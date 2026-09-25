/**
 * Coefficient-statistics probe (R&D tool): two numbers the rationale asserts
 * but never measured.
 *
 * 1. **Entropy headroom.** "~20–40% entropy savings on near-Laplacian AC" is
 *    the stated cost of fixed-width fields. This quantizes the corpus with the
 *    shipped µ-law quantizer and measures the actual zeroth-order entropy of
 *    the code stream — globally, and conditioned on the selection index (what a
 *    per-position context model would reach).
 *
 * 2. **Selection-order headroom.** The l2-ball takes the K lowest isotropic
 *    frequencies. This dumps a much larger candidate set and asks how much luma
 *    AC energy the ball's first K capture versus the best K of the same
 *    candidates — corpus-fixed (a trainable, zero-signaling reorder) and
 *    per-image (the unreachable oracle a signaled selection would chase).
 *
 * Usage: node dist/coeff-stats.js [--split tune|tune2|all] [--k 26] [--big 200]
 *
 * Reads only the images already cached under `fixtures/`, and never a sealed
 * one (`corpus.ts` `parseScratchPhotoSplit`).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { RUST_CLI } from "./adapters/chromahash.ts";
import {
  type CorpusSplit,
  inCorpus,
  inSplit,
  parseScratchPhotoSplit,
} from "./corpus.ts";
import { loadImage } from "./image-loader.ts";

const { values } = parseArgs({
  options: {
    split: { type: "string", default: "tune" },
    k: { type: "string", default: "26" },
    big: { type: "string", default: "200" },
  },
});
let split: CorpusSplit | "all" = "tune";
try {
  split = parseScratchPhotoSplit(values.split ?? "tune");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const K = Number.parseInt(values.k ?? "26", 10);
const BIG = Number.parseInt(values.big ?? "200", 10);

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

/** Shannon entropy (bits/symbol) of a symbol-count map. */
function entropy(counts: Map<number, number>): number {
  let n = 0;
  for (const c of counts.values()) n += c;
  if (n === 0) return 0;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function dump(
  binary: string,
  input: { smallWidth: number; smallHeight: number; smallRgba: Uint8Array },
  tune: string,
): Record<string, number[]> {
  const out = execFileSync(
    binary,
    [
      "dump-coeffs",
      String(input.smallWidth),
      String(input.smallHeight),
      "srgb",
    ],
    {
      input: Buffer.from(input.smallRgba),
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, CHROMAHASH_TIER: "1", CHROMAHASH_TUNE: tune },
    },
  );
  const g: Record<string, number[]> = { l: [], a: [], b: [], alpha: [] };
  for (const line of out.split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    const arr = g[line.slice(0, sp)];
    if (arr) arr.push(Number.parseFloat(line.slice(sp + 1)));
  }
  return g;
}

async function main(): Promise<void> {
  const toolRoot = path.resolve(import.meta.dirname, "..");
  const paths: string[] = [];
  for await (const e of glob(path.join(toolRoot, "fixtures/**/*.{png,jpg}"))) {
    const name = path.basename(e).replace(/\.[^.]+$/, "");
    if (!inCorpus(name, "photo")) continue;
    if (!inSplit(name, split)) continue;
    paths.push(e);
  }
  paths.sort();

  const global: Record<string, Map<number, number>> = {
    l: new Map(),
    c: new Map(),
  };
  const byIndex: Record<string, Map<number, number>[]> = { l: [], c: [] };
  let energyBall = 0;
  let energyTotal = 0;
  let energyPerImageBest = 0;
  const indexEnergy = new Array<number>(BIG).fill(0);
  const perImage: Array<{ image: string; ballFrac: number; bestFrac: number }> =
    [];

  for (const filePath of paths) {
    const input = await loadImage(filePath);
    const name = path.basename(filePath).replace(/\.[^.]+$/, "");

    const shipped = dump(RUST_CLI, input, `l1=${K}:5 c=9:4`);
    for (const [group, bits, mu] of [
      ["l", 5, 5],
      ["a", 4, 8],
      ["b", 4, 8],
    ] as const) {
      const key = group === "l" ? "l" : "c";
      const vals = shipped[group] ?? [];
      for (let i = 0; i < vals.length; i++) {
        const q = quantIndex(muCompress(vals[i] ?? 0, mu), bits);
        global[key]?.set(q, (global[key]?.get(q) ?? 0) + 1);
        const slot = byIndex[key];
        if (slot) {
          slot[i] ??= new Map();
          slot[i]?.set(q, (slot[i]?.get(q) ?? 0) + 1);
        }
      }
    }

    const big = dump(RUST_CLI, input, `l1=${BIG}:5 c=9:4`);
    const e = (big.l ?? []).map((v) => v * v);
    const total = e.reduce((s, v) => s + v, 0);
    if (total > 0) {
      const ball = e.slice(0, K).reduce((s, v) => s + v, 0);
      const best = [...e]
        .sort((x, y) => y - x)
        .slice(0, K)
        .reduce((s, v) => s + v, 0);
      energyBall += ball / total;
      energyPerImageBest += best / total;
      energyTotal += 1;
      for (let i = 0; i < Math.min(BIG, e.length); i++) {
        indexEnergy[i] = (indexEnergy[i] ?? 0) + (e[i] ?? 0) / total;
      }
      perImage.push({
        image: name,
        ballFrac: ball / total,
        bestFrac: best / total,
      });
    }
  }

  const n = energyTotal || 1;
  const ranked = indexEnergy
    .map((v, i) => ({ i, v }))
    .sort((x, y) => y.v - x.v)
    .slice(0, K);
  const fixedIdx = new Set(ranked.map((r) => r.i));
  let fixedFrac = 0;
  for (const r of ranked) fixedFrac += r.v / n;
  const ballFrac = energyBall / n;

  const hL = entropy(global.l ?? new Map());
  const hC = entropy(global.c ?? new Map());
  const hLIdx =
    (byIndex.l ?? []).reduce((s, m) => s + entropy(m), 0) /
    Math.max(1, (byIndex.l ?? []).length);
  const hCIdx =
    (byIndex.c ?? []).reduce((s, m) => s + entropy(m), 0) /
    Math.max(1, (byIndex.c ?? []).length);

  const acFixedBits = K * 5 + 2 * 9 * 4;
  const acEntropyBits = K * hL + 2 * 9 * hC;
  const acCtxBits = K * hLIdx + 2 * 9 * hCIdx;

  console.log(`coeff-stats: ${paths.length} ${split}-split photos\n`);
  console.log("Entropy of the shipped tier-0 AC code stream");
  console.log(
    `  luma   5.000 b fixed -> ${hL.toFixed(3)} b zeroth-order -> ${hLIdx.toFixed(3)} b per-index context`,
  );
  console.log(
    `  chroma 4.000 b fixed -> ${hC.toFixed(3)} b zeroth-order -> ${hCIdx.toFixed(3)} b per-index context`,
  );
  console.log(
    `  whole AC payload: ${acFixedBits} b fixed -> ${acEntropyBits.toFixed(1)} b (${((1 - acEntropyBits / acFixedBits) * 100).toFixed(1)}% saved) -> ${acCtxBits.toFixed(1)} b with context (${((1 - acCtxBits / acFixedBits) * 100).toFixed(1)}% saved)`,
  );
  console.log(
    `  at 32 B that is ${((acFixedBits - acEntropyBits) / 8).toFixed(1)} B of headroom, or ${((acFixedBits - acEntropyBits) / 5).toFixed(1)} more luma coefficients\n`,
  );

  console.log(
    `Selection order: luma AC energy captured by K=${K} of the ${BIG} lowest-frequency candidates`,
  );
  console.log(
    `  l2-ball prefix (shipped)        ${(ballFrac * 100).toFixed(2)}%`,
  );
  console.log(
    `  best corpus-fixed K (trainable) ${(fixedFrac * 100).toFixed(2)}%  (${K - [...fixedIdx].filter((i) => i < K).length} of ${K} slots differ from the ball)`,
  );
  console.log(
    `  best per-image K (oracle)       ${((energyPerImageBest / n) * 100).toFixed(2)}%`,
  );

  const outDir = path.join(toolRoot, "output/sweeps");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, `coeff-stats-${split}.json`),
    `${JSON.stringify({ split, K, BIG, hL, hC, hLIdx, hCIdx, acFixedBits, acEntropyBits, acCtxBits, ballFrac, fixedFrac, oracleFrac: energyPerImageBest / n, rankedIndices: ranked.map((r) => r.i), perImage }, null, 2)}\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
