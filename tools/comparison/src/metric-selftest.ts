/**
 * Self-checks for the metrics this harness computes itself: ringing
 * (`metrics/local.ts`), spurious detail and spectral deficit
 * (`metrics/spurious.ts`), aspect fidelity (`aspect.ts`), and the joins
 * `stratify.ts` reads them through (`stratify-core.ts`). Run with
 * `mise run selftest:metrics`.
 *
 * This tool has no test framework — see `TESTING.md` — so the properties the
 * local metrics are *designed around* are asserted here instead, as a script
 * that exits non-zero. They are the falsifiable claims: if the "a blur scores
 * exactly zero" case ever fails, the window-radius derivation in
 * `metrics/local.ts` is wrong and every ringing number in the report is noise;
 * if "the ideal low-pass scores zero" fails, the same is true of every spurious
 * number.
 *
 * Both artifact metrics have earned that framing. The rounding asymmetry in
 * `spurious.ts` — which made a provably-ideal low-pass of a ramp score 0.14 —
 * was found by this file and by nothing else.
 *
 * The aspect block is new: the docstring here and the `selftest:metrics` task
 * description had both claimed `aspect.ts` coverage since it was written, and
 * neither had any.
 *
 * The stratify block is here because §13.3 is the one table in EXPERIMENTS.md
 * that no sweep binds -- `verify:experiments` registers it in `UNBOUND_NOTES`
 * -- so no gate reached it from either end, and the correlation, the binning
 * and the alignment assert its numbers rest on had no coverage of any kind.
 * They are checked against fixtures whose answers are known by hand rather than
 * against the corpus, so they hold with no sweep output on disk.
 *
 * The grid-pin block is here for the same reason and paid for itself the same
 * way. Every cross-tier artifact figure in EXPERIMENTS.md §13 is read off a
 * pinned grid, and no call in this file had ever passed the pin — so the first
 * assertion that an ideal low-pass still scores exactly zero *through* a pin
 * failed immediately, on a bias that grew with the pin ratio and so ran along
 * the tier axis those figures are read down.
 *
 * The verify-benchmark and probe blocks are here for the stratify block's
 * reason, one document over. `verify:benchmark` decides which PERFORMANCE.md
 * cells pass, fail or are skipped, and every rule that makes that decision was
 * added because an earlier version reported green over a case it had not
 * checked. The gate's own run over the committed baseline exercises only the
 * one state that baseline is in — Swift absent, one clean commit, every prose
 * sentence present — so none of the failure paths had ever executed. They are
 * asserted against fixture runs, tables and stage files
 * (`verify-benchmark-core.ts`), and the probe classification that feeds them
 * against real spawns (`perf/availability.ts`).
 *
 * The verify:experiments block is here for the same reason again: the table
 * register (`experiments-register.ts`) and the result reader's shape check
 * (`results.ts`) fail a run only on a state the committed document and results
 * are never in, so each failure branch is driven from a fixture instead.
 *
 * The alpha corpus block covers the retired alpha holdout split and withdrawn
 * pins (`alpha-images.ts`, #83), whose refusal and skip no sweep CI runs ever
 * reaches, and the move of the split's survivors to tune2 (#93). The alpha
 * holdout2 block covers the sealed split that replaces it (#93).
 *
 * The photographic splits block covers the same for the photographic holdout
 * #76 retired into tune2, and for the gate that keeps holdout2 sealed until
 * `spec/V0.8-DECISIONS.md` records a decision as frozen (`holdout-images.ts`).
 *
 * The mde block covers `mde-core.ts`, which EXPERIMENTS.md §13.6 is computed
 * by: `verify:experiments` compares §13.6 with that same code, so only
 * hand-worked values can say the code is right. S3b, beside the other
 * bootstrap checks, holds §13.6's claim that the percentile bootstrap is
 * narrower than the normal and t intervals.
 *
 * The register-verdict block covers `register-verdict-core.ts`, which
 * re-derives C1 and C2's frozen verdicts from the committed holdout2 reads. It
 * asserts the R1 outcomes, condition 4 and C1's ThumbHash admission the
 * register records, which no EXPERIMENTS.md table carries.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  ALPHA_HOLDOUT2_UNPINNED,
  ALPHA_HOLDOUT_RETIRED,
  ALPHA_IMAGES,
  type AlphaImageSpec,
  alphaHoldout2Specs,
  alphaHoldout3Specs,
  alphaImagesToFetch,
} from "./alpha-images.ts";
import { compareArms, guardVerdictOnIntervals } from "./arms-core.ts";
import { aspectFidelity, log2ToPct } from "./aspect.ts";
import {
  type CommonsFacts,
  HOLDOUT3_AMENDMENTS,
  HOLDOUT3_DRAW,
  HOLDOUT3_DRAW_RECORD,
  HOLDOUT3_PINS_BEGIN,
  HOLDOUT3_PINS_END,
  type Holdout3DrawRecord,
  SKIN_REGION,
  admit,
  alphaCell,
  alphaFractions,
  covariatesOf,
  exifCamera,
  holdout3Admission,
  holdout3Label,
  holdout3OrderKey,
  inSkinRegion,
  isFreeLicence,
  isPhoneCamera,
  measureFile,
  pinnedCommonsTitle,
  replayHoldout3,
  sha1Mismatch,
  silhouetteOf,
  skinBand,
  spliceHoldout3Pins,
  srgbToLab,
} from "./corpus-covariates.ts";
import {
  ALPHA_HOLDOUT2_PREFIX,
  ALPHA_HOLDOUT3_PREFIX,
  GRAPHIC_HOLDOUT3_PREFIX,
  HOLDOUT2_ALL_REFUSED,
  HOLDOUT2_PREFIX,
  HOLDOUT3_PREFIX,
  HOLDOUT3_PROTOCOL,
  HOLDOUT3_STRATA,
  type Holdout3Record,
  PHOTO_HOLDOUT_RETIRED,
  assertHoldout2Corpus,
  holdout3Strata,
  inCorpus,
  inSplit,
  isSealed,
  parseScratchPhotoSplit,
  parseSplit,
  partitionSealed,
  splitFor,
  tierFor,
} from "./corpus.ts";
import { rewriteCell } from "./doc-tables.ts";
import {
  type TableRegisterInput,
  tableRegisterProblems,
} from "./experiments-register.ts";
import {
  type GraphicImageSpec,
  GRAPHIC_IMAGES,
  graphicHoldout3Specs,
  graphicImagesToFetch,
} from "./graphic-images.ts";
import {
  KODAK_SHA256,
  assertHoldout2Unread,
  assertHoldout3Unread,
  checkHoldout3Pins,
  ensureHoldout2Images,
  ensureHoldout3Images,
  holdout2Specs,
  holdout3Reads,
  holdout3Specs,
  openHoldout2,
  openHoldout3,
  registerStatus,
} from "./holdout-images.ts";
import {
  dataUriToBuffer,
  fileBufferToDisplayDataUri,
  loadImage,
  orientedSize,
} from "./image-loader.ts";
import {
  PHOTO_HOLDOUT2_CANDIDATES,
  mdeCell,
  readSpread,
  tFactor,
  zFactor,
} from "./mde-core.ts";
import { computeRinging } from "./metrics/local.ts";
import { computeSpurious } from "./metrics/spurious.ts";
import {
  CURATED_IMAGES,
  type NaturalImageSpec,
  naturalImagesToFetch,
} from "./natural-images.ts";
import { classifyProbe, repoRelative } from "./perf/availability.ts";
import {
  type Preflight,
  defaultMaxLoad,
  hostKey,
  judgePreflight,
  mayStart,
  overLoad,
  readLoadavg,
  readPreflight,
  SUSTAINED_LOAD_FACTOR,
  sustainedLoadBar,
  WAIT_RULE,
  waitForLoad,
} from "./perf/host.ts";
import { planMatrix, planRun, roundOrder } from "./perf/plan.ts";
import { cellStats, pairStats } from "./perf/probe.ts";
import {
  type GitView,
  MEASURED_PATHS,
  MEASUREMENT_OUTPUTS,
  digestOfListing,
  isDocumentation,
  judgeLanding,
  judgeProvenance,
  provenanceFails,
  sourceDigest,
} from "./perf/provenance.ts";
import { allTargets } from "./perf/targets.ts";
import {
  deriveVerdict,
  guardsAtSeed,
  holdout3StrataOf,
  strataMembers,
  stratumRule,
} from "./register-verdict-core.ts";
import {
  ARTIFACT_ZERO_BASE_ALLOWANCE,
  RESULT_SCHEMA,
  type ResultFile,
  shapeProblems,
} from "./results.ts";
import {
  BOOTSTRAP_SEED,
  bootstrapCI,
  bootstrapP,
  correlationInference,
  holm,
  normalQuantile,
  studentTQuantile,
} from "./stats.ts";
import { alignmentError, equalCountBins, pearson } from "./stratify-core.ts";
import {
  type Binding,
  CROSS_RUN_TOLERANCE,
  type ClaimContext,
  type Counters,
  type DecodeStageCell,
  type DocNumber,
  type Edit,
  type Failure,
  MissingCell,
  type ProseClaim,
  type RunDoc,
  Runs,
  type StageCell,
  type SweepClaim,
  TOLERANCE,
  type Verdict,
  agreement,
  applyEdits,
  checkDecodeStagesProvenance,
  checkProseClaims,
  checkStability,
  checkStabilityClaim,
  checkStageRowCoverage,
  checkStagesProvenance,
  checkSweepClaims,
  checkTable,
  clean,
  fixRefusal,
  parseDecodeStages,
  parseStages,
  parseTables,
  parseUnavailableMarker,
  runFailures,
  stabilityFailures,
  withheldReason,
} from "./verify-benchmark-core.ts";

let failures = 0;

const REPO_ROOT_FOR_SELFTEST = path.resolve(import.meta.dirname, "../../..");

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name} — ${detail}`);
  }
}

/** Opaque RGBA from a per-pixel colour function. */
function makeRgba(
  w: number,
  h: number,
  f: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const p = (y * w + x) * 4;
      out[p] = Math.max(0, Math.min(255, Math.round(r)));
      out[p + 1] = Math.max(0, Math.min(255, Math.round(g)));
      out[p + 2] = Math.max(0, Math.min(255, Math.round(b)));
      out[p + 3] = 255;
    }
  }
  return out;
}

/**
 * Area-average downscale — the honest model of "a decode that is merely a
 * low-pass of the reference". Convex by construction, so by the metric's
 * central property it must score zero.
 */
function boxDownscale(
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      const acc = [0, 0, 0];
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const p = (sy * sw + sx) * 4;
          acc[0] = (acc[0] ?? 0) + (src[p] ?? 0);
          acc[1] = (acc[1] ?? 0) + (src[p + 1] ?? 0);
          acc[2] = (acc[2] ?? 0) + (src[p + 2] ?? 0);
          n++;
        }
      }
      const p = (y * dw + x) * 4;
      out[p] = Math.round((acc[0] ?? 0) / n);
      out[p + 1] = Math.round((acc[1] ?? 0) / n);
      out[p + 2] = Math.round((acc[2] ?? 0) / n);
      out[p + 3] = 255;
    }
  }
  return out;
}

const REF_W = 256;
const REF_H = 256;
const DEC = 32;

// A reference with real edges: ringing has to have something to ring around.
// Mid-range values on purpose, so an excursion is visible instead of clipping
// at the byte boundary (the trap that hid sharp's own overshoot).
const reference = makeRgba(REF_W, REF_H, (x, y) => {
  const band = x < REF_W / 2 ? 70 : 190;
  const v = y < REF_H / 2 ? band : 255 - band;
  return [v, v, v];
});

console.log("\nringing — the properties the metric is built on\n");

// 1. Identity.
{
  const s = computeRinging(reference, reference, REF_W, REF_H, REF_W, REF_H);
  check(
    "identity scores 0",
    s !== null && s.ringing === 0,
    `ringing=${s?.ringing}`,
  );
}

// 2. THE null hypothesis: a pure low-pass decode must score exactly 0. If this
//    fails, the radius derivation is wrong and the metric measures blur.
const lowpass = boxDownscale(reference, REF_W, REF_H, DEC, DEC);
{
  const s = computeRinging(reference, lowpass, REF_W, REF_H, DEC, DEC);
  check(
    "a pure low-pass decode scores 0",
    s !== null && s.ringing === 0,
    `ringing=${s?.ringing.toFixed(4)} radius=${s?.ringWindowRadius}`,
  );
}

// 3. Bias correction: a uniform tint is "smooth but wrong", not an artifact.
{
  const tinted = new Uint8Array(lowpass);
  for (let i = 0; i < tinted.length; i += 4) {
    tinted[i] = Math.min(255, (tinted[i] ?? 0) + 8);
    tinted[i + 1] = Math.min(255, (tinted[i + 1] ?? 0) + 8);
    tinted[i + 2] = Math.min(255, (tinted[i + 2] ?? 0) + 8);
  }
  const s = computeRinging(reference, tinted, REF_W, REF_H, DEC, DEC);
  check(
    "a uniform +8 tint is absorbed as bias, not scored as ringing",
    s !== null && s.ringing < 0.5,
    `ringing=${s?.ringing.toFixed(4)}`,
  );
}

/** Add an oscillation straddling the vertical edge — synthetic Gibbs. */
function addRipple(
  base: Uint8Array,
  amp: [number, number, number],
): Uint8Array {
  const out = new Uint8Array(base);
  const mid = DEC / 2;
  for (let y = 0; y < DEC; y++) {
    for (let x = 0; x < DEC; x++) {
      const d = x - mid;
      if (Math.abs(d) > 5) continue;
      const w = Math.cos((d * Math.PI) / 2.5) * (1 - Math.abs(d) / 6);
      const p = (y * DEC + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[p + c] = Math.max(
          0,
          Math.min(255, Math.round((out[p + c] ?? 0) + (amp[c] ?? 0) * w)),
        );
      }
    }
  }
  return out;
}

// 4. A neutral ripple must register, and register as luma.
const neutral = computeRinging(
  reference,
  addRipple(lowpass, [30, 30, 30]),
  REF_W,
  REF_H,
  DEC,
  DEC,
);
check(
  "a neutral ripple at the edge registers",
  neutral !== null && neutral.ringing > 1,
  `ringing=${neutral?.ringing.toFixed(3)} area=${((neutral?.ringArea ?? 0) * 100).toFixed(1)}%`,
);
check(
  "a neutral ripple reads as luma, not chroma",
  neutral !== null && neutral.ringingLuma > neutral.ringingChroma * 4,
  `luma=${neutral?.ringingLuma.toFixed(3)} chroma=${neutral?.ringingChroma.toFixed(3)}`,
);

// 5a. On a flat reference the luma/chroma separation is exact: an opposing
//     R/B ripple must read as pure chroma.
{
  const flat = makeRgba(REF_W, REF_H, () => [128, 128, 128]);
  const flatDec = boxDownscale(flat, REF_W, REF_H, DEC, DEC);
  const s = computeRinging(
    flat,
    addRipple(flatDec, [30, 0, -30]),
    REF_W,
    REF_H,
    DEC,
    DEC,
  );
  check(
    "on a flat reference a chroma ripple reads as pure chroma",
    s !== null && s.ringingChroma > 1 && s.ringingLuma === 0,
    `luma=${s?.ringingLuma.toFixed(3)} chroma=${s?.ringingChroma.toFixed(3)}`,
  );
}

// 5b. Near an edge the separation is partial, and that is inherent rather than
//     a defect: the envelope test is one-sided, so where the local range is
//     wide and sits asymmetrically about a pixel's value, one channel's
//     excursion clears the envelope while the opposite channel's does not. The
//     residual reads as luma. Chroma must still dominate — that is the
//     discrimination `spec/RATIONALE.md` §255 needs (chroma quantization noise
//     vs luma ringing) — but expecting a clean split next to an edge would be
//     expecting the wrong thing.
{
  const s = computeRinging(
    reference,
    addRipple(lowpass, [30, 0, -30]),
    REF_W,
    REF_H,
    DEC,
    DEC,
  );
  check(
    "near an edge a chroma ripple still reads mostly as chroma",
    s !== null && s.ringingChroma > s.ringingLuma * 1.5,
    `luma=${s?.ringingLuma.toFixed(3)} chroma=${s?.ringingChroma.toFixed(3)}`,
  );
  // 6. The decomposition is orthogonal, so the aggregate must be Pythagorean.
  if (s !== null) {
    const lhs = s.ringing ** 2;
    const rhs = s.ringingLuma ** 2 + s.ringingChroma ** 2;
    check(
      "ringing^2 = ringingLuma^2 + ringingChroma^2",
      Math.abs(lhs - rhs) < 1e-6 * Math.max(1, lhs),
      `${lhs.toFixed(6)} vs ${rhs.toFixed(6)}`,
    );
  }
}

// 7. Severity ordering: a bigger overshoot must score higher.
{
  const small = computeRinging(
    reference,
    addRipple(lowpass, [10, 10, 10]),
    REF_W,
    REF_H,
    DEC,
    DEC,
  );
  check(
    "a larger overshoot scores higher than a smaller one",
    small !== null && neutral !== null && neutral.ringing > small.ringing,
    `amp10=${small?.ringing.toFixed(3)} amp30=${neutral?.ringing.toFixed(3)}`,
  );
}

// 7b. THE REGRESSION THIS SUITE ONCE MISSED.
//
// The checks above fix REF_W = 256 and DEC = 32, i.e. one upscale factor of 8.
// Two separate defects lived entirely outside that regime and shipped through a
// green run: a fixed 64-px cap on the window radius (which broke `r >= S`, so
// the score measured ordinary resolution loss once a decode fell below 16 px
// against a 512 px reference), and a bias correction applied to the decode but
// not to the envelope it was tested against (which broke the exact-zero
// property at every radius). On a logo -- large flat fields, one hard edge --
// a provably convex 4x3 decode scored 7.67, larger than the genuine ripple
// above.
//
// So sweep the decode sizes the real lineup produces, against the reference
// size it actually scores at, on the content shape that exposed it.
{
  const W = 512;
  const H = 341;
  // Logo-shaped: flat ground, one solid block, one hard edge. This is what
  // broke; a photograph did not.
  const logo = makeRgba(W, H, (x, y) => {
    const inMark = x > W * 0.2 && x < W * 0.55 && y > H * 0.25 && y < H * 0.7;
    return inMark ? [28, 78, 200] : [244, 244, 240];
  });
  // Fine periodic structure, the opposite failure shape.
  const text = makeRgba(W, H, (x, y) =>
    y % 7 < 3 && x % 5 < 3 ? [20, 20, 20] : [250, 250, 250],
  );
  const failures: string[] = [];
  for (const [label, ref] of [
    ["logo", logo],
    ["text", text],
  ] as const) {
    for (const long of [4, 6, 8, 12, 16, 24, 32, 64]) {
      const dw = Math.max(1, Math.round((W * long) / Math.max(W, H)));
      const dh = Math.max(1, Math.round((H * long) / Math.max(W, H)));
      // A box average is a convex combination of the samples it covers, so by
      // the metric's central property it cannot overshoot. Anything above zero
      // here is a false positive.
      const s = computeRinging(
        ref,
        boxDownscale(ref, W, H, dw, dh),
        W,
        H,
        dw,
        dh,
      );
      if (s === null || s.ringing > 0) {
        failures.push(
          `${label} ${dw}x${dh}=${s?.ringing.toFixed(3) ?? "null"}`,
        );
      }
    }
  }
  check(
    "a convex decode scores 0 at every decode size, not just the easy one",
    failures.length === 0,
    failures.length === 0
      ? "16 sizes x 2 content shapes, 4px to 64px against a 512px reference"
      : `false positives: ${failures.join(", ")}`,
  );
}

// 8. Degenerate rasters must not throw or produce NaN.
{
  const solid = makeRgba(8, 8, () => [120, 120, 120]);
  const one = makeRgba(1, 1, () => [120, 120, 120]);
  const s1 = computeRinging(solid, one, 8, 8, 1, 1);
  const s2 = computeRinging(one, one, 1, 1, 1, 1);
  check(
    "degenerate rasters score finite",
    s1 !== null &&
      Number.isFinite(s1.ringing) &&
      s2 !== null &&
      Number.isFinite(s2.ringing),
    `8x8<-1x1=${s1?.ringing.toFixed(3)} 1x1=${s2?.ringing.toFixed(3)}`,
  );
  check(
    "a solid reference with a matching solid decode scores 0",
    s1 !== null && s1.ringing === 0,
    `ringing=${s1?.ringing}`,
  );
}

console.log("\nspurious detail — the properties that metric is built on\n");

/**
 * Add a sinusoid to a decode at a chosen orientation. `fx`/`fy` are cycles
 * across the decode's width/height, so `(f, 0)` varies along x and is constant
 * down y — vertical stripes.
 */
function addWave(
  base: Uint8Array,
  w: number,
  h: number,
  fx: number,
  fy: number,
  amp: number,
): Uint8Array {
  const out = new Uint8Array(base);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v =
        amp *
        Math.cos((2 * Math.PI * fx * (x + 0.5)) / w) *
        Math.cos((2 * Math.PI * fy * (y + 0.5)) / h);
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[p + c] = Math.max(
          0,
          Math.min(255, Math.round((out[p + c] ?? 0) + v)),
        );
      }
    }
  }
  return out;
}

// S1. Identity: a decode that is the reference has no energy the reference
//     lacks -- and, the other way round, none the reference has that it lacks.
//     Both halves, for the reason S2/S3b/S3c/P1 assert both: `deficit` shares a
//     loop and a dead zone with `spurious` but faces the other way, so a defect
//     confined to its side of the subtraction is invisible to a spurious-only
//     assertion. The identity pair is also the one case that needs no rounding
//     argument at all -- both spectra come from the same buffer, so both scores
//     must be exactly zero.
{
  const s = computeSpurious(reference, reference, REF_W, REF_H, REF_W, REF_H);
  check(
    "identity scores 0 spurious AND 0 deficit",
    s !== null && s.spurious === 0 && s.deficit === 0,
    `spurious=${s?.spurious} deficit=${s?.deficit}`,
  );
}

// S2. THE null hypothesis, and the direct analogue of the ringing suite's:
//     the ideal low-pass decode scores exactly 0. Swept over decode sizes and
//     content shapes for the reason §7b of the ringing suite records — a single
//     upscale factor hid two defects once already.
{
  const W = 512;
  const H = 341;
  const logo = makeRgba(W, H, (x, y) => {
    const inMark = x > W * 0.2 && x < W * 0.55 && y > H * 0.25 && y < H * 0.7;
    return inMark ? [28, 78, 200] : [244, 244, 240];
  });
  const text = makeRgba(W, H, (x, y) =>
    y % 7 < 3 && x % 5 < 3 ? [20, 20, 20] : [250, 250, 250],
  );
  // A smooth ramp: the shape a false-contour metric would fire on, and the one
  // this metric must stay silent for, because a low-pass of a ramp is a ramp.
  const ramp = makeRgba(W, H, (x, y) => [
    Math.round((x / (W - 1)) * 255),
    Math.round((y / (H - 1)) * 255),
    128,
  ]);
  const failures: string[] = [];
  for (const [label, ref] of [
    ["logo", logo],
    ["text", text],
    ["ramp", ramp],
  ] as const) {
    for (const long of [4, 8, 16, 32, 64, 128, 256, 512]) {
      const dw = Math.max(1, Math.round((W * long) / Math.max(W, H)));
      const dh = Math.max(1, Math.round((H * long) / Math.max(W, H)));
      const s = computeSpurious(
        ref,
        boxDownscale(ref, W, H, dw, dh),
        W,
        H,
        dw,
        dh,
      );
      // Both scores, together: they are the same comparison with the sign
      // flipped, so the ideal low-pass has to be exactly zero on each. Deficit
      // is the one that could plausibly leak — its clamp faces the other way,
      // so a rounding asymmetry between the two sides would show up here and
      // nowhere in `spurious`.
      if (s === null || s.spurious > 0 || s.deficit > 0) {
        failures.push(
          `${label} ${dw}x${dh}=` +
            `spur ${s?.spurious.toFixed(4) ?? "null"} / ` +
            `def ${s?.deficit.toFixed(4) ?? "null"}`,
        );
      }
    }
  }
  check(
    "the ideal low-pass decode scores 0 spurious AND 0 deficit at every size",
    failures.length === 0,
    failures.length === 0
      ? "8 sizes x 3 content shapes, 4px to 512px against a 512px reference"
      : `false positives: ${failures.join(", ")}`,
  );
}

// The working pair for the orientation and ordering checks: a photograph-ish
// reference with structure on both axes, and its ideal low-pass decode.
const SW = 64;
const SH = 48;
const sRef = makeRgba(REF_W, REF_H, (x, y) => {
  const a = Math.sin((x / REF_W) * 6) * 40 + Math.cos((y / REF_H) * 4) * 30;
  return [128 + a, 120 + a * 0.5, 140 - a * 0.3];
});
const sDec = boxDownscale(sRef, REF_W, REF_H, SW, SH);

// S3. Energy the reference does not have must register.
const vertical = computeSpurious(
  sRef,
  addWave(sDec, SW, SH, 12, 0, 24),
  REF_W,
  REF_H,
  SW,
  SH,
);
check(
  "invented structure registers",
  vertical !== null && vertical.spurious > 1,
  `spurious=${vertical?.spurious.toFixed(3)}`,
);

// S3b. Deficit is the mirror, and has to behave like one: a decode that is
// *flatter* than the ideal low-pass has dropped structure the reference has, so
// deficit must rise while spurious stays at zero. Without this, `deficit` could
// be wired to the wrong side of the subtraction and every table would still
// look plausible — the two scores move together often enough that only a case
// built to separate them can tell.
{
  const flattened = new Uint8Array(sDec);
  for (let i = 0; i < SW * SH; i++) {
    for (let c = 0; c < 3; c++) {
      const v = flattened[i * 4 + c] ?? 0;
      flattened[i * 4 + c] = Math.round(128 + (v - 128) * 0.4);
    }
  }
  const s = computeSpurious(sRef, flattened, REF_W, REF_H, SW, SH);
  // `spurious` is asserted negligible rather than exactly zero, on the same
  // grounds as S8 below: the exact zero belongs to the ideal-low-pass case,
  // where both sides are the same array. Here the contracted decode carries its
  // own 8-bit rounding, and across ~9000 coefficients the largest residue
  // occasionally grazes the one-level dead zone. Measured at 0.006 against a
  // deficit of 14.5 — three orders of magnitude apart, which is the claim.
  check(
    "a decode flatter than the ideal low-pass scores deficit, not spurious",
    s !== null && s.deficit > 1 && s.spurious < 0.05,
    `deficit=${s?.deficit.toFixed(3)} spurious=${s?.spurious.toFixed(4)}`,
  );
}

// S3c. And the converse, on the same pair: adding energy the reference does not
// have must move `spurious` without moving `deficit` down past zero. Asserting
// both directions is what makes the pair a pair rather than two numbers that
// happen to be printed together.
// `deficit >= 0` was the original second conjunct here and asserted nothing:
// it is a sum of squares, so it holds for every input this function can be
// given, including one where deficit and spurious had been wired to the same
// side of the subtraction. The bound is absolute rather than relative for the
// same reason — this case measures deficit at exactly 0.000 against a spurious
// of 17.08, so a ratio test would divide by zero into another tautology.
check(
  "invented structure does not register as deficit",
  vertical !== null && vertical.spurious > 1 && vertical.deficit < 0.05,
  `spurious=${vertical?.spurious.toFixed(3)} deficit=${vertical?.deficit.toFixed(3)}`,
);

// S4/S5. Orientation. A pattern varying along x is *vertical* stripes; one
//        varying down y is horizontal. Getting this backwards is the perennial
//        error, so both directions are pinned.
check(
  "a pattern varying along x reads as vertical striping",
  vertical !== null &&
    vertical.spuriousVertical > vertical.spuriousHorizontal * 4 &&
    vertical.spuriousVertical > vertical.spuriousDiagonal * 4,
  `V=${vertical?.spuriousVertical.toFixed(3)} H=${vertical?.spuriousHorizontal.toFixed(3)} D=${vertical?.spuriousDiagonal.toFixed(3)}`,
);
{
  const s = computeSpurious(
    sRef,
    addWave(sDec, SW, SH, 0, 12, 24),
    REF_W,
    REF_H,
    SW,
    SH,
  );
  check(
    "a pattern varying down y reads as horizontal striping",
    s !== null &&
      s.spuriousHorizontal > s.spuriousVertical * 4 &&
      s.spuriousHorizontal > s.spuriousDiagonal * 4,
    `V=${s?.spuriousVertical.toFixed(3)} H=${s?.spuriousHorizontal.toFixed(3)} D=${s?.spuriousDiagonal.toFixed(3)}`,
  );
}
{
  // An oblique product term lands in the diagonal band. This is the one the
  // format's `aniso_oblique = 1.2` de-prioritises, so it has to be separable
  // from the other two or the sweep cannot see what the weight does.
  const s = computeSpurious(
    sRef,
    addWave(sDec, SW, SH, 9, 9, 24),
    REF_W,
    REF_H,
    SW,
    SH,
  );
  check(
    "an oblique pattern reads as diagonal",
    s !== null &&
      s.spuriousDiagonal > s.spuriousVertical &&
      s.spuriousDiagonal > s.spuriousHorizontal,
    `V=${s?.spuriousVertical.toFixed(3)} H=${s?.spuriousHorizontal.toFixed(3)} D=${s?.spuriousDiagonal.toFixed(3)}`,
  );
}

// S6. The three bands partition the frequency plane, so they must recombine in
//     quadrature exactly — the same contract ringing's luma/chroma split has.
if (vertical !== null) {
  const lhs = vertical.spurious ** 2;
  const rhs =
    vertical.spuriousVertical ** 2 +
    vertical.spuriousHorizontal ** 2 +
    vertical.spuriousDiagonal ** 2;
  check(
    "spurious^2 = vertical^2 + horizontal^2 + diagonal^2",
    Math.abs(lhs - rhs) < 1e-6 * Math.max(1, lhs),
    `${lhs.toFixed(6)} vs ${rhs.toFixed(6)}`,
  );
}

// S7. Severity ordering.
{
  const small = computeSpurious(
    sRef,
    addWave(sDec, SW, SH, 12, 0, 8),
    REF_W,
    REF_H,
    SW,
    SH,
  );
  check(
    "more invented structure scores higher",
    small !== null && vertical !== null && vertical.spurious > small.spurious,
    `amp8=${small?.spurious.toFixed(3)} amp24=${vertical?.spurious.toFixed(3)}`,
  );
}

// S8. Missing detail is free. A decode with *less* energy than the ideal
//     low-pass at every frequency must score nothing — losing detail is what
//     ΔE00, SSIMULACRA2 and DSSIM charge for. If this ever fails, the metric has
//     quietly become a second fidelity score.
//
//     Constructed by pulling every sample halfway to the plane's mean, which
//     halves every AC magnitude and leaves DC alone. Deliberately *not* by
//     upsampling from a coarser grid: a box upsample is nearest-neighbour
//     replication, so it is blocky rather than blurry and genuinely does invent
//     high-frequency structure. That construction scored 3.64 here, and the
//     metric was right — which is its own small piece of evidence that the
//     number sees blockiness.
{
  let mean = 0;
  for (let i = 0; i < sDec.length; i += 4) mean += sDec[i] ?? 0;
  mean /= sDec.length / 4;
  const flatter = new Uint8Array(sDec);
  for (let i = 0; i < flatter.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = flatter[i + c] ?? 0;
      flatter[i + c] = Math.round(v + (mean - v) * 0.5);
    }
  }
  //     Asserted as negligible rather than exactly zero, and the distinction is
  //     real. The exact zero belongs to the ideal-low-pass case above, where
  //     both sides are the *same array* and every excess is identically
  //     negative. Here the decode carries its own independent 8-bit rounding,
  //     which an orthonormal transform spreads over ~9000 coefficients; across
  //     that many, the largest occasionally grazes the one-level dead zone at a
  //     frequency where the reference has nothing. Measured at 0.005 against
  //     real scores of ~17, i.e. three orders of magnitude down. Demanding an
  //     exact zero here would be demanding that 8-bit rounding not exist.
  const s = computeSpurious(sRef, flatter, REF_W, REF_H, SW, SH);
  check(
    "a decode with less energy than the ideal low-pass scores ~0",
    s !== null && s.spurious < 0.05,
    `spurious=${s?.spurious.toFixed(4)}`,
  );
}

// S9. Degenerate rasters must not throw or produce NaN.
{
  const solid = makeRgba(8, 8, () => [120, 120, 120]);
  const one = makeRgba(1, 1, () => [120, 120, 120]);
  const s1 = computeSpurious(
    solid,
    boxDownscale(solid, 8, 8, 2, 2),
    8,
    8,
    2,
    2,
  );
  check(
    "degenerate rasters score finite, and a 1x1 grid is declined",
    s1 !== null &&
      Number.isFinite(s1.spurious) &&
      computeSpurious(one, one, 1, 1, 1, 1) === null,
    `8x8<-2x2=${s1?.spurious.toFixed(3)}`,
  );
}

console.log("\naspect — the properties that metric is built on\n");

// A1. Identity: a declared shape equal to the target has no error and no reflow.
{
  const s = aspectFidelity({ kind: "declared", width: 32, height: 21 }, 32, 21);
  check(
    "a declared shape equal to the target scores 0",
    s !== null && s.log2Error === 0 && s.errorPct === 0 && s.reflowPx === 0,
    `log2=${s?.log2Error} pct=${s?.errorPct} reflow=${s?.reflowPx}`,
  );
}

// A2. THE property the log2 form exists for. The ratio measure |AR_d/AR_t − 1|
//     scores 10% too wide as 10.00% and 10% too narrow as 9.09%, so a corpus
//     mean would be biased by the landscape/portrait mix of the corpus rather
//     than by any format. Symmetry about 1:1 is what removes that, and it is
//     the same property spec §8.1 builds the aspect encoding on.
{
  const wide = aspectFidelity(
    { kind: "declared", width: 110, height: 100 },
    100,
    100,
  );
  const narrow = aspectFidelity(
    { kind: "declared", width: 100, height: 110 },
    100,
    100,
  );
  check(
    "the error is symmetric under transposing the mistake",
    wide !== null &&
      narrow !== null &&
      Math.abs(wide.log2Error - narrow.log2Error) < 1e-12,
    `wide=${wide?.log2Error.toFixed(9)} narrow=${narrow?.log2Error.toFixed(9)}`,
  );
}

// A3. A format that declares no shape must return null rather than 0. Scoring
//     it as zero error would rank "carries no aspect at all" as perfect layout
//     fidelity, which is the opposite of the truth.
check(
  "a format with no declared size scores null, not 0",
  aspectFidelity({ kind: "absent", reason: "no aspect in payload" }, 32, 21) ===
    null,
  "absent -> null",
);

// A4. Degenerate inputs decline rather than returning Infinity or NaN, which
//     would poison a corpus mean silently.
check(
  "degenerate dimensions are declined",
  aspectFidelity({ kind: "declared", width: 0, height: 10 }, 32, 21) === null &&
    aspectFidelity({ kind: "declared", width: 10, height: 10 }, 0, 21) === null,
  "zero extents -> null",
);

// A5. The documented conversion between the two conventions must agree with the
//     value the metric reports, or the report's percent column and the spec's
//     §8.1 percent are different numbers wearing the same name.
{
  const s = aspectFidelity({ kind: "declared", width: 32, height: 21 }, 3, 2);
  check(
    "log2ToPct agrees with the reported errorPct",
    s !== null && Math.abs(log2ToPct(s.log2Error) - s.errorPct) < 1e-12,
    `log2=${s?.log2Error.toFixed(6)} pct=${s?.errorPct.toFixed(4)}%`,
  );
}

// A6. The reflow sign convention, which the report renders as a direction:
//     positive means the real image is TALLER than the placeholder reserved, so
//     content below it gets pushed down when the real image lands.
{
  const tooShort = aspectFidelity(
    { kind: "declared", width: 100, height: 50 },
    100,
    100,
  );
  check(
    "a placeholder shorter than the real image reflows positive",
    tooShort !== null && tooShort.reflowPx > 0,
    `reflow=${tooShort?.reflowPx.toFixed(1)}px for a 1000px container`,
  );
}

console.log("\nspurious — the pinned analysis grid\n");

// The grid pin is what every cross-tier artifact number in EXPERIMENTS.md §13
// rests on, and until these checks existed not one of the ten computeSpurious
// calls above passed a seventh argument: the parameter the conclusions depend
// on was the one parameter with no coverage at all.
//
// P1 is the null hypothesis one level down, and it is the one that mattered. An
// ideal low-pass must score exactly zero — unpinned, that is asserted above at
// 8 sizes; pinned, it was scoring 0.008 at 32->16, 0.020 at 64->32 and 0.032 at
// 128->64, a floor that grew with the pin ratio and therefore landed hardest on
// exactly the high tiers the pin exists to make comparable. The cause was in
// `idealSpectrum`: the decode reached a pinned grid through two roundings and
// the ideal through one.
{
  const failures: string[] = [];
  for (const [dw, dh] of [
    [32, 24],
    [64, 48],
    [128, 96],
    [16, 12],
  ] as const) {
    const dec = boxDownscale(sRef, REF_W, REF_H, dw, dh);
    for (const pin of [8, 16, 32, 64, 128]) {
      const s = computeSpurious(sRef, dec, REF_W, REF_H, dw, dh, pin);
      if (s === null || s.spurious > 0 || s.deficit > 0) {
        failures.push(
          `${dw}x${dh}@${pin}=spur ${s?.spurious.toFixed(4) ?? "null"} / def ${s?.deficit.toFixed(4) ?? "null"}`,
        );
      }
    }
  }
  check(
    "P1 the ideal low-pass scores 0 spurious AND 0 deficit at every pin",
    failures.length === 0,
    failures.length === 0
      ? "4 decode rasters x 5 pins, all exactly zero"
      : `false positives: ${failures.join(", ")}`,
  );
}

// P2. A pin at or above the decode's long edge cannot bind, so it must return
//     the unpinned score bit for bit rather than merely something close.
{
  const dec = addWave(sDec, SW, SH, 12, 0, 24);
  const bare = computeSpurious(sRef, dec, REF_W, REF_H, SW, SH);
  const wide = [SW, SW * 2, 512].map((pin) =>
    computeSpurious(sRef, dec, REF_W, REF_H, SW, SH, pin),
  );
  check(
    "P2 a pin at or above the decode's long edge is the unpinned score",
    bare !== null &&
      wide.every(
        (s) =>
          s !== null &&
          s.spurious === bare.spurious &&
          s.deficit === bare.deficit,
      ),
    `unpinned=${bare?.spurious.toFixed(6)} pinned=${wide.map((s) => s?.spurious.toFixed(6)).join(", ")}`,
  );
}

// P3. And a pin below it must actually bind. Without this, a pin silently
//     ignored — a dropped argument, a renamed field in the sweep config — would
//     leave every arm scored on its own raster while the table said otherwise,
//     which is precisely the §12.4 mistake the pin was added to prevent.
{
  const dec = addWave(sDec, SW, SH, 12, 0, 24);
  const bare = computeSpurious(sRef, dec, REF_W, REF_H, SW, SH);
  const pinned = computeSpurious(sRef, dec, REF_W, REF_H, SW, SH, 16);
  check(
    "P3 a pin below the decode's long edge changes the score",
    bare !== null && pinned !== null && pinned.spurious !== bare.spurious,
    `unpinned=${bare?.spurious.toFixed(4)} pinned@16=${pinned?.spurious.toFixed(4)}`,
  );
}

console.log("\nstratify — the joins §13.3 is read through\n");

// §13.3 is the one table in EXPERIMENTS.md that no sweep binds, so nothing
// downstream of these three functions would notice them being wrong: a
// mis-signed correlation, a bin that quietly held four images, or a positional
// join across two arms that were scored over different lists all print a table
// of exactly the right shape. Fixtures with answers known by hand, so the block
// runs with no sweep output and no corpus.

// T1. Pearson against a case whose answer is arithmetic, not a coincidence: a
//     series that is an exact affine function of the axis correlates ±1 to
//     floating point, in both directions. Getting the sign backwards is the
//     perennial error and it is what §13.3's whole reading turns on.
{
  const xs = [1, 2, 3, 4, 5, 6, 7];
  const up = xs.map((x) => 3 * x + 11);
  const down = xs.map((x) => -0.5 * x + 4);
  check(
    "an exact affine relation correlates +1 and its mirror -1",
    Math.abs(pearson(xs, up) - 1) < 1e-12 &&
      Math.abs(pearson(xs, down) + 1) < 1e-12,
    `up=${pearson(xs, up).toFixed(12)} down=${pearson(xs, down).toFixed(12)}`,
  );
}

// T2. And against a hand-computable value, so the check is not satisfied by a
//     function that only ever returns ±1. For xs = [1,2,3,4] and
//     ys = [1,3,2,4]: both are centred at 2.5, so the deviations are
//     [-1.5,-0.5,+0.5,+1.5] and [-1.5,+0.5,-0.5,+1.5], giving Sxy = 4 and
//     Sxx = Syy = 5, so r = 4/5 exactly.
{
  const r = pearson([1, 2, 3, 4], [1, 3, 2, 4]);
  check(
    "a partial relation scores its exact coefficient",
    Math.abs(r - 0.8) < 1e-12,
    `r=${r.toFixed(12)} (expected 0.8)`,
  );
}

// T3. The cases where a coefficient means nothing must return NaN rather than a
//     number: fewer than three pairs, a constant on either side, or two series
//     of different lengths. The table renders NaN as "—"; a 0 or a 1 here would
//     be printed as a finding.
{
  const flat = pearson([1, 2, 3, 4], [7, 7, 7, 7]);
  const short = pearson([1, 2], [3, 4]);
  const ragged = pearson([1, 2, 3, 4], [1, 2, 3]);
  check(
    "an undefined correlation is NaN, not a number",
    Number.isNaN(flat) && Number.isNaN(short) && Number.isNaN(ragged),
    `constant=${flat} n=2 ${short} ragged=${ragged}`,
  );
}

// T4. Equal-count terciles over 31 — the tune corpus's size, and the split
//     §13.3 prints. Every image lands in exactly one bin, the bins are within
//     one of each other, and they are contiguous in rank: a bin whose
//     membership was not an interval of the sorted order would make the
//     "smooth / mid / textured" column headings a lie while the means still
//     looked plausible.
{
  const ranks = Array.from({ length: 31 }, (_, i) => i);
  const bins = equalCountBins(ranks, 3);
  const sizes = bins.map((b) => b.length);
  const flat = bins.flat();
  const contiguous = bins.every((b) =>
    b.every((v, i) => i === 0 || v === (b[i - 1] ?? -1) + 1),
  );
  check(
    "31 images split into 3 contiguous, equal-count bins covering every image",
    flat.length === 31 &&
      new Set(flat).size === 31 &&
      Math.max(...sizes) - Math.min(...sizes) <= 1 &&
      contiguous &&
      (bins[0]?.[0] ?? -1) === 0 &&
      (bins[2]?.[bins[2].length - 1] ?? -1) === 30,
    `sizes=${sizes.join("/")}`,
  );
}

// T5. The degenerate bin counts the tool now rejects at the boundary, asserted
//     on the function rather than the CLI: one bin is the ungrouped mean and
//     more bins than images cannot be equal-count. Neither may lose or
//     duplicate an image on the way.
{
  const ranks = Array.from({ length: 5 }, (_, i) => i);
  const one = equalCountBins(ranks, 1);
  const many = equalCountBins(ranks, 8);
  check(
    "binning neither drops nor duplicates an image at the degenerate counts",
    one.length === 1 &&
      one[0]?.length === 5 &&
      many.length === 8 &&
      many.flat().length === 5 &&
      new Set(many.flat()).size === 5,
    `1 bin=${one[0]?.length} 8 bins=[${many.map((b) => b.length).join(",")}]`,
  );
}

// T6. The positional join. Every arm's per-image series is read as parallel to
//     the first arm's image list; sweep.ts scores every arm over one input list
//     so that holds today, but nothing requires it, and a filtered or reordered
//     row would build a table of the right shape out of mismatched pairs.
{
  const aligned = [
    { label: "a", imageNames: ["p", "q", "r"] },
    { label: "b", imageNames: ["p", "q", "r"] },
  ];
  const shortArm = [
    { label: "a", imageNames: ["p", "q", "r"] },
    { label: "b", imageNames: ["p", "q"] },
  ];
  const reordered = [
    { label: "a", imageNames: ["p", "q", "r"] },
    { label: "b", imageNames: ["p", "r", "q"] },
  ];
  const shortMsg = alignmentError(shortArm) ?? "";
  const reorderMsg = alignmentError(reordered) ?? "";
  check(
    "aligned arms pass, and a short or reordered arm is refused by name",
    alignmentError(aligned) === null &&
      shortMsg.includes('"b"') &&
      shortMsg.includes("2 images") &&
      reorderMsg.includes('"r"') &&
      reorderMsg.includes("position 1"),
    `short=${JSON.stringify(shortMsg.slice(0, 48))} reorder=${JSON.stringify(reorderMsg.slice(0, 48))}`,
  );
}

// T7. An empty sweep is refused rather than treated as aligned — the vacuous
//     truth is exactly the answer that produces an empty table and exit 0.
check(
  "a sweep with no rows is refused",
  alignmentError([]) !== null,
  `${alignmentError([])}`,
);

console.log(
  "\ninference — the intervals, adjustments and guards sweeps read\n",
);

// Every verdict a sweep prints now turns on these: a Holm adjustment that
// failed to be monotone, a correlation threshold off by a degree of freedom,
// or a guard that read the wrong end of an interval would each print a table
// of exactly the right shape. Answers known by hand or from standard tables.

// S1. Holm against a worked family: sorted .005 .01 .03 .04 scale by 4 3 2 1
//     to .02 .03 .06 .04, and monotonicity lifts the last to .06. Returned in
//     input order, with a non-finite entry left out of m and passed through.
{
  const adjusted = holm([0.01, 0.04, 0.03, 0.005, Number.NaN]);
  const want = [0.03, 0.06, 0.06, 0.02];
  check(
    "Holm scales by the step-down multipliers, stays monotone, keeps input order",
    want.every((w, i) => Math.abs((adjusted[i] ?? 0) - w) < 1e-12) &&
      Number.isNaN(adjusted[4]),
    `adjusted=${adjusted.map((p) => p.toFixed(3)).join(" ")}`,
  );
}

// S2. The t quantile and the correlation threshold it gives. t(0.975, 29) is
//     2.0452 in every table; r_crit = t/√(df + t²) = 0.3550 at n = 31, the
//     threshold §13.5 quotes. And the Fisher-z interval at r = 0.29, n = 31:
//     atanh(0.29) ± 1.95996/√28 mapped back is [−0.0717, 0.5843].
{
  const t = studentTQuantile(0.975, 29);
  const inf = correlationInference(0.29, 31);
  check(
    "t(0.975, 29), the n = 31 threshold and a Fisher-z interval match tables",
    Math.abs(t - 2.04523) < 1e-5 &&
      inf !== null &&
      Math.abs(inf.rCritical - 0.35505) < 1e-5 &&
      inf.ci !== null &&
      Math.abs(inf.ci[0] + 0.07171) < 1e-4 &&
      Math.abs(inf.ci[1] - 0.5843) < 1e-4 &&
      Math.abs(normalQuantile(0.975) - 1.959964) < 1e-6,
    `t=${t.toFixed(5)} rcrit=${inf?.rCritical.toFixed(5)} ci=${inf?.ci?.map((v) => v.toFixed(4)).join(",")}`,
  );
}

// S2b. The correlation t-test p, which §13.5's "survives Holm" readings rest
//      on. t = r·√(29/(1 − r²)) on 29 df, two-sided, against a direct
//      numerical integral of the t density: r = 0.29 gives t = 1.63182 and
//      p = 0.113530; r = 0.5 gives t = 3.10913 and p = 0.0041806. The sign of r
//      does not move p, and at r = rCritical p is α exactly — the test and the
//      threshold solve the same equation.
{
  const at29 = correlationInference(0.29, 31);
  const neg29 = correlationInference(-0.29, 31);
  const at50 = correlationInference(0.5, 31);
  const atCrit =
    at29 === null ? null : correlationInference(at29.rCritical, 31);
  check(
    "correlation p matches the t distribution, is symmetric in r, and is α at the threshold",
    at29 !== null &&
      neg29 !== null &&
      at50 !== null &&
      atCrit !== null &&
      Math.abs(at29.p - 0.1135304) < 1e-6 &&
      Math.abs(neg29.p - at29.p) < 1e-12 &&
      Math.abs(at50.p - 0.0041806) < 1e-6 &&
      Math.abs(atCrit.p - 0.05) < 1e-6,
    `p(0.29)=${at29?.p.toFixed(7)} p(−0.29)=${neg29?.p.toFixed(7)} p(0.5)=${at50?.p.toFixed(7)} p(rcrit)=${atCrit?.p.toFixed(7)}`,
  );
}

// S3. The bootstrap p at its two ends: two bit-identical arms (every delta 0)
//     are p = 1, and a delta that is positive on every image is at the floor
//     2/(B + 1) rather than 0.
{
  const same = bootstrapP([0, 0, 0, 0]);
  const always = bootstrapP([0.1, 0.2, 0.3, 0.4]);
  check(
    "bootstrap p is 1 for identical arms and 2/(B+1) for a one-signed delta",
    same === 1 && Math.abs(always - 2 / 10_001) < 1e-12,
    `identical=${same} one-signed=${always}`,
  );
}

// S3b. The percentile bootstrap against the normal and t intervals, the claim
//      EXPERIMENTS.md §13.6's Assumptions paragraph makes. On 1..14 (n = 14,
//      SD = √17.5 = 4.18330), the normal 95% interval of the mean is
//      2 · 1.959964 · SD/√14 = 4.38262 wide and the t one, on 13 df,
//      2 · 2.160369 · SD/√14 = 4.83074. The bootstrap resamples the empirical
//      distribution, whose SD is the plug-in SD·√(13/14), so its interval
//      should be about 4.38262 · √(13/14) = 4.22318 wide: narrower than both,
//      by √(13/14) against the normal one. The 3% tolerance is the Monte Carlo
//      error of two percentiles at B = 10,000 plus the lattice the means of 14
//      integers fall on.
{
  const sample = Array.from({ length: 14 }, (_, i) => i + 1);
  const [lo, hi] = bootstrapCI(sample);
  const width = hi - lo;
  const se = Math.sqrt(17.5) / Math.sqrt(14);
  const normal = 2 * normalQuantile(0.975) * se;
  const t = 2 * studentTQuantile(0.975, 13) * se;
  const plugIn = normal * Math.sqrt(13 / 14);
  check(
    "the percentile bootstrap is about the plug-in width, narrower than the normal and t intervals",
    Math.abs(normal - 4.38262) < 1e-4 &&
      Math.abs(t - 4.83074) < 1e-4 &&
      Math.abs(width / plugIn - 1) < 0.03 &&
      width < normal &&
      normal < t &&
      Math.abs((lo + hi) / 2 - 7.5) < 0.05,
    `bootstrap ${width.toFixed(4)} [${lo.toFixed(3)}, ${hi.toFixed(3)}], plug-in ${plugIn.toFixed(4)}, normal ${normal.toFixed(4)}, t ${t.toFixed(4)}`,
  );
}

// S4. The guard verdict reads the right end of each interval, in all three
//     states. SSIMULACRA2's tolerance is a floor on the lower bound; a relative
//     guard's is a ceiling on the upper bound, scaled by the incumbent's mean.
{
  const stat = (
    key: "ssimulacra2" | "butteraugli" | "ringing" | "spurious",
    ci: [number, number],
    baseMean: number,
  ) => ({
    key,
    label: key,
    better: key === "ssimulacra2" ? ("higher" as const) : ("lower" as const),
    pairs: 31,
    baseMean,
    meanDelta: (ci[0] + ci[1]) / 2,
    ci,
    p: 0.5,
    pHolm: 0.5,
  });
  const tol = { ssimulacra2Drop: 1, relativeRise: 0.02 };
  const arm = (ssim: [number, number], butter: [number, number]) => ({
    label: "arm",
    stats: [stat("ssimulacra2", ssim, -300), stat("butteraugli", butter, 50)],
  });
  // Butteraugli's margin is 0.02 × 50 = 1.0.
  const ok = guardVerdictOnIntervals(arm([-0.9, 2], [-1, 0.9]), tol, undefined);
  const straddle = guardVerdictOnIntervals(
    arm([-1.5, 2], [-1, 0.9]),
    tol,
    undefined,
  );
  const shown = guardVerdictOnIntervals(
    arm([-0.5, 2], [1.1, 3]),
    tol,
    undefined,
  );
  const unscored = guardVerdictOnIntervals(undefined, tol, undefined);
  check(
    "interval guards: inside = ok, straddling = inconclusive, beyond = FAIL",
    ok === "ok" &&
      straddle === "inconclusive" &&
      shown === "FAIL" &&
      unscored === "ok",
    `inside=${ok} straddle=${straddle} beyond=${shown} unscored=${unscored}`,
  );

  // S4b. The artifact guards, which apply only where the run declared an
  //      artifactRise. Spurious has an incumbent mean of 10, so at rise 0.5
  //      its margin is 5. Ringing has an incumbent mean of 0, where a relative
  //      margin would be 0 and any rise at all a FAIL; the margin is the
  //      ARTIFACT_ZERO_BASE_ALLOWANCE instead. Each is driven through all
  //      three states with the other guards held at ok, and a ringing interval
  //      that would FAIL is ignored when no artifactRise is declared.
  const zero = ARTIFACT_ZERO_BASE_ALLOWANCE;
  const withArtifacts = (ring: [number, number], spur: [number, number]) => ({
    label: "arm",
    stats: [
      stat("ssimulacra2", [-0.5, 2], -300),
      stat("butteraugli", [-1, 0.5], 50),
      stat("ringing", ring, 0),
      stat("spurious", spur, 10),
    ],
  });
  const verdict = (ring: [number, number], spur: [number, number]) =>
    guardVerdictOnIntervals(withArtifacts(ring, spur), tol, 0.5);
  const artifactStates = {
    ringOk: verdict([0, zero - 0.1], [-1, 4]),
    ringStraddle: verdict([0, zero + 0.1], [-1, 4]),
    ringBeyond: verdict([zero + 0.1, zero + 1], [-1, 4]),
    spurOk: verdict([0, 0.5], [-1, 4.9]),
    spurStraddle: verdict([0, 0.5], [4, 6]),
    spurBeyond: verdict([0, 0.5], [5.1, 6]),
    undeclared: guardVerdictOnIntervals(
      withArtifacts([zero + 0.1, zero + 1], [5.1, 6]),
      tol,
      undefined,
    ),
  };
  check(
    "artifact guards: zero-incumbent allowance and relative margin, in all three states, only when declared",
    zero > 0 &&
      artifactStates.ringOk === "ok" &&
      artifactStates.ringStraddle === "inconclusive" &&
      artifactStates.ringBeyond === "FAIL" &&
      artifactStates.spurOk === "ok" &&
      artifactStates.spurStraddle === "inconclusive" &&
      artifactStates.spurBeyond === "FAIL" &&
      artifactStates.undeclared === "ok",
    JSON.stringify(artifactStates),
  );
}

// S5. compareArms against a reference other than row 0: Δ is arm − reference
//     with that sign, the reference is not compared with itself, and Holm's m
//     is the number of arms compared. An arm identical to the reference scores
//     Δ = 0 and p = 1.
{
  const rows = [
    { label: "a", perImage: { ciede2000: [10, 11, 12, 13] } },
    { label: "ref", perImage: { ciede2000: [9, 10, 11, 12] } },
    { label: "same", perImage: { ciede2000: [9, 10, 11, 12] } },
  ];
  const cmps = compareArms(rows, 1);
  const a = cmps.find((c) => c.label === "a")?.stats[0];
  const same = cmps.find((c) => c.label === "same")?.stats[0];
  check(
    "compareArms: arm − reference, reference excluded, Holm over the arms",
    cmps.length === 2 &&
      a !== undefined &&
      a.meanDelta === 1 &&
      a.ci[0] === 1 &&
      Math.abs(a.pHolm - 2 * a.p) < 1e-12 &&
      same !== undefined &&
      same.meanDelta === 0 &&
      same.p === 1,
    `labels=${cmps.map((c) => c.label).join(",")} Δa=${a?.meanDelta} pa=${a?.p} pHolm=${a?.pHolm} Δsame=${same?.meanDelta}`,
  );
}

console.log("\nverify-benchmark — what passes, what is skipped, what fails\n");

// Fixtures: a run is a list of cell ids plus what it recorded unavailable, and
// a table is markdown parsed exactly as PERFORMANCE.md is. The binding reads
// `encode/<row label>/t1` and throws on a missing cell, as §7's binding does.

function fixtureRun(
  file: string,
  ids: string[],
  unavailable?: RunDoc["unavailable"],
  overrides: Partial<RunDoc> = {},
): RunDoc {
  return {
    file,
    schema: "chromahash-perf/2",
    git: { commit: "abc1234", dirty: false },
    environment: { cpuModel: "fixture", arch: "x64", cores: 1 },
    config: { mode: "bounded", reps: 1 },
    cells: ids.map((id) => ({
      id,
      nsPerOp: 1_000_000,
      medianNsPerOp: 1_000_000,
      iqrPct: 0,
      noisy: false,
      iters: 1,
    })),
    ...(unavailable ? { unavailable } : {}),
    ...overrides,
  };
}

type UnavailableEntry = NonNullable<RunDoc["unavailable"]>[number];

/** An `unavailable` record as the driver writes it; no kind means a pre-kind run. */
function unavailableEntry(
  target: string,
  reason: string,
  kind: string | undefined,
): UnavailableEntry {
  return kind === undefined ? { target, reason } : { target, reason, kind };
}

const FIXTURE_BINDING: Binding = {
  section: "7",
  index: 0,
  title: "fixture",
  columns: {
    "encode t1": (row, R) => R.us(`encode/${clean(row("implementation"))}/t1`),
  },
};

function fixtureTable(rows: [string, string][]): string {
  return [
    "## 7. Fixture",
    "",
    "| implementation | encode t1 |",
    "|---|---:|",
    ...rows.map(([label, cell]) => `| ${label} | ${cell} |`),
    "",
  ].join("\n");
}

function gate(
  rows: [string, string][],
  runs: RunDoc[],
): { failures: Failure[]; counters: Counters; R: Runs } {
  const table = parseTables(fixtureTable(rows))[0];
  const failures: Failure[] = [];
  const counters: Counters = {
    checked: 0,
    unbound: 0,
    placeholders: 0,
    pending: 0,
    withheld: 0,
    unavailable: 0,
    tolerated: 0,
  };
  const edits: Edit[] = [];
  const R = new Runs(runs);
  if (table) checkTable(FIXTURE_BINDING, table, R, failures, counters, edits);
  return { failures, counters, R };
}

const details = (fs: Failure[]): string =>
  fs.map((f) => f.detail ?? f.measured).join(" | ");

const SWIFT_ABSENT = [
  { target: "Swift", reason: "spawnSync ChromaHashCLI ENOENT", kind: "absent" },
];

// B1. The marker is a token, not prose: emphasis required, host from a closed
//     list. The first version matched any phrase ending in "only", and every
//     bound cell runs through it.
{
  const accepted = ["*macOS only*", "**macOS only**", " *Linux only* "];
  const rejected = [
    "macOS only",
    "*encoder only*",
    "*batch only*",
    "*macOS only* (see §0)",
    "*macos only*",
    "",
  ];
  const wrongly = [
    ...accepted.filter((c) => parseUnavailableMarker(c) === null),
    ...rejected.filter((c) => parseUnavailableMarker(c) !== null),
  ];
  check(
    "a marker needs its emphasis and a known host; prose ending in 'only' is not one",
    wrongly.length === 0 &&
      parseUnavailableMarker("*macOS only*") === "macOS only",
    wrongly.length === 0
      ? `${accepted.length} accepted, ${rejected.length} rejected`
      : `misread: ${JSON.stringify(wrongly)}`,
  );
}

// B2. An absent target's marked row is skipped and counted — the one case
//     the skip exists for.
{
  const { failures, counters } = gate(
    [
      ["Rust", "1.0 ms"],
      ["Swift", "*macOS only*"],
    ],
    [fixtureRun("perf-report.json", ["encode/Rust/t1"], SWIFT_ABSENT)],
  );
  check(
    "an absent target's marked row is skipped, and the measured row checked",
    failures.length === 0 &&
      counters.unavailable === 1 &&
      counters.checked === 1,
    `failures=${failures.length} unavailable=${counters.unavailable} checked=${counters.checked}`,
  );
}

// B3. A *number* on an absent target is failed: nothing measured it. This is
//     the case the skip used to wave through.
{
  const { failures } = gate(
    [["Swift", "1.0 ms"]],
    [fixtureRun("perf-report.json", ["encode/Rust/t1"], SWIFT_ABSENT)],
  );
  check(
    "a documented number on an absent target fails",
    failures.length === 1 &&
      (failures[0]?.detail ?? "").includes("no committed run measured Swift"),
    details(failures),
  );
}

// B4/B5. Only `absent` may be skipped. A probe that found the target and saw
//        it fail is a regression, and a run too old to say which it saw cannot
//        be trusted to mean "absent" — both fail even with a marker.
for (const [label, kind, needle] of [
  ["broken", "broken", "regression in the target"],
  ["unclassified (no kind)", undefined, "before absent/broken"],
  ["unrecognised-kind", "missing", "before absent/broken"],
] as const) {
  const { failures, counters } = gate(
    [["Swift", "*macOS only*"]],
    [
      fixtureRun(
        "perf-report.json",
        ["encode/Rust/t1"],
        [unavailableEntry("Swift", "exit 1\nstack", kind)],
      ),
    ],
  );
  check(
    `the marked row of a target recorded ${label} fails rather than being skipped`,
    failures.length === 1 &&
      counters.unavailable === 0 &&
      (failures[0]?.detail ?? "").includes(needle),
    details(failures),
  );
}

// B6. Across two runs, `broken` outranks `absent` in either order: if any run
//     got far enough to see the target fail, "not built here" is not the story.
for (const order of ["absent first", "broken first"] as const) {
  const a = fixtureRun("perf-report-full.json", [], SWIFT_ABSENT);
  const b = fixtureRun(
    "perf-report.json",
    [],
    [{ target: "Swift", reason: "exit 1", kind: "broken" }],
  );
  const R = new Runs(order === "absent first" ? [a, b] : [b, a]);
  check(
    `broken outranks absent across runs (${order})`,
    R.unavailable.get("Swift")?.kind === "broken",
    `kind=${R.unavailable.get("Swift")?.kind}`,
  );
}

// B7. The clearing pass is order-independent: a target one run measured and
//     another recorded absent is measured, whichever file is read first. It
//     used to clear only against the same file's cells, so the full sweep on
//     macOS (Swift present) read before the bounded one on Linux (Swift
//     absent) left Swift marked unavailable while cells held it.
for (const order of ["measured first", "absent first"] as const) {
  const measured = fixtureRun("perf-report-full.json", [
    "encode/Rust/t1",
    "encode/Swift/t1",
  ]);
  const absent = fixtureRun(
    "perf-report.json",
    ["encode/Rust/t1"],
    SWIFT_ABSENT,
  );
  const runs =
    order === "measured first" ? [measured, absent] : [absent, measured];
  const kept = new Runs(runs).unavailable.has("Swift");
  const ok = gate([["Swift", "1.0 ms"]], runs);
  const marked = gate([["Swift", "*macOS only*"]], runs);
  check(
    `a target any run measured is not unavailable (${order})`,
    !kept &&
      ok.failures.length === 0 &&
      ok.counters.checked === 1 &&
      marked.failures.length === 1 &&
      (marked.failures[0]?.detail ?? "").includes(
        "but a committed run measured Swift",
      ),
    `stillUnavailable=${kept} numberFailures=${ok.failures.length} marker=${details(marked.failures)}`,
  );
}

// B8. A marker on a target no run probed at all (`--impls Rust`) is failed
//     with that reason, not with the false claim that a run measured it.
{
  const { failures } = gate(
    [["Swift", "*macOS only*"]],
    [fixtureRun("perf-report.json", ["encode/Rust/t1"])],
  );
  check(
    "a marker on a never-probed target fails as never probed",
    failures.length === 1 &&
      (failures[0]?.detail ?? "").includes("never probed"),
    details(failures),
  );
}

// B9. A parenthesised target name matches its own record. `bare()` strips the
//     parenthetical, and "Rust (scalar)" is a driver target name verbatim.
{
  const { failures, counters } = gate(
    [["Rust (scalar)", "*x86_64 only*"]],
    [
      fixtureRun(
        "perf-report.json",
        ["encode/Rust/t1"],
        [{ target: "Rust (scalar)", reason: "ENOENT", kind: "absent" }],
      ),
    ],
  );
  check(
    "a parenthesised absent target is found and its marked row skipped",
    failures.length === 0 && counters.unavailable === 1,
    `failures=${details(failures)} unavailable=${counters.unavailable}`,
  );
}

// B10. A run in the wrong schema is rejected, not merged: /1 reported medians
//      and /2 reports minima. A dirty run is loaded and listed as dirty.
{
  const R = new Runs([
    fixtureRun("old.json", ["encode/Rust/t1"], undefined, {
      schema: "chromahash-perf/1",
    }),
    fixtureRun("dirty.json", ["encode/Go/t1"], undefined, {
      git: { commit: "abc1234", dirty: true },
    }),
  ]);
  check(
    "a wrong-schema run is rejected and a dirty run is flagged",
    R.rejected.length === 1 &&
      R.rejected[0]?.startsWith("old.json") === true &&
      !R.has("encode/Rust/t1") &&
      R.loaded.length === 1 &&
      R.dirty.join() === "dirty.json",
    `rejected=${JSON.stringify(R.rejected)} dirty=${JSON.stringify(R.dirty)}`,
  );
}

// S1–S7. §0's host-stability claim: two bounded sweeps at one commit, every
//        shared cell within CROSS_RUN_TOLERANCE, and §0's table row saying
//        what the check says. The committed tree holds one bounded run, so
//        only the skip path runs there; pass and every fail path are driven
//        from fixtures.

/** A run whose cells take the given microseconds. */
function timedRun(
  file: string,
  us: Record<string, number>,
  overrides: Partial<RunDoc> = {},
): RunDoc {
  const run = fixtureRun(file, Object.keys(us), undefined, overrides);
  return {
    ...run,
    cells: run.cells.map((c) => ({
      ...c,
      nsPerOp: (us[c.id] ?? 0) * 1000,
      medianNsPerOp: (us[c.id] ?? 0) * 1000,
    })),
  };
}

/** §0's reproducibility table, holding the stability row with this cell. */
const stabilityDoc = (cell: string): string =>
  [
    "> | Claim | Reproducible from the tree? |",
    "> |---|---|",
    "> | Every table below equals a cell | **Yes** |",
    `> | This host's cross-run agreement | ${cell} |`,
  ].join("\n");

// S1. One bounded run: the check is skipped and says why. "No" is the honest
//     row; "Yes" fails, because nothing was compared.
{
  const s = checkStability(
    new Runs([timedRun("perf-report.json", { "encode/Rust/t1": 1000 })]),
  );
  const no = checkStabilityClaim(stabilityDoc("**No.** one sweep"), s);
  const yes = checkStabilityClaim(stabilityDoc("**Yes**"), s);
  check(
    "one bounded run skips the stability check; §0 may say No and may not say Yes",
    s.status === "skip" &&
      (s.problems[0] ?? "").includes("1 bounded run(s)") &&
      no.length === 0 &&
      yes.length === 1 &&
      (yes[0]?.detail ?? "").includes("did not pass"),
    `status=${s.status} no=${details(no)} yes=${details(yes)}`,
  );
}

// S2. Two bounded runs at one commit, within the bar: pass. "No" now
//     understates the tree and fails; "Yes" must quote the check's figures.
{
  const R = new Runs([
    timedRun("perf-report.json", {
      "encode/Rust/t1": 1000,
      "decode/Rust": 200,
    }),
    timedRun("perf-report-2.json", {
      "encode/Rust/t1": 1050,
      "decode/Rust": 204,
    }),
  ]);
  const s = checkStability(R);
  const no = checkStabilityClaim(stabilityDoc("**No.**"), s);
  const plain = checkStabilityClaim(stabilityDoc("**Yes**"), s);
  const quoted = checkStabilityClaim(
    stabilityDoc("**Yes** — 2 shared cells, widest 5.0%"),
    s,
  );
  const stale = checkStabilityClaim(
    stabilityDoc("**Yes** — 12 shared cells, widest 5.5%"),
    s,
  );
  check(
    "two agreeing bounded runs pass, and §0 must say Yes with their figures",
    s.status === "pass" &&
      s.shared === 2 &&
      Math.abs((s.widest ?? 0) - 0.05) < 1e-9 &&
      R.crossRunSpread.length === 0 &&
      no.length === 1 &&
      (no[0]?.detail ?? "").includes("understates") &&
      plain.length === 1 &&
      quoted.length === 0 &&
      stale.length === 1 &&
      (stale[0]?.detail ?? "").includes('"2 shared cells", "widest 5.0%"'),
    `status=${s.status} shared=${s.shared} widest=${s.widest} no=${details(no)} plain=${details(plain)} quoted=${details(quoted)} stale=${details(stale)}`,
  );
}

// S3. A shared cell outside the bar fails the check and is itself listed as a
//     spread — the gate turns each into a failure, not a warning.
{
  const R = new Runs([
    timedRun("perf-report.json", {
      "encode/Rust/t1": 1000,
      "decode/Rust": 200,
    }),
    timedRun("perf-report-2.json", {
      "encode/Rust/t1": 1200,
      "decode/Rust": 201,
    }),
  ]);
  const s = checkStability(R);
  check(
    "a bounded pair more than the tolerance apart on one cell fails",
    s.status === "fail" &&
      (s.problems[0] ?? "").includes("1 of 2 shared cell(s)") &&
      (s.problems[0] ?? "").includes("widest 20.0%") &&
      R.crossRunSpread.length === 1 &&
      (R.crossRunSpread[0] ?? "").startsWith("encode/Rust/t1:"),
    `status=${s.status} problems=${JSON.stringify(s.problems)} spread=${JSON.stringify(R.crossRunSpread)}`,
  );
}

// S4. Spread is pairwise. With the full sweep read first, the two bounded runs
//     were each compared with it and never with each other, so a pair 18.5%
//     apart — each under 10% from the full sweep — passed unnoticed. (A full
//     run holding bounded ids is itself a failure now, and the bounded value
//     is the one read: see V3.)
{
  const R = new Runs([
    timedRun(
      "perf-report-full.json",
      { "encode/Rust/t1": 1000 },
      {
        config: { mode: "full", reps: 1 },
      },
    ),
    timedRun("perf-report.json", { "encode/Rust/t1": 1090 }),
    timedRun("perf-report-2.json", { "encode/Rust/t1": 920 }),
  ]);
  const s = checkStability(R);
  check(
    "the two bounded runs are compared with each other, not only with the first run read",
    R.crossRunSpread.length === 1 &&
      (R.crossRunSpread[0] ?? "").includes("perf-report.json says 1090.0") &&
      (R.crossRunSpread[0] ?? "").includes("perf-report-2.json says 920.0") &&
      s.status === "fail" &&
      s.runs.join() === "perf-report.json,perf-report-2.json" &&
      R.overlaps.length === 2 &&
      R.us("encode/Rust/t1") === 1090,
    `spread=${JSON.stringify(R.crossRunSpread)} status=${s.status} runs=${s.runs.join()}`,
  );
}

// S5. The claim is one commit on one host measured twice. Agreeing runs from
//     two commits, from two CPUs filed under one host's directory, or from two
//     machines with one CPU model, do not substantiate it.
const FIXTURE_HOST = "unknown-x64-fixture";
for (const [label, first, overrides, needle] of [
  [
    "different commits",
    {},
    { git: { commit: "def5678", dirty: false } },
    "different commits",
  ],
  [
    "different CPUs under one host directory",
    {},
    {
      environment: { cpuModel: "other", arch: "x64", cores: 1 },
      hostDir: FIXTURE_HOST,
    },
    "different CPUs",
  ],
  [
    "different machines",
    { host: { id: FIXTURE_HOST, machine: "aaaaaaaaaaaa" } },
    { host: { id: FIXTURE_HOST, machine: "bbbbbbbbbbbb" } },
    "different machines",
  ],
] as const) {
  const s = checkStability(
    new Runs([
      timedRun("perf-report.json", { "encode/Rust/t1": 1000 }, first),
      timedRun("perf-report-2.json", { "encode/Rust/t1": 1000 }, overrides),
    ]),
  );
  check(
    `an agreeing bounded pair from ${label} fails`,
    s.status === "fail" && s.problems.some((p) => p.includes(needle)),
    `status=${s.status} problems=${JSON.stringify(s.problems)}`,
  );
}

// S6. Two bounded runs that share no cell compared nothing, and fail rather
//     than passing vacuously.
{
  const s = checkStability(
    new Runs([
      timedRun("perf-report.json", { "encode/Rust/t1": 1000 }),
      timedRun("perf-report-2.json", { "decode/Rust": 200 }),
    ]),
  );
  check(
    "a bounded pair with no shared cell fails instead of passing vacuously",
    s.status === "fail" &&
      s.shared === 0 &&
      s.problems.some((p) => p.includes("share no cell")),
    `status=${s.status} shared=${s.shared} problems=${JSON.stringify(s.problems)}`,
  );
}

// S7. §0 must carry the row, and it must answer Yes or No: a missing or
//     reworded row fails rather than exempting the claim from the check.
{
  const s = checkStability(
    new Runs([timedRun("perf-report.json", { "encode/Rust/t1": 1000 })]),
  );
  const missing = checkStabilityClaim("> | Claim | Reproducible? |", s);
  const vague = checkStabilityClaim(stabilityDoc("Partly"), s);
  check(
    "a missing or non-Yes/No stability row fails",
    missing.length === 1 &&
      (missing[0]?.detail ?? "").includes("must state") &&
      vague.length === 1 &&
      (vague[0]?.detail ?? "").includes('"Yes" or "No"'),
    `missing=${details(missing)} vague=${details(vague)}`,
  );
}

// B11. §1's baseline: every way of not having one is an error with a reason,
//      never a null that `checkTable` would count as deliberately unbound.
{
  const cell: StageCell = {
    ns: { whole_encode: 1000 },
    sharePct: { dct_forward: 100 },
    git: { rev: "abc1234", dirty: false },
  };
  const cases: [string, string | null, string][] = [
    ["no file", null, "does not exist"],
    ["unparseable", "{", "not valid JSON"],
    [
      "wrong schema",
      JSON.stringify({
        schema: "chromahash-perf-stages/0",
        cells: { a: cell },
      }),
      "expected chromahash-perf-stages/1",
    ],
    ["no schema", JSON.stringify({ cells: { a: cell } }), "schema (none)"],
    [
      "no cells",
      JSON.stringify({ schema: "chromahash-perf-stages/1", cells: {} }),
      "holds no cells",
    ],
  ];
  const wrong = cases.filter(([, text, needle]) => {
    const r = parseStages(text);
    return r.cells !== null || !(r.error ?? "").includes(needle);
  });
  const good = parseStages(
    JSON.stringify({
      schema: "chromahash-perf-stages/1",
      cells: { "100x100-t1": cell },
    }),
  );
  check(
    "a missing, unparseable, wrong-schema or empty stages file is an error",
    wrong.length === 0 && good.error === null && good.cells !== null,
    wrong.length === 0
      ? `${cases.length} refused, a valid file accepted`
      : `not refused: ${wrong.map(([n]) => n).join(", ")}`,
  );
}

// B12. §1's provenance: one clean commit across all three columns, or a
//      failure naming the cells that are not.
{
  const at = (rev: string, dirty: boolean): StageCell => ({
    ns: {},
    sharePct: {},
    git: { rev, dirty },
  });
  const clean3 = checkStagesProvenance({
    a: at("e53e6cd", false),
    b: at("e53e6cd", false),
    c: at("e53e6cd", false),
  });
  const dirty = checkStagesProvenance({
    a: at("e53e6cd", false),
    b: at("e53e6cd", true),
  });
  const mixed = checkStagesProvenance({
    a: at("e53e6cd", false),
    b: at("1111111", false),
  });
  const unrecorded = checkStagesProvenance({
    a: at("e53e6cd", false),
    b: { ns: {}, sharePct: {} } as unknown as StageCell,
  });
  check(
    "stage cells from a dirty tree or from different commits fail",
    clean3.length === 0 &&
      dirty.length === 1 &&
      dirty[0]?.column === "git.dirty" &&
      dirty[0]?.row === "b" &&
      mixed.length === 1 &&
      mixed[0]?.column === "git.rev" &&
      mixed[0]?.measured === "2 commits" &&
      unrecorded.some((f) => f.column === "git.rev"),
    `clean=${clean3.length} dirty=${JSON.stringify(dirty.map((f) => f.row))} mixed=${JSON.stringify(mixed.map((f) => f.measured))} unrecorded=${unrecorded.length}`,
  );
}

// B13. Prose claims: the figure must be quoted exactly once and agree with the
//      cells it sums, by the share rule — within half a point. The sum is the historical slip — 5.43 + 6.91 + 4.17 = 16.51,
//      which "16.5" states and "16.6" (the parts rounded first, then added)
//      does not exactly. Under the band, a 0.09-point slip is inside what a
//      re-recording moves a share by, and passes; 0.7 points does not, and
//      --fix rewrites it at the precision written.
{
  const stages: Record<string, StageCell> = {
    "512x512-t1": {
      ns: {},
      sharePct: { linearize: 5.43, oklab_forward: 6.91, composite: 4.17 },
      git: { rev: "e53e6cd", dirty: false },
    },
  };
  const claim: ProseClaim = {
    what: "pipeline",
    pattern: /the colour pipeline is ([\d.]+)%/,
    cell: "512x512-t1",
    stages: ["linearize", "oklab_forward", "composite"],
  };
  const right = checkProseClaims(
    "So the colour pipeline is 16.5% here.",
    stages,
    [claim],
  );
  const slip = checkProseClaims(
    "So the colour pipeline is 16.6% here.",
    stages,
    [claim],
  );
  const wrong = checkProseClaims(
    "So the colour pipeline is 17.2% here.",
    stages,
    [claim],
  );
  const finer = checkProseClaims(
    "So the colour pipeline is 16.52% here.",
    stages,
    [claim],
  );
  const gone = checkProseClaims("Reworded entirely.", stages, [claim]);
  const twice = checkProseClaims(
    "the colour pipeline is 16.5% and the colour pipeline is 16.5%",
    stages,
    [claim],
  );
  check(
    "a prose figure is checked once, within the share band, and a missing or doubled sentence fails",
    right.checked === 1 &&
      right.failures.length === 0 &&
      slip.failures.length === 0 &&
      wrong.failures.length === 1 &&
      wrong.failures[0]?.measured === "16.51%" &&
      wrong.edits.length === 1 &&
      wrong.edits[0]?.text === "16.5" &&
      "So the colour pipeline is 17.2% here.".slice(
        wrong.edits[0]?.index ?? 0,
        (wrong.edits[0]?.index ?? 0) + (wrong.edits[0]?.length ?? 0),
      ) === "17.2" &&
      finer.failures.length === 0 &&
      gone.failures.length === 1 &&
      (gone.failures[0]?.detail ?? "").includes("edited without updating") &&
      gone.checked === 0 &&
      twice.failures.length === 1 &&
      (twice.failures[0]?.detail ?? "").includes("must name one figure"),
    `right=${right.failures.length} slip=${slip.failures.length} wrong=${details(wrong.failures)} edits=${JSON.stringify(wrong.edits)} finer=${finer.failures.length} gone=${gone.failures.length} twice=${twice.failures.length}`,
  );
}

// B14. A prose claim bound to a cell or stage the baseline lacks fails. It
//      used to be skipped, so a claim pointing at the wrong cell never failed.
{
  const stages: Record<string, StageCell> = {
    "512x512-t1": {
      ns: {},
      sharePct: { linearize: 5.43 },
      git: { rev: "e53e6cd", dirty: false },
    },
  };
  const claim = (cell: string, stage: string): ProseClaim => ({
    what: "x",
    pattern: /is ([\d.]+)%/,
    cell,
    stages: [stage],
  });
  const noCell = checkProseClaims("is 5.4%", stages, [
    claim("100x100-t1", "linearize"),
  ]);
  const noStage = checkProseClaims(
    "is 5.4%",
    stages,
    [claim("512x512-t1", "composite")],
    "perf-decode-stages.json",
  );
  check(
    "a prose claim bound to a missing cell or stage fails, naming the baseline",
    noCell.failures.length === 1 &&
      noCell.checked === 0 &&
      (noCell.failures[0]?.detail ?? "").includes("has no cell 100x100-t1") &&
      noStage.failures.length === 1 &&
      (noStage.failures[0]?.detail ?? "").includes(
        "perf-decode-stages.json records no composite",
      ),
    `noCell=${details(noCell.failures)} noStage=${details(noStage.failures)}`,
  );
}

// B15. §1.1's baseline: refused on §1's terms, under its own schema.
{
  const cases: [string, string | null, string][] = [
    ["no file", null, "benchmark:decode-stages 100 100 4 20"],
    [
      "§1's schema",
      JSON.stringify({ schema: "chromahash-perf-stages/1", cells: { a: {} } }),
      "expected chromahash-perf-decode-stages/1",
    ],
    [
      "no cells",
      JSON.stringify({ schema: "chromahash-perf-decode-stages/1", cells: {} }),
      "holds no cells",
    ],
  ];
  const wrong = cases.filter(([, text, needle]) => {
    const r = parseDecodeStages(text);
    return r.cells !== null || !(r.error ?? "").includes(needle);
  });
  check(
    "a missing, wrong-schema or empty decode-stages file is an error",
    wrong.length === 0,
    wrong.length === 0
      ? "3 refused"
      : `not refused: ${wrong.map(([n]) => n).join(", ")}`,
  );
}

// B16. §1.1's provenance: a decode cell must say it reproduced the spec
//      vectors, be filed under the key its fields describe, and carry shares
//      that are its own ns over whole_decode.
{
  const good = (): DecodeStageCell => ({
    width: 100,
    height: 100,
    tier: 4,
    iters: 20,
    cap: { width: 32, height: 32 },
    render: { width: 32, height: 32 },
    hashBytes: 1623,
    vectorsChecked: 19,
    ns: {
      selection: 400,
      render: 590,
      unmarked: 10,
      stage_sum: 990,
      whole_decode: 1000,
    },
    sharePct: { selection: 40, render: 59, unmarked: 1 },
    git: { rev: "e68291e", dirty: false },
  });
  const run = (
    mut: (c: DecodeStageCell) => void,
    key = "100x100-t4-cap32x32",
  ) => {
    const c = good();
    mut(c);
    return checkDecodeStagesProvenance({ [key]: c }).map((f) => f.column);
  };
  const cases: [string, string[], string][] = [
    ["clean", run(() => {}), ""],
    [
      "no vector check",
      run((c) => {
        c.vectorsChecked = 0;
      }),
      "vectorsChecked",
    ],
    [
      "vector check absent",
      run((c) => {
        (c as { vectorsChecked: number | undefined }).vectorsChecked =
          undefined;
      }),
      "vectorsChecked",
    ],
    ["wrong key", run(() => {}, "100x100-t4-natural"), "key"],
    [
      "zero iters",
      run((c) => {
        c.iters = 0;
      }),
      "iters",
    ],
    [
      "share edited",
      run((c) => {
        c.sharePct.render = 60;
      }),
      "sharePct",
    ],
    [
      "share missing",
      run((c) => {
        c.sharePct = { selection: 40, render: 59 };
      }),
      "sharePct",
    ],
    [
      // A key present with no number: `NaN > tol` is false, so a check
      // written as "fail when off by more than tol" would wave it through.
      "share not a number",
      run((c) => {
        c.sharePct.render = undefined as unknown as number;
      }),
      "sharePct",
    ],
    [
      "sum exceeds whole",
      run((c) => {
        c.ns.stage_sum = 2000;
      }),
      "ns",
    ],
    [
      "dirty",
      run((c) => {
        c.git.dirty = true;
      }),
      "git.dirty",
    ],
  ];
  const wrong = cases.filter(([, cols, want]) =>
    want === "" ? cols.length !== 0 : !(cols.length === 1 && cols[0] === want),
  );
  check(
    "a decode cell without its vector check, under the wrong key, or with shares off its ns fails",
    wrong.length === 0,
    wrong.length === 0
      ? `${cases.length} cases`
      : wrong
          .map(([n, cols]) => `${n}: ${cols.join(",") || "(none)"}`)
          .join("; "),
  );
}

// B17. A stage table's rows must be exactly the stages its baseline records.
{
  const cell: StageCell = {
    ns: {},
    sharePct: { selection: 40, render: 59, unmarked: 1 },
    git: { rev: "e68291e", dirty: false },
  };
  const ok = checkStageRowCoverage(
    ["selection", "render", "unmarked"],
    { k: cell },
    "t",
  );
  const omits = checkStageRowCoverage(
    ["selection", "render"],
    { k: cell },
    "t",
  );
  const extra = checkStageRowCoverage(
    ["selection", "render", "unmarked", "idct"],
    { k: cell },
    "t",
  );
  check(
    "a stage table that omits a recorded stage or names an unrecorded one fails",
    ok.length === 0 &&
      omits.length === 1 &&
      (omits[0]?.detail ?? "").includes(
        "recorded but not in the table: unmarked",
      ) &&
      extra.length === 1 &&
      (extra[0]?.detail ?? "").includes("in the table but not recorded: idct"),
    `ok=${ok.length} omits=${details(omits)} extra=${details(extra)}`,
  );
}

console.log(
  "\nverify-benchmark — tolerance, supplements, hosts, provenance, pairs\n",
);

/** A quiet host's preflight for a run of `rounds` process rounds. */
const quietPreflight = (
  rounds = 4,
): NonNullable<RunDoc["environment"]["preflight"]> => ({
  loaded: false,
  maxLoad: 1,
  loadavgStart: [0.3, 0.4, 0.5],
  loadavgRounds: Array.from({ length: rounds }, () => [0.4, 0.4, 0.5]),
  loadavgEnd: [0.9, 0.5, 0.5],
});

/**
 * A chromahash-perf/3 run the gate takes as a baseline: four processes of five
 * blocks, a quiet preflight, a traceable git block. A cell may give its
 * process minima (µs), from which its range is derived as the driver derives
 * it, and the run can carry pairs and aliases. An `environment` override is
 * merged over the default, preflight included unless it names its own.
 */
function run3(
  file: string,
  cells: Record<string, { us: number; mins?: number[] }>,
  overrides: Partial<RunDoc> = {},
): RunDoc {
  const { environment, ...rest } = overrides;
  return {
    file,
    schema: "chromahash-perf/3",
    git: { commit: "abc1234", dirty: false, digest: "d".repeat(64) },
    environment: {
      cpuModel: "fixture",
      arch: "x64",
      cores: 1,
      ...environment,
      preflight: environment?.preflight ?? quietPreflight(),
    },
    config: { mode: "bounded", reps: 5, processes: 4 },
    cells: Object.entries(cells).map(([id, c]) => ({
      id,
      nsPerOp: c.us * 1000,
      medianNsPerOp: c.us * 1000,
      iqrPct: 0,
      noisy: false,
      iters: 1,
      ...(c.mins
        ? {
            processMinNsPerOp: c.mins.map((m) => m * 1000),
            rangeNsPerOp: [
              Math.min(...c.mins) * 1000,
              Math.max(...c.mins) * 1000,
            ],
          }
        : {}),
    })) as RunDoc["cells"],
    ...rest,
  };
}

const num = (
  value: number,
  unit: DocNumber["unit"],
  decimals: number,
): DocNumber => ({ value, unit, decimals });
const est = (value: number, interval: [number, number] | null = null) => ({
  value,
  interval,
});

// V1. The agreement rule: exact, then the interval, then the ±TOLERANCE band;
//     a share by half a point; a timing difference by TOLERANCE on its ratio.
{
  const cases: [string, Verdict, Verdict][] = [
    ["exact", agreement(num(2.46, "ms", 2), est(2461)).verdict, "exact"],
    [
      "4% off, no interval",
      agreement(num(2.56, "ms", 2), est(2461)).verdict,
      "band",
    ],
    [
      "6% off, no interval",
      agreement(num(2.61, "ms", 2), est(2461)).verdict,
      "outside",
    ],
    [
      "15% off, inside the interval",
      agreement(num(2.83, "ms", 2), est(2461, [2300, 2900])).verdict,
      "interval",
    ],
    [
      "15% off, outside the interval",
      agreement(num(2.83, "ms", 2), est(2461, [2400, 2500])).verdict,
      "outside",
    ],
    [
      "ratio 4% off",
      agreement(num(3.83, "ratio", 2), est(3.68)).verdict,
      "band",
    ],
    [
      "ratio 8% off",
      agreement(num(3.98, "ratio", 2), est(3.68)).verdict,
      "outside",
    ],
    [
      "share 0.4 points",
      agreement(num(57.6, "percent", 1), est(57.2), "share").verdict,
      "band",
    ],
    [
      "share 0.7 points of a large share",
      agreement(num(57.9, "percent", 1), est(57.2), "share").verdict,
      "outside",
    ],
    [
      "share, whole percent, rounding",
      agreement(num(66, "percent", 0), est(66.6), "share").verdict,
      "band",
    ],
    [
      "difference 3 points of a 0.637x ratio (relative 4.7%)",
      agreement(num(-33.3, "percent", 1), est(-36.3)).verdict,
      "band",
    ],
    [
      "difference 4 points of a 0.637x ratio (relative 6.3%)",
      agreement(num(-32.3, "percent", 1), est(-36.3)).verdict,
      "outside",
    ],
    [
      "difference 7 points",
      agreement(num(-29.3, "percent", 1), est(-36.3)).verdict,
      "outside",
    ],
    [
      "a 2% gain stated, a 1% loss measured: in band, wrong way",
      agreement(num(2, "percent", 0), est(-1)).verdict,
      "outside",
    ],
    [
      "a 2% gain stated, 4% measured: same way, in band",
      agreement(num(2, "percent", 0), est(4)).verdict,
      "band",
    ],
    [
      "1.03x stated, 0.99x measured: in band, wrong way",
      agreement(num(1.03, "ratio", 2), est(0.99)).verdict,
      "outside",
    ],
    [
      "1.00x states no direction",
      agreement(num(1.0, "ratio", 2), est(0.98)).verdict,
      "band",
    ],
    [
      "0% states no direction",
      agreement(num(0, "percent", 0), est(-1.2)).verdict,
      "band",
    ],
    [
      "a slowdown inside its range is still a slowdown",
      agreement(num(1.02, "ratio", 2), est(0.995, [0.98, 1.03])).verdict,
      "outside",
    ],
    [
      "a stage share has no direction",
      agreement(num(0.3, "percent", 1), est(-0.1), "share").verdict,
      "band",
    ],
  ];
  const wrong = cases.filter(([, got, want]) => got !== want);
  check(
    `a value passes exactly, inside its range, or within ±${TOLERANCE * 100}% (relative, for a timing percentage) — and fails outside all three, or on the wrong side of 1x or 0%`,
    TOLERANCE <= CROSS_RUN_TOLERANCE && wrong.length === 0,
    wrong.length === 0
      ? `${cases.length} cases`
      : wrong.map(([n, got, want]) => `${n}: ${got}, want ${want}`).join("; "),
  );
}

// V2. Through checkTable: an in-band value passes and is counted as tolerated,
//     an out-of-band one fails with a --fix edit, and only that one is edited.
//     So a second run on a stable host rewrites almost nothing.
{
  const table = parseTables(
    fixtureTable([
      ["Rust", "1.04 ms"],
      ["Go", "1.20 ms"],
    ]),
  )[0];
  const failures: Failure[] = [];
  const counters: Counters = {
    checked: 0,
    unbound: 0,
    placeholders: 0,
    pending: 0,
    withheld: 0,
    unavailable: 0,
    tolerated: 0,
  };
  const edits: Edit[] = [];
  const R = new Runs([
    run3("perf-report.json", {
      "encode/Rust/t1": { us: 1000 },
      "encode/Go/t1": { us: 1000 },
    }),
  ]);
  const binding: Binding = {
    ...FIXTURE_BINDING,
    columns: {
      "encode t1": (row, RR) =>
        RR.est(`encode/${clean(row("implementation"))}/t1`),
    },
  };
  if (table) checkTable(binding, table, R, failures, counters, edits);
  const fixed = applyEdits(
    fixtureTable([
      ["Rust", "1.04 ms"],
      ["Go", "1.20 ms"],
    ]),
    edits,
    [],
  );
  check(
    "--fix rewrites only the cell outside its band",
    counters.checked === 2 &&
      counters.tolerated === 1 &&
      failures.length === 1 &&
      failures[0]?.row === "Go" &&
      edits.length === 1 &&
      fixed.includes("| Rust | 1.04 ms |") &&
      fixed.includes("| Go | 1.00 ms |"),
    `checked=${counters.checked} tolerated=${counters.tolerated} failures=${details(failures)} edits=${JSON.stringify(edits)}`,
  );
}

// V3. Full is a supplement. A full run's own ids fill what the bounded runs
//     lack; an id both hold is read from the bounded run, in either file order,
//     and the overlap fails the gate. That is what stops filling six cells
//     from re-baselining every other.
for (const order of ["full first", "bounded first"] as const) {
  const bounded = run3("perf-report.json", {
    "encode/Rust/t1/100x100/gradient": { us: 2460 },
  });
  const full = run3(
    "perf-report-full.json",
    {
      "encode/Rust/t1/100x100/gradient": { us: 2300 },
      "encode/Rust/t3/100x100/gradient": { us: 40000 },
    },
    { config: { mode: "full", reps: 5, processes: 4 } },
  );
  const R = new Runs(
    order === "full first" ? [full, bounded] : [bounded, full],
  );
  const fails = runFailures(R);
  check(
    `the bounded run is authoritative over the full supplement (${order})`,
    R.us("encode/Rust/t1/100x100/gradient") === 2460 &&
      R.us("encode/Rust/t3/100x100/gradient") === 40000 &&
      R.overlaps.length === 1 &&
      fails.some((f) => f.column === "supplement"),
    `t1=${R.us("encode/Rust/t1/100x100/gradient")} overlaps=${JSON.stringify(R.overlaps)}`,
  );
}
{
  // A clean supplement shares nothing, so nothing fails and nothing spreads.
  const R = new Runs([
    run3("perf-report.json", {
      "encode/Rust/t1/100x100/gradient": { us: 2460 },
    }),
    run3(
      "perf-report-full.json",
      { "encode/Rust/t3/100x100/gradient": { us: 40000 } },
      { config: { mode: "full", reps: 5, processes: 4 } },
    ),
  ]);
  check(
    "a full run holding only its own ids passes",
    runFailures(R).length === 0 && R.crossRunSpread.length === 0,
    details(runFailures(R)),
  );
}

// V4. Per-host baselines. A macOS run 30% away from Linux on a shared cell is
//     another host, not a spread; it fills Swift, which Linux recorded absent,
//     and nothing Linux measured. The stability pair is the primary host's.
{
  const linux = (file: string, us: number): RunDoc =>
    run3(
      file,
      { "encode/Rust/t1": { us }, "decode/Rust/t1": { us: 300 } },
      {
        environment: { os: "linux", cpuModel: "Ryzen", arch: "x64", cores: 16 },
        unavailable: [{ target: "Swift", reason: "ENOENT", kind: "absent" }],
      },
    );
  const mac = run3(
    "perf-report.json",
    { "encode/Rust/t1": { us: 1300 }, "encode/Swift/t1": { us: 1310 } },
    {
      environment: {
        os: "darwin",
        cpuModel: "M3 Pro",
        arch: "arm64",
        cores: 12,
      },
    },
  );
  const R = new Runs(
    [linux("perf-report.json", 1000), linux("perf-report-2.json", 1020), mac],
    { primary: "linux-x64-ryzen" },
  );
  const s = checkStability(R);
  const sMac = checkStability(R, "darwin-arm64-m3-pro");
  // The mac host supplies the Swift cells, so it needs a pair of its own; a
  // second mac run supplies one. The legacy-only host needs none.
  const macAlone = stabilityFailures(R);
  const withPair = stabilityFailures(
    new Runs(
      [
        linux("perf-report.json", 1000),
        linux("perf-report-2.json", 1020),
        mac,
        { ...mac, file: "perf-report-2.json" },
      ],
      { primary: "linux-x64-ryzen" },
    ),
  );
  const legacyAlone = stabilityFailures(
    new Runs([fixtureRun("perf-report.json", ["encode/Rust/t1"])]),
  );
  const v3Alone = stabilityFailures(
    new Runs([run3("perf-report.json", { "encode/Rust/t1": { us: 1 } })]),
  );
  check(
    "hosts are keyed, compared only with themselves, a secondary host fills only what the primary cannot, and any host read from needs its own stability pair",
    R.hosts.size === 2 &&
      R.crossRunSpread.length === 0 &&
      s.status === "pass" &&
      s.shared === 2 &&
      sMac.status === "skip" &&
      R.us("encode/Rust/t1") === 1000 &&
      R.us("encode/Swift/t1") === 1310 &&
      !R.unavailable.has("Swift") &&
      runFailures(R).length === 0 &&
      macAlone.length === 1 &&
      (macAlone[0]?.row ?? "").startsWith("darwin-arm64-m3-pro") &&
      withPair.length === 0 &&
      legacyAlone.length === 0 &&
      v3Alone.length === 1,
    `hosts=${[...R.hosts.keys()].join(",")} spread=${JSON.stringify(R.crossRunSpread)} primary=${s.status}/${s.shared} mac=${sMac.status} rust=${R.us("encode/Rust/t1")} macAlone=${details(macAlone)} withPair=${details(withPair)} v3Alone=${v3Alone.length}`,
  );
  const misfiled = new Runs([{ ...mac, hostDir: "linux-x64-ryzen" }]);
  check(
    "a run committed under another host's directory fails",
    runFailures(misfiled).some((f) => f.column === "host"),
    JSON.stringify(misfiled.misfiled),
  );
  check(
    "the host key of the committed baseline is the directory it was moved to",
    hostKey({
      os: "linux",
      arch: "x64",
      cpuModel: "AMD Ryzen 7 7800X3D 8-Core Processor",
    }) === "linux-x64-amd-ryzen-7-7800x3d-8-core-processor",
    hostKey({
      os: "linux",
      arch: "x64",
      cpuModel: "AMD Ryzen 7 7800X3D 8-Core Processor",
    }),
  );
}

// V5. Loaded, quick and mixed-schema runs are refused as baselines.
{
  const loaded = new Runs([
    run3(
      "perf-report.json",
      { a: { us: 1 } },
      {
        environment: {
          cpuModel: "fixture",
          arch: "x64",
          cores: 1,
          preflight: { ...quietPreflight(), loaded: true },
        },
      },
    ),
  ]);
  const quick = new Runs([
    run3(
      "perf-report.json",
      { a: { us: 1 } },
      {
        config: { mode: "quick", reps: 1, processes: 1 },
      },
    ),
  ]);
  const mixed = new Runs([
    run3("perf-report.json", { a: { us: 1 } }),
    fixtureRun("perf-report-2.json", ["a"]),
  ]);
  check(
    "a run forced past the load bar, a --quick run, and a host mixing run formats all fail",
    runFailures(loaded).some((f) => f.column === "preflight.load") &&
      quick.loaded.length === 0 &&
      (quick.rejected[0] ?? "").includes("smoke test") &&
      runFailures(quick).some((f) => f.column === "run") &&
      runFailures(mixed).some((f) => f.column === "schema"),
    `loaded=${details(runFailures(loaded))} quick=${JSON.stringify(quick.rejected)} mixed=${details(runFailures(mixed))}`,
  );
}

// V5b. The load bar is the gate's, recomputed from the run's own cores and held
//      to every reading. `--max-load 50` does not move it, a run that starts
//      quiet and turns loaded fails, and a /3 run that does not record its
//      sampling, its source or its host is not read at all — and its absence
//      is a failure, not a print. A /2 run predates all of it.
{
  const on16 = (preflight: NonNullable<RunDoc["environment"]["preflight"]>) =>
    run3(
      "perf-report.json",
      { a: { us: 1 } },
      {
        environment: { cpuModel: "fixture", arch: "x64", cores: 16, preflight },
      },
    );
  const quiet = quietPreflight();
  const loadFails = (pf: NonNullable<RunDoc["environment"]["preflight"]>) =>
    runFailures(new Runs([on16(pf)])).filter(
      (f) => f.column === "preflight.load",
    );
  const raised = loadFails({
    ...quiet,
    maxLoad: 50,
    loadavgStart: [10.5, 9, 8],
  });
  const turned = loadFails({
    ...quiet,
    loadavgRounds: [
      [0.5, 0.5, 0.5],
      [0.6, 0.5, 0.5],
      [6.1, 2, 1],
      [0.7, 1, 1],
    ],
  });
  const atBar = loadFails({ ...quiet, loadavgStart: [2, 2, 2] });
  const truncated = loadFails({ ...quiet, loadavgRounds: [[0.5, 0.5, 0.5]] });
  const unreadLoad = loadFails({
    ...quiet,
    loadavgRounds: [null, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]],
  });
  const endIgnored = loadFails({ ...quiet, loadavgEnd: [14, 6, 3] });
  const rejectedFor = (o: Partial<RunDoc>, drop?: "preflight"): string => {
    const full = run3("perf-report-2.json", { a: { us: 1 } }, o);
    const { preflight: _dropped, ...bare } = full.environment;
    const doc = drop ? { ...full, environment: bare } : full;
    const R = new Runs([doc]);
    return R.loaded.length === 0 &&
      runFailures(R).some((f) => f.column === "run")
      ? (R.rejected[0] ?? "")
      : "";
  };
  const thin = rejectedFor({
    config: { mode: "bounded", reps: 5, processes: 3 },
  });
  const odd = rejectedFor({
    config: { mode: "bounded", reps: 5, processes: 5 },
  });
  const fewBlocks = rejectedFor({
    config: { mode: "bounded", reps: 4, processes: 4 },
  });
  const noDigest = rejectedFor({ git: { commit: "abc1234", dirty: false } });
  const noGit = rejectedFor({ git: undefined as unknown as RunDoc["git"] });
  const noPreflight = rejectedFor({}, "preflight");
  const six = new Runs([
    run3(
      "perf-report.json",
      { a: { us: 1 } },
      {
        config: { mode: "bounded", reps: 7, processes: 6 },
        environment: {
          cpuModel: "fixture",
          arch: "x64",
          cores: 1,
          preflight: quietPreflight(6),
        },
      },
    ),
  ]);
  const legacy = new Runs([fixtureRun("perf-report.json", ["a"])]);
  check(
    "the load bar is recomputed and held to every round, and a /3 run missing its sampling, git or preflight record is rejected as a failure",
    raised.length === 1 &&
      (raised[0]?.detail ?? "").includes("10.50 at the start") &&
      turned.length === 1 &&
      (turned[0]?.detail ?? "").includes("round 3") &&
      atBar.length === 0 &&
      truncated.length === 1 &&
      unreadLoad.length === 1 &&
      endIgnored.length === 0 &&
      thin.includes("3 process(es)") &&
      odd.includes("5 process(es)") &&
      fewBlocks.includes("4 block(s)") &&
      noDigest.includes("source digest") &&
      noGit.includes("source digest") &&
      noPreflight.includes("no preflight") &&
      six.loaded.length === 1 &&
      runFailures(six).length === 0 &&
      legacy.loaded.length === 1 &&
      runFailures(legacy).length === 0,
    `raised=${details(raised)} turned=${details(turned)} atBar=${atBar.length} truncated=${truncated.length} unread=${unreadLoad.length} end=${endIgnored.length} thin=${thin} odd=${odd} few=${fewBlocks} noDigest=${noDigest} noGit=${noGit} noPreflight=${noPreflight} six=${details(runFailures(six))}`,
  );
}

// V5b2. Sustained quiet: a run that records `waitRule` must also hold every
//       reading's 5-minute load under 1.5x the bar (3.0 on 16 threads), strictly;
//       a run without it was admitted on the 1-minute rule alone and is held to
//       that, as the runs committed before the rule are; and a `waitRule` the
//       gate does not know fails rather than passing on the 1-minute half.
{
  const on16 = (preflight: NonNullable<RunDoc["environment"]["preflight"]>) =>
    run3(
      "perf-report.json",
      { a: { us: 1 } },
      {
        environment: { cpuModel: "fixture", arch: "x64", cores: 16, preflight },
      },
    );
  const loadFails = (pf: NonNullable<RunDoc["environment"]["preflight"]>) =>
    runFailures(new Runs([on16(pf)])).filter(
      (f) => f.column === "preflight.load",
    );
  // The 2026-10-10 shape: 1-minute just under the bar, 5-minute well over.
  const dipRounds: (number[] | null)[] = [
    [0.5, 0.5, 0.5],
    [1.86, 4.1, 3],
    [0.5, 0.5, 0.5],
    [0.5, 0.5, 0.5],
  ];
  const ruled = { ...quietPreflight(), waitRule: WAIT_RULE };
  const quietRuled = loadFails(ruled);
  const dipRuled = loadFails({ ...ruled, loadavgRounds: dipRounds });
  const dipLegacy = loadFails({
    ...quietPreflight(),
    loadavgRounds: dipRounds,
  });
  const startAt3 = loadFails({ ...ruled, loadavgStart: [1, 3, 2] });
  const startUnder3 = loadFails({ ...ruled, loadavgStart: [1, 2.99, 2] });
  const no5 = loadFails({ ...ruled, loadavgStart: [1] });
  const unknownRule = loadFails({
    ...quietPreflight(),
    waitRule: "load1<=bar",
  });
  check(
    "a run recording waitRule fails on a high 5-minute round, a run without it is held to the 1-minute rule only, and an unknown waitRule fails",
    SUSTAINED_LOAD_FACTOR === 1.5 &&
      WAIT_RULE.includes("1.5") &&
      quietRuled.length === 0 &&
      dipRuled.length === 1 &&
      (dipRuled[0]?.detail ?? "").includes("5-minute load 4.10 at round 2") &&
      (dipRuled[0]?.detail ?? "").includes("3.00") &&
      dipLegacy.length === 0 &&
      startAt3.length === 1 &&
      (startAt3[0]?.detail ?? "").includes("at the start") &&
      startUnder3.length === 0 &&
      no5.length === 1 &&
      (no5[0]?.detail ?? "").includes("no 5-minute load") &&
      unknownRule.length === 1 &&
      (unknownRule[0]?.detail ?? "").includes("load1<=bar"),
    `quiet=${details(quietRuled)} dip=${details(dipRuled)} legacy=${details(dipLegacy)} at3=${details(startAt3)} under3=${details(startUnder3)} no5=${details(no5)} unknown=${details(unknownRule)}`,
  );
}

// V5c. --fix refuses while the committed runs themselves fail: rewriting the
//      document to agree with a run the gate rejects would launder it.
{
  const loaded = new Runs([
    run3(
      "perf-report.json",
      { a: { us: 1 } },
      {
        environment: {
          cpuModel: "fixture",
          arch: "x64",
          cores: 1,
          preflight: { ...quietPreflight(), loaded: true },
        },
      },
    ),
  ]);
  const clean = new Runs([run3("perf-report.json", { a: { us: 1 } })]);
  const refused = fixRefusal(runFailures(loaded));
  check(
    "--fix refuses while a committed run fails, and names what to clear",
    refused?.includes("preflight.load") === true &&
      fixRefusal(runFailures(clean)) === null,
    String(refused),
  );
}

// V5d. A cell spread past the host bar is withheld, not a run failure: it fails
//      by name and --fix writes TBD there, while every other cell is still
//      fixed. A TBD it rests on stays TBD on the next pass. A run-level failure
//      still refuses the whole fix.
{
  const rows: [string, string][] = [
    ["Rust", "1.20 ms"],
    ["Go", "1.00 ms"],
  ];
  const quietAndWide = (overrides: Partial<RunDoc> = {}): RunDoc =>
    run3(
      "perf-report.json",
      {
        "encode/Rust/t1": { us: 1000, mins: [995, 1000, 1000, 1010] },
        "encode/Go/t1": { us: 1000, mins: [900, 1000, 1000, 1150] },
      },
      overrides,
    );
  const pass = (text: string, R: Runs) => {
    const table = parseTables(text)[0];
    const failures: Failure[] = [];
    const counters: Counters = {
      checked: 0,
      unbound: 0,
      placeholders: 0,
      pending: 0,
      withheld: 0,
      unavailable: 0,
      tolerated: 0,
    };
    const edits: Edit[] = [];
    if (table) checkTable(FIXTURE_BINDING, table, R, failures, counters, edits);
    return { failures, counters, edits, fixed: applyEdits(text, edits, []) };
  };
  const R = new Runs([quietAndWide()]);
  const first = pass(fixtureTable(rows), R);
  const again = pass(first.fixed, new Runs([quietAndWide()]));
  const loaded = new Runs([
    quietAndWide({
      environment: {
        cpuModel: "fixture",
        arch: "x64",
        cores: 1,
        preflight: { ...quietPreflight(), loaded: true },
      },
    }),
  ]);
  // Prose resting on the wide cell is withheld the same way.
  const ctx: ClaimContext = {
    counters: first.counters,
    stability: checkStability(R),
  };
  const prose = checkSweepClaims("Go encodes in 1.00 ms here", R, ctx, [
    {
      what: "go",
      pattern: /encodes in (TBD|[\d.]+) ms/,
      unit: "ms",
      decimals: 2,
      resolve: (RR) => RR.est("encode/Go/t1"),
    },
  ]);
  check(
    "one cell spread past the bar is withheld as TBD and does not stop --fix writing the others; a run-level failure still does",
    first.counters.withheld === 1 &&
      first.counters.checked === 1 &&
      first.failures.length === 2 &&
      first.failures.some(
        (f) => f.row === "Go" && (f.detail ?? "").startsWith("withheld"),
      ) &&
      first.fixed.includes("| Rust | 1.00 ms |") &&
      first.fixed.includes("| Go | TBD ms |") &&
      fixRefusal(runFailures(R)) === null &&
      again.counters.withheld === 1 &&
      again.edits.length === 0 &&
      again.fixed === first.fixed &&
      prose.withheld === 1 &&
      prose.edits[0]?.text === "TBD" &&
      fixRefusal(runFailures(loaded)) !== null,
    `first=${details(first.failures)} edits=${JSON.stringify(first.edits)} again=${JSON.stringify(again.counters)} prose=${details(prose.failures)}`,
  );
}

// V5e. A cell that completed fewer processes than its run planned, or a pair
//      with fewer AB/BA blocks than processes / 2, is withheld for its
//      sampling: with one process there is no spread, so the noisy, unstable
//      and withheld rules would otherwise pass it on the ±5% band alone. The
//      run's own count is the bar, not MIN_PROCESSES: a six-process run's cell
//      that completed four is thin too.
{
  const b = "encode/Rust/t1/512x512/gradient";
  const a = `${b}/accel all`;
  const once = "encode/Go/t1";
  const R = new Runs([
    run3(
      "perf-report.json",
      {
        [b]: { us: 46700, mins: [46600, 46700, 46700, 46800] },
        [a]: { us: 20000, mins: [20000, 20000, 20000, 20000] },
        [once]: { us: 1000, mins: [1000] },
      },
      {
        pairs: [
          // One complete block of the two four processes plan.
          { base: b, arm: a, ratio: 2.4, range: [2.4, 2.4], blocks: [2.4] },
        ],
      },
    ),
  ]);
  const cellOnce = R.trace(() => R.est(once));
  const steady = R.trace(() => R.est(b));
  const pairOnce = R.trace(() => R.ratio(b, a));
  const six = new Runs([
    run3(
      "perf-report.json",
      { [b]: { us: 46700, mins: [46600, 46700, 46700, 46800] } },
      { config: { mode: "bounded", reps: 5, processes: 6 } },
    ),
  ]);
  const sixShort = six.trace(() => six.est(b));
  // Counted from `processes` where a cell records no minima.
  const countedDoc = run3("perf-report.json", { [once]: { us: 1000 } });
  countedDoc.cells = countedDoc.cells.map((c) => ({ ...c, processes: 1 }));
  const counted = new Runs([countedDoc]);
  const countedOnce = counted.trace(() => counted.est(once));
  const counters: Counters = {
    checked: 0,
    unbound: 0,
    placeholders: 0,
    pending: 0,
    withheld: 0,
    unavailable: 0,
    tolerated: 0,
  };
  const prose = checkSweepClaims(
    "Go encodes in 1.00 ms here",
    R,
    { counters, stability: checkStability(R) },
    [
      {
        what: "go",
        pattern: /encodes in (TBD|[\d.]+) ms/,
        unit: "ms",
        decimals: 2,
        resolve: (RR) => RR.est(once),
      },
    ],
  );
  const reason = withheldReason(cellOnce.unstable);
  check(
    "a cell or pair that completed fewer processes or AB/BA blocks than its run planned is withheld, not held to the band alone",
    cellOnce.unstable.length === 1 &&
      cellOnce.unstable[0]?.kind === "thin-process" &&
      reason.includes("1 of 4 processes completed") &&
      steady.unstable.length === 0 &&
      pairOnce.unstable.some(
        (u) => u.kind === "thin-block" && u.taken === 1 && u.expected === 2,
      ) &&
      withheldReason(pairOnce.unstable).includes("1 of 2 A B / B A blocks") &&
      sixShort.unstable[0]?.kind === "thin-process" &&
      sixShort.unstable[0]?.expected === 6 &&
      countedOnce.unstable[0]?.kind === "thin-process" &&
      prose.withheld === 1 &&
      prose.edits[0]?.text === "TBD",
    `cell=${JSON.stringify(cellOnce.unstable)} pair=${JSON.stringify(pairOnce.unstable)} six=${JSON.stringify(sixShort.unstable)} counted=${JSON.stringify(countedOnce.unstable)} prose=${details(prose.failures)}`,
  );
}

// V6. Aliases: one measurement under two names. A /3 run resolves `…/shipped`
//     to its base; an old run that holds both is checked for agreeing.
{
  const alias = "encode/Rust/t1/100x100/gradient/shipped";
  const base = "encode/Rust/t1/100x100/gradient";
  const R3 = new Runs([
    run3(
      "perf-report.json",
      { [base]: { us: 2460 } },
      { aliases: { [alias]: base } },
    ),
  ]);
  const plannerAliases = planMatrix("bounded", allTargets()).aliases;
  const agreeing = new Runs(
    [timedRun("perf-report.json", { [base]: 2461, [alias]: 2446 })],
    { aliases: plannerAliases },
  );
  const apart = new Runs(
    [timedRun("perf-report.json", { [base]: 2461, [alias]: 2000 })],
    { aliases: plannerAliases },
  );
  check(
    "a shipped arm is its base cell, and an old run's two copies must agree",
    R3.has(alias) &&
      R3.us(alias) === 2460 &&
      plannerAliases[alias] === base &&
      agreeing.aliasDisagreements.length === 0 &&
      agreeing.us(alias) === 2446 &&
      apart.aliasDisagreements.length === 1 &&
      runFailures(apart).some((f) => f.column === "alias"),
    `r3=${R3.has(alias)} agree=${JSON.stringify(agreeing.aliasDisagreements)} apart=${JSON.stringify(apart.aliasDisagreements)}`,
  );
}

// V7. Paired ratios. A run's own pair record is read, range and all. A /3 run
//     without one is missing a measurement and throws; only a /2 run, which
//     recorded no pairs, falls back to the ratio of its two cells.
{
  const b = "encode/Rust/t1/512x512/gradient";
  const a = `${b}/accel all`;
  const paired = new Runs([
    run3(
      "perf-report.json",
      { [b]: { us: 46700 }, [a]: { us: 20000 } },
      {
        pairs: [
          {
            base: b,
            arm: a,
            ratio: 2.4,
            range: [2.35, 2.45],
            blocks: [2.35, 2.45],
          },
        ],
      },
    ),
  ]);
  const unpaired = new Runs([
    run3("perf-report.json", { [b]: { us: 46700 }, [a]: { us: 20000 } }),
  ]);
  const legacy = new Runs([
    timedRun("perf-report.json", { [b]: 46700, [a]: 20000 }),
  ]);
  const p = paired.ratio(b, a);
  let thrown = "";
  try {
    unpaired.ratio(b, a);
  } catch (e) {
    if (e instanceof MissingCell) thrown = e.message;
  }
  const u = legacy.ratio(b, a);
  // Two AB/BA blocks 25% apart: the ratio is unreproducible even though each
  // cell is steady, so its range accepts nothing and the gate fails it.
  const split = new Runs([
    run3(
      "perf-report.json",
      { [b]: { us: 46700 }, [a]: { us: 20000 } },
      {
        pairs: [
          { base: b, arm: a, ratio: 2.24, range: [2, 2.5], blocks: [2, 2.5] },
        ],
      },
    ),
  ]);
  const s = split.ratio(b, a);
  const splitUnstable = split.unstableTouched();
  check(
    "a speedup is the run's paired record, a /3 run without one is missing it, and blocks that disagree past the bar fail",
    p.value === 2.4 &&
      p.interval?.[0] === 2.35 &&
      paired.unstableTouched().length === 0 &&
      thrown.includes("no paired record") &&
      Math.abs(u.value - 2.335) < 1e-9 &&
      u.interval === null &&
      s.interval === null &&
      splitUnstable.length === 1 &&
      splitUnstable[0]?.kind === "block" &&
      (splitUnstable[0]?.id ?? "").includes(" / "),
    `paired=${JSON.stringify(p)} unpaired=${thrown} legacy=${JSON.stringify(u)} split=${JSON.stringify(s)} ${JSON.stringify(splitUnstable)}`,
  );
}

// V8. Provenance by digest. The rule §0 states, against a fake repository.
{
  const view = (o: {
    ancestors?: string[];
    present?: Record<string, string>;
    history?: string[];
    shallow?: boolean;
  }): GitView => ({
    isAncestor: (c) =>
      o.present?.[c] === undefined ? null : (o.ancestors ?? []).includes(c),
    digestAt: (c) => o.present?.[c] ?? null,
    history: () => o.history ?? [],
    shallow: o.shallow ?? false,
  });
  const D = "a".repeat(64);
  const E = "b".repeat(64);
  const cases: [
    string,
    ReturnType<typeof judgeProvenance>["status"],
    boolean,
  ][] = [
    [
      "ancestor with its digest",
      judgeProvenance(
        { commit: "c1", digest: D },
        view({ ancestors: ["c1"], present: { c1: D } }),
      ).status,
      false,
    ],
    [
      "ancestor with another digest",
      judgeProvenance(
        { commit: "c1", digest: D },
        view({ ancestors: ["c1"], present: { c1: E } }),
      ).status,
      true,
    ],
    [
      "squash-merged, sources on master",
      judgeProvenance(
        { commit: "gone", digest: D },
        view({ present: { s1: E, s2: D }, history: ["s1", "s2"] }),
      ).status,
      false,
    ],
    [
      "squash-merged, sources nowhere",
      judgeProvenance(
        { commit: "gone", digest: D },
        view({ present: { s1: E }, history: ["s1"] }),
      ).status,
      true,
    ],
    [
      "shallow clone",
      judgeProvenance(
        { commit: "gone", digest: D },
        view({ present: { s1: E }, history: ["s1"], shallow: true }),
      ).status,
      false,
    ],
    [
      "legacy format, no digest",
      judgeProvenance({ commit: "e53e6cd" }, view({}), true).status,
      false,
    ],
    [
      "current format, no digest",
      judgeProvenance({ commit: "abc1234", digest: null }, view({})).status,
      true,
    ],
  ];
  const want = [
    "commit",
    "mismatch",
    "digest",
    "unresolved",
    "shallow",
    "legacy",
    "unrecorded",
  ];
  const wrong = cases.filter(
    ([, status, fails], i) =>
      status !== want[i] || provenanceFails({ status, detail: "" }) !== fails,
  );
  check(
    "provenance passes by commit or by digest, fails on a mismatch, untraceable sources or a missing digest, and reports legacy and shallow",
    wrong.length === 0,
    wrong.length === 0
      ? `${cases.length} cases`
      : wrong.map(([n, s]) => `${n}: ${s}`).join("; "),
  );
}

// V9. The digest is computed over the same paths, and the same outputs are
//     excluded, by both recorders: the TypeScript driver and the stage
//     recorder in Python. Two lists that drift apart make one recorder's
//     runs untraceable by the other's rule.
{
  const py = readFileSync(
    path.join(REPO_ROOT_FOR_SELFTEST, "tools/benchmark/record_stages.py"),
    "utf8",
  );
  const tuple = (name: string): string[] => {
    const m = new RegExp(`${name} = \\(([^)]*)\\)`).exec(py);
    return [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (x) => x[1] as string,
    );
  };
  const pyPaths = tuple("MEASURED_PATHS");
  const pyOutputs = tuple("MEASUREMENT_OUTPUTS");
  // The digests themselves, not just the lists: both recorders on HEAD. The
  // listing walk, the documentation rule and the byte framing must all agree,
  // or a stage cell and a sweep taken at one commit trace to different sources.
  const pyRun = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import sys; sys.path.insert(0, 'tools/benchmark'); import record_stages; print(record_stages.source_digest())",
    ],
    { cwd: REPO_ROOT_FOR_SELFTEST, encoding: "utf8" },
  );
  const pyDigest = pyRun.stdout?.trim() ?? "";
  const tsDigest = sourceDigest(REPO_ROOT_FOR_SELFTEST, "HEAD");
  check(
    "the driver and the stage recorder digest the same sources, the same way, and ignore the same outputs",
    pyPaths.join() === MEASURED_PATHS.join() &&
      pyOutputs.join() === MEASUREMENT_OUTPUTS.join() &&
      MEASURED_PATHS.includes(".mise.toml") &&
      MEASURED_PATHS.includes("mise-tasks/benchmark") &&
      tsDigest !== null &&
      pyDigest === tsDigest,
    `py=${pyPaths.join(",")} | ${pyOutputs.join(",")} | digest ts=${tsDigest?.slice(0, 12)} py=${pyDigest.slice(0, 12) || pyRun.stderr?.slice(0, 200)}`,
  );
}

// V9b. Documentation is not a measured source, and a baseline this change
//      adds must carry HEAD's own sources (the landing rule).
{
  const docs = [
    "rust/README.md",
    "bindings/uniffi/README.MD",
    "python/docs/api.txt",
    "go/notes.rst",
  ];
  const sources = [
    "rust/src/encode.rs",
    "rust/Cargo.toml",
    "python/requirements.txt",
    "bindings/c/CMakeLists.txt",
    "rust/docsgen.rs",
  ];
  const entry = (p: string, obj: string) =>
    Buffer.from(`100644 blob ${obj}\t${p}`);
  const listing = (...es: Buffer[]) =>
    Buffer.concat(es.flatMap((e) => [e, Buffer.from([0])]));
  const withReadme = digestOfListing(
    listing(entry("rust/README.md", "a1"), entry("rust/lib.rs", "b2")),
  );
  const without = digestOfListing(listing(entry("rust/lib.rs", "b2")));
  const changed = digestOfListing(listing(entry("rust/lib.rs", "c3")));
  const D = "a".repeat(64);
  const E = "b".repeat(64);
  const untouched = judgeLanding(
    { digest: E },
    { isNew: false, headDigest: D, base: "base123" },
  );
  const current = judgeLanding(
    { digest: D },
    { isNew: true, headDigest: D, base: "base123" },
  );
  const stale = judgeLanding(
    { digest: E },
    { isNew: true, headDigest: D, base: "base123" },
  );
  const noDigest = judgeLanding(
    { digest: null },
    { isNew: true, headDigest: D, base: "base123" },
  );
  check(
    "documentation does not enter the digest, and a new baseline fails unless measured on HEAD's sources",
    docs.every(isDocumentation) &&
      !sources.some(isDocumentation) &&
      withReadme === without &&
      without !== changed &&
      digestOfListing(listing(entry("rust/README.md", "a1"))) === null &&
      untouched === null &&
      current?.status === "commit" &&
      stale !== null &&
      provenanceFails(stale) &&
      noDigest !== null &&
      provenanceFails(noDigest),
    `docs=${docs.filter((d) => !isDocumentation(d))} sources=${sources.filter(isDocumentation)} readme=${withReadme === without} stale=${stale?.detail}`,
  );
}

// V10. The plan: full is disjoint from bounded and holds the cells only it
//      can produce; every shipped arm is an alias; every other arm is paired;
//      and rounds alternate direction with each unit's cells adjacent.
{
  const all = allTargets();
  const bounded = planRun("bounded", all, all);
  const full = planRun("full", all, all);
  const bIds = new Set(bounded.cells.map((c) => c.id));
  const overlap = full.cells.filter((c) => bIds.has(c.id)).map((c) => c.id);
  const needed = [
    "encode/Rust/t3/100x100/gradient",
    "encode/Rust/t1/128x128/gradient",
    "encode/Rust/t1/1024x1024/gradient",
  ];
  const fullIds = new Set(full.cells.map((c) => c.id));
  const shippedCells = bounded.cells.filter((c) => c.id.endsWith("/shipped"));
  const levers = bounded.cells.filter((c) => c.tune !== null);
  const unpaired = levers.filter(
    (c) => !bounded.pairs.some((p) => p.arm === c.id),
  );
  const r0 = roundOrder(bounded, 0).map((c) => c.id);
  const r1 = roundOrder(bounded, 1).map((c) => c.id);
  const base = "encode/Rust/t1/512x512/gradient";
  const arm = `${base}/accel_quant_table`;
  const unit = bounded.unitOf.get(base);
  const unitIdx = r0
    .map((id, i) => (bounded.unitOf.get(id) === unit ? i : -1))
    .filter((i) => i >= 0);
  const contiguous =
    unitIdx.length > 1 &&
    unitIdx.every((v, i) => i === 0 || v === (unitIdx[i - 1] as number) + 1);
  check(
    "full is a supplement, shipped is an alias, every lever is paired, and rounds interleave units in alternating order",
    overlap.length === 0 &&
      needed.every((id) => fullIds.has(id)) &&
      bIds.has("encode/Rust/t4/100x100/gradient") &&
      shippedCells.length === 0 &&
      Object.keys(bounded.aliases).length === 7 &&
      unpaired.length === 0 &&
      bounded.pairs.some(
        (p) =>
          p.base === `${base}/refine_passes=1` &&
          p.arm === `${base}/refine_passes=1 accel_sse_early_exit`,
      ) &&
      contiguous &&
      r1.join() === [...r0].reverse().join() &&
      r0.indexOf(base) < r0.indexOf(arm) &&
      r1.indexOf(base) > r1.indexOf(arm),
    `overlap=${overlap.join(",")} shipped=${shippedCells.length} aliases=${Object.keys(bounded.aliases).length} unpaired=${unpaired.map((c) => c.id).join(",")} contiguous=${contiguous}`,
  );
}

// V11. Per-process statistics: the reported cost is the median of the
//      process minima, beside their range — labelled with the chance it holds
//      the median, 1 − 2^(1−n), not as a 95% interval — and noisy means the
//      minima disagree, not that one process's blocks scatter. A paired ratio
//      is the geometric mean over complete AB/BA blocks, so an order effect
//      cancels, and a block missing either round is dropped whole.
{
  const s = cellStats([
    [105, 100, 110],
    [120, 130, 125],
    [98, 99, 101],
  ]);
  const four = cellStats([
    [100, 140, 101],
    [102, 103, 160],
    [101, 101, 101],
    [103, 104, 103],
  ]);
  const p = pairStats([200, 210, undefined, 190], [100, 100, 80, 100]);
  // Base takes 200, arm 100: a true ratio of 2. Whichever member runs second
  // in its unit is 4% slower. Rounds alternate A B, B A (roundOrder).
  const second = 1.04;
  const ordered = (rounds: number) => {
    const base: number[] = [];
    const arm: number[] = [];
    for (let r = 0; r < rounds; r++) {
      const baseFirst = r % 2 === 0;
      base.push(baseFirst ? 200 : 200 * second);
      arm.push(baseFirst ? 100 * second : 100);
    }
    return pairStats(base, arm);
  };
  const fourRounds = ordered(4);
  const threeRounds = ordered(3);
  const oneRound = pairStats([200], [100]);
  // What the old estimator, a median of per-round ratios, made of three.
  const oldThree = [200 / 104, 208 / 100, 200 / 104].sort((x, y) => x - y)[1];
  check(
    "a cell reports the median of its process minima beside their labelled range, and a pair cancels its order effect over AB/BA blocks",
    s.nsPerOp === 100 &&
      s.processMinNsPerOp.join() === "100,120,98" &&
      Math.abs(s.spreadPct - 22 / 98) < 1e-12 &&
      s.noisy &&
      s.rangeNsPerOp.join() === "98,120" &&
      s.rangeCoverage === 0.75 &&
      four.rangeCoverage === 0.875 &&
      four.nsPerOp === 101.5 &&
      four.iqrPct > 0.05 &&
      !four.noisy &&
      p !== null &&
      p.ratios.join() === "2,2.1,,1.9" &&
      p.blocks.length === 1 &&
      Math.abs(p.ratio - Math.sqrt(2 * 2.1)) < 1e-12 &&
      fourRounds !== null &&
      Math.abs(fourRounds.ratio - 2) < 1e-12 &&
      fourRounds.blocks.length === 2 &&
      fourRounds.coverage === 0.5 &&
      !fourRounds.noisy &&
      threeRounds !== null &&
      Math.abs(threeRounds.ratio - 2) < 1e-12 &&
      threeRounds.blocks.length === 1 &&
      Math.abs((oldThree ?? 0) - 2) > 0.07 &&
      oneRound === null,
    `nsPerOp=${s.nsPerOp} mins=${s.processMinNsPerOp} range=${s.rangeNsPerOp}@${s.rangeCoverage} four=${four.nsPerOp}/${four.iqrPct}/${four.noisy} pair=${JSON.stringify(p)}`,
  );
}

// V11b. The gate's side of noise. A quiet cell's range may accept a value; a
//       noisy one's (processes past 5% apart) may not, so a value inside a
//       wide range but outside the band fails; and a bound cell whose
//       processes spread past the 10% host bar fails outright.
{
  const quiet = "encode/Rust/t1";
  const wide = "encode/Go/t1";
  const R = new Runs([
    run3("perf-report.json", {
      [quiet]: { us: 1015, mins: [1000, 1010, 1020, 1030] },
      [wide]: { us: 1000, mins: [940, 1000, 1000, 1060] },
    }),
  ]);
  const q = R.est(quiet);
  const w = R.est(wide);
  const verdict = agreement(num(1.055, "ms", 3), w).verdict;
  const unstable = R.unstableTouched();
  const legacy = new Runs([fixtureRun("perf-report.json", ["x"])]);
  legacy.est("x");
  check(
    "a noisy cell's range never widens acceptance, and a bound cell spread past the host bar is unstable",
    q.interval?.join() === "1000,1030" &&
      w.interval === null &&
      verdict === "outside" &&
      R.noisyTouched().join() === wide &&
      unstable.length === 1 &&
      unstable[0]?.id === wide &&
      legacy.unstableTouched().length === 0,
    `quiet=${JSON.stringify(q)} wide=${JSON.stringify(w)} verdict=${verdict} unstable=${JSON.stringify(unstable)}`,
  );
}

// V12. Preflight: refuse a loaded host unless forced, and mark a forced run.
{
  const base: Preflight = {
    loadavgStart: [30.2, 28, 25],
    loadavgRounds: [],
    loadavgEnd: null,
    waitedSeconds: [],
    maxLoad: defaultMaxLoad(16),
    loaded: false,
    governor: "powersave",
    boost: "on",
    boostSource: null,
    smt: "on",
    scalingDriver: null,
    energyPerformancePreference: null,
    warnings: [],
  };
  const refused = judgePreflight(base, false);
  const forced = judgePreflight(base, true);
  const quiet = judgePreflight(
    { ...base, loadavgStart: [0.4, 0.5, 0.6] },
    false,
  );
  check(
    "a loaded host is refused unless forced, a forced run is marked loaded, and root-only settings only warn",
    defaultMaxLoad(16) === 2 &&
      defaultMaxLoad(4) === 1 &&
      !mayStart(refused, false) &&
      !refused.loaded &&
      mayStart(forced, true) &&
      forced.loaded &&
      mayStart(quiet, false) &&
      !quiet.loaded &&
      quiet.warnings.length === 3 &&
      readLoadavg("linux", () => [0.524, 0.58, 0.591])?.join() ===
        "0.52,0.58,0.59" &&
      readLoadavg("darwin", () => [1.5, 1.2, 1])?.join() === "1.5,1.2,1" &&
      readLoadavg("win32", () => [0, 0, 0]) === null &&
      readLoadavg("linux", () => [Number.NaN, 0, 0]) === null,
    `refused=${mayStart(refused, false)} forced=${forced.loaded} quiet=${JSON.stringify(quiet.warnings)}`,
  );
}

// V12b. --wait-for-load: a loaded host is waited out rather than refused, and
//       given up on at the timeout. A fake clock, so nothing actually sleeps:
//       the load decays from 9 by one per poll against a bar of 2.
{
  const fake = (start: number) => {
    let t = 0;
    let load = start;
    const notes: number[] = [];
    return {
      notes,
      opts: {
        read: (): [number, number, number] => [load, load, load],
        sleep: async (ms: number) => {
          t += ms;
          load -= 1;
        },
        now: () => t,
        onWait: (_why: string, l: [number, number, number]) => notes.push(l[0]),
      },
    };
  };
  const decays = fake(9);
  const settled = await waitForLoad({
    maxLoad: 2,
    timeoutMs: 600_000,
    pollMs: 10_000,
    ...decays.opts,
  });
  const stuck = fake(9);
  const gaveUp = await waitForLoad({
    maxLoad: 2,
    timeoutMs: 25_000,
    pollMs: 10_000,
    ...stuck.opts,
  });
  const quiet = await waitForLoad({
    maxLoad: 2,
    timeoutMs: 0,
    read: () => [0.3, 0.3, 0.3],
    now: () => 0,
  });
  const unreadable = await waitForLoad({
    maxLoad: 2,
    timeoutMs: 0,
    read: () => null,
    now: () => 0,
  });
  check(
    "--wait-for-load waits a loaded host out, gives up at the timeout, and does not wait on a quiet or unreadable one",
    settled.ok &&
      settled.waitedMs === 70_000 &&
      settled.load?.[0] === 2 &&
      decays.notes.join() === "9,8,7,6,5,4,3" &&
      !gaveUp.ok &&
      gaveUp.waitedMs === 25_000 &&
      gaveUp.load?.[0] === 6 &&
      quiet.ok &&
      quiet.waitedMs === 0 &&
      unreadable.ok &&
      unreadable.load === null,
    `settled=${JSON.stringify(settled)} gaveUp=${JSON.stringify(gaveUp)} quiet=${quiet.ok}/${quiet.waitedMs} unreadable=${unreadable.ok}`,
  );
}

// V12c. Sustained quiet at the driver: a 1-minute dip under the bar while the
//       5-minute load is still at or over 1.5x it is waited out, not admitted,
//       and the start is refused the same way. Here the 1-minute load sits at
//       1.9 against a bar of 2 from the first poll, and the 5-minute load
//       decays from 4.5 by 0.5 per poll, so admission waits for it to fall
//       under 3.0 — strictly, so 3.0 itself is waited past — four polls, not
//       zero.
{
  let t = 0;
  let load5 = 4.5;
  const whys: string[] = [];
  const dip = await waitForLoad({
    maxLoad: 2,
    timeoutMs: 600_000,
    pollMs: 10_000,
    read: () => [1.9, load5, 2],
    sleep: async (ms: number) => {
      t += ms;
      load5 -= 0.5;
    },
    now: () => t,
    onWait: (why) => whys.push(why),
  });
  const base: Preflight = {
    loadavgStart: [1.9, 4.1, 3],
    loadavgRounds: [],
    loadavgEnd: null,
    waitedSeconds: [],
    maxLoad: 2,
    loaded: false,
    governor: null,
    boost: null,
    boostSource: null,
    smt: null,
    scalingDriver: null,
    energyPerformancePreference: null,
    warnings: [],
  };
  const refused = judgePreflight(base, false);
  const forced = judgePreflight(base, true);
  check(
    "a 1-minute dip with a high 5-minute load is waited out, refused at the start unless forced, and the rule is recorded",
    sustainedLoadBar(2) === 3 &&
      dip.ok &&
      dip.waitedMs === 40_000 &&
      dip.load?.[1] === 2.5 &&
      whys.length === 4 &&
      whys.every((w) => w.startsWith("5-minute load average")) &&
      overLoad([2, 2.99, 1], 2) === null &&
      (overLoad([2, 3, 1], 2) ?? "").startsWith("5-minute") &&
      (overLoad([2.1, 1, 1], 2) ?? "").startsWith("1-minute") &&
      overLoad(null, 2) === null &&
      !mayStart(refused, false) &&
      refused.warnings[0]?.startsWith("5-minute load average 4.10") === true &&
      mayStart(forced, true) &&
      forced.loaded &&
      readPreflight(2, false).waitRule === WAIT_RULE,
    `dip=${JSON.stringify(dip)} whys=${JSON.stringify(whys)} refused=${JSON.stringify(refused.warnings)} forced=${forced.loaded}`,
  );
}

// V13. Sweep prose: a TBD with a committed cell is a placeholder --fix fills;
//      a TBD without one is pending; a number in band passes; one out of band
//      fails with an edit; a sentence speaking for several cells holds all.
{
  const R = new Runs([
    run3("perf-report.json", {
      "decode/Rust/t4/natural": { us: 233797 },
      "a/1": { us: 100 },
      "a/2": { us: 104 },
      "a/3": { us: 140 },
    }),
  ]);
  const ctx: ClaimContext = {
    counters: {
      checked: 0,
      unbound: 0,
      placeholders: 0,
      pending: 0,
      withheld: 0,
      unavailable: 0,
      tolerated: 0,
    },
    stability: checkStability(R),
  };
  const claim = (
    pattern: RegExp,
    resolve: SweepClaim["resolve"],
  ): SweepClaim => ({
    what: "x",
    pattern,
    unit: "ms",
    decimals: 0,
    resolve,
  });
  const decode = claim(/prices at (TBD|[\d.]+) ms/, (RR) =>
    RR.est("decode/Rust/t4/natural"),
  );
  const tbd = checkSweepClaims("§2 prices at TBD ms", R, ctx, [decode]);
  const pending = checkSweepClaims("x is TBD ms", R, ctx, [
    claim(/is (TBD|[\d.]+) ms/, (RR) => RR.est("missing/cell")),
  ]);
  const inBand = checkSweepClaims("§2 prices at 240 ms", R, ctx, [decode]);
  const outBand = checkSweepClaims("§2 prices at 260 ms", R, ctx, [decode]);
  const flat = (text: string) =>
    checkSweepClaims(text, R, ctx, [
      {
        what: "flat",
        pattern: /all (TBD|[\d.]+) us/,
        unit: "us",
        decimals: 0,
        resolve: (RR) => ["a/1", "a/2", "a/3"].map((id) => RR.est(id)),
      },
    ]);
  const wrapped = checkSweepClaims("§2 prices\n> at 234 ms", R, ctx, [decode]);
  const widest: SweepClaim = {
    what: "widest",
    pattern: /widest (TBD|[\d.]+)%/,
    unit: "count",
    decimals: 1,
    resolve: () => 5.2,
  };
  const countRight = checkSweepClaims("widest 5.2%", R, ctx, [widest]);
  const countWrong = checkSweepClaims("widest 5.0%", R, ctx, [widest]);
  const countFill = checkSweepClaims("widest TBD%", R, ctx, [widest]);
  const filled = applyEdits("§2 prices at TBD ms", [], tbd.edits);
  // A sentence stating a gain, against a measured loss within the band.
  const gainClaim = (measured: number): SweepClaim => ({
    what: "gain",
    pattern: /the measured gain is (TBD|[\d.]+)%/,
    unit: "percent",
    decimals: 0,
    resolve: () => measured,
  });
  const gainWrongWay = checkSweepClaims("the measured gain is 2%", R, ctx, [
    gainClaim(-1),
  ]);
  const gainRightWay = checkSweepClaims("the measured gain is 2%", R, ctx, [
    gainClaim(3),
  ]);
  check(
    "a sweep figure is filled from a TBD, pending without a cell, banded, and held for every cell it speaks for",
    tbd.placeholders === 1 &&
      filled === "§2 prices at 234 ms" &&
      pending.pending === 1 &&
      pending.edits.length === 0 &&
      inBand.failures.length === 0 &&
      inBand.checked === 1 &&
      outBand.failures.length === 1 &&
      outBand.edits[0]?.text === "234" &&
      flat("all 104 us").failures.length === 1 &&
      flat("all 104 us").failures[0]?.detail?.includes("1 of the 3") === true &&
      wrapped.failures.length === 0 &&
      countRight.failures.length === 0 &&
      countWrong.failures.length === 1 &&
      countFill.edits[0]?.text === "5.2" &&
      gainWrongWay.failures.length === 1 &&
      gainRightWay.failures.length === 0,
    `tbd=${JSON.stringify(tbd.edits)} pending=${pending.pending} in=${details(inBand.failures)} out=${JSON.stringify(outBand.edits)} flat=${details(flat("all 104 us").failures)} wrapped=${details(wrapped.failures)}`,
  );
}

console.log("\nperf probe — absent is skippable, anything else is broken\n");

// P1–P5. Real spawns, classified exactly as `run.ts` classifies a target's
//        `bench-info`. The root is fictitious so ENOENT is guaranteed and the
//        redaction has something to strip.
{
  const root = "/nonexistent-chromahash-root/checkout";
  const node = process.execPath;
  const spawn = (cmd: string, args: string[], timeout = 30_000) =>
    classifyProbe(spawnSync(cmd, args, { encoding: "utf8", timeout }), root);

  const missing = spawn(`${root}/.build/release/ChromaHashCLI`, ["bench-info"]);
  check(
    "a binary that is not there is absent, and its path is repo-relative",
    !missing.ok &&
      missing.kind === "absent" &&
      (missing.reason ?? "").includes("ENOENT") &&
      !(missing.reason ?? "").includes(root) &&
      (missing.reason ?? "").includes(".build/release/ChromaHashCLI"),
    `kind=${missing.kind} reason=${missing.reason}`,
  );

  const failing = spawn(node, [
    "-e",
    "process.stderr.write('boom');process.exit(3)",
  ]);
  check(
    "a binary that exits non-zero is broken, with what it said",
    !failing.ok && failing.kind === "broken" && failing.reason === "boom",
    `kind=${failing.kind} reason=${failing.reason}`,
  );

  const hung = spawn(node, ["-e", "setTimeout(() => {}, 60000)"], 300);
  check(
    "a binary that times out is broken",
    !hung.ok && hung.kind === "broken",
    `kind=${hung.kind} reason=${hung.reason}`,
  );

  const killed = spawn(node, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  check(
    "a binary killed by a signal is broken, and names the signal",
    !killed.ok &&
      killed.kind === "broken" &&
      killed.reason === "killed by SIGKILL",
    `kind=${killed.kind} reason=${killed.reason}`,
  );

  const silent = spawn(node, [
    "-e",
    "process.stderr.write(' \\n');process.exit(4)",
  ]);
  check(
    "a binary that exits non-zero saying nothing is broken, with its status",
    !silent.ok && silent.kind === "broken" && silent.reason === "exit 4",
    `kind=${silent.kind} reason=${silent.reason}`,
  );

  const fine = spawn(node, ["-e", "console.log('runtime=fixture\\n')"]);
  check(
    "a binary that answers is available, with its info",
    fine.ok && fine.kind === undefined && fine.info === "runtime=fixture",
    `ok=${fine.ok} info=${JSON.stringify(fine.info)}`,
  );

  check(
    "the root alone redacts to '.'",
    repoRelative(`cd ${root} failed`, root) === "cd . failed" &&
      repoRelative(`${root}/a/b ENOENT`, root) === "a/b ENOENT",
    repoRelative(`cd ${root} failed`, root),
  );

  // P6. And the two classifications carried through to the gate, the way the
  //     driver records them: absent skips a marked row, broken fails it.
  const recorded = (o: typeof missing) =>
    fixtureRun(
      "perf-report.json",
      ["encode/Rust/t1"],
      [unavailableEntry("Swift", o.reason ?? "", o.kind)],
    );
  const skipped = gate([["Swift", "*macOS only*"]], [recorded(missing)]);
  const failed = gate([["Swift", "*macOS only*"]], [recorded(failing)]);
  check(
    "an absent probe skips the target's marked rows and a broken one fails them",
    skipped.failures.length === 0 &&
      skipped.counters.unavailable === 1 &&
      failed.failures.length === 1,
    `absent→failures=${skipped.failures.length} broken→failures=${failed.failures.length}`,
  );
}

// ─── verify:experiments' table register and the result reader ──────────────
//
// `verify:experiments --strict` over the committed document and results runs
// only the state they are in, where every register is complete and every
// result well-formed, so none of the branches that fail a run had executed.
// Each is driven here from a fixture that is clean but for the one defect.
console.log("\nverify:experiments — the table register and result shape\n");
{
  const table = (section: string, index: number) => ({
    section,
    index,
    line: 1,
    header: ["a", "b"],
  });
  const complete: TableRegisterInput = {
    tables: [table("1", 0), table("2", 0), table("2", 1)],
    bound: new Set(["1#0", "2#1"]),
    unboundNotes: { "2#0": "prose" },
    expectedCells: { "1#0": 3, "2#1": 2 },
    checkedByTable: new Map([
      ["1#0", 3],
      ["2#1", 2],
    ]),
    skippedTables: new Set<string>(),
  };
  const run = (over: Partial<TableRegisterInput>) =>
    tableRegisterProblems({ ...complete, ...over });
  const only = (problems: string[], needle: string) =>
    problems.length === 1 && problems[0]?.includes(needle) === true;

  const none = run({});
  check(
    "a complete register reports nothing",
    none.length === 0,
    JSON.stringify(none),
  );

  const unexplained = run({ unboundNotes: {} });
  check(
    "a table with neither a binding nor an UNBOUND_NOTES entry fails",
    only(unexplained, "§2 table 0") &&
      only(unexplained, "no binding and no UNBOUND_NOTES entry"),
    JSON.stringify(unexplained),
  );

  const ghost = run({ unboundNotes: { "2#0": "prose", "9#0": "gone" } });
  check(
    "an UNBOUND_NOTES entry for a table the document lacks fails",
    only(ghost, 'UNBOUND_NOTES["9#0"]') && only(ghost, "no such table"),
    JSON.stringify(ghost),
  );

  const boundNote = run({ unboundNotes: { "2#0": "prose", "1#0": "why" } });
  check(
    "an UNBOUND_NOTES entry for a bound table fails",
    only(boundNote, 'UNBOUND_NOTES["1#0"]') && only(boundNote, "is bound"),
    JSON.stringify(boundNote),
  );

  const short = run({
    checkedByTable: new Map([
      ["1#0", 2],
      ["2#1", 2],
    ]),
  });
  check(
    "a bound table checking fewer cells than EXPECTED_CELLS fails",
    only(short, "§1 table 0: checked 2 cell(s), EXPECTED_CELLS asserts 3"),
    JSON.stringify(short),
  );

  const silent = run({ checkedByTable: new Map([["2#1", 2]]) });
  check(
    "a bound table that checked nothing fails against its count",
    only(silent, "§1 table 0: checked 0 cell(s), EXPECTED_CELLS asserts 3"),
    JSON.stringify(silent),
  );

  const unasserted = run({ expectedCells: { "1#0": 3 } });
  check(
    "a bound table with no EXPECTED_CELLS entry fails",
    only(unasserted, "§2 table 1: checked 2 cell(s) with no EXPECTED_CELLS"),
    JSON.stringify(unasserted),
  );

  const stale = run({ expectedCells: { "1#0": 3, "2#1": 2, "2#0": 4 } });
  check(
    "an EXPECTED_CELLS entry for an unbound table fails",
    only(stale, 'EXPECTED_CELLS["2#0"] asserts cells for a table no binding'),
    JSON.stringify(stale),
  );

  const skippedShort = run({
    checkedByTable: new Map([["2#1", 2]]),
    skippedTables: new Set(["1#0"]),
  });
  check(
    "a skipped table is not held to its count (the SKIP reports it)",
    skippedShort.length === 0,
    JSON.stringify(skippedShort),
  );

  const result = (): ResultFile => ({
    schema: RESULT_SCHEMA,
    tool: "sweep",
    name: "fixture",
    split: "tune",
    settings: {},
    provenance: {
      rev: "0".repeat(40),
      dirty: false,
      dirtyPaths: [],
      iqaCli: "iqa-cli fixture",
      config: "fixture.json",
      configSha256: "0".repeat(64),
      binaries: {},
      node: process.version,
      corpus: [
        { name: "a", sha256: "1".repeat(64) },
        { name: "b", sha256: "2".repeat(64) },
      ],
    },
    imageNames: ["a", "b"],
    rows: [
      {
        label: "arm",
        tune: null,
        tier: null,
        version: null,
        perImage: { ciede2000: [1, 2], bytes: [30, 31] },
      },
    ],
  });
  check(
    "a well-formed result has no shape problem",
    shapeProblems(result()).length === 0,
    JSON.stringify(shapeProblems(result())),
  );

  const futureSchema = result();
  futureSchema.schema = RESULT_SCHEMA + 1;
  const fs1 = shapeProblems(futureSchema);
  check(
    "a result of an unknown schema is refused",
    only(fs1, `this reader knows ${RESULT_SCHEMA}`),
    JSON.stringify(fs1),
  );

  const fewDigests = result();
  fewDigests.provenance.corpus.pop();
  const fs2 = shapeProblems(fewDigests);
  check(
    "a result with a corpus digest missing is refused",
    only(fs2, "provenance lists 1 corpus digests for 2 images"),
    JSON.stringify(fs2),
  );

  const misaligned = result();
  misaligned.provenance.corpus.reverse();
  const fs3 = shapeProblems(misaligned);
  check(
    "a result whose digests are out of image order is refused",
    only(fs3, 'corpus digest 0 is for "b", image 0 is "a"'),
    JSON.stringify(fs3),
  );

  const noCiede = result();
  const noCiedeRow = noCiede.rows[0];
  if (noCiedeRow) noCiedeRow.perImage = { bytes: [30, 31] };
  const fs4 = shapeProblems(noCiede);
  check(
    "a row with no ciede2000 series is refused",
    only(fs4, 'row "arm" carries no ciede2000 series'),
    JSON.stringify(fs4),
  );

  const ragged = result();
  const raggedRow = ragged.rows[0];
  if (raggedRow) raggedRow.perImage = { ciede2000: [1, 2], bytes: [30] };
  const fs5 = shapeProblems(ragged);
  check(
    "a series shorter than the image list is refused",
    only(fs5, 'row "arm" bytes has 1 values for 2 images'),
    JSON.stringify(fs5),
  );
}

// --- verify:experiments --fix: rewriting a cell keeps its markup (#109) -----
//
// `--fix` rewrites cells only when a table disagrees with its results, which
// the committed document never does, so no run CI makes reaches the rewriter.
// Each case is a cell shape the document uses, with the answer written out.
console.log("\nverify:experiments --fix — a rewritten cell keeps its markup\n");
{
  const cases: [string, string, boolean, string, string][] = [
    [
      "a cell bold on its number only keeps both markers and what follows",
      "**11.458** (−1.7%)",
      true,
      "11.457",
      "**11.457** (−1.7%)",
    ],
    [
      "a fully bold cell stays fully bold",
      "**4.21%**",
      true,
      "4.15",
      "**4.15%**",
    ],
    [
      "a bold signed cell keeps its + on a positive value",
      "**+4.21%**",
      true,
      "4.15",
      "**+4.15%**",
    ],
    [
      "a plain signed cell keeps its + and its annotation",
      "+0.40%, CI straddles",
      true,
      "0.39",
      "+0.39%, CI straddles",
    ],
    [
      "a signed cell turning negative takes the document's minus, not a +",
      "+0.480",
      true,
      "-0.496",
      "−0.496",
    ],
    [
      "a signed cell rounding to zero is written unsigned",
      "+0.004",
      false,
      "0.000",
      "0.000",
    ],
    [
      "a negative value rounding to zero is written unsigned, not −0.000",
      "+0.004",
      true,
      "-0.000",
      "0.000",
    ],
    ["an unsigned cell gains no +", "11.458", false, "11.457", "11.457"],
    [
      "a composite value is not given the old cell's suffix or sign",
      "+15/31",
      false,
      "16/31",
      "16/31",
    ],
  ];
  for (const [name, raw, unicode, value, want] of cases) {
    const got = rewriteCell(raw, value, unicode);
    check(name, got === want, `${raw} ← ${value}: ${got}`);
  }
}

// --- Alpha corpus: the retired holdout and withdrawn pins (#83) ------------
//
// `ensureAlphaImages` refuses the retired holdout split and never fetches a
// withdrawn pin. Neither branch runs in any sweep CI executes, so both are
// driven here through the selection it delegates to, without the network.
{
  console.log("\nalpha corpus selection:");

  let thrown = "";
  try {
    alphaImagesToFetch("holdout");
  } catch (e) {
    thrown = e instanceof Error ? e.message : String(e);
  }
  check(
    "the retired alpha holdout split is refused",
    thrown === ALPHA_HOLDOUT_RETIRED,
    thrown === "" ? "no error thrown" : thrown,
  );

  const base: AlphaImageSpec = {
    label: "fixture-kept",
    url: "https://example.invalid/kept.png",
    ext: ".png",
    width: 1,
    height: 1,
    split: "tune",
    nonOpaqueFraction: 0,
    softAlphaFraction: 0,
    sha256: "0".repeat(64),
    source: "https://example.invalid/kept",
    author: "fixture",
    licence: "CC0",
    notes: "fixture",
  };
  const fixture: AlphaImageSpec[] = [
    base,
    { ...base, label: "fixture-withdrawn", withdrawn: "gone" },
    { ...base, label: "fixture-holdout", split: "holdout" },
  ];
  const labels = (specs: AlphaImageSpec[]): string =>
    specs.map((s) => s.label).join(",");
  const tune = labels(alphaImagesToFetch("tune", fixture));
  check(
    "a withdrawn tune pin is not fetched for the tune split",
    tune === "fixture-kept",
    tune,
  );
  const all = labels(alphaImagesToFetch(undefined, fixture));
  check(
    "a withdrawn pin is not fetched with no split",
    all === "fixture-kept,fixture-holdout",
    all,
  );

  const shipped = alphaImagesToFetch().filter(
    (s) => s.withdrawn !== undefined || s.label === "cutout-wordmark-aflac",
  );
  check(
    "the deleted cutout-wordmark-aflac pin is never fetched",
    shipped.length === 0,
    labels(shipped),
  );
  check(
    "the withdrawn pin keeps its holdout split, so a cached copy cannot join tune",
    splitFor("cutout-wordmark-aflac") === "holdout",
    splitFor("cutout-wordmark-aflac"),
  );

  // The retired split's seven survivors are tune2 (#93).
  const survivors = [
    "cutout-app-icon-aptoide",
    "cutout-campaign-medal",
    "cutout-dslr-camera",
    "cutout-glassfish",
    "cutout-insignia-4id",
    "cutout-lineart-oinochoe",
    "cutout-planet-gas-giant",
  ];
  const tune2Pins = ALPHA_IMAGES.filter((s) => s.split === "tune2")
    .map((s) => s.label)
    .sort();
  check(
    "the retired alpha holdout's seven survivors, and only they, are tune2",
    tune2Pins.join(",") === survivors.join(",") &&
      survivors.every((l) => splitFor(l) === "tune2"),
    tune2Pins.join(","),
  );
  const leftInHoldout = ALPHA_IMAGES.filter(
    (s) => s.split === "holdout" && s.withdrawn === undefined,
  );
  check(
    "no fetchable alpha pin is left in the retired holdout split",
    leftInHoldout.length === 0,
    leftInHoldout.map((s) => s.label).join(","),
  );
  check(
    "the retired-holdout refusal names tune2 and the sealed holdout2",
    ALPHA_HOLDOUT_RETIRED.includes("--split tune2") &&
      ALPHA_HOLDOUT_RETIRED.includes("holdout2"),
    ALPHA_HOLDOUT_RETIRED,
  );
  check(
    "a tune2 alpha fetch takes the tune2 pins only",
    labels(
      alphaImagesToFetch("tune2", [
        ...fixture,
        { ...base, label: "fixture-survivor", split: "tune2" },
      ]),
    ) === "fixture-survivor",
    "",
  );
}

// --- Alpha corpus: the sealed holdout2 (#93) ---------------------------------
//
// The alpha holdout2 opens through the same register gate as the photographic
// one, and nothing a CI sweep runs asks for it, so every branch of its
// selection and of the corpus rule that tells it from a sealed photograph is
// driven here from fixtures.
{
  console.log("\nalpha holdout2:");

  const thrown = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "";
  };
  const sealedCutout = `${ALPHA_HOLDOUT2_PREFIX}fixture`;
  check(
    "the alpha seal is the holdout2 seal followed by the alpha corpus prefix",
    ALPHA_HOLDOUT2_PREFIX === `${HOLDOUT2_PREFIX}cutout-`,
    ALPHA_HOLDOUT2_PREFIX,
  );
  check(
    "a sealed-cutout- image is holdout2, in the alpha corpus and not the photographic one",
    splitFor(sealedCutout) === "holdout2" &&
      inCorpus(sealedCutout, "alpha") &&
      !inCorpus(sealedCutout, "photo") &&
      !inCorpus(sealedCutout, "graphic"),
    splitFor(sealedCutout),
  );
  check(
    "a sealed photograph stays out of the alpha corpus",
    inCorpus(`${HOLDOUT2_PREFIX}phone-fixture`, "photo") &&
      !inCorpus(`${HOLDOUT2_PREFIX}phone-fixture`, "alpha"),
    "",
  );
  const sealedGraphic = `${HOLDOUT2_PREFIX}graphic-fixture`;
  check(
    "a sealed-graphic- image is filed under the graphics corpus, not the photographic one",
    inCorpus(sealedGraphic, "graphic") &&
      !inCorpus(sealedGraphic, "photo") &&
      !inCorpus(sealedGraphic, "alpha"),
    "",
  );
  check(
    '--split holdout2 refuses the "all" corpus, and reads photo or alpha',
    thrown(() => assertHoldout2Corpus("all")) === HOLDOUT2_ALL_REFUSED &&
      thrown(() => assertHoldout2Corpus("photo")) === "" &&
      thrown(() => assertHoldout2Corpus("alpha")) === "",
    thrown(() => assertHoldout2Corpus("all")),
  );
  check(
    '"all" excludes a sealed cut-out, and the report drops a cached one',
    !inSplit(sealedCutout, "all") &&
      partitionSealed([`/fx/alpha/${sealedCutout}.png`]).sealed.length === 1,
    "",
  );
  check(
    "a sealed cut-out is real content, not a synthetic fixture",
    tierFor(sealedCutout) === "real",
    tierFor(sealedCutout),
  );

  const base: AlphaImageSpec = {
    label: "cutout-open",
    url: "https://example.invalid/open.png",
    ext: ".png",
    width: 1,
    height: 1,
    split: "tune",
    nonOpaqueFraction: 0.5,
    softAlphaFraction: 0,
    sha256: "0".repeat(64),
    source: "https://example.invalid/open",
    author: "fixture",
    licence: "CC0",
    notes: "fixture",
  };
  const sealed: AlphaImageSpec = {
    ...base,
    label: sealedCutout,
    split: "holdout2",
  };
  const opening = {
    decision: "C2",
    register: "spec/V0.8-DECISIONS.md",
    registerSha256: "0".repeat(64),
  };
  const table = [base, sealed];
  const labels = (specs: AlphaImageSpec[]): string =>
    specs.map((s) => s.label).join(",");

  check(
    "the alpha holdout2 is refused without the gate's opening",
    thrown(() => alphaImagesToFetch("holdout2", table)).includes(
      "fetched only through the register gate",
    ),
    thrown(() => alphaImagesToFetch("holdout2", table)),
  );
  check(
    "an opened alpha holdout2 fetches exactly its sealed pins",
    labels(alphaImagesToFetch("holdout2", table, opening)) === sealedCutout,
    labels(alphaImagesToFetch("holdout2", table, opening)),
  );
  check(
    "with no split, the alpha fetch skips every sealed pin",
    labels(alphaImagesToFetch(undefined, table)) === "cutout-open",
    labels(alphaImagesToFetch(undefined, table)),
  );
  const empty = thrown(() => alphaImagesToFetch("holdout2", [base], opening));
  check(
    "an opened alpha holdout2 with no pins refuses rather than scoring nothing",
    empty.startsWith(ALPHA_HOLDOUT2_UNPINNED) && empty.includes('"C2"'),
    empty,
  );
  const gone = thrown(() =>
    alphaImagesToFetch(
      "holdout2",
      [...table, { ...sealed, label: `${sealedCutout}-gone`, withdrawn: "x" }],
      opening,
    ),
  );
  check(
    "an alpha holdout2 with a withdrawn pin refuses, since it cannot be read whole",
    gone.includes("cannot be read whole"),
    gone,
  );
  // The fourteen approved in #107: sixteen were proposed, and the LAPD patch
  // and the AI-generated filing-cabinet icon were dropped, not replaced.
  const approved = [
    "sealed-cutout-2006-nd-proof",
    "sealed-cutout-bupropion-molecule-spacefill",
    "sealed-cutout-coffee-bean",
    "sealed-cutout-flashlight-symbol",
    "sealed-cutout-flowerit-5-gray",
    "sealed-cutout-helmed-hoplite-sparta",
    "sealed-cutout-journal-plague-year",
    "sealed-cutout-languages-difference-icon",
    "sealed-cutout-mammal-barnstar-hires",
    "sealed-cutout-marcosticks-3d-printed",
    "sealed-cutout-neuro-muscular-junction",
    "sealed-cutout-new-doodles-2016",
    "sealed-cutout-uscgc-florence-finch",
    "sealed-cutout-usmc-pistol-marksman",
  ];
  const shippedSealed = alphaHoldout2Specs()
    .map((s) => s.label)
    .sort();
  check(
    "the shipped alpha holdout2 is exactly the fourteen approved pins",
    shippedSealed.join(",") === approved.join(","),
    shippedSealed.join(","),
  );
  check(
    "an opened alpha holdout2 fetches every approved pin",
    labels(alphaImagesToFetch("holdout2", undefined, opening))
      .split(",")
      .sort()
      .join(",") === approved.join(","),
    "",
  );
  const leaked = alphaImagesToFetch()
    .concat(alphaImagesToFetch("tune"), alphaImagesToFetch("tune2"))
    .filter((s) => s.split === "holdout2");
  check(
    "no unopened alpha fetch reaches a shipped holdout2 pin",
    leaked.length === 0 && approved.every((l) => splitFor(l) === "holdout2"),
    labels(leaked),
  );
  for (const [what, bad] of [
    [
      "an alpha holdout2 pin without the prefix",
      { ...sealed, label: "cutout-x" },
    ],
    [
      "a sealed-cutout- pin on another split",
      { ...sealed, split: "tune" as const },
    ],
    [
      "an alpha pin sealed as a photograph",
      { ...sealed, label: `${HOLDOUT2_PREFIX}x` },
    ],
  ] as const) {
    const message = thrown(() => alphaHoldout2Specs([bad]));
    check(`${what} is refused`, message.includes("is labelled"), message);
  }
}

// --- Photographic splits: tune2 retired, holdout2 sealed (#76) --------------
//
// The gate that opens holdout2 fails a run only on register states the
// repository is not in, and no sweep CI runs ever asks for holdout2, so every
// branch is driven here from fixtures, without the network.
{
  console.log("\nphotographic splits and the holdout2 gate:");

  const thrown = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "";
  };
  const rejected = async (f: () => Promise<unknown>): Promise<string> => {
    try {
      await f();
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "";
  };

  // The retired split: every photograph that was holdout is tune2 now.
  const kodak = splitFor("kodak07");
  check("Kodak24 is tune2", kodak === "tune2", kodak);
  const former = CURATED_IMAGES.filter((s) => s.split === "tune2");
  check(
    "the eight curated photographs of the spent holdout are tune2",
    former.length === 8 && former.every((s) => splitFor(s.label) === "tune2"),
    former.map((s) => s.label).join(","),
  );
  const stillHoldout = CURATED_IMAGES.filter((s) => s.split === "holdout");
  check(
    "no photograph is left in the retired holdout split",
    stillHoldout.length === 0,
    stillHoldout.map((s) => s.label).join(","),
  );
  check(
    "--split holdout is refused for photographs, naming tune2",
    thrown(() => parseScratchPhotoSplit("holdout")) === PHOTO_HOLDOUT_RETIRED,
    thrown(() => parseScratchPhotoSplit("holdout")),
  );
  check(
    "an unknown --split is refused, not defaulted",
    thrown(() => parseSplit("holdout9", true)).startsWith("unknown --split"),
    thrown(() => parseSplit("holdout9", true)),
  );

  // The seal: by prefix, out of "all", out of every scratch tool.
  check(
    "a sealed- image is holdout2 whatever the tables say",
    splitFor(`${HOLDOUT2_PREFIX}fixture`) === "holdout2",
    splitFor(`${HOLDOUT2_PREFIX}fixture`),
  );
  check(
    "a sealed- image is photographic, so a photo sweep can read it once opened",
    inCorpus(`${HOLDOUT2_PREFIX}fixture`, "photo"),
    "",
  );
  check(
    '"all" excludes the sealed split and keeps tune2',
    !inSplit(`${HOLDOUT2_PREFIX}fixture`, "all") &&
      inSplit("kodak07", "all") &&
      inSplit("kodak07", "tune2"),
    "",
  );
  check(
    "a scratch tool refuses holdout2",
    thrown(() => parseScratchPhotoSplit("holdout2")).includes(
      "does not read holdout2",
    ),
    thrown(() => parseScratchPhotoSplit("holdout2")),
  );
  const globbed = [
    "/fx/natural/natural-open.jpg",
    `/fx/natural/${HOLDOUT2_PREFIX}fixture.jpg`,
    "/fx/holdout/kodak07.png",
    `/fx/natural/${HOLDOUT2_PREFIX}other.png`,
  ];
  const parted = partitionSealed(globbed);
  check(
    "the report drops every cached sealed- image and keeps the rest in order",
    parted.open.join(",") ===
      "/fx/natural/natural-open.jpg,/fx/holdout/kodak07.png" &&
      parted.sealed.join(",") ===
        `/fx/natural/${HOLDOUT2_PREFIX}fixture.jpg,/fx/natural/${HOLDOUT2_PREFIX}other.png`,
    `open=${parted.open.join(",")} sealed=${parted.sealed.join(",")}`,
  );

  // The register's contract, one branch at a time.
  const register = [
    "# v0.8 decisions",
    "",
    "## D1. Entropy-coded AC",
    "",
    "**Status:** frozen",
    "",
    "### Evidence",
    "",
    "Status notes live here and are part of D1.",
    "",
    "## D1.1 A sub-question",
    "",
    "Status: open",
    "",
    "## D2 — Separable DCT",
    "",
    "```",
    "Status: frozen",
    "```",
    "- Status: decided",
    "",
    "## D3: Alpha at tiers 2-3",
    "",
    "Status: open",
    "Status: frozen",
    "",
    "## D4) No status",
    "",
    "## D5 twice",
    "Status: frozen",
    "## D5 again",
    "Status: frozen",
    "",
  ].join("\n");
  const status = (id: string): string => {
    const r = registerStatus(register, id);
    return "status" in r ? r.status : `error: ${r.error}`;
  };
  check(
    "a bold status line under its heading is read",
    status("D1") === "frozen",
    status("D1"),
  );
  check(
    "D1 does not match D1.1's heading, and D1.1 has its own status",
    status("D1.1") === "open",
    status("D1.1"),
  );
  check(
    "a status inside a fenced block is ignored; the list-item one is read",
    status("D2") === "decided",
    status("D2"),
  );
  check(
    "two status lines in one section are refused",
    status("D3").startsWith("error:") && status("D3").includes("2 status"),
    status("D3"),
  );
  check(
    "a section with no status line is refused",
    status("D4").includes("0 status"),
    status("D4"),
  );
  check(
    "a decision headed twice is refused",
    status("D5").includes("2 times"),
    status("D5"),
  );
  check(
    "an absent decision is refused",
    status("D9").includes("no decision headed"),
    status("D9"),
  );

  // The gate itself, against a fixture register on disk.
  const dir = mkdtempSync(path.join(tmpdir(), "holdout2-gate-"));
  const fixturePath = path.join(dir, "V0.8-DECISIONS.md");
  writeFileSync(fixturePath, register);
  const opened = (() => {
    try {
      return openHoldout2("D1", fixturePath);
    } catch {
      return null;
    }
  })();
  check(
    "a frozen decision opens holdout2 and records the register's digest",
    opened !== null &&
      opened.decision === "D1" &&
      /^[0-9a-f]{64}$/.test(opened.registerSha256),
    opened === null ? "refused" : opened.registerSha256.slice(0, 12),
  );
  const refusals: [string, string | undefined, string, string][] = [
    ["no --decision", undefined, fixturePath, "needs --decision"],
    ["a malformed ID", "../D1", fixturePath, "is not a decision ID"],
    ["an open decision", "D1.1", fixturePath, 'as "open"'],
    ["a decided decision", "D2", fixturePath, 'as "decided"'],
    ["an ambiguous register", "D3", fixturePath, "2 status lines"],
    ["a missing register", "D1", path.join(dir, "absent.md"), "does not exist"],
  ];
  for (const [what, id, at, expect] of refusals) {
    const message = thrown(() => openHoldout2(id, at));
    check(`the gate refuses ${what}`, message.includes(expect), message);
  }

  // One reading per question, and a pin table that agrees with the prefix.
  const existing = path.join(dir, "fixture-holdout2.json");
  writeFileSync(existing, "{}");
  check(
    "a committed holdout2 result is never overwritten",
    thrown(() => assertHoldout2Unread(existing)).includes(
      "already holds a holdout2 reading",
    ),
    thrown(() => assertHoldout2Unread(existing)),
  );
  check(
    "an unread holdout2 result path passes",
    thrown(() => assertHoldout2Unread(path.join(dir, "unread.json"))) === "",
    "",
  );
  const spec: NaturalImageSpec = {
    label: `${HOLDOUT2_PREFIX}fixture`,
    urls: ["https://example.invalid/sealed.jpg"],
    ext: ".jpg",
    width: 1,
    height: 1,
    split: "holdout2",
    sha256: "0".repeat(64),
    source: "https://example.invalid/sealed",
    author: "fixture",
    licence: "CC0",
    axis: "fixture",
    notes: "fixture",
  };
  check(
    "holdout2 pins are the sealed- ones",
    holdout2Specs([spec, { ...spec, label: "natural-open", split: "tune" }])
      .length === 1,
    "",
  );
  for (const [what, bad] of [
    ["a holdout2 pin without the prefix", { ...spec, label: "natural-x" }],
    ["a sealed- pin on another split", { ...spec, split: "tune" as const }],
    [
      "a photographic pin sealed as a cut-out",
      { ...spec, label: `${ALPHA_HOLDOUT2_PREFIX}x` },
    ],
  ] as const) {
    const message = thrown(() => holdout2Specs([bad]));
    check(`${what} is refused`, message.includes("is labelled"), message);
  }

  // The ordinary natural-image fetch never touches a holdout2 pin.
  const table: NaturalImageSpec[] = [
    { ...spec, label: "natural-open", split: "tune" },
    spec,
    { ...spec, label: "natural-spent", split: "tune2" },
  ];
  const fetchLabels = (only?: readonly string[]): string =>
    naturalImagesToFetch(only, table)
      .map((s) => s.label)
      .join(",");
  check(
    "the natural-image fetch skips every holdout2 pin",
    fetchLabels() === "natural-open,natural-spent",
    fetchLabels(),
  );
  check(
    "a label list is honoured, and unknown labels still throw",
    fetchLabels(["natural-spent"]) === "natural-spent" &&
      thrown(() => fetchLabels(["natural-absent"])).startsWith(
        "unknown curated image label",
      ),
    fetchLabels(["natural-spent"]),
  );
  const askedSealed = thrown(() => fetchLabels([spec.label]));
  check(
    "a holdout2 pin asked for by label is refused before any fetch",
    askedSealed.includes("sealed holdout2 split") &&
      askedSealed.includes("ensureHoldout2Images"),
    askedSealed,
  );
  if (opened !== null) {
    const empty = await rejected(() => ensureHoldout2Images(opened, []));
    check(
      "an opened holdout2 with no pins refuses rather than scoring nothing",
      empty.includes("no pinned images"),
      empty,
    );
  }
  // The covariates holdout2 candidates are chosen on (corpus-covariates.ts).
  const [rL, ra, rb] = srgbToLab(255, 0, 0);
  check(
    "sRGB red is CIELAB (53.24, 80.09, 67.20) under D65",
    Math.abs(rL - 53.24) < 0.01 &&
      Math.abs(ra - 80.09) < 0.01 &&
      Math.abs(rb - 67.2) < 0.01,
    `${rL.toFixed(3)}, ${ra.toFixed(3)}, ${rb.toFixed(3)}`,
  );
  const size = { width: 8, height: 4 };
  const grey = covariatesOf(
    makeRgba(8, 4, () => [119, 119, 119]),
    8,
    4,
    size,
  );
  check(
    "a flat grey is achromatic, keyless and has no detail",
    // The sRGB→XYZ matrix's rows reach D65 only to 7 digits, so neutral
    // lands within 1e-4 of the axis rather than on it.
    grey.meanC < 1e-4 &&
      grey.detail === 0 &&
      grey.highKey === 0 &&
      grey.lowKey === 0 &&
      Math.abs(grey.meanL - 50) < 0.5,
    `L ${grey.meanL.toFixed(2)} C ${grey.meanC} detail ${grey.detail}`,
  );
  const white = covariatesOf(
    makeRgba(8, 4, () => [255, 255, 255]),
    8,
    4,
    size,
  );
  check(
    "white is all high-key",
    white.highKey === 1 && Math.abs(white.meanL - 100) < 1e-4,
    `L ${white.meanL} high ${white.highKey}`,
  );
  const checker = covariatesOf(
    makeRgba(8, 4, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0])),
    8,
    4,
    size,
  );
  check(
    "a one-pixel checkerboard has the largest 4-neighbour Laplacian: 4 × 100 L*",
    Math.abs(checker.detail - 400) < 1e-3 &&
      checker.highKey === 0.5 &&
      checker.lowKey === 0.5,
    `detail ${checker.detail}`,
  );
  check(
    "orientation is of the dimensions the caller gives",
    grey.orientation === "landscape" && grey.exifOrientation === null,
    grey.orientation,
  );
  for (const [licence, ok] of [
    ["CC BY-SA 4.0", true],
    ["CC BY-SA 3.0 us", true],
    ["CC0", true],
    ["Public domain", true],
    ["CC BY-NC-SA 4.0", false],
    ["CC BY-ND 4.0", false],
    ["GFDL", false],
    ["", false],
  ] as const) {
    check(
      `the curation tool ${ok ? "admits" : "refuses"} "${licence}"`,
      isFreeLicence(licence) === ok,
      "",
    );
  }

  // measureFile: the reference is capped at 512 px and never enlarged, and
  // it is of the upright picture.
  const checkerPng = (w: number, h: number): Promise<Buffer> =>
    sharp(
      Buffer.from(
        makeRgba(w, h, (x, y) =>
          (x + y) % 2 === 0 ? [255, 255, 255] : [0, 0, 0],
        ),
      ),
      { raw: { width: w, height: h, channels: 4 } },
    )
      .png()
      .toBuffer();
  const small = await measureFile(await checkerPng(16, 8));
  check(
    "measureFile never enlarges: a 16 × 8 checkerboard keeps detail 400",
    small.width === 16 && Math.abs(small.detail - 400) < 1e-3,
    `${small.width}×${small.height} detail ${small.detail}`,
  );
  const large = await measureFile(await checkerPng(1024, 512));
  check(
    "measureFile resamples to the 512 px reference: a 1024 × 512 checkerboard averages to flat grey",
    large.width === 1024 &&
      large.height === 512 &&
      large.detail < 0.01 &&
      large.highKey === 0 &&
      large.lowKey === 0,
    `${large.width}×${large.height} detail ${large.detail}`,
  );
  // A file stored 24 × 12, left half white and right half black, tagged
  // Orientation 6 (turn a quarter clockwise to view): upright it is 12 × 24
  // with the white half on top. The harness encodes, scores and measures the
  // upright picture (#102), so every path must see it that way.
  const sideways = await sharp(
    Buffer.from(
      makeRgba(24, 12, (x) => (x < 12 ? [255, 255, 255] : [0, 0, 0])),
    ),
    { raw: { width: 24, height: 12, channels: 4 } },
  )
    .jpeg({ quality: 100 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const rotated = await measureFile(sideways);
  check(
    "measureFile records EXIF Orientation and measures the upright picture",
    rotated.exifOrientation === 6 &&
      rotated.width === 12 &&
      rotated.height === 24 &&
      rotated.orientation === "portrait",
    `exif ${rotated.exifOrientation} ${rotated.width}×${rotated.height} ${rotated.orientation}`,
  );
  check(
    "orientedSize swaps only for the quarter-turn tags 5–8",
    [1, 2, 3, 4, 5, 6, 7, 8, undefined]
      .map((o) => orientedSize({ width: 3, height: 2, orientation: o }).width)
      .join() === "3,3,3,3,2,2,2,2,3",
    "",
  );
  {
    const dir = mkdtempSync(path.join(tmpdir(), "chromahash-orient-"));
    const file = path.join(dir, "sideways.jpg");
    writeFileSync(file, sideways);
    const input = await loadImage(file);
    // Mean of the red channel over the top and bottom halves of a raster.
    const halves = (rgba: Uint8Array, w: number, h: number): number[] =>
      [0, 1].map((half) => {
        let sum = 0;
        for (let y = half * (h / 2); y < (half + 1) * (h / 2); y++) {
          for (let x = 0; x < w; x++) sum += rgba[4 * (y * w + x)] ?? 0;
        }
        return sum / ((w * h) / 2);
      });
    const [refTop = 0, refBottom = 0] = halves(
      input.referenceRgba,
      input.referenceWidth,
      input.referenceHeight,
    );
    const [smallTop = 0, smallBottom = 0] = halves(
      input.smallRgba,
      input.smallWidth,
      input.smallHeight,
    );
    check(
      "loadImage encodes and scores the upright picture of an EXIF-rotated file",
      input.originalWidth === 12 &&
        input.originalHeight === 24 &&
        input.referenceWidth === 12 &&
        input.referenceHeight === 24 &&
        input.smallWidth === 12 &&
        input.smallHeight === 24 &&
        refTop > 200 &&
        refBottom < 55 &&
        smallTop > 200 &&
        smallBottom < 55,
      `${input.originalWidth}×${input.originalHeight}, reference top ${refTop.toFixed(0)} bottom ${refBottom.toFixed(0)}, small top ${smallTop.toFixed(0)} bottom ${smallBottom.toFixed(0)}`,
    );
    // The report's display image: its stored pixels must already be upright,
    // and it must carry no Orientation tag a browser would apply again.
    const display = dataUriToBuffer(
      await fileBufferToDisplayDataUri(sideways),
    ).buffer;
    const displayMeta = await sharp(display).metadata();
    const { data: displayRgba, info: displayInfo } = await sharp(display)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const [displayTop = 0, displayBottom = 0] = halves(
      new Uint8Array(displayRgba),
      displayInfo.width,
      displayInfo.height,
    );
    check(
      "fileBufferToDisplayDataUri shows the upright picture of an EXIF-rotated file",
      displayInfo.width === 12 &&
        displayInfo.height === 24 &&
        (displayMeta.orientation ?? 1) === 1 &&
        displayTop > 200 &&
        displayBottom < 55,
      `${displayInfo.width}×${displayInfo.height} orientation ${displayMeta.orientation}, top ${displayTop.toFixed(0)} bottom ${displayBottom.toFixed(0)}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // The alpha covariates the alpha holdout2 candidates are chosen on (#93).
  check(
    "an image with no alpha channel has no alpha covariates",
    rotated.alpha === null,
    JSON.stringify(rotated.alpha),
  );
  const fractions = alphaFractions(
    new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255]),
  );
  check(
    "alpha 255, 0, 128, 255 is half non-opaque and a quarter soft",
    fractions.nonOpaqueFraction === 0.5 && fractions.softAlphaFraction === 0.25,
    JSON.stringify(fractions),
  );
  const mask = (
    w: number,
    h: number,
    on: (x: number, y: number) => boolean,
  ): Uint8Array => {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[4 * (y * w + x) + 3] = on(x, y) ? 255 : 0;
    }
    return out;
  };
  const square = silhouetteOf(
    mask(16, 16, (x, y) => x >= 4 && x < 12 && y >= 4 && y < 12),
    16,
    16,
  );
  const dots = silhouetteOf(
    mask(16, 16, (x, y) => (x === 2 && y === 2) || (x === 9 && y === 9)),
    16,
    16,
  );
  const edge = silhouetteOf(
    mask(4, 4, () => true),
    4,
    4,
  );
  check(
    "an axis-aligned square scores silhouette 1, two lone pixels √2, and the raster border counts as edge",
    square === 1 &&
      dots !== null &&
      Math.abs(dots - Math.SQRT2) < 1e-12 &&
      edge === 1,
    `square ${square} dots ${dots} edge ${edge}`,
  );
  check(
    "an empty mask has no silhouette",
    silhouetteOf(
      mask(4, 4, () => false),
      4,
      4,
    ) === null,
    "",
  );
  const halfPng = await sharp(Buffer.from(mask(1024, 512, (x) => x >= 512)), {
    raw: { width: 1024, height: 512, channels: 4 },
  })
    .png()
    .toBuffer();
  const half = await measureFile(halfPng);
  // Squared to 512 × 512, the opaque half is a 256 × 512 rectangle on the
  // border: P = 2 (256 + 512), A = 256 · 512.
  const halfSilhouette = 1536 / (4 * Math.sqrt(256 * 512));
  check(
    "measureFile takes the alpha fractions on the stored pixels and the silhouette on a square resample",
    half.alpha !== null &&
      half.alpha.nonOpaqueFraction === 0.5 &&
      half.alpha.softAlphaFraction === 0 &&
      half.alpha.silhouette !== null &&
      Math.abs(half.alpha.silhouette - halfSilhouette) < 0.02,
    `${JSON.stringify(half.alpha)} (expected silhouette ${halfSilhouette.toFixed(4)})`,
  );
  const strip = await measureFile(
    await sharp(Buffer.from(mask(1300, 100, () => true)), {
      raw: { width: 1300, height: 100, channels: 4 },
    })
      .png()
      .toBuffer(),
  );
  check(
    "the silhouette ignores the raster's aspect: an opaque 13:1 strip scores 1, not the ~2 its own raster would",
    strip.alpha?.silhouette === 1,
    JSON.stringify(strip.alpha),
  );

  // The --commons path's refusals, on the facts Commons would return.
  const facts: CommonsFacts = {
    title: "File:Fixture.jpg",
    url: "https://example.invalid/Fixture.jpg",
    descriptionUrl: "https://example.invalid/File:Fixture.jpg",
    sha1: createHash("sha1").update("fixture").digest("hex"),
    mime: "image/jpeg",
    licence: "CC BY-SA 4.0",
    author: "fixture",
    make: null,
    model: null,
    software: null,
    dateTimeOriginal: null,
    categories: [],
    width: 4000,
    height: 3000,
    size: 5_000_000,
  };
  const reason = (f: CommonsFacts | string | undefined): string => {
    const a = admit(f);
    return "reason" in a ? a.reason : "";
  };
  check(
    "a free JPEG Commons describes is admitted",
    reason(facts) === "",
    reason(facts),
  );
  check(
    "a file Commons does not describe is refused with Commons' reason",
    reason("Commons has no such file") === "Commons has no such file" &&
      reason(undefined) === "not asked",
    reason("Commons has no such file"),
  );
  check(
    "a non-free licence is refused",
    reason({ ...facts, licence: "CC BY-NC 4.0" }).includes(
      "not one the corpus admits",
    ),
    reason({ ...facts, licence: "CC BY-NC 4.0" }),
  );
  check(
    "a MIME type other than JPEG or PNG is refused",
    reason({ ...facts, mime: "image/tiff" }) ===
      "image/tiff is not JPEG or PNG",
    reason({ ...facts, mime: "image/tiff" }),
  );
  check(
    "bytes matching Commons' SHA-1 pass, and any other bytes are refused",
    sha1Mismatch(Buffer.from("fixture"), facts.sha1) === null &&
      (sha1Mismatch(Buffer.from("fixturf"), facts.sha1) ?? "").includes(
        `Commons records ${facts.sha1}`,
      ),
    sha1Mismatch(Buffer.from("fixturf"), facts.sha1) ?? "",
  );

  const shipped = thrown(() => holdout2Specs());
  check(
    "the shipped pin table's prefixes and splits agree",
    shipped === "",
    shipped || `${holdout2Specs().length} holdout2 pin(s)`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- holdout3: the third sealed split (#129) --------------------------------
//
// The seal, the gate (one read per register entry and tool), the fetchers,
// the strata, and the covariates and protocol the draw ran on. Like holdout2's
// block, every refusal is driven from fixtures, without the network.
{
  console.log("\nholdout3 — the seal, the gate, the strata and the draw:");

  const thrown = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "";
  };
  const rejected = async (f: () => Promise<unknown>): Promise<string> => {
    try {
      await f();
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return "";
  };
  const corpora = ["photo", "alpha", "graphic"] as const;

  // The seal: by prefix, one corpus each, out of "all" and every scratch tool.
  for (const [label, corpus] of [
    [`${HOLDOUT3_PREFIX}phone-fixture`, "photo"],
    [`${ALPHA_HOLDOUT3_PREFIX}fixture`, "alpha"],
    [`${GRAPHIC_HOLDOUT3_PREFIX}chart-fixture`, "graphic"],
  ] as const) {
    const inside = corpora.filter((c) => inCorpus(label, c));
    check(
      `${label} is holdout3, sealed, real, in the ${corpus} corpus alone, and out of "all"`,
      splitFor(label) === "holdout3" &&
        isSealed(splitFor(label)) &&
        tierFor(label) === "real" &&
        inside.join(",") === corpus &&
        !inSplit(label, "all") &&
        inSplit(label, "holdout3"),
      `${splitFor(label)} ${inside.join(",")}`,
    );
  }
  check(
    "the two seals never claim each other's images",
    !HOLDOUT3_PREFIX.startsWith(HOLDOUT2_PREFIX) &&
      splitFor(`${HOLDOUT2_PREFIX}x`) === "holdout2" &&
      splitFor(`${HOLDOUT3_PREFIX}x`) === "holdout3",
    "",
  );
  check(
    "--split holdout3 parses, and a scratch tool refuses it",
    parseSplit("holdout3", false) === "holdout3" &&
      thrown(() => parseScratchPhotoSplit("holdout3")).includes(
        "does not read holdout3",
      ),
    thrown(() => parseScratchPhotoSplit("holdout3")),
  );
  const parted = partitionSealed([
    "/fx/natural/natural-open.jpg",
    `/fx/natural/${HOLDOUT3_PREFIX}phone-x.jpg`,
    `/fx/alpha/${ALPHA_HOLDOUT3_PREFIX}x.png`,
    `/fx/graphic/${GRAPHIC_HOLDOUT3_PREFIX}map-x.png`,
  ]);
  check(
    "the report drops every cached sealed3- image",
    parted.open.join(",") === "/fx/natural/natural-open.jpg" &&
      parted.sealed.length === 3,
    `open=${parted.open.join(",")}`,
  );
  const shippedSealed3 = [
    ...CURATED_IMAGES,
    ...ALPHA_IMAGES,
    ...GRAPHIC_IMAGES,
  ].filter((s) => s.label.startsWith(HOLDOUT3_PREFIX));
  check(
    "splitFor maps every shipped sealed3-* label to holdout3, and every shipped holdout3 pin is labelled sealed3-*",
    shippedSealed3.every((s) => splitFor(s.label) === "holdout3") &&
      [...CURATED_IMAGES, ...ALPHA_IMAGES, ...GRAPHIC_IMAGES]
        .filter((s) => s.split === "holdout3")
        .every((s) => s.label.startsWith(HOLDOUT3_PREFIX)),
    `${shippedSealed3.length} sealed3- pin(s)`,
  );

  // The gate, against a fixture register.
  const dir = mkdtempSync(path.join(tmpdir(), "holdout3-gate-"));
  const fixturePath = path.join(dir, "V0.8-DECISIONS.md");
  writeFileSync(
    fixturePath,
    [
      "# register",
      "",
      "### D1. Frozen",
      "",
      "- **Status:** frozen. Criteria approved.",
      "",
      "### D2. Open",
      "",
      "- **Status:** open. Criteria approved.",
      "",
      "### D3. Decided",
      "",
      "- **Status:** decided.",
      "",
    ].join("\n"),
  );
  const opened = (() => {
    try {
      return openHoldout3("D1", fixturePath);
    } catch {
      return null;
    }
  })();
  check(
    "a frozen entry opens holdout3, and the opening names its split and the register's digest",
    opened !== null &&
      opened.split === "holdout3" &&
      opened.decision === "D1" &&
      /^[0-9a-f]{64}$/.test(opened.registerSha256),
    opened === null ? "refused" : opened.registerSha256.slice(0, 12),
  );
  for (const [what, id, at, expect] of [
    ["an open entry", "D2", fixturePath, 'as "open"'],
    ["a decided entry", "D3", fixturePath, 'as "decided"'],
    ["no --decision", undefined, fixturePath, "--split holdout3 needs"],
    ["an absent entry", "D9", fixturePath, "no decision headed"],
    ["a missing register", "D1", path.join(dir, "absent.md"), "does not exist"],
  ] as const) {
    const message = thrown(() => openHoldout3(id, at));
    check(
      `the holdout3 gate refuses ${what}`,
      message.includes(expect) && message.includes("holdout3"),
      message,
    );
  }

  // One read per entry and tool, under any result name.
  const results = path.join(dir, "results");
  mkdirSync(results);
  const read = (file: string, tool: string, split: string, decision: string) =>
    writeFileSync(
      path.join(results, file),
      JSON.stringify({
        tool,
        split,
        settings: { [split]: { decision } },
      }),
    );
  read("d1-sweep-holdout3.json", "sweep", "holdout3", "D1");
  read("d2-sweep-holdout2.json", "sweep", "holdout2", "D2");
  check(
    "a second sweep of holdout3 for one entry is refused, whatever its result is named",
    thrown(() => assertHoldout3Unread("D1", "sweep", results)).includes(
      "already been read by sweep",
    ),
    thrown(() => assertHoldout3Unread("D1", "sweep", results)),
  );
  check(
    "another entry, or the other tool, may still read it once; a holdout2 read does not count",
    thrown(() => assertHoldout3Unread("D1", "rd-budget", results)) === "" &&
      thrown(() => assertHoldout3Unread("D2", "sweep", results)) === "",
    "",
  );
  check(
    "holdout3Reads lists exactly the holdout3 results",
    holdout3Reads(results)
      .map((r) => `${r.file}:${r.tool}:${r.decision}`)
      .join(",") === "d1-sweep-holdout3.json:sweep:D1",
    JSON.stringify(holdout3Reads(results)),
  );
  const existing = path.join(results, "d1-sweep-holdout3.json");
  check(
    "a committed holdout3 result file is never overwritten either",
    thrown(() => assertHoldout2Unread(existing, "holdout3")).includes(
      "already holds a holdout3 reading",
    ),
    thrown(() => assertHoldout2Unread(existing, "holdout3")),
  );
  const registerText = readFileSync(
    path.resolve(import.meta.dirname, "../../../spec/V0.8-DECISIONS.md"),
    "utf8",
  );
  const shippedReads = holdout3Reads();
  const byEntry = new Map<string, number>();
  for (const r of shippedReads) {
    byEntry.set(
      `${r.decision}/${r.tool}`,
      (byEntry.get(`${r.decision}/${r.tool}`) ?? 0) + 1,
    );
  }
  const badReads = shippedReads.filter((r) => {
    const s = registerStatus(registerText, r.decision);
    return (
      !("status" in s) ||
      (s.status !== "frozen" && s.status !== "decided") ||
      (byEntry.get(`${r.decision}/${r.tool}`) ?? 0) > 1
    );
  });
  check(
    "every committed holdout3 read names an entry the register has frozen or decided, at most once per tool",
    badReads.length === 0,
    `${shippedReads.length} committed holdout3 read(s); bad: ${badReads.map((r) => r.file).join(",") || "none"}`,
  );

  // The shipped register's D-entries (#131): each has exactly one status
  // line, `open`, with `Criteria approved` dated and tied to a commit, the
  // register table agrees with it, and the real gate refuses each one.
  const dEntries = ["D1", "D2", "D3", "D4", "D5", "D6", "D8", "D9"];
  const tableStatus = (id: string): string | undefined => {
    const row = registerText.split("\n").find((l) => l.startsWith(`| ${id} |`));
    return row?.split("|").at(-2)?.trim();
  };
  for (const id of dEntries) {
    const found = registerStatus(registerText, id);
    const section =
      registerText
        .split(new RegExp(`^### ${id}\\. `, "m"))[1]
        ?.split(/^#{1,3} /m)[0] ?? "";
    // A date, then the commit that records the approval: a SHA, or the
    // squash commit of a numbered change.
    const approved =
      /- \*\*Status:\*\* open\. Criteria approved: 2026-\d\d-\d\d at /.test(
        section,
      ) && /2026-11-22[^.]*?at the commit of\s+#\d+\b/.test(section);
    const refusal = thrown(() => openHoldout3(id));
    check(
      `the shipped register records ${id} as open with its criteria approved, its table row agrees, and the holdout3 gate refuses it`,
      "status" in found &&
        found.status === "open" &&
        tableStatus(id) === "open" &&
        approved &&
        refusal.includes(`"${id}" as "open"`),
      `${"status" in found ? found.status : found.error}; table ${tableStatus(id)}; approved ${approved}; ${refusal}`,
    );
  }

  // The pin tables: seal, record and split agree, in every part.
  const record: Holdout3Record = {
    drawnAs: "fixture",
    camera: null,
    phone: false,
    meanL: 50,
    lowKey: 0,
    skin: 0,
    strata: [],
  };
  const photo: NaturalImageSpec = {
    label: `${HOLDOUT3_PREFIX}daylight-fixture`,
    urls: ["https://example.invalid/sealed3.jpg"],
    ext: ".jpg",
    width: 4,
    height: 3,
    split: "holdout3",
    sha256: "0".repeat(64),
    source: "https://example.invalid/sealed3",
    author: "fixture",
    licence: "CC0",
    axis: "fixture",
    notes: "fixture",
    holdout3: record,
  };
  const { holdout3: _drop, ...bare } = photo;
  check(
    "holdout3Specs returns the photographic sealed3- pins",
    holdout3Specs([photo, { ...bare, label: "natural-x", split: "tune" }])
      .length === 1,
    "",
  );
  for (const [what, bad] of [
    ["a holdout3 pin with no draw record", bare],
    ["a sealed3- pin on another split", { ...photo, split: "tune" as const }],
    ["a holdout3 pin without the seal", { ...photo, label: "natural-x" }],
    [
      "a draw record on a tune pin",
      { ...photo, label: "natural-x", split: "tune" as const },
    ],
    [
      "a photograph sealed as a cut-out",
      { ...photo, label: `${ALPHA_HOLDOUT3_PREFIX}x` },
    ],
  ] as const) {
    const message = thrown(() => holdout3Specs([bad]));
    check(`${what} is refused`, message !== "", message);
  }
  check(
    "a pin carrying another part's seal is refused by the generic check",
    thrown(() =>
      checkHoldout3Pins(
        [
          {
            label: `${GRAPHIC_HOLDOUT3_PREFIX}x`,
            split: "holdout3" as const,
            holdout3: record,
          },
        ],
        ALPHA_HOLDOUT3_PREFIX,
        "alpha",
      ),
    ).includes("is labelled"),
    "",
  );
  const naturalTable: NaturalImageSpec[] = [
    { ...bare, label: "natural-open", split: "tune" },
    photo,
  ];
  check(
    "the natural-image fetch skips every holdout3 pin",
    naturalImagesToFetch(undefined, naturalTable)
      .map((s) => s.label)
      .join(",") === "natural-open",
    "",
  );
  const askedSealed3 = thrown(() =>
    naturalImagesToFetch([photo.label], naturalTable),
  );
  check(
    "a holdout3 pin asked for by label is refused, naming its gated fetcher",
    askedSealed3.includes("sealed holdout3 split") &&
      askedSealed3.includes("ensureHoldout3Images"),
    askedSealed3,
  );
  if (opened !== null) {
    const empty = await rejected(() => ensureHoldout3Images(opened, []));
    check(
      "an opened holdout3 with no photographic pins refuses rather than scoring nothing",
      empty.includes("no pinned photographs"),
      empty,
    );
  }

  const cutout: AlphaImageSpec = {
    label: `${ALPHA_HOLDOUT3_PREFIX}fixture`,
    url: "https://example.invalid/cutout.png",
    ext: ".png",
    width: 4,
    height: 4,
    split: "holdout3",
    nonOpaqueFraction: 0.5,
    softAlphaFraction: 0.1,
    sha256: "0".repeat(64),
    source: "https://example.invalid/cutout",
    author: "fixture",
    licence: "CC0",
    notes: "fixture",
    holdout3: record,
  };
  const { holdout3: _c, ...openCutout } = cutout;
  const alphaTable: AlphaImageSpec[] = [
    { ...openCutout, label: "cutout-open", split: "tune" },
    cutout,
  ];
  const holdout2Opening = {
    decision: "D1",
    register: "r",
    registerSha256: "0",
  };
  const alphaLabels = (s: AlphaImageSpec[]): string =>
    s.map((x) => x.label).join(",");
  check(
    "the alpha part of holdout3 needs a holdout3 opening, and then fetches exactly its pins",
    thrown(() => alphaImagesToFetch("holdout3", alphaTable)).includes(
      "openHoldout3",
    ) &&
      thrown(() =>
        alphaImagesToFetch("holdout3", alphaTable, holdout2Opening),
      ).includes("openHoldout3") &&
      opened !== null &&
      alphaLabels(alphaImagesToFetch("holdout3", alphaTable, opened)) ===
        cutout.label,
    "",
  );
  check(
    "no unopened alpha fetch reaches a holdout3 pin, and a holdout3 opening does not open holdout2",
    alphaLabels(alphaImagesToFetch(undefined, alphaTable)) === "cutout-open" &&
      opened !== null &&
      thrown(() => alphaImagesToFetch("holdout2", alphaTable, opened)) !== "",
    alphaLabels(alphaImagesToFetch(undefined, alphaTable)),
  );
  check(
    "an opened alpha holdout3 with no pins refuses",
    opened !== null &&
      thrown(() =>
        alphaImagesToFetch(
          "holdout3",
          [alphaTable[0] as AlphaImageSpec],
          opened,
        ),
      ).includes("no pinned images"),
    "",
  );
  const graphic: GraphicImageSpec = {
    label: `${GRAPHIC_HOLDOUT3_PREFIX}chart-fixture`,
    url: "https://example.invalid/chart.png",
    ext: ".png",
    width: 4,
    height: 4,
    split: "holdout3",
    sha256: "0".repeat(64),
    source: "https://example.invalid/chart",
    author: "fixture",
    licence: "CC0",
    notes: "fixture",
    holdout3: record,
  };
  const { holdout3: _g, ...openGraphic } = graphic;
  const graphicTable: GraphicImageSpec[] = [
    { ...openGraphic, label: "graphic-open", split: "tune" },
    { ...openGraphic, label: "graphic-old-holdout", split: "holdout" },
    graphic,
  ];
  const graphicLabels = (s: GraphicImageSpec[]): string =>
    s.map((x) => x.label).join(",");
  check(
    "the graphics fetch skips holdout3 unless opened, and then fetches exactly its pins",
    graphicLabels(graphicImagesToFetch(undefined, graphicTable)) ===
      "graphic-open,graphic-old-holdout" &&
      thrown(() => graphicImagesToFetch("holdout3", graphicTable)).includes(
        "openHoldout3",
      ) &&
      opened !== null &&
      graphicLabels(graphicImagesToFetch("holdout3", graphicTable, opened)) ===
        graphic.label &&
      thrown(() =>
        graphicImagesToFetch("holdout3", graphicTable.slice(0, 2), opened),
      ).includes("no pinned images"),
    graphicLabels(graphicImagesToFetch(undefined, graphicTable)),
  );
  const shippedTables = [
    thrown(() => holdout3Specs()),
    thrown(() => alphaHoldout3Specs()),
    thrown(() => graphicHoldout3Specs()),
  ].filter((m) => m !== "");
  check(
    "the shipped tables' holdout3 seals, splits and draw records agree",
    shippedTables.length === 0,
    shippedTables.join(" | "),
  );

  // The shipped pins: sizes, strata, and disjointness from every other split.
  type Pin = {
    label: string;
    split: string;
    sha256: string;
    source: string;
    width: number;
    height: number;
    nonOpaqueFraction: number;
    holdout3?: Holdout3Record | undefined;
  };
  const everyPin: Pin[] = [
    ...CURATED_IMAGES.map((s) => ({ ...s, nonOpaqueFraction: 0 })),
    ...ALPHA_IMAGES,
    ...GRAPHIC_IMAGES.map((s) => ({ ...s, nonOpaqueFraction: 0 })),
  ];
  const h3 = everyPin.filter((s) => s.split === "holdout3");
  const others = everyPin.filter((s) => s.split !== "holdout3");
  const size = (corpus: "photo" | "alpha" | "graphic"): number =>
    h3.filter((s) => inCorpus(s.label, corpus)).length;
  check(
    "holdout3 holds at least 48 photographs, 24 cut-outs and 16 graphics",
    size("photo") >= HOLDOUT3_PROTOCOL.sizes.photo &&
      size("alpha") >= HOLDOUT3_PROTOCOL.sizes.alpha &&
      size("graphic") >= HOLDOUT3_PROTOCOL.sizes.graphic,
    `${size("photo")} / ${size("alpha")} / ${size("graphic")}`,
  );
  const rederived = h3.filter((s) => {
    const r = s.holdout3;
    if (r === undefined) return true;
    const corpus = corpora.find((c) => inCorpus(s.label, c)) ?? "photo";
    const derived = holdout3Strata({
      corpus,
      width: s.width,
      height: s.height,
      nonOpaqueFraction: s.nonOpaqueFraction,
      phone: r.phone,
      meanL: r.meanL,
      lowKey: r.lowKey,
      skin: r.skin,
    });
    return derived.join(",") !== r.strata.join(",");
  });
  check(
    "every holdout3 pin's recorded strata are the ones its recorded figures derive",
    rederived.length === 0,
    rederived.map((s) => s.label).join(", "),
  );
  const perStratum = HOLDOUT3_STRATA.map(
    (st) =>
      [st, h3.filter((s) => s.holdout3?.strata.includes(st)).length] as const,
  );
  check(
    `every stratum holds at least ${HOLDOUT3_PROTOCOL.strataMin} pins`,
    perStratum.every(([, n]) => n >= HOLDOUT3_PROTOCOL.strataMin),
    perStratum.map(([st, n]) => `${st} ${n}`).join(", "),
  );
  const otherSha = new Set([...others.map((s) => s.sha256), ...KODAK_SHA256]);
  const otherTitles = new Set(
    others.map((s) => pinnedCommonsTitle(s.source)).filter((t) => t !== null),
  );
  const shaClash = h3.filter((s) => otherSha.has(s.sha256));
  const titleClash = h3.filter((s) => {
    const t = pinnedCommonsTitle(s.source);
    return t === null || otherTitles.has(t);
  });
  const ownSha = new Set(h3.map((s) => s.sha256));
  const ownTitles = new Set(h3.map((s) => pinnedCommonsTitle(s.source)));
  check(
    "holdout3 shares no image with tune, tune2, holdout or holdout2 (Kodak24 included), by SHA-256 and by Commons title, and repeats none",
    shaClash.length === 0 &&
      titleClash.length === 0 &&
      ownSha.size === h3.length &&
      ownTitles.size === h3.length,
    [...shaClash, ...titleClash].map((s) => s.label).join(", ") ||
      `${h3.length} pins against ${others.length} others`,
  );

  // The committed draw record: the pins are re-derived from it offline, so
  // "covariate-only seeded selection" is checked, not trusted (#151 V2).
  const drawRecord = JSON.parse(
    readFileSync(HOLDOUT3_DRAW_RECORD, "utf8"),
  ) as Holdout3DrawRecord;
  check(
    "the draw record ran under the committed protocol, skin region, amendments and axes",
    JSON.stringify(drawRecord.protocol) === JSON.stringify(HOLDOUT3_PROTOCOL) &&
      JSON.stringify(drawRecord.skinRegion) === JSON.stringify(SKIN_REGION) &&
      JSON.stringify(drawRecord.amendments) ===
        JSON.stringify(HOLDOUT3_AMENDMENTS) &&
      drawRecord.axes.length === HOLDOUT3_DRAW.length &&
      drawRecord.axes.every(
        (a, i) =>
          a.name === HOLDOUT3_DRAW[i]?.name &&
          a.part === HOLDOUT3_DRAW[i]?.part &&
          a.queries.map((q) => `${q.name}=${q.query}`).join("|") ===
            HOLDOUT3_DRAW[i]?.queries
              .map((q) => `${q.name}=${q.query}`)
              .join("|"),
      ),
    drawRecord.drawnAt,
  );
  const unordered = drawRecord.axes.filter(
    (a) =>
      a.walked.length !== a.consumed ||
      a.consumed > a.pool ||
      a.walked.some(
        (w, i) =>
          i > 0 &&
          holdout3OrderKey(a.walked[i - 1]?.title ?? "") >=
            holdout3OrderKey(w.title),
      ) ||
      a.walked.some((w) => !a.queries.some((q) => q.name === w.query)),
  );
  check(
    "every axis's walked prefix is in ascending seeded order, attributed to its own queries",
    unordered.length === 0,
    unordered.map((a) => a.name).join(", ") ||
      `${drawRecord.axes.reduce((n, a) => n + a.consumed, 0)} candidates walked`,
  );
  const replayed = await replayHoldout3(drawRecord);
  const pickKey = (p: { label: string; title: string; sha256: string }) =>
    `${p.label}|${p.title}|${p.sha256}`;
  check(
    "replaying the record re-derives its picks, refusals, sizes, strata and shortfalls exactly",
    replayed.picks.map(pickKey).join("\n") ===
      drawRecord.picks.map(pickKey).join("\n") &&
      drawRecord.axes.every(
        (a, i) =>
          JSON.stringify(a.refusals) ===
            JSON.stringify(replayed.axes[i]?.refusals) &&
          a.picks.join(",") === replayed.axes[i]?.picks.join(",") &&
          a.consumed === replayed.axes[i]?.walked.length,
      ) &&
      JSON.stringify(replayed.sizes) === JSON.stringify(drawRecord.sizes) &&
      JSON.stringify(replayed.strata) === JSON.stringify(drawRecord.strata) &&
      replayed.shortfalls.join("|") === drawRecord.shortfalls.join("|"),
    `${replayed.picks.length} picks replayed`,
  );
  const shippedByLabel = new Map<string, Pin & { softAlphaFraction?: number }>(
    h3.map((s) => [s.label, s]),
  );
  const pinMismatch = replayed.picks.filter((p) => {
    const s = shippedByLabel.get(p.label);
    if (s === undefined) return true;
    const a = p.covariates.alpha;
    return (
      s.sha256 !== p.sha256 ||
      pinnedCommonsTitle(s.source) !== p.title ||
      s.width !== p.covariates.width ||
      s.height !== p.covariates.height ||
      JSON.stringify(s.holdout3) !== JSON.stringify(p.record) ||
      (p.part === "alpha" &&
        (a === null ||
          s.nonOpaqueFraction !== Math.round(a.nonOpaqueFraction * 1e4) / 1e4 ||
          s.softAlphaFraction !== Math.round(a.softAlphaFraction * 1e4) / 1e4))
    );
  });
  const partOrder = (part: string): string =>
    replayed.picks
      .filter((p) => p.part === part)
      .map((p) => p.label)
      .join(",");
  check(
    "the shipped holdout3 pins are exactly the replayed picks, in draw order, with their figures and records",
    pinMismatch.length === 0 &&
      h3.length === replayed.picks.length &&
      partOrder("photo") ===
        CURATED_IMAGES.filter((s) => s.split === "holdout3")
          .map((s) => s.label)
          .join(",") &&
      partOrder("alpha") ===
        ALPHA_IMAGES.filter((s) => s.split === "holdout3")
          .map((s) => s.label)
          .join(",") &&
      partOrder("graphic") ===
        GRAPHIC_IMAGES.filter((s) => s.split === "holdout3")
          .map((s) => s.label)
          .join(","),
    pinMismatch.map((p) => p.label).join(", ") ||
      `${h3.length} pins, ${replayed.picks.length} picks`,
  );
  // A record that does not hold what the walk asks is refused, not guessed.
  const tampered = (edit: (r: Holdout3DrawRecord) => void): Promise<string> => {
    const r = JSON.parse(JSON.stringify(drawRecord)) as Holdout3DrawRecord;
    edit(r);
    return replayHoldout3(r).then(
      (w) => w.picks.map(pickKey).join("\n"),
      (e: unknown) => `threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  };
  const firstPickAxis = drawRecord.axes.findIndex((a) => a.picks.length > 0);
  const truncated = await tampered((r) => {
    const a = r.axes[firstPickAxis];
    if (a !== undefined) a.walked = a.walked.slice(0, 0);
  });
  const stripped = await tampered((r) => {
    for (const a of r.axes) {
      a.walked = a.walked.map(
        ({ covariates: _c, refused: _r, ...rest }) => rest,
      );
    }
  });
  const unskinned = await tampered((r) => {
    for (const a of r.axes) {
      for (const w of a.walked) {
        if (w.covariates !== undefined) w.covariates.skin = 0;
      }
    }
  });
  check(
    "a record cut short or missing a verdict is refused, and changed covariates never replay to the same picks",
    truncated.startsWith("threw:") &&
      truncated.includes("past the 0 recorded") &&
      stripped.startsWith("threw:") &&
      stripped.includes("does not say") &&
      unskinned !== drawRecord.picks.map(pickKey).join("\n"),
    `${truncated.slice(0, 80)} | ${stripped.slice(0, 80)}`,
  );
  const spliced = spliceHoldout3Pins(
    [
      "[",
      `  ${HOLDOUT3_PINS_BEGIN}`,
      "  {old},",
      `  ${HOLDOUT3_PINS_END}`,
      "];",
    ].join("\n"),
    ["{a},", "{b},"],
  );
  check(
    "the pin writer replaces exactly the lines between the markers, and refuses a table without them",
    spliced ===
      [
        "[",
        `  ${HOLDOUT3_PINS_BEGIN}`,
        "{a},",
        "{b},",
        `  ${HOLDOUT3_PINS_END}`,
        "];",
      ].join("\n") &&
      thrown(() => spliceHoldout3Pins("[\n];", [])).includes(
        "no holdout3 pin markers",
      ),
    "",
  );

  // The strata, from the recorded figures alone.
  type StratumInput = Parameters<typeof holdout3Strata>[0];
  const base: StratumInput = {
    corpus: "photo",
    width: 4000,
    height: 3000,
    nonOpaqueFraction: 0,
    phone: false,
    meanL: 50,
    lowKey: 0,
    skin: 0,
  };
  const strata = (over: Partial<StratumInput>): string =>
    holdout3Strata({ ...base, ...over }).join(",");
  check(
    "a plain daylight photograph is in no stratum",
    strata({}) === "",
    strata({}),
  );
  check(
    "the strata thresholds sit where the protocol puts them, inclusive",
    strata({ phone: true }) === "smartphone" &&
      strata({ skin: HOLDOUT3_PROTOCOL.skinMin }) === "skin" &&
      strata({ skin: HOLDOUT3_PROTOCOL.skinMin - 1e-4 }) === "" &&
      strata({ meanL: HOLDOUT3_PROTOCOL.lowLightMeanL }) === "low-light" &&
      strata({ meanL: HOLDOUT3_PROTOCOL.lowLightMeanL + 0.01 }) === "" &&
      strata({ lowKey: HOLDOUT3_PROTOCOL.lowLightLowKey }) === "low-light" &&
      strata({ width: 3000, height: 1000 }) === "extreme-aspect" &&
      strata({ width: 1000, height: 2999 }) === "",
    [strata({ phone: true }), strata({ width: 3000, height: 1000 })].join(" "),
  );
  check(
    "graphics content is the graphics stratum; an alpha raster's colour figures place it in no colour stratum",
    strata({ corpus: "graphic" }) === "graphics" &&
      strata({
        corpus: "alpha",
        nonOpaqueFraction: 0.4,
        meanL: 5,
        lowKey: 0.9,
        skin: 0.5,
      }) === "alpha",
    strata({ corpus: "alpha", nonOpaqueFraction: 0.4, meanL: 5, lowKey: 0.9 }),
  );
  check(
    "the protocol's strata are the six the issue fixes",
    HOLDOUT3_STRATA.join(",") ===
      "smartphone,graphics,alpha,skin,low-light,extreme-aspect" &&
      HOLDOUT3_PROTOCOL.strataMin === 8 &&
      HOLDOUT3_PROTOCOL.sizes.photo === 48 &&
      HOLDOUT3_PROTOCOL.sizes.alpha === 24 &&
      HOLDOUT3_PROTOCOL.sizes.graphic === 16,
    HOLDOUT3_STRATA.join(","),
  );
  const quota = (part: string): number =>
    HOLDOUT3_DRAW.filter((a) => a.part === part)
      .flatMap((a) => Object.values(a.slots))
      .reduce((x, y) => x + y, 0);
  check(
    "the draw's quotas sum to each part's size",
    quota("photo") === HOLDOUT3_PROTOCOL.sizes.photo &&
      quota("alpha") === HOLDOUT3_PROTOCOL.sizes.alpha &&
      quota("graphic") === HOLDOUT3_PROTOCOL.sizes.graphic,
    `${quota("photo")}/${quota("alpha")}/${quota("graphic")}`,
  );

  // The covariates the draw adds: skin, the capture device, the order.
  const labOf = (r: number, g: number, b: number): [number, number, number] =>
    srgbToLab(r, g, b);
  check(
    "the skin region holds every swatch it was set from, light (h 74.8°, 78.4°) to dark, and refuses sand, green, near-black and near-white",
    inSkinRegion(...labOf(241, 194, 125)) &&
      inSkinRegion(...labOf(224, 172, 105)) &&
      inSkinRegion(...labOf(198, 134, 66)) &&
      inSkinRegion(...labOf(141, 85, 36)) &&
      inSkinRegion(...labOf(180, 120, 100)) &&
      inSkinRegion(...labOf(92, 51, 23)) &&
      !inSkinRegion(...labOf(194, 178, 128)) &&
      !inSkinRegion(...labOf(34, 139, 34)) &&
      !inSkinRegion(...labOf(60, 40, 30)) &&
      !inSkinRegion(...labOf(255, 219, 172)) &&
      SKIN_REGION.maxHue === 80,
    "",
  );
  const skinRaster = covariatesOf(
    makeRgba(4, 2, (x) => (x < 1 ? [198, 134, 66] : [34, 139, 34])),
    4,
    2,
    { width: 4, height: 2 },
  );
  check(
    "skin is the in-region fraction, and skinL their mean L*",
    Math.abs(skinRaster.skin - 0.25) < 1e-12 &&
      skinRaster.skinL !== null &&
      Math.abs(skinRaster.skinL - labOf(198, 134, 66)[0]) < 1e-9 &&
      skinRaster.camera === null &&
      !skinRaster.phone,
    `skin ${skinRaster.skin} skinL ${skinRaster.skinL}`,
  );
  check(
    "skin bands split at mean L* 45 and 60",
    skinBand(44.9) === "dark" &&
      skinBand(45) === "medium" &&
      skinBand(59.9) === "medium" &&
      skinBand(60) === "light" &&
      skinBand(null) === null,
    "",
  );
  const phones: [string | null, string | null, boolean][] = [
    ["Apple", "iPhone 13 Pro", true],
    ["Apple", "iPad Air", false],
    ["samsung", "SM-G998B", true],
    ["samsung", "SM-T870", false],
    ["SAMSUNG", "NX300", false],
    ["SONY", "ILCE-7M4", false],
    ["Sony", "G8341", true],
    ["Google", "Pixel 6", true],
    ["HUAWEI", "MAR-LX1A", true],
    ["NIKON CORPORATION", "NIKON D850", false],
    ["Canon", "Canon EOS 5D Mark III", false],
    ["Microsoft", "Lumia 950", true],
    ["Xiaomi", "Redmi Note 8 Pro", true],
    ["Xiaomi", "Xiaomi Pad 5", false],
    [null, null, false],
  ];
  const wrongPhones = phones.filter(
    ([mk, md, want]) => isPhoneCamera(mk, md) !== want,
  );
  check(
    "isPhoneCamera names phones and refuses tablets and cameras",
    wrongPhones.length === 0,
    wrongPhones.map(([mk, md]) => `${mk} ${md}`).join("; "),
  );
  // A little-endian TIFF IFD0 with Make (inline, ≤ 4 bytes) and Model (offset).
  const tiff = Buffer.alloc(64);
  tiff.write("Exif\0\0II", 0, "latin1");
  tiff.writeUInt16LE(42, 8);
  tiff.writeUInt32LE(8, 10);
  tiff.writeUInt16LE(2, 14);
  tiff.writeUInt16LE(0x010f, 16);
  tiff.writeUInt16LE(2, 18);
  tiff.writeUInt32LE(4, 20);
  tiff.write("LGE\0", 24, "latin1");
  tiff.writeUInt16LE(0x0110, 28);
  tiff.writeUInt16LE(2, 30);
  tiff.writeUInt32LE(7, 32);
  tiff.writeUInt32LE(40, 36);
  tiff.write("Nexus\0\0", 46, "latin1");
  const cam = exifCamera(tiff);
  check(
    "exifCamera reads IFD0 Make (inline) and Model (by offset), and a malformed block names neither",
    cam.make === "LGE" &&
      cam.model === "Nexus" &&
      exifCamera(Buffer.from("not exif at all")).make === null &&
      exifCamera(undefined).model === null &&
      exifCamera(tiff.subarray(0, 20)).make === null,
    JSON.stringify(cam),
  );
  check(
    'the seeded order is SHA-256 of "holdout3:" + the title',
    holdout3OrderKey("File:Fixture.jpg") ===
      createHash("sha256").update("holdout3:File:Fixture.jpg").digest("hex") &&
      HOLDOUT3_PROTOCOL.seed === "holdout3",
    holdout3OrderKey("File:Fixture.jpg").slice(0, 12),
  );
  check(
    "a pin's source page and a search hit compare as one Commons title",
    pinnedCommonsTitle(
      "https://commons.wikimedia.org/wiki/File%3AValle_de_Pineta_02.jpg",
    ) === "File:Valle de Pineta 02.jpg" &&
      pinnedCommonsTitle(
        "https://commons.wikimedia.org/wiki/File:Jos%C3%A9_Manuel_Luc%C3%ADa_Meg%C3%ADas.JPG",
      ) === "File:José Manuel Lucía Megías.JPG" &&
      pinnedCommonsTitle("https://example.invalid/wiki/File:x.jpg") === null,
    "",
  );
  check(
    "alpha cells follow #107's cuts and leave the gaps unassigned",
    alphaCell({
      nonOpaqueFraction: 0.2,
      softAlphaFraction: 0,
      silhouette: 1.2,
    }) === "opaque/hard/simple" &&
      alphaCell({
        nonOpaqueFraction: 0.6,
        softAlphaFraction: 0.05,
        silhouette: 2.5,
      }) === "transparent/soft/detailed" &&
      alphaCell({
        nonOpaqueFraction: 0.6,
        softAlphaFraction: 0.02,
        silhouette: 2.5,
      }) === null &&
      alphaCell({
        nonOpaqueFraction: 0.6,
        softAlphaFraction: 0.05,
        silhouette: 1.7,
      }) === null &&
      alphaCell({
        nonOpaqueFraction: 0.6,
        softAlphaFraction: 0.05,
        silhouette: null,
      }) === null,
    "",
  );
  const candidate: CommonsFacts = {
    title: "File:Fixture.jpg",
    url: "https://example.invalid/Fixture.jpg",
    descriptionUrl: "https://example.invalid/File:Fixture.jpg",
    sha1: "0".repeat(40),
    mime: "image/jpeg",
    licence: "CC BY-SA 4.0",
    author: "fixture",
    make: "Apple",
    model: "iPhone 11",
    software: null,
    dateTimeOriginal: null,
    categories: [],
    width: 4032,
    height: 3024,
    size: 3_000_000,
  };
  const why = (
    part: "photo" | "alpha" | "graphic",
    over: Partial<CommonsFacts>,
    phone = false,
  ) =>
    holdout3Admission(
      part,
      { ...candidate, ...over },
      { onePerCamera: phone },
    ) ?? "admitted";
  check(
    "the draw's admission rules refuse what the protocol says, before any download",
    why("photo", {}) === "admitted" &&
      why("photo", { model: null }).includes("camera model") &&
      why("photo", { width: 1900, height: 1200 }).includes("2000") &&
      why("photo", { categories: ["Oil paintings"] }).includes("art") &&
      why("photo", { categories: ["AI-generated images"] }).includes(
        "machine",
      ) &&
      why("photo", { software: "Adobe Photoshop" }, true).includes("editor") &&
      why("photo", { software: "Adobe Photoshop" }) === "admitted" &&
      why("photo", { author: "" }).includes("author") &&
      why("alpha", {
        mime: "image/png",
        model: null,
        categories: ["Coats of arms"],
      }).includes("logo") &&
      why("alpha", { mime: "image/png", model: null }) === "admitted" &&
      why("graphic", { mime: "image/png" }).includes("photograph") &&
      why("graphic", { mime: "image/png", model: null }) === "admitted",
    [why("photo", {}), why("graphic", { mime: "image/png" })].join(" | "),
  );
  const labels = new Set<string>([`${HOLDOUT3_PREFIX}phone-aamsveen-herfst`]);
  check(
    "labels carry the part's seal, are slugged from the title, and never repeat",
    holdout3Label("photo", "phone", "File:Aamsveen Herfst.jpg", labels) ===
      `${HOLDOUT3_PREFIX}phone-aamsveen-herfst-2` &&
      holdout3Label(
        "alpha",
        "cutout",
        "File:Café au lait (1).png",
        new Set(),
      ) === `${ALPHA_HOLDOUT3_PREFIX}cafe-au-lait-1` &&
      holdout3Label("graphic", "map", "File:Карта.png", new Set()).startsWith(
        `${GRAPHIC_HOLDOUT3_PREFIX}map-`,
      ),
    holdout3Label("graphic", "map", "File:Карта.png", new Set()),
  );
  rmSync(dir, { recursive: true, force: true });
}

// The MDE block: `mde-core.ts`, which EXPERIMENTS.md §13.6 is computed by.
// `verify:experiments` checks §13.6 against that same code, so it cannot catch
// the code being wrong; these values are worked by hand instead. The fixture
// results directory holds one photographic tune sweep of four images, one alpha
// tune sweep of three, and one photographic holdout sweep of three that must be
// ignored (it would otherwise give the photo tune split two sizes and throw).
console.log(
  "\nmde — the multipliers, the per-comparison MDE, and the filters\n",
);
{
  check(
    "zFactor is z(1 − α/(2m)) + z(power): 2.801585 at m = 1, 3.083024 at m = 2",
    Math.abs(zFactor(0.05, 0.8, 1) - 2.801585) < 1e-6 &&
      Math.abs(zFactor(0.05, 0.8, 2) - 3.083024) < 1e-6,
    `m1=${zFactor(0.05, 0.8, 1).toFixed(6)} m2=${zFactor(0.05, 0.8, 2).toFixed(6)}`,
  );
  // t(0.975, 3) = 3.18245 and t(0.8, 3) = 0.97847 in every table.
  check(
    "tFactor uses Student-t quantiles on n − 1 df: 4.16092 at m = 1, n = 4",
    Math.abs(tFactor(0.05, 0.8, 1, 4) - 4.16092) < 1e-4,
    `t=${tFactor(0.05, 0.8, 1, 4).toFixed(5)}`,
  );

  const dir = mkdtempSync(path.join(tmpdir(), "mde-selftest-"));
  const row = (label: string, ciede: number[], bytes: number[]) => ({
    label,
    tune: null,
    tier: null,
    version: null,
    perImage: { ciede2000: ciede, bytes },
  });
  const sweep = (
    name: string,
    split: string,
    corpus: string,
    rows: ReturnType<typeof row>[],
  ): void => {
    const images = (rows[0]?.perImage.ciede2000 ?? []).map((_, i) => `i${i}`);
    const file: ResultFile = {
      schema: RESULT_SCHEMA,
      tool: "sweep",
      name,
      split,
      settings: { corpus },
      provenance: {
        rev: "0".repeat(40),
        dirty: false,
        dirtyPaths: [],
        iqaCli: "iqa-cli fixture",
        config: `${name}.json`,
        configSha256: "0".repeat(64),
        binaries: {},
        node: process.version,
        corpus: images.map((n) => ({ name: n, sha256: "1".repeat(64) })),
      },
      imageNames: images,
      rows,
    };
    writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(file));
  };
  const b4 = [32, 32, 32, 32];
  // Incumbent mean 10. `near`: d = (0.1, 0.3, −0.1, 0.1), mean 0.1, SD
  // √(0.08/3) = 0.163299, so σ_rel = 0.0163299 and the effect is +1%. `far`:
  // d = (1, 2, 1, 2), SD √(1/3) = 0.577350, σ_rel = 0.0577350, effect +15%,
  // outside NEAR. `other` spends one byte more on one image; `same` is the
  // incumbent again.
  sweep("photo-fixture", "tune", "photo", [
    row("inc", [10, 10, 10, 10], b4),
    row("near", [10.1, 10.3, 9.9, 10.1], b4),
    row("far", [11, 12, 11, 12], b4),
    row("other", [10.5, 10.6, 10.5, 10.6], [32, 32, 33, 32]),
    row("same", [10, 10, 10, 10], b4),
  ]);
  // Incumbent mean 20, d = (0.2, 0.4, 0.6): SD 0.2, σ_rel 0.01, effect +2%.
  sweep("alpha-fixture", "tune", "alpha", [
    row("inc", [20, 20, 20], [40, 40, 40]),
    row("arm", [20.2, 20.4, 20.6], [40, 40, 40]),
  ]);
  sweep("photo-holdout-fixture", "holdout", "photo", [
    row("inc", [10, 10, 10], [32, 32, 32]),
    row("arm", [50, 60, 70], [32, 32, 32]),
  ]);

  const data = readSpread(dir, false, { photo: 0, alpha: 5 });
  const photo = data.comparisons.photo;
  const near = photo.find((c) => c.label === "near");
  const far = photo.find((c) => c.label === "far");
  check(
    "readSpread keeps same-budget arms, skips other budgets and SD-0 arms, and ignores non-tune splits",
    photo.length === 2 &&
      near !== undefined &&
      far !== undefined &&
      Math.abs(near.sigmaRel - 0.0163299) < 1e-6 &&
      Math.abs(near.effectRel - 0.01) < 1e-12 &&
      Math.abs(far.sigmaRel - 0.057735) < 1e-6 &&
      Math.abs(far.effectRel - 0.15) < 1e-12 &&
      data.otherBudget === 1 &&
      data.identical === 1 &&
      data.comparisons.alpha.length === 1 &&
      Math.abs((data.comparisons.alpha[0]?.sigmaRel ?? 0) - 0.01) < 1e-12,
    `photo=${photo.map((c) => `${c.label}:${c.sigmaRel.toFixed(6)}`).join(",")} otherBudget=${data.otherBudget} identical=${data.identical}`,
  );
  const allBudgets = readSpread(dir, true, { photo: 0, alpha: 5 });
  check(
    "--all-budgets keeps the other-budget arm",
    allBudgets.comparisons.photo.length === 3 &&
      allBudgets.otherBudget === 0 &&
      allBudgets.identical === 1,
    `photo=${allBudgets.comparisons.photo.length} otherBudget=${allBudgets.otherBudget}`,
  );

  const split = (name: string) => data.splits.find((s) => s.name === name);
  const pinnedPhoto = readSpread(dir, false, {
    photo: 7,
    alpha: 5,
  }).splits.find((s) => s.name === "photo holdout2");
  check(
    "split sizes: tune from the results, holdout2 from the pins, photo falls back to #103's 32 while unpinned",
    split("photo tune")?.n === 4 &&
      split("alpha tune")?.n === 3 &&
      split("alpha holdout2")?.n === 5 &&
      split("photo holdout2")?.n === PHOTO_HOLDOUT2_CANDIDATES &&
      PHOTO_HOLDOUT2_CANDIDATES === 32 &&
      pinnedPhoto?.n === 7,
    data.splits.map((s) => `${s.name}=${s.n}`).join(", "),
  );

  // MDE = z · σ_rel / √n. Photo tune, n = 4, m = 1: near 2.801585 · 0.0163299
  // / 2 = 0.0228747, far 2.801585 · 0.0577350 / 2 = 0.0808747; their median
  // is 0.0518747 and one of two is at most 3%. Within NEAR only `near` is
  // left, and at m = 2 it is 3.083024 · 0.0163299 / 2 = 0.0251726. Alpha
  // holdout2, n = 5: 2.801585 · 0.01 / √5 = 0.0125291.
  const tune = split("photo tune");
  const alphaH2 = split("alpha holdout2");
  if (tune && alphaH2) {
    const all1 = mdeCell(data, tune, false, 1);
    const near2 = mdeCell(data, tune, true, 2);
    const alpha1 = mdeCell(data, alphaH2, false, 1);
    check(
      "mdeCell gives z·σ_rel/√n per comparison, its median, the t median and the share under a cut",
      Math.abs((all1.mdes[0] ?? 0) - 0.0228747) < 1e-6 &&
        Math.abs((all1.mdes[1] ?? 0) - 0.0808747) < 1e-6 &&
        Math.abs(all1.quartiles[1] - 0.0518747) < 1e-6 &&
        Math.abs(all1.tMedian - (0.0518747 * 4.16092) / 2.801585) < 1e-5 &&
        all1.share(0.03) === 0.5 &&
        near2.mdes.length === 1 &&
        Math.abs((near2.mdes[0] ?? 0) - 0.0251726) < 1e-6 &&
        Math.abs((alpha1.mdes[0] ?? 0) - 0.0125291) < 1e-6,
      `all=${all1.mdes.map((x) => x.toFixed(7)).join(",")} median=${all1.quartiles[1].toFixed(7)} t=${all1.tMedian.toFixed(7)} near2=${near2.mdes[0]?.toFixed(7)} alpha=${alpha1.mdes[0]?.toFixed(7)}`,
    );
  } else {
    check(
      "mdeCell fixture splits exist",
      false,
      "photo tune or alpha holdout2 missing",
    );
  }
  rmSync(dir, { recursive: true, force: true });
}

// The register-verdict block: C1 and C2's frozen verdicts, re-derived from the
// committed holdout2 results by `register-verdict-core.ts`. `verify:experiments`
// binds §13.7's `p Holm` and `guards (CI)` cells to the same derivation; the
// R1 outcomes, condition 4 and C1's ThumbHash admission are in no table, so
// they are asserted here, as `spec/V0.8-DECISIONS.md` records them. A change
// to `arms-core.ts` or `stats.ts` that moves any of them fails this block.
console.log(
  "\nregister-verdict — C1 and C2 as recorded, from the committed reads\n",
);
{
  // Per comparison, in the freeze's order: R1 pass, guards against the named
  // baseline, and the entry-family Holm p (raw p at the floor for C2's three
  // replacements, so 4 × 2/(B+1)).
  const recorded = {
    C1: {
      pass: [false, false, false, false, false, false, false, false],
      guards: [
        "inconclusive",
        "inconclusive",
        "FAIL",
        "inconclusive",
        "FAIL",
        "ok",
        "ok",
        "FAIL",
      ],
      pHolm: [1, 0.8271, 0.0016, 1, 1, 0.019, 0.0016, 0.0016],
    },
    C2: {
      pass: [true, true, false, true],
      guards: ["ok", "ok", "inconclusive", "ok"],
      pHolm: [0.0008, 0.0008, 0.5927, 0.0008],
    },
  } as const;
  for (const [id, want] of Object.entries(recorded)) {
    let v: ReturnType<typeof deriveVerdict> | undefined;
    try {
      v = deriveVerdict(id, 20);
    } catch (e) {
      check(`${id}'s committed reads derive a verdict`, false, String(e));
      continue;
    }
    const got = v.comparisons;
    check(
      `${id}: the R1 outcome of every judged comparison is the recorded one`,
      got.length === want.pass.length &&
        got.every((c, i) => c.r1.pass === want.pass[i]),
      got.map((c) => `${c.arm}=${c.r1.pass}`).join(", "),
    );
    check(
      `${id}: guards against each named baseline are the recorded ones`,
      got.every((c, i) => c.guards === want.guards[i]),
      got.map((c) => c.guards).join(", "),
    );
    check(
      `${id}: the entry-family Holm p of every comparison is the recorded one`,
      got.every((c, i) => Math.abs(c.pHolm - (want.pHolm[i] ?? -1)) < 5e-5),
      got.map((c) => c.pHolm.toFixed(4)).join(", "),
    );
    check(
      `${id}: condition 4 — no R1 outcome turns under 20 other seeds`,
      v.seeds.length === 20 && v.turned.length === 0,
      `${v.seeds.length} seeds, ${v.turned.length} turned`,
    );
    check(
      `${id}: condition 4's guard rule at the default seed is condition 3's`,
      got.every(
        (c) =>
          guardsAtSeed(c.armRow, c.baseRow, c.tol, c.rise, BOOTSTRAP_SEED) ===
          c.guards,
      ),
      got
        .map((c) =>
          guardsAtSeed(c.armRow, c.baseRow, c.tol, c.rise, BOOTSTRAP_SEED),
        )
        .join(", "),
    );
    if (id === "C1") {
      check(
        "C1: the compact row's ThumbHash admission holds on all four means",
        v.admission?.holds === true && v.admission.metrics.length === 4,
        (v.admission?.metrics ?? [])
          .map((m) => `${m.key}=${m.wins}`)
          .join(", "),
      );
    }
  }

  // Condition 4 reads the artifact guards and the zero-baseline allowance, as
  // condition 3 does: a ringing rise with every other guard flat, and a
  // spurious rise from an all-zero baseline, each FAIL under another seed.
  type GuardRow = Parameters<typeof guardsAtSeed>[0];
  const flat = Array.from({ length: 16 }, (_, i) => 1 + i / 16);
  const row = (ringing: number[], spurious: number[]): GuardRow =>
    ({
      label: "synthetic",
      perImage: {
        ciede2000: flat,
        ssimulacra2: flat,
        butteraugli: flat,
        dssim: flat,
        ringing,
        spurious,
      },
    }) as unknown as GuardRow;
  const tol = { ssimulacra2Drop: 0.5, relativeRise: 0.05 };
  const zeros = flat.map(() => 0);
  const base = row(flat, zeros);
  const ringing = row(
    flat.map((v) => v * 1.5),
    zeros,
  );
  const declared = guardsAtSeed(ringing, base, tol, 0.1, 7);
  check(
    "condition 4 fails a ringing rise beyond artifactGuardRise",
    declared === "FAIL",
    declared,
  );
  const undeclared = guardsAtSeed(ringing, base, tol, undefined, 7);
  check(
    "condition 4 ignores ringing where the run declared no artifactGuardRise",
    undeclared === "ok",
    undeclared,
  );
  const fromZero = guardsAtSeed(row(flat, flat), base, tol, 0.1, 7);
  check(
    "condition 4 fails a spurious rise from a zero baseline beyond the allowance",
    fromZero === "FAIL",
    fromZero,
  );

  // The stratum rule (spec/V0.8-DECISIONS.md, #131): an arm that passes
  // overall fails on a stratum whose guard is FAIL on its intervals or whose
  // ΔE00 interval lies above +1% of the stratum's incumbent mean; an
  // inconclusive stratum is reported and does not fail it. 24 images: the
  // first 16 in `skin`, the last 16 in `low-light`, so the middle 8 in both.
  const n = 24;
  const names = Array.from({ length: n }, (_, i) => `img${i}`);
  const strataOfFixture = (name: string): readonly string[] => {
    const i = Number(name.slice(3));
    return [...(i < 16 ? ["skin"] : []), ...(i >= 8 ? ["low-light"] : [])];
  };
  const members = strataMembers(names, strataOfFixture);
  check(
    "strataMembers places each image in every stratum it records, in report order, and leaves empty strata out",
    [...members.keys()].join(",") === "skin,low-light" &&
      members.get("skin")?.length === 16 &&
      members.get("low-light")?.length === 16 &&
      members.get("low-light")?.[0] === 8,
    JSON.stringify([...members.entries()]),
  );
  const series = (f: (i: number) => number): number[] =>
    Array.from({ length: n }, (_, i) => f(i));
  const strRow = (
    de: (i: number) => number,
    s2: (i: number) => number,
  ): GuardRow =>
    ({
      label: "synthetic",
      perImage: {
        ciede2000: series(de),
        ssimulacra2: series(s2),
        butteraugli: series(() => 2),
        dssim: series(() => 0.1),
      },
    }) as unknown as GuardRow;
  const strTol = { ssimulacra2Drop: 1.0, relativeRise: 0.02 };
  const baseDe = (i: number): number => 10 + (i % 5) / 10;
  const strBase = strRow(baseDe, () => 50);
  const better = (i: number): number => baseDe(i) * 0.95;
  const verdicts = (r: ReturnType<typeof stratumRule>): string =>
    r.strata.map((s) => `${s.stratum}=${s.verdict}`).join(",");

  const pass = stratumRule(
    strRow(better, () => 50),
    strBase,
    members,
    strTol,
    undefined,
  );
  check(
    "stratum rule: an arm better in every stratum, guards flat, fails no stratum",
    !pass.fails && verdicts(pass) === "skin=ok,low-light=ok",
    verdicts(pass),
  );

  // 5% worse on ΔE00 in the images only low-light holds; skin keeps i < 8 at
  // −5% and 8..15 at +5%, a mean of 0 whose interval does not clear +1%.
  const worse = stratumRule(
    strRow(
      (i) => (i >= 8 ? baseDe(i) * 1.05 : better(i)),
      () => 50,
    ),
    strBase,
    members,
    strTol,
    undefined,
  );
  check(
    "stratum rule: a stratum whose ΔE00 interval lies above +1% of its incumbent fails the arm, and only that stratum",
    worse.fails &&
      verdicts(worse) === "skin=ok,low-light=FAIL" &&
      (worse.strata[1]?.lowerRel ?? 0) > 1,
    `${verdicts(worse)} lower ${worse.strata.map((s) => s.lowerRel.toFixed(2)).join(",")}`,
  );

  // SSIMULACRA2 down 3 points (tolerance 1) on every low-light image.
  const guardFail = stratumRule(
    strRow(better, (i) => (i >= 8 ? 47 : 50)),
    strBase,
    members,
    strTol,
    undefined,
  );
  check(
    "stratum rule: a stratum guard FAIL on its intervals fails the arm",
    guardFail.fails &&
      guardFail.strata.find((s) => s.stratum === "low-light")?.guards ===
        "FAIL",
    verdicts(guardFail),
  );

  // SSIMULACRA2 swinging ±4 around −1 in low-light: its interval straddles
  // the −1.0 floor, so the guard is inconclusive, and that does not fail.
  const unsure = stratumRule(
    strRow(better, (i) => (i >= 8 ? (i % 2 === 0 ? 53 : 45) : 50)),
    strBase,
    members,
    strTol,
    undefined,
  );
  check(
    "stratum rule: an inconclusive stratum is reported and does not fail the arm",
    !unsure.fails &&
      unsure.strata.find((s) => s.stratum === "low-light")?.verdict ===
        "inconclusive",
    verdicts(unsure),
  );

  const pinned = [...CURATED_IMAGES, ...ALPHA_IMAGES, ...GRAPHIC_IMAGES].find(
    (s) => s.split === "holdout3" && (s.holdout3?.strata.length ?? 0) > 0,
  );
  check(
    "holdout3StrataOf reads a pin's recorded strata, and none for an image that is no holdout3 pin",
    pinned !== undefined &&
      holdout3StrataOf(pinned.label).join(",") ===
        pinned.holdout3?.strata.join(",") &&
      holdout3StrataOf("kodak01").length === 0,
    pinned
      ? `${pinned.label}: ${holdout3StrataOf(pinned.label).join(",")}`
      : "no pin",
  );
}

console.log(
  failures === 0
    ? "\nAll metric self-checks passed.\n"
    : `\n${failures} metric self-check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
