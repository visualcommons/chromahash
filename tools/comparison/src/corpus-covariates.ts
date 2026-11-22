/**
 * Measure candidate photographs on covariates alone, for curating a corpus
 * split without looking at how any encoder does on it (#76).
 *
 * A holdout chosen by how the format scores on it is not a holdout. So a
 * candidate is judged only by what it *is*: its licence, its source camera,
 * and five numbers measured on the same 512 px reference the harness scores
 * against (`image-loader.ts`) — orientation, mean CIELAB L\*, mean chroma C\*,
 * the high-key and low-key pixel fractions, and a Laplacian detail energy. An
 * image with an alpha channel also gets the three covariates the alpha corpus
 * is curated on (#93): its non-opaque and soft-alpha fractions and its
 * silhouette complexity ({@link AlphaCovariates}). For holdout3 (#129) every
 * image also gets a skin-tone covariate — the fraction of pixels inside a
 * fixed CIELAB {@link SKIN_REGION} — and the capture device its own EXIF
 * names, with whether that device is a phone ({@link isPhoneCamera}). No
 * encoder is built or run here, and nothing reads a result.
 *
 * This is also the tool the covariates in `natural-images.ts`' `notes` are
 * measured with (`--files` over the cached corpus; #102). The figures first
 * recorded there came from a formula nobody wrote down and no variant tried
 * reproduced, so they were re-measured here, and a candidate and a pinned
 * image are now on one scale.
 *
 *   node dist/corpus-covariates.js --commons <titles.txt> [--out <file.json>]
 *   node dist/corpus-covariates.js --files <image> [<image> ...]
 *   node dist/corpus-covariates.js --draw-holdout3 --out <file.json>
 *
 * `--draw-holdout3` runs the holdout3 draw exactly as {@link HOLDOUT3_DRAW}
 * and `corpus.ts`' `HOLDOUT3_PROTOCOL` fix it, and writes the record: every
 * query's hits, every axis's refusals by reason, and the picks with what a
 * pin needs. It pins nothing.
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
import { ALPHA_IMAGES } from "./alpha-images.ts";
import {
  ALPHA_HOLDOUT3_PREFIX,
  GRAPHIC_HOLDOUT3_PREFIX,
  HOLDOUT3_PREFIX,
  HOLDOUT3_PROTOCOL,
  HOLDOUT3_STRATA,
  type Holdout3Record,
  holdout3Strata,
} from "./corpus.ts";
import { GRAPHIC_IMAGES } from "./graphic-images.ts";
import { KODAK_SHA256 } from "./holdout-images.ts";
import { REFERENCE_CAP, orientedSize, upright } from "./image-loader.ts";
import { CURATED_IMAGES } from "./natural-images.ts";

/** Covariates of one image, measured on its scoring reference. */
export interface Covariates {
  /**
   * Dimensions of the upright picture: the stored ones, swapped when the EXIF
   * Orientation tag turns it a quarter turn. The harness turns every image
   * upright before it encodes or scores it (`image-loader.ts` `upright`), so
   * these are the dimensions it scores, and the ones a pin records.
   */
  width: number;
  height: number;
  /** Of the upright picture, as a viewer is shown it and the harness scores it. */
  orientation: "landscape" | "portrait" | "square";
  /**
   * The EXIF Orientation tag, when present. Anything but 1 means the stored
   * pixels are rotated or flipped relative to the picture; every figure here
   * is measured after undoing it.
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
  /**
   * Fraction of pixels inside the fixed CIELAB {@link SKIN_REGION} (#129).
   * It is a colour test, not a detector: sand, wood and warm-lit walls fall
   * in the region too, and a stratum built on it says "this much skin-coloured
   * area", which is the property an encoder can see.
   */
  skin: number;
  /** Mean L* of the pixels inside the skin region, or null when there are none. */
  skinL: number | null;
  /**
   * The capture device the file's own EXIF names: Make and Model as stored,
   * joined by a space, or null when it records neither ({@link exifCamera}).
   */
  camera: string | null;
  /** Whether {@link camera} names a phone ({@link isPhoneCamera}). */
  phone: boolean;
  /**
   * The alpha covariates, for an image that stores an alpha channel; null for
   * one that does not. The colour covariates above are taken over every pixel
   * whatever its alpha, so on a cut-out they describe the stored raster, not
   * what a composite shows.
   */
  alpha: AlphaCovariates | null;
}

/**
 * What the alpha corpus is curated on (#93): how much of the image is
 * transparent, how much of that is soft, and how intricate the silhouette is.
 */
export interface AlphaCovariates {
  /**
   * Fraction of pixels with alpha < 255, on the stored pixels at full
   * resolution: the same measurement as `nonOpaqueFraction` in
   * `alpha-images.ts`, so a candidate's figure is comparable with a pin's.
   */
  nonOpaqueFraction: number;
  /** Fraction with 0 < alpha < 255, on the same pixels: the soft edges. */
  softAlphaFraction: number;
  /**
   * How intricate the silhouette is. The image is resampled to a
   * {@link REFERENCE_CAP} px square whatever its aspect (Lanczos3), so the
   * figure measures the outline and not the raster's shape: a mask filling a
   * 13:1 strip is as simple as one filling a square. The mask is alpha ≥ 128,
   * its perimeter P is the number of 4-neighbour pixel edges between mask and
   * non-mask (the raster's border counts as non-mask), and the figure is
   * P / (4 √A) for mask area A. A mask filling the raster scores 1, a disc
   * about 1.13, and a ragged, perforated or scattered outline much more. Null
   * when no pixel reaches alpha 128.
   */
  silhouette: number | null;
}

/** A pixel this light counts toward the high-key fraction. */
export const HIGH_KEY_L = 90;
/** A pixel this dark counts toward the low-key fraction. */
export const LOW_KEY_L = 10;

/**
 * The skin region (#129), fixed before the holdout3 draw: CIELAB (D65)
 * lightness, chroma C*ab and hue angle h_ab in degrees, each bound inclusive.
 * The hue band brackets the yellow-red angles human skin occupies across
 * tone, the chroma band excludes near-neutrals and saturated paint, and the
 * lightness band excludes clipped highlights and near-black.
 */
export const SKIN_REGION = {
  minL: 20,
  maxL: 88,
  minC: 10,
  maxC: 50,
  minHue: 25,
  maxHue: 70,
} as const;

/** Is a CIELAB colour inside {@link SKIN_REGION}? */
export function inSkinRegion(L: number, a: number, b: number): boolean {
  const r = SKIN_REGION;
  const c = Math.hypot(a, b);
  const h = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return (
    L >= r.minL &&
    L <= r.maxL &&
    c >= r.minC &&
    c <= r.maxC &&
    h >= r.minHue &&
    h <= r.maxHue
  );
}

/**
 * Makes whose every camera is a phone, matched at the start of EXIF Make.
 * Apple, Samsung, Sony, Google, Microsoft and Asus also make cameras, tablets
 * or computers, so {@link isPhoneCamera} decides them by model instead.
 */
const PHONE_MAKES =
  /^(xiaomi|redmi|poco|huawei|honor|oneplus|oppo|vivo|realme|motorola|hmd global|nokia|lge|lg electronics|htc|fairphone|meizu|zte|nothing|blackberry|research in motion)\b/i;

/**
 * Does an EXIF Make and Model name a phone? Fixed before the holdout3 draw
 * (#129): a tablet (`iPad`, Samsung `SM-T`/`SM-P`/`SM-X`, any model naming a
 * pad, tab or tablet) is not a phone, and neither is a camera from a maker
 * that also makes phones (Sony `ILCE-`, Samsung `NX`, …).
 */
export function isPhoneCamera(
  make: string | null,
  model: string | null,
): boolean {
  const mk = (make ?? "").trim();
  const md = (model ?? "").trim();
  if (mk === "" && md === "") return false;
  if (/iphone/i.test(md)) return true;
  if (/ipad|ipod|\b(pad|tab|tablet)\b|pixel c\b/i.test(md)) return false;
  if (/^samsung/i.test(mk)) {
    return (
      /^(SM-[A-Z]|GT-[IN]|SGH-|SCH-|SHV-|SPH-|SC-\d|galaxy)/i.test(md) &&
      !/^SM-[TPX]/i.test(md)
    );
  }
  if (/^sony/i.test(mk)) {
    return /^(xperia|SO-|SOV|SOG|XQ-|[CDEFGHJ]\d{4})/i.test(md);
  }
  if (/^google/i.test(mk)) return /pixel|nexus/i.test(md);
  if (/^microsoft/i.test(mk)) return /lumia/i.test(md);
  if (/^asus/i.test(mk)) return /zenfone|^ASUS_[XZ]/i.test(md);
  return PHONE_MAKES.test(mk);
}

/**
 * EXIF Make and Model from the IFD0 of a raw EXIF block (`sharp`'s
 * `metadata().exif`, which starts `Exif\0\0`, or a bare TIFF header), each
 * null when absent. A malformed block reads as neither, never as a throw: the
 * device is a covariate, and an image whose EXIF cannot be read simply names
 * none.
 */
export function exifCamera(exif: Buffer | undefined): {
  make: string | null;
  model: string | null;
} {
  const none = { make: null, model: null };
  if (exif === undefined || exif.length < 8) return none;
  try {
    const t = exif.toString("latin1", 0, 6) === "Exif\0\0" ? 6 : 0;
    const order = exif.toString("latin1", t, t + 2);
    if (order !== "II" && order !== "MM") return none;
    const le = order === "II";
    const u16 = (o: number): number =>
      le ? exif.readUInt16LE(o) : exif.readUInt16BE(o);
    const u32 = (o: number): number =>
      le ? exif.readUInt32LE(o) : exif.readUInt32BE(o);
    if (u16(t + 2) !== 42) return none;
    const ifd = t + u32(t + 4);
    const n = u16(ifd);
    let make: string | null = null;
    let model: string | null = null;
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + 12 * i;
      const tag = u16(e);
      if ((tag !== 0x010f && tag !== 0x0110) || u16(e + 2) !== 2) continue;
      const count = u32(e + 4);
      const at = count <= 4 ? e + 8 : t + u32(e + 8);
      if (at + count > exif.length) continue;
      const text = exif
        .toString("latin1", at, at + count)
        .replace(/\0[\s\S]*$/, "")
        .trim();
      if (text === "") continue;
      if (tag === 0x010f) make = text;
      else model = text;
    }
    return { make, model };
  } catch {
    return none;
  }
}

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
 * The non-opaque and soft-alpha fractions of an RGBA raster, which for a
 * curated alpha image is the stored pixels at full resolution
 * ({@link AlphaCovariates}).
 */
export function alphaFractions(rgba: Uint8Array): {
  nonOpaqueFraction: number;
  softAlphaFraction: number;
} {
  const n = Math.floor(rgba.length / 4);
  let nonOpaque = 0;
  let soft = 0;
  for (let i = 0; i < n; i++) {
    const a = rgba[4 * i + 3] ?? 255;
    if (a < 255) nonOpaque++;
    if (a > 0 && a < 255) soft++;
  }
  return {
    nonOpaqueFraction: n > 0 ? nonOpaque / n : 0,
    softAlphaFraction: n > 0 ? soft / n : 0,
  };
}

/** The mask threshold for {@link silhouetteOf}. */
export const SILHOUETTE_ALPHA = 128;

/**
 * Silhouette complexity P / (4 √A) of an RGBA raster's alpha ≥
 * {@link SILHOUETTE_ALPHA} mask ({@link AlphaCovariates}); null for an empty
 * mask.
 */
export function silhouetteOf(
  rgba: Uint8Array,
  w: number,
  h: number,
): number | null {
  const inside = (x: number, y: number): boolean =>
    x >= 0 &&
    y >= 0 &&
    x < w &&
    y < h &&
    (rgba[4 * (y * w + x) + 3] ?? 0) >= SILHOUETTE_ALPHA;
  let area = 0;
  let perimeter = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      area++;
      if (!inside(x - 1, y)) perimeter++;
      if (!inside(x + 1, y)) perimeter++;
      if (!inside(x, y - 1)) perimeter++;
      if (!inside(x, y + 1)) perimeter++;
    }
  }
  return area > 0 ? perimeter / (4 * Math.sqrt(area)) : null;
}

/**
 * Covariates of an RGBA raster, which is already the scoring reference. The
 * colour covariates ignore alpha; `native.alpha` carries the alpha
 * covariates, which {@link measureFile} measures partly at full resolution.
 */
export function covariatesOf(
  rgba: Uint8Array,
  w: number,
  h: number,
  native: {
    width: number;
    height: number;
    exifOrientation?: number | null;
    alpha?: AlphaCovariates | null;
    /** EXIF Make and Model ({@link exifCamera}). */
    make?: string | null;
    model?: string | null;
  },
): Covariates {
  const n = w * h;
  const L = new Float64Array(n);
  let sumL = 0;
  let sumC = 0;
  let sumA = 0;
  let sumB = 0;
  let high = 0;
  let low = 0;
  let skin = 0;
  let sumSkinL = 0;
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
    if (inSkinRegion(l, a, b)) {
      skin++;
      sumSkinL += l;
    }
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
  const make = native.make ?? null;
  const model = native.model ?? null;
  const camera = [make, model].filter((s) => s !== null).join(" ") || null;
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
    skin: skin / n,
    skinL: skin > 0 ? sumSkinL / skin : null,
    camera,
    phone: isPhoneCamera(make, model),
    alpha: native.alpha ?? null,
  };
}

/**
 * Covariates of an encoded image, on the reference `image-loader.ts` builds:
 * the upright original capped to {@link REFERENCE_CAP} on the long edge with
 * Lanczos3, never enlarged. An image that stores alpha also gets its
 * {@link AlphaCovariates}: the two fractions on the stored pixels, the
 * silhouette on a square resample of the upright picture.
 */
export async function measureFile(bytes: Buffer): Promise<Covariates> {
  const meta = await sharp(bytes).metadata();
  const { width, height } = orientedSize(meta);
  if (width === 0 || height === 0) throw new Error("unreadable dimensions");
  const scale = Math.min(REFERENCE_CAP / width, REFERENCE_CAP / height, 1);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const { data } = await upright(bytes)
    .resize(w, h, { kernel: "lanczos3", fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const reference = new Uint8Array(data);
  let alpha: AlphaCovariates | null = null;
  if (meta.hasAlpha === true) {
    const stored = await sharp(bytes).ensureAlpha().raw().toBuffer();
    const square = await upright(bytes)
      .resize(REFERENCE_CAP, REFERENCE_CAP, { kernel: "lanczos3", fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer();
    alpha = {
      ...alphaFractions(new Uint8Array(stored)),
      silhouette: silhouetteOf(
        new Uint8Array(square),
        REFERENCE_CAP,
        REFERENCE_CAP,
      ),
    };
  }
  return covariatesOf(reference, w, h, {
    width,
    height,
    exifOrientation: meta.orientation ?? null,
    alpha,
    ...exifCamera(meta.exif),
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
  /** EXIF Software, which names an editor a file passed through. */
  software: string | null;
  dateTimeOriginal: string | null;
  categories: string[];
  /** Stored dimensions and byte size, as Commons records them. */
  width: number;
  height: number;
  size: number;
}

interface ImageInfoPage {
  title: string;
  missing?: string;
  imageinfo?: {
    url: string;
    descriptionurl: string;
    sha1: string;
    mime: string;
    width?: number;
    height?: number;
    size?: number;
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
      iiprop: "url|sha1|mime|size|extmetadata|metadata",
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
        make: exif.get("Make")?.trim() || null,
        model: exif.get("Model")?.trim() || null,
        software: exif.get("Software")?.trim() || null,
        dateTimeOriginal: stripHtml(ext.DateTimeOriginal?.value ?? "") || null,
        categories: (ext.Categories?.value ?? "")
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean),
        width: info.width ?? 0,
        height: info.height ?? 0,
        size: info.size ?? 0,
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

/**
 * Whether a candidate may be downloaded and measured, judged on what Commons
 * said about it: a file Commons does not describe (the reason `commonsFacts`
 * recorded), a licence {@link isFreeLicence} refuses, or a MIME type other
 * than JPEG or PNG is refused with its reason.
 */
export function admit(
  f: CommonsFacts | string | undefined,
): { facts: CommonsFacts } | { reason: string } {
  if (f === undefined) return { reason: "not asked" };
  if (typeof f === "string") return { reason: f };
  if (!isFreeLicence(f.licence)) {
    return { reason: `licence "${f.licence}" is not one the corpus admits` };
  }
  if (f.mime !== "image/jpeg" && f.mime !== "image/png") {
    return { reason: `${f.mime} is not JPEG or PNG` };
  }
  return { facts: f };
}

/**
 * Why downloaded bytes are refused, or null when their SHA-1 is the one
 * Commons records for the file.
 */
export function sha1Mismatch(
  bytes: Buffer,
  commonsSha1: string,
): string | null {
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  return sha1 === commonsSha1
    ? null
    : `downloaded bytes have SHA-1 ${sha1}, Commons records ${commonsSha1}`;
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
    const admitted = admit(facts.get(title));
    if ("reason" in admitted) {
      refused.push({ title, reason: admitted.reason });
      continue;
    }
    const f = admitted.facts;
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
    const mismatch = sha1Mismatch(bytes, f.sha1);
    if (mismatch !== null) {
      refused.push({ title, reason: mismatch });
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

// ─── holdout3: the seeded draw (#129) ───────────────────────────────────────
//
// The draw is part of the protocol, and was committed with it, before any
// candidate was measured: the queries, the admission rules, the order, the
// caps, the per-axis tests and quotas, and what happens when an axis runs
// short. `--draw-holdout3` runs it and writes the record; nothing here pins
// anything, builds an encoder or reads a result.

/** The SHA-256 a candidate's seeded position is: `"<seed>:" + title`, hex. */
export function holdout3OrderKey(title: string): string {
  return createHash("sha256")
    .update(`${HOLDOUT3_PROTOCOL.seed}:${title}`)
    .digest("hex");
}

/**
 * The Commons title (`File:Name with spaces.jpg`) of a pin's `source` page,
 * percent-decoded and with underscores as spaces — the form a Commons search
 * returns, so a candidate and a pin compare as equal strings. Null for a
 * source that is not a Commons file page.
 */
export function pinnedCommonsTitle(source: string): string | null {
  const m = /^https:\/\/commons\.wikimedia\.org\/wiki\/(.+)$/.exec(source);
  if (m?.[1] === undefined) return null;
  let t: string;
  try {
    t = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  t = t.replace(/_/g, " ");
  return t.startsWith("File:") ? t : null;
}

/** One Commons search, `srnamespace=6`, in Commons' own relevance order. */
interface DrawQuery {
  /** Short name, for the record. */
  name: string;
  query: string;
}

/** Which part of holdout3 an axis fills. */
type DrawPart = "photo" | "alpha" | "graphic";

/**
 * One axis of the draw: its own pool (the union of its queries' hits), its
 * test, and its quota, split into slots. A measured candidate the axis's
 * {@link DrawAxis.slot} maps to null fails the test; one whose slot is full is
 * passed over.
 */
interface DrawAxis {
  part: DrawPart;
  /** What a pin records as `drawnAs`. */
  name: string;
  /** The label segment after the part's seal. */
  stem: string;
  /** The test, in words, for the record. */
  test: string;
  queries: readonly DrawQuery[];
  /** At most this many picks attributed to one query. */
  perQuery: number;
  /** At most one pick per EXIF camera (Make and Model). */
  onePerCamera: boolean;
  /** Quota per slot; the axis's quota is their sum. */
  slots: Readonly<Record<string, number>>;
  slot: (c: Covariates, aspect: number) => string | null;
}

const P = HOLDOUT3_PROTOCOL;
const phoneQuery = (model: string): DrawQuery => ({
  name: model,
  query: `incategory:"Taken with ${model}" filemime:image/jpeg`,
});
const jpeg = (name: string, terms: string): DrawQuery => ({
  name,
  query: `filemime:image/jpeg ${terms}`,
});
const png = (name: string, terms: string): DrawQuery => ({
  name,
  query: `filemime:image/png ${terms}`,
});
const one =
  (slot: string, test: (c: Covariates, aspect: number) => boolean) =>
  (c: Covariates, aspect: number): string | null =>
    test(c, aspect) ? slot : null;

/** The alpha cuts, as #107 fixed them, with a gap on two axes. */
export function alphaCell(a: AlphaCovariates): string | null {
  const t = a.nonOpaqueFraction < 0.5 ? "opaque" : "transparent";
  const s = a.softAlphaFraction;
  const edge = s <= 0.01 ? "hard" : s >= 0.03 ? "soft" : null;
  const g = a.silhouette;
  const shape =
    g === null ? null : g <= 1.5 ? "simple" : g >= 2.0 ? "detailed" : null;
  return edge === null || shape === null ? null : `${t}/${edge}/${shape}`;
}

/** The skin axis's tone band, by the mean L* of the skin-region pixels. */
export function skinBand(skinL: number | null): string | null {
  if (skinL === null) return null;
  return skinL < 45 ? "dark" : skinL < 60 ? "medium" : "light";
}

const ALPHA_CELLS = [
  "opaque/hard/simple",
  "opaque/hard/detailed",
  "opaque/soft/simple",
  "opaque/soft/detailed",
  "transparent/hard/simple",
  "transparent/hard/detailed",
  "transparent/soft/simple",
  "transparent/soft/detailed",
] as const;

/**
 * The draw, in the order it runs. Axes run in list order, and an image one
 * axis takes is not considered by a later one. Photographic quotas sum to 48,
 * alpha to 24 (three per #107 cell), graphics to 16.
 */
export const HOLDOUT3_DRAW: readonly DrawAxis[] = [
  {
    part: "photo",
    name: "smartphone",
    stem: "phone",
    test: "EXIF Make and Model name a phone (isPhoneCamera), and EXIF Software names no desktop editor or stitcher",
    queries: [
      "iPhone 6",
      "iPhone 8",
      "iPhone 11",
      "iPhone 13 Pro",
      "iPhone SE (2nd generation)",
      "Samsung Galaxy S7",
      "Samsung Galaxy S8",
      "Samsung Galaxy S10",
      "Samsung Galaxy A52",
      "Google Pixel 3",
      "Google Pixel 6",
      "Xiaomi Mi 9",
      "Xiaomi Redmi Note 9 Pro",
      "OnePlus 6",
      "Huawei Mate 20 Pro",
      "Motorola Moto G7 Plus",
      "Nokia Lumia 1020",
      "Sony Xperia Z3",
      "Fairphone 3",
    ].map(phoneQuery),
    perQuery: 1,
    onePerCamera: true,
    slots: { phone: 10 },
    slot: one("phone", (c) => c.phone),
  },
  {
    part: "photo",
    name: "extreme aspect",
    stem: "pano",
    test: `long edge ÷ short edge ≥ ${P.aspectMin}`,
    queries: [
      jpeg("panoramic", 'incategory:"Panoramic photographs"'),
      jpeg("skyline", "filew:>6000 panorama skyline"),
      jpeg("city", "filew:>6000 panorama city"),
      jpeg("mountains", "filew:>6000 panorama mountains"),
      jpeg("beach", "filew:>6000 panorama beach"),
      jpeg("interior", "filew:>6000 panorama interior"),
    ],
    perQuery: 2,
    onePerCamera: false,
    slots: { pano: 8 },
    slot: one("pano", (_c, aspect) => aspect >= P.aspectMin),
  },
  {
    part: "photo",
    name: "low light",
    stem: "lowlight",
    test: `mean L* ≤ ${P.lowLightMeanL} or low-key fraction ≥ ${P.lowLightLowKey}`,
    queries: [
      jpeg("train-station", "night train station"),
      jpeg("fireworks", "fireworks"),
      jpeg("aurora", "aurora borealis"),
      jpeg("candlelit", "candlelit"),
      jpeg("cave", "cave interior"),
      jpeg("bridge", "illuminated bridge night"),
      jpeg("stars", "starry sky"),
    ],
    perQuery: 2,
    onePerCamera: false,
    slots: { lowlight: 9 },
    slot: one(
      "lowlight",
      (c) => c.meanL <= P.lowLightMeanL || c.lowKey >= P.lowLightLowKey,
    ),
  },
  {
    part: "photo",
    name: "skin",
    stem: "skin",
    test: `skin fraction ≥ ${P.skinMin}; three per tone band by the skin pixels' mean L* (dark < 45 ≤ medium < 60 ≤ light)`,
    queries: [
      "Senegal",
      "Ethiopia",
      "Uganda",
      "Bangladesh",
      "Indonesia",
      "Peru",
      "Brazil",
      "Vietnam",
      "Norway",
      "Ireland",
    ].map((place) => jpeg(place.toLowerCase(), `portrait ${place}`)),
    perQuery: 2,
    onePerCamera: false,
    slots: { dark: 3, medium: 3, light: 3 },
    slot: (c) => (c.skin >= P.skinMin ? skinBand(c.skinL) : null),
  },
  {
    part: "photo",
    name: "high key",
    stem: "highkey",
    test: "high-key fraction (L* ≥ 90) ≥ 0.35",
    queries: [
      jpeg("snow", "snow landscape sunny"),
      jpeg("sand", "white sand beach"),
      jpeg("studio", '"white background" studio'),
      jpeg("overexposed", "overexposed bright white"),
    ],
    perQuery: 2,
    onePerCamera: false,
    slots: { highkey: 4 },
    slot: one("highkey", (c) => c.highKey >= 0.35),
  },
  {
    part: "photo",
    name: "chroma floor",
    stem: "chroma",
    test: "mean C* ≤ 4",
    queries: [
      jpeg(
        "bw-buildings",
        'incategory:"Black and white photographs of buildings"',
      ),
      jpeg("bw-animals", 'incategory:"Black and white photographs of animals"'),
      jpeg("bw-streets", 'incategory:"Black and white photographs of streets"'),
      jpeg("mist", "mist morning lake"),
      jpeg("overcast-snow", "overcast snow field"),
    ],
    perQuery: 2,
    onePerCamera: false,
    slots: { chroma: 4 },
    slot: one("chroma", (c) => c.meanC <= 4),
  },
  {
    part: "photo",
    name: "daylight",
    stem: "daylight",
    test: "mean L* ≥ 35 and low-key fraction < 0.25",
    queries: [
      jpeg("park", "park summer"),
      jpeg("village", "village street daytime"),
      jpeg("garden", "garden flowers sunny"),
      jpeg("trail", "mountain hiking trail"),
    ],
    perQuery: 2,
    onePerCamera: false,
    slots: { daylight: 4 },
    slot: one("daylight", (c) => c.meanL >= 35 && c.lowKey < 0.25),
  },
  {
    part: "alpha",
    name: "alpha",
    stem: "cutout",
    test: "an alpha channel; non-opaque fraction 0.05–0.95; not animated; assigned to a #107 cell (non-opaque < 0.5 | ≥ 0.5; soft-alpha ≤ 0.01 | ≥ 0.03; silhouette ≤ 1.5 | ≥ 2.0), three per cell",
    queries: [
      png("objects", 'incategory:"Objects with transparent background"'),
      png("food", 'incategory:"Food on transparent background"'),
      png("cutout-photo", 'incategory:"Cut out photography"'),
      png("organisms", 'deepcat:"Organisms on transparent background"'),
      png("icons", 'incategory:"Icons with transparent background"'),
      png("planets", 'incategory:"Planets with transparent background"'),
      png("science", 'incategory:"Science images with transparent background"'),
      png("medical", 'incategory:"Medical images with transparent background"'),
      png(
        "ornaments",
        'incategory:"Graphic ornaments with transparent background"',
      ),
      png("kitchen", 'incategory:"Kitchen images with transparent background"'),
      png("gameart", 'incategory:"Media from OpenGameArt"'),
      png("plants", 'incategory:"Plants with transparent background"'),
      png("vehicles", 'incategory:"Vehicles with transparent background"'),
      png("clothing", 'incategory:"Clothing with transparent background"'),
      png("glow", 'glow "transparent background"'),
      png("smoke", 'smoke "transparent background"'),
      png("glass", 'glass "transparent background"'),
      png("hair", 'hair "transparent background"'),
      png("shadow", '"drop shadow" "transparent background"'),
    ],
    perQuery: 3,
    onePerCamera: false,
    slots: Object.fromEntries(ALPHA_CELLS.map((c) => [c, 3])),
    slot: (c) => {
      const a = c.alpha;
      if (a === null) return null;
      if (a.nonOpaqueFraction < 0.05 || a.nonOpaqueFraction > 0.95) {
        return null;
      }
      return alphaCell(a);
    },
  },
  ...(
    [
      [
        "screenshot",
        3,
        [
          png("free-software", 'screenshot "free software"'),
          png("website", "screenshot website"),
          png("ui", 'screenshot "user interface"'),
        ],
      ],
      [
        "chart",
        3,
        [
          png("bar", '"bar chart"'),
          png("line", '"line graph"'),
          png("pie", '"pie chart"'),
        ],
      ],
      [
        "map",
        3,
        [
          png("location", '"location map"'),
          png("topographic", '"topographic map"'),
          png("election", '"election results" map'),
        ],
      ],
      [
        "diagram",
        3,
        [
          png("block", '"block diagram"'),
          png("flowchart", "flowchart"),
          png("circuit", '"circuit diagram"'),
        ],
      ],
      [
        "comic",
        2,
        [
          png("strip", '"comic strip"'),
          png("webcomic", "webcomic"),
          jpeg("strip-jpeg", '"comic strip"'),
        ],
      ],
      [
        "text",
        2,
        [
          png("font", '"font sample"'),
          png("specimen", '"typeface specimen"'),
          png("infographic", "infographic"),
        ],
      ],
    ] as const
  ).map(
    ([name, quota, queries]): DrawAxis => ({
      part: "graphic",
      name,
      stem: name,
      test: "stores no transparency (no alpha channel, or none below 255); not animated",
      queries,
      perQuery: 2,
      onePerCamera: false,
      slots: { [name]: quota },
      slot: one(
        name,
        (c) => c.alpha === null || c.alpha.nonOpaqueFraction === 0,
      ),
    }),
  ),
];

/** Hits taken from each query, in Commons' relevance order. */
export const HOLDOUT3_POOL_PER_QUERY = 200;

/** A title or category naming a deleted, disputed or unfree file. */
const UNFREE =
  /deletion|copyright violation|copyvio|possibly unfree|fair use|non-free|unfree/i;
/** A title or category naming machine-generated content. */
const GENERATED =
  /\bAI[- ]generated|artificial intelligence|midjourney|stable diffusion|dall[-·]?e\b|generated by ai/i;
/** Categories that make a photograph something other than a camera's output. */
const NOT_A_PHOTO =
  /\b(paintings?|artworks?|drawings?|illustrations?|scans?|scanned|maps?|diagrams?|posters?|screenshots?|collages?|HDR|composites?|photomontages?|retouched|infographics?)\b/i;
/**
 * Titles or categories the alpha part refuses: the #107 list (the #83 lesson:
 * the deleted cut-out was a logo), and heraldry and insignia, whose
 * public-domain tags were the reason #107's LAPD patch was dropped.
 */
const NOT_A_CUTOUT =
  /\b(logos?|wordmarks?|trademarks?|signatures?|autographs?|screenshots?|diagrams?|charts?|maps?|insignias?|patch(es)?|seals?|coats? of arms|emblems?|badges?|flags?)\b/i;
/** Titles or categories the graphics part refuses. */
const NOT_A_GRAPHIC =
  /\b(logos?|wordmarks?|trademarks?|photographs?|scans?|scanned)\b/i;
/** EXIF Software naming a desktop editor or a panorama stitcher. */
const EDITOR =
  /photoshop|lightroom|gimp|capture one|darktable|affinity|luminar|dxo|rawtherapee|paint\.net|picasa|hugin|ptgui|microsoft ice|image composite editor/i;

/**
 * Why Commons' facts refuse a candidate for a part, or null when they admit
 * it. Applied before anything is downloaded, on top of {@link admit}.
 */
export function holdout3Admission(
  part: DrawPart,
  f: CommonsFacts,
  axis?: { onePerCamera: boolean },
): string | null {
  const words = [f.title, ...f.categories].join(" | ");
  const long = Math.max(f.width, f.height);
  if (f.author === "") return "Commons records no author";
  if (UNFREE.test(words)) return "a deletion or unfree category";
  if (GENERATED.test(words)) return "machine-generated";
  if (f.width * f.height > 100_000_000) return "over 100 MP";
  if (part === "photo") {
    if (f.mime !== "image/jpeg") return "not a JPEG";
    if (long < 2000) return "long edge under 2000 px";
    if (f.size > 50_000_000) return "over 50 MB";
    if (f.model === null) return "no EXIF camera model";
    if (NOT_A_PHOTO.test(words))
      return "an art, scan, map or composite category";
    if (axis?.onePerCamera === true && EDITOR.test(f.software ?? "")) {
      return "EXIF Software names an editor";
    }
    return null;
  }
  if (f.size > 25_000_000) return "over 25 MB";
  if (part === "alpha") {
    if (f.mime !== "image/png") return "not a PNG";
    if (long < 512) return "long edge under 512 px";
    if (NOT_A_CUTOUT.test(words)) return "a logo, insignia or graphic";
    return null;
  }
  if (long < 1000) return "long edge under 1000 px";
  if (f.model !== null) return "an EXIF camera model: a photograph";
  if (NOT_A_GRAPHIC.test(words)) return "a logo, photograph or scan";
  return null;
}

/** A label for a pick: the part's seal, the axis stem, and the title's first words. */
export function holdout3Label(
  part: DrawPart,
  stem: string,
  title: string,
  taken: ReadonlySet<string>,
): string {
  const seal =
    part === "alpha"
      ? ALPHA_HOLDOUT3_PREFIX
      : part === "graphic"
        ? `${GRAPHIC_HOLDOUT3_PREFIX}${stem}-`
        : `${HOLDOUT3_PREFIX}${stem}-`;
  const words = title
    .replace(/^File:/, "")
    .replace(/\.[^.]+$/, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  const base = `${seal}${words || holdout3OrderKey(title).slice(0, 8)}`;
  let label = base;
  for (let i = 2; taken.has(label); i++) label = `${base}-${i}`;
  return label;
}

/** One pick, with everything a pin needs. */
export interface Holdout3Pick extends Candidate {
  part: DrawPart;
  label: string;
  drawnAs: string;
  slot: string;
  query: string;
  orderKey: string;
  record: Holdout3Record;
}

async function commonsSearch(
  query: string,
): Promise<{ totalhits: number; titles: string[] }> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    list: "search",
    srnamespace: "6",
    srlimit: String(HOLDOUT3_POOL_PER_QUERY),
    srprop: "",
    srinfo: "totalhits",
    srsearch: query,
  });
  const response = await fetch(`${COMMONS_API}?${params}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new Error(`Commons answered HTTP ${response.status}`);
  const body = (await response.json()) as {
    query?: {
      searchinfo?: { totalhits: number };
      search?: { title: string }[];
    };
  };
  return {
    totalhits: body.query?.searchinfo?.totalhits ?? 0,
    titles: (body.query?.search ?? []).map((s) => s.title),
  };
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

async function runDrawHoldout3(outPath: string): Promise<void> {
  const pins = [
    ...CURATED_IMAGES.map((s) => ({
      source: s.source,
      sha256: s.sha256,
      author: s.author,
    })),
    ...ALPHA_IMAGES.map((s) => ({
      source: s.source,
      sha256: s.sha256,
      author: s.author,
    })),
    ...GRAPHIC_IMAGES.map((s) => ({
      source: s.source,
      sha256: s.sha256,
      author: s.author,
    })),
  ];
  const takenTitles = new Set(
    pins.map((p) => pinnedCommonsTitle(p.source)).filter((t) => t !== null),
  );
  const takenSha = new Set([...pins.map((p) => p.sha256), ...KODAK_SHA256]);
  const authorKey = (a: string): string => a.trim().toLowerCase();
  const takenAuthors = new Set(pins.map((p) => authorKey(p.author)));
  const labels = new Set<string>();
  const picks: Holdout3Pick[] = [];
  await fs.mkdir(CANDIDATE_DIR, { recursive: true });

  interface AxisState {
    axis: DrawAxis;
    pool: { title: string; query: string; key: string }[];
    cursor: number;
    filled: Map<string, number>;
    perQuery: Map<string, number>;
    cameras: Set<string>;
    refusals: Map<string, number>;
    queries: {
      name: string;
      query: string;
      totalhits: number;
      returned: number;
      attributed: number;
    }[];
    facts: Map<string, CommonsFacts | string>;
  }
  const states: AxisState[] = [];
  for (const axis of HOLDOUT3_DRAW) {
    const attributed = new Map<string, string>();
    const queries: AxisState["queries"] = [];
    for (const q of axis.queries) {
      const { totalhits, titles } = await commonsSearch(q.query);
      let mine = 0;
      for (const t of titles) {
        if (!attributed.has(t)) {
          attributed.set(t, q.name);
          mine++;
        }
      }
      queries.push({
        ...q,
        totalhits,
        returned: titles.length,
        attributed: mine,
      });
      console.error(
        `${axis.name} / ${q.name}: ${titles.length} of ${totalhits}`,
      );
    }
    states.push({
      axis,
      pool: [...attributed]
        .map(([title, query]) => ({
          title,
          query,
          key: holdout3OrderKey(title),
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      cursor: 0,
      filled: new Map(),
      perQuery: new Map(),
      cameras: new Set(),
      refusals: new Map(),
      queries,
      facts: new Map(),
    });
  }

  const refuse = (s: AxisState, reason: string): void => {
    s.refusals.set(reason, (s.refusals.get(reason) ?? 0) + 1);
  };
  const quota = (a: DrawAxis): number =>
    Object.values(a.slots).reduce((x, y) => x + y, 0);

  /** Walk one axis from its cursor until it takes one pick, or its pool ends. */
  async function takeOne(s: AxisState, liftSlots: boolean): Promise<boolean> {
    const { axis } = s;
    while (s.cursor < s.pool.length) {
      const entry = s.pool[s.cursor++];
      if (entry === undefined) break;
      const { title, query, key } = entry;
      if (takenTitles.has(title)) {
        refuse(s, "already pinned or picked");
        continue;
      }
      if ((s.perQuery.get(query) ?? 0) >= axis.perQuery) {
        refuse(s, "its query's cap is reached");
        continue;
      }
      if (!s.facts.has(title)) {
        const ahead = s.pool
          .slice(s.cursor - 1, s.cursor + 19)
          .map((e) => e.title)
          .filter((t) => !s.facts.has(t));
        for (const [t, f] of await commonsFacts(ahead)) s.facts.set(t, f);
      }
      const admitted = admit(s.facts.get(title));
      if ("reason" in admitted) {
        refuse(
          s,
          admitted.reason.startsWith("licence")
            ? "licence not admitted"
            : admitted.reason,
        );
        continue;
      }
      const f = admitted.facts;
      const why = holdout3Admission(axis.part, f, axis);
      if (why !== null) {
        refuse(s, why);
        continue;
      }
      if (takenAuthors.has(authorKey(f.author))) {
        refuse(s, "author already pinned or picked");
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
        try {
          bytes = await download(f.url);
        } catch (e) {
          refuse(s, "download failed");
          console.error(
            `download failed for ${title}: ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
        await fs.writeFile(file, bytes);
      }
      if (sha1Mismatch(bytes, f.sha1) !== null) {
        refuse(s, "SHA-1 differs from Commons'");
        continue;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (takenSha.has(sha256)) {
        refuse(s, "bytes already pinned or picked");
        continue;
      }
      let c: Covariates;
      let pages: number;
      try {
        pages = (await sharp(bytes).metadata()).pages ?? 1;
        c = await measureFile(bytes);
      } catch {
        refuse(s, "unreadable");
        continue;
      }
      if (pages > 1) {
        refuse(s, "animated");
        continue;
      }
      const aspect = Math.max(c.width, c.height) / Math.min(c.width, c.height);
      const slot = axis.slot(c, aspect);
      if (slot === null) {
        refuse(s, "fails the axis test");
        continue;
      }
      if (!liftSlots && (s.filled.get(slot) ?? 0) >= (axis.slots[slot] ?? 0)) {
        refuse(s, `slot ${slot} full`);
        continue;
      }
      if (axis.onePerCamera && c.camera !== null && s.cameras.has(c.camera)) {
        refuse(s, "camera already picked");
        continue;
      }
      const corpus = axis.part;
      const nonOpaqueFraction = c.alpha?.nonOpaqueFraction ?? 0;
      const record = {
        drawnAs:
          axis.name === "skin" || axis.part === "alpha"
            ? `${axis.name}: ${slot}`
            : axis.name,
        camera: c.camera,
        phone: c.phone,
        meanL: round4(c.meanL),
        lowKey: round4(c.lowKey),
        skin: round4(c.skin),
      };
      const label = holdout3Label(axis.part, axis.stem, title, labels);
      labels.add(label);
      takenTitles.add(title);
      takenSha.add(sha256);
      takenAuthors.add(authorKey(f.author));
      s.filled.set(slot, (s.filled.get(slot) ?? 0) + 1);
      s.perQuery.set(query, (s.perQuery.get(query) ?? 0) + 1);
      if (c.camera !== null) s.cameras.add(c.camera);
      picks.push({
        ...f,
        sha256,
        covariates: c,
        part: axis.part,
        label,
        drawnAs: axis.name,
        slot,
        query,
        orderKey: key,
        record: {
          ...record,
          strata: holdout3Strata({
            corpus,
            width: c.width,
            height: c.height,
            nonOpaqueFraction: round4(nonOpaqueFraction),
            phone: record.phone,
            meanL: record.meanL,
            lowKey: record.lowKey,
            skin: record.skin,
          }),
        },
      });
      console.error(`picked ${label} (${axis.name}: ${slot}) ← ${title}`);
      return true;
    }
    return false;
  }

  for (const s of states) {
    const q = quota(s.axis);
    let n = 0;
    while (n < q && (await takeOne(s, false))) n++;
  }
  // A part that ends short walks its axes again, in list order, one pick per
  // axis per round, slot quotas lifted, until it is full or every pool ends.
  const shortfalls: string[] = [];
  for (const part of ["photo", "alpha", "graphic"] as const) {
    const size = P.sizes[part];
    const mine = states.filter((s) => s.axis.part === part);
    let progress = true;
    while (picks.filter((p) => p.part === part).length < size && progress) {
      progress = false;
      for (const s of mine) {
        if (picks.filter((p) => p.part === part).length >= size) break;
        if (await takeOne(s, true)) {
          progress = true;
          shortfalls.push(
            `${part} was short: ${picks.at(-1)?.label} taken by ${s.axis.name} with its slot quotas lifted`,
          );
        }
      }
    }
  }
  const strata = Object.fromEntries(
    HOLDOUT3_STRATA.map((st) => [
      st,
      picks.filter((p) => p.record.strata.includes(st)).length,
    ]),
  );
  const record = {
    protocol: P,
    drawnAt: new Date().toISOString(),
    poolPerQuery: HOLDOUT3_POOL_PER_QUERY,
    axes: states.map((s) => ({
      part: s.axis.part,
      name: s.axis.name,
      test: s.axis.test,
      slots: s.axis.slots,
      queries: s.queries,
      pool: s.pool.length,
      consumed: s.cursor,
      refusals: Object.fromEntries(s.refusals),
      picks: picks.filter((p) => p.drawnAs === s.axis.name).map((p) => p.label),
    })),
    sizes: {
      photo: picks.filter((p) => p.part === "photo").length,
      alpha: picks.filter((p) => p.part === "alpha").length,
      graphic: picks.filter((p) => p.part === "graphic").length,
    },
    strata,
    shortfalls,
    picks,
  };
  await fs.writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`);
  console.error(
    `${picks.length} picked; sizes ${JSON.stringify(record.sizes)}; strata ${JSON.stringify(strata)}`,
  );
  const short = (["photo", "alpha", "graphic"] as const).filter(
    (p) => record.sizes[p] < P.sizes[p],
  );
  const thin = HOLDOUT3_STRATA.filter((st) => (strata[st] ?? 0) < P.strataMin);
  if (short.length > 0 || thin.length > 0) {
    console.error(
      `the draw does not meet the protocol: short parts ${short.join(", ") || "none"}; thin strata ${thin.join(", ") || "none"}`,
    );
    process.exit(1);
  }
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
      "draw-holdout3": { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  if (values.commons !== undefined) {
    await runCommons(values.commons, values.out);
  } else if (values.files && positionals.length > 0) {
    await runFiles(positionals);
  } else if (values["draw-holdout3"] && values.out !== undefined) {
    await runDrawHoldout3(values.out);
  } else {
    console.error(
      "Usage: corpus-covariates.js --commons <titles.txt> [--out <file.json>] | --files <image>... | --draw-holdout3 --out <file.json>",
    );
    process.exit(1);
  }
}
