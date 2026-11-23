/**
 * Pure-TypeScript ChromaHash **decode** path (v1).
 *
 * This is the one hand-maintained algorithm port in the TypeScript package: a
 * render-only module that reconstructs a placeholder from a hash with
 * **no WebAssembly init**, so latency-sensitive consumers (server-side render,
 * the critical browser paint path) skip the `.wasm` fetch + instantiate.
 *
 * It is a faithful port of the Rust reference `decode` path (`rust/src/decode.rs`
 * and its dependencies). Encoding lives only in WebAssembly — see `./index`.
 *
 * Determinism: every transcendental matches the spec's portable implementations
 * (`portable_cos`/`portable_pow`/`portable_ln`) so output is bit-identical to
 * the Rust core and the WASM build. The `decode.test.ts` sync guard asserts that
 * equality against `chromahash-wasm` over the spec vectors and a fuzz corpus —
 * if a spec change lands in the core, that guard fails until this module follows.
 */

import { AcHistory, AcModels, ArithDecoder } from "./arith.ts";
import {
  AC_CODED,
  ALPHA_DC_BITS,
  ALPHA_SCALE_BITS,
  ANISO_OBLIQUE,
  A_DC_BITS,
  A_SCALE_BITS,
  BASE_LONG_EDGE,
  B_DC_BITS,
  B_SCALE_BITS,
  DESCRIPTOR_BITS,
  L_DC_BITS,
  L_SCALE_BITS,
  MAX_ALPHA_SCALE,
  MAX_A_SCALE,
  MAX_B_SCALE,
  MAX_CHROMA_A,
  MAX_CHROMA_B,
  MAX_L_SCALE,
  MU_ALPHA,
  MU_C,
  MU_L,
  PREFIX_BITS,
  SEL_HV,
  SEL_ONE,
  WINDOW_W_EXP,
  WINDOW_W_MIN_ALPHA,
  WINDOW_W_MIN_OPAQUE,
  assertHash,
  readAspect,
  readHasAlpha,
  readTier,
  renderLevel,
  tierCountScale,
  tierLayout,
} from "./header.ts";

type Mat3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];
type Vec3 = readonly [number, number, number];

/** M2_INV: OKLAB [L, a, b] → LMS (cube-root). */
const M2_INV: Mat3 = [
  [1.0, 0.3963377774, 0.2158037573],
  [1.0, -0.1055613458, -0.0638541728],
  [1.0, -0.0894841775, -1.291485548],
];

/** M1_INV[sRGB]: LMS → linear sRGB (decoder matrix). */
const M1_INV_SRGB: Mat3 = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

/** M1_INV[Display P3]: LMS → linear Display P3. */
const M1_INV_DISPLAY_P3: Mat3 = [
  [3.1277689869, -2.2571357957, 0.1293668089],
  [-1.0910090475, 2.4133317585, -0.3223227108],
  [-0.026010813, -0.508041326, 1.5340521389],
];

/** M1_INV[Adobe RGB]: LMS → linear Adobe RGB. */
const M1_INV_ADOBE_RGB: Mat3 = [
  [2.5540368478, -1.6219762024, 0.0679393544],
  [-1.2684380042, 2.6097574007, -0.3413193963],
  [-0.0562347471, -0.5670418342, 1.6232765812],
];

/**
 * Decode output gamut: the display target the placeholder is rendered into.
 * `Display P3` shares the sRGB transfer curve; `Adobe RGB` uses γ = 2.2.
 */
export type OutputGamut = "sRGB" | "Display P3" | "Adobe RGB";

function m1InvFor(output: OutputGamut): Mat3 {
  switch (output) {
    case "Display P3":
      return M1_INV_DISPLAY_P3;
    case "Adobe RGB":
      return M1_INV_ADOBE_RGB;
    default:
      return M1_INV_SRGB;
  }
}

// ---------------------------------------------------------------------------
// Portable math (bit-exact across languages; see rust/src/math_utils.rs)
// ---------------------------------------------------------------------------

// Math.PI / Math.LN2 are the exact IEEE-754 doubles the spec's portable math
// uses, so referencing them keeps this port bit-identical to the Rust core.
const PI = Math.PI;
const LN2 = Math.LN2;

/** Round half away from zero (NOT banker's rounding). Per spec §2.2. */
function roundHalfAwayFromZero(x: number): number {
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Sign matching Rust's `f64::signum` for the values seen here (+0 → +1). */
function signum(x: number): number {
  return x < 0 ? -1 : 1;
}

/** Portable natural logarithm. Range-reduces to [1, 2) then a fast series. */
function portableLn(x: number): number {
  if (x <= 0) return Number.NEGATIVE_INFINITY;
  if (x === 1) return 0;

  let m = x;
  let e = 0;
  while (m >= 2.0) {
    m /= 2.0;
    e += 1;
  }
  while (m < 1.0) {
    m *= 2.0;
    e -= 1;
  }

  const u = (m - 1.0) / (m + 1.0);
  const u2 = u * u;
  let term = u;
  let sum = u;
  let k = 1;
  while (k <= 20) {
    term *= u2;
    sum += term / (2 * k + 1);
    k += 1;
  }

  return 2.0 * sum + e * LN2;
}

/** Portable exponential. exp(x) = 2^k · exp(r), r ∈ [-ln2/2, ln2/2]. */
function portableExp(x: number): number {
  if (x === 0) return 1.0;

  const k = Math.floor(x / LN2 + 0.5);
  const r = x - k * LN2;

  let term = 1.0;
  let sum = 1.0;
  let i = 1;
  while (i <= 25) {
    term *= r / i;
    sum += term;
    i += 1;
  }

  let result = sum;
  if (k >= 0) {
    for (let j = 0; j < k; j++) result *= 2.0;
  } else {
    for (let j = 0; j < -k; j++) result /= 2.0;
  }
  return result;
}

/** Portable power: base^exponent via exp(exponent · ln(base)). */
function portablePow(base: number, exponent: number): number {
  if (base === 0) return 0.0;
  if (exponent === 0) return 1.0;
  if (base === 1) return 1.0;
  return portableExp(exponent * portableLn(base));
}

/** Portable cosine (degree-16 Taylor with range reduction). */
function portableCos(x: number): number {
  const TWO_PI = 6.283185307179586;
  const HALF_PI = 1.5707963267948966;

  let v = x < 0 ? -x : x;
  if (v >= TWO_PI) v -= Math.floor(v / TWO_PI) * TWO_PI;
  if (v > PI) v = TWO_PI - v;
  const negate = v > HALF_PI;
  if (negate) v = PI - v;

  const x2 = v * v;
  const r =
    1.0 +
    x2 *
      (-1.0 / 2.0 +
        x2 *
          (1.0 / 24.0 +
            x2 *
              (-1.0 / 720.0 +
                x2 *
                  (1.0 / 40320.0 +
                    x2 *
                      (-1.0 / 3628800.0 +
                        x2 *
                          (1.0 / 479001600.0 +
                            x2 *
                              (-1.0 / 87178291200.0 +
                                x2 * (1.0 / 20922789888000.0))))))));

  return negate ? -r : r;
}

function matvec3(m: Mat3, v: Vec3): [number, number, number] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

// ---------------------------------------------------------------------------
// Bitstream
// ---------------------------------------------------------------------------

/** Read `count` bits starting at `bitpos` (little-endian). Per spec §12.6. */
function readBits(hash: Uint8Array, bitpos: number, count: number): number {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const byteIdx = (bitpos + i) >> 3;
    const bitIdx = (bitpos + i) & 7;
    if (((hash[byteIdx] ?? 0) & (1 << bitIdx)) !== 0) value |= 1 << i;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Transfer + gamma LUT
// ---------------------------------------------------------------------------

/** sRGB gamma (linear → gamma). Per spec §12.6. */
function srgbGamma(x: number): number {
  if (x <= 0.0031308) return 12.92 * x;
  return 1.055 * portablePow(x, 1.0 / 2.4) - 0.055;
}

/** Adobe RGB gamma (linear → gamma): x^(1/2.2). Per spec §12.5. */
function adobeRgbGamma(x: number): number {
  return portablePow(x, 1.0 / 2.2);
}

/** 4096-entry gamma LUT for a transfer fn: lut[i] = γ(i/4095)·255. Per spec §12.6. */
function buildGammaLut(gamma: (x: number) => number): Uint8Array {
  const lut = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) {
    lut[i] = roundHalfAwayFromZero(clamp01(gamma(i / 4095.0)) * 255.0);
  }
  return lut;
}

// sRGB / Display P3 share the sRGB transfer; Adobe RGB uses γ = 2.2.
const SRGB_GAMMA_LUT = buildGammaLut(srgbGamma);
const ADOBE_GAMMA_LUT = buildGammaLut(adobeRgbGamma);

function gammaLutFor(output: OutputGamut): Uint8Array {
  return output === "Adobe RGB" ? ADOBE_GAMMA_LUT : SRGB_GAMMA_LUT;
}

/** Map linear [0,1] to gamma-encoded u8 via the given LUT. Per spec §12.6. */
function linearToGamma8(x: number, lut: Uint8Array): number {
  let idx = roundHalfAwayFromZero(x * 4095.0);
  if (idx < 0) idx = 0;
  else if (idx > 4095) idx = 4095;
  return lut[idx] ?? 0;
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

function oklabToLinearSrgb(lab: Vec3): [number, number, number] {
  return oklabToLinearOutput(lab, "sRGB");
}

/** OKLAB → linear RGB in the given output gamut (LMS → gamut RGB). Per spec §12.5. */
function oklabToLinearOutput(
  lab: Vec3,
  output: OutputGamut,
): [number, number, number] {
  const c = matvec3(M2_INV, lab);
  const lms: Vec3 = [
    c[0] * c[0] * c[0],
    c[1] * c[1] * c[1],
    c[2] * c[2] * c[2],
  ];
  return matvec3(m1InvFor(output), lms);
}

// ---------------------------------------------------------------------------
// µ-law dequantization
// ---------------------------------------------------------------------------

function muExpand(compressed: number, mu: number): number {
  return (
    (signum(compressed) * (portablePow(1.0 + mu, Math.abs(compressed)) - 1.0)) /
    mu
  );
}

/** Dequantize a µ-law index back to [-1, 1]. Per spec §7.3 (v0.6). */
function muLawDequantize(index: number, bits: number, mu: number): number {
  const maxIdx = (1 << bits) - 2;
  const idx = Math.min(index, maxIdx);
  const compressed = (idx / maxIdx) * 2.0 - 1.0;
  return muExpand(compressed, mu);
}

/** Dequantize a unit-range DC/scale code (`code / (2^bits - 1)`). Per spec §7.1. */
function dequantizeLDc(code: number, bits: number): number {
  return code / ((1 << bits) - 1);
}

/** Dequantize a zero-centred chroma DC code. Per spec §7.1. */
function dequantizeCDc(code: number, range: number, bits: number): number {
  const center = 1 << (bits - 1);
  const span = center - 1;
  return ((code - center) / span) * range;
}

/** Dequantize an AC scale code (linear grid; `scale_mu` is 0 in v1). §7.2. */
function dequantizeScale(code: number, range: number, bits: number): number {
  return (code / ((1 << bits) - 1)) * range;
}

// ---------------------------------------------------------------------------
// Aspect
// ---------------------------------------------------------------------------

/** Decode aspect ratio from byte. Per spec §8.1 (v0.3). */
function decodeAspect(byte: number): number {
  return portablePow(2.0, (byte / 255.0) * 8.0 - 4.0);
}

/** Base (render-level-0) output size from an aspect byte. Per spec §8.2. */
function baseOutputSize(byte: number): [number, number] {
  const ratio = decodeAspect(byte);
  if (ratio > 1.0) {
    const h = Math.max(roundHalfAwayFromZero(BASE_LONG_EDGE / ratio), 1.0);
    return [BASE_LONG_EDGE, h];
  }
  const w = Math.max(roundHalfAwayFromZero(BASE_LONG_EDGE * ratio), 1.0);
  return [w, BASE_LONG_EDGE];
}

/**
 * Natural output size for an aspect byte at a tier. The base size is scaled by
 * a **bit shift** on the tier's render level — not re-derived from
 * `32·2^level / ratio`, which disagrees for non-power-of-two ratios (§8.2).
 */
function decodeOutputSize(byte: number, tier: number): [number, number] {
  const [w, h] = baseOutputSize(byte);
  const level = renderLevel(tier);
  return [w << level, h << level];
}

// ---------------------------------------------------------------------------
// Coefficient selection + DCT synthesis
// ---------------------------------------------------------------------------

interface Selection {
  coeffs: Array<[number, number]>;
  priorities: number[];
  pK: number;
}

/** Quantize a selection-weight parameter onto the Q12 grid. */
function q12(v: number): number {
  return roundHalfAwayFromZero(v * SEL_ONE);
}

const ANISO_Q12 = q12(ANISO_OBLIQUE);
const SEL_HV_Q12 = q12(SEL_HV);

/**
 * Exact integer sort key for one candidate frequency. Per spec §6.2 (v1).
 *
 * Every intermediate stays under 2^51 at every tier for the parameter ranges
 * the format allows, so a JavaScript `number` evaluates it without a bignum —
 * which is the whole reason the spec defines the order on a Q12 integer grid
 * rather than in floating point.
 */
function selectionKey(
  px: number,
  py: number,
  aQ12: number,
  hQ12: number,
): number {
  const sq = px * px;
  const tq = py * py;
  const p = sq + tq;
  if (aQ12 === 0 && hQ12 === 0) return p * 65536;
  const d = sq - tq;
  // Truncate toward zero, matching the reference's `/`.
  const x = Math.trunc((d * SEL_ONE) / p);
  const u = (SEL_ONE + aQ12) * SEL_ONE - Math.floor((aQ12 * x * x) / SEL_ONE);
  const v = SEL_ONE * SEL_ONE + hQ12 * x;
  return p * Math.floor((u * v) / 4294967296);
}

/**
 * Select the K lowest-priority AC coefficients for an (aspect byte, tier).
 * Per spec §6.2 (v1): the weighted priority order, ties broken by (cx, cy).
 *
 * `priorities` carries the *unweighted* priority `(cx·H)² + (cy·W)²`, which is
 * what the synthesis window and the `p_K` band edge are defined on.
 */
function selectCoefficients(
  aspectByte: number,
  tier: number,
  k: number,
): Selection {
  const [w, h] = decodeOutputSize(aspectByte, tier);
  const entries: Array<[number, number, number, number]> = [];
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      if (cx === 0 && cy === 0) continue;
      const px = cx * h;
      const py = cy * w;
      entries.push([
        selectionKey(px, py, ANISO_Q12, SEL_HV_Q12),
        cx,
        cy,
        px * px + py * py,
      ]);
    }
  }
  entries.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  entries.length = Math.min(entries.length, k);

  const last = entries[entries.length - 1];
  return {
    coeffs: entries.map(([, cx, cy]) => [cx, cy]),
    priorities: entries.map(([, , , pri]) => pri),
    pK: last ? last[3] : 1,
  };
}

/** Decode-side synthesis window weights for a selection. Per spec §11 (v0.6). */
function windowWeights(sel: Selection, wMin: number, wExp: number): number[] {
  if (wMin >= 1.0) return sel.priorities.map(() => 1.0);
  return sel.priorities.map((p) => {
    const rho = Math.sqrt(p / sel.pK);
    const hann = (1.0 + portableCos(PI * rho)) / 2.0;
    let powed = 1.0;
    for (let i = 0; i < wExp; i++) powed *= hann;
    return wMin + (1.0 - wMin) * powed;
  });
}

/** Cosine table: table[freq][pos] = cos(π/dim · freq · (pos+0.5)). Per spec §12.6. */
function precomputeCosTable(dim: number, maxFreq: number): number[][] {
  const table: number[][] = [];
  for (let freq = 0; freq < maxFreq; freq++) {
    const row: number[] = [];
    for (let pos = 0; pos < dim; pos++) {
      row.push(portableCos((PI / dim) * freq * (pos + 0.5)));
    }
    table.push(row);
  }
  return table;
}

/** Inverse DCT at a single pixel using precomputed cosine tables. Per spec §12.6. */
function dctDecodePixelSeparable(
  dc: number,
  ac: number[],
  scan: Array<[number, number]>,
  x: number,
  y: number,
  cosX: number[][],
  cosY: number[][],
): number {
  let value = dc;
  for (let j = 0; j < scan.length; j++) {
    const pair = scan[j];
    if (pair === undefined) continue;
    const [cx, cy] = pair;
    const cxFactor = cx > 0 ? 2.0 : 1.0;
    const cyFactor = cy > 0 ? 2.0 : 1.0;
    const fx = (cosX[cx] ?? [])[x] ?? 0;
    const fy = (cosY[cy] ?? [])[y] ?? 0;
    value += (ac[j] ?? 0) * fx * fy * cxFactor * cyFactor;
  }
  return value;
}

/**
 * Filter a channel's AC values to frequencies representable at (w, h):
 * windowed values + their (cx, cy) pairs with cx < w and cy < h. Per spec §11.
 */
function prepareChannel(
  ac: number[],
  coeffs: Array<[number, number]>,
  weights: number[],
  w: number,
  h: number,
): { vals: number[]; scan: Array<[number, number]> } {
  const vals: number[] = [];
  const scan: Array<[number, number]> = [];
  for (let j = 0; j < coeffs.length; j++) {
    const pair = coeffs[j];
    if (pair === undefined) continue;
    const [cx, cy] = pair;
    if (cx >= w || cy >= h) continue;
    vals.push((ac[j] ?? 0) * (weights[j] ?? 0));
    scan.push([cx, cy]);
  }
  return { vals, scan };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Render a ChromaHash at the given pixel dimensions. Per spec §11 (v1). */
function renderAtSize(
  hash: Uint8Array,
  w: number,
  h: number,
  output: OutputGamut,
): Uint8Array {
  // 1. Descriptor byte + aspect byte (§2.5), then the 38-bit DC/scale group.
  const tier = readTier(hash);
  const hasAlpha = readHasAlpha(hash);
  const aspect = readAspect(hash);

  let bitpos = DESCRIPTOR_BITS;
  const lDcQ = readBits(hash, bitpos, L_DC_BITS);
  bitpos += L_DC_BITS;
  const aDcQ = readBits(hash, bitpos, A_DC_BITS);
  bitpos += A_DC_BITS;
  const bDcQ = readBits(hash, bitpos, B_DC_BITS);
  bitpos += B_DC_BITS;
  const lSclQ = readBits(hash, bitpos, L_SCALE_BITS);
  bitpos += L_SCALE_BITS;
  const aSclQ = readBits(hash, bitpos, A_SCALE_BITS);
  bitpos += A_SCALE_BITS;
  const bSclQ = readBits(hash, bitpos, B_SCALE_BITS);
  bitpos += B_SCALE_BITS;

  // 2. DC values + scale factors
  const lDc = dequantizeLDc(lDcQ, L_DC_BITS);
  const aDc = dequantizeCDc(aDcQ, MAX_CHROMA_A, A_DC_BITS);
  const bDc = dequantizeCDc(bDcQ, MAX_CHROMA_B, B_DC_BITS);
  const lScale = dequantizeScale(lSclQ, MAX_L_SCALE, L_SCALE_BITS);
  const aScale = dequantizeScale(aSclQ, MAX_A_SCALE, A_SCALE_BITS);
  const bScale = dequantizeScale(bSclQ, MAX_B_SCALE, B_SCALE_BITS);

  // 3. Coefficient selection (mirrors the encoder exactly). Counts come from
  //    the tier's §3.2 row scaled by 4^level; bit widths stay constant.
  const layout = tierLayout(tier);
  const scale = tierCountScale(tier);
  const lBands = (hasAlpha ? layout.laBands : layout.lBands).map(
    ([count, bits]) => [count * scale, bits] as const,
  );
  const lCount = lBands.reduce((acc, [count]) => acc + count, 0);
  const cCount = (hasAlpha ? layout.caCount : layout.cCount) * scale;
  const cBits = hasAlpha ? layout.caBits : layout.cBits;
  const alphaAcCount = layout.aCount * scale;
  const alphaAcBits = layout.aBits;
  const lSel = selectCoefficients(aspect, tier, lCount);
  const cSel = selectCoefficients(aspect, tier, cCount);

  // 4. Alpha prefix, then the AC payload.
  let alphaDcVal = 1.0;
  let alphaScaleVal = 0.0;
  if (hasAlpha) {
    alphaDcVal = dequantizeLDc(
      readBits(hash, bitpos, ALPHA_DC_BITS),
      ALPHA_DC_BITS,
    );
    bitpos += ALPHA_DC_BITS;
    alphaScaleVal = dequantizeScale(
      readBits(hash, bitpos, ALPHA_SCALE_BITS),
      MAX_ALPHA_SCALE,
      ALPHA_SCALE_BITS,
    );
    bitpos += ALPHA_SCALE_BITS;
  }

  // Every AC code, in the order the payload carries them: luma (with its
  // per-index widths), chroma a, chroma b, then alpha. A coded tier (§3.6)
  // reads them from one arithmetic-coded stream over the rest of the hash;
  // every other tier reads fixed-width fields.
  const lBits: number[] = [];
  for (const [count, bits] of lBands) {
    for (let i = 0; i < count; i++) lBits.push(bits);
  }
  const alphaCount = hasAlpha ? alphaAcCount : 0;
  const lRaw: number[] = [];
  const aRaw: number[] = [];
  const bRaw: number[] = [];
  const alphaRaw: number[] = [];
  if (AC_CODED[tier] === true) {
    const dec = new ArithDecoder(hash, bitpos, hash.length * 8);
    const models = new AcModels();
    let hist = new AcHistory();
    for (const [i, bits] of lBits.entries()) {
      lRaw.push(models.decode(dec, hist, 0, i, bits));
    }
    for (const raw of [aRaw, bRaw]) {
      hist = new AcHistory();
      for (let i = 0; i < cCount; i++) {
        raw.push(models.decode(dec, hist, 1, i, cBits));
      }
    }
    hist = new AcHistory();
    for (let i = 0; i < alphaCount; i++) {
      alphaRaw.push(models.decode(dec, hist, 2, i, alphaAcBits));
    }
  } else {
    const read = (out: number[], n: number, width: (i: number) => number) => {
      for (let i = 0; i < n; i++) {
        const bits = width(i);
        out.push(readBits(hash, bitpos, bits));
        bitpos += bits;
      }
    };
    read(lRaw, lBits.length, (i) => lBits[i] ?? 0);
    read(aRaw, cCount, () => cBits);
    read(bRaw, cCount, () => cBits);
    read(alphaRaw, alphaCount, () => alphaAcBits);
  }

  const lAc = lRaw.map(
    (q, i) => muLawDequantize(q, lBits[i] ?? 0, MU_L) * lScale,
  );
  const aAc = aRaw.map((q) => muLawDequantize(q, cBits, MU_C) * aScale);
  const bAc = bRaw.map((q) => muLawDequantize(q, cBits, MU_C) * bScale);

  let alphaSel: Selection | null = null;
  const alphaAc: number[] = [];
  if (hasAlpha) {
    alphaSel = selectCoefficients(aspect, tier, alphaAcCount);
    for (const q of alphaRaw) {
      alphaAc.push(muLawDequantize(q, alphaAcBits, MU_ALPHA) * alphaScaleVal);
    }
  }

  // 5. Synthesis window (per alpha mode and tier code) + frequency filter
  const wMin =
    (hasAlpha ? WINDOW_W_MIN_ALPHA : WINDOW_W_MIN_OPAQUE)[tier] ?? 1.0;
  const lWeights = windowWeights(lSel, wMin, WINDOW_W_EXP);
  const cWeights = windowWeights(cSel, wMin, WINDOW_W_EXP);

  const lCh = prepareChannel(lAc, lSel.coeffs, lWeights, w, h);
  const aCh = prepareChannel(aAc, cSel.coeffs, cWeights, w, h);
  const bCh = prepareChannel(bAc, cSel.coeffs, cWeights, w, h);
  // Alpha is structural, not chromatic — share the luma window shape.
  const alphaCh =
    alphaSel !== null
      ? prepareChannel(
          alphaAc,
          alphaSel.coeffs,
          windowWeights(alphaSel, wMin, WINDOW_W_EXP),
          w,
          h,
        )
      : { vals: [], scan: [] as Array<[number, number]> };

  // 6. Cosine tables sized to the surviving frequencies
  let maxCx = 0;
  let maxCy = 0;
  for (const [cx, cy] of [...lCh.scan, ...aCh.scan, ...alphaCh.scan]) {
    if (cx > maxCx) maxCx = cx;
    if (cy > maxCy) maxCy = cy;
  }
  const cosX = precomputeCosTable(w, maxCx + 1);
  const cosY = precomputeCosTable(h, maxCy + 1);

  // 7. Render
  const gammaLut = gammaLutFor(output);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = dctDecodePixelSeparable(
        lDc,
        lCh.vals,
        lCh.scan,
        x,
        y,
        cosX,
        cosY,
      );
      const a = dctDecodePixelSeparable(
        aDc,
        aCh.vals,
        aCh.scan,
        x,
        y,
        cosX,
        cosY,
      );
      const b = dctDecodePixelSeparable(
        bDc,
        bCh.vals,
        bCh.scan,
        x,
        y,
        cosX,
        cosY,
      );
      const alpha = hasAlpha
        ? dctDecodePixelSeparable(
            alphaDcVal,
            alphaCh.vals,
            alphaCh.scan,
            x,
            y,
            cosX,
            cosY,
          )
        : 1.0;

      const lClamped = clamp01(l);
      const rgbLin = oklabToLinearOutput([lClamped, a, b], output);
      const idx = (y * w + x) * 4;
      rgba[idx] = linearToGamma8(clamp01(rgbLin[0]), gammaLut);
      rgba[idx + 1] = linearToGamma8(clamp01(rgbLin[1]), gammaLut);
      rgba[idx + 2] = linearToGamma8(clamp01(rgbLin[2]), gammaLut);
      rgba[idx + 3] = roundHalfAwayFromZero(255.0 * clamp01(alpha));
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A decoded RGBA image (≤ 256×256 px at the top tier). Row-major, 4 bytes/pixel. */
export interface DecodedImage {
  w: number;
  h: number;
  rgba: Uint8Array;
}

/** An RGBA color as 0–255 integers. */
export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Decode a ChromaHash into an sRGB RGBA image. Per spec §11 (v1). */
export function decode(hash: Uint8Array): DecodedImage {
  return decodeTo(hash, "sRGB");
}

/**
 * Decode a ChromaHash into an RGBA image in the given output gamut
 * (`sRGB`, `Display P3`, or `Adobe RGB`). Wide-gamut colors render at full
 * saturation when the target gamut can represent them, clipped otherwise.
 */
export function decodeTo(hash: Uint8Array, output: OutputGamut): DecodedImage {
  assertHash(hash);
  const [w, h] = decodeOutputSize(readAspect(hash), readTier(hash));
  return { w, h, rgba: renderAtSize(hash, w, h, output) };
}

/**
 * Decode a ChromaHash into an sRGB RGBA image, capped at the given max
 * dimensions. Useful when the natural decoded size would exceed the source.
 */
export function decodeCapped(
  hash: Uint8Array,
  maxWidth: number,
  maxHeight: number,
): DecodedImage {
  return decodeCappedTo(hash, maxWidth, maxHeight, "sRGB");
}

/** Capped decode (see {@link decodeCapped}) in the given output gamut. */
export function decodeCappedTo(
  hash: Uint8Array,
  maxWidth: number,
  maxHeight: number,
  output: OutputGamut,
): DecodedImage {
  assertHash(hash);
  const [natW, natH] = decodeOutputSize(readAspect(hash), readTier(hash));
  const w = Math.min(natW, maxWidth);
  const h = Math.min(natH, maxHeight);
  return { w, h, rgba: renderAtSize(hash, w, h, output) };
}

/** Extract the average color without a full decode. Per spec §11.2. */
export function averageColor(hash: Uint8Array): RgbaColor {
  assertHash(hash);
  const hasAlpha = readHasAlpha(hash);
  let bitpos = DESCRIPTOR_BITS;
  const lDcQ = readBits(hash, bitpos, L_DC_BITS);
  bitpos += L_DC_BITS;
  const aDcQ = readBits(hash, bitpos, A_DC_BITS);
  bitpos += A_DC_BITS;
  const bDcQ = readBits(hash, bitpos, B_DC_BITS);

  const lDc = dequantizeLDc(lDcQ, L_DC_BITS);
  const aDc = dequantizeCDc(aDcQ, MAX_CHROMA_A, A_DC_BITS);
  const bDc = dequantizeCDc(bDcQ, MAX_CHROMA_B, B_DC_BITS);

  const lClamped = clamp01(lDc);
  const rgbLin = oklabToLinearSrgb([lClamped, aDc, bDc]);
  // The alpha DC sits immediately after the fixed prefix, in alpha mode only.
  const alpha = hasAlpha
    ? dequantizeLDc(readBits(hash, PREFIX_BITS, ALPHA_DC_BITS), ALPHA_DC_BITS)
    : 1.0;

  return {
    r: linearToGamma8(clamp01(rgbLin[0]), SRGB_GAMMA_LUT),
    g: linearToGamma8(clamp01(rgbLin[1]), SRGB_GAMMA_LUT),
    b: linearToGamma8(clamp01(rgbLin[2]), SRGB_GAMMA_LUT),
    a: roundHalfAwayFromZero(255.0 * clamp01(alpha)),
  };
}

export {
  COMPACT_TIER,
  DEFAULT_TIER,
  isVersionSupported,
  MAX_TIER,
} from "./header.ts";
