/**
 * Register entry D3's reading of a `synthesis-window-codes34` result
 * (`spec/V0.8-DECISIONS.md`, D3, "How the primary metric is read"): each
 * window arm `A` at code k (3 or 4) against its own tier's shipped arm `I`,
 * and its spurious detail against shipped code 2, the floor `F`:
 *
 *   1. the primary: the upper bound of the paired 95% interval of spurious
 *      `A − F` is at most 0 (a comparison across two byte counts);
 *   2. condition 1: the upper bound of the paired ΔE00 interval of `A − I` is
 *      at most +1.0% of `I`'s mean (R2's default δ);
 *   3. condition 2: every guard `ok` on the paired intervals against `I`,
 *      with no artifact guard (spurious is the primary, not a guard);
 *   4. the stratum rule against `I`, as written (`stratumRule`), with each
 *      stratum's spurious `A − F` reported beside it, gating nothing;
 *   5. condition 4: every frozen arm's outcome unchanged under other seeds.
 *
 * No Holm adjustment applies: every condition is an interval bound, and each
 * code is its own question.
 *
 * On tune the selection rule reads the same quantities as point estimates: an
 * arm qualifies if its mean spurious `A − F` is at most 0, its mean ΔE00
 * `A − I` at most +1.0% of `I`'s mean, and its guards against `I` not `FAIL`;
 * per code the one qualifying arm with the lowest mean spurious detail is
 * frozen (ties to the lower mean ΔE00, then the earlier row).
 *
 * It calls the same `compareArms`, interval guards, bootstrap and stratum rule
 * the sweeps and `register-verdict` use and changes no statistic.
 * `stratify --window` and `selftest:metrics` read D3 through here.
 */

import {
  type GuardVerdict,
  type PairableRow,
  type PairedStat,
  compareArms,
  guardVerdictOnIntervals,
  statFor,
} from "./arms-core.ts";
import {
  FREEZE_REVS,
  RESULTS_DIR,
  type StratumReading,
  load,
  strataMembers,
  stratumRule,
} from "./register-verdict-core.ts";
import type { GuardTolerances, PerImage } from "./results.ts";
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED } from "./stats.ts";

/** R2's default non-inferiority margin δ, as a fraction of `I`'s mean. */
export const WINDOW_DE00_MARGIN = 0.01;

/** The floor every window arm's spurious detail is read against. */
export const WINDOW_FLOOR = "t2 shipped (no window)";

/** One window arm, its code, and its tier's shipped arm. */
export interface WindowSpec {
  k: number;
  arm: string;
  incumbent: string;
  floor: string;
}

const ARM_LABEL = /^t([34]) (.+)$/;

/**
 * Every window arm a result holds, in row order, by the labels
 * `synthesis-window-codes34` writes: `tK <window>` read against
 * `tK shipped (no window)` and the code-2 floor. A shipped arm is an
 * incumbent, not a candidate; an arm whose incumbent or floor is not in the
 * rows is left out.
 */
export function windowArms(rows: readonly { label: string }[]): WindowSpec[] {
  const labels = new Set(rows.map((r) => r.label.trim()));
  if (!labels.has(WINDOW_FLOOR)) return [];
  const out: WindowSpec[] = [];
  for (const r of rows) {
    const label = r.label.trim();
    const m = ARM_LABEL.exec(label);
    if (!m || m[2] === "shipped (no window)") continue;
    const incumbent = `t${m[1]} shipped (no window)`;
    if (!labels.has(incumbent)) continue;
    out.push({ k: Number(m[1]), arm: label, incumbent, floor: WINDOW_FLOOR });
  }
  return out;
}

/** The quantities of one arm over one set of images (overall, or a stratum). */
export interface WindowStat {
  n: number;
  /** Paired spurious detail, `A − F`. */
  spurious: PairedStat;
  /** Paired ΔE00, `A − I`. */
  delta: PairedStat;
  guards: GuardVerdict;
}

/** One window arm's reading, overall, at one seed. */
export interface WindowReading extends WindowStat {
  spec: WindowSpec;
  /** The primary: the upper bound of spurious `A − F` at most 0. */
  primary: boolean;
  /** Condition 1: the upper bound of ΔE00 `A − I` at most δ · mean(I). */
  cond1: boolean;
  /** Condition 2: every guard `ok` on intervals. */
  guardsOk: boolean;
  /** Mean ΔE00 `A − I` relative to mean(I), in percent. */
  deltaRel: number;
  /** The selection rule's tune test. */
  qualifies: boolean;
  /** The stratum rule against `I`, when strata were given. */
  strata: WindowStratum[] | undefined;
  /** The primary, conditions 1 and 2, and no stratum failing. */
  pass: boolean;
}

/** One stratum of an arm's reading: the stratum rule, and spurious beside it. */
export interface WindowStratum extends StratumReading {
  /** Spurious `A − F` in this stratum; reported, gates nothing. */
  spurious: PairedStat | undefined;
}

const subset = (row: PairableRow, idx: readonly number[]): PairableRow => {
  const perImage: PerImage = {};
  for (const [key, series] of Object.entries(row.perImage) as [
    keyof PerImage,
    (number | null)[] | undefined,
  ][]) {
    if (series) perImage[key] = idx.map((i) => series[i] ?? null);
  }
  return { label: row.label, perImage };
};

/** The primary's and conditions 1–2's quantities, at `seed`. */
export function windowStat(
  arm: PairableRow,
  incumbent: PairableRow,
  floor: PairableRow,
  tol: GuardTolerances,
  seed: number = BOOTSTRAP_SEED,
): WindowStat {
  const [cmp] = compareArms([incumbent, arm], 0, BOOTSTRAP_RESAMPLES, seed);
  const [floorCmp] = compareArms([floor, arm], 0, BOOTSTRAP_RESAMPLES, seed);
  const delta = statFor(cmp, "ciede2000");
  const spurious = statFor(floorCmp, "spurious");
  if (!delta) throw new Error(`${arm.label} carries no paired ΔE00`);
  if (!spurious) throw new Error(`${arm.label} carries no paired spurious`);
  return {
    n: delta.pairs,
    spurious,
    delta,
    guards: guardVerdictOnIntervals(cmp, tol, undefined),
  };
}

function row(rows: readonly PairableRow[], label: string): PairableRow {
  const r = rows.find((x) => x.label.trim() === label);
  if (!r) throw new Error(`no arm ${JSON.stringify(label)} in the result`);
  return r;
}

/** Read one window arm overall, and per stratum when `members` is given. */
export function readWindow(
  spec: WindowSpec,
  rows: readonly PairableRow[],
  tol: GuardTolerances,
  members?: ReadonlyMap<string, readonly number[]>,
  seed: number = BOOTSTRAP_SEED,
): WindowReading {
  const arm = row(rows, spec.arm);
  const incumbent = row(rows, spec.incumbent);
  const floor = row(rows, spec.floor);
  const s = windowStat(arm, incumbent, floor, tol, seed);
  const margin = WINDOW_DE00_MARGIN * s.delta.baseMean;
  const primary = s.spurious.ci[1] <= 0;
  const cond1 = s.delta.ci[1] <= margin;
  const guardsOk = s.guards === "ok";
  let strata: WindowStratum[] | undefined;
  if (members) {
    const rule = stratumRule(arm, incumbent, members, tol, undefined, seed);
    strata = rule.strata.map((st) => {
      const idx = members.get(st.stratum) ?? [];
      const [c] = compareArms(
        [subset(floor, idx), subset(arm, idx)],
        0,
        BOOTSTRAP_RESAMPLES,
        seed,
      );
      return { ...st, spurious: statFor(c, "spurious") };
    });
  }
  const strataOk = !strata?.some((x) => x.verdict === "FAIL");
  return {
    ...s,
    spec,
    primary,
    cond1,
    guardsOk,
    deltaRel: (100 * s.delta.meanDelta) / s.delta.baseMean,
    qualifies:
      s.spurious.meanDelta <= 0 &&
      s.delta.meanDelta <= margin &&
      s.guards !== "FAIL",
    strata,
    pass: primary && cond1 && guardsOk && strataOk,
  };
}

/** A frozen window entry's holdout read: the result, and the arms it judges. */
export interface WindowFreeze {
  result: string;
  arms: readonly string[];
}

/** D3's verdict on its holdout read, with condition 4 across other seeds. */
export interface WindowVerdict {
  id: string;
  result: string;
  readings: WindowReading[];
  seeds: number[];
  /** Every frozen arm whose outcome, overall or in a stratum, turned at a seed. */
  turned: { seed: number; arm: string }[];
}

/** The outcome condition 4 holds still: the pass, and every stratum's verdict. */
const outcome = (r: WindowReading): string =>
  `${r.pass}|${(r.strata ?? []).map((s) => `${s.stratum}:${s.verdict}`).join(",")}`;

/**
 * D3's verdict from a holdout result's rows: every frozen arm read overall and
 * per stratum at the harness seed, then re-read under `seedCount` other seeds.
 */
export function windowVerdict(
  id: string,
  result: string,
  rows: readonly PairableRow[],
  arms: readonly string[],
  members: ReadonlyMap<string, readonly number[]>,
  tol: GuardTolerances,
  seedCount: number,
): WindowVerdict {
  const specs = windowArms(rows).filter((s) => arms.includes(s.arm));
  if (specs.length !== arms.length) {
    throw new Error(
      `${result} does not hold every frozen arm of ${id} (${arms.join(", ")}) beside its shipped arm and ${WINDOW_FLOOR}`,
    );
  }
  const readings = specs.map((s) => readWindow(s, rows, tol, members));
  const seeds: number[] = [];
  for (let s = 1; seeds.length < seedCount; s++) {
    if (s !== BOOTSTRAP_SEED) seeds.push(s);
  }
  const turned: WindowVerdict["turned"] = [];
  for (const seed of seeds) {
    for (const [i, spec] of specs.entries()) {
      const at = readWindow(spec, rows, tol, members, seed);
      const base = readings[i];
      if (base && outcome(at) !== outcome(base)) {
        turned.push({ seed, arm: spec.arm });
      }
    }
  }
  return { id, result, readings, seeds, turned };
}

/**
 * The arms each window entry froze, and the holdout result that reads them
 * (`spec/V0.8-DECISIONS.md`, D3, "Frozen arms").
 */
export const WINDOW_FROZEN: Record<string, WindowFreeze> = {
  D3: {
    result: "synthesis-window-codes34-frozen-holdout3",
    arms: ["t3 w_min 0.85 exp 1", "t4 w_min 0.7 exp 1"],
  },
};

/**
 * Derive window entry `id`'s verdict from its committed holdout3 read, which
 * must be scored at the entry's freeze rev from a clean tree.
 */
export function deriveWindowVerdict(
  id: string,
  seedCount: number,
  dir: string = RESULTS_DIR,
): WindowVerdict {
  const freeze = WINDOW_FROZEN[id];
  const rev = FREEZE_REVS[id];
  if (!freeze || !rev) throw new Error(`no frozen window entry ${id}`);
  const file = load(dir, freeze.result, rev);
  if (file.split !== "holdout3") {
    throw new Error(`${freeze.result} is not a holdout3 read`);
  }
  return windowVerdict(
    id,
    freeze.result,
    file.rows,
    freeze.arms,
    strataMembers(file.imageNames),
    file.settings.guardTolerances as GuardTolerances,
    seedCount,
  );
}

/**
 * The selection rule over the window arms' tune readings, per code: the one
 * qualifying arm with the lowest mean spurious detail (ties to the lower mean
 * ΔE00, then the earlier row) is frozen; a code with none is decided in
 * sample. One arm per code and two codes keeps the two-arm cap.
 */
export function selectWindows(readings: readonly WindowReading[]): {
  frozen: WindowReading[];
  decidedInSample: number[];
} {
  const frozen: WindowReading[] = [];
  const decidedInSample: number[] = [];
  for (const k of [...new Set(readings.map((r) => r.spec.k))].sort()) {
    const best = readings
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.spec.k === k && r.qualifies)
      .sort(
        (a, b) =>
          a.r.spurious.meanDelta - b.r.spurious.meanDelta ||
          a.r.delta.meanDelta - b.r.delta.meanDelta ||
          a.i - b.i,
      )[0];
    if (best) frozen.push(best.r);
    else decidedInSample.push(k);
  }
  return { frozen, decidedInSample };
}
