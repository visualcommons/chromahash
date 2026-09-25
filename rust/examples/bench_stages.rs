//! Per-stage timing for the encode pipeline.
//!
//! Answers the question the aggregate numbers cannot: of the milliseconds an
//! encode costs, which stage spends them. Built only with the `bench-internals`
//! feature, which is what compiles the `stage!` marks in `src/encode.rs`.
//!
//! ```sh
//! cargo run --release --features bench-internals --example bench_stages
//! ```
//!
//! Reads a raw RGBA image from stdin, or generates a gradient when stdin is a
//! terminal. Prints one `stage=nanoseconds` line per stage, plus the total, so
//! the driver can diff the sum against a monolithic `bench-encode` and report
//! how much of the time the stages actually account for.

use chromahash::stage_timing;
use chromahash::{ChromaHash, Gamut};
use std::collections::BTreeMap;
use std::io::{self, Read};

fn gradient(w: usize, h: usize) -> Vec<u8> {
    let mut rgba = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            rgba[i] = if w > 1 { (x * 255 / (w - 1)) as u8 } else { 0 };
            rgba[i + 1] = if h > 1 { (y * 255 / (h - 1)) as u8 } else { 0 };
            rgba[i + 2] = 128;
            rgba[i + 3] = 255;
        }
    }
    rgba
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let w: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(512);
    let h: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(512);
    let tier: u8 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let iters: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(20);

    // Prefer stdin so the driver controls the fixture; fall back to a gradient.
    let mut rgba = Vec::new();
    let _ = io::stdin().read_to_end(&mut rgba);
    if rgba.len() != w * h * 4 {
        rgba = gradient(w, h);
    }

    // Warm up before timing, and prove the instrumented path still produces the
    // shipped bytes — a stage mark that changed behaviour would invalidate every
    // number below.
    let reference = ChromaHash::encode_with_quality(w as u32, h as u32, &rgba, Gamut::Srgb, tier);

    let mut totals: BTreeMap<&'static str, u128> = BTreeMap::new();
    let mut order: Vec<&'static str> = Vec::new();
    let mut whole_ns: u128 = 0;

    for _ in 0..iters {
        stage_timing::reset();
        let start = std::time::Instant::now();
        let hash = ChromaHash::encode_with_quality(w as u32, h as u32, &rgba, Gamut::Srgb, tier);
        whole_ns += start.elapsed().as_nanos();
        assert_eq!(
            hash.as_bytes(),
            reference.as_bytes(),
            "instrumented encode diverged from the shipped bytes"
        );
        for (name, ns) in stage_timing::take() {
            if !totals.contains_key(name) {
                order.push(name);
            }
            *totals.entry(name).or_insert(0) += ns;
        }
    }

    let n = iters as u128;
    let stage_sum: u128 = totals.values().sum();
    println!("# {w}x{h} tier {tier}, {iters} iterations, ns per encode");
    for name in &order {
        println!("{name}={}", totals[name] / n);
    }
    println!("stage_sum={}", stage_sum / n);
    println!("whole_encode={}", whole_ns / n);
    // The marks cover `encode_with` end to end — the quantizer searches, the
    // refinement and the bit packing have their own marks (`dc_search`,
    // `ac_quantize`, `refine`, `pack`) — so what is left names no work: the
    // return from `encode_with`, the `ChromaHash` wrapper, and the timers' own
    // overhead. It was `quantize_and_pack` while those four were one unmarked
    // span, which made it an upper bound on work it could not attribute.
    println!("unmarked={}", whole_ns.saturating_sub(stage_sum) / n);
}
