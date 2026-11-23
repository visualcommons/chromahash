/**
 * Register entry D5, downsampling before the transform
 * (`spec/V0.8-DECISIONS.md` D5): its candidates, how a
 * `downsample-before-dct` result and the `downsample-instructions` count are
 * read, the selection rule, and the verdict. `stratify --downsample`,
 * `perf/downsample-instructions.ts`, `register-verdict D5` and
 * `selftest:metrics` read D5 through here.
 *
 * A candidate is a placement (`linear` or `oklab`, `Tunables::downsample`)
 * and a grid edge `E` (`Tunables::downsample_edge`, a budget of `E²`
 * pixels). Each tier `k` has one incumbent row, `tK full resolution`, and
 * one row per candidate, `tK downsample=P downsample_edge=E`, every row
 * encoding the source at its native resolution.
 *
 * For an arm `A` at code k against its incumbent `I` (D5's "How the verdict
 * is read"), every interval the paired 95% bootstrap at `B` = 10,000:
 *
 *   1. condition 1: the upper bound of the paired ΔE00 interval of `A − I`
 *      at most +1.0% of `I`'s mean (R2's default δ);
 *   2. condition 2: every guard `ok` on the paired intervals against `I`;
 *   3. condition 3: the speed primary, from the count record: both pair
 *      ratios at the arm's code-1 edge at least 2.0, the runs agreeing;
 *   4. the stratum rule against `I`, as written (`stratumRule`);
 *   5. condition 4: every frozen arm's outcome, overall and per stratum,
 *      unchanged under 20 other seeds.
 *
 * No Holm adjustment applies: every condition is an interval bound and each
 * tier is its own question; all five tiers must pass.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type GuardVerdict,
  type PairableRow,
  type PairedStat,
  compareArms,
  guardVerdictOnIntervals,
  statFor,
} from "./arms-core.ts";
import { COUNTS_DIR, SPEED_THRESHOLD } from "./dct-identity-core.ts";
import type { CountBlock, PairReading } from "./perf/count.ts";
import { runsAgree } from "./perf/count.ts";
import {
  FREEZE_REVS,
  RESULTS_DIR,
  type StratumReading,
  load,
  otherSeeds,
  strataMembers,
  stratumRule,
} from "./register-verdict-core.ts";
import type { GuardTolerances, Provenance } from "./results.ts";
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED } from "./stats.ts";

/** The two placements, in the order a tie between them is broken. */
export const D5_PLACEMENTS = ["linear", "oklab"] as const;
export type Placement = (typeof D5_PLACEMENTS)[number];
/** The registered grid edges, smallest first. */
export const D5_EDGES = [64, 128, 256, 512] as const;
/** Every tier is judged, and all five must pass. */
export const D5_TIERS = [0, 1, 2, 3, 4] as const;
/** R2's default non-inferiority margin δ, as a fraction of `I`'s mean. */
export const D5_DE00_MARGIN = 0.01;
/** The speed primary's fixture edge and tier. */
export const D5_COUNT_SIZE = 1024;
export const D5_COUNT_TIER = 1;
/** The count record's name under `results/counts/`. */
export const D5_COUNT_RECORD = "downsample-instructions";
/** The tune sweep's name. */
export const D5_SWEEP = "downsample-before-dct";

/** A candidate's knob, as a tune string. */
export const knobTune = (p: Placement, edge: number): string =>
  `downsample=${p} downsample_edge=${edge}`;
/** A candidate's id in the count record. */
export const candidateId = (p: Placement, edge: number): string =>
  `${p} ${edge}`;
export const incumbentLabel = (k: number): string => `t${k} full resolution`;
export const armLabel = (k: number, p: Placement, edge: number): string =>
  `t${k} ${knobTune(p, edge)}`;

/** Every registered candidate, placement-major, edges ascending. */
export function d5Candidates(): {
  id: string;
  placement: Placement;
  edge: number;
  tune: string;
}[] {
  return D5_PLACEMENTS.flatMap((placement) =>
    D5_EDGES.map((edge) => ({
      id: candidateId(placement, edge),
      placement,
      edge,
      tune: knobTune(placement, edge),
    })),
  );
}

/** One downsampling arm, its code, and its tier's incumbent. */
export interface D5Spec {
  k: number;
  placement: Placement;
  edge: number;
  arm: string;
  incumbent: string;
}

const ARM_LABEL = /^t([0-4]) downsample=(linear|oklab) downsample_edge=(\d+)$/;

/**
 * Every downsampling arm a result holds, in row order, by the labels
 * `downsample-before-dct` writes. An arm whose tier has no incumbent row is
 * left out.
 */
export function d5Arms(rows: readonly { label: string }[]): D5Spec[] {
  const labels = new Set(rows.map((r) => r.label.trim()));
  const out: D5Spec[] = [];
  for (const r of rows) {
    const m = ARM_LABEL.exec(r.label.trim());
    if (!m) continue;
    const k = Number(m[1]);
    const incumbent = incumbentLabel(k);
    if (!labels.has(incumbent)) continue;
    out.push({
      k,
      placement: m[2] as Placement,
      edge: Number(m[3]),
      arm: r.label.trim(),
      incumbent,
    });
  }
  return out;
}

/** One arm's reading against its incumbent, overall, at one seed. */
export interface D5Reading {
  spec: D5Spec;
  n: number;
  /** Paired ΔE00, `A − I`. */
  delta: PairedStat;
  guards: GuardVerdict;
  /** Mean ΔE00 `A − I` relative to mean(I), in percent. */
  deltaRel: number;
  /** The interval's upper bound relative to mean(I), in percent. */
  upperRel: number;
  /** Condition 1: the upper bound at most δ · mean(I). */
  cond1: boolean;
  /** Condition 2: every guard `ok` on intervals. */
  guardsOk: boolean;
  /** The selection rule's tune test: condition 1, and guards not `FAIL`. */
  qualifies: boolean;
  /** The stratum rule against `I`, when strata were given. */
  strata: StratumReading[] | undefined;
  /** Conditions 1 and 2, and no stratum failing. */
  pass: boolean;
}

function row(rows: readonly PairableRow[], label: string): PairableRow {
  const r = rows.find((x) => x.label.trim() === label);
  if (!r) throw new Error(`no arm ${JSON.stringify(label)} in the result`);
  return r;
}

/** Read one arm overall, and per stratum when `members` is given. */
export function readD5(
  spec: D5Spec,
  rows: readonly PairableRow[],
  tol: GuardTolerances,
  members?: ReadonlyMap<string, readonly number[]>,
  seed: number = BOOTSTRAP_SEED,
): D5Reading {
  const arm = row(rows, spec.arm);
  const incumbent = row(rows, spec.incumbent);
  const [cmp] = compareArms([incumbent, arm], 0, BOOTSTRAP_RESAMPLES, seed);
  const delta = statFor(cmp, "ciede2000");
  if (!delta) throw new Error(`${spec.arm} carries no paired ΔE00`);
  const guards = guardVerdictOnIntervals(cmp, tol, undefined);
  const cond1 = delta.ci[1] <= D5_DE00_MARGIN * delta.baseMean;
  const guardsOk = guards === "ok";
  const strata = members
    ? stratumRule(arm, incumbent, members, tol, undefined, seed).strata
    : undefined;
  const strataOk = !strata?.some((s) => s.verdict === "FAIL");
  return {
    spec,
    n: delta.pairs,
    delta,
    guards,
    deltaRel: (100 * delta.meanDelta) / delta.baseMean,
    upperRel: (100 * delta.ci[1]) / delta.baseMean,
    cond1,
    guardsOk,
    qualifies: cond1 && guards !== "FAIL",
    strata,
    pass: cond1 && guardsOk && strataOk,
  };
}

// ── The speed primary ────────────────────────────────────────────────────

/** The shape `perf/downsample-instructions.ts` writes. */
export interface D5CountRecord {
  schema: 1;
  tool: typeof D5_COUNT_RECORD;
  settings: { fixture: { width: number; height: number }; tier: number };
  provenance: Provenance;
  pairs: {
    candidate: string;
    label: string;
    hashesEqual: boolean;
    runs: { blocks: CountBlock[]; reading: PairReading }[];
    agree: boolean;
    instructionRatio: number | null;
  }[];
  agree: boolean;
}

/** One candidate's speed: both pairs, and whether both clear the threshold. */
export interface D5Speed {
  candidate: string;
  pairs: {
    label: string;
    ratio: number;
    runRatios: number[];
    min: number;
    max: number;
    agree: boolean;
    pass: boolean;
  }[];
  /** The ACCEL_ALL pair's ratio: what the selection breaks a placement tie on. */
  accelRatio: number;
  pass: boolean;
}

/** Read every candidate's speed off a count record. */
export function readD5Speed(rec: D5CountRecord): Map<string, D5Speed> {
  if (
    rec.settings.fixture.width !== D5_COUNT_SIZE ||
    rec.settings.fixture.height !== D5_COUNT_SIZE ||
    rec.settings.tier !== D5_COUNT_TIER
  ) {
    throw new Error(
      `${D5_COUNT_RECORD} is not at ${D5_COUNT_SIZE}x${D5_COUNT_SIZE} code ${D5_COUNT_TIER}`,
    );
  }
  const out = new Map<string, D5Speed>();
  for (const p of rec.pairs) {
    const runRatios = p.runs.map((r) => r.reading.ratio["instructions:u"]);
    const first = p.runs[0]?.reading;
    const ratio = runRatios[0] ?? 0;
    const agree =
      runRatios.length === 2 && runsAgree(runRatios[0] ?? 0, runRatios[1] ?? 0);
    const reading = {
      label: p.label,
      ratio,
      runRatios,
      min: first?.min["instructions:u"] ?? 0,
      max: first?.max["instructions:u"] ?? 0,
      agree,
      pass: agree && ratio >= SPEED_THRESHOLD,
    };
    const s = out.get(p.candidate) ?? {
      candidate: p.candidate,
      pairs: [],
      accelRatio: 0,
      pass: false,
    };
    s.pairs.push(reading);
    if (p.label === "ACCEL_ALL") s.accelRatio = ratio;
    s.pass =
      s.pairs.length === 2 &&
      ["shipped", "ACCEL_ALL"].every((l) =>
        s.pairs.some((x) => x.label === l),
      ) &&
      s.pairs.every((x) => x.pass);
    out.set(p.candidate, s);
  }
  return out;
}

/** The committed count record, refused unless recorded from a clean tree. */
export function loadD5Count(dir: string = COUNTS_DIR): D5CountRecord {
  const rec = JSON.parse(
    readFileSync(path.join(dir, `${D5_COUNT_RECORD}.json`), "utf8"),
  ) as D5CountRecord;
  if (rec.provenance.rev === null || rec.provenance.dirty !== false) {
    throw new Error(
      `${D5_COUNT_RECORD} was not recorded from a clean tree; refusing to read D5's speed from it`,
    );
  }
  return rec;
}

// ── The selection rule ───────────────────────────────────────────────────

/** One placement under the selection rule. */
export interface PlacementPick {
  placement: Placement;
  /** Per tier, the smallest qualifying edge, or null. */
  edges: (number | null)[];
  /** Every tier has a qualifying edge. */
  qualifies: boolean;
  /** The speed at its code-1 edge, once it qualifies. */
  speed: D5Speed | undefined;
}

export interface D5Selection {
  placements: PlacementPick[];
  /** The placement chosen, or null when none qualifies. */
  chosen: Placement | null;
  /** The frozen arms, one per tier, when the chosen placement's speed passes. */
  frozen: D5Spec[];
  outcome:
    | "frozen"
    | "decided in sample: no placement qualifies at every tier"
    | "decided in sample: the speed primary fails";
}

/**
 * D5's selection rule over the tune readings (D5, "Selection on tune"): for
 * each placement and tier, the smallest edge whose arm qualifies; a placement
 * qualifies if every tier has one. Of the qualifying placements the one with
 * the larger ACCEL_ALL instruction ratio at its code-1 edge is chosen (a tie
 * to the earlier in {@link D5_PLACEMENTS}). It is frozen if its code-1
 * edge's speed passes; otherwise, or if no placement qualifies, D5 is decided
 * in sample.
 */
export function selectD5(
  readings: readonly D5Reading[],
  speed: ReadonlyMap<string, D5Speed>,
): D5Selection {
  const placements: PlacementPick[] = D5_PLACEMENTS.map((placement) => {
    const edges = D5_TIERS.map((k) => {
      const ok = readings
        .filter(
          (r) =>
            r.spec.k === k && r.spec.placement === placement && r.qualifies,
        )
        .map((r) => r.spec.edge)
        .sort((a, b) => a - b);
      return ok[0] ?? null;
    });
    const qualifies = edges.every((e) => e !== null);
    const e1 = edges[D5_COUNT_TIER];
    return {
      placement,
      edges,
      qualifies,
      speed:
        qualifies && e1 != null
          ? speed.get(candidateId(placement, e1))
          : undefined,
    };
  });
  const ranked = placements
    .filter((p) => p.qualifies)
    .sort((a, b) => (b.speed?.accelRatio ?? 0) - (a.speed?.accelRatio ?? 0));
  const best = ranked[0];
  if (!best) {
    return {
      placements,
      chosen: null,
      frozen: [],
      outcome: "decided in sample: no placement qualifies at every tier",
    };
  }
  if (!best.speed?.pass) {
    return {
      placements,
      chosen: best.placement,
      frozen: [],
      outcome: "decided in sample: the speed primary fails",
    };
  }
  const frozen = D5_TIERS.map((k) => {
    const edge = best.edges[k] as number;
    return {
      k,
      placement: best.placement,
      edge,
      arm: armLabel(k, best.placement, edge),
      incumbent: incumbentLabel(k),
    };
  });
  return { placements, chosen: best.placement, frozen, outcome: "frozen" };
}

/** A selection's identity, for condition 4's re-draw of it. */
export const selectionKey = (s: D5Selection): string =>
  `${s.outcome}|${s.chosen}|${s.placements.map((p) => p.edges.join(",")).join(";")}`;

// ── The verdict ──────────────────────────────────────────────────────────

/** D5's frozen arms and the holdout3 read that judges them. */
export interface D5Freeze {
  result: string;
  arms: readonly string[];
  /** The count-record candidate whose speed is condition 3. */
  candidate: string;
}

/** The freeze (D5, "Frozen arms"): the linear placement's five arms. */
export const D5_FROZEN: D5Freeze | null = {
  result: "downsample-before-dct-frozen-holdout3",
  arms: [
    armLabel(0, "linear", 128),
    armLabel(1, "linear", 128),
    armLabel(2, "linear", 128),
    armLabel(3, "linear", 256),
    armLabel(4, "linear", 512),
  ],
  candidate: candidateId("linear", 128),
};

export interface D5Verdict {
  result: string;
  readings: D5Reading[];
  speed: D5Speed;
  seeds: number[];
  turned: { seed: number; arm: string }[];
  /** Every tier passes conditions 1-2 and the stratum rule, the speed passes, and nothing turns. */
  pass: boolean;
}

const outcome = (r: D5Reading): string =>
  `${r.pass}|${(r.strata ?? []).map((s) => `${s.stratum}:${s.verdict}`).join(",")}`;

/** D5's verdict from a holdout read's rows and the candidate's speed. */
export function d5Verdict(
  result: string,
  rows: readonly PairableRow[],
  arms: readonly string[],
  members: ReadonlyMap<string, readonly number[]>,
  tol: GuardTolerances,
  speed: D5Speed,
  seedCount: number,
): D5Verdict {
  const specs = d5Arms(rows).filter((s) => arms.includes(s.arm));
  if (
    specs.length !== arms.length ||
    D5_TIERS.some((k) => !specs.some((s) => s.k === k))
  ) {
    throw new Error(
      `${result} does not hold every frozen arm of D5 (${arms.join(", ")}) beside its tier's incumbent, one per tier`,
    );
  }
  const readings = specs.map((s) => readD5(s, rows, tol, members));
  const seeds = otherSeeds(seedCount);
  const turned: D5Verdict["turned"] = [];
  for (const seed of seeds) {
    for (const [i, spec] of specs.entries()) {
      const at = readD5(spec, rows, tol, members, seed);
      const base = readings[i];
      if (base && outcome(at) !== outcome(base)) {
        turned.push({ seed, arm: spec.arm });
      }
    }
  }
  return {
    result,
    readings,
    speed,
    seeds,
    turned,
    pass: readings.every((r) => r.pass) && speed.pass && turned.length === 0,
  };
}

/**
 * Derive D5's verdict from its committed holdout3 read, scored at the freeze
 * rev from a clean tree, and its count record.
 */
export function deriveD5Verdict(
  seedCount: number,
  freeze: D5Freeze | null = D5_FROZEN,
  dir: string = RESULTS_DIR,
  countsDir: string = COUNTS_DIR,
): D5Verdict {
  const rev = FREEZE_REVS.D5;
  if (!freeze || !rev) throw new Error("D5 is not frozen");
  const file = load(dir, freeze.result, rev);
  if (file.split !== "holdout3") {
    throw new Error(`${freeze.result} is not a holdout3 read`);
  }
  const speed = readD5Speed(loadD5Count(countsDir)).get(freeze.candidate);
  if (!speed) {
    throw new Error(`${D5_COUNT_RECORD} has no candidate ${freeze.candidate}`);
  }
  return d5Verdict(
    freeze.result,
    file.rows,
    freeze.arms,
    strataMembers(file.imageNames),
    file.settings.guardTolerances as GuardTolerances,
    speed,
    seedCount,
  );
}
