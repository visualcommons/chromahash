/**
 * Fixtures and the lever matrix.
 *
 * Every knob that moves bytes, quality or time gets an axis here. The bounded
 * default holds one axis free at a time against a fixed centre (tier 1,
 * 100x100, gradient); the exhaustive mode takes the cross product.
 */

/** Content classes, chosen for what they do to the AC spectrum. */
export type Content = "gradient" | "noise" | "solid";

export interface Fixture {
  readonly w: number;
  readonly h: number;
  readonly content: Content;
  readonly rgba: Buffer;
}

/**
 * Deterministic fixtures, generated rather than loaded so a perf run needs no
 * corpus on disk and cannot drift with it.
 *
 * - `gradient` is the historical fixture, and its spectrum is nearly empty
 *   above DC — the easy case for coefficient selection.
 * - `noise` fills the selected band, so the quantizer's neighbourhood searches
 *   actually run rather than short-circuiting on zeros.
 * - `solid` has exactly zero AC energy and trips the `scale < 1e-10` floor,
 *   which is the cheapest path through the encoder.
 */
export function makeFixture(w: number, h: number, content: Content): Fixture {
  const rgba = Buffer.alloc(w * h * 4);
  // A small LCG, so `noise` is reproducible without a dependency.
  let s = 0x9e3779b9;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s >>> 24;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (content === "solid") {
        rgba[i] = 180;
        rgba[i + 1] = 90;
        rgba[i + 2] = 60;
      } else if (content === "noise") {
        rgba[i] = next();
        rgba[i + 1] = next();
        rgba[i + 2] = next();
      } else {
        rgba[i] = w > 1 ? Math.floor((x * 255) / (w - 1)) : 0;
        rgba[i + 1] = h > 1 ? Math.floor((y * 255) / (h - 1)) : 0;
        rgba[i + 2] = 128;
      }
      rgba[i + 3] = 255;
    }
  }
  return { w, h, content, rgba };
}

export const ALL_TIERS = [0, 1, 2, 3, 4] as const;
/** Encoded length per tier code, no alpha (spec 3.5). */
export const TIER_BYTES: Readonly<Record<number, number>> = {
  0: 21,
  1: 32,
  2: 108,
  3: 411,
  4: 1623,
};

/** Source sizes for the encode-scaling axis. Encode is O(K*W*H) on the full source. */
export const BOUNDED_SIZES = [64, 100, 256, 512] as const;
export const FULL_SIZES = [64, 100, 128, 256, 512, 1024] as const;

/** Cross-language tiers. Tier 4 decode costs ~250 ms, so bounded stops at 2. */
export const BOUNDED_CROSS_TIERS = [0, 1, 2] as const;

/** PERFORMANCE.md §12.1's seven byte-identical levers, by `Tunables` flag. */
export const ACCEL_LEVERS = [
  "accel_quant_table",
  "accel_dct_lanes",
  "accel_gamma_lut_cache",
  "accel_flat_cos",
  "accel_sse_early_exit",
  "accel_fused_pixels",
  "accel_word_bitpack",
] as const;

/**
 * Every §12.1 lever on at once. Encode-only and decode-only flags are both
 * harmless on the other operation, so one string serves both arm sets. Since
 * #142 `Tunables::DEFAULT` sets every one of them but `accel_fused_pixels`,
 * whose paired count is an instruction increase; records made before then
 * compare this with a levers-off default.
 */
export const ACCEL_ALL = ACCEL_LEVERS.map((l) => `${l}=1`).join(" ");

/**
 * Every §12.1 lever off: the unaccelerated reference path the shipped levers
 * replace, which `lever-identity` and `benchmark:counts` compare them with.
 */
export const ACCEL_NONE = ACCEL_LEVERS.map((l) => `${l}=0`).join(" ");

/**
 * Encoder-only levers: zero wire cost, decoder untouched, bytes unchanged.
 * Rust-only, because no binding exposes `Tunables`.
 */
export const TUNE_ARMS: ReadonlyArray<{ label: string; tune: string | null }> =
  [
    { label: "shipped", tune: null },
    { label: "scale_fit=0", tune: "scale_fit=0" },
    { label: "scale_fit=1", tune: "scale_fit=1" },
    { label: "ac_nearest=0", tune: "ac_nearest=0" },
    { label: "dc_search=0", tune: "dc_search=0" },
    {
      label: "no encoder search",
      tune: "scale_fit=0 ac_nearest=0 dc_search=0",
    },
    { label: "refine_passes=1", tune: "refine_passes=1" },
    { label: "refine_passes=2", tune: "refine_passes=2" },
    // PERFORMANCE.md §12.1's byte-identical levers that act on encode. The
    // shipped defaults turn all but `accel_fused_pixels` on (#142), so each
    // of those arms turns one off, `accel_fused_pixels` turns its lever on,
    // and `accel none` turns all seven off: the reference path the levers
    // replaced. Every arm produces the shipped bytes
    // (rust/tests/accel_levers.rs), so the time column is the whole of what
    // it changes; a lever's speedup is the `=0` arm's time over `shipped`'s,
    // and the fused pass's is `shipped`'s over its arm's. The two decode-only levers
    // are in `DECODE_ACCEL_ARMS`; the early exit only acts inside refinement,
    // so it is priced against `refine_passes=1` rather than against `shipped`.
    { label: "accel_quant_table=0", tune: "accel_quant_table=0" },
    { label: "accel_dct_lanes=0", tune: "accel_dct_lanes=0" },
    { label: "accel_fused_pixels", tune: "accel_fused_pixels=1" },
    { label: "accel_word_bitpack=0", tune: "accel_word_bitpack=0" },
    { label: "accel none", tune: ACCEL_NONE },
    // The prototype separable forward DCT. Off by default and exposed by no
    // binding (constants.rs `dct_separable: false`, pinned by a test), so this
    // is the only way to price it — and PERFORMANCE.md §6 quotes it. §6 prices
    // it against the direct summation with every §12.1 lever off, as it was
    // measured before #142 made the levers the defaults: on the shipped
    // defaults the direct path runs `accel_dct_lanes` and the quantizer runs
    // `accel_quant_table`, so a ratio against `shipped` would be separable
    // against the lane-batched DCT, not against the direct sum. The label
    // extends `accel none`, so `plan.ts` pairs it with that arm, which must
    // come first.
    {
      label: "accel none dct_separable",
      tune: `${ACCEL_NONE} dct_separable=1`,
    },
    {
      label: "refine_passes=1 accel_sse_early_exit=0",
      tune: "refine_passes=1 accel_sse_early_exit=0",
    },
  ];

/**
 * The encode levers whose share grows with the tier rather than the source:
 * `scale_fit = 2` searches every scale code over every selected coefficient,
 * and tier 4 selects ~16× the coefficients of tier 1. Priced at tier 4 on the
 * centre fixture. `shipped` is §2's tier-4 encode cell under the lever
 * table's name (an alias, `plan.ts`), and every other arm is a paired ratio
 * against it: a lever turned off, or all of them (`TUNE_ARMS`).
 */
export const TIER4_ACCEL_ARMS: ReadonlyArray<{
  label: string;
  tune: string | null;
}> = [
  { label: "shipped", tune: null },
  { label: "accel_quant_table=0", tune: "accel_quant_table=0" },
  { label: "accel_dct_lanes=0", tune: "accel_dct_lanes=0" },
  { label: "accel none", tune: ACCEL_NONE },
];

/**
 * §12.1 item 4's two decode levers, each turned off alone and then every
 * lever off, each a paired ratio against §2's decode cell at the same tier
 * and raster, which `shipped` names (an alias, `plan.ts`).
 */
export const DECODE_ACCEL_ARMS: ReadonlyArray<{
  label: string;
  tune: string | null;
}> = [
  { label: "shipped", tune: null },
  { label: "accel_gamma_lut_cache=0", tune: "accel_gamma_lut_cache=0" },
  { label: "accel_flat_cos=0", tune: "accel_flat_cos=0" },
  { label: "accel none", tune: ACCEL_NONE },
];

/** Batch thread counts for the scaling sweep. */
export const BOUNDED_THREADS = [1, 0] as const;
export const FULL_THREADS = [1, 2, 4, 8, 0] as const;
