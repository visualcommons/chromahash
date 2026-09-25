use crate::constants::{Companding, QuantTable};
use crate::math_utils::{portable_exp, portable_ln, portable_pow, round_half_away_from_zero};

/// µ-law compress: value in [-1, 1] → compressed in [-1, 1].
pub fn mu_compress(value: f64, mu: f64) -> f64 {
    mu_compress_by(value, mu, portable_ln(1.0 + mu))
}

/// [`mu_compress`] with its denominator `ln(1 + mu)` supplied by the caller,
/// so a loop over one `mu` computes it once (`spec/PERFORMANCE.md` §12.1 item
/// 2). `mu_compress` is this function, so the two cannot drift apart: the
/// expression is evaluated once, in one place, in the same order.
pub(crate) fn mu_compress_by(value: f64, mu: f64, ln_1p_mu: f64) -> f64 {
    let v = value.clamp(-1.0, 1.0);
    v.signum() * portable_ln(1.0 + mu * v.abs()) / ln_1p_mu
}

/// µ-law expand: compressed in [-1, 1] → value in [-1, 1].
pub fn mu_expand(compressed: f64, mu: f64) -> f64 {
    compressed.signum() * (portable_pow(1.0 + mu, compressed.abs()) - 1.0) / mu
}

/// Quantize a compressed value in [-1, 1] to an odd-level index.
///
/// The shared odd-level grid (2^bits − 1 levels): indices 0..=2^bits−2 with the
/// center index representing exactly 0.0. The top code (2^bits − 1) is never
/// written. This removes the v0.5 zero bias (+0.0119·scale at 5 bits), so
/// zeroed coefficients — solid colors, frequency-clamped slots — decode exactly.
fn quantize_compressed(compressed: f64, bits: u32) -> u32 {
    let max_idx = (1u32 << bits) - 2;
    let index = round_half_away_from_zero((compressed + 1.0) / 2.0 * max_idx as f64);
    (index as i64).clamp(0, max_idx as i64) as u32
}

/// Map an odd-level index back to its compressed value in [-1, 1].
/// The never-written top code clamps down for robustness.
fn dequantize_compressed(index: u32, bits: u32) -> f64 {
    let max_idx = (1u32 << bits) - 2;
    let index = index.min(max_idx);
    index as f64 / max_idx as f64 * 2.0 - 1.0
}

/// Quantize a value in [-1, 1] using µ-law to an integer index. Per spec §7.3 (v0.6).
pub fn mu_law_quantize(value: f64, bits: u32, mu: f64) -> u32 {
    quantize_compressed(mu_compress(value, mu), bits)
}

/// Dequantize an integer index back to a value in [-1, 1] using µ-law.
/// Per spec §7.3 (v0.6).
pub fn mu_law_dequantize(index: u32, bits: u32, mu: f64) -> f64 {
    mu_expand(dequantize_compressed(index, bits), mu)
}

/// [`compand_quantize`] for a caller that already holds `ln(1 + mu)`.
///
/// Every family but µ-law is dispatched to [`compand_quantize`] unchanged; the
/// µ-law arm is the same deadzone test and the same [`mu_law_quantize`]
/// arithmetic, with [`mu_compress_by`] in place of [`mu_compress`].
pub(crate) fn compand_quantize_hoisted(
    value: f64,
    bits: u32,
    family: Companding,
    mu: f64,
    ln_1p_mu: f64,
    table: &QuantTable,
    deadzone: f64,
) -> u32 {
    match family {
        Companding::MuLaw => {
            if deadzone > 0.0 && value.abs() < deadzone {
                return (1u32 << (bits - 1)) - 1;
            }
            quantize_compressed(mu_compress_by(value, mu, ln_1p_mu), bits)
        }
        _ => compand_quantize(value, bits, family, mu, table, deadzone),
    }
}

/// Every value [`compand_dequantize`] returns at width `bits`, indexed by the
/// code: `table[q] == compand_dequantize(q, bits, …)` for `q` in
/// `0..2^bits`, the never-written top code included (it clamps, as the
/// function does). A pure function of its arguments, so the table holds the
/// same `f64`s the calls would — `spec/PERFORMANCE.md` §12.1 item 1.
///
/// The width is part of what the table is for: a job whose bit width varies
/// with the selection index needs one table per width, never one per job.
pub(crate) fn dequantize_table(
    bits: u32,
    family: Companding,
    mu: f64,
    table: &QuantTable,
) -> Vec<f64> {
    (0..1u32 << bits)
        .map(|q| compand_dequantize(q, bits, family, mu, table))
        .collect()
}

/// A-law compress (G.711's other companding half; linear near zero).
pub fn a_law_compress(value: f64, a: f64) -> f64 {
    let v = value.clamp(-1.0, 1.0);
    let x = v.abs();
    let denom = 1.0 + portable_ln(a);
    let mag = if x < 1.0 / a {
        a * x / denom
    } else {
        (1.0 + portable_ln(a * x)) / denom
    };
    v.signum() * mag
}

/// A-law expand: inverse of [`a_law_compress`].
pub fn a_law_expand(compressed: f64, a: f64) -> f64 {
    let y = compressed.clamp(-1.0, 1.0);
    let x = y.abs();
    let denom = 1.0 + portable_ln(a);
    let mag = if x < 1.0 / denom {
        x * denom / a
    } else {
        portable_exp(x * denom - 1.0) / a
    };
    y.signum() * mag
}

/// Power-law compress: sign(x)·|x|^gamma (AAC/MP3 use gamma = 0.75).
pub fn power_compress(value: f64, gamma: f64) -> f64 {
    let v = value.clamp(-1.0, 1.0);
    if v == 0.0 {
        return 0.0;
    }
    v.signum() * portable_pow(v.abs(), gamma)
}

/// Power-law expand: inverse of [`power_compress`].
pub fn power_expand(compressed: f64, gamma: f64) -> f64 {
    let c = compressed.clamp(-1.0, 1.0);
    if c == 0.0 {
        return 0.0;
    }
    c.signum() * portable_pow(c.abs(), 1.0 / gamma)
}

/// Nearest-level quantization against a trained symmetric codebook: index =
/// center ± the offset of the closest positive level (0 counts as the center).
/// Ties round away from zero, consistent with `round_half_away_from_zero`.
fn table_quantize(value: f64, bits: u32, table: &QuantTable) -> u32 {
    let center = (1u32 << (bits - 1)) - 1;
    let max_offset = (table.len as u32).min(center);
    let mag = value.clamp(-1.0, 1.0).abs();

    let mut best_offset = 0u32;
    let mut best_dist = mag; // distance to the center level (0.0)
    for k in 0..max_offset {
        let dist = (mag - table.levels[k as usize]).abs();
        if dist <= best_dist {
            best_dist = dist;
            best_offset = k + 1;
        }
    }
    if value < 0.0 {
        center - best_offset
    } else {
        center + best_offset
    }
}

/// Codebook lookup: inverse of [`table_quantize`]. Out-of-range indices clamp
/// to the outermost trained level (mirrors the µ-law top-code clamp).
fn table_dequantize(index: u32, bits: u32, table: &QuantTable) -> f64 {
    let center = ((1u32 << (bits - 1)) - 1) as i64;
    let max_offset = (table.len as i64).min(center);
    if max_offset == 0 {
        return 0.0;
    }
    let offset = (index as i64 - center).clamp(-max_offset, max_offset);
    if offset == 0 {
        return 0.0;
    }
    let level = table.levels[(offset.abs() - 1) as usize];
    if offset < 0 { -level } else { level }
}

/// Quantize a normalized value in [-1, 1] under the group's companding family.
/// Sweep-only dispatch: with the default family (µ-law) and deadzone 0.0 this
/// is bit-for-bit [`mu_law_quantize`]. A non-zero deadzone maps |value| below
/// the threshold to the exact-zero center code before companding.
pub fn compand_quantize(
    value: f64,
    bits: u32,
    family: Companding,
    mu: f64,
    table: &QuantTable,
    deadzone: f64,
) -> u32 {
    if deadzone > 0.0 && value.abs() < deadzone {
        return (1u32 << (bits - 1)) - 1;
    }
    match family {
        Companding::MuLaw => mu_law_quantize(value, bits, mu),
        Companding::ALaw { a } => quantize_compressed(a_law_compress(value, a), bits),
        Companding::Power { gamma } => quantize_compressed(power_compress(value, gamma), bits),
        Companding::Table => table_quantize(value, bits, table),
    }
}

/// Dequantize an index under the group's companding family. Sweep-only
/// dispatch: with the default family this is bit-for-bit [`mu_law_dequantize`].
pub fn compand_dequantize(
    index: u32,
    bits: u32,
    family: Companding,
    mu: f64,
    table: &QuantTable,
) -> f64 {
    match family {
        Companding::MuLaw => mu_law_dequantize(index, bits, mu),
        Companding::ALaw { a } => a_law_expand(dequantize_compressed(index, bits), a),
        Companding::Power { gamma } => power_expand(dequantize_compressed(index, bits), gamma),
        Companding::Table => table_dequantize(index, bits, table),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MU: f64 = 5.0;

    #[test]
    fn roundtrip_extremes() {
        for &v in &[-1.0, -0.5, 0.0, 0.5, 1.0] {
            let c = mu_compress(v, MU);
            let rt = mu_expand(c, MU);
            assert!(
                (rt - v).abs() < 1e-12,
                "µ-law roundtrip failed at v={v}: got {rt}"
            );
        }
    }

    #[test]
    fn compressed_range() {
        assert!((mu_compress(1.0, MU) - 1.0).abs() < 1e-12);
        assert!((mu_compress(-1.0, MU) + 1.0).abs() < 1e-12);
        assert!((mu_compress(0.0, MU)).abs() < 1e-12);
    }

    #[test]
    fn zero_is_exact() {
        // The defining v0.6 property: 0.0 quantizes to the center index and
        // dequantizes back to exactly 0.0 at every bit width.
        for bits in [4u32, 5, 6] {
            let center = (1u32 << (bits - 1)) - 1;
            assert_eq!(mu_law_quantize(0.0, bits, MU), center, "bits={bits}");
            assert_eq!(mu_law_dequantize(center, bits, MU), 0.0, "bits={bits}");
        }
    }

    #[test]
    fn extremes_quantize_to_bounds() {
        for bits in [4u32, 5, 6] {
            let max_idx = (1u32 << bits) - 2;
            assert_eq!(mu_law_quantize(-1.0, bits, MU), 0);
            assert_eq!(mu_law_quantize(1.0, bits, MU), max_idx);
        }
    }

    #[test]
    fn top_code_clamps_on_dequantize() {
        // The never-written top code (2^bits − 1) must decode like 2^bits − 2.
        for bits in [4u32, 5, 6] {
            let top = (1u32 << bits) - 1;
            assert_eq!(
                mu_law_dequantize(top, bits, MU),
                mu_law_dequantize(top - 1, bits, MU)
            );
        }
    }

    #[test]
    fn quantize_roundtrip_preserves_sign() {
        for bits in [4u32, 5, 6] {
            for &v in &[-0.9, -0.5, -0.1, 0.1, 0.5, 0.9] {
                let q = mu_law_quantize(v, bits, MU);
                let dq = mu_law_dequantize(q, bits, MU);
                if v > 0.0 {
                    assert!(dq >= 0.0, "sign should be preserved for v={v}");
                } else {
                    assert!(dq <= 0.0, "sign should be preserved for v={v}");
                }
            }
        }
    }

    #[test]
    fn symmetric_codes() {
        // With an odd level count, +v and −v should land symmetrically
        // around the center code.
        for bits in [4u32, 5, 6] {
            let center = (1u32 << (bits - 1)) - 1;
            for &v in &[0.1, 0.3, 0.7] {
                let qp = mu_law_quantize(v, bits, MU);
                let qn = mu_law_quantize(-v, bits, MU);
                assert_eq!(
                    qp - center,
                    center - qn,
                    "codes for ±{v} not symmetric at bits={bits}"
                );
            }
        }
    }

    #[test]
    fn compand_default_dispatch_is_mu_law() {
        // The sweep dispatch with the default family and zero deadzone must be
        // bit-for-bit the shipped µ-law path.
        let table = QuantTable::EMPTY;
        for bits in [4u32, 5, 6] {
            for &v in &[-1.0, -0.73, -0.2, 0.0, 0.11, 0.5, 1.0] {
                assert_eq!(
                    compand_quantize(v, bits, Companding::MuLaw, MU, &table, 0.0),
                    mu_law_quantize(v, bits, MU),
                );
                let q = mu_law_quantize(v, bits, MU);
                assert_eq!(
                    compand_dequantize(q, bits, Companding::MuLaw, MU, &table),
                    mu_law_dequantize(q, bits, MU),
                );
            }
        }
    }

    #[test]
    fn alaw_and_power_roundtrip_with_exact_zero() {
        let table = QuantTable::EMPTY;
        for family in [
            Companding::ALaw { a: 87.6 },
            Companding::Power { gamma: 0.75 },
        ] {
            // Compress/expand round-trips.
            for &v in &[-1.0, -0.4, -0.01, 0.0, 0.02, 0.6, 1.0] {
                let c = match family {
                    Companding::ALaw { a } => a_law_expand(a_law_compress(v, a), a),
                    Companding::Power { gamma } => power_expand(power_compress(v, gamma), gamma),
                    _ => unreachable!(),
                };
                assert!((c - v).abs() < 1e-9, "{family:?} roundtrip failed at {v}");
            }
            // The exact-zero center code holds for every family.
            for bits in [4u32, 5, 6] {
                let center = (1u32 << (bits - 1)) - 1;
                assert_eq!(compand_quantize(0.0, bits, family, MU, &table, 0.0), center);
                assert_eq!(compand_dequantize(center, bits, family, MU, &table), 0.0);
            }
        }
    }

    #[test]
    fn deadzone_maps_small_values_to_center() {
        let table = QuantTable::EMPTY;
        let center = (1u32 << 4) - 1; // bits = 5
        assert_eq!(
            compand_quantize(0.09, 5, Companding::MuLaw, MU, &table, 0.1),
            center
        );
        // At/above the threshold the normal path resumes.
        assert_eq!(
            compand_quantize(0.1, 5, Companding::MuLaw, MU, &table, 0.1),
            mu_law_quantize(0.1, 5, MU)
        );
    }

    /// The families and deadzones §12.1 items 1–2 must agree under.
    fn accel_cases() -> Vec<(Companding, f64, QuantTable, f64)> {
        let mut trained = QuantTable::EMPTY;
        trained.levels[0] = 0.1;
        trained.levels[1] = 0.35;
        trained.levels[2] = 0.8;
        trained.len = 3;
        vec![
            (Companding::MuLaw, 5.0, QuantTable::EMPTY, 0.0),
            (Companding::MuLaw, 8.0, QuantTable::EMPTY, 0.0),
            (Companding::MuLaw, 5.0, QuantTable::EMPTY, 0.05),
            (Companding::ALaw { a: 87.6 }, 5.0, QuantTable::EMPTY, 0.0),
            (
                Companding::Power { gamma: 0.75 },
                5.0,
                QuantTable::EMPTY,
                0.02,
            ),
            (Companding::Table, 5.0, trained, 0.0),
        ]
    }

    #[test]
    fn hoisted_quantize_is_bit_for_bit_the_plain_one() {
        // A dense sweep of [-1.1, 1.1] plus the values where the arithmetic has
        // edges: zero of both signs, the clamp boundary, the deadzone boundary.
        let mut values: Vec<f64> = (-1100..=1100).map(|i| i as f64 / 1000.0).collect();
        values.extend([-0.0, 0.05, -0.05, 0.02, f64::MIN_POSITIVE, 1.0, -1.0]);
        for (family, mu, table, deadzone) in accel_cases() {
            let ln = portable_ln(1.0 + mu);
            for bits in [3u32, 4, 5, 6, 7, 8] {
                for &v in &values {
                    assert_eq!(
                        compand_quantize_hoisted(v, bits, family, mu, ln, &table, deadzone),
                        compand_quantize(v, bits, family, mu, &table, deadzone),
                        "{family:?} mu={mu} dz={deadzone} bits={bits} v={v}"
                    );
                }
            }
        }
    }

    #[test]
    fn mu_compress_by_is_mu_compress() {
        for mu in [1.0, 5.0, 8.0, 255.0] {
            let ln = portable_ln(1.0 + mu);
            for i in -1100..=1100 {
                let v = i as f64 / 1000.0;
                assert_eq!(
                    mu_compress_by(v, mu, ln).to_bits(),
                    mu_compress(v, mu).to_bits()
                );
            }
        }
    }

    #[test]
    fn dequantize_table_holds_what_the_calls_return() {
        for (family, mu, table, _) in accel_cases() {
            for bits in [3u32, 4, 5, 6, 7, 8] {
                let t = dequantize_table(bits, family, mu, &table);
                assert_eq!(t.len(), 1usize << bits);
                for (q, &v) in t.iter().enumerate() {
                    assert_eq!(
                        v.to_bits(),
                        compand_dequantize(q as u32, bits, family, mu, &table).to_bits(),
                        "{family:?} bits={bits} q={q}"
                    );
                }
            }
        }
    }

    #[test]
    fn dequantize_tables_differ_by_width() {
        // Why the key is `(bits, index)`: the same index names a different level
        // at a different width, so a table keyed on the index alone would hand
        // one band the other's grid (LAYOUT_C's 6-bit and 5-bit L bands).
        let six = dequantize_table(6, Companding::MuLaw, MU, &QuantTable::EMPTY);
        let five = dequantize_table(5, Companding::MuLaw, MU, &QuantTable::EMPTY);
        assert!((1..31).any(|q| six[q] != five[q]));
    }

    #[test]
    fn table_quantize_roundtrip_and_ties() {
        // Exactly representable levels so the tie case is a true f64 tie.
        let mut table = QuantTable::EMPTY;
        table.levels[0] = 0.125;
        table.levels[1] = 0.375;
        table.levels[2] = 0.875;
        table.len = 3;
        let bits = 4u32; // center = 7, offsets ±1..=3 used
        let f = Companding::Table;

        // Each trained level round-trips exactly, both signs.
        for (offset, &level) in [0.125, 0.375, 0.875].iter().enumerate() {
            let qp = compand_quantize(level, bits, f, MU, &table, 0.0);
            assert_eq!(qp, 7 + offset as u32 + 1);
            assert_eq!(compand_dequantize(qp, bits, f, MU, &table), level);
            let qn = compand_quantize(-level, bits, f, MU, &table, 0.0);
            assert_eq!(qn, 7 - offset as u32 - 1);
            assert_eq!(compand_dequantize(qn, bits, f, MU, &table), -level);
        }
        // Midpoint ties round away from zero: 0.25 is equidistant to
        // 0.125/0.375 (all exactly representable), so the larger level wins.
        assert_eq!(compand_quantize(0.25, bits, f, MU, &table, 0.0), 9);
        // Values beyond the last level clamp to it; out-of-range indices too.
        assert_eq!(compand_quantize(5.0, bits, f, MU, &table, 0.0), 10);
        assert_eq!(compand_dequantize(15, bits, f, MU, &table), 0.875);
        assert_eq!(compand_dequantize(0, bits, f, MU, &table), -0.875);
    }
}
