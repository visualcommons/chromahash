/**
 * The three pure pieces `stratify.ts` is built out of: the correlation it
 * reports, the equal-count binning its table is, and the positional-alignment
 * check that makes joining two arms' per-image series legitimate.
 *
 * Split out of the CLI for one reason: `stratify.ts` does its work at module
 * scope — it parses argv, reads a sweep off disk and prints — so importing it to
 * check any of this would run it. These are the parts that can be wrong without
 * throwing, and §13.3 is read off them, so they are asserted in
 * `metric-selftest.ts` against fixtures with known answers.
 */

/**
 * Pearson correlation. Reported alongside the binned table rather than instead
 * of it: with 31 images a single r is easy to over-read, and the bin means say
 * whether a relationship is monotone or just present.
 *
 * Returns NaN rather than a number for the cases where a correlation is not
 * defined — fewer than three pairs, or a constant series on either side — so a
 * caller renders "—" instead of a coefficient that means nothing.
 */
export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return Number.NaN;
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

/**
 * Split an ascending-sorted list into `binCount` equal-count bins by rank.
 *
 * Rank-based rather than value-based so every bin holds the same number of
 * images: a value-based split of a skewed covariate (detail energy runs 6.8 to
 * 75.9 over the tune corpus) would put twenty images in one bin and two in
 * another, and a two-image mean is not a reading. The remainder when the count
 * does not divide goes to the later bins, and every input lands in exactly one.
 */
export function equalCountBins<T>(
  sorted: readonly T[],
  binCount: number,
): T[][] {
  const bins: T[][] = Array.from({ length: binCount }, () => []);
  for (const [rank, item] of sorted.entries()) {
    const b = Math.min(
      binCount - 1,
      Math.floor((rank * binCount) / sorted.length),
    );
    bins[b]?.push(item);
  }
  return bins;
}

/** The shape `alignmentError` needs off a sweep row. */
export interface AlignableRow {
  label: string;
  imageNames: string[];
}

/**
 * Why two arms' per-image series may not be read as pairs, or null when they
 * may.
 *
 * Every row is indexed positionally against the first row's image list — the
 * bins are built from the first row, and `series[i]` is read as "the same
 * image" in every other row. `sweep.ts` scores every arm over one input list so
 * that holds today, but nothing here requires it, and a row that had been
 * filtered or reordered would produce a table of the right shape built from
 * mismatched pairs. That is the failure this tool exists to make visible, so it
 * is asserted rather than assumed.
 */
export function alignmentError(rows: readonly AlignableRow[]): string | null {
  const first = rows[0];
  if (!first) return "sweep has no rows";
  for (const row of rows) {
    if (row.imageNames.length !== first.imageNames.length) {
      return `arm "${row.label}" scored ${row.imageNames.length} images against "${first.label}"'s ${first.imageNames.length}; the per-image series cannot be compared positionally`;
    }
    const off = row.imageNames.findIndex((n, i) => n !== first.imageNames[i]);
    if (off !== -1) {
      return `arm "${row.label}" has "${row.imageNames[off]}" at position ${off} where "${first.label}" has "${first.imageNames[off]}"; the per-image series are not aligned`;
    }
  }
  return null;
}
