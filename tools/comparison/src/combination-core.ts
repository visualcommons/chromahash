/**
 * The v0.8 verdict's combination check (`spec/V0.8-DECISIONS.md`, "The v0.8
 * verdict", #140), on a `v08-combination` tune result.
 *
 * Three entries passed on `holdout3`, each alone against the shipped format:
 * D1 (the entropy coder at code 3), D3 (the synthesis window at codes 3 and
 * 4) and D6 (the 5-bit alpha rows at codes 3 and 4). They land as one format,
 * so the combination is read on tune before it does, per cell: a (code,
 * alpha mode) pair, which the decoder recovers from the hash.
 *
 * In each cell, `S*` is the single component arm with the lowest mean ΔE00
 * over the cell's images. A candidate is a combination row whose components
 * all belong to the cell and include `S*`'s. It passes against `S*` when:
 *
 *   1. the upper bound of its paired 95% ΔE00 interval (candidate − `S*`) is
 *      at most +1.0% of `S*`'s mean;
 *   2. its guards on the paired intervals against `S*` are not `FAIL`;
 *   3. if it holds D3, its mean spurious detail against `t2 shipped` over the
 *      cell's images is at most 0;
 *   4. its outcome does not turn under the 20 other seeds.
 *
 * The cell adopts the passing candidate with the most components (a tie to
 * the lower mean ΔE00), or `S*` alone when none passes.
 *
 * It calls the same `compareArms`, interval guards and bootstrap the sweeps
 * and `register-verdict` use, and changes no statistic.
 * `stratify --combination` and `selftest:metrics` read it through here.
 */

import {
  type GuardVerdict,
  type PairableRow,
  type PairedStat,
  compareArms,
  guardVerdictOnIntervals,
  statFor,
} from "./arms-core.ts";
import { otherSeeds, subsetRow } from "./register-verdict-core.ts";
import type { GuardTolerances } from "./results.ts";
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED } from "./stats.ts";

/** The tune sweep's name. */
export const COMBINATION_SWEEP = "v08-combination";
/** R2's δ for the combination, as a fraction of `S*`'s mean. */
export const COMBINATION_MARGIN = 0.01;
/** D3's spurious floor. */
export const COMBINATION_FLOOR = "t2 shipped";
/** Condition 4's seed count. */
export const COMBINATION_SEEDS = 20;

/** An adopted entry, in the order a row label lists it. */
export type Component = "D1" | "D3" | "D6";
const COMPONENT_ORDER: readonly Component[] = ["D1", "D3", "D6"];

/** An alpha mode, which a hash's flag carries. */
export type AlphaMode = "opaque" | "alpha";

/** A (code, alpha mode) pair, and the entries adopted there. */
export interface Cell {
  k: 3 | 4;
  mode: AlphaMode;
  components: readonly Component[];
}

/** The cells the v0.8 verdict's adopted entries touch. */
export const CELLS: readonly Cell[] = [
  { k: 3, mode: "opaque", components: ["D1", "D3"] },
  { k: 3, mode: "alpha", components: ["D1", "D3", "D6"] },
  { k: 4, mode: "opaque", components: ["D3"] },
  { k: 4, mode: "alpha", components: ["D3", "D6"] },
];

/** The row label of a set of components at code `k`: `t3 D1+D3`. */
export function comboLabel(
  k: number,
  components: readonly Component[],
): string {
  const sorted = COMPONENT_ORDER.filter((c) => components.includes(c));
  return `t${k} ${sorted.join("+")}`;
}

const LABEL = /^t([34]) (D[136](?:\+D[136])*)$/;

/** A row label's code and components, or undefined for any other row. */
export function parseCombo(
  label: string,
): { k: 3 | 4; components: Component[] } | undefined {
  const m = LABEL.exec(label.trim());
  if (!m) return undefined;
  const parts = (m[2] ?? "").split("+") as Component[];
  if (new Set(parts).size !== parts.length) return undefined;
  if (comboLabel(Number(m[1]), parts) !== label.trim()) return undefined;
  return { k: Number(m[1]) as 3 | 4, components: parts };
}

/** One candidate's reading against `S*`, over one cell's images. */
export interface CandidateReading {
  arm: string;
  components: Component[];
  /** Paired ΔE00, candidate − `S*`. */
  delta: PairedStat;
  /** Its mean ΔE00 over the cell's images. */
  mean: number;
  /** The interval's upper bound relative to `S*`'s mean, in percent. */
  upperRel: number;
  cond1: boolean;
  guards: GuardVerdict;
  cond2: boolean;
  /** Spurious against the floor, when the candidate holds D3. */
  spurious: PairedStat | undefined;
  cond3: boolean;
  /** Conditions 1–3 at this seed. */
  pass: boolean;
}

/** One cell's reading: its best single, its candidates, and what it adopts. */
export interface CellReading {
  cell: Cell;
  n: number;
  /** Each single component's mean ΔE00 over the cell's images. */
  singles: { arm: string; component: Component; mean: number }[];
  best: string;
  candidates: CandidateReading[];
  /** Candidates whose pass turned at some other seed, with those seeds. */
  turned: { arm: string; seeds: number[] }[];
  /** The adopted row's label. */
  adopted: string;
  /** Components the adopted row leaves out: the interactions. */
  dropped: Component[];
}

function row(rows: readonly PairableRow[], label: string): PairableRow {
  const r = rows.find((x) => x.label.trim() === label);
  if (!r) throw new Error(`no arm ${JSON.stringify(label)} in the result`);
  return r;
}

function meanOf(r: PairableRow): number {
  const v = (r.perImage.ciede2000 ?? []).filter(
    (x): x is number => x !== null && Number.isFinite(x),
  );
  if (v.length === 0) throw new Error(`${r.label} carries no ΔE00`);
  return v.reduce((s, x) => s + x, 0) / v.length;
}

/** Conditions 1–3 for one candidate against `best`, over `idx`, at `seed`. */
export function readCandidate(
  arm: string,
  best: string,
  rows: readonly PairableRow[],
  idx: readonly number[],
  tol: GuardTolerances,
  seed: number = BOOTSTRAP_SEED,
): CandidateReading {
  const parsed = parseCombo(arm);
  if (!parsed) throw new Error(`${arm} is not a combination row`);
  const a = subsetRow(row(rows, arm), idx);
  const b = subsetRow(row(rows, best), idx);
  const [cmp] = compareArms([b, a], 0, BOOTSTRAP_RESAMPLES, seed);
  const delta = statFor(cmp, "ciede2000");
  if (!delta) throw new Error(`${arm} carries no paired ΔE00`);
  const guards = guardVerdictOnIntervals(cmp, tol, undefined);
  let spurious: PairedStat | undefined;
  if (parsed.components.includes("D3")) {
    const f = subsetRow(row(rows, COMBINATION_FLOOR), idx);
    const [fc] = compareArms([f, a], 0, BOOTSTRAP_RESAMPLES, seed);
    spurious = statFor(fc, "spurious");
    if (!spurious) throw new Error(`${arm} carries no paired spurious`);
  }
  const cond1 = delta.ci[1] <= COMBINATION_MARGIN * delta.baseMean;
  const cond2 = guards !== "FAIL";
  const cond3 = spurious === undefined || spurious.meanDelta <= 0;
  return {
    arm,
    components: parsed.components,
    delta,
    mean: meanOf(a),
    upperRel: (100 * delta.ci[1]) / delta.baseMean,
    cond1,
    guards,
    cond2,
    spurious,
    cond3,
    pass: cond1 && cond2 && cond3,
  };
}

/**
 * Read one cell over the images at `idx`: its best single, every candidate
 * at the harness seed, condition 4 under `seedCount` other seeds, and the
 * row it adopts.
 */
export function readCell(
  cell: Cell,
  rows: readonly PairableRow[],
  idx: readonly number[],
  tol: GuardTolerances,
  seedCount: number = COMBINATION_SEEDS,
): CellReading {
  const singles = cell.components.map((c) => {
    const arm = comboLabel(cell.k, [c]);
    return { arm, component: c, mean: meanOf(subsetRow(row(rows, arm), idx)) };
  });
  const bestSingle = [...singles].sort((x, y) => x.mean - y.mean)[0];
  if (!bestSingle)
    throw new Error(`cell t${cell.k} ${cell.mode} has no component`);
  const best = bestSingle.arm;
  const names = rows
    .map((r) => r.label.trim())
    .filter((label) => {
      const p = parseCombo(label);
      return (
        p !== undefined &&
        p.k === cell.k &&
        p.components.length >= 2 &&
        p.components.every((c) => cell.components.includes(c)) &&
        p.components.includes(bestSingle.component)
      );
    });
  const candidates = names.map((arm) =>
    readCandidate(arm, best, rows, idx, tol),
  );
  const turned: CellReading["turned"] = [];
  for (const c of candidates) {
    const seeds = otherSeeds(seedCount).filter(
      (seed) =>
        readCandidate(c.arm, best, rows, idx, tol, seed).pass !== c.pass,
    );
    if (seeds.length > 0) turned.push({ arm: c.arm, seeds });
  }
  const turnedArms = new Set(turned.map((t) => t.arm));
  const winner = candidates
    .filter((c) => c.pass && !turnedArms.has(c.arm))
    .sort(
      (x, y) => y.components.length - x.components.length || x.mean - y.mean,
    )[0];
  const adopted = winner?.arm ?? best;
  const kept = parseCombo(adopted)?.components ?? [];
  return {
    cell,
    n: idx.length,
    singles,
    best,
    candidates,
    turned,
    adopted,
    dropped: cell.components.filter((c) => !kept.includes(c)),
  };
}
