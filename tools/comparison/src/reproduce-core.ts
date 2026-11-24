/**
 * Whether a re-run of a sweep reproduces its committed result, value by value
 * and claim by claim.
 *
 * Two readings, at two grains. {@link reproductionErrors} and
 * {@link armMovements} compare every per-image value of a re-run with the
 * committed result's, matched by arm label and image name, inside
 * {@link REPRODUCTION_REL}: the reading `selftest:determinism` gates one sweep
 * on, and the one `spec/EXPERIMENTS.md` §13.16's first table reports for every
 * re-run. The claims ledger ({@link LEDGER}, §13.16's second table, #130) is
 * the coarser reading the document needs: each load-bearing figure recomputed
 * from the committed result and from its re-run, with a status from the rule
 * #130 fixed before anything was re-run:
 *
 * - **reproduced** -- the two agree at the figure's printed precision;
 * - **drifted** -- the figure moves, but its comparison's sign, its Holm
 *   verdict (adjusted p below 0.05) and its `guards (CI)` verdict do not;
 * - **not reproduced** -- any of those turns, or there is no re-run.
 *
 * The re-runs are committed under `results/reproductions/`, a subdirectory, so
 * nothing that enumerates `results/*.json` (§13.5's `all committed sweeps`
 * row, `arms --summary`) counts a re-run as a second sweep. Re-runs of the
 * same sweeps at the last generation-v1 revision, for the arms #162's format
 * change moves at master, are under `results/reproductions/v1/`.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type ArmComparison,
  type InferenceSummary,
  compareArms,
  guardVerdictOnIntervals,
  statFor,
  summarizeInference,
} from "./arms-core.ts";
import {
  type GuardTolerances,
  type PerImageKey,
  type Provenance,
  type ResultFile,
  readResult,
} from "./results.ts";

// ─── Per-image reproduction ─────────────────────────────────────────────────

/**
 * How far a re-run may sit from the committed value and still reproduce it.
 *
 * Not zero, because nothing pins the floating-point path across machines: the
 * SSIMULACRA2 and Butteraugli kernels dispatch on the host's SIMD width, and
 * libvips's resampler does the same. 1e-5 relative is two orders of magnitude
 * below the coarsest rounding `spec/EXPERIMENTS.md` prints (a ΔE00 near 10 to
 * three decimals is 1e-4), so a value inside it cannot move a cell, and one
 * outside it is a result this build does not reproduce.
 */
export const REPRODUCTION_REL = 1e-5;
export const REPRODUCTION_ABS = 1e-9;

/** The results subdirectory the ledger's re-runs are committed in. */
export const REPRODUCTIONS = "reproductions";

/**
 * The last revision before #162 landed wire-format generation v2: the encoder
 * every claim in the ledger was measured on. Re-runs at it are committed under
 * `reproductions/v1/`, and `verify:experiments` refuses one scored anywhere
 * else: a "v1" re-run from another revision would attribute a move to #162
 * that something else made.
 */
export const GENERATION_V1_REV = "225bdce88569727a041233956116110a6d1dce74";

function relativeMove(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(b), REPRODUCTION_ABS);
}

function outside(a: number, b: number): boolean {
  return (
    Math.abs(a - b) > Math.max(REPRODUCTION_ABS, Math.abs(b) * REPRODUCTION_REL)
  );
}

/**
 * Where a re-run's per-image values fall outside {@link REPRODUCTION_REL} of the
 * committed result's, matched by arm label and image name. Also reports an arm
 * or a series the committed result has and the re-run lacks, or the reverse:
 * a series that stopped being measured is not a reproduction either.
 */
export function reproductionErrors(
  run: ResultFile,
  committed: ResultFile,
): string[] {
  const out: string[] = [];
  const committedIndex = new Map(
    committed.imageNames.map((n, i) => [n, i] as const),
  );
  for (const row of run.rows) {
    const twin = committed.rows.find((r) => r.label === row.label);
    if (!twin) {
      out.push(`arm "${row.label}" is not in the committed result`);
      continue;
    }
    const keys = new Set([
      ...Object.keys(row.perImage),
      ...Object.keys(twin.perImage),
    ]) as Set<keyof typeof row.perImage>;
    for (const key of keys) {
      const mine = row.perImage[key];
      const theirs = twin.perImage[key];
      if (!mine || !theirs) {
        out.push(
          `arm "${row.label}" ${key}: ${mine ? "absent from the committed result" : "not measured by the re-run"}`,
        );
        continue;
      }
      for (const [i, name] of run.imageNames.entries()) {
        const j = committedIndex.get(name);
        if (j === undefined) {
          out.push(`image "${name}" is not in the committed result`);
          continue;
        }
        const a = mine[i] ?? null;
        const b = theirs[j] ?? null;
        if (a === null || b === null) {
          if (a !== b) out.push(`${row.label} / ${name} ${key}: ${a} vs ${b}`);
          continue;
        }
        if (outside(a, b)) {
          out.push(
            `${row.label} / ${name} ${key}: re-run ${a}, committed ${b} (off by ${relativeMove(a, b).toExponential(2)} relative)`,
          );
        }
      }
    }
  }
  for (const twin of committed.rows) {
    if (!run.rows.some((r) => r.label === twin.label)) {
      out.push(`committed arm "${twin.label}" was not re-run`);
    }
  }
  return out;
}

/** One committed arm's per-image agreement with its re-run. */
export interface ArmMovement {
  label: string;
  /** Values compared: every series both carry, over every image both scored. */
  compared: number;
  /**
   * Values outside {@link REPRODUCTION_REL}, a value null on one side only
   * included. An arm or a series the re-run lacks counts every committed value
   * of it as moved: not measuring it is not reproducing it.
   */
  moved: number;
  /** The series holding a moved value. */
  keys: PerImageKey[];
  /** The largest relative move between two numbers, 0 when none moved. */
  maxRel: number;
}

/**
 * Per committed arm, how many of its per-image values the re-run left. With
 * `scoredOnly`, only the arms the re-run scored: a re-run narrowed on purpose
 * (the v1 `rd-budget` run scores only ChromaHash at 411 B and 1623 B, the
 * two arms #162 moves) is read on what it re-ran, and says so in its row.
 */
export function armMovements(
  run: ResultFile,
  committed: ResultFile,
  scoredOnly = false,
): ArmMovement[] {
  const runIndex = new Map(run.imageNames.map((n, i) => [n, i] as const));
  const twins = scoredOnly
    ? committed.rows.filter((t) => run.rows.some((r) => r.label === t.label))
    : committed.rows;
  return twins.map((twin) => {
    const row = run.rows.find((r) => r.label === twin.label);
    const m: ArmMovement = {
      label: twin.label,
      compared: 0,
      moved: 0,
      keys: [],
      maxRel: 0,
    };
    for (const key of Object.keys(twin.perImage) as PerImageKey[]) {
      const theirs = twin.perImage[key] ?? [];
      const mine = row?.perImage[key];
      for (const [j, name] of committed.imageNames.entries()) {
        const i = runIndex.get(name);
        const b = theirs[j] ?? null;
        const a = mine && i !== undefined ? (mine[i] ?? null) : undefined;
        m.compared++;
        if (a === null && b === null) continue;
        if (a === undefined || a === null || b === null || outside(a, b)) {
          m.moved++;
          if (!m.keys.includes(key)) m.keys.push(key);
          if (typeof a === "number" && b !== null) {
            m.maxRel = Math.max(m.maxRel, relativeMove(a, b));
          }
        }
      }
    }
    return m;
  });
}

// ─── The re-runs ────────────────────────────────────────────────────────────

/** A committed result, its re-run at master and, where #162 moved it, at v1. */
export interface ReproducedSweep {
  committed: string;
  /** Name under `reproductions/`. */
  repro: string;
  /**
   * Name under `reproductions/v1/`, for a result #162 moves at master. The v1
   * re-run is read on the arms it scored ({@link armMovements}).
   */
  v1?: string;
}

/**
 * Every result #130 re-ran: the ledger's sources and the rest of the sweeps
 * their sections cite. A `-holdout` result scored what is `tune2` now (#76),
 * so its re-run is `--split tune2`.
 */
export const REPRODUCED_SWEEPS: readonly ReproducedSweep[] = [
  { committed: "alpha-fields", repro: "alpha-fields" },
  { committed: "alpha-ac-count", repro: "alpha-ac-count" },
  { committed: "alpha-ceiling", repro: "alpha-ceiling" },
  { committed: "alpha-tier1", repro: "alpha-tier1" },
  { committed: "compact-tier", repro: "compact-tier" },
  { committed: "compact-tier-graphics", repro: "compact-tier-graphics" },
  { committed: "compact-tier-alpha", repro: "compact-tier-alpha" },
  { committed: "v07-holdout-photo", repro: "v07-holdout-photo" },
  {
    committed: "v07-holdout-photo-holdout",
    repro: "v07-holdout-photo-tune2",
  },
  { committed: "v07-holdout-alpha", repro: "v07-holdout-alpha" },
  {
    committed: "rd-budget-holdout",
    repro: "rd-budget-tune2",
    v1: "rd-budget-tune2",
  },
  {
    committed: "embedded-tiers",
    repro: "embedded-tiers",
    v1: "embedded-tiers",
  },
  { committed: "cfl", repro: "cfl", v1: "cfl" },
  { committed: "cfl-range", repro: "cfl-range", v1: "cfl-range" },
  { committed: "selection-weights", repro: "selection-weights" },
  { committed: "selection-hv", repro: "selection-hv" },
  { committed: "synthesis-window", repro: "synthesis-window" },
  { committed: "synthesis-window-upper", repro: "synthesis-window-upper" },
  {
    committed: "artifact-ladder",
    repro: "artifact-ladder",
    v1: "artifact-ladder",
  },
  {
    committed: "artifact-ladder-common-grid",
    repro: "artifact-ladder-common-grid",
    v1: "artifact-ladder-common-grid",
  },
];

/** Read a re-run: `reproductions/<name>`, or `reproductions/v1/<name>`. */
export function readReproduction(
  resultsDir: string,
  name: string,
  v1 = false,
): ResultFile | null {
  return readResult(
    path.join(resultsDir, REPRODUCTIONS, ...(v1 ? ["v1"] : [])),
    name,
  );
}

/** A re-run's per-image reading against its committed result, as cells. */
export interface SweepCells {
  arms: number;
  compared: number;
  moved: number;
  /** `identical`, or how many of the arms read moved. */
  status: string;
}

function sweepReading(
  run: ResultFile | null,
  committed: ResultFile | null,
  scoredOnly: boolean,
): SweepCells | null {
  if (!run || !committed) return null;
  const ms = armMovements(run, committed, scoredOnly);
  const movedArms = ms.filter((m) => m.moved > 0).length;
  const of = `${ms.length}${scoredOnly && ms.length < committed.rows.length ? " re-run" : ""}`;
  return {
    arms: ms.length,
    compared: ms.reduce((n, m) => n + m.compared, 0),
    moved: ms.reduce((n, m) => n + m.moved, 0),
    status:
      movedArms === 0
        ? `identical (${of} arms)`
        : `${movedArms} of ${of} arms moved`,
  };
}

/** §13.16's first table: one re-run's per-image reading, at master and v1. */
export function sweepCells(
  resultsDir: string,
  s: ReproducedSweep,
): { master: SweepCells | null; v1: SweepCells | null } {
  const committed = readResult(resultsDir, s.committed);
  return {
    master: sweepReading(
      readReproduction(resultsDir, s.repro),
      committed,
      false,
    ),
    v1:
      s.v1 === undefined
        ? null
        : sweepReading(
            readReproduction(resultsDir, s.v1, true),
            committed,
            true,
          ),
  };
}

/** Every committed arm's movement in a re-run, for the CLI's `--arms`. */
export function sweepMovements(
  resultsDir: string,
  s: ReproducedSweep,
  v1 = false,
): ArmMovement[] {
  const committed = readResult(resultsDir, s.committed);
  const name = v1 ? s.v1 : s.repro;
  const run =
    name === undefined ? null : readReproduction(resultsDir, name, v1);
  return run && committed ? armMovements(run, committed, v1) : [];
}

/**
 * Every committed re-run, as `reproductions/<name>` or
 * `reproductions/v1/<name>`, so `verify:experiments --strict` audits their
 * provenance as it audits every other result's.
 */
export function reproductionFiles(
  resultsDir: string,
): { where: string; file: ResultFile }[] {
  const out: { where: string; file: ResultFile }[] = [];
  for (const s of REPRODUCED_SWEEPS) {
    const at = readReproduction(resultsDir, s.repro);
    if (at) out.push({ where: `${REPRODUCTIONS}/${s.repro}`, file: at });
    if (s.v1 !== undefined) {
      const v1 = readReproduction(resultsDir, s.v1, true);
      if (v1) out.push({ where: `${REPRODUCTIONS}/v1/${s.v1}`, file: v1 });
    }
  }
  return out;
}

// ─── The claims ledger ──────────────────────────────────────────────────────

/** What the ledger concludes about one claim: #130's three statuses. */
export type LedgerStatus = "reproduced" | "drifted" | "not reproduced";

/**
 * A figure read off a committed result: the figure as the ledger prints it,
 * at the precision its section quotes it, so "agrees at its printed precision"
 * is a string comparison and not a tolerance chosen after the re-run; and the
 * verdict a drift must not turn (the comparison's sign, its Holm reading and
 * its `guards (CI)` verdict, as one string).
 */
interface SweepFigure {
  figure: (file: ResultFile) => string | null;
  verdict: (file: ResultFile) => string | null;
  /** The comparison the figure reads, where it is one arm against another. */
  pair?: { arm: string; base: string; key: PerImageKey };
}

/**
 * One load-bearing figure: where it is recorded, how it is computed, and which
 * re-run reproduces it.
 *
 * A `sweep` claim's recorded figure is computed from the committed result, the
 * way its section's binding computes it. An `entropy-budget` claim has no
 * committed result to compute it from -- `entropy-budget.ts` wrote only
 * scratch output until #130 -- so its recorded figure is the one §7.13
 * prints, held here as text, and its re-run is the committed
 * `reproductions/entropy-budget-tune.json`.
 */
export type LedgerClaim = {
  /** The ledger row's label: what the figure is. */
  claim: string;
  section: string;
  /**
   * The command that re-ran it, as `EXPERIMENTS.md` §6 lists it in full:
   * `sweep` is `mise run sweep`, and the others are
   * `node tools/comparison/dist/<tool>.js`, each writing into
   * `results/reproductions/`.
   */
  command: string;
} & (
  | ({
      kind: "sweep";
      /** Committed result the recorded figure is computed from. */
      sweep: string;
      /** Its re-run, by name under `reproductions/`. */
      repro: string;
      /** Its re-run at {@link GENERATION_V1_REV}, under `reproductions/v1/`. */
      v1?: string;
    } & SweepFigure)
  | {
      kind: "entropy-budget";
      /** The figure as §7.13 records it. */
      recorded: string;
      figure: (file: EntropyBudgetFile) => string | null;
    }
);

const MINUS = "−";

/** `x` to `decimals`, signed, with the document's unicode minus. */
export function signedFixed(x: number, decimals: number): string {
  const s = Math.abs(x).toFixed(decimals);
  if (Number(s) === 0) return s;
  return `${x < 0 ? MINUS : "+"}${s}`;
}

const pct =
  (decimals: number) =>
  (x: number | null): string | null =>
    x === null ? null : `${signedFixed(x, decimals)}%`;

function rowIndex(file: ResultFile, label: string): number {
  const i = file.rows.findIndex((r) => r.label === label);
  if (i < 0) throw new Error(`${file.name} has no arm "${label}"`);
  return i;
}

function meanOf(
  file: ResultFile,
  label: string,
  key: PerImageKey,
): number | null {
  const s = file.rows[rowIndex(file, label)]?.perImage[key];
  if (!s) return null;
  const v = s.filter((x): x is number => x !== null);
  return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Every arm against `base`, Holm-adjusted across the whole sweep, cached. */
const comparisons = new WeakMap<ResultFile, Map<number, ArmComparison[]>>();
function comparisonOf(
  file: ResultFile,
  arm: string,
  base: string,
): ArmComparison | undefined {
  const b = rowIndex(file, base);
  let byBase = comparisons.get(file);
  if (!byBase) {
    byBase = new Map();
    comparisons.set(file, byBase);
  }
  let list = byBase.get(b);
  if (!list) {
    list = compareArms(file.rows, b);
    byBase.set(b, list);
  }
  return list.find((c) => c.label === arm);
}

/**
 * The reading a drift must not turn: the sign of `arm − base` on `key`, whether
 * it survives Holm across the sweep, and the arm's `guards (CI)` verdict at the
 * tolerances the run recorded (`none` for a run that recorded none).
 */
export function pairVerdict(
  file: ResultFile,
  arm: string,
  base: string,
  key: PerImageKey = "ciede2000",
): string | null {
  const cmp = comparisonOf(file, arm, base);
  const stat = statFor(cmp, key);
  if (!stat) return null;
  const tol = file.settings.guardTolerances as GuardTolerances | undefined;
  const rise = (file.settings.artifactGuardRise as number | null) ?? undefined;
  const guards = tol ? guardVerdictOnIntervals(cmp, tol, rise) : "none";
  const sign = stat.meanDelta > 0 ? "+" : stat.meanDelta < 0 ? "-" : "0";
  return `${sign} holm:${stat.pHolm < 0.05 ? "yes" : "no"} guards:${guards}`;
}

/** Mean-ΔE00 relative difference of `arm` against `base`, in percent. */
function deltaPct(file: ResultFile, arm: string, base: string): number | null {
  const a = meanOf(file, arm, "ciede2000");
  const b = meanOf(file, base, "ciede2000");
  return a === null || b === null || b === 0 ? null : ((a - b) / b) * 100;
}

/** `arm`'s mean-ΔE00 Δ% against `base`. */
export function deltaFigure(
  arm: string,
  base: string,
  decimals = 2,
): SweepFigure {
  return {
    figure: (f) => pct(decimals)(deltaPct(f, arm, base)),
    verdict: (f) => pairVerdict(f, arm, base),
    pair: { arm, base, key: "ciede2000" },
  };
}

/**
 * `arm`'s mean of `key`, read against `base` for its verdict. It carries no
 * `pair`: the figure is a level, not a comparison, so it has no per-stratum
 * gain to report.
 */
export function meanFigure(
  arm: string,
  key: PerImageKey,
  decimals: number,
  base: string,
): SweepFigure {
  return {
    figure: (f) => {
      const m = meanOf(f, arm, key);
      return m === null ? null : m.toFixed(decimals);
    },
    verdict: (f) => pairVerdict(f, arm, base, key),
  };
}

/** `arm − base` on `key`, with its paired 95% interval. */
export function diffFigure(
  arm: string,
  base: string,
  key: PerImageKey,
): SweepFigure {
  return {
    figure: (f) => {
      const s = statFor(comparisonOf(f, arm, base), key);
      if (!s) return null;
      return `${signedFixed(s.meanDelta, 3)} [${signedFixed(s.ci[0], 3)}, ${signedFixed(s.ci[1], 3)}]`;
    },
    verdict: (f) => pairVerdict(f, arm, base, key),
    pair: { arm, base, key },
  };
}

/** `arm`'s Holm-adjusted ΔE00 p against `base`, across the whole sweep. */
export function holmFigure(arm: string, base: string): SweepFigure {
  return {
    figure: (f) => {
      const s = statFor(comparisonOf(f, arm, base), "ciede2000");
      return s ? s.pHolm.toFixed(4) : null;
    },
    verdict: (f) => pairVerdict(f, arm, base),
    pair: { arm, base, key: "ciede2000" },
  };
}

/** The relative change in mean spurious detail of `arm` against `base`. */
export function spuriousCutFigure(arm: string, base: string): SweepFigure {
  return {
    figure: (f) => {
      const a = meanOf(f, arm, "spurious");
      const b = meanOf(f, base, "spurious");
      return a === null || b === null || b === 0
        ? null
        : pct(0)(((a - b) / b) * 100);
    },
    verdict: (f) => pairVerdict(f, arm, base, "spurious"),
    pair: { arm, base, key: "spurious" },
  };
}

/**
 * One of `arms --summary`'s counts for a whole sweep (§13.5). A count is its
 * own verdict: any change in it is some arm's verdict turning.
 */
export function summaryFigure(field: keyof InferenceSummary): SweepFigure {
  const read = (f: ResultFile) => {
    const s = summarizeInference(f);
    return s ? String(s[field]) : null;
  };
  return { figure: read, verdict: read };
}

/**
 * The compact tier against ThumbHash at ThumbHash's own size in an rd-budget
 * run, ΔE00 as "compact vs ThumbHash"; the verdict is whether the 21-byte
 * ChromaHash row is better on all four metrics, §11.12's claim.
 */
export function thumbHashFigure(): SweepFigure {
  const compact = "ChromaHash@21B";
  const th = "ThumbHash";
  return {
    figure: (f) => {
      const m = meanOf(f, compact, "ciede2000");
      const t = meanOf(f, th, "ciede2000");
      return m === null || t === null
        ? null
        : `${m.toFixed(3)} vs ${t.toFixed(3)}`;
    },
    verdict: (f) => {
      const keys: [PerImageKey, boolean][] = [
        ["ciede2000", false],
        ["ssimulacra2", true],
        ["butteraugli", false],
        ["dssim", false],
      ];
      const better = keys.map(([k, higher]) => {
        const a = meanOf(f, compact, k);
        const b = meanOf(f, th, k);
        return a === null || b === null ? null : higher ? a > b : a < b;
      });
      if (better.some((x) => x === null)) return null;
      return better.every((x) => x === true) ? "beats on all four" : "does not";
    },
  };
}

// ─── entropy-budget's output (§7.13) ────────────────────────────────────────

/** The parts of `entropy-budget.ts`'s output the ledger reads. */
export interface EntropyBudgetFile {
  split: string;
  images: number;
  prefixBits: number;
  picks: {
    budgetBytes: number;
    coder: string;
    kind: string;
    layout: string | null;
    ciede2000: number | null;
  }[];
  rows: {
    tier: number;
    layout: string;
    fixedBits: number;
    contextBackoffBits: number;
  }[];
  provenance?: Provenance;
}

export function readEntropyBudget(
  resultsDir: string,
  name: string,
): EntropyBudgetFile | null {
  const p = path.join(resultsDir, REPRODUCTIONS, `${name}.json`);
  return existsSync(p)
    ? (JSON.parse(readFileSync(p, "utf8")) as EntropyBudgetFile)
    : null;
}

/** The fixed-field coder's label in `entropy-budget.ts`. */
const FIXED_CODER = "fixed fields (today)";

/**
 * The best coder's AC bits on the `L26@5 C9@4` layout, against the fixed
 * fields' (§7.13's bold row): context backing off to order-0, LOO.
 */
export function acBitsFigure(f: EntropyBudgetFile): string | null {
  const row = f.rows.find((r) => r.tier === 1 && r.layout === "L26@5 C9@4");
  if (!row) return null;
  const fixed = row.fixedBits - f.prefixBits;
  const coded = row.contextBackoffBits - f.prefixBits;
  return pct(1)((coded / fixed - 1) * 100);
}

/**
 * What spending a coder's saving buys at `budgetBytes`: the best ΔE00 any
 * coder's fitting layouts reach, against the best the fixed fields reach.
 */
export function spendFigure(
  budgetBytes: number,
): (f: EntropyBudgetFile) => string | null {
  return (f) => {
    const best = (coded: boolean): number | null => {
      let out: number | null = null;
      for (const p of f.picks) {
        if (p.budgetBytes !== budgetBytes || p.kind !== "best ΔE00") continue;
        if ((p.coder === FIXED_CODER) === coded || p.ciede2000 === null) {
          continue;
        }
        out = out === null ? p.ciede2000 : Math.min(out, p.ciede2000);
      }
      return out;
    };
    const fixed = best(false);
    const coded = best(true);
    return fixed === null || coded === null
      ? null
      : pct(1)((coded / fixed - 1) * 100);
  };
}

// ─── Reading the ledger ─────────────────────────────────────────────────────

/** One ledger row's cells. `v1` is set only for a claim re-run at v1 too. */
export interface LedgerCells {
  recorded: string | null;
  rerun: string | null;
  v1?: string | null;
  status: LedgerStatus;
}

/**
 * #130's rule. Equal at the printed precision is reproduced; otherwise the
 * verdict decides, and a missing figure or verdict on either side is not a
 * reproduction.
 */
export function classify(
  recorded: string | null,
  rerun: string | null,
  recordedVerdict: string | null,
  rerunVerdict: string | null,
): LedgerStatus {
  if (recorded === null || rerun === null) return "not reproduced";
  if (recorded === rerun) return "reproduced";
  if (recordedVerdict === null || rerunVerdict === null) {
    return "not reproduced";
  }
  return recordedVerdict === rerunVerdict ? "drifted" : "not reproduced";
}

/** The sign a percentage figure carries, the only verdict §7.13 offers. */
function signOf(figure: string | null): string | null {
  if (figure === null) return null;
  return figure.startsWith(MINUS) || figure.startsWith("-") ? "-" : "+";
}

/** Every ledger row's cells, keyed by claim. */
export function ledgerCells(resultsDir: string): Map<string, LedgerCells> {
  const out = new Map<string, LedgerCells>();
  for (const c of LEDGER) {
    if (c.kind === "entropy-budget") {
      const file = readEntropyBudget(resultsDir, "entropy-budget-tune");
      const rerun = file ? c.figure(file) : null;
      out.set(c.claim, {
        recorded: c.recorded,
        rerun,
        status: classify(c.recorded, rerun, signOf(c.recorded), signOf(rerun)),
      });
      continue;
    }
    const committed = readResult(resultsDir, c.sweep);
    const run = readReproduction(resultsDir, c.repro);
    const recorded = committed ? c.figure(committed) : null;
    const rerun = run ? c.figure(run) : null;
    const cells: LedgerCells = {
      recorded,
      rerun,
      status: classify(
        recorded,
        rerun,
        committed ? c.verdict(committed) : null,
        run ? c.verdict(run) : null,
      ),
    };
    if (c.v1 !== undefined) {
      const v1 = readReproduction(resultsDir, c.v1, true);
      cells.v1 = v1 ? c.figure(v1) : null;
    }
    out.set(c.claim, cells);
  }
  return out;
}
const sweepCmd = (config: string, split = ""): string =>
  `sweep ${config}${split ? ` --split ${split}` : ""}`;

/** A claim on a sweep whose re-run keeps the sweep's own name. */
function onSweep(
  claim: string,
  section: string,
  sweep: string,
  figure: SweepFigure,
  v1 = false,
): LedgerClaim {
  return {
    kind: "sweep",
    claim,
    section,
    sweep,
    repro: sweep,
    ...(v1 ? { v1: sweep } : {}),
    command: sweepCmd(sweep),
    ...figure,
  };
}

const CFL_SHIPPED = "32B shipped L26@5C9@4";
const SEL_DEFAULT = "DEFAULT aniso=1.2 hv=0.15";
const LEADER = "L19@4 C6@3  (§8.1 tune)";
const SHIPPED_SHAPE = "shipped shape L13@5 C6@4";
const ALPHA_SHIPPED = "SHIPPED A5@4 L20@5 C9@4";

/**
 * The load-bearing figures #130 lists, in its order: each one a figure
 * `V0.8-DECISIONS.md`, `RATIONALE.md` or `README.md` leans on, computed from
 * the committed result the way its section's binding computes it.
 */
export const LEDGER: readonly LedgerClaim[] = [
  onSweep(
    "alpha row `A28@3 L22@4 C3@3` at code 1",
    "11.3",
    "alpha-ceiling",
    deltaFigure("A28@3 L22@4 C3@3", ALPHA_SHIPPED),
  ),
  onSweep(
    "the same row at code 2",
    "11.11",
    "alpha-tier1",
    deltaFigure("A28@3 L22@4 C3@3 (t0 winner)", ALPHA_SHIPPED),
  ),
  onSweep(
    "compact leader `L19@4 C6@3` against the shipped shape",
    "11.10",
    "compact-tier",
    deltaFigure(LEADER, SHIPPED_SHAPE),
  ),
  onSweep(
    "`L16@4 C8@3` against the leader, Holm p",
    "11.10",
    "compact-tier",
    holmFigure("L16@4 C8@3", LEADER),
  ),
  onSweep(
    "compact leader on the graphics tune split",
    "11.10",
    "compact-tier-graphics",
    deltaFigure(LEADER, SHIPPED_SHAPE),
  ),
  {
    kind: "sweep",
    claim: "compact leader against the shipped shape, on tune2",
    section: "11.12",
    sweep: "v07-holdout-photo-holdout",
    repro: "v07-holdout-photo-tune2",
    command: sweepCmd("v07-holdout-photo", "tune2"),
    ...deltaFigure("compact 21B L19@4 C6@3", "compact 21B shipped shape"),
  },
  {
    kind: "sweep",
    claim: "compact 21 B against ThumbHash, ΔE00, on tune2",
    section: "11.12",
    sweep: "rd-budget-holdout",
    repro: "rd-budget-tune2",
    command: "rd-budget --split tune2",
    ...thumbHashFigure(),
  },
  {
    kind: "entropy-budget",
    claim: "best coder's AC bits against the fixed fields, LOO",
    section: "7.13",
    recorded: `${MINUS}7.5%`,
    command: "entropy-budget --split tune --record",
    figure: acBitsFigure,
  },
  {
    kind: "entropy-budget",
    claim: "the saving spent at 32 B, ΔE00",
    section: "7.13",
    recorded: `${MINUS}1.6%`,
    command: "entropy-budget --split tune --record",
    figure: spendFigure(32),
  },
  {
    kind: "entropy-budget",
    claim: "the saving spent at 108 B, ΔE00",
    section: "7.13",
    recorded: `${MINUS}4.8%`,
    command: "entropy-budget --split tune --record",
    figure: spendFigure(108),
  },
  onSweep(
    "first 32 B of an interleaved code-2 hash against native code 1",
    "7.11",
    "embedded-tiers",
    deltaFigure("t1 interleaved, trunc 32 B", "t0 native 32 B"),
    true,
  ),
  onSweep(
    "interleaved against channel-sequential, at the 32 B cut",
    "7.11",
    "embedded-tiers",
    deltaFigure("t1 interleaved, trunc 32 B", "t1 seq, trunc 32 B", 1),
    true,
  ),
  onSweep(
    "CfL paid at 32 B (`L24@5 C9@4`) against the shipped layout",
    "7.10",
    "cfl",
    deltaFigure("32B paid cfl5 L24C9", CFL_SHIPPED),
    true,
  ),
  onSweep(
    "CfL free at code 1",
    "7.10",
    "cfl",
    deltaFigure("32B free cfl5 (34 B)", CFL_SHIPPED),
    true,
  ),
  onSweep(
    "CfL free at code 3",
    "7.10",
    "cfl",
    deltaFigure("411B t2 free cfl5", "411B t2 shipped"),
    true,
  ),
  onSweep(
    "CfL free at code 4",
    "7.10",
    "cfl",
    deltaFigure("1623B t3 free cfl5", "1623B t3 shipped"),
    true,
  ),
  onSweep(
    "`aniso 0.9 / hv 0` against the default",
    "11.5",
    "selection-weights",
    deltaFigure("aniso=0.9 hv=0.0", SEL_DEFAULT),
  ),
  onSweep(
    "`aniso 0.9 / hv 0`, Holm p",
    "11.5",
    "selection-weights",
    holmFigure("aniso=0.9 hv=0.0", SEL_DEFAULT),
  ),
  onSweep(
    "`aniso 1.2 / hv 0` (`sel_hv` off), Holm p",
    "11.5",
    "selection-weights",
    holmFigure("aniso=1.2 hv=0.0", SEL_DEFAULT),
  ),
  onSweep(
    "`sel_hv` 0.15 → 0.30",
    "11.5",
    "selection-weights",
    deltaFigure("aniso=1.2 hv=0.3", SEL_DEFAULT),
  ),
  onSweep(
    "window `w_min 0.5 exp 2` at code 1, spurious detail",
    "12.2",
    "synthesis-window",
    spuriousCutFigure("w_min 0.5 exp 2", "shipped (no window)"),
  ),
  onSweep(
    "window `w_min 0.85 exp 1` at code 1, ΔE00",
    "12.2",
    "synthesis-window",
    deltaFigure("w_min 0.85 exp 1", "shipped (no window)"),
  ),
  onSweep(
    "window `w_min 0.85 exp 1` at code 2, ΔE00 Δ and interval",
    "12.3",
    "synthesis-window-upper",
    diffFigure("t2 w_min 0.85 exp 1", "t2 shipped (no window)", "ciede2000"),
  ),
  onSweep(
    "window `w_min 0.85 exp 1` at code 2, spurious detail",
    "12.3",
    "synthesis-window-upper",
    spuriousCutFigure("t2 w_min 0.85 exp 1", "t2 shipped (no window)"),
  ),
  onSweep(
    "the ladder, code 0 ΔE00",
    "13.1",
    "artifact-ladder",
    meanFigure(
      "code 0 (compact, 21 B)",
      "ciede2000",
      3,
      "code 1 (default, 32 B)",
    ),
    true,
  ),
  onSweep(
    "the ladder, code 1 ΔE00",
    "13.1",
    "artifact-ladder",
    meanFigure("code 1 (default, 32 B)", "ciede2000", 3, "code 2 (108 B)"),
    true,
  ),
  onSweep(
    "code 3 − code 2, spurious detail on the pinned grid",
    "13.2",
    "artifact-ladder-common-grid",
    diffFigure("code 3 (411 B)", "code 2 (108 B)", "spurious"),
    true,
  ),
  onSweep(
    "code 4 − code 2, spurious detail on the pinned grid",
    "13.2",
    "artifact-ladder-common-grid",
    diffFigure("code 4 (1623 B)", "code 2 (108 B)", "spurious"),
    true,
  ),
  onSweep(
    "`selection-weights`, arms that survive Holm",
    "13.5",
    "selection-weights",
    summaryFigure("differsHolm"),
  ),
  onSweep(
    "`selection-weights`, arms `ok` on intervals",
    "13.5",
    "selection-weights",
    summaryFigure("guardsOk"),
  ),
  onSweep(
    "`synthesis-window`, arms that survive Holm",
    "13.5",
    "synthesis-window",
    summaryFigure("differsHolm"),
  ),
];
