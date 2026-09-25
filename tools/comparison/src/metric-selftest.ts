/**
 * Self-checks for the metrics this harness computes itself: ringing
 * (`metrics/local.ts`), spurious detail and spectral deficit
 * (`metrics/spurious.ts`), aspect fidelity (`aspect.ts`), and the joins
 * `stratify.ts` reads them through (`stratify-core.ts`). Run with
 * `mise run selftest:metrics`.
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
 *
 * The stratify block is here because §13.3 is the one table in EXPERIMENTS.md
 * that no sweep binds -- `verify:experiments` registers it in `UNBOUND_NOTES`
 * -- so no gate reached it from either end, and the correlation, the binning
 * and the alignment assert its numbers rest on had no coverage of any kind.
 * They are checked against fixtures whose answers are known by hand rather than
 * against the corpus, so they hold with no sweep output on disk.
 *
 * The grid-pin block is here for the same reason and paid for itself the same
 * way. Every cross-tier artifact figure in EXPERIMENTS.md §13 is read off a
 * pinned grid, and no call in this file had ever passed the pin — so the first
 * assertion that an ideal low-pass still scores exactly zero *through* a pin
 * failed immediately, on a bias that grew with the pin ratio and so ran along
 * the tier axis those figures are read down.
 *
 * The verify-benchmark and probe blocks are here for the stratify block's
 * reason, one document over. `verify:benchmark` decides which PERFORMANCE.md
 * cells pass, fail or are skipped, and every rule that makes that decision was
 * added because an earlier version reported green over a case it had not
 * checked. The gate's own run over the committed baseline exercises only the
 * one state that baseline is in — Swift absent, one clean commit, every prose
 * sentence present — so none of the failure paths had ever executed. They are
 * asserted against fixture runs, tables and stage files
 * (`verify-benchmark-core.ts`), and the probe classification that feeds them
 * against real spawns (`perf/availability.ts`).
 *
 * The verify:experiments block is here for the same reason again: the table
 * register (`experiments-register.ts`) and the result reader's shape check
 * (`results.ts`) fail a run only on a state the committed document and results
 * are never in, so each failure branch is driven from a fixture instead.
 *
 * The alpha corpus block covers the retired alpha holdout split and withdrawn
 * pins (`alpha-images.ts`, #83), whose refusal and skip no sweep CI runs ever
 * reaches.
 *
 * The photographic splits block covers the same for the photographic holdout
 * #76 retired into tune2, and for the gate that keeps holdout2 sealed until
 * `spec/V0.8-DECISIONS.md` records a decision as frozen (`holdout-images.ts`).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ALPHA_HOLDOUT_RETIRED,
  type AlphaImageSpec,
  alphaImagesToFetch,
} from "./alpha-images.ts";
import {
  HOLDOUT2_PREFIX,
  PHOTO_HOLDOUT_RETIRED,
  inCorpus,
  inSplit,
  parseScratchPhotoSplit,
  parseSplit,
  partitionSealed,
  splitFor,
} from "./corpus.ts";
import {
  assertHoldout2Unread,
  ensureHoldout2Images,
  holdout2Specs,
  openHoldout2,
  registerStatus,
} from "./holdout-images.ts";
import { CURATED_IMAGES, type NaturalImageSpec } from "./natural-images.ts";
import { covariatesOf, isFreeLicence, srgbToLab } from "./corpus-covariates.ts";
import { computeRinging } from "./metrics/local.ts";
import { computeSpurious } from "./metrics/spurious.ts";
import { aspectFidelity, log2ToPct } from "./aspect.ts";
import { alignmentError, equalCountBins, pearson } from "./stratify-core.ts";
import { compareArms, guardVerdictOnIntervals } from "./arms-core.ts";
import {
  bootstrapP,
  correlationInference,
  holm,
  normalQuantile,
  studentTQuantile,
} from "./stats.ts";
import { classifyProbe, repoRelative } from "./perf/availability.ts";
import {
  type TableRegisterInput,
  tableRegisterProblems,
} from "./experiments-register.ts";
import {
  ARTIFACT_ZERO_BASE_ALLOWANCE,
  RESULT_SCHEMA,
  type ResultFile,
  shapeProblems,
} from "./results.ts";
import {
  type Binding,
  type Counters,
  type DecodeStageCell,
  type Edit,
  type Failure,
  type ProseClaim,
  type RunDoc,
  Runs,
  type StageCell,
  checkDecodeStagesProvenance,
  checkProseClaims,
  checkStability,
  checkStabilityClaim,
  checkStageRowCoverage,
  checkStagesProvenance,
  checkTable,
  clean,
  parseDecodeStages,
  parseStages,
  parseTables,
  parseUnavailableMarker,
} from "./verify-benchmark-core.ts";

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

// S1. Identity: a decode that is the reference has no energy the reference
//     lacks -- and, the other way round, none the reference has that it lacks.
//     Both halves, for the reason S2/S3b/S3c/P1 assert both: `deficit` shares a
//     loop and a dead zone with `spurious` but faces the other way, so a defect
//     confined to its side of the subtraction is invisible to a spurious-only
//     assertion. The identity pair is also the one case that needs no rounding
//     argument at all -- both spectra come from the same buffer, so both scores
//     must be exactly zero.
{
  const s = computeSpurious(reference, reference, REF_W, REF_H, REF_W, REF_H);
  check(
    "identity scores 0 spurious AND 0 deficit",
    s !== null && s.spurious === 0 && s.deficit === 0,
    `spurious=${s?.spurious} deficit=${s?.deficit}`,
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
      // Both scores, together: they are the same comparison with the sign
      // flipped, so the ideal low-pass has to be exactly zero on each. Deficit
      // is the one that could plausibly leak — its clamp faces the other way,
      // so a rounding asymmetry between the two sides would show up here and
      // nowhere in `spurious`.
      if (s === null || s.spurious > 0 || s.deficit > 0) {
        failures.push(
          `${label} ${dw}x${dh}=` +
            `spur ${s?.spurious.toFixed(4) ?? "null"} / ` +
            `def ${s?.deficit.toFixed(4) ?? "null"}`,
        );
      }
    }
  }
  check(
    "the ideal low-pass decode scores 0 spurious AND 0 deficit at every size",
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

// S3b. Deficit is the mirror, and has to behave like one: a decode that is
// *flatter* than the ideal low-pass has dropped structure the reference has, so
// deficit must rise while spurious stays at zero. Without this, `deficit` could
// be wired to the wrong side of the subtraction and every table would still
// look plausible — the two scores move together often enough that only a case
// built to separate them can tell.
{
  const flattened = new Uint8Array(sDec);
  for (let i = 0; i < SW * SH; i++) {
    for (let c = 0; c < 3; c++) {
      const v = flattened[i * 4 + c] ?? 0;
      flattened[i * 4 + c] = Math.round(128 + (v - 128) * 0.4);
    }
  }
  const s = computeSpurious(sRef, flattened, REF_W, REF_H, SW, SH);
  // `spurious` is asserted negligible rather than exactly zero, on the same
  // grounds as S8 below: the exact zero belongs to the ideal-low-pass case,
  // where both sides are the same array. Here the contracted decode carries its
  // own 8-bit rounding, and across ~9000 coefficients the largest residue
  // occasionally grazes the one-level dead zone. Measured at 0.006 against a
  // deficit of 14.5 — three orders of magnitude apart, which is the claim.
  check(
    "a decode flatter than the ideal low-pass scores deficit, not spurious",
    s !== null && s.deficit > 1 && s.spurious < 0.05,
    `deficit=${s?.deficit.toFixed(3)} spurious=${s?.spurious.toFixed(4)}`,
  );
}

// S3c. And the converse, on the same pair: adding energy the reference does not
// have must move `spurious` without moving `deficit` down past zero. Asserting
// both directions is what makes the pair a pair rather than two numbers that
// happen to be printed together.
// `deficit >= 0` was the original second conjunct here and asserted nothing:
// it is a sum of squares, so it holds for every input this function can be
// given, including one where deficit and spurious had been wired to the same
// side of the subtraction. The bound is absolute rather than relative for the
// same reason — this case measures deficit at exactly 0.000 against a spurious
// of 17.08, so a ratio test would divide by zero into another tautology.
check(
  "invented structure does not register as deficit",
  vertical !== null && vertical.spurious > 1 && vertical.deficit < 0.05,
  `spurious=${vertical?.spurious.toFixed(3)} deficit=${vertical?.deficit.toFixed(3)}`,
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

console.log("\nspurious — the pinned analysis grid\n");

// The grid pin is what every cross-tier artifact number in EXPERIMENTS.md §13
// rests on, and until these checks existed not one of the ten computeSpurious
// calls above passed a seventh argument: the parameter the conclusions depend
// on was the one parameter with no coverage at all.
//
// P1 is the null hypothesis one level down, and it is the one that mattered. An
// ideal low-pass must score exactly zero — unpinned, that is asserted above at
// 8 sizes; pinned, it was scoring 0.008 at 32->16, 0.020 at 64->32 and 0.032 at
// 128->64, a floor that grew with the pin ratio and therefore landed hardest on
// exactly the high tiers the pin exists to make comparable. The cause was in
// `idealSpectrum`: the decode reached a pinned grid through two roundings and
// the ideal through one.
{
  const failures: string[] = [];
  for (const [dw, dh] of [
    [32, 24],
    [64, 48],
    [128, 96],
    [16, 12],
  ] as const) {
    const dec = boxDownscale(sRef, REF_W, REF_H, dw, dh);
    for (const pin of [8, 16, 32, 64, 128]) {
      const s = computeSpurious(sRef, dec, REF_W, REF_H, dw, dh, pin);
      if (s === null || s.spurious > 0 || s.deficit > 0) {
        failures.push(
          `${dw}x${dh}@${pin}=spur ${s?.spurious.toFixed(4) ?? "null"} / def ${s?.deficit.toFixed(4) ?? "null"}`,
        );
      }
    }
  }
  check(
    "P1 the ideal low-pass scores 0 spurious AND 0 deficit at every pin",
    failures.length === 0,
    failures.length === 0
      ? "4 decode rasters x 5 pins, all exactly zero"
      : `false positives: ${failures.join(", ")}`,
  );
}

// P2. A pin at or above the decode's long edge cannot bind, so it must return
//     the unpinned score bit for bit rather than merely something close.
{
  const dec = addWave(sDec, SW, SH, 12, 0, 24);
  const bare = computeSpurious(sRef, dec, REF_W, REF_H, SW, SH);
  const wide = [SW, SW * 2, 512].map((pin) =>
    computeSpurious(sRef, dec, REF_W, REF_H, SW, SH, pin),
  );
  check(
    "P2 a pin at or above the decode's long edge is the unpinned score",
    bare !== null &&
      wide.every(
        (s) =>
          s !== null &&
          s.spurious === bare.spurious &&
          s.deficit === bare.deficit,
      ),
    `unpinned=${bare?.spurious.toFixed(6)} pinned=${wide.map((s) => s?.spurious.toFixed(6)).join(", ")}`,
  );
}

// P3. And a pin below it must actually bind. Without this, a pin silently
//     ignored — a dropped argument, a renamed field in the sweep config — would
//     leave every arm scored on its own raster while the table said otherwise,
//     which is precisely the §12.4 mistake the pin was added to prevent.
{
  const dec = addWave(sDec, SW, SH, 12, 0, 24);
  const bare = computeSpurious(sRef, dec, REF_W, REF_H, SW, SH);
  const pinned = computeSpurious(sRef, dec, REF_W, REF_H, SW, SH, 16);
  check(
    "P3 a pin below the decode's long edge changes the score",
    bare !== null && pinned !== null && pinned.spurious !== bare.spurious,
    `unpinned=${bare?.spurious.toFixed(4)} pinned@16=${pinned?.spurious.toFixed(4)}`,
  );
}

console.log("\nstratify — the joins §13.3 is read through\n");

// §13.3 is the one table in EXPERIMENTS.md that no sweep binds, so nothing
// downstream of these three functions would notice them being wrong: a
// mis-signed correlation, a bin that quietly held four images, or a positional
// join across two arms that were scored over different lists all print a table
// of exactly the right shape. Fixtures with answers known by hand, so the block
// runs with no sweep output and no corpus.

// T1. Pearson against a case whose answer is arithmetic, not a coincidence: a
//     series that is an exact affine function of the axis correlates ±1 to
//     floating point, in both directions. Getting the sign backwards is the
//     perennial error and it is what §13.3's whole reading turns on.
{
  const xs = [1, 2, 3, 4, 5, 6, 7];
  const up = xs.map((x) => 3 * x + 11);
  const down = xs.map((x) => -0.5 * x + 4);
  check(
    "an exact affine relation correlates +1 and its mirror -1",
    Math.abs(pearson(xs, up) - 1) < 1e-12 &&
      Math.abs(pearson(xs, down) + 1) < 1e-12,
    `up=${pearson(xs, up).toFixed(12)} down=${pearson(xs, down).toFixed(12)}`,
  );
}

// T2. And against a hand-computable value, so the check is not satisfied by a
//     function that only ever returns ±1. For xs = [1,2,3,4] and
//     ys = [1,3,2,4]: both are centred at 2.5, so the deviations are
//     [-1.5,-0.5,+0.5,+1.5] and [-1.5,+0.5,-0.5,+1.5], giving Sxy = 4 and
//     Sxx = Syy = 5, so r = 4/5 exactly.
{
  const r = pearson([1, 2, 3, 4], [1, 3, 2, 4]);
  check(
    "a partial relation scores its exact coefficient",
    Math.abs(r - 0.8) < 1e-12,
    `r=${r.toFixed(12)} (expected 0.8)`,
  );
}

// T3. The cases where a coefficient means nothing must return NaN rather than a
//     number: fewer than three pairs, a constant on either side, or two series
//     of different lengths. The table renders NaN as "—"; a 0 or a 1 here would
//     be printed as a finding.
{
  const flat = pearson([1, 2, 3, 4], [7, 7, 7, 7]);
  const short = pearson([1, 2], [3, 4]);
  const ragged = pearson([1, 2, 3, 4], [1, 2, 3]);
  check(
    "an undefined correlation is NaN, not a number",
    Number.isNaN(flat) && Number.isNaN(short) && Number.isNaN(ragged),
    `constant=${flat} n=2 ${short} ragged=${ragged}`,
  );
}

// T4. Equal-count terciles over 31 — the tune corpus's size, and the split
//     §13.3 prints. Every image lands in exactly one bin, the bins are within
//     one of each other, and they are contiguous in rank: a bin whose
//     membership was not an interval of the sorted order would make the
//     "smooth / mid / textured" column headings a lie while the means still
//     looked plausible.
{
  const ranks = Array.from({ length: 31 }, (_, i) => i);
  const bins = equalCountBins(ranks, 3);
  const sizes = bins.map((b) => b.length);
  const flat = bins.flat();
  const contiguous = bins.every((b) =>
    b.every((v, i) => i === 0 || v === (b[i - 1] ?? -1) + 1),
  );
  check(
    "31 images split into 3 contiguous, equal-count bins covering every image",
    flat.length === 31 &&
      new Set(flat).size === 31 &&
      Math.max(...sizes) - Math.min(...sizes) <= 1 &&
      contiguous &&
      (bins[0]?.[0] ?? -1) === 0 &&
      (bins[2]?.[bins[2].length - 1] ?? -1) === 30,
    `sizes=${sizes.join("/")}`,
  );
}

// T5. The degenerate bin counts the tool now rejects at the boundary, asserted
//     on the function rather than the CLI: one bin is the ungrouped mean and
//     more bins than images cannot be equal-count. Neither may lose or
//     duplicate an image on the way.
{
  const ranks = Array.from({ length: 5 }, (_, i) => i);
  const one = equalCountBins(ranks, 1);
  const many = equalCountBins(ranks, 8);
  check(
    "binning neither drops nor duplicates an image at the degenerate counts",
    one.length === 1 &&
      one[0]?.length === 5 &&
      many.length === 8 &&
      many.flat().length === 5 &&
      new Set(many.flat()).size === 5,
    `1 bin=${one[0]?.length} 8 bins=[${many.map((b) => b.length).join(",")}]`,
  );
}

// T6. The positional join. Every arm's per-image series is read as parallel to
//     the first arm's image list; sweep.ts scores every arm over one input list
//     so that holds today, but nothing requires it, and a filtered or reordered
//     row would build a table of the right shape out of mismatched pairs.
{
  const aligned = [
    { label: "a", imageNames: ["p", "q", "r"] },
    { label: "b", imageNames: ["p", "q", "r"] },
  ];
  const shortArm = [
    { label: "a", imageNames: ["p", "q", "r"] },
    { label: "b", imageNames: ["p", "q"] },
  ];
  const reordered = [
    { label: "a", imageNames: ["p", "q", "r"] },
    { label: "b", imageNames: ["p", "r", "q"] },
  ];
  const shortMsg = alignmentError(shortArm) ?? "";
  const reorderMsg = alignmentError(reordered) ?? "";
  check(
    "aligned arms pass, and a short or reordered arm is refused by name",
    alignmentError(aligned) === null &&
      shortMsg.includes('"b"') &&
      shortMsg.includes("2 images") &&
      reorderMsg.includes('"r"') &&
      reorderMsg.includes("position 1"),
    `short=${JSON.stringify(shortMsg.slice(0, 48))} reorder=${JSON.stringify(reorderMsg.slice(0, 48))}`,
  );
}

// T7. An empty sweep is refused rather than treated as aligned — the vacuous
//     truth is exactly the answer that produces an empty table and exit 0.
check(
  "a sweep with no rows is refused",
  alignmentError([]) !== null,
  `${alignmentError([])}`,
);

console.log(
  "\ninference — the intervals, adjustments and guards sweeps read\n",
);

// Every verdict a sweep prints now turns on these: a Holm adjustment that
// failed to be monotone, a correlation threshold off by a degree of freedom,
// or a guard that read the wrong end of an interval would each print a table
// of exactly the right shape. Answers known by hand or from standard tables.

// S1. Holm against a worked family: sorted .005 .01 .03 .04 scale by 4 3 2 1
//     to .02 .03 .06 .04, and monotonicity lifts the last to .06. Returned in
//     input order, with a non-finite entry left out of m and passed through.
{
  const adjusted = holm([0.01, 0.04, 0.03, 0.005, Number.NaN]);
  const want = [0.03, 0.06, 0.06, 0.02];
  check(
    "Holm scales by the step-down multipliers, stays monotone, keeps input order",
    want.every((w, i) => Math.abs((adjusted[i] ?? 0) - w) < 1e-12) &&
      Number.isNaN(adjusted[4]),
    `adjusted=${adjusted.map((p) => p.toFixed(3)).join(" ")}`,
  );
}

// S2. The t quantile and the correlation threshold it gives. t(0.975, 29) is
//     2.0452 in every table; r_crit = t/√(df + t²) = 0.3550 at n = 31, the
//     threshold §13.5 quotes. And the Fisher-z interval at r = 0.29, n = 31:
//     atanh(0.29) ± 1.95996/√28 mapped back is [−0.0717, 0.5843].
{
  const t = studentTQuantile(0.975, 29);
  const inf = correlationInference(0.29, 31);
  check(
    "t(0.975, 29), the n = 31 threshold and a Fisher-z interval match tables",
    Math.abs(t - 2.04523) < 1e-5 &&
      inf !== null &&
      Math.abs(inf.rCritical - 0.35505) < 1e-5 &&
      inf.ci !== null &&
      Math.abs(inf.ci[0] + 0.07171) < 1e-4 &&
      Math.abs(inf.ci[1] - 0.5843) < 1e-4 &&
      Math.abs(normalQuantile(0.975) - 1.959964) < 1e-6,
    `t=${t.toFixed(5)} rcrit=${inf?.rCritical.toFixed(5)} ci=${inf?.ci?.map((v) => v.toFixed(4)).join(",")}`,
  );
}

// S2b. The correlation t-test p, which §13.5's "survives Holm" readings rest
//      on. t = r·√(29/(1 − r²)) on 29 df, two-sided, against a direct
//      numerical integral of the t density: r = 0.29 gives t = 1.63182 and
//      p = 0.113530; r = 0.5 gives t = 3.10913 and p = 0.0041806. The sign of r
//      does not move p, and at r = rCritical p is α exactly — the test and the
//      threshold solve the same equation.
{
  const at29 = correlationInference(0.29, 31);
  const neg29 = correlationInference(-0.29, 31);
  const at50 = correlationInference(0.5, 31);
  const atCrit =
    at29 === null ? null : correlationInference(at29.rCritical, 31);
  check(
    "correlation p matches the t distribution, is symmetric in r, and is α at the threshold",
    at29 !== null &&
      neg29 !== null &&
      at50 !== null &&
      atCrit !== null &&
      Math.abs(at29.p - 0.1135304) < 1e-6 &&
      Math.abs(neg29.p - at29.p) < 1e-12 &&
      Math.abs(at50.p - 0.0041806) < 1e-6 &&
      Math.abs(atCrit.p - 0.05) < 1e-6,
    `p(0.29)=${at29?.p.toFixed(7)} p(−0.29)=${neg29?.p.toFixed(7)} p(0.5)=${at50?.p.toFixed(7)} p(rcrit)=${atCrit?.p.toFixed(7)}`,
  );
}

// S3. The bootstrap p at its two ends: two bit-identical arms (every delta 0)
//     are p = 1, and a delta that is positive on every image is at the floor
//     2/(B + 1) rather than 0.
{
  const same = bootstrapP([0, 0, 0, 0]);
  const always = bootstrapP([0.1, 0.2, 0.3, 0.4]);
  check(
    "bootstrap p is 1 for identical arms and 2/(B+1) for a one-signed delta",
    same === 1 && Math.abs(always - 2 / 10_001) < 1e-12,
    `identical=${same} one-signed=${always}`,
  );
}

// S4. The guard verdict reads the right end of each interval, in all three
//     states. SSIMULACRA2's tolerance is a floor on the lower bound; a relative
//     guard's is a ceiling on the upper bound, scaled by the incumbent's mean.
{
  const stat = (
    key: "ssimulacra2" | "butteraugli" | "ringing" | "spurious",
    ci: [number, number],
    baseMean: number,
  ) => ({
    key,
    label: key,
    better: key === "ssimulacra2" ? ("higher" as const) : ("lower" as const),
    pairs: 31,
    baseMean,
    meanDelta: (ci[0] + ci[1]) / 2,
    ci,
    p: 0.5,
    pHolm: 0.5,
  });
  const tol = { ssimulacra2Drop: 1, relativeRise: 0.02 };
  const arm = (ssim: [number, number], butter: [number, number]) => ({
    label: "arm",
    stats: [stat("ssimulacra2", ssim, -300), stat("butteraugli", butter, 50)],
  });
  // Butteraugli's margin is 0.02 × 50 = 1.0.
  const ok = guardVerdictOnIntervals(arm([-0.9, 2], [-1, 0.9]), tol, undefined);
  const straddle = guardVerdictOnIntervals(
    arm([-1.5, 2], [-1, 0.9]),
    tol,
    undefined,
  );
  const shown = guardVerdictOnIntervals(
    arm([-0.5, 2], [1.1, 3]),
    tol,
    undefined,
  );
  const unscored = guardVerdictOnIntervals(undefined, tol, undefined);
  check(
    "interval guards: inside = ok, straddling = inconclusive, beyond = FAIL",
    ok === "ok" &&
      straddle === "inconclusive" &&
      shown === "FAIL" &&
      unscored === "ok",
    `inside=${ok} straddle=${straddle} beyond=${shown} unscored=${unscored}`,
  );

  // S4b. The artifact guards, which apply only where the run declared an
  //      artifactRise. Spurious has an incumbent mean of 10, so at rise 0.5
  //      its margin is 5. Ringing has an incumbent mean of 0, where a relative
  //      margin would be 0 and any rise at all a FAIL; the margin is the
  //      ARTIFACT_ZERO_BASE_ALLOWANCE instead. Each is driven through all
  //      three states with the other guards held at ok, and a ringing interval
  //      that would FAIL is ignored when no artifactRise is declared.
  const zero = ARTIFACT_ZERO_BASE_ALLOWANCE;
  const withArtifacts = (ring: [number, number], spur: [number, number]) => ({
    label: "arm",
    stats: [
      stat("ssimulacra2", [-0.5, 2], -300),
      stat("butteraugli", [-1, 0.5], 50),
      stat("ringing", ring, 0),
      stat("spurious", spur, 10),
    ],
  });
  const verdict = (ring: [number, number], spur: [number, number]) =>
    guardVerdictOnIntervals(withArtifacts(ring, spur), tol, 0.5);
  const artifactStates = {
    ringOk: verdict([0, zero - 0.1], [-1, 4]),
    ringStraddle: verdict([0, zero + 0.1], [-1, 4]),
    ringBeyond: verdict([zero + 0.1, zero + 1], [-1, 4]),
    spurOk: verdict([0, 0.5], [-1, 4.9]),
    spurStraddle: verdict([0, 0.5], [4, 6]),
    spurBeyond: verdict([0, 0.5], [5.1, 6]),
    undeclared: guardVerdictOnIntervals(
      withArtifacts([zero + 0.1, zero + 1], [5.1, 6]),
      tol,
      undefined,
    ),
  };
  check(
    "artifact guards: zero-incumbent allowance and relative margin, in all three states, only when declared",
    zero > 0 &&
      artifactStates.ringOk === "ok" &&
      artifactStates.ringStraddle === "inconclusive" &&
      artifactStates.ringBeyond === "FAIL" &&
      artifactStates.spurOk === "ok" &&
      artifactStates.spurStraddle === "inconclusive" &&
      artifactStates.spurBeyond === "FAIL" &&
      artifactStates.undeclared === "ok",
    JSON.stringify(artifactStates),
  );
}

// S5. compareArms against a reference other than row 0: Δ is arm − reference
//     with that sign, the reference is not compared with itself, and Holm's m
//     is the number of arms compared. An arm identical to the reference scores
//     Δ = 0 and p = 1.
{
  const rows = [
    { label: "a", perImage: { ciede2000: [10, 11, 12, 13] } },
    { label: "ref", perImage: { ciede2000: [9, 10, 11, 12] } },
    { label: "same", perImage: { ciede2000: [9, 10, 11, 12] } },
  ];
  const cmps = compareArms(rows, 1);
  const a = cmps.find((c) => c.label === "a")?.stats[0];
  const same = cmps.find((c) => c.label === "same")?.stats[0];
  check(
    "compareArms: arm − reference, reference excluded, Holm over the arms",
    cmps.length === 2 &&
      a !== undefined &&
      a.meanDelta === 1 &&
      a.ci[0] === 1 &&
      Math.abs(a.pHolm - 2 * a.p) < 1e-12 &&
      same !== undefined &&
      same.meanDelta === 0 &&
      same.p === 1,
    `labels=${cmps.map((c) => c.label).join(",")} Δa=${a?.meanDelta} pa=${a?.p} pHolm=${a?.pHolm} Δsame=${same?.meanDelta}`,
  );
}

console.log("\nverify-benchmark — what passes, what is skipped, what fails\n");

// Fixtures: a run is a list of cell ids plus what it recorded unavailable, and
// a table is markdown parsed exactly as PERFORMANCE.md is. The binding reads
// `encode/<row label>/t1` and throws on a missing cell, as §7's binding does.

function fixtureRun(
  file: string,
  ids: string[],
  unavailable?: RunDoc["unavailable"],
  overrides: Partial<RunDoc> = {},
): RunDoc {
  return {
    file,
    schema: "chromahash-perf/2",
    git: { commit: "abc1234", dirty: false },
    environment: { cpuModel: "fixture", arch: "x64", cores: 1 },
    config: { mode: "bounded", reps: 1 },
    cells: ids.map((id) => ({
      id,
      nsPerOp: 1_000_000,
      medianNsPerOp: 1_000_000,
      iqrPct: 0,
      noisy: false,
      iters: 1,
    })),
    ...(unavailable ? { unavailable } : {}),
    ...overrides,
  };
}

type UnavailableEntry = NonNullable<RunDoc["unavailable"]>[number];

/** An `unavailable` record as the driver writes it; no kind means a pre-kind run. */
function unavailableEntry(
  target: string,
  reason: string,
  kind: string | undefined,
): UnavailableEntry {
  return kind === undefined ? { target, reason } : { target, reason, kind };
}

const FIXTURE_BINDING: Binding = {
  section: "7",
  index: 0,
  title: "fixture",
  columns: {
    "encode t1": (row, R) => R.us(`encode/${clean(row("implementation"))}/t1`),
  },
};

function fixtureTable(rows: [string, string][]): string {
  return [
    "## 7. Fixture",
    "",
    "| implementation | encode t1 |",
    "|---|---:|",
    ...rows.map(([label, cell]) => `| ${label} | ${cell} |`),
    "",
  ].join("\n");
}

function gate(
  rows: [string, string][],
  runs: RunDoc[],
): { failures: Failure[]; counters: Counters; R: Runs } {
  const table = parseTables(fixtureTable(rows))[0];
  const failures: Failure[] = [];
  const counters: Counters = {
    checked: 0,
    unbound: 0,
    placeholders: 0,
    unavailable: 0,
  };
  const edits: Edit[] = [];
  const R = new Runs(runs);
  if (table) checkTable(FIXTURE_BINDING, table, R, failures, counters, edits);
  return { failures, counters, R };
}

const details = (fs: Failure[]): string =>
  fs.map((f) => f.detail ?? f.measured).join(" | ");

const SWIFT_ABSENT = [
  { target: "Swift", reason: "spawnSync ChromaHashCLI ENOENT", kind: "absent" },
];

// B1. The marker is a token, not prose: emphasis required, host from a closed
//     list. The first version matched any phrase ending in "only", and every
//     bound cell runs through it.
{
  const accepted = ["*macOS only*", "**macOS only**", " *Linux only* "];
  const rejected = [
    "macOS only",
    "*encoder only*",
    "*batch only*",
    "*macOS only* (see §0)",
    "*macos only*",
    "",
  ];
  const wrongly = [
    ...accepted.filter((c) => parseUnavailableMarker(c) === null),
    ...rejected.filter((c) => parseUnavailableMarker(c) !== null),
  ];
  check(
    "a marker needs its emphasis and a known host; prose ending in 'only' is not one",
    wrongly.length === 0 &&
      parseUnavailableMarker("*macOS only*") === "macOS only",
    wrongly.length === 0
      ? `${accepted.length} accepted, ${rejected.length} rejected`
      : `misread: ${JSON.stringify(wrongly)}`,
  );
}

// B2. An absent target's marked row is skipped and counted — the one case
//     the skip exists for.
{
  const { failures, counters } = gate(
    [
      ["Rust", "1.0 ms"],
      ["Swift", "*macOS only*"],
    ],
    [fixtureRun("perf-report.json", ["encode/Rust/t1"], SWIFT_ABSENT)],
  );
  check(
    "an absent target's marked row is skipped, and the measured row checked",
    failures.length === 0 &&
      counters.unavailable === 1 &&
      counters.checked === 1,
    `failures=${failures.length} unavailable=${counters.unavailable} checked=${counters.checked}`,
  );
}

// B3. A *number* on an absent target is failed: nothing measured it. This is
//     the case the skip used to wave through.
{
  const { failures } = gate(
    [["Swift", "1.0 ms"]],
    [fixtureRun("perf-report.json", ["encode/Rust/t1"], SWIFT_ABSENT)],
  );
  check(
    "a documented number on an absent target fails",
    failures.length === 1 &&
      (failures[0]?.detail ?? "").includes("no committed run measured Swift"),
    details(failures),
  );
}

// B4/B5. Only `absent` may be skipped. A probe that found the target and saw
//        it fail is a regression, and a run too old to say which it saw cannot
//        be trusted to mean "absent" — both fail even with a marker.
for (const [label, kind, needle] of [
  ["broken", "broken", "regression in the target"],
  ["unclassified (no kind)", undefined, "before absent/broken"],
  ["unrecognised-kind", "missing", "before absent/broken"],
] as const) {
  const { failures, counters } = gate(
    [["Swift", "*macOS only*"]],
    [
      fixtureRun(
        "perf-report.json",
        ["encode/Rust/t1"],
        [unavailableEntry("Swift", "exit 1\nstack", kind)],
      ),
    ],
  );
  check(
    `the marked row of a target recorded ${label} fails rather than being skipped`,
    failures.length === 1 &&
      counters.unavailable === 0 &&
      (failures[0]?.detail ?? "").includes(needle),
    details(failures),
  );
}

// B6. Across two runs, `broken` outranks `absent` in either order: if any run
//     got far enough to see the target fail, "not built here" is not the story.
for (const order of ["absent first", "broken first"] as const) {
  const a = fixtureRun("perf-report-full.json", [], SWIFT_ABSENT);
  const b = fixtureRun(
    "perf-report.json",
    [],
    [{ target: "Swift", reason: "exit 1", kind: "broken" }],
  );
  const R = new Runs(order === "absent first" ? [a, b] : [b, a]);
  check(
    `broken outranks absent across runs (${order})`,
    R.unavailable.get("Swift")?.kind === "broken",
    `kind=${R.unavailable.get("Swift")?.kind}`,
  );
}

// B7. The clearing pass is order-independent: a target one run measured and
//     another recorded absent is measured, whichever file is read first. It
//     used to clear only against the same file's cells, so the full sweep on
//     macOS (Swift present) read before the bounded one on Linux (Swift
//     absent) left Swift marked unavailable while cells held it.
for (const order of ["measured first", "absent first"] as const) {
  const measured = fixtureRun("perf-report-full.json", [
    "encode/Rust/t1",
    "encode/Swift/t1",
  ]);
  const absent = fixtureRun(
    "perf-report.json",
    ["encode/Rust/t1"],
    SWIFT_ABSENT,
  );
  const runs =
    order === "measured first" ? [measured, absent] : [absent, measured];
  const kept = new Runs(runs).unavailable.has("Swift");
  const ok = gate([["Swift", "1.0 ms"]], runs);
  const marked = gate([["Swift", "*macOS only*"]], runs);
  check(
    `a target any run measured is not unavailable (${order})`,
    !kept &&
      ok.failures.length === 0 &&
      ok.counters.checked === 1 &&
      marked.failures.length === 1 &&
      (marked.failures[0]?.detail ?? "").includes(
        "but a committed run measured Swift",
      ),
    `stillUnavailable=${kept} numberFailures=${ok.failures.length} marker=${details(marked.failures)}`,
  );
}

// B8. A marker on a target no run probed at all (`--impls Rust`) is failed
//     with that reason, not with the false claim that a run measured it.
{
  const { failures } = gate(
    [["Swift", "*macOS only*"]],
    [fixtureRun("perf-report.json", ["encode/Rust/t1"])],
  );
  check(
    "a marker on a never-probed target fails as never probed",
    failures.length === 1 &&
      (failures[0]?.detail ?? "").includes("never probed"),
    details(failures),
  );
}

// B9. A parenthesised target name matches its own record. `bare()` strips the
//     parenthetical, and "Rust (scalar)" is a driver target name verbatim.
{
  const { failures, counters } = gate(
    [["Rust (scalar)", "*x86_64 only*"]],
    [
      fixtureRun(
        "perf-report.json",
        ["encode/Rust/t1"],
        [{ target: "Rust (scalar)", reason: "ENOENT", kind: "absent" }],
      ),
    ],
  );
  check(
    "a parenthesised absent target is found and its marked row skipped",
    failures.length === 0 && counters.unavailable === 1,
    `failures=${details(failures)} unavailable=${counters.unavailable}`,
  );
}

// B10. A run in the wrong schema is rejected, not merged: /1 reported medians
//      and /2 reports minima. A dirty run is loaded and listed as dirty.
{
  const R = new Runs([
    fixtureRun("old.json", ["encode/Rust/t1"], undefined, {
      schema: "chromahash-perf/1",
    }),
    fixtureRun("dirty.json", ["encode/Go/t1"], undefined, {
      git: { commit: "abc1234", dirty: true },
    }),
  ]);
  check(
    "a wrong-schema run is rejected and a dirty run is flagged",
    R.rejected.length === 1 &&
      R.rejected[0]?.startsWith("old.json") === true &&
      !R.has("encode/Rust/t1") &&
      R.loaded.length === 1 &&
      R.dirty.join() === "dirty.json",
    `rejected=${JSON.stringify(R.rejected)} dirty=${JSON.stringify(R.dirty)}`,
  );
}

// S1–S7. §0's host-stability claim: two bounded sweeps at one commit, every
//        shared cell within CROSS_RUN_TOLERANCE, and §0's table row saying
//        what the check says. The committed tree holds one bounded run, so
//        only the skip path runs there; pass and every fail path are driven
//        from fixtures.

/** A run whose cells take the given microseconds. */
function timedRun(
  file: string,
  us: Record<string, number>,
  overrides: Partial<RunDoc> = {},
): RunDoc {
  const run = fixtureRun(file, Object.keys(us), undefined, overrides);
  return {
    ...run,
    cells: run.cells.map((c) => ({
      ...c,
      nsPerOp: (us[c.id] ?? 0) * 1000,
      medianNsPerOp: (us[c.id] ?? 0) * 1000,
    })),
  };
}

/** §0's reproducibility table, holding the stability row with this cell. */
const stabilityDoc = (cell: string): string =>
  [
    "> | Claim | Reproducible from the tree? |",
    "> |---|---|",
    "> | Every table below equals a cell | **Yes** |",
    `> | This host's cross-run agreement | ${cell} |`,
  ].join("\n");

// S1. One bounded run: the check is skipped and says why. "No" is the honest
//     row; "Yes" fails, because nothing was compared.
{
  const s = checkStability(
    new Runs([timedRun("perf-report.json", { "encode/Rust/t1": 1000 })]),
  );
  const no = checkStabilityClaim(stabilityDoc("**No.** one sweep"), s);
  const yes = checkStabilityClaim(stabilityDoc("**Yes**"), s);
  check(
    "one bounded run skips the stability check; §0 may say No and may not say Yes",
    s.status === "skip" &&
      (s.problems[0] ?? "").includes("1 bounded run(s)") &&
      no.length === 0 &&
      yes.length === 1 &&
      (yes[0]?.detail ?? "").includes("did not pass"),
    `status=${s.status} no=${details(no)} yes=${details(yes)}`,
  );
}

// S2. Two bounded runs at one commit, within the bar: pass. "No" now
//     understates the tree and fails; "Yes" must quote the check's figures.
{
  const R = new Runs([
    timedRun("perf-report.json", {
      "encode/Rust/t1": 1000,
      "decode/Rust": 200,
    }),
    timedRun("perf-report-2.json", {
      "encode/Rust/t1": 1050,
      "decode/Rust": 204,
    }),
  ]);
  const s = checkStability(R);
  const no = checkStabilityClaim(stabilityDoc("**No.**"), s);
  const plain = checkStabilityClaim(stabilityDoc("**Yes**"), s);
  const quoted = checkStabilityClaim(
    stabilityDoc("**Yes** — 2 shared cells, widest 5.0%"),
    s,
  );
  const stale = checkStabilityClaim(
    stabilityDoc("**Yes** — 12 shared cells, widest 5.5%"),
    s,
  );
  check(
    "two agreeing bounded runs pass, and §0 must say Yes with their figures",
    s.status === "pass" &&
      s.shared === 2 &&
      Math.abs((s.widest ?? 0) - 0.05) < 1e-9 &&
      R.crossRunSpread.length === 0 &&
      no.length === 1 &&
      (no[0]?.detail ?? "").includes("understates") &&
      plain.length === 1 &&
      quoted.length === 0 &&
      stale.length === 1 &&
      (stale[0]?.detail ?? "").includes('"2 shared cells", "widest 5.0%"'),
    `status=${s.status} shared=${s.shared} widest=${s.widest} no=${details(no)} plain=${details(plain)} quoted=${details(quoted)} stale=${details(stale)}`,
  );
}

// S3. A shared cell outside the bar fails the check and is itself listed as a
//     spread — the gate turns each into a failure, not a warning.
{
  const R = new Runs([
    timedRun("perf-report.json", {
      "encode/Rust/t1": 1000,
      "decode/Rust": 200,
    }),
    timedRun("perf-report-2.json", {
      "encode/Rust/t1": 1200,
      "decode/Rust": 201,
    }),
  ]);
  const s = checkStability(R);
  check(
    "a bounded pair more than the tolerance apart on one cell fails",
    s.status === "fail" &&
      (s.problems[0] ?? "").includes("1 of 2 shared cell(s)") &&
      (s.problems[0] ?? "").includes("widest 20.0%") &&
      R.crossRunSpread.length === 1 &&
      (R.crossRunSpread[0] ?? "").startsWith("encode/Rust/t1:"),
    `status=${s.status} problems=${JSON.stringify(s.problems)} spread=${JSON.stringify(R.crossRunSpread)}`,
  );
}

// S4. Spread is pairwise. With the full sweep read first, the two bounded runs
//     were each compared with it and never with each other, so a pair 18.5%
//     apart — each under 10% from the full sweep — passed unnoticed.
{
  const R = new Runs([
    timedRun(
      "perf-report-full.json",
      { "encode/Rust/t1": 1000 },
      {
        config: { mode: "full", reps: 1 },
      },
    ),
    timedRun("perf-report.json", { "encode/Rust/t1": 1090 }),
    timedRun("perf-report-2.json", { "encode/Rust/t1": 920 }),
  ]);
  const s = checkStability(R);
  check(
    "the two bounded runs are compared with each other, not only with the first run read",
    R.crossRunSpread.length === 1 &&
      (R.crossRunSpread[0] ?? "").includes("perf-report.json says 1090.0") &&
      (R.crossRunSpread[0] ?? "").includes("perf-report-2.json says 920.0") &&
      s.status === "fail" &&
      s.runs.join() === "perf-report.json,perf-report-2.json" &&
      R.us("encode/Rust/t1") === 1000,
    `spread=${JSON.stringify(R.crossRunSpread)} status=${s.status} runs=${s.runs.join()}`,
  );
}

// S5. The claim is one commit on one host measured twice. Agreeing runs from
//     two commits, or two CPUs, do not substantiate it.
for (const [label, overrides, needle] of [
  [
    "different commits",
    { git: { commit: "def5678", dirty: false } },
    "different commits",
  ],
  [
    "different CPUs",
    { environment: { cpuModel: "other", arch: "x64", cores: 1 } },
    "different CPUs",
  ],
] as const) {
  const s = checkStability(
    new Runs([
      timedRun("perf-report.json", { "encode/Rust/t1": 1000 }),
      timedRun("perf-report-2.json", { "encode/Rust/t1": 1000 }, overrides),
    ]),
  );
  check(
    `an agreeing bounded pair from ${label} fails`,
    s.status === "fail" && s.problems.some((p) => p.includes(needle)),
    `status=${s.status} problems=${JSON.stringify(s.problems)}`,
  );
}

// S6. Two bounded runs that share no cell compared nothing, and fail rather
//     than passing vacuously.
{
  const s = checkStability(
    new Runs([
      timedRun("perf-report.json", { "encode/Rust/t1": 1000 }),
      timedRun("perf-report-2.json", { "decode/Rust": 200 }),
    ]),
  );
  check(
    "a bounded pair with no shared cell fails instead of passing vacuously",
    s.status === "fail" &&
      s.shared === 0 &&
      s.problems.some((p) => p.includes("share no cell")),
    `status=${s.status} shared=${s.shared} problems=${JSON.stringify(s.problems)}`,
  );
}

// S7. §0 must carry the row, and it must answer Yes or No: a missing or
//     reworded row fails rather than exempting the claim from the check.
{
  const s = checkStability(
    new Runs([timedRun("perf-report.json", { "encode/Rust/t1": 1000 })]),
  );
  const missing = checkStabilityClaim("> | Claim | Reproducible? |", s);
  const vague = checkStabilityClaim(stabilityDoc("Partly"), s);
  check(
    "a missing or non-Yes/No stability row fails",
    missing.length === 1 &&
      (missing[0]?.detail ?? "").includes("must state") &&
      vague.length === 1 &&
      (vague[0]?.detail ?? "").includes('"Yes" or "No"'),
    `missing=${details(missing)} vague=${details(vague)}`,
  );
}

// B11. §1's baseline: every way of not having one is an error with a reason,
//      never a null that `checkTable` would count as deliberately unbound.
{
  const cell: StageCell = {
    ns: { whole_encode: 1000 },
    sharePct: { dct_forward: 100 },
    git: { rev: "abc1234", dirty: false },
  };
  const cases: [string, string | null, string][] = [
    ["no file", null, "does not exist"],
    ["unparseable", "{", "not valid JSON"],
    [
      "wrong schema",
      JSON.stringify({
        schema: "chromahash-perf-stages/0",
        cells: { a: cell },
      }),
      "expected chromahash-perf-stages/1",
    ],
    ["no schema", JSON.stringify({ cells: { a: cell } }), "schema (none)"],
    [
      "no cells",
      JSON.stringify({ schema: "chromahash-perf-stages/1", cells: {} }),
      "holds no cells",
    ],
  ];
  const wrong = cases.filter(([, text, needle]) => {
    const r = parseStages(text);
    return r.cells !== null || !(r.error ?? "").includes(needle);
  });
  const good = parseStages(
    JSON.stringify({
      schema: "chromahash-perf-stages/1",
      cells: { "100x100-t1": cell },
    }),
  );
  check(
    "a missing, unparseable, wrong-schema or empty stages file is an error",
    wrong.length === 0 && good.error === null && good.cells !== null,
    wrong.length === 0
      ? `${cases.length} refused, a valid file accepted`
      : `not refused: ${wrong.map(([n]) => n).join(", ")}`,
  );
}

// B12. §1's provenance: one clean commit across all three columns, or a
//      failure naming the cells that are not.
{
  const at = (rev: string, dirty: boolean): StageCell => ({
    ns: {},
    sharePct: {},
    git: { rev, dirty },
  });
  const clean3 = checkStagesProvenance({
    a: at("e53e6cd", false),
    b: at("e53e6cd", false),
    c: at("e53e6cd", false),
  });
  const dirty = checkStagesProvenance({
    a: at("e53e6cd", false),
    b: at("e53e6cd", true),
  });
  const mixed = checkStagesProvenance({
    a: at("e53e6cd", false),
    b: at("1111111", false),
  });
  const unrecorded = checkStagesProvenance({
    a: at("e53e6cd", false),
    b: { ns: {}, sharePct: {} } as unknown as StageCell,
  });
  check(
    "stage cells from a dirty tree or from different commits fail",
    clean3.length === 0 &&
      dirty.length === 1 &&
      dirty[0]?.column === "git.dirty" &&
      dirty[0]?.row === "b" &&
      mixed.length === 1 &&
      mixed[0]?.column === "git.rev" &&
      mixed[0]?.measured === "2 commits" &&
      unrecorded.some((f) => f.column === "git.rev"),
    `clean=${clean3.length} dirty=${JSON.stringify(dirty.map((f) => f.row))} mixed=${JSON.stringify(mixed.map((f) => f.measured))} unrecorded=${unrecorded.length}`,
  );
}

// B13. Prose claims: the figure must be quoted exactly once and agree with the
//      cells it sums to the precision it is written at. The sum case is the
//      historical slip — 5.43 + 6.91 + 4.17 = 16.51, which "16.5" states and
//      "16.6" (the parts rounded first, then added) does not.
{
  const stages: Record<string, StageCell> = {
    "512x512-t1": {
      ns: {},
      sharePct: { linearize: 5.43, oklab_forward: 6.91, composite: 4.17 },
      git: { rev: "e53e6cd", dirty: false },
    },
  };
  const claim: ProseClaim = {
    what: "pipeline",
    pattern: /the colour pipeline is ([\d.]+)%/,
    cell: "512x512-t1",
    stages: ["linearize", "oklab_forward", "composite"],
  };
  const right = checkProseClaims(
    "So the colour pipeline is 16.5% here.",
    stages,
    [claim],
  );
  const wrong = checkProseClaims(
    "So the colour pipeline is 16.6% here.",
    stages,
    [claim],
  );
  const finer = checkProseClaims(
    "So the colour pipeline is 16.52% here.",
    stages,
    [claim],
  );
  const gone = checkProseClaims("Reworded entirely.", stages, [claim]);
  const twice = checkProseClaims(
    "the colour pipeline is 16.5% and the colour pipeline is 16.5%",
    stages,
    [claim],
  );
  check(
    "a prose figure is checked once, at its own precision, and a missing or doubled sentence fails",
    right.checked === 1 &&
      right.failures.length === 0 &&
      wrong.failures.length === 1 &&
      wrong.failures[0]?.measured === "16.51%" &&
      finer.failures.length === 1 &&
      gone.failures.length === 1 &&
      (gone.failures[0]?.detail ?? "").includes("edited without updating") &&
      gone.checked === 0 &&
      twice.failures.length === 1 &&
      (twice.failures[0]?.detail ?? "").includes("must name one figure"),
    `right=${right.failures.length} wrong=${details(wrong.failures)} finer=${finer.failures.length} gone=${gone.failures.length} twice=${twice.failures.length}`,
  );
}

// B14. A prose claim bound to a cell or stage the baseline lacks fails. It
//      used to be skipped, so a claim pointing at the wrong cell never failed.
{
  const stages: Record<string, StageCell> = {
    "512x512-t1": {
      ns: {},
      sharePct: { linearize: 5.43 },
      git: { rev: "e53e6cd", dirty: false },
    },
  };
  const claim = (cell: string, stage: string): ProseClaim => ({
    what: "x",
    pattern: /is ([\d.]+)%/,
    cell,
    stages: [stage],
  });
  const noCell = checkProseClaims("is 5.4%", stages, [
    claim("100x100-t1", "linearize"),
  ]);
  const noStage = checkProseClaims(
    "is 5.4%",
    stages,
    [claim("512x512-t1", "composite")],
    "perf-decode-stages.json",
  );
  check(
    "a prose claim bound to a missing cell or stage fails, naming the baseline",
    noCell.failures.length === 1 &&
      noCell.checked === 0 &&
      (noCell.failures[0]?.detail ?? "").includes("has no cell 100x100-t1") &&
      noStage.failures.length === 1 &&
      (noStage.failures[0]?.detail ?? "").includes(
        "perf-decode-stages.json records no composite",
      ),
    `noCell=${details(noCell.failures)} noStage=${details(noStage.failures)}`,
  );
}

// B15. §1.1's baseline: refused on §1's terms, under its own schema.
{
  const cases: [string, string | null, string][] = [
    ["no file", null, "benchmark:decode-stages 100 100 4 20"],
    [
      "§1's schema",
      JSON.stringify({ schema: "chromahash-perf-stages/1", cells: { a: {} } }),
      "expected chromahash-perf-decode-stages/1",
    ],
    [
      "no cells",
      JSON.stringify({ schema: "chromahash-perf-decode-stages/1", cells: {} }),
      "holds no cells",
    ],
  ];
  const wrong = cases.filter(([, text, needle]) => {
    const r = parseDecodeStages(text);
    return r.cells !== null || !(r.error ?? "").includes(needle);
  });
  check(
    "a missing, wrong-schema or empty decode-stages file is an error",
    wrong.length === 0,
    wrong.length === 0
      ? "3 refused"
      : `not refused: ${wrong.map(([n]) => n).join(", ")}`,
  );
}

// B16. §1.1's provenance: a decode cell must say it reproduced the spec
//      vectors, be filed under the key its fields describe, and carry shares
//      that are its own ns over whole_decode.
{
  const good = (): DecodeStageCell => ({
    width: 100,
    height: 100,
    tier: 4,
    iters: 20,
    cap: { width: 32, height: 32 },
    render: { width: 32, height: 32 },
    hashBytes: 1623,
    vectorsChecked: 19,
    ns: {
      selection: 400,
      render: 590,
      unmarked: 10,
      stage_sum: 990,
      whole_decode: 1000,
    },
    sharePct: { selection: 40, render: 59, unmarked: 1 },
    git: { rev: "e68291e", dirty: false },
  });
  const run = (
    mut: (c: DecodeStageCell) => void,
    key = "100x100-t4-cap32x32",
  ) => {
    const c = good();
    mut(c);
    return checkDecodeStagesProvenance({ [key]: c }).map((f) => f.column);
  };
  const cases: [string, string[], string][] = [
    ["clean", run(() => {}), ""],
    [
      "no vector check",
      run((c) => {
        c.vectorsChecked = 0;
      }),
      "vectorsChecked",
    ],
    [
      "vector check absent",
      run((c) => {
        (c as { vectorsChecked: number | undefined }).vectorsChecked =
          undefined;
      }),
      "vectorsChecked",
    ],
    ["wrong key", run(() => {}, "100x100-t4-natural"), "key"],
    [
      "zero iters",
      run((c) => {
        c.iters = 0;
      }),
      "iters",
    ],
    [
      "share edited",
      run((c) => {
        c.sharePct.render = 60;
      }),
      "sharePct",
    ],
    [
      "share missing",
      run((c) => {
        c.sharePct = { selection: 40, render: 59 };
      }),
      "sharePct",
    ],
    [
      // A key present with no number: `NaN > tol` is false, so a check
      // written as "fail when off by more than tol" would wave it through.
      "share not a number",
      run((c) => {
        c.sharePct.render = undefined as unknown as number;
      }),
      "sharePct",
    ],
    [
      "sum exceeds whole",
      run((c) => {
        c.ns.stage_sum = 2000;
      }),
      "ns",
    ],
    [
      "dirty",
      run((c) => {
        c.git.dirty = true;
      }),
      "git.dirty",
    ],
  ];
  const wrong = cases.filter(([, cols, want]) =>
    want === "" ? cols.length !== 0 : !(cols.length === 1 && cols[0] === want),
  );
  check(
    "a decode cell without its vector check, under the wrong key, or with shares off its ns fails",
    wrong.length === 0,
    wrong.length === 0
      ? `${cases.length} cases`
      : wrong
          .map(([n, cols]) => `${n}: ${cols.join(",") || "(none)"}`)
          .join("; "),
  );
}

// B17. A stage table's rows must be exactly the stages its baseline records.
{
  const cell: StageCell = {
    ns: {},
    sharePct: { selection: 40, render: 59, unmarked: 1 },
    git: { rev: "e68291e", dirty: false },
  };
  const ok = checkStageRowCoverage(
    ["selection", "render", "unmarked"],
    { k: cell },
    "t",
  );
  const omits = checkStageRowCoverage(
    ["selection", "render"],
    { k: cell },
    "t",
  );
  const extra = checkStageRowCoverage(
    ["selection", "render", "unmarked", "idct"],
    { k: cell },
    "t",
  );
  check(
    "a stage table that omits a recorded stage or names an unrecorded one fails",
    ok.length === 0 &&
      omits.length === 1 &&
      (omits[0]?.detail ?? "").includes(
        "recorded but not in the table: unmarked",
      ) &&
      extra.length === 1 &&
      (extra[0]?.detail ?? "").includes("in the table but not recorded: idct"),
    `ok=${ok.length} omits=${details(omits)} extra=${details(extra)}`,
  );
}

console.log("\nperf probe — absent is skippable, anything else is broken\n");

// P1–P5. Real spawns, classified exactly as `run.ts` classifies a target's
//        `bench-info`. The root is fictitious so ENOENT is guaranteed and the
//        redaction has something to strip.
{
  const root = "/nonexistent-chromahash-root/checkout";
  const node = process.execPath;
  const spawn = (cmd: string, args: string[], timeout = 30_000) =>
    classifyProbe(spawnSync(cmd, args, { encoding: "utf8", timeout }), root);

  const missing = spawn(`${root}/.build/release/ChromaHashCLI`, ["bench-info"]);
  check(
    "a binary that is not there is absent, and its path is repo-relative",
    !missing.ok &&
      missing.kind === "absent" &&
      (missing.reason ?? "").includes("ENOENT") &&
      !(missing.reason ?? "").includes(root) &&
      (missing.reason ?? "").includes(".build/release/ChromaHashCLI"),
    `kind=${missing.kind} reason=${missing.reason}`,
  );

  const failing = spawn(node, [
    "-e",
    "process.stderr.write('boom');process.exit(3)",
  ]);
  check(
    "a binary that exits non-zero is broken, with what it said",
    !failing.ok && failing.kind === "broken" && failing.reason === "boom",
    `kind=${failing.kind} reason=${failing.reason}`,
  );

  const hung = spawn(node, ["-e", "setTimeout(() => {}, 60000)"], 300);
  check(
    "a binary that times out is broken",
    !hung.ok && hung.kind === "broken",
    `kind=${hung.kind} reason=${hung.reason}`,
  );

  const killed = spawn(node, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  check(
    "a binary killed by a signal is broken, and names the signal",
    !killed.ok &&
      killed.kind === "broken" &&
      killed.reason === "killed by SIGKILL",
    `kind=${killed.kind} reason=${killed.reason}`,
  );

  const silent = spawn(node, [
    "-e",
    "process.stderr.write(' \\n');process.exit(4)",
  ]);
  check(
    "a binary that exits non-zero saying nothing is broken, with its status",
    !silent.ok && silent.kind === "broken" && silent.reason === "exit 4",
    `kind=${silent.kind} reason=${silent.reason}`,
  );

  const fine = spawn(node, ["-e", "console.log('runtime=fixture\\n')"]);
  check(
    "a binary that answers is available, with its info",
    fine.ok && fine.kind === undefined && fine.info === "runtime=fixture",
    `ok=${fine.ok} info=${JSON.stringify(fine.info)}`,
  );

  check(
    "the root alone redacts to '.'",
    repoRelative(`cd ${root} failed`, root) === "cd . failed" &&
      repoRelative(`${root}/a/b ENOENT`, root) === "a/b ENOENT",
    repoRelative(`cd ${root} failed`, root),
  );

  // P6. And the two classifications carried through to the gate, the way the
  //     driver records them: absent skips a marked row, broken fails it.
  const recorded = (o: typeof missing) =>
    fixtureRun(
      "perf-report.json",
      ["encode/Rust/t1"],
      [unavailableEntry("Swift", o.reason ?? "", o.kind)],
    );
  const skipped = gate([["Swift", "*macOS only*"]], [recorded(missing)]);
  const failed = gate([["Swift", "*macOS only*"]], [recorded(failing)]);
  check(
    "an absent probe skips the target's marked rows and a broken one fails them",
    skipped.failures.length === 0 &&
      skipped.counters.unavailable === 1 &&
      failed.failures.length === 1,
    `absent→failures=${skipped.failures.length} broken→failures=${failed.failures.length}`,
  );
}

// ─── verify:experiments' table register and the result reader ──────────────
//
// `verify:experiments --strict` over the committed document and results runs
// only the state they are in, where every register is complete and every
// result well-formed, so none of the branches that fail a run had executed.
// Each is driven here from a fixture that is clean but for the one defect.
console.log("\nverify:experiments — the table register and result shape\n");
{
  const table = (section: string, index: number) => ({
    section,
    index,
    line: 1,
    header: ["a", "b"],
  });
  const complete: TableRegisterInput = {
    tables: [table("1", 0), table("2", 0), table("2", 1)],
    bound: new Set(["1#0", "2#1"]),
    unboundNotes: { "2#0": "prose" },
    expectedCells: { "1#0": 3, "2#1": 2 },
    checkedByTable: new Map([
      ["1#0", 3],
      ["2#1", 2],
    ]),
    skippedTables: new Set<string>(),
  };
  const run = (over: Partial<TableRegisterInput>) =>
    tableRegisterProblems({ ...complete, ...over });
  const only = (problems: string[], needle: string) =>
    problems.length === 1 && problems[0]?.includes(needle) === true;

  const none = run({});
  check(
    "a complete register reports nothing",
    none.length === 0,
    JSON.stringify(none),
  );

  const unexplained = run({ unboundNotes: {} });
  check(
    "a table with neither a binding nor an UNBOUND_NOTES entry fails",
    only(unexplained, "§2 table 0") &&
      only(unexplained, "no binding and no UNBOUND_NOTES entry"),
    JSON.stringify(unexplained),
  );

  const ghost = run({ unboundNotes: { "2#0": "prose", "9#0": "gone" } });
  check(
    "an UNBOUND_NOTES entry for a table the document lacks fails",
    only(ghost, 'UNBOUND_NOTES["9#0"]') && only(ghost, "no such table"),
    JSON.stringify(ghost),
  );

  const boundNote = run({ unboundNotes: { "2#0": "prose", "1#0": "why" } });
  check(
    "an UNBOUND_NOTES entry for a bound table fails",
    only(boundNote, 'UNBOUND_NOTES["1#0"]') && only(boundNote, "is bound"),
    JSON.stringify(boundNote),
  );

  const short = run({
    checkedByTable: new Map([
      ["1#0", 2],
      ["2#1", 2],
    ]),
  });
  check(
    "a bound table checking fewer cells than EXPECTED_CELLS fails",
    only(short, "§1 table 0: checked 2 cell(s), EXPECTED_CELLS asserts 3"),
    JSON.stringify(short),
  );

  const silent = run({ checkedByTable: new Map([["2#1", 2]]) });
  check(
    "a bound table that checked nothing fails against its count",
    only(silent, "§1 table 0: checked 0 cell(s), EXPECTED_CELLS asserts 3"),
    JSON.stringify(silent),
  );

  const unasserted = run({ expectedCells: { "1#0": 3 } });
  check(
    "a bound table with no EXPECTED_CELLS entry fails",
    only(unasserted, "§2 table 1: checked 2 cell(s) with no EXPECTED_CELLS"),
    JSON.stringify(unasserted),
  );

  const stale = run({ expectedCells: { "1#0": 3, "2#1": 2, "2#0": 4 } });
  check(
    "an EXPECTED_CELLS entry for an unbound table fails",
    only(stale, 'EXPECTED_CELLS["2#0"] asserts cells for a table no binding'),
    JSON.stringify(stale),
  );

  const skippedShort = run({
    checkedByTable: new Map([["2#1", 2]]),
    skippedTables: new Set(["1#0"]),
  });
  check(
    "a skipped table is not held to its count (the SKIP reports it)",
    skippedShort.length === 0,
    JSON.stringify(skippedShort),
  );

  const result = (): ResultFile => ({
    schema: RESULT_SCHEMA,
    tool: "sweep",
    name: "fixture",
    split: "tune",
    settings: {},
    provenance: {
      rev: "0".repeat(40),
      dirty: false,
      dirtyPaths: [],
      iqaCli: "iqa-cli fixture",
      config: "fixture.json",
      configSha256: "0".repeat(64),
      binaries: {},
      node: process.version,
      corpus: [
        { name: "a", sha256: "1".repeat(64) },
        { name: "b", sha256: "2".repeat(64) },
      ],
    },
    imageNames: ["a", "b"],
    rows: [
      {
        label: "arm",
        tune: null,
        tier: null,
        version: null,
        perImage: { ciede2000: [1, 2], bytes: [30, 31] },
      },
    ],
  });
  check(
    "a well-formed result has no shape problem",
    shapeProblems(result()).length === 0,
    JSON.stringify(shapeProblems(result())),
  );

  const futureSchema = result();
  futureSchema.schema = RESULT_SCHEMA + 1;
  const fs1 = shapeProblems(futureSchema);
  check(
    "a result of an unknown schema is refused",
    only(fs1, `this reader knows ${RESULT_SCHEMA}`),
    JSON.stringify(fs1),
  );

  const fewDigests = result();
  fewDigests.provenance.corpus.pop();
  const fs2 = shapeProblems(fewDigests);
  check(
    "a result with a corpus digest missing is refused",
    only(fs2, "provenance lists 1 corpus digests for 2 images"),
    JSON.stringify(fs2),
  );

  const misaligned = result();
  misaligned.provenance.corpus.reverse();
  const fs3 = shapeProblems(misaligned);
  check(
    "a result whose digests are out of image order is refused",
    only(fs3, 'corpus digest 0 is for "b", image 0 is "a"'),
    JSON.stringify(fs3),
  );

  const noCiede = result();
  const noCiedeRow = noCiede.rows[0];
  if (noCiedeRow) noCiedeRow.perImage = { bytes: [30, 31] };
  const fs4 = shapeProblems(noCiede);
  check(
    "a row with no ciede2000 series is refused",
    only(fs4, 'row "arm" carries no ciede2000 series'),
    JSON.stringify(fs4),
  );

  const ragged = result();
  const raggedRow = ragged.rows[0];
  if (raggedRow) raggedRow.perImage = { ciede2000: [1, 2], bytes: [30] };
  const fs5 = shapeProblems(ragged);
  check(
    "a series shorter than the image list is refused",
    only(fs5, 'row "arm" bytes has 1 values for 2 images'),
    JSON.stringify(fs5),
  );
}

// --- Alpha corpus: the retired holdout and withdrawn pins (#83) ------------
//
// `ensureAlphaImages` refuses the retired holdout split and never fetches a
// withdrawn pin. Neither branch runs in any sweep CI executes, so both are
// driven here through the selection it delegates to, without the network.
{
  console.log("\nalpha corpus selection:");

  let thrown = "";
  try {
    alphaImagesToFetch("holdout");
  } catch (e) {
    thrown = e instanceof Error ? e.message : String(e);
  }
  check(
    "the retired alpha holdout split is refused",
    thrown === ALPHA_HOLDOUT_RETIRED,
    thrown === "" ? "no error thrown" : thrown,
  );

  const base: AlphaImageSpec = {
    label: "fixture-kept",
    url: "https://example.invalid/kept.png",
    ext: ".png",
    width: 1,
    height: 1,
    split: "tune",
    nonOpaqueFraction: 0,
    softAlphaFraction: 0,
    sha256: "0".repeat(64),
    source: "https://example.invalid/kept",
    author: "fixture",
    licence: "CC0",
    notes: "fixture",
  };
  const fixture: AlphaImageSpec[] = [
    base,
    { ...base, label: "fixture-withdrawn", withdrawn: "gone" },
    { ...base, label: "fixture-holdout", split: "holdout" },
  ];
  const labels = (specs: AlphaImageSpec[]): string =>
    specs.map((s) => s.label).join(",");
  const tune = labels(alphaImagesToFetch("tune", fixture));
  check(
    "a withdrawn tune pin is not fetched for the tune split",
    tune === "fixture-kept",
    tune,
  );
  const all = labels(alphaImagesToFetch(undefined, fixture));
  check(
    "a withdrawn pin is not fetched with no split",
    all === "fixture-kept,fixture-holdout",
    all,
  );

  const shipped = alphaImagesToFetch().filter(
    (s) => s.withdrawn !== undefined || s.label === "cutout-wordmark-aflac",
  );
  check(
    "the deleted cutout-wordmark-aflac pin is never fetched",
    shipped.length === 0,
    labels(shipped),
  );
  check(
    "the withdrawn pin keeps its holdout split, so a cached copy cannot join tune",
    splitFor("cutout-wordmark-aflac") === "holdout",
    splitFor("cutout-wordmark-aflac"),
  );
}

// --- Photographic splits: tune2 retired, holdout2 sealed (#76) --------------
//
// The gate that opens holdout2 fails a run only on register states the
// repository is not in, and no sweep CI runs ever asks for holdout2, so every
// branch is driven here from fixtures, without the network.
{
  console.log("\nphotographic splits and the holdout2 gate:");

  const thrown = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "";
  };
  const rejected = async (f: () => Promise<unknown>): Promise<string> => {
    try {
      await f();
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "";
  };

  // The retired split: every photograph that was holdout is tune2 now.
  const kodak = splitFor("kodak07");
  check("Kodak24 is tune2", kodak === "tune2", kodak);
  const former = CURATED_IMAGES.filter((s) => s.split === "tune2");
  check(
    "the eight curated photographs of the spent holdout are tune2",
    former.length === 8 && former.every((s) => splitFor(s.label) === "tune2"),
    former.map((s) => s.label).join(","),
  );
  const stillHoldout = CURATED_IMAGES.filter((s) => s.split === "holdout");
  check(
    "no photograph is left in the retired holdout split",
    stillHoldout.length === 0,
    stillHoldout.map((s) => s.label).join(","),
  );
  check(
    "--split holdout is refused for photographs, naming tune2",
    thrown(() => parseScratchPhotoSplit("holdout")) === PHOTO_HOLDOUT_RETIRED,
    thrown(() => parseScratchPhotoSplit("holdout")),
  );
  check(
    "an unknown --split is refused, not defaulted",
    thrown(() => parseSplit("holdout3", true)).startsWith("unknown --split"),
    thrown(() => parseSplit("holdout3", true)),
  );

  // The seal: by prefix, out of "all", out of every scratch tool.
  check(
    "a sealed- image is holdout2 whatever the tables say",
    splitFor(`${HOLDOUT2_PREFIX}fixture`) === "holdout2",
    splitFor(`${HOLDOUT2_PREFIX}fixture`),
  );
  check(
    "a sealed- image is photographic, so a photo sweep can read it once opened",
    inCorpus(`${HOLDOUT2_PREFIX}fixture`, "photo"),
    "",
  );
  check(
    '"all" excludes the sealed split and keeps tune2',
    !inSplit(`${HOLDOUT2_PREFIX}fixture`, "all") &&
      inSplit("kodak07", "all") &&
      inSplit("kodak07", "tune2"),
    "",
  );
  check(
    "a scratch tool refuses holdout2",
    thrown(() => parseScratchPhotoSplit("holdout2")).includes(
      "does not read holdout2",
    ),
    thrown(() => parseScratchPhotoSplit("holdout2")),
  );
  const globbed = [
    "/fx/natural/natural-open.jpg",
    `/fx/natural/${HOLDOUT2_PREFIX}fixture.jpg`,
    "/fx/holdout/kodak07.png",
    `/fx/natural/${HOLDOUT2_PREFIX}other.png`,
  ];
  const parted = partitionSealed(globbed);
  check(
    "the report drops every cached sealed- image and keeps the rest in order",
    parted.open.join(",") ===
      "/fx/natural/natural-open.jpg,/fx/holdout/kodak07.png" &&
      parted.sealed.join(",") ===
        `/fx/natural/${HOLDOUT2_PREFIX}fixture.jpg,/fx/natural/${HOLDOUT2_PREFIX}other.png`,
    `open=${parted.open.join(",")} sealed=${parted.sealed.join(",")}`,
  );

  // The register's contract, one branch at a time.
  const register = [
    "# v0.8 decisions",
    "",
    "## D1. Entropy-coded AC",
    "",
    "**Status:** frozen",
    "",
    "### Evidence",
    "",
    "Status notes live here and are part of D1.",
    "",
    "## D1.1 A sub-question",
    "",
    "Status: open",
    "",
    "## D2 — Separable DCT",
    "",
    "```",
    "Status: frozen",
    "```",
    "- Status: decided",
    "",
    "## D3: Alpha at tiers 2-3",
    "",
    "Status: open",
    "Status: frozen",
    "",
    "## D4) No status",
    "",
    "## D5 twice",
    "Status: frozen",
    "## D5 again",
    "Status: frozen",
    "",
  ].join("\n");
  const status = (id: string): string => {
    const r = registerStatus(register, id);
    return "status" in r ? r.status : `error: ${r.error}`;
  };
  check(
    "a bold status line under its heading is read",
    status("D1") === "frozen",
    status("D1"),
  );
  check(
    "D1 does not match D1.1's heading, and D1.1 has its own status",
    status("D1.1") === "open",
    status("D1.1"),
  );
  check(
    "a status inside a fenced block is ignored; the list-item one is read",
    status("D2") === "decided",
    status("D2"),
  );
  check(
    "two status lines in one section are refused",
    status("D3").startsWith("error:") && status("D3").includes("2 status"),
    status("D3"),
  );
  check(
    "a section with no status line is refused",
    status("D4").includes("0 status"),
    status("D4"),
  );
  check(
    "a decision headed twice is refused",
    status("D5").includes("2 times"),
    status("D5"),
  );
  check(
    "an absent decision is refused",
    status("D9").includes("no decision headed"),
    status("D9"),
  );

  // The gate itself, against a fixture register on disk.
  const dir = mkdtempSync(path.join(tmpdir(), "holdout2-gate-"));
  const fixturePath = path.join(dir, "V0.8-DECISIONS.md");
  writeFileSync(fixturePath, register);
  const opened = (() => {
    try {
      return openHoldout2("D1", fixturePath);
    } catch {
      return null;
    }
  })();
  check(
    "a frozen decision opens holdout2 and records the register's digest",
    opened !== null &&
      opened.decision === "D1" &&
      /^[0-9a-f]{64}$/.test(opened.registerSha256),
    opened === null ? "refused" : opened.registerSha256.slice(0, 12),
  );
  const refusals: [string, string | undefined, string, string][] = [
    ["no --decision", undefined, fixturePath, "needs --decision"],
    ["a malformed ID", "../D1", fixturePath, "is not a decision ID"],
    ["an open decision", "D1.1", fixturePath, 'as "open"'],
    ["a decided decision", "D2", fixturePath, 'as "decided"'],
    ["an ambiguous register", "D3", fixturePath, "2 status lines"],
    ["a missing register", "D1", path.join(dir, "absent.md"), "does not exist"],
  ];
  for (const [what, id, at, expect] of refusals) {
    const message = thrown(() => openHoldout2(id, at));
    check(`the gate refuses ${what}`, message.includes(expect), message);
  }

  // One reading per question, and a pin table that agrees with the prefix.
  const existing = path.join(dir, "fixture-holdout2.json");
  writeFileSync(existing, "{}");
  check(
    "a committed holdout2 result is never overwritten",
    thrown(() => assertHoldout2Unread(existing)).includes(
      "already holds a holdout2 reading",
    ),
    thrown(() => assertHoldout2Unread(existing)),
  );
  check(
    "an unread holdout2 result path passes",
    thrown(() => assertHoldout2Unread(path.join(dir, "unread.json"))) === "",
    "",
  );
  const spec: NaturalImageSpec = {
    label: `${HOLDOUT2_PREFIX}fixture`,
    urls: ["https://example.invalid/sealed.jpg"],
    ext: ".jpg",
    width: 1,
    height: 1,
    split: "holdout2",
    sha256: "0".repeat(64),
    source: "https://example.invalid/sealed",
    author: "fixture",
    licence: "CC0",
    axis: "fixture",
    notes: "fixture",
  };
  check(
    "holdout2 pins are the sealed- ones",
    holdout2Specs([spec, { ...spec, label: "natural-open", split: "tune" }])
      .length === 1,
    "",
  );
  for (const [what, bad] of [
    ["a holdout2 pin without the prefix", { ...spec, label: "natural-x" }],
    ["a sealed- pin on another split", { ...spec, split: "tune" as const }],
  ] as const) {
    const message = thrown(() => holdout2Specs([bad]));
    check(`${what} is refused`, message.includes("is labelled"), message);
  }
  if (opened !== null) {
    const empty = await rejected(() => ensureHoldout2Images(opened, []));
    check(
      "an opened holdout2 with no pins refuses rather than scoring nothing",
      empty.includes("no pinned images"),
      empty,
    );
  }
  // The covariates holdout2 candidates are chosen on (corpus-covariates.ts).
  const [rL, ra, rb] = srgbToLab(255, 0, 0);
  check(
    "sRGB red is CIELAB (53.24, 80.09, 67.20) under D65",
    Math.abs(rL - 53.24) < 0.01 &&
      Math.abs(ra - 80.09) < 0.01 &&
      Math.abs(rb - 67.2) < 0.01,
    `${rL.toFixed(3)}, ${ra.toFixed(3)}, ${rb.toFixed(3)}`,
  );
  const size = { width: 8, height: 4 };
  const grey = covariatesOf(
    makeRgba(8, 4, () => [119, 119, 119]),
    8,
    4,
    size,
  );
  check(
    "a flat grey is achromatic, keyless and has no detail",
    // The sRGB→XYZ matrix's rows reach D65 only to 7 digits, so neutral
    // lands within 1e-4 of the axis rather than on it.
    grey.meanC < 1e-4 &&
      grey.detail === 0 &&
      grey.highKey === 0 &&
      grey.lowKey === 0 &&
      Math.abs(grey.meanL - 50) < 0.5,
    `L ${grey.meanL.toFixed(2)} C ${grey.meanC} detail ${grey.detail}`,
  );
  const white = covariatesOf(
    makeRgba(8, 4, () => [255, 255, 255]),
    8,
    4,
    size,
  );
  check(
    "white is all high-key",
    white.highKey === 1 && Math.abs(white.meanL - 100) < 1e-4,
    `L ${white.meanL} high ${white.highKey}`,
  );
  const checker = covariatesOf(
    makeRgba(8, 4, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0])),
    8,
    4,
    size,
  );
  check(
    "a one-pixel checkerboard has the largest 4-neighbour Laplacian: 4 × 100 L*",
    Math.abs(checker.detail - 400) < 1e-3 &&
      checker.highKey === 0.5 &&
      checker.lowKey === 0.5,
    `detail ${checker.detail}`,
  );
  check(
    "orientation is of the stored pixels",
    grey.orientation === "landscape" && grey.exifOrientation === null,
    grey.orientation,
  );
  for (const [licence, ok] of [
    ["CC BY-SA 4.0", true],
    ["CC BY-SA 3.0 us", true],
    ["CC0", true],
    ["Public domain", true],
    ["CC BY-NC-SA 4.0", false],
    ["CC BY-ND 4.0", false],
    ["GFDL", false],
    ["", false],
  ] as const) {
    check(
      `the curation tool ${ok ? "admits" : "refuses"} "${licence}"`,
      isFreeLicence(licence) === ok,
      "",
    );
  }

  const shipped = thrown(() => holdout2Specs());
  check(
    "the shipped pin table's prefixes and splits agree",
    shipped === "",
    shipped || `${holdout2Specs().length} holdout2 pin(s)`,
  );
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\nAll metric self-checks passed.\n"
    : `\n${failures} metric self-check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
