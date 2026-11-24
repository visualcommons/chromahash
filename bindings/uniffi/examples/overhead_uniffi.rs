//! The UniFFI arm of the FFI overhead counts (see
//! `bindings/overhead/protocol.rs`): each operation as a UniFFI host performs
//! it, through the generated scaffolding symbols the Kotlin/JVM, Android,
//! Python and Swift bindings call. Paired with `overhead_core` from this crate
//! under `mise run benchmark:counts`.
//!
//! The host's own side is emulated at its minimum, the way the generated
//! Python and Kotlin do it: arguments are serialized into a buffer from
//! `rustbuffer_alloc` (big-endian, an `i32` length before a byte array, an
//! `i32` 1-based index for an enum), every method call first clones the
//! object's handle, and a returned buffer is copied out and released with
//! `rustbuffer_free`. What the host's runtime adds on top (ctypes, JNA, the
//! collector) is not counted here.

#[path = "../../overhead/protocol.rs"]
mod protocol;

use chromahash_uniffi as _;
use protocol::Layer;
use uniffi::{RustBuffer, RustCallStatus, RustCallStatusCode};

unsafe extern "C" {
    fn ffi_chromahash_uniffi_rustbuffer_alloc(size: u64, status: *mut RustCallStatus)
    -> RustBuffer;
    fn ffi_chromahash_uniffi_rustbuffer_free(buf: RustBuffer, status: *mut RustCallStatus);
    fn uniffi_chromahash_uniffi_fn_constructor_chromahash_encode_with_quality(
        w: u32,
        h: u32,
        rgba: RustBuffer,
        gamut: RustBuffer,
        quality: u8,
        status: *mut RustCallStatus,
    ) -> u64;
    fn uniffi_chromahash_uniffi_fn_constructor_chromahash_from_bytes(
        bytes: RustBuffer,
        status: *mut RustCallStatus,
    ) -> u64;
    fn uniffi_chromahash_uniffi_fn_clone_chromahash(
        handle: u64,
        status: *mut RustCallStatus,
    ) -> u64;
    fn uniffi_chromahash_uniffi_fn_free_chromahash(handle: u64, status: *mut RustCallStatus);
    fn uniffi_chromahash_uniffi_fn_method_chromahash_as_bytes(
        handle: u64,
        status: *mut RustCallStatus,
    ) -> RustBuffer;
    fn uniffi_chromahash_uniffi_fn_method_chromahash_decode_to(
        handle: u64,
        output: RustBuffer,
        status: *mut RustCallStatus,
    ) -> RustBuffer;
    fn uniffi_chromahash_uniffi_fn_constructor_batchencoder_with_threads(
        threads: u32,
        status: *mut RustCallStatus,
    ) -> u64;
    fn uniffi_chromahash_uniffi_fn_clone_batchencoder(
        handle: u64,
        status: *mut RustCallStatus,
    ) -> u64;
    fn uniffi_chromahash_uniffi_fn_method_batchencoder_encode_batch(
        handle: u64,
        items: RustBuffer,
        status: *mut RustCallStatus,
    ) -> RustBuffer;
}

/// `Gamut::Srgb` as UniFFI serializes an enum: its 1-based variant index.
const SRGB: i32 = 1;

/// Run one scaffolding call with a fresh status and insist it succeeded.
fn call<T>(f: impl FnOnce(*mut RustCallStatus) -> T) -> T {
    let mut status = RustCallStatus::default();
    let out = f(&mut status);
    assert_eq!(
        status.code,
        RustCallStatusCode::Success,
        "a scaffolding call failed"
    );
    out
}

/// A host-side argument buffer: allocated by the library, filled by the host.
struct Writer {
    buf: RustBuffer,
    at: usize,
}

impl Writer {
    fn new(size: usize) -> Self {
        let buf = call(|s| unsafe { ffi_chromahash_uniffi_rustbuffer_alloc(size as u64, s) });
        Writer { buf, at: 0 }
    }

    fn put(&mut self, bytes: &[u8]) {
        assert!(self.at + bytes.len() <= self.buf.capacity());
        unsafe {
            let dst = self.buf.data_pointer().cast_mut().add(self.at);
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
        }
        self.at += bytes.len();
    }

    /// The filled buffer. `rustbuffer_alloc` returns a buffer whose length is
    /// already the requested size, so it must have been filled exactly.
    fn finish(self) -> RustBuffer {
        assert_eq!(
            self.at,
            self.buf.len(),
            "an argument buffer was not filled exactly"
        );
        self.buf
    }
}

fn byte_array(bytes: &[u8]) -> RustBuffer {
    let mut w = Writer::new(4 + bytes.len());
    w.put(&(bytes.len() as i32).to_be_bytes());
    w.put(bytes);
    w.finish()
}

fn gamut_srgb() -> RustBuffer {
    let mut w = Writer::new(4);
    w.put(&SRGB.to_be_bytes());
    w.finish()
}

/// A host-side read of a returned buffer: copy it out, then release it.
fn take(buf: RustBuffer) -> Vec<u8> {
    let bytes = unsafe { std::slice::from_raw_parts(buf.data_pointer(), buf.len()) }.to_vec();
    call(|s| unsafe { ffi_chromahash_uniffi_rustbuffer_free(buf, s) });
    bytes
}

fn be_i32(b: &[u8], at: usize) -> i32 {
    i32::from_be_bytes(b[at..at + 4].try_into().expect("4 bytes"))
}

/// A hash's bytes as the host ends up holding them: `as_bytes` on a cloned
/// handle, the returned `bytes` lifted out of its buffer.
fn hash_bytes(handle: u64) -> Vec<u8> {
    let clone = call(|s| unsafe { uniffi_chromahash_uniffi_fn_clone_chromahash(handle, s) });
    let ret = take(call(|s| unsafe {
        uniffi_chromahash_uniffi_fn_method_chromahash_as_bytes(clone, s)
    }));
    let len = be_i32(&ret, 0) as usize;
    ret[4..4 + len].to_vec()
}

fn free_hash(handle: u64) {
    call(|s| unsafe { uniffi_chromahash_uniffi_fn_free_chromahash(handle, s) });
}

#[derive(Default)]
struct UniFfi {
    batch: Option<u64>,
}

impl Layer for UniFfi {
    fn encode(&mut self, w: u32, h: u32, rgba: &[u8], tier: u8, sink: &mut dyn FnMut(&[u8])) {
        let (rgba, gamut) = (byte_array(rgba), gamut_srgb());
        let handle = call(|s| unsafe {
            uniffi_chromahash_uniffi_fn_constructor_chromahash_encode_with_quality(
                w, h, rgba, gamut, tier, s,
            )
        });
        sink(&hash_bytes(handle));
        free_hash(handle);
    }

    fn decode(&mut self, hash: &[u8], sink: &mut dyn FnMut(u32, u32, &[u8])) {
        let bytes = byte_array(hash);
        let handle = call(|s| unsafe {
            uniffi_chromahash_uniffi_fn_constructor_chromahash_from_bytes(bytes, s)
        });
        let clone = call(|s| unsafe { uniffi_chromahash_uniffi_fn_clone_chromahash(handle, s) });
        let gamut = gamut_srgb();
        // DecodeResult { width: i32, height: i32, rgba: bytes }.
        let ret = take(call(|s| unsafe {
            uniffi_chromahash_uniffi_fn_method_chromahash_decode_to(clone, gamut, s)
        }));
        let (dw, dh, len) = (be_i32(&ret, 0), be_i32(&ret, 4), be_i32(&ret, 8) as usize);
        let rgba = ret[12..12 + len].to_vec();
        sink(dw as u32, dh as u32, &rgba);
        free_hash(handle);
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
        let encoder = *self.batch.get_or_insert_with(|| {
            call(|s| unsafe {
                uniffi_chromahash_uniffi_fn_constructor_batchencoder_with_threads(1, s)
            })
        });
        // List<ImageInput { w: u32, h: u32, rgba: bytes, gamut: Gamut, quality: u8 }>.
        let item = 4 + 4 + 4 + rgba.len() + 4 + 1;
        let mut items = Writer::new(4 + n * item);
        items.put(&(n as i32).to_be_bytes());
        for _ in 0..n {
            items.put(&w.to_be_bytes());
            items.put(&h.to_be_bytes());
            items.put(&(rgba.len() as i32).to_be_bytes());
            items.put(rgba);
            items.put(&SRGB.to_be_bytes());
            items.put(&[tier]);
        }
        let items = items.finish();
        let clone = call(|s| unsafe { uniffi_chromahash_uniffi_fn_clone_batchencoder(encoder, s) });
        // List<ChromaHash>: an i32 count, then one u64 handle per hash.
        let ret = take(call(|s| unsafe {
            uniffi_chromahash_uniffi_fn_method_batchencoder_encode_batch(clone, items, s)
        }));
        let count = be_i32(&ret, 0) as usize;
        assert_eq!(count, n);
        for i in 0..count {
            let at = 4 + i * 8;
            let handle = u64::from_be_bytes(ret[at..at + 8].try_into().expect("8 bytes"));
            sink(&hash_bytes(handle));
            free_hash(handle);
        }
    }
}

fn main() {
    protocol::main(UniFfi::default());
}
