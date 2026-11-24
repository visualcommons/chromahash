/**
 * Print the reproduction ledger `spec/EXPERIMENTS.md` §13.16 records (#130):
 * every committed re-run's per-image reading against its committed result,
 * and every load-bearing claim of {@link LEDGER} as recorded, as re-run and
 * with its status. `verify:experiments` binds both tables to the same
 * functions, so this is the generator and that is the check.
 *
 * It scores nothing: it reads the committed results and the committed re-runs
 * under `results/reproductions/`, which are `sweep`, `rd-budget` and
 * `entropy-budget` runs written there with `--out-dir` from a clean tree
 * (§6 lists the commands).
 *
 * Usage:
 *   node dist/reproduce.js             # both tables, as markdown
 *   node dist/reproduce.js --arms      # also every arm whose values moved
 *   node dist/reproduce.js --strata    # each comparison per holdout3 stratum
 *
 * `--strata` measures each image's strata off its cached fixture
 * (`measured-strata.ts`), so it needs the corpus on disk, which a run of the
 * sweeps fetches; nothing in CI runs it.
 */

import { parseArgs } from "node:util";
import { compareArms, statFor } from "./arms-core.ts";
import { measuredStrata } from "./measured-strata.ts";
import { strataMembers, subsetRow } from "./register-verdict-core.ts";
import {
  LEDGER,
  REPRODUCED_SWEEPS,
  ledgerCells,
  readReproduction,
  signedFixed,
  sweepCells,
  sweepMovements,
} from "./reproduce-core.ts";
import { RESULTS_DIR } from "./results.ts";
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED } from "./stats.ts";

const { values } = parseArgs({
  options: {
    arms: { type: "boolean", default: false },
    strata: { type: "boolean", default: false },
  },
});

const cellOf = (x: string | null | undefined): string => x ?? "—";

console.log(
  "| result | re-run | arms | values | moved at master | at master | at v1 |",
);
console.log("|---|---|---|---|---|---|---|");
for (const s of REPRODUCED_SWEEPS) {
  const c = sweepCells(RESULTS_DIR, s);
  console.log(
    `| \`${s.committed}\` | \`${s.repro}\` | ${c.master?.arms ?? "—"} | ${c.master?.compared ?? "—"} | ${c.master?.moved ?? "—"} | ${c.master?.status ?? "no re-run"} | ${s.v1 === undefined ? "—" : (c.v1?.status ?? "no re-run")} |`,
  );
}

console.log("");
console.log(
  "| claim | § | as recorded | at master | at v1 | status | command |",
);
console.log("|---|---|---|---|---|---|---|");
const cells = ledgerCells(RESULTS_DIR);
for (const claim of LEDGER) {
  const c = cells.get(claim.claim);
  console.log(
    `| ${claim.claim} | ${claim.section} | ${cellOf(c?.recorded)} | ${cellOf(c?.rerun)} | ${c?.v1 === undefined ? "—" : cellOf(c.v1)} | ${c?.status ?? "not reproduced"} | \`${claim.command}\` |`,
  );
}

if (values.arms) {
  for (const s of REPRODUCED_SWEEPS) {
    for (const v1 of [false, true]) {
      if (v1 && s.v1 === undefined) continue;
      const moved = sweepMovements(RESULTS_DIR, s, v1).filter(
        (m) => m.moved > 0,
      );
      if (moved.length === 0) continue;
      console.log(
        `\n${v1 ? "v1/" : ""}${v1 ? s.v1 : s.repro} against ${s.committed}:`,
      );
      for (const m of moved) {
        console.log(
          `  ${m.label}: ${m.moved} of ${m.compared} values moved (${m.keys.join(", ")}), largest ${m.maxRel.toExponential(2)} relative`,
        );
      }
    }
  }
}

if (values.strata) {
  await printStrata();
}

/**
 * Each comparison the ledger reads (every claim with a `pair`: the ΔE00
 * comparisons, the spurious-detail ones of §12.2 and §13.2, and the compact
 * tier against ThumbHash), overall and in every holdout3 stratum the re-run's
 * images fall in, on the re-run at master, as the relative change in the
 * pair's own metric. A comparison whose sign turns in some stratum is
 * input-dependent, and shown to be where that stratum holds two or more images
 * and its paired interval excludes zero on the other side: no later entry may
 * inherit it as a global gain. Each stratum is resampled as `stratumRule`
 * resamples it, so a ΔE00 row reads what `stratify --strata` would.
 */
async function printStrata(): Promise<void> {
  const strataSeen = new Set<string>();
  const readings: {
    label: string;
    metric: string;
    overall: number;
    by: Map<string, { rel: number; n: number; shown: boolean }>;
  }[] = [];
  const seen = new Set<string>();
  for (const c of LEDGER) {
    if (c.kind !== "sweep" || !c.pair) continue;
    const { arm, base, key } = c.pair;
    // A Holm p and a Δ% on the same pair are one comparison per stratum.
    const pairKey = `${c.repro}\u0000${arm}\u0000${base}\u0000${key}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const run = readReproduction(RESULTS_DIR, c.repro);
    const armRow = run?.rows.find((r) => r.label === arm);
    const baseRow = run?.rows.find((r) => r.label === base);
    if (!run || !armRow || !baseRow) continue;
    const members = strataMembers(
      run.imageNames,
      await measuredStrata(run.imageNames),
    );
    const overall = statFor(compareArms([baseRow, armRow])[0], key);
    if (!overall || overall.baseMean === 0) continue;
    const overallRel = (100 * overall.meanDelta) / overall.baseMean;
    const by = new Map<string, { rel: number; n: number; shown: boolean }>();
    for (const [stratum, idx] of members) {
      const s = statFor(
        compareArms(
          [subsetRow(baseRow, idx), subsetRow(armRow, idx)],
          0,
          BOOTSTRAP_RESAMPLES,
          BOOTSTRAP_SEED,
        )[0],
        key,
      );
      if (!s || s.baseMean === 0) continue;
      strataSeen.add(stratum);
      const rel = (100 * s.meanDelta) / s.baseMean;
      const turns = Math.sign(rel) !== Math.sign(overallRel);
      // One image has no interval: its bootstrap is that image every time.
      const shown =
        turns &&
        idx.length >= 2 &&
        (overallRel < 0 ? s.ci[0] > 0 : s.ci[1] < 0);
      by.set(stratum, { rel, n: idx.length, shown });
    }
    readings.push({
      label: `§${c.section} \`${arm.trim()}\` − \`${base.trim()}\``,
      metric: key === "ciede2000" ? "ΔE00" : key,
      overall: overallRel,
      by,
    });
  }
  const strata = [...strataSeen];
  const rows = [
    `| comparison | metric | overall | ${strata.join(" | ")} | input-dependent |`,
    `|---|---|---|${strata.map(() => "---|").join("")}---|`,
  ];
  for (const r of readings) {
    const turned = [...r.by.values()].filter(
      (s) => Math.sign(s.rel) !== Math.sign(r.overall),
    );
    const verdict =
      turned.length === 0
        ? "no"
        : turned.some((s) => s.shown)
          ? "**shown**"
          : "sign turns";
    rows.push(
      `| ${r.label} | ${r.metric} | ${signedFixed(r.overall, 2)}% | ${strata
        .map((s) => {
          const x = r.by.get(s);
          return x ? `${signedFixed(x.rel, 2)}% (${x.n})` : "—";
        })
        .join(" | ")} | ${verdict} |`,
    );
  }
  console.log(`\n${rows.join("\n")}`);
}
