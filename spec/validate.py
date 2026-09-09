#!/usr/bin/env python3
"""Validate ChromaHash constants against first-principles derivations.

Independently derives all M1 matrices from gamut chromaticity coordinates
and verifies they match the values in constants.py. Also checks matrix
inverse relationships, white point mapping, and OKLAB bounds.

Usage:
    python3 spec/validate.py

Exit code 0 on success, 1 on any validation failure.
"""
import math
import ast
import os
import re
import sys

import selection
from constants import (
    M1_ADOBE_RGB,
    M1_BT2020,
    M1_DISPLAY_P3,
    M1_INV_ADOBE_RGB,
    M1_INV_DISPLAY_P3,
    M1_INV_SRGB,
    M1_PROPHOTO_RGB,
    M1_SRGB,
    M2,
    M2_INV,
    M_BRADFORD,
    D50_XY,
    D65_XY,
    GAMUT_PRIMARIES,
    MAX_A_ALPHA_SCALE,
    MAX_A_SCALE,
    MAX_B_SCALE,
    MAX_CHROMA_A,
    MAX_CHROMA_B,
    MAX_L_SCALE,
    MU_ALPHA,
    W_EXP_C,
    W_EXP_L,
    W_MIN_C,
    W_MIN_L,
    MU_C,
    MU_L,
    ANISO_OBLIQUE,
    DEFAULT_LAYOUT,
    SEL_HV,
    tier_layout,
    FORMAT_VERSION,
    MAX_TIER,
    DESCRIPTOR_BITS,
    DC_SCALE_BITS,
    PREFIX_BITS,
    ALPHA_PREFIX_BITS,
    ac_shape,
    ac_payload_bits,
    body_len_bytes,
    tier_count_scale,
    COMPACT_TIER,
    DEFAULT_TIER,
    is_valid_tier,
    render_level,
    ALPHA_FLAG_BIT,
    BASE_LONG_EDGE,
    LAYOUT_B,
    LAYOUT_T0,
    LAYOUT_TC,
    L_DC_BITS,
    L_SCALE_BITS,
    B_SCALE_BITS,
    ALPHA_DC_BITS,
    ALPHA_SCALE_BITS,
    A_DC_BITS,
    A_SCALE_BITS,
    B_DC_BITS,
    RESERVED_FLAG_BIT,
    TIER_BITS,
    VERSION_BITS,
    SEL_Q,)
from selection import (
    FORMAT_KS,
    decode_output_size,
    format_ks,
    q12,
    select_coefficients,
    selection_key,
)

# Mapping from gamut name → stored M1 matrix
STORED_M1 = {
    "sRGB": M1_SRGB,
    "Display P3": M1_DISPLAY_P3,
    "Adobe RGB": M1_ADOBE_RGB,
    "BT.2020": M1_BT2020,
    "ProPhoto RGB": M1_PROPHOTO_RGB,
}

# Tolerance for floating-point comparisons
MATRIX_TOL = 1e-7   # For matrix element comparisons (derived vs stored)
IDENTITY_TOL = 5e-8  # For identity matrix checks (accounts for 10-digit published precision)
WHITE_TOL = 1e-8     # For white point mapping

passed = 0
failed = 0


def check(condition: bool, label: str):
    """Record a pass/fail check."""
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✓ {label}")
    else:
        failed += 1
        print(f"  ✗ FAIL: {label}")


# =========================================================================
# Pure-Python linear algebra (no numpy dependency)
# =========================================================================

def matmul(A, B):
    n, k, m = len(A), len(B), len(B[0])
    C = [[0.0] * m for _ in range(n)]
    for i in range(n):
        for j in range(m):
            for l in range(k):
                C[i][j] += A[i][l] * B[l][j]
    return C


def matvec(A, v):
    return [sum(A[i][j] * v[j] for j in range(len(v))) for i in range(len(A))]


def matscale_cols(M, s):
    return [[M[i][j] * s[j] for j in range(len(M[0]))] for i in range(len(M))]


def mat_inv_3x3(M):
    a, b, c = M[0]
    d, e, f = M[1]
    g, h, k = M[2]
    det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g)
    inv_det = 1.0 / det
    return [
        [(e * k - f * h) * inv_det, (c * h - b * k) * inv_det, (b * f - c * e) * inv_det],
        [(f * g - d * k) * inv_det, (a * k - c * g) * inv_det, (c * d - a * f) * inv_det],
        [(d * h - e * g) * inv_det, (b * g - a * h) * inv_det, (a * e - b * d) * inv_det],
    ]


def diag3(v):
    return [[v[0], 0, 0], [0, v[1], 0], [0, 0, v[2]]]


def mat_max_diff(A, B):
    return max(abs(A[i][j] - B[i][j]) for i in range(3) for j in range(3))


def identity_error(M):
    return max(abs(M[i][j] - (1.0 if i == j else 0.0)) for i in range(3) for j in range(3))


# =========================================================================
# Matrix derivation from chromaticity coordinates
# =========================================================================

def xy_to_XYZ(x, y):
    return [x / y, 1.0, (1.0 - x - y) / y]


def rgb_to_xyz_matrix(primaries_xy, white_xy):
    """Compute 3×3 linear RGB → CIE XYZ matrix from chromaticities."""
    R = xy_to_XYZ(*primaries_xy[0])
    G = xy_to_XYZ(*primaries_xy[1])
    B = xy_to_XYZ(*primaries_xy[2])
    M = [[R[i], G[i], B[i]] for i in range(3)]
    W = xy_to_XYZ(*white_xy)
    S = matvec(mat_inv_3x3(M), W)
    return matscale_cols(M, S)


def bradford_adapt(src_xy, dst_xy):
    """Bradford chromatic adaptation matrix."""
    src_XYZ = xy_to_XYZ(*src_xy)
    dst_XYZ = xy_to_XYZ(*dst_xy)
    M_inv = mat_inv_3x3(M_BRADFORD)
    src_lms = matvec(M_BRADFORD, src_XYZ)
    dst_lms = matvec(M_BRADFORD, dst_XYZ)
    scale = [dst_lms[i] / src_lms[i] for i in range(3)]
    return matmul(M_inv, matmul(diag3(scale), M_BRADFORD))


def derive_m1(gamut_name: str) -> list:
    """Derive M1[gamut] from first principles using Ottosson's M1[sRGB]."""
    info = GAMUT_PRIMARIES[gamut_name]
    white_xy = D65_XY if info["white"] == "D65" else D50_XY
    primaries = [info["R"], info["G"], info["B"]]

    # Derive implicit M_LMS from Ottosson's M1[sRGB]
    M_XYZ_sRGB = rgb_to_xyz_matrix(
        [GAMUT_PRIMARIES["sRGB"]["R"],
         GAMUT_PRIMARIES["sRGB"]["G"],
         GAMUT_PRIMARIES["sRGB"]["B"]],
        D65_XY,
    )
    M_LMS = matmul(M1_SRGB, mat_inv_3x3(M_XYZ_sRGB))

    # Compute target gamut XYZ matrix
    M_XYZ = rgb_to_xyz_matrix(primaries, white_xy)

    # Apply Bradford adaptation if not D65
    if info["white"] != "D65":
        M_adapt = bradford_adapt(white_xy, D65_XY)
        M_XYZ = matmul(M_adapt, M_XYZ)

    return matmul(M_LMS, M_XYZ)


# =========================================================================
# Validation checks
# =========================================================================

def validate_matrix_inverses():
    """Check M2 × M2_inv ≈ I and M1[g] × M1_inv[g] ≈ I for each output gamut."""
    print("\n1. Matrix inverse relationships")

    product = matmul(M2, M2_INV)
    err = identity_error(product)
    check(err < IDENTITY_TOL, f"M2 × M2_inv ≈ I (err={err:.2e})")

    # Every display-output gamut the decoder supports (§11.1) must ship a
    # stored inverse that (a) multiplies with its M1 to identity and
    # (b) matches the inverse computed from M1 from first principles.
    output_gamuts = [
        ("sRGB", M1_SRGB, M1_INV_SRGB),
        ("Display P3", M1_DISPLAY_P3, M1_INV_DISPLAY_P3),
        ("Adobe RGB", M1_ADOBE_RGB, M1_INV_ADOBE_RGB),
    ]
    for name, m1, m1_inv in output_gamuts:
        product = matmul(m1, m1_inv)
        err = identity_error(product)
        check(err < IDENTITY_TOL, f"M1[{name}] × M1_inv[{name}] ≈ I (err={err:.2e})")

        m1_inv_computed = mat_inv_3x3(m1)
        diff = mat_max_diff(m1_inv_computed, m1_inv)
        check(diff < 1e-8, f"M1_inv[{name}] matches inv(M1[{name}]) (diff={diff:.2e})")


def validate_white_point():
    """Check M1[gamut] × (1,1,1) ≈ (1,1,1) for all gamuts."""
    print("\n2. White point mapping: M1 × (1,1,1) ≈ (1,1,1)")

    for name, M1 in STORED_M1.items():
        w = matvec(M1, [1.0, 1.0, 1.0])
        err = max(abs(v - 1.0) for v in w)
        check(err < WHITE_TOL, f"M1[{name}] (err={err:.2e})")

    # M2 × (1,1,1) = (1, 0, 0)
    r = matvec(M2, [1.0, 1.0, 1.0])
    err = abs(r[0] - 1.0) + abs(r[1]) + abs(r[2])
    check(err < IDENTITY_TOL, f"M2 × (1,1,1) ≈ (1,0,0) (err={err:.2e})")


def validate_m1_derivation():
    """Check stored M1 matrices match first-principles derivation."""
    print("\n3. M1 matrices match chromaticity-based derivation")

    for name in STORED_M1:
        derived = derive_m1(name)
        stored = STORED_M1[name]
        diff = mat_max_diff(derived, stored)
        check(diff < MATRIX_TOL, f"M1[{name}] (diff={diff:.2e})")


def validate_row_sums():
    """Check all M1 row sums ≈ 1.0 (white maps to white)."""
    print("\n4. M1 row sums ≈ 1.0")

    for name, M1 in STORED_M1.items():
        rs = [sum(row) for row in M1]
        err = max(abs(s - 1.0) for s in rs)
        check(err < WHITE_TOL, f"M1[{name}] row sums (err={err:.2e})")


def validate_oklab_bounds():
    """Check MAX_CHROMA_A/B cover the display-output gamut union hull.

    v0.6 sizes the chroma DC ranges to the OKLAB hull of the union of the
    display-output gamuts (sRGB ∪ Display P3 ∪ Adobe RGB) so wide-gamut colors
    are stored faithfully for multi-gamut decode output (spec §11). The range
    stops there — wider sources (BT.2020/ProPhoto) clip at encode, since no
    supported display can show beyond this hull; the decode-aware DC search
    (spec §10.3) keeps the stored DC within ±1 code of the true average.
    """
    print("\n5. OKLAB bounds and MAX_CHROMA coverage (sRGB∪P3∪Adobe hull)")

    union_max_a = 0.0
    union_max_b = 0.0

    for m1 in (M1_SRGB, M1_DISPLAY_P3, M1_ADOBE_RGB):
        for r in [0.0, 1.0]:
            for g in [0.0, 1.0]:
                for b in [0.0, 1.0]:
                    if r == 0 and g == 0 and b == 0:
                        continue
                    lms = matvec(m1, [r, g, b])
                    lms_cbrt = [math.copysign(abs(x) ** (1 / 3), x) for x in lms]
                    lab = matvec(M2, lms_cbrt)
                    union_max_a = max(union_max_a, abs(lab[1]))
                    union_max_b = max(union_max_b, abs(lab[2]))

    check(MAX_CHROMA_A >= union_max_a,
          f"MAX_CHROMA_A={MAX_CHROMA_A} ≥ sRGB∪P3∪Adobe hull max |a|={union_max_a:.4f}")
    check(MAX_CHROMA_B >= union_max_b,
          f"MAX_CHROMA_B={MAX_CHROMA_B} ≥ sRGB∪P3∪Adobe hull max |b|={union_max_b:.4f}")
    # Ranges should be tight: more than ~10% slack wastes quantization precision.
    check(MAX_CHROMA_A <= union_max_a * 1.1,
          f"MAX_CHROMA_A={MAX_CHROMA_A} ≤ 1.1 × union hull max |a| (tight range)")
    check(MAX_CHROMA_B <= union_max_b * 1.1,
          f"MAX_CHROMA_B={MAX_CHROMA_B} ≤ 1.1 × union hull max |b| (tight range)")


def validate_scale_constants():
    """Check scale and clamp constants are positive and reasonable."""
    print("\n6. Scale factor and clamp constants")

    for name, val in [
        ("MAX_L_SCALE", MAX_L_SCALE),
        ("MAX_A_SCALE", MAX_A_SCALE),
        ("MAX_B_SCALE", MAX_B_SCALE),
        ("MAX_A_ALPHA_SCALE", MAX_A_ALPHA_SCALE),
    ]:
        check(val > 0, f"{name} = {val} > 0")
        check(val <= 1.0, f"{name} = {val} ≤ 1.0")


def validate_mu_law():
    """Check µ-law round-trip and exact-zero properties for all format µ values."""
    print("\n7. µ-law companding round-trip (v0.6 odd level count)")

    def mu_compress(v, mu):
        return math.copysign(1, v) * math.log(1 + mu * abs(v)) / math.log(1 + mu)

    def mu_expand(c, mu):
        return math.copysign(1, c) * ((1 + mu) ** abs(c) - 1) / mu

    for mu_name, mu in [("MU_L", MU_L), ("MU_C", MU_C), ("MU_ALPHA", MU_ALPHA)]:
        check(mu > 0, f"{mu_name} = {mu} > 0")

        # Round-trip at extreme values
        for v in [-1.0, -0.5, 0.0, 0.5, 1.0]:
            c = mu_compress(v, mu)
            rt = mu_expand(c, mu)
            err = abs(rt - v)
            check(err < 1e-12, f"{mu_name}: round-trip at v={v:+.1f} (err={err:.2e})")

        # Check compressed range is [-1, 1]
        c_max = mu_compress(1.0, mu)
        c_min = mu_compress(-1.0, mu)
        check(abs(c_max - 1.0) < 1e-12, f"{mu_name}: µ-law(1.0) ≈ 1.0")
        check(abs(c_min + 1.0) < 1e-12, f"{mu_name}: µ-law(-1.0) ≈ -1.0")

        # Exact-zero property (v1, unchanged from v0.6): with 2^bits − 1 levels,
        # the center index dequantizes to exactly 0.0 at every AC bit width the
        # format uses (4-bit chroma/alpha, 5-bit luma) plus 6-bit headroom.
        for bits in [4, 5, 6]:
            max_idx = (1 << bits) - 2
            center = max_idx // 2
            c = center / max_idx * 2 - 1
            check(mu_expand(c, mu) == 0.0,
                  f"{mu_name}: center code is exact zero at {bits} bits")


def validate_aspect_ratio():
    """Check aspect ratio encoding for known ratios."""
    print("\n8. Aspect ratio encoding")

    def encode_aspect(w, h):
        import math as m
        return max(0, min(255, round((m.log2(w / h) + 4) / 8 * 255)))

    def decode_aspect(byte_val):
        return 2 ** (byte_val / 255 * 8 - 4)

    test_cases = [
        ("1:1", 1.0, 1.0),
        ("3:2", 3.0, 2.0),
        ("4:3", 4.0, 3.0),
        ("16:9", 16.0, 9.0),
        ("4:1", 4.0, 1.0),
        ("1:4", 1.0, 4.0),
        ("16:1", 16.0, 1.0),
        ("1:16", 1.0, 16.0),
    ]

    for label, w, h in test_cases:
        byte_val = encode_aspect(w, h)
        decoded = decode_aspect(byte_val)
        actual = w / h
        err = abs(decoded - actual) / actual * 100
        check(err < 1.1, f"Aspect {label}: error={err:.3f}% < 1.1%")


def validate_selection():
    """Check coefficient selection properties across tiers. Per spec §6 (v1)."""
    print("\n9. Coefficient selection (weighted top-K frequency order, all tiers)")

    representative = [0, 64, 100, 128, 159, 191, 255]
    a_q, h_q = q12(ANISO_OBLIQUE), q12(SEL_HV)

    def check_invariants(byte_iter, tier):
        """Return (invariants_ok, fully_satisfied) for the bytes at this tier."""
        ok = True
        satisfied = True
        for byte in byte_iter:
            w, h = decode_output_size(byte, tier)
            candidates = w * h - 1
            for k in format_ks(tier):
                if k > candidates:
                    satisfied = False
                coeffs, p_k = select_coefficients(byte, tier, k)
                if len(coeffs) != k:
                    ok = False
                if (0, 0) in coeffs:
                    ok = False
                if any(cx >= w or cy >= h for cx, cy in coeffs):
                    ok = False
                # Transmission order is ascending in the §6.2 key, not in the
                # bare priority — the weights are exactly what reorders it.
                keys = [selection_key(cx * h, cy * w, a_q, h_q) for cx, cy in coeffs]
                if keys != sorted(keys):
                    ok = False
                last_cx, last_cy = coeffs[-1]
                if p_k != (last_cx * h) ** 2 + (last_cy * w) ** 2 or p_k <= 0:
                    ok = False
        return ok, satisfied

    # Default tier: exhaustive over all 256 aspect bytes (preserves v0.6 coverage).
    ok0, sat0 = check_invariants(range(256), DEFAULT_TIER)
    check(ok0, "Default tier, all 256 bytes × all K: count, DC excluded, in-bounds, "
               "ascending priority, p_k consistent")
    check(sat0, "Default tier: every K ≤ candidate count (selection fully satisfied)")

    # Every other code: representative aspect bytes, K scaled by 4^level.
    okN, satN = True, True
    others = [t for t in range(MAX_TIER + 1) if t != DEFAULT_TIER]
    for tier in others:
        o, s = check_invariants(representative, tier)
        okN = okN and o
        satN = satN and s
    check(okN, f"Codes {others} (representative bytes): same invariants with "
               "K(tier) = K·4^level")
    check(satN, f"Codes {others}: every K(tier) ≤ candidate count")

    # ── The bare order (both weights zeroed) ─────────────────────────────
    # Square at byte=128 (W=H=32): radial order, ℓ2 ball
    def bare(byte, tier, k):
        return select_coefficients(byte, tier, k, 0.0, 0.0)

    coeffs_9, _ = bare(128, 0, 9)
    check(coeffs_9[0] == (0, 1) and coeffs_9[1] == (1, 0),
          "Square K=9: first two slots are (0,1),(1,0) — tied priority, lex tiebreak")
    check(coeffs_9[2] == (1, 1), "Square K=9: third slot is (1,1)")

    coeffs_26, _ = bare(128, 0, 26)
    check((3, 4) in coeffs_26 and (4, 3) in coeffs_26,
          "Square K=26: ℓ2 ball includes diagonals (3,4)/(4,3)")
    check((6, 0) not in coeffs_26 and (0, 6) not in coeffs_26,
          "Square K=26: ℓ2 ball excludes axis extremes (6,0)/(0,6)")

    # Zeroing both weights must reproduce the bare priority order exactly — the
    # key is then `priority << 16`, which is order-identical to `priority`.
    zero_ok = True
    for byte in representative:
        w, h = decode_output_size(byte, 0)
        pri = sorted(
            ((cx * h) ** 2 + (cy * w) ** 2, cx, cy)
            for cy in range(h) for cx in range(w) if (cx, cy) != (0, 0)
        )
        if bare(byte, 0, 28)[0] != [(cx, cy) for _, cx, cy in pri[:28]]:
            zero_ok = False
    check(zero_ok, "aniso = hv = 0 ⇒ key is priority << 16 ⇒ the bare priority order")

    # ── The shipped weighted order (§6.2) ─────────────────────────────────
    # Same K returns the same low frequencies at any tier: the key is
    # homogeneous, so doubling the grid scales every key by 4 and leaves the
    # order untouched. Per spec §6.2.
    coeffs_w26, _ = select_coefficients(128, DEFAULT_TIER, 26)
    same_across_tiers = all(
        select_coefficients(128, t, 26)[0] == coeffs_w26 for t in range(MAX_TIER + 1)
    )
    check(same_across_tiers,
          f"Same K=26 ⇒ identical low frequencies across codes 0..{MAX_TIER}")
    # The larger high-tier grid is what lets K itself scale to reach genuinely
    # higher frequencies (always satisfiable).
    max0 = max(max(cx, cy) for cx, cy in coeffs_w26)
    top_level = render_level(MAX_TIER)
    coeffs_hi, _ = select_coefficients(128, MAX_TIER, 26 << (2 * top_level))
    max_hi = max(max(cx, cy) for cx, cy in coeffs_hi)
    check(max_hi > max0,
          f"code {MAX_TIER} with K·4^level reaches higher frequencies "
          f"({max_hi} > {max0})")

    # Both weights must be observable on the square grid (W = H = 32), where
    # the diagonal (1,1) has priority 2048 and the axis pair (2,0)/(0,2) 4096:
    #   (1,1) → 2048·(1 + 1.2·1)·(1 + 0.15·0)  = 4506   (oblique penalty)
    #   (0,2) → 4096·(1 + 1.2·0)·(1 − 0.15·1)  = 3482   (hv favours vertical)
    #   (2,0) → 4096·(1 + 1.2·0)·(1 + 0.15·1)  = 4710
    # so the bare order (1,1) < (0,2) = (2,0) becomes (0,2) < (1,1) < (2,0).
    first4 = select_coefficients(128, 0, 4)[0]
    check(first4.index((0, 2)) < first4.index((1, 1)),
          f"aniso = {ANISO_OBLIQUE}: the oblique penalty demotes the diagonal "
          f"(1,1) behind the axis frequency (0,2) (K=4 → {first4})")
    check(bare(128, 0, 4)[0].index((1, 1)) < 3,
          "…which the bare order does not: it puts (1,1) third")
    first6 = select_coefficients(128, 0, 6)[0]
    check(first6.index((0, 2)) < first6.index((2, 0)),
          f"hv = {SEL_HV}: the tied axis pair splits in favour of the vertical "
          f"frequency (0,2) over (2,0)")

    # Extreme landscape at byte=255 (W=32, H=2): long axis dominates
    coeffs_land, _ = select_coefficients(255, 0, 26)
    cy0 = sum(1 for _, cy in coeffs_land if cy == 0)
    check(cy0 >= 15, f"16:1 landscape K=26: {cy0} ≥ 15 slots on the long axis")
    check(all(cy < 2 for _, cy in coeffs_land),
          "16:1 landscape: no cy ≥ H=2 frequency ever selected")

    # Portrait/landscape symmetry: byte b and byte (255−b) have mirrored
    # (W, H), so under the BARE order the selected priority multisets are
    # identical. The exact coefficient sets may differ within an equal-priority
    # tie group cut at the K boundary (the (key, cx, cy) tiebreak is not
    # swap-invariant); this is benign — the multiset and p_k stay invariant.
    sym_ok = True
    for b in range(128):
        w_lo, h_lo = decode_output_size(b, 0)
        w_hi, h_hi = decode_output_size(255 - b, 0)
        if (w_lo, h_lo) != (h_hi, w_hi):
            sym_ok = False
        for k in FORMAT_KS:
            lo, pk_lo = bare(b, 0, k)
            hi, pk_hi = bare(255 - b, 0, k)
            pri_lo = sorted((cx * h_lo) ** 2 + (cy * w_lo) ** 2 for cx, cy in lo)
            pri_hi = sorted((cx * h_hi) ** 2 + (cy * w_hi) ** 2 for cx, cy in hi)
            if pri_lo != pri_hi or pk_lo != pk_hi:
                sym_ok = False
    check(sym_ok, "Bare priority order: portrait/landscape symmetry — mirrored dims, "
                  "equal priority multisets and p_k across all K")

    # hv ≠ 0 BREAKS that symmetry on purpose: cos2θ flips sign under the
    # transpose, so a landscape image and its portrait mirror do not select
    # mirrored frequency sets. Assert the asymmetry so it can never be
    # reintroduced as a "fix".
    asym = False
    for b in range(128):
        w_lo, h_lo = decode_output_size(b, 0)
        if (w_lo, h_lo) == (h_lo, w_lo):
            continue
        lo, _ = select_coefficients(b, 0, 28)
        hi, _ = select_coefficients(255 - b, 0, 28)
        if sorted(lo) != sorted((cy, cx) for cx, cy in hi):
            asym = True
            break
    check(asym, f"hv = {SEL_HV} deliberately breaks portrait/landscape symmetry "
                "(vertical detail is favoured over horizontal)")


def validate_length_formula():
    """Check the v1 deterministic length formula and tier scaling. Per spec §3 (v1).

    v1 drops v0.6's fixed 256-bit/32-byte frame. The encoded length is
    body_len_bytes(layout, has_alpha, tier) =
        ceil((PREFIX_BITS [+ ALPHA_PREFIX_BITS] + ac_payload_bits) / 8).
    The default tier (code 1) is 32 bytes for BOTH alpha modes (the v0.6 footprint,
    for equal-budget comparison); codes 2..=4 scale every AC count by 4^level, for
    level = render_level(tier) = max(0, tier - 1), and grow the body toward 4× as
    the fixed prefix becomes negligible. There is no CRC.
    """
    print("\n10. v1 length formula and tier scaling")

    layout = DEFAULT_LAYOUT  # the default tier; other codes use tier_layout(tier)

    # Version / tier descriptor constants are consistent.
    check(FORMAT_VERSION == 0, f"FORMAT_VERSION = {FORMAT_VERSION} (format v1)")
    check(MAX_TIER == 4,
          f"MAX_TIER = {MAX_TIER} (highest tier code, and highest quality)")
    # The codes are ordered by quality: compact is the smallest code as well as
    # the smallest hash, and the default is one above it. Pin both, and pin that
    # the two share a render level — the only place the ordering is not 1:1.
    check(COMPACT_TIER == 0, f"COMPACT_TIER = {COMPACT_TIER} (code 0)")
    check(DEFAULT_TIER == 1, f"DEFAULT_TIER = {DEFAULT_TIER} (code 1)")
    check(COMPACT_TIER < DEFAULT_TIER < MAX_TIER,
          "tier codes are ordered by quality")
    check(all(is_valid_tier(t) for t in range(MAX_TIER + 1)),
          f"codes 0..={MAX_TIER} are all valid")
    check(all(not is_valid_tier(t) for t in (5, 6, 7)),
          "codes 5..=7 remain reserved and are rejected")
    check(render_level(COMPACT_TIER) == 0,
          "compact tier renders at level 0 (the default tier's resolution)")
    check(render_level(DEFAULT_TIER) == 0,
          "the default tier renders at level 0 too")
    check(tier_count_scale(COMPACT_TIER) == 1,
          "compact tier scales coefficient counts by 1")
    check(all(render_level(t) == max(0, t - 1) for t in range(MAX_TIER + 1)),
          "renderLevel(tier) = max(0, tier - 1) for every code")
    # It must be genuinely smaller than the default in both alpha modes, or it
    # is not a compact tier at all.
    for has_alpha in (False, True):
        label = "alpha" if has_alpha else "no-alpha"
        nc = body_len_bytes(tier_layout(COMPACT_TIER), has_alpha, COMPACT_TIER)
        n0 = body_len_bytes(tier_layout(DEFAULT_TIER), has_alpha, DEFAULT_TIER)
        check(nc == 21, f"compact {label} length = {nc} bytes (= 21)")
        check(nc < n0, f"compact {label} ({nc} B) is smaller than the default ({n0} B)")

    # Fixed prefix framing: 16-bit descriptor/aspect + 38-bit DC/scale = 54 bits.
    check(PREFIX_BITS == 54, f"PREFIX_BITS = {PREFIX_BITS} (= 54)")
    check(PREFIX_BITS == DESCRIPTOR_BITS + DC_SCALE_BITS,
          f"PREFIX_BITS = DESCRIPTOR_BITS({DESCRIPTOR_BITS}) + "
          f"DC_SCALE_BITS({DC_SCALE_BITS})")
    check(ALPHA_PREFIX_BITS == 9,
          f"ALPHA_PREFIX_BITS = {ALPHA_PREFIX_BITS} (= 9: alpha DC 5 + scale 4)")

    # The default tier is exactly 32 bytes for both alpha modes.
    for has_alpha in (False, True):
        label = "alpha" if has_alpha else "no-alpha"
        n = body_len_bytes(layout, has_alpha, DEFAULT_TIER)
        check(n == 32, f"default-tier {label} length = {n} bytes (= 32)")

    # Default-tier bit accounting matches the spec's stated split.
    no_alpha_bits = PREFIX_BITS + ac_payload_bits(ac_shape(layout, False, DEFAULT_TIER))
    check(no_alpha_bits == 256,
          f"default-tier no-alpha = {no_alpha_bits} bits (54 prefix + 112 L + 90 chroma)")
    alpha_bits = (PREFIX_BITS + ALPHA_PREFIX_BITS
                  + ac_payload_bits(ac_shape(layout, True, DEFAULT_TIER)))
    check(alpha_bits == 253,
          f"default-tier alpha = {alpha_bits} bits (54 + 9 + 88 L + 18 chroma + 84 alpha)")
    # The alpha channel must never have fewer coefficients at a higher tier than
    # at a lower one — the failure the per-row allocation of §11.3 introduces if
    # a row is updated in isolation.
    prev_a = 0
    for tier in range(MAX_TIER + 1):
        n = ac_shape(tier_layout(tier), True, tier).alpha_ac_count
        check(n >= prev_a,
              f"alpha AC count at code {tier} is {n} (>= {prev_a} at the code below)")
        prev_a = n

    # Higher tiers: positive, strictly growing, and approaching 4× per level.
    for has_alpha in (False, True):
        label = "alpha" if has_alpha else "no-alpha"
        prev = body_len_bytes(layout, has_alpha, DEFAULT_TIER)
        for tier in range(DEFAULT_TIER + 1, MAX_TIER + 1):
            n = body_len_bytes(tier_layout(tier), has_alpha, tier)
            ratio = n / prev
            check(n > 0 and n > prev,
                  f"{label} code {tier} length {n} bytes > code {tier - 1} ({prev})")
            check(3.0 <= ratio <= 4.0,
                  f"{label} code {tier}/{tier - 1} length ratio {ratio:.3f} ≈ 4×")
            prev = n

    # The whole ladder is strictly increasing in byte length, which is what
    # "the codes are ordered by quality" means on the wire.
    for has_alpha in (False, True):
        label = "alpha" if has_alpha else "no-alpha"
        lengths = [body_len_bytes(tier_layout(t), has_alpha, t)
                   for t in range(MAX_TIER + 1)]
        check(all(a < b for a, b in zip(lengths, lengths[1:])),
              f"{label} byte length is strictly increasing in the tier code: {lengths}")

    # Within the codes-2..=4 band the AC payload scales by EXACTLY 4^level and
    # bit widths stay constant. Codes 0 and 1 are excluded on purpose: each has
    # its own layout (§3.2), so neither is the code-2 base scaled down.
    for has_alpha in (False, True):
        label = "alpha" if has_alpha else "no-alpha"
        upper = tier_layout(DEFAULT_TIER + 1)
        base = ac_shape(upper, has_alpha, DEFAULT_TIER)
        base_payload = ac_payload_bits(base)
        for tier in range(DEFAULT_TIER + 1, MAX_TIER + 1):
            s = tier_count_scale(tier)
            level = render_level(tier)
            check(s == 4 ** level, f"tier_count_scale({tier}) = {s} (= 4^{level})")
            shape = ac_shape(upper, has_alpha, tier)
            check(ac_payload_bits(shape) == base_payload * s,
                  f"{label} tier {tier} AC payload scales ×{s} "
                  f"(= {base_payload * s} bits)")
            check(shape.l_count() == base.l_count() * s,
                  f"{label} code {tier} L count {shape.l_count()} "
                  f"= {base.l_count()}·4^{level}")
            check(shape.c_count == base.c_count * s,
                  f"{label} code {tier} chroma count {shape.c_count} "
                  f"= {base.c_count}·4^{level}")
            check(shape.alpha_ac_count == base.alpha_ac_count * s,
                  f"{label} tier {tier} alpha-AC count = {shape.alpha_ac_count}")
            check(shape.c_bits == base.c_bits
                  and shape.l_tiers[0][1] == base.l_tiers[0][1],
                  f"{label} tier {tier} bit widths constant "
                  f"(L={shape.l_tiers[0][1]}, C={shape.c_bits})")


# =========================================================================
# Main
# =========================================================================

def validate_against_vectors():
    """Check this reference against the shared test vectors. Per spec §2.

    The other checks in this file are self-consistent: they verify the constants
    against each other and against arithmetic. That is not enough. A reference
    implementation can be internally coherent and still disagree with the
    normative bytes — which is exactly what happened to `decode_output_size`,
    where shifting by the tier code rather than the render level gave the
    compact tier a 512 px grid while every self-consistent check still passed.

    The vectors are the only thing that can catch that class of error, so the
    Python reference is now measured against them like any other port.
    """
    import json
    import os

    print("\n11. Reference vs shared test vectors")
    vec_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test-vectors")

    # Render size: the half of the render-level rule no length check can see.
    with open(os.path.join(vec_dir, "unit-aspect.json")) as f:
        aspect_cases = json.load(f)
    bad = []
    for c in aspect_cases:
        i, e = c["input"], c["expected"]
        got = selection.decode_output_size(e["byte"], i["tier"])
        if got != (e["output_width"], e["output_height"]):
            bad.append((c["name"], got, (e["output_width"], e["output_height"])))
    check(not bad,
          f"decode_output_size matches all {len(aspect_cases)} unit-aspect vectors"
          + (f" — MISMATCH: {bad[:3]}" if bad else ""))

    # Selection order and p_k, including the weighted form.
    with open(os.path.join(vec_dir, "unit-selection.json")) as f:
        sel_cases = json.load(f)
    bad = []
    for c in sel_cases:
        i, e = c["input"], c["expected"]
        coeffs, p_k = selection.select_coefficients(
            i["aspect_byte"], i["tier"], i["k"], i.get("aniso", 0.0), i.get("hv", 0.0)
        )
        if [list(x) for x in coeffs] != e["coeffs"] or p_k != e["p_k"]:
            bad.append(c["name"])
    check(not bad,
          f"select_coefficients matches all {len(sel_cases)} unit-selection vectors"
          + (f" — {len(bad)} MISMATCHED: {bad[:3]}" if bad else ""))

    # Byte length, across every tier code and both alpha modes.
    with open(os.path.join(vec_dir, "integration-encode.json")) as f:
        enc_cases = json.load(f)
    bad = []
    for c in enc_cases:
        e = c["expected"]
        raw = e["hash"]
        tier = (raw[0] >> 3) & 0b111
        has_alpha = bool((raw[0] >> ALPHA_FLAG_BIT) & 1)
        want = body_len_bytes(tier_layout(tier), has_alpha, tier)
        if want != len(raw):
            bad.append((c["name"], want, len(raw)))
    check(not bad,
          f"body_len_bytes matches all {len(enc_cases)} integration-encode vectors"
          + (f" — MISMATCH: {bad[:3]}" if bad else ""))



# =========================================================================
# Cross-implementation constant parity
# =========================================================================
# This file is the spec's own re-derivation of `spec/constants.py`, and until
# now that was the whole of it: nothing compared `constants.py` to the Rust
# reference it claims to describe, or to the third hand-maintained copy in
# `typescript/src/header.ts`.
#
# Three copies, two of them unchecked, is a standing invitation to drift. The
# TypeScript one is the worst of it: the pure-TS decoder re-declares all three
# layouts, every bit width, every quantization maximum, all three µ values and
# the selection weights, and the only thing that compared it to anything was a
# unit test checking three tier *codes* against WASM. A moved layout row or a
# changed `SEL_HV` would survive there until somebody regenerated the golden
# vectors and noticed the mismatch several languages later.
#
# So the parity is asserted here, where it costs nothing to run: this script has
# no path filter in `ci-repo.yml`, so it fires on every push. The sources are
# read as text rather than imported — Rust and TypeScript are not importable
# from Python, and a regex over a `const` declaration is exactly as strong as
# the thing it is protecting, which is that somebody typed the same number three
# times.

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_source(rel: str):
    """Text of `rel` under the repo root, or None if it is not there.

    `spec/README.md` and `TESTING.md` both invite running this script on its
    own, and `spec/` is the part of the tree a reimplementer is most likely to
    copy out. Read directly, a missing `rust/src/constants.rs` raised
    FileNotFoundError out of the middle of the run and killed the process
    *before* the "Results: N passed, M failed" summary -- so a standalone user
    lost every check that had already passed, and the one thing that went wrong
    was reported as a traceback rather than as a failed check. Returning None
    lets the caller record it as the failure it is and let the summary print.
    """
    try:
        with open(os.path.join(REPO, rel), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def _rust_source():
    return _read_source("rust/src/constants.rs")


def _ts_source():
    return _read_source("typescript/src/header.ts")


def _num(text: str, pattern: str):
    """First capture of `pattern` in `text`, as a float, or None.

    Searched with `re.M` so a pattern can anchor to the start of the line its
    constant is declared on; see the pattern table for why that is not
    optional.
    """
    m = re.search(pattern, text, re.M)
    return float(m.group(1)) if m else None


def _rust_tunables(src: str) -> str:
    """Body of `const DEFAULT: Tunables = Tunables { .. };`, or `""`.

    The 11 tunable defaults are struct fields, not `const`s, so they have no
    declaration line of their own to anchor a pattern to; scoping the search to
    `DEFAULT`'s body is that anchor. Searched over the whole file instead,
    `max_chroma_a` is answered by whichever `Tunables { .. }` literal comes
    first -- a doc example, a test fixture, a second literal written above this
    one -- and the shipped value below it is never read.
    """
    m = re.search(
        r"const\s+DEFAULT\s*:\s*Tunables\s*=\s*Tunables\s*\{(.*?)\n\s*\};",
        src,
        re.S,
    )
    return m.group(1) if m else ""


def _rust_layout(src: str, name: str):
    """Parse `const NAME: AcLayout = AcLayout { .. };` into a comparable tuple."""
    m = re.search(
        r"const\s+" + re.escape(name) + r"\s*:\s*AcLayout\s*=\s*AcLayout\s*\{(.*?)\n\};",
        src,
        re.S,
    )
    if not m:
        return None
    body = m.group(1)

    # `a_count` is a substring of `ca_count` and `a_bits` of `ca_bits`, so
    # every field needs a left word boundary or it silently reads its neighbour.
    def bands(field):
        b = re.search(r"(?<![A-Za-z_])" + field + r"\s*:\s*\[\s*\((\d+),\s*(\d+)\),\s*\((\d+),\s*(\d+)\)", body)
        return (int(b.group(1)), int(b.group(2)), int(b.group(3)), int(b.group(4))) if b else None

    def scalar(field):
        v = re.search(r"(?<![A-Za-z_])" + field + r"\s*:\s*(\d+)", body)
        return int(v.group(1)) if v else None

    return (
        bands("l_tiers"), scalar("c_count"), scalar("c_bits"),
        bands("la_tiers"), scalar("ca_count"), scalar("ca_bits"),
        scalar("a_count"), scalar("a_bits"),
    )


def _ts_layout(src: str, name: str):
    """Parse `const NAME: AcLayout = { .. };` into the same tuple shape."""
    m = re.search(
        r"const\s+" + re.escape(name) + r"\s*:\s*AcLayout\s*=\s*\{(.*?)\n\};", src, re.S
    )
    if not m:
        return None
    body = m.group(1)

    # As the Rust reader: `aCount` is a substring of `caCount`.
    def bands(field):
        b = re.search(r"(?<![A-Za-z])" + field + r"\s*:\s*\[\s*\[\s*(\d+),\s*(\d+),?\s*\],\s*\[\s*(\d+),\s*(\d+),?\s*\]", body, re.S)
        return (int(b.group(1)), int(b.group(2)), int(b.group(3)), int(b.group(4))) if b else None

    def scalar(field):
        v = re.search(r"(?<![A-Za-z])" + field + r"\s*:\s*(\d+)", body)
        return int(v.group(1)) if v else None

    return (
        bands("lBands"), scalar("cCount"), scalar("cBits"),
        bands("laBands"), scalar("caCount"), scalar("caBits"),
        scalar("aCount"), scalar("aBits"),
    )


def _spec_layout(layout):
    return (
        (layout.l_tiers[0][0], layout.l_tiers[0][1], layout.l_tiers[1][0], layout.l_tiers[1][1]),
        layout.c_count, layout.c_bits,
        (layout.la_tiers[0][0], layout.la_tiers[0][1], layout.la_tiers[1][0], layout.la_tiers[1][1]),
        layout.ca_count, layout.ca_bits,
        layout.a_count, layout.a_bits,
    )


def validate_cross_implementation_constants():
    print("\nCross-implementation constant parity (spec / Rust / TypeScript):")
    rust = _rust_source()
    ts = _ts_source()
    # `SEL_Q` lives in dct.rs, not constants.rs — read it from there.
    dct_src = _read_source("rust/src/dct.rs")

    # Every source this function compares against lives outside `spec/`, so all
    # three are absent whenever the script is run on its own (see
    # `_read_source`). Checked together and up front: one failed check naming
    # what is missing, and the parity assertions below skipped rather than
    # attempted against None.
    sources = (
        ("rust/src/constants.rs", rust),
        ("typescript/src/header.ts", ts),
        ("rust/src/dct.rs", dct_src),
    )
    unreadable = [name for name, src in sources if src is None]
    check(
        not unreadable,
        "implementation sources are readable"
        + ("" if not unreadable
           else f" — {len(unreadable)} missing: {', '.join(unreadable)}"
                " (running outside the monorepo? the parity checks below need"
                " the other languages' trees)"),
    )

    # --- Scalars: (spec value, Rust pattern, TypeScript pattern) ---
    #
    # Both patterns are anchored to the declaration they mean to read: the Rust
    # and TypeScript `const`s to the start of their own line, the `Tunables`
    # fields to `DEFAULT`'s body (`_rust_tunables`) with the same left word
    # boundary `_rust_layout` needs. Unanchored, `re.search` takes the first
    # line that merely quotes the name -- a comment reading
    # `MAX_CHROMA_B = 0.33`, a doc example, a second `Tunables { .. }` -- and
    # never reaches the drifted declaration below it. The check then compares
    # prose against prose and passes.
    scalars = [
        ("MAX_CHROMA_A", MAX_CHROMA_A,
         r"(?<![A-Za-z_])max_chroma_a:\s*([\d.]+)",
         r"^(?:export )?const MAX_CHROMA_A\s*=\s*([\d.]+)"),
        ("MAX_CHROMA_B", MAX_CHROMA_B,
         r"(?<![A-Za-z_])max_chroma_b:\s*([\d.]+)",
         r"^(?:export )?const MAX_CHROMA_B\s*=\s*([\d.]+)"),
        ("MAX_L_SCALE", MAX_L_SCALE,
         r"(?<![A-Za-z_])max_l_scale:\s*([\d.]+)",
         r"^(?:export )?const MAX_L_SCALE\s*=\s*([\d.]+)"),
        ("MAX_A_SCALE", MAX_A_SCALE,
         r"(?<![A-Za-z_])max_a_scale:\s*([\d.]+)",
         r"^(?:export )?const MAX_A_SCALE\s*=\s*([\d.]+)"),
        ("MAX_B_SCALE", MAX_B_SCALE,
         r"(?<![A-Za-z_])max_b_scale:\s*([\d.]+)",
         r"^(?:export )?const MAX_B_SCALE\s*=\s*([\d.]+)"),
        ("MAX_A_ALPHA_SCALE", MAX_A_ALPHA_SCALE,
         r"(?<![A-Za-z_])max_alpha_scale:\s*([\d.]+)",
         r"^(?:export )?const MAX_ALPHA_SCALE\s*=\s*([\d.]+)"),
        ("MU_L", MU_L,
         r"(?<![A-Za-z_])mu_l:\s*([\d.]+)",
         r"^(?:export )?const MU_L\s*=\s*([\d.]+)"),
        ("MU_C", MU_C,
         r"(?<![A-Za-z_])mu_c:\s*([\d.]+)",
         r"^(?:export )?const MU_C\s*=\s*([\d.]+)"),
        ("MU_ALPHA", MU_ALPHA,
         r"(?<![A-Za-z_])mu_alpha:\s*([\d.]+)",
         r"^(?:export )?const MU_ALPHA\s*=\s*([\d.]+)"),
        # The synthesis window, disabled in v1 but declared and read by both
        # decoders. Rust holds these as Tunables fields, so the Rust patterns
        # are unanchored and resolve inside DEFAULT's body like the rest.
        ("W_MIN_L", W_MIN_L,
         r"(?<![A-Za-z_])w_min_l:\s*([\d.]+)",
         r"^(?:export )?const W_MIN_L\s*=\s*([\d.]+)"),
        ("W_EXP_L", W_EXP_L,
         r"(?<![A-Za-z_])w_exp_l:\s*([\d.]+)",
         r"^(?:export )?const W_EXP_L\s*=\s*([\d.]+)"),
        ("W_MIN_C", W_MIN_C,
         r"(?<![A-Za-z_])w_min_c:\s*([\d.]+)",
         r"^(?:export )?const W_MIN_C\s*=\s*([\d.]+)"),
        ("W_EXP_C", W_EXP_C,
         r"(?<![A-Za-z_])w_exp_c:\s*([\d.]+)",
         r"^(?:export )?const W_EXP_C\s*=\s*([\d.]+)"),
        ("ANISO_OBLIQUE", ANISO_OBLIQUE,
         r"(?<![A-Za-z_])aniso_oblique:\s*([\d.]+)",
         r"^(?:export )?const ANISO_OBLIQUE\s*=\s*([\d.]+)"),
        ("SEL_HV", SEL_HV,
         r"(?<![A-Za-z_])sel_hv:\s*([\d.]+)",
         r"^(?:export )?const SEL_HV\s*=\s*([\d.]+)"),
        ("SEL_Q", SEL_Q,
         r"^pub const SEL_Q:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const SEL_Q\s*=\s*(\d+)"),
        ("FORMAT_VERSION", FORMAT_VERSION,
         r"^pub const FORMAT_VERSION:\s*u8\s*=\s*(\d+)",
         r"^(?:export )?const FORMAT_VERSION\s*=\s*(\d+)"),
        ("BASE_LONG_EDGE", BASE_LONG_EDGE,
         r"^pub const BASE_LONG_EDGE:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const BASE_LONG_EDGE\s*=\s*(\d+)"),
        ("MAX_TIER", MAX_TIER,
         r"^pub const MAX_TIER:\s*u8\s*=\s*(\d+)",
         r"^(?:export )?const MAX_TIER\s*=\s*(\d+)"),
        ("L_DC_BITS", L_DC_BITS,
         r"^pub const L_DC_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const L_DC_BITS\s*=\s*(\d+)"),
        ("L_SCALE_BITS", L_SCALE_BITS,
         r"^pub const L_SCALE_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const L_SCALE_BITS\s*=\s*(\d+)"),
        ("B_SCALE_BITS", B_SCALE_BITS,
         r"^pub const B_SCALE_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const B_SCALE_BITS\s*=\s*(\d+)"),
        ("ALPHA_DC_BITS", ALPHA_DC_BITS,
         r"^pub const ALPHA_DC_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const ALPHA_DC_BITS\s*=\s*(\d+)"),
        ("ALPHA_SCALE_BITS", ALPHA_SCALE_BITS,
         r"^pub const ALPHA_SCALE_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const ALPHA_SCALE_BITS\s*=\s*(\d+)"),
        # The header's own layout. Every one of these decides where a field
        # starts or how wide it is, so a disagreement between two
        # implementations is a wire-format split -- the exact failure this
        # function exists to catch -- and none of them was checked. The three
        # DC/scale widths below made it worse than an omission: L_DC_BITS,
        # L_SCALE_BITS and B_SCALE_BITS were checked while their A and B
        # siblings, declared on the neighbouring lines of all three files, were
        # not. A reader of this list had every reason to believe the set was
        # complete.
        ("VERSION_BITS", VERSION_BITS,
         r"^pub const VERSION_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const VERSION_BITS\s*=\s*(\d+)"),
        ("TIER_BITS", TIER_BITS,
         r"^pub const TIER_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const TIER_BITS\s*=\s*(\d+)"),
        ("ALPHA_FLAG_BIT", ALPHA_FLAG_BIT,
         r"^pub const ALPHA_FLAG_BIT:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const ALPHA_FLAG_BIT\s*=\s*(\d+)"),
        ("RESERVED_FLAG_BIT", RESERVED_FLAG_BIT,
         r"^pub const RESERVED_FLAG_BIT:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const RESERVED_FLAG_BIT\s*=\s*(\d+)"),
        ("DESCRIPTOR_BITS", DESCRIPTOR_BITS,
         r"^pub const DESCRIPTOR_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const DESCRIPTOR_BITS\s*=\s*(\d+)"),
        ("COMPACT_TIER", COMPACT_TIER,
         r"^pub const COMPACT_TIER:\s*u8\s*=\s*(\d+)",
         r"^(?:export )?const COMPACT_TIER\s*=\s*(\d+)"),
        ("DEFAULT_TIER", DEFAULT_TIER,
         r"^pub const DEFAULT_TIER:\s*u8\s*=\s*(\d+)",
         r"^(?:export )?const DEFAULT_TIER\s*=\s*(\d+)"),
        ("A_DC_BITS", A_DC_BITS,
         r"^pub const A_DC_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const A_DC_BITS\s*=\s*(\d+)"),
        ("B_DC_BITS", B_DC_BITS,
         r"^pub const B_DC_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const B_DC_BITS\s*=\s*(\d+)"),
        ("A_SCALE_BITS", A_SCALE_BITS,
         r"^pub const A_SCALE_BITS:\s*u32\s*=\s*(\d+)",
         r"^(?:export )?const A_SCALE_BITS\s*=\s*(\d+)"),
    ]

    # A `^`-anchored Rust pattern reads a declaration line from the file that
    # declares it; the `Tunables` fields, which have no such line, read
    # `DEFAULT`'s body instead. The pattern says which, so there is no second
    # hand-written list here to fall out of step with the first.
    if not unreadable:
        tunables = _rust_tunables(rust)

        for name, spec_value, rust_pat, ts_pat in scalars:
            if not rust_pat.startswith("^"):
                src = tunables
            else:
                src = dct_src if name == "SEL_Q" else rust
            r = _num(src, rust_pat)
            t = _num(ts, ts_pat)
            check(
                r is not None and t is not None
                and float(spec_value) == r == t,
                f"{name}: spec {spec_value} == Rust {r} == TypeScript {t}",
            )

        # --- Layouts: the whole AC table, all three rows ---
        for name, spec_layout in (
            ("LAYOUT_B", LAYOUT_B),
            ("LAYOUT_T0", LAYOUT_T0),
            ("LAYOUT_TC", LAYOUT_TC),
        ):
            want = _spec_layout(spec_layout)
            got_rust = _rust_layout(rust, name)
            got_ts = _ts_layout(ts, name)
            check(
                got_rust is not None and got_ts is not None
                and want == got_rust == got_ts,
                f"{name}: spec == Rust == TypeScript"
                + ("" if want == got_rust == got_ts
                   else f" — spec {want}, Rust {got_rust}, TypeScript {got_ts}"),
            )

    # --- Completeness: every numeric constant is named above, or excused ---
    #
    # The list above is written by hand, and for ten constants it silently was
    # not: VERSION_BITS, TIER_BITS, ALPHA_FLAG_BIT, RESERVED_FLAG_BIT,
    # DESCRIPTOR_BITS, COMPACT_TIER, DEFAULT_TIER, A_DC_BITS, B_DC_BITS and
    # A_SCALE_BITS each existed in all three sources, each decides where a
    # header field sits or how wide it is, and none was compared. Three of them
    # sat next to siblings that were — L_DC_BITS checked, A_DC_BITS not — so
    # the omission looked like a decision.
    #
    # Nothing could have found that by reading, so it is found by counting
    # instead: constants.py is parsed, and a module-level numeric literal that
    # this function does not compare fails the run. The exception register is
    # empty on purpose — every one of the 30 is checked — and an entry added to
    # it should carry the reason a constant the spec fixes is not one the
    # implementations must agree on.
    not_in_parity: dict[str, str] = {}

    with open(os.path.join(os.path.dirname(__file__), "constants.py"),
              encoding="utf-8") as f:
        const_tree = ast.parse(f.read())
    literals = []
    for node in const_tree.body:
        if not (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)):
            continue
        value = node.value
        if isinstance(value, ast.UnaryOp) and isinstance(value.op, ast.USub):
            value = value.operand
        if (isinstance(value, ast.Constant)
                and isinstance(value.value, (int, float))
                and not isinstance(value.value, bool)):
            literals.append(node.targets[0].id)

    compared = {name for name, _, _, _ in scalars}
    missing = [n for n in literals
               if n not in compared and n not in not_in_parity]
    check(
        not missing,
        f"every numeric constant is compared ({len(literals)} in constants.py)"
        + ("" if not missing
           else f" — {len(missing)} unchecked: {', '.join(missing)}"),
    )
    stale = [n for n in not_in_parity if n not in literals or n in compared]
    check(
        not stale,
        "no stale exception in not_in_parity"
        + ("" if not stale else f" — {', '.join(stale)}"),
    )


if __name__ == "__main__":
    print("ChromaHash Constants Validation")
    print("=" * 60)

    validate_matrix_inverses()
    validate_white_point()
    validate_m1_derivation()
    validate_row_sums()
    validate_oklab_bounds()
    validate_scale_constants()
    validate_mu_law()
    validate_aspect_ratio()
    validate_selection()
    validate_length_formula()
    validate_against_vectors()
    validate_cross_implementation_constants()

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed")

    if failed:
        print("\n⚠ VALIDATION FAILED — constants may be incorrect")
        sys.exit(1)
    else:
        print("\n✓ All validations passed")
        sys.exit(0)
