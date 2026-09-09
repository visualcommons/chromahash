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
const OUT =
  value("--out") ?? path.join(ROOT, "tools/comparison/output/perf/perf.json");
const only = value("--impls");
const ONLY = only ? new Set(only.split(",").map((s) => s.trim())) : null;

const targets = allTargets().filter((t) => (ONLY ? ONLY.has(t.name) : true));

/**
 * Why a target could not be measured, and whether that is a fact about the host
 * or a fact about the target.
 *
 * This used to be a bare `ok: false`, identical for a missing binary, a
 * non-zero exit, a timeout and a crash — and `verify-benchmark` skips a
 * target's rows on that alone. So on macOS, where `xcodebuild` exists, a Swift
 * *build regression* was indistinguishable from no Swift toolchain, and the
 * gate would have waved the rows through in both cases. Only `absent` may be
 * skipped; `broken` is reported.
 */
type Availability = "absent" | "broken";

/**
 * Strip the author's checkout path out of a probe message.
 *
 * The reason is committed in `baselines/perf-report.json` and echoed into CI
 * logs by `verify-benchmark`, and Node's ENOENT message quotes the absolute
 * command — which for this repo was a maintainer's worktree path, published in
 * the baseline and reprinted on every CI run. Repo-relative says the same
 * thing and belongs to the repo rather than to whoever measured.
 */
function repoRelative(message: string): string {
  return message.split(`${ROOT}/`).join("").split(ROOT).join(".");
}

/** A target is available if its binary exists and answers `bench-info`. */
function probeAvailability(t: Target): {
  ok: boolean;
  kind?: Availability;
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
    // ENOENT is the only outcome that means "nothing on this host could have
    // measured it". A spawn that succeeded and then exited non-zero, timed out
    // (ETIMEDOUT / SIGTERM) or died on a signal all mean the target is present
    // and not working.
    const code = (proc.error as NodeJS.ErrnoException | undefined)?.code;
    const kind: Availability = code === "ENOENT" ? "absent" : "broken";
    const why =
      proc.error?.message ??
      proc.stderr?.slice(0, 200) ??
      (proc.signal ? `killed by ${proc.signal}` : `exit ${proc.status}`);
    return { ok: false, kind, reason: repoRelative(why.trim()) };
  }
  return { ok: true, info: proc.stdout.trim() };
}

const available: Target[] = [];
const unavailable: { target: string; reason: string; kind: Availability }[] =
  [];
const info: Record<string, string> = {};
for (const t of targets) {
  const a = probeAvailability(t);
  if (a.ok) {
    available.push(t);
    info[t.name] = a.info ?? "";
  } else {
    unavailable.push({
      target: t.name,
      reason: a.reason ?? "unknown",
      kind: a.kind ?? "broken",
    });
  }
}

const broken = unavailable.filter((u) => u.kind === "broken");
const brokenNote = broken.length
  ? ` (${broken.length} present but failing)`
  : "";
const unavailableNote = unavailable.length
  ? `, ${unavailable.length} unavailable${brokenNote}`
  : "";
const BROKEN_NOTE =
  "      recorded as broken, not absent, so verify:benchmark will not skip its rows";
for (const u of broken) {
  process.stderr.write(
    `perf: WARNING ${u.target} is built but its probe failed — ${u.reason.split("\n")[0]}\n${BROKEN_NOTE}\n`,
  );
}
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
