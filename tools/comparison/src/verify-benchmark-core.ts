/**
 * The pure parts of `verify-benchmark.ts`: how PERFORMANCE.md is read, how the
 * committed runs are merged, and every rule that decides whether a documented
 * cell passes, fails or is skipped.
 *
 * Split out of the CLI for the reason `stratify-core.ts` was: the gate does its
 * work at module scope — it parses argv, reads the document and the baselines
 * off disk, prints and exits — so importing it to check any of this would run
 * it. These are the parts that can be wrong without throwing, and a gate that is
 * wrong without throwing reports green, so they are asserted in
 * `metric-selftest.ts` against fixtures with known answers. The file reads, the
 * table bindings and the exit status stay in the CLI.
 */

// ─── The document, as tables ────────────────────────────────────────────────

export interface DocTable {
  section: string;
  index: number;
  line: number;
  header: string[];
  rows: string[][];
  /** Source line of each row, parallel to `rows`, for --fix. */
  rowLines: number[];
}

export const clean = (s: string): string => s.replace(/[*`]/g, "").trim();

export function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isSeparator = (line: string): boolean =>
  /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-");

export function parseTables(markdown: string): DocTable[] {
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

export function parseUnavailableMarker(raw: string): string | null {
  // The raw cell, not `clean(raw)` — `clean` strips the emphasis that
  // constraint 1 depends on.
  const m = MARKER_RE.exec(raw.trim());
  return m?.[1] ? `${m[1]} only` : null;
}

const TIME_UNITS = new Set<Unit>(["us", "ms", "s"]);
const PER_US: Record<string, number> = { us: 1, ms: 1e3, s: 1e6 };

// ─── The committed runs ─────────────────────────────────────────────────────

/** The run format this document's figures are defined against. */
export const SCHEMA = "chromahash-perf/2";

/**
 * Two runs of the same cell agree to about this much on a quiet machine. Used
 * only to flag disagreement *between* the committed runs, never to accept a
 * documented number — those are checked exactly.
 */
export const CROSS_RUN_TOLERANCE = 0.1;

interface Cell {
  id: string;
  /** chromahash-perf/2. Older runs reported the median as the headline. */
  nsPerOp?: number;
  medianNsPerOp: number;
  iqrPct: number;
  noisy: boolean;
  iters: number;
}

export interface RunDoc {
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

export function classify(kind: string | undefined): Availability {
  return kind === "absent" || kind === "broken" ? kind : "unclassified";
}

export class Runs {
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

  /**
   * The committed runs, parsed, in the order a lookup prefers them. Each is
   * tagged with the baseline file it was read from; reading them is the CLI's
   * job, so a fixture can stand in for a file.
   */
  constructor(docs: RunDoc[]) {
    for (const doc of docs) {
      const file = doc.file;

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

export class MissingCell extends Error {
  constructor(readonly id: string) {
    super(`no cell "${id}" in any committed run`);
  }
}

// ─── Bindings ───────────────────────────────────────────────────────────────

/** Reads a named column out of the row being checked. */
export type Row = (column: string) => string;
export type Resolve = (row: Row, R: Runs) => number | null;

export interface Binding {
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
export const bare = (s: string): string =>
  clean(s)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();

// ─── §1's stages baseline ───────────────────────────────────────────────────

export const STAGES_BASELINE = "perf-stages.json";
export const STAGES_SCHEMA = "chromahash-perf-stages/1";

export interface StageCell {
  ns: Record<string, number>;
  sharePct: Record<string, number>;
  git: { rev: string; dirty: boolean };
}

/**
 * The stages baseline, or the reason there is none. `text` is the file's
 * contents, or null when there is no file.
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
export function parseStages(text: string | null): {
  cells: Record<string, StageCell> | null;
  error: string | null;
} {
  const where = `tools/comparison/baselines/${STAGES_BASELINE}`;
  if (text === null) {
    return {
      cells: null,
      error: `${where} does not exist — record §1's three columns with \`mise run benchmark:stages 100 100 1\`, \`… 512 512 1\`, \`… 512 512 4\``,
    };
  }
  let doc: { schema?: string; cells?: Record<string, StageCell> };
  try {
    doc = JSON.parse(text) as typeof doc;
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
export interface ProseClaim {
  what: string;
  /** Must match exactly once in the document, capturing the figure. */
  pattern: RegExp;
  /** The cell key in `perf-stages.json`. */
  cell: string;
  /** Stages to sum; a single-element list is a single cell. */
  stages: string[];
}

// ─── Checking ───────────────────────────────────────────────────────────────

export interface Failure {
  where: string;
  column: string;
  row: string;
  documented: string;
  measured: string;
  detail?: string;
}

/** One cell `--fix` will rewrite: line in the document, column, new text. */
export interface Edit {
  line: number;
  cellIndex: number;
  text: string;
}

export interface Counters {
  checked: number;
  unbound: number;
  placeholders: number;
  unavailable: number;
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

export function checkTable(
  binding: Binding,
  table: DocTable,
  R: Runs,
  failures: Failure[],
  counters: Counters,
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

/**
 * §1's baseline gets the provenance check its sibling already had. A stages
 * file is *merged* one cell per run — the table is three columns and each is
 * its own invocation — so it is the one artifact here that can hold cells from
 * three different builds and read as one measurement. Nothing looked. The
 * dirty flag was recorded on every cell and read on none, while the same flag
 * on a perf-report has failed the run since that check was written.
 */
export function checkStagesProvenance(
  stages: Record<string, StageCell>,
): Failure[] {
  const failures: Failure[] = [];
  const dirty = Object.entries(stages)
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
  for (const [key, cell] of Object.entries(stages)) {
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
  return failures;
}

/**
 * The prose figures §1 derives from its own table. Checked against the same
 * baseline the table is checked against, and to the precision the sentence
 * itself claims — the same tolerance rule the cells use, so tightening a figure
 * in the document tightens the assertion on it.
 */
export function checkProseClaims(
  doc: string,
  stages: Record<string, StageCell>,
  claims: readonly ProseClaim[],
): { failures: Failure[]; checked: number } {
  const failures: Failure[] = [];
  let checked = 0;
  for (const claim of claims) {
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
    const cell = stages[claim.cell];
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
    checked++;
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
  return { failures, checked };
}
