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
  unavailable?: { target: string; reason: string }[];
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
  readonly unavailable = new Map<string, string>();

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
        if (!this.unavailable.has(u.target)) {
          this.unavailable.set(u.target, u.reason);
        }
      }

      const seen = new Set<string>();
      for (const c of doc.cells) {
        if (seen.has(c.id)) {
          this.duplicates.push(`${file}: duplicate cell id ${c.id}`);
          continue;
        }
        seen.add(c.id);
        // A target one run could not reach but another did is available: the
        // union of what was measured wins over any single run's gap.
        this.unavailable.delete(c.id.split("/")[1] ?? "");
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
  }

  has(id: string): boolean {
    return this.byId.has(id);
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

function loadStages(): Record<string, StageCell> | null {
  const full = path.join(BASELINE_DIR, STAGES_BASELINE);
  if (!existsSync(full)) return null;
  const doc = JSON.parse(readFileSync(full, "utf8")) as {
    schema?: string;
    cells?: Record<string, StageCell>;
  };
  if (doc.schema !== STAGES_SCHEMA) return null;
  return doc.cells ?? null;
}

const STAGES = loadStages();

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
      if (!doc) continue;

      // A row naming a target no run could measure is not drift and not a
      // forgotten measurement — it is a row this host cannot fill, and the
      // document says so in prose beside it. Counted, never failed.
      const rowTarget = bare(rowLabel);
      if (R.unavailable.has(rowTarget)) {
        counters.unavailable++;
        continue;
      }

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

console.log(
  `Checked ${counters.checked} documented value(s) against the committed runs` +
    `; ${counters.unbound} deliberately unbound` +
    `${counters.unavailable > 0 ? `, ${counters.unavailable} on targets this run could not reach` : ""}` +
    `${counters.placeholders > 0 ? `, ${counters.placeholders} placeholder(s) not yet measured` : ""}.`,
);
const UNAVAILABLE_NOTE =
  "               its rows are skipped, not failed — a host that cannot run a\n" +
  "               target cannot be asked to document it.";
for (const [target, reason] of runs.unavailable) {
  console.log(
    `  UNAVAILABLE  ${target}: ${reason.split("\n")[0]}\n${UNAVAILABLE_NOTE}`,
  );
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
