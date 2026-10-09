/**
 * Re-derive a committed sweep's paired inference: every metric of every arm
 * against a reference arm, with the Holm-adjusted p beside the raw one, and
 * the guard verdict on intervals beside the point-mean one.
 *
 * `sweep.ts` prints the same tables at the end of a run. This reads them back
 * out of `tools/comparison/results/` without re-scoring anything, and it can
 * change the reference: EXPERIMENTS.md §13.2 compares every tier with code 2
 * rather than with the sweep's first row, and its intervals had no command
 * that reproduced them until this one. `--baseline-from` takes the reference
 * arm from a second committed result scored over the same images, paired by
 * image name: §7.12's equal-quality saving pairs a `final-candidates-holdout`
 * arm with a `budget-ladder-tuned-holdout` one.
 *
 * Usage:
 *   node dist/arms.js <result> [--baseline LABEL [--baseline-from RESULT]]
 *   node dist/arms.js --summary [<result>...]
 *   node dist/arms.js --seed-sensitivity [--seeds N] [<result>...]
 *   node dist/arms.js --resample-change [--from B] [<result>...]
 *
 * `--summary` tallies, over every committed sweep, how many arms differ from
 * their incumbent on ΔE00 before and after Holm, and how the interval guard
 * verdict compares with the point-mean one. `--seed-sensitivity` re-derives
 * every committed ΔE00 interval against its incumbent under N other bootstrap
 * seeds (default 20) and reports how far the bounds move and whether any
 * verdict turns: the check `stats.ts`'s fixed seed is documented against.
 * `--resample-change` re-derives the same intervals at an earlier resample
 * count (default 1,000, what the intervals were drawn at until
 * {@link BOOTSTRAP_RESAMPLES}) and at the current one, and counts the arms
 * whose interval changes whether it excludes zero. All three are recorded in
 * EXPERIMENTS.md §13.5.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type InferenceSummary,
  addSummaries,
  compareArms,
  type GuardVerdict,
  formatArmTables,
  guardVerdictOnIntervals,
  pairedDeltas,
  summarizeInference,
} from "./arms-core.ts";
import {
  type GuardTolerances,
  type PerImage,
  type PerImageKey,
  RESULTS_DIR,
  type ResultFile,
  type ResultRow,
  guardsHold,
  readResult,
  summarize,
} from "./results.ts";
import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  bootstrapCI,
  bootstrapP,
  holm,
} from "./stats.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    baseline: { type: "string" },
    "baseline-from": { type: "string" },
    from: { type: "string", default: "1000" },
    "resample-change": { type: "boolean", default: false },
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
} else if (values["resample-change"]) {
  resampleChange();
} else if (values.summary) {
  summary();
} else {
  report();
}

/**
 * A row of `source` with every per-image series reordered to `dest`'s image
 * list, so it pairs positionally with `dest`'s arms. Fails fast unless the two
 * results scored exactly the same images: a pairing over a partial overlap
 * would be a different sample from either sweep's.
 */
function realign(
  row: ResultRow,
  source: ResultFile,
  dest: ResultFile,
  sourceName: string,
): ResultRow {
  const at = new Map(source.imageNames.map((n, i) => [n, i]));
  const same =
    source.imageNames.length === dest.imageNames.length &&
    dest.imageNames.every((n) => at.has(n));
  if (!same) {
    console.error(
      `${sourceName} and ${dest.name} did not score the same images; a paired comparison needs both sides on every image`,
    );
    process.exit(2);
  }
  const perImage: PerImage = {};
  for (const [key, series] of Object.entries(row.perImage) as [
    PerImageKey,
    (number | null)[],
  ][]) {
    perImage[key] = dest.imageNames.map((n) => series[at.get(n) ?? -1] ?? null);
  }
  return { ...row, label: `${sourceName}: ${row.label}`, perImage };
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
  const from = values["baseline-from"];
  if (from !== undefined && values.baseline === undefined) {
    console.error("--baseline-from names a result; --baseline names its arm");
    process.exit(2);
  }
  if (values.baseline !== undefined) {
    const source = from === undefined ? file : load(from);
    const want = normalize(values.baseline);
    const found = source.rows.findIndex((r) => normalize(r.label) === want);
    if (found < 0) {
      console.error(
        `no arm labelled ${JSON.stringify(values.baseline)} in ${from ?? name}; arms are:\n  ${source.rows.map((r) => r.label).join("\n  ")}`,
      );
      process.exit(2);
    }
    baseIndex = found;
    const row = source.rows[found];
    if (from !== undefined && row) {
      file.rows.push(realign(row, source, file, from));
      baseIndex = file.rows.length - 1;
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
 * A sweep's arms as paired ΔE00 deltas against its incumbent (row 0), each
 * kept with its own label so an arm dropped for having no ΔE00 pairs cannot
 * shift the label a later one is reported under. Null for a result that is not
 * a sweep (rd-budget's formats at budgets have no incumbent).
 */
function incumbentSeries(
  file: ResultFile,
): { label: string; deltas: number[] }[] | null {
  if (file.tool !== "sweep") return null;
  const base = file.rows[0]?.perImage.ciede2000;
  if (!base) return null;
  return file.rows
    .slice(1)
    .map((row) => ({
      label: row.label,
      deltas: pairedDeltas(row.perImage.ciede2000 ?? [], base).deltas,
    }))
    .filter((s) => s.deltas.length > 0);
}

/** Whether a paired interval excludes zero: the arm differs from its incumbent. */
function excludesZero(ci: [number, number]): boolean {
  return ci[0] > 0 || ci[1] < 0;
}

/**
 * What raising the interval resample count moved. Every committed ΔE00
 * interval against its incumbent, at the seed every document figure uses,
 * drawn at `--from` resamples and at {@link BOOTSTRAP_RESAMPLES}: the arms
 * whose interval changes whether it excludes zero, the largest move of either
 * bound, and how often "the interval excludes zero" and "raw p < 0.05" disagree
 * at each count. Then every sweep's guard verdict on intervals at both counts,
 * since a guard reads every guard metric's interval. The p-values and so the
 * Holm verdicts are drawn at {@link BOOTSTRAP_RESAMPLES} on both sides, so none
 * of those can move.
 */
function resampleChange(): void {
  const from = Number(values.from);
  if (!Number.isInteger(from) || from < 1) {
    console.error(`--from must be a positive integer; got ${values.from}`);
    process.exit(2);
  }
  const to = BOOTSTRAP_RESAMPLES;
  let arms = 0;
  let flips = 0;
  let worstShift = 0;
  let disagreeFrom = 0;
  let disagreeTo = 0;
  const flipped: string[] = [];
  console.log(
    `${"result".padEnd(36)} ${"arms".padStart(5)} ${"max |Δbound|".padStart(13)} ${"CI flips".padStart(9)} ${`CI≠p @${from}`.padStart(10)} ${`CI≠p @${to}`.padStart(11)}`,
  );
  for (const name of resultNames()) {
    const series = incumbentSeries(load(name));
    if (!series) continue;
    let shift = 0;
    let n = 0;
    let dFrom = 0;
    let dTo = 0;
    for (const { label, deltas } of series) {
      const before = bootstrapCI(deltas, from);
      const after = bootstrapCI(deltas, to);
      const significant = bootstrapP(deltas) < 0.05;
      shift = Math.max(
        shift,
        Math.abs(after[0] - before[0]),
        Math.abs(after[1] - before[1]),
      );
      if (excludesZero(before) !== excludesZero(after)) {
        n++;
        flipped.push(
          `${name}: "${label}" [${before[0].toFixed(3)}, ${before[1].toFixed(3)}] → [${after[0].toFixed(3)}, ${after[1].toFixed(3)}]`,
        );
      }
      if (excludesZero(before) !== significant) dFrom++;
      if (excludesZero(after) !== significant) dTo++;
    }
    arms += series.length;
    flips += n;
    worstShift = Math.max(worstShift, shift);
    disagreeFrom += dFrom;
    disagreeTo += dTo;
    console.log(
      `${name.padEnd(36)} ${String(series.length).padStart(5)} ${shift.toFixed(4).padStart(13)} ${String(n).padStart(9)} ${String(dFrom).padStart(10)} ${String(dTo).padStart(11)}`,
    );
  }
  console.log(
    `\n${arms} ΔE00 intervals against their incumbent, seed ${BOOTSTRAP_SEED}, re-derived at ${from} and at ${to} resamples:` +
      `\n  largest move of either bound  ${worstShift.toFixed(4)} ΔE00` +
      `\n  arms whose interval turns on whether it excludes zero  ${flips}` +
      `\n  arms whose interval and raw p (at ${to}) disagree on 0.05: ${disagreeFrom} at ${from}, ${disagreeTo} at ${to}` +
      `\n  arms whose Holm verdict turns  0 (the p-values are drawn at ${to} on both sides)`,
  );
  for (const f of flipped) console.log(`    ${f}`);

  let guarded = 0;
  const moved: string[] = [];
  const tally = (vs: GuardVerdict[]) =>
    `${vs.filter((v) => v === "ok").length} ok / ${vs.filter((v) => v === "inconclusive").length} inconclusive / ${vs.filter((v) => v === "FAIL").length} FAIL`;
  const allFrom: GuardVerdict[] = [];
  const allTo: GuardVerdict[] = [];
  for (const name of resultNames()) {
    const file = load(name);
    const tol = file.settings.guardTolerances as GuardTolerances | undefined;
    if (file.tool !== "sweep" || !tol) continue;
    const rise =
      (file.settings.artifactGuardRise as number | null) ?? undefined;
    const before = compareArms(file.rows, 0, from);
    const after = compareArms(file.rows, 0, to);
    for (const [i, cmp] of after.entries()) {
      const a = guardVerdictOnIntervals(before[i], tol, rise);
      const b = guardVerdictOnIntervals(cmp, tol, rise);
      guarded++;
      allFrom.push(a);
      allTo.push(b);
      if (a !== b) moved.push(`${name}: "${cmp.label}" ${a} → ${b}`);
    }
  }
  console.log(
    `\n${guarded} guard verdicts on intervals (guards (CI)), against the incumbent:` +
      `\n  at ${from}: ${tally(allFrom)}` +
      `\n  at ${to}: ${tally(allTo)}` +
      `\n  arms whose verdict changes  ${moved.length}`,
  );
  for (const m of moved) console.log(`    ${m}`);
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
    const series = incumbentSeries(load(name));
    if (!series) continue;
    const deltas = series.map((s) => s.deltas);
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
        const ci = bootstrapCI(d, BOOTSTRAP_RESAMPLES, 0.05, seed);
        const move = Math.max(
          Math.abs(ci[0] - ref[0]),
          Math.abs(ci[1] - ref[1]),
        );
        shift = Math.max(shift, move);
        const width = ref[1] - ref[0];
        if (width > 0) relative = Math.max(relative, move / width);
        if (excludesZero(ci) !== excludesZero(ref)) ciFlip.add(i);
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
    `\n${arms} ΔE00 intervals at ${BOOTSTRAP_RESAMPLES} resamples, each re-derived under ${seeds.length} seeds other than ${BOOTSTRAP_SEED}:` +
      `\n  largest move of either bound  ${worstShift.toFixed(4)} ΔE00` +
      `\n  as a fraction of the interval's width  ${(worstRelative * 100).toFixed(1)}%` +
      `\n  arms whose interval turns on whether it excludes zero  ${ciFlips}` +
      `\n  arms whose Holm verdict (α = 0.05) turns  ${holmFlips}`,
  );
  for (const f of flipped) console.log(`    ${f}`);
}
