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
 * A comparison that could never report a difference would print the same
 * "0 differ", so every 100 px and 512 px pair also runs a negative control:
 * the same image encoded with `CONTROL`, a luma companding change that alters
 * the quantized AC codes of any image with luma detail. It reaches the binary
 * through the same `CHROMAHASH_TUNE` path as `ACCEL_ALL`, so it also shows the
 * tune string is not silently dropped. Where a control hash differs from the
 * levers-off hash, its decoded pixels are compared with the levers-off pixels
 * too. The run fails unless at least one control encode and one control decode
 * are reported as differing, so a "0 differ" record shows the comparison could
 * see a difference on the same images.
 *
 * No metric is computed and no image is scored, so this reads no holdout in
 * the register's sense. The sealed holdout2 images are still skipped, judged
 * by `corpus.ts`'s `partitionSealed` like every other loader, so that nothing
 * in their directory is touched outside a frozen read.
 *
 *   node dist/lever-identity.js [--out baselines/lever-identity.json]
 *
 * Exits non-zero when any pair differs, when no image is found, or when the
 * negative control reports no differing encode or no differing decode.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { partitionSealed } from "./corpus.js";
import { ACCEL_ALL } from "./perf/matrix.js";
import { captureProvenance, fileSha256, repoRelative } from "./results.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURES = path.join(REPO_ROOT, "tools/comparison/fixtures");
const BIN = path.join(REPO_ROOT, "rust/target/release/examples/encode_stdin");
const DIRS = ["natural", "alpha", "graphic", "synthetic", "holdout"] as const;

/**
 * The negative control's tune: luma µ-law companding at 3 instead of the
 * shipped 5, which moves the quantized luma AC codes. The prototype separable
 * DCT (`dct_separable=1`) was tried first and changed no byte on the 43
 * synthetic fixtures, so it cannot be relied on to differ on a given corpus.
 */
const CONTROL = "mu_l=3";

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
let controlPairs = 0;
let controlEncodesDiffering = 0;
let controlDecodesDiffering = 0;

for (const d of DIRS) {
  const dir = path.join(FIXTURES, d);
  const { open: files } = partitionSealed(
    readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort(),
  );
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
        if (size === 0) continue;
        const control = run(args, data, CONTROL, tier);
        controlPairs++;
        if (!control.equals(off)) {
          controlEncodesDiffering++;
          if (!run(["decode"], control, "", tier).equals(pixelsOff)) {
            controlDecodesDiffering++;
          }
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
  control: {
    tune: CONTROL,
    pairs: controlPairs,
    encodesDiffering: controlEncodesDiffering,
    decodesDiffering: controlDecodesDiffering,
  },
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
console.error(
  `control ${CONTROL}: ${controlPairs} pairs, ${controlEncodesDiffering} encodes and ${controlDecodesDiffering} decodes differ`,
);
const controlBlind =
  controlEncodesDiffering === 0 || controlDecodesDiffering === 0;
if (controlBlind) {
  console.error(
    "the negative control reported no difference, so this comparison cannot be shown to detect one",
  );
}
if (corpus.length === 0 || diffs.length > 0 || controlBlind) process.exit(1);
