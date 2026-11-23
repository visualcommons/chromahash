//! WebAssembly bindings for ChromaHash.
//!
//! A thin `wasm-bindgen` wrapper over the zero-dependency [`chromahash`] core,
//! built with `wasm-pack` and consumed by the TypeScript web package. Exposes the
//! full encode + decode surface; output is byte-identical to every other
//! ChromaHash implementation.
//!
//! Batch encoding is deliberately *not* exposed here: WebAssembly cannot use the
//! core's worker pool without `SharedArrayBuffer` + COOP/COEP, so the TypeScript
//! layer implements `encodeBatch` by looping this single-image `encode`.

use chromahash::{ChromaHash as CoreHash, Gamut as CoreGamut, MAX_TIER};
use wasm_bindgen::prelude::*;

// ─── quality tiers ────────────────────────────────────────────────────────────
//
// Exported so the TypeScript package can name the tiers instead of restating
// codes the format is free to renumber. wasm-bindgen has no constant export, so
// these are zero-cost functions the TS layer reads once.

/// The lowest quality tier: a 21-byte hash. Tier codes are ordered by quality.
#[wasm_bindgen(js_name = compactTier)]
pub fn compact_tier() -> u8 {
    chromahash::COMPACT_TIER
}

/// The default quality tier: a 32-byte hash. What `encode` uses.
#[wasm_bindgen(js_name = defaultTier)]
pub fn default_tier() -> u8 {
    chromahash::DEFAULT_TIER
}

/// The highest quality tier this build implements; higher codes are reserved.
#[wasm_bindgen(js_name = maxTier)]
pub fn max_tier() -> u8 {
    MAX_TIER
}

/// The format generation this build writes and accepts (the `version` field of
/// byte 0).
#[wasm_bindgen(js_name = formatVersion)]
pub fn format_version() -> u8 {
    chromahash::FORMAT_VERSION
}

/// Validate an encode's arguments, mirroring the C ABI check for check. The core
/// panics on any of these, and a panic in WebAssembly aborts the instance — every
/// later call on the module then fails — so they are turned into thrown errors.
fn check_encode_args(w: u32, h: u32, rgba_len: usize, quality: u8) -> Result<(), JsError> {
    if w == 0 || h == 0 {
        return Err(JsError::new(&format!(
            "width and height must be >= 1 (got {w}x{h})"
        )));
    }
    let expected = (w as usize)
        .checked_mul(h as usize)
        .and_then(|p| p.checked_mul(4));
    if expected != Some(rgba_len) {
        return Err(JsError::new(&format!(
            "rgba length must equal width * height * 4 (expected {}, got {rgba_len})",
            expected.map_or("an overflowing count".to_string(), |n| n.to_string())
        )));
    }
    if quality > MAX_TIER {
        return Err(JsError::new(&format!(
            "quality tier must be 0..={MAX_TIER} (got {quality})"
        )));
    }
    Ok(())
}

/// Source/target color space. Mirrors [`chromahash::Gamut`].
#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub enum Gamut {
    Srgb,
    DisplayP3,
    AdobeRgb,
    Bt2020,
    ProPhotoRgb,
}

impl From<Gamut> for CoreGamut {
    fn from(g: Gamut) -> Self {
        match g {
            Gamut::Srgb => CoreGamut::Srgb,
            Gamut::DisplayP3 => CoreGamut::DisplayP3,
            Gamut::AdobeRgb => CoreGamut::AdobeRgb,
            Gamut::Bt2020 => CoreGamut::Bt2020,
            Gamut::ProPhotoRgb => CoreGamut::ProPhotoRgb,
        }
    }
}

/// A decoded RGBA image (≤ 32×32 px). `rgba` is row-major, 4 bytes/pixel
/// (R, G, B, A) and crosses to JS as a `Uint8Array`.
#[wasm_bindgen]
pub struct DecodeResult {
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
    rgba: Vec<u8>,
}

#[wasm_bindgen]
impl DecodeResult {
    #[wasm_bindgen(getter)]
    pub fn rgba(&self) -> Vec<u8> {
        self.rgba.clone()
    }
}

/// A ChromaHash placeholder (variable length — 32 bytes at the default tier).
/// Mirrors [`chromahash::ChromaHash`].
#[wasm_bindgen]
pub struct ChromaHash {
    inner: CoreHash,
}

#[wasm_bindgen]
impl ChromaHash {
    /// Encode an RGBA image (4 bytes/pixel) into a default-tier (32-byte)
    /// ChromaHash. Throws if a dimension is zero or `rgba.len() != w * h * 4`.
    pub fn encode(w: u32, h: u32, rgba: &[u8], gamut: Gamut) -> Result<ChromaHash, JsError> {
        Self::encode_with_quality(w, h, rgba, gamut, chromahash::DEFAULT_TIER)
    }

    /// Encode at an explicit quality tier (0..=4, ordered by quality). Tier 1 is
    /// the 32-byte default and tier 0 the 21-byte compact tier; each higher code
    /// carries more detail in a larger hash. Throws on invalid dimensions, an
    /// rgba length that disagrees with them, or a reserved tier code.
    #[wasm_bindgen(js_name = encodeWithQuality)]
    pub fn encode_with_quality(
        w: u32,
        h: u32,
        rgba: &[u8],
        gamut: Gamut,
        quality: u8,
    ) -> Result<ChromaHash, JsError> {
        check_encode_args(w, h, rgba.len(), quality)?;
        Ok(ChromaHash {
            inner: CoreHash::encode_with_quality(w, h, rgba, gamut.into(), quality),
        })
    }

    /// Reconstruct from raw hash bytes. Throws if `bytes` is not a valid v2
    /// ChromaHash.
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(bytes: &[u8]) -> Result<ChromaHash, JsError> {
        let inner = CoreHash::from_bytes(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(ChromaHash { inner })
    }

    /// Decode into an sRGB RGBA image (≤ 32×32 px).
    pub fn decode(&self) -> DecodeResult {
        self.decode_to(Gamut::Srgb)
    }

    /// Decode into an RGBA image in the given output gamut (sRGB / Display P3 /
    /// Adobe RGB; others fall back to sRGB).
    #[wasm_bindgen(js_name = decodeTo)]
    pub fn decode_to(&self, output: Gamut) -> DecodeResult {
        let (width, height, rgba) = self.inner.decode_to(output.into());
        DecodeResult {
            width,
            height,
            rgba,
        }
    }

    /// Decode into an sRGB RGBA image, capped at the given maximum dimensions.
    #[wasm_bindgen(js_name = decodeCapped)]
    pub fn decode_capped(&self, max_w: u32, max_h: u32) -> DecodeResult {
        self.decode_capped_to(max_w, max_h, Gamut::Srgb)
    }

    /// Capped decode (see `decodeCapped`) in the given output gamut.
    #[wasm_bindgen(js_name = decodeCappedTo)]
    pub fn decode_capped_to(&self, max_w: u32, max_h: u32, output: Gamut) -> DecodeResult {
        let (width, height, rgba) = self.inner.decode_capped_to(max_w, max_h, output.into());
        DecodeResult {
            width,
            height,
            rgba,
        }
    }

    /// Extract the average color without a full decode, as `[r, g, b, a]`.
    #[wasm_bindgen(js_name = averageColor)]
    pub fn average_color(&self) -> Vec<u8> {
        self.inner.average_color().to_vec()
    }

    /// The raw hash bytes (32 at the default tier, more at higher tiers).
    #[wasm_bindgen(js_name = asBytes)]
    pub fn as_bytes(&self) -> Vec<u8> {
        self.inner.as_bytes().to_vec()
    }
}
