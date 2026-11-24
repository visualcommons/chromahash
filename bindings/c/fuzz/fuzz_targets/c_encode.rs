//! The C ABI's encode surface: `chromahash_encode`,
//! `chromahash_encode_with_quality` and `chromahash_batch_encode`, with zero
//! dimensions, mismatched RGBA lengths, out-of-range tiers and NULL pointers
//! wherever the header documents a NULL check. Each status is checked against
//! the validation order the binding documents, and each hash against the core.
//!
//! Input layout (`rust/fuzz/seeds.py` writes the seeds in it):
//!
//! | bytes | field |
//! |---|---|
//! | 0 | flags, below |
//! | 1 | source gamut (`% 5`, discriminant order) |
//! | 2 | quality tier, raw: codes above `CHROMAHASH_MAX_TIER` must be refused |
//! | 3..5 | width, u16 LE, `% 513` (0 is a case) |
//! | 5..7 | height, likewise, then lowered so `w · h ≤ 32768` |
//! | 7 | RGBA length delta, i8: `rgba_len = w·h·4 + delta`, floored at 0 |
//! | 8.. | RGBA, repeated (or zero-filled when empty) to exactly `rgba_len` |
//!
//! Flags: bit 0 NULL `rgba`; bit 1 NULL `out_hash`; bit 2 call
//! `chromahash_encode` instead of `_with_quality`; bit 3 also batch-encode the
//! image beside a fixed valid one; bits 4–7 modify that batch: NULL `items`,
//! NULL `out_hashes`, `count = 0`, NULL encoder.
#![no_main]

use std::ptr;

use chromahash::{ChromaHash as Core, Gamut, DEFAULT_TIER, MAX_TIER};
use chromahash_c::{
    chromahash_as_bytes, chromahash_batch_encode, chromahash_batch_encoder_free,
    chromahash_batch_encoder_with_threads, chromahash_byte_len, chromahash_encode,
    chromahash_encode_with_quality, chromahash_free, ChromaHash, ChromaHashGamut,
    ChromaHashImageInput, ChromaHashStatus,
};
use libfuzzer_sys::fuzz_target;

const HEADER: usize = 8;
const MAX_SIDE: u32 = 512;
const MAX_PIXELS: u32 = 32_768;

const GAMUTS: [(ChromaHashGamut, Gamut); 5] = [
    (ChromaHashGamut::Srgb, Gamut::Srgb),
    (ChromaHashGamut::DisplayP3, Gamut::DisplayP3),
    (ChromaHashGamut::AdobeRgb, Gamut::AdobeRgb),
    (ChromaHashGamut::Bt2020, Gamut::Bt2020),
    (ChromaHashGamut::ProPhotoRgb, Gamut::ProPhotoRgb),
];

/// The bytes behind a handle, read back through the ABI.
unsafe fn handle_bytes(h: *const ChromaHash) -> Vec<u8> {
    let len = chromahash_byte_len(h);
    let mut out = vec![0u8; len];
    assert_eq!(
        chromahash_as_bytes(h, out.as_mut_ptr(), len),
        ChromaHashStatus::Ok
    );
    out
}

fuzz_target!(|data: &[u8]| {
    if data.len() < HEADER {
        return;
    }
    let flags = data[0];
    let (c_gamut, gamut) = GAMUTS[data[1] as usize % GAMUTS.len()];
    let quality = data[2];
    let w = u32::from(u16::from_le_bytes([data[3], data[4]])) % (MAX_SIDE + 1);
    let mut h = u32::from(u16::from_le_bytes([data[5], data[6]])) % (MAX_SIDE + 1);
    if let Some(most) = MAX_PIXELS.checked_div(w) {
        h = h.min(most);
    }
    let exact = w as usize * h as usize * 4;
    let rgba_len = exact.saturating_add_signed(isize::from(data[7] as i8));
    let src = &data[HEADER..];
    // Exactly `rgba_len` long, so a read past it is a sanitizer report.
    let rgba: Vec<u8> = if src.is_empty() {
        vec![0; rgba_len]
    } else {
        src.iter().copied().cycle().take(rgba_len).collect()
    };

    let default_entry = flags & 4 != 0;
    let tier = if default_entry { DEFAULT_TIER } else { quality };
    let null_rgba = flags & 1 != 0;
    let rgba_ptr = if null_rgba {
        ptr::null()
    } else {
        rgba.as_ptr()
    };

    // The single-image entry points check, in order: NULL pointers,
    // dimensions, RGBA length, then (with_quality only) the tier.
    let expected = if null_rgba || flags & 2 != 0 {
        ChromaHashStatus::NullPointer
    } else if w == 0 || h == 0 {
        ChromaHashStatus::InvalidDimensions
    } else if rgba_len != exact {
        ChromaHashStatus::InvalidLength
    } else if tier > MAX_TIER {
        ChromaHashStatus::InvalidData
    } else {
        ChromaHashStatus::Ok
    };
    let valid = expected == ChromaHashStatus::Ok;
    let core = valid.then(|| Core::encode_with_quality(w, h, &rgba, gamut, tier));

    let mut handle: *mut ChromaHash = ptr::null_mut();
    let out_hash = if flags & 2 != 0 {
        ptr::null_mut()
    } else {
        &mut handle as *mut _
    };
    let status = unsafe {
        if default_entry {
            chromahash_encode(w, h, rgba_ptr, rgba_len, c_gamut, out_hash)
        } else {
            chromahash_encode_with_quality(w, h, rgba_ptr, rgba_len, c_gamut, quality, out_hash)
        }
    };
    assert_eq!(status, expected, "{w}x{h} len {rgba_len} tier {tier}");
    if let Some(core) = &core {
        unsafe {
            assert_eq!(handle_bytes(handle), core.as_bytes());
            chromahash_free(handle);
        }
    } else {
        assert!(handle.is_null(), "a refused encode wrote a handle");
    }

    if flags & 8 == 0 {
        return;
    }

    // Batch: this image, then a fixed valid 1×1 one, so a two-slot output is
    // exercised and an error in slot 0 must leave slot 1 untouched too.
    let pixel = [10u8, 20, 30, 255];
    let items = [
        ChromaHashImageInput {
            width: w,
            height: h,
            rgba: rgba_ptr,
            rgba_len,
            gamut: c_gamut,
            quality: tier,
        },
        ChromaHashImageInput {
            width: 1,
            height: 1,
            rgba: pixel.as_ptr(),
            rgba_len: 4,
            gamut: ChromaHashGamut::Srgb,
            quality: DEFAULT_TIER,
        },
    ];
    let null_items = flags & 16 != 0;
    let null_out = flags & 32 != 0;
    let count = if flags & 64 != 0 { 0 } else { items.len() };
    let null_enc = flags & 128 != 0;
    // The batch path checks, in order: the encoder, an empty batch, the
    // array pointers, then per item: dimensions, length, `rgba`, tier.
    let expected = if null_enc {
        ChromaHashStatus::NullPointer
    } else if count == 0 {
        ChromaHashStatus::Ok
    } else if null_items || null_out {
        ChromaHashStatus::NullPointer
    } else if w == 0 || h == 0 {
        ChromaHashStatus::InvalidDimensions
    } else if rgba_len != exact {
        ChromaHashStatus::InvalidLength
    } else if null_rgba {
        ChromaHashStatus::NullPointer
    } else if tier > MAX_TIER {
        ChromaHashStatus::InvalidData
    } else {
        ChromaHashStatus::Ok
    };

    let mut out: [*mut ChromaHash; 2] = [ptr::null_mut(); 2];
    unsafe {
        let enc = if null_enc {
            ptr::null_mut()
        } else {
            chromahash_batch_encoder_with_threads(1)
        };
        assert!(null_enc || !enc.is_null());
        let status = chromahash_batch_encode(
            enc,
            if null_items {
                ptr::null()
            } else {
                items.as_ptr()
            },
            count,
            if null_out {
                ptr::null_mut()
            } else {
                out.as_mut_ptr()
            },
        );
        assert_eq!(
            status, expected,
            "batch: {w}x{h} len {rgba_len} tier {tier}"
        );
        if status == ChromaHashStatus::Ok && count > 0 {
            let first = Core::encode_with_quality(w, h, &rgba, gamut, tier);
            let second = Core::encode_with_quality(1, 1, &pixel, Gamut::Srgb, DEFAULT_TIER);
            assert_eq!(handle_bytes(out[0]), first.as_bytes());
            assert_eq!(handle_bytes(out[1]), second.as_bytes());
            chromahash_free(out[0]);
            chromahash_free(out[1]);
        } else {
            assert!(
                out.iter().all(|p| p.is_null()),
                "a batch that allocated nothing wrote a handle"
            );
        }
        chromahash_batch_encoder_free(enc);
    }
});
