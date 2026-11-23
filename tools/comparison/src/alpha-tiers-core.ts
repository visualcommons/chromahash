/**
 * Register entry D6, the alpha allocation at codes 3–4
 * (`spec/V0.8-DECISIONS.md` D6): its candidates, how an `alpha-tiers34`
 * result is read, the opacity strata, and the selection rule.
 * `stratify --alpha-tiers`, `register-verdict D6` and `selftest:metrics`
 * read D6 through here.
 *
 * A candidate is a 190-bit alpha-mode base row at code 3 or 4. Each tier `k`
 * has one incumbent row, `tK A28@3 L22@4 C3@3 (shipped)`, and one row per
 * candidate, `tK <row>`, every one at the shipped alpha-mode length of its
 * tier.
 *
 * Each candidate is read under R1 against its own tier's incumbent: its mean
 * ΔE00 relative to the incumbent's (condition 1, at least 3.0% lower) and its
 * guards on the paired intervals (condition 3). The selection rule, fixed in
 * D6 before the first result, takes per tier the one candidate with the
 * lowest mean ΔE00 among those whose `guards (CI)` is not `FAIL`; a tier
 * whose pick is not at least 3.0% better on tune is decided in sample (Q13),
 * and the picks that are form one Holm family on `holdout3`'s alpha part.
 *
 * The opacity strata (D6, "The opacity strata"): `RATIONALE.md`'s future
 * work item 14 found that the ΔE00-optimal alpha point depended on the
 * corpus being mostly transparent, so every D6 table is also read in two
 * halves of the alpha corpus split at a non-opaque fraction of 0.5, the cut
 * holdout3's alpha cells were drawn on. Each image's fraction is its pin's
 * (`alpha-images.ts`), measured on the pinned bytes, so the split is fixed by
 * the corpus before any arm is read. On holdout3 the two halves join the
 * stratum rule beside the pinned strata.
 */

import { ALPHA_IMAGES } from "./alpha-images.ts";
import {
  type GuardVerdict,
  type PairableRow,
  type PairedStat,
  compareArms,
  guardVerdictOnIntervals,
  statFor,
} from "./arms-core.ts";
import {
  type StratumReading,
  strataMembers,
  stratumRule,
} from "./register-verdict-core.ts";
import type { GuardTolerances } from "./results.ts";
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED } from "./stats.ts";

/** The two tiers D6 decides, each separately. */
export const D6_TIERS = [3, 4] as const;
/** The tune sweep's name. */
export const D6_SWEEP = "alpha-tiers34";
/** The shipped base row, as the sweep labels it. */
export const D6_SHIPPED_ROW = "A28@3 L22@4 C3@3 (shipped)";
/** R1's condition 1, and Q13's in-sample bar: at least 3.0% lower mean ΔE00. */
export const D6_R1_GAIN = -3;
/** The non-opaque fraction the opacity strata are cut at. */
export const D6_OPACITY_CUT = 0.5;
/** The opacity strata's names, in report order. */
export const D6_OPACITY_STRATA = [
  "mostly-opaque",
  "mostly-transparent",
] as const;

export const incumbentLabel = (k: number): string => `t${k} ${D6_SHIPPED_ROW}`;

/** One candidate row, its code, and its tier's incumbent. */
export interface D6Spec {
  k: number;
  /** The row without its tier prefix, e.g. `A23@4 L20@4 C3@3`. */
  row: string;
  arm: string;
  incumbent: string;
}

const ARM_LABEL = /^t([34]) (A\d+@\d+ L\d+@\d+ C\d+@\d+)$/;

/**
 * Every candidate a result holds, in row order, by the labels
 * `alpha-tiers34` writes. An arm whose tier has no incumbent row is left out,
 * and so is the incumbent itself.
 */
export function d6Arms(rows: readonly { label: string }[]): D6Spec[] {
  const labels = new Set(rows.map((r) => r.label.trim()));
  const out: D6Spec[] = [];
  for (const r of rows) {
    const m = ARM_LABEL.exec(r.label.trim());
    if (!m) continue;
    const k = Number(m[1]);
    const incumbent = incumbentLabel(k);
    if (!labels.has(incumbent)) continue;
    out.push({ k, row: m[2] as string, arm: r.label.trim(), incumbent });
  }
  return out;
}

/**
 * An alpha image's non-opaque fraction, off its pin, or undefined for a name
 * no alpha pin carries.
 */
export function pinnedNonOpaque(name: string): number | undefined {
  return ALPHA_IMAGES.find((s) => s.label === name)?.nonOpaqueFraction;
}

/**
 * The opacity strata's image indices into `imageNames`: `mostly-opaque`
 * below {@link D6_OPACITY_CUT}, `mostly-transparent` at or above it. A name
 * with no alpha pin is in neither, and an empty half is left out.
 */
export function opacityMembers(
  imageNames: readonly string[],
  nonOpaqueOf: (name: string) => number | undefined = pinnedNonOpaque,
): Map<string, number[]> {
  const halves: [string, number[]][] = D6_OPACITY_STRATA.map((s) => [s, []]);
  for (const [i, name] of imageNames.entries()) {
    const f = nonOpaqueOf(name);
    if (f === undefined) continue;
    halves[f < D6_OPACITY_CUT ? 0 : 1]?.[1].push(i);
  }
  return new Map(halves.filter(([, idx]) => idx.length > 0));
}

/**
 * D6's strata: the ones the stratum rule names, found by `strataOf`, then
 * the two opacity halves.
 */
export function d6Members(
  imageNames: readonly string[],
  strataOf?: (name: string) => readonly string[],
  nonOpaqueOf?: (name: string) => number | undefined,
): Map<string, number[]> {
  return new Map([
    ...strataMembers(imageNames, strataOf),
    ...opacityMembers(imageNames, nonOpaqueOf),
  ]);
}

/** One candidate's reading against its tier's incumbent, at one seed. */
export interface D6Reading {
  spec: D6Spec;
  n: number;
  /** Paired ΔE00, arm − incumbent. */
  delta: PairedStat;
  /** Mean ΔE00 difference relative to the incumbent's mean, in percent. */
  rel: number;
  guards: GuardVerdict;
  /** Selectable on tune: guards (CI) not `FAIL`. */
  eligible: boolean;
  /** R1's condition 1 (and Q13's bar): {@link rel} at most −3.0%. */
  lower3: boolean;
  /** The stratum rule against the incumbent, when strata were given. */
  strata: StratumReading[] | undefined;
}

function rowOf(rows: readonly PairableRow[], label: string): PairableRow {
  const r = rows.find((x) => x.label.trim() === label);
  if (!r) throw new Error(`no arm ${JSON.stringify(label)} in the result`);
  return r;
}

/** Read one candidate overall, and per stratum when `members` is given. */
export function readD6(
  spec: D6Spec,
  rows: readonly PairableRow[],
  tol: GuardTolerances,
  members?: ReadonlyMap<string, readonly number[]>,
  seed: number = BOOTSTRAP_SEED,
): D6Reading {
  const arm = rowOf(rows, spec.arm);
  const incumbent = rowOf(rows, spec.incumbent);
  const [cmp] = compareArms([incumbent, arm], 0, BOOTSTRAP_RESAMPLES, seed);
  const delta = statFor(cmp, "ciede2000");
  if (!delta) throw new Error(`${spec.arm} carries no paired ΔE00`);
  const guards = guardVerdictOnIntervals(cmp, tol, undefined);
  const rel = (100 * delta.meanDelta) / delta.baseMean;
  return {
    spec,
    n: delta.pairs,
    delta,
    rel,
    guards,
    eligible: guards !== "FAIL",
    lower3: rel <= D6_R1_GAIN,
    strata: members
      ? stratumRule(arm, incumbent, members, tol, undefined, seed).strata
      : undefined,
  };
}

/** The selection rule's outcome at one tier. */
export interface D6TierPick {
  k: number;
  /** The eligible candidate with the lowest mean ΔE00, or null when none is eligible. */
  pick: D6Reading | null;
  /** Whether the pick clears Q13's 3.0% on tune, and so is frozen. */
  frozen: boolean;
  outcome: string;
}

/** The selection rule over both tiers. */
export interface D6Selection {
  tiers: D6TierPick[];
  /** The frozen arms, code 3 first: one Holm family on holdout3. */
  frozen: D6Reading[];
}

/**
 * D6's selection rule: per tier, the eligible candidate with the lowest mean
 * ΔE00 (the lowest mean, so the largest relative gain; a tie goes to the
 * earlier row), frozen if it is at least 3.0% better than the tier's
 * incumbent on tune and otherwise decided in sample under Q13. At most two
 * arms freeze, one per tier, so the register's two-arm cap never binds.
 */
export function selectD6(readings: readonly D6Reading[]): D6Selection {
  const tiers = D6_TIERS.map((k): D6TierPick => {
    let pick: D6Reading | null = null;
    for (const r of readings) {
      if (r.spec.k !== k || !r.eligible) continue;
      if (pick === null || r.delta.meanDelta < pick.delta.meanDelta) pick = r;
    }
    if (pick === null) {
      return {
        k,
        pick,
        frozen: false,
        outcome: "decided in sample: no candidate's guards (CI) avoid FAIL",
      };
    }
    return pick.lower3
      ? { k, pick, frozen: true, outcome: "frozen" }
      : {
          k,
          pick,
          frozen: false,
          outcome: "decided in sample: the pick is not 3.0% better (Q13)",
        };
  });
  return {
    tiers,
    frozen: tiers.flatMap((t) => (t.frozen && t.pick ? [t.pick] : [])),
  };
}

/** A selection's identity, to compare it across seeds: each tier's pick and whether it froze. */
export const selectionKey = (s: D6Selection): string =>
  s.tiers
    .map((t) => `t${t.k} ${t.pick?.spec.row ?? "none"} ${t.frozen}`)
    .join(" | ");
