//! Shared oracle and input layouts for the core fuzz targets.
//!
//! The oracle restates the spec rather than calling into the crate's private
//! constants: a fuzz target that asked the implementation what the answer
//! should be would only ever confirm the implementation. Everything here is
//! read from `spec/README.md` (§2.5 descriptor byte, §2.6 validation, §3.5
//! length table, §8.2 decode size, §9.1 alpha detection).
//!
//! The byte layouts of the `decode` and `encode` inputs are documented on
//! [`DecodeInput`] and [`EncodeInput`]; `seeds.py` writes the seed corpora in
//! exactly these layouts, so the two must change together.

use chromahash::{ChromaHash, ChromaHashError, FORMAT_VERSION, Gamut, MAX_TIER};

/// §2.6: the fixed header is 54 bits, so anything shorter than 7 bytes is
/// rejected before byte 0 is read.
pub const MIN_LEN: usize = 7;

/// §3.5 length table, `[tier] -> (no-alpha, alpha)` bytes.
pub const TIER_LEN: [(usize, usize); 5] =
    [(21, 21), (32, 32), (108, 103), (411, 388), (1623, 1528)];

/// §2.5 descriptor byte fields.
pub fn version(b0: u8) -> u8 {
    b0 & 0b111
}
pub fn tier(b0: u8) -> u8 {
    (b0 >> 3) & 0b111
}
pub fn has_alpha(b0: u8) -> bool {
    (b0 >> 6) & 1 == 1
}
pub fn reserved(b0: u8) -> bool {
    (b0 >> 7) & 1 == 1
}

/// §3.5's byte length for a valid `tier` code.
pub fn tier_len(tier: u8, alpha: bool) -> usize {
    let (opaque, with_alpha) = TIER_LEN[tier as usize];
    if alpha { with_alpha } else { opaque }
}

/// What §2.6 says `from_bytes` must return for `bytes`, checked in the
/// order the spec lists the checks.
pub fn expected_validation(bytes: &[u8]) -> Result<(), ChromaHashError> {
    if bytes.len() < MIN_LEN {
        return Err(ChromaHashError::TooShort);
    }
    let b0 = bytes[0];
    if version(b0) != FORMAT_VERSION {
        return Err(ChromaHashError::UnsupportedVersion);
    }
    if tier(b0) > MAX_TIER {
        return Err(ChromaHashError::InvalidTier);
    }
    if reserved(b0) {
        return Err(ChromaHashError::ReservedBitSet);
    }
    if bytes.len() != tier_len(tier(b0), has_alpha(b0)) {
        return Err(ChromaHashError::LengthMismatch);
    }
    Ok(())
}

/// §3.5 / §8.2: the natural render's long edge is `32 · 2^renderLevel(tier)`.
pub fn natural_long_edge(tier: u8) -> u32 {
    32 << tier.saturating_sub(1)
}

/// Assert the shape of a decoded image: a non-empty `w × h` RGBA raster whose
/// buffer is exactly `w · h · 4` bytes, fully opaque when the hash carries no
/// alpha channel (§9: without the flag there is no alpha to render).
pub fn check_raster(hash: &ChromaHash, w: u32, h: u32, rgba: &[u8]) {
    assert_eq!(
        rgba.len(),
        w as usize * h as usize * 4,
        "decoded buffer is not w*h*4 for {w}x{h}"
    );
    if !has_alpha(hash.as_bytes()[0]) {
        assert!(
            rgba.as_chunks::<4>().0.iter().all(|p| p[3] == 255),
            "a hash without the alpha flag decoded a non-opaque pixel"
        );
    }
}

/// Assert `w × h` is the tier's natural size.
pub fn check_natural_size(hash: &ChromaHash, w: u32, h: u32) {
    let t = tier(hash.as_bytes()[0]);
    let long = natural_long_edge(t);
    assert_eq!(
        w.max(h),
        long,
        "tier {t} decoded {w}x{h}, long edge must be {long}"
    );
    assert!(w >= 1 && h >= 1, "tier {t} decoded an empty {w}x{h} raster");
}

/// Assert the natural decode of a validated hash has the tier's size.
pub fn check_natural(hash: &ChromaHash, w: u32, h: u32, rgba: &[u8]) {
    check_natural_size(hash, w, h);
    check_raster(hash, w, h, rgba);
}

/// Codes 3 and 4 render at 128 and 256 px with up to ~3,000 coefficients, and
/// the render is `O(w·h·K)`: one natural tier-4 decode costs about a second
/// under the sanitizer, which would leave a 60 s smoke run replaying seeds.
/// From this code up the targets render capped rasters instead.
pub const HEAVY_TIER: u8 = 3;
/// Per-axis cap the targets apply at [`HEAVY_TIER`] and above.
pub const HEAVY_CAP: u32 = 32;

/// Is this a [`HEAVY_TIER`] hash?
pub fn is_heavy(hash: &ChromaHash) -> bool {
    tier(hash.as_bytes()[0]) >= HEAVY_TIER
}

/// Decode a validated hash and check it, at a cost that does not grow with
/// the tier: a natural decode below [`HEAVY_TIER`]; above it, the natural size
/// read from two one-pixel-wide capped renders (a cap is a per-axis `min`, so
/// `(∞, 1)` yields the natural width and `(1, ∞)` the natural height). Either
/// way the whole AC payload is parsed, since a render reads every coefficient.
/// Returns the natural size.
pub fn check_decode(hash: &ChromaHash) -> (u32, u32) {
    if !is_heavy(hash) {
        let (w, h, rgba) = hash.decode();
        check_natural(hash, w, h, &rgba);
        return (w, h);
    }
    let (w, one_h, row) = hash.decode_capped(u32::MAX, 1);
    let (one_w, h, col) = hash.decode_capped(1, u32::MAX);
    assert_eq!((one_h, one_w), (1, 1), "a cap of 1 rendered more than 1 px");
    check_natural_size(hash, w, h);
    check_raster(hash, w, 1, &row);
    check_raster(hash, 1, h, &col);
    (w, h)
}

/// The five gamuts, indexed in the C ABI's discriminant order.
pub const GAMUTS: [Gamut; 5] = [
    Gamut::Srgb,
    Gamut::DisplayP3,
    Gamut::AdobeRgb,
    Gamut::Bt2020,
    Gamut::ProPhotoRgb,
];

pub fn gamut(byte: u8) -> Gamut {
    GAMUTS[byte as usize % GAMUTS.len()]
}

fn u16_le(b: &[u8]) -> u16 {
    u16::from_le_bytes([b[0], b[1]])
}

fn u32_le(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// Input of the `decode` target:
///
/// | bytes | field |
/// |---|---|
/// | 0 | output gamut (`% 5`, C ABI order) |
/// | 1..5 | `max_w`, u32 LE |
/// | 5..9 | `max_h`, u32 LE |
/// | 9.. | hash bytes; the shortest prefix that validates is decoded |
///
/// Taking the shortest validating prefix rather than the whole tail keeps a
/// mutation that appends or overwrites trailing bytes decodable, so the fuzzer
/// spends its time in the decoder instead of in `LengthMismatch`.
pub struct DecodeInput<'a> {
    pub gamut: Gamut,
    pub max_w: u32,
    pub max_h: u32,
    pub hash: &'a [u8],
}

pub const DECODE_HEADER: usize = 9;

impl<'a> DecodeInput<'a> {
    pub fn parse(data: &'a [u8]) -> Option<Self> {
        if data.len() < DECODE_HEADER {
            return None;
        }
        Some(Self {
            gamut: gamut(data[0]),
            max_w: u32_le(&data[1..5]),
            max_h: u32_le(&data[5..9]),
            hash: &data[DECODE_HEADER..],
        })
    }
}

/// Input of the `encode` target:
///
/// | bytes | field |
/// |---|---|
/// | 0..2 | width, u16 LE, taken `% (MAX_SIDE + 1)` and raised to 1 |
/// | 2..4 | height, likewise, then lowered so `w · h ≤ MAX_PIXELS` |
/// | 4 | source gamut (`% 5`, C ABI order) |
/// | 5 | tier (`% (MAX_TIER + 1)`) |
/// | 6.. | RGBA, repeated (or zero-filled when empty) to exactly `w · h · 4` |
///
/// The size bounds keep one execution in milliseconds while still covering
/// every spec vector's dimensions (the largest is 320×20, the most pixels
/// 200×150) and both 16:1 aspect clamps.
pub struct EncodeInput {
    pub w: u32,
    pub h: u32,
    pub gamut: Gamut,
    pub tier: u8,
    pub rgba: Vec<u8>,
}

pub const ENCODE_HEADER: usize = 6;
pub const MAX_SIDE: u32 = 512;
pub const MAX_PIXELS: u32 = 32_768;

impl EncodeInput {
    pub fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < ENCODE_HEADER {
            return None;
        }
        let w = (u32::from(u16_le(&data[0..2])) % (MAX_SIDE + 1)).max(1);
        let h = (u32::from(u16_le(&data[2..4])) % (MAX_SIDE + 1))
            .max(1)
            .min(MAX_PIXELS / w);
        let gamut = gamut(data[4]);
        let tier = data[5] % (MAX_TIER + 1);
        let n = w as usize * h as usize * 4;
        let src = &data[ENCODE_HEADER..];
        let rgba = if src.is_empty() {
            vec![0; n]
        } else {
            src.iter().copied().cycle().take(n).collect()
        };
        Some(Self {
            w,
            h,
            gamut,
            tier,
            rgba,
        })
    }
}
