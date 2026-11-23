/**
 * D4's speed condition, in retired instructions (`spec/V0.8-DECISIONS.md` D4,
 * "The speed criterion, amended"): the per-encode `instructions:u` ratio of
 * the direct-sum forward DCT over the separable factorisation, at 512×512
 * code 1 on the bounded matrix's gradient, from paired, interleaved A B / B A
 * blocks, against two incumbents.
 *
 * - **Pair `shipped`:** the shipped default (A) against `dct_separable=1` (B).
 * - **Pair `ACCEL_ALL`:** every byte-identical lever on (A) against the same
 *   with `dct_separable=1` added (B). The separable path replaces
 *   `accel_dct_lanes` (`rust/src/encode.rs`), and the other levers apply to
 *   both arms, so the pair isolates the transform.
 *
 * One arm's count in a block is two processes of `encode_stdin bench-encode`
 * under `perf stat`, at 0 and {@link ITERATIONS} timed iterations; their
 * difference over {@link ITERATIONS} is the per-encode count, with start-up,
 * the input read and the one warmup encode cancelled. Each pair runs
 * {@link BLOCKS} blocks, and the whole measurement runs {@link RUNS} times
 * back to back; the record gives a reading only if the runs agree within 1%
 * on both instruction ratios (`count.ts` `runsAgree`). Every arm's hash of
 * the fixture is recorded too, so the record shows the two arms encode the
 * same bytes on the input they are timed on.
 *
 *   node dist/perf/dct-instructions.js [--out FILE]
 *
 * Default output: tools/comparison/results/counts/dct-instructions.json.
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
import { captureProvenance, repoRelative } from "../results.ts";
import {
  COUNT_EVENTS,
  type CountBlock,
  type PairReading,
  type ProcessCounts,
  block,
  blockOrder,
  pairReading,
  parsePerfStat,
  perIteration,
  RUN_AGREEMENT,
  runsAgree,
} from "./count.ts";
import { ACCEL_ALL, makeFixture } from "./matrix.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const BIN = path.join(REPO_ROOT, "rust/target/release/examples/encode_stdin");

/** The fixture and tier D4's threshold names. */
const SIZE = 512;
const TIER = 1;
/** Timed iterations of the long process; the short one runs 0. */
export const ITERATIONS = 20;
/** Blocks per pair, alternating A B and B A: 5 of each. */
export const BLOCKS = 10;
/** Back-to-back runs whose ratios must agree. */
export const RUNS = 2;
const CANDIDATE = "dct_separable=1";

export const PAIRS = [
  { label: "shipped", incumbent: "", candidate: CANDIDATE },
  {
    label: "ACCEL_ALL",
    incumbent: ACCEL_ALL,
    candidate: `${ACCEL_ALL} ${CANDIDATE}`,
  },
] as const;

const fixture = makeFixture(SIZE, SIZE, "gradient");

function env(tune: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CHROMAHASH_TUNE: tune,
    CHROMAHASH_TIER: String(TIER),
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
      String(SIZE),
      String(SIZE),
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
  const r = spawnSync(BIN, ["encode", String(SIZE), String(SIZE), "srgb"], {
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

function measurePair(incumbent: string, candidate: string): PairRun {
  const blocks: CountBlock[] = [];
  for (let i = 0; i < BLOCKS; i++) {
    const counts: Partial<Record<"a" | "b", ProcessCounts>> = {};
    for (const arm of blockOrder(i)) {
      counts[arm] = perEncode(arm === "a" ? incumbent : candidate);
    }
    if (!counts.a || !counts.b) throw new Error("a block lost an arm");
    blocks.push(block(i, counts.a, counts.b));
  }
  return { blocks, reading: pairReading(blocks) };
}

const loadavg = (): number[] => os.loadavg().map((l) => Number(l.toFixed(2)));

function main(): void {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const out = values.out ?? path.join(COUNTS_DIR, "dct-instructions.json");
  const provenance = captureProvenance({
    config: "dct-instructions",
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
    candidate: hashOf(p.candidate),
  }));
  const runs: PairRun[][] = [];
  for (let r = 0; r < RUNS; r++) {
    runs.push(PAIRS.map((p) => measurePair(p.incumbent, p.candidate)));
    console.error(
      `run ${r + 1}: ${PAIRS.map((p, k) => `${p.label} ${runs[r]?.[k]?.reading.ratio["instructions:u"].toFixed(4)}`).join(", ")}`,
    );
  }

  const pairs = PAIRS.map((p, k) => {
    const perRun = runs.map((run) => run[k] as PairRun);
    const ratios = perRun.map((r) => r.reading.ratio["instructions:u"]);
    return {
      label: p.label,
      incumbent: p.incumbent,
      candidate: p.candidate,
      hashesEqual: hashes[k]?.incumbent === hashes[k]?.candidate,
      runs: perRun,
      agree: runsAgree(ratios[0] ?? 0, ratios[1] ?? 0),
      instructionRatio: ratios[0] ?? null,
    };
  });
  // The faster incumbent retires fewer instructions per encode (run 1, the
  // geometric mean of its per-block counts).
  const incumbentCount = (k: number): number => {
    const blocks = runs[0]?.[k]?.blocks ?? [];
    return Math.exp(
      blocks.reduce((s, b) => s + Math.log(b.a["instructions:u"]), 0) /
        blocks.length,
    );
  };
  const faster = incumbentCount(1) < incumbentCount(0) ? 1 : 0;
  const agree = pairs.every((p) => p.agree);

  const record = {
    schema: 1,
    tool: "dct-instructions",
    name: "dct-instructions",
    settings: {
      fixture: {
        width: SIZE,
        height: SIZE,
        content: fixture.content,
        sha256: createHash("sha256").update(fixture.rgba).digest("hex"),
      },
      tier: TIER,
      events: COUNT_EVENTS,
      iterations: ITERATIONS,
      blocks: BLOCKS,
      runs: RUNS,
      agreement: RUN_AGREEMENT,
      ratio: "incumbent / candidate, per encode",
    },
    provenance: { ...provenance, corpus: [] },
    host: {
      cpu: os.cpus()[0]?.model ?? "unknown",
      threads: os.availableParallelism(),
      perf: perfVersion ?? "unknown",
      loadavgStart: loadStart,
      loadavgEnd: loadavg(),
    },
    hashes: PAIRS.map((p, k) => ({ pair: p.label, ...hashes[k] })),
    pairs,
    fasterIncumbent: PAIRS[faster]?.label,
    agree,
  };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.error(`wrote ${repoRelative(out)}`);
  for (const p of pairs) {
    console.error(
      `${p.label}: instructions ${p.runs.map((r) => r.reading.ratio["instructions:u"].toFixed(4)).join(" / ")} (runs ${p.agree ? "agree" : "DISAGREE"} within 1%), cycles ${p.runs.map((r) => r.reading.ratio["cycles:u"].toFixed(3)).join(" / ")}, hashes ${p.hashesEqual ? "equal" : "DIFFER"}`,
    );
  }
  console.error(`faster incumbent: ${record.fasterIncumbent}`);
  if (!agree) process.exit(1);
}

main();
