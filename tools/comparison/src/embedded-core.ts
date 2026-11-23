/**
 * Register entry D2's reading of an `embedded-tiers-ladder` result
 * (`spec/V0.8-DECISIONS.md`, D2, "How the primary metric is read"): each
 * prefix cut against native code k, with the same run's gap from native k−1
 * to native k as its margin, overall and per holdout3 stratum.
 *
 * For cut k, `Δ_k` is the per-image ΔE00 of the cut minus native code k and
 * `g_k` that of native code k−1 minus native code k, both paired:
 *
 *   1. condition 1: the upper bound `U_k` of the paired 95% interval of mean
 *      `Δ_k` is below `G_k`, the mean of `g_k`;
 *   2. condition 2: every guard `ok` on the paired intervals against native k;
 *   3. the stratum rule, with D2's own margin: a stratum fails the cut if a
 *      guard is `FAIL` there, or if the lower bound of its `Δ_k` interval is
 *      above that stratum's own `G_k`. The literal +1.0%-of-native-k test is
 *      reported beside it and gates nothing;
 *   4. condition 4: every frozen cut's outcome unchanged under other seeds.
 *
 * No Holm adjustment applies: the conditions are interval bounds, and D2 is
 * adopted only if every frozen cut passes (an intersection–union test).
 *
 * On tune, the selection rule reads the same quantities as point estimates:
 * a cut qualifies if its mean `Δ_k` is below `G_k` and its guards are not
 * `FAIL`, and at most two qualifying cuts are frozen, those with the largest
 * relative margin `(G_k − mean Δ_k) / mean(native k)`.
 *
 * It calls the same `compareArms`, interval guards and bootstrap the sweeps
 * use and changes no statistic. `stratify --embedded` and `selftest:metrics`
 * read D2 through here; `register-verdict` and `verify:experiments` do not
 * import it.
 */

import {
  type GuardVerdict,
  type PairableRow,
  type PairedStat,
  compareArms,
  guardVerdictOnIntervals,
  statFor,
} from "./arms-core.ts";
import { subsetRow } from "./register-verdict-core.ts";
import type { GuardTolerances } from "./results.ts";
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED } from "./stats.ts";

/** One prefix cut of a ladder: the arm, its native code k, and native k−1. */
export interface CutSpec {
  /** The cut's code: the arm decodes the first L(k) bytes. */
  k: number;
  /** `interleaved` (D2's candidate) or `seq` (the control). */
  order: "interleaved" | "seq";
  cut: string;
  native: string;
  below: string;
}

const CUT_LABEL = /^t(\d) (interleaved|seq) cut (\d)$/;

/**
 * Every cut a ladder's rows hold, in row order, by the labels
 * `embedded-tiers-ladder` writes: `tJ interleaved cut k` or `tJ seq cut k`
 * with `J = k + 1`, read against `tk native` and `t(k−1) native`. A cut whose
 * native arms are not both in the rows is left out, as is any label that
 * does not cut one code down.
 */
export function embeddedCuts(rows: readonly { label: string }[]): CutSpec[] {
  const labels = new Set(rows.map((r) => r.label.trim()));
  const out: CutSpec[] = [];
  for (const r of rows) {
    const m = CUT_LABEL.exec(r.label.trim());
    if (!m) continue;
    const j = Number(m[1]);
    const k = Number(m[3]);
    if (j !== k + 1 || k < 1) continue;
    const native = `t${k} native`;
    const below = `t${k - 1} native`;
    if (!labels.has(native) || !labels.has(below)) continue;
    out.push({
      k,
      order: m[2] as CutSpec["order"],
      cut: r.label.trim(),
      native,
      below,
    });
  }
  return out;
}

/** Conditions 1 and 2 over one set of images (overall, or a stratum). */
export interface CutStat {
  n: number;
  /** Paired ΔE00, cut − native k. */
  delta: PairedStat;
  /** Paired ΔE00, native k−1 − native k: `meanDelta` is `G_k`. */
  gap: PairedStat;
  guards: GuardVerdict;
}

/** One cut's reading, overall, at one seed. */
export interface CutReading extends CutStat {
  spec: CutSpec;
  /** `U_k`: the upper bound of `delta`'s interval. */
  upper: number;
  /** `G_k`: the mean paired gap. */
  gapMean: number;
  /** Condition 1: `U_k < G_k`. */
  cond1: boolean;
  /** Condition 2: every guard `ok` on intervals. */
  guardsOk: boolean;
  /** The selection rule's tune test: mean Δ below `G_k`, guards not FAIL. */
  qualifies: boolean;
  /** `(G_k − mean Δ_k) / mean(native k)`, in percent: the selection's key. */
  marginRel: number;
  /** The stratum rule, when strata were given. */
  strata: CutStratum[] | undefined;
  /** Conditions 1 and 2, and no stratum failing. */
  pass: boolean;
}

/** One stratum of a cut's reading. */
export interface CutStratum extends CutStat {
  stratum: string;
  /** `delta`'s lower bound relative to the stratum's native-k mean, in percent. */
  lowerRel: number;
  /** `G_k` in this stratum, relative to its native-k mean, in percent. */
  gapRel: number;
  /**
   * `FAIL` if a guard is `FAIL` or `delta`'s lower bound is above this
   * stratum's `G_k`; otherwise the guards' verdict, `inconclusive` included,
   * which does not fail the cut.
   */
  verdict: GuardVerdict;
  /** The stratum rule's literal +1.0%-of-native-k ΔE00 test; gates nothing. */
  literalFails: boolean;
}

/** Conditions 1 and 2's quantities over the given rows, at `seed`. */
export function cutStat(
  cut: PairableRow,
  native: PairableRow,
  below: PairableRow,
  tol: GuardTolerances,
  artifactRise: number | undefined,
  seed: number = BOOTSTRAP_SEED,
): CutStat {
  const [cmp] = compareArms([native, cut], 0, BOOTSTRAP_RESAMPLES, seed);
  const [gapCmp] = compareArms([native, below], 0, BOOTSTRAP_RESAMPLES, seed);
  const delta = statFor(cmp, "ciede2000");
  const gap = statFor(gapCmp, "ciede2000");
  if (!delta || !gap) throw new Error(`${cut.label} carries no paired ΔE00`);
  return {
    n: delta.pairs,
    delta,
    gap,
    guards: guardVerdictOnIntervals(cmp, tol, artifactRise),
  };
}

/** The stratum rule for one cut, with D2's tier-step margin. */
export function cutStrata(
  cut: PairableRow,
  native: PairableRow,
  below: PairableRow,
  members: ReadonlyMap<string, readonly number[]>,
  tol: GuardTolerances,
  artifactRise: number | undefined,
  seed: number = BOOTSTRAP_SEED,
): CutStratum[] {
  const out: CutStratum[] = [];
  for (const [stratum, idx] of members) {
    const s = cutStat(
      subsetRow(cut, idx),
      subsetRow(native, idx),
      subsetRow(below, idx),
      tol,
      artifactRise,
      seed,
    );
    const worse = s.delta.ci[0] > s.gap.meanDelta;
    out.push({
      ...s,
      stratum,
      lowerRel: (100 * s.delta.ci[0]) / s.delta.baseMean,
      gapRel: (100 * s.gap.meanDelta) / s.delta.baseMean,
      verdict: s.guards === "FAIL" || worse ? "FAIL" : s.guards,
      literalFails: s.delta.ci[0] > 0.01 * s.delta.baseMean,
    });
  }
  return out;
}

/** A labelled ladder row, as a committed result holds it. */
export type LadderRow = PairableRow;

function row(rows: readonly LadderRow[], label: string): LadderRow {
  const r = rows.find((x) => x.label.trim() === label);
  if (!r) throw new Error(`no arm ${JSON.stringify(label)} in the ladder`);
  return r;
}

/** Read one cut overall, and per stratum when `members` is given. */
export function readCut(
  spec: CutSpec,
  rows: readonly LadderRow[],
  tol: GuardTolerances,
  artifactRise: number | undefined,
  members?: ReadonlyMap<string, readonly number[]>,
  seed: number = BOOTSTRAP_SEED,
): CutReading {
  const cut = row(rows, spec.cut);
  const native = row(rows, spec.native);
  const below = row(rows, spec.below);
  const s = cutStat(cut, native, below, tol, artifactRise, seed);
  const upper = s.delta.ci[1];
  const gapMean = s.gap.meanDelta;
  const cond1 = upper < gapMean;
  const guardsOk = s.guards === "ok";
  const strata = members
    ? cutStrata(cut, native, below, members, tol, artifactRise, seed)
    : undefined;
  const strataOk = !strata?.some((x) => x.verdict === "FAIL");
  return {
    ...s,
    spec,
    upper,
    gapMean,
    cond1,
    guardsOk,
    qualifies: s.delta.meanDelta < gapMean && s.guards !== "FAIL",
    marginRel: (100 * (gapMean - s.delta.meanDelta)) / s.delta.baseMean,
    strata,
    pass: cond1 && guardsOk && strataOk,
  };
}

/**
 * The selection rule over the interleaved cuts' tune readings: every one that
 * qualifies, at most two of them frozen by relative margin (largest first,
 * ties to the lower cut), and the rest decided in sample.
 */
export function selectCuts(readings: readonly CutReading[]): {
  frozen: CutReading[];
  notQualified: CutReading[];
  capped: CutReading[];
} {
  const candidates = readings.filter((r) => r.spec.order === "interleaved");
  const qualified = candidates
    .filter((r) => r.qualifies)
    .sort((a, b) => b.marginRel - a.marginRel || a.spec.k - b.spec.k);
  return {
    frozen: qualified.slice(0, 2).sort((a, b) => a.spec.k - b.spec.k),
    notQualified: candidates.filter((r) => !r.qualifies),
    capped: qualified.slice(2),
  };
}
