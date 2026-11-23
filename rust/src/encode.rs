use crate::aspect::encode_aspect;
use crate::bitpack::{AcHistory, AcModels, ArithEncoder, write_bits, write_bits_word};
use crate::color::{linear_rgb_to_oklab, oklab_to_linear_srgb};
use crate::constants::{
    ALPHA_FLAG_BIT, DEFAULT_TIER, FORMAT_VERSION, Gamut, MAX_TIER, Tunables, VERSION_BITS,
    ac_payload_bits, ac_shape, body_len_bytes, is_valid_tier, prefix_bits, shipped_fields,
    tier_index,
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

/// Pixels per tile of the fused colour pass (`Tunables::accel_fused_pixels`).
/// A multiple of every SIMD lane count `simd/` uses (1, 2 and 4).
const FUSED_TILE: usize = 1024;

/// The grid register entry D5's downsampling resamples a `w × h` source to
/// (`Tunables::downsample_edge`), or `None` when the source has at most
/// `edge²` pixels and is encoded at its own resolution. The grid keeps the
/// source's aspect at a pixel count of about `edge²`: each axis is scaled by
/// `s = edge / sqrt(w·h)` and rounded half away from zero, then held to
/// `1..=` its source length, so no axis is ever enlarged. A zero edge is no
/// budget and means no downsampling, and so does a grid that rounds back to
/// the source's own size.
pub(crate) fn downsample_dims(w: usize, h: usize, edge: u32) -> Option<(usize, usize)> {
    if edge == 0 {
        return None;
    }
    // A source within the budget has `s >= 1` (IEEE square root and division
    // are correctly rounded, so `sqrt(w·h) <= edge` whenever `w·h <= edge²`),
    // so both axes clamp back to the source's: the identity, which is no
    // grid. The same filter catches a source just over the budget whose
    // axes round back to its own size, so the budget needs no test of its
    // own.
    let s = f64::from(edge) / ((w as f64) * (h as f64)).sqrt();
    let axis = |n: usize| (round_half_away_from_zero(n as f64 * s) as usize).clamp(1, n);
    Some((axis(w), axis(h))).filter(|&g| g != (w, h))
}

/// The area kernel's weights along one axis of `n` source pixels resampled to
/// `m <= n` cells. In units of `1/(n·m)` of the axis, source pixel `x` spans
/// `[x·m, (x+1)·m)` and cell `i` spans `[i·n, (i+1)·n)`, so every overlap is
/// an exact integer. Entry `x` is `(i, first, second)`: the pixel overlaps
/// cell `i` by `first` and cell `i + 1` by `second` (zero when it lies in one
/// cell; with `m <= n` a pixel never spans more than two). Every cell's
/// overlaps sum to `n`.
pub(crate) fn area_spans(n: usize, m: usize) -> Vec<(usize, u64, u64)> {
    debug_assert!(m >= 1 && m <= n);
    let (n64, m64) = (n as u64, m as u64);
    (0..n as u64)
        .map(|x| {
            let start = x * m64;
            let end = start + m64;
            let cell = start / n64;
            let boundary = (cell + 1) * n64;
            if end <= boundary {
                (cell as usize, m64, 0)
            } else {
                (cell as usize, boundary - start, end - boundary)
            }
        })
        .collect()
}

/// The exact area average of a `w × h` plane on the `dw × dh` grid: each cell
/// is the integral mean of the source pixels it covers, weighted by their
/// fractional coverage ([`area_spans`]). The sum runs a row at a time, each
/// row into its cells along `x` in pixel order, then each row's cells into
/// the grid along `y` in row order, and every cell is divided by its total
/// weight `w·h` last; that order is the kernel's floating-point definition.
pub(crate) fn area_downsample(plane: &[f64], w: usize, h: usize, dw: usize, dh: usize) -> Vec<f64> {
    let xs = area_spans(w, dw);
    let ys = area_spans(h, dh);
    let mut out = vec![0.0f64; dw * dh];
    let mut row = vec![0.0f64; dw];
    for (y, &(cy, fy, sy)) in ys.iter().enumerate() {
        row.fill(0.0);
        let src = &plane[y * w..(y + 1) * w];
        for (&v, &(cx, fx, sx)) in src.iter().zip(xs.iter()) {
            row[cx] += fx as f64 * v;
            if sx > 0 {
                row[cx + 1] += sx as f64 * v;
            }
        }
        accumulate_row(&mut out, &row, dw, cy, fy, sy);
    }
    let total = (w as f64) * (h as f64);
    for v in &mut out {
        *v /= total;
    }
    out
}

/// Add one source row's cells into grid rows `cy` (weight `fy`) and `cy + 1`
/// (weight `sy`, skipped when zero).
fn accumulate_row(out: &mut [f64], row: &[f64], dw: usize, cy: usize, fy: u64, sy: u64) {
    let (f, s) = (fy as f64, sy as f64);
    for (o, &r) in out[cy * dw..(cy + 1) * dw].iter_mut().zip(row) {
        *o += f * r;
    }
    if sy > 0 {
        for (o, &r) in out[(cy + 1) * dw..(cy + 2) * dw].iter_mut().zip(row) {
            *o += s * r;
        }
    }
}

/// Register entry D5's **linear** placement (`Tunables::downsample = 2`):
/// the area average of the source's linear-light RGB, premultiplied by alpha,
/// and of its alpha, straight off the bytes, on the `dw × dh` grid. Fills the
/// four grid planes the shipped colour pass reads: each cell's colour is its
/// premultiplied sum over its alpha sum (zero where the cell is fully
/// transparent, where the composite gives it no weight), and its alpha the
/// area mean of `α/255`. The alpha sums are exact integers, so an opaque cell
/// is exactly `1.0` and the hash's alpha mode is the source's.
#[allow(clippy::too_many_arguments)]
fn area_downsample_linear(
    rgba: &[u8],
    w: usize,
    h: usize,
    dw: usize,
    dh: usize,
    eotf_lut: &[f64; 256],
    lin: [&mut [f64]; 3],
    alpha_out: &mut [f64],
) {
    let xs = area_spans(w, dw);
    let ys = area_spans(h, dh);
    let cells = dw * dh;
    let mut sums = [
        vec![0.0f64; cells],
        vec![0.0f64; cells],
        vec![0.0f64; cells],
    ];
    let mut alpha_sum = vec![0u64; cells];
    let mut rows = [vec![0.0f64; dw], vec![0.0f64; dw], vec![0.0f64; dw]];
    let mut alpha_row = vec![0u64; dw];
    for (y, &(cy, fy, sy)) in ys.iter().enumerate() {
        for r in &mut rows {
            r.fill(0.0);
        }
        alpha_row.fill(0);
        let src = &rgba[y * w * 4..(y + 1) * w * 4];
        for (px, &(cx, fx, sx)) in src.chunks_exact(4).zip(xs.iter()) {
            let a = u64::from(px[3]);
            let af = a as f64;
            for c in 0..3 {
                let p = af * eotf_lut[px[c] as usize];
                rows[c][cx] += fx as f64 * p;
                if sx > 0 {
                    rows[c][cx + 1] += sx as f64 * p;
                }
            }
            alpha_row[cx] += fx * a;
            if sx > 0 {
                alpha_row[cx + 1] += sx * a;
            }
        }
        for c in 0..3 {
            accumulate_row(&mut sums[c], &rows[c], dw, cy, fy, sy);
        }
        for (i, &a) in alpha_row.iter().enumerate() {
            alpha_sum[cy * dw + i] += fy * a;
            if sy > 0 {
                alpha_sum[(cy + 1) * dw + i] += sy * a;
            }
        }
    }
    let full = 255.0 * (w as f64) * (h as f64);
    let [lr, lg, lb] = lin;
    for i in 0..cells {
        let a = alpha_sum[i] as f64;
        alpha_out[i] = a / full;
        let (r, g, b) = if alpha_sum[i] > 0 {
            (sums[0][i] / a, sums[1][i] / a, sums[2][i] / a)
        } else {
            (0.0, 0.0, 0.0)
        };
        lr[i] = r;
        lg[i] = g;
        lb[i] = b;
    }
}

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

    // Register entry D5 (`Tunables::downsample`, off in the shipped
    // encoder): the grid a source over the budget is resampled to. The
    // linear placement resamples before the colour pass, so the pass runs on
    // the grid; the oklab placement resamples the composited planes after it.
    // The hash's aspect is the source's either way (step 5).
    let grid = match t.downsample {
        1 | 2 => downsample_dims(w, h, t.downsample_edge),
        _ => None,
    };
    let linear_grid = grid.filter(|_| t.downsample == 2);
    let oklab_grid = grid.filter(|_| t.downsample == 1);
    let (pw, ph) = linear_grid.unwrap_or((w, h));
    let pixel_count = pw * ph;

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
    //
    // The shipped path allocates, fills and frees these buffers exactly as it
    // always has — the three linear-RGB planes and the alpha plane first, all
    // four living to the end of this function — because it is the reference
    // every lever is timed against, and the allocator is part of what a timing
    // measures. Shortening one lifetime or moving one allocation lets a later
    // buffer reuse freed, already-faulted memory, and that alone moved a
    // 512×512 encode by more than 10% while this was being written. The fused
    // path (`accel_fused_pixels`) allocates none of the four; the alpha plane
    // is rebuilt below only when the image has alpha to transform.
    // The fused pass reads the source bytes, so the linear placement, whose
    // colour pass reads the grid planes instead, takes the unfused path.
    let fused = t.accel_fused_pixels && linear_grid.is_none();
    let unfused = if fused { 0 } else { pixel_count };
    let mut lin_r = vec![0.0f64; unfused];
    let mut lin_g = vec![0.0f64; unfused];
    let mut lin_b = vec![0.0f64; unfused];
    let mut alpha_pixels = vec![0.0f64; unfused];
    if let Some((dw, dh)) = linear_grid {
        area_downsample_linear(
            rgba,
            w,
            h,
            dw,
            dh,
            &eotf_lut,
            [&mut lin_r, &mut lin_g, &mut lin_b],
            &mut alpha_pixels,
        );
        stage!("downsample");
    } else if !fused {
        // Sliced to `pixel_count` for the reason given at `alpha_average`.
        let (r, g, b) = (
            &mut lin_r[..pixel_count],
            &mut lin_g[..pixel_count],
            &mut lin_b[..pixel_count],
        );
        let a = &mut alpha_pixels[..pixel_count];
        for i in 0..pixel_count {
            r[i] = eotf_lut[rgba[i * 4] as usize];
            g[i] = eotf_lut[rgba[i * 4 + 1] as usize];
            b[i] = eotf_lut[rgba[i * 4 + 2] as usize];
            a[i] = rgba[i * 4 + 3] as f64 / 255.0;
        }
        stage!("linearize");
    }

    let mut oklab_pixels = vec![[0.0f64; 3]; pixel_count];
    let mut avg_l = 0.0;
    let mut avg_a = 0.0;
    let mut avg_b = 0.0;
    let mut avg_alpha = 0.0;

    if fused {
        // §12.1 item 6: linearize, OKLAB and the alpha-weighted reduction in
        // one pass over tiles of `FUSED_TILE` pixels, with no full-size
        // linear-RGB or alpha buffer. Byte-identical because (a) each pixel's
        // linear RGB and OKLAB are the same per-pixel functions of the same
        // bytes, and (b) the reduction still visits pixels in flat index
        // order, with the same `alpha` expression. `FUSED_TILE` is a multiple
        // of every SIMD lane count (1, 2, 4), so the pixels
        // `oklab_forward_batch` sends to its scalar tail are the same ones as
        // in one whole-image call — not that it matters to the bytes, which
        // `simd/`'s contract makes lane-count independent.
        //
        // `oklab_pixels` stays full-size: `composite` reads it after the
        // reduction has *finished*, and that barrier cannot be tiled away.
        let mut tr = [0.0f64; FUSED_TILE];
        let mut tg = [0.0f64; FUSED_TILE];
        let mut tb = [0.0f64; FUSED_TILE];
        // A bounded `for`, not a `while` on `start`: a mutated bound in the
        // mutation sweep must fail a test, not hang it.
        for start in (0..pixel_count).step_by(FUSED_TILE) {
            let end = (start + FUSED_TILE).min(pixel_count);
            let n = end - start;
            for k in 0..n {
                let i = start + k;
                tr[k] = eotf_lut[rgba[i * 4] as usize];
                tg[k] = eotf_lut[rgba[i * 4 + 1] as usize];
                tb[k] = eotf_lut[rgba[i * 4 + 2] as usize];
            }
            crate::simd::oklab_forward_batch(
                &tr[..n],
                &tg[..n],
                &tb[..n],
                gamut,
                &mut oklab_pixels[start..end],
            );
            for (i, lab) in oklab_pixels.iter().enumerate().take(end).skip(start) {
                let alpha = rgba[i * 4 + 3] as f64 / 255.0;
                avg_l += alpha * lab[0];
                avg_a += alpha * lab[1];
                avg_b += alpha * lab[2];
                avg_alpha += alpha;
            }
        }
        stage!("fused_pixels");
    } else {
        crate::simd::oklab_forward_batch(&lin_r, &lin_g, &lin_b, gamut, &mut oklab_pixels);
        stage!("oklab_forward");

        // Re-slice to `pixel_count`: the plane's length is now `unfused`, a
        // runtime value, and without the one check here the compiler cannot
        // drop the per-element bounds checks it could when the plane was
        // allocated at `pixel_count` in plain sight — which cost this loop 3×.
        let alpha_plane = &alpha_pixels[..pixel_count];
        for i in 0..pixel_count {
            let alpha = alpha_plane[i];
            let lab = oklab_pixels[i];
            avg_l += alpha * lab[0];
            avg_a += alpha * lab[1];
            avg_b += alpha * lab[2];
            avg_alpha += alpha;
        }
        stage!("alpha_average");
    }

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

    if fused {
        // The fused path kept no alpha buffer: re-derive each pixel's alpha
        // with the identical expression, and build the buffer only for an
        // image whose alpha plane the forward DCT below will transform.
        if has_alpha {
            alpha_pixels = Vec::with_capacity(pixel_count);
        }
        for i in 0..pixel_count {
            let alpha = rgba[i * 4 + 3] as f64 / 255.0;
            l_chan[i] = avg_l * (1.0 - alpha) + alpha * oklab_pixels[i][0];
            a_chan[i] = avg_a * (1.0 - alpha) + alpha * oklab_pixels[i][1];
            b_chan[i] = avg_b * (1.0 - alpha) + alpha * oklab_pixels[i][2];
            if has_alpha {
                alpha_pixels.push(alpha);
            }
        }
    } else {
        for i in 0..pixel_count {
            let alpha = alpha_pixels[i];
            l_chan[i] = avg_l * (1.0 - alpha) + alpha * oklab_pixels[i][0];
            a_chan[i] = avg_a * (1.0 - alpha) + alpha * oklab_pixels[i][1];
            b_chan[i] = avg_b * (1.0 - alpha) + alpha * oklab_pixels[i][2];
        }
    }
    stage!("composite");

    // D5's oklab placement: the composited planes, and the alpha plane when
    // the forward DCT below transforms it, move to the grid here. The
    // composite is linear in each pixel, so this is the area average of
    // exactly the planes the full-resolution transform would read.
    let (gw, gh) = oklab_grid.unwrap_or((pw, ph));
    if let Some((dw, dh)) = oklab_grid {
        l_chan = area_downsample(&l_chan, pw, ph, dw, dh);
        a_chan = area_downsample(&a_chan, pw, ph, dw, dh);
        b_chan = area_downsample(&b_chan, pw, ph, dw, dh);
        if has_alpha {
            alpha_pixels = area_downsample(&alpha_pixels, pw, ph, dw, dh);
        }
        stage!("downsample");
    }

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
    let cos_x = precompute_cos_table(gw, (max_cx + 1).min(gw.max(1)));
    let cos_y = precompute_cos_table(gh, (max_cy + 1).min(gh.max(1)));
    stage!("cos_tables");

    // 7. DCT encode each channel (frequency clamp to source dims built in).
    //
    // `dct_separable` selects the prototype separable transform. It is not
    // byte-identical — see `dct::dct_encode_selected_separable` — and is false
    // in `Tunables::DEFAULT`, so the shipped path is always the direct sum.
    // `accel_dct_lanes` is §12.1 item 3, which *is* byte-identical
    // (`dct::dct_encode_lanes`); the separable prototype wins if both
    // are set, since it is the one that changes what is computed.
    let forward = if t.dct_separable {
        crate::dct::dct_encode_selected_separable
    } else if t.accel_dct_lanes {
        crate::dct::dct_encode_lanes
    } else {
        dct_encode_selected
    };
    let l = forward(&l_chan, gw, gh, &l_sel.coeffs, &cos_x, &cos_y);
    let a = forward(&a_chan, gw, gh, &c_sel.coeffs, &cos_x, &cos_y);
    let b = forward(&b_chan, gw, gh, &c_sel.coeffs, &cos_x, &cos_y);
    let alpha = if has_alpha {
        forward(&alpha_pixels, gw, gh, &alpha_sel.coeffs, &cos_x, &cos_y)
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
        w: gw,
        h: gh,
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
/// The alpha AC scale an alpha scale code stands for: the linear grid the
/// decoder reads (`code / (2^bits − 1) · max_alpha_scale`).
pub(crate) fn dequantize_alpha_scale(code: u32, t: &Tunables) -> f64 {
    code as f64 / ((1u32 << t.alpha_scale_bits) - 1) as f64 * t.max_alpha_scale
}

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
    /// `Tunables::accel_quant_table`'s precomputation, or `None` for the
    /// shipped per-call path. Set by [`AcQuantJob::accelerated`].
    accel: Option<AcAccel>,
}

/// What `spec/PERFORMANCE.md` §12.1 items 1 and 2 compute once per job instead
/// of once per call. Every field is a pure function of the job's widths and
/// companding parameters, which no caller changes after construction — the
/// CfL rebind (`AcQuantJob { values, ..job }`) replaces the values and keeps
/// the tiers, so the table it carries over still describes it.
struct AcAccel {
    /// `bits_at(i)` for every selection index the job holds.
    bits: Vec<u32>,
    /// Offset of index `i`'s width's block in `deq`.
    base: Vec<usize>,
    /// One `dequantize_table` block per distinct width, concatenated. Keyed on
    /// `(bits, index)` through `base`, never on the index alone: a tiered job
    /// (`LAYOUT_C`'s 6-bit and 5-bit L bands) has two grids.
    deq: Vec<f64>,
    /// `portable_ln(1 + mu)`, the µ-law denominator.
    ln_1p_mu: f64,
}

impl AcQuantJob<'_> {
    /// Attach the §12.1 items 1–2 precomputation when `on`. The values it
    /// returns are the ones the per-call path computes; only when they are
    /// computed moves.
    fn accelerated(mut self, on: bool) -> Self {
        if !on {
            self.accel = None;
            return self;
        }
        let bits: Vec<u32> = (0..self.values.len()).map(|i| self.bits_at(i)).collect();
        let mut widths: Vec<(u32, usize)> = Vec::new();
        let mut deq = Vec::new();
        let base = bits
            .iter()
            .map(|&b| match widths.iter().find(|&&(w, _)| w == b) {
                Some(&(_, off)) => off,
                None => {
                    let off = deq.len();
                    deq.extend(crate::mulaw::dequantize_table(
                        b,
                        self.family,
                        self.mu,
                        self.table,
                    ));
                    widths.push((b, off));
                    off
                }
            })
            .collect();
        self.accel = Some(AcAccel {
            bits,
            base,
            deq,
            ln_1p_mu: crate::math_utils::portable_ln(1.0 + self.mu),
        });
        self
    }

    /// Bit width at selection index `i`: the precomputed one where there is
    /// one, the tier walk otherwise. Every caller indexes within the job's
    /// values, which is the range the precomputation covers.
    fn width(&self, i: usize) -> u32 {
        match &self.accel {
            Some(a) => a.bits[i],
            None => self.bits_at(i),
        }
    }

    /// `compand_dequantize(q, bits_at(i), …)`, from the table when there is one.
    fn deq(&self, i: usize, q: u32) -> f64 {
        match &self.accel {
            Some(a) => a.deq[a.base[i] + q as usize],
            None => compand_dequantize(q, self.bits_at(i), self.family, self.mu, self.table),
        }
    }

    /// `compand_quantize(normalized, bits_at(i), …)`, with `ln(1 + mu)`
    /// hoisted when the job is accelerated.
    fn quant(&self, i: usize, normalized: f64) -> u32 {
        let bits = self.width(i);
        match &self.accel {
            Some(a) => crate::mulaw::compand_quantize_hoisted(
                normalized,
                bits,
                self.family,
                self.mu,
                a.ln_1p_mu,
                self.table,
                self.deadzone,
            ),
            None => compand_quantize(
                normalized,
                bits,
                self.family,
                self.mu,
                self.table,
                self.deadzone,
            ),
        }
    }

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
fn quantize_one(job: &AcQuantJob, i: usize, value: f64, scale: f64, nearest: bool) -> u32 {
    let normalized = if scale == 0.0 { 0.0 } else { value / scale };
    let q = job.quant(i, normalized);
    let deadzoned = job.deadzone > 0.0 && normalized.abs() < job.deadzone;
    if !nearest || scale == 0.0 || deadzoned {
        return q;
    }
    let max_idx = (1u32 << job.width(i)) - 2;
    let mut best = q;
    let mut best_err = f64::INFINITY;
    for d in [0i64, -1, 1, -2, 2] {
        let cand = (q as i64 + d).clamp(0, max_idx as i64) as u32;
        let rec = job.deq(i, cand) * scale;
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
        let s = scale * job.gain_at(i);
        let q = quantize_one(job, i, v, s, nearest);
        let rec = job.deq(i, q) * s;
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
        codes.push(quantize_one(
            job,
            i,
            v,
            norm_scale * job.gain_at(i),
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
///
/// `stop_at` is §12.1 item 5 (`Tunables::accel_sse_early_exit`): with
/// `Some(bound)`, the sum is abandoned at the end of the first row where it
/// has reached `bound`, and that partial sum is returned. Every caller asks
/// only "is this strictly below `bound`?", and the answer cannot change once
/// the partial sum has reached it: each term is a sum of squares, so it is
/// `>= 0` or NaN, and adding a non-negative number never decreases an IEEE
/// sum under round-to-nearest. A partial sum `>= bound` therefore means the
/// full one is `>= bound` too, or NaN — and NaN is not below `bound` either.
/// A candidate that could win is never cut short, so the value a caller keeps
/// is always a complete sum.
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
    stop_at: Option<f64>,
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
        if let Some(bound) = stop_at {
            if acc >= bound {
                return acc;
            }
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
        .map(|(i, &q)| job.deq(i, q) * scale * job.gain_at(i))
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
    // The (alpha mode, tier code) cell's index into the per-cell window
    // arrays.
    (ai, ti): (usize, usize),
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
        window_weights(sels[0], t.w_min_l[ai][ti], t.w_exp_l[ai][ti]),
        window_weights(sels[1], t.w_min_c[ai][ti], t.w_exp_c[ai][ti]),
        window_weights(sels[2], t.w_min_c[ai][ti], t.w_exp_c[ai][ti]),
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
        j.deq(i, code) * scale * j.gain_at(i) * windows[ch][i]
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
                                i,
                                jobs[ch].values[i],
                                s * jobs[ch].gain_at(i),
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
                    let stop_at = t
                        .accel_sse_early_exit
                        .then(|| chosen.as_ref().map_or(best, |&(_, be)| be));
                    let e = sse_with_delta(
                        &obj, &recon[0], &recon[1], &recon[2], ch, w, h, 0, 0, delta, cos_x, cos_y,
                        stop_at,
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
                let bits = jobs[ch].width(i);
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
                        let stop_at = t
                            .accel_sse_early_exit
                            .then(|| chosen.as_ref().map_or(best, |&(_, be)| be));
                        let e = sse_with_delta(
                            &obj, &recon[0], &recon[1], &recon[2], ch, w, h, cx, cy, dval, cos_x,
                            cos_y, stop_at,
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

/// Steps of the coded stream's fit search: at step `k`, each channel keeps
/// its first `ceil(count · k / FIT_STEPS)` codes and codes the rest as zero.
const FIT_STEPS: usize = 256;

/// The exact-zero centre code of a `bits`-wide odd-level field.
fn center_code(bits: u32) -> u32 {
    (1u32 << (bits - 1)) - 1
}

/// `codes` at fit step `k`: every index at or past
/// `ceil(padded · k / FIT_STEPS)` replaced by its centre code, `width(i)`
/// wide. `padded` is the channel's full count in the stream, which the cut is
/// a fraction of; the coded stream and the adaptive mode's reconstruction
/// both cut through this one function.
fn cut_codes(codes: &[u32], padded: usize, k: usize, width: &dyn Fn(usize) -> u32) -> Vec<u32> {
    let kept = (padded * k).div_ceil(FIT_STEPS);
    codes
        .iter()
        .enumerate()
        .map(|(i, &q)| if i < kept { q } else { center_code(width(i)) })
        .collect()
}

/// Every AC code of one hash, in the order the coded stream carries them
/// (register D1, [`Tunables::ac_coder`]): luma with its per-index widths,
/// then chroma a and b, then alpha.
pub(crate) struct CodedAc<'a> {
    pub l: (&'a [u32], &'a [u32]),
    pub a: &'a [u32],
    pub b: &'a [u32],
    pub c_bits: u32,
    pub alpha: &'a [u32],
    pub alpha_bits: u32,
}

impl CodedAc<'_> {
    /// Code the stream at fit step `k` (`0..=FIT_STEPS`).
    fn code(&self, k: usize) -> (Vec<u8>, usize) {
        let mut enc = ArithEncoder::new();
        let mut models = AcModels::new();
        let (l, widths) = self.l;
        let mut hist = AcHistory::default();
        let l = cut_codes(l, l.len(), k, &|i| widths[i]);
        for (i, (&q, &w)) in l.iter().zip(widths).enumerate() {
            models.encode(&mut enc, &mut hist, 0, i, w, q);
        }
        for (group, codes, w) in [
            (1, self.a, self.c_bits),
            (1, self.b, self.c_bits),
            (2, self.alpha, self.alpha_bits),
        ] {
            let mut hist = AcHistory::default();
            for (i, &q) in cut_codes(codes, codes.len(), k, &|_| w).iter().enumerate() {
                models.encode(&mut enc, &mut hist, group, i, w, q);
            }
        }
        enc.finish()
    }

    /// The stream at a fit step whose coded length is at most `budget` bits,
    /// with the bytes, the bit count and the step: every code when that
    /// fits, and otherwise the step bisection between step 0 (every code
    /// zero) and [`FIT_STEPS`] settles on, which fits while the step above
    /// it does not. Only a step that was coded and measured to fit is ever
    /// returned. The coded length is not strictly monotone in the step (the
    /// models adapt to what they see), so this is a boundary the bisection
    /// found, not a proof that no larger step fits.
    ///
    /// # Panics
    ///
    /// If even the all-zero stream exceeds `budget`: the layout bounds more
    /// codes than the hash can carry, which is a sweep-configuration error.
    pub(crate) fn fit(&self, budget: usize) -> (Vec<u8>, usize, usize) {
        let full = self.code(FIT_STEPS);
        if full.1 <= budget {
            return (full.0, full.1, FIT_STEPS);
        }
        let mut best = self.code(0);
        assert!(
            best.1 <= budget,
            "ac_coder: the all-zero stream takes {} bits of a {budget}-bit budget; the layout bounds too many codes",
            best.1
        );
        // FIT_STEPS is 2^8, so eight halvings leave `hi = lo + 1`. A bounded
        // loop, so a mutated bound ends with a wrong step rather than none.
        let (mut lo, mut hi) = (0usize, FIT_STEPS);
        for _ in 0..FIT_STEPS.trailing_zeros() {
            let mid = (lo + hi) / 2;
            let trial = self.code(mid);
            if trial.1 <= budget {
                lo = mid;
                best = trial;
            } else {
                hi = mid;
            }
        }
        (best.0, best.1, lo)
    }
}

/// Encode an image into a ChromaHash body with explicit tunables and quality
/// `tier`. Per spec §10 (v1). Returns the variable-length encoded bytes
/// (the default tier = 32 bytes; each higher code roughly quadruples the length).
pub fn encode_with(w: u32, h: u32, rgba: &[u8], gamut: Gamut, t: &Tunables, tier: u8) -> Box<[u8]> {
    if t.ac_coder[tier_index(tier)] == 2 {
        return encode_adaptive(w, h, rgba, gamut, t, tier);
    }
    encode_parts(w, h, rgba, gamut, t, tier, 0, false).0
}

/// What one encode's AC codes reconstruct, per channel (L, a, b, alpha), in
/// selection order: the unquantized coefficients and their dequantized
/// values as the decoder will read them (after any coded-stream cut).
struct AcRecon {
    truth: [Vec<f64>; 4],
    recon: [Vec<f64>; 4],
}

/// Register D1's adaptive mode (`ac_coder = 2`): encode the coded stream (in
/// all but the first payload bit) and the shipped fixed-width fields, and
/// keep the one whose AC codes reconstruct the coefficients with the smaller
/// pixel-domain squared error. The first payload bit says which (1 = coded).
///
/// The error is Parseval's: a coefficient error `δ` at `(cx, cy)` costs
/// `δ² · (cx > 0 ? 2 : 1) · (cy > 0 ? 2 : 1)` per pixel under the decoder's
/// basis, summed over every coefficient either encode selects (a coefficient
/// one leaves out costs its whole value), over L, a, b and alpha alike. DC
/// and every coefficient neither selects cost both the same, so they drop out.
/// The decision is the encoder's own, from the source alone.
///
/// # Panics
///
/// With CfL or a shared b scale on, which change what the chroma codes
/// reconstruct, or where the shipped layout leaves no padding bit for the
/// flag (codes 0 and 1).
fn encode_adaptive(w: u32, h: u32, rgba: &[u8], gamut: Gamut, t: &Tunables, tier: u8) -> Box<[u8]> {
    assert!(
        t.cfl_bits == 0 && !t.b_scale_from_a,
        "ac_coder 2 decides on the AC reconstruction, which CfL and a shared b scale change"
    );
    // `encode_parts` codes the stream for any non-zero `ac_coder`, so `t`
    // itself is the coded half.
    let fixed = shipped_fields(t);
    let (hc, rc) = encode_parts(w, h, rgba, gamut, t, tier, 1, true);
    let (hf, rf) = encode_parts(w, h, rgba, gamut, &fixed, tier, 0, true);
    let (rc, rf) = (rc.expect("asked for"), rf.expect("asked for"));
    let has_alpha = hf[0] >> ALPHA_FLAG_BIT & 1 == 1;
    let start = prefix_bits(t) as usize
        + if has_alpha {
            (t.alpha_dc_bits + t.alpha_scale_bits) as usize
        } else {
            0
        };
    let fixed_end = start + ac_payload_bits(&ac_shape(&fixed, has_alpha, tier));
    assert!(
        fixed_end < hf.len() * 8,
        "ac_coder 2: the shipped layout at code {tier} leaves no bit for the flag"
    );

    let (_, aspect) = quantize_aspect(encode_aspect(w, h), t.aspect_bits);
    let order = SelectionOrder::new(aspect, tier, t.aniso_oblique, t.sel_hv);
    // Each channel's truth over every coefficient either encode selects: the
    // longer of the two, since both are prefixes of one selection order.
    let truth: [&[f64]; 4] = core::array::from_fn(|ch| {
        if rc.truth[ch].len() >= rf.truth[ch].len() {
            rc.truth[ch].as_slice()
        } else {
            rf.truth[ch].as_slice()
        }
    });
    // On a tie the shipped fields stand.
    let use_coded = ac_sse(&order, truth, &rc.recon) < ac_sse(&order, truth, &rf.recon);
    let src = if use_coded { &hc } else { &hf };

    // The chosen hash's prefix, the flag, then its payload one bit later. The
    // payload's last bit is always zero (padding, or the bit the coded stream
    // was told to leave free), so it is the one dropped, and the length check
    // is what makes dropping it, rather than keeping it, observable.
    let total = src.len() * 8;
    let bits: Vec<u32> = (0..start)
        .map(|b| read_bit(src, b))
        .chain(core::iter::once(use_coded as u32))
        .chain((start..total - 1).map(|b| read_bit(src, b)))
        .collect();
    assert_eq!(
        bits.len(),
        total,
        "the flag moves the payload, it adds no bit"
    );
    let mut out = vec![0u8; src.len()];
    for (i, &b) in bits.iter().enumerate() {
        write_bits(&mut out, i, 1, b);
    }
    debug_assert!(use_coded || (fixed_end..src.len() * 8).all(|b| read_bit(src, b) == 0));
    out.into_boxed_slice()
}

/// The pixel-domain cost of a unit coefficient error at `(cx, cy)` under the
/// decoder's basis (`2` per non-zero axis frequency, `1` per zero one), up to
/// a factor common to every coefficient.
fn parseval_weight(cx: usize, cy: usize) -> f64 {
    let axis = |f: usize| if f == 0 { 1.0 } else { 2.0 };
    axis(cx) * axis(cy)
}

/// The adaptive mode's error: the Parseval-weighted squared difference of
/// each channel's `truth` and `recon`, index by index in selection order, a
/// missing reconstruction counting as zero.
fn ac_sse(order: &SelectionOrder, truth: [&[f64]; 4], recon: &[Vec<f64>; 4]) -> f64 {
    let mut sse = 0.0;
    for (t, r) in truth.iter().zip(recon) {
        let coeffs = order.take(t.len()).coeffs;
        for (i, (&c, &(cx, cy))) in t.iter().zip(&coeffs).enumerate() {
            let d = c - r.get(i).copied().unwrap_or(0.0);
            sse += parseval_weight(cx, cy) * d * d;
        }
    }
    sse
}

fn read_bit(bytes: &[u8], bit: usize) -> u32 {
    (bytes[bit / 8] >> (bit % 8)) as u32 & 1
}

/// [`encode_with`] for one fixed or coded mode, reserving `reserve` bits at
/// the head of a coded stream's budget (the adaptive mode's flag), and
/// returning the AC reconstruction when `want_recon` asks for it.
#[allow(clippy::too_many_arguments)]
fn encode_parts(
    w: u32,
    h: u32,
    rgba: &[u8],
    gamut: Gamut,
    t: &Tunables,
    tier: u8,
    reserve: usize,
    want_recon: bool,
) -> (Box<[u8]>, Option<AcRecon>) {
    let Analysis {
        has_alpha,
        aspect,
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
    stage!("dc_search");

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
        accel: None,
    }
    .accelerated(t.accel_quant_table);
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
        accel: None,
    }
    .accelerated(t.accel_quant_table);
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
        accel: None,
    }
    .accelerated(t.accel_quant_table);
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
        accel: None,
    }
    .accelerated(t.accel_quant_table);
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
                    i,
                    b_job.values[i],
                    shared * b_job.gain_at(i),
                    t.ac_nearest,
                )
            })
            .collect();
        (a_scl_q, codes)
    } else {
        quantize_ac_channel(&b_job, b_scale, t)
    };
    // Every AC scale and code search: the jobs, `scale_fit`'s scale search and
    // `ac_nearest`'s neighbourhood, the alpha plane, and CfL when it is on —
    // where §12.1 items 1 and 2 act.
    stage!("ac_quantize");

    // Encoder-only pixel-domain refinement (off by default). Rebinds the header
    // and AC codes; the decoder is untouched and the byte length is unchanged.
    let mut dc_codes = [l_dc_q, a_dc_q, b_dc_q];
    let mut scale_codes = [l_scl_q, a_scl_q, b_scl_q];
    let mut ac_codes = [l_codes, a_codes, b_codes];
    if t.refine_passes > 0 && t.cfl_bits == 0 {
        if t.refine_grid == 1 {
            // Score on the decoder's natural render grid, against the ideal
            // full-basis downsample of the source.
            let (rw, rh) = crate::aspect::decode_output_size(aspect, tier);
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
                crate::constants::cell_index(has_alpha, tier),
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
                crate::constants::cell_index(has_alpha, tier),
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
    // Near zero in the shipped build, where `refine_passes` is 0; §12.1 item 5
    // acts here when it is not.
    stage!("refine");

    // 9. Allocate the variable-length body and write the descriptor bytes.
    //    Byte 0: version (bits 0..3) | tier (bits 3..6) | hasAlpha (bit 6) |
    //    reserved (bit 7, 0). Byte 1: aspect. (v1, spec §3.1)
    let body_len = body_len_bytes(t, has_alpha, tier);
    let mut hash = vec![0u8; body_len];
    // §12.1 item 7 (`accel_word_bitpack`): the same bits, a word at a time.
    // Both writers only OR into a zeroed buffer.
    let put: fn(&mut [u8], usize, u32, u32) = if t.accel_word_bitpack {
        write_bits_word
    } else {
        write_bits
    };
    hash[0] = FORMAT_VERSION | (tier << VERSION_BITS) | ((has_alpha as u8) << ALPHA_FLAG_BIT);

    // 10. Aspect + DC + scale prefix. With the shipped widths this is byte 1 =
    //     aspect followed by bits 16..54, byte-for-byte the v1 layout.
    let mut bitpos = 8usize;
    put(&mut hash, bitpos, t.aspect_bits, aspect_code);
    bitpos += t.aspect_bits as usize;
    put(&mut hash, bitpos, t.l_dc_bits, l_dc_q);
    bitpos += t.l_dc_bits as usize;
    put(&mut hash, bitpos, t.a_dc_bits, a_dc_q);
    bitpos += t.a_dc_bits as usize;
    put(&mut hash, bitpos, t.b_dc_bits, b_dc_q);
    bitpos += t.b_dc_bits as usize;
    put(&mut hash, bitpos, t.l_scale_bits, l_scl_q);
    bitpos += t.l_scale_bits as usize;
    put(&mut hash, bitpos, t.a_scale_bits, a_scl_q);
    bitpos += t.a_scale_bits as usize;
    if !t.b_scale_from_a {
        put(&mut hash, bitpos, t.b_scale_bits, b_scl_q);
        bitpos += t.b_scale_bits as usize;
    }
    if t.cfl_bits > 0 {
        put(&mut hash, bitpos, t.cfl_bits, cfl_a_code);
        bitpos += t.cfl_bits as usize;
        put(&mut hash, bitpos, t.cfl_bits, cfl_b_code);
        bitpos += t.cfl_bits as usize;
    }
    debug_assert_eq!(bitpos, prefix_bits(t) as usize);

    // 11. AC payload (every channel's codes were computed above; µ-law by
    //     default, the family/deadzone/band knobs are sweep-only no-ops).
    if has_alpha {
        let alpha_dc_max = ((1u32 << t.alpha_dc_bits) - 1) as f64;
        let alpha_dc_q = round_half_away_from_zero(alpha_dc_max * clamp01(alpha_dc)) as u32;
        put(&mut hash, bitpos, t.alpha_dc_bits, alpha_dc_q);
        bitpos += t.alpha_dc_bits as usize;
        put(&mut hash, bitpos, t.alpha_scale_bits, alpha_scl_q);
        bitpos += t.alpha_scale_bits as usize;
    }

    let c_bits = shape.c_bits;
    // The AC reconstruction at fit step `k` (every code kept at FIT_STEPS):
    // each channel's codes past `ceil(padded count · k / FIT_STEPS)` read as
    // the zero centre, as the coded stream carries them.
    let recon_at = |k: usize| -> AcRecon {
        let l = cut_codes(&l_codes, shape.l_count(), k, &|i| l_job.bits_at(i));
        let a = cut_codes(&a_codes, shape.c_count, k, &|_| c_bits);
        let b = cut_codes(&b_codes, shape.c_count, k, &|_| c_bits);
        let alpha_n = if has_alpha { shape.alpha_ac_count } else { 0 };
        let al = cut_codes(&alpha_codes, alpha_n, k, &|_| shape.alpha_ac_bits);
        let alpha_scale = dequantize_alpha_scale(alpha_scl_q, t);
        AcRecon {
            truth: [l_ac.clone(), a_ac.clone(), b_ac.clone(), alpha_ac.clone()],
            recon: [
                decoded_luma_ac(&l_job, l_scl_q, &l),
                decoded_luma_ac(&a_job, a_scl_q, &a),
                decoded_luma_ac(&b_job, b_scl_q, &b),
                al.iter()
                    .map(|&q| {
                        compand_dequantize(
                            q,
                            shape.alpha_ac_bits,
                            t.compand_alpha,
                            t.mu_alpha,
                            &t.table_alpha,
                        ) * alpha_scale
                    })
                    .collect(),
            ],
        }
    };
    if t.ac_coder[tier_index(tier)] != 0 {
        // Register D1: one arithmetic-coded stream in place of the fixed
        // fields, filling the rest of the shipped-size hash.
        // The stream carries exactly the counts the decoder derives from the
        // shape. A selection the grid cannot fill (an extreme aspect at a
        // large count) is shorter, and its missing codes are coded as zero.
        let l_widths: Vec<u32> = (0..shape.l_count()).map(|i| l_job.bits_at(i)).collect();
        let pad = |codes: &[u32], n: usize, bits: &dyn Fn(usize) -> u32| -> Vec<u32> {
            (0..n)
                .map(|i| codes.get(i).copied().unwrap_or(center_code(bits(i))))
                .collect()
        };
        let l_all = pad(&l_codes, shape.l_count(), &|i| l_widths[i]);
        let a_all = pad(&a_codes, shape.c_count, &|_| c_bits);
        let b_all = pad(&b_codes, shape.c_count, &|_| c_bits);
        let alpha_n = if has_alpha { shape.alpha_ac_count } else { 0 };
        let alpha_all = pad(&alpha_codes, alpha_n, &|_| shape.alpha_ac_bits);
        let streams = CodedAc {
            l: (&l_all, &l_widths),
            a: &a_all,
            b: &b_all,
            c_bits,
            alpha: &alpha_all,
            alpha_bits: shape.alpha_ac_bits,
        };
        let (bytes, nbits, step) = streams.fit(body_len * 8 - bitpos - reserve);
        for i in 0..nbits {
            put(&mut hash, bitpos + i, 1, read_bit(&bytes, i));
        }
        stage!("pack");
        return (hash.into_boxed_slice(), want_recon.then(|| recon_at(step)));
    }
    if t.interleave {
        // Embedded order (register D2): every channel merged by frequency
        // priority, alpha's AC codes as a fourth channel in alpha mode, so a
        // truncated payload still carries every channel's lowest frequencies.
        let alpha_count = if has_alpha { shape.alpha_ac_count } else { 0 };
        let alpha_sel =
            SelectionOrder::new(aspect, tier, t.aniso_oblique, t.sel_hv).take(alpha_count);
        let channels = [
            (&l_sel, shape.l_count()),
            (&c_sel, shape.c_count),
            (&c_sel, shape.c_count),
            (&alpha_sel, alpha_count),
        ];
        for (ch, i) in interleaved_order(&channels) {
            let (bits, q) = match ch {
                0 => (l_job.bits_at(i), l_codes[i]),
                1 => (c_bits, a_codes[i]),
                2 => (c_bits, b_codes[i]),
                _ => (shape.alpha_ac_bits, alpha_codes[i]),
            };
            put(&mut hash, bitpos, bits, q);
            bitpos += bits as usize;
        }
    } else {
        // L AC in selection order across the precision tiers (counts scaled by tier)
        let mut l_idx = 0usize;
        for &(count, bits) in &shape.l_tiers {
            for _ in 0..count {
                put(&mut hash, bitpos, bits, l_codes[l_idx]);
                bitpos += bits as usize;
                l_idx += 1;
            }
        }

        // Chroma AC
        for &q in &a_codes {
            put(&mut hash, bitpos, c_bits, q);
            bitpos += c_bits as usize;
        }
        for &q in &b_codes {
            put(&mut hash, bitpos, c_bits, q);
            bitpos += c_bits as usize;
        }
    }

    if has_alpha && !t.interleave {
        for &q in &alpha_codes {
            put(&mut hash, bitpos, shape.alpha_ac_bits, q);
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
    // The body allocation and every bit written into it — §12.1 item 7.
    stage!("pack");

    (
        hash.into_boxed_slice(),
        want_recon.then(|| recon_at(FIT_STEPS)),
    )
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
    use crate::bitpack::read_bits;

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
            9, 128, 64, 231, 172, 56, 22, 63, 128, 174, 26, 162, 29, 222, 225, 221, 221,
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
        // v2: byte 0 = descriptor (9 = version 1, tier 1, opaque), byte 1 =
        // aspect (128 for 1:1), then the 38-bit DC/scale prefix, then AC.
        #[rustfmt::skip]
        let cases: &[(u8, u8, u8, Gamut, [u8; 32])] = &[
            (128, 128, 128, Gamut::Srgb,
                [9, 128, 76, 32, 16, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (255, 0, 0, Gamut::Srgb,
                [9, 128, 208, 116, 22, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (0, 255, 0, Gamut::Srgb,
                [9, 128, 238, 202, 24, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (0, 0, 255, Gamut::Srgb,
                [9, 128, 57, 29, 1, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (255, 255, 255, Gamut::Srgb,
                [9, 128, 127, 32, 16, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (0, 0, 0, Gamut::Srgb,
                [9, 128, 0, 32, 16, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            // Wide-gamut solids: the same pixels map through a different M1
            // matrix (and EOTF for ProPhoto) → distinct OKLAB and DC codes.
            (200, 100, 50, Gamut::DisplayP3,
                [9, 128, 79, 171, 21, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (220, 50, 30, Gamut::ProPhotoRgb,
                [9, 128, 85, 62, 22, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            // Adobe RGB (γ = 2.2 EOTF) and BT.2020 (PQ→Reinhard EOTF) are the two
            // source-gamut transfer arms no other golden vector exercises.
            (200, 100, 50, Gamut::AdobeRgb,
                [9, 128, 211, 171, 21, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
            (200, 100, 50, Gamut::Bt2020,
                [9, 128, 89, 52, 23, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109]),
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
        let one = [9, 128, 78, 233, 20, 0, 192, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 221, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109];
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
        let h8x4 = [9, 159, 72, 166, 141, 120, 245, 128, 131, 53, 165, 222, 225, 157, 225, 221, 221, 221, 221, 221, 29, 58, 78, 219, 182, 109, 19, 168, 105, 219, 182, 109];
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
        let h4x8 = [9, 96, 201, 38, 142, 136, 49, 176, 28, 164, 250, 205, 33, 222, 217, 221, 221, 157, 221, 221, 93, 133, 113, 219, 182, 109, 131, 52, 109, 220, 182, 109];
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
        let expected = [73, 128, 208, 116, 22, 0, 0, 132, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 109, 219, 182, 117, 219, 214, 117, 219, 54, 111, 155, 55, 15];
        assert_eq!(encode(8, 8, &cb, Gamut::Srgb).as_ref(), &expected);
    }

    #[test]
    fn encode_fully_transparent() {
        // Every pixel α = 0 → the alpha-weighted sum is zero, so the average must
        // default to black rather than divide by zero (`avg_alpha > 0.0` guard).
        let hash = encode(4, 4, &[0u8; 4 * 4 * 4], Gamut::Srgb);
        #[rustfmt::skip]
        let expected = [73, 128, 0, 32, 16, 0, 0, 128, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 109, 219, 182, 109, 219, 182, 109, 219, 182, 109, 219, 182, 13];
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
        let expected = [73, 128, 71, 174, 20, 0, 192, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 187, 109, 219, 134, 109, 219, 180, 109, 219, 182, 109, 219, 182, 13];
        assert_eq!(encode(w, h, &rgba, Gamut::Srgb).as_ref(), &expected);
    }

    // ── PERFORMANCE.md §12.1's byte-identical levers ─────────────────────
    //
    // `tests/accel_levers.rs` holds every lever to the spec vectors and a wider
    // sweep, but it reads the sibling `spec/` dir, so the mutation sweep cannot
    // run it. These are its in-crate half: every encoder lever against the
    // shipped path, on inputs chosen to reach each lever's own code — two
    // fused-pass tiles, translucent pixels, a tiered-width luma job, the
    // refinement the early exit lives in.

    /// Each encoder-side lever's flag.
    const ENCODE_LEVERS: [fn(&mut Tunables); 5] = [
        |t| t.accel_quant_table = true,
        |t| t.accel_dct_lanes = true,
        |t| t.accel_sse_early_exit = true,
        |t| t.accel_fused_pixels = true,
        |t| t.accel_word_bitpack = true,
    ];

    /// Deterministic noise over a gradient, optionally with an alpha ramp that
    /// includes fully transparent pixels.
    fn lever_image(w: u32, h: u32, alpha: bool, seed: u32) -> Vec<u8> {
        let mut s = seed.wrapping_mul(0x9e37_79b9) | 1;
        let (w, h) = (w as usize, h as usize);
        let mut rgba = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let n = (s >> 26) as usize;
                let i = (y * w + x) * 4;
                rgba[i] = ((x * 255 / w.max(2)) + n) as u8;
                rgba[i + 1] = ((y * 255 / h.max(2)) + n * 2) as u8;
                rgba[i + 2] = (s >> 20) as u8;
                rgba[i + 3] = if !alpha {
                    255
                } else if (x + y) % 5 == 0 {
                    0
                } else {
                    ((x + 2 * y) * 255 / (w + 2 * h)) as u8
                };
            }
        }
        rgba
    }

    // ── Register D1: the entropy-coded AC payload (`ac_coder`) ───────────

    fn coded(t: Tunables) -> Tunables {
        Tunables {
            ac_coder: [1; crate::constants::TIER_CODES],
            ..t
        }
    }

    /// A smooth image whose shipped-layout codes fit the coded stream whole:
    /// the coded hash then carries exactly the fixed-width hash's codes, so
    /// it decodes to exactly the same pixels, at the shipped length.
    #[test]
    fn coded_ac_carries_the_shipped_codes_when_they_fit() {
        let (w, h) = (24, 16);
        for alpha in [false, true] {
            let mut rgba = lever_image(w, h, alpha, 3);
            for px in rgba.chunks_exact_mut(4) {
                // Strip the noise: a gradient's spectrum is sparse.
                px[2] = px[0] / 2 + px[1] / 2;
            }
            for tier in 0..=MAX_TIER {
                // The fixed-width length rows with the coder off: under the
                // defaults code 3 is already coded, and would compare the
                // coded stream with itself.
                let d = shipped_fields(&Tunables::DEFAULT);
                let fixed = encode_with(w, h, &rgba, Gamut::Srgb, &d, tier);
                let hash = encode_with(w, h, &rgba, Gamut::Srgb, &coded(d), tier);
                assert_eq!(hash.len(), fixed.len(), "tier {tier} alpha {alpha}");
                assert_eq!(hash.len(), body_len_bytes(&coded(d), alpha, tier));
                // The prefix (descriptor, aspect, DC, scales, alpha DC/scale)
                // is the fixed hash's, bit for bit.
                let p = prefix_bits(&d) as usize + if alpha { 9 } else { 0 };
                for bit in 0..p {
                    assert_eq!(read_bits(&hash, bit, 1), read_bits(&fixed, bit, 1));
                }
                assert_eq!(
                    crate::decode::decode_with(&hash, &coded(d)),
                    crate::decode::decode_with(&fixed, &d),
                    "tier {tier} alpha {alpha}"
                );
            }
        }
    }

    /// A layout bounding far more codes than the bytes hold: the encoder
    /// zeroes the tail until the stream fits, and the length never moves.
    #[test]
    fn coded_ac_fits_an_oversized_layout_into_the_shipped_length() {
        let (w, h) = (40, 30);
        for alpha in [false, true] {
            let rgba = lever_image(w, h, alpha, 9);
            let mut t = coded(Tunables::DEFAULT);
            t.layout_upper.l_tiers = [(60, 6), (0, 6)];
            t.layout_upper.c_count = 24;
            t.layout_upper.c_bits = 5;
            t.layout_upper.la_tiers = [(50, 5), (0, 5)];
            t.layout_upper.a_count = 60;
            t.layout_upper.a_bits = 4;
            // Codes 3 and 4 read their own rows: bound them the same way.
            t.layout_t3 = t.layout_upper;
            t.layout_t4 = t.layout_upper;
            for tier in 2..=MAX_TIER {
                let hash = encode_with(w, h, &rgba, Gamut::Srgb, &t, tier);
                let shipped = body_len_bytes(&Tunables::DEFAULT, alpha, tier);
                assert_eq!(hash.len(), shipped, "tier {tier} alpha {alpha}");
                let (dw, dh, px) = crate::decode::decode_with(&hash, &t);
                assert_eq!(px.len(), (dw * dh * 4) as usize);
                assert_eq!(
                    (dw, dh),
                    crate::aspect::decode_output_size(encode_aspect(w, h), tier)
                );
            }
        }
    }

    /// At an extreme aspect the candidate grid holds fewer frequencies than a
    /// large bound asks for. The stream still carries the shape's full count
    /// (the missing codes as zero), so encoder and decoder stay in step.
    #[test]
    fn coded_ac_pads_a_selection_the_grid_cannot_fill() {
        let (w, h) = (200, 10);
        let rgba: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                [(x * 255 / w) as u8, (y * 25) as u8, 90, 255]
            })
            .collect();
        let bound = |base: usize| {
            let mut t = coded(Tunables::DEFAULT);
            t.layout_upper.l_tiers = [(base, 5), (0, 5)];
            t
        };
        let order = SelectionOrder::new(encode_aspect(w, h), 2, 1.2, 0.15);
        let fill = order.take(1000).coeffs.len();
        assert!(fill < 256, "the grid must run short of both bounds: {fill}");
        // Two bounds past the grid select the same frequencies, so with every
        // code fitting they must render the same picture. Had the encoder
        // coded only the selection while the decoder read the shape's count,
        // each would read a different number of chroma codes as luma.
        let (h64, h80) = (
            encode_with(w, h, &rgba, Gamut::Srgb, &bound(64), 2),
            encode_with(w, h, &rgba, Gamut::Srgb, &bound(80), 2),
        );
        assert_eq!(h64.len(), body_len_bytes(&Tunables::DEFAULT, false, 2));
        assert_eq!(h80.len(), h64.len());
        assert_eq!(
            crate::decode::decode_with(&h64, &bound(64)),
            crate::decode::decode_with(&h80, &bound(80))
        );
    }

    /// The adaptive mode's flag bit, which follows the prefix.
    fn adaptive_flag(hash: &[u8], t: &Tunables, alpha: bool) -> u32 {
        let start = prefix_bits(t) as usize + if alpha { 9 } else { 0 };
        read_bits(hash, start, 1)
    }

    /// `ac_coder = 2` keeps the fixed fields where the coded stream would
    /// have to cut codes the fixed fields carry whole, and then decodes to
    /// exactly the shipped pixels; it keeps the coded stream where that
    /// carries more, and the flag says which.
    #[test]
    fn the_adaptive_mode_signals_the_encode_it_keeps() {
        let (w, h) = (40, 30);
        // The adaptive mode chooses between the coded stream and the
        // fixed-width rows, so it is read against the length rows at every
        // upper code, with the coder off: the rows D1 measured it on.
        let v1 = shipped_fields(&Tunables::DEFAULT);
        let mut cut = 0;
        for alpha in [false, true] {
            for tier in 2..=MAX_TIER {
                // White noise at the shipped bound: the coded stream overflows
                // and cuts, so the fixed fields reconstruct better.
                let mut s = 0x2545_f491u32;
                let noisy: Vec<u8> = (0..w * h * 4)
                    .map(|i| {
                        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                        if i % 4 == 3 && !alpha {
                            255
                        } else {
                            (s >> 24) as u8
                        }
                    })
                    .collect();
                let t = Tunables {
                    ac_coder: [2; crate::constants::TIER_CODES],
                    ..v1
                };
                let coded = encode_with(w, h, &noisy, Gamut::Srgb, &coded(v1), tier);
                let fixed = encode_with(w, h, &noisy, Gamut::Srgb, &v1, tier);
                let hash = encode_with(w, h, &noisy, Gamut::Srgb, &t, tier);
                assert_eq!(hash.len(), fixed.len());
                if crate::decode::decode_with(&coded, &super::tests::coded(v1))
                    != crate::decode::decode_with(&fixed, &v1)
                {
                    cut += 1;
                    assert_eq!(
                        adaptive_flag(&hash, &t, alpha),
                        0,
                        "tier {tier} alpha {alpha}"
                    );
                    assert_eq!(
                        crate::decode::decode_with(&hash, &t),
                        crate::decode::decode_with(&fixed, &v1)
                    );
                }

                // A gradient under twice the bound: every code fits, and the
                // extra coefficients only reduce the error.
                let mut smooth = lever_image(w, h, alpha, 21);
                for px in smooth.chunks_exact_mut(4) {
                    px[0] = px[1] / 2;
                    px[2] = px[1] / 3;
                }
                let mut big = t;
                big.layout_upper.l_tiers = [(52, 5), (0, 5)];
                big.layout_upper.c_count = 18;
                big.layout_upper.la_tiers = [(44, 4), (0, 4)];
                big.layout_upper.a_count = 56;
                big.layout_t3 = big.layout_upper;
                big.layout_t4 = big.layout_upper;
                let hash = encode_with(w, h, &smooth, Gamut::Srgb, &big, tier);
                assert_eq!(
                    adaptive_flag(&hash, &big, alpha),
                    1,
                    "tier {tier} alpha {alpha}"
                );
                // Behind the flag is the coded stream one bit short of the
                // hash, and the decoder drops the flag at the right bit.
                let plain = Tunables {
                    ac_coder: [1; crate::constants::TIER_CODES],
                    ..big
                };
                let (inner, _) = encode_parts(w, h, &smooth, Gamut::Srgb, &plain, tier, 1, false);
                assert_eq!(
                    crate::decode::decode_with(&hash, &big),
                    crate::decode::decode_with(&inner, &plain),
                    "tier {tier} alpha {alpha}"
                );
                let fixed = encode_with(w, h, &smooth, Gamut::Srgb, &v1, tier);
                assert_ne!(
                    crate::decode::decode_with(&hash, &big),
                    crate::decode::decode_with(&fixed, &v1)
                );
            }
        }
        // The fixed branch must have been reached, or half the test is idle.
        assert!(cut > 0);
    }

    /// `ac_coder` at twice the shipped upper-tier counts, in both alpha
    /// modes, in mode `mode`: the bound D1's sweep calls `x2`.
    fn bound_x2(mode: u32) -> Tunables {
        let mut t = Tunables {
            ac_coder: [mode; crate::constants::TIER_CODES],
            ..Tunables::DEFAULT
        };
        t.layout_upper.l_tiers = [(52, 5), (0, 5)];
        t.layout_upper.c_count = 18;
        t.layout_upper.la_tiers = [(44, 4), (0, 4)];
        t.layout_upper.ca_count = 6;
        t.layout_upper.a_count = 56;
        t
    }

    /// Coded and adaptive hashes are wire bytes too. A round trip cannot pin
    /// them: a fit search that cut one step too early, a pad that coded a
    /// different count, or an adaptive choice that flipped would each still
    /// decode its own output. These hold one code-2 hash per mode and alpha
    /// mode, on an image whose stream has to be cut to fit.
    #[test]
    fn coded_hashes_are_bit_exact() {
        let opaque = lever_image(40, 30, false, 9);
        let alpha = lever_image(40, 30, true, 9);
        let got =
            |rgba: &[u8], mode: u32| encode_with(40, 30, rgba, Gamut::Srgb, &bound_x2(mode), 2);
        assert_eq!(got(&opaque, 1).as_ref(), &GOLDEN_CODED_OPAQUE[..]);
        assert_eq!(got(&alpha, 1).as_ref(), &GOLDEN_CODED_ALPHA[..]);
        assert_eq!(got(&opaque, 2).as_ref(), &GOLDEN_ADAPTIVE_OPAQUE[..]);
    }

    const GOLDEN_CODED_OPAQUE: [u8; 108] = [
        17, 141, 209, 32, 208, 112, 202, 223, 81, 245, 173, 93, 31, 130, 12, 220, 38, 27, 46, 66,
        65, 227, 85, 77, 1, 72, 124, 14, 248, 210, 247, 161, 35, 221, 74, 216, 239, 178, 96, 73,
        227, 254, 131, 164, 103, 79, 11, 179, 242, 215, 200, 208, 175, 141, 90, 72, 212, 181, 228,
        246, 76, 131, 40, 97, 240, 54, 102, 250, 210, 23, 184, 93, 18, 161, 171, 197, 231, 224,
        234, 142, 232, 52, 3, 116, 227, 146, 41, 239, 124, 121, 251, 204, 88, 186, 215, 255, 39,
        121, 40, 65, 58, 126, 175, 222, 239, 39, 41, 7,
    ];
    const GOLDEN_CODED_ALPHA: [u8; 103] = [
        81, 141, 212, 96, 80, 32, 4, 155, 47, 95, 253, 101, 99, 131, 27, 62, 131, 96, 108, 71, 176,
        118, 201, 105, 36, 110, 219, 73, 36, 223, 161, 102, 202, 97, 49, 107, 182, 126, 134, 94,
        77, 153, 143, 125, 139, 67, 126, 254, 236, 29, 107, 64, 181, 171, 110, 209, 39, 138, 82,
        127, 75, 183, 105, 229, 102, 180, 227, 172, 39, 195, 69, 94, 213, 100, 230, 75, 116, 156,
        50, 236, 179, 122, 217, 3, 167, 234, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    // The same image's coded stream one bit later, behind a set flag: byte 6
    // keeps bits 48..54 of the prefix and gains bit 54 = 1.
    const GOLDEN_ADAPTIVE_OPAQUE: [u8; 108] = [
        17, 141, 209, 32, 208, 112, 202, 191, 163, 234, 91, 187, 62, 4, 25, 184, 77, 54, 92, 132,
        130, 198, 171, 154, 2, 144, 248, 28, 240, 165, 239, 67, 71, 186, 149, 176, 223, 101, 193,
        146, 198, 253, 7, 73, 207, 158, 22, 102, 229, 175, 145, 161, 95, 27, 181, 144, 168, 107,
        201, 237, 153, 6, 81, 194, 224, 109, 204, 244, 165, 47, 112, 187, 36, 66, 87, 139, 207,
        193, 213, 29, 209, 105, 6, 232, 198, 37, 83, 222, 249, 242, 246, 153, 177, 116, 175, 255,
        79, 242, 80, 130, 116, 252, 94, 189, 223, 79, 82, 14,
    ];

    /// The fixed alternative and the coded length keep every knob but the
    /// layouts and the coder: a hash coded under a wider prefix field is the
    /// length the shipped layout gives *that* prefix, and an adaptive hash
    /// that keeps the fixed fields decodes them under the caller's own
    /// quantizer, not the default one.
    #[test]
    fn the_shipped_fields_keep_every_other_knob() {
        let wide = Tunables {
            l_scale_bits: 9,
            ..bound_x2(1)
        };
        let fixed_wide = Tunables {
            l_scale_bits: 9,
            ..Tunables::DEFAULT
        };
        for tier in 2..=MAX_TIER {
            assert_eq!(
                body_len_bytes(&wide, false, tier),
                body_len_bytes(&fixed_wide, false, tier)
            );
            assert_ne!(
                body_len_bytes(&wide, false, tier),
                body_len_bytes(&Tunables::DEFAULT, false, tier),
                "a 3-bit wider field moves the length at code {tier}"
            );
        }
        // Codes 0 and 1 read their own rows: a coded hash with those rows
        // resized is still the shipped length.
        let mut rows = coded(Tunables::DEFAULT);
        rows.layout.l_tiers = [(40, 4), (0, 4)];
        rows.layout_compact.l_tiers = [(30, 4), (0, 4)];
        for alpha in [false, true] {
            for tier in [0, DEFAULT_TIER] {
                assert_eq!(
                    body_len_bytes(&rows, alpha, tier),
                    body_len_bytes(&Tunables::DEFAULT, alpha, tier)
                );
            }
        }
        // White noise at the shipped bound keeps the fixed fields (see the
        // adaptive test above), here under a non-default luma µ.
        let mut s = 0x2545_f491u32;
        let noisy: Vec<u8> = (0..40 * 30 * 4)
            .map(|i| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                if i % 4 == 3 { 255 } else { (s >> 24) as u8 }
            })
            .collect();
        // A 9-bit luma scale field also moves the flag to bit 57, where its
        // byte (7) and its offset in the byte (1) differ; at the shipped
        // widths both are 6 (bit 54) or 7 (bit 63), so a decoder reading the
        // wrong one of the two would pass every other test.
        let t = Tunables {
            ac_coder: [2; crate::constants::TIER_CODES],
            mu_l: 9.0,
            l_scale_bits: 9,
            ..Tunables::DEFAULT
        };
        let plain = Tunables {
            ac_coder: [0; crate::constants::TIER_CODES],
            ..t
        };
        let hash = encode_with(40, 30, &noisy, Gamut::Srgb, &t, 2);
        assert_eq!(adaptive_flag(&hash, &t, false), 0);
        let fixed = encode_with(40, 30, &noisy, Gamut::Srgb, &plain, 2);
        assert_eq!(
            crate::decode::decode_with(&hash, &t),
            crate::decode::decode_with(&fixed, &plain)
        );
        // And the coded branch at the same field width: between the two, a
        // flag read from the wrong bit is wrong for one of them whatever
        // that bit holds.
        // The image the adaptive test above shows choosing the coded stream.
        let mut smooth = lever_image(40, 30, false, 21);
        for px in smooth.chunks_exact_mut(4) {
            px[0] = px[1] / 2;
            px[2] = px[1] / 3;
        }
        let wide = Tunables {
            mu_l: 9.0,
            l_scale_bits: 9,
            ..bound_x2(2)
        };
        let hash = encode_with(40, 30, &smooth, Gamut::Srgb, &wide, 2);
        assert_eq!(adaptive_flag(&hash, &wide, false), 1);
        let coded_wide = Tunables {
            ac_coder: [1; crate::constants::TIER_CODES],
            ..wide
        };
        let (inner, _) = encode_parts(40, 30, &smooth, Gamut::Srgb, &coded_wide, 2, 1, false);
        assert_eq!(
            crate::decode::decode_with(&hash, &wide),
            crate::decode::decode_with(&inner, &coded_wide)
        );
    }

    #[test]
    #[should_panic(expected = "leaves no bit for the flag")]
    fn the_adaptive_mode_refuses_a_tier_with_no_spare_bit() {
        let rgba = lever_image(8, 8, false, 1);
        let t = Tunables {
            ac_coder: [2; crate::constants::TIER_CODES],
            ..Tunables::DEFAULT
        };
        encode_with(8, 8, &rgba, Gamut::Srgb, &t, DEFAULT_TIER);
    }

    #[test]
    fn the_fit_search_settles_on_a_step_that_fits_below_one_that_does_not() {
        let codes: Vec<u32> = (0..200u32).map(|i| (i * 7919) % 31).collect();
        let widths = vec![5u32; codes.len()];
        let s = CodedAc {
            l: (&codes, &widths),
            a: &[],
            b: &[],
            c_bits: 3,
            alpha: &[],
            alpha_bits: 3,
        };
        let full = s.code(FIT_STEPS).1;
        let zero = s.code(0).1;
        assert!(zero < full / 10, "{zero} vs {full}");
        // Whole budget: everything kept.
        let (bytes, n, k) = s.fit(full);
        assert_eq!((bytes, n, k), (s.code(FIT_STEPS).0, full, FIT_STEPS));
        // A budget between: the returned step's stream, which fits, and the
        // next step does not.
        let budget = full / 2;
        let (bytes, n, k) = s.fit(budget);
        assert!(n <= budget);
        assert_eq!(s.code(k), (bytes, n));
        assert!(k > 0 && k < FIT_STEPS);
        assert!(s.code(k + 1).1 > budget, "step {k} is not a boundary");

        // Step `k` is exactly the full stream of the codes with every index
        // at or past `ceil(count · k / FIT_STEPS)` set to the centre, in
        // every channel.
        let chroma: Vec<u32> = (0..60u32).map(|i| (i * 31) % 15).collect();
        let s = CodedAc {
            l: (&codes, &widths),
            a: &chroma,
            b: &chroma,
            c_bits: 4,
            alpha: &chroma,
            alpha_bits: 4,
        };
        for k in [1, 77, 128, 255] {
            let cut = |c: &[u32], center: u32| -> Vec<u32> {
                let kept = (c.len() * k).div_ceil(FIT_STEPS);
                c.iter()
                    .enumerate()
                    .map(|(i, &q)| if i < kept { q } else { center })
                    .collect()
            };
            let (l, ch) = (cut(&codes, 15), cut(&chroma, 7));
            let by_hand = CodedAc {
                l: (&l, &widths),
                a: &ch,
                b: &ch,
                c_bits: 4,
                alpha: &ch,
                alpha_bits: 4,
            };
            assert_eq!(s.code(k), by_hand.code(FIT_STEPS), "step {k}");
        }
    }

    /// The adaptive mode's error, on numbers small enough to check by hand:
    /// each channel's differences squared, weighted by the frequency at that
    /// selection index, a missing reconstruction counting as zero.
    #[test]
    fn the_adaptive_error_is_the_weighted_squared_difference() {
        let order = SelectionOrder::new(128, 2, 1.2, 0.15);
        let coeffs = order.take(3).coeffs;
        let w: Vec<f64> = coeffs.iter().map(|&(x, y)| parseval_weight(x, y)).collect();
        let truth: [&[f64]; 4] = [&[1.0, 2.0, 3.0], &[0.5], &[], &[-1.0, 1.0]];
        let recon = [vec![1.0, 1.5], vec![0.0], vec![], vec![-1.0, 0.0]];
        let want = w[1] * 0.25 + w[2] * 9.0 + w[0] * 0.25 + w[1] * 1.0;
        assert_eq!(ac_sse(&order, truth, &recon), want);
        assert_eq!(
            ac_sse(
                &order,
                truth,
                &[vec![1.0, 2.0, 3.0], vec![0.5], vec![], vec![-1.0, 1.0]]
            ),
            0.0
        );
    }

    /// A tie keeps the shipped fields: a smooth image at the shipped bound
    /// codes every shipped code, so both encodes reconstruct the same.
    #[test]
    fn the_adaptive_mode_keeps_the_fixed_fields_on_a_tie() {
        let (w, h) = (24, 16);
        let rgba: Vec<u8> = (0..w * h)
            .flat_map(|i| [(i % w * 10) as u8, (i / w * 15) as u8, 80, 255])
            .collect();
        let t = Tunables {
            ac_coder: [2; crate::constants::TIER_CODES],
            ..Tunables::DEFAULT
        };
        for tier in 2..=MAX_TIER {
            let hash = encode_with(w as u32, h as u32, &rgba, Gamut::Srgb, &t, tier);
            assert_eq!(adaptive_flag(&hash, &t, false), 0, "tier {tier}");
        }
    }

    #[test]
    fn parseval_weights_count_each_nonzero_axis_twice() {
        let got = [(0, 0), (1, 0), (0, 3), (2, 5), (7, 0)].map(|(x, y)| parseval_weight(x, y));
        assert_eq!(got, [1.0, 2.0, 2.0, 4.0, 2.0]);
    }

    #[test]
    #[should_panic(expected = "the layout bounds too many codes")]
    fn the_fit_search_refuses_a_layout_whose_zero_stream_overflows() {
        let codes = vec![15u32; 5000];
        let widths = vec![5u32; codes.len()];
        let s = CodedAc {
            l: (&codes, &widths),
            a: &[],
            b: &[],
            c_bits: 3,
            alpha: &[],
            alpha_bits: 3,
        };
        s.fit(8);
    }

    /// Every encoder lever alone and all together must give `base`'s bytes.
    fn assert_levers_reproduce(base: Tunables, w: u32, h: u32, rgba: &[u8], tier: u8) {
        let reference = encode_with(w, h, rgba, Gamut::Srgb, &base, tier);
        let mut all = base;
        for (k, set) in ENCODE_LEVERS.iter().enumerate() {
            let mut t = base;
            set(&mut t);
            set(&mut all);
            assert_eq!(
                encode_with(w, h, rgba, Gamut::Srgb, &t, tier),
                reference,
                "lever {k}, {w}x{h} tier {tier}, base {base:?}"
            );
        }
        assert_eq!(
            encode_with(w, h, rgba, Gamut::Srgb, &all, tier),
            reference,
            "all levers, {w}x{h} tier {tier}"
        );
    }

    #[test]
    fn encoder_levers_reproduce_the_shipped_bytes() {
        let d = Tunables::DEFAULT;
        let bases = [
            d,
            // Two bit widths in one luma job from tier 2 up (§12.1 item 1).
            Tunables {
                layout_upper: crate::constants::LAYOUT_C,
                ..d
            },
            Tunables {
                alpha_ac_fit: true,
                ..d
            },
            Tunables {
                cfl_bits: 5,
                b_scale_from_a: true,
                ..d
            },
        ];
        // 40×30 and 35×33 are more than one `FUSED_TILE`; 1×19 is a strip.
        let images = [
            (7u32, 5u32, false, 0u8..=2u8),
            (6, 6, true, 0..=2),
            (1, 19, true, 0..=1),
            (40, 30, false, 0..=1),
            (35, 33, true, 0..=1),
        ];
        for (bi, base) in bases.into_iter().enumerate() {
            for (ii, (w, h, alpha, tiers)) in images.iter().cloned().enumerate() {
                let rgba = lever_image(w, h, alpha, (bi * 7 + ii) as u32);
                for tier in tiers {
                    assert_levers_reproduce(base, w, h, &rgba, tier);
                }
            }
        }
    }

    #[test]
    fn early_exit_reproduces_the_refined_bytes() {
        // §12.1 item 5 changes nothing unless the refinement runs.
        let base = Tunables {
            refine_passes: 2,
            refine_delta: 2,
            refine_dc: true,
            refine_scale: true,
            ..Tunables::DEFAULT
        };
        for (w, h, alpha) in [(9u32, 7u32, false), (8, 8, true), (1, 12, false)] {
            let rgba = lever_image(w, h, alpha, w * 31 + h);
            for tier in 0..=1 {
                assert_levers_reproduce(base, w, h, &rgba, tier);
            }
        }
    }

    #[test]
    fn early_exit_stops_only_at_the_bound() {
        // The scorer itself: the full sum with no bound, the full sum when the
        // bound is never reached, and a partial sum no smaller than the bound
        // when it is.
        let (w, h) = (6usize, 5usize);
        let l: Vec<f64> = (0..w * h).map(|p| (p % 7) as f64 / 7.0).collect();
        let a: Vec<f64> = (0..w * h).map(|p| (p % 3) as f64 * 0.02 - 0.02).collect();
        let b: Vec<f64> = (0..w * h).map(|p| (p % 4) as f64 * -0.01).collect();
        let obj = PixelObjective::new(0, 1.0, 1.0, &l, &a, &b);
        let cos_x = precompute_cos_table(w, 3);
        let cos_y = precompute_cos_table(h, 3);
        let score = |stop: Option<f64>| {
            sse_with_delta(&obj, &l, &a, &b, 0, w, h, 2, 1, 0.3, &cos_x, &cos_y, stop)
        };
        let full = score(None);
        assert!(full > 0.0);
        assert_eq!(score(Some(f64::INFINITY)), full);
        assert_eq!(score(Some(full * 2.0)), full);
        let partial = score(Some(full / 4.0));
        assert!(partial >= full / 4.0, "{partial} stopped below its bound");
        assert!(partial < full, "{partial} did not stop early");
    }

    #[test]
    fn quant_table_attaches_only_when_on_and_agrees_per_width() {
        // A tiered job: indices 0..8 at 6 bits, 8..22 at 5 — LAYOUT_C's L row.
        let values: Vec<f64> = (0..22).map(|i| (i as f64 * 0.37).sin() * 0.2).collect();
        let tiers = [(8usize, 6u32), (14, 5)];
        let job = |on: bool| {
            AcQuantJob {
                values: &values,
                tiers: &tiers,
                split: 11,
                band_gain: 1.0,
                max_scale: 0.5,
                code_max: 63,
                scale_bits: 6,
                scale_mu: 0.0,
                family: crate::constants::Companding::MuLaw,
                mu: 5.0,
                table: &crate::constants::QuantTable::EMPTY,
                deadzone: 0.0,
                accel: None,
            }
            .accelerated(on)
        };
        let (plain, fast) = (job(false), job(true));
        assert!(plain.accel.is_none());
        assert!(fast.accel.is_some());
        for i in 0..values.len() {
            let bits = plain.bits_at(i);
            assert_eq!(fast.width(i), bits, "index {i}");
            for q in 0..(1u32 << bits) - 1 {
                assert_eq!(
                    fast.deq(i, q).to_bits(),
                    plain.deq(i, q).to_bits(),
                    "index {i} code {q}"
                );
            }
            for v in [-1.0, -0.4, -0.01, 0.0, 0.03, 0.5, 1.0] {
                assert_eq!(fast.quant(i, v), plain.quant(i, v), "index {i} value {v}");
            }
        }
    }

    #[test]
    fn band_gain_refine_cfl_and_shared_scale_goldens() {
        // The lever tests above compare two paths through the same lines, so a
        // defect on a line both share passes them. These pin the bytes of the
        // lines the levers re-plumbed — every `· gain_at(i)`, the refinement's
        // dequantized value and window, the CfL predictor, the shared chroma
        // scale — under Tunables where each one matters (every shipped gain
        // and window is 1.0, where `·` and `/` agree). The bytes were produced
        // by `master`'s encoder before any lever existed, and this branch's
        // reproduces them.
        let (w, h) = (11u32, 9u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h as usize {
            for x in 0..w as usize {
                rgba.extend_from_slice(&[
                    ((x * 37 + y * 11) % 256) as u8,
                    ((x * x * 3 + y * 29) % 256) as u8,
                    ((x * y * 5 + 17) % 256) as u8,
                    255,
                ]);
            }
        }
        let banded = Tunables {
            band_gain_l: 1.4,
            band_gain_c: 0.7,
            ..Tunables::DEFAULT
        };
        let cases: [(Tunables, u8, &[u8]); 5] = [
            (
                banded,
                1,
                &[
                    9, 137, 77, 94, 50, 121, 210, 196, 144, 20, 9, 90, 110, 233, 217, 217, 225, 25,
                    26, 97, 157, 26, 182, 96, 88, 53, 43, 217, 68, 152, 198, 148,
                ],
            ),
            (
                banded,
                2,
                &[
                    17, 137, 77, 94, 242, 152, 140, 1, 228, 140, 101, 70, 108, 53, 171, 235, 216,
                    107, 112, 58, 38, 87, 137, 8, 178, 248, 108, 148, 145, 54, 246, 152, 106, 49,
                    66, 249, 166, 107, 80, 193, 245, 92, 115, 111, 58, 249, 158, 123, 241, 173,
                    215, 222, 123, 239, 193, 247, 232, 123, 242, 185, 7, 223, 123, 111, 61, 246,
                    218, 123, 242, 189, 247, 30, 177, 228, 106, 36, 229, 150, 210, 233, 25, 13,
                    206, 217, 38, 15, 22, 14, 209, 82, 175, 178, 196, 0, 22, 234, 176, 234, 169,
                    50, 209, 32, 36, 92, 105, 237, 34, 50,
                ],
            ),
            (
                // A low band split, so the luma gain reaches the indices the
                // CfL predictor reads (chroma is the shorter set).
                Tunables {
                    cfl_bits: 5,
                    band_split: 0.1,
                    ..banded
                },
                1,
                &[
                    9, 137, 77, 94, 242, 184, 74, 155, 3, 67, 98, 36, 104, 185, 165, 103, 103, 135,
                    103, 104, 131, 116, 106, 72, 98, 98, 71, 205, 174, 131, 128, 26, 211, 2,
                ],
            ),
            (
                Tunables {
                    refine_passes: 1,
                    refine_scale: true,
                    refine_dc: true,
                    w_min_l: [[0.6; crate::constants::TIER_CODES]; 2],
                    w_exp_l: [[2; crate::constants::TIER_CODES]; 2],
                    ..banded
                },
                1,
                &[
                    9, 137, 76, 30, 82, 137, 16, 197, 144, 216, 8, 158, 46, 173, 221, 217, 221, 25,
                    86, 157, 157, 152, 149, 96, 216, 52, 43, 201, 68, 168, 198, 148,
                ],
            ),
            (
                Tunables {
                    b_scale_from_a: true,
                    ..banded
                },
                1,
                &[
                    9, 137, 77, 94, 50, 121, 38, 134, 164, 72, 208, 114, 75, 207, 206, 14, 207,
                    208, 8, 235, 212, 176, 5, 195, 170, 89, 201, 38, 2, 181, 166, 4,
                ],
            ),
        ];
        for (k, (t, tier, expected)) in cases.iter().enumerate() {
            assert_eq!(
                encode_with(w, h, &rgba, Gamut::Srgb, t, *tier).as_ref(),
                *expected,
                "case {k}"
            );
            // And every lever on reproduces them too.
            assert_levers_reproduce(*t, w, h, &rgba, *tier);
        }
    }

    // ── Header-field quantizers at sweep widths ──────────────────────────
    //
    // The shipped widths (8-bit aspect, linear scale grid) take the early
    // return or the linear branch, so the goldens above never reach the
    // coarse-aspect or µ-law-scale arithmetic. These pin it directly.

    #[test]
    fn aspect_quantizer_is_the_identity_at_eight_bits_and_wider() {
        for byte in 0..=255u8 {
            for bits in [8u32, 9] {
                assert_eq!(quantize_aspect(byte, bits), (byte as u32, byte));
                assert_eq!(dequantize_aspect(byte as u32, bits), byte);
            }
        }
    }

    #[test]
    fn aspect_quantizer_rounds_onto_the_symmetric_grid() {
        // At `bits` < 8 the grid is 128 + k·2^(8−bits) for codes
        // k + 2^(bits−1) in [0, 2^bits), clamped to [0, 255]; the code is
        // round_half_away_from_zero((byte − 128) / step) + centre, clamped.
        #[rustfmt::skip]
        let cases: &[(u32, u8, u32, u8)] = &[
            // bits = 4: step 16, centre 8.
            (4, 0, 0, 0), (4, 1, 0, 0), (4, 8, 0, 0), (4, 9, 1, 16),
            (4, 96, 6, 96), (4, 120, 7, 112), (4, 121, 8, 128), (4, 128, 8, 128),
            (4, 135, 8, 128), (4, 136, 9, 144), (4, 191, 12, 192), (4, 232, 15, 240),
            // 255 rounds to code 16, past the top code 15: the clamp holds it.
            (4, 255, 15, 240),
            // bits = 1: step 128, centre 1. Two codes, portrait and square.
            (1, 0, 0, 0), (1, 64, 0, 0), (1, 65, 1, 128), (1, 128, 1, 128), (1, 255, 1, 128),
            // bits = 7: step 2, centre 64.
            (7, 0, 0, 0), (7, 127, 63, 126), (7, 128, 64, 128), (7, 129, 65, 130),
            (7, 254, 127, 254), (7, 255, 127, 254),
        ];
        for &(bits, byte, code, recon) in cases {
            assert_eq!(
                quantize_aspect(byte, bits),
                (code, recon),
                "bits={bits} byte={byte}"
            );
            assert_eq!(
                dequantize_aspect(code, bits),
                recon,
                "bits={bits} code={code}"
            );
        }
        // Every code of a 4-bit field, including the clamped bottom one.
        let grid: Vec<u8> = (0..16).map(|c| dequantize_aspect(c, 4)).collect();
        let want: Vec<u8> = (0..16).map(|k| (k * 16) as u8).collect();
        assert_eq!(grid, want);
    }

    #[test]
    fn aspect_quantizer_picks_the_nearest_grid_byte() {
        // A property over every byte and width: the reconstruction is the
        // decoder's own dequantization of the code, the code fits the field,
        // and no grid byte is nearer the input.
        for bits in 1..=7u32 {
            let grid: Vec<u8> = (0..1u32 << bits)
                .map(|c| dequantize_aspect(c, bits))
                .collect();
            for byte in 0..=255u8 {
                let (code, recon) = quantize_aspect(byte, bits);
                assert!(code < 1 << bits, "bits={bits} byte={byte} code={code}");
                assert_eq!(recon, grid[code as usize], "bits={bits} byte={byte}");
                let err = (recon as i32 - byte as i32).abs();
                for &g in &grid {
                    assert!(
                        err <= (g as i32 - byte as i32).abs(),
                        "bits={bits} byte={byte}: {recon} is farther than {g}"
                    );
                }
            }
        }
    }

    #[test]
    fn coarse_aspect_field_reaches_the_hash_and_the_decoder() {
        // 4:1 is aspect byte 191, which a 4-bit field codes as 12 (byte 192).
        // The encoder writes the code into bits 8..12, and the decoder sizes
        // its render from the reconstructed byte, not the source's.
        let t = Tunables {
            aspect_bits: 4,
            ..Tunables::DEFAULT
        };
        let rgba = lever_image(8, 2, false, 3);
        let hash = encode_with(8, 2, &rgba, Gamut::Srgb, &t, 1);
        assert_eq!(hash.len(), body_len_bytes(&t, false, 1));
        assert_eq!(crate::bitpack::read_bits(&hash, 8, 4), 12);
        let (w, h, _) = crate::decode::decode_to_with(&hash, &t, Gamut::Srgb);
        assert_eq!((w, h), crate::aspect::decode_output_size(192, 1));
    }

    #[test]
    fn scale_quantizer_linear_grid() {
        // code = round_half_away_from_zero((2^bits − 1) · clamp01(scale / range)).
        assert_eq!(quantize_scale(0.0, 0.5, 6, 0.0), 0);
        assert_eq!(quantize_scale(0.25, 0.5, 6, 0.0), 32); // 31.5 rounds up
        assert_eq!(quantize_scale(0.5, 0.5, 6, 0.0), 63);
        assert_eq!(quantize_scale(0.9, 0.5, 6, 0.0), 63); // clamped
        assert_eq!(quantize_scale(0.1, 0.125, 5, 0.0), 25); // 24.8
        assert_eq!(dequantize_scale(32, 0.5, 6, 0.0), 32.0 / 63.0 * 0.5);
        assert_eq!(dequantize_scale(63, 0.5, 6, 0.0), 0.5);
        assert_eq!(dequantize_scale(0, 0.5, 6, 0.0), 0.0);
    }

    #[test]
    fn scale_quantizer_mu_law_grid() {
        // `scale_mu` > 0 compands the code: 0.05 of a 0.5 range is x = 0.1,
        // and ln(1 + 5·0.1) / ln 6 = 0.2263, so the code is round(63 · 0.2263)
        // = 14 where the linear grid gives round(6.3) = 6.
        assert_eq!(quantize_scale(0.05, 0.5, 6, 5.0), 14);
        assert_eq!(quantize_scale(0.05, 0.5, 6, 0.0), 6);
        assert_eq!(
            dequantize_scale(14, 0.5, 6, 5.0),
            mu_expand(14.0 / 63.0, 5.0) * 0.5
        );
        assert!(dequantize_scale(14, 0.5, 6, 5.0) < dequantize_scale(14, 0.5, 6, 0.0));
        // Every code round-trips through its own reconstruction on both grids.
        for mu in [0.0, 5.0] {
            for code in 0..=63u32 {
                let s = dequantize_scale(code, 0.5, 6, mu);
                assert_eq!(quantize_scale(s, 0.5, 6, mu), code, "mu={mu} code={code}");
            }
        }
    }

    // ── AC quantization job ──────────────────────────────────────────────

    /// A job over `values` with the given tiers and quantizer, at the L
    /// channel's range and scale width and no band split.
    fn test_job<'a>(
        values: &'a [f64],
        tiers: &'a [(usize, u32)],
        family: crate::constants::Companding,
        table: &'a crate::constants::QuantTable,
        deadzone: f64,
    ) -> AcQuantJob<'a> {
        AcQuantJob {
            values,
            tiers,
            split: values.len(),
            band_gain: 1.0,
            max_scale: 0.5,
            code_max: 63,
            scale_bits: 6,
            scale_mu: 0.0,
            family,
            mu: 5.0,
            table,
            deadzone,
            accel: None,
        }
    }

    const MU_LAW: crate::constants::Companding = crate::constants::Companding::MuLaw;
    const NO_TABLE: crate::constants::QuantTable = crate::constants::QuantTable::EMPTY;

    #[test]
    fn bits_at_walks_the_precision_tiers() {
        let tiers = [(3usize, 6u32), (2, 5)];
        let job = test_job(&[], &tiers, MU_LAW, &NO_TABLE, 0.0);
        let widths: Vec<u32> = (0..7).map(|i| job.bits_at(i)).collect();
        // Past the last tier the last width holds.
        assert_eq!(widths, [6, 6, 6, 5, 5, 5, 5]);
        let tiers = [(0usize, 6u32), (4, 5)];
        let job = test_job(&[], &tiers, MU_LAW, &NO_TABLE, 0.0);
        assert_eq!(job.bits_at(0), 5);
        // A third tier is where the running base must accumulate: with two,
        // the last tier and the past-the-end fallback share a width.
        let tiers = [(2usize, 6u32), (1, 5), (4, 4)];
        let job = test_job(&[], &tiers, MU_LAW, &NO_TABLE, 0.0);
        let widths: Vec<u32> = (0..8).map(|i| job.bits_at(i)).collect();
        assert_eq!(widths, [6, 6, 5, 4, 4, 4, 4, 4]);
    }

    #[test]
    fn quantize_one_scores_reconstruction_error() {
        // 4-bit µ-law (µ = 5): levels 0, 0.0583, 0.1337, 0.2310, … At 0.182
        // the companded rounding picks code 10 (0.2310), but 9 (0.1337)
        // reconstructs nearer, so the search moves to it.
        let tiers = [(1usize, 4u32)];
        let job = test_job(&[], &tiers, MU_LAW, &NO_TABLE, 0.0);
        assert_eq!(job.quant(0, 0.182), 10);
        assert_eq!(quantize_one(&job, 0, 0.182, 1.0, false), 10);
        assert_eq!(quantize_one(&job, 0, 0.182, 1.0, true), 9);
        // A zero scale is the exact-zero centre code, search or not.
        assert_eq!(quantize_one(&job, 0, 0.3, 0.0, true), 7);
    }

    #[test]
    fn quantize_one_lets_a_fired_deadzone_stand() {
        let tiers = [(1usize, 4u32)];
        let open = test_job(&[], &tiers, MU_LAW, &NO_TABLE, 0.0);
        // Premise: without a deadzone the search takes 0.05 to code 8.
        assert_eq!(quantize_one(&open, 0, 0.05, 1.0, true), 8);
        let dz = test_job(&[], &tiers, MU_LAW, &NO_TABLE, 0.1);
        // Below the deadzone: the centre, and the search does not undo it.
        assert_eq!(quantize_one(&dz, 0, 0.05, 1.0, true), 7);
        assert_eq!(quantize_one(&dz, 0, -0.05, 1.0, true), 7);
        // Above it the search still runs.
        assert_eq!(quantize_one(&dz, 0, 0.182, 1.0, true), 9);
        // The threshold is strict: |value| == deadzone is not deadzoned.
        let at = test_job(&[], &tiers, MU_LAW, &NO_TABLE, 0.182);
        assert_eq!(at.quant(0, 0.182), 10);
        assert_eq!(quantize_one(&at, 0, 0.182, 1.0, true), 9);
    }

    #[test]
    fn quantize_one_keeps_the_companded_code_on_an_exact_tie() {
        // Exactly representable levels: 0.375 is 0.125 from both 0.25 and
        // 0.5. The table quantizer rounds the tie away from zero (code 9, 0.5)
        // and the strict search keeps it rather than stepping down to 8.
        let mut table = crate::constants::QuantTable::EMPTY;
        table.levels[..3].copy_from_slice(&[0.25, 0.5, 0.75]);
        table.len = 3;
        let tiers = [(1usize, 4u32)];
        let job = test_job(
            &[],
            &tiers,
            crate::constants::Companding::Table,
            &table,
            0.0,
        );
        assert_eq!(job.quant(0, 0.375), 9);
        assert_eq!(quantize_one(&job, 0, 0.375, 1.0, true), 9);
    }

    #[test]
    fn quantize_ac_channel_scale_fit_modes() {
        // 0.1853 sits on the 12/13 boundary of the 4-bit µ-law grid (at a
        // normalized 0.6174): over the raw scale 0.3 it is 0.6177 (code 13),
        // over the dequantized 0.3016 it is 0.6144 (code 12).
        let values = [0.3, -0.12, 0.05, 0.21, -0.27, 0.1853];
        let raw = 0.3;
        let tiers = [(values.len(), 4u32)];
        let job = test_job(&values, &tiers, MU_LAW, &NO_TABLE, 0.0);
        let fit = |mode: u32| {
            let t = Tunables {
                scale_fit: mode,
                ac_nearest: false,
                ..Tunables::DEFAULT
            };
            quantize_ac_channel(&job, raw, &t)
        };
        let codes_at = |s: f64| -> Vec<u32> {
            values
                .iter()
                .map(|&v| compand_quantize(v / s, 4, MU_LAW, 5.0, &NO_TABLE, 0.0))
                .collect()
        };
        // Both nominal modes write round(63 · 0.3 / 0.5) = 38. Mode 0 normalizes
        // by the raw scale, mode 1 by the scale the decoder will see.
        let nominal = 38;
        let deq = dequantize_scale(nominal, 0.5, 6, 0.0);
        assert_eq!(fit(0), (nominal, codes_at(raw)));
        assert_eq!(fit(1), (nominal, codes_at(deq)));
        // Mode 2 searches every code by reconstruction SSE; here it lands
        // somewhere neither nominal mode does.
        let (code, codes) = fit(2);
        assert_eq!(codes, codes_at(dequantize_scale(code, 0.5, 6, 0.0)));
        assert_ne!((code, codes.clone()), fit(0));
        assert_ne!((code, codes), fit(1));
        assert_ne!(fit(0), fit(1), "premise: the two nominal modes differ");
    }

    #[test]
    fn scale_search_keeps_the_smaller_code_on_an_exact_tie() {
        // Levels 0.5 and 1.0 are exact, and dequantize_scale(4) is exactly
        // 2·dequantize_scale(2), so a lone coefficient equal to
        // dequantize_scale(2) reconstructs with zero error at code 2 (level
        // 1.0) and at code 4 (level 0.5). The strict search keeps code 2.
        let mut table = crate::constants::QuantTable::EMPTY;
        table.levels[..2].copy_from_slice(&[0.5, 1.0]);
        table.len = 2;
        let v = dequantize_scale(2, 0.5, 6, 0.0);
        assert_eq!(dequantize_scale(4, 0.5, 6, 0.0), 2.0 * v);
        let values = [v];
        let tiers = [(1usize, 4u32)];
        let job = test_job(
            &values,
            &tiers,
            crate::constants::Companding::Table,
            &table,
            0.0,
        );
        assert_eq!(
            quantize_ac_channel(&job, v, &Tunables::DEFAULT),
            (2, vec![9])
        );
    }

    // ── Refinement objective ─────────────────────────────────────────────

    #[test]
    fn refine_gamma_lut_rounds_onto_its_4096_point_grid() {
        let obj = PixelObjective::new(0, 1.0, 1.0, &[], &[], &[]);
        // 0.75 · 4095 = 3071.25 → entry 3071.
        assert_eq!(obj.gamma_of(0.75), srgb_gamma(3071.0 / 4095.0));
        assert_eq!(obj.gamma_of(0.5), srgb_gamma(2048.0 / 4095.0));
        assert_eq!(obj.gamma_of(1.0), srgb_gamma(1.0));
        assert_eq!(obj.gamma_of(2.0), srgb_gamma(1.0));
        assert_eq!(obj.gamma_of(-0.5), 0.0);
    }

    #[test]
    fn refine_objectives_map_into_their_own_spaces() {
        // An out-of-gamut, over-range triple, so every clip is load-bearing.
        let (l, a, b) = (1.1, 0.25, -0.2);
        let clipped = |l: f64, a: f64, b: f64| {
            let rgb = oklab_to_linear_srgb([clamp01(l), a, b]);
            linear_rgb_to_oklab(
                [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])],
                Gamut::Srgb,
            )
        };
        let c = clipped(l, a, b);
        assert_ne!(c, [l, a, b], "premise: the clip moves this triple");

        // 1: OKLAB untouched.
        let o1 = PixelObjective::new(1, 2.0, 3.0, &[], &[], &[]);
        assert_eq!(o1.map(l, a, b), [l, a, b]);
        // 2: OKLAB after the L clamp and the gamut clip.
        let o2 = PixelObjective::new(2, 2.0, 3.0, &[], &[], &[]);
        assert_eq!(o2.map(l, a, b), c);
        // 3: the same, with L weighted by wl and both chroma axes by wc.
        let o3 = PixelObjective::new(3, 2.0, 3.0, &[], &[], &[]);
        assert_eq!(o3.map(l, a, b), [c[0] * 2.0, c[1] * 3.0, c[2] * 3.0]);
        // 0: gamma-encoded sRGB through the LUT.
        let o0 = PixelObjective::new(0, 2.0, 3.0, &[], &[], &[]);
        let rgb = oklab_to_linear_srgb([clamp01(l), a, b]);
        assert_eq!(
            o0.map(l, a, b),
            [
                o0.gamma_of(rgb[0]),
                o0.gamma_of(rgb[1]),
                o0.gamma_of(rgb[2])
            ]
        );
        // The target is the source mapped the same way.
        let o = PixelObjective::new(3, 2.0, 3.0, &[l], &[a], &[b]);
        assert_eq!(o.target, vec![o3.map(l, a, b)]);
    }

    // ── Sweep-only payload paths through `encode_with` ───────────────────

    #[test]
    fn interleave_reorders_the_ac_codes_and_nothing_else() {
        let il = Tunables {
            interleave: true,
            ..Tunables::DEFAULT
        };
        let d = Tunables::DEFAULT;
        let cases = [
            (9u32, 7u32, 1u8, false),
            (12, 5, 0, false),
            (6, 6, 2, false),
            (6, 6, 1, true),
            (11, 4, 0, true),
            (7, 9, 2, true),
        ];
        for (w, h, tier, alpha) in cases {
            let rgba = lever_image(w, h, alpha, w + h);
            let plain = encode_with(w, h, &rgba, Gamut::Srgb, &d, tier);
            let mixed = encode_with(w, h, &rgba, Gamut::Srgb, &il, tier);
            assert_eq!(
                plain[0] >> ALPHA_FLAG_BIT & 1 == 1,
                alpha,
                "premise: alpha mode {alpha}"
            );
            assert_ne!(plain, mixed, "premise: {w}x{h} tier {tier} reorders");

            // Read the shipped order's codes, then lay them out in the merged
            // order: that must be the interleaved hash, bit for bit.
            let shape = ac_shape(&d, alpha, tier);
            let order = SelectionOrder::new(plain[1], tier, d.aniso_oblique, d.sel_hv);
            let l_sel = order.take(shape.l_count());
            let c_sel = order.take(shape.c_count);
            let alpha_sel = order.take(shape.alpha_ac_count);
            let prefix = prefix_bits(&d) as usize
                + if alpha {
                    (d.alpha_dc_bits + d.alpha_scale_bits) as usize
                } else {
                    0
                };
            let mut pos = prefix;
            let mut read = |bits: u32| {
                let q = crate::bitpack::read_bits(&plain, pos, bits);
                pos += bits as usize;
                q
            };
            let mut l = Vec::new();
            for &(count, bits) in &shape.l_tiers {
                for _ in 0..count {
                    l.push((bits, read(bits)));
                }
            }
            let a: Vec<u32> = (0..shape.c_count).map(|_| read(shape.c_bits)).collect();
            let b: Vec<u32> = (0..shape.c_count).map(|_| read(shape.c_bits)).collect();
            let al: Vec<u32> = (0..shape.alpha_ac_count)
                .map(|_| read(shape.alpha_ac_bits))
                .collect();
            let mut want = vec![0u8; plain.len()];
            let mut pos = prefix;
            for k in 0..pos {
                if plain[k / 8] & (1 << (k % 8)) != 0 {
                    want[k / 8] |= 1 << (k % 8);
                }
            }
            let channels = [
                (&l_sel, shape.l_count()),
                (&c_sel, shape.c_count),
                (&c_sel, shape.c_count),
                (&alpha_sel, shape.alpha_ac_count),
            ];
            for (ch, i) in interleaved_order(&channels) {
                let (bits, q) = match ch {
                    0 => l[i],
                    1 => (shape.c_bits, a[i]),
                    2 => (shape.c_bits, b[i]),
                    _ => (shape.alpha_ac_bits, al[i]),
                };
                write_bits(&mut want, pos, bits, q);
                pos += bits as usize;
            }
            assert_eq!(mixed.as_ref(), want.as_slice(), "{w}x{h} tier {tier}");

            // And the decoder, told the same, renders the same pixels.
            assert_eq!(
                crate::decode::decode_to_with(&mixed, &il, Gamut::Srgb),
                crate::decode::decode_to_with(&plain, &d, Gamut::Srgb),
                "{w}x{h} tier {tier}"
            );
        }
    }

    /// The alpha scale code of an alpha-mode hash.
    fn alpha_scale_code(hash: &[u8], t: &Tunables) -> u32 {
        let pos = prefix_bits(t) + t.alpha_dc_bits;
        crate::bitpack::read_bits(hash, pos as usize, t.alpha_scale_bits)
    }

    #[test]
    fn alpha_scale_code_tops_out_at_its_field() {
        // A hard alpha edge against a tiny range: the raw alpha scale is far
        // past `max_alpha_scale`, so both the legacy path (code = round(15 ·
        // clamp01(scale / range))) and the fitted search (best is the widest
        // scale) must write the 4-bit field's top code, 15 — not a code that
        // wraps when it is packed.
        let (w, h) = (8u32, 8u32);
        let mut rgba = solid(w, h, 200, 80, 40, 255);
        for px in rgba.chunks_exact_mut(4).skip(32) {
            px[3] = 0;
        }
        for fit in [false, true] {
            let t = Tunables {
                max_alpha_scale: 0.02,
                alpha_ac_fit: fit,
                ..Tunables::DEFAULT
            };
            let hash = encode_with(w, h, &rgba, Gamut::Srgb, &t, 1);
            assert_eq!(alpha_scale_code(&hash, &t), 15, "alpha_ac_fit={fit}");
        }
    }

    #[test]
    fn refinement_is_skipped_under_cfl() {
        // `refine_codes` scores a decoder without the CfL predictor, so the
        // encoder must not run it when CfL is on.
        let (w, h) = (11u32, 9u32);
        let rgba = lever_image(w, h, false, 5);
        let refine = |t: Tunables| Tunables {
            refine_passes: 2,
            refine_dc: true,
            refine_scale: true,
            ..t
        };
        let d = Tunables::DEFAULT;
        let cfl = Tunables { cfl_bits: 5, ..d };
        assert_ne!(
            encode_with(w, h, &rgba, Gamut::Srgb, &refine(d), 1),
            encode_with(w, h, &rgba, Gamut::Srgb, &d, 1),
            "premise: the refinement changes this image's bytes"
        );
        assert_eq!(
            encode_with(w, h, &rgba, Gamut::Srgb, &refine(cfl), 1),
            encode_with(w, h, &rgba, Gamut::Srgb, &cfl, 1)
        );
    }

    #[test]
    fn debug_coefficients_are_the_ac_over_its_scale() {
        let t = Tunables::DEFAULT;
        let rgba = lever_image(9, 7, false, 2);
        let dump = encode_debug_coefficients(9, 7, &rgba, Gamut::Srgb, &t, 1);
        let shape = ac_shape(&t, false, 1);
        assert_eq!(dump.l.len(), shape.l_count());
        assert_eq!(dump.a.len(), shape.c_count);
        assert_eq!(dump.b.len(), shape.c_count);
        assert!(dump.alpha.is_empty(), "opaque: no alpha channel");
        // The scale is the channel's peak |AC|, so the peak normalizes to
        // exactly 1 and nothing exceeds it.
        for (name, ch) in [("l", &dump.l), ("a", &dump.a), ("b", &dump.b)] {
            let peak = ch.iter().fold(0.0f64, |m, v| m.max(v.abs()));
            assert_eq!(peak, 1.0, "{name}");
        }
        // A solid image has no AC energy: every channel floors to scale 0 and
        // contributes nothing.
        let flat =
            encode_debug_coefficients(4, 4, &solid(4, 4, 90, 90, 90, 255), Gamut::Srgb, &t, 1);
        assert!(flat.l.is_empty() && flat.a.is_empty() && flat.b.is_empty());
    }

    #[test]
    fn resample_is_exact_at_the_source_size_and_flat_for_a_flat_channel() {
        // With every frequency the source holds, the DCT round trip at the
        // same size reproduces the channel.
        let (w, h) = (5usize, 4usize);
        let chan: Vec<f64> = (0..w * h).map(|p| ((p * 7 % 11) as f64) / 11.0).collect();
        let same = resample_channel_dct(&chan, w, h, w, h);
        assert_eq!(same.len(), w * h);
        for (p, (&got, &want)) in same.iter().zip(&chan).enumerate() {
            assert!((got - want).abs() < 1e-12, "pixel {p}: {got} vs {want}");
        }
        // A constant resamples to the same constant at any size.
        let flat = resample_channel_dct(&[0.4; 12], 4, 3, 7, 2);
        assert_eq!(flat.len(), 14);
        for v in flat {
            assert!((v - 0.4).abs() < 1e-12, "{v}");
        }
    }

    #[test]
    fn refinement_keeps_a_code_on_an_exact_tie() {
        // Refinement accepts a move only on a strict improvement. On a solid
        // image every AC value is zero and each channel's scale code is 0, so
        // a scale move re-quantizes every AC value to the zero code, and an AC
        // move at scale 0 adds nothing: each candidate reproduces the current
        // pixels exactly and ties the running best. The strict `<` keeps the
        // current code, so the hash is the unrefined one. A `<=` would take
        // the tied candidate and write a different scale or AC code.
        for (k, &(r, g, b)) in [(128u8, 64u8, 200u8), (30, 160, 90), (250, 250, 240)]
            .iter()
            .enumerate()
        {
            let rgba = solid(12, 8, r, g, b, 255);
            let plain = encode_with(12, 8, &rgba, Gamut::Srgb, &Tunables::DEFAULT, 1);
            for refine_scale in [true, false] {
                for refine_obj in 0..4 {
                    let t = Tunables {
                        refine_passes: 1,
                        refine_delta: 2,
                        refine_dc: false,
                        refine_scale,
                        refine_obj,
                        ..Tunables::DEFAULT
                    };
                    let got = encode_with(12, 8, &rgba, Gamut::Srgb, &t, 1);
                    assert_eq!(
                        got, plain,
                        "colour {k}, scale {refine_scale}, obj {refine_obj}"
                    );
                }
            }
        }
        // A DC move ties on black under the gamma-sRGB objective (obj 0): one
        // L or chroma step from black lands every channel within 1e-6 of zero
        // in linear light, which the 4096-point gamma LUT rounds back to 0.
        let black = solid(12, 8, 0, 0, 0, 255);
        let t = Tunables {
            refine_passes: 1,
            refine_dc: true,
            refine_obj: 0,
            ..Tunables::DEFAULT
        };
        assert_eq!(
            encode_with(12, 8, &black, Gamut::Srgb, &t, 1),
            encode_with(12, 8, &black, Gamut::Srgb, &Tunables::DEFAULT, 1)
        );
    }

    #[test]
    fn refinement_goldens() {
        // `band_gain_refine_cfl_and_shared_scale_goldens` runs one pass at
        // ±1. These pin the rest of the coordinate descent: several passes
        // (the convergence break), ±2 moves for every code family, the
        // decoder-raster target (`refine_grid = 1`, which resamples the
        // source) on strips narrower than that raster, and scale refinement
        // switched off.
        let base = Tunables {
            refine_passes: 3,
            refine_delta: 2,
            refine_dc: true,
            refine_scale: true,
            w_min_l: [[0.6; crate::constants::TIER_CODES]; 2],
            w_exp_l: [[2; crate::constants::TIER_CODES]; 2],
            ..Tunables::DEFAULT
        };
        let grid = Tunables {
            refine_grid: 1,
            ..base
        };
        let no_scale = Tunables {
            refine_scale: false,
            ..base
        };
        #[rustfmt::skip]
        let cases: [(u32, u32, Tunables, [u8; 32]); 5] = [
            (11, 9, base,
                [9, 137, 206, 33, 240, 160, 22, 13, 129, 29, 147, 214, 152, 88, 98, 41, 97, 37, 209, 104, 34, 24, 115, 164, 24, 78, 91, 134, 109, 146, 168, 137]),
            (11, 9, grid,
                [9, 137, 81, 32, 240, 144, 72, 12, 193, 153, 225, 202, 96, 150, 150, 230, 88, 25, 166, 222, 24, 170, 138, 149, 56, 73, 2, 130, 50, 140, 80, 202]),
            (1, 12, grid,
                [9, 13, 86, 148, 177, 145, 84, 72, 233, 209, 24, 205, 222, 221, 221, 221, 221, 221, 221, 221, 157, 75, 82, 27, 181, 109, 67, 146, 144, 75, 181, 109]),
            (12, 1, grid,
                [9, 242, 61, 38, 236, 96, 81, 200, 110, 155, 13, 221, 233, 245, 221, 221, 221, 221, 221, 221, 157, 210, 112, 163, 54, 78, 91, 16, 8, 214, 150, 101]),
            (11, 9, no_scale,
                [9, 137, 208, 223, 240, 152, 202, 136, 192, 217, 110, 151, 13, 201, 221, 22, 93, 234, 213, 105, 45, 42, 79, 140, 20, 170, 12, 136, 164, 158, 184, 164]),
        ];
        for (k, (w, h, t, expected)) in cases.iter().enumerate() {
            let rgba = lever_image(*w, *h, false, 40 + k as u32);
            let got = encode_with(*w, *h, &rgba, Gamut::Srgb, t, 1);
            assert_eq!(got.as_ref(), expected, "case {k}");
            let plain = encode_with(*w, *h, &rgba, Gamut::Srgb, &Tunables::DEFAULT, 1);
            assert_ne!(got, plain, "premise: case {k} refines something");
        }
        // With `b_scale_from_a` the b channel has no scale of its own, and
        // scale refinement is skipped rather than moving a shared code.
        let rgba = lever_image(11, 9, false, 49);
        let shared = |t: Tunables| Tunables {
            b_scale_from_a: true,
            ..t
        };
        assert_eq!(
            encode_with(11, 9, &rgba, Gamut::Srgb, &shared(base), 1),
            encode_with(11, 9, &rgba, Gamut::Srgb, &shared(no_scale), 1)
        );
    }

    // ── Register D5: downsampling before the transform (`downsample`) ────

    fn downsampled(placement: u32, edge: u32) -> Tunables {
        Tunables {
            downsample: placement,
            downsample_edge: edge,
            ..Tunables::DEFAULT
        }
    }

    #[test]
    fn downsampling_is_off_in_the_shipped_encoder() {
        let shipped = std::hint::black_box(&Tunables::DEFAULT);
        assert_eq!(
            shipped.downsample, 0,
            "downsample must stay off: it moves every hash of a large source"
        );
    }

    #[test]
    fn the_grid_keeps_the_aspect_at_the_budget_and_never_enlarges() {
        // At or under the budget there is no grid; a zero edge is no budget.
        assert_eq!(downsample_dims(100, 100, 100), None);
        assert_eq!(downsample_dims(256, 256, 256), None);
        assert_eq!(downsample_dims(5000, 4000, 0), None);
        // One pixel over the budget resamples.
        assert_eq!(downsample_dims(101, 100, 100), Some((100, 100)));
        assert_eq!(downsample_dims(1024, 1024, 256), Some((256, 256)));
        // The aspect is kept: s = 256 / sqrt(4000·1000) = 0.128.
        assert_eq!(downsample_dims(4000, 1000, 256), Some((512, 128)));
        assert_eq!(downsample_dims(1000, 4000, 256), Some((128, 512)));
        // A rounded-away short axis is held to one pixel, and no axis grows.
        assert_eq!(downsample_dims(1, 100_000, 16), Some((1, 5060)));
        let (w, h) = downsample_dims(3, 5000, 64).unwrap();
        assert!(w <= 3 && h <= 5000 && w >= 1, "{w}x{h}");
    }

    #[test]
    fn area_spans_are_exact_integer_overlaps_summing_to_the_source_length() {
        // 3 pixels to 2 cells: the middle pixel is split 1:1.
        assert_eq!(area_spans(3, 2), vec![(0, 2, 0), (0, 1, 1), (1, 2, 0)]);
        // An integer factor puts each pixel in one cell, whole.
        assert_eq!(
            area_spans(4, 2),
            vec![(0, 2, 0), (0, 2, 0), (1, 2, 0), (1, 2, 0)]
        );
        // No resampling is the identity.
        assert_eq!(area_spans(3, 3), vec![(0, 3, 0), (1, 3, 0), (2, 3, 0)]);
        for (n, m) in [(7, 3), (1000, 256), (5000, 1), (97, 96)] {
            let mut per_cell = vec![0u64; m];
            for (cell, first, second) in area_spans(n, m) {
                per_cell[cell] += first;
                if second > 0 {
                    per_cell[cell + 1] += second;
                }
            }
            assert!(
                per_cell.iter().all(|&s| s == n as u64),
                "{n}->{m}: {per_cell:?}"
            );
        }
    }

    #[test]
    fn the_area_average_weights_each_pixel_by_its_coverage() {
        // [0, 3, 6] to 2 cells: (2·0 + 1·3)/3 and (1·3 + 2·6)/3.
        assert_eq!(
            area_downsample(&[0.0, 3.0, 6.0], 3, 1, 2, 1),
            vec![1.0, 5.0]
        );
        // Separable: a 2×2 block mean, then a fractional one along y.
        let plane = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(area_downsample(&plane, 2, 2, 1, 1), vec![2.5]);
        let column = [0.0, 3.0, 6.0];
        assert_eq!(area_downsample(&column, 1, 3, 1, 2), vec![1.0, 5.0]);
        // A constant plane stays constant, cell by cell.
        let flat = vec![0.3; 37 * 23];
        for v in area_downsample(&flat, 37, 23, 11, 7) {
            assert!((v - 0.3).abs() < 1e-15, "{v}");
        }
    }

    #[test]
    fn the_linear_placement_averages_premultiplied_light() {
        // An opaque red pixel beside a transparent green one: the cell is
        // red at half alpha. An unpremultiplied mean would be (0.5, 0.5, 0).
        let rgba = [255, 0, 0, 255, 0, 255, 0, 0];
        let lut = build_eotf_lut(Gamut::Srgb);
        let (mut r, mut g, mut b, mut a) = ([9.0], [9.0], [9.0], [9.0]);
        area_downsample_linear(&rgba, 2, 1, 1, 1, &lut, [&mut r, &mut g, &mut b], &mut a);
        assert_eq!((r[0], g[0], b[0], a[0]), (1.0, 0.0, 0.0, 0.5));
        // A fully transparent cell has no colour and no alpha.
        let clear = [255, 255, 255, 0, 10, 20, 30, 0];
        area_downsample_linear(&clear, 2, 1, 1, 1, &lut, [&mut r, &mut g, &mut b], &mut a);
        assert_eq!((r[0], g[0], b[0], a[0]), (0.0, 0.0, 0.0, 0.0));
        // An opaque cell's alpha is exactly 1, at any coverage.
        let opaque = solid(7, 5, 10, 200, 90, 255);
        let mut planes = [vec![0.0; 6], vec![0.0; 6], vec![0.0; 6]];
        let mut alpha = vec![0.0; 6];
        let [pr, pg, pb] = &mut planes;
        area_downsample_linear(&opaque, 7, 5, 3, 2, &lut, [pr, pg, pb], &mut alpha);
        assert!(alpha.iter().all(|&x| x == 1.0), "{alpha:?}");
        assert!(planes[1].iter().all(|&x| (x - lut[200]).abs() < 1e-15));
    }

    /// An opaque image constant on every 2×2 block, and the image of its
    /// blocks: the area average of the first on the half-size grid is the
    /// second exactly, in linear light and in OKLAB alike.
    fn blocky(w: u32, h: u32, seed: u32) -> (Vec<u8>, Vec<u8>) {
        let small = lever_image(w, h, false, seed);
        let (w, h) = (w as usize, h as usize);
        let mut big = vec![0u8; w * h * 16];
        for y in 0..2 * h {
            for x in 0..2 * w {
                let s = ((y / 2) * w + x / 2) * 4;
                let d = (y * 2 * w + x) * 4;
                big[d..d + 4].copy_from_slice(&small[s..s + 4]);
            }
        }
        (big, small)
    }

    #[test]
    fn a_downsampled_encode_is_the_encode_of_the_grid() {
        // s = 10 / sqrt(24·16) ≈ 0.510, so the grid is exactly half size.
        assert_eq!(downsample_dims(24, 16, 10), Some((12, 8)));
        let (big, small) = blocky(12, 8, 7);
        let mut resolved = 0;
        for tier in 0..=MAX_TIER {
            let grid = encode_with(12, 8, &small, Gamut::Srgb, &Tunables::DEFAULT, tier);
            for placement in [1, 2] {
                let got = encode_with(24, 16, &big, Gamut::Srgb, &downsampled(placement, 10), tier);
                assert_eq!(got, grid, "placement {placement} tier {tier}");
            }
            let full = encode_with(24, 16, &big, Gamut::Srgb, &Tunables::DEFAULT, tier);
            resolved += usize::from(full != grid);
        }
        // Premise: the full-resolution encode is not the grid's at the tiers
        // whose frequencies reach past the grid's, so the equality above is
        // the resampling's doing, not the input's.
        assert!(resolved >= 2, "{resolved} tiers see the resolution");
    }

    #[test]
    fn a_source_within_the_budget_encodes_as_shipped() {
        for alpha in [false, true] {
            let rgba = lever_image(20, 15, alpha, 3);
            for tier in [0, 1, 4] {
                let shipped = encode_with(20, 15, &rgba, Gamut::Srgb, &Tunables::DEFAULT, tier);
                // 300 pixels: a budget of 18² = 324 holds them; 17² = 289
                // does not, but its grid rounds back to 20×15, the identity.
                assert_eq!(downsample_dims(20, 15, 17), None);
                for edge in [17, 18] {
                    for placement in [0, 1, 2, 3] {
                        let t = downsampled(placement, edge);
                        assert_eq!(encode_with(20, 15, &rgba, Gamut::Srgb, &t, tier), shipped);
                    }
                }
                // 12² = 144 resamples, except when the knob is off (0) or
                // names no placement (3).
                for placement in [0, 3] {
                    let t = downsampled(placement, 12);
                    assert_eq!(encode_with(20, 15, &rgba, Gamut::Srgb, &t, tier), shipped);
                }
                // At code 4 every placement's resample shows in the hash (at
                // code 0 a 14×10 grid can still give the shipped codes).
                for placement in [1, 2].into_iter().filter(|_| tier == 4) {
                    let t = downsampled(placement, 12);
                    assert_ne!(
                        encode_with(20, 15, &rgba, Gamut::Srgb, &t, tier),
                        shipped,
                        "placement {placement} tier {tier} alpha {alpha} resamples over the budget"
                    );
                }
            }
        }
    }

    #[test]
    fn a_downsampled_hash_keeps_the_shipped_length_alpha_mode_and_aspect() {
        for alpha in [false, true] {
            let rgba = lever_image(61, 23, alpha, 11);
            for tier in 0..=MAX_TIER {
                let shipped = encode_with(61, 23, &rgba, Gamut::Srgb, &Tunables::DEFAULT, tier);
                let (sw, sh, _) = crate::decode::decode_with(&shipped, &Tunables::DEFAULT);
                for placement in [1, 2] {
                    let t = downsampled(placement, 12);
                    let got = encode_with(61, 23, &rgba, Gamut::Srgb, &t, tier);
                    assert_eq!(got.len(), shipped.len(), "tier {tier} alpha {alpha}");
                    assert!(crate::ChromaHash::from_bytes(&got).is_ok());
                    let (w, h, px) = crate::decode::decode_with(&got, &Tunables::DEFAULT);
                    assert_eq!((w, h), (sw, sh), "the aspect is the source's");
                    assert_eq!(px.len(), (w * h * 4) as usize);
                    let has_alpha = px.chunks_exact(4).any(|p| p[3] < 255);
                    assert_eq!(has_alpha, alpha, "placement {placement} tier {tier}");
                }
            }
        }
    }

    #[test]
    fn every_encoder_lever_is_byte_identical_under_downsampling() {
        for alpha in [false, true] {
            // Over two fused-pass tiles, so the fused path has work to skip.
            let rgba = lever_image(53, 41, alpha, 21);
            for placement in [1, 2] {
                for tier in [0, 1, 3] {
                    let base = downsampled(placement, 20);
                    let want = encode_with(53, 41, &rgba, Gamut::Srgb, &base, tier);
                    for lever in ENCODE_LEVERS {
                        let mut t = base;
                        lever(&mut t);
                        assert_eq!(
                            encode_with(53, 41, &rgba, Gamut::Srgb, &t, tier),
                            want,
                            "placement {placement} tier {tier} alpha {alpha}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn the_two_placements_differ_only_where_the_colour_pass_is_nonlinear() {
        // A flat colour is the same in either placement; texture is not.
        let flat = solid(40, 30, 30, 140, 220, 255);
        let noisy = lever_image(40, 30, false, 5);
        for tier in [1, 3] {
            let at =
                |rgba: &[u8], p| encode_with(40, 30, rgba, Gamut::Srgb, &downsampled(p, 16), tier);
            assert_eq!(at(&flat, 1), at(&flat, 2), "tier {tier}");
            assert_ne!(at(&noisy, 1), at(&noisy, 2), "tier {tier}");
        }
    }
}
