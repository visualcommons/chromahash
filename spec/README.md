# ChromaHash Format Specification

**Release:** 0.7.2
**Wire-format generation:** v1 (`version` field = 0)
**Status:** Stable
**Date:** 2026-09-01

> **What "Stable" means here.** Every constant this format ships has a measurement behind
> it on the current corpora, taken on a tune split and validated once on a never-tuned
> holdout (`EXPERIMENTS.md` §11). The wire format freezes **at the 0.7.1 release**: from
> that tag on, a change to it increments the `version` field. 0.7.1 is tagged and
> published, so v1 is live and the bitstream is frozen (§13). It does **not** mean every
> language binding has caught up — the Rust core is the reference and the bindings
> follow it.

> ChromaHash is a compact, self-describing Low Quality Image Placeholder (LQIP)
> format designed for professional photo management at scale. It encodes a
> perceptually accurate thumbnail of an image using the OKLAB color space,
> DCT-based frequency decomposition, and µ-law companded quantization. The default
> code is **32 bytes**; an optional **quality multiplier** (a 3-bit tier in the
> header) trades size for detail, roughly quadrupling the byte length per tier
> while doubling the rendered resolution on each axis.
>
> The release version (`0.7.2`, semver) and the **wire-format generation** (`v1`,
> the 3-bit `version` field, value `0`) are independent axes: the release follows
> semver, while the on-wire `version` field increments only on an incompatible
> format break (`1`→v2, `2`→v3, …). This generation is a clean break with **no
> backward compatibility** with the older v0.6 bitstream.
>
> **Design rationale:** [`RATIONALE.md`](RATIONALE.md) records why each decision
> is what it is — the alternatives considered (including the audio-codec and
> AVIF/JPEG-XL technique audits), the measured sweep evidence behind the
> constants, and the explicitly open questions.

---

## Table of Contents

1. [Design Goals](#1-design-goals)
2. [Conventions](#2-conventions)
3. [Binary Format](#3-binary-format)
4. [Color Space: OKLAB](#4-color-space-oklab)
5. [Multi-Gamut Encoding](#5-multi-gamut-encoding)
6. [DCT & Coefficient Selection](#6-dct--coefficient-selection)
7. [Quantization](#7-quantization)
8. [Aspect Ratio Encoding](#8-aspect-ratio-encoding)
9. [Alpha Channel Support](#9-alpha-channel-support)
10. [Encoding Algorithm](#10-encoding-algorithm)
11. [Decoding Algorithm](#11-decoding-algorithm)
12. [Constants & Matrices](#12-constants--matrices)
13. [Changes to v1 (0.7.1)](#13-changes-to-v1-071)
14. [Trade-offs & Limitations](#14-trade-offs--limitations)
15. [Future Directions: JPEG XL VarDCT Evaluation](#15-future-directions-jpeg-xl-vardct-evaluation)
16. [Appendix A: ThumbHash Comparison](#appendix-a-thumbhash-comparison--acknowledgment)

---

## 1. Design Goals

ChromaHash targets professional photo management workloads where perceptual quality,
layout precision, and wide-gamut support matter more than minimizing byte count.

| Goal | Rationale |
|------|-----------|
| 32 bytes at the default tier | Memory-aligned, cache-friendly, predictable storage. Zero-overhead database column or cache key; equal-budget comparison with prior LQIP formats. |
| Quality multiplier (3-bit tier) | Opt into more detail when wanted: long edge `32·2^level` and byte length growing ≈ `4^level`× from the 32-byte default, where `level = renderLevel(tier)` (§3.5). The compact tier is its own 21-byte row rather than a scaling of that. The common case stays 32 bytes. |
| Self-describing + fail-fast | Byte 0 carries version, tier, and flags; the byte length follows deterministically, so a parser validates a hash in O(1) and a validated hash always decodes. No checksum needed. |
| OKLAB color space | Perceptually uniform — quantization levels are maximally efficient. |
| 8-bit log₂ aspect ratio | ~1.09% max error for all photographic ratios. Covers 1:16 to 16:1. |
| Top-K coefficient selection | The K lowest spatial frequencies for the image's aspect ratio — a single deterministic rule, no grid machinery, no aliasing. |
| Quantization ranges sized to signal | Chroma DC spans the sRGB OKLAB hull; AC scale ranges match measured coefficient distributions. Every code level does work. |
| Per-row luminance AC precision | 4 bits (15 levels) at the default tier, where 28 coefficients beat 26 finer ones at 32 bytes, and at the compact tier, whose own 21-byte sweep landed on 4 bits again; 5 bits (31 levels) in the opaque code-2 base row that codes 2–4 scale (§7.4). |
| µ-law companding with exact zero | Non-linear quantization matching natural image DCT coefficient distributions; zero coefficients decode exactly. |
| Decode-aware DC selection | The encoder picks the DC codes whose *decoded* color is closest to the true average — gamut-corner solids round-trip nearly exactly. |
| Multi-gamut encode | Accepts sRGB, Display P3, Adobe RGB, BT.2020, or ProPhoto RGB sources. |
| Display-gamut decode | sRGB by default; decoders MAY render to Display P3 or Adobe RGB (§11). OKLAB is absolute, so no gamut flag is stored. |
| Alpha support | Transparent images supported within the same tier byte budget (32 bytes at the default tier). |

### Design Priorities (ordered)

1. **Perceptual accuracy** — placeholder should look as close to the original as possible.
2. **Layout precision** — decoded aspect ratio must closely match the original.
3. **Wide-gamut correctness** — colors from P3/Adobe RGB/BT.2020 sources preserved accurately.
4. **Decode simplicity and speed** — trivially implementable, fast (<1ms in JavaScript).
5. **Predictable size** — the byte length is deterministic from byte 0 (§3.5); no length framing to parse.

---

## 2. Conventions

### 2.1 Pseudocode Notation

- **Ranges:** `for i in 0..N` iterates from 0 to N **inclusive** (N+1 iterations).
- **Integer types:** All bit-field values are unsigned integers unless stated otherwise.

### 2.2 Rounding

All `round()` operations use **round half away from zero**:

```
round(x) = floor(x + 0.5)    for x ≥ 0
round(x) = ceil(x − 0.5)     for x < 0
```

Implementations MUST use this rounding mode. Cross-implementation bit-exactness is the
primary constraint.

### 2.3 Numerical Precision

Intermediate computations SHALL use at minimum IEEE 754 binary64 (float64) for encoding.
The decoder MAY use float32 since output is 8-bit RGBA, but SHOULD use float64 for matrix
multiplications to match reference test vectors.

The encoding pipeline requires int64/uint64 bit reinterpretation for the optimized cube
root computation (see §12.6).

### 2.4 Cube Root of Negative Values

The OKLAB transform uses cube roots. Out-of-gamut colors can produce negative LMS values.
Implementations MUST handle negative inputs:

```
cbrt(x) = sign(x) × |x|^(1/3)
```

Implementations MUST NOT use `pow(x, 1.0/3.0)`, which is undefined for negative `x` in
many languages. See §12.6 for the recommended IEEE 754 bit-seed implementation.

### 2.5 Descriptor Byte (Byte 0): Version, Tier, Flags

Byte 0 fully describes the hash. It is read directly (not as part of the little-endian
field group):

| Bits | Field | Width | Meaning |
|------|-------|-------|---------|
| 0–2 | `version` | 3 | Wire-format generation. `0` = **v1** (this spec). |
| 3–5 | `tier` | 3 | Tier code, ordered by quality. `0` is the **compact tier**, `1` is the default, `2..=4` are the higher quality tiers; `5..=7` reserved. |
| 6 | `hasAlpha` | 1 | Alpha channel present. |
| 7 | reserved | 1 | MUST be 0. |

**The tier code is a quality ordinal.** Codes are ordered smallest-first, so a larger
code is never a smaller hash. Code `0` is the **compact tier**: 21 bytes, the lowest
fidelity, rendered at the same resolution as code 1. Code `1` is the default and is
exactly 32 bytes. Codes `2..=4` each double the natural render size and roughly quadruple
the byte length.

Codes `0` and `1` share a render size, so the quantity that scales with quality is the
tier's **render level** (§3.5, §8.2), not the code itself:

```
renderLevel(tier) = max(0, tier − 1)
```

Codes `5..=7` are reserved and MUST be rejected (§2.6).

`FORMAT_VERSION = 0` is the first generation of this self-describing scheme. Future
incompatible breaks increment the field (`1`→v2, `2`→v3, …); a decoder MUST reject a
`version` it does not implement.

This is a **clean break**: there is no backward compatibility with the older v0.6
bitstream (whose byte 0 was the `L_dc` value, not a version field). The two are not
co-detectable from bytes alone, so an application storing a mix of generations must track
which is which out of band. A v1 decoder validates the descriptor + length (§2.6, §3.5)
and rejects anything that is not a well-formed v1 hash.

### 2.6 Self-Describing Length, Validation, and Padding

A v1 hash is **variable length**, fully determined by `(tier, hasAlpha)` via the length
formula in §3.5. Decodability is established by **structure, not a checksum**:
`from_bytes` (the validating constructor) checks the `version`, the `tier` range, the
reserved bit, and that the byte length exactly equals the formula — and **fails early** on
any mismatch. A byte string that passes these checks is guaranteed to decode.

There is deliberately **no CRC or checksum**. A checksum verifies *integrity*, not
*decodability*: a bit-flip that happens to land on a still-valid hash would decode to a
wrong-but-readable image, which is acceptable for a placeholder, while a flip that breaks
structure is already caught by the length/version/tier checks. The reserved flag bit is
left free for a future opt-in extension.

Trailing bits in the final byte beyond the AC payload are padding; encoders MUST set them
to 0 and decoders MUST ignore them.

### 2.7 Authoritative Constants

All constants, matrices, and scalar parameters are defined in `spec/constants.py`. That
file is the single source of truth. Run `spec/validate.py` to verify.

---

## 3. Binary Format

A ChromaHash is a variable-length byte string: a fixed prefix, a per-tier AC payload, and
trailing zero padding to the next byte boundary. At the default tier it is exactly **32 bytes** (the
v0.6 footprint, for equal-budget comparison); each higher tier roughly quadruples the
length. All field offsets, widths, and counts are named constants in `spec/constants.py`.

### 3.1 Header

**Byte 0 — descriptor** (read directly; see §2.5): `version` (bits 0–2), `tier`
(bits 3–5), `hasAlpha` (bit 6), reserved (bit 7).

**Byte 1 — `aspect`**: the 8-bit log₂ aspect ratio (see §8).

**Bits 16–53 — DC + scale prefix**, packed little-endian via `writeBits` in this order:

| Bit offset | Field | Width | Range | Description |
|------------|-------|-------|-------|-------------|
| 16–22 | `L_dc`    | 7 | 0–127 | OKLAB L (lightness) |
| 23–29 | `a_dc`    | 7 | 1–127 | OKLAB a (green–red), centered |
| 30–36 | `b_dc`    | 7 | 1–127 | OKLAB b (blue–yellow), centered |
| 37–42 | `L_scale` | 6 | 0–63  | Luminance AC max amplitude |
| 43–48 | `a_scale` | 6 | 0–63  | Chroma-a AC max amplitude |
| 49–53 | `b_scale` | 5 | 0–31  | Chroma-b AC max amplitude |

The fixed prefix is **54 bits** (bytes 0–1 plus the 38-bit DC/scale group). In alpha mode
an additional `alpha_dc` (5 bits) + `alpha_scale` (4 bits) = 9 bits immediately follow the
prefix, before the AC payload.

### 3.2 AC Payload

AC coefficients follow the prefix (and the alpha DC/scale in alpha mode), in **selection
order** (§6.2): the j-th value in each channel's field is the j-th selected `(cx, cy)`
pair.

The per-channel split is a **three-row table, not one base scaled by `4^(tier−2)`**: codes
0 and 1 each have their own row, and codes 2–4 scale the code-2 base by `4^(tier−2)`. Bits
per coefficient are constant within a row. The split exists because the count-vs-precision
optimum moves with the budget — at 32 bytes the format is measurably better off with more,
coarser coefficients than the code-2 row scaled down would give it (`EXPERIMENTS.md` §4.2,
§8.1), and the compact tier's smaller budget moves it again (§11.10).

**Compact tier (code 0, 21 bytes):**

```
                no-alpha                     alpha
Field           Coeff  Bits  Total    Field         Coeff  Bits  Total
──────────────────────────────────    ─────────────────────────────────
L AC            19     4     76       alpha_dc      1      5       5
a AC (chroma)   6      3     18       alpha_scale   1      4       4
b AC (chroma)   6      3     18       L AC          12     4      48
                            ────      a AC          1      3       3
                            112       b AC          1      3       3
                                      A AC (alpha)  16     3      48
                                                           ────────
                                                                 111
```

54 + 112 = **166 bits → 21 bytes**; 54 + 111 = **165 bits → 21 bytes**. ✓

**Default tier (code 1, 32 bytes):**

```
                no-alpha                     alpha
Field           Coeff  Bits  Total    Field         Coeff  Bits  Total
──────────────────────────────────    ─────────────────────────────────
L AC            28     4     112      alpha_dc      1      5       5
a AC (chroma)   15     3     45       alpha_scale   1      4       4
b AC (chroma)   15     3     45       L AC          22     4      88
                            ────      a AC          3      3       9
                            202       b AC          3      3       9
                                      A AC (alpha)  28     3      84
                                                           ────────
                                                                 199
```

54 + 202 = **256 bits = 32 bytes**; 54 + 199 = **253 bits → 32 bytes** (3 padding bits). ✓

**Code-2 base (the row codes 2–4 scale):**

```
Field           no-alpha          alpha
──────────────────────────────────────────
L AC            104 @ 5           88 @ 4
a AC (chroma)   36 @ 4            12 @ 3
b AC (chroma)   36 @ 4            12 @ 3
A AC (alpha)    —                 112 @ 3
```

At tier `m ≥ 2`, every coefficient count in that row is multiplied by `4^(m−2)`; see §3.5.

**On the alpha rows.** They are not the opaque rows with luma trimmed. The alpha channel
carries a silhouette, which is high-frequency and is most of what a cut-out placeholder
communicates; chroma spent inside transparent regions is composited away and buys nothing.
So the alpha rows spend far more on the alpha plane and far less on chroma than the opaque
rows do — 28 alpha coefficients against 3 chroma at code 1. This is measured, not derived:
`EXPERIMENTS.md` §11.3 and §11.11.

The alpha AC **count and bit width are per row**, like every other count in this table.
They must not be hoisted into a single constant: code 1 wants 28 coefficients where the
compact tier's smaller budget wants 16. An implementation MUST also keep the alpha count
non-decreasing as the tier rises — 16 / 28 / 112 / 448 / 1792 for codes 0 / 1 / 2 / 3 / 4
— since a higher tier with fewer alpha coefficients is a higher quality tier that renders
a worse silhouette.

### 3.3 Layout Diagram

```
Default tier (code 1), no-alpha (32 bytes):
┌────────┬────────┬────────────────────────────────┬───────────────────────────────────────┐
│ byte 0 │ byte 1 │   DC + scale prefix (38 bits)  │            AC payload + pad            │
│ descr  │ aspect │ L_dc|a_dc|b_dc|L_scl|a_scl|b_scl│ L_ac×28(4b) | a_ac×15(3b)| b_ac×15(3b)│
└────────┴────────┴────────────────────────────────┴───────────────────────────────────────┘

Default tier (code 1), alpha (32 bytes):
┌────────┬────────┬────────────────────────────────┬──────────────────────────────────────────────────────┐
│ descr  │ aspect │ L_dc|a_dc|b_dc|L_scl|a_scl|b_scl│ A_dc(5b)|A_scl(4b)|L_ac×22(4b)|a_ac×3|b_ac×3|A_ac×28(3b)│
└────────┴────────┴────────────────────────────────┴──────────────────────────────────────────────────────┘

Compact tier (code 0), no-alpha (21 bytes):
┌────────┬────────┬────────────────────────────────┬──────────────────────────────────────┐
│ descr  │ aspect │ L_dc|a_dc|b_dc|L_scl|a_scl|b_scl│ L_ac×19(4b) | a_ac×6(3b) | b_ac×6(3b)│
└────────┴────────┴────────────────────────────────┴──────────────────────────────────────┘

Higher tiers use identical framing and the code-2 row (no-alpha L 104 @ 5b, a/b 36 @ 4b;
alpha L 88 @ 4b, a/b 12 @ 3b, A 112 @ 3b), with every AC coefficient count multiplied by
4^(tier−2). The compact tier is NOT part of that scaling — it is its own row at the
default tier's render size.
```

### 3.5 Quality Multiplier (Tier) & Length Formula

The 3-bit `tier` (byte 0, bits 3–5) selects a row of the §3.2 layout table and a render
size. Both derive from the tier's **render level**, not from the code itself:

```
renderLevel(tier) = max(0, tier − 1)
countScale(tier)  = 4^renderLevel(tier)
```

- **Render grid** — the natural decode size is `decodeOutputSize(aspect, tier)` =
  `decodeOutputSize(aspect, 1)` with each axis shifted left by `renderLevel(tier)` (long
  edge `32·2^level`: 32 / 64 / 128 / 256 px). This MUST be a bit-shift of the rounded
  base size, not a re-rounding of `32·2^level / ratio` (the two diverge — see §8.2).
- **Coefficient budget** — codes 0 and 1 each read their own row of §3.2 directly; tier
  `m ≥ 2` reads the code-2 row with each per-channel count multiplied by `4^(m−2)`. The
  candidate frequency pool grows with the grid, so every `K(tier)` remains satisfiable.

Valid tier codes are `0..=4` (`MAX_TIER = 4`); `5..=7` are reserved and MUST be rejected.
Codes 0 and 1 share a render level, so shifting by the raw code rather than by
`renderLevel` over-renders every code from 1 up. The **default tier** is where it bites
first and hardest: a 64 px grid and 4× the coefficients for what must be a 32-byte,
32 px hash. The compact tier is the one code the mistake leaves alone — `renderLevel(0)`
and the raw code are both 0 — so a `valid_compact` vector passes under the bug; it is the
code-1 vectors, whose length check fails, that catch it.

**Length formula** — the total byte length is determined entirely by `(tier, hasAlpha)`:

```
ac_bits   = K_L(tier)·B_L(tier) + 2·K_c(tier)·B_c(tier)
          + K_alpha(tier)·B_alpha(tier)
body_bits = 54 + (9 if hasAlpha else 0) + ac_bits     # alpha terms 0 when opaque
length    = ceil(body_bits / 8)    bytes
```

where `K_*`/`B_*` come from the §3.2 row for that tier: codes 0 and 1 read their own rows
directly, and tier `m ≥ 2` reads the code-2 row with every count times `4^(m−2)`. Note
`B_alpha` is read from the row like every other width — it is 3 bits in v0.7, not the 4 it
was before §11.3.

| tier code | no-alpha | alpha |
|---|---|---|
| 0 (compact) | 21 B | 21 B |
| 1 (default) | 32 B | 32 B |
| 2 | 108 B | 103 B |
| 3 | 411 B | 388 B |
| 4 | 1623 B | 1528 B |

A decoder recomputes `length` from the descriptor and MUST reject a hash whose byte
length differs (§2.6).

### 3.4 String Representation

ChromaHash is a binary format. This specification does not define a canonical UTF-8 string
encoding; the reference implementation does not provide one. Applications are responsible
for choosing an encoding appropriate to their context (e.g. base64url per RFC 4648 §5 for
web and API use, hex for debugging). Because the byte length is self-describing (§3.5), any
consistently applied encoding is unambiguous without additional framing.

---

## 4. Color Space: OKLAB

### 4.1 Choice Justification

| Candidate | Verdict |
|-----------|---------|
| **LPQA** (ThumbHash) | Not perceptually uniform. Gamma-encoded sRGB averaging. |
| **CIELAB** (CIE 1976) | Hue linearity problems — blue shifts toward purple. Requires D50 adaptation. |
| **YCbCr** (BT.601/709) | Not perceptually uniform. Designed for signal compression. |
| **ICtCp** (BT.2100) | Overkill for SDR placeholders. Requires PQ/HLG transfer functions. |
| **OKLCH** (cylindrical) | Hue angle discontinuity at 0°/360° breaks DCT encoding. |
| **OKLAB** | **Selected.** Perceptually uniform, hue-linear, D65 native, simple transform, industry-adopted (CSS Color Level 4). |

Key properties: equal L steps = equal perceived lightness changes; no hue shift during
interpolation (unlike CIELAB); D65 white point matches all target gamuts natively;
gamut-agnostic via CIE XYZ; simple transform (two 3×3 matrices + cube root).

### 4.2 OKLAB Transform

**Forward (RGB → OKLAB):**

```
1. Linearize RGB using the source gamut's transfer function
2. Linear RGB → LMS:   lms = M1[source_gamut] × rgb_linear
3. Cube root:          lms_cbrt = [cbrt(l), cbrt(m), cbrt(s)]
4. LMS → OKLAB:        [L, a, b] = M2 × lms_cbrt
```

**Inverse (OKLAB → sRGB):**

```
1. OKLAB → LMS_cbrt:   lms_cbrt = M2_inv × [L, a, b]
2. Cube:               lms = [l³, m³, s³]
3. LMS → sRGB linear:  rgb_linear = M1_inv[sRGB] × lms
4. Apply sRGB gamma:   rgb = srgb_gamma(clamp(rgb_linear, 0, 1))
```

Matrices are defined in §12.

---

## 5. Multi-Gamut Encoding

### 5.1 Encoding Pipeline

```
Source RGB → Linearize (source EOTF) → LMS (M1[source_gamut]) → OKLAB (M2)
```

The resulting OKLAB values are **absolute** — the same physical color produces the same
(L, a, b) regardless of source gamut. No gamut flag is stored. The decoder renders the
absolute OKLAB to a caller-chosen **output gamut** (§11), so the same hash can be shown
correctly on an sRGB, Display P3, or Adobe RGB display.

> **Note:** DC chroma quantization ranges are sized to the OKLAB hull of the
> display-output gamuts — the union of sRGB, Display P3 and Adobe RGB (§7.1) — so colors
> within any of those gamuts are stored faithfully and render at full saturation on a
> matching display. Source colors more saturated than that union (e.g. some BT.2020 /
> ProPhoto inputs) clip at encode; no real display can show them anyway. The decode-aware
> DC selection (§10.3) keeps the stored DC within ±1 code of the true average. AC
> coefficients are differences around the DC and are unaffected.

### 5.2 Decoding Pipeline

```
OKLAB → LMS_cbrt (M2_inv) → LMS (cube) → linear RGB (M1_inv[output gamut]) → clamp → gamma → 8-bit RGBA
```

The default decode target is sRGB. Decoders MAY render to Display P3 or Adobe RGB on
request (§11); requests for BT.2020 or ProPhoto output fall back to sRGB, and
`averageColor` (§11.2) is always sRGB.

### 5.3 Transfer Functions

| Gamut | Transfer function (gamma → linear) |
|-------|-------------------------------------|
| sRGB / Display P3 | `x ≤ 0.04045 ? x/12.92 : ((x+0.055)/1.055)^2.4` |
| Adobe RGB | `x^2.2` |
| ProPhoto RGB | `x^1.8` |
| BT.2020 PQ (ST 2084) | Inverse PQ EOTF (tone-map to SDR first) |

> **Note:** BT.2020 in this spec means BT.2020 with PQ transfer (ST 2084). SDR BT.2020
> content (e.g. BT.709-like OETF with BT.2020 primaries) SHOULD be encoded using the
> sRGB transfer function with the BT.2020 M1 matrix.

> **Note:** The ProPhoto RGB entry uses the simplified `x^1.8` power function. The full
> ROMM RGB standard specifies a piecewise function with a linear toe below ~0.001808; for
> typical photographic values this difference is negligible.

The decoder always applies the **sRGB inverse EOTF** (linear → gamma):

```
gamma(x) = x ≤ 0.0031308 ? 12.92 × x : 1.055 × x^(1/2.4) − 0.055
```

For HDR PQ content, the encoder MUST tone-map to SDR before OKLAB conversion,
using the canonical Reinhard operator below. An implementation-defined tone map
would contradict the byte-identical cross-implementation requirement (§2.3) —
two conforming encoders MUST produce the same hash for the same PQ input.

```
pqToSdr(x):                       // x = PQ-encoded channel value in [0, 1]
    m1 = 0.1593017578125          // ST 2084 constants
    m2 = 78.84375
    c1 = 0.8359375
    c2 = 18.8515625
    c3 = 18.6875
    n = x^(1/m2)
    yLinear = (max(n − c1, 0) / (c2 − c3·n))^(1/m1)
    yNits = yLinear × 10000       // PQ codes absolute luminance up to 10000 cd/m²
    l = yNits / 203               // SDR reference white = 203 cd/m² (BT.2408)
    return l / (1 + l)            // Reinhard: compresses highlights, preserves midtones
```

Reinhard at a 203-nit reference white is deliberately simple: a placeholder needs
a stable, deterministic SDR appearance, not a display-adaptive HDR rendering.
Fancier operators (BT.2390 EETF, ACES) produce different bytes per parameterization
and would need their parameters pinned in the spec for no perceptual benefit at
placeholder fidelity.

---

## 6. DCT & Coefficient Selection

### 6.1 Transform

**Forward transform** over the source image (`w × h` pixels) for a selected frequency
pair `(cx, cy)`:

```
F(cx, cy) = (1 / (w × h)) × Σ_y Σ_x  channel[x + y×w] × cos(π/w × cx × (x + 0.5))
                                                         × cos(π/h × cy × (y + 0.5))
```

DC is `F(0, 0)` = the channel mean.

**Inverse transform** (decode, at render dimensions `w × h`):

```
value = DC + Σ_j  AC[j] × cos(π/w × cx_j × (x + 0.5)) × cos(π/h × cy_j × (y + 0.5)) × C(cx_j, cy_j)
```

Normalization factor: `C(cx, cy) = (cx > 0 ? 2 : 1) × (cy > 0 ? 2 : 1)`

### 6.2 Top-K Coefficient Selection

Which K frequency pairs each channel transmits is derived deterministically from the
aspect byte — no grid machinery, no mode flags:

```
ANISO = 1.2      // oblique-effect weight   (§12.1)
HV    = 0.15     // horizontal/vertical weight

// level = renderLevel(tier) = max(0, tier − 1)  (§3.5) — NOT the raw tier code
function selectCoefficients(aspect_byte, tier, K):
    (W, H) = decodeOutputSize(aspect_byte, tier)   // §8.2; long side 32·2^level, short side ≥ 2·2^level
    entries = []
    for cy in 0 .. H−1:
        for cx in 0 .. W−1:
            if cx == 0 and cy == 0: continue       // DC is stored separately
            key = selectionKey(cx × H, cy × W, ANISO, HV)   // integer, below
            entries.append((key, cx, cy))
    sort entries ascending by (key, cx, cy)        // lex tiebreak for determinism
    truncate entries to first K
    (cx, cy) = last (K-th) entry
    p_k = (cx × H)² + (cy × W)²                    // the UNWEIGHTED priority
    return ([(cx, cy) for (_, cx, cy) in entries], p_k)
```

**Selection key.** The transmission order is the candidate frequencies sorted by

```
priority = (cx × H)² + (cy × W)²                              // integer
key      = priority × (1 + ANISO × sin²2θ) × (1 + HV × cos2θ)
```

where θ is the frequency's angle: `sin²2θ = 0` on the axes and `1` on the diagonal, and
`cos2θ = +1` for a purely horizontal frequency and `−1` for a purely vertical one. Human
contrast sensitivity is lower for diagonal detail (the *oblique effect*), so `ANISO > 0`
spends the budget on axis-aligned structure first; `HV > 0` then prefers vertical detail
to horizontal. Both are corpus-measured, not assumed — see `EXPERIMENTS.md` §7.4, §8.1.

The key MUST be evaluated as an **exact integer**. Writing `s = (cx·H)²`, `t = (cy·W)²`,
`p = s + t` and `d = s − t`, the identities `cos2θ = d/p` and `sin²2θ = 1 − (d/p)²`
collapse both factors into polynomials in the single ratio `d/p`:

```
function selectionKey(px, py, aniso, hv):
    s = px²;  t = py²;  p = s + t;  d = s − t
    A = round(aniso × 4096);  H = round(hv × 4096)          // Q12
    if A == 0 and H == 0: return p << 16                    // the bare priority order
    X = trunc(d × 4096 / p)                 // Q12,  −4096 ≤ X ≤ 4096, toward zero
    U = (4096 + A) × 4096 − ((A × X × X) >> 12)             // Q24, ≥ 2²⁴
    V = 4096 × 4096 + H × X                                 // Q24, > 0
    return p × ((U × V) >> 32)                              // Q16 weight × priority
```

`>>` is an arithmetic (floor) shift; `/` truncates toward zero. Every intermediate stays
below `2⁵¹` at every tier for the ranges the format allows (`aniso ∈ [0, 8]`, `|hv| < 1`),
so an implementation with exact 53-bit integers — a JavaScript `number` — evaluates this
without a bignum, and the order is **bit-exact across languages**. With both weights zero
the key is `priority << 16`, so the unweighted order is the same code path.

`p_k` is always the **unweighted** priority: the synthesis window and any
frequency-normalized extension are defined on the true spatial frequency, not on the
perceptual sort key.

**Candidate domain.** Candidates are exactly the frequencies representable at the
natural decode raster `[0, W) × [0, H)`. `cos(π/W × cx × (x+0.5))` with `cx = W`
evaluates to zero at every sample, and `cx > W` aliases to a lower frequency — the
bound makes selecting an unrepresentable frequency structurally impossible. The
candidate count is at least `64·4^level − 1` for every aspect byte (short side ≥ 2·2^level),
so every `K(tier)` the format uses is always fully satisfied.

**Tier scaling.** Doubling the grid scales `(W, H)`, and hence every priority, by `4^level`
uniformly. The weight depends only on the *ratio* `d/p`, which is unchanged, so the whole
key scales by `4^level` and the *ordering* is tier-independent: a higher tier reuses the
same low-frequency ordering on a larger grid, which admits more (and higher) frequencies
and lets `K` grow as `4^level` (§3.5).

**Priority.** `(cx·H)² + (cy·W)²` is the squared isotropic per-pixel spatial frequency
scaled by `(W·H)²`: sorting ascending takes the K lowest spatial frequencies — an ℓ2
ball in frequency space, the ideal low-pass set for the radially decaying spectra of
natural images. Properties:

- **Square** (W = H = 32): priority ∝ `cx² + cy²` — radial order. Unweighted first slots:
  `(0,1), (1,0)` (tied; lex tiebreak), then `(1,1)`, `(0,2)`, `(2,0)`, … At K = 27 the
  ball includes diagonals like `(3,4)/(4,3)` and excludes axis extremes like
  `(6,0)/(0,6)` — the opposite of v0.4's ℓ1 triangle, and the reason v0.6 does not
  produce v0.4's sparse high-frequency striping. The weights then reorder *within* that
  ball: `(1,1)` (priority 2048, key 4506) falls behind `(0,2)` (priority 4096, key 3482)
  and ahead of `(2,0)` (key 4710).
- **Extreme landscape** (byte 255: W = 32, H = 2): one `cy` step costs `(1×32)² = 1024`
  while one `cx` step costs `(1×2)² = 4` — the selection fills the long axis first, and
  no `cy ≥ 2` frequency can ever be selected.
- All arithmetic is integer; the sort is total via the `(key, cx, cy)` tiebreak.
  Bit-exact across languages by construction.
- **Mirror asymmetry.** Under the unweighted order, byte `b` and byte `255−b` have
  mirrored `(W, H)` and identical priority multisets (when K cuts an equal-priority tie
  group the lex tiebreak may pick non-mirrored members — benign, and pinned by the test
  vectors). `HV ≠ 0` breaks that symmetry **on purpose**: `cos2θ` changes sign under the
  transpose, so a landscape image and its portrait mirror do not select mirrored sets.

`p_k` (the unweighted priority of the K-th selected pair) is deterministic from the
selection and is reserved for frequency-normalized decoder extensions; it is pinned by
the test vectors.

**K per channel** (per §3.2: the code-1 row, then the code-2 row scaled ×`4^(tier−2)`):

| Channel | Mode | K (code 1) | Bits | K (code 2) | Bits |
|---|---|---|---|---|---|
| L luminance | no-alpha | 28 | 4 each | 104 | 5 each |
| L luminance | alpha | 22 | 4 each | 88 | 4 each |
| a chroma | no-alpha | 15 | 3 each | 36 | 4 each |
| a chroma | alpha | 3 | 3 each | 12 | 3 each |
| b chroma | no-alpha | 15 | 3 each | 36 | 4 each |
| b chroma | alpha | 3 | 3 each | 12 | 3 each |
| Alpha | alpha | 28 | 3 each | 112 | 3 each |

Run `python3 spec/selection.py --json` for all unique selections (one per `(W, H, K)`).

### 6.3 Encoder Frequency Clamp (Source Dimensions)

A selected pair `(cx, cy)` with `cx ≥ src_w` or `cy ≥ src_h` cannot be represented by
the source samples: the DCT basis is not orthogonal there and the projection
degenerates (e.g. `F(2, cy)` on a 1-pixel-wide image equals `−F(0, cy)` — a copy of
the DC masquerading as detail). Encoders MUST emit such coefficients as **exact zero**
and MUST exclude them from the scale computation (§7.2).

This is the guard for degenerate inputs (1×N strips, 1×1 images): without it, the junk
coefficient inflates the channel scale, crushes the real coefficients' precision, and
renders catastrophically at capped decode sizes.

### 6.4 Decoder Frequency Filter (Render Dimensions)

When rendering at dimensions `(w, h)` — natural or capped (§11.3) — decoders MUST skip
any coefficient with `cx ≥ w` or `cy ≥ h`. The remaining sum is the band-limited
reconstruction at the coarser raster: a 1×N render of a portrait hash is the exact
column profile rather than an aliased pattern.

At the natural render size the filter never excludes anything (the selection domain is
the natural raster); it only takes effect for sub-natural renders.

---

## 7. Quantization

### 7.1 DC Quantization

| Channel | Bits | Encode | Decode |
|---------|------|--------|--------|
| L | 7 | `round(127 × clamp(L_dc, 0, 1))` | `raw / 127.0` |
| a | 7 | `round(64 + 63 × clamp(a_dc/MAX_CHROMA_A, -1, 1))` | `(raw - 64) / 63.0 × MAX_CHROMA_A` |
| b | 7 | `round(64 + 63 × clamp(b_dc/MAX_CHROMA_B, -1, 1))` | `(raw - 64) / 63.0 × MAX_CHROMA_B` |
| Alpha | 5 | `round(31 × clamp(A_dc, 0, 1))` | `raw / 31.0` |

The nominal codes above are the starting point for the decode-aware DC search (§10.3),
which may shift each of L/a/b by ±1 code.

`MAX_CHROMA_A = 0.35` and `MAX_CHROMA_B = 0.33` cover the OKLAB hull of the union of the
display-output gamuts — sRGB ∪ Display P3 ∪ Adobe RGB (max |a| ≈ 0.347, max |b| ≈ 0.321).
This stores colors within any output gamut faithfully so they render at full saturation
on a matching display (§11). The range stops there — wider sources (BT.2020/ProPhoto)
clip, since no supported display can show beyond this hull.

> **Note:** The a/b DC encode formula `round(64 + 63×x)` produces indices in [1, 127],
> never 0. Conforming encoders MUST NOT produce raw=0 for a/b DC (the DC search clamps
> its candidates to [1, 127]). Decoders encountering raw=0 will reconstruct a slightly
> out-of-range chroma value; this is handled by the downstream per-channel gamut clip.

### 7.2 Scale Factor Quantization

| Channel | Bits | Nominal encode | Decode |
|---------|------|----------------|--------|
| L scale | 6 | `round(63 × clamp(L_scale/MAX_L_SCALE, 0, 1))` | `raw / 63.0 × MAX_L_SCALE` |
| a scale | 6 | `round(63 × clamp(a_scale/MAX_A_SCALE, 0, 1))` | `raw / 63.0 × MAX_A_SCALE` |
| b scale | 5 | `round(31 × clamp(b_scale/MAX_B_SCALE, 0, 1))` | `raw / 31.0 × MAX_B_SCALE` |
| Alpha scale | 4 | `round(15 × clamp(A_scale/MAX_A_ALPHA_SCALE, 0, 1))` | `raw / 15.0 × MAX_A_ALPHA_SCALE` |

`X_scale` above is the maximum |AC| over the channel's **non-clamped** coefficients
(§6.3), and the nominal column is the code that value rounds to.

**Scale selection is a search, not that rounding.** The decoder dequantizes with the
*rounded* code, so normalizing the coefficients by the unrounded maximum encodes against
a scale the decoder never uses; and rounding the maximum is not the code that minimizes
the channel's error, because clipping one outlier can buy back resolution for every other
coefficient. Encoders MUST therefore choose the scale code as:

```
if X_scale == 0:  scale_code = 0                       // silent channel; all AC = zero code
else:
    scale_code = argmin over code in 1 ..= (2^bits − 1) of
                     Σ_j ( dequantAC(quantAC(AC_j, dequantScale(code)), dequantScale(code))
                           − AC_j )²
                 // ties resolved by the lowest code; quantAC/dequantAC per §7.3
```

and MUST then normalize every coefficient by `dequantScale(scale_code)` — the exact
value the decoder will use — not by `X_scale`. This costs no bits, changes no decoder,
and is worth −0.43% mean ΔE00 at 32 bytes and −1.8% at 411 (`EXPERIMENTS.md` §7.11).

`MAX_A_SCALE = MAX_B_SCALE = 0.125`: across the reference corpus the chroma AC scale
never exceeds 0.113. v0.5's 0.5 range wasted two bits of every chroma coefficient and
was the dominant cause of chroma banding and visible desaturation. `MAX_L_SCALE = 0.5`
is retained — luminance scales genuinely span the full range on synthetic content.

### 7.3 AC Coefficient Quantization: µ-law Companding

All AC coefficients use **µ-law companding** with a per-channel-group µ:

| Channel group | µ |
|---|---|
| L AC | `MU_L` = 5 |
| a/b AC | `MU_C` = 8 |
| Alpha AC | `MU_ALPHA` = 5 |

Chroma uses a higher µ because its tight scale range (§7.2) concentrates most
coefficients very near zero.

**Compress:** `compressed = sign(v) × log(1 + µ × |v|) / log(1 + µ)`

**Quantize (odd level count):**

```
max_idx  = 2^bits − 2
nominal  = clamp(round((compressed + 1) / 2 × max_idx), 0, max_idx)
```

**Nearest-reconstruction refinement.** µ-law levels are unevenly spaced, so the level
nearest in the *compressed* domain is not always the one that reconstructs closest to the
coefficient. Encoders MUST score the ±2 neighbourhood of `nominal` by reconstruction
error and take the best:

```
index = argmin over d in [0, −1, +1, −2, +2] of
            | dequantize(clamp(nominal + d, 0, max_idx)) × scale − v |
        // strictly-better wins, so d = 0 (the nominal code) holds every tie
```

This costs no bits and leaves the decoder untouched. The `[0, −1, +1, −2, +2]` order and
the strict-improvement rule are normative: they are what makes the tie-breaking — and
hence the emitted bytes — identical across implementations.

**Dequantize:**

```
index      = min(index, 2^bits − 2)        // top code is never written; clamp down
compressed = index / (2^bits − 2) × 2 − 1
```

**Expand:** `v = sign(compressed) × ((1 + µ)^|compressed| − 1) / µ`

The quantizer uses `2^bits − 1` levels (indices `0 ..= 2^bits − 2`) so the center index
(`2^(bits−1) − 1`) represents **exactly 0.0**. This removes the earlier systematic zero bias
(+0.012·scale at 5 bits): solid colors, frequency-clamped slots (§6.3), and genuinely
zero coefficients decode exactly. The top code `2^bits − 1` is never produced by
encoders; decoders MUST clamp it down to `2^bits − 2` for robustness.

When a channel's scale is 0 (solid color), encoders write the center (zero) code for
every coefficient.

### 7.4 AC Bit Depths

Bit depths are constant within a §3.2 row; the tier multiplies the coefficient *count*
(§3.5), not the precision. Codes 0 and 1 have their own rows, so their bit depths differ
from the code-2 row that codes 2–4 scale.

| Channel | Compact, no-α | Compact, α | Code 1, no-α | Code 1, α | Code-2 base, no-α | Code-2 base, α |
|---------|---------------|------------|--------------|-----------|-------------------|----------------|
| L AC | 4 b (all 19) | 4 b (all 12) | 4 b (all 28) | 4 b (all 22) | 5 b (all 104) | 4 b (all 88) |
| a AC | 3 b (all 6) | 3 b (all 1) | 3 b (all 15) | 3 b (all 3) | 4 b (all 36) | 3 b (all 12) |
| b AC | 3 b (all 6) | 3 b (all 1) | 3 b (all 15) | 3 b (all 3) | 4 b (all 36) | 3 b (all 12) |
| Alpha AC | — | 3 b (all 16) | — | 3 b (all 28) | — | 3 b (all 112) |

Code 1 trades precision for count because at 32 bytes that is measurably the better
buy — 28 luma coefficients at 4 bits beat 26 at 5 by 3.5% mean ΔE00 on the never-tuned
holdout split, with every guard metric improving (`EXPERIMENTS.md` §4.2, §8.3). By code 2
the budget is loose enough that the 5-bit split wins again for the opaque row.

The alpha rows do not follow the opaque ones. Alpha AC is 3 bits at every tier — 2 bits
fails the Butteraugli guard at any count — and it takes the largest share of the alpha
budget, because a silhouette is high-frequency and is most of what a cut-out placeholder
communicates. Chroma correspondingly collapses to 3 coefficients at code 1: chroma spent
inside a transparent region is composited away. `EXPERIMENTS.md` §11.3.

The `AcLayout` supports a two-tier L precision split (a low-frequency band at higher bit
depth) as a tuning knob, but every shipped row uses a single L tier.

---

## 8. Aspect Ratio Encoding

### 8.1 Encoding Formula

```
Encode: byte = clamp(round((log₂(w / h) + 4) / 8 × 255), 0, 255)
Decode: ratio = 2^(byte / 255 × 8 − 4)
```

This maps log₂(ratio) from [−4, +4] to [0, 255], covering ratios from **1:16** (0.0625)
to **16:1** (16.0). The encoding is symmetric about 1:1 — portrait and landscape ratios
of the same proportions have the same error.

Maximum error: `2^(8/255/2) − 1 ≈ 1.09%`. Notable values: 1:1 → byte 128, 4:1 → 191,
16:1 → 255, 1:4 → 64, 1:16 → 0.

### 8.2 Decode Output Size

The base render size has its longer side at `BASE_LONG_EDGE = 32` pixels by convention:

```
baseOutputSize(byte):
    if ratio > 1:
        w = 32; h = max(round(32 / ratio), 1)
    else:
        w = max(round(32 × ratio), 1); h = 32

decodeOutputSize(byte, tier):
    (w, h)  = baseOutputSize(byte)
    level   = renderLevel(tier)          // max(0, tier − 1)
    return (w << level, h << level)      // long edge 32·2^level
```

Shifting by `renderLevel(tier)` rather than by `tier` is what keeps the default tier at
the base 32 px size, which the compact tier shares (§3.5). Shifting by the raw code would
render the default tier at 64 px; the compact tier, at code 0, is unaffected either way.

Over the byte range the base short side is at least 2 pixels (byte 0 → 2×32;
byte 255 → 32×2), which the selection domain (§6.2) relies on; at render level `m` it is
`2·2^m`. The tier scaling is a **bit shift of the rounded base size** — it MUST NOT be
re-derived as `round(32·2^level / ratio)`, which disagrees for non-power-of-two ratios
(e.g. ratio 3, level 1: `round(64/3) = 21` vs `round(32/3) << 1 = 22`) and would
desynchronize the encoder and decoder grids. Implementations MAY render at other sizes;
see §6.4 and §11.3.

---

## 9. Alpha Channel Support

### 9.1 Detection

An image has alpha if any pixel's alpha value < 255. The `hasAlpha` flag records this.

### 9.2 Alpha Compositing Before Encoding

Before encoding, transparent pixels are composited over the alpha-weighted average color
in OKLAB space:

```
1. Compute alpha-weighted average OKLAB (avg_L, avg_a, avg_b)
2. For each pixel:
     L_chan[i] = avg_L × (1 − alpha) + alpha × oklab[i].L
     a_chan[i] = avg_a × (1 − alpha) + alpha × oklab[i].a
     b_chan[i] = avg_b × (1 − alpha) + alpha × oklab[i].b
```

This ensures L, a, b channels represent opaque color values while alpha is encoded
separately.

### 9.3 Alpha Channel Encoding

When `hasAlpha = 1`: DC (5 bits), scale (4 bits), and the tier row's alpha AC coefficients
(3 bits each, µ-law companded with `MU_ALPHA`). The count is the row's own — 16 at the
compact tier, 28 at the default tier and in the code-2 base — scaled by `4^level` above
code 2, giving **16 / 28 / 112 / 448 / 1792** for codes 0–4 (§3.2). It is not one constant
scaled by `4^level`: the compact tier reads its own row, so the sequence starts at 16
rather than at a scaled 28.

At the default tier that is 93 bits of alpha (`5 + 4 + 28·3`), funded almost entirely out
of **chroma** rather than luminance: a/b shrink from 15 coefficients each to 3 (−72 bits)
and L from 28 to 22 (−24 bits). Chroma spent inside transparent regions composites away,
while the alpha plane carries the silhouette — see §3.2 "On the alpha rows" and
`EXPERIMENTS.md` §11.3. The 3 bits left over are the alpha row's padding, keeping the
default-tier hash at 32 bytes.

---

## 10. Encoding Algorithm

### 10.1 Input Requirements

- Image dimensions: any size (full-resolution encoding — no downscale required)
- Pixel format: RGBA, 8 bits per channel
- Source gamut: one of {sRGB, Display P3, Adobe RGB, BT.2020, ProPhoto RGB}

### 10.2 Pseudocode

```
function encode(W, H, rgba, gamut, tier) -> byte[]:   // tier in 0..=MAX_TIER (4)
    // 1. Precompute EOTF lookup table (256 entries per 8-bit input value)
    lut = precompute_eotf_lut(gamut)

    // 2. Convert all pixels to OKLAB
    oklab = array[W*H*3]; alphas = array[W*H]
    avg_L = 0; avg_a = 0; avg_b = 0; avg_alpha = 0

    for i in 0 .. W*H-1:
        alpha = rgba[i*4+3] / 255.0
        r_lin = lut[rgba[i*4+0]]
        g_lin = lut[rgba[i*4+1]]
        b_lin = lut[rgba[i*4+2]]
        lms = M1[gamut] × [r_lin, g_lin, b_lin]
        lms_cbrt = [cbrt(lms[0]), cbrt(lms[1]), cbrt(lms[2])]
        lab = M2 × lms_cbrt
        avg_L += alpha*lab[0]; avg_a += alpha*lab[1]; avg_b += alpha*lab[2]
        avg_alpha += alpha
        oklab[i*3..] = lab; alphas[i] = alpha

    // 3. Alpha-weighted average
    if avg_alpha > 0:
        avg_L /= avg_alpha; avg_a /= avg_alpha; avg_b /= avg_alpha
    else:
        avg_L = 0; avg_a = 0; avg_b = 0

    // 4. Composite transparent pixels over average
    hasAlpha = avg_alpha < W * H
    L_chan = array[W*H]; a_chan = array[W*H]; b_chan = array[W*H]
    for i in 0 .. W*H-1:
        a = alphas[i]
        L_chan[i] = avg_L*(1-a) + a*oklab[i*3+0]
        a_chan[i] = avg_a*(1-a) + a*oklab[i*3+1]
        b_chan[i] = avg_b*(1-a) + a*oklab[i*3+2]

    // 5. Select coefficients (§6.2). Counts and bit widths come from the §3.2
    //    row for this tier — codes 0 and 1 have their own, codes 2–4 scale the code-2 row.
    aspect_byte = clamp(round((log2(W/H) + 4) / 8 * 255), 0, 255)
    (L_K, L_B, C_K, C_B, A_K) = acShape(tier, hasAlpha)   // §3.2
    (L_sel, _) = selectCoefficients(aspect_byte, tier, L_K)
    (C_sel, _) = selectCoefficients(aspect_byte, tier, C_K)
    if hasAlpha: (A_sel, _) = selectCoefficients(aspect_byte, tier, A_K)

    // 6. Precompute cosine tables over the source dims, covering every selected
    //    frequency. Rows for frequencies ≥ source dims exist but are never read
    //    (the frequency clamp in dctEncode skips them).
    max_cx = max over all selections of cx; max_cy = max over all selections of cy
    cos_x = precompute_cos_table(W, min(max_cx + 1, W))
    cos_y = precompute_cos_table(H, min(max_cy + 1, H))

    // 7. DCT encode each channel (frequency clamp built in, §6.3)
    (L_dc, L_ac, L_scale) = dctEncode(L_chan, W, H, L_sel, cos_x, cos_y)
    (a_dc, a_ac, a_scale) = dctEncode(a_chan, W, H, C_sel, cos_x, cos_y)
    (b_dc, b_ac, b_scale) = dctEncode(b_chan, W, H, C_sel, cos_x, cos_y)
    if hasAlpha:
        (A_dc, A_ac, A_scale) = dctEncode(alphas, W, H, A_sel, cos_x, cos_y)

    // 8. Quantize header (decode-aware DC selection, §10.3). The scale codes
    //    are chosen by the reconstruction-SSE search of §7.2, not by rounding
    //    the raw maximum, and every AC value is then normalized by the
    //    dequantized scale the decoder will use.
    (L_dc_q, a_dc_q, b_dc_q) = selectDcCodes(L_dc, a_dc, b_dc)
    (L_scl_q, L_norm) = fitScale(L_ac, L_scale, MAX_L_SCALE, 6, MU_L, L_B)
    (a_scl_q, a_norm) = fitScale(a_ac, a_scale, MAX_A_SCALE, 6, MU_C, C_B)
    (b_scl_q, b_norm) = fitScale(b_ac, b_scale, MAX_B_SCALE, 5, MU_C, C_B)

    // 9. Pack descriptor + prefix. Byte 0 = version|tier|hasAlpha|reserved;
    //    byte 1 = aspect; bits 16..54 = DC + scales (little-endian writeBits).
    length = bodyLenBytes(hasAlpha, tier)           // §3.5
    hash = new byte[length]
    hash[0] = FORMAT_VERSION | (tier << 3) | ((1 if hasAlpha else 0) << 6)
    hash[1] = aspect_byte
    bitpos = 16
    writeBits(hash, bitpos, 7, L_dc_q);  bitpos += 7
    writeBits(hash, bitpos, 7, a_dc_q);  bitpos += 7
    writeBits(hash, bitpos, 7, b_dc_q);  bitpos += 7
    writeBits(hash, bitpos, 6, L_scl_q); bitpos += 6
    writeBits(hash, bitpos, 6, a_scl_q); bitpos += 6
    writeBits(hash, bitpos, 5, b_scl_q); bitpos += 5
    assert bitpos == 54

    // 10. Pack AC with µ-law companding (§7.3). Counts and widths come from the
    //    §3.2 row (step 5); `qAC` is the nearest-reconstruction quantizer of
    //    §7.3 and normalizes by the fitted scale from step 8.
    function qAC(value, scale, bits, mu):
        if scale == 0: return muLawQuantize(0, bits, mu)
        return muLawQuantizeNearest(value, scale, bits, mu)      // §7.3

    if hasAlpha:
        writeBits(hash, bitpos, 5, round(31*clamp(A_dc,0,1))); bitpos += 5
        (A_scl_q, A_norm) = fitScale(A_ac, A_scale, MAX_A_ALPHA_SCALE, 4, MU_ALPHA, 4)
        writeBits(hash, bitpos, 4, A_scl_q); bitpos += 4
    for i in 0 .. L_K-1: writeBits(hash, bitpos, L_B, qAC(L_ac[i],L_norm,L_B,MU_L)); bitpos += L_B
    for i in 0 .. C_K-1: writeBits(hash, bitpos, C_B, qAC(a_ac[i],a_norm,C_B,MU_C)); bitpos += C_B
    for i in 0 .. C_K-1: writeBits(hash, bitpos, C_B, qAC(b_ac[i],b_norm,C_B,MU_C)); bitpos += C_B
    if hasAlpha:
        for i in 0 .. A_K-1: writeBits(hash, bitpos, 4, qAC(A_ac[i],A_norm,4,MU_ALPHA)); bitpos += 4

    // Trailing bits to the byte boundary are padding (§2.6), implicit zero.
    assert ceil(bitpos / 8) == length
    return hash
```

### 10.3 Decode-Aware DC Selection

Plain rounding of the DC triple, combined with quantization and the decoder's
per-channel clip of out-of-gamut chroma (§12.6), can land the decoded flat color away
from the true average. The encoder therefore simulates the decoder's DC path and
searches the ±1 neighborhood of the nominal codes:

```
function dcDecodeSim(L_q, a_q, b_q) -> (r, g, b):    // gamma-encoded sRGB floats
    L = L_q / 127.0
    a = (a_q - 64) / 63.0 * MAX_CHROMA_A
    b = (b_q - 64) / 63.0 * MAX_CHROMA_B
    rgb_lin = oklabToLinearRgb(clamp(L, 0, 1), a, b)
    return (srgbGamma(clamp(rgb_lin[0],0,1)), srgbGamma(clamp(rgb_lin[1],0,1)),
            srgbGamma(clamp(rgb_lin[2],0,1)))

function selectDcCodes(L_mean, a_mean, b_mean) -> (L_q, a_q, b_q):
    L0 = round(127 * clamp(L_mean, 0, 1))
    a0 = round(64 + 63 * clamp(a_mean / MAX_CHROMA_A, -1, 1))
    b0 = round(64 + 63 * clamp(b_mean / MAX_CHROMA_B, -1, 1))

    // Target = the best color the decoder could show for the true average
    // (out-of-gamut targets are clipped per-channel, same as the decoder)
    rgb_lin = oklabToLinearRgb(clamp(L_mean, 0, 1), a_mean, b_mean)
    target = (srgbGamma(clamp(rgb_lin[0],0,1)), srgbGamma(clamp(rgb_lin[1],0,1)),
              srgbGamma(clamp(rgb_lin[2],0,1)))

    best = (L0, a0, b0); best_err = +infinity
    for dL in [0, -1, +1]:                       // fixed order — deterministic
      for da in [0, -1, +1]:
        for db in [0, -1, +1]:
            L_q = clamp(L0 + dL, 0, 127)
            a_q = clamp(a0 + da, 1, 127)
            b_q = clamp(b0 + db, 1, 127)
            cand = dcDecodeSim(L_q, a_q, b_q)
            err  = (cand.r - target.r)² + (cand.g - target.g)² + (cand.b - target.b)²
            if err < best_err:                   // strict < keeps the nominal codes on ties
                best_err = err; best = (L_q, a_q, b_q)
    return best
```

27 candidates × one DC simulation each (~10 µs total) — negligible next to the DCT.
The fixed iteration order and strict-improvement comparison make the result
deterministic and bit-exact across implementations. For solid images (scale = 0, all
AC exactly zero per §7.3) the decoded color equals the simulation, so gamut-corner
solids round-trip nearly exactly.

---

## 11. Decoding Algorithm

The decoder renders the stored absolute OKLAB into a caller-chosen **output gamut**:
`sRGB`, `Display P3`, or `Adobe RGB`. For each output gamut it uses that gamut's inverse
matrix `M1_inv[gamut]` (LMS → linear gamut RGB, §12.5) and gamma curve (`srgbGamma` for
sRGB and Display P3, which share the sRGB transfer; `x^(1/2.2)` for Adobe RGB), then
clips each channel to `[0, 1]` (relative-colorimetric, §12.6). Colors within the target
gamut render at full saturation; colors outside it clip to its boundary. Output gamut
defaults to sRGB. `BT.2020` (HDR PQ, no clean SDR display inverse) and `ProPhoto` (not a
display gamut) are not output targets and fall back to sRGB. `averageColor` (§11.2)
always returns sRGB.

### 11.1 Pseudocode

```
function decode(hash, output_gamut = sRGB) -> (w, h, rgba):
    // output_gamut ∈ {sRGB, Display P3, Adobe RGB}; others fall back to sRGB.
    // M1_inv[output_gamut] and gamma_lut (built from the gamut's transfer) are
    // selected once here and used in the per-pixel loop below (§11 intro, §12.5).
    // 1. Read descriptor (byte 0) + aspect (byte 1), then the DC/scale prefix.
    version  = hash[0] & 0x07
    tier     = (hash[0] >> 3) & 0x07
    hasAlpha = (hash[0] >> 6) & 1
    aspect   = hash[1]
    // A validating parser rejects version != FORMAT_VERSION, tier > MAX_TIER, a
    // set reserved bit, or len(hash) != bodyLenBytes(hasAlpha, tier) (§2.6, §3.5).

    bitpos = 16
    L_dc_q  = readBits(hash, bitpos, 7); bitpos += 7
    a_dc_q  = readBits(hash, bitpos, 7); bitpos += 7
    b_dc_q  = readBits(hash, bitpos, 7); bitpos += 7
    L_scl_q = readBits(hash, bitpos, 6); bitpos += 6
    a_scl_q = readBits(hash, bitpos, 6); bitpos += 6
    b_scl_q = readBits(hash, bitpos, 5); bitpos += 5    // bitpos == 54

    // 2. Decode DC and scale factors
    L_dc    = L_dc_q / 127.0
    a_dc    = (a_dc_q - 64) / 63.0 * MAX_CHROMA_A
    b_dc    = (b_dc_q - 64) / 63.0 * MAX_CHROMA_B
    L_scale = L_scl_q / 63.0 * MAX_L_SCALE
    a_scale = a_scl_q / 63.0 * MAX_A_SCALE
    b_scale = b_scl_q / 31.0 * MAX_B_SCALE

    // 3. Coefficient selection (mirrors the encoder exactly, §6.2). Counts and
    //    bit widths come from the §3.2 row for this tier: code 1 reads its own
    //    row, tier m ≥ 2 reads the code-2 row scaled by 4^(m−2).
    (L_K, L_B, C_K, C_B, A_K) = acShape(tier, hasAlpha)   // §3.2
    (L_sel, _) = selectCoefficients(aspect, tier, L_K)
    (C_sel, _) = selectCoefficients(aspect, tier, C_K)

    // 4. Decode output size (§8.2): base size shifted left by renderLevel(tier)
    (w, h) = decodeOutputSize(aspect, tier)

    // 5. Dequantize AC from bitstream (read exactly K values per channel)
    if hasAlpha:
        A_dc    = readBits(hash, bitpos, 5) / 31.0; bitpos += 5
        A_scale = readBits(hash, bitpos, 4) / 15.0 * MAX_A_ALPHA_SCALE; bitpos += 4
        (A_sel, _) = selectCoefficients(aspect, tier, A_K)
    L_ac = []
    for i in 0 .. L_K-1: L_ac.append(muLawDequantize(readBits(hash,bitpos,L_B),L_B,MU_L)*L_scale); bitpos += L_B
    a_ac = []; for i in 0 .. C_K-1: a_ac.append(muLawDequantize(readBits(hash,bitpos,C_B),C_B,MU_C)*a_scale); bitpos += C_B
    b_ac = []; for i in 0 .. C_K-1: b_ac.append(muLawDequantize(readBits(hash,bitpos,C_B),C_B,MU_C)*b_scale); bitpos += C_B
    if hasAlpha:
        A_ac = []; for i in 0 .. A_K-1: A_ac.append(muLawDequantize(readBits(hash,bitpos,4),4,MU_ALPHA)*A_scale); bitpos += 4

    // 6. Frequency filter for the render raster (§6.4). At the natural size
    //    this removes nothing; for capped renders it removes frequencies the
    //    coarser raster cannot represent.
    (L_vals, L_scan) = filter (L_ac[j], L_sel[j]) where L_sel[j].cx < w and L_sel[j].cy < h
    (a_vals, C_scan) = filter likewise over C_sel; (b_vals, _) = likewise
    if hasAlpha: (A_vals, A_scan) = likewise over A_sel

    // 7. Build sRGB gamma LUT and render
    gamma_lut = buildGammaLut()
    rgba = new byte[w * h * 4]

    for y in 0..h-1:
        for x in 0..w-1:
            // Inverse DCT per channel over the filtered coefficients
            L = L_dc
            for j, (cx, cy) in L_scan:
                L += L_vals[j] * cos(π/w*cx*(x+0.5)) * cos(π/h*cy*(y+0.5))
                               * ((cx>0?2:1) * (cy>0?2:1))

            a = a_dc; b = b_dc
            for j, (cx, cy) in C_scan:
                fx = cos(π/w*cx*(x+0.5)) * cos(π/h*cy*(y+0.5)) * ((cx>0?2:1) * (cy>0?2:1))
                a += a_vals[j] * fx
                b += b_vals[j] * fx

            alpha = hasAlpha ? A_dc : 1.0
            if hasAlpha:
                for j, (cx, cy) in A_scan:
                    alpha += A_vals[j] * cos(π/w*cx*(x+0.5)) * cos(π/h*cy*(y+0.5))
                                       * ((cx>0?2:1) * (cy>0?2:1))

            // Clamp L from DCT ringing; out-of-gamut chroma is handled by the
            // per-channel clip of rgb_lin below (relative-colorimetric, §12.6)
            L = clamp(L, 0.0, 1.0)

            // OKLAB → linear output-gamut RGB (M1_inv[output_gamut]) → gamma LUT
            rgb_lin = oklabToLinearRgb(L, a, b, output_gamut)
            idx = (y*w + x) * 4
            rgba[idx+0] = linearToGamma8(clamp(rgb_lin[0], 0, 1), gamma_lut)
            rgba[idx+1] = linearToGamma8(clamp(rgb_lin[1], 0, 1), gamma_lut)
            rgba[idx+2] = linearToGamma8(clamp(rgb_lin[2], 0, 1), gamma_lut)
            rgba[idx+3] = round(255 * clamp(alpha, 0, 1))

    return (w, h, rgba)
```

### 11.2 Average Color Extraction

The DC coefficients can be converted to an average RGBA color without full decode:

```
function averageColor(hash) -> (r, g, b, a):
    ...extract L_dc, a_dc, b_dc, hasAlpha from header...
    L_dc = clamp(L_dc, 0, 1)
    lms_cbrt = M2_inv × [L_dc, a_dc, b_dc]  // out-of-gamut chroma clipped per-channel below
    lms = [lms_cbrt[0]³, lms_cbrt[1]³, lms_cbrt[2]³]
    rgb_lin = M1_inv_sRGB × lms
    r = srgbGamma(clamp(rgb_lin[0], 0, 1))
    g = srgbGamma(clamp(rgb_lin[1], 0, 1))
    b = srgbGamma(clamp(rgb_lin[2], 0, 1))
    a = hasAlpha ? (decode alpha_dc from AC block) : 1.0
    return (round(255×r), round(255×g), round(255×b), round(255×a))
```

### 11.3 Capped Decode

Implementations SHOULD provide a capped decode that renders at
`(min(natural_w, max_w), min(natural_h, max_h))` — useful when the caller's display
target is smaller than the natural 32-px render. Rendering below the natural size MUST
apply the frequency filter of §6.4; the result is the band-limited reconstruction at
the coarser raster. Caps larger than the natural size MUST NOT upscale.

The capped path is pinned by `spec/test-vectors/integration-decode-capped.json`,
including 1×N renders of degenerate-aspect hashes (the v0.5 aliasing regression).

---

## 12. Constants & Matrices

All constants are authoritatively defined in `spec/constants.py`.

### 12.1 Scalar Constants

```
MAX_CHROMA_A       = 0.35    # Max absolute OKLAB 'a' DC (sRGB∪P3∪Adobe hull max |a| ≈ 0.347)
MAX_CHROMA_B       = 0.33    # Max absolute OKLAB 'b' DC (sRGB∪P3∪Adobe hull max |b| ≈ 0.321)
MAX_L_SCALE        = 0.5     # Max luminance AC amplitude
MAX_A_SCALE        = 0.125   # Max chroma-a AC amplitude (corpus max: 0.111)
MAX_B_SCALE        = 0.125   # Max chroma-b AC amplitude (corpus max: 0.113)
MAX_A_ALPHA_SCALE  = 0.5     # Max alpha AC amplitude
MU_L               = 5       # µ-law parameter, luminance AC
MU_C               = 8       # µ-law parameter, chroma AC
MU_ALPHA           = 5       # µ-law parameter, alpha AC

ANISO_OBLIQUE      = 1.2     # Selection weight: oblique-effect penalty  (§6.2)
SEL_HV             = 0.15    # Selection weight: horizontal/vertical bias (§6.2)
SEL_Q              = 12      # Fixed-point shift the selection order is defined on
```

These values were locked by coordinate-descent sweeps against the reference comparison
corpus (74 images: 43 synthetic dimension/alpha/color/gamut fixtures plus 31 curated
photographs), optimizing mean CIEDE2000 with SSIMULACRA2/Butteraugli/DSSIM as guards,
and validated on a never-tuned 32-image holdout split (Kodak24 plus held-out curated
photographs). `spec/EXPERIMENTS.md` records the measurements, including the ones that
were rejected.

### 12.2 M2 — LMS (cube-root) → OKLAB

```
  ┌                                           ┐
  │  0.2104542553   0.7936177850  -0.0040720468 │
  │  1.9779984951  -2.4285922050   0.4505937099 │
  │  0.0259040371   0.7827717662  -0.8086757660 │
  └                                           ┘
```

### 12.3 M2_inv — OKLAB → LMS (cube-root)

```
  ┌                                           ┐
  │  1.0000000000   0.3963377774   0.2158037573 │
  │  1.0000000000  -0.1055613458  -0.0638541728 │
  │  1.0000000000  -0.0894841775  -1.2914855480 │
  └                                           ┘
```

### 12.4 M1 — Source Gamut Matrices (Linear RGB → LMS)

Derived as `M_LMS × M_XYZ[gamut]`. Property: `M1 × [1,1,1]^T ≈ [1,1,1]^T`.

**M1[sRGB]:** (Ottosson published)
```
  0.4122214708   0.5363325363   0.0514459929
  0.2119034982   0.6806995451   0.1073969566
  0.0883024619   0.2817188376   0.6299787005
```

**M1[Display P3]:**
```
  0.4813798544   0.4621183697   0.0565017758
  0.2288319449   0.6532168128   0.1179512422
  0.0839457557   0.2241652689   0.6918889754
```

**M1[Adobe RGB]:**
```
  0.5764322615   0.3699132211   0.0536545174
  0.2963164739   0.5916761266   0.1120073994
  0.1234782548   0.2194986958   0.6570230494
```

**M1[BT.2020]:**
```
  0.6167557872   0.3601983994   0.0230458134
  0.2651330640   0.6358393641   0.0990275718
  0.1001026342   0.2039065194   0.6959908464
```

**M1[ProPhoto RGB]:** (includes Bradford D50→D65 adaptation)
```
  0.7154484635   0.3527915480  -0.0682400115
  0.2744116551   0.6677976408   0.0577907040
  0.1097844385   0.1861982875   0.7040172740
```

### 12.5 M1_inv[output gamut] — Decoder Matrices (LMS → linear gamut RGB)

The decoder selects one of these by the output gamut (§11). Each is the exact inverse of
the corresponding `M1` in §12.4. sRGB / Display P3 / Adobe RGB are the display-output
gamuts; BT.2020 / ProPhoto fall back to `M1_inv[sRGB]`.

**M1_inv[sRGB]:**
```
  4.0767416621  -3.3077115913   0.2309699292
 -1.2684380046   2.6097574011  -0.3413193965
 -0.0041960863  -0.7034186147   1.7076147010
```

**M1_inv[Display P3]:**
```
  3.1277689869  -2.2571357957   0.1293668089
 -1.0910090475   2.4133317585  -0.3223227108
 -0.0260108130  -0.5080413260   1.5340521389
```

**M1_inv[Adobe RGB]:**
```
  2.5540368478  -1.6219762024   0.0679393544
 -1.2684380042   2.6097574007  -0.3413193963
 -0.0562347471  -0.5670418342   1.6232765812
```

Output gamma: sRGB and Display P3 use `srgbGamma` (§12.6); Adobe RGB uses `x^(1/2.2)`.

### 12.6 Helper Functions

**Cube root — IEEE 754 bit-seed + 3 Halley iterations** (recommended for performance):

```
cbrt(x):
    if x == 0: return 0
    sign = (x < 0); if sign: x = -x
    bits = double_to_uint64(x)
    signed_bits = reinterpret_as_int64(bits)
    seed_signed = (signed_bits - (1023 << 52)) / 3 + (1023 << 52)  // signed int64 division
    y = uint64_to_double(reinterpret_as_uint64(seed_signed))
    repeat 3 times:                        // Halley iteration (cubic convergence)
        t1 = y * y;   y3 = t1 * y         // explicit temporaries prevent FMA
        t2 = 2.0 * x; num = y3 + t2
        t3 = 2.0 * y3; den = t3 + x
        t4 = y * num;  y = t4 / den
    return sign ? -y : y
```

Max error ≤ 2 ULP. The seed division MUST use **signed int64** arithmetic — unsigned
wraps for inputs < 1.0.

**Gamut clip** (relative-colorimetric, per-channel):

Out-of-sRGB OKLAB values are mapped to the display gamut by **per-channel clipping in
linear sRGB** — i.e. after `oklabToLinearRgb`, each channel is clamped to `[0, 1]`
before the gamma encode. This is exactly the `clamp(rgb_lin[i], 0, 1)` already present
in the decode loop (§11) and the DC-search simulation (§10.3); there is no separate
clamp helper. The result is what a standard sRGB display shows for the same color
(maximum in-gamut saturation toward the gamut corner), so the decoded placeholder
matches how the source image actually renders.

> **Why relative-colorimetric clip:** an out-of-gamut color has no exact sRGB
> representation. Per-channel clipping keeps the color at the gamut boundary (maximum
> saturation), matching the standard display rendering. Earlier versions instead
> *desaturated* out-of-gamut colors toward gray (v0.2–v0.5: constant-L clamp; an interim
> v0.6 draft: a lightness-blended soft clamp), which made saturated wide-gamut solids —
> e.g. a Display P3 or ProPhoto red — decode noticeably washed-out relative to the real
> image. Clipping is also simpler and branch-free.

```
oklabToLinearRgb(L, a, b):
    lms_cbrt = M2_inv × [L, a, b]
    lms = [lms_cbrt[0]³, lms_cbrt[1]³, lms_cbrt[2]³]
    return M1_inv_sRGB × lms

inGamut(rgb):
    return rgb[0] >= 0.0 and rgb[0] <= 1.0
       and rgb[1] >= 0.0 and rgb[1] <= 1.0
       and rgb[2] >= 0.0 and rgb[2] <= 1.0
```

**sRGB gamma LUT** (decode, 4096-entry):

```
buildGammaLut():
    lut = array[4096] of uint8
    for i in 0..4095:
        x = i / 4095.0
        srgb = x ≤ 0.0031308 ? 12.92*x : 1.055*x^(1/2.4) - 0.055
        lut[i] = round(clamp(srgb, 0, 1) * 255)
    return lut

linearToSrgb8(x, lut):
    return lut[clamp(round(x * 4095), 0, 4095)]
```

**EOTF LUT** (encode, 256-entry):

```
precompute_eotf_lut(gamut):
    lut = array[256] of float64
    for i in 0..255: lut[i] = eotf[gamut](i / 255.0)
    return lut
```

The EOTF LUT applies to RGB channels only. Alpha is linearly normalized: `alpha = rgba[i*4+3] / 255.0`.

**Cosine precomputation:**

```
precompute_cos_table(dim, max_freq):
    table = array[max_freq][dim] of float64
    for freq in 0..max_freq-1:
        for pos in 0..dim-1:
            table[freq][pos] = cos(π / dim * freq * (pos + 0.5))
    return table
```

**sRGB transfer functions:**

```
srgbGamma(x) = x ≤ 0.0031308 ? 12.92 × x : 1.055 × x^(1/2.4) − 0.055
srgbEOTF(x)  = x ≤ 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055)^2.4
```

**DCT encode** (with the §6.3 frequency clamp):

If the maximum AC magnitude after the main loop is below 1e-10, implementations MUST zero
all AC values and set scale to 0. This prevents amplification of floating-point noise for
near-constant channels (e.g., solid colors): dividing by a near-zero scale amplifies
platform-specific ULP differences into divergent quantized codes across implementations.

```
dctEncode(channel, w, h, selection, cos_x, cos_y):
    // DC: cx=0, cy=0 — cos(0)=1 everywhere, so DC = mean(channel)
    dc = sum(channel) / (w * h)
    ac = []; scale = 0
    for (cx, cy) in selection:
        if cx >= w or cy >= h:        // frequency clamp (§6.3): unrepresentable
            ac.append(0.0)            //   → exact zero, excluded from scale
            continue
        f = 0
        for y in 0..h-1:
            for x in 0..w-1:
                f += channel[x + y*w] * cos_x[cx][x] * cos_y[cy][y]
        f /= w * h
        ac.append(f); scale = max(scale, abs(f))
    if scale < 1e-10:
        for i in 0..len(ac)-1: ac[i] = 0
        scale = 0
    return (dc, ac, scale)
```

**Bit packing:**

```
writeBits(hash, bitpos, count, value):
    for i in 0..count-1:
        byte_idx = (bitpos + i) / 8; bit_idx = (bitpos + i) % 8
        if (value >> i) & 1: hash[byte_idx] |= (1 << bit_idx)

readBits(hash, bitpos, count):
    value = 0
    for i in 0..count-1:
        byte_idx = (bitpos + i) / 8; bit_idx = (bitpos + i) % 8
        if hash[byte_idx] & (1 << bit_idx): value |= (1 << i)
    return value
```

---

## 13. Changes to v1 (0.7.1)

Release 0.7.1 introduces wire-format generation **v1**, a clean break with **no backward
compatibility** with the v0.6 bitstream. The framing changes are:

- **Self-describing descriptor byte (§2.5, §3.1).** Byte 0 now carries a 3-bit `version`
  (replacing the single v0.6 version bit, which was exhausted), a 3-bit quality `tier`, the
  `hasAlpha` flag, and a reserved bit. Byte 1 is the aspect. The DC/scale prefix moves to
  bits 16–53.
- **Quality multiplier / variable length (§3.5).** A 3-bit tier scales the render grid
  (`32·2^level`) and the coefficient budget (`×4^level`), making the format variable length
  (≈21 / 32 / 108 / 411 / 1623 bytes for codes 0–4). Code 1, the default, stays exactly
  32 bytes.
- **Compact tier (§3.2, §3.5).** Tier code `0` is a 21-byte tier at the default tier's
  render resolution. It fills the gap the format could not previously express —
  ThumbHash's size, inside the range where no real codec exists (WebP's floor is ~48 B,
  AVIF's ~465 B) — and beats ThumbHash on ΔE00, SSIMULACRA2, Butteraugli *and* DSSIM on
  the never-tuned holdout split. Codes `5..=7` remain reserved.
- **Structural validation, no checksum (§2.6).** Decodability is established by validating
  version, tier, reserved bit, and the deterministic length — failing fast — rather than by
  a CRC.
- **Per-tier AC layout (§3.2, §7.4).** The layout is a three-row table rather than one
  base scaled by `4^level`. Code 1 spends its 202 AC bits on 28 luma coefficients at 4 bits
  and 15 chroma at 3 (was 26 @ 5 and 9 @ 4); codes 2–4 scale the 5-bit/4-bit code-2 row;
  the compact tier has its own row again.
- **Alpha allocation (§3.2, §7.4).** The alpha rows are rebuilt. The alpha channel had 5
  AC coefficients, inherited from v0.6 and never measured — five cannot describe a
  silhouette, which is most of what a cut-out placeholder communicates. It now takes 28 at
  code 1, paid for out of chroma (which transparent regions composite away) rather than
  luma, and alpha AC is 3 bits at every tier. Worth **−16.2% mean ΔE00** on a never-tuned
  alpha holdout with every guard improving. Alpha-mode byte lengths above code 1 change
  slightly as a result (code 2: 104 → 103 B).
- **Weighted selection order (§6.2).** The transmission order is the priority order scaled
  by `(1 + 1.2·sin²2θ)(1 + 0.15·cos2θ)` — a perceptual reordering that spends the budget
  on axis-aligned detail first. It is evaluated as an exact integer key, so it stays
  bit-exact across languages and costs nothing at decode.
- **Encoder-side quantization (§7.2, §7.3).** The AC scale code is chosen by a
  reconstruction-SSE search over every representable code (and coefficients normalized by
  the dequantized scale the decoder will use), and each AC code is the nearest in
  *reconstruction* rather than in the companded domain. Both are encoder-only: the decoder
  and the wire layout are untouched.

Together the four constants-level and encoder-side changes above are worth **−3.50% mean
ΔE00** at the default tier on a never-tuned holdout split, with SSIMULACRA2, Butteraugli and DSSIM
all improving; the optimized 32-byte encode matches the v0.6 constants at 40 bytes.
`spec/EXPERIMENTS.md` §8 records the measurements and what was rejected.

The DCT, OKLAB color pipeline, ℓ2-ball candidate set, µ-law quantizer, decode-aware DC
search, and gamut handling are **inherited from the v0.6 algorithm** (now parameterized by
tier). The subsections below document that algorithm lineage; the quality figures were
measured on the older reference corpus (52 images, color-managed metrics) for the v0.6
algorithm that v1 carries forward, and predate both the corpus revision and the tuning
above — see `spec/EXPERIMENTS.md` for current numbers:

| Mean ΔE00 (lower = better) | algorithm | v0.5 | ThumbHash |
|---|---|---|---|
| All images | **4.62** | 8.38 | 7.56 |
| Natural photographs | **8.75** | 9.52 | 10.60 |
| Degenerate dimensions | **1.81** | 18.10 | 10.09 |
| Wide-gamut fixtures | **2.67** | 4.71 | 5.23 |

### Algorithm lineage (inherited from the v0.6 redesign)

### Change 1 — Top-K coefficient selection (§6.2) replaces deriveGrid + triangle + scan order

**Problem.** v0.4 derived a grid shape from the aspect byte, masked it with an ℓ1
triangle, sorted by priority, then truncated to the bit budget — four mechanisms whose
composition could select frequencies that don't exist (a 4×14 grid for a 1-pixel-wide
source) while spending slots on sparse axis-aligned high frequencies (`cx` up to 8 at
3:2) that reconstruct as visible striping.

**Fix.** One mechanism: take the K lowest isotropic per-pixel spatial frequencies over
the natural-decode domain `[0, W) × [0, H)`. The domain bound makes unrepresentable
frequencies unselectable; the ℓ2 ball matches natural-image spectra; `deriveGrid`, the
triangle test, and the separate scan-order sort are deleted. The priority formula and
lex tiebreak are unchanged from v0.4 — only the candidate set differs.

### Change 2 — Encoder frequency clamp to source dimensions (§6.3)

**Problem.** Encoding a 1×N image computed `F(cx, cy)` for `cx ≥ 1` over a single
column: the basis is degenerate there and `F(2, cy) = −F(0, cy)` — a junk copy of the
DC that inflated the channel scale ~5×, crushed every real coefficient's precision, and
rendered as solid white at capped decode sizes (where `cos(π·2·0.5) = −1`).

**Fix.** Selected pairs with `cx ≥ src_w` or `cy ≥ src_h` are written as exact zeros and
excluded from the scale max. The dim-1x100 corpus fixture improves from ΔE00 54.5 to 0.78.

### Change 3 — Decoder frequency filter for sub-natural renders (§6.4, §11.3)

Capped decodes now skip coefficients the render raster cannot represent, yielding the
band-limited reconstruction instead of aliasing. Pinned by the new
`integration-decode-capped.json` vectors.

### Change 4 — Exact-zero µ-law with per-channel µ (§7.3)

**Problem.** v0.5's `2^bits` levels had no zero code: a zero coefficient decoded to
+0.012·scale (5-bit) / +0.025·scale (4-bit), a systematic bias across every empty slot.

**Fix.** Odd level count (`2^bits − 1`) with an exact-zero center code; the never-written
top code clamps down on read. Solid colors decode exactly uniform. µ splits per channel
group (`MU_L = 5`, `MU_C = 8`, `MU_ALPHA = 5`) — chroma's tight scale range concentrates
coefficients near zero, where a higher µ buys resolution.

### Change 5 — Quantization ranges sized to signal (§7.1, §7.2)

**Problem.** Chroma DC ranges (±0.45) were sized to wide-gamut source extremes the sRGB
decoder can never display, and chroma AC scale ranges (0.5) exceeded the measured corpus
maximum (0.113) by 4.4× — together wasting roughly two bits of every chroma field. The
result was visible chroma banding and desaturation.

**Fix.** `MAX_CHROMA_A/B` sized to the display-output gamut union — sRGB ∪ Display P3 ∪
Adobe RGB (0.35/0.33), still far tighter than v0.5's ±0.45 — so wide-gamut colors are
stored faithfully for multi-gamut output (§11) without wasting precision on chroma no
display can show; `MAX_A/B_SCALE` to 0.125. This was the single largest quality win of
the revision.

### Change 6 — Decode-aware DC code selection (§10.3)

**Problem.** Rounding the DC triple independently could land just outside the sRGB
gamut, where the decoder's clamp dragged it far away: solid blue `(0,0,255)` decoded
as `(0,58,214)` (ΔE00 7.75).

**Fix.** The encoder simulates the decoder's DC path for the 27 code triples in the ±1
neighborhood and keeps the one minimizing gamma-sRGB error against the clamp-mapped
target. Deterministic (fixed order, strict improvement, ties keep nominal). Solid blue
now decodes at ΔE00 0.36.

### Change 7 — Relative-colorimetric gamut clip (§12.6)

**Problem.** Both the v0.2–v0.5 constant-L clamp and an interim v0.6 lightness-blended
soft clamp *desaturated* out-of-sRGB colors (toward gray / toward the gamut interior),
so saturated wide-gamut solids — a Display P3 or ProPhoto red — decoded visibly
washed-out relative to how the source actually renders on a display.

**Fix.** Out-of-gamut OKLAB values are mapped by **per-channel clipping in linear sRGB**
(the `clamp(rgb_lin[i], 0, 1)` already in the decode loop) — relative-colorimetric, the
same mapping a display applies. Saturated colors land at the gamut boundary (maximum
in-gamut saturation) instead of being pulled inward, and the separate soft-clamp helper
is removed.

### Evaluated and rejected

A decode-side raised-cosine synthesis window (tapering high-frequency AC by normalized
priority `ρ = sqrt(priority / p_k)`) was implemented and swept. With the v0.6 chroma
ranges in place it cost more detail than the residual ringing it suppressed — v0.5's
visible banding turned out to be chroma quantization noise (Change 5), not luma Gibbs
ringing. The `p_k` value remains defined (§6.2) should a future revision revisit
frequency-normalized decoding.

---

## 14. Trade-offs & Limitations

| Trade-off | Details |
|-----------|---------|
| **Larger size** | 32 bytes at the default tier vs 5–25 for variable-length formats. At 1B photos: 32 GB vs ~17 GB. Fixed size enables memory alignment and cache-friendly access; the compact tier (21 B) trades that fixed width for ThumbHash's footprint. |
| **Encode cost** | Encoding is `O(K·W·H)` over the full source, with no downsample, so cost scales with the source's pixel count — a multi-megapixel original is far more expensive than a thumbnail. The DC search adds a fixed term that is negligible against it. The forward DCT dominates the total; see [`PERFORMANCE.md`](PERFORMANCE.md) §1 for the measured breakdown. |
| **Decode cost** | Cost is `O(w·h·K)` and grows ~16× per tier level (`4^level` coefficients over a `4^level` raster), so the upper tiers are dramatically more expensive than the default — `decodeCapped` is the mitigation, and capping the raster is what makes tier 4 practical. See [`PERFORMANCE.md`](PERFORMANCE.md) §2 for measured figures. |
| **Solid images** | The whole AC payload is zero — 202 of the default tier's 256 bits, and a larger share at each tier above it, since only the 54-bit prefix carries signal. Irrelevant for photographs. |
| **Extreme ratios** | Ratios beyond 16:1 clamp to 16:1. Rare in photography. |
| **Wide-gamut DC clipping** | The DC chroma range covers the OKLAB hull of sRGB ∪ Display P3 ∪ Adobe RGB (§7.1), so only sources wider than that union — some BT.2020 / ProPhoto inputs — clip at encode (§5.1), and no display can show those anyway. Decoding into Display P3 or Adobe RGB is already a caller option (§11, §12.5), not a format break. |
| **Gamut clip** | Out-of-sRGB OKLAB values are clipped per-channel in linear sRGB (relative-colorimetric, §12.6) — the same mapping a display applies, so saturated wide-gamut solids render at full in-gamut saturation rather than desaturated. |
| **No progressive decode** | The whole hash must be received before decoding. Never a practical bottleneck at these sizes; embedded/progressive tiers are a future direction (§15). |
| **Codes 3–4 are not a rate–distortion claim** | See below. |

### 14.1 What codes 3 and 4 are for

Codes 1 and 2 (32–108 bytes) are where this format is competitive on quality: it leads
every other LQIP and every size-matched codec on ΔE00 by 8–25%, and at 108 B it takes
SSIMULACRA2 off size-matched WebP. Below 48 bytes no general codec can produce output at
all, which is the compact and default tiers' whole argument.

Codes 3 and 4 are **not** justified that way, and this specification does not claim they
are. Measured at equal bytes on the same corpus, WebP overtakes ChromaHash somewhere
around 300 bytes, and by ~1.6 kB even uncoded RGB565 pixels score better than code 4
(`EXPERIMENTS.md` §2, §3). Entropy coding would recover roughly 4% — nowhere near the
20–40% gap, and it would cost the O(1) length check that *is* this format's validity
check (§2.6).

They are kept for the operational properties they share with the rest of the format, and
those are real: no codec dependency, no decoder CVE surface, no container or metadata
parsing, byte-exact reproducibility across languages and platforms, O(1) validation from
byte 0, and one code path from 21 bytes to 1.6 kB. Choose code 3 or 4 when those matter
more than bytes-per-quality. When they do not, a real codec is the better tool and this
specification would rather say so than argue otherwise.

---

## 15. Future Directions: JPEG XL VarDCT Evaluation

The v1 quality multiplier (§3.5) buys "more detail" the simplest correct way — more DCT
coefficients on a larger grid at fixed per-coefficient precision. JPEG XL's VarDCT (lossy)
path is the natural reference for going further. Each of its coding tools is evaluated below
**for the ultra-low-bitrate LQIP regime** (sub-2 KB, smooth blurred placeholder); a
technique that pays for itself in a full-image codec often does not when the entire payload
is a few hundred bytes and the target is intentionally low-pass.

| JPEG XL VarDCT tool | What it does | Verdict for chromahash |
|---|---|---|
| XYB opsin color | Perceptual LMS-based color space | **Already covered** — OKLAB is the modern peer; no change. |
| Variable DCT block sizes (2×2…32×32, incl. rectangular) | Per-block adaptive transform size | **N/A** — a single global DCT is correct at this bitrate; the *tier* is our "variable" axis. Per-block side-info is unaffordable here. |
| Adaptive (spatial) quantization | Per-region quant field from a perceptual heuristic | **Defer** — a per-region quant map is too much side-info for a sub-2 KB payload; possibly justified only at code 4. |
| **Chroma-from-luma (CfL)** | Predict X/B chroma from Y luma with per-group multipliers | **Built and refuted** — `EXPERIMENTS.md` §7.10 implemented it as a signalled per-channel least-squares gain and measured it at every tier; it does not pay at any of them. This row read "strong v0.8 candidate" until that experiment was run, and is kept as the prediction it scored against. |
| Gaborish | Small post-decode smoothing convolution | **Re-evaluated, still off** — the decode-side synthesis window (`window_weights`, a Hann taper, disabled by default). `EXPERIMENTS.md` §12.2–§12.3 measured it at codes 1 and 2 with artifact metrics that did not exist when v0.6 rejected it: it removes up to 73% of the invented structure and costs ΔE00 and SSIMULACRA2 monotonically, failing the guards at every strength. At code 2 the lightest taper is statistically free on ΔE00 and fails on SSIMULACRA2 alone. |
| Edge-preserving filter (EPF) | Adaptive deringing loop filter | **Reject** — a blurred placeholder has few edges to preserve. |
| DC image + DC predictors | Separate DC plane with spatial predictors | **N/A** — chromahash has a single average-color DC per channel, already chosen by the decode-aware DC search (§10.3). |
| **Quantization weighting matrices (HVS/CSF)** | Frequency-dependent quant step | **Evaluate / adopt** — a frequency-shaped bit allocation generalizes the existing two-tier `AcLayout` L split; cheap and on-trend with HVS sensitivity. |
| **Entropy coding (rANS + context modeling + clustering, HybridUint tokens)** | Adaptive entropy coding of quantized coefficients | **Highest-impact v0.8+** — fixed-width µ-law leaves the most on the table; many high-frequency coefficients quantize to zero and would cost almost nothing under an entropy coder, raising the quality ceiling per byte. Heaviest to make bit-exact across all language bindings (incl. the hand-written TS decoder) and it trades away the fixed-per-tier length, so it is deferred deliberately. |
| Coefficient ordering / scan + nonzero context | Frequency-ordered scan, run/EOB modeling | **Already frequency-ordered** — the top-K isotropic selection is exactly this; pairs naturally with entropy coding when added. |
| Patches / splines / dots | Reference repeated elements / smooth gradients / point sources | **Reject** — no repeated elements or point sources in a placeholder; the DCT already models smooth gradients compactly. |
| Noise synthesis | Add a per-image perceptual noise model at decode | **Low-priority option** — a few bits of noise amplitude could add cheap perceptual texture; minor. |
| **Progressive / responsive passes** | DC-first, then refinement passes (embedded scalability) | **Compelling v0.8 direction** — make higher tiers *embedded* (the default-tier bytes are a prefix of code 2, etc.) so one stored hash serves both an instant preview and an on-demand detailed render. Constrains the layout but is very LQIP-appropriate. |
| Upsampling (2×/4×/8×) | Store small, upsample at decode with a fixed kernel | **Already covered** — the DCT renders at any target size and `decodeCapped` band-limits (§6.4, §11.3). |

**Summary of the roadmap, as written for v1 — and how it scored.** The four directions
named here were (1) **entropy coding**, (2) **chroma-from-luma**, (3) **frequency-weighted
quantization**, (4) **embedded/progressive tiers**. All four were subsequently built and
measured in `EXPERIMENTS.md` §7, and the ordering did not survive: chroma-from-luma is
refuted at every tier (§7.10), frequency-weighted quantization is −0.52% and below
threshold (§11.9), embedded tiers are bounded at −20% (§7.11), and entropy coding buys
−4.3% out of sample at the cost of the O(1) length check that *is* this format's validity
check (§7.13, §2.6). The list is kept as written so the predictions can be read against
the outcomes; `EXPERIMENTS.md` §11.13 and §12 carry the current one.

---

## Appendix A: ThumbHash Comparison & Acknowledgment

ChromaHash is directly inspired by [ThumbHash](https://evanw.github.io/thumbhash/) by
Evan Wallace. Key inherited ideas: DCT-based placeholder encoding, alpha compositing
over average color, and average color extraction from the header.

| Feature | ThumbHash | ChromaHash v1 (default tier) |
|---------|-----------|------------|
| **Size** | 5–25 bytes (variable, length must be probed) | 32 bytes at the default tier; opt-in tiers to ~108/411/1623 bytes (self-describing length) |
| **Color space** | LPQA (gamma sRGB) | OKLAB (perceptually uniform) |
| **L DC / Chroma DC** | 6 / 6 bits | 7 / 7 bits |
| **Coefficient selection** | ℓ1 triangle over adaptive grid | Top-K ℓ2 ball over the decode raster |
| **L AC budget** | up to 27 coeff, 4-bit linear | 28 coeff, 4-bit µ-law (exact zero) |
| **Chroma AC budget** | 5 coeff × 4-bit each | 15 coeff × 3-bit µ-law (µ=8) each |
| **DC fidelity** | rounded | decode-aware search (gamut-corner solids near-exact) |
| **Aspect ratio** | 3-bit (~7% error) | 8-bit log₂ (~1.1% error) |
| **Aspect range** | up to ~7:1 | up to 16:1 |
| **Source gamuts** | sRGB only | sRGB, P3, Adobe RGB, BT.2020, ProPhoto |
| **Gamut clamping** | Hard per-channel | Relative-colorimetric per-channel clip in the output gamut (§12.6) |
| **Input dimensions** | Any (library resizes) | Any (full-resolution DCT) |
| **Quality scaling** | None | 3-bit tier: ×4^level coefficients, 2^level render resolution, `level = renderLevel(tier)` |

On the reference corpus (52 images, identical color-managed metrics), ChromaHash v0.6 —
whose default-tier layout differs from v1 only in the smaller pre-tier header and a 27th L
coefficient — led ThumbHash on every metric: mean ΔE00 4.62 vs 7.56, SSIMULACRA2 56.6
vs 47.6, Butteraugli 9.78 vs 14.90, in exchange for the larger size.

---

*This specification is licensed under the same terms as the ChromaHash project (MIT OR Apache-2.0).*
