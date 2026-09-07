import { execFileSync } from "node:child_process";
import path from "node:path";
import { rgbaToDataUri } from "../image-loader.ts";
import { computeAllMetrics } from "../metrics.ts";
import type { FormatAdapter, FormatResult, ImageInput } from "../types.ts";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
// Release build: published timings must not measure debug-profile overhead.
// Exported for the sweep runner and codebook trainer, which drive the same
// binary with CHROMAHASH_TUNE overrides.
export const RUST_CLI = path.join(
  ROOT,
  "rust/target/release/examples/encode_stdin",
);

const GAMUT_MAP: Record<string, string> = {
  srgb: "srgb",
  displayp3: "displayp3",
  adobergb: "adobergb",
  bt2020: "bt2020",
  prophoto: "prophoto",
};

/** Env for a chromahash subprocess: quality tier + optional TUNE overrides. */
function rustEnv(tier: number, tune?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHROMAHASH_TIER: String(tier),
  };
  // Never inherit a stray TUNE from the shell — a silent override would
  // corrupt every non-sweep result. (undefined-valued keys are dropped by
  // child_process.)
  env.CHROMAHASH_TUNE = tune;
  return env;
}

export function encodeViaRust(
  binary: string,
  w: number,
  h: number,
  rgba: Uint8Array,
  gamut: string,
  tier: number,
  tune?: string,
): Uint8Array {
  const output = execFileSync(binary, ["encode", String(w), String(h), gamut], {
    input: Buffer.from(rgba),
    encoding: "buffer",
    timeout: 30_000,
    // The quality tier is read from the environment (decode recovers it from the
    // hash, so only encode needs it).
    env: rustEnv(tier, tune),
  });
  return new Uint8Array(output);
}

/**
 * Dump the encoder's scale-normalized AC coefficients per channel group
 * (`dump-coeffs` subcommand). Used by the codebook trainer on the tune split.
 */
export function dumpCoefficientsViaRust(
  binary: string,
  w: number,
  h: number,
  rgba: Uint8Array,
  gamut: string,
  tier: number,
): { l: number[]; a: number[]; b: number[]; alpha: number[] } {
  const output = execFileSync(
    binary,
    ["dump-coeffs", String(w), String(h), gamut],
    {
      input: Buffer.from(rgba),
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: rustEnv(tier),
    },
  );
  const dump: { l: number[]; a: number[]; b: number[]; alpha: number[] } = {
    l: [],
    a: [],
    b: [],
    alpha: [],
  };
  for (const line of output.split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    const group = line.slice(0, space) as keyof typeof dump;
    const value = Number.parseFloat(line.slice(space + 1));
    if (dump[group] && Number.isFinite(value)) {
      dump[group].push(value);
    }
  }
  return dump;
}

/**
 * Display gamuts ChromaHash can decode *to*, paired with the named ICC profile
 * to tag the preview with so a color-managed viewer renders it correctly.
 * sharp ships sRGB and P3 profiles; other source gamuts (Adobe RGB, BT.2020,
 * ProPhoto) preview in sRGB — the decoder falls back to sRGB for them anyway.
 */
const PREVIEW_OUTPUT: Record<string, { out: string; icc?: string }> = {
  displayp3: { out: "displayp3", icc: "p3" },
};

export function decodeViaRust(
  binary: string,
  hash: Uint8Array,
  outGamut: string,
  maxW?: number,
  maxH?: number,
  tune?: string,
): {
  w: number;
  h: number;
  rgba: Uint8Array;
} {
  const extraArgs =
    maxW !== undefined && maxH !== undefined
      ? [String(maxW), String(maxH)]
      : [];
  const output = execFileSync(binary, ["decode", ...extraArgs], {
    input: Buffer.from(hash),
    encoding: "buffer",
    timeout: 30_000,
    env: { ...rustEnv(0, tune), CHROMAHASH_OUT: outGamut },
  });
  const newline = output.indexOf(0x0a);
  const header = output.subarray(0, newline).toString("ascii");
  const parts = header.split(" ");
  const w = Number.parseInt(parts[0] ?? "0", 10);
  const h = Number.parseInt(parts[1] ?? "0", 10);
  const rgba = new Uint8Array(output.subarray(newline + 1));
  return { w, h, rgba };
}

/**
 * Render a hash at an exact raster, above or below its natural one.
 *
 * This is the `render` subcommand of the `encode_stdin` example, gated on the
 * core's `research-render` feature. Every other decode path in this file goes
 * through `decode`, which renders at the natural raster or caps below it and
 * cannot go up.
 */
function renderViaRust(
  binary: string,
  hash: Uint8Array,
  outGamut: string,
  width: number,
  height: number,
  tune?: string,
): { w: number; h: number; rgba: Uint8Array } {
  const output = execFileSync(
    binary,
    ["render", String(width), String(height)],
    {
      input: Buffer.from(hash),
      encoding: "buffer",
      // A render at display resolution is O(w·h·K) — ~256x the per-pixel work of
      // a 32 px natural raster — so it needs materially more headroom than the
      // 30 s the natural-raster decodes run under.
      timeout: 120_000,
      // Node's default is exactly 1 MiB, and this is the first call here that
      // emits a *display-resolution* raster: `decodeViaRust` is bounded by the
      // natural raster (<=256 px at tier 4, ~262 KB) but this one is
      // `refW*refH*4 + header`. At REFERENCE_CAP = 512 a square source lands on
      // 1048584 bytes and throws ENOBUFS. No fixture trips it today — the
      // largest is 989192 bytes, 6% short — so one square photograph added to
      // the corpus, or any raise of REFERENCE_CAP, would break the report.
      maxBuffer: 64 * 1024 * 1024,
      env: { ...rustEnv(0, tune), CHROMAHASH_OUT: outGamut },
    },
  );
  const newline = output.indexOf(0x0a);
  const parts = output.subarray(0, newline).toString("ascii").split(" ");
  return {
    w: Number.parseInt(parts[0] ?? "0", 10),
    h: Number.parseInt(parts[1] ?? "0", 10),
    rgba: new Uint8Array(output.subarray(newline + 1)),
  };
}

/**
 * Whether a given binary understands `render`.
 *
 * Not every binary this harness drives does: released tags predate the
 * subcommand entirely (`--versions` mode builds v0.2…v0.6), and a working-tree
 * build without `research-render` omits it. Probed once per binary rather than
 * assumed, so a missing subcommand degrades the native-render row to "skipped"
 * instead of aborting a whole report.
 */
const rendersAtSize = new Map<string, boolean>();

export function supportsRender(binary: string = RUST_CLI): boolean {
  const hit = rendersAtSize.get(binary);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    // `render` with no dimensions exits non-zero with a usage line; an *unknown*
    // subcommand hits the same path. The two are told apart by the banner, which
    // only lists `render` when the feature is compiled in.
    execFileSync(binary, ["--help"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const banner = String((err as { stderr?: Buffer | string }).stderr ?? "");
    ok = banner.includes("encode_stdin render");
  }
  rendersAtSize.set(binary, ok);
  return ok;
}

export class ChromaHashAdapter implements FormatAdapter {
  readonly name: string;
  /** The `encode_stdin` binary used to both encode and decode. */
  private readonly binaryPath: string;
  /** Cap the decode to source dims (true), or decode uncapped (false). */
  private readonly capToSource: boolean;
  /** Quality tier (0..=3); higher tiers carry more detail in more bytes. */
  private readonly tier: number;
  /**
   * Render at the display-resolution reference instead of decoding at the
   * natural raster and letting `upscale.ts` enlarge it.
   *
   * The two are genuinely different pictures, and the difference is the whole
   * question. The shipped path samples the format's continuous cosine
   * reconstruction at 32 px and hands those samples to a resampler, which
   * interpolates between them — and overshoots a step edge by ~7% doing it. This
   * path samples the same reconstruction densely instead. Nothing else in the
   * harness has ever measured it, because until `research-render` no API could
   * ask for it.
   *
   * Added as an extra operating point, never as a replacement: every
   * cross-format number in this report goes through one shared upscale, and a
   * format scored through a path the others cannot use would not be comparable
   * to them.
   */
  private readonly renderAtReference: boolean;
  /** Time via in-process bench subcommands (true) or spawn loops (false). */

  /**
   * @param opts.name        Display name (default "ChromaHash").
   * @param opts.binaryPath  Version-specific `encode_stdin` binary (default: the
   *   working tree's release build). A version must encode and decode with the same
   *   binary — hashes are not portable across format versions (header bit 47).
   * @param opts.capToSource Cap decode to source dims (default true). The version
   *   report decodes uncapped (false) so every build is framed identically — the
   *   oldest tags lack capped-decode support, and metrics resample to source anyway.
   */
  constructor(opts?: {
    name?: string;
    binaryPath?: string;
    capToSource?: boolean;
    tier?: number;
    renderAtReference?: boolean;
  }) {
    this.name = opts?.name ?? "ChromaHash";
    this.binaryPath = opts?.binaryPath ?? RUST_CLI;
    this.capToSource = opts?.capToSource ?? true;
    this.tier = opts?.tier ?? 0;
    this.renderAtReference = opts?.renderAtReference ?? false;
  }

  async process(input: ImageInput): Promise<FormatResult> {
    const { smallWidth: w, smallHeight: h, smallRgba: rgba } = input;
    const gamut = GAMUT_MAP[input.gamut ?? "srgb"] ?? "srgb";
    const bin = this.binaryPath;

    // Encode once to get the result bytes, then time the operation.
    const encoded = encodeViaRust(bin, w, h, rgba, gamut, this.tier);

    const encodedSizeBytes = encoded.length;

    // Decode capped to the encoder-input dims (never upscaling past the source,
    // and never synthesising detail beyond it); `computeAllMetrics` upscales
    // every format's decode to the display-resolution reference for scoring.
    const capW = this.capToSource ? w : undefined;
    const capH = this.capToSource ? h : undefined;
    // Metrics are always scored in sRGB against the color-managed sRGB reference,
    // so the cross-format comparison stays apples-to-apples.
    //
    // The native-render row asks the format for the reference raster directly,
    // which makes the shared upscale a no-op for this row alone. That is exactly
    // what it is for: it isolates how much of a placeholder's visible texture is
    // the reconstruction and how much is the resampler standing in for it.
    if (this.renderAtReference && !supportsRender(bin)) {
      // Falling back to a plain decode here would emit a row byte-identical to
      // the tier row beside it, under a name claiming it is something else --
      // a duplicate presented as a comparison. The lineup is supposed to have
      // filtered this adapter out (see main.ts); if it did not, say so rather
      // than publish the duplicate.
      throw new Error(
        `${this.name}: ${bin} has no \`render\` subcommand, so it cannot render at the reference raster. Rebuild with \`--features research-render\`, or drop this row from the lineup.`,
      );
    }
    const native = this.renderAtReference;
    const decoded = native
      ? renderViaRust(
          bin,
          encoded,
          "srgb",
          input.referenceWidth,
          input.referenceHeight,
        )
      : decodeViaRust(bin, encoded, "srgb", capW, capH);
    const capArgs =
      capW !== undefined && capH !== undefined
        ? [String(capW), String(capH)]
        : [];

    const { w: dw, h: dh, rgba: decodedRgba } = decoded;

    // The size ChromaHash *declares*, which is not necessarily the size decoded
    // above. `decode_capped_to_with` caps per axis (`nat_w.min(max_w)`), so once
    // the natural grid exceeds the encoder input the decode reports the cap --
    // i.e. this harness's own downscale of the source. On a 3:2 photo the t3 and
    // t4 columns come back as the input's 100x67 rather than the format's shape,
    // and an aspect error derived from that would read ~0 for precisely the
    // tiers whose layout precision is being questioned.
    //
    // A second, uncapped decode is the honest source. It is only needed when
    // capping could have bitten: if both decoded edges came in strictly under
    // the cap, neither `min` bound and the decode already is the natural size.
    // That short-circuit skips the extra spawn for the low tiers, which is most
    // of the lineup.
    //
    // Asking the binary rather than reimplementing `decodeOutputSize` in TS
    // keeps the Rust core the single source of truth, as `gamut.ts` and
    // `iqa.ts` already do -- and `decode` with no cap args is a subcommand every
    // released tag understands, so `--versions` mode keeps working.
    //
    // The native row always needs the second call: `dw` is the *reference*
    // width, so `dw >= capW` is trivially true and the short-circuit below can
    // never fire for it. More importantly it would be wrong to skip — the
    // declared shape is a property of the hash, not of the raster this row
    // happened to ask for, and taking `decoded` here would report the reference
    // dimensions as the format's declared size and read a false 0 aspect error.
    const cappedOut =
      native ||
      (capW !== undefined && capH !== undefined && (dw >= capW || dh >= capH));
    const natural = cappedOut ? decodeViaRust(bin, encoded, "srgb") : decoded;

    // Preview: decode to the source display gamut where ChromaHash supports it
    // (Display P3), and tag it with that ICC profile so a wide-gamut viewer shows
    // the true saturated color. Other gamuts preview in sRGB (decoder fallback).
    const preview = PREVIEW_OUTPUT[gamut];
    const previewDecode = preview
      ? native
        ? renderViaRust(
            bin,
            encoded,
            preview.out,
            input.referenceWidth,
            input.referenceHeight,
          )
        : decodeViaRust(bin, encoded, preview.out, capW, capH)
      : decoded;
    const dataUri = await rgbaToDataUri(
      previewDecode.rgba,
      previewDecode.w,
      previewDecode.h,
      preview?.icc,
    );

    const reference = input.metricReferenceRgba ?? input.referenceRgba;
    const scores = await computeAllMetrics(
      reference,
      input.referenceWidth,
      input.referenceHeight,
      decodedRgba,
      dw,
      dh,
    );

    return {
      formatName: this.name,
      encodedSizeBytes,
      decodedWidth: dw,
      decodedHeight: dh,
      dataUri,
      ...scores,
      intrinsicSize: { kind: "declared", width: natural.w, height: natural.h },
    };
  }
}
