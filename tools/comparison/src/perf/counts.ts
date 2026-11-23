/**
 * `benchmark:counts`: a paired A/B count of two arms on one cell, robust to
 * the host's load.
 *
 * An arm is a binary and a `CHROMAHASH_TUNE` string, so the two arms are two
 * builds (`--a-bin`, `--b-bin`), two `Tunables` settings (`--a-tune`,
 * `--b-tune`), or both. A cell is an implementation, an operation, a source
 * size and a tier, on one of the perf matrix's generated fixtures.
 *
 * One arm's count in a block is two processes of the implementation's
 * `bench-encode` / `bench-decode` under `perf stat -e instructions:u,cycles:u`,
 * at 0 and `--iterations` timed iterations; their difference over the
 * iterations is the per-operation count, with start-up, the input read and the
 * warmup cancelled (`count.ts` `perIteration`). The bench loop's own timing
 * output is discarded. Blocks alternate A B and B A; the record holds each
 * arm's median count with its block range, and the geometric mean of the
 * per-block A/B ratios with theirs.
 *
 * A decode cell decodes one input in both arms: arm A's encode of the fixture.
 *
 *   node dist/perf/counts.js --impl Rust --op encode --size 512 --tier 1 \
 *     --a-tune "" --b-tune "dct_separable=1" --out FILE [--against FILE]
 *
 * `--against FILE` compares this run with an earlier record of the same cell,
 * arms and CPU (`counts-core.ts` `compareRuns`), records the comparison, and
 * exits non-zero if the instruction ratios differ by more than 1%. The run
 * refuses, by name and before counting anything, a host whose counter cannot
 * be read, and a managed-runtime implementation, whose JIT and collector make
 * a process's instruction count depend on more than the operation.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { captureProvenance, fileSha256, repoRelative } from "../results.ts";
import {
  COUNT_EVENTS,
  type CountBlock,
  type ProcessCounts,
  block,
  parsePerfStat,
  perIteration,
} from "./count.ts";
import {
  AB_COUNTS_DIR,
  type CountsArm,
  type CountsRecord,
  type Op,
  blockSchedule,
  compareRuns,
  counterRefusal,
  parseCpuinfo,
  readSchema,
  schemaErrors,
  summarize,
} from "./counts-core.ts";
import { type Content, makeFixture } from "./matrix.ts";
import { ROOT, type Target, allTargets } from "./targets.ts";

const DEFAULT_ITERATIONS: Record<Op, number> = { encode: 20, decode: 200 };
const DEFAULT_BLOCKS = 10;

function fail(message: string): never {
  console.error(`benchmark:counts: ${message}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    impl: { type: "string", default: "Rust" },
    op: { type: "string", default: "encode" },
    size: { type: "string" },
    tier: { type: "string" },
    content: { type: "string", default: "gradient" },
    "a-bin": { type: "string" },
    "b-bin": { type: "string" },
    "a-tune": { type: "string", default: "" },
    "b-tune": { type: "string", default: "" },
    iterations: { type: "string" },
    blocks: { type: "string", default: String(DEFAULT_BLOCKS) },
    out: { type: "string" },
    against: { type: "string" },
  },
});

const op = values.op as Op;
if (op !== "encode" && op !== "decode")
  fail(`--op is encode or decode, not ${values.op}`);
const content = values.content as Content;
if (!["gradient", "noise", "solid"].includes(content)) {
  fail(`--content is gradient, noise or solid, not ${values.content}`);
}
const sizeMatch = /^(\d+)(?:x(\d+))?$/.exec(values.size ?? "");
if (!sizeMatch) fail("--size is required, as N or WxH");
const width = Number(sizeMatch[1]);
const height = Number(sizeMatch[2] ?? sizeMatch[1]);
if (!(width > 0 && height > 0)) fail("--size must be positive");
if (values.tier === undefined || !/^\d+$/.test(values.tier))
  fail("--tier is required");
const tier = Number(values.tier);
const iterations = Number(values.iterations ?? DEFAULT_ITERATIONS[op]);
if (!Number.isInteger(iterations) || iterations < 1)
  fail("--iterations must be a positive integer");
let schedule: ("AB" | "BA")[];
try {
  schedule = blockSchedule(Number(values.blocks));
} catch (e) {
  fail((e as Error).message);
}
if (!values.out) fail("--out is required");
const out = path.resolve(values.out);

const found: Target | undefined = allTargets().find(
  (t) => t.name === values.impl,
);
if (!found) {
  fail(
    `no implementation named ${values.impl}; one of: ${allTargets()
      .map((t) => t.name)
      .join(", ")}`,
  );
}
const target: Target = found;
if (target.managed) {
  fail(
    `${target.name} runs on a managed runtime: its JIT and collector make an instruction count depend on more than the operation, so benchmark:counts measures only native implementations`,
  );
}
if (!target.ops.includes(op)) fail(`${target.name} does not implement ${op}`);
if (!target.tunable && (values["a-tune"] !== "" || values["b-tune"] !== "")) {
  fail(
    `${target.name} does not read CHROMAHASH_TUNE; only Rust targets take a tune`,
  );
}

function arm(
  bin: string | undefined,
  tune: string,
): CountsArm & { abs: string } {
  const abs = bin ? path.resolve(bin) : target.command;
  if (!existsSync(abs))
    fail(`no binary at ${repoRelative(abs)}; build it first`);
  return {
    abs,
    bin: repoRelative(abs),
    binSha256: fileSha256(abs) ?? "missing",
    tune,
  };
}
const arms = {
  a: arm(values["a-bin"], values["a-tune"] ?? ""),
  b: arm(values["b-bin"], values["b-tune"] ?? ""),
};

// ─── The counter ────────────────────────────────────────────────────────────

function readParanoid(): number | null {
  try {
    const n = Number(
      readFileSync("/proc/sys/kernel/perf_event_paranoid", "utf8").trim(),
    );
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

const paranoid = readParanoid();
{
  const p = spawnSync(
    "perf",
    ["stat", "-x,", "-e", COUNT_EVENTS.join(","), "--", "true"],
    {
      encoding: "utf8",
    },
  );
  const refusal = counterRefusal({
    errorCode: (p.error as NodeJS.ErrnoException | undefined)?.code ?? null,
    status: p.status,
    stderr: p.stderr ?? "",
    paranoid,
  });
  if (refusal) fail(`refusing to count: ${refusal}`);
}

// ─── The processes ──────────────────────────────────────────────────────────

const fixture = makeFixture(width, height, content);

function env(tune: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...target.env,
    CHROMAHASH_TUNE: tune,
    CHROMAHASH_TIER: String(tier),
    CHROMAHASH_BENCH_REPS: "1",
    CHROMAHASH_BENCH_WARMUP_MS: "0",
  };
}

function run(a: typeof arms.a, argv: string[], input: Buffer): Buffer {
  const r = spawnSync(a.abs, [...target.args, ...argv], {
    cwd: target.cwd,
    input,
    env: env(a.tune),
    maxBuffer: 1 << 28,
  });
  if (r.error) fail(`${argv[0]}: ${r.error.message}`);
  if (r.status !== 0)
    fail(`${argv[0]} exited ${r.status}: ${r.stderr.toString().slice(0, 400)}`);
  return r.stdout;
}

const input: Buffer =
  op === "encode"
    ? fixture.rgba
    : run(
        arms.a,
        ["encode", String(width), String(height), "srgb"],
        fixture.rgba,
      );

const benchArgv = (n: number): string[] =>
  op === "encode"
    ? ["bench-encode", String(width), String(height), "srgb", String(n)]
    : ["bench-decode", String(n)];

function countProcess(a: typeof arms.a, n: number): ProcessCounts {
  const r = spawnSync(
    "perf",
    [
      "stat",
      "-x,",
      "-e",
      COUNT_EVENTS.join(","),
      "--",
      a.abs,
      ...target.args,
      ...benchArgv(n),
    ],
    { cwd: target.cwd, input, env: env(a.tune), maxBuffer: 1 << 26 },
  );
  if (r.error) fail(`perf: ${r.error.message}`);
  if (r.status !== 0)
    fail(
      `perf stat ${benchArgv(n)[0]} exited ${r.status}: ${r.stderr.toString().slice(0, 400)}`,
    );
  return parsePerfStat(r.stderr.toString());
}

const perOperation = (a: typeof arms.a): ProcessCounts =>
  perIteration(countProcess(a, 0), countProcess(a, iterations), iterations);

const outputOf = (a: typeof arms.a): string =>
  op === "encode"
    ? run(a, ["encode", String(width), String(height), "srgb"], input).toString(
        "hex",
      )
    : createHash("sha256")
        .update(run(a, ["decode"], input))
        .digest("hex");

const loadavg = (): number[] => os.loadavg().map((l) => Number(l.toFixed(2)));

// ─── The run ────────────────────────────────────────────────────────────────

const loadavgStart = loadavg();
const outputs = { a: outputOf(arms.a), b: outputOf(arms.b) };
const blocks: CountBlock[] = [];
for (const [i, order] of schedule.entries()) {
  const counts: Partial<Record<"a" | "b", ProcessCounts>> = {};
  for (const side of order === "AB"
    ? (["a", "b"] as const)
    : (["b", "a"] as const)) {
    counts[side] = perOperation(arms[side]);
  }
  blocks.push(block(i, counts.a as ProcessCounts, counts.b as ProcessCounts));
  const last = blocks[blocks.length - 1] as CountBlock;
  console.error(
    `block ${i + 1}/${schedule.length} ${order}: instructions ${last.ratio["instructions:u"].toFixed(4)}, cycles ${last.ratio["cycles:u"].toFixed(3)}`,
  );
}

const provenance = captureProvenance({
  config: "benchmark-counts",
  configSha256: "",
  iqaCli: "unused",
  binaries: [],
});
let cpuinfo = "";
try {
  cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
} catch {
  // An unreadable cpuinfo records an unknown CPU, which compareRuns refuses.
}

const record: CountsRecord = {
  schema: 1,
  tool: "benchmark-counts",
  cell: {
    impl: target.name,
    op,
    width,
    height,
    tier,
    content,
    fixtureSha256: createHash("sha256").update(fixture.rgba).digest("hex"),
    input: op === "decode" ? input.toString("hex") : null,
  },
  arms: {
    a: { bin: arms.a.bin, binSha256: arms.a.binSha256, tune: arms.a.tune },
    b: { bin: arms.b.bin, binSha256: arms.b.binSha256, tune: arms.b.tune },
  },
  settings: {
    events: COUNT_EVENTS,
    iterations,
    blocks: schedule.length,
    ratio: "a / b, per operation",
  },
  provenance: {
    rev: provenance.rev,
    dirty: provenance.dirty,
    dirtyPaths: provenance.dirtyPaths,
    node: provenance.node,
  },
  host: {
    cpu: parseCpuinfo(cpuinfo),
    kernel: os.release(),
    threads: os.availableParallelism(),
    counter: {
      backend: "perf-stat",
      version:
        spawnSync("perf", ["--version"]).stdout?.toString().trim() || "unknown",
      paranoid,
    },
    loadavgStart,
    loadavgEnd: loadavg(),
  },
  outputs: { ...outputs, equal: outputs.a === outputs.b },
  blocks,
  summary: summarize(blocks),
  against: null,
};

if (values.against) {
  const earlierPath = path.resolve(values.against);
  const earlier = JSON.parse(readFileSync(earlierPath, "utf8")) as CountsRecord;
  const earlierErrs = schemaErrors(earlier, readSchema());
  if (earlierErrs.length > 0)
    fail(`${values.against} is not a counts record: ${earlierErrs[0]}`);
  try {
    record.against = compareRuns(earlier, record, repoRelative(earlierPath));
  } catch (e) {
    fail((e as Error).message);
  }
}

const errs = schemaErrors(record, readSchema());
if (errs.length > 0)
  fail(`the record does not match its schema:\n  ${errs.join("\n  ")}`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);

const s = record.summary;
const fmt = (n: number) => n.toFixed(0);
console.error(
  `wrote ${repoRelative(out)}${out.startsWith(AB_COUNTS_DIR) ? "" : " (outside results/counts/ab)"}`,
);
for (const side of ["a", "b"] as const) {
  console.error(
    `arm ${side.toUpperCase()}: instructions ${fmt(s[side].median["instructions:u"])} per ${op} (blocks ${fmt(s[side].min["instructions:u"])}–${fmt(s[side].max["instructions:u"])}), cycles ${fmt(s[side].median["cycles:u"])}`,
  );
}
console.error(
  `A/B: instructions ${s.ratio.geomean["instructions:u"].toFixed(4)} (blocks ${s.ratio.min["instructions:u"].toFixed(4)}–${s.ratio.max["instructions:u"].toFixed(4)}), cycles ${s.ratio.geomean["cycles:u"].toFixed(3)} (blocks ${s.ratio.min["cycles:u"].toFixed(3)}–${s.ratio.max["cycles:u"].toFixed(3)}); outputs ${record.outputs.equal ? "equal" : "differ"}`,
);
if (record.against) {
  const g = record.against;
  console.error(
    `against ${g.record}: instruction ratio ${g.instructionRatio.map((r) => r.toFixed(4)).join(" / ")} (${(g.instructionAgreement * 100).toFixed(3)}%, ${g.agree ? "agree" : "DISAGREE"} within 1%), cycle ratio ${g.cycleRatio.map((r) => r.toFixed(3)).join(" / ")} (spread ${(g.cycleSpread * 100).toFixed(1)}%)`,
  );
  if (!g.agree) process.exit(1);
}
