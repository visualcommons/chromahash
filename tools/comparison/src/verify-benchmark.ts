/**
 * Checks the numbers in `spec/PERFORMANCE.md` against the perf runs that
 * produced them.
 *
 * The document is transcribed by hand from `mise run benchmark`, and until this
 * script existed nothing noticed when the transcription and the committed run
 * disagreed. They did, extensively: the 2026-08-29 baseline was a `bounded` run
 * taken from a dirty tree, while §2's per-tier table, §3's scaling table, §4's
 * first lever table, §5's tier-0 row and the whole of §6 quoted a `--full` run
 * that was never committed. Nine of §2's ten values disagreed with or had no
 * cell; §3's 512x512 was off by 9.6%; §6's separable-DCT table could not have
 * come from the harness at all, because no `dct_separable` arm existed in it.
 *
 * That is precisely the failure §11 indicts `spec/README` §14 for, so the
 * document had reproduced the thing it was written to correct.
 *
 * This closes the loop. Tables are parsed out of the document, so no number is
 * transcribed twice; only the *binding* — which cell a column means — is
 * written by hand below. A documented value passes when it equals the cell
 * value rounded to the precision the document itself uses, so the check is
 * exact rather than tolerance-based, and tightening a figure in the document
 * tightens the assertion with it.
 *
 * Usage:
 *   node dist/verify-benchmark.js                # every bound table
 *   node dist/verify-benchmark.js --list-unbound # tables with no binding, and why
 *   node dist/verify-benchmark.js --section 7
 *   node dist/verify-benchmark.js --fix          # rewrite cells from the runs
 *
 * Exit status is non-zero on any disagreement, so `mise run verify:benchmark`
 * gates a documentation change the way `mise run rd:gate` gates a quality one.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DOC = path.join(REPO_ROOT, "spec/PERFORMANCE.md");
const BASELINE_DIR = path.join(REPO_ROOT, "tools/comparison/baselines");

/** The committed runs, in the order a lookup prefers them. */
const BASELINES = ["perf-report-full.json", "perf-report.json"] as const;

/** The run format this document's figures are defined against. */
const SCHEMA = "chromahash-perf/2";

/**
 * Two runs of the same cell agree to about this much on a quiet machine. Used
 * only to flag disagreement *between* the committed runs, never to accept a
 * documented number — those are checked exactly.
 */
const CROSS_RUN_TOLERANCE = 0.1;

// ─── The document, as tables ────────────────────────────────────────────────

interface DocTable {
  section: string;
  index: number;
  line: number;
  header: string[];
  rows: string[][];
  /** Source line of each row, parallel to `rows`, for --fix. */
  rowLines: number[];
}

const clean = (s: string): string => s.replace(/[*`]/g, "").trim();

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isSeparator = (line: string): boolean =>
  /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-");

function parseTables(markdown: string): DocTable[] {
  const lines = markdown.split("\n");
  const tables: DocTable[] = [];
  let section = "0";
  let indexInSection = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = /^#{2,3}\s+([0-9]+(?:\.[0-9]+)?)[.\s]/.exec(line);
    if (heading?.[1]) {
      section = heading[1];
      indexInSection = 0;
      continue;
    }
    if (!line.trimStart().startsWith("|")) continue;
    if (!isSeparator(lines[i + 1] ?? "")) continue;

    const header = cells(line);
    const rows: string[][] = [];
    const rowLines: number[] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const body = lines[j] ?? "";
      if (!body.trimStart().startsWith("|")) break;
      rows.push(cells(body));
      rowLines.push(j);
    }
    tables.push({
      section,
      index: indexInSection++,
      line: i + 1,
      header,
      rows,
      rowLines,
    });
    i = j - 1;
  }
  return tables;
}

// ─── A documented number ────────────────────────────────────────────────────

type Unit = "us" | "ms" | "s" | "ratio" | "percent";

interface DocNumber {
  value: number;
  unit: Unit;
  /** Decimal places the document used, which is the precision it is held to. */
  decimals: number;
}

/**
 * A bound cell whose number has not been measured yet. Written into the
 * document as TBD so a rewrite can land with its tables bound but its figures
 * pending; the gate fails on it, so the document cannot be published in that
 * state. `--fix` against a committed run replaces them.
 */
const PLACEHOLDER = "TBD";

/**
 * Read a placeholder's intended format. Written as "TBD ms", "TBD µs", "TBD×"
 * or "TBD%", so a rewrite knows the unit the column is in; the decimals default
 * to what the document uses for that unit elsewhere.
 */
function parsePlaceholder(raw: string): DocNumber | null {
  const text = clean(raw).replace(/\*\*/g, "").trim();
  const m = /^TBD\s*(µs|us|ms|s|×|x|%)?$/i.exec(text);
  if (!m) return null;
  const suffix = m[1];
  const unit: Unit =
    suffix === "ms"
      ? "ms"
      : suffix === "s"
        ? "s"
        : suffix === "%"
          ? "percent"
          : suffix === "×" || suffix === "x"
            ? "ratio"
            : suffix === undefined
              ? "ratio"
              : "us";
  const decimals = unit === "us" ? 0 : unit === "percent" ? 1 : 2;
  return { value: Number.NaN, unit, decimals };
}

/**
 * Read one table cell as a number. Markdown emphasis, thousands separators and
 * the unicode minus all appear in the document and none of them are data.
 * Returns null for a cell that is deliberately not a measurement — an em dash,
 * a "not measured", a prose note.
 */
function parseDocNumber(raw: string): DocNumber | null {
  const text = raw
    .replace(/\*\*/g, "")
    .replace(/[*_`]/g, "")
    .replace(/−/g, "-")
    .replace(/,/g, "")
    .trim();
  const m = /^(-?[0-9]+(?:\.[0-9]+)?)\s*(µs|us|ms|s|×|x|%)?$/.exec(text);
  if (!m?.[1]) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = m[2];
  const unit: Unit =
    suffix === "µs" || suffix === "us"
      ? "us"
      : suffix === "ms"
        ? "ms"
        : suffix === "s"
          ? "s"
          : suffix === "%"
            ? "percent"
            : suffix === "×" || suffix === "x"
              ? "ratio"
              : "ratio";
  const dot = m[1].indexOf(".");
  return { value, unit, decimals: dot < 0 ? 0 : m[1].length - dot - 1 };
}

/**
 * Read a cell that declares a target this run cannot reach — "*macOS only*".
 *
 * A token rather than free prose, and asserted rather than tolerated, because
 * the alternative is what this gate shipped with: the unavailable-target skip
 * sat *below* `if (!doc) continue`, so a prose cell exited before ever reaching
 * it and the branch was live only for the one case that must never take it — a
 * documented *number* on a target no committed run measured. Fabricated Swift
 * figures passed, and the run said "Every bound value in PERFORMANCE.md agrees
 * with a committed run".
 *
 * The shape is "<host or toolchain> only", which is what §0's disclosure table
 * already writes and what PERFORMANCE.md:55 already says is written instead of
 * `TBD`: these rows are not pending anybody's run. Asserting the shape is what
 * separates a deliberate marker from a typo, an emptied cell, or a sentence
 * that used to be a number.
 *
 * Two constraints, both because the first version of this was
 * `^[A-Za-z][A-Za-z0-9 .+#-]* only$` against the de-emphasised text, which
 * matches any English phrase ending in "only". Every bound column of every
 * bound table runs through here, so an ordinary prose cell — "encoder only",
 * "batch only" — became a hard failure with a message about committed runs
 * that had nothing to do with it.
 *
 *  1. The emphasis is part of the marker. §0 and §7/§8 write `*macOS only*`,
 *     and the failure message tells an author to write exactly that. A bare
 *     phrase is prose.
 *  2. The qualifier must name a platform this repo builds for, from the list
 *     below. A marker says "no run on this host can fill this cell"; only a
 *     host can make that true, and the vocabulary for hosts is closed.
 */
const MARKER_PLATFORMS = [
  "macOS",
  "Linux",
  "Windows",
  "iOS",
  "Android",
  "arm64",
  "aarch64",
  "x86_64",
  "wasm",
] as const;

const MARKER_RE = new RegExp(
  `^\\*(?:\\*)?(${MARKER_PLATFORMS.join("|")}) only(?:\\*)?\\*$`,
);

function parseUnavailableMarker(raw: string): string | null {
  // The raw cell, not `clean(raw)` — `clean` strips the emphasis that
  // constraint 1 depends on.
  const m = MARKER_RE.exec(raw.trim());
  return m?.[1] ? `${m[1]} only` : null;
}

const TIME_UNITS = new Set<Unit>(["us", "ms", "s"]);
const PER_US: Record<string, number> = { us: 1, ms: 1e3, s: 1e6 };

// ─── The committed runs ─────────────────────────────────────────────────────

interface Cell {
  id: string;
  /** chromahash-perf/2. Older runs reported the median as the headline. */
  nsPerOp?: number;
  medianNsPerOp: number;
  iqrPct: number;
  noisy: boolean;
  iters: number;
}

interface RunDoc {
  file: string;
  schema: string;
  git: { commit: string; dirty: boolean };
  environment: { cpuModel: string; arch: string; cores: number };
  config: { mode: string; reps: number };
  cells: Cell[];
  /**
   * Targets the driver could not run, with the reason it recorded. Swift is the
   * permanent case: its binding consumes a UniFFI xcframework only `xcodebuild`
   * can assemble, so the row is empty on every run made off macOS.
   */
  unavailable?: { target: string; reason: string; kind?: string }[];
}

/**
 * Why a target was not measured — and whether that is a fact about the host or
 * a fact about the target.
 *
 * `probeAvailability` used to answer only "did `bench-info` succeed", and the
 * gate skipped every row of every target that answered no. A missing binary, a
 * non-zero exit, a timeout and a crash were one outcome, so on macOS a genuine
 * Swift *build regression* was indistinguishable from no `xcodebuild`, and the
 * gate would have skipped the rows in both cases, reporting green.
 *
 *  - `absent`  — the binary is not there (spawn ENOENT). Nothing on this host
 *                could have measured it. Rows are skipped.
 *  - `broken`  — it is there and it failed: non-zero exit, timeout, crash.
 *                That is a regression, not an unavailable platform, and it is
 *                reported rather than skipped.
 *  - missing   — a run recorded before this distinction existed. Not skipped:
 *                the fail-safe direction is to report, since an old run cannot
 *                say which of the two it saw.
 */
type Availability = "absent" | "broken" | "unclassified";

interface Unavailable {
  reason: string;
  kind: Availability;
}

function classify(kind: string | undefined): Availability {
  return kind === "absent" || kind === "broken" ? kind : "unclassified";
}

class Runs {
  private readonly byId = new Map<
    string,
    { us: number; cell: Cell; from: string }
  >();
  readonly loaded: RunDoc[] = [];
  /** Same id, two runs, materially different: a property of the host. */
  readonly crossRunSpread: string[] = [];
  /** Same id twice inside one run: an integrity bug in the driver. */
  readonly duplicates: string[] = [];
  readonly dirty: string[] = [];
  /** Runs rejected outright, with the reason. */
  readonly rejected: string[] = [];
  /**
   * Targets no loaded run could measure.
   *
   * A cell for one of these is not a document that has drifted and not a
   * measurement anybody forgot: it is a row this host cannot fill. Reporting it
   * as a missing cell made `verify:benchmark` unpassable on Linux — which is
   * every CI runner this job uses — and so made `continue-on-error` permanent
   * while its comment claimed it was pending a re-measurement.
   */
  readonly unavailable = new Map<string, Unavailable>();

  constructor(files: string[]) {
    for (const file of files) {
      const full = path.join(BASELINE_DIR, file);
      if (!existsSync(full)) continue;
      const doc = JSON.parse(readFileSync(full, "utf8")) as RunDoc;
      doc.file = file;

      // chromahash-perf/1 reported the median as a cell's headline figure; /2
      // reports the minimum. Binding this document to a /1 run would compare
      // numbers that do not mean the same thing, and a --fix against one would
      // quietly write medians into a document that says minima.
      if (doc.schema !== SCHEMA) {
        this.rejected.push(
          `${file}: schema ${doc.schema ?? "(none)"}, expected ${SCHEMA} — regenerate with \`mise run benchmark\``,
        );
        continue;
      }

      this.loaded.push(doc);
      if (doc.git?.dirty) this.dirty.push(file);
      for (const u of doc.unavailable ?? []) {
        const prior = this.unavailable.get(u.target);
        // A `broken` probe outranks an `absent` one: if any run got far enough
        // to see the target fail, "not built on this host" is not the story.
        if (
          !prior ||
          (prior.kind === "absent" && classify(u.kind) !== "absent")
        ) {
          this.unavailable.set(u.target, {
            reason: u.reason,
            kind: classify(u.kind),
          });
        }
      }

      const seen = new Set<string>();
      for (const c of doc.cells) {
        if (seen.has(c.id)) {
          this.duplicates.push(`${file}: duplicate cell id ${c.id}`);
          continue;
        }
        seen.add(c.id);
        const us = (c.nsPerOp ?? c.medianNsPerOp) / 1000;
        const prior = this.byId.get(c.id);
        if (!prior) {
          this.byId.set(c.id, { us, cell: c, from: file });
          continue;
        }
        const delta = Math.abs(prior.us - us) / Math.min(prior.us, us);
        if (delta > CROSS_RUN_TOLERANCE) {
          this.crossRunSpread.push(
            `${c.id}: ${prior.from} says ${prior.us.toFixed(1)} us, ` +
              `${file} says ${us.toFixed(1)} us (${(delta * 100).toFixed(1)}% apart)`,
          );
        }
      }
    }

    // "The union of what was measured wins over any single run's gap" — as a
    // second pass, over every cell of every loaded run.
    //
    // It used to run inline: a file's `unavailable` entries went in, then that
    // file's cells came out again. The result depended on the order `BASELINES`
    // lists the files. With `["perf-report-full.json", "perf-report.json"]`, a
    // target the full sweep measured and the bounded one did not was inserted
    // by the bounded run *after* the full run's cells had already been walked,
    // so it stayed marked unavailable while committed cells held it — and the
    // gate then skipped, or failed, rows it had the measurement for. That is
    // the exact shape of taking the full sweep on macOS (Swift present) and the
    // bounded one on Linux (Swift absent).
    for (const id of this.byId.keys()) {
      this.unavailable.delete(id.split("/")[1] ?? "");
    }
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Whether any committed run holds a cell for this target, at any id. */
  measuredTarget(target: string): boolean {
    for (const id of this.byId.keys()) {
      if ((id.split("/")[1] ?? "") === target) return true;
    }
    return false;
  }

  /** Median microseconds per op. Throws if the id is not in any committed run. */
  us(id: string): number {
    const hit = this.byId.get(id);
    if (!hit) throw new MissingCell(id);
    return hit.us;
  }

  cell(id: string): Cell | null {
    return this.byId.get(id)?.cell ?? null;
  }

  get ids(): string[] {
    return [...this.byId.keys()].sort();
  }
}

class MissingCell extends Error {
  constructor(readonly id: string) {
    super(`no cell "${id}" in any committed run`);
  }
}

// ─── Bindings ───────────────────────────────────────────────────────────────
//
// The one hand-written part: which cell each column of each table means. A
// resolver receives the whole row (so it can read a tier from one column and a
// size from another) and returns microseconds for a time column, or a bare
// number for a ratio or percentage. Returning null marks a cell as deliberately
// unbound — a quality figure carried from EXPERIMENTS.md, a cold-start wall
// clock the perf driver does not measure, an em dash.

/** Images per batch, matching the `bench-batch` argv the driver emits. */
const BATCH_COUNT = 200;

/** Encoded length per tier code, no alpha (spec 3.5). */
const TIER_BYTES: Record<number, number> = {
  0: 21,
  1: 32,
  2: 108,
  3: 411,
  4: 1623,
};

/** Reads a named column out of the row being checked. */
type Row = (column: string) => string;
type Resolve = (row: Row, R: Runs) => number | null;

interface Binding {
  section: string;
  index: number;
  title: string;
  /** Column header (exact) -> resolver. Unlisted columns are not checked. */
  columns: Record<string, Resolve>;
}

/**
 * A header or row label without its parenthetical aside: the document writes
 * "auto (12)" for the thread count and "shipped (scale_fit=2 ...)" for the
 * lever, and in both the parenthesis is commentary, not the name.
 */
const bare = (s: string): string =>
  clean(s)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();

/** "tier 3", "3 (archival)", "t3" -> 3 */
function tierOf(raw: string): number | null {
  const m = /^(?:tier\s*)?t?([0-4])\b/.exec(clean(raw));
  return m?.[1] ? Number.parseInt(m[1], 10) : null;
}

/** "512×512", "512x512" -> 512; non-square or unparseable -> null */
function sizeOf(raw: string): number | null {
  const m = /^([0-9]+)\s*[×x]\s*([0-9]+)$/.exec(clean(raw));
  return m?.[1] && m[1] === m[2] ? Number.parseInt(m[1], 10) : null;
}

const ratio = (slow: number, fast: number): number => slow / fast;

/** A lever's cell id, keyed by the arm label the driver records. */
const armId = (n: number, arm: string): string =>
  `encode/Rust/t1/${n}x${n}/gradient/${bare(arm)}`;

function timeOr<T>(R: Runs, id: string): number | null {
  return R.has(id) ? R.us(id) : null;
}

/**
 * §1's source, which is not a `perf/run.js` sweep.
 *
 * `benchmark:stages` runs the instrumented build and reports *shares* of one
 * encode, taken inside a single process. §1 has carried a note since it was
 * written saying it "writes no committed artifact, so this table is transcribed
 * by hand. That is a remaining gap" — and it was the worst possible table to
 * leave ungated, because it is the one that orders §10's whole roadmap.
 *
 * It is bound separately rather than folded into `Runs` because it is a
 * different measurement: a ratio within one process rather than a wall-clock
 * cell, which is also why it is readable on a host whose absolute timings would
 * not be.
 */
const STAGES_BASELINE = "perf-stages.json";
const STAGES_SCHEMA = "chromahash-perf-stages/1";

interface StageCell {
  ns: Record<string, number>;
  sharePct: Record<string, number>;
  git: { rev: string; dirty: boolean };
}

/**
 * The stages baseline, or the reason there is none.
 *
 * This returned a bare `null` for "no file" and for "wrong schema" alike, and
 * §1's resolvers turned that into `null` per cell, which `checkTable` counts as
 * `unbound` — a *pass*. Deleting `perf-stages.json` therefore produced a green
 * run for the one table this gate exists for: thirty cells silently reclassified
 * as deliberately unbound, and all thirteen `PROSE_CLAIMS` skipped along with
 * them, since both blocks are guarded by `if (STAGES)`. `Runs` has never
 * behaved that way — a missing perf report exits 1 with the command to
 * regenerate it. §1 gets the same treatment.
 */
function loadStages(): {
  cells: Record<string, StageCell> | null;
  error: string | null;
} {
  const full = path.join(BASELINE_DIR, STAGES_BASELINE);
  const where = `tools/comparison/baselines/${STAGES_BASELINE}`;
  if (!existsSync(full)) {
    return {
      cells: null,
      error: `${where} does not exist — record §1's three columns with \`mise run benchmark:stages 100 100 1\`, \`… 512 512 1\`, \`… 512 512 4\``,
    };
  }
  let doc: { schema?: string; cells?: Record<string, StageCell> };
  try {
    doc = JSON.parse(readFileSync(full, "utf8")) as typeof doc;
  } catch (e) {
    return {
      cells: null,
      error: `${where} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (doc.schema !== STAGES_SCHEMA) {
    return {
      cells: null,
      error: `${where}: schema ${doc.schema ?? "(none)"}, expected ${STAGES_SCHEMA} — re-record §1's three columns with \`mise run benchmark:stages\``,
    };
  }
  if (!doc.cells || Object.keys(doc.cells).length === 0) {
    return { cells: null, error: `${where} holds no cells` };
  }
  return { cells: doc.cells, error: null };
}

const { cells: STAGES, error: STAGES_ERROR } = loadStages();

/** §1's column headers name a fixture; map each to the recorded cell key. */
const STAGE_COLUMNS: Record<string, string> = {
  "100×100 t1": "100x100-t1",
  "512×512 t1": "512x512-t1",
  "512×512 t4": "512x512-t4",
};

/** Doc row label -> the stage the instrumented build reports it as. */
const STAGE_ROWS: Record<string, string> = {
  eotf_lut: "eotf_lut",
  linearize: "linearize",
  oklab_forward: "oklab_forward",
  alpha_average: "alpha_average",
  composite: "composite",
  selection: "selection",
  cos_tables: "cos_tables",
  dct_forward: "dct_forward",
  quantize_and_pack: "quantize_and_pack",
};

/**
 * Figures the prose derives from §1's table, bound to the same baseline.
 *
 * The table is checked cell by cell; the sentences underneath it were not, and
 * that is where §1's numbers actually drifted. "the per-pixel colour pipeline
 * is 16.6% — `linearize` 5.5%" is a sum of three cells and one of the cells,
 * and both were wrong: `linearize` measures 5.4340%, which the table two dozen
 * lines above correctly rounds to 5.4%, and the three stages sum to 16.5183%.
 * The 16.6% is what you get by rounding each part up first and adding the
 * rounded parts, and it was repeated in §10 and in the lever table, so a single
 * transcription slip became three published figures no run supports.
 *
 * A derived figure is a claim like any other. These bind the sentence to the
 * arithmetic, so restating a cell in prose is checked the same way as writing
 * it in the table.
 */
interface ProseClaim {
  what: string;
  /** Must match exactly once in the document, capturing the figure. */
  pattern: RegExp;
  /** The cell key in `perf-stages.json`. */
  cell: string;
  /** Stages to sum; a single-element list is a single cell. */
  stages: string[];
}

const PROSE_CLAIMS: ProseClaim[] = [
  {
    what: "§1: the per-pixel colour pipeline's share at 512x512 t1",
    pattern: /the per-pixel colour pipeline is ([\d.]+)%\*\* — `linearize`/,
    cell: "512x512-t1",
    stages: ["linearize", "oklab_forward", "composite"],
  },
  {
    what: "§1: `linearize`'s share, quoted in prose",
    pattern: /colour pipeline is [\d.]+%\*\* — `linearize` ([\d.]+)%/,
    cell: "512x512-t1",
    stages: ["linearize"],
  },
  {
    what: "§1: `oklab_forward`'s share, quoted in prose",
    pattern: /`oklab_forward` ([\d.]+)%, `composite`/,
    cell: "512x512-t1",
    stages: ["oklab_forward"],
  },
  {
    what: "§1: `composite`'s share, quoted in prose",
    pattern: /`oklab_forward` [\d.]+%, `composite` ([\d.]+)%/,
    cell: "512x512-t1",
    stages: ["composite"],
  },
  {
    what: "§1: `oklab_forward` as the SIMD-covered share of the budget",
    pattern: /covers ([\d.]+) points of a 100-point budget/,
    cell: "512x512-t1",
    stages: ["oklab_forward"],
  },
  {
    what: "§1: `quantize_and_pack`'s share at 100x100 t1, quoted in prose",
    pattern: /At 100×100, `quantize_and_pack` is ([\d.]+)%\*\*/,
    cell: "100x100-t1",
    stages: ["quantize_and_pack"],
  },
  {
    what: "§1: `dct_forward`'s share at 100x100 t1, quoted in prose",
    pattern: /([\d.]+)% of a 100×100\nencode/,
    cell: "100x100-t1",
    stages: ["dct_forward"],
  },
  {
    what: "§1: `dct_forward`'s share at 512x512 t4, quoted in prose",
    pattern: /and \*\*([\d.]+)%\*\* at 512×512 tier 4/,
    cell: "512x512-t4",
    stages: ["dct_forward"],
  },
  {
    what: "§12 summary: the pipeline share, restated",
    pattern: /the per-pixel colour pipeline is \*\*([\d.]+)%\*\* at 512×512/,
    cell: "512x512-t1",
    stages: ["linearize", "oklab_forward", "composite"],
  },
  {
    what: "§12 summary: `quantize_and_pack`, restated",
    pattern: /`quantize_and_pack` is \*\*([\d.]+)%\*\* of a 100×100 one/,
    cell: "100x100-t1",
    stages: ["quantize_and_pack"],
  },
  {
    what: "§12 summary: `dct_forward` at tier 4, restated",
    pattern: /encode and \*\*([\d.]+)%\*\* at tier 4/,
    cell: "512x512-t4",
    stages: ["dct_forward"],
  },
  {
    what: "§12 summary: the SIMD-covered points, restated",
    pattern: /because it covers ([\d.]+) of those points/,
    cell: "512x512-t1",
    stages: ["oklab_forward"],
  },
  {
    what: "§10 lever 6: the pipeline share, restated",
    pattern: /for a stage §1 prices at ([\d.]+)%/,
    cell: "512x512-t1",
    stages: ["linearize", "oklab_forward", "composite"],
  },
];

const BINDINGS: Binding[] = [
  {
    section: "1",
    index: 0,
    title: "Where encode time goes (shares of one encode)",
    columns: Object.fromEntries(
      Object.entries(STAGE_COLUMNS).map(([header, key]) => [
        header,
        (row: (h: string) => string) => {
          if (!STAGES) return null;
          const cell = STAGES[key];
          if (!cell) return null;
          const label = clean(row("stage"));
          // The total row is the one absolute number in the table, and it is in
          // milliseconds rather than a share.
          if (label === "total") {
            const whole = cell.ns.whole_encode;
            return whole === undefined ? null : whole / 1e3;
          }
          const stage = STAGE_ROWS[label];
          return stage === undefined ? null : (cell.sharePct[stage] ?? null);
        },
      ]),
    ) as Record<string, Resolve>,
  },

  {
    section: "2",
    index: 0,
    title: "Cost per tier (Rust, 100x100 gradient)",
    columns: {
      bytes: (row) => {
        const t = tierOf(row("tier"));
        return t === null ? null : (TIER_BYTES[t] ?? null);
      },
      encode: (row, R) => {
        const t = tierOf(row("tier"));
        return t === null ? null : R.us(`encode/Rust/t${t}/100x100/gradient`);
      },
      decode: (row, R) => {
        const t = tierOf(row("tier"));
        return t === null ? null : R.us(`decode/Rust/t${t}/natural`);
      },
    },
  },
  {
    section: "2",
    index: 1,
    title: "Capped decode against natural",
    columns: {
      natural: (row, R) => {
        const t = tierOf(row("tier"));
        return t === null ? null : R.us(`decode/Rust/t${t}/natural`);
      },
      "capped 32×32": (row, R) => {
        const t = tierOf(row("tier"));
        return t === null ? null : R.us(`decode/Rust/t${t}/capped32`);
      },
      saving: (row, R) => {
        const t = tierOf(row("tier"));
        if (t === null) return null;
        return ratio(
          R.us(`decode/Rust/t${t}/natural`),
          R.us(`decode/Rust/t${t}/capped32`),
        );
      },
    },
  },
  {
    section: "3",
    index: 0,
    title: "Encode scaling in source pixels (Rust, tier 1)",
    columns: {
      encode: (row, R) => {
        const n = sizeOf(row("source"));
        return n === null ? null : R.us(`encode/Rust/t1/${n}x${n}/gradient`);
      },
      "per megapixel": (row, R) => {
        const n = sizeOf(row("source"));
        if (n === null) return null;
        // Reported in ms per megapixel.
        return (
          R.us(`encode/Rust/t1/${n}x${n}/gradient`) / 1000 / ((n * n) / 1e6)
        );
      },
    },
  },
  {
    section: "4",
    index: 0,
    title: "Encoder-only levers at 100x100, tier 1",
    columns: {
      encode: (row, R) => timeOr(R, armId(100, row("lever"))),
      "vs shipped": (row, R) => {
        const arm = armId(100, row("lever"));
        const base = armId(100, "shipped");
        if (!R.has(arm) || !R.has(base)) return null;
        return ((R.us(arm) - R.us(base)) / R.us(base)) * 100;
      },
    },
  },
  {
    section: "4",
    index: 1,
    title: "The same levers at 100x100, 256x256 and 512x512",
    columns: {
      "100×100": (row, R) => timeOr(R, armId(100, row("lever"))),
      // The middle column was in the document and not in this map, so its eight
      // cells were never visited: not failed, not counted, not listed. The
      // driver has measured them all along. Same blindness `verify-experiments`
      // grew `--list-unbound-columns` for, one document over.
      "256×256": (row, R) => timeOr(R, armId(256, row("lever"))),
      "512×512": (row, R) => timeOr(R, armId(512, row("lever"))),
    },
  },
  {
    section: "5",
    index: 0,
    title: "The simd feature, default build against --no-default-features",
    columns: {
      SIMD: (row, R) => {
        const n = sizeOf(row("source"));
        const t = tierOf(row("tier"));
        return n === null || t === null
          ? null
          : R.us(`encode/Rust/t${t}/${n}x${n}/gradient`);
      },
      scalar: (row, R) => {
        const n = sizeOf(row("source"));
        const t = tierOf(row("tier"));
        return n === null || t === null
          ? null
          : R.us(`encode/Rust (scalar)/t${t}/${n}x${n}/gradient`);
      },
      gain: (row, R) => {
        const n = sizeOf(row("source"));
        const t = tierOf(row("tier"));
        if (n === null || t === null) return null;
        return ratio(
          R.us(`encode/Rust (scalar)/t${t}/${n}x${n}/gradient`),
          R.us(`encode/Rust/t${t}/${n}x${n}/gradient`),
        );
      },
    },
  },
  {
    section: "6",
    index: 0,
    title: "Separable forward DCT against the direct summation",
    columns: {
      "tier 1 direct": (row, R) => {
        const n = sizeOf(row("source"));
        return n === null ? null : timeOr(R, armId(n, "shipped"));
      },
      separable: (row, R) => {
        const n = sizeOf(row("source"));
        return n === null ? null : timeOr(R, armId(n, "dct_separable"));
      },
      speedup: (row, R) => {
        const n = sizeOf(row("source"));
        if (n === null) return null;
        const direct = armId(n, "shipped");
        const sep = armId(n, "dct_separable");
        if (!R.has(direct) || !R.has(sep)) return null;
        return ratio(R.us(direct), R.us(sep));
      },
    },
  },
  {
    section: "7",
    index: 0,
    title: "Cross-language, startup excluded",
    columns: {
      "encode t0": (row, R) => impl(row("implementation"), R, "encode", 0),
      "encode t1": (row, R) => impl(row("implementation"), R, "encode", 1),
      "encode t2": (row, R) => impl(row("implementation"), R, "encode", 2),
      "decode t1": (row, R) => impl(row("implementation"), R, "decode", 1),
      "decode t2": (row, R) => impl(row("implementation"), R, "decode", 2),
    },
  },
  {
    section: "8",
    index: 0,
    title: "Batch throughput and thread scaling",
    columns: {
      "1 thread": (row, R) => batch(row("implementation"), R, "1"),
      auto: (row, R) => batch(row("implementation"), R, "auto"),
      scaling: (row, R) => {
        const one = batch(row("implementation"), R, "1");
        const auto = batch(row("implementation"), R, "auto");
        return one === null || auto === null ? null : ratio(one, auto);
      },
    },
  },
];

/** Row labels in §7 and §8 are the driver's target names verbatim. */
function impl(
  raw: string,
  R: Runs,
  op: "encode" | "decode",
  tier: number,
): number | null {
  const t = clean(raw);
  const id =
    op === "encode"
      ? `encode/${t}/t${tier}/100x100/gradient`
      : `decode/${t}/t${tier}/natural`;
  return timeOr(R, id);
}

function batch(raw: string, R: Runs, threads: string): number | null {
  const id = `batch/${clean(raw)}/t1/100x100/threads=${threads}`;
  const us = timeOr(R, id);
  return us === null ? null : us / BATCH_COUNT;
}

// ─── Checking ───────────────────────────────────────────────────────────────

interface Failure {
  where: string;
  column: string;
  row: string;
  documented: string;
  measured: string;
  detail?: string;
}

/** One cell `--fix` will rewrite: line in the document, column, new text. */
interface Edit {
  line: number;
  cellIndex: number;
  text: string;
}

/**
 * A documented value passes when it equals the measured value rounded to the
 * precision the document used. Rounding rather than a tolerance means the
 * assertion tightens automatically as the document quotes more digits, and a
 * figure written to three significant digits is not held to five.
 */
function agrees(
  doc: DocNumber,
  measuredUs: number,
): { ok: boolean; shown: string } {
  const measured = TIME_UNITS.has(doc.unit)
    ? measuredUs / (PER_US[doc.unit] ?? 1)
    : measuredUs;
  const rounded = Number(measured.toFixed(doc.decimals));
  const suffix =
    doc.unit === "ratio"
      ? "×"
      : doc.unit === "percent"
        ? "%"
        : ` ${doc.unit === "us" ? "µs" : doc.unit}`;
  return {
    ok: Math.abs(rounded - doc.value) < 1e-9,
    shown: `${rounded.toFixed(doc.decimals)}${suffix}`,
  };
}

/**
 * Render a measured value the way the document writes that column: same unit,
 * same number of decimals, same emphasis. Used by --fix so a rewritten cell is
 * indistinguishable from a hand-written one.
 */
function formatLike(doc: DocNumber, measuredUs: number, raw: string): string {
  const measured = TIME_UNITS.has(doc.unit)
    ? measuredUs / (PER_US[doc.unit] ?? 1)
    : measuredUs;
  const suffix =
    doc.unit === "ratio"
      ? "×"
      : doc.unit === "percent"
        ? "%"
        : ` ${doc.unit === "us" ? "µs" : doc.unit}`;
  const body = `${measured.toFixed(doc.decimals)}${suffix}`;
  // Preserve bold emphasis, which the document uses to mark a headline figure.
  return /^\*\*.*\*\*$/.test(raw.trim()) ? `**${body}**` : body;
}

function checkTable(
  binding: Binding,
  table: DocTable,
  R: Runs,
  failures: Failure[],
  counters: {
    checked: number;
    unbound: number;
    placeholders: number;
    unavailable: number;
  },
  edits: Edit[],
): void {
  const headerIndex = new Map<string, number>();
  table.header.forEach((h, i) => {
    headerIndex.set(clean(h).toLowerCase(), i);
    headerIndex.set(bare(h).toLowerCase(), i);
  });

  const columnOf = (name: string): number | undefined =>
    headerIndex.get(name.toLowerCase()) ??
    headerIndex.get(bare(name).toLowerCase());

  table.rows.forEach((cellsOfRow, rowIdx) => {
    const row: Row = (column) => {
      const i = columnOf(column);
      return i === undefined ? "" : (cellsOfRow[i] ?? "");
    };
    const rowLabel = clean(cellsOfRow[0] ?? "");
    const sourceLine = table.rowLines[rowIdx] ?? table.line;

    for (const [column, resolve] of Object.entries(binding.columns)) {
      const i = columnOf(column);
      if (i === undefined) continue;
      const raw = cellsOfRow[i] ?? "";
      const placeholder = parsePlaceholder(raw);
      const doc = placeholder ?? parseDocNumber(raw);

      // Before `!doc`, not after. A row naming a target no committed run
      // measured is not drift and not a forgotten measurement — it is a row
      // this host cannot fill, and the document says so with a marker beside
      // it. But that is a claim about the *cell*, so the cell has to be read
      // before it can be honoured, and it was being read afterwards: a prose
      // cell left at `!doc` first and never arrived, while a cell carrying a
      // number arrived and was waved through. Exactly inverted. The only case
      // the skip actually caught was the one it must never catch.
      // `R.unavailable` is keyed on the target name the driver records, which
      // is the row label verbatim — "Rust (scalar)" included. Looking it up
      // under `bare(rowLabel)` alone stripped the parenthetical, so a
      // parenthesised target could never match its own record. Try the label as
      // written first, then bare.
      const rowLabelClean = clean(rowLabel);
      const rowTarget = R.unavailable.has(rowLabelClean)
        ? rowLabelClean
        : bare(rowLabel);
      const unavailable = R.unavailable.get(rowTarget);
      const marker = parseUnavailableMarker(raw);
      const where = `§${binding.section} ${binding.title} (line ${sourceLine})`;
      if (unavailable) {
        // Only an *absent* target may be skipped. A target that was found and
        // then failed its probe is a regression, and skipping its rows is how a
        // broken Swift build passes for "no xcodebuild".
        if (unavailable.kind !== "absent") {
          failures.push({
            where,
            column,
            row: rowLabel,
            documented: raw === "" ? "(empty)" : raw,
            measured: "—",
            detail:
              unavailable.kind === "broken"
                ? `${rowTarget}'s probe was found and failed (${unavailable.reason.split("\n")[0]}) — that is a regression in the target, not an unavailable platform, so this row is not skipped`
                : `${rowTarget} is recorded unavailable by a run made before absent/broken were distinguished, so it cannot be told apart from a build regression — regenerate the run with \`mise run benchmark\``,
          });
          continue;
        }
        if (marker) {
          counters.unavailable++;
          continue;
        }
        // No committed run holds a measurement for this target, so whatever is
        // in this cell is not backed by one — a number least of all.
        failures.push({
          where,
          column,
          row: rowLabel,
          documented: raw === "" ? "(empty)" : raw,
          measured: "—",
          detail: `no committed run measured ${rowTarget} (${unavailable.reason}), so this cell cannot be verified — write it as a marker such as "*macOS only*"`,
        });
        continue;
      }
      // And the converse. A marker on a target the committed runs *did* measure
      // is a row that has stopped describing the run behind it, which is the
      // same drift in the other direction and just as invisible.
      //
      // But only if a run measured it. The message asserts "a committed run
      // measured T" and nothing checked that: a target no run ever *probed* —
      // `--impls Rust,Go` leaves seven of them — is in neither `unavailable`
      // nor `cells`, and the gate stated a falsehood about it. Ask `R`.
      if (marker) {
        if (!R.measuredTarget(rowTarget)) {
          failures.push({
            where,
            column,
            row: rowLabel,
            documented: raw,
            measured: "—",
            detail: `cell reads "${marker}", but no committed run measured ${rowTarget} and none recorded it as unavailable either — it was never probed, so nothing here is evidence either way (was the run made with \`--impls\`?)`,
          });
          continue;
        }
        failures.push({
          where,
          column,
          row: rowLabel,
          documented: raw,
          measured: "—",
          detail: `cell reads "${marker}" but a committed run measured ${rowTarget}`,
        });
        continue;
      }
      if (!doc) continue;

      let expected: number | null;
      try {
        expected = resolve(row, R);
      } catch (e) {
        if (e instanceof MissingCell) {
          failures.push({
            where: `§${binding.section} ${binding.title} (line ${table.line})`,
            column,
            row: rowLabel,
            documented: raw,
            measured: "—",
            detail: e.message,
          });
          continue;
        }
        throw e;
      }
      if (expected === null) {
        counters.unbound++;
        continue;
      }

      // A placeholder is a bound cell whose number has not been measured yet.
      // It always fails, so a document cannot be published still carrying one,
      // and --fix knows exactly what to write in its place.
      if (placeholder) {
        counters.placeholders++;
        edits.push({
          line: sourceLine,
          cellIndex: i,
          text: formatLike(doc, expected, raw),
        });
        failures.push({
          where: `§${binding.section} ${binding.title} (line ${sourceLine})`,
          column,
          row: rowLabel,
          documented: raw,
          measured: formatLike(doc, expected, raw),
          detail: "placeholder — run with --fix against a committed run",
        });
        continue;
      }

      counters.checked++;
      const verdict = agrees(doc, expected);
      if (!verdict.ok) {
        edits.push({
          line: sourceLine,
          cellIndex: i,
          text: formatLike(doc, expected, raw),
        });
        failures.push({
          where: `§${binding.section} ${binding.title} (line ${sourceLine})`,
          column,
          row: rowLabel,
          documented: raw,
          measured: verdict.shown,
        });
      }
    }
  });
}

// ─── Entry point ────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    section: { type: "string" },
    "list-unbound": { type: "boolean", default: false },
    "list-cells": { type: "boolean", default: false },
    fix: { type: "boolean", default: false },
  },
});

const doc = readFileSync(DOC, "utf8");
const tables = parseTables(doc);

if (values["list-unbound"]) {
  console.log("Tables in PERFORMANCE.md with no binding:\n");
  for (const t of tables) {
    if (BINDINGS.some((b) => b.section === t.section && b.index === t.index)) {
      continue;
    }
    console.log(
      `  §${t.section} table ${t.index} (line ${t.line}): ${t.header.join(" | ")}`,
    );
  }
  process.exit(0);
}

const runs = new Runs([...BASELINES]);
for (const r of runs.rejected) console.error(`Rejected ${r}`);
if (runs.loaded.length === 0) {
  console.error(
    [
      "No committed perf run found. Expected one of:",
      ...BASELINES.map((b) => `  tools/comparison/baselines/${b}`),
      "",
      "Generate with `mise run benchmark` / `mise run benchmark:full`.",
    ].join("\n"),
  );
  process.exit(1);
}

if (values["list-cells"]) {
  for (const id of runs.ids) console.log(id);
  process.exit(0);
}

console.log("Committed runs:");
for (const r of runs.loaded) {
  console.log(
    `  ${r.file}: ${r.cells.length} cells, mode=${r.config?.mode}, ` +
      `${r.environment?.cpuModel} (${r.environment?.arch}, ${r.environment?.cores} cores), ` +
      `commit ${r.git?.commit}${r.git?.dirty ? " DIRTY" : ""}`,
  );
}
console.log();

const failures: Failure[] = [];
const counters = { checked: 0, unbound: 0, placeholders: 0, unavailable: 0 };
const edits: Edit[] = [];
const missingTables: string[] = [];

// §1's baseline is a hard requirement whenever §1 is in the binding set, and it
// is the one table this gate was extended to cover. Without this, a missing or
// schema-bumped `perf-stages.json` made every §1 resolver return null, which
// `checkTable` counts as `unbound` and therefore as a pass — a green run for
// the table, and all thirteen prose claims skipped with it. `Runs` exits 1 on
// the same condition; so does this now.
const stagesBound = BINDINGS.some(
  (b) => b.section === "1" && (!values.section || values.section === b.section),
);
if (stagesBound && !STAGES) {
  console.error(
    [
      `No committed stages run for PERFORMANCE.md §1: ${STAGES_ERROR ?? "unavailable"}`,
      "",
      "§1 orders §10's whole acceleration roadmap and is bound cell by cell to",
      "this artifact, together with the figures §1, §10 and §12 derive from it.",
      "Without it those checks do not become optional — they become unrun.",
    ].join("\n"),
  );
  process.exit(1);
}

for (const binding of BINDINGS) {
  if (values.section && binding.section !== values.section) continue;
  const table = tables.find(
    (t) => t.section === binding.section && t.index === binding.index,
  );
  if (!table) {
    missingTables.push(
      `§${binding.section} table ${binding.index} — ${binding.title}`,
    );
    continue;
  }
  checkTable(binding, table, runs, failures, counters, edits);
}

// A dirty tree means the numbers cannot be traced back to a source state, which
// is how the 2026-08-29 baseline came to disagree with the document it backed.
for (const file of runs.dirty) {
  failures.push({
    where: `baselines/${file}`,
    column: "git.dirty",
    row: "—",
    documented: "clean tree",
    measured: "dirty",
    detail: "regenerate from a committed tree so the run traces to a revision",
  });
}
for (const c of runs.duplicates) {
  failures.push({
    where: "committed runs",
    column: "integrity",
    row: "—",
    documented: "one value per cell id",
    measured: "duplicate",
    detail: c,
  });
}

// Two runs of the same cell disagreeing is a fact about the measuring host, not
// about the document, so it is reported rather than failed on — but loudly:
// it is the ceiling on how much any number here can be trusted.
if (runs.crossRunSpread.length > 0) {
  const pct = (CROSS_RUN_TOLERANCE * 100).toFixed(0);
  console.log(
    [
      "",
      `WARNING: ${runs.crossRunSpread.length} cell(s) disagree by more than ${pct}% between`,
      "the committed runs. That is the measuring host's reproducibility floor,",
      "and no figure in the document is tighter than it.",
    ].join("\n"),
  );
  for (const c of runs.crossRunSpread.slice(0, 10)) console.log(`  ${c}`);
  if (runs.crossRunSpread.length > 10) {
    console.log(`  ... and ${runs.crossRunSpread.length - 10} more`);
  }
}

if (values.fix) {
  if (edits.length === 0) {
    console.log("Nothing to rewrite — every bound value already agrees.");
    process.exit(0);
  }
  const lines = doc.split("\n");
  // Group by line so a row with several rewritten columns is rebuilt once.
  const byLine = new Map<number, Edit[]>();
  for (const e of edits) {
    const list = byLine.get(e.line);
    if (list) list.push(e);
    else byLine.set(e.line, [e]);
  }
  for (const [line, group] of byLine) {
    const raw = lines[line];
    if (raw === undefined) continue;
    // Keep the row's own leading whitespace and outer pipes.
    const indent = raw.slice(0, raw.length - raw.trimStart().length);
    const parts = cells(raw);
    for (const e of group) parts[e.cellIndex] = e.text;
    lines[line] = `${indent}| ${parts.join(" | ")} |`;
  }
  writeFileSync(DOC, lines.join("\n"));
  console.log(
    `Rewrote ${edits.length} cell(s) across ${byLine.size} row(s) in ${path.relative(REPO_ROOT, DOC)}.`,
  );
  console.log("Re-run without --fix to confirm, and review the diff.");
  process.exit(0);
}

// §1's baseline gets the provenance check its sibling already had. A stages
// file is *merged* one cell per run — the table is three columns and each is
// its own invocation — so it is the one artifact here that can hold cells from
// three different builds and read as one measurement. Nothing looked. The
// dirty flag was recorded on every cell and read on none, while the same flag
// on a perf-report has failed the run since that check was written.
if (STAGES) {
  const dirty = Object.entries(STAGES)
    .filter(([, c]) => c.git?.dirty)
    .map(([k]) => k);
  if (dirty.length > 0) {
    failures.push({
      where: STAGES_BASELINE,
      column: "git.dirty",
      row: dirty.join(", "),
      documented: "—",
      measured: "dirty",
      detail:
        "recorded from a working tree with uncommitted changes, so these shares cannot be traced to a source state — re-run benchmark:stages from a clean tree",
    });
  }
  const revs = new Map<string, string[]>();
  for (const [key, cell] of Object.entries(STAGES)) {
    const rev = cell.git?.rev ?? "(none)";
    revs.set(rev, [...(revs.get(rev) ?? []), key]);
  }
  if (revs.size > 1) {
    failures.push({
      where: STAGES_BASELINE,
      column: "git.rev",
      row: [...revs.keys()].join(" vs "),
      documented: "one commit",
      measured: `${revs.size} commits`,
      detail: `§1 reads as one measurement across its three columns, and these cells are from different builds: ${[...revs.entries()].map(([r, ks]) => `${r} (${ks.join(", ")})`).join("; ")}`,
    });
  }
}

// The prose figures §1 derives from its own table. Checked against the same
// baseline the table is checked against, and to the precision the sentence
// itself claims — the same tolerance rule the cells use, so tightening a figure
// in the document tightens the assertion on it.
let proseChecked = 0;
if (STAGES) {
  for (const claim of PROSE_CLAIMS) {
    const all = [...doc.matchAll(new RegExp(claim.pattern, "g"))];
    if (all.length !== 1) {
      failures.push({
        where: "PERFORMANCE.md prose",
        column: claim.what,
        row: "—",
        documented: `${all.length} match(es)`,
        measured: "—",
        detail:
          all.length === 0
            ? "the sentence was edited without updating its binding here, so the figure is no longer checked"
            : "the pattern must name one figure",
      });
      continue;
    }
    const quotedRaw = all[0]?.[1];
    const cell = STAGES[claim.cell];
    if (quotedRaw === undefined || !cell) continue;
    const quoted = Number(quotedRaw);
    if (!Number.isFinite(quoted)) {
      failures.push({
        where: "PERFORMANCE.md prose",
        column: claim.what,
        row: "—",
        documented: quotedRaw,
        measured: "—",
        detail: "captured text is not a number",
      });
      continue;
    }
    let expected = 0;
    let missing = false;
    for (const st of claim.stages) {
      const v = cell.sharePct[st];
      if (v === undefined) {
        missing = true;
        break;
      }
      expected += v;
    }
    if (missing) continue;
    const dot = quotedRaw.indexOf(".");
    const places = dot < 0 ? 0 : quotedRaw.length - dot - 1;
    const tol = 0.5 * 10 ** -places;
    proseChecked++;
    if (Math.abs(expected - quoted) > tol) {
      failures.push({
        where: "PERFORMANCE.md prose",
        column: claim.what,
        row: claim.stages.join(" + "),
        documented: `${quotedRaw}%`,
        measured: `${expected.toFixed(Math.max(places, 2))}%`,
        detail: `from ${claim.cell} in ${STAGES_BASELINE}`,
      });
    }
  }
}

console.log(
  `Checked ${counters.checked} documented value(s) against the committed runs` +
    `; ${counters.unbound} deliberately unbound` +
    `${counters.unavailable > 0 ? `, ${counters.unavailable} on targets this run could not reach` : ""}` +
    `${counters.placeholders > 0 ? `, ${counters.placeholders} placeholder(s) not yet measured` : ""}.`,
);
console.log(
  `Checked ${proseChecked} figure(s) the prose derives from §1's table.`,
);
const UNAVAILABLE_NOTE =
  '               a cell marked "<host> only" is skipped, not failed — a target no\n' +
  "               committed run reached cannot be asked to document a number. A cell\n" +
  "               holding one anyway IS failed: nothing measured it.";
for (const [target, u] of runs.unavailable) {
  const label = u.kind === "absent" ? "UNAVAILABLE" : `PROBE-${u.kind}`;
  // Only an absent target is skipped, so only an absent target gets the note
  // explaining why a marker is acceptable in its rows.
  const note = u.kind === "absent" ? `\n${UNAVAILABLE_NOTE}` : "";
  console.log(`  ${label}  ${target}: ${u.reason.split("\n")[0]}${note}`);
}
for (const m of missingTables)
  console.log(`  SKIP  ${m} — not found in the document`);

if (failures.length > 0) {
  console.log(`\n${failures.length} disagreement(s):\n`);
  for (const f of failures) {
    console.log(`  ${f.where}`);
    console.log(`    row "${f.row}", column "${f.column}"`);
    console.log(`      document: ${f.documented}`);
    console.log(`      measured: ${f.measured}`);
    if (f.detail) console.log(`      ${f.detail}`);
    console.log();
  }
  process.exit(1);
}

console.log(
  "\nEvery bound value in PERFORMANCE.md agrees with a committed run.",
);
