/**
 * Metrics this harness computes itself, in-process — as opposed to the seven
 * `iqa-cli` returns (see `metrics/iqa.ts`). Kept in a separate module, and
 * behind a separate type, so the report's claim that those seven come from
 * iqa-cli stays literally true.
 *
 * Here: **ringing**, the overshoot measure. Its companion, **spurious detail**,
 * lives in `metrics/spurious.ts` — the two are the artifact pair, and the split
 * is deliberate: ringing sees only error that escapes the reference's local
 * range, and everything that stays inside it is the other metric's job.
 *
 * ## Why a new metric at all
 *
 * ΔE00, SSIMULACRA2, DSSIM and Butteraugli are aggregate fidelity scores. They
 * answer "how wrong is this?" and cannot separate *smooth but wrong* from
 * *sharp with artifacts*: a placeholder that is uniformly a little off and one
 * that rings visibly around every edge can score the same. That distinction is
 * the one a consumer actually feels, because a downstream blur-up hides the
 * second kind of error and not the first, and it is the question
 * `spec/README.md` §14 leaves open about the decode-side synthesis window at
 * the high tiers.
 *
 * ## What it measures
 *
 * Overshoot: how far the decode escapes the *local* range of the reference.
 *
 * The theorem the metric rests on: a decode that is merely a low-pass of the
 * reference is a convex combination of nearby reference samples, so it lies
 * inside the local [min, max] of any window containing the samples it averaged.
 * It therefore scores exactly **zero**. Only a reconstruction that overshoots —
 * Gibbs ringing from a truncated frequency basis, the halo the format is
 * suspected of at high tiers — leaves the envelope. That "blur ⇒ 0" property is
 * what makes this an artifact measure rather than another fidelity score.
 *
 * Three design consequences follow from wanting that zero to be exact:
 *
 * 1. **Nearest-neighbour sampling, not the scoring upscale.** `upscale.ts`
 *    brings decodes to reference resolution with sharp, which overshoots a step
 *    edge by ~7% (measured; see the note in `upscale.ts`). Scoring after it
 *    would charge every format for the resampler's own halo. Nearest is the
 *    unique resampler that neither adds nor removes overshoot — every output
 *    pixel's value *is* some decoded sample's value — so a non-zero score is
 *    attributable to the format. It also makes the number independent of
 *    `--upscale-policy`.
 * 2. **The window scales with the decode.** A decoded sample covers
 *    `refW/decW × refH/decH` reference pixels, so a window smaller than that
 *    footprint fires on ordinary resolution loss. `r >= S` is what makes the
 *    low-pass case score zero; the extra factor covers the support of a real
 *    reconstruction kernel. This is derived, not tuned — and it is why the
 *    radius is per-format-per-image and gets reported alongside the score.
 * 3. **Bias correction.** Without it a solid-colour fixture, whose envelope is
 *    a single point, scores any tint error as ringing. Subtracting the locally
 *    smooth component of the error first absorbs level and tint errors — which
 *    are broad — while ringing, which oscillates either side of an edge, mostly
 *    cancels in a wide mean and survives.
 *
 * Working in gamma-encoded sRGB, per channel, is deliberate: convexity is
 * preserved by linear resampling *in the space the resampling happened in*, so
 * measuring there keeps "blur ⇒ exactly 0" exact. OKLab would be more
 * perceptual but only approximately zero on a blur, and `gamut.ts` states the
 * OKLab matrices are not reimplemented in this tool.
 *
 * Per-channel RGB is not blind to chroma ringing: a chroma ring is precisely an
 * excursion where channels move in opposite directions, and each leaves its own
 * envelope. The luma/chroma split below decomposes it rather than changing
 * space.
 */

import type { LocalMetrics } from "../types.ts";

/**
 * Window radius in decoded samples. `>= 1` is what makes an ordinary low-pass
 * decode score zero; 2 covers the support of a reconstruction kernel wider than
 * a single sample (a Gaussian, a cosine's main lobe).
 *
 * Biasing this large is close to free: Gibbs overshoot exceeds the reference's
 * true local extremes, so a wider window still flags real ringing. It only
 * stops flagging excursions that stay *inside* the reference's range — which
 * are not overshoot. The number is therefore a conservative lower bound.
 */
export const RING_WINDOW_SAMPLES = 2;

/** Ignore excursions below one 8-bit level: that is compositing rounding. */
export const RING_DEAD_ZONE = 1.0;

/**
 * Bias-correction radius, as a multiple of the envelope radius. The one
 * genuinely tuned constant here, and a real tension: too small and it eats
 * broad halos that are ringing; too large and it stops absorbing local tint.
 */
export const RING_BIAS_RADIUS_FACTOR = 4;

/**
 * The window is bounded by the image, and by nothing else.
 *
 * There was a fixed cap here (64). It was wrong: the radius derivation requires
 * `r >= S`, so capping it below `2S` breaks the property the whole metric rests
 * on and the score starts measuring ordinary resolution loss. Measured on
 * `graphic-logo-solid-blue.png` against a *box-averaged* decode — convex, so
 * provably free of overshoot — a 4x3 decode scored **7.67**, larger than a real
 * synthetic Gibbs ripple. The cap cost correctness and bought nothing: the
 * sliding min/max is a monotonic deque, O(n) in the row length regardless of
 * radius, so a large window is very nearly free.
 */
function windowRadius(scale: number, refW: number, refH: number): number {
  const wanted = Math.ceil(RING_WINDOW_SAMPLES * scale);
  // A window wider than the image measures the global range rather than a local
  // one; there is nothing beyond the image to include.
  return Math.max(1, Math.min(wanted, Math.max(refW, refH)));
}

/** Ringing measurements for one decode, all in 8-bit sRGB levels. */
export interface RingingScores {
  ringing: number;
  ringingLuma: number;
  ringingChroma: number;
  ringArea: number;
  ringP99: number;
  ringWindowRadius: number;
}

/**
 * 1-D sliding minimum over a truncated window `[i-r, i+r]`, along one axis of a
 * strided plane. Monotonic-deque (van Herk / Gil-Werman equivalent): each index
 * is pushed and popped at most once, so the whole pass is O(n) regardless of
 * `r`. A naive window would be O(n·r), and `r` reaches ~32 at a 32px decode
 * scored against a 512px reference.
 */
function slidingMin1D(
  src: Float32Array,
  out: Float32Array,
  n: number,
  stride: number,
  base: number,
  r: number,
  deque: Int32Array,
): void {
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n + r; j++) {
    if (j < n) {
      const v = src[base + j * stride] ?? 0;
      while (
        tail > head &&
        (src[base + (deque[tail - 1] ?? 0) * stride] ?? 0) >= v
      ) {
        tail--;
      }
      deque[tail++] = j;
    }
    const i = j - r;
    if (i >= 0) {
      const lo = i - r;
      while (tail > head && (deque[head] ?? 0) < lo) head++;
      out[base + i * stride] = src[base + (deque[head] ?? 0) * stride] ?? 0;
    }
  }
}

/** 1-D sliding maximum; see {@link slidingMin1D}. */
function slidingMax1D(
  src: Float32Array,
  out: Float32Array,
  n: number,
  stride: number,
  base: number,
  r: number,
  deque: Int32Array,
): void {
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n + r; j++) {
    if (j < n) {
      const v = src[base + j * stride] ?? 0;
      while (
        tail > head &&
        (src[base + (deque[tail - 1] ?? 0) * stride] ?? 0) <= v
      ) {
        tail--;
      }
      deque[tail++] = j;
    }
    const i = j - r;
    if (i >= 0) {
      const lo = i - r;
      while (tail > head && (deque[head] ?? 0) < lo) head++;
      out[base + i * stride] = src[base + (deque[head] ?? 0) * stride] ?? 0;
    }
  }
}

/**
 * 2-D sliding min/max over a `(2r+1)²` box, computed separably — a box
 * structuring element decomposes into a horizontal pass then a vertical one.
 */
function envelope2D(
  plane: Float32Array,
  w: number,
  h: number,
  r: number,
): { min: Float32Array; max: Float32Array } {
  const deque = new Int32Array(Math.max(w, h));
  const hMin = new Float32Array(w * h);
  const hMax = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    slidingMin1D(plane, hMin, w, 1, y * w, r, deque);
    slidingMax1D(plane, hMax, w, 1, y * w, r, deque);
  }
  const min = new Float32Array(w * h);
  const max = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    slidingMin1D(hMin, min, h, w, x, r, deque);
    slidingMax1D(hMax, max, h, w, x, r, deque);
  }
  return { min, max };
}

/**
 * Box mean over a truncated `(2R+1)²` window via a summed-area table.
 *
 * Float64 for the table, not Float32: the running sum reaches
 * `512·512·255 ≈ 6.7e7`, well past Float32's 24-bit exact-integer range, and a
 * bias term that drifts would show up as phantom ringing.
 */
function boxMean(
  src: Float32Array,
  w: number,
  h: number,
  r: number,
): Float32Array {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x] ?? 0;
      sat[(y + 1) * (w + 1) + (x + 1)] =
        (sat[y * (w + 1) + (x + 1)] ?? 0) + rowSum;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const total =
        (sat[(y1 + 1) * (w + 1) + (x1 + 1)] ?? 0) -
        (sat[y0 * (w + 1) + (x1 + 1)] ?? 0) -
        (sat[(y1 + 1) * (w + 1) + x0] ?? 0) +
        (sat[y0 * (w + 1) + x0] ?? 0);
      out[y * w + x] = total / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }
  return out;
}

/**
 * The reference envelope depends only on the composited reference and the
 * radius, and every format column in an image re-derives it — ~15 times per
 * image, for the handful of distinct radii the lineup's decode sizes produce.
 * Memoized on the buffer's identity so it is computed once each; the WeakMap
 * releases it when the image goes out of scope.
 */
const envelopeCache = new WeakMap<
  Uint8Array,
  Map<string, { min: Float32Array; max: Float32Array }>
>();

function referenceEnvelope(
  refRgba: Uint8Array,
  plane: Float32Array,
  channel: number,
  w: number,
  h: number,
  r: number,
): { min: Float32Array; max: Float32Array } {
  let perBuffer = envelopeCache.get(refRgba);
  if (!perBuffer) {
    perBuffer = new Map();
    envelopeCache.set(refRgba, perBuffer);
  }
  const key = `${channel}:${r}`;
  const hit = perBuffer.get(key);
  if (hit) return hit;
  const built = envelope2D(plane, w, h, r);
  perBuffer.set(key, built);
  return built;
}

/** Extract one channel of an interleaved RGBA buffer as a float plane. */
function channelPlane(
  rgba: Uint8Array,
  count: number,
  channel: number,
): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = rgba[i * 4 + channel] ?? 0;
  return out;
}

/**
 * Nearest-neighbour sample-and-hold of one channel of the decode up to
 * reference dimensions. Deliberately not `upscaleRgba` — see the module note.
 */
function nearestPlane(
  decRgba: Uint8Array,
  decW: number,
  decH: number,
  refW: number,
  refH: number,
  channel: number,
): Float32Array {
  const xMap = new Int32Array(refW);
  for (let x = 0; x < refW; x++) {
    xMap[x] = Math.min(decW - 1, Math.floor(((x + 0.5) * decW) / refW));
  }
  const out = new Float32Array(refW * refH);
  for (let y = 0; y < refH; y++) {
    const sy = Math.min(decH - 1, Math.floor(((y + 0.5) * decH) / refH));
    const srcRow = sy * decW;
    const dstRow = y * refW;
    for (let x = 0; x < refW; x++) {
      out[dstRow + x] = decRgba[(srcRow + (xMap[x] ?? 0)) * 4 + channel] ?? 0;
    }
  }
  return out;
}

/**
 * Score ringing between a composited reference and a composited decode.
 *
 * Both buffers must already be opaque RGBA (composited over the scoring
 * backdrop by the caller); the decode is at its own dimensions and is sampled
 * up here, not resampled by `upscale.ts`.
 *
 * Returns null when there is no raster to score.
 */
export function computeRinging(
  refRgba: Uint8Array,
  decRgba: Uint8Array,
  refW: number,
  refH: number,
  decW: number,
  decH: number,
): RingingScores | null {
  if (refW <= 0 || refH <= 0 || decW <= 0 || decH <= 0) return null;

  const scale = Math.max(refW / decW, refH / decH);
  const radius = windowRadius(scale, refW, refH);
  const biasRadius = radius * RING_BIAS_RADIUS_FACTOR;

  const count = refW * refH;
  // Signed per-channel excursion, reused across the three channel passes.
  const dR = new Float32Array(count);
  const dG = new Float32Array(count);
  const dB = new Float32Array(count);
  const excursions = [dR, dG, dB];

  for (let c = 0; c < 3; c++) {
    const refPlane = channelPlane(refRgba, count, c);
    const decPlane = nearestPlane(decRgba, decW, decH, refW, refH, c);
    const { min, max } = referenceEnvelope(
      refRgba,
      refPlane,
      c,
      refW,
      refH,
      radius,
    );

    // Locally-smooth component of the error: a level or tint shift is broad and
    // is absorbed here, while ringing oscillates about an edge and cancels.
    const diff = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      diff[i] = (decPlane[i] ?? 0) - (refPlane[i] ?? 0);
    }
    const bias = boxMean(diff, refW, refH, biasRadius);

    // An excursion has to survive BOTH tests: it must escape the reference's
    // local range, *and* it must not be explained by a locally-smooth offset.
    //
    // Taking only the bias-corrected test breaks the property the metric is
    // built on. Convexity says the decode itself lies inside [min, max]; it says
    // nothing about the decode minus a bias, so wherever the bias is non-zero
    // and the envelope is tight, a pure low-pass escapes. Measured on
    // `graphic-logo-solid-blue.png` at a correct radius, a box-averaged decode
    // scored 0.09 rather than 0.
    //
    // Taking only the raw test breaks the other property: on a solid colour the
    // envelope is a single point, so any tint error reads as ringing.
    //
    // The smaller of the two keeps both. A low-pass has a raw excess of exactly
    // zero; a uniform tint has a bias-corrected excess of zero; genuine ringing
    // oscillates about an edge, so it largely cancels in the wide mean and
    // survives both. The result is a conservative lower bound, which is what
    // this metric claims to be.
    const out = excursions[c] as Float32Array;
    for (let i = 0; i < count; i++) {
      const dec = decPlane[i] ?? 0;
      const v = dec - (bias[i] ?? 0);
      const hi = max[i] ?? 0;
      const lo = min[i] ?? 0;
      const over = Math.min(dec - hi, v - hi) - RING_DEAD_ZONE;
      if (over > 0) {
        out[i] = over;
        continue;
      }
      const under = Math.min(lo - dec, lo - v) - RING_DEAD_ZONE;
      out[i] = under > 0 ? -under : 0;
    }
  }

  // Decompose each pixel's excursion vector d into its achromatic projection
  // onto (1,1,1)/sqrt(3) and the orthogonal chromatic residual, so
  // m^2 = mL^2 + mC^2 pointwise -- and, because the aggregate is an RMS, so
  // that ringing^2 = ringingLuma^2 + ringingChroma^2 exactly.
  const INV_SQRT3 = 1 / Math.sqrt(3);
  let sumSq = 0;
  let sumSqL = 0;
  let sumSqC = 0;
  let hit = 0;
  // 1024 bins over [0, 256) levels for the p99: a sort of 262k floats per pair
  // would dominate the metric's cost.
  const BINS = 1024;
  const hist = new Int32Array(BINS);
  for (let i = 0; i < count; i++) {
    const r = dR[i] ?? 0;
    const g = dG[i] ?? 0;
    const b = dB[i] ?? 0;
    const m = Math.sqrt(r * r + g * g + b * b) * INV_SQRT3;
    const mL = Math.abs(r + g + b) / 3;
    const mC2 = Math.max(0, m * m - mL * mL);
    sumSq += m * m;
    sumSqL += mL * mL;
    sumSqC += mC2;
    if (m > 0) {
      hit++;
      const bin = Math.min(BINS - 1, Math.floor((m / 256) * BINS));
      hist[bin] = (hist[bin] ?? 0) + 1;
    }
  }

  // Pixels with no excursion are not binned, so they seed the running count.
  let seen = count - hit;
  const target = count * 0.99;
  let p99 = 0;
  if (seen < target) {
    for (let b = 0; b < BINS; b++) {
      seen += hist[b] ?? 0;
      if (seen >= target) {
        p99 = ((b + 1) / BINS) * 256;
        break;
      }
    }
  }

  return {
    ringing: Math.sqrt(sumSq / count),
    ringingLuma: Math.sqrt(sumSqL / count),
    ringingChroma: Math.sqrt(sumSqC / count),
    ringArea: hit / count,
    ringP99: p99,
    ringWindowRadius: radius,
  };
}

/** Ringing fields with every entry null — CSS-only formats, skipped runs. */
export const NULL_RINGING: Pick<
  LocalMetrics,
  | "ringing"
  | "ringingLuma"
  | "ringingChroma"
  | "ringArea"
  | "ringP99"
  | "ringWindowRadius"
> = {
  ringing: null,
  ringingLuma: null,
  ringingChroma: null,
  ringArea: null,
  ringP99: null,
  ringWindowRadius: null,
};
