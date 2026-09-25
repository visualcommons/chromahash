use crate::aspect::encode_aspect;
use crate::bitpack::write_bits;
use crate::color::{linear_rgb_to_oklab, oklab_to_linear_srgb};
use crate::constants::{
    ALPHA_FLAG_BIT, DEFAULT_TIER, FORMAT_VERSION, Gamut, MAX_TIER, Tunables, VERSION_BITS,
    ac_payload_bits, ac_shape, body_len_bytes, is_valid_tier, prefix_bits,
};
use crate::dct::{
    Selection, SelectionOrder, dct_decode_pixel_separable, dct_encode_selected, interleaved_order,
    precompute_cos_table, window_weights,
};
use crate::math_utils::{clamp_neg1_1, clamp01, round_half_away_from_zero};
use crate::mulaw::{compand_dequantize, compand_quantize, mu_compress, mu_expand};
use crate::transfer::{adobe_rgb_eotf, bt2020_pq_eotf, prophoto_rgb_eotf, srgb_eotf, srgb_gamma};

/// Build a 256-entry EOTF lookup table for the given gamut. Per spec §5.2.
fn build_eotf_lut(gamut: Gamut) -> [f64; 256] {
    let mut lut = [0.0f64; 256];
    for (i, entry) in lut.iter_mut().enumerate() {
        let x = i as f64 / 255.0;
        *entry = match gamut {
            Gamut::Srgb | Gamut::DisplayP3 => srgb_eotf(x),
            Gamut::AdobeRgb => adobe_rgb_eotf(x),
            Gamut::ProPhotoRgb => prophoto_rgb_eotf(x),
            Gamut::Bt2020 => bt2020_pq_eotf(x),
        };
    }
    lut
}

/// Simulate the decoder's DC-only path for a quantized (L, a, b) code triple:
/// dequantize → clamp L → linear sRGB → per-channel clip → gamma. Returns the
/// gamma-encoded sRGB triple the decoder would render for a flat region.
fn dc_decode_sim(l_q: u32, a_q: u32, b_q: u32, t: &Tunables) -> [f64; 3] {
    let l = dequantize_l_dc(l_q, t.l_dc_bits);
    let a = dequantize_c_dc(a_q, t.max_chroma_a, t.a_dc_bits);
    let b = dequantize_c_dc(b_q, t.max_chroma_b, t.b_dc_bits);
    let rgb = oklab_to_linear_srgb([clamp01(l), a, b]);
    [
        srgb_gamma(clamp01(rgb[0])),
        srgb_gamma(clamp01(rgb[1])),
        srgb_gamma(clamp01(rgb[2])),
    ]
}

/// Decode-aware DC code selection. Per spec §10 (v0.6).
///
/// Plain rounding of the DC triple, combined with quantization and the
/// decoder's per-channel clip of out-of-gamut chroma, can land the decoded
/// flat color away from the true average. Searching the ±1 neighborhood of the
/// nominal codes — scoring each by the simulated decoded color against the
/// clipped target — costs 27 DC simulations (~10 µs) and zero bits. Fixed
/// iteration order and strict improvement (`<`) keep it deterministic; ties
/// keep the nominal codes.
fn select_dc_codes(l_mean: f64, a_mean: f64, b_mean: f64, t: &Tunables) -> (u32, u32, u32) {
    let l0 = quantize_l_dc(l_mean, t.l_dc_bits) as i64;
    let a0 = quantize_c_dc(a_mean, t.max_chroma_a, t.a_dc_bits) as i64;
    let b0 = quantize_c_dc(b_mean, t.max_chroma_b, t.b_dc_bits) as i64;

    if !t.dc_search {
        return (l0 as u32, a0 as u32, b0 as u32);
    }
    let l_hi = ((1i64 << t.l_dc_bits) - 1).max(0);
    let a_hi = ((1i64 << t.a_dc_bits) - 1).max(0);
    let b_hi = ((1i64 << t.b_dc_bits) - 1).max(0);

    // Target = what the decoder could at best show for the true average color
    // (out-of-gamut targets are clipped per-channel, same as the decoder).
    let target_rgb = oklab_to_linear_srgb([clamp01(l_mean), a_mean, b_mean]);
    let target = [
        srgb_gamma(clamp01(target_rgb[0])),
        srgb_gamma(clamp01(target_rgb[1])),
        srgb_gamma(clamp01(target_rgb[2])),
    ];

    let mut best = (l0 as u32, a0 as u32, b0 as u32);
    let mut best_err = f64::INFINITY;
    for dl in [0i64, -1, 1] {
        for da in [0i64, -1, 1] {
            for db in [0i64, -1, 1] {
                let l_q = (l0 + dl).clamp(0, l_hi) as u32;
                let a_q = (a0 + da).clamp(1, a_hi) as u32;
                let b_q = (b0 + db).clamp(1, b_hi) as u32;
                let cand = dc_decode_sim(l_q, a_q, b_q, t);
                let dr = cand[0] - target[0];
                let dg = cand[1] - target[1];
                let db_ = cand[2] - target[2];
                let err = dr * dr + dg * dg + db_ * db_;
                if err < best_err {
                    best_err = err;
                    best = (l_q, a_q, b_q);
                }
            }
        }
    }
    best
}

/// First selection index of the scalefactor high band: `floor(count·split)`.
/// Encoder and decoder compute this identically (same f64 expression).
pub(crate) fn band_split_index(count: usize, split: f64) -> usize {
    (count as f64 * split) as usize
}

/// Everything the encoder derives from the pixels before quantization: the
/// alpha/aspect geometry, the resolved AC shape, and each channel's
/// (dc, ac-in-selection-order, scale) DCT result.
struct Analysis {
    has_alpha: bool,
    aspect: u8,
    /// The value actually written into the (possibly narrowed) aspect field.
    aspect_code: u32,
    shape: crate::constants::AcShape,
    l: (f64, Vec<f64>, f64),
    a: (f64, Vec<f64>, f64),
    b: (f64, Vec<f64>, f64),
    alpha: (f64, Vec<f64>, f64),
    /// Encoder-input geometry and the composited OKLAB channels, kept so the
    /// pixel-domain refinement can score candidate codes against the source it
    /// was actually derived from (see [`refine_codes`]).
    w: usize,
    h: usize,
    l_chan: Vec<f64>,
    a_chan: Vec<f64>,
    b_chan: Vec<f64>,
    l_sel: Selection,
    c_sel: Selection,
    cos_x: Vec<Vec<f64>>,
    cos_y: Vec<Vec<f64>>,
}

/// Stage timing for `mise run benchmark:stages` and
/// `mise run benchmark:decode-stages`, compiled only under the off-by-default
/// `bench-internals` feature.
///
/// Answering "where does encode time actually go" needs per-stage numbers, and
/// this crate has no dependencies to profile with. Everything here is behind the
/// feature, so the shipped build contains not one instruction of it — the
/// `stage!` marks below expand to nothing at all. It is also invisible to the
/// mutation sweep, which builds with `no_default_features` (see
/// rust/.cargo/mutants.toml), so it adds no mutants to the hot path.
///
/// The decoder marks its own stages through the same recorder (`decode.rs`
/// imports `stage!` from here). One recorder serves both because a mark is
/// "time since the previous mark on this thread", so the two only stay
/// separable while neither calls the other: the encoder calls no decode entry
/// point outside its tests, and each example resets the recorder around the one
/// operation it times.
#[cfg(feature = "bench-internals")]
pub mod stage_timing {
    use std::cell::RefCell;
    use std::time::Instant;

    thread_local! {
        static MARKS: RefCell<Vec<(&'static str, u128)>> = const { RefCell::new(Vec::new()) };
        static LAST: RefCell<Option<Instant>> = const { RefCell::new(None) };
    }

    /// Begin a run, discarding any marks from a previous one.
    pub fn reset() {
        MARKS.with(|m| m.borrow_mut().clear());
        LAST.with(|l| *l.borrow_mut() = Some(Instant::now()));
    }

    /// Record the nanoseconds elapsed since the previous mark under `name`.
    pub fn mark(name: &'static str) {
        let now = Instant::now();
        LAST.with(|l| {
            let mut last = l.borrow_mut();
            if let Some(prev) = *last {
                MARKS.with(|m| {
                    m.borrow_mut()
                        .push((name, now.duration_since(prev).as_nanos()))
                });
            }
            *last = Some(now);
        });
    }

    /// Drain the marks recorded since [`reset`].
    pub fn take() -> Vec<(&'static str, u128)> {
        MARKS.with(|m| std::mem::take(&mut *m.borrow_mut()))
    }
}

#[cfg(feature = "bench-internals")]
macro_rules! stage {
    ($name:literal) => {
        $crate::encode::stage_timing::mark($name)
    };
}

#[cfg(not(feature = "bench-internals"))]
macro_rules! stage {
    ($name:literal) => {};
}

// Crate-visible so the decoder marks its stages with the same macro, and so
// with the same guarantee: nothing at all in a build without the feature.
pub(crate) use stage;

/// Signal-path front half of the encoder (spec §10 steps 1–7): color
/// conversion, alpha handling, coefficient selection, and the forward DCT.
/// Shared by [`encode_with`] and the sweep-only coefficient dump.
fn analyze(w: u32, h: u32, rgba: &[u8], gamut: Gamut, t: &Tunables, tier: u8) -> Analysis {
    assert!(w >= 1, "width must be >= 1");
    assert!(h >= 1, "height must be >= 1");
    assert!(
        rgba.len() == (w as usize) * (h as usize) * 4,
        "rgba length mismatch"
    );
    assert!(
        is_valid_tier(tier),
        "tier must be a valid code 0..={MAX_TIER}"
    );

    let w = w as usize;
    let h = h as usize;
    let pixel_count = w * h;

    // 1. Precompute EOTF LUT (256 entries, eliminates per-pixel portable_pow)
    let eotf_lut = build_eotf_lut(gamut);
    stage!("eotf_lut");

    // 2. Per-pixel OKLAB conversion with alpha accumulation.
    //
    // The linear-RGB → OKLAB transform is independent per pixel, so it runs
    // through the SIMD batch path (`simd::oklab_forward_batch`), whose output is
    // byte-identical to per-pixel `linear_rgb_to_oklab`. The alpha-weighted
    // average is a reduction, so it stays a scalar pass in pixel order to keep
    // the floating-point summation bit-exact.
    let mut lin_r = vec![0.0f64; pixel_count];
    let mut lin_g = vec![0.0f64; pixel_count];
    let mut lin_b = vec![0.0f64; pixel_count];
    let mut alpha_pixels = vec![0.0f64; pixel_count];
    for i in 0..pixel_count {
        lin_r[i] = eotf_lut[rgba[i * 4] as usize];
        lin_g[i] = eotf_lut[rgba[i * 4 + 1] as usize];
        lin_b[i] = eotf_lut[rgba[i * 4 + 2] as usize];
        alpha_pixels[i] = rgba[i * 4 + 3] as f64 / 255.0;
    }
    stage!("linearize");

    let mut oklab_pixels = vec![[0.0f64; 3]; pixel_count];
    crate::simd::oklab_forward_batch(&lin_r, &lin_g, &lin_b, gamut, &mut oklab_pixels);
    stage!("oklab_forward");

    let mut avg_l = 0.0;
    let mut avg_a = 0.0;
    let mut avg_b = 0.0;
    let mut avg_alpha = 0.0;
    for i in 0..pixel_count {
        let alpha = alpha_pixels[i];
        let lab = oklab_pixels[i];
        avg_l += alpha * lab[0];
        avg_a += alpha * lab[1];
        avg_b += alpha * lab[2];
        avg_alpha += alpha;
    }
    stage!("alpha_average");

    // 3. Compute alpha-weighted average color
    if avg_alpha > 0.0 {
        avg_l /= avg_alpha;
        avg_a /= avg_alpha;
        avg_b /= avg_alpha;
    }

    // 4. Composite transparent pixels over average
    let has_alpha = avg_alpha < pixel_count as f64;
    let mut l_chan = vec![0.0f64; pixel_count];
    let mut a_chan = vec![0.0f64; pixel_count];
    let mut b_chan = vec![0.0f64; pixel_count];

    for i in 0..pixel_count {
        let alpha = alpha_pixels[i];
        l_chan[i] = avg_l * (1.0 - alpha) + alpha * oklab_pixels[i][0];
        a_chan[i] = avg_a * (1.0 - alpha) + alpha * oklab_pixels[i][1];
        b_chan[i] = avg_b * (1.0 - alpha) + alpha * oklab_pixels[i][2];
    }
    stage!("composite");

    // 5. Select coefficients (top-K isotropic frequencies, scaled to the tier)
    // The aspect field may be narrower than a byte; encoder and decoder must
    // both select and render on the *reconstructed* aspect.
    let (aspect_code, aspect) = quantize_aspect(encode_aspect(w as u32, h as u32), t.aspect_bits);
    let shape = ac_shape(t, has_alpha, tier);
    let l_count = shape.l_count();
    let c_count = shape.c_count;
    let order = SelectionOrder::new(aspect, tier, t.aniso_oblique, t.sel_hv);
    let l_sel: Selection = order.take(l_count);
    let c_sel: Selection = order.take(c_count);
    let alpha_sel = if has_alpha {
        order.take(shape.alpha_ac_count)
    } else {
        Selection {
            coeffs: vec![],
            priorities: vec![],
            p_k: 1,
        }
    };

    // 6. Precompute cosine tables over the source dims, covering every
    // selected frequency (rows for frequencies ≥ source dims exist but are
    // never read — dct_encode_selected clamps them to exact zero).
    let max_cx = l_sel
        .coeffs
        .iter()
        .chain(c_sel.coeffs.iter())
        .chain(alpha_sel.coeffs.iter())
        .map(|&(cx, _)| cx)
        .max()
        .unwrap_or(0);
    let max_cy = l_sel
        .coeffs
        .iter()
        .chain(c_sel.coeffs.iter())
        .chain(alpha_sel.coeffs.iter())
        .map(|&(_, cy)| cy)
        .max()
        .unwrap_or(0);
    stage!("selection");
    let cos_x = precompute_cos_table(w, (max_cx + 1).min(w.max(1)));
    let cos_y = precompute_cos_table(h, (max_cy + 1).min(h.max(1)));
    stage!("cos_tables");

    // 7. DCT encode each channel (frequency clamp to source dims built in).
    //
    // `dct_separable` selects the prototype separable transform. It is not
    // byte-identical — see `dct::dct_encode_selected_separable` — and is false
    // in `Tunables::DEFAULT`, so the shipped path is always the direct sum.
    let forward = if t.dct_separable {
        crate::dct::dct_encode_selected_separable
    } else {
        dct_encode_selected
    };
    let l = forward(&l_chan, w, h, &l_sel.coeffs, &cos_x, &cos_y);
    let a = forward(&a_chan, w, h, &c_sel.coeffs, &cos_x, &cos_y);
    let b = forward(&b_chan, w, h, &c_sel.coeffs, &cos_x, &cos_y);
    let alpha = if has_alpha {
        forward(&alpha_pixels, w, h, &alpha_sel.coeffs, &cos_x, &cos_y)
    } else {
        (0.0, vec![], 0.0)
    };

    stage!("dct_forward");

    Analysis {
        has_alpha,
        aspect,
        aspect_code,
        shape,
        l,
        a,
        b,
        alpha,
        w,
        h,
        l_chan,
        a_chan,
        b_chan,
        l_sel,
        c_sel,
        cos_x,
        cos_y,
    }
}

// ── Tunable header field widths ───────────────────────────────────────────
//
// The 54-bit prefix (descriptor + aspect + DC + scales) is 21% of a 32-byte
// hash and 32% of a 21-byte one. These helpers let a sweep resize each field
// so the cost of that framing can be measured instead of assumed. With the
// shipped widths every one of them reproduces the v1 bytes exactly.

/// Coarsen the aspect byte to `bits`, symmetrically about 1:1 (byte 128) so the
/// portrait/landscape mirror symmetry the validator enforces survives.
/// Returns `(code, reconstructed_byte)`.
pub(crate) fn quantize_aspect(aspect: u8, bits: u32) -> (u32, u8) {
    if bits >= 8 {
        return (aspect as u32, aspect);
    }
    let step = 1i64 << (8 - bits);
    let center = 1i64 << (bits - 1);
    let d = aspect as i64 - 128;
    let code = (round_half_away_from_zero(d as f64 / step as f64) as i64 + center)
        .clamp(0, (1i64 << bits) - 1);
    let recon = (128 + (code - center) * step).clamp(0, 255) as u8;
    (code as u32, recon)
}

/// Reconstruct the aspect byte a decoder sees from a coarsened aspect code.
pub(crate) fn dequantize_aspect(code: u32, bits: u32) -> u8 {
    if bits >= 8 {
        return code as u8;
    }
    let step = 1i64 << (8 - bits);
    let center = 1i64 << (bits - 1);
    (128 + (code as i64 - center) * step).clamp(0, 255) as u8
}

/// Quantize a luma DC value in [0, 1] to a `bits`-wide code.
pub(crate) fn quantize_l_dc(value: f64, bits: u32) -> u32 {
    let max = ((1u32 << bits) - 1) as f64;
    round_half_away_from_zero(max * clamp01(value)) as u32
}

/// Dequantize a luma DC code.
pub(crate) fn dequantize_l_dc(code: u32, bits: u32) -> f64 {
    code as f64 / ((1u32 << bits) - 1) as f64
}

/// Quantize a chroma DC value to a `bits`-wide code centred on zero. At 7 bits
/// this is the shipped `round(64 + 63·x)`.
pub(crate) fn quantize_c_dc(value: f64, range: f64, bits: u32) -> u32 {
    let center = (1u32 << (bits - 1)) as f64;
    let span = center - 1.0;
    round_half_away_from_zero(center + span * clamp_neg1_1(value / range)) as u32
}

/// Dequantize a chroma DC code.
pub(crate) fn dequantize_c_dc(code: u32, range: f64, bits: u32) -> f64 {
    let center = (1u32 << (bits - 1)) as f64;
    let span = center - 1.0;
    (code as f64 - center) / span * range
}

/// Quantize an AC scale into a `bits`-wide code. `scale_mu` = 0 is the shipped
/// linear grid; a positive value companded the code µ-law style, which puts the
/// resolution where corpus scales actually sit (near zero).
pub(crate) fn quantize_scale(scale: f64, range: f64, bits: u32, scale_mu: f64) -> u32 {
    let code_max = ((1u32 << bits) - 1) as f64;
    let x = clamp01(scale / range);
    let companded = if scale_mu > 0.0 {
        mu_compress(x, scale_mu)
    } else {
        x
    };
    round_half_away_from_zero(code_max * companded) as u32
}

/// Dequantize an AC scale code.
pub(crate) fn dequantize_scale(code: u32, range: f64, bits: u32, scale_mu: f64) -> f64 {
    let code_max = ((1u32 << bits) - 1) as f64;
    let x = code as f64 / code_max;
    if scale_mu > 0.0 {
        mu_expand(x, scale_mu) * range
    } else {
        x * range
    }
}

/// One channel's AC quantization job: the coefficients in selection order, the
/// per-index bit widths, the scalefactor-band split, and the group's companding
/// parameters. Used by [`quantize_ac_channel`], which owns every encoder-only
/// scale/rounding policy so the three call sites stay identical.
struct AcQuantJob<'a> {
    values: &'a [f64],
    /// Precision tiers in write order (chroma/alpha pass a single tier).
    tiers: &'a [(usize, u32)],
    /// First selection index of the scalefactor high band.
    split: usize,
    /// Scale multiplier applied at and above `split` (1.0 disables).
    band_gain: f64,
    /// Quantization range the scale code spans (e.g. `MAX_L_SCALE`).
    max_scale: f64,
    /// Largest writable scale code (2^bits − 1).
    code_max: u32,
    /// Width of the scale field (for the µ-law scale grid).
    scale_bits: u32,
    /// µ-law parameter of the scale grid (0 = linear, the shipped grid).
    scale_mu: f64,
    family: crate::constants::Companding,
    mu: f64,
    table: &'a crate::constants::QuantTable,
    deadzone: f64,
}

impl AcQuantJob<'_> {
    /// Bit width of the coefficient at selection index `i`.
    fn bits_at(&self, i: usize) -> u32 {
        let mut base = 0usize;
        for &(count, bits) in self.tiers {
            if i < base + count {
                return bits;
            }
            base += count;
        }
        self.tiers.last().map(|&(_, b)| b).unwrap_or(0)
    }

    /// Scale multiplier at selection index `i`.
    fn gain_at(&self, i: usize) -> f64 {
        if i >= self.split { self.band_gain } else { 1.0 }
    }
}

/// Quantize one coefficient. With `nearest` the ±2 neighborhood of the
/// companded-domain code is scored by *reconstruction* error and the best code
/// wins; otherwise this is bit-for-bit the shipped `compand_quantize`.
///
/// A fired deadzone short-circuits the search. The deadzone's whole purpose is
/// to force a small coefficient to exact zero, and the nearest-reconstruction
/// code for a small value is always within ±2 of the centre — so letting the
/// search run would silently undo every deadzone decision, making the knob
/// inert rather than merely ineffective. (It was: before this, the encoder
/// produced byte-identical output at every deadzone value.)
fn quantize_one(job: &AcQuantJob, value: f64, scale: f64, bits: u32, nearest: bool) -> u32 {
    let normalized = if scale == 0.0 { 0.0 } else { value / scale };
    let q = compand_quantize(
        normalized,
        bits,
        job.family,
        job.mu,
        job.table,
        job.deadzone,
    );
    let deadzoned = job.deadzone > 0.0 && normalized.abs() < job.deadzone;
    if !nearest || scale == 0.0 || deadzoned {
        return q;
    }
    let max_idx = (1u32 << bits) - 2;
    let mut best = q;
    let mut best_err = f64::INFINITY;
    for d in [0i64, -1, 1, -2, 2] {
        let cand = (q as i64 + d).clamp(0, max_idx as i64) as u32;
        let rec = compand_dequantize(cand, bits, job.family, job.mu, job.table) * scale;
        let err = (rec - value).abs();
        // Strict improvement keeps the shipped code on ties (d = 0 is first).
        if err < best_err {
            best_err = err;
            best = cand;
        }
    }
    best
}

/// Reconstruction SSE of a whole channel at one candidate dequantized scale.
fn channel_sse(job: &AcQuantJob, scale: f64, nearest: bool) -> f64 {
    let mut sse = 0.0;
    for (i, &v) in job.values.iter().enumerate() {
        let bits = job.bits_at(i);
        let s = scale * job.gain_at(i);
        let q = quantize_one(job, v, s, bits, nearest);
        let rec = compand_dequantize(q, bits, job.family, job.mu, job.table) * s;
        let d = rec - v;
        sse += d * d;
    }
    sse
}

/// Choose the scale code and quantize a channel's AC set under the encoder-only
/// `scale_fit` / `ac_nearest` policies. Returns `(scale_code, codes)`.
///
/// Mode 0 reproduces the shipped bytes exactly: the code is `round(max|AC|)`
/// and coefficients are normalized by the *unquantized* max|AC|, even though
/// the decoder will dequantize with the rounded scale.
fn quantize_ac_channel(job: &AcQuantJob, raw_scale: f64, t: &Tunables) -> (u32, Vec<u32>) {
    let nominal = quantize_scale(raw_scale, job.max_scale, job.scale_bits, job.scale_mu);
    let dq = |code: u32| dequantize_scale(code, job.max_scale, job.scale_bits, job.scale_mu);

    let (code, norm_scale) = match t.scale_fit {
        0 => (nominal, raw_scale),
        1 => (nominal, dq(nominal)),
        _ => {
            // Search every representable scale code. A channel with no energy
            // keeps code 0 (and the exact-zero AC codes that go with it).
            if raw_scale == 0.0 {
                (0, 0.0)
            } else {
                let mut best = nominal.max(1);
                let mut best_sse = f64::INFINITY;
                for code in 1..=job.code_max {
                    let sse = channel_sse(job, dq(code), t.ac_nearest);
                    if sse < best_sse {
                        best_sse = sse;
                        best = code;
                    }
                }
                (best, dq(best))
            }
        }
    };

    let mut codes = Vec::with_capacity(job.values.len());
    for (i, &v) in job.values.iter().enumerate() {
        let bits = job.bits_at(i);
        codes.push(quantize_one(
            job,
            v,
            norm_scale * job.gain_at(i),
            bits,
            t.ac_nearest,
        ));
    }
    (code, codes)
}

// ── Pixel-domain refinement (encoder-only) ─────────────────────────────────
//
// Independent scalar rounding minimizes *coefficient* squared error, and the
// selected cosine basis is orthogonal, so on that objective there is nothing
// left to win. The decoded error is a different function: the render path
// clamps L into [0, 1] and clips each output channel into gamut, and both are
// non-linear, so the pixel error is not separable across coefficients. This
// module scores candidate codes on the decoded pixels instead, by coordinate
// descent over the AC codes (optionally the DC and scale codes too).

/// Number of entries in the linear→gamma lookup used by the refinement
/// objective; matches the decoder's render LUT resolution.
const REFINE_GAMMA_LUT: usize = 4096;

/// The refinement objective: maps a reconstructed OKLAB triple into the space
/// the error is measured in, and holds the mapped source as the target.
struct PixelObjective {
    obj: u32,
    /// Channel weights for the weighted clipped-OKLAB objective (obj 3).
    wl: f64,
    wc: f64,
    /// Mapped source, one triple per encoder-input pixel.
    target: Vec<[f64; 3]>,
    /// linear → gamma, sampled at `REFINE_GAMMA_LUT` points (objective 0).
    gamma: Vec<f64>,
}

impl PixelObjective {
    fn new(obj: u32, wl: f64, wc: f64, l_chan: &[f64], a_chan: &[f64], b_chan: &[f64]) -> Self {
        let gamma: Vec<f64> = (0..REFINE_GAMMA_LUT)
            .map(|i| srgb_gamma(i as f64 / (REFINE_GAMMA_LUT - 1) as f64))
            .collect();
        let mut me = Self {
            obj,
            wl,
            wc,
            target: Vec::new(),
            gamma,
        };
        me.target = (0..l_chan.len())
            .map(|p| me.map(l_chan[p], a_chan[p], b_chan[p]))
            .collect();
        me
    }

    /// Gamma-encode a linear value through the LUT (same grid as the decoder).
    #[inline]
    fn gamma_of(&self, x: f64) -> f64 {
        let idx = (round_half_away_from_zero(clamp01(x) * (REFINE_GAMMA_LUT - 1) as f64) as i64)
            .clamp(0, REFINE_GAMMA_LUT as i64 - 1) as usize;
        self.gamma[idx]
    }

    /// Map a reconstructed OKLAB triple into the objective space.
    #[inline]
    fn map(&self, l: f64, a: f64, b: f64) -> [f64; 3] {
        match self.obj {
            // OKLAB with no clipping model — the control. Independent rounding
            // is already optimal here, so this variant should find ~nothing.
            1 => [l, a, b],
            // Weighted clipped OKLAB: the same, with the L and chroma terms
            // reweighted so the objective can be steered toward colour.
            3 => {
                let rgb = oklab_to_linear_srgb([clamp01(l), a, b]);
                let lab = linear_rgb_to_oklab(
                    [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])],
                    Gamut::Srgb,
                );
                [lab[0] * self.wl, lab[1] * self.wc, lab[2] * self.wc]
            }
            // OKLAB after the gamut clip: perceptual *and* clip-aware.
            2 => {
                let rgb = oklab_to_linear_srgb([clamp01(l), a, b]);
                linear_rgb_to_oklab(
                    [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])],
                    Gamut::Srgb,
                )
            }
            // Gamma-encoded sRGB: the bytes the decoder actually emits.
            _ => {
                let rgb = oklab_to_linear_srgb([clamp01(l), a, b]);
                [
                    self.gamma_of(rgb[0]),
                    self.gamma_of(rgb[1]),
                    self.gamma_of(rgb[2]),
                ]
            }
        }
    }

    /// Squared error of a whole reconstruction against the target.
    fn sse(&self, l: &[f64], a: &[f64], b: &[f64]) -> f64 {
        let mut acc = 0.0;
        for p in 0..self.target.len() {
            let m = self.map(l[p], a[p], b[p]);
            let t = self.target[p];
            let d0 = m[0] - t[0];
            let d1 = m[1] - t[1];
            let d2 = m[2] - t[2];
            acc += d0 * d0 + d1 * d1 + d2 * d2;
        }
        acc
    }
}

/// Add `dval · basis(cx, cy)` into a per-pixel channel.
#[inline]
#[allow(clippy::too_many_arguments, clippy::needless_range_loop)]
fn add_basis(
    dst: &mut [f64],
    w: usize,
    h: usize,
    cx: usize,
    cy: usize,
    dval: f64,
    cos_x: &[Vec<f64>],
    cos_y: &[Vec<f64>],
) {
    let fx = if cx > 0 { 2.0 } else { 1.0 };
    let fy = if cy > 0 { 2.0 } else { 1.0 };
    for y in 0..h {
        let cyv = cos_y[cy][y] * fy;
        let row = y * w;
        for x in 0..w {
            dst[row + x] += dval * cos_x[cx][x] * fx * cyv;
        }
    }
}

/// SSE of the reconstruction with one channel perturbed by `dval · basis`,
/// without materializing the perturbed channel.
#[allow(clippy::too_many_arguments, clippy::needless_range_loop)]
fn sse_with_delta(
    obj: &PixelObjective,
    l: &[f64],
    a: &[f64],
    b: &[f64],
    which: usize,
    w: usize,
    h: usize,
    cx: usize,
    cy: usize,
    dval: f64,
    cos_x: &[Vec<f64>],
    cos_y: &[Vec<f64>],
) -> f64 {
    let fx = if cx > 0 { 2.0 } else { 1.0 };
    let fy = if cy > 0 { 2.0 } else { 1.0 };
    let mut acc = 0.0;
    for y in 0..h {
        let cyv = cos_y[cy][y] * fy;
        let row = y * w;
        for x in 0..w {
            let p = row + x;
            let d = dval * cos_x[cx][x] * fx * cyv;
            let (lv, av, bv) = match which {
                0 => (l[p] + d, a[p], b[p]),
                1 => (l[p], a[p] + d, b[p]),
                _ => (l[p], a[p], b[p] + d),
            };
            let m = obj.map(lv, av, bv);
            let t = obj.target[p];
            let d0 = m[0] - t[0];
            let d1 = m[1] - t[1];
            let d2 = m[2] - t[2];
            acc += d0 * d0 + d1 * d1 + d2 * d2;
        }
    }
    acc
}

/// The luma AC values a decoder reconstructs, in selection order — the CfL
/// predictor's input. Excludes the decode-side synthesis window, which the
/// decoder applies to the summed chroma value, not to the predictor.
fn decoded_luma_ac(job: &AcQuantJob, scale_code: u32, codes: &[u32]) -> Vec<f64> {
    let scale = dequantize_scale(scale_code, job.max_scale, job.scale_bits, job.scale_mu);
    codes
        .iter()
        .enumerate()
        .map(|(i, &q)| {
            compand_dequantize(q, job.bits_at(i), job.family, job.mu, job.table)
                * scale
                * job.gain_at(i)
        })
        .collect()
}

/// Least-squares CfL gain: the alpha minimizing ‖chroma − alpha·luma‖² over the
/// indices both channels share (chroma is always the shorter set).
fn cfl_gain(chroma: &[f64], luma: &[f64]) -> f64 {
    let mut num = 0.0;
    let mut den = 0.0;
    for (i, &c) in chroma.iter().enumerate() {
        let l = luma.get(i).copied().unwrap_or(0.0);
        num += c * l;
        den += l * l;
    }
    if den <= 0.0 { 0.0 } else { num / den }
}

/// Quantize a CfL gain into a `bits`-wide code centred on zero.
pub(crate) fn quantize_cfl_gain(alpha: f64, range: f64, bits: u32) -> u32 {
    let center = (1u32 << (bits - 1)) as f64;
    let span = center - 1.0;
    round_half_away_from_zero(center + span * clamp_neg1_1(alpha / range)) as u32
}

/// Dequantize a CfL gain code.
pub(crate) fn dequantize_cfl_gain(code: u32, range: f64, bits: u32) -> f64 {
    let center = (1u32 << (bits - 1)) as f64;
    let span = center - 1.0;
    (code as f64 - center) / span * range
}

/// Project a channel onto the full DCT basis of a `rw × rh` grid and evaluate
/// it there: the ideal, alias-free rendering of the source at the decoder's
/// natural size. Used as the refinement target when `refine_grid = 1`, so the
/// encoder optimizes the pixels a decoder will actually emit rather than the
/// encoder input it will never show.
fn resample_channel_dct(chan: &[f64], w: usize, h: usize, rw: usize, rh: usize) -> Vec<f64> {
    let fx = rw.min(w);
    let fy = rh.min(h);
    let mut coeffs: Vec<(usize, usize)> = Vec::with_capacity(fx * fy);
    for cy in 0..fy {
        for cx in 0..fx {
            if cx == 0 && cy == 0 {
                continue;
            }
            coeffs.push((cx, cy));
        }
    }
    let cos_x = precompute_cos_table(w, fx);
    let cos_y = precompute_cos_table(h, fy);
    let (dc, ac, _) = dct_encode_selected(chan, w, h, &coeffs, &cos_x, &cos_y);
    let rcos_x = precompute_cos_table(rw, fx);
    let rcos_y = precompute_cos_table(rh, fy);
    let mut out = vec![0.0f64; rw * rh];
    for y in 0..rh {
        for x in 0..rw {
            out[y * rw + x] = dct_decode_pixel_separable(dc, &ac, &coeffs, x, y, &rcos_x, &rcos_y);
        }
    }
    out
}

/// Coordinate descent over the quantized codes, scored on the decoded pixels.
///
/// `dc`, `scl` and `codes` are the L/a/b header and AC codes, updated in place.
/// Only codes that strictly reduce the objective are accepted, and candidates
/// are visited in a fixed order, so the result is deterministic.
#[allow(clippy::too_many_arguments)]
fn refine_codes(
    t: &Tunables,
    w: usize,
    h: usize,
    cos_x: &[Vec<f64>],
    cos_y: &[Vec<f64>],
    sels: [&Selection; 3],
    jobs: [&AcQuantJob; 3],
    chans: [&[f64]; 3],
    // Encoder-input dims, used only to decide which selected frequencies the
    // source could represent; may differ from the refinement grid.
    src: (usize, usize),
    dc: &mut [u32; 3],
    scl: &mut [u32; 3],
    codes: &mut [Vec<u32>; 3],
) {
    let obj = PixelObjective::new(
        t.refine_obj,
        t.refine_wl,
        t.refine_wc,
        chans[0],
        chans[1],
        chans[2],
    );
    let windows = [
        window_weights(sels[0], t.w_min_l, t.w_exp_l),
        window_weights(sels[1], t.w_min_c, t.w_exp_c),
        window_weights(sels[2], t.w_min_c, t.w_exp_c),
    ];
    // The DC code ranges the shipped DC search uses (chroma never writes 0).
    let dc_lo = [0i64, 1, 1];
    let dc_hi = [127i64, 127, 127];

    let dc_val = |ch: usize, q: u32| -> f64 {
        match ch {
            0 => q as f64 / 127.0,
            1 => (q as f64 - 64.0) / 63.0 * t.max_chroma_a,
            _ => (q as f64 - 64.0) / 63.0 * t.max_chroma_b,
        }
    };
    let scale_val =
        |ch: usize, q: u32| -> f64 { q as f64 / jobs[ch].code_max as f64 * jobs[ch].max_scale };
    let ac_val = |ch: usize, i: usize, code: u32, scale: f64| -> f64 {
        let j = jobs[ch];
        compand_dequantize(code, j.bits_at(i), j.family, j.mu, j.table)
            * scale
            * j.gain_at(i)
            * windows[ch][i]
    };
    // A selected frequency the encoder input cannot represent was emitted as an
    // exact zero; refining it would invent energy the source does not have (and
    // its cosine row was never built).
    let live = |ch: usize, i: usize| -> bool {
        let (cx, cy) = sels[ch].coeffs[i];
        cx < src.0 && cy < src.1 && cx < w && cy < h
    };
    let build = |ch: usize, scale: f64, codes_ch: &[u32], dcq: u32| -> Vec<f64> {
        let mut r = vec![dc_val(ch, dcq); w * h];
        for (i, &code) in codes_ch.iter().enumerate() {
            if !live(ch, i) {
                continue;
            }
            let v = ac_val(ch, i, code, scale);
            if v == 0.0 {
                continue;
            }
            let (cx, cy) = sels[ch].coeffs[i];
            add_basis(&mut r, w, h, cx, cy, v, cos_x, cos_y);
        }
        r
    };

    let mut recon = [
        build(0, scale_val(0, scl[0]), &codes[0], dc[0]),
        build(1, scale_val(1, scl[1]), &codes[1], dc[1]),
        build(2, scale_val(2, scl[2]), &codes[2], dc[2]),
    ];
    let mut best = obj.sse(&recon[0], &recon[1], &recon[2]);

    let sse_of = |ch: usize, r: &[f64], recon: &[Vec<f64>; 3]| -> f64 {
        match ch {
            0 => obj.sse(r, &recon[1], &recon[2]),
            1 => obj.sse(&recon[0], r, &recon[2]),
            _ => obj.sse(&recon[0], &recon[1], r),
        }
    };

    for _pass in 0..t.refine_passes {
        let pass_start = best;

        // Scale codes: amplitude clipped away at decode is amplitude wasted, so
        // a narrower scale can buy resolution for everything that survives.
        if t.refine_scale && !t.b_scale_from_a {
            for ch in 0..3 {
                let cur = scl[ch];
                let mut chosen: Option<(u32, Vec<u32>, Vec<f64>, f64)> = None;
                for d in [-2i64, -1, 1, 2] {
                    let cand = (cur as i64 + d).clamp(0, jobs[ch].code_max as i64) as u32;
                    if cand == cur {
                        continue;
                    }
                    let s = scale_val(ch, cand);
                    let cc: Vec<u32> = (0..codes[ch].len())
                        .map(|i| {
                            quantize_one(
                                jobs[ch],
                                jobs[ch].values[i],
                                s * jobs[ch].gain_at(i),
                                jobs[ch].bits_at(i),
                                t.ac_nearest,
                            )
                        })
                        .collect();
                    let rr = build(ch, s, &cc, dc[ch]);
                    let e = sse_of(ch, &rr, &recon);
                    let better = chosen.as_ref().map_or(e < best, |(_, _, _, be)| e < *be);
                    if better {
                        chosen = Some((cand, cc, rr, e));
                    }
                }
                if let Some((cand, cc, rr, e)) = chosen {
                    scl[ch] = cand;
                    codes[ch] = cc;
                    recon[ch] = rr;
                    best = e;
                }
            }
        }

        // DC codes: the shipped search picked these against a flat target, with
        // the AC set assumed zero.
        if t.refine_dc {
            for ch in 0..3 {
                let cur = dc[ch];
                let mut chosen: Option<(u32, f64)> = None;
                for d in [-1i64, 1] {
                    let cand = (cur as i64 + d).clamp(dc_lo[ch], dc_hi[ch]) as u32;
                    if cand == cur {
                        continue;
                    }
                    let delta = dc_val(ch, cand) - dc_val(ch, cur);
                    let e = sse_with_delta(
                        &obj, &recon[0], &recon[1], &recon[2], ch, w, h, 0, 0, delta, cos_x, cos_y,
                    );
                    let better = chosen.as_ref().map_or(e < best, |&(_, be)| e < be);
                    if better {
                        chosen = Some((cand, e));
                    }
                }
                if let Some((cand, e)) = chosen {
                    let delta = dc_val(ch, cand) - dc_val(ch, cur);
                    add_basis(&mut recon[ch], w, h, 0, 0, delta, cos_x, cos_y);
                    dc[ch] = cand;
                    best = e;
                }
            }
        }

        // AC codes.
        for ch in 0..3 {
            let scale = scale_val(ch, scl[ch]);
            for i in 0..codes[ch].len() {
                if !live(ch, i) {
                    continue;
                }
                let cur = codes[ch][i];
                let bits = jobs[ch].bits_at(i);
                let max_idx = (1u32 << bits) - 2;
                let base = ac_val(ch, i, cur, scale);
                let (cx, cy) = sels[ch].coeffs[i];
                let mut chosen: Option<(u32, f64)> = None;
                for d in 1..=t.refine_delta as i64 {
                    for sgn in [-1i64, 1] {
                        let cand = (cur as i64 + sgn * d).clamp(0, max_idx as i64) as u32;
                        if cand == cur {
                            continue;
                        }
                        let dval = ac_val(ch, i, cand, scale) - base;
                        let e = sse_with_delta(
                            &obj, &recon[0], &recon[1], &recon[2], ch, w, h, cx, cy, dval, cos_x,
                            cos_y,
                        );
                        let better = chosen.as_ref().map_or(e < best, |&(_, be)| e < be);
                        if better {
                            chosen = Some((cand, e));
                        }
                    }
                }
                if let Some((cand, e)) = chosen {
                    let dval = ac_val(ch, i, cand, scale) - base;
                    add_basis(&mut recon[ch], w, h, cx, cy, dval, cos_x, cos_y);
                    codes[ch][i] = cand;
                    best = e;
                }
            }
        }

        if best >= pass_start {
            break;
        }
    }
}

/// Encode an image into a ChromaHash body with explicit tunables and quality
/// `tier`. Per spec §10 (v1). Returns the variable-length encoded bytes
/// (the default tier = 32 bytes; each higher code roughly quadruples the length).
pub fn encode_with(w: u32, h: u32, rgba: &[u8], gamut: Gamut, t: &Tunables, tier: u8) -> Box<[u8]> {
    let Analysis {
        has_alpha,
        aspect: _aspect,
        aspect_code,
        shape,
        l: (l_dc, l_ac, l_scale),
        a: (a_dc, a_ac, a_scale),
        b: (b_dc, b_ac, b_scale),
        alpha: (alpha_dc, alpha_ac, alpha_scale),
        w: src_w,
        h: src_h,
        l_chan,
        a_chan,
        b_chan,
        l_sel,
        c_sel,
        cos_x,
        cos_y,
    } = analyze(w, h, rgba, gamut, t, tier);

    // 8. Quantize header values (decode-aware DC code search, v0.6)
    let (l_dc_q, a_dc_q, b_dc_q) = select_dc_codes(l_dc, a_dc, b_dc, t);

    // Scalefactor-band split points (index >= split uses scale*band_gain).
    let l_split = band_split_index(shape.l_count(), t.band_split);
    let c_split = band_split_index(shape.c_count, t.band_split);

    // AC scale codes + codes for L/a/b. With the shipped tunables this is
    // bit-for-bit the v1 quantizer; `scale_fit`/`ac_nearest` are encoder-only.
    let c_tiers = [(shape.c_count, shape.c_bits)];
    let l_job = AcQuantJob {
        values: &l_ac,
        tiers: &shape.l_tiers,
        split: l_split,
        band_gain: t.band_gain_l,
        max_scale: t.max_l_scale,
        code_max: (1u32 << t.l_scale_bits) - 1,
        scale_bits: t.l_scale_bits,
        scale_mu: t.scale_mu,
        family: t.compand_l,
        mu: t.mu_l,
        table: &t.table_l,
        deadzone: t.deadzone_l,
    };
    let a_job = AcQuantJob {
        values: &a_ac,
        tiers: &c_tiers,
        split: c_split,
        band_gain: t.band_gain_c,
        max_scale: t.max_a_scale,
        code_max: (1u32 << t.a_scale_bits) - 1,
        scale_bits: t.a_scale_bits,
        scale_mu: t.scale_mu,
        family: t.compand_c,
        mu: t.mu_c,
        table: &t.table_c,
        deadzone: t.deadzone_c,
    };
    let b_job = AcQuantJob {
        values: &b_ac,
        tiers: &c_tiers,
        split: c_split,
        band_gain: t.band_gain_c,
        // With `b_scale_from_a` the b channel is quantized against the a
        // channel's field entirely: same range, same width, same code.
        max_scale: if t.b_scale_from_a {
            t.max_a_scale
        } else {
            t.max_b_scale
        },
        code_max: (1u32
            << if t.b_scale_from_a {
                t.a_scale_bits
            } else {
                t.b_scale_bits
            })
            - 1,
        scale_bits: if t.b_scale_from_a {
            t.a_scale_bits
        } else {
            t.b_scale_bits
        },
        scale_mu: t.scale_mu,
        family: t.compand_c,
        mu: t.mu_c,
        table: &t.table_c,
        deadzone: t.deadzone_c,
    };
    let (l_scl_q, l_codes) = quantize_ac_channel(&l_job, l_scale, t);

    // Alpha AC. `alpha_ac_fit` routes it through the same channel quantizer as
    // L/a/b so `scale_fit`/`ac_nearest` reach it; the legacy path is a nominal
    // scale code and a bare per-coefficient quantize, which is what alpha has
    // used since v0.6.
    let alpha_tiers = [(shape.alpha_ac_count, shape.alpha_ac_bits)];
    let alpha_job = AcQuantJob {
        values: &alpha_ac,
        tiers: &alpha_tiers,
        split: shape.alpha_ac_count,
        band_gain: 1.0,
        max_scale: t.max_alpha_scale,
        code_max: (1u32 << t.alpha_scale_bits) - 1,
        scale_bits: t.alpha_scale_bits,
        scale_mu: t.scale_mu,
        family: t.compand_alpha,
        mu: t.mu_alpha,
        table: &t.table_alpha,
        deadzone: t.deadzone_alpha,
    };
    let (alpha_scl_q, alpha_codes) = if !has_alpha {
        (0, Vec::new())
    } else if t.alpha_ac_fit {
        quantize_ac_channel(&alpha_job, alpha_scale, t)
    } else {
        let code = round_half_away_from_zero(
            ((1u32 << t.alpha_scale_bits) - 1) as f64 * clamp01(alpha_scale / t.max_alpha_scale),
        ) as u32;
        let codes = alpha_ac
            .iter()
            .map(|&v| {
                let n = if alpha_scale == 0.0 {
                    0.0
                } else {
                    v / alpha_scale
                };
                compand_quantize(
                    n,
                    shape.alpha_ac_bits,
                    t.compand_alpha,
                    t.mu_alpha,
                    &t.table_alpha,
                    t.deadzone_alpha,
                )
            })
            .collect();
        (code, codes)
    };

    // Chroma-from-luma: recode each chroma coefficient as a residual against
    // `alpha · (the luma AC value the decoder will reconstruct)`. The gains are
    // signalled, so the predictor is exactly reproducible; the chroma scale
    // field then carries the *residual* scale, which is the whole point.
    let (cfl_a_code, cfl_b_code, a_res, b_res) = if t.cfl_bits > 0 {
        let l_deq = decoded_luma_ac(&l_job, l_scl_q, &l_codes);
        let ga = cfl_gain(&a_ac, &l_deq);
        let gb = cfl_gain(&b_ac, &l_deq);
        let ca = quantize_cfl_gain(ga, t.cfl_range, t.cfl_bits);
        let cb = quantize_cfl_gain(gb, t.cfl_range, t.cfl_bits);
        let aq = dequantize_cfl_gain(ca, t.cfl_range, t.cfl_bits);
        let bq = dequantize_cfl_gain(cb, t.cfl_range, t.cfl_bits);
        let ra: Vec<f64> = a_ac
            .iter()
            .enumerate()
            .map(|(i, v)| v - aq * l_deq.get(i).copied().unwrap_or(0.0))
            .collect();
        let rb: Vec<f64> = b_ac
            .iter()
            .enumerate()
            .map(|(i, v)| v - bq * l_deq.get(i).copied().unwrap_or(0.0))
            .collect();
        (ca, cb, ra, rb)
    } else {
        (0, 0, Vec::new(), Vec::new())
    };
    let (a_job, b_job, a_scale, b_scale) = if t.cfl_bits > 0 {
        let a_scale = a_res.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        let b_scale = b_res.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        (
            AcQuantJob {
                values: &a_res,
                ..a_job
            },
            AcQuantJob {
                values: &b_res,
                ..b_job
            },
            a_scale,
            b_scale,
        )
    } else {
        (a_job, b_job, a_scale, b_scale)
    };

    let (a_scl_q, a_codes) = quantize_ac_channel(&a_job, a_scale, t);
    let (b_scl_q, b_codes) = if t.b_scale_from_a {
        let shared = dequantize_scale(a_scl_q, b_job.max_scale, b_job.scale_bits, b_job.scale_mu);
        let codes = (0..b_job.values.len())
            .map(|i| {
                quantize_one(
                    &b_job,
                    b_job.values[i],
                    shared * b_job.gain_at(i),
                    b_job.bits_at(i),
                    t.ac_nearest,
                )
            })
            .collect();
        (a_scl_q, codes)
    } else {
        quantize_ac_channel(&b_job, b_scale, t)
    };

    // Encoder-only pixel-domain refinement (off by default). Rebinds the header
    // and AC codes; the decoder is untouched and the byte length is unchanged.
    let mut dc_codes = [l_dc_q, a_dc_q, b_dc_q];
    let mut scale_codes = [l_scl_q, a_scl_q, b_scl_q];
    let mut ac_codes = [l_codes, a_codes, b_codes];
    if t.refine_passes > 0 && t.cfl_bits == 0 {
        if t.refine_grid == 1 {
            // Score on the decoder's natural render grid, against the ideal
            // full-basis downsample of the source.
            let (rw, rh) = crate::aspect::decode_output_size(_aspect, tier);
            let (rw, rh) = (rw as usize, rh as usize);
            let tl = resample_channel_dct(&l_chan, src_w, src_h, rw, rh);
            let ta = resample_channel_dct(&a_chan, src_w, src_h, rw, rh);
            let tb = resample_channel_dct(&b_chan, src_w, src_h, rw, rh);
            let max_cx = l_sel
                .coeffs
                .iter()
                .chain(c_sel.coeffs.iter())
                .map(|&(cx, _)| cx)
                .max()
                .unwrap_or(0);
            let max_cy = l_sel
                .coeffs
                .iter()
                .chain(c_sel.coeffs.iter())
                .map(|&(_, cy)| cy)
                .max()
                .unwrap_or(0);
            let rcos_x = precompute_cos_table(rw, (max_cx + 1).min(rw.max(1)));
            let rcos_y = precompute_cos_table(rh, (max_cy + 1).min(rh.max(1)));
            refine_codes(
                t,
                rw,
                rh,
                &rcos_x,
                &rcos_y,
                [&l_sel, &c_sel, &c_sel],
                [&l_job, &a_job, &b_job],
                [&tl, &ta, &tb],
                (src_w, src_h),
                &mut dc_codes,
                &mut scale_codes,
                &mut ac_codes,
            );
        } else {
            refine_codes(
                t,
                src_w,
                src_h,
                &cos_x,
                &cos_y,
                [&l_sel, &c_sel, &c_sel],
                [&l_job, &a_job, &b_job],
                [&l_chan, &a_chan, &b_chan],
                (src_w, src_h),
                &mut dc_codes,
                &mut scale_codes,
                &mut ac_codes,
            );
        }
    }
    let [l_dc_q, a_dc_q, b_dc_q] = dc_codes;
    let [l_scl_q, a_scl_q, b_scl_q] = scale_codes;
    let [l_codes, a_codes, b_codes] = ac_codes;

    // 9. Allocate the variable-length body and write the descriptor bytes.
    //    Byte 0: version (bits 0..3) | tier (bits 3..6) | hasAlpha (bit 6) |
    //    reserved (bit 7, 0). Byte 1: aspect. (v1, spec §3.1)
    let body_len = body_len_bytes(t, has_alpha, tier);
    let mut hash = vec![0u8; body_len];
    hash[0] = FORMAT_VERSION | (tier << VERSION_BITS) | ((has_alpha as u8) << ALPHA_FLAG_BIT);

    // 10. Aspect + DC + scale prefix. With the shipped widths this is byte 1 =
    //     aspect followed by bits 16..54, byte-for-byte the v1 layout.
    let mut bitpos = 8usize;
    write_bits(&mut hash, bitpos, t.aspect_bits, aspect_code);
    bitpos += t.aspect_bits as usize;
    write_bits(&mut hash, bitpos, t.l_dc_bits, l_dc_q);
    bitpos += t.l_dc_bits as usize;
    write_bits(&mut hash, bitpos, t.a_dc_bits, a_dc_q);
    bitpos += t.a_dc_bits as usize;
    write_bits(&mut hash, bitpos, t.b_dc_bits, b_dc_q);
    bitpos += t.b_dc_bits as usize;
    write_bits(&mut hash, bitpos, t.l_scale_bits, l_scl_q);
    bitpos += t.l_scale_bits as usize;
    write_bits(&mut hash, bitpos, t.a_scale_bits, a_scl_q);
    bitpos += t.a_scale_bits as usize;
    if !t.b_scale_from_a {
        write_bits(&mut hash, bitpos, t.b_scale_bits, b_scl_q);
        bitpos += t.b_scale_bits as usize;
    }
    if t.cfl_bits > 0 {
        write_bits(&mut hash, bitpos, t.cfl_bits, cfl_a_code);
        bitpos += t.cfl_bits as usize;
        write_bits(&mut hash, bitpos, t.cfl_bits, cfl_b_code);
        bitpos += t.cfl_bits as usize;
    }
    debug_assert_eq!(bitpos, prefix_bits(t) as usize);

    // 11. AC payload (every channel's codes were computed above; µ-law by
    //     default, the family/deadzone/band knobs are sweep-only no-ops).
    if has_alpha {
        let alpha_dc_max = ((1u32 << t.alpha_dc_bits) - 1) as f64;
        let alpha_dc_q = round_half_away_from_zero(alpha_dc_max * clamp01(alpha_dc)) as u32;
        write_bits(&mut hash, bitpos, t.alpha_dc_bits, alpha_dc_q);
        bitpos += t.alpha_dc_bits as usize;
        write_bits(&mut hash, bitpos, t.alpha_scale_bits, alpha_scl_q);
        bitpos += t.alpha_scale_bits as usize;
    }

    let c_bits = shape.c_bits;
    if t.interleave && !has_alpha {
        // Embedded order: all three channels merged by frequency priority, so a
        // truncated payload still carries every channel's lowest frequencies.
        for (ch, i) in interleaved_order(&l_sel, &c_sel, shape.l_count(), shape.c_count) {
            let (bits, q) = match ch {
                0 => (l_job.bits_at(i), l_codes[i]),
                1 => (c_bits, a_codes[i]),
                _ => (c_bits, b_codes[i]),
            };
            write_bits(&mut hash, bitpos, bits, q);
            bitpos += bits as usize;
        }
    } else {
        // L AC in selection order across the precision tiers (counts scaled by tier)
        let mut l_idx = 0usize;
        for &(count, bits) in &shape.l_tiers {
            for _ in 0..count {
                write_bits(&mut hash, bitpos, bits, l_codes[l_idx]);
                bitpos += bits as usize;
                l_idx += 1;
            }
        }

        // Chroma AC
        for &q in &a_codes {
            write_bits(&mut hash, bitpos, c_bits, q);
            bitpos += c_bits as usize;
        }
        for &q in &b_codes {
            write_bits(&mut hash, bitpos, c_bits, q);
            bitpos += c_bits as usize;
        }
    }

    if has_alpha {
        for &q in &alpha_codes {
            write_bits(&mut hash, bitpos, shape.alpha_ac_bits, q);
            bitpos += shape.alpha_ac_bits as usize;
        }
    }

    // Exact bit budget; trailing bits to the byte boundary are padding zeros.
    let alpha_prefix = if has_alpha {
        (t.alpha_dc_bits + t.alpha_scale_bits) as usize
    } else {
        0
    };
    debug_assert_eq!(
        bitpos,
        prefix_bits(t) as usize + alpha_prefix + ac_payload_bits(&shape)
    );
    debug_assert_eq!(body_len, bitpos.div_ceil(8));

    hash.into_boxed_slice()
}

/// Scale-normalized AC coefficients per channel group, for quantizer training
/// (sweep-only). Values are `coefficient / scale` in [-1, 1]; a channel whose
/// scale floored to zero contributes nothing.
#[doc(hidden)]
pub struct CoeffDump {
    pub l: Vec<f64>,
    pub a: Vec<f64>,
    pub b: Vec<f64>,
    pub alpha: Vec<f64>,
}

/// Dump the encoder's normalized AC coefficients without quantizing them.
/// Sweep-only: the comparison harness pools these across the tuning corpus to
/// train Lloyd-Max codebooks for [`crate::Companding::Table`].
#[doc(hidden)]
pub fn encode_debug_coefficients(
    w: u32,
    h: u32,
    rgba: &[u8],
    gamut: Gamut,
    t: &Tunables,
    tier: u8,
) -> CoeffDump {
    let analysis = analyze(w, h, rgba, gamut, t, tier);
    let normalize = |(_, ac, scale): (f64, Vec<f64>, f64)| -> Vec<f64> {
        if scale == 0.0 {
            vec![]
        } else {
            ac.iter().map(|v| v / scale).collect()
        }
    };
    CoeffDump {
        l: normalize(analysis.l),
        a: normalize(analysis.a),
        b: normalize(analysis.b),
        alpha: normalize(analysis.alpha),
    }
}

/// Encode an image into a ChromaHash at the default tier. Per spec §10 (v1).
pub fn encode(w: u32, h: u32, rgba: &[u8], gamut: Gamut) -> Box<[u8]> {
    encode_with(w, h, rgba, gamut, &Tunables::DEFAULT, DEFAULT_TIER)
}

/// Encode an image at a given quality `tier` (`0..=MAX_TIER`, ordered by
/// quality). Per spec §10 (v1).
pub fn encode_quality(w: u32, h: u32, rgba: &[u8], gamut: Gamut, tier: u8) -> Box<[u8]> {
    encode_with(w, h, rgba, gamut, &Tunables::DEFAULT, tier)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Self-contained golden vectors copied from `spec/test-vectors/`. The
    // crate's full golden cross-check lives in `tests/spec_vectors.rs`, but that
    // reads the sibling `spec/` dir, which cargo-mutants' isolated per-crate
    // build doesn't stage — so the encode pipeline is pinned here too, in-crate,
    // where the mutation sweep (`cargo mutants`, library tests only) can use it.

    fn solid(w: u32, h: u32, r: u8, g: u8, b: u8, a: u8) -> Vec<u8> {
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for px in rgba.chunks_exact_mut(4) {
            px.copy_from_slice(&[r, g, b, a]);
        }
        rgba
    }

    // ── Encode preconditions ─────────────────────────────────────────────
    //
    // `analyze` guards four preconditions with `assert!`. Nothing pinned them:
    // the crate's only `should_panic` was on the batch path, whose copies in
    // `batch.rs` are textually separate, and every binding pre-validates its own
    // arguments before calling in — so those suites pass whether or not the core
    // check still exists. Verified by deletion: removing `assert!(w >= 1)` left
    // all 156 tests green.
    //
    // cargo-mutants cannot cover this either — it emits no mutant for the inside
    // of an `assert!` — so these are the only thing standing between the
    // preconditions and a silent removal.
    //
    // Each matches on the message, not just on panicking, because a zero
    // dimension also panics further downstream on an out-of-bounds index; a bare
    // `should_panic` would pass for the wrong reason.

    #[test]
    #[should_panic(expected = "width must be >= 1")]
    fn encode_rejects_zero_width() {
        crate::ChromaHash::encode(0, 4, &[], Gamut::Srgb);
    }

    #[test]
    #[should_panic(expected = "height must be >= 1")]
    fn encode_rejects_zero_height() {
        crate::ChromaHash::encode(4, 0, &[], Gamut::Srgb);
    }

    #[test]
    #[should_panic(expected = "rgba length mismatch")]
    fn encode_rejects_a_short_rgba_buffer() {
        // 4x4 needs 64 bytes; hand it 60.
        crate::ChromaHash::encode(4, 4, &[0u8; 60], Gamut::Srgb);
    }

    #[test]
    #[should_panic(expected = "tier must be a valid code")]
    fn encode_rejects_a_reserved_tier() {
        let rgba = solid(4, 4, 128, 64, 32, 255);
        crate::ChromaHash::encode_with_quality(4, 4, &rgba, Gamut::Srgb, MAX_TIER + 1);
    }

    #[test]
    fn select_dc_codes_searches_l_neighbors() {
        // The decode-aware DC search must explore the L code's ±1 neighbours, not
        // only the rounded nominal `l0`. At a near-black, maximally-green-chroma
        // working point the decoder's per-channel gamut clip makes a neighbour
        // strictly better, so the search returns `l0 ± 1`.
        //
        // The `(l0 + dl)` → `(l0 * dl)` mutation collapses the L candidate set to
        // {l0*0, l0*-1→clamp0, l0*1} = {0, l0} over dl ∈ {0,-1,1}, which can reach
        // neither neighbour. Every golden solid happens to have `l0` optimal, so
        // only an input that genuinely selects a neighbour pins this out. These
        // are at the v0.6 working point (max_chroma_b = 0.33); the exact tuples
        // are this build's own search output.
        let t = &Tunables::DEFAULT;
        let l = 14.0_f64 / 60.0; // l0 = round(127 · 0.2333…) = 30
        let l0 = round_half_away_from_zero(127.0 * clamp01(l)) as u32;
        assert_eq!(l0, 30, "fixture assumes nominal L code 30");
        assert!(t.dc_search, "search must be enabled for the ± scan");

        // Maximally-green a (−max_chroma_a) with two nearby b values that tip the
        // clipped decode toward the opposite L neighbours.
        let b_up = (5.0_f64 / 60.0 - 0.5) * 2.0 * 0.33; // -0.275 → picks l0 + 1
        let b_dn = (8.0_f64 / 60.0 - 0.5) * 2.0 * 0.33; // -0.242 → picks l0 - 1
        assert_eq!(
            select_dc_codes(l, -0.35, b_up, t),
            (31, 1, 13),
            "search must reach l0 + 1 = 31"
        );
        assert_eq!(
            select_dc_codes(l, -0.35, b_dn, t),
            (29, 2, 17),
            "search must reach l0 - 1 = 29"
        );
    }

    #[test]
    fn cfl_residual_reaches_the_quantizer() {
        // Chroma-from-luma is a sweep-only tuning arm (`Tunables::DEFAULT
        // .cfl_bits == 0`), so nothing in the shipped format exercises it and
        // the whole branch was untested — the two `AcQuantJob { values: &a_res,
        // .. }` overrides could be deleted with every test still green.
        //
        // Encode a chroma-correlated image both ways. With CfL on, the chroma
        // channels quantize their *residual against luma*, so the bitstream
        // must differ from the same image without it; and the round trip must
        // stay coherent, since decode.rs reads the two gain codes back.
        let mut t = Tunables::DEFAULT;
        t.cfl_bits = 4;
        assert_eq!(
            Tunables::DEFAULT.cfl_bits,
            0,
            "if CfL ever ships, this test's premise changes"
        );

        // A ramp whose chroma tracks its luma — exactly the correlation CfL
        // exists to exploit, so the residual is not the original signal.
        let (w, h) = (8u32, 8u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let v = ((x + y) * 255 / (w + h - 2)) as u8;
                rgba[i] = v;
                rgba[i + 1] = v / 2;
                rgba[i + 2] = 255 - v;
                rgba[i + 3] = 255;
            }
        }

        let with_cfl = encode_with(w, h, &rgba, Gamut::Srgb, &t, DEFAULT_TIER);
        let without = encode_with(w, h, &rgba, Gamut::Srgb, &Tunables::DEFAULT, DEFAULT_TIER);
        assert_ne!(with_cfl, without, "cfl_bits > 0 must change the bitstream");

        // Pinned bytes, not just "different": signalling the two gain codes
        // already makes the bitstream differ, so an inequality alone would still
        // pass if the chroma channels quantized the *original* AC instead of the
        // residual. Only the exact payload distinguishes those two.
        #[rustfmt::skip]
        let expected: [u8; 33] = [
            8, 128, 64, 231, 172, 56, 22, 63, 128, 174, 26, 162, 29, 222, 225, 221, 221,
            221, 221, 221, 221, 93, 18, 68, 146, 166, 81, 3, 36, 137, 212, 182, 109,
        ];
        assert_eq!(&with_cfl[..], &expected[..], "CfL bitstream");

        // And the decoder agrees with the encoder about what those bits mean.
        let (dw, dh, pixels) = crate::decode::decode_with(&with_cfl, &t);
        assert_eq!(pixels.len(), (dw * dh * 4) as usize);
    }

    #[test]
    fn select_dc_codes_never_exceeds_its_field_width() {
        // The search clamps each candidate to `(1 << bits) - 1`. A ceiling one
        // too high would let it return a code that does not fit the field, and
        // `write_bits` would silently truncate it — turning a maximal channel
        // into a zero one. Sweep the working range, including the corners that
        // actually land on the ceiling (21 of a stride-5 sweep of the RGB cube
        // do), and assert every code fits.
        let t = &Tunables::DEFAULT;
        let l_hi = (1u32 << t.l_dc_bits) - 1;
        let a_hi = (1u32 << t.a_dc_bits) - 1;
        let b_hi = (1u32 << t.b_dc_bits) - 1;

        let mut saw_ceiling = false;
        for li in 0..=20 {
            let l = li as f64 / 20.0;
            for ai in 0..=20 {
                let a = (ai as f64 / 20.0 - 0.5) * 2.0 * t.max_chroma_a;
                for bi in 0..=20 {
                    let b = (bi as f64 / 20.0 - 0.5) * 2.0 * t.max_chroma_b;
                    let (lq, aq, bq) = select_dc_codes(l, a, b, t);
                    assert!(lq <= l_hi, "L code {lq} exceeds {l_hi} at ({l}, {a}, {b})");
                    assert!(aq <= a_hi, "a code {aq} exceeds {a_hi} at ({l}, {a}, {b})");
                    assert!(bq <= b_hi, "b code {bq} exceeds {b_hi} at ({l}, {a}, {b})");
                    saw_ceiling |= lq == l_hi || aq == a_hi || bq == b_hi;
                }
            }
        }
        assert!(
            saw_ceiling,
            "the sweep must actually reach a ceiling, or it proves nothing"
        );
    }

    #[test]
    fn encode_golden_solids() {
        // Saturated gamut corners exercise the decode-aware DC code search; the
        // neutral/extreme tones pin the DC and scale quantizers and the header
        // packing. (spec/test-vectors/integration-encode.json)
        // v1: byte 0 = descriptor (8 = version 0, tier 1, opaque), byte 1 =
        // aspect (128 for 1:1), then the 38-bit DC/scale prefix, then AC.
        #[rustfmt::skip]
        let cases: &[(u8, u8, u8, Gamut, [u8; 32])] = &[
            (128, 128, 128, Gamut::Srgb,
                [8, 128, 76, 32, 16, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (255, 0, 0, Gamut::Srgb,
                [8, 128, 208, 116, 22, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (0, 255, 0, Gamut::Srgb,
                [8, 128, 238, 202, 24, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (0, 0, 255, Gamut::Srgb,
                [8, 128, 57, 29, 1, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (255, 255, 255, Gamut::Srgb,
                [8, 128, 127, 32, 16, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (0, 0, 0, Gamut::Srgb,
                [8, 128, 0, 32, 16, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            // Wide-gamut solids: the same pixels map through a different M1
            // matrix (and EOTF for ProPhoto) → distinct OKLAB and DC codes.
            (200, 100, 50, Gamut::DisplayP3,
                [8, 128, 79, 171, 21, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (220, 50, 30, Gamut::ProPhotoRgb,
                [8, 128, 85, 62, 22, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            // Adobe RGB (γ = 2.2 EOTF) and BT.2020 (PQ→Reinhard EOTF) are the two
            // source-gamut transfer arms no other golden vector exercises.
            (200, 100, 50, Gamut::AdobeRgb,
                [8, 128, 211, 171, 21, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (200, 100, 50, Gamut::Bt2020,
                [8, 128, 89, 52, 23, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
        ];
        for &(r, g, b, gamut, expected) in cases {
            let rgba = solid(4, 4, r, g, b, 255);
            assert_eq!(
                encode(4, 4, &rgba, gamut).as_ref(),
                &expected,
                "solid ({r},{g},{b}) {gamut:?}"
            );
        }

        // 1×1 solid (aspect-byte extreme, single-pixel DCT).
        #[rustfmt::skip]
        let one = [8, 128, 78, 233, 20, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109];
        assert_eq!(
            encode(1, 1, &solid(1, 1, 200, 100, 50, 255), Gamut::Srgb).as_ref(),
            &one
        );
    }

    #[test]
    fn encode_golden_gradients() {
        // Non-constant channels drive every AC slot: pins the per-tier write
        // order, the scale factors, and the µ-law quantizer. Inputs and hashes
        // are the gradient_8x4 / gradient_4x8 spec vectors verbatim.
        let g8x4: [u8; 128] = [
            0, 0, 255, 255, 36, 0, 255, 255, 72, 0, 255, 255, 109, 0, 255, 255, 145, 0, 255, 255,
            182, 0, 255, 255, 218, 0, 255, 255, 255, 0, 255, 255, 0, 85, 170, 255, 36, 72, 170,
            255, 72, 60, 170, 255, 109, 48, 170, 255, 145, 36, 170, 255, 182, 24, 170, 255, 218,
            12, 170, 255, 255, 0, 170, 255, 0, 170, 85, 255, 36, 145, 85, 255, 72, 121, 85, 255,
            109, 97, 85, 255, 145, 72, 85, 255, 182, 48, 85, 255, 218, 24, 85, 255, 255, 0, 85,
            255, 0, 255, 0, 255, 36, 218, 0, 255, 72, 182, 0, 255, 109, 145, 0, 255, 145, 109, 0,
            255, 182, 72, 0, 255, 218, 36, 0, 255, 255, 0, 0, 255,
        ];
        #[rustfmt::skip]
        let h8x4 = [8, 159, 72, 166, 141, 120, 245, 128, 131, 53, 165, 222, 225, 157, 225, 221, 221, 221, 221, 221, 29, 58, 78, 219, 182, 109, 19, 168, 105, 219, 182, 109];
        assert_eq!(encode(8, 4, &g8x4, Gamut::Srgb).as_ref(), &h8x4);

        let g4x8: [u8; 128] = [
            0, 0, 255, 255, 85, 0, 255, 255, 170, 0, 255, 255, 255, 0, 255, 255, 0, 36, 218, 255,
            85, 24, 218, 255, 170, 12, 218, 255, 255, 0, 218, 255, 0, 72, 182, 255, 85, 48, 182,
            255, 170, 24, 182, 255, 255, 0, 182, 255, 0, 109, 145, 255, 85, 72, 145, 255, 170, 36,
            145, 255, 255, 0, 145, 255, 0, 145, 109, 255, 85, 97, 109, 255, 170, 48, 109, 255, 255,
            0, 109, 255, 0, 182, 72, 255, 85, 121, 72, 255, 170, 60, 72, 255, 255, 0, 72, 255, 0,
            218, 36, 255, 85, 145, 36, 255, 170, 72, 36, 255, 255, 0, 36, 255, 0, 255, 0, 255, 85,
            170, 0, 255, 170, 85, 0, 255, 255, 0, 0, 255,
        ];
        #[rustfmt::skip]
        let h4x8 = [8, 96, 201, 38, 142, 136, 49, 176, 28, 164, 250, 205, 33, 222, 217, 221, 221, 157, 221, 221, 93, 133, 113, 219, 182, 109, 131, 52, 109, 220, 182, 109];
        assert_eq!(encode(4, 8, &g4x8, Gamut::Srgb).as_ref(), &h4x8);
    }

    #[test]
    fn encode_golden_alpha() {
        // Any α < 255 flips the alpha layout (6×6 L grid + alpha channel). Pins
        // the alpha-DC/scale write and the alpha-weighted average. checkerboard
        // alternates opaque red / transparent blue → average is red at α≈132.
        let cb: [u8; 256] = [
            255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255,
            0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0,
            255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0,
            255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0,
            0, 255, 0, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0,
            255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0,
            255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0,
            255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0,
            0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0,
            255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 255, 0, 0,
            255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 255, 0, 255, 0,
            0, 255,
        ];
        #[rustfmt::skip]
        let expected = [72, 128, 208, 116, 22, 0, 0, 132, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 109, 219, 182, 117, 219, 214, 117, 219, 54, 111, 155, 55, 15];
        assert_eq!(encode(8, 8, &cb, Gamut::Srgb).as_ref(), &expected);
    }

    #[test]
    fn encode_fully_transparent() {
        // Every pixel α = 0 → the alpha-weighted sum is zero, so the average must
        // default to black rather than divide by zero (`avg_alpha > 0.0` guard).
        let hash = encode(4, 4, &[0u8; 4 * 4 * 4], Gamut::Srgb);
        #[rustfmt::skip]
        let expected = [72, 128, 0, 32, 16, 0, 0, 128, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 13];
        assert_eq!(hash.as_ref(), &expected);
    }

    #[test]
    fn encode_alpha_gradient() {
        // A smooth left→right alpha ramp over a solid colour gives the alpha
        // channel a non-zero scale and real AC content — pins the alpha-scale
        // quantizer (the checkerboard's extreme α saturates it to a constant).
        let (w, h) = (8u32, 8u32);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let idx = ((y * w + x) * 4) as usize;
                rgba[idx..idx + 4].copy_from_slice(&[
                    200,
                    60,
                    40,
                    (x as f64 / (w - 1) as f64 * 255.0) as u8,
                ]);
            }
        }
        #[rustfmt::skip]
        let expected = [72, 128, 71, 174, 20, 0, 192, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 109, 219, 134, 109, 219, 180, 109, 219, 182, 109, 219, 182, 13];
        assert_eq!(encode(w, h, &rgba, Gamut::Srgb).as_ref(), &expected);
    }
}
