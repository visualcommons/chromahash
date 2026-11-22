/**
 * Print what each split can detect: the minimum detectable relative ΔE00
 * effect of a paired arm-vs-incumbent comparison, from the per-image spread of
 * every committed tune sweep. `mde-core.ts` holds the computation and its
 * derivation; EXPERIMENTS.md §13.6 records the result.
 *
 * Usage:
 *   node dist/mde.js [--power 0.8] [--alpha 0.05] [--all-budgets]
 *
 * Assumptions, printed with the output: images are independent draws, the
 * mean paired difference is normal (the t column, on n − 1 df, is the small-n
 * check on that), and the tune split's spread carries over to the holdout. The
 * sweeps' own inference is a percentile bootstrap, whose standard error is the
 * plug-in SD·√((n−1)/n)/√n, a little narrower than the normal one at small n
 * and less reliable there.
 */

import { parseArgs } from "node:util";
import {
  MDE_CORPORA,
  NEAR,
  type SpreadData,
  mdeCell,
  pct,
  quartiles,
  readSpread,
  subset,
} from "./mde-core.ts";
import { RESULTS_DIR } from "./results.ts";

const { values } = parseArgs({
  options: {
    power: { type: "string", default: "0.8" },
    alpha: { type: "string", default: "0.05" },
    "all-budgets": { type: "boolean", default: false },
  },
});

const power = Number(values.power);
const alpha = Number(values.alpha);
if (!(power > 0 && power < 1) || !(alpha > 0 && alpha < 1)) {
  console.error(
    `--power and --alpha must lie in (0, 1); got ${values.power}, ${values.alpha}`,
  );
  process.exit(2);
}

let data: SpreadData;
try {
  data = readSpread(RESULTS_DIR, values["all-budgets"]);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const iqr = ([lo, mid, hi]: [number, number, number]) =>
  `${pct(mid)} [${pct(lo)}, ${pct(hi)}]`;
const subsetLabel = (near: boolean) =>
  near ? `within ${pct(NEAR, 0)}` : "all";

console.log(
  `Minimum detectable relative ΔE00 effect, paired arm − incumbent: two-sided α = ${alpha}, power ${power}, Holm family m (first step α/m).`,
);
console.log(
  `Comparisons: every arm of every committed photo and alpha tune sweep against its incumbent, at the incumbent's bytes on every image${values["all-budgets"] ? " (--all-budgets: any bytes)" : ""}.`,
);
console.log(
  `  skipped: ${data.otherBudget} arm(s) at another budget, ${data.identical} bit-identical to their incumbent (SD 0).`,
);

console.log("\nσ_rel = SD(arm − incumbent) / incumbent mean, per comparison:");
for (const corpus of MDE_CORPORA) {
  for (const near of [false, true]) {
    const sig = subset(data, corpus, near).map((c) => c.sigmaRel);
    const sorted = [...sig].sort((a, b) => a - b);
    console.log(
      `  ${corpus.padEnd(6)} ${subsetLabel(near).padEnd(9)} ${String(sig.length).padStart(4)} comparisons   median [IQR] ${iqr(quartiles(sig))}   range ${pct(sorted[0] ?? 0)}–${pct(sorted[sorted.length - 1] ?? 0)}`,
    );
  }
}

console.log(
  "\nMDE, median [IQR] across comparisons (normal approximation; t = the median under the t approximation on n − 1 df).",
);
console.log(
  "R2 met = share of arms whose MDE at m = 1 is ≤ 1% (a truly equal arm meets R2's margin with the given power);",
);
console.log(
  "R1 resolved = share whose MDE at m = 2 is ≤ 3% (a true 3% improvement is significant after Holm with the given power).",
);
console.log(
  `  ${"split".padEnd(16)} ${"n".padStart(3)} ${"arms".padEnd(9)} ${"#".padStart(4)}  ${"m = 1".padEnd(24)} ${"t".padStart(6)}  ${"m = 2".padEnd(24)} ${"t".padStart(6)}  ${"R2 met".padStart(6)} ${"R1 res.".padStart(7)}  source`,
);
for (const split of data.splits) {
  for (const near of [false, true]) {
    const m1 = mdeCell(data, split, near, 1, alpha, power);
    const m2 = mdeCell(data, split, near, 2, alpha, power);
    console.log(
      `  ${split.name.padEnd(16)} ${String(split.n).padStart(3)} ${subsetLabel(near).padEnd(9)} ${String(m1.mdes.length).padStart(4)}  ${iqr(m1.quartiles).padEnd(24)} ${pct(m1.tMedian).padStart(6)}  ${iqr(m2.quartiles).padEnd(24)} ${pct(m2.tMedian).padStart(6)}  ${pct(m1.share(0.01), 0).padStart(6)} ${pct(m2.share(0.03), 0).padStart(7)}  ${split.source}`,
    );
  }
}

console.log(
  "\nIncumbent mean ΔE00, and what R2's 1.0% margin and R1's 3.0% improvement are in ΔE00 there:",
);
for (const corpus of MDE_CORPORA) {
  const means = data.incumbents[corpus].map((i) => i.mean);
  const [lo, mid, hi] = quartiles(means);
  const sorted = [...means].sort((a, b) => a - b);
  console.log(
    `  ${corpus.padEnd(6)} ${data.incumbents[corpus].length} incumbents: median ${mid.toFixed(3)} [IQR ${lo.toFixed(3)}, ${hi.toFixed(3)}], range ${sorted[0]?.toFixed(3)}–${sorted[sorted.length - 1]?.toFixed(3)}   1% = ${(0.01 * mid).toFixed(3)}, 3% = ${(0.03 * mid).toFixed(3)} ΔE00 at the median`,
  );
}
console.log(
  `\n  ${"result".padEnd(28)} ${"incumbent".padEnd(36)} ${"n".padStart(3)} ${"mean".padStart(7)} ${"1%".padStart(6)} ${"3%".padStart(6)}`,
);
for (const corpus of MDE_CORPORA) {
  for (const i of data.incumbents[corpus]) {
    console.log(
      `  ${i.result.padEnd(28)} ${i.label.trim().slice(0, 36).padEnd(36)} ${String(i.n).padStart(3)} ${i.mean.toFixed(3).padStart(7)} ${(0.01 * i.mean).toFixed(3).padStart(6)} ${(0.03 * i.mean).toFixed(3).padStart(6)}`,
    );
  }
}

console.log(
  "\nAssumptions: images are independent; the mean paired difference is normal (the t column is the small-n check);" +
    "\nthe tune split's σ_rel carries to the holdout; Holm's first step (α/m) bounds what its smallest p must clear." +
    "\nThe sweeps decide on a percentile bootstrap, not on this formula: this sizes the splits, it decides nothing.",
);
