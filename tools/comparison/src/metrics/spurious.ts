/**
 * **Spurious detail** — structure the placeholder asserts that the original does
 * not have. The second metric this harness computes itself; see `local.ts` for
 * the first (ringing) and for why the seven iqa-cli metrics stay in their own
 * module.
 *
 * ## Why ringing is not enough
 *
 * Ringing measures *overshoot*: error that escapes the local `[min, max]` of the
 * reference. That makes a blur score exactly zero, which is what makes it an
 * artifact measure — but it is also a strict limit on what it can see. A ripple
 * that oscillates **inside** the reference's local range scores zero. So does a
 * broad, low-frequency wave laid across a textured region. So does a directional
 * stripe, as long as it stays within the envelope.
 *
 * Those are exactly the artifacts a truncated-basis reconstruction produces away
 * from hard edges, and they are what a reader means by "it looks textured". This
 * metric is built to see them.
 *
 * ## What it measures
 *
 * Energy the decode has at spatial frequencies the reference does not.
 *
 * Both sides are brought to one common grid, and both are transformed by the
 * same separable DCT-II — deliberately the format's own basis, so a coefficient
 * of the transform *is* a coefficient of the kind ChromaHash transmits. For each
 * frequency the excess is `max(0, |D| - |I|)`, and the score is the RMS of those
 * excesses in 8-bit sRGB levels.
 *
 * The reference side, `I`, is the reference **area-averaged onto the decode's own
 * grid**: the ideal low-pass, the best any placeholder at that raster could do.
 *
 * ## The defining property
 *
 * A decode that is exactly that ideal low-pass scores **exactly zero** — the same
 * discipline `local.ts` holds itself to, and for the same reason. `D` and `I` are
 * then the same array, every excess is `max(0, 0)`, and no tuning constant is
 * involved in getting there. A non-zero score is energy the format invented.
 *
 * Two consequences follow, and both are deliberate:
 *
 * 1. **Missing detail is free.** Where the decode has *less* energy than the
 *    reference the excess clamps to zero. That is not an oversight: a placeholder
 *    is a low-pass by design, and losing detail is what ΔE00, SSIMULACRA2 and
 *    DSSIM already charge for. This metric answers the other question.
 * 2. **It is magnitude-only, so it is blind to phase.** A decode whose spectrum
 *    has the right magnitudes in the wrong places scores zero here and badly
 *    everywhere else. That is the correct division of labour — putting energy
 *    where the original has none is an *artifact*; putting the right amount of
 *    energy in the wrong phase is *infidelity* — but it does mean this number
 *    must never be read as a fidelity score.
 *
 * ## Orientation
 *
 * The same transform decomposes by orientation for nothing, which is worth
 * having because ChromaHash's selection order is deliberately anisotropic
 * (`aniso_oblique = 1.2` de-prioritises diagonals, `sel_hv = 0.15` prefers
 * vertical detail — `spec/README.md` §6.2). Whether that asymmetry is *visible*
 * has never been measured; these three sub-scores are how it would show up.
 *
 * Naming follows what a reader sees, not the frequency axis, because the two are
 * transposes of each other and the confusion is perennial. A basis function with
 * horizontal frequency `cx > 0` and `cy = 0` varies along x and is constant down
 * y — that is a pattern of **vertical stripes**. So:
 *
 * - `spuriousVertical`   — `cx`-dominant frequencies: vertical banding/striping.
 * - `spuriousHorizontal` — `cy`-dominant frequencies: horizontal striping.
 * - `spuriousDiagonal`   — the oblique band between them.
 *
 * The three partition the frequency plane, so
 * `spurious² = spuriousVertical² + spuriousHorizontal² + spuriousDiagonal²`
 * exactly, and `metric-selftest.ts` asserts it.
 *
 * ## Grid, and what is comparable
 *
 * The analysis runs on the decode's own raster, capped (see
 * {@link SPURIOUS_MAX_EDGE}). Two decodes at the *same* raster are directly
 * comparable — which is the case that matters, because a constants sweep holds
 * the tier fixed and varies one knob. Across different decode sizes the number
 * carries its grid with it, exactly as ringing carries its envelope radius, so
 * `spuriousGridEdge` is reported alongside the score.
 *
 * Working in gamma-encoded sRGB, per channel, matches `local.ts`: it is the space
 * the reference is stored in and the space a viewer's display receives, and it
 * keeps the two locally-measured metrics on one set of units (8-bit levels).
 */

import type { LocalMetrics } from "../types.ts";

/**
 * Longest edge of the analysis grid. The transform is separable, so it costs
 * `O(W·H·(W+H))` — at 256 that is ~2e7 multiply-adds per channel, which is a
 * fraction of the ~45 ms ringing already spends, and at 512 it would be eight
 * times that for frequencies no shipped tier can even represent.
 *
 * The cap only ever bites above the default tiers: the natural raster is 32 px
 * at codes 0-1, 64 at code 2 and 128 at code 3, so nothing is discarded below
 * code 4. A decode above the cap is area-averaged down first, which is convex and
 * applied identically to both sides, so the zero property survives it.
 */
export const SPURIOUS_MAX_EDGE = 256;

/**
 * Excesses below this are dropped, in 8-bit levels per frequency.
 *
 * Both sides pass through an 8-bit quantization before they reach us, so a
 * frequency's magnitude carries rounding noise of its own. This is the same role
 * `RING_DEAD_ZONE` plays in `local.ts` and is set the same way: one level.
 */
export const SPURIOUS_DEAD_ZONE = 1.0;

/**
 * Half-width of the diagonal band, as a fraction of a quarter turn.
 *
 * A frequency at angle `θ = atan2(cy, cx)` is diagonal when it lies within this
 * fraction of 45°. At 1/3 the three bands are equal thirds of the quadrant,
 * which is the only choice that does not privilege one of them a priori — and
 * the metric exists to ask whether the format privileges one, so the partition
 * itself must not.
 */
export const SPURIOUS_DIAGONAL_BAND = 1 / 3;

/** Spurious-detail scores for one decode, in 8-bit sRGB levels. */
export interface SpuriousScores {
  spurious: number;
  spuriousVertical: number;
  spuriousHorizontal: number;
  spuriousDiagonal: number;
  spuriousGridEdge: number;
}

/**
 * Area-average one channel of an interleaved RGBA buffer onto a `dw x dh` grid,
 * rounded back to whole levels.
 *
 * Convex by construction — every output is a mean of inputs — which is the
 * property the zero case rests on. Box bounds are computed the same way on both
 * sides so that a decode already at the target grid is passed through exactly.
 *
 * The rounding is what makes the zero *exact*, and it took a failing self-check
 * to find. A real decode arrives quantized to 8 bits; an unrounded reference
 * average does not. The residue between them is not the small random noise that
 * argument assumes — on a ramp or a fine periodic pattern it is *correlated with
 * the content*, so instead of spreading thinly across the spectrum it piles into
 * a few frequencies and clears the dead zone. Measured before the fix: a
 * provably-ideal low-pass of a ramp scored up to 0.14. Quantizing both sides the
 * same way removes the asymmetry at its source rather than raising the dead zone
 * until the symptom disappears.
 */
function areaChannel(
  rgba: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  channel: number,
): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let acc = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        const row = sy * sw;
        for (let sx = x0; sx < x1; sx++) {
          acc += rgba[(row + sx) * 4 + channel] ?? 0;
          n++;
        }
      }
      out[y * dw + x] = n > 0 ? Math.round(acc / n) : 0;
    }
  }
  return out;
}

/**
 * Orthonormal DCT-II basis table: `table[k * n + i]` is the weight of sample `i`
 * in coefficient `k`. Orthonormal so that the coefficient magnitudes are in the
 * same units as the samples (8-bit levels) and Parseval holds, which is what
 * lets the three orientation bands recombine to the total.
 */
function cosTable(n: number): Float32Array {
  const table = new Float32Array(n * n);
  const s0 = Math.sqrt(1 / n);
  const s = Math.sqrt(2 / n);
  for (let k = 0; k < n; k++) {
    const scale = k === 0 ? s0 : s;
    for (let i = 0; i < n; i++) {
      table[k * n + i] = scale * Math.cos((Math.PI * (i + 0.5) * k) / n);
    }
  }
  return table;
}

/** Cosine tables are per-size and reused across channels, images and formats. */
const cosCache = new Map<number, Float32Array>();
function cosFor(n: number): Float32Array {
  let hit = cosCache.get(n);
  if (!hit) {
    hit = cosTable(n);
    cosCache.set(n, hit);
  }
  return hit;
}

/**
 * Separable 2-D DCT-II of a `w x h` plane. Rows first, then columns, so the cost
 * is `O(w·h·(w+h))` rather than the `O((w·h)²)` a direct evaluation would pay.
 */
function dct2(plane: Float32Array, w: number, h: number): Float32Array {
  const cx = cosFor(w);
  const cy = cosFor(h);
  const rows = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = y * w;
    for (let k = 0; k < w; k++) {
      let acc = 0;
      const base = k * w;
      for (let i = 0; i < w; i++)
        acc += (plane[src + i] ?? 0) * (cx[base + i] ?? 0);
      rows[src + k] = acc;
    }
  }
  const out = new Float32Array(w * h);
  for (let k = 0; k < w; k++) {
    for (let l = 0; l < h; l++) {
      let acc = 0;
      const base = l * h;
      for (let i = 0; i < h; i++)
        acc += (rows[i * w + k] ?? 0) * (cy[base + i] ?? 0);
      out[l * w + k] = acc;
    }
  }
  return out;
}

/**
 * The analysis grid: the decode's own raster, bounded by
 * {@link SPURIOUS_MAX_EDGE} and by the reference.
 *
 * The reference bound is what keeps `ideal` an *average*. `areaChannel` onto a
 * grid finer than its source degenerates to nearest-neighbour replication, which
 * is not convex, invents a staircase spectrum of its own, and would be charged to
 * the format. Above the reference's own resolution there is no ground truth to
 * compare against anyway — those frequencies are exactly the ones it cannot
 * resolve. A native-resolution render lands on equality, which passes through.
 */
function analysisGrid(
  decW: number,
  decH: number,
  refW: number,
  refH: number,
): { w: number; h: number } {
  const k = Math.min(
    1,
    SPURIOUS_MAX_EDGE / Math.max(decW, decH),
    refW / decW,
    refH / decH,
  );
  if (k >= 1) return { w: decW, h: decH };
  return {
    w: Math.max(1, Math.round(decW * k)),
    h: Math.max(1, Math.round(decH * k)),
  };
}

/**
 * The reference's transform depends only on the reference buffer and the grid,
 * and every format column in an image re-derives it — ~15 times per image for
 * the handful of distinct decode rasters a lineup produces. Memoized on the
 * buffer's identity, exactly as `local.ts` memoizes the envelope, and released
 * with the image.
 */
const idealCache = new WeakMap<Uint8Array, Map<string, Float32Array>>();

function idealSpectrum(
  refRgba: Uint8Array,
  refW: number,
  refH: number,
  w: number,
  h: number,
  channel: number,
): Float32Array {
  let perBuffer = idealCache.get(refRgba);
  if (!perBuffer) {
    perBuffer = new Map();
    idealCache.set(refRgba, perBuffer);
  }
  // refW/refH are in the key even though they are a function of the buffer's
  // identity today: nothing enforces that, and a caller scoring one reference at
  // two sizes would otherwise get a stale spectrum with no error.
  const key = `${channel}:${refW}x${refH}:${w}x${h}`;
  const hit = perBuffer.get(key);
  if (hit) return hit;
  const built = dct2(areaChannel(refRgba, refW, refH, w, h, channel), w, h);
  perBuffer.set(key, built);
  return built;
}

/**
 * Score spurious detail between a composited reference and a composited decode.
 *
 * Both buffers must already be opaque RGBA at their own dimensions, exactly as
 * `computeRinging` expects, and for the same reason: neither metric may see
 * `upscale.ts`, whose resampler has overshoot of its own.
 *
 * Returns null when there is no raster to score, or when the grid is too small
 * for a frequency plane to mean anything — a 1x1 analysis grid has only a DC
 * term, and "energy above DC" is the whole measurement.
 */
export function computeSpurious(
  refRgba: Uint8Array,
  decRgba: Uint8Array,
  refW: number,
  refH: number,
  decW: number,
  decH: number,
): SpuriousScores | null {
  if (refW <= 0 || refH <= 0 || decW <= 0 || decH <= 0) return null;
  const { w, h } = analysisGrid(decW, decH, refW, refH);
  if (w * h < 2) return null;

  let sumSq = 0;
  let sumSqV = 0;
  let sumSqH = 0;
  let sumSqD = 0;

  // A quarter turn is split into three equal angular bands; `diagLo`/`diagHi`
  // are the boundaries in units of the quarter turn.
  const diagLo = (0.5 - SPURIOUS_DIAGONAL_BAND / 2) * (Math.PI / 2);
  const diagHi = (0.5 + SPURIOUS_DIAGONAL_BAND / 2) * (Math.PI / 2);

  for (let c = 0; c < 3; c++) {
    const dec = dct2(areaChannel(decRgba, decW, decH, w, h, c), w, h);
    const ideal = idealSpectrum(refRgba, refW, refH, w, h, c);
    for (let l = 0; l < h; l++) {
      for (let k = 0; k < w; k++) {
        // DC carries the average colour, not structure. A level error there is
        // exactly what ΔE00 exists to charge for, and counting it here would
        // make a uniformly-too-bright decode read as invented texture.
        if (k === 0 && l === 0) continue;
        const i = l * w + k;
        const excess =
          Math.abs(dec[i] ?? 0) - Math.abs(ideal[i] ?? 0) - SPURIOUS_DEAD_ZONE;
        if (excess <= 0) continue;
        const e2 = excess * excess;
        sumSq += e2;
        // Orientation is a property of the *physical* frequency (cx/w, cy/h),
        // not of the index pair: on a 32x21 grid the two differ by the aspect
        // ratio, and every photograph in the corpus has one. This is the same
        // measure the format's own selection order uses -- `(cx·H)² + (cy·W)²`,
        // spec §6.2 -- so a diagonal here is a diagonal there.
        //
        // theta = 0 is pure cx (vertical stripes); pi/2 is pure cy.
        const theta = Math.atan2(l * w, k * h);
        if (theta < diagLo) sumSqV += e2;
        else if (theta > diagHi) sumSqH += e2;
        else sumSqD += e2;
      }
    }
  }

  // Divided by the count of scored frequencies per channel across all three
  // channels, so the score is a per-frequency RMS and does not grow with the
  // grid. The DC term is excluded from the count as well as the sum.
  const scored = (w * h - 1) * 3;
  const rms = (sum: number) => Math.sqrt(sum / scored);

  return {
    spurious: rms(sumSq),
    spuriousVertical: rms(sumSqV),
    spuriousHorizontal: rms(sumSqH),
    spuriousDiagonal: rms(sumSqD),
    spuriousGridEdge: Math.max(w, h),
  };
}

/** Spurious-detail fields with every entry null — CSS formats, skipped runs. */
export const NULL_SPURIOUS: Pick<
  LocalMetrics,
  | "spurious"
  | "spuriousVertical"
  | "spuriousHorizontal"
  | "spuriousDiagonal"
  | "spuriousGridEdge"
> = {
  spurious: null,
  spuriousVertical: null,
  spuriousHorizontal: null,
  spuriousDiagonal: null,
  spuriousGridEdge: null,
};
