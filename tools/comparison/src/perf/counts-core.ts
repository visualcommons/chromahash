/**
 * `benchmark:counts`, the pure parts: the block schedule, each arm's summary
 * and the ratio, the refusals (no counter, another CPU, another cell), and the
 * committed record's schema. `counts.ts` runs the processes; this module is
 * what `selftest:metrics` pins.
 *
 * The harness compares two arms on one cell by retired user-space
 * instructions, which another process's load does not move, with cycles read
 * beside them and judging nothing (`count.ts`). It never records a wall-clock
 * figure: the schema below has no field for one, and `wallClockFields` finds
 * any that is added to it.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  COUNT_EVENTS,
  type CountBlock,
  type CountEvent,
  type PairReading,
  type ProcessCounts,
  RUN_AGREEMENT,
  blockOrder,
  pairReading,
  parsePerfStat,
} from "./count.ts";

/** Where the records and their schema live. */
export const AB_COUNTS_DIR = path.resolve(
  import.meta.dirname,
  "../../results/counts/ab",
);
export const AB_SCHEMA_PATH = path.join(AB_COUNTS_DIR, "counts.schema.json");

export type Op = "encode" | "decode";

/** What is measured: one implementation, operation, source size and tier. */
export interface CountsCell {
  impl: string;
  op: Op;
  width: number;
  height: number;
  tier: number;
  content: "gradient" | "noise" | "solid";
  fixtureSha256: string;
  /** A decode cell's input hash, hex: arm A's encode of the fixture. */
  input: string | null;
}

/**
 * One arm: a binary and the `CHROMAHASH_TUNE` it runs under. An arm that runs
 * another implementation than the cell's (`--b-impl`) names it; an arm run
 * under a {@link CountingConfig} states it. For a host with a counting
 * configuration, `bin` is the program it runs and `binSha256` digests its
 * artifacts ({@link artifactsSha256}).
 */
export interface CountsArm {
  bin: string;
  binSha256: string;
  tune: string;
  impl?: string;
  config?: string[];
}

/** The CPU a record was counted on. Counts compare only on one identity. */
export interface CpuIdentity {
  vendor: string;
  family: string;
  model: string;
  stepping: string;
  modelName: string;
}

/** One arm's per-operation count over the blocks. */
export interface Spread {
  median: ProcessCounts;
  min: ProcessCounts;
  max: ProcessCounts;
}

export interface Against {
  record: string;
  rev: string | null;
  instructionRatio: [number, number];
  instructionAgreement: number;
  agree: boolean;
  cycleRatio: [number, number];
  cycleSpread: number;
}

export interface CountsRecord {
  schema: 1;
  tool: "benchmark-counts";
  cell: CountsCell;
  arms: { a: CountsArm; b: CountsArm };
  settings: {
    events: readonly CountEvent[];
    iterations: number;
    blocks: number;
    ratio: "a / b, per operation";
  };
  provenance: {
    rev: string | null;
    dirty: boolean | null;
    dirtyPaths: string[];
    node: string;
  };
  host: {
    cpu: CpuIdentity;
    kernel: string;
    threads: number;
    counter: { backend: "perf-stat"; version: string; paranoid: number | null };
    loadavgStart: number[];
    loadavgEnd: number[];
  };
  outputs: { a: string; b: string; equal: boolean };
  blocks: CountBlock[];
  summary: {
    a: Spread;
    b: Spread;
    ratio: { geomean: ProcessCounts; min: ProcessCounts; max: ProcessCounts };
  };
  against: Against | null;
}

// ─── The block schedule ─────────────────────────────────────────────────────

/**
 * Which arm runs first in each block: A B, B A, A B, … Refuses a count that is
 * not a positive even number, so the schedule is always complete A B / B A
 * pairs and neither arm runs first more often than the other.
 */
export function blockSchedule(blocks: number): ("AB" | "BA")[] {
  if (!Number.isInteger(blocks) || blocks < 2 || blocks % 2 !== 0) {
    throw new Error(
      `--blocks must be a positive even number, for complete A B / B A pairs; got ${blocks}`,
    );
  }
  return Array.from({ length: blocks }, (_, i) =>
    blockOrder(i)[0] === "a" ? "AB" : "BA",
  );
}

// ─── Each arm, and the ratio ────────────────────────────────────────────────

/** The median of a non-empty list: the mean of the middle two for an even one. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** One arm's median per-operation count and its block range, per event. */
export function armSpread(
  blocks: readonly CountBlock[],
  side: "a" | "b",
): Spread {
  if (blocks.length === 0) throw new Error("an arm needs at least one block");
  const out = { median: {}, min: {}, max: {} } as {
    median: Partial<ProcessCounts>;
    min: Partial<ProcessCounts>;
    max: Partial<ProcessCounts>;
  };
  for (const e of COUNT_EVENTS) {
    const v = blocks.map((b) => b[side][e]);
    out.median[e] = median(v);
    out.min[e] = Math.min(...v);
    out.max[e] = Math.max(...v);
  }
  return out as Spread;
}

/** The record's summary: each arm's spread, and the paired ratio. */
export function summarize(
  blocks: readonly CountBlock[],
): CountsRecord["summary"] {
  const r: PairReading = pairReading(blocks);
  return {
    a: armSpread(blocks, "a"),
    b: armSpread(blocks, "b"),
    ratio: { geomean: r.ratio, min: r.min, max: r.max },
  };
}

// ─── Refusals ───────────────────────────────────────────────────────────────

/** What probing the counter saw: a `perf stat` spawn, and the sysctl. */
export interface CounterProbe {
  /** The spawn's error code (`ENOENT` when `perf` is not installed). */
  errorCode: string | null;
  status: number | null;
  stderr: string;
  /** `kernel.perf_event_paranoid`, or null where it could not be read. */
  paranoid: number | null;
}

/**
 * Why the counter cannot be used, by name, or null when it can. The harness
 * has one backend, `perf stat`; it refuses rather than fall back to a timer,
 * so no count it records is an estimate or a clock reading.
 */
export function counterRefusal(p: CounterProbe): string | null {
  if (p.errorCode === "ENOENT") {
    return "perf is not installed: benchmark:counts reads instructions:u and cycles:u through perf stat, and has no other backend";
  }
  if (p.errorCode !== null) return `perf could not be run: ${p.errorCode}`;
  if (p.paranoid !== null && p.paranoid > 2) {
    return `kernel.perf_event_paranoid is ${p.paranoid}: user-space counters (instructions:u, cycles:u) need it at 2 or lower`;
  }
  for (const e of COUNT_EVENTS) {
    for (const line of p.stderr.split("\n")) {
      const f = line.split(",");
      if (
        f[2] === e &&
        (f[0] === "<not supported>" || f[0] === "<not counted>")
      ) {
        return `this host does not count ${e}: perf stat reported ${f[0]}`;
      }
    }
  }
  if (p.status !== 0) {
    return `perf stat exited ${p.status}: ${p.stderr.trim().slice(0, 200)}`;
  }
  try {
    parsePerfStat(p.stderr);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

/**
 * The implementations whose per-operation instruction count is a property of
 * the operation as they ship: native code with no tracing collector. Rust runs
 * none; Swift frees by reference counting, inline on the calling thread, so
 * its retain and release instructions are part of the operation and repeat
 * with it.
 */
export const COUNTABLE_IMPLS: readonly string[] = [
  "Rust",
  "Rust (scalar)",
  "Swift",
];

/**
 * How a host runtime is run under count, so that a process's instruction
 * count depends only on the operation: the runtime's background compilation
 * and its collector's pacing are turned off or made synchronous, because the
 * short/long subtraction (`count.ts` `perIteration`) cancels only work that is
 * the same in both processes or N times larger in the long one. A host is
 * admitted under its configuration only where the configuration passes
 * {@link HOST_SPREAD} in a committed record (`overhead-core.ts`); the
 * configuration is not how the host ships, so a count taken under it is the
 * host's cost under that configuration, not in production.
 */
export interface CountingConfig {
  /** Environment set for the host's processes, beside the harness's own. */
  env: Readonly<Record<string, string>>;
  /** Runtime flags, placed before the program on the runtime's command line. */
  flags: readonly string[];
  /** Repository-relative command that replaces the target's, if any. */
  command?: string;
  /** Arguments that replace the target's, if any. */
  args?: readonly string[];
  /**
   * Repository-relative path of the program the host runs, which an arm's
   * `--a-bin` / `--b-bin` replaces: the script, assembly or launcher. Null
   * where the host runs a module by name and no other build can be named.
   */
  program: string | null;
  /**
   * Repository-relative files and directories whose bytes are the code under
   * test (`binSha256` digests them all), given the arm's program.
   */
  artifacts: (program: string) => string[];
  /** Why the configuration makes the count depend only on the operation. */
  why: string;
}

/** The V8 flags that leave one deterministic tier for JavaScript and wasm. */
const NODE_FLAGS = [
  "--single-threaded",
  "--no-opt",
  "--no-maglev",
  "--no-sparkplug",
  "--liftoff-only",
] as const;

/**
 * The counting configuration of each host runtime `benchmark:counts` admits
 * beyond {@link COUNTABLE_IMPLS}, by target name. Each was checked before it
 * was committed by ten interleaved blocks whose per-operation instruction
 * counts all fall within {@link HOST_SPREAD} of their median; the committed
 * host records carry that check (`overhead-core.ts` `spreadProblem`).
 */
export const COUNTING_CONFIGS: Readonly<Record<string, CountingConfig>> = {
  Go: {
    env: { GOGC: "off", GOMAXPROCS: "1" },
    flags: [],
    program: "go/encode-stdin",
    artifacts: (p) => [p],
    why: "GOGC=off stops the collector, whose concurrent work is paced by heap growth rather than by the operation, and GOMAXPROCS=1 keeps the scheduler to one thread",
  },
  "TypeScript (wasm)": {
    env: {},
    flags: NODE_FLAGS,
    program: "typescript/dist/encode-stdin.js",
    artifacts: (p) => {
      const pkg = path.dirname(path.dirname(p));
      return [path.join(pkg, "dist"), path.join(pkg, "wasm")];
    },
    why: `${NODE_FLAGS.join(" ")}: V8 runs JavaScript in its interpreter and wasm in its baseline compiler only, with no tier-up and no background compile or GC thread, so the wasm core runs slower than it ships`,
  },
  "C#": {
    env: {
      DOTNET_TieredCompilation: "0",
      DOTNET_TieredPGO: "0",
      DOTNET_gcConcurrent: "0",
      DOTNET_GCgen0size: "0x10000000",
    },
    flags: [],
    program: "csharp/src/Chromahash.Cli/bin/Release/net9.0/Chromahash.Cli.dll",
    artifacts: (p) => [path.dirname(p)],
    why: "every method is compiled once, fully optimized, on first call (no tiering, no rejit, no profile-guided recompile), and the collector is non-concurrent with a 256 MiB first generation",
  },
  Kotlin: {
    env: {
      JAVA_OPTS:
        "-XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Xbatch -XX:CICompilerCount=1",
    },
    flags: [],
    program:
      "bindings/uniffi/jvm/build/install/chromahash-jvm/bin/chromahash-jvm",
    artifacts: (p) => [path.join(path.dirname(path.dirname(p)), "lib")],
    why: "the JVM compiles with C1 only, synchronously (-Xbatch) on one compiler thread, so a method compiles at the same call count in every process, and the serial collector runs on the calling thread",
  },
  Python: {
    env: { PYTHONHASHSEED: "0" },
    flags: [],
    command: "python/.venv/bin/python",
    args: ["-m", "chromahash.encode_stdin"],
    program: null,
    artifacts: () => ["python/chromahash"],
    why: "the virtual environment's interpreter runs directly rather than through `uv run`, whose start-up varies when it re-syncs the environment, with a fixed hash seed; CPython has no JIT and collects by reference count and allocation count",
  },
};

/**
 * The tolerance of the host admission check: across a record's interleaved
 * blocks, each arm's per-operation instruction count stays within 1% of the
 * arm's median.
 */
export const HOST_SPREAD = 0.01;

/**
 * An arm's block spread: the largest relative distance of a block's
 * per-operation instruction count from the arm's median.
 */
export function blockSpread(s: Spread): number {
  const m = s.median["instructions:u"];
  if (!(m > 0)) throw new Error("an arm's median count must be positive");
  return Math.max(
    Math.abs(s.min["instructions:u"] / m - 1),
    Math.abs(s.max["instructions:u"] / m - 1),
  );
}

/**
 * Why an implementation cannot be counted, by name, or null when it can. A
 * host with a {@link COUNTING_CONFIGS} entry is admitted under it; any other
 * managed runtime, and any implementation not admitted by name, is refused:
 * a JIT's tier-up and a collector add instructions to a process that the
 * short/long subtraction does not cancel.
 */
export function implRefusal(t: {
  name: string;
  managed: boolean;
}): string | null {
  if (COUNTING_CONFIGS[t.name] !== undefined) return null;
  if (t.managed) {
    return `${t.name} runs on a managed runtime with no counting configuration: its JIT and collector make an instruction count depend on more than the operation, so benchmark:counts refuses it`;
  }
  if (!COUNTABLE_IMPLS.includes(t.name)) {
    return `${t.name} is not one of benchmark:counts' admitted implementations (${[...COUNTABLE_IMPLS, ...Object.keys(COUNTING_CONFIGS)].join(", ")})`;
  }
  return null;
}

/**
 * A configuration as the record states it: its environment as `NAME=value`,
 * sorted, then its runtime flags in order, then the command and arguments it
 * runs in place of the target's, if any.
 */
export const configTokens = (c: CountingConfig): string[] => [
  ...Object.entries(c.env)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`),
  ...c.flags,
  ...(c.command === undefined
    ? []
    : [`runs: ${[c.command, ...(c.args ?? [])].join(" ")}`]),
];

/**
 * The digest of an arm's code: for one file, its SHA-256; otherwise the
 * SHA-256 of one `<sha256>  <path>` line per file under the given files and
 * directories (paths relative to `root`, sorted, `__pycache__` skipped since
 * the interpreter writes it as it runs). Null where an artifact is missing.
 */
export function artifactsSha256(
  root: string,
  artifacts: readonly string[],
): string | null {
  const digest = (b: Buffer | string) =>
    createHash("sha256").update(b).digest("hex");
  const files: string[] = [];
  const walk = (abs: string): boolean => {
    if (!existsSync(abs)) return false;
    if (!statSync(abs).isDirectory()) {
      files.push(abs);
      return true;
    }
    for (const e of readdirSync(abs)) {
      if (e !== "__pycache__") walk(path.join(abs, e));
    }
    return true;
  };
  const abs = artifacts.map((a) => path.resolve(root, a));
  if (!abs.every(walk)) return null;
  if (abs.length === 1 && files.length === 1 && files[0] === abs[0]) {
    return digest(readFileSync(abs[0] as string));
  }
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
  const lines = files
    .map((f) => `${digest(readFileSync(f))}  ${rel(f)}`)
    .sort((x, y) => {
      const a = x.slice(66);
      const b = y.slice(66);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return digest(`${lines.join("\n")}\n`);
}

/** The implementations whose `decode` writes a `W H` line before the pixels. */
export const HEADED_DECODE_IMPLS: readonly string[] = ["Rust", "Rust (scalar)"];

/**
 * A decode's RGBA bytes: for an implementation in {@link HEADED_DECODE_IMPLS},
 * its output with the `W H` header line removed; for any other, its output.
 * Where a record's arms run different implementations, the record compares
 * these, so a host that writes the pixels alone and a Rust arm compare on the
 * same bytes. Throws on a missing header, or one whose dimensions disagree
 * with the byte count that follows.
 */
export function decodedPixels(impl: string, out: Buffer): Buffer {
  if (!HEADED_DECODE_IMPLS.includes(impl)) return out;
  const nl = out.indexOf(0x0a);
  const head = nl < 0 ? "" : out.subarray(0, nl).toString("latin1");
  const m = /^(\d+) (\d+)$/.exec(head);
  if (m === null) throw new Error(`${impl}'s decode wrote no "W H" header`);
  const pixels = out.subarray(nl + 1);
  const want = Number(m[1]) * Number(m[2]) * 4;
  if (pixels.length !== want) {
    throw new Error(
      `a decode wrote a ${m[1]}x${m[2]} header and ${pixels.length} bytes, not ${want}`,
    );
  }
  return pixels;
}

/** Read `/proc/cpuinfo`'s first processor into a {@link CpuIdentity}. */
export function parseCpuinfo(text: string): CpuIdentity {
  const first = text.split(/\n\s*\n/)[0] ?? "";
  const field = (key: string): string => {
    for (const line of first.split("\n")) {
      const [k, ...v] = line.split(":");
      if (k?.trim() === key) return v.join(":").trim();
    }
    return "unknown";
  };
  return {
    vendor: field("vendor_id"),
    family: field("cpu family"),
    model: field("model"),
    stepping: field("stepping"),
    modelName: field("model name"),
  };
}

const sameJson = (x: unknown, y: unknown): boolean =>
  JSON.stringify(x) === JSON.stringify(y);

/**
 * Compare a run with an earlier one of the same measurement. Refuses records
 * counted on different CPUs (instruction counts are a property of the
 * microarchitecture and the code it runs, so a ratio from another CPU is a
 * different measurement), an unknown CPU, and records of different cells,
 * arms, settings or backends. Otherwise returns how far the two instruction
 * ratios agree, against {@link RUN_AGREEMENT}, with the cycle-ratio spread
 * beside it.
 */
export function compareRuns(
  earlier: CountsRecord,
  later: CountsRecord,
  earlierPath: string,
): Against {
  const ca = earlier.host.cpu;
  const cb = later.host.cpu;
  if (
    Object.values(ca).includes("unknown") ||
    Object.values(cb).includes("unknown")
  ) {
    throw new Error(
      "refusing to compare runs whose CPU identity is unknown: a ratio is comparable only on one CPU",
    );
  }
  if (!sameJson(ca, cb)) {
    throw new Error(
      `refusing to compare runs from different CPUs: ${ca.modelName} (family ${ca.family} model ${ca.model} stepping ${ca.stepping}) against ${cb.modelName} (family ${cb.family} model ${cb.model} stepping ${cb.stepping})`,
    );
  }
  if (!sameJson(earlier.cell, later.cell)) {
    throw new Error("refusing to compare runs of different cells");
  }
  for (const side of ["a", "b"] as const) {
    const x = earlier.arms[side];
    const y = later.arms[side];
    if (x.tune !== y.tune || x.binSha256 !== y.binSha256) {
      throw new Error(
        `refusing to compare runs whose arm ${side.toUpperCase()} differs (tune or binary digest)`,
      );
    }
  }
  if (!sameJson(earlier.settings, later.settings)) {
    throw new Error("refusing to compare runs with different settings");
  }
  if (earlier.host.counter.backend !== later.host.counter.backend) {
    throw new Error("refusing to compare runs read through different backends");
  }
  const i1 = earlier.summary.ratio.geomean["instructions:u"];
  const i2 = later.summary.ratio.geomean["instructions:u"];
  const c1 = earlier.summary.ratio.geomean["cycles:u"];
  const c2 = later.summary.ratio.geomean["cycles:u"];
  const instructionAgreement = Math.abs(i2 / i1 - 1);
  return {
    record: earlierPath,
    rev: earlier.provenance.rev,
    instructionRatio: [i1, i2],
    instructionAgreement,
    agree: instructionAgreement <= RUN_AGREEMENT,
    cycleRatio: [c1, c2],
    cycleSpread: Math.abs(c2 / c1 - 1),
  };
}

// ─── The schema ─────────────────────────────────────────────────────────────

/** The JSON Schema keywords the committed schema uses, and nothing more. */
export interface Schema {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  minimum?: number;
  exclusiveMinimum?: number;
  $defs?: Record<string, Schema>;
}

const KNOWN = new Set([
  "$schema",
  "$ref",
  "$defs",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minimum",
  "exclusiveMinimum",
]);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/**
 * Validate `value` against the subset of JSON Schema 2020-12 the committed
 * schema uses, returning every violation as `path: reason`. A keyword outside
 * that subset is itself a violation, so the schema cannot grow a rule this
 * validator silently ignores.
 */
export function schemaErrors(
  value: unknown,
  schema: Schema,
  root: Schema = schema,
  at = "$",
): string[] {
  const errs: string[] = [];
  for (const k of Object.keys(schema)) {
    if (!KNOWN.has(k))
      errs.push(`${at}: the schema uses unsupported keyword ${k}`);
  }
  if (schema.$ref !== undefined) {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    const target = root.$defs?.[name];
    if (target === undefined)
      return [...errs, `${at}: unresolved ${schema.$ref}`];
    return [...errs, ...schemaErrors(value, target, root, at)];
  }
  const t = typeOf(value);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some(
      (x) => x === t || (x === "number" && t === "integer"),
    );
    if (!ok) return [...errs, `${at}: is ${t}, not ${types.join(" or ")}`];
  }
  if ("const" in schema && !sameJson(value, schema.const)) {
    errs.push(`${at}: is not ${JSON.stringify(schema.const)}`);
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some((e) => sameJson(e, value))
  ) {
    errs.push(`${at}: is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && !(value >= schema.minimum)) {
      errs.push(`${at}: is under ${schema.minimum}`);
    }
    if (
      schema.exclusiveMinimum !== undefined &&
      !(value > schema.exclusiveMinimum)
    ) {
      errs.push(`${at}: is not above ${schema.exclusiveMinimum}`);
    }
  }
  if (t === "array" && schema.items !== undefined) {
    for (const [i, v] of (value as unknown[]).entries()) {
      errs.push(...schemaErrors(v, schema.items, root, `${at}[${i}]`));
    }
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) {
      if (!(r in obj)) errs.push(`${at}: lacks ${r}`);
    }
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub !== undefined)
        errs.push(...schemaErrors(v, sub, root, `${at}.${k}`));
      else if (schema.additionalProperties === false) {
        errs.push(`${at}: has ${k}, which the schema does not declare`);
      }
    }
  }
  return errs;
}

export const readSchema = (file: string = AB_SCHEMA_PATH): Schema =>
  JSON.parse(readFileSync(file, "utf8")) as Schema;

/**
 * A property name that reads as a wall-clock figure: a duration, a time unit,
 * a rate, or a speedup.
 */
const WALL_CLOCK =
  /(^|[^a-z])(ns|us|ms|secs?|seconds?|millis\w*|nanos\w*|time|timing|timed|duration|elapsed|wall\w*|clock|latency|throughput|ops|persec|speedup|faster)([^a-z]|$)/i;

/**
 * Every property name the schema declares that reads as a wall-clock figure.
 * Names are split at camelCase boundaries first, so `speedupRatio` and
 * `elapsedNs` are found.
 */
export function wallClockFields(schema: Schema, at = "$"): string[] {
  const out: string[] = [];
  const visit = (s: Schema, where: string): void => {
    for (const [k, sub] of Object.entries(s.properties ?? {})) {
      const words = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
      if (WALL_CLOCK.test(words)) out.push(`${where}.${k}`);
      visit(sub, `${where}.${k}`);
    }
    if (s.items) visit(s.items, `${where}[]`);
    for (const [k, sub] of Object.entries(s.$defs ?? {})) {
      visit(sub, `${where}.$defs.${k}`);
    }
  };
  visit(schema, at);
  return out;
}
