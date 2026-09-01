import sharp from "sharp";
import type { LocalMetrics, MetricResult } from "./types.ts";
import { computeIqaMetrics, NULL_IQA_METRICS } from "./metrics/iqa.ts";
import { computeRinging, NULL_RINGING } from "./metrics/local.ts";
import { computeSpurious, NULL_SPURIOUS } from "./metrics/spurious.ts";
import { upscaleRgba, type UpscalePolicy } from "./upscale.ts";

/** An opaque RGB backdrop that translucent pixels are composited over. */
export type Backdrop = readonly [number, number, number];

/**
 * Backdrop both sides are composited over before scoring. RGBA PNGs handed to
 * iqa-cli have undefined alpha semantics, so alpha is resolved here: white, the
 * dominant page background placeholders sit on.
 */
export const ALPHA_BACKDROP: Backdrop = [255, 255, 255];

/**
 * Backdrop sets for {@link ScoringConfig.backdrops}.
 *
 * Scoring over white alone is the right default — it is where placeholders
 * actually sit — but it cannot measure the alpha channel. A decode whose alpha
 * is wrong wherever the colour happens to be near-white scores as though it
 * were right, so an alpha-layout experiment scored on one backdrop is largely
 * measuring colour. Compositing over white, black and mid-grey and averaging
 * makes an alpha error visible on at least one of them regardless of the
 * underlying colour.
 */
export const BACKDROP_SETS = {
  white: [[255, 255, 255]],
  "white-black-grey": [
    [255, 255, 255],
    [0, 0, 0],
    [128, 128, 128],
  ],
} as const satisfies Record<string, readonly Backdrop[]>;

/** Name of a backdrop set. */
export type BackdropSetName = keyof typeof BACKDROP_SETS;

/**
 * Blur sigma rule for the "as-rendered" metric set: LQIPs are shown with a
 * blur-up of roughly this strength relative to their display size. Floored at
 * 1.0 — libvips truncates the Gaussian kernel by amplitude, so sigma below
 * ~0.6 is a byte-identical no-op that would silently duplicate the sharp set.
 */
export const BLUR_SIGMA_RULE = "max(1, longEdge / 32)";

/**
 * The blurred "as-rendered" pass exists to answer one question — how much of a
 * format's error survives the blur-up a consumer applies — and ΔE00 answers it.
 * Requesting the full set would double the run's iqa-cli cost for six columns
 * nothing reads, and SSIMULACRA2 and Butteraugli are the expensive ones.
 */
const BLURRED_METRICS = ["ciede2000"] as const;

/** Scoring configuration, set once by the orchestrator before processing. */
export interface ScoringConfig {
  upscalePolicy: UpscalePolicy;
  blurredScoring: boolean;
  /**
   * Backdrops to composite over and average across. A single backdrop is the
   * historical path and is bit-identical to it; see {@link BACKDROP_SETS}.
   */
  backdrops?: readonly Backdrop[];
  /**
   * Also score the alpha plane directly (see {@link LocalMetrics.alphaMae}).
   * Off by default: it is meaningless for the opaque corpora and would only
   * add a null column.
   */
  alphaFidelity?: boolean;
  /**
   * Score the locally-computed artifact metrics -- ringing (`metrics/local.ts`)
   * and spurious detail (`metrics/spurious.ts`). Defaults to **off**, and the
   * report opts in.
   *
   * Optional-and-off rather than optional-and-on because the other entry points
   * -- `rd-gate.ts`, `rd-budget.ts`, `entropy-budget.ts`, and `sweep.ts` unless
   * its config opts in -- construct a config without this field and read only
   * `metrics`. Defaulting it on made every one of them compute metrics they
   * discard, which over a sweep's thousands of pairs is minutes per run for
   * numbers nothing looks at.
   *
   * The cost is not small, and grew when spurious detail joined ringing.
   * Measured on a warm metric cache over ~20 photographs and the full default
   * lineup: **15 s with these off, 28 s with them on** — the pair roughly
   * doubles a report run. That is why the report is the only entry point that
   * opts in by default, and why a sweep has to ask.
   */
  artifacts?: boolean;
}

let scoringConfig: ScoringConfig = {
  upscalePolicy: "browser-gamma",
  blurredScoring: false,
  backdrops: [ALPHA_BACKDROP],
  alphaFidelity: false,
};

export function setScoringConfig(config: ScoringConfig): void {
  scoringConfig = config;
}

export function getScoringConfig(): ScoringConfig {
  return scoringConfig;
}

/**
 * Memoized {@link flattenOverBackdrop} for the reference.
 *
 * The reference is composited once per format column -- ~15 times per image --
 * and its opaque fast path returns the input array unchanged, so for an opaque
 * image the result is already object-stable. For anything with transparency it
 * allocates a fresh array every call, which made the ringing envelope cache in
 * `metrics/local.ts` (keyed on buffer identity) a 100% miss on exactly the
 * `cutout-*` corpus it was written for. Memoizing here restores that identity
 * and drops ~15 composites per image besides.
 */
const flattenedReferences = new WeakMap<Uint8Array, Map<string, Uint8Array>>();

function flattenReference(rgba: Uint8Array, backdrop: Backdrop): Uint8Array {
  let perBuffer = flattenedReferences.get(rgba);
  if (!perBuffer) {
    perBuffer = new Map();
    flattenedReferences.set(rgba, perBuffer);
  }
  const key = backdrop.join(",");
  const hit = perBuffer.get(key);
  if (hit) return hit;
  const built = flattenOverBackdrop(rgba, backdrop);
  perBuffer.set(key, built);
  return built;
}

/** Composite RGBA over a backdrop (source-over), yielding opaque RGBA. */
export function flattenOverBackdrop(
  rgba: Uint8Array,
  backdrop: Backdrop = ALPHA_BACKDROP,
): Uint8Array {
  // Fast path: fully opaque input stays untouched.
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  if (opaque) return rgba;

  const [br, bg, bb] = backdrop;
  const out = new Uint8Array(rgba.length);
  for (let p = 0; p < rgba.length; p += 4) {
    const a = (rgba[p + 3] ?? 0) / 255;
    out[p] = Math.round((rgba[p] ?? 0) * a + br * (1 - a));
    out[p + 1] = Math.round((rgba[p + 1] ?? 0) * a + bg * (1 - a));
    out[p + 2] = Math.round((rgba[p + 2] ?? 0) * a + bb * (1 - a));
    out[p + 3] = 255;
  }
  return out;
}

/** Gaussian-blur opaque RGBA in place-equivalent fashion via sharp. */
async function blurRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  sigma: number,
): Promise<Uint8Array> {
  const { data } = await sharp(Buffer.from(rgba), {
    raw: { width, height, channels: 4 },
  })
    .blur(Math.max(0.3, sigma))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

/**
 * Memoized {@link blurRgba} for the reference, on the same principle as
 * {@link flattenReference} above.
 *
 * The blurred pass blurs both sides, but the reference side is the *same*
 * buffer for every format column and — far worse — for every candidate the
 * codec byte-target search scores. That was ~52 identical 512 px Gaussians per
 * image. The decode side is genuinely different every time and is not cached.
 *
 * Keyed on buffer identity, which `flattenReference` is what makes stable.
 */
const blurredReferences = new WeakMap<Uint8Array, Map<number, Uint8Array>>();

async function blurReference(
  rgba: Uint8Array,
  width: number,
  height: number,
  sigma: number,
): Promise<Uint8Array> {
  let perBuffer = blurredReferences.get(rgba);
  if (!perBuffer) {
    perBuffer = new Map();
    blurredReferences.set(rgba, perBuffer);
  }
  const hit = perBuffer.get(sigma);
  if (hit) return hit;
  const built = await blurRgba(rgba, width, height, sigma);
  perBuffer.set(sigma, built);
  return built;
}

/**
 * Per-call narrowing of what {@link computeAllMetrics} computes.
 *
 * A *ranking* caller — the codec byte-target search — compares candidates on
 * ΔE00 alone and discards the rest, so paying for SSIMULACRA2 and Butteraugli
 * on every rung of the dimension ladder buys nothing. Measured on eight 512 px
 * photo pairs: the full seven-metric set costs 0.69 s per pair against 0.059 s
 * for ΔE00 alone, so narrowing the search is ~11x cheaper per candidate.
 *
 * This narrows only *which metrics are asked for*. It cannot change a reported
 * number: the winner is re-scored with the full set, and the metric cache keys
 * on the requested set (see `metrics/iqa.ts`) so a narrow result is never
 * served to a caller that asked for everything.
 */
export interface MetricOptions {
  /** Restrict the iqa-cli set to these metric names; omit for every valid one. */
  only?: readonly string[];
  /**
   * Skip the blurred "as-rendered" pass regardless of
   * {@link ScoringConfig.blurredScoring}. Blur recovery is reported for the
   * chosen variant only, so scoring it for a candidate that loses is waste.
   */
  skipBlurred?: boolean;
  /**
   * Skip both locally-computed artifact metrics regardless of
   * {@link ScoringConfig.artifacts}. Same reasoning as {@link skipBlurred}: they
   * are reported for the chosen variant only, and they are not free — together
   * they roughly double a warm report run (see {@link ScoringConfig.artifacts}),
   * against ~59 ms/pair for a ΔE00-only iqa-cli call.
   */
  skipArtifacts?: boolean;
}

/** Primary + optional blurred "as-rendered" metric sets for one decode. */
export interface MetricScores {
  metrics: MetricResult;
  metricsBlurred: MetricResult | null;
  /**
   * Everything this harness measured itself rather than reading from iqa-cli.
   * Separate from {@link MetricResult} so the report's provenance claim — that
   * those seven numbers are iqa-cli's — stays true. See {@link LocalMetrics}.
   */
  local: LocalMetrics;
}

/** Mean of the finite values, or null if there are none. */
function meanOrNull(xs: (number | null)[]): number | null {
  const ys = xs.filter((v): v is number => v !== null && Number.isFinite(v));
  return ys.length > 0 ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
}

/** Average a set of metric results field by field, dropping nulls per field. */
function averageMetrics(sets: MetricResult[]): MetricResult {
  const keys = Object.keys(
    sets[0] ?? NULL_IQA_METRICS,
  ) as (keyof MetricResult)[];
  const out = {} as MetricResult;
  for (const k of keys) out[k] = meanOrNull(sets.map((m) => m[k]));
  return out;
}

/**
 * Mean absolute error between the reference alpha plane and the decode's,
 * both at reference resolution.
 *
 * The alpha plane is upscaled as an opaque greyscale image (R=G=B=alpha) under
 * the same policy as the colour, rather than by resampling RGBA directly:
 * resamplers disagree on whether to premultiply, and that disagreement would
 * land squarely in the number this is meant to measure.
 */
async function alphaPlaneMae(
  referenceRgba: Uint8Array,
  referenceW: number,
  referenceH: number,
  decodedRgba: Uint8Array,
  decodedW: number,
  decodedH: number,
): Promise<number> {
  const asGrey = (rgba: Uint8Array): Uint8Array => {
    const out = new Uint8Array(rgba.length);
    for (let p = 0; p < rgba.length; p += 4) {
      const a = rgba[p + 3] ?? 255;
      out[p] = a;
      out[p + 1] = a;
      out[p + 2] = a;
      out[p + 3] = 255;
    }
    return out;
  };

  const decAlphaAtRef = await upscaleRgba(
    asGrey(decodedRgba),
    decodedW,
    decodedH,
    referenceW,
    referenceH,
    scoringConfig.upscalePolicy,
  );

  let sum = 0;
  let n = 0;
  for (let p = 0; p < referenceRgba.length; p += 4) {
    const refA = referenceRgba[p + 3] ?? 255;
    const decA = decAlphaAtRef[p] ?? 255;
    sum += Math.abs(refA - decA);
    n++;
  }
  return n > 0 ? sum / n / 255 : 0;
}

/**
 * Score a decoded LQIP against the display-resolution reference.
 *
 * Both sides are composited over the scoring backdrop, then the decode is
 * upscaled to reference dimensions under the configured policy (placeholders
 * are judged at the size they are displayed, stretched to the display aspect
 * the way a browser stretches an `<img>`). With blurred scoring enabled, a
 * second metric set is computed after Gaussian-blurring both sides
 * (sigma = longEdge/32), modeling the blur-up presentation.
 */
export async function computeAllMetrics(
  referenceRgba: Uint8Array,
  referenceW: number,
  referenceH: number,
  decodedRgba: Uint8Array,
  decodedW: number,
  decodedH: number,
  options: MetricOptions = {},
): Promise<MetricScores> {
  const backdrops = scoringConfig.backdrops ?? [ALPHA_BACKDROP];
  const perBackdrop: MetricResult[] = [];
  const perBackdropBlurred: MetricResult[] = [];

  let ringing = NULL_RINGING;
  let spurious = NULL_SPURIOUS;
  // An explicit flag rather than `ringing === NULL_RINGING`. Both metrics are
  // taken from the primary backdrop, and reusing one's sentinel to gate the
  // other only works while their failure conditions coincide -- they do today
  // (spurious's are a strict superset), but if they ever diverge, spurious would
  // silently come from the *last* backdrop while ringing came from the first.
  let artifactsScored = false;
  for (const backdrop of backdrops) {
    const reference = flattenReference(referenceRgba, backdrop);
    const decodedFlat = flattenOverBackdrop(decodedRgba, backdrop);

    // Primary backdrop only. Averaging an artifact measure across white/black/
    // grey composites is not meaningful, and it would triple the cost. Never on
    // the blurred set either: blurring both sides destroys the artifact by
    // construction, which is the whole point of the blur-up presentation.
    if (
      (scoringConfig.artifacts ?? false) &&
      !(options.skipArtifacts ?? false) &&
      !artifactsScored
    ) {
      ringing =
        computeRinging(
          reference,
          decodedFlat,
          referenceW,
          referenceH,
          decodedW,
          decodedH,
        ) ?? NULL_RINGING;
      spurious =
        computeSpurious(
          reference,
          decodedFlat,
          referenceW,
          referenceH,
          decodedW,
          decodedH,
        ) ?? NULL_SPURIOUS;
      artifactsScored = true;
    }

    // Composite first, then upscale: the backdrop is part of what is resampled,
    // so hoisting the upscale out of this loop would change the result.
    const decodedAtRef = await upscaleRgba(
      decodedFlat,
      decodedW,
      decodedH,
      referenceW,
      referenceH,
      scoringConfig.upscalePolicy,
    );

    perBackdrop.push(
      await computeIqaMetrics(
        reference,
        decodedAtRef,
        referenceW,
        referenceH,
        options.only,
      ),
    );

    if (scoringConfig.blurredScoring && !(options.skipBlurred ?? false)) {
      const sigma = Math.max(1, Math.max(referenceW, referenceH) / 32);
      const [refBlur, decBlur] = await Promise.all([
        blurReference(reference, referenceW, referenceH, sigma),
        blurRgba(decodedAtRef, referenceW, referenceH, sigma),
      ]);
      perBackdropBlurred.push(
        await computeIqaMetrics(
          refBlur,
          decBlur,
          referenceW,
          referenceH,
          BLURRED_METRICS,
        ),
      );
    }
  }

  // One backdrop is the historical path: return its result untouched rather
  // than round-tripping it through the averaging code.
  const metrics =
    perBackdrop.length === 1
      ? (perBackdrop[0] as MetricResult)
      : averageMetrics(perBackdrop);
  const metricsBlurred =
    perBackdropBlurred.length === 0
      ? null
      : perBackdropBlurred.length === 1
        ? (perBackdropBlurred[0] as MetricResult)
        : averageMetrics(perBackdropBlurred);

  const alphaMae = scoringConfig.alphaFidelity
    ? await alphaPlaneMae(
        referenceRgba,
        referenceW,
        referenceH,
        decodedRgba,
        decodedW,
        decodedH,
      )
    : null;

  return {
    metrics,
    metricsBlurred,
    local: { alphaMae, ...ringing, ...spurious },
  };
}

/** MetricResult with all fields null — for CSS-only formats that produce no raster output. */
export const NULL_METRICS: MetricResult = NULL_IQA_METRICS;
