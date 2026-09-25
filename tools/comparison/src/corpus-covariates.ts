/**
 * Measure candidate photographs on covariates alone, for curating a corpus
 * split without looking at how any encoder does on it (#76).
 *
 * A holdout chosen by how the format scores on it is not a holdout. So a
 * candidate is judged only by what it *is*: its licence, its source camera,
 * and five numbers measured on the same 512 px reference the harness scores
 * against (`image-loader.ts`) — orientation, mean CIELAB L\*, mean chroma C\*,
 * the high-key and low-key pixel fractions, and a Laplacian detail energy. No
 * encoder is built or run here, and nothing reads a result.
 *
 * The detail formula is written down here because the one behind the
 * `detail` figures in `natural-images.ts` was not: no formula tried reproduces
 * them, so those figures and these are on different scales. To place a
 * candidate against the existing corpus, run `--files` over the cached corpus
 * too and compare like with like.
 *
 *   node dist/corpus-covariates.js --commons <titles.txt> [--out <file.json>]
 *   node dist/corpus-covariates.js --files <image> [<image> ...]
 *
 * `--commons` reads one Commons file title per line (`File:…`; blank lines
 * and `#` comments skipped), asks Commons for each file's licence, author,
 * size, SHA-1 and camera EXIF, downloads the original into
 * `output/candidates/`, checks the bytes against Commons' SHA-1, and records
 * the SHA-256 a pin would carry. A file Commons does not describe, or whose
 * licence is not free, is reported and not measured. Nothing is pinned: the
 * output is a candidate list for a human to approve.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { REFERENCE_CAP } from "./image-loader.ts";

/** Covariates of one image, measured on its scoring reference. */
export interface Covariates {
  /** Stored pixel dimensions: what the harness scores, which never rotates. */
  width: number;
  height: number;
  /** Of the stored pixels, not of the picture a viewer would be shown. */
  orientation: "landscape" | "portrait" | "square";
  /**
   * The EXIF Orientation tag, when present. Anything but 1 means a viewer
   * rotates or flips the picture and the harness does not (`image-loader.ts`
   * never calls `rotate()`), so the orientation above is not what a person
   * looking at the file sees.
   */
  exifOrientation: number | null;
  /** Mean CIELAB L* (D65), 0–100. */
  meanL: number;
  /** Mean CIELAB chroma C*ab. */
  meanC: number;
  /** Mean a* and b*: the direction of any overall cast. */
  meanA: number;
  meanB: number;
  /** Fraction of pixels with L* ≥ {@link HIGH_KEY_L}. */
  highKey: number;
  /** Fraction of pixels with L* ≤ {@link LOW_KEY_L}. */
  lowKey: number;
  /**
   * Mean absolute 4-neighbour Laplacian of L* over interior pixels: how much
   * local structure the image has, in L* units per pixel.
   */
  detail: number;
}

/** A pixel this light counts toward the high-key fraction. */
export const HIGH_KEY_L = 90;
/** A pixel this dark counts toward the low-key fraction. */
export const LOW_KEY_L = 10;

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const labF = (t: number): number =>
  t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;

/** sRGB (8-bit) to CIELAB under D65. */
export function srgbToLab(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Covariates of an RGBA raster, which is already the scoring reference.
 * Alpha is ignored: the candidates are opaque photographs.
 */
export function covariatesOf(
  rgba: Uint8Array,
  w: number,
  h: number,
  native: { width: number; height: number; exifOrientation?: number | null },
): Covariates {
  const n = w * h;
  const L = new Float64Array(n);
  let sumL = 0;
  let sumC = 0;
  let sumA = 0;
  let sumB = 0;
  let high = 0;
  let low = 0;
  for (let i = 0; i < n; i++) {
    const [l, a, b] = srgbToLab(
      rgba[4 * i] ?? 0,
      rgba[4 * i + 1] ?? 0,
      rgba[4 * i + 2] ?? 0,
    );
    L[i] = l;
    sumL += l;
    sumC += Math.hypot(a, b);
    sumA += a;
    sumB += b;
    if (l >= HIGH_KEY_L) high++;
    if (l <= LOW_KEY_L) low++;
  }
  let lap = 0;
  let interior = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v =
        4 * (L[i] ?? 0) -
        (L[i - 1] ?? 0) -
        (L[i + 1] ?? 0) -
        (L[i - w] ?? 0) -
        (L[i + w] ?? 0);
      lap += Math.abs(v);
      interior++;
    }
  }
  const { width, height } = native;
  return {
    width,
    height,
    orientation:
      width === height ? "square" : width > height ? "landscape" : "portrait",
    exifOrientation: native.exifOrientation ?? null,
    meanL: sumL / n,
    meanC: sumC / n,
    meanA: sumA / n,
    meanB: sumB / n,
    highKey: high / n,
    lowKey: low / n,
    detail: interior > 0 ? lap / interior : 0,
  };
}

/**
 * Covariates of an encoded image, on the reference `image-loader.ts` builds:
 * the original capped to {@link REFERENCE_CAP} on the long edge with Lanczos3,
 * never enlarged.
 */
export async function measureFile(bytes: Buffer): Promise<Covariates> {
  const meta = await sharp(bytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) throw new Error("unreadable dimensions");
  const scale = Math.min(REFERENCE_CAP / width, REFERENCE_CAP / height, 1);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const { data } = await sharp(bytes)
    .resize(w, h, { kernel: "lanczos3", fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return covariatesOf(new Uint8Array(data), w, h, {
    width,
    height,
    exifOrientation: meta.orientation ?? null,
  });
}

// ─── Commons ────────────────────────────────────────────────────────────────

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT =
  "chromahash-corpus-covariates/0.7 (https://github.com/visualcommons/chromahash) node-fetch";
const CANDIDATE_DIR = path.resolve(import.meta.dirname, "../output/candidates");

/**
 * Licences a corpus image may carry: the families the existing pin tables
 * already use — CC0, public domain, and CC BY / CC BY-SA at any version,
 * ported or not. Anything else — NoDerivatives, NonCommercial, GFDL-only, or
 * a licence Commons does not name — is refused rather than judged here.
 */
export function isFreeLicence(licence: string): boolean {
  const l = licence.trim();
  return (
    /^CC0( 1\.0)?$/i.test(l) ||
    /^Public domain$/i.test(l) ||
    /^CC BY(-SA)? (1\.0|2\.0|2\.5|3\.0|4\.0)( [a-z]{2,3})?$/i.test(l)
  );
}

/** What Commons records about one file, as far as this tool reads it. */
export interface CommonsFacts {
  title: string;
  url: string;
  descriptionUrl: string;
  sha1: string;
  mime: string;
  licence: string;
  author: string;
  make: string | null;
  model: string | null;
  dateTimeOriginal: string | null;
  categories: string[];
}

interface ImageInfoPage {
  title: string;
  missing?: string;
  imageinfo?: {
    url: string;
    descriptionurl: string;
    sha1: string;
    mime: string;
    extmetadata?: Record<string, { value: string }>;
    metadata?: { name: string; value: unknown }[] | null;
  }[];
}

const stripHtml = (s: string): string =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

async function commonsFacts(
  titles: string[],
): Promise<Map<string, CommonsFacts | string>> {
  const out = new Map<string, CommonsFacts | string>();
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "1",
      prop: "imageinfo",
      iiprop: "url|sha1|mime|extmetadata|metadata",
      iiextmetadatafilter:
        "LicenseShortName|Artist|Categories|DateTimeOriginal",
      titles: batch.join("|"),
    });
    const response = await fetch(`${COMMONS_API}?${params}`, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`Commons answered HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      query?: {
        normalized?: { from: string; to: string }[];
        pages?: Record<string, ImageInfoPage>;
      };
    };
    const asked = new Map<string, string>(batch.map((t) => [t, t]));
    for (const { from, to } of body.query?.normalized ?? []) {
      asked.set(to, from);
    }
    for (const page of Object.values(body.query?.pages ?? {})) {
      const title = asked.get(page.title) ?? page.title;
      const info = page.imageinfo?.[0];
      if (page.missing !== undefined || info === undefined) {
        out.set(title, "Commons has no such file");
        continue;
      }
      const ext = info.extmetadata ?? {};
      const exif = new Map(
        (info.metadata ?? []).map((m) => [m.name, String(m.value)]),
      );
      out.set(title, {
        title: page.title,
        url: info.url,
        descriptionUrl: info.descriptionurl,
        sha1: info.sha1,
        mime: info.mime,
        licence: stripHtml(ext.LicenseShortName?.value ?? ""),
        author: stripHtml(ext.Artist?.value ?? ""),
        make: exif.get("Make")?.trim() ?? null,
        model: exif.get("Model")?.trim() ?? null,
        dateTimeOriginal: stripHtml(ext.DateTimeOriginal?.value ?? "") || null,
        categories: (ext.Categories?.value ?? "")
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean),
      });
    }
    for (const t of batch) {
      if (!out.has(t)) out.set(t, "Commons did not answer for it");
    }
  }
  return out;
}

async function download(url: string): Promise<Buffer> {
  for (const delay of [0, 2_000, 8_000, 20_000]) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
  }
  throw new Error(`gave up on ${url}`);
}

/** One measured candidate: what a pin would record, plus its covariates. */
export interface Candidate extends CommonsFacts {
  sha256: string;
  covariates: Covariates;
}

async function runCommons(
  listPath: string,
  outPath: string | undefined,
): Promise<void> {
  const titles = readFileSync(listPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  const facts = await commonsFacts(titles);
  await fs.mkdir(CANDIDATE_DIR, { recursive: true });
  const measured: Candidate[] = [];
  const refused: { title: string; reason: string }[] = [];
  for (const title of titles) {
    const f = facts.get(title);
    if (f === undefined || typeof f === "string") {
      refused.push({ title, reason: f ?? "not asked" });
      continue;
    }
    if (!isFreeLicence(f.licence)) {
      refused.push({
        title,
        reason: `licence "${f.licence}" is not one the corpus admits`,
      });
      continue;
    }
    if (f.mime !== "image/jpeg" && f.mime !== "image/png") {
      refused.push({ title, reason: `${f.mime} is not JPEG or PNG` });
      continue;
    }
    const file = path.join(
      CANDIDATE_DIR,
      path.basename(new URL(f.url).pathname),
    );
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch {
      bytes = await download(f.url);
      await fs.writeFile(file, bytes);
    }
    const sha1 = createHash("sha1").update(bytes).digest("hex");
    if (sha1 !== f.sha1) {
      refused.push({
        title,
        reason: `downloaded bytes have SHA-1 ${sha1}, Commons records ${f.sha1}`,
      });
      continue;
    }
    measured.push({
      ...f,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      covariates: await measureFile(bytes),
    });
    console.error(`measured ${title}`);
  }
  for (const r of refused) console.error(`refused ${r.title}: ${r.reason}`);
  const text = `${JSON.stringify({ measured, refused }, null, 2)}\n`;
  if (outPath !== undefined) await fs.writeFile(outPath, text);
  else process.stdout.write(text);
  console.error(`${measured.length} measured, ${refused.length} refused`);
}

async function runFiles(files: string[]): Promise<void> {
  const rows = [];
  for (const f of files) {
    const bytes = await fs.readFile(f);
    rows.push({
      file: path.basename(f),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      covariates: await measureFile(bytes),
    });
  }
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

// Run only as the entry point, so the self-test can import the measurement.
if (
  process.argv[1] !== undefined &&
  import.meta.filename === path.resolve(process.argv[1])
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      commons: { type: "string" },
      files: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  if (values.commons !== undefined) {
    await runCommons(values.commons, values.out);
  } else if (values.files && positionals.length > 0) {
    await runFiles(positionals);
  } else {
    console.error(
      "Usage: corpus-covariates.js --commons <titles.txt> [--out <file.json>] | --files <image>...",
    );
    process.exit(1);
  }
}
