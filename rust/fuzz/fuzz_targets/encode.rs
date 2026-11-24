//! `encode_with_quality` on arbitrary images within the documented limits
//! (`w, h ≥ 1`, `rgba.len() == w·h·4`, a valid tier).
//!
//! Input layout: [`chromahash_fuzz::EncodeInput`]. Every encode must produce a
//! hash that `from_bytes` accepts, at exactly the tier's §3.5 length, carrying
//! the requested tier and the §9.1 alpha flag, and that decodes.
#![no_main]

use chromahash::{ChromaHash, DEFAULT_TIER, FORMAT_VERSION};
use chromahash_fuzz::{EncodeInput, check_natural, has_alpha, tier, tier_len, version};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some(input) = EncodeInput::parse(data) else {
        return;
    };
    let hash =
        ChromaHash::encode_with_quality(input.w, input.h, &input.rgba, input.gamut, input.tier);
    let bytes = hash.as_bytes();

    let b0 = bytes[0];
    let alpha = input.rgba.as_chunks::<4>().0.iter().any(|p| p[3] < 255);
    assert_eq!(
        version(b0),
        FORMAT_VERSION,
        "encode wrote a foreign version"
    );
    assert_eq!(tier(b0), input.tier, "encode wrote a different tier");
    assert_eq!(has_alpha(b0), alpha, "alpha flag disagrees with spec §9.1");
    assert_eq!(
        bytes.len(),
        tier_len(input.tier, alpha),
        "tier {} (alpha {alpha}) hash is not the §3.5 length",
        input.tier
    );

    let parsed = ChromaHash::from_bytes(bytes).expect("from_bytes rejected an encoder's own hash");
    assert_eq!(parsed, hash, "from_bytes did not round-trip the hash");

    if input.tier == DEFAULT_TIER {
        let plain = ChromaHash::encode(input.w, input.h, &input.rgba, input.gamut);
        assert_eq!(plain, hash, "encode != encode_with_quality(DEFAULT_TIER)");
    }

    // Decode at a capped size: the natural raster's shape is the `decode`
    // target's job, and a full tier-4 render would dominate the run here.
    let (w, h, rgba) = parsed.decode_capped(32, 32);
    assert!(
        w >= 1 && h >= 1 && w <= 32 && h <= 32,
        "capped decode gave {w}x{h}"
    );
    assert_eq!(rgba.len(), w as usize * h as usize * 4);
    if input.tier <= DEFAULT_TIER {
        // Codes 0 and 1 render at 32 px, so the 32×32 cap is inert there.
        let (nw, nh, natural) = parsed.decode();
        check_natural(&parsed, nw, nh, &natural);
        assert_eq!(
            (nw, nh, natural),
            (w, h, rgba),
            "an inert cap changed the decode"
        );
    }
});
