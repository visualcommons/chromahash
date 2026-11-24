//! Runs the shared spec test vectors through the C ABI (`extern "C"` functions
//! called as Rust fns) and asserts byte-exact output. This is the parity gate for
//! the C surface — and, transitively, for the C# (P/Invoke) and Go (cgo) bindings
//! that link this same library. Mirrors `bindings/uniffi/tests/spec_vectors.rs`.

use std::ptr;

use chromahash_c::{
    chromahash_as_bytes, chromahash_average_color, chromahash_batch_encode,
    chromahash_batch_encoder_free, chromahash_batch_encoder_new, chromahash_byte_len,
    chromahash_decode, chromahash_decode_capped, chromahash_encode, chromahash_encode_with_quality,
    chromahash_free, chromahash_from_bytes, chromahash_image_free, ChromaHash, ChromaHashColor,
    ChromaHashGamut, ChromaHashImage, ChromaHashImageInput, ChromaHashStatus,
    CHROMAHASH_COMPACT_TIER, CHROMAHASH_DEFAULT_TIER, CHROMAHASH_FORMAT_VERSION,
    CHROMAHASH_MAX_TIER, CHROMA_HASH_GAMUT_ADOBE_RGB, CHROMA_HASH_GAMUT_BT2020,
    CHROMA_HASH_GAMUT_DISPLAY_P3, CHROMA_HASH_GAMUT_PRO_PHOTO_RGB, CHROMA_HASH_GAMUT_SRGB,
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

fn gamut_from_str(s: &str) -> ChromaHashGamut {
    match s {
        "sRGB" => CHROMA_HASH_GAMUT_SRGB,
        "Display P3" => CHROMA_HASH_GAMUT_DISPLAY_P3,
        "Adobe RGB" => CHROMA_HASH_GAMUT_ADOBE_RGB,
        "BT.2020" => CHROMA_HASH_GAMUT_BT2020,
        "ProPhoto RGB" => CHROMA_HASH_GAMUT_PRO_PHOTO_RGB,
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

/// Encode through the C ABI at the given quality tier and return the resulting
/// handle (caller frees).
fn encode(w: u32, h: u32, rgba: &[u8], gamut: ChromaHashGamut, tier: u8) -> *mut ChromaHash {
    let mut handle: *mut ChromaHash = ptr::null_mut();
    let status = unsafe {
        chromahash_encode_with_quality(w, h, rgba.as_ptr(), rgba.len(), gamut, tier, &mut handle)
    };
    assert_eq!(status, ChromaHashStatus::Ok, "encode returned an error");
    assert!(!handle.is_null(), "encode produced a null handle");
    handle
}

fn hash_bytes(handle: *mut ChromaHash) -> Vec<u8> {
    let len = unsafe { chromahash_byte_len(handle) };
    let mut out = vec![0u8; len];
    let status = unsafe { chromahash_as_bytes(handle, out.as_mut_ptr(), out.len()) };
    assert_eq!(status, ChromaHashStatus::Ok, "as_bytes returned an error");
    out
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

        let handle = encode(w, h, &rgba, gamut, tier);

        assert_eq!(
            hash_bytes(handle),
            bytes(&case["expected"]["hash"]),
            "{name}: hash mismatch"
        );

        if let Some(avg) = case["expected"].get("average_color") {
            let mut color = ChromaHashColor {
                r: 0,
                g: 0,
                b: 0,
                a: 0,
            };
            let status = unsafe { chromahash_average_color(handle, &mut color) };
            assert_eq!(status, ChromaHashStatus::Ok, "{name}: average_color error");
            assert_eq!(
                vec![color.r, color.g, color.b, color.a],
                bytes(avg),
                "{name}: average_color mismatch"
            );
        }

        unsafe { chromahash_free(handle) };
    }
}

#[test]
fn integration_decode_vectors() {
    let cases: Value = serde_json::from_str(DECODE_VECTORS).expect("parse decode vectors");
    let cases = cases.as_array().expect("decode vectors should be an array");
    assert!(!cases.is_empty(), "no decode vectors found");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let hash = bytes(&case["input"]["hash"]);

        let mut handle: *mut ChromaHash = ptr::null_mut();
        let status = unsafe { chromahash_from_bytes(hash.as_ptr(), hash.len(), &mut handle) };
        assert_eq!(status, ChromaHashStatus::Ok, "{name}: from_bytes error");

        let mut image = ChromaHashImage {
            width: 0,
            height: 0,
            rgba: ptr::null_mut(),
            rgba_len: 0,
        };
        let status = unsafe { chromahash_decode(handle, &mut image) };
        assert_eq!(status, ChromaHashStatus::Ok, "{name}: decode error");

        let expected = &case["expected"];
        assert_eq!(
            image.width as u64,
            expected["width"].as_u64().expect("width"),
            "{name}: width mismatch"
        );
        assert_eq!(
            image.height as u64,
            expected["height"].as_u64().expect("height"),
            "{name}: height mismatch"
        );
        let rgba = unsafe { std::slice::from_raw_parts(image.rgba, image.rgba_len) };
        assert_eq!(
            rgba,
            bytes(&expected["rgba"]).as_slice(),
            "{name}: rgba mismatch"
        );

        unsafe { chromahash_image_free(&mut image) };
        assert!(image.rgba.is_null(), "image_free must null the buffer");
        unsafe { chromahash_free(handle) };
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
        let hash = bytes(&input["hash"]);
        let max_w = input["max_width"].as_u64().expect("max_width") as u32;
        let max_h = input["max_height"].as_u64().expect("max_height") as u32;

        let mut handle: *mut ChromaHash = ptr::null_mut();
        let status = unsafe { chromahash_from_bytes(hash.as_ptr(), hash.len(), &mut handle) };
        assert_eq!(status, ChromaHashStatus::Ok, "{name}: from_bytes error");

        let mut image = ChromaHashImage {
            width: 0,
            height: 0,
            rgba: ptr::null_mut(),
            rgba_len: 0,
        };
        let status = unsafe { chromahash_decode_capped(handle, max_w, max_h, &mut image) };
        assert_eq!(status, ChromaHashStatus::Ok, "{name}: decode_capped error");

        let expected = &case["expected"];
        assert_eq!(
            image.width as u64,
            expected["width"].as_u64().expect("width"),
            "{name}: width mismatch"
        );
        assert_eq!(
            image.height as u64,
            expected["height"].as_u64().expect("height"),
            "{name}: height mismatch"
        );
        let rgba = unsafe { std::slice::from_raw_parts(image.rgba, image.rgba_len) };
        assert_eq!(
            rgba,
            bytes(&expected["rgba"]).as_slice(),
            "{name}: rgba mismatch"
        );

        unsafe { chromahash_image_free(&mut image) };
        unsafe { chromahash_free(handle) };
    }
}

#[test]
fn from_bytes_rejects_wrong_length() {
    // v1 self-describing validation: the header fixes the exact byte length, so
    // any other length is InvalidData. A zeroed byte 0 is tier *0* — the 21-byte
    // compact tier, not the 32-byte default — which is why the buffers below are
    // 16 and 33 rather than a fixed 32.
    let mut handle: *mut ChromaHash = ptr::null_mut();
    let buf = [0u8; 16];
    assert_eq!(
        unsafe { chromahash_from_bytes(buf.as_ptr(), buf.len(), &mut handle) },
        ChromaHashStatus::InvalidData,
        "from_bytes should reject a 16-byte buffer"
    );
    let buf = [0u8; 33];
    assert_eq!(
        unsafe { chromahash_from_bytes(buf.as_ptr(), buf.len(), &mut handle) },
        ChromaHashStatus::InvalidData,
        "from_bytes should reject a 33-byte buffer"
    );
}

#[test]
fn encode_rejects_bad_args() {
    let mut handle: *mut ChromaHash = ptr::null_mut();
    let rgba = [0u8; 16];
    // Zero dimension.
    assert_eq!(
        unsafe {
            chromahash_encode(
                0,
                1,
                rgba.as_ptr(),
                rgba.len(),
                CHROMA_HASH_GAMUT_SRGB,
                &mut handle,
            )
        },
        ChromaHashStatus::InvalidDimensions
    );
    // Length mismatch (2x2 needs 16 bytes; give 8).
    let short = [0u8; 8];
    assert_eq!(
        unsafe {
            chromahash_encode(
                2,
                2,
                short.as_ptr(),
                short.len(),
                CHROMA_HASH_GAMUT_SRGB,
                &mut handle,
            )
        },
        ChromaHashStatus::InvalidLength
    );
    // Null rgba.
    assert_eq!(
        unsafe { chromahash_encode(2, 2, ptr::null(), 16, CHROMA_HASH_GAMUT_SRGB, &mut handle) },
        ChromaHashStatus::NullPointer
    );
}

#[test]
fn batch_encode_matches_single_encode() {
    // Take the encode vectors, run them through the batch API, and compare each
    // result to the single-encode path — byte-identical per the core's contract.
    let cases: Value = serde_json::from_str(ENCODE_VECTORS).expect("parse encode vectors");
    let cases = cases.as_array().expect("encode vectors should be an array");

    // Keep the rgba buffers alive for the duration of the batch call.
    let owned: Vec<(u32, u32, Vec<u8>, ChromaHashGamut)> = cases
        .iter()
        .map(|case| {
            let input = &case["input"];
            (
                input["width"].as_u64().unwrap() as u32,
                input["height"].as_u64().unwrap() as u32,
                bytes(&input["rgba"]),
                gamut_from_str(input["gamut"].as_str().unwrap()),
            )
        })
        .collect();

    // Cycle through every tier so the test would fail if `quality` were ignored
    // and every item silently encoded at the default.
    let tier_of = |i: usize| (i % (chromahash::MAX_TIER as usize + 1)) as u8;

    let items: Vec<ChromaHashImageInput> = owned
        .iter()
        .enumerate()
        .map(|(i, (w, h, rgba, gamut))| ChromaHashImageInput {
            width: *w,
            height: *h,
            rgba: rgba.as_ptr(),
            rgba_len: rgba.len(),
            gamut: *gamut,
            quality: tier_of(i),
        })
        .collect();

    let encoder = chromahash_batch_encoder_new();
    assert!(!encoder.is_null(), "batch encoder creation failed");

    let mut out: Vec<*mut ChromaHash> = vec![ptr::null_mut(); items.len()];
    let status =
        unsafe { chromahash_batch_encode(encoder, items.as_ptr(), items.len(), out.as_mut_ptr()) };
    assert_eq!(status, ChromaHashStatus::Ok, "batch_encode error");

    for (i, (w, h, rgba, gamut)) in owned.iter().enumerate() {
        let single = encode(*w, *h, rgba, *gamut, tier_of(i));
        assert_eq!(
            hash_bytes(out[i]),
            hash_bytes(single),
            "batch item {i} diverges from single encode at tier {}",
            tier_of(i)
        );
        unsafe { chromahash_free(single) };
        unsafe { chromahash_free(out[i]) };
    }

    unsafe { chromahash_batch_encoder_free(encoder) };
}

#[test]
fn batch_encode_rejects_a_reserved_tier() {
    // The batch path validates every item up front, exactly like the single
    // encode: one bad tier fails the whole call and allocates no handle.
    let rgba = [128u8; 4 * 4 * 4];
    let items = [ChromaHashImageInput {
        width: 4,
        height: 4,
        rgba: rgba.as_ptr(),
        rgba_len: rgba.len(),
        gamut: CHROMA_HASH_GAMUT_SRGB,
        quality: chromahash::MAX_TIER + 1,
    }];

    let encoder = chromahash_batch_encoder_new();
    assert!(!encoder.is_null(), "batch encoder creation failed");
    let mut out: Vec<*mut ChromaHash> = vec![ptr::null_mut(); items.len()];
    let status =
        unsafe { chromahash_batch_encode(encoder, items.as_ptr(), items.len(), out.as_mut_ptr()) };
    assert_eq!(status, ChromaHashStatus::InvalidData);
    assert!(out[0].is_null(), "no handle may be allocated on error");
    unsafe { chromahash_batch_encoder_free(encoder) };
}

/// The byte length is a function of the tier alone, so assert all five rather
/// than only the default — a `len == 32` check is true of exactly one tier and
/// says nothing about the other four. Same for the decoded raster, where a
/// range check wide enough to pass at every tier cannot tell them apart.
/// The reserved bit is how v1 reserves room for a future extension: a decoder
/// that ignored it would accept a hash written by a later format and render
/// garbage. Neither it nor a reserved tier code was exercised through this ABI.
#[test]
fn from_bytes_rejects_a_malformed_header() {
    let rgba = [128u8; 4 * 4 * 4];
    let valid = {
        let h = encode(
            4,
            4,
            &rgba,
            CHROMA_HASH_GAMUT_SRGB,
            chromahash::DEFAULT_TIER,
        );
        let bytes = hash_bytes(h).to_vec();
        unsafe { chromahash_free(h) };
        bytes
    };

    let reject = |bytes: &[u8], what: &str| {
        let mut handle: *mut ChromaHash = ptr::null_mut();
        let status = unsafe { chromahash_from_bytes(bytes.as_ptr(), bytes.len(), &mut handle) };
        assert_eq!(status, ChromaHashStatus::InvalidData, "{what}");
        assert!(handle.is_null(), "{what}: a handle was allocated");
    };

    let mut reserved_bit = valid.clone();
    reserved_bit[0] |= 0b1000_0000;
    reject(&reserved_bit, "reserved bit set");

    let mut reserved_tier = valid.clone();
    reserved_tier[0] = (reserved_tier[0] & !0b0011_1000) | ((chromahash::MAX_TIER + 1) << 3);
    reject(&reserved_tier, "reserved tier code");

    let mut bad_version = valid.clone();
    bad_version[0] &= !0b0000_0111; // generation v1 (version 0)
    reject(&bad_version, "unsupported version");
}

#[test]
fn each_tier_has_its_documented_length_and_raster() {
    // Opaque: alpha < 255 selects the alpha layouts, whose lengths differ.
    let rgba: Vec<u8> = std::iter::repeat_n([128u8, 128, 128, 255], 4 * 4)
        .flatten()
        .collect();
    let lengths = [21usize, 32, 108, 411, 1623];
    let edges = [32u32, 32, 64, 128, 256];

    for tier in 0..=chromahash::MAX_TIER {
        let hash = encode(4, 4, &rgba, CHROMA_HASH_GAMUT_SRGB, tier);
        assert_eq!(
            hash_bytes(hash).len(),
            lengths[tier as usize],
            "tier {tier} byte length"
        );

        let mut image = ChromaHashImage {
            width: 0,
            height: 0,
            rgba: ptr::null_mut(),
            rgba_len: 0,
        };
        assert_eq!(
            unsafe { chromahash_decode(hash, &mut image) },
            ChromaHashStatus::Ok
        );
        assert_eq!(image.width, edges[tier as usize], "tier {tier} width");
        assert_eq!(image.height, edges[tier as usize], "tier {tier} height");
        assert_eq!(image.rgba_len, (image.width * image.height * 4) as usize);
        unsafe { chromahash_image_free(&mut image) };
        unsafe { chromahash_free(hash) };
    }
}

#[test]
fn exported_tier_constants_match_the_core() {
    // The C# and Go bindings link these symbols instead of restating the codes.
    // If the core renumbers a tier, this is where the ABI notices.
    assert_eq!(CHROMAHASH_COMPACT_TIER, chromahash::COMPACT_TIER);
    assert_eq!(CHROMAHASH_DEFAULT_TIER, chromahash::DEFAULT_TIER);
    assert_eq!(CHROMAHASH_MAX_TIER, chromahash::MAX_TIER);
    assert_eq!(CHROMAHASH_FORMAT_VERSION, chromahash::FORMAT_VERSION);

    // And the codes are ordered by quality, with the default not at zero.
    assert!(CHROMAHASH_COMPACT_TIER < CHROMAHASH_DEFAULT_TIER);
    assert!(CHROMAHASH_DEFAULT_TIER < CHROMAHASH_MAX_TIER);
}
