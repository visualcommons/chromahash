/**
 * The committed record of a sweep or rd-budget run, and the provenance that
 * makes it auditable.
 *
 * `spec/EXPERIMENTS.md` is transcribed from these runs, and until this module
 * their output lived only under the gitignored `output/sweeps/`. No arm the
 * document cites could be checked from the repository, `verify:experiments`
 * could not run in CI, and a file on one machine said nothing about which
 * build, which corpus or which metric binary produced it.
 *
 * So a full run now writes a compact result to `tools/comparison/results/`,
 * which is committed. It keeps two things:
 *
 * - **Per-image arrays, and nothing derived from them.** A mean, a median, a
 *   Δ%, a paired interval or a guard verdict is a function of these arrays,
 *   and storing one beside its inputs is storing a second copy that can
 *   disagree with the first. Every consumer recomputes them here, through
 *   {@link summarize}, with the same folds `sweep.ts` prints its table with.
 * - **Provenance.** The git revision and whether the tree was dirty, the
 *   SHA-256 of every corpus image scored, the `iqa-cli` version banner, the
 *   SHA-256 of the config (or of the effective arguments), and the SHA-256 of
 *   every encoder binary the run shelled out to (the Rust encoder, and
 *   rd-budget's system `cjxl`/`djxl` when its JXL baseline runs).
 *
 * A run restricted with `--max-images` is not a result -- its means are over a
 * different corpus -- and is written to `output/sweeps/` instead, where the
 * scratch runs have always gone.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ALPHA_IMAGES } from "./alpha-images.ts";
import { GRAPHIC_IMAGES } from "./graphic-images.ts";
import { KODAK_SHA256 } from "./holdout-images.ts";
import { CURATED_IMAGES } from "./natural-images.ts";
import { quantile } from "./stats.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/** Where committed results live. */
export const RESULTS_DIR = path.join(REPO_ROOT, "tools/comparison/results");

/** Where scratch runs go: a `--max-images` run is not a result. */
export const SCRATCH_DIR = path.join(
  REPO_ROOT,
  "tools/comparison/output/sweeps",
);

/**
 * Bumped when the shape of a result file changes. A reader refuses a version
 * it does not know rather than reading a renamed field as absent.
 */
export const RESULT_SCHEMA = 1;

/** Lowercase hex SHA-256. */
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ─── Aggregation ────────────────────────────────────────────────────────────
//
// The folds every table is computed with. `sweep.ts` prints its decision table
// through these and `verify-experiments.ts` re-derives the committed means
// through them, so the two cannot drift: there is one definition.

/** Mean of the finite, non-null values, or null when there are none. */
export function mean(values: readonly (number | null)[]): number | null {
  const xs = values.filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  return xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
}

/** Median of the finite, non-null values, or null when there are none. */
export function median(values: readonly (number | null)[]): number | null {
  const xs = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  return xs.length > 0 ? quantile(xs, 0.5) : null;
}

// ─── Guards ─────────────────────────────────────────────────────────────────
//
// The guard verdict, defined once. `sweep.ts` prints it and
// `verify-experiments.ts` checks the document's `ok`/`FAIL` column against it;
// a second copy in each was only held together by a stored `guardsOk` the
// verifier compared against, and a result no longer stores anything derived.

/** The metrics a guard reads, as both sweep rows and summarized rows carry them. */
export interface GuardedMetrics {
  meanSsimulacra2: number | null;
  meanButteraugli: number | null;
  meanDssim: number | null;
  meanRinging: number | null;
  meanSpurious: number | null;
}

/** Tolerances a run applies, recorded in its settings. */
export interface GuardTolerances {
  /** Absolute SSIMULACRA2 drop allowed. */
  ssimulacra2Drop: number;
  /** Relative Butteraugli / DSSIM rise allowed. */
  relativeRise: number;
}

/**
 * Absolute allowance, in 8-bit levels, when an artifact guard's incumbent scores
 * exactly zero. One level is the dead zone both artifact metrics already apply
 * per pixel and per frequency, so anything at or below it is noise by their own
 * definition.
 */
export const ARTIFACT_ZERO_BASE_ALLOWANCE = 1.0;

/**
 * True when `value` is no more than `rise` above `base`, relatively.
 *
 * A null on either side passes: the metric was not scored, and a sweep that did
 * not ask for it must not fail on it. (A config that declares the tolerance and
 * forgets `artifacts` would therefore gate nothing at all, silently — so
 * `sweep.ts` rejects that combination at load.)
 *
 * A base of exactly zero cannot be compared relatively: any positive value is an
 * infinite rise, which would fail every arm on a corpus where the incumbent
 * happens to be artifact-free. It falls back to an absolute allowance of
 * {@link ARTIFACT_ZERO_BASE_ALLOWANCE} levels rather than reusing `rise`, which
 * is a *fraction* and would otherwise be read as a level count -- 0.02 levels is
 * far below the metrics' own one-level dead zone and would fail an arm for
 * noise.
 */
export function roseNoMoreThan(
  value: number | null,
  base: number | null,
  rise: number,
): boolean {
  if (value === null || base === null) return true;
  if (base === 0) return value <= ARTIFACT_ZERO_BASE_ALLOWANCE;
  return value <= base * (1 + rise);
}

/**
 * Whether `row` holds every guard against the incumbent `base`: SSIMULACRA2 may
 * drop by an absolute amount, Butteraugli and DSSIM may rise by a fraction, and
 * -- only where the run declared `artifactGuardRise` -- ringing and spurious
 * detail may rise by that fraction.
 */
export function guardsHold(
  row: GuardedMetrics,
  base: GuardedMetrics,
  tol: GuardTolerances,
  artifactRise: number | undefined,
): boolean {
  const ssim2Ok =
    row.meanSsimulacra2 === null ||
    base.meanSsimulacra2 === null ||
    row.meanSsimulacra2 >= base.meanSsimulacra2 - tol.ssimulacra2Drop;
  const butterOk =
    row.meanButteraugli === null ||
    base.meanButteraugli === null ||
    row.meanButteraugli <= base.meanButteraugli * (1 + tol.relativeRise);
  const dssimOk =
    row.meanDssim === null ||
    base.meanDssim === null ||
    row.meanDssim <= base.meanDssim * (1 + tol.relativeRise);
  const artifactOk =
    artifactRise === undefined ||
    (roseNoMoreThan(row.meanRinging, base.meanRinging, artifactRise) &&
      roseNoMoreThan(row.meanSpurious, base.meanSpurious, artifactRise));
  return ssim2Ok && butterOk && dssimOk && artifactOk;
}

// ─── Provenance ─────────────────────────────────────────────────────────────

/** One image a run scored, and the digest of the exact file it read. */
export interface CorpusEntry {
  name: string;
  sha256: string;
}

export interface Provenance {
  /** `git rev-parse HEAD` at the start of the run, or null outside a repo. */
  rev: string | null;
  /**
   * Whether the working tree differed from `rev` at the start of the run,
   * other than under `tools/comparison/results/` (a batch of runs writes there
   * as it goes, and a result cannot be an input to the run that writes it).
   * Null when git could not be asked.
   */
  dirty: boolean | null;
  /** The paths that made the tree dirty, so a dirty run says what it ran. */
  dirtyPaths: string[];
  /** `iqa-cli --version`, the binary every metric but the local ones came from. */
  iqaCli: string;
  /** Repo-relative path of the config, or the tool name for rd-budget. */
  config: string;
  /** SHA-256 of the config file's bytes, or of rd-budget's effective arguments. */
  configSha256: string;
  /**
   * Path → SHA-256 of every encoder binary the run executed: repo-relative for
   * a binary built in the tree, absolute for a system tool resolved from PATH
   * (rd-budget's `cjxl`/`djxl`). `missing` when the file could not be read.
   */
  binaries: Record<string, string>;
  /** `process.version`. */
  node: string;
  /** Library versions a codec baseline depends on (rd-budget's sharp), if any. */
  codecs?: Record<string, string>;
  /** Every image scored, in the order of the per-image arrays. */
  corpus: CorpusEntry[];
}

/**
 * Raw stdout of a git command, or null when git cannot answer. Not trimmed:
 * porcelain status lines start with a status column that may be a space, and
 * trimming the whole output ate the first path's first character.
 */
function git(args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Repo-relative path, for a record that must read the same on any machine. */
export function repoRelative(p: string): string {
  return path.relative(REPO_ROOT, path.resolve(p)).split(path.sep).join("/");
}

/** SHA-256 of a file, or null when it does not exist. */
export function fileSha256(p: string): string | null {
  return existsSync(p) ? sha256(readFileSync(p)) : null;
}

/**
 * Capture everything but the corpus, which the caller hashes as it loads.
 *
 * Taken once, at the start of a run: a tree edited while a sweep is scoring is
 * a real hazard on a long run, and the start is the state the encoder binary
 * was built from.
 */
export function captureProvenance(opts: {
  config: string;
  configSha256: string;
  iqaCli: string;
  binaries: readonly string[];
  codecs?: Record<string, string>;
}): Omit<Provenance, "corpus"> {
  const rev = git(["rev-parse", "HEAD"])?.trim() ?? null;
  const status =
    rev === null
      ? null
      : git([
          "status",
          "--porcelain=v1",
          "--untracked-files=normal",
          "--",
          ".",
          ":(exclude)tools/comparison/results",
        ]);
  const dirtyPaths =
    status === null
      ? []
      : status
          .split("\n")
          .filter((l) => l.length > 3)
          .map((l) => l.slice(3));
  const binaries: Record<string, string> = {};
  for (const b of opts.binaries) {
    const rel = repoRelative(b);
    const key = rel.startsWith("../") ? path.resolve(b) : rel;
    binaries[key] = fileSha256(b) ?? "missing";
  }
  return {
    rev,
    dirty: status === null ? null : dirtyPaths.length > 0,
    dirtyPaths,
    iqaCli: opts.iqaCli,
    config: opts.config,
    configSha256: opts.configSha256,
    binaries,
    node: process.version,
    ...(opts.codecs ? { codecs: opts.codecs } : {}),
  };
}

// ─── The committed shape ────────────────────────────────────────────────────

/**
 * The per-image series a sweep row can carry. A key is **absent** when the run
 * did not measure it, never an array of nulls, so "not measured" cannot be
 * read as "measured as nothing".
 */
export const PER_IMAGE_KEYS = [
  "bytes",
  "ciede2000",
  "ssimulacra2",
  "butteraugli",
  "dssim",
  "alphaMae",
  "ringing",
  "spurious",
  "spuriousVertical",
  "spuriousHorizontal",
  "spuriousDiagonal",
  "deficit",
  "spuriousGrid",
] as const;
export type PerImageKey = (typeof PER_IMAGE_KEYS)[number];
export type PerImage = Partial<Record<PerImageKey, (number | null)[]>>;

/** One arm of a result: what it ran, and what it scored per image. */
export interface ResultRow {
  label: string;
  /** rd-budget's format family ("ChromaHash", "WebP", ...); absent for sweeps. */
  family?: string;
  /** rd-budget's requested byte budget, or null for a fixed-rate format. */
  targetBytes?: number | null;
  tune: string | null;
  tier: number | null;
  version: string | null;
  perImage: PerImage;
}

export interface ResultFile {
  schema: number;
  tool: "sweep" | "rd-budget";
  name: string;
  split: string;
  /**
   * The run's settings: everything that decides what a number means but is not
   * itself a measurement (corpus, backdrops, guard tolerances, budgets).
   */
  settings: Record<string, unknown>;
  provenance: Provenance;
  /** Image names, in the order of every per-image array. */
  imageNames: string[];
  rows: ResultRow[];
}

/** Drop a series that measured nothing, so its absence says so. */
export function perImageOf(
  series: Partial<Record<PerImageKey, (number | null)[]>>,
): PerImage {
  const out: PerImage = {};
  for (const key of PER_IMAGE_KEYS) {
    const s = series[key];
    if (s?.some((v) => v !== null)) out[key] = s;
  }
  return out;
}

/**
 * Serialize with every array of numbers on one line.
 *
 * `JSON.stringify(_, null, 2)` puts each number on its own line, which makes a
 * 31-image row 31 lines and the committed directory several times larger than
 * its content; one line per series keeps a re-run's diff readable as "this
 * arm's ΔE00 series changed". Numbers are written by `JSON.stringify` itself,
 * the shortest string that round-trips, so no precision is lost.
 */
export function serializeResult(file: ResultFile): string {
  const walk = (value: unknown, indent: string): string => {
    if (Array.isArray(value)) {
      if (value.every((v) => v === null || typeof v !== "object")) {
        return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
      }
      const inner = `${indent}  `;
      return `[\n${value.map((v) => `${inner}${walk(v, inner)}`).join(",\n")}\n${indent}]`;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return "{}";
      const inner = `${indent}  `;
      return `{\n${entries
        .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${walk(v, inner)}`)
        .join(",\n")}\n${indent}}`;
    }
    return JSON.stringify(value);
  };
  return `${walk(file, "")}\n`;
}

/** Path a result of `name` on `split` is committed at. */
export function resultPath(dir: string, name: string): string {
  return path.join(dir, `${name}.json`);
}

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * A row with its aggregates derived, in the shape every consumer reads: the
 * means `sweep.ts` prints, the per-image ΔE00 series paired statistics run on,
 * and the image names that series is aligned with.
 */
export interface SummarizedRow {
  label: string;
  family: string | null;
  targetBytes: number | null;
  tune: string | null;
  tier: number | null;
  version: string | null;
  /** Images this row actually scored (non-null ΔE00). */
  images: number;
  bytes: number | null;
  meanCiede: number | null;
  medianCiede: number | null;
  meanSsimulacra2: number | null;
  meanButteraugli: number | null;
  meanDssim: number | null;
  meanAlphaMae: number | null;
  meanRinging: number | null;
  meanSpurious: number | null;
  meanDeficit: number | null;
  perImageCiede: (number | null)[];
  perImageSpurious: (number | null)[] | null;
  perImageDeficit: (number | null)[] | null;
  perImageRinging: (number | null)[] | null;
  perImageSpuriousGrid: (number | null)[] | null;
  imageNames: string[];
}

/** Derive a row's aggregates from its per-image series. */
export function summarize(row: ResultRow, imageNames: string[]): SummarizedRow {
  const p = row.perImage;
  const ciede = p.ciede2000 ?? imageNames.map(() => null);
  return {
    label: row.label,
    family: row.family ?? null,
    targetBytes: row.targetBytes ?? null,
    tune: row.tune,
    tier: row.tier,
    version: row.version,
    images: ciede.filter((v) => v !== null).length,
    bytes: p.bytes ? mean(p.bytes) : null,
    meanCiede: mean(ciede),
    medianCiede: median(ciede),
    meanSsimulacra2: p.ssimulacra2 ? mean(p.ssimulacra2) : null,
    meanButteraugli: p.butteraugli ? mean(p.butteraugli) : null,
    meanDssim: p.dssim ? mean(p.dssim) : null,
    meanAlphaMae: p.alphaMae ? mean(p.alphaMae) : null,
    meanRinging: p.ringing ? mean(p.ringing) : null,
    meanSpurious: p.spurious ? mean(p.spurious) : null,
    meanDeficit: p.deficit ? mean(p.deficit) : null,
    perImageCiede: ciede,
    perImageSpurious: p.spurious ?? null,
    perImageDeficit: p.deficit ?? null,
    perImageRinging: p.ringing ?? null,
    perImageSpuriousGrid: p.spuriousGrid ?? null,
    imageNames,
  };
}

/**
 * Structural problems with a parsed result, or an empty list. Everything a
 * reader would otherwise have to trust: the schema, and that every series is
 * exactly as long as the image list it claims to be aligned with.
 */
export function shapeProblems(file: ResultFile): string[] {
  const out: string[] = [];
  if (file.schema !== RESULT_SCHEMA) {
    out.push(`schema ${file.schema}, this reader knows ${RESULT_SCHEMA}`);
    return out;
  }
  const n = file.imageNames.length;
  if (file.provenance.corpus.length !== n) {
    out.push(
      `provenance lists ${file.provenance.corpus.length} corpus digests for ${n} images`,
    );
  }
  for (const [i, entry] of file.provenance.corpus.entries()) {
    if (entry.name !== file.imageNames[i]) {
      out.push(
        `corpus digest ${i} is for "${entry.name}", image ${i} is "${file.imageNames[i]}"`,
      );
      break;
    }
  }
  for (const row of file.rows) {
    if (!row.perImage.ciede2000) {
      out.push(`row "${row.label}" carries no ciede2000 series`);
    }
    for (const [key, series] of Object.entries(row.perImage)) {
      if (series && series.length !== n) {
        out.push(
          `row "${row.label}" ${key} has ${series.length} values for ${n} images`,
        );
      }
    }
  }
  return out;
}

/**
 * The digest every downloaded corpus image is pinned to, by image name.
 *
 * Generated fixtures (the synthetic set) have no pin: they are produced by
 * `generate-fixtures.ts` at the recorded revision, and their digests are
 * recorded but can only be compared across results, not against a table.
 */
export function corpusPins(): Map<string, string> {
  const pins = new Map<string, string>();
  for (const s of [...CURATED_IMAGES, ...ALPHA_IMAGES, ...GRAPHIC_IMAGES]) {
    pins.set(s.label, s.sha256);
  }
  for (const [i, digest] of KODAK_SHA256.entries()) {
    pins.set(`kodak${String(i + 1).padStart(2, "0")}`, digest);
  }
  return pins;
}

/** Read a result file, or null when there is none. Throws on a malformed one. */
export function readResult(dir: string, name: string): ResultFile | null {
  const p = resultPath(dir, name);
  if (!existsSync(p)) return null;
  const file = JSON.parse(readFileSync(p, "utf8")) as ResultFile;
  const problems = shapeProblems(file);
  if (problems.length > 0) {
    throw new Error(
      `${repoRelative(p)} is malformed:\n  ${problems.join("\n  ")}`,
    );
  }
  return file;
}
