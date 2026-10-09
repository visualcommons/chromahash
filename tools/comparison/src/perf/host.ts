/**
 * The measuring host: who it is, and whether it is fit to measure on right now.
 *
 * The driver used to record five facts about the host — os, arch, CPU model,
 * core count, node — and check none. Load, the frequency governor, boost and
 * SMT, which decide whether a wall-clock figure is about the code or about the
 * machine, were neither controlled nor written down, so a run taken at load 30
 * and one taken idle were indistinguishable in the committed file. Now the
 * driver reads them before measuring, refuses a loaded host unless told
 * otherwise, and records what it saw; a run that was forced past the load bar
 * is marked, and the gate will not take it as a baseline.
 *
 * Nothing here needs root and nothing changes the host. Setting the governor to
 * `performance` and turning boost off are root-only and are documented in
 * PERFORMANCE.md §0 rather than automated: a benchmark driver that runs sudo is
 * a benchmark driver nobody should run.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import * as os from "node:os";

/**
 * The 1-minute load average above which the driver refuses to start: one
 * runnable task per eight hardware threads, and never below 1. Every harness
 * but the `threads=auto` batch cells is single-threaded, so at the bar at least
 * seven of every eight threads are idle; the host this document was measured
 * on passed §0's 10% stability bar at a load of about 1.5–2.0 on 16 threads,
 * which this admits, and failed it at 17, which this refuses.
 */
export function defaultMaxLoad(cores: number): number {
  return Math.max(1, cores / 8);
}

/** One value if every CPU agrees, `mixed: a, b` otherwise, null if none read. */
export function summarize(values: readonly string[]): string | null {
  const distinct = [...new Set(values.map((v) => v.trim()))].sort();
  if (distinct.length === 0) return null;
  return distinct.length === 1
    ? (distinct[0] as string)
    : `mixed: ${distinct.join(", ")}`;
}

export type Loadavg = [number, number, number];

export interface Preflight {
  /** 1-, 5- and 15-minute load averages when the run started. */
  loadavgStart: Loadavg | null;
  /**
   * The same at the start of each process round, after any wait: the gate holds
   * every one to the bar, so a run that starts quiet and becomes loaded fails.
   */
  loadavgRounds: (Loadavg | null)[];
  /**
   * At the end. Recorded, not held to the bar: it trails the run's own last
   * minutes, which can include the `threads=auto` batch cells, so it says more
   * about this sweep than about anything else on the host.
   */
  loadavgEnd: Loadavg | null;
  /**
   * Seconds spent waiting for the load to fall under the bar (`--wait-for-load`)
   * before the start and before each round, in that order; empty if no wait.
   */
  waitedSeconds: number[];
  maxLoad: number;
  /** Started above `maxLoad` because `--force-loaded` said to. Not a baseline. */
  loaded: boolean;
  governor: string | null;
  /** `on`, `off`, `mixed: …` or null where the platform exposes no switch. */
  boost: string | null;
  boostSource: string | null;
  smt: string | null;
  scalingDriver: string | null;
  energyPerformancePreference: string | null;
  /** Things a quiet-host run should not have, reported but not refused. */
  warnings: string[];
}

const SYS_CPU = "/sys/devices/system/cpu";

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function perCpu(file: string): string[] {
  let names: string[];
  try {
    names = readdirSync(SYS_CPU).filter((n) => /^cpu[0-9]+$/.test(n));
  } catch {
    return [];
  }
  return names
    .map((n) => read(`${SYS_CPU}/${n}/cpufreq/${file}`))
    .filter((v): v is string => v !== null);
}

/**
 * The 1-, 5- and 15-minute load averages, rounded as `/proc/loadavg` writes
 * them. `os.loadavg()` reads `/proc/loadavg` on Linux and `vm.loadavg` on macOS,
 * so the preflight and the gate's load check work on both; Windows has no load
 * average and reports zeros, which would read as an idle host, so it is null.
 */
export function readLoadavg(
  platform: string = process.platform,
  sample: () => number[] = os.loadavg,
): Loadavg | null {
  if (platform === "win32") return null;
  const l = sample();
  if (l.length < 3 || !l.slice(0, 3).every(Number.isFinite)) return null;
  const r = (x: number) => Math.round(x * 100) / 100;
  return [r(l[0] as number), r(l[1] as number), r(l[2] as number)];
}

export interface LoadWait {
  /** Under the bar (or unreadable) before the timeout. */
  ok: boolean;
  waitedMs: number;
  /** The last reading taken. */
  load: Loadavg | null;
}

/**
 * Poll the 1-minute load average until it is at or under `maxLoad`, or until
 * `timeoutMs` has passed.
 *
 * Load is the one host property the person running a sweep can fix by waiting,
 * and the sweep itself is what most often needs waiting out: the 1-minute
 * average decays with a one-minute time constant, so it stays above the bar for
 * a minute or two after `build:benchmark`, and after a round's `threads=auto`
 * batch cells put a runnable thread on every core. Refusing there stopped
 * `benchmark:session` at its second sweep. A host with no load average to read
 * is not waited on: there is nothing to wait for.
 *
 * Pure apart from the injected clock, sleep and reader, so the selftest can
 * drive it without waiting.
 */
export async function waitForLoad(o: {
  maxLoad: number;
  timeoutMs: number;
  pollMs?: number;
  read?: () => Loadavg | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called before each sleep with the reading and the time waited so far. */
  onWait?: (load1: number, waitedMs: number) => void;
}): Promise<LoadWait> {
  const read = o.read ?? (() => readLoadavg());
  const sleep =
    o.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = o.now ?? Date.now;
  const poll = o.pollMs ?? 10_000;
  const start = now();
  for (;;) {
    const load = read();
    const waitedMs = now() - start;
    if (load === null || load[0] <= o.maxLoad) {
      return { ok: true, waitedMs, load };
    }
    if (waitedMs >= o.timeoutMs) return { ok: false, waitedMs, load };
    o.onWait?.(load[0], waitedMs);
    await sleep(Math.min(poll, o.timeoutMs - waitedMs));
  }
}

/**
 * Boost, wherever this kernel exposes it: the global cpufreq switch
 * (acpi-cpufreq, and amd-pstate in passive mode), intel_pstate's inverted
 * `no_turbo`, or amd-pstate's per-policy `boost`.
 */
function readBoost(): { value: string | null; source: string | null } {
  const global = read(`${SYS_CPU}/cpufreq/boost`);
  if (global !== null) {
    return {
      value: global === "1" ? "on" : "off",
      source: `${SYS_CPU}/cpufreq/boost`,
    };
  }
  const noTurbo = read(`${SYS_CPU}/intel_pstate/no_turbo`);
  if (noTurbo !== null) {
    return {
      value: noTurbo === "1" ? "off" : "on",
      source: `${SYS_CPU}/intel_pstate/no_turbo`,
    };
  }
  const per = perCpu("boost").map((v) => (v === "1" ? "on" : "off"));
  return per.length > 0
    ? { value: summarize(per), source: `${SYS_CPU}/cpu*/cpufreq/boost` }
    : { value: null, source: null };
}

/**
 * Read the host's state. The load average is read on Linux and macOS; the
 * cpufreq fields are Linux's sysfs and null elsewhere.
 */
export function readPreflight(
  maxLoad: number,
  forceLoaded: boolean,
): Preflight {
  const load = readLoadavg();
  const boost = readBoost();
  const smtRaw = read(`${SYS_CPU}/smt/active`);
  const p: Preflight = {
    loadavgStart: load,
    loadavgRounds: [],
    loadavgEnd: null,
    waitedSeconds: [],
    maxLoad,
    loaded: false,
    governor: summarize(perCpu("scaling_governor")),
    boost: boost.value,
    boostSource: boost.source,
    smt: smtRaw === null ? null : smtRaw === "1" ? "on" : "off",
    scalingDriver: summarize(perCpu("scaling_driver")),
    energyPerformancePreference: summarize(
      perCpu("energy_performance_preference"),
    ),
    warnings: [],
  };
  return judgePreflight(p, forceLoaded);
}

/**
 * Decide whether to start, and say what is wrong with the host. Only load is
 * refused, because only load is a property of *now* that the person running the
 * sweep can fix by waiting; the governor and boost need root, so they are
 * reported and left to §0's documented steps.
 */
export function judgePreflight(p: Preflight, forceLoaded: boolean): Preflight {
  const warnings: string[] = [];
  const load1 = p.loadavgStart?.[0];
  const over = load1 !== undefined && load1 > p.maxLoad;
  if (over) {
    warnings.push(
      `1-minute load average ${load1.toFixed(2)} is above ${p.maxLoad.toFixed(2)}`,
    );
  }
  // amd-pstate and intel_pstate in active mode take their policy from the
  // energy-performance preference, and their `powersave` governor is not the
  // legacy one; `performance` is still the only setting that pins the request.
  if (p.governor !== null && p.governor !== "performance") {
    warnings.push(`cpufreq governor is ${p.governor}, not performance`);
  }
  if (p.boost !== null && p.boost !== "off") {
    warnings.push(
      `boost is ${p.boost}: clocks follow temperature, so a long sweep drifts`,
    );
  }
  if (p.smt === "on") {
    warnings.push(
      "SMT is on: pin with --pin to one thread per core, or a sibling's load lands on the harness",
    );
  }
  return { ...p, loaded: over && forceLoaded, warnings };
}

/** Whether the run may start. */
export const mayStart = (p: Preflight, forceLoaded: boolean): boolean => {
  const load1 = p.loadavgStart?.[0];
  return forceLoaded || load1 === undefined || load1 <= p.maxLoad;
};

/**
 * A host's key: the directory its baselines live in. OS, architecture and CPU
 * model, slugged — the three facts every committed run has recorded since the
 * first, so the existing baseline has a key without being edited.
 */
export function hostKey(env: {
  os?: string;
  arch?: string;
  cpuModel?: string;
}): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/\(r\)|\(tm\)/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return [env.os ?? "unknown", env.arch ?? "unknown", env.cpuModel ?? "unknown"]
    .map(slug)
    .join("-");
}

/**
 * Two machines with one CPU model are two hosts. A short, one-way hash of
 * `/etc/machine-id` (or the hostname where there is none) tells them apart
 * without publishing either.
 */
export function machineId(): string {
  const raw = read("/etc/machine-id") ?? os.hostname();
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

export function rustcVersion(cwd: string): string | null {
  try {
    return execFileSync("rustc", ["--version"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
