/**
 * Reads a sweep's per-image scores against the corpus covariates, so a mean
 * over 31 photographs becomes a statement about *which* photographs.
 *
 * Every table in `EXPERIMENTS.md` is an aggregate. That is the right unit for
 * choosing a constant — the pre-registered rule is about mean ΔE00 on a holdout
 * split — and it is the wrong unit for the question a design round starts from,
 * which is not "how much does the format invent" but "invent *on what*". A mean
 * spurious score of 4.23 at code 4 on the pinned grid — 6.56 on that tier's own
 * raster — says the top tier asserts structure the original does not have. It
 * does not say whether that happens on the dense facade or on the near-flat
 * sky, and those two answers point at different changes to the format.
 *
 * The covariates are already measured and already committed: `natural-images.ts`
 * records mean L*, mean chroma C* and Laplacian detail energy per image, taken
 * on the same 512 px reference the harness scores against, because §9.1's corpus
 * audit needed them to choose the set. They are measured by
 * `corpus-covariates.ts --files` (#102), which defines each one.
 *
 * Usage:
 *   node dist/stratify.js <sweep> [--metric spurious|deficit|ringing|ciede]
 *                                 [--by detail|lightness|chroma]
 *                                 [--bins 3]
 */

import fs from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { compareArms, guardVerdictOnIntervals, statFor } from "./arms-core.ts";
import { holdout3Strata } from "./corpus.ts";
import { measureFile } from "./corpus-covariates.ts";
import { COUNTS_DIR } from "./dct-identity-core.ts";
import {
  type D5Speed,
  D5_PLACEMENTS,
  D5_TIERS,
  d5Arms,
  loadD5Count,
  readD5,
  readD5Speed,
  selectD5,
  selectionKey,
} from "./downsample-core.ts";
import { embeddedCuts, readCut, selectCuts } from "./embedded-core.ts";
import {
  WINDOW_FLOOR,
  readWindow,
  selectWindows,
  windowArms,
} from "./window-core.ts";
import { CURATED_IMAGES } from "./natural-images.ts";
import {
  holdout3StrataOf,
  otherSeeds,
  strataMembers,
  stratumRule,
} from "./register-verdict-core.ts";
import {
  type GuardTolerances,
  RESULTS_DIR,
  readResult,
  summarize,
} from "./results.ts";
import {
  BOOTSTRAP_SEED,
  type CorrelationInference,
  correlationInference,
  holm,
} from "./stats.ts";
import {
  alignmentError,
  equalCountBins,
  pearson,
  realCorpusOf,
  tierBaselinePairs,
} from "./stratify-core.ts";

/** The three covariates `natural-images.ts` records, parsed out of `notes`. */
interface Covariates {
  lightness: number;
  chroma: number;
  detail: number;
  axis: string;
}

/**
 * `notes` is prose with the numbers in it — "landscape, mean L* 40, mean C*
 * 6.9, detail 2.94". Parsed rather than restructured because the field is also
 * read by humans, and because a schema change here would touch all 39 entries
 * for no measurement gain.
 *
 * The trade that buys is a regex over prose a human is invited to edit, so the
 * failure is loud rather than quiet. An entry whose sentence stops matching
 * used to be skipped, which silently shrank the corpus every table here is
 * computed over: the bins would still be equal-count terciles, of a different
 * set, and nothing printed would say so. A caption reworded to "detail energy
 * 2.94" is enough to do it.
 */
function covariates(): Map<string, Covariates> {
  const out = new Map<string, Covariates>();
  const unparsed: string[] = [];
  for (const img of CURATED_IMAGES) {
    const l = /mean L\*\s*([\d.]+)/.exec(img.notes);
    const c = /mean C\*\s*([\d.]+)/.exec(img.notes);
    const d = /detail\s*([\d.]+)/.exec(img.notes);
    if (!l || !c || !d) {
      const missing = [
        l ? null : "mean L*",
        c ? null : "mean C*",
        d ? null : "detail",
      ].filter((x) => x !== null);
      unparsed.push(
        `${img.label}: no ${missing.join(", ")} in ${JSON.stringify(img.notes)}`,
      );
      continue;
    }
    out.set(img.label, {
      lightness: Number(l[1]),
      chroma: Number(c[1]),
      detail: Number(d[1]),
      axis: img.axis,
    });
  }
  if (unparsed.length > 0) {
    console.error(
      `${unparsed.length} curated image(s) carry covariates this tool cannot read:\n`,
    );
    for (const u of unparsed) console.error(`  ${u}`);
    console.error(
      "\nEvery table this tool prints is computed over the images it could read, so\n" +
        "a skipped entry silently changes the corpus rather than the output. Restore\n" +
        "the phrasing in natural-images.ts, or teach the regexes the new one.",
    );
    process.exit(1);
  }
  return out;
}

interface SweepRow {
  label: string;
  bytes: number | null;
  imageNames: string[];
  perImageCiede: (number | null)[];
  perImageSpurious: (number | null)[] | null;
  perImageDeficit: (number | null)[] | null;
  perImageRinging: (number | null)[] | null;
}

const METRICS = {
  spurious: (r: SweepRow) => r.perImageSpurious,
  deficit: (r: SweepRow) => r.perImageDeficit,
  ringing: (r: SweepRow) => r.perImageRinging,
  ciede: (r: SweepRow) => r.perImageCiede,
} as const;

type MetricName = keyof typeof METRICS;
type Axis = "detail" | "lightness" | "chroma";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    metric: { type: "string", default: "spurious" },
    by: { type: "string", default: "detail" },
    bins: { type: "string", default: "3" },
    strata: { type: "boolean", default: false },
    embedded: { type: "boolean", default: false },
    window: { type: "boolean", default: false },
    downsample: { type: "boolean", default: false },
  },
});

const sweepName = positionals[0];
if (!sweepName) {
  console.error(
    "usage: stratify <sweep> [--metric M] [--by AXIS] [--bins N] | stratify <sweep> --strata | stratify <sweep> --embedded | stratify <sweep> --window | stratify <sweep> --downsample",
  );
  process.exit(2);
}
if (values.strata) {
  await printStrata(sweepName);
  process.exit(0);
}
if (values.embedded) {
  await printEmbedded(sweepName);
  process.exit(0);
}
if (values.window) {
  await printWindow(sweepName);
  process.exit(0);
}
if (values.downsample) {
  await printDownsample(sweepName);
  process.exit(0);
}

/**
 * `--embedded`: register entry D2's reading of an `embedded-tiers-ladder`
 * result (`embedded-core.ts`). Each cut against native code k, with the same
 * run's gap from native k−1 to native k as its margin, overall and in each
 * holdout3 stratum, the strata found as `--strata` finds them. On tune it
 * also applies D2's selection rule; on tune the strata gate nothing.
 */
async function printEmbedded(name: string): Promise<void> {
  const file = readResult(RESULTS_DIR, name);
  if (!file) {
    console.error(`no committed result ${name} — run the sweep`);
    process.exit(1);
  }
  const strataOf =
    file.split === "holdout3"
      ? holdout3StrataOf
      : await measuredStrata(file.imageNames);
  const members = strataMembers(file.imageNames, strataOf);
  const tol = file.settings.guardTolerances as GuardTolerances;
  const rise = (file.settings.artifactGuardRise as number | null) ?? undefined;
  const sign = (x: number, d: number) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
  const pct = (x: number, base: number) => sign((100 * x) / base, 2);
  console.log(
    `${name} (${file.split}, ${file.imageNames.length} images): each cut against native code k; margin G = the same run's gap from native k-1 to native k`,
  );
  for (const [s, idx] of members) console.log(`  ${s}: ${idx.length} images`);
  const readings = embeddedCuts(file.rows).map((spec) =>
    readCut(spec, file.rows, tol, rise, members),
  );
  for (const r of readings) {
    const base = r.delta.baseMean;
    console.log(
      `\n${r.spec.cut} vs ${r.spec.native} (margin from ${r.spec.below})\n  ${"overall".padEnd(15)} n ${String(r.n).padStart(3)}  Δ ${sign(r.delta.meanDelta, 3)} [${sign(r.delta.ci[0], 3)}, ${sign(r.upper, 3)}] = ${pct(r.delta.meanDelta, base)}%  G ${sign(r.gapMean, 3)} = ${pct(r.gapMean, base)}%  U < G ${r.cond1 ? "yes" : "no"}  guards (CI) ${r.guards}  margin ${sign(r.marginRel, 2)}%  ${r.qualifies ? "qualifies" : "does not qualify"}`,
    );
    for (const s of r.strata ?? []) {
      console.log(
        `  ${s.stratum.padEnd(15)} n ${String(s.n).padStart(3)}  Δ ${sign(s.delta.meanDelta, 3)} [${sign(s.delta.ci[0], 3)}, ${sign(s.delta.ci[1], 3)}] = ${pct(s.delta.meanDelta, s.delta.baseMean)}%  G ${pct(s.gap.meanDelta, s.delta.baseMean)}%  guards (CI) ${s.guards}  ${s.verdict}${s.literalFails ? "  (+1.0% test: FAIL)" : ""}`,
      );
    }
  }
  if (file.split !== "holdout3") {
    const pick = selectCuts(readings);
    const list = (rs: readonly { spec: { cut: string } }[]) =>
      rs.map((r) => r.spec.cut).join(", ") || "none";
    console.log(
      `\nD2's selection rule: frozen ${list(pick.frozen)}; decided in sample (not qualifying) ${list(pick.notQualified)}; past the two-arm cap ${list(pick.capped)}`,
    );
    // Condition 4's reading of the selection: the same rule at other seeds
    // (the means are seed-free; the guard intervals are not).
    const key = (p: ReturnType<typeof selectCuts>) =>
      `${list(p.frozen)}|${list(p.notQualified)}|${list(p.capped)}`;
    const seeds = otherSeeds(20);
    const turned = seeds.filter(
      (seed) =>
        key(
          selectCuts(
            embeddedCuts(file.rows).map((spec) =>
              readCut(spec, file.rows, tol, rise, undefined, seed),
            ),
          ),
        ) !== key(pick),
    );
    console.log(
      `  under ${seeds.length} seeds other than ${BOOTSTRAP_SEED}, the selection changes at ${turned.length}${turned.length > 0 ? ` (seeds ${turned.join(", ")})` : ""}`,
    );
  }
}

/**
 * `--window`: register entry D3's reading of a `synthesis-window-codes34`
 * result (`window-core.ts`). Each window arm at code 3 or 4: its spurious
 * detail against shipped code 2 (the primary), and its ΔE00 and guards
 * against its own tier's shipped arm, overall, per corpus and in each
 * holdout3 stratum (the strata found as `--strata` finds them). On tune it
 * also applies D3's selection rule, and re-draws it under 20 other seeds; on
 * tune the corpora and strata gate nothing.
 */
async function printWindow(name: string): Promise<void> {
  const file = readResult(RESULTS_DIR, name);
  if (!file) {
    console.error(`no committed result ${name} — run the sweep`);
    process.exit(1);
  }
  const strataOf =
    file.split === "holdout3"
      ? holdout3StrataOf
      : await measuredStrata(file.imageNames);
  const members = strataMembers(file.imageNames, strataOf);
  const corpora = new Map<string, number[]>();
  for (const [i, n] of file.imageNames.entries()) {
    const c = realCorpusOf(n) ?? "other";
    corpora.set(`corpus ${c}`, [...(corpora.get(`corpus ${c}`) ?? []), i]);
  }
  const tol = file.settings.guardTolerances as GuardTolerances;
  const sign = (x: number, d: number) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
  const iv = (s: { meanDelta: number; ci: [number, number] }) =>
    `${sign(s.meanDelta, 3)} [${sign(s.ci[0], 3)}, ${sign(s.ci[1], 3)}]`;
  const pct = (x: number, base: number) => `${sign((100 * x) / base, 2)}%`;
  console.log(
    `${name} (${file.split}, ${file.imageNames.length} images): each window arm's spurious against ${WINDOW_FLOOR} (the primary, across byte counts) and its ΔE00 and guards against its tier's shipped arm`,
  );
  for (const [s, idx] of [...corpora, ...members]) {
    console.log(`  ${s}: ${idx.length} images`);
  }
  const specs = windowArms(file.rows);
  const readings = specs.map((spec) =>
    readWindow(spec, file.rows, tol, members),
  );
  for (const r of readings) {
    const perCorpus = readWindow(r.spec, file.rows, tol, corpora).strata ?? [];
    console.log(
      `\n${r.spec.arm} vs ${r.spec.incumbent} (spurious vs ${r.spec.floor})\n  ${"overall".padEnd(17)} n ${String(r.n).padStart(3)}  Spur ${iv(r.spurious)} ${r.primary ? "≤ 0" : "> 0"}  ΔE00 ${iv(r.delta)} = ${pct(r.delta.meanDelta, r.delta.baseMean)} (U ${pct(r.delta.ci[1], r.delta.baseMean)}) ${r.cond1 ? "≤ δ" : "> δ"}  guards (CI) ${r.guards}  ${r.qualifies ? "qualifies" : "does not qualify"}  ${r.pass ? "passes" : "fails"} on intervals`,
    );
    for (const s of [...perCorpus, ...(r.strata ?? [])]) {
      console.log(
        `  ${s.stratum.padEnd(17)} n ${String(s.n).padStart(3)}  Spur ${s.spurious ? iv(s.spurious) : "—"}  ΔE00 ${iv(s.deltaE)} = ${pct(s.deltaE.meanDelta, s.deltaE.baseMean)}  guards (CI) ${s.guards}  ${s.verdict}`,
      );
    }
  }
  if (file.split !== "holdout3") {
    const pick = selectWindows(readings);
    const key = (p: ReturnType<typeof selectWindows>) =>
      `${p.frozen.map((r) => r.spec.arm).join(", ") || "none"}|${p.decidedInSample.join(", ") || "none"}`;
    console.log(
      `\nD3's selection rule: frozen ${pick.frozen.map((r) => r.spec.arm).join(", ") || "none"}; codes decided in sample (no qualifying arm) ${pick.decidedInSample.join(", ") || "none"}`,
    );
    const seeds = otherSeeds(20);
    const turned = seeds.filter(
      (seed) =>
        key(
          selectWindows(
            specs.map((spec) =>
              readWindow(spec, file.rows, tol, undefined, seed),
            ),
          ),
        ) !== key(pick),
    );
    console.log(
      `  under ${seeds.length} seeds other than ${BOOTSTRAP_SEED}, the selection changes at ${turned.length}${turned.length > 0 ? ` (seeds ${turned.join(", ")})` : ""}`,
    );
  }
}

/**
 * `--downsample`: register entry D5's reading of a `downsample-before-dct`
 * result (`downsample-core.ts`). Each candidate arm at code k against
 * `tK full resolution`: its paired ΔE00 and the interval's upper bound
 * against +1.0%, and its guards, overall, per corpus and in each holdout3
 * stratum (the strata found as `--strata` finds them). On tune it also
 * applies D5's selection rule, with the speed read off the committed
 * `downsample-instructions` count when there is one, and re-draws the
 * selection under 20 other seeds; on tune the corpora and strata gate
 * nothing.
 */
async function printDownsample(name: string): Promise<void> {
  const file = readResult(RESULTS_DIR, name);
  if (!file) {
    console.error(`no committed result ${name} — run the sweep`);
    process.exit(1);
  }
  const strataOf =
    file.split === "holdout3"
      ? holdout3StrataOf
      : await measuredStrata(file.imageNames);
  const members = strataMembers(file.imageNames, strataOf);
  const corpora = new Map<string, number[]>();
  for (const [i, n] of file.imageNames.entries()) {
    const c = realCorpusOf(n) ?? "other";
    corpora.set(`corpus ${c}`, [...(corpora.get(`corpus ${c}`) ?? []), i]);
  }
  const tol = file.settings.guardTolerances as GuardTolerances;
  const sign = (x: number, d: number) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
  const iv = (s: { meanDelta: number; ci: [number, number] }) =>
    `${sign(s.meanDelta, 3)} [${sign(s.ci[0], 3)}, ${sign(s.ci[1], 3)}]`;
  const pct = (x: number, base: number) => `${sign((100 * x) / base, 2)}%`;
  console.log(
    `${name} (${file.split}, ${file.imageNames.length} images): each downsampling arm's ΔE00 and guards against its tier's full-resolution incumbent; condition 1 is the upper bound within +1.0%`,
  );
  for (const [s, idx] of [...corpora, ...members]) {
    console.log(`  ${s}: ${idx.length} images`);
  }
  const specs = d5Arms(file.rows);
  const readings = specs.map((spec) => readD5(spec, file.rows, tol, members));
  for (const r of readings) {
    const perCorpus = readD5(r.spec, file.rows, tol, corpora).strata ?? [];
    console.log(
      `\n${r.spec.arm} vs ${r.spec.incumbent}\n  ${"overall".padEnd(17)} n ${String(r.n).padStart(3)}  ΔE00 ${iv(r.delta)} = ${pct(r.delta.meanDelta, r.delta.baseMean)} (U ${sign(r.upperRel, 2)}%) ${r.cond1 ? "≤ δ" : "> δ"}  guards (CI) ${r.guards}  ${r.qualifies ? "qualifies" : "does not qualify"}  ${r.pass ? "passes" : "fails"} on intervals`,
    );
    for (const s of [...perCorpus, ...(r.strata ?? [])]) {
      console.log(
        `  ${s.stratum.padEnd(17)} n ${String(s.n).padStart(3)}  ΔE00 ${iv(s.deltaE)} = ${pct(s.deltaE.meanDelta, s.deltaE.baseMean)}  guards (CI) ${s.guards}  ${s.verdict}`,
      );
    }
  }
  if (file.split === "holdout3") return;
  let speed = new Map<string, D5Speed>();
  try {
    speed = readD5Speed(loadD5Count(COUNTS_DIR));
  } catch (e) {
    console.log(
      `\n(no readable downsample-instructions count: ${(e as Error).message}; the selection below has no speed)`,
    );
  }
  for (const [id, s] of speed) {
    console.log(
      `  speed ${id.padEnd(12)} ${s.pairs.map((p) => `${p.label} ${p.ratio.toFixed(3)}× (runs ${p.runRatios.map((x) => x.toFixed(4)).join(" / ")}${p.agree ? "" : ", DISAGREE"})`).join("  ")}  ≥ 2.0× both ${s.pass ? "yes" : "no"}`,
    );
  }
  const pick = selectD5(readings, speed);
  console.log("\nD5's selection rule:");
  for (const p of pick.placements) {
    console.log(
      `  ${p.placement.padEnd(6)} edges by tier ${D5_TIERS.map((k) => `t${k} ${p.edges[k] ?? "none"}`).join(", ")}  ${p.qualifies ? "qualifies" : "does not qualify"}${p.speed ? `  code-1 speed vs ACCEL_ALL ${p.speed.accelRatio.toFixed(3)}×` : ""}`,
    );
  }
  console.log(
    `  chosen ${pick.chosen ?? "none"} (ties to ${D5_PLACEMENTS[0]}); ${pick.outcome}${pick.frozen.length > 0 ? `: ${pick.frozen.map((f) => f.arm).join(", ")}` : ""}`,
  );
  const seeds = otherSeeds(20);
  const turned = seeds.filter(
    (seed) =>
      selectionKey(
        selectD5(
          specs.map((spec) => readD5(spec, file.rows, tol, undefined, seed)),
          speed,
        ),
      ) !== selectionKey(pick),
  );
  console.log(
    `  under ${seeds.length} seeds other than ${BOOTSTRAP_SEED}, the selection changes at ${turned.length}${turned.length > 0 ? ` (seeds ${turned.join(", ")})` : ""}`,
  );
}

/**
 * `--strata`: every arm against the first arm of its own tier (the tier's
 * incumbent, so a config that spans tiers is read at equal bytes), overall
 * and in each holdout3 stratum (`corpus.ts` `HOLDOUT3_STRATA`), under the
 * stratum rule's tests (`register-verdict-core.ts` `stratumRule`).
 *
 * A holdout3 result reads each image's strata off its pin. Any other split
 * has no pinned strata, so they are derived the way the pins' were: each
 * image's covariates are measured on its cached fixture
 * (`corpus-covariates.ts` `measureFile`), rounded to the pins' four places,
 * and placed by `holdout3Strata`. On tune this is reporting: the stratum rule
 * gates only a holdout3 read.
 */
async function printStrata(name: string): Promise<void> {
  const file = readResult(RESULTS_DIR, name);
  if (!file) {
    console.error(`no committed result ${name} — run the sweep`);
    process.exit(1);
  }
  const strataOf =
    file.split === "holdout3"
      ? holdout3StrataOf
      : await measuredStrata(file.imageNames);
  const members = strataMembers(file.imageNames, strataOf);
  const tol = file.settings.guardTolerances as GuardTolerances;
  const rise = (file.settings.artifactGuardRise as number | null) ?? undefined;
  const sign = (x: number, d: number) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
  console.log(
    `${name} (${file.split}, ${file.imageNames.length} images): each arm against the first arm of its tier, overall and per stratum`,
  );
  for (const [s, idx] of members) console.log(`  ${s}: ${idx.length} images`);
  for (const [ai, bi] of tierBaselinePairs(file.rows)) {
    const row = file.rows[ai];
    const base = file.rows[bi];
    if (!row || !base) continue;
    const [cmp] = compareArms([base, row], 0);
    const d = statFor(cmp, "ciede2000");
    if (!d) continue;
    console.log(
      `\n${row.label} vs ${base.label}\n  ${"overall".padEnd(15)} n ${String(file.imageNames.length).padStart(3)}  ΔE00 ${sign(d.meanDelta, 3)} [${sign(d.ci[0], 3)}, ${sign(d.ci[1], 3)}] = ${sign((100 * d.meanDelta) / d.baseMean, 2)}%  guards (CI) ${guardVerdictOnIntervals(cmp, tol, rise)}`,
    );
    for (const s of stratumRule(row, base, members, tol, rise).strata) {
      console.log(
        `  ${s.stratum.padEnd(15)} n ${String(s.n).padStart(3)}  ΔE00 ${sign(s.deltaE.meanDelta, 3)} [${sign(s.deltaE.ci[0], 3)}, ${sign(s.deltaE.ci[1], 3)}] = ${sign((100 * s.deltaE.meanDelta) / s.deltaE.baseMean, 2)}%  guards (CI) ${s.guards}  ${s.verdict}`,
      );
    }
  }
}

/** Each image's holdout3 strata, measured off its cached fixture. */
async function measuredStrata(
  names: readonly string[],
): Promise<(name: string) => readonly string[]> {
  const files = new Map<string, string>();
  for await (const f of glob(
    path.join(import.meta.dirname, "../fixtures/**/*.{png,jpg}"),
  )) {
    files.set(path.basename(f).replace(/\.[^.]+$/, ""), f);
  }
  const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const out = new Map<string, readonly string[]>();
  for (const name of names) {
    const f = files.get(name);
    if (!f) {
      console.error(`${name}: no cached fixture to measure — run the sweep`);
      process.exit(1);
    }
    const c = await measureFile(await fs.readFile(f));
    const corpus = realCorpusOf(name);
    if (corpus === null) {
      console.error(`${name}: in no real corpus, so it has no strata`);
      process.exit(1);
    }
    out.set(
      name,
      holdout3Strata({
        corpus,
        width: c.width,
        height: c.height,
        nonOpaqueFraction: round4(c.alpha?.nonOpaqueFraction ?? 0),
        phone: c.phone,
        meanL: round4(c.meanL),
        lowKey: round4(c.lowKey),
        skin: round4(c.skin),
      }),
    );
  }
  return (name) => out.get(name) ?? [];
}

const metric = values.metric as MetricName;
if (!(metric in METRICS)) {
  console.error(
    `unknown metric ${metric}; one of ${Object.keys(METRICS).join(", ")}`,
  );
  process.exit(2);
}
const axis = values.by as Axis;
if (!["detail", "lightness", "chroma"].includes(axis)) {
  console.error(`unknown axis ${axis}; one of detail, lightness, chroma`);
  process.exit(2);
}
// `--bins` is the one argument that reaches arithmetic rather than a lookup, so
// a bad value does not fail: `--bins 0` printed a header with no bins and
// `--bins abc` printed "NaN bins", both over a table of dashes and both exiting
// 0. Every other bad input in this file exits non-zero saying what was wrong,
// and a silent empty table is the failure mode this whole tool exists to
// prevent. The upper bound is the corpus: more bins than images cannot be
// equal-count, and two of them would be empty.
const binCount = Number(values.bins);
if (!Number.isInteger(binCount) || binCount < 2) {
  console.error(
    `--bins must be an integer of at least 2; got ${JSON.stringify(values.bins)}`,
  );
  process.exit(2);
}

// The committed result (results.ts), whose per-image series are the only thing
// this reads. A missing one is an error, not an empty table.
const result = readResult(RESULTS_DIR, sweepName);
if (!result) {
  console.error(
    `no ${path.relative(process.cwd(), path.join(RESULTS_DIR, `${sweepName}.json`))} — run the sweep`,
  );
  process.exit(1);
}
const sweep: { rows: SweepRow[] } = {
  rows: result.rows.map((r) => summarize(r, result.imageNames)),
};
const cov = covariates();

const AXIS_LABEL: Record<Axis, string> = {
  detail: "Laplacian detail energy",
  lightness: "mean L*",
  chroma: "mean C*",
};

console.log(
  `${sweepName}: ${metric} against ${AXIS_LABEL[axis]}, ${binCount} bins\n`,
);

// Bin edges come from the first row's images and are held fixed across rows, so
// every arm is reported over the same partition of the corpus. Recomputing them
// per row would let a bin's membership move between rows and silently turn a
// comparison of arms into a comparison of different image sets.
const firstRow = sweep.rows[0];
if (!firstRow) {
  console.error("sweep has no rows");
  process.exit(1);
}
// See `alignmentError`: every row is read positionally against the first row's
// image list, which sweep.ts guarantees today and nothing here requires.
const misaligned = alignmentError(sweep.rows);
if (misaligned !== null) {
  console.error(misaligned);
  process.exit(1);
}

// A row whose series is absent is "not measured", and skipping it printed a
// complete, plausible, EMPTY table and exited 0 — so a reader who ran this over
// a sweep written before `artifacts` existed read "no relationship on any arm"
// where the truth is "nobody measured it". `sweep.ts` is deliberate about the
// distinction on the way out (null, rather than an array of nulls, when a run
// scored no artifacts) and this contradicted it on the way back in. Same shape
// as `covariates()` above: name the sweep and the field, and exit non-zero.
const MISSING_FIELD: Record<MetricName, string> = {
  spurious: "perImageSpurious",
  deficit: "perImageDeficit",
  ringing: "perImageRinging",
  ciede: "perImageCiede",
};
const measured: { row: SweepRow; series: (number | null)[] }[] = [];
const unmeasured: SweepRow[] = [];
for (const row of sweep.rows) {
  const series = METRICS[metric](row);
  if (series) measured.push({ row, series });
  else unmeasured.push(row);
}
if (unmeasured.length > 0) {
  console.error(
    `\n${sweepName} carries no ${MISSING_FIELD[metric]} on ${unmeasured.length} of its ${sweep.rows.length} arm(s):\n`,
  );
  for (const r of unmeasured) console.error(`  ${r.label}`);
  console.error(
    "\nThat field is null when the run did not score the metric at all, which is not\n" +
      "the same as scoring it as nothing — every sweep run before `artifacts` existed\n" +
      'is in that state. Re-run the sweep with `"artifacts": true` in its config (and\n' +
      "`artifactGridEdge` too, if its arms decode at different rasters), or choose a\n" +
      "metric this sweep measured.",
  );
  process.exit(1);
}

const named = firstRow.imageNames
  .map((n, i) => ({ n, i, c: cov.get(n) }))
  .filter(
    (x): x is { n: string; i: number; c: Covariates } => x.c !== undefined,
  );

if (named.length === 0) {
  console.error(
    `none of this sweep's ${firstRow.imageNames.length} images are in the curated set — stratification needs the covariates natural-images.ts records, so this only applies to a photo-corpus sweep`,
  );
  process.exit(1);
}
if (named.length < firstRow.imageNames.length) {
  console.log(
    `  (${named.length} of ${firstRow.imageNames.length} images carry covariates; the rest are Kodak holdout or synthetic and are excluded)\n`,
  );
}

const sorted = [...named].sort((a, b) => a.c[axis] - b.c[axis]);
if (binCount > sorted.length) {
  console.error(
    `--bins ${binCount} over ${sorted.length} image(s) with covariates cannot be equal-count; at least one bin would be empty`,
  );
  process.exit(2);
}
const bins = equalCountBins(sorted, binCount);

const ranges = bins.map((b) => {
  const lo = b[0]?.c[axis];
  const hi = b[b.length - 1]?.c[axis];
  return lo === undefined || hi === undefined
    ? "—"
    : `${lo.toFixed(1)}–${hi.toFixed(1)}`;
});

const header = ["arm".padEnd(26), "bytes".padStart(6)]
  .concat(ranges.map((r, i) => `bin${i + 1} ${r}`.padStart(18)))
  .concat([
    "  r".padStart(7),
    "95% CI (Fisher z)".padStart(20),
    "p".padStart(8),
    "p Holm".padStart(8),
  ])
  .join("");
console.log(header);

// Computed for every arm first, so the arms' p-values can be adjusted as the
// family they are: a reader scans the r column for the arm where the
// relationship is strongest, which is five tests, not one.
const lines: { head: string; inference: CorrelationInference | null }[] = [];
for (const { row, series } of measured) {
  const cells: string[] = [];
  for (const bin of bins) {
    const vs = bin
      .map((x) => series[x.i])
      .filter((v): v is number => v !== null && v !== undefined);
    cells.push(
      (vs.length
        ? (vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(2)
        : "—"
      ).padStart(18),
    );
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const x of named) {
    const v = series[x.i];
    if (v === null || v === undefined) continue;
    xs.push(x.c[axis]);
    ys.push(v);
  }
  const r = pearson(xs, ys);
  lines.push({
    head:
      row.label.slice(0, 26).padEnd(26) +
      String(row.bytes ?? "—").padStart(6) +
      cells.join(""),
    inference: correlationInference(r, xs.length),
  });
}
const adjusted = holm(lines.map((l) => l.inference?.p ?? Number.NaN));
for (const [i, { head, inference }] of lines.entries()) {
  const signedR = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
  const ci = inference?.ci
    ? `[${signedR(inference.ci[0])}, ${signedR(inference.ci[1])}]`
    : "—";
  const p = adjusted[i];
  console.log(
    head +
      (inference ? signedR(inference.r).padStart(7) : "     —") +
      ci.padStart(20) +
      (inference ? inference.p.toFixed(4) : "—").padStart(8) +
      (p !== undefined && Number.isFinite(p) ? p.toFixed(4) : "—").padStart(8),
  );
}

// The threshold is a property of n, so it is the same for every arm whose
// series is complete; stated once, for the n the arms were computed over.
const ns = [...new Set(lines.map((l) => l.inference?.n))].filter(
  (n): n is number => n !== undefined,
);
const thresholds = ns
  .map((n) => {
    const t = correlationInference(0, n);
    return t ? `|r| ≥ ${t.rCritical.toFixed(3)} at n = ${n}` : null;
  })
  .filter((t): t is string => t !== null);

console.log(
  "\nBins are equal-count terciles of the tune corpus by the chosen axis, held " +
    "fixed across arms.\n`r` is Pearson over all images, reported beside the bins " +
    "rather than instead of them: with this many\nimages one coefficient is easy " +
    "to over-read, and the bin means say whether a relationship\nis monotone or " +
    "merely present. The interval is Fisher's z-transform, p is the t-test of",
);
console.log(
  `ρ = 0, and p Holm adjusts it across the ${lines.length} arms. Significant at α = 0.05, two-sided: ${thresholds.join("; ") || "—"}.`,
);
