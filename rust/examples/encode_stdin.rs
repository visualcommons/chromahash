use chromahash::{
    BatchEncoder, COMPACT_TIER, ChromaHash, Companding, DEFAULT_TIER, Gamut, ImageInput, MAX_TIER,
    QuantTable, Tunables, encode_debug_coefficients,
};
use std::io::{self, Read, Write};
use std::sync::Arc;

fn usage() -> ! {
    eprintln!("Usage:");
    eprintln!("  encode_stdin encode <width> <height> <gamut>");
    eprintln!("  encode_stdin decode [max_width max_height]");
    #[cfg(feature = "research-render")]
    eprintln!("  encode_stdin render <width> <height>");
    eprintln!("  encode_stdin average-color");
    eprintln!("  encode_stdin batch-encode <width> <height> <gamut> <count>");
    eprintln!("  encode_stdin batch-decode <count>");
    eprintln!("  encode_stdin bench-encode <width> <height> <gamut> <iters>");
    eprintln!("  encode_stdin bench-decode <iters> [max_width max_height]");
    eprintln!("  encode_stdin bench-batch <width> <height> <gamut> <count>");
    eprintln!("  encode_stdin bench-info");
    eprintln!("  encode_stdin dump-coeffs <width> <height> <gamut>");
    eprintln!();
    eprintln!("Quality: set CHROMAHASH_TIER=0..={MAX_TIER} to pick the quality tier.");
    eprintln!("Codes are ordered by quality: {COMPACT_TIER} is the 21-byte compact tier,");
    eprintln!("{DEFAULT_TIER} the 32-byte default, and each step above it doubles the");
    eprintln!("render resolution. Defaults to {DEFAULT_TIER}.");
    eprintln!("Sweep interface: set CHROMAHASH_TUNE to space-separated key=value");
    eprintln!("pairs to override v1 format constants, e.g.");
    eprintln!("  CHROMAHASH_TUNE=\"layout=B w_min_l=1.0 mu_c=8\"");
    eprintln!();
    eprintln!("Bench loop: CHROMAHASH_BENCH_REPS (default 1) timed blocks, each");
    eprintln!("preceded by a shared warmup of CHROMAHASH_BENCH_WARMUP_MS (default 0,");
    eprintln!("meaning a single warmup iteration).");
    eprintln!("milliseconds. One mean-ns/op line per block on stdout.");
    std::process::exit(1);
}

/// Quality tier from `CHROMAHASH_TIER` (default [`DEFAULT_TIER`]). Kept separate from the
/// `CHROMAHASH_TUNE` parser so positional CLI args stay stable for the harness.
fn tier_from_env() -> u8 {
    match std::env::var("CHROMAHASH_TIER") {
        Ok(s) => {
            let tier: u8 = s.parse().unwrap_or_else(|_| {
                eprintln!("CHROMAHASH_TIER: invalid tier '{s}'");
                std::process::exit(1);
            });
            if !chromahash::is_valid_tier(tier) {
                eprintln!(
                    "CHROMAHASH_TIER: tier {tier} is not a valid code (0..={MAX_TIER}, or {} for the compact tier)",
                    chromahash::COMPACT_TIER
                );
                std::process::exit(1);
            }
            tier
        }
        Err(_) => DEFAULT_TIER,
    }
}

/// Read a whole variable-length hash from stdin and validate it against the
/// tunables in effect (a sweep may resize the AC layout, which legitimately
/// changes the encoded length).
fn read_hash_from_stdin() -> ChromaHash {
    let mut buf = Vec::new();
    io::stdin()
        .read_to_end(&mut buf)
        .expect("failed to read hash from stdin");
    ChromaHash::from_bytes_tuned(&buf, &tunables_from_env()).unwrap_or_else(|e| {
        eprintln!("invalid chromahash on stdin: {e}");
        std::process::exit(1);
    })
}

/// Apply a raw layout override to both the tier-0 table and the tier-1..3 base.
fn set_layouts(t: &mut Tunables, mut f: impl FnMut(&mut chromahash::AcLayout)) {
    f(&mut t.layout);
    f(&mut t.layout_upper);
    f(&mut t.layout_compact);
}

/// Which row of the three-row AC layout table a raw override applies to.
enum LayoutScope {
    /// Every row — the historical "one base, scaled by 4^tier" meaning, extended
    /// to the compact row so a bare knob is never silently inert at some tier.
    Both,
    /// Tier 0 only.
    T0,
    /// The tier-1..3 base only.
    Upper,
    /// The compact tier only.
    Compact,
}

/// Apply a raw layout override to one row of the table, or to both.
fn set_layout_scoped(
    t: &mut Tunables,
    scope: LayoutScope,
    mut f: impl FnMut(&mut chromahash::AcLayout),
) {
    match scope {
        LayoutScope::Both => set_layouts(t, f),
        LayoutScope::T0 => f(&mut t.layout),
        LayoutScope::Upper => f(&mut t.layout_upper),
        LayoutScope::Compact => f(&mut t.layout_compact),
    }
}

/// Split a raw layout key into its base name and the row it targets: a `_t0`
/// suffix means tier 0 only, `_up` the tier-1..3 base, and no suffix both.
fn split_layout_scope(key: &str) -> (&str, LayoutScope) {
    if let Some(base) = key.strip_suffix("_t0") {
        (base, LayoutScope::T0)
    } else if let Some(base) = key.strip_suffix("_up") {
        (base, LayoutScope::Upper)
    } else if let Some(base) = key.strip_suffix("_tc") {
        (base, LayoutScope::Compact)
    } else {
        (key, LayoutScope::Both)
    }
}

/// Parse CHROMAHASH_TUNE overrides on top of `Tunables::DEFAULT`.
/// Unknown keys or malformed values abort loudly — a silently ignored knob
/// would corrupt a whole sweep.
///
/// Each match arm below mirrors one field of `chromahash::Tunables`; keep this
/// parser in sync with that struct (see `rust/src/constants.rs`).
fn tunables_from_env() -> Tunables {
    let mut t = Tunables::DEFAULT;
    let Ok(spec) = std::env::var("CHROMAHASH_TUNE") else {
        return t;
    };
    for pair in spec.split_whitespace() {
        let Some((key, value)) = pair.split_once('=') else {
            eprintln!("CHROMAHASH_TUNE: malformed pair '{pair}'");
            std::process::exit(1);
        };
        let parse_f64 = || -> f64 {
            value.parse().unwrap_or_else(|_| {
                eprintln!("CHROMAHASH_TUNE: invalid number for {key}: '{value}'");
                std::process::exit(1);
            })
        };
        let parse_u32 = || -> u32 {
            value.parse().unwrap_or_else(|_| {
                eprintln!("CHROMAHASH_TUNE: invalid integer for {key}: '{value}'");
                std::process::exit(1);
            })
        };
        match key {
            "layout" => {
                t.layout = match value {
                    "A" => chromahash::LAYOUT_A,
                    "B" => chromahash::LAYOUT_B,
                    "C" => chromahash::LAYOUT_C,
                    "D" => chromahash::LAYOUT_D,
                    "T0" => chromahash::LAYOUT_T0,
                    _ => {
                        eprintln!("CHROMAHASH_TUNE: unknown layout '{value}'");
                        std::process::exit(1);
                    }
                };
                t.layout_upper = t.layout;
            }
            "max_chroma_a" => t.max_chroma_a = parse_f64(),
            "max_chroma_b" => t.max_chroma_b = parse_f64(),
            "max_l_scale" => t.max_l_scale = parse_f64(),
            "max_a_scale" => t.max_a_scale = parse_f64(),
            "max_b_scale" => t.max_b_scale = parse_f64(),
            "max_alpha_scale" => t.max_alpha_scale = parse_f64(),
            "mu_l" => t.mu_l = parse_f64(),
            "mu_c" => t.mu_c = parse_f64(),
            "mu_alpha" => t.mu_alpha = parse_f64(),
            "w_min_l" => t.w_min_l = parse_f64(),
            "w_exp_l" => t.w_exp_l = parse_u32(),
            "w_min_c" => t.w_min_c = parse_f64(),
            "w_exp_c" => t.w_exp_c = parse_u32(),
            "dc_search" => t.dc_search = value == "1" || value == "true",
            // Companding family per group: mulaw | alaw:<a> | pow:<gamma> | table
            "compand_l" => t.compand_l = parse_companding(key, value),
            "compand_c" => t.compand_c = parse_companding(key, value),
            "compand_alpha" => t.compand_alpha = parse_companding(key, value),
            // Trained codebooks (positive half, comma-separated ascending levels)
            "table_l" => t.table_l = parse_table(key, value),
            "table_c" => t.table_c = parse_table(key, value),
            "table_alpha" => t.table_alpha = parse_table(key, value),
            "deadzone_l" => t.deadzone_l = parse_f64(),
            "deadzone_c" => t.deadzone_c = parse_f64(),
            "deadzone_alpha" => t.deadzone_alpha = parse_f64(),
            "band_split" => t.band_split = parse_f64(),
            "band_gain_l" => t.band_gain_l = parse_f64(),
            "band_gain_c" => t.band_gain_c = parse_f64(),
            "aniso" => t.aniso_oblique = parse_f64(),
            "ac_nearest" => t.ac_nearest = value == "1" || value == "true",
            // Prototype separable forward DCT. NOT byte-identical — see
            // dct::dct_encode_selected_separable; a measurement knob only.
            "dct_separable" => t.dct_separable = value == "1" || value == "true",
            "scale_fit" => t.scale_fit = parse_u32(),
            "refine_passes" => t.refine_passes = parse_u32(),
            "refine_delta" => t.refine_delta = parse_u32(),
            "refine_obj" => t.refine_obj = parse_u32(),
            "refine_dc" => t.refine_dc = value == "1" || value == "true",
            "refine_scale" => t.refine_scale = value == "1" || value == "true",
            "reproject_passes" => t.reproject_passes = parse_u32(),
            "aspect_bits" => t.aspect_bits = parse_u32(),
            "l_dc_bits" => t.l_dc_bits = parse_u32(),
            "a_dc_bits" => t.a_dc_bits = parse_u32(),
            "b_dc_bits" => t.b_dc_bits = parse_u32(),
            "l_scale_bits" => t.l_scale_bits = parse_u32(),
            "a_scale_bits" => t.a_scale_bits = parse_u32(),
            "b_scale_bits" => t.b_scale_bits = parse_u32(),
            "b_scale_from_a" => t.b_scale_from_a = value == "1" || value == "true",
            "scale_mu" => t.scale_mu = parse_f64(),
            "sel_hv" => t.sel_hv = parse_f64(),
            "refine_grid" => t.refine_grid = parse_u32(),
            "refine_wl" => t.refine_wl = parse_f64(),
            "refine_wc" => t.refine_wc = parse_f64(),
            "cfl_bits" => t.cfl_bits = parse_u32(),
            "cfl_range" => t.cfl_range = parse_f64(),
            "synth_count" => t.synth_count = parse_u32() as usize,
            "synth_gain" => t.synth_gain = parse_f64(),
            "interleave" => t.interleave = value == "1" || value == "true",
            "trunc_bytes" => t.trunc_bytes = parse_u32() as usize,
            "alpha_dc_bits" => t.alpha_dc_bits = parse_u32(),
            "alpha_scale_bits" => t.alpha_scale_bits = parse_u32(),
            "alpha_ac_count" => {
                let n = parse_u32() as usize;
                set_layouts(&mut t, |l| l.a_count = n);
            }
            "alpha_ac_bits" => {
                let n = parse_u32();
                set_layouts(&mut t, |l| l.a_bits = n);
            }
            "alpha_ac_fit" => t.alpha_ac_fit = value == "1" || value == "true",
            // Raw AcLayout overrides ("count:bits"), applied on top of `layout`.
            // v1 splits the layout in two (tier 0 vs. the tier-1..3 base). The
            // bare keys write *both*, so a sweep written before the split keeps
            // the historical "one base, scaled by 4^tier" meaning at whatever
            // tier it runs at; a `_t0` or `_up` suffix targets one row, which is
            // the only way to ask "move tier 0 and leave the rest alone".
            _ => match split_layout_scope(key) {
                ("l1", sc) => {
                    set_layout_scoped(&mut t, sc, |l| l.l_tiers[0] = parse_count_bits(key, value));
                }
                ("l2", sc) => {
                    set_layout_scoped(&mut t, sc, |l| l.l_tiers[1] = parse_count_bits(key, value));
                }
                ("c", sc) => set_layout_scoped(&mut t, sc, |l| {
                    let (count, bits) = parse_count_bits(key, value);
                    l.c_count = count;
                    l.c_bits = bits;
                }),
                ("la1", sc) => {
                    set_layout_scoped(&mut t, sc, |l| l.la_tiers[0] = parse_count_bits(key, value));
                }
                ("la2", sc) => {
                    set_layout_scoped(&mut t, sc, |l| l.la_tiers[1] = parse_count_bits(key, value));
                }
                ("a", sc) => set_layout_scoped(&mut t, sc, |l| {
                    let (count, bits) = parse_count_bits(key, value);
                    l.a_count = count;
                    l.a_bits = bits;
                }),
                ("ca", sc) => set_layout_scoped(&mut t, sc, |l| {
                    let (count, bits) = parse_count_bits(key, value);
                    l.ca_count = count;
                    l.ca_bits = bits;
                }),
                _ => {
                    eprintln!("CHROMAHASH_TUNE: unknown key '{key}'");
                    std::process::exit(1);
                }
            },
        }
    }
    t
}

/// Parse a companding family spec: `mulaw`, `alaw:<a>`, `pow:<gamma>`, `table`.
fn parse_companding(key: &str, value: &str) -> Companding {
    let bad = || -> ! {
        eprintln!("CHROMAHASH_TUNE: invalid companding for {key}: '{value}'");
        std::process::exit(1);
    };
    match value.split_once(':') {
        None => match value {
            "mulaw" => Companding::MuLaw,
            "table" => Companding::Table,
            _ => bad(),
        },
        Some((family, param)) => {
            let p: f64 = param.parse().unwrap_or_else(|_| bad());
            match family {
                "alaw" => Companding::ALaw { a: p },
                "pow" => Companding::Power { gamma: p },
                _ => bad(),
            }
        }
    }
}

/// Parse a trained codebook: comma-separated ascending positive levels.
fn parse_table(key: &str, value: &str) -> QuantTable {
    let mut table = QuantTable::EMPTY;
    for (i, part) in value.split(',').enumerate() {
        if i >= table.levels.len() {
            eprintln!("CHROMAHASH_TUNE: too many levels for {key} (max 31)");
            std::process::exit(1);
        }
        table.levels[i] = part.parse().unwrap_or_else(|_| {
            eprintln!("CHROMAHASH_TUNE: invalid level for {key}: '{part}'");
            std::process::exit(1);
        });
        table.len = (i + 1) as u8;
    }
    table
}

/// Parse a "count:bits" AcLayout override.
fn parse_count_bits(key: &str, value: &str) -> (usize, u32) {
    let bad = || -> ! {
        eprintln!("CHROMAHASH_TUNE: invalid count:bits for {key}: '{value}'");
        std::process::exit(1);
    };
    let Some((count, bits)) = value.split_once(':') else {
        bad();
    };
    (
        count.parse().unwrap_or_else(|_| bad()),
        bits.parse().unwrap_or_else(|_| bad()),
    )
}

fn parse_gamut(s: &str) -> Gamut {
    match s {
        "srgb" => Gamut::Srgb,
        "displayp3" => Gamut::DisplayP3,
        "adobergb" => Gamut::AdobeRgb,
        "bt2020" => Gamut::Bt2020,
        "prophoto" => Gamut::ProPhotoRgb,
        other => {
            eprintln!("unknown gamut: {other}");
            std::process::exit(1);
        }
    }
}

/// How many timed blocks to run, and how long to warm up first.
///
/// Warmup is **time-based, not count-based**: this contract is shared with six
/// other language harnesses, and a fixed iteration count is either useless for
/// Rust (~50 us/encode) or minutes for Python (~5 ms/encode).
///
/// Both defaults reproduce the pre-existing behaviour exactly — 1 timed block
/// after a single warmup iteration — so `compare`, `sweep` and `rd-budget`,
/// which call `bench-encode` once per image per format via
/// `tools/comparison/src/adapters/chromahash.ts`, are unchanged in both output
/// shape (one bare integer on stdout) and runtime. The heavier warmup that a
/// steady-state measurement needs is the perf driver's policy to set, not a
/// default every existing caller silently pays.
struct BenchCfg {
    reps: u32,
    warmup_ms: u64,
}

fn bench_cfg() -> BenchCfg {
    fn env_u64(key: &str, default: u64) -> u64 {
        match std::env::var(key) {
            Ok(s) => s.parse().unwrap_or_else(|_| {
                eprintln!("{key}: invalid value '{s}'");
                std::process::exit(1);
            }),
            Err(_) => default,
        }
    }
    BenchCfg {
        reps: env_u64("CHROMAHASH_BENCH_REPS", 1).max(1) as u32,
        warmup_ms: env_u64("CHROMAHASH_BENCH_WARMUP_MS", 0),
    }
}

/// Warm up for `warmup_ms`, then run `reps` timed blocks of `iters` iterations,
/// printing one mean-ns/op line per block to stdout.
///
/// `op` returns one result-derived byte, which is folded into an accumulator
/// reported on stderr. Consuming a byte of every result is what keeps the work
/// from being optimized away; `black_box` alone on a discarded value is not
/// enough of a guarantee to share with six other languages.
fn run_bench(iters: u32, mut op: impl FnMut() -> u8) {
    let cfg = bench_cfg();
    let mut acc: u64 = 0;

    // Always at least one iteration, so the default warmup_ms=0 is exactly the
    // single warmup call this harness did before, and still validates the input
    // before the first timed block.
    let warm_start = std::time::Instant::now();
    loop {
        acc = acc.wrapping_add(u64::from(std::hint::black_box(op())));
        if warm_start.elapsed().as_millis() >= u128::from(cfg.warmup_ms) {
            break;
        }
    }

    for _ in 0..cfg.reps {
        let start = std::time::Instant::now();
        for _ in 0..iters {
            acc = acc.wrapping_add(u64::from(std::hint::black_box(op())));
        }
        let ns_per_op = start.elapsed().as_nanos() / u128::from(iters.max(1));
        println!("{ns_per_op}");
    }

    eprintln!("checksum={acc:x}");
    eprintln!("iters={iters}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        usage();
    }

    match args[1].as_str() {
        "encode" => {
            if args.len() != 5 {
                eprintln!("Usage: encode_stdin encode <width> <height> <gamut>");
                std::process::exit(1);
            }
            let w: u32 = args[2].parse().expect("invalid width");
            let h: u32 = args[3].parse().expect("invalid height");
            let gamut = parse_gamut(&args[4]);

            let expected_len = (w as usize) * (h as usize) * 4;
            let mut rgba = vec![0u8; expected_len];
            io::stdin()
                .read_exact(&mut rgba)
                .expect("failed to read RGBA from stdin");

            let hash = ChromaHash::encode_tuned_quality(
                w,
                h,
                &rgba,
                gamut,
                &tunables_from_env(),
                tier_from_env(),
            );
            io::stdout()
                .write_all(hash.as_bytes())
                .expect("failed to write hash");
        }
        "decode" => {
            if args.len() != 2 && args.len() != 4 {
                eprintln!("Usage: encode_stdin decode [max_width max_height]");
                std::process::exit(1);
            }
            let ch = read_hash_from_stdin();
            let t = tunables_from_env();
            // Output gamut via env (keeps positional args stable for the
            // comparison harness): srgb (default) | displayp3 | adobergb.
            let out_gamut = match std::env::var("CHROMAHASH_OUT").as_deref() {
                Ok("displayp3") => Gamut::DisplayP3,
                Ok("adobergb") => Gamut::AdobeRgb,
                _ => Gamut::Srgb,
            };
            let (w, h, rgba) = if args.len() == 4 {
                let max_w: u32 = args[2].parse().expect("invalid max_width");
                let max_h: u32 = args[3].parse().expect("invalid max_height");
                ch.decode_capped_to_tuned(max_w, max_h, out_gamut, &t)
            } else {
                ch.decode_to_tuned(out_gamut, &t)
            };
            let header = format!("{w} {h}\n");
            io::stdout()
                .write_all(header.as_bytes())
                .expect("failed to write header");
            io::stdout().write_all(&rgba).expect("failed to write RGBA");
        }
        // Render at an exact raster instead of at (or capped below) the natural
        // one. The harness uses this to score the format's own reconstruction at
        // display resolution against the same reference every other format is
        // upscaled into — the one path that does not run through a resampler.
        #[cfg(feature = "research-render")]
        "render" => {
            if args.len() != 4 {
                eprintln!("Usage: encode_stdin render <width> <height>");
                std::process::exit(1);
            }
            let ch = read_hash_from_stdin();
            let t = tunables_from_env();
            let out_gamut = match std::env::var("CHROMAHASH_OUT").as_deref() {
                Ok("displayp3") => Gamut::DisplayP3,
                Ok("adobergb") => Gamut::AdobeRgb,
                _ => Gamut::Srgb,
            };
            let tw: u32 = args[2].parse().expect("invalid width");
            let th: u32 = args[3].parse().expect("invalid height");
            let (w, h, rgba) = ch.decode_at_size_tuned(tw, th, out_gamut, &t);
            let header = format!("{w} {h}\n");
            io::stdout()
                .write_all(header.as_bytes())
                .expect("failed to write header");
            io::stdout().write_all(&rgba).expect("failed to write RGBA");
        }
        "average-color" => {
            let rgba = read_hash_from_stdin().average_color();
            io::stdout()
                .write_all(&rgba)
                .expect("failed to write average color");
        }
        "batch-encode" => {
            // Read one image, encode it `count` times through the parallel
            // BatchEncoder. Used to benchmark bulk throughput.
            if args.len() != 6 {
                eprintln!("Usage: encode_stdin batch-encode <width> <height> <gamut> <count>");
                std::process::exit(1);
            }
            let w: u32 = args[2].parse().expect("invalid width");
            let h: u32 = args[3].parse().expect("invalid height");
            let gamut = parse_gamut(&args[4]);
            let count: usize = args[5].parse().expect("invalid count");

            let expected_len = (w as usize) * (h as usize) * 4;
            let mut rgba = vec![0u8; expected_len];
            io::stdin()
                .read_exact(&mut rgba)
                .expect("failed to read RGBA from stdin");
            let rgba: Arc<[u8]> = Arc::from(rgba);
            let tier = tier_from_env();

            let items: Vec<ImageInput> = (0..count)
                .map(|_| ImageInput {
                    w,
                    h,
                    rgba: Arc::clone(&rgba),
                    gamut,
                    quality: tier,
                })
                .collect();

            let encoder = BatchEncoder::new();
            let hashes = encoder.encode_batch(&items);
            // Write one result-derived byte so the work cannot be optimized away.
            io::stdout()
                .write_all(&[hashes[0].as_bytes()[0]])
                .expect("failed to write checksum");
        }
        "bench-encode" => {
            // In-process encode timing: read one image, loop `iters` times, print
            // the mean nanoseconds per encode to stdout. The comparison harness
            // uses this so ChromaHash timing excludes process-spawn overhead and
            // is measured on the same terms as the in-process npm formats.
            if args.len() != 6 {
                eprintln!("Usage: encode_stdin bench-encode <width> <height> <gamut> <iters>");
                std::process::exit(1);
            }
            let w: u32 = args[2].parse().expect("invalid width");
            let h: u32 = args[3].parse().expect("invalid height");
            let gamut = parse_gamut(&args[4]);
            let iters: u32 = args[5].parse().expect("invalid iters");

            let expected_len = (w as usize) * (h as usize) * 4;
            let mut rgba = vec![0u8; expected_len];
            io::stdin()
                .read_exact(&mut rgba)
                .expect("failed to read RGBA from stdin");
            let t = tunables_from_env();
            let tier = tier_from_env();

            run_bench(iters, || {
                let hash = ChromaHash::encode_tuned_quality(w, h, &rgba, gamut, &t, tier);
                hash.as_bytes()[0]
            });
        }
        "bench-decode" => {
            // In-process decode timing: read one hash, loop `iters` times, print
            // the mean nanoseconds per decode to stdout. Optional max dims use the
            // capped decode path (same as `decode [max_w max_h]`).
            if args.len() != 3 && args.len() != 5 {
                eprintln!("Usage: encode_stdin bench-decode <iters> [max_width max_height]");
                std::process::exit(1);
            }
            let iters: u32 = args[2].parse().expect("invalid iters");
            let ch = read_hash_from_stdin();
            let t = tunables_from_env();
            let out_gamut = match std::env::var("CHROMAHASH_OUT").as_deref() {
                Ok("displayp3") => Gamut::DisplayP3,
                Ok("adobergb") => Gamut::AdobeRgb,
                _ => Gamut::Srgb,
            };
            let cap = if args.len() == 5 {
                let max_w: u32 = args[3].parse().expect("invalid max_width");
                let max_h: u32 = args[4].parse().expect("invalid max_height");
                Some((max_w, max_h))
            } else {
                None
            };
            let run = || match cap {
                Some((mw, mh)) => ch.decode_capped_to_tuned(mw, mh, out_gamut, &t),
                None => ch.decode_to_tuned(out_gamut, &t),
            };

            run_bench(iters, || {
                let (dw, dh, rgba) = run();
                rgba[0] ^ (dw as u8) ^ (dh as u8)
            });
        }
        "bench-batch" => {
            // In-process batch throughput: build `count` items from one image and
            // time whole BatchEncoder::encode_batch calls. Reported per *batch*,
            // so the driver divides by count itself — a batch is the unit that
            // scales with cores, and conflating it with per-op cost is what made
            // the old "bulk per-op" column compare threading models rather than
            // algorithms.
            //
            // CHROMAHASH_BATCH_THREADS pins the pool size (0 = default, 1 = the
            // serial baseline), which is how the thread-scaling sweep is driven.
            if args.len() != 6 {
                eprintln!("Usage: encode_stdin bench-batch <width> <height> <gamut> <count>");
                std::process::exit(1);
            }
            let w: u32 = args[2].parse().expect("invalid width");
            let h: u32 = args[3].parse().expect("invalid height");
            let gamut = parse_gamut(&args[4]);
            let count: usize = args[5].parse().expect("invalid count");

            let expected_len = (w as usize) * (h as usize) * 4;
            let mut rgba = vec![0u8; expected_len];
            io::stdin()
                .read_exact(&mut rgba)
                .expect("failed to read RGBA from stdin");
            let rgba: Arc<[u8]> = Arc::from(rgba);
            let tier = tier_from_env();

            let items: Vec<ImageInput> = (0..count)
                .map(|_| ImageInput {
                    w,
                    h,
                    rgba: Arc::clone(&rgba),
                    gamut,
                    quality: tier,
                })
                .collect();

            let threads: usize = match std::env::var("CHROMAHASH_BATCH_THREADS") {
                Ok(s) => s.parse().unwrap_or_else(|_| {
                    eprintln!("CHROMAHASH_BATCH_THREADS: invalid value '{s}'");
                    std::process::exit(1);
                }),
                Err(_) => 0,
            };
            let encoder = if threads > 0 {
                BatchEncoder::with_threads(threads)
            } else {
                BatchEncoder::new()
            };

            // One batch is one "iteration": pass iters=1 so the printed number is
            // nanoseconds per batch.
            run_bench(1, || encoder.encode_batch(&items)[0].as_bytes()[0]);
        }
        "bench-info" => {
            // Report what this build actually is, so a timing run records which
            // vector backend produced it rather than leaving the reader to guess.
            //
            // The backend predicate below MIRRORS `dispatch` in rust/src/simd/mod.rs
            // (AVX2, else SSE2, else scalar). It is duplicated rather than exported
            // because reporting a diagnostic is not worth widening the core's
            // public API; if that dispatch order changes, change it here too.
            let simd_feature = cfg!(feature = "simd");
            let backend = if !simd_feature {
                "scalar"
            } else if cfg!(any(target_arch = "x86", target_arch = "x86_64")) {
                #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
                {
                    if std::is_x86_feature_detected!("avx2") {
                        "avx2"
                    } else if std::is_x86_feature_detected!("sse2") {
                        "sse2"
                    } else {
                        "scalar"
                    }
                }
                #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
                {
                    "scalar"
                }
            } else if cfg!(target_arch = "aarch64") {
                "neon"
            } else if cfg!(all(target_arch = "wasm32", target_feature = "simd128")) {
                "simd128"
            } else {
                "scalar"
            };
            println!("runtime=rust");
            println!("simd={backend}");
            println!("feature_simd={}", u8::from(simd_feature));
            println!("arch={}", std::env::consts::ARCH);
            println!(
                "threads={}",
                std::thread::available_parallelism().map_or(0, |n| n.get())
            );
        }
        "dump-coeffs" => {
            // Print the encoder's scale-normalized AC coefficients, one per
            // line as "<group> <value>" (groups l/a/b/alpha). The harness pools
            // these across the tuning corpus to train Lloyd-Max codebooks.
            if args.len() != 5 {
                eprintln!("Usage: encode_stdin dump-coeffs <width> <height> <gamut>");
                std::process::exit(1);
            }
            let w: u32 = args[2].parse().expect("invalid width");
            let h: u32 = args[3].parse().expect("invalid height");
            let gamut = parse_gamut(&args[4]);

            let expected_len = (w as usize) * (h as usize) * 4;
            let mut rgba = vec![0u8; expected_len];
            io::stdin()
                .read_exact(&mut rgba)
                .expect("failed to read RGBA from stdin");

            let dump = encode_debug_coefficients(
                w,
                h,
                &rgba,
                gamut,
                &tunables_from_env(),
                tier_from_env(),
            );
            let mut out = String::new();
            for (group, values) in [
                ("l", &dump.l),
                ("a", &dump.a),
                ("b", &dump.b),
                ("alpha", &dump.alpha),
            ] {
                for v in values {
                    out.push_str(group);
                    out.push(' ');
                    out.push_str(&format!("{v:.17}"));
                    out.push('\n');
                }
            }
            io::stdout()
                .write_all(out.as_bytes())
                .expect("failed to write coefficients");
        }
        "batch-decode" => {
            // No batch decode API exists; loop the single decode `count` times.
            if args.len() != 3 {
                eprintln!("Usage: encode_stdin batch-decode <count>");
                std::process::exit(1);
            }
            let count: usize = args[2].parse().expect("invalid count");
            let ch = read_hash_from_stdin();
            let mut acc = 0u8;
            for _ in 0..count {
                let (_w, _h, rgba) = ch.decode();
                acc ^= rgba[0];
            }
            io::stdout()
                .write_all(&[acc])
                .expect("failed to write checksum");
        }
        _ => usage(),
    }
}
