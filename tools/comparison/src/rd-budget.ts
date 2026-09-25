/**
 * Cross-format rate–distortion at arbitrary byte budgets (R&D tool).
 *
 * `mise run compare:rd` scores the competing formats at the four *shipped* tier
 * anchors (32/108/411/1623 B). This script asks the prior question: what is the
 * right anchor at all? It scores ChromaHash across a continuous byte ladder —
 * resizing the AC layout through `CHROMAHASH_TUNE`, which the format supports
 * natively because its length is derived from the layout — against every other
 * LQIP and codec baseline at the *same* budgets, on the *same* corpus split as
 * `mise run sweep`, so a ladder row and a competitor row are directly comparable.
 *
 * Every run also emits the guard-aware summary (roadmap U16): a winner per
 * metric inside each byte neighbourhood, flagging where ChromaHash wins ΔE00
 * and loses SSIMULACRA2 / Butteraugli / DSSIM to the format it is beating.
 * `--summarize` recomputes that section from an already-written result, so the
 * cross-format scoring can be revisited without re-running the metrics.
 *
 * A full run writes `tools/comparison/results/<out>-<split>.json`, which is
 * committed: per-image scores and provenance, nothing derived (`results.ts`).
 * The summary is derived, so it is printed rather than stored. A run narrowed
 * by `--max-images` or `--formats` is not a result and goes to `output/sweeps/`.
 *
 * Usage:
 *   node dist/rd-budget.js [--split tune|holdout|all] [--budgets 16,21,24,32,...]
 *                          [--max-images N] [--out <name>] [--formats a,b,c]
 *                          [--out-dir DIR]
 *   node dist/rd-budget.js --summarize results/rd-budget-holdout.json
 *                          [--budgets 16,21,24,32,...]
 */

import fs from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { BlurHashAdapter } from "./adapters/blurhash.ts";
import {
  RUST_CLI,
  decodeViaRust,
  encodeViaRust,
} from "./adapters/chromahash.ts";
import { CodecThumbAdapter, isJxlAvailable } from "./adapters/codec-thumb.ts";
import { LqipModernAdapter } from "./adapters/lqip-modern.ts";
import { RawPixelsAdapter } from "./adapters/raw-pixels.ts";
import { ThumbHashAdapter } from "./adapters/thumbhash.ts";
import { type CorpusSplit, inCorpus, splitFor } from "./corpus.ts";
import { gamutToSrgbReference } from "./gamut.ts";
import { generateFixtures } from "./generate-fixtures.ts";
import { ensureHoldoutImages } from "./holdout-images.ts";
import { loadImage } from "./image-loader.ts";
import { computeAllMetrics, setScoringConfig } from "./metrics.ts";
import { ensureIqaAvailable, iqaVersionBanner } from "./metrics/iqa.ts";
import { ensureNaturalImages } from "./natural-images.ts";
import {
  type PerImage,
  RESULTS_DIR,
  RESULT_SCHEMA,
  type ResultFile,
  SCRATCH_DIR,
  captureProvenance,
  fileSha256,
  mean,
  perImageOf,
  readResult,
  repoRelative,
  resultPath,
  serializeResult,
  sha256,
  summarize,
} from "./results.ts";
import type { FormatAdapter, ImageInput } from "./types.ts";

/** Fixed bit prefix before the AC payload (descriptor+aspect+DC+scales). */
const PREFIX_BITS = 54;
/** Shipped tier-0 L:C coefficient-count ratio (26 luma : 9 per chroma channel). */
const SHIPPED_LC_RATIO = 26 / 9;
/** Bits per luma / per chroma AC coefficient in the shipped layout. */
const L_BITS = 5;
const C_BITS = 4;

/**
 * Byte anchors the format actually ships, mapped to their tier code. At these
 * budgets the comparison must run the shipped constants; anywhere else there is
 * no shipped layout to run and one is synthesized instead.
 */
const SHIPPED_ANCHORS = new Map<number, number>([
  [21, 0], // the compact tier
  [32, 1], // the default tier
  [108, 2],
  [411, 3],
  [1623, 4],
]);

/** Encoded length in bytes for a default-tier (nL, nC) AC layout. */
function bytesFor(nL: number, nC: number): number {
  return Math.ceil((PREFIX_BITS + nL * L_BITS + 2 * nC * C_BITS) / 8);
}

/**
 * The (nL, nC) layout that fills a byte budget exactly while staying closest to
 * the shipped L:C ratio. Returns null when the budget is below the 7-byte
 * prefix floor.
 */
function allocate(targetBytes: number): { nL: number; nC: number } | null {
  let best: { key: [number, number]; v: { nL: number; nC: number } } | null =
    null;
  for (let nC = 0; nC < 4000; nC++) {
    const base = Math.round(SHIPPED_LC_RATIO * nC);
    for (let nL = Math.max(0, base - 6); nL <= base + 6; nL++) {
      if (bytesFor(nL, nC) !== targetBytes) continue;
      const used = nL * L_BITS + 2 * nC * C_BITS;
      const dev = Math.abs((nC > 0 ? nL / nC : 1e9) - SHIPPED_LC_RATIO);
      const key: [number, number] = [-used, dev];
      if (
        best === null ||
        key[0] < best.key[0] ||
        (key[0] === best.key[0] && key[1] < best.key[1])
      ) {
        best = { key, v: { nL, nC } };
      }
    }
  }
  return best?.v ?? null;
}

/**
 * Quality tier to decode a coefficient count at. Selection draws only from the
 * candidate box of the encoding tier's own render, so the raster edge — which is
 * `32 << levelOf(code)`, one less than the returned code — has to clear the top
 * selected frequency index (~sqrt(4·nL/π)) with margin. Below that bound the
 * encoder is forced to substitute coefficients it would not otherwise pick
 * (§4.1); nothing is dropped at decode.
 */
const levelOf = (tier: number): number => Math.max(0, tier - 1);

function tierFor(nL: number): number {
  // Returns a tier *code*, not a render level: the codes are ordered by quality
  // and code 1 is level 0, so the code is the level plus one.
  for (let level = 0; level <= 3; level++) {
    const raster = 32 << level;
    if (raster >= 2.2 * Math.sqrt((4 * Math.max(nL, 1)) / Math.PI)) {
      return level + 1;
    }
  }
  return 4;
}

/** One scored row of the output table. */
interface Row {
  family: string;
  variant: string;
  targetBytes: number | null;
  /** CHROMAHASH_TUNE of a ChromaHash row; null for the shipped constants and other formats. */
  tune: string | null;
  /** Quality tier code of a ChromaHash row; null for other formats. */
  tier: number | null;
  images: number;
  bytes: number;
  ciede2000: number | null;
  ssimulacra2: number | null;
  butteraugli: number | null;
  dssim: number | null;
  /**
   * The per-image series, aligned with the corpus: null where this format could
   * not represent the budget on that image. What the committed result keeps.
   */
  perImage: PerImage;
}

const { values } = parseArgs({
  options: {
    split: { type: "string", default: "tune" },
    budgets: { type: "string" },
    formats: { type: "string" },
    "max-images": { type: "string" },
    out: { type: "string" },
    "out-dir": { type: "string" },
    summarize: { type: "string" },
  },
});

const splitArg = values.split ?? "tune";
if (splitArg !== "tune" && splitArg !== "holdout" && splitArg !== "all") {
  console.error(`invalid --split: ${splitArg}`);
  process.exit(1);
}
const DEFAULT_BUDGETS = [16, 21, 24, 32, 48, 64, 108, 192, 411, 1623];
const budgets = (values.budgets ?? DEFAULT_BUDGETS.join(","))
  .split(",")
  .map((s) => Number.parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);
const maxImages = values["max-images"]
  ? Number.parseInt(values["max-images"], 10)
  : null;
const formatFilter = values.formats
  ? new Set(values.formats.split(",").map((s) => s.trim().toLowerCase()))
  : null;

async function loadCorpus(): Promise<ImageInput[]> {
  const toolRoot = path.resolve(import.meta.dirname, "..");
  const syntheticDir = path.join(toolRoot, "fixtures/synthetic");
  try {
    const files = await fs.readdir(syntheticDir);
    if (files.length === 0) await generateFixtures();
  } catch {
    await generateFixtures();
  }
  await ensureNaturalImages();
  if (splitArg !== "tune") await ensureHoldoutImages();

  const paths: string[] = [];
  for await (const entry of glob(
    path.join(toolRoot, "fixtures/**/*.{png,jpg}"),
  )) {
    if (entry.endsWith(".png") || entry.endsWith(".jpg")) paths.push(entry);
  }
  paths.sort();

  const inputs: ImageInput[] = [];
  for (const filePath of paths) {
    const name = path.basename(filePath).replace(/\.[^.]+$/, "");
    if (!inCorpus(name, "photo")) continue;
    if (splitArg !== "all" && splitFor(name) !== (splitArg as CorpusSplit))
      continue;
    const input = await loadImage(filePath);
    input.gamut = "srgb";
    input.metricReferenceRgba = gamutToSrgbReference(
      input.referenceRgba,
      "srgb",
    );
    inputs.push(input);
  }
  return inputs;
}

/** Score one ChromaHash layout (encode + capped decode + metrics) per image. */
async function scoreChromaHash(
  label: string,
  targetBytes: number,
  /** CHROMAHASH_TUNE overrides, or null to run the shipped constants. */
  tune: string | null,
  tier: number,
  inputs: ImageInput[],
): Promise<Row> {
  const ciede: (number | null)[] = [];
  const ssim2: (number | null)[] = [];
  const butter: (number | null)[] = [];
  const dssim: (number | null)[] = [];
  const bytes: number[] = [];
  let bytesSum = 0;
  for (const input of inputs) {
    const { smallWidth: w, smallHeight: h, smallRgba: rgba } = input;
    const hash = encodeViaRust(
      RUST_CLI,
      w,
      h,
      rgba,
      "srgb",
      tier,
      tune ?? undefined,
    );
    bytesSum += hash.length;
    bytes.push(hash.length);
    const dec = decodeViaRust(RUST_CLI, hash, "srgb", w, h, tune ?? undefined);
    const { metrics } = await computeAllMetrics(
      input.metricReferenceRgba ?? input.referenceRgba,
      input.referenceWidth,
      input.referenceHeight,
      dec.rgba,
      dec.w,
      dec.h,
    );
    ciede.push(metrics.ciede2000);
    ssim2.push(metrics.ssimulacra2);
    butter.push(metrics.butteraugli);
    dssim.push(metrics.dssim);
  }
  return {
    family: "ChromaHash",
    variant: label,
    targetBytes,
    tune,
    tier,
    images: inputs.length,
    bytes: bytesSum / (inputs.length || 1),
    ciede2000: mean(ciede),
    ssimulacra2: mean(ssim2),
    butteraugli: mean(butter),
    dssim: mean(dssim),
    perImage: perImageOf({
      bytes,
      ciede2000: ciede,
      ssimulacra2: ssim2,
      butteraugli: butter,
      dssim,
    }),
  };
}

/** Score any FormatAdapter over the corpus; unrepresentable budgets return null. */
async function scoreAdapter(
  family: string,
  adapter: FormatAdapter,
  targetBytes: number | null,
  inputs: ImageInput[],
): Promise<Row | null> {
  const ciede: (number | null)[] = [];
  const ssim2: (number | null)[] = [];
  const butter: (number | null)[] = [];
  const dssim: (number | null)[] = [];
  const bytes: (number | null)[] = [];
  let bytesSum = 0;
  let scored = 0;
  for (const input of inputs) {
    try {
      const r = await adapter.process(input);
      bytesSum += r.encodedSizeBytes;
      bytes.push(r.encodedSizeBytes);
      ciede.push(r.metrics.ciede2000);
      ssim2.push(r.metrics.ssimulacra2);
      butter.push(r.metrics.butteraugli);
      dssim.push(r.metrics.dssim);
      scored++;
    } catch {
      // Budget unrepresentable for this codec on this image — skip it. The
      // per-image series keep a null in its place, so they stay aligned with
      // the corpus and the result shows which images a mean is over.
      for (const s of [bytes, ciede, ssim2, butter, dssim]) s.push(null);
    }
  }
  if (scored === 0) return null;
  return {
    family,
    variant: adapter.name,
    targetBytes,
    tune: null,
    tier: null,
    perImage: perImageOf({
      bytes,
      ciede2000: ciede,
      ssimulacra2: ssim2,
      butteraugli: butter,
      dssim,
    }),
    images: scored,
    bytes: bytesSum / scored,
    ciede2000: mean(ciede),
    ssimulacra2: mean(ssim2),
    butteraugli: mean(butter),
    dssim: mean(dssim),
  };
}

/**
 * Guard-aware cross-format scoring (roadmap U16).
 *
 * Every cross-format claim the project makes is ΔE00-only: ΔE00 is the format's
 * primary metric, and SSIMULACRA2 / Butteraugli / DSSIM are checked as guards
 * only *within* a sweep, against another ChromaHash build. Across formats they
 * were never scored at all — which hides the one asymmetry §2 of
 * `spec/EXPERIMENTS.md` turned up: from ~84 B up ChromaHash wins colour and
 * loses structure, to competitors it is nominally beating.
 *
 * So the summary below names a winner per metric inside each byte
 * neighbourhood and labels ChromaHash's result there: a clean sweep, a ΔE00-only
 * win (with the guards it loses named), or a loss.
 */

/** Metrics the summary ranks, with their direction of improvement. */
const SUMMARY_METRICS = [
  { key: "ciede2000", label: "ΔE00", lowerIsBetter: true, digits: 3 },
  { key: "ssimulacra2", label: "SSIM2", lowerIsBetter: false, digits: 1 },
  { key: "butteraugli", label: "Butter", lowerIsBetter: true, digits: 2 },
  { key: "dssim", label: "DSSIM", lowerIsBetter: true, digits: 4 },
] as const satisfies ReadonlyArray<{
  key: keyof Pick<Row, "ciede2000" | "ssimulacra2" | "butteraugli" | "dssim">;
  label: string;
  lowerIsBetter: boolean;
  digits: number;
}>;

/** Direction lookup keyed by metric field, derived from {@link SUMMARY_METRICS}. */
const LOWER_IS_BETTER: Record<string, boolean> = Object.fromEntries(
  SUMMARY_METRICS.map((m) => [m.key, m.lowerIsBetter]),
);

/**
 * How far a row's mean size may sit from an anchor and still be treated as
 * competing at that budget. 1.20x matches how §2 groups its table (lqip-modern
 * r16 at 83.9 B against ChromaHash at 80 B, WebP at 107.2 B against 108 B) and
 * keeps a row that is a quarter larger from being scored as an equal-byte peer.
 */
const NEIGHBOURHOOD_RATIO = 1.2;

/**
 * Tie tolerances, mirroring the in-sweep guard rule (sweep.ts): SSIMULACRA2 is
 * absolute, everything else relative. A rival must beat ChromaHash by more than
 * this to count as a guard loss, so noise does not manufacture verdicts.
 */
const TIE_SSIM2 = 1.0;
const TIE_REL = 0.02;

/** Winner of one metric inside one neighbourhood. */
interface MetricWinner {
  metric: string;
  variant: string;
  value: number | null;
  /** ChromaHash's value for the same metric, or null if it has no row here. */
  chromahash: number | null;
}

/** One byte-anchor neighbourhood, scored per metric. */
interface Neighbourhood {
  anchorBytes: number;
  variants: string[];
  chromahash: string | null;
  winners: MetricWinner[];
  /** Guards ChromaHash loses here despite (or alongside) its ΔE00 result. */
  lostGuards: string[];
  /**
   * One of: "sweep" (ChromaHash leads every metric), "ΔE00 only" (leads ΔE00,
   * loses a guard), "ΔE00 tie, guards clean" / "ΔE00 tie, loses guards" (inside
   * the tie tolerance on colour), "behind", "unopposed" (nothing else competes
   * at this size), "absent" (no ChromaHash row here).
   */
  verdict: string;
}

/** Is `a` better than `b` on a metric, by more than the tie tolerance? */
function beats(metric: string, a: number, b: number): boolean {
  if (metric === "ssimulacra2") return a - b > TIE_SSIM2;
  const lower = LOWER_IS_BETTER[metric] ?? true;
  return lower ? b - a > Math.abs(b) * TIE_REL : a - b > Math.abs(b) * TIE_REL;
}

/**
 * Group rows into byte neighbourhoods around the swept anchors and score each
 * one per metric. A row joins the anchor nearest in log-byte space, and is
 * dropped when even that anchor is more than {@link NEIGHBOURHOOD_RATIO} away —
 * an unopposed row at a size nobody else reaches proves nothing about a winner.
 */
function summarizeGuards(rows: Row[], anchors: number[]): Neighbourhood[] {
  const groups = new Map<number, Row[]>();
  for (const row of rows) {
    if (row.bytes <= 0) continue;
    let best: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const anchor of anchors) {
      const d = Math.abs(Math.log(row.bytes / anchor));
      if (d < bestDist) {
        bestDist = d;
        best = anchor;
      }
    }
    if (best === null || bestDist > Math.log(NEIGHBOURHOOD_RATIO)) continue;
    const list = groups.get(best);
    if (list) list.push(row);
    else groups.set(best, [row]);
  }

  // One row per family per neighbourhood: the one closest to the anchor. A
  // budget ladder emits several rows per family near one anchor (a codec that
  // floors out, two adjacent ChromaHash layouts), and scoring a family against
  // itself is not a cross-format result.
  for (const [anchor, group] of groups) {
    const best = new Map<string, Row>();
    for (const row of group) {
      const incumbent = best.get(row.family);
      if (
        !incumbent ||
        Math.abs(Math.log(row.bytes / anchor)) <
          Math.abs(Math.log(incumbent.bytes / anchor))
      ) {
        best.set(row.family, row);
      }
    }
    groups.set(anchor, [...best.values()]);
  }

  const out: Neighbourhood[] = [];
  for (const anchor of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(anchor) ?? [];
    const ours = group.find((r) => r.family === "ChromaHash") ?? null;
    const winners: MetricWinner[] = [];
    const lostGuards: string[] = [];
    for (const { key, label } of SUMMARY_METRICS) {
      const scored = group.filter(
        (r): r is Row & Record<typeof key, number> =>
          r[key] !== null && Number.isFinite(r[key]),
      );
      if (scored.length === 0) {
        winners.push({
          metric: label,
          variant: "—",
          value: null,
          chromahash: null,
        });
        continue;
      }
      const lower = LOWER_IS_BETTER[key] ?? true;
      let top = scored[0] as Row & Record<typeof key, number>;
      for (const r of scored) {
        if (lower ? r[key] < top[key] : r[key] > top[key]) top = r;
      }
      const mine = ours && ours[key] !== null ? ours[key] : null;
      winners.push({
        metric: label,
        variant: top.variant,
        value: top[key],
        chromahash: mine,
      });
      if (mine !== null && key !== "ciede2000" && beats(key, top[key], mine)) {
        lostGuards.push(label);
      }
    }

    let verdict: string;
    if (!ours) verdict = "absent";
    else if (group.length === 1) verdict = "unopposed";
    else {
      const deltaE = winners.find((w) => w.metric === "ΔE00");
      const topIsOurs = deltaE?.variant === ours.variant;
      // Within the tie tolerance the colour lead is not real, so say "tie"
      // rather than crediting a win the numbers do not support.
      const tiesColour =
        deltaE !== undefined &&
        deltaE.value !== null &&
        deltaE.chromahash !== null &&
        !beats("ciede2000", deltaE.value, deltaE.chromahash);
      if (!tiesColour) verdict = "behind";
      else if (lostGuards.length === 0)
        verdict = topIsOurs ? "sweep" : "ΔE00 tie, guards clean";
      else verdict = topIsOurs ? "ΔE00 only" : "ΔE00 tie, loses guards";
    }

    out.push({
      anchorBytes: anchor,
      variants: group.map((r) => r.variant),
      chromahash: ours?.variant ?? null,
      winners,
      lostGuards,
      verdict,
    });
  }
  return out;
}

/** Print the guard-aware summary table. */
function printGuardSummary(summary: Neighbourhood[]): void {
  console.log(
    "\nGuard-aware winners by byte neighbourhood (ΔE00 primary, three guards)",
  );
  console.log(
    `  ${"Anchor".padStart(7)} ${"n".padStart(3)} ${"ΔE00 winner".padEnd(22)} ${"SSIM2 winner".padEnd(22)} ${"Butter winner".padEnd(22)} ${"DSSIM winner".padEnd(22)} verdict`,
  );
  for (const n of summary) {
    const cell = (label: string) => {
      const w = n.winners.find((x) => x.metric === label);
      if (!w || w.value === null) return "—".padEnd(22);
      const digits =
        SUMMARY_METRICS.find((m) => m.label === label)?.digits ?? 2;
      return `${w.variant} ${w.value.toFixed(digits)}`.padEnd(22);
    };
    const note =
      n.lostGuards.length > 0 ? ` (loses ${n.lostGuards.join(", ")})` : "";
    console.log(
      `  ${`${n.anchorBytes} B`.padStart(7)} ${String(n.variants.length).padStart(3)} ${cell("ΔE00")} ${cell("SSIM2")} ${cell("Butter")} ${cell("DSSIM")} ${n.verdict}${note}`,
    );
  }
  const only = summary.filter(
    (n) => n.verdict === "ΔE00 only" || n.verdict === "ΔE00 tie, loses guards",
  );
  if (only.length > 0) {
    console.log(
      `\n  ChromaHash wins ΔE00 but loses a guard at ${only
        .map((n) => `${n.anchorBytes} B [${n.lostGuards.join("+")}]`)
        .join(", ")}.`,
    );
  } else {
    console.log(
      "\n  No neighbourhood where ChromaHash wins ΔE00 and loses a guard.",
    );
  }
}

/**
 * Re-derive the guard summary from an already-written result.
 *
 * Printed, not written back: the summary is a function of the per-image
 * series, and a result stores nothing derived (`results.ts`).
 */
function summarizeExisting(jsonPath: string): void {
  const file = readResult(
    path.dirname(jsonPath),
    path.basename(jsonPath, ".json"),
  );
  if (!file) throw new Error(`no result at ${jsonPath}`);
  if (file.tool !== "rd-budget") {
    throw new Error(`${jsonPath} is a ${file.tool} result, not rd-budget's`);
  }
  const rows: Row[] = file.rows.map((r) => {
    const s = summarize(r, file.imageNames);
    return {
      family: r.family ?? "ChromaHash",
      variant: r.label,
      targetBytes: r.targetBytes ?? null,
      tune: r.tune,
      tier: r.tier,
      images: s.images,
      bytes: s.bytes ?? 0,
      ciede2000: s.meanCiede,
      ssimulacra2: s.meanSsimulacra2,
      butteraugli: s.meanButteraugli,
      dssim: s.meanDssim,
      perImage: r.perImage,
    };
  });
  const recorded = file.settings.budgets as number[];
  const anchors = values.budgets !== undefined ? budgets : recorded;
  printGuardSummary(summarizeGuards(rows, anchors));
}

async function main(): Promise<void> {
  const summarizePath = values.summarize;
  if (summarizePath !== undefined) {
    summarizeExisting(path.resolve(summarizePath));
    return;
  }
  ensureIqaAvailable();
  setScoringConfig({ upscalePolicy: "browser-gamma", blurredScoring: false });

  let inputs = await loadCorpus();
  if (maxImages !== null) inputs = inputs.slice(0, maxImages);

  // rd-budget has no config file; what decides its rows is its arguments, so
  // those are what the config digest covers. Taken before the first encode.
  const effectiveArgs = {
    split: splitArg,
    budgets,
    formats: formatFilter ? [...formatFilter].sort() : null,
    maxImages,
    jxl: isJxlAvailable(),
  };
  const provenance = {
    ...captureProvenance({
      config: "tools/comparison/src/rd-budget.ts",
      configSha256: sha256(JSON.stringify(effectiveArgs)),
      iqaCli: iqaVersionBanner(),
      binaries: [RUST_CLI],
      codecs: Object.fromEntries(
        Object.entries(sharp.versions).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      ),
    }),
    corpus: inputs.map((i) => ({
      name: path.basename(i.filePath).replace(/\.[^.]+$/, ""),
      sha256: fileSha256(i.filePath) ?? "missing",
    })),
  };
  console.log(
    `rd-budget: ${inputs.length} ${splitArg}-split photos × budgets [${budgets.join(", ")}]`,
  );

  const want = (f: string) => formatFilter === null || formatFilter.has(f);
  const rows: Row[] = [];
  const push = async (r: Promise<Row | null>) => {
    const row = await r;
    if (!row) return;
    rows.push(row);
    console.log(
      `  ${row.variant.padEnd(26)} ${row.bytes.toFixed(1).padStart(7)} B  ΔE00 ${row.ciede2000?.toFixed(3) ?? "N/A"}`,
    );
  };

  // ChromaHash. At a shipped byte anchor this must be the shipped tier, not a
  // layout synthesized to fill the budget: `allocate` builds a 5 b/4 b layout,
  // which is the *pre-v0.7* shape, so synthesizing at 32 B would report the old
  // format under the current name. Off-anchor budgets are still synthesized —
  // there is nothing else to show there — and are labelled "resized" so the two
  // are never confused.
  if (want("chromahash")) {
    for (const b of budgets) {
      const anchorTier = SHIPPED_ANCHORS.get(b);
      if (anchorTier !== undefined) {
        await push(
          scoreChromaHash(`ChromaHash@${b}B`, b, null, anchorTier, inputs),
        );
        continue;
      }
      const a = allocate(b);
      if (!a) {
        console.log(
          `  ChromaHash@${b}B  — below the 7 B prefix floor, skipped`,
        );
        continue;
      }
      const tier = tierFor(a.nL);
      // `l1=`/`c=` are counts at the *default* tier, which the encoder scales
      // by 4^level. Passing the tier *code* here divides by an extra factor of
      // four and synthesizes a layout at a quarter of the budget.
      const s = 4 ** levelOf(tier);
      // Express the target counts as base counts at the chosen tier.
      const l1 = Math.round(a.nL / s);
      const c = Math.round(a.nC / s);
      const tune = `l1=${l1}:5 c=${c}:4`;
      await push(
        scoreChromaHash(`ChromaHash@${b}B (resized)`, b, tune, tier, inputs),
      );
    }
  }

  // ThumbHash is a single fixed-rate point (no quality knob).
  if (want("thumbhash")) {
    await push(scoreAdapter("ThumbHash", new ThumbHashAdapter(), null, inputs));
  }
  // BlurHash's knob is component count; sizes land where they land.
  if (want("blurhash")) {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      await push(
        scoreAdapter(
          "BlurHash",
          new BlurHashAdapter({
            name: `BlurHash ${n}x${n}`,
            componentsX: n,
            componentsY: n,
          }),
          null,
          inputs,
        ),
      );
    }
  }
  if (want("lqip-modern")) {
    for (const r of [8, 12, 16, 24, 32, 48]) {
      await push(
        scoreAdapter(
          "lqip-modern",
          new LqipModernAdapter({
            name: `lqip-modern r${r}`,
            resize: r,
            outputFormat: "webp",
          }),
          null,
          inputs,
        ),
      );
    }
  }
  if (want("rawrgb565")) {
    for (const b of budgets) {
      await push(scoreAdapter("RawRGB565", new RawPixelsAdapter(b), b, inputs));
    }
  }
  const codecs = ["webp", "jpeg", "avif", ...(isJxlAvailable() ? ["jxl"] : [])];
  for (const codec of codecs) {
    if (!want(codec)) continue;
    for (const b of budgets) {
      await push(
        scoreAdapter(
          codec.toUpperCase(),
          new CodecThumbAdapter(codec as "webp" | "jpeg" | "avif" | "jxl", b),
          b,
          inputs,
        ),
      );
    }
  }

  // A run narrowed to some images or some formats is not the cross-format
  // result, so it never lands where the committed one lives.
  const outDir =
    values["out-dir"] !== undefined
      ? path.resolve(values["out-dir"])
      : maxImages !== null || formatFilter !== null
        ? SCRATCH_DIR
        : RESULTS_DIR;
  await fs.mkdir(outDir, { recursive: true });
  const name = `${values.out ?? "rd-budget"}-${splitArg}`;
  const outPath = resultPath(outDir, name);
  const summary = summarizeGuards(rows, budgets);
  const result: ResultFile = {
    schema: RESULT_SCHEMA,
    tool: "rd-budget",
    name,
    split: splitArg,
    settings: {
      budgets,
      formats: effectiveArgs.formats,
      jxl: effectiveArgs.jxl,
    },
    provenance,
    imageNames: provenance.corpus.map((c) => c.name),
    rows: rows.map((r) => ({
      label: r.variant,
      family: r.family,
      targetBytes: r.targetBytes,
      tune: r.tune,
      tier: r.tier,
      version: null,
      perImage: r.perImage,
    })),
  };
  await fs.writeFile(outPath, serializeResult(result));
  if (provenance.dirty) {
    console.warn(
      `\n  !! The tree was dirty when this run started (${provenance.dirtyPaths.length} path(s)); the result records it, and verify:experiments --strict refuses it.`,
    );
  }

  console.log(`\nR-D by byte budget (${splitArg} split) → ${outPath}`);
  console.log(
    `  ${"Variant".padEnd(26)} ${"Bytes".padStart(7)} ${"ΔE00".padStart(8)} ${"SSIM2".padStart(8)} ${"Butter".padStart(8)} ${"DSSIM".padStart(8)}`,
  );
  const cell = (v: number | null, d: number, w: number) =>
    (v !== null ? v.toFixed(d) : "N/A").padStart(w);
  for (const r of [...rows].sort(
    (a, b) => a.bytes - b.bytes || a.family.localeCompare(b.family),
  )) {
    console.log(
      `  ${r.variant.padEnd(26)} ${r.bytes.toFixed(1).padStart(7)} ${cell(r.ciede2000, 3, 8)} ${cell(r.ssimulacra2, 1, 8)} ${cell(r.butteraugli, 2, 8)} ${cell(r.dssim, 4, 8)}`,
    );
  }

  printGuardSummary(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
