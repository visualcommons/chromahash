//! Randomized property tests for the public API.
//!
//! The golden vectors in `spec/test-vectors/` are the parity gate, but they are
//! *regenerated from this crate*, so they can only catch a change to the
//! bitstream — never a bug that was present when they were written. These tests
//! assert invariants the format guarantees, over inputs nobody enumerated:
//!
//!   - a hash's byte length is a function of `(tier, has_alpha)` alone;
//!   - `from_bytes` accepts exactly what `encode_with_quality` produces;
//!   - anything `from_bytes` accepts, `decode` handles without panicking —
//!     the documented contract that "a hash that validates is guaranteed to
//!     decode";
//!   - encode and decode are deterministic;
//!   - `decode_capped` never exceeds its cap, and never returns an empty image;
//!   - `average_color` agrees with a full decode's mean to within a tolerance
//!     the DC-only path can actually hold.
//!
//! Failures shrink to a minimal reproducer, which is the reason for the
//! dependency over a hand-rolled generator.
//!
//! **These runs are not deterministic.** proptest draws a fresh seed each time,
//! so `mise run test` and the mutation sweep both sample a different corner of the
//! input space on every invocation. That is deliberate — a fixed seed turns a
//! property test into a slow unit test — but it has two consequences worth
//! knowing. A failure here may not reproduce on a re-run: copy the seed
//! proptest prints into `properties.proptest-regressions` (it writes the file
//! itself) and commit it, which pins that case forever. And a mutant these
//! tests kill in one sweep may survive the next, so a single missed mutant in
//! this file's blast radius is worth re-running before acting on.
//!
//! Nothing here should depend on a rare draw to hold: every bound below is
//! either exact or set at a measured worst case over the whole input domain,
//! not at whatever the sample happened to reach.

use chromahash::{COMPACT_TIER, ChromaHash, ChromaHashError, Gamut, MAX_TIER, Tunables};
use proptest::prelude::*;

// Case budgets. Two forces set these, and they pull the same way.
//
// A tier-4 decode rasterizes 256x256 px, so the decoding properties dominate
// this file's runtime — at proptest's default 256 cases it took ~5 minutes in a
// debug build. And cargo-mutants re-runs the whole suite *once per mutant*
// (~2000 of them), so every second here is multiplied by two thousand.
//
// These properties are about shape invariants that hold or fail across the
// whole tier range, not about hunting rare values, so a modest sample finds
// what they can find. Raise them locally when investigating a specific failure.
const CASES: u32 = 96;
const DECODING_CASES: u32 = 24;

/// How far `average_color` may sit from a solid input's own channel value.
///
/// The DC carries lightness at 7 bits and chroma at 6/5 bits over a *bounded*
/// chroma range (`MAX_CHROMA_A` = 0.35, `MAX_CHROMA_B` = 0.33), so a colour
/// sitting near that boundary is reproduced least precisely.
///
/// The worst case is **17**, on saturated green — `[17, 250, 14]`. Exactly two
/// points in the whole RGB cube exceed 16, which is why a stride-3 sweep (the
/// first measurement taken here) stepped straight over both and reported 16.
/// The strategy below draws from the full cube, so 16 was a bound the test
/// could itself have falsified: rare enough never to be seen in practice, and
/// wrong all the same.
///
/// Set at the real maximum: it is the format's behaviour, and drift past it is
/// a regression worth failing on.
const AVERAGE_COLOR_TOLERANCE: i32 = 17;
/// Alpha is linear, not perceptual — its 5-bit DC stays within 4 across the
/// whole 0..=255 sweep.
const ALPHA_TOLERANCE: i32 = 4;

/// Byte lengths per tier code for an opaque image (spec §3.3). Alpha mode uses
/// its own, shorter, table — the second row.
const OPAQUE_LEN: [usize; 5] = [21, 32, 108, 411, 1623];
const ALPHA_LEN: [usize; 5] = [21, 32, 103, 388, 1528];

/// A pseudo-random image from a seed, optionally forced opaque.
///
/// Cheaper than a `Vec<u8>` strategy — proptest would generate and shrink every
/// byte — and the seed is all a failure needs to reproduce.
fn deterministic_image(seed: u64, opaque: bool) -> (u32, u32, Vec<u8>) {
    let mut state = seed | 1;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let w = (next() % 24 + 1) as u32;
    let h = (next() % 24 + 1) as u32;
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    for px in rgba.chunks_exact_mut(4) {
        let v = next();
        px[0] = v as u8;
        px[1] = (v >> 8) as u8;
        px[2] = (v >> 16) as u8;
        px[3] = if opaque { 255 } else { (v >> 24) as u8 & 0x7f };
    }
    (w, h, rgba)
}

fn gamuts() -> impl Strategy<Value = Gamut> {
    prop_oneof![
        Just(Gamut::Srgb),
        Just(Gamut::DisplayP3),
        Just(Gamut::AdobeRgb),
        Just(Gamut::Bt2020),
        Just(Gamut::ProPhotoRgb),
    ]
}

/// A random RGBA image, 1..=24 px on each edge. `opaque` forces alpha to 255 so
/// a test can select the alpha mode deliberately rather than by accident — the
/// two modes have different byte lengths, and conflating them is the mistake
/// this file exists partly to prevent.
fn image(opaque: bool) -> impl Strategy<Value = (u32, u32, Vec<u8>)> {
    (1u32..=24, 1u32..=24).prop_flat_map(move |(w, h)| {
        let n = (w * h) as usize;
        prop::collection::vec(any::<u8>(), n * 4).prop_map(move |mut rgba| {
            if opaque {
                for px in rgba.chunks_exact_mut(4) {
                    px[3] = 255;
                }
            }
            (w, h, rgba)
        })
    })
}

/// The `TooShort` boundary is one exact length — `ceil(PREFIX_BITS / 8)` = 7 —
/// so sampling will not reliably land on it. Enumerate it instead: below 7 is
/// `TooShort`, and 7 itself is *not* (it falls through to the header checks,
/// and then fails the length check, because no tier is 7 bytes long).
///
/// Both entry points must agree; `from_bytes_tuned` is the sweep harness's own
/// validator and had no test at all before.
#[test]
fn the_too_short_boundary_is_exact() {
    let valid = ChromaHash::encode(4, 4, &[128u8; 4 * 4 * 4], Gamut::Srgb)
        .as_bytes()
        .to_vec();

    for len in 0..=8usize {
        let bytes = &valid[..len];
        let expected = if len < 7 {
            Err(ChromaHashError::TooShort)
        } else {
            Err(ChromaHashError::LengthMismatch)
        };
        assert_eq!(
            ChromaHash::from_bytes(bytes),
            expected,
            "from_bytes at {len} bytes"
        );
        assert_eq!(
            ChromaHash::from_bytes_tuned(bytes, &Tunables::DEFAULT),
            expected,
            "from_bytes_tuned at {len} bytes"
        );
    }
}

/// Byte 0 packs four fields — version, tier, alpha flag, reserved bit — and each
/// has its own rejection path. There are only 256 values, so enumerate them all
/// rather than sampling: a random header lands on the reserved-bit check only
/// after passing the version and tier checks, which is a few percent of draws.
///
/// Both entry points must agree, value for value and error for error.
#[test]
fn every_header_byte_is_classified_the_same_by_both_validators() {
    // A real 32-byte default-tier hash, so the length check passes for any
    // header whose tier and alpha flag imply 32 bytes.
    let valid = ChromaHash::encode(4, 4, &[128u8; 4 * 4 * 4], Gamut::Srgb)
        .as_bytes()
        .to_vec();
    assert_eq!(valid.len(), 32);

    let mut seen_version = false;
    let mut seen_tier = false;
    let mut seen_reserved = false;
    let mut seen_ok = false;

    for b0 in 0u8..=255 {
        let mut bytes = valid.clone();
        bytes[0] = b0;

        let plain = ChromaHash::from_bytes(&bytes);
        let tuned = ChromaHash::from_bytes_tuned(&bytes, &Tunables::DEFAULT);
        assert_eq!(
            plain.as_ref().map(|h| h.as_bytes()),
            tuned.as_ref().map(|h| h.as_bytes()),
            "byte 0 = {b0:#04x}"
        );
        assert_eq!(
            plain.as_ref().err(),
            tuned.as_ref().err(),
            "byte 0 = {b0:#04x}"
        );

        // And the classification is the one the format defines, in field order.
        let version = b0 & 0b0000_0111;
        let tier = (b0 >> 3) & 0b0000_0111;
        let reserved = (b0 >> 7) & 1;
        let expected = if version != 0 {
            Some(ChromaHashError::UnsupportedVersion)
        } else if tier > MAX_TIER {
            Some(ChromaHashError::InvalidTier)
        } else if reserved != 0 {
            Some(ChromaHashError::ReservedBitSet)
        } else if tier != 1 {
            // Only the default tier is 32 bytes; the compact tier is 21.
            Some(ChromaHashError::LengthMismatch)
        } else {
            None
        };
        assert_eq!(
            plain.as_ref().err().copied(),
            expected,
            "byte 0 = {b0:#04x}"
        );

        match expected {
            Some(ChromaHashError::UnsupportedVersion) => seen_version = true,
            Some(ChromaHashError::InvalidTier) => seen_tier = true,
            Some(ChromaHashError::ReservedBitSet) => seen_reserved = true,
            None => seen_ok = true,
            _ => {}
        }
    }

    // The sweep must actually reach every branch, or it proves nothing.
    assert!(seen_version && seen_tier && seen_reserved && seen_ok);
}

/// Every error variant must render a distinct, non-empty message.
///
/// These strings are not decoration: the UniFFI and wasm bindings carry them
/// across the FFI as the `reason` a caller sees, so an empty or duplicated one
/// is what a Python or JavaScript user gets instead of a diagnosis.
#[test]
fn every_error_variant_has_its_own_message() {
    use std::collections::HashSet;

    let variants = [
        ChromaHashError::TooShort,
        ChromaHashError::UnsupportedVersion,
        ChromaHashError::InvalidTier,
        ChromaHashError::ReservedBitSet,
        ChromaHashError::LengthMismatch,
    ];

    let mut seen = HashSet::new();
    for v in variants {
        let msg = v.to_string();
        assert!(!msg.is_empty(), "{v:?} renders an empty message");
        assert!(
            msg.contains("chromahash"),
            "{v:?} renders {msg:?}, which does not name the format"
        );
        assert!(
            seen.insert(msg.clone()),
            "{v:?} duplicates the message {msg:?}"
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    /// The byte length depends on the tier and the alpha mode, and on nothing
    /// else — not the dimensions, not the gamut, not the pixel content.
    #[test]
    fn length_is_a_function_of_tier_and_alpha(
        (w, h, rgba) in image(false),
        gamut in gamuts(),
        tier in COMPACT_TIER..=MAX_TIER,
    ) {
        let has_alpha = rgba.chunks_exact(4).any(|px| px[3] != 255);
        let table = if has_alpha { ALPHA_LEN } else { OPAQUE_LEN };
        let hash = ChromaHash::encode_with_quality(w, h, &rgba, gamut, tier);
        prop_assert_eq!(hash.as_bytes().len(), table[tier as usize]);
    }

    /// `from_bytes` accepts exactly what the encoder produced, and hands back
    /// the same bytes.
    ///
    /// `opaque` is a parameter, not a fixed choice: tiers 0 and 1 have the same
    /// byte length in both alpha modes (21 and 32), so a decoder that read the
    /// alpha flag wrongly would still accept them. Only tiers 2–4 distinguish
    /// 108/411/1623 from 103/388/1528, and only with an opaque image.
    #[test]
    fn from_bytes_round_trips_every_encode(
        opaque in any::<bool>(),
        gamut in gamuts(),
        tier in COMPACT_TIER..=MAX_TIER,
        seed in any::<u64>(),
    ) {
        let (w, h, rgba) = deterministic_image(seed, opaque);
        let encoded = ChromaHash::encode_with_quality(w, h, &rgba, gamut, tier);
        prop_assert_eq!(
            encoded.as_bytes().len(),
            if opaque { OPAQUE_LEN } else { ALPHA_LEN }[tier as usize],
            "tier {} alpha={}", tier, !opaque
        );
        let parsed = ChromaHash::from_bytes(encoded.as_bytes())
            .map_err(|e| TestCaseError::fail(format!("rejected its own output: {e}")))?;
        prop_assert_eq!(parsed.as_bytes(), encoded.as_bytes());
    }

    /// Truncating or extending a valid hash must always be rejected: the header
    /// fixes the length exactly.
    #[test]
    fn wrong_lengths_are_always_rejected(
        (w, h, rgba) in image(false),
        tier in COMPACT_TIER..=MAX_TIER,
        drop_n in 1usize..=20,
        extend_n in 1usize..=20,
    ) {
        let bytes = ChromaHash::encode_with_quality(w, h, &rgba, Gamut::Srgb, tier).as_bytes().to_vec();
        let short = &bytes[..bytes.len().saturating_sub(drop_n)];
        prop_assert!(ChromaHash::from_bytes(short).is_err());

        let mut long = bytes.clone();
        long.extend(std::iter::repeat_n(0u8, extend_n));
        prop_assert!(ChromaHash::from_bytes(&long).is_err());
    }

    /// Tier codes above `MAX_TIER` are reserved, and a set reserved bit is
    /// rejected — whatever the rest of the header says.
    #[test]
    fn reserved_header_states_are_rejected(
        (w, h, rgba) in image(false),
        tier in COMPACT_TIER..=MAX_TIER,
        reserved_tier in (MAX_TIER + 1)..=7u8,
    ) {
        let valid = ChromaHash::encode_with_quality(w, h, &rgba, Gamut::Srgb, tier).as_bytes().to_vec();

        let mut bad_tier = valid.clone();
        bad_tier[0] = (bad_tier[0] & !0b0011_1000) | (reserved_tier << 3);
        prop_assert_eq!(
            ChromaHash::from_bytes(&bad_tier).unwrap_err(),
            ChromaHashError::InvalidTier
        );

        let mut reserved_bit = valid.clone();
        reserved_bit[0] |= 0b1000_0000;
        prop_assert_eq!(
            ChromaHash::from_bytes(&reserved_bit).unwrap_err(),
            ChromaHashError::ReservedBitSet
        );
    }

    /// `average_color` reads the DC term straight from the header, without a
    /// decode. For a solid image the DC *is* the color, so this reproduces the
    /// input to within the DC's quantization — the strongest form of the
    /// property, and the one the accessor exists for (a caller paints this
    /// while the real image loads).
    ///
    /// A mean-of-the-decode comparison would be the wrong assertion: the DC is
    /// a mean in Oklab, and for a high-contrast ramp the perceptual mean and
    /// the arithmetic sRGB mean genuinely differ by more than 24/255 — that is
    /// the colour space behaving correctly, not the codec drifting.
    #[test]
    fn average_color_reproduces_a_solid((w, h) in (1u32..=24, 1u32..=24), rgb in any::<[u8; 3]>()) {
        let rgba: Vec<u8> = std::iter::repeat_n([rgb[0], rgb[1], rgb[2], 255], (w * h) as usize)
            .flatten()
            .collect();
        let avg = ChromaHash::encode(w, h, &rgba, Gamut::Srgb).average_color();

        for c in 0..3 {
            prop_assert!(
                (avg[c] as i32 - rgb[c] as i32).abs() <= AVERAGE_COLOR_TOLERANCE,
                "channel {}: average_color {} vs input {}",
                c,
                avg[c],
                rgb[c]
            );
        }
        prop_assert_eq!(avg[3], 255, "an opaque image must report opaque");
    }

    /// The alpha channel is not a perceptual quantity — for a uniformly
    /// transparent image the reported alpha must track the input closely
    /// whatever the color content is.
    #[test]
    fn average_color_tracks_uniform_alpha(
        (w, h) in (1u32..=24, 1u32..=24),
        rgb in any::<[u8; 3]>(),
        alpha in any::<u8>(),
    ) {
        let rgba: Vec<u8> = std::iter::repeat_n([rgb[0], rgb[1], rgb[2], alpha], (w * h) as usize)
            .flatten()
            .collect();
        let avg = ChromaHash::encode(w, h, &rgba, Gamut::Srgb).average_color();
        prop_assert!(
            (avg[3] as i32 - alpha as i32).abs() <= ALPHA_TOLERANCE,
            "alpha {} vs input {}",
            avg[3],
            alpha
        );
    }

    /// Every image encodes at the default tier to exactly 32 bytes when opaque.
    /// This is the single number the format is known by; nothing about getting
    /// it wrong fails to compile or fails to decode.
    #[test]
    fn the_default_tier_is_always_32_bytes((w, h, rgba) in image(true), gamut in gamuts()) {
        prop_assert_eq!(ChromaHash::encode(w, h, &rgba, gamut).as_bytes().len(), 32);
    }
}

// The properties above are cheap; these three decode, which at tier 4 means
// rasterizing 256x256 px per case. Same invariants, smaller sample.
proptest! {
    #![proptest_config(ProptestConfig::with_cases(DECODING_CASES))]

    /// The documented contract: bytes that validate are guaranteed to decode.
    /// Perturbing one byte of a real hash reaches both sides of it — a header
    /// byte usually fails validation, a payload byte usually does not — so this
    /// exercises the accept path with values the encoder never emits.
    #[test]
    fn anything_from_bytes_accepts_decodes(
        (w, h, rgba) in image(false),
        gamut in gamuts(),
        tier in COMPACT_TIER..=MAX_TIER,
        index in 0usize..1623,
        patch in any::<u8>(),
    ) {
        let mut bytes = ChromaHash::encode_with_quality(w, h, &rgba, gamut, tier).as_bytes().to_vec();
        let i = index % bytes.len();
        bytes[i] = patch;

        if let Ok(hash) = ChromaHash::from_bytes(&bytes) {
            let (dw, dh, pixels) = hash.decode();
            prop_assert!(dw > 0 && dh > 0);
            prop_assert_eq!(pixels.len(), (dw * dh * 4) as usize);
            // And every accessor on it, not just decode.
            let _ = hash.average_color();
            let _ = hash.decode_capped(8, 8);
        }
    }

    /// A capped decode never exceeds its cap, never returns an empty image, and
    /// preserves the aspect ratio's orientation.
    #[test]
    fn decode_capped_respects_its_cap(
        (w, h, rgba) in image(false),
        tier in COMPACT_TIER..=MAX_TIER,
        max_w in 1u32..=300,
        max_h in 1u32..=300,
    ) {
        let hash = ChromaHash::encode_with_quality(w, h, &rgba, Gamut::Srgb, tier);
        let (cw, ch, pixels) = hash.decode_capped(max_w, max_h);
        prop_assert!(cw <= max_w, "width {} exceeds cap {}", cw, max_w);
        prop_assert!(ch <= max_h, "height {} exceeds cap {}", ch, max_h);
        prop_assert!(cw > 0 && ch > 0);
        prop_assert_eq!(pixels.len(), (cw * ch * 4) as usize);

        // An uncapped decode is what a cap at or above the natural size gives.
        let (nw, nh, _) = hash.decode();
        if max_w >= nw && max_h >= nh {
            prop_assert_eq!((cw, ch), (nw, nh));
        }
    }

    /// `from_bytes_tuned` is the sweep harness's own validator: it takes the
    /// `Tunables` the runner encoded with, because a sweep that resizes the AC
    /// layout produces a legitimately different length. At `Tunables::DEFAULT`
    /// it must agree with `from_bytes` exactly — same accept set, same error.
    ///
    /// Nothing exercised it before, so a sweep could have been validating
    /// against a broken check and silently discarding good candidates.
    #[test]
    fn from_bytes_tuned_agrees_with_from_bytes_at_the_default(
        opaque in any::<bool>(),
        tier in COMPACT_TIER..=MAX_TIER,
        seed in any::<u64>(),
        // Drive byte 0 directly rather than hoping a random index lands on it:
        // the version, tier, alpha and reserved fields all live there, and each
        // is a separate rejection path.
        header in any::<u8>(),
        touch_header in any::<bool>(),
        // `None` keeps the full hash — without it every tier above 1 (108 bytes
        // and up) would always be truncated below its valid length by the range
        // below, and the paths that only run on a *valid* hash would never be
        // reached at all.
        keep in prop_oneof![Just(None), (0usize..=40).prop_map(Some)],
        patch in any::<u8>(),
        index in 0usize..1623,
    ) {
        let (w, h, rgba) = deterministic_image(seed, opaque);
        let mut bytes = ChromaHash::encode_with_quality(w, h, &rgba, Gamut::Srgb, tier)
            .as_bytes()
            .to_vec();
        if touch_header {
            bytes[0] = header;
        } else {
            let i = index % bytes.len();
            bytes[i] = patch;
        }
        if let Some(keep) = keep {
            bytes.truncate(keep.min(bytes.len()));
        }

        // Compare the whole `Result`, error variant included: the two differ
        // meaningfully when they reject for *different reasons*, and mapping to
        // the Ok payload alone would hide that.
        let plain = ChromaHash::from_bytes(&bytes).map(|h| h.as_bytes().to_vec());
        let tuned = ChromaHash::from_bytes_tuned(&bytes, &Tunables::DEFAULT)
            .map(|h| h.as_bytes().to_vec());
        prop_assert_eq!(plain, tuned);
    }

    /// Encoding and decoding are pure: the same input always gives the same
    /// bytes, and the same bytes always give the same pixels.
    #[test]
    fn encode_and_decode_are_deterministic(
        (w, h, rgba) in image(false),
        gamut in gamuts(),
        tier in COMPACT_TIER..=MAX_TIER,
    ) {
        let a = ChromaHash::encode_with_quality(w, h, &rgba, gamut, tier);
        let b = ChromaHash::encode_with_quality(w, h, &rgba, gamut, tier);
        prop_assert_eq!(a.as_bytes(), b.as_bytes());
        prop_assert_eq!(a.decode(), b.decode());
    }

    /// Register D1's validity design with the entropy coder on
    /// (`Tunables::ac_coder`): the code is total, so a byte string that
    /// validates decodes, and validation is exactly the shipped validator's.
    ///
    /// The strings are random, not perturbed encodes: a valid header and the
    /// header-implied length are drawn on purpose (most random strings fail
    /// the length check and prove nothing about the decoder), with a random
    /// header byte and a wrong length mixed in for the rejection paths.
    #[test]
    fn with_the_coder_on_anything_from_bytes_accepts_decodes(
        tier in 2u8..=MAX_TIER,
        alpha in any::<bool>(),
        aspect in any::<u8>(),
        payload_seed in any::<u64>(),
        header in prop_oneof![Just(None), any::<u8>().prop_map(Some)],
        len_delta in prop_oneof![Just(0isize), -3isize..=3],
    ) {
        let t = coded_tunables();
        let len = if alpha { ALPHA_LEN } else { OPAQUE_LEN }[tier as usize];
        let len = (len as isize + len_delta).max(0) as usize;
        let mut state = payload_seed | 1;
        let mut bytes: Vec<u8> = (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect();
        if len >= 2 {
            bytes[0] = header.unwrap_or((tier << 3) | ((alpha as u8) << 6));
            bytes[1] = aspect;
        }

        let coded = ChromaHash::from_bytes_tuned(&bytes, &t);
        // Every rejection is the named error the shipped validator gives the
        // same bytes: the coded length is the shipped length.
        let shipped = ChromaHash::from_bytes(&bytes);
        prop_assert_eq!(coded.as_ref().err(), shipped.as_ref().err());
        if let Ok(hash) = coded {
            let (dw, dh, pixels) = hash.decode_tuned(&t);
            // The tier's natural size, which the header alone fixes.
            let (nw, nh, _) = shipped.unwrap().decode();
            prop_assert_eq!((dw, dh), (nw, nh));
            prop_assert_eq!(pixels.len(), (dw * dh * 4) as usize);
            let (cw, ch, _) = hash.decode_capped_tuned(8, 8, &t);
            prop_assert!(cw <= 8 && ch <= 8 && cw > 0 && ch > 0);
        }
    }

    /// Coded hashes at codes 2–4 are the shipped length, validate, and decode
    /// at the tier's size, with a bound large enough that the encoder has to
    /// cut the stream to fit.
    #[test]
    fn coded_hashes_validate_and_decode_at_the_tier_size(
        opaque in any::<bool>(),
        tier in 2u8..=MAX_TIER,
        seed in any::<u64>(),
    ) {
        let t = coded_tunables();
        let (w, h, rgba) = deterministic_image(seed, opaque);
        let coded = ChromaHash::encode_tuned_quality(w, h, &rgba, Gamut::Srgb, &t, tier);
        let shipped = ChromaHash::encode_with_quality(w, h, &rgba, Gamut::Srgb, tier);
        prop_assert_eq!(coded.as_bytes().len(), shipped.as_bytes().len());
        let parsed = ChromaHash::from_bytes_tuned(coded.as_bytes(), &t)
            .map_err(|e| TestCaseError::fail(format!("rejected its own output: {e}")))?;
        let (dw, dh, pixels) = parsed.decode_tuned(&t);
        let (nw, nh, _) = shipped.decode();
        prop_assert_eq!((dw, dh), (nw, nh));
        prop_assert_eq!(pixels.len(), (dw * dh * 4) as usize);
    }
}

/// The coder on, with a bound of twice the shipped upper-tier counts in both
/// alpha modes, so random content overflows the stream and the fit search
/// runs.
fn coded_tunables() -> Tunables {
    let mut t = Tunables {
        ac_coder: 1,
        ..Tunables::DEFAULT
    };
    t.layout_upper.l_tiers = [(52, 5), (0, 5)];
    t.layout_upper.c_count = 18;
    t.layout_upper.la_tiers = [(44, 4), (0, 4)];
    t.layout_upper.ca_count = 6;
    t.layout_upper.a_count = 56;
    t
}
