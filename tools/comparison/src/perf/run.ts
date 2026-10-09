/**
 * The unified performance driver.
 *
 * Produces one machine-readable document covering time and bytes across every
 * performance lever, for every distinct implementation — the axes the repo
 * previously measured with separate tools that never met.
 *
 * Usage:
 *   node dist/perf/run.js [--full | --quick] [--impls A,B] [--out FILE]
 *                         [--processes P] [--reps N] [--max-cell-ms N]
 *                         [--pin CPULIST] [--max-load L] [--force-loaded]
 *                         [--plan]
 *
 *   --full          the cells only the exhaustive matrix has; a supplement to
 *                   the bounded run, never an override (plan.ts)
 *   --processes P   independent processes per cell, interleaved round-robin
 *                   across cells (default 3; 1 for --quick)
 *   --reps N        timed blocks per process (default 5; 1 for --quick)
 *   --pin CPULIST   run every harness under `taskset -c CPULIST`
 *   --max-load L    refuse to start above this 1-minute load average
 *                   (default max(1, threads/8))
 *   --force-loaded  start anyway; the run is marked loaded and the gate
 *                   refuses it as a baseline
 *   --plan          print the cells and pairs this run would measure, and exit
 *   --preflight     print the host's state and the tree's, refuse (exit 3/4)
 *                   as a run would, and exit; --allow-dirty waives the tree
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  type Availability,
  type ProbeOutcome,
  classifyProbe,
} from "./availability.ts";
import {
  defaultMaxLoad,
  hostKey,
  machineId,
  mayStart,
  readLoadavg,
  readPreflight,
  rustcVersion,
} from "./host.ts";
import { makeFixture } from "./matrix.ts";
import {
  type Input,
  type Mode,
  type PlannedCell,
  planRun,
  roundOrder,
} from "./plan.ts";
import {
  type CellRequest,
  type CellStats,
  type PairStats,
  calibrate,
  cellStats,
  measureProcess,
  pairStats,
} from "./probe.ts";
import { MEASURED_PATHS, recordGit } from "./provenance.ts";
import { ROOT, type Target, allTargets } from "./targets.ts";

/** The run format. /3 is per-process sampling; see probe.ts. */
export const RUN_SCHEMA = "chromahash-perf/3";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const int = (name: string, fallback: number): number => {
  const raw = value(name);
  const n = raw === null ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(
      `perf: ${name} must be a positive integer, got ${raw}\n`,
    );
    process.exit(2);
  }
  return n;
};

const QUICK = flag("--quick");
const FULL = flag("--full") && !QUICK;
const MODE: Mode = QUICK ? "quick" : FULL ? "full" : "bounded";
const MAX_CELL_MS = int("--max-cell-ms", 5000);
const REPS = int("--reps", QUICK ? 1 : 5);
const PROCESSES = int("--processes", QUICK ? 1 : 3);
const PIN = value("--pin");
const FORCE_LOADED = flag("--force-loaded");
const MAX_LOAD = Number.parseFloat(
  value("--max-load") ?? String(defaultMaxLoad(os.cpus().length)),
);
/**
 * The three run shapes must not land on the same file: the gate reads the
 * bounded pair and the full supplement as distinct baselines, so a shared
 * default would have `benchmark:full` overwrite the bounded run it sits beside.
 * `--quick` wins the name over `--full`: it is a one-rep smoke test, and the
 * only way it can do damage is by being mistaken for a baseline.
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

const universe = allTargets();
const targets = universe.filter((t) => (ONLY ? ONLY.has(t.name) : true));

if (flag("--plan")) {
  const plan = planRun(MODE, targets, universe);
  for (const c of plan.cells) console.log(c.id);
  console.log(
    `\n${plan.cells.length} cell(s), ${plan.pairs.length} pair(s), ` +
      `${Object.keys(plan.aliases).length} alias(es), mode=${MODE}, ` +
      `${PROCESSES} process(es) x ${REPS} block(s) each`,
  );
  process.exit(0);
}

// ─── Preflight ──────────────────────────────────────────────────────────────

const preflight = readPreflight(MAX_LOAD, FORCE_LOADED);
for (const w of preflight.warnings)
  process.stderr.write(`perf: WARNING ${w}\n`);
if (!mayStart(preflight, FORCE_LOADED)) {
  process.stderr.write(
    [
      `perf: refusing to start — the host is loaded (${preflight.loadavgStart?.join(" ")}).`,
      "  A wall-clock figure taken now would be about this machine's other work.",
      "  Wait for it, raise the bar with --max-load, or pass --force-loaded to",
      "  measure anyway: the run is then marked loaded and verify:benchmark will",
      "  not accept it as a baseline.",
      "",
    ].join("\n"),
  );
  process.exit(3);
}
if (PIN) {
  const t = spawnSync("taskset", ["-c", PIN, "true"], { encoding: "utf8" });
  if (t.status !== 0) {
    process.stderr.write(
      `perf: --pin ${PIN} failed (${t.error?.message ?? t.stderr.trim()})\n`,
    );
    process.exit(2);
  }
}
const startedAt = new Date();
const gitAtStart = recordGit(ROOT);

// `--preflight`: what `benchmark:session` checks before committing an hour to
// a sweep — the host's state, and a tree the gate will accept a run from.
if (flag("--preflight")) {
  const show = (v: unknown) => (v === null ? "(not exposed)" : String(v));
  process.stderr.write(
    [
      `perf: preflight on ${hostKey({ os: process.platform, arch: process.arch, cpuModel: os.cpus()[0]?.model ?? "unknown" })}`,
      `  load average   ${show(preflight.loadavgStart?.join(" ") ?? null)} (bar ${MAX_LOAD.toFixed(2)})`,
      `  governor       ${show(preflight.governor)}`,
      `  boost          ${show(preflight.boost)}${preflight.boostSource ? ` (${preflight.boostSource})` : ""}`,
      `  SMT            ${show(preflight.smt)}`,
      `  driver / EPP   ${show(preflight.scalingDriver)} / ${show(preflight.energyPerformancePreference)}`,
      `  commit         ${gitAtStart.commit}${gitAtStart.dirty ? " (DIRTY outside the measurement outputs)" : ""}`,
      "",
    ].join("\n"),
  );
  if (gitAtStart.dirty && !flag("--allow-dirty")) {
    process.stderr.write(
      "perf: refusing — the tree has uncommitted changes outside the measurement outputs, so no run\n" +
        "      taken now can be traced to a revision and verify:benchmark would refuse it.\n",
    );
    process.exit(4);
  }
  process.exit(0);
}

// ─── Availability ───────────────────────────────────────────────────────────

/** How a failed probe is classified — `absent` or `broken` — is availability.ts. */
function probeAvailability(t: Target): ProbeOutcome {
  const proc = spawnSync(t.command, [...t.args, "bench-info"], {
    cwd: t.cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...t.env },
  });
  return classifyProbe(proc, ROOT);
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
for (const u of broken) {
  process.stderr.write(
    `perf: WARNING ${u.target} is built but its probe failed — ${u.reason.split("\n")[0]}\n      recorded as broken, not absent, so verify:benchmark will not skip its rows\n`,
  );
}
process.stderr.write(
  `perf: ${available.length} target(s) available${
    unavailable.length
      ? `, ${unavailable.length} unavailable${broken.length ? ` (${broken.length} present but failing)` : ""}`
      : ""
  }\n`,
);
for (const u of unavailable)
  process.stderr.write(`  - ${u.target}: ${u.reason}\n`);

// ─── Plan ───────────────────────────────────────────────────────────────────

const plan = planRun(MODE, available, universe);
const byName = new Map(available.map((t) => [t.name, t]));
const rust = universe.find((t) => t.name === "Rust");
if (!rust) throw new Error("no Rust target defined");

/** One hash per tier, produced by Rust — the format is byte-identical by spec. */
const hashes = new Map<string, Buffer>();
const fixtures = new Map<string, Buffer>();
function stdinFor(input: Input): Buffer {
  const key = `${input.kind}/${input.w}x${input.h}/${input.content}/${input.kind === "hash" ? input.tier : ""}`;
  const fx =
    fixtures.get(`${input.w}x${input.h}/${input.content}`) ??
    makeFixture(input.w, input.h, input.content).rgba;
  fixtures.set(`${input.w}x${input.h}/${input.content}`, fx);
  if (input.kind === "pixels") return fx;
  let h = hashes.get(key);
  if (!h) {
    h = execFileSync(
      (rust as Target).command,
      ["encode", String(input.w), String(input.h), "srgb"],
      {
        cwd: (rust as Target).cwd,
        input: fx,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CHROMAHASH_TIER: String(input.tier) },
      },
    );
    hashes.set(key, h);
  }
  return h;
}

function requestFor(c: PlannedCell): CellRequest {
  return {
    target: byName.get(c.target) as Target,
    argv: c.argv,
    stdin: stdinFor(c.input),
    env: { CHROMAHASH_TIER: String(c.tier), ...c.env },
    reps: REPS,
    maxCellMs: MAX_CELL_MS,
    pin: PIN,
  };
}

// ─── Measure ────────────────────────────────────────────────────────────────
//
// Calibrate every cell once, then take P rounds; each round spawns one process
// per cell, in `roundOrder` (units adjacent, every other round reversed).

const skipped: { id: string; reason: string }[] = [];
const iters = new Map<string, number>();
process.stderr.write(`\nperf: calibrating ${plan.cells.length} cell(s)\n`);
for (const c of plan.cells) {
  try {
    const cal = calibrate(requestFor(c));
    if (cal.kind === "skipped") {
      skipped.push({ id: c.id, reason: cal.reason });
      process.stderr.write(`  skipped ${c.id}: ${cal.reason}\n`);
    } else {
      iters.set(c.id, cal.iters);
    }
  } catch (e) {
    skipped.push({ id: c.id, reason: (e as Error).message });
    process.stderr.write(`  failed ${c.id}: ${(e as Error).message}\n`);
  }
}

/** Per cell, each round's blocks; undefined where that round's process failed. */
const rounds = new Map<string, (number[] | undefined)[]>();
for (let r = 0; r < PROCESSES; r++) {
  preflight.loadavgRounds.push(readLoadavg());
  const order = roundOrder(plan, r).filter((c) => iters.has(c.id));
  process.stderr.write(
    `\nperf: round ${r + 1}/${PROCESSES}, ${order.length} process(es)\n`,
  );
  let n = 0;
  for (const c of order) {
    n++;
    const list = rounds.get(c.id) ?? [];
    try {
      const m = measureProcess(
        requestFor(c),
        iters.get(c.id) as number,
        r === 0,
      );
      iters.set(c.id, m.iters);
      list[r] = m.blocks;
      process.stderr.write(`  [${n}] ${c.id}\n`);
    } catch (e) {
      list[r] = undefined;
      process.stderr.write(
        `  [${n}] ${c.id} failed: ${(e as Error).message}\n`,
      );
    }
    rounds.set(c.id, list);
  }
}
preflight.loadavgEnd = readLoadavg();
const gitAtEnd = recordGit(ROOT);

// ─── Record ─────────────────────────────────────────────────────────────────

const cells: (Omit<PlannedCell, "argv" | "input" | "env"> &
  CellStats & { iters: number; reps: number; processes: number })[] = [];
const minsById = new Map<string, (number | undefined)[]>();
for (const c of plan.cells) {
  const per = rounds.get(c.id);
  const taken = (per ?? []).filter((b): b is number[] => !!b && b.length > 0);
  if (taken.length === 0) {
    if (iters.has(c.id)) {
      skipped.push({ id: c.id, reason: "no process completed" });
    }
    continue;
  }
  const stats = cellStats(taken);
  minsById.set(
    c.id,
    Array.from({ length: PROCESSES }, (_, r) => {
      const b = per?.[r];
      return b && b.length > 0 ? Math.min(...b) : undefined;
    }),
  );
  const { argv: _a, input: _i, env: _e, ...shape } = c;
  cells.push({
    ...shape,
    iters: iters.get(c.id) as number,
    reps: REPS,
    processes: taken.length,
    ...stats,
  });
}

const pairs: ({ base: string; arm: string } & PairStats)[] = [];
for (const p of plan.pairs) {
  const s = pairStats(minsById.get(p.base) ?? [], minsById.get(p.arm) ?? []);
  if (s) pairs.push({ base: p.base, arm: p.arm, ...s });
}

const measured = new Set(cells.map((c) => c.id));
const environment = {
  os: process.platform,
  arch: process.arch,
  cpuModel: os.cpus()[0]?.model ?? "unknown",
  cores: os.cpus().length,
  node: process.versions.node,
  kernel: `${os.type()} ${os.release()}`,
  rustc: rustcVersion(ROOT),
  preflight,
  targetInfo: info,
};
const finishedAt = new Date();
const doc = {
  schema: RUN_SCHEMA,
  generatedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  wallSeconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  git: {
    commit: gitAtStart.commit,
    // Dirty at either end: a source edit mid-sweep is as untraceable as one
    // made before it.
    dirty:
      gitAtStart.dirty ||
      gitAtEnd.dirty ||
      gitAtStart.commit !== gitAtEnd.commit,
    digest: gitAtStart.digest,
    digestPaths: [...MEASURED_PATHS],
  },
  host: {
    id: hostKey(environment),
    machine: machineId(),
  },
  environment,
  config: {
    mode: MODE,
    supplementOf: MODE === "full" ? "bounded" : null,
    processes: PROCESSES,
    reps: REPS,
    maxCellMs: MAX_CELL_MS,
    pin: PIN,
    impls: ONLY ? [...ONLY] : null,
  },
  unavailable,
  skipped,
  cells,
  pairs,
  aliases: Object.fromEntries(
    Object.entries(plan.aliases).filter(([, id]) => measured.has(id)),
  ),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
process.stderr.write(
  `\nperf: ${cells.length} cell(s), ${pairs.length} pair(s) in ${doc.wallSeconds} s -> ${OUT}\n` +
    `perf: host ${doc.host.id}; baselines/hosts/${doc.host.id}/ is where it is committed\n`,
);
