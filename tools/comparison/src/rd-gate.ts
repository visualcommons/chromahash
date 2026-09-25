/**
 * R-D regression gate (roadmap U18).
 *
 * `ci-comparison.yml` runs the cross-format report, which proves the harness
 * still works — it does not prove the format still performs. A change that
 * quietly cost 5% of default-tier quality would render a perfectly healthy
 * report and pass. This gate closes that: it encodes a fixed handful of corpus
 * images at the 32-byte default (tier code 1; the old numbering EXPERIMENTS.md
 * uses called it "tier 0"), scores mean ΔE00, and fails if the result has
 * drifted past a tolerance from a checked-in baseline.
 *
 * Deliberately small — a few content-pinned photos, no codec baselines, no
 * ladder — so it costs a CI job seconds and can run on every pull request.
 * The full R-D picture is what `rd-budget` and the sweeps are for.
 *
 * The gate is two-sided. A regression fails, and so does an *improvement*
 * beyond tolerance: the baseline is then stale, and a stale baseline silently
 * stops gating. Refresh it deliberately with `--update`.
 *
 * Usage:
 *   node dist/rd-gate.js [--update] [--tolerance 1.0] [--baseline <path>]
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  RUST_CLI,
  decodeViaRust,
  encodeViaRust,
} from "./adapters/chromahash.ts";
import { gamutToSrgbReference } from "./gamut.ts";
import { loadImage } from "./image-loader.ts";
import { computeAllMetrics, setScoringConfig } from "./metrics.ts";
import { ensureIqaAvailable } from "./metrics/iqa.ts";
import { ensureNaturalImages } from "./natural-images.ts";

/**
 * The gated images: eight tune-split photographs spanning the corpus categories
 * the encoder is most likely to regress on — mid-key detail, a face, a night
 * scene, a saturated one, a skin tone, and a photograph whose measured mean
 * chroma is ~0 so its chroma AC set is identically zero (the degenerate input
 * for any change to the chroma path). One image per axis of the corpus audit,
 * all from the tune split. Content-pinned by `natural-images.ts`, so this set
 * is byte-identical on every machine.
 */
const GATE_IMAGES = [
  "portrait-african-lady",
  "chroma-the-old-monochrome",
  "natural-landschaftsschutzgebiet-volkspark-rehberge",
  "natural-andrew-jackson-state",
  "night-bas-lica-notre",
  "natural-fishing-the-coast",
  "natural-dish-meatloaf-served",
  "natural-hard-rock-cafe",
] as const;

/** Quality tier the gate scores: the 32-byte default (spec §2.5 tier code 1). */
const TIER = 1;
/** Encoded length a default-tier hash must have, per the shipped v1 layout. */
const TIER_BYTES = 32;
/** Default two-sided tolerance on mean ΔE00, in percent. */
const DEFAULT_TOLERANCE_PCT = 1.0;

/** Baseline document, checked into the repo next to this tool. */
interface Baseline {
  /** Explains the file to whoever finds it in a diff. */
  note: string;
  tier: number;
  tolerancePct: number;
  images: Array<{ label: string; bytes: number; ciede2000: number }>;
  meanCiede2000: number;
}

const { values } = parseArgs({
  options: {
    update: { type: "boolean", default: false },
    tolerance: { type: "string" },
    baseline: { type: "string" },
  },
});

const toolRoot = path.resolve(import.meta.dirname, "..");
const baselinePath = path.resolve(
  values.baseline ?? path.join(toolRoot, "baselines/rd-gate.json"),
);

/** Encode + decode + score every gated image at {@link TIER}. */
async function measure(): Promise<Baseline["images"]> {
  const paths = await ensureNaturalImages(GATE_IMAGES);
  const out: Baseline["images"] = [];
  for (const filePath of paths.sort()) {
    const label = path.basename(filePath).replace(/\.[^.]+$/, "");
    const input = await loadImage(filePath);
    input.gamut = "srgb";
    input.metricReferenceRgba = gamutToSrgbReference(
      input.referenceRgba,
      "srgb",
    );
    const { smallWidth: w, smallHeight: h, smallRgba: rgba } = input;
    const hash = encodeViaRust(RUST_CLI, w, h, rgba, "srgb", TIER);
    if (hash.length !== TIER_BYTES) {
      throw new Error(
        [
          `${label}: tier-${TIER} hash is ${hash.length} B, expected ${TIER_BYTES} B —`,
          "the wire layout changed, which is a spec change, not a quality regression.",
        ].join(" "),
      );
    }
    const dec = decodeViaRust(RUST_CLI, hash, "srgb", w, h);
    const { metrics } = await computeAllMetrics(
      input.metricReferenceRgba,
      input.referenceWidth,
      input.referenceHeight,
      dec.rgba,
      dec.w,
      dec.h,
    );
    const ciede = metrics.ciede2000;
    if (ciede === null || !Number.isFinite(ciede)) {
      throw new Error(`${label}: ΔE00 could not be measured`);
    }
    out.push({ label, bytes: hash.length, ciede2000: ciede });
  }
  return out;
}

function meanOf(images: Baseline["images"]): number {
  return images.reduce((s, i) => s + i.ciede2000, 0) / images.length;
}

async function main(): Promise<void> {
  ensureIqaAvailable();
  setScoringConfig({ upscalePolicy: "browser-gamma", blurredScoring: false });

  const images = await measure();
  const mean = meanOf(images);

  if (values.update === true) {
    const baseline: Baseline = {
      note:
        "Baseline for the default-tier (code 1, 32 B) R-D regression gate (src/rd-gate.ts). " +
        "Regenerate deliberately with `mise run rd:gate:update` after an intended " +
        "encoder change, and say so in the commit message.",
      tier: TIER,
      tolerancePct: DEFAULT_TOLERANCE_PCT,
      images,
      meanCiede2000: mean,
    };
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      `rd-gate: wrote baseline (${images.length} images, mean ΔE00 ${mean.toFixed(4)}) → ${baselinePath}`,
    );
    return;
  }

  let baseline: Baseline;
  try {
    baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")) as Baseline;
  } catch (err) {
    console.error(
      [
        `rd-gate: no baseline at ${baselinePath} (${
          err instanceof Error ? err.message : err
        }).`,
        "  Create one with `mise run rd:gate:update`.",
      ].join("\n"),
    );
    process.exit(1);
    return;
  }

  const tolerance =
    values.tolerance !== undefined
      ? Number.parseFloat(values.tolerance)
      : (baseline.tolerancePct ?? DEFAULT_TOLERANCE_PCT);
  const deltaPct =
    ((mean - baseline.meanCiede2000) / baseline.meanCiede2000) * 100;

  console.log(
    `rd-gate: tier ${TIER}, ${images.length} pinned photos, ±${tolerance}% on mean ΔE00`,
  );
  const priorByLabel = new Map(
    baseline.images.map((i) => [i.label, i.ciede2000]),
  );
  for (const image of images) {
    const prior = priorByLabel.get(image.label);
    const change =
      prior === undefined
        ? "new"
        : `${(((image.ciede2000 - prior) / prior) * 100).toFixed(2)}%`;
    console.log(
      `  ${image.label.padEnd(22)} ${image.ciede2000.toFixed(4).padStart(9)}  ${change.padStart(8)}`,
    );
  }
  console.log(
    `  ${"mean".padEnd(22)} ${mean.toFixed(4).padStart(9)}  ${deltaPct.toFixed(2).padStart(7)}%  (baseline ${baseline.meanCiede2000.toFixed(4)})`,
  );

  const missing = baseline.images
    .map((i) => i.label)
    .filter((l) => !images.some((i) => i.label === l));
  if (missing.length > 0) {
    console.error(
      `rd-gate: FAIL — baseline images not measured: ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  if (deltaPct > tolerance) {
    console.error(
      `rd-gate: FAIL — mean ΔE00 regressed ${deltaPct.toFixed(2)}%, past the ${tolerance}% tolerance.`,
    );
    process.exit(1);
  }
  if (deltaPct < -tolerance) {
    console.error(
      [
        `rd-gate: FAIL — mean ΔE00 improved ${Math.abs(deltaPct).toFixed(2)}%, past the ${tolerance}% tolerance.`,
        "  That is good news and a stale baseline: refresh it with `mise run rd:gate:update`",
        "  so the gate keeps measuring against what the encoder actually does.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log("rd-gate: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
