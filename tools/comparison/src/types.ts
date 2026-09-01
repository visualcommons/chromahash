import type { CorpusSplit, CorpusTier } from "./corpus.ts";
import type { PairedComparison } from "./paired.ts";

/** Represents a loaded and downscaled image ready for encoding. */
export interface ImageInput {
  /** Original file path. */
  filePath: string;
  /** Original image width. */
  originalWidth: number;
  /** Original image height. */
  originalHeight: number;
  /** Downscaled width (<=100px). */
  smallWidth: number;
  /** Downscaled height (<=100px). */
  smallHeight: number;
  /** Downscaled raw RGBA pixel data (the encoder input). */
  smallRgba: Uint8Array;
  /**
   * Display-resolution reference width (original capped to REFERENCE_CAP px on
   * the long edge). Quality is judged at this scale — the resolution a
   * placeholder is actually shown at — not at the encoder-input scale.
   */
  referenceWidth: number;
  /** Display-resolution reference height. */
  referenceHeight: number;
  /** Display-resolution reference RGBA (original decoded at the capped size). */
  referenceRgba: Uint8Array;
  /** Original file as a Buffer. */
  fileBuffer: Buffer;
  /** Source gamut identifier (e.g. "srgb", "displayp3"). */
  gamut?: string;
  /**
   * Color-managed metric reference: referenceRgba converted from its tagged
   * gamut to sRGB appearance, at reference resolution. Metrics for every format
   * compare against this (not the raw gamut-encoded bytes). Equals
   * referenceRgba when gamut is sRGB.
   */
  metricReferenceRgba?: Uint8Array;
}

/**
 * Per-format quality metrics, computed by `iqa-cli` between the decoded preview
 * (upscaled to display resolution by the configured policy) and the
 * display-resolution reference. All fields are null for formats that produce no
 * raster output, or when running with --allow-missing-iqa.
 */
export interface MetricResult {
  /**
   * Primary metric: mean CIEDE2000 (ΔE00) color difference over sRGB→CIELAB (D65).
   * Lower is better; ΔE00 JND ≈ 1.
   */
  ciede2000: number | null;
  /** DSSIM = (1 - SSIM) / 2. Lower is better; 0 = identical. */
  dssim: number | null;
  /** Multi-scale SSIM. Higher is better; 1 = identical. */
  msSsim: number | null;
  /** PSNR-HVS-M (DCT-domain PSNR with CSF + contrast masking), in dB. Higher is better. */
  psnrHvsM: number | null;
  /** SSIMULACRA2 perceptual score. Higher is better (100 = identical). */
  ssimulacra2: number | null;
  /** Butteraugli distance. Lower is better; 0 = identical. */
  butteraugli: number | null;
  /** Classic PSNR in dB. Higher is better; reference only (weak LQIP correlation). */
  psnrDb: number | null;
}

/**
 * Metrics this harness computes itself, in-process, rather than reading from
 * `iqa-cli`.
 *
 * Kept out of {@link MetricResult} deliberately, and for the reason `alphaMae`
 * always was: `MetricResult` is *what iqa-cli returned*, and folding a
 * locally-computed number into it would make the report's provenance claim
 * false. Anything measured here belongs in this interface instead.
 */
export interface LocalMetrics {
  /**
   * Mean absolute alpha error on [0, 1], scored on the alpha plane alone at
   * reference resolution. Null unless alpha fidelity is being scored.
   */
  alphaMae: number | null;
  /**
   * Ringing: RMS excursion beyond the reference's local range, in 8-bit sRGB
   * levels. Lower is better; a decode that is merely a blur of the reference
   * scores exactly 0. This is the artifact measure — see `metrics/local.ts`
   * for why the fidelity metrics cannot answer the same question.
   */
  ringing: number | null;
  /** Achromatic part of the ringing excursion (levels). */
  ringingLuma: number | null;
  /** Chromatic part of the ringing excursion (levels); orthogonal to the above. */
  ringingChroma: number | null;
  /** Fraction of pixels with any excursion at all, on [0, 1]. */
  ringArea: number | null;
  /** 99th percentile of the per-pixel excursion (levels). */
  ringP99: number | null;
  /**
   * Envelope radius used, in reference pixels. Reported because it is derived
   * per format per image from the decode's scale, so the score carries its own
   * scale (see `metrics/local.ts`).
   */
  ringWindowRadius: number | null;
  /**
   * Spurious detail: RMS energy the decode carries at spatial frequencies the
   * reference does not, in 8-bit sRGB levels. Lower is better; a decode that is
   * the ideal low-pass of the reference scores exactly 0.
   *
   * The companion to {@link ringing}, and the reason there are two: ringing sees
   * only error that escapes the reference's *local range*, so an in-envelope
   * ripple, a broad wave over a textured region and a directional stripe all
   * score zero there. See `metrics/spurious.ts`.
   */
  spurious: number | null;
  /** Vertical-stripe part of the spurious energy (cx-dominant frequencies). */
  spuriousVertical: number | null;
  /** Horizontal-stripe part (cy-dominant frequencies). */
  spuriousHorizontal: number | null;
  /** Oblique part; the three partition the plane and recombine in quadrature. */
  spuriousDiagonal: number | null;
  /**
   * Longest edge of the analysis grid, in samples. Reported for the same reason
   * as {@link ringWindowRadius}: it is derived per format per image, so two
   * scores are directly comparable only at equal grids.
   */
  spuriousGridEdge: number | null;
}

/** All-null local metrics — for CSS-only formats and skipped computations. */
export const NULL_LOCAL_METRICS: LocalMetrics = {
  alphaMae: null,
  ringing: null,
  ringingLuma: null,
  ringingChroma: null,
  ringArea: null,
  ringP99: null,
  ringWindowRadius: null,
  spurious: null,
  spuriousVertical: null,
  spuriousHorizontal: null,
  spuriousDiagonal: null,
  spuriousGridEdge: null,
};

/**
 * The size a format *declares* — what a consumer could reserve layout for from
 * the payload alone, before any image data arrives.
 *
 * Deliberately **not** `decodedWidth`/`decodedHeight`. Those are the size this
 * harness asked for: `decode_capped_to_with` in the Rust core caps per axis
 * (`nat_w.min(max_w)`), and the ChromaHash adapter passes the encoder input as
 * that cap, so at the higher tiers the reported decode dimensions *are the cap*
 * — the harness's own downscale of the source, not the format's shape. Deriving
 * an aspect error from them would report ~0 for exactly the tiers whose layout
 * precision is in question.
 *
 * Required on {@link FormatResult} rather than optional: every adapter has to
 * state its answer, and "this format carries no aspect at all" is an answer
 * with a reason, not a missing field.
 */
export type IntrinsicSize =
  | {
      readonly kind: "declared";
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "absent"; readonly reason: string };

/**
 * How far a format's declared shape is from the shape it was handed, and what
 * that costs a page that reserves layout from it.
 */
export interface AspectFidelity {
  /**
   * |log2(AR_declared / AR_target)| in octaves. The symmetric measure: the
   * ratio form |AR_d/AR_t − 1| scores 10% too wide as 10.00% and 10% too narrow
   * as 9.09%, so a corpus mean would be biased by the landscape/portrait mix.
   * Symmetry about 1:1 is the same property spec §8.1 builds the aspect
   * encoding on.
   */
  log2Error: number;
  /** (2^log2Error − 1) × 100 — spec §8.1's own convention for the same error. */
  errorPct: number;
  /**
   * Layout shift in CSS px for a `REFLOW_CONTAINER_PX`-wide container. Positive
   * means the real image is taller than the placeholder reserved, so content
   * below it gets pushed down when the image loads.
   */
  reflowPx: number;
}

/** Result of encoding/decoding with a particular format. */
export interface FormatResult {
  /** Name of the LQIP format. */
  formatName: string;
  /** Size of the encoded representation in bytes. */
  encodedSizeBytes: number;
  /** Width of the decoded preview image. */
  decodedWidth: number;
  /** Height of the decoded preview image. */
  decodedHeight: number;
  /** Base64 PNG data URI for HTML embedding. */
  dataUri: string;
  /** Quality metrics (all null for CSS-only formats like unpic). */
  metrics: MetricResult;
  /**
   * "As-rendered" metrics: both sides Gaussian-blurred before scoring, modeling
   * the blur-up presentation LQIPs are typically displayed with. Null unless the
   * run enables --blurred-scoring.
   */
  metricsBlurred: MetricResult | null;
  /** Metrics computed by this harness rather than by iqa-cli. */
  local: LocalMetrics;
  /** The size this format declares, or why it declares none. */
  intrinsicSize: IntrinsicSize;
}

/** An adapter that processes an image through a specific LQIP format. */
export interface FormatAdapter {
  /** Display name of the format. */
  readonly name: string;
  /** Process an image and return the format result. */
  process(input: ImageInput): Promise<FormatResult>;
}

/** Result from a per-language CLI harness. */
export interface HarnessResult {
  /** Language name (e.g. "Rust", "TypeScript"). */
  language: string;
  /** The 32-byte hash produced by this implementation. */
  hash: Uint8Array;
  /** Whether this hash matches the reference (Rust) hash. */
  matches: boolean;
  /**
   * Why this harness produced no hash, or null when it ran.
   *
   * A harness that builds and then crashes used to be recorded as
   * `matches: false` — indistinguishable from a genuine byte disagreement,
   * which is a claim nothing observed. Consumers must treat an errored result
   * as *inconclusive*, never as a mismatch.
   */
  error: string | null;
  /** Decoded preview as a base64 PNG data URI. */
  dataUri: string;
  /** Width of the decoded preview, or 0 when the harness produced no preview. */
  decodedWidth: number;
  /** Height of the decoded preview, or 0 when the harness produced no preview. */
  decodedHeight: number;
}

/** Category for grouping images in the report. */
export type ImageCategory =
  | "Dimensions"
  | "Alpha"
  | "Alpha (real)"
  | "Graphics"
  | "Color Distribution"
  | "Quantization"
  | "Gamut"
  | "Text/UI"
  | "Illustration"
  | "Natural"
  | "Portrait"
  | "Night"
  | "Realistic";

/** Per-format summary statistics, averaged across a set of images. */
export interface FormatStat {
  name: string;
  /**
   * Images this format actually produced a result for. A codec baseline can
   * fail to hit a small byte budget on some images (its container floor
   * exceeds it), and a mean over the subset that fit would otherwise be
   * presented as a mean over the whole set.
   */
  images: number;
  avgSize: number;
  /** Primary metric: mean CIEDE2000 ΔE00 (lower is better). */
  avgCiede: number | null;
  avgDssim: number | null;
  avgMsSsim: number | null;
  avgPsnrHvsM: number | null;
  avgSsimulacra2: number | null;
  avgButteraugli: number | null;
  avgPsnr: number | null;
  /** Mean blurred "as-rendered" ΔE00; null unless --blurred-scoring ran. */
  avgCiedeBlurred: number | null;
  /** Median ΔE00 across the set (robust to outlier images). */
  medianCiede: number | null;
  /** 90th-percentile ΔE00 — the tail behaviour a mean hides. */
  p90Ciede: number | null;
  /** 95% bootstrap confidence interval of the mean ΔE00 (see stats.ts). */
  ciCiede: [number, number] | null;
  /** RMS ringing in 8-bit sRGB levels, averaged across the set. */
  avgRinging: number | null;
  /** 90th-percentile ringing — the images where artifacts actually bite. */
  p90Ringing: number | null;
  /** Mean fraction of pixels carrying any excursion, on [0, 1]. */
  avgRingArea: number | null;
  /**
   * Mean aspect error, as a percent, converted from the mean of the per-image
   * octave errors (see aspect.ts on why the mean is taken in log space).
   */
  avgAspectErrorPct: number | null;
  /** 90th-percentile aspect error, as a percent. */
  p90AspectErrorPct: number | null;
  /**
   * Largest absolute reflow across the set, in CSS px at the reference
   * container width. Max rather than mean: layout shift is felt on the worst
   * page in a set, not on the average one.
   */
  maxAbsReflowPx: number | null;
  /**
   * Images where this format declared a size at all. Zero means the format
   * carries no aspect, and the report must print a dash rather than a number.
   */
  aspectImages: number;
  /** Why no size was declared, when `aspectImages` is 0. */
  aspectAbsentReason: string | null;
}

/**
 * A single format's encode/decode result as serialized into the JSON report.
 * Mirrors {@link FormatResult} but references the decoded preview by relative
 * file path instead of embedding it inline.
 */
export interface FormatJson {
  formatName: string;
  encodedSizeBytes: number;
  decodedWidth: number;
  decodedHeight: number;
  /** Relative path to the standalone preview image, or null for CSS-only formats. */
  preview: string | null;
  /** CSS gradient string for CSS-only formats (e.g. unpic), else null. */
  css: string | null;
  metrics: MetricResult;
  /** Blurred "as-rendered" metrics; null unless --blurred-scoring ran. */
  metricsBlurred: MetricResult | null;
  /** Metrics computed by this harness rather than by iqa-cli. */
  local: LocalMetrics;
  /** The size this format declares, or why it declares none. */
  intrinsicSize: IntrinsicSize;
  /** Layout fidelity against the encoder input; null when no size is declared. */
  aspect: AspectFidelity | null;
}

/** A single language implementation's result as serialized into the JSON report. */
export interface ImplementationJson {
  language: string;
  /** Hex-encoded 32-byte hash, or "" if the harness errored. */
  hash: string;
  /**
   * Whether this hash matches the reference (Rust) hash. Meaningful only when
   * {@link error} is null — an errored harness produced no hash to compare.
   */
  matches: boolean;
  /** Why this harness produced no hash, or null when it ran. */
  error: string | null;
  /** Relative path to the standalone decoded preview, or null if the harness errored. */
  preview: string | null;
}

/** A single image's full comparison record as serialized into the JSON report. */
export interface ComparisonImageJson {
  name: string;
  category: ImageCategory;
  /** Corpus split (see corpus.ts) so downstream tools never re-derive it. */
  split: CorpusSplit;
  /** Real content or a generated capability fixture (see corpus.ts). */
  tier: CorpusTier;
  originalWidth: number;
  originalHeight: number;
  /** Relative path to the standalone original (display-sized) image. */
  original: string;
  /** Relative path to the standalone encoder-input (downscaled) image. */
  encoderInput: string;
  /** Encoder-input width (the resolution all formats encode from). */
  encoderInputWidth: number;
  /** Encoder-input height. */
  encoderInputHeight: number;
  formats: FormatJson[];
  implementations: ImplementationJson[];
}

/**
 * The full machine-readable comparison report. Written alongside the HTML and
 * referencing the same standalone images under `images/`.
 */
/** How the run scored quality — stamped into the JSON so results are interpretable. */
export interface ScoringMetaJson {
  /** Long-edge cap (px) of the display-resolution reference. */
  referenceCap: number;
  /** Upscale policy used to bring decodes to reference resolution. */
  upscalePolicy: string;
  /** Whether the blurred "as-rendered" metric set was computed. */
  blurredScoring: boolean;
  /** Gaussian sigma rule for blurred scoring (informational). */
  blurSigmaRule: string;
  /** Backdrop RGB both sides are composited over before scoring. */
  alphaBackdrop: readonly [number, number, number];
  /** Container width the layout reflow figure is quoted for, in CSS px. */
  reflowContainerPx: number;
  /**
   * Whether the locally-computed artifact metrics (ringing and spurious detail)
   * were scored. One flag, because both are computed at the same point on the
   * same composited pair, and neither is meaningful on the blurred set.
   */
  artifacts: boolean;
}

/**
 * One point on a rate–distortion curve: a single variant (e.g. "ChromaHash t2",
 * "WebP@411B") aggregated as the MEAN over the images processed in the run.
 */
export interface RdPointJson {
  /** Variant name, unique within the run (doubles as the formatName). */
  variant: string;
  /** Mean encoded size in bytes across the processed images. */
  bytes: number;
  /** Mean ΔE00 (lower is better), or null when never computed. */
  ciede2000: number | null;
  /** Mean SSIMULACRA2 (higher is better), or null when never computed. */
  ssimulacra2: number | null;
  /** Mean Butteraugli distance (lower is better), or null when never computed. */
  butteraugli: number | null;
  /** How many images contributed (variants can be unrepresentable per-image). */
  imageCount: number;
}

/** A format family's rate–distortion curve (points sorted by mean bytes). */
export interface RdCurveJson {
  /** Family name the variants sweep (e.g. "ChromaHash", "BlurHash", "WebP"). */
  format: string;
  points: RdPointJson[];
}

/** Rate–distortion sweep results (present only in `--rd` runs). */
export interface RdJson {
  /** Canonical equal-byte anchors: every ChromaHash tier size (no-alpha). */
  anchors: number[];
  curves: RdCurveJson[];
}

export interface ComparisonJson {
  /** Schema version, bumped on breaking changes to this structure. */
  schemaVersion: number;
  /** Pre-formatted generation timestamp (matches the HTML footer). */
  generatedAt: string;
  /** Scoring configuration for this run. */
  scoring: ScoringMetaJson;
  /** Full commit SHA the report was built from, or null when unknown. */
  commit: string | null;
  /** Base repository URL, or null. */
  repoUrl: string | null;
  /** LQIP format names, in report order. */
  formats: string[];
  /** Language implementation names, in report order. */
  languages: string[];
  /**
   * Summary statistics: photographic images (primary), all images, and the
   * tune/holdout corpus splits (see corpus.ts).
   */
  summary: {
    naturalAndRealistic: FormatStat[];
    all: FormatStat[];
    tune: FormatStat[];
    holdout: FormatStat[];
  };
  /** Cross-language pass/fail; pass is null when harnesses were skipped. */
  crossLanguage: { language: string; pass: boolean | null }[];
  images: ComparisonImageJson[];
  /** Rate–distortion sweep (only written by `--rd` runs). */
  rd?: RdJson;
  /** Paired version A/B deltas (only written by `--versions` runs). */
  paired?: PairedJson;
}

/**
 * Paired per-image deltas against a released-tag baseline, over the same image
 * subsets as `summary`. Present only in `--versions` runs that include a tag —
 * see paired.ts for why version comparison needs paired statistics and the
 * cross-format report does not.
 */
export interface PairedJson {
  /** The released tag every candidate column is differenced against. */
  baseline: string;
  naturalAndRealistic: PairedComparison[];
  all: PairedComparison[];
  tune: PairedComparison[];
  holdout: PairedComparison[];
}
