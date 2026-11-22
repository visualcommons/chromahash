/**
 * Spawning and timing one measurement cell, and the statistics over its
 * processes.
 *
 * The driver never times anything itself: each harness runs a timed loop
 * in-process and prints one mean-ns/op line per block, so a spawn's cost —
 * which for the JVM and .NET dwarfs the operation being measured — never enters
 * a reported number. What happens here is calibration, collection and
 * statistics.
 *
 * **Methods revision (chromahash-perf/3).** A cell used to be one process: the
 * reported cost was the minimum of its seven blocks, so the variance *between*
 * processes — a different heap layout, a different core, a different moment in
 * the host's thermal cycle — was never sampled, and the "CI" beside it was an
 * interval on the median of those blocks, not on the figure reported. A cell is
 * now P processes (default 4), each still reporting the minimum of its blocks,
 * and the reported cost is the **median of the per-process minima**, beside the
 * range of those minima. The runner interleaves the processes of every cell
 * round-robin (`plan.ts`, `roundOrder`), so a drift over the sweep spreads
 * across every cell instead of landing on whichever ran last.
 *
 * **The range is not a 95% interval.** It was stored as a "bootstrap 95%
 * interval" across processes, but a percentile bootstrap of the median of
 * three values can only return values among those three, so it was in effect
 * their range — and the range of n independent draws contains their median
 * with probability 1 − 2^(1−n): 75% at three processes, 87.5% at four. It is
 * now stored as what it is, with that coverage beside it, and nothing here
 * draws a bootstrap.
 */

import { spawnSync } from "node:child_process";
import { median, quantile } from "../stats.ts";
import type { Target } from "./targets.ts";

/** Target wall-time of one timed block. Long enough to swamp clock granularity. */
const BLOCK_MS = 200;
const MIN_ITERS = 1;
const MAX_ITERS = 200_000;

/**
 * Re-size when a measured block came out this much shorter than BLOCK_MS. The
 * pilot is one sample; if it over-estimated the per-op cost, every block is too
 * short and exposed to a single descheduling event.
 */
const RECALIBRATE_BELOW = 0.5;

/** Warmup handed to a harness, in milliseconds. */
export const WARMUP_MS = { native: 500, managed: 2000 } as const;

/**
 * A cell is noisy when its process minima spread further than this: past 5%
 * the processes do not agree on the figure to the resolution the document is
 * checked at. The gate never lets a noisy cell's range widen what it accepts,
 * and fails a bound cell whose processes spread past the 10% host bar.
 *
 * Spread across processes only. A process's own blocks can scatter — a managed
 * runtime's collector lands on some of them — without moving its minimum,
 * which is what is reported; their IQR is recorded, and not held to this.
 */
export const NOISY = 0.05;

/**
 * The chance that the range of n independent draws contains the median of the
 * distribution they are drawn from: 1 − 2·(1/2)^n. Distribution-free; 0 for a
 * single draw, whose "range" is a point.
 */
export const rangeCoverage = (n: number): number =>
  n < 2 ? 0 : 1 - 2 * 0.5 ** n;

export interface CellRequest {
  readonly target: Target;
  readonly argv: readonly string[];
  readonly stdin: Buffer;
  readonly env: Readonly<Record<string, string>>;
  /** Timed blocks per process. */
  readonly reps: number;
  /** Abort if the pilot projects one operation longer than this. */
  readonly maxCellMs: number;
  /** `taskset -c` CPU list, or null to leave scheduling to the kernel. */
  readonly pin: string | null;
}

export type Calibration =
  | { readonly kind: "ok"; readonly iters: number }
  | { readonly kind: "skipped"; readonly reason: string };

function runOnce(
  req: CellRequest,
  iters: number,
  reps: number,
  warmupMs: number,
): number[] {
  const argv = req.argv.map((a) => (a === "@ITERS@" ? String(iters) : a));
  const command = req.pin ? "taskset" : req.target.command;
  const args = req.pin
    ? ["-c", req.pin, req.target.command, ...req.target.args, ...argv]
    : [...req.target.args, ...argv];
  const proc = spawnSync(command, args, {
    cwd: req.target.cwd,
    input: req.stdin,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60_000,
    env: {
      ...process.env,
      ...req.target.env,
      ...req.env,
      CHROMAHASH_BENCH_REPS: String(reps),
      CHROMAHASH_BENCH_WARMUP_MS: String(warmupMs),
    },
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    const stderr = proc.stderr?.toString("utf8").slice(0, 400) ?? "";
    throw new Error(`${req.target.name} exited ${proc.status}: ${stderr}`);
  }
  const lines = proc.stdout
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => Number.parseInt(l, 10));
  if (lines.some((n) => !Number.isFinite(n))) {
    throw new Error(`${req.target.name}: non-numeric bench output`);
  }
  return lines;
}

const warmupOf = (req: CellRequest) =>
  req.target.managed ? WARMUP_MS.managed : WARMUP_MS.native;

const sizeFor = (nsPerOp: number) =>
  Math.min(
    MAX_ITERS,
    Math.max(MIN_ITERS, Math.ceil((BLOCK_MS * 1e6) / nsPerOp)),
  );

/**
 * Size a cell's blocks from one pilot iteration.
 *
 * The pilot carries the measured run's warmup. A cold pilot times a managed
 * runtime's JIT rather than its steady state, over-estimates the per-op cost,
 * and under-sizes the block: the committed 2026-08-29 baseline sized
 * `encode/Kotlin/t2` at 2 iterations (a 15.7 ms block against the 200 ms
 * target), and those were the cells that came back non-monotonic in tier.
 */
export function calibrate(req: CellRequest): Calibration {
  const pilotNs = runOnce(req, 1, 1, warmupOf(req))[0] ?? 0;
  if (pilotNs <= 0) {
    return { kind: "skipped", reason: "pilot returned a non-positive time" };
  }
  if (pilotNs / 1e6 > req.maxCellMs) {
    return {
      kind: "skipped",
      reason: `one operation costs ${(pilotNs / 1e6).toFixed(0)} ms, over the ${req.maxCellMs} ms cell budget`,
    };
  }
  return { kind: "ok", iters: sizeFor(pilotNs) };
}

/**
 * One measured process: `reps` timed blocks.
 *
 * The first process of a cell may re-size it. If the pilot over-estimated and
 * the blocks ran short, the cell is re-sized from this process's median — warm
 * by construction and many samples rather than one — and the process is taken
 * again at the new size, so every recorded process of a cell times the same
 * block length.
 */
export function measureProcess(
  req: CellRequest,
  iters: number,
  mayResize: boolean,
): { iters: number; blocks: number[] } {
  const warmupMs = warmupOf(req);
  const blocks = runOnce(req, iters, req.reps, warmupMs);
  if (!mayResize || blocks.length === 0) return { iters, blocks };
  const med = median(blocks);
  if (
    med > 0 &&
    iters > MIN_ITERS &&
    (iters * med) / 1e6 < BLOCK_MS * RECALIBRATE_BELOW
  ) {
    const resized = sizeFor(med);
    if (resized > iters) {
      const again = runOnce(req, resized, req.reps, warmupMs);
      if (again.length > 0) return { iters: resized, blocks: again };
    }
  }
  return { iters, blocks };
}

export interface CellStats {
  /** Each process's timed blocks, ns/op, in the order the rounds ran. */
  readonly samplesNsPerOp: number[][];
  /** Each process's minimum block: the least-contaminated sample it took. */
  readonly processMinNsPerOp: number[];
  /**
   * The reported cost: the median of the per-process minima.
   *
   * Within a process, every source of error is one-sided — contention,
   * interrupts, page faults, migration, throttling only ever slow a block — so
   * the minimum is the sample least contaminated by the host. Between
   * processes that stops being true: a process can land on a better core or a
   * luckier heap than the code will usually get, so the minimum of minima
   * would report the luckiest process. The median of them reports a typical
   * one, and is what a second run on the same host reproduces.
   */
  readonly nsPerOp: number;
  /**
   * The lowest and highest process minimum: the range `nsPerOp` sits in.
   * Contains the true median with probability `rangeCoverage` — 87.5% at four
   * processes — and is labelled as a range, not a confidence interval.
   */
  readonly rangeNsPerOp: [number, number];
  /** `rangeCoverage(processes)`: how often a range like this holds the median. */
  readonly rangeCoverage: number;
  /** Median of every block of every process. Reported, not used. */
  readonly medianNsPerOp: number;
  /** The smallest block of any process. Reported, not used. */
  readonly minNsPerOp: number;
  /**
   * Median over processes of each process's IQR as a fraction of its median.
   * Reported, not used: it describes the blocks, not the reported minimum.
   */
  readonly iqrPct: number;
  /** (max − min) / min over the process minima. */
  readonly spreadPct: number;
  /** `spreadPct` past NOISY. */
  readonly noisy: boolean;
}

export function cellStats(samples: number[][]): CellStats {
  const kept = samples.filter((s) => s.length > 0);
  if (kept.length === 0) throw new RangeError("cellStats: no samples");
  const mins = kept.map((s) => Math.min(...s));
  const all = kept.flat();
  const iqrs = kept.map((s) => {
    const sorted = [...s].sort((a, b) => a - b);
    const m = median(s);
    return m > 0 ? (quantile(sorted, 0.75) - quantile(sorted, 0.25)) / m : 0;
  });
  const lo = Math.min(...mins);
  const hi = Math.max(...mins);
  const nsPerOp = median(mins);
  const spreadPct = lo > 0 ? (hi - lo) / lo : 0;
  const iqrPct = median(iqrs);
  return {
    samplesNsPerOp: kept,
    processMinNsPerOp: mins,
    nsPerOp,
    rangeNsPerOp: [lo, hi],
    rangeCoverage: rangeCoverage(mins.length),
    medianNsPerOp: median(all),
    minNsPerOp: Math.min(...all),
    iqrPct,
    spreadPct,
    noisy: spreadPct > NOISY,
  };
}

export interface PairStats {
  /** base ÷ arm for each round, in round order; null where a member failed. */
  readonly ratios: (number | null)[];
  /**
   * One ratio per complete AB/BA block — rounds 2k and 2k+1, which ran the
   * pair in opposite orders — as the geometric mean of the two.
   */
  readonly blocks: number[];
  /** The geometric mean over every complete block's rounds. */
  readonly ratio: number;
  /** The lowest and highest block ratio. */
  readonly range: [number, number];
  /** `rangeCoverage(blocks)`: 50% for two blocks. A range, not an interval. */
  readonly coverage: number;
  /** (max − min) / min over the block ratios. */
  readonly spreadPct: number;
  /** `spreadPct` past NOISY. */
  readonly noisy: boolean;
}

/**
 * A paired ratio, base time over arm time, estimated so that an order effect
 * cancels rather than survives.
 *
 * The runner reverses each unit every other round (`plan.ts` `roundOrder`), so
 * rounds 0 and 1 run a pair as A B and then B A, rounds 2 and 3 as A B and B A
 * again. Whatever running second does to a member — a warmer cache, a hotter
 * core, a drift across the unit — multiplies the round's ratio by some (1 + d)
 * in one order and divides it by about that in the other, so the geometric
 * mean of a block's two rounds cancels it, and the geometric mean of complete
 * blocks is the estimate. It used to be the median of the per-round ratios,
 * which with three rounds (A B, B A, A B) is an A B round, carrying the order
 * effect whole. That is why the driver now takes an even number of rounds, and
 * why a block missing either round is left out rather than half-counted.
 *
 * `undefined` entries are rounds a member failed in. Null if no block is
 * complete: one round, as in `--quick`, is not a paired measurement.
 */
export function pairStats(
  base: readonly (number | undefined)[],
  arm: readonly (number | undefined)[],
): PairStats | null {
  const rounds = Math.max(base.length, arm.length);
  const ratios: (number | null)[] = [];
  for (let i = 0; i < rounds; i++) {
    const b = base[i];
    const a = arm[i];
    ratios.push(b !== undefined && a !== undefined && a > 0 ? b / a : null);
  }
  const blocks: number[] = [];
  const logs: number[] = [];
  for (let k = 0; k + 1 < ratios.length; k += 2) {
    const ab = ratios[k];
    const ba = ratios[k + 1];
    if (ab == null || ba == null) continue;
    blocks.push(Math.sqrt(ab * ba));
    logs.push(Math.log(ab), Math.log(ba));
  }
  if (blocks.length === 0) return null;
  const ratio = Math.exp(logs.reduce((s, l) => s + l, 0) / logs.length);
  const lo = Math.min(...blocks);
  const hi = Math.max(...blocks);
  const spreadPct = lo > 0 ? (hi - lo) / lo : 0;
  return {
    ratios,
    blocks,
    ratio,
    range: [lo, hi],
    coverage: rangeCoverage(blocks.length),
    spreadPct,
    noisy: spreadPct > NOISY,
  };
}
