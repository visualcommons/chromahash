# ChromaHash Design Rationale

Why each v1 design decision is what it is, with the alternatives that were
considered and rejected. Normative text lives in [`README.md`](README.md); this
file records the *evidence*.

Sweep numbers come from the decision tables produced by `mise run sweep <config>`
(configs in `tools/comparison/sweeps/`, results in
`tools/comparison/output/sweeps/`) on the **tune split** of the expanded corpus
(74 images: 43 synthetic + 31 curated photos; the 32-image holdout —
Kodak24 + held-out curated photos — is reserved for validating winners, per the
pre-registered rule below). The curated set grew from 26 to 39 photographs in
the 2026-08 corpus revision (`EXPERIMENTS.md` §9); **the v1 numbers in this file
were measured before it** and are not comparable to the re-measured tables
there. Re-deriving the constants on the revised corpus was a stated job for the
next revision, and **v0.7 did it**: µ-law companding, the deadzone, the
quantization ranges, the scalefactor bands and the selection weights were all
re-swept on the current corpus at the current bit depths (`EXPERIMENTS.md`
§11.5–§11.9). Every one of them stands, so the conclusions in this file survive
their re-derivation — but the *numbers* below are the pre-revision ones, and
§11 is where the current figures live. Rate–distortion numbers come from `mise run compare:rd`
(photographic corpus, display-resolution scoring). Release A/B numbers against
the previous format generation come from `mise run compare:versions`, which
differences each image against the v0.6 tag *paired* and reports a bootstrap CI
of that difference (see Evaluation methodology). Numbers marked **[v0.6]** were
measured during the v0.6 redesign on the original 52-image corpus.

**Pre-registered retune rule.** A constants-level wire change lands only if it
improves holdout mean CIEDE2000 by ≥3% with no SSIMULACRA2 / Butteraugli /
DSSIM guard regression. The 2026-07 sweep battery **did not trigger it** — the
best candidate across every family reached −1.51% on the tune split — so the
v1 constants stand, now with the evidence recorded below.

Because µ-law companding comes from telephony, the audio-codec toolbox was
audited explicitly (§Quantization); because the format competes with modern
lossy image codecs, the AVIF/JPEG XL toolbox was audited explicitly
(§Image-codec techniques).

## Architecture

### 32 bytes at the default tier
A default-tier (code 1) hash is exactly 32 bytes — the v0.6 footprint — so the format is an
equal-budget upgrade path from prior LQIPs (BlurHash ~30–36 B, ThumbHash
~21–25 B) and a zero-overhead fixed-width database column in the common case.
**Rejected:** a variable-length default (ThumbHash-style, 5–25 B): saves ~15 B per
image at the cost of length framing everywhere and a materially worse quality
floor.

#### What holding 32 bytes cost, measured
Keeping the default at exactly 32 bytes while byte 0 grew into a self-describing
descriptor had to come from somewhere: at the v0.6 bit widths the no-alpha luma
AC count drops 27 → 26, and alpha mode collapses v0.6's mixed-precision
`[(7,6),(13,5)]` into a single `[(20,5)]` tier (the pre-§11.3 alpha row; the
shipped one is `[(22,4)]`). That is ~3.7% of the luma AC budget spent on
framing. **Measured** (`mise run compare:versions`, paired per-image against
the v0.6 tag at the same 32 bytes, holdout split, n=28).
Signs are normalized per metric so that **positive means v1 is worse**:

| Metric | v0.6 | v1 t0 | paired Δ% | 95% CI of paired Δ | win/loss |
|---|---|---|---|---|---|
| ΔE00 | 11.312 | 11.364 | **+0.45%** | [+0.029, +0.078] | 3/25 |
| SSIMULACRA2 | −279.8 | −283.1 | **+1.18%** | [+1.57, +5.53] | 3/25 |
| Butteraugli | 28.06 | 28.45 | **+1.39%** | [+0.160, +0.657] | 5/23 |
| DSSIM | 0.2534 | 0.2535 | +0.02% | [−0.0000, +0.0001] | 10/18 |

Small but real: every CI except DSSIM's excludes zero, and the direction is
consistent (25 of 28 holdout images regress; sign-test p = 0.0001). The
photographic corpus agrees at +0.62% ΔE00. Run through the sweep runner's guard
gate (`sweeps/v06-vs-v1.json`), **v1's default tier fails the guards against v0.6** —
the SSIMULACRA2 drop exceeds the 1.0 tolerance.

**Accepted anyway, and this is a positioning claim rather than a quality one.**
At 32 bytes v1 is not an improvement on v0.6; it is a ~0.5% quality payment for
the descriptor byte, and what that byte buys is the tier ladder, O(1)
structural validation, and deterministic variable length. The quality story
lives one rung up: code 2 at 108 B is −17.5% ΔE00 against v0.6 on holdout
(CI [−2.38, −1.61]), winning on all 28 images — a budget v0.6 has no way to
spend at all. Reclaiming the 27th luma coefficient (a narrower scale field, or
the reserved bit) is sized by the 0.45% above and recorded as future work.

The effect is also far below the ≥3% pre-registered retune threshold, so it
does not by itself argue for a constants revision — it is recorded because the
"equal-budget upgrade path" framing above is true about *bytes* and would
otherwise be read as also true about *quality*.

### Quality tiers: count ×4^level at constant precision
A 3-bit tier multiplies every AC coefficient *count* by 4^level and doubles the
render edge (32→256 px); bytes ≈ 21/32/108/411/1623. One knob, deterministic
length, and the selection order is tier-invariant (priorities scale uniformly
×4 per level), so low frequencies mean the same thing at every tier.

Review challenged this with rate–distortion practice (codecs add *precision*
with rate, not only bandwidth). **Measured** (`tier-precision-vs-count`, the
108 B budget, equal bytes): every precision-for-count trade loses — a 10×6b+14×5b L
split +0.11% ΔE00, fewer-L/wider-chroma +1.05%, mostly-6-bit L +0.50%, and all
three *fail the SSIMULACRA2 guard* (−135 → −141…−158). At these bitrates more
coefficients beat finer coefficients; the constant-depth design is the right
call for v1's tier range.

### Tier codes ordered by quality
The 3-bit tier field is a quality ordinal: code 0 is the compact tier (21 B),
code 1 the 32-byte default, codes 2–4 the higher tiers. A larger code is never a
smaller hash.

**Rejected:** placing the compact tier at code 4, above the quality tiers,
because 4 came from the range v1 had reserved. That was the original shape and
it was chosen for availability, not for semantics — the reserved range was, in
`EXPERIMENTS.md` §3's words, "the cheapest place to put it". The argument for
keeping it was compatibility: a v1 decoder written before the compact tier
existed would reject code 4 rather than mis-decode it. **That argument applies
to a population of size zero.** Wire generation v1 (`version` = 0) ships in
0.7.x, which was never tagged and never published to any registry; v0.6 and
earlier carried a single version bit at bit 47 and no tier field at all. The
compact tier and the rest of v1 reach users in the same release.

Against that, an unordered code costs a permanent hazard. It forces every
size-scaling site to shift by a derived render level rather than the code, and
`README.md` §3.5 had to name that as "the single most likely way to implement
this tier wrongly". It fired three times inside this repository before release:
the Python reference rendered the compact tier at 512 px; the C ABI's
`quality > MAX_TIER` bound rejected the compact tier outright, taking Go and C#
with it; and a cross-language parity vector built as `MAX_TIER + 1` silently
stopped testing what it claimed. Ordering the codes costs nothing in reserved
space — codes 5–7 remain free either way — and makes `tier <= MAX_TIER` correct.

The residual cost is that the default tier's code is 1, not 0, so a literal `0`
default in a language binding now selects the compact tier. Each binding names
the constant (`DEFAULT_TIER`) rather than writing the literal, and asserts that
its default encode is exactly 32 bytes.

### The upper tiers vs "just ship a tiny real image"
Measured by `mise run compare:rd` against size-targeted WebP/JPEG(mozjpeg)/AVIF
thumbnails and a raw-RGB565 control at the tier byte anchors (50 photographic
images, display-resolution scoring, mean ΔE00 lower-better). Structural
floors first: WebP cannot exist below ~48 B, mozjpeg ~320 B, AVIF ~466 B — so
at 32 B ChromaHash competes only with purpose-built LQIPs.

| Anchor | Winner | Runner-ups |
|---|---|---|
| 32 B | **ChromaHash v0.6 10.51** | ChromaHash t0 10.57 · RawRGB565 11.76 · ThumbHash 12.00 · BlurHash 4x4 13.46 |
| 108 B | **ChromaHash t1 8.58** | RawRGB565 9.10 · WebP 9.45 · lqip-modern r16 10.53 (82 B) |
| 411 B | **WebP 6.61** | ChromaHash t2 7.13 · RawRGB565 7.41 · lqip-modern r48 7.57 (248 B) · JPEG 8.83 |
| 1623 B | **AVIF 4.71** | WebP 5.17 · JPEG 5.30 · RawRGB565 5.75 · ChromaHash t3 6.40 |

The predecessor edges out v1's default tier at the anchor they share, by the margin
quantified above; against every *other* format at 32 B the two are
interchangeable. Code 2 wins its anchor outright — at 108 B even raw RGB565 pixels
beat WebP, whose container overhead dominates that budget. WebP overtakes
code 3 by ~7% at 411 B, and the real codecs lead code 4 by 20–36% at 1623 B.
The honest positioning: **codes 3–4 are not rate–distortion-competitive with
real codecs**; their value is operational (no image decoder dependency, O(1)
validation, deterministic bytes, one code path for all tiers). Recorded as an
open positioning question below. (Also measured: the CSS-gradient
placeholder — unpic, 592 B — scores 19.24, worst of every raster-capable
entry; BlurHash saturates near ΔE00 ≈ 12 regardless of component count.)

### Independent (non-embedded) tiers
A code-2 hash is not a byte-superset of a default-tier hash: channels are stored
sequentially, so a byte prefix is not decodable. Capped decode (§11.3) already
covers "render a high-tier hash small" — **measured** (`capped-tier1-vs-tier0`,
photo tune split): a code-2 hash rendered at the default natural size scores
ΔE00 7.61 vs 9.57 for a native default-tier encode (−20%), essentially identical
to the code-2 natural render (7.62). Note this is *not* a truncation preview —
capped decode keeps every in-band coefficient of the larger set — so it upper-
bounds what byte-embedded/progressive tiers could preserve. Embedding requires
interleaving AC across channels by priority: a structural wire change, v0.8
roadmap.

### No entropy coding
At the default tier, fixed-width fields buy O(1) validation (deterministic length
*is* the validity check), no decoder tables, and fixed DB width — for ≤256 bits
the ~20–40% entropy savings on near-Laplacian AC is not worth losing those. At
codes 3–4 (3–13 kbit) the trade genuinely reverses; entropy-coded AC is a v0.8
roadmap item, and the R-D gap to WebP/AVIF at those anchors is the budget it
would need to close.

### Self-describing, no checksum
Byte 0 (version/tier/flags) + the deterministic length formula = a parser
validates in O(1) and a validated hash always decodes. A checksum verifies
*integrity*, not *decodability* — transport already owns integrity
(TCP/TLS/storage ECC).

### Full-resolution encode, no pre-downsample
The DCT projection *is* the anti-aliased lowpass: computing only the K lowest
frequencies over all source pixels is a proper inner product — no resampling
kernel to standardize, no aliasing pathway. Cost is O(K·w·h), documented; apps
MAY pre-downscale for speed at the price of bit-exactness vs full-res encodes.

## Signal path

### OKLAB
Perceptually uniform (quantization steps ≈ evenly perceived), hue-linear, cheap
(3×3 matrices + cube root), and *absolute* — no gamut flag on the wire.
**Rejected:** OKLCH (hue-angle wraparound at 0°/360° breaks DCT encoding);
YCbCr (not perceptually uniform — wastes code levels); ICtCp (needs PQ
transfer; overkill at placeholder fidelity); **XYB (JPEG XL)** — the serious
peer, also a cbrt-LMS space, but its axes are tuned for JXL's adaptive-
quantization machinery, it is not hue-orthogonal by design, and it has no
CSS/ecosystem presence; no evidence it wins at 32 B.

### Averaging and DCT in OKLAB (not linear light)
The DC is the perceptual average — arguably the right *target* for a
placeholder — rather than the physical (linear-light) average a downscaler
would produce. Untested empirically (would need a Rust-side averaging knob);
recorded as future work. The perceptual-average argument stands on its own for
a format whose output is judged by eyes, not by radiometry.

### Global separable cosine transform
No blocks → no blocking artifacts → nothing for a lapped transform to fix
(**MDCT explicitly N/A** — its purpose is block-boundary cancellation).
**Rejected:** wavelets (no scale hierarchy to exploit at K=26; reopen at
code 4 only if codes 3–4 survive their positioning question); KLT/learned
bases and Gaussian-splat placeholders (training dependency, no zero-dependency
deterministic decode story); block DCT (blocking artifacts at exactly the
scale placeholders are blurred at).

### Top-K ℓ2-ball selection, fixed per (aspect, tier)
Priority `(cx·H)² + (cy·W)²` = squared isotropic per-pixel frequency ×(WH)²:
integer-exact, aspect-adaptive (the long axis gets more coefficients), and
structurally alias-free (candidates are exactly the representable
frequencies). Zero signaling cost — at K=26, per-image adaptive selection
would spend more bits on positions than it buys (it only pays with entropy
coding → v0.8).

Review challenged isotropy via the human CSF's oblique effect (diagonal
frequencies are less visible; JPEG's tables penalize diagonals ~2×).
**Measured** (`aniso-selection` + `aniso-extended`): weighting the ball by
`1 + aniso·sin²2θ` improves monotonically to an optimum at aniso=1.2, then
degrades and fails guards past 1.6. Extending it to the two-parameter family
`(1 + aniso·sin²2θ)(1 + hv·cos2θ)` adds a horizontal/vertical term at hv=0.15.

**Shipped in v1** (§6.2). On its own the weight is under the 3% retune
threshold; it entered the spec as part of the default-tier recipe of
`EXPERIMENTS.md` §8, which clears it as a whole (−3.50% holdout, all guards
improving) and is worth −0.34 pp of that. The f64 ordering the sweep used is
*not* what shipped: the spec orders on an exact Q12 integer key, so the order
is bit-exact across languages, and computing it once per candidate instead of
inside the comparator made decode ~8% **faster** than the unweighted v0.6 sort
rather than the +32% the float prototype cost.

`hv ≠ 0` deliberately breaks the portrait/landscape symmetry the bare priority
order has — `cos2θ` flips sign under the transpose. That asymmetry is the
point (vertical detail is favoured), and `spec/validate.py` asserts it so it
cannot be "fixed" back out.

### Encoder frequency clamp + decoder frequency filter
Selected pairs outside the source's representable band are emitted as exact
zeros and excluded from scale (encoder); render-time filtering skips pairs
outside the raster (decoder). Fixes the v0.5 1×N-strip catastrophe
**[v0.6: dim_1x100 ΔE00 54.5 → 0.78]** and makes capped decodes band-limited.

### Synthesis window: evaluated and rejected, re-measured and still off
A raised-cosine synthesis window (ρ = sqrt(priority/p_k)) was implemented and
swept for v0.6. With corrected chroma scale ranges it cost more detail than
the ringing it suppressed — v0.5's visible striping was chroma quantization
noise, not luma ringing. `p_k` stays pinned by test vectors for future
frequency-normalized extensions.

**Re-opened for v0.8** (`EXPERIMENTS.md` §12.2–§12.3), because that verdict was
reached on ΔE00 plus three aggregate fidelity guards, and none of them can
separate *smooth but wrong* from *sharp with artifacts* — the harness had no
artifact metric at all until v0.7.2, and no sweep scored one until this round.
Measured at codes 1 and 2 with ringing and spurious detail reported, the taper
removes up to **73%** of the structure the format invents, and costs ΔE00 and
SSIMULACRA2 monotonically; every arm fails the guards. **The rejection stands,
and now it rests on the trade rather than on half of it.**

Two findings worth carrying forward. The effect is **entirely luma**: a
chroma-only taper is inert on every column, which is the opposite of the
attribution above — whatever was true at the v0.5 constants, at v0.7's the
invented structure is luma, and this paragraph's second sentence should not be
read as describing the format as it now ships. And at code 2 the lightest taper
(`w_min 0.85`) is **statistically free** on ΔE00 — a paired CI of
[−0.027, +0.012] over 31 images — buying a 28% cut in invented detail and a
better DSSIM, and failing on SSIMULACRA2 alone. That is a decision resting
entirely on whether SSIMULACRA2 is right about placeholders, which is U19 and
is still open.

## Quantization (the audio-codec audit)

### µ-law companding, µ_L=5 / µ_C=8 / µ_ALPHA=5 — validated against the family
Logarithmic companding matches the Laplacian-like distribution of natural-image
DCT coefficients; chroma uses higher µ because its tight scale range (0.125)
concentrates coefficients near zero where higher µ buys resolution.

Review demanded the full audio family at identical bit budgets, not just µ
re-tuning. **Measured** (`companding-family`, 14 variants):

| Alternative | ΔE00 vs shipped |
|---|---|
| µ_L ∈ {4,6,7}, µ_C ∈ {6,10,12} | −0.12% … +0.47% (plateau) |
| **A-law** (a=87.6, L+C) | **+0.98% worse** |
| **Power-law** \|x\|^γ, γ∈{0.6, 0.75, 0.9} (the AAC/MP3 shape) | +0.20% / +0.39% / **+2.12% worse** |
| **Lloyd-Max codebooks** trained on the tune corpus (top level pinned at 1.0) | −0.05% / −0.11% / **−0.17%** (L / C / both) |

The trained-optimal quantizer buying only −0.17% is the strongest evidence
available that µ-law is already at the distribution's plateau: in pure MSE the
tables beat µ-law by just +0.33 dB (L) / +0.85 dB (C) (`mise run train:tables`).
A structural detail matters here: scale = max|AC| puts a point mass at exactly
±1 in the normalized data (≥1/K of samples), and µ-law's endpoint level sits
exactly there — a trained codebook must pin its top level at 1.0 to match.

### Odd-level exact-zero quantizer
2^bits−1 levels with the center index decoding to exactly 0.0 removed v0.5's
systematic zero bias **[v0.6: +0.012·scale at 5 b / +0.025·scale at 4 b]**.
The top code is never written; decoders clamp it down.

### Deadzone: evaluated and rejected
The video-codec staple (widened zero bin). **Measured** (`deadzone`): every
variant is neutral-to-worse (+0.00% … +0.97%). The exact-zero center code
already captures the entire benefit a deadzone offers this signal.

### One scale factor per channel (max |AC|)
Review raised MP3/AAC scalefactor bands — one large low-frequency coefficient
shouldn't crush the resolution of every small high-frequency one. **Measured**
(`scalefactor-bands` at the default tier, `scalefactor-bands-t1` at code 2): the
best band split reaches −0.20% at the default and −0.52% at code 2 (split=0.25,
gain_l=0.6, guards ok). Direction confirmed — the effect grows with
coefficient count, exactly as the audio analogy predicts — but far below the
retune threshold. Revisit alongside entropy coding at v0.8, where per-band
scales become cheap to signal.

### Quantization ranges sized to signal — re-validated
`MAX_A/B_SCALE = 0.125`: the v0.6 corpus maximum chroma AC scale was 0.113 —
v0.5's 0.5 range wasted two bits of every chroma coefficient (the single
largest v0.6 quality win). **Re-measured on the expanded corpus**
(`quant-ranges`): widening b to 0.15 costs +0.46%, narrowing both to 0.1 costs
+0.86%, and moving `MAX_L_SCALE` to 0.35/0.65 is ±0.2% — the shipped
0.5 / 0.125 / 0.125 sits at a flat optimum. The a_scale=6b / b_scale=5b field-
width asymmetry is wire-fixed and could not be swept; the range-asymmetry
proxy (a vs b at 0.15) shows b is the more sensitive axis (+0.46% vs −0.01%),
consistent with keeping b's range tight — the 1-bit swap itself remains an
open (wire-changing) question.

### Bit allocation: code 1 = L 4 b ×28 / C 3 b ×15+15; codes 2–4 = L 5 b / C 4 b
The v0.6 sweep over layouts A–D (chroma-rebalanced, tiered-precision,
finer-chroma variants) locked a 5-bit luma / 4-bit chroma split, and the v1
108 B sweep re-confirms it against three equal-byte alternatives — *at code 2
and above*.

At the default tier it is the wrong answer. The count-vs-precision optimum moves with the
budget, and a 32-byte hash has 202 AC bits to spend: sweeping the whole
equal-byte grid (`EXPERIMENTS.md` §4.2) puts the optimum at 28 luma
coefficients at 4 bits plus 15 chroma at 3, worth −3.5% mean ΔE00 on the
never-tuned holdout with every guard improving. So v1 carries a **three-row
layout table** rather than one base scaled by `4^level` (§3.2).

The optimum is broad — L30/C13 and L32/C12 are within noise of L28/C15 — which
is itself the finding: what matters is moving *off* 26 @ 5, not the exact stop.
Alpha mode was left on 5-bit luma at the default tier here, because the photographic
corpus that chose the rebalance contains no alpha and cannot speak to it. §11.3 later
measured the alpha rows directly and moved them to `L 22 @ 4 / a·b 3 @ 3 / A 28 @ 3`.

### DC: 7/7/7 bits + decode-aware ±1 search
The encoder simulates the decoder's DC path (dequantize → clamp → gamma) over
the 27-candidate ±1 neighborhood and keeps the code triple whose *decoded*
color is closest to the clip-mapped target. Zero wire cost, ~10 µs.
**[v0.6: solid blue ΔE00 7.75 → 0.36]**

### Rejected audio techniques (with reasons)
- **Vector quantization (CELP/TwinVQ):** **measured** — a 256-codeword 2D VQ
  on chroma pairs beats scalar 4+4-bit µ-law by 3.52 dB MSE at equal
  bits/pair (`mise run train:tables`). Rejected anyway: the perceptual companding
  sweep shows scalar quantization is not the quality bottleneck at 32 B (the
  MSE-optimal *scalar* table bought only −0.17% ΔE00), and VQ costs trained
  codebook tables in every decoder, encode-side search, and a much larger
  cross-language bit-exactness surface. Reopen only if a future format
  revision is chasing single-digit-percent gains and has spent the cheaper
  levers first.
- **ADPCM / predictive coding:** the DCT already decorrelates;
  inter-coefficient prediction gains ≈ 0. (The image-domain prediction that
  *does* pay is chroma-from-luma — see roadmap.)
- **MDCT / lapped transforms:** exist to cancel block boundaries; there are no
  blocks.
- **Dither / noise shaping:** determinism is a hard requirement, the blurred
  end-use masks banding, and v0.5's "banding" was mis-sized chroma scales, not
  missing dither.

## Aspect, alpha, gamut

### 8-bit log₂ aspect, range 1:16–16:1
Max ratio error ~1.09% (vs ThumbHash's 3-bit ~7%). ±4 log₂ covers photographic
practice; beyond-range panoramas clamp gracefully to 16:1. Symmetric about 1:1
(byte 128); portrait/landscape mirror symmetry is validator-enforced.

### Tier scaling by bit-shift of the rounded base
`(w<<level, h<<level)` for `level = renderLevel(tier)` — never re-derive
`round(32·2^level/ratio)`; the two disagree (at level 1, round(64/3)=21 vs
round(32/3)<<1=22) and encoder/decoder grids MUST match or reconstruction
desynchronizes. Shifting by the raw tier code instead of by the level is the
same bug one step earlier: codes 0 and 1 share level 0.

### Alpha: composite-over-average + separate channel
Transparent pixels composite over the alpha-weighted average OKLAB (keeps the
color channels clean of transparency edges — inherited from ThumbHash), and
alpha is its own DCT channel (DC 5 b + scale 4 b + the row's alpha AC at 3 b —
16 / 28 / 112 / 448 / 1792 for codes 0–4). Funded mostly out of chroma — a/b 15→3,
L 28→22 — so the default tier stays 32 bytes.
`hasAlpha` = any pixel α<255: exact and predictable; a threshold would be equally
arbitrary and produce input-dependent surprises.

### Multi-gamut encode / display-gamut decode, canonical tone map
OKLAB coordinates are absolute → no gamut flag. Out-of-hull colors clip
relative-colorimetrically per channel in the *output* gamut — desaturating
alternatives (constant-L clamp, lightness-blended soft clamp) rendered
wide-gamut solids visibly washed out **[v0.6, Change 7]**. BT.2020 PQ input
tone-maps through the canonical Reinhard operator (§5.3) — pinned normative
because an implementation-defined tone map would break byte-identical
encoding.

## Image-codec techniques (the AVIF/JXL audit)

| Technique | Verdict for v1 |
|---|---|
| Chroma-from-luma (AVIF CfL, JXL) | **Roadmap v0.8.** At LQIP scale chroma often tracks luma; predicting a/b AC as α·L_AC + residual could cut chroma bits. Structural wire change. |
| Adaptive/spatial quantization (JXL quant maps) | **Rejected:** needs per-region signaling; nothing to signal at 32 B. |
| Frequency-weighted quant matrices (JPEG/JXL) | **= the scalefactor-band experiment** (one mechanism, two framings): −0.20% (t0) / −0.52% (t1) — direction real, below threshold. |
| DC prediction | **N/A:** one global DC. |
| Directional intra prediction | **N/A:** no blocks. |
| Entropy coding (ANS/CABAC) | **Rejected at the default tier / roadmap codes 3–4** (see Architecture). |
| Progressive / embedded refinement | **Roadmap v0.8**; the capped-decode experiment bounds the value (t1@t0-size −20% ΔE00 vs native t0). |
| XYB color space | **Rejected** in favor of OKLAB (see Signal path). |
| Wavelets (JPEG2000) | **Rejected at the default tier;** reopen at code 4 only if codes 3–4 survive their positioning question. |
| Gaussian-splat / learned bases | **Rejected:** training dependency, no zero-dep decode. |

## Evaluation methodology decisions
- **CIEDE2000 primary, SSIMULACRA2/Butteraugli/DSSIM as guards:** color
  accuracy dominates perceived placeholder quality (structure is destroyed by
  design); ΔE00 is structure-blind, so every sweep decision requires guard
  non-regression. The tier-precision sweep shows the guards doing real work —
  variants that look near-neutral on ΔE00 fail hard on SSIMULACRA2.
- **Ringing and spurious detail as the artifact pair, reported not gated:** all
  four metrics above are *aggregate fidelity* scores, and none separates a
  placeholder that is uniformly a little off from one that rings and stripes.
  The two locally-computed metrics do, and each is built on one falsifiable
  property asserted in CI — a blur scores exactly zero for ringing, the ideal
  low-pass scores exactly zero for spurious detail. They are opt-in per sweep
  and gate nothing by default: a taper is *expected* to trade fidelity for
  artifacts, and gating would hide the exchange rate rather than measure it
  (`EXPERIMENTS.md` §12).
- **Display-resolution reference (512 px cap), browser-gamma upscale primary:**
  placeholders are judged at display size as a browser renders them
  (gamma-space smooth filtering); linear-light Lanczos is co-supported as the
  signal-fidelity view. Both sides composite over a defined backdrop before
  scoring; a blurred "as-rendered" metric set models blur-up presentation.
- **Paired statistics for release A/Bs:** per-format bootstrap CIs are
  *unpaired* — they carry the corpus's image-to-image spread (ΔE00 ranges ~1 to
  ~30), which swamps the difference between two builds of one format. The
  v0.6-vs-v1 holdout CIs are [10.25, 12.39] and [10.30, 12.45]: apparently
  identical formats. Differencing per image first gives [+0.029, +0.078] on the
  same data — ~40× tighter and excluding zero. Version comparison is the only
  controlled experiment here (same images, same scoring, one variable), so it
  reports paired deltas with a sign test; cross-format runs compare different
  formats at different byte costs and correctly do not.
- **Tune/holdout split:** the v0.6 constants were tuned on the evaluation
  corpus. The split immediately quantified the damage: mean ΔE00 6.48
  (CI 4.6–8.4) on the tune split vs **11.36 (CI 10.3–12.5) on the
  never-tuned holdout**. All v1 experiments tune on `tune` and validate on
  `holdout` under the pre-registered ≥3%-with-guards rule.

## Future work / open questions
Explicitly unresolved, so nothing evaluated-in-thought silently disappears:
1. ~~**Chroma-from-luma**~~ — **refuted in v0.7** (`EXPERIMENTS.md` §7.10).
   Built as a signalled per-channel least-squares gain and measured at every
   tier; it does not pay at any of them. Listed here as "the largest expected
   v0.8 win" until it was run, and kept struck through rather than deleted so
   the prediction can be read against the outcome.
2. ~~**Alpha-mode default-tier layout**~~ — **resolved in v0.7** (`EXPERIMENTS.md`
   §11.3). It got its own corpus and sweep, and the answer was not the
   arithmetic's `L 22 @ 4, a/b 14 @ 3`. The binding constraint was not the
   luma/chroma split at all: the *alpha channel* had five AC coefficients,
   inherited from v0.6 and never measured, and five cannot describe a
   silhouette. Code 1 now carries `L 22 @ 4, a/b 3 @ 3, A 28 @ 3`, worth
   −16.2% mean ΔE00 on a never-tuned alpha holdout with every guard improving.
   Still open: codes 3–4 alpha, inherited from the code-2 measurement rather
   than measured directly.
3. ~~**Code 3–4 positioning**~~ — **resolved in v0.7 by repositioning them**
   (`README.md` §14.1). Size-matched WebP overtakes code 3 and AVIF/WebP/JPEG
   beat code 4; entropy coding would recover ~4% of a 20–40% gap and would
   cost the O(1) length check that is the format's validity check. The spec
   now states that codes 3–4 are kept for their operational properties — no
   codec dependency, no decoder CVE surface, byte-exact reproducibility, one
   code path from 21 B to 1.6 kB — and makes no rate–distortion claim for
   them.
4. **Entropy-coded AC at codes 3–4** — sized by that same R-D gap.
5. **Embedded/progressive tiers** — interleave AC by priority so a tier-t hash
   is a prefix of tier-t+1; capped decode bounds the value at −20% ΔE00 for
   t1-at-t0-size.
6. **Scalefactor bands / quant matrices** — real but small (−0.52% at t1);
   becomes worth its signaling cost only alongside entropy coding.
7. **a/b scale field-width swap (6b/5b)** — wire-fixed, unsweepable today; the
   range-asymmetry proxy suggests the current allocation is right.
8. **Linear-light vs OKLAB DC averaging** — needs a Rust-side averaging knob;
   perceptual-average argument currently carries the decision.
9. **Wavelet/alternative bases at code 4** — only if codes 3–4 survive.
10. **Per-image adaptive selection with signaling** — only alongside entropy
    coding.
11. **Perceptual validation** — every conclusion here is metric-based; a small
    human study of blurred placeholders would anchor the metric choices. v0.7
    sharpened the case rather than weakening it: `EXPERIMENTS.md` §11.12
    records a candidate that was statistically significant on one tune corpus,
    independently corroborated on a second, and still failed out of sample.
    Metrics agreeing with each other is not the same as metrics being right.
12. **Reclaiming the 27th luma coefficient** — the default tier pays ~0.45% holdout ΔE00
    (and a guard-failing 1.18% SSIMULACRA2) for the descriptor byte. A narrower
    scale field or the reserved bit could fund the coefficient back; the
    measurement above sizes the prize. Below the retune threshold, so it rides
    with the next wire change rather than motivating one.
13. **Smartphone-source photographs** — sensor noise, motion blur, on-camera
    flash and heavy JPEG history. Both photographic corpora are professional
    captures, which is not what a real placeholder pipeline ingests.
14. **The corpus mix is a choice, not a measurement.** The alpha allocation of
    §11.3 was picked to protect mostly-opaque images precisely because the
    ΔE00-optimal point depended on this corpus being three-quarters
    transparent. Any future corpus change should re-ask that question rather
    than inherit the answer.
