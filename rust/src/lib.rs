//! ChromaHash — a compact, perceptual image placeholder (LQIP).
//!
//! ChromaHash encodes any image into a compact code that decodes back
//! into a smooth, color-accurate thumbnail — the kind of blurred placeholder you
//! show while the full image loads. The default code is **32 bytes** ([`DEFAULT_TIER`]); a
//! [quality multiplier](ChromaHash::encode_with_quality) trades size for detail.
//! It works in the perceptual
//! [OKLab](https://bottosson.github.io/posts/oklab/) color space, supports
//! wide-gamut sources (Display P3, Adobe RGB, BT.2020, ProPhoto RGB) and an
//! alpha channel, and is bit-exact across platforms and languages: the same
//! input always produces the same 32 bytes. The core crate has **zero runtime
//! dependencies**.
//!
//! # Quick start
//!
//! ```
//! use chromahash::{ChromaHash, Gamut};
//!
//! // A 2×2 RGBA image (4 bytes per pixel).
//! let rgba: [u8; 16] = [
//!     255, 0, 0, 255, /**/ 0, 255, 0, 255,
//!     0, 0, 255, 255, /**/ 255, 255, 0, 255,
//! ];
//!
//! // Encode to a compact hash (the default tier = 32 bytes), tagging the source space.
//! let hash = ChromaHash::encode(2, 2, &rgba, Gamut::Srgb);
//! let bytes: &[u8] = hash.as_bytes(); // store or transmit these
//!
//! // Later: validate and reconstruct a placeholder at its natural size, or…
//! let (w, h, pixels) = ChromaHash::from_bytes(bytes).unwrap().decode();
//! assert_eq!(pixels.len(), (w * h * 4) as usize);
//!
//! // …grab just the average color for an instant solid-color fill.
//! let [r, g, b, a] = hash.average_color();
//! # let _ = (r, g, b, a);
//! ```
//!
//! # API surface
//!
//! [`ChromaHash`] is the whole public API:
//!
//! - [`ChromaHash::encode`] — image → hash.
//! - [`ChromaHash::decode`] / [`decode_to`](ChromaHash::decode_to) — hash → RGBA
//!   at its natural size, optionally in a chosen output [`Gamut`].
//! - [`decode_capped`](ChromaHash::decode_capped) /
//!   [`decode_capped_to`](ChromaHash::decode_capped_to) — render no larger than
//!   the given bounds (a band-limited render, free of aliasing).
//! - [`average_color`](ChromaHash::average_color) — the DC color, without a full
//!   decode.
//! - [`encode_with_quality`](ChromaHash::encode_with_quality) — image → hash at a
//!   chosen tier (`0..=4`, ordered by quality; `COMPACT_TIER` = 0 is 21 bytes); higher tiers
//!   carry more detail in more bytes.
//! - [`from_bytes`](ChromaHash::from_bytes) / [`as_bytes`](ChromaHash::as_bytes)
//!   — round-trip the raw bytes; `from_bytes` validates and is fallible.
//!
//! [`BatchEncoder`] amortizes setup across many images for higher throughput;
//! its output is byte-identical to calling [`ChromaHash::encode`] per image.
//!
//! # Versioning
//!
//! This crate (release 0.7.x) implements wire-format generation **v1**. A hash
//! is self-describing: byte 0 carries the format version and quality tier, and
//! the byte length follows from them. [`ChromaHash::from_bytes`] validates all of
//! this and returns [`ChromaHashError`] for anything malformed — a hash that
//! validates is guaranteed decodable. There is **no** backward compatibility with
//! the older v0.6 bitstream. The format is a pre-1.0 **draft**, not yet
//! guaranteed stable across releases.
//!
//! # Feature flags
//!
//! - **`simd`** *(default)* — enable the SIMD backends (AVX2/SSE2, NEON,
//!   wasm simd128). Each replays the scalar path op-for-op, so output is
//!   byte-identical; disabling it only changes speed.
//! - **`spec-vectors`** *(default)* — compile the shared `spec/test-vectors`
//!   integration test. Test-only; no effect on the library.
//! - **`simd-diff-tests`** / **`full`** — opt-in scalar-vs-SIMD differential
//!   tests (dev-only). See `TESTING.md`.

mod aspect;
mod batch;
mod bitpack;
mod color;
mod constants;
mod dct;
mod decode;
mod encode;
mod math_utils;
mod mulaw;
mod simd;
mod test_vectors;
mod transfer;

pub use batch::{BatchEncoder, ImageInput};
/// Tier code of the **compact tier** — 21 bytes, the smallest and lowest-
/// fidelity tier, rendered at [`DEFAULT_TIER`]'s resolution.
pub use constants::COMPACT_TIER;
/// Tier code of the **default tier** — exactly 32 bytes, what
/// [`ChromaHash::encode`] produces.
///
/// Pass this rather than a literal to [`ChromaHash::encode_with_quality`]: the
/// codes are ordered by quality, so a bare `0` selects the compact tier.
pub use constants::DEFAULT_TIER;
pub use constants::Gamut;
/// Highest tier code [`ChromaHash::encode_with_quality`] accepts (`0..=4`).
///
/// Tier codes are ordered by quality, so this is both the highest-quality tier
/// and the largest valid code.
pub use constants::MAX_TIER;
/// Is `tier` a code this format defines? `0..=`[`MAX_TIER`]; codes `5..=7`
/// remain reserved and are rejected.
pub use constants::is_valid_tier;

/// The format generation this build writes and accepts — the `version` field of
/// byte 0.
///
/// Public because it describes the *format*, not this crate's implementation of
/// it, and the FFI layers re-export it so a binding can name the generation it
/// speaks instead of writing a literal.
///
/// The rest of the byte-0 layout (`VERSION_BITS`, `TIER_BITS`, the flag bit
/// positions, `PREFIX_BITS`) stays private. Publishing it was considered and
/// rejected: nothing outside this crate needs to *assemble* a header — the
/// bindings hand bytes to `from_bytes` and let it validate — and a pre-1.0
/// crate should not carry public items with no consumer.
pub use constants::FORMAT_VERSION;

use constants::{
    ALPHA_FLAG_BIT, PREFIX_BITS, RESERVED_FLAG_BIT, TIER_BITS, VERSION_BITS, body_len_bytes,
};

// Tuning interface for the comparison harness: not part of the public API.
// `Tunables::DEFAULT` is the v1 default-tier format; overrides exist solely so the
// corpus sweep (tools/comparison) can explore constants before they are
// locked into the spec.
#[doc(hidden)]
pub use constants::{
    AcLayout, Companding, LAYOUT_A, LAYOUT_B, LAYOUT_C, LAYOUT_D, LAYOUT_T0, LAYOUT_TC, QuantTable,
    Tunables,
};
#[doc(hidden)]
pub use encode::{CoeffDump, encode_debug_coefficients};

/// Per-stage encode timing for `mise run benchmark:stages`. Compiled only under
/// the off-by-default `bench-internals` feature, so this is not part of the
/// published API surface — see `encode::stage_timing`.
#[cfg(feature = "bench-internals")]
#[doc(hidden)]
pub use encode::stage_timing;

/// ChromaHash: a compact LQIP (Low Quality Image Placeholder).
///
/// The encoded form is variable length: 32 bytes at the default tier, and roughly 4×
/// larger per quality tier (see [`encode_with_quality`](Self::encode_with_quality)).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChromaHash {
    hash: Box<[u8]>,
}

impl ChromaHash {
    /// Encode an image into a ChromaHash.
    ///
    /// - `w`, `h`: image dimensions (>= 1 each)
    /// - `rgba`: pixel data in RGBA format (4 bytes per pixel)
    /// - `gamut`: source color space
    ///
    /// # Panics
    ///
    /// Panics if `w` or `h` is 0, or if `rgba.len()` is not exactly
    /// `w * h * 4`.
    pub fn encode(w: u32, h: u32, rgba: &[u8], gamut: Gamut) -> Self {
        Self {
            hash: encode::encode(w, h, rgba, gamut),
        }
    }

    /// Encode an image at an explicit `tier` (`0..=`[`MAX_TIER`], ordered by
    /// quality).
    ///
    /// [`DEFAULT_TIER`] (1) is the 32-byte placeholder; [`COMPACT_TIER`] (0) is
    /// 21 bytes at the same render resolution. Each code above the default
    /// doubles the natural render resolution (long edge `32 · 2^level`) and
    /// roughly quadruples the byte length, carrying proportionally more detail.
    /// [`encode`](Self::encode) is exactly
    /// `encode_with_quality(.., DEFAULT_TIER)` — note that a literal `0` here
    /// selects the *compact* tier, not the default.
    ///
    /// Decode cost grows ~16× per level, so [`MAX_TIER`] (256 px) is best
    /// reserved for when the extra fidelity is worth the compute.
    ///
    /// # Panics
    ///
    /// Panics if `w` or `h` is 0, if `rgba.len()` is not exactly `w * h * 4`,
    /// or if `quality` is not a valid tier code (see [`is_valid_tier`]).
    pub fn encode_with_quality(w: u32, h: u32, rgba: &[u8], gamut: Gamut, quality: u8) -> Self {
        Self {
            hash: encode::encode_quality(w, h, rgba, gamut, quality),
        }
    }

    /// Decode a ChromaHash into an RGBA image.
    /// Returns (width, height, rgba_pixels).
    ///
    /// Output is unspecified for a hash this build does not support; check
    /// [`is_version_supported`](Self::is_version_supported) first when the hash's
    /// provenance is unknown.
    pub fn decode(&self) -> (u32, u32, Vec<u8>) {
        decode::decode(&self.hash)
    }

    /// Decode a ChromaHash into an RGBA image in the given output gamut.
    ///
    /// `output` selects the display gamut to render into: `Srgb`, `DisplayP3`,
    /// or `AdobeRgb`. Wide-gamut colors are rendered at full saturation when the
    /// target gamut can represent them, and clipped (relative-colorimetric) to
    /// the target otherwise. `Bt2020` and `ProPhotoRgb` are not display-output
    /// gamuts and fall back to sRGB. Returns (width, height, rgba_pixels).
    pub fn decode_to(&self, output: Gamut) -> (u32, u32, Vec<u8>) {
        decode::decode_to(&self.hash, output)
    }

    /// Decode a ChromaHash into an RGBA image, capped at the given max dimensions.
    /// Useful when the decoded size would exceed the source image dimensions.
    /// Returns (width, height, rgba_pixels).
    pub fn decode_capped(&self, max_w: u32, max_h: u32) -> (u32, u32, Vec<u8>) {
        decode::decode_capped(&self.hash, max_w, max_h)
    }

    /// Decode capped at the given max dimensions, in the given output gamut.
    /// Returns (width, height, rgba_pixels).
    pub fn decode_capped_to(&self, max_w: u32, max_h: u32, output: Gamut) -> (u32, u32, Vec<u8>) {
        decode::decode_capped_to(&self.hash, max_w, max_h, output)
    }

    /// Extract the average color without full decode.
    /// Returns [r, g, b, a] as u8 values.
    pub fn average_color(&self) -> [u8; 4] {
        decode::average_color(&self.hash)
    }

    /// Create a ChromaHash from raw encoded bytes, validating the format.
    ///
    /// Checks the version, quality tier, reserved bits, and that the byte length
    /// matches the length the header implies. Returns [`ChromaHashError`] for
    /// anything malformed; an `Ok` value is guaranteed to
    /// [`decode`](Self::decode) without error. This is the cheap, robust
    /// "is this a usable hash?" check — there is no separate checksum (a
    /// structurally valid hash that was corrupted into another valid hash simply
    /// decodes to a different image). Per spec §2 (v1).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ChromaHashError> {
        // Need at least the fixed descriptor + aspect + DC/scale prefix.
        if bytes.len() < (PREFIX_BITS as usize).div_ceil(8) {
            return Err(ChromaHashError::TooShort);
        }
        let b0 = bytes[0];
        if b0 & ((1 << VERSION_BITS) - 1) != FORMAT_VERSION {
            return Err(ChromaHashError::UnsupportedVersion);
        }
        let tier = (b0 >> VERSION_BITS) & ((1 << TIER_BITS) - 1);
        if !is_valid_tier(tier) {
            return Err(ChromaHashError::InvalidTier);
        }
        if (b0 >> RESERVED_FLAG_BIT) & 1 != 0 {
            return Err(ChromaHashError::ReservedBitSet);
        }
        let has_alpha = (b0 >> ALPHA_FLAG_BIT) & 1 == 1;
        if bytes.len() != body_len_bytes(&Tunables::DEFAULT, has_alpha, tier) {
            return Err(ChromaHashError::LengthMismatch);
        }
        Ok(Self {
            hash: Box::from(bytes),
        })
    }

    /// Validate raw bytes against an explicit tunable layout (harness sweep
    /// interface). [`from_bytes`](Self::from_bytes) checks the length implied by
    /// the *shipped* layout; a sweep that resizes the AC layout produces a
    /// legitimately different length, so the runner must validate against the
    /// same `Tunables` it encoded with.
    #[doc(hidden)]
    pub fn from_bytes_tuned(bytes: &[u8], t: &Tunables) -> Result<Self, ChromaHashError> {
        if bytes.len() < (crate::constants::prefix_bits(t) as usize).div_ceil(8) {
            return Err(ChromaHashError::TooShort);
        }
        let b0 = bytes[0];
        if b0 & ((1 << VERSION_BITS) - 1) != FORMAT_VERSION {
            return Err(ChromaHashError::UnsupportedVersion);
        }
        let tier = (b0 >> VERSION_BITS) & ((1 << TIER_BITS) - 1);
        if !is_valid_tier(tier) {
            return Err(ChromaHashError::InvalidTier);
        }
        if (b0 >> RESERVED_FLAG_BIT) & 1 != 0 {
            return Err(ChromaHashError::ReservedBitSet);
        }
        let has_alpha = (b0 >> ALPHA_FLAG_BIT) & 1 == 1;
        if bytes.len() != body_len_bytes(t, has_alpha, tier) {
            return Err(ChromaHashError::LengthMismatch);
        }
        Ok(Self {
            hash: Box::from(bytes),
        })
    }

    /// Encode with explicit tunables (comparison-harness sweep interface).
    #[doc(hidden)]
    pub fn encode_tuned(w: u32, h: u32, rgba: &[u8], gamut: Gamut, t: &Tunables) -> Self {
        Self {
            hash: encode::encode_with(w, h, rgba, gamut, t, DEFAULT_TIER),
        }
    }

    /// Encode with explicit tunables and quality tier (harness interface — lets
    /// the comparison/benchmark tools sweep constants *and* exercise tiers).
    #[doc(hidden)]
    pub fn encode_tuned_quality(
        w: u32,
        h: u32,
        rgba: &[u8],
        gamut: Gamut,
        t: &Tunables,
        quality: u8,
    ) -> Self {
        Self {
            hash: encode::encode_with(w, h, rgba, gamut, t, quality),
        }
    }

    /// Decode with explicit tunables (comparison-harness sweep interface).
    #[doc(hidden)]
    pub fn decode_tuned(&self, t: &Tunables) -> (u32, u32, Vec<u8>) {
        decode::decode_with(&self.hash, t)
    }

    /// Decode to an output gamut with explicit tunables (harness interface).
    #[doc(hidden)]
    pub fn decode_to_tuned(&self, output: Gamut, t: &Tunables) -> (u32, u32, Vec<u8>) {
        decode::decode_to_with(&self.hash, t, output)
    }

    /// Capped decode with explicit tunables (comparison-harness sweep interface).
    #[doc(hidden)]
    pub fn decode_capped_tuned(&self, max_w: u32, max_h: u32, t: &Tunables) -> (u32, u32, Vec<u8>) {
        decode::decode_capped_with(&self.hash, max_w, max_h, t)
    }

    /// Capped decode to an output gamut with explicit tunables (harness interface).
    #[doc(hidden)]
    pub fn decode_capped_to_tuned(
        &self,
        max_w: u32,
        max_h: u32,
        output: Gamut,
        t: &Tunables,
    ) -> (u32, u32, Vec<u8>) {
        decode::decode_capped_to_with(&self.hash, max_w, max_h, t, output)
    }

    /// Render at an exact target raster, above or below the natural one, with
    /// explicit tunables (comparison-harness interface).
    ///
    /// Every other decode entry point renders at the natural raster or takes a
    /// `min` against it, so this is the only way to ask for the reconstruction
    /// *above* natural size. See [`decode::decode_at_size_to_with`].
    ///
    /// Research surface, gated on the `research-render` feature.
    #[cfg(feature = "research-render")]
    #[doc(hidden)]
    pub fn decode_at_size_tuned(
        &self,
        w: u32,
        h: u32,
        output: Gamut,
        t: &Tunables,
    ) -> (u32, u32, Vec<u8>) {
        decode::decode_at_size_to_with(&self.hash, w, h, t, output)
    }

    /// Get the raw encoded bytes (length depends on the quality tier; 32 bytes
    /// at the default tier).
    pub fn as_bytes(&self) -> &[u8] {
        &self.hash
    }
}

/// Why a byte string is not a decodable v1 [`ChromaHash`] — returned by
/// [`ChromaHash::from_bytes`]. Bytes that produce none of these are guaranteed
/// to decode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChromaHashError {
    /// Fewer bytes than the fixed header requires.
    TooShort,
    /// The `version` field names a format generation this build does not implement.
    UnsupportedVersion,
    /// The `tier` field is greater than [`MAX_TIER`].
    InvalidTier,
    /// A reserved header bit is set (must be 0 in v1).
    ReservedBitSet,
    /// The byte length does not match the length the header implies.
    LengthMismatch,
}

impl core::fmt::Display for ChromaHashError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            ChromaHashError::TooShort => "byte string is shorter than the chromahash header",
            ChromaHashError::UnsupportedVersion => "unsupported chromahash format version",
            ChromaHashError::InvalidTier => "chromahash quality tier out of range",
            ChromaHashError::ReservedBitSet => "reserved chromahash header bit is set",
            ChromaHashError::LengthMismatch => "byte length does not match the chromahash header",
        })
    }
}

impl std::error::Error for ChromaHashError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default encode must stay exactly 32 bytes.
    ///
    /// The tier codes are ordered by quality, so `DEFAULT_TIER` is 1 and a bare
    /// `0` selects the 21-byte compact tier. Nothing about that mistake fails to
    /// compile and nothing about it fails to decode — only the byte count moves.
    /// This is the guard for it.
    #[test]
    fn default_encode_is_32_bytes() {
        let rgba = solid_image(4, 4, 128, 128, 128, 255);
        assert_eq!(
            ChromaHash::encode(4, 4, &rgba, Gamut::Srgb)
                .as_bytes()
                .len(),
            32
        );
        assert_eq!(
            ChromaHash::encode_with_quality(4, 4, &rgba, Gamut::Srgb, DEFAULT_TIER)
                .as_bytes()
                .len(),
            32
        );
        // ...and the compact tier is genuinely a different, smaller code.
        assert_eq!(
            ChromaHash::encode_with_quality(4, 4, &rgba, Gamut::Srgb, COMPACT_TIER)
                .as_bytes()
                .len(),
            21
        );
        assert_eq!(
            ChromaHash::encode(4, 4, &rgba, Gamut::Srgb).as_bytes(),
            ChromaHash::encode_with_quality(4, 4, &rgba, Gamut::Srgb, DEFAULT_TIER).as_bytes()
        );
    }

    /// Create a solid-color RGBA image.
    fn solid_image(w: u32, h: u32, r: u8, g: u8, b: u8, a: u8) -> Vec<u8> {
        let pixel_count = (w * h) as usize;
        let mut rgba = vec![0u8; pixel_count * 4];
        for i in 0..pixel_count {
            rgba[i * 4] = r;
            rgba[i * 4 + 1] = g;
            rgba[i * 4 + 2] = b;
            rgba[i * 4 + 3] = a;
        }
        rgba
    }

    /// Create a horizontal gradient RGBA image.
    fn horizontal_gradient(w: u32, h: u32) -> Vec<u8> {
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let t = x as f64 / (w - 1).max(1) as f64;
                let idx = ((y * w + x) * 4) as usize;
                rgba[idx] = (t * 255.0) as u8;
                rgba[idx + 1] = ((1.0 - t) * 255.0) as u8;
                rgba[idx + 2] = 128;
                rgba[idx + 3] = 255;
            }
        }
        rgba
    }

    #[test]
    fn has_alpha_flag_set_correctly() {
        // v1: the hasAlpha flag is bit 6 of the byte-0 descriptor.
        let rgba_opaque = solid_image(4, 4, 128, 128, 128, 255);
        let hash = ChromaHash::encode(4, 4, &rgba_opaque, Gamut::Srgb);
        assert_eq!(
            (hash.as_bytes()[0] >> 6) & 1,
            0,
            "opaque image should not have alpha flag"
        );

        let rgba_alpha = solid_image(4, 4, 128, 128, 128, 128);
        let hash = ChromaHash::encode(4, 4, &rgba_alpha, Gamut::Srgb);
        assert_eq!(
            (hash.as_bytes()[0] >> 6) & 1,
            1,
            "semi-transparent image should have alpha flag"
        );
    }

    #[test]
    fn decode_solid_color_pixels_exactly_uniform() {
        // v0.6's exact-zero quantizer means a solid color stores all-zero AC,
        // so every decoded pixel must be bit-identical — not just close.
        let rgba = solid_image(4, 4, 128, 128, 128, 255);
        let hash = ChromaHash::encode(4, 4, &rgba, Gamut::Srgb);
        let (w, h, pixels) = hash.decode();

        let first = &pixels[0..4];
        for i in 0..(w * h) as usize {
            assert_eq!(
                &pixels[i * 4..i * 4 + 4],
                first,
                "pixel {i} diverges from pixel 0"
            );
        }
    }

    #[test]
    fn solid_corner_colors_roundtrip_closely() {
        // The decode-aware DC search must keep saturated gamut-corner solids
        // near-exact. v0.5 decoded solid blue as (0, 58, 214) — ΔE00 7.75.
        for &(r, g, b) in &[
            (0u8, 0u8, 255u8),
            (255, 0, 0),
            (0, 255, 0),
            (255, 255, 0),
            (255, 0, 255),
            (0, 255, 255),
        ] {
            let rgba = solid_image(8, 8, r, g, b, 255);
            let hash = ChromaHash::encode(8, 8, &rgba, Gamut::Srgb);
            let avg = hash.average_color();
            let err = (avg[0] as i32 - r as i32)
                .abs()
                .max((avg[1] as i32 - g as i32).abs())
                .max((avg[2] as i32 - b as i32).abs());
            // 8/255 per channel at a gamut corner is well under 1 ΔE00 in the
            // insensitive regions (green) and ~1 in the sensitive ones (blue);
            // v0.5's failure mode was 58/255 on the blue corner.
            assert!(
                err <= 8,
                "solid ({r},{g},{b}) decoded as ({},{},{}) — max channel err {err}",
                avg[0],
                avg[1],
                avg[2]
            );
        }
    }

    #[test]
    fn strip_capped_decode_is_not_blank() {
        // v0.5 regression: a 1×100 red→blue strip decoded at max dims (1, 100)
        // rendered solid white (aliased cx=2 basis at a 1-px raster).
        let h = 100u32;
        let mut rgba = vec![0u8; (h * 4) as usize];
        for y in 0..h as usize {
            let t = y as f64 / 99.0;
            rgba[y * 4] = (255.0 * (1.0 - t)) as u8;
            rgba[y * 4 + 2] = (255.0 * t) as u8;
            rgba[y * 4 + 3] = 255;
        }
        let hash = ChromaHash::encode(1, h, &rgba, Gamut::Srgb);
        let (dw, dh, pixels) = hash.decode_capped(1, h);
        assert_eq!(dw, 1);
        assert!(dh > 1);

        // Red must dominate at the top and blue at the bottom.
        let top = &pixels[0..4];
        let bottom = &pixels[(dh as usize - 1) * 4..];
        assert!(
            top[0] > top[2] + 50,
            "top pixel should be red-dominant: {top:?}"
        );
        assert!(
            bottom[2] > bottom[0] + 50,
            "bottom pixel should be blue-dominant: {bottom:?}"
        );
    }

    #[test]
    fn all_layouts_fit_bit_budget_for_all_aspects() {
        // encode_with debug_asserts the exact AC payload bit position; running
        // every layout over opaque and transparent images across extreme
        // dimensions exercises those asserts for both alpha modes.
        for layout in [LAYOUT_A, LAYOUT_B, LAYOUT_C, LAYOUT_D, LAYOUT_T0] {
            let t = Tunables {
                layout,
                layout_upper: layout,
                ..Tunables::DEFAULT
            };
            for &(w, h) in &[(1u32, 1u32), (1, 100), (100, 1), (16, 9), (9, 16), (32, 2)] {
                let opaque = solid_image(w, h, 200, 100, 50, 255);
                let translucent = solid_image(w, h, 200, 100, 50, 128);
                let h1 = ChromaHash::encode_tuned(w, h, &opaque, Gamut::Srgb, &t);
                let h2 = ChromaHash::encode_tuned(w, h, &translucent, Gamut::Srgb, &t);
                let (dw, dh, px) = h1.decode_tuned(&t);
                assert_eq!(px.len(), (dw * dh * 4) as usize);
                let (dw2, dh2, px2) = h2.decode_tuned(&t);
                assert_eq!(px2.len(), (dw2 * dh2 * 4) as usize);
            }
        }
    }

    #[test]
    fn from_bytes_validates_end_to_end() {
        // from_bytes is the decodability check: it validates version, tier,
        // reserved bits, and exact length, failing early — and an Ok value always
        // decodes. (spec/test-vectors/unit-validate.json)
        let rgba = solid_image(4, 4, 128, 128, 128, 255);
        let bytes = ChromaHash::encode(4, 4, &rgba, Gamut::Srgb)
            .as_bytes()
            .to_vec();
        assert!(ChromaHash::from_bytes(&bytes).is_ok());

        let mut bad_version = bytes.clone();
        bad_version[0] = (bad_version[0] & !0b111) | 1;
        assert_eq!(
            ChromaHash::from_bytes(&bad_version),
            Err(ChromaHashError::UnsupportedVersion)
        );

        // The first code that is still reserved. The codes are ordered by
        // quality, so `MAX_TIER + 1` is exactly that code.
        let mut bad_tier = bytes.clone();
        bad_tier[0] = (bad_tier[0] & !(0b111 << 3)) | ((MAX_TIER + 1) << 3);
        assert_eq!(
            ChromaHash::from_bytes(&bad_tier),
            Err(ChromaHashError::InvalidTier)
        );

        let mut reserved = bytes.clone();
        reserved[0] |= 1 << 7;
        assert_eq!(
            ChromaHash::from_bytes(&reserved),
            Err(ChromaHashError::ReservedBitSet)
        );

        let mut too_long = bytes.clone();
        too_long.push(0);
        assert_eq!(
            ChromaHash::from_bytes(&too_long),
            Err(ChromaHashError::LengthMismatch)
        );
        assert_eq!(ChromaHash::from_bytes(&[]), Err(ChromaHashError::TooShort));

        // A validated hash always decodes.
        let (w, h, px) = ChromaHash::from_bytes(&bytes).unwrap().decode();
        assert_eq!(px.len(), (w * h * 4) as usize);
    }

    #[test]
    fn large_image_encode_decode() {
        // Full-res encoding: dimensions well beyond the old 100×100 limit
        let w = 200u32;
        let h = 150u32;
        let rgba = horizontal_gradient(w, h);
        let hash = ChromaHash::encode(w, h, &rgba, Gamut::Srgb);
        assert_eq!(hash.as_bytes().len(), 32);
        let (dw, dh, pixels) = hash.decode();
        assert!(dw > 0 && dh > 0);
        assert_eq!(pixels.len(), (dw * dh * 4) as usize);
    }

    #[test]
    fn panorama_encode_decode() {
        // 4:1 panorama exercises adaptive grid (should produce 10×5 for L)
        let w = 200u32;
        let h = 50u32;
        let rgba = horizontal_gradient(w, h);
        let hash = ChromaHash::encode(w, h, &rgba, Gamut::Srgb);
        assert_eq!(hash.as_bytes().len(), 32);
        let (dw, dh, pixels) = hash.decode();
        assert!(dw > dh, "panorama output should be wider than tall");
        assert_eq!(pixels.len(), (dw * dh * 4) as usize);
    }

    #[test]
    fn transparency_roundtrip() {
        let w = 8;
        let h = 8;
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        // Top half opaque red, bottom half transparent
        for y in 0..h {
            for x in 0..w {
                let idx = ((y * w + x) * 4) as usize;
                if y < h / 2 {
                    rgba[idx] = 255;
                    rgba[idx + 3] = 255;
                } else {
                    rgba[idx + 3] = 0;
                }
            }
        }
        let hash = ChromaHash::encode(w, h, &rgba, Gamut::Srgb);
        let has_alpha = (hash.as_bytes()[0] >> 6) & 1 == 1;
        assert!(has_alpha, "should detect alpha");

        let (dw, dh, pixels) = hash.decode();
        assert!(dw > 0 && dh > 0);
        // Alpha values should vary
        let a_min = pixels.iter().skip(3).step_by(4).copied().min().unwrap();
        let a_max = pixels.iter().skip(3).step_by(4).copied().max().unwrap();
        assert!(a_max > a_min, "alpha should vary across decoded image");
    }

    #[test]
    fn from_bytes_roundtrip() {
        let rgba = solid_image(4, 4, 128, 64, 32, 255);
        let hash = ChromaHash::encode(4, 4, &rgba, Gamut::Srgb);
        let hash2 = ChromaHash::from_bytes(hash.as_bytes()).unwrap();
        assert_eq!(hash, hash2);
    }

    #[test]
    fn deterministic_encoding() {
        let rgba = horizontal_gradient(16, 16);
        let hash1 = ChromaHash::encode(16, 16, &rgba, Gamut::Srgb);
        let hash2 = ChromaHash::encode(16, 16, &rgba, Gamut::Srgb);
        assert_eq!(
            hash1.as_bytes(),
            hash2.as_bytes(),
            "encoding should be deterministic"
        );
    }

    #[test]
    fn highfreq_roundtrip_golden() {
        // A spectrally rich image is the only thing that pins decode's synthesis
        // window and its cx≥w / cy≥h frequency filter: every spec vector is a
        // smooth gradient, so its high-frequency AC is ≈0 and those paths go
        // unexercised. Hash and decoded pixels are this build's own output — a
        // regression (or surviving mutant) that shifts them is caught.
        let (w, h) = (16u32, 16u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                rgba[i] = ((x * 37 + y * 101) % 256) as u8;
                rgba[i + 1] = ((x * 53) ^ (y * 191)) as u8;
                rgba[i + 2] = ((x * x + y * y * 3) % 256) as u8;
                rgba[i + 3] = 255;
            }
        }
        let hash = ChromaHash::encode(w, h, &rgba, Gamut::Srgb);
        #[rustfmt::skip]
        let expected_hash = [
            8, 128, 79, 97, 48, 16, 136, 0, 0, 77, 96, 21, 145, 64, 230, 140, 5, 136, 84, 204, 24,
            16, 40, 33, 229, 201, 182, 235, 180, 18, 197, 40,
        ];
        assert_eq!(hash.as_bytes(), &expected_hash);

        // Full render: the window-attenuated high-frequency coefficients carry
        // real amplitude here, so `ac · weight` (not `ac / weight`) is pinned.
        let (dw, dh, px) = hash.decode();
        assert_eq!((dw, dh), (32, 32));
        let p = |i: usize| &px[i * 4..i * 4 + 4];
        assert_eq!(p(0), [78, 51, 0, 255]);
        assert_eq!(p(17), [158, 124, 62, 255]);
        assert_eq!(p(500), [153, 144, 158, 255]);
        assert_eq!(p(1000), [143, 127, 159, 255]);

        // Aggressive cap: coefficients with cx ≥ 4 or cy ≥ 4 must be dropped, not
        // kept — asserting the whole 4×4 pins the off-axis pixels where those
        // dropped bases are non-zero (so `||` can't degrade to `&&`).
        let (cw, ch, cpx) = hash.decode_capped(4, 4);
        assert_eq!((cw, ch), (4, 4));
        let expected: [[u8; 4]; 16] = [
            [121, 105, 0, 255],
            [155, 132, 26, 255],
            [147, 128, 105, 255],
            [141, 137, 198, 255],
            [153, 141, 126, 255],
            [134, 126, 123, 255],
            [147, 138, 153, 255],
            [147, 137, 161, 255],
            [147, 137, 142, 255],
            [144, 134, 140, 255],
            [143, 135, 149, 255],
            [142, 131, 128, 255],
            [128, 126, 163, 255],
            [151, 134, 136, 255],
            [144, 130, 141, 255],
            [134, 130, 146, 255],
        ];
        for (i, e) in expected.iter().enumerate() {
            assert_eq!(&cpx[i * 4..i * 4 + 4], e, "capped pixel {i}");
        }

        // The synthesis window is only active under non-default tunables
        // (w_min < 1); the default render keeps every weight at 1.0, where
        // `ac * weight` and `ac / weight` coincide. Decode the same hash with the
        // window engaged so the per-coefficient weight application is pinned.
        let windowed = Tunables {
            w_min_l: 0.55,
            w_exp_l: 2,
            w_min_c: 0.6,
            w_exp_c: 2,
            ..Tunables::DEFAULT
        };
        let (ww, wh, wpx) = hash.decode_tuned(&windowed);
        assert_eq!((ww, wh), (32, 32));
        let wp = |i: usize| &wpx[i * 4..i * 4 + 4];
        assert_eq!(wp(0), [101, 79, 0, 255]);
        assert_eq!(wp(17), [152, 127, 84, 255]);
        assert_eq!(wp(500), [149, 140, 150, 255]);
        assert_eq!(wp(1000), [142, 129, 154, 255]);
    }

    #[test]
    fn tuned_default_matches_public_api() {
        // The doc-hidden `*_tuned` sweep entry points must be exactly the public
        // API at `Tunables::DEFAULT`. Comparing full results (not just lengths)
        // pins them against whole-body replacement with a trivial tuple.
        for &(w, h) in &[(8u32, 6u32), (1, 1), (16, 9), (9, 16)] {
            let rgba = horizontal_gradient(w, h);
            let hash = ChromaHash::encode(w, h, &rgba, Gamut::Srgb);
            assert_eq!(
                hash.decode_tuned(&Tunables::DEFAULT),
                hash.decode(),
                "decode_tuned diverges from decode for {w}×{h}"
            );
            assert_eq!(
                hash.decode_capped_tuned(4, 4, &Tunables::DEFAULT),
                hash.decode_capped(4, 4),
                "decode_capped_tuned diverges from decode_capped for {w}×{h}"
            );
        }
    }

    #[test]
    fn gamut_wrappers_match_public_api() {
        // The gamut-aware decode wrappers — decode_capped_to (public) and the
        // doc-hidden decode_to_tuned / decode_capped_to_tuned — are otherwise
        // never called, so whole-body replacement with a trivial tuple survives.
        // Pin each against the already-golden free-function behaviour at
        // Tunables::DEFAULT, and assert the output gamut actually flows through.
        //
        // A saturated P3 green clips in sRGB but not in P3, so the renders differ
        // by gamut — that gives both an equality oracle (per gamut) and an
        // inequality oracle (P3 ≠ sRGB) that the constant-tuple mutants fail.
        let p3_green = [0u8, 200, 80, 255].repeat(16);
        for &(w, h) in &[(8u32, 6u32), (1, 1), (16, 9), (9, 16)] {
            let mut rgba = vec![0u8; (w * h * 4) as usize];
            for px in rgba.chunks_exact_mut(4) {
                px.copy_from_slice(&p3_green[0..4]);
            }
            let hash = ChromaHash::encode(w, h, &rgba, Gamut::DisplayP3);

            for output in [Gamut::Srgb, Gamut::DisplayP3, Gamut::AdobeRgb] {
                assert_eq!(
                    hash.decode_to_tuned(output, &Tunables::DEFAULT),
                    hash.decode_to(output),
                    "decode_to_tuned diverges from decode_to for {w}×{h} {output:?}"
                );
                assert_eq!(
                    hash.decode_capped_to_tuned(4, 4, output, &Tunables::DEFAULT),
                    hash.decode_capped_to(4, 4, output),
                    "decode_capped_to_tuned diverges from decode_capped_to for {w}×{h} {output:?}"
                );
            }

            // decode_capped_to at sRGB must equal the non-gamut decode_capped.
            assert_eq!(
                hash.decode_capped_to(4, 4, Gamut::Srgb),
                hash.decode_capped(4, 4),
                "decode_capped_to(Srgb) diverges from decode_capped for {w}×{h}"
            );

            // The output gamut must change the pixels, not be ignored.
            assert_ne!(
                hash.decode_to_tuned(Gamut::DisplayP3, &Tunables::DEFAULT),
                hash.decode_to_tuned(Gamut::Srgb, &Tunables::DEFAULT),
                "decode_to_tuned must honour the output gamut for {w}×{h}"
            );
            assert_ne!(
                hash.decode_capped_to(4, 4, Gamut::DisplayP3),
                hash.decode_capped_to(4, 4, Gamut::Srgb),
                "decode_capped_to must honour the output gamut for {w}×{h}"
            );
        }
    }
}
