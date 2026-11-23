//! UniFFI binding crate for ChromaHash.
//!
//! Exposes the zero-dependency [`chromahash`] core to Kotlin/Android (and any other
//! UniFFI target) across the FFI boundary. The core crate is left untouched and
//! dependency-free; only this thin wrapper carries the `uniffi` dependency.
//!
//! The generated Kotlin lives in package `io.chromahash.ffi` (see `uniffi.toml`) and
//! mirrors the pure-JVM `chromahash` API 1:1, with two deliberate differences at the
//! FFI boundary:
//!   - Every fallible entry point **throws** rather than panicking, because a
//!     panic across FFI is undefined behaviour. That covers `from_bytes` on
//!     malformed input and `encode`/`encode_with_quality`/`encode_batch` on
//!     invalid dimensions, a mismatched `rgba` length, or a reserved tier code —
//!     the same checks, and the same taxonomy, as the C ABI's status codes.
//!   - Integer record fields are signed (`i32` → Kotlin `Int`), matching the
//!     pure-Kotlin `DecodeResult`/`RgbaColor` types and Android's `Bitmap`/ARGB APIs.

use std::sync::{Arc, Mutex};

use chromahash::{
    BatchEncoder as CoreBatch, ChromaHash as CoreHash, Gamut as CoreGamut, ImageInput as CoreInput,
};

uniffi::setup_scaffolding!();

// ─── quality tiers ────────────────────────────────────────────────────────────
//
// Re-exported from the core rather than restated in each generated language, so
// Kotlin, Swift, and Python name the tiers instead of writing a literal that the
// format is free to renumber underneath them. UniFFI has no constant export, so
// these are zero-cost functions the facades read once.

/// The lowest quality tier: a 21-byte hash. Tier codes are ordered by quality.
pub const COMPACT_TIER: u8 = chromahash::COMPACT_TIER;

/// The default quality tier: a 32-byte hash. What [`ChromaHash::encode`] uses.
pub const DEFAULT_TIER: u8 = chromahash::DEFAULT_TIER;

/// The highest quality tier this build implements. Codes above it are reserved
/// and rejected with [`ChromaHashError::InvalidTier`].
pub const MAX_TIER: u8 = chromahash::MAX_TIER;

/// The format generation this build writes and accepts (the `version` field of
/// byte 0).
pub const FORMAT_VERSION: u8 = chromahash::FORMAT_VERSION;

/// The lowest quality tier: a 21-byte hash. Tier codes are ordered by quality.
#[uniffi::export]
pub fn compact_tier() -> u8 {
    COMPACT_TIER
}

/// The default quality tier: a 32-byte hash. What [`ChromaHash::encode`] uses.
#[uniffi::export]
pub fn default_tier() -> u8 {
    DEFAULT_TIER
}

/// The highest quality tier this build implements; higher codes are reserved.
#[uniffi::export]
pub fn max_tier() -> u8 {
    MAX_TIER
}

/// The format generation this build writes and accepts.
#[uniffi::export]
pub fn format_version() -> u8 {
    FORMAT_VERSION
}

/// Source/target color space. Mirrors [`chromahash::Gamut`].
#[derive(Debug, Clone, Copy, uniffi::Enum)]
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

/// Errors surfaced across the FFI boundary. Maps to a thrown Kotlin/Swift/Python
/// exception.
///
/// The core encoder panics on invalid input, which is undefined behaviour across
/// an FFI boundary — so every entry point validates first and returns one of
/// these instead. The variants mirror the C ABI's `ChromaHashStatus` codes, so a
/// caller sees the same taxonomy whichever binding it went through.
#[derive(Debug, uniffi::Error)]
pub enum ChromaHashError {
    /// `from_bytes` was given bytes that are not a valid v2 ChromaHash (bad
    /// version, tier, reserved bit, or a length that disagrees with the header).
    /// `reason` carries the core's precise message.
    InvalidData { reason: String },
    /// A dimension was zero.
    InvalidDimensions { reason: String },
    /// `rgba.len()` was not `w * h * 4`.
    InvalidLength { reason: String },
    /// The quality tier was above [`MAX_TIER`]; codes above it are reserved.
    InvalidTier { reason: String },
}

impl std::fmt::Display for ChromaHashError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChromaHashError::InvalidData { reason }
            | ChromaHashError::InvalidDimensions { reason }
            | ChromaHashError::InvalidLength { reason }
            | ChromaHashError::InvalidTier { reason } => write!(f, "{reason}"),
        }
    }
}

/// Validate an encode's arguments, mirroring `chromahash_encode_with_quality`
/// in the C ABI check-for-check. The core would panic on any of these, and a
/// panic must not cross the FFI boundary.
fn check_encode_args(w: u32, h: u32, rgba_len: usize, quality: u8) -> Result<(), ChromaHashError> {
    if w == 0 || h == 0 {
        return Err(ChromaHashError::InvalidDimensions {
            reason: format!("width and height must be >= 1 (got {w}x{h})"),
        });
    }
    let expected = (w as usize)
        .checked_mul(h as usize)
        .and_then(|p| p.checked_mul(4));
    if expected != Some(rgba_len) {
        return Err(ChromaHashError::InvalidLength {
            reason: format!(
                "rgba length must equal width * height * 4 (expected {}, got {rgba_len})",
                expected.map_or("an overflowing count".to_string(), |n| n.to_string())
            ),
        });
    }
    if quality > MAX_TIER {
        return Err(ChromaHashError::InvalidTier {
            reason: format!("quality tier must be 0..={MAX_TIER} (got {quality})"),
        });
    }
    Ok(())
}

impl std::error::Error for ChromaHashError {}

/// Tag a batch item's validation failure with its index, so the caller learns
/// which of `items` was rejected.
fn prefix(e: ChromaHashError, index: usize) -> ChromaHashError {
    let tag = |reason: String| format!("item {index}: {reason}");
    match e {
        ChromaHashError::InvalidData { reason } => ChromaHashError::InvalidData {
            reason: tag(reason),
        },
        ChromaHashError::InvalidDimensions { reason } => ChromaHashError::InvalidDimensions {
            reason: tag(reason),
        },
        ChromaHashError::InvalidLength { reason } => ChromaHashError::InvalidLength {
            reason: tag(reason),
        },
        ChromaHashError::InvalidTier { reason } => ChromaHashError::InvalidTier {
            reason: tag(reason),
        },
    }
}

/// A decoded RGBA image (≤ 32×32 px). `rgba` is row-major, 4 bytes/pixel (R, G, B, A).
#[derive(Debug, uniffi::Record)]
pub struct DecodeResult {
    pub width: i32,
    pub height: i32,
    pub rgba: Vec<u8>,
}

/// An 8-bit-per-channel RGBA color. Each field is in the range `0..=255`.
#[derive(Debug, uniffi::Record)]
pub struct RgbaColor {
    pub r: i32,
    pub g: i32,
    pub b: i32,
    pub a: i32,
}

/// A ChromaHash placeholder (variable length — 32 bytes at the default tier).
/// Mirrors [`chromahash::ChromaHash`].
#[derive(Debug, uniffi::Object)]
pub struct ChromaHash {
    inner: CoreHash,
}

#[uniffi::export]
impl ChromaHash {
    /// Encode an image (RGBA, 4 bytes/pixel) into a default-tier (32-byte)
    /// ChromaHash. Throws if a dimension is zero or `rgba.len() != w * h * 4`.
    #[uniffi::constructor]
    pub fn encode(
        w: u32,
        h: u32,
        rgba: Vec<u8>,
        gamut: Gamut,
    ) -> Result<Arc<Self>, ChromaHashError> {
        Self::encode_with_quality(w, h, rgba, gamut, DEFAULT_TIER)
    }

    /// Encode at an explicit quality tier (0..=4, ordered by quality). Tier 1 is
    /// the 32-byte default and tier 0 the 21-byte compact tier; each higher code
    /// carries more detail in a larger hash. Throws on invalid dimensions, an
    /// rgba length that disagrees with them, or a reserved tier code.
    #[uniffi::constructor]
    pub fn encode_with_quality(
        w: u32,
        h: u32,
        rgba: Vec<u8>,
        gamut: Gamut,
        quality: u8,
    ) -> Result<Arc<Self>, ChromaHashError> {
        check_encode_args(w, h, rgba.len(), quality)?;
        Ok(Arc::new(Self {
            inner: CoreHash::encode_with_quality(w, h, &rgba, gamut.into(), quality),
        }))
    }

    /// Reconstruct from raw hash bytes. Throws [`ChromaHashError::InvalidData`] if
    /// `bytes` is not a valid v2 ChromaHash.
    #[uniffi::constructor]
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Arc<Self>, ChromaHashError> {
        let inner = CoreHash::from_bytes(&bytes).map_err(|e| ChromaHashError::InvalidData {
            reason: e.to_string(),
        })?;
        Ok(Arc::new(Self { inner }))
    }

    /// Decode into an sRGB RGBA image (≤ 32×32 px).
    pub fn decode(&self) -> DecodeResult {
        self.decode_to(Gamut::Srgb)
    }

    /// Decode into an RGBA image in the given output gamut (sRGB / Display P3 /
    /// Adobe RGB; others fall back to sRGB).
    pub fn decode_to(&self, output: Gamut) -> DecodeResult {
        let (width, height, rgba) = self.inner.decode_to(output.into());
        DecodeResult {
            width: width as i32,
            height: height as i32,
            rgba,
        }
    }

    /// Decode into an sRGB RGBA image, capped at the given maximum dimensions.
    pub fn decode_capped(&self, max_w: u32, max_h: u32) -> DecodeResult {
        self.decode_capped_to(max_w, max_h, Gamut::Srgb)
    }

    /// Capped decode (see `decode_capped`) in the given output gamut.
    pub fn decode_capped_to(&self, max_w: u32, max_h: u32, output: Gamut) -> DecodeResult {
        let (width, height, rgba) = self.inner.decode_capped_to(max_w, max_h, output.into());
        DecodeResult {
            width: width as i32,
            height: height as i32,
            rgba,
        }
    }

    /// Extract the average color without a full decode.
    pub fn average_color(&self) -> RgbaColor {
        let [r, g, b, a] = self.inner.average_color();
        RgbaColor {
            r: r as i32,
            g: g as i32,
            b: b as i32,
            a: a as i32,
        }
    }

    /// The raw hash bytes (32 at the default tier, more at higher tiers).
    pub fn as_bytes(&self) -> Vec<u8> {
        self.inner.as_bytes().to_vec()
    }
}

/// One image to encode in a batch. `rgba` is RGBA, 4 bytes/pixel
/// (length == `w * h * 4`). Mirrors [`chromahash::ImageInput`].
#[derive(Debug, Clone, uniffi::Record)]
pub struct ImageInput {
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
    pub gamut: Gamut,
    /// Quality tier (`0..=4`, ordered by quality). Defaults to the 32-byte
    /// default tier, matching [`ChromaHash::encode`] — note that the tier
    /// codes start at 0 for the *compact* tier, so an explicit 0 is the
    /// 21-byte hash.
    ///
    /// The literal is forced: `#[uniffi(default = …)]` takes a literal, not a
    /// path, so it cannot name [`DEFAULT_TIER`]. The const assertion below ties
    /// the two together at compile time instead.
    #[uniffi(default = 1)]
    pub quality: u8,
}

// `#[uniffi(default = 1)]` on `ImageInput::quality` above cannot name a const,
// so this is what stops it drifting from the format: renumbering the tiers
// without updating that literal fails the build rather than silently changing
// what an omitted tier means.
const _: () = assert!(
    DEFAULT_TIER == 1,
    "ImageInput::quality's #[uniffi(default = 1)] no longer matches DEFAULT_TIER"
);

/// A stateful batch encoder backed by a persistent worker pool. Output is
/// byte-identical to calling [`ChromaHash::encode`] on each image individually.
///
/// The core encoder is `!Sync` (it holds an `mpsc::Sender`), so it is wrapped in a
/// `Mutex` here to satisfy UniFFI's `Send + Sync` requirement for objects:
/// concurrent `encode_batch` calls on the same encoder serialize, but each call
/// still saturates the worker pool internally.
#[derive(uniffi::Object)]
pub struct BatchEncoder {
    inner: Mutex<CoreBatch>,
}

#[uniffi::export]
impl BatchEncoder {
    /// Create an encoder with a worker pool sized to the available parallelism.
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(CoreBatch::new()),
        })
    }

    /// Create an encoder with an explicit worker count (clamped to ≥ 1).
    #[uniffi::constructor]
    pub fn with_threads(threads: u32) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(CoreBatch::with_threads(threads as usize)),
        })
    }

    /// Encode every item, returning hashes in the same order as `items`. Each
    /// hash is byte-identical to [`ChromaHash::encode_with_quality`] on that
    /// item at its `quality` tier.
    ///
    /// Every item is validated before any work is dispatched, so an invalid item
    /// throws on the calling thread (naming its index) rather than panicking a
    /// worker across the FFI boundary.
    pub fn encode_batch(
        &self,
        items: Vec<ImageInput>,
    ) -> Result<Vec<Arc<ChromaHash>>, ChromaHashError> {
        let mut inputs: Vec<CoreInput> = Vec::with_capacity(items.len());
        for (i, it) in items.into_iter().enumerate() {
            check_encode_args(it.w, it.h, it.rgba.len(), it.quality).map_err(|e| prefix(e, i))?;
            inputs.push(CoreInput {
                w: it.w,
                h: it.h,
                rgba: Arc::from(it.rgba),
                gamut: it.gamut.into(),
                quality: it.quality,
            });
        }
        let guard = self.inner.lock().expect("batch encoder mutex poisoned");
        Ok(guard
            .encode_batch(&inputs)
            .into_iter()
            .map(|inner| Arc::new(ChromaHash { inner }))
            .collect())
    }
}
