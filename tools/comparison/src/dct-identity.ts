/**
 * D4's byte-identity count (`spec/V0.8-DECISIONS.md` D4, "Byte identity, as
 * measured"): encode every image with the separable forward DCT off (the
 * shipped encoder) and on (`dct_separable=1`), and count the hashes that
 * differ, per corpus, split, size and tier.
 *
 * Sizes follow `lever-identity`: the harness's encoder input (`loadImage`,
 * at most 100 px, what every sweep scores) and 512 px at codes 0–4, and full
 * resolution at codes 0–2. A negative control (`mu_l=3`, a luma companding
 * change) encodes every image at the first two sizes through the same
 * `CHROMAHASH_TUNE` path, and the record is refused unless it changed at
 * least one hash, so a count of zero comes from a comparison that can see a
 * difference.
 *
 * Without `--split`, it counts every tuning image ({@link D4_OPEN_SPLITS}:
 * tune and tune2, the generated fixtures included), and every input of
 * `spec/test-vectors/integration-encode.json` at codes 0–4, whose shipped
 * hash at its own code must be its expected hash. The graphics `holdout`,
 * which no committed result has read, holdout2 and alpha holdout v2 are never
 * encoded.
 *
 * With `--split holdout3 --decision D4` it is D4's one holdout3 read: the
 * register gate must record D4 as frozen, a second read is refused, and all
 * three parts are encoded, hashes only, with the count also reported per
 * stratum. No metric is computed in either mode.
 *
 *   node dist/dct-identity.js [--split holdout3 --decision D4] [--jobs N]
 *
 * Writes tools/comparison/results/counts/dct-identity.json, or
 * dct-identity-holdout3.json for the read. Exits non-zero when any hash
 * differs, when a vector's hash is not its expected one, when no image is
 * found, or when the control changed nothing.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { ensureAlphaImages } from "./alpha-images.ts";
import { HOLDOUT3_STRATA, inCorpus, splitFor } from "./corpus.ts";
import {
  CONTROL_SIZES,
  COUNTS_DIR,
  D4_CANDIDATE,
  D4_CONTROL,
  D4_OPEN_SPLITS,
  type IdentityRecord,
  type Observation,
  SIZES,
  type SizeKey,
  type VectorCount,
  tallyCells,
  tallyStrata,
  totalsOf,
} from "./dct-identity-core.ts";
import { generateFixtures } from "./generate-fixtures.ts";
import { ensureGraphicImages } from "./graphic-images.ts";
import {
  type Holdout3Opening,
  assertHoldout3Unread,
  ensureHoldout3Images,
  ensureHoldoutImages,
  openHoldout3,
} from "./holdout-images.ts";
import { loadImage, orientedSize, upright } from "./image-loader.ts";
import { ensureNaturalImages } from "./natural-images.ts";
import { defaultJobs, mapConcurrent } from "./pool.ts";
import { holdout3StrataOf } from "./register-verdict-core.ts";
import { captureProvenance, fileSha256, repoRelative } from "./results.ts";

const TOOL_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(TOOL_ROOT, "../..");
const BIN = path.join(REPO_ROOT, "rust/target/release/examples/encode_stdin");
const VECTORS = path.join(
  REPO_ROOT,
  "spec/test-vectors/integration-encode.json",
);
const TOOL = "dct-identity";

/** The gamut fixtures carry their gamut in their name, as `sweep.ts` reads them. */
const GAMUTS: Record<string, string> = {
  "gamut-srgb": "srgb",
  "gamut-p3": "displayp3",
  "gamut-adobe-rgb": "adobergb",
  "gamut-bt2020": "bt2020",
  "gamut-prophoto": "prophoto",
};
/** The vectors' gamut names, as `encode_stdin` takes them. */
const VECTOR_GAMUTS: Record<string, string> = {
  sRGB: "srgb",
  "Display P3": "displayp3",
  "Adobe RGB": "adobergb",
  "BT.2020": "bt2020",
  "ProPhoto RGB": "prophoto",
};

function encode(
  rgba: Uint8Array,
  w: number,
  h: number,
  gamut: string,
  tune: string,
  tier: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, ["encode", String(w), String(h), gamut], {
      env: {
        ...process.env,
        CHROMAHASH_TUNE: tune,
        CHROMAHASH_TIER: String(tier),
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`encode_stdin encode ${w}x${h}: ${Buffer.concat(err)}`),
        );
      } else {
        resolve(Buffer.concat(out));
      }
    });
    child.stdin.on("error", reject);
    child.stdin.end(rgba);
  });
}

/** The raster at `size`, upright, as RGBA. */
async function raster(
  file: string,
  size: SizeKey,
): Promise<{ rgba: Uint8Array; w: number; h: number }> {
  if (size === "harness") {
    const input = await loadImage(file);
    return {
      rgba: input.smallRgba,
      w: input.smallWidth,
      h: input.smallHeight,
    };
  }
  let img = upright(await fs.readFile(file));
  if (size === "512") {
    img = img.resize(512, 512, { fit: "inside", withoutEnlargement: true });
  }
  const { data, info } = await img
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8Array(data), w: info.width, h: info.height };
}

const corpusOf = (name: string): string =>
  (["photo", "alpha", "graphic"] as const).find((c) => inCorpus(name, c)) ??
  "synthetic";

async function fetchOpen(): Promise<void> {
  const synthetic = path.join(TOOL_ROOT, "fixtures/synthetic");
  if (!existsSync(synthetic) || (await fs.readdir(synthetic)).length === 0) {
    await generateFixtures();
  }
  await ensureNaturalImages();
  await ensureHoldoutImages();
  await ensureAlphaImages();
  await ensureGraphicImages();
}

async function fetchHoldout3(opening: Holdout3Opening): Promise<void> {
  await ensureHoldout3Images(opening);
  await ensureAlphaImages("holdout3", opening);
  await ensureGraphicImages("holdout3", opening);
}

/** Every fixture image the run counts, by split: open, or holdout3 only. */
async function images(sealedRead: boolean): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of glob(
    path.join(TOOL_ROOT, "fixtures/**/*.{png,jpg}"),
  )) {
    const split = splitFor(path.parse(entry).name);
    if (sealedRead ? split === "holdout3" : D4_OPEN_SPLITS.includes(split)) {
      paths.push(entry);
    }
  }
  return paths.sort();
}

async function countImage(
  file: string,
  sealedRead: boolean,
): Promise<{
  obs: Observation[];
  meta: IdentityRecord["images"][number];
  sha256: string;
}> {
  const name = path.parse(file).name;
  const corpus = corpusOf(name);
  const split = splitFor(name);
  const strata = sealedRead ? holdout3StrataOf(name) : [];
  const gamut = GAMUTS[name] ?? "srgb";
  const meta = await sharp(file).metadata();
  const obs: Observation[] = [];
  for (const { size, tiers } of SIZES) {
    const { rgba, w, h } = await raster(file, size);
    for (const tier of tiers) {
      const off = await encode(rgba, w, h, gamut, "", tier);
      const on = await encode(rgba, w, h, gamut, D4_CANDIDATE, tier);
      const control = CONTROL_SIZES.includes(size)
        ? !(await encode(rgba, w, h, gamut, D4_CONTROL, tier)).equals(off)
        : null;
      obs.push({
        image: name,
        corpus,
        split,
        strata,
        size,
        tier,
        differs: !off.equals(on),
        controlDiffers: control,
      });
    }
  }
  const { width, height } = orientedSize(meta);
  return {
    obs,
    meta: { name, corpus, split, width, height, strata },
    sha256: fileSha256(file) ?? "missing",
  };
}

interface EncodeVector {
  name: string;
  input: {
    width: number;
    height: number;
    gamut: string;
    tier: number;
    rgba: number[];
  };
  expected: { hash: number[] };
}

async function countVectors(): Promise<VectorCount> {
  const vectors = JSON.parse(readFileSync(VECTORS, "utf8")) as EncodeVector[];
  const out: VectorCount = {
    vectors: vectors.length,
    encodes: 0,
    differing: 0,
    expectedMismatches: [],
    diffs: [],
  };
  for (const v of vectors) {
    const gamut = VECTOR_GAMUTS[v.input.gamut];
    if (gamut === undefined) {
      throw new Error(`vector ${v.name}: unknown gamut ${v.input.gamut}`);
    }
    const rgba = Uint8Array.from(v.input.rgba);
    for (const tier of [0, 1, 2, 3, 4]) {
      const { width: w, height: h } = v.input;
      const off = await encode(rgba, w, h, gamut, "", tier);
      const on = await encode(rgba, w, h, gamut, D4_CANDIDATE, tier);
      out.encodes++;
      if (!off.equals(on)) {
        out.differing++;
        out.diffs.push(`${v.name} t${tier}`);
      }
      if (tier === v.input.tier && !off.equals(Buffer.from(v.expected.hash))) {
        out.expectedMismatches.push(v.name);
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      split: { type: "string" },
      decision: { type: "string" },
      jobs: { type: "string" },
    },
  });
  let opening: Holdout3Opening | undefined;
  if (values.split !== undefined) {
    if (values.split !== "holdout3") {
      throw new Error(
        `--split takes only holdout3 (D4's one read); without it every unsealed split is counted, not ${values.split}`,
      );
    }
    opening = openHoldout3(values.decision);
    if (opening.decision !== "D4") {
      throw new Error(
        `dct-identity reads holdout3 only for D4, not ${opening.decision}`,
      );
    }
    assertHoldout3Unread(opening.decision, TOOL);
  } else if (values.decision !== undefined) {
    throw new Error("--decision means nothing without --split holdout3");
  }
  const sealedRead = opening !== undefined;
  const out = path.join(
    COUNTS_DIR,
    sealedRead ? "dct-identity-holdout3.json" : "dct-identity.json",
  );
  if (sealedRead && existsSync(out)) {
    throw new Error(`${repoRelative(out)} already holds D4's holdout3 read`);
  }
  // Each job holds one full-resolution raster (~100 MB at 25 MP), so the
  // default stays well under the thread count.
  const jobs = values.jobs
    ? Number(values.jobs)
    : Math.max(1, Math.min(8, defaultJobs()));

  const provenance = captureProvenance({
    config: TOOL,
    configSha256: "",
    iqaCli: "unused",
    binaries: [BIN],
  });
  if (opening) await fetchHoldout3(opening);
  else await fetchOpen();
  const files = await images(sealedRead);
  if (files.length === 0) throw new Error("no image found to count");
  console.error(`${files.length} images, ${jobs} jobs`);

  let done = 0;
  const counted = await mapConcurrent(files, jobs, async (f) => {
    const r = await countImage(f, sealedRead);
    done++;
    if (done % 10 === 0) console.error(`${done}/${files.length}`);
    return r;
  });
  const obs = counted.flatMap((c) => c.obs);
  const cells = tallyCells(obs);
  const vectors = sealedRead ? undefined : await countVectors();
  const record: IdentityRecord = {
    schema: 1,
    tool: TOOL,
    name: sealedRead ? "dct-identity-holdout3" : "dct-identity",
    split: sealedRead ? "holdout3" : "open",
    settings: {
      candidate: D4_CANDIDATE,
      control: D4_CONTROL,
      sizes: SIZES,
      controlSizes: CONTROL_SIZES,
      ...(opening ? { holdout3: opening } : {}),
    },
    provenance: {
      ...provenance,
      corpus: counted.map((c) => ({ name: c.meta.name, sha256: c.sha256 })),
    },
    images: counted.map((c) => c.meta),
    cells,
    strata: sealedRead ? tallyStrata(obs, HOLDOUT3_STRATA) : [],
    ...(vectors ? { vectors } : {}),
    totals: totalsOf(cells),
    diffs: obs
      .filter((o) => o.differs)
      .map((o) => `${o.image} ${o.size} t${o.tier}`),
  };
  mkdirSync(COUNTS_DIR, { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  const t = record.totals;
  console.error(`wrote ${repoRelative(out)}`);
  console.error(
    `${files.length} images, ${t.encodes} encode pairs: ${t.differing} differ; control ${D4_CONTROL}: ${t.controlDiffering} of ${t.controlEncodes} differ`,
  );
  if (vectors) {
    console.error(
      `${vectors.vectors} vectors, ${vectors.encodes} encode pairs: ${vectors.differing} differ; ${vectors.expectedMismatches.length} shipped hashes off their expected value`,
    );
  }
  if (
    t.differing > 0 ||
    t.controlDiffering === 0 ||
    (vectors &&
      (vectors.differing > 0 || vectors.expectedMismatches.length > 0))
  ) {
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
