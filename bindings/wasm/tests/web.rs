//! Runs the shared spec test vectors through the wasm-bindgen surface, compiled to
//! wasm and executed in Node via `wasm-pack test --node`. The vectors are embedded
//! with `include_str!` because the wasm test runner has no filesystem. Mirrors the
//! C and UniFFI parity gates.

use chromahash::MAX_TIER;
use chromahash_wasm::{compact_tier, default_tier, format_version, max_tier, ChromaHash, Gamut};
use serde_json::Value;
use wasm_bindgen_test::*;

const ENCODE_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/test-vectors/integration-encode.json"
));
const DECODE_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/test-vectors/integration-decode.json"
));
const DECODE_CAPPED_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/test-vectors/integration-decode-capped.json"
));

fn gamut_from_str(s: &str) -> Gamut {
    match s {
        "sRGB" => Gamut::Srgb,
        "Display P3" => Gamut::DisplayP3,
        "Adobe RGB" => Gamut::AdobeRgb,
        "BT.2020" => Gamut::Bt2020,
        "ProPhoto RGB" => Gamut::ProPhotoRgb,
        other => panic!("unknown gamut in spec vector: {other:?}"),
    }
}

fn bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .expect("expected a JSON array of bytes")
        .iter()
        .map(|n| n.as_u64().expect("byte should be a number") as u8)
        .collect()
}

#[wasm_bindgen_test]
fn integration_encode_vectors() {
    let cases: Value = serde_json::from_str(ENCODE_VECTORS).expect("parse encode vectors");
    let cases = cases.as_array().expect("encode vectors should be an array");
    assert!(!cases.is_empty(), "no encode vectors found");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = &case["input"];
        let w = input["width"].as_u64().expect("width") as u32;
        let h = input["height"].as_u64().expect("height") as u32;
        let gamut = gamut_from_str(input["gamut"].as_str().expect("gamut"));
        let tier = input["tier"].as_u64().expect("tier") as u8;
        let rgba = bytes(&input["rgba"]);

        let hash = ChromaHash::encode_with_quality(w, h, &rgba, gamut, tier)
            .unwrap_or_else(|_| panic!("{name}: encode rejected a spec vector"));
        assert_eq!(
            hash.as_bytes(),
            bytes(&case["expected"]["hash"]),
            "{name}: hash mismatch"
        );

        if let Some(avg) = case["expected"].get("average_color") {
            assert_eq!(
                hash.average_color(),
                bytes(avg),
                "{name}: average_color mismatch"
            );
        }
    }
}

#[wasm_bindgen_test]
fn integration_decode_vectors() {
    let cases: Value = serde_json::from_str(DECODE_VECTORS).expect("parse decode vectors");
    let cases = cases.as_array().expect("decode vectors should be an array");
    assert!(!cases.is_empty(), "no decode vectors found");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let hash_bytes = bytes(&case["input"]["hash"]);
        let hash = ChromaHash::from_bytes(&hash_bytes)
            .unwrap_or_else(|_| panic!("{name}: from_bytes rejected a 32-byte hash"));
        let result = hash.decode();

        let expected = &case["expected"];
        assert_eq!(
            result.width as u64,
            expected["width"].as_u64().expect("width"),
            "{name}: width mismatch"
        );
        assert_eq!(
            result.height as u64,
            expected["height"].as_u64().expect("height"),
            "{name}: height mismatch"
        );
        assert_eq!(
            result.rgba(),
            bytes(&expected["rgba"]),
            "{name}: rgba mismatch"
        );
    }
}

/// Every tier has its own exact byte length, so a fixed length is not a valid
/// assertion for any of them. Derive each length from a real encode rather than
/// hard-coding one — that is what let the pre-renumbering `[0u8; 32]` assertion
/// survive the tier renumbering, when byte 0 = 0 stopped meaning the 32-byte tier
/// and started meaning the 21-byte compact one.
#[wasm_bindgen_test]
fn from_bytes_accepts_every_tier_and_rejects_wrong_lengths() {
    let rgba = vec![128u8; 4 * 4 * 4];

    for tier in 0..=MAX_TIER {
        let encoded = ChromaHash::encode_with_quality(4, 4, &rgba, Gamut::Srgb, tier)
            .expect("encode should accept a valid tier")
            .as_bytes();

        assert!(
            ChromaHash::from_bytes(&encoded).is_ok(),
            "tier {tier}: from_bytes rejected its own {} byte encoding",
            encoded.len()
        );

        let short = &encoded[..encoded.len() - 1];
        assert!(
            ChromaHash::from_bytes(short).is_err(),
            "tier {tier}: from_bytes accepted a buffer one byte short"
        );

        let mut long = encoded.clone();
        long.push(0);
        assert!(
            ChromaHash::from_bytes(&long).is_err(),
            "tier {tier}: from_bytes accepted a buffer one byte long"
        );
    }
}

/// The reserved bit is how v1 reserves room for a future extension: a decoder
/// that ignored it would accept a hash written by a later format and render
/// garbage. Neither it nor a reserved tier code was exercised here.
#[wasm_bindgen_test]
fn from_bytes_rejects_a_malformed_header() {
    let rgba = [128u8; 4 * 4 * 4];
    let valid = ChromaHash::encode(4, 4, &rgba, Gamut::Srgb)
        .expect("encode")
        .as_bytes();

    let mut reserved_bit = valid.clone();
    reserved_bit[0] |= 0b1000_0000;
    assert!(
        ChromaHash::from_bytes(&reserved_bit).is_err(),
        "reserved bit set"
    );

    let mut reserved_tier = valid.clone();
    reserved_tier[0] = (reserved_tier[0] & !0b0011_1000) | ((MAX_TIER + 1) << 3);
    assert!(
        ChromaHash::from_bytes(&reserved_tier).is_err(),
        "reserved tier code"
    );

    let mut bad_version = valid.clone();
    bad_version[0] |= 0b0000_0010; // version 3: no generation this build implements
    assert!(
        ChromaHash::from_bytes(&bad_version).is_err(),
        "unsupported version"
    );
}

/// The byte length is a function of the tier alone, so assert all five rather
/// than only the default; and the decoded raster is per-tier too, so a range
/// check wide enough to pass at every tier cannot tell them apart.
#[wasm_bindgen_test]
fn each_tier_has_its_documented_length_and_raster() {
    // Opaque: alpha < 255 selects the alpha layouts, whose lengths differ.
    let rgba: Vec<u8> = std::iter::repeat_n([128u8, 128, 128, 255], 4 * 4)
        .flatten()
        .collect();
    let lengths = [21usize, 32, 108, 411, 1623];
    let edges = [32u32, 32, 64, 128, 256];

    for tier in 0..=MAX_TIER {
        let hash = ChromaHash::encode_with_quality(4, 4, &rgba, Gamut::Srgb, tier)
            .expect("a valid tier must encode");
        assert_eq!(
            hash.as_bytes().len(),
            lengths[tier as usize],
            "tier {tier} byte length"
        );
        let decoded = hash.decode();
        assert_eq!(decoded.width, edges[tier as usize], "tier {tier} width");
        assert_eq!(decoded.height, edges[tier as usize], "tier {tier} height");
        assert_eq!(
            decoded.rgba().len(),
            (decoded.width * decoded.height * 4) as usize
        );
    }
}

/// A Rust panic in WebAssembly aborts the module instance, so every later call
/// on it fails too — far worse than a thrown error. Each of these panics in the
/// core, so the binding must reject them before they reach it.
#[wasm_bindgen_test]
fn encode_rejects_invalid_input_without_panicking() {
    let rgba = [128u8; 4 * 4 * 4];

    assert!(ChromaHash::encode(0, 4, &rgba, Gamut::Srgb).is_err());
    assert!(ChromaHash::encode(4, 0, &rgba, Gamut::Srgb).is_err());
    assert!(ChromaHash::encode(4, 4, &rgba[..3], Gamut::Srgb).is_err());
    assert!(
        ChromaHash::encode_with_quality(4, 4, &rgba, Gamut::Srgb, MAX_TIER + 1).is_err(),
        "a reserved tier code must be rejected"
    );

    // And the module is still usable afterwards — the point of not panicking.
    assert!(ChromaHash::encode(4, 4, &rgba, Gamut::Srgb).is_ok());
}

/// The TypeScript package reads the tier codes through these, and its own
/// pure-TS decoder declares them independently. This is the tie between them.
#[wasm_bindgen_test]
fn exported_tier_functions_match_the_core() {
    assert_eq!(compact_tier(), chromahash::COMPACT_TIER);
    assert_eq!(default_tier(), chromahash::DEFAULT_TIER);
    assert_eq!(max_tier(), chromahash::MAX_TIER);
    assert_eq!(format_version(), chromahash::FORMAT_VERSION);
}
#[wasm_bindgen_test]
fn integration_decode_capped_vectors() {
    // The capped decode has its own scaling path (it picks a render size that
    // fits the cap, not the tier's natural raster), and neither this binding nor
    // the UniFFI one replayed these vectors — the two FFI surfaces were the only
    // ones exercising `decode` but not `decode_capped` against the contract.
    let cases: Value =
        serde_json::from_str(DECODE_CAPPED_VECTORS).expect("parse decode-capped vectors");
    let cases = cases
        .as_array()
        .expect("decode-capped vectors should be an array");
    assert!(!cases.is_empty(), "no decode-capped vectors found");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = &case["input"];
        let max_w = input["max_width"].as_u64().expect("max_width") as u32;
        let max_h = input["max_height"].as_u64().expect("max_height") as u32;
        let hash = ChromaHash::from_bytes(&bytes(&input["hash"]))
            .unwrap_or_else(|_| panic!("{name}: from_bytes rejected a spec-vector hash"));
        let result = hash.decode_capped(max_w, max_h);

        let expected = &case["expected"];
        assert_eq!(
            result.width as u64,
            expected["width"].as_u64().expect("width"),
            "{name}: width mismatch"
        );
        assert_eq!(
            result.height as u64,
            expected["height"].as_u64().expect("height"),
            "{name}: height mismatch"
        );
        assert_eq!(
            result.rgba(),
            bytes(&expected["rgba"]),
            "{name}: rgba mismatch"
        );
        assert!(result.width <= max_w && result.height <= max_h);
    }
}
