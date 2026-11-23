/**
 * The pure checks `sweep.ts` applies to its inputs and hashes, split out of
 * the CLI because `sweep.ts` runs at module scope: importing it to assert
 * these would start a sweep. Both are asserted in `metric-selftest.ts`.
 */

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
