/**
 * Self-checks for the metrics this harness computes itself: ringing
 * (`metrics/local.ts`), spurious detail (`metrics/spurious.ts`) and aspect
 * fidelity (`aspect.ts`). Run with `mise run selftest:metrics`.
 *
 * This tool has no test framework — see `TESTING.md` — so the properties the
 * local metrics are *designed around* are asserted here instead, as a script
 * that exits non-zero. They are the falsifiable claims: if the "a blur scores
 * exactly zero" case ever fails, the window-radius derivation in
 * `metrics/local.ts` is wrong and every ringing number in the report is noise;
 * if "the ideal low-pass scores zero" fails, the same is true of every spurious
 * number.
 *
 * Both artifact metrics have earned that framing. The rounding asymmetry in
 * `spurious.ts` — which made a provably-ideal low-pass of a ramp score 0.14 —
 * was found by this file and by nothing else.
 *
 * The aspect block is new: the docstring here and the `selftest:metrics` task
 * description had both claimed `aspect.ts` coverage since it was written, and
 * neither had any.
 */

import { computeRinging } from "./metrics/local.ts";
import { computeSpurious } from "./metrics/spurious.ts";
import { aspectFidelity, log2ToPct } from "./aspect.ts";

let failures = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name} — ${detail}`);
  }
}

/** Opaque RGBA from a per-pixel colour function. */
function makeRgba(
  w: number,
  h: number,
  f: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const p = (y * w + x) * 4;
      out[p] = Math.max(0, Math.min(255, Math.round(r)));
      out[p + 1] = Math.max(0, Math.min(255, Math.round(g)));
      out[p + 2] = Math.max(0, Math.min(255, Math.round(b)));
      out[p + 3] = 255;
    }
  }
  return out;
}

/**
 * Area-average downscale — the honest model of "a decode that is merely a
 * low-pass of the reference". Convex by construction, so by the metric's
 * central property it must score zero.
 */
function boxDownscale(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      const acc = [0, 0, 0];
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const p = (sy * sw + sx) * 4;
          acc[0] = (acc[0] ?? 0) + (src[p] ?? 0);
          acc[1] = (acc[1] ?? 0) + (src[p + 1] ?? 0);
          acc[2] = (acc[2] ?? 0) + (src[p + 2] ?? 0);
          n++;
        }
      }
      const p = (y * dw + x) * 4;
      out[p] = Math.round((acc[0] ?? 0) / n);
      out[p + 1] = Math.round((acc[1] ?? 0) / n);
      out[p + 2] = Math.round((acc[2] ?? 0) / n);
      out[p + 3] = 255;
    }
  }
  return out;
}

const REF_W = 256;
const REF_H = 256;
const DEC = 32;

// A reference with real edges: ringing has to have something to ring around.
// Mid-range values on purpose, so an excursion is visible instead of clipping
// at the byte boundary (the trap that hid sharp's own overshoot).
const reference = makeRgba(REF_W, REF_H, (x, y) => {
  const band = x < REF_W / 2 ? 70 : 190;
  const v = y < REF_H / 2 ? band : 255 - band;
  return [v, v, v];
});

console.log("\nringing — the properties the metric is built on\n");

// 1. Identity.
{
  const s = computeRinging(reference, reference, REF_W, REF_H, REF_W, REF_H);
  check(
    "identity scores 0",
    s !== null && s.ringing === 0,
    `ringing=${s?.ringing}`,
  );
}

// 2. THE null hypothesis: a pure low-pass decode must score exactly 0. If this
//    fails, the radius derivation is wrong and the metric measures blur.
const lowpass = boxDownscale(reference, REF_W, REF_H, DEC, DEC);
{
  const s = computeRinging(reference, lowpass, REF_W, REF_H, DEC, DEC);
  check(
    "a pure low-pass decode scores 0",
    s !== null && s.ringing === 0,
    `ringing=${s?.ringing.toFixed(4)} radius=${s?.ringWindowRadius}`,
  );
}

// 3. Bias correction: a uniform tint is "smooth but wrong", not an artifact.
{
  const tinted = new Uint8Array(lowpass);
  for (let i = 0; i < tinted.length; i += 4) {
    tinted[i] = Math.min(255, (tinted[i] ?? 0) + 8);
    tinted[i + 1] = Math.min(255, (tinted[i + 1] ?? 0) + 8);
    tinted[i + 2] = Math.min(255, (tinted[i + 2] ?? 0) + 8);
  }
  const s = computeRinging(reference, tinted, REF_W, REF_H, DEC, DEC);
  check(
    "a uniform +8 tint is absorbed as bias, not scored as ringing",
    s !== null && s.ringing < 0.5,
    `ringing=${s?.ringing.toFixed(4)}`,
  );
}

/** Add an oscillation straddling the vertical edge — synthetic Gibbs. */
function addRipple(
  base: Uint8Array,
  amp: [number, number, number],
): Uint8Array {
  const out = new Uint8Array(base);
  const mid = DEC / 2;
  for (let y = 0; y < DEC; y++) {
    for (let x = 0; x < DEC; x++) {
      const d = x - mid;
      if (Math.abs(d) > 5) continue;
      const w = Math.cos((d * Math.PI) / 2.5) * (1 - Math.abs(d) / 6);
      const p = (y * DEC + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[p + c] = Math.max(
          0,
          Math.min(255, Math.round((out[p + c] ?? 0) + (amp[c] ?? 0) * w)),
        );
      }
    }
  }
  return out;
}

// 4. A neutral ripple must register, and register as luma.
const neutral = computeRinging(
  reference,
  addRipple(lowpass, [30, 30, 30]),
  REF_W,
  REF_H,
  DEC,
  DEC,
);
check(
  "a neutral ripple at the edge registers",
  neutral !== null && neutral.ringing > 1,
  `ringing=${neutral?.ringing.toFixed(3)} area=${((neutral?.ringArea ?? 0) * 100).toFixed(1)}%`,
);
check(
  "a neutral ripple reads as luma, not chroma",
  neutral !== null && neutral.ringingLuma > neutral.ringingChroma * 4,
  `luma=${neutral?.ringingLuma.toFixed(3)} chroma=${neutral?.ringingChroma.toFixed(3)}`,
);

// 5a. On a flat reference the luma/chroma separation is exact: an opposing
//     R/B ripple must read as pure chroma.
{
  const flat = makeRgba(REF_W, REF_H, () => [128, 128, 128]);
  const flatDec = boxDownscale(flat, REF_W, REF_H, DEC, DEC);
  const s = computeRinging(
    flat,
    addRipple(flatDec, [30, 0, -30]),
    REF_W,
    REF_H,
    DEC,
    DEC,
  );
  check(
    "on a flat reference a chroma ripple reads as pure chroma",
    s !== null && s.ringingChroma > 1 && s.ringingLuma === 0,
    `luma=${s?.ringingLuma.toFixed(3)} chroma=${s?.ringingChroma.toFixed(3)}`,
  );
}

// 5b. Near an edge the separation is partial, and that is inherent rather than
//     a defect: the envelope test is one-sided, so where the local range is
//     wide and sits asymmetrically about a pixel's value, one channel's
//     excursion clears the envelope while the opposite channel's does not. The
//     residual reads as luma. Chroma must still dominate — that is the
//     discrimination `spec/RATIONALE.md` §255 needs (chroma quantization noise
//     vs luma ringing) — but expecting a clean split next to an edge would be
//     expecting the wrong thing.
{
  const s = computeRinging(
    reference,
    addRipple(lowpass, [30, 0, -30]),
    REF_W,
    REF_H,
    DEC,
    DEC,
  );
  check(
    "near an edge a chroma ripple still reads mostly as chroma",
    s !== null && s.ringingChroma > s.ringingLuma * 1.5,
    `luma=${s?.ringingLuma.toFixed(3)} chroma=${s?.ringingChroma.toFixed(3)}`,
  );
  // 6. The decomposition is orthogonal, so the aggregate must be Pythagorean.
  if (s !== null) {
    const lhs = s.ringing ** 2;
    const rhs = s.ringingLuma ** 2 + s.ringingChroma ** 2;
    check(
      "ringing^2 = ringingLuma^2 + ringingChroma^2",
      Math.abs(lhs - rhs) < 1e-6 * Math.max(1, lhs),
      `${lhs.toFixed(6)} vs ${rhs.toFixed(6)}`,
    );
  }
}

// 7. Severity ordering: a bigger overshoot must score higher.
{
  const small = computeRinging(
    reference,
    addRipple(lowpass, [10, 10, 10]),
    REF_W,
    REF_H,
    DEC,
    DEC,
  );
  check(
    "a larger overshoot scores higher than a smaller one",
    small !== null && neutral !== null && neutral.ringing > small.ringing,
    `amp10=${small?.ringing.toFixed(3)} amp30=${neutral?.ringing.toFixed(3)}`,
  );
}

// 7b. THE REGRESSION THIS SUITE ONCE MISSED.
//
// The checks above fix REF_W = 256 and DEC = 32, i.e. one upscale factor of 8.
// Two separate defects lived entirely outside that regime and shipped through a
// green run: a fixed 64-px cap on the window radius (which broke `r >= S`, so
// the score measured ordinary resolution loss once a decode fell below 16 px
// against a 512 px reference), and a bias correction applied to the decode but
// not to the envelope it was tested against (which broke the exact-zero
// property at every radius). On a logo -- large flat fields, one hard edge --
// a provably convex 4x3 decode scored 7.67, larger than the genuine ripple
// above.
//
// So sweep the decode sizes the real lineup produces, against the reference
// size it actually scores at, on the content shape that exposed it.
{
  const W = 512;
  const H = 341;
  // Logo-shaped: flat ground, one solid block, one hard edge. This is what
  // broke; a photograph did not.
  const logo = makeRgba(W, H, (x, y) => {
    const inMark = x > W * 0.2 && x < W * 0.55 && y > H * 0.25 && y < H * 0.7;
    return inMark ? [28, 78, 200] : [244, 244, 240];
  });
  // Fine periodic structure, the opposite failure shape.
  const text = makeRgba(W, H, (x, y) =>
    y % 7 < 3 && x % 5 < 3 ? [20, 20, 20] : [250, 250, 250],
  );
  const failures: string[] = [];
  for (const [label, ref] of [
    ["logo", logo],
    ["text", text],
  ] as const) {
    for (const long of [4, 6, 8, 12, 16, 24, 32, 64]) {
      const dw = Math.max(1, Math.round((W * long) / Math.max(W, H)));
      const dh = Math.max(1, Math.round((H * long) / Math.max(W, H)));
      // A box average is a convex combination of the samples it covers, so by
      // the metric's central property it cannot overshoot. Anything above zero
      // here is a false positive.
      const s = computeRinging(
        ref,
        boxDownscale(ref, W, H, dw, dh),
        W,
        H,
        dw,
        dh,
      );
      if (s === null || s.ringing > 0) {
        failures.push(
          `${label} ${dw}x${dh}=${s?.ringing.toFixed(3) ?? "null"}`,
        );
      }
    }
  }
  check(
    "a convex decode scores 0 at every decode size, not just the easy one",
    failures.length === 0,
    failures.length === 0
      ? "16 sizes x 2 content shapes, 4px to 64px against a 512px reference"
      : `false positives: ${failures.join(", ")}`,
  );
}

// 8. Degenerate rasters must not throw or produce NaN.
{
  const solid = makeRgba(8, 8, () => [120, 120, 120]);
  const one = makeRgba(1, 1, () => [120, 120, 120]);
  const s1 = computeRinging(solid, one, 8, 8, 1, 1);
  const s2 = computeRinging(one, one, 1, 1, 1, 1);
  check(
    "degenerate rasters score finite",
    s1 !== null &&
      Number.isFinite(s1.ringing) &&
      s2 !== null &&
      Number.isFinite(s2.ringing),
    `8x8<-1x1=${s1?.ringing.toFixed(3)} 1x1=${s2?.ringing.toFixed(3)}`,
  );
  check(
    "a solid reference with a matching solid decode scores 0",
    s1 !== null && s1.ringing === 0,
    `ringing=${s1?.ringing}`,
  );
}

console.log("\nspurious detail — the properties that metric is built on\n");

/**
 * Add a sinusoid to a decode at a chosen orientation. `fx`/`fy` are cycles
 * across the decode's width/height, so `(f, 0)` varies along x and is constant
 * down y — vertical stripes.
 */
function addWave(
  base: Uint8Array,
  w: number,
  h: number,
  fx: number,
  fy: number,
  amp: number,
): Uint8Array {
  const out = new Uint8Array(base);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v =
        amp *
        Math.cos((2 * Math.PI * fx * (x + 0.5)) / w) *
        Math.cos((2 * Math.PI * fy * (y + 0.5)) / h);
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[p + c] = Math.max(
          0,
          Math.min(255, Math.round((out[p + c] ?? 0) + v)),
        );
      }
    }
  }
  return out;
}

// S1. Identity: a decode that is the reference has no energy the reference lacks.
{
  const s = computeSpurious(reference, reference, REF_W, REF_H, REF_W, REF_H);
  check(
    "identity scores 0",
    s !== null && s.spurious === 0,
    `spurious=${s?.spurious}`,
  );
}

// S2. THE null hypothesis, and the direct analogue of the ringing suite's:
//     the ideal low-pass decode scores exactly 0. Swept over decode sizes and
//     content shapes for the reason §7b of the ringing suite records — a single
//     upscale factor hid two defects once already.
{
  const W = 512;
  const H = 341;
  const logo = makeRgba(W, H, (x, y) => {
    const inMark = x > W * 0.2 && x < W * 0.55 && y > H * 0.25 && y < H * 0.7;
    return inMark ? [28, 78, 200] : [244, 244, 240];
  });
  const text = makeRgba(W, H, (x, y) =>
    y % 7 < 3 && x % 5 < 3 ? [20, 20, 20] : [250, 250, 250],
  );
  // A smooth ramp: the shape a false-contour metric would fire on, and the one
  // this metric must stay silent for, because a low-pass of a ramp is a ramp.
  const ramp = makeRgba(W, H, (x, y) => [
    Math.round((x / (W - 1)) * 255),
    Math.round((y / (H - 1)) * 255),
    128,
  ]);
  const failures: string[] = [];
  for (const [label, ref] of [
    ["logo", logo],
    ["text", text],
    ["ramp", ramp],
  ] as const) {
    for (const long of [4, 8, 16, 32, 64, 128, 256, 512]) {
      const dw = Math.max(1, Math.round((W * long) / Math.max(W, H)));
      const dh = Math.max(1, Math.round((H * long) / Math.max(W, H)));
      const s = computeSpurious(
        ref,
        boxDownscale(ref, W, H, dw, dh),
        W,
        H,
        dw,
        dh,
      );
      if (s === null || s.spurious > 0) {
        failures.push(
          `${label} ${dw}x${dh}=${s?.spurious.toFixed(4) ?? "null"}`,
        );
      }
    }
  }
  check(
    "the ideal low-pass decode scores 0 at every decode size",
    failures.length === 0,
    failures.length === 0
      ? "8 sizes x 3 content shapes, 4px to 512px against a 512px reference"
      : `false positives: ${failures.join(", ")}`,
  );
}

// The working pair for the orientation and ordering checks: a photograph-ish
// reference with structure on both axes, and its ideal low-pass decode.
const SW = 64;
const SH = 48;
const sRef = makeRgba(REF_W, REF_H, (x, y) => {
  const a = Math.sin((x / REF_W) * 6) * 40 + Math.cos((y / REF_H) * 4) * 30;
  return [128 + a, 120 + a * 0.5, 140 - a * 0.3];
});
const sDec = boxDownscale(sRef, REF_W, REF_H, SW, SH);

// S3. Energy the reference does not have must register.
const vertical = computeSpurious(
  sRef,
  addWave(sDec, SW, SH, 12, 0, 24),
  REF_W,
  REF_H,
  SW,
  SH,
);
check(
  "invented structure registers",
  vertical !== null && vertical.spurious > 1,
  `spurious=${vertical?.spurious.toFixed(3)}`,
);

// S4/S5. Orientation. A pattern varying along x is *vertical* stripes; one
//        varying down y is horizontal. Getting this backwards is the perennial
//        error, so both directions are pinned.
check(
  "a pattern varying along x reads as vertical striping",
  vertical !== null &&
    vertical.spuriousVertical > vertical.spuriousHorizontal * 4 &&
    vertical.spuriousVertical > vertical.spuriousDiagonal * 4,
  `V=${vertical?.spuriousVertical.toFixed(3)} H=${vertical?.spuriousHorizontal.toFixed(3)} D=${vertical?.spuriousDiagonal.toFixed(3)}`,
);
{
  const s = computeSpurious(
    sRef,
    addWave(sDec, SW, SH, 0, 12, 24),
    REF_W,
    REF_H,
    SW,
    SH,
  );
  check(
    "a pattern varying down y reads as horizontal striping",
    s !== null &&
      s.spuriousHorizontal > s.spuriousVertical * 4 &&
      s.spuriousHorizontal > s.spuriousDiagonal * 4,
    `V=${s?.spuriousVertical.toFixed(3)} H=${s?.spuriousHorizontal.toFixed(3)} D=${s?.spuriousDiagonal.toFixed(3)}`,
  );
}
{
  // An oblique product term lands in the diagonal band. This is the one the
  // format's `aniso_oblique = 1.2` de-prioritises, so it has to be separable
  // from the other two or the sweep cannot see what the weight does.
  const s = computeSpurious(
    sRef,
    addWave(sDec, SW, SH, 9, 9, 24),
    REF_W,
    REF_H,
    SW,
    SH,
  );
  check(
    "an oblique pattern reads as diagonal",
    s !== null &&
      s.spuriousDiagonal > s.spuriousVertical &&
      s.spuriousDiagonal > s.spuriousHorizontal,
    `V=${s?.spuriousVertical.toFixed(3)} H=${s?.spuriousHorizontal.toFixed(3)} D=${s?.spuriousDiagonal.toFixed(3)}`,
  );
}

// S6. The three bands partition the frequency plane, so they must recombine in
//     quadrature exactly — the same contract ringing's luma/chroma split has.
if (vertical !== null) {
  const lhs = vertical.spurious ** 2;
  const rhs =
    vertical.spuriousVertical ** 2 +
    vertical.spuriousHorizontal ** 2 +
    vertical.spuriousDiagonal ** 2;
  check(
    "spurious^2 = vertical^2 + horizontal^2 + diagonal^2",
    Math.abs(lhs - rhs) < 1e-6 * Math.max(1, lhs),
    `${lhs.toFixed(6)} vs ${rhs.toFixed(6)}`,
  );
}

// S7. Severity ordering.
{
  const small = computeSpurious(
    sRef,
    addWave(sDec, SW, SH, 12, 0, 8),
    REF_W,
    REF_H,
    SW,
    SH,
  );
  check(
    "more invented structure scores higher",
    small !== null && vertical !== null && vertical.spurious > small.spurious,
    `amp8=${small?.spurious.toFixed(3)} amp24=${vertical?.spurious.toFixed(3)}`,
  );
}

// S8. Missing detail is free. A decode with *less* energy than the ideal
//     low-pass at every frequency must score nothing — losing detail is what
//     ΔE00, SSIMULACRA2 and DSSIM charge for. If this ever fails, the metric has
//     quietly become a second fidelity score.
//
//     Constructed by pulling every sample halfway to the plane's mean, which
//     halves every AC magnitude and leaves DC alone. Deliberately *not* by
//     upsampling from a coarser grid: a box upsample is nearest-neighbour
//     replication, so it is blocky rather than blurry and genuinely does invent
//     high-frequency structure. That construction scored 3.64 here, and the
//     metric was right — which is its own small piece of evidence that the
//     number sees blockiness.
{
  let mean = 0;
  for (let i = 0; i < sDec.length; i += 4) mean += sDec[i] ?? 0;
  mean /= sDec.length / 4;
  const flatter = new Uint8Array(sDec);
  for (let i = 0; i < flatter.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = flatter[i + c] ?? 0;
      flatter[i + c] = Math.round(v + (mean - v) * 0.5);
    }
  }
  //     Asserted as negligible rather than exactly zero, and the distinction is
  //     real. The exact zero belongs to the ideal-low-pass case above, where
  //     both sides are the *same array* and every excess is identically
  //     negative. Here the decode carries its own independent 8-bit rounding,
  //     which an orthonormal transform spreads over ~9000 coefficients; across
  //     that many, the largest occasionally grazes the one-level dead zone at a
  //     frequency where the reference has nothing. Measured at 0.005 against
  //     real scores of ~17, i.e. three orders of magnitude down. Demanding an
  //     exact zero here would be demanding that 8-bit rounding not exist.
  const s = computeSpurious(sRef, flatter, REF_W, REF_H, SW, SH);
  check(
    "a decode with less energy than the ideal low-pass scores ~0",
    s !== null && s.spurious < 0.05,
    `spurious=${s?.spurious.toFixed(4)}`,
  );
}

// S9. Degenerate rasters must not throw or produce NaN.
{
  const solid = makeRgba(8, 8, () => [120, 120, 120]);
  const one = makeRgba(1, 1, () => [120, 120, 120]);
  const s1 = computeSpurious(
    solid,
    boxDownscale(solid, 8, 8, 2, 2),
    8,
    8,
    2,
    2,
  );
  check(
    "degenerate rasters score finite, and a 1x1 grid is declined",
    s1 !== null &&
      Number.isFinite(s1.spurious) &&
      computeSpurious(one, one, 1, 1, 1, 1) === null,
    `8x8<-2x2=${s1?.spurious.toFixed(3)}`,
  );
}

console.log("\naspect — the properties that metric is built on\n");

// A1. Identity: a declared shape equal to the target has no error and no reflow.
{
  const s = aspectFidelity({ kind: "declared", width: 32, height: 21 }, 32, 21);
  check(
    "a declared shape equal to the target scores 0",
    s !== null && s.log2Error === 0 && s.errorPct === 0 && s.reflowPx === 0,
    `log2=${s?.log2Error} pct=${s?.errorPct} reflow=${s?.reflowPx}`,
  );
}

// A2. THE property the log2 form exists for. The ratio measure |AR_d/AR_t − 1|
//     scores 10% too wide as 10.00% and 10% too narrow as 9.09%, so a corpus
//     mean would be biased by the landscape/portrait mix of the corpus rather
//     than by any format. Symmetry about 1:1 is what removes that, and it is
//     the same property spec §8.1 builds the aspect encoding on.
{
  const wide = aspectFidelity(
    { kind: "declared", width: 110, height: 100 },
    100,
    100,
  );
  const narrow = aspectFidelity(
    { kind: "declared", width: 100, height: 110 },
    100,
    100,
  );
  check(
    "the error is symmetric under transposing the mistake",
    wide !== null &&
      narrow !== null &&
      Math.abs(wide.log2Error - narrow.log2Error) < 1e-12,
    `wide=${wide?.log2Error.toFixed(9)} narrow=${narrow?.log2Error.toFixed(9)}`,
  );
}

// A3. A format that declares no shape must return null rather than 0. Scoring
//     it as zero error would rank "carries no aspect at all" as perfect layout
//     fidelity, which is the opposite of the truth.
check(
  "a format with no declared size scores null, not 0",
  aspectFidelity({ kind: "absent", reason: "no aspect in payload" }, 32, 21) ===
    null,
  "absent -> null",
);

// A4. Degenerate inputs decline rather than returning Infinity or NaN, which
//     would poison a corpus mean silently.
check(
  "degenerate dimensions are declined",
  aspectFidelity({ kind: "declared", width: 0, height: 10 }, 32, 21) === null &&
    aspectFidelity({ kind: "declared", width: 10, height: 10 }, 0, 21) === null,
  "zero extents -> null",
);

// A5. The documented conversion between the two conventions must agree with the
//     value the metric reports, or the report's percent column and the spec's
//     §8.1 percent are different numbers wearing the same name.
{
  const s = aspectFidelity({ kind: "declared", width: 32, height: 21 }, 3, 2);
  check(
    "log2ToPct agrees with the reported errorPct",
    s !== null && Math.abs(log2ToPct(s.log2Error) - s.errorPct) < 1e-12,
    `log2=${s?.log2Error.toFixed(6)} pct=${s?.errorPct.toFixed(4)}%`,
  );
}

// A6. The reflow sign convention, which the report renders as a direction:
//     positive means the real image is TALLER than the placeholder reserved, so
//     content below it gets pushed down when the real image lands.
{
  const tooShort = aspectFidelity(
    { kind: "declared", width: 100, height: 50 },
    100,
    100,
  );
  check(
    "a placeholder shorter than the real image reflows positive",
    tooShort !== null && tooShort.reflowPx > 0,
    `reflow=${tooShort?.reflowPx.toFixed(1)}px for a 1000px container`,
  );
}

console.log(
  failures === 0
    ? "\nAll metric self-checks passed.\n"
    : `\n${failures} metric self-check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
