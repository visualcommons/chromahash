/**
 * The figures `spec/PERFORMANCE.md` §12.4 quotes from the committed
 * `benchmark:counts` records under
 * `tools/comparison/results/counts/ab/`, each checked against the record it
 * comes from. They are the evidence `Tunables::DEFAULT`'s levers rest on (#142),
 * so a re-recorded count that moves one must fail here rather than leave the
 * document arguing from the old number. `verify:claims` runs it; it reads
 * committed files only.
 *
 * The table's two count columns are each arm's median per-operation count,
 * floored, as the document prints whole instructions; its ratio column is the
 * record's geometric-mean ratio at the decimals the document quotes. Each row
 * is also held to the record's cell and its arms, so a row cannot quote one
 * record under another's label.
 */

import { decimals, parseTables } from "../doc-tables.ts";
import type { CountsRecord } from "./counts-core.ts";
import { ACCEL_NONE } from "./matrix.ts";

export const COUNTS_DOC = "spec/PERFORMANCE.md";
/** §12.4's counts table: the section and its index within it. */
export const COUNTS_SECTION = "12.4";
export const COUNTS_TABLE = 1;

/** One row of §12.4's counts table and the record it quotes. */
export interface CountRow {
  lever: string;
  cell: string;
  /** Record file name under `results/counts/ab/`. */
  record: string;
  /** The reference arm's tune (A), which turns the row's lever(s) off. */
  refTune: string;
  /** The shipped arm's tune (B). */
  shippedTune: string;
}

export const COUNT_ROWS: readonly CountRow[] = [
  {
    lever: "accel_quant_table",
    cell: "encode 100×100 t1",
    record: "accel-quant-table.json",
    refTune: "accel_quant_table=0",
    shippedTune: "",
  },
  {
    lever: "accel_dct_lanes",
    cell: "encode 512×512 t1",
    record: "accel-dct-lanes.json",
    refTune: "accel_dct_lanes=0",
    shippedTune: "",
  },
  {
    lever: "accel_gamma_lut_cache",
    cell: "decode 100×100 t1",
    record: "accel-gamma-lut-cache.json",
    refTune: "accel_gamma_lut_cache=0",
    shippedTune: "",
  },
  {
    lever: "accel_flat_cos",
    cell: "decode 100×100 t4",
    record: "accel-flat-cos.json",
    refTune: "accel_flat_cos=0",
    shippedTune: "",
  },
  {
    lever: "accel_sse_early_exit",
    cell: "encode 100×100 t1, refine_passes=1",
    record: "accel-sse-early-exit.json",
    refTune: "refine_passes=1 accel_sse_early_exit=0",
    shippedTune: "refine_passes=1",
  },
  {
    lever: "accel_word_bitpack",
    cell: "encode 100×100 t4",
    record: "accel-word-bitpack-t4.json",
    refTune: "accel_word_bitpack=0",
    shippedTune: "",
  },
  {
    lever: "accel_word_bitpack",
    cell: "encode 100×100 t1",
    record: "accel-word-bitpack.json",
    refTune: "accel_word_bitpack=0",
    shippedTune: "",
  },
  {
    lever: "every lever off",
    cell: "encode 512×512 t1",
    record: "accel-none-encode.json",
    refTune: ACCEL_NONE,
    shippedTune: "",
  },
  {
    lever: "every lever off",
    cell: "decode 100×100 t1",
    record: "accel-none-decode.json",
    refTune: ACCEL_NONE,
    shippedTune: "",
  },
  {
    // Re-recorded by #165, which made the fused pass a reduction and a
    // default; #142's record of it, an increase, is in that file's history.
    lever: "accel_fused_pixels",
    cell: "encode 512×512 t1",
    record: "accel-fused-pixels.json",
    refTune: "accel_fused_pixels=0",
    shippedTune: "",
  },
  // #165's selection prefix and EOTF table cache have no flag: each row's
  // two arms are two builds, the reference the commit before the change
  // (`arms.a.bin` and its hash), under the same shipped tune.
  {
    lever: "selection prefix",
    cell: "decode 100×100 t1",
    record: "selection-prefix-decode-100-t1.json",
    refTune: "",
    shippedTune: "",
  },
  {
    lever: "selection prefix",
    cell: "encode 100×100 t1",
    record: "selection-prefix-encode-100-t1.json",
    refTune: "",
    shippedTune: "",
  },
  {
    lever: "selection prefix",
    cell: "encode 512×512 t4",
    record: "selection-prefix-encode-512-t4.json",
    refTune: "",
    shippedTune: "",
  },
  {
    lever: "EOTF table cache",
    cell: "encode 100×100 t1",
    record: "eotf-lut-cache-encode-100-t1.json",
    refTune: "",
    shippedTune: "",
  },
  {
    lever: "EOTF table cache",
    cell: "encode 512×512 t1",
    record: "eotf-lut-cache-encode-512-t1.json",
    refTune: "",
    shippedTune: "",
  },
];

const INSTR = "instructions:u";
const reference = (r: CountsRecord): number =>
  Math.floor(r.summary.a.median[INSTR]);
const shipped = (r: CountsRecord): number =>
  Math.floor(r.summary.b.median[INSTR]);
const ratio = (r: CountsRecord): number => r.summary.ratio.geomean[INSTR];

/** A figure quoted in prose, and how to compute it from its record. */
export interface CountProse {
  file: string;
  what: string;
  /** Captures the quoted figure in group 1; must match exactly once. */
  pattern: RegExp;
  record: string;
  value: (r: CountsRecord) => number;
}

export const COUNT_PROSE: readonly CountProse[] = [
  {
    file: COUNTS_DOC,
    what: "§12.4: accel_word_bitpack's saving at tier 4",
    pattern: /it removes ([\d,]+) instructions per encode/,
    record: "accel-word-bitpack-t4.json",
    value: (r) => reference(r) - shipped(r),
  },
  {
    file: COUNTS_DOC,
    what: "§12.4: accel_word_bitpack's cost at tier 1",
    pattern: /it costs ([\d,]+) more out of [\d.]+ million/,
    record: "accel-word-bitpack.json",
    value: (r) => shipped(r) - reference(r),
  },
  {
    file: COUNTS_DOC,
    what: "§12.4: a tier-1 encode's instructions, in millions",
    pattern: /it costs [\d,]+ more out of ([\d.]+) million/,
    record: "accel-word-bitpack.json",
    value: (r) => shipped(r) / 1e6,
  },
];

const strip = (s: string): string => s.replace(/[*`]/g, "").trim();
const number = (raw: string): number => Number(strip(raw).replace(/,/g, ""));
/** Half a unit in the last place the quote gives. */
const tolerance = (raw: string): number =>
  0.5 * 10 ** -decimals(strip(raw).replace(/,/g, ""));

/** The record cell's label as the table writes it. */
export function cellLabel(r: CountsRecord, shippedTune: string): string {
  const base = `${r.cell.op} ${r.cell.width}×${r.cell.height} t${r.cell.tier}`;
  return shippedTune ? `${base}, ${shippedTune}` : base;
}

/**
 * Every disagreement between the quoting files and the records, as one line
 * each; empty when every quoted count agrees. `read` returns a repo-relative
 * file's text, and `load` a record by file name.
 */
export function countClaimFailures(
  read: (file: string) => string,
  load: (record: string) => CountsRecord,
  rows: readonly CountRow[] = COUNT_ROWS,
  prose: readonly CountProse[] = COUNT_PROSE,
): string[] {
  const out: string[] = [];
  const table = parseTables(read(COUNTS_DOC)).find(
    (t) => t.section === COUNTS_SECTION && t.index === COUNTS_TABLE,
  );
  const header = (table?.header ?? []).map(strip).join(" | ");
  if (!table || header !== "lever | cell | reference | shipped | ratio") {
    return [
      `${COUNTS_DOC} §${COUNTS_SECTION} table ${COUNTS_TABLE} is not the counts table (header: ${header || "none"})`,
    ];
  }
  if (table.rows.length !== rows.length) {
    out.push(
      `${COUNTS_DOC} §${COUNTS_SECTION}'s counts table has ${table.rows.length} rows; ${rows.length} are bound`,
    );
  }
  for (const row of rows) {
    const where = `§${COUNTS_SECTION} "${row.lever}" / "${row.cell}"`;
    const hits = table.rows.filter(
      (cs) =>
        strip(cs[0] ?? "") === row.lever && strip(cs[1] ?? "") === row.cell,
    );
    if (hits.length !== 1) {
      out.push(`${where}: ${hits.length} rows, expected one`);
      continue;
    }
    const cs = hits[0] ?? [];
    let r: CountsRecord;
    try {
      r = load(row.record);
    } catch (e) {
      out.push(`${where}: ${row.record}: ${(e as Error).message}`);
      continue;
    }
    if (cellLabel(r, row.shippedTune) !== row.cell) {
      out.push(
        `${where}: ${row.record} counts ${cellLabel(r, r.arms.b.tune)}, not ${row.cell}`,
      );
    }
    if (r.arms.a.tune !== row.refTune || r.arms.b.tune !== row.shippedTune) {
      out.push(
        `${where}: ${row.record}'s arms are "${r.arms.a.tune}" / "${r.arms.b.tune}", not "${row.refTune}" / "${row.shippedTune}"`,
      );
    }
    if (!r.outputs.equal) {
      out.push(`${where}: ${row.record}'s arms produced different outputs`);
    }
    const columns: [string, string, number][] = [
      ["reference", cs[2] ?? "", reference(r)],
      ["shipped", cs[3] ?? "", shipped(r)],
      ["ratio", cs[4] ?? "", ratio(r)],
    ];
    for (const [name, raw, want] of columns) {
      const got = number(raw);
      if (!Number.isFinite(got) || Math.abs(got - want) > tolerance(raw)) {
        out.push(
          `${where} / "${name}": quotes ${strip(raw)}, ${row.record} gives ${want}`,
        );
      }
    }
  }
  for (const p of prose) {
    const all = [...read(p.file).matchAll(new RegExp(p.pattern, "g"))];
    if (all.length !== 1 || all[0]?.[1] === undefined) {
      out.push(
        `${p.file} — ${p.what}: the pattern matches ${all.length} times; it must name one figure`,
      );
      continue;
    }
    const raw = all[0][1];
    let want: number;
    try {
      want = p.value(load(p.record));
    } catch (e) {
      out.push(`${p.file} — ${p.what}: ${p.record}: ${(e as Error).message}`);
      continue;
    }
    const got = number(raw);
    if (!Number.isFinite(got) || Math.abs(got - want) > tolerance(raw)) {
      out.push(
        `${p.file} — ${p.what}: quotes ${raw}, ${p.record} gives ${want}`,
      );
    }
  }
  return out;
}
