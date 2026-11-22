/**
 * The derivation `mise run register-verdict` prints: a frozen register entry's
 * judged comparisons, applied to its committed holdout2 results.
 * `spec/V0.8-DECISIONS.md` names every judged comparison and its baseline at
 * the freeze; this reads them back from `tools/comparison/results/` and
 * re-scores nothing.
 *
 * R1, per comparison (arm against the named baseline, at equal bytes):
 *   1. mean ΔE00 at least 3.0% lower (point estimate);
 *   2. the paired ΔE00 difference significant at 0.05 after Holm across the
 *      entry's judged comparisons (the family the freeze names, not the sweep's
 *      arms: some of those are at another budget and are not judged);
 *   3. every guard `ok` on the paired intervals, at the tolerances the run
 *      recorded (`guardVerdictOnIntervals` — the rule `arms` prints for the
 *      incumbent, applied here to the named baseline. The freeze said
 *      conditions 1–3 "come from `mise run arms`", whose guard table covers
 *      row 0 only; applying the same rule to a named baseline was defined
 *      after the reads, and EXPERIMENTS.md §13.7 records it as a deviation);
 *   4. the R1 outcome of every comparison unchanged under N other bootstrap
 *      seeds, re-deriving p, the entry-family Holm and every guard interval
 *      against the same named baselines. `arms --seed-sensitivity` cannot do
 *      this: it compares every arm with row 0 across the sweep.
 *
 * Every result must carry the freeze's provenance — rev {@link FREEZE_REV} and
 * a clean tree — or this refuses to derive a verdict from it.
 *
 * It calls the same `compareArms`, `holm` and bootstrap the sweeps use and
 * changes no statistic. It is a module of its own so that two gates can reach
 * it: `verify:experiments` binds §13.7's `p Holm` and `guards (CI)` columns to
 * {@link deriveVerdict}, and `selftest:metrics` asserts the R1 outcomes,
 * condition 4 and C1's admission it returns, so a change to `arms-core.ts` or
 * `stats.ts` that moved a frozen verdict fails both.
 */

import path from "node:path";
import {
  type GuardVerdict,
  type PairedStat,
  compareArms,
  guardVerdictOnIntervals,
  pairedDeltas,
  statFor,
} from "./arms-core.ts";
import {
  type GuardTolerances,
  type ResultFile,
  readResult,
} from "./results.ts";
import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  bootstrapCI,
  bootstrapP,
  holm,
} from "./stats.ts";

/** The commit C1 and C2 froze at, and every holdout2 read was scored at. */
export const FREEZE_REV = "2047f7df6f6e043b06f0676c7da9bc701fadaf46";

/** [result, arm, baseline]: one judged comparison, as the freeze names it. */
export type Comparison = readonly [string, string, string];

const PHOTO = "c1-confirm-photo-holdout2";
const ALPHA = "v07-holdout-alpha-holdout2";
const ALPHA_T1 = "alpha-tier1-holdout2";
const INCUMBENT = "SS10 constants (incumbent)";
const COMPACT = "compact 21B L19@4 C6@3";

/** The comparisons each entry froze (spec/V0.8-DECISIONS.md, C1 and C2). */
export const FROZEN: Record<string, readonly Comparison[]> = {
  C1: [
    [PHOTO, "sel_hv=0.30", INCUMBENT],
    [PHOTO, "isotropic (aniso=0 hv=0)", INCUMBENT],
    [PHOTO, "pre-adoption v0.6-derived", INCUMBENT],
    [PHOTO, "sel_hv=0 aniso=1.2", INCUMBENT],
    [PHOTO, "compact 21B L18@4 C7@3", COMPACT],
    [PHOTO, "compact 21B L20@4 C5@3", COMPACT],
    [PHOTO, "compact 21B L26@3 C6@3", COMPACT],
    [PHOTO, "compact 21B shipped shape", COMPACT],
  ],
  C2: [
    [ALPHA, "ADOPTED A28@3 L22@4 C3@3", "SHIPPED A5@4 L20@5 C9@4"],
    [
      ALPHA,
      "compact 21B ADOPTED A16@3 L12@4 C1@3",
      "compact 21B shipped shape",
    ],
    [ALPHA, "+ alpha_ac_fit", "ADOPTED A28@3 L22@4 C3@3"],
    [ALPHA_T1, "A28@3 L22@4 C3@3 (t0 winner)", "SHIPPED A5@4 L20@5 C9@4"],
  ],
};

/** C1's ThumbHash admission: the shipped compact row against ThumbHash. */
const ADMISSION = {
  result: "rd-budget-holdout2",
  ours: "ChromaHash@21B",
  theirs: "ThumbHash",
} as const;

const METRICS = [
  ["ciede2000", "lower"],
  ["ssimulacra2", "higher"],
  ["butteraugli", "lower"],
  ["dssim", "lower"],
] as const;

/** The committed results directory the freeze's reads were written to. */
export const RESULTS_DIR = path.join(import.meta.dirname, "..", "results");

const same = (a: string, b: string): boolean => a.trim() === b.trim();

type Row = ResultFile["rows"][number];

/** One judged comparison, with R1's conditions 1–3 at the default seed. */
export interface JudgedComparison {
  result: string;
  arm: string;
  base: string;
  stat: PairedStat;
  /** Mean ΔE00 difference relative to the baseline's mean, in percent. */
  rel: number;
  /** Holm-adjusted across the entry's judged comparisons. */
  pHolm: number;
  /**
   * Whether the raw p is the bootstrap's resolution floor, 2/(B+1), so the
   * adjusted value is an upper bound rather than an estimate.
   */
  atFloor: boolean;
  guards: GuardVerdict;
  medians: readonly [number, number];
  r1: { lower3: boolean; holm: boolean; guardsOk: boolean; pass: boolean };
  armRow: Row;
  baseRow: Row;
  tol: GuardTolerances;
  /** The run's `artifactGuardRise`, or undefined where it declared none. */
  rise: number | undefined;
}

export interface AdmissionMetric {
  key: string;
  ours: number;
  theirs: number;
  wins: boolean;
  ci: readonly [number, number];
  excludesZero: boolean;
}

export interface EntryVerdict {
  id: string;
  comparisons: JudgedComparison[];
  /** The seeds condition 4 re-drew under, none of them BOOTSTRAP_SEED. */
  seeds: number[];
  /** Every comparison whose R1 outcome turned under one of {@link seeds}. */
  turned: { seed: number; arm: string; base: string }[];
  /** C1 only: the shipped compact row against ThumbHash on point means. */
  admission?: { metrics: AdmissionMetric[]; holds: boolean };
}

function load(dir: string, name: string): ResultFile {
  const file = readResult(dir, name);
  if (!file) throw new Error(`no committed result ${name}`);
  if (file.provenance.rev !== FREEZE_REV || file.provenance.dirty !== false) {
    throw new Error(
      `${name} was not scored at the freeze from a clean tree (rev ${file.provenance.rev}, dirty ${file.provenance.dirty}); refusing to derive a verdict from it`,
    );
  }
  return file;
}

function rowIndex(file: ResultFile, label: string): number {
  const i = file.rows.findIndex((r) => same(r.label, label));
  if (i < 0) throw new Error(`no arm ${JSON.stringify(label)} in ${file.name}`);
  return i;
}

function finite(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null && Number.isFinite(v));
}

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2
    ? (s[m] as number)
    : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/**
 * Condition 3 under `seed`: {@link guardVerdictOnIntervals} itself -- the
 * ringing and spurious guards where the run declared `artifactGuardRise`, and
 * the zero-baseline allowance included -- read off `compareArms`' intervals
 * re-drawn at `seed` against the named baseline. At {@link BOOTSTRAP_SEED} it
 * is condition 3 exactly, which `selftest:metrics` asserts.
 */
export function guardsAtSeed(
  arm: Row,
  base: Row,
  tol: GuardTolerances,
  artifactRise: number | undefined,
  seed: number,
): GuardVerdict {
  const [cmp] = compareArms([base, arm], 0, BOOTSTRAP_RESAMPLES, seed);
  return guardVerdictOnIntervals(cmp, tol, artifactRise);
}

const passes = (
  rel: number,
  delta: number,
  pHolm: number,
  guards: string,
): boolean => rel <= -3 && pHolm < 0.05 && delta < 0 && guards === "ok";

/**
 * Derive entry `id`'s verdict from the committed results in `dir`. Condition 4
 * runs under `seedCount` seeds other than BOOTSTRAP_SEED (0 skips it).
 */
export function deriveVerdict(
  id: string,
  seedCount: number,
  dir: string = RESULTS_DIR,
): EntryVerdict {
  const frozen = FROZEN[id];
  if (!frozen) throw new Error(`no frozen register entry ${id}`);

  const floor = Math.min(1, 2 / (BOOTSTRAP_RESAMPLES + 1));
  const partial = frozen.map(([name, arm, base]) => {
    const file = load(dir, name);
    const bi = rowIndex(file, base);
    const ai = rowIndex(file, arm);
    const cmp = compareArms(file.rows, bi).find((c) => same(c.label, arm));
    const stat = statFor(cmp, "ciede2000");
    if (!stat) throw new Error(`${arm} carries no ΔE00 in ${name}`);
    const tol = file.settings.guardTolerances as GuardTolerances;
    const rise =
      (file.settings.artifactGuardRise as number | null) ?? undefined;
    const armRow = file.rows[ai];
    const baseRow = file.rows[bi];
    if (!armRow || !baseRow) throw new Error(`rows missing in ${name}`);
    return {
      result: name,
      arm: arm.trim(),
      base,
      stat,
      rel: (100 * stat.meanDelta) / stat.baseMean,
      atFloor: stat.p <= floor,
      guards: guardVerdictOnIntervals(cmp, tol, rise),
      medians: [
        median(finite(armRow.perImage.ciede2000 ?? [])),
        median(finite(baseRow.perImage.ciede2000 ?? [])),
      ] as const,
      armRow,
      baseRow,
      tol,
      rise,
    };
  });

  const adjusted = holm(partial.map((l) => l.stat.p));
  const comparisons: JudgedComparison[] = partial.map((l, k) => {
    const pHolm = adjusted[k] ?? 1;
    const lower3 = l.rel <= -3;
    const significant = pHolm < 0.05 && l.stat.meanDelta < 0;
    const guardsOk = l.guards === "ok";
    return {
      ...l,
      pHolm,
      r1: {
        lower3,
        holm: significant,
        guardsOk,
        pass: passes(l.rel, l.stat.meanDelta, pHolm, l.guards),
      },
    };
  });

  const seeds: number[] = [];
  for (let s = 1; seeds.length < seedCount; s++) {
    if (s !== BOOTSTRAP_SEED) seeds.push(s);
  }
  const turned: EntryVerdict["turned"] = [];
  for (const seed of seeds) {
    const ps = comparisons.map((l) => {
      const d = pairedDeltas(
        l.armRow.perImage.ciede2000 ?? [],
        l.baseRow.perImage.ciede2000 ?? [],
      );
      return bootstrapP(d.deltas, BOOTSTRAP_RESAMPLES, seed);
    });
    const adj = holm(ps);
    for (const [k, l] of comparisons.entries()) {
      const g = guardsAtSeed(l.armRow, l.baseRow, l.tol, l.rise, seed);
      if (passes(l.rel, l.stat.meanDelta, adj[k] ?? 1, g) !== l.r1.pass) {
        turned.push({ seed, arm: l.arm, base: l.base });
      }
    }
  }

  const verdict: EntryVerdict = { id, comparisons, seeds, turned };
  if (id === "C1") {
    const file = load(dir, ADMISSION.result);
    const ours = file.rows[rowIndex(file, ADMISSION.ours)];
    const theirs = file.rows[rowIndex(file, ADMISSION.theirs)];
    if (!ours || !theirs) throw new Error("admission rows missing");
    const metrics = METRICS.map(([key, better]): AdmissionMetric => {
      const a = mean(finite(ours.perImage[key] ?? []));
      const b = mean(finite(theirs.perImage[key] ?? []));
      const d = pairedDeltas(
        ours.perImage[key] ?? [],
        theirs.perImage[key] ?? [],
      );
      const [lo, hi] = bootstrapCI(d.deltas);
      return {
        key,
        ours: a,
        theirs: b,
        wins: better === "lower" ? a < b : a > b,
        ci: [lo, hi],
        excludesZero: better === "lower" ? hi < 0 : lo > 0,
      };
    });
    verdict.admission = { metrics, holds: metrics.every((m) => m.wins) };
  }
  return verdict;
}
