/**
 * Paired inference for every metric of every arm of a sweep against one
 * reference arm, and the guard verdict read off those intervals.
 *
 * A sweep used to carry a paired interval for ΔE00 alone. The three guard
 * metrics and the local artifact metrics got point means, so a guard passed or
 * failed on whether one mean sat a hair either side of a tolerance -- on 31
 * images, where the corpus spread dwarfs the differences between arms -- and
 * nothing corrected for a table of dozens of arms each being tested against the
 * same incumbent. Both are the winner's-curse shape: the arm that looks best in
 * a wide table is disproportionately the one luck favoured.
 *
 * This module is pure, and is shared by the three places that read a sweep:
 * `sweep.ts` prints it after a run, `arms.ts` re-derives it from a committed
 * result, and `verify-experiments.ts` checks the document against it.
 */

import {
  ARTIFACT_ZERO_BASE_ALLOWANCE,
  type GuardTolerances,
  type PerImage,
  type PerImageKey,
} from "./results.ts";
import { bootstrapCI, bootstrapP, holm } from "./stats.ts";

/** A metric that can be compared per image, and which direction is better. */
export interface PairedMetricSpec {
  key: PerImageKey;
  label: string;
  /**
   * "lower" or "higher" is better. Deficit has neither: a placeholder is meant
   * to drop detail, so it is read against spurious as an exchange rate and
   * never minimized (EXPERIMENTS.md §13).
   */
  better: "lower" | "higher" | "neither";
}

/**
 * The series a sweep row can carry that are scores rather than bookkeeping.
 * `bytes` is the independent variable, `spuriousGrid` a record of the
 * instrument, and the three orientation shares are a decomposition of
 * `spurious` rather than further tests of it.
 */
export const PAIRED_METRICS: readonly PairedMetricSpec[] = [
  { key: "ciede2000", label: "ΔE00", better: "lower" },
  { key: "ssimulacra2", label: "SSIM2", better: "higher" },
  { key: "butteraugli", label: "Butter", better: "lower" },
  { key: "dssim", label: "DSSIM", better: "lower" },
  { key: "alphaMae", label: "αMAE", better: "lower" },
  { key: "ringing", label: "Ring", better: "lower" },
  { key: "spurious", label: "Spur", better: "lower" },
  { key: "deficit", label: "Deficit", better: "neither" },
];

/** One metric's paired comparison of an arm against the reference arm. */
export interface PairedStat {
  key: PerImageKey;
  label: string;
  better: PairedMetricSpec["better"];
  /** Images with a finite value on both sides. */
  pairs: number;
  /** Reference arm's mean over those images. */
  baseMean: number;
  /** Mean per-image difference, **arm − reference**, in the metric's units. */
  meanDelta: number;
  /** 95% paired bootstrap interval of `meanDelta` (1,000 resamples, seed 42). */
  ci: [number, number];
  /** Two-sided bootstrap p for a zero mean difference (`bootstrapP`). */
  p: number;
  /**
   * `p` after Holm's adjustment across every arm compared with the same
   * reference on this metric. Equal to `p` when the sweep has one comparison.
   */
  pHolm: number;
}

/** Every metric's paired comparison for one arm. */
export interface ArmComparison {
  label: string;
  stats: PairedStat[];
}

/** The shape this module needs off a row: `ResultRow` satisfies it. */
export interface PairableRow {
  label: string;
  perImage: PerImage;
}

/**
 * The per-image differences arm − reference over the images both scored. Pairs
 * are positional: every arm of a sweep is scored over one image list, which
 * `shapeProblems` (results.ts) checks every series against.
 */
export function pairedDeltas(
  arm: readonly (number | null)[],
  base: readonly (number | null)[],
): { deltas: number[]; baseValues: number[] } {
  const deltas: number[] = [];
  const baseValues: number[] = [];
  for (const [i, b] of base.entries()) {
    const a = arm[i];
    if (b === null || a === null || a === undefined) continue;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    deltas.push(a - b);
    baseValues.push(b);
  }
  return { deltas, baseValues };
}

/**
 * Compare every row but `baseIndex` with the row at `baseIndex`, on every metric
 * both carry, and adjust each metric's p-values across the arms with Holm.
 *
 * The family is one metric across all arms of one sweep against one reference:
 * that is the set of tests a reader scans when they pick the best row of a
 * table. Metrics are not pooled into one family, because they answer different
 * questions and a guard is not a search.
 */
export function compareArms(
  rows: readonly PairableRow[],
  baseIndex = 0,
): ArmComparison[] {
  const base = rows[baseIndex];
  if (!base) return [];
  const out: ArmComparison[] = rows
    .filter((_, i) => i !== baseIndex)
    .map((row) => ({ label: row.label, stats: [] }));
  for (const spec of PAIRED_METRICS) {
    const baseSeries = base.perImage[spec.key];
    if (!baseSeries) continue;
    const found: PairedStat[] = [];
    for (const [j, row] of rows.filter((_, i) => i !== baseIndex).entries()) {
      const series = row.perImage[spec.key];
      if (!series) continue;
      const { deltas, baseValues } = pairedDeltas(series, baseSeries);
      if (deltas.length === 0) continue;
      const stat: PairedStat = {
        key: spec.key,
        label: spec.label,
        better: spec.better,
        pairs: deltas.length,
        baseMean: baseValues.reduce((s, v) => s + v, 0) / baseValues.length,
        meanDelta: deltas.reduce((s, v) => s + v, 0) / deltas.length,
        ci: bootstrapCI(deltas),
        p: bootstrapP(deltas),
        pHolm: Number.NaN,
      };
      out[j]?.stats.push(stat);
      found.push(stat);
    }
    const adjusted = holm(found.map((s) => s.p));
    for (const [k, s] of found.entries()) s.pHolm = adjusted[k] ?? s.p;
  }
  return out;
}

/** One metric's stat for an arm, or undefined when the arm does not carry it. */
export function statFor(
  cmp: ArmComparison | undefined,
  key: PerImageKey,
): PairedStat | undefined {
  return cmp?.stats.find((s) => s.key === key);
}

/**
 * What an arm's paired intervals say about its guards, in three states:
 *
 * - `ok` — every guard's interval lies inside its tolerance: the data **rule
 *   out** a regression beyond it (a non-inferiority reading).
 * - `FAIL` — some guard's interval lies entirely beyond its tolerance: the data
 *   **show** a regression beyond it.
 * - `inconclusive` — neither: some interval straddles its tolerance, and this
 *   corpus cannot say which side of it the arm is on.
 *
 * The point-mean verdict (`guardsHold`) collapses the last state into
 * whichever side the mean happens to fall, which on 16 or 31 images is often
 * a coin toss. Only `ok` passes: a guard exists to keep a regression out, so
 * the burden is on the arm.
 *
 * Per guard, with Δ = arm − incumbent over the images both scored:
 *
 * - SSIMULACRA2 (higher is better, absolute tolerance): the tolerance is
 *   Δ ≥ −`ssimulacra2Drop`.
 * - Butteraugli and DSSIM (relative tolerance): Δ ≤ `relativeRise` × the
 *   incumbent's mean over the same images.
 * - Ringing and spurious, only where the run declared `artifactRise`: the same
 *   relative rule; where the incumbent's mean is exactly zero, the absolute
 *   allowance `guardsHold` uses, {@link ARTIFACT_ZERO_BASE_ALLOWANCE} levels.
 *
 * A metric either side did not score is `ok`, exactly as in `guardsHold`: a
 * sweep that did not ask for a metric must not fail on it. The guards are an
 * intersection -- every one must hold -- so they need no multiplicity
 * adjustment of their own; each is already tested at its full 95%.
 */
export type GuardVerdict = "ok" | "inconclusive" | "FAIL";

export function guardVerdictOnIntervals(
  cmp: ArmComparison | undefined,
  tol: GuardTolerances,
  artifactRise: number | undefined,
): GuardVerdict {
  const verdicts: GuardVerdict[] = [];
  const ssim2 = statFor(cmp, "ssimulacra2");
  if (ssim2) {
    const floor = -tol.ssimulacra2Drop;
    verdicts.push(
      ssim2.ci[0] >= floor
        ? "ok"
        : ssim2.ci[1] < floor
          ? "FAIL"
          : "inconclusive",
    );
  }
  const rising = (key: PerImageKey, rise: number): void => {
    const s = statFor(cmp, key);
    if (!s) return;
    const margin =
      s.baseMean === 0 ? ARTIFACT_ZERO_BASE_ALLOWANCE : rise * s.baseMean;
    verdicts.push(
      s.ci[1] <= margin ? "ok" : s.ci[0] > margin ? "FAIL" : "inconclusive",
    );
  };
  rising("butteraugli", tol.relativeRise);
  rising("dssim", tol.relativeRise);
  if (artifactRise !== undefined) {
    rising("ringing", artifactRise);
    rising("spurious", artifactRise);
  }
  if (verdicts.includes("FAIL")) return "FAIL";
  if (verdicts.includes("inconclusive")) return "inconclusive";
  return "ok";
}

/**
 * `p` to four decimals. The bootstrap's floor is 2/(B + 1) ≈ 0.0002 at
 * {@link P_VALUE_RESAMPLES}, so four decimals never round a p to zero.
 */
export function formatP(p: number): string {
  return Number.isFinite(p) ? p.toFixed(4) : "—";
}

const signed = (n: number, d: number): string =>
  `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;

/** Decimals a metric is printed to, matching the decision table. */
const DECIMALS: Partial<Record<PerImageKey, number>> = {
  ciede2000: 3,
  ssimulacra2: 2,
  butteraugli: 3,
  dssim: 4,
  alphaMae: 4,
  ringing: 3,
  spurious: 3,
  deficit: 3,
};

/**
 * Render the paired comparisons as one block per metric: every arm's mean
 * difference, its interval, the raw p and the Holm-adjusted p side by side, and
 * the verdict each supports. Empty when there is nothing to compare.
 */
export function formatArmTables(
  baseLabel: string,
  comparisons: readonly ArmComparison[],
  alpha = 0.05,
): string {
  const lines: string[] = [];
  const width = Math.max(
    28,
    ...comparisons.map((c) => Math.min(c.label.length, 40)),
  );
  for (const spec of PAIRED_METRICS) {
    const rows = comparisons
      .map((c) => ({ label: c.label, s: statFor(c, spec.key) }))
      .filter((r): r is { label: string; s: PairedStat } => r.s !== undefined);
    if (rows.length === 0) continue;
    const d = DECIMALS[spec.key] ?? 3;
    const arrow =
      spec.better === "lower" ? " ↓" : spec.better === "higher" ? " ↑" : "";
    lines.push(
      `\n  ${spec.label}${arrow} — arm − ${baseLabel}, paired over the images both scored; Holm across ${rows.length} arm(s)`,
    );
    lines.push(
      `  ${"Arm".padEnd(width)} ${"Δ".padStart(10)} ${"95% CI of Δ".padStart(24)} ${"p".padStart(8)} ${"p Holm".padStart(8)}  verdict`,
    );
    for (const { label, s } of rows) {
      const ci = `[${signed(s.ci[0], d)}, ${signed(s.ci[1], d)}]`;
      const verdict =
        s.pHolm < alpha
          ? "differs (Holm)"
          : s.p < alpha
            ? "differs unadjusted only"
            : "—";
      lines.push(
        `  ${label.slice(0, width).padEnd(width)} ${signed(s.meanDelta, d).padStart(10)} ${ci.padStart(24)} ${formatP(s.p).padStart(8)} ${formatP(s.pHolm).padStart(8)}  ${verdict}`,
      );
    }
  }
  if (lines.length > 0) {
    lines.push(
      `\n  p is the bootstrap test of a zero mean difference; p Holm adjusts it across the\n  arms of this table (familywise α = ${alpha}). A difference is not a direction:\n  read Δ's sign against the arrow beside each metric.`,
    );
  }
  return lines.join("\n");
}
