import { computeAllMetrics, type MetricScores } from "../metrics.ts";

/**
 * Long-edge candidates swept per byte budget. Codecs trade resolution against
 * quantization under a fixed budget, so the search explores the whole ladder
 * and lets the metric pick the best trade — a 32B WebP wins at 4-8px while a
 * 1623B one wins at 48-64px.
 */
export const DIM_LADDER: readonly number[] = [4, 6, 8, 12, 16, 24, 32, 48, 64];

/** Encoder quality range binary-searched per ladder dimension. */
export const QUALITY_MIN = 1;
export const QUALITY_MAX = 100;

/**
 * The only metric candidate selection reads (see {@link betterCiede}).
 *
 * Scoring a candidate with the full seven-metric set computed SSIMULACRA2 and
 * Butteraugli — the two expensive ones — for every rung of the ladder, then
 * threw them away: measured, 37 metric calls per image of which 6 reach the
 * report. Narrowing to ΔE00 cannot change which candidate wins, because that
 * decision was always this field alone.
 */
const RANKING_METRICS = ["ciede2000"] as const;

/**
 * Thrown when a byte budget is unrepresentable for a codec (e.g. AVIF's
 * container overhead alone exceeds ~250B, so a 32B target has no encoding).
 * The R-D report shows such variants as N/A at their anchor.
 */
export class BudgetUnrepresentableError extends Error {
  constructor(
    variant: string,
    targetBytes: number,
    /** Smallest encoding observed (min dim at min quality), or null if unknown. */
    readonly floorBytes: number | null,
  ) {
    super(
      `${variant}: ${targetBytes}B budget is unrepresentable${floorBytes !== null ? ` (smallest encoding is ${floorBytes}B)` : ""}`,
    );
    this.name = "BudgetUnrepresentableError";
  }
}

/** The winning (dimension, quality) variant for a byte budget. */
export interface CodecCandidate {
  /** Long edge (px) the source was downscaled to before encoding. */
  longEdge: number;
  /** Encoder quality (1..=100). */
  quality: number;
  /** The encoded file bytes (its length is the real encoded size). */
  data: Buffer;
  decodedRgba: Uint8Array;
  decodedWidth: number;
  decodedHeight: number;
  /** Metric scores against the reference (reused by the caller — cached). */
  scores: MetricScores;
}

export interface BudgetSearchOpts {
  /** Decode encoded bytes back to RGBA so candidates can be scored. */
  decode: (
    data: Buffer,
  ) => Promise<{ rgba: Uint8Array; width: number; height: number }>;
  /** Display-resolution reference the candidates are scored against. */
  referenceRgba: Uint8Array;
  referenceWidth: number;
  referenceHeight: number;
  /** Skip ladder dims above this (the encoder input's long edge — no upscaling). */
  maxLongEdge: number;
  /** Override the default {@link DIM_LADDER}. */
  dimLadder?: readonly number[];
}

/**
 * Find the codec variant that best spends a byte budget: for each ladder
 * dimension, binary-search the highest quality whose encoding fits
 * `targetBytes`, then pick the fitting (dim, quality) pair with the best
 * (lowest) ΔE00 against the reference. Candidate scoring goes through
 * `computeAllMetrics` — the content-hash metric cache makes the winning
 * candidate's re-score in the adapter free.
 *
 * Returns null when no dimension fits the budget even at minimum quality.
 */
export async function findCodecVariantForBudget(
  encodeAt: (longEdge: number, quality: number) => Promise<Buffer>,
  targetBytes: number,
  opts: BudgetSearchOpts,
): Promise<CodecCandidate | null> {
  let ladder = (opts.dimLadder ?? DIM_LADDER).filter(
    (d) => d <= opts.maxLongEdge,
  );
  if (ladder.length === 0) {
    // Source smaller than the smallest rung: the source itself is the only dim.
    ladder = [opts.maxLongEdge];
  }

  let best: CodecCandidate | null = null;
  for (const longEdge of ladder) {
    const fit = await maxQualityWithinBudget(encodeAt, longEdge, targetBytes);
    if (fit === null) continue;

    const decoded = await opts.decode(fit.data);
    // Ranking only — see RANKING_METRICS. The caller re-scores the winner with
    // the full set, so nothing reported comes from this call.
    const scores = await computeAllMetrics(
      opts.referenceRgba,
      opts.referenceWidth,
      opts.referenceHeight,
      decoded.rgba,
      decoded.width,
      decoded.height,
      { only: RANKING_METRICS, skipBlurred: true, skipArtifacts: true },
    );
    const candidate: CodecCandidate = {
      longEdge,
      quality: fit.quality,
      data: fit.data,
      decodedRgba: decoded.rgba,
      decodedWidth: decoded.width,
      decodedHeight: decoded.height,
      scores,
    };
    if (best === null || betterCiede(candidate, best)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Binary-search the highest quality in [QUALITY_MIN, QUALITY_MAX] whose
 * encoding fits the budget, or null when even minimum quality is too large.
 * Encoded size is treated as monotone in quality (true in practice for these
 * encoders at LQIP sizes; a rare non-monotone blip only costs optimality, not
 * correctness — every returned encoding is verified to fit).
 */
async function maxQualityWithinBudget(
  encodeAt: (longEdge: number, quality: number) => Promise<Buffer>,
  longEdge: number,
  targetBytes: number,
): Promise<{ quality: number; data: Buffer } | null> {
  const atMin = await encodeAt(longEdge, QUALITY_MIN);
  if (atMin.length > targetBytes) return null;

  const atMax = await encodeAt(longEdge, QUALITY_MAX);
  if (atMax.length <= targetBytes) {
    return { quality: QUALITY_MAX, data: atMax };
  }

  // Invariant: lo fits (with `data` its encoding), hi does not.
  let lo = QUALITY_MIN;
  let hi = QUALITY_MAX;
  let data = atMin;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const encoded = await encodeAt(longEdge, mid);
    if (encoded.length <= targetBytes) {
      lo = mid;
      data = encoded;
    } else {
      hi = mid;
    }
  }
  return { quality: lo, data };
}

/** Rank candidates by ΔE00 (lower wins); a scored candidate beats an unscored one. */
function betterCiede(a: CodecCandidate, b: CodecCandidate): boolean {
  const av = a.scores.metrics.ciede2000;
  const bv = b.scores.metrics.ciede2000;
  if (av === null) return false;
  if (bv === null) return true;
  return av < bv;
}
