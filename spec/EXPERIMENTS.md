# ChromaHash Design Experiments

A log of designs that were *built and measured*, and of the ones that have not
been tried yet. [`RATIONALE.md`](RATIONALE.md) records why the shipped v1
constants are what they are; this file is the workbench behind it, including the
results that argue against them.

Everything here is measured with `tools/comparison` on the photographic corpus:
CIEDE2000 (ΔE00, lower better) primary, SSIMULACRA2 (higher better) /
Butteraugli (lower better) / DSSIM (lower better) as guards, browser-gamma
upscale to a 512 px display-resolution reference. **Tune split = 31 photos,
holdout split = 32 (Kodak24 + 8 held-out curated).** Candidates are chosen on
tune and validated on holdout, per the pre-registered rule in `RATIONALE.md`.

> **Corpus revision (2026-08).** Every number below was re-measured on a
> corpus extended from 26 to 39 curated photographs, after an audit found the
> old set had no interior illuminant, no achromatic photograph, no high-key
> product framing and exactly one dark skin tone (in holdout). §9 records the
> audit, the additions and what moved. Round-1 and round-2 conclusions survive;
> two effect sizes do not, and are corrected in place.

> **Corpus re-source (2026-09).** The photographic corpus was then re-sourced
> from Wikimedia Commons for licensing reasons (`85f6af3`), which moved every
> photographic number below. §1–§11 were re-measured against it. **§9.5 records
> what moved, what was not re-measured, and which tables are views onto sweeps
> rather than transcriptions of them** — read it before quoting a figure from
> this file. The alpha and graphic corpora were untouched by the re-source.

> **Tier numbering.** Every section below was written before the tier codes
> were reordered by quality, and uses the *old* numbering, where code 0 was the
> 32-byte default. The shipped codes are `0` = compact (21 B), `1` = default
> (32 B), `2` = 108 B, `3` = 411 B, `4` = 1623 B. So a table that says "tier 0"
> means the 32-byte default (code 1 today), "tier 1" means 108 B (code 2), and
> so on; the *byte* anchors quoted alongside them are unchanged and unambiguous.
> §11.14 is the one table restated in the shipped codes, because it is the
> current cross-format record rather than the log of a finished round.
>
> The **compact tier** is the one row that mapping does not cover, because it was
> not on the old ladder at all. §8.1 and §11 propose it at code `4`, taken from the
> then-reserved `4..=7` range; `f6417d3` rejected that placement and shipped it at
> code **0** (`RATIONALE.md`, "Tier codes ordered by quality"). Read every "tier
> code 4" below as the proposal, never as what ships.

> **Status: §8 has shipped.** The recipe this file converged on is now
> `Tunables::DEFAULT` — the tier-0 layout `L 28 @ 4 / C 15 @ 3`, the selection
> weights `aniso = 1.2` / `sel_hv = 0.15`, and the encoder-only `scale_fit = 2`
> / `ac_nearest = 1`. See §10 for what adopting it took, including the integer
> reformulation of the selection order that §8.1 listed as its blocker. Rows
> labelled **shipped** in the tables below mean the *pre-adoption* v0.6-derived
> constants, which is what they were measured against; §8.3 is the delta the
> format actually moved by.
>
> Everything else these experiments introduce — `refine_*`, the header field
> widths, `cfl_*`, `synth_*`, `interleave`, `trunc_bytes` — still defaults to
> the shipped behaviour and remains sweep-only.
>
> §1–§6 are the byte-budget study (round 1). §7 builds and measures every item
> §5 listed as untried. §8 is the recipe that survived, and its parameters. §9
> is the corpus audit that every number was re-measured against. §10 records
> the adoption.

## 0. What made these measurements possible

The v1 length formula is derived from the AC layout, so resizing the layout
resizes the hash — the format has always been able to express any byte budget,
but nothing could decode one. Four tooling changes opened that surface:

| Change | Why |
|---|---|
| `ChromaHash::from_bytes_tuned` (used by `encode_stdin`) | `from_bytes` validated length against the **shipped** layout, so any length-changing sweep encoded fine and then failed to decode. Every sweep before this one had to hold the byte count fixed — which is why no byte-budget question had ever been asked. |
| `sweep.js` records per-image ΔE00 | Enables paired statistics and per-image (oracle) analyses. |
| `tools/comparison/src/rd-budget.ts` | Cross-format R-D at arbitrary byte budgets on the **same corpus split** as `mise run sweep`, so a ladder row and a ThumbHash row are directly comparable. |
| `src/cfl-probe.ts`, `src/coeff-stats.ts` | Size two roadmap items (chroma-from-luma, entropy coding) from corpus statistics instead of by assertion. |

## 1. The rate–distortion curve of v0.7

The constants that ship today (post-§10 adoption), AC layout resized to each
budget at the shipped 26:9 luma:chroma count ratio and 5 b luma / 4 b chroma
precision (`sweeps/budget-ladder.json`, both splits). Points ≤ 80 B render at
the default tier's raster, ≥ 108 B at the next one up — that is the tier's
*raster*, not its byte budget, which the layout override sets directly.

Both splits were re-measured together for v0.7. §4.5 and §7.12 quote an
**earlier** ladder, taken against the pre-adoption v0.6-derived constants, and
keep those numbers: they are what the round-1 and round-2 candidates were
measured against.

| Bytes | 10 | 12 | 14 | 16 | 18 | 21 | 24 | 28 | **32** | 40 | 48 | 64 | 80 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ΔE00 tune | 15.51 | 14.17 | 13.59 | 13.19 | 13.05 | 12.57 | 12.16 | 11.92 | **11.65** | 11.25 | 10.97 | 10.48 | 10.13 |
| ΔE00 holdout | 14.96 | 13.88 | 13.49 | 13.00 | 12.75 | 12.49 | 12.14 | 11.85 | **11.54** | 11.17 | 10.81 | 10.36 | 9.98 |

| Bytes | **108** | 129 | 161 | 189 | 246 | 310 | **411** | 512 | 767 | 1017 | **1623** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ΔE00 tune | **9.67** | 9.40 | 9.06 | 8.81 | 8.42 | 8.13 | **7.83** | 7.62 | 7.24 | 7.03 | **6.75** |
| ΔE00 holdout | **9.52** | 9.23 | 8.93 | 8.73 | 8.39 | 8.09 | **7.78** | 7.56 | 7.20 | 7.02 | **6.77** |

Marginal value collapses far faster than 1/bytes (tune split):

| Interval | 16→32 B | 32→64 B | 64→129 B | 129→246 B | 246→512 B | 512→1017 B |
|---|---|---|---|---|---|---|
| ΔE00 gained per byte | 0.096 | 0.037 | 0.0166 | 0.0084 | 0.0030 | 0.00118 |

Each doubling of the budget buys 36–51% of what the previous one did. The five
shipped tier anchors are five points on this one smooth curve; there is nothing
special about 21/32/108/411/1623 B beyond ×4 arithmetic above the default.

## 2. Cross-format at equal bytes, same corpus, same scoring

> **Superseded by §11.14.** Every ChromaHash row below was measured with a
> layout synthesized to fill the budget at 5 b/4 b — the pre-v0.7 shape — so it
> understates the shipped format. §11.14 re-measures this table with the shipped
> tiers at the shipped anchors. The competitor rows and the shape of the
> conclusions are unchanged.

`rd-budget`, **tune split**. Bold marks the leader in a column within a byte
neighbourhood.

| Bytes | Format | ΔE00 | SSIM2 | Butter |
|---|---|---|---|---|
| 11.9 | RawRGB565 | 14.00 | −346 | 43.9 |
| 12.0 | BlurHash 2×2 | 16.97 | −379 | 49.6 |
| 12.0 | **ChromaHash** | **13.79** | **−345** | **41.8** |
| 16.0 | **ChromaHash** | **12.35** | **−311** | **35.2** |
| 20.9 | **ThumbHash** | 12.04 | **−283** | **32.1** |
| 21.0 | ChromaHash, shipped shape | **11.70** | −301 | 34.4 |
| 21.0 | ChromaHash, retuned (§4.3) | **11.02** | **−280** | **31.5** |
| 22.0 | BlurHash 3×3 | 14.87 | −344 | 41.8 |
| 22.1 | RawRGB565 | 12.31 | −318 | 37.3 |
| 24.0 | **ChromaHash** | **11.14** | **−285** | **31.7** |
| 25.4 | RawRGB565 | 11.88 | −307 | 36.1 |
| 32.0 | **ChromaHash** | **10.43** | **−268** | **29.2** |
| 36.0 | BlurHash 4×4 | 13.96 | −325 | 39.2 |
| 46.9 | RawRGB565 | 10.66 | −282 | 32.0 |
| 48.0 | WebP | 12.71 | −364 | 34.2 |
| 48.0 | **ChromaHash** | **9.73** | **−243** | **27.2** |
| 63.6 | WebP | 11.31 | −250 | 29.3 |
| 64.0 | **ChromaHash** | **9.32** | **−219** | **25.4** |
| 79.9 | WebP | 10.31 | −202 | 25.5 |
| 80.0 | **ChromaHash** | **8.98** | −202 | 24.5 |
| 84.0 | lqip-modern r16 | 10.27 | **−168** | **24.1** |
| 107.0 | WebP | 9.28 | −155 | **23.2** |
| 108.0 | **ChromaHash** | **8.56** | −169 | 23.3 |
| 129.4 | lqip-modern r24 | 9.35 | **−117** | **21.7** |
| 188.6 | **WebP** | **7.87** | **−88** | **18.5** |
| 193.0 | ChromaHash | 7.87 | −115 | 21.1 |
| 252.6 | lqip-modern r48 | 7.32 | **−62** | **15.8** |
| 361.9 | RawRGB565 | 7.53 | −129 | 21.9 |
| 404.3 | **WebP** | **6.37** | **−50** | **14.0** |
| 414.0 | ChromaHash | 7.09 | −77 | 18.5 |
| 1500.7 | WebP | 5.05 | −34 | 11.6 |
| 1563.2 | **RawRGB565** | **5.80** | −59 | 16.6 |
| 1584.1 | **AVIF** | **4.54** | **−33** | **11.4** |
| 1623.0 | ChromaHash | 6.26 | −64 | 14.9 |

Holdout confirms the shape (ThumbHash 21.1 B: ΔE00 12.85 / SSIM2 −326 /
Butteraugli 31.8; ChromaHash 32 B: 11.55 / −305 / 29.3; WebP 405.7 B: 7.29 /
−62 / 14.0 vs ChromaHash 414 B: 7.79 / −77 / 18.0).

Three things this says that `RATIONALE.md` does not:

1. **ChromaHash wins colour and loses structure, everywhere.** From ~80 B up,
   lqip-modern and WebP beat it on SSIMULACRA2 *and* Butteraugli while losing on
   ΔE00. ΔE00 is the format's primary metric and the guards are only ever
   checked *within* a sweep, never across formats — so this asymmetry has never
   been scored. Every cross-format claim in `RATIONALE.md` is ΔE00-only.
2. **ThumbHash is not beaten at its own size by the shipped constants.** At
   21 B the shipped-shape layout wins ΔE00 by 2.8% but loses SSIMULACRA2 by 19
   points and Butteraugli by 7.2%. Only the retuned low-budget allocation
   (§4.3) beats ThumbHash on all four.
3. **Tier 3 loses to raw pixels.** At ~1.6 kB, RGB565 pixels with no coding at
   all score 5.80 against tier 3's 6.26. The coding machinery stops paying for
   itself somewhere between 411 B and 1623 B.

> **Round 1's readings of round 1's table, and the third has since inverted.**
> These three are not re-derived on the Wikimedia corpus — §2 is not re-run —
> and the figures in them are the retired set's. Claim 1 survives and §11.14
> restates it at the shipped anchors. Claim 2's current form is in §4.3, where
> the shipped shape still wins ΔE00 and still loses SSIMULACRA2 and Butteraugli.
> **Claim 3 no longer holds**: measured now, tier 3 is **6.73** against RGB565's
> **6.96**, so the coding machinery does still pay for itself at the top of the
> ladder. What beats tier 3 at ~1.6 kB is a real codec — WebP 5.79, JPEG 5.93,
> AVIF 5.46 — which is §11.14's finding rather than this one.

## 3. The optimal budget

> Built on §2 and superseded with it by **§11.14** — the crossovers below are
> the round-1 record. The shape survives; the ChromaHash side of every crossover
> moved with §10's adoption.

| Region | What is true there |
|---|---|
| < 12 B | Below the format's own floor: 54 bits (6.75 B) of descriptor + aspect + DC + scales before a single AC coefficient. |
| 12–20 B | ChromaHash beats BlurHash and raw pixels; ThumbHash not yet reachable. |
| **20–32 B** | **ThumbHash's budget.** With the retuned allocation ChromaHash beats it on ΔE00, SSIMULACRA2 and Butteraugli simultaneously. No real codec exists here. WebP's floor is ~48 B, which the current lineup
reproduces (`CODEC_FLOOR_BYTES` in `rd/lineup.ts` declares the same 48 B, and
470 B for AVIF); the mozjpeg and AVIF floors quoted in earlier rounds are not
reproducible from the sweeps now on disk, which carry no AVIF row below 1.5 kB
and no mozjpeg at all. |
| **32–110 B** | **The format's strongest region.** It leads every LQIP and every size-matched codec on ΔE00 by 8–25%, and still leads or ties the guards up to ~64 B. |
| 110–190 B | Still leads ΔE00; already behind WebP and lqip-modern on SSIMULACRA2 and Butteraugli. |
| ~190 B | WebP draws level on ΔE00 (7.87 vs 7.87) while winning all three guards. |
| 190–400 B | WebP takes the ΔE00 lead outright (6.37 vs 7.09 at ~410 B). |
| > 400 B | Real codecs lead by 20–40%; by 1.6 kB even uncoded RGB565 wins. |

**Conclusion.** The defensible operating range is **~20–110 B** — tier 0 and
tier 1. Tier 2 is marginal, tier 3 is indefensible as a rate–distortion claim
(keep it, if at all, on the operational argument `RATIONALE.md` already makes).
The single most valuable missing budget is **21–24 B**: it is ThumbHash's size,
it is inside the codec-free zone, and the format cannot express it at all
because the default tier is fixed at 32 B. Tier codes `4..=7` were reserved and
rejected at the time — a compact tier is the cheapest place to put it. (It
shipped at code 0 instead; the codes were ordered by quality before release —
`RATIONALE.md`, "Tier codes ordered by quality".)

The prefix is what makes small budgets expensive: 54 bits is 21% of a 32 B hash
and **32% of a 21 B hash**.

## 4. Designs attempted this round

### 4.1 Doubling the render raster buys nothing — wherever the raster is legal

A tier does two things: ×4 the coefficient count and ×2 the render edge. Hold
byte count *and* coefficient count fixed, vary only the raster
(`sweeps/render-raster.json`, tune):

| Coefficients (bytes) | small raster | native tier raster | Δ |
|---|---|---|---|
| 104 L / 36 C (108 B) | 9.665 @32 px | 9.667 @64 px | −0.02% |
| 416 L / 144 C (411 B) | 7.900 @32 px | 7.828 @128 px | 0.92% |
| 416 L / 144 C (411 B) @64 px | 7.830 @64 px | 7.828 @128 px | 0.02% |
| 1664 L / 576 C (1623 B) | 6.745 @64 px | 6.726 @256 px | 0.29% |

(The "native tier raster" column names the tier's own render. The shipped-tier
arms are scored through the harness's ≤100 px encoder input, so t2 and t3 render
at 100×67 rather than 128×84 and 256×168 — which is what §7.14 measures around.
The tier's own raster is nonetheless what governs the selection below.)

**The raster is inert wherever it is legal, and only there** — and the binding
constraint is at *encode*, not decode. `SelectionOrder` builds its candidate set
as every `(cx, cy)` in `[0, W) × [0, H)` for the encoding tier's own render, so
a frequency outside that box is never a candidate in the first place and
`prepare_channel`'s `cx >= w || cy >= h` test has nothing left to drop. The box
is *per-axis* and the short edge is what binds: on a 3:2 photograph a 32 px
raster is 32×21, and the ℓ2 ball of K luma coefficients reaches an index of
about √(4K/π). The four rows split exactly on that test — 11.5 against 21 and
23.0 against 42 clear it and cost nothing (−0.02%, 0.02%); 23.0 against 21 and
46.0 against 42 do not, and the coefficients the encoder is forced to substitute
for the ones the box denies it cost 0.92% and 0.29%.

So the conclusion stands, with its scope now stated: all of the measured
quality in the tier ladder comes from coefficient count, and the render-edge
doubling is a convenience for the consumer rather than a fidelity mechanism.
What it satisfies is a correctness bound, not a quality one — and below that
bound the doubling is not free: it is returning the coefficients a smaller
candidate box had denied the encoder.

Round 1 read this table as "if anything the *smaller* raster scores better",
which its numbers supported (−0.04% / −0.05% / −0.34%, all negative). That
reading was an artifact of a corpus insensitive enough that the forced
substitution did not show. The third row is the control that separates the two
explanations — same counts, same baseline, a raster that clears the bound —
and it was in the sweep the whole time, never quoted.

### 4.2 Count vs precision: the shipped answer is right at 108 B and wrong at 32 B

`RATIONALE.md` concludes "at these bitrates more coefficients beat finer
coefficients" from an experiment that only tested *finer* coefficients, only at
tier 1. Testing both directions at both budgets (`sweeps/allocation-grid.json`,
29 allocations of the same 202-bit AC budget, tune split — because tier *m*
scales counts by 4^m at constant width, one base allocation lands at both 32 B
and 108 B):

| Allocation | 32 B ΔE00 | 108 B ΔE00 |
|---|---|---|
| L26@5 C9@4 — **shipped** | 11.655 | **9.721** |
| L28@4 C15@3 | 11.546 (−0.9%) | 9.913 (+2.0%) |
| L38@4 C8@3 | **11.458** (−1.7%) | 9.927 (+2.1%) |
| L28@4 C11@4 | 11.542 (−1.0%) | 9.767 (+0.5%) |
| L44@3 C11@3 | 11.660 (+0.0%) | 10.721 (+10%) |
| L29@5 C9@3 | 11.608 (−0.4%) | 9.833 (+1.2%) |

The optimum moves with the budget. Sweeping six precision families across five
budgets (`sweeps/precision-by-budget.json`, tune) gives the trend cleanly:

| Budget | 16 B | 21 B | 24 B | 32 B | 48 B | 80 B | 108 B |
|---|---|---|---|---|---|---|---|
| best luma bits | **3** | **3** | **3** | **4** | **4** | **4** | **5** |
| best ΔE00 | 12.91 | 12.27 | 12.01 | 11.46 | 10.86 | 10.14 | 9.72 |
| shipped-shape ΔE00 | 13.44 | 12.64 | 12.29 | 11.65 | 10.96 | 10.16 | 9.72 |
| gain | −3.9% | −2.9% | −2.2% | −1.7% | −0.9% | −0.2% | 0% |

(`precision-by-budget` sweeps 16/21/24/48/80 B; the 32 B and 108 B columns are
the same six families read off `allocation-grid`, which covers those two
budgets. The two sweeps share an incumbent and agree on it to the digit.)

Chroma wants one bit less than luma where it can: at 32 B, 48 B and 108 B the
best allocation is 4/3, 4/3 and 5/4. It cannot at 16–24 B, where luma is already
on the 3-bit floor and chroma has nowhere below to go, and it does not at 80 B,
where 4/4 (10.139) edges out 4/3 (10.209) — the one budget measured where
chroma wants the same width as luma rather than one less.

**This contradicts the format's central tier axiom.** "Count ×4^tier at constant
precision" is right at 108 B and wrong below it: at 32 B the shipped layout
spends a bit per luma coefficient that would buy more as a whole extra
coefficient, and the penalty grows as the budget shrinks — −1.7% at 32 B, −2.2%
at 24 B, −3.9% at 16 B. The axiom was never wrong where it was tested; it was
only ever tested at tier 1, which is the one budget here where it holds.

The gap closes smoothly rather than at a threshold (−0.9% at 48 B, −0.2% at
80 B, 0% at 108 B), so "above ~80 B" is a description of where the effect stops
mattering, not a boundary in the format.

### 4.3 The low-budget allocation, retuned

Best found at 21 B against ThumbHash's own 21 B
(`sweeps/thumbhash-headtohead.json`; "+stack" = §4.4 encoder levers + aniso=1.2):

**Tune split**

| Layout | Bytes | ΔE00 | SSIM2 | Butter | DSSIM |
|---|---|---|---|---|---|
| ThumbHash | 21.0 | 13.171 | −380.6 | 33.16 | 0.2723 |
| shipped shape L13@5 C6@4 | 21 | 12.702 | −399.2 | 35.17 | 0.2691 |
| L26@3 C6@3 | 21 | 12.224 | −360.3 | 31.95 | 0.2682 |
| L19@4 C6@3 | 21 | 12.308 | −375.3 | 32.38 | 0.2675 |
| **L19@4 C6@3 + stack** | 21 | **12.181** | **−373.0** | **32.19** | **0.2664** |
| L22@4 C8@3 + stack | 24 | 11.983 | −364.1 | 31.55 | 0.2654 |

**Holdout split**

| Layout | Bytes | ΔE00 | SSIM2 | Butter | DSSIM |
|---|---|---|---|---|---|
| ThumbHash | 21.0 | 12.807 | −337.2 | 30.98 | 0.2647 |
| shipped shape L13@5 C6@4 | 21 | 12.726 | −361.0 | 32.49 | 0.2656 |
| **L26@3 C6@3 + stack** | 21 | **12.136** | **−321.6** | **29.57** | **0.2641** |
| L22@3 C8@3 + stack | 21 | 12.120 | −332.2 | 30.51 | 0.2642 |
| L19@4 C6@3 + stack | 21 | 12.203 | −335.0 | 30.03 | 0.2641 |
| L22@4 C8@3 + stack | 24 | 11.920 | −326.4 | 29.44 | 0.2635 |

A 21-byte ChromaHash that beats ThumbHash on **all four** metrics exists and
validates on holdout (−5.2% ΔE00, +16 SSIMULACRA2, −4.6% Butteraugli, −0.2%
DSSIM). All three of the stacked 21 B layouts do, not just the bolded one. The
format has no way to encode any of them.

Both ThumbHash rows are the npm encoder rather than a sweep arm, so they are
transcribed from `rd-budget` and not checked by `verify:experiments` against
this sweep — the binding says as much. They had been carrying figures from a
corpus two revisions back, which is what made this table appear to contradict
§11.14; it now agrees with it to the digit.

Note that "+stack" here is the three-knob form — `aniso`, `scale_fit`,
`ac_nearest`, without `sel_hv` — so these rows sit on a different base from
§11.10's, which is the adopted default. The two orderings of `L19@4 C6@3` and
`L26@3 C6@3` differ for that reason and not because either is wrong: the
compact-tier pick turns on `sel_hv`, which §11.10 has and this table does not.

### 4.4 Encoder-only levers (zero wire cost, decoder untouched)

Two defects in the shipped encoder, both free to fix:

* **`scale_fit`** — the encoder normalizes AC coefficients by the *unquantized*
  `max|AC|`, while the decoder dequantizes with the rounded scale code. Mode 1
  normalizes by the dequantized scale (one line, no extra compute); mode 2
  searches every scale code for minimum reconstruction SSE (~2^bits quantization
  passes per channel).
* **`ac_nearest`** — the quantizer rounds in the companded domain, which is not
  the code whose *reconstruction* is nearest. A ±2 neighbourhood search fixes it.

`sweeps/encoder-compute.json`, tune split, against the same layout without them:

| Layout | shipped | ac_nearest | scale_fit=1 | scale_fit=2 | fit2 + nearest |
|---|---|---|---|---|---|
| 21 B | 12.702 | — | — | — | 12.679 (−0.18%) |
| 32 B | 11.655 | 11.653 (−0.02%) | 11.638 (−0.14%) | 11.619 (−0.30%) | 11.619 (−0.30%) |
| 108 B | 9.721 | — | — | — | 9.667 (−0.56%) |
| 411 B | 7.908 | — | — | — | 7.826 (−1.04%) |

`ac_nearest` alone is worth 0.02% — µ-law's compressed-domain rounding is
already near reconstruction-optimal, an independent confirmation of the
companding choice. **The scale mismatch is the real defect**, and the gain grows
with tier because more coefficients share one scale: −0.18% at 21 B to −1.04% at
411 B.

Round 1 read mode 1 as capturing nearly all of the mode-2 gain, on numbers that
put the free fix (−0.51%) *ahead* of the search (−0.40%). That ordering does not
survive: mode 1 is −0.14% and mode 2 −0.30%, so the search is worth about twice
the one-line fix rather than slightly less than it. The free fix is still free
and still points the right way; it is no longer a substitute for the search, and
`scale_fit = 2` is what §8.2 adopts.

### 4.5 Stacking, and the holdout verdict

`sweeps/holdout-candidates.json`, **holdout split**, incumbent = shipped 32 B.
"stack" = `aniso=1.2 scale_fit=2 ac_nearest=1`.

| Variant | Bytes | ΔE00 | Δ% | SSIM2 | Butter | DSSIM | Guards |
|---|---|---|---|---|---|---|---|
| shipped | 32 | 11.735 | — | −318.4 | 28.66 | 0.2630 | (base) |
| L38@4 C8@3 | 32 | 11.577 | −1.35% | −293.7 | 27.18 | 0.2628 | ok |
| L28@4 C15@3 | 32 | 11.490 | −2.09% | −314.3 | 28.29 | 0.2628 | ok |
| shipped + stack | 32 | 11.563 | −1.46% | −311.1 | 28.33 | 0.2628 | ok |
| L38@4 C8@3 + stack | 32 | 11.464 | −2.31% | −287.8 | 27.07 | 0.2624 | ok |
| **L28@4 C15@3 + stack** | 32 | **11.340** | **−3.37%** | −308.1 | 28.10 | 0.2624 | **ok** |
| tier 1 shipped | 108 | 9.696 | −17.38% | −184.9 | 23.00 | 0.2589 | ok |
| tier 1 + stack | 108 | 9.535 | −18.75% | −178.7 | 22.89 | 0.2583 | ok |

**−3.37% holdout ΔE00 with every guard improving clears the pre-registered ≥3%
retune threshold** — the first candidate in the project's history to do so. Two
caveats before it can enter the spec: `aniso` still needs the integer
reformulation `RATIONALE.md` flags, and a changed encoder changes every test
vector even though the decoder is untouched.

Applying the findings across the whole ladder
(`sweeps/budget-ladder-tuned.json`: per-budget luma precision from §4.2, chroma
one bit under luma, plus the stack):

| Bytes | 12 | 16 | 21 | 24 | 28 | 32 | 48 | 64 | 108 | 246 | 411 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tune, pre-adoption shipped | 13.79 | 12.35 | 11.70 | 11.14 | 10.80 | 10.43 | 9.73 | 9.32 | 8.57 | 7.67 | 7.09 |
| tune, tuned | 13.60 | 12.78 | 12.15 | 11.93 | 11.67 | 11.41 | 10.76 | 10.48 | 9.67 | 8.45 | 7.90 |
| tune Δ | −8.4% | −4.8% | −5.8% | −4.1% | −3.7% | −2.3% | −1.5% | −1.1% | −1.9% | −2.5% | −2.4% |
| holdout, pre-adoption shipped | 13.84 | 13.07 | 12.61 | 12.14 | 11.79 | 11.55 | 10.72 | 10.24 | 9.44 | 8.31 | 7.79 |
| holdout, tuned | 13.40 | 12.67 | 12.15 | 11.88 | 11.55 | 11.38 | 10.67 | 10.35 | 9.51 | 8.39 | 7.82 |
| holdout Δ | −4.0% | −3.3% | −4.0% | −2.9% | −2.7% | −2.7% | −1.9% | −1.0% | −1.9% | −1.9% | −2.1% |

The gain is largest exactly where the shipped constants were never checked. The
compact way to say it: **the retuned encoder reaches today's tier-0 quality in
28 bytes instead of 32** (tune 10.40 vs 10.43; holdout 11.47 vs 11.55) — a 12.5%
byte saving at equal quality, with no wire-format change beyond the layout
table.

### 4.6 Companding retune at the new allocation — no effect

µ_L=5 / µ_C=8 were locked against a 5 b / 4 b layout. Re-swept against the 4 b /
3 b winner (`sweeps/retune-32b.json`, tune): µ_L ∈ {3,4,6,8} spans 10.229–10.286
against 10.238 at µ_L=5; µ_C ∈ {5,6,12,16} spans 10.246–10.275. The plateau
`RATIONALE.md` reports survives the change of bit depth — µ-law is not the
binding constraint at any of these depths.

### 4.7 Per-image adaptive layout — sized, and small

The decoder reads the DC and scale fields before any AC, so encoder and decoder
could both derive a layout from them with **zero signaling**. Upper bound, from
per-image ΔE00 across the 29-allocation grid (tune):

| | 32 B | 108 B |
|---|---|---|
| shipped fixed layout | 11.655 | 9.721 |
| best single fixed layout | 11.458 | 9.707 |
| per-image **oracle** layout | 11.242 | 9.567 |
| oracle gain beyond the best fixed layout | −1.9% | −1.4% |

A perfect oracle over 29 layouts buys 1.4–1.9%; a header-derivable rule would
capture a fraction of that. Not worth a wire change.

That the oracle is worth *less* at 108 B than at 32 B is the same finding as
§4.2's: at 108 B the shipped allocation is already within 0.14% of the best
fixed one, so there is little for a per-image rule to recover. The room is at
the low budgets, where the fixed layout is furthest from right.

### 4.8 Chroma-from-luma — the roadmap's "largest expected win" is small

`cfl-probe`, tune split, 26 coefficients per channel with L and chroma sharing
one selection order so index *i* is the same (cx, cy) in all three channels:

* mean |ρ(a, L)| = 0.457, mean |ρ(b, L)| = 0.504
* after a **per-image least-squares** predictor — itself an oracle, since α
  would have to be signaled — residual energy is **71.5%** (a) and **63.2%** (b)
  (the one grayscale photograph in the split has an identically-zero `a` AC set,
  for which both statistics are 0/0; the probe now excludes such a channel
  instead of scoring it as ρ = 0, residual = 100%)

The sign of the correlation flips between images (−0.81 on `chroma-yellow-wall`,
+0.75 on `natural-building`), so a fixed gain is useless. A 24–38% energy
reduction is ≈0.2–0.35 bit/coefficient; at tier 0 that is ~4–6 bits across 18
chroma coefficients, against ~10 bits to signal two gains. **CfL does not pay at
tier 0.** Reopen at tier 2–3, where per-image gains amortize over hundreds of
coefficients.

### 4.9 Entropy headroom, measured

`coeff-stats`, tune split, shipped tier-0 layout, µ-law codes:

| | luma (5 b field) | chroma (4 b field) |
|---|---|---|
| zeroth-order entropy | 4.607 b | 3.855 b |
| entropy conditioned on selection index | 3.708 b | 3.495 b |

Whole tier-0 AC payload: 202 b fixed → **189.2 b** zeroth-order (−6.4%) →
**159.3 b** with a per-index context model (−21.1%). At 32 B that is 1.6 B of
headroom, or 2.6 more luma coefficients.

> **Corrected in §7.13.** Both figures are *in-sample* entropies of the corpus
> that produced them, and the 159.3 b context number does **not** survive
> out-of-sample scoring — 26+18 per-index histograms estimated from 31 images
> over a 31-symbol alphabet are mostly noise. Measured leave-one-image-out with
> a real adaptive coder, the achievable saving is **7.4%, not 21.1%**.

### 4.10 Selection-order headroom, measured

Luma AC energy captured by K=26 of the 200 lowest-frequency candidates (tune):

| Selection | energy captured |
|---|---|
| ℓ2-ball prefix (shipped) | 75.94% |
| best corpus-fixed 26 (trainable, zero signaling) | 77.26% — 5 of 26 slots differ |
| best per-image 26 (oracle) | 88.70% |

The trainable reorder is worth ~1.3 energy points, the same order as the −0.46%
ΔE00 the anisotropic weight achieves on this corpus (§11.5) — `aniso` is
capturing most of what a fully trained fixed order could. Per-image selection is
worth 12.8 points but needs signaling, which only pays alongside entropy coding.

Both headroom figures shrank when the corpus stopped being predominantly
outdoor landscape (§9), and the trainable one shrank again on the Wikimedia
re-source: 2.2 points, then 1.5, now **1.3**. A trained *fixed* order is worth
less exactly when the corpus's dominant orientation structure is less uniform,
and three corpora in a row have now said so with a smaller number each time.

## 5. Untried (as of round 1)

Every item below was subsequently built and measured — see §7 for the results
and §8 for what survived. Kept as written so the predictions can be scored
against the outcomes.

Ordered by expected value per unit of disruption. "Encoder" changes only how
bytes are chosen; "constants" changes the layout table; "wire" changes what a
decoder must understand.

### Encoder-only (no format change — but every test vector moves)

| # | Idea | Why it might pay | Cost |
|---|---|---|---|
| U1 | **Pixel-domain RDO.** Score candidate codes by decoded-*pixel* error instead of coefficient SSE. | The reconstruction passes through OKLAB → linear → per-channel gamut clip → gamma. Coefficient SSE is not that error, and clipping makes it **non-separable** — which is the one place the orthogonality argument for independent rounding genuinely fails. §4.4's coefficient-domain search already found 0.5–2%. | O(K·pixels) per pass |
| U2 | **Joint DC+AC search.** `select_dc_codes` optimizes the flat-colour target assuming the AC set is zero. With AC present a different DC can cancel clipping. | Same non-linearity, zero bits, and the existing DC search is proof the effect is real (v0.6: solid blue ΔE00 7.75 → 0.36). | 27× a cheap decode |
| U3 | **Clipping pre-compensation.** Amplitude that pushes a pixel out of the output gamut is discarded at decode; scaling those coefficients down before quantization trades unusable amplitude for resolution everywhere else. | Targets exactly the high-chroma images where ΔE00 is worst. | cheap |
| U4 | **Closed-loop residual re-projection.** Decode, take the residual against the source in OKLAB, re-project onto the *same* selected basis, requantize; 2–3 iterations. | Recovers signal the quantizer's own error re-introduces into the retained basis. | 2–3× encode |
| U5 | **Metric-targeted RDO** — optimize ΔE00 (or SSIMULACRA2) directly rather than SSE. | The format is judged on ΔE00; SSE is a proxy. | high, and invites metric overfitting |

### Constants-level (layout table only)

| # | Idea | Sizing |
|---|---|---|
| U6 | **Budget-dependent precision** — 3 b luma below 20 B, 4 b to ~56 B, 5 b above; chroma one bit under luma. | Measured (§4.2): −3.9% at 16 B, −1.7% at 32 B, −0.2% at 80 B, 0 at 108 B. Breaks the constant-precision tier axiom. |
| U7 | **Corpus-trained selection order**, generalizing `aniso`. | Measured headroom (§4.10): +1.3 energy points; `aniso=1.2` already captures most of it. |
| U8 | **Shrink the prefix.** 54 b is 21% of tier 0 and 32% of a 21 B hash. Aspect 8 b → 5 b (≈2.5% ratio error, still 3× better than ThumbHash); scales 6/6/5 b → 5/4/4 b with log-spaced codes; 1 reserved bit; 1 unused tier bit. | ~10 bits ≈ 2–3 extra luma coefficients at a small budget. **Untested** — the highest-value unmeasured item on this list. |
| U9 | **Derive the b scale from the a scale** instead of storing both. | 5 bits. Untested; `RATIONALE.md`'s range-asymmetry proxy suggests they are far from independent. |

### Wire-level

| # | Idea | Sizing |
|---|---|---|
| U10 | **A compact tier below 32 B** (tier codes 4–7 were reserved at the time). | Measured (§4.3): a 21 B layout beats ThumbHash on all four metrics, on holdout (−6.7% ΔE00). The highest-value structural gap. |
| U11 | **Entropy-coded AC with a per-index context model.** | Measured (§4.9): −22.3% of the AC payload in sample, 8.7% out of sample (§7.13). Costs the O(1) length check. |
| U12 | **Decoder-side detail synthesis** — deterministic, hash-seeded high-frequency texture added at render time. | Untested, and the only idea here that attacks the format's actual weakness: it loses SSIMULACRA2/DSSIM to WebP and lqip-modern at every budget above ~84 B while winning ΔE00. Costs zero bytes. Risk: it fabricates detail, which some callers will consider a bug rather than a feature. |
| U13 | **Per-image signaled selection.** | Measured (§4.10): +9 energy points, but only pays alongside U11. |
| U14 | **Chroma-from-luma.** | Measured (§4.8): does not pay at tier 0. Reopen at tier 2–3 only. |
| U15 | **Embedded/progressive tiers.** | Bounded at −20% ΔE00 by the capped-decode experiment in `RATIONALE.md`. |

### Evaluation, not format

| # | Idea |
|---|---|
| U16 | **Score cross-format runs against the guards.** Every cross-format claim in `RATIONALE.md` is ΔE00-only; §2 shows the guards tell a materially different story from ~84 B up. |
| U17 | **Content-pin the corpus.** Neither `natural-images.ts` nor `holdout-images.ts` verifies a hash, and both continue on fetch failure — a partial download silently shifts every mean. |
| U18 | **A quality gate in CI.** `ci-comparison.yml` runs the cross-format compare only; a regression on the format's own R-D curve would not be caught. |
| U19 | **Perceptual validation.** Every number in this file and in `RATIONALE.md` is metric-based. |

## 6. Reproducing

```sh
# Round 1 — the byte-budget study (§1–§4)
mise run sweep budget-ladder                        # R-D ladder, shipped constants
mise run sweep budget-ladder --split holdout
mise run sweep budget-ladder-tuned                  # round-1 recipe
mise run sweep budget-ladder-tuned --split holdout   # §4.5
mise run sweep render-raster                        # §4.1
mise run sweep allocation-grid                      # §4.2, §4.7
mise run sweep precision-by-budget                  # §4.2
mise run sweep thumbhash-headtohead                 # §4.3
mise run sweep thumbhash-headtohead --split holdout  # §4.3, §7.6
mise run sweep encoder-compute                      # §4.4
mise run sweep holdout-candidates --split holdout   # §4.5
mise run sweep retune-32b                           # §4.6

# Round 2 — the roadmap, materialized (§7)
mise run sweep refine-ablation                      # §7.1  pixel-domain RDO
mise run sweep refine-objective                     # §7.2  metric-targeted RDO
mise run sweep refine-grid                          # §7.2  render-grid control
mise run sweep selection-hv                         # §7.4  trained selection order
mise run sweep prefix-shrink                        # §7.5  header field widths
mise run sweep detail-synthesis                     # §7.8  decoder-side synthesis
mise run sweep cfl                                  # §7.10 chroma-from-luma
mise run sweep cfl-range                            # §7.10 the CfL audit
mise run sweep embedded-tiers                       # §7.11 progressive prefixes
mise run sweep combined-optimizer                   # §7.12 stacking, tune
mise run sweep final-candidates --split holdout     # §7.12 the holdout verdict
mise run sweep budget-ladder-optimized              # §7.12 optimized ladder
mise run sweep budget-ladder-optimized --split holdout

# Cross-format R-D at arbitrary budgets, with guard-aware winners (§2, §7.14)
node tools/comparison/dist/rd-budget.js --split tune \
  --budgets 12,16,18,21,24,28,32,40,48,64,80,108,192,411,1623
node tools/comparison/dist/rd-budget.js --split holdout \
  --budgets 12,16,18,21,24,28,32,40,48,64,80,108,192,411,1623   # §11.14

node tools/comparison/dist/cfl-probe.js      --split tune   # §4.8
node tools/comparison/dist/coeff-stats.js    --split tune   # §4.9, §4.10
node tools/comparison/dist/entropy-budget.js --split tune   # §7.13
mise run rd:gate                                                # §7.14 CI gate

# Round 3 — v0.7 stabilization (§11)
mise run sweep alpha-layout                         # §11.1
mise run sweep alpha-layout-control                 # §11.2
mise run sweep alpha-fields                         # §11.3
mise run sweep alpha-ac-count                       # §11.3
mise run sweep alpha-ceiling                        # §11.3
mise run sweep alpha-encoder                        # §11.3
mise run sweep alpha-balance                        # §11.3  C3-vs-C5 chroma count
mise run sweep graphics-layout                      # §11.4
mise run sweep graphics-encoder                     # §11.4
mise run sweep selection-weights                    # §11.5
mise run sweep companding-family                    # §11.6
mise run sweep deadzone                             # §11.7
mise run sweep quant-ranges                         # §11.8
mise run sweep scalefactor-bands                    # §11.9
mise run sweep compact-tier                         # §11.10
mise run sweep compact-tier-graphics                # §11.10
mise run sweep compact-tier-alpha                   # §11.12 compact tier, alpha corpus
mise run sweep alpha-tier1                          # §11.11
mise run sweep v07-holdout-photo --split holdout    # §11.12
mise run sweep v07-holdout-alpha --split holdout    # §11.12
mise run sweep adopted-defaults                     # §10.3
mise run sweep adopted-defaults --split holdout     # §10.3

# Check the tables in this file against the results above
mise run verify:experiments
mise run verify:experiments --list-unbound
```

The three `--split holdout` lines marked §4.5, §7.6 and §11.14 were **missing
until the §9.5 re-run**, and each is the only source for a table this file
already carried — §11.14's is the current cross-format record. Nothing said so:
`verify:experiments` reports a missing sweep output as SKIP, not as a failure,
so the block could not reproduce three of its own tables and still exited 0.
**A SKIP is not a pass** — read the skip list, or run with `--strict`, which
turns one into a failure.
Six configs in `tools/comparison/sweeps/` are **not** written up above, and are
listed here so their absence is not mistaken for a result being withheld:
`low-budget-allocation` and `v06-vs-v1` were run and superseded before this
file's round-3 numbers were taken, and their outputs no longer survive on disk;
`capped-tier1-vs-tier0`, `compact-tier-alpha`, `scalefactor-bands-t1` and
`tier-precision-vs-count` were written but never run — `compact-tier-alpha` is
listed as a command above but has never produced an output. None of them informed an
adopted constant. `mise run verify:experiments` checks the tables that *are* here
against the outputs that produced them.

`aniso-selection` and `aniso-extended`, named in §11.5, were deleted when
`selection-weights` replaced them; their outputs survive only in the gitignored
`output/sweeps/`.

Every command above reads the corpus of `tools/comparison/src/natural-images.ts`
and `holdout-images.ts`, content-pinned by SHA-256. The numbers in this file are
from the 39-image photographic corpus re-sourced from Wikimedia Commons in
`85f6af3` (§9.5), at the split sizes named at the top of this file; a run
against a different corpus is a different experiment, not a reproduction.


## 7. Round 2: every roadmap item, built and measured

Each `U`-number from §5 was implemented behind a tunable, round-tripped, and
swept. Tune split unless stated; the winners are re-validated on holdout in §7.12.
`spec/test-vectors/` passes unchanged throughout: every knob defaults to the
shipped behaviour.

### 7.1 U1/U2/U3 — pixel-domain RDO: the search works, the objective was wrong

Implemented as a coordinate descent over the quantized codes (`refine_passes`),
scored on the decoded pixels rather than the coefficients, with the DC codes
(`refine_dc`, U2) and the AC scale codes (`refine_scale`, U3 clipping
pre-compensation) as optional extra coordinates.

**Verification first.** On sources whose tier-0 render grid *is* the source grid
(so the encoder's model of the decoder can be checked directly against a real
decode), two passes reduce the gamma-sRGB squared error it optimizes by
**15–31%**, and adding the DC and scale coordinates takes it to **17–31%**:

| source | shipped | +2 passes | +dc+scale |
|---|---|---|---|
| 32×21 | 14.03 | 10.19 (−27.4%) | 9.61 (−31.5%) |
| 32×32 | 38.43 | 32.60 (−15.2%) | 31.73 (−17.4%) |
| 24×32 | 17.51 | 14.21 (−18.8%) | 12.88 (−26.5%) |

**And yet ΔE00 gets worse** (`sweeps/refine-ablation.json`, tune, 32 B):

| Variant | ΔE00 | Δ% |
|---|---|---|
| shipped | 11.655 | — |
| `refine_obj=1` (OKLAB, no clipping model — the control) | 11.636 | −0.16% |
| `refine_obj=0` (gamma sRGB), 2 passes | 11.685 | **0.26%** |
| `refine_obj=0`, 2 passes + dc + scale | 11.740 | **0.73%** |
| `refine_obj=2` (clipped OKLAB), 2 passes | 11.633 | −0.19% |

A 15–31% reduction in decoded-pixel squared error buys a **+0.26% increase** in
ΔE00, and pushing it to 17–31% with the DC and scale coordinates buys **+0.73%**
— the more squared error the search removes, the worse the colour gets. Not a
bug: the model of the decoder is exact, as the table above proves. The premise
of U1 was wrong: at these bitrates, squared pixel error and perceived colour
error are actively anti-correlated.

The control makes the same point from the other side. Holding the search fixed
and swapping only the objective flips the sign — `refine_obj=2` (clipped OKLAB)
is −0.19% where `refine_obj=0` (gamma sRGB) is +0.26%, on identical passes over
identical codes. The search was never the problem. (`refine_obj=1` finding
−0.16% on a supposedly separable objective is the scale mismatch of §4.4 turning
up again through a different door.)

### 7.2 U5 — metric-targeted RDO: the objective is what matters, and it stopped paying

Since the objective is what matters, `refine_obj=3` weights the clipped-OKLAB L
term by `refine_wl` and the chroma terms by `refine_wc`
(`sweeps/refine-objective.json`, tune, 32 B):

| chroma weight | 0.5 | 1 | 2 | **3** | 4 | 6 | 10 |
|---|---|---|---|---|---|---|---|
| ΔE00 Δ% | +1.09% | +0.13% | −0.01% | **−0.07%** | −0.02% | −0.02% | +0.30% |

The shape survives — a shallow optimum around `wc ≈ 3`, with 0.5 and 10 clearly
worse either side of it — but the depth does not. Round 2 measured that optimum
at −0.80%; on this corpus it is **−0.07%**, and the three arms from `wc = 2` to
`wc = 6` sit inside 0.06 pp of each other and of the incumbent. Adding the DC
and scale coordinates takes it to **−0.23%** (−0.27% at `wc = 4`); four passes
do not improve on two (−0.22%); at tier 1 it is −0.52%.

The comparison round 2 drew against "the retuned 4-bit layout" is no longer
available: `L28@4 C15@3` is the adopted default, so those arms and the plain
`obj3` arms are the same configuration and report the same number. What the
sweep can still say is that refinement on top of today's default buys −0.23%,
not the −1.2 pp round 2 attributed to it.

(This sweep's incumbent is the shipped default rather than a reconstructed
pre-adoption one, so these deltas are refinement measured on top of the adopted
recipe — which is the question worth asking now, and not the one round 2 asked.)

Also measured: `refine_grid=1` moves the objective onto the decoder's natural
render grid (scored against the ideal full-basis downsample of the source)
instead of the encoder input. **It makes no difference at all** — 11.485 vs
11.488 at `obj=2`, a gap of 0.02%. That reproduces round 2's reading exactly:
the grid was a red herring; only the error metric mattered. It is also the one
claim in this section the re-baseline left untouched, which is what a genuine
null looks like next to an effect that shrank by a factor of ten.

**Cost.** Refinement is ~54× the shipped encode (0.86 ms → 46 ms at tier 0,
3.2 ms → 275 ms at tier 1, on this machine). Decode is untouched.

### 7.3 U4 — closed-loop residual re-projection: refuted on paper, not built

The selected cosine basis is orthogonal over the encoder-input grid, so the
projection of the residual onto that basis is **exactly** `raw − dequantized`.
Adding it back and requantizing is therefore not error feedback but a fixed
bias, and can only lose. The only part of the residual that is *not* recoverable
this way is what the clipping non-linearity introduces — and that is precisely
what §7.1/§7.2's descent already searches, with a stronger objective. The knob
(`reproject_passes`) exists and is wired to nothing; U4 is subsumed.

### 7.4 U7 — corpus-trained selection order, as a 2-parameter family

`sel_hv` adds a horizontal/vertical asymmetry to the selection key:
`priority · (1 + aniso·sin²2θ) · (1 + hv·cos2θ)`. Positive `hv` pushes horizontal
frequencies (vertical edges) down the order (`sweeps/selection-hv.json`, tune,
32 B):

| | hv = −0.30 | −0.15 | 0 | **+0.15** | +0.30 |
|---|---|---|---|---|---|
| aniso = 0 | +2.22% | +1.54% | — | −0.67% | −0.81% |
| aniso = 1.2 | +0.92% | +0.36% | −0.64% | **−1.03%** | −1.13% |

> **Not reproducible, and left at its round-2 values deliberately. Read §11.5
> instead.** `sweeps/selection-hv.json` sets only the parameter each arm varies
> and lets the other default. That was correct when it was written, because both
> defaults were 0 — and it stopped being correct the moment §10 adopted
> `aniso_oblique = 1.2` / `sel_hv = 0.15`, after which "unset" means "the
> adopted value". Every `aniso = 0` cell above is really `aniso = 1.2`, and the
> `hv = 0` column is really `hv = 0.15`. Re-run today the config reports the
> shipped default, 11.4727, for **six** arms — the four cells of the grid above
> that name four different points, plus both `L28@4 C15@3` arms. Its twelve
> non-layout arms resolve to six distinct `(aniso, hv)` points, not twelve.
>
> This is the same defect §11.5 records for `aniso-selection` and
> `aniso-extended`, which were deleted for it; `selection-hv` has it too and was
> missed. It is not fixed here because fixing it means replacing the config, and
> `sweeps/selection-weights.json` already **is** that replacement: it sets both
> parameters explicitly in all 29 arms and is the grid §11.5 reads. The numbers
> above are kept as the round-2 record of what was concluded and how.

Round 2 read the matrix as nearly additive with the oblique-effect weight, with
an interpretable sign: photographic corpora carry more energy in vertical
frequencies (horizons, ground/sky), so demoting horizontal ones is right. §11.5
measures the same family correctly and does not reproduce that reading.

**The effect halved when the corpus stopped being predominantly outdoor
landscape** (§9): on the old 22-image split the same cell measured −2.09%, and
`aniso` alone −1.17%. Interiors, facades and flat man-made surfaces do not share
the horizon-driven H/V asymmetry, and a *fixed* trained order can encode only
one asymmetry. Round 2 also read the retuned L28@4 C15@3 layout as having already taken what
the weights were taking, at −1.99% against −2.01%. That comparison is not
readable either: both of its arms are in the collision above, and they now
report one number between them.

Where the weights do still pay is out of sample, and only there — §7.12 puts
`sel_hv = 0.15` at −3.72% on holdout against −3.37% for `hv = 0`, while §11.5
has `hv = 0` clearing zero on tune in the opposite direction. The honest size of
the lever is the +1.3 energy points `coeff-stats` now measures (§4.10), not
+2.2.

**Cost:** the weighted order is a float sort over every candidate, and it is
**+32% decode time** (302 → 399 µs) — the integer reformulation `RATIONALE.md`
already flags is now a performance requirement, not just a purity one.

### 7.5 U8/U9 — shrink the prefix: it buys ΔE00, and the bill is aspect fidelity

Every header field width is now tunable. Pure cost first (same AC layout, tune,
32 B):

| Narrowing | bits saved | ΔE00 Δ% | guards |
|---|---|---|---|
| aspect 8 → 5 b | 3 | **−0.11%** | ok |
| aspect 8 → 4 b | 4 | **−0.06%** | **FAIL** |
| scales 6/6/5 → 5/4/4, linear grid | 4 | 0.69% | ok |
| scales 6/6/5 → 5/4/4, **µ-law grid** (`scale_mu=8`) | 4 | 0.09% | ok |
| `b_scale_from_a` (drop the b field) | 5 | 2.20% | **FAIL** |
| DC 7/7/7 → 6/6/6 | 3 | 0.76% | ok |
| all of the above | 15 | 2.71% | **FAIL** |

(The ΔE00 column is bound; the `guards` column is not, and two of its cells were
stale — narrowing aspect to 4 b and the all-in row both fail their guards.)

Then spend the recovered bits on AC at the same 32 bytes. **On ΔE00 this now
pays.** The best 4-bit-luma row is **−0.68%** against the same layout with the
full prefix, every guard passing: three bits of aspect precision become two more
luma coefficients, `L30@4 C14@3` for `L28@4 C15@3`. That is consistent with
§4.2, where more 4-bit luma is what this budget wants. The best 5-bit-luma row
is +1.40% and fails its guards, so the gain belongs to the 4-bit layouts and not
to the idea in general.

Round 2 measured that same comparison at **+0.04 pp** — nothing — and wrote the
section as a refutation on that basis. On this corpus it is **−0.68 pp**, so the
refutation cannot rest there any more. It rests on the paragraph below instead,
which was always the stronger argument and never depended on the sweep.

Two findings that survive intact:

* **µ-law scale codes work.** Narrowing the scale fields costs +0.69% on a
  linear grid and +0.09% on a companded one. Corpus scales cluster far below
  the range maximum, exactly as expected. If a future revision needs scale bits,
  this is how to take them.
* **U9 is dead.** `b_scale_from_a` costs +2.20% and fails the guards. The two
  chroma scales are not redundant.

**The aspect gain is bought with something the metric cannot see.**
`upscaleRgba` resizes every decode to the reference dimensions with
`fit: "fill"`, so **the evaluation cannot see aspect error at all** — it
stretches the wrong-shaped decode back into the right frame, which is precisely
why the ΔE00 ledger above reads as a free win. The real cost is analytic: a `b`-bit aspect field has a
max ratio error of `2^(4/2^b) − 1`, i.e. 1.09% at 8 b, 4.4% at 6 b and **9.1% at
5 b — worse than ThumbHash's 3-bit ~7%**, which is the comparison the format's
"precise layout" claim rests on. At 5 bits, 3:2 and 4:3 images decode to the
same 32×22 grid. Keep 8 bits.

> **The blindness is fixed; the conclusion is not affected.** The comparison
> harness now measures layout fidelity directly (`tools/comparison/src/aspect.ts`),
> outside the metric path, so the number no longer has to be argued analytically —
> see U19 in §7.14. The sweep rows above were measured under the blind harness and
> still stand: they measure ΔE00, which the stretch does not affect, and the reason
> to keep 8 bits was never in the sweep.

### 7.6 U10 — the compact tier below 32 B

Materialized as a measured layout rather than a new tier code (tier codes 4–7
were still reserved at this point). With the round-2 recipe at ThumbHash's own 21 B, **holdout**:

| | ΔE00 | SSIM2 | Butteraugli | DSSIM |
|---|---|---|---|---|
| ThumbHash (21.0 B) | 12.807 | −337.2 | 30.98 | 0.2647 |
| ChromaHash 21 B, shipped-shape layout | 12.726 | −361.0 | 32.49 | 0.2656 |
| **ChromaHash 21 B, L19@4 C6@3 + stack** | **12.203** | **−335.0** | **30.03** | **0.2641** |
| ChromaHash 21 B, L26@3 C6@3 + stack | 12.136 | −321.6 | 29.57 | 0.2641 |

−4.7% ΔE00 against ThumbHash while also winning SSIMULACRA2, Butteraugli and
DSSIM, validated out of sample — and the 3-bit variant of §4.3 does better
still, −5.2%, with far more of the margin on SSIMULACRA2 (+15.6 against +2.2).
This remains the single largest structural gap, though a narrower one than round
2 recorded: −6.3% then, −4.7% now, most of the change being ThumbHash scoring
better on this corpus rather than ChromaHash scoring worse.

These are §4.3's holdout rows, which are bound; this table is the view onto
them. The refinement row round 2 carried here is dropped rather than
re-transcribed — it came from a different sweep on a different base, and §7.12
now states the refinement delta against a control that matches it.

### 7.7 U11 — entropy-coded AC

See §7.13 (measured with a real adaptive coder, not just static entropy).

### 7.8 U12 — decoder-side detail synthesis: refuted, decisively

Implemented in the decoder: frequencies past the coded band are filled with
pseudo-random signs (xorshift64\*, seeded by FNV-1a over the hash bytes, so it is
deterministic and cross-platform) whose amplitude continues the coded band's own
spectral decay (`sqrt(p_K/p_j)` times the RMS of the coded set's top quarter).
Zero bytes. `sweeps/detail-synthesis.json`, tune:

| variant | ΔE00 Δ% | SSIM2 | Butteraugli | DSSIM |
|---|---|---|---|---|
| shipped | — | −341.7 | 30.38 | 0.2638 |
| 26 extra coefficients, gain 0.25 | 0.59% | −346.1 | 30.53 | 0.2643 |
| 78, gain 0.5 | 4.54% | −392.6 | 32.29 | 0.2695 |
| 234, gain 0.5 | 6.60% | −432.1 | 33.38 | 0.2752 |
| tier 1, 312, gain 0.5 | +5.0 pp | −281.0 | 26.01 | 0.2704 |

The hypothesis was that SSIMULACRA2 and DSSIM — the axes where the format loses
to WebP — would reward plausible detail. **They do the opposite**: every
structural metric gets monotonically worse with synthesis strength. Synthesized
detail is uncorrelated with real detail, and these metrics are not fooled by
texture that is merely present. Decode also costs +70%. Dead end, and worth
recording because the idea is intuitively appealing.

### 7.9 U13 — per-image signalled selection

Using the 12 `(aniso, hv)` presets of §7.4 as the signalled alphabet, per-image
(tune):

| | ΔE00 |
|---|---|
| shipped ℓ2-ball order | 10.434 |
| best single fixed preset (aniso 1.2, hv +0.30) | 10.317 (−1.13%) |
| per-image **oracle** preset | 10.152 (−2.70% vs shipped, **−1.59% vs best fixed**) |

Signalling 4 bits costs ~0.37% ΔE00 at 32 B, so an oracle selector nets ~−1.2%
— and a real selector would capture only part of the oracle. Worth less than the
fixed preset it would sit on top of. Not recommended.

> **Round-2 values, and not reproducible — see §7.4.** The alphabet here is
> `selection-hv.json`'s twelve non-layout arms, and that config sets one
> selection parameter per arm while letting the other default. The figures above
> were taken when both defaults were 0, so the labels were accurate when
> written. Re-run today those twelve arms resolve to **six** distinct presets, so
> the oracle-over-12 experiment cannot be reproduced and the 4-bit signalling
> cost it prices would be 3 bits. The verdict survives — a smaller alphabet does
> not make the oracle worth more than the fixed preset — but the numbers are
> round 2's, not the current corpus's.

### 7.10 U14 — chroma-from-luma: the predictor works, and does not pay for itself

Implemented as a wire feature: a signalled per-channel least-squares gain
(`cfl_bits`, `cfl_range`), with each chroma AC coefficient coded as a residual
against `alpha ×` the luma coefficient the *decoder* reconstructs at the same
selection index. `sweeps/cfl.json`, tune:

| | bytes | ΔE00 | vs its own control |
|---|---|---|---|
| shipped | 32 | 11.473 | — |
| CfL free (gains not paid for) | 34 | 11.462 | **−0.09%** |
| CfL paid, L24@5 C9@4 | 32 | 11.723 | −0.04% vs the same layout without CfL |
| CfL paid on the 4-bit layout | 32 | 11.512 | −0.04% vs its control |
| tier 1 free | 109 | 9.656 | −0.11% |
| tier 2 free | 412 | 7.793 | −0.45% |
| tier 3 free | 1624 | 6.665 | −0.90% |

**This column changed sign on the Wikimedia corpus, and it is the one column in
the table nothing checks** — the binding covers `bytes` and `ΔE00`, so the
control deltas were never re-derived when the ΔE00 cells were. Round 2 read a
free predictor as *worse* than none (+0.19% at 32 B), which is not physically
expected and prompted the audit below. Measured now it is slightly better, and
consistently so, growing with tier: −0.09% at 32 B to −0.90% at tier 3. The
audit's findings stand; what has changed is that they no longer need to explain
away a paradox:

1. **Gain precision excluded.** Sweeping `cfl_range` over 0.05–1.0 and
   `cfl_bits` to 10 (α step 5·10⁻⁴, effectively exact) leaves it in the
   −0.21…+0.02% band (`sweeps/cfl-range.json`) — every arm but the coarsest
   range a small gain. Quantized gains are not the problem, and were never the
   problem.
2. **The predictor does work.** Residual *energy* after the least-squares gain
   is 71.5% (a) / 63.2% (b) of the original (§4.8) — an amplitude ratio of
   ≈0.85 / 0.79, so the scale field really does shrink.
3. **Coefficient error really does improve.** Simulating the µ-law path,
   RMS coefficient error falls from 0.0376 → 0.0356 (a) and 0.0375 → 0.0306 (b),
   *including* the α·(luma quantization error) the predictor imports. (Points 2
   and 3 were measured before the §9 corpus revision; the ΔE00 verdict above is
   from the revised corpus and does not rest on them.)

So CfL reduces the scale, the coefficient error *and* — on this corpus — ΔE00.
The three now agree, which removes the anti-correlation round 2 read here and
filed alongside §7.1's. That reading was an artifact of the old corpus; §7.1's
own anti-correlation is unaffected and still stands on its own evidence.

**What refutes CfL is the bill, not the prediction.** The gain field costs
2 · `cfl_bits`, and those bytes buy coefficients that are worth more than the
prediction saves: paid at 32 B on `L24@5 C9@4` it is **+2.18% against the
shipped layout**, and on the 4-bit layout **+0.34%**, while against its own
size-matched control it is a wash either way (−0.04%). A −0.09% predictor cannot
fund a 10-bit field at a 32-byte budget.

The tier-3 figure is the one worth revisiting if the format ever grows a cheaper
way to signal the gains: −0.90% free at 1623 B is the largest CfL has measured
here, and unlike the low tiers there are enough coefficients for the field to
amortize against. The §4.8 correlation probe still calls the magnitude
correctly.

### 7.11 U15 — embedded/progressive tiers

Implemented: `interleave` writes the AC codes of all three channels merged by
frequency priority (identical bytes-out length, a pure permutation, verified
byte-neutral at full length), and `trunc_bytes` decodes only a prefix, treating
every code past it as the exact-zero centre code. `sweeps/embedded-tiers.json`,
tune:

| Decoded from a 108 B tier-1 hash | ΔE00 | vs native tier 0 (11.473) | SSIM2 |
|---|---|---|---|
| first 32 B, interleaved | 11.955 | **+4.21%** | −378.4 |
| first 32 B, channel-sequential | 12.584 | +9.69% | −319.8 |
| first 48 B, interleaved | 11.220 | −2.20% | −344.2 |
| first 64 B, interleaved | 10.700 | −6.74% | −311.2 |
| full 108 B (either order) | 9.667 | −15.74% | −212.9 |

Interleaving is worth **5.0%** over a sequential prefix at the 32-byte cut, and
progressive costs **~4%** against a native tier-0 encode at the same 32 bytes.
Note the trade the two orders make: a sequential prefix delivers all of the luma
and none of the chroma, so it scores *better* on SSIMULACRA2 (−319.8 vs −378.4)
and much worse on ΔE00. Progressive is affordable; it is an operational feature
(one hash serves every size), not a quality one.

### 7.12 The optimized recipe, validated on holdout

`sweeps/final-candidates.json`, **holdout split**, incumbent = shipped 32 B.
**STACK** = `l1=28:4 c=15:3 aniso=1.2 sel_hv=0.15 scale_fit=2 ac_nearest=1`;
**REFINE** = `refine_passes=2 refine_grid=1 refine_obj=3 refine_wc=3 refine_dc=1 refine_scale=1`.

| Variant | Bytes | ΔE00 | Δ% | SSIM2 | Butter | DSSIM | Guards |
|---|---|---|---|---|---|---|---|
| shipped | 32 | 11.735 | — | −318.4 | 28.66 | 0.2630 | (base) |
| shipped layout + stack | 32 | 11.539 | −1.67% | −308.5 | 28.19 | 0.2626 | ok |
| L36C9 stack | 32 | 11.377 | −3.05% | −287.1 | 27.23 | 0.2623 | ok |
| L32C12 stack | 32 | 11.371 | −3.10% | −296.7 | 27.65 | 0.2624 | ok |
| L30C13 stack | 32 | 11.364 | −3.16% | −302.0 | 27.93 | 0.2624 | ok |
| L28C15 stack, hv = 0 | 32 | 11.340 | −3.37% | −308.1 | 28.10 | 0.2624 | ok |
| **L28C15 stack** | 32 | **11.298** | **−3.72%** | −303.7 | 28.16 | 0.2623 | **ok** |
| **L28C15 stack + REFINE** | 32 | **11.265** | **−4.01%** | −303.0 | 28.14 | 0.2628 | **ok** |
| tier 1 base | 108 | 9.696 | −17.38% | −184.9 | 23.00 | 0.2589 | ok |
| tier 1 stack | 108 | 9.517 | −18.90% | −174.1 | 22.75 | 0.2582 | ok |
| tier 1 stack + REFINE | 108 | 9.489 | −19.14% | −173.0 | 22.78 | 0.2587 | ok |
| tier 2 stack | 411 | 7.783 | −33.68% | −76.8 | 17.94 | 0.2507 | ok |

Both winners clear the pre-registered ≥3% holdout threshold with **every guard
improving**: the constants-only stack at **−3.72%** and the same stack with the
refinement pass at **−4.01%**. `sel_hv = 0.15` generalizes — it beats `hv = 0`
out of sample, −3.72% against −3.37% — and `hv = 0.3` lands between them at
−3.19%. Of the three, 0.15 is the right value.

What the re-baseline changed is the tune side of this, not the holdout side.
Round 3 could say `hv = 0.3` was *better* on tune and reject it out of sample
anyway; on the Wikimedia corpus `hv = 0.3` is +0.40% on tune with a CI
straddling zero, and the arm that clears zero there is `hv = 0`, pointing the
other way (§11.5). So the holdout ordering is unchanged and still picks 0.15 —
but it is no longer overturning a tune result, it is the only evidence the
selection weights have. They earn their keep out of sample and nowhere else.

The whole ladder under the constants-only recipe
(`sweeps/budget-ladder-optimized.json`):

| Bytes | 12 | 16 | 21 | 24 | 28 | 32 | 40 | 48 | 64 | 80 | 108 | 161 | 246 | 411 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tune, pre-adoption shipped | 13.79 | 12.35 | 11.70 | 11.14 | 10.80 | 10.43 | 10.03 | 9.73 | 9.32 | 8.98 | 8.57 | 8.07 | 7.67 | 7.09 |
| tune, optimized | 13.50 | 12.68 | 12.15 | 11.93 | 11.67 | 11.41 | 11.09 | 10.76 | 10.48 | 10.14 | 9.67 | 9.05 | 8.45 | 7.90 |
| holdout, pre-adoption shipped | 13.84 | 13.07 | 12.61 | 12.14 | 11.79 | 11.55 | 11.14 | 10.72 | 10.24 | 9.85 | 9.44 | 8.85 | 8.31 | 7.79 |
| holdout, optimized | 13.30 | 12.72 | 12.15 | 11.88 | 11.55 | 11.38 | 10.98 | 10.67 | 10.35 | 9.99 | 9.51 | 8.92 | 8.39 | 7.82 |

(The 32 B row of this ladder uses the ratio-derived `L33@4 C11@3`; the *measured*
optimum `L28@4 C15@3` is better still — 11.298 on holdout, in the table above.)

> **The two `pre-adoption shipped` rows are round 2's baseline and are not on
> this corpus.** Their sweep no longer exists: `budget-ladder` resizes the
> layout but inherits today's adopted knobs, so it is a ladder of the format
> that ships rather than the one round 2 compared against. Read the `optimized`
> rows against each other, not across the pair — and see §8.3, where the
> equal-quality byte saving that used to be stated here is withdrawn for the
> same reason.


### 7.13 U11 — entropy-coded AC, with a real coder instead of an entropy

`entropy-budget.ts` re-asks §4.9's question with two changes: the code stream is
actually coded (sequentially, per image, against a Laplace-smoothed adaptive
model) rather than assigned its pooled entropy, and the model is scored
**leave-one-image-out** so the table's own fitting cost is paid.

| Model | AC bits (of 202 fixed) | vs fixed | honest? |
|---|---|---|---|
| static pooled entropy (§4.9) | 187.9 | −7.0% | no — in-sample lower bound |
| static per-index entropy (§4.9) | 159.3 | −21.1% | **no — badly optimistic** |
| order-0 adaptive, no decoder tables | 196.0 | −3.0% | yes |
| order-0 pretrained table, LOO | 190.3 | −5.8% | yes |
| per-index context table, LOO | 190.5 | −5.7% | yes |
| **per-index context backing off to order-0, LOO** | **187.0** | **−7.4%** | yes |

Two corrections fall out:

* **A table-free adaptive coder is worse than the static entropy by 4.3%**
  (196.0 vs 187.9 b). A 44-symbol payload never lets a model that starts uniform
  pay for itself.
* **Per-index context, scored out of sample, is worse than plain order-0**
  (190.5 vs 190.3 b) — the opposite of what §4.9's in-sample number implied. It
  helps only when backed off to the order-0 table, and then by 3.3 b.

So the real tier-0 headroom is **15.0 bits ≈ 2 extra 5-bit luma coefficients**,
not the ~10 that the in-sample context figure implies. Spending it (searching
layouts that fit under each coder) gives **−1.6% ΔE00** at 32 B and **−4.8%** at
108 B, each against the best layout the *fixed* fields can reach at the same
budget — real, and at 108 B of the same order as the constants changes of §8,
but paid for with decoder tables, a decode loop, and the O(1) length check that
currently *is* the validity check.

Both figures moved, and in opposite directions: the 32 B case is now less than
half what round 2 recorded and the 108 B case rather more. At 32 B a coder buys
two coefficients out of 44, which is inside the noise of a layout search; the
case for entropy coding, such as it is, is a case about the upper tiers.

The counter-finding from the same search is **half-refuted, and worth saying
so**. Maximizing *coefficient count* is still the wrong objective — under every
coder the count-maximal layout loses to that coder's ΔE00-optimal one (11.576 vs
11.252 under the best). But round 2's stronger claim, that it is worse than the
shipped layout outright, no longer holds: the count-maximal layout under the
fixed fields (L35@3 C23@2, 81 coefficients) is **11.987 — 2.9% worse than
shipped, not 13%** — and once a coder buys 147 of them it reaches **11.576,
0.7% better than shipped**. The precision floor is real and it is a good deal
shallower than the old corpus made it look.

### 7.14 U16/U17/U18 — the evaluation items

**U16 — guard-aware cross-format scoring.** `rd-budget.ts` now emits a
winner-per-metric summary (and a `--summarize` mode that recomputes it from an
existing JSON). It makes the §2 asymmetry explicit: on the tune split
ChromaHash's shipped constants win ΔE00 *and lose at least one guard* at
**12 B** (SSIMULACRA2, to raw RGB565), **80 B** and **192 B** (SSIMULACRA2 and
Butteraugli, to lqip-modern and WebP); they sweep all four metrics at 21, 28,
32, 40, 48, 64 and **108 B**, and stand unopposed at 16, 18 and 24 B.

The asymmetry is narrower than round 2 recorded, in both directions. **21 B and
108 B are now clean sweeps** where they were guard losses — to ThumbHash and
lqip-modern respectively — which is the positioning §8.6 predicted the optimized
recipe would reclaim, now measured directly rather than inferred. **12 B is a
new loss**, on SSIMULACRA2 to raw RGB565. And at 192 B ChromaHash now leads
ΔE00 outright (8.785 vs WebP's 8.944) rather than being drawn level with; that
particular change is not the corpus but a defect in the harness, and is not a
result — see §9.5.

**U17 — content-pinned corpus.** `corpus-pin.ts` verifies a SHA-256 for every
fixture, cached or freshly fetched; `natural-images.ts` (39 digests) and
`holdout-images.ts` (24 Kodak digests) now **throw** on mismatch or fetch
failure instead of warning and continuing with a partial corpus. Independently
verified: the digests match the current fixtures, appending one byte to
`natural-food.jpg` aborts with the expected/actual digests, and the check passes
again once restored.

> **A corpus change is a re-baseline, not an edit.** `sweep.ts` globs
> `fixtures/**` and defaults unknown names to the tune split, so adding an
> image silently moves every mean in this file. That is what makes the pin
> load-bearing: the digests say *which* corpus a number belongs to. The 13
> photographs of §9 were added deliberately and **every table above was
> re-measured in the same change**; a run that mixes the two sets reproduces
> nothing (ThumbHash on "tune": 11.17 before, 12.04 after). Treat any future
> addition the same way — re-run §6 in full, or do not add it.

**U18 — a CI quality gate.** `mise run rd:gate` encodes 8 pinned photos at tier 0 and
compares mean ΔE00 against `tools/comparison/baselines/rd-gate.json` with a
**two-sided** ±1% tolerance (an unexplained improvement also fails — a stale
baseline gates nothing), and asserts every hash is exactly 32 bytes. Wired into
`ci-comparison.yml`. The set gained a dark-skin portrait and a grayscale
photograph in the §9 revision, so the gate now covers the two inputs most likely
to expose a chroma-path regression; baseline mean 8.9043 (6 images) → **9.0933**
(8 images) → **8.8459** after §10 adopted the recipe → **11.1369** after
`85f6af3` re-sourced the corpus from Wikimedia Commons. The 9.0933 step was
verified at 0.00% drift, which is what confirmed that every knob round 2 adds
defaults to byte-identical output; 8.8459 is the −2.72% the gated set moved by
when those defaults changed; 11.1369 is +25.9% and is a different set of eight
photographs, not a quality change — the encoder did not move, and `rd:gate`
reports 0.00% drift against it here.

**U19 — perceptual validation.** Two of the three gaps are now closed; the third
is still the most valuable thing left.

*Aspect blindness — closed.* §7.5 showed the harness could not see aspect-ratio
error at all, because every decode is stretched back into the reference frame
before scoring. `tools/comparison/src/aspect.ts` now measures it outside that
path, reporting `|log₂(AR_declared / AR_original)|` in §8.1's own percent
convention plus the reflow in CSS px for a 1000 px column. Two things had to be
got right for the number to mean anything. It cannot come from the decode's
reported dimensions: `decode_capped_to_with` caps per axis and the harness passes
the encoder input as that cap, so on a 3:2 photograph t3 and t4 report the cap's
100×67 rather than their own 128×84 and 256×168 — an error derived from that
would read ≈0 for exactly the tiers in question. And it measures the *render
grid*, which is coarser than the aspect byte: the byte is good to ±1.09%, but the
base grid rounds to integers at a 32 px long edge, so a 3:2 source lands on
32×21 = 1.5238. Measured on photographs, every tier reports an identical ~1.6%
against ThumbHash's ~7.8% — tier-invariance being a self-check, since §8.2 defines
the higher tiers as a bit shift of the already-rounded base.

*Artifact blindness — closed.* ΔE00, SSIMULACRA2, Butteraugli and DSSIM are all
aggregate fidelity scores; none separates *smooth but wrong* from *sharp with
artifacts*, which is the distinction that decides whether a downstream blur-up
rescues a placeholder. `tools/comparison/src/metrics/local.ts` measures ringing as
RMS excursion beyond the reference's local range, so a decode that is merely a
low-pass of the reference scores exactly zero. It gives §14's open question about
the decode-side synthesis window a number to move: on photographs, ringing climbs
monotonically with tier while every fidelity metric improves.

*Human-judgement validation — still open, and still the most valuable item.*
§8.5 shows three separate MSE-reducing changes moving ΔE00 the wrong way. The
metrics remain load-bearing and unaudited against human ratings; nothing above
changes that, and adding two more computed metrics arguably raises the stakes.

## 8. The optimized algorithm and its default parameters

What survived, in the form a spec revision would take. Everything below is
validated on the never-tuned holdout split with all four metrics improving.

### 8.1 Constants-level (every implementation must adopt these together)

**1. The AC layout becomes a per-tier table, not one base layout scaled by 4^tier.**
The measured count-vs-precision optimum moves with the budget (§4.2), so tier 0
wants coarser, more numerous coefficients than tiers 1–3. The byte anchors are
unchanged.

| Tier | bytes | shipped layout | **optimized layout** |
|---|---|---|---|
| compact (proposed, tier code 4) | **21** | — | **L 19 @ 4 b, a/b 6 @ 3 b** * |
| 0 | 32 | L 26 @ 5 b, a/b 9 @ 4 b | **L 28 @ 4 b, a/b 15 @ 3 b** |
| 1 | 108 | L 104 @ 5 b, a/b 36 @ 4 b | unchanged |
| 2 | 411 | L 416 @ 5 b, a/b 144 @ 4 b | unchanged |
| 3 | 1623 | L 1664 @ 5 b, a/b 576 @ 4 b | unchanged |

`54 + 28·4 + 2·15·3 = 256 bits` — tier 0 is still exactly 32 bytes.
`54 + 19·4 + 2·6·3 = 166 bits` → 21 bytes for the compact tier.

\* The compact layout is chosen on tune, where `L 19 @ 4 b` wins (12.147 vs
12.161). On holdout the 3-bit sibling `L 26 @ 3 b, a/b 6 @ 3 b` is better
(12.129 vs 12.146) — both beat ThumbHash on all four metrics, and the choice
between them should be re-made against the alpha-mode layout before a compact
tier is written down.
**Not yet measured:** the alpha-mode layout. The arithmetic points at
`L 22 @ 4 b, a/b 14 @ 3 b` at tier 0 (255 bits), but the photographic corpus has
no alpha, so this needs its own sweep before it is written down.

**2. Selection weights** `aniso = 1.2`, `sel_hv = 0.15` — key
`priority · (1 + 1.2·sin²2θ) · (1 + 0.15·cos2θ)`. Worth −1.03% on its own on
tune, and −0.34 pp of the holdout verdict (§7.12: −3.16% without them, −3.50%
with). This is the weakest of the three constants-level changes and the one the
corpus revision cut hardest (§7.4) — it is carried by the holdout result, not by
tune. **Blocker:** it is a float sort and costs **+32% decode time**; it needs
the integer reformulation `RATIONALE.md` already flags before it can be
normative. If the integer reformulation proves awkward, dropping `sel_hv` and
keeping the layout still clears the ≥3% rule (−3.16%).

**3. Everything else stays.** Aspect 8 b (§7.5 — narrowing it only looks free
because the evaluation is blind to aspect error), DC 7/7/7, scales 6/6/5 on the
linear grid, µ_L = 5 / µ_C = 8 (§4.6), no deadzone, no scalefactor bands, no
synthesis window.

### 8.2 Encoder-only (no decoder change; test vectors move, the format does not)

| Knob | Value | Why |
|---|---|---|
| `scale_fit` | **2** | The shipped encoder normalizes AC by the unquantized max\|AC\| while the decoder uses the rounded scale code. Mode 1 fixes the mismatch for free; mode 2 searches the code and is worth about twice as much (§4.4). −0.30% at 32 B, −1.0% at 411 B. |
| `ac_nearest` | **1** | Pick the code nearest in reconstruction rather than in the companded domain. Worth 0.02% — keep it because it is free and principled, not because it is large. |

**Optional high-effort mode** (~54× encode time, decode untouched):
`refine_passes=2 refine_grid=1 refine_obj=3 refine_wc=3 refine_dc=1 refine_scale=1`.
Worth a further −0.3 pp on holdout at tier 0 and −0.3 pp at tier 1. Offer it as
an encoder quality setting, not a default: 0.86 ms → 46 ms per image at tier 0.
If only one number is wanted, `refine_wc = 3` is the whole discovery — the
search was never the hard part, the objective was.

### 8.3 What that buys

Holdout, photographic corpus:

| | ΔE00 | SSIMULACRA2 | Butteraugli | DSSIM |
|---|---|---|---|---|
| shipped, 32 B | 11.735 | −318.4 | 28.66 | 0.2630 |
| optimized constants + encoder, 32 B | **11.298 (−3.72%)** | **−303.7** | **28.16** | **0.2623** |
| + optional refinement, 32 B | **11.265 (−4.01%)** | −303.0 | 28.14 | 0.2628 |
| shipped, tier 1 108 B | 9.696 | −184.9 | 23.00 | 0.2589 |
| optimized, tier 1 108 B | **9.517 (−1.84 pp)** | **−174.1** | **22.75** | **0.2582** |

Every guard improves at both tiers, and the tier-0 delta clears the
pre-registered ≥3% holdout threshold. These are the same four rows §10.3 checks
against `adopted-defaults`, which reconstructs the pre-adoption constants by
hand rather than inheriting them — the only way the comparison stays meaningful
now that §10 has made the optimized recipe the default.

> **The equal-quality byte saving is not restated here.** Round 2 put it at 20%
> — the optimized 32-byte encode matching the shipped format at 40 bytes — read
> off a ladder of the *pre-adoption* signal path. No current sweep produces that
> ladder: `budget-ladder` resizes the layout but inherits today's adopted
> knobs, so it is a ladder of the format that ships, not of the one the saving
> was measured against. The −3.72% above is what the corpus still supports; the
> byte figure needs a pre-adoption ladder nobody has run.

At the proposed 21-byte compact tier the format beats ThumbHash on **all four
metrics** on holdout (§7.6), which the shipped constants do not.

### 8.4 Rejected, with the number that rejected it

| Idea | Verdict |
|---|---|
| Pixel-SSE refinement (U1) | +0.26% ΔE00 (+0.73% with dc+scale) despite −15…31% pixel SSE. Objective was wrong. |
| Closed-loop re-projection (U4) | Provably a fixed bias on an orthogonal basis; subsumed by U5. |
| Prefix narrowing (U8) | Best case **−0.68 pp** on ΔE00 — but paid for in aspect error the metric cannot see (9.1% at 5 b, worse than ThumbHash). Refused on that, not on the sweep. |
| `b_scale_from_a` (U9) | +2.20%, fails guards. |
| Decoder detail synthesis (U12) | Every structural metric monotonically worse; +70% decode. |
| Per-image signalled selection (U13) | Oracle −1.59% vs best fixed, minus ~0.37% signalling. |
| Chroma-from-luma (U14) | Free gains help slightly now (−0.09% at 32 B, −0.90% at tier 3); paid for, the field costs more than it saves (+2.18% at 32 B). |

### 8.5 The meta-finding

Round 2 read three independent levers this way — pixel-domain RDO (§7.1),
chroma-from-luma (§7.10), and the objective sweep (§7.2) — as all reducing
squared error and all failing to improve ΔE00. **On the Wikimedia corpus that is
down to one.** §7.1 still shows it cleanly and in both directions: minimizing
gamma-sRGB SSE costs +0.26% while swapping only the objective to clipped OKLAB
buys −0.19%. But §7.10's chroma-from-luma now *does* translate its coefficient
gain into ΔE00 (−0.09% at 32 B, −0.90% at tier 3), and what refuses it is the
cost of the gain field, not an anti-correlation.

So the meta-finding holds in the weaker form it can still support: **at LQIP
bitrates, minimizing squared error harder buys little and can cost.** What paid
this round still paid by changing *where the bits go* (layout, selection order)
or *what error means* (the perceptual objective) — but the MSE domain is not
inverted, only nearly flat, and the one lever that inverts it is the one
optimizing pixels the decoder never shows at that size.

The corollary is uncomfortable and should be stated: every one of those
conclusions rests on ΔE00 with three guard metrics, and §7.5 showed the harness
is structurally blind to at least one real defect (aspect error). A human study
would be worth more than the next round of sweeps.

### 8.6 What the optimized recipe does to the cross-format positioning

> **Superseded by §11.14** for the same reason as §2, and because the alpha
> allocation and the compact tier both landed after it.

Holdout split, competitors from `rd-budget --split holdout`, ChromaHash rows
from `budget-ladder-optimized`/`final-candidates` (same corpus, same split, same
scoring config, same metric cache — the two runners share all of it).

| Bytes | Format | ΔE00 | SSIM2 | Butter | DSSIM |
|---|---|---|---|---|---|
| 21.0 | ThumbHash | 12.851 | −326.3 | 31.75 | 0.2589 |
| 21 | ChromaHash **shipped** | 12.611 | −349.2 | 33.04 | 0.2587 |
| 21 | ChromaHash **optimized** | **12.047** | **−323.2** | **30.52** | **0.2576** |
| 25.8 | RawRGB565 | 12.570 | −351.6 | 34.19 | 0.2585 |
| 32 | ChromaHash **shipped** | 11.554 | −304.5 | 29.27 | 0.2559 |
| 32 | ChromaHash **optimized** | **11.150** | **−285.8** | **28.49** | **0.2550** |
| 47.5 | RawRGB565 | 11.388 | −317.6 | 31.19 | 0.2555 |
| 47.7 | WebP | 15.570 | −406.0 | 37.87 | 0.2852 |
| 48 | ChromaHash **optimized** | **10.464** | **−231.2** | **25.32** | **0.2538** |
| 82.3 | lqip-modern r16 | 11.230 | **−183.3** | **23.86** | 0.2525 |
| 80 | ChromaHash **optimized** | **9.744** | −192.4 | 23.98 | **0.2515** |
| 107.3 | WebP | 10.255 | −167.5 | 22.91 | 0.2498 |
| 108 | ChromaHash shipped | 9.435 | −169.1 | 22.86 | 0.2512 |
| 108 | ChromaHash **optimized** | **9.281** | **−159.4** | **22.51** | **0.2505** |
| 132.8 | lqip-modern r24 | 10.223 | **−124.4** | **21.22** | **0.2487** |
| 404.8 | **WebP** | **7.289** | **−62.2** | **14.01** | **0.2285** |
| 411 | ChromaHash optimized | 7.604 | −76.3 | 17.76 | 0.2441 |

Two things move:

* **At 108 B ChromaHash now wins SSIMULACRA2 against size-matched WebP**
  (−159.4 vs −167.5), where the shipped constants lost it (−169.1). That
  reclaims the one guard the format was losing to a real codec at its own best
  budget. It does *not* generalize to lqip-modern: at 82 B lqip r16 still takes
  SSIMULACRA2 and Butteraugli (−183.3 / 23.86 against −192.4 / 23.98), and takes
  them by more from ~128 B. The reclaim holds on the tune split too, by a
  similar hair: WebP@107 B scores −155.1 against the optimized recipe's −153.1
  (`rd-budget --split tune`, `budget-ladder-optimized`).
* **The 21-byte compact tier beats ThumbHash on all four metrics**, which is the
  positioning claim the format could not previously make anywhere.

Unchanged: tiers 2–3 remain a rate–distortion loss. What did move with the
corpus is the upper ΔE00 crossover: WebP now draws level at ~190 B rather than
somewhere past 200 B, so the optimized recipe widens the format's strong region
from ~32–110 B to roughly **~20–110 B plus the 21 B tier**, and the region where
it leads *everything* ends sooner than round 1 claimed.


## 9. The corpus audit and revision (2026-08)

Round 1 and round 2 were measured on 26 curated Picsum photographs (22 tune /
4 holdout) plus the 24-image Kodak holdout suite. Everything above has been
re-measured on **39 curated photographs (31 tune / 8 holdout)** plus Kodak. This
section is the audit that motivated the change, what was added, and what moved.

### 9.1 What the old corpus could not see

The set was diverse *by subject* — coasts, forests, cities, food, animals — and
narrow along every axis the format is actually sensitive to.

| Axis | State of the 22-image tune split | Why it matters here |
|---|---|---|
| **Skin tone** | 3 portraits, all light-skinned. The one dark-skinned subject (`portrait-mother-child`) was in **holdout**, so no image the constants were tuned on contained dark skin. | The primary metric is a colour-difference metric and the chroma DC/AC ranges are what decide skin reproduction. A tuning set with one narrow skin locus cannot show a chroma allocation that is wrong for the others. |
| **Illuminant** | Daylight or dusk outdoors, plus two daylight flat-lays. No tungsten, no mixed interior, no artificially-lit interior at all. | Interior white points sit far off the daylight locus; the DC chroma ranges and the µ-law chroma curve are sized from corpus statistics. |
| **Key** | No high-key, white-background framing. | Product/e-commerce imagery — a first-class LQIP use case — is mostly high-key, where the DC dominates and clipping behaves differently. |
| **Chroma floor** | **No achromatic photograph.** Lowest mean chroma 0.014; nothing near zero. | 44% of the tier-0 AC payload is chroma. The case where the right answer is "spend none of it" was never scored, and the encoder's degenerate path (max\|AC\| = 0) was never exercised by a sweep. |
| **Spatial frequency** | Mostly smooth landscape gradients; little dense periodic man-made structure. | Selection order and count-vs-precision are decided by where the energy sits. |
| **Orientation** | 19 of 22 at 3:2 landscape, 1 portrait, 0 square. | Aspect and the render grid are format features; §7.5 already showed the harness is blind to aspect *error*, which makes orientation coverage the only lever left. |

### 9.2 What was added

Thirteen Picsum photographs (≥ 12 MP, SHA-256 content-pinned like the rest,
`tools/comparison/src/natural-images.ts`). Nine went to tune, four to holdout;
**no image moved out of holdout**, so the pre-registered validation rule is
intact.

| Label | Picsum id | Split | Axis it fills |
|---|---|---|---|
| `portrait-suit` | 856 | tune | Dark skin, high-key background, daylight |
| `portrait-guitarist` | 836 | tune | Dark skin, cluttered interior, mixed light |
| `portrait-dim-indoor` | 832 | tune | East-Asian skin, dim tungsten interior, low key |
| `natural-cafe` | 513 | tune | Interior, artificial + window light, people |
| `natural-typewriter` | 486 | tune | High-key product framing, near-neutral, **portrait orientation** |
| `natural-facade` | 945 | tune | **Grayscale**, dense periodic structure |
| `natural-snow-forest` | 730 | tune | Near-neutral, low contrast, high key |
| `night-bridge-lights` | 799 | tune | Night with saturated artificial (magenta/purple) lighting |
| `chroma-stripes` | 951 | tune | Flat saturated man-made paint, two-colour |
| `portrait-child-book` | 1010 | holdout | Dark skin, interior |
| `natural-shop` | 1059 | holdout | Interior retail clutter |
| `natural-piano` | 1082 | holdout | **Grayscale**, periodic structure |
| `natural-succulents` | 940 | holdout | Fine texture, **portrait orientation** |

The additions widen the difficulty spread in both directions rather than simply
making the corpus harder: at the shipped tier 0 they span ΔE00 2.11
(`chroma-yellow-wall`, the easiest image in the corpus) to 25.86
(`chroma-stripes`, the hardest by a wide margin), against a corpus mean of
10.18. Because one image now sits ~2.5× the mean, the **median** column of every
sweep is worth reading alongside the mean; the decisions in §8 hold on both.

Two measurement consequences of the grayscale images, both fixed rather than
papered over:

* `cfl-probe` scored an identically-zero chroma channel as "ρ = 0, residual
  100%", i.e. as evidence *against* chroma-from-luma, when the statistic is 0/0.
  It now excludes such a channel and says so (§4.8).
* `rd-gate` gained two images (`portrait-suit`, `natural-facade`) so the CI
  regression gate covers a dark skin tone and the degenerate chroma path.
  Baseline mean ΔE00 **8.9043 → 9.0933** over 8 images (and → 8.8459 once §10
  adopted the recipe); re-verified passing at
  0.00% drift with the working tree, which is also the check that the corpus
  change did not perturb the encoder.

### 9.3 What moved

| Measurement | Old corpus | Revised corpus | Verdict |
|---|---|---|---|
| Shipped tier 0, tune / holdout ΔE00 | 9.565 / 11.364 | 10.434 / 11.554 | Corpus is harder; **no cross-version number comparison is meaningful** |
| Best fixed 32 B layout | L28@4 C15@3 | L28@4 C15@3 | unchanged |
| §8 recipe on holdout | −3.51% | **−3.50%** | unchanged — still clears the pre-registered ≥3% |
| … with refinement | −4.14% | −4.12% | unchanged |
| 21 B vs ThumbHash (holdout) | −6.4% ΔE00, all four metrics | −6.3% ΔE00, all four metrics | unchanged |
| `aniso 1.2 + sel_hv 0.15` on tune | −2.09% | **−1.03%** | **halved** |
| Trainable selection-order headroom | +2.2 energy points | **+1.5** | **shrank** |
| Entropy coding, LOO | −9.1% | −8.7% | unchanged |
| Per-image oracle layout at 108 B | −1.1% | **−2.0%** | grew |
| WebP takes the ΔE00 lead at | 200–400 B | **~190 B** | crossover moved down |
| Precision optimum by budget | 3 b ≤ 20 B, 4 b to ~56 B, 5 b above | same, gains smaller at 16 B (−7.5% → −4.7%) | unchanged |

**Nothing was refuted and nothing was resurrected**: every accepted item in §8
still clears its bar, and every rejected item in §8.4 is still rejected, with
the same sign and comparable magnitude. The two results that changed materially
are both about the *trained selection order* (§7.4, §4.10), and they changed in
the direction the audit predicts: a corpus that is no longer predominantly
outdoor landscape has less of a single dominant orientation structure for a
fixed order to exploit. The lever survives — it is what carries the holdout
verdict from −3.16% to −3.50% — but it is half the size round 2 reported, and
on tune it now adds nothing on top of the retuned layout.

The one claim that genuinely weakened is the upper end of the operating range:
WebP draws level on ΔE00 at ~190 B rather than past 200 B, and at 108 B the
SSIMULACRA2 win over size-matched WebP is holdout-only (§8.6). The defensible
range in §3 is unchanged at its lower end and slightly tighter at the top.

### 9.4 Gaps that remain

The corpus is still a set of professional photographs from one source, and the
following are *not* covered by this revision:

* **Source bias.** Every curated image is Picsum/Unsplash — a professional
  aesthetic. No smartphone snapshots: no sensor noise, motion blur, harsh
  on-camera flash or heavy JPEG history, which is what a real LQIP pipeline
  ingests.
* **Non-photographic content** — screenshots, text-heavy graphics, logos,
  charts. The synthetic fixtures (`illust-*`, `textui-*`) exist but are excluded
  from every `photoOnly` sweep, so no constant has ever been chosen against
  them.
* **Alpha.** The photographic corpus has no transparency, so the alpha-mode
  layout in §8.1 is still unmeasured — flagged there, unchanged here.
* **Perceptual validation (U19).** Still the most valuable missing thing: this
  revision improved *what* is measured, not *whether the metric is right*.

### 9.5 The Wikimedia re-source (2026-09), and what it moved

`85f6af3` replaced the curated photographic corpus with images sourced from
Wikimedia Commons, for licensing reasons rather than measurement ones, and said
plainly that every photographic number would move. It left §1–§11 describing
the retired set. This subsection is the re-run it asked for: every command §6
lists, plus three it does not, re-measured and transcribed by
`verify:experiments --fix`.

The alpha and graphic corpora were untouched by the re-source, so §11.1–§11.4,
§11.3, §11.11 and §11.10's graphics column agree with their previous values to
the last digit. That is the control on the whole exercise — a re-run that
reproduces what did not change is measuring the corpus rather than the weather.

#### What moved

| Measurement | Curated (§9) | Wikimedia | Verdict |
|---|---|---|---|
| Tier 1, tune / holdout ΔE00 | 10.28 / 11.38 | 11.65 / 11.54 | Tune is 13.3% harder; **holdout only 1.4%**, being three-quarters Kodak24 |
| R-D gate, mean of 8 | 8.8459 | 11.1369 | +25.9%, and 0.00% drift against its own baseline |
| Compact tier vs ThumbHash, holdout | wins all four | wins all four | unchanged |
| 108 B vs size-matched WebP, holdout | −9.5% ΔE00 | **−10.8%** | **grew** |
| ΔE00 crossover with WebP | between 193 and 411 B | between 193 and 411 B | unchanged |
| Compact-tier layout | `L19@4 C6@3` | `L19@4 C6@3` | unchanged — but its tie-break no longer separates it (§11.10) |
| `sel_hv = 0.30` vs `0.15`, tune | −0.81%, CI excludes zero | **+0.40%, CI straddles** | **refuted** |
| Best selection-weight arm | `aniso 1.2 / hv 0.30` | **`aniso 0.9 / hv 0`** | **moved to `hv = 0`** |
| Trainable selection-order headroom | +1.5 energy points | **+1.3** | shrank again |
| Entropy-coding headroom at 32 B | −4.3% | **−1.6%** | **more than halved** |
| Entropy-coding headroom at 108 B | −4.0% | **−4.8%** | grew |
| Count-maximal layout vs shipped | 13% worse | **2.9% worse** | **weakened** |
| Scalefactor bands, best arm | −0.30% | **−0.13%** | narrowed, still below threshold |
| Doubling the render raster | inert (−0.05%) | inert *above the bound*, +0.92% below it | **rescoped** (§4.1) |
| CfL with free gains, 32 B / tier 3 | +0.19% / −0.27% | **−0.09% / −0.90%** | **sign flipped** (§7.10) |
| Prefix narrowing, best 4-bit row | +0.04 pp | **−0.68 pp** | **now pays on ΔE00** (§7.5) |
| Metric-targeted RDO optimum | −0.80% | **−0.07%** | **evaporated** (§7.2) |
| `fit2+nearest` at 32 B | −0.43% | −0.30% | narrowed; mode 1 / mode 2 order reversed (§4.4) |
| Count-vs-precision at 32 B | −2.0% | −1.7% | thesis intact, restated (§4.2) |
| Tier 3 vs raw RGB565, ~1.6 kB | pixels win, 5.80 vs 6.26 | **ChromaHash wins, 6.73 vs 6.96** | **inverted** (§2) |

**Nothing that ships changed, and two things that were concluded did.** Every
adopted constant in §8.1 still clears its bar and every item in §8.4 is still
rejected. The two casualties are both *tune-only* selection-order results —
§7.4's matrix and §11.5's `sel_hv = 0.30` — which is the third corpus in a row
to shrink or reverse a selection-order effect, exactly as §4.10 predicts for
anything that exploits a dominant orientation structure.

#### Five defects this found

The re-run was more informative about the tools than about the format.

1. **`rd-budget` synthesized every off-anchor layout a quarter of its budget.**
   `8a2029a` changed `tierFor` to return a tier code; its caller kept reading a
   render level. At the 192 B budget the row was a 53-byte hash scored against
   192-byte competitors, which reads as a quality regression rather than a
   sizing error. Two of §11.14's four conclusions and all of §7.14's U16
   summary are computed from those rows.
2. **`entropy-budget`'s reference row vanished.** The same commit left a lookup
   testing `r.tier === 0`, which no row satisfies any more, so §7.13's source
   table had been printing an empty section for five days.
3. **`verify-experiments --fix` corrupted composite cells.** Rewriting a win
   count `15/31` to `16/31` re-appended the "unit" it had already parsed,
   producing `16/31/31`. It reported success and left seven cells malformed.

4. **Every arm that named a pre-adoption constant was measuring the adopted
   one.** A `tune` string is applied on top of `Tunables::DEFAULT`, so an
   omitted knob inherits whatever ships. Once §10 made the §8 recipe the
   default, an arm labelled `32B SHIPPED L26@5 C9@4` *was* `L28@4 C15@3` with
   the full stack. Four arms of `holdout-candidates` returned one number;
   `thumbhash-headtohead` printed each plain layout and its own `+stack` twin
   as two rows of the twin; `encoder-compute`'s control already contained both
   levers it exists to measure; `final-candidates`'s `hv = 0` arm was
   `hv = 0.15`. §7.4 is the case that was caught before this re-run. It was
   never the only one.

The first two are the same defect: **nothing in the harness distinguishes a
tier code from a render level.** §11.10 records the library hitting this and
solving it with `render_level(tier)`; the tools have no such function, so the
sweep that fixed the library seeded three of these in `tools/comparison`. A
type — or even a named `levelOf`, which is what these fixes add — is the
durable answer, and it is not applied everywhere yet.

The fourth is that defect one level up: a label naming a constant the run does
not set. **Seven configs are fixed here** — `allocation-grid`,
`precision-by-budget`, `encoder-compute`, `holdout-candidates`,
`final-candidates`, `thumbhash-headtohead` and `refine-ablation` — by pinning
all four selection/encoder knobs in every arm, the way `adopted-defaults`
already did and is the only sweep that survived the adoption intact. §4.2, §4.3,
§4.4, §4.5, §4.7, §7.1, §7.6 and §7.12 are re-measured from them.

**Two groups are not fixed, and are disclosed instead.** `selection-hv` is
retired in place (§7.4): a number measured at a point its label does not name is
worse than no number, and `selection-weights` already is its corrected
replacement. Separately, `cfl`, `prefix-shrink`, `retune-32b`,
`combined-optimizer`, `detail-synthesis`, `refine-grid`, `refine-objective`,
`embedded-tiers` and `budget-ladder-optimized` carry an inaccurate *incumbent
label* but a valid set of deltas around it, because every arm in them shares one
base. Relabelling would move no number and would change the row keys the
bindings match on, so they are left alone: read their "shipped" row as "the
default as of that run", not as the pre-adoption format.

A check that reconciles an arm's label against the constants it sets would have
caught all of this, and is the obvious next thing to build. It is not in this
change.

5. **A column nobody checks, inside a table that passes.** `verify:experiments`
   binds *columns*, not tables, and a table is reported green when the columns
   it binds agree — saying nothing about the rest. §10.3's Δ%, §7.11's "vs
   native tier 0", §7.10's "vs its own control" and §7.5's `guards` are all
   unbound, and all four were stale; §7.10's had every sign inverted and §7.5's
   had two cells reading `ok` for arms that fail their guards. §11.14's byte
   column is the same problem, which is why the current cross-format record
   carried a stale x-axis while its four metric columns were re-transcribed.

   This is "a SKIP is not a pass" one level down, and it is worse, because a
   SKIP is at least printed. The unbound columns are invisible: nothing in the
   output distinguishes a table whose four columns were all checked from one
   where three were. Listing them is a few lines against the existing bindings —
   `--list-unbound` already does the table-level version — and it is the second
   obvious thing to build.

#### What was not re-measured

Stated so their absence is not mistaken for agreement:

* **§7.1's first table** (pixel-domain squared error on three source shapes)
  comes from a refine harness that no longer exists as a runnable tool. Its
  second table, the ΔE00 ablation, is bound and re-measured.
* **§2, §3 and §8.6** are the round-1 and round-2 cross-format records,
  explicitly superseded by §11.14 and kept as history. They are not re-run.
* **§10.2's decode timings** are not a corpus measurement.
* Of the unbound derived tables, **§4.2, §4.4, §4.7, §7.2, §7.6, §8.3 and
  §11.12 are re-transcribed** in this change, along with §4.9 and §4.10 — the
  claim that a view onto a current sweep is itself current does not hold, and
  four of them had a conclusion that no longer followed. **§7.9 is not**: its
  alphabet is `selection-hv`'s, so it inherits that config's retirement and
  says so in place. **§11.0, §11.2 and §11.3** are the synthetic fixture and the
  alpha corpus, which the re-source did not touch.
  `verify:experiments --list-unbound` is the full list.

## 10. Adoption: making §8 the default (2026-08)

§8 is now `Tunables::DEFAULT`, `spec/constants.py`, and the normative spec. This
section records what that took, because two of the four changes needed work that
the sweeps did not.

### 10.1 What shipped, and what did not

| §8 item | Shipped? | Where |
|---|---|---|
| Tier-0 layout `L 28 @ 4, a/b 15 @ 3` | **yes** | `LAYOUT_T0`; spec §3.2, §7.4 |
| Selection weights `aniso = 1.2`, `sel_hv = 0.15` | **yes** | spec §6.2 |
| `scale_fit = 2` (scale code by reconstruction SSE) | **yes** | spec §7.2 |
| `ac_nearest = 1` (nearest-reconstruction AC code) | **yes** | spec §7.3 |
| Optional refinement (`refine_*`) | no | §8.2 asks for an encoder quality setting, not a default: −0.3 pp for 54× encode time |
| 21-byte compact tier | no | §8.1's own footnote — tune and holdout disagree on its layout, and the choice should be made against the alpha-mode layout that does not exist yet |
| Alpha-mode tier-0 rebalance | no | never measured; the photographic corpus has no alpha (§9.4) |

Tiers 1–3 keep the 5-bit luma / 4-bit chroma split, so the layout is now a
**two-row table** (§3.2) rather than one base scaled by `4^tier`. That is the
literal reading of §8.1's first line, and `budget-ladder-optimized`/
`final-candidates` measured tier 1 exactly that way — weights and encoder knobs
on, layout untouched.

### 10.2 The blocker, resolved

§8.1 rejected the selection weights as normative on two grounds: the order was a
float comparison, and it cost **+32% decode time**. Both are gone.

**Integer reformulation.** The weight is
`(1 + aniso·sin²2θ)(1 + hv·cos2θ)`. With `s = (cx·H)²`, `t = (cy·W)²`,
`p = s + t` and `d = s − t`, the identities `cos2θ = d/p` and
`sin²2θ = 1 − (d/p)²` collapse *both* factors into polynomials in the single
ratio `d/p` — which is what makes an exact integer form possible at all. The
naive route (cross-multiplying the two rationals) needs 173 bits and is useless
to a JavaScript implementation; evaluating `d/p` once in Q12 and carrying the
weight in Q16 keeps every intermediate under **2^51** at every tier, so a
language with exact 53-bit integers computes it without a bignum. Spec §6.2.

Q12 is not a compromise: over all 256 aspect bytes at tier 0 the integer order
is **identical to the float order, coefficient for coefficient**, at every K the
format uses, and at tiers 1–2 it selects identical *sets* (it permutes within
them, which changes nothing a decoder can observe because encoder and decoder
share the order). `dct.rs::integer_selection_key_matches_the_real_valued_weight`
pins the first claim in CI; `spec/validate.py` and the 610 `unit-selection.json`
vectors — now emitted twice per `(W, H, K)`, once with the weights zeroed and
once with them on — pin the arithmetic across implementations.

**The +32% was never the weights.** It was the prototype recomputing a float key
inside the sort comparator, `O(n log n)` times. Computing the integer key once
per candidate, and sorting the candidate grid **once per (aspect, tier)** instead
of once per channel — every channel's selection is a prefix of the same list —
makes the shipped weighted decode ~8% *faster* than the unweighted v0.6 path it
replaces:

| decode, 32×32 natural render | ns/decode (3 runs) |
|---|---|
| v0.6: unweighted, one sort per channel | 391.6k / 395.8k / 399.8k |
| v1: weighted, one sort per (aspect, tier) | 356.8k / 318.0k / 348.4k |

> **What this table is, and is not.** It is an A/B of two decode implementations
> at one fixture, run to show that the +32% is gone — not a decode-latency figure.
> Mind the units: the `k` suffix is thousands of **nanoseconds**, so these cells
> are fractions of a millisecond, not the microsecond figures a decode-cost table
> reports.
>
> The candidate sort is **inside the timed region on both rows**, because it is
> inside the shipped decode: `SelectionOrder::new` is constructed on every
> `decode()` call (`rust/src/decode.rs`), and there is no selection cache in the
> crate. "Once per (aspect, tier)" means once per *decode* rather than once per
> *channel* — every channel's selection is a prefix of the same list — not
> memoization across calls. So the v1 row is the shipped path, and the ~8% is a
> like-for-like saving.
>
> It is also **unbound and ungated**: beyond a repeat count of three it names no
> host, no per-run iteration count and no warm-up, and §6 lists no command that
> reproduces it. `verify:experiments` does not check it — the table carries no
> binding, so the checking loop never reaches it; the note beside it
> (`"10.2#0": "decode timings, not a corpus measurement"`) is an audit trail
> printed by `--list-unbound`, not an exemption the gate enforces. Do not quote
> it as the cost of a decode. [`PERFORMANCE.md`](PERFORMANCE.md) §2
> is where decode cost lives, and its `decode/Rust/t1/natural` cell is what should
> replace this table once a re-measurement lands.

### 10.3 Verification

`adopted-defaults` runs the new `Tunables::DEFAULT` with **no overrides at all**
against a hand-reconstructed pre-adoption arm, and must reproduce the
`final-candidates` rows exactly — if it does, the default change is the measured
change and nothing else moved:

| | ΔE00 | Δ% | SSIM2 | Butter | DSSIM |
|---|---|---|---|---|---|
| holdout, tier 0, pre-adoption | 11.735 | — | −318.4 | 28.66 | 0.2630 |
| holdout, tier 0, **DEFAULT** | **11.298** | **−3.72** | **−303.7** | **28.16** | **0.2623** |
| holdout, tier 1, pre-adoption | 9.696 | — | −184.9 | 23.00 | 0.2589 |
| holdout, tier 1, **DEFAULT** | **9.517** | **−1.84** | **−174.1** | **22.75** | **0.2582** |
| tune, tier 0, pre-adoption | 11.655 | — | −349.1 | 30.64 | 0.2641 |
| tune, tier 0, **DEFAULT** | **11.473** | **−1.56** | **−341.7** | 30.38 | **0.2638** |

Every cell matches §8.3. The R-D gate baseline moves with it, 9.0933 → **8.8459**
(−2.72% over the 8 gated photos), and `spec/test-vectors/` was regenerated: the
hashes in `integration-*.json` and `unit-validate.json` change, which is the
point — the format's output moved.

### 10.4 What adoption exposed

* **The tier-0 and tier-1 rows now disagree on bit width**, so `4^tier` scaling
  no longer describes the whole ladder. Everything that assumed one base — the
  length formula, the decode pseudocode, `spec/validate.py`'s "AC payload scales
  ×4^tier" check — is now scoped to tiers 1–3.
* **`sel_hv` breaks portrait/landscape symmetry**, deliberately: `cos2θ` flips
  sign under the transpose, so a landscape image and its portrait mirror no
  longer select mirrored frequency sets. `validate.py` now *asserts* the
  asymmetry, so it cannot be quietly "fixed" back out.
* **`scale_fit` and `ac_nearest` are encoder-only but not optional.** The repo
  requires byte-identical output across implementations, so the search order and
  tie-breaking rule (`[0, −1, +1, −2, +2]`, strictly-better wins) had to become
  normative text, not encoder freedom. Spec §7.2, §7.3.
* **The pure-TypeScript decoder is not synced.** `typescript/src/decode.ts` has
  had no commit since before v1 landed — it still carries the v0.6 framing and
  layout — so it was already non-conforming before this change and is not made
  conforming by it. Every other binding is FFI over the Rust core and follows
  automatically. That port is its own piece of work.

## 11. Stabilizing v0.7 (2026-08)

§10 adopted the recipe §8 converged on. This section is the work of deciding
whether v0.7 can be called stable: every constant the format ships was either
re-derived on the current corpus and current bit depths, or measured for the
first time.

Three things made that possible and are worth stating before the results,
because each of them changed what a measurement means:

| Change | Why the numbers below could not be taken without it |
|---|---|
| **Two new corpora** (§11.0) | The alpha-mode layout cannot be measured on a corpus with no transparency, and no constant had ever been chosen against non-photographic content. |
| **Alpha scored as alpha** (§11.0) | Both sides were composited over opaque white before any metric ran, so alpha error was folded into colour error against one background. |
| **`forceOpaque` control** | The alpha corpus is cut-outs and line art — graphic-like content — and the graphics corpus independently prefers more luma. Without a control, "alpha mode wants a different layout" and "this content wants a different layout" are the same measurement. |

Every decision below is taken on the **tune** split. Holdout is consulted once,
at the end (§11.12), for the assembled candidate — repeatedly consulting it
would make it a second tune set.

### 11.0 What the measurements needed first

**The corpora.** 24 `cutout-*` images with real transparency (non-opaque
fraction 0.118–0.912, soft-edge fraction 0.000–0.293, so hard binary masks and
anti-aliased edges are both represented) and 24 `graphic-*` images (screenshots,
charts, maps, schematics, comics, dense text). Both content-pinned by SHA-256,
16 tune / 8 holdout, split by position in the sorted label list so the split
never depends on a result. The generated `alpha-*`, `illust-*` and `textui-*`
synthetic fixtures stay out of both: they are 8×8 correctness cases for a code
path, not content to tune against. The new prefixes sit outside
`CORPUS_PREFIXES`, so every photographic sweep still sees 31 tune / 32 holdout
images and no number in §1–§10 moves.

**Alpha scoring.** `ALPHA_BACKDROP` composited both sides over opaque white
before any metric ran. On a 32×32 near-white test image whose left half is fully
transparent, against a decode with alpha completely wrong (fully opaque):

| scoring | ΔE00 |
|---|---|
| white backdrop only | 6.06 |
| white + black + mid-grey | **17.49** |

The single white backdrop hides roughly two thirds of the error, so a layout
sweep scored that way is largely ranking colour. Alpha experiments below score
over three backdrops and additionally report a direct alpha-plane mean absolute
error (αMAE), which reads 0.5000 on the test above — arithmetically what a
half-wrong alpha channel should give.

### 11.1 The alpha-mode tier-0 layout — the shipped split is wrong

The opaque row was rebalanced to `L 28 @ 4 / C 15 @ 3` in §8; alpha mode still
carried v0.6's `L 20 @ 5 / C 9 @ 4` purely because nothing could measure it.
`sweeps/alpha-layout.json`, 34 layouts all at exactly 32 bytes, tune split. Every arm
pins the alpha AC allocation explicitly: a config that overrides only part of a layout
inherits the rest from the shipped default, so once §11.3 moved that default these arms
would have silently stopped being 32 bytes. It is the same class of drift the corpus pins
exist to prevent, in the knob space rather than the corpus, and it is worth stating
because a sweep that quietly changes budget mid-campaign reports a comparison nobody made.

| layout | ΔE00 | Δ% | paired 95% CI | win/n |
|---|---|---|---|---|
| **shipped** L20@5 C9@4 | 15.689 | — | — | — |
| L22@4 C14@3 (the arithmetic in §8.1) | 15.541 | −0.94% | [+0.053, +0.251] | 15/16 |
| L29@4 C9@3 | 15.497 | −1.22% | [+0.058, +0.353] | 12/16 |
| L36@3 C10@3 | 15.432 | −1.64% | [+0.093, +0.452] | 13/16 |
| **L43@3 C11@2** | **15.401** | **−1.84%** | [+0.107, +0.518] | 13/16 |

The shipped layout is significantly worse than a dozen alternatives, and the
direction is consistent: alpha mode wants **more luma coefficients at lower
precision, and much less chroma** than the opaque row does.

### 11.2 That direction belongs to alpha mode, not to the corpus

The alpha corpus is cut-outs and insignia. §11.4 finds that non-photographic
content independently prefers more luma, so the §11.1 result could be nothing
but a statement about cut-outs. `sweeps/alpha-layout-control.json` re-runs the
grid on the **same images**, flattened to opaque and encoded in the format's
opaque mode:

| layout | opaque mode (control) | alpha mode (§11.1) |
|---|---|---|
| v0.6 shape L26@5 C9@4 | 15.180 (base) | — |
| **the photographic winner** L28@4 C15@3 | **14.673 (−3.34%)** | — |
| L35@3 C16@3 | 14.583 (−3.93%) | — |
| L46@4 C2@3 (chroma-starved) | 15.085 (−0.63%) | — |
| L39@4 C2@3 (chroma-starved) | — | 15.500 (−1.20%) |

In opaque mode on this content the photographic layout is near-best and
chroma-starved layouts are *mediocre*. In alpha mode the same chroma-starved
layouts *win*. The shift is a property of alpha mode: transparent regions are
composited away, so chroma spent on them buys nothing.

### 11.4 Non-photographic content — the photographic constants hold

No constant in this format had ever been chosen against a screenshot, a chart
or a page of text. `sweeps/graphics-layout.json` re-runs the same 32-byte
allocation grid that chose the tier-0 layout (§4.2) on the graphics corpus,
with the adopted default as incumbent; `sweeps/graphics-encoder.json` does the
same for the encoder stack. Both run with `forceOpaque`, because two of the 16
tune images carry real transparency and would otherwise encode in alpha mode,
where none of an opaque-layout arm's overrides apply — contributing an identical
constant to every arm and diluting every delta, which biases a layout test
toward exactly the "no difference" verdict it is trying to test for.

**Layout.** The photo-derived `L 28 @ 4 / C 15 @ 3` is not the graphics
optimum, but it is close to it and the gap does not justify a second constant:

| layout | ΔE00 | Δ% | paired 95% CI |
|---|---|---|---|
| **DEFAULT** L28@4 C15@3 | 10.450 | — | — |
| pre-adoption L26@5 C9@4 | 10.569 | +1.14% | [−0.300, +0.022] |
| L30@4 C13@3 | 10.394 | −0.54% | [+0.008, +0.102] |
| L40@4 C7@3 | 10.344 | −1.01% | includes zero |

Exactly one arm reaches significance, by 0.54%. Graphics wants slightly more
luma and less chroma — the same direction as alpha mode, for the same reason
that structure matters more than colour in synthetic content — but at a
magnitude that does not warrant splitting the constant.

**The encoder stack generalizes.** This is the stronger result: every part of
the §8 adoption was chosen on photographs, and it holds on content it never saw.

| variant | ΔE00 | Δ% | paired 95% CI |
|---|---|---|---|
| **DEFAULT** (full stack) | 10.450 | — | — |
| no selection weights | 10.513 | +0.60% | [−0.229, +0.076] |
| no encoder search (`scale_fit=0 ac_nearest=0`) | 10.577 | +1.22% | **[−0.228, −0.039]** |
| pre-adoption (everything off) | 10.766 | **+3.02%** | **[−0.597, −0.114]** |
| `sel_hv = 0.30` | 10.410 | −0.39% | includes zero |

Turning the adoption off costs 3.02% on graphics, significantly. Note the last
row: graphics independently prefers `sel_hv = 0.30` over the shipped `0.15`,
which is the same direction §11.5 finds on photographs.

### 11.5 The selection weights, re-derived — and `sel_hv` is not optimal

`aniso-selection` and `aniso-extended` could not answer this any more. Both
labelled their incumbent "default (isotropic)", which stopped being true the
moment `aniso = 1.2` / `sel_hv = 0.15` were adopted: every delta in them was
measured against the *new* default while claiming the old one. Re-run today they
report `aniso=1.2` as 0.00% different from "isotropic", which is the tell.
`sweeps/selection-weights.json` replaces them with the full 2-D grid, the
adopted pair as incumbent and an explicit isotropic arm.

| variant | ΔE00 | Δ% | paired 95% CI | win/n |
|---|---|---|---|---|
| **DEFAULT** aniso 1.2 / hv 0.15 | 11.473 | — | — | — |
| isotropic (aniso 0, hv 0) | 11.453 | −0.17% | [−0.071, +0.120] | 16/31 |
| **aniso 0.9 / hv 0.0** | **11.392** | **−0.71%** | **[+0.027, +0.143]** | 17/31 |
| **aniso 1.2 / hv 0.0** (shipped aniso, `sel_hv` off) | **11.420** | **−0.46%** | **[+0.011, +0.101]** | 20/31 |
| aniso 1.2 / hv 0.30 | 11.518 | 0.40% | [−0.119, +0.025] | 14/31 |
| aniso 2.0 / hv 0.30 | 11.574 | 0.88% | **[−0.187, −0.025]** | 13/31 |
| aniso 1.2 / hv −0.15 | 11.470 | −0.03% | [−0.076, +0.073] | 19/31 |
| aniso 1.2 / hv −0.30 | 11.553 | 0.70% | [−0.185, +0.014] | 12/31 |
| aniso 3.2 / hv 0.0 | 11.631 | 1.38% | **[−0.265, −0.072]** | 7/31 |

Three findings, and the first two are uncomfortable:

1. **`sel_hv` is worth less than nothing at the shipped `aniso`.** Turning it
   off — `aniso 1.2 / hv 0`, one knob changed — is −0.46% with a CI that
   excludes zero and wins 20 of 31 images. `aniso 0.9 / hv 0` is the grid's best
   arm at −0.71%, also excluding zero. Every arm that clears zero in the good
   direction has `hv = 0`; no arm with `hv ≠ 0` does. Two caveats before anyone
   acts on it: this is 28 arms scored against one incumbent with no multiplicity
   correction, and −0.71% is inside the range §9.3 has already watched a
   selection-order effect halve under a corpus change.
2. **Isotropic is statistically indistinguishable from the adopted weights.**
   On the current corpus the selection weights buy nothing measurable on tune;
   their justification rests entirely on the holdout delta §7.12 recorded
   (−3.16% without them, −3.50% with). §8.1 already called them "the weakest of
   the three constants-level changes"; this is weaker still.
3. **Large `aniso` is real, and negative `hv` no longer is.** Every arm at
   `aniso ≥ 2.0` is significantly worse whatever `hv` does, so the weight is not
   noise. But negative `hv`, which round 3 recorded as significantly worse, now
   is not: `hv −0.15` is −0.03% and `hv −0.30` is +0.70% with a CI straddling
   zero. What survives is a bound on `aniso`, not a sign for `hv`.

> **Round 3 read this grid the other way round**, and its own numbers supported
> it: `aniso 1.2 / hv 0.30` was −0.81% with a CI excluding zero, and the section
> concluded "`sel_hv = 0.30` is significantly better than the shipped `0.15`".
> On the current corpus that same arm is **+0.40%** and its CI straddles zero.
> Nothing about the format changed; the conclusion was carried by a corpus of
> predominantly outdoor landscape, exactly as §4.10 predicts for anything that
> exploits a dominant orientation structure. Neither reading has been validated
> on holdout, and neither should be adopted from tune alone.

### 11.6 µ-law companding, re-derived — stands

`sweeps/companding-family.json`, now pinned to `corpus: "photo"` and re-run at
the 4 b/3 b tier-0 depths rather than the 5 b/4 b depths it was locked against.

| family | ΔE00 | Δ% |
|---|---|---|
| **µ-law µ_L=5 / µ_C=8 (shipped)** | 11.473 | — |
| µ_L=7 | 11.480 | 0.06% |
| µ_C=12 | 11.475 | 0.02% |
| A-law 87.6 (G.711) | 11.666 | 1.69% |
| power-law 0.75 (AAC/MP3) | 11.527 | 0.47% |
| power-law 0.9 | 11.599 | 1.10% |
| Lloyd-Max L+C (trained on this corpus) | 11.498 | 0.22% |

Every alternative family is worse, including codebooks trained on the corpus
being scored. The µ plateau §4.6 reported survives both the corpus revision and
the bit-depth change: every µ_L ∈ {4…7} lands within ±0.06% of the shipped µ_L = 5.

### 11.7 Deadzone, re-derived — and it was measuring nothing

`sweeps/deadzone.json`. The first re-run reported every arm byte-identical to
the base. That was not a
result: adopting `ac_nearest = 1` had silently killed the knob. The deadzone
forces a small coefficient to the exact-zero centre code, and the ±2
reconstruction search then runs on that code — for a small value the
nearest-reconstruction code is always inside ±2, so the search undid every
deadzone decision it was handed. The encoder produced identical bytes at
`deadzone_l` = 0, 0.05 and 0.2.

A fired deadzone now short-circuits the search, and the knob measures again:

| variant | ΔE00 | Δ% |
|---|---|---|
| **no deadzone (shipped)** | 11.473 | — |
| `deadzone_l = 0.02` | 11.473 | 0.00% |
| `deadzone_l = 0.05` | 11.482 | 0.08% |
| both = 0.03 | 11.472 | −0.01% |

Rejected — now on evidence rather than on an artifact.

Three arms still read exactly 0.00%, and for a real reason rather than the old
one: the quantizer's zero bin is already wider than those deadzones, so nothing
falls inside them. The bin scales with the code width, so the threshold differs
per channel — luma is 4-bit at tier 0 and chroma 3-bit, and chroma's bin is
correspondingly wider. Sweeping past it confirms the knob is live on both
channels: `deadzone_c` first moves the output at 0.15, and moves it further at
0.4. The rejection stands on the arms that do fire.

A knob that cannot move the output is worse than a rejected one, because the
next sweep to touch it draws a conclusion from a constant.

### 11.8 Quantization ranges, re-derived — stand

`sweeps/quant-ranges.json`: `max_l_scale` ∈ {0.35, 0.5, 0.65}, `max_a/b_scale`
∈ {0.1, 0.125, 0.15}. Every arm lands within **±0.17%** of the shipped values
and every guard holds. The ranges are sized to the signal, as `RATIONALE.md`
claims; the claim now rests on the current corpus.

### 11.9 Scalefactor bands, re-derived — still below threshold

`sweeps/scalefactor-bands.json`: the best arm (`band_gain_l = 0.7` with the
band split at 0.3, high-band luma scaled down) is worth **−0.13%**, against the
−0.52% at tier 1 `RATIONALE.md` records and the −0.30% round 3 measured. Real,
small, and it costs a signalled band split it cannot pay for. Not adopted; the
verdict is unchanged and the margin under it has narrowed twice running, which
is the more useful thing to know about it.

### 11.10 The compact tier — a plateau, tie-broken across corpora

§8.1 proposed a 21-byte tier and left its layout open, noting that tune and
holdout disagreed (`L 19 @ 4` vs `L 26 @ 3`). `sweeps/compact-tier.json`
measures 15 layouts, all at exactly 21 bytes, at tier 0 with raw layout
overrides — the same way §7.6 measured it, so the layout is decided before a
tier code is spent on it.

| layout | ΔE00 | Δ% vs shipped shape | paired CI vs the leader |
|---|---|---|---|
| shipped shape L13@5 C6@4 | 12.573 | — | **[−0.580, −0.288]** |
| **L19@4 C6@3** | **12.147** | −3.39% | (leader) |
| L26@3 C6@3 | 12.161 | −3.27% | [−0.090, +0.062] |
| L18@4 C7@3 | 12.175 | −3.16% | [−0.098, +0.023] |
| L16@4 C8@3 | 12.240 | −2.65% | **[−0.195, −0.002]** |
| L24@3 C7@3 | 12.181 | −3.12% | [−0.106, +0.032] |
| L20@4 C5@3 | 12.227 | −2.75% | [−0.204, +0.012] |
| L35@3 C2@2 (count-maximal) | 12.279 | −2.34% | **[−0.403, +0.120]** |
| L19@5 C2@4 (precision-maximal) | 12.436 | −1.09% | **[−0.501, −0.130]** |

The extremes are decisively rejected and the shipped shape is decisively beaten
— by 3.39% — but **the leading five layouts are a plateau**: their paired CIs
against the leader all include zero. Only `L16@4 C8@3` has separated from the
group, and it separated downward. The photographic split still cannot choose
among the five, and squeezing its guard metrics for a winner would be mining
noise.

The *identity* of the leader did move, though, and toward the layout that
shipped: on the old corpus `L18@4 C7@3` led and `L19@4 C6@3` sat second, and
that ordering is now reversed. Nothing separates them — the CI between them
straddles zero either way — which is the point of calling it a plateau.

So the tie is broken on new information rather than on a second look at the same
data: which candidate holds up on the graphics corpus, which a compact tier will
also be asked to carry (`sweeps/compact-tier-graphics.json`).

| layout | photo rank | graphics ΔE00 | graphics rank | rank sum |
|---|---|---|---|---|
| **L19@4 C6@3** | 1 | 10.855 (−2.78%) | 3 | **4** |
| L26@3 C6@3 | 2 | 10.813 (−3.16%) | 2 | **4** |
| L24@3 C7@3 | 5 | 10.885 (−2.52%) | 5 | 10 |
| L20@4 C5@3 | 9 | 10.783 (−3.43%) | 1 | 10 |
| L18@4 C7@3 | 4 | 10.917 (−2.22%) | 7 | 11 |
| L16@4 C8@3 | 11 | 11.060 (−0.94%) | 8 | 19 |

The graphics column is unchanged — `85f6af3` re-sourced the photographic corpus
only — so every rank that moved here moved because of the photo column.

Neither rank column is machine-checked (only `graphics ΔE00` is bound), and the
two are drawn from **different pools**: 15 layouts on the photographic sweep
against 9 on the graphics one, so a photo rank of 11 and a graphics rank of 8
are not the same distance from last. That does not touch the tie the section
turns on — both layouts sit 1st/2nd and 3rd/2nd, whichever pool you score them
in — but the larger sums are softer than they look, and are not a metric to
carry anywhere else.

**The choice is unchanged and its justification is not.** On the old corpus the
rank sum separated `L19@4 C6@3` (5) from `L26@3 C6@3` (10) and that gap is what
broke the tie. The two now **tie at 4**, so the rank sum no longer decides
anything. What decides it instead is stronger evidence than round 3 had:
`L19@4 C6@3` leads the photographic corpus outright, which it did not before,
and it is the layout §8.1 chose on tune and the one that shipped.

Read carefully, that is a tie-break rule failing and the conclusion surviving on
other grounds — not a rule confirming itself twice.

> **Superseded.** The paragraph below records the code-4 placement as it was
> built. It did not ship that way: `f6417d3` reordered the tier codes by quality before
> release, so the compact tier is code **0**, `MAX_TIER` is 4, and
> `render_level(tier) = tier.saturating_sub(1)` needs no special case. The
> reasoning below — that shifting by the raw tier code is the hazard, and that
> `MAX_TIER` must keep meaning "highest *quality* tier" — is what carried over
> and is why the renumbering was safe. `RATIONALE.md` ("Tier codes ordered by
> quality") records why code 4 was rejected.

**Implementation.** The compact tier is code 4, taken from the formerly-reserved
`4..=7` range, so a v1 decoder written before it existed rejects it rather than
mis-decoding it. It renders at tier 0's resolution and scales coefficient counts
by 1.

That last sentence is the whole hazard. Code 4 is numerically *above* tier 3 and
*below* tier 0 in quality, and two places shifted by the raw tier code —
`decode_output_size` (`w << tier`) and `tier_count_scale` (`1 << 2·tier`) —
which would have made "compact" a 512 px render at 256× the coefficients. Both
now shift by a `render_level(tier)` that maps code 4 to level 0. `MAX_TIER`
keeps meaning "highest *quality* tier" and validation moves to `is_valid_tier`.

The distinction was already load-bearing: two tests built their invalid-tier
fixture as `MAX_TIER + 1`, which is now the compact tier. One of them is in the
shared cross-language vectors, where it had been asserting `InvalidTier` and
began failing with `LengthMismatch` — a parity vector quietly testing the wrong
thing. `unit-validate.json` now pins `valid_compact` and `valid_compact_alpha`
too, so an implementation that rejects code 4 outright is caught by the gate.

### 11.3 The alpha channel is starved — the largest result of this round

The alpha field widths were never tunable, so this had never been asked.
`sweeps/alpha-fields.json` asks it, trading each field against luma so every arm
stays at exactly 32 bytes:

| variant | ΔE00 | Δ% | αMAE | guards |
|---|---|---|---|---|
| **shipped** alpha DC 5 b, scale 4 b, AC 5 @ 4 b | 15.689 | — | 0.2625 | — |
| alpha DC 4 b (−1) | 15.708 | +0.12% | 0.2623 | ok |
| alpha scale 3 b (−1) | 15.677 | −0.08% | 0.2613 | ok |
| **A 8 @ 4** (+3 coefficients, −3 luma) | 14.884 | **−5.13%** | 0.2316 | ok |
| **A 12 @ 4** (+7 coefficients, −6 luma) | 14.465 | **−7.80%** | 0.2139 | ok |
| A 3 @ 4 (−2 coefficients) | 17.005 | +8.39% | 0.3030 | FAIL |
| A 0 (no alpha AC at all) | 19.428 | **+23.84%** | 0.3812 | FAIL |

The field *widths* are asymmetric. Taking a bit *off* is noise — ±0.12% on the
DC and scale — but adding one costs an alpha coefficient and is not: `dc 6b`
scores +4.28% and `scale 5b` +4.06%, both failing guards. Narrowing is free;
widening is not, on the DC and scale
codes. The **count** is not. Five AC coefficients cannot describe a silhouette,
and a silhouette is what a cut-out placeholder mostly is. Removing them costs
24%; adding seven buys 7.8%, more than the entire §8 adoption bought at tier 0.

`sweeps/alpha-ac-count.json` and `sweeps/alpha-ceiling.json` follow the ladder
to the point where the budget runs out. It is monotone for a long way:

| allocation | ΔE00 | Δ% | SSIM2 | Butter | αMAE |
|---|---|---|---|---|---|
| shipped A5@4 L20@5 C9@4 | 15.689 | — | −393.8 | 57.38 | 0.2625 |
| A12@4 L18@4 C9@4 | 14.348 | −8.54% | −374.2 | 50.95 | 0.2139 |
| A20@4 L20@5 C1@4 | 13.526 | −13.79% | −356.2 | 46.63 | 0.1777 |
| **A28@3 L22@4 C3@3** | **13.005** | **−17.10%** | **−339.9** | 44.48 | 0.1632 |
| A40@3 L13@4 C3@3 | 12.906 | −17.74% | −344.8 | 43.38 | 0.1515 |
| A48@3 L7@4 C3@3 | 12.885 | −17.87% | −349.1 | 43.34 | 0.1423 |
| A32@2 L24@4 C5@3 | 13.880 | −11.53% | −366.1 | 61.43 | **FAIL** |

Three things fall out.

1. **Alpha needs at least 3 bits per coefficient.** Every 2-bit arm fails the
   Butteraugli guard (58.7–64.6 against 42.9–45.3), whatever the count.
2. **The coefficients are better bought from chroma than from luma.**
   `A20@4 L20@5 C1@4` beats `A20@4 L10@4 C9@4` (13.526 vs 13.619) while keeping
   the full luma budget: transparent regions are composited away, so chroma
   spent on them buys nothing. Holding the alpha count fixed, shrinking chroma is
   near-free: across every C3-vs-C5 pair the mean difference is under 0.05 ΔE00
   and the largest single-image difference is 0.59 (`cutout-navy-crest`), against
   a 15.7 ΔE00 baseline. It is not strictly monotone — at `A12@4` and `A16@4`
   the C5 arm edges the C3 one by 0.008 and 0.029 — and no pair isolates chroma,
   since every C3→C5 swap also moves luma to keep the budget. The honest reading
   is that chroma is nearly inert here, not that less of it is always better.
3. **The mean hides a trade, and the trade decides the constant.**

| allocation | all | mostly opaque (<35% transparent) | mostly transparent |
|---|---|---|---|
| A28@3 L22@4 C3@3 | −17.10% | **−7.42%** | −22.60% |
| A32@3 L19@4 C3@3 | −17.19% | −6.79% | −23.09% |
| A40@3 L13@4 C3@3 | −17.74% | −5.68% | −24.58% |
| A48@3 L7@4 C3@3 | −17.87% | −3.86% | −25.82% |

Pushing the alpha count higher buys transparent images at the expense of opaque
ones, and the mean is driven by this corpus being three-quarters transparent —
a property of the corpus, not of the world. **`A 28 @ 3 b, L 22 @ 4 b,
a/b 3 @ 3 b`** is adopted: it takes −17.10% overall while giving the at-risk
opaque-ish subgroup the largest gain of any **guard-passing** arm (three 2-bit
arms score higher there — −7.5% to −8.5% — but all three fail Butteraugli),
posts the best SSIM2 of the whole sweep, and carries *more* luma than the layout it replaces (22 vs 20).
Choosing the ΔE00-optimal corner instead would trade 0.8 pp of mean for 3.6 pp
of the subgroup most exposed to a different corpus mix.

Not a corpus artifact, checked two ways. **Every one of the 16 images improves**,
including those only 15–22% transparent. And §11.2's control shows the direction
belongs to alpha mode rather than to cut-out content.

**The alpha channel also ran a generation behind the others.** L, a and b go
through `quantize_ac_channel`, where `scale_fit` and `ac_nearest` live; alpha
used a bare per-coefficient quantize against a nominal scale code, the v0.6
path. Routing it through the same code (`alpha_ac_fit`) is worth −0.21% on the
shipped layout and −0.22% on a better one, guards clean
(`sweeps/alpha-encoder.json`).

The knob has to be read against a fixed layout. The row
`alpha_ac_fit @ L22@4 C14@3` is −1.16% against the *shipped* incumbent, but
−0.94 pp of that is the layout and only −0.22 pp is the knob: quoting the
combined figure would overstate it fivefold. Small, free and principled — the
same argument that adopted `ac_nearest` at 0.05% — which is exactly why
§11.12's holdout result gets to overrule it.

### 11.11 Does the alpha finding hold above tier 0?

It has to be asked rather than assumed. Tiers 1–3 share one base row scaled by
`4^(tier−1)` (§3.2), so adopting §11.3 at tier 0 and leaving that row alone
would give **tier 1 fewer alpha coefficients than tier 0** — a higher quality
tier that is worse at the thing that matters most for a cut-out. The tier-1
base budget is the same 192 bits as tier 0's alpha budget, so
`sweeps/alpha-tier1.json` is the same allocations evaluated at 4× resolution.

One arm in that file is **off-budget** and is excluded from the comparison
below: `A20@4 L20@5 C1@4` at 106 B, against the 103–104 B the rest occupy. It
posts the best raw ΔE00 in the file (10.768) and the best SSIMULACRA2 and
Butteraugli, which is what 2–3 extra bytes buys; it is not an equal-budget
result and is not treated as one. (It does *not* take DSSIM — `A16@4 L14@4 C9@4`
does, 0.22150 against 0.22193.) This is the drift `expectBytes` now catches.

| allocation | tier-1 ΔE00 | Δ% | SSIM2 | Butter | αMAE |
|---|---|---|---|---|---|
| shipped A5@4 L20@5 C9@4 | 12.332 | — | −278.0 | 41.89 | 0.1775 |
| A24@3 L22@4 C5@3 | 10.852 | −12.00% | −234.5 | 33.85 | 0.1216 |
| **A28@3 L22@4 C3@3** (the tier-0 choice) | **10.859** | **−11.95%** | −233.5 | 33.93 | 0.1185 |
| A32@3 L19@4 C3@3 | 10.872 | −11.84% | −240.7 | 34.71 | 0.1164 |
| A20@3 L28@4 C3@3 | 10.899 | −11.63% | −224.5 | 34.01 | 0.1240 |
| A16@4 L14@4 C9@4 | 10.987 | −10.91% | −266.4 | 34.07 | 0.1213 |
| A40@3 L13@4 C3@3 | 11.153 | −9.56% | −270.3 | 36.57 | 0.1147 |

Among the equal-budget arms the tier-0 choice is essentially tied for best at
tier 1 — 0.06% behind `A24@3 L22@4 C5@3` — so **one row still serves tiers
1–3** and the `4^(tier−1)` structure is intact. Alpha AC counts are now 16 / 28 / 112 / 448 / 1792 across
compact / 0 / 1 / 2 / 3 — monotone, which `validate.py` asserts.

### 11.12 The holdout, consulted once

Every decision above was taken on tune, with holdout untouched until they were
all frozen. It rejected half of them.
`sweeps/v07-holdout-photo.json` and `sweeps/v07-holdout-alpha.json`, both run
with `--split holdout`.

**Photographic holdout (32 images):**

| candidate | tune | holdout | verdict |
|---|---|---|---|
| `sel_hv` 0.15 → 0.30 | +0.40%, CI straddles (§11.5) | **+0.56%** | **rejected** |
| isotropic weights | −0.17%, CI straddles | +0.62%, guards fail | rejected |
| pre-adoption v0.6-derived | +1.59% | +3.87% | (confirms §8 out of sample) |
| compact 21 B `L19@4 C6@3` | −3.39% | −2.78% vs the shipped shape | adopted |

Holdout ranks the compact plateau differently from tune — `L26@3 C6@3` leads it
at 12.129 against the adopted layout's 12.146 — which is the same tune/holdout
disagreement §8.1 originally flagged for this tier. The pick was frozen before
the holdout was opened and is not revisited on it; the spread across the four
candidates is 0.7%, and all four beat the shipped shape by 2.5–3.1%.

`sel_hv = 0.30` was significant on tune when round 3 took it, pointed the same
way on the graphics corpus (§11.4 — −0.39% there, though its CI includes zero),
and still failed out of sample. The shipped `0.15` stands. This is the split
doing exactly the job it exists for: a result significant on one corpus and
directionally agreed with on a second did not survive a third.

The re-baseline has since removed the premise as well. On the Wikimedia corpus
the tune arm is **+0.40% with a CI straddling zero** (§11.5), so the result the
holdout rejected no longer reproduces in sample either — and what now clears
zero on tune is `hv = 0`, in the opposite direction. The verdict on `0.30` is
unchanged; the reason it is rejected is now over-determined.

**Alpha holdout (8 images):**

| candidate | tune | holdout | verdict |
|---|---|---|---|
| **A28@3 L22@4 C3@3** | −17.10% | **−16.19%**, every guard improving | **adopted** |
| `alpha_ac_fit` | −0.21% | +0.09% | **rejected** |
| A28@3 + `alpha_ac_fit` | — | −14.48% (worse than without) | rejected |
| compact alpha A16@3 L12@4 C1@3 | −13.00% | −6.96%, guards ok | adopted |

The alpha allocation validates emphatically: SSIMULACRA2 −307.2 → −242.7,
Butteraugli 57.56 → 44.36, DSSIM 0.2319 → 0.2179, αMAE 0.2696 → 0.1675.

`alpha_ac_fit` does not, and is left at `false`. It is principled and free, and
it measured −0.21% on tune — but out of sample it is +0.09% alone and makes the
adopted allocation *worse* in combination. The knob stays for a future
measurement; the default does not move on a result that will not replicate.

**The compact tier's positioning claim, on holdout:**

| | bytes | ΔE00 ↓ | SSIM2 ↑ | Butter ↓ | DSSIM ↓ |
|---|---|---|---|---|---|
| ThumbHash | 21.0 | 12.807 | −337.2 | 30.98 | 0.2647 |
| **ChromaHash compact** | **21** | **12.146** | **−333.9** | **30.07** | **0.2638** |

Beaten on all four metrics, out of sample, at ThumbHash's own size — the claim
§8.6 wanted and the shipped constants could not previously make anywhere.

### 11.13 What v0.7 stabilization changed, and what it did not

| Change | Evidence |
|---|---|
| Alpha row → `L 22 @ 4, a/b 3 @ 3, A 28 @ 3` at tier 0 and the tier-1..3 base (the compact tier takes its own, below) | −16.19% holdout, all guards (§11.3, §11.11, §11.12) |
| Compact tier, code 4, 21 B, `L 19 @ 4 / a/b 6 @ 3` (alpha `L 12 @ 4 / a/b 1 @ 3 / A 16 @ 3`) | Beats ThumbHash on all four on holdout (§11.10, §11.12) |
| Deadzone made reachable again | It was byte-identical at every value (§11.7) |

Deliberately unchanged, each with the number that left it alone:

| Kept | Why |
|---|---|
| `sel_hv = 0.15` | 0.30 was better on two tune corpora and **worse on holdout** (§11.12); on the current corpus it is worse on tune too, and `hv = 0` is better — unvalidated on holdout (§11.5) |
| `aniso_oblique = 1.2` | Isotropic is statistically indistinguishable on tune and worse on holdout (§11.5, §11.12) |
| µ-law µ_L = 5 / µ_C = 8 | Every alternative family is worse, including corpus-trained codebooks (§11.6) |
| No deadzone | +0.08% once the knob could move the output (§11.7) |
| Quantization ranges | Every arm within ±0.17% (§11.8) |
| No scalefactor bands | −0.13%, below threshold and unable to pay its signalling (§11.9) |
| Tier-0 opaque layout | Holds on non-photographic content; no candidate significantly better (§11.4) |
| `alpha_ac_fit = false` | −0.21% on tune, +0.09% on holdout (§11.12) |

What is still not measured, and is now the honest list for v0.8:

* **Perceptual validation (U19).** Unchanged and still the most valuable missing
  thing. Every number in this file is metric-based, and §11.12 is a fresh
  reminder that a metric that agrees with itself across two corpora can still
  fail on a third split.
* **Tiers 2–3 alpha**, inherited from the tier-1 measurement rather than
  measured directly.
* **Smartphone-source photographs** — sensor noise, motion blur, heavy JPEG
  history. Both photographic corpora are professional captures.
* **Entropy-coded AC** (−1.6% at 32 B, −4.8% at 108 B), which remains refused
  on the fail-fast O(1) length check rather than on its quality (§7.13).

### 11.14 Cross-format positioning, re-measured against the shipped constants

The tables in §2 and §8.6 were taken before v0.7 and are kept as the record of
those rounds. These are the current figures, and they are the first ones in this
file taken with `rd-budget` running the **shipped tiers** at the shipped byte
anchors rather than a layout synthesized to fill the budget.

That distinction mattered. `allocate()` builds a 5 b/4 b layout — the pre-v0.7
shape — so every previous ChromaHash row in a cross-format table was the old
constants under the current name. At 21 B on holdout the synthesized row loses
SSIMULACRA2 (−342.2) and Butteraugli (32.60) to ThumbHash; the shipped compact
tier wins both. Off-anchor budgets are still synthesized and are now labelled
`(resized)`.

**Holdout split (32 photographs).** Bold marks the leader in a byte
neighbourhood.

| Bytes | Format | ΔE00 ↓ | SSIM2 ↑ | Butter ↓ | DSSIM ↓ |
|---|---|---|---|---|---|
| 21.0 | ThumbHash | 12.807 | −337.2 | 30.98 | 0.2647 |
| **21** | **ChromaHash compact** | **12.146** | **−333.9** | **30.07** | **0.2638** |
| **32** | **ChromaHash tier 1** (default) | **11.298** | **−303.7** | **28.16** | **0.2623** |
| 47.7 | WebP | 15.586 | −378.3 | 36.16 | 0.2746 |
| 62.9 | lqip-modern r8 | 13.458 | −328.3 | 30.40 | 0.2649 |
| 63.5 | WebP | 12.541 | −283.7 | 27.47 | 0.2632 |
| 79.6 | WebP | 11.423 | −226.8 | 24.90 | 0.2612 |
| 83.8 | lqip-modern r16 | 11.517 | **−192.3** | **23.83** | 0.2594 |
| 107.0 | WebP | 10.674 | −184.9 | 23.15 | **0.2580** |
| **108** | **ChromaHash tier 2** | **9.517** | **−174.1** | **22.75** | 0.2582 |
| 132.8 | lqip-modern r24 | 10.524 | −128.8 | 21.38 | 0.2564 |
| 175.8 | lqip-modern r32 | 9.733 | **−92.1** | 19.43 | 0.2521 |
| 188.7 | WebP | 9.091 | −100.4 | **18.83** | **0.2499** |
| 193 | ChromaHash *(resized)* | **8.684** | −119.9 | 20.60 | 0.2554 |
| 271.5 | lqip-modern r48 | 8.321 | −66.3 | 15.83 | 0.2411 |
| 404.8 | **WebP** | **7.518** | **−62.6** | **14.21** | **0.2349** |
| 411 | ChromaHash tier 3 | 7.783 | −76.8 | 17.94 | 0.2507 |

Four things this settles.

1. **The compact tier beats ThumbHash on all four metrics at its own size**,
   out of sample. That is the positioning claim §8.6 wanted and no shipped
   constant set had previously been able to make.
2. **No general codec reaches these budgets.** WebP's smallest usable output on
   this corpus is ~48 B and it scores 15.586 there — worse than ChromaHash at
   **12 bytes** (13.878), which is a clean sweep of all four metrics in its own
   neighbourhood. Between 12 and 48 bytes the comparison set is other LQIPs and
   raw pixels, and ChromaHash leads all of them.
3. **Code 2 (108 B) is the format's strongest point.** It beats size-matched
   WebP on ΔE00 by 10.8% *and* takes SSIMULACRA2 and Butteraugli, losing only
   DSSIM by 0.0002. It also beats lqip-modern at 133 B while being 25 B smaller.
   The margin is wider than round 3 measured, not narrower: 9.5% then, 10.8%
   now.
4. **The structural guards go from ~190 B up, but ΔE00 does not.** In that
   neighbourhood ChromaHash still leads ΔE00 (8.684 against WebP's 9.091), WebP
   takes Butteraugli and DSSIM, and SSIMULACRA2 goes to **lqip-modern r32** at
   175.8 B (−92.1 against WebP's −100.4) — not to WebP, as round 3 recorded and
   as §7.14 already says. The ΔE00 crossover is between 193 and 411 B, where
   WebP does lead all four. The same ordering holds on tune
   (8.785 vs 8.944 at ~190 B). §14.1 of the spec states this rather than
   arguing around it.

The structural weakness §2 identified is narrowed but not gone: lqip-modern
still takes SSIMULACRA2 and Butteraugli at ~84 B, where ChromaHash wins ΔE00 by
13%. The format still buys colour accuracy with structural accuracy; it now does
so over a wider range and loses the trade later.

