#!/usr/bin/env python3
"""Generate canonical coefficient selection tables for ChromaHash (format v1).

v1 keeps v0.6's single deterministic top-K selection over the natural-decode
frequency domain, now parameterized by quality tier and by a perceptual weight:

  1. (W, H) = decodeOutputSize(aspect_byte, tier)   # long edge 32·2^level
  2. Candidates: all (cx, cy) in [0, W) × [0, H) except DC (0, 0).
     The bound makes selecting a frequency unrepresentable at the natural
     render structurally impossible.
  3. priority = (cx·H)² + (cy·W)²             # integer, bit-exact across langs
  4. key = priority · (1 + aniso·sin²2θ) · (1 + hv·cos2θ)
  5. Sort ascending by (key, cx, cy); take the first K.

Step 4 is evaluated as an EXACT INTEGER (`selection_key` below) — no float
comparison anywhere — so the order is bit-exact across languages. With the
weights zeroed the key is `priority << 16`, i.e. step 4 collapses to the bare
priority order.

p_k (the priority of the K-th selected pair) is emitted alongside each
selection; it is reserved for frequency-normalized decoder extensions and
pinned by the test vectors. It is the UNWEIGHTED priority: the synthesis window
is defined on the true spatial frequency, not on the perceptual sort key.

K per channel at the default tier (constants.py LAYOUT_T0): L = 28 (no-alpha) /
22 (alpha mode), chroma a/b = 15 (no-alpha) / 3 (alpha mode), alpha = 28.
Codes 2..=4 scale the LAYOUT_B counts by 4^level, and the larger grid keeps the
higher K satisfiable (candidates ≥ 64·4^level − 1).

Usage:
    python3 spec/selection.py           # pretty-print (default tier)
    python3 spec/selection.py --json    # JSON output (default tier)
"""

import json
import math
import sys

from constants import (
    ANISO_OBLIQUE,
    BASE_LONG_EDGE,
    DEFAULT_TIER,
    SEL_HV,
    SEL_ONE,
    SEL_Q,
    render_level,
    tier_count_scale,
    tier_layout,
)


def format_ks(tier: int) -> list[int]:
    """Every per-channel K the format uses at `tier`, ascending."""
    lay = tier_layout(tier)
    s = tier_count_scale(tier)
    return sorted(
        {
            lay.a_count * s,
            lay.c_count * s,
            lay.ca_count * s,
            (lay.la_tiers[0][0] + lay.la_tiers[1][0]) * s,
            (lay.l_tiers[0][0] + lay.l_tiers[1][0]) * s,
        }
    )


# Every per-channel K at the default tier, in ascending order. Not format_ks(0)
# -- the tier codes are ordered by quality, so 0 is the compact tier.
FORMAT_KS = format_ks(DEFAULT_TIER)


def q12(v: float) -> int:
    """Quantize a selection-weight parameter onto the Q12 grid."""
    return round(v * SEL_ONE)


def selection_key(px: int, py: int, a_q12: int, h_q12: int) -> int:
    """Exact integer sort key for one candidate frequency. Per spec §6.2 (v1).

    With s = px², t = py², p = s + t and d = s − t, the identities
    cos2θ = d/p and sin²2θ = 1 − (d/p)² turn both weight factors into
    polynomials in the single ratio d/p, which is what makes an exact integer
    form possible:

        X = trunc(d · 2^12 / p)                  in [−2^12, 2^12]   (Q12)
        U = (2^12 + A)·2^12 − ((A·X²) >> 12)     >= 2^24            (Q24)
        V = 2^24 + H·X                           > 0                (Q24)
        W = (U·V) >> 32                                             (Q16)
        key = p · W

    `>>` is an arithmetic (floor) shift and `/` truncates toward zero. Every
    intermediate stays under 2^51 at every tier for the parameter ranges the
    format allows (aniso in [0, 8], |hv| < 1), so a language with exact 53-bit
    integers — a JavaScript `number` — evaluates it without a bignum.
    """
    s, t = px * px, py * py
    p = s + t
    if a_q12 == 0 and h_q12 == 0:
        return p << 16
    d = s - t
    x = -((-d * SEL_ONE) // p) if d < 0 else (d * SEL_ONE) // p  # trunc toward 0
    u = (SEL_ONE + a_q12) * SEL_ONE - ((a_q12 * x * x) >> SEL_Q)
    v = SEL_ONE * SEL_ONE + h_q12 * x
    return p * ((u * v) >> 32)


def round_half_away_from_zero(x: float) -> int:
    """Round half away from zero (spec-mandated rounding, §2.2)."""
    if x >= 0:
        return math.floor(x + 0.5)
    return math.ceil(x - 0.5)


def base_output_size(aspect_byte: int) -> tuple[int, int]:
    """Tier-0 (W, H) from an aspect byte. Longer side = BASE_LONG_EDGE (32px),
    shorter side ≥ 1. Per spec §8.2."""
    ratio = math.pow(2.0, aspect_byte / 255.0 * 8.0 - 4.0)
    if ratio > 1.0:
        h = max(round_half_away_from_zero(BASE_LONG_EDGE / ratio), 1)
        return (BASE_LONG_EDGE, h)
    w = max(round_half_away_from_zero(BASE_LONG_EDGE * ratio), 1)
    return (w, BASE_LONG_EDGE)


def decode_output_size(aspect_byte: int, tier: int) -> tuple[int, int]:
    """Natural output size for an aspect byte at a tier code. Per spec §8.2 (v1).

    The base size is scaled by a power of two — (w << level, h << level), where
    level is render_level(tier) — so the long edge is 32·2^level
    (32 / 64 / 128 / 256 px). The shift is on the RENDER LEVEL, not the tier
    code: the compact tier is code 0 and renders at the default tier's size, so shifting by
    the code would give it a 512 px grid. Scaling the already-rounded
    base size by a bit shift (rather than re-rounding 32·2^level/ratio) is
    mandatory: the two disagree for non-power-of-two ratios (round(64/3) = 21 vs
    round(32/3) << 1 = 22), and the encoder and decoder MUST derive identical
    grids or the reconstruction desynchronizes.
    """
    w, h = base_output_size(aspect_byte)
    level = render_level(tier)
    return (w << level, h << level)


def select_coefficients(
    aspect_byte: int,
    tier: int,
    k: int,
    aniso: float = ANISO_OBLIQUE,
    hv: float = SEL_HV,
) -> tuple[list[tuple[int, int]], int]:
    """Return (selected (cx, cy) pairs in transmission order, p_k). Per §6 (v1).

    `aniso`/`hv` default to the shipped weights; pass 0.0 for both to get the
    bare priority order. `p_k` is always the unweighted priority of the
    last pair in selection order.

    The candidate count is ≥ 64·4^level − 1 for every aspect byte (the 16:1
    extreme), and every per-channel K(tier) of a fixed-width tier is < that
    bound, so its selection is always fully satisfied. A coded tier's row only
    bounds its stream (§3.6): its K may exceed the candidates at an extreme
    aspect, and the selection is then every candidate.
    """
    w, h = decode_output_size(aspect_byte, tier)
    a_q12, h_q12 = q12(aniso), q12(hv)
    entries = []
    for cy in range(h):
        for cx in range(w):
            if cx == 0 and cy == 0:
                continue
            key = selection_key(cx * h, cy * w, a_q12, h_q12)
            entries.append((key, cx, cy))
    entries.sort()
    entries = entries[:k]
    coeffs = [(cx, cy) for (_, cx, cy) in entries]
    cx, cy = coeffs[-1]
    p_k = (cx * h) ** 2 + (cy * w) ** 2
    return coeffs, p_k


def main() -> None:
    use_json = "--json" in sys.argv
    tier = DEFAULT_TIER  # the canonical table is dumped at the default tier

    # Enumerate all unique (W, H, K) selections across all 256 aspect bytes.
    seen: set[tuple[int, int, int]] = set()
    entries = []

    for byte in range(256):
        w, h = decode_output_size(byte, tier)
        for k in FORMAT_KS:
            key = (w, h, k)
            if key in seen:
                continue
            seen.add(key)
            coeffs, p_k = select_coefficients(byte, tier, k)
            assert len(coeffs) == k, f"byte={byte} k={k}: got {len(coeffs)}"
            assert all(cx < w and cy < h for cx, cy in coeffs), (
                f"byte={byte} k={k}: frequency out of bounds"
            )
            entries.append(
                {
                    "aspect_byte": byte,
                    "tier": tier,
                    "w": w,
                    "h": h,
                    "k": k,
                    "coeffs": coeffs,
                    "p_k": p_k,
                }
            )

    if use_json:
        json_entries = [
            {**e, "coeffs": [list(pair) for pair in e["coeffs"]]} for e in entries
        ]
        print(json.dumps(json_entries, indent=2))
    else:
        for k in FORMAT_KS:
            subset = [e for e in entries if e["k"] == k]
            print(f"\n=== K={k} ({len(subset)} unique (W,H) selections) ===")
            for e in subset:
                print(f"\n  W={e['w']} H={e['h']} (p_k={e['p_k']}):")
                for i, (cx, cy) in enumerate(e["coeffs"]):
                    print(f"    [{i:2d}] cx={cx}, cy={cy}")

    print(f"\nAll {len(entries)} unique selections validated.", file=sys.stderr)


if __name__ == "__main__":
    main()
