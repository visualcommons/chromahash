/**
 * What each split can detect: the minimum detectable relative ΔE00 effect of a
 * paired arm-vs-incumbent comparison, at the split sizes the v0.8 register
 * decides on.
 *
 * `spec/V0.8-DECISIONS.md` asks R1 for a 3.0% ΔE00 improvement that is also
 * significant after Holm, and R2 for an upper interval bound within a 1.0%
 * non-inferiority margin. Neither number says whether a split of 14 or 32
 * images can resolve it. This reads the per-image spread of the paired
 * difference off every committed tune sweep, which is the one input the answer
 * needs that no document recorded, and turns it into the smallest effect each
 * split detects. It re-scores nothing, and it reads no sealed image: the
 * holdout2 sizes come from the pin tables' metadata (and, while the
 * photographic half is unpinned, from the candidate count of #103).
 *
 * For one comparison over n images, with d_i = arm_i − incumbent_i and
 * σ_rel = SD(d) / mean(incumbent):
 *
 *   MDE_rel = (z_{1 − α/(2m)} + z_{power}) · σ_rel / √n
 *
 * the normal approximation to a two-sided paired test at α, with power
 * `power`, at Bonferroni level α/m for a Holm family of m (Holm's first step,
 * which the smallest p in the family must clear). The same expression at m = 1
 * is the smallest non-inferiority margin δ that a truly equal arm meets with
 * probability `power` under R2's one-sided 97.5% bound; R2 is not
 * Holm-adjusted.
 *
 * The spread of a difference grows with the difference: an arm 20% worse than
 * its incumbent is 20% worse by more on some images than on others. So beside
 * every comparison this also reports the ones within {@link NEAR} of their
 * incumbent, which are the arms a 1% or 3% threshold has to resolve.
 *
 * Shared by `mde.ts`, which prints it, and `verify-experiments.ts`, which
 * checks EXPERIMENTS.md §13.6 against it.
 */

import { readdirSync } from "node:fs";
import { ALPHA_IMAGES } from "./alpha-images.ts";
import { pairedDeltas } from "./arms-core.ts";
import { CURATED_IMAGES } from "./natural-images.ts";
import { readResult } from "./results.ts";
import { normalQuantile, quantile, studentTQuantile } from "./stats.ts";

/**
 * The photographic holdout2 candidate list awaiting approval in #103: 32
 * images (9 smartphone, 3 night, 4 interior, 4 chroma floor, 4 high key, 6
 * skin tone, 2 daylight). Used only while the pin table holds none of them;
 * once they are pinned the pinned count is used instead.
 */
export const PHOTO_HOLDOUT2_CANDIDATES = 32;

/** "Near the threshold": a mean effect within 3% of the incumbent's mean. */
export const NEAR = 0.03;

export type MdeCorpus = "photo" | "alpha";
export const MDE_CORPORA: readonly MdeCorpus[] = ["photo", "alpha"];

/** One arm against its sweep's incumbent. */
export interface Comparison {
  result: string;
  label: string;
  /** SD of the per-image difference (n − 1), over the incumbent's mean. */
  sigmaRel: number;
  /** Mean per-image difference, over the incumbent's mean. */
  effectRel: number;
}

/** One sweep's incumbent. */
export interface Incumbent {
  result: string;
  label: string;
  n: number;
  mean: number;
}

/** A split the register decides on, and the corpus whose spread it takes. */
export interface MdeSplit {
  name: string;
  n: number;
  corpus: MdeCorpus;
  source: string;
}

/** Everything the committed tune results say about paired spread. */
export interface SpreadData {
  comparisons: Record<MdeCorpus, Comparison[]>;
  incumbents: Record<MdeCorpus, Incumbent[]>;
  splits: MdeSplit[];
  /** Arms skipped for spending other bytes than their incumbent. */
  otherBudget: number;
  /** Arms skipped for being bit-identical to their incumbent (SD 0). */
  identical: number;
}

const sum = (xs: readonly number[]) => xs.reduce((s, v) => s + v, 0);

/** Sample SD, n − 1 denominator. */
function sd(xs: readonly number[]): number {
  const m = sum(xs) / xs.length;
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

/** Whether two arms spent the same bytes on every image. */
function sameBudget(
  a: readonly (number | null)[] | undefined,
  b: readonly (number | null)[] | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Read every committed photographic and alpha tune sweep in `resultsDir`. Only
 * arms at their incumbent's bytes on every image are kept unless `allBudgets`:
 * the register compares arms at one tier, and an arm at another budget is a
 * different question with a far larger spread.
 */
export function readSpread(resultsDir: string, allBudgets = false): SpreadData {
  const comparisons: Record<MdeCorpus, Comparison[]> = {
    photo: [],
    alpha: [],
  };
  const incumbents: Record<MdeCorpus, Incumbent[]> = { photo: [], alpha: [] };
  const tuneSize: Record<MdeCorpus, Set<number>> = {
    photo: new Set(),
    alpha: new Set(),
  };
  let otherBudget = 0;
  let identical = 0;

  const names = readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  for (const name of names) {
    const file = readResult(resultsDir, name);
    if (!file || file.tool !== "sweep" || file.split !== "tune") continue;
    const corpus = file.settings.corpus;
    if (corpus !== "photo" && corpus !== "alpha") continue;
    const base = file.rows[0];
    const baseSeries = base?.perImage.ciede2000;
    if (!base || !baseSeries) continue;
    const finite = baseSeries.filter((v): v is number => v !== null);
    incumbents[corpus].push({
      result: name,
      label: base.label,
      n: finite.length,
      mean: sum(finite) / finite.length,
    });
    tuneSize[corpus].add(file.imageNames.length);
    for (const row of file.rows.slice(1)) {
      const series = row.perImage.ciede2000;
      if (!series) continue;
      if (!allBudgets && !sameBudget(row.perImage.bytes, base.perImage.bytes)) {
        otherBudget++;
        continue;
      }
      const { deltas, baseValues } = pairedDeltas(series, baseSeries);
      if (deltas.length < 2) continue;
      const s = sd(deltas);
      if (s === 0) {
        identical++;
        continue;
      }
      const mean = sum(baseValues) / baseValues.length;
      comparisons[corpus].push({
        result: name,
        label: row.label,
        sigmaRel: s / mean,
        effectRel: sum(deltas) / deltas.length / mean,
      });
    }
  }

  const only = (set: Set<number>, what: string): number => {
    const [n, ...rest] = [...set];
    if (n === undefined || rest.length > 0) {
      throw new Error(
        `${what}: expected one tune size across its results, got ${[...set].join(", ") || "none"}`,
      );
    }
    return n;
  };
  const holdout2 = (specs: readonly { split: string }[]) =>
    specs.filter((s) => s.split === "holdout2").length;
  const alphaPinned = holdout2(ALPHA_IMAGES);
  const photoPinned = holdout2(CURATED_IMAGES);

  const splits: MdeSplit[] = [
    {
      name: "photo tune",
      n: only(tuneSize.photo, "photo"),
      corpus: "photo",
      source: "committed tune results",
    },
    {
      name: "photo holdout2",
      n: photoPinned > 0 ? photoPinned : PHOTO_HOLDOUT2_CANDIDATES,
      corpus: "photo",
      source:
        photoPinned > 0
          ? "pinned in natural-images.ts"
          : "#103 candidate list; none pinned yet",
    },
    {
      name: "alpha tune",
      n: only(tuneSize.alpha, "alpha"),
      corpus: "alpha",
      source: "committed tune results",
    },
    {
      name: "alpha holdout2",
      n: alphaPinned,
      corpus: "alpha",
      source: "pinned in alpha-images.ts",
    },
  ];

  return { comparisons, incumbents, splits, otherBudget, identical };
}

/** A corpus's comparisons, or only those within {@link NEAR} of their incumbent. */
export function subset(
  data: SpreadData,
  corpus: MdeCorpus,
  near: boolean,
): Comparison[] {
  return data.comparisons[corpus].filter(
    (c) => !near || Math.abs(c.effectRel) <= NEAR,
  );
}

/** First quartile, median and third quartile of an unsorted sample. */
export function quartiles(xs: readonly number[]): [number, number, number] {
  const s = [...xs].sort((a, b) => a - b);
  return [quantile(s, 0.25), quantile(s, 0.5), quantile(s, 0.75)];
}

/** The normal-approximation multiplier on σ_rel/√n. */
export function zFactor(alpha: number, power: number, m: number): number {
  return normalQuantile(1 - alpha / (2 * m)) + normalQuantile(power);
}

/** The same multiplier with Student-t quantiles on n − 1 df. */
export function tFactor(
  alpha: number,
  power: number,
  m: number,
  n: number,
): number {
  return (
    studentTQuantile(1 - alpha / (2 * m), n - 1) +
    studentTQuantile(power, n - 1)
  );
}

/** One split's MDE distribution at one Holm family size. */
export interface MdeCell {
  /** Relative MDE per comparison, normal approximation. */
  mdes: number[];
  quartiles: [number, number, number];
  /** The median under the t approximation. */
  tMedian: number;
  /** Share of comparisons whose MDE is at most `cut`. */
  share: (cut: number) => number;
}

export function mdeCell(
  data: SpreadData,
  split: MdeSplit,
  near: boolean,
  m: number,
  alpha = 0.05,
  power = 0.8,
): MdeCell {
  const z = zFactor(alpha, power, m);
  const mdes = subset(data, split.corpus, near).map(
    (c) => (z * c.sigmaRel) / Math.sqrt(split.n),
  );
  const q = quartiles(mdes);
  return {
    mdes,
    quartiles: q,
    tMedian: (tFactor(alpha, power, m, split.n) * q[1]) / z,
    share: (cut) => mdes.filter((x) => x <= cut).length / mdes.length,
  };
}

/** A fraction as a percentage to `d` places. */
export const pct = (x: number, d = 2): string => `${(x * 100).toFixed(d)}%`;

/** The cells EXPERIMENTS.md §13.6 binds, keyed by `<split>|all` or `<split>|near`. */
export function mdeTableCells(
  data: SpreadData,
): Map<string, Record<string, number | string>> {
  const out = new Map<string, Record<string, number | string>>();
  for (const split of data.splits) {
    for (const near of [false, true]) {
      const m1 = mdeCell(data, split, near, 1);
      const m2 = mdeCell(data, split, near, 2);
      const range = (q: [number, number, number]) =>
        `[${pct(q[0])}, ${pct(q[2])}]`;
      out.set(`${split.name}|${near ? "near" : "all"}`, {
        n: split.n,
        arms: m1.mdes.length,
        m1: m1.quartiles[1] * 100,
        m1Iqr: range(m1.quartiles),
        m2: m2.quartiles[1] * 100,
        m2Iqr: range(m2.quartiles),
        r2Met: Math.round(m1.share(0.01) * 100),
        r1Resolved: Math.round(m2.share(0.03) * 100),
      });
    }
  }
  for (const corpus of MDE_CORPORA) {
    const mid = quartiles(data.incumbents[corpus].map((i) => i.mean))[1];
    out.set(`incumbent|${corpus}`, {
      incumbents: data.incumbents[corpus].length,
      mean: mid,
      abs1: 0.01 * mid,
      abs3: 0.03 * mid,
    });
  }
  return out;
}
