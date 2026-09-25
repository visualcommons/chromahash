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
import {
  type Binding,
  CROSS_RUN_TOLERANCE,
  DECODE_STAGES_BASELINE,
  type Edit,
  type Failure,
  type ProseClaim,
  type Resolve,
  type RunDoc,
  Runs,
  STABILITY_MODE,
  STAGES_BASELINE,
  type StageCell,
  bare,
  MissingCell,
  cells,
  checkDecodeStagesProvenance,
  checkProseClaims,
  checkStability,
  checkStabilityClaim,
  checkStageRowCoverage,
  checkStagesProvenance,
  checkTable,
  clean,
  parseDecodeStages,
  parseStages,
  parseTables,
} from "./verify-benchmark-core.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DOC = path.join(REPO_ROOT, "spec/PERFORMANCE.md");
const BASELINE_DIR = path.join(REPO_ROOT, "tools/comparison/baselines");

/**
 * The committed runs, in the order a lookup prefers them. `perf-report-2.json`
 * is the second independent bounded sweep §0's stability claim needs: no
 * documented figure is read from it (every cell it holds, `perf-report.json`
 * holds first), but every shared cell is compared against the other runs.
 */
const BASELINES = [
  "perf-report-full.json",
  "perf-report.json",
  "perf-report-2.json",
] as const;

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
 *
 * `parseStages` (verify-benchmark-core.ts) decides what the file means, and
 * refuses a missing, unparseable, wrong-schema or empty one; this only reads it.
 */
const STAGES_PATH = path.join(BASELINE_DIR, STAGES_BASELINE);
const { cells: STAGES, error: STAGES_ERROR } = parseStages(
  existsSync(STAGES_PATH) ? readFileSync(STAGES_PATH, "utf8") : null,
);

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
 * §1.1's source: `benchmark:decode-stages`, the decode half of §1, bound the
 * same way and refused on the same terms by `parseDecodeStages`.
 */
const DECODE_STAGES_PATH = path.join(BASELINE_DIR, DECODE_STAGES_BASELINE);
const { cells: DECODE_STAGES, error: DECODE_STAGES_ERROR } = parseDecodeStages(
  existsSync(DECODE_STAGES_PATH)
    ? readFileSync(DECODE_STAGES_PATH, "utf8")
    : null,
);

/** §1.1's column headers -> the recorded cell key. */
const DECODE_STAGE_COLUMNS: Record<string, string> = {
  "t1 natural": "100x100-t1-natural",
  "t4 natural": "100x100-t4-natural",
  "t4 capped 32×32": "100x100-t4-cap32x32",
};

/**
 * Figures the prose derives from §1.1's table: the §1.1 sentences under it,
 * and their restatements in §12.1 item 4 and §12.3.
 */
const DECODE_PROSE_CLAIMS: ProseClaim[] = [
  {
    what: "§1.1: `gamma_lut`'s share of a tier-1 decode",
    pattern: /`gamma_lut` is\s+\*\*(\d+)%\*\*\s+of a tier-1 decode/,
    cell: "100x100-t1-natural",
    stages: ["gamma_lut"],
  },
  {
    what: "§1.1: `render`'s share of a tier-1 decode",
    pattern: /\(`render` is\s+\*\*(\d+)%\*\*\)/,
    cell: "100x100-t1-natural",
    stages: ["render"],
  },
  {
    what: "§1.1: the render loop's share of a natural tier-4 decode",
    pattern: /\*\*(\d+)%\*\*\s+of a natural tier-4 decode,\s+everything else/,
    cell: "100x100-t4-natural",
    stages: ["render"],
  },
  {
    what: "§1.1: `selection`'s share of a capped tier-4 decode",
    pattern: /is\s+\*\*(\d+)%\*\*\s+of what remains/,
    cell: "100x100-t4-cap32x32",
    stages: ["selection"],
  },
  {
    what: "§12.1 item 4(a): the gamma LUT, restated",
    pattern: /measures it at \*\*(\d+)%\*\* of a default-tier decode/,
    cell: "100x100-t1-natural",
    stages: ["gamma_lut"],
  },
  {
    what: "§12.1 item 4(b): the tier-4 render loop, restated",
    pattern: /puts that loop at \*\*(\d+)%\*\* of a natural tier-4 decode/,
    cell: "100x100-t4-natural",
    stages: ["render"],
  },
  {
    what: "§12.1 item 4(b): the tier-4 bound",
    pattern: /is bounded by (\d+)% there/,
    cell: "100x100-t4-natural",
    stages: ["render"],
  },
  {
    what: "§12.1 item 4(b): the tier-1 bound",
    pattern: /and by (\d+)% at tier 1/,
    cell: "100x100-t1-natural",
    stages: ["render"],
  },
  {
    what: "§12.3: the gamma LUT, restated",
    pattern: /the gamma LUT is \*\*(\d+)%\*\* of a default-tier decode/,
    cell: "100x100-t1-natural",
    stages: ["gamma_lut"],
  },
  {
    what: "§12.3: the tier-4 render loop, restated",
    pattern: /the render\s+loop \*\*(\d+)%\*\* of a tier-4 one/,
    cell: "100x100-t4-natural",
    stages: ["render"],
  },
];

/**
 * Figures the prose derives from §1's table, bound to the same baseline. Why
 * they exist, and how each is checked, is at `ProseClaim` and
 * `checkProseClaims` in verify-benchmark-core.ts.
 */
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
    section: "1.1",
    index: 0,
    title: "Where decode time goes (shares of one decode)",
    // Unlike §1, a row or column that resolves to nothing fails rather than
    // counting as deliberately unbound: every cell in this table is a share,
    // so there is no cell here that could legitimately be unbound.
    columns: Object.fromEntries(
      Object.entries(DECODE_STAGE_COLUMNS).map(([header, key]) => [
        header,
        (row: (h: string) => string) => {
          const label = clean(row("stage"));
          const share = DECODE_STAGES?.[key]?.sharePct[label];
          if (share === undefined) {
            throw new MissingCell(`${DECODE_STAGES_BASELINE} ${key} ${label}`);
          }
          return share;
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

const runs = new Runs(
  BASELINES.filter((file) => existsSync(path.join(BASELINE_DIR, file))).map(
    (file) => ({
      ...(JSON.parse(
        readFileSync(path.join(BASELINE_DIR, file), "utf8"),
      ) as RunDoc),
      file,
    }),
  ),
);
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
// §1.1 on the same terms: bound means required.
const decodeStagesBound = BINDINGS.some(
  (b) =>
    b.section === "1.1" && (!values.section || values.section === b.section),
);
if (decodeStagesBound && !DECODE_STAGES) {
  console.error(
    [
      `No committed decode-stages run for PERFORMANCE.md §1.1: ${DECODE_STAGES_ERROR ?? "unavailable"}`,
      "",
      "§1.1 sizes §12.1 item 4 and is bound cell by cell to this artifact,",
      "together with the figures §1.1, §12.1 and §12.3 derive from it.",
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

// Two committed runs of the same cell disagreeing by more than §0's bar means
// the host did not hold its clock still, and every figure drawn from either run
// is no tighter than that. This used to be a printed warning, which left §0's
// stability claim resting on the maintainer's word; it now fails the gate.
const spreadPct = (CROSS_RUN_TOLERANCE * 100).toFixed(0);
for (const c of runs.crossRunSpread) {
  failures.push({
    where: "committed runs",
    column: "cross-run spread",
    row: c.split(":")[0] ?? "—",
    documented: `within ${spreadPct}% across runs`,
    measured: "outside",
    detail: c,
  });
}

// §0's host-stability claim: two bounded sweeps at one commit. With fewer than
// two committed the check is skipped and said to be; with two it must pass,
// and §0's table row must say what the check says.
const stability = checkStability(runs);
const stabilityWidest =
  stability.widest === null
    ? ""
    : `, widest ${(stability.widest * 100).toFixed(1)}%`;
const stabilityDetail =
  stability.status === "skip"
    ? stability.problems.join("; ")
    : `${stability.runs.join(" vs ")}: ${stability.shared} shared cells${stabilityWidest}`;
console.log(
  `Host stability (§0): ${stability.status.toUpperCase()} — ${stabilityDetail}`,
);
console.log();
if (stability.status === "fail") {
  failures.push({
    where: "committed runs",
    column: "host stability",
    row: stability.runs.join(" vs "),
    documented: `two ${STABILITY_MODE} runs, one commit, within ${spreadPct}%`,
    measured: "fail",
    detail: stability.problems.join("; "),
  });
}
if (!values.section || values.section === "0") {
  failures.push(...checkStabilityClaim(doc, stability));
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

// §1's provenance (one clean commit across all three columns) and the prose
// figures derived from its table: `checkStagesProvenance` and
// `checkProseClaims` in verify-benchmark-core.ts.
let proseChecked = 0;
if (STAGES) {
  failures.push(...checkStagesProvenance(STAGES));
  const prose = checkProseClaims(doc, STAGES, PROSE_CLAIMS);
  failures.push(...prose.failures);
  proseChecked = prose.checked;
}

// §1.1: provenance (one clean commit, each cell reproduced the spec vectors,
// shares agree with ns), a table that has every column and exactly the
// recorded stages as rows, and the prose figures derived from it.
let decodeProseChecked = 0;
if (decodeStagesBound && DECODE_STAGES) {
  failures.push(...checkDecodeStagesProvenance(DECODE_STAGES));
  const table = tables.find((t) => t.section === "1.1" && t.index === 0);
  if (table) {
    const where = `§1.1 Where decode time goes (line ${table.line})`;
    const headers = table.header.map((h) => clean(h));
    for (const [header, key] of Object.entries(DECODE_STAGE_COLUMNS)) {
      if (!headers.includes(header)) {
        failures.push({
          where,
          column: header,
          row: "—",
          documented: "(column missing)",
          measured: key,
          detail:
            "a bound column the table no longer has is a cell nothing checks",
        });
      }
      const cell = DECODE_STAGES[key];
      if (!cell) {
        failures.push({
          where: DECODE_STAGES_BASELINE,
          column: header,
          row: "—",
          documented: key,
          measured: "(no cell)",
          detail: "record it with `mise run benchmark:decode-stages`",
        });
      }
    }
    const bound: Record<string, StageCell> = {};
    for (const key of Object.values(DECODE_STAGE_COLUMNS)) {
      const cell = DECODE_STAGES[key];
      if (cell) bound[key] = cell;
    }
    failures.push(
      ...checkStageRowCoverage(
        table.rows.map((r) => clean(r[0] ?? "")),
        bound,
        where,
      ),
    );
  } else {
    // `checkTable`'s loop only lists a missing table as SKIP; for a table
    // whose baseline is committed, losing the table is losing every check.
    failures.push({
      where: "PERFORMANCE.md §1.1",
      column: "table",
      row: "—",
      documented: "(not found)",
      measured: DECODE_STAGES_BASELINE,
      detail:
        "the decode-stages table is gone while its baseline is committed, so none of its cells is checked",
    });
  }
  const prose = checkProseClaims(
    doc,
    DECODE_STAGES,
    DECODE_PROSE_CLAIMS,
    DECODE_STAGES_BASELINE,
  );
  failures.push(...prose.failures);
  decodeProseChecked = prose.checked;
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
console.log(
  `Checked ${decodeProseChecked} figure(s) the prose derives from §1.1's table.`,
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
