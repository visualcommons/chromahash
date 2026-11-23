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

import { readFileSync } from "node:fs";
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

/** One arm: a binary and the `CHROMAHASH_TUNE` it runs under. */
export interface CountsArm {
  bin: string;
  binSha256: string;
  tune: string;
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
