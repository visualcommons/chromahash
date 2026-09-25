/**
 * Quality metrics via the `iqa-cli` binary (the iqa-rs crate).
 *
 * The comparison harness shells out to iqa-cli rather than reimplementing metrics,
 * so every format is scored by the same reference implementation. iqa-cli reads two
 * images from disk and prints a JSON object keyed by metric name; non-finite scores
 * (e.g. PSNR of identical images) come back as JSON `null`.
 *
 * Install with `mise run install:iqa` (or `cargo install iqa-cli`). Override the binary
 * path with the `IQA_CLI` environment variable.
 *
 * A missing or broken iqa-cli is a hard error: a report with all-null quality
 * metrics looks superficially complete but supports no conclusions, so the run
 * fails up front (`ensureIqaAvailable`) and again on any per-pair failure.
 * `--allow-missing-iqa` (see main.ts) opts into the old degrade-to-null behavior
 * for preview-only runs.
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { defaultJobs, Semaphore } from "../pool.ts";

const execFileAsync = promisify(execFile);

/** Metrics from iqa-cli. Null = not computed (too small) or non-finite. */
export interface IqaMetrics {
  /** Mean CIEDE2000 (ΔE00) color difference. Lower is better. */
  ciede2000: number | null;
  /** Classic PSNR in dB. Higher is better. */
  psnrDb: number | null;
  /** DSSIM = (1 - SSIM) / 2. Lower is better. */
  dssim: number | null;
  /** Multi-scale SSIM. Higher is better. */
  msSsim: number | null;
  /** PSNR-HVS-M in dB. Higher is better. */
  psnrHvsM: number | null;
  /** SSIMULACRA2 perceptual score (≤100). Higher is better. */
  ssimulacra2: number | null;
  /** Butteraugli distance. Lower is better. */
  butteraugli: number | null;
}

/** All-null metrics — for CSS-only formats or when iqa-cli is unavailable. */
export const NULL_IQA_METRICS: IqaMetrics = {
  ciede2000: null,
  psnrDb: null,
  dssim: null,
  msSsim: null,
  psnrHvsM: null,
  ssimulacra2: null,
  butteraugli: null,
};

const IQA_CLI = process.env.IQA_CLI ?? "iqa-cli";

/**
 * Metric-infrastructure failure (iqa-cli missing/broken). Distinct from ordinary
 * per-adapter errors so the orchestrator can abort the run instead of logging
 * and continuing with a hollow all-N/A report.
 */
export class IqaError extends Error {}

/** When true, metric failures degrade to null instead of aborting the run. */
let allowMissingIqa = false;

/**
 * The `iqa-cli --version` banner, captured by {@link ensureIqaAvailable} and
 * folded into the cache key.
 *
 * Without it, upgrading iqa-cli serves scores computed by the *old* binary out
 * of the cache indefinitely — the entries are keyed on pixels, and the pixels
 * did not change. That is a silent wrong answer, and the only thing that used
 * to prevent it was remembering to hand-bump {@link CACHE_VERSION}.
 */
let iqaVersion = "unknown";

/**
 * Caps concurrent `iqa-cli` processes.
 *
 * Sized lazily on first use so `--jobs` can be applied before any scoring
 * starts. This is the throttle that matters: every caller above it may fan out
 * as wide as it likes.
 */
let metricSemaphore: Semaphore | null = null;
let configuredJobs: number | null = null;

/** Set the concurrent-metric limit. Must be called before any scoring. */
export function setMetricJobs(jobs: number): void {
  configuredJobs = jobs;
  metricSemaphore = new Semaphore(jobs);
}

function semaphore(): Semaphore {
  if (!metricSemaphore) {
    metricSemaphore = new Semaphore(configuredJobs ?? defaultJobs());
  }
  return metricSemaphore;
}

/** Opt into degrade-to-null metrics (preview-only runs). */
export function setAllowMissingIqa(allow: boolean): void {
  allowMissingIqa = allow;
}

/**
 * Fail fast when iqa-cli is not runnable. Called once at startup so a run
 * never silently produces an all-N/A report.
 */
export function ensureIqaAvailable(): void {
  if (allowMissingIqa) return;
  try {
    iqaVersion = execFileSync(IQA_CLI, ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch (err) {
    const reason =
      err instanceof Error
        ? (err.message.split("\n")[0] ?? err.message)
        : String(err);
    throw new IqaError(
      `iqa-cli is not available (${reason}). Quality metrics are required for a meaningful report — install with \`mise run install:iqa\` or set IQA_CLI, or pass --allow-missing-iqa for a preview-only run with N/A metrics.`,
    );
  }
}

/**
 * The `iqa-cli --version` banner every committed result and the metric
 * reference test are held to. The version `mise run install:iqa` and
 * `ci-comparison.yml` install; bump all three together, re-record the results,
 * and re-record the golden pair (`metric-reference-test.ts --update`).
 */
export const PINNED_IQA_CLI = "iqa-cli 1.2.1";

/**
 * The `iqa-cli --version` banner {@link ensureIqaAvailable} captured, for a
 * result's provenance. "unknown" until that has run.
 */
export function iqaVersionBanner(): string {
  return iqaVersion;
}

/**
 * Whether the metric cache is consulted and written. `CHROMAHASH_METRIC_CACHE=off`
 * turns it off for a run that must score every pair afresh: a determinism check
 * whose second run is served from the first run's cache compares the cache with
 * itself.
 */
const cacheEnabled = process.env.CHROMAHASH_METRIC_CACHE !== "off";

/**
 * iqa-cli aborts the entire run if any requested metric errors, and several metrics
 * reject images below a minimum side length. Request only the metrics valid for these
 * dimensions; ciede2000/psnr (the primary + reference) work at any size.
 */
function metricsForDims(
  width: number,
  height: number,
  only?: readonly string[],
): string[] {
  const minSide = Math.min(width, height);
  const metrics = ["ciede2000", "psnr"];
  if (minSide >= 8) metrics.push("ssimulacra2", "psnr-hvs-m", "butteraugli");
  if (minSide >= 11) metrics.push("dssim", "ms-ssim");
  // A caller that needs one metric should not pay for SSIMULACRA2 and
  // Butteraugli, which dominate the cost at 512px (vendored C++ in iqa-cli).
  return only ? metrics.filter((m) => only.includes(m)) : metrics;
}

let warned = false;
function warnUnavailable(reason: string): void {
  if (warned) return;
  warned = true;
  console.warn(
    `  iqa-cli unavailable (${reason}); quality metrics will be N/A. Install with \`mise run install:iqa\` or set IQA_CLI.`,
  );
}

type IqaJson = Record<string, number | null>;

/**
 * Content-addressed metric memo cache. iqa-cli at display resolution dominates
 * a run's wall clock (and sweeps re-score unchanged pairs constantly); results
 * are pure functions of the two pixel buffers, so cache them by content hash.
 * Lives under output/.metric-cache/ (gitignored with the rest of output/).
 */
const CACHE_DIR = path.resolve(
  import.meta.dirname,
  "../../output/.metric-cache",
);
let cacheDirReady = false;

/**
 * Bumped whenever the shape or meaning of a cached entry changes. It is part of
 * the key, so a bump invalidates rather than reinterprets: an entry written
 * before a field existed would otherwise deserialize with that field
 * `undefined`, and the cache-hit path below returns the parsed object directly
 * without passing it through `numOrNull`. That `undefined` survives into the
 * report — `JSON.stringify` drops the key and `avgMetric`'s `Number.isFinite`
 * filter silently excludes it — so a developer with a warm cache would get a
 * different report than CI, with nothing to indicate why.
 */
const CACHE_VERSION = 1;

function cacheKey(
  refRgba: Uint8Array,
  distRgba: Uint8Array,
  width: number,
  height: number,
  metrics: readonly string[],
): string {
  return (
    createHash("sha256")
      // The requested metric set is part of the key. Two callers can now ask for
      // different metrics over the same pair of buffers, and without this a
      // cached one-metric result would be served to a caller that asked for all
      // seven -- with the six it never requested reading as null.
      // The iqa-cli identity is part of the key too — see `iqaVersion`. Pixels
      // alone do not determine the score; the binary that reads them does.
      .update(
        `v${CACHE_VERSION}:${iqaVersion}:${width}x${height}:${[...metrics].sort().join(",")}:`,
      )
      .update(refRgba)
      .update(":")
      .update(distRgba)
      .digest("hex")
  );
}

/**
 * Every field of {@link IqaMetrics} must be present and be a number or null.
 * A partial entry is treated as a miss and recomputed — see {@link CACHE_VERSION}
 * for why a missing field must never be allowed through.
 */
function isCachedMetrics(v: unknown): v is IqaMetrics {
  if (typeof v !== "object" || v === null) return false;
  const rec = v as Record<string, unknown>;
  return Object.keys(NULL_IQA_METRICS).every((k) => {
    const f = rec[k];
    return f === null || typeof f === "number";
  });
}

function cacheRead(key: string): IqaMetrics | null {
  if (!cacheEnabled) return null;
  try {
    const raw = readFileSync(path.join(CACHE_DIR, `${key}.json`), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isCachedMetrics(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write an entry atomically: a full write to a unique temp name in the same
 * directory, then `rename`, which is atomic on POSIX.
 *
 * With scoring now fanned out, several workers can land on the same key at the
 * same time. A plain `writeFileSync` to the final path lets a concurrent reader
 * observe a half-written file. That fails safe today — `JSON.parse` throws and
 * `cacheRead` degrades it to a miss — but it costs a recompute for no reason,
 * and "fails safe by accident" is not a property worth relying on.
 */
function cacheWrite(key: string, metrics: IqaMetrics): void {
  if (!cacheEnabled) return;
  try {
    if (!cacheDirReady) {
      mkdirSync(CACHE_DIR, { recursive: true });
      cacheDirReady = true;
    }
    const final = path.join(CACHE_DIR, `${key}.json`);
    const tmp = `${final}.${process.pid}.${cacheWriteCounter++}.tmp`;
    writeFileSync(tmp, JSON.stringify(metrics));
    renameSync(tmp, final);
  } catch {
    // Cache writes are best-effort; a failed write only costs a recompute.
  }
}

let cacheWriteCounter = 0;

/**
 * One `iqa-cli` invocation, gated by {@link metricSemaphore}.
 *
 * Async rather than `execFileSync` deliberately: the synchronous form blocks
 * the event loop outright, so no amount of `Promise.all` above this function
 * bought any concurrency at all.
 */
async function runIqa(
  refPath: string,
  distPath: string,
  metrics: string[],
): Promise<IqaJson> {
  const { stdout } = await semaphore().run(() =>
    execFileAsync(
      IQA_CLI,
      [
        "--reference",
        refPath,
        "--distorted",
        distPath,
        "--format",
        "json",
        "--metric",
        metrics.join(","),
      ],
      { encoding: "utf8", timeout: 60_000 },
    ),
  );
  return JSON.parse(stdout) as IqaJson;
}

async function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

async function writePng(
  rgba: Uint8Array,
  width: number,
  height: number,
  file: string,
): Promise<void> {
  writeFileSync(file, await encodePng(rgba, width, height));
}

/**
 * Memoized PNG encode for the reference side.
 *
 * On a miss the reference is re-encoded for every pair — every format column
 * and every candidate of the codec byte-target search, ~52 identical 512 px
 * PNG encodes per image. The distorted side differs every time and is not
 * cached. Keyed on buffer identity, which `flattenReference` in `../metrics.ts`
 * is what makes stable.
 */
const referencePngs = new WeakMap<Uint8Array, Map<string, Buffer>>();

async function writeReferencePng(
  rgba: Uint8Array,
  width: number,
  height: number,
  file: string,
): Promise<void> {
  let perBuffer = referencePngs.get(rgba);
  if (!perBuffer) {
    perBuffer = new Map();
    referencePngs.set(rgba, perBuffer);
  }
  const key = `${width}x${height}`;
  let png = perBuffer.get(key);
  if (!png) {
    png = await encodePng(rgba, width, height);
    perBuffer.set(key, png);
  }
  writeFileSync(file, png);
}

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Compute iqa-cli quality metrics between two RGBA buffers of identical dimensions.
 * Throws on failure unless `setAllowMissingIqa(true)` opted into null degradation.
 */
export async function computeIqaMetrics(
  refRgba: Uint8Array,
  distRgba: Uint8Array,
  width: number,
  height: number,
  /** Restrict to this subset of metric names; omit for every valid metric. */
  only?: readonly string[],
): Promise<IqaMetrics> {
  const requested = metricsForDims(width, height, only);
  if (requested.length === 0) {
    // All-null here would be indistinguishable from a real measurement in the
    // report. A caller asking for a metric set that resolves to nothing at
    // these dimensions has a bug; say so rather than emitting a hollow row.
    throw new IqaError(
      `no requested metric is valid at ${width}x${height} (asked for ${only?.join(",") ?? "the default set"}).`,
    );
  }
  const key = cacheKey(refRgba, distRgba, width, height, requested);
  const cached = cacheRead(key);
  if (cached) return cached;

  const dir = mkdtempSync(path.join(tmpdir(), "chromahash-iqa-"));
  const refPath = path.join(dir, "ref.png");
  const distPath = path.join(dir, "dist.png");

  try {
    await writeReferencePng(refRgba, width, height, refPath);
    await writePng(distRgba, width, height, distPath);

    let json: IqaJson;
    // Which set actually produced `json`. The fallback path below yields fewer
    // metrics than were asked for, and the entry must be keyed on what it
    // contains — see the `cacheWrite` at the end of this function.
    let produced: readonly string[] = requested;
    try {
      json = await runIqa(refPath, distPath, requested);
    } catch {
      // A metric we believed valid still errored — fall back to the always-safe
      // pair so the primary CIEDE2000 metric survives.
      const reduced = requested.filter(
        (m) => m === "ciede2000" || m === "psnr",
      );
      try {
        if (reduced.length === 0 || reduced.length === requested.length) {
          // Nothing left to fall back to; re-run so the catch below reports the
          // real reason rather than an empty --metric list.
          throw new Error(`no reduced metric set available for ${requested}`);
        }
        json = await runIqa(refPath, distPath, reduced);
        produced = reduced;
      } catch (err) {
        const reason =
          err instanceof Error
            ? (err.message.split("\n")[0] ?? err.message)
            : String(err);
        if (!allowMissingIqa) {
          throw new IqaError(
            `iqa-cli failed for a ${width}×${height} pair (${reason}). Pass --allow-missing-iqa to degrade metrics to N/A instead.`,
          );
        }
        warnUnavailable(reason);
        return { ...NULL_IQA_METRICS };
      }
    }

    const metrics: IqaMetrics = {
      ciede2000: numOrNull(json.ciede2000),
      psnrDb: numOrNull(json.psnr),
      dssim: numOrNull(json.dssim),
      msSsim: numOrNull(json["ms-ssim"]),
      psnrHvsM: numOrNull(json["psnr-hvs-m"]),
      ssimulacra2: numOrNull(json.ssimulacra2),
      butteraugli: numOrNull(json.butteraugli),
    };
    // Key the entry on the set that actually produced it, not the set that was
    // asked for. Writing a reduced fallback under the full set's key made one
    // transient iqa-cli failure permanent: every later run hit the cache and
    // read the four missing metrics as null, and `avgMetric` silently drops
    // non-finite values, so the columns just narrowed with nothing to say why.
    cacheWrite(
      produced === requested
        ? key
        : cacheKey(refRgba, distRgba, width, height, produced),
      metrics,
    );
    return metrics;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
