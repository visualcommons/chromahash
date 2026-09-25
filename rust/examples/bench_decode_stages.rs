//! Per-stage timing for the decode pipeline — the decode half of what
//! `bench_stages.rs` does for encode.
//!
//! Built only with the `bench-internals` feature, which is what compiles the
//! `stage!` marks in `src/decode.rs`, and with `spec-vectors`, because it reads
//! the shared decode vectors:
//!
//! ```sh
//! cargo run --release --features bench-internals --example bench_decode_stages \
//!     -- 100 100 4 20            # natural raster
//! cargo run --release --features bench-internals --example bench_decode_stages \
//!     -- 100 100 4 200 32x32     # capped at 32x32
//! ```
//!
//! Arguments: `SRC_W SRC_H TIER ITERS [CAP]`. The source is a `SRC_W`×`SRC_H`
//! gradient encoded at `TIER`; what is timed is decoding that hash, at its
//! natural raster or capped at `CAP` (`WxH`). Decode cost depends on the tier
//! and the raster, not on the source's size, which is recorded only so the
//! fixture can be reproduced.
//!
//! Prints `meta.*` lines describing the run, then one `stage=nanoseconds` line
//! per stage, `stage_sum`, `whole_decode`, and `unmarked` — the part of the
//! whole decode the marks do not cover.

use chromahash::stage_timing;
use chromahash::{ChromaHash, Gamut};
use serde_json::Value;
use std::collections::BTreeMap;

const DECODE_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../spec/test-vectors/integration-decode.json"
));
const DECODE_CAPPED_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../spec/test-vectors/integration-decode-capped.json"
));

/// The same fixture `bench_stages.rs` encodes.
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

fn bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .expect("byte array")
        .iter()
        .map(|b| b.as_u64().expect("byte") as u8)
        .collect()
}

/// Decode every shared decode vector — natural and capped — through this
/// instrumented build, and require the spec's exact output. Returns how many
/// were checked.
///
/// This is what makes "the instrumented build produces the shipped bytes" a
/// checked statement rather than a repeatability check: a mark that changed
/// what the renderer computes would fail here, against bytes this build did not
/// produce, before any number is printed.
fn check_spec_vectors() -> usize {
    let mut checked = 0;
    for (file, text, capped) in [
        ("integration-decode.json", DECODE_VECTORS, false),
        (
            "integration-decode-capped.json",
            DECODE_CAPPED_VECTORS,
            true,
        ),
    ] {
        let cases: Value = serde_json::from_str(text).expect("parse decode vectors");
        let cases = cases.as_array().expect("decode vectors are an array");
        assert!(!cases.is_empty(), "{file}: no vectors");
        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let input = &case["input"];
            let hash = ChromaHash::from_bytes(&bytes(&input["hash"]))
                .unwrap_or_else(|e| panic!("{file} {name}: invalid hash: {e:?}"));
            let got = if capped {
                let mw = input["max_width"].as_u64().expect("max_width") as u32;
                let mh = input["max_height"].as_u64().expect("max_height") as u32;
                hash.decode_capped(mw, mh)
            } else {
                hash.decode()
            };
            let expected = &case["expected"];
            let want = (
                expected["width"].as_u64().expect("width") as u32,
                expected["height"].as_u64().expect("height") as u32,
                bytes(&expected["rgba"]),
            );
            assert!(
                got == want,
                "{file} {name}: the instrumented decode diverged from the spec's bytes"
            );
            checked += 1;
        }
    }
    checked
}

fn parse_cap(s: &str) -> (u32, u32) {
    let (w, h) = s
        .split_once('x')
        .unwrap_or_else(|| panic!("CAP must be WxH, got {s:?}"));
    let parse = |v: &str| -> u32 {
        v.parse()
            .ok()
            .filter(|&n| n >= 1)
            .unwrap_or_else(|| panic!("CAP must be WxH with both >= 1, got {s:?}"))
    };
    (parse(w), parse(h))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let w: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(100);
    let h: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(100);
    let tier: u8 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(4);
    let iters: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(20);
    let cap = args.get(5).map(|s| parse_cap(s));
    assert!(
        w >= 1 && h >= 1 && iters >= 1,
        "SRC_W, SRC_H, ITERS must be >= 1"
    );

    let vectors_checked = check_spec_vectors();

    let hash =
        ChromaHash::encode_with_quality(w as u32, h as u32, &gradient(w, h), Gamut::Srgb, tier);
    let decode = || match cap {
        Some((cw, ch)) => hash.decode_capped(cw, ch),
        None => hash.decode(),
    };

    // Warm up, and fix the output every timed decode must reproduce.
    let reference = decode();

    let mut totals: BTreeMap<&'static str, u128> = BTreeMap::new();
    let mut order: Vec<&'static str> = Vec::new();
    let mut whole_ns: u128 = 0;

    for _ in 0..iters {
        stage_timing::reset();
        let start = std::time::Instant::now();
        let out = decode();
        whole_ns += start.elapsed().as_nanos();
        assert!(
            out == reference,
            "instrumented decode is not repeatable across iterations"
        );
        for (name, ns) in stage_timing::take() {
            if !totals.contains_key(name) {
                order.push(name);
            }
            *totals.entry(name).or_insert(0) += ns;
        }
    }
    assert!(!order.is_empty(), "no decode stage recorded a mark");

    let n = iters as u128;
    let stage_sum: u128 = totals.values().sum();
    let raster = match cap {
        Some((cw, ch)) => format!("capped {cw}x{ch}"),
        None => "natural".to_string(),
    };
    println!(
        "# decode of a {w}x{h} gradient at tier {tier}, {raster}, {iters} iterations, ns per decode"
    );
    println!("meta.hash_bytes={}", hash.as_bytes().len());
    println!("meta.render_width={}", reference.0);
    println!("meta.render_height={}", reference.1);
    println!("meta.vectors_checked={vectors_checked}");
    for name in &order {
        println!("{name}={}", totals[name] / n);
    }
    println!("stage_sum={}", stage_sum / n);
    println!("whole_decode={}", whole_ns / n);
    // What the marks do not cover: the return from `render_at_size` to this
    // loop, and the timers' own overhead. The first mark measures from
    // `reset()`, so `header` already holds the entry point's header read and
    // size computation, and every line of `render_at_size` is inside a mark,
    // so this residual names no algorithmic work — as encode's `unmarked` now
    // does too.
    println!("unmarked={}", whole_ns.saturating_sub(stage_sum) / n);
}
