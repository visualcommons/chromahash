//! Every validation branch of the C ABI, each pinned to its documented status.
//!
//! The ABI validates at the boundary before it touches the core: a NULL pointer
//! is `NullPointer`, a zero dimension `InvalidDimensions`, an RGBA buffer that is
//! not exactly `width * height * 4` bytes (or an output buffer smaller than the
//! hash) `InvalidLength`, and a reserved tier code or malformed hash bytes
//! `InvalidData`. On any error no handle is allocated and no out-parameter is
//! written.
//!
//! The domains here are small, so every test enumerates rather than samples:
//! every byte-0 value at every length for `chromahash_from_bytes`, every quality
//! byte, every output capacity around each tier's length, and each argument of
//! each entry point. Nothing depends on a random draw, so a regression fails the
//! same way on every run.

use std::ptr;

use chromahash::{ChromaHash as CoreHash, MAX_TIER};
use chromahash_c::{
    chromahash_as_bytes, chromahash_average_color, chromahash_batch_encode,
    chromahash_batch_encoder_free, chromahash_batch_encoder_new, chromahash_byte_len,
    chromahash_decode, chromahash_decode_capped, chromahash_decode_capped_to, chromahash_decode_to,
    chromahash_encode, chromahash_encode_with_quality, chromahash_free, chromahash_from_bytes,
    chromahash_image_free, ChromaHash, ChromaHashBatchEncoder, ChromaHashColor, ChromaHashGamut,
    ChromaHashImage, ChromaHashImageInput, ChromaHashStatus,
};

/// Byte lengths per tier code (spec §3.3), opaque then alpha.
const OPAQUE_LEN: [usize; 5] = [21, 32, 108, 411, 1623];
const ALPHA_LEN: [usize; 5] = [21, 32, 103, 388, 1528];

/// A sentinel no allocator returns, so a test can tell "left untouched" from
/// "overwritten with NULL" or "overwritten with a handle".
fn sentinel<T>() -> *mut T {
    std::ptr::NonNull::dangling().as_ptr()
}

fn empty_image() -> ChromaHashImage {
    ChromaHashImage {
        width: 0xDEAD,
        height: 0xBEEF,
        rgba: sentinel(),
        rgba_len: 0xF00D,
    }
}

/// A grey `w`×`h` opaque image.
fn grey(w: u32, h: u32) -> Vec<u8> {
    std::iter::repeat_n([128u8, 128, 128, 255], (w * h) as usize)
        .flatten()
        .collect()
}

fn encode_at(tier: u8) -> *mut ChromaHash {
    let rgba = grey(4, 4);
    let mut handle = ptr::null_mut();
    let status = unsafe {
        chromahash_encode_with_quality(
            4,
            4,
            rgba.as_ptr(),
            rgba.len(),
            ChromaHashGamut::Srgb,
            tier,
            &mut handle,
        )
    };
    assert_eq!(status, ChromaHashStatus::Ok);
    handle
}

// ─── NULL pointers ────────────────────────────────────────────────────────────

/// Each pointer argument of each entry point, NULL on its own, is
/// `NullPointer`, and no out-parameter is written.
#[test]
fn every_pointer_argument_rejects_null() {
    let rgba = grey(2, 2);
    let hash = encode_at(chromahash::DEFAULT_TIER);
    let gamut = ChromaHashGamut::Srgb;

    unsafe {
        // encode / encode_with_quality: rgba, out_hash.
        let mut out: *mut ChromaHash = sentinel();
        assert_eq!(
            chromahash_encode(2, 2, ptr::null(), 16, gamut, &mut out),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(out, sentinel(), "encode wrote out_hash on error");
        assert_eq!(
            chromahash_encode(2, 2, rgba.as_ptr(), 16, gamut, ptr::null_mut()),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_encode_with_quality(2, 2, ptr::null(), 16, gamut, 1, &mut out),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(out, sentinel(), "encode_with_quality wrote out_hash");
        assert_eq!(
            chromahash_encode_with_quality(2, 2, rgba.as_ptr(), 16, gamut, 1, ptr::null_mut()),
            ChromaHashStatus::NullPointer
        );

        // from_bytes: bytes, out_hash.
        let bytes = [0u8; 32];
        assert_eq!(
            chromahash_from_bytes(ptr::null(), 32, &mut out),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(out, sentinel(), "from_bytes wrote out_hash");
        assert_eq!(
            chromahash_from_bytes(bytes.as_ptr(), bytes.len(), ptr::null_mut()),
            ChromaHashStatus::NullPointer
        );

        // as_bytes: hash, out_buf.
        let mut buf = [0xAAu8; 32];
        assert_eq!(
            chromahash_as_bytes(ptr::null(), buf.as_mut_ptr(), buf.len()),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(buf, [0xAA; 32], "as_bytes wrote the buffer");
        assert_eq!(
            chromahash_as_bytes(hash, ptr::null_mut(), 32),
            ChromaHashStatus::NullPointer
        );

        // average_color: hash, out_color.
        let mut color = ChromaHashColor {
            r: 1,
            g: 2,
            b: 3,
            a: 4,
        };
        assert_eq!(
            chromahash_average_color(ptr::null(), &mut color),
            ChromaHashStatus::NullPointer
        );
        assert_eq!((color.r, color.g, color.b, color.a), (1, 2, 3, 4));
        assert_eq!(
            chromahash_average_color(hash, ptr::null_mut()),
            ChromaHashStatus::NullPointer
        );

        // The four decodes: hash, out_image.
        let mut image = empty_image();
        assert_eq!(
            chromahash_decode(ptr::null(), &mut image),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_decode_to(ptr::null(), gamut, &mut image),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_decode_capped(ptr::null(), 8, 8, &mut image),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_decode_capped_to(ptr::null(), 8, 8, gamut, &mut image),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            (image.width, image.height, image.rgba, image.rgba_len),
            (0xDEAD, 0xBEEF, sentinel(), 0xF00D),
            "a decode wrote out_image on error"
        );
        assert_eq!(
            chromahash_decode(hash, ptr::null_mut()),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_decode_to(hash, gamut, ptr::null_mut()),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_decode_capped(hash, 8, 8, ptr::null_mut()),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_decode_capped_to(hash, 8, 8, gamut, ptr::null_mut()),
            ChromaHashStatus::NullPointer
        );

        // byte_len has no status to return: NULL is documented as length 0.
        assert_eq!(chromahash_byte_len(ptr::null()), 0);

        // The releases are documented NULL-safe.
        chromahash_free(ptr::null_mut());
        chromahash_image_free(ptr::null_mut());
        chromahash_batch_encoder_free(ptr::null_mut());

        chromahash_free(hash);
    }
}

/// A NULL pointer is checked first: with every other argument wrong as well,
/// the status is still `NullPointer`.
#[test]
fn a_null_pointer_wins_over_every_other_argument_error() {
    let mut out: *mut ChromaHash = sentinel();
    unsafe {
        assert_eq!(
            chromahash_encode(0, 0, ptr::null(), 1, ChromaHashGamut::Srgb, &mut out),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_encode_with_quality(
                0,
                0,
                ptr::null(),
                1,
                ChromaHashGamut::Srgb,
                255,
                &mut out
            ),
            ChromaHashStatus::NullPointer
        );
    }
    assert_eq!(out, sentinel());
}

// ─── dimensions and RGBA length ───────────────────────────────────────────────

/// A zero width or height is `InvalidDimensions`, checked before the length:
/// a zero-area image has an expected length of 0, so a 0-byte buffer would
/// otherwise pass the length check.
#[test]
fn a_zero_dimension_is_invalid_dimensions_before_the_length() {
    let rgba = [0u8; 64];
    for (w, h) in [(0u32, 0u32), (0, 1), (1, 0), (0, 4), (4, 0), (0, u32::MAX)] {
        for len in [0usize, 16, 64] {
            let mut out: *mut ChromaHash = sentinel();
            let single = unsafe {
                chromahash_encode(w, h, rgba.as_ptr(), len, ChromaHashGamut::Srgb, &mut out)
            };
            let tiered = unsafe {
                chromahash_encode_with_quality(
                    w,
                    h,
                    rgba.as_ptr(),
                    len,
                    ChromaHashGamut::Srgb,
                    255,
                    &mut out,
                )
            };
            assert_eq!(
                single,
                ChromaHashStatus::InvalidDimensions,
                "{w}x{h} len {len}"
            );
            assert_eq!(
                tiered,
                ChromaHashStatus::InvalidDimensions,
                "{w}x{h} len {len}"
            );
            assert_eq!(out, sentinel());
        }
    }
}

/// The RGBA length must be exactly `w * h * 4`: one byte short, one over, the
/// pixel count without the `* 4`, and twice the length are all
/// `InvalidLength`, checked before the quality tier.
#[test]
fn the_rgba_length_must_be_exactly_w_h_4() {
    let rgba = vec![200u8; 6 * 6 * 4 * 2 + 1];
    for w in 1u32..=6 {
        for h in 1u32..=6 {
            let want = (w * h * 4) as usize;
            for len in [0, want - 1, want + 1, want / 4, want * 2] {
                if len == want {
                    continue;
                }
                let mut out: *mut ChromaHash = sentinel();
                let single = unsafe {
                    chromahash_encode(w, h, rgba.as_ptr(), len, ChromaHashGamut::Srgb, &mut out)
                };
                // Quality 255 too: the length is checked before the tier.
                let tiered = unsafe {
                    chromahash_encode_with_quality(
                        w,
                        h,
                        rgba.as_ptr(),
                        len,
                        ChromaHashGamut::Srgb,
                        255,
                        &mut out,
                    )
                };
                assert_eq!(single, ChromaHashStatus::InvalidLength, "{w}x{h} len {len}");
                assert_eq!(tiered, ChromaHashStatus::InvalidLength, "{w}x{h} len {len}");
                assert_eq!(out, sentinel());
            }

            let mut out = ptr::null_mut();
            let ok = unsafe {
                chromahash_encode(w, h, rgba.as_ptr(), want, ChromaHashGamut::Srgb, &mut out)
            };
            assert_eq!(ok, ChromaHashStatus::Ok, "{w}x{h} at its exact length");
            unsafe { chromahash_free(out) };
        }
    }
}

/// `w * h * 4` is computed without overflow: dimensions whose product does not
/// fit a `usize` are `InvalidLength`, not a wrapped length that some small
/// buffer could match. The buffer is never read, because the check rejects
/// first.
#[test]
fn an_overflowing_rgba_length_is_invalid_length() {
    let rgba = [0u8; 16];
    for (w, h) in [(u32::MAX, u32::MAX), (u32::MAX, u32::MAX / 2)] {
        for len in [0usize, 16, usize::MAX] {
            let mut out: *mut ChromaHash = sentinel();
            let status = unsafe {
                chromahash_encode(w, h, rgba.as_ptr(), len, ChromaHashGamut::Srgb, &mut out)
            };
            assert_eq!(status, ChromaHashStatus::InvalidLength, "{w}x{h} len {len}");
            assert_eq!(out, sentinel());
        }
    }
}

// ─── quality tier ─────────────────────────────────────────────────────────────

/// Every quality byte: `0..=MAX_TIER` encode at the tier's documented length,
/// and every byte above is `InvalidData` with no handle.
#[test]
fn every_quality_byte_is_accepted_iff_it_is_a_tier() {
    let rgba = grey(4, 4);
    for quality in 0u8..=255 {
        let mut out: *mut ChromaHash = sentinel();
        let status = unsafe {
            chromahash_encode_with_quality(
                4,
                4,
                rgba.as_ptr(),
                rgba.len(),
                ChromaHashGamut::Srgb,
                quality,
                &mut out,
            )
        };
        if quality <= MAX_TIER {
            assert_eq!(status, ChromaHashStatus::Ok, "quality {quality}");
            assert_eq!(
                unsafe { chromahash_byte_len(out) },
                OPAQUE_LEN[quality as usize],
                "quality {quality}"
            );
            unsafe { chromahash_free(out) };
        } else {
            assert_eq!(status, ChromaHashStatus::InvalidData, "quality {quality}");
            assert_eq!(out, sentinel(), "quality {quality} wrote out_hash");
        }
    }
}

// ─── from_bytes ───────────────────────────────────────────────────────────────

/// Every byte-0 value at every length from 0 to one past the longest hash: the
/// ABI's status is `Ok` exactly when the core's `from_bytes` accepts, and
/// `InvalidData` for each of the core's five rejections. A rejection writes no
/// handle; an acceptance hands back the same bytes.
#[test]
fn from_bytes_status_follows_the_core_for_every_header_and_length() {
    let buf = vec![0x5Au8; OPAQUE_LEN[MAX_TIER as usize] + 1];
    let mut accepted = 0;
    for b0 in 0u8..=255 {
        let mut bytes = buf.clone();
        bytes[0] = b0;
        for len in 0..=bytes.len() {
            let slice = &bytes[..len];
            let mut out: *mut ChromaHash = sentinel();
            let status = unsafe { chromahash_from_bytes(slice.as_ptr(), len, &mut out) };
            match CoreHash::from_bytes(slice) {
                Ok(_) => {
                    accepted += 1;
                    assert_eq!(status, ChromaHashStatus::Ok, "b0 {b0:#04x} len {len}");
                    assert_eq!(unsafe { chromahash_byte_len(out) }, len);
                    let mut back = vec![0u8; len];
                    let copied = unsafe { chromahash_as_bytes(out, back.as_mut_ptr(), len) };
                    assert_eq!(copied, ChromaHashStatus::Ok);
                    assert_eq!(back, slice);
                    unsafe { chromahash_free(out) };
                }
                Err(e) => {
                    assert_eq!(
                        status,
                        ChromaHashStatus::InvalidData,
                        "b0 {b0:#04x} len {len} ({e:?})"
                    );
                    assert_eq!(out, sentinel(), "b0 {b0:#04x} len {len} wrote out_hash");
                }
            }
        }
    }
    // One length per (tier, alpha flag): the sweep reached every acceptance.
    assert_eq!(accepted, OPAQUE_LEN.len() + ALPHA_LEN.len());
}

// ─── output capacity ──────────────────────────────────────────────────────────

/// `as_bytes` needs `out_cap >= byte_len`: every capacity from 0 to two past
/// the length, at every tier. Below it is `InvalidLength` and the buffer is
/// untouched; at or above it the hash is copied and nothing past it is written.
#[test]
fn as_bytes_needs_a_capacity_of_at_least_the_hash_length() {
    for tier in 0..=MAX_TIER {
        let hash = encode_at(tier);
        let len = unsafe { chromahash_byte_len(hash) };
        assert_eq!(len, OPAQUE_LEN[tier as usize]);
        let mut expected = vec![0u8; len];
        assert_eq!(
            unsafe { chromahash_as_bytes(hash, expected.as_mut_ptr(), len) },
            ChromaHashStatus::Ok
        );

        for cap in 0..=len + 2 {
            let mut buf = vec![0xEEu8; len + 2];
            let status = unsafe { chromahash_as_bytes(hash, buf.as_mut_ptr(), cap) };
            if cap < len {
                assert_eq!(
                    status,
                    ChromaHashStatus::InvalidLength,
                    "tier {tier} cap {cap}"
                );
                assert!(
                    buf.iter().all(|&b| b == 0xEE),
                    "tier {tier} cap {cap} wrote"
                );
            } else {
                assert_eq!(status, ChromaHashStatus::Ok, "tier {tier} cap {cap}");
                assert_eq!(&buf[..len], &expected[..], "tier {tier} cap {cap}");
                assert_eq!(&buf[len..], &[0xEE, 0xEE], "tier {tier} cap {cap} overran");
            }
        }
        unsafe { chromahash_free(hash) };
    }
}

// ─── capped decode ────────────────────────────────────────────────────────────

/// The capped decodes have no error of their own: any cap is accepted, and the
/// raster is `min(natural, cap)` per axis, down to a cap of 0, which gives an
/// empty image that `chromahash_image_free` releases.
#[test]
fn a_capped_decode_renders_at_min_of_natural_and_cap() {
    for tier in 0..=MAX_TIER {
        let hash = encode_at(tier);
        let mut natural = empty_image();
        assert_eq!(
            unsafe { chromahash_decode(hash, &mut natural) },
            ChromaHashStatus::Ok
        );
        let (nw, nh) = (natural.width, natural.height);
        unsafe { chromahash_image_free(&mut natural) };

        let caps = [0u32, 1, 2, nw - 1, nw, nw + 1, u32::MAX];
        for &max_w in &caps {
            for &max_h in &caps {
                for to in [false, true] {
                    let mut image = empty_image();
                    let status = unsafe {
                        if to {
                            chromahash_decode_capped_to(
                                hash,
                                max_w,
                                max_h,
                                ChromaHashGamut::DisplayP3,
                                &mut image,
                            )
                        } else {
                            chromahash_decode_capped(hash, max_w, max_h, &mut image)
                        }
                    };
                    let what = format!("tier {tier} cap {max_w}x{max_h} to={to}");
                    assert_eq!(status, ChromaHashStatus::Ok, "{what}");
                    assert_eq!(
                        (image.width, image.height),
                        (nw.min(max_w), nh.min(max_h)),
                        "{what}"
                    );
                    assert_eq!(
                        image.rgba_len,
                        (image.width * image.height * 4) as usize,
                        "{what}"
                    );
                    unsafe { chromahash_image_free(&mut image) };
                    assert!(image.rgba.is_null() && image.rgba_len == 0, "{what}");
                }
            }
        }
        unsafe { chromahash_free(hash) };
    }
}

// ─── batch ────────────────────────────────────────────────────────────────────

fn item(rgba: &[u8], w: u32, h: u32, quality: u8) -> ChromaHashImageInput {
    ChromaHashImageInput {
        width: w,
        height: h,
        rgba: rgba.as_ptr(),
        rgba_len: rgba.len(),
        gamut: ChromaHashGamut::Srgb,
        quality,
    }
}

/// `ChromaHashImageInput` is a plain C struct, not `Copy`; every field is.
fn dup(i: &ChromaHashImageInput) -> ChromaHashImageInput {
    ChromaHashImageInput {
        gamut: i.gamut,
        ..*i
    }
}

fn batch(
    enc: *mut ChromaHashBatchEncoder,
    items: &[ChromaHashImageInput],
) -> (ChromaHashStatus, Vec<*mut ChromaHash>) {
    let mut out: Vec<*mut ChromaHash> = vec![sentinel(); items.len()];
    let status =
        unsafe { chromahash_batch_encode(enc, items.as_ptr(), items.len(), out.as_mut_ptr()) };
    (status, out)
}

/// The batch entry point's own pointer checks: a NULL encoder is rejected even
/// for an empty batch; an empty batch with a live encoder is `Ok` whatever its
/// array pointers are; and with `count > 0` a NULL item or output array is
/// `NullPointer`.
#[test]
fn batch_pointer_checks() {
    let enc = chromahash_batch_encoder_new();
    assert!(!enc.is_null());
    let rgba = grey(2, 2);
    let items = [item(&rgba, 2, 2, chromahash::DEFAULT_TIER)];
    let mut out: [*mut ChromaHash; 1] = [sentinel()];

    unsafe {
        assert_eq!(
            chromahash_batch_encode(ptr::null_mut(), ptr::null(), 0, ptr::null_mut()),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_batch_encode(ptr::null_mut(), items.as_ptr(), 1, out.as_mut_ptr()),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_batch_encode(enc, ptr::null(), 0, ptr::null_mut()),
            ChromaHashStatus::Ok
        );
        assert_eq!(
            chromahash_batch_encode(enc, ptr::null(), 1, out.as_mut_ptr()),
            ChromaHashStatus::NullPointer
        );
        assert_eq!(
            chromahash_batch_encode(enc, items.as_ptr(), 1, ptr::null_mut()),
            ChromaHashStatus::NullPointer
        );
    }
    assert_eq!(out[0], sentinel(), "a rejected batch wrote a handle");
    unsafe { chromahash_batch_encoder_free(enc) };
}

/// Each per-item check, and their order: dimensions, then length, then a NULL
/// `rgba`, then the tier. An item failing several reports the first. Every
/// item is validated before any is encoded, so a bad item *after* good ones
/// still fails the whole call and writes no handle.
#[test]
fn batch_item_checks_and_their_order() {
    let enc = chromahash_batch_encoder_new();
    assert!(!enc.is_null());
    let rgba = grey(2, 2);
    let good = item(&rgba, 2, 2, chromahash::DEFAULT_TIER);
    let null_rgba = |w, h, len, quality| ChromaHashImageInput {
        width: w,
        height: h,
        rgba: ptr::null(),
        rgba_len: len,
        gamut: ChromaHashGamut::Srgb,
        quality,
    };

    let cases: [(ChromaHashImageInput, ChromaHashStatus, &str); 8] = [
        (
            item(&rgba, 0, 2, 1),
            ChromaHashStatus::InvalidDimensions,
            "zero width",
        ),
        (
            item(&rgba, 2, 0, 1),
            ChromaHashStatus::InvalidDimensions,
            "zero height",
        ),
        (
            null_rgba(0, 2, 3, 255),
            ChromaHashStatus::InvalidDimensions,
            "zero width, all else wrong",
        ),
        (
            item(&rgba[..15], 2, 2, 1),
            ChromaHashStatus::InvalidLength,
            "one byte short",
        ),
        (
            item(&rgba, u32::MAX, u32::MAX, 1),
            ChromaHashStatus::InvalidLength,
            "overflowing length",
        ),
        (
            null_rgba(2, 2, 15, 255),
            ChromaHashStatus::InvalidLength,
            "short, NULL rgba and tier 255",
        ),
        (
            null_rgba(2, 2, 16, 255),
            ChromaHashStatus::NullPointer,
            "NULL rgba and tier 255",
        ),
        (
            item(&rgba, 2, 2, MAX_TIER + 1),
            ChromaHashStatus::InvalidData,
            "reserved tier",
        ),
    ];

    for (bad, want, what) in cases {
        let (alone, out) = batch(enc, std::slice::from_ref(&bad));
        assert_eq!(alone, want, "{what}");
        assert_eq!(out, [sentinel()], "{what}: wrote a handle");

        let items = [dup(&good), dup(&good), bad];
        let (after_good, out) = batch(enc, &items);
        assert_eq!(after_good, want, "{what} after two good items");
        assert!(
            out.iter().all(|&p| p == sentinel()),
            "{what}: wrote a handle"
        );
    }

    // And with every item valid, at every tier, each slot gets its own handle.
    let items: Vec<_> = (0..=MAX_TIER).map(|q| item(&rgba, 2, 2, q)).collect();
    let (status, out) = batch(enc, &items);
    assert_eq!(status, ChromaHashStatus::Ok);
    for (q, &h) in out.iter().enumerate() {
        assert_eq!(unsafe { chromahash_byte_len(h) }, OPAQUE_LEN[q], "tier {q}");
        unsafe { chromahash_free(h) };
    }
    unsafe { chromahash_batch_encoder_free(enc) };
}
