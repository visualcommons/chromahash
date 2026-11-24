/// Gamut identifiers for source color spaces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gamut {
    Srgb,
    DisplayP3,
    AdobeRgb,
    Bt2020,
    ProPhotoRgb,
}

// ── v2 wire format ─────────────────────────────────────────────────────────
//
// chromahash ships as release 0.8.0, but the on-wire format carries its own
// generation number, independent of the package semver. This is wire-format
// generation **v2**. Every framing parameter below is a named constant so the
// encoder, decoder, and `spec/constants.py` agree without scattered literals.

/// Wire-format generation, stored in the 3-bit `version` field of byte 0.
///
/// `1` is format **v2** (chromahash 0.8.x): generation v1 (`0`, chromahash
/// 0.7.x) with codes 3 and 4 changed by the v0.8 verdict
/// (`spec/V0.8-DECISIONS.md`). Future incompatible formats increment the
/// field: `2` → v3, `3` → v4, … A decoder MUST reject any value it does not
/// implement, and this one implements v2 alone.
pub const FORMAT_VERSION: u8 = 1;

/// Width of the byte-0 `version` field (bits 0..3).
pub const VERSION_BITS: u32 = 3;
/// Width of the byte-0 `tier` field (bits 3..6).
pub const TIER_BITS: u32 = 3;
/// Bit position of the `hasAlpha` flag within byte 0.
pub const ALPHA_FLAG_BIT: u32 = 6;
/// Bit position of the reserved flag within byte 0 (MUST be 0 in v1).
pub const RESERVED_FLAG_BIT: u32 = 7;

/// Highest valid tier code the format defines (spec §2.5). Tier codes are
/// `0..=MAX_TIER`, ordered by quality; codes `5..=7` remain reserved.
pub const MAX_TIER: u8 = 4;

/// How many tier codes the format defines (`0..=MAX_TIER`): the length of
/// every per-tier [`Tunables`] array.
pub const TIER_CODES: usize = MAX_TIER as usize + 1;

/// The compact tier's code (spec §3.1). 21 bytes: the smallest and lowest-
/// fidelity tier, rendered at [`DEFAULT_TIER`]'s resolution.
pub const COMPACT_TIER: u8 = 0;

/// The default tier's code (spec §3.5). Exactly 32 bytes, matching the v0.6
/// footprint — what [`crate::ChromaHash::encode`] produces.
///
/// Never write the literal `1` for this: the codes are ordered by quality, so a
/// bare `0` default would silently select the 21-byte compact tier.
pub const DEFAULT_TIER: u8 = 1;

/// Is `tier` a code this format defines? Codes `5..=7` remain reserved.
#[inline]
pub const fn is_valid_tier(tier: u8) -> bool {
    tier <= MAX_TIER
}

/// Quality ordinal of a tier code: how many times the natural render size
/// doubles, and the exponent behind the `4^level` coefficient scaling.
///
/// The compact tier renders at the default tier's size, so codes 0 and 1 share
/// level 0 and every higher code is one level above its predecessor. Every
/// place that scales with quality shifts by this rather than by the raw code.
#[inline]
pub const fn render_level(tier: u8) -> u8 {
    tier.saturating_sub(1)
}

/// Natural render long-edge in pixels at render level 0. The natural render size
/// scales to `BASE_LONG_EDGE << render_level(tier)` on the long edge
/// (32 / 64 / 128 / 256 px).
pub const BASE_LONG_EDGE: u32 = 32;

/// DC code bit widths (L, a, b) — identical quantization to v0.6.
pub const L_DC_BITS: u32 = 7;
pub const A_DC_BITS: u32 = 7;
pub const B_DC_BITS: u32 = 7;
/// AC scale code bit widths (L, a, b).
pub const L_SCALE_BITS: u32 = 6;
pub const A_SCALE_BITS: u32 = 6;
pub const B_SCALE_BITS: u32 = 5;
/// Alpha DC / scale code bit widths (present only in alpha mode). These are the
/// shipped values and the defaults of [`Tunables::alpha_dc_bits`] /
/// [`Tunables::alpha_scale_bits`]; the alpha prefix is their sum (9 bits), which
/// [`body_len_bytes`] computes from the tunables rather than from a constant so
/// a sweep can resize it.
pub const ALPHA_DC_BITS: u32 = 5;
pub const ALPHA_SCALE_BITS: u32 = 4;

/// Byte 0 (descriptor) + byte 1 (aspect) = 16 bits.
pub const DESCRIPTOR_BITS: u32 = 16;
/// DC + scale prefix after the descriptor/aspect bytes
/// (L/a/b DC = 21 bits, L/a/b scale = 17 bits).
pub const DC_SCALE_BITS: u32 =
    L_DC_BITS + A_DC_BITS + B_DC_BITS + L_SCALE_BITS + A_SCALE_BITS + B_SCALE_BITS;
/// Fixed prefix before the AC payload: descriptor + aspect + DC + scales = 54 bits.
pub const PREFIX_BITS: u32 = DESCRIPTOR_BITS + DC_SCALE_BITS;

/// AC bit layout: how the per-channel AC budget is split at one quality tier.
///
/// v1 carries **three** of these (see [`Tunables::layout`],
/// [`Tunables::layout_upper`] and [`Tunables::layout_compact`]): the compact tier and the
/// default tier each have their own table, and codes 2..=4 scale a single base by
/// `4^level` (bits per coefficient stay constant — higher tiers carry *more*
/// coefficients, not finer ones). The split exists because the count-vs-precision
/// optimum moves with the budget: at 32 bytes the format is better off with more,
/// coarser coefficients than the code-2 base scaled down would give it (spec §3.2).
///
/// L coefficients are written in selection order through up to two precision
/// tiers (a tier with count 0 is unused). Chroma a/b each get `c_count`
/// coefficients at `c_bits`. The `la_*`/`ca_*` fields are the alpha-mode
/// equivalents (alpha mode additionally stores alpha DC 5b + scale 4b + scaled
/// alpha AC). Trailing bits to the final byte boundary are padding zeros.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcLayout {
    pub l_tiers: [(usize, u32); 2],
    pub c_count: usize,
    pub c_bits: u32,
    pub la_tiers: [(usize, u32); 2],
    pub ca_count: usize,
    pub ca_bits: u32,
    /// Alpha AC coefficient count and bit width (alpha mode only).
    ///
    /// Part of the layout row rather than one global, because the rows
    /// disagree: §11.3 measured the default tier wanting 28 coefficients where the
    /// compact tier's smaller budget wants 16. A global would force one of
    /// them to be wrong.
    pub a_count: usize,
    pub a_bits: u32,
}

/// Layout A: rebalance 15 bits from L to chroma (primary v0.6 candidate).
pub const LAYOUT_A: AcLayout = AcLayout {
    l_tiers: [(24, 5), (0, 5)],
    c_count: 11,
    c_bits: 4,
    la_tiers: [(19, 5), (0, 5)],
    ca_count: 10,
    ca_bits: 4,
    a_count: 5,
    a_bits: 4,
};

/// Layout B: the **v1 upper-tier base**, reached only at codes 2..=4
/// (`Tunables::DEFAULT.layout` is [`LAYOUT_T0`]; this is `layout_upper`). Its
/// counts were sized so that, unscaled,
/// they would fill exactly 32 bytes in both alpha modes — the v0.6 footprint, kept
/// as the equal-budget anchor [`LAYOUT_T0`] was measured against. It is never
/// emitted at 32 bytes itself, because every code that reaches it scales the counts
/// by `4^level`:
/// no-alpha = 54 prefix + 26·5 L + 2·9·4 chroma = 256 bits; alpha = 54 + 9 +
/// 22·4 L + 2·3·3 chroma + 28·3 alpha = 253 bits (both → 32 bytes).
///
/// The alpha row is the §11.3 allocation, which measured essentially tied for best
/// at code 2 as well as at the default tier.
pub const LAYOUT_B: AcLayout = AcLayout {
    l_tiers: [(26, 5), (0, 5)],
    c_count: 9,
    c_bits: 4,
    la_tiers: [(22, 4), (0, 4)],
    ca_count: 3,
    ca_bits: 3,
    a_count: 28,
    a_bits: 3,
};

/// Layout T0: the **v1 default-tier layout** (the shipped default at code 1). At a
/// 32-byte budget the AC payload is 202 bits, and spending it on 28 luma
/// coefficients at 4 bits plus 15 chroma at 3 beats the 26@5 / 9@4 split of
/// [`LAYOUT_B`] by 2.09% mean ΔE00 on the old photographic holdout (since spent,
/// spec/EXPERIMENTS.md §11.12), with
/// SSIMULACRA2, Butteraugli and DSSIM all improving (spec/EXPERIMENTS.md §4.5;
/// the 3.5% this comment used to quote was the whole v0.7 recipe, not the
/// layout alone, and §8.3 is where that recipe is measured).
/// Sized to the same anchor: no-alpha = 54 prefix + 28·4 L + 2·15·3 chroma =
/// 256 bits.
///
/// The **alpha-mode** fields are the §11.3 allocation, and they coincide with
/// [`LAYOUT_B`]'s alpha row because that sweep measured the two essentially tied.
/// The alpha channel had five AC coefficients, inherited from v0.6 and never
/// measured, and five cannot describe a silhouette. Raising it to 28 and paying
/// out of chroma — which transparent regions composite away — is worth −17.10% mean
/// ΔE00 on the alpha tune corpus, where every one of its 16 images improves. That
/// is in-sample evidence. The never-tuned alpha holdout that put it at −16.2% mean
/// ΔE00 has been retired (one of its images was deleted from Wikimedia Commons), so
/// that figure can no longer be reproduced (§11.12). Its replacement, the sealed
/// alpha holdout v2, confirms the row out of sample at −13.66% (§13.7, register
/// C2). The alpha row's budget:
/// alpha = 54 + 9 + 22·4 L + 2·3·3 chroma + 28·3 alpha = 253 bits.
pub const LAYOUT_T0: AcLayout = AcLayout {
    l_tiers: [(28, 4), (0, 4)],
    c_count: 15,
    c_bits: 3,
    la_tiers: [(22, 4), (0, 4)],
    ca_count: 3,
    ca_bits: 3,
    a_count: 28,
    a_bits: 3,
};

/// Layout C: tiered L precision (6-bit low band) with widened chroma.
pub const LAYOUT_C: AcLayout = AcLayout {
    l_tiers: [(8, 6), (14, 5)],
    c_count: 11,
    c_bits: 4,
    la_tiers: [(6, 6), (12, 5)],
    ca_count: 10,
    ca_bits: 4,
    a_count: 5,
    a_bits: 4,
};

/// Layout D: fewer but finer (5-bit) chroma coefficients.
pub const LAYOUT_D: AcLayout = AcLayout {
    l_tiers: [(23, 5), (0, 5)],
    c_count: 9,
    c_bits: 5,
    la_tiers: [(19, 5), (0, 5)],
    ca_count: 8,
    ca_bits: 5,
    a_count: 5,
    a_bits: 4,
};

/// Layout TC: the **compact-tier row** (tier code 0, 21 bytes).
///
/// Chosen on the photographic tune split and tie-broken on the graphics corpus:
/// the leading 21-byte layouts are a plateau there (the top seven span 0.5% and
/// every paired-bootstrap CI against the leader includes zero), so the tie was
/// broken on which candidate holds up across both bodies of content rather than
/// by mining the photographic guards. See `EXPERIMENTS.md` §11.5.
///
/// `54 + 19·4 + 2·6·3 = 166 bits` → 21 bytes (no alpha).
/// `54 + 9 + 12·4 + 2·1·3 + 16·3 = 165 bits` → 21 bytes (alpha).
pub const LAYOUT_TC: AcLayout = AcLayout {
    l_tiers: [(19, 4), (0, 4)],
    c_count: 6,
    c_bits: 3,
    la_tiers: [(12, 4), (0, 4)],
    ca_count: 1,
    ca_bits: 3,
    a_count: 16,
    a_bits: 3,
};

/// Layout T3: the **code-3 row** of generation v2 (v0.8), scaled by 16.
///
/// Code 3 carries its AC codes in the arithmetic-coded stream (register entry
/// D1, `spec/V0.8-DECISIONS.md`), so this row **bounds** the codes the stream
/// may carry instead of fixing their fields, and the hash keeps the length
/// [`LAYOUT_B`] gives (411 / 388 bytes). The opaque bounds are three times
/// [`LAYOUT_B`]'s counts at its widths (D1's frozen `x3`). The alpha bounds
/// are three times the D6 row `A20@5 L18@4 C3@3`, at its widths: register
/// entry D6's 5-bit alpha row, combined with the coder as the v0.8
/// combination check read it on tune.
pub const LAYOUT_T3: AcLayout = AcLayout {
    l_tiers: [(78, 5), (0, 5)],
    c_count: 27,
    c_bits: 4,
    la_tiers: [(54, 4), (0, 4)],
    ca_count: 9,
    ca_bits: 3,
    a_count: 60,
    a_bits: 5,
};

/// Layout T4: the **code-4 row** of generation v2 (v0.8), scaled by 64.
///
/// Opaque, it is [`LAYOUT_B`]'s row. Alpha, it is register entry D6's
/// `A16@5 L23@4 C3@3`: a 5-bit alpha field in place of the 3-bit one, at the
/// same 190 bits per base row, so the length is [`LAYOUT_B`]'s (1623 / 1528
/// bytes). `54 + 9 + 64·(23·4 + 2·3·3 + 16·5) = 12223 bits` → 1528 bytes.
pub const LAYOUT_T4: AcLayout = AcLayout {
    l_tiers: [(26, 5), (0, 5)],
    c_count: 9,
    c_bits: 4,
    la_tiers: [(23, 4), (0, 4)],
    ca_count: 3,
    ca_bits: 3,
    a_count: 16,
    a_bits: 5,
};

/// One value per alpha mode and tier code, indexed `[has_alpha][tier]`: the
/// shape of every setting generation v2 makes conditional on both, which the
/// decoder reads from byte 0.
pub type PerCell<T> = [[T; TIER_CODES]; 2];

/// The synthesis window's `w_min` per alpha mode and tier code, luma and
/// chroma alike, with `w_exp = 1` (register entry D3, as the v0.8
/// combination check kept it): off (`1.0`) at codes 0–2; at code 3 on in
/// alpha mode (`0.85`) and off opaque, where it fails D3's primary beside
/// the coder; at code 4 on opaque (`0.7`) and off in alpha mode, where it
/// costs the 5-bit alpha row more than δ (`spec/V0.8-DECISIONS.md`, "The
/// v0.8 verdict").
pub const WINDOW_W_MIN: PerCell<f64> = [
    [1.0, 1.0, 1.0, 1.0, 0.7],  // opaque
    [1.0, 1.0, 1.0, 0.85, 1.0], // alpha
];

/// `[has_alpha][tier]` index of a (alpha mode, tier code) cell. A reserved
/// code (never reached: `from_bytes` rejects it) reads the top tier's entry.
#[inline]
pub(crate) fn cell_index(has_alpha: bool, tier: u8) -> (usize, usize) {
    (has_alpha as usize, tier_index(tier))
}

/// The AC coder per tier code (register entry D1): the arithmetic-coded
/// stream at code 3, the fixed-width fields everywhere else.
pub const AC_CODER: [u32; TIER_CODES] = [0, 0, 0, 1, 0];

/// Per-channel AC counts/bit-widths resolved for one (alpha mode, tier). The
/// [`AcLayout`] passed in describes that tier's base counts; a tier scales every
/// coefficient *count* by `4^render_level(tier)` while bit widths stay fixed.
#[derive(Debug, Clone, Copy)]
pub(crate) struct AcShape {
    /// L coefficient precision tiers (count, bits), in write order.
    pub l_tiers: [(usize, u32); 2],
    /// Chroma a/b coefficient count (each channel) and bit width.
    pub c_count: usize,
    pub c_bits: u32,
    /// Alpha AC coefficient count (0 when not in alpha mode).
    pub alpha_ac_count: usize,
    /// Bits per alpha AC coefficient.
    pub alpha_ac_bits: u32,
}

impl AcShape {
    /// Total L coefficient count across both precision tiers.
    pub fn l_count(&self) -> usize {
        self.l_tiers[0].0 + self.l_tiers[1].0
    }
}

/// `4^level` — the count multiplier for a tier code (1, 4, 16, 64; 1 for the
/// compact tier, which shares the default tier's render level).
#[inline]
pub(crate) fn tier_count_scale(tier: u8) -> usize {
    1usize << (2 * render_level(tier) as usize)
}

/// The [`AcLayout`] that governs a tier code. The table has three rows: the
/// compact tier, the default tier, and one base that codes 2..=4 scale by
/// `4^level`.
pub(crate) fn tier_layout(t: &Tunables, tier: u8) -> &AcLayout {
    match tier {
        COMPACT_TIER => &t.layout_compact,
        DEFAULT_TIER => &t.layout,
        2 => &t.layout_upper,
        3 => &t.layout_t3,
        _ => &t.layout_t4,
    }
}

/// The tier code's index into the per-tier [`Tunables`] arrays. A reserved
/// code (never reached: `from_bytes` rejects it) reads the top tier's entry.
#[inline]
pub(crate) fn tier_index(tier: u8) -> usize {
    (tier as usize).min(TIER_CODES - 1)
}

/// Resolve the layout for a (alpha mode, tier): pick the tier's table, then the
/// alpha or no-alpha counts, then scale them by `4^level`.
pub(crate) fn ac_shape(t: &Tunables, has_alpha: bool, tier: u8) -> AcShape {
    let layout = tier_layout(t, tier);
    let s = tier_count_scale(tier);
    if has_alpha {
        AcShape {
            l_tiers: [
                (layout.la_tiers[0].0 * s, layout.la_tiers[0].1),
                (layout.la_tiers[1].0 * s, layout.la_tiers[1].1),
            ],
            c_count: layout.ca_count * s,
            c_bits: layout.ca_bits,
            alpha_ac_count: layout.a_count * s,
            alpha_ac_bits: layout.a_bits,
        }
    } else {
        AcShape {
            l_tiers: [
                (layout.l_tiers[0].0 * s, layout.l_tiers[0].1),
                (layout.l_tiers[1].0 * s, layout.l_tiers[1].1),
            ],
            c_count: layout.c_count * s,
            c_bits: layout.c_bits,
            alpha_ac_count: 0,
            alpha_ac_bits: layout.a_bits,
        }
    }
}

/// AC payload bits for a resolved shape: L tiers + both chroma channels + alpha
/// AC. Excludes the prefix and the alpha DC/scale (see [`body_len_bytes`]).
pub(crate) fn ac_payload_bits(shape: &AcShape) -> usize {
    let l_bits: usize = shape.l_tiers.iter().map(|&(n, b)| n * b as usize).sum();
    l_bits
        + 2 * shape.c_count * shape.c_bits as usize
        + shape.alpha_ac_count * shape.alpha_ac_bits as usize
}

/// Bits before the AC payload for a given tunable header layout: descriptor
/// byte + aspect field + DC fields + scale fields. Equals [`PREFIX_BITS`] (54)
/// for the shipped widths; the sweep-only field-width knobs move it.
pub(crate) fn prefix_bits(t: &Tunables) -> u32 {
    let scale_bits =
        t.l_scale_bits + t.a_scale_bits + if t.b_scale_from_a { 0 } else { t.b_scale_bits };
    8 + t.aspect_bits + t.l_dc_bits + t.a_dc_bits + t.b_dc_bits + scale_bits + 2 * t.cfl_bits
}

/// `t` with the fixed-width **length rows**: the compact and default rows,
/// and [`LAYOUT_B`] at codes 2–4, with the coder off, every other knob as `t`
/// has it. It fixes a coded hash's length (every generation-v2 row at codes
/// 3 and 4 has the length [`LAYOUT_B`] gives), and it is the fixed
/// alternative of the adaptive mode (`ac_coder = 2`).
pub(crate) fn shipped_fields(t: &Tunables) -> Tunables {
    Tunables {
        layout: Tunables::DEFAULT.layout,
        layout_upper: LAYOUT_B,
        layout_compact: Tunables::DEFAULT.layout_compact,
        layout_t3: LAYOUT_B,
        layout_t4: LAYOUT_B,
        ac_coder: [0; TIER_CODES],
        ..*t
    }
}

/// Total encoded length in bytes for a (tunables, alpha mode, tier): the
/// header prefix (+ alpha DC/scale in alpha mode) plus the AC payload, rounded
/// up to a whole number of bytes. This is the deterministic length formula a
/// decoder recomputes to validate a hash.
///
/// With [`Tunables::ac_coder`] on, the length is the one the shipped layouts
/// give (the same prefix widths, the fixed-width fields): an entropy-coded
/// hash is the shipped hash's size, and its own layout only bounds what the
/// coded stream carries.
pub(crate) fn body_len_bytes(t: &Tunables, has_alpha: bool, tier: u8) -> usize {
    // Not a recursive call on `shipped_fields(t)`: the fixed-width length is
    // read straight off the rows, so a `shipped_fields` that left the coder
    // on gives a wrong length rather than an endless loop.
    let fixed;
    let rows = if t.ac_coder[tier_index(tier)] != 0 {
        fixed = shipped_fields(t);
        &fixed
    } else {
        t
    };
    fields_len_bytes(rows, has_alpha, tier)
}

/// The byte length the fixed-width fields of `t`'s rows give a (alpha mode,
/// tier), whatever `t`'s coder says.
fn fields_len_bytes(t: &Tunables, has_alpha: bool, tier: u8) -> usize {
    let shape = ac_shape(t, has_alpha, tier);
    let mut bits = prefix_bits(t) as usize + ac_payload_bits(&shape);
    if has_alpha {
        bits += (t.alpha_dc_bits + t.alpha_scale_bits) as usize;
    }
    bits.div_ceil(8)
}

/// Experimental AC companding family (sweep-only). The shipped v1 format uses
/// [`Companding::MuLaw`]; the alternatives exist so the corpus sweep can compare
/// the µ-law choice against its audio-codec siblings on equal footing:
/// A-law (G.711's other half, linear near zero), power-law (AAC/MP3 quantize
/// |x|^0.75), and trained Lloyd-Max codebooks ([`Companding::Table`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Companding {
    /// µ-law (the shipped quantizer); uses the group's `mu_*` parameter.
    MuLaw,
    /// A-law with parameter `a` (G.711 uses 87.6).
    ALaw { a: f64 },
    /// Power-law |x|^gamma (AAC/MP3 use gamma = 0.75).
    Power { gamma: f64 },
    /// Trained codebook: the group's [`QuantTable`] holds the positive half of
    /// a symmetric odd-level quantizer with the center pinned at exactly 0.
    Table,
}

/// Positive half of a symmetric odd-level codebook for [`Companding::Table`]:
/// `len` ascending reconstruction levels for indices center+1..=center+len
/// (mirrored for the negative side; the center index decodes to exactly 0).
/// 31 slots cover up to 6-bit fields (2^5 − 1 positive levels). Fixed-size so
/// [`Tunables`] stays `Copy`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuantTable {
    pub levels: [f64; 31],
    pub len: u8,
}

impl QuantTable {
    /// No trained levels (must not be used with `Companding::Table`).
    pub const EMPTY: QuantTable = QuantTable {
        levels: [0.0; 31],
        len: 0,
    };
}

/// All format parameters. The shipped format uses [`Tunables::DEFAULT`];
/// the comparison harness can override these while sweeping the corpus to lock
/// the final constants, via the `CHROMAHASH_TUNE` env parser in the
/// `rust/examples/encode_stdin.rs` example binary.
///
/// NOTE: every field below is mirrored by a `key=value` knob in that example's
/// `tunables_from_env()`. When adding, removing, or renaming a field here, update
/// that parser in lockstep — an unhandled key aborts the whole sweep.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tunables {
    /// AC layout at the **default tier** (code 1, 32 bytes).
    pub layout: AcLayout,
    /// AC layout base for **code 2**, scaled by `4^level` (×4).
    pub layout_upper: AcLayout,
    /// AC layout of the compact tier (code 0). The third row of the table.
    pub layout_compact: AcLayout,
    /// AC layout base for **code 3**, scaled by `4^level` (×16). Since v0.8
    /// (generation v2) codes 3 and 4 each have their own row: the v0.8
    /// verdict adopted a different row at each (`spec/V0.8-DECISIONS.md`).
    /// With [`Tunables::ac_coder`] on at code 3, the row bounds the codes the
    /// coded stream may carry rather than fixing their fields.
    pub layout_t3: AcLayout,
    /// AC layout base for **code 4**, scaled by `4^level` (×64).
    pub layout_t4: AcLayout,
    /// DC chroma quantization ranges. Sized to the union OKLab hull of the
    /// display-output gamuts (sRGB ∪ Display P3 ∪ Adobe RGB: max |a| ≈ 0.347,
    /// max |b| ≈ 0.321) so wide-gamut colors are stored faithfully for
    /// rendering to a P3/Adobe display (§5.1), not truncated to the sRGB hull.
    pub max_chroma_a: f64,
    pub max_chroma_b: f64,
    pub max_l_scale: f64,
    pub max_a_scale: f64,
    pub max_b_scale: f64,
    pub max_alpha_scale: f64,
    /// µ-law companding parameter per channel group.
    pub mu_l: f64,
    pub mu_c: f64,
    pub mu_alpha: f64,
    /// Decode-side synthesis window: w = w_min + (1−w_min)·hann(ρ)^w_exp,
    /// one entry per alpha mode and tier code (`[has_alpha][tier]`). w_min =
    /// 1.0 disables the window. Generation v2 tapers two cells of codes 3
    /// and 4 ([`WINDOW_W_MIN`]); the decoder reads the tier and the alpha
    /// flag from the hash, so the window is conditional on both.
    pub w_min_l: PerCell<f64>,
    pub w_exp_l: PerCell<u32>,
    pub w_min_c: PerCell<f64>,
    pub w_exp_c: PerCell<u32>,
    /// Encoder-only: search the ±1 neighborhood of the DC codes for the
    /// triple minimizing post-clip sRGB error (off only for ablation).
    pub dc_search: bool,
    /// AC companding family per channel group (sweep-only; defaults reproduce
    /// the shipped µ-law bytes exactly).
    pub compand_l: Companding,
    pub compand_c: Companding,
    pub compand_alpha: Companding,
    /// Trained codebooks used when the group's family is [`Companding::Table`].
    pub table_l: QuantTable,
    pub table_c: QuantTable,
    pub table_alpha: QuantTable,
    /// Encoder deadzone per group: a normalized |value/scale| below this
    /// quantizes to the exact-zero center code. 0.0 disables (shipped).
    pub deadzone_l: f64,
    pub deadzone_c: f64,
    pub deadzone_alpha: f64,
    /// Scalefactor-band experiment (MP3/AAC-style): coefficients at selection
    /// index ≥ floor(count·band_split) quantize against `scale·band_gain_*`
    /// instead of `scale`, symmetric in encode and decode. Gain 1.0 disables.
    pub band_split: f64,
    pub band_gain_l: f64,
    pub band_gain_c: f64,
    /// Anisotropic (CSF oblique-effect) selection weight: sorts candidates by
    /// priority·(1 + aniso·sin²2θ), penalizing diagonals, so the budget goes to
    /// axis-aligned detail first. Human contrast sensitivity is lower for
    /// diagonal frequencies, and the corpus agrees. 0.0 reproduces the pure
    /// priority order coefficient for coefficient.
    ///
    /// Quantized to Q12 and compared as an exact integer key
    /// (`dct::selection_key`, spec §6.2) — the order is bit-exact across
    /// languages, and costs no more than the unweighted sort.
    pub aniso_oblique: f64,
    /// Encoder-only: pick the AC code whose *dequantized* value is closest to
    /// the coefficient, instead of the code nearest in the companded domain.
    /// The shipped quantizer rounds in µ-law space, which is not the same
    /// decision — µ-law levels are unevenly spaced, so the nearest compressed
    /// level is not always the nearest reconstruction. Costs a ±2 neighborhood
    /// search per coefficient and zero bits; the decoder is untouched.
    pub ac_nearest: bool,
    /// Encoder-only AC scale-factor policy (zero wire cost — every mode writes
    /// a legal scale code and the decoder is untouched):
    /// * `0` — shipped: code = round(max|AC| / max_scale), coefficients
    ///   normalized by the **unquantized** max|AC|.
    /// * `1` — normalize by the dequantized scale the decoder will actually
    ///   use, removing the encoder/decoder scale mismatch.
    /// * `2` — search every scale code for the one minimizing reconstruction
    ///   SSE over the channel's AC set (clipping a lone outlier can buy back
    ///   resolution for everything else).
    pub scale_fit: u32,
    /// Encoder-only: use the separable forward DCT prototype
    /// (`dct::dct_encode_selected_separable`) instead of the direct 2-D sum.
    ///
    /// **Not byte-identical** — factoring the sum changes floating-point
    /// association, so this is a measurement knob for costing a possible future
    /// transform, never a shipped setting. `false` here and in every binding
    /// (none of which expose `Tunables` at all).
    pub dct_separable: bool,
    /// `spec/PERFORMANCE.md` §12.1's byte-identical acceleration levers, one
    /// flag per lever so each can be timed as its own arm.
    ///
    /// Unlike [`Tunables::dct_separable`], every one of these produces the
    /// same bytes as the path it replaces — the unit tests beside each one and
    /// `tests/accel_levers.rs` hold them to that over the spec vectors and a
    /// randomized input set. [`Tunables::DEFAULT`] turns on each lever whose
    /// paired instruction count (`mise run benchmark:counts`, committed under
    /// `tools/comparison/results/counts/ab/accel-*.json`) is a reduction: all
    /// seven. Off, a flag selects the
    /// unaccelerated path, which stays as the reference
    /// `mise run lever-identity` and `benchmark:counts` compare the shipped
    /// path against (`accel_*=0`); either setting changes the time an
    /// operation takes and nothing else.
    ///
    /// §12.1 items 1 and 2: a per-job dequantization table keyed on
    /// `(bit width, index)`, the per-index bit widths computed once, and the
    /// µ-law denominator `ln(1 + µ)` hoisted out of every quantize call.
    pub accel_quant_table: bool,
    /// §12.1 item 3: the forward DCT computes four coefficients per pass over
    /// the channel, one lane each, with each lane's sum in the scalar order.
    pub accel_dct_lanes: bool,
    /// §12.1 item 4(a): the decoder's 4096-entry gamma table is built once
    /// per output transfer curve and reused, not rebuilt on every decode.
    pub accel_gamma_lut_cache: bool,
    /// §12.1 item 4(b), the layout half: the decoder's cosine tables are one
    /// contiguous row-major array per axis rather than a `Vec` per frequency.
    pub accel_flat_cos: bool,
    /// §12.1 item 5: the refinement's candidate scorer stops summing once its
    /// partial error can no longer beat the best candidate so far.
    pub accel_sse_early_exit: bool,
    /// §12.1 item 6: `linearize`, `oklab_forward` and `alpha_average` run as
    /// one tiled pass, and the per-pixel alpha buffer is built only when the
    /// image has alpha to transform.
    ///
    /// On in [`Tunables::DEFAULT`] since #165, which removed the per-element
    /// bounds checks that had made it cost more instructions than the four
    /// separate passes (#142 left it off on that count). Its paired count on
    /// a 512×512 tier-1 encode is `results/counts/ab/accel-fused-pixels.json`.
    pub accel_fused_pixels: bool,
    /// §12.1 item 7: each bit field is shifted into place as one word and
    /// OR-ed a byte at a time, instead of one bit at a time.
    pub accel_word_bitpack: bool,
    /// Encoder-only pixel-domain refinement passes (0 = off, the shipped
    /// behaviour). Each pass is a coordinate descent over the AC codes —
    /// optionally the DC and scale codes too — scored by the error of the
    /// *decoded pixels* rather than of the coefficients. Coefficient-domain
    /// SSE is separable and independently-rounded codes already minimize it;
    /// the decoded error is not separable, because the render path clamps L
    /// and clips each output channel into gamut. That non-linearity is the one
    /// place independent rounding is provably not optimal.
    pub refine_passes: u32,
    /// Largest code offset tried per coefficient during refinement.
    pub refine_delta: u32,
    /// Refinement objective: `0` = squared error in gamma-encoded sRGB (models
    /// the whole decode path, including the gamut clip), `1` = squared error in
    /// OKLAB with no clipping model (the cheap control — should behave like the
    /// coefficient-domain search), `2` = squared error in OKLAB *after* the
    /// gamut clip (perceptual, and models the clip).
    pub refine_obj: u32,
    /// Include the three DC codes as refinement coordinates. The shipped DC
    /// search optimizes the flat-colour target with the AC set assumed zero;
    /// with AC present a different DC can cancel clipping.
    pub refine_dc: bool,
    /// Include the AC scale codes as refinement coordinates. Amplitude that
    /// pushes a pixel out of gamut is discarded at decode, so trading it for
    /// resolution everywhere else can pay — clipping pre-compensation, chosen
    /// by measurement rather than by rule.
    pub refine_scale: bool,
    /// Encoder-only closed-loop passes: decode, take the residual against the
    /// source, re-project it onto the *same* selected basis, add it to the
    /// unquantized coefficients and requantize. Cheaper than the coordinate
    /// descent and strictly weaker, but a clean ablation of "does re-projection
    /// alone recover anything the first projection lost?"
    pub reproject_passes: u32,
    /// Width of the aspect field. 8 bits is the shipped ~1.09% max ratio error;
    /// narrower fields coarsen the aspect grid symmetrically about 1:1 and hand
    /// the saved bits to the AC payload. The 54-bit prefix is 21% of a 32-byte
    /// hash and 32% of a 21-byte one, so at small budgets this is the largest
    /// pool of recoverable bits in the format.
    pub aspect_bits: u32,
    /// DC field widths (shipped 7/7/7).
    pub l_dc_bits: u32,
    pub a_dc_bits: u32,
    pub b_dc_bits: u32,
    /// AC scale field widths (shipped 6/6/5).
    pub l_scale_bits: u32,
    pub a_scale_bits: u32,
    pub b_scale_bits: u32,
    /// Drop the b-scale field and reuse the a-scale for both chroma channels.
    /// Saves `b_scale_bits` outright; costs whatever the two scales actually
    /// differ by, which the range-asymmetry evidence suggests is little.
    pub b_scale_from_a: bool,
    /// µ-law parameter for the AC scale fields (0 = the shipped linear grid).
    /// Corpus scales cluster well below the range maximum, so a logarithmic
    /// grid should carry the same accuracy in fewer bits.
    pub scale_mu: f64,
    /// Horizontal/vertical selection asymmetry: sorts candidates by
    /// `priority·(1 + aniso·sin²2θ)·(1 + hv·cos2θ)`. Positive values push
    /// horizontal frequencies (vertical edges) down the order. Generalizes the
    /// oblique-effect weight into the 2-parameter family a corpus-trained
    /// selection order would live in. Shares the Q12 integer key with
    /// [`Tunables::aniso_oblique`]; `|hv| < 1` keeps the weight positive.
    pub sel_hv: f64,
    /// Alpha DC code width, in bits (alpha mode only). The quantizer's top code
    /// is `2^bits - 1`, so narrowing this coarsens the flat alpha level rather
    /// than clipping it.
    pub alpha_dc_bits: u32,
    /// Alpha AC scale-factor code width, in bits (alpha mode only).
    pub alpha_scale_bits: u32,
    /// Quantize the alpha AC plane through the same path as L/a/b, so
    /// [`Tunables::scale_fit`] and [`Tunables::ac_nearest`] apply to it.
    ///
    /// Alpha has always used a bare quantizer and a nominal scale code, so
    /// every encoder-side improvement since v0.6 has skipped it — the alpha
    /// channel runs a generation behind the channels beside it. `false`
    /// reproduces that legacy path exactly.
    pub alpha_ac_fit: bool,
    /// Grid the pixel-domain refinement scores on: `0` = the encoder input
    /// (reconstruct the source as well as possible), `1` = the **natural render
    /// grid**, against the ideal full-basis downsample of the source — i.e. the
    /// pixels a decoder will actually emit. The two are different objectives:
    /// the encoder input is 100 px here while a default-tier decode is 32 px.
    pub refine_grid: u32,
    /// Per-channel weights for `refine_obj = 3` (clipped OKLAB, weighted).
    /// `refine_wl` scales the L term, `refine_wc` the a/b terms. Lets the
    /// objective be steered between "match the pixels" and "match the colour",
    /// which is what the metric actually rewards.
    pub refine_wl: f64,
    pub refine_wc: f64,
    /// Chroma-from-luma: width of each signalled per-channel gain field
    /// (0 = off, the shipped format). Each chroma AC coefficient is coded as a
    /// residual against `alpha · (the decoder's dequantized luma AC at the same
    /// selection index)`. Costs `2 · cfl_bits` prefix bits and pays only if the
    /// residual's scale shrinks by more than that. Wire-level.
    pub cfl_bits: u32,
    /// Range of the signalled CfL gain: alpha spans [-cfl_range, +cfl_range].
    pub cfl_range: f64,
    /// Decoder-side detail synthesis: how many frequencies *beyond* the coded
    /// set to synthesize at render time, seeded deterministically from the hash
    /// bytes. Costs zero bytes and attacks the format's real weakness — it
    /// wins dE00 but loses SSIMULACRA2/DSSIM to real codecs, because every bit
    /// goes to a handful of global low frequencies and the result is too smooth.
    pub synth_count: usize,
    /// Amplitude of the synthesized detail, as a fraction of the RMS of the
    /// highest-frequency quarter of the coded luma AC set. 0 disables.
    pub synth_gain: f64,
    /// Embedded/progressive AC order (register entry D2): write the AC codes
    /// of every channel merged by frequency priority instead of
    /// channel-sequentially, so a truncated payload still carries the lowest
    /// frequencies of every channel. In alpha mode the alpha AC codes join the
    /// merge as a fourth channel. It is a pure permutation of the fixed-width
    /// fields: the length, the prefix and every code are unchanged, and the
    /// full-length decode is the shipped one. This is the structural
    /// prerequisite for a tier-t hash being a usable prefix of a tier-t+1 one.
    /// It applies to the fixed-width fields only; with [`Tunables::ac_coder`]
    /// on, the coded stream keeps its own order.
    pub interleave: bool,
    /// Decode only the first `trunc_bytes` bytes, treating every AC code that
    /// falls past them as the exact-zero centre code (0 = decode it all).
    /// Measurement-only: it is how a progressive decoder would behave.
    pub trunc_bytes: usize,
    /// Decode only the prefix a code-`k` hash of the same alpha mode would
    /// occupy (`body_len_bytes` under these tunables), as [`Self::trunc_bytes`]
    /// does for a byte count. This is register entry D2's cut: the code-`k`
    /// length taken from a longer hash, which differs between the opaque and
    /// the alpha mode, so a sweep over both cannot name it as one byte count.
    /// `None` (the default) decodes it all; a cut at or past the hash's own
    /// length is no cut. When both are set, the shorter cut applies.
    /// Measurement-only.
    pub cut_tier: Option<u8>,
    /// AC payload coding (register entry D1, `spec/V0.8-DECISIONS.md`).
    /// `0` is the shipped fixed-width fields. `1` codes every AC code, in the
    /// channel-sequential order, as one adaptive binary arithmetic-coded
    /// stream (`bitpack::AcModels`) that fills the rest of the hash, whose
    /// length stays the one the *shipped* layout gives the same tier and
    /// alpha mode (`body_len_bytes`): the layout's counts and widths then
    /// bound what the stream may carry rather than fix its size, and the
    /// encoder zeroes the highest-index codes until the stream fits. Every
    /// bit string of that length decodes (the code is total), so the length
    /// check stays the whole validity check.
    ///
    /// `2` is the adaptive form (U13's per-image signalled selection): the
    /// first payload bit chooses, per image, between the coded stream (`1`,
    /// in the bits after it) and the shipped fixed-width fields (`0`, one bit
    /// later than they would sit; every shipped layout at codes 2–4 leaves a
    /// padding bit for it). The encoder writes both and keeps the one with the
    /// smaller AC reconstruction error (`encode::encode_adaptive`), an encoder-side decision paid for inside the same
    /// bytes. Any other value reads as `1`. Wire-level.
    ///
    /// One entry per tier code. Generation v2 ships `1` at code 3 alone,
    /// where register entry D1 passed, and `0` everywhere else; the decoder
    /// reads the tier from the hash, so the coder is conditional on it.
    pub ac_coder: [u32; TIER_CODES],
    /// Downsampling before the transform (register entry D5,
    /// `spec/V0.8-DECISIONS.md`): resample a source of more than
    /// `downsample_edge²` pixels to a grid of about that many pixels, with
    /// the source's aspect, before the forward DCT, so the transform's cost
    /// stops growing with the source's pixel count. A source at or under the
    /// budget is encoded exactly as shipped, so the knob is conditional on an
    /// input property the encoder reads off the input.
    ///
    /// The kernel is the exact area (box) average: each grid cell is the
    /// integral mean of the source pixels it covers, with fractional
    /// coverage at its edges (`encode::area_downsample`). Two placements:
    ///
    /// * `0` — off, the shipped full-resolution encode.
    /// * `1` — **oklab**: the composited OKLAB planes (and the alpha plane)
    ///   are averaged after the shipped full-resolution colour pass, which is
    ///   linear ahead of a linear transform, so only the DCT moves to the grid.
    /// * `2` — **linear**: the linear-light RGB, premultiplied by alpha, and
    ///   the alpha plane are averaged straight off the source bytes, and the
    ///   colour pass, the alpha average and the composite run on the grid.
    ///
    /// The hash's aspect is always the source's. Every hash of a source over
    /// the budget changes, so this is a format change; any other value of
    /// `downsample` reads as off. Sweep-only: `0` here and in every binding.
    pub downsample: u32,
    /// Grid budget of [`Tunables::downsample`]: a source is resampled only if
    /// it has more than `downsample_edge²` pixels, to `round(w·s) × round(h·s)`
    /// with `s = downsample_edge / sqrt(w·h)`, never enlarging either axis.
    pub downsample_edge: u32,
}

impl Tunables {
    /// The v2 format constants. Generation v2 (0.8.0) is the v1 constants
    /// below with codes 3 and 4 changed by the v0.8 verdict
    /// (`spec/V0.8-DECISIONS.md`): their own rows ([`LAYOUT_T3`],
    /// [`LAYOUT_T4`]), the coded stream at code 3 ([`AC_CODER`]) and the
    /// synthesis window in two cells ([`WINDOW_W_MIN`]).
    ///
    /// The v1 constants were locked by the 2026-08 corpus sweep and
    /// re-verified on the 2026-09 Wikimedia re-source (tools/comparison,
    /// 39 curated photographs from Wikimedia Commons + Kodak24 over a
    /// tune/holdout split; spec/EXPERIMENTS.md §9.5). Nothing here moved
    /// under the re-source; the figures below did.
    ///
    /// Carried over from v0.6: chroma AC scale range 0.125 (v0.5: 0.5) is the
    /// single largest quality win (the corpus maximum chroma scale is 0.113 —
    /// the old range wasted two bits); chroma DC ranges sized to the
    /// display-output gamut hull (sRGB ∪ P3 ∪ Adobe); µ_C=8 exploits the finer
    /// chroma scale near zero; out-of-gamut chroma is clipped per-channel at
    /// decode (relative-colorimetric, §12.6); the synthesis window is DISABLED at codes 0–2
    /// (w_min=1.0) — with fine chroma scales it costs more detail than the
    /// banding it suppresses. (v0.5's visible striping was attributed to chroma
    /// quantization noise rather than luma ringing. That was about v0.5's
    /// constants: re-measured at v0.7's with an artifact metric that can see it,
    /// the structure the format invents is entirely luma, and a chroma-only
    /// taper is inert on every column — EXPERIMENTS.md §12.2. The window stays
    /// off on the trade it makes, not on which channel it acts on.)
    ///
    /// New in v1, and validated together on the old photographic holdout (since
    /// spent, EXPERIMENTS.md §11.12) at
    /// −3.72% mean ΔE00 with SSIMULACRA2, Butteraugli and DSSIM all improving
    /// (EXPERIMENTS.md §7.12, §8):
    ///
    /// * [`LAYOUT_T0`] at the default tier — more, coarser coefficients where the
    ///   budget is tightest, while codes 2..=4 keep [`LAYOUT_B`] scaled by `4^level`.
    /// * `aniso_oblique = 1.2`, `sel_hv = 0.15` — a perceptual selection order
    ///   (spec §6.2), integer-exact and free at decode.
    /// * `scale_fit = 2`, `ac_nearest = true` — encoder-only quantization
    ///   decisions that cost no bits and leave the decoder untouched.
    ///
    /// Deliberately *not* default: the pixel-domain refinement of §8.2. It is
    /// worth a further −0.3 pp at the default tier (§7.12: −3.72% → −4.01%) and
    /// costs ~54× encode time, so it belongs behind an encoder quality setting,
    /// not here.
    pub const DEFAULT: Tunables = Tunables {
        layout: LAYOUT_T0,
        layout_upper: LAYOUT_B,
        layout_compact: LAYOUT_TC,
        layout_t3: LAYOUT_T3,
        layout_t4: LAYOUT_T4,
        max_chroma_a: 0.35,
        max_chroma_b: 0.33,
        max_l_scale: 0.5,
        max_a_scale: 0.125,
        max_b_scale: 0.125,
        max_alpha_scale: 0.5,
        mu_l: 5.0,
        mu_c: 8.0,
        mu_alpha: 5.0,
        w_min_l: WINDOW_W_MIN,
        w_exp_l: [[1; TIER_CODES]; 2],
        w_min_c: WINDOW_W_MIN,
        w_exp_c: [[1; TIER_CODES]; 2],
        dc_search: true,
        compand_l: Companding::MuLaw,
        compand_c: Companding::MuLaw,
        compand_alpha: Companding::MuLaw,
        table_l: QuantTable::EMPTY,
        table_c: QuantTable::EMPTY,
        table_alpha: QuantTable::EMPTY,
        deadzone_l: 0.0,
        deadzone_c: 0.0,
        deadzone_alpha: 0.0,
        band_split: 0.5,
        band_gain_l: 1.0,
        band_gain_c: 1.0,
        aniso_oblique: 1.2,
        ac_nearest: true,
        scale_fit: 2,
        dct_separable: false,
        accel_quant_table: true,
        accel_dct_lanes: true,
        accel_gamma_lut_cache: true,
        accel_flat_cos: true,
        accel_sse_early_exit: true,
        accel_fused_pixels: true,
        accel_word_bitpack: true,
        refine_passes: 0,
        refine_delta: 1,
        refine_obj: 0,
        refine_dc: false,
        refine_scale: false,
        reproject_passes: 0,
        aspect_bits: 8,
        l_dc_bits: L_DC_BITS,
        a_dc_bits: A_DC_BITS,
        b_dc_bits: B_DC_BITS,
        l_scale_bits: L_SCALE_BITS,
        a_scale_bits: A_SCALE_BITS,
        b_scale_bits: B_SCALE_BITS,
        b_scale_from_a: false,
        scale_mu: 0.0,
        sel_hv: 0.15,
        alpha_dc_bits: ALPHA_DC_BITS,
        alpha_scale_bits: ALPHA_SCALE_BITS,
        alpha_ac_fit: false,
        refine_grid: 0,
        refine_wl: 1.0,
        refine_wc: 1.0,
        cfl_bits: 0,
        cfl_range: 0.5,
        synth_count: 0,
        synth_gain: 0.0,
        interleave: false,
        trunc_bytes: 0,
        cut_tier: None,
        ac_coder: AC_CODER,
        downsample: 0,
        downsample_edge: 256,
    };
}

impl Default for Tunables {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// M2: LMS (cube-root) → OKLAB [L, a, b] (Ottosson).
pub const M2: [[f64; 3]; 3] = [
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
];

/// M2_INV: OKLAB [L, a, b] → LMS (cube-root).
pub const M2_INV: [[f64; 3]; 3] = [
    [1.0000000000, 0.3963377774, 0.2158037573],
    [1.0000000000, -0.1055613458, -0.0638541728],
    [1.0000000000, -0.0894841775, -1.2914855480],
];

/// M1[sRGB]: Linear sRGB → LMS (Ottosson published).
pub const M1_SRGB: [[f64; 3]; 3] = [
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
];

/// M1[Display P3]: Linear Display P3 → LMS.
pub const M1_DISPLAY_P3: [[f64; 3]; 3] = [
    [0.4813798544, 0.4621183697, 0.0565017758],
    [0.2288319449, 0.6532168128, 0.1179512422],
    [0.0839457557, 0.2241652689, 0.6918889754],
];

/// M1[Adobe RGB]: Linear Adobe RGB → LMS.
pub const M1_ADOBE_RGB: [[f64; 3]; 3] = [
    [0.5764322615, 0.3699132211, 0.0536545174],
    [0.2963164739, 0.5916761266, 0.1120073994],
    [0.1234782548, 0.2194986958, 0.6570230494],
];

/// M1[BT.2020]: Linear BT.2020 → LMS.
pub const M1_BT2020: [[f64; 3]; 3] = [
    [0.6167557872, 0.3601983994, 0.0230458134],
    [0.2651330640, 0.6358393641, 0.0990275718],
    [0.1001026342, 0.2039065194, 0.6959908464],
];

/// M1[ProPhoto RGB]: Linear ProPhoto RGB → LMS (includes Bradford D50→D65).
pub const M1_PROPHOTO_RGB: [[f64; 3]; 3] = [
    [0.7154484635, 0.3527915480, -0.0682400115],
    [0.2744116551, 0.6677976408, 0.0577907040],
    [0.1097844385, 0.1861982875, 0.7040172740],
];

/// M1_INV[sRGB]: LMS → Linear sRGB (decoder matrix, Ottosson published).
pub const M1_INV_SRGB: [[f64; 3]; 3] = [
    [4.0767416621, -3.3077115913, 0.2309699292],
    [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.7076147010],
];

/// M1_INV[Display P3]: LMS → Linear Display P3 (inverse of M1_DISPLAY_P3).
pub const M1_INV_DISPLAY_P3: [[f64; 3]; 3] = [
    [3.1277689869, -2.2571357957, 0.1293668089],
    [-1.0910090475, 2.4133317585, -0.3223227108],
    [-0.0260108130, -0.5080413260, 1.5340521389],
];

/// M1_INV[Adobe RGB]: LMS → Linear Adobe RGB (inverse of M1_ADOBE_RGB).
pub const M1_INV_ADOBE_RGB: [[f64; 3]; 3] = [
    [2.5540368478, -1.6219762024, 0.0679393544],
    [-1.2684380042, 2.6097574007, -0.3413193963],
    [-0.0562347471, -0.5670418342, 1.6232765812],
];

impl Gamut {
    /// Return the M1 matrix for this gamut (linear gamut RGB → LMS), used at
    /// encode to ingest any source gamut.
    pub(crate) fn m1_matrix(self) -> &'static [[f64; 3]; 3] {
        match self {
            Gamut::Srgb => &M1_SRGB,
            Gamut::DisplayP3 => &M1_DISPLAY_P3,
            Gamut::AdobeRgb => &M1_ADOBE_RGB,
            Gamut::Bt2020 => &M1_BT2020,
            Gamut::ProPhotoRgb => &M1_PROPHOTO_RGB,
        }
    }

    /// Return the inverse M1 matrix (LMS → linear gamut RGB) for rendering
    /// decode output **to** this gamut. Only sRGB / Display P3 / Adobe RGB are
    /// valid display-output gamuts; BT.2020 (HDR PQ, no clean SDR inverse) and
    /// ProPhoto (not a display gamut) fall back to sRGB output.
    pub(crate) fn m1_inv_matrix(self) -> &'static [[f64; 3]; 3] {
        match self {
            Gamut::DisplayP3 => &M1_INV_DISPLAY_P3,
            Gamut::AdobeRgb => &M1_INV_ADOBE_RGB,
            Gamut::Srgb | Gamut::Bt2020 | Gamut::ProPhotoRgb => &M1_INV_SRGB,
        }
    }

    /// Whether decode output to this gamut uses the Adobe RGB gamma (γ = 2.2).
    /// sRGB and Display P3 share the sRGB piecewise transfer; the sRGB fallback
    /// gamuts (BT.2020/ProPhoto) use sRGB too.
    pub(crate) fn output_uses_adobe_gamma(self) -> bool {
        matches!(self, Gamut::AdobeRgb)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math_utils::matvec3;

    fn matmul3(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
        let mut c = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                for k in 0..3 {
                    c[i][j] += a[i][k] * b[k][j];
                }
            }
        }
        c
    }

    /// `ac_shape` scales *both* `l_tiers` entries by `4^level`. Every shipped
    /// layout has a zero second entry (`[(28, 4), (0, 4)]` and friends), so
    /// `0 * s == 0 / s` and the scaling of that entry is unobservable through
    /// the shipped tiers — a mutation of it survives every test in the crate.
    ///
    /// `LAYOUT_C` is the exception: it is the tiered-precision arm the sweep
    /// explores (`[(8, 6), (14, 5)]`), and it is *only* reachable through
    /// `Tunables`. Exercising it here is what pins the second entry's scaling,
    /// so a bug in it would be caught before the sweep ever adopted the layout.
    #[test]
    fn both_l_tier_entries_scale_with_the_tier() {
        let mut t = Tunables::DEFAULT;
        t.layout_upper = LAYOUT_C;
        t.layout_t3 = LAYOUT_C;
        assert_ne!(
            LAYOUT_C.l_tiers[1].0, 0,
            "this test needs a layout whose second L tier is non-empty"
        );

        // Tier 2 scales counts by 4^1; tier 3 by 4^2.
        for (tier, scale) in [(2u8, 4usize), (3, 16)] {
            for has_alpha in [false, true] {
                let shape = ac_shape(&t, has_alpha, tier);
                let src = if has_alpha {
                    LAYOUT_C.la_tiers
                } else {
                    LAYOUT_C.l_tiers
                };
                assert_eq!(
                    shape.l_tiers[0].0,
                    src[0].0 * scale,
                    "tier {tier} alpha={has_alpha}: first L tier"
                );
                assert_eq!(
                    shape.l_tiers[1].0,
                    src[1].0 * scale,
                    "tier {tier} alpha={has_alpha}: second L tier"
                );
            }
        }
    }

    /// The per-cell index the encoder's refinement reads its window through:
    /// the alpha flag picks the row and the tier code the column, and a
    /// reserved code reads the top tier's entry. The shipped encoder runs no
    /// refinement, so no vector reaches it; this pins it.
    #[test]
    fn cell_index_reads_the_alpha_flag_and_the_tier() {
        assert_eq!(cell_index(false, 0), (0, 0));
        assert_eq!(cell_index(true, 3), (1, 3));
        assert_eq!(cell_index(false, 4), (0, 4));
        assert_eq!(cell_index(true, MAX_TIER + 3), (1, MAX_TIER as usize));
        // The two cells the v0.8 verdict tapers, read through it.
        let (a, t) = cell_index(true, 3);
        assert_eq!(WINDOW_W_MIN[a][t], 0.85);
        let (a, t) = cell_index(false, 4);
        assert_eq!(WINDOW_W_MIN[a][t], 0.7);
    }

    fn identity_error(m: &[[f64; 3]; 3]) -> f64 {
        let mut err = 0.0_f64;
        for (i, row) in m.iter().enumerate() {
            for (j, value) in row.iter().enumerate() {
                let expected = if i == j { 1.0 } else { 0.0 };
                err = err.max((value - expected).abs());
            }
        }
        err
    }

    #[test]
    fn m2_times_m2_inv_is_identity() {
        let product = matmul3(&M2, &M2_INV);
        assert!(
            identity_error(&product) < 5e-8,
            "M2 × M2_INV should be identity"
        );
    }

    #[test]
    fn m1_srgb_times_m1_inv_srgb_is_identity() {
        let product = matmul3(&M1_SRGB, &M1_INV_SRGB);
        assert!(
            identity_error(&product) < 5e-8,
            "M1[sRGB] × M1_INV[sRGB] should be identity"
        );
    }

    #[test]
    fn output_inverse_matrices_invert_their_m1() {
        // Each display-output gamut's M1_INV must be the inverse of its M1.
        for (name, m1, m1_inv) in [
            ("Display P3", &M1_DISPLAY_P3, &M1_INV_DISPLAY_P3),
            ("Adobe RGB", &M1_ADOBE_RGB, &M1_INV_ADOBE_RGB),
        ] {
            let product = matmul3(m1, m1_inv);
            assert!(
                identity_error(&product) < 5e-8,
                "M1[{name}] × M1_INV[{name}] should be identity"
            );
        }
    }

    #[test]
    fn output_gamut_selectors_resolve() {
        // sRGB / P3 / Adobe are real output gamuts; BT.2020 / ProPhoto fall back
        // to sRGB (no clean SDR display inverse).
        assert_eq!(*Gamut::Srgb.m1_inv_matrix(), M1_INV_SRGB);
        assert_eq!(*Gamut::DisplayP3.m1_inv_matrix(), M1_INV_DISPLAY_P3);
        assert_eq!(*Gamut::AdobeRgb.m1_inv_matrix(), M1_INV_ADOBE_RGB);
        assert_eq!(*Gamut::Bt2020.m1_inv_matrix(), M1_INV_SRGB);
        assert_eq!(*Gamut::ProPhotoRgb.m1_inv_matrix(), M1_INV_SRGB);
        assert!(Gamut::AdobeRgb.output_uses_adobe_gamma());
        assert!(!Gamut::DisplayP3.output_uses_adobe_gamma());
        assert!(!Gamut::Srgb.output_uses_adobe_gamma());
    }

    #[test]
    fn m1_white_point_mapping() {
        let gamuts: &[(&str, &[[f64; 3]; 3])] = &[
            ("sRGB", &M1_SRGB),
            ("Display P3", &M1_DISPLAY_P3),
            ("Adobe RGB", &M1_ADOBE_RGB),
            ("BT.2020", &M1_BT2020),
            ("ProPhoto RGB", &M1_PROPHOTO_RGB),
        ];
        for (name, m1) in gamuts {
            let w = matvec3(m1, [1.0, 1.0, 1.0]);
            let err = (w[0] - 1.0)
                .abs()
                .max((w[1] - 1.0).abs())
                .max((w[2] - 1.0).abs());
            assert!(
                err < 1e-8,
                "M1[{name}] × (1,1,1) should ≈ (1,1,1), err={err}"
            );
        }
    }

    #[test]
    fn m2_white_maps_to_l1_a0_b0() {
        let r = matvec3(&M2, [1.0, 1.0, 1.0]);
        assert!((r[0] - 1.0).abs() < 5e-8, "M2×(1,1,1) L should ≈ 1");
        assert!(r[1].abs() < 5e-8, "M2×(1,1,1) a should ≈ 0");
        assert!(r[2].abs() < 5e-8, "M2×(1,1,1) b should ≈ 0");
    }
}
