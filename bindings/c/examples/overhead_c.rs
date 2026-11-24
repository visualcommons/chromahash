//! The C ABI arm of the FFI overhead counts (see `bindings/overhead/protocol.rs`):
//! each operation as a C caller performs it, through the `extern "C"` entry
//! points the C, C# (P/Invoke) and Go (cgo) bindings all call. Paired with
//! `overhead_core` from this crate under `mise run benchmark:counts`.

#[path = "../../overhead/protocol.rs"]
mod protocol;

use std::ptr;

use chromahash_c::{
    chromahash_as_bytes, chromahash_batch_encode, chromahash_batch_encoder_free,
    chromahash_batch_encoder_with_threads, chromahash_byte_len, chromahash_decode,
    chromahash_encode_with_quality, chromahash_free, chromahash_from_bytes, chromahash_image_free,
    ChromaHash, ChromaHashBatchEncoder, ChromaHashGamut, ChromaHashImage, ChromaHashImageInput,
    ChromaHashStatus,
};
use protocol::Layer;

/// The bytes a C caller holds after an encode: the hash copied out of its
/// handle into a caller-owned buffer (the default tier's hash fits in the
/// first 64 bytes; larger tiers take the heap path a C caller would too).
unsafe fn copy_out(hash: *mut ChromaHash, sink: &mut dyn FnMut(&[u8])) {
    let len = chromahash_byte_len(hash);
    let mut stack = [0u8; 64];
    let mut heap = Vec::new();
    let buf: &mut [u8] = if len <= stack.len() {
        &mut stack[..len]
    } else {
        heap.resize(len, 0);
        &mut heap
    };
    let status = chromahash_as_bytes(hash, buf.as_mut_ptr(), buf.len());
    assert_eq!(status, ChromaHashStatus::Ok);
    sink(buf);
}

struct C {
    batch: *mut ChromaHashBatchEncoder,
    handles: Vec<*mut ChromaHash>,
}

impl Drop for C {
    fn drop(&mut self) {
        unsafe { chromahash_batch_encoder_free(self.batch) };
    }
}

impl Layer for C {
    fn encode(&mut self, w: u32, h: u32, rgba: &[u8], tier: u8, sink: &mut dyn FnMut(&[u8])) {
        unsafe {
            let mut hash: *mut ChromaHash = ptr::null_mut();
            let status = chromahash_encode_with_quality(
                w,
                h,
                rgba.as_ptr(),
                rgba.len(),
                ChromaHashGamut::Srgb,
                tier,
                &mut hash,
            );
            assert_eq!(status, ChromaHashStatus::Ok);
            copy_out(hash, sink);
            chromahash_free(hash);
        }
    }

    fn decode(&mut self, hash: &[u8], sink: &mut dyn FnMut(u32, u32, &[u8])) {
        unsafe {
            let mut handle: *mut ChromaHash = ptr::null_mut();
            let status = chromahash_from_bytes(hash.as_ptr(), hash.len(), &mut handle);
            assert_eq!(status, ChromaHashStatus::Ok, "a valid hash on stdin");
            let mut image = ChromaHashImage {
                width: 0,
                height: 0,
                rgba: ptr::null_mut(),
                rgba_len: 0,
            };
            let status = chromahash_decode(handle, &mut image);
            assert_eq!(status, ChromaHashStatus::Ok);
            sink(
                image.width,
                image.height,
                std::slice::from_raw_parts(image.rgba, image.rgba_len),
            );
            chromahash_image_free(&mut image);
            chromahash_free(handle);
        }
    }

    fn encode_batch(
        &mut self,
        w: u32,
        h: u32,
        rgba: &[u8],
        tier: u8,
        n: usize,
        sink: &mut dyn FnMut(&[u8]),
    ) {
        unsafe {
            if self.batch.is_null() {
                self.batch = chromahash_batch_encoder_with_threads(1);
                assert!(!self.batch.is_null());
            }
            let items: Vec<ChromaHashImageInput> = (0..n)
                .map(|_| ChromaHashImageInput {
                    width: w,
                    height: h,
                    rgba: rgba.as_ptr(),
                    rgba_len: rgba.len(),
                    gamut: ChromaHashGamut::Srgb,
                    quality: tier,
                })
                .collect();
            self.handles.clear();
            self.handles.resize(n, ptr::null_mut());
            let status =
                chromahash_batch_encode(self.batch, items.as_ptr(), n, self.handles.as_mut_ptr());
            assert_eq!(status, ChromaHashStatus::Ok);
            for &hash in &self.handles {
                copy_out(hash, sink);
                chromahash_free(hash);
            }
        }
    }
}

fn main() {
    protocol::main(C {
        batch: ptr::null_mut(),
        handles: Vec::new(),
    });
}
