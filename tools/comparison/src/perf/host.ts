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

/** `/proc/loadavg`'s first three fields, or null. */
export function parseLoadavg(
  text: string | null,
): [number, number, number] | null {
  if (text === null) return null;
  const f = text.trim().split(/\s+/).slice(0, 3).map(Number);
  return f.length === 3 && f.every(Number.isFinite)
    ? [f[0] as number, f[1] as number, f[2] as number]
    : null;
}

/** One value if every CPU agrees, `mixed: a, b` otherwise, null if none read. */
export function summarize(values: readonly string[]): string | null {
  const distinct = [...new Set(values.map((v) => v.trim()))].sort();
  if (distinct.length === 0) return null;
  return distinct.length === 1
    ? (distinct[0] as string)
    : `mixed: ${distinct.join(", ")}`;
}

export interface Preflight {
  /** 1-, 5- and 15-minute load averages when the run started. */
  loadavgStart: [number, number, number] | null;
  /** The same, at the start of each process round and at the end. */
  loadavgRounds: ([number, number, number] | null)[];
  loadavgEnd: [number, number, number] | null;
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

export function readLoadavg(): [number, number, number] | null {
  return parseLoadavg(read("/proc/loadavg"));
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

/** Read the host's state. Every field is null off Linux, where none of it exists. */
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
