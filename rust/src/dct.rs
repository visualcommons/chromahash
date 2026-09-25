use std::f64::consts::PI;

use crate::aspect::decode_output_size;
use crate::math_utils::portable_cos;

/// The AC coefficients selected for one channel, in transmission order.
/// Per spec §6 (v0.6).
pub struct Selection {
    /// Selected (cx, cy) frequency pairs, ascending by priority.
    pub coeffs: Vec<(usize, usize)>,
    /// Integer priority of each selected pair: (cx·H)² + (cy·W)².
    pub priorities: Vec<u64>,
    /// Priority of the last (highest-frequency) selected pair.
    pub p_k: u64,
}

/// Fixed-point shift for the selection weight (spec §6.2). `aniso` and `hv`
/// ride as Q12 integers and the direction term is evaluated in Q12; the weight
/// itself lands in Q16.
pub const SEL_Q: u32 = 12;
/// `1 << SEL_Q` — Q12 unity.
pub const SEL_ONE: i64 = 1 << SEL_Q;

/// Quantize a selection-weight parameter onto the Q12 grid the order is defined on.
#[inline]
pub fn sel_weight_q12(v: f64) -> i64 {
    (v * SEL_ONE as f64).round() as i64
}

/// The integer sort key of one candidate frequency. Per spec §6.2 (v1).
///
/// The order is `priority · (1 + aniso·sin²2θ) · (1 + hv·cos2θ)` — human contrast
/// sensitivity is lower on the diagonals, so the budget buys axis-aligned detail
/// first. Writing `s = (cx·H)²`, `t = (cy·W)²`, `p = s + t` and `d = s − t`, the
/// identities `cos2θ = d/p` and `sin²2θ = 1 − (d/p)²` collapse both factors into
/// polynomials in the single ratio `d/p`, which is what makes an exact integer
/// form possible at all:
///
/// ```text
///   X = trunc(d · 2^12 / p)                 ∈ [−2^12, 2^12]   (Q12)
///   U = (2^12 + A)·2^12 − ((A·X²) >> 12)    ≥ 2^24            (Q24)
///   V = 2^24 + H·X                          > 0               (Q24)
///   W = (U·V) >> 32                                           (Q16)
///   key = p · W
/// ```
///
/// `A`/`H` are `aniso`/`hv` in Q12; `>>` is an arithmetic (floor) shift and `/`
/// truncates toward zero. With `A = H = 0` the key is exactly `p << 16`, so the
/// unweighted order of v0.6 is this order with the weights zeroed, coefficient
/// for coefficient. Every intermediate stays under 2^51 for the parameter ranges
/// the format allows (`aniso ∈ [0, 8]`, `|hv| < 1`) at every tier, so an
/// implementation with exact 53-bit integers — a JavaScript `number` — computes
/// it without a bignum, and the order is bit-exact across languages.
#[inline]
pub fn selection_key(px: u64, py: u64, a_q12: i64, h_q12: i64) -> u64 {
    let s = (px * px) as i64;
    let t = (py * py) as i64;
    let p = s + t;
    if a_q12 == 0 && h_q12 == 0 {
        return (p as u64) << 16;
    }
    let x = (s - t) * SEL_ONE / p;
    let u = (SEL_ONE + a_q12) * SEL_ONE - ((a_q12 * x * x) >> SEL_Q);
    let v = SEL_ONE * SEL_ONE + h_q12 * x;
    (p as u64) * ((u * v) >> 32) as u64
}

/// Every candidate frequency for one (aspect byte, tier), sorted into selection
/// order once. Per spec §6.
///
/// Candidates are all (cx, cy) in [0, W) × [0, H) except DC, where (W, H) =
/// decodeOutputSize(aspect_byte, tier) — exactly the frequencies representable
/// at the natural render, which makes selecting an unrepresentable (aliasing)
/// frequency structurally impossible. Ties on the key break by (cx, cy)
/// ascending.
///
/// Every per-channel selection at a tier is a **prefix** of this one list, so
/// luma, chroma and alpha share a single sort instead of repeating it per
/// channel. The candidate count is ≥ 64·4^level − 1 for every aspect byte (the
/// 16:1 extreme), and every per-channel K(tier) the format uses is below that
/// bound, so every selection is fully satisfied.
pub struct SelectionOrder {
    entries: Vec<(u64, usize, usize)>,
    w: usize,
    h: usize,
}

impl SelectionOrder {
    /// Sort the candidate grid for one (aspect byte, tier) under the §6.2 weights.
    pub fn new(aspect_byte: u8, tier: u8, aniso: f64, hv: f64) -> Self {
        let (w, h) = decode_output_size(aspect_byte, tier);
        let (w, h) = (w as usize, h as usize);
        let (a_q12, h_q12) = (sel_weight_q12(aniso), sel_weight_q12(hv));
        let mut entries: Vec<(u64, usize, usize)> = Vec::with_capacity(w * h - 1);
        for cy in 0..h {
            for cx in 0..w {
                if cx == 0 && cy == 0 {
                    continue;
                }
                let key = selection_key((cx * h) as u64, (cy * w) as u64, a_q12, h_q12);
                entries.push((key, cx, cy));
            }
        }
        entries.sort_unstable_by_key(|&(key, cx, cy)| (key, cx, cy));
        Self { entries, w, h }
    }

    /// The first `k` frequencies in selection order.
    ///
    /// `priorities`/`p_k` report the **unweighted** integer priority
    /// `(cx·H)² + (cy·W)²`: the synthesis window and the CfL taper are defined
    /// on the true spatial frequency, not on the perceptual sort key.
    pub fn take(&self, k: usize) -> Selection {
        let n = k.min(self.entries.len());
        let mut coeffs = Vec::with_capacity(n);
        let mut priorities = Vec::with_capacity(n);
        for &(_, cx, cy) in &self.entries[..n] {
            let (px, py) = ((cx * self.h) as u64, (cy * self.w) as u64);
            coeffs.push((cx, cy));
            priorities.push(px * px + py * py);
        }
        let p_k = priorities.last().copied().unwrap_or(1);
        Selection {
            coeffs,
            priorities,
            p_k,
        }
    }
}

/// Merged AC write order for the embedded/progressive layout: `(channel, index)`
/// pairs sorted by frequency priority (L = 0, a = 1, b = 2), with the channel
/// and index as deterministic tie-breaks. Encoder and decoder derive it from the
/// selections alone, so it costs no bits.
pub fn interleaved_order(
    l_sel: &Selection,
    c_sel: &Selection,
    l_count: usize,
    c_count: usize,
) -> Vec<(u8, usize)> {
    let mut v: Vec<(u64, u8, usize)> = Vec::with_capacity(l_count + 2 * c_count);
    for i in 0..l_count.min(l_sel.priorities.len()) {
        v.push((l_sel.priorities[i], 0, i));
    }
    for ch in [1u8, 2] {
        for i in 0..c_count.min(c_sel.priorities.len()) {
            v.push((c_sel.priorities[i], ch, i));
        }
    }
    v.sort_unstable();
    v.into_iter().map(|(_, ch, i)| (ch, i)).collect()
}

/// Decode-side synthesis window weights for a selection. Per spec §11 (v0.6).
///
/// w_j = w_min + (1 − w_min) · ((1 + cos(π·ρ_j)) / 2)^w_exp with
/// ρ_j = sqrt(priority_j / P_K) ∈ (0, 1]. Tapering high-frequency amplitudes
/// suppresses the Gibbs ringing/banding that sparse unwindowed cosines
/// produce — and because it is applied after dequantization, it attenuates
/// quantization noise by the same factor. w_min = 1.0 disables the window.
/// Portable: integer priorities, IEEE-correctly-rounded sqrt, portable_cos,
/// and an integer exponent evaluated as repeated multiplication.
pub fn window_weights(selection: &Selection, w_min: f64, w_exp: u32) -> Vec<f64> {
    selection
        .priorities
        .iter()
        .map(|&p| {
            if w_min >= 1.0 {
                return 1.0;
            }
            let rho = (p as f64 / selection.p_k as f64).sqrt();
            let hann = (1.0 + portable_cos(PI * rho)) / 2.0;
            let mut powed = 1.0;
            for _ in 0..w_exp {
                powed *= hann;
            }
            w_min + (1.0 - w_min) * powed
        })
        .collect()
}

/// Precompute cosine table for DCT: table[freq][pos] = cos(π/dim · freq · (pos+0.5)).
/// Per spec §12.6. Uses portable_cos for cross-platform determinism.
pub fn precompute_cos_table(dim: usize, max_freq: usize) -> Vec<Vec<f64>> {
    let mut table = Vec::with_capacity(max_freq);
    for freq in 0..max_freq {
        let mut row = Vec::with_capacity(dim);
        for pos in 0..dim {
            row.push(cos_entry(dim, freq, pos));
        }
        table.push(row);
    }
    table
}

/// One cosine-table entry. Both table layouts call this, so they hold the
/// same `f64` at the same `(freq, pos)` by construction.
#[inline]
fn cos_entry(dim: usize, freq: usize, pos: usize) -> f64 {
    portable_cos(PI / dim as f64 * freq as f64 * (pos as f64 + 0.5))
}

/// [`precompute_cos_table`] as one contiguous row-major array:
/// `flat[freq * dim + pos] == table[freq][pos]`. The decoder's render loop
/// reads a cosine per coefficient per pixel, and a `Vec<Vec<f64>>` costs a
/// pointer chase for each — `spec/PERFORMANCE.md` §12.1 item 4(b).
pub fn precompute_cos_table_flat(dim: usize, max_freq: usize) -> Vec<f64> {
    let mut flat = Vec::with_capacity(dim * max_freq);
    for freq in 0..max_freq {
        for pos in 0..dim {
            flat.push(cos_entry(dim, freq, pos));
        }
    }
    flat
}

/// Forward DCT over the selected coefficients. Per spec §10 (v0.6).
/// Returns (dc, ac_in_selection_order, scale).
///
/// Frequency clamp: a selected (cx, cy) with cx ≥ w or cy ≥ h cannot be
/// represented by the w×h source samples — the basis is not orthogonal there
/// and the projection degenerates (e.g. F(2, cy) ≈ −DC on a 1-px-wide image,
/// the v0.5 dim-1xN catastrophe). Such coefficients are emitted as exact 0
/// and excluded from the scale max.
pub fn dct_encode_selected(
    channel: &[f64],
    w: usize,
    h: usize,
    coeffs: &[(usize, usize)],
    cos_x: &[Vec<f64>],
    cos_y: &[Vec<f64>],
) -> (f64, Vec<f64>, f64) {
    let wh = (w * h) as f64;

    // DC = mean (cos_x[0] and cos_y[0] are all-ones by construction)
    let dc: f64 = channel.iter().sum::<f64>() / wh;

    let mut ac = Vec::with_capacity(coeffs.len());
    let mut scale = 0.0_f64;

    for &(cx, cy) in coeffs {
        if cx >= w || cy >= h {
            ac.push(0.0);
            continue;
        }
        let cy_row = &cos_y[cy];
        let cx_row = &cos_x[cx];
        let mut f = 0.0;
        for y in 0..h {
            let fy = cy_row[y];
            for x in 0..w {
                f += channel[x + y * w] * cx_row[x] * fy;
            }
        }
        f /= wh;
        ac.push(f);
        scale = scale.max(f.abs());
    }

    // Floor near-zero scale to exactly zero. When the channel is (near-)constant,
    // floating-point noise in cosine sums produces tiny AC values. Without this
    // threshold, dividing AC/scale amplifies platform-specific ULP differences
    // into divergent quantized codes.
    if scale < 1e-10 {
        ac.fill(0.0);
        scale = 0.0;
    }

    (dc, ac, scale)
}

/// Coefficients one pass of [`dct_encode_selected_lanes`] computes together.
const DCT_LANES: usize = 4;

/// [`dct_encode_selected`], computing [`DCT_LANES`] coefficients per pass over
/// the channel — `spec/PERFORMANCE.md` §12.1 item 3. Byte-identical to it, and
/// the reason is structural rather than empirical:
///
/// * **Lanes are coefficients, never pixels.** Each lane is one `(cx, cy)`
///   pair's own accumulator, visiting pixels in the same row-major order as
///   the scalar loop, so no sum is split or reassociated. Vectorizing across
///   pixels instead would reorder the reduction and change bytes.
/// * **The per-term expression is the scalar one.** A lane adds
///   `channel · cos_x · cos_y`, grouped `(channel · cos_x) · cos_y` exactly as
///   `f += channel[i] * cx_row[x] * fy` parses. It is written with separate
///   multiplies and one add: Rust never contracts `a * b + c` into a fused
///   multiply-add (that needs an explicit `mul_add`), and there are no
///   hand-written intrinsics here for anyone to reach for `fmadd` in.
///
/// The only thing that changes is how the work is scheduled: the channel is
/// read once per group of lanes instead of once per coefficient, and each
/// group's `cos_x` rows are interleaved so a pixel's lane factors are
/// contiguous. The compiler may map the lanes onto vector registers; lane
/// arithmetic under IEEE 754 does not depend on whether it does.
pub fn dct_encode_selected_lanes(
    channel: &[f64],
    w: usize,
    h: usize,
    coeffs: &[(usize, usize)],
    cos_x: &[Vec<f64>],
    cos_y: &[Vec<f64>],
) -> (f64, Vec<f64>, f64) {
    let wh = (w * h) as f64;
    let dc: f64 = channel.iter().sum::<f64>() / wh;

    // The representable coefficients, in selection order. A dead one is an
    // exact 0.0 exactly as in the scalar path, and takes no lane.
    let mut ac = vec![0.0f64; coeffs.len()];
    let live: Vec<usize> = (0..coeffs.len())
        .filter(|&j| coeffs[j].0 < w && coeffs[j].1 < h)
        .collect();

    let mut gx = vec![0.0f64; w * DCT_LANES];
    for group in live.chunks(DCT_LANES) {
        let n = group.len();
        // Interleave this group's cos_x rows: gx[x·LANES + k] = cos_x[cx_k][x].
        // A short final group pads with lanes that are computed and discarded.
        for (k, &j) in group.iter().enumerate() {
            let row = &cos_x[coeffs[j].0];
            for x in 0..w {
                gx[x * DCT_LANES + k] = row[x];
            }
        }
        let mut acc = [0.0f64; DCT_LANES];
        for y in 0..h {
            let mut fy = [0.0f64; DCT_LANES];
            for (k, &j) in group.iter().enumerate() {
                fy[k] = cos_y[coeffs[j].1][y];
            }
            let row = &channel[y * w..y * w + w];
            for (x, &c) in row.iter().enumerate() {
                let g = &gx[x * DCT_LANES..x * DCT_LANES + DCT_LANES];
                for k in 0..DCT_LANES {
                    acc[k] += c * g[k] * fy[k];
                }
            }
        }
        for k in 0..n {
            ac[group[k]] = acc[k] / wh;
        }
    }

    let mut scale = 0.0_f64;
    for &f in &ac {
        scale = scale.max(f.abs());
    }
    if scale < 1e-10 {
        ac.fill(0.0);
        scale = 0.0;
    }
    (dc, ac, scale)
}

/// Inverse DCT at a single pixel using precomputed cosine tables. Per spec §12.6.
/// The cx/cy factors stay as separate multiplies to preserve the exact
/// floating-point operation order. cos_x/cos_y must cover all (cx, cy) in scan.
pub fn dct_decode_pixel_separable(
    dc: f64,
    ac: &[f64],
    scan: &[(usize, usize)],
    x: usize,
    y: usize,
    cos_x: &[Vec<f64>],
    cos_y: &[Vec<f64>],
) -> f64 {
    let mut value = dc;
    for (j, &(cx, cy)) in scan.iter().enumerate() {
        let cx_factor = if cx > 0 { 2.0 } else { 1.0 };
        let cy_factor = if cy > 0 { 2.0 } else { 1.0 };
        let fx = cos_x[cx][x];
        let fy = cos_y[cy][y];
        value += ac[j] * fx * fy * cx_factor * cy_factor;
    }
    value
}

/// [`dct_decode_pixel_separable`] over [`precompute_cos_table_flat`]'s layout:
/// `cos_x` has row stride `w` and `cos_y` row stride `h`. The same factors,
/// multiplied in the same order, summed in scan order.
#[allow(clippy::too_many_arguments)]
#[inline]
pub fn dct_decode_pixel_flat(
    dc: f64,
    ac: &[f64],
    scan: &[(usize, usize)],
    x: usize,
    y: usize,
    cos_x: &[f64],
    w: usize,
    cos_y: &[f64],
    h: usize,
) -> f64 {
    let mut value = dc;
    for (j, &(cx, cy)) in scan.iter().enumerate() {
        let cx_factor = if cx > 0 { 2.0 } else { 1.0 };
        let cy_factor = if cy > 0 { 2.0 } else { 1.0 };
        let fx = cos_x[cx * w + x];
        let fy = cos_y[cy * h + y];
        value += ac[j] * fx * fy * cx_factor * cy_factor;
    }
    value
}

/// Separable forward DCT over the selected coefficients — **prototype only**.
///
/// [`dct_encode_selected`] evaluates a full 2-D sum per selected coefficient, so
/// it costs `K·W·H`. Most selected pairs share an `x` frequency, so the inner
/// sum can be factored: one row pass per *distinct* `cx` (`Cx·W·H`), then a
/// length-`H` column reduction per coefficient (`K·H`). The saving is roughly
/// `K / Cx`, and both grow with the tier — `K` by `4^level` and `Cx` by
/// `2^level` — so the wider the tier, the more there is to win. Stage timing
/// puts the forward DCT at the overwhelming majority of an encode, rising with
/// both size and tier (`spec/PERFORMANCE.md` §1), which is what makes this
/// worth measuring.
///
/// **This is not byte-identical to [`dct_encode_selected`] and must never be
/// enabled in a shipped build.** Floating-point addition is not associative, so
/// factoring the sum changes the last bits of each coefficient, and a
/// coefficient sitting near a quantization boundary can then land on a different
/// code. It is reachable only through `Tunables::dct_separable`, which is
/// `false` in `Tunables::DEFAULT` and which no binding exposes — adopting it
/// would be a format change requiring a version bump, regenerated spec vectors,
/// and every language landing together.
pub fn dct_encode_selected_separable(
    channel: &[f64],
    w: usize,
    h: usize,
    coeffs: &[(usize, usize)],
    cos_x: &[Vec<f64>],
    cos_y: &[Vec<f64>],
) -> (f64, Vec<f64>, f64) {
    let wh = (w * h) as f64;
    let dc: f64 = channel.iter().sum::<f64>() / wh;

    // Row pass, memoized per distinct cx: rows[cx][y] = sum_x channel[x, y]·cos_x[cx][x].
    let mut rows: Vec<Option<Vec<f64>>> = vec![None; cos_x.len()];
    for &(cx, cy) in coeffs {
        if cx >= w || cy >= h || rows[cx].is_some() {
            continue;
        }
        // The memoization guard duplicates the clamp below, and on its own is
        // unobservable — a row built for a dead frequency is simply never read,
        // so a mutated guard produces identical output. This states the
        // invariant instead, which `[profile.mutants]` (debug-assertions on)
        // turns into a real check: building a row for cx >= w means the guard
        // stopped agreeing with the clamp.
        debug_assert!(
            cx < w && cy < h,
            "row pass reached a frequency the source cannot represent"
        );
        let cx_row = &cos_x[cx];
        let mut acc = vec![0.0f64; h];
        for (y, slot) in acc.iter_mut().enumerate() {
            let mut sum = 0.0;
            for x in 0..w {
                sum += channel[x + y * w] * cx_row[x];
            }
            *slot = sum;
        }
        rows[cx] = Some(acc);
    }

    let mut ac = Vec::with_capacity(coeffs.len());
    let mut scale = 0.0_f64;
    for &(cx, cy) in coeffs {
        // Same frequency clamp as the direct form: a frequency the source cannot
        // represent is emitted as exact zero and excluded from the scale max.
        if cx >= w || cy >= h {
            ac.push(0.0);
            continue;
        }
        let row = rows[cx].as_ref().expect("row pass ran for every live cx");
        let cy_row = &cos_y[cy];
        let mut f = 0.0;
        for y in 0..h {
            f += row[y] * cy_row[y];
        }
        f /= wh;
        ac.push(f);
        scale = scale.max(f.abs());
    }

    if scale < 1e-10 {
        ac.fill(0.0);
        scale = 0.0;
    }

    (dc, ac, scale)
}

#[cfg(test)]
mod tests {

    /// The bare priority order (both selection weights zeroed) — the base the
    /// weighted order of §6.2 must reproduce exactly at `aniso = hv = 0`.
    fn select_coefficients(aspect_byte: u8, tier: u8, k: usize) -> Selection {
        SelectionOrder::new(aspect_byte, tier, 0.0, 0.0).take(k)
    }

    /// One-shot weighted selection, for the tests that only need a single K.
    fn select_coefficients_weighted(
        aspect_byte: u8,
        tier: u8,
        k: usize,
        aniso: f64,
        hv: f64,
    ) -> Selection {
        SelectionOrder::new(aspect_byte, tier, aniso, hv).take(k)
    }
    use super::*;

    #[test]
    fn selection_counts() {
        for byte in [0u8, 64, 128, 191, 255] {
            for k in [5usize, 9, 11, 24, 27] {
                let sel = select_coefficients(byte, 0, k);
                assert_eq!(sel.coeffs.len(), k, "byte={byte} k={k}");
                assert_eq!(sel.priorities.len(), k);
            }
        }
    }

    #[test]
    fn weighted_selection_zero_matches_integer_path() {
        // aniso = 0.0 must be the shipped selection, coefficient for coefficient.
        for byte in [0u8, 64, 128, 191, 255] {
            for tier in [1u8, 2] {
                let base = select_coefficients(byte, tier, 26);
                let weighted = select_coefficients_weighted(byte, tier, 26, 0.0, 0.0);
                assert_eq!(base.coeffs, weighted.coeffs, "byte={byte} tier={tier}");
                assert_eq!(base.priorities, weighted.priorities);
                assert_eq!(base.p_k, weighted.p_k);
            }
        }
    }

    #[test]
    fn integer_selection_key_matches_the_real_valued_weight() {
        // The spec orders on an exact integer key; the *definition* it stands in
        // for is priority·(1 + aniso·sin²2θ)·(1 + hv·cos2θ) over the reals. Pin
        // the two together at the shipped weights over every aspect byte, at the
        // tier whose order the format actually transmits in.
        let t = crate::constants::Tunables::DEFAULT;
        for byte in 0u8..=255 {
            let (w, h) = decode_output_size(byte, 0);
            let (w, h) = (w as usize, h as usize);
            let mut real: Vec<(f64, usize, usize)> = Vec::new();
            for cy in 0..h {
                for cx in 0..w {
                    if cx == 0 && cy == 0 {
                        continue;
                    }
                    let (px, py) = ((cx * h) as f64, (cy * w) as f64);
                    let p = px * px + py * py;
                    let sin2_2t = (2.0 * px * py) * (2.0 * px * py) / (p * p);
                    let cos_2t = (px * px - py * py) / p;
                    let key = p * (1.0 + t.aniso_oblique * sin2_2t) * (1.0 + t.sel_hv * cos_2t);
                    real.push((key, cx, cy));
                }
            }
            real.sort_by(|a, b| {
                a.0.total_cmp(&b.0)
                    .then_with(|| (a.1, a.2).cmp(&(b.1, b.2)))
            });
            let order = SelectionOrder::new(byte, 0, t.aniso_oblique, t.sel_hv);
            for &k in &[5usize, 9, 15, 20, 28] {
                let want: Vec<(usize, usize)> =
                    real.iter().take(k).map(|&(_, cx, cy)| (cx, cy)).collect();
                assert_eq!(order.take(k).coeffs, want, "byte={byte} k={k}");
            }
        }
    }

    #[test]
    fn selection_key_stays_inside_53_bits() {
        // An implementation with exact 53-bit integers (a JavaScript `number`)
        // must be able to evaluate the key without a bignum at every tier.
        let t = crate::constants::Tunables::DEFAULT;
        let (a, hv) = (sel_weight_q12(t.aniso_oblique), sel_weight_q12(t.sel_hv));
        let mut worst = 0u64;
        for tier in 0..=crate::constants::MAX_TIER {
            for byte in [0u8, 128, 255] {
                let (w, h) = decode_output_size(byte, tier);
                let (w, h) = (w as usize, h as usize);
                for &(cx, cy) in &[(w - 1, h - 1), (w - 1, 0), (0, h - 1)] {
                    worst = worst.max(selection_key((cx * h) as u64, (cy * w) as u64, a, hv));
                }
            }
        }
        assert!(
            worst < (1u64 << 53),
            "worst key {worst} needs more than 53 bits"
        );
    }

    #[test]
    fn weighted_selection_penalizes_diagonals() {
        // Square grid: (1,1) has priority 2·32² = 2048 and sin²2θ = 1, while
        // (2,0)/(0,2) have priority 4096 and sin²2θ = 0. With aniso = 1.5 the
        // diagonal's weighted key (5120) exceeds the axis pair's (4096), so the
        // axis frequencies must now be selected first.
        let sel = select_coefficients_weighted(128, 0, 4, 1.5, 0.0);
        let first_four = &sel.coeffs[..4];
        assert!(first_four.contains(&(2, 0)), "got {first_four:?}");
        assert!(first_four.contains(&(0, 2)), "got {first_four:?}");
        assert!(!first_four.contains(&(1, 1)), "got {first_four:?}");
        // The unweighted order keeps (1,1) ahead of (2,0).
        let base = select_coefficients(128, 0, 4);
        assert!(base.coeffs[..3].contains(&(1, 1)));
    }

    #[test]
    fn selection_scales_with_tier() {
        // Priority (cx·H)² + (cy·W)² scales uniformly by 4^level when the grid
        // doubles, so the *same* K returns the *same* low frequencies at any
        // tier. The higher tier's larger grid is what lets K itself scale by
        // 4^level and reach genuinely higher frequencies — always satisfiable.
        assert_eq!(
            select_coefficients(128, 1, 26).coeffs,
            select_coefficients(128, 3, 26).coeffs,
            "same K ⇒ same low frequencies across tiers"
        );
        for tier in 0u8..=crate::constants::MAX_TIER {
            let level = crate::constants::render_level(tier) as usize;
            let k = 26usize << (2 * level); // 26·4^level
            assert_eq!(
                select_coefficients(255, tier, k).coeffs.len(),
                k,
                "K(tier) must be fully satisfied even at 16:1, tier={tier}"
            );
        }
        let max_base = select_coefficients(128, crate::constants::DEFAULT_TIER, 26)
            .coeffs
            .iter()
            .map(|&(cx, cy)| cx.max(cy))
            .max()
            .unwrap();
        let max_top = select_coefficients(128, crate::constants::MAX_TIER, 26 << 6)
            .coeffs
            .iter()
            .map(|&(cx, cy)| cx.max(cy))
            .max()
            .unwrap();
        assert!(
            max_top > max_base,
            "the top tier must reach higher frequencies: {max_top} vs {max_base}"
        );
    }

    #[test]
    fn selection_square_is_radial_l2_ball() {
        // byte=128 → (W,H) = (32,32); priority ∝ cx² + cy².
        let sel = select_coefficients(128, 0, 9);
        let expected = vec![
            (0, 1), // 1
            (1, 0), // 1 (tie broken by cx? no: (0,1) has cx=0 < 1)
            (1, 1), // 2
            (0, 2), // 4
            (2, 0), // 4
            (1, 2), // 5
            (2, 1), // 5
            (2, 2), // 8
            (0, 3), // 9
        ];
        assert_eq!(sel.coeffs, expected);
    }

    #[test]
    fn selection_square_27_includes_diagonals_over_axis_extremes() {
        // The ℓ2 ball (v0.6) should include (3,4)/(4,3) (priority 25) and
        // exclude (6,0)/(0,6) (priority 36) at K=27 — the opposite of the
        // v0.5 ℓ1 triangle.
        let sel = select_coefficients(128, 0, 27);
        assert!(sel.coeffs.contains(&(3, 4)));
        assert!(sel.coeffs.contains(&(4, 3)));
        assert!(!sel.coeffs.contains(&(6, 0)));
        assert!(!sel.coeffs.contains(&(0, 6)));
    }

    #[test]
    fn selection_priorities_ascending() {
        for byte in [0u8, 100, 128, 200, 255] {
            let sel = select_coefficients(byte, 0, 24);
            for pair in sel.priorities.windows(2) {
                assert!(pair[0] <= pair[1], "priorities must be ascending");
            }
            assert_eq!(*sel.priorities.last().unwrap(), sel.p_k);
        }
    }

    #[test]
    fn selection_bounded_by_output_size() {
        // No selected frequency may equal or exceed the natural render dims.
        for byte in 0u8..=255 {
            let (w, h) = decode_output_size(byte, 0);
            let sel = select_coefficients(byte, 0, 27);
            for &(cx, cy) in &sel.coeffs {
                assert!(cx < w as usize, "cx={cx} ≥ W={w} for byte={byte}");
                assert!(cy < h as usize, "cy={cy} ≥ H={h} for byte={byte}");
            }
        }
    }

    #[test]
    fn selection_extreme_landscape_prefers_long_axis() {
        // byte=255 → (W,H)=(32,2): cy is twice as expensive as 16·cx,
        // so the selection should be dominated by (cx, 0) terms.
        let sel = select_coefficients(255, 0, 24);
        let cy0 = sel.coeffs.iter().filter(|&&(_, cy)| cy == 0).count();
        assert!(cy0 >= 15, "expected mostly cy=0 terms, got {cy0}");
    }

    #[test]
    fn window_weights_disabled_at_one() {
        let sel = select_coefficients(128, 0, 24);
        let w = window_weights(&sel, 1.0, 1);
        assert!(w.iter().all(|&x| x == 1.0));
    }

    #[test]
    fn window_weights_monotone_and_bounded() {
        let sel = select_coefficients(128, 0, 24);
        let w = window_weights(&sel, 0.3, 1);
        for pair in w.windows(2) {
            assert!(
                pair[0] >= pair[1] - 1e-12,
                "weights should be non-increasing in priority"
            );
        }
        // Boundary coefficient gets exactly w_min (ρ=1 → hann=0).
        assert!((w.last().unwrap() - 0.3).abs() < 1e-12);
        assert!(w.iter().all(|&x| (0.3..=1.0).contains(&x)));
    }

    // ── Separable forward DCT prototype ──────────────────────────────────
    //
    // The prototype is unreachable from any shipped path, so nothing else in the
    // suite would notice if it broke. These pin it directly — and they are what
    // keeps the mutation sweep honest about a function no golden vector covers.

    /// A channel with real structure at several frequencies, so the two forms
    /// have something to disagree about.
    fn textured_channel(w: usize, h: usize) -> Vec<f64> {
        let mut c = vec![0.0; w * h];
        for y in 0..h {
            for x in 0..w {
                let fx = x as f64 / w as f64;
                let fy = y as f64 / h as f64;
                c[x + y * w] = 0.5 + 0.3 * (fx * 7.0).cos() + 0.2 * (fy * 5.0).sin()
                    - 0.1 * ((fx + fy) * 11.0).cos();
            }
        }
        c
    }

    #[test]
    fn separable_dct_agrees_with_the_direct_form() {
        // Not asserted bit-for-bit: factoring the sum reassociates the additions,
        // which is exactly why the prototype is not byte-identical and cannot
        // ship without a format change. What must hold is that it computes the
        // same transform to within reassociation error.
        for &(w, h) in &[(4, 4), (8, 4), (4, 8), (16, 16), (13, 7)] {
            let channel = textured_channel(w, h);
            let sel = select_coefficients(128, 1, 12);
            let cos_x = precompute_cos_table(w, 32);
            let cos_y = precompute_cos_table(h, 32);
            let (dc_a, ac_a, scale_a) =
                dct_encode_selected(&channel, w, h, &sel.coeffs, &cos_x, &cos_y);
            let (dc_b, ac_b, scale_b) =
                dct_encode_selected_separable(&channel, w, h, &sel.coeffs, &cos_x, &cos_y);
            assert!((dc_a - dc_b).abs() < 1e-12, "{w}x{h}: DC {dc_a} vs {dc_b}");
            assert!(
                (scale_a - scale_b).abs() < 1e-12,
                "{w}x{h}: scale {scale_a} vs {scale_b}"
            );
            assert_eq!(ac_a.len(), ac_b.len());
            for (i, (a, b)) in ac_a.iter().zip(ac_b.iter()).enumerate() {
                assert!((a - b).abs() < 1e-12, "{w}x{h}: AC[{i}] {a} vs {b}");
            }
        }
    }

    #[test]
    fn separable_dct_clamps_frequencies_the_source_cannot_represent() {
        // cx >= w or cy >= h must be emitted as exact zero and left out of the
        // scale max — the v0.5 dim-1xN catastrophe the direct form guards against.
        let (w, h) = (2, 2);
        let channel = textured_channel(w, h);
        let cos_x = precompute_cos_table(w, 8);
        let cos_y = precompute_cos_table(h, 8);
        let coeffs = vec![(0, 1), (1, 0), (5, 0), (0, 6), (7, 7)];
        let (_, ac, scale) = dct_encode_selected_separable(&channel, w, h, &coeffs, &cos_x, &cos_y);
        assert_eq!(ac[2], 0.0, "cx >= w must be exactly zero");
        assert_eq!(ac[3], 0.0, "cy >= h must be exactly zero");
        assert_eq!(ac[4], 0.0, "both out of range must be exactly zero");
        let live_max = ac[0].abs().max(ac[1].abs());
        assert_eq!(scale, live_max, "scale must ignore the clamped entries");
    }

    #[test]
    fn separable_dct_floors_a_constant_channel_to_zero() {
        let (w, h) = (4, 4);
        let channel = vec![0.5; w * h];
        let sel = select_coefficients(128, 0, 9);
        let cos_x = precompute_cos_table(w, 8);
        let cos_y = precompute_cos_table(h, 8);
        let (dc, ac, scale) =
            dct_encode_selected_separable(&channel, w, h, &sel.coeffs, &cos_x, &cos_y);
        assert!((dc - 0.5).abs() < 1e-12);
        assert_eq!(scale, 0.0, "near-zero scale must floor to exactly 0");
        assert!(ac.iter().all(|&v| v == 0.0), "and zero every coefficient");
    }

    #[test]
    fn separable_dct_handles_degenerate_dimensions() {
        for &(w, h) in &[(1, 8), (8, 1), (1, 1)] {
            let channel = textured_channel(w, h);
            let sel = select_coefficients(128, 1, 6);
            let cos_x = precompute_cos_table(w, 16);
            let cos_y = precompute_cos_table(h, 16);
            let (dc_a, ac_a, _) = dct_encode_selected(&channel, w, h, &sel.coeffs, &cos_x, &cos_y);
            let (dc_b, ac_b, _) =
                dct_encode_selected_separable(&channel, w, h, &sel.coeffs, &cos_x, &cos_y);
            assert!((dc_a - dc_b).abs() < 1e-12, "{w}x{h}");
            for (a, b) in ac_a.iter().zip(ac_b.iter()) {
                assert!((a - b).abs() < 1e-12, "{w}x{h}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn separable_dct_is_off_in_the_shipped_defaults() {
        // If this ever fails, the prototype has been adopted — which is a format
        // change, and every golden vector in spec/test-vectors must have been
        // regenerated with it.
        // Read through black_box so this is a real runtime check rather than a
        // constant clippy can fold away (and warn about).
        let shipped = std::hint::black_box(&crate::constants::Tunables::DEFAULT).dct_separable;
        assert!(
            !shipped,
            "dct_separable must stay off: the separable transform is not byte-identical"
        );
    }

    #[test]
    fn dc_of_constant_channel() {
        let w = 4;
        let h = 4;
        let val = 0.7;
        let channel = vec![val; w * h];
        let sel = select_coefficients(128, 0, 9);
        let cos_x = precompute_cos_table(w, 8);
        let cos_y = precompute_cos_table(h, 8);
        let (dc, _, _) = dct_encode_selected(&channel, w, h, &sel.coeffs, &cos_x, &cos_y);
        assert!(
            (dc - val).abs() < 1e-12,
            "DC of constant channel should = {val}, got {dc}"
        );
    }

    #[test]
    fn ac_of_constant_channel_is_zero() {
        let w = 4;
        let h = 4;
        let channel = vec![0.5; w * h];
        let sel = select_coefficients(128, 0, 9);
        let cos_x = precompute_cos_table(w, 8);
        let cos_y = precompute_cos_table(h, 8);
        let (_, ac, scale) = dct_encode_selected(&channel, w, h, &sel.coeffs, &cos_x, &cos_y);
        assert_eq!(scale, 0.0, "AC scale of constant channel should be 0");
        assert!(ac.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn frequency_clamp_zeroes_unrepresentable() {
        // 1-px-wide source: every cx ≥ 1 coefficient must be exactly 0 and
        // must not contaminate the scale (the v0.5 dim-1xN catastrophe).
        let w = 1;
        let h = 16;
        let channel: Vec<f64> = (0..h).map(|y| y as f64 / 15.0).collect();
        let sel = select_coefficients(0, 0, 24); // byte 0, tier 0 → (W,H)=(2,32)
        let cos_x = precompute_cos_table(w, 2);
        let cos_y = precompute_cos_table(h, 32);
        let (_, ac, scale) = dct_encode_selected(&channel, w, h, &sel.coeffs, &cos_x, &cos_y);
        for (j, &(cx, _)) in sel.coeffs.iter().enumerate() {
            if cx >= w {
                assert_eq!(ac[j], 0.0, "clamped coefficient {j} must be 0");
            }
        }
        // The vertical gradient has strong (0,1) energy; scale must reflect
        // it rather than a degenerate ±DC junk value.
        assert!(scale > 0.05 && scale < 0.5, "scale={scale}");
    }

    #[test]
    fn encode_decode_roundtrip_constant() {
        let w = 8;
        let h = 8;
        let val = 0.42;
        let channel = vec![val; w * h];
        let sel = select_coefficients(128, 0, 9);
        let cos_x = precompute_cos_table(w, 8);
        let cos_y = precompute_cos_table(h, 8);
        let (dc, ac, _) = dct_encode_selected(&channel, w, h, &sel.coeffs, &cos_x, &cos_y);

        for y in 0..h {
            for x in 0..w {
                let r = dct_decode_pixel_separable(dc, &ac, &sel.coeffs, x, y, &cos_x, &cos_y);
                assert!(
                    (r - val).abs() < 1e-10,
                    "constant roundtrip failed at ({x},{y}): got {r}"
                );
            }
        }
    }

    #[test]
    fn encode_decode_gradient_reasonable() {
        let w = 8;
        let h = 8;
        let mut channel = vec![0.0; w * h];
        for y in 0..h {
            for x in 0..w {
                channel[x + y * w] = (x as f64 / w as f64 + y as f64 / h as f64) / 2.0;
            }
        }
        let sel = select_coefficients(128, 0, 27);
        let cos_x = precompute_cos_table(w, 32);
        let cos_y = precompute_cos_table(h, 32);
        let (dc, ac, _) = dct_encode_selected(&channel, w, h, &sel.coeffs, &cos_x, &cos_y);

        let mut max_err = 0.0_f64;
        for y in 0..h {
            for x in 0..w {
                let r = dct_decode_pixel_separable(dc, &ac, &sel.coeffs, x, y, &cos_x, &cos_y);
                max_err = max_err.max((r - channel[x + y * w]).abs());
            }
        }
        assert!(
            max_err < 0.02,
            "gradient reconstruction max error too large: {max_err}"
        );
    }
}
