/**
 * Print a frozen register entry's verdict, as `register-verdict-core.ts`
 * derives it from the committed holdout results: R1's conditions 1–3 for each
 * judged comparison, the stratum rule on a holdout3 result, condition 4 across
 * other bootstrap seeds, and C1's ThumbHash admission. A window entry (D3)
 * is judged under R2 with an artifact primary instead (`window-core.ts`).
 * Re-scores nothing.
 *
 * Usage:
 *   node dist/register-verdict.js C1|C2|D1|D3|D4|D5|D6|D9 [--seeds N]
 *
 * D4 rests on counts rather than intervals (`dct-identity-core.ts`), and D9
 * on its tune oracle bound, a mean of per-image minima
 * (`cfl-oracle-core.ts`), so `--seeds` applies to neither.
 */

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { D9_BAR, D9_RULE_REV, readD9 } from "./cfl-oracle-core.ts";
import { SPEED_THRESHOLD, deriveD4Verdict } from "./dct-identity-core.ts";
import { D5_FROZEN, deriveD5Verdict } from "./downsample-core.ts";
import { FREEZE_REVS, FROZEN, deriveVerdict } from "./register-verdict-core.ts";
import { REPO_ROOT, RESULTS_DIR, readResult } from "./results.ts";
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
  if (id === "D9") {
    printD9Verdict();
    return;
  }
  const known =
    id === "D4" ||
    (id === "D5" && D5_FROZEN !== null) ||
    (FROZEN[id] ?? WINDOW_FROZEN[id]) !== undefined;
  if (!known || !Number.isInteger(seedCount) || seedCount < 0) {
    console.error(
      `usage: register-verdict ${[...Object.keys(FROZEN), "D4", ...(D5_FROZEN ? ["D5"] : []), ...Object.keys(WINDOW_FROZEN), "D9"].join("|")} [--seeds N]`,
    );
    process.exit(2);
  }
  if (id === "D4") {
    printD4Verdict();
    return;
  }
  if (WINDOW_FROZEN[id]) {
    printWindowVerdict(id, seedCount);
    return;
  }
  if (id === "D5") {
    printD5Verdict(seedCount);
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

/**
 * D5, downsampling before the transform (`downsample-core.ts`): R2 with a
 * speed primary at every tier. Each frozen arm's ΔE00 non-inferiority and
 * guards against its tier's full-resolution incumbent, the stratum rule and
 * condition 4 from the holdout3 read; the speed from the count record.
 */
function printD5Verdict(seedCount: number): void {
  const v = deriveD5Verdict(seedCount);
  const yes = (b: boolean): string => (b ? "yes" : "no");
  const iv = (s: { meanDelta: number; ci: [number, number] }): string =>
    `${signed(s.meanDelta, 3)} [${s.ci.map((x) => signed(x, 3)).join(", ")}]`;
  console.log(
    `D5: ${v.readings.length} frozen arms, one per tier, R2 with a speed primary in retired instructions, no Holm (results at ${(FREEZE_REVS.D5 ?? "").slice(0, 7)}, clean) [${v.result}]`,
  );
  for (const p of v.speed.pairs) {
    console.log(
      `  speed ${v.speed.candidate} vs ${p.label}: ${p.ratio.toFixed(3)}× instructions (blocks ${p.min.toFixed(3)}–${p.max.toFixed(3)}; runs ${p.runRatios.map((r) => r.toFixed(4)).join(" / ")}, agree within 1% ${yes(p.agree)})  ≥ ${SPEED_THRESHOLD.toFixed(1)}× ${yes(p.pass)}`,
    );
  }
  for (const r of v.readings) {
    console.log(
      `  ${r.spec.arm} vs ${r.spec.incumbent}\n` +
        `    ΔE00 ${iv(r.delta)} = ${signed(r.deltaRel, 2)}% (upper ${signed(r.upperRel, 2)}%)  guards (CI) ${r.guards}\n` +
        `    R2: (1) ΔE00 upper ≤ +1.0% ${yes(r.cond1)}  (2) guards ok ${yes(r.guardsOk)}`,
    );
    const fails = r.strata?.some((s) => s.verdict === "FAIL") ?? false;
    console.log(
      `    stratum rule: ${fails ? "a stratum fails" : "no stratum fails"}`,
    );
    for (const s of r.strata ?? []) {
      console.log(
        `      ${s.stratum.padEnd(15)} n ${String(s.n).padStart(2)}  ΔE00 ${iv(s.deltaE)} (lower ${signed(s.lowerRel, 2)}%)  guards (CI) ${s.guards}  ${s.verdict}`,
      );
    }
  }
  console.log(
    `  ${v.readings.filter((r) => r.pass).length} of ${v.readings.length} tiers pass conditions 1-2 and the stratum rule at seed ${BOOTSTRAP_SEED}; speed ${v.speed.pass ? "passes" : "fails"}`,
  );
  if (v.seeds.length > 0) {
    for (const t of v.turned) console.log(`    seed ${t.seed}: ${t.arm} turns`);
    console.log(
      `  Condition 4: under ${v.seeds.length} seeds other than ${BOOTSTRAP_SEED}, ${v.turned.length} outcome(s) turn (overall or in a stratum)`,
    );
  }
  console.log(`  outcome: D5 ${v.pass ? "passes" : "fails"}`);
}

/**
 * D9, chroma-from-luma in an adaptive or conditional form, is decided on tune
 * by its oracle bound (`cfl-oracle-core.ts`): at each code, the mean of each
 * image's best of the shipped arm and the free CfL arms against the shipped
 * mean, overall and in each class the decoder recovers from the hash. The
 * bound is a mean of per-image minima, so no bootstrap seed moves it and
 * `--seeds` does not apply. The result must be clean and scored at a rev that
 * descends from the commit that fixed D9's rule.
 */
function printD9Verdict(): void {
  const file = readResult(RESULTS_DIR, "cfl-oracle");
  if (!file) {
    console.error("no committed result cfl-oracle — run the sweep");
    process.exit(1);
  }
  const rev = file.provenance.rev ?? "";
  const descends =
    spawnSync("git", ["merge-base", "--is-ancestor", D9_RULE_REV, rev], {
      cwd: REPO_ROOT,
    }).status === 0;
  if (file.provenance.dirty !== false || !descends) {
    console.error(
      `cfl-oracle was not scored from a clean tree at a rev that descends from D9's rule (${D9_RULE_REV.slice(0, 7)}): rev ${rev.slice(0, 7)}, dirty ${file.provenance.dirty}; refusing to derive a verdict from it`,
    );
    process.exit(1);
  }
  const v = readD9(file);
  console.log(
    `D9: the oracle bound on ${file.split} (${file.imageNames.length} images, results at ${rev.slice(0, 7)}, clean); a code is decided on the bound when it is under ${D9_BAR.toFixed(1)}% lower overall and in every recoverable class`,
  );
  for (const t of v.tiers) {
    console.log(
      `  code ${t.k}: ${t.decided ? "decided on the bound" : "the bound reaches 3%"}`,
    );
    for (const b of [t.overall, ...t.classes]) {
      console.log(
        `    ${b.group.padEnd(15)} n ${String(b.n).padStart(2)}  shipped ${b.shippedMean.toFixed(3)}  oracle ${b.oracleMean.toFixed(3)}  bound ${signed(b.rel, 2)}%  CfL lower on ${b.cflLower}  ${b.reaches ? "reaches 3%" : "under 3%"}`,
      );
    }
  }
  if (v.missing.length > 0) {
    console.log(`  codes not in the result: ${v.missing.join(", ")}`);
  }
  console.log(
    "  Condition 4: the bound is a mean of per-image minima, which no bootstrap seed moves",
  );
  console.log(
    `  outcome: ${v.decided ? "D9 is decided on the bound at every code; holdout3 is not read for D9" : "not decided on the bound alone: D9 registers deployable arms where the bound reaches 3%"}`,
  );
}

/**
 * D4, the separable forward DCT, rests on counts (`dct-identity-core.ts`):
 * the paired instruction ratio against both incumbents, the open-split and
 * vector identity count that selects it, and, once frozen, the holdout3
 * identity count. Identical hashes decode to identical pixels, so R2's
 * ΔE00, guard and seed conditions and the stratum rule hold exactly on a
 * zero count; there is no interval to re-draw. Before the freeze this
 * prints the selection alone.
 */
function printD4Verdict(): void {
  const rev = FREEZE_REVS.D4;
  const v = deriveD4Verdict(undefined, rev);
  const yes = (b: boolean): string => (b ? "yes" : "no");
  console.log(
    `D4: R2 with a speed primary in retired instructions; counts, not intervals${rev ? ` (holdout3 read at ${rev.slice(0, 7)}, clean)` : ""}`,
  );
  for (const p of v.speed.pairs) {
    console.log(
      `  speed vs ${p.label}: ${p.ratio.toFixed(3)}× instructions (blocks ${p.min.toFixed(3)}–${p.max.toFixed(3)}; runs ${p.runRatios.map((r) => r.toFixed(4)).join(" / ")}, agree within 1% ${yes(p.agree)})  ≥ ${SPEED_THRESHOLD.toFixed(1)}× ${yes(p.pass)}`,
    );
  }
  console.log(`  faster incumbent: ${v.speed.fasterIncumbent}`);
  const o = v.open;
  console.log(
    `  open splits and vectors: ${o.encodes} encode pairs, ${o.differing} image and ${o.vectorsDiffering} vector hashes differ, ${o.expectedMismatches} vectors off their expected hash, control seen ${yes(o.controlSeen)}`,
  );
  console.log(`  qualifies (selection on tune): ${yes(v.qualifies)}`);
  if (v.holdout3) {
    const h = v.holdout3;
    console.log(
      `  holdout3: ${h.encodes} encode pairs, ${h.differing} differ, control seen ${yes(h.controlSeen)}`,
    );
    for (const s of h.strata) {
      console.log(
        `    ${s.stratum.padEnd(15)} ${String(s.images).padStart(2)} images  ${String(s.encodes).padStart(4)} encodes  ${s.differing} differ`,
      );
    }
  }
  console.log(
    `  outcome: ${v.outcome ?? "qualifies; holdout3 not yet read (freeze first)"}`,
  );
}

main();
