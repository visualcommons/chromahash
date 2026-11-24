//! The baseline arm of the FFI overhead counts: the Rust core, called the way
//! a Rust caller holding the same byte slices as an FFI caller would call it.
//!
//! The batch builds each item's `Arc<[u8]>` from the caller's slice, as a Rust
//! caller holding plain buffers must, so a binding's batch overhead is what it
//! adds beyond that one copy.

use std::sync::Arc;

use chromahash::{BatchEncoder, ChromaHash, Gamut, ImageInput};

use crate::protocol::Layer;

#[derive(Default)]
pub struct Core {
    batch: Option<BatchEncoder>,
}

impl Layer for Core {
    fn encode(&mut self, w: u32, h: u32, rgba: &[u8], tier: u8, sink: &mut dyn FnMut(&[u8])) {
        let hash = ChromaHash::encode_with_quality(w, h, rgba, Gamut::Srgb, tier);
        sink(hash.as_bytes());
    }

    fn decode(&mut self, hash: &[u8], sink: &mut dyn FnMut(u32, u32, &[u8])) {
        let hash = ChromaHash::from_bytes(hash).expect("a valid hash on stdin");
        let (w, h, rgba) = hash.decode_to(Gamut::Srgb);
        sink(w, h, &rgba);
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
        let encoder = self
            .batch
            .get_or_insert_with(|| BatchEncoder::with_threads(1));
        let items: Vec<ImageInput> = (0..n)
            .map(|_| ImageInput {
                w,
                h,
                rgba: Arc::from(rgba),
                gamut: Gamut::Srgb,
                quality: tier,
            })
            .collect();
        for hash in encoder.encode_batch(&items) {
            sink(hash.as_bytes());
        }
    }
}
