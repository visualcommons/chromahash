//! The stdin/stdout protocol shared by the FFI overhead count drivers.
//!
//! Each binding crate builds two examples from this module: `overhead_core`,
//! which calls the Rust core directly, and one that calls the same operation
//! through that crate's FFI surface (`overhead_c`, `overhead_uniffi`). Both
//! speak the subset of `rust/examples/encode_stdin.rs`'s protocol that
//! `mise run benchmark:counts` drives, so the harness counts them as the two
//! arms of one paired A/B cell (`--impl Rust --a-bin LAYER --b-bin CORE`), and
//! the A/B instruction ratio is the binding's per-operation overhead over the
//! core on the same input. Built in the same crate with the same profile, the
//! two arms differ only in the layer under test.
//!
//! ```text
//! overhead_<layer> encode <width> <height> srgb        rgba on stdin -> hash bytes
//! overhead_<layer> decode                              hash on stdin -> "w h\n" rgba
//! overhead_<layer> bench-encode <width> <height> srgb <iters>
//! overhead_<layer> bench-decode <iters>
//! ```
//!
//! `CHROMAHASH_TIER` selects the tier (default: the default tier).
//! `CHROMAHASH_OVERHEAD_BATCH=N` turns `encode` and `bench-encode` into a batch
//! of `N` copies of the input through a one-worker batch encoder, so one
//! iteration is one batch; `encode` then writes all `N` hashes. One worker
//! keeps the count free of the scheduling a wider pool adds. The drivers take
//! no tune: a non-empty `CHROMAHASH_TUNE` is refused rather than ignored.
//!
//! Every operation hands its result to a sink that sees the bytes the caller
//! ends up holding — the core's borrowed hash, the C caller's copied-out
//! buffer, the UniFFI host's lifted array — so the counted path and the path
//! whose output the harness compares are the same code.

use std::io::{self, Read, Write};

/// One binding layer's encode, decode and batch, each ending at the bytes its
/// caller holds.
pub trait Layer {
    /// Encode one image and hand the hash bytes to `sink`.
    fn encode(&mut self, w: u32, h: u32, rgba: &[u8], tier: u8, sink: &mut dyn FnMut(&[u8]));
    /// Validate `hash`, decode it to sRGB and hand the image to `sink`.
    fn decode(&mut self, hash: &[u8], sink: &mut dyn FnMut(u32, u32, &[u8]));
    /// Encode `n` copies of one image as one batch, handing each hash to `sink`
    /// in order.
    fn encode_batch(
        &mut self,
        w: u32,
        h: u32,
        rgba: &[u8],
        tier: u8,
        n: usize,
        sink: &mut dyn FnMut(&[u8]),
    );
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}

fn tier() -> u8 {
    match std::env::var("CHROMAHASH_TIER") {
        Ok(s) => match s.parse::<u8>() {
            Ok(t) if t <= chromahash::MAX_TIER => t,
            _ => die(&format!("CHROMAHASH_TIER: invalid tier '{s}'")),
        },
        Err(_) => chromahash::DEFAULT_TIER,
    }
}

fn batch() -> Option<usize> {
    match std::env::var("CHROMAHASH_OVERHEAD_BATCH") {
        Ok(s) => match s.parse::<usize>() {
            Ok(n) if n >= 1 => Some(n),
            _ => die(&format!("CHROMAHASH_OVERHEAD_BATCH: invalid count '{s}'")),
        },
        Err(_) => None,
    }
}

fn read_stdin(expected: Option<usize>) -> Vec<u8> {
    let mut buf = Vec::new();
    io::stdin()
        .read_to_end(&mut buf)
        .unwrap_or_else(|e| die(&format!("failed to read stdin: {e}")));
    match expected {
        Some(n) if buf.len() != n => {
            die(&format!("expected {n} bytes on stdin, got {}", buf.len()))
        }
        _ => buf,
    }
}

fn image_args(args: &[String], count: usize, usage: &str) -> (u32, u32, Vec<u8>) {
    if args.len() != count {
        die(usage);
    }
    let w: u32 = args[2].parse().unwrap_or_else(|_| die("invalid width"));
    let h: u32 = args[3].parse().unwrap_or_else(|_| die("invalid height"));
    if args[4] != "srgb" {
        die("the overhead drivers encode sRGB only");
    }
    let rgba = read_stdin(Some((w as usize) * (h as usize) * 4));
    (w, h, rgba)
}

fn iters(s: &str) -> u32 {
    s.parse().unwrap_or_else(|_| die("invalid iters"))
}

/// Run `op` `iters` times, folding one byte of every result into a checksum
/// reported on stderr so no iteration can be optimized away.
fn bench(iters: u32, mut op: impl FnMut() -> u8) {
    let mut acc: u64 = 0;
    for _ in 0..iters {
        acc = acc.wrapping_add(u64::from(std::hint::black_box(op())));
    }
    eprintln!("checksum={acc:x}");
    eprintln!("iters={iters}");
}

/// Dispatch the command line to `layer`.
pub fn main(mut layer: impl Layer) {
    if std::env::var("CHROMAHASH_TUNE").is_ok_and(|t| !t.is_empty()) {
        die("the overhead drivers take no CHROMAHASH_TUNE");
    }
    let args: Vec<String> = std::env::args().collect();
    let tier = tier();
    let batch = batch();
    let mut out = io::stdout().lock();
    match args.get(1).map(String::as_str) {
        Some("encode") => {
            let (w, h, rgba) = image_args(&args, 5, "usage: encode <width> <height> srgb");
            let mut bytes = Vec::new();
            let mut sink = |hash: &[u8]| bytes.extend_from_slice(hash);
            match batch {
                Some(n) => layer.encode_batch(w, h, &rgba, tier, n, &mut sink),
                None => layer.encode(w, h, &rgba, tier, &mut sink),
            }
            out.write_all(&bytes).expect("failed to write the hash");
        }
        Some("decode") => {
            if args.len() != 2 {
                die("usage: decode");
            }
            let hash = read_stdin(None);
            layer.decode(&hash, &mut |w, h, rgba| {
                out.write_all(format!("{w} {h}\n").as_bytes())
                    .and_then(|()| out.write_all(rgba))
                    .expect("failed to write the image");
            });
        }
        Some("bench-encode") => {
            let (w, h, rgba) = image_args(
                &args,
                6,
                "usage: bench-encode <width> <height> srgb <iters>",
            );
            bench(iters(&args[5]), || {
                let mut first = 0u8;
                let mut sink = |hash: &[u8]| first ^= hash[0];
                match batch {
                    Some(n) => layer.encode_batch(w, h, &rgba, tier, n, &mut sink),
                    None => layer.encode(w, h, &rgba, tier, &mut sink),
                }
                first
            });
        }
        Some("bench-decode") => {
            if args.len() != 3 {
                die("usage: bench-decode <iters>");
            }
            let n = iters(&args[2]);
            let hash = read_stdin(None);
            bench(n, || {
                let mut fold = 0u8;
                layer.decode(&hash, &mut |w, h, rgba| {
                    fold = rgba[0] ^ (w as u8) ^ (h as u8);
                });
                fold
            });
        }
        _ => die("usage: encode | decode | bench-encode | bench-decode (see protocol.rs)"),
    }
}
