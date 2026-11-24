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
 *   node dist/reproduce.js --strata    # each ΔE00 claim per holdout3 stratum
 *
 * `--strata` measures each image's strata off its cached fixture
 * (`measured-strata.ts`), so it needs the corpus on disk, which a run of the
 * sweeps fetches; nothing in CI runs it.
 */

import { parseArgs } from "node:util";
import { measuredStrata } from "./measured-strata.ts";
import { strataMembers } from "./register-verdict-core.ts";
import {
  LEDGER,
  REPRODUCED_SWEEPS,
  ledgerCells,
  readReproduction,
  signedFixed,
  sweepCells,
  sweepMovements,
} from "./reproduce-core.ts";
import { RESULTS_DIR, type ResultFile } from "./results.ts";

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
 * Each ΔE00 claim's arm against its base, overall and in every holdout3
 * stratum the re-run's images fall in, on the re-run at master. A claim whose
 * sign turns in some stratum is input-dependent: no later entry may inherit
 * it as a global gain.
 */
async function printStrata(): Promise<void> {
  const rows: string[] = [];
  const strataSeen = new Set<string>();
  const readings: {
    claim: string;
    overall: number;
    by: Map<string, { rel: number; n: number }>;
  }[] = [];
  const cache = new Map<string, ResultFile>();
  const seen = new Set<string>();
  for (const c of LEDGER) {
    if (c.kind !== "sweep" || !c.pair || c.pair.key !== "ciede2000") continue;
    // A Holm p and a Δ% on the same pair are one comparison per stratum.
    const pairKey = `${c.repro}\u0000${c.pair.arm}\u0000${c.pair.base}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    let run = cache.get(c.repro);
    if (!run) {
      const read = readReproduction(RESULTS_DIR, c.repro);
      if (!read) continue;
      run = read;
      cache.set(c.repro, run);
    }
    const arm = run.rows.find((r) => r.label === c.pair?.arm);
    const base = run.rows.find((r) => r.label === c.pair?.base);
    if (!arm || !base) continue;
    const members = strataMembers(
      run.imageNames,
      await measuredStrata(run.imageNames),
    );
    const rel = (idx: readonly number[]): number => {
      let a = 0;
      let b = 0;
      for (const i of idx) {
        const x = arm.perImage.ciede2000?.[i];
        const y = base.perImage.ciede2000?.[i];
        if (x == null || y == null) continue;
        a += x;
        b += y;
      }
      return b === 0 ? 0 : ((a - b) / b) * 100;
    };
    const by = new Map<string, { rel: number; n: number }>();
    for (const [s, idx] of members) {
      strataSeen.add(s);
      by.set(s, { rel: rel(idx), n: idx.length });
    }
    readings.push({
      claim: c.claim,
      overall: rel(run.imageNames.map((_, i) => i)),
      by,
    });
  }
  const strata = [...strataSeen];
  rows.push(
    `| claim | overall | ${strata.join(" | ")} | input-dependent |`,
    `|---|---|${strata.map(() => "---|").join("")}---|`,
  );
  for (const r of readings) {
    const flips = [...r.by.values()].some(
      (s) => Math.sign(s.rel) !== Math.sign(r.overall),
    );
    rows.push(
      `| ${r.claim} | ${signedFixed(r.overall, 2)}% | ${strata
        .map((s) => {
          const x = r.by.get(s);
          return x ? `${signedFixed(x.rel, 2)}% (${x.n})` : "—";
        })
        .join(" | ")} | ${flips ? "**yes**" : "no"} |`,
    );
  }
  console.log(`\n${rows.join("\n")}`);
}
