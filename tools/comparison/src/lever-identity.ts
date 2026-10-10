/**
 * Check that PERFORMANCE.md §12.1's byte-identical levers are byte-identical
 * on the whole fixture corpus, not only on the spec vectors.
 *
 * `rust/tests/accel_levers.rs` proves identity on the shipped test vectors,
 * and `rd:gate` on its 64 photographs. Turning the levers on by default is a
 * claim about every input, so this widens the evidence to every fixture image
 * the harness has fetched. It encodes each one with every lever off and all
 * seven on (`ACCEL_ALL`, the arm PERFORMANCE.md times) at three sizes:
 *
 * - 100 px, at every tier code;
 * - 512 px, at every tier code;
 * - full resolution, at codes 0-2. Codes 3-4 at 24 MP take minutes per image
 *   and run the same per-coefficient code as at 512 px.
 *
 * The hashes must match byte for byte. Each hash is then decoded at its
 * natural size with every lever off and all seven on, and the pixels must
 * match too: two of the levers act only on decode.
 *
 * No metric is computed and no image is scored, so this reads no holdout in
 * the register's sense. The sealed holdout2 photographs (`sealed-*`) are
 * still skipped, so that nothing in their directory is touched outside a
 * frozen read.
 *
 *   node dist/lever-identity.js [--out results/lever-identity.json]
 *
 * Exits non-zero when any pair differs, or when no image is found.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ACCEL_ALL } from "./perf/matrix.js";
import { captureProvenance, fileSha256, repoRelative } from "./results.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURES = path.join(REPO_ROOT, "tools/comparison/fixtures");
const BIN = path.join(REPO_ROOT, "rust/target/release/examples/encode_stdin");
const DIRS = ["natural", "alpha", "graphic", "synthetic", "holdout"] as const;

/** Each source size (0 = full resolution) and the tier codes encoded at it. */
const SIZES: ReadonlyArray<readonly [number, readonly number[]]> = [
  [100, [0, 1, 2, 3, 4]],
  [512, [0, 1, 2, 3, 4]],
  [0, [0, 1, 2]],
];

function run(args: string[], input: Buffer, tune: string, tier: number) {
  const r = spawnSync(BIN, args, {
    input,
    maxBuffer: 1 << 30,
    env: {
      ...process.env,
      CHROMAHASH_TUNE: tune,
      CHROMAHASH_TIER: String(tier),
    },
  });
  if (r.status !== 0) {
    throw new Error(`encode_stdin ${args.join(" ")}: ${r.stderr}`);
  }
  return r.stdout;
}

const outIdx = process.argv.indexOf("--out");
const out = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;

const provenance = captureProvenance({
  config: "lever-identity",
  configSha256: "",
  iqaCli: "unused",
  binaries: [BIN],
});
const corpus: { name: string; sha256: string }[] = [];
const diffs: string[] = [];
let encodePairs = 0;
let decodePairs = 0;

for (const d of DIRS) {
  const dir = path.join(FIXTURES, d);
  const files = readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && !f.startsWith("sealed-"))
    .sort();
  for (const f of files) {
    const file = path.join(dir, f);
    corpus.push({ name: `${d}/${f}`, sha256: fileSha256(file) ?? "missing" });
    for (const [size, tiers] of SIZES) {
      let img = sharp(file).rotate().ensureAlpha();
      if (size > 0) {
        img = img.resize(size, size, {
          fit: "inside",
          withoutEnlargement: true,
        });
      }
      const { data, info } = await img
        .raw()
        .toBuffer({ resolveWithObject: true });
      const where = `${d}/${f} ${info.width}x${info.height}`;
      const args = ["encode", String(info.width), String(info.height), "srgb"];
      for (const tier of tiers) {
        const off = run(args, data, "", tier);
        const on = run(args, data, ACCEL_ALL, tier);
        encodePairs++;
        if (!off.equals(on)) {
          diffs.push(`${where} t${tier}: hash differs`);
          continue;
        }
        const pixelsOff = run(["decode"], off, "", tier);
        const pixelsOn = run(["decode"], off, ACCEL_ALL, tier);
        decodePairs++;
        if (!pixelsOff.equals(pixelsOn)) {
          diffs.push(`${where} t${tier}: decode differs`);
        }
      }
    }
  }
  console.error(`${d}: ${files.length} images (${encodePairs} pairs so far)`);
}

const result = {
  levers: ACCEL_ALL,
  images: corpus.length,
  encodePairs,
  decodePairs,
  differing: diffs.length,
  diffs,
  provenance: { ...provenance, corpus },
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (out) {
  writeFileSync(out, json);
  console.error(`wrote ${repoRelative(out)}`);
} else {
  process.stdout.write(json);
}
console.error(
  `${corpus.length} images, ${encodePairs} encode pairs, ${decodePairs} decode pairs: ${diffs.length} differ`,
);
if (corpus.length === 0 || diffs.length > 0) process.exit(1);
