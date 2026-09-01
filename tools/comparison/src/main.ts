import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { glob } from "node:fs/promises";
import { ChromaHashAdapter } from "./adapters/chromahash.ts";
import { ThumbHashAdapter } from "./adapters/thumbhash.ts";
import { BlurHashAdapter } from "./adapters/blurhash.ts";
import { LqipModernAdapter } from "./adapters/lqip-modern.ts";
import { UnpicAdapter } from "./adapters/unpic.ts";
import {
  prepareVersionBinaries,
  type VersionBinary,
} from "./version-builds.ts";
import {
  loadImage,
  REFERENCE_CAP,
  rgbaToDataUri,
  fileBufferToDisplayDataUri,
  writeImageFile,
} from "./image-loader.ts";
import { buildHarnesses, runAllHarnesses } from "./harness-runner.ts";
import {
  ensureIqaAvailable,
  IqaError,
  setAllowMissingIqa,
  setMetricJobs,
} from "./metrics/iqa.ts";
import {
  ALPHA_BACKDROP,
  BLUR_SIGMA_RULE,
  setScoringConfig,
} from "./metrics.ts";
import type { UpscalePolicy } from "./upscale.ts";
import {
  generateReport,
  categorizeImage,
  computeFormatStats,
  FORMAT_NAMES,
  LANGUAGES,
  PHOTO_CATEGORIES,
} from "./report.ts";
import type { ReportMeta } from "./report.ts";
import { generateFixtures } from "./generate-fixtures.ts";
import { ensureNaturalImages } from "./natural-images.ts";
import { ensureHoldoutImages } from "./holdout-images.ts";
import { CodecThumbAdapter } from "./adapters/codec-thumb.ts";
import {
  ALL_TIERS,
  buildRdLineup,
  chromaHashLabel,
  CODEC_FLOOR_BYTES,
  DEFAULT_TIER,
  type RdVariant,
  TIER_BYTES,
} from "./rd/lineup.ts";
import { computeRdCurves, generateRdSection } from "./rd/report.ts";
import { splitFor, tierFor } from "./corpus.ts";
import { defaultJobs, mapConcurrent } from "./pool.ts";
import { aspectFidelity, REFLOW_CONTAINER_PX } from "./aspect.ts";
import {
  computePairedComparisons,
  formatPairedTable,
  pickVersionBaseline,
} from "./paired.ts";
import { ensureGamutReferenceBuilt, gamutToSrgbReference } from "./gamut.ts";
import type {
  ComparisonImageJson,
  ComparisonJson,
  FormatAdapter,
  FormatJson,
  FormatResult,
  HarnessResult,
  ImageCategory,
  ImplementationJson,
} from "./types.ts";

const { values } = parseArgs({
  options: {
    images: { type: "string", default: "fixtures/**/*.{png,jpg}" },
    // No parseArgs default: the code-level default below picks the report name so
    // version mode can fall back to versions-report.html instead of clobbering it.
    output: { type: "string" },
    json: { type: "string" },
    "skip-harnesses": { type: "boolean", default: false },
    "generate-fixtures": { type: "boolean", default: true },
    "skip-natural": { type: "boolean", default: false },
    // Skip downloading the Kodak holdout suite (mirrors --skip-natural; the
    // holdout images live in fixtures/holdout/ and are cached the same way).
    "skip-holdout": { type: "boolean", default: false },
    // Preview-only escape hatch: metrics degrade to N/A instead of failing the
    // run when iqa-cli is unavailable. Never use for published comparisons.
    "allow-missing-iqa": { type: "boolean", default: false },
    // How decodes are brought to display resolution for scoring:
    // "browser" (gamma-space Mitchell, models what a browser shows — primary)
    // or "linear" (linear-light Lanczos-3, signal-processing-correct).
    "upscale-policy": { type: "string", default: "browser" },
    // Also score both sides after a Gaussian blur (sigma = longEdge/32),
    // modeling the blur-up presentation placeholders are displayed with.
    "blurred-scoring": { type: "boolean", default: true },
    // Blur recovery is on by default: an LQIP is normally displayed with a
    // blur-up, so "how much of this error survives the blur" is part of what a
    // reader is choosing between. The blurred pass requests ΔE00 alone, so it
    // costs a fraction of the sharp set rather than doubling it.
    "no-blurred-scoring": { type: "boolean", default: false },
    // Skip the locally-computed artifact metrics (metrics/local.ts and
    // metrics/spurious.ts). They cost no subprocess but do cost CPU per pair;
    // a preview-only run can drop them.
    "no-artifacts": { type: "boolean", default: false },
    formats: { type: "string" },
    versions: { type: "string" },
    commit: { type: "string" },
    // Rate–distortion mode: sweep every format's quality knob on the
    // photographic corpus and chart quality vs bytes (see rd/lineup.ts).
    rd: { type: "boolean", default: false },
    "skip-codecs": { type: "boolean", default: false },
    // Concurrent images, and the cap on concurrent iqa-cli processes.
    // `--jobs 1` is exact serial execution and is the reference the
    // determinism self-test compares a parallel run against.
    jobs: { type: "string" },
  },
});

const imagesGlob = values.images ?? "fixtures/**/*.{png,jpg}";
const rdMode = values.rd ?? false;
if (rdMode && values.versions) {
  console.error("--rd and --versions are mutually exclusive.");
  process.exit(1);
}
// Each mode gets its own default report name so runs never clobber each other.
const outputPath =
  values.output ??
  (rdMode
    ? "output/rd-report.html"
    : values.versions
      ? "output/versions-report.html"
      : "output/report.html");
// Version-comparison mode compares chromahash builds only, and R-D mode sweeps
// format variants, so the cross-language harness verification is irrelevant in
// both and is always skipped.
const skipHarnesses =
  (values["skip-harnesses"] ?? false) || Boolean(values.versions) || rdMode;
const shouldGenerateFixtures = values["generate-fixtures"] ?? true;
const skipNatural = values["skip-natural"] ?? false;
const skipHoldout = values["skip-holdout"] ?? false;
/** Upscale policy: "browser" → gamma-space Mitchell, "linear" → linear-light Lanczos-3. */
const upscalePolicy: UpscalePolicy =
  (values["upscale-policy"] ?? "browser") === "linear"
    ? "linear-lanczos"
    : "browser-gamma";
const blurredScoring =
  (values["blurred-scoring"] ?? true) &&
  !(values["no-blurred-scoring"] ?? false);
const artifacts = !(values["no-artifacts"] ?? false);
/** Optional comma-separated format filter (case-insensitive), e.g. --formats ChromaHash,ThumbHash. */
const formatFilter = values.formats
  ? values.formats.split(",").map((f) => f.trim().toLowerCase())
  : null;
/** Optional chromahash version list, e.g. --versions v0.2,v0.3,v0.4,v0.5,current. */
const versionList = values.versions
  ? values.versions
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  : null;

/** Derive the JSON output path from the HTML output path by swapping the extension. */
function deriveJsonPath(htmlPath: string): string {
  const ext = path.extname(htmlPath);
  return `${htmlPath.slice(0, htmlPath.length - ext.length)}.json`;
}

const jsonPath = values.json ?? deriveJsonPath(outputPath);

/** Make a filesystem- and URL-safe slug for image file names. */
function slugify(value: string): string {
  return value.replace(/#/g, "sharp").replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Hex-encode a hash (empty input -> empty string). */
function toHex(bytes: Uint8Array): string {
  return bytes.length > 0 ? Buffer.from(bytes).toString("hex") : "";
}

/**
 * Resolve the source commit the report is built from: an explicit --commit flag,
 * the CI-provided GITHUB_SHA, then a local `git rev-parse HEAD`, else null.
 */
function resolveCommit(toolRoot: string): string | null {
  if (values.commit) return values.commit;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: toolRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

/** Base repo URL from CI env (used to link the footer commit), else null. */
function resolveRepoUrl(): string | null {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  return server && repo ? `${server}/${repo}` : null;
}

/**
 * Label for the working-tree ("current") build in the version report: the short
 * commit plus a dirty marker, e.g. `current (a1b2c3d, dirty)`. This is the primary
 * variant — it's what the report exists to evaluate against the released tags.
 */
function currentVariantLabel(toolRoot: string): string {
  const git = (args: string[]): string => {
    try {
      return execFileSync("git", args, {
        cwd: toolRoot,
        encoding: "utf8",
      }).trim();
    } catch {
      return "";
    }
  };
  const short = git(["rev-parse", "--short", "HEAD"]) || "unknown";
  const dirty = git(["status", "--porcelain"]).length > 0;
  return `current (${short}${dirty ? ", dirty" : ""})`;
}

/** Order version builds for display: current (primary) first, then tags descending. */
function orderVersions(bins: VersionBinary[]): VersionBinary[] {
  const current = bins.filter((b) => b.version === "current");
  const tags = bins
    .filter((b) => b.version !== "current")
    .sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    );
  return [...current, ...tags];
}

async function main(): Promise<void> {
  const toolRoot = path.resolve(import.meta.dirname, "..");

  // Fail fast if quality metrics can't be computed — an all-N/A report looks
  // complete but supports no conclusions (this happened: see commit history).
  setAllowMissingIqa(values["allow-missing-iqa"] ?? false);
  ensureIqaAvailable();

  setScoringConfig({ upscalePolicy, blurredScoring, artifacts });

  // Fan-out width. Scoring is dominated by iqa-cli subprocesses and sharp
  // encodes, so the default is one worker per available core; --jobs 1 restores
  // exact serial execution.
  const jobs = (() => {
    const raw = values.jobs;
    if (raw === undefined) return defaultJobs();
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error(`--jobs ${raw} is not a positive integer.`);
      process.exit(1);
    }
    return parsed;
  })();
  setMetricJobs(jobs);
  console.log(
    `Scoring: reference cap ${REFERENCE_CAP}px, upscale=${upscalePolicy}${blurredScoring ? ", blurred set enabled" : ""}`,
  );

  // Generate synthetic fixtures if needed
  if (shouldGenerateFixtures) {
    const syntheticDir = path.join(toolRoot, "fixtures/synthetic");
    try {
      const files = await fs.readdir(syntheticDir);
      if (files.length === 0) {
        await generateFixtures();
      }
    } catch {
      await generateFixtures();
    }
  }

  // Fetch natural images from Picsum (on-demand with local cache). Both
  // fetchers are content-pinned and throw on a mismatch or a network failure
  // rather than returning a short list — scoring a partial corpus would move
  // every mean in the report without saying so.
  if (!skipNatural) {
    console.log("Ensuring natural images are cached...");
    const naturalPaths = await ensureNaturalImages();
    console.log(`${naturalPaths.length} natural image(s) available.`);
  }

  // Fetch the Kodak holdout suite (on-demand with local cache)
  if (!skipHoldout) {
    console.log("Ensuring holdout images are cached...");
    const holdoutPaths = await ensureHoldoutImages();
    console.log(`${holdoutPaths.length} holdout image(s) available.`);
  }

  // Find all image files
  const resolvedGlob = path.resolve(toolRoot, imagesGlob);
  let imagePaths: string[] = [];
  for await (const entry of glob(resolvedGlob)) {
    if (entry.endsWith(".png") || entry.endsWith(".jpg")) {
      imagePaths.push(entry);
    }
  }
  imagePaths.sort();

  // R-D mode answers "which format wins at equal byte cost" for real
  // photographs — synthetic fixture categories would only add noise, so the
  // sweep processes the photo-class categories only.
  if (rdMode) {
    imagePaths = imagePaths.filter((p) =>
      PHOTO_CATEGORIES.includes(categorizeImage(path.basename(p))),
    );
  }

  if (imagePaths.length === 0) {
    console.error(
      `No ${rdMode ? "photographic " : ""}images found matching: ${resolvedGlob}`,
    );
    process.exit(1);
  }

  console.log(`Found ${imagePaths.length} images.`);

  // Build all harness binaries once. A harness whose build fails is recorded
  // here and skipped below, rather than being invoked once per image.
  let unavailableHarnesses: ReadonlySet<string> = new Set<string>();
  if (!skipHarnesses) {
    console.log("Building harnesses...");
    unavailableHarnesses = buildHarnesses();
    console.log("Harnesses built.");
  }

  // Initialize adapters. In version-comparison mode every "format" column is a
  // chromahash build (one per version, each round-tripping with its own binary);
  // otherwise it's the cross-format LQIP line-up.
  let adapters: FormatAdapter[];
  let activeFormatNames: string[];
  // chromahash quality tier (0..=4, ordered by quality) for the ChromaHash column, from the
  // environment so `CHROMAHASH_TIER=2 mise run compare` evaluates a higher-fidelity
  // build under a more generous size budget (the encoded-bytes column shows the
  // size–quality trade-off). Matches the encode_stdin / benchmark convention.
  const chromaTier = Number.parseInt(
    process.env.CHROMAHASH_TIER ?? String(DEFAULT_TIER),
    10,
  );
  if (!Number.isInteger(chromaTier) || !TIER_BYTES.has(chromaTier)) {
    console.error(
      `CHROMAHASH_TIER=${process.env.CHROMAHASH_TIER} is not a valid tier code (0..=4).`,
    );
    process.exit(1);
  }
  if (chromaTier !== DEFAULT_TIER) {
    console.log(`ChromaHash quality tier: ${chromaTier}`);
  }
  // R-D variant lineup (null outside --rd mode); kept for curve aggregation.
  let rdVariants: RdVariant[] | null = null;
  if (rdMode) {
    rdVariants = buildRdLineup();
    adapters = rdVariants.map((v) => v.adapter);
    activeFormatNames = adapters.map((a) => a.name);
    const families = [...new Set(rdVariants.map((v) => v.family))];
    console.log(
      `R-D lineup: ${adapters.length} variants across ${families.length} families (${families.join(", ")})`,
    );
  } else if (versionList) {
    // Quality tiers are a v1 feature: released tags have no tier API, and the
    // decode shim they are built with ignores CHROMAHASH_TIER. Honouring the
    // tier for `current` alone would put (say) a 411-byte column beside a
    // 32-byte one in a table captioned "version comparison" — the reader would
    // score a 3x byte increase as a quality win. Refuse instead of misleading.
    const taggedVersions = versionList.filter((v) => v !== "current");
    if (chromaTier !== DEFAULT_TIER && taggedVersions.length > 0) {
      console.error(
        `CHROMAHASH_TIER=${chromaTier} cannot be applied to released tags (${taggedVersions.join(", ")}): quality tiers are a v1 feature, so those columns would stay at 32 bytes while "current" grew, and the comparison would no longer be equal-budget.\nEither drop CHROMAHASH_TIER to compare at 32 bytes, or pass --versions current to sweep the working tree's tiers on their own.`,
      );
      process.exit(1);
    }
    console.log("Preparing chromahash version binaries...");
    const bins = orderVersions(prepareVersionBinaries(versionList));
    adapters = bins.map(
      (b) =>
        new ChromaHashAdapter({
          name:
            b.version === "current" ? currentVariantLabel(toolRoot) : b.version,
          binaryPath: b.binaryPath,
          // Decode uncapped so every version is framed identically (the oldest
          // tags lack capped decode); metrics resample to source regardless.
          capToSource: false,
          tier: chromaTier,
        }),
    );
    if (adapters.length === 0) {
      console.error("No version binaries were built; nothing to compare.");
      process.exit(1);
    }
    activeFormatNames = adapters.map((a) => a.name);
    console.log(`Version comparison: ${activeFormatNames.join(", ")}`);
  } else {
    // Every shipped tier, smallest first. A single column could only ever
    // answer "how does ChromaHash compare at one budget"; the format's whole
    // proposition is the range, and at 32 B against ThumbHash's ~21 the single
    // column was not even the size-matched comparison.
    adapters = [
      ...ALL_TIERS.map(
        (tier) => new ChromaHashAdapter({ name: chromaHashLabel(tier), tier }),
      ),
      // The same 32 bytes, rendered at the reference raster instead of decoded
      // at 32 px and enlarged by the shared upscale. An extra operating point,
      // not a replacement: the row above it is the one that is comparable to
      // every other format, because every other format goes through that same
      // resampler and most of them have no choice.
      //
      // It is here rather than behind a flag because the question it answers is
      // one a reader asks by looking: the previews in this report are decodes at
      // their native raster, magnified by the browser, and "is that texture the
      // format or the magnification?" cannot be answered from them alone. This
      // row is the other half of that comparison. It is deliberately NOT in
      // rd/lineup.ts, so rd-budget and the R-D gate are untouched.
      new ChromaHashAdapter({
        name: `${chromaHashLabel(DEFAULT_TIER)} native render`,
        tier: DEFAULT_TIER,
        renderAtReference: true,
      }),
      new ThumbHashAdapter(),
      new BlurHashAdapter(),
      new LqipModernAdapter(),
      new UnpicAdapter(),
    ];
    // Size-matched real codecs. The interesting comparison for this format is
    // not only against other LQIPs but against what a general codec does with
    // the same number of bytes, and that was previously visible only in `--rd`.
    if (!(values["skip-codecs"] ?? false)) {
      // No general codec reaches the two smallest tiers — AVIF's floor is
      // ~470 B against 21 and 32 — so there the honest row is the codec's
      // smallest possible output, labelled as such. That floor encode does not
      // depend on the target, so both tiers share ONE pair rather than getting
      // a byte-identical pair each (which would also collide on the name
      // "WebP (min)", and duplicate names silently corrupt computeFormatStats).
      // From the first reachable budget up, each tier gets a genuine
      // equal-budget pair.
      const anchors = ALL_TIERS.map((t) => TIER_BYTES.get(t) ?? 0);
      const smallest = anchors[0] ?? 32;
      for (const codec of ["webp", "avif"] as const) {
        adapters.push(new CodecThumbAdapter(codec, smallest, true));
        const floor = CODEC_FLOOR_BYTES.get(codec) ?? 128;
        for (const anchor of anchors.filter((bytes) => bytes >= floor)) {
          adapters.push(new CodecThumbAdapter(codec, anchor, false));
        }
      }
    }
    if (formatFilter) {
      // Prefix match so `--formats chromahash` still selects the whole tier
      // ladder now that the adapters are named "ChromaHash t0".."t4".
      adapters = adapters.filter((a) => {
        const name = a.name.toLowerCase();
        return formatFilter.some((f) => name === f || name.startsWith(`${f} `));
      });
      if (adapters.length === 0) {
        console.error(`--formats matched no adapters: ${values.formats}`);
        process.exit(1);
      }
      console.log(
        `Format filter active: ${adapters.map((a) => a.name).join(", ")}`,
      );
    }
    // FORMAT_NAMES fixes the canonical column order; anything not in it (the
    // byte-targeted codec adapters, whose names carry their budget) is appended
    // rather than filtered away, which would silently drop it from every table.
    const known = FORMAT_NAMES.filter((n) =>
      adapters.some((a) => a.name === n),
    );
    const extra = adapters
      .map((a) => a.name)
      .filter((n) => !FORMAT_NAMES.includes(n));
    activeFormatNames = [...known, ...extra];
  }

  interface Entry {
    name: string;
    category: ImageCategory;
    originalWidth: number;
    originalHeight: number;
    smallWidth: number;
    smallHeight: number;
    originalDataUri: string;
    loResDataUri: string;
    formatResults: FormatResult[];
    harnessResults: HarnessResult[];
  }

  // Force the wide-gamut shim's build before fanning out: `ensureBuilt` is a
  // check-then-act around a `cargo build`, so concurrent first-callers would
  // each launch one. Only gamut fixtures reach it, so only pay for it if the
  // corpus actually has one.
  if (imagePaths.some((p) => path.basename(p).startsWith("gamut-"))) {
    ensureGamutReferenceBuilt();
  }

  // Images are independent, so they are scored concurrently. `mapConcurrent`
  // places results by index rather than pushing on completion, which is what
  // keeps every downstream mean bit-identical to a serial run — see pool.ts.
  //
  // The real throttle is the semaphore around iqa-cli, not this width; going
  // wider here only keeps that semaphore fed while an image is busy encoding.
  let done = 0;
  const entries: Entry[] = await mapConcurrent(
    imagePaths,
    jobs,
    async (imagePath): Promise<Entry> => {
      const fileName = path.basename(imagePath);
      const name = fileName.replace(/\.[^.]+$/, "");
      const category = categorizeImage(fileName);

      const input = await loadImage(imagePath);

      // Determine gamut from filename (used by both adapters and harnesses)
      const gamutMap: Record<string, string> = {
        "gamut-srgb": "srgb",
        "gamut-p3": "displayp3",
        "gamut-adobe-rgb": "adobergb",
        "gamut-bt2020": "bt2020",
        "gamut-prophoto": "prophoto",
      };
      const gamut = gamutMap[name] ?? "srgb";
      input.gamut = gamut;
      // Color-managed metric reference: all formats are scored against the
      // image's true sRGB appearance at display (reference) resolution, not the
      // raw gamut-encoded bytes.
      input.metricReferenceRgba = gamutToSrgbReference(
        input.referenceRgba,
        gamut,
      );
      // The report previews stay at encoder-input resolution; gamut fixtures
      // need their own small-res sRGB conversion for display.
      const displaySmallRgba = gamutToSrgbReference(input.smallRgba, gamut);

      // Gamut fixtures store raw bytes tagged with a wide gamut and carry no ICC
      // profile, so rendering them as plain sRGB misrepresents the source (#39).
      // For Display P3 — a real, ICC-taggable display gamut — show the *source*
      // P3 bytes tagged with the P3 profile, so on a wide-gamut viewer the Original
      // and the (P3-decoded, P3-tagged) ChromaHash preview both show the true
      // saturated color and match, while sRGB-only formats look less saturated.
      // Other wide gamuts (Adobe RGB / BT.2020 / ProPhoto) aren't P3-taggable and
      // fall back to the color-managed sRGB appearance.
      const colorManaged = gamut !== "srgb";
      const p3 = gamut === "displayp3";
      const previewIcc = p3 ? "p3" : undefined;
      // P3: the raw source bytes are already P3-encoded — tag, don't convert.
      const displayRgba = p3 ? input.smallRgba : displaySmallRgba;
      const originalDataUri = colorManaged
        ? await rgbaToDataUri(
            displayRgba,
            input.smallWidth,
            input.smallHeight,
            previewIcc,
          )
        : await fileBufferToDisplayDataUri(input.fileBuffer);
      const loResDataUri = await rgbaToDataUri(
        colorManaged ? displayRgba : input.smallRgba,
        input.smallWidth,
        input.smallHeight,
        previewIcc,
      );

      // Run format adapters
      const formatResults: FormatResult[] = [];
      for (const adapter of adapters) {
        try {
          const result = await adapter.process(input);
          formatResults.push(result);
        } catch (err) {
          // Metric-infrastructure failures abort the whole run — a report where
          // one format silently lost its metrics is not a comparison.
          if (err instanceof IqaError) throw err;
          console.warn(
            `  ${adapter.name} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // Run cross-language harnesses (if not skipped)
      let harnessResults: HarnessResult[] = [];
      if (!skipHarnesses) {
        try {
          harnessResults = await runAllHarnesses(
            input,
            gamut,
            unavailableHarnesses,
          );
        } catch (err) {
          console.warn(
            `  Harness runner failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      console.log(`[${++done}/${imagePaths.length}] ${name} (${category})`);

      return {
        name,
        category,
        originalWidth: input.originalWidth,
        originalHeight: input.originalHeight,
        smallWidth: input.smallWidth,
        smallHeight: input.smallHeight,
        originalDataUri,
        loResDataUri,
        formatResults,
        harnessResults,
      };
    },
  );

  const absOutput = path.resolve(toolRoot, outputPath);
  const absJson = path.resolve(toolRoot, jsonPath);
  const meta: ReportMeta = {
    commit: resolveCommit(toolRoot),
    repoUrl: resolveRepoUrl(),
    generatedAt: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
  };

  // Materialize every image as a standalone file under <output dir>/images/, and
  // rewrite each entry's inline data URIs to relative paths so the HTML and JSON
  // both reference the same assets. The directory is recreated each run so no
  // stale images linger. R-D mode uses its own subdirectory so an --rd run never
  // wipes the standard report's assets (both default into output/).
  const imagesSubdir = rdMode ? "rd-images" : "images";
  const imagesDir = path.join(path.dirname(absOutput), imagesSubdir);
  await fs.rm(imagesDir, { recursive: true, force: true });
  await fs.mkdir(imagesDir, { recursive: true });

  const jsonImages: ComparisonImageJson[] = [];
  for (const entry of entries) {
    const base = slugify(entry.name);

    const [originalFile, inputFile] = await Promise.all([
      writeImageFile(entry.originalDataUri, imagesDir, `${base}__original`),
      writeImageFile(entry.loResDataUri, imagesDir, `${base}__input`),
    ]);
    entry.originalDataUri = `${imagesSubdir}/${originalFile.fileName}`;
    entry.loResDataUri = `${imagesSubdir}/${inputFile.fileName}`;

    const formats: FormatJson[] = await Promise.all(
      entry.formatResults.map(async (r): Promise<FormatJson> => {
        let preview: string | null = null;
        let css: string | null = null;
        if (r.dataUri.startsWith("css:")) {
          // CSS-only formats (e.g. unpic) keep their sentinel; no file is written.
          css = r.dataUri.slice(4);
        } else if (r.dataUri) {
          const file = await writeImageFile(
            r.dataUri,
            imagesDir,
            `${base}__fmt-${slugify(r.formatName)}`,
          );
          preview = `${imagesSubdir}/${file.fileName}`;
          r.dataUri = preview;
        }
        return {
          formatName: r.formatName,
          encodedSizeBytes: r.encodedSizeBytes,
          decodedWidth: r.decodedWidth,
          decodedHeight: r.decodedHeight,
          preview,
          css,
          metrics: r.metrics,
          metricsBlurred: r.metricsBlurred,
          local: r.local,
          intrinsicSize: r.intrinsicSize,
          // Scored against the ORIGINAL: that is the shape which eventually
          // loads, so it is the shape the layout shift is felt against. The
          // harness's own <=100px encoder input contributes a little of this
          // (~0.5%), reported separately rather than netted out -- see
          // aspect.ts and `encoderInputFloor`.
          aspect: aspectFidelity(
            r.intrinsicSize,
            entry.originalWidth,
            entry.originalHeight,
          ),
        };
      }),
    );

    const implementations: ImplementationJson[] = await Promise.all(
      entry.harnessResults.map(async (r): Promise<ImplementationJson> => {
        let preview: string | null = null;
        if (r.dataUri) {
          const file = await writeImageFile(
            r.dataUri,
            imagesDir,
            `${base}__lang-${slugify(r.language)}`,
          );
          preview = `${imagesSubdir}/${file.fileName}`;
          r.dataUri = preview;
        }
        return {
          language: r.language,
          hash: toHex(r.hash),
          matches: r.matches,
          error: r.error,
          preview,
        };
      }),
    );

    jsonImages.push({
      name: entry.name,
      category: entry.category,
      split: splitFor(entry.name),
      tier: tierFor(entry.name),
      originalWidth: entry.originalWidth,
      originalHeight: entry.originalHeight,
      original: entry.originalDataUri,
      encoderInput: entry.loResDataUri,
      encoderInputWidth: entry.smallWidth,
      encoderInputHeight: entry.smallHeight,
      formats,
      implementations,
    });
  }

  // Summary stats are reused by both the JSON output and the console summary.
  const naturalStats = computeFormatStats(entries, activeFormatNames, (e) =>
    PHOTO_CATEGORIES.includes(e.category),
  );
  const allStats = computeFormatStats(entries, activeFormatNames);
  // Tune/holdout split summaries so sweep tooling can compare generalization
  // without re-deriving the split (see corpus.ts).
  const tuneStats = computeFormatStats(
    entries,
    activeFormatNames,
    (e) => splitFor(e.name) === "tune",
  );
  const holdoutStats = computeFormatStats(
    entries,
    activeFormatNames,
    (e) => splitFor(e.name) === "holdout",
  );

  // Paired A/B deltas against the newest released tag. Version mode is the only
  // controlled experiment the harness runs — same images, same scoring, one
  // variable — and unpaired CIs cannot resolve the differences it produces
  // (see paired.ts). Null when the lineup carries no tag to difference against.
  const pairedBaseline = versionList
    ? pickVersionBaseline(activeFormatNames)
    : null;
  const pairedFor = (filter?: (e: (typeof entries)[number]) => boolean) =>
    pairedBaseline
      ? computePairedComparisons(
          filter ? entries.filter(filter) : entries,
          pairedBaseline,
          activeFormatNames,
        )
      : [];
  const paired = pairedBaseline
    ? {
        baseline: pairedBaseline,
        naturalAndRealistic: pairedFor((e) =>
          PHOTO_CATEGORIES.includes(e.category),
        ),
        all: pairedFor(),
        tune: pairedFor((e) => splitFor(e.name) === "tune"),
        holdout: pairedFor((e) => splitFor(e.name) === "holdout"),
      }
    : null;

  const harnessesSkipped = entries.every((e) => e.harnessResults.length === 0);
  const crossLanguage = LANGUAGES.map((language) => {
    if (harnessesSkipped) return { language, pass: null as boolean | null };
    // A language that produced no result anywhere was never run at all — its
    // harness could not be built. That is "unavailable", not a parity failure,
    // and reporting it as FAIL asserts a byte mismatch that was never observed.
    //
    // A harness that built and then *crashed* is the same kind of absent
    // verdict: it produced no hash, so it neither matched nor disagreed. Only
    // an observed byte difference is a FAIL.
    const observed = entries.flatMap((e) =>
      e.harnessResults.filter(
        (r) => r.language === language && r.error === null,
      ),
    );
    if (observed.length === 0)
      return { language, pass: null as boolean | null };
    const pass = observed.every((r) => r.matches);
    return { language, pass };
  });

  // R-D aggregation: per-family curves of per-variant means (see rd/report.ts).
  const rdJson = rdVariants ? computeRdCurves(entries, rdVariants) : null;

  const json: ComparisonJson = {
    schemaVersion: 5,
    generatedAt: meta.generatedAt,
    scoring: {
      referenceCap: REFERENCE_CAP,
      upscalePolicy,
      blurredScoring,
      blurSigmaRule: BLUR_SIGMA_RULE,
      alphaBackdrop: ALPHA_BACKDROP,
      reflowContainerPx: REFLOW_CONTAINER_PX,
      artifacts,
    },
    commit: meta.commit,
    repoUrl: meta.repoUrl,
    formats: activeFormatNames,
    languages: LANGUAGES,
    summary: {
      naturalAndRealistic: naturalStats,
      all: allStats,
      tune: tuneStats,
      holdout: holdoutStats,
    },
    crossLanguage,
    images: jsonImages,
    ...(rdJson ? { rd: rdJson } : {}),
    ...(paired ? { paired } : {}),
  };
  await fs.mkdir(path.dirname(absJson), { recursive: true });
  await fs.writeFile(absJson, `${JSON.stringify(json, null, 2)}\n`);

  // Render the HTML report (now referencing the standalone images by path).
  // R-D and version modes both narrow the format columns to their own lineup
  // and hide the (skipped) cross-language tab; R-D additionally injects the
  // rate–distortion charts and anchor table at the top.
  const html = generateReport(
    entries,
    meta,
    rdJson
      ? {
          formatNames: activeFormatNames,
          showImplementations: false,
          preludeHtml: generateRdSection(rdJson, entries.length),
        }
      : versionList
        ? {
            formatNames: activeFormatNames,
            showImplementations: false,
            paired: paired !== null,
          }
        : // The standard report used to fall through to FORMAT_NAMES, so the
          // size-matched WebP/AVIF columns appeared in the galleries and in the
          // console summary but in none of the HTML tables. They are the most
          // useful comparison a reader has -- "how does this compare with just
          // shipping a tiny WebP?" -- and they are already computed.
          { formatNames: activeFormatNames },
  );
  await fs.writeFile(absOutput, html);

  const link = (p: string) => `\x1b]8;;file://${p}\x1b\\${p}\x1b]8;;\x1b\\`;
  console.log(`\nReport written to: ${link(absOutput)}`);
  console.log(`JSON written to:   ${link(absJson)}`);
  console.log(`Images written to: ${link(imagesDir)}/`);

  // Print expanded metric summary
  const cell = (v: number | null, digits: number, width: number): string =>
    (v !== null ? v.toFixed(digits) : "N/A").padStart(width);

  const printSummary = (
    label: string,
    stats: ReturnType<typeof computeFormatStats>,
  ) => {
    console.log(`\n=== Format Summary (${label}) ===`);
    console.log(
      `  ${"Format".padEnd(16)} ${"Size(B)".padStart(8)} ${"ΔE00".padStart(8)} ${"MedΔE00".padStart(8)} ${"DSSIM".padStart(8)} ${"MS-SSIM".padStart(8)} ${"SSIM2".padStart(8)} ${"Butter".padStart(8)} ${"PSNR(dB)".padStart(9)}`,
    );
    for (const s of stats) {
      console.log(
        `  ${s.name.padEnd(16)} ${s.avgSize.toFixed(0).padStart(8)} ${cell(s.avgCiede, 2, 8)} ${cell(s.medianCiede, 2, 8)} ${cell(s.avgDssim, 4, 8)} ${cell(s.avgMsSsim, 4, 8)} ${cell(s.avgSsimulacra2, 1, 8)} ${cell(s.avgButteraugli, 2, 8)} ${cell(s.avgPsnr, 1, 9)}`,
      );
    }
  };

  printSummary("Natural Images Only", naturalStats);
  printSummary("All Images", allStats);

  // Paired A/B is the conclusion of a version run, so it prints last — the
  // holdout block is the honest number and goes closest to the prompt.
  if (paired) {
    console.log(formatPairedTable("photographic", paired.naturalAndRealistic));
    console.log(formatPairedTable("all images", paired.all));
    if (paired.holdout.length > 0) {
      console.log(formatPairedTable("HOLDOUT split", paired.holdout));
    }
  }

  if (!skipHarnesses) {
    console.log("\n=== Cross-Language Verification ===");
    const allLangs = new Set(
      entries.flatMap((e) => e.harnessResults.map((r) => r.language)),
    );
    for (const lang of allLangs) {
      const results = entries.flatMap((e) =>
        e.harnessResults.filter((r) => r.language === lang),
      );
      const observed = results.filter((r) => r.error === null);
      const errored = results.length - observed.length;
      const note = errored > 0 ? ` (${errored} image(s) errored)` : "";
      const verdict =
        observed.length === 0
          ? "N/A"
          : observed.every((r) => r.matches)
            ? "PASS"
            : "FAIL";
      console.log(`  ${lang}: ${verdict}${note}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
