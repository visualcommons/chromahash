/**
 * Apply a frozen register entry's comparisons to its committed holdout2
 * results, and print R1's conditions for each. `spec/V0.8-DECISIONS.md` names
 * every judged comparison and its baseline at the freeze; this reads them back
 * from `tools/comparison/results/` and re-scores nothing.
 *
 * Usage:
 *   node dist/register-verdict.js C1|C2
 *
 * R1, per comparison (arm against the named baseline, at equal bytes):
 *   1. mean ΔE00 at least 3.0% lower (point estimate);
 *   2. the paired ΔE00 difference significant at 0.05 after Holm across the
 *      entry's judged comparisons (the family the freeze names, not the sweep's
 *      arms: some of those are at another budget and are not judged);
 *   3. every guard `ok` on the paired intervals, at the tolerances the run
 *      recorded (`guardVerdictOnIntervals`, the rule `arms` prints for the
 *      incumbent, applied here to the named baseline);
 *   4. seed stability, which `arms --seed-sensitivity` checks separately.
 *
 * This is a reporter over the frozen instrument: it calls the same
 * `compareArms` and `holm` the sweeps use and changes no statistic.
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { compareArms, guardVerdictOnIntervals, statFor } from "./arms-core.js";
import {
  type GuardTolerances,
  type ResultFile,
  readResult,
} from "./results.js";
import { holm } from "./stats.js";

/** [result, arm, baseline]: one judged comparison, as the freeze names it. */
type Comparison = readonly [string, string, string];

const PHOTO = "c1-confirm-photo-holdout2";
const ALPHA = "v07-holdout-alpha-holdout2";
const ALPHA_T1 = "alpha-tier1-holdout2";
const INCUMBENT = "SS10 constants (incumbent)";
const COMPACT = "compact 21B L19@4 C6@3";

/** The comparisons each entry froze (spec/V0.8-DECISIONS.md, C1 and C2). */
const FROZEN: Record<string, readonly Comparison[]> = {
  C1: [
    [PHOTO, "sel_hv=0.30", INCUMBENT],
    [PHOTO, "isotropic (aniso=0 hv=0)", INCUMBENT],
    [PHOTO, "pre-adoption v0.6-derived", INCUMBENT],
    [PHOTO, "sel_hv=0 aniso=1.2", INCUMBENT],
    [PHOTO, "compact 21B L18@4 C7@3", COMPACT],
    [PHOTO, "compact 21B L20@4 C5@3", COMPACT],
    [PHOTO, "compact 21B L26@3 C6@3", COMPACT],
    [PHOTO, "compact 21B shipped shape", COMPACT],
  ],
  C2: [
    [ALPHA, "ADOPTED A28@3 L22@4 C3@3", "SHIPPED A5@4 L20@5 C9@4"],
    [
      ALPHA,
      "compact 21B ADOPTED A16@3 L12@4 C1@3",
      "compact 21B shipped shape",
    ],
    [ALPHA, "+ alpha_ac_fit", "ADOPTED A28@3 L22@4 C3@3"],
    [ALPHA_T1, "A28@3 L22@4 C3@3 (t0 winner)", "SHIPPED A5@4 L20@5 C9@4"],
  ],
};

/** C1's ThumbHash admission: the shipped compact row against ThumbHash. */
const ADMISSION = {
  result: "rd-budget-holdout2",
  ours: "ChromaHash@21B",
  theirs: "ThumbHash",
} as const;

const METRICS = [
  ["ciede2000", "lower"],
  ["ssimulacra2", "higher"],
  ["butteraugli", "lower"],
  ["dssim", "lower"],
] as const;

const RESULTS_DIR = path.join(import.meta.dirname, "..", "results");
const same = (a: string, b: string): boolean => a.trim() === b.trim();

function load(name: string): ResultFile {
  const file = readResult(RESULTS_DIR, name);
  if (!file) throw new Error(`no committed result ${name}`);
  return file;
}

function rowIndex(file: ResultFile, label: string): number {
  const i = file.rows.findIndex((r) => same(r.label, label));
  if (i < 0) throw new Error(`no arm ${JSON.stringify(label)} in ${file.name}`);
  return i;
}

function mean(values: readonly (number | null)[]): number {
  const finite = values.filter((v): v is number => Number.isFinite(v));
  return finite.reduce((s, v) => s + v, 0) / finite.length;
}

function main(): void {
  const { positionals } = parseArgs({ allowPositionals: true });
  const id = positionals[0] ?? "";
  const frozen = FROZEN[id];
  if (!frozen) {
    console.error(`usage: register-verdict ${Object.keys(FROZEN).join("|")}`);
    process.exit(2);
  }

  const lines = frozen.map(([name, arm, base]) => {
    const file = load(name);
    const cmp = compareArms(file.rows, rowIndex(file, base)).find((c) =>
      same(c.label, arm),
    );
    const s = statFor(cmp, "ciede2000");
    if (!s) throw new Error(`${arm} carries no ΔE00 in ${name}`);
    const tol = file.settings.guardTolerances as GuardTolerances;
    const rise =
      (file.settings.artifactGuardRise as number | null) ?? undefined;
    return {
      name,
      arm: arm.trim(),
      base,
      rev: file.provenance.rev ?? "unknown",
      rel: (100 * s.meanDelta) / s.baseMean,
      s,
      guards: guardVerdictOnIntervals(cmp, tol, rise),
    };
  });
  const adjusted = holm(lines.map((l) => l.s.p));

  console.log(
    `${id}: ${lines.length} judged comparisons, Holm across all of them`,
  );
  let passes = 0;
  for (const [k, l] of lines.entries()) {
    const pHolm = adjusted[k] ?? 1;
    const c1 = l.rel <= -3;
    const c2 = pHolm < 0.05 && l.s.meanDelta < 0;
    const c3 = l.guards === "ok";
    if (c1 && c2 && c3) passes++;
    const ci = l.s.ci.map((x) => x.toFixed(3)).join(", ");
    console.log(
      `  ${l.arm} vs ${l.base} [${l.name} @ ${l.rev.slice(0, 7)}]\n` +
        `    ΔE00 ${l.s.meanDelta >= 0 ? "+" : ""}${l.s.meanDelta.toFixed(3)} [${ci}] = ${l.rel >= 0 ? "+" : ""}${l.rel.toFixed(2)}%  p ${l.s.p.toFixed(4)}  p Holm ${pHolm.toFixed(4)}  guards (CI) ${l.guards}\n` +
        `    R1: (1) ≥3% lower ${c1 ? "yes" : "no"}  (2) Holm ${c2 ? "yes" : "no"}  (3) guards ok ${c3 ? "yes" : "no"}`,
    );
  }
  console.log(
    `  ${passes} of ${lines.length} clear R1's conditions 1-3 (condition 4: arms --seed-sensitivity)`,
  );

  if (id === "C1") {
    const file = load(ADMISSION.result);
    const ours = file.rows[rowIndex(file, ADMISSION.ours)];
    const theirs = file.rows[rowIndex(file, ADMISSION.theirs)];
    if (!ours || !theirs) throw new Error("admission rows missing");
    let all = true;
    console.log(
      `\n  ThumbHash admission [${file.name} @ ${(file.provenance.rev ?? "unknown").slice(0, 7)}]: ${ADMISSION.ours} against ${ADMISSION.theirs}`,
    );
    for (const [key, better] of METRICS) {
      const a = mean(ours.perImage[key] ?? []);
      const b = mean(theirs.perImage[key] ?? []);
      const wins = better === "lower" ? a < b : a > b;
      all &&= wins;
      console.log(
        `    ${key.padEnd(12)} ${a.toFixed(4)} vs ${b.toFixed(4)}  ${wins ? "beats" : "does not beat"}`,
      );
    }
    console.log(
      `  Admission ${all ? "holds" : "fails"}: ${all ? "beats ThumbHash on all four metrics" : "not all four"}`,
    );
  }
}

main();
