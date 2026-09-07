/**
 * Reads a sweep's per-image scores against the corpus covariates, so a mean
 * over 31 photographs becomes a statement about *which* photographs.
 *
 * Every table in `EXPERIMENTS.md` is an aggregate. That is the right unit for
 * choosing a constant — the pre-registered rule is about mean ΔE00 on a holdout
 * split — and it is the wrong unit for the question a design round starts from,
 * which is not "how much does the format invent" but "invent *on what*". A mean
 * spurious score of 6.23 at code 4 says the top tier asserts structure the
 * original does not have. It does not say whether that happens on the dense
 * facade or on the near-flat sky, and those two answers point at different
 * changes to the format.
 *
 * The covariates are already measured and already committed: `natural-images.ts`
 * records mean L*, mean chroma C* and Laplacian detail energy per image, taken
 * on the same 512 px reference the harness scores against, because §9.1's corpus
 * audit needed them to choose the set. Nothing has ever read them back.
 *
 * Usage:
 *   node dist/stratify.js <sweep> [--metric spurious|deficit|ringing|ciede]
 *                                 [--by detail|lightness|chroma]
 *                                 [--bins 3]
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CURATED_IMAGES } from "./natural-images.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SWEEP_DIR = path.join(REPO_ROOT, "tools/comparison/output/sweeps");

/** The three covariates `natural-images.ts` records, parsed out of `notes`. */
interface Covariates {
  lightness: number;
  chroma: number;
  detail: number;
  axis: string;
}

/**
 * `notes` is prose with the numbers in it — "landscape, mean L* 40.1, mean C*
 * 6.8, detail 9.85". Parsed rather than restructured because the field is also
 * read by humans, and because a schema change here would touch all 39 entries
 * for no measurement gain.
 */
function covariates(): Map<string, Covariates> {
  const out = new Map<string, Covariates>();
  for (const img of CURATED_IMAGES) {
    const l = /mean L\*\s*([\d.]+)/.exec(img.notes);
    const c = /mean C\*\s*([\d.]+)/.exec(img.notes);
    const d = /detail\s*([\d.]+)/.exec(img.notes);
    if (!l || !c || !d) continue;
    out.set(img.label, {
      lightness: Number(l[1]),
      chroma: Number(c[1]),
      detail: Number(d[1]),
      axis: img.axis,
    });
  }
  return out;
}

interface SweepRow {
  label: string;
  bytes: number | null;
  imageNames: string[];
  perImageCiede: (number | null)[];
  perImageSpurious: (number | null)[] | null;
  perImageDeficit: (number | null)[] | null;
  perImageRinging: (number | null)[] | null;
}

const METRICS = {
  spurious: (r: SweepRow) => r.perImageSpurious,
  deficit: (r: SweepRow) => r.perImageDeficit,
  ringing: (r: SweepRow) => r.perImageRinging,
  ciede: (r: SweepRow) => r.perImageCiede,
} as const;

type MetricName = keyof typeof METRICS;
type Axis = "detail" | "lightness" | "chroma";

/**
 * Pearson correlation. Reported alongside the binned table rather than instead
 * of it: with 31 images a single r is easy to over-read, and the bin means say
 * whether a relationship is monotone or just present.
 */
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return Number.NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - mx;
    const dy = (ys[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? Number.NaN : sxy / Math.sqrt(sxx * syy);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    metric: { type: "string", default: "spurious" },
    by: { type: "string", default: "detail" },
    bins: { type: "string", default: "3" },
  },
});

const sweepName = positionals[0];
if (!sweepName) {
  console.error("usage: stratify <sweep> [--metric M] [--by AXIS] [--bins N]");
  process.exit(2);
}

const metric = values.metric as MetricName;
if (!(metric in METRICS)) {
  console.error(
    `unknown metric ${metric}; one of ${Object.keys(METRICS).join(", ")}`,
  );
  process.exit(2);
}
const axis = values.by as Axis;
if (!["detail", "lightness", "chroma"].includes(axis)) {
  console.error(`unknown axis ${axis}; one of detail, lightness, chroma`);
  process.exit(2);
}
const binCount = Number(values.bins);

const file = path.join(SWEEP_DIR, `${sweepName}.json`);
const sweep = JSON.parse(readFileSync(file, "utf8")) as { rows: SweepRow[] };
const cov = covariates();

const AXIS_LABEL: Record<Axis, string> = {
  detail: "Laplacian detail energy",
  lightness: "mean L*",
  chroma: "mean C*",
};

console.log(
  `${sweepName}: ${metric} against ${AXIS_LABEL[axis]}, ${binCount} bins\n`,
);

// Bin edges come from the first row's images and are held fixed across rows, so
// every arm is reported over the same partition of the corpus. Recomputing them
// per row would let a bin's membership move between rows and silently turn a
// comparison of arms into a comparison of different image sets.
const firstRow = sweep.rows[0];
if (!firstRow) {
  console.error("sweep has no rows");
  process.exit(1);
}
const named = firstRow.imageNames
  .map((n, i) => ({ n, i, c: cov.get(n) }))
  .filter(
    (x): x is { n: string; i: number; c: Covariates } => x.c !== undefined,
  );

if (named.length === 0) {
  console.error(
    `none of this sweep's ${firstRow.imageNames.length} images are in the curated set — stratification needs the covariates natural-images.ts records, so this only applies to a photo-corpus sweep`,
  );
  process.exit(1);
}
if (named.length < firstRow.imageNames.length) {
  console.log(
    `  (${named.length} of ${firstRow.imageNames.length} images carry covariates; the rest are Kodak holdout or synthetic and are excluded)\n`,
  );
}

const sorted = [...named].sort((a, b) => a.c[axis] - b.c[axis]);
const bins: (typeof sorted)[] = Array.from({ length: binCount }, () => []);
for (const [rank, item] of sorted.entries()) {
  const b = Math.min(
    binCount - 1,
    Math.floor((rank * binCount) / sorted.length),
  );
  bins[b]?.push(item);
}

const ranges = bins.map((b) => {
  const lo = b[0]?.c[axis];
  const hi = b[b.length - 1]?.c[axis];
  return lo === undefined || hi === undefined
    ? "—"
    : `${lo.toFixed(1)}–${hi.toFixed(1)}`;
});

const header = ["arm".padEnd(26), "bytes".padStart(6)]
  .concat(ranges.map((r, i) => `bin${i + 1} ${r}`.padStart(18)))
  .concat(["  r".padStart(7)])
  .join("");
console.log(header);

for (const row of sweep.rows) {
  const series = METRICS[metric](row);
  if (!series) continue;

  const cells: string[] = [];
  for (const bin of bins) {
    const vs = bin
      .map((x) => series[x.i])
      .filter((v): v is number => v !== null && v !== undefined);
    cells.push(
      (vs.length
        ? (vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(2)
        : "—"
      ).padStart(18),
    );
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const x of named) {
    const v = series[x.i];
    if (v === null || v === undefined) continue;
    xs.push(x.c[axis]);
    ys.push(v);
  }
  const r = pearson(xs, ys);

  console.log(
    row.label.slice(0, 26).padEnd(26) +
      String(row.bytes ?? "—").padStart(6) +
      cells.join("") +
      (Number.isNaN(r) ? "     —" : r.toFixed(2).padStart(7)),
  );
}

console.log(
  "\nBins are equal-count terciles of the tune corpus by the chosen axis, held " +
    "fixed across arms.\n`r` is Pearson over all images, reported beside the bins " +
    "rather than instead of them: with this many\nimages one coefficient is easy " +
    "to over-read, and the bin means say whether a relationship\nis monotone or " +
    "merely present.",
);
