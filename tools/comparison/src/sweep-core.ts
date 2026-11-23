/**
 * The pure checks `sweep.ts` applies to its inputs and hashes, split out of
 * the CLI because `sweep.ts` runs at module scope: importing it to assert
 * these would start a sweep. Each is asserted in `metric-selftest.ts`.
 */

import { createHash } from "node:crypto";
import { tierFor } from "./corpus.ts";

/** The byte lengths one tier's hashes must have, by alpha mode. */
export interface TierBytes {
  opaque: number;
  alpha: number;
}

/** A sweep config's `expectBytes`: one mean for every arm, or a length per tier. */
export type ExpectBytes = number | Record<string, TierBytes>;

/**
 * The byte length `hash` must have under a per-tier `expectBytes`, read off
 * its own alpha flag (byte 0, bit 6), or null when the config sets none or
 * sets the single-mean form, which is checked on the arm's mean instead.
 * Throws for a tier the map does not name.
 */
export function expectedLength(
  expect: ExpectBytes | undefined,
  tier: number,
  hash: Uint8Array,
): number | null {
  if (expect === undefined || typeof expect === "number") return null;
  const lengths = expect[String(tier)];
  if (!lengths) {
    throw new Error(`expectBytes names no length for tier ${tier}`);
  }
  return ((hash[0] ?? 0) >> 6) & 1 ? lengths.alpha : lengths.opaque;
}

/**
 * `realOnly`'s filter: the inputs whose image is real content
 * (`corpus.ts` `tierFor`), dropping the generated capability fixtures.
 */
export function realOnlyInputs<T>(
  inputs: readonly T[],
  nameOf: (input: T) => string,
): T[] {
  return inputs.filter((i) => tierFor(nameOf(i)) === "real");
}

/**
 * The digest a variant's `identicalTo` check compares: the decode's raster
 * size and every RGBA byte, so two decodes share a digest exactly when they
 * are the same pixels at the same size.
 */
export function decodeDigest(w: number, h: number, rgba: Uint8Array): string {
  return createHash("sha256").update(`${w}x${h}:`).update(rgba).digest("hex");
}

/**
 * The images whose decode digest differs between a variant and the earlier
 * variant its `identicalTo` names, by name, in corpus order. Empty when every
 * image decodes to the same pixels. Throws when the two did not score the
 * same images, which no run should produce.
 */
export function identityMismatches(
  reference: readonly string[],
  got: readonly string[],
  names: readonly string[],
): string[] {
  if (reference.length !== got.length || got.length !== names.length) {
    throw new Error(
      `identicalTo compares ${got.length} decodes against ${reference.length}, over ${names.length} images`,
    );
  }
  return names.filter((_, i) => reference[i] !== got[i]);
}

/**
 * Refuse a config whose `identicalTo` names no earlier variant, or names an
 * earlier variant that is itself an identity arm (a chain), so a misspelt
 * label fails before the first encode rather than hours in.
 */
export function checkIdenticalTo(
  variants: readonly { label: string; identicalTo?: string }[],
  configName: string,
): void {
  for (const [i, v] of variants.entries()) {
    if (v.identicalTo === undefined) continue;
    const target = variants.slice(0, i).find((e) => e.label === v.identicalTo);
    if (!target || target.identicalTo !== undefined) {
      throw new Error(
        `variant "${v.label}" is identicalTo "${v.identicalTo}", which is no earlier scored variant of ${configName}`,
      );
    }
  }
}

/**
 * Refuses a native-source config (`encodeSource: "native"`) that asks for
 * something only the harness raster has: `forceOpaque` flattens that raster,
 * and an arm's `capToTier0` or `version` acts on it. Any other config passes.
 * Run before the corpus loads, so a refused config fails before any encode.
 */
export function checkNativeSource(config: {
  name: string;
  encodeSource?: "harness" | "native";
  forceOpaque?: boolean;
  variants: readonly {
    label: string;
    capToTier0?: boolean;
    version?: string;
  }[];
}): void {
  if (config.encodeSource !== "native") return;
  if (config.forceOpaque) {
    throw new Error(
      `config ${config.name}: forceOpaque flattens the harness raster, not a native source`,
    );
  }
  for (const v of config.variants) {
    if (v.capToTier0 || v.version) {
      throw new Error(
        `variant "${v.label}": encodeSource "native" cannot honour capToTier0 or version, which act on the harness raster`,
      );
    }
  }
}

/** What an identity arm keeps of its own: its spec and its encoded lengths. */
export interface IdentityArm {
  label: string;
  tune: string | null;
  tier: number;
  version: string | null;
}

/**
 * The row an `identicalTo` arm records: its reference's metric series (equal
 * pixels score equally), with the arm's own label, spec, byte lengths and
 * decode digests. Throws, naming the first five, if any image's decode
 * differs from the reference's.
 */
export function identityRow<
  R extends {
    label: string;
    decodeDigests: readonly string[];
    perImage: Partial<Record<"bytes", (number | null)[]>>;
  },
>(
  reference: R,
  arm: IdentityArm,
  bytes: number[],
  digests: string[],
  imageNames: readonly string[],
): R {
  const differ = identityMismatches(
    reference.decodeDigests,
    digests,
    imageNames,
  );
  if (differ.length > 0) {
    throw new Error(
      `${arm.label}: ${differ.length} of ${imageNames.length} decodes differ from ${reference.label}'s (identicalTo), first ${differ.slice(0, 5).join(", ")}`,
    );
  }
  let bytesSum = 0;
  for (const b of bytes) bytesSum += b;
  return {
    ...reference,
    ...arm,
    bytes: bytesSum / (bytes.length || 1),
    perImage: { ...reference.perImage, bytes },
    decodeDigests: digests,
  };
}
