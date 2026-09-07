/**
 * Checks the numbers in `spec/EXPERIMENTS.md` against the sweep results that
 * produced them.
 *
 * The document is a workbench log: its tables are transcribed by hand from
 * `mise run sweep` output, and a later re-run of a sweep silently invalidates the
 * transcription. Both failure modes were live before this script existed —
 * §1's tune ladder sat at a pre-adoption run while its holdout twin was
 * current, and §4.1 carried a Δ an order of magnitude off its own inputs.
 * Nothing in the repo could tell.
 *
 * This closes that loop. Tables are parsed out of the document, so no number is
 * transcribed twice; only the *binding* — which sweep a table came from, and
 * what its columns mean — is written by hand here. Claimed values are
 * recomputed from `perImageCiede` rather than read back from the summary
 * fields, and paired CIs go through the same seeded `bootstrapCI` the report
 * uses, so a reproduction is exact rather than approximate.
 *
 * Usage:
 *   node dist/verify-experiments.js              # every bound table
 *   node dist/verify-experiments.js --section 11.5
 *   node dist/verify-experiments.js --list-unbound
 *   node dist/verify-experiments.js --strict        # a SKIP is a failure
 *
 * Exit status is non-zero on any disagreement, so `mise run verify:experiments`
 * gates a documentation change the way `mise run rd:gate` gates a quality change.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { bootstrapCI } from "./stats.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DOC = path.join(REPO_ROOT, "spec/EXPERIMENTS.md");
const SWEEP_DIR = path.join(REPO_ROOT, "tools/comparison/output/sweeps");

// ─── The document, as tables ────────────────────────────────────────────────

interface DocTable {
  /** Section heading the table sits under, e.g. "11.5" or "1". */
  section: string;
  /** Index of this table within its section, 0-based. */
  index: number;
  /** Line of the header row in EXPERIMENTS.md, for error messages. */
  line: number;
  header: string[];
  rows: string[][];
}

/** Split a markdown table row into trimmed cells, dropping the outer pipes. */
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
    let j = i + 2;
    for (; j < lines.length; j++) {
      const body = lines[j] ?? "";
      if (!body.trimStart().startsWith("|")) break;
      rows.push(cells(body));
    }
    tables.push({
      section,
      index: indexInSection++,
      line: i + 1,
      header,
      rows,
    });
    i = j - 1;
  }
  return tables;
}

// ─── Sweep results ──────────────────────────────────────────────────────────

export interface SweepRow {
  label: string;
  bytes: number | null;
  meanCiede: number | null;
  medianCiede: number | null;
  meanSsimulacra2: number | null;
  meanButteraugli: number | null;
  meanDssim: number | null;
  meanAlphaMae: number | null;
  ciedeDeltaPct: number | null;
  guardsOk: boolean | null;
  perImageCiede: (number | null)[];
  imageNames: string[];
}

interface SweepFile {
  name: string;
  split: string;
  images: number;
  rows: SweepRow[];
}

/** A row as `rd-budget` writes it — one format at one byte budget. */
interface RdRow {
  family: string;
  variant: string;
  bytes: number;
  ciede2000: number;
  ssimulacra2: number;
  butteraugli: number;
  dssim: number;
}

/** rd-budget reports aggregates only, so its rows arrive without per-image data. */
function fromRdRow(r: RdRow): SweepRow {
  return {
    label: r.variant,
    bytes: r.bytes,
    meanCiede: r.ciede2000,
    medianCiede: null,
    meanSsimulacra2: r.ssimulacra2,
    meanButteraugli: r.butteraugli,
    meanDssim: r.dssim,
    meanAlphaMae: null,
    ciedeDeltaPct: null,
    guardsOk: null,
    perImageCiede: [],
    imageNames: [],
  };
}

const sweepCache = new Map<string, SweepFile | null>();

function loadSweep(name: string): SweepFile | null {
  const cached = sweepCache.get(name);
  if (cached !== undefined) return cached;
  let parsed: SweepFile | null = null;
  try {
    const raw = JSON.parse(
      readFileSync(path.join(SWEEP_DIR, `${name}.json`), "utf8"),
    ) as Omit<SweepFile, "rows"> & { rows: unknown[] };
    parsed = {
      ...raw,
      rows: raw.rows.map((r) =>
        typeof r === "object" && r !== null && "variant" in r
          ? fromRdRow(r as RdRow)
          : (r as SweepRow),
      ),
    };
  } catch {
    parsed = null;
  }
  sweepCache.set(name, parsed);
  return parsed;
}

/**
 * Loose label match: the prose that quotes a sweep differs from it in spacing,
 * case, and decoration ("**aniso 1.2 / hv 0.15**" vs "aniso=1.2 hv=0.15").
 * Reduce both to alphanumerics so an explicit alias is only needed when the
 * words themselves differ.
 */
const normalize = (s: string): string =>
  s
    .replace(/[*`]/g, "")
    .toLowerCase()
    // The sign is load-bearing: `hv=-0.3` and `hv=0.3` are different arms, and
    // dropping the minus silently matched one to the other.
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/[^a-z0-9.+-]+/g, "");

function findRow(sweep: SweepFile, label: string): SweepRow | undefined {
  const want = normalize(label);
  return (
    sweep.rows.find((r) => normalize(r.label) === want) ??
    (want.length > 3
      ? sweep.rows.find((r) => normalize(r.label).includes(want))
      : undefined)
  );
}

// ─── What a cell can assert ─────────────────────────────────────────────────

export type Metric =
  | "meanCiede"
  | "medianCiede"
  | "meanSsimulacra2"
  | "meanButteraugli"
  | "meanDssim"
  | "meanAlphaMae"
  | "ciedeDeltaPct"
  | "bytes"
  | "ci"
  | "winN";

/** Resolve the sweep row a doc label refers to, when a name match cannot. */
type Resolver = (rows: SweepRow[], docCells: string[]) => SweepRow | undefined;

interface CommonBinding {
  section: string;
  /** Which table within the section (default 0). */
  table?: number;
  /** Doc label → sweep label, where the wording differs by more than punctuation. */
  aliases?: Record<string, string>;
  resolve?: Resolver;
  /** Why a table is bound the way it is, or what it deliberately leaves out. */
  note?: string;
}

/** Doc rows are sweep variants; doc columns are metrics. The common shape. */
interface RowBinding extends CommonBinding {
  kind: "rows";
  sweep: string;
  columns: Partial<Record<string, Metric>>;
  /** Cell that names the variant, when it is not the first (default 0). */
  labelColumn?: number;
  /** Doc rows that assert nothing checkable (prose, derived, "—"). */
  skipRows?: string[];
  /** Row the Δ%/CI/win-n columns are measured against (default: sweep row 0). */
  baseline?: string;
  /**
   * Per-column override of `baseline`. §11.10 needs it: its Δ% is against the
   * shipped shape while its CI is against the leader, in one table.
   */
  baselines?: Partial<Record<string, string>>;
}

/**
 * Transposed: doc *columns* are the sweep variants and each doc row is one
 * series. §1's ladder is the canonical case — one row per split, one column
 * per byte budget.
 */
type ColumnSeries =
  | { docRow: string; sweep: string; metric: Metric; baseline?: string }
  /**
   * A row the document derives from two others, e.g. "tune Δ" beneath
   * "tune, shipped" and "tune, tuned". Checking these is the point: §4.1
   * carried a Δ an order of magnitude away from its own inputs.
   */
  | { docRow: string; pctFrom: { base: string; cand: string } }
  /**
   * A row of slopes between two ladder points, one per column, where the column
   * header names the interval ("16→32 B"). §1's marginal-value row is derived
   * from the ladder above it and had gone stale with it.
   */
  | { docRow: string; slopeFrom: string };

interface ColumnBinding extends CommonBinding {
  kind: "columns";
  series: ColumnSeries[];
}

/**
 * A table whose Δ column is derived from two other columns *of the same row*.
 *
 * §4.1 is the case that motivated it: three rows, each "small raster" vs
 * "native tier raster" with a Δ between them, and the middle row's Δ was an
 * order of magnitude off its own two inputs — through two hand checks, because
 * nothing computed it. The row labels here name coefficient counts rather than
 * sweep arms, so there is no clean row binding; checking the arithmetic the
 * document does on its own printed values catches this class regardless.
 */
interface RatioBinding extends CommonBinding {
  kind: "row-ratio";
  /** Header of the derived column. */
  delta: string;
  /** Headers of the two columns it is derived from: (cand - base) / base. */
  cand: string;
  base: string;
  /** Sweep the arms live in. */
  sweep: string;
  /**
   * Doc row label → the two sweep arms its two columns report.
   *
   * The Δ must come from the arms' full precision, not from the document's
   * rounded cells: §4.1's three-decimal inputs (7.089 vs 7.093) give −0.056%,
   * while the values behind them (7.089273 vs 7.092663) give −0.048%. When two
   * numbers nearly cancel, the printed pair cannot reconstruct their ratio.
   */
  arms: Record<string, { cand: string; base: string }>;
}

type Binding = RowBinding | ColumnBinding | RatioBinding;

// ─── Checking ───────────────────────────────────────────────────────────────

/** Parse a doc cell like "**10.100**", "−0.81%", "8.57 @32 px", "—". */
function parseCell(raw: string): number | null {
  const cleaned = raw
    .replace(/[*`]/g, "")
    .replace(/[−–—]/g, "-")
    .replace(/%/g, "")
    .replace(/@.*$/, "")
    .replace(/\s*B$/i, "")
    .trim();
  if (cleaned === "" || cleaned === "-" || cleaned.toLowerCase() === "n/a") {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Decimals shown, so the tolerance matches the precision the doc claims. */
function decimals(raw: string): number {
  const m = /\.(\d+)/.exec(raw.replace(/[*`]/g, ""));
  return m?.[1]?.length ?? 0;
}

interface Failure {
  section: string;
  row: string;
  column: string;
  claimed: string;
  measured: string;
  /** Line of the table header, and the cell's coordinates, for --fix. */
  fix?:
    | { line: number; rowIndex: number; colIndex: number; cell: string }
    | undefined;
}

/** Recompute one metric from the raw per-image data wherever possible. */
function measure(
  metric: Metric,
  row: SweepRow,
  baseline: SweepRow | undefined,
): number | string | null {
  const paired = (): number[] => {
    if (!baseline) return [];
    const out: number[] = [];
    for (const [i, base] of baseline.perImageCiede.entries()) {
      const cand = row.perImageCiede[i];
      if (base == null || cand == null) continue;
      out.push(base - cand); // positive = the candidate is better
    }
    return out;
  };

  switch (metric) {
    case "meanCiede": {
      // Recomputed, not read back: the stored mean is part of what we audit.
      // rd-budget rows carry no per-image data, so there the aggregate is all
      // there is.
      const vals = row.perImageCiede.filter((v): v is number => v !== null);
      return vals.length
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : row.meanCiede;
    }
    case "ciedeDeltaPct": {
      if (!baseline?.meanCiede || row.meanCiede === null) return null;
      return ((row.meanCiede - baseline.meanCiede) / baseline.meanCiede) * 100;
    }
    case "ci": {
      const d = paired();
      if (d.length === 0) return null;
      const [lo, hi] = bootstrapCI(d);
      return `[${signed(lo)}, ${signed(hi)}]`;
    }
    case "winN": {
      const d = paired();
      if (d.length === 0) return null;
      return `${d.filter((x) => x > 0).length}/${d.length}`;
    }
    default:
      return row[metric];
  }
}

const signed = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;

function compare(
  ctx: {
    section: string;
    row: string;
    column: string;
    fix?: { line: number; rowIndex: number; colIndex: number };
  },
  raw: string,
  measured: number | string,
  failures: Failure[],
  stats: { cells: number },
): void {
  const blank = raw.replace(/[*`\s]/g, "");
  // The incumbent and the reference row assert nothing: no delta, no interval,
  // no win count.
  if (["", "—", "-", "(base)", "(leader)", "(control)"].includes(blank)) return;

  if (typeof measured === "string") {
    stats.cells++;
    const claimed = raw.replace(/[*`]/g, "").trim();
    // Some intervals are stated as the conclusion rather than the numbers.
    // That is still a checkable claim about where the interval sits.
    const straddlesZero = /^\[([-+0-9.]+), ([-+0-9.]+)\]$/.exec(measured);
    if (/includes zero/i.test(claimed) && straddlesZero) {
      const lo = Number(straddlesZero[1]);
      const hi = Number(straddlesZero[2]);
      if (!(lo <= 0 && hi >= 0)) {
        failures.push({
          ...ctx,
          claimed,
          measured: `${measured} — excludes zero`,
          fix: ctx.fix && { ...ctx.fix, cell: rewriteCell(raw, measured) },
        });
      }
      return;
    }
    if (normalize(claimed) !== normalize(measured)) {
      failures.push({
        ...ctx,
        claimed,
        measured,
        fix: ctx.fix && { ...ctx.fix, cell: rewriteCell(raw, measured) },
      });
    }
    return;
  }
  const claimed = parseCell(raw);
  if (claimed === null) return;
  stats.cells++;
  const tol = 0.5 * 10 ** -decimals(raw) + 1e-9;
  if (Math.abs(claimed - measured) > tol) {
    const rounded = measured.toFixed(decimals(raw));
    failures.push({
      ...ctx,
      claimed: raw.trim(),
      measured: `${rounded}  (exact ${measured.toFixed(decimals(raw) + 3)})`,
      fix: ctx.fix && { ...ctx.fix, cell: rewriteCell(raw, rounded) },
    });
  }
}

/** Whether the document writes negatives with U+2212 rather than an ASCII hyphen. */
let docMinusCache: boolean | undefined;
function docUsesUnicodeMinus(): boolean {
  if (docMinusCache === undefined) {
    docMinusCache = readFileSync(DOC, "utf8").includes("\u2212");
  }
  return docMinusCache;
}

/**
 * Put a corrected value into a cell without disturbing anything else about it:
 * the document uses bold to mark winners, a unicode minus, and trailing units,
 * and all of that is meaning, not formatting noise.
 */
function rewriteCell(raw: string, value: string): string {
  const bold = raw.trim().startsWith("**") && raw.trim().endsWith("**");
  const body = raw.trim().replace(/^\*\*|\*\*$/g, "");
  // The minus convention belongs to the document, not to the cell being
  // replaced. Reading it from the cell alone gets it wrong in exactly the case
  // that matters: a cell whose old value was positive has no minus to copy, so
  // a newly-negative measurement lands as an ASCII hyphen among unicode ones.
  const usesUnicodeMinus = /[\u2212]/.test(body) || docUsesUnicodeMinus();
  let next = value;
  if (usesUnicodeMinus) next = next.replace(/^-/, "\u2212");
  // Preserve a trailing unit or annotation ("%", " B", " @32 px", "pp") \u2014 but
  // only when the measured value is a bare number. A composite value already
  // carries what this regex reads as a suffix: on a win count the "unit" is
  // `/31`, so appending it to `16/31` produced `16/31/31`. That stayed hidden
  // while every win count happened to agree, and surfaced the first time one
  // did not.
  const suffix = /^[-\u2212+]?[0-9.]+(.*)$/.exec(body)?.[1] ?? "";
  if (/^[-\u2212+]?[0-9.]+$/.test(value)) next += suffix;
  else if (usesUnicodeMinus) next = value.replace(/-/g, "\u2212");
  return bold ? `**${next}**` : next;
}

function checkRowTable(
  b: RowBinding,
  table: DocTable,
  failures: Failure[],
  stats: { cells: number },
): string | null {
  const sweep = loadSweep(b.sweep);
  if (!sweep) return `no output/sweeps/${b.sweep}.json — run the sweep`;
  const baseline = b.baseline ? findRow(sweep, b.baseline) : sweep.rows[0];

  for (const row of table.rows) {
    const docLabel = row[b.labelColumn ?? 0] ?? "";
    if (b.skipRows?.some((s) => normalize(s) === normalize(docLabel))) continue;

    const sweepRow =
      b.resolve?.(sweep.rows, row) ??
      findRow(sweep, b.aliases?.[docLabel] ?? docLabel);
    if (!sweepRow) {
      failures.push({
        section: b.section,
        row: docLabel,
        column: "(row)",
        claimed: "a matching sweep row",
        measured: "none",
      });
      continue;
    }

    for (const [i, header] of table.header.entries()) {
      const metric = b.columns[header];
      if (!metric) continue;
      const columnBase = b.baselines?.[header];
      const measured = measure(
        metric,
        sweepRow,
        columnBase ? findRow(sweep, columnBase) : baseline,
      );
      if (measured === null) continue;
      compare(
        {
          section: b.section,
          row: docLabel,
          column: header,
          fix: {
            line: table.line,
            rowIndex: table.rows.indexOf(row),
            colIndex: i,
          },
        },
        row[i] ?? "",
        measured,
        failures,
        stats,
      );
    }
  }
  return null;
}

/**
 * Check a table whose two value columns are two arms of one sweep and whose Δ
 * column is the ratio between them.
 */
function checkRatioTable(
  b: RatioBinding,
  table: DocTable,
  failures: Failure[],
  stats: { cells: number },
): string | null {
  const col = (name: string): number => {
    const i = table.header.findIndex((h) => h.trim() === name);
    if (i < 0) throw new Error(`no column ${JSON.stringify(name)}`);
    return i;
  };

  let deltaCol: number;
  let candCol: number;
  let baseCol: number;
  try {
    deltaCol = col(b.delta);
    candCol = col(b.cand);
    baseCol = col(b.base);
  } catch (e) {
    return (e as Error).message;
  }

  const sweep = loadSweep(b.sweep);
  if (!sweep) return `no output/sweeps/${b.sweep}.json — run the sweep`;

  for (const [rowIndex, row] of table.rows.entries()) {
    const label = (row[0] ?? "").trim();
    const arms = b.arms[label];
    if (!arms) return `no arms mapped for row ${JSON.stringify(label)}`;

    const cand = findRow(sweep, arms.cand);
    const base = findRow(sweep, arms.base);
    if (!cand) return `no sweep arm ${JSON.stringify(arms.cand)}`;
    if (!base) return `no sweep arm ${JSON.stringify(arms.base)}`;

    if (cand.meanCiede === null || base.meanCiede === null) {
      return `arm ${JSON.stringify(arms.cand)} or ${JSON.stringify(arms.base)} has no ΔE00`;
    }
    const candCiede = cand.meanCiede;
    const baseCiede = base.meanCiede;

    const ctx = (column: string, colIndex: number) => ({
      section: b.section,
      row: label,
      column,
      fix: { line: table.line, rowIndex, colIndex },
    });

    // The two value columns, then the Δ derived from their full precision.
    compare(
      ctx(b.cand, candCol),
      row[candCol] ?? "",
      candCiede,
      failures,
      stats,
    );
    compare(
      ctx(b.base, baseCol),
      row[baseCol] ?? "",
      baseCiede,
      failures,
      stats,
    );
    compare(
      ctx(b.delta, deltaCol),
      row[deltaCol] ?? "",
      ((candCiede - baseCiede) / baseCiede) * 100,
      failures,
      stats,
    );
  }
  return null;
}

function checkColumnTable(
  b: ColumnBinding,
  table: DocTable,
  failures: Failure[],
  stats: { cells: number },
): string | null {
  // Column index → measured value, per series, so derived rows can be checked
  // against what the rows above them actually measured.
  const measured = new Map<string, Map<number, number>>();

  for (const series of b.series) {
    if ("pctFrom" in series || "slopeFrom" in series) continue;
    const sweep = loadSweep(series.sweep);
    if (!sweep) return `no output/sweeps/${series.sweep}.json — run the sweep`;
    const baseline = series.baseline
      ? findRow(sweep, series.baseline)
      : sweep.rows[0];
    const byColumn = new Map<number, number>();
    measured.set(series.docRow, byColumn);

    for (const [i, colLabel] of table.header.entries()) {
      if (i === 0) continue;
      const sweepRow =
        b.resolve?.(sweep.rows, [colLabel]) ??
        findRow(sweep, b.aliases?.[colLabel] ?? colLabel);
      if (!sweepRow) {
        failures.push({
          section: b.section,
          row: series.docRow,
          column: colLabel,
          claimed: "a matching sweep row",
          measured: "none",
        });
        continue;
      }
      const value = measure(series.metric, sweepRow, baseline);
      if (typeof value === "number") byColumn.set(i, value);
    }
  }

  for (const series of b.series) {
    const docRow = table.rows.find(
      (r) => normalize(r[0] ?? "") === normalize(series.docRow),
    );
    if (!docRow) {
      failures.push({
        section: b.section,
        row: series.docRow,
        column: "(row)",
        claimed: "a row with this label",
        measured: "none in the document",
      });
      continue;
    }

    for (const [i, colLabel] of table.header.entries()) {
      if (i === 0) continue;
      let value: number | undefined;
      if ("slopeFrom" in series) {
        const sweep = loadSweep(series.slopeFrom);
        const bounds = /(\d+)\s*[\u2192>-]+\s*(\d+)/.exec(colLabel);
        if (!sweep || !bounds) continue;
        const from = byBudget(sweep.rows, [bounds[1] ?? ""]);
        const to = byBudget(sweep.rows, [bounds[2] ?? ""]);
        if (!from?.meanCiede || !to?.meanCiede) continue;
        const bytes = Number(bounds[2]) - Number(bounds[1]);
        // ΔE00 recovered per extra byte across the interval.
        value = (from.meanCiede - to.meanCiede) / bytes;
      } else if ("pctFrom" in series) {
        const base = measured.get(series.pctFrom.base)?.get(i);
        const cand = measured.get(series.pctFrom.cand)?.get(i);
        if (base === undefined || cand === undefined || base === 0) continue;
        value = ((cand - base) / base) * 100;
      } else {
        value = measured.get(series.docRow)?.get(i);
      }
      if (value === undefined) continue;
      compare(
        {
          section: b.section,
          row: series.docRow,
          column: colLabel,
          fix: {
            line: table.line,
            rowIndex: table.rows.indexOf(docRow),
            colIndex: i,
          },
        },
        docRow[i] ?? "",
        value,
        failures,
        stats,
      );
    }
  }
  return null;
}

// ─── Bindings ───────────────────────────────────────────────────────────────
// Hand-written, because only a person can say which sweep a table came from.
// Every *number* is parsed from the document, so a mistake here cannot hide
// one there — it shows up as a mismatch, not as a silent pass.

/** Ladder rows are labelled "  32 B  t1 L26/C9"; select by the byte budget. */
const byBudget: Resolver = (rows, docCells) => {
  const want = Number((docCells[0] ?? "").replace(/[*\s]/g, ""));
  if (!Number.isFinite(want)) return undefined;
  // The incumbent "SHIPPED" row shares 32 B with a ladder point; the ladder
  // point is the later of the two.
  return rows.filter((r) => r.bytes === want).at(-1);
};

/**
 * §11.14 lists a format at several budgets, so the format name alone is
 * ambiguous. Key on the name plus the byte column, allowing the rounding the
 * document applies to a measured mean size.
 */
const byFormatAndBytes: Resolver = (rows, docCells) => {
  const bytes = Number((docCells[0] ?? "").replace(/[*\s]/g, ""));
  const name = normalize(docCells[1] ?? "");
  const candidates = rows.filter((r) => {
    const label = normalize(r.label);
    const family = label.replace(/[0-9].*$/, "");
    return label.startsWith(name) || name.startsWith(family);
  });
  if (!Number.isFinite(bytes)) return candidates[0];
  return candidates
    .slice()
    .sort(
      (a, b) =>
        Math.abs((a.bytes ?? 0) - bytes) - Math.abs((b.bytes ?? 0) - bytes),
    )
    .find((r) => Math.abs((r.bytes ?? 0) - bytes) < 1);
};

const BINDINGS: Binding[] = [
  // §4.1 — the raster-vs-coefficients table. Its Δ is derived from the two
  // columns beside it, and was an order of magnitude wrong through two hand
  // checks. The row labels name coefficient counts, not sweep arms, so there is
  // no clean row binding; checking the document's own arithmetic catches it.
  {
    kind: "row-ratio",
    section: "4.1",
    table: 0,
    sweep: "render-raster",
    delta: "Δ",
    cand: "small raster",
    base: "native tier raster",
    arms: {
      "104 L / 36 C (108 B)": {
        cand: "t1 counts @tier0 (32px)",
        base: "t1 shipped (108 B, 64px)",
      },
      "416 L / 144 C (411 B)": {
        cand: "t2 counts @tier0 (32px)",
        base: "t2 shipped (411 B, 128px)",
      },
      // The control that separates "the raster is inert" from "the raster is
      // below the bound": same counts, same base, a raster that clears it.
      "416 L / 144 C (411 B) @64 px": {
        cand: "t2 counts @tier1 (64px)",
        base: "t2 shipped (411 B, 128px)",
      },
      "1664 L / 576 C (1623 B)": {
        cand: "t3 counts @tier1 (64px)",
        base: "t3 shipped (1623 B, 256px)",
      },
    },
  },

  // §1 — the rate–distortion ladder, one column per byte budget.
  {
    kind: "columns",
    section: "1",
    table: 0,
    resolve: byBudget,
    series: [
      { docRow: "ΔE00 tune", sweep: "budget-ladder", metric: "meanCiede" },
      {
        docRow: "ΔE00 holdout",
        sweep: "budget-ladder-holdout",
        metric: "meanCiede",
      },
    ],
  },
  {
    kind: "columns",
    section: "1",
    table: 2,
    series: [{ docRow: "ΔE00 gained per byte", slopeFrom: "budget-ladder" }],
  },
  {
    kind: "columns",
    section: "1",
    table: 1,
    resolve: byBudget,
    series: [
      { docRow: "ΔE00 tune", sweep: "budget-ladder", metric: "meanCiede" },
      {
        docRow: "ΔE00 holdout",
        sweep: "budget-ladder-holdout",
        metric: "meanCiede",
      },
    ],
  },

  // §4.3 — the 21 B head-to-head against ThumbHash, both splits.
  {
    kind: "rows",
    section: "4.3",
    table: 0,
    sweep: "thumbhash-headtohead",
    columns: {
      Bytes: "bytes",
      ΔE00: "meanCiede",
      SSIM2: "meanSsimulacra2",
      Butter: "meanButteraugli",
      DSSIM: "meanDssim",
    },
    aliases: {
      "shipped shape L13@5 C6@4": "21B shipped-shape L13@5 C6@4",
      "L26@3 C6@3": "21B L26@3 C6@3",
      "L19@4 C6@3": "21B L19@4 C6@3",
      "**L19@4 C6@3 + stack**": "21B L19@4 C6@3 +stack",
      "L22@4 C8@3 + stack": "24B L22@4 C8@3 +stack",
    },
    skipRows: ["ThumbHash"],
    note: "The ThumbHash row is the npm encoder, not a sweep arm; it is checked in §11.14 against rd-budget.",
  },
  {
    kind: "rows",
    section: "4.3",
    table: 1,
    sweep: "thumbhash-headtohead-holdout",
    columns: {
      Bytes: "bytes",
      ΔE00: "meanCiede",
      SSIM2: "meanSsimulacra2",
      Butter: "meanButteraugli",
      DSSIM: "meanDssim",
    },
    aliases: {
      "shipped shape L13@5 C6@4": "21B shipped-shape L13@5 C6@4",
      "**L26@3 C6@3 + stack**": "21B L26@3 C6@3 +stack",
      "L22@3 C8@3 + stack": "21B L22@3 C8@3 +stack",
      "L19@4 C6@3 + stack": "21B L19@4 C6@3 +stack",
      "L22@4 C8@3 + stack": "24B L22@4 C8@3 +stack",
    },
    skipRows: ["ThumbHash"],
  },

  // §4.5 — the round-1 holdout verdict, and the tuned ladder beside it.
  {
    kind: "rows",
    section: "4.5",
    table: 0,
    sweep: "holdout-candidates-holdout",
    columns: {
      Bytes: "bytes",
      ΔE00: "meanCiede",
      "Δ%": "ciedeDeltaPct",
      SSIM2: "meanSsimulacra2",
      Butter: "meanButteraugli",
      DSSIM: "meanDssim",
    },
    aliases: {
      shipped: "32B SHIPPED",
      "L38@4 C8@3": "32B A L38@4 C8@3",
      "L28@4 C15@3": "32B B L28@4 C15@3",
      "shipped + stack": "32B SHIPPED+aniso+fit2",
      "L38@4 C8@3 + stack": "32B A + aniso+fit2",
      "**L28@4 C15@3 + stack**": "32B B + aniso+fit2",
      "tier 1 shipped": "108B SHIPPED (t1)",
      "tier 1 + stack": "108B t1 +aniso+fit2",
    },
  },
  {
    kind: "columns",
    section: "4.5",
    table: 1,
    resolve: byBudget,
    series: [
      {
        docRow: "tune, tuned",
        sweep: "budget-ladder-tuned",
        metric: "meanCiede",
      },
      {
        docRow: "holdout, tuned",
        sweep: "budget-ladder-tuned-holdout",
        metric: "meanCiede",
      },
    ],
    note: "The `pre-adoption shipped` rows, and the Δ rows derived from them, are round 1's baseline — the v0.6-derived constants, whose ladder run no longer exists on disk. §1 carries the ladder for the constants that ship today.",
  },

  // §7 — the roadmap items, each behind its own tunable.
  {
    kind: "rows",
    section: "7.1",
    table: 1,
    sweep: "refine-ablation",
    columns: { ΔE00: "meanCiede", "Δ%": "ciedeDeltaPct" },
    aliases: {
      shipped: "32B shipped",
      "`refine_obj=1` (OKLAB, no clipping model — the control)":
        "32B obj1 control p1",
      "`refine_obj=0` (gamma sRGB), 2 passes": "32B obj0 p2",
      "`refine_obj=0`, 2 passes + dc + scale": "32B obj0 p2 +dc+scale",
      "`refine_obj=2` (clipped OKLAB), 2 passes": "32B obj2 p2",
    },
  },
  {
    kind: "rows",
    section: "7.5",
    table: 0,
    sweep: "prefix-shrink",
    columns: { "ΔE00 Δ%": "ciedeDeltaPct" },
    aliases: {
      "aspect 8 → 5 b": "cost aspect 5b (-3)",
      "aspect 8 → 4 b": "cost aspect 4b (-4)",
      "scales 6/6/5 → 5/4/4, linear grid": "cost scales 5/4/4 (-4)",
      "scales 6/6/5 → 5/4/4, **µ-law grid** (`scale_mu=8`)":
        "cost scales 5/4/4 +mu8 (-4)",
      "`b_scale_from_a` (drop the b field)": "cost b_from_a (-5)",
      "DC 7/7/7 → 6/6/6": "cost dc 6/6/6 (-3)",
      "all of the above": "cost all-in: +dc6/6/6 (-15)",
    },
  },
  {
    kind: "rows",
    section: "7.8",
    table: 0,
    sweep: "detail-synthesis",
    columns: {
      "ΔE00 Δ%": "ciedeDeltaPct",
      SSIM2: "meanSsimulacra2",
      Butteraugli: "meanButteraugli",
      DSSIM: "meanDssim",
    },
    aliases: {
      shipped: "32B shipped (no synth)",
      "26 extra coefficients, gain 0.25": "32B synth 26 g0.25",
      "78, gain 0.5": "32B synth 78 g0.5",
      "234, gain 0.5": "32B synth 234 g0.5",
      "tier 1, 312, gain 0.5": "108B t1 synth 312 g0.5",
    },
    note: "The tier-1 row's ΔE00 column is quoted in percentage points against the tier-1 base, not against the 32 B incumbent, so it is not comparable to ciedeDeltaPct.",
  },
  {
    kind: "rows",
    section: "7.10",
    table: 0,
    sweep: "cfl",
    columns: { bytes: "bytes", ΔE00: "meanCiede" },
    aliases: {
      shipped: "32B shipped L26@5C9@4",
      "CfL free (gains not paid for)": "32B free cfl5 (34 B)",
      "CfL paid, L24@5 C9@4": "32B paid cfl5 L24C9",
      "CfL paid on the 4-bit layout": "32B 4b paid cfl5 L28C13",
      "tier 1 free": "108B t1 free cfl5",
      "tier 2 free": "411B t2 free cfl5",
      "tier 3 free": "1623B t3 free cfl5",
    },
  },
  {
    kind: "rows",
    section: "7.11",
    table: 0,
    sweep: "embedded-tiers",
    columns: { ΔE00: "meanCiede", SSIM2: "meanSsimulacra2" },
    aliases: {
      "first 32 B, interleaved": "t1 interleaved, trunc 32 B",
      "first 32 B, channel-sequential": "t1 seq, trunc 32 B",
      "first 48 B, interleaved": "t1 interleaved, trunc 48 B",
      "first 64 B, interleaved": "t1 interleaved, trunc 64 B",
      "full 108 B (either order)": "t1 interleaved, full 108 B",
    },
  },
  {
    kind: "rows",
    section: "7.12",
    table: 0,
    sweep: "final-candidates-holdout",
    columns: {
      Bytes: "bytes",
      ΔE00: "meanCiede",
      "Δ%": "ciedeDeltaPct",
      SSIM2: "meanSsimulacra2",
      Butter: "meanButteraugli",
      DSSIM: "meanDssim",
    },
    aliases: {
      shipped: "32B shipped",
      "shipped layout + stack": "32B shipped-layout stack",
      "L36C9 stack": "32B L36C9 stack",
      "L32C12 stack": "32B L32C12 stack",
      "L30C13 stack": "32B L30C13 stack",
      "L28C15 stack, hv = 0": "32B L28C15 stack hv0",
      "**L28C15 stack**": "32B L28C15 stack",
      "**L28C15 stack + REFINE**": "32B L28C15 stack+REFINE",
      "tier 1 base": "108B t1 base",
      "tier 1 stack": "108B t1 stack",
      "tier 1 stack + REFINE": "108B t1 stack+REFINE",
      "tier 2 stack": "411B t2 stack",
    },
  },
  {
    kind: "columns",
    section: "7.12",
    table: 1,
    resolve: byBudget,
    series: [
      {
        docRow: "tune, optimized",
        sweep: "budget-ladder-optimized",
        metric: "meanCiede",
      },
      {
        docRow: "holdout, optimized",
        sweep: "budget-ladder-optimized-holdout",
        metric: "meanCiede",
      },
    ],
    note: "As §4.5: the `pre-adoption shipped` rows are round 2's baseline and are not reproducible from a current build.",
  },

  // §10.3 — what adoption bought, on both splits.
  {
    kind: "rows",
    section: "10.3",
    table: 0,
    sweep: "adopted-defaults-holdout",
    columns: {
      ΔE00: "meanCiede",
      SSIM2: "meanSsimulacra2",
      Butter: "meanButteraugli",
      DSSIM: "meanDssim",
    },
    aliases: {
      "holdout, tier 0, pre-adoption": "t0 pre-adoption constants",
      "holdout, tier 0, **DEFAULT**": "t0 DEFAULT (post-adoption)",
      "holdout, tier 1, pre-adoption": "t1 pre-adoption constants",
      "holdout, tier 1, **DEFAULT**": "t1 DEFAULT (post-adoption)",
    },
    skipRows: ["tune, tier 0, pre-adoption", "tune, tier 0, **DEFAULT**"],
    note: "§10.3 mixes splits in one table, so its tune rows are bound separately below. Its Δ% column is measured against the pre-adoption row rather than the sweep incumbent, so it is checked by hand in the section text.",
  },
  {
    kind: "rows",
    section: "10.3",
    table: 0,
    sweep: "adopted-defaults",
    columns: {
      ΔE00: "meanCiede",
      SSIM2: "meanSsimulacra2",
      Butter: "meanButteraugli",
      DSSIM: "meanDssim",
    },
    aliases: {
      "tune, tier 0, pre-adoption": "t0 pre-adoption constants",
      "tune, tier 0, **DEFAULT**": "t0 DEFAULT (post-adoption)",
    },
    skipRows: [
      "holdout, tier 0, pre-adoption",
      "holdout, tier 0, **DEFAULT**",
      "holdout, tier 1, pre-adoption",
      "holdout, tier 1, **DEFAULT**",
    ],
  },

  // §11.3 — the alpha allocation, the largest result of the round.
  {
    kind: "rows",
    section: "11.3",
    table: 0,
    sweep: "alpha-fields",
    columns: {
      ΔE00: "meanCiede",
      "Δ%": "ciedeDeltaPct",
      αMAE: "meanAlphaMae",
    },
    aliases: {
      "**shipped** alpha DC 5 b, scale 4 b, AC 5 @ 4 b":
        "SHIPPED dc5 scl4 A5@4",
      "alpha DC 4 b (−1)": "dc 4b (-1, +1 alpha AC)",
      "alpha scale 3 b (−1)": "scale 3b (-1)",
      "**A 8 @ 4** (+3 coefficients, −3 luma)": "A8@4 (+3 alpha AC, -3 L)",
      "**A 12 @ 4** (+7 coefficients, −6 luma)": "A12@4 (+7 alpha AC, -6 L)",
      "A 3 @ 4 (−2 coefficients)": "A3@4 (-2 alpha AC, +1 L)",
      "A 0 (no alpha AC at all)": "A0 (no alpha AC, +4 L)",
    },
  },
  {
    kind: "rows",
    section: "11.3",
    table: 1,
    sweep: "alpha-ceiling",
    columns: {
      ΔE00: "meanCiede",
      "Δ%": "ciedeDeltaPct",
      SSIM2: "meanSsimulacra2",
      Butter: "meanButteraugli",
      αMAE: "meanAlphaMae",
    },
    aliases: {
      "shipped A5@4 L20@5 C9@4": "SHIPPED A5@4 L20@5 C9@4",
      "**A28@3 L22@4 C3@3**": "A28@3 L22@4 C3@3",
    },
    skipRows: ["A12@4 L18@4 C9@4", "A20@4 L20@5 C1@4"],
    note: "The ladder is assembled from two sweeps; the two lower rungs come from alpha-ac-count and are bound below.",
  },
  {
    kind: "rows",
    section: "11.3",
    table: 1,
    sweep: "alpha-ac-count",
    columns: {
      ΔE00: "meanCiede",
      "Δ%": "ciedeDeltaPct",
      SSIM2: "meanSsimulacra2",
      Butter: "meanButteraugli",
      αMAE: "meanAlphaMae",
    },
    aliases: {
      "shipped A5@4 L20@5 C9@4": "SHIPPED A5@4 L20@5 C9@4",
      "A20@4 L20@5 C1@4": "A20@4 L20@5 C1@4 (from chroma)",
    },
    skipRows: [
      "**A28@3 L22@4 C3@3**",
      "A40@3 L13@4 C3@3",
      "A48@3 L7@4 C3@3",
      "A32@2 L24@4 C5@3",
    ],
  },

  // §11.10 — the compact tier, on the photographic corpus and cross-checked
  // against graphics.
  {
    kind: "rows",
    section: "11.10",
    table: 0,
    sweep: "compact-tier",
    columns: {
      ΔE00: "meanCiede",
      "Δ% vs shipped shape": "ciedeDeltaPct",
      "paired CI vs the leader": "ci",
    },
    baselines: { "paired CI vs the leader": "L19@4 C6@3  (§8.1 tune)" },
    aliases: {
      "**L19@4 C6@3**": "L19@4 C6@3  (§8.1 tune)",
      "L26@3 C6@3": "L26@3 C6@3  (§8.1 hold)",
      "L18@4 C7@3": "L18@4 C7@3",
      "L24@3 C7@3": "L24@3 C7@3",
      "L35@3 C2@2 (count-maximal)": "L35@3 C2@2 (count-max)",
      "L19@5 C2@4 (precision-maximal)": "L19@5 C2@4 (precision-max)",
    },
    note: "Δ% is against the shipped shape (the sweep incumbent); the CI column is against the leader, so `baseline` names the leader.",
  },
  {
    kind: "rows",
    section: "11.10",
    table: 1,
    sweep: "compact-tier-graphics",
    columns: { "graphics ΔE00": "meanCiede" },
    aliases: {
      "**L19@4 C6@3**": "L19@4 C6@3  (§8.1 tune)",
      "L26@3 C6@3": "L26@3 C6@3  (§8.1 hold)",
    },
  },

  // §11.12 — the holdout, consulted once.
  {
    kind: "rows",
    section: "11.12",
    table: 2,
    sweep: "rd-budget-holdout",
    resolve: byFormatAndBytes,
    labelColumn: 0,
    columns: {
      bytes: "bytes",
      "ΔE00 ↓": "meanCiede",
      "SSIM2 ↑": "meanSsimulacra2",
      "Butter ↓": "meanButteraugli",
      "DSSIM ↓": "meanDssim",
    },
    aliases: { "**ChromaHash compact**": "ChromaHash@21B" },
    note: "This table names the format in its first cell and the budget in its second, the reverse of §11.14.",
  },

  // §11 — stabilization. Every arm is a sweep row with paired statistics.
  {
    kind: "rows",
    section: "11.1",
    table: 0,
    sweep: "alpha-layout",
    columns: {
      ΔE00: "meanCiede",
      "Δ%": "ciedeDeltaPct",
      "paired 95% CI": "ci",
      "win/n": "winN",
    },
    aliases: {
      "**shipped** L20@5 C9@4": "SHIPPED L20@5 C9@4",
      "L22@4 C14@3 (the arithmetic in §8.1)": "L22@4 C14@3 (arithmetic)",
    },
  },
  {
    kind: "rows",
    section: "11.4",
    table: 0,
    sweep: "graphics-layout",
    columns: {
      ΔE00: "meanCiede",
      "Δ%": "ciedeDeltaPct",
      "paired 95% CI": "ci",
    },
    aliases: {
      "**DEFAULT** L28@4 C15@3": "DEFAULT L28@4 C15@3 (photo winner)",
    },
  },
  {
    kind: "rows",
    section: "11.4",
    table: 1,
    sweep: "graphics-encoder",
    columns: {
      ΔE00: "meanCiede",
      "Δ%": "ciedeDeltaPct",
      "paired 95% CI": "ci",
    },
    aliases: {
      "**DEFAULT** (full stack)": "DEFAULT (full stack)",
      "no encoder search (`scale_fit=0 ac_nearest=0`)": "no encoder search",
      "pre-adoption (everything off)": "pre-adoption (all off)",
      "`sel_hv = 0.30`": "sel_hv=0.30",
    },
  },
  {
    kind: "rows",
    section: "11.5",
    table: 0,
    sweep: "selection-weights",
    columns: {
      ΔE00: "meanCiede",
      "Δ%": "ciedeDeltaPct",
      "paired 95% CI": "ci",
      "win/n": "winN",
    },
    aliases: {
      "**DEFAULT** aniso 1.2 / hv 0.15": "DEFAULT aniso=1.2 hv=0.15",
      "isotropic (aniso 0, hv 0)": "isotropic (aniso=0 hv=0)",
      "**aniso 0.9 / hv 0.0**": "aniso=0.9 hv=0.0",
      "**aniso 1.2 / hv 0.0** (shipped aniso, `sel_hv` off)":
        "aniso=1.2 hv=0.0",
      "aniso 1.2 / hv 0.30": "aniso=1.2 hv=0.3",
      "aniso 2.0 / hv 0.30": "aniso=2.0 hv=0.3",
      "aniso 1.2 / hv −0.15": "aniso=1.2 hv=-0.15",
      "aniso 1.2 / hv −0.30": "aniso=1.2 hv=-0.3",
      "aniso 3.2 / hv 0.0": "aniso=3.2 hv=0.0",
    },
  },
  {
    kind: "rows",
    section: "11.6",
    table: 0,
    sweep: "companding-family",
    columns: { ΔE00: "meanCiede", "Δ%": "ciedeDeltaPct" },
    aliases: {
      "**µ-law µ_L=5 / µ_C=8 (shipped)**": "default (µ-law 5/8)",
      "µ_L=7": "mu_l=7",
      "µ_C=12": "mu_c=12",
      "A-law 87.6 (G.711)": "alaw 87.6 (L+C)",
      "power-law 0.75 (AAC/MP3)": "pow 0.75 (L+C)",
      "power-law 0.9": "pow 0.9 (L+C)",
      "Lloyd-Max L+C (trained on this corpus)": "Lloyd-Max L+C (trained)",
    },
  },
  {
    kind: "rows",
    section: "11.7",
    table: 0,
    sweep: "deadzone",
    columns: { ΔE00: "meanCiede", "Δ%": "ciedeDeltaPct" },
    aliases: {
      "**no deadzone (shipped)**": "default (no deadzone)",
      "`deadzone_l = 0.02`": "deadzone_l=0.02",
      "`deadzone_l = 0.05`": "deadzone_l=0.05",
      "both = 0.03": "deadzone both 0.03",
    },
  },
  {
    kind: "rows",
    section: "11.11",
    table: 0,
    sweep: "alpha-tier1",
    columns: {
      "tier-1 ΔE00": "meanCiede",
      "Δ%": "ciedeDeltaPct",
      SSIM2: "meanSsimulacra2",
      Butter: "meanButteraugli",
      αMAE: "meanAlphaMae",
    },
    aliases: {
      "shipped A5@4 L20@5 C9@4": "SHIPPED A5@4 L20@5 C9@4",
      "**A28@3 L22@4 C3@3** (the tier-0 choice)": "A28@3 L22@4 C3@3",
    },
  },

  // §11.14 — the current cross-format table. Keyed on format *and* budget,
  // because a family appears at several byte anchors.
  {
    kind: "rows",
    section: "11.14",
    table: 0,
    sweep: "rd-budget-holdout",
    labelColumn: 1,
    resolve: byFormatAndBytes,
    columns: {
      "ΔE00 ↓": "meanCiede",
      "SSIM2 ↑": "meanSsimulacra2",
      "Butter ↓": "meanButteraugli",
      "DSSIM ↓": "meanDssim",
    },
  },
];

// ─── Entry point ────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    section: { type: "string" },
    "list-unbound": { type: "boolean", default: false },
    fix: { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
  },
});

const tables = parseTables(readFileSync(DOC, "utf8"));
const bound = new Set(BINDINGS.map((b) => `${b.section}#${b.table ?? 0}`));

/**
 * Why a table carries no binding. A table absent from here is simply not bound
 * yet; a table listed here is verified by hand on purpose, and the reason is
 * the audit trail.
 */
const UNBOUND_NOTES: Record<string, string> = {
  "2#0":
    "superseded by §11.14 — the record of a round whose run is gone; its ChromaHash rows used a synthesized layout that no longer exists, and its competitor rows predate the cached rd-budget run",
  "8.6#0": "superseded by §11.14, same reason as §2",

  "4.2#0": "an allocation grid quoted at two budgets from one sweep",
  "4.2#1":
    "a precision-by-budget matrix: columns are budgets, rows are precisions, and every cell names a different arm",
  "4.4#0":
    "encoder levers quoted as a budget x lever matrix over encoder-compute.json",
  "4.7#0":
    "per-image oracle analysis derived from allocation-grid's perImageCiede, not a sweep row",
  "4.9#0": "coeff-stats output, not a sweep",
  "4.10#0": "coeff-stats output, not a sweep",
  "7.1#0": "pixel-domain SSE from the refine harness, not a corpus sweep",
  "7.2#0": "a chroma-weight row quoted across refine-objective's arms",
  "7.4#0":
    "the trained selection grid, quoted as a 2-D matrix over selection-hv.json",
  "7.6#0":
    "the compact tier vs ThumbHash, quoted from thumbhash-headtohead --split holdout; the same rows are bound in §4.3 table 1",
  "7.9#0": "per-image signalled selection, derived from §7.4's presets",
  "7.13#0": "entropy-budget output, not a sweep",
  "9.3#0":
    "old-corpus vs new-corpus figures; the old corpus no longer exists, which is the point of the section",
  "9.5#0":
    "curated-corpus vs Wikimedia-corpus figures; the curated corpus no longer exists, same reason as §9.3",
  "10.2#0": "decode timings, not a corpus measurement",
  "11.0#0": "a two-row scoring demonstration on one synthetic fixture",
  "11.2#0":
    "a control table whose two columns are two different sweeps, one arm each",
  "11.3#2":
    "an alpha subgroup breakdown computed from alpha-ceiling's perImageCiede",
  "11.12#0":
    "verdict prose: tune and holdout deltas quoted side by side from two sweeps",
  "11.12#1": "verdict prose, as §11.12 table 0",
};

if (values["list-unbound"]) {
  console.log("Tables in EXPERIMENTS.md with no binding:\n");
  for (const t of tables) {
    const key = `${t.section}#${t.index}`;
    if (bound.has(key)) continue;
    const why = UNBOUND_NOTES[key];
    const heading = `  §${t.section} table ${t.index} (line ${t.line})  ${t.header.join(" | ")}`;
    console.log(why ? `${heading}\n      ${why}` : heading);
  }
  process.exit(0);
}

const failures: Failure[] = [];
const stats = { cells: 0 };
const skipped: string[] = [];
let checked = 0;

for (const binding of BINDINGS) {
  if (values.section && binding.section !== values.section) continue;
  const table = tables.find(
    (t) => t.section === binding.section && t.index === (binding.table ?? 0),
  );
  if (!table) {
    skipped.push(`§${binding.section} table ${binding.table ?? 0}: not found`);
    continue;
  }
  const problem =
    binding.kind === "rows"
      ? checkRowTable(binding, table, failures, stats)
      : binding.kind === "row-ratio"
        ? checkRatioTable(binding, table, failures, stats)
        : checkColumnTable(binding, table, failures, stats);
  if (problem) {
    skipped.push(`§${binding.section} table ${binding.table ?? 0}: ${problem}`);
    continue;
  }
  checked++;
}

console.log(
  `Checked ${stats.cells} cells across ${checked} tables ` +
    `(${BINDINGS.length} bound of ${tables.length} in the document).`,
);
for (const s of skipped) console.log(`  SKIP  ${s}`);

// A missing sweep output is reported rather than fatal, so the tool stays
// useful on a machine that has run only part of section 6. That also means a
// table whose sweep nobody ran passes silently: three of this document's
// tables sat unreproducible behind a green run until the 2026-09 re-baseline
// (section 9.5), because section 6 never listed the holdout runs they bind to.
// `--strict` is for the case where every sweep is supposed to be on disk, and
// a SKIP means the document has drifted out of reach of its own evidence.
const strictFailed = values.strict && skipped.length > 0;
const reportStrict = () =>
  console.log(
    `\n--strict: ${skipped.length} table(s) could not be checked. Run the sweeps named above, or drop the binding.`,
  );

if (failures.length > 0) {
  console.log(`\n${failures.length} disagreement(s):\n`);
  for (const f of failures) {
    console.log(
      `  §${f.section}  ${f.row}  [${f.column}]\n` +
        `      document: ${f.claimed}\n` +
        `      measured: ${f.measured}`,
    );
  }

  if (values.fix) {
    const fixable = failures.filter((f) => f.fix !== undefined);
    const lines = readFileSync(DOC, "utf8").split("\n");
    for (const f of fixable) {
      const fix = f.fix;
      if (!fix) continue;
      // Header line + separator + the row's offset within the table body.
      const index = fix.line + 1 + fix.rowIndex;
      const line = lines[index];
      if (line === undefined) continue;
      const parts = line.split("|");
      // A row written `| a | b |` splits with empty ends, so cell n is part n+1.
      const target = parts[fix.colIndex + 1];
      if (target === undefined) continue;
      parts[fix.colIndex + 1] = ` ${fix.cell} `;
      lines[index] = parts.join("|");
    }
    writeFileSync(DOC, lines.join("\n"));
    console.log(
      `\nRewrote ${fixable.length} cell(s) in ${path.relative(REPO_ROOT, DOC)}.
Re-run without --fix to confirm, and read the diff: a corrected number can
invalidate the sentence beneath its table.`,
    );
  }
  if (strictFailed) reportStrict();
  process.exit(1);
}

if (strictFailed) {
  reportStrict();
  process.exit(1);
}
console.log("\nEvery bound table agrees with its sweep output.");
