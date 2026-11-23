//! Runs the shared spec test vectors through the UniFFI binding wrappers and asserts
//! byte-exact output. Because the binding just forwards to the core crate, this is the
//! "thin marshalling check" of the contract in `spec/` (see docs/android.md §9): it
//! exercises the Gamut conversion, record packing, the i32 casts, and the fallible
//! `from_bytes` — without needing the Android NDK/SDK, so it runs in plain `cargo test`.

use chromahash_uniffi::{
    BatchEncoder, COMPACT_TIER, ChromaHash, ChromaHashError, DEFAULT_TIER, Gamut, ImageInput,
    MAX_TIER, compact_tier, default_tier, format_version, max_tier,
};
use serde_json::Value;

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

/// Map a spec-vector gamut string to the binding's `Gamut` enum.
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

/// Read a JSON array of integers into a `Vec<u8>`.
fn bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .expect("expected a JSON array of bytes")
        .iter()
        .map(|n| n.as_u64().expect("byte should be a number") as u8)
        .collect()
}

#[test]
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

        let hash = ChromaHash::encode_with_quality(w, h, rgba, gamut, tier)
            .unwrap_or_else(|e| panic!("{name}: encode rejected a spec vector: {e}"));

        assert_eq!(
            hash.as_bytes(),
            bytes(&case["expected"]["hash"]),
            "{name}: hash mismatch"
        );

        // average_color is optional in the vectors but present today.
        if let Some(avg) = case["expected"].get("average_color") {
            let c = hash.average_color();
            assert_eq!(
                vec![c.r as u8, c.g as u8, c.b as u8, c.a as u8],
                bytes(avg),
                "{name}: average_color mismatch"
            );
        }
    }
}

#[test]
fn batch_encode_matches_single_encode() {
    // Drive the encode vectors through the BatchEncoder and compare each result to
    // the single-encode path — byte-identical per the core's contract.
    let cases: Value = serde_json::from_str(ENCODE_VECTORS).expect("parse encode vectors");
    let cases = cases.as_array().expect("encode vectors should be an array");

    // Cycle through every tier so the test would fail if `quality` were ignored
    // and every item silently encoded at the default.
    let items: Vec<ImageInput> = cases
        .iter()
        .enumerate()
        .map(|(i, case)| {
            let input = &case["input"];
            ImageInput {
                w: input["width"].as_u64().expect("width") as u32,
                h: input["height"].as_u64().expect("height") as u32,
                rgba: bytes(&input["rgba"]),
                gamut: gamut_from_str(input["gamut"].as_str().expect("gamut")),
                quality: (i % (MAX_TIER as usize + 1)) as u8,
            }
        })
        .collect();

    let hashes = BatchEncoder::new()
        .encode_batch(items.clone())
        .expect("batch rejected the spec vectors");
    assert_eq!(hashes.len(), items.len(), "batch returned wrong count");

    for (i, (item, batched)) in items.iter().zip(hashes.iter()).enumerate() {
        let single = ChromaHash::encode_with_quality(
            item.w,
            item.h,
            item.rgba.clone(),
            item.gamut,
            item.quality,
        )
        .expect("single encode rejected a spec vector");
        assert_eq!(
            batched.as_bytes(),
            single.as_bytes(),
            "batch item {i} diverges from single encode at tier {}",
            item.quality
        );
    }
}

/// Pin the tier down to the byte count. Comparing batch against single alone
/// would pass if both silently used one tier.
#[test]
fn batch_encode_honors_quality() {
    // Opaque: alpha < 255 selects the alpha layouts, whose lengths differ.
    let rgba: Vec<u8> = std::iter::repeat_n([128, 128, 128, 255], 8 * 8)
        .flatten()
        .collect();
    let items: Vec<ImageInput> = (COMPACT_TIER..=MAX_TIER)
        .map(|quality| ImageInput {
            w: 8,
            h: 8,
            rgba: rgba.clone(),
            gamut: Gamut::Srgb,
            quality,
        })
        .collect();

    let hashes = BatchEncoder::new().encode_batch(items).expect("batch");
    assert_eq!(
        hashes
            .iter()
            .map(|h| h.as_bytes().len())
            .collect::<Vec<_>>(),
        vec![21, 32, 108, 411, 1623],
        "the per-tier byte lengths spec §3.3 tabulates"
    );
}

/// The reserved bit is how v1 reserves room for a future extension: a decoder
/// that ignored it would accept a hash written by a later format and render
/// garbage. Neither it nor a reserved tier code was exercised here.
#[test]
fn from_bytes_rejects_a_malformed_header() {
    let rgba = vec![128u8; 4 * 4 * 4];
    let valid = ChromaHash::encode(4, 4, rgba, Gamut::Srgb)
        .expect("encode")
        .as_bytes();

    for (what, mutate) in [
        ("reserved bit set", 0usize),
        ("reserved tier code", 1),
        ("unsupported version (generation v1)", 2),
    ] {
        let mut bytes = valid.clone();
        bytes[0] = match mutate {
            0 => bytes[0] | 0b1000_0000,
            1 => (bytes[0] & !0b0011_1000) | ((MAX_TIER + 1) << 3),
            _ => bytes[0] & !0b0000_0111,
        };
        assert!(
            matches!(
                ChromaHash::from_bytes(bytes),
                Err(ChromaHashError::InvalidData { .. })
            ),
            "{what}"
        );
    }
}

/// The decoded raster is a function of the tier, so assert the values rather
/// than a range wide enough to pass at every one of them.
#[test]
fn decoded_dimensions_follow_the_tier_raster() {
    let rgba: Vec<u8> = std::iter::repeat_n([128u8, 128, 128, 255], 4 * 4)
        .flatten()
        .collect();
    let edges = [32i32, 32, 64, 128, 256];
    for tier in COMPACT_TIER..=MAX_TIER {
        let hash = ChromaHash::encode_with_quality(4, 4, rgba.clone(), Gamut::Srgb, tier)
            .expect("a valid tier must encode");
        let result = hash.decode();
        assert_eq!(result.width, edges[tier as usize], "tier {tier} width");
        assert_eq!(result.height, edges[tier as usize], "tier {tier} height");
        assert_eq!(
            result.rgba.len(),
            (result.width * result.height * 4) as usize
        );
    }
}

/// The core panics on invalid input; a panic across FFI is undefined behaviour,
/// so the binding must have turned each one into a typed error first.
#[test]
fn encode_rejects_invalid_input_without_panicking() {
    let rgba = vec![128u8; 4 * 4 * 4];

    assert!(matches!(
        ChromaHash::encode(0, 4, rgba.clone(), Gamut::Srgb),
        Err(ChromaHashError::InvalidDimensions { .. })
    ));
    assert!(matches!(
        ChromaHash::encode(4, 0, rgba.clone(), Gamut::Srgb),
        Err(ChromaHashError::InvalidDimensions { .. })
    ));
    assert!(matches!(
        ChromaHash::encode(4, 4, vec![0u8; 3], Gamut::Srgb),
        Err(ChromaHashError::InvalidLength { .. })
    ));
    assert!(matches!(
        ChromaHash::encode_with_quality(4, 4, rgba.clone(), Gamut::Srgb, MAX_TIER + 1),
        Err(ChromaHashError::InvalidTier { .. })
    ));

    // And the batch path validates every item up front, naming the bad one.
    let good = ImageInput {
        w: 4,
        h: 4,
        rgba: rgba.clone(),
        gamut: Gamut::Srgb,
        quality: DEFAULT_TIER,
    };
    let bad = ImageInput {
        quality: MAX_TIER + 1,
        ..good.clone()
    };
    let err = BatchEncoder::new()
        .encode_batch(vec![good, bad])
        .expect_err("a reserved tier must fail the batch");
    assert!(matches!(err, ChromaHashError::InvalidTier { .. }));
    assert!(err.to_string().starts_with("item 1:"), "got {err}");
}

/// The tier codes reach Kotlin, Swift, and Python through these functions —
/// UniFFI cannot export a constant. Assert they still agree with the core.
#[test]
fn exported_tier_functions_match_the_core() {
    assert_eq!(compact_tier(), chromahash::COMPACT_TIER);
    assert_eq!(default_tier(), chromahash::DEFAULT_TIER);
    assert_eq!(max_tier(), chromahash::MAX_TIER);
    assert_eq!(format_version(), chromahash::FORMAT_VERSION);
    assert!(compact_tier() < default_tier() && default_tier() < max_tier());
}

#[test]
fn integration_decode_vectors() {
    let cases: Value = serde_json::from_str(DECODE_VECTORS).expect("parse decode vectors");
    let cases = cases.as_array().expect("decode vectors should be an array");
    assert!(!cases.is_empty(), "no decode vectors found");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let hash = ChromaHash::from_bytes(bytes(&case["input"]["hash"]))
            .expect("spec vector hash should be exactly 32 bytes");
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
            result.rgba,
            bytes(&expected["rgba"]),
            "{name}: rgba mismatch"
        );
    }
}

#[test]
fn from_bytes_rejects_wrong_length() {
    // The expected length is a function of the descriptor byte, so each buffer
    // has to carry the descriptor for the tier whose length it is claiming.
    // Descriptor 9 = version 1, tier 1 (the 32-byte default); descriptor 1 =
    // version 1, the compact tier, which is 21 bytes.
    let mut default_tier = vec![0u8; 32];
    default_tier[0] = 9;
    assert!(
        ChromaHash::from_bytes(default_tier.clone()).is_ok(),
        "from_bytes should accept a 32-byte default-tier buffer"
    );
    let mut compact = vec![0u8; 21];
    compact[0] = 1;
    assert!(
        ChromaHash::from_bytes(compact).is_ok(),
        "from_bytes should accept a 21-byte compact-tier buffer"
    );

    let mut short = default_tier.clone();
    short.truncate(16);
    assert!(
        ChromaHash::from_bytes(short).is_err(),
        "from_bytes should reject a 16-byte buffer"
    );
    let mut long = default_tier.clone();
    long.push(0);
    assert!(
        ChromaHash::from_bytes(long).is_err(),
        "from_bytes should reject a 33-byte buffer"
    );
    // A compact descriptor on a 32-byte buffer is the renumbering's own hazard:
    // it must be a length mismatch, not a silently mis-read default-tier hash.
    let mut compact_on_32 = vec![0u8; 32];
    compact_on_32[0] = 1;
    assert!(
        ChromaHash::from_bytes(compact_on_32).is_err(),
        "a compact-tier descriptor on 32 bytes must be rejected"
    );
}
#[test]
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
        let hash = ChromaHash::from_bytes(bytes(&input["hash"]))
            .unwrap_or_else(|e| panic!("{name}: from_bytes rejected a spec-vector hash: {e}"));
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
            result.rgba,
            bytes(&expected["rgba"]),
            "{name}: rgba mismatch"
        );
        assert!(result.width as u32 <= max_w && result.height as u32 <= max_h);
    }
}
