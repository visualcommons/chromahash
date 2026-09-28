/**
 * Chroma-from-luma sizing probe (R&D tool).
 *
 * The rationale lists CfL as the largest expected v0.8 win but carries no
 * number for it. This measures the thing CfL actually depends on: how much of
 * each chroma AC coefficient is linearly predictable from the *co-located* luma
 * AC coefficient. Encoding L and chroma with the SAME coefficient count makes
 * the two selections identical, so index i of each channel is the same (cx, cy).
 *
 * Reported per image and pooled: Pearson ρ(a, L), ρ(b, L), the least-squares
 * gain α, and the residual energy fraction 1 − ρ² — the factor by which a
 * perfect per-image CfL predictor would shrink the chroma residual before
 * quantization. ρ² near 0 means CfL has nothing to predict at this scale.
 *
 * Usage: node dist/cfl-probe.js [--split tune|tune2|all] [--count N] [--tier T]
 *
 * Reads only the images already cached under `fixtures/`, and never a sealed
 * one (`corpus.ts` `parseScratchPhotoSplit`).
 */

import { glob } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { RUST_CLI } from "./adapters/chromahash.ts";
import { execFileSync } from "node:child_process";
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
    count: { type: "string", default: "26" },
    tier: { type: "string", default: "0" },
  },
});
let split: CorpusSplit | "all" = "tune";
try {
  split = parseScratchPhotoSplit(values.split ?? "tune");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const count = Number.parseInt(values.count ?? "26", 10);
const tier = Number.parseInt(values.tier ?? "0", 10);

/** Pearson correlation of two equal-length series (null when either is flat). */
function pearson(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i] ?? 0;
    sy += y[i] ?? 0;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] ?? 0) - mx;
    const dy = (y[i] ?? 0) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Least-squares gain α minimizing ‖y − αx‖², and the residual energy fraction. */
function lsGain(x: number[], y: number[]): { alpha: number; residual: number } {
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = 0; i < x.length; i++) {
    xy += (x[i] ?? 0) * (y[i] ?? 0);
    xx += (x[i] ?? 0) ** 2;
    yy += (y[i] ?? 0) ** 2;
  }
  if (xx <= 0 || yy <= 0) return { alpha: 0, residual: 1 };
  const alpha = xy / xx;
  return { alpha, residual: Math.max(0, (yy - (xy * xy) / xx) / yy) };
}

async function main(): Promise<void> {
  const toolRoot = path.resolve(import.meta.dirname, "..");
  const paths: string[] = [];
  for await (const entry of glob(
    path.join(toolRoot, "fixtures/**/*.{png,jpg}"),
  )) {
    const name = path.basename(entry).replace(/\.[^.]+$/, "");
    if (!inCorpus(name, "photo")) continue;
    if (!inSplit(name, split)) continue;
    paths.push(entry);
  }
  paths.sort();

  const rows: Array<{
    image: string;
    rhoA: number | null;
    rhoB: number | null;
    residualA: number;
    residualB: number;
    alphaA: number;
    alphaB: number;
  }> = [];

  for (const filePath of paths) {
    const input = await loadImage(filePath);
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
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          CHROMAHASH_TIER: String(tier),
          CHROMAHASH_TUNE: `l1=${count}:5 c=${count}:4`,
        },
      },
    );
    const g: Record<string, number[]> = { l: [], a: [], b: [], alpha: [] };
    for (const line of out.split("\n")) {
      if (!line) continue;
      const sp = line.indexOf(" ");
      const key = line.slice(0, sp);
      const arr = g[key];
      if (arr) arr.push(Number.parseFloat(line.slice(sp + 1)));
    }
    const la = lsGain(g.l ?? [], g.a ?? []);
    const lb = lsGain(g.l ?? [], g.b ?? []);
    rows.push({
      image: path.basename(filePath).replace(/\.[^.]+$/, ""),
      rhoA: pearson(g.l ?? [], g.a ?? []),
      rhoB: pearson(g.l ?? [], g.b ?? []),
      residualA: la.residual,
      residualB: lb.residual,
      alphaA: la.alpha,
      alphaB: lb.alpha,
    });
  }

  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : Number.NaN;
  // A grayscale photograph has an identically-zero chroma AC set: its
  // correlation with luma is 0/0, and "the predictor recovered none of the
  // energy" is meaningless when there is no energy to recover. Those channels
  // are excluded from the means (and counted) rather than folded in as
  // ρ = 0 / residual = 100%, which is what an achromatic image would otherwise
  // contribute to both.
  const definedA = rows.filter((r) => r.rhoA !== null);
  const definedB = rows.filter((r) => r.rhoB !== null);
  const absRhoA = mean(definedA.map((r) => Math.abs(r.rhoA as number)));
  const absRhoB = mean(definedB.map((r) => Math.abs(r.rhoB as number)));
  const resA = mean(definedA.map((r) => r.residualA));
  const resB = mean(definedB.map((r) => r.residualB));
  const skipped = rows.length - Math.min(definedA.length, definedB.length);

  console.log(
    `CfL probe: ${rows.length} ${split}-split photos, ${count} coefficients/channel at tier ${tier}\n`,
  );
  console.log(
    `  ${"image".padEnd(24)} ${"ρ(a,L)".padStart(8)} ${"ρ(b,L)".padStart(8)} ${"resid a".padStart(9)} ${"resid b".padStart(9)}`,
  );
  for (const r of rows) {
    console.log(
      `  ${r.image.padEnd(24)} ${(r.rhoA ?? Number.NaN).toFixed(3).padStart(8)} ${(r.rhoB ?? Number.NaN).toFixed(3).padStart(8)} ${r.residualA.toFixed(3).padStart(9)} ${r.residualB.toFixed(3).padStart(9)}`,
    );
  }
  if (skipped > 0) {
    console.log(
      `\n  ${skipped} image(s) have an all-zero chroma AC set (achromatic) and are excluded from the means.`,
    );
  }
  console.log(`\n  mean |ρ|: a ${absRhoA.toFixed(3)}, b ${absRhoB.toFixed(3)}`);
  console.log(
    `  mean residual energy after a per-image least-squares CfL predictor: a ${(resA * 100).toFixed(1)}%, b ${(resB * 100).toFixed(1)}%`,
  );
  console.log(
    "  (100% = CfL predicts nothing; 0% = chroma AC is a pure multiple of luma AC)",
  );

  const outDir = path.join(toolRoot, "output/sweeps");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, `cfl-probe-${split}.json`),
    `${JSON.stringify({ split, count, tier, rows, meanAbsRhoA: absRhoA, meanAbsRhoB: absRhoB, meanResidualA: resA, meanResidualB: resB }, null, 2)}\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
