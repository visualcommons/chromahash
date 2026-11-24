//! The decode family on validated hashes: `decode`, `decode_to`,
//! `decode_capped` and `decode_capped_to`, with arbitrary caps and gamuts.
//!
//! Input layout: [`chromahash_fuzz::DecodeInput`]. The hash body is arbitrary,
//! so at code 3 this drives the arithmetic-coded AC stream with bit strings no
//! encoder wrote — the total-code property (§3.6) is what keeps them decodable.
//!
//! At codes 3 and 4 the caps are lowered to [`HEAVY_CAP`] and the natural
//! size is probed rather than rendered; see [`chromahash_fuzz::HEAVY_TIER`].
#![no_main]

use chromahash::{ChromaHash, Gamut};
use chromahash_fuzz::{
    DecodeInput, HEAVY_CAP, check_decode, check_natural, check_raster, is_heavy,
};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Some(input) = DecodeInput::parse(data) else {
        return;
    };
    // The shortest prefix that validates. `from_bytes` is O(1), so the scan is
    // negligible beside a decode.
    let Some(hash) =
        (0..=input.hash.len()).find_map(|n| ChromaHash::from_bytes(&input.hash[..n]).ok())
    else {
        return;
    };
    let heavy = is_heavy(&hash);

    let (nw, nh, natural_in_gamut) = if heavy {
        let (w, h) = check_decode(&hash);
        (w, h, None)
    } else {
        let (w, h, natural) = hash.decode();
        check_natural(&hash, w, h, &natural);

        // `decode` is `decode_to(Srgb)`.
        let (sw, sh, srgb) = hash.decode_to(Gamut::Srgb);
        assert_eq!(
            (sw, sh, &srgb),
            (w, h, &natural),
            "decode != decode_to(Srgb)"
        );

        let (gw, gh, in_gamut) = hash.decode_to(input.gamut);
        assert_eq!((gw, gh), (w, h), "decode_to changed the raster size");
        check_raster(&hash, gw, gh, &in_gamut);
        (w, h, Some(in_gamut))
    };

    let (max_w, max_h) = if heavy {
        (input.max_w.min(HEAVY_CAP), input.max_h.min(HEAVY_CAP))
    } else {
        (input.max_w, input.max_h)
    };

    // A cap is a per-axis `min` against the natural raster.
    let (cw, ch, capped) = hash.decode_capped_to(max_w, max_h, input.gamut);
    assert_eq!(
        (cw, ch),
        (nw.min(max_w), nh.min(max_h)),
        "decode_capped_to is not the per-axis min of natural {nw}x{nh} and cap {max_w}x{max_h}"
    );
    check_raster(&hash, cw, ch, &capped);
    // A cap at or above the natural size renders the natural raster.
    if let Some(natural) = natural_in_gamut
        && max_w >= nw
        && max_h >= nh
    {
        assert_eq!(capped, natural, "an inert cap changed the decode");
    }

    let (pw, ph, plain) = hash.decode_capped(max_w, max_h);
    assert_eq!(
        (pw, ph),
        (cw, ch),
        "decode_capped and decode_capped_to disagree on size"
    );
    check_raster(&hash, pw, ph, &plain);
});
