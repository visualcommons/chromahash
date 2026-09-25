/**
 * Statistics helpers for the report summaries: quantiles and a deterministic
 * bootstrap confidence interval for the mean. Mean-only summaries hide the
 * tail behaviour that matters for placeholders (a format can win on average
 * while failing badly on dark or saturated images), so the report co-reports
 * the median, p90, and a CI of the mean for the primary metric.
 *
 * The sweeps' inference lives here too, so every tool draws it from one place:
 * the bootstrap p-value paired against the same resampling as the interval,
 * Holm's multiplicity adjustment across a sweep's arms, and the Fisher-z
 * interval and significance threshold for a Pearson coefficient.
 */

/**
 * Fixed seed for the bootstrap PRNG — every run resamples identically.
 *
 * **The same seed restarts on every call**, so two calls over samples of the
 * same length draw the *same* resample indices. Every arm of a sweep is scored
 * over one image list, so every paired interval in one table is computed over
 * one shared set of resamples: arm A's and arm B's intervals are not
 * independent Monte Carlo draws, and their Monte Carlo errors do not average
 * out across the table — they move together. That is deliberate (it is what
 * makes a document's intervals reproducible to the digit, and as common random
 * numbers it reduces the resampling noise in a comparison *between* arms), and
 * it is also why the
 * seed's own influence is measured rather than assumed: `mise run arms
 * --seed-sensitivity` re-derives every committed ΔE00 interval under other
 * seeds, and EXPERIMENTS.md §13.5 records the result.
 */
export const BOOTSTRAP_SEED = 42;

/**
 * Resamples behind a bootstrap p-value. Higher than the intervals' 1,000
 * because a p-value is fed to a multiplicity correction: with B resamples the
 * smallest p the bootstrap can report is about 2/(B+1), so at B = 1,000 a
 * 33-arm sweep could never clear a Holm threshold of 0.05/32 however large
 * its effect. At 10,000 the floor is 2×10⁻⁴, and 32 comparisons adjust it to
 * 0.0064. The intervals stay at 1,000 so every interval the document quotes is
 * unchanged.
 */
export const P_VALUE_RESAMPLES = 10_000;

/** Deterministic pseudo-random using a simple LCG (same recipe as generate-fixtures). */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Linear-interpolation quantile of an ascending-sorted array, p in [0, 1].
 * Fails fast on an empty array or out-of-range p — callers guard emptiness.
 */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    throw new RangeError("quantile: empty input");
  }
  if (!(p >= 0 && p <= 1)) {
    throw new RangeError(`quantile: p must be in [0, 1], got ${p}`);
  }
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? 0;
  return loVal + (hiVal - loVal) * (pos - lo);
}

/**
 * Bootstrap confidence interval for the mean: resample with replacement
 * nResamples times and take the [alpha/2, 1 - alpha/2] quantiles of the
 * resampled means. Deterministic (seeded LCG, no Math.random) so reports are
 * reproducible. Fails fast on empty input — callers guard emptiness.
 */
export function bootstrapCI(
  values: number[],
  nResamples = 1000,
  alpha = 0.05,
  seed = BOOTSTRAP_SEED,
): [number, number] {
  return bootstrapCIOf(values, mean, nResamples, alpha, seed);
}

/** Arithmetic mean. The statistic {@link bootstrapCI} resamples. */
function mean(sample: number[]): number {
  let sum = 0;
  for (const v of sample) sum += v;
  return sum / sample.length;
}

/**
 * Bootstrap confidence interval for an arbitrary statistic of the sample.
 *
 * Timing wants a CI of the *median* — one descheduling event skews a mean, and
 * the median is what the perf report leads with — while the quality tables want
 * the mean, so the statistic is a parameter.
 *
 * The draw order is load-bearing and must not change: `verify:experiments`
 * re-derives every confidence interval quoted in spec/EXPERIMENTS.md from this
 * function, so altering how many times `rng()` is called per resample, or in
 * what order, would silently invalidate the whole document. Hence all
 * `values.length` indices are drawn first and the statistic applied afterwards,
 * which reproduces the previous sequence exactly. `seed` exists for the
 * seed-sensitivity check alone; every figure the document quotes uses the
 * default.
 */
export function bootstrapCIOf(
  values: number[],
  statistic: (sample: number[]) => number,
  nResamples = 1000,
  alpha = 0.05,
  seed = BOOTSTRAP_SEED,
): [number, number] {
  const stats = resampledStatistics(values, statistic, nResamples, seed);
  stats.sort((a, b) => a - b);
  return [quantile(stats, alpha / 2), quantile(stats, 1 - alpha / 2)];
}

/**
 * The statistic of each of `nResamples` resamples, in draw order. The one
 * resampling loop, shared by the interval and the p-value so the two cannot
 * drift apart in how they draw.
 */
function resampledStatistics(
  values: number[],
  statistic: (sample: number[]) => number,
  nResamples: number,
  seed: number,
): number[] {
  if (values.length === 0) {
    throw new RangeError("bootstrap: empty input");
  }
  const rng = lcg(seed);
  const stats: number[] = new Array(nResamples);
  const sample: number[] = new Array(values.length);
  for (let r = 0; r < nResamples; r++) {
    for (let i = 0; i < values.length; i++) {
      sample[i] = values[Math.floor(rng() * values.length)] ?? 0;
    }
    stats[r] = statistic(sample);
  }
  return stats;
}

/**
 * Two-sided bootstrap p-value for "the mean of `values` is zero", by inverting
 * the percentile interval: the smallest α at which {@link bootstrapCI}'s
 * construction, run at `nResamples`, would exclude zero. Counting the resampled
 * means on each side of zero, p = 2·(min(k≤0, k≥0) + 1)/(B + 1), the +1 being
 * the standard correction that keeps a finite bootstrap from ever reporting
 * p = 0 (Davison & Hinkley 1997, §4.4).
 *
 * Built for paired per-image deltas, where it is the p-value of the same test
 * the paired interval already reports — so "the interval excludes zero" and
 * "p < 0.05" say one thing, up to the resampling error between the interval's
 * 1,000 resamples and this function's {@link P_VALUE_RESAMPLES}. A sample of
 * all zeros (two bit-identical arms) returns 1.
 */
export function bootstrapP(
  values: number[],
  nResamples = P_VALUE_RESAMPLES,
  seed = BOOTSTRAP_SEED,
): number {
  const means = resampledStatistics(values, mean, nResamples, seed);
  let le = 0;
  let ge = 0;
  for (const m of means) {
    if (m <= 0) le++;
    if (m >= 0) ge++;
  }
  return Math.min(1, (2 * (Math.min(le, ge) + 1)) / (nResamples + 1));
}

/**
 * Holm's step-down adjustment (Holm 1979) of a family of p-values, returned in
 * the input order.
 *
 * A sweep compares every arm with its incumbent, so a table of k arms runs k−1
 * tests at once, and the chance that *some* arm clears α = 0.05 by luck alone
 * grows with k — the winner's curse a 33-arm table is most exposed to. Holm
 * controls that familywise error at α with no assumption about how the tests
 * depend on each other (they share an incumbent, so they do), and is uniformly
 * more powerful than Bonferroni: sorted ascending, the i-th smallest p (from 0)
 * is multiplied by (m − i), and the adjusted values are made monotone so a
 * smaller raw p never gets a larger adjusted one.
 *
 * Non-finite entries are not tests: they are returned as-is and do not count
 * toward m.
 */
export function holm(ps: readonly number[]): number[] {
  const tested = ps
    .map((p, i) => ({ p, i }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p);
  const m = tested.length;
  const out = [...ps];
  let running = 0;
  for (const [rank, { p, i }] of tested.entries()) {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  }
  return out;
}

/** ln Γ(x) for x > 0, Lanczos (g = 7, n = 9); ~15 significant digits. */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const z = x - 1;
  let a = c[0] ?? 0;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += (c[i] ?? 0) / (z + i);
  return (
    0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
  );
}

/**
 * Regularized incomplete beta I_x(a, b), by the continued fraction of Numerical
 * Recipes §6.4 (modified Lentz), using the symmetry relation where the fraction
 * converges slowly.
 */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    lnGamma(a + b) -
      lnGamma(a) -
      lnGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x),
  );
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - incompleteBeta(1 - x, b, a);
  }
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let f = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let num = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + num * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + num / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    f *= d * c;
    num = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + num * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + num / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    f *= step;
    if (Math.abs(step - 1) < 1e-15) break;
  }
  return (front * f) / a;
}

/** Student-t CDF with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Student-t quantile, by bisection on {@link studentTCdf}; p in (0, 1). */
export function studentTQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`studentTQuantile: p must be in (0, 1), got ${p}`);
  }
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (studentTCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Standard normal quantile, by bisection on {@link erfPrecise}. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`normalQuantile: p must be in (0, 1), got ${p}`);
  }
  if (p < 0.5) return -normalQuantile(1 - p);
  let lo = 0;
  let hi = 40;
  for (let i = 0; i < 200 && hi - lo > 1e-13; i++) {
    const mid = (lo + hi) / 2;
    if (0.5 * (1 + erfPrecise(mid / Math.SQRT2)) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * erf(x) for x ≥ 0 to near double precision: the Maclaurin series below x = 3
 * and the continued fraction for erfc above it. {@link erf} (A&S 7.1.26) is
 * good to 1.5×10⁻⁷, which is enough for a p-value to four decimals and not
 * enough to invert for a quantile.
 */
function erfPrecise(x: number): number {
  if (x < 3) {
    // erf(x) = 2/√π Σ (−1)^n x^(2n+1) / (n! (2n+1))
    let term = x;
    let sum = x;
    for (let n = 1; n < 200; n++) {
      term *= (-x * x) / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return (2 / Math.sqrt(Math.PI)) * sum;
  }
  // erfc(x) by Lentz's continued fraction; erf = 1 − erfc.
  const tiny = 1e-300;
  let f = x;
  let c = x;
  let d = 0;
  for (let n = 1; n < 300; n++) {
    const an = n / 2;
    d = x + an * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = x + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = c * d;
    f *= step;
    if (Math.abs(step - 1) < 1e-16) break;
  }
  return 1 - Math.exp(-x * x) / (f * Math.sqrt(Math.PI));
}

/** What one Pearson coefficient over n pairs can and cannot support. */
export interface CorrelationInference {
  r: number;
  n: number;
  /**
   * 95% interval for ρ by Fisher's z-transform: atanh(r) ± z₀.₉₇₅/√(n − 3),
   * mapped back through tanh. Null below n = 4, where the transform's standard
   * error is undefined.
   */
  ci: [number, number] | null;
  /** Two-sided p for ρ = 0, from t = r·√((n − 2)/(1 − r²)) on n − 2 df. */
  p: number;
  /**
   * The smallest |r| that is significant at α = 0.05 two-sided with this n —
   * the same t-test solved for r. At n = 31 it is 0.355.
   */
  rCritical: number;
}

/**
 * Inference for a Pearson coefficient: the Fisher-z interval, the t-test
 * p-value, and the significance threshold for this n. With 31 images a single
 * r is easy to over-read, and these are the three numbers that say how much
 * a given one can carry. Null when r is not a number.
 */
export function correlationInference(
  r: number,
  n: number,
  alpha = 0.05,
): CorrelationInference | null {
  if (!Number.isFinite(r) || n < 3) return null;
  const df = n - 2;
  const tCrit = studentTQuantile(1 - alpha / 2, df);
  const rCritical = tCrit / Math.sqrt(df + tCrit * tCrit);
  const clamped = Math.max(-1, Math.min(1, r));
  const p =
    Math.abs(clamped) >= 1
      ? 0
      : 2 *
        (1 -
          studentTCdf(
            Math.abs(clamped) * Math.sqrt(df / (1 - clamped * clamped)),
            df,
          ));
  let ci: [number, number] | null = null;
  if (n > 3 && Math.abs(clamped) < 1) {
    const z = Math.atanh(clamped);
    const half = normalQuantile(1 - alpha / 2) / Math.sqrt(n - 3);
    ci = [Math.tanh(z - half), Math.tanh(z + half)];
  }
  return { r: clamped, n, ci, p, rCritical };
}

/** Median of a sample, sorting a copy so the caller's array is untouched. */
export function median(sample: number[]): number {
  return quantile(
    [...sample].sort((a, b) => a - b),
    0.5,
  );
}

/**
 * Gauss error function, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7) — enough
 * precision for reporting a p-value to four decimals.
 */
function erf(x: number): number {
  const sign = Math.sign(x);
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
    t;
  return sign * (1 - poly * Math.exp(-z * z));
}

/**
 * Two-sided sign-test p-value for `wins` vs `losses` (ties excluded, as the
 * sign test requires): the probability of a split at least this lopsided under
 * the null hypothesis that either direction is equally likely.
 *
 * Uses the normal approximation with a continuity correction. Paired A/B runs
 * here have tens of non-tied images, where the approximation is accurate to
 * well under the reported precision; it complements the paired bootstrap CI by
 * answering "is the direction consistent?" independently of effect size.
 * Returns 1 when nothing is comparable.
 */
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const extreme = Math.max(wins, losses);
  const z = (Math.abs(extreme - n / 2) - 0.5) / (0.5 * Math.sqrt(n));
  const p = 2 * (1 - 0.5 * (1 + erf(z / Math.SQRT2)));
  return Math.min(1, Math.max(0, p));
}
