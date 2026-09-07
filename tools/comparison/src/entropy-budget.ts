/**
 * Entropy budget (R&D tool): the decision number behind roadmap item U11.
 *
 * `coeff-stats` measured the *entropy* of the tier-0 AC code stream — 202 b of
 * fixed fields carry 184.3 b of order-0 information, 148.9 b once conditioned
 * on the selection index (§4.9). That is a headroom number: it says how much of
 * the payload is redundant, not what the format would gain by removing it.
 *
 * This script asks the question a spec change actually turns on: **if tier 0's
 * 32 bytes were entropy-coded, how many more coefficients would fit, and what
 * quality would that buy?** It enumerates candidate layouts the way
 * `sweeps/allocation-grid.json` does — luma and chroma count × precision — and
 * for each one measures the size of the coded payload three ways:
 *
 *   * **static pooled** — the §4.9 headroom number: pooled corpus entropy times
 *     the symbol count. In-sample and table-free, so it is a lower bound no
 *     real coder reaches.
 *   * **order-0 adaptive** — a Laplace-smoothed frequency model that starts
 *     uniform and adapts *within one image*, coded sequentially. This is what a
 *     coder with **no decoder tables** costs, and on a 26-symbol luma stream the
 *     model never has time to learn anything: it is the honest floor of the
 *     "just add an arithmetic coder" proposal.
 *   * **pretrained tables, leave-one-image-out** — a static table baked into the
 *     decoder, order-0 or conditioned on the selection index, trained on the
 *     other N−1 corpus images and used to code the held-out one. This is what
 *     the §4.9 context model would really cost, scored out-of-sample so the
 *     22-image corpus cannot flatter itself.
 *
 * Every cost is an achievable arithmetic-coder rate (Σ −log2 p under the model
 * the decoder can reproduce), reported as bits per image and then averaged, not
 * as a pooled static entropy. The fixed 54-bit prefix is added to every total.
 *
 * The layouts that fit the byte budget are then encoded for real (uncoded, so
 * they overflow the budget) and scored, which converts "N more coefficients"
 * into a ΔE00 the R-D ladder can be read against.
 *
 * Usage:
 *   node dist/entropy-budget.js [--split tune|holdout|all] [--max-images N]
 *                               [--skip-score] [--out <name>]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  RUST_CLI,
  decodeViaRust,
  encodeViaRust,
} from "./adapters/chromahash.ts";
import { type CorpusSplit, inCorpus, splitFor } from "./corpus.ts";
import { gamutToSrgbReference } from "./gamut.ts";
import { ensureHoldoutImages } from "./holdout-images.ts";
import { loadImage } from "./image-loader.ts";
import { computeAllMetrics, setScoringConfig } from "./metrics.ts";
import { ensureIqaAvailable } from "./metrics/iqa.ts";
import { ensureNaturalImages } from "./natural-images.ts";
import type { ImageInput } from "./types.ts";

/** Fixed bit prefix before the AC payload (descriptor+aspect+DC+scales). */
const PREFIX_BITS = 54;
/** Shipped µ-law companding parameters (rust/src/mulaw.rs). */
const MU_L = 5;
const MU_C = 8;
/** Shipped tier-0 AC layout: 26 luma at 5 b, 9 per chroma channel at 4 b. */
const SHIPPED = { nL: 26, lBits: 5, nC: 9, cBits: 4 } as const;
/** Shipped L:C base-count ratio. */
const SHIPPED_LC_RATIO = SHIPPED.nL / SHIPPED.nC;

/**
 * Largest base counts a candidate layout may ask for. Coefficients are dumped
 * per layout rather than once per image: the encoder normalizes by the
 * channel's AC scale, and that scale is taken over the *selected* set, so a
 * 26-coefficient dump is not the prefix of a 180-coefficient one whenever the
 * larger selection reaches a bigger |AC|. (Measured: it is a prefix for most
 * images and not for others — enough to shift a µ-law code.)
 */
const MAX_L = 180;
const MAX_C = 60;

/**
 * Byte budgets scored, with the tier *code* whose raster carries that many
 * coefficients. Code 1 is the 32-byte default and code 2 is 108 B.
 */
const BUDGETS: ReadonlyArray<{ bytes: number; tier: number }> = [
  { bytes: 32, tier: 1 },
  { bytes: 108, tier: 2 },
];

/**
 * Render level for a tier code. Counts scale by 4^level and the raster by
 * 2^level; the codes are ordered by quality and code 1 is level 0, so the two
 * differ by one. Conflating them multiplies every count by four.
 *
 * Saturates at zero, matching `render_level` in `rust/src/constants.rs`: code 0
 * is the compact tier and is level 0, not level −1.
 */
const levelOf = (tier: number): number => Math.max(0, tier - 1);

/** Precision families swept, as [luma bits, chroma bits]. */
const PRECISION_FAMILIES: ReadonlyArray<readonly [number, number]> = [
  [5, 4],
  [4, 3],
  [3, 2],
  [4, 4],
  [5, 3],
  [3, 3],
  [6, 5],
  [6, 4],
];

/**
 * Luma:chroma count ratios swept. Index 0 is the shipped 26:9, which the report
 * uses as the "same shape, more coefficients" reference — the question a spec
 * change would actually ask, as opposed to the degenerate one the pure
 * coefficient-count objective answers.
 */
const LC_RATIOS: readonly number[] = [SHIPPED_LC_RATIO, 1.5, 2.0, 4.0, 6.0];

const { values } = parseArgs({
  options: {
    split: { type: "string", default: "tune" },
    "max-images": { type: "string" },
    "skip-score": { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const splitArg = values.split ?? "tune";
if (splitArg !== "tune" && splitArg !== "holdout" && splitArg !== "all") {
  console.error(`invalid --split: ${splitArg}`);
  process.exit(1);
}
const maxImages = values["max-images"]
  ? Number.parseInt(values["max-images"], 10)
  : null;
const skipScore = values["skip-score"] === true;

/** mu-law compress, matching `rust/src/mulaw.rs`. */
function muCompress(v: number, mu: number): number {
  const x = Math.max(-1, Math.min(1, v));
  return Math.sign(x) * (Math.log1p(mu * Math.abs(x)) / Math.log1p(mu));
}

/** Odd-level quantizer index, matching `quantize_compressed`. */
function quantIndex(compressed: number, bits: number): number {
  const maxIdx = (1 << bits) - 2;
  const raw = ((compressed + 1) / 2) * maxIdx;
  const idx = Math.sign(raw) * Math.round(Math.abs(raw));
  return Math.max(0, Math.min(maxIdx, idx));
}

/** Symbol-alphabet size of a `bits`-wide odd-level field. */
function alphabet(bits: number): number {
  return (1 << bits) - 1;
}

/** One image's quantized code streams for one precision, by channel group. */
interface CodeStreams {
  /** Luma codes in selection order. */
  l: Uint8Array;
  /** `a` codes in selection order. */
  a: Uint8Array;
  /** `b` codes in selection order. */
  b: Uint8Array;
}

/** Raw dumped coefficients for one image at one tier. */
interface Dump {
  l: number[];
  a: number[];
  b: number[];
}

function dumpCoefficients(input: ImageInput, tier: number, tune: string): Dump {
  const out = execFileSync(
    RUST_CLI,
    [
      "dump-coeffs",
      String(input.smallWidth),
      String(input.smallHeight),
      "srgb",
    ],
    {
      input: Buffer.from(input.smallRgba),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        CHROMAHASH_TIER: String(tier),
        CHROMAHASH_TUNE: tune,
      },
    },
  );
  const dump: Dump = { l: [], a: [], b: [] };
  for (const line of out.split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    const group = line.slice(0, sp);
    const value = Number.parseFloat(line.slice(sp + 1));
    if (group === "l") dump.l.push(value);
    else if (group === "a") dump.a.push(value);
    else if (group === "b") dump.b.push(value);
  }
  return dump;
}

/** Quantize a dump into code streams at one (luma bits, chroma bits) pair. */
function quantizeDump(dump: Dump, lBits: number, cBits: number): CodeStreams {
  const q = (vals: number[], bits: number, mu: number) => {
    const out = new Uint8Array(vals.length);
    for (let i = 0; i < vals.length; i++) {
      out[i] = quantIndex(muCompress(vals[i] ?? 0, mu), bits);
    }
    return out;
  };
  return {
    l: q(dump.l, lBits, MU_L),
    a: q(dump.a, cBits, MU_C),
    b: q(dump.b, cBits, MU_C),
  };
}

/** Shannon entropy (bits/symbol) of a count vector. */
function entropyOf(counts: Float64Array): number {
  let n = 0;
  for (const c of counts) n += c;
  if (n === 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Backoff strengths tried for the context-with-backoff model. The best is
 * picked per layout by the same leave-one-out cost the model is scored with, so
 * it is one scalar fitted out-of-sample rather than a free parameter.
 */
const BACKOFF_ALPHAS: readonly number[] = [0.5, 1, 2, 4, 8, 16, 32, 64];

/** Per-image coded sizes of one layout's AC payload, in bits. */
interface AcCost {
  /** Pooled corpus entropy × symbol count — the §4.9 headroom lower bound. */
  staticPooled: number;
  /** Laplace-smoothed model that starts uniform and adapts within the image. */
  order0Adaptive: number;
  /** Static order-0 decoder table, trained leave-one-image-out. */
  order0Table: number;
  /** Static per-selection-index decoder table, trained leave-one-image-out. */
  contextTable: number;
  /**
   * Per-index table that backs off to the order-0 table instead of to a uniform
   * prior. With 22 images and a 31-symbol alphabet the raw per-index histogram
   * is mostly noise, and smoothing it towards uniform — the naive Laplace
   * choice — charges for symbols the order-0 model already knows are common.
   * This is what a real context coder would be built as.
   */
  contextBackoff: number;
}

/** A layout under test. */
interface Layout {
  nL: number;
  lBits: number;
  nC: number;
  cBits: number;
  /** Index into {@link LC_RATIOS}; 0 is the shipped 26:9 shape. */
  ratioIndex: number;
  /** Quality tier *code*: counts are multiplied by 4^levelOf(tier). */
  tier: number;
  /** Byte budget this layout is a candidate for. */
  budgetBytes: number;
}

function layoutLabel(l: Layout): string {
  return `L${l.nL}@${l.lBits} C${l.nC}@${l.cBits}`;
}

/** Fixed-field AC payload size of a layout, in bits. */
function acFixedBits(l: Layout): number {
  return l.nL * l.lBits + 2 * l.nC * l.cBits;
}

/**
 * Score one layout's AC payload across the corpus.
 *
 * Both table models are trained leave-one-image-out: the counts are pooled over
 * every image, the held-out image's own contribution is subtracted, and the
 * remainder is Laplace-smoothed. A table that had seen the image it codes would
 * report the in-sample entropy, which is exactly the number this script exists
 * to stop quoting as achievable.
 */
function scoreLayout(
  layout: Layout,
  streams: CodeStreams[],
): { perImage: AcCost[]; mean: AcCost; backoffAlpha: number } {
  const { nL, nC, lBits, cBits } = layout;
  const aL = alphabet(lBits);
  const aC = alphabet(cBits);

  // Pooled counts: order-0 per group, and one table per selection index.
  const poolL = new Float64Array(aL);
  const poolC = new Float64Array(aC);
  const idxL: Float64Array[] = Array.from(
    { length: nL },
    () => new Float64Array(aL),
  );
  const idxC: Float64Array[] = Array.from(
    { length: nC },
    () => new Float64Array(aC),
  );

  // Per-image counts, so the leave-one-out tables are a subtraction.
  const ownL: Float64Array[] = [];
  const ownC: Float64Array[] = [];
  for (const s of streams) {
    const oL = new Float64Array(aL);
    const oC = new Float64Array(aC);
    for (let i = 0; i < nL; i++) {
      const sym = s.l[i] ?? 0;
      oL[sym] = (oL[sym] ?? 0) + 1;
      poolL[sym] = (poolL[sym] ?? 0) + 1;
      const t = idxL[i];
      if (t) t[sym] = (t[sym] ?? 0) + 1;
    }
    for (let i = 0; i < nC; i++) {
      for (const sym of [s.a[i] ?? 0, s.b[i] ?? 0]) {
        oC[sym] = (oC[sym] ?? 0) + 1;
        poolC[sym] = (poolC[sym] ?? 0) + 1;
        const t = idxC[i];
        if (t) t[sym] = (t[sym] ?? 0) + 1;
      }
    }
    ownL.push(oL);
    ownC.push(oC);
  }

  const hL = entropyOf(poolL);
  const hC = entropyOf(poolC);
  const staticPooled = nL * hL + 2 * nC * hC;

  /** −log2 of a Laplace-smoothed probability, given counts and a total. */
  const cost = (count: number, total: number, a: number) =>
    -Math.log2((count + 1) / (total + a));

  const perImage: AcCost[] = [];
  const backoffByImage: Float64Array[] = [];
  for (let img = 0; img < streams.length; img++) {
    const s = streams[img];
    const oL = ownL[img];
    const oC = ownC[img];
    if (!s || !oL || !oC) continue;

    // Order-0 adaptive: uniform prior, updated after each coded symbol.
    const adaptL = new Float64Array(aL).fill(1);
    const adaptC = new Float64Array(aC).fill(1);
    let adaptLTotal = aL;
    let adaptCTotal = aC;

    // Leave-one-out order-0 tables.
    let looLTotal = 0;
    for (let v = 0; v < aL; v++) looLTotal += (poolL[v] ?? 0) - (oL[v] ?? 0);
    let looCTotal = 0;
    for (let v = 0; v < aC; v++) looCTotal += (poolC[v] ?? 0) - (oC[v] ?? 0);

    let adaptive = 0;
    let table0 = 0;
    let tableCtx = 0;
    const backoff = new Float64Array(BACKOFF_ALPHAS.length);

    /** LOO order-0 probability of `sym` in a group, used as the backoff prior. */
    const prior0 = (
      pool: Float64Array,
      own: Float64Array,
      sym: number,
      total: number,
      a: number,
    ) => ((pool[sym] ?? 0) - (own[sym] ?? 0) + 1) / (total + a);

    for (let i = 0; i < nL; i++) {
      const sym = s.l[i] ?? 0;
      adaptive += -Math.log2((adaptL[sym] ?? 1) / adaptLTotal);
      adaptL[sym] = (adaptL[sym] ?? 1) + 1;
      adaptLTotal += 1;
      table0 += cost((poolL[sym] ?? 0) - (oL[sym] ?? 0), looLTotal, aL);
      // Leave-one-out: drop this image's own symbol from the index's table.
      const t = idxL[i];
      const seen = Math.max(0, (t?.[sym] ?? 0) - 1);
      tableCtx += cost(seen, streams.length - 1, aL);
      const p0 = prior0(poolL, oL, sym, looLTotal, aL);
      for (let k = 0; k < BACKOFF_ALPHAS.length; k++) {
        const alpha = BACKOFF_ALPHAS[k] ?? 1;
        backoff[k] =
          (backoff[k] ?? 0) -
          Math.log2((seen + alpha * p0) / (streams.length - 1 + alpha));
      }
    }
    for (let i = 0; i < nC; i++) {
      const t = idxC[i];
      for (const sym of [s.a[i] ?? 0, s.b[i] ?? 0]) {
        adaptive += -Math.log2((adaptC[sym] ?? 1) / adaptCTotal);
        adaptC[sym] = (adaptC[sym] ?? 1) + 1;
        adaptCTotal += 1;
        table0 += cost((poolC[sym] ?? 0) - (oC[sym] ?? 0), looCTotal, aC);
        let c = t ? (t[sym] ?? 0) : 0;
        // Subtract this image's own two contributions at this index.
        if (t) {
          if ((s.a[i] ?? 0) === sym) c -= 1;
          if ((s.b[i] ?? 0) === sym) c -= 1;
        }
        const seen = Math.max(0, c);
        tableCtx += cost(seen, 2 * (streams.length - 1), aC);
        const p0 = prior0(poolC, oC, sym, looCTotal, aC);
        for (let k = 0; k < BACKOFF_ALPHAS.length; k++) {
          const alpha = BACKOFF_ALPHAS[k] ?? 1;
          backoff[k] =
            (backoff[k] ?? 0) -
            Math.log2((seen + alpha * p0) / (2 * (streams.length - 1) + alpha));
        }
      }
    }

    perImage.push({
      staticPooled,
      order0Adaptive: adaptive,
      order0Table: table0,
      contextTable: tableCtx,
      // Filled in below, once the best backoff strength is known.
      contextBackoff: Number.NaN,
    });
    backoffByImage.push(backoff);
  }

  // Pick the backoff strength with the lowest leave-one-out cost over the
  // corpus, then charge every image at that setting.
  let bestK = 0;
  let bestTotal = Number.POSITIVE_INFINITY;
  for (let k = 0; k < BACKOFF_ALPHAS.length; k++) {
    let total = 0;
    for (const b of backoffByImage) total += b[k] ?? 0;
    if (total < bestTotal) {
      bestTotal = total;
      bestK = k;
    }
  }
  for (let i = 0; i < perImage.length; i++) {
    const row = perImage[i];
    const b = backoffByImage[i];
    if (row && b) row.contextBackoff = b[bestK] ?? Number.NaN;
  }

  const avg = (pick: (c: AcCost) => number) =>
    perImage.length === 0
      ? 0
      : perImage.reduce((s, c) => s + pick(c), 0) / perImage.length;
  return {
    perImage,
    backoffAlpha: BACKOFF_ALPHAS[bestK] ?? 1,
    mean: {
      staticPooled,
      order0Adaptive: avg((c) => c.order0Adaptive),
      order0Table: avg((c) => c.order0Table),
      contextTable: avg((c) => c.contextTable),
      contextBackoff: avg((c) => c.contextBackoff),
    },
  };
}

/** One emitted row of the layout table. */
interface Row {
  layout: string;
  tier: number;
  nL: number;
  lBits: number;
  nC: number;
  cBits: number;
  /** Index into {@link LC_RATIOS}; 0 is the shipped 26:9 shape. */
  ratioIndex: number;
  /** Total coefficients carried (luma + both chroma channels). */
  coefficients: number;
  budgetBytes: number;
  budgetBits: number;
  /** 54 b prefix + fixed-width AC fields. */
  fixedBits: number;
  /** Byte length of the uncoded hash this layout produces today. */
  fixedBytes: number;
  /** 54 b + pooled corpus entropy (the §4.9 lower bound, in-sample). */
  staticBits: number;
  /** 54 b + order-0 adaptive coded payload, mean over images. */
  order0Bits: number;
  /** 54 b + leave-one-out order-0 table payload, mean over images. */
  order0TableBits: number;
  /** 54 b + leave-one-out per-index context payload, mean over images. */
  contextBits: number;
  /** 54 b + per-index context backing off to the order-0 table, mean over images. */
  contextBackoffBits: number;
  /** Backoff strength chosen for this layout. */
  backoffAlpha: number;
  fitsFixed: boolean;
  fitsOrder0: boolean;
  fitsOrder0Table: boolean;
  fitsContext: boolean;
  fitsContextBackoff: boolean;
}

/** Enumerate the candidate layouts for one byte budget. */
function candidateLayouts(budgetBytes: number, tier: number): Layout[] {
  const budgetBits = budgetBytes * 8;
  const acBudget = budgetBits - PREFIX_BITS;
  const scale = 4 ** levelOf(tier);
  const seen = new Set<string>();
  const out: Layout[] = [];

  const add = (
    nL: number,
    lBits: number,
    nC: number,
    cBits: number,
    ratioIndex: number,
  ) => {
    if (nL < 1 || nC < 1 || nL > MAX_L || nC > MAX_C) return;
    const key = `${nL}:${lBits}:${nC}:${cBits}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ nL, lBits, nC, cBits, ratioIndex, tier, budgetBytes });
  };

  // The shipped shape always appears, as the reference row.
  add(SHIPPED.nL, SHIPPED.lBits, SHIPPED.nC, SHIPPED.cBits, 0);

  for (const [lBits, cBits] of PRECISION_FAMILIES) {
    for (let r = 0; r < LC_RATIOS.length; r++) {
      const ratio = LC_RATIOS[r] ?? SHIPPED_LC_RATIO;
      for (let nC = 1; nC <= MAX_C; nC++) {
        const nL = Math.round(ratio * nC);
        const fixed = scale * (nL * lBits + 2 * nC * cBits);
        // Layouts far under the budget waste bytes and layouts far over it are
        // out of reach of any measured coder; keep the band in between.
        if (fixed < acBudget * 0.9 || fixed > acBudget * 2.6) continue;
        add(nL, lBits, nC, cBits, r);
      }
    }
  }
  return out;
}

async function loadCorpus(): Promise<ImageInput[]> {
  const toolRoot = path.resolve(import.meta.dirname, "..");
  await ensureNaturalImages();
  if (splitArg !== "tune") await ensureHoldoutImages();

  const paths: string[] = [];
  for await (const entry of glob(
    path.join(toolRoot, "fixtures/**/*.{png,jpg}"),
  )) {
    paths.push(entry);
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

/** Mean ΔE00 of a layout, encoded uncoded at its natural length. */
async function scoreCiede(
  layout: Layout,
  inputs: ImageInput[],
): Promise<{ ciede: number; bytes: number }> {
  const tune = `l1=${layout.nL}:${layout.lBits} c=${layout.nC}:${layout.cBits}`;
  let sum = 0;
  let n = 0;
  let bytes = 0;
  for (const input of inputs) {
    const { smallWidth: w, smallHeight: h, smallRgba: rgba } = input;
    const hash = encodeViaRust(RUST_CLI, w, h, rgba, "srgb", layout.tier, tune);
    bytes += hash.length;
    const dec = decodeViaRust(RUST_CLI, hash, "srgb", w, h, tune);
    const { metrics } = await computeAllMetrics(
      input.metricReferenceRgba ?? input.referenceRgba,
      input.referenceWidth,
      input.referenceHeight,
      dec.rgba,
      dec.w,
      dec.h,
    );
    if (metrics.ciede2000 !== null && Number.isFinite(metrics.ciede2000)) {
      sum += metrics.ciede2000;
      n++;
    }
  }
  return { ciede: n > 0 ? sum / n : Number.NaN, bytes: bytes / inputs.length };
}

async function main(): Promise<void> {
  if (!skipScore) ensureIqaAvailable();
  setScoringConfig({ upscalePolicy: "browser-gamma", blurredScoring: false });

  let inputs = await loadCorpus();
  if (maxImages !== null) inputs = inputs.slice(0, maxImages);
  console.log(`entropy-budget: ${inputs.length} ${splitArg}-split photos`);

  const rows: Row[] = [];
  for (const { bytes: budgetBytes, tier } of BUDGETS) {
    const budgetBits = budgetBytes * 8;
    const scale = 4 ** levelOf(tier);
    // Group candidates by their (nL, nC) count pair: one dump per pair per
    // image serves every precision family at those counts, since the dumped
    // coefficients are pre-quantization.
    const byCounts = new Map<string, Layout[]>();
    for (const layout of candidateLayouts(budgetBytes, tier)) {
      const key = `${layout.nL}:${layout.nC}`;
      const list = byCounts.get(key);
      if (list) list.push(layout);
      else byCounts.set(key, [layout]);
    }
    console.log(
      `  ${budgetBytes} B / tier ${tier}: ${byCounts.size} count pairs, ` +
        `${[...byCounts.values()].reduce((n, v) => n + v.length, 0)} layouts`,
    );

    for (const layouts of byCounts.values()) {
      const first = layouts[0];
      if (!first) continue;
      const tune = `l1=${first.nL}:5 c=${first.nC}:4`;
      const dumped = inputs.map((input) => dumpCoefficients(input, tier, tune));
      const quantCache = new Map<string, CodeStreams[]>();
      for (const layout of layouts) {
        const key = `${layout.lBits}:${layout.cBits}`;
        let streams = quantCache.get(key);
        if (!streams) {
          streams = dumped.map((d) =>
            quantizeDump(d, layout.lBits, layout.cBits),
          );
          quantCache.set(key, streams);
        }
        const scaled: Layout = {
          ...layout,
          nL: layout.nL * scale,
          nC: layout.nC * scale,
        };
        const { mean, backoffAlpha } = scoreLayout(scaled, streams);
        const fixed = PREFIX_BITS + acFixedBits(scaled);
        rows.push({
          layout: layoutLabel(layout),
          tier,
          nL: scaled.nL,
          lBits: layout.lBits,
          nC: scaled.nC,
          cBits: layout.cBits,
          ratioIndex: layout.ratioIndex,
          coefficients: scaled.nL + 2 * scaled.nC,
          budgetBytes,
          budgetBits,
          fixedBits: fixed,
          fixedBytes: Math.ceil(fixed / 8),
          staticBits: PREFIX_BITS + mean.staticPooled,
          order0Bits: PREFIX_BITS + mean.order0Adaptive,
          order0TableBits: PREFIX_BITS + mean.order0Table,
          contextBits: PREFIX_BITS + mean.contextTable,
          contextBackoffBits: PREFIX_BITS + mean.contextBackoff,
          backoffAlpha,
          fitsFixed: fixed <= budgetBits,
          fitsOrder0: PREFIX_BITS + mean.order0Adaptive <= budgetBits,
          fitsOrder0Table: PREFIX_BITS + mean.order0Table <= budgetBits,
          fitsContext: PREFIX_BITS + mean.contextTable <= budgetBits,
          fitsContextBackoff: PREFIX_BITS + mean.contextBackoff <= budgetBits,
        });
      }
    }
  }

  // ── The shipped layout: what each coder actually costs ────────────────────
  const shippedRow = rows.find(
    (r) =>
      r.tier === 1 &&
      r.layout ===
        layoutLabel({ ...SHIPPED, ratioIndex: 0, tier: 1, budgetBytes: 32 }),
  );
  console.log("\nShipped tier-0 layout L26@5 C9@4 — AC payload, bits/image");
  if (shippedRow) {
    const ac = (b: number) => b - PREFIX_BITS;
    const acFixed = ac(shippedRow.fixedBits);
    const pct = (b: number) => ((1 - ac(b) / acFixed) * 100).toFixed(1);
    console.log(`  fixed fields                    ${acFixed.toFixed(1)} b`);
    console.log(
      `  static pooled entropy           ${ac(shippedRow.staticBits).toFixed(1)} b  (−${pct(shippedRow.staticBits)}%)  in-sample lower bound`,
    );
    console.log(
      `  order-0 adaptive, no tables     ${ac(shippedRow.order0Bits).toFixed(1)} b  (−${pct(shippedRow.order0Bits)}%)  achievable`,
    );
    console.log(
      `  order-0 pretrained table (LOO)  ${ac(shippedRow.order0TableBits).toFixed(1)} b  (−${pct(shippedRow.order0TableBits)}%)  achievable`,
    );
    console.log(
      `  per-index context table (LOO)   ${ac(shippedRow.contextBits).toFixed(1)} b  (−${pct(shippedRow.contextBits)}%)  achievable`,
    );
    console.log(
      `  context + order-0 backoff (LOO) ${ac(shippedRow.contextBackoffBits).toFixed(1)} b  (−${pct(shippedRow.contextBackoffBits)}%)  achievable (α=${shippedRow.backoffAlpha})`,
    );
    const bestCoded = Math.min(
      ac(shippedRow.order0Bits),
      ac(shippedRow.order0TableBits),
      ac(shippedRow.contextBits),
      ac(shippedRow.contextBackoffBits),
    );
    const saved = acFixed - bestCoded;
    console.log(
      `  best measured coder saves ${saved.toFixed(1)} b = ${Math.floor(saved / SHIPPED.lBits)} more ${SHIPPED.lBits}-bit luma coefficients ` +
        `(§4.9's in-sample context figure implies ${Math.floor((acFixed - 148.9) / SHIPPED.lBits)}).`,
    );
    const gap =
      (ac(shippedRow.order0Bits) / ac(shippedRow.staticBits) - 1) * 100;
    console.log(
      [
        `  adaptive-vs-static gap: the table-free adaptive coder costs ${gap.toFixed(1)}% more`,
        "  than the static entropy it is quoted against — a payload this short is not enough",
        "  for a model that starts uniform to pay for itself.",
      ].join("\n"),
    );
  }

  // ── What each coder buys, per budget ─────────────────────────────────────
  //
  // "Largest layout that fits" is the literal U11 question, but taken alone it
  // is answered by the degenerate corner of the grid: 3-bit luma / 2-bit chroma
  // maximizes coefficient count and destroys quality. So each coder is reported
  // three ways — the shipped shape carried further, the best layout the grid
  // offers on ΔE00, and the raw count maximum that shows why count alone is the
  // wrong objective.

  const CODERS = [
    { key: "fitsFixed", bits: "fixedBits", label: "fixed fields (today)" },
    { key: "fitsOrder0", bits: "order0Bits", label: "order-0 adaptive" },
    {
      key: "fitsOrder0Table",
      bits: "order0TableBits",
      label: "order-0 table (LOO)",
    },
    {
      key: "fitsContext",
      bits: "contextBits",
      label: "per-index context (LOO)",
    },
    {
      key: "fitsContextBackoff",
      bits: "contextBackoffBits",
      label: "context + order-0 backoff",
    },
  ] as const;

  /** The fitting row with the most coefficients, under an optional filter. */
  const largestFitting = (
    budgetBytes: number,
    coder: (typeof CODERS)[number]["key"],
    where: (r: Row) => boolean = () => true,
  ): Row | null => {
    let best: Row | null = null;
    for (const r of rows) {
      if (r.budgetBytes !== budgetBytes || !r[coder] || !where(r)) continue;
      if (
        best === null ||
        r.coefficients > best.coefficients ||
        (r.coefficients === best.coefficients && r.fixedBits > best.fixedBits)
      ) {
        best = r;
      }
    }
    return best;
  };

  const isShippedShape = (r: Row) =>
    r.lBits === SHIPPED.lBits &&
    r.cBits === SHIPPED.cBits &&
    r.ratioIndex === 0;

  // Layouts worth spending a metrics run on: the shipped reference, each
  // coder's shipped-shape and count-maximal picks, and — per precision family,
  // at the shipped ratio — the largest layout each coder can afford. That last
  // set is the quality search: within one family more coefficients is always
  // better, so only its maximum can win.
  const pool = new Map<string, Row>();
  const remember = (r: Row | null) => {
    if (r) pool.set(`${r.tier}:${r.layout}`, r);
  };
  for (const { bytes: budgetBytes } of BUDGETS) {
    for (const { key } of CODERS) {
      remember(largestFitting(budgetBytes, key, isShippedShape));
      remember(largestFitting(budgetBytes, key));
      for (const [lBits, cBits] of PRECISION_FAMILIES) {
        remember(
          largestFitting(
            budgetBytes,
            key,
            (r) => r.lBits === lBits && r.cBits === cBits && r.ratioIndex === 0,
          ),
        );
      }
    }
  }

  const ciedeByLayout = new Map<string, number>();
  if (!skipScore) {
    console.log(`\nScoring ΔE00 for ${pool.size} candidate layouts…`);
    for (const [key, r] of pool) {
      const { ciede } = await scoreCiede(
        {
          nL: r.nL / 4 ** levelOf(r.tier),
          lBits: r.lBits,
          nC: r.nC / 4 ** levelOf(r.tier),
          cBits: r.cBits,
          ratioIndex: r.ratioIndex,
          tier: r.tier,
          budgetBytes: r.budgetBytes,
        },
        inputs,
      );
      ciedeByLayout.set(key, ciede);
      console.log(
        `  tier ${r.tier} ${r.layout.padEnd(14)} ${`${r.fixedBytes} B`.padStart(6)} uncoded  ΔE00 ${ciede.toFixed(3)}`,
      );
    }
  }
  const ciedeOf = (r: Row | null): number | null =>
    r === null ? null : (ciedeByLayout.get(`${r.tier}:${r.layout}`) ?? null);

  /** Best-ΔE00 fitting layout among the scored pool. */
  const bestQuality = (
    budgetBytes: number,
    coder: (typeof CODERS)[number]["key"],
  ): Row | null => {
    let best: Row | null = null;
    let bestCiede = Number.POSITIVE_INFINITY;
    for (const r of pool.values()) {
      if (r.budgetBytes !== budgetBytes || !r[coder]) continue;
      const c = ciedeOf(r);
      if (c === null || !Number.isFinite(c)) continue;
      if (c < bestCiede) {
        bestCiede = c;
        best = r;
      }
    }
    return best;
  };

  interface Pick {
    budgetBytes: number;
    coder: string;
    kind: "shipped shape" | "best ΔE00" | "most coefficients";
    layout: string | null;
    tier: number | null;
    coefficients: number | null;
    codedBits: number | null;
    uncodedBytes: number | null;
    ciede2000: number | null;
  }
  const picks: Pick[] = [];

  for (const { bytes: budgetBytes } of BUDGETS) {
    console.log(
      `\nWhat fits ${budgetBytes} B (${budgetBytes * 8} b) — ${splitArg} split, ${inputs.length} images`,
    );
    console.log(
      `  ${"coder".padEnd(24)} ${"pick".padEnd(17)} ${"layout".padEnd(14)} ${"coeffs".padStart(6)} ${"coded b".padStart(8)} ${"uncoded".padStart(8)} ${"ΔE00".padStart(7)}`,
    );
    console.log(
      "  (the ΔE00 search covers every precision family at the shipped 26:9 count",
      "\n   ratio; the count-ratio dimension is sweeps/allocation-grid.json's question)",
    );
    for (const { key, bits, label } of CODERS) {
      const variants: Array<[Pick["kind"], Row | null]> = [
        ["shipped shape", largestFitting(budgetBytes, key, isShippedShape)],
        ["best ΔE00", bestQuality(budgetBytes, key)],
        ["most coefficients", largestFitting(budgetBytes, key)],
      ];
      for (const [kind, r] of variants) {
        const ciede = ciedeOf(r);
        picks.push({
          budgetBytes,
          coder: label,
          kind,
          layout: r?.layout ?? null,
          tier: r?.tier ?? null,
          coefficients: r?.coefficients ?? null,
          codedBits: r ? r[bits] : null,
          uncodedBytes: r?.fixedBytes ?? null,
          ciede2000: ciede,
        });
        console.log(
          `  ${label.padEnd(24)} ${kind.padEnd(17)} ${(r?.layout ?? "—").padEnd(14)} ${String(r?.coefficients ?? "—").padStart(6)} ${(r ? r[bits].toFixed(1) : "—").padStart(8)} ${(r ? `${r.fixedBytes} B` : "—").padStart(8)} ${(ciede !== null ? ciede.toFixed(3) : "—").padStart(7)}`,
        );
      }
    }
  }

  const toolRoot = path.resolve(import.meta.dirname, "..");
  const outDir = path.join(toolRoot, "output/sweeps");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `${values.out ?? "entropy-budget"}-${splitArg}.json`,
  );
  await fs.writeFile(
    outPath,
    `${JSON.stringify(
      {
        split: splitArg,
        images: inputs.length,
        prefixBits: PREFIX_BITS,
        budgets: BUDGETS,
        picks,
        rows,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n→ ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
