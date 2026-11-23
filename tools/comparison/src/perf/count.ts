/**
 * Load-robust counts: what a paired instruction-count measurement reads, and
 * how it is reduced to a ratio. `dct-instructions.ts` runs the processes;
 * this module holds the pure parts, so `selftest:metrics` can pin them.
 *
 * Retired user-space instructions do not move with the host's load the way
 * wall-clock time does: another process's work is not counted against this
 * one, and a deterministic encode retires the same instructions however long
 * it was descheduled. Cycles do move (contended caches, frequency), so they
 * are recorded beside the instruction ratio and judge nothing
 * (`spec/V0.8-DECISIONS.md` D4, "The speed criterion, amended").
 */

/** The events every count reads, in the order `perf stat -e` is given them. */
export const COUNT_EVENTS = ["instructions:u", "cycles:u"] as const;
export type CountEvent = (typeof COUNT_EVENTS)[number];

/** One process's counts. */
export type ProcessCounts = Record<CountEvent, number>;

/**
 * Parse `perf stat -x,` output (stderr) into one count per event. A line is
 * `value,unit,event,run-time,percent-enabled,…`. Throws on an event that is
 * missing, `<not counted>` or `<not supported>`, and on one enabled less than
 * 100% of the time: a multiplexed count is perf's extrapolation, not a count.
 */
export function parsePerfStat(text: string): ProcessCounts {
  const out: Partial<ProcessCounts> = {};
  for (const line of text.split("\n")) {
    const f = line.split(",");
    const event = COUNT_EVENTS.find((e) => e === f[2]);
    if (event === undefined) continue;
    const value = Number(f[0]);
    if (f[0] === undefined || f[0] === "" || !Number.isFinite(value)) {
      throw new Error(`perf stat counted no ${event}: "${line}"`);
    }
    const enabled = Number(f[4]);
    if (!(enabled >= 100)) {
      throw new Error(
        `perf stat multiplexed ${event} (enabled ${f[4]}%), so its count is an estimate: "${line}"`,
      );
    }
    out[event] = value;
  }
  for (const e of COUNT_EVENTS) {
    if (out[e] === undefined) throw new Error(`perf stat reported no ${e}`);
  }
  return out as ProcessCounts;
}

/**
 * The per-iteration count from two processes of one arm that differ only in
 * their iteration count: start-up, the input read and the warmup are in both,
 * so they cancel. Throws unless the longer process counted more.
 */
export function perIteration(
  short: ProcessCounts,
  long: ProcessCounts,
  iterations: number,
): ProcessCounts {
  if (!(iterations > 0)) throw new Error("iterations must be positive");
  const out: Partial<ProcessCounts> = {};
  for (const e of COUNT_EVENTS) {
    const d = long[e] - short[e];
    if (!(d > 0)) {
      throw new Error(
        `the ${iterations}-iteration process counted no more ${e} than the short one (${long[e]} vs ${short[e]})`,
      );
    }
    out[e] = d / iterations;
  }
  return out as ProcessCounts;
}

/** Which arm a block runs first: A B, then B A, alternating from block 0. */
export const blockOrder = (block: number): readonly ["a", "b"] | ["b", "a"] =>
  block % 2 === 0 ? (["a", "b"] as const) : ["b", "a"];

/** The geometric mean of positive values. */
export function geomean(values: readonly number[]): number {
  if (values.length === 0 || values.some((v) => !(v > 0))) {
    throw new Error("geomean needs at least one value, every one positive");
  }
  return Math.exp(values.reduce((s, v) => s + Math.log(v), 0) / values.length);
}

/** One block: each arm's per-iteration counts, and A over B per event. */
export interface CountBlock {
  order: "AB" | "BA";
  a: ProcessCounts;
  b: ProcessCounts;
  ratio: ProcessCounts;
}

/** A pair's reading over its blocks, per event. */
export interface PairReading {
  blocks: number;
  /** Complete A B / B A block pairs: the block count must be even. */
  ratio: ProcessCounts;
  min: ProcessCounts;
  max: ProcessCounts;
}

export function block(
  index: number,
  a: ProcessCounts,
  b: ProcessCounts,
): CountBlock {
  const ratio: Partial<ProcessCounts> = {};
  for (const e of COUNT_EVENTS) ratio[e] = a[e] / b[e];
  return {
    order: blockOrder(index)[0] === "a" ? "AB" : "BA",
    a,
    b,
    ratio: ratio as ProcessCounts,
  };
}

/**
 * Reduce a pair's blocks: the geometric mean of the per-block ratios, and
 * their range. Refuses an odd block count or blocks out of A B / B A order,
 * so every reading is over complete, balanced block pairs.
 */
export function pairReading(blocks: readonly CountBlock[]): PairReading {
  if (blocks.length === 0 || blocks.length % 2 !== 0) {
    throw new Error(
      `a pair needs complete A B / B A blocks; it has ${blocks.length}`,
    );
  }
  for (const [i, b] of blocks.entries()) {
    if (b.order !== (i % 2 === 0 ? "AB" : "BA")) {
      throw new Error(`block ${i} ran ${b.order}, out of A B / B A order`);
    }
  }
  const ratio: Partial<ProcessCounts> = {};
  const min: Partial<ProcessCounts> = {};
  const max: Partial<ProcessCounts> = {};
  for (const e of COUNT_EVENTS) {
    const r = blocks.map((b) => b.ratio[e]);
    ratio[e] = geomean(r);
    min[e] = Math.min(...r);
    max[e] = Math.max(...r);
  }
  return {
    blocks: blocks.length,
    ratio: ratio as ProcessCounts,
    min: min as ProcessCounts,
    max: max as ProcessCounts,
  };
}

/** The tolerance two back-to-back runs' instruction ratios must agree within. */
export const RUN_AGREEMENT = 0.01;

/** Do two runs' ratios agree: `|r1 / r2 − 1| ≤ RUN_AGREEMENT`. */
export const runsAgree = (r1: number, r2: number): boolean =>
  r1 > 0 && r2 > 0 && Math.abs(r1 / r2 - 1) <= RUN_AGREEMENT;
