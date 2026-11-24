//! The decode family on validated hashes: `decode`, `decode_to`,
//! `decode_capped` and `decode_capped_to`, with arbitrary caps and gamuts.
//!
//! Input layout: [`chromahash_fuzz::DecodeInput`]. The hash body is arbitrary,
//! so at code 3 this drives the arithmetic-coded AC stream with bit strings no
//! encoder wrote — the total-code property (§3.6) is what keeps them decodable.
#![no_main]

use chromahash::{ChromaHash, Gamut};
use chromahash_fuzz::{DecodeInput, check_natural, check_raster};
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

    let (nw, nh, natural) = hash.decode();
    check_natural(&hash, nw, nh, &natural);

    // `decode` is `decode_to(Srgb)`.
    let (sw, sh, srgb) = hash.decode_to(Gamut::Srgb);
    assert_eq!(
        (sw, sh, &srgb),
        (nw, nh, &natural),
        "decode != decode_to(Srgb)"
    );

    let (gw, gh, gamut) = hash.decode_to(input.gamut);
    assert_eq!((gw, gh), (nw, nh), "decode_to changed the raster size");
    check_raster(&hash, gw, gh, &gamut);

    // A cap is a per-axis `min` against the natural raster.
    let (cw, ch, capped) = hash.decode_capped_to(input.max_w, input.max_h, input.gamut);
    assert_eq!(
        (cw, ch),
        (nw.min(input.max_w), nh.min(input.max_h)),
        "decode_capped_to is not the per-axis min of natural {nw}x{nh} and cap {}x{}",
        input.max_w,
        input.max_h
    );
    check_raster(&hash, cw, ch, &capped);
    // A cap at or above the natural size renders the natural raster.
    if input.max_w >= nw && input.max_h >= nh {
        assert_eq!(capped, gamut, "an inert cap changed the decode");
    }

    let (pw, ph, plain) = hash.decode_capped(input.max_w, input.max_h);
    assert_eq!(
        (pw, ph),
        (cw, ch),
        "decode_capped and decode_capped_to disagree on size"
    );
    check_raster(&hash, pw, ph, &plain);
});
