/**
 * Apply a frozen register entry's comparisons to its committed holdout2
 * results, and print R1's conditions for each. `spec/V0.8-DECISIONS.md` names
 * every judged comparison and its baseline at the freeze; this reads them back
 * from `tools/comparison/results/` and re-scores nothing.
 *
 * Usage:
 *   node dist/register-verdict.js C1|C2 [--seeds N]
 *
 * R1, per comparison (arm against the named baseline, at equal bytes):
 *   1. mean ΔE00 at least 3.0% lower (point estimate);
 *   2. the paired ΔE00 difference significant at 0.05 after Holm across the
 *      entry's judged comparisons (the family the freeze names, not the sweep's
 *      arms: some of those are at another budget and are not judged);
 *   3. every guard `ok` on the paired intervals, at the tolerances the run
 *      recorded (`guardVerdictOnIntervals` — the rule `arms` prints for the
 *      incumbent, applied here to the named baseline. The freeze said
 *      conditions 1–3 "come from `mise run arms`", whose guard table covers
 *      row 0 only; applying the same rule to a named baseline was defined
 *      after the reads, and EXPERIMENTS.md §13.7 records it as a deviation);
 *   4. the R1 outcome of every comparison unchanged under N other bootstrap
 *      seeds (default 20), re-deriving p, the entry-family Holm and every guard
 *      interval against the same named baselines. `arms --seed-sensitivity`
 *      cannot do this: it compares every arm with row 0 across the sweep.
 *
 * Every result must carry the freeze's provenance — rev {@link FREEZE_REV} and
 * a clean tree — or this refuses to print a verdict from it.
 *
 * This is a reporter over the frozen instrument: it calls the same
 * `compareArms`, `holm` and bootstrap the sweeps use and changes no statistic.
 */

import path from "node:path";
import { parseArgs } from "node:util";
import {
  compareArms,
  guardVerdictOnIntervals,
  pairedDeltas,
  statFor,
} from "./arms-core.js";
import {
  type GuardTolerances,
  type ResultFile,
  readResult,
} from "./results.js";
import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  bootstrapCI,
  bootstrapP,
  holm,
} from "./stats.js";

/** The commit C1 and C2 froze at, and every holdout2 read was scored at. */
const FREEZE_REV = "2047f7df6f6e043b06f0676c7da9bc701fadaf46";

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
  if (file.provenance.rev !== FREEZE_REV || file.provenance.dirty !== false) {
    throw new Error(
      `${name} was not scored at the freeze from a clean tree (rev ${file.provenance.rev}, dirty ${file.provenance.dirty}); refusing to print a verdict from it`,
    );
  }
  return file;
}

function rowIndex(file: ResultFile, label: string): number {
  const i = file.rows.findIndex((r) => same(r.label, label));
  if (i < 0) throw new Error(`no arm ${JSON.stringify(label)} in ${file.name}`);
  return i;
}

function finite(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null && Number.isFinite(v));
}

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2
    ? (s[m] as number)
    : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

const signed = (x: number, digits: number): string =>
  `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;

/**
 * Condition 3 under `seed`: `guardVerdictOnIntervals`' rule, with each guard
 * interval re-drawn at `seed` against the named baseline.
 */
function guardsAtSeed(
  arm: ResultFile["rows"][number],
  base: ResultFile["rows"][number],
  tol: GuardTolerances,
  seed: number,
): "ok" | "inconclusive" | "FAIL" {
  const verdicts: string[] = [];
  const ssim = pairedDeltas(
    arm.perImage.ssimulacra2 ?? [],
    base.perImage.ssimulacra2 ?? [],
  );
  if (ssim.deltas.length > 0) {
    const [lo, hi] = bootstrapCI(ssim.deltas, BOOTSTRAP_RESAMPLES, 0.05, seed);
    const floor = -tol.ssimulacra2Drop;
    verdicts.push(lo >= floor ? "ok" : hi < floor ? "FAIL" : "inconclusive");
  }
  for (const key of ["butteraugli", "dssim"] as const) {
    const d = pairedDeltas(arm.perImage[key] ?? [], base.perImage[key] ?? []);
    if (d.deltas.length === 0) continue;
    const [lo, hi] = bootstrapCI(d.deltas, BOOTSTRAP_RESAMPLES, 0.05, seed);
    const margin = tol.relativeRise * mean(d.baseValues);
    verdicts.push(hi <= margin ? "ok" : lo > margin ? "FAIL" : "inconclusive");
  }
  if (verdicts.includes("FAIL")) return "FAIL";
  return verdicts.includes("inconclusive") ? "inconclusive" : "ok";
}

function main(): void {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { seeds: { type: "string", default: "20" } },
  });
  const id = positionals[0] ?? "";
  const frozen = FROZEN[id];
  const seedCount = Number(values.seeds);
  if (!frozen || !Number.isInteger(seedCount) || seedCount < 0) {
    console.error(
      `usage: register-verdict ${Object.keys(FROZEN).join("|")} [--seeds N]`,
    );
    process.exit(2);
  }

  const lines = frozen.map(([name, arm, base]) => {
    const file = load(name);
    const bi = rowIndex(file, base);
    const ai = rowIndex(file, arm);
    const cmp = compareArms(file.rows, bi).find((c) => same(c.label, arm));
    const s = statFor(cmp, "ciede2000");
    if (!s) throw new Error(`${arm} carries no ΔE00 in ${name}`);
    const tol = file.settings.guardTolerances as GuardTolerances;
    const rise =
      (file.settings.artifactGuardRise as number | null) ?? undefined;
    const armRow = file.rows[ai];
    const baseRow = file.rows[bi];
    if (!armRow || !baseRow) throw new Error(`rows missing in ${name}`);
    return {
      name,
      arm: arm.trim(),
      base,
      armRow,
      baseRow,
      tol,
      rel: (100 * s.meanDelta) / s.baseMean,
      s,
      medians: [
        median(finite(armRow.perImage.ciede2000 ?? [])),
        median(finite(baseRow.perImage.ciede2000 ?? [])),
      ] as const,
      guards: guardVerdictOnIntervals(cmp, tol, rise),
    };
  });

  const outcome = (
    rel: number,
    delta: number,
    pHolm: number,
    guards: string,
  ): boolean => rel <= -3 && pHolm < 0.05 && delta < 0 && guards === "ok";

  const adjusted = holm(lines.map((l) => l.s.p));
  console.log(
    `${id}: ${lines.length} judged comparisons, Holm across all of them (results at ${FREEZE_REV.slice(0, 7)}, clean)`,
  );
  const base42: boolean[] = [];
  for (const [k, l] of lines.entries()) {
    const pHolm = adjusted[k] ?? 1;
    const c1 = l.rel <= -3;
    const c2 = pHolm < 0.05 && l.s.meanDelta < 0;
    const c3 = l.guards === "ok";
    base42.push(outcome(l.rel, l.s.meanDelta, pHolm, l.guards));
    const ci = l.s.ci.map((x) => signed(x, 3)).join(", ");
    console.log(
      `  ${l.arm} vs ${l.base} [${l.name}]\n` +
        `    ΔE00 ${signed(l.s.meanDelta, 3)} [${ci}] = ${signed(l.rel, 2)}%  p ${l.s.p.toFixed(4)}  p Holm ${pHolm.toFixed(4)}  guards (CI) ${l.guards}\n` +
        `    median ΔE00 ${l.medians[0].toFixed(3)} vs ${l.medians[1].toFixed(3)}\n` +
        `    R1: (1) ≥3% lower ${c1 ? "yes" : "no"}  (2) Holm ${c2 ? "yes" : "no"}  (3) guards ok ${c3 ? "yes" : "no"}`,
    );
  }
  console.log(
    `  ${base42.filter(Boolean).length} of ${lines.length} clear R1's conditions 1-3 at seed ${BOOTSTRAP_SEED}`,
  );

  if (seedCount > 0) {
    const seeds: number[] = [];
    for (let s = 1; seeds.length < seedCount; s++) {
      if (s !== BOOTSTRAP_SEED) seeds.push(s);
    }
    let turned = 0;
    for (const seed of seeds) {
      const ps = lines.map((l) => {
        const d = pairedDeltas(
          l.armRow.perImage.ciede2000 ?? [],
          l.baseRow.perImage.ciede2000 ?? [],
        );
        return bootstrapP(d.deltas, BOOTSTRAP_RESAMPLES, seed);
      });
      const adj = holm(ps);
      for (const [k, l] of lines.entries()) {
        const g = guardsAtSeed(l.armRow, l.baseRow, l.tol, seed);
        if (outcome(l.rel, l.s.meanDelta, adj[k] ?? 1, g) !== base42[k]) {
          turned++;
          console.log(`    seed ${seed}: ${l.arm} vs ${l.base} turns`);
        }
      }
    }
    console.log(
      `  Condition 4: under ${seeds.length} seeds other than ${BOOTSTRAP_SEED}, ${turned} R1 outcome(s) turn (entry-family Holm and guard intervals, against the named baselines)`,
    );
  }

  if (id === "C1") {
    const file = load(ADMISSION.result);
    const ours = file.rows[rowIndex(file, ADMISSION.ours)];
    const theirs = file.rows[rowIndex(file, ADMISSION.theirs)];
    if (!ours || !theirs) throw new Error("admission rows missing");
    let all = true;
    console.log(
      `\n  ThumbHash admission [${file.name}]: ${ADMISSION.ours} against ${ADMISSION.theirs} (the criterion is point means; the paired interval is reported beside it)`,
    );
    for (const [key, better] of METRICS) {
      const a = mean(finite(ours.perImage[key] ?? []));
      const b = mean(finite(theirs.perImage[key] ?? []));
      const wins = better === "lower" ? a < b : a > b;
      all &&= wins;
      const d = pairedDeltas(
        ours.perImage[key] ?? [],
        theirs.perImage[key] ?? [],
      );
      const [lo, hi] = bootstrapCI(d.deltas);
      const decisive = better === "lower" ? hi < 0 : lo > 0;
      console.log(
        `    ${key.padEnd(12)} ${a.toFixed(4)} vs ${b.toFixed(4)}  ${wins ? "beats" : "does not beat"}  paired Δ [${signed(lo, 4)}, ${signed(hi, 4)}] ${decisive ? "excludes zero" : "includes zero"}`,
      );
    }
    console.log(
      `  Admission ${all ? "holds" : "fails"}: ${all ? "beats ThumbHash on all four metric means" : "not all four"}`,
    );
  }
}

main();
