//! The C ABI's handle surface: `chromahash_from_bytes` on arbitrary lengths,
//! then the accessors and the decode family on what it returns — with NULL
//! pointers wherever the header documents a NULL check, and undersized output
//! buffers for `chromahash_as_bytes`. Every result is compared with the core.
//!
//! Input layout (`rust/fuzz/seeds.py` writes the seeds in it):
//!
//! | bytes | field |
//! |---|---|
//! | 0 | flags, below |
//! | 1 | output gamut, as `i8` widened to the ABI's `int32_t`: 0–4 name a gamut, every other value must be refused |
//! | 2..6 | `max_width`, u32 LE |
//! | 6..10 | `max_height`, u32 LE |
//! | 10..12 | `chromahash_as_bytes` output capacity, u16 LE |
//! | 12.. | hash bytes, passed with exactly their length |
//!
//! Flags: bit 0 NULL `bytes`; bit 1 NULL `out_hash`; bit 2 NULL `out_buf`;
//! bit 3 NULL `out_image`; bit 4 NULL `out_color`; bits 5–6 pick the decode
//! entry point (`decode`, `decode_to`, `decode_capped`, `decode_capped_to`);
//! at tier codes 3 and 4 the capped twin runs, with each cap at most 32 px.
#![no_main]

use std::ptr;

use chromahash::{ChromaHash as Core, Gamut};
use chromahash_c::{
    chromahash_as_bytes, chromahash_average_color, chromahash_byte_len, chromahash_decode,
    chromahash_decode_capped, chromahash_decode_capped_to, chromahash_decode_to, chromahash_free,
    chromahash_from_bytes, chromahash_image_free, ChromaHash, ChromaHashColor, ChromaHashGamut,
    ChromaHashImage, ChromaHashStatus, CHROMA_HASH_GAMUT_ADOBE_RGB, CHROMA_HASH_GAMUT_BT2020,
    CHROMA_HASH_GAMUT_DISPLAY_P3, CHROMA_HASH_GAMUT_PRO_PHOTO_RGB, CHROMA_HASH_GAMUT_SRGB,
};
use libfuzzer_sys::fuzz_target;

const HEADER: usize = 12;
/// Tier code from which decodes are capped (spec §2.5: bits 3–5 of byte 0).
const HEAVY_TIER: u8 = 3;
const HEAVY_CAP: u32 = 32;

/// The core gamut a `CHROMA_HASH_GAMUT_*` value names, or `None` for any
/// other `int32_t`, which the ABI must refuse with `InvalidData`.
fn core_gamut(g: ChromaHashGamut) -> Option<Gamut> {
    match g {
        CHROMA_HASH_GAMUT_SRGB => Some(Gamut::Srgb),
        CHROMA_HASH_GAMUT_DISPLAY_P3 => Some(Gamut::DisplayP3),
        CHROMA_HASH_GAMUT_ADOBE_RGB => Some(Gamut::AdobeRgb),
        CHROMA_HASH_GAMUT_BT2020 => Some(Gamut::Bt2020),
        CHROMA_HASH_GAMUT_PRO_PHOTO_RGB => Some(Gamut::ProPhotoRgb),
        _ => None,
    }
}

fn empty_image() -> ChromaHashImage {
    ChromaHashImage {
        width: 0,
        height: 0,
        rgba: ptr::null_mut(),
        rgba_len: 0,
    }
}

/// Every entry point that takes a handle must refuse a NULL one.
fn null_handle_paths() {
    let mut buf = [0u8; 4];
    let mut color = ChromaHashColor {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
    };
    let mut image = empty_image();
    let none: *const ChromaHash = ptr::null();
    unsafe {
        assert_eq!(chromahash_byte_len(none), 0);
        assert_eq!(
            chromahash_as_bytes(none, buf.as_mut_ptr(), buf.len()),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_average_color(none, &mut color),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_decode(none, &mut image),
            ChromaHashStatus::NullPointer
        );
        assert!(image.rgba.is_null(), "a refused decode wrote an image");
        chromahash_free(ptr::null_mut());
        chromahash_image_free(ptr::null_mut());
    }
}

fuzz_target!(|data: &[u8]| {
    if data.len() < HEADER {
        return;
    }
    let flags = data[0];
    let c_gamut = ChromaHashGamut::from(data[1] as i8);
    let gamut = core_gamut(c_gamut);
    let max_w = u32::from_le_bytes([data[2], data[3], data[4], data[5]]);
    let max_h = u32::from_le_bytes([data[6], data[7], data[8], data[9]]);
    let out_cap = usize::from(u16::from_le_bytes([data[10], data[11]]));
    // An exactly-sized heap copy, so a read one byte past `len` is a
    // sanitizer report rather than a read of the fuzzer's own buffer.
    let bytes = data[HEADER..].to_vec();

    null_handle_paths();

    let null_bytes = flags & 1 != 0;
    let null_out = flags & 2 != 0;
    let mut handle: *mut ChromaHash = ptr::null_mut();
    let status = unsafe {
        chromahash_from_bytes(
            if null_bytes {
                ptr::null()
            } else {
                bytes.as_ptr()
            },
            bytes.len(),
            if null_out {
                ptr::null_mut()
            } else {
                &mut handle
            },
        )
    };
    if null_bytes || null_out {
        assert_eq!(status, ChromaHashStatus::NullPointer);
        assert!(handle.is_null());
        return;
    }
    let core = Core::from_bytes(&bytes);
    let Ok(core) = core else {
        assert_eq!(
            status,
            ChromaHashStatus::InvalidData,
            "C accepted bytes the core rejects"
        );
        assert!(handle.is_null(), "a rejected from_bytes wrote a handle");
        return;
    };
    assert_eq!(
        status,
        ChromaHashStatus::Ok,
        "C rejected bytes the core accepts"
    );
    assert!(!handle.is_null());

    unsafe {
        assert_eq!(chromahash_byte_len(handle), bytes.len());

        // `out_cap` below the hash's length must be refused untouched; at or
        // above it, exactly the bytes are copied. The buffer is exactly
        // `out_cap` long, so an overrun is a sanitizer report.
        let mut out = vec![0xA5u8; out_cap];
        let null_buf = flags & 4 != 0;
        let s = chromahash_as_bytes(
            handle,
            if null_buf {
                ptr::null_mut()
            } else {
                out.as_mut_ptr()
            },
            out_cap,
        );
        if null_buf {
            assert_eq!(s, ChromaHashStatus::NullPointer);
        } else if out_cap < bytes.len() {
            assert_eq!(s, ChromaHashStatus::InvalidLength);
            assert!(
                out.iter().all(|&b| b == 0xA5),
                "a refused as_bytes wrote the buffer"
            );
        } else {
            assert_eq!(s, ChromaHashStatus::Ok);
            assert_eq!(&out[..bytes.len()], &bytes[..]);
            assert!(
                out[bytes.len()..].iter().all(|&b| b == 0xA5),
                "as_bytes wrote past the hash"
            );
        }

        let mut color = ChromaHashColor {
            r: 0,
            g: 0,
            b: 0,
            a: 0,
        };
        if flags & 16 != 0 {
            assert_eq!(
                chromahash_average_color(handle, ptr::null_mut()),
                ChromaHashStatus::NullPointer
            );
        } else {
            assert_eq!(
                chromahash_average_color(handle, &mut color),
                ChromaHashStatus::Ok
            );
            assert_eq!([color.r, color.g, color.b, color.a], core.average_color());
        }

        // Codes 3 and 4 render 128 and 256 px at O(w·h·K): a natural decode
        // costs about a second under the sanitizer, twice here (C and core).
        // There, take the capped twin of the chosen entry point and cap each
        // axis at 32 px. The entry points differ only in the arguments they
        // hand the core, so the uncapped ones stay covered at codes 0–2.
        let heavy = (bytes[0] >> 3) & 0b111 >= HEAVY_TIER;
        let mut entry = (flags >> 5) & 3;
        let (max_w, max_h) = if heavy {
            entry |= 2;
            (max_w.min(HEAVY_CAP), max_h.min(HEAVY_CAP))
        } else {
            (max_w, max_h)
        };
        let decode = |out: *mut ChromaHashImage| match entry {
            0 => chromahash_decode(handle, out),
            1 => chromahash_decode_to(handle, c_gamut, out),
            2 => chromahash_decode_capped(handle, max_w, max_h, out),
            _ => chromahash_decode_capped_to(handle, max_w, max_h, c_gamut, out),
        };
        // Entries 1 and 3 take the fuzzed gamut; 0 and 2 pass sRGB.
        let takes_gamut = entry & 1 == 1;
        if flags & 8 != 0 {
            // The NULL check comes before the gamut check.
            assert_eq!(decode(ptr::null_mut()), ChromaHashStatus::NullPointer);
        } else if takes_gamut && gamut.is_none() {
            let mut image = empty_image();
            assert_eq!(
                decode(&mut image),
                ChromaHashStatus::InvalidData,
                "gamut {c_gamut} was not refused"
            );
            assert!(image.rgba.is_null(), "a refused decode wrote an image");
        } else {
            let mut image = empty_image();
            assert_eq!(decode(&mut image), ChromaHashStatus::Ok);
            let in_gamut = gamut.unwrap_or(Gamut::Srgb);
            let (w, h, rgba) = match entry {
                0 => core.decode(),
                1 => core.decode_to(in_gamut),
                2 => core.decode_capped(max_w, max_h),
                _ => core.decode_capped_to(max_w, max_h, in_gamut),
            };
            assert_eq!((image.width, image.height), (w, h));
            assert_eq!(image.rgba_len, rgba.len());
            assert!(
                !image.rgba.is_null(),
                "a successful decode returned a NULL buffer"
            );
            assert_eq!(
                std::slice::from_raw_parts(image.rgba, image.rgba_len),
                &rgba[..]
            );
            chromahash_image_free(&mut image);
            assert!(image.rgba.is_null() && image.rgba_len == 0);
            // Documented as safe once the struct is zeroed.
            chromahash_image_free(&mut image);
        }

        chromahash_free(handle);
    }
});
