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
 * written by hand below. A documented value passes when it lies inside the
 * cell's interval across processes, or within `TOLERANCE` of the committed run
 * (`agreement` in verify-benchmark-core.ts). It used to have to equal the
 * run's rounded output exactly, which made every re-measurement rewrite the
 * whole document: the diff of a re-run was noise, and a figure that really
 * moved could not be seen in it.
 *
 * Usage:
 *   node dist/verify-benchmark.js                # every bound table and figure
 *   node dist/verify-benchmark.js --list-unbound # tables with no binding, and why
 *   node dist/verify-benchmark.js --list-cells   # every cell id the runs provide
 *   node dist/verify-benchmark.js --section 7
 *   node dist/verify-benchmark.js --fix          # rewrite out-of-band figures
 *
 * Exit status is non-zero on any disagreement, so `mise run verify:benchmark`
 * gates a documentation change the way `mise run rd:gate` gates a quality one.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { planMatrix } from "./perf/plan.ts";
import {
  gitView,
  judgeProvenance,
  provenanceFails,
} from "./perf/provenance.ts";
import { allTargets } from "./perf/targets.ts";
import {
  type Binding,
  type ClaimContext,
  CROSS_RUN_TOLERANCE,
  type Counters,
  DECODE_STAGES_BASELINE,
  type Estimate,
  type Failure,
  LEGACY_SCHEMA,
  type ProseClaim,
  type ProseEdit,
  type Resolve,
  type RunDoc,
  Runs,
  STABILITY_MODE,
  STAGES_BASELINE,
  type StageCell,
  type SweepClaim,
  TOLERANCE,
  applyEdits,
  bare,
  MissingCell,
  checkDecodeStagesProvenance,
  checkProseClaims,
  checkStability,
  checkStabilityClaim,
  checkStageRowCoverage,
  checkStagesProvenance,
  checkSweepClaims,
  checkTable,
  clean,
  parseDecodeStages,
  parseStages,
  parseTables,
  runFailures,
} from "./verify-benchmark-core.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DOC = path.join(REPO_ROOT, "spec/PERFORMANCE.md");
const BASELINE_DIR = path.join(REPO_ROOT, "tools/comparison/baselines");

/**
 * The committed sweeps live per host: `baselines/hosts/<host>/`, where `<host>`
 * is the run's OS, architecture and CPU model, slugged (`perf/host.ts`). The
 * cross-run spread and §0's stability check compare runs of one host only, so
 * a macOS run can be committed as its own set — the one place Swift can be
 * measured — without failing a spread against Linux it was never meant to
 * match.
 *
 * `PRIMARY` names the host the document is measured on. Its bounded runs are
 * authoritative; its full run supplements them; another host is read only for
 * a target the primary host recorded absent.
 */
const HOSTS_DIR = path.join(BASELINE_DIR, "hosts");
const PRIMARY_FILE = path.join(HOSTS_DIR, "PRIMARY");

/**
 * The files a host directory may hold, in the order a lookup prefers them:
 * the bounded pair §0's stability claim needs, then the full supplement.
 */
const BASELINES = [
  "perf-report.json",
  "perf-report-2.json",
  "perf-report-full.json",
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

/** Scale an estimate and its interval by a constant. */
const scaled = (e: Estimate, k: number): Estimate => ({
  value: e.value * k,
  interval: e.interval ? [e.interval[0] * k, e.interval[1] * k] : null,
});

/**
 * A lever's time relative to its base, in percent: −36.3% is 0.637× the base.
 * Read off the paired ratio (base ÷ arm) where the run recorded one, interval
 * and all.
 */
const vsBase = (r: Estimate): Estimate => {
  const pct = (x: number) => (1 / x - 1) * 100;
  return {
    value: pct(r.value),
    interval: r.interval
      ? [pct(Math.max(...r.interval)), pct(Math.min(...r.interval))]
      : null,
  };
};

/** A lever's cell id, keyed by the arm label the driver records. */
const armId = (n: number, arm: string): string =>
  `encode/Rust/t1/${n}x${n}/gradient/${bare(arm)}`;

function timeOr(R: Runs, id: string): Estimate | null {
  return R.has(id) ? R.est(id) : null;
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
  // What was one residual, `quantize_and_pack`, until these four had marks.
  dc_search: "dc_search",
  ac_quantize: "ac_quantize",
  refine: "refine",
  pack: "pack",
  unmarked: "unmarked",
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
    what: "§1: `ac_quantize`'s share at 100x100 t1, quoted in prose",
    pattern: /At 100×100, `ac_quantize` is ([\d.]+)%\*\*/,
    cell: "100x100-t1",
    stages: ["ac_quantize"],
  },
  {
    what: "§1: `unmarked`'s share at 512x512 t1, quoted in prose",
    pattern: /negligible at 100×100, and ([\d.]+)% at 512×512/,
    cell: "512x512-t1",
    stages: ["unmarked"],
  },
  {
    what: "§12 summary: the searches' share of the old residual at 100x100 t1",
    pattern: /the searches are\s+([\d.]+) of its old/,
    cell: "100x100-t1",
    stages: ["ac_quantize"],
  },
  {
    what: "§12.1: `ac_quantize` at 100x100 t1, after the table",
    pattern: /`ac_quantize`, which is ([\d.]+)% of a thumbnail encode/,
    cell: "100x100-t1",
    stages: ["ac_quantize"],
  },
  {
    what: "§12.1: `ac_quantize` at 512x512 t1, after the table",
    pattern: /of a thumbnail encode\nand ([\d.]+)% of a photograph/,
    cell: "512x512-t1",
    stages: ["ac_quantize"],
  },
  {
    what: "§12.1: `dc_search` at 100x100 t1",
    pattern: /is `dc_search` at ([\d.]+)%/,
    cell: "100x100-t1",
    stages: ["dc_search"],
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
    what: "§12 summary: `ac_quantize`, restated",
    pattern: /`ac_quantize` is \*\*([\d.]+)%\*\* of a 100×100 one/,
    cell: "100x100-t1",
    stages: ["ac_quantize"],
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
    what: "§1: `dct_forward`'s share at 512x512 t1, quoted in prose",
    pattern: /encode, ([\d.]+)% at 512×512, and/,
    cell: "512x512-t1",
    stages: ["dct_forward"],
  },
  {
    what: "§5: `oklab_forward`, the stage SIMD covers",
    pattern: /prices that stage at \*\*([\d.]+)%\*\* of a 512×512 encode/,
    cell: "512x512-t1",
    stages: ["oklab_forward"],
  },
  {
    what: "§5: the SIMD ceiling",
    pattern: /So the ceiling was ([\d.]+)%/,
    cell: "512x512-t1",
    stages: ["oklab_forward"],
  },
  {
    what: "§6: `dct_forward`'s share, against the SIMD stage",
    pattern: /at ([\d.]+)% of the work rather than/,
    cell: "512x512-t1",
    stages: ["dct_forward"],
  },
  {
    what: "§6: `oklab_forward`'s share, the stage SIMD covers",
    pattern: /on the ([\d.]+)% stage `simd` covers/,
    cell: "512x512-t1",
    stages: ["oklab_forward"],
  },
  {
    what: "§10 lever 1: `dct_forward` at 512x512 t1",
    pattern: /§1 puts it at ([\d.]+)% of a 512×512 encode/,
    cell: "512x512-t1",
    stages: ["dct_forward"],
  },
  {
    what: "§10 lever 1: `dct_forward` at 512x512 t4",
    pattern: /of a 512×512 encode and ([\d.]+)%\s+at tier 4/,
    cell: "512x512-t4",
    stages: ["dct_forward"],
  },
  {
    what: "§12 summary: `dct_forward` at 512x512 t1, restated",
    pattern: /the forward DCT is \*\*([\d.]+)%\*\* of a 512×512/,
    cell: "512x512-t1",
    stages: ["dct_forward"],
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
    rule: "share",
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
    rule: "share",
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
        return t === null ? null : R.est(`encode/Rust/t${t}/100x100/gradient`);
      },
      decode: (row, R) => {
        const t = tierOf(row("tier"));
        return t === null ? null : R.est(`decode/Rust/t${t}/natural`);
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
        return t === null ? null : R.est(`decode/Rust/t${t}/natural`);
      },
      "capped 32×32": (row, R) => {
        const t = tierOf(row("tier"));
        return t === null ? null : R.est(`decode/Rust/t${t}/capped32`);
      },
      saving: (row, R) => {
        const t = tierOf(row("tier"));
        if (t === null) return null;
        return R.ratio(
          `decode/Rust/t${t}/natural`,
          `decode/Rust/t${t}/capped32`,
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
        return n === null ? null : R.est(`encode/Rust/t1/${n}x${n}/gradient`);
      },
      "per megapixel": (row, R) => {
        const n = sizeOf(row("source"));
        if (n === null) return null;
        // Microseconds per megapixel. Return it unconverted: agrees() applies
        // the column's own unit (the document writes ms), and a conversion here
        // as well would divide by 1000 twice.
        return scaled(
          R.est(`encode/Rust/t1/${n}x${n}/gradient`),
          1e6 / (n * n),
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
        return vsBase(R.ratio(base, arm));
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
          : R.est(`encode/Rust/t${t}/${n}x${n}/gradient`);
      },
      scalar: (row, R) => {
        const n = sizeOf(row("source"));
        const t = tierOf(row("tier"));
        return n === null || t === null
          ? null
          : R.est(`encode/Rust (scalar)/t${t}/${n}x${n}/gradient`);
      },
      gain: (row, R) => {
        const n = sizeOf(row("source"));
        const t = tierOf(row("tier"));
        if (n === null || t === null) return null;
        return R.ratio(
          `encode/Rust (scalar)/t${t}/${n}x${n}/gradient`,
          `encode/Rust/t${t}/${n}x${n}/gradient`,
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
        return R.ratio(direct, sep);
      },
    },
  },
  {
    section: "12.4",
    index: 1,
    title: "§12.1's encode levers, built: speedup at tier 1",
    // `R.us`, not `timeOr`: a lever cell no committed run holds is a missing
    // measurement, and must fail as one rather than count as deliberately
    // unbound — these rows exist only to carry a number.
    columns: Object.fromEntries(
      [100, 256, 512].map((n) => [
        `${n}×${n}`,
        (row: (h: string) => string, R: Runs) => {
          const arm = clean(row("lever"));
          // The early exit acts only inside refinement, so its baseline is
          // the refinement arm, not the shipped encode.
          const base = arm.startsWith("refine_passes=1 ")
            ? "refine_passes=1"
            : "shipped";
          return R.ratio(armId(n, base), armId(n, arm));
        },
      ]),
    ) as Record<string, Resolve>,
  },
  {
    section: "12.4",
    index: 2,
    title: "§12.1's encode levers, built: tier 4 at 100x100",
    columns: {
      encode: (row, R) =>
        R.est(`encode/Rust/t4/100x100/gradient/${clean(row("lever"))}`),
      speedup: (row, R) => {
        const arm = clean(row("lever"));
        if (arm === "shipped") return null;
        return R.ratio(
          "encode/Rust/t4/100x100/gradient/shipped",
          `encode/Rust/t4/100x100/gradient/${arm}`,
        );
      },
    },
  },
  {
    section: "12.4",
    index: 3,
    title: "§12.1's decode levers, built: speedup",
    columns: Object.fromEntries(
      (
        [
          ["t1 natural", "t1/natural"],
          ["t4 natural", "t4/natural"],
          ["t4 capped 32×32", "t4/capped32"],
        ] as const
      ).map(([header, raster]) => [
        header,
        (row: (h: string) => string, R: Runs) =>
          R.ratio(
            `decode/Rust/${raster}/shipped`,
            `decode/Rust/${raster}/${clean(row("lever"))}`,
          ),
      ]),
    ) as Record<string, Resolve>,
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
        const t = clean(row("implementation"));
        const one = `batch/${t}/t1/100x100/threads=1`;
        const auto = `batch/${t}/t1/100x100/threads=auto`;
        return R.has(one) && R.has(auto) ? R.ratio(one, auto) : null;
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
): Estimate | null {
  const t = clean(raw);
  const id =
    op === "encode"
      ? `encode/${t}/t${tier}/100x100/gradient`
      : `decode/${t}/t${tier}/natural`;
  return timeOr(R, id);
}

function batch(raw: string, R: Runs, threads: string): Estimate | null {
  const id = `batch/${clean(raw)}/t1/100x100/threads=${threads}`;
  const us = timeOr(R, id);
  return us === null ? null : scaled(us, 1 / BATCH_COUNT);
}

// ─── Figures the prose derives from the sweeps ──────────────────────────────
//
// The sentences under §2–§6 and in §10–§12 restate table figures — §5's 2%,
// §6's 34.0 ms and 38×, §2's 234 ms — and nothing checked them, so a
// re-measurement that moved a table left its sentences behind. Each is bound
// here the way PROSE_CLAIMS binds §1's. Where the figure needs a measurement
// no committed run holds yet, the document writes TBD and the gate fails on
// it by name (`checkSweepClaims`).

const t1 = (n: number) => `encode/Rust/t1/${n}x${n}/gradient`;
const scalarT1 = (n: number) => `encode/Rust (scalar)/t1/${n}x${n}/gradient`;
const gain = (R: Runs, n: number): Estimate => R.ratio(scalarT1(n), t1(n));
const asPct = (e: Estimate): Estimate => ({
  value: (e.value - 1) * 100,
  interval: e.interval
    ? [(e.interval[0] - 1) * 100, (e.interval[1] - 1) * 100]
    : null,
});
/** A difference of two cells, in µs: an absolute saving. No interval. */
const saving = (R: Runs, slow: string, fast: string): number =>
  R.us(slow) - R.us(fast);
const FIG = String.raw`(TBD|[\d.]+)`;

const SWEEP_CLAIMS: SweepClaim[] = [
  {
    what: "§5: the SIMD gain, flat across sizes",
    pattern: new RegExp(
      String.raw`\*\*${FIG}%, and flat across every size measured`,
    ),
    unit: "percent",
    decimals: 0,
    resolve: (R) => [100, 256, 512].map((n) => asPct(gain(R, n))),
  },
  {
    what: "§5: the measured SIMD gain at 512x512",
    pattern: new RegExp(String.raw`the\s+measured gain is ${FIG}%`),
    unit: "percent",
    decimals: 0,
    resolve: (R) => asPct(gain(R, 512)),
  },
  {
    what: "§5: every tier-1 SIMD gain lands on one ratio",
    pattern: new RegExp(String.raw`would not all land on\s+${FIG}×`),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => [100, 256, 512].map((n) => gain(R, n)),
  },
  {
    what: "§6: the separable speedup at 100x100",
    pattern: new RegExp(
      String.raw`${FIG}× → (?:TBD|[\d.]+)× → (?:TBD|[\d.]+)×`,
    ),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => R.ratio(t1(100), `${t1(100)}/dct_separable`),
  },
  {
    what: "§6: the separable speedup at 256x256",
    pattern: new RegExp(
      String.raw`(?:TBD|[\d.]+)× → ${FIG}× → (?:TBD|[\d.]+)×`,
    ),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => R.ratio(t1(256), `${t1(256)}/dct_separable`),
  },
  {
    what: "§6: the separable speedup at 512x512",
    pattern: new RegExp(
      String.raw`(?:TBD|[\d.]+)× → (?:TBD|[\d.]+)× → ${FIG}×`,
    ),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => R.ratio(t1(512), `${t1(512)}/dct_separable`),
  },
  {
    what: "§6: the separable DCT's absolute saving at 512x512",
    pattern: new RegExp(String.raw`takes \*\*${FIG} ms off an encode`),
    unit: "ms",
    decimals: 1,
    resolve: (R) => saving(R, t1(512), `${t1(512)}/dct_separable`),
  },
  {
    what: "§6: the simd feature's absolute saving at 512x512",
    pattern: new RegExp(String.raw`\`simd\` feature takes ${FIG} ms\*\*`),
    unit: "ms",
    decimals: 1,
    resolve: (R) => saving(R, scalarT1(512), t1(512)),
  },
  {
    what: "§6: the separable saving over the simd saving",
    pattern: new RegExp(String.raw`${FIG}× the absolute saving`),
    unit: "ratio",
    decimals: 0,
    resolve: (R) =>
      saving(R, t1(512), `${t1(512)}/dct_separable`) /
      saving(R, scalarT1(512), t1(512)),
  },
  {
    what: "§6: the only byte-identical speedup measured so far",
    pattern: new RegExp(
      String.raw`byte-identical speedup §5 measures is ${FIG}%`,
    ),
    unit: "percent",
    decimals: 0,
    resolve: (R) => asPct(gain(R, 512)),
  },
  {
    what: "§10 item 2: the separable speedup, restated",
    pattern: new RegExp(String.raw`\*\*${FIG}× at 512×512\*\*, now measured`),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => R.ratio(t1(512), `${t1(512)}/dct_separable`),
  },
  {
    what: "§12.2 item 8: the separable speedup, restated",
    pattern: new RegExp(String.raw`§6 measures \*\*${FIG}× at 512×512\*\*`),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => R.ratio(t1(512), `${t1(512)}/dct_separable`),
  },
  {
    what: "§12.2 item 9: one 512x512 encode",
    pattern: new RegExp(String.raw`— ${FIG} ms for one 512×512 image`),
    unit: "ms",
    decimals: 1,
    resolve: (R) => R.est(t1(512)),
  },
  {
    what: "§12 summary: the simd feature's gain, restated",
    pattern: new RegExp(String.raw`feature buys \*\*${FIG}×\*\* because`),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => gain(R, 512),
  },
  {
    what: "§12.1 item 4(b): §2's tier-4 decode, restated",
    pattern: new RegExp(String.raw`the operation §2 prices at ${FIG} ms`),
    unit: "ms",
    decimals: 0,
    resolve: (R) => R.est("decode/Rust/t4/natural"),
  },
  {
    what: "§12.3: §2's tier-4 decode, restated",
    pattern: new RegExp(String.raw`§2's ${FIG} ms is still the only measured`),
    unit: "ms",
    decimals: 0,
    resolve: (R) => R.est("decode/Rust/t4/natural"),
  },
  {
    what: "§12.1 item 5: refine_passes=1 at 100x100",
    pattern: new RegExp(String.raw`refinement at \*\*${FIG}–`),
    unit: "ms",
    decimals: 0,
    resolve: (R) => R.est(`${t1(100)}/refine_passes=1`),
  },
  {
    what: "§12.1 item 5: refine_passes=2 at 100x100",
    pattern: new RegExp(
      String.raw`refinement at \*\*(?:TBD|[\d.]+)–${FIG} ms against`,
    ),
    unit: "ms",
    decimals: 0,
    resolve: (R) => R.est(`${t1(100)}/refine_passes=2`),
  },
  {
    what: "§12.1 item 5: the shipped 100x100 encode",
    pattern: new RegExp(String.raw`ms against ${FIG} ms shipped\*\*`),
    unit: "ms",
    decimals: 2,
    resolve: (R) => R.est(t1(100)),
  },
  // #95: §12.1's prose after its table and §12.3's first bullet, restated
  // from §12.4's measured speedups rather than from §1's stage shares.
  {
    what: "§12.1: accel_quant_table at 100x100, measured",
    pattern: new RegExp(
      String.raw`\`accel_quant_table\` makes a 100×100 tier-1 encode \*\*${FIG}×\*\*`,
    ),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => R.ratio(t1(100), `${t1(100)}/accel_quant_table`),
  },
  {
    what: "§12.1: accel_quant_table at 512x512, measured",
    pattern: new RegExp(String.raw`and a 512×512 one \*\*${FIG}×\*\*`),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => R.ratio(t1(512), `${t1(512)}/accel_quant_table`),
  },
  {
    what: "§12.1: accel_quant_table at tier 4, measured",
    pattern: new RegExp(String.raw`at tier 4 it is \*\*${FIG}×\*\*`),
    unit: "ratio",
    decimals: 2,
    resolve: (R) =>
      R.ratio(
        "encode/Rust/t4/100x100/gradient",
        "encode/Rust/t4/100x100/gradient/accel_quant_table",
      ),
  },
  {
    what: "§12.1: accel_word_bitpack at 100x100, measured",
    pattern: new RegExp(
      String.raw`\`accel_word_bitpack\`, measures \*\*${FIG}×\*\*`,
    ),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => R.ratio(t1(100), `${t1(100)}/accel_word_bitpack`),
  },
  {
    what: "§12.3: every encode lever together at 512x512, measured",
    pattern: new RegExp(
      String.raw`all seven levers together measure \*\*${FIG}×\*\*`,
    ),
    unit: "ratio",
    decimals: 2,
    resolve: (R) => R.ratio(t1(512), `${t1(512)}/accel all`),
  },
  {
    what: "§12.3: every lever together on a tier-1 decode, measured",
    pattern: new RegExp(
      String.raw`on a 512×512 encode and \*\*${FIG}×\*\* on a default-tier decode`,
    ),
    unit: "ratio",
    decimals: 2,
    resolve: (R) =>
      R.ratio("decode/Rust/t1/natural", "decode/Rust/t1/natural/accel all"),
  },
  // §0: the host-stability pair's own figures. The pair §0 describes from
  // 2026-09 was never committed, so its figures are no longer quoted; these
  // read the committed pair's, and are TBD until there is one.
  {
    what: "§0: cells the committed bounded pair shares",
    pattern: new RegExp(String.raw`at one commit share \*\*${FIG} cells\*\*`),
    unit: "count",
    decimals: 0,
    resolve: (_R, ctx) =>
      ctx.stability.status === "pass" ? ctx.stability.shared : null,
  },
  {
    what: "§0: the committed bounded pair's widest spread",
    pattern: new RegExp(String.raw`the widest \*\*${FIG}%\*\* apart`),
    unit: "count",
    decimals: 1,
    resolve: (_R, ctx) =>
      ctx.stability.status === "pass" && ctx.stability.widest !== null
        ? Number((ctx.stability.widest * 100).toFixed(1))
        : null,
  },
];

/**
 * §0's own counts: how much of the document the gate checks, and how much it
 * cannot yet. Counted as they will stand after `--fix`, so the rewrite a fix
 * makes to them is the one that is then true.
 */
function countClaims(pendingProse: number): SweepClaim[] {
  return [
    {
      what: "§0: values checked against a committed run",
      pattern: new RegExp(
        String.raw`\*\*${FIG} of this document's values are checked`,
      ),
      unit: "count",
      decimals: 0,
      resolve: (_R, ctx) => ctx.counters.checked + ctx.counters.placeholders,
    },
    {
      what: "§0: table cells no committed run can fill",
      pattern: new RegExp(
        String.raw`\*\*${FIG} table cells\*\* are placeholders`,
      ),
      unit: "count",
      decimals: 0,
      resolve: (_R, ctx) => ctx.counters.pending,
    },
    {
      what: "§0: prose figures no committed run can fill",
      pattern: new RegExp(String.raw`\*\*${FIG} figures in the prose\*\*`),
      unit: "count",
      decimals: 0,
      resolve: () => pendingProse,
    },
  ];
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

// A sweep committed at the old flat path is a baseline the gate would not
// read; say where it goes rather than report the document unmeasured.
const stray = BASELINES.filter((f) => existsSync(path.join(BASELINE_DIR, f)));
if (stray.length > 0) {
  console.error(
    [
      `Found ${stray.map((f) => `baselines/${f}`).join(", ")} at the old flat path.`,
      "Committed sweeps now live per host, under baselines/hosts/<host>/, where",
      "<host> is the run's own `host.id` (`mise run benchmark:session` puts them there).",
    ].join("\n"),
  );
  process.exit(1);
}

const hostDirs = existsSync(HOSTS_DIR)
  ? readdirSync(HOSTS_DIR)
      .filter((d) => statSync(path.join(HOSTS_DIR, d)).isDirectory())
      .sort()
  : [];
const primary = existsSync(PRIMARY_FILE)
  ? readFileSync(PRIMARY_FILE, "utf8").trim()
  : undefined;
if (primary !== undefined && !hostDirs.includes(primary)) {
  console.error(
    `baselines/hosts/PRIMARY names ${primary}, which has no directory under baselines/hosts/.`,
  );
  process.exit(1);
}
const ordered = primary
  ? [primary, ...hostDirs.filter((h) => h !== primary)]
  : hostDirs;

const runs = new Runs(
  ordered.flatMap((host) =>
    BASELINES.filter((file) =>
      existsSync(path.join(HOSTS_DIR, host, file)),
    ).map((file) => ({
      ...(JSON.parse(
        readFileSync(path.join(HOSTS_DIR, host, file), "utf8"),
      ) as RunDoc),
      file,
      hostDir: host,
    })),
  ),
  {
    ...(primary ? { primary } : {}),
    // Older runs recorded `…/shipped` as a cell of its own; the planner's
    // alias map says which cell each such name is.
    aliases: planMatrix("bounded", allTargets()).aliases,
  },
);
for (const r of runs.rejected) console.error(`Rejected ${r}`);
if (runs.loaded.length === 0) {
  console.error(
    [
      "No committed perf run found. Expected, under tools/comparison/baselines/hosts/<host>/:",
      ...BASELINES.map((b) => `  ${b}`),
      "",
      "Generate with `mise run benchmark:session`.",
    ].join("\n"),
  );
  process.exit(1);
}

if (values["list-cells"]) {
  for (const id of runs.ids) console.log(id);
  process.exit(0);
}

console.log(`Committed runs (primary host ${runs.primary}):`);
for (const r of runs.loaded) {
  const cfg = r.config;
  const sampling =
    cfg?.processes !== undefined
      ? `${cfg.processes} process(es) x ${cfg.reps} block(s)`
      : `1 process x ${cfg?.reps} block(s)`;
  console.log(
    `  ${r.hostDir}/${r.file}: ${r.cells.length} cells, mode=${cfg?.mode}, ${r.schema}, ${sampling}, ` +
      `${r.environment?.cpuModel} (${r.environment?.arch}, ${r.environment?.cores} cores), ` +
      `commit ${r.git?.commit}${r.git?.dirty ? " DIRTY" : ""}`,
  );
}
console.log();

const failures: Failure[] = [];
const counters: Counters = {
  checked: 0,
  unbound: 0,
  placeholders: 0,
  pending: 0,
  unavailable: 0,
  tolerated: 0,
};
const edits: Parameters<typeof applyEdits>[1][number][] = [];
const proseEdits: ProseEdit[] = [];
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
  const before = counters.checked + counters.placeholders;
  checkTable(binding, table, runs, failures, counters, edits);
  // §1.1 has no cell that may be skipped: every row is a recorded stage and
  // every column a recorded cell. `checkTable` passes over a cell whose text
  // is not a number, so count what it actually checked and hold it to the
  // table's size — otherwise "n/a" in a cell would be a silent pass.
  if (binding.section === "1.1") {
    const expected =
      table.rows.length * Object.keys(DECODE_STAGE_COLUMNS).length;
    const got = counters.checked + counters.placeholders - before;
    if (got !== expected) {
      failures.push({
        where: `§1.1 ${binding.title} (line ${table.line})`,
        column: "cells checked",
        row: "—",
        documented: `${expected} cells`,
        measured: `${got} checked`,
        detail:
          "every cell of this table is a bound share; one that is not a number, or a column the table lacks, was not checked",
      });
    }
  }
}

// The committed runs themselves: dirty, duplicated, spread past one host's
// bar, a supplement overriding the bounded runs, one measurement disagreeing
// with itself under two names, misfiled, or forced past the load bar.
failures.push(...runFailures(runs));

// Every host's stability pair is checked; §0's row speaks for the primary's.
const spreadPct = (CROSS_RUN_TOLERANCE * 100).toFixed(0);
const stability = checkStability(runs);
for (const host of runs.hosts.keys()) {
  const s = host === runs.primary ? stability : checkStability(runs, host);
  const widest =
    s.widest === null ? "" : `, widest ${(s.widest * 100).toFixed(1)}%`;
  const detail =
    s.status === "skip"
      ? s.problems.join("; ")
      : `${s.runs.join(" vs ")}: ${s.shared} shared cells${widest}`;
  console.log(
    `Host stability (§0) ${host}${host === runs.primary ? " [primary]" : ""}: ${s.status.toUpperCase()} — ${detail}`,
  );
  if (s.status === "fail") {
    failures.push({
      where: "committed runs",
      column: "host stability",
      row: `${host}: ${s.runs.join(" vs ")}`,
      documented: `two ${STABILITY_MODE} runs, one commit, within ${spreadPct}%`,
      measured: "fail",
      detail: s.problems.join("; "),
    });
  }
}
if (!values.section || values.section === "0") {
  failures.push(...checkStabilityClaim(doc, stability));
}

// Provenance, by commit where the commit is reachable and by the digest of
// its measured sources where it is not (`perf/provenance.ts`).
const view = gitView(REPO_ROOT);
console.log("\nProvenance:");
for (const r of runs.loaded) {
  const v = judgeProvenance(
    r.git ?? { commit: "(none)" },
    view,
    r.schema === LEGACY_SCHEMA,
  );
  console.log(
    `  ${v.status.toUpperCase().padEnd(10)} ${r.hostDir}/${r.file}: ${v.detail}`,
  );
  if (provenanceFails(v)) {
    failures.push({
      where: `baselines/hosts/${r.hostDir}/${r.file}`,
      column: "provenance",
      row: r.git?.commit ?? "—",
      documented: "a commit, or the sources of one, in HEAD's history",
      measured: v.status,
      detail: v.detail,
    });
  }
}
for (const [file, stages] of [
  [STAGES_BASELINE, STAGES],
  [DECODE_STAGES_BASELINE, DECODE_STAGES],
] as const) {
  if (!stages) continue;
  const seen = new Set<string>();
  for (const cell of Object.values(stages) as StageCell[]) {
    const key = `${cell.git?.rev}|${cell.git?.digest ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A stage cell recorded before digests is legacy: the stage schema did
    // not change when the recorder started writing one. A new cell without a
    // digest is caught by the landing rule below, which needs HEAD's.
    const v = judgeProvenance(
      { commit: cell.git?.rev ?? "(none)", digest: cell.git?.digest ?? null },
      view,
      true,
    );
    console.log(`  ${v.status.toUpperCase().padEnd(10)} ${file}: ${v.detail}`);
    if (provenanceFails(v)) {
      failures.push({
        where: file,
        column: "provenance",
        row: cell.git?.rev ?? "—",
        documented: "a commit, or the sources of one, in HEAD's history",
        measured: v.status,
        detail: v.detail,
      });
    }
  }
}
console.log();

// §1's provenance (one clean commit across all three columns) and the prose
// figures derived from its table.
let proseChecked = 0;
if (STAGES) {
  failures.push(...checkStagesProvenance(STAGES));
  const prose = checkProseClaims(doc, STAGES, PROSE_CLAIMS);
  failures.push(...prose.failures);
  proseEdits.push(...prose.edits);
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
  proseEdits.push(...prose.edits);
  decodeProseChecked = prose.checked;
}

// The sweep-derived prose, then §0's counts of everything above. Only on a
// whole-document run: a count of one section's cells is not §0's count.
let sweepChecked = 0;
let sweepPending = 0;
if (!values.section) {
  const ctx: ClaimContext = { counters, stability };
  const sweep = checkSweepClaims(doc, runs, ctx, SWEEP_CLAIMS);
  const counts = checkSweepClaims(doc, runs, ctx, countClaims(sweep.pending));
  for (const r of [sweep, counts]) {
    failures.push(...r.failures);
    proseEdits.push(...r.edits);
  }
  sweepChecked = sweep.checked + counts.checked;
  sweepPending = sweep.pending;
}

if (values.fix) {
  if (edits.length === 0 && proseEdits.length === 0) {
    console.log("Nothing to rewrite — every bound value is within its band.");
    process.exit(0);
  }
  writeFileSync(DOC, applyEdits(doc, edits, proseEdits));
  console.log(
    `Rewrote ${edits.length} table cell(s) and ${proseEdits.length} prose figure(s) in ${path.relative(REPO_ROOT, DOC)} — only those outside their interval and the ±${(TOLERANCE * 100).toFixed(0)}% band, and the placeholders a committed run can fill.`,
  );
  console.log("Re-run without --fix to confirm, and review the diff.");
  process.exit(0);
}

console.log(
  `Checked ${counters.checked} documented value(s) against the committed runs` +
    ` (${counters.tolerated} within the interval or the ±${(TOLERANCE * 100).toFixed(0)}% band rather than exact)` +
    `; ${counters.unbound} deliberately unbound` +
    `${counters.unavailable > 0 ? `, ${counters.unavailable} on targets this run could not reach` : ""}` +
    `${counters.placeholders > 0 ? `, ${counters.placeholders} placeholder(s) a committed run can fill` : ""}` +
    `${counters.pending > 0 ? `, ${counters.pending} placeholder(s) no committed run can fill yet` : ""}.`,
);
console.log(
  `Checked ${proseChecked} figure(s) the prose derives from §1's table.`,
);
console.log(
  `Checked ${decodeProseChecked} figure(s) the prose derives from §1.1's table.`,
);
console.log(
  `Checked ${sweepChecked} figure(s) the prose derives from the sweeps` +
    `${sweepPending > 0 ? `; ${sweepPending} still TBD` : ""}.`,
);
const noisy = runs.noisyTouched();
if (noisy.length > 0) {
  console.log(
    `  NOISY  ${noisy.length} bound cell(s) the driver flagged noisy (process minima or blocks spread past 5%): ${noisy.join(", ")}`,
  );
}
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
