/**
 * Re-derive a committed sweep's paired inference: every metric of every arm
 * against a reference arm, with the Holm-adjusted p beside the raw one, and
 * the guard verdict on intervals beside the point-mean one.
 *
 * `sweep.ts` prints the same tables at the end of a run. This reads them back
 * out of `tools/comparison/results/` without re-scoring anything, and it can
 * change the reference: EXPERIMENTS.md §13.2 compares every tier with code 2
 * rather than with the sweep's first row, and its intervals had no command
 * that reproduced them until this one.
 *
 * Usage:
 *   node dist/arms.js <result> [--baseline LABEL]
 *   node dist/arms.js --summary [<result>...]
 *   node dist/arms.js --seed-sensitivity [--seeds N] [<result>...]
 *
 * `--summary` tallies, over every committed sweep, how many arms differ from
 * their incumbent on ΔE00 before and after Holm, and how the interval guard
 * verdict compares with the point-mean one. `--seed-sensitivity` re-derives
 * every committed ΔE00 interval against its incumbent under N other bootstrap
 * seeds (default 20) and reports how far the bounds move and whether any
 * verdict turns: the check `stats.ts`'s fixed seed is documented against. Both
 * are recorded in EXPERIMENTS.md §13.5.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type InferenceSummary,
  addSummaries,
  compareArms,
  formatArmTables,
  guardVerdictOnIntervals,
  pairedDeltas,
  summarizeInference,
} from "./arms-core.ts";
import {
  type GuardTolerances,
  RESULTS_DIR,
  type ResultFile,
  guardsHold,
  readResult,
  summarize,
} from "./results.ts";
import { BOOTSTRAP_SEED, bootstrapCI, bootstrapP, holm } from "./stats.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    baseline: { type: "string" },
    "seed-sensitivity": { type: "boolean", default: false },
    seeds: { type: "string", default: "20" },
    summary: { type: "boolean", default: false },
  },
});

/** Every committed result's name, or the ones named on the command line. */
function resultNames(): string[] {
  return positionals.length > 0
    ? positionals
    : readdirSync(RESULTS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
}

/** Loose label match, the same reduction `verify-experiments.ts` applies. */
const normalize = (s: string): string =>
  s
    .replace(/[*`]/g, "")
    .toLowerCase()
    .replace(/[−–—]/g, "-")
    .replace(/[^a-z0-9.+-]+/g, "");

function load(name: string): ResultFile {
  const file = readResult(RESULTS_DIR, name);
  if (!file) {
    console.error(
      `no ${path.relative(process.cwd(), path.join(RESULTS_DIR, `${name}.json`))} — run the sweep`,
    );
    process.exit(1);
  }
  return file;
}

if (values["seed-sensitivity"]) {
  seedSensitivity();
} else if (values.summary) {
  summary();
} else {
  report();
}

/**
 * What the new inference changes, across every committed sweep against its
 * incumbent: ΔE00 differences before and after Holm, and the interval guard
 * verdict against the point-mean one. rd-budget results are formats at
 * budgets rather than arms against an incumbent, and are skipped.
 */
function summary(): void {
  const line = (label: string, s: InferenceSummary) =>
    `${label.padEnd(36)} ${String(s.arms).padStart(5)} ${String(s.differs).padStart(11)} ${String(s.differsHolm).padStart(9)} ${String(s.guardsOk).padStart(6)} ${String(s.guardsInconclusive).padStart(7)} ${String(s.guardsFail).padStart(8)} ${String(s.meansOkCiNot).padStart(16)} ${String(s.meansFailCiNot).padStart(18)}`;
  console.log(
    `${"result".padEnd(36)} ${"arms".padStart(5)} ${"ΔE00 p<.05".padStart(11)} ${"Holm<.05".padStart(9)} ${"CI ok".padStart(6)} ${"incon.".padStart(7)} ${"CI FAIL".padStart(8)} ${"means ok→CI not".padStart(16)} ${"means FAIL→CI not".padStart(18)}`,
  );
  const all: InferenceSummary[] = [];
  for (const name of resultNames()) {
    const s = summarizeInference(load(name));
    if (!s) continue;
    all.push(s);
    console.log(line(name, s));
  }
  console.log(line("total", addSummaries(all)));
}

function report(): void {
  const name = positionals[0];
  if (!name) {
    console.error(
      "usage: arms <result> [--baseline LABEL] | arms --seed-sensitivity [--seeds N] [<result>]",
    );
    process.exit(2);
  }
  const file = load(name);
  let baseIndex = 0;
  if (values.baseline !== undefined) {
    const want = normalize(values.baseline);
    baseIndex = file.rows.findIndex((r) => normalize(r.label) === want);
    if (baseIndex < 0) {
      console.error(
        `no arm labelled ${JSON.stringify(values.baseline)} in ${name}; arms are:\n  ${file.rows.map((r) => r.label).join("\n  ")}`,
      );
      process.exit(2);
    }
  }
  const base = file.rows[baseIndex];
  if (!base) {
    console.error(`${name} has no rows`);
    process.exit(1);
  }
  const comparisons = compareArms(file.rows, baseIndex);
  console.log(
    `${name} (${file.split} split, ${file.imageNames.length} images): ${comparisons.length} arm(s) against "${base.label}"`,
  );

  // Guards are defined against the sweep's own incumbent, at the tolerances
  // the run recorded; against any other reference they are not the run's
  // guards, so they are printed only for the incumbent.
  const tol = file.settings.guardTolerances as GuardTolerances | undefined;
  if (file.tool === "sweep" && baseIndex === 0 && tol) {
    const rise =
      (file.settings.artifactGuardRise as number | null) ?? undefined;
    const summaries = file.rows.map((r) => summarize(r, file.imageNames));
    const baseSummary = summaries[0];
    console.log(
      "\n  Guards against the incumbent: CI = on the paired intervals (only ok passes), means = the point-mean rule",
    );
    console.log(`  ${"Arm".padEnd(40)} ${"CI".padEnd(13)} means`);
    for (const [i, cmp] of comparisons.entries()) {
      const s = summaries[i + 1];
      if (!s || !baseSummary) continue;
      const onMeans = guardsHold(s, baseSummary, tol, rise) ? "ok" : "FAIL";
      console.log(
        `  ${cmp.label.slice(0, 40).padEnd(40)} ${guardVerdictOnIntervals(cmp, tol, rise).padEnd(13)} ${onMeans}`,
      );
    }
  }
  console.log(formatArmTables(base.label, comparisons));
}

/**
 * How much the fixed seed decides. For every committed sweep's arms against
 * their incumbent, the ΔE00 interval under `seeds` other seeds against the
 * seed-42 one every document figure uses: the largest move of either bound,
 * that move as a fraction of the interval's width, and the arms whose
 * "excludes zero" verdict differs under any seed. Holm verdicts are checked
 * the same way, over the p-values the adjustment is run on.
 */
function seedSensitivity(): void {
  const count = Number(values.seeds);
  if (!Number.isInteger(count) || count < 1) {
    console.error(`--seeds must be a positive integer; got ${values.seeds}`);
    process.exit(2);
  }
  // Seeds 1..count, skipping the default so every one is an alternative.
  const seeds: number[] = [];
  for (let s = 1; seeds.length < count; s++) {
    if (s !== BOOTSTRAP_SEED) seeds.push(s);
  }
  const names = resultNames();

  let arms = 0;
  let worstShift = 0;
  let worstRelative = 0;
  let ciFlips = 0;
  let holmFlips = 0;
  const flipped: string[] = [];
  console.log(
    `${"result".padEnd(36)} ${"arms".padStart(5)} ${"max |Δbound|".padStart(13)} ${"÷ width".padStart(8)} ${"CI flips".padStart(9)} ${"Holm flips".padStart(11)}`,
  );
  for (const name of names) {
    const file = load(name);
    if (file.tool !== "sweep") continue;
    const base = file.rows[0]?.perImage.ciede2000;
    if (!base) continue;
    // Keep each series' own row, so an arm dropped for having no ΔE00
    // pairs cannot shift the label a later flip is reported under.
    const series = file.rows
      .slice(1)
      .map((row) => ({
        label: row.label,
        deltas: pairedDeltas(row.perImage.ciede2000 ?? [], base).deltas,
      }))
      .filter((s) => s.deltas.length > 0);
    const deltas = series.map((s) => s.deltas);
    const excludes = (ci: [number, number]) => ci[0] > 0 || ci[1] < 0;
    const reference = deltas.map((d) => bootstrapCI(d));
    const holmAt = (seed: number) =>
      holm(deltas.map((d) => bootstrapP(d, undefined, seed))).map(
        (p) => p < 0.05,
      );
    const holmRef = holmAt(BOOTSTRAP_SEED);
    let shift = 0;
    let relative = 0;
    const ciFlip = new Set<number>();
    const holmFlip = new Set<number>();
    for (const seed of seeds) {
      for (const [i, d] of deltas.entries()) {
        const ref = reference[i];
        if (!ref) continue;
        const ci = bootstrapCI(d, 1000, 0.05, seed);
        const move = Math.max(
          Math.abs(ci[0] - ref[0]),
          Math.abs(ci[1] - ref[1]),
        );
        shift = Math.max(shift, move);
        const width = ref[1] - ref[0];
        if (width > 0) relative = Math.max(relative, move / width);
        if (excludes(ci) !== excludes(ref)) ciFlip.add(i);
      }
      const verdicts = holmAt(seed);
      for (const [i, v] of verdicts.entries()) {
        if (v !== holmRef[i]) holmFlip.add(i);
      }
    }
    for (const i of ciFlip) {
      flipped.push(`${name}: "${series[i]?.label}" (interval)`);
    }
    for (const i of holmFlip) {
      flipped.push(`${name}: "${series[i]?.label}" (Holm)`);
    }
    arms += deltas.length;
    worstShift = Math.max(worstShift, shift);
    worstRelative = Math.max(worstRelative, relative);
    ciFlips += ciFlip.size;
    holmFlips += holmFlip.size;
    console.log(
      `${name.padEnd(36)} ${String(deltas.length).padStart(5)} ${shift.toFixed(4).padStart(13)} ${`${(relative * 100).toFixed(1)}%`.padStart(8)} ${String(ciFlip.size).padStart(9)} ${String(holmFlip.size).padStart(11)}`,
    );
  }
  console.log(
    `\n${arms} ΔE00 intervals, each re-derived under ${seeds.length} seeds other than ${BOOTSTRAP_SEED}:` +
      `\n  largest move of either bound  ${worstShift.toFixed(4)} ΔE00` +
      `\n  as a fraction of the interval's width  ${(worstRelative * 100).toFixed(1)}%` +
      `\n  arms whose interval turns on whether it excludes zero  ${ciFlips}` +
      `\n  arms whose Holm verdict (α = 0.05) turns  ${holmFlips}`,
  );
  for (const f of flipped) console.log(`    ${f}`);
}
