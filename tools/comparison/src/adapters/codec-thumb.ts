import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { FormatAdapter, FormatResult, ImageInput } from "../types.ts";
import { rgbaToDataUri } from "../image-loader.ts";
import { ALPHA_BACKDROP, computeAllMetrics } from "../metrics.ts";
import {
  BudgetUnrepresentableError,
  findCodecVariantForBudget,
  QUALITY_MIN,
} from "../rd/byte-target.ts";

/** Codecs the equal-byte baseline can target. */
export type ThumbCodec = "webp" | "avif" | "jpeg" | "jxl";

const CODEC_LABEL: Record<ThumbCodec, string> = {
  webp: "WebP",
  avif: "AVIF",
  jpeg: "JPEG",
  jxl: "JXL",
};

/** Subprocess timeout for the cjxl/djxl CLI tools. */
const JXL_TIMEOUT_MS = 60_000;

/** The encoder input downscaled to one ladder dimension, as raw pixels. */
interface ResizedInput {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

/**
 * Per-image memos, keyed on the encoder input's buffer identity so an entry is
 * collectable as soon as the image is. Shared across every `CodecThumbAdapter`
 * instance deliberately — the six the report builds probe overlapping
 * `(dimension, quality)` pairs, and that overlap is most of the duplicated work.
 * See {@link CodecThumbAdapter.encodeAt}.
 */
const resizedInputs = new WeakMap<Uint8Array, Map<number, ResizedInput>>();
const encodedVariants = new WeakMap<Uint8Array, Map<string, Buffer>>();

/** Fetch (or create) the per-image memo bucket for `key`. */
function perImage<K, V>(
  store: WeakMap<Uint8Array, Map<K, V>>,
  key: Uint8Array,
): Map<K, V> {
  let bucket = store.get(key);
  if (!bucket) {
    bucket = new Map();
    store.set(key, bucket);
  }
  return bucket;
}

/**
 * Whether the system `cjxl`/`djxl` CLIs are on PATH. sharp has no JXL support,
 * so the JXL baseline shells out; callers skip constructing the adapter when
 * this returns false.
 */
export function isJxlAvailable(): boolean {
  for (const tool of ["cjxl", "djxl"]) {
    try {
      execFileSync(tool, ["--version"], {
        encoding: "utf8",
        timeout: JXL_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The absolute paths `cjxl` and `djxl` resolve to on PATH, in the order
 * `execFileSync` searches it, so a run's provenance can hash the binaries it
 * will execute. A tool that does not resolve is returned by bare name, which
 * the provenance records as `missing`.
 */
export function jxlToolPaths(): string[] {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return ["cjxl", "djxl"].map((tool) => {
    for (const dir of dirs) {
      const candidate = path.resolve(dir, tool);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here; keep searching.
      }
    }
    return tool;
  });
}

/** Run cjxl on a PNG buffer, returning the encoded JXL bytes. */
function cjxlEncode(png: Buffer, quality: number): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "chromahash-jxl-"));
  try {
    const inPath = path.join(dir, "in.png");
    const outPath = path.join(dir, "out.jxl");
    writeFileSync(inPath, png);
    execFileSync("cjxl", [inPath, outPath, "-q", String(quality), "--quiet"], {
      timeout: JXL_TIMEOUT_MS,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return readFileSync(outPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run djxl on JXL bytes, returning the decoded PNG bytes. */
function djxlDecode(jxl: Buffer): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "chromahash-jxl-"));
  try {
    const inPath = path.join(dir, "in.jxl");
    const outPath = path.join(dir, "out.png");
    writeFileSync(inPath, jxl);
    execFileSync("djxl", [inPath, outPath, "--quiet"], {
      timeout: JXL_TIMEOUT_MS,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return readFileSync(outPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Equal-byte codec baseline: "what if the placeholder were just a tiny WebP /
 * JPEG / AVIF / JXL file?" For a byte target, the ≤100px encoder input is
 * downscaled (Lanczos-3) across a dimension ladder and the encoder quality is
 * binary-searched per dimension for the largest encoding that fits; the best
 * fitting variant by ΔE00 becomes this format's result (see rd/byte-target.ts).
 * The reported size is the actual file bytes — container overhead included,
 * which is exactly the point of the comparison.
 */
export class CodecThumbAdapter implements FormatAdapter {
  readonly name: string;
  private readonly codec: ThumbCodec;
  private readonly targetBytes: number;
  private readonly floorFallback: boolean;

  /**
   * @param floorFallback When the budget is unrepresentable, encode at the
   *   codec's smallest possible output instead of failing. At LQIP budgets this
   *   is the *interesting* answer rather than an error: no real codec reaches
   *   32 bytes (AVIF's floor is ~465 B), and a column of N/A says that far less
   *   clearly than a row showing what the smallest possible AVIF actually
   *   scores. The row's mean-size column then reports the real byte count, so
   *   the comparison stays honest about not being equal-budget.
   */
  constructor(codec: ThumbCodec, targetBytes: number, floorFallback = false) {
    this.codec = codec;
    this.targetBytes = targetBytes;
    this.floorFallback = floorFallback;
    // `(min)` is only truthful when the budget is genuinely unreachable for
    // this codec, which the caller decides — see `main.ts`. Enabling the
    // fallback at a budget the codec *can* hit would label an equal-budget
    // result as a floor.
    this.name = floorFallback
      ? `${CODEC_LABEL[codec]} (min)`
      : `${CODEC_LABEL[codec]}@${targetBytes}B`;
  }

  /**
   * Downscale the encoder input to `longEdge` and encode it at `quality`.
   *
   * Both halves are memoized on the encoder input's buffer identity, which is
   * stable for the life of one image and lets the WeakMap drop the entry when
   * the image goes out of scope. Two distinct wins, both measured:
   *
   * - **The resize**, once per `longEdge` instead of once per encode. A quality
   *   binary search probes ~8 qualities per rung and re-ran the Lanczos every
   *   time.
   * - **The encode**, once per `(codec, longEdge, quality)`. `main.ts` builds
   *   six `CodecThumbAdapter`s that share a dimension ladder and all probe
   *   `q=1`, `q=100` and `q=50` at every rung, so 64 of 202 encodes per image
   *   were byte-identical repeats of one another's work. The floor-fallback
   *   path alone encoded `(4, QUALITY_MIN)` three times.
   */
  private async encodeAt(
    input: ImageInput,
    longEdge: number,
    quality: number,
  ): Promise<Buffer> {
    const cacheKey = `${this.codec}:${longEdge}:${quality}`;
    const encodes = perImage(encodedVariants, input.smallRgba);
    const cached = encodes.get(cacheKey);
    if (cached) return cached;

    const resized = await this.resizeTo(input, longEdge);
    const pipeline = sharp(resized.data, {
      raw: {
        width: resized.width,
        height: resized.height,
        channels: resized.channels,
      },
    });
    const encoded = await this.encodePipeline(pipeline, quality);
    encodes.set(cacheKey, encoded);
    return encoded;
  }

  /** The encoder input downscaled to `longEdge`, memoized per image. */
  private async resizeTo(
    input: ImageInput,
    longEdge: number,
  ): Promise<ResizedInput> {
    const resizes = perImage(resizedInputs, input.smallRgba);
    const hit = resizes.get(longEdge);
    if (hit) return hit;
    const { data, info } = await sharp(Buffer.from(input.smallRgba), {
      raw: { width: input.smallWidth, height: input.smallHeight, channels: 4 },
    })
      .resize(longEdge, longEdge, { fit: "inside", kernel: "lanczos3" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const built = {
      data,
      width: info.width,
      height: info.height,
      channels: info.channels,
    };
    resizes.set(longEdge, built);
    return built;
  }

  /** Encode an already-resized pipeline at `quality`. */
  private async encodePipeline(
    pipeline: sharp.Sharp,
    quality: number,
  ): Promise<Buffer> {
    switch (this.codec) {
      case "webp":
        return pipeline.webp({ quality }).toBuffer();
      case "avif":
        return pipeline.avif({ quality }).toBuffer();
      case "jpeg": {
        // JPEG has no alpha; flatten over the scoring backdrop rather than
        // sharp's default black so alpha semantics match the metrics.
        const flattened = pipeline.flatten({
          background: {
            r: ALPHA_BACKDROP[0],
            g: ALPHA_BACKDROP[1],
            b: ALPHA_BACKDROP[2],
          },
        });
        return flattened.jpeg({ quality, mozjpeg: true }).toBuffer();
      }
      case "jxl": {
        const png = await pipeline.png().toBuffer();
        return cjxlEncode(png, quality);
      }
    }
  }

  /** Decode encoded bytes back to RGBA. */
  private async decode(
    data: Buffer,
  ): Promise<{ rgba: Uint8Array; width: number; height: number }> {
    const bytes = this.codec === "jxl" ? djxlDecode(data) : data;
    const { data: raw, info } = await sharp(bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      rgba: new Uint8Array(raw),
      width: info.width,
      height: info.height,
    };
  }

  async process(input: ImageInput): Promise<FormatResult> {
    const reference = input.metricReferenceRgba ?? input.referenceRgba;
    const maxLongEdge = Math.max(input.smallWidth, input.smallHeight);
    const encodeAt = (longEdge: number, quality: number) =>
      this.encodeAt(input, longEdge, quality);

    let chosen = await findCodecVariantForBudget(encodeAt, this.targetBytes, {
      decode: (data) => this.decode(data),
      referenceRgba: reference,
      referenceWidth: input.referenceWidth,
      referenceHeight: input.referenceHeight,
      maxLongEdge,
    });
    if (chosen === null && this.floorFallback) {
      // Re-target the search at the codec's actual floor: the smallest rung of
      // the dimension ladder at minimum quality. Passing an unbounded budget
      // instead would make `maxQualityWithinBudget` short-circuit to
      // QUALITY_MAX and return the *largest* output at that size — the opposite
      // of a floor, and 2.5x too big in practice.
      const floorLongEdge = Math.min(4, maxLongEdge);
      const floorBytes = (await encodeAt(floorLongEdge, QUALITY_MIN)).length;
      chosen = await findCodecVariantForBudget(encodeAt, floorBytes, {
        maxLongEdge,
        referenceRgba: reference,
        referenceWidth: input.referenceWidth,
        referenceHeight: input.referenceHeight,
        decode: (buf) => this.decode(buf),
        dimLadder: [floorLongEdge],
      });
    }
    if (chosen === null) {
      // Report the codec's byte floor so the failure message is diagnostic.
      const floor = (await encodeAt(Math.min(4, maxLongEdge), QUALITY_MIN))
        .length;
      throw new BudgetUnrepresentableError(this.name, this.targetBytes, floor);
    }

    // The search ranks on ΔE00 alone (see RANKING_METRICS), so the winner is
    // the only variant that gets the full metric set — including the blurred
    // pass and ringing, which the report displays and the search skipped.
    const scores = await computeAllMetrics(
      reference,
      input.referenceWidth,
      input.referenceHeight,
      chosen.decodedRgba,
      chosen.decodedWidth,
      chosen.decodedHeight,
    );

    const dataUri = await rgbaToDataUri(
      chosen.decodedRgba,
      chosen.decodedWidth,
      chosen.decodedHeight,
    );

    return {
      formatName: this.name,
      encodedSizeBytes: chosen.data.length,
      decodedWidth: chosen.decodedWidth,
      decodedHeight: chosen.decodedHeight,
      // A real codec bitstream carries its dimensions; the byte-target search
      // picked this resolution, and the file states it.
      intrinsicSize: {
        kind: "declared",
        width: chosen.decodedWidth,
        height: chosen.decodedHeight,
      },
      dataUri,
      ...scores,
    };
  }
}
