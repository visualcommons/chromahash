/// Round half away from zero (NOT Rust's default banker's rounding).
/// Per spec §2.2: round(x) = floor(x + 0.5) for x ≥ 0, ceil(x - 0.5) for x < 0.
pub fn round_half_away_from_zero(x: f64) -> f64 {
    if x >= 0.0 {
        (x + 0.5).floor()
    } else {
        (x - 0.5).ceil()
    }
}

/// The most halvings or doublings any `f64` needs to reach [1, 2), with
/// margin: the largest finite value is below 2^1024 and the smallest
/// subnormal is 2^-1074. Both power-of-two loops below are bounded by it.
///
/// The bound changes no result in either function's working domain (see
/// `portable_exp` for where that ends). Every finite input to `portable_ln`
/// finishes its loop well inside it, and only an infinite `m`, which the
/// unbounded loop never left, reaches it; `portable_exp`'s result is already
/// `inf` or `0` by then, where doubling or halving again leaves it. What the
/// bound buys is that no edit to a comparison or a
/// step can turn one of these loops into one that never ends, so a broken
/// kernel fails its tests instead of hanging them.
const POW2_STEPS: i32 = 1100;

/// Portable natural logarithm using only basic IEEE 754 arithmetic.
/// Range-reduces to [1, 2) then uses the series ln(m) = 2·Σ u^(2k+1)/(2k+1)
/// where u = (m-1)/(m+1).
#[allow(clippy::approx_constant)]
pub fn portable_ln(x: f64) -> f64 {
    const LN2: f64 = 0.6931471805599453;

    if x <= 0.0 {
        return f64::NEG_INFINITY;
    }
    if x == 1.0 {
        return 0.0;
    }

    // Range reduce to m ∈ [1, 2)
    let mut m = x;
    let mut e: i32 = 0;
    for _ in 0..POW2_STEPS {
        if m < 2.0 {
            break;
        }
        m /= 2.0;
        e += 1;
    }
    for _ in 0..POW2_STEPS {
        if m >= 1.0 {
            break;
        }
        m *= 2.0;
        e -= 1;
    }

    // Series: ln(m) = 2·(u + u³/3 + u⁵/5 + ...) where u = (m-1)/(m+1)
    // For m ∈ [1, 2), u ∈ [0, 1/3), converges fast
    let u = (m - 1.0) / (m + 1.0);
    let u2 = u * u;
    let mut term = u;
    let mut sum = u;
    for k in 1..=20 {
        term *= u2;
        sum += term / (2 * k + 1) as f64;
    }

    2.0 * sum + e as f64 * LN2
}

/// Portable exponential using only basic IEEE 754 arithmetic.
/// Range-reduces via exp(x) = 2^k · exp(r) where r ∈ [-ln2/2, ln2/2],
/// then uses a degree-25 Taylor polynomial for exp(r).
#[allow(clippy::approx_constant)]
pub fn portable_exp(x: f64) -> f64 {
    const LN2: f64 = 0.6931471805599453;

    if x == 0.0 {
        return 1.0;
    }

    // Range reduction: k = round(x / ln2), r = x - k·ln2
    let k = (x / LN2 + 0.5).floor() as i32;
    let r = x - k as f64 * LN2;

    // Taylor polynomial for exp(r), |r| < 0.347
    let mut term = 1.0;
    let mut sum = 1.0;
    for i in 1..=25 {
        term *= r / i as f64;
        sum += term;
    }

    // Multiply by 2^k. `sum` is within [0.7, 1.5], so it overflows to `inf`
    // within 1025 doublings and flushes to `0` within 1076 halvings; capping
    // the count at `POW2_STEPS` leaves the result as it was for every `x`
    // whose `k` fits an `i32` (|x| below about 1.49e9, far past both
    // saturations). Beyond that the `as i32` cast saturates, `r` is no longer
    // reduced, and the result was and is meaningless; `unsigned_abs` at least
    // stops `-k` overflowing at `k = i32::MIN`, which panicked a checked build.
    let steps = k.unsigned_abs().min(POW2_STEPS as u32);
    let mut result = sum;
    if k >= 0 {
        for _ in 0..steps {
            result *= 2.0;
        }
    } else {
        for _ in 0..steps {
            result /= 2.0;
        }
    }

    result
}

/// Portable power function: base^exponent using only basic IEEE 754 arithmetic.
/// Computes exp(exponent · ln(base)).
pub fn portable_pow(base: f64, exponent: f64) -> f64 {
    if base == 0.0 {
        return 0.0;
    }
    if exponent == 0.0 {
        return 1.0;
    }
    if base == 1.0 {
        return 1.0;
    }
    portable_exp(exponent * portable_ln(base))
}

/// IEEE 754 bit-seed cube root with 3 Halley iterations. Per spec §12.6.
/// ~26 FLOPs, max error ≤ 2 ULP across full domain. Deterministic on all platforms.
/// Signed: cbrt_halley(-x) = -cbrt_halley(x).
pub fn cbrt_halley(x: f64) -> f64 {
    if x == 0.0 {
        return 0.0;
    }
    let sign = x < 0.0;
    let x = if sign { -x } else { x };

    // Seed via signed int64 biased-exponent division (MUST be signed, not u64)
    let bits = x.to_bits();
    let signed_bits = bits as i64;
    let seed_signed = (signed_bits - (1023i64 << 52)) / 3 + (1023i64 << 52);
    let seed = seed_signed as u64;
    let mut y = f64::from_bits(seed);

    // 3 Halley iterations with explicit let bindings to prevent FMA contraction
    for _ in 0..3 {
        let t1 = y * y;
        let y3 = t1 * y;
        let t2 = 2.0 * x;
        let num = y3 + t2;
        let t3 = 2.0 * y3;
        let den = t3 + x;
        let t4 = y * num;
        y = t4 / den;
    }

    if sign { -y } else { y }
}

/// Signed cube root per spec §2.4: cbrt(x) = sign(x) × |x|^(1/3).
/// Uses portable_pow for cross-platform determinism.
/// Superseded by cbrt_halley for production use; retained as the reference
/// the tests check `cbrt_halley` against, and compiled only for them.
#[cfg(test)]
pub fn cbrt_signed(x: f64) -> f64 {
    if x == 0.0 {
        0.0
    } else if x > 0.0 {
        portable_pow(x, 1.0 / 3.0)
    } else {
        -portable_pow(-x, 1.0 / 3.0)
    }
}

/// Portable cosine using only basic IEEE 754 arithmetic (+, -, *, /).
/// Produces bit-identical results across all platforms, unlike platform-specific
/// cos() which can differ at the last ULP due to different libm implementations.
/// Uses a degree-16 Taylor polynomial with range reduction.
#[allow(clippy::approx_constant)]
pub fn portable_cos(x: f64) -> f64 {
    const PI: f64 = 3.141592653589793;
    const TWO_PI: f64 = 6.283185307179586;
    const HALF_PI: f64 = 1.5707963267948966;

    // cos is even. (`abs` rather than `if x < 0.0 { -x }`: the two differ
    // only at -0.0, whose cosine is 1 either way.)
    let mut x = x.abs();

    // Range reduce to [0, 2π)
    if x >= TWO_PI {
        x -= (x / TWO_PI).floor() * TWO_PI;
    }

    // Reduce to [0, π] using cos(2π - x) = cos(x)
    if x > PI {
        x = TWO_PI - x;
    }

    // Reduce to [0, π/2] using cos(π - x) = -cos(x)
    let negate = x > HALF_PI;
    if negate {
        x = PI - x;
    }

    // Horner form of degree-16 Taylor polynomial for cos(x) on [0, π/2]
    // Coefficients: (-1)^n / (2n)! for n = 0..8
    let x2 = x * x;
    let r = 1.0
        + x2 * (-1.0 / 2.0
            + x2 * (1.0 / 24.0
                + x2 * (-1.0 / 720.0
                    + x2 * (1.0 / 40320.0
                        + x2 * (-1.0 / 3628800.0
                            + x2 * (1.0 / 479001600.0
                                + x2 * (-1.0 / 87178291200.0 + x2 * (1.0 / 20922789888000.0))))))));

    if negate { -r } else { r }
}

/// Clamp to [0, 1].
pub fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

/// Clamp to [-1, 1].
pub fn clamp_neg1_1(x: f64) -> f64 {
    x.clamp(-1.0, 1.0)
}

/// 3×3 matrix × 3-vector multiplication.
pub fn matvec3(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_positive_half() {
        assert_eq!(round_half_away_from_zero(0.5), 1.0);
        assert_eq!(round_half_away_from_zero(1.5), 2.0);
        assert_eq!(round_half_away_from_zero(2.5), 3.0);
    }

    #[test]
    fn round_negative_half() {
        assert_eq!(round_half_away_from_zero(-0.5), -1.0);
        assert_eq!(round_half_away_from_zero(-1.5), -2.0);
        assert_eq!(round_half_away_from_zero(-2.5), -3.0);
    }

    #[test]
    fn round_standard_cases() {
        assert_eq!(round_half_away_from_zero(0.0), 0.0);
        assert_eq!(round_half_away_from_zero(0.3), 0.0);
        assert_eq!(round_half_away_from_zero(0.7), 1.0);
        assert_eq!(round_half_away_from_zero(-0.3), 0.0);
        assert_eq!(round_half_away_from_zero(-0.7), -1.0);
    }

    #[test]
    fn cbrt_positive() {
        assert!((cbrt_signed(8.0) - 2.0).abs() < 1e-12);
        assert!((cbrt_signed(27.0) - 3.0).abs() < 1e-12);
        assert!((cbrt_signed(1.0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn cbrt_negative() {
        assert!((cbrt_signed(-8.0) - (-2.0)).abs() < 1e-12);
        assert!((cbrt_signed(-27.0) - (-3.0)).abs() < 1e-12);
    }

    #[test]
    fn cbrt_zero() {
        assert_eq!(cbrt_signed(0.0), 0.0);
    }

    #[test]
    fn cbrt_halley_known_values() {
        assert!((cbrt_halley(8.0) - 2.0).abs() < 1e-12);
        assert!((cbrt_halley(27.0) - 3.0).abs() < 1e-12);
        assert!((cbrt_halley(1.0) - 1.0).abs() < 1e-12);
        assert!((cbrt_halley(-8.0) - (-2.0)).abs() < 1e-12);
        assert!((cbrt_halley(-27.0) - (-3.0)).abs() < 1e-12);
        assert_eq!(cbrt_halley(0.0), 0.0);
    }

    #[test]
    fn cbrt_halley_agrees_with_cbrt_signed() {
        // Verify ≤2 ULP agreement across LMS domain [1e-6, 3.0]
        let test_vals: &[f64] = &[
            1e-6, 0.001, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 2.5, 3.0,
        ];
        for &v in test_vals {
            for &x in &[v, -v] {
                let halley = cbrt_halley(x);
                let signed = cbrt_signed(x);
                let rel_err = if signed.abs() > 1e-15 {
                    (halley - signed).abs() / signed.abs()
                } else {
                    (halley - signed).abs()
                };
                assert!(
                    rel_err < 1e-12,
                    "cbrt_halley({x}) = {halley}, cbrt_signed({x}) = {signed}, rel_err = {rel_err}"
                );
            }
        }
    }

    #[test]
    fn clamp01_works() {
        assert_eq!(clamp01(-0.5), 0.0);
        assert_eq!(clamp01(0.5), 0.5);
        assert_eq!(clamp01(1.5), 1.0);
    }

    #[test]
    fn portable_cos_known_values() {
        let pi = std::f64::consts::PI;
        assert!((portable_cos(0.0) - 1.0).abs() < 1e-15);
        // Tight bound: π/2 maximises x² in the reduced domain, so the smallest
        // Horner coefficient is what makes cos(π/2) land on zero. Loosening it
        // (e.g. flipping that term's sign) perturbs this by ~2e-10.
        assert!(portable_cos(pi / 2.0).abs() < 1e-12);
        assert!((portable_cos(pi) - (-1.0)).abs() < 1e-15);
        assert!((portable_cos(2.0 * pi) - 1.0).abs() < 1e-14);
        // Check accuracy for a typical DCT argument
        assert!((portable_cos(pi / 16.0 * 3.0 * 7.5) - (-0.2902846772544624)).abs() < 1e-10);
    }

    #[test]
    fn portable_cos_negative_and_large_arguments() {
        // cos is even, so the first step folds negatives via `x = -x`. The
        // known-value test only fed non-negative arguments, leaving the
        // negation (and the `x < 0.0` guard) untested — a large negative input
        // that skips range reduction exposes any break there.
        let pi = std::f64::consts::PI;
        for &x in &[
            -0.5,
            -pi / 2.0,
            -pi,
            -3.0 * pi,
            -7.3,
            7.3,
            42.0,
            -42.0,
            -100.0,
        ] {
            let got = portable_cos(x);
            let want = x.cos();
            assert!(
                (got - want).abs() < 1e-9,
                "portable_cos({x}) = {got}, std {want}"
            );
        }
    }

    #[test]
    fn portable_ln_known_values() {
        assert!((portable_ln(1.0) - 0.0).abs() < 1e-14);
        assert!((portable_ln(std::f64::consts::E) - 1.0).abs() < 1e-12);
        assert!((portable_ln(2.0) - std::f64::consts::LN_2).abs() < 1e-14);
        assert!((portable_ln(0.5) - (-std::f64::consts::LN_2)).abs() < 1e-14);
        assert!((portable_ln(10.0) - std::f64::consts::LN_10).abs() < 1e-12);
    }

    #[test]
    fn portable_exp_known_values() {
        assert!((portable_exp(0.0) - 1.0).abs() < 1e-15);
        assert!((portable_exp(1.0) - std::f64::consts::E).abs() < 1e-12);
        assert!((portable_exp(-1.0) - 1.0 / std::f64::consts::E).abs() < 1e-12);
        assert!((portable_exp(std::f64::consts::LN_2) - 2.0).abs() < 1e-12);
    }

    #[test]
    fn portable_pow_known_values() {
        assert!((portable_pow(2.0, 10.0) - 1024.0).abs() < 1e-8);
        assert!((portable_pow(0.5, 2.4) - 0.5_f64.powf(2.4)).abs() < 1e-12);
        assert!((portable_pow(0.8, 2.4) - 0.8_f64.powf(2.4)).abs() < 1e-12);
        assert_eq!(portable_pow(0.0, 2.4), 0.0);
        assert_eq!(portable_pow(1.0, 2.4), 1.0);
    }

    /// Exact values at the points where a kernel's branch or loop decides
    /// something, which the tolerance tests above cannot see.
    #[test]
    fn kernels_are_exact_at_their_boundaries() {
        // The kernels' local `LN2`, `PI`, `TWO_PI` and `HALF_PI` literals are
        // these constants rounded to f64, so they are the same bits.
        use std::f64::consts::{FRAC_PI_2, LN_2 as LN2, PI, TAU};
        // A power of two range-reduces to m = 1 exactly, so the series adds
        // nothing and ln is e·LN2 to the bit. Reducing m = 1 once more (a
        // `<=` in the doubling loop) would sum the series at m = 2 instead,
        // which lands an ulp or two off.
        assert_eq!(portable_ln(2.0), LN2);
        assert_eq!(portable_ln(0.5), -LN2);
        assert_eq!(portable_ln(4.0), 2.0 * LN2);
        assert_eq!(portable_ln(0.25), -2.0 * LN2);

        // The 2^k scaling saturates rather than wrapping or running away: a
        // large argument overflows to inf and a small one flushes to 0, and
        // the largest finite results sit just inside.
        assert_eq!(portable_exp(1000.0), f64::INFINITY);
        assert_eq!(portable_exp(-1000.0), 0.0);
        assert!(portable_exp(709.0).is_finite() && portable_exp(709.0) > 8.2e307);
        assert!(portable_exp(-708.0) > 0.0);

        // At exactly π/2 the Taylor polynomial leaves a positive residue, and
        // the quadrant fold (`x > HALF_PI`) must not negate it.
        assert_eq!(portable_cos(FRAC_PI_2), 5.260236690673992e-13);
        assert_eq!(portable_cos(-FRAC_PI_2), 5.260236690673992e-13);
        // Premise of the `x > PI` exclusion in .cargo/mutants.toml: at x = π
        // the fold computes 2π - π, which is π again, so `>` and `>=` agree.
        assert_eq!(TAU - PI, PI);
    }

    #[test]
    fn matvec3_identity() {
        let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let v = [3.0, 4.0, 5.0];
        let r = matvec3(&identity, v);
        assert_eq!(r, v);
    }
}
