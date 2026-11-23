/**
 * D5's speed condition, in retired instructions (`spec/V0.8-DECISIONS.md` D5,
 * "The speed criterion, amended"): the per-encode `instructions:u` ratio of
 * the full-resolution encode over the downsampling encode, at 1024×1024
 * code 1 on the bounded matrix's gradient, from paired, interleaved A B / B A
 * blocks, against two incumbents, for every registered candidate (each
 * placement at each grid edge, `downsample-core.ts`).
 *
 * - **Pair `shipped`:** the shipped default (A) against the candidate's knob
 *   alone (B).
 * - **Pair `ACCEL_ALL`:** every byte-identical lever on (A) against the same
 *   with the candidate's knob added (B), so the pair isolates the resample
 *   against the fastest encoder that writes the shipped bytes.
 *
 * One arm's count in a block is two processes of `encode_stdin bench-encode`
 * under `perf stat`, at 0 and {@link ITERATIONS} timed iterations; their
 * difference over {@link ITERATIONS} is the per-encode count, with start-up,
 * the input read and the one warmup encode cancelled. Each pair runs
 * {@link BLOCKS} blocks, and the whole measurement runs {@link RUNS} times
 * back to back; the record gives a reading only if the runs agree within 1%
 * on every instruction ratio (`count.ts` `runsAgree`). Every arm's hash of
 * the fixture is recorded beside the counts.
 *
 *   node dist/perf/downsample-instructions.js [--out FILE]
 *
 * Default output: tools/comparison/results/counts/downsample-instructions.json.
 * Exits non-zero if the runs disagree, or if `perf` is unavailable or
 * multiplexes a counter.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { COUNTS_DIR } from "../dct-identity-core.ts";
import {
  D5_COUNT_RECORD,
  D5_COUNT_SIZE,
  D5_COUNT_TIER,
  d5Candidates,
} from "../downsample-core.ts";
import { captureProvenance, repoRelative } from "../results.ts";
import {
  COUNT_EVENTS,
  type CountBlock,
  type PairReading,
  type ProcessCounts,
  RUN_AGREEMENT,
  block,
  blockOrder,
  pairReading,
  parsePerfStat,
  perIteration,
  runsAgree,
} from "./count.ts";
import { ACCEL_ALL, makeFixture } from "./matrix.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const BIN = path.join(REPO_ROOT, "rust/target/release/examples/encode_stdin");

/**
 * Timed iterations of the long process; the short one runs 0. A 1024×1024
 * encode is four of D4's 512×512 ones, so 10 iterations do twice D4's work
 * per process.
 */
export const ITERATIONS = 10;
/** Blocks per pair, alternating A B and B A: 5 of each. */
export const BLOCKS = 10;
/** Back-to-back runs whose ratios must agree. */
export const RUNS = 2;

/** Every pair the record measures: each candidate against both incumbents. */
export const PAIRS = d5Candidates().flatMap((c) => [
  {
    candidate: c.id,
    incumbentLabel: "shipped",
    incumbent: "",
    arm: c.tune,
  },
  {
    candidate: c.id,
    incumbentLabel: "ACCEL_ALL",
    incumbent: ACCEL_ALL,
    arm: `${ACCEL_ALL} ${c.tune}`,
  },
]);

const fixture = makeFixture(D5_COUNT_SIZE, D5_COUNT_SIZE, "gradient");

function env(tune: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CHROMAHASH_TUNE: tune,
    CHROMAHASH_TIER: String(D5_COUNT_TIER),
    CHROMAHASH_BENCH_REPS: "1",
    CHROMAHASH_BENCH_WARMUP_MS: "0",
  };
}

/** One process of `bench-encode` at `iterations`, under `perf stat`. */
function countProcess(tune: string, iterations: number): ProcessCounts {
  const r = spawnSync(
    "perf",
    [
      "stat",
      "-x,",
      "-e",
      COUNT_EVENTS.join(","),
      "--",
      BIN,
      "bench-encode",
      String(D5_COUNT_SIZE),
      String(D5_COUNT_SIZE),
      "srgb",
      String(iterations),
    ],
    { input: fixture.rgba, env: env(tune), maxBuffer: 1 << 26 },
  );
  if (r.error) throw new Error(`perf: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`perf stat bench-encode exited ${r.status}: ${r.stderr}`);
  }
  return parsePerfStat(r.stderr.toString());
}

function perEncode(tune: string): ProcessCounts {
  const short = countProcess(tune, 0);
  const long = countProcess(tune, ITERATIONS);
  return perIteration(short, long, ITERATIONS);
}

function hashOf(tune: string): string {
  const size = String(D5_COUNT_SIZE);
  const r = spawnSync(BIN, ["encode", size, size, "srgb"], {
    input: fixture.rgba,
    env: env(tune),
  });
  if (r.status !== 0) throw new Error(`encode: ${r.stderr}`);
  return r.stdout.toString("hex");
}

interface PairRun {
  blocks: CountBlock[];
  reading: PairReading;
}

function measurePair(incumbent: string, arm: string): PairRun {
  const blocks: CountBlock[] = [];
  for (let i = 0; i < BLOCKS; i++) {
    const counts: Partial<Record<"a" | "b", ProcessCounts>> = {};
    for (const side of blockOrder(i)) {
      counts[side] = perEncode(side === "a" ? incumbent : arm);
    }
    if (!counts.a || !counts.b) throw new Error("a block lost an arm");
    blocks.push(block(i, counts.a, counts.b));
  }
  return { blocks, reading: pairReading(blocks) };
}

const loadavg = (): number[] => os.loadavg().map((l) => Number(l.toFixed(2)));

function main(): void {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const out = values.out ?? path.join(COUNTS_DIR, `${D5_COUNT_RECORD}.json`);
  const provenance = captureProvenance({
    config: D5_COUNT_RECORD,
    configSha256: "",
    iqaCli: "unused",
    binaries: [BIN],
  });
  const perfVersion = spawnSync("perf", ["--version"])
    .stdout?.toString()
    .trim();
  const loadStart = loadavg();

  const hashes = PAIRS.map((p) => ({
    incumbent: hashOf(p.incumbent),
    arm: hashOf(p.arm),
  }));
  const runs: PairRun[][] = [];
  for (let r = 0; r < RUNS; r++) {
    const run: PairRun[] = [];
    for (const p of PAIRS) {
      const m = measurePair(p.incumbent, p.arm);
      run.push(m);
      console.error(
        `run ${r + 1}: ${p.candidate} vs ${p.incumbentLabel} ${m.reading.ratio["instructions:u"].toFixed(4)}`,
      );
    }
    runs.push(run);
  }

  const pairs = PAIRS.map((p, k) => {
    const perRun = runs.map((run) => run[k] as PairRun);
    const ratios = perRun.map((r) => r.reading.ratio["instructions:u"]);
    return {
      candidate: p.candidate,
      label: p.incumbentLabel,
      incumbent: p.incumbent,
      arm: p.arm,
      hashesEqual: hashes[k]?.incumbent === hashes[k]?.arm,
      runs: perRun,
      agree: runsAgree(ratios[0] ?? 0, ratios[1] ?? 0),
      instructionRatio: ratios[0] ?? null,
    };
  });
  const agree = pairs.every((p) => p.agree);

  const record = {
    schema: 1,
    tool: D5_COUNT_RECORD,
    name: D5_COUNT_RECORD,
    settings: {
      fixture: {
        width: D5_COUNT_SIZE,
        height: D5_COUNT_SIZE,
        content: fixture.content,
        sha256: createHash("sha256").update(fixture.rgba).digest("hex"),
      },
      tier: D5_COUNT_TIER,
      events: COUNT_EVENTS,
      iterations: ITERATIONS,
      blocks: BLOCKS,
      runs: RUNS,
      agreement: RUN_AGREEMENT,
      ratio: "incumbent / arm, per encode",
    },
    provenance: { ...provenance, corpus: [] },
    host: {
      cpu: os.cpus()[0]?.model ?? "unknown",
      threads: os.availableParallelism(),
      perf: perfVersion ?? "unknown",
      loadavgStart: loadStart,
      loadavgEnd: loadavg(),
    },
    hashes: PAIRS.map((p, k) => ({
      candidate: p.candidate,
      pair: p.incumbentLabel,
      ...hashes[k],
    })),
    pairs,
    agree,
  };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.error(`wrote ${repoRelative(out)}`);
  for (const p of pairs) {
    console.error(
      `${p.candidate} vs ${p.label}: instructions ${p.runs.map((r) => r.reading.ratio["instructions:u"].toFixed(4)).join(" / ")} (runs ${p.agree ? "agree" : "DISAGREE"} within 1%), cycles ${p.runs.map((r) => r.reading.ratio["cycles:u"].toFixed(3)).join(" / ")}`,
    );
  }
  if (!agree) process.exit(1);
}

main();
