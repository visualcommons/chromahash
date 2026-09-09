/**
 * Reads a sweep's per-image scores against the corpus covariates, so a mean
 * over 31 photographs becomes a statement about *which* photographs.
 *
 * Every table in `EXPERIMENTS.md` is an aggregate. That is the right unit for
 * choosing a constant — the pre-registered rule is about mean ΔE00 on a holdout
 * split — and it is the wrong unit for the question a design round starts from,
 * which is not "how much does the format invent" but "invent *on what*". A mean
 * spurious score of 4.23 at code 4 on the pinned grid — 6.56 on that tier's own
 * raster — says the top tier asserts structure the original does not have. It
 * does not say whether that happens on the dense facade or on the near-flat
 * sky, and those two answers point at different changes to the format.
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
import { alignmentError, equalCountBins, pearson } from "./stratify-core.ts";

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
 *
 * The trade that buys is a regex over prose a human is invited to edit, so the
 * failure is loud rather than quiet. An entry whose sentence stops matching
 * used to be skipped, which silently shrank the corpus every table here is
 * computed over: the bins would still be equal-count terciles, of a different
 * set, and nothing printed would say so. A caption reworded to "detail energy
 * 9.85" is enough to do it.
 */
function covariates(): Map<string, Covariates> {
  const out = new Map<string, Covariates>();
  const unparsed: string[] = [];
  for (const img of CURATED_IMAGES) {
    const l = /mean L\*\s*([\d.]+)/.exec(img.notes);
    const c = /mean C\*\s*([\d.]+)/.exec(img.notes);
    const d = /detail\s*([\d.]+)/.exec(img.notes);
    if (!l || !c || !d) {
      const missing = [
        l ? null : "mean L*",
        c ? null : "mean C*",
        d ? null : "detail",
      ].filter((x) => x !== null);
      unparsed.push(
        `${img.label}: no ${missing.join(", ")} in ${JSON.stringify(img.notes)}`,
      );
      continue;
    }
    out.set(img.label, {
      lightness: Number(l[1]),
      chroma: Number(c[1]),
      detail: Number(d[1]),
      axis: img.axis,
    });
  }
  if (unparsed.length > 0) {
    console.error(
      `${unparsed.length} curated image(s) carry covariates this tool cannot read:\n`,
    );
    for (const u of unparsed) console.error(`  ${u}`);
    console.error(
      "\nEvery table this tool prints is computed over the images it could read, so\n" +
        "a skipped entry silently changes the corpus rather than the output. Restore\n" +
        "the phrasing in natural-images.ts, or teach the regexes the new one.",
    );
    process.exit(1);
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
// `--bins` is the one argument that reaches arithmetic rather than a lookup, so
// a bad value does not fail: `--bins 0` printed a header with no bins and
// `--bins abc` printed "NaN bins", both over a table of dashes and both exiting
// 0. Every other bad input in this file exits non-zero saying what was wrong,
// and a silent empty table is the failure mode this whole tool exists to
// prevent. The upper bound is the corpus: more bins than images cannot be
// equal-count, and two of them would be empty.
const binCount = Number(values.bins);
if (!Number.isInteger(binCount) || binCount < 2) {
  console.error(
    `--bins must be an integer of at least 2; got ${JSON.stringify(values.bins)}`,
  );
  process.exit(2);
}

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
// See `alignmentError`: every row is read positionally against the first row's
// image list, which sweep.ts guarantees today and nothing here requires.
const misaligned = alignmentError(sweep.rows);
if (misaligned !== null) {
  console.error(misaligned);
  process.exit(1);
}

// A row whose series is absent is "not measured", and skipping it printed a
// complete, plausible, EMPTY table and exited 0 — so a reader who ran this over
// a sweep written before `artifacts` existed read "no relationship on any arm"
// where the truth is "nobody measured it". `sweep.ts` is deliberate about the
// distinction on the way out (null, rather than an array of nulls, when a run
// scored no artifacts) and this contradicted it on the way back in. Same shape
// as `covariates()` above: name the sweep and the field, and exit non-zero.
const MISSING_FIELD: Record<MetricName, string> = {
  spurious: "perImageSpurious",
  deficit: "perImageDeficit",
  ringing: "perImageRinging",
  ciede: "perImageCiede",
};
const measured: { row: SweepRow; series: (number | null)[] }[] = [];
const unmeasured: SweepRow[] = [];
for (const row of sweep.rows) {
  const series = METRICS[metric](row);
  if (series) measured.push({ row, series });
  else unmeasured.push(row);
}
if (unmeasured.length > 0) {
  console.error(
    `\n${sweepName} carries no ${MISSING_FIELD[metric]} on ${unmeasured.length} of its ${sweep.rows.length} arm(s):\n`,
  );
  for (const r of unmeasured) console.error(`  ${r.label}`);
  console.error(
    "\nThat field is null when the run did not score the metric at all, which is not\n" +
      "the same as scoring it as nothing — every sweep run before `artifacts` existed\n" +
      'is in that state. Re-run the sweep with `"artifacts": true` in its config (and\n' +
      "`artifactGridEdge` too, if its arms decode at different rasters), or choose a\n" +
      "metric this sweep measured.",
  );
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
if (binCount > sorted.length) {
  console.error(
    `--bins ${binCount} over ${sorted.length} image(s) with covariates cannot be equal-count; at least one bin would be empty`,
  );
  process.exit(2);
}
const bins = equalCountBins(sorted, binCount);

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

for (const { row, series } of measured) {
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
