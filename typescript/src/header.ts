/**
 * ChromaHash **descriptor byte** parsing, the §3.2 layout table, and the §2.6
 * structural validation both entry points share.
 *
 * Kept separate from `./decode` so the WASM-backed `./index` can validate a
 * hash without pulling in the pure-TypeScript render path, and from `./index`
 * so the pure decoder needs no WebAssembly.
 */

// ---------------------------------------------------------------------------
// v1 format constants (the locked `Tunables::DEFAULT`)
// ---------------------------------------------------------------------------

type Band = readonly [count: number, bits: number];

/**
 * One tier's AC bit layout (spec §3.2). v1 carries three rows: the compact
 * tier, the default tier, and one base that codes 2..=4 scale by `4^level`.
 */
export interface AcLayout {
  /** No-alpha luma bands (count, bits), in selection order. */
  readonly lBands: readonly Band[];
  readonly cCount: number;
  readonly cBits: number;
  /** Alpha-mode luma bands. */
  readonly laBands: readonly Band[];
  readonly caCount: number;
  readonly caBits: number;
  /** Alpha-plane AC count/width — per row, not global (§11.3). */
  readonly aCount: number;
  readonly aBits: number;
}

/** Layout B: the base codes 2..=4 scale. */
const LAYOUT_B: AcLayout = {
  lBands: [
    [26, 5],
    [0, 5],
  ],
  cCount: 9,
  cBits: 4,
  laBands: [
    [22, 4],
    [0, 4],
  ],
  caCount: 3,
  caBits: 3,
  aCount: 28,
  aBits: 3,
};

/** Layout T0: the default tier's own row (code 1, 32 bytes). */
const LAYOUT_T0: AcLayout = {
  lBands: [
    [28, 4],
    [0, 4],
  ],
  cCount: 15,
  cBits: 3,
  laBands: [
    [22, 4],
    [0, 4],
  ],
  caCount: 3,
  caBits: 3,
  aCount: 28,
  aBits: 3,
};

/** Layout TC: the compact tier's own row (code 0, 21 bytes). */
const LAYOUT_TC: AcLayout = {
  lBands: [
    [19, 4],
    [0, 4],
  ],
  cCount: 6,
  cBits: 3,
  laBands: [
    [12, 4],
    [0, 4],
  ],
  caCount: 1,
  caBits: 3,
  aCount: 16,
  aBits: 3,
};

/**
 * Layout T3: code 3's own row (generation v2). Code 3 carries its AC codes in
 * the arithmetic-coded stream, so this row bounds what the stream may carry,
 * and the hash keeps the length {@link LAYOUT_B} gives.
 */
const LAYOUT_T3: AcLayout = {
  lBands: [
    [78, 5],
    [0, 5],
  ],
  cCount: 27,
  cBits: 4,
  laBands: [
    [54, 4],
    [0, 4],
  ],
  caCount: 9,
  caBits: 3,
  aCount: 60,
  aBits: 5,
};

/** Layout T4: code 4's own row (generation v2): B opaque, a 5-bit alpha row. */
const LAYOUT_T4: AcLayout = {
  lBands: [
    [26, 5],
    [0, 5],
  ],
  cCount: 9,
  cBits: 4,
  laBands: [
    [23, 4],
    [0, 4],
  ],
  caCount: 3,
  caBits: 3,
  aCount: 16,
  aBits: 5,
};

/** Wire-format generation this module implements: `1` is v2. */
export const FORMAT_VERSION = 1;
const VERSION_BITS = 3;
const TIER_BITS = 3;
const ALPHA_FLAG_BIT = 6;
const RESERVED_FLAG_BIT = 7;

/**
 * Tier codes, ordered by quality (spec §2.5). `0` is the 21-byte compact tier,
 * `1` the 32-byte default, `2..=4` the higher tiers; `5..=7` stay reserved.
 */
export const COMPACT_TIER = 0;
export const DEFAULT_TIER = 1;
export const MAX_TIER = 4;

/** Natural render long edge at render level 0. */
export const BASE_LONG_EDGE = 32;

export const L_DC_BITS = 7;
export const A_DC_BITS = 7;
export const B_DC_BITS = 7;
export const L_SCALE_BITS = 6;
export const A_SCALE_BITS = 6;
export const B_SCALE_BITS = 5;
export const ALPHA_DC_BITS = 5;
export const ALPHA_SCALE_BITS = 4;

/** Byte 0 (descriptor) + byte 1 (aspect). */
export const DESCRIPTOR_BITS = 16;
/** Fixed prefix before the AC payload: descriptor + aspect + DC + scales. */
export const PREFIX_BITS =
  DESCRIPTOR_BITS +
  L_DC_BITS +
  A_DC_BITS +
  B_DC_BITS +
  L_SCALE_BITS +
  A_SCALE_BITS +
  B_SCALE_BITS;
/** Extra prefix bits present only in alpha mode. */
export const ALPHA_PREFIX_BITS = ALPHA_DC_BITS + ALPHA_SCALE_BITS;

export const MAX_CHROMA_A = 0.35;
export const MAX_CHROMA_B = 0.33;
export const MAX_L_SCALE = 0.5;
export const MAX_A_SCALE = 0.125;
export const MAX_B_SCALE = 0.125;
export const MAX_ALPHA_SCALE = 0.5;
export const MU_L = 5.0;
export const MU_C = 8.0;
export const MU_ALPHA = 5.0;
/**
 * The synthesis window per alpha mode and tier code (spec §11.1, register
 * entry D3 as the v0.8 combination check kept it): `w_min` for luma and
 * chroma alike, with `w_exp = 1`. Off (`1.0`) at codes 0–2; on at code 4
 * opaque and at code 3 in alpha mode.
 */
export const WINDOW_W_MIN_OPAQUE: readonly number[] = [1.0, 1.0, 1.0, 1.0, 0.7];
export const WINDOW_W_MIN_ALPHA: readonly number[] = [1.0, 1.0, 1.0, 0.85, 1.0];
export const WINDOW_W_EXP = 1;

/** Whether a tier code's AC payload is the arithmetic-coded stream (code 3). */
export const AC_CODED: readonly boolean[] = [false, false, false, true, false];

/** §6.2 selection weights, on the exact Q12 integer grid the spec orders on. */
export const ANISO_OBLIQUE = 1.2;
export const SEL_HV = 0.15;
export const SEL_Q = 12;
export const SEL_ONE = 1 << SEL_Q;

/**
 * Quality ordinal of a tier code (spec §3.5): how many times the natural render
 * size doubles. Codes 0 and 1 share level 0; every higher code is one above its
 * predecessor.
 */
export function renderLevel(tier: number): number {
  return Math.max(0, tier - 1);
}

/** Count multiplier for a tier code: `4^level`. */
export function tierCountScale(tier: number): number {
  return 1 << (2 * renderLevel(tier));
}

/** The §3.2 layout row governing a tier code. */
export function tierLayout(tier: number): AcLayout {
  if (tier === COMPACT_TIER) return LAYOUT_TC;
  if (tier === DEFAULT_TIER) return LAYOUT_T0;
  if (tier === 3) return LAYOUT_T3;
  return tier === 4 ? LAYOUT_T4 : LAYOUT_B;
}

/**
 * The fixed-width row a tier code's **length** is computed from (spec §3.5):
 * its own row, except at codes 2–4, which all take {@link LAYOUT_B}'s length.
 * Every generation-v2 row at codes 3 and 4 has that length, and a coded
 * tier's row only bounds its stream.
 */
function lengthLayout(tier: number): AcLayout {
  return tier >= 2 ? LAYOUT_B : tierLayout(tier);
}

/** Wire-format generation from byte 0 (bits 0..3). */
export function readVersion(hash: Uint8Array): number {
  return (hash[0] ?? 0) & ((1 << VERSION_BITS) - 1);
}

/** Tier code from byte 0 (bits 3..6). */
export function readTier(hash: Uint8Array): number {
  return ((hash[0] ?? 0) >> VERSION_BITS) & ((1 << TIER_BITS) - 1);
}

/** Alpha flag from byte 0 (bit 6). */
export function readHasAlpha(hash: Uint8Array): boolean {
  return (((hash[0] ?? 0) >> ALPHA_FLAG_BIT) & 1) === 1;
}

/** Aspect byte (byte 1). */
export function readAspect(hash: Uint8Array): number {
  return hash[1] ?? 0;
}

/**
 * Encoded byte length implied by `(tier, hasAlpha)`. Per spec §3.5 — the length
 * is fully determined by the descriptor, which is what makes validation a
 * structural check rather than a checksum.
 */
export function bodyLenBytes(tier: number, hasAlpha: boolean): number {
  const layout = lengthLayout(tier);
  const scale = tierCountScale(tier);
  const bands = hasAlpha ? layout.laBands : layout.lBands;
  let acBits = 0;
  for (const [count, bits] of bands) acBits += count * scale * bits;
  const cCount = (hasAlpha ? layout.caCount : layout.cCount) * scale;
  const cBits = hasAlpha ? layout.caBits : layout.cBits;
  acBits += 2 * cCount * cBits;
  if (hasAlpha) acBits += layout.aCount * scale * layout.aBits;
  const bodyBits = PREFIX_BITS + (hasAlpha ? ALPHA_PREFIX_BITS : 0) + acBits;
  return Math.ceil(bodyBits / 8);
}

/**
 * Validate the descriptor and the exact byte length. Per spec §2.6: a hash that
 * passes these checks is guaranteed to decode, so every public entry point
 * validates before rendering rather than producing garbage downstream.
 */
export function assertHash(hash: Uint8Array): void {
  if (hash.length < 2) {
    throw new Error(
      `ChromaHash is too short to carry a descriptor: ${hash.length} bytes`,
    );
  }
  const version = readVersion(hash);
  if (version !== FORMAT_VERSION) {
    throw new Error(
      `unsupported ChromaHash wire-format generation ${version} (this build implements ${FORMAT_VERSION})`,
    );
  }
  const tier = readTier(hash);
  if (tier > MAX_TIER) {
    throw new Error(
      `invalid ChromaHash tier code ${tier} (valid: 0..=${MAX_TIER})`,
    );
  }
  if ((((hash[0] ?? 0) >> RESERVED_FLAG_BIT) & 1) !== 0) {
    throw new Error("ChromaHash reserved flag must be 0");
  }
  const expected = bodyLenBytes(tier, readHasAlpha(hash));
  if (hash.length !== expected) {
    throw new Error(
      `ChromaHash length ${hash.length} disagrees with its descriptor (tier ${tier} implies ${expected} bytes)`,
    );
  }
}

/**
 * Whether this hash's wire-format generation is the one this module implements.
 *
 * Unlike the v0.6 predecessor, an unsupported generation is *detectable*: byte 0
 * carries an explicit 3-bit `version` field, so this is a real check rather than
 * a guess, and {@link decode} rejects rather than producing garbage.
 */
export function isVersionSupported(hash: Uint8Array): boolean {
  return hash.length >= 2 && readVersion(hash) === FORMAT_VERSION;
}
