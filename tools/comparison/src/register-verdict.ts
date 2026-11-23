/**
 * Print a frozen register entry's verdict, as `register-verdict-core.ts`
 * derives it from the committed holdout results: R1's conditions 1–3 for each
 * judged comparison, the stratum rule on a holdout3 result, condition 4 across
 * other bootstrap seeds, and C1's ThumbHash admission. Re-scores nothing.
 *
 * Usage:
 *   node dist/register-verdict.js C1|C2|D1 [--seeds N]
 */

import { parseArgs } from "node:util";
import { FREEZE_REVS, FROZEN, deriveVerdict } from "./register-verdict-core.ts";
import { BOOTSTRAP_SEED } from "./stats.ts";
import { WINDOW_FROZEN, deriveWindowVerdict } from "./window-core.ts";

const signed = (x: number, digits: number): string =>
  `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;

function main(): void {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { seeds: { type: "string", default: "20" } },
  });
  const id = positionals[0] ?? "";
  const seedCount = Number(values.seeds);
  const known = (FROZEN[id] ?? WINDOW_FROZEN[id]) !== undefined;
  if (!known || !Number.isInteger(seedCount) || seedCount < 0) {
    console.error(
      `usage: register-verdict ${[...Object.keys(FROZEN), ...Object.keys(WINDOW_FROZEN)].join("|")} [--seeds N]`,
    );
    process.exit(2);
  }
  if (WINDOW_FROZEN[id]) {
    printWindowVerdict(id, seedCount);
    return;
  }

  const v = deriveVerdict(id, seedCount);
  console.log(
    `${id}: ${v.comparisons.length} judged comparisons, Holm across all of them (results at ${(FREEZE_REVS[id] ?? "").slice(0, 7)}, clean)`,
  );
  for (const l of v.comparisons) {
    const ci = l.stat.ci.map((x) => signed(x, 3)).join(", ");
    const yes = (b: boolean): string => (b ? "yes" : "no");
    console.log(
      `  ${l.arm} vs ${l.base} [${l.result}]\n` +
        `    ΔE00 ${signed(l.stat.meanDelta, 3)} [${ci}] = ${signed(l.rel, 2)}%  p ${l.stat.p.toFixed(4)}  p Holm ${l.atFloor ? "≤ " : ""}${l.pHolm.toFixed(4)}  guards (CI) ${l.guards}\n` +
        `    median ΔE00 ${l.medians[0].toFixed(3)} vs ${l.medians[1].toFixed(3)}\n` +
        `    R1: (1) ≥3% lower ${yes(l.r1.lower3)}  (2) Holm ${yes(l.r1.holm)}  (3) guards ok ${yes(l.r1.guardsOk)}`,
    );
    if (l.strata) {
      console.log(
        `    stratum rule: ${l.strata.fails ? "a stratum fails" : "no stratum fails"}`,
      );
      for (const s of l.strata.strata) {
        const sci = s.deltaE.ci.map((x) => signed(x, 3)).join(", ");
        console.log(
          `      ${s.stratum.padEnd(15)} n ${String(s.n).padStart(2)}  ΔE00 ${signed(s.deltaE.meanDelta, 3)} [${sci}] (lower ${signed(s.lowerRel, 2)}%)  guards (CI) ${s.guards}  ${s.verdict}`,
        );
      }
    }
  }
  console.log(
    `  ${v.comparisons.filter((l) => l.r1.pass).length} of ${v.comparisons.length} clear R1's conditions 1-3 (and the stratum rule, on holdout3) at seed ${BOOTSTRAP_SEED}`,
  );

  if (v.seeds.length > 0) {
    for (const t of v.turned) {
      console.log(`    seed ${t.seed}: ${t.arm} vs ${t.base} turns`);
    }
    console.log(
      `  Condition 4: under ${v.seeds.length} seeds other than ${BOOTSTRAP_SEED}, ${v.turned.length} R1 outcome(s) turn (entry-family Holm and guard intervals, against the named baselines)`,
    );
  }

  if (v.admission) {
    console.log(
      "\n  ThumbHash admission [rd-budget-holdout2]: ChromaHash@21B against ThumbHash (the criterion is point means; the paired interval is reported beside it)",
    );
    for (const m of v.admission.metrics) {
      console.log(
        `    ${m.key.padEnd(12)} ${m.ours.toFixed(4)} vs ${m.theirs.toFixed(4)}  ${m.wins ? "beats" : "does not beat"}  paired Δ [${signed(m.ci[0], 4)}, ${signed(m.ci[1], 4)}] ${m.excludesZero ? "excludes zero" : "includes zero"}`,
      );
    }
    console.log(
      `  Admission ${v.admission.holds ? "holds: beats ThumbHash on all four metric means" : "fails: not all four"}`,
    );
  }
}

/**
 * A window entry (D3) is judged under R2 with an artifact primary
 * (`window-core.ts`): each frozen arm's spurious detail against shipped code
 * 2, its ΔE00 non-inferiority and guards against its tier's shipped arm, the
 * stratum rule, and condition 4. No Holm adjustment applies.
 */
function printWindowVerdict(id: string, seedCount: number): void {
  const v = deriveWindowVerdict(id, seedCount);
  const yes = (b: boolean): string => (b ? "yes" : "no");
  const iv = (s: { meanDelta: number; ci: [number, number] }): string =>
    `${signed(s.meanDelta, 3)} [${s.ci.map((x) => signed(x, 3)).join(", ")}]`;
  console.log(
    `${id}: ${v.readings.length} frozen arm(s), R2 with an artifact primary, no Holm (results at ${(FREEZE_REVS[id] ?? "").slice(0, 7)}, clean) [${v.result}]`,
  );
  for (const r of v.readings) {
    const margin = (100 * r.delta.ci[1]) / r.delta.baseMean;
    console.log(
      `  ${r.spec.arm} vs ${r.spec.incumbent} (spurious vs ${r.spec.floor})\n` +
        `    spurious ${iv(r.spurious)}  ΔE00 ${iv(r.delta)} = ${signed(r.deltaRel, 2)}% (upper ${signed(margin, 2)}%)  guards (CI) ${r.guards}\n` +
        `    R2: primary (spurious upper ≤ 0) ${yes(r.primary)}  (1) ΔE00 upper ≤ +1.0% ${yes(r.cond1)}  (2) guards ok ${yes(r.guardsOk)}`,
    );
    const fails = r.strata?.some((s) => s.verdict === "FAIL") ?? false;
    console.log(
      `    stratum rule: ${fails ? "a stratum fails" : "no stratum fails"}`,
    );
    for (const s of r.strata ?? []) {
      console.log(
        `      ${s.stratum.padEnd(15)} n ${String(s.n).padStart(2)}  ΔE00 ${iv(s.deltaE)} (lower ${signed(s.lowerRel, 2)}%)  guards (CI) ${s.guards}  ${s.verdict}  spurious ${s.spurious ? iv(s.spurious) : "—"}`,
      );
    }
  }
  console.log(
    `  ${v.readings.filter((r) => r.pass).length} of ${v.readings.length} pass R2's primary and conditions 1-2 and the stratum rule at seed ${BOOTSTRAP_SEED}`,
  );
  if (v.seeds.length > 0) {
    for (const t of v.turned) console.log(`    seed ${t.seed}: ${t.arm} turns`);
    console.log(
      `  Condition 4: under ${v.seeds.length} seeds other than ${BOOTSTRAP_SEED}, ${v.turned.length} outcome(s) turn (overall or in a stratum)`,
    );
  }
}

main();
