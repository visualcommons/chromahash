//! The gamut crosses the C ABI as a plain `int32_t`, so a caller can pass any
//! value. Every gamut-taking entry point must reject one that no
//! `CHROMA_HASH_GAMUT_*` constant names with `InvalidData`, allocate nothing,
//! and leave the out-parameter untouched — and must accept each of the five
//! constants.

use std::ptr;

use chromahash_c::{
    chromahash_batch_encode, chromahash_batch_encoder_free, chromahash_batch_encoder_new,
    chromahash_decode_capped_to, chromahash_decode_to, chromahash_encode,
    chromahash_encode_with_quality, chromahash_free, chromahash_image_free, ChromaHash,
    ChromaHashGamut, ChromaHashImage, ChromaHashImageInput, ChromaHashStatus,
    CHROMAHASH_DEFAULT_TIER, CHROMA_HASH_GAMUT_ADOBE_RGB, CHROMA_HASH_GAMUT_BT2020,
    CHROMA_HASH_GAMUT_DISPLAY_P3, CHROMA_HASH_GAMUT_PRO_PHOTO_RGB, CHROMA_HASH_GAMUT_SRGB,
};

/// The values the issue names (`5`, one past the last constant, and `-1`),
/// plus both ends of `int32_t`.
const OUT_OF_RANGE: [ChromaHashGamut; 4] = [5, -1, i32::MAX, i32::MIN];

const VALID: [ChromaHashGamut; 5] = [
    CHROMA_HASH_GAMUT_SRGB,
    CHROMA_HASH_GAMUT_DISPLAY_P3,
    CHROMA_HASH_GAMUT_ADOBE_RGB,
    CHROMA_HASH_GAMUT_BT2020,
    CHROMA_HASH_GAMUT_PRO_PHOTO_RGB,
];

const W: u32 = 4;
const H: u32 = 4;

fn rgba() -> Vec<u8> {
    (0..(W * H * 4)).map(|i| (i * 7 % 256) as u8).collect()
}

/// A handle to decode, encoded with a valid gamut.
fn valid_hash() -> *mut ChromaHash {
    let rgba = rgba();
    let mut handle: *mut ChromaHash = ptr::null_mut();
    let st = unsafe {
        chromahash_encode(
            W,
            H,
            rgba.as_ptr(),
            rgba.len(),
            CHROMA_HASH_GAMUT_SRGB,
            &mut handle,
        )
    };
    assert_eq!(st, ChromaHashStatus::Ok);
    assert!(!handle.is_null());
    handle
}

fn empty_image() -> ChromaHashImage {
    ChromaHashImage {
        width: 0,
        height: 0,
        rgba: ptr::null_mut(),
        rgba_len: 0,
    }
}

#[test]
fn encode_rejects_out_of_range_gamut() {
    let rgba = rgba();
    for g in OUT_OF_RANGE {
        let mut handle: *mut ChromaHash = ptr::null_mut();
        let st = unsafe { chromahash_encode(W, H, rgba.as_ptr(), rgba.len(), g, &mut handle) };
        assert_eq!(st, ChromaHashStatus::InvalidData, "gamut {g}");
        assert!(handle.is_null(), "gamut {g}: no handle on error");
    }
}

#[test]
fn encode_with_quality_rejects_out_of_range_gamut() {
    let rgba = rgba();
    for g in OUT_OF_RANGE {
        let mut handle: *mut ChromaHash = ptr::null_mut();
        let st = unsafe {
            chromahash_encode_with_quality(
                W,
                H,
                rgba.as_ptr(),
                rgba.len(),
                g,
                CHROMAHASH_DEFAULT_TIER,
                &mut handle,
            )
        };
        assert_eq!(st, ChromaHashStatus::InvalidData, "gamut {g}");
        assert!(handle.is_null(), "gamut {g}: no handle on error");
    }
}

#[test]
fn decode_to_rejects_out_of_range_gamut() {
    let hash = valid_hash();
    for g in OUT_OF_RANGE {
        let mut image = empty_image();
        let st = unsafe { chromahash_decode_to(hash, g, &mut image) };
        assert_eq!(st, ChromaHashStatus::InvalidData, "gamut {g}");
        assert!(image.rgba.is_null(), "gamut {g}: no image on error");
    }
    unsafe { chromahash_free(hash) };
}

#[test]
fn decode_capped_to_rejects_out_of_range_gamut() {
    let hash = valid_hash();
    for g in OUT_OF_RANGE {
        let mut image = empty_image();
        let st = unsafe { chromahash_decode_capped_to(hash, 8, 8, g, &mut image) };
        assert_eq!(st, ChromaHashStatus::InvalidData, "gamut {g}");
        assert!(image.rgba.is_null(), "gamut {g}: no image on error");
    }
    unsafe { chromahash_free(hash) };
}

#[test]
fn batch_encode_rejects_an_item_with_out_of_range_gamut() {
    let rgba = rgba();
    let enc = chromahash_batch_encoder_new();
    assert!(!enc.is_null());
    for g in OUT_OF_RANGE {
        // The bad item is second, so a valid item precedes it: the batch must
        // still fail as a whole and allocate no handle for either.
        let items: Vec<ChromaHashImageInput> = [CHROMA_HASH_GAMUT_SRGB, g]
            .into_iter()
            .map(|gamut| ChromaHashImageInput {
                width: W,
                height: H,
                rgba: rgba.as_ptr(),
                rgba_len: rgba.len(),
                gamut,
                quality: CHROMAHASH_DEFAULT_TIER,
            })
            .collect();
        let mut out: [*mut ChromaHash; 2] = [ptr::null_mut(); 2];
        let st =
            unsafe { chromahash_batch_encode(enc, items.as_ptr(), items.len(), out.as_mut_ptr()) };
        assert_eq!(st, ChromaHashStatus::InvalidData, "gamut {g}");
        assert!(
            out.iter().all(|h| h.is_null()),
            "gamut {g}: no handle on error"
        );
    }
    unsafe { chromahash_batch_encoder_free(enc) };
}

#[test]
fn every_gamut_constant_is_accepted_at_every_entry_point() {
    let rgba = rgba();
    let enc = chromahash_batch_encoder_new();
    assert!(!enc.is_null());
    for g in VALID {
        let mut handle: *mut ChromaHash = ptr::null_mut();
        let st = unsafe { chromahash_encode(W, H, rgba.as_ptr(), rgba.len(), g, &mut handle) };
        assert_eq!(st, ChromaHashStatus::Ok, "encode, gamut {g}");
        unsafe { chromahash_free(handle) };

        let mut handle: *mut ChromaHash = ptr::null_mut();
        let st = unsafe {
            chromahash_encode_with_quality(
                W,
                H,
                rgba.as_ptr(),
                rgba.len(),
                g,
                CHROMAHASH_DEFAULT_TIER,
                &mut handle,
            )
        };
        assert_eq!(st, ChromaHashStatus::Ok, "encode_with_quality, gamut {g}");

        let mut image = empty_image();
        let st = unsafe { chromahash_decode_to(handle, g, &mut image) };
        assert_eq!(st, ChromaHashStatus::Ok, "decode_to, gamut {g}");
        unsafe { chromahash_image_free(&mut image) };

        let mut image = empty_image();
        let st = unsafe { chromahash_decode_capped_to(handle, 8, 8, g, &mut image) };
        assert_eq!(st, ChromaHashStatus::Ok, "decode_capped_to, gamut {g}");
        unsafe { chromahash_image_free(&mut image) };
        unsafe { chromahash_free(handle) };

        let item = ChromaHashImageInput {
            width: W,
            height: H,
            rgba: rgba.as_ptr(),
            rgba_len: rgba.len(),
            gamut: g,
            quality: CHROMAHASH_DEFAULT_TIER,
        };
        let mut out: *mut ChromaHash = ptr::null_mut();
        let st = unsafe { chromahash_batch_encode(enc, &item, 1, &mut out) };
        assert_eq!(st, ChromaHashStatus::Ok, "batch_encode, gamut {g}");
        unsafe { chromahash_free(out) };
    }
    unsafe { chromahash_batch_encoder_free(enc) };
}
