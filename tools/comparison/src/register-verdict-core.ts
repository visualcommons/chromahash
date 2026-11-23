/**
 * The derivation `mise run register-verdict` prints: a frozen register entry's
 * judged comparisons, applied to its committed holdout results.
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
 * On a holdout3 result, the stratum rule ({@link stratumRule}) also applies:
 * a comparison that passes 1–3 overall fails if any stratum the pins record
 * has a guard `FAIL` on its paired intervals, or a ΔE00 interval whose lower
 * bound is above +1.0% of the stratum's incumbent mean. Condition 4 re-draws
 * it with the rest. A holdout2 result records no strata, so C1 and C2 are
 * unchanged by it.
 *
 * Every result must carry its entry's freeze provenance — the rev
 * {@link FREEZE_REVS} names for the entry and a clean tree — or this refuses
 * to derive a verdict from it.
 *
 * It calls the same `compareArms`, `holm` and bootstrap the sweeps use and
 * changes no statistic. It is a module of its own so that two gates can reach
 * it: `verify:experiments` binds §13.7's `p Holm` and `guards (CI)` columns to
 * {@link deriveVerdict}, and `selftest:metrics` asserts the R1 outcomes,
 * condition 4 and C1's admission it returns, so a change to `arms-core.ts` or
 * `stats.ts` that moved a frozen verdict fails both.
 */

import path from "node:path";
import { ALPHA_IMAGES } from "./alpha-images.ts";
import {
  type GuardVerdict,
  type PairableRow,
  type PairedStat,
  compareArms,
  guardVerdictOnIntervals,
  pairedDeltas,
  statFor,
} from "./arms-core.ts";
import { HOLDOUT3_STRATA } from "./corpus.ts";
import { type CutReading, embeddedCuts, readCut } from "./embedded-core.ts";
import { GRAPHIC_IMAGES } from "./graphic-images.ts";
import { CURATED_IMAGES } from "./natural-images.ts";
import {
  type GuardTolerances,
  type PerImage,
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

/**
 * The commit each entry froze at, whose `tools/comparison` scored its holdout
 * read. Every result an entry's verdict rests on must record this rev and a
 * clean tree.
 */
export const FREEZE_REVS: Record<string, string> = {
  C1: FREEZE_REV,
  C2: FREEZE_REV,
  // D1 froze its code-3 and code-4 comparisons at #132's freeze commit.
  D1: "e3b2eb63eb08ff98a32cd980d9163cb1d0685490",
};

/** [result, arm, baseline]: one judged comparison, as the freeze names it. */
export type Comparison = readonly [string, string, string];

const PHOTO = "c1-confirm-photo-holdout2";
const ALPHA = "v07-holdout-alpha-holdout2";
const ALPHA_T1 = "alpha-tier1-holdout2";
const INCUMBENT = "SS10 constants (incumbent)";
const COMPACT = "compact 21B L19@4 C6@3";
/** D1's one holdout3 read: its frozen arms, each beside its tier's shipped arm. */
const D1_READ = "entropy-coded-ac-frozen-holdout3";

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
  D1: [
    [D1_READ, "t3 coded x3", "t3 shipped"],
    [D1_READ, "t4 coded x4", "t4 shipped"],
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
  /**
   * `strataOk`: no stratum fails the stratum rule. It holds trivially for a
   * result that is not a holdout3 read, which records no strata.
   */
  r1: {
    lower3: boolean;
    holm: boolean;
    guardsOk: boolean;
    strataOk: boolean;
    pass: boolean;
  };
  /** The stratum rule at the default seed; undefined unless a holdout3 result. */
  strata: StratumRule | undefined;
  /** Each stratum's image indices; undefined unless a holdout3 result. */
  members: Map<string, number[]> | undefined;
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

function load(dir: string, name: string, rev: string): ResultFile {
  const file = readResult(dir, name);
  if (!file) throw new Error(`no committed result ${name}`);
  if (file.provenance.rev !== rev || file.provenance.dirty !== false) {
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

// ─── The stratum rule (spec/V0.8-DECISIONS.md, "The stratum rule") ─────────

/**
 * A stratum fails the arm when the lower bound of its paired ΔE00 interval
 * (arm − incumbent) lies above this fraction of the stratum's incumbent mean.
 */
export const STRATUM_DE00_MARGIN = 0.01;

/** One stratum of a holdout3 result, against the incumbent. */
export interface StratumReading {
  stratum: string;
  /** Images of the result in the stratum. */
  n: number;
  /** The stratum's paired ΔE00 (arm − incumbent). */
  deltaE: PairedStat;
  /** The ΔE00 interval's lower bound, relative to the stratum's incumbent mean, in percent. */
  lowerRel: number;
  /** The guards on the stratum's paired intervals. */
  guards: GuardVerdict;
  /**
   * `FAIL` when a guard is `FAIL` or the ΔE00 lower bound is above
   * {@link STRATUM_DE00_MARGIN}; otherwise `inconclusive` when a guard is,
   * which is reported and does not fail; otherwise `ok`.
   */
  verdict: GuardVerdict;
}

/** The stratum rule over one comparison: every stratum's reading, and whether any fails. */
export interface StratumRule {
  strata: StratumReading[];
  fails: boolean;
}

/**
 * The strata a holdout3 pin records, by image name (the pin's label), across
 * the photographic, alpha and graphics tables. A name that is no holdout3 pin
 * has none.
 */
export function holdout3StrataOf(name: string): readonly string[] {
  const pin = [...CURATED_IMAGES, ...ALPHA_IMAGES, ...GRAPHIC_IMAGES].find(
    (s) => s.label === name,
  );
  return pin?.holdout3?.strata ?? [];
}

/**
 * Each stratum's image indices into `imageNames`, in the order a report lists
 * the strata. A stratum no image falls in is left out: it is not reported.
 */
export function strataMembers(
  imageNames: readonly string[],
  strataOf: (name: string) => readonly string[] = holdout3StrataOf,
): Map<string, number[]> {
  const members = new Map<string, number[]>();
  for (const stratum of HOLDOUT3_STRATA) {
    const idx = imageNames.flatMap((name, i) =>
      strataOf(name).includes(stratum) ? [i] : [],
    );
    if (idx.length > 0) members.set(stratum, idx);
  }
  return members;
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

/**
 * The stratum rule for one arm against its incumbent: in each stratum, the
 * guards on the stratum's paired intervals (`guardVerdictOnIntervals`, at the
 * run's tolerances) and the paired ΔE00 interval's lower bound against
 * {@link STRATUM_DE00_MARGIN} of the stratum's incumbent mean, drawn at
 * `seed`. The overall rule carries the decision; this only removes an arm
 * that passed it, and an `inconclusive` stratum does not.
 */
export function stratumRule(
  arm: PairableRow,
  base: PairableRow,
  members: ReadonlyMap<string, readonly number[]>,
  tol: GuardTolerances,
  artifactRise: number | undefined,
  seed: number = BOOTSTRAP_SEED,
): StratumRule {
  const strata: StratumReading[] = [];
  for (const [stratum, idx] of members) {
    const [cmp] = compareArms(
      [subset(base, idx), subset(arm, idx)],
      0,
      BOOTSTRAP_RESAMPLES,
      seed,
    );
    const deltaE = statFor(cmp, "ciede2000");
    if (!deltaE) {
      throw new Error(`stratum ${stratum} carries no paired ΔE00`);
    }
    const guards = guardVerdictOnIntervals(cmp, tol, artifactRise);
    const lowerRel = (100 * deltaE.ci[0]) / deltaE.baseMean;
    const worse = deltaE.ci[0] > STRATUM_DE00_MARGIN * deltaE.baseMean;
    strata.push({
      stratum,
      n: idx.length,
      deltaE,
      lowerRel,
      guards,
      verdict: guards === "FAIL" || worse ? "FAIL" : guards,
    });
  }
  return { strata, fails: strata.some((s) => s.verdict === "FAIL") };
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
  const rev = FREEZE_REVS[id];
  if (!frozen || !rev) throw new Error(`no frozen register entry ${id}`);

  const floor = Math.min(1, 2 / (BOOTSTRAP_RESAMPLES + 1));
  const partial = frozen.map(([name, arm, base]) => {
    const file = load(dir, name, rev);
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
    const members =
      file.split === "holdout3" ? strataMembers(file.imageNames) : undefined;
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
      members,
      strata: members
        ? stratumRule(armRow, baseRow, members, tol, rise)
        : undefined,
    };
  });

  const adjusted = holm(partial.map((l) => l.stat.p));
  const comparisons: JudgedComparison[] = partial.map((l, k) => {
    const pHolm = adjusted[k] ?? 1;
    const lower3 = l.rel <= -3;
    const significant = pHolm < 0.05 && l.stat.meanDelta < 0;
    const guardsOk = l.guards === "ok";
    const strataOk = !l.strata?.fails;
    return {
      ...l,
      pHolm,
      r1: {
        lower3,
        holm: significant,
        guardsOk,
        strataOk,
        pass: passes(l.rel, l.stat.meanDelta, pHolm, l.guards) && strataOk,
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
      const strataOk = l.members
        ? !stratumRule(l.armRow, l.baseRow, l.members, l.tol, l.rise, seed)
            .fails
        : true;
      const pass = passes(l.rel, l.stat.meanDelta, adj[k] ?? 1, g) && strataOk;
      if (pass !== l.r1.pass) {
        turned.push({ seed, arm: l.arm, base: l.base });
      }
    }
  }

  const verdict: EntryVerdict = { id, comparisons, seeds, turned };
  if (id === "C1") {
    const file = load(dir, ADMISSION.result, rev);
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

// ─── D2: embedded tiers (R2 with a tier-step margin) ───────────────────────

/**
 * D2's one holdout3 read and the cuts it froze (spec/V0.8-DECISIONS.md, D2).
 * D2 is not an R1 entry, so it is not in {@link FROZEN}: its comparisons are
 * cuts read by `embedded-core.ts`, each against native code k with the same
 * run's tier gap as its margin.
 */
export const D2_FROZEN: { result: string; cuts: readonly string[] } = {
  result: "embedded-tiers-ladder-frozen-holdout3",
  cuts: [],
};

/** Part 1 on a read: every interleaved full-length arm matched its native one. */
export interface IdentityCheck {
  arm: string;
  of: string;
  images: number;
}

export interface EmbeddedVerdict {
  id: "D2";
  /** Each frozen cut at the default seed, overall and per stratum. */
  cuts: CutReading[];
  /** Part 1: the identity checks the read recorded, one per code 0–4. */
  identity: IdentityCheck[];
  /** Whether every code 0–4 was checked on every image of the read. */
  identityHolds: boolean;
  seeds: number[];
  /** Every frozen cut whose outcome turned under one of {@link seeds}. */
  turned: { seed: number; cut: string }[];
  /** Every frozen cut passes, part 1 holds, and no outcome turns. */
  adopted: boolean;
}

/**
 * Derive D2's verdict from its committed holdout3 read: part 1 from the
 * identity checks the run recorded (it fails before writing if any image
 * differs, so a recorded check found none), and each frozen cut under D2's
 * conditions 1 and 2 and the stratum rule with its tier-step margin, with
 * condition 4 under `seedCount` other seeds.
 */
export function deriveEmbeddedVerdict(
  seedCount: number,
  dir: string = RESULTS_DIR,
  frozen: { result: string; cuts: readonly string[] } = D2_FROZEN,
): EmbeddedVerdict {
  const rev = FREEZE_REVS.D2;
  if (!rev || frozen.cuts.length === 0) {
    throw new Error("D2 has not frozen: no freeze rev or no frozen cut");
  }
  const file = load(dir, frozen.result, rev);
  if (file.split !== "holdout3") {
    throw new Error(`${frozen.result} is not a holdout3 read`);
  }
  const tol = file.settings.guardTolerances as GuardTolerances;
  const rise = (file.settings.artifactGuardRise as number | null) ?? undefined;
  const members = strataMembers(file.imageNames);
  const specs = embeddedCuts(file.rows);
  const chosen = frozen.cuts.map((label) => {
    const spec = specs.find((s) => s.cut === label);
    if (!spec) throw new Error(`no frozen cut ${label} in ${frozen.result}`);
    return spec;
  });
  const cuts = chosen.map((s) => readCut(s, file.rows, tol, rise, members));

  const identity =
    (file.settings.identity as IdentityCheck[] | undefined) ?? [];
  const identityHolds = [0, 1, 2, 3, 4].every((k) =>
    identity.some(
      (c) =>
        c.arm === `t${k} interleaved full` &&
        c.of === `t${k} native` &&
        c.images === file.imageNames.length,
    ),
  );

  const seeds: number[] = [];
  for (let s = 1; seeds.length < seedCount; s++) {
    if (s !== BOOTSTRAP_SEED) seeds.push(s);
  }
  const turned: EmbeddedVerdict["turned"] = [];
  for (const seed of seeds) {
    for (const [i, spec] of chosen.entries()) {
      const r = readCut(spec, file.rows, tol, rise, members, seed);
      if (r.pass !== cuts[i]?.pass) turned.push({ seed, cut: spec.cut });
    }
  }
  return {
    id: "D2",
    cuts,
    identity,
    identityHolds,
    seeds,
    turned,
    adopted: identityHolds && turned.length === 0 && cuts.every((c) => c.pass),
  };
}
