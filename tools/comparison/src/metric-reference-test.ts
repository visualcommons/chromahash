/**
 * Pins `iqa-cli` against reference data. Run with `mise run selftest:iqa`.
 *
 * Every committed result, every table in `spec/EXPERIMENTS.md` and the R-D
 * gate score through `iqa-cli`, and the only thing that held it still was a
 * version number in two install commands. A version pin says which binary ran;
 * it says nothing about whether that binary computes what the document calls
 * ΔE00, SSIMULACRA2, Butteraugli and DSSIM, or whether a rebuild on another
 * host still computes the same numbers. This does, in three parts:
 *
 * 1. **CIEDE2000 against Sharma, Wu & Dalal (2005).** An implementation of the
 *    formula written here from the paper is first held to all 34 published
 *    pairs (`metric-reference/sharma-ciede2000.json`) at their printed
 *    precision. `iqa-cli` only reads 8-bit sRGB images, so it cannot be handed
 *    those Lab pairs directly: each pair is carried to the nearest 8-bit sRGB
 *    colours, written as a one-pixel image pair, and `iqa-cli`'s ΔE00 is
 *    required to equal this file's on exactly those pixels. A 64x64 pair of
 *    deterministic pseudo-random colours then does the same across the gamut.
 *    The sRGB → CIELAB conversion both sides share is itself held to the
 *    published Lab of the sRGB primaries.
 * 2. **A committed golden pair** (`metric-reference/*.png`) whose
 *    SSIMULACRA2, Butteraugli, DSSIM and ΔE00 were recorded from the pinned
 *    `iqa-cli`. These three have no closed-form reference a test can compute:
 *    SSIMULACRA2 and Butteraugli are libjxl's own kernels, vendored by iqa-rs,
 *    and DSSIM is iqa-rs's `(1 − SSIM) / 2`. So this part is a **regression
 *    pin, not a proof of correctness**: it detects a version bump, a rebuild
 *    that computes differently, or a host whose SIMD path diverges -- the ways
 *    committed results stop being reproducible -- and it is honest about being
 *    no more than that.
 * 3. **The version itself**, against the same `PINNED_IQA_CLI` the results are
 *    audited against.
 *
 * `--update` rewrites the golden pair's PNGs and expected scores from the
 * installed `iqa-cli`. Like `rd:gate --update`, it is for an intended change:
 * say in the commit which change moved the numbers.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { PINNED_IQA_CLI } from "./metrics/iqa.ts";

const IQA_CLI = process.env.IQA_CLI ?? "iqa-cli";
// Deliberately outside `fixtures/`: every corpus glob in this package
// (`fixtures/**/*.{png,jpg}` in main.ts, train-tables.ts, rd-budget.ts and
// others) would otherwise score the golden pair as two extra images.
const FIXTURES = path.resolve(import.meta.dirname, "../metric-reference");
const GOLDEN_REF = path.join(FIXTURES, "golden-reference.png");
const GOLDEN_DIST = path.join(FIXTURES, "golden-distorted.png");
const GOLDEN_EXPECTED = path.join(FIXTURES, "golden-expected.json");

const { values } = parseArgs({
  options: { update: { type: "boolean", default: false } },
});

let failures = 0;
function check(ok: boolean, what: string): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${what}`);
  }
}

// ─── The reference CIEDE2000, from the paper ────────────────────────────────

interface Lab {
  L: number;
  a: number;
  b: number;
}

const deg = (r: number): number => (r * 180) / Math.PI;
const rad = (d: number): number => (d * Math.PI) / 180;
const POW25_7 = 25 ** 7;

/** Hue angle in degrees on [0, 360), defined as 0 where a' = b = 0 (eq. 7). */
function hue(ap: number, b: number): number {
  if (ap === 0 && b === 0) return 0;
  const h = deg(Math.atan2(b, ap));
  return h < 0 ? h + 360 : h;
}

/**
 * ΔE00 with kL = kC = kH = 1, following Sharma, Wu & Dalal (2005), eqs. 1-22,
 * including the three edge cases their notes call out: the hue of an
 * achromatic colour, the hue-difference wrap, and the mean-hue wrap.
 */
function ciede2000(c1: Lab, c2: Lab): number {
  const C1 = Math.hypot(c1.a, c1.b);
  const C2 = Math.hypot(c2.a, c2.b);
  const Cbar7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));
  const a1p = (1 + G) * c1.a;
  const a2p = (1 + G) * c2.a;
  const C1p = Math.hypot(a1p, c1.b);
  const C2p = Math.hypot(a2p, c2.b);
  const h1p = hue(a1p, c1.b);
  const h2p = hue(a2p, c2.b);

  const dLp = c2.L - c1.L;
  const dCp = C2p - C1p;
  const product = C1p * C2p;
  let dhp = 0;
  if (product !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(product) * Math.sin(rad(dhp / 2));

  const Lbarp = (c1.L + c2.L) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (product !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp /= 2;
    else if (hbarp < 360) hbarp = (hbarp + 360) / 2;
    else hbarp = (hbarp - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hbarp - 30)) +
    0.24 * Math.cos(rad(2 * hbarp)) +
    0.32 * Math.cos(rad(3 * hbarp + 6)) -
    0.2 * Math.cos(rad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const l50 = (Lbarp - 50) ** 2;
  const SL = 1 + (0.015 * l50) / Math.sqrt(20 + l50);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;
  const tl = dLp / SL;
  const tc = dCp / SC;
  const th = dHp / SH;
  return Math.sqrt(tl * tl + tc * tc + th * th + RT * tc * th);
}

// ─── sRGB (IEC 61966-2-1) ↔ CIELAB (D65) ────────────────────────────────────
//
// The conversion `iqa-cli` documents: the sRGB EOTF, the high-precision sRGB
// to XYZ matrix (whose rows sum to the D65 white below), and CIELAB's f(t)
// with ε = 216/24389 and κ = 24389/27.

const M: readonly (readonly [number, number, number])[] = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const WHITE = [0.95047, 1.0, 1.08883] as const;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

const eotf = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const oetf = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
const f = (t: number): number =>
  t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
const fInv = (t: number): number =>
  t ** 3 > EPS ? t ** 3 : (116 * t - 16) / KAPPA;

function mul(m: typeof M, v: readonly number[]): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const row = m[i] as readonly [number, number, number];
    out[i] = row[0] * (v[0] ?? 0) + row[1] * (v[1] ?? 0) + row[2] * (v[2] ?? 0);
  }
  return out;
}

/** 3x3 inverse by cofactors. */
function invert(m: typeof M): (readonly [number, number, number])[] {
  const [a, b, c] = m[0] as readonly [number, number, number];
  const [d, e, g] = m[1] as readonly [number, number, number];
  const [h, i, k] = m[2] as readonly [number, number, number];
  const A = e * k - g * i;
  const B = -(d * k - g * h);
  const C = d * i - e * h;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * k - c * i) / det, (b * g - c * e) / det],
    [B / det, (a * k - c * h) / det, -(a * g - c * d) / det],
    [C / det, -(a * i - b * h) / det, (a * e - b * d) / det],
  ];
}
const M_INV = invert(M);

function srgb8ToLab(rgb: readonly [number, number, number]): Lab {
  const [x, y, z] = mul(
    M,
    rgb.map((v) => eotf(v / 255)),
  );
  const fx = f(x / WHITE[0]);
  const fy = f(y / WHITE[1]);
  const fz = f(z / WHITE[2]);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** The nearest 8-bit sRGB colour to a Lab colour, clipped into the gamut. */
function labToSrgb8(lab: Lab): [number, number, number] {
  const fy = (lab.L + 16) / 116;
  const xyz = [
    WHITE[0] * fInv(fy + lab.a / 500),
    WHITE[1] * fInv(fy),
    WHITE[2] * fInv(fy - lab.b / 200),
  ];
  const lin = mul(M_INV, xyz);
  return lin.map((c) =>
    Math.round(255 * oetf(Math.min(1, Math.max(0, c)))),
  ) as [number, number, number];
}

// ─── iqa-cli ────────────────────────────────────────────────────────────────

async function writeRgb(
  file: string,
  w: number,
  h: number,
  rgb: Uint8Array,
): Promise<void> {
  await sharp(Buffer.from(rgb), { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(file);
}

function iqa(
  ref: string,
  dist: string,
  metrics: string[],
): Record<string, number> {
  const out = execFileSync(
    IQA_CLI,
    [
      "--reference",
      ref,
      "--distorted",
      dist,
      "--format",
      "json",
      "--metric",
      metrics.join(","),
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  return JSON.parse(out) as Record<string, number>;
}

/** Deterministic pseudo-random bytes (a 32-bit LCG), so the pair never moves. */
function lcgBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

// ─── The golden pair ────────────────────────────────────────────────────────

const GOLDEN_W = 96;
const GOLDEN_H = 64;

/**
 * A reference with the structure the metrics respond to -- a smooth two-axis
 * colour gradient, a sinusoidal texture, and a hard diagonal edge -- and a
 * distortion shaped like a placeholder: the reference box-averaged to 12x8,
 * enlarged back by bilinear interpolation, and tinted. Only `--update` builds
 * them; the test reads the committed PNG bytes, so a change to this function
 * cannot move the pair without a visible diff in the fixtures.
 */
function goldenPair(): { ref: Uint8Array; dist: Uint8Array } {
  const ref = new Uint8Array(GOLDEN_W * GOLDEN_H * 3);
  for (let y = 0; y < GOLDEN_H; y++) {
    for (let x = 0; x < GOLDEN_W; x++) {
      const i = (y * GOLDEN_W + x) * 3;
      const texture = 24 * Math.sin(x / 2.5) * Math.cos(y / 3.5);
      const edge = x + y > 90 ? 60 : 0;
      ref[i] = clamp8(40 + (x * 170) / GOLDEN_W + texture + edge);
      ref[i + 1] = clamp8(60 + (y * 150) / GOLDEN_H - texture / 2);
      ref[i + 2] = clamp8(200 - (x * 90) / GOLDEN_W + texture / 3 - edge);
    }
  }
  const sw = 12;
  const sh = 8;
  const small = new Float64Array(sw * sh * 3);
  const bx = GOLDEN_W / sw;
  const by = GOLDEN_H / sh;
  for (let y = 0; y < GOLDEN_H; y++) {
    for (let x = 0; x < GOLDEN_W; x++) {
      const s = (Math.floor(y / by) * sw + Math.floor(x / bx)) * 3;
      const i = (y * GOLDEN_W + x) * 3;
      for (let c = 0; c < 3; c++) {
        small[s + c] = (small[s + c] ?? 0) + (ref[i + c] ?? 0) / (bx * by);
      }
    }
  }
  const at = (sx: number, sy: number, c: number): number =>
    small[
      (Math.min(sh - 1, Math.max(0, sy)) * sw +
        Math.min(sw - 1, Math.max(0, sx))) *
        3 +
        c
    ] ?? 0;
  const tint = [6, -4, 3];
  const dist = new Uint8Array(ref.length);
  for (let y = 0; y < GOLDEN_H; y++) {
    for (let x = 0; x < GOLDEN_W; x++) {
      const fx = (x + 0.5) / bx - 0.5;
      const fy = (y + 0.5) / by - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const i = (y * GOLDEN_W + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v =
          (1 - ty) * ((1 - tx) * at(x0, y0, c) + tx * at(x0 + 1, y0, c)) +
          ty * ((1 - tx) * at(x0, y0 + 1, c) + tx * at(x0 + 1, y0 + 1, c));
        dist[i + c] = clamp8(v + (tint[c] ?? 0));
      }
    }
  }
  return { ref, dist };
}

function clamp8(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

const GOLDEN_METRICS = ["ssimulacra2", "butteraugli", "dssim", "ciede2000"];

/**
 * How far a golden score may move and still count as the same instrument.
 * Not zero: libjxl's kernels dispatch on the host's SIMD width, and a
 * different width sums in a different order. 1e-4 relative is far below the
 * precision any table prints for these metrics.
 */
const GOLDEN_REL = 1e-4;

interface GoldenExpected {
  iqaCli: string;
  note: string;
  scores: Record<string, number>;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const version = execFileSync(IQA_CLI, ["--version"], {
    encoding: "utf8",
  }).trim();

  if (values.update) {
    mkdirSync(FIXTURES, { recursive: true });
    const { ref, dist } = goldenPair();
    await writeRgb(GOLDEN_REF, GOLDEN_W, GOLDEN_H, ref);
    await writeRgb(GOLDEN_DIST, GOLDEN_W, GOLDEN_H, dist);
    const scores = iqa(GOLDEN_REF, GOLDEN_DIST, GOLDEN_METRICS);
    const expected: GoldenExpected = {
      iqaCli: version,
      note: "Recorded from the iqa-cli named above by `node dist/metric-reference-test.js --update`. A regression pin, not a reference value: see metric-reference-test.ts.",
      scores,
    };
    writeFileSync(GOLDEN_EXPECTED, `${JSON.stringify(expected, null, 2)}\n`);
    console.log(`Recorded the golden pair against ${version}:`);
    for (const [k, v] of Object.entries(scores)) console.log(`  ${k}: ${v}`);
    return;
  }

  console.log(`iqa-cli: ${version}`);
  check(
    version === PINNED_IQA_CLI,
    `installed "${version}", pinned "${PINNED_IQA_CLI}"`,
  );

  // 1a. The reference implementation against the paper.
  const sharma = JSON.parse(
    readFileSync(path.join(FIXTURES, "sharma-ciede2000.json"), "utf8"),
  ) as { pairs: number[][] };
  check(
    sharma.pairs.length === 34,
    `Sharma set has ${sharma.pairs.length} pairs, not 34`,
  );
  let worst = 0;
  const labPairs: [Lab, Lab][] = [];
  for (const [n, p] of sharma.pairs.entries()) {
    const [L1 = 0, a1 = 0, b1 = 0, L2 = 0, a2 = 0, b2 = 0, want = 0] = p;
    const c1 = { L: L1, a: a1, b: b1 };
    const c2 = { L: L2, a: a2, b: b2 };
    labPairs.push([c1, c2]);
    const got = ciede2000(c1, c2);
    worst = Math.max(worst, Math.abs(got - want));
    // Printed to four decimals: half a unit in the last place.
    check(
      Math.abs(got - want) <= 5e-5 + 1e-12,
      `Sharma pair ${n + 1}: reference gives ${got.toFixed(6)}, published ${want}`,
    );
    // Swapping the pair must not move the difference.
    check(
      Math.abs(ciede2000(c2, c1) - got) < 1e-12,
      `Sharma pair ${n + 1} is not symmetric under swap`,
    );
  }
  console.log(
    `  reference CIEDE2000 reproduces all ${sharma.pairs.length} Sharma pairs (worst |Δ| ${worst.toExponential(2)})`,
  );

  // 1b. The shared sRGB → Lab conversion against published landmarks
  // (D65, 2°; the values Lindbloom's calculator and colour-science both give).
  const landmarks: [[number, number, number], Lab][] = [
    [[255, 255, 255], { L: 100, a: 0, b: 0 }],
    [[0, 0, 0], { L: 0, a: 0, b: 0 }],
    [[255, 0, 0], { L: 53.2408, a: 80.0925, b: 67.2032 }],
    [[0, 255, 0], { L: 87.7347, a: -86.1827, b: 83.1793 }],
    [[0, 0, 255], { L: 32.297, a: 79.1875, b: -107.8602 }],
  ];
  for (const [rgb, want] of landmarks) {
    const got = srgb8ToLab(rgb);
    check(
      Math.abs(got.L - want.L) < 2e-3 &&
        Math.abs(got.a - want.a) < 2e-3 &&
        Math.abs(got.b - want.b) < 2e-3,
      `sRGB(${rgb.join(", ")}) → Lab(${got.L.toFixed(4)}, ${got.a.toFixed(4)}, ${got.b.toFixed(4)}), published (${want.L}, ${want.a}, ${want.b})`,
    );
  }
  console.log(`  sRGB → Lab matches ${landmarks.length} published landmarks`);

  const dir = mkdtempSync(path.join(os.tmpdir(), "chromahash-iqa-reference-"));
  try {
    // 1c. iqa-cli on each Sharma pair, carried to the nearest 8-bit colours.
    const ref = path.join(dir, "ref.png");
    const dist = path.join(dir, "dist.png");
    let worstPair = 0;
    for (const [n, [c1, c2]] of labPairs.entries()) {
      const p1 = labToSrgb8(c1);
      const p2 = labToSrgb8(c2);
      await writeRgb(ref, 1, 1, Uint8Array.from(p1));
      await writeRgb(dist, 1, 1, Uint8Array.from(p2));
      const want = ciede2000(srgb8ToLab(p1), srgb8ToLab(p2));
      const got = iqa(ref, dist, ["ciede2000"]).ciede2000 ?? Number.NaN;
      worstPair = Math.max(worstPair, Math.abs(got - want));
      check(
        Math.abs(got - want) <= 1e-9,
        `Sharma pair ${n + 1} as sRGB ${p1.join(",")} vs ${p2.join(",")}: iqa-cli ${got}, reference ${want}`,
      );
    }
    console.log(
      `  iqa-cli agrees with the reference on all ${labPairs.length} Sharma pairs as 8-bit sRGB (worst |Δ| ${worstPair.toExponential(2)})`,
    );

    // 1d. Across the gamut: 4096 pseudo-random colour pairs in one image,
    // whose mean is the metric's pooled score.
    const side = 64;
    const a = lcgBytes(side * side * 3, 0x9e3779b9);
    const b = lcgBytes(side * side * 3, 0x7f4a7c15);
    await writeRgb(ref, side, side, a);
    await writeRgb(dist, side, side, b);
    let sum = 0;
    for (let i = 0; i < side * side; i++) {
      const pa: [number, number, number] = [
        a[3 * i] ?? 0,
        a[3 * i + 1] ?? 0,
        a[3 * i + 2] ?? 0,
      ];
      const pb: [number, number, number] = [
        b[3 * i] ?? 0,
        b[3 * i + 1] ?? 0,
        b[3 * i + 2] ?? 0,
      ];
      sum += ciede2000(srgb8ToLab(pa), srgb8ToLab(pb));
    }
    const wantMean = sum / (side * side);
    const gotMean = iqa(ref, dist, ["ciede2000"]).ciede2000 ?? Number.NaN;
    check(
      Math.abs(gotMean - wantMean) <= 1e-9,
      `random ${side}x${side} pair: iqa-cli mean ΔE00 ${gotMean}, reference ${wantMean}`,
    );
    console.log(
      `  iqa-cli agrees on ${side * side} pseudo-random pairs (mean ${wantMean.toFixed(6)}, |Δ| ${Math.abs(gotMean - wantMean).toExponential(2)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 2. The golden pair.
  const expected = JSON.parse(
    readFileSync(GOLDEN_EXPECTED, "utf8"),
  ) as GoldenExpected;
  check(
    expected.iqaCli === PINNED_IQA_CLI,
    `golden scores were recorded with "${expected.iqaCli}", not the pinned "${PINNED_IQA_CLI}"`,
  );
  const scores = iqa(GOLDEN_REF, GOLDEN_DIST, GOLDEN_METRICS);
  for (const metric of GOLDEN_METRICS) {
    const want = expected.scores[metric];
    const got = scores[metric];
    if (want === undefined || got === undefined || got === null) {
      check(false, `golden ${metric}: expected ${want}, got ${got}`);
      continue;
    }
    const rel = Math.abs(got - want) / Math.max(Math.abs(want), 1e-12);
    check(
      rel <= GOLDEN_REL,
      `golden ${metric}: iqa-cli ${got}, recorded ${want} (${rel.toExponential(2)} relative)`,
    );
  }
  console.log(
    `  the golden pair scores within ${GOLDEN_REL} of its recorded ${GOLDEN_METRICS.join(", ")}`,
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll iqa-cli reference checks passed.");
}

await main();
