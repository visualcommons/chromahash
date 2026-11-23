/**
 * The pure checks `sweep.ts` applies to its inputs and hashes, split out of
 * the CLI because `sweep.ts` runs at module scope: importing it to assert
 * these would start a sweep. Both are asserted in `metric-selftest.ts`.
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
