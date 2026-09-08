/**
 * The unified performance driver.
 *
 * Produces one machine-readable document covering time, bytes and (where
 * available) quality across every performance lever, for every distinct
 * implementation — the three axes the repo previously measured with three
 * separate tools that never met.
 *
 * Usage:
 *   node dist/perf/run.js [--full] [--impls A,B] [--out FILE] [--max-cell-ms N]
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ALL_TIERS,
  BOUNDED_CROSS_TIERS,
  BOUNDED_SIZES,
  BOUNDED_THREADS,
  FULL_SIZES,
  FULL_THREADS,
  TIER_BYTES,
  TUNE_ARMS,
  makeFixture,
} from "./matrix.ts";
import { probeCell } from "./probe.ts";
import { ROOT, type Target, allTargets } from "./targets.ts";

interface Cell {
  id: string;
  op: string;
  target: string;
  tier: number;
  source: { w: number; h: number; content: string } | null;
  tune: string | null;
  decodeCap: [number, number] | null;
  threads: number | null;
  bytes: number | null;
  iters: number;
  reps: number;
  samplesNsPerOp: number[];
  /** The reported cost: the minimum over the timed blocks (see probe.ts). */
  nsPerOp: number;
  medianNsPerOp: number;
  minNsPerOp: number;
  ci95NsPerOp: [number, number];
  iqrPct: number;
  noisy: boolean;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

const FULL = flag("--full");
const QUICK = flag("--quick");
const MAX_CELL_MS = Number.parseInt(value("--max-cell-ms") ?? "5000", 10);
const REPS = Number.parseInt(value("--reps") ?? (QUICK ? "1" : "7"), 10);
/**
 * The three run shapes must not land on the same file: `verify:benchmark` reads
 * `perf-report-full.json` and `perf-report.json` as two distinct baselines
 * (see verify-benchmark.ts), so a shared default would have `benchmark:full`
 * silently overwrite the bounded run it is meant to sit beside. An explicit
 * `--out` still wins over all three.
 *
 * `--quick` takes precedence over `--full` in the name, which is the one
 * ordering that is not arbitrary. Its own task description says the numbers are
 * "not meaningful": it is a contract smoke test at one rep, and the only way it
 * can do damage is by being mistaken for a baseline. Naming it after the matrix
 * it swept would let `--quick --full` produce a `perf-full.json` that looks
 * exactly like an hours-long sweep, so the reps win the name instead.
 */
const OUT =
  value("--out") ??
  path.join(
    ROOT,
    QUICK
      ? "tools/comparison/output/perf/perf-quick.json"
      : FULL
        ? "tools/comparison/output/perf/perf-full.json"
        : "tools/comparison/output/perf/perf.json",
  );
const only = value("--impls");
const ONLY = only ? new Set(only.split(",").map((s) => s.trim())) : null;

const targets = allTargets().filter((t) => (ONLY ? ONLY.has(t.name) : true));

/** A target is available if its binary exists and answers `bench-info`. */
function probeAvailability(t: Target): {
  ok: boolean;
  reason?: string;
  info?: string;
} {
  const proc = spawnSync(t.command, [...t.args, "bench-info"], {
    cwd: t.cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...t.env },
  });
  if (proc.error || proc.status !== 0) {
    const why =
      proc.error?.message ??
      proc.stderr?.slice(0, 200) ??
      `exit ${proc.status}`;
    return { ok: false, reason: why.trim() };
  }
  return { ok: true, info: proc.stdout.trim() };
}

const available: Target[] = [];
const unavailable: { target: string; reason: string }[] = [];
const info: Record<string, string> = {};
for (const t of targets) {
  const a = probeAvailability(t);
  if (a.ok) {
    available.push(t);
    info[t.name] = a.info ?? "";
  } else {
    unavailable.push({ target: t.name, reason: a.reason ?? "unknown" });
  }
}

const unavailableNote = unavailable.length
  ? `, ${unavailable.length} unavailable`
  : "";
process.stderr.write(
  `perf: ${available.length} target(s) available${unavailableNote}\n`,
);
for (const u of unavailable)
  process.stderr.write(`  - ${u.target}: ${u.reason}\n`);

const cells: Cell[] = [];
const recorded = new Set<string>();
let done = 0;

function record(
  id: string,
  op: string,
  t: Target,
  tier: number,
  source: { w: number; h: number; content: string } | null,
  opts: {
    argv: string[];
    stdin: Buffer;
    env?: Record<string, string>;
    tune?: string | null;
    decodeCap?: [number, number] | null;
    threads?: number | null;
    bytes?: number | null;
  },
): void {
  // The sweep blocks deliberately overlap — block A covers every target at the
  // bounded cross tiers, block C extends Rust decode to all five. Measuring the
  // same cell twice does not average: the 2026-08-29 baseline carried
  // `decode/Rust/t2/natural` at both 1349 us (1.0% IQR) and 2047 us (30.0%),
  // and the report quoted the noisy one. One id, one measurement — which is
  // also what lets `verify:benchmark` bind a documented number to a cell.
  if (recorded.has(id)) return;
  recorded.add(id);
  done++;
  process.stderr.write(`  [${done}] ${id}\n`);
  let outcome: ReturnType<typeof probeCell>;
  try {
    outcome = probeCell({
      target: t,
      argv: opts.argv,
      stdin: opts.stdin,
      env: { CHROMAHASH_TIER: String(tier), ...(opts.env ?? {}) },
      reps: REPS,
      maxCellMs: MAX_CELL_MS,
    });
  } catch (e) {
    process.stderr.write(`      failed: ${(e as Error).message}\n`);
    return;
  }
  if (outcome.kind === "skipped") {
    process.stderr.write(`      skipped: ${outcome.reason}\n`);
    return;
  }
  const r = outcome.result;
  cells.push({
    id,
    op,
    target: t.name,
    tier,
    source,
    tune: opts.tune ?? null,
    decodeCap: opts.decodeCap ?? null,
    threads: opts.threads ?? null,
    bytes: opts.bytes ?? null,
    iters: r.iters,
    reps: r.reps,
    samplesNsPerOp: r.samplesNsPerOp,
    nsPerOp: r.nsPerOp,
    medianNsPerOp: r.medianNsPerOp,
    minNsPerOp: r.minNsPerOp,
    ci95NsPerOp: r.ci95NsPerOp,
    iqrPct: r.iqrPct,
    noisy: r.noisy,
  });
}

const rustCandidate = allTargets().find((t) => t.name === "Rust");
if (!rustCandidate) throw new Error("no Rust target defined");
const rustBin: Target = rustCandidate;

/** One hash per tier, produced by Rust — the format is byte-identical by spec. */
function hashFor(
  tier: number,
  w: number,
  h: number,
  content: "gradient" | "noise" | "solid",
): Buffer {
  const fx = makeFixture(w, h, content);
  return execFileSync(
    rustBin.command,
    ["encode", String(w), String(h), "srgb"],
    {
      cwd: rustBin.cwd,
      input: fx.rgba,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CHROMAHASH_TIER: String(tier) },
    },
  );
}

const sizes = FULL ? FULL_SIZES : BOUNDED_SIZES;
const crossTiers = FULL ? ALL_TIERS : BOUNDED_CROSS_TIERS;
const threadCounts = FULL ? FULL_THREADS : BOUNDED_THREADS;
const centre = makeFixture(100, 100, "gradient");

process.stderr.write("\nperf: measuring\n");

// A. Cross-language encode/decode at the centre fixture.
for (const t of available) {
  for (const tier of QUICK ? [1] : crossTiers) {
    const bytes = TIER_BYTES[tier] ?? null;
    if (t.ops.includes("encode")) {
      record(
        `encode/${t.name}/t${tier}/100x100/gradient`,
        "encode",
        t,
        tier,
        { w: 100, h: 100, content: "gradient" },
        {
          argv: ["bench-encode", "100", "100", "srgb", "@ITERS@"],
          stdin: centre.rgba,
          bytes,
        },
      );
    }
    if (t.ops.includes("decode")) {
      record(`decode/${t.name}/t${tier}/natural`, "decode", t, tier, null, {
        argv: ["bench-decode", "@ITERS@"],
        stdin: hashFor(tier, 100, 100, "gradient"),
        bytes,
      });
    }
  }
}

if (!QUICK) {
  const rust = available.find((t) => t.name === "Rust");

  // B. Encode scaling in source pixels — the axis nothing varied before.
  if (rust) {
    for (const n of sizes) {
      const fx = makeFixture(n, n, "gradient");
      record(
        `encode/Rust/t1/${n}x${n}/gradient`,
        "encode",
        rust,
        1,
        { w: n, h: n, content: "gradient" },
        {
          argv: ["bench-encode", String(n), String(n), "srgb", "@ITERS@"],
          stdin: fx.rgba,
          bytes: 32,
        },
      );
    }
    // C. Decode scaling by tier, natural and capped.
    for (const tier of ALL_TIERS) {
      const hash = hashFor(tier, 100, 100, "gradient");
      record(`decode/Rust/t${tier}/natural`, "decode", rust, tier, null, {
        argv: ["bench-decode", "@ITERS@"],
        stdin: hash,
        bytes: TIER_BYTES[tier] ?? null,
      });
      record(`decode/Rust/t${tier}/capped32`, "decode", rust, tier, null, {
        argv: ["bench-decode", "@ITERS@", "32", "32"],
        stdin: hash,
        decodeCap: [32, 32],
        bytes: TIER_BYTES[tier] ?? null,
      });
    }
    // E. Encoder-only levers, priced against their quality deltas in EXPERIMENTS.
    //
    // Three sizes, not two: the separable-DCT arm's whole claim is that its
    // saving grows with K/Cx, and two points cannot show a trend.
    for (const arm of TUNE_ARMS) {
      for (const n of [100, 256, 512]) {
        const fx = makeFixture(n, n, "gradient");
        record(
          `encode/Rust/t1/${n}x${n}/gradient/${arm.label}`,
          "encode",
          rust,
          1,
          { w: n, h: n, content: "gradient" },
          {
            argv: ["bench-encode", String(n), String(n), "srgb", "@ITERS@"],
            stdin: fx.rgba,
            env: arm.tune ? { CHROMAHASH_TUNE: arm.tune } : {},
            tune: arm.tune,
            bytes: 32,
          },
        );
      }
    }
    // I. Content classes — what a filled AC band costs the quantizer.
    for (const content of ["gradient", "noise", "solid"] as const) {
      const fx = makeFixture(256, 256, content);
      record(
        `encode/Rust/t1/256x256/${content}`,
        "encode",
        rust,
        1,
        { w: 256, h: 256, content },
        {
          argv: ["bench-encode", "256", "256", "srgb", "@ITERS@"],
          stdin: fx.rgba,
          bytes: 32,
        },
      );
    }
  }

  // D. SIMD on/off — the shipped feature nothing has ever measured.
  const scalar = available.find((t) => t.name === "Rust (scalar)");
  if (scalar) {
    // Both builds, same sizes and tiers: the feature is only priceable as a
    // ratio, so every scalar cell needs a default-build cell to divide into.
    // The tier axis is here because the gain is largest where the per-pixel
    // OKLAB transform is the biggest share of encode, which is the low tiers.
    for (const [n, tier] of [
      [100, 1],
      [256, 1],
      [512, 1],
      [512, 0],
    ] as const) {
      const fx = makeFixture(n, n, "gradient");
      const argv = ["bench-encode", String(n), String(n), "srgb", "@ITERS@"];
      const src = { w: n, h: n, content: "gradient" as const };
      const bytes = TIER_BYTES[tier] ?? null;
      for (const t of [rust, scalar]) {
        if (!t) continue;
        record(
          `encode/${t.name}/t${tier}/${n}x${n}/gradient`,
          "encode",
          t,
          tier,
          src,
          { argv, stdin: fx.rgba, bytes },
        );
      }
    }
  }

  // G. Batch throughput and thread scaling, reported per batch.
  for (const t of available) {
    if (!t.ops.includes("batch")) continue;
    for (const th of t.threadable ? threadCounts : [1]) {
      record(
        `batch/${t.name}/t1/100x100/threads=${th === 0 ? "auto" : th}`,
        "batch",
        t,
        1,
        { w: 100, h: 100, content: "gradient" },
        {
          argv: ["bench-batch", "100", "100", "srgb", "200"],
          stdin: centre.rgba,
          env: { CHROMAHASH_BATCH_THREADS: String(th) },
          threads: th,
          bytes: 32,
        },
      );
    }
  }
}

const doc = {
  schema: "chromahash-perf/2",
  generatedAt: new Date().toISOString(),
  git: {
    commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
    dirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim().length > 0,
  },
  environment: {
    os: process.platform,
    arch: process.arch,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    node: process.versions.node,
    targetInfo: info,
  },
  config: {
    mode: QUICK ? "quick" : FULL ? "full" : "bounded",
    reps: REPS,
    maxCellMs: MAX_CELL_MS,
  },
  unavailable,
  cells,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
process.stderr.write(`\nperf: ${cells.length} cell(s) -> ${OUT}\n`);
