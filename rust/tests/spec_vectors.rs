//! Runs the shared spec test vectors through the public Rust API and asserts
//! byte-exact output. The Rust core is the *reference* implementation that
//! `generate_test_vectors` writes these vectors from — but it previously never
//! read them back, so a change to encode/decode that altered the bitstream went
//! unnoticed here (only the binding crates re-checked the committed vectors).
//!
//! This test closes that gap: it pins the reference output to the committed
//! `spec/test-vectors/*.json`, mirroring `bindings/c/tests/spec_vectors.rs` and
//! the matching tests in the other binding crates. Regenerating the vectors is a
//! deliberate, reviewed act (`cargo test -- --ignored generate_test_vectors`);
//! absent that, encode/decode output must reproduce them exactly.

use chromahash::{BatchEncoder, ChromaHash, Gamut, ImageInput};
use serde_json::Value;
use std::sync::Arc;

const ENCODE_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../spec/test-vectors/integration-encode.json"
));
const DECODE_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../spec/test-vectors/integration-decode.json"
));
const DECODE_CAPPED_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../spec/test-vectors/integration-decode-capped.json"
));
const VALIDATE_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../spec/test-vectors/unit-validate.json"
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

fn hash_from_bytes(v: &Value) -> ChromaHash {
    ChromaHash::from_bytes(&bytes(v)).expect("spec-vector hash must be a valid v1 hash")
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

        let hash = ChromaHash::encode_with_quality(w, h, &rgba, gamut, tier);

        assert_eq!(
            hash.as_bytes().to_vec(),
            bytes(&case["expected"]["hash"]),
            "{name}: hash mismatch"
        );

        if let Some(avg) = case["expected"].get("average_color") {
            assert_eq!(
                hash.average_color().to_vec(),
                bytes(avg),
                "{name}: average_color mismatch"
            );
        }

        // A freshly encoded hash must round-trip through the validating parser.
        assert!(
            ChromaHash::from_bytes(hash.as_bytes()).is_ok(),
            "{name}: freshly encoded hash must validate"
        );
    }
}

#[test]
fn integration_decode_vectors() {
    let cases: Value = serde_json::from_str(DECODE_VECTORS).expect("parse decode vectors");
    let cases = cases.as_array().expect("decode vectors should be an array");
    assert!(!cases.is_empty(), "no decode vectors found");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let hash = hash_from_bytes(&case["input"]["hash"]);

        let (w, h, rgba) = hash.decode();

        let expected = &case["expected"];
        assert_eq!(
            w as u64,
            expected["width"].as_u64().expect("width"),
            "{name}: width mismatch"
        );
        assert_eq!(
            h as u64,
            expected["height"].as_u64().expect("height"),
            "{name}: height mismatch"
        );
        assert_eq!(rgba, bytes(&expected["rgba"]), "{name}: rgba mismatch");
    }
}

#[test]
fn integration_decode_capped_vectors() {
    let cases: Value =
        serde_json::from_str(DECODE_CAPPED_VECTORS).expect("parse capped decode vectors");
    let cases = cases.as_array().expect("capped vectors should be an array");
    assert!(!cases.is_empty(), "no capped decode vectors found");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = &case["input"];
        let hash = hash_from_bytes(&input["hash"]);
        let max_w = input["max_width"].as_u64().expect("max_width") as u32;
        let max_h = input["max_height"].as_u64().expect("max_height") as u32;

        let (w, h, rgba) = hash.decode_capped(max_w, max_h);

        let expected = &case["expected"];
        assert_eq!(
            w as u64,
            expected["width"].as_u64().expect("width"),
            "{name}: width mismatch"
        );
        assert_eq!(
            h as u64,
            expected["height"].as_u64().expect("height"),
            "{name}: height mismatch"
        );
        assert_eq!(rgba, bytes(&expected["rgba"]), "{name}: rgba mismatch");
    }
}

#[test]
fn batch_encode_matches_spec_vectors() {
    // The persistent-pool batch path must be byte-identical to single encode —
    // run the encode vectors through it and compare against the committed hashes.
    let cases: Value = serde_json::from_str(ENCODE_VECTORS).expect("parse encode vectors");
    let cases = cases.as_array().expect("encode vectors should be an array");

    let items: Vec<ImageInput> = cases
        .iter()
        .map(|case| {
            let input = &case["input"];
            ImageInput {
                w: input["width"].as_u64().unwrap() as u32,
                h: input["height"].as_u64().unwrap() as u32,
                rgba: Arc::from(bytes(&input["rgba"]).into_boxed_slice()),
                gamut: gamut_from_str(input["gamut"].as_str().unwrap()),
                quality: input["tier"].as_u64().unwrap() as u8,
            }
        })
        .collect();

    let encoder = BatchEncoder::new();
    let hashes = encoder.encode_batch(&items);
    assert_eq!(hashes.len(), cases.len());

    for (case, hash) in cases.iter().zip(hashes) {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        assert_eq!(
            hash.as_bytes().to_vec(),
            bytes(&case["expected"]["hash"]),
            "{name}: batch hash mismatch"
        );
    }
}

#[test]
fn unit_validate_vectors() {
    // from_bytes is the decodability check: each vector pins whether a byte
    // string is accepted ("ok") or rejected (the ChromaHashError variant name).
    let cases: Value = serde_json::from_str(VALIDATE_VECTORS).expect("parse validate vectors");
    let cases = cases
        .as_array()
        .expect("validate vectors should be an array");
    assert!(!cases.is_empty(), "no validate vectors found");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = bytes(&case["input"]["bytes"]);
        let expected = case["expected"]["result"].as_str().expect("result");
        let got = match ChromaHash::from_bytes(&input) {
            Ok(_) => "ok".to_string(),
            Err(e) => format!("{e:?}"),
        };
        assert_eq!(got, expected, "{name}: validation result mismatch");
    }
}

#[test]
fn interleaved_encode_vectors_decode_to_the_shipped_pixels() {
    // Register entry D2, part 1: the embedded order is a pure permutation of
    // the fixed-width fields, so every encode vector, at every code 0-4 and in
    // both alpha modes, must decode to exactly the shipped channel-sequential
    // pixels at full length, while its bytes differ wherever it has more than
    // one AC code to reorder.
    use chromahash::Tunables;
    let interleaved = Tunables {
        interleave: true,
        ..Tunables::DEFAULT
    };
    let cases: Value = serde_json::from_str(ENCODE_VECTORS).expect("parse encode vectors");
    let cases = cases.as_array().expect("encode vectors should be an array");
    let mut tiers = [0usize; 5];
    let mut reordered = 0usize;
    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = &case["input"];
        let w = input["width"].as_u64().expect("width") as u32;
        let h = input["height"].as_u64().expect("height") as u32;
        let gamut = gamut_from_str(input["gamut"].as_str().expect("gamut"));
        let tier = input["tier"].as_u64().expect("tier") as u8;
        let rgba = bytes(&input["rgba"]);

        let shipped = ChromaHash::encode_with_quality(w, h, &rgba, gamut, tier);
        let mixed = ChromaHash::encode_tuned_quality(w, h, &rgba, gamut, &interleaved, tier);
        assert_eq!(
            shipped.as_bytes(),
            bytes(&case["expected"]["hash"]).as_slice(),
            "{name}: premise: the shipped encode is the vector"
        );
        assert_eq!(
            mixed.as_bytes().len(),
            shipped.as_bytes().len(),
            "{name}: length"
        );
        if mixed.as_bytes() != shipped.as_bytes() {
            reordered += 1;
        }
        assert_eq!(
            mixed.decode_tuned(&interleaved),
            shipped.decode(),
            "{name}: the interleaved hash decodes to other pixels"
        );
        tiers[tier as usize] += 1;
    }
    assert!(
        tiers.iter().all(|&n| n > 0),
        "premise: vectors at every code 0-4 ({tiers:?})"
    );
    assert!(
        reordered > cases.len() / 2,
        "premise: most vectors reorder ({reordered})"
    );
}
