use crate::aspect::decode_output_size;
use crate::bitpack::read_bits;
use crate::color::{oklab_to_linear_output, oklab_to_linear_srgb};
use crate::constants::{
    ALPHA_FLAG_BIT, Gamut, TIER_BITS, Tunables, VERSION_BITS, ac_shape, prefix_bits,
};
use crate::dct::{
    SelectionOrder, dct_decode_pixel_separable, precompute_cos_table, window_weights,
};
use crate::encode::{
    band_split_index, dequantize_aspect, dequantize_c_dc, dequantize_cfl_gain, dequantize_l_dc,
    dequantize_scale,
};
use crate::math_utils::{clamp01, round_half_away_from_zero};
use crate::mulaw::compand_dequantize;
use crate::transfer::{adobe_rgb_gamma, srgb_gamma};

/// Build the 4096-entry gamma LUT for the output gamut: lut[i] = γ(i/4095)·255.
/// sRGB / Display P3 use the sRGB piecewise transfer; Adobe RGB uses γ = 2.2.
/// Per spec §12.6.
fn build_gamma_lut(output: Gamut) -> [u8; 4096] {
    let mut lut = [0u8; 4096];
    for (i, entry) in lut.iter_mut().enumerate() {
        let x = i as f64 / 4095.0;
        let g = if output.output_uses_adobe_gamma() {
            adobe_rgb_gamma(x)
        } else {
            srgb_gamma(x)
        };
        *entry = round_half_away_from_zero(g.clamp(0.0, 1.0) * 255.0) as u8;
    }
    lut
}

/// Map linear [0,1] to gamma-encoded u8 via the output-gamut LUT. Per spec §12.6.
fn linear_to_gamma8(x: f64, lut: &[u8; 4096]) -> u8 {
    let idx = (round_half_away_from_zero(x * 4095.0) as i64).clamp(0, 4095) as usize;
    lut[idx]
}

/// Decode the byte-0 descriptor + byte-1 aspect: (version, tier, hasAlpha,
/// aspect). Per spec §3.1 (v1). Callers operate on hashes already validated by
/// [`crate::ChromaHash::from_bytes`], so the fields are well-formed here.
fn read_header_fields(hash: &[u8], t: &Tunables) -> (u8, u8, bool, u8) {
    let b0 = hash[0];
    let version = b0 & ((1 << VERSION_BITS) - 1);
    let tier = (b0 >> VERSION_BITS) & ((1 << TIER_BITS) - 1);
    let has_alpha = (b0 >> ALPHA_FLAG_BIT) & 1 == 1;
    // The aspect field may be narrower than a byte; reconstruct the byte the
    // encoder selected and rendered on.
    let aspect = dequantize_aspect(read_bits(hash, 8, t.aspect_bits), t.aspect_bits);
    (version, tier, has_alpha, aspect)
}

/// One channel's AC data ready for rendering: windowed coefficient values and
/// their (cx, cy) pairs, filtered to frequencies representable at the render
/// dimensions (cx < w, cy < h). Per spec §11 (v0.6) — rendering below the
/// natural size is a band-limited reconstruction at the coarser raster, which
/// is what makes capped decodes of extreme aspect ratios artifact-free
/// (v0.5 rendered 1×N strips as solid white through basis aliasing).
fn prepare_channel(
    ac: &[f64],
    coeffs: &[(usize, usize)],
    weights: &[f64],
    w: usize,
    h: usize,
) -> (Vec<f64>, Vec<(usize, usize)>) {
    let mut vals = Vec::with_capacity(ac.len());
    let mut scan = Vec::with_capacity(ac.len());
    for (j, &(cx, cy)) in coeffs.iter().enumerate() {
        if cx >= w || cy >= h {
            continue;
        }
        vals.push(ac[j] * weights[j]);
        scan.push((cx, cy));
    }
    (vals, scan)
}

/// FNV-1a over the hash bytes: a deterministic seed for detail synthesis, so
/// the same hash always renders the same detail on every platform.
fn hash_seed(hash: &[u8]) -> u64 {
    let mut acc: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in hash {
        acc ^= b as u64;
        acc = acc.wrapping_mul(0x0000_0100_0000_01b3);
    }
    acc
}

/// Extend the luma AC set past the coded band with synthesized coefficients.
///
/// Amplitude follows the coded band's own decay: the RMS of the coded set's
/// highest-frequency quarter, scaled by `sqrt(p_K / p_j)` so the synthetic tail
/// continues the spectrum rather than adding a flat noise floor. Signs come
/// from an LCG seeded by the hash, so the result is deterministic and carries
/// no bytes. Returns the extended selection and coefficient list.
fn synthesize_detail(
    hash: &[u8],
    aspect: u8,
    tier: u8,
    l_count: usize,
    l_sel: crate::dct::Selection,
    mut l_ac: Vec<f64>,
    t: &Tunables,
) -> (crate::dct::Selection, Vec<f64>) {
    let ext =
        SelectionOrder::new(aspect, tier, t.aniso_oblique, t.sel_hv).take(l_count + t.synth_count);
    if ext.coeffs.len() <= l_count {
        return (l_sel, l_ac);
    }
    // Reference amplitude: the coded set's highest-frequency quarter.
    let tail = (l_count / 4).max(1);
    let mut acc = 0.0;
    for v in l_ac.iter().skip(l_count - tail) {
        acc += v * v;
    }
    let rms = (acc / tail as f64).sqrt();
    if rms <= 0.0 {
        return (l_sel, l_ac);
    }
    let p_k = l_sel.p_k as f64;
    let mut state = hash_seed(hash) | 1;
    for j in l_count..ext.coeffs.len() {
        // xorshift64*, a deterministic integer PRNG with no platform floats.
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let r = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        let sign = if r & 1 == 0 { -1.0 } else { 1.0 };
        let decay = (p_k / ext.priorities[j] as f64).sqrt();
        l_ac.push(sign * t.synth_gain * rms * decay);
    }
    (ext, l_ac)
}

/// Render a ChromaHash at the given pixel dimensions, into the given output
/// gamut (sRGB / Display P3 / Adobe RGB). Per spec §11 (v0.6).
fn render_at_size(hash: &[u8], w: usize, h: usize, t: &Tunables, output: Gamut) -> Vec<u8> {
    // 1. Header fields: byte-0 descriptor + byte-1 aspect, then DC/scale prefix
    //    (bits 16..54). Per spec §3.1 (v1).
    let (_version, tier, has_alpha, aspect) = read_header_fields(hash, t);

    let mut bitpos = 8usize + t.aspect_bits as usize;
    let l_dc_q = read_bits(hash, bitpos, t.l_dc_bits);
    bitpos += t.l_dc_bits as usize;
    let a_dc_q = read_bits(hash, bitpos, t.a_dc_bits);
    bitpos += t.a_dc_bits as usize;
    let b_dc_q = read_bits(hash, bitpos, t.b_dc_bits);
    bitpos += t.b_dc_bits as usize;
    let l_scl_q = read_bits(hash, bitpos, t.l_scale_bits);
    bitpos += t.l_scale_bits as usize;
    let a_scl_q = read_bits(hash, bitpos, t.a_scale_bits);
    bitpos += t.a_scale_bits as usize;
    // `b_scale_from_a` drops the b field entirely and shares the a code.
    let b_scl_q = if t.b_scale_from_a {
        a_scl_q
    } else {
        let q = read_bits(hash, bitpos, t.b_scale_bits);
        bitpos += t.b_scale_bits as usize;
        q
    };
    // Chroma-from-luma gains, when signalled.
    let (cfl_a, cfl_b) = if t.cfl_bits > 0 {
        let ca = read_bits(hash, bitpos, t.cfl_bits);
        bitpos += t.cfl_bits as usize;
        let cb = read_bits(hash, bitpos, t.cfl_bits);
        bitpos += t.cfl_bits as usize;
        (
            dequantize_cfl_gain(ca, t.cfl_range, t.cfl_bits),
            dequantize_cfl_gain(cb, t.cfl_range, t.cfl_bits),
        )
    } else {
        (0.0, 0.0)
    };
    debug_assert_eq!(bitpos, prefix_bits(t) as usize);

    // 2. Decode DC values and scale factors
    let l_dc = dequantize_l_dc(l_dc_q, t.l_dc_bits);
    let a_dc = dequantize_c_dc(a_dc_q, t.max_chroma_a, t.a_dc_bits);
    let b_dc = dequantize_c_dc(b_dc_q, t.max_chroma_b, t.b_dc_bits);
    let l_scale = dequantize_scale(l_scl_q, t.max_l_scale, t.l_scale_bits, t.scale_mu);
    let a_scale = dequantize_scale(a_scl_q, t.max_a_scale, t.a_scale_bits, t.scale_mu);
    let (b_range, b_bits) = if t.b_scale_from_a {
        (t.max_a_scale, t.a_scale_bits)
    } else {
        (t.max_b_scale, t.b_scale_bits)
    };
    let b_scale = dequantize_scale(b_scl_q, b_range, b_bits, t.scale_mu);

    // 3. Coefficient selection (mirrors the encoder; counts scaled by tier)
    let shape = ac_shape(t, has_alpha, tier);
    let l_count = shape.l_count();
    let c_count = shape.c_count;
    // Every channel's selection is a prefix of the same sorted candidate list,
    // so the sort — the one superlinear step in a decode — happens once.
    let order = SelectionOrder::new(aspect, tier, t.aniso_oblique, t.sel_hv);
    let l_sel = order.take(l_count);
    let c_sel = order.take(c_count);

    // 4. Read AC payload (alpha DC/scale first in alpha mode)
    let (alpha_dc_val, alpha_scale_val) = if has_alpha {
        let adc = read_bits(hash, bitpos, t.alpha_dc_bits) as f64
            / ((1u32 << t.alpha_dc_bits) - 1) as f64;
        bitpos += t.alpha_dc_bits as usize;
        let ascl = read_bits(hash, bitpos, t.alpha_scale_bits) as f64
            / ((1u32 << t.alpha_scale_bits) - 1) as f64
            * t.max_alpha_scale;
        bitpos += t.alpha_scale_bits as usize;
        (adc, ascl)
    } else {
        (1.0, 0.0)
    };

    // Scalefactor-band split points (mirror the encoder; gain 1.0 = no-op).
    let l_split = band_split_index(l_count, t.band_split);
    let c_split = band_split_index(c_count, t.band_split);

    // A truncated (progressive) decode treats every code past the delivered
    // bytes as the exact-zero centre code.
    let limit_bits = if t.trunc_bytes > 0 {
        t.trunc_bytes.min(hash.len()) * 8
    } else {
        hash.len() * 8
    };
    let read_code = |bitpos: usize, bits: u32| -> u32 {
        if bitpos + bits as usize <= limit_bits {
            read_bits(hash, bitpos, bits)
        } else {
            (1u32 << (bits - 1)) - 1
        }
    };

    let c_bits = shape.c_bits;
    let mut l_raw = vec![0u32; l_count];
    let mut a_raw = vec![0u32; c_count];
    let mut b_raw = vec![0u32; c_count];
    let mut l_bits_at = vec![0u32; l_count];
    {
        let mut i = 0usize;
        for &(count, bits) in &shape.l_tiers {
            for _ in 0..count {
                if i < l_count {
                    l_bits_at[i] = bits;
                }
                i += 1;
            }
        }
    }
    if t.interleave && !has_alpha {
        for (ch, i) in crate::dct::interleaved_order(&l_sel, &c_sel, l_count, c_count) {
            let bits = if ch == 0 { l_bits_at[i] } else { c_bits };
            let q = read_code(bitpos, bits);
            bitpos += bits as usize;
            match ch {
                0 => l_raw[i] = q,
                1 => a_raw[i] = q,
                _ => b_raw[i] = q,
            }
        }
    } else {
        for i in 0..l_count {
            let bits = l_bits_at[i];
            l_raw[i] = read_code(bitpos, bits);
            bitpos += bits as usize;
        }
        for slot in a_raw.iter_mut() {
            *slot = read_code(bitpos, c_bits);
            bitpos += c_bits as usize;
        }
        for slot in b_raw.iter_mut() {
            *slot = read_code(bitpos, c_bits);
            bitpos += c_bits as usize;
        }
    }

    let mut l_ac = Vec::with_capacity(l_count);
    for (i, &q) in l_raw.iter().enumerate() {
        let bits = l_bits_at[i];
        let gain = if i >= l_split { t.band_gain_l } else { 1.0 };
        l_ac.push(compand_dequantize(q, bits, t.compand_l, t.mu_l, &t.table_l) * l_scale * gain);
    }

    // With CfL on, each chroma coefficient is a residual against alpha times the
    // luma coefficient at the same selection index (the same index is the same
    // frequency: both selections truncate one sorted candidate list).
    let predictor = |i: usize| -> f64 { l_ac.get(i).copied().unwrap_or(0.0) };
    let mut a_ac = Vec::with_capacity(c_count);
    for (i, &q) in a_raw.iter().enumerate() {
        let gain = if i >= c_split { t.band_gain_c } else { 1.0 };
        let residual =
            compand_dequantize(q, c_bits, t.compand_c, t.mu_c, &t.table_c) * a_scale * gain;
        a_ac.push(residual + cfl_a * predictor(i));
    }
    let mut b_ac = Vec::with_capacity(c_count);
    for (i, &q) in b_raw.iter().enumerate() {
        let gain = if i >= c_split { t.band_gain_c } else { 1.0 };
        let residual =
            compand_dequantize(q, c_bits, t.compand_c, t.mu_c, &t.table_c) * b_scale * gain;
        b_ac.push(residual + cfl_b * predictor(i));
    }

    let (alpha_ac, alpha_sel) = if has_alpha {
        let sel = order.take(shape.alpha_ac_count);
        let mut aac = Vec::with_capacity(shape.alpha_ac_count);
        for _ in 0..shape.alpha_ac_count {
            let q = read_bits(hash, bitpos, shape.alpha_ac_bits);
            bitpos += shape.alpha_ac_bits as usize;
            aac.push(
                compand_dequantize(
                    q,
                    shape.alpha_ac_bits,
                    t.compand_alpha,
                    t.mu_alpha,
                    &t.table_alpha,
                ) * alpha_scale_val,
            );
        }
        (aac, Some(sel))
    } else {
        (vec![], None)
    };

    // 4b. Decoder-side detail synthesis (zero bytes). Everything the format
    //     codes is a handful of global low frequencies, so the render is far
    //     smoother than the source; this extends the spectrum past the coded
    //     band with a deterministic, hash-seeded field whose amplitude follows
    //     the coded band's own decay. Off by default.
    let (l_sel, l_ac) = if t.synth_count > 0 && t.synth_gain > 0.0 && l_count > 0 {
        synthesize_detail(hash, aspect, tier, l_count, l_sel, l_ac, t)
    } else {
        (l_sel, l_ac)
    };

    // 5. Synthesis window + frequency filter for the render raster
    let l_weights = window_weights(&l_sel, t.w_min_l, t.w_exp_l);
    let c_weights = window_weights(&c_sel, t.w_min_c, t.w_exp_c);

    let (l_vals, l_scan) = prepare_channel(&l_ac, &l_sel.coeffs, &l_weights, w, h);
    let (a_vals, a_scan) = prepare_channel(&a_ac, &c_sel.coeffs, &c_weights, w, h);
    let (b_vals, b_scan) = prepare_channel(&b_ac, &c_sel.coeffs, &c_weights, w, h);
    let (alpha_vals, alpha_scan) = if let Some(sel) = &alpha_sel {
        // Alpha is structural, not chromatic — share the luma window shape.
        let weights = window_weights(sel, t.w_min_l, t.w_exp_l);
        prepare_channel(&alpha_ac, &sel.coeffs, &weights, w, h)
    } else {
        (vec![], vec![])
    };

    // 6. Cosine tables sized to the surviving frequencies
    let max_cx = l_scan
        .iter()
        .chain(a_scan.iter())
        .chain(alpha_scan.iter())
        .map(|&(cx, _)| cx)
        .max()
        .unwrap_or(0);
    let max_cy = l_scan
        .iter()
        .chain(a_scan.iter())
        .chain(alpha_scan.iter())
        .map(|&(_, cy)| cy)
        .max()
        .unwrap_or(0);
    let cos_x = precompute_cos_table(w, max_cx + 1);
    let cos_y = precompute_cos_table(h, max_cy + 1);

    // 7. Build gamma LUT and render
    let gamma_lut = build_gamma_lut(output);
    let mut rgba_out = vec![0u8; w * h * 4];

    for y in 0..h {
        for x in 0..w {
            let l = dct_decode_pixel_separable(l_dc, &l_vals, &l_scan, x, y, &cos_x, &cos_y);
            let a = dct_decode_pixel_separable(a_dc, &a_vals, &a_scan, x, y, &cos_x, &cos_y);
            let b = dct_decode_pixel_separable(b_dc, &b_vals, &b_scan, x, y, &cos_x, &cos_y);
            let alpha = if has_alpha {
                dct_decode_pixel_separable(
                    alpha_dc_val,
                    &alpha_vals,
                    &alpha_scan,
                    x,
                    y,
                    &cos_x,
                    &cos_y,
                )
            } else {
                1.0
            };

            // Clamp L from DCT ringing; out-of-gamut chroma is handled by the
            // per-channel clamp01 below (relative-colorimetric clip, §12.6).
            let l_clamped = clamp01(l);
            let rgb_linear = oklab_to_linear_output([l_clamped, a, b], output);
            let idx = (y * w + x) * 4;
            rgba_out[idx] = linear_to_gamma8(clamp01(rgb_linear[0]), &gamma_lut);
            rgba_out[idx + 1] = linear_to_gamma8(clamp01(rgb_linear[1]), &gamma_lut);
            rgba_out[idx + 2] = linear_to_gamma8(clamp01(rgb_linear[2]), &gamma_lut);
            rgba_out[idx + 3] = round_half_away_from_zero(255.0 * clamp01(alpha)) as u8;
        }
    }

    rgba_out
}

/// Decode a ChromaHash into RGBA pixel data in the given output gamut, with
/// explicit tunables. Returns (width, height, rgba_pixels).
pub fn decode_to_with(hash: &[u8], t: &Tunables, output: Gamut) -> (u32, u32, Vec<u8>) {
    let (_version, tier, _has_alpha, aspect) = read_header_fields(hash, t);
    let (w, h) = decode_output_size(aspect, tier);
    let rgba = render_at_size(hash, w as usize, h as usize, t, output);
    (w, h, rgba)
}

/// Decode a ChromaHash into sRGB RGBA pixel data with explicit tunables.
pub fn decode_with(hash: &[u8], t: &Tunables) -> (u32, u32, Vec<u8>) {
    decode_to_with(hash, t, Gamut::Srgb)
}

/// Decode a ChromaHash into sRGB RGBA pixel data. Per spec §11 (v0.6).
/// Returns (width, height, rgba_pixels).
pub fn decode(hash: &[u8]) -> (u32, u32, Vec<u8>) {
    decode_to_with(hash, &Tunables::DEFAULT, Gamut::Srgb)
}

/// Decode a ChromaHash into RGBA pixel data in the given output gamut
/// (sRGB / Display P3 / Adobe RGB; others fall back to sRGB).
pub fn decode_to(hash: &[u8], output: Gamut) -> (u32, u32, Vec<u8>) {
    decode_to_with(hash, &Tunables::DEFAULT, output)
}

/// Decode capped at the given max dimensions, in the given output gamut, with
/// explicit tunables.
pub fn decode_capped_to_with(
    hash: &[u8],
    max_w: u32,
    max_h: u32,
    t: &Tunables,
    output: Gamut,
) -> (u32, u32, Vec<u8>) {
    let (_version, tier, _has_alpha, aspect) = read_header_fields(hash, t);
    let (nat_w, nat_h) = decode_output_size(aspect, tier);
    let w = nat_w.min(max_w);
    let h = nat_h.min(max_h);
    let rgba = render_at_size(hash, w as usize, h as usize, t, output);
    (w, h, rgba)
}

/// Decode capped at the given max dimensions (sRGB output), with explicit tunables.
pub fn decode_capped_with(
    hash: &[u8],
    max_w: u32,
    max_h: u32,
    t: &Tunables,
) -> (u32, u32, Vec<u8>) {
    decode_capped_to_with(hash, max_w, max_h, t, Gamut::Srgb)
}

/// Decode a ChromaHash into sRGB RGBA pixel data, capped at the given max
/// dimensions. The shorter decoded dimension is also capped proportionally.
/// Returns (width, height, rgba_pixels).
pub fn decode_capped(hash: &[u8], max_w: u32, max_h: u32) -> (u32, u32, Vec<u8>) {
    decode_capped_to_with(hash, max_w, max_h, &Tunables::DEFAULT, Gamut::Srgb)
}

/// Decode capped at the given max dimensions, in the given output gamut.
pub fn decode_capped_to(hash: &[u8], max_w: u32, max_h: u32, output: Gamut) -> (u32, u32, Vec<u8>) {
    decode_capped_to_with(hash, max_w, max_h, &Tunables::DEFAULT, output)
}

/// Render a ChromaHash at an exact target raster, with explicit tunables.
///
/// Unlike [`decode_capped_to_with`], which takes a per-axis `min` against the
/// natural raster and therefore only ever renders *smaller*, this renders at
/// whatever grid it is given — including one far larger than the natural size.
/// The coefficients are unchanged; only the sampling grid moves, so this is the
/// format's own continuous reconstruction sampled densely rather than an
/// interpolation of its natural-raster samples.
///
/// The caller supplies both axes, so nothing here preserves the aspect ratio:
/// that is deliberate, because the harness renders into a reference frame whose
/// dimensions it already knows. Callers wanting the declared shape should scale
/// [`decode_output_size`]'s result themselves.
///
/// The §6.4 frequency filter still applies, so a raster *smaller* than natural
/// stays band-limited exactly as a capped decode would be. Above the natural
/// raster the filter is inert — every selected pair is representable — which is
/// what makes this the full reconstruction rather than a resampled one.
///
/// Both axes are clamped to at least 1: a zero-area render has no defined
/// output and returning an empty buffer would be a silent wrong answer.
///
/// Takes an already-validated hash, exactly as the other free functions in this
/// module do — `ChromaHash::from_bytes` is where a malformed input is rejected.
///
/// Research surface, gated on the `research-render` feature. Not part of the
/// default API and exposed by no binding — see the feature's note in
/// `Cargo.toml`.
#[cfg(feature = "research-render")]
pub fn decode_at_size_to_with(
    hash: &[u8],
    w: u32,
    h: u32,
    t: &Tunables,
    output: Gamut,
) -> (u32, u32, Vec<u8>) {
    let w = w.max(1);
    let h = h.max(1);
    let rgba = render_at_size(hash, w as usize, h as usize, t, output);
    (w, h, rgba)
}

/// Extract the average color from a ChromaHash without full decode, with
/// explicit tunables. Returns [r, g, b, a] as u8 values. Per spec §11.2.
pub fn average_color_with(hash: &[u8], t: &Tunables) -> [u8; 4] {
    let (_version, _tier, has_alpha, _aspect) = read_header_fields(hash, t);

    let mut bitpos = 8usize + t.aspect_bits as usize;
    let l_dc_q = read_bits(hash, bitpos, t.l_dc_bits);
    bitpos += t.l_dc_bits as usize;
    let a_dc_q = read_bits(hash, bitpos, t.a_dc_bits);
    bitpos += t.a_dc_bits as usize;
    let b_dc_q = read_bits(hash, bitpos, t.b_dc_bits);

    let l_dc = dequantize_l_dc(l_dc_q, t.l_dc_bits);
    let a_dc = dequantize_c_dc(a_dc_q, t.max_chroma_a, t.a_dc_bits);
    let b_dc = dequantize_c_dc(b_dc_q, t.max_chroma_b, t.b_dc_bits);

    let l_clamped = clamp01(l_dc);
    let rgb_linear = oklab_to_linear_srgb([l_clamped, a_dc, b_dc]);
    let gamma_lut = build_gamma_lut(Gamut::Srgb);

    // Alpha DC is the first field after the header prefix, in alpha mode.
    let alpha = if has_alpha {
        read_bits(hash, prefix_bits(t) as usize, t.alpha_dc_bits) as f64
            / ((1u32 << t.alpha_dc_bits) - 1) as f64
    } else {
        1.0
    };

    [
        linear_to_gamma8(clamp01(rgb_linear[0]), &gamma_lut),
        linear_to_gamma8(clamp01(rgb_linear[1]), &gamma_lut),
        linear_to_gamma8(clamp01(rgb_linear[2]), &gamma_lut),
        round_half_away_from_zero(255.0 * clamp01(alpha)) as u8,
    ]
}

/// Extract the average color from a ChromaHash without full decode.
/// Returns [r, g, b, a] as u8 values. Per spec §11.2.
pub fn average_color(hash: &[u8]) -> [u8; 4] {
    average_color_with(hash, &Tunables::DEFAULT)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Self-contained golden vectors copied from `spec/test-vectors/`. The full
    // golden cross-check lives in `tests/spec_vectors.rs`, but that reads the
    // sibling `spec/` dir which cargo-mutants' isolated per-crate build doesn't
    // stage — so the decode pipeline is pinned here too, in-crate, for the
    // mutation sweep (library tests only).

    fn assert_uniform(rgba: &[u8], px: [u8; 4]) {
        for (i, chunk) in rgba.chunks_exact(4).enumerate() {
            assert_eq!(chunk, px, "pixel {i} diverges from {px:?}");
        }
    }

    fn solid(w: u32, h: u32, r: u8, g: u8, b: u8, a: u8) -> Vec<u8> {
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for px in rgba.chunks_exact_mut(4) {
            px.copy_from_slice(&[r, g, b, a]);
        }
        rgba
    }

    // Mirrors test_vectors::gradient_image (the gradient_* spec vectors).
    fn gradient_image(w: u32, h: u32) -> Vec<u8> {
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let tx = x as f64 / (w - 1).max(1) as f64;
                let ty = y as f64 / (h - 1).max(1) as f64;
                let i = ((y * w + x) * 4) as usize;
                rgba[i] = (tx * 255.0) as u8;
                rgba[i + 1] = ((1.0 - tx) * ty * 255.0) as u8;
                rgba[i + 2] = ((1.0 - ty) * 255.0) as u8;
                rgba[i + 3] = 255;
            }
        }
        rgba
    }

    fn checkerboard_alpha(w: u32, h: u32) -> Vec<u8> {
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                if (x + y) % 2 == 0 {
                    rgba[i..i + 4].copy_from_slice(&[255, 0, 0, 255]);
                } else {
                    rgba[i..i + 4].copy_from_slice(&[0, 0, 255, 0]);
                }
            }
        }
        rgba
    }

    fn alpha_gradient(w: u32, h: u32) -> Vec<u8> {
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let a = (x as f64 / (w - 1) as f64 * 255.0) as u8;
                rgba[i..i + 4].copy_from_slice(&[200, 60, 40, a]);
            }
        }
        rgba
    }

    fn strip_gradient(w: u32, h: u32) -> Vec<u8> {
        let n = (w * h) as usize;
        let mut rgba = vec![0u8; n * 4];
        for i in 0..n {
            let t = i as f64 / (n - 1).max(1) as f64;
            rgba[i * 4] = (255.0 * (1.0 - t)) as u8;
            rgba[i * 4 + 2] = (255.0 * t) as u8;
            rgba[i * 4 + 3] = 255;
        }
        rgba
    }

    #[test]
    fn decode_output_gamut_changes_wide_gamut_color() {
        use crate::ChromaHash;
        // A saturated Display P3 green sits outside the sRGB gamut. Rendering it
        // to sRGB clips it; rendering it to P3 keeps the saturated color, so the
        // two outputs must differ. The sRGB output must also equal plain decode.
        let rgba = [0u8, 200, 80, 255].repeat(16);
        let hash = ChromaHash::encode(4, 4, &rgba, Gamut::DisplayP3);
        let (_, _, srgb) = hash.decode_to(Gamut::Srgb);
        let (_, _, p3) = hash.decode_to(Gamut::DisplayP3);
        let (_, _, default) = hash.decode();
        assert_eq!(srgb, default, "decode_to(Srgb) must equal decode()");
        assert_ne!(srgb, p3, "P3 output must differ from clipped sRGB output");
        // Bt2020/ProPhoto are not display-output gamuts → fall back to sRGB.
        let (_, _, bt) = hash.decode_to(Gamut::Bt2020);
        assert_eq!(bt, srgb, "Bt2020 output falls back to sRGB");
    }

    #[test]
    fn decode_golden_solids() {
        // A solid encodes to all-zero AC, so it decodes to a uniform field — pins
        // the header unpack, the DC dequantize, and the gamut clamp. average_color
        // on opaque hashes must report alpha 255 (the header-only DC path).
        use crate::ChromaHash;
        let gray = ChromaHash::encode(4, 4, &solid(4, 4, 128, 128, 128, 255), Gamut::Srgb);
        let (w, h, rgba) = gray.decode();
        assert_eq!((w, h), (32, 32));
        assert_uniform(&rgba, [128, 128, 128, 255]);
        assert_eq!(gray.average_color(), [128, 128, 128, 255]);

        let blue = ChromaHash::encode(4, 4, &solid(4, 4, 0, 0, 255, 255), Gamut::Srgb);
        let (w, h, rgba) = blue.decode();
        assert_eq!((w, h), (32, 32));
        assert_uniform(&rgba, [0, 0, 255, 255]);
        assert_eq!(blue.average_color(), [0, 0, 255, 255]);
    }

    #[test]
    fn decode_golden_alpha() {
        // Alpha hash: the alpha DC/scale + alpha AC must be read at the right bit
        // offsets, and `average_color` must report the sub-255 alpha — pins the
        // alpha-DC read in both the full render and the header-only path.
        use crate::ChromaHash;
        let cb = ChromaHash::encode(8, 8, &checkerboard_alpha(8, 8), Gamut::Srgb);
        let (w, h, rgba) = cb.decode();
        assert_eq!((w, h), (32, 32));
        assert_uniform(&rgba, [255, 0, 0, 132]);
        assert_eq!(cb.average_color(), [255, 0, 0, 132]);
    }

    #[test]
    fn decode_golden_gradient() {
        // A non-flat field exercises the AC read loops and the separable IDCT at
        // every pixel. gradient_200x50 → 32×8.
        use crate::ChromaHash;
        let hash = ChromaHash::encode(200, 50, &gradient_image(200, 50), Gamut::Srgb);
        let (w, h, rgba) = hash.decode();
        assert_eq!((w, h), (32, 8));
        let px = |i: usize| &rgba[i * 4..i * 4 + 4];
        assert_eq!(px(0), [39, 36, 229, 255]);
        assert_eq!(px(31), [245, 55, 226, 255]);
        assert_eq!(px(128), [0, 132, 118, 255]);
        assert_eq!(px(255), [246, 49, 0, 255]);
    }

    #[test]
    fn decode_golden_gradient_16x16() {
        // A 32×32 render reaches the high-frequency coefficients the 32×8 case
        // drops. (integration-decode.json)
        use crate::ChromaHash;
        let hash = ChromaHash::encode(16, 16, &gradient_image(16, 16), Gamut::Srgb);
        let (w, h, rgba) = hash.decode();
        assert_eq!((w, h), (32, 32));
        let px = |i: usize| &rgba[i * 4..i * 4 + 4];
        assert_eq!(px(0), [43, 45, 249, 255]);
        assert_eq!(px(16), [135, 21, 250, 255]);
        assert_eq!(px(400), [130, 53, 166, 255]);
        assert_eq!(px(600), [202, 16, 101, 255]);
        assert_eq!(px(1000), [64, 188, 0, 255]);
    }

    #[test]
    fn decode_alpha_gradient_varies() {
        // Decoded alpha must ramp across the row — pins the alpha AC bit offsets
        // and scale, which a uniform-alpha vector (checkerboard) can't reach.
        use crate::ChromaHash;
        let hash = ChromaHash::encode(8, 8, &alpha_gradient(8, 8), Gamut::Srgb);
        let (w, h, rgba) = hash.decode();
        assert_eq!((w, h), (32, 32));
        let px = |i: usize| &rgba[i * 4..i * 4 + 4];
        // First row: alpha climbs left→right; RGB stays put.
        assert_eq!(px(0), [200, 59, 38, 0]);
        assert_eq!(px(16), [200, 59, 38, 126]);
        assert_eq!(px(31), [200, 59, 38, 255]);
        assert_eq!(px(1023), [200, 59, 38, 255]);
    }

    #[test]
    fn decode_capped_golden() {
        // Capping renders at a coarser raster — pins decode_capped's size math and
        // the frequency filter that drops coefficients with cx ≥ w or cy ≥ h.
        // Sampling along the strip (not just pixel 0) makes that filter observable.
        use crate::ChromaHash;
        let strip = ChromaHash::encode(1, 100, &strip_gradient(1, 100), Gamut::Srgb);
        let (w, h, rgba) = strip.decode_capped(1, 100);
        assert_eq!((w, h), (1, 32));
        let px = |i: usize| &rgba[i * 4..i * 4 + 4];
        assert_eq!(px(0), [236, 56, 28, 255]);
        assert_eq!(px(8), [188, 0, 65, 255]);
        assert_eq!(px(16), [126, 1, 129, 255]);
        assert_eq!(px(24), [58, 0, 199, 255]);
        assert_eq!(px(31), [0, 15, 249, 255]);

        let grad = ChromaHash::encode(16, 16, &gradient_image(16, 16), Gamut::Srgb);
        let (w, h, rgba) = grad.decode_capped(8, 8);
        assert_eq!((w, h), (8, 8));
        assert_eq!(&rgba[0..4], [43, 41, 243, 255]);
    }

    #[test]
    fn decode_capped_to_golden() {
        use crate::ChromaHash;
        // decode_capped_to is the gamut-aware capped entry point; the rest of the
        // in-crate suite only reaches decode_capped (sRGB), leaving this whole
        // function unexercised. Pin its sRGB output against the golden capped
        // render and cross-check it equals decode_capped.
        let grad = ChromaHash::encode(16, 16, &gradient_image(16, 16), Gamut::Srgb);
        let bytes = grad.as_bytes();
        let (w, h, rgba) = decode_capped_to(bytes, 8, 8, Gamut::Srgb);
        assert_eq!((w, h), (8, 8));
        assert_eq!(&rgba[0..4], [43, 41, 243, 255]);
        assert_eq!(
            decode_capped_to(bytes, 8, 8, Gamut::Srgb),
            decode_capped(bytes, 8, 8),
            "decode_capped_to(Srgb) must equal decode_capped"
        );

        // The output gamut must flow through: a capped P3-encoded saturated green
        // clips in sRGB but not in P3, so the two capped renders differ.
        let p3_green = [0u8, 200, 80, 255].repeat(16);
        let hash = ChromaHash::encode(4, 4, &p3_green, Gamut::DisplayP3);
        let bytes = hash.as_bytes();
        assert_ne!(
            decode_capped_to(bytes, 4, 4, Gamut::DisplayP3),
            decode_capped_to(bytes, 4, 4, Gamut::Srgb),
            "P3 vs sRGB capped output must differ"
        );
    }

    /// `decode_at_size` is only meaningful if it is the *same* renderer the
    /// shipped entry points use, sampled on a different grid. These are the
    /// three claims that make it a measurement rather than a second decoder.
    #[cfg(feature = "research-render")]
    #[test]
    fn decode_at_size_agrees_with_the_shipped_entry_points() {
        use crate::{ChromaHash, Tunables};
        let hash = ChromaHash::encode(16, 16, &gradient_image(16, 16), Gamut::Srgb);
        let bytes = hash.as_bytes();
        let t = Tunables::DEFAULT;

        // 1. At the natural raster it must be byte-identical to a plain decode.
        //    Any difference here means a second, divergent render path.
        let (nw, nh, natural) = decode_to_with(bytes, &t, Gamut::Srgb);
        assert_eq!(
            decode_at_size_to_with(bytes, nw, nh, &t, Gamut::Srgb),
            (nw, nh, natural),
            "a render at the natural raster must equal decode"
        );

        // 2. Below natural it must be byte-identical to a capped decode -- the
        //    §6.4 frequency filter is the one thing that could differ, and a
        //    band-limited render is exactly what a capped decode promises.
        assert_eq!(
            decode_at_size_to_with(bytes, 8, 8, &t, Gamut::Srgb),
            decode_capped_to_with(bytes, 8, 8, &t, Gamut::Srgb),
            "a render below natural must equal a capped decode"
        );

        // 3. Above natural it must actually go up. This is the capability no
        //    shipped entry point has: `decode_capped_*` takes a per-axis min, so
        //    asking either of them for 64x64 returns the 16x16 natural raster.
        let (uw, uh, up) = decode_at_size_to_with(bytes, 64, 64, &t, Gamut::Srgb);
        assert_eq!((uw, uh), (64, 64));
        assert_eq!(up.len(), 64 * 64 * 4);
        assert_eq!(
            decode_capped_to_with(bytes, 64, 64, &t, Gamut::Srgb).0,
            nw,
            "capped decode must still refuse to upscale"
        );
    }

    /// The `ChromaHash` method is the surface the harness actually calls — the
    /// free function above is module-internal, since `mod decode` is private.
    /// Exercising only the free function left every mutant of the wrapper alive
    /// (12 of them), which is exactly what an untested public entry point looks
    /// like.
    #[cfg(feature = "research-render")]
    #[test]
    fn decode_at_size_tuned_is_the_free_function() {
        use crate::{ChromaHash, Tunables};
        let hash = ChromaHash::encode(16, 16, &gradient_image(16, 16), Gamut::Srgb);
        let t = Tunables::DEFAULT;

        for (w, h) in [(64u32, 64u32), (8, 8), (0, 0)] {
            let via_method = hash.decode_at_size_tuned(w, h, Gamut::Srgb, &t);
            let via_fn = decode_at_size_to_with(hash.as_bytes(), w, h, &t, Gamut::Srgb);
            assert_eq!(
                via_method, via_fn,
                "method and free function diverge at {w}x{h}"
            );
            // Pin the shape independently, so a mutant returning a plausible
            // constant tuple cannot satisfy the equality above by replacing both.
            let (mw, mh, rgba) = via_method;
            assert_eq!((mw, mh), (w.max(1), h.max(1)));
            assert_eq!(rgba.len(), (mw * mh * 4) as usize);
        }

        // The output gamut must flow through the wrapper, not be dropped: a
        // P3-encoded saturated green clips in sRGB and not in P3.
        let p3_green = [0u8, 200, 80, 255].repeat(16);
        let p3 = ChromaHash::encode(4, 4, &p3_green, Gamut::DisplayP3);
        assert_ne!(
            p3.decode_at_size_tuned(8, 8, Gamut::DisplayP3, &t),
            p3.decode_at_size_tuned(8, 8, Gamut::Srgb, &t),
            "P3 vs sRGB output must differ"
        );
    }

    /// A zero axis has no defined render. Clamping to 1 keeps the returned
    /// dimensions and the buffer length in agreement, which an empty buffer
    /// would not: a caller reading `w * h * 4` would walk off the end.
    #[cfg(feature = "research-render")]
    #[test]
    fn decode_at_size_clamps_a_zero_axis() {
        use crate::{ChromaHash, Tunables};
        let hash = ChromaHash::encode(16, 16, &gradient_image(16, 16), Gamut::Srgb);
        let (w, h, rgba) =
            decode_at_size_to_with(hash.as_bytes(), 0, 0, &Tunables::DEFAULT, Gamut::Srgb);
        assert_eq!((w, h), (1, 1));
        assert_eq!(rgba.len(), (w * h * 4) as usize);
    }
}
