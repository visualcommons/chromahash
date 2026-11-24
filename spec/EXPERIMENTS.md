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
> photographic number below — the R-D gate's tier-1 ΔE00 went 8.8459 → 11.1369
> (+25.9%) over its eight images. §1–§11 were re-measured against it, and §12
> was measured on it from the start. **§9.5 records what moved, what was not
> re-measured, and which tables are views onto sweeps rather than
> transcriptions of them** — read it before quoting a figure from this file.
> The alpha and graphic corpora were untouched by the re-source.

> **The holdout is spent (2026-09, #76).** Every "holdout" figure in this file
> was measured on the 32-image split named above, and that split had informed
> a decision in every round (§11.12 lists them), so none of its figures is the
> clean out-of-sample test the pre-registered rule assumes. It is retired: its
> 32 images are now the **`tune2`** split, which is tuning data, and
> `--split holdout` refuses a photographic corpus. The figures stay as what
> was measured, and their committed `*-holdout.json` results still bind them.
> The out-of-sample split for v0.8 is **`holdout2`**: new Commons photographs
> selected on covariates alone, with no encoder run on them. Its 32 images were
> pinned once their list was approved (#103, 2026-10-09). It is sealed: no tool reads it until
> `spec/V0.8-DECISIONS.md` records the decision being answered as frozen,
> and then only once. §6 and §11.12 give the mechanics. The alpha holdout,
> retired in #83 when one of its images was deleted, went the same way (#93):
> its seven surviving cut-outs are `tune2` too, and its replacement is the
> alpha half of `holdout2`, curated on covariates alone, pinned only once its
> list is approved, and behind the same gate.

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
> widths, `cfl_*`, `synth_*`, `interleave`, `trunc_bytes`, `cut_tier`, `ac_coder` — still
> defaults to the shipped behaviour and remains sweep-only.
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
budget at the upper tiers' 26:9 luma:chroma count ratio and 5 b luma / 4 b
chroma precision (`sweeps/budget-ladder.json`, both splits). Points ≤ 80 B
render at the default tier's raster, ≥ 108 B at the next one up — that is the
tier's *raster*, not its byte budget, which the layout override sets directly.

That shape is what codes 2–4 ship at 108, 411 and 1623 B. It is **not** what
the two lower tiers ship: the default tier (32 B) is `L 28 @ 4 / C 15 @ 3` and
the compact tier (21 B) `L 19 @ 4 / C 6 @ 3`, both off this curve and both
better than it at their budget. So the 32 and 21 B columns below are the
ladder's shape at those budgets, not the tiers; the last table in this section
gives the shipped default beside it.

Both splits were re-measured together for v0.7. §4.5 and §7.12 quote an
**earlier** ladder, taken against the pre-adoption v0.6-derived constants, and
keep those numbers: they are what the round-1 and round-2 candidates were
measured against.

| Bytes | 10 | 12 | 14 | 16 | 18 | 21 | 24 | 28 | 32 | 40 | 48 | 64 | 80 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ΔE00 tune | 15.51 | 14.20 | 13.64 | 13.21 | 13.08 | 12.62 | 12.15 | 11.94 | 11.66 | 11.25 | 10.97 | 10.48 | 10.13 |
| ΔE00 holdout | 14.96 | 13.88 | 13.49 | 13.00 | 12.75 | 12.49 | 12.14 | 11.85 | 11.54 | 11.17 | 10.81 | 10.36 | 9.98 |

| Bytes | **108** | 129 | 161 | 189 | 246 | 310 | **411** | 512 | 767 | 1017 | **1623** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ΔE00 tune | **9.67** | 9.41 | 9.06 | 8.81 | 8.42 | 8.14 | **7.83** | 7.63 | 7.25 | 7.03 | **6.75** |
| ΔE00 holdout | **9.52** | 9.23 | 8.93 | 8.73 | 8.39 | 8.09 | **7.78** | 7.56 | 7.20 | 7.02 | **6.77** |

Marginal value collapses far faster than 1/bytes (tune split):

| Interval | 16→32 B | 32→64 B | 64→129 B | 129→246 B | 246→512 B | 512→1017 B |
|---|---|---|---|---|---|---|
| ΔE00 gained per byte | 0.097 | 0.037 | 0.0166 | 0.0084 | 0.0030 | 0.00118 |

Each doubling of the budget buys 36–51% of what the previous one did. The three
upper tier anchors are points on this one smooth curve, and there is nothing
special about 108/411/1623 B beyond ×4 arithmetic above the default. The two
lower tiers sit below the curve, because their layouts were re-derived for
their budgets (§4.2, §11.10) and the ladder's were not:

| 32 B layout | ΔE00 tune | ΔE00 holdout |
|---|---|---|
| ladder shape, L 26 @ 5 / C 9 @ 4 | 11.66 | 11.54 |
| **shipped default, L 28 @ 4 / C 15 @ 3** | **11.48** | **11.30** |

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
> **Claim 3 now depends on the split.** On tune, tier 3 is **6.73** against
> RGB565's **6.96**, so the coding machinery pays for itself at the top of the
> ladder. On holdout it does not: RGB565 scores **6.57** against tier 3's
> **6.77** on ΔE00, though tier 3 still takes SSIMULACRA2 and Butteraugli and
> the two tie on DSSIM (§11.14). This note used to say the claim no longer
> held, from the tune figures alone; `rd-budget` had only been committed for
> holdout, and nothing compared the two. Either way the margin is about 3%, and
> what clearly beats tier 3 at ~1.6 kB is a real codec — on tune WebP 5.79, JPEG
> 5.93, AVIF 5.46 — which is §11.14's finding rather than this one.

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
| 104 L / 36 C (108 B) | 9.668 @32 px | 9.670 @64 px | −0.02% |
| 416 L / 144 C (411 B) | 7.904 @32 px | 7.832 @128 px | 0.92% |
| 416 L / 144 C (411 B) @64 px | 7.833 @64 px | 7.832 @128 px | 0.01% |
| 1664 L / 576 C (1623 B) | 6.748 @64 px | 6.729 @256 px | 0.28% |

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
23.0 against 42 clear it and cost nothing (−0.02%, 0.01%); 23.0 against 21 and
46.0 against 42 do not, and the coefficients the encoder is forced to substitute
for the ones the box denies it cost 0.92% and 0.28%.

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
| L26@5 C9@4 — **shipped** | 11.656 | **9.722** |
| L28@4 C15@3 | 11.547 (−0.9%) | 9.915 (+2.0%) |
| L38@4 C8@3 | **11.457** (−1.7%) | 9.926 (+2.1%) |
| L28@4 C11@4 | 11.543 (−1.0%) | 9.769 (+0.5%) |
| L44@3 C11@3 | 11.661 (+0.0%) | 10.721 (+10%) |
| L29@5 C9@3 | 11.609 (−0.4%) | 9.832 (+1.2%) |

The optimum moves with the budget. Sweeping six precision families across five
budgets (`sweeps/precision-by-budget.json`, tune) gives the trend cleanly:

| Budget | 16 B | 21 B | 24 B | 32 B | 48 B | 80 B | 108 B |
|---|---|---|---|---|---|---|---|
| best luma bits | **3** | **3** | **3** | **4** | **4** | **4** | **5** |
| best ΔE00 | 12.91 | 12.27 | 12.01 | 11.46 | 10.86 | 10.14 | 9.72 |
| shipped-shape ΔE00 | 13.44 | 12.64 | 12.29 | 11.66 | 10.96 | 10.16 | 9.72 |
| gain | −3.9% | −2.9% | −2.2% | −1.7% | −0.9% | −0.2% | 0% |

(`precision-by-budget` sweeps 16/21/24/48/80 B; the 32 B and 108 B columns are
the same six families read off `allocation-grid`, which covers those two
budgets. The two sweeps share an incumbent and agree on it to the digit.)

Chroma wants one bit less than luma where it can: at 32 B, 48 B and 108 B the
best allocation is 4/3, 4/3 and 5/4. It cannot at 16–24 B, where luma is already
on the 3-bit floor and chroma has nowhere below to go, and it does not at 80 B,
where 4/4 (10.141) edges out 4/3 (10.209) — the one budget measured where
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
| shipped shape L13@5 C6@4 | 21 | 12.703 | −399.2 | 35.17 | 0.2691 |
| L26@3 C6@3 | 21 | 12.224 | −360.3 | 31.95 | 0.2682 |
| L19@4 C6@3 | 21 | 12.310 | −375.3 | 32.38 | 0.2675 |
| **L19@4 C6@3 + stack** | 21 | **12.182** | **−373.1** | **32.19** | **0.2664** |
| L22@4 C8@3 + stack | 24 | 11.984 | −364.2 | 31.55 | 0.2654 |

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
| 21 B | 12.703 | — | — | — | 12.679 (−0.18%) |
| 32 B | 11.656 | 11.655 (−0.02%) | 11.640 (−0.14%) | 11.621 (−0.30%) | 11.621 (−0.30%) |
| 108 B | 9.722 | — | — | — | 9.668 (−0.56%) |
| 411 B | 7.910 | — | — | — | 7.827 (−1.04%) |

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

| Variant | Bytes | ΔE00 | Δ% | SSIM2 | Butter | DSSIM | guards (means) | guards (CI) |
|---|---|---|---|---|---|---|---|---|
| shipped | 32 | 11.735 | — | −318.4 | 28.66 | 0.2630 | (base) | (base) |
| L38@4 C8@3 | 32 | 11.577 | −1.35% | −293.7 | 27.18 | 0.2628 | ok | ok |
| L28@4 C15@3 | 32 | 11.490 | −2.09% | −314.3 | 28.29 | 0.2628 | ok | ok |
| shipped + stack | 32 | 11.563 | −1.46% | −311.1 | 28.33 | 0.2628 | ok | ok |
| L38@4 C8@3 + stack | 32 | 11.464 | −2.31% | −287.8 | 27.07 | 0.2624 | ok | ok |
| **L28@4 C15@3 + stack** | 32 | **11.340** | **−3.37%** | −308.1 | 28.10 | 0.2624 | **ok** | ok |
| tier 1 shipped | 108 | 9.696 | −17.38% | −184.9 | 23.00 | 0.2589 | ok | ok |
| tier 1 + stack | 108 | 9.535 | −18.75% | −178.7 | 22.89 | 0.2583 | ok | ok |

**−3.37% holdout ΔE00 with every guard improving clears the pre-registered ≥3%
retune threshold** — the first candidate in the project's history to do so. Two
caveats before it can enter the spec: `aniso` still needs the integer
reformulation `RATIONALE.md` flags, and a changed encoder changes every test
vector even though the decoder is untouched.

Applying the findings across the whole ladder
(`sweeps/budget-ladder-tuned.json`: per-budget luma precision from §4.2, chroma
one bit under luma, plus the three-knob stack, `sel_hv` pinned to 0). The
`pre-adoption shipped` rows are arms of the same sweep: the v0.6-derived format
resized to each budget as §1 resizes it, with the four selection/encoder knobs
pinned off, so both rows of each pair are scored on the same images in the same
run:

| Bytes | 12 | 16 | 21 | 24 | 28 | 32 | 48 | 64 | 108 | 246 | 411 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tune, pre-adoption shipped | 14.24 | 13.20 | 12.70 | 12.23 | 11.95 | 11.66 | 10.96 | 10.51 | 9.72 | 8.64 | 7.91 |
| tune, tuned | 13.60 | 12.72 | 12.18 | 11.98 | 11.61 | 11.44 | 10.80 | 10.49 | 9.66 | 8.48 | 7.91 |
| tune Δ | −4.5% | −3.6% | −4.1% | −2.0% | −2.9% | −1.9% | −1.4% | −0.2% | −0.7% | −1.8% | 0.0% |
| holdout, pre-adoption shipped | 14.23 | 13.28 | 12.73 | 12.29 | 11.97 | 11.74 | 10.94 | 10.51 | 9.70 | 8.57 | 8.00 |
| holdout, tuned | 13.40 | 12.73 | 12.20 | 11.92 | 11.61 | 11.39 | 10.72 | 10.40 | 9.53 | 8.38 | 7.81 |
| holdout Δ | −5.8% | −4.2% | −4.1% | −3.0% | −3.1% | −3.0% | −2.1% | −1.0% | −1.7% | −2.2% | −2.3% |

The gain is largest exactly where the shipped constants were never checked:
−4.5% tune and −5.8% holdout at 12 B, falling to −0.2% and −1.0% at 64 B. The
compact way to say it: **the retuned encoder reaches the pre-adoption default's
quality in 28 bytes instead of 32** (tune 11.61 against 11.66; holdout 11.61
against 11.74) — a 12.5% byte saving at equal quality, with no wire-format
change beyond the layout table.

> **This table was wrong on two counts until the 2026-09 re-measure.** Its
> `pre-adoption shipped` rows were §2's ladder on the *retired* corpus, set
> beside `tuned` rows measured on the current one, so every Δ below them
> compared two corpora: −8.4% at 12 B was a corpus difference, and at 16–411 B
> the printed Δs did not follow from the cells above them at all (16 B read
> −4.8% between 12.35 and 12.78, which is +3.5%). And the `tuned` arms set every
> round-1 knob but `sel_hv`, so they inherited the adopted 0.15 and measured the
> round-2 recipe — at 21–411 B they equalled §7.12's `optimized` row to the
> digit. The arms now pin `sel_hv = 0`, and the pre-adoption rows are measured
> in the same run. The 28-byte claim survives on both splits; the figures it
> quoted (10.40 against 10.43) were the retired corpus's.
>
> From 108 B up the two rows also differ in raster: the tuned arms render at the
> default tier's 32 px and the pre-adoption ones at the upper tier's, which
> §4.1 prices at 0.92% at 411 B. So the upper-budget Δs understate the recipe
> by up to that much, which is consistent with tune reading 0.0% at 411 B.

### 4.6 Companding retune at the new allocation — no effect

µ_L=5 / µ_C=8 were locked against a 5 b / 4 b layout. Re-swept against the 4 b /
3 b winner (`sweeps/retune-32b.json`, tune, on `L38@4 C8@3`): µ_L ∈ {3,4,6,8}
spans 11.406–11.415 against 11.409 at µ_L=5; µ_C ∈ {5,6,12,16} spans
11.401–11.418. The plateau `RATIONALE.md` reports survives the change of bit
depth — µ-law is not the binding constraint at any of these depths.

(Re-transcribed in the 2026-09 re-measure, the first time this sweep's result
was committed. The figures this paragraph carried until then, 10.229–10.286
and 10.246–10.275, were the retired corpus's, which §9.5 did not re-run. The
sweep's arms inherit today's selection and encoder knobs — it is one of §9.5's
disclosed `unpinnedLabels` configs — so this is the plateau on top of the
adopted stack; every arm shares that base, so the spread is still the µ effect.)

### 4.7 Per-image adaptive layout — sized, and small

The decoder reads the DC and scale fields before any AC, so encoder and decoder
could both derive a layout from them with **zero signaling**. Upper bound, from
per-image ΔE00 across the 29-allocation grid (tune):

| | 32 B | 108 B |
|---|---|---|
| shipped fixed layout | 11.656 | 9.722 |
| best single fixed layout | 11.453 | 9.709 |
| per-image **oracle** layout | 11.243 | 9.569 |
| oracle gain beyond the best fixed layout | −1.8% | −1.4% |

A perfect oracle over 29 layouts buys 1.4–1.8%; a header-derivable rule would
capture a fraction of that. Not worth a wire change.

(The best single fixed layout at 32 B is `L40@4 C7@3` at 11.453. Before #102
turned `portrait-african-woman-rusinga` upright it was `L38@4 C8@3`, §4.2's
bolded row, by 0.001; the two now differ by 0.004 the other way — neither gap
is one this corpus can resolve, and §4.2's six-row table still bolds the best
of the rows it lists.)

That the oracle is worth *less* at 108 B than at 32 B is the same finding as
§4.2's: at 108 B the shipped allocation is already within 0.14% of the best
fixed one, so there is little for a per-image rule to recover. The room is at
the low budgets, where the fixed layout is furthest from right.

### 4.8 Chroma-from-luma — the roadmap's "largest expected win" is small

`cfl-probe`, tune split, 26 coefficients per channel with L and chroma sharing
one selection order so index *i* is the same (cx, cy) in all three channels:

* mean |ρ(a, L)| = 0.461, mean |ρ(b, L)| = 0.581
* after a **per-image least-squares** predictor — itself an oracle, since α
  would have to be signaled — residual energy is **74.2%** (a) and **57.7%** (b)
  (five photographs in the split have an identically-zero chroma AC set, for
  which the statistics are 0/0; the probe excludes them from the means instead
  of scoring them as ρ = 0, residual = 100%)

The sign of the correlation flips between images (−0.94 on
`natural-landschaftsschutzgebiet-volkspark-rehberge`, +0.86 on
`night-bas-lica-notre`, both for `a`), so a fixed gain is useless. A 26–42%
energy reduction is ≈0.2–0.4 bit/coefficient; across the default tier's 2 × 15
chroma coefficients that is ~9 bits, against ~10 bits to signal two gains. **By
this estimate CfL does not pay at tier 0**, though by a narrower margin than
round 1 read, and the estimate is not what decides it: §7.10 built CfL and
measured the paid form directly. Reopen at tier 2–3, where per-image gains
amortize over hundreds of coefficients.

(Re-derived in the 2026-09 re-measure. The figures this section carried —
mean |ρ| 0.457 / 0.504, residual 71.5% / 63.2%, and two example images that
are not in the current corpus — were the retired corpus's, and §9.5 did not re-run the
probe. The probe is not a sweep, so nothing binds these; `cfl-probe --split
tune` reproduces them. They were re-run again once #102 turned the one
EXIF-rotated tune photograph upright, which moved each by 0.002 or 0.1 pp.)

### 4.9 Entropy headroom, measured

`coeff-stats`, tune split, µ-law codes, on the `L 26 @ 5 / C 9 @ 4` layout the
tool calls "shipped tier-0" — the pre-adoption default row, and the base codes
2–4 still ship, but not today's `L 28 @ 4 / C 15 @ 3` default (re-run in the
2026-09 re-measure, and again after #102 turned the one EXIF-rotated tune
photograph upright):

| | luma (5 b field) | chroma (4 b field) |
|---|---|---|
| zeroth-order entropy | 4.610 b | 3.855 b |
| entropy conditioned on selection index | 3.710 b | 3.479 b |

Whole tier-0 AC payload: 202 b fixed → **189.2 b** zeroth-order (−6.3%) →
**159.1 b** with a per-index context model (−21.2%). At 32 B that is 1.6 B of
headroom, or 2.6 more luma coefficients.

> **Corrected in §7.13.** Both figures are *in-sample* entropies of the corpus
> that produced them, and the 159.1 b context number does **not** survive
> out-of-sample scoring — 26+18 per-index histograms estimated from 31 images
> over a 31-symbol alphabet are mostly noise. Measured leave-one-image-out with
> a real adaptive coder, the achievable saving is **7.5%, not 21.2%**.

### 4.10 Selection-order headroom, measured

Luma AC energy captured by K=26 of the 200 lowest-frequency candidates (tune):

| Selection | energy captured |
|---|---|
| ℓ2-ball prefix (shipped) | 75.93% |
| best corpus-fixed 26 (trainable, zero signaling) | 77.27% — 6 of 26 slots differ |
| best per-image 26 (oracle) | 88.70% |

The trainable reorder is worth ~1.3 energy points, the same order as the −0.52%
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
| U11 | **Entropy-coded AC with a per-index context model.** | Measured (§4.9): −22.3% of the AC payload in sample, 8.7% out of sample (§7.13). That per-index-table design costs the O(1) length check; register entry D1's table-free total code keeps it, and passes R1 at code 3 only (§13.8). |
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
mise run sweep budget-ladder-tuned                  # §4.5, §7.12 round-1 recipe + pre-adoption ladder
mise run sweep budget-ladder-tuned --split holdout   # §4.5, §7.12, §8.3
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
  --budgets 12,16,18,21,24,28,32,40,48,64,80,108,192,411,1623   # §11.14, generation v1
CHROMAHASH_METRIC_CACHE=off node tools/comparison/dist/rd-budget.js --split tune2 \
  --budgets 12,16,18,21,24,28,32,40,48,64,80,108,192,411,1623   # §11.14, generation v2 (#168)

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
mise run sweep compact-tier-alpha                   # §11.10 compact tier, alpha row
mise run sweep alpha-tier1                          # §11.11
mise run sweep v07-holdout-photo                    # §11.12 tune column
mise run sweep v07-holdout-photo --split holdout    # §11.12
mise run sweep v07-holdout-alpha                    # §11.12 tune column
mise run sweep v07-holdout-alpha --split holdout    # §11.12 (cannot run: #83)
mise run sweep adopted-defaults                     # §10.3
mise run sweep adopted-defaults --split holdout     # §10.3

# Round 4 — the instruments, and the window (§12)
mise run sweep synthesis-window                     # §12.2
mise run sweep synthesis-window-upper               # §12.3
mise run selftest:metrics                           # §12.1, §12.5

# §12.1's orientation table and §12.4's come from a report run, not a sweep, so
# verify:experiments does not bind them. Read them out of output/report.json's
# per-format `local` block.
node tools/comparison/dist/main.js --skip-harnesses --images 'fixtures/natural/chroma-black-and-white.jpg'

# Round 5 — the ladder, and the corpus read by content (§13)
mise run sweep artifact-ladder                      # §13.1 table 0
mise run sweep artifact-ladder-common-grid          # §13.1 table 1, §13.2

# §13.3's table comes from `stratify`, not a sweep, so verify:experiments does
# not bind it. It reads the per-image scores the sweep above already wrote.
mise run stratify artifact-ladder-common-grid --metric spurious --by detail
mise run stratify artifact-ladder-common-grid --metric deficit  --by detail
mise run stratify artifact-ladder-common-grid --metric ringing  --by detail
mise run stratify artifact-ladder-common-grid --metric ciede    --by detail
mise run stratify artifact-ladder-common-grid --metric spurious --by chroma
mise run stratify artifact-ladder-common-grid --metric spurious --by lightness

# Paired intervals, Holm-adjusted p and interval guards for every metric of a
# committed sweep, against its incumbent or any other arm. They read the
# committed results and re-score nothing (§13.2, §13.5).
mise run arms artifact-ladder-common-grid --baseline "code 2 (108 B)"   # §13.2
mise run arms artifact-ladder-common-grid --baseline "code 3 (411 B)"   # §13.2
mise run arms --summary                                                 # §13.5
mise run arms --seed-sensitivity                                        # §13.5
mise run arms --resample-change                                         # §13.5

# The minimum detectable ΔE00 effect per split, from the same committed tune
# results' paired spread. Re-scores nothing and reads no sealed image (§13.6).
mise run mde                                                            # §13.6

# The register's two confirmations on the sealed holdout2 splits (§13.7). Each
# was read once, at the freeze commit 2047f7d; the reads refuse to overwrite a
# committed holdout2 result, so these four lines cannot run again as written.
mise run sweep c1-confirm-photo --split holdout2 --decision C1          # §13.7
node tools/comparison/dist/rd-budget.js --split holdout2 --decision C1  # §13.7
mise run sweep v07-holdout-alpha --split holdout2 --decision C2         # §13.7
mise run sweep alpha-tier1 --split holdout2 --decision C2               # §13.7
# Their verdicts, re-derived from the committed results (re-scores nothing)
mise run register-verdict C1                                            # §13.7
mise run register-verdict C2                                            # §13.7
mise run arms --seed-sensitivity c1-confirm-photo-holdout2 v07-holdout-alpha-holdout2 alpha-tier1-holdout2

# Register D1, entropy-coded AC at codes 2-4 (§13.8): the tune sweep, each
# arm against its own tier's shipped arm, and the tune strata
mise run sweep entropy-coded-ac                                         # §13.8
mise run arms entropy-coded-ac --baseline "t3 shipped"                  # §13.8
mise run stratify entropy-coded-ac --strata                             # §13.8
# Its one holdout3 read, at the freeze commit e3b2eb6; a second read for D1
# refuses, so this line cannot run again as written. Then its verdict,
# re-derived from the committed result (re-scores nothing)
mise run sweep entropy-coded-ac-frozen --split holdout3 --decision D1   # §13.8
mise run register-verdict D1                                            # §13.8
mise run stratify entropy-coded-ac-frozen-holdout3 --strata             # §13.8

# Register D2, embedded tiers (§13.9): the tune ladder, each cut against
# native code k with the same run's tier gap as its margin, overall, per
# stratum, with D2's selection rule and its re-draw under 20 seeds. No cut
# qualified, so D2 read no holdout3
mise run sweep embedded-tiers-ladder                                    # §13.9
mise run stratify embedded-tiers-ladder --embedded                      # §13.9
mise run arms --seed-sensitivity embedded-tiers-ladder                  # §13.9
# and part 1 on the generated fixtures and tune2, which the ladder leaves out
mise run sweep embedded-tiers-identity                                  # §13.9
mise run sweep embedded-tiers-identity --split tune2                    # §13.9

# Register D3, the synthesis window at codes 3-4 (§13.10): the tune sweep,
# each window arm's spurious against shipped code 2 and its ΔE00 and guards
# against its tier's shipped arm, overall, per corpus and per stratum, with
# D3's selection rule and its re-draw under 20 seeds
mise run sweep synthesis-window-codes34                                 # §13.10
mise run stratify synthesis-window-codes34 --window                     # §13.10
mise run arms --seed-sensitivity synthesis-window-codes34               # §13.10
# Its one holdout3 read, at the freeze commit 40bf6f2; a second read for D3
# refuses, so this line cannot run again as written. Then its verdict,
# re-derived from the committed result (re-scores nothing)
mise run sweep synthesis-window-codes34-frozen --split holdout3 --decision D3  # §13.10
mise run register-verdict D3                                            # §13.10

# Register D5, downsampling before the transform (§13.11): the tune sweep at
# native resolution, each downsampling arm's ΔE00 and guards against its
# tier's full-resolution incumbent, overall, per corpus and per stratum, with
# D5's selection rule and its re-draw under 20 seeds; and the paired
# instruction count at 1024x1024 code 1 the selection reads its speed from
mise run sweep downsample-before-dct                                    # §13.11
mise run downsample-instructions                                        # §13.11
mise run stratify downsample-before-dct --downsample                    # §13.11
mise run arms --seed-sensitivity downsample-before-dct                  # §13.11
# Its one holdout3 read, at the freeze commit fd781e3; a second read for D5
# refuses, so this line cannot run again as written. Then its verdict,
# re-derived from the committed result and count (re-scores nothing)
mise run sweep downsample-before-dct-frozen --split holdout3 --decision D5  # §13.11
mise run register-verdict D5                                            # §13.11

# Register D6, the alpha allocation at codes 3-4 (§13.12): the tune sweep,
# each alpha row's ΔE00 and guards against its tier's shipped row, overall,
# per stratum and per opacity half, with D6's selection rule and its re-draw
# under 20 seeds
mise run sweep alpha-tiers34                                            # §13.12
mise run stratify alpha-tiers34 --alpha-tiers                           # §13.12
mise run arms --seed-sensitivity alpha-tiers34                          # §13.12
# Its one holdout3 read, at the freeze commit eec3495; a second read for D6
# refuses, so this line cannot run again as written. Then its verdict,
# re-derived from the committed result (re-scores nothing)
mise run sweep alpha-tiers34-frozen --split holdout3 --decision D6      # §13.12
mise run register-verdict D6                                            # §13.12
mise run stratify alpha-tiers34-frozen-holdout3 --alpha-tiers           # §13.12

# Register D8, the code-0 compact layout (§13.13): the tune sweeps at code 0,
# every layout against the shipped one, on the photographs D8's selection
# rule reads and on the graphics beside them, per stratum, and the seed
# re-draw. D8 is decided in sample (Q13), so it has no holdout3 read
mise run sweep compact-retune                                           # §13.13
mise run sweep compact-retune-graphics                                  # §13.13
mise run stratify compact-retune --strata                               # §13.13
mise run stratify compact-retune-graphics --strata                      # §13.13
mise run arms --seed-sensitivity compact-retune                         # §13.13

# Register D9, chroma-from-luma in an adaptive or conditional form (§13.14):
# the tune sweep, every code's shipped arm and three free CfL arms, then the
# per-image oracle bound overall, per recoverable class, per corpus and per
# stratum, the rule applied to it, and the seed re-draw of the free arms. D9
# is decided on the bound, so it has no holdout3 read
mise run sweep cfl-oracle                                               # §13.14
mise run stratify cfl-oracle --cfl-oracle                               # §13.14
mise run register-verdict D9                                            # §13.14
mise run arms --seed-sensitivity cfl-oracle                             # §13.14

# The #130 reproduction ledger (§13.16): every cited sweep re-run from a fresh
# checkout, empty fixture cache, metric cache off, into results/reproductions/
# (never over a committed result), and the ones #162 moves re-run again at
# 225bdce, the last generation-v1 revision, into results/reproductions/v1/
R=tools/comparison/results/reproductions
for s in alpha-fields alpha-ac-count alpha-ceiling alpha-tier1 compact-tier \
         compact-tier-graphics compact-tier-alpha v07-holdout-photo \
         v07-holdout-alpha embedded-tiers cfl cfl-range selection-weights \
         selection-hv synthesis-window synthesis-window-upper artifact-ladder \
         artifact-ladder-common-grid; do
  CHROMAHASH_METRIC_CACHE=off mise run sweep "$s" --out-dir "$R"         # §13.16
done
CHROMAHASH_METRIC_CACHE=off mise run sweep v07-holdout-photo --split tune2 --out-dir "$R"
CHROMAHASH_METRIC_CACHE=off node tools/comparison/dist/rd-budget.js --split tune2 \
  --budgets 12,16,18,21,24,28,32,40,48,64,80,108,192,411,1623 --out-dir "$R"
CHROMAHASH_METRIC_CACHE=off node tools/comparison/dist/entropy-budget.js \
  --split tune --record "$R"                                            # §7.13, §13.16
# at 225bdce: sweep embedded-tiers, cfl, cfl-range, artifact-ladder and
# artifact-ladder-common-grid with --out-dir "$R/v1", and
# rd-budget.js --split tune2 --formats chromahash --budgets 411,1623 --out-dir "$R/v1"
node tools/comparison/dist/reproduce.js --arms --strata                 # §13.16
mise run arms --seed-sensitivity --resamples 1000 <the 54 results>      # §13.5, §13.16

# Check the tables in this file against the results above
mise run verify:experiments
mise run verify:experiments --list-unbound
```

**The photographic `--split holdout` lines above no longer run** (#76). They
are the commands that produced the committed `*-holdout.json` results, which
record `"split": "holdout"`, the split's name when they were scored. That split
is retired as spent (§11.12), so asking for it refuses and names the
replacement. Its 32 images are `--split tune2` now, which scores the same
pinned bytes and writes `<name>-tune2.json` instead; `verify:experiments`
reads the `-holdout` results, not those, except for §11.14, whose
generation-v2 re-record is `rd-budget-tune2.json` (#168). The alpha line was
already retired (#83); its seven surviving images are `--split tune2` now as
well (#93). The out-of-sample split is `holdout2`: `sweep` and `rd-budget`
read it only with
`--split holdout2 --decision <ID>`, only when `spec/V0.8-DECISIONS.md`
records that decision as frozen, only whole, and only once. A second reading
under the same result name is refused. A config's corpus picks the half it
reads: a photographic config reads the sealed photographs (#76), an alpha
config such as `v07-holdout-alpha` the sealed cut-outs (#93), and each is
fetched only for its own corpus.

The three `--split holdout` lines marked §4.5, §7.6 and §11.14 were **missing
until the §9.5 re-run**, and each is the only source for a table this file
already carried — §11.14's is the current cross-format record. Nothing said so:
`verify:experiments` reports a missing sweep output as SKIP, not as a failure,
so the block could not reproduce three of its own tables and still exited 0.
**A SKIP is not a pass** — read the skip list, or run with `--strict`, which
turns one into a failure.

Every `sweep` and `rd-budget` line above writes its result to
`tools/comparison/results/<name>[-<split>].json`, which is committed, and every
one of them that can still run was re-run from a clean tree at one commit,
`e310475`, for the 2026-09 re-measure: 54 results, per-image scores and
provenance only. The one that cannot is the alpha holdout run (#83).
`verify:experiments --strict` checks this file against them in CI. The three
`node .../dist/*.js --split tune` probes (`cfl-probe`, `coeff-stats`,
`entropy-budget`) and `main.js` are not sweeps, write to the gitignored
`output/`, and are not part of that record.

Five configs in `tools/comparison/sweeps/` are **not** written up above, and are
listed here so their absence is not mistaken for a result being withheld:
`low-budget-allocation` and `v06-vs-v1` were run and superseded before this
file's round-3 numbers were taken, and their outputs no longer survive on disk;
`capped-tier1-vs-tier0`, `scalefactor-bands-t1` and `tier-precision-vs-count`
have not been run on the current corpus. `RATIONALE.md` quotes results from
all three taken on the pre-2026-08 corpus, whose outputs were not kept. None of
them informed an adopted constant.
`compact-tier-alpha` was listed here too, as written but never run. That was
wrong in the way that matters: its committed result reproduces the tune figure
§11.12 quotes for the adopted compact alpha row to the digit, so the run that
figure came from scored these encodes, and no output of it was kept. §11.10 now
reports the sweep.

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
| shipped | 11.656 | — |
| `refine_obj=1` (OKLAB, no clipping model — the control) | 11.638 | −0.16% |
| `refine_obj=0` (gamma sRGB), 2 passes | 11.686 | **0.26%** |
| `refine_obj=0`, 2 passes + dc + scale | 11.741 | **0.73%** |
| `refine_obj=2` (clipped OKLAB), 2 passes | 11.634 | −0.19% |

(Paired against `shipped` over the 31 images, `mise run arms refine-ablation`:
the +0.26% row is [−0.004, +0.065] and the +0.73% row [−0.004, +0.202], both
straddling zero; the −0.19% row is [−0.043, −0.001]. None of the three
survives Holm across the sweep's 16 arms. Drawn at 1,000 resamples the +0.73%
row excluded zero, [+0.001, +0.218], and the −0.19% row did not; §13.5 counts
both among the seven intervals the move to 10,000 turned. So the table is a
consistent direction on 31 images, not a resolved size.)

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
| ΔE00 Δ% | +1.11% | +0.19% | +0.01% | **−0.05%** | +0.01% | −0.02% | +0.30% |

The shape survives — a shallow optimum around `wc ≈ 3`, with 0.5 and 10 clearly
worse either side of it — but the depth does not. Round 2 measured that optimum
at −0.80%; on this corpus it is **−0.05%**, and the arms from `wc = 2` to
`wc = 6` sit inside 0.06 pp of each other and of the incumbent. Adding the DC
and scale coordinates takes it to **−0.22%** (−0.27% at `wc = 4`); four passes
do not improve on two (−0.21%); at tier 1 it is −0.51%.

The comparison round 2 drew against "the retuned 4-bit layout" is no longer
available: `L28@4 C15@3` is the adopted default, so those arms and the plain
`obj3` arms are the same configuration and report the same number. What the
sweep can still say is that refinement on top of today's default buys −0.22%,
not the −1.2 pp round 2 attributed to it.

(This sweep's incumbent is the shipped default rather than a reconstructed
pre-adoption one, so these deltas are refinement measured on top of the adopted
recipe — which is the question worth asking now, and not the one round 2 asked.)

Also measured: `refine_grid=1` moves the objective onto the decoder's natural
render grid (scored against the ideal full-basis downsample of the source)
instead of the encoder input. **It makes no difference this corpus can see** —
11.496 vs 11.502 at `obj=2`, a gap of 0.06% whose paired 95% interval
[−0.001, +0.018] includes zero. That reproduces round 2's reading: the grid was
a red herring; only the error metric mattered. It is also the one claim in this
section the re-baseline left standing, which is what a genuine null looks like
next to an effect that shrank by more than a factor of ten. (Before #102 turned
the one EXIF-rotated tune photograph upright the gap was 0.02%, 11.485 vs
11.488; that image alone moves it, and still inside the interval.)

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
> shipped default, 11.4806, for **six** arms — the four cells of the grid above
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

| Narrowing | bits saved | ΔE00 Δ% | guards (means) | guards (CI) |
|---|---|---|---|---|
| aspect 8 → 5 b | 3 | **−0.17%** | ok | inconclusive |
| aspect 8 → 4 b | 4 | **−0.11%** | **FAIL** | inconclusive |
| scales 6/6/5 → 5/4/4, linear grid | 4 | 0.67% | ok | inconclusive |
| scales 6/6/5 → 5/4/4, **µ-law grid** (`scale_mu=8`) | 4 | 0.08% | ok | inconclusive |
| `b_scale_from_a` (drop the b field) | 5 | 2.20% | **FAIL** | inconclusive |
| DC 7/7/7 → 6/6/6 | 3 | 0.76% | ok | ok |
| all of the above | 15 | 2.65% | **ok** | inconclusive |

(Both guard columns are bound. The point-mean one was once unbound, and two of
its cells were stale: narrowing aspect to 4 b and the all-in row both failed
their guards on means. Once #102 scored the one EXIF-rotated tune photograph
upright, the all-in row's point-mean guards pass and aspect-to-4 b's still fail,
which is how close to the tolerance both sit. On intervals (§13.5) neither they
nor `b_scale_from_a` is *shown* to regress. Each is `inconclusive`, so none of
them passes either.)

Then spend the recovered bits on AC at the same 32 bytes. **On ΔE00 this now
pays.** The best 4-bit-luma row is **−0.73%** against the same layout with the
full prefix, every guard passing: three bits of aspect precision become two more
luma coefficients, `L30@4 C14@3` for `L28@4 C15@3`. That is consistent with
§4.2, where more 4-bit luma is what this budget wants. The best 5-bit-luma row
is +1.32% and fails its guards, so the gain belongs to the 4-bit layouts and not
to the idea in general.

Round 2 measured that same comparison at **+0.04 pp** — nothing — and wrote the
section as a refutation on that basis. On this corpus it is **−0.73 pp**, so the
refutation cannot rest there any more. It rests on the paragraph below instead,
which was always the stronger argument and never depended on the sweep.

Two findings that survive intact:

* **µ-law scale codes work.** Narrowing the scale fields costs +0.67% on a
  linear grid and +0.08% on a companded one. Corpus scales cluster far below
  the range maximum, exactly as expected. If a future revision needs scale bits,
  this is how to take them.
* **U9 is dead.** `b_scale_from_a` costs +2.20% and fails the guards. The two
  chroma scales are not redundant. (§13.5: the ΔE00 cost survives Holm. The
  guard failure is a point-mean one, and on intervals it is `inconclusive`.)

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
| shipped | — | −342.1 | 30.35 | 0.2639 |
| 26 extra coefficients, gain 0.25 | 0.59% | −346.6 | 30.49 | 0.2644 |
| 78, gain 0.5 | 4.54% | −393.2 | 32.22 | 0.2697 |
| 234, gain 0.5 | 6.62% | −433.5 | 33.30 | 0.2755 |
| tier 1, 312, gain 0.5 | +5.0 pp | −279.7 | 25.94 | 0.2701 |

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
| shipped | 32 | 11.481 | — |
| CfL free (gains not paid for) | 34 | 11.470 | **−0.10%** |
| CfL paid, L24@5 C9@4 | 32 | 11.723 | −0.04% vs the same layout without CfL |
| CfL paid on the 4-bit layout | 32 | 11.520 | −0.06% vs its control |
| tier 1 free | 109 | 9.659 | −0.12% |
| tier 2 free | 412 | 7.797 | −0.45% |
| tier 3 free | 1624 | 6.668 | −0.90% |

The `tier 2 free` and `tier 3 free` rows, and the control each is read
against, are **generation v1** (codes 3 and 4 before #162). Re-run on
generation v2, whose code 3 is arithmetic-coded and whose code 4 carries the
window, the free predictor is −0.29% at code 3, no longer surviving Holm, and
−0.92% at code 4 (§13.16); every row above code 2 reproduces to the value at
v1, and every row at codes 1 and 2 at both.

**This column changed sign on the Wikimedia corpus, and it is the one column in
the table nothing checks** — the binding covers `bytes` and `ΔE00`, so the
control deltas were never re-derived when the ΔE00 cells were. Round 2 read a
free predictor as *worse* than none (+0.19% at 32 B), which is not physically
expected and prompted the audit below. Measured now it is slightly better, and
consistently so, growing with tier: −0.10% at 32 B to −0.90% at tier 3. (This
column is re-derived by hand from `results/cfl.json`; it was last re-derived
when #102 turned the one EXIF-rotated tune photograph upright.) The
audit's findings stand; what has changed is that they no longer need to explain
away a paradox:

1. **Gain precision excluded.** Sweeping `cfl_range` over 0.05–1.0 and
   `cfl_bits` to 10 (α step 5·10⁻⁴, effectively exact) leaves it in the
   −0.20…+0.03% band (`sweeps/cfl-range.json`) — every arm but the coarsest
   range a small gain. Quantized gains are not the problem, and were never the
   problem.
2. **The predictor does work.** Residual *energy* after the least-squares gain
   is 74.2% (a) / 57.7% (b) of the original (§4.8) — an amplitude ratio of
   ≈0.86 / 0.76, so the scale field really does shrink.
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
prediction saves: paid at 32 B on `L24@5 C9@4` it is **+2.11% against the
shipped layout**, and on the 4-bit layout **+0.34%**, while against its own
size-matched control it is a wash either way (−0.04%, −0.06%). A −0.10% predictor cannot
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

| Decoded from a 108 B tier-1 hash | ΔE00 | vs native tier 0 (11.481) | SSIM2 |
|---|---|---|---|
| first 32 B, interleaved | 11.957 | **+4.15%** | −378.4 |
| first 32 B, channel-sequential | 12.581 | +9.59% | −319.7 |
| first 48 B, interleaved | 11.221 | −2.26% | −344.2 |
| first 64 B, interleaved | 10.697 | −6.83% | −310.8 |
| full 108 B (either order) | 9.670 | −15.77% | −213.2 |

Interleaving is worth **5.0%** over a sequential prefix at the 32-byte cut, and
progressive costs **~4%** against a native tier-0 encode at the same 32 bytes.
Note the trade the two orders make: a sequential prefix delivers all of the luma
and none of the chroma, so it scores *better* on SSIMULACRA2 (−319.7 vs −378.4)
and much worse on ΔE00. Progressive is affordable; it is an operational feature
(one hash serves every size), not a quality one.

### 7.12 The optimized recipe, validated on holdout

`sweeps/final-candidates.json`, **holdout split**, incumbent = shipped 32 B.
**STACK** = `l1=28:4 c=15:3 aniso=1.2 sel_hv=0.15 scale_fit=2 ac_nearest=1`;
**REFINE** = `refine_passes=2 refine_grid=1 refine_obj=3 refine_wc=3 refine_dc=1 refine_scale=1`.

| Variant | Bytes | ΔE00 | Δ% | SSIM2 | Butter | DSSIM | guards (means) | guards (CI) |
|---|---|---|---|---|---|---|---|---|
| shipped | 32 | 11.735 | — | −318.4 | 28.66 | 0.2630 | (base) | (base) |
| shipped layout + stack | 32 | 11.539 | −1.67% | −308.5 | 28.19 | 0.2626 | ok | ok |
| L36C9 stack | 32 | 11.377 | −3.05% | −287.1 | 27.23 | 0.2623 | ok | ok |
| L32C12 stack | 32 | 11.371 | −3.10% | −296.7 | 27.65 | 0.2624 | ok | ok |
| L30C13 stack | 32 | 11.364 | −3.16% | −302.0 | 27.93 | 0.2624 | ok | ok |
| L28C15 stack, hv = 0 | 32 | 11.340 | −3.37% | −308.1 | 28.10 | 0.2624 | ok | ok |
| **L28C15 stack** | 32 | **11.298** | **−3.72%** | −303.7 | 28.16 | 0.2623 | **ok** | ok |
| **L28C15 stack + REFINE** | 32 | **11.265** | **−4.01%** | −303.0 | 28.14 | 0.2628 | **ok** | ok |
| tier 1 base | 108 | 9.696 | −17.38% | −184.9 | 23.00 | 0.2589 | ok | ok |
| tier 1 stack | 108 | 9.517 | −18.90% | −174.1 | 22.75 | 0.2582 | ok | ok |
| tier 1 stack + REFINE | 108 | 9.489 | −19.14% | −173.0 | 22.78 | 0.2587 | ok | ok |
| tier 2 stack | 411 | 7.783 | −33.68% | −76.8 | 17.94 | 0.2507 | ok | ok |

Both winners clear the pre-registered ≥3% holdout threshold with **every guard
improving**: the constants-only stack at **−3.72%** and the same stack with the
refinement pass at **−4.01%**. `sel_hv = 0.15` generalizes — it beats `hv = 0`
out of sample, −3.72% against −3.37% — and `hv = 0.3` lands between them at
−3.19%. Of the three, 0.15 is the right value.

What the re-baseline changed is the tune side of this, not the holdout side.
Round 3 could say `hv = 0.3` was *better* on tune and reject it out of sample
anyway; on the Wikimedia corpus `hv = 0.3` is +0.39% on tune with a CI
straddling zero, and the arm that clears zero there is `hv = 0`, pointing the
other way (§11.5). So the holdout ordering is unchanged and still picks 0.15 —
but it is no longer overturning a tune result, it is the only evidence the
selection weights have. They earn their keep out of sample and nowhere else.

The whole ladder under the constants-only recipe
(`sweeps/budget-ladder-optimized.json`):

| Bytes | 12 | 16 | 21 | 24 | 28 | 32 | 40 | 48 | 64 | 80 | 108 | 161 | 246 | 411 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tune, pre-adoption shipped | 14.24 | 13.20 | 12.70 | 12.23 | 11.95 | 11.66 | 11.29 | 10.96 | 10.51 | 10.17 | 9.72 | 9.20 | 8.64 | 7.91 |
| tune, optimized | 13.52 | 12.68 | 12.16 | 11.94 | 11.68 | 11.41 | 11.09 | 10.76 | 10.47 | 10.14 | 9.67 | 9.05 | 8.45 | 7.90 |
| holdout, pre-adoption shipped | 14.23 | 13.28 | 12.73 | 12.29 | 11.97 | 11.74 | 11.31 | 10.94 | 10.51 | 10.11 | 9.70 | 9.11 | 8.57 | 8.00 |
| holdout, optimized | 13.30 | 12.72 | 12.15 | 11.88 | 11.55 | 11.38 | 10.98 | 10.67 | 10.35 | 9.99 | 9.51 | 8.92 | 8.39 | 7.82 |

(The 32 B row of this ladder uses the ratio-derived `L33@4 C11@3`; the *measured*
optimum `L28@4 C15@3` is better still — 11.298 on holdout, in the table above.)

The `pre-adoption shipped` rows are §4.5's, the pre-adoption arms of
`budget-ladder-tuned` on this corpus. (Until the 2026-09 re-measure they were
the retired corpus's §2 ladder, which no run could reproduce, and this note told
the reader not to compare across the pair. The pair is now comparable.) The
optimized recipe beats the pre-adoption format at every budget on holdout, by
6.5% at 12 B and 1.2–4.6% from 16 to 108 B; above that the raster caveat under
§4.5's table applies.

**The equal-quality byte saving, restated.** Round 2 reported that the adopted
32-byte recipe matches the pre-adoption format at **40 bytes**, a 20% saving.
Paired per image over the same split (adopted minus pre-adoption 40 B, ΔE00,
`bootstrapCI`'s default seed and resamples), the two splits disagree:

- **Holdout:** 11.298 against 11.307, a difference of −0.009 with CI
  [−0.098, +0.077]; the adopted recipe wins on 15 of 32 images. The two are
  **not separable**. That is consistent with "matches at 40 B", and it does not
  support "better than".
- **Tune:** 11.481 against 11.292, a difference of +0.188 with CI
  [+0.069, +0.310]; the adopted recipe wins on 8 of 31. Here the 40-byte
  pre-adoption format is **better**, so the saving on tune is less than 20%.
  The adopted recipe does separate from the pre-adoption format at 32 B on tune
  (−0.175, CI [−0.273, −0.077]), so the tune saving lies strictly between 0 and
  20%. The ladder has no arm between 32 and 40 B to place it more precisely.
  The three intervals are `mise run arms budget-ladder-tuned --baseline "40B
  pre-adoption L34/C12"` (and `"32B pre-adoption L26/C9"`) and `mise run arms
  final-candidates-holdout --baseline "40B pre-adoption L34/C12"
  --baseline-from budget-ladder-tuned-holdout`, each the `32B SHIPPED (ref)`
  or `32B L28C15 stack` row.

So the evidence bounds the saving at no more than 20%, and reaches 20% only on
the split where the two arms cannot be told apart. Neither split's figure is the
one to quote alone; a statement of the saving carries both. (The holdout pairing
uses `final-candidates-holdout`'s `32B L28C15 stack` against
`budget-ladder-tuned-holdout`'s `40B pre-adoption L34/C12`; the same run's
`32B SHIPPED (ref)` arm gives identical per-image scores.)


### 7.13 U11 — entropy-coded AC, with a real coder instead of an entropy

`entropy-budget.ts` re-asks §4.9's question with two changes: the code stream is
actually coded (sequentially, per image, against a Laplace-smoothed adaptive
model) rather than assigned its pooled entropy, and the model is scored
**leave-one-image-out** so the table's own fitting cost is paid. (As in §4.9,
"shipped" below is the `L 26 @ 5 / C 9 @ 4` row the tool calls shipped, not
today's `L 28 @ 4 / C 15 @ 3` default. Re-run in the 2026-09 re-measure, and
again after #102 turned the one EXIF-rotated tune photograph upright; the
figures below are that last run's.)

| Model | AC bits (of 202 fixed) | vs fixed | honest? |
|---|---|---|---|
| static pooled entropy (§4.9) | 188.0 | −6.9% | no — in-sample lower bound |
| static per-index entropy (§4.9) | 159.1 | −21.2% | **no — badly optimistic** |
| order-0 adaptive, no decoder tables | 195.9 | −3.0% | yes |
| order-0 pretrained table, LOO | 190.4 | −5.7% | yes |
| per-index context table, LOO | 190.3 | −5.8% | yes |
| **per-index context backing off to order-0, LOO** | **186.9** | **−7.5%** | yes |

Two corrections fall out:

* **A table-free adaptive coder is worse than the static entropy by 4.2%**
  (195.9 vs 188.0 b). A 44-symbol payload never lets a model that starts uniform
  pay for itself.
* **Per-index context, scored out of sample, is no better than plain order-0**
  (190.3 vs 190.4 b) — nothing like the gain §4.9's in-sample number implied. It
  helps only when backed off to the order-0 table, and then by 3.5 b. (Before
  #102 the two unbacked coders read 190.5 against 190.3, the other way round; a
  0.1–0.2 b gap that one image reverses is not an ordering.)

So the real tier-0 headroom is **15.1 bits ≈ 3 more 5-bit luma coefficients**,
not the ~10 that the in-sample context figure implies. Spending it (searching
layouts that fit under each coder) gives **−1.6% ΔE00** at 32 B and **−4.8%** at
108 B, each against the best layout the *fixed* fields can reach at the same
budget — real, and at 108 B of the same order as the constants changes of §8,
but paid for with decoder tables, a decode loop, and the O(1) length check that
currently *is* the validity check.

Both figures moved, and in opposite directions: the 32 B case is now less than
half what round 2 recorded and the 108 B case rather more. At 32 B a coder buys
three coefficients out of 44, which is inside the noise of a layout search; the
case for entropy coding, such as it is, is a case about the upper tiers.

The counter-finding from the same search is **half-refuted, and worth saying
so**. Maximizing *coefficient count* is still the wrong objective — under every
coder the count-maximal layout loses to that coder's ΔE00-optimal one (11.577 vs
11.253 under the best). But round 2's stronger claim, that it is worse than the
shipped layout outright, no longer holds: the count-maximal layout under the
fixed fields (L35@3 C23@2, 81 coefficients) is **11.987 — 2.9% worse than
shipped, not 13%** — and once a coder buys 147 of them it reaches **11.577,
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
ΔE00 outright (8.788 vs WebP's 8.934) rather than being drawn level with; that
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

**U18 — a CI quality gate.** `mise run rd:gate` encodes 8 pinned photos at the
32-byte default (tier 0 in this file's old numbering, code 1 as shipped) and
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
reports 0.00% drift against it here. The re-source did not keep the skin-tone
half of that coverage: the gate's one portrait, `portrait-african-lady`, was a
black-and-white photograph (mean C\* 0, #102), so on the Wikimedia set the gate
had two achromatic inputs and no skin chroma at all. #110 restored it by
swapping in the dark-skin colour portrait `portrait-african-woman-rusinga`
(mean C\* 16) for `portrait-african-lady`, keeping eight images and
`chroma-the-old-monochrome` as the one achromatic input: **11.1369 → 11.0921**
(−0.40%). That step is the image swap alone; the unchanged set reported 0.00%
drift against 11.1369 immediately before it.

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
validated on the holdout split with all four metrics improving. That split was
never tuned on directly, but it was not unread either: round 1 had already
consulted it, and `sel_hv = 0.15` was chosen on it (§11.12 records how often it
has been read).

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

\* The compact layout is chosen on tune, where `L 19 @ 4 b` wins (12.156 vs
12.166). On holdout the 3-bit sibling `L 26 @ 3 b, a/b 6 @ 3 b` is better
(12.129 vs 12.146) — both beat ThumbHash on all four metrics, and the choice
between them should be re-made against the alpha-mode layout before a compact
tier is written down.
**Not yet measured** when this was written: the alpha-mode layout. The
arithmetic points at `L 22 @ 4 b, a/b 14 @ 3 b` at tier 0 (255 bits), but the
photographic corpus has no alpha, so this needs its own sweep before it is
written down. *Measured since* in §11.1 and §11.3: that arithmetic is not among
the layouts that beat the old alpha row after Holm (§13.5), and the row that
shipped is `A 28 @ 3 b, L 22 @ 4 b, a/b 3 @ 3 b`, which moves the budget into
the alpha channel instead. The compact tier's alpha row is §11.10's.

**2. Selection weights** `aniso = 1.2`, `sel_hv = 0.15` — key
`priority · (1 + 1.2·sin²2θ) · (1 + 0.15·cos2θ)`. Worth **−0.36 pp** of the
holdout verdict (§7.12: −3.37% without them, −3.72% with). This is the weakest
of the three constants-level changes, and dropping `sel_hv` while keeping the
layout still clears the ≥3% rule (−3.37%).

> **Three claims this paragraph used to make, and what became of them.** It said
> the weights were worth −1.03% on tune, citing §7.4 — a table since retired as
> not reproducible, because its arms named constants they did not set. §11.5 is
> the grid that replaces it, and on the Wikimedia corpus the weights buy nothing
> on tune: isotropic is −0.23% with a CI straddling zero, and `aniso 1.2 / hv 0`
> is −0.52% with a CI that *excludes* it, pointing the other way. It also called
> them a blocker — a float sort costing **+32% decode time**, pending an integer
> reformulation. §10.2 delivered that: the exact Q12 key selects the identical
> order at tier 0 over all 256 aspect bytes, and computing it once per candidate
> made decode ~8% *faster* than v0.6's unweighted sort. The blocker is gone; what
> is left is a lever with no in-sample support, carried entirely by §7.12's
> holdout delta.

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

> **The equal-quality byte saving, measured again.** Round 2 put it at 20% —
> the optimized 32-byte encode matching the pre-adoption format at 40 bytes —
> and this section withdrew it, because no sweep produced a pre-adoption ladder
> on this corpus. `budget-ladder-tuned` now does, and §7.12 restates it: on
> holdout the adopted recipe at 32 B (11.298) and the pre-adoption format at
> 40 B (11.307) are not separable (paired CI [−0.098, +0.077]), so the 20% is an
> equal-quality match there and no better. On tune the 40-byte pre-adoption
> format is separably better (paired CI [+0.069, +0.310]), so the saving there is
> less than 20%. The saving is therefore at most 20%, and no single split's
> figure stands for it. The −3.72% above remains the figure the pre-registered
> rule is judged on.

At the proposed 21-byte compact tier the format beats ThumbHash on **all four
metrics** on holdout (§7.6), which the shipped constants do not.

### 8.4 Rejected, with the number that rejected it

| Idea | Verdict |
|---|---|
| Pixel-SSE refinement (U1) | +0.26% ΔE00 (+0.73% with dc+scale) despite −15…31% pixel SSE. Objective was wrong. |
| Closed-loop re-projection (U4) | Provably a fixed bias on an orthogonal basis; subsumed by U5. |
| Prefix narrowing (U8) | Best case **−0.73 pp** on ΔE00 — but paid for in aspect error the metric cannot see (9.1% at 5 b, worse than ThumbHash). Refused on that, not on the sweep. |
| `b_scale_from_a` (U9) | +2.20%, fails guards. |
| Decoder detail synthesis (U12) | Every structural metric monotonically worse; +70% decode. |
| Per-image signalled selection (U13) | Oracle −1.59% vs best fixed, minus ~0.37% signalling. |
| Chroma-from-luma (U14) | Free gains help slightly now (−0.10% at 32 B, −0.90% at tier 3); paid for, the field costs more than it saves (+2.11% at 32 B). |

### 8.5 The meta-finding

Round 2 read three independent levers this way — pixel-domain RDO (§7.1),
chroma-from-luma (§7.10), and the objective sweep (§7.2) — as all reducing
squared error and all failing to improve ΔE00. **On the Wikimedia corpus that is
down to one.** §7.1 still shows it cleanly and in both directions: minimizing
gamma-sRGB SSE costs +0.26% while swapping only the objective to clipped OKLAB
buys −0.19%. But §7.10's chroma-from-luma now *does* translate its coefficient
gain into ΔE00 (−0.10% at 32 B, −0.90% at tier 3), and what refuses it is the
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

> **How the current corpus answers the skin-tone and orientation rows (#102).**
> The table describes the retired Picsum set. The Wikimedia re-source (§9.5)
> labelled six tune portraits "skin tone and portrait framing", but three of
> them — `portrait-african-lady`, `portrait-mother-and-child` and
> `portrait-portrait-femme-tenue` — are black-and-white photographs, mean C\* 0
> on the scoring reference. They carry no skin chroma, so the chroma allocation
> this row wanted tested against a range of skin loci is exercised by **three**
> colour portraits (`portrait-african-woman-rusinga`, `portrait-imene6`,
> `portrait-sideshow-bob-love`), not six; their pins now say so. The CI R-D
> gate's one portrait was one of the three monochrome ones; #110 replaced it
> with `portrait-african-woman-rusinga` (§7.14).
>
> On orientation, one tune photograph, `portrait-african-woman-rusinga`, is
> stored 6240×4160 with EXIF Orientation 8. Until #102 the harness ignored the
> tag and scored it lying on its side, a landscape; it now turns every image
> upright before encoding or scoring it, so the tune split scores 23 landscape
> and 8 portrait photographs, as the pins record (24 and 7 before). No other
> pinned photograph, Kodak image, graphic or retrievable alpha cutout (23 of 24;
> #83 withdrew the other) carries an Orientation tag other than 1, and each of
> them decodes to the same rasters as before. Every tune result that scores it
> was re-run: the other 30 images
> reproduce to the digit, so every tune figure in this file that moved, moved by
> that one image.

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

> **Both columns are the retired curated corpus** — the pre-§9 set and the §9
> revision of it — so every figure in this table is a round-2-vs-round-3 reading
> and none of them is current. `85f6af3` has since re-sourced the corpus and
> §9.5 re-measures the whole file on it. Where a row here and a section above
> disagree, the section above is right: the **−3.50%** recipe verdict in
> particular is now **−3.72%** (§7.12, §10.3, and the same row in §9.5's table),
> and it is the −3.72% that `verify:claims` gates and the rest of the repo
> quotes. Nothing in this table is re-derivable — the corpus it was measured on
> no longer exists.

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

* **Source bias.** Every curated image was Picsum/Unsplash at the time of this
  audit — a professional aesthetic. The 2026-09 re-source (§9.5) replaced them
  with Wikimedia Commons originals, which narrows *that* bias without closing
  this gap: selection still required camera EXIF and excluded Commons' artwork
  categories, and none of the 39 axes below is a degradation axis. No smartphone
  snapshots: no sensor noise, motion blur, harsh on-camera flash or heavy JPEG
  history, which is what a real LQIP pipeline ingests. The corpus spans what a
  picture *contains*, not what a camera did to it.
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

(The Wikimedia column is the corpus as it is scored now, with the one
EXIF-rotated tune photograph upright (#102); where that moved a tune figure,
the column carries the new one and the verdicts are unchanged.)

| Measurement | Curated (§9) | Wikimedia | Verdict |
|---|---|---|---|
| §1's 32 B ladder point (`L 26 @ 5 / C 9 @ 4`, not the shipped default), tune / holdout ΔE00 | 10.28 / 11.38 | 11.66 / 11.54 | Tune is 13.4% harder; **holdout only 1.4%**, being three-quarters Kodak24 |
| R-D gate, mean of 8 | 8.8459 | 11.1369 | +25.9%, and 0.00% drift against its own baseline |
| §8 recipe on holdout | −3.50% | **−3.72%** | grew — still clears the pre-registered ≥3%, and this is the figure the repo quotes (§7.12, §10.3) |
| Compact tier vs ThumbHash, holdout | wins all four | wins all four | unchanged |
| 108 B vs size-matched WebP, holdout | −9.5% ΔE00 | **−10.8%** | **grew** |
| ΔE00 crossover with WebP | between 193 and 411 B | between 193 and 411 B | unchanged |
| Compact-tier layout | `L19@4 C6@3` | `L19@4 C6@3` | unchanged — but its tie-break no longer separates it (§11.10) |
| `sel_hv = 0.30` vs `0.15`, tune | −0.81%, CI excludes zero | **+0.39%, CI straddles** | **refuted** |
| Best selection-weight arm | `aniso 1.2 / hv 0.30` | **`aniso 0.9 / hv 0`** | **moved to `hv = 0`** |
| Trainable selection-order headroom | +1.5 energy points | **+1.3** | shrank again |
| Entropy-coding headroom at 32 B | −4.3% | **−1.6%** | **more than halved** |
| Entropy-coding headroom at 108 B | −4.0% | **−4.8%** | grew |
| Count-maximal layout vs shipped | 13% worse | **2.9% worse** | **weakened** |
| Scalefactor bands, best arm | −0.30% | **−0.14%** | narrowed, still below threshold |
| Doubling the render raster | inert (−0.05%) | inert *above the bound*, +0.92% below it | **rescoped** (§4.1) |
| CfL with free gains, 32 B / tier 3 | +0.19% / −0.27% | **−0.10% / −0.90%** | **sign flipped** (§7.10) |
| Prefix narrowing, best 4-bit row | +0.04 pp | **−0.73 pp** | **now pays on ΔE00** (§7.5) |
| Metric-targeted RDO optimum | −0.80% | **−0.05%** | **evaporated** (§7.2) |
| `fit2+nearest` at 32 B | −0.43% | −0.30% | narrowed; mode 1 / mode 2 order reversed (§4.4) |
| Count-vs-precision at 32 B | −2.0% | −1.7% | thesis intact, restated (§4.2) |
| Tier 3 vs raw RGB565, ~1.6 kB | pixels win, 5.80 vs 6.26 | ChromaHash wins on tune, 6.73 vs 6.96; **pixels win on holdout**, 6.57 vs 6.77 | **split-dependent** (§2, §11.14; this row read "inverted" from tune alone) |

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
replacement. Separately, `cfl`, `prefix-shrink` and `retune-32b` carry an
inaccurate *incumbent label* but a valid set of deltas around it, because every
arm in them shares one base. `combined-optimizer` declares for a different
reason and its note says so: its incumbent is a bare `32B shipped`, naming no
constant to be wrong about, and the arm at fault is a *candidate* —
`32B L26@5C9 stack`, which sets the four stack knobs and no `l1`/`c`, inherits
`LAYOUT_T0`, and so measures 28@4 C15@3 and ties the incumbent to thirteen
decimal places. Relabelling would
move no number and would change the row keys the bindings match on, so they are
left alone: read their "shipped" row as "the default as of that run", not as the
pre-adoption format. `low-budget-allocation` belongs with them and this
subsection first left it out entirely — its `32B SHIPPED L26@5 C9@4` incumbent
carries no `tune` string at all — though it is unfixed for its own reason: it
was run and superseded before this file's round-3 numbers were taken, its output
no longer survives on disk (§6), and it informed no adopted constant. Those six
configs, and only those six, declare `unpinnedLabels` with the reason, so each
decision is recorded on the sweep it applies to rather than only here.

**Five more were named here as disclosed and are not.** `detail-synthesis`,
`refine-grid`, `refine-objective`, `embedded-tiers` and
`budget-ladder-optimized` carry the same inaccurate incumbent and are read the
same way — but their incumbents are labelled `32B shipped`, `32B shipped (ref)`
and `t0 native 32 B`, which name no constant to be inaccurate about. Nothing
checks them because there is nothing in the label to check, which is not the
same thing as a decision to leave them, and the distinction is the subject of
the next paragraph.

A check that reconciles an arm's label against the constants it sets would have
caught every one of these that spells a constant out — most of them, and not all
of them, because an arm labelled `32B shipped` names nothing to reconcile. It is
still the obvious next thing to build.

> **Built** — `mise run verify:sweep-labels`. Over 584 label-bearing arms in 49
> configs — 481 of them enforceable, see below — it reports two things: a label
> naming a constant nothing in the arm's `tune` string writes, and a label
> naming one value where the tune sets another. Both are properties of the config alone, so it needs no corpus, no
> encoder and no sweep output, and runs in CI where the sweeps cannot. It found
> fourteen. Two incumbents were pinned and their sweeps re-run byte-identical;
> one arm was relabelled (the off-budget `C2@4` of `sweeps/alpha-tier1.json`,
> discussed in §11.11 — §11.3's own tables read `C1@4` and are correct); the
> remaining eleven are
> the arms of the six configs that declare `unpinnedLabels` — `cfl`,
> `prefix-shrink`, `retune-32b`, `combined-optimizer`, `low-budget-allocation`
> and `selection-hv`, six of them `selection-hv`'s — so the decision is recorded
> on the config rather than only here. Each of those six opt-outs carries the
> number of arms it excuses, and the gate fails if that number drops to zero or
> stops matching: an exemption nobody re-earns is cover for whatever lands under
> it next. That is the same rule `spec/validate.py`'s `not_in_parity` register
> lives under. **It also found a config this
> subsection missed entirely** — `v07-holdout-alpha`, whose incumbent inherited the
> adopted alpha allocation and encoded to 40 bytes rather than 32, which made
> §11.12's source table score the default against itself.
>
> **481 is the number that can fail. 584 is only the number it reads.** Two
> different populations sit between 481 and the 807 arms in those 49 configs,
> and this note used to print one figure covering both — 584 — which named
> neither of them.
>
> The first is the *unreadable* residue: 223 of the 807 — 28% — name no constant
> in any form the gate recognizes, and each is passed over, not failed. 36 were
> recovered by adding one token shape, the tune syntax written out
> (`deadzone_l=0.02`), which is where the 548 this note first reported became
> 584; all 36 pass, and that they pass was not knowable while they sat in the
> residue. `--list-unnamed` prints what remains, which is what makes the skip
> auditable rather than silent and is how the 36 were found.
>
> The second is the *exempt* set, and it is the one 584 hid. 103 of those 584
> readable arms sit in the six configs that declare `unpinnedLabels` —
> `prefix-shrink` 23, `low-budget-allocation` 23, `retune-32b` 17,
> `selection-hv` 15, `combined-optimizer` 15, `cfl` 10. The opt-out is
> whole-config, so every finding in those 103 is discarded whether the label is
> accurate or not; the gate read them, and then counted them as *checked*.
> **584 − 103 = 481 arms can actually fail this gate**, and the summary line
> now prints the three figures separately rather than adding them.
>
> So a clean run says "every label that states something checkable, in a config
> nobody exempted, states it truthfully" — not "every arm is what it claims".
> Three of the differences are above this line: the five configs of the previous
> paragraph are green by the readability silence rather than by any decision;
> the six exempt configs are green by declaration; and two of
> `v07-holdout-alpha`'s four mislabelled arms — `alpha_ac_fit alone` and
> `compact 21B shipped shape` — name nothing readable and were found by reading
> the config, not by running the gate. Read a passing run as a statement about
> 481 arms.
>
> **The counts above are the ones this note was written against.** At the
> 2026-09 re-measure the gate reads 831 arms in 51 configs: 481 enforceable,
> 103 exempt, 247 unreadable. All 24 arms added since are unreadable: the ten
> of the two §13 ladder configs, whose labels name tiers rather than constants,
> and the 14 pre-adoption arms `budget-ladder-tuned` gained for §4.5, labelled
> in §1's `L26/C9` form, which the gate does not read.

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

   > **Built.** Every run now reports column coverage and prints a `PARTIAL`
   > line per bound table with an unchecked column, naming it;
   > `--list-unbound-columns` gives the full breakdown. Then the coverage it
   > exposed was closed: `guardsOk` became a bindable metric (six tables),
   > `rowBaselines` made a per-row delta base expressible — which is what §10.3's
   > Δ% and §7.11's "vs native tier 0" needed and never had — and §11.14's byte
   > column, the stale x-axis named above, is bound. 739 checked cells became
   > 820 — 813 when that work landed, and seven more once `parseCell` learned
   > the score-plus-delta cell shape, which took §11.10's bound `graphics ΔE00`
   > from six of six cells unreadable to six checked. Five columns remain
   > unbound and each carries its reason in
   > `UNBOUND_COLUMN_NOTES`; the interesting one is §7.10's, where every row
   > names a different control and two state it in prose inside the cell.

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
* **§4.6 and §4.8 were missed by that list**, and still carried the retired
  corpus's figures until the 2026-09 re-measure (§6), which re-ran every sweep
  at one commit, re-ran the `cfl-probe`, `coeff-stats` and `entropy-budget`
  probes, and re-derived both. §4.9, §4.10 and §7.13 reproduced to the digit.

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
| tune, tier 0, pre-adoption | 11.656 | — | −349.1 | 30.64 | 0.2641 |
| tune, tier 0, **DEFAULT** | **11.481** | **−1.51** | **−342.1** | 30.35 | **0.2639** |

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

Every decision below is taken on the **tune** split. Within this round holdout
is consulted once, at the end (§11.12), for the assembled candidate. Across the
file it is not: the same 32 images had already validated rounds 1 and 2, and
§11.12 sets out every time they were read and what each reading decided.
Repeatedly consulting a holdout makes it a second tune set, and this one has
been consulted enough that it has partly become one.

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

| layout | ΔE00 | Δ% | paired 95% CI | Holm p | win/n |
|---|---|---|---|---|---|
| **shipped** L20@5 C9@4 | 15.689 | — | — | — | — |
| L22@4 C14@3 (the arithmetic in §8.1) | 15.541 | −0.94% | [+0.053, +0.253] | 0.0756 | 15/16 |
| L29@4 C9@3 | 15.497 | −1.22% | [+0.057, +0.361] | 0.0066 | 12/16 |
| L36@3 C10@3 | 15.432 | −1.64% | [+0.094, +0.459] | 0.0066 | 13/16 |
| **L43@3 C11@2** | **15.401** | **−1.84%** | [+0.109, +0.517] | 0.0066 | 13/16 |

The shipped layout is significantly worse than a dozen alternatives, and the
direction is consistent: alpha mode wants **more luma coefficients at lower
precision, and much less chroma** than the opaque row does.

> **After Holm (§13.5):** ten alternatives, not a dozen, and `L22@4 C14@3` is
> not among them. The direction is unchanged.

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

| layout | ΔE00 | Δ% | paired 95% CI | Holm p |
|---|---|---|---|---|
| **DEFAULT** L28@4 C15@3 | 10.450 | — | — | — |
| pre-adoption L26@5 C9@4 | 10.569 | +1.14% | [−0.294, +0.034] | 1.0000 |
| L30@4 C13@3 | 10.394 | −0.54% | [+0.009, +0.104] | 0.5599 |
| L40@4 C7@3 | 10.344 | −1.01% | includes zero | 1.0000 |

Exactly one arm reaches significance, by 0.54%. Graphics wants slightly more
luma and less chroma — the same direction as alpha mode, for the same reason
that structure matters more than colour in synthetic content — but at a
magnitude that does not warrant splitting the constant.

> **After Holm (§13.5):** not even that one. Across the sweep's 28 arms
> `L30@4 C13@3` adjusts to 0.56, and no layout differs from the default. That
> strengthens this subsection's conclusion rather than weakening it.

**The encoder stack generalizes.** This is the stronger result: every part of
the §8 adoption was chosen on photographs, and it holds on content it never saw.

| variant | ΔE00 | Δ% | paired 95% CI | Holm p |
|---|---|---|---|---|
| **DEFAULT** (full stack) | 10.450 | — | — | — |
| no selection weights | 10.513 | +0.60% | [−0.225, +0.085] | 1.0000 |
| no encoder search (`scale_fit=0 ac_nearest=0`) | 10.577 | +1.22% | **[−0.226, −0.040]** | 0.0320 |
| pre-adoption (everything off) | 10.766 | **+3.02%** | **[−0.577, −0.112]** | 0.0018 |
| `sel_hv = 0.30` | 10.410 | −0.39% | includes zero | 1.0000 |

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

| variant | ΔE00 | Δ% | paired 95% CI | Holm p | win/n |
|---|---|---|---|---|---|
| **DEFAULT** aniso 1.2 / hv 0.15 | 11.481 | — | — | — | — |
| isotropic (aniso 0, hv 0) | 11.455 | −0.23% | [−0.061, +0.123] | 1.0000 | 16/31 |
| **aniso 0.9 / hv 0.0** | **11.393** | **−0.76%** | **[+0.031, +0.149]** | 0.0432 | 18/31 |
| **aniso 1.2 / hv 0.0** (shipped aniso, `sel_hv` off) | **11.421** | **−0.52%** | **[+0.015, +0.109]** | 0.2112 | 20/31 |
| aniso 1.2 / hv 0.30 | 11.525 | 0.39% | [−0.120, +0.024] | 1.0000 | 14/31 |
| aniso 2.0 / hv 0.30 | 11.578 | 0.85% | **[−0.178, −0.022]** | 0.2438 | 13/31 |
| aniso 1.2 / hv −0.15 | 11.464 | −0.14% | [−0.062, +0.089] | 1.0000 | 20/31 |
| aniso 1.2 / hv −0.30 | 11.549 | 0.59% | [−0.177, +0.026] | 1.0000 | 13/31 |
| aniso 3.2 / hv 0.0 | 11.632 | 1.32% | **[−0.259, −0.063]** | 0.0056 | 8/31 |

Three findings, and the first two are uncomfortable:

1. **`sel_hv` is worth less than nothing at the shipped `aniso`.** Turning it
   off — `aniso 1.2 / hv 0`, one knob changed — is −0.52% with a CI that
   excludes zero and wins 20 of 31 images. `aniso 0.9 / hv 0` is the grid's best
   arm at −0.76%, also excluding zero. Every arm that clears zero in the good
   direction has `hv = 0`; no arm with `hv ≠ 0` does. Two caveats before anyone
   acts on it: this is 28 arms scored against one incumbent with no multiplicity
   correction, and −0.76% is inside the range §9.3 has already watched a
   selection-order effect halve under a corpus change. **The first caveat has
   since been applied, and the finding survives it only at its best arm, and
   only just**: after Holm `aniso 0.9 / hv 0` adjusts to 0.043 and
   `aniso 1.2 / hv 0` to 0.211 (the `Holm p` column, §13.5). That 0.043 is one
   photograph's doing. Before #102 turned `portrait-african-woman-rusinga`
   upright the same two arms adjusted to 0.085 and 0.304, and neither survived;
   a verdict that one image of 31 moves across α = 0.05 is not one to act on
   from tune, and the second caveat stands untouched.
2. **Isotropic is statistically indistinguishable from the adopted weights.**
   On the current corpus the selection weights buy nothing measurable on tune;
   their justification rests entirely on the holdout delta §7.12 recorded
   (−3.37% without them, −3.72% with). §8.1 already called them "the weakest of
   the three constants-level changes"; this is weaker still.
3. **Large `aniso` is real, and negative `hv` no longer is.** Every arm at
   `aniso ≥ 2.0` is significantly worse whatever `hv` does, so the weight is not
   noise. (After Holm only `aniso 3.2 / hv 0` remains significantly worse; the
   bound on `aniso` is looser than this sentence states. See §13.5.) But negative `hv`, which round 3 recorded as significantly worse, now
   is not: `hv −0.15` is −0.14% and `hv −0.30` is +0.59% with a CI straddling
   zero. What survives is a bound on `aniso`, not a sign for `hv`.

> **Round 3 read this grid the other way round**, and its own numbers supported
> it: `aniso 1.2 / hv 0.30` was −0.81% with a CI excluding zero, and the section
> concluded "`sel_hv = 0.30` is significantly better than the shipped `0.15`".
> On the current corpus that same arm is **+0.39%** and its CI straddles zero.
> Nothing about the format changed; the conclusion was carried by a corpus of
> predominantly outdoor landscape, exactly as §4.10 predicts for anything that
> exploits a dominant orientation structure. Neither reading has been validated
> on holdout, and neither should be adopted from tune alone.

### 11.6 µ-law companding, re-derived — stands

`sweeps/companding-family.json`, now pinned to `corpus: "photo"` and re-run at
the 4 b/3 b tier-0 depths rather than the 5 b/4 b depths it was locked against.

| family | ΔE00 | Δ% |
|---|---|---|
| **µ-law µ_L=5 / µ_C=8 (shipped)** | 11.481 | — |
| µ_L=7 | 11.488 | 0.06% |
| µ_C=12 | 11.483 | 0.02% |
| A-law 87.6 (G.711) | 11.673 | 1.68% |
| power-law 0.75 (AAC/MP3) | 11.535 | 0.47% |
| power-law 0.9 | 11.609 | 1.12% |
| Lloyd-Max L+C (trained on this corpus) | 11.505 | 0.21% |

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
| **no deadzone (shipped)** | 11.481 | — |
| `deadzone_l = 0.02` | 11.481 | 0.00% |
| `deadzone_l = 0.05` | 11.490 | 0.08% |
| both = 0.03 | 11.480 | −0.01% |

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
band split at 0.3, high-band luma scaled down) is worth **−0.14%**, against the
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

| layout | ΔE00 | Δ% vs shipped shape | paired CI vs the leader | Holm p vs the leader |
|---|---|---|---|---|
| shipped shape L13@5 C6@4 | 12.620 | — | **[−0.666, −0.292]** | 0.0028 |
| **L19@4 C6@3** | **12.156** | −3.67% | (leader) | (leader) |
| L26@3 C6@3 | 12.166 | −3.59% | [−0.085, +0.067] | 1.0000 |
| L18@4 C7@3 | 12.171 | −3.55% | [−0.073, +0.028] | 1.0000 |
| L16@4 C8@3 | 12.244 | −2.98% | **[−0.184, +0.007]** | 0.6775 |
| L24@3 C7@3 | 12.189 | −3.41% | [−0.102, +0.033] | 1.0000 |
| L20@4 C5@3 | 12.243 | −2.98% | [−0.204, +0.002] | 0.6775 |
| L35@3 C2@2 (count-maximal) | 12.280 | −2.69% | **[−0.381, +0.124]** | 1.0000 |
| L19@5 C2@4 (precision-maximal) | 12.444 | −1.40% | **[−0.486, −0.117]** | 0.0028 |

The extremes are decisively rejected and the shipped shape is decisively beaten
— by 3.67% — but **the leading five layouts are a plateau**: their paired CIs
against the leader all include zero. This section used to say `L16@4 C8@3`
had separated from the group, downward, on an interval of [−0.184, −0.000]. That
bound was zero to three places, and drawn at 10,000 resamples rather than 1,000
(§13.5) the interval is [−0.184, +0.007]: it has not separated. The
photographic split still cannot choose among the five, and squeezing its guard
metrics for a winner would be mining noise.

> **After Holm (§13.5):** `L16@4 C8@3` has not separated on the adjusted p
> either. Against the leader it adjusts to 0.68, and only the shipped shape
> and the precision-maximal layout remain distinguishable. The count-maximal
> row's interval, bold above, never excluded zero. The plateau is wider than
> five, and the choice below does not rest on it.

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
| L18@4 C7@3 | 3 | 10.917 (−2.22%) | 7 | 10 |
| L20@4 C5@3 | 10 | 10.783 (−3.43%) | 1 | 11 |
| L16@4 C8@3 | 11 | 11.060 (−0.94%) | 8 | 19 |

The graphics column is unchanged — `85f6af3` re-sourced the photographic corpus
only — so every rank that moved here moved because of the photo column. (The
photo ranks were last re-derived when #102 turned the one EXIF-rotated tune
photograph upright, which swapped `L18@4 C7@3` and `L28@3 C5@3` at 3rd/4th and
`L20@4 C5@3` and `L30@3 C3@3` at 9th/10th; the top two did not move.)

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

**The alpha row.** Alpha mode spends 9 more prefix bits, so the opaque 21-byte
layouts do not fit it. `sweeps/compact-tier-alpha.json` measures 23 alpha
allocations at exactly 21 bytes on the 16 alpha tune images, against the
opaque row's shape resized to alpha mode. §6 used to list this sweep as never
run. Its committed result reproduces the tune figure §11.12 quotes for the
adopted row, −13.00%, to the digit:

| alpha layout, 21 B | ΔE00 | Δ% | αMAE | more-opaque half (8) | paired CI vs the adopted row | guards (CI) |
|---|---|---|---|---|---|---|
| shipped shape A5@4 L9@5 C5@4 | 15.974 | — | 0.2625 | — | [−2.789, −1.392] | — |
| A12@3 L15@4 C1@3 | 14.615 | −8.51% | 0.2144 | −7.67% | [−1.130, −0.361] | ok |
| **A16@3 L12@4 C1@3** (adopted) | **13.898** | **−13.00%** | 0.1851 | **−9.42%** | — | ok |
| A20@3 L9@4 C1@3 | 13.831 | −13.42% | 0.1795 | −9.03% | [−0.083, +0.215] | ok |
| A24@3 L5@4 C2@3 | 13.738 | −14.00% | 0.1726 | −9.23% | [−0.103, +0.399] | ok |

The adopted row is not the mean's best: `A24@3` is 1.0 pp ahead, and so is
`A20@3` by 0.4 pp. But both paired intervals against the adopted row include
zero, so on this corpus the three are a plateau, as the opaque rows above are.
Within it the adopted row gives the more-opaque half of the images the largest
gain of all 23 arms, which is the same rule §11.3 chose the default tier's alpha
row by. (The paired CI is `adopted − row`, so a positive bound favours the
row.)

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

| variant | ΔE00 | Δ% | αMAE | guards (means) | guards (CI) |
|---|---|---|---|---|---|
| **shipped** alpha DC 5 b, scale 4 b, AC 5 @ 4 b | 15.689 | — | 0.2625 | — | — |
| alpha DC 4 b (−1) | 15.708 | +0.12% | 0.2623 | ok | ok |
| alpha scale 3 b (−1) | 15.677 | −0.08% | 0.2613 | ok | inconclusive |
| **A 8 @ 4** (+3 coefficients, −3 luma) | 14.884 | **−5.13%** | 0.2316 | ok | ok |
| **A 12 @ 4** (+7 coefficients, −6 luma) | 14.465 | **−7.80%** | 0.2139 | ok | inconclusive |
| A 3 @ 4 (−2 coefficients) | 17.005 | +8.39% | 0.3030 | FAIL | FAIL |
| A 0 (no alpha AC at all) | 19.428 | **+23.84%** | 0.3812 | FAIL | FAIL |

(`A 12 @ 4` and `alpha scale 3 b` pass on means and are `inconclusive` on
intervals, per §13.5. Neither was adopted: the adopted allocation comes from the
ladder below, where `A28@3 L22@4 C3@3` is `ok` on both.)

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
| A32@2 L24@4 C5@3 (fails Butteraugli) | 13.880 | −11.53% | −366.1 | **61.43** | 0.1901 |

(The last row's αMAE cell used to read **FAIL**. That was a guard verdict in a
measurement column: the arm's alpha error is 0.1901, and what fails is its
Butteraugli, 61.43 against the incumbent's 57.38.)

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

| allocation | all | <35% transparent (4 images) | ≥35% transparent (12) | more-opaque half (8) | more-transparent half (8) |
|---|---|---|---|---|---|
| **A28@3 L22@4 C3@3** (adopted) | −17.10% | **−7.42%** | −22.60% | **−12.28%** | −24.42% |
| A32@3 L19@4 C3@3 | −17.19% | −6.79% | −23.09% | −11.87% | −25.27% |
| A40@3 L13@4 C3@3 | −17.74% | −5.68% | −24.58% | −12.04% | −26.38% |
| A48@3 L7@4 C3@3 | −17.87% | −3.86% | −25.82% | −11.28% | −27.87% |
| A28@2 L29@4 C3@3 (fails Butteraugli) | −11.76% | −8.52% | −13.59% | −9.63% | −14.98% |

Pushing the alpha count higher buys transparent images at the expense of opaque
ones, and the mean is driven by this corpus being three-quarters transparent —
a property of the corpus, not of the world. **`A 28 @ 3 b, L 22 @ 4 b,
a/b 3 @ 3 b`** is adopted: it takes −17.10% overall while giving the at-risk
opaque-ish subgroup the largest gain of any **guard-passing** arm (three 2-bit
arms score higher there on the 35% cut — −7.5% to −8.5% — but all three fail
Butteraugli), posts the best SSIM2 of the whole sweep, and carries *more* luma
than the layout it replaces (22 vs 20). Choosing the ΔE00-optimal corner instead
would trade 0.8 pp of mean for 3.6 pp of the subgroup most exposed to a
different corpus mix.

> **The 35% cut was chosen after the sweep was read, and it holds four
> images.** No record fixes it in advance, and a cut picked while looking at
> the arms can be picked to favour one. So the table also splits the same 16
> images at their median non-opaque fraction (0.527), a cut the corpus fixes
> before any arm is scored. On that cut the adopted row still gives the
> more-opaque half the largest gain of all 33 arms in `alpha-ceiling`, 2-bit
> arms included: −12.28%, against −12.10% for the next, `A28@3 L19@4 C5@3`, and
> −9.63% for the best 2-bit arm. The margin over the next arm is 0.18 pp on
> eight images, and nothing here tests it, so this is a ranking and not a
> separation. What the median cut shows is that the ranking the adoption rests
> on does not depend on where the line was drawn. Both cuts are bound, so a
> re-run re-derives them.

Not a corpus artifact, checked two ways. **Every one of the 16 images improves**,
including those only 15–22% transparent. And §11.2's control shows the direction
belongs to alpha mode rather than to cut-out content.

Everything in this section is tune evidence. Its out-of-sample confirmation
was §11.12's alpha holdout, which is **retired and can no longer be
reproduced**: one of its images was deleted from Wikimedia Commons (§11.12,
#83). The adopted row rests on this section until a new alpha split is sealed
and read. That split is the alpha half of `holdout2` (#93, §11.12), and the
reading is register entry C2 in `spec/V0.8-DECISIONS.md`.

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
§11.12's holdout result got to overrule it. That result is from the retired
alpha split and cannot be re-run, so the default stands on a verdict nothing can
now check.

### 11.11 Does the alpha finding hold above tier 0?

It has to be asked rather than assumed. Tiers 1–3 share one base row scaled by
`4^(tier−1)` (§3.2), so adopting §11.3 at tier 0 and leaving that row alone
would give **tier 1 fewer alpha coefficients than tier 0** — a higher quality
tier that is worse at the thing that matters most for a cut-out. The tier-1
base budget is the same 192 bits as tier 0's alpha budget, so
`sweeps/alpha-tier1.json` is the same allocations evaluated at 4× resolution.

One arm in that file is **off-budget** and is excluded from the comparison
below: `A20@4 L20@5 C2@4` at 106 B, against the 103–104 B the rest occupy. The
label carried `C1@4` until the 2026-09 label audit, and the two extra chroma
coefficients its arm actually sets are precisely why it is over budget — the
name of the defect was written on it the whole time. Note that its **tier-0
namesake in `alpha-ac-count` really is `C1@4`**, so the pair is not the
like-for-like this section otherwise assumes. It
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

This is a tune measurement only. The tier-1 row was never scored on a holdout,
and the tier-0 holdout figure it would lean on is from the retired alpha split,
which can no longer be reproduced (§11.12). The sealed alpha half of
`holdout2` (#93) is where it is first read out of sample: register entry C2
reads this file's arms at code 2, and D6 asks the question again at codes 3
and 4.

### 11.12 The holdout, and how often it has been read

Every decision in this round was taken on tune, with holdout untouched until
they were all frozen. It rejected half of them. `sweeps/v07-holdout-photo.json`
and `sweeps/v07-holdout-alpha.json`, both run with `--split holdout`; the tune
column is the same configs run on tune.

That is the round's own discipline, and it is not the holdout's history. This
section used to be titled "consulted once", and §11's introduction said the
same. The photographic holdout had in fact been read, and had informed a
decision, in every round before this one:

1. **Round 1** (§4.3, §4.5): `thumbhash-headtohead` and `holdout-candidates`.
   It cleared `L28@4 C15@3` + stack against the ≥3% rule, and made the compact
   tier a candidate.
2. **Round 2** (§7.6, §7.12): `final-candidates` and `budget-ladder-optimized`.
   It chose `sel_hv = 0.15` over 0 and 0.30 on the holdout ordering, which is
   the only evidence that weight has (§7.12), and priced the optional
   refinement.
3. **§8.1**: the compact candidates. The holdout preferred `L26@3 C6@3`, and
   the compact layout was deferred on it.
4. **§10.3**: `adopted-defaults`. It verified that adoption reproduced the
   measured change, and chose nothing.
5. **Round 3** (this section): `v07-holdout-photo` and `v07-holdout-alpha`. It
   rejected `sel_hv = 0.30`, the isotropic weights and `alpha_ac_fit`, and
   adopted the alpha row and the compact tier.
6. **§11.14**: `rd-budget`. It is the cross-format positioning the spec states
   (spec §14.1).

Its composition moved under it as well. The curated part went from 4 images to
8 in §9, and was replaced by Wikimedia photographs in §9.5; only Kodak24 has
been in it throughout, and every holdout sweep has been re-run on each version.

Two things follow. First, `sel_hv = 0.15` was **selected** on this split, so the
split cannot also validate it: that value has no out-of-sample evidence at all.
Second, the other readings each saw a holdout that earlier readings had already
steered the candidates towards, so none of them is the clean one-shot test the
pre-registered rule assumes. A result in this file that says "never-tuned
holdout" is describing how the split was meant to be used. The fix is a fresh
split read once, not a rewording (#76).

**What #76 did with it.** The split is retired, not re-labelled in place:

- **Its 32 images are `tune2`.** Kodak24 and the eight curated photographs keep
  their pins and their bytes; `splitFor` now puts them in `tune2`, a split of
  its own rather than a merge into `tune`, so every committed tune result
  still means what it measured and the split's history stays in its name. It
  is tuning data. A figure read from it is in-sample for every decision the
  list above names, and says nothing out of sample about any other.
- **`--split holdout` refuses a photographic corpus**, naming `tune2`. The
  committed `*-holdout.json` results are left as they were scored, and the
  tables below keep reading them. The graphics corpus keeps its own
  eight-image holdout (`graphic-images.ts` pins 16 tune and 8 holdout
  graphics, as `fixtures/graphic/LICENSES.md` lists), which no committed
  result or recorded decision has read.
- **The replacement is `holdout2`**, sealed. Its images are chosen on
  covariates alone — the §9.1 axes plus the smartphone snapshots §9.4 lists as
  missing — with no encoder run on a candidate, and nothing pinned until
  the list was approved. The 32 candidates, the protocol that drew them in a
  seeded order under thresholds fixed beforehand, and their covariates
  (`corpus-covariates.ts`) are in #103, which pinned all 32 on approval
  (2026-10-09). Now pinned, `sweep` and `rd-budget` read it only with
  `--split holdout2 --decision <ID>`, only when `spec/V0.8-DECISIONS.md`
  records that decision as frozen (its criterion approved, and not yet
  answered), only whole, and only once: a second run under the same result
  name refuses, and the result records the decision and the digest of the
  register it was opened against. The report and the scratch probes never
  read it. The self-test drives every refusal from fixtures
  (`mise run selftest:metrics`).

**Photographic holdout (32 images):**

| candidate | tune | holdout | verdict |
|---|---|---|---|
| `sel_hv` 0.15 → 0.30 | +0.39%, CI straddles (§11.5) | **+0.56%** | **rejected** |
| isotropic weights | −0.23%, CI straddles | +0.62%, guards fail | rejected |
| pre-adoption v0.6-derived | +1.53% | +3.87% | (confirms §8 out of sample) |
| compact 21 B `L19@4 C6@3` | −3.67% | −2.78%, vs the shipped shape | adopted |

**The compact row is adopted at −2.78%, below the ≥3% the rule asks for, and
the rule did not apply to it.** `RATIONALE.md`'s rule governs changing a
constant that ships. The compact tier was a new tier code with no incumbent, and
its "shipped shape" is the 26:9 layout resized to 21 bytes, a format nobody
shipped; the −2.78% is reported against it rather than gated on it. The
criterion it was admitted on is the one §8.1 and §8.6 set out before this round
ran: beat ThumbHash on all four metrics, out of sample, at 21 bytes. It does
(the table at the end of this section). That criterion was never written into
`RATIONALE.md` as a rule, which is a gap in the record rather than in the
measurement.

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
the tune arm is **+0.39% with a CI straddling zero** (§11.5), so the result the
holdout rejected no longer reproduces in sample either — and what now clears
zero on tune is `hv = 0`, in the opposite direction. The verdict on `0.30` is
unchanged; the reason it is rejected is now over-determined.

**Alpha holdout (8 images):**

| candidate | tune | holdout | verdict |
|---|---|---|---|
| **A28@3 L22@4 C3@3** | −17.10% | **−16.19%**, every guard improving | **adopted** |
| `alpha_ac_fit` | −0.21% | +0.09% | **rejected** |
| A28@3 + `alpha_ac_fit` | — | −14.48% (worse than without) | rejected |
| compact alpha A16@3 L12@4 C1@3 | −13.00% | −9.49%, guards ok | adopted |

> **This table's `holdout` column can no longer be reproduced, and nor can any
> figure below taken from the alpha holdout.** One of its eight images,
> `cutout-wordmark-aflac`, was deleted from Wikimedia Commons on 2026-08-25 as
> a copyright violation, and no archived copy was found. The split is
> **retired** (#83): `mise run sweep v07-holdout-alpha --split holdout` now
> refuses to run rather than fail on the missing file, and the column has no
> committed result (`verify:experiments --list-unbound` gives the reason).
> Scoring the remaining seven would be a new experiment reported under this
> one's name, and the split has already been read for every verdict in this
> table. So the figures stand as what was measured in `bd6a530`, and nothing
> can check them now. The `tune` column is bound and reproducible from
> `tools/comparison/results/v07-holdout-alpha.json`. The four decisions this
> table records keep their tune evidence (that column, and §11.3 for the alpha
> row and `alpha_ac_fit`) and have lost their out-of-sample evidence. They get
> it back only from a new alpha split, curated on covariates and sealed before
> anything reads it.
>
> **The last row is measured against the 21-byte shipped shape**, not against
> the 32-byte incumbent the three rows above it use — a 21 B candidate against a
> 32 B baseline is a byte-count comparison wearing an allocation comparison's
> clothes. That was already true of its tune figure and was not stated; its
> holdout figure was against the 32 B incumbent instead, so one row was reporting
> its two columns against two different baselines. Both are now the 21 B shape,
> which moves the holdout cell from −6.96% to **−9.49%** and strengthens the
> verdict rather than changing it. The binding in `verify-experiments.ts` records
> the baseline per row, so the two columns cannot drift apart again.
>
> **The moved cell's provenance**, because nothing automatic can supply it: both
> the pinning and the figures in this table are one re-run of `mise run sweep
> v07-holdout-alpha --split holdout` (§6) in `bd6a530`, against the Wikimedia
> corpus of `85f6af3` (§9.5). That output landed in the gitignored
> `output/sweeps/` and was never committed, and the split it scored is now
> retired (above), so the run cannot be repeated. Every holdout cell in this
> table rests on the commit that produced it, which is why the commit is named.

**What #93 did with the alpha split.** It went the way #76 took the
photographic one:

- **Its seven surviving images are `tune2`.** They keep their pins and their
  bytes, and join `tune2` rather than `tune`, so every committed alpha tune
  result keeps its image set. They were read for all four verdicts in the
  table above, so a figure from them is in-sample for those four decisions.
  The deleted `cutout-wordmark-aflac` stays `holdout`, the retired split, so
  a cached copy joins no sweep, and asking for `--split holdout` on the alpha
  corpus still refuses.
- **The replacement is the alpha half of `holdout2`**, labelled
  `sealed-cutout-*`. The seal and the corpus are both read off the label, so
  a sealed cut-out is never scored as a photograph or as tune. It opens
  through the same gate as the photographic half: an alpha config with
  `--split holdout2 --decision <ID>`, only for a decision
  `spec/V0.8-DECISIONS.md` records as frozen (C2, and D6 once its sweep
  exists), whole and once. Its candidates are chosen on three
  covariates and nothing else: the non-opaque and soft-alpha fractions
  `alpha-images.ts` already records, and a silhouette complexity
  (`corpus-covariates.ts`). The candidate list is 16 images, two for each
  combination of mostly opaque or mostly transparent, hard or soft edges,
  and simple or detailed silhouette, drawn in a seeded order under cuts fixed
  in advance. No encoder is run on a candidate. The list, the
  protocol that drew it, and each candidate's covariates, licence and SHA-256
  are in #107. Fourteen of the sixteen were approved and are pinned: a city
  police patch tagged public domain and an AI-generated icon were dropped and
  not replaced, so two cells (opaque/hard/simple, transparent/soft/simple)
  hold one image each. No encoder has run on a pinned image either; the
  split is fetched only when the gate opens.

**What #129 adds: `holdout3`.** C1 read the photographic half of `holdout2`
and C2 its alpha half (§13.7), so neither is unread for the v0.8 D-entries.
`holdout3` is a third sealed split, with a photographic, an alpha and a
graphics part, that no decision has read:

- **The seal.** Labels `sealed3-*`, `sealed3-cutout-*` and `sealed3-graphic-*`,
  the split `holdout3`. `sealed3-` does not start with `sealed-`, so the two
  seals never claim each other's images. `sweep` and `rd-budget` read it only
  with `--split holdout3 --decision <ID>`, only for an entry
  `V0.8-DECISIONS.md` records as `frozen`, only whole, and **once per entry**:
  a second read by the same tool for the same entry refuses under any result
  name, because the gate counts the committed results that record a holdout3
  reading for that entry, not a file name. `sweep` reads the parts its
  config's corpus names, and `all` reads all three in one run; `rd-budget`
  reads the photographic part. No other tool reads it.
- **The protocol**, committed before any candidate was measured
  (`corpus.ts` `HOLDOUT3_PROTOCOL`, `corpus-covariates.ts` `HOLDOUT3_DRAW` and
  `SKIN_REGION`). No encoder, decoder or metric runs on a candidate.
  - **Strata**, each decided by a covariate or by licence and EXIF metadata
    alone, so a conditional candidate can name one as its activation class.
    A pin may sit in several, and records them.
    - *smartphone*: the file's EXIF Make and Model name a phone
      (`isPhoneCamera`; tablets are not phones).
    - *graphics*: a pin of the graphics part.
    - *alpha*: stores an alpha channel with a non-opaque fraction above 0.
    - *skin*: at least 0.10 of the 512 px reference's pixels inside the skin
      region, CIELAB L\* 20–88, C\* 10–50 and hue 25°–80° (the hue band
      holds every skin swatch it was set from, 44.3°–78.4°, and stops short
      of sand at 93.6°; amendment 2).
    - *low-light*: mean L\* ≤ 30, or a low-key fraction (L\* ≤ 10) ≥ 0.25.
    - *extreme aspect*: long edge ÷ short edge ≥ 3.

    On the alpha part the colour covariates describe the stored RGB under
    transparent pixels, so an alpha pin is placed in neither colour stratum.
    The skin region is a colour test, not a detector: sand, wood and warm walls
    fall in it too, and the stratum means "this much skin-coloured area".
  - **Sizes.** At least 48 photographs, 24 cut-outs and 16 graphics, and at
    least 8 pins in every stratum.
  - **Order.** Each axis pools the first 200 hits of each of its Commons
    searches, attributes each file to its first query in list order, and
    takes candidates in ascending `sha256("holdout3:" + title)`.
  - **Admission, on Commons' facts, before any download.** A free licence
    (`isFreeLicence`), a recorded author, no deletion, unfree or
    machine-generated category, at most 100 MP, and not pinned in any corpus
    by title or by SHA-256, Kodak24 included. No author already pinned in any
    corpus, and none twice. Photographs: JPEG, long edge ≥ 2000 px, an EXIF
    camera model, at most 50 MB, and no art, scan, map, diagram, poster,
    screenshot, collage, HDR or composite category; the smartphone axis also
    refuses an EXIF Software naming a desktop editor or stitcher. Cut-outs:
    PNG, long edge ≥ 512 px, at most 25 MB, and none of #107's excluded words
    nor heraldry or insignia (the reason #107's police patch was dropped).
    Graphics: long edge ≥ 1000 px, at most 25 MB, no EXIF camera model, and no
    logo, photograph or scan category.
  - **Axes and tests**, each run in order, an image one axis took being out
    of every later one. At most two picks per query (one on the smartphone
    axis, three on the alpha one), and one per camera model on the smartphone
    axis. Photographs, 48: smartphone 10 (a phone camera, one per model,
    from 19 `Taken with …` categories); extreme aspect 8 (aspect ≥ 3); low
    light 9 (the stratum's test); skin 9 (skin ≥ 0.10, three per tone band by
    the skin pixels' mean L\*: dark below 45, medium below 60, light above);
    high key 4 (high-key fraction ≥ 0.35); chroma floor 4 (mean C\* ≤ 4);
    daylight 4 (mean L\* ≥ 35 and low-key fraction < 0.25). Cut-outs, 24:
    three in each of #107's eight cells (an alpha channel, non-opaque 0.05–0.95,
    not animated, assigned by #107's cuts). Graphics, 16: screenshot, chart,
    map and diagram 3 each, comic and text 2 each (no transparency, not
    animated).

  - **Shortfall.** A part that ends short walks its axes again, in list
    order, one pick per axis per round, with slot quotas lifted, until it is
    full; a draw that still misses a size or a stratum minimum fails rather
    than pins.
  - **Amendment 1, after the first draw.** The first draw ended one cut-out
    short, 23 of 24, and so failed. It had consumed the whole alpha pool,
    refusing 165 candidates only because their cell was full, and the
    shortfall walk resumed from the end of the pool, where nothing was left.
    With slot quotas lifted, a short axis now first reconsiders the
    candidates it passed over only for a full slot, in seeded order. The
    amendment changes no test, cut or quota, and was made with no encoder run
    on any candidate (`corpus-covariates.ts` `HOLDOUT3_AMENDMENTS`).
  - **Amendment 2, after review.** The skin region's hue band ended at 70°,
    which contradicted its recorded basis: the swatches it was set from sit at
    44.3°–78.4°, and 70° refused the palette's two light swatches, sRGB
    (241,194,125) at 78.4° and (224,172,105) at 74.8°, so the skin axis's
    light band under-sampled light skin. The band now ends at 80°. That
    changes every candidate's skin figure, so the split was drawn again from
    the start with the same queries, seed and quotas. The re-draw excludes
    only the other splits' pins (the first run's own picks were in the tables
    by then), and its record lists every candidate the walk reached with what
    its facts and bytes answered. No encoder had run on any candidate.
- **The draw, 2026-11-22**, under amendments 1 and 2. Every axis's pool had
  the same size as in the run before it; the walk reached 2442 candidates and
  pinned 48 photographs, 24 cut-outs and 16 graphics. Against the amendment-1 run, 84
  picks are unchanged and four skin picks differ: the wider hue band moved
  enough pixels into the region to change which candidates fill the dark and
  light bands first. The strata hold smartphone 17, graphics 16, alpha 24,
  skin 17, low-light 12 and extreme aspect 16. The record is committed as
  `tools/comparison/fixtures/holdout3-draw.json`: the protocol, skin region
  and exclusions it ran under, every query's hits, every walked candidate in
  seeded order with its refusal or its covariates, and the picks. `mise run
  selftest:metrics` replays it offline (`replayHoldout3`) under the
  committed `HOLDOUT3_DRAW` and checks that the replay re-derives the
  record's picks, refusals and strata, and that the shipped pins are exactly
  those picks; the pins themselves are written from the replay by
  `corpus-covariates.js --pin-holdout3`. Every source was probed present
  under its recorded licence (`mise run corpus:licenses --probe`), and the
  self-test also checks the sizes, the strata minima, each pin's strata
  against its recorded figures, and disjointness from every other pinned
  image, Kodak24 included, by SHA-256 and by Commons title. The pins name
  what the protocol admits, not what anyone chose: the skin stratum holds a
  Peruvian portrait head jar and a neo-Gothic cathedral (whose mean skin-pixel
  L\* 61.0 makes it a light-band pick), the chroma floor a scan whose EXIF
  names a flatbed scanner, and the graphics part a 1976 comic strip Commons
  records as public domain. Nothing has read the split.

The alpha allocation validated emphatically on that split: SSIMULACRA2
−307.2 → −242.7, Butteraugli 57.56 → 44.36, DSSIM 0.2319 → 0.2179, αMAE
0.2696 → 0.1675. Those figures are from the retired split and cannot be
reproduced either.

`alpha_ac_fit` does not, and is left at `false`. It is principled and free, and
it measured −0.21% on tune — but on the retired split it was +0.09% alone and
made the adopted allocation *worse* in combination. The knob stays for a future
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
| Alpha row → `L 22 @ 4, a/b 3 @ 3, A 28 @ 3` at tier 0 and the tier-1..3 base (the compact tier takes its own, below) | −17.10% on tune (§11.3), −11.95% on tune at tier 1 (§11.11); −16.19% holdout, all guards, on the retired alpha split, which can no longer be reproduced (§11.12) |
| Compact tier, code 4, 21 B, `L 19 @ 4 / a/b 6 @ 3` (alpha `L 12 @ 4 / a/b 1 @ 3 / A 16 @ 3`) | Opaque layout: beats ThumbHash on all four on the photographic holdout (§11.10, §11.12). Alpha layout: −13.00% on tune against the 21 B shipped shape; −9.49% holdout, on the retired alpha split, which can no longer be reproduced (§11.12) |
| Deadzone made reachable again | It was byte-identical at every value (§11.7) |

Deliberately unchanged, each with the number that left it alone:

| Kept | Why |
|---|---|
| `sel_hv = 0.15` | 0.30 was better on two tune corpora and **worse on holdout** (§11.12); on the current corpus it is worse on tune too, and `hv = 0` is better — unvalidated on holdout (§11.5). Stands under R1 on `holdout2` (§13.7): neither 0.30 nor 0 is distinguishable from 0.15 |
| `aniso_oblique = 1.2` | Isotropic is statistically indistinguishable on tune and worse on holdout (§11.5, §11.12) |
| µ-law µ_L = 5 / µ_C = 8 | Every alternative family is worse, including corpus-trained codebooks (§11.6) |
| No deadzone | +0.08% once the knob could move the output (§11.7) |
| Quantization ranges | Every arm within ±0.17% (§11.8) |
| No scalefactor bands | −0.14%, below threshold and unable to pay its signalling (§11.9) |
| Tier-0 opaque layout | Holds on non-photographic content; no candidate significantly better (§11.4) |
| `alpha_ac_fit = false` | −0.21% on tune, +0.09% on the retired alpha holdout, which can no longer be reproduced (§11.12) |

What is still not measured, and is now the honest list for v0.8:

* **Perceptual validation (U19).** Unchanged and still the most valuable missing
  thing. Every number in this file is metric-based, and §11.12 is a fresh
  reminder that a metric that agrees with itself across two corpora can still
  fail on a third split.
* **Tiers 2–3 alpha**, inherited from the tier-1 measurement rather than
  measured directly. Register entry D6 asks it, to be read on the sealed
  alpha half of `holdout2` (#93).
* **Out-of-sample evidence for the alpha rows above.** Every alpha row and
  `alpha_ac_fit` lost it with the retired split. Register entry C2 re-reads
  them once on the sealed alpha half of `holdout2` (#93, §11.12).
* **Smartphone-source photographs** — sensor noise, motion blur, heavy JPEG
  history. Both photographic corpora are professional captures.
* **Entropy-coded AC** (−1.6% at 32 B, −4.8% at 108 B, §7.13), refused here
  on the fail-fast O(1) length check rather than on its quality. Register
  entry D1 has since built a total code that keeps the check, and decided it
  at codes 2–4 on `holdout3`: it passes R1 at code 3 and not at codes 2 and 4
  (§13.8).

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

**The table is generation v2** (#168). It was first taken at `e310475`, on
generation v1 (`rd-budget-holdout.json`). #162 then changed the encoder at
codes 3 and 4, so the table was re-recorded at master on the same 32
photographs, which `--split tune2` scores now (`rd-budget-tune2.json`). Every
row below code 3 reproduces to the value; the two ChromaHash rows at 411 B
and 1623 B move, and the generation-v1 values of those two rows are kept in
the second table. The v1 rows reproduce exactly at `225bdce`, the last
generation-v1 revision (§13.16), so the move is the format change, not a
scoring drift. No sealed split was read.

**The retired holdout split (32 photographs, now `tune2`).** Bold marks the
leader in a byte neighbourhood.

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
| 404.8 | WebP | 7.518 | **−62.6** | **14.21** | **0.2349** |
| 411 | ChromaHash tier 3 | **7.313** | −67.6 | 16.26 | 0.2476 |
| 1574.0 | RawRGB565 | 6.570 | −65.5 | 16.47 | 0.2400 |
| 1576.4 | WebP | 5.906 | −47.1 | 11.56 | 0.2165 |
| 1576.6 | JPEG | 6.078 | −51.6 | 12.01 | 0.2225 |
| 1595.6 | **AVIF** | **5.471** | **−47.1** | **11.53** | **0.2157** |
| 1623 | ChromaHash tier 4 | 6.642 | −61.7 | 13.62 | 0.2351 |

**Generation v1, kept as the record #162 moved** (`rd-budget-holdout.json`,
`e310475`). These are the values the table carried until #168; every other row
of the table is the same in both runs.

| Bytes | Format | ΔE00 ↓ | SSIM2 ↑ | Butter ↓ | DSSIM ↓ |
|---|---|---|---|---|---|
| 411 | ChromaHash tier 3 | 7.783 | −76.8 | 17.94 | 0.2507 |
| 1623 | ChromaHash tier 4 | 6.768 | −62.1 | 13.99 | 0.2400 |

At generation v1 WebP led all four metrics at ~405 B, and code 3 has since
taken ΔE00 off it: the entropy coder generation v2 adopts at code 3 lowers
code 3's ΔE00 by 6.0% here, enough to pass WebP, and improves the three
structural metrics without moving any of them past WebP. Code 4, where
generation v2 turns the synthesis window on, improves on all four metrics and
changes no ordering against the real codecs; against raw RGB565 it now wins
DSSIM, which it tied.

Four things this settles, and a fifth about the top of the ladder.

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
   as §7.14 already says. At ~405 B ChromaHash still leads ΔE00 (7.313
   against WebP's 7.518) while WebP takes the other three, so the ΔE00
   crossover is between 411 B and ~1.6 kB. At generation v1 it was between
   193 and 411 B, where WebP led all four. The same ordering holds on tune at
   ~190 B (8.788 vs 8.934); tune has not been re-run at 411 B for generation
   v2. §14.1 of the spec states this rather than arguing around it.
5. **At ~1.6 kB every real codec leads, and so, on ΔE00, do raw pixels.** AVIF
   leads all four metrics, and WebP and JPEG beat code 4 on all four as well.
   ΔE00 goes to AVIF by 18% (5.471 against 6.642). Uncoded RGB565 also beats
   code 4 on ΔE00 here (6.570), while losing SSIMULACRA2, Butteraugli and
   DSSIM to it. That half is split-dependent: on tune code 4 beat RGB565 at
   generation v1, 6.729 against 6.959 (§2). These rows were added in the
   2026-09 re-measure; the table used to stop at 411 B, and the spec's claim
   about 1.6 kB (§14.1) cited round 1's §2 instead.

The structural weakness §2 identified is narrowed but not gone: lqip-modern
still takes SSIMULACRA2 and Butteraugli at ~84 B, where ChromaHash wins ΔE00 by
13%. The format still buys colour accuracy with structural accuracy; it now does
so over a wider range and loses the trade later.


## 12. Round 4: the instruments, and the window (2026-09)

This round adds no constant. It adds two things the file needed before it could
add another: a metric that can see the artifact the format is actually accused
of, and a decode path that can tell the format's own reconstruction apart from
the browser's interpolation of it. Then it uses both on the one lever §5 listed
that has never been refuted with a number.

> **These numbers are on the Wikimedia corpus** (`85f6af3`) — the same corpus
> §1–§11 were re-baselined onto in §9.5, so a figure here and a figure above are
> now comparable. They were written not to be: each table below is a
> self-contained sweep with its own incumbent, so guards, Δ% and the paired CI
> are all measured *within* the run, which is the reading that stays valid
> across a corpus change. Prefer it.

### 12.1 Ringing could not see the artifact, and no sweep could see ringing

Two gaps, and they compound.

`metrics/local.ts` measures overshoot: error escaping the reference's local
`[min, max]`. That is what makes a blur score exactly zero, and it is also a
hard ceiling on what it can detect. A ripple oscillating *inside* the envelope
scores zero. So does a broad wave over a textured region, and so does a
directional stripe. Away from hard edges, those are precisely what a
truncated-cosine reconstruction produces — and they are what a reader means when
a placeholder "looks textured" rather than merely blurry.

And no sweep computed it regardless. `sweep.ts` builds its scoring config
without the flag, so **every constant in this document was chosen on ΔE00 plus
three aggregate fidelity guards** — none of which separates *smooth but wrong*
from *sharp with artifacts*. That is the same instrument set that rejected the
synthesis window for v0.6.

**Spurious detail** (`metrics/spurious.ts`) is the second artifact metric. Both
sides go onto one grid and through the same separable DCT-II — the format's own
basis, so a coefficient of the transform is a coefficient of the kind ChromaHash
transmits — and the score is the RMS of `max(0, |D| − |I|)` in 8-bit levels,
where `I` is the reference area-averaged onto the decode's raster: the ideal
low-pass, the best any placeholder at that raster could do.

It holds the same discipline: **a decode that is that ideal low-pass scores
exactly zero**, and `selftest:metrics` asserts it over 8 decode sizes × 3
content shapes. Missing detail is free — that is what ΔE00, SSIMULACRA2 and
DSSIM charge for — and it is magnitude-only, so it is an artifact measure and
never a fidelity score.

The orientation split comes free, and is worth having because the selection
order is deliberately anisotropic (`aniso_oblique = 1.2`, `sel_hv = 0.15`) and
whether that asymmetry is *visible* had never been measured.

Two independent checks that it recognises formats by their construction, none
of it fitted. **This table and §12.4's come from a report run, not a sweep, so
`verify:experiments` does not bind them** — it checks sweep output, and nothing
here aggregates orientation into a sweep row. They are reproduced with
`node tools/comparison/dist/main.js --skip-harnesses --images '<one photo>'` and
read out of `output/report.json`'s per-format `local` block; treat them as
illustrative rather than as gated figures, unlike §12.2 and §12.3.

| Format | Vertical | Horizontal | Diagonal | What it is |
|---|---|---|---|---|
| unpic | 0.09 | **16.45** | 0.96 | a CSS gradient — horizontal bands |
| BlurHash | 6.15 | 6.01 | **0.08** | separable rectangular basis, no diagonal term |
| lqip-modern | 5.71 | 4.83 | 4.88 | a plain downscale; ringing scores exactly 0.00 |
| ChromaHash t1 | 2.29 | 3.62 | 2.09 | ℓ2 ball, weighted against diagonals |

ChromaHash shows no gross directional artifact. The oblique weight is doing
something — diagonal is the lowest of its three — but nothing like BlurHash's
structural blindness to it.

### 12.2 The synthesis window, at the default tier

`sweeps/synthesis-window.json`, 31 tune photographs, `expectBytes: 32`. The
taper is decoder-side and the encoder is byte-identical with it on, so every
arm is the same 32 bytes; adopting one would move every test vector and change
no hash.

| variant | ΔE00 | Δ% | SSIM2 | Ring | Spur | paired 95% CI | Holm p | guards (means) | guards (CI) |
|---|---|---|---|---|---|---|---|---|---|
| shipped (no window) | 11.481 | — | −342.1 | 1.03 | 3.53 | — | — | (base) | (base) |
| w_min 0.85 exp 1 | 11.518 | +0.33% | −344.1 | 0.79 | 2.44 | [−0.076, −0.003] | 0.0692 | FAIL | inconclusive |
| w_min 0.7 exp 1 | 11.652 | +1.49% | −347.9 | 0.68 | 1.79 | [−0.269, −0.086] | 0.0014 | FAIL | FAIL |
| w_min 0.7 exp 2 | 11.781 | +2.61% | −349.7 | 0.75 | 1.52 | [−0.428, −0.185] | 0.0014 | FAIL | FAIL |
| w_min 0.5 exp 1 | 11.983 | +4.38% | −356.2 | 0.80 | 1.28 | [−0.711, −0.320] | 0.0014 | FAIL | FAIL |
| w_min 0.5 exp 2 | 12.311 | +7.23% | −360.8 | 1.02 | 0.95 | [−1.108, −0.577] | 0.0014 | FAIL | FAIL |
| luma only 0.7 exp 1 | 11.654 | +1.51% | −347.3 | 0.68 | 1.90 | [−0.261, −0.097] | 0.0014 | FAIL | FAIL |
| chroma only 0.7 exp 1 | 11.484 | +0.03% | −342.7 | 1.03 | 3.58 | [−0.032, +0.029] | 0.8103 | ok | ok |

Four things this settles.

1. **The window does what it is for, and by a lot.** Invented detail falls
   monotonically with taper strength, 3.53 → 0.95, a **73% reduction** at the
   strongest setting. Nothing else on the roadmap moves an artifact number like
   that.
2. **It is paid for in ΔE00 and SSIMULACRA2, monotonically.** Every windowed arm
   fails guards, and the paired CI excludes zero from `w_min 0.85` onward.
   (§13.5: after Holm the ΔE00 cost is established from `w_min 0.7` onward.
   `w_min 0.85`'s interval clears zero by a margin a different bootstrap seed
   can erase, and on intervals its guards are `inconclusive` rather than
   failed.) The
   pre-registered rule wants ≥3% ΔE00 *improvement* with no guard regressing
   (the guards must hold, not improve); this is the opposite sign, and the
   guards regress as well. **The v0.6 rejection stands — and now it stands on
   evidence rather than on an instrument that could not see the other half.**
3. **The effect is entirely luma.** `luma only` reproduces the both-channel arm
   almost exactly (spurious 1.90 vs 1.79, ΔE00 +1.51% vs +1.49%), while
   `chroma only` is inert on every column — spurious 3.58 against a 3.53 base,
   a paired CI straddling zero, the only arm that passes guards precisely
   because it does nothing. `RATIONALE.md` attributes v0.5's visible striping to
   "chroma quantization noise, not luma ringing". Whatever was true at the v0.5
   constants, at v0.7's the invented structure is **luma**, and a chroma taper
   cannot touch it.
4. **Ringing is not monotonic in the taper, and spurious is.** Ringing bottoms
   out at `w_min 0.7 exp 1` (1.03 → 0.68) and climbs back to 1.02 at the
   strongest arm, while spurious keeps falling. They are measuring different
   things, which is the case for having both.

### 12.3 The same knob at code 2, where the positioning claim lives

`sweeps/synthesis-window-upper.json`, `expectBytes: 108`. Split from the table
above rather than added to it: Δ%, guards and the paired CI are computed against
the first row, so mixing tiers would compare a 108-byte arm to a 32-byte
incumbent and make the tightest instrument here meaningless.

| variant | ΔE00 | Δ% | SSIM2 | DSSIM | Ring | Spur | paired 95% CI | Holm p | guards (means) | guards (CI) |
|---|---|---|---|---|---|---|---|---|---|---|
| t2 shipped (no window) | 9.670 | — | −213.2 | 0.2560 | 1.32 | 3.64 | — | — | (base) | (base) |
| t2 w_min 0.85 exp 1 | 9.678 | +0.08% | −216.5 | 0.2549 | 1.03 | 2.62 | [−0.028, +0.011] | 0.9143 | FAIL | FAIL |
| t2 w_min 0.7 exp 1 | 9.763 | +0.96% | −222.2 | 0.2544 | 0.87 | 1.99 | [−0.141, −0.050] | 0.0010 | FAIL | FAIL |
| t2 w_min 0.5 exp 2 | 10.271 | +6.21% | −242.7 | 0.2562 | 1.01 | 1.26 | [−0.754, −0.460] | 0.0010 | FAIL | FAIL |
| t2 luma only 0.7 exp 1 | 9.755 | +0.88% | −221.4 | 0.2544 | 0.88 | 2.02 | [−0.127, −0.048] | 0.0010 | FAIL | FAIL |
| t2 chroma only 0.7 exp 1 | 9.678 | +0.08% | −214.0 | 0.2561 | 1.30 | 3.70 | [−0.036, +0.022] | 0.9143 | ok | inconclusive |

The pattern holds, and the light arm gets interesting.

At `w_min 0.85`, ΔE00 is **statistically free** — the paired CI is
[−0.028, +0.011] and includes zero, on 31 images, from the instrument §11 built
precisely to resolve differences this small. For that nothing, the arm buys a
**28% cut in invented detail**, a **22% cut in ringing**, and a *better* DSSIM
(0.2549 vs 0.2560).

It fails guards on one metric: SSIMULACRA2, −3.3 points against a −1.0
tolerance. On intervals the failure is *shown*, not just probable: the arm's
`guards (CI)` is `FAIL` (§13.5). `chroma only`'s pass, by contrast, is a
point-mean one, and on intervals it is `inconclusive`. That is the whole verdict, and it deserves to be stated as a tension
rather than filed as a refutation:

* SSIMULACRA2 is the metric ChromaHash **already loses** to WebP and lqip-modern
  from ~84 B up (§2, §11.14). It is the axis the format is weakest on.
* It is also a **fidelity** score fitted to human ratings of *coded images*,
  where invented high-frequency structure and real high-frequency detail are
  hard to tell apart from a distance. A taper removes both.
* And per §7.14's U19, **not one of these metrics has ever been validated
  against human judgement at placeholder fidelity.** §8.5 already recorded three
  MSE-reducing changes moving ΔE00 the wrong way.

So the honest statement is: the window trades a metric the format is losing
anyway for two artifact metrics it wins on, at no measurable ΔE00 cost, and
**the existing rules say no**. Whether the rules are right about this is the
U19 question, which this round does not answer and cannot.

### 12.4 What the previews were showing, and the render at display size

The artifacts a reader sees in the comparison report were the prompt for this
round, so it is worth stating what that report actually renders. Every preview
is a decode at its **own** raster — 32×21 at the default tier — placed in a
150 px box with `image-rendering: pixelated`, i.e. magnified about seven times.
The button labelled "Toggle Blur" applied no blur; it switched
`image-rendering` to `auto`, the browser's interpolation of those same samples.

Neither view is the format drawing a picture at display size, and until this
round nothing could produce one: `render_at_size` has always been able to
evaluate the basis at any grid, but it is private, and every public entry point
either uses the natural raster or takes a per-axis `min` against it. No binding,
in any of the nine languages, can ask for it. The scoring path could not either
— it decodes capped to the ≤100 px encoder input and hands the result to
libvips, whose enlarger overshoots a step edge by ~7% of its own.

`research-render` (off by default, no binding exposes it) closes that, and the
report gains a row: the same 32 bytes, rendered directly at the 512 px
reference, so the shared upscale is a no-op for it alone.

First measurement, one photograph (`chroma-black-and-white`):

| | ΔE00 | DSSIM | SSIM2 | Butteraugli | Spurious |
|---|---|---|---|---|---|
| t1, decode at 32 px + upscale | 9.50 | 0.1844 | −180.1 | 32.88 | 4.77 |
| t1, native render at 512 px | 9.49 | 0.1843 | −179.9 | 32.82 | 4.64 |

**The two are the same picture on every metric that can compare them.** Not
close — identical to three significant figures on all four fidelity scores, and
within noise on invented detail. Rendering the format's own continuous
reconstruction at display size, instead of sampling it at 32 px and letting a
resampler interpolate, changes nothing a metric here can detect.

**Ringing is deliberately absent from that table, and the reason is worth
recording.** The first draft of this section reported ringing 0.85 against 2.32
and concluded that the native render "overshoots 2.7× more" because a truncated
cosine basis can overshoot where bilinear interpolation cannot. That conclusion
was wrong, and the metric — not the format — produced it.

`metrics/local.ts` derives its envelope radius from the *upscale factor*:
`scale = max(refW/decW, refH/decH)`, `radius = ceil(2·scale)`. A 32×21 decode
against a 512×341 reference gets **radius 33**; a native render at 512×341 gets
**radius 2**. Those are different instruments. A radius-2 envelope is a 5×5
local min/max of a photograph, tight enough that almost any reconstruction
escapes it.

Measured directly, with the *same picture* presented at both decode sizes —
exactly 16×, so nearest-neighbour sampling makes the two decode planes
pixel-identical and only the radius differs:

| presentation | radius | ringing |
|---|---|---|
| 32×20 decode against a 512×320 reference | 32 | **0.000** |
| the identical picture as a 512×320 decode | 2 | **10.482** |

The same picture, zero or ten depending only on how it is handed to the metric.
The 0.85-vs-2.32 gap is comfortably inside that, so it carries no information
about the format. The causal story in the withdrawn draft was independently
wrong too: `computeRinging` never sees `upscale.ts` at all — it sample-and-holds
through `nearestPlane` precisely so a resampler's halo is not charged to a
format — so both rows' decode planes are step functions and neither can
overshoot by interpolation.

This is a limit of the ringing metric, not a defect in it: `r >= S` is what makes
a low-pass score exactly zero, and that derivation *requires* the radius to track
the decode's footprint. The consequence is simply that **ringing is comparable
only between decodes at the same raster** — which `local.ts` already says, and
which is why it reports `ringWindowRadius` alongside the score. Spurious detail
is much less grid-sensitive (a controlled probe gives 12.48 at grid 32 against
14.19 at grid 256 for one picture), so it is the artifact column this table can
carry.

What survives is narrower than the withdrawn claim and more useful: on one
photograph, rendering at display size buys **nothing measurable**, at ~256× the
per-pixel decode cost. That is an argument against promoting `render_at_size` to
public API in nine languages, not for it — and it is the row to widen to the
corpus before either decision. It also settles the presentation question: the
blockiness in a report preview is the magnification, not the format, and the
format's own render does not look different enough for any metric to tell.

### 12.5 What this round did not do

* **No constant moved.** Every arm above is a measurement.
* **`aspect.ts` gained the self-checks** that `metric-selftest.ts`'s docstring
  and the `selftest:metrics` task description had both claimed since it was
  written, and neither had. One of them pins the 1.59% a 3:2 source lands on —
  which is the number an `<img>` receives, against the aspect *byte*'s 1.09%.
* **U19 is still open, and this round raises its stakes.** §7.14 said adding two
  computed metrics arguably does that; §12.3 is what it looks like when it
  happens — a decision that now turns on whether SSIMULACRA2 is right about
  placeholders, which nothing here can say.

## 13. Round 5: where the format fails, on real photographs (2026-09)

Every table above chooses a constant, and the unit that decides a constant is a
mean over a corpus. This round asks a different question — not *how much* is the
reconstruction wrong, but *what kind* of wrong, at which tier, on which content
— because that is the question a wire change starts from and no aggregate can
answer it. Three things were missing and are added here.

**A third locally-computed metric.** `spurious` measures energy the decode has
that the reference does not, and clamps the other direction to zero by design.
That clamp was a measurement nobody was taking. **Spectral deficit** is the same
comparison with the sign flipped — `max(0, |I| − |D|)`, structure the original
has that the placeholder drops — computed in the same pass from the same two
spectra. The pair is the only thing here that separates *smooth but wrong* from
*sharp with artifacts*: ΔE00, SSIMULACRA2, Butteraugli and DSSIM are aggregate
fidelity scores that charge for both at once, which is exactly why §12.3's
verdict came down to one SSIMULACRA2 number that could not say what it was
reacting to. It holds the same discipline as its siblings — an ideal low-pass
scores **exactly zero** on both, asserted in `selftest:metrics` over 8 decode
sizes × 3 content shapes, and over four decode rasters at every pin, which is
the case that caught the grid-pin defect §13.3 records — and it is not a fidelity score either: a placeholder
is *supposed* to have a deficit, so it is read against `spurious` as an exchange
rate, never minimized.

**The ladder.** §12 measured artifacts at codes 1 and 2, against one knob. No
run has ever taken them along the tier ladder, so the format's most-repeated
informal criticism — that the upper tiers look *textured* rather than merely
soft — had never had a number attached in either direction.

**The corpus's own covariates, read back.** `natural-images.ts` records mean L*,
mean chroma C* and Laplacian detail energy for all 39 photographs, measured on
the same 512 px reference the harness scores against, because §9.1's audit
needed them to choose the set. Nothing had read them since. `mise run stratify`
does. (The figures it reads are `corpus-covariates.ts`'s, re-measured in #102
because the originals came from a formula nobody recorded.)

### 13.1 The instrument has to be held still first

`sweeps/artifact-ladder.json` scores each tier on its **own** raster, which is
what a viewer of that tier receives:

| tier | bytes | ΔE00 | SSIM2 | DSSIM | Ring | Spur | Deficit |
|---|---|---|---|---|---|---|---|
| code 0 (compact) | 21 | 12.156 | −372.0 | 0.2665 | 1.32 | 3.98 | 27.10 |
| code 1 (default) | 32 | 11.481 | −342.1 | 0.2639 | 1.03 | 3.53 | 24.81 |
| code 2 | 108 | 9.670 | −213.2 | 0.2560 | 1.32 | 3.64 | 23.24 |
| code 3 | 411 | 7.832 | −89.5 | 0.2451 | 1.48 | 4.48 | 19.35 |
| code 4 | 1623 | 6.729 | −63.8 | 0.2343 | 2.30 | 6.56 | 13.25 |

**Do not read the artifact columns down this table.** Both spectral scores are
defined on the decode's own grid, so a tier-4 row is judged on frequencies a
tier-0 row does not have, and part of any difference between them is the
instrument rather than the format. §12.4 is the record of that exact mistake
being made and caught, with ringing: a withdrawn claim that a native render
"overshoots 2.7× more", produced by two envelope radii and not by two pictures.

So the ladder is run again with the spectral grid pinned to 32 px — the compact
tier's natural raster, and therefore the largest grid all five arms can be asked
about on equal terms. `sweeps/artifact-ladder-common-grid.json`, 31 tune
photographs:

**One thing the pin does not do, stated before the table rather than after it.**
A strict reading of "the frequencies all five tiers can represent" would score
invention *above* the pinned grid's Nyquist at exactly zero, because no arm can
be asked about it. The pin does not deliver that. Both sides reach the analysis
grid through `areaPlane`, which is a box decimation rather than an anti-aliased
low-pass, so invented structure above the pin folds back into the grid and is
charged — with a gain that depends on the arm's own raster, since a larger
raster decimates by a larger factor. Measured directly on a synthetic pair
(identical invented amplitude above a 32 px pin's Nyquist, decode raster
varied), the score *falls* as the raster grows: the residue is largest on the
compact arm and smallest on the archival one. That is the conservative direction
for §13.2, whose finding is that invention *rises* with tier — the instrument
understates the rise it reports. It is recorded rather than fixed: replacing the
decimation with an anti-aliased low-pass would move every number in this section
and is not a change to make at the end of a round.


| tier | bytes | ΔE00 | Spur | Deficit | Spur / Deficit |
|---|---|---|---|---|---|
| code 0 (compact) | 21 | 12.156 | 3.98 | 27.10 | 0.15 |
| code 1 (default) | 32 | 11.481 | 3.53 | 24.81 | 0.14 |
| **code 2** | 108 | 9.670 | **3.48** | 17.02 | 0.20 |
| code 3 | 411 | 7.832 | 4.22 | 8.45 | 0.50 |
| code 4 | 1623 | 6.729 | 4.22 | 4.58 | **0.92** |

Ringing is deliberately still reported per row and still not comparable across
them: it derives its envelope radius from the upscale factor and has no
equivalent knob, which is the asymmetry §12.4 documents.

The code-3 and code-4 rows of both tables are **generation v1**. #162 changed
the encoder at those two codes (the coder at code 3, the window at code 4), so
a re-run at master moves them and nothing else; at `225bdce`, the last v1
revision, both ladders reproduce to the value (§13.16).

### 13.2 The upper tiers buy fidelity by inventing

The paired differences in spurious detail this section reads, every tier against
code 2 on the same 31 photographs of the pinned-grid ladder, and the top two
against each other:

| comparison | Spur Δ | paired 95% CI | Holm p |
|---|---|---|---|
| code 0 − code 2 | +0.496 | [+0.005, +1.023] | 0.0976 |
| code 1 − code 2 | +0.048 | [−0.409, +0.461] | 0.7991 |
| code 3 − code 2 | +0.735 | [+0.358, +1.159] | 0.0008 |
| code 4 − code 2 | +0.742 | [+0.270, +1.195] | 0.0072 |
| code 4 − code 3 | +0.007 | [−0.280, +0.261] | 0.9209 |

`mise run arms artifact-ladder-common-grid --baseline "code 2 (108 B)"` prints
the first four rows (and the same comparison for every other metric), and
`--baseline "code 3 (411 B)"` the fifth. Every row with code 3 or code 4 in it
is generation v1 (§13.16): on generation v2 code 3 − code 2 is +0.780 and
still excludes zero, and code 4 − code 2 is −0.354 [−0.810, +0.081], the rise
at code 4 gone with the window D3 adopted there. Δ is the row's tier minus the reference
tier, so positive means the row invents more. The Holm p is adjusted across the
four tiers compared with the same reference, which for the last row is code 3.

Three findings, on one instrument.

1. **Invented structure has a floor, and it is codes 1–2.** Spurious falls
   3.98 → 3.53 → **3.48** and then rises, 4.22 at code 3 and 4.22 at code 4.
   The two lowest cells are not separable, and this does not claim they are: a
   paired bootstrap over the same 31 photographs puts code 1 − code 2 at
   **+0.048, 95% CI [−0.409, +0.461]**, straddling zero, and code 0 − code 2 at
   +0.496 [+0.005, +1.023], which clears zero by 0.005 and not after Holm
   (0.0976). Drawn at 1,000 resamples it was [−0.009, +1.015] and straddled
   zero; raising the count to 10,000 (§13.5) moved it across. A bound 0.005
   from zero is the seed's to decide as much as the data's, so it is read as
   unresolved here. Calling code 2 *the minimum*
   would be reading a 0.05-level gap this corpus cannot resolve — the mistake
   §11.5 declines to make when it calls its leading five layouts a plateau
   rather than crowning the top row.

   The **rise off that floor is what survives**: code 3 − code 2 is +0.735
   [**+0.358, +1.159**] and code 4 − code 2 is +0.742 [**+0.270, +1.195**], both
   excluding zero. The top two are a plateau of their own — code 4 − code 3 is
   +0.007 [−0.280, +0.261]. So the shape is two levels rather than five: a floor
   at codes 1–2, and a step up to codes 3–4 that stands **21%** above it while
   ΔE00 improves 30%. That codes 1–2 are also where §11.14 puts the format's
   strongest cross-format position is not a coincidence worth asserting from two
   numbers, but it is worth writing down.

   (Intervals are the seeded paired bootstrap in `stats.ts` that every sweep's
   ΔE00 column already uses, taken over the spurious series in
   `results/artifact-ladder-common-grid.json` — the same construction §7.12 and
   §11.5 quote. They are the table above, which `verify:experiments` binds; until
   `mise run arms` existed no committed command reproduced them. Every reading
   above survives Holm, in both directions: the two rises stay significant and
   the three gaps called unresolved stay unresolved.)
2. **At code 4 the format invents almost as much as it still lacks.**
   Spurious 4.22 against deficit 4.58 — a ratio of 0.92, against 0.14 at the
   default tier. Read plainly: on the frequencies every tier can represent, the
   archival tier's remaining error is roughly half missing structure and half
   fabricated structure. Every fidelity metric improves monotonically across that same
   range, and none of them can say this, because each charges for both halves at
   once.
3. **Deficit falls monotonically and fidelity tracks it, not spurious.**
   27.10 → 4.58, an 83% reduction, alongside ΔE00 −45% and SSIMULACRA2
   −372 → −64. The tiers do work. What the pair adds is the price: **the last
   two tiers spend 73% of the remaining deficit and buy 21% more invention.**

This is the number behind the informal criticism, and it does not refute it.

### 13.3 The content the artifact prefers stops being predictable

`mise run stratify artifact-ladder-common-grid --metric spurious --by detail`.
Equal-count terciles of the tune corpus by detail energy — the mean absolute
4-neighbour Laplacian of L\* on the upright 512 px scoring reference, as
`corpus-covariates.ts` defines and measures it — bins held fixed across arms;
`r` is Pearson over all 31.

| tier | smooth (2.0–4.9) | mid (5.0–8.1) | textured (8.5–22.1) | r |
|---|---|---|---|---|
| code 0 | 4.37 | 4.22 | 3.30 | **−0.30** |
| code 1 | 3.53 | 3.81 | 3.25 | −0.16 |
| code 2 | 3.45 | 3.95 | 3.05 | −0.18 |
| code 3 | 3.80 | 4.68 | 4.22 | +0.09 |
| code 4 | 3.54 | 5.13 | 4.07 | **+0.05** |

> **Re-measured for #102.** This table used to bin on `detail` figures that no
> committed code computed and that no formula tried could reproduce. The
> covariates are now `corpus-covariates.ts`'s, re-measured for every pinned
> photograph, on a different scale from the old figures (hence the bin edges),
> though they rank the images much the same way: 4 of the 31 tune photographs
> change tercile. The same change turned the one EXIF-rotated tune photograph
> upright, which moved its own scores. The readings below are of this table,
> and none of them changed its verdict.

**No tier's correlation with detail is distinguishable from zero.** At
n = 31, |r| must reach 0.355 to differ from zero at 0.05, and the largest here is
−0.30 at code 0, with a 95% interval of [−0.59, +0.06]. This table used to say
the correlation "does not survive the ladder", which reads a relationship into
the low tiers that the sample never established: there was nothing to survive.
What remains is descriptive, and is read as a lean rather than a finding. At
the low tiers r leans negative (−0.30, −0.16, −0.18 at codes 0–2): every one
of the three invents least on the *most textured* tercile, but only code 0's
bins fall monotonically, inventing most on the smooth photographs — a handful
of coefficients laid across a near-flat field would do that, as low-order-basis
banding. At codes 1 and 2 the peak is the middle tercile. Ringing leans the
same negative way at every tier (r = −0.10 to −0.29, none significant). At the
upper tiers even the lean is gone: r is +0.09 and +0.05, and the bins stop being
monotone in either direction, peaking on the middle tercile and falling back on
the most textured one.

An earlier form of this table read as a clean sign change — the invention
following the texture at codes 3 and 4 — and that reading was an artifact of the
instrument, not of the format. The pinned grid was double-quantizing every
decode whose raster sat above it, which inflated the upper tiers' spurious
scores in proportion to how far they had been pinned; `metrics/spurious.ts`
records the defect and `selftest:metrics` now pins it shut. What is left is
weaker than the sign change, and at this sample size it is not a relationship
at all: a lean at the low tiers that no test here can tell from noise, and no
lean above them.

Whether low-tier banding and upper-tier invention are two different defects,
wanting two different answers, is therefore still open. This corpus cannot
separate them by detail, and no aggregate could.

Two supporting axes, same sweep:

* **Chroma.** This is the one axis that reaches significance. Spurious tracks
  mean C* at the low tiers (r = +0.44, +0.41, +0.53 at codes 0–2, all three
  past the 0.355 threshold, though only code 2's survives Holm across the five
  tiers) and about half as strongly above them (+0.19, +0.26, neither
  significant). Saturated content drives invented structure hardest where the
  chroma budget is tightest — 6 coefficients at code 0, 15 at code 1 — and the
  sign is the same all the way up the ladder.
* **Lightness.** Spurious leans lowest on high-key photographs at every tier
  (r = −0.04 to −0.36), which is the DC-dominated case: little AC amplitude to
  get wrong. Only code 2's −0.36 reaches the threshold, and it does not survive
  Holm.

And the fidelity side, for contrast: ΔE00's correlation with detail rises with
tier, +0.31 at code 0 to **+0.61** at code 4. It passes the 0.355 threshold from
code 2 up (+0.40, +0.51, +0.61) and survives Holm only at codes 3 and 4. There
the upper tiers help smooth photographs more than textured ones, so the format's
error becomes more content-dependent as the budget grows, not less. Below code 3
the sample cannot say firmly: code 2's +0.40 does not survive Holm (0.077).

### 13.4 What this says for v0.8, and what it does not

Stated as measurements, not as a plan. Nothing here adopts anything.

* **The upper tiers are the artifact problem, and codes 1–2 are the floor.** Any
  change aimed at invented structure should be evaluated at codes 3–4, where
  §13.2 puts the exchange rate at ~1:1, and not at the default tier where it is
  1:7. §12.2–§12.3 measured the synthesis window at codes 1 and 2 — the two
  tiers where there is least to gain.
* **The window's verdict was taken on the wrong tiers.** §12.3 found the
  lightest taper statistically free on ΔE00 at code 2 and failing SSIMULACRA2
  alone. §13.2 says code 2 sits on the *floor* invented structure never goes
  below — indistinguishable from code 1, and ~0.7 levels under codes 3–4 with a
  paired interval that excludes zero. A taper judged there is judged where there
  is least invented structure for it to remove. The interesting measurement —
  the same taper at codes 3 and 4 — has not been made. (§13.10 has since
  made it, under register entry D3.)
* **Possibly two defects, not one.** A change that suppresses low-order banding
  on smooth content and a change that stops the basis fighting real texture
  would be different changes, and a single corpus mean would report their sum.
  But §13.3 does not show that both exist: at n = 31 no tier's correlation with
  detail differs from zero. Telling them apart needs a larger or stratified
  corpus, not this one.
* **U19 is still the ceiling, and this round raises it again.** §12.5 said so of
  two metrics; there are now three, and §13.2's central claim — that a 1:1
  invention-to-deficit ratio is *worse* than a 1:7 one — is a claim about human
  judgement that nothing in this repo has ever validated. (1:1 and 1:7 are
  §13.1's 0.92 at code 4 and 0.14 at code 1 — the same two figures the first
  bullet quotes, and the only ratios either table supports.) Nor are the two
  ratios at the same fidelity: code 4's ΔE00 is 6.729 and code 1's 11.481, so the
  comparison is between two different amounts of error split two different ways,
  not between two splits of one amount. It is stated as an exchange rate rather
  than a verdict for both reasons.

### 13.5 The statistics behind every table, re-read (2026-09)

Until this section a sweep carried one interval, the paired bootstrap of ΔE00,
and everything else was a point mean. That left three gaps under every table
above. Each is now closed in the tooling (`stats.ts`, `arms-core.ts`), and each is
read back here over every committed result. No number measured by a sweep moves:
this section changes what the numbers are allowed to mean.

**Guards were decided on point means.** A guard passed or failed on which side
of its tolerance an arm's mean SSIMULACRA2, Butteraugli or DSSIM fell, on 16 or
31 images. Every sweep now also reads each guard off the paired 95% interval of
arm − incumbent, in three states:

* `ok`: the interval lies inside the tolerance, so a regression beyond it is
  ruled out.
* `FAIL`: the interval lies entirely beyond the tolerance, so a regression is
  shown.
* `inconclusive`: the interval straddles the tolerance.

Only `ok` passes. A guard exists to keep a regression out, so the burden of proof
is on the arm. The six tables with a guard column (§4.5, §7.5, §7.12, §11.3,
§12.2 and §12.3) now show both verdicts: `guards (means)` is the one each
decision was taken on, and `guards (CI)` sits beside it.

**Nothing corrected for the size of a table.** A 33-arm sweep runs 32 tests
against one incumbent, so the arm that looks best in a wide table is more likely
than any other to be the one luck favoured. Every metric's p-value is now
adjusted across the arms of its sweep with Holm's step-down procedure, which
controls the familywise error at 0.05 whatever the dependence between the tests
(they share an incumbent, so they are dependent). The p-value is a bootstrap
test that inverts the same construction as the interval, at 10,000 resamples
rather than 1,000, because at 1,000 the smallest reportable p (2/1,001) times 32
already exceeds 0.05. (The intervals were drawn at 1,000 until 2026-10 and are
now drawn at 10,000 too; see the end of this section.) The seven tables that quote a paired ΔE00 interval (§11.1,
§11.4 twice, §11.5, §11.10, §12.2 and §12.3) now carry the Holm p beside it. The
family is always the whole committed sweep, never only the rows a table quotes:
a table showing five arms of 29 was still chosen from 29.

**§13.2's intervals had no command.** They now come from `mise run arms`, and the
table at the head of §13.2 is bound.

`mise run arms --summary` counts what this changes for each committed sweep
against its incumbent:

| sweep | arms | ΔE00 p < 0.05 | after Holm | guards (CI) ok | inconclusive | FAIL | ok on means, not on CI | FAIL on means, not shown on CI |
|---|---|---|---|---|---|---|---|---|
| all committed sweeps | 1080 | 814 | 759 | 712 | 190 | 178 | 97 | 93 |
| `selection-weights` | 28 | 13 | 2 | 2 | 26 | 0 | 12 | 14 |
| `alpha-layout` | 33 | 22 | 10 | 20 | 4 | 9 | 0 | 4 |
| `refine-ablation` | 16 | 9 | 4 | 7 | 9 | 0 | 3 | 6 |
| `graphics-layout` | 28 | 1 | 0 | 16 | 12 | 0 | 7 | 5 |
| `prefix-shrink` | 32 | 22 | 18 | 12 | 12 | 8 | 6 | 6 |
| `synthesis-window` | 7 | 6 | 5 | 1 | 1 | 5 | 0 | 1 |
| `holdout-candidates-holdout` | 13 | 13 | 13 | 8 | 0 | 5 | 0 | 0 |
| `final-candidates-holdout` | 16 | 16 | 16 | 13 | 1 | 2 | 0 | 1 |

(The first row sums every committed result, so it grew from 504 arms to 839
when the 2026-09 re-measure committed the §6 sweeps no table had bound, and
to 864 when the register's confirmations committed their three holdout2
sweeps (§13.7), and to 880 and then 883 when D1 committed its tune sweep and
its holdout3 read (§13.8), and to 898 when D2 committed its tune ladder
and then 916 when it committed the two `embedded-tiers-identity` results of
part 1 (§13.9), and to 932 and then 936 when D3 committed its tune sweep
and its holdout3 read (§13.10), and to 983 and then 995 when D5 committed
its tune sweep and its holdout3 read (§13.11), and to 1018 and then 1021 when D6
committed its tune sweep and its holdout3 read (§13.12), and to 1049 when D8
committed its two tune sweeps, every arm at code 0 against the shipped code-0
layout (§13.13), and to 1068 when D9 committed its tune sweep (§13.14), and
to 1080 when the v0.8 verdict committed its combination sweep (§13.15). The
row compares every arm with its sweep's
first row whatever the arm's tier, so it includes comparisons at
different byte counts that no decision judged: 276 of the 1080 arms, 13 of them
D1's (the 11 code-3 and code-4 rows of `entropy-coded-ac` against its code-2
row, and the 2 code-4 rows of its holdout3 read against its code-3 row),
30 D2's (every row but `t0 interleaved full` of `embedded-tiers-ladder` and
of each `embedded-tiers-identity` result, against its code-0 row), 20
D3's (every code-3 and code-4 row of `synthesis-window-codes34` and of its
holdout3 read against its code-2 row, which D3 reads on spurious detail
alone) and 48 D5's (every code-1 to code-4 row of `downsample-before-dct`
and of its holdout3 read against its code-0 incumbent; D5 reads each arm
against its own tier's), 14 D6's (every code-4 row of `alpha-tiers34`
and of its holdout3 read against its code-3 shipped row), 19 D9's (every
row of `cfl-oracle` but `t0 shipped`, against it: the code-1 to code-4
rows are other tiers, and every free arm carries its gain field on top of
its tier's bytes; D9 reads each code's per-image best against that code's
own shipped arm), 12 of the v0.8 verdict's (every row of `v08-combination`
but `t2 shipped`, against it: the combination check reads each cell against
its own best single), the
rest from the tier ladders and mixed-tier tables of earlier sweeps. The
prose below counts the 839 of the re-measure. The
eight rows below it did not move then: those sweeps re-ran per-image identical.
#102 then turned the one EXIF-rotated tune photograph upright and re-ran every
tune result that scores it, which moved the first row and the
`selection-weights` and `prefix-shrink` rows; the other six are as they were.
Raising the interval resample count to 10,000, below, moved the same three
rows again, in the guard columns only: no ΔE00 count can move with it, because
the p-values were already drawn at 10,000.)

What it says:

1. **Both adoptions stand on the stricter reading.** Every arm §4.5 and §7.12
   adopted (`L28@4 C15@3 + stack`, `L28C15 stack` and `+ REFINE`) is `ok` on
   intervals: its guards are shown to hold, not just not shown to fail. The
   holdout rule's ΔE00 half is untouched by Holm there. Those arms clear zero by
   margins no adjustment over 13 or 16 arms reaches.
2. **Holm removes differences where tables are widest and effects smallest.**
   §11.5 keeps one of its two good-direction findings, and only just:
   `aniso 0.9 / hv 0` adjusts to 0.043 and `aniso 1.2 / hv 0` to 0.211. The
   other arm that survives is `aniso 3.2 / hv 0`, and it is worse than the
   default. So §11.5's first finding ("`sel_hv` is worth less than nothing")
   survives the correction its own caveat asked for at a single arm, by a margin
   that one photograph (#102: 0.085 before the rotated image was turned upright)
   and the bootstrap seed (below) each decide, and its third holds only at
   `aniso 3.2`. §11.4's single significant layout (`L30@4 C13@3`) adjusts to
   0.56. §11.1's shipped alpha layout is beaten by ten layouts after Holm rather
   than "a dozen", and `L22@4 C14@3`, the §8.1 arithmetic, is not one of the ten.
   Against §11.10's leader, `L16@4 C8@3`, the one layout said to have separated
   from the plateau, adjusts to 0.68. After Holm, only the shipped shape and the
   precision-maximal layout are distinguishable from the leader. §12.2's claim
   that the CI excludes zero "from `w_min 0.85` onward" holds from `w_min 0.7`
   onward.
3. **The SSIMULACRA2 guard is finer than these corpora resolve.** Its tolerance
   is 1.0 point, and a near-null arm's paired SSIMULACRA2 interval is several
   points either side of zero. §11.5's isotropic arm, for example, is
   [−4.01, +6.73] (`mise run arms selection-weights`). Such an arm cannot be
   `ok` however good it is, which is why 26 of `selection-weights`' 28 arms are
   `inconclusive`. The other two, `aniso 1.2 / hv 0` and `aniso 0.9 / hv 0`,
   are `ok`; the second became `ok` when the intervals moved to 10,000
   resamples. That is not a verdict on those arms. It
   says the tolerance and the sample size were never matched. A pre-registered
   criterion for v0.8 has to settle one of them before it is used.
4. **The two verdicts part in both directions.** The arms that passed on means
   and are not `ok` on intervals include §11.3's `A 12 @ 4` and `alpha scale 3 b`
   and §12.3's `chroma only`. The arms that failed on means without the interval
   showing a regression include §7.5's `aspect 8 → 4 b` and `b_scale_from_a`
   rows, and §12.2's `w_min 0.85`. §7.5's "U9 is dead" still stands, but on
   `b_scale_from_a`'s ΔE00 cost, which survives Holm (0.0088,
   `mise run arms prefix-shrink`). It does not stand on its guards.

**The fixed seed, and what it decides.** Every interval here is drawn from a
linear congruential generator seeded at 42, and the seed restarts on every call.
So every arm of a sweep, all scored over one image list, is resampled with the
*same* indices. The intervals in one table are therefore not independent Monte
Carlo draws: their resampling errors move together rather than averaging out.
That is deliberate, because it makes every quoted interval reproducible to the
digit. Its cost is measured with `mise run arms --seed-sensitivity`, which
re-derives every committed ΔE00 interval against its incumbent under 20 other
seeds. Over the 54 results of the 2026-09 re-measure that is 839 intervals
(it was 504 over the 36 results this section was first written against).

With the intervals drawn at 1,000 resamples, as they were when this section was
written (`mise run arms --seed-sensitivity --resamples 1000` over those 54
results reproduces every figure below; until #130 added `--resamples` that
reading had no command, §13.16):

* The largest move of either bound is 0.295 ΔE00, and the largest move relative
  to its own interval's width is 15.5%. (These are two separate maxima; this
  list used to print them as one interval's.)
* 26 arms' intervals change whether they exclude zero under some seed.
* 10 arms change their Holm verdict.

(23 and 14 before #102 re-scored the tune results with the one EXIF-rotated
photograph upright; the two maxima did not move.)

Among the rows this file quoted, §12.2's `w_min 0.85` [−0.077, −0.003] was one
of the 26, and §11.1's `L22@4 C14@3` and §11.5's `aniso 0.9 / hv 0` were two of
the 10. An interval whose bound sits within about a tenth of its width of zero
is decided by the seed as much as by the data. The remedy is more resamples, not
another seed (#88).

**The intervals are drawn at 10,000 resamples (2026-10).** That is the count the
p-values already used, and `stats.ts` now has one constant,
`BOOTSTRAP_RESAMPLES`, behind both, so an interval and the p-value of the same
test are drawn over the same resamples. It had to land before any entry of
[`V0.8-DECISIONS.md`](V0.8-DECISIONS.md) freezes, because a freeze pins the
instrument. No per-image score moved: every committed result already carries
the per-image values, so every interval was re-derived from them, and every
table in this file was re-transcribed by `mise run verify:experiments --fix`.
`mise run arms --resample-change` re-derives the same 839 intervals at seed 42
at 1,000 and at 10,000 and counts what moved:

* The largest move of either bound is 0.099 ΔE00.
* 7 intervals change whether they exclude zero: four of `refine-ablation`'s
  (`32B obj2 p2` now excludes zero; `32B obj0 p2 +dc`, `+scale` and
  `+dc+scale` no longer do), `refine-objective`'s `obj3 wc=3 p4 +dc+scale`
  (no longer), `prefix-shrink`'s `spend4b b_from_a (-5) L29C15` and
  `embedded-tiers`' `t1 seq, trunc 48 B` (both now do). At 10,000 each has a
  bound within 0.01 of zero. No table in this file quotes an interval for any
  of the seven, but §7.1's quotes two of them as point means
  (`refine_obj=0`, 2 passes + dc + scale, and `refine_obj=2`, 2 passes), and
  now says what their intervals are.
* 0 Holm verdicts change, by construction: the p-values were drawn at 10,000
  before and after.
* At 1,000, 7 arms' intervals disagreed with their own raw p on whether the
  difference is significant at 0.05. At 10,000, none of the 839 does.
* 6 arms' `guards (CI)` verdicts change, which moved the table at the head of
  this section from 507 / 169 / 163 (`ok` / `inconclusive` / `FAIL`) to
  512 / 165 / 162. Five go `inconclusive` → `ok`: `compact-tier`'s
  `L26@3 C6@3`, `compact-tier-graphics`' `L19@4 C6@3` and `L20@3 C9@3`,
  `prefix-shrink`'s `spend4b b_from_a +mu8 (-5) L29C15`, and §11.5's
  `aniso 0.9 / hv 0`. One goes `FAIL` → `inconclusive`: `alpha-ceiling`'s
  `A64@2 L8@4 C5@3`.

Two intervals this file quotes against a reference other than the incumbent
also crossed zero, and their sections now say so: §11.10's `L16@4 C8@3`
against the leader, [−0.184, −0.000] → [−0.184, +0.007], so it no longer
separates from the plateau; and §13.2's spurious-detail code 0 − code 2,
[−0.009, +1.015] → [+0.005, +1.023], which still does not survive Holm.

The seed check, re-run at 10,000:

* The largest move of either bound is 0.077 ΔE00, and the largest move relative
  to its own interval's width is 4.8%.
* 7 arms' intervals change whether they exclude zero under some seed, down from
  26.
* 10 arms change their Holm verdict, as before. Raising the interval count
  could not move these, because the p-values were already drawn at 10,000:
  a Holm-adjusted p within its Monte Carlo error of 0.05 still turns on the
  seed. That is the case R1's seed condition in `V0.8-DECISIONS.md` exists for.

§12.2's `w_min 0.85` is no longer among the interval flips. §11.1's
`L22@4 C14@3` and §11.5's `aniso 0.9 / hv 0` are still two of the 10 Holm flips.

**Correlations.** `stratify` now prints a Fisher-z interval for each `r`, the
t-test p, a Holm p across the five tiers, and the threshold for its n: at
n = 31, |r| must reach **0.355** to differ from zero at 0.05. None of §13.3's
detail-axis coefficients for spurious detail reaches it at any tier. The largest,
−0.30 at code 0, has an interval of [−0.59, +0.06]. §13.3's reading that the
correlation "does not survive the ladder" therefore has no survival to lose: at
this n no tier's coefficient is distinguishable from zero. The chroma axis
reaches the threshold at codes 0–2, but only code 2's +0.53 survives Holm. ΔE00's
correlation with detail reaches it at codes 2, 3 and 4 (+0.40, +0.51, +0.61),
and survives Holm at codes 3 and 4. Reproduce with the §6 `stratify` lines.

### 13.6 What each split can detect (2026-10)

[`V0.8-DECISIONS.md`](V0.8-DECISIONS.md) fixes its thresholds before any
holdout is read. R1 asks for a ΔE00 improvement of at least 3.0% that is also
significant after Holm, and R2 for the upper bound of the paired 95% interval to
sit within +1.0% of the incumbent's mean. Nothing related either number to the
number of images that has to resolve it. This section does, from the spread of
the paired differences the committed tune sweeps already carry. It re-scores
nothing and reads no sealed image: the holdout2 sizes are the pin tables'
counts, 14 alpha images and the 32 photographs #103 pinned. `mise run mde`
prints it, and
`verify:experiments` binds both tables below.

**Method.** Every arm of every committed photographic and alpha tune sweep is
taken against its own incumbent, if it spends the incumbent's bytes on every
image: the register compares arms at one tier. Arms at another budget are left
out, and so are arms bit-identical to their incumbent. For each comparison,
σ_rel is the standard deviation of the per-image difference (n − 1
denominator) over the incumbent's mean. The smallest relative effect a split of
n images detects at two-sided α = 0.05 with power 0.8 is then

  MDE = (z₁₋α/(2m) + z₀.₈) · σ_rel / √n

where m is the Holm family. m = 1 is a single holdout arm. m = 2 is the
register's default two-arm cap, at Holm's first step α/2, which the better
arm's p must clear. The confirmations froze larger families (C1 m = 8, C2
m = 4), and the same formula scales the m = 1 rows to them (§13.7). At m = 1 the same expression is also the smallest R2 margin that a
truly equal arm meets with probability 0.8: R2 reads the one-sided 97.5% bound
and is not Holm-adjusted.

The spread of a difference grows with the difference. An arm 20% worse than its
incumbent is worse by more on some images than on others. So each split has two
rows. `all arms` is every comparison. `within 3%` keeps the comparisons whose
mean effect is within 3% of the incumbent, which are the arms a 1% or 3%
threshold actually has to resolve. "R2's 1% met" is the share of comparisons
whose MDE at m = 1 is at most 1%. "R1's 3% resolved" is the share whose MDE at
m = 2 is at most 3%.

| split | n | arms | MDE, m = 1 | IQR, m = 1 | MDE, m = 2 | IQR, m = 2 | R2's 1% met | R1's 3% resolved |
|---|---|---|---|---|---|---|---|---|
| photo tune, all arms | 31 | 242 | 0.98% | [0.42%, 1.47%] | 1.08% | [0.46%, 1.61%] | 50% | 93% |
| photo tune, within 3% | 31 | 218 | 0.91% | [0.39%, 1.28%] | 1.00% | [0.43%, 1.41%] | 56% | 97% |
| photo holdout2, all arms | 32 | 242 | 0.97% | [0.41%, 1.44%] | 1.07% | [0.45%, 1.59%] | 52% | 94% |
| photo holdout2, within 3% | 32 | 218 | 0.89% | [0.38%, 1.26%] | 0.98% | [0.42%, 1.39%] | 57% | 98% |
| alpha tune, all arms | 16 | 189 | 6.41% | [2.44%, 7.65%] | 7.06% | [2.68%, 8.42%] | 9% | 26% |
| alpha tune, within 3% | 16 | 58 | 1.45% | [0.94%, 1.97%] | 1.59% | [1.03%, 2.17%] | 29% | 83% |
| alpha holdout2, all arms | 14 | 189 | 6.86% | [2.61%, 8.18%] | 7.54% | [2.87%, 9.00%] | 8% | 25% |
| alpha holdout2, within 3% | 14 | 58 | 1.55% | [1.00%, 2.11%] | 1.70% | [1.10%, 2.32%] | 26% | 81% |

The two thresholds in ΔE00, at the median incumbent of the same sweeps:

| corpus | incumbents | median incumbent ΔE00 | R2's 1.0% in ΔE00 | R1's 3.0% in ΔE00 |
|---|---|---|---|---|
| photo | 31 | 11.481 | 0.115 | 0.344 |
| alpha | 10 | 15.689 | 0.157 | 0.471 |

What the tables give, at α = 0.05 and power 0.8:

1. **Photographic splits, within 3%.** The median MDE is 0.91% at n = 31 and
   0.89% at n = 32 for m = 1, and 1.00% and 0.98% for m = 2. A 3% effect is
   at or above the m = 2 MDE for 97% and 98% of these comparisons, and a 1%
   effect at or above the m = 1 MDE for 56% and 57%. At the median incumbent,
   1% is 0.115 ΔE00 and 3% is 0.344.
2. **Alpha holdout2, within 3%.** At n = 14 the median MDE is 1.55% for m = 1
   and 1.70% for m = 2, about 1.7 times the photographic n = 32 figure. A 3%
   effect is at or above the m = 2 MDE for 81% of the comparisons, and a 1%
   effect at or above the m = 1 MDE for 26%.
3. **All arms against within 3%.** The all-arms rows are wider: on alpha
   holdout2 the median is 6.86% against 1.55%, about four times, because the
   alpha sweeps hold many layouts far from their incumbent.

Caveats on reading them against the register:

- The MDE is computed at m = 1 and m = 2 only. An entry whose Holm family is
  larger has a larger MDE, through z₁₋α/(2m). C1 (m = 8) and C2 (m = 4),
  whose freezes judge eight and four named comparisons, are two.
- Power 0.8 at the MDE is the chance the Holm-adjusted test is significant. It
  is not the chance R1 passes, because R1 also requires the point estimate to
  be at least 3.0%, which an arm whose true effect is exactly 3.0% reaches
  about half the time.

**Assumptions.** The MDE is a normal approximation. Under the Student-t
approximation on n − 1 df, which `mise run mde` prints beside it, the medians
rise by about 4–5% at n = 31 and 32, and by about 8–11% at n = 14. The register does not
decide on this formula. It decides on the percentile bootstrap, now at 10,000
resamples (§13.5). That interval's standard error is the plug-in
SD·√((n − 1)/n)/√n, narrower than the normal-theory one, so at n = 14 the
bootstrap interval is somewhat anti-conservative, and the t figure is the
closer guide. `mise run selftest:metrics` checks that width on a known sample
of 14: the bootstrap interval comes out within 3% of the plug-in width, and
narrower than the normal and the t intervals. The images are treated as independent draws. Arms of one sweep
share images and an incumbent, so the comparisons above are not independent
samples of σ, and the median and IQR describe the committed record rather than
a population. The tune split's spread is assumed to carry over to the holdout.
The photographic holdout2 list was drawn by axis quota (#103: nine
smartphone, six skin-tone and four chroma-floor images among the 32), and the
alpha one two per covariate cell (#107), so their spread may differ, and
nothing may read them to check before an entry freezes. The power is 0.8 and α is 0.05;
`mise run mde --power 0.9` or `--alpha` restate the tables at other values.

### 13.7 The confirmations, out of sample (2026-10)

`V0.8-DECISIONS.md` registers two confirmations: C1 for the photographic
constants and C2 for the alpha constants. They exist because the old holdout
was spent (§11.12). `sel_hv = 0.15` had been selected on it, and the alpha
evidence died with the retired alpha split. Both entries froze at `2047f7d`,
with every judged comparison and its baseline named before the read. Each read
its sealed split once, from a clean tree, at B = 10,000. The four results are
committed as `*-holdout2.json`, and `mise run register-verdict C1|C2`
re-derives every row below from them.

**C1: the photographic constants, on the 32 images of `holdout2` (Holm across
all eight comparisons).**

| comparison (arm vs baseline, equal bytes) | ΔE00 | 95% CI of Δ | relative | p Holm | guards (CI) |
|---|---|---|---|---|---|
| code 1: `sel_hv=0.30` vs shipped | +0.003 | [−0.055, +0.055] | +0.02% | 1.0000 | inconclusive |
| code 1: isotropic vs shipped | +0.047 | [−0.027, +0.125] | +0.41% | 0.8271 | inconclusive |
| code 1: pre-adoption v0.6-derived vs shipped | +0.258 | [+0.139, +0.389] | +2.22% | 0.0016 | FAIL |
| code 1: `sel_hv=0 aniso=1.2` vs shipped | −0.013 | [−0.057, +0.034] | −0.11% | 1.0000 | inconclusive |
| code 0: `L18@4 C7@3` vs shipped `L19@4 C6@3` | +0.008 | [−0.068, +0.075] | +0.07% | 1.0000 | FAIL |
| code 0: `L20@4 C5@3` vs shipped | +0.096 | [+0.025, +0.188] | +0.77% | 0.0190 | ok |
| code 0: `L26@3 C6@3` vs shipped | −0.186 | [−0.282, −0.088] | −1.50% | 0.0016 | ok |
| code 0: the old shipped shape vs shipped | +0.412 | [+0.272, +0.557] | +3.31% | 0.0016 | FAIL |

The shipped incumbents score 11.617 at code 1 and 12.468 at code 0. No
comparison clears R1's first condition, a 3% improvement, so **the shipped
constants stand under R1 at both codes**. The intervals, not the MDE, bound
what this rules out. Every judged comparison's 95% interval lies above −3% of
its baseline (the closest, `L26@3 C6@3`, reaches −0.282 against a 3% line at
−0.374), so the data exclude an improvement of 3% or more. The 1.14% MDE the
freeze quoted is a pre-data statement of power and excludes nothing by
itself. Medians, reported beside the means (register Q9), tell the same
story: 11.809 for the code-1 incumbent against 11.751–12.040 for its
alternatives, and 12.662 for the code-0 incumbent against 12.655–13.296. Three
readings go beyond the verdict:

1. **`sel_hv = 0.15` now has out-of-sample evidence.** Neither 0.30 nor 0 is
   distinguishable from it: +0.02% and −0.11%, both intervals straddling zero
   and lying within about ±0.5% of the incumbent's 11.617. `hv = 0` cleared
   zero on tune (§11.5) and does not here.
2. **The adoption replicates in direction, not in size.** The pre-adoption
   v0.6-derived row is 2.22% worse than the shipped constants, significant
   after Holm, and fails its guards. Equivalently, the shipped constants are
   2.18% better, against the −3.72% §7.12 and §8 measured on the old holdout.
   §8's gain holds on photographs nothing had tuned on, at about three-fifths
   of its old size.
3. **One compact layout is better, below the bar.** `L26@3 C6@3` is 1.50%
   better than the shipped `L19@4 C6@3`. That is significant after Holm, every
   guard is `ok` on intervals, and no seed moves it. §11.10 called the compact
   tier a plateau, tie-broken across corpora, and this split leans the other
   way. It is under R1's 3%, so it changes nothing on its own, and a code-0
   retune entry would start from it.

**The compact tier's admission holds, on point means, as the criterion is
written.** In `rd-budget` on the same split, the shipped compact row's mean
beats ThumbHash's on all four metrics. Three of the four differences exclude
zero on the paired interval. DSSIM's does not: 0.2802 against 0.2819, with a
paired Δ of [−0.0043, +0.0006]. On DSSIM the two are indistinguishable.

| | bytes | ΔE00 ↓ | SSIM2 ↑ | Butter ↓ | DSSIM ↓ |
|---|---|---|---|---|---|
| ThumbHash | 20.8 | 13.350 | −411.2 | 34.46 | 0.2819 |
| **ChromaHash compact** | **21** | **12.468** | **−398.4** | **32.83** | **0.2802** |

**The smartphone stratum, reported and not judged (register Q12).** The
smartphone-camera images are harder: the incumbent's mean ΔE00 is 13.178 on
the nine `sealed-phone-*` images against 11.006 on the other 23. On the phone
images both `sel_hv` alternatives sit marginally ahead of 0.15 (`sel_hv=0`
−0.03%, `sel_hv=0.30` −0.11%) and isotropic is +0.96%. Over all 32, 0.30 is
behind. At
code 0, `L26@3 C6@3` is −0.71% there and −1.86% on the rest. Nine images resolve
none of these; the stratum is a description, not a test.

**C2: the alpha constants, on the 14 images of alpha holdout v2 (Holm across
all four comparisons).**

| comparison (replacement vs the row it replaced) | ΔE00 | 95% CI of Δ | relative | p Holm | guards (CI) |
|---|---|---|---|---|---|
| code 1: `A28@3 L22@4 C3@3` vs `A5@4 L20@5 C9@4` | −2.110 | [−3.326, −1.280] | −13.66% | ≤ 0.0008 | ok |
| code 0: `A16@3 L12@4 C1@3` vs the old compact shape | −1.592 | [−2.822, −0.758] | −10.19% | ≤ 0.0008 | ok |
| `alpha_ac_fit` on vs off, code 1 | +0.040 | [−0.124, +0.183] | +0.30% | 0.5927 | inconclusive |

The fourth comparison reads `alpha-tier1` rather than `v07-holdout-alpha`:

| comparison (replacement vs the row it replaced) | ΔE00 | 95% CI of Δ | relative | p Holm | guards (CI) |
|---|---|---|---|---|---|
| code 2: the shipped base row vs `A5@4 L20@5 C9@4` | −1.132 | [−1.852, −0.550] | −8.99% | ≤ 0.0008 | ok |

**All three replacements replicate under R1**, and `alpha_ac_fit = false`
stands. The code-1 row's −13.66% sits near its tune figure (−17.10%, §11.3) and
the retired split's unreproducible −16.2%. The code-2 base row's −8.99% sits
near its tune −11.95% (§11.11). This is the out-of-sample evidence the alpha
allocation lost in #83. Two cautions apply at n = 14:
- "≤ 0.0008" is the bootstrap's resolution floor, 2/(B+1) after Holm, not an
  exact p.
- The percentile bootstrap is anti-conservative at this size: code 1's upper
  bound is −1.280 by bootstrap against −0.883 by paired t.

The verdicts do not depend on either: 14 of 14 and 13 of 14 images improve.
None of §11.11's equal-budget alternatives beats the shipped code-2 row here
(the best, `A16@4 L14@4 C9@4`, is −0.58%), and the off-budget `C2@4` arm is
−2.54% at Holm p 0.39.

**Condition 4.** `mise run register-verdict C1|C2 --seeds 20` re-derives each
judged comparison under 20 other bootstrap seeds. Each is taken against its
named baseline, with the entry-family Holm and every guard interval re-drawn.
No R1 outcome turns in either entry.

**Deviations from the frozen procedure, recorded rather than hidden.**
1. **Guards against a named baseline.** The freeze said conditions 1–3 "come
   from `mise run arms`", whose guard table covers row 0 only. Applying the
   same `guardVerdictOnIntervals` rule to a named baseline was written down
   after the reads, in `register-verdict`. It is the same rule at the same
   tolerances. C2's compact comparison passes partly on it.
2. **The first condition-4 check used the wrong family.** As first recorded,
   condition 4 came from `arms --seed-sensitivity`, which compares every arm
   with row 0 across the whole sweep. That is not the frozen baselines or
   family, and it re-draws no guard. The check above replaces it. No outcome
   changes.
3. **C2's code-2 comparison was narrowed at the freeze.** C2's Arms field
   names the code-2 base row against §11.11's equal-budget arms. The freeze
   judged the shipped row against the row it replaced, as for the other
   replacements, and reports the equal-budget arms (above). The narrowing was
   made before the read.

Neither post-read deviation decides an outcome. Deviation 1 applies the
pre-registered guard rule, at its recorded tolerances, to the baseline the
freeze named, and the comparison that "passes partly on it", C2's compact
row, has every guard interval wholly on the improving side of zero against
that baseline: SSIMULACRA2 +26.92 [+10.28, +49.54], Butteraugli −8.806
[−15.314, −3.574] and DSSIM −0.0078 [−0.0129, −0.0027]
(`mise run arms v07-holdout-alpha-holdout2 --baseline "compact 21B shipped
shape"`). Deviation 2 changed which check was run, and no outcome turns under
either.

Both entries are therefore `decided`. They confirm the v0.7 constants out of
sample, and are the baseline the register's open format entries are
measured against: D1–D6, and D8 and D9, which the register's 2026-11-22
approval added. None of those reads `holdout2`: each reads `holdout3` once,
overall and per stratum (`V0.8-DECISIONS.md`, "The stratum rule").

### 13.8 D1: entropy-coded AC at codes 2–4 (2026-11)

§7.13 priced an entropy coder at codes 1 and 2 with a coder written in
TypeScript, against the best fixed-field layout rather than the shipped one,
and nothing had measured codes 3 and 4, where `RATIONALE.md` expects the
trade to pay most. Register entry D1 asks the question in the format itself.
`Tunables::ac_coder` (#132) codes every AC code as one adaptive binary
arithmetic-coded stream with no table, in a hash of exactly the shipped
length; the arm's layout bounds how many codes the stream may carry, and the
encoder zeroes the highest-index codes until it fits. `ac_coder = 2` is the
adaptive form: a payload bit says, per image, whether the coded stream or the
shipped fixed fields follow, as the encoder's own decision.
`V0.8-DECISIONS.md` D1 records the coder, the validity design that keeps
"a hash that validates is guaranteed to decode" (a total code, so
`from_bytes` is unchanged), and the selection rule, all committed before the
first result.

The coder's whole case is the bits it frees. A high-index AC code is usually
the centre code, which the coder sends in a small fraction of a bit, so the
shipped codes take less than the fixed fields' payload, and the more so the
higher the tier. Those bits are spent on more coefficients at the shipped
widths: an `×M` arm bounds `M` times the shipped counts, so a `×2` bound at
code 2 carries up to 208 L and 72 C codes where the fixed fields carry 104
and 36, and the fit search zeroes the tail of whatever does not fit.

**Tune (`mise run sweep entropy-coded-ac`).** 63 images: the 31
photographic, 16 alpha and 16 graphics tune images, composited over white,
black and grey, with the generated fixtures left out (`realOnly`). Every
hash is its tier's shipped length, checked image by image. Each arm is read
against its own tier's shipped arm, at equal bytes; `relative` is the
difference of means over that arm's mean, and the interval and guards are
paired (`mise run arms entropy-coded-ac --baseline "t3 shipped"`, and so on).

| arm | ΔE00 | relative | 95% CI of Δ | guards (CI) |
|---|---|---|---|---|
| t2 shipped | 9.858 | — | — | — |
| t2 coded x1.25 | 9.663 | −1.99% | [−0.240, −0.153] | ok |
| t2 coded x1.5 | 9.556 | −3.06% | [−0.384, −0.226] | ok |
| t2 coded x2 | 9.490 | −3.74% | [−0.502, −0.257] | ok |
| t2 adaptive x1.5 | 9.557 | −3.06% | [−0.382, −0.227] | ok |
| t2 adaptive x2 | 9.488 | −3.76% | [−0.504, −0.260] | ok |
| t3 shipped | 8.322 | — | — | — |
| t3 coded x1.5 | 7.971 | −4.22% | [−0.453, −0.265] | ok |
| t3 coded x2 | 7.802 | −6.25% | [−0.685, −0.385] | ok |
| t3 coded x2.5 | 7.721 | −7.22% | [−0.784, −0.449] | ok |
| t3 coded x3 | 7.691 | −7.58% | [−0.816, −0.475] | ok |
| t3 adaptive x2.5 | 7.721 | −7.22% | [−0.784, −0.449] | ok |
| t4 shipped | 7.246 | — | — | — |
| t4 coded x2 | 6.932 | −4.34% | [−0.425, −0.218] | ok |
| t4 coded x3 | 6.847 | −5.51% | [−0.544, −0.277] | ok |
| t4 coded x4 | 6.815 | −5.95% | [−0.593, −0.296] | ok |
| t4 adaptive x3 | 6.847 | −5.51% | [−0.544, −0.277] | ok |

By corpus, the same relative differences over each part of tune:

| arm | photographic (31) | alpha (16) | graphics (16) |
|---|---|---|---|
| t2 coded x1.25 | −2.07% | −2.23% | −1.54% |
| t2 coded x1.5 | −3.11% | −3.51% | −2.46% |
| t2 coded x2 | −4.21% | −4.09% | −2.37% |
| t2 adaptive x1.5 | −3.20% | −3.35% | −2.41% |
| t2 adaptive x2 | −4.31% | −3.94% | −2.42% |
| t3 coded x1.5 | −4.41% | −3.32% | −4.94% |
| t3 coded x2 | −6.57% | −5.16% | −6.97% |
| t3 coded x2.5 | −7.05% | −7.03% | −7.78% |
| t3 coded x3 | −7.24% | −7.67% | −8.12% |
| t3 adaptive x2.5 | −7.05% | −7.03% | −7.78% |
| t4 coded x2 | −4.20% | −4.52% | −4.37% |
| t4 coded x3 | −4.86% | −6.91% | −4.96% |
| t4 coded x4 | −5.02% | −7.78% | −5.39% |
| t4 adaptive x3 | −4.86% | −6.91% | −4.96% |

And by `holdout3` stratum, for the arm each tier's selection rule picks
(below), with the strata derived from each tune image's own covariates the
way the holdout3 pins' were (`mise run stratify entropy-coded-ac --strata`).
On tune the strata are reported and gate nothing; the cell is the relative
difference and the stratum rule's verdict.

| stratum (tune images) | t2 adaptive x2 | t3 coded x3 | t4 coded x4 |
|---|---|---|---|
| smartphone (4) | −1.91%, ok | −6.06%, ok | −3.43%, inconclusive |
| graphics (16) | −2.42%, ok | −8.12%, ok | −5.39%, ok |
| alpha (17) | −4.28%, ok | −7.63%, ok | −7.57%, ok |
| skin (12) | −3.23%, ok | −6.46%, ok | −5.19%, ok |
| low-light (10) | −5.77%, ok | −11.01%, ok | −6.60%, ok |
| extreme aspect (1) | −8.86%, ok | −15.90%, ok | −1.01%, ok |

What the tune result says:

1. **Every coded arm beats its tier's shipped arm, with every guard `ok` on
   intervals, at every tier.** The gain grows with the bound and flattens:
   at code 3 from −4.22% (×1.5) to −7.58% (×3), at code 4 from −4.34% (×2)
   to −5.95% (×4), and at code 2 from −1.99% (×1.25) to −3.74% (×2). No
   stratum fails the stratum rule's tests for any selected arm.
2. **Code 4 flattens earlier than code 3, and part of that is the
   harness.** An isotropic ball of K luma coefficients on a 3:2 image reaches
   a horizontal index of about √(6K/π): about 98 for the ×3 bound's 4,992
   and 113 for the ×4 bound's 6,656. Every sweep here is scored through the
   ≤ 100 px encoder input and its capped decode, where an index of 100 or
   more is clamped to zero at encode and dropped at decode, so part of the
   ×4 bound is spent on coefficients this harness cannot show. The code-4
   figures say what the coder buys on what the harness can see. They are
   not an estimate for a full-resolution encode rendered at 256 px, which
   nothing here measures.
3. **The adaptive arms change almost nothing.** At codes 3 and 4 the encoder
   never chose the fixed fields, so each adaptive arm is its coded twin to
   the last digit. At code 2 it chose them on a few images, and moved the
   mean by 0.02 percentage points at most. Where the coded stream gains
   least, on graphics at code 2 (−2.37% against −4.21% on photographs for
   `×2`), the per-image choice does not rescue it.
4. **The graphics corpus gains least at code 2 and most at code 3**
   (−2.37% for `t2 coded x2`, −8.12% for `t3 coded x3`). Nothing here
   measures why.

**Selection (the rule D1 recorded before this run).** Per tier, the coded or
adaptive arm with the lowest tune ΔE00 whose `guards (CI)` against the
tier's shipped arm is not `FAIL`: `t2 adaptive x2` (−3.76%), `t3 coded x3`
(−7.58%) and `t4 coded x4` (−5.95%). All three clear Q13's 3%, so none is
decided in sample. The register's cap of two holdout arms per entry then
freezes the two with the largest relative tune gain, codes 3 and 4, and
code 2 is decided not adopted for want of a holdout read: a −3.76% tune
estimate is the one most at risk of shrinking below 3% out of sample, and
reopening it takes a new entry. Q8's power statement for the frozen pair on
`holdout3`'s 88 images (48 photographic, 24 alpha, 16 graphics), at Holm
family m = 2, from each comparison's tune spread (σ_rel 8.44% and 8.27%):
an MDE of 2.77% at code 3 and 2.72% at code 4, so R1's 3% is resolved.

**The holdout3 read.** D1 froze at `e3b2eb6`, and read `holdout3` once from a
clean tree at that commit: `mise run sweep entropy-coded-ac-frozen --split
holdout3 --decision D1`, over all 88 pins (48 photographic, 24 alpha, 16
graphics), with exactly the four frozen rows. The result is committed as
`entropy-coded-ac-frozen-holdout3.json`, and `mise run register-verdict D1`
re-derives every row below from it.

| comparison (arm vs its tier's shipped arm, equal bytes) | ΔE00 | 95% CI of Δ | relative | p Holm | guards (CI) |
|---|---|---|---|---|---|
| code 3: `t3 coded x3` vs `t3 shipped` | −0.429 | [−0.491, −0.369] | −6.04% | ≤ 0.0004 | ok |
| code 4: `t4 coded x4` vs `t4 shipped` | −0.179 | [−0.231, −0.131] | −2.80% | ≤ 0.0004 | ok |

Per stratum, the relative difference over each stratum's pins (a pin may sit
in several):

| comparison | smartphone (17) | graphics (16) | alpha (24) | skin (17) | low-light (12) | extreme aspect (16) |
|---|---|---|---|---|---|---|
| code 3: `t3 coded x3` vs `t3 shipped` | −6.16% | −5.28% | −6.92% | −5.80% | −5.34% | −6.55% |
| code 4: `t4 coded x4` vs `t4 shipped` | −2.06% | −2.65% | −3.43% | −3.56% | −1.34% | −2.28% |

The shipped incumbents score 7.090 at code 3 and 6.397 at code 4. Under R1
and the stratum rule (`mise run register-verdict D1`):

1. **Code 3 passes.** `t3 coded x3` is 6.04% better than the shipped code-3
   layout, at a Holm p at the resampling floor, with every guard `ok` on its
   paired interval. Its interval, −0.491 to −0.369, lies wholly beyond the
   3% line at −0.213, so the data exclude a gain under 3%. No stratum fails
   the stratum rule: every one improves, and the one whose guards are
   `inconclusive` (low-light, 12 pins) has a ΔE00 interval wholly on the
   improving side. Under 20 other bootstrap seeds no outcome turns. The tune
   estimate was −7.58%, so it shrank by about a fifth out of sample, and the
   median moves with the mean (6.257 against 6.706).
2. **Code 4 fails R1's first condition.** `t4 coded x4` is 2.80% better,
   significant after Holm with every guard `ok`, but below the 3% bar; its
   interval, −0.231 to −0.131, spans about −3.6% to −2.0% of the incumbent,
   so the data do not exclude a 3% gain either. The tune estimate was
   −5.95%, and it halved. The medians are level (6.088 against 6.092), so
   the mean's gain is not a shift of the typical image. §13.8's tune finding 2 is the
   likely part of the reason, and nothing here separates it from shrinkage:
   this harness scores code 4 through a ≤ 100 px input, where a ×4 bound
   spends bits on coefficients it cannot show.
3. **Code 2 was decided without a read** (the two-arm cap, above), and this
   read shows no code-2 result.

Two readings go beyond the verdict. The coder's gain does not depend on the
content in the way an adaptive or conditional rule would need to exploit: at
code 3 every stratum improves by 5.3–6.9%, graphics and alpha included, and
the adaptive arms on tune never preferred the fixed fields there. And the
code-4 result is a statement about this harness as much as the format: a
D-entry that measures code 4 at its own raster would have to change the
encoder input the harness has always used, which no register entry has done.

### 13.9 D2: embedded tiers (2026-11)

§7.11 found the first 32 B of an interleaved code-2 hash about 4% worse in
ΔE00 than a native code-1 encode, on the photographic tune split only, with
the code-1 incumbent and no measured margin. Register entry D2 asks whether
a prefix one code down is a placeholder the format can define: the AC codes
merged by frequency priority (`Tunables::interleave`, which since #133 also
merges alpha's AC codes as a fourth channel), and a code-`(k+1)` hash read
from only its first `L(k)` bytes (`Tunables::cut_tier = k`, rendered at code
`k`'s natural size). `V0.8-DECISIONS.md` D2 records the order, the prefix
design (a header left as written, `from_bytes` unchanged, an explicit O(1)
prefix mode), how its primary metric is read, and its selection rule, all
committed before this result.

**Tune (`mise run sweep embedded-tiers-ladder`).** The same 63 images as
§13.8: 31 photographic, 16 alpha and 16 graphics tune images, over white,
black and grey, with the generated fixtures left out. Every hash is its
tier's shipped length, checked image by image; the Bytes of a cut are the
whole hash's. Part 1 holds on every image: each of the five interleaved
full-length arms decoded to its native arm's pixels, byte for byte, on all
63 images (`identicalTo`, recorded in the result's `settings.identity`), and
`rust/tests/spec_vectors.rs` asserts the same on every encode vector at codes
0–4. The ladder leaves out the generated fixtures and tune2, so
`embedded-tiers-identity` (native codes 0–4 and the same five `identicalTo`
arms, no cut, no `realOnly`) checks them too: every interleaved arm matched
on all 106 tune images, the 43 generated fixtures included, and on all 39
tune2 images. Its two results judge nothing. Each cut is read against native code `k`; `relative` is the difference
of means over native `k`'s mean, and the interval and guards are paired.

| arm | ΔE00 | relative | 95% CI of Δ | guards (CI) |
|---|---|---|---|---|
| t0 native | 12.286 | — | — | — |
| t1 native | 11.608 | — | — | — |
| t2 native | 9.858 | — | — | — |
| t3 native | 8.322 | — | — | — |
| t4 native | 7.246 | — | — | — |
| t2 interleaved cut 1 | 12.117 | +4.38% | [+0.378, +0.645] | FAIL |
| t3 interleaved cut 2 | 10.139 | +2.84% | [+0.166, +0.392] | FAIL |
| t4 interleaved cut 3 | 8.620 | +3.58% | [+0.122, +0.540] | FAIL |
| t2 seq cut 1 | 13.834 | +19.17% | [+1.425, +3.085] | FAIL |
| t3 seq cut 2 | 12.789 | +29.73% | [+1.969, +3.959] | FAIL |
| t4 seq cut 3 | 11.884 | +42.80% | [+2.544, +4.641] | FAIL |

The margin of each cut, the same run's step from native `k−1` to native `k`,
read the same way (native `k−1` against native `k`):

| step | ΔE00 | relative | SSIM2 | Butteraugli |
|---|---|---|---|---|
| k = 1: t0 native vs t1 native | +0.678 | +5.84% | −28.7 | +3.01 |
| k = 2: t1 native vs t2 native | +1.750 | +17.75% | −113.9 | +7.14 |
| k = 3: t2 native vs t3 native | +1.536 | +18.46% | −111.3 | +4.16 |

And the guards the interleaved cuts fail, against native `k`:

| arm | SSIM2 | SSIM2 95% CI | Butteraugli | Butteraugli 95% CI |
|---|---|---|---|---|
| t2 interleaved cut 1 | −33.1 | [−41.667, −24.980] | +3.54 | [+2.760, +4.333] |
| t3 interleaved cut 2 | −39.7 | [−49.899, −30.191] | +2.19 | [+1.644, +2.806] |
| t4 interleaved cut 3 | −34.0 | [−60.124, −17.080] | +1.70 | [+1.251, +2.219] |

By corpus, each cut's relative difference over each part of tune:

| arm | photographic (31) | alpha (16) | graphics (16) |
|---|---|---|---|
| t2 interleaved cut 1 | +4.16% | +4.70% | +4.47% |
| t3 interleaved cut 2 | +2.97% | +2.78% | +2.67% |
| t4 interleaved cut 3 | +6.26% | −1.89% | +5.22% |
| t2 seq cut 1 | +9.59% | +48.51% | +3.09% |
| t3 seq cut 2 | +16.05% | +72.84% | +6.74% |
| t4 seq cut 3 | +28.53% | +88.35% | +13.69% |

Per `holdout3` stratum, from each tune image's own covariates
(`mise run stratify embedded-tiers-ladder --embedded`), the interleaved cuts'
relative difference and the stratum rule's verdict with D2's margin; on tune
the strata gate nothing:

| stratum (tune images) | t2 interleaved cut 1 | t3 interleaved cut 2 | t4 interleaved cut 3 |
|---|---|---|---|
| smartphone (4) | +3.64%, FAIL | +3.72%, FAIL | +4.12%, FAIL |
| graphics (16) | +4.47%, FAIL | +2.67%, FAIL | +5.22%, FAIL |
| alpha (17) | +4.43%, FAIL | +2.37%, FAIL | −1.72%, inconclusive |
| skin (12) | +2.86%, FAIL | +1.20%, FAIL | +2.61%, FAIL |
| low-light (10) | +2.61%, FAIL | +1.59%, FAIL | +11.53%, FAIL |
| extreme aspect (1) | +11.13%, FAIL | +5.78%, FAIL | +12.96%, FAIL |

Every stratum `FAIL` above is a guard `FAIL`. Only one also fails the ΔE00
test: cut 1 on the one extreme-aspect image, +11.13% against that image's
own step of +6.04%.

What the tune result says:

1. **On ΔE00 every interleaved cut is well inside one tier step.** Cut 1
   costs +4.38% against a +5.84% step, with an upper bound of +0.645 against
   a gap of +0.678; cuts 2 and 3 cost +2.84% and +3.58% against steps of
   +17.75% and +18.46%. Condition 1 alone would hold at all three, by a
   wide margin at the upper two.
2. **Every interleaved cut fails condition 2, decisively.** Against native
   code `k` its SSIMULACRA2 falls by 33 to 40 points, with every interval
   wholly below the 1.0-point tolerance, and its Butteraugli rises by 7.5–10.4%,
   every interval wholly above the 2% tolerance. DSSIM stays within it. At
   cut 1 the guard cost exceeds the whole tier step it is allowed in ΔE00
   (SSIM2 −33.1 against the step's −28.7, Butteraugli +3.54 against +3.01);
   at cuts 2 and 3 it is about a third of a step on SSIMULACRA2.
3. **Why the interleaved prefix trades luma for colour.** The merge weights
   every channel equally by frequency, while each native layout spends most
   of its bits on luma. Native code 1 is L28@4 C15@3: 28 luma and 15 of
   each chroma coefficient. Code 2's widths are L@5 and C@4, so until its
   36 chroma codes run out every priority costs 5 + 4 + 4 = 13 bits, and
   the 202 payload bits of an opaque 32 B cut hold about 15 coefficients of each
   channel: half native code 1's luma, at a finer step, and as much chroma.
   ΔE00, a colour difference, rewards that; SSIMULACRA2 and Butteraugli,
   which weight structure, do not. This is the layouts' arithmetic, not a
   measurement of the order's per-channel counts, and no arm here tests a
   luma-weighted merge.
4. **Interleaving is what makes a prefix usable at all.** The
   channel-sequential cuts cost +19–43% in ΔE00, past every tier step, and
   on alpha images +49–88%, because the sequential order writes alpha's AC
   codes last and a cut drops them. The interleaved cut keeps alpha's lowest
   frequencies, and the alpha corpus then fares like the others.

**Selection (the rule D2 recorded before this run).** No cut qualifies: each
interleaved cut's mean Δ is below its tier gap, but its tune
`guards (CI)` against native `k` is `FAIL`, and a holdout cannot rescue a
candidate that fails where it was chosen. So nothing is frozen, `holdout3`
is not read for D2 and stays unread by it, and D2 is decided in sample.
Under 20 bootstrap seeds other than 42 the selection does not change, and
`mise run arms --seed-sensitivity embedded-tiers-ladder` turns no interval
and no Holm verdict.

**The verdict: D2 does not pass.** Embedded tiers are not adopted. Part 1
holds (the interleaved order is a pure permutation that decodes to the
shipped pixels on every `tune` and `tune2` image and every encode vector
at codes 0–4; the 8 graphics `holdout` pins were read by neither run and
are not covered),
but it carries no benefit on its own, and every prefix fails R2's guards
against the native code it stands for. Two readings go beyond the verdict.
The prefix fails on guards a native lower tier also fails against the
tier above it (the step tables above), so with R2's tolerances any prefix
whose cost is real fails, whatever its ΔE00; a criterion that allows a
tier step in ΔE00 and none in the guards is what Q1 chose, and this entry
is the case it bites. And a merge weighted toward luma, as the native
layouts are, is the untested design point 3 names; it would be a new
register entry, with its own criteria, and could not reuse this tune run.

### 13.10 D3: the synthesis window at codes 3–4 (2026-11)

§12.2–§12.3 measured the decode-side synthesis window (`window_weights`, a
Hann taper of the AC codes by normalized priority) at codes 1 and 2 only,
and §13.4 recorded that this was the wrong place: §13.2 puts the floor of
invented structure at codes 1–2 and the step up at codes 3–4. Register entry
D3 asks whether the window brings codes 3 and 4 back to that floor at no
ΔE00 cost. It is a decode change: the shipped encoder runs no pixel-domain
refinement (`refine_passes = 0`, the one encoder path that reads the
window), so every arm of a tier encodes the same bytes, and adopting an arm
would move every decode vector and no hash. `V0.8-DECISIONS.md` D3 records
the sweep, how the primary metric is read and the selection rule, all
committed before this result.

**Tune (`mise run sweep synthesis-window-codes34`).** The same 63 images as
§13.8 and §13.9: 31 photographic, 16 alpha and 16 graphics tune images, over
white, black and grey, with the generated fixtures left out. Every hash is
its tier's shipped length, checked image by image, and the spectral grid is
pinned to 32 px, so spurious detail is comparable down the column. The
primary first: each arm's spurious detail against shipped code 2, paired,
which is a comparison across byte counts (`mise run arms
synthesis-window-codes34 --baseline "t2 shipped (no window)"`).

| arm | Spur | Spur Δ vs code 2 | 95% CI |
|---|---|---|---|
| t2 shipped (no window) | 4.55 | — | — |
| t3 shipped (no window) | 5.28 | +0.723 | [+0.452, +1.004] |
| t3 w_min 0.95 exp 1 | 4.99 | +0.435 | [+0.170, +0.707] |
| t3 w_min 0.9 exp 1 | 4.71 | +0.162 | [−0.095, +0.427] |
| t3 w_min 0.85 exp 1 | 4.46 | −0.092 | [−0.344, +0.167] |
| t3 w_min 0.7 exp 1 | 3.81 | −0.742 | [−0.999, −0.484] |
| t3 w_min 0.5 exp 2 | 2.71 | −1.844 | [−2.165, −1.528] |
| t3 luma only 0.7 exp 1 | 3.87 | −0.678 | [−0.950, −0.409] |
| t3 chroma only 0.7 exp 1 | 5.25 | +0.699 | [+0.441, +0.975] |
| t4 shipped (no window) | 5.10 | +0.551 | [+0.212, +0.879] |
| t4 w_min 0.95 exp 1 | 4.91 | +0.363 | [+0.029, +0.685] |
| t4 w_min 0.9 exp 1 | 4.74 | +0.189 | [−0.141, +0.507] |
| t4 w_min 0.85 exp 1 | 4.58 | +0.024 | [−0.302, +0.339] |
| t4 w_min 0.7 exp 1 | 4.16 | −0.389 | [−0.713, −0.077] |
| t4 w_min 0.5 exp 2 | 3.33 | −1.222 | [−1.532, −0.924] |
| t4 luma only 0.7 exp 1 | 4.28 | −0.267 | [−0.601, +0.058] |
| t4 chroma only 0.7 exp 1 | 5.02 | +0.464 | [+0.142, +0.778] |

Then every window arm against its own tier's shipped arm, at equal bytes;
`relative` is the difference of means over the shipped arm's mean, and the
intervals and guards are paired (`--baseline "t3 shipped (no window)"`, and
the same for code 4). The guard that decides is SSIMULACRA2: Butteraugli and
DSSIM fall with every taper up to `w_min 0.7`, and move by little at
`w_min 0.5 exp 2` and in the chroma-only arm, so they hold.

| arm | ΔE00 | relative | 95% CI of Δ | SSIM2 | SSIM2 95% CI | guards (CI) |
|---|---|---|---|---|---|---|
| t2 shipped (no window) | 9.858 | — | — | — | — | — |
| t3 shipped (no window) | 8.322 | — | — | — | — | — |
| t3 w_min 0.95 exp 1 | 8.317 | −0.07% | [−0.013, +0.004] | −0.3 | [−0.788, +0.012] | ok |
| t3 w_min 0.9 exp 1 | 8.316 | −0.07% | [−0.020, +0.013] | −0.8 | [−1.759, −0.068] | inconclusive |
| t3 w_min 0.85 exp 1 | 8.321 | −0.01% | [−0.023, +0.027] | −1.4 | [−2.944, −0.256] | inconclusive |
| t3 w_min 0.7 exp 1 | 8.377 | +0.66% | [+0.011, +0.112] | −4.3 | [−8.020, −1.502] | FAIL |
| t3 w_min 0.5 exp 2 | 8.750 | +5.14% | [+0.326, +0.550] | −16.5 | [−26.173, −9.047] | FAIL |
| t3 luma only 0.7 exp 1 | 8.394 | +0.87% | [+0.030, +0.128] | −3.9 | [−7.577, −1.267] | FAIL |
| t3 chroma only 0.7 exp 1 | 8.306 | −0.19% | [−0.033, +0.000] | −0.3 | [−0.692, −0.076] | ok |
| t4 shipped (no window) | 7.246 | — | — | — | — | — |
| t4 w_min 0.95 exp 1 | 7.229 | −0.24% | [−0.025, −0.008] | +0.0 | [−0.100, +0.139] | ok |
| t4 w_min 0.9 exp 1 | 7.217 | −0.40% | [−0.045, −0.010] | +0.0 | [−0.253, +0.242] | ok |
| t4 w_min 0.85 exp 1 | 7.210 | −0.49% | [−0.061, −0.006] | −0.1 | [−0.475, +0.309] | ok |
| t4 w_min 0.7 exp 1 | 7.229 | −0.24% | [−0.071, +0.049] | −0.6 | [−1.647, +0.232] | inconclusive |
| t4 w_min 0.5 exp 2 | 7.489 | +3.35% | [+0.112, +0.411] | −4.1 | [−7.408, −1.480] | FAIL |
| t4 luma only 0.7 exp 1 | 7.276 | +0.41% | [−0.018, +0.090] | −0.5 | [−1.466, +0.283] | inconclusive |
| t4 chroma only 0.7 exp 1 | 7.202 | −0.61% | [−0.065, −0.024] | −0.1 | [−0.222, −0.031] | ok |

By corpus, each window arm's relative ΔE00 difference over each part of tune:

| arm | photographic (31) | alpha (16) | graphics (16) |
|---|---|---|---|
| t3 w_min 0.95 exp 1 | −0.15% | +0.13% | −0.15% |
| t3 w_min 0.9 exp 1 | −0.22% | +0.30% | −0.23% |
| t3 w_min 0.85 exp 1 | −0.22% | +0.51% | −0.25% |
| t3 w_min 0.7 exp 1 | +0.39% | +1.39% | +0.27% |
| t3 w_min 0.5 exp 2 | +5.25% | +5.65% | +4.28% |
| t3 luma only 0.7 exp 1 | +0.61% | +1.13% | +1.03% |
| t3 chroma only 0.7 exp 1 | −0.21% | +0.26% | −0.71% |
| t4 w_min 0.95 exp 1 | −0.42% | +0.07% | −0.30% |
| t4 w_min 0.9 exp 1 | −0.74% | +0.19% | −0.52% |
| t4 w_min 0.85 exp 1 | −0.97% | +0.35% | −0.66% |
| t4 w_min 0.7 exp 1 | −1.00% | +1.07% | −0.47% |
| t4 w_min 0.5 exp 2 | +2.57% | +4.29% | +3.64% |
| t4 luma only 0.7 exp 1 | −0.20% | +0.80% | +1.06% |
| t4 chroma only 0.7 exp 1 | −0.75% | +0.27% | −1.45% |

Per `holdout3` stratum, from each tune image's own covariates
(`mise run stratify synthesis-window-codes34 --window`), for the arm each
code's selection rule picks (below): the relative ΔE00 difference against
the tier's shipped arm and the stratum rule's verdict, then the stratum's
spurious detail against shipped code 2. On tune the strata gate nothing.

| stratum (tune images) | t3 w_min 0.85 exp 1 | t4 w_min 0.7 exp 1 |
|---|---|---|
| smartphone (4) | −0.73%, ok; Spur +0.093 | −1.88%, ok; Spur −0.417 |
| graphics (16) | −0.25%, inconclusive; Spur +0.004 | −0.47%, inconclusive; Spur −0.689 |
| alpha (17) | +0.41%, inconclusive; Spur −0.120 | +0.90%, inconclusive; Spur −0.181 |
| skin (12) | −0.49%, inconclusive; Spur −0.550 | −1.74%, inconclusive; Spur −0.680 |
| low-light (10) | +0.53%, inconclusive; Spur −0.352 | +0.72%, inconclusive; Spur −1.027 |
| extreme aspect (1) | +1.61%, FAIL; Spur −2.069 | +3.05%, FAIL; Spur −2.442 |

The one extreme-aspect tune image fails both arms on ΔE00 alone: an
interval of one image is its point, and it lies above +1.0%.

What the tune result says:

1. **§13.2's step reproduces on the mixed corpus.** Shipped code 3 invents
   +0.723 [+0.452, +1.004] more than shipped code 2, and code 4 +0.551
   [+0.212, +0.879], against §13.2's +0.735 and +0.742 on the 31
   photographs alone.
2. **The window removes the step, monotonically in its strength.** Spurious
   detail at code 3 falls from 5.28 to 2.71, and the lightest
   both-channel taper whose point estimate reaches the code-2 floor is
   `w_min 0.85` at code 3 and `w_min 0.7` at code 4. The interval's upper
   bound reaches it only for `w_min 0.7`, `luma only 0.7` and
   `w_min 0.5 exp 2` at code 3, and for `w_min 0.7` and `w_min 0.5 exp 2`
   at code 4.
3. **At the upper tiers a light taper costs no ΔE00, and at code 4 it
   gains.** Every arm up to `w_min 0.85` at code 3, and up to `w_min 0.7` at
   code 4, sits within ±0.5% of its shipped arm, and at code 4 the three
   lightest arms are better, each interval excluding zero. That is the
   opposite of §12.2's code 1, where every taper cost ΔE00 from the first.
4. **SSIMULACRA2 is what limits it, as at code 2, but less.** Its drop grows
   with the taper. At code 3 every arm whose upper bound reaches the floor
   fails it; at code 4 `w_min 0.7` reaches the floor with SSIMULACRA2
   `inconclusive`, and so meets the primary and condition 1 on tune
   intervals already. Both selected arms sit where the SSIMULACRA2
   interval straddles the 1.0-point tolerance (`inconclusive`), which a
   holdout of 88 images may or may not resolve. Butteraugli and DSSIM
   improve with both selected arms.
5. **The chroma-only taper does nothing to spurious detail** (5.25 against
   5.28 at code 3), as §12.2 found at code 1: the invented structure is luma
   at codes 3–4 too.
6. **Alpha images pay where the others gain.** Every taper costs ΔE00 on
   the alpha corpus (+0.51% and +1.07% for the selected arms), while the
   selected arms gain on photographs and graphics. The window applies the luma taper to
   alpha's AC codes as well, and nothing here separates that from the
   colour channels.

**Selection (the rule D3 recorded before this run).** At each code, the
window arm with the lowest tune spurious detail among those whose mean
spurious is at most code 2's, whose mean ΔE00 is within +1.0% of the
shipped arm, and whose `guards (CI)` is not `FAIL`: `t3 w_min 0.85 exp 1`
(mean spurious −0.092 against code 2, ΔE00 −0.01%, guards
`inconclusive`) and `t4 w_min 0.7 exp 1` (−0.389, −0.24%, `inconclusive`).
Both codes have a qualifying arm, so neither is decided in sample, and one
arm per code keeps the register's two-arm cap. Under 20 bootstrap seeds
other than 42 the selection does not change, and `mise run arms
--seed-sensitivity synthesis-window-codes34` turns no interval and no Holm
verdict. Q8's power statement for `holdout3`'s 88 images, from each arm's
tune spread: a ΔE00 MDE of 0.36% at code 3 and 1.00% at code 4, so δ =
1.0% is resolved, and a spurious MDE of 0.31 and 0.38 levels against tune
estimates of −0.09 and −0.39, so at code 3 the read had little power to
pass the primary.

**The holdout3 read.** D3 froze at `40bf6f2`, and read `holdout3` once from
a clean tree at that commit: `mise run sweep synthesis-window-codes34-frozen
--split holdout3 --decision D3`, over all 88 pins (48 photographic, 24
alpha, 16 graphics), with exactly the five frozen rows. The result is
committed as `synthesis-window-codes34-frozen-holdout3.json`, and `mise run
register-verdict D3` re-derives every row below from it. Spurious detail is
read against shipped code 2 (4.59 here), everything else against the
tier's shipped arm.

| frozen arm | Spur Δ vs code 2 | Spur 95% CI | ΔE00 | 95% CI of Δ | relative | SSIM2 | SSIM2 95% CI | guards (CI) |
|---|---|---|---|---|---|---|---|---|
| code 3: `t3 w_min 0.85 exp 1` | −0.287 | [−0.513, −0.074] | −0.014 | [−0.028, +0.001] | −0.20% | −0.2 | [−0.491, +0.067] | ok |
| code 4: `t4 w_min 0.7 exp 1` | −0.452 | [−0.717, −0.203] | −0.069 | [−0.096, −0.041] | −1.07% | +0.2 | [−0.162, +0.632] | ok |

Per stratum, the relative ΔE00 difference against the tier's shipped arm
over each stratum's pins (a pin may sit in several):

| frozen arm | smartphone (17) | graphics (16) | alpha (24) | skin (17) | low-light (12) | extreme aspect (16) |
|---|---|---|---|---|---|---|
| code 3: `t3 w_min 0.85 exp 1` | −0.54% | −0.55% | +0.69% | −0.53% | −1.14% | +0.23% |
| code 4: `t4 w_min 0.7 exp 1` | −1.65% | −1.40% | +0.49% | −1.85% | −2.96% | +0.41% |

The shipped arms score 7.090 at code 3 and 6.397 at code 4, and invent
+0.412 [+0.170, +0.644] and +0.299 [+0.007, +0.579] more than code 2 here:
§13.2's step holds out of sample, smaller than on tune. Under R2 with the
artifact primary and the stratum rule (`mise run register-verdict D3`):

1. **Code 3 passes.** `t3 w_min 0.85 exp 1` invents less than shipped code
   2, with the interval's upper bound at −0.074; its ΔE00 is 0.20% better
   than the shipped code-3 decode, with an upper bound of +0.02% against
   the +1.0% margin; every guard is `ok` on its paired interval,
   SSIMULACRA2 included (−0.2, [−0.491, +0.067] against the 1.0-point
   tolerance). No stratum fails the stratum rule. Two are `inconclusive`
   on guards (alpha and skin); the alpha stratum is the only one whose
   ΔE00 interval excludes zero on the losing side, +0.69% with a lower
   bound of +0.35%, inside the +1.0% the rule allows.
2. **Code 4 passes.** `t4 w_min 0.7 exp 1` invents less than code 2 with
   an upper bound of −0.203, is 1.07% better than the shipped code-4
   decode in ΔE00 with its whole interval below zero, and is `ok` on every
   guard. No stratum fails; graphics and extreme aspect are
   `inconclusive` on guards, and alpha's ΔE00 interval reaches −0.03% at
   its lower bound.
3. **Condition 4 holds.** Under 20 bootstrap seeds other than 42 no
   outcome turns, overall or in any stratum.

Two readings go beyond the verdict. The SSIMULACRA2 cost that decided
§12.3 at code 2, and that left both arms `inconclusive` on tune, is not
there on `holdout3` (−0.2 and +0.2 points), so the tension §12.3 states
is a property of the lower tiers, not of the window. And the alpha
stratum is the one that pays at both codes, as alpha did on tune: the
window tapers alpha's AC codes with the luma window, and an arm that left
alpha untapered is untested. Adopting the window at codes 3–4 is a decode
change in every language, which the v0.8 verdict lands or declines; it
moves every code-3 and code-4 decode vector and no hash. U19 still bounds
the claim: spurious detail and SSIMULACRA2 are both metrics no human has
validated at placeholder fidelity.

### 13.11 D5: downsampling before the transform (2026-11)

Every encode before this section ran the forward DCT over every pixel of
its input, and every sweep fed it the harness's ≤ 100 px raster, where the
cost of that sum never showed. Register entry D5 asks whether the encoder
should resample a large source to a fixed pixel budget first, so that
encode cost stops growing with the source, at a ΔE00 cost within R2's
+1.0% at every tier. It is a format change: every hash of a source over the
budget moves, and the resampling kernel would become normative.
`V0.8-DECISIONS.md` D5 ("The amendment") records the candidates, the
source sizes, the speed criterion, how the verdict is read and the
selection rule, all committed (`ba44767`) before this section's first
result or count.

The candidates are two placements of the exact area average
(`Tunables::downsample`) at four grid budgets of E² pixels at the source's
aspect (`downsample_edge` E = 64, 128, 256, 512): **linear** averages the
premultiplied linear-light RGB and the alpha off the source bytes and runs
the colour pass on the grid; **oklab** runs the shipped colour pass at full
resolution and averages the composited OKLAB planes. The incumbent at each
code is the shipped encoder at the source's native resolution, with the
byte-identical levers of `PERFORMANCE.md` §12.1 on.

**The speed primary (`mise run downsample-instructions`).** Retired
user-space instructions per encode at 1024×1024, code 1, on the bounded
matrix's gradient, incumbent over candidate, the geometric mean of 10
interleaved A B / B A blocks, recorded at `6d1c062` from a clean tree.
Both runs agree to the fourth decimal in every pair; the record is
`results/counts/downsample-instructions.json`. Cycles are recorded beside
it and judge nothing.

| candidate | vs shipped default | vs `ACCEL_ALL` | candidate's instructions per encode (with `ACCEL_ALL`) |
|---|---|---|---|
| linear 64 | 17.27× | 8.18× | 57.0 M |
| linear 128 | 14.06× | 7.30× | 63.9 M |
| linear 256 | 8.26× | 5.32× | 87.7 M |
| linear 512 | 3.18× | 2.65× | 175.9 M |
| oklab 64 | 5.29× | 1.93× | 241.5 M |
| oklab 128 | 5.00× | 1.89× | 247.1 M |
| oklab 256 | 4.12× | 1.78× | 261.6 M |
| oklab 512 | 2.44× | 1.45× | 322.0 M |

The shipped default retires 1,123.1 M instructions per encode here and
`ACCEL_ALL` 466.4 M. The oklab placement clears 2.0× against the shipped
default at every edge and against `ACCEL_ALL` at none: it keeps the
full-resolution colour pass, which is most of what `ACCEL_ALL` leaves (at
edges 64 and 128 it even retires more instructions with the levers on than
without them, 241.5 M and 247.1 M against 212.2 M and 224.6 M; this
section does not trace why). The linear placement moves the colour pass
onto the grid and clears 2.0× against both incumbents at every edge.

**Tune (`mise run sweep downsample-before-dct`).** The same 63 images as
§13.8–§13.10: 31 photographic, 16 alpha and 16 graphics tune images, over
white, black and grey, with the generated fixtures left out. Every arm
encodes the source file at its native resolution (600 px to 8,000 px on
the long edge) and is scored against the usual 512 px reference. Scored at
`6d1c062` from a clean tree. Every hash is its tier's shipped length,
checked image by image, and at codes 0–2 the lever-free shipped default
decodes to the incumbent's pixels on all 63 images. Each arm against its
own tier's full-resolution incumbent, paired (`mise run stratify
downsample-before-dct --downsample`):

| arm | ΔE00 | relative | 95% CI of Δ | guards (CI) |
|---|---|---|---|---|
| t0 full resolution | 12.301 | — | — | — |
| t0 downsample=linear downsample_edge=64 | 12.319 | +0.15% | [−0.111, +0.147] | inconclusive |
| t0 downsample=linear downsample_edge=128 | 12.275 | −0.21% | [−0.125, +0.071] | ok |
| t0 downsample=linear downsample_edge=256 | 12.275 | −0.21% | [−0.107, +0.050] | ok |
| t0 downsample=linear downsample_edge=512 | 12.260 | −0.33% | [−0.103, +0.017] | ok |
| t0 downsample=oklab downsample_edge=64 | 12.301 | −0.00% | [−0.001, +0.001] | ok |
| t0 downsample=oklab downsample_edge=128 | 12.301 | +0.00% | [+0.000, +0.000] | ok |
| t0 downsample=oklab downsample_edge=256 | 12.301 | +0.00% | [+0.000, +0.000] | ok |
| t0 downsample=oklab downsample_edge=512 | 12.301 | +0.00% | [+0.000, +0.000] | ok |
| t1 full resolution | 11.620 | — | — | — |
| t1 downsample=linear downsample_edge=64 | 11.639 | +0.17% | [−0.098, +0.142] | inconclusive |
| t1 downsample=linear downsample_edge=128 | 11.608 | −0.10% | [−0.106, +0.080] | ok |
| t1 downsample=linear downsample_edge=256 | 11.595 | −0.22% | [−0.101, +0.047] | ok |
| t1 downsample=linear downsample_edge=512 | 11.593 | −0.24% | [−0.086, +0.029] | ok |
| t1 downsample=oklab downsample_edge=64 | 11.621 | +0.01% | [−0.000, +0.002] | ok |
| t1 downsample=oklab downsample_edge=128 | 11.620 | −0.00% | [−0.001, +0.001] | ok |
| t1 downsample=oklab downsample_edge=256 | 11.620 | −0.00% | [−0.001, +0.000] | ok |
| t1 downsample=oklab downsample_edge=512 | 11.620 | +0.00% | [+0.000, +0.000] | ok |
| t2 full resolution | 9.859 | — | — | — |
| t2 downsample=linear downsample_edge=64 | 9.917 | +0.59% | [−0.049, +0.172] | inconclusive |
| t2 downsample=linear downsample_edge=128 | 9.869 | +0.10% | [−0.073, +0.094] | inconclusive |
| t2 downsample=linear downsample_edge=256 | 9.839 | −0.21% | [−0.085, +0.043] | inconclusive |
| t2 downsample=linear downsample_edge=512 | 9.830 | −0.29% | [−0.080, +0.022] | ok |
| t2 downsample=oklab downsample_edge=64 | 9.856 | −0.04% | [−0.008, +0.000] | ok |
| t2 downsample=oklab downsample_edge=128 | 9.860 | +0.00% | [−0.001, +0.002] | ok |
| t2 downsample=oklab downsample_edge=256 | 9.860 | +0.00% | [−0.001, +0.002] | ok |
| t2 downsample=oklab downsample_edge=512 | 9.860 | +0.01% | [−0.000, +0.002] | ok |
| t3 full resolution | 8.311 | — | — | — |
| t3 downsample=linear downsample_edge=64 | 8.417 | +1.28% | [+0.009, +0.215] | inconclusive |
| t3 downsample=linear downsample_edge=128 | 8.346 | +0.43% | [−0.037, +0.115] | inconclusive |
| t3 downsample=linear downsample_edge=256 | 8.309 | −0.01% | [−0.055, +0.057] | ok |
| t3 downsample=linear downsample_edge=512 | 8.295 | −0.18% | [−0.061, +0.032] | ok |
| t3 downsample=oklab downsample_edge=64 | 8.313 | +0.03% | [−0.005, +0.010] | inconclusive |
| t3 downsample=oklab downsample_edge=128 | 8.312 | +0.02% | [−0.002, +0.006] | ok |
| t3 downsample=oklab downsample_edge=256 | 8.311 | +0.00% | [−0.001, +0.002] | ok |
| t3 downsample=oklab downsample_edge=512 | 8.311 | +0.00% | [−0.000, +0.001] | ok |
| t4 full resolution | 7.214 | — | — | — |
| t4 downsample=linear downsample_edge=64 | 7.431 | +3.01% | [+0.100, +0.360] | FAIL |
| t4 downsample=linear downsample_edge=128 | 7.292 | +1.08% | [+0.003, +0.164] | inconclusive |
| t4 downsample=linear downsample_edge=256 | 7.235 | +0.30% | [−0.031, +0.081] | ok |
| t4 downsample=linear downsample_edge=512 | 7.210 | −0.05% | [−0.043, +0.038] | ok |
| t4 downsample=oklab downsample_edge=64 | 7.258 | +0.61% | [+0.028, +0.065] | inconclusive |
| t4 downsample=oklab downsample_edge=128 | 7.218 | +0.06% | [−0.000, +0.009] | ok |
| t4 downsample=oklab downsample_edge=256 | 7.215 | +0.02% | [−0.000, +0.003] | ok |
| t4 downsample=oklab downsample_edge=512 | 7.214 | −0.01% | [−0.001, +0.000] | ok |

By corpus, the relative ΔE00 difference of the arm each code's selection
picks (below) over each part of tune:

| arm | photographic (31) | alpha (16) | graphics (16) |
|---|---|---|---|
| t0 downsample=linear downsample_edge=128 | +0.21% | +0.22% | −1.65% |
| t1 downsample=linear downsample_edge=128 | +0.30% | +0.30% | −1.46% |
| t2 downsample=linear downsample_edge=128 | +0.36% | +0.47% | −0.86% |
| t3 downsample=linear downsample_edge=256 | +0.03% | +0.22% | −0.40% |
| t4 downsample=linear downsample_edge=512 | +0.01% | +0.01% | −0.26% |

Per `holdout3` stratum, from each tune image's own covariates, for the same
arms: the relative ΔE00 difference and the stratum rule's verdict. On tune
the strata gate nothing.

| stratum (tune images) | t0 linear 128 | t1 linear 128 | t2 linear 128 | t3 linear 256 | t4 linear 512 |
|---|---|---|---|---|---|
| smartphone (4) | +0.04%, inconclusive | −0.09%, inconclusive | −0.41%, inconclusive | −0.76%, inconclusive | −0.74%, ok |
| graphics (16) | −1.65%, inconclusive | −1.46%, inconclusive | −0.86%, inconclusive | −0.40%, inconclusive | −0.26%, inconclusive |
| alpha (17) | +0.22%, inconclusive | +0.27%, ok | +0.45%, inconclusive | +0.22%, inconclusive | +0.00%, ok |
| skin (12) | +0.30%, inconclusive | +0.40%, inconclusive | +0.53%, inconclusive | +0.33%, inconclusive | +0.58%, ok |
| low-light (10) | +2.00%, inconclusive | +2.21%, inconclusive | +2.44%, inconclusive | +2.21%, inconclusive | +1.51%, inconclusive |
| extreme aspect (1) | −3.76%, ok | −4.30%, FAIL | −2.22%, ok | +1.30%, FAIL | +0.84%, FAIL |

The one extreme-aspect tune image is a stratum of one, whose guard
intervals are its points: at codes 1, 3 and 4 a guard moves past its
tolerance on that image alone.

What the tune result says:

1. **The oklab placement is all but free, and the linear one is not.**
   Averaging the composited OKLAB planes moves ΔE00 by at most 0.06% at
   any tier from edge 128 up, every interval within 0.01 ΔE00 of zero, and
   even edge 64 stays within +0.61% at code 4. The linear placement's
   intervals are far wider at every edge (about ±0.9% of the incumbent at
   edge 128, code 1): averaging light and then converting is not
   converting and then averaging, and the difference depends on the image.
2. **The linear placement's cost falls with the edge and rises with the
   tier.** Its interval's upper bound passes +1.0% at edge 64 at every
   code, at edge 128 at codes 3–4, and at edge 256 at code 4, so it
   qualifies from edges 128, 128, 128, 256 and 512 at codes 0–4.
3. **It pays on graphics and costs in the dark.** Every selected linear arm
   is better on graphics and worse on the low-light stratum, with every
   low-light interval excluding zero on the losing side at codes 0–3;
   neither moves the stratum rule on tune.

**Selection (the rule D5 recorded before this run).** Per placement and
tier, the smallest edge whose tune ΔE00 upper bound is within +1.0% of the
incumbent with `guards (CI)` not `FAIL`: linear 128, 128, 128, 256 and 512
at codes 0–4, and oklab 64 at every code. Both placements qualify, and the
rule chooses on the `ACCEL_ALL` instruction ratio at the code-1 edge:
linear 128's 7.30× against oklab 64's 1.93×. Linear 128 clears 2.0×
against both incumbents, so D5 freezes the linear placement's five arms.
The oklab placement, the cheaper in ΔE00, is not chosen because it fails
the speed primary against `ACCEL_ALL` at every edge. Under 20 bootstrap
seeds other than 42 the selection does not change, and `mise run arms
--seed-sensitivity downsample-before-dct` turns no interval and no Holm
verdict. Q8's power statement for `holdout3`'s 88 images, from each frozen
arm's tune spread at power 0.8 and two-sided α = 0.05: σ_rel 3.22%, 3.26%,
3.41%, 2.72% and 2.31% at codes 0–4, an MDE of 0.96%, 0.97%, 1.02%, 0.81%
and 0.69%, so δ = 1.0% is about what the read resolves at codes 0–2.

**The holdout3 read.** D5 froze at `fd781e3`, and read `holdout3` once from
a clean tree at that commit: `mise run sweep downsample-before-dct-frozen
--split holdout3 --decision D5`, over all 88 pins (48 photographic, 24
alpha, 16 graphics) at their native resolution, with exactly the 13 frozen
rows. At codes 0–2 the lever-free shipped default decoded to the
incumbent's pixels on every pin. The result is committed as
`downsample-before-dct-frozen-holdout3.json`, and `mise run
register-verdict D5` re-derives every row below from it, each frozen arm
against its tier's full-resolution incumbent:

| frozen arm | ΔE00 | 95% CI of Δ | relative | guards (CI) |
|---|---|---|---|---|
| code 0: `t0 downsample=linear downsample_edge=128` | −0.018 | [−0.095, +0.046] | −0.16% | ok |
| code 1: `t1 downsample=linear downsample_edge=128` | −0.034 | [−0.111, +0.028] | −0.33% | ok |
| code 2: `t2 downsample=linear downsample_edge=128` | −0.013 | [−0.080, +0.044] | −0.16% | ok |
| code 3: `t3 downsample=linear downsample_edge=256` | −0.002 | [−0.046, +0.038] | −0.03% | ok |
| code 4: `t4 downsample=linear downsample_edge=512` | −0.010 | [−0.036, +0.016] | −0.15% | ok |

Per stratum, the relative ΔE00 difference over each stratum's pins (a pin
may sit in several):

| frozen arm | smartphone (17) | graphics (16) | alpha (24) | skin (17) | low-light (12) | extreme aspect (16) |
|---|---|---|---|---|---|---|
| code 0: `t0 downsample=linear downsample_edge=128` | +0.82% | −4.87% | −0.05% | +0.97% | +1.31% | −1.24% |
| code 1: `t1 downsample=linear downsample_edge=128` | +1.04% | −5.62% | −0.14% | +0.53% | +1.57% | −1.51% |
| code 2: `t2 downsample=linear downsample_edge=128` | +1.44% | −5.59% | −0.28% | +1.22% | +2.88% | −1.11% |
| code 3: `t3 downsample=linear downsample_edge=256` | +1.28% | −4.43% | −0.01% | +0.96% | +2.40% | −0.46% |
| code 4: `t4 downsample=linear downsample_edge=512` | +0.72% | −2.73% | −0.01% | +0.46% | +1.23% | +0.00% |

Under R2 with the speed primary and the stratum rule (`mise run
register-verdict D5`):

1. **Conditions 1–3 hold at every tier.** Every arm's ΔE00 interval has
   its upper bound under the +1.0% margin (+0.41%, +0.27%, +0.52%, +0.53%
   and +0.25% of the incumbent at codes 0–4), every guard is `ok` on its
   paired interval, and the speed at the code-1 edge is 14.06× against the
   shipped default and 7.30× against `ACCEL_ALL`.
2. **The stratum rule fails code 2.** On the 12 low-light pins the code-2
   arm costs +2.88%, and the lower bound of its interval is +1.50%, above
   the rule's +1.0%. Every other stratum at every tier is `ok` or
   `inconclusive`; low-light's lower bound is the next nearest at code 3
   (+0.91%).
3. **Condition 4 holds.** Under 20 bootstrap seeds other than 42 no
   outcome turns, overall or in any stratum.

**D5 fails**, because all five tiers must pass. What the read shows
beyond the verdict is that the overall means hide a trade between the
corpora. Per corpus the photographs pay at every tier (+0.91%, +0.89%,
+1.36%, +1.18% and +0.50% at codes 0–4, every interval excluding zero on
the losing side), the graphics gain 2.7% to 5.6%, and the alpha cut-outs
do not move; the photographs' cost concentrates where the tune result put
it, in low light, and in the smartphone and skin pins, which are
photographs too. That is a fixed setting that helps one stratum and hurts
another, which the adaptive/conditional rule judges as it stands. The
oklab placement, which the tune result found all but free, was not read:
the selection chose on speed, and against `ACCEL_ALL` it does not reach
2.0× at any edge. The shipped encoder is unchanged.

### 13.12 D6: the alpha allocation at codes 3–4 (2026-11)

Codes 2–4 share one alpha-mode base row, `A28@3 L22@4 C3@3`, scaled by
`4^(level)`: 28 alpha, 22 luma and 3 + 3 chroma AC coefficients per base,
×4 at code 2, ×16 at code 3 and ×64 at code 4. §11.11 chose it at code 2,
where it is within 0.06% of the best equal-budget row, and codes 3 and 4
inherited it unmeasured. Register entry D6 asks whether those two codes want
a different split. `V0.8-DECISIONS.md` D6 records the candidates, the
opacity strata and the selection rule, all committed before the first
result.

Every candidate is a 190-bit base row, the shipped row's budget: 190 is the
only base budget that gives the shipped alpha-mode length at both codes,
388 B at ×16 and 1528 B at ×64. The candidates are §11.11's four
equal-budget rows and seven more: a luma-heavier row, chroma bought from
luma, and five rows that spend the budget on alpha *precision* (4- and
5-bit alpha fields) rather than alpha count. §11.11's two 192-bit rows are
4 B and 16 B over at codes 3 and 4 and are left out.

**Tune (`mise run sweep alpha-tiers34`).** The 16 alpha tune images,
composited over white, black and grey. Every alpha-mode hash is its tier's
shipped length, checked image by image. Each row is read against its own
tier's shipped row, at equal bytes (`mise run stratify alpha-tiers34
--alpha-tiers`); `relative` is the difference of means over the shipped
row's mean, and the interval and guards are paired.

| row | ΔE00 | relative | 95% CI of Δ | guards (CI) | αMAE |
|---|---|---|---|---|---|
| t3 A28@3 L22@4 C3@3 (shipped) | 9.757 | — | — | — | 0.1096 |
| t3 A24@3 L22@4 C5@3 | 9.617 | −1.44% | [−0.259, −0.054] | ok | 0.1098 |
| t3 A32@3 L19@4 C3@3 | 9.808 | +0.52% | [+0.024, +0.078] | FAIL | 0.1094 |
| t3 A20@3 L28@4 C3@3 | 9.673 | −0.86% | [−0.146, −0.027] | ok | 0.1102 |
| t3 A40@3 L13@4 C3@3 | 9.968 | +2.16% | [+0.122, +0.307] | FAIL | 0.1092 |
| t3 A12@3 L34@4 C3@3 | 9.691 | −0.68% | [−0.171, +0.046] | ok | 0.1131 |
| t3 A28@3 L19@4 C5@3 | 9.669 | −0.90% | [−0.192, −0.017] | FAIL | 0.1096 |
| t3 A16@4 L27@4 C3@3 | 8.885 | −8.94% | [−1.151, −0.599] | ok | 0.0846 |
| t3 A23@4 L20@4 C3@3 | 8.897 | −8.82% | [−1.174, −0.580] | ok | 0.0807 |
| t3 A12@5 L28@4 C3@3 | 8.897 | −8.81% | [−1.146, −0.557] | ok | 0.0849 |
| t3 A16@5 L23@4 C3@3 | 8.774 | −10.08% | [−1.307, −0.657] | ok | 0.0778 |
| t3 A20@5 L18@4 C3@3 | 8.757 | −10.25% | [−1.354, −0.648] | ok | 0.0737 |
| t4 A28@3 L22@4 C3@3 (shipped) | 8.744 | — | — | — | 0.1085 |
| t4 A24@3 L22@4 C5@3 | 8.632 | −1.28% | [−0.192, −0.044] | ok | 0.1086 |
| t4 A32@3 L19@4 C3@3 | 8.794 | +0.58% | [+0.015, +0.098] | inconclusive | 0.1085 |
| t4 A20@3 L28@4 C3@3 | 8.661 | −0.95% | [−0.147, −0.034] | ok | 0.1087 |
| t4 A40@3 L13@4 C3@3 | 8.973 | +2.62% | [+0.093, +0.428] | FAIL | 0.1084 |
| t4 A12@3 L34@4 C3@3 | 8.607 | −1.57% | [−0.255, −0.042] | ok | 0.1091 |
| t4 A28@3 L19@4 C5@3 | 8.683 | −0.70% | [−0.120, −0.011] | inconclusive | 0.1085 |
| t4 A16@4 L27@4 C3@3 | 7.608 | −12.99% | [−1.450, −0.872] | ok | 0.0752 |
| t4 A23@4 L20@4 C3@3 | 7.702 | −11.91% | [−1.371, −0.766] | ok | 0.0744 |
| t4 A12@5 L28@4 C3@3 | 7.235 | −17.25% | [−1.878, −1.148] | ok | 0.0627 |
| t4 A16@5 L23@4 C3@3 | 7.233 | −17.28% | [−1.902, −1.149] | ok | 0.0605 |
| t4 A20@5 L18@4 C3@3 | 7.296 | −16.56% | [−1.871, −1.057] | ok | 0.0591 |

By opacity half, the same relative differences over the 7 mostly-opaque
images (non-opaque fraction below 0.5) and the 9 mostly-transparent ones.
Every tune alpha image falls in the `alpha` stratum and in no other
holdout3 stratum, so the stratum table is the overall row and is not
repeated.

| row | mostly-opaque (7) | mostly-transparent (9) |
|---|---|---|
| t3 A24@3 L22@4 C5@3 | −2.14% | −0.48% |
| t3 A32@3 L19@4 C3@3 | +0.64% | +0.36% |
| t3 A20@3 L28@4 C3@3 | −1.26% | −0.32% |
| t3 A40@3 L13@4 C3@3 | +2.54% | +1.65% |
| t3 A12@3 L34@4 C3@3 | −1.84% | +0.90% |
| t3 A28@3 L19@4 C5@3 | −1.51% | −0.07% |
| t3 A16@4 L27@4 C3@3 | −6.21% | −12.69% |
| t3 A23@4 L20@4 C3@3 | −5.15% | −13.84% |
| t3 A12@5 L28@4 C3@3 | −6.39% | −12.13% |
| t3 A16@5 L23@4 C3@3 | −6.29% | −15.26% |
| t3 A20@5 L18@4 C3@3 | −5.68% | −16.52% |
| t4 A24@3 L22@4 C5@3 | −2.05% | −0.31% |
| t4 A32@3 L19@4 C3@3 | +0.79% | +0.31% |
| t4 A20@3 L28@4 C3@3 | −1.30% | −0.50% |
| t4 A40@3 L13@4 C3@3 | +3.69% | +1.27% |
| t4 A12@3 L34@4 C3@3 | −2.29% | −0.66% |
| t4 A28@3 L19@4 C5@3 | −1.22% | −0.04% |
| t4 A16@4 L27@4 C3@3 | −8.75% | −18.31% |
| t4 A23@4 L20@4 C3@3 | −6.97% | −18.09% |
| t4 A12@5 L28@4 C3@3 | −11.65% | −24.26% |
| t4 A16@5 L23@4 C3@3 | −10.93% | −25.22% |
| t4 A20@5 L18@4 C3@3 | −9.40% | −25.53% |

What the tune result says:

1. **The count split §11.11 measured is flat at codes 3 and 4.** Every
   3-bit row is within 2.7% of the shipped row at both codes, as at code 2,
   and the rows with more alpha coefficients (`A32@3`, `A40@3`) are the
   worst. Their αMAE barely moves: 3-bit alpha fields already carry every
   coefficient a 3-bit code can resolve, so a larger count buys zeros.
2. **Alpha precision is what binds at codes 3 and 4.** Every row with 4- or
   5-bit alpha fields is 8.8% to 10.3% better at code 3 and 11.9% to 17.3%
   better at code 4, with every guard `ok` on intervals and αMAE down by a
   quarter to almost a half. The 5-bit rows lead at both codes. At code 2,
   §11.11's 4-bit row `A16@4 L14@4 C9@4` trailed the shipped 3-bit row;
   with 16 and 64 times the coefficients, the extra bits pay.
3. **The gain is largest on mostly-transparent cut-outs, and holds on the
   mostly-opaque ones.** For the 5-bit rows, −12% to −17% on the
   mostly-transparent half at code 3 and −24% to −26% at code 4, against
   −6% and −9% to −12% on the mostly-opaque half. That is the dependence
   `RATIONALE.md` future work item 14 warned of, and it is why the opacity
   halves are strata of their own on `holdout3`. No half loses.

**Selection (the rule D6 recorded before this run).** Per code, the row
with the lowest tune ΔE00 whose `guards (CI)` against the code's shipped
row is not `FAIL`: `t3 A20@5 L18@4 C3@3` (−10.25%) and
`t4 A16@5 L23@4 C3@3` (−17.28%; `A12@5 L28@4` is 0.002 behind). Both clear
Q13's 3%, so both are frozen, one Holm family of two. The selection does not
change under 20 other seeds. The code-3 pick's guards are `inconclusive`
on the mostly-opaque half on tune, which gates nothing there. Q8's power
statement for the pair on `holdout3`'s 24 alpha pins at m = 2, from each
comparison's tune spread (σ_rel 7.65% and 8.96%): an MDE of 4.81% at
code 3 and 5.64% at code 4. Neither resolves R1's 3%; both are about half
the tune estimate.

**The holdout3 read.** D6 froze at `eec3495`, and read `holdout3`'s alpha
part once from a clean tree at that commit: `mise run sweep
alpha-tiers34-frozen --split holdout3 --decision D6`, over its 24 alpha
pins, with exactly the four frozen rows. The result is committed as
`alpha-tiers34-frozen-holdout3.json`, and `mise run register-verdict D6`
re-derives every row below from it.

| comparison (row vs its code's shipped row, equal bytes) | ΔE00 | 95% CI of Δ | relative | p Holm | guards (CI) |
|---|---|---|---|---|---|
| code 3: `t3 A20@5 L18@4 C3@3` | −0.992 | [−1.314, −0.664] | −13.50% | ≤ 0.0004 | ok |
| code 4: `t4 A16@5 L23@4 C3@3` | −1.526 | [−1.827, −1.237] | −22.69% | ≤ 0.0004 | ok |

Per stratum, the relative difference over each stratum's pins (a pin may
sit in several; every pin is in `alpha`, so that column is the overall
row), and over each opacity half:

| comparison | smartphone (1) | extreme aspect (3) | mostly-opaque (11) | mostly-transparent (13) |
|---|---|---|---|---|
| code 3: `t3 A20@5 L18@4 C3@3` | −9.25% | −3.66% | −11.48% | −16.10% |
| code 4: `t4 A16@5 L23@4 C3@3` | −15.69% | −10.69% | −19.19% | −27.13% |

The shipped rows score 7.347 at code 3 and 6.725 at code 4 (medians 7.420
and 6.739, against 7.155 and 5.440 for the frozen rows). Under R1 and the
stratum rule (`mise run register-verdict D6`):

1. **Both rows pass R1.** Each is past 3% (−13.50% and −22.69%), each is
   Holm-significant with its p at the resampling floor, and every guard is
   `ok` on its paired interval, SSIMULACRA2, Butteraugli and DSSIM alike.
2. **No stratum fails.** Every stratum and both opacity halves are `ok`,
   except the three extreme-aspect pins, whose guards are `inconclusive`
   at both codes (n = 3); their ΔE00 intervals are nowhere near the
   rule's +1.0%. The mostly-opaque half gains less than the
   mostly-transparent one, as on tune, but out of sample by −11.48% and
   −19.19%, more than on tune.
3. **Condition 4 holds.** Under 20 bootstrap seeds other than 42 no
   outcome turns, overall or in any stratum.

**D6 passes R1 at codes 3 and 4.** Both effects are larger out of sample
than on tune, and both are well past the MDE Q8 computed. They are the
best rows measured, not a bracketed optimum. Both use 5-bit alpha fields,
the widest in the grid, so no wider-precision row was run. At code 3,
`A20@5` is also the grid's largest 5-bit count, and the tune gain was
still rising with count there (−8.81%, −10.08%, −10.25% for `A12@5`,
`A16@5` and `A20@5`). At code 4 the 5-bit counts peak inside the grid.
The shipped bytes are unchanged: adopting a 5-bit alpha row at codes 3 and 4 is a
format change, and a per-code row ends the single base row that codes 2–4
share, which the v0.8 verdict lands in every language or declines.

### 13.13 D8: the code-0 compact layout (2026-11)

Register entry D8 asks whether code 0 should ship another 21-byte AC layout
in place of the shipped `L19@4 C6@3`. It exists because C1 found
`L26@3 C6@3` 1.50% better than the shipped layout on `holdout2` (§13.7),
below R1's 3%, and `holdout2` chose the candidate, so it is not evidence
for it. `V0.8-DECISIONS.md` D8 records the sweep, the selection rule (the
default: one arm, the lowest tune ΔE00 that is not the shipped layout,
among those whose tune `guards (CI)` is not `FAIL`) and Q13's in-sample
stop, all committed before this result.

**Tune (`mise run sweep compact-retune`).** The 31 photographic tune
images, every hash 21 B. The 15 layouts of `compact-tier.json` (§11.10),
unchanged, each encoded at code 0 as deployed rather than at code 1 with a
21-byte override as §11.10 and C1 measured them, every arm read against the
shipped `L19@4 C6@3`. Every arm's mean ΔE00 is the one §11.10 records for
the same layout to the third decimal: the tier code changes the header,
not the payload or the render. `relative` is the difference of means over
the shipped mean; the interval, `p Holm` (across the 14 arms) and the
guards are paired.

| arm | ΔE00 | relative | 95% CI of Δ | p Holm | guards (CI) |
|---|---|---|---|---|---|
| t0 L19@4 C6@3 (shipped) | 12.156 | — | — | — | — |
| t0 L26@3 C6@3 | 12.166 | +0.09% | [−0.067, +0.085] | 1.0000 | inconclusive |
| t0 L13@5 C6@4 (pre-v0.7 shape) | 12.620 | +3.81% | [+0.292, +0.666] | 0.0028 | FAIL |
| t0 L22@3 C8@3 | 12.199 | +0.35% | [−0.026, +0.113] | 1.0000 | inconclusive |
| t0 L18@4 C7@3 | 12.171 | +0.13% | [−0.028, +0.073] | 1.0000 | inconclusive |
| t0 L20@4 C5@3 | 12.243 | +0.72% | [−0.002, +0.204] | 0.6775 | ok |
| t0 L22@4 C4@3 | 12.207 | +0.42% | [−0.050, +0.188] | 1.0000 | ok |
| t0 L16@4 C8@3 | 12.244 | +0.72% | [−0.007, +0.184] | 0.6775 | FAIL |
| t0 L16@4 C6@4 | 12.289 | +1.10% | [+0.051, +0.226] | 0.0120 | FAIL |
| t0 L24@3 C7@3 | 12.189 | +0.27% | [−0.033, +0.102] | 1.0000 | inconclusive |
| t0 L28@3 C5@3 | 12.182 | +0.22% | [−0.130, +0.187] | 1.0000 | inconclusive |
| t0 L30@3 C3@3 | 12.239 | +0.68% | [−0.107, +0.283] | 1.0000 | ok |
| t0 L20@3 C9@3 | 12.228 | +0.59% | [−0.010, +0.148] | 0.7325 | inconclusive |
| t0 L35@3 C2@2 (count-max) | 12.280 | +1.02% | [−0.124, +0.381] | 1.0000 | ok |
| t0 L19@5 C2@4 (precision-max) | 12.444 | +2.37% | [+0.117, +0.486] | 0.0028 | inconclusive |

The same arms on the 16 graphics tune images
(`mise run sweep compact-retune-graphics`, with `forceOpaque` as §11.10's
graphics run had), which gate nothing:

| arm | ΔE00 | relative | 95% CI of Δ | p Holm | guards (CI) |
|---|---|---|---|---|---|
| t0 L19@4 C6@3 (shipped) | 10.855 | — | — | — | — |
| t0 L26@3 C6@3 | 10.813 | −0.39% | [−0.121, +0.029] | 1.0000 | ok |
| t0 L13@5 C6@4 (pre-v0.7 shape) | 11.166 | +2.86% | [+0.097, +0.576] | 0.0028 | FAIL |
| t0 L22@3 C8@3 | 10.902 | +0.43% | [−0.063, +0.195] | 1.0000 | inconclusive |
| t0 L18@4 C7@3 | 10.917 | +0.57% | [−0.028, +0.200] | 1.0000 | inconclusive |
| t0 L20@4 C5@3 | 10.783 | −0.67% | [−0.190, +0.009] | 1.0000 | inconclusive |
| t0 L22@4 C4@3 | 10.805 | −0.47% | [−0.201, +0.078] | 1.0000 | ok |
| t0 L16@4 C8@3 | 11.060 | +1.89% | [+0.018, +0.446] | 0.3168 | FAIL |
| t0 L16@4 C6@4 | 11.078 | +2.05% | [+0.046, +0.449] | 0.0052 | FAIL |
| t0 L24@3 C7@3 | 10.885 | +0.27% | [−0.064, +0.159] | 1.0000 | inconclusive |
| t0 L28@3 C5@3 | 10.737 | −1.09% | [−0.261, −0.002] | 0.5235 | ok |
| t0 L30@3 C3@3 | 10.732 | −1.14% | [−0.296, +0.048] | 1.0000 | inconclusive |
| t0 L20@3 C9@3 | 10.870 | +0.14% | [−0.169, +0.201] | 1.0000 | inconclusive |
| t0 L35@3 C2@2 (count-max) | 10.869 | +0.13% | [−0.299, +0.429] | 1.0000 | inconclusive |
| t0 L19@5 C2@4 (precision-max) | 10.996 | +1.30% | [−0.112, +0.478] | 1.0000 | inconclusive |

Per `holdout3` stratum, from each tune image's own covariates
(`mise run stratify compact-retune --strata` and
`mise run stratify compact-retune-graphics --strata`), the relative
difference of the layouts within 0.5% of the shipped one overall, and the
stratum rule's verdict; the photographic tune split holds no
extreme-aspect image, and on tune the strata gate nothing:

| stratum (tune images) | `L26@3 C6@3` | `L18@4 C7@3` | `L28@3 C5@3` | `L24@3 C7@3` | `L22@3 C8@3` | `L22@4 C4@3` |
|---|---|---|---|---|---|---|
| smartphone (4) | −0.67%, inconclusive | +0.25%, inconclusive | −0.32%, inconclusive | +0.68%, inconclusive | −0.32%, inconclusive | +0.09%, inconclusive |
| skin (11) | +0.24%, inconclusive | +0.29%, inconclusive | +1.55%, inconclusive | +0.16%, inconclusive | +0.19%, inconclusive | +1.32%, ok |
| low-light (9) | +0.01%, inconclusive | +0.07%, inconclusive | −0.37%, inconclusive | +0.34%, inconclusive | +0.06%, inconclusive | −0.44%, inconclusive |
| graphics (16) | −0.39%, ok | +0.57%, inconclusive | −1.09%, ok | +0.27%, inconclusive | +0.43%, inconclusive | −0.47%, ok |

What the tune result says:

1. **No layout beats the shipped one on the photographs.** Every one of
   the 14 candidates has a higher mean ΔE00 than `L19@4 C6@3`, and none
   has an interval wholly below zero. The leading layouts are §11.10's
   plateau: `L26@3 C6@3` is +0.09% with a 95% interval of the paired ΔE00
   difference of [−0.067, +0.085],
   and five layouts sit within +0.35%.
2. **The graphics split leans the other way, and not far.** Five layouts
   score below the shipped one on graphics, the best `L30@3 C3@3` at
   −1.14% and `L28@3 C5@3` at −1.09%, the only interval that excludes zero
   and not after Holm; `L26@3 C6@3` is −0.39%. None is near 3%, and the
   graphics split gates nothing.
3. **No stratum hides a gain the size of the bar.** The smartphone stratum
   favours `L26@3 C6@3` by −0.67% over 4 images; no stratum entry for a
   plateau layout is past ±1.6%.
4. **An adaptive layout could not reach the bar either.** The per-image
   oracle that picks, for each image, whichever of the 15 layouts scores
   lowest, after scoring them, with no bit spent to signal it, is −2.41%
   against the shipped layout on the photographs (−3.23% on graphics),
   computed from the committed per-image ΔE00 of `compact-retune.json` and
   `compact-retune-graphics.json`. It is an oracle, so it cannot be an arm
   (the adaptive/conditional rule), and the minimum of 15 noisy scores per
   image overstates any encoder's decision. A signalled form would also pay
   for its choice inside the same 21 bytes, so on the photographic primary
   no adaptive layout choice among these could clear R1's 3%.

**Selection (the rule D8 recorded before this run).** The lowest tune
ΔE00 that is not the shipped layout is `t0 L26@3 C6@3` (12.166), whose
tune `guards (CI)` is `inconclusive`, not `FAIL`, so the rule picks it.
It is +0.09% against the shipped layout, not 3% better, so it fails R1's
condition 1 in sample, and under Q13 D8 is decided without a `holdout3`
read: nothing is frozen, and `holdout3` stays unread by D8. The pick and
the outcome rest on point estimates; under 20 bootstrap seeds other than
42, `mise run arms --seed-sensitivity compact-retune` turns no interval
and no Holm verdict, and no seed can move a mean.

**The verdict: D8 does not pass.** The shipped `L19@4 C6@3` stays the
code-0 layout. The 1.50% C1 found for `L26@3 C6@3` on `holdout2` does not
reappear on tune, where the two are a tie (+0.09%); it was read on the
split that chose the candidate, and it was below R1's 3% there too. The
shipped bytes are unchanged, and C1's ThumbHash admission of the compact
tier, which this entry did not re-read, stands as §13.7 records it.

### 13.14 D9: chroma-from-luma, adaptive or conditional (2026-11)

Register entry D7 decided that a signalled per-channel chroma-from-luma
gain never pays (§7.10), and named a cheaper way to signal the gains as the
only open route. D9 is that route: a predictor the encoder switches on per
image and signals (adaptive), or one active only on a class the decoder
recovers from the hash (conditional). Before any such form is built,
`V0.8-DECISIONS.md` D9 fixes an upper bound on all of them, and the rule
that reads it, committed (`00c4498`) before this result.

**The bound.** At each code, each image takes the lowest ΔE00 among the
tier's shipped arm and three free CfL arms, after scoring and with no bit
spent on the choice. The free arms carry their least-squares gain field on
top of the tier's bytes, so their hashes are 1–3 B longer, and they differ
only in the gain's precision and clamp. A deployed form has to decide
before scoring and pay for its flag and its gains inside the tier's bytes,
so it cannot beat this bound. Taking the minimum of four noisy scores per
image overstates any real choice, which only makes the bound looser. Code
k is decided on the bound if the bound is not at least 3.0% lower,
overall and in each class a conditional form could switch on: the alpha
flag (alpha against opaque) and the aspect byte (extreme aspect). A form
that activates per image on anything else the hash carries, such as the
DC colour, is covered by the overall bound. Its mean is never below the
mean of per-image minima.

**Tune (`mise run sweep cfl-oracle`).** The 63 real tune images: 31
photographic, 16 alpha and 16 graphics, over white, black and grey, as in
§13.8. Each free arm is read against its own code's shipped arm. Its
hash is larger, so this table measures what the prediction is worth, not
what it would cost.

| arm | ΔE00 | relative | 95% CI of Δ | guards (CI) |
|---|---|---|---|---|
| t0 shipped | 12.286 | — | — | — |
| t0 free cfl_bits=5 cfl_range=0.5 | 12.284 | −0.02% | [−0.017, +0.011] | ok |
| t0 free cfl_bits=8 cfl_range=0.25 | 12.281 | −0.04% | [−0.017, +0.006] | ok |
| t0 free cfl_bits=10 cfl_range=1.0 | 12.288 | +0.01% | [−0.012, +0.014] | ok |
| t1 shipped | 11.608 | — | — | — |
| t1 free cfl_bits=5 cfl_range=0.5 | 11.595 | −0.11% | [−0.030, +0.003] | ok |
| t1 free cfl_bits=8 cfl_range=0.25 | 11.594 | −0.12% | [−0.032, +0.002] | ok |
| t1 free cfl_bits=10 cfl_range=1.0 | 11.597 | −0.10% | [−0.028, +0.004] | ok |
| t2 shipped | 9.858 | — | — | — |
| t2 free cfl_bits=5 cfl_range=0.5 | 9.847 | −0.11% | [−0.021, −0.001] | ok |
| t2 free cfl_bits=8 cfl_range=0.25 | 9.846 | −0.12% | [−0.020, −0.005] | ok |
| t2 free cfl_bits=10 cfl_range=1.0 | 9.843 | −0.16% | [−0.024, −0.007] | ok |
| t3 shipped | 8.322 | — | — | — |
| t3 free cfl_bits=5 cfl_range=0.5 | 8.287 | −0.43% | [−0.054, −0.020] | ok |
| t3 free cfl_bits=8 cfl_range=0.25 | 8.289 | −0.40% | [−0.050, −0.018] | ok |
| t3 free cfl_bits=10 cfl_range=1.0 | 8.284 | −0.46% | [−0.058, −0.022] | ok |
| t4 shipped | 7.246 | — | — | — |
| t4 free cfl_bits=5 cfl_range=0.5 | 7.167 | −1.09% | [−0.123, −0.044] | ok |
| t4 free cfl_bits=8 cfl_range=0.25 | 7.170 | −1.05% | [−0.115, −0.045] | ok |
| t4 free cfl_bits=10 cfl_range=1.0 | 7.162 | −1.15% | [−0.129, −0.047] | ok |

The bound by code (`mise run register-verdict D9`). `shipped` and
`oracle` are the mean ΔE00 of the shipped arm and of the per-image minima.
`bound` is their relative difference over all 63 images, and the next
three columns give it within each class the decoder recovers from the hash:
the 18 images the encoder put in alpha mode (read off the run's own code-2
hash lengths), the 45 opaque ones, and the one image at an aspect of 3:1 or
more. `CfL lower` counts the images on which a free arm scores below the
shipped arm.

| code | shipped | oracle | bound | alpha flag (18) | opaque (45) | extreme aspect (1) | CfL lower | outcome |
|---|---|---|---|---|---|---|---|---|
| code 0 | 12.286 | 12.267 | −0.15% | −0.02% | −0.21% | 0.00% | 33 of 63 | decided on the bound |
| code 1 | 11.608 | 11.573 | −0.31% | −0.11% | −0.39% | 0.00% | 36 of 63 | decided on the bound |
| code 2 | 9.858 | 9.835 | −0.23% | −0.19% | −0.25% | 0.00% | 42 of 63 | decided on the bound |
| code 3 | 8.322 | 8.275 | −0.56% | −0.29% | −0.69% | 0.00% | 43 of 63 | decided on the bound |
| code 4 | 7.246 | 7.154 | −1.27% | −0.66% | −1.56% | 0.00% | 43 of 63 | decided on the bound |

The same bound by corpus and by `holdout3` stratum
(`mise run stratify cfl-oracle --cfl-oracle`). The strata are derived from
each tune image's own covariates, as in §13.8. On tune they are reported
and gate nothing. The `alpha` stratum (17) is measured on the 512 px
scoring reference and rounded to the pins' four places, while the alpha
flag (18 above) is the encoder's own decision on its input, so the two
counts differ by one.

| group (tune images) | code 0 | code 1 | code 2 | code 3 | code 4 |
|---|---|---|---|---|---|
| photographic (31) | −0.22% | −0.39% | −0.18% | −0.54% | −1.13% |
| alpha corpus (16) | −0.01% | −0.09% | −0.15% | −0.25% | −0.59% |
| graphics (16) | −0.18% | −0.39% | −0.46% | −1.00% | −2.40% |
| smartphone (4) | −0.65% | −0.57% | −0.33% | −0.43% | −1.16% |
| alpha (17) | −0.02% | −0.10% | −0.17% | −0.29% | −0.67% |
| skin (12) | −0.20% | −0.65% | −0.25% | −1.05% | −2.09% |
| low-light (10) | −0.39% | −0.12% | −0.24% | −0.66% | −2.14% |
| extreme-aspect (1) | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |

What the tune result says:

1. **The predictor works, and it grows with the tier, as §7.10 found.**
   Every free arm at codes 2–4 has a paired interval wholly below zero,
   and every guard is `ok`. The gain is −0.04% to +0.01% at code 0 and
   −1.05% to −1.15% at code 4. The three gain quantisations agree to within
   0.10 points at every code, which reproduces §7.10's finding that gain
   precision is not what limits CfL.
2. **The best any per-image choice could do is −1.27%, at code 4.** At
   codes 0–3 the bound is −0.15% to −0.56%. A free arm is lower on 33 to
   43 of the 63 images, but each time by little, so letting every image
   pick its own predictor and gain, for free, adds only 0.07 to 0.19
   points to the best single free arm at each code.
3. **No recoverable class reaches the bar either.** The largest class
   bound is the opaque images at code 4, −1.56%. Alpha-mode images gain
   least (−0.66% at code 4), which fits alpha mode's smaller chroma
   allocation. The one extreme-aspect image never gains:
   no free arm scores below the shipped arm on it at any code. A
   conditional form on the alpha flag, the aspect or the tier code
   therefore cannot pass anywhere.
4. **No stratum hides a gain the size of the bar.** The largest stratum
   bounds are at code 4: graphics −2.40%, low-light −2.14% and skin
   −2.09%. Graphics is not a class the decoder can recover from the hash,
   and an adaptive flag scoped to it would be judged overall, where the
   bound is −1.27%. The photographs, D7's corpus, reach −1.13%.
5. **The seed moves nothing.** The bound is a mean of per-image minima,
   so no bootstrap seed moves it. Under 20 seeds other than 42,
   `mise run arms --seed-sensitivity cfl-oracle` turns no interval and no
   Holm verdict of the 19 arms.

**The rule (recorded before this run).** The bound is under 3.0% at every
code 0–4, overall and in every recoverable class the tune split holds, so
every code is decided on the bound. No deployable arm is registered or
built, and `holdout3` is not read for D9 and stays unread by it.

**The verdict: D9 does not pass at any code.** No adaptive or conditional
chroma-from-luma predictor can clear R1's 3% on tune, even before it pays
for its signalling. The shipped format keeps no CfL (`cfl_bits` stays 0),
and the shipped bytes are unchanged. Reopening CfL now needs a
predictor other than a least-squares gain on co-located luma
coefficients, which is what this bound covers.

### 13.15 The v0.8 verdict: the adopted entries, combined (2026-11)

Every register entry is decided. Per entry, with its section:

- **D1**, entropy-coded AC: passes R1 at code 3 on `holdout3` (−6.04%),
  not at code 4 (−2.80%), and code 2 is decided in sample by the two-arm
  cap (§13.8).
- **D2**, embedded tiers: not adopted, decided in sample; every prefix fails
  the guards against the native code it stands for (§13.9).
- **D3**, the synthesis window: passes R2 at codes 3 and 4 on `holdout3`
  (§13.10).
- **D4**, the separable forward DCT: not adopted, decided in sample on the
  instruction count against `ACCEL_ALL` (1.166×, under 2.0×).
- **D5**, downsampling before the transform: fails on `holdout3`, the
  low-light stratum at code 2 (§13.11).
- **D6**, the alpha allocation: passes R1 at codes 3 and 4 on `holdout3`'s
  alpha pins (−13.50%, −22.69%; §13.12).
- **D7** and **D9**, chroma-from-luma: not adopted, decided on tune (§7.10,
  §13.14).
- **D8**, the code-0 layout: the shipped layout stays, decided in sample
  (§13.13).
- **C1** and **C2**: every shipped constant stands (§13.7).

So three entries passed their rule once on the sealed `holdout3`, each
alone against the shipped format: D1 at code 3, D3 at codes 3 and 4, and
D6 at codes 3 and 4. Before the three land as one format, `V0.8-DECISIONS.md`
("The v0.8 verdict") fixes how their combination is read on tune, committed
(`1af9626`) before this result. No sealed split is read.

**The rule.** A (code, alpha mode) pair is a cell, which the decoder
recovers from the hash. In each cell the best single arm `S*` is the one
of the cell's adopted entries with the lowest tune mean ΔE00. Every
combination that holds `S*`'s entry is read against it under R2 with
δ = 1.0%, as the register reads its rules in sample: the upper bound of the
paired ΔE00 interval at most +1.0% of `S*`'s mean, guards (CI) not `FAIL`,
D3's own primary (mean spurious detail against shipped code 2 at most 0)
when it holds D3, and no outcome turning under 20 other seeds. The cell
adopts the passing combination with the most entries, or `S*` alone.

**Tune (`mise run sweep v08-combination`).** The 63 real tune images: 31
photographic, 16 alpha and 16 graphics, over white, black and grey, as in
§13.8. Each single copies its frozen arm's tune string; a combination is the
union of its entries' strings, D1 with D6 coding the stream with bounds of
three times the D6 row. A D6 string moves only alpha-mode hashes. Every arm
against its own code's shipped arm:

| arm | ΔE00 | relative | 95% CI of Δ | guards (CI) |
|---|---|---|---|---|
| t2 shipped | 9.858 | — | — | — |
| t3 shipped | 8.322 | — | — | — |
| t3 D1 | 7.691 | −7.58% | [−0.816, −0.475] | ok |
| t3 D3 | 8.321 | −0.01% | [−0.023, +0.027] | inconclusive |
| t3 D6 | 8.070 | −3.03% | [−0.401, −0.122] | ok |
| t3 D1+D3 | 7.665 | −7.89% | [−0.830, −0.509] | ok |
| t3 D1+D6 | 7.426 | −10.76% | [−1.119, −0.696] | ok |
| t3 D3+D6 | 8.085 | −2.85% | [−0.377, −0.115] | inconclusive |
| t3 D1+D3+D6 | 7.408 | −10.98% | [−1.123, −0.725] | ok |
| t4 shipped | 7.246 | — | — | — |
| t4 D3 | 7.229 | −0.24% | [−0.071, +0.049] | inconclusive |
| t4 D6 | 6.862 | −5.31% | [−0.582, −0.211] | ok |
| t4 D3+D6 | 6.866 | −5.25% | [−0.569, −0.213] | ok |

The rule, cell by cell (`mise run stratify v08-combination --combination`).
Each candidate against its cell's `S*`, over the cell's images: the alpha
corpus for the alpha cells, the photographic and graphics images for the
opaque ones.

| cell | n | `S*` | candidate | ΔE00 vs `S*` | upper bound | guards (CI) | spurious vs code 2 | outcome |
|---|---|---|---|---|---|---|---|---|
| 3, opaque | 47 | t3 D1 | t3 D1+D3 | −0.61% | −0.22% | ok | +0.157 | fails (spurious) |
| 3, alpha | 16 | t3 D6 | t3 D1+D6 | −9.07% | −6.22% | ok | — | passes |
| 3, alpha | 16 | t3 D6 | t3 D3+D6 | +1.26% | +1.53% | FAIL | −4.058 | fails |
| 3, alpha | 16 | t3 D6 | t3 D1+D3+D6 | −8.41% | −5.72% | ok | −3.836 | passes |
| 4, alpha | 16 | t4 D6 | t4 D3+D6 | +2.44% | +3.28% | inconclusive | −4.259 | fails (δ) |

(4, opaque) holds D3 alone, so it has no candidate. No outcome turns under
the 20 other seeds. The cells adopt `t3 D1` (opaque), `t3 D1+D3+D6`
(alpha), `t4 D3` (opaque) and `t4 D6` (alpha).

The format as it ships, each image scored by the row its own alpha flag
adopts (read off its code-2 hash length), against its code's shipped arm,
by corpus and by `holdout3` stratum. The strata are derived from each tune
image's covariates, as in §13.8; on tune they gate nothing.

| group (tune images) | code 3 | code 4 |
|---|---|---|
| overall (63) | −10.63% [−1.104, −0.690], ok | −5.78% [−0.618, −0.238], ok |
| photographic (31) | −7.24%, ok | −1.00%, ok |
| alpha corpus (16) | −17.80%, ok | −17.28%, ok |
| graphics (16) | −8.24%, ok | −0.12%, inconclusive |
| smartphone (4) | −6.06%, ok | −1.88%, ok |
| alpha (17) | −17.46%, ok | −16.72%, ok |
| skin (12) | −6.54%, ok | −1.58%, inconclusive |
| low-light (10) | −11.01%, ok | +0.72%, inconclusive |
| extreme-aspect (1) | −15.90%, ok | +3.05%, FAIL |

What the tune result says:

1. **The coder and the 5-bit alpha row compound.** At code 3 in alpha
   mode, coding the stream with bounds of three times the D6 row is 9.07%
   better than the D6 row alone and 18.39% better than the shipped code-3
   row on the alpha corpus. Each alone was 7.67% (D1) and 10.25% (D6) on
   that corpus.
2. **The window does not combine with the coder at code 3 opaque.** It
   still lowers ΔE00 (−0.61% against the coder alone), but the coded arm
   invents more than code 2 (+0.157 levels over the 47 opaque images), so
   D3's primary fails in combination and the opaque code 3 ships without
   it. At code 3 in alpha mode the window keeps D3's primary (−3.836) and
   stays inside δ, so it ships there.
3. **The window costs the 5-bit alpha row at code 4.** On the alpha corpus
   it is +2.44% against D6 alone, with the interval wholly above δ: the
   alpha stratum, which D3's `holdout3` read already flagged as the one
   that pays (§13.10), pays more once the alpha field is finer. Alpha-mode
   code 4 ships without the window; opaque code 4 ships with it.
4. **The alpha flag reads the same.** Two graphics images are alpha-mode
   hashes (18 alpha, 45 opaque by the encoder's own flag). Read by the
   flag rather than by corpus, every candidate's outcome and every cell's
   adoption are unchanged: code 3 opaque −0.57% with spurious +0.151, code
   3 alpha `t3 D1+D3+D6` at −8.17% against `t3 D6`, code 4 alpha
   `t4 D3+D6` at +1.93% (upper bound +3.00%).
5. **One tune image fails at code 4.** The single extreme-aspect image is
   +3.05% with a guard `FAIL` under the window. On tune the strata gate
   nothing, and D3's `holdout3` read failed no stratum at code 4 (§13.10);
   one image is not a stratum estimate. It is recorded, not acted on.

**The verdict.** v0.8 lands D1 at code 3, D6 at codes 3 and 4 in alpha
mode, and D3 at code 3 in alpha mode and at code 4 in opaque mode, as
wire-format generation v2 (`version` = 1) and release 0.8.0, in every
language (spec `README.md` §13). Every form is conditional on the tier
code and the alpha flag, both in the hash. U19 bounds every figure here:
these are metric verdicts.

### 13.16 The load-bearing claims, re-run from a clean fetch (2026-11)

Every register entry started from figures in this file, and those figures had
survived three corpus revisions (§9, §9.5, #102) and a resample change
(§13.5). #130 re-ran each one that `V0.8-DECISIONS.md`, `RATIONALE.md` and
`README.md` lean on, at `master` (`86a30af`), in a fresh checkout with an
empty fixture cache (every image fetched again and checked against its pin)
and the metric cache off, into scratch result names that overwrite nothing.
No sealed split was read: only tune, tune2 and the graphics tune split.
Nothing was tuned, and no criterion moved: every register entry was decided
before this ran (§13.15), and none is reopened by it. The status rule was
fixed in #130 before the first re-run:

- **reproduced**: every per-image score matches, or the figure matches at its
  printed precision;
- **drifted**: the figure moves, but its sign, its Holm verdict and its
  `guards (CI)` verdict do not;
- **not reproduced**: one of those verdicts turns, or the claim cannot be
  re-run.

`master` is not the encoder these figures were measured on. #162 landed
wire-format generation v2 after them, and it changes the encoder at codes 3
and 4 (§13.15) and nothing below code 3. So every result that moved at master
was re-run a second time at `225bdce`, the last generation-v1 revision, with
the same harness. The scoring harness is identical at the two revisions:
`sweep` and `rd-budget` encode and decode ChromaHash through
`rust/examples/encode_stdin`, and nothing on the path they score through
changed outside `rust/`. Outside `rust/`,
`git diff 225bdce 86a30af` touches `spec/`, `bindings/`, `csharp/`, `go/`,
`python/`, `swift/`, `typescript/`, `tools/benchmark/` (its
`pyproject.toml` and `uv.lock`), and seven paths under `tools/comparison/`:
`package.json` (the version), `sweeps/v08-combination.json` and
`results/v08-combination.json` (a new sweep and its result), and four files
under `src/` (`combination-core.ts`, new; `stratify.ts`'s `--combination`;
and their `verify-experiments.ts` and `metric-selftest.ts` checks). A
figure that
moves at master and holds at v1 is the format change, not an error in the
record. The re-runs are committed under `results/reproductions/` (master) and
`results/reproductions/v1/` (v1), outside the directory every count in §13.5
and §13.6 is taken over.

**Per image.** Each re-run against its committed result, value by value, at
the 10⁻⁵ relative tolerance `selftest:determinism` holds one sweep to.
`rd-budget-holdout` and `v07-holdout-photo-holdout` scored what is `tune2` now
(#76), so their re-runs are `--split tune2`; the v1 `rd-budget` re-run scored
only the two ChromaHash arms #162 moves.

| result | re-run | arms | values | moved at master | at master | at v1 |
|---|---|---|---|---|---|---|
| `alpha-fields` | `alpha-fields` | 11 | 1056 | 0 | identical (11 arms) | — |
| `alpha-ac-count` | `alpha-ac-count` | 19 | 1824 | 0 | identical (19 arms) | — |
| `alpha-ceiling` | `alpha-ceiling` | 34 | 3264 | 0 | identical (34 arms) | — |
| `alpha-tier1` | `alpha-tier1` | 9 | 864 | 0 | identical (9 arms) | — |
| `compact-tier` | `compact-tier` | 15 | 2325 | 0 | identical (15 arms) | — |
| `compact-tier-graphics` | `compact-tier-graphics` | 9 | 720 | 0 | identical (9 arms) | — |
| `compact-tier-alpha` | `compact-tier-alpha` | 24 | 2304 | 0 | identical (24 arms) | — |
| `v07-holdout-photo` | `v07-holdout-photo` | 9 | 1395 | 0 | identical (9 arms) | — |
| `v07-holdout-photo-holdout` | `v07-holdout-photo-tune2` | 9 | 1440 | 0 | identical (9 arms) | — |
| `v07-holdout-alpha` | `v07-holdout-alpha` | 9 | 864 | 0 | identical (9 arms) | — |
| `rd-budget-holdout` | `rd-budget-tune2` | 54 | 8640 | 255 | 2 of 54 arms moved | identical (2 re-run arms) |
| `embedded-tiers` | `embedded-tiers` | 13 | 2015 | 372 | 3 of 13 arms moved | identical (13 arms) |
| `cfl` | `cfl` | 18 | 2790 | 496 | 4 of 18 arms moved | identical (18 arms) |
| `cfl-range` | `cfl-range` | 13 | 2015 | 248 | 2 of 13 arms moved | identical (13 arms) |
| `selection-weights` | `selection-weights` | 29 | 4495 | 0 | identical (29 arms) | — |
| `selection-hv` | `selection-hv` | 15 | 2325 | 0 | identical (15 arms) | — |
| `synthesis-window` | `synthesis-window` | 8 | 2976 | 0 | identical (8 arms) | — |
| `synthesis-window-upper` | `synthesis-window-upper` | 6 | 2232 | 0 | identical (6 arms) | — |
| `artifact-ladder` | `artifact-ladder` | 5 | 1860 | 620 | 2 of 5 arms moved | identical (5 arms) |
| `artifact-ladder-common-grid` | `artifact-ladder-common-grid` | 5 | 1860 | 620 | 2 of 5 arms moved | identical (5 arms) |

47,264 per-image values across 20 results. Every arm below code 3 reproduces
to the value. The 2,611 values that moved belong to 15 arms, every one of them
at code 3 or code 4, and each of those arms reproduces to the value at v1. No
value in this file's record failed to reproduce on the encoder that produced
it.

**The claims.** The figure as recorded is computed from the committed result
exactly as its section's binding computes it, and `at master` and `at v1` from
the re-runs (`reproduce-core.ts`). `verify:experiments` binds every cell, and
`node tools/comparison/dist/reproduce.js` prints the table. §7.13's three
figures had no committed result until now (`entropy-budget` wrote only scratch
output), so their recorded figure is the one §7.13 prints, and their re-run is
the record `entropy-budget --record` commits.

| claim | § | as recorded | at master | at v1 | status | command |
|---|---|---|---|---|---|---|
| alpha row `A28@3 L22@4 C3@3` at code 1 | 11.3 | −17.10% | −17.10% | — | reproduced | `sweep alpha-ceiling` |
| the same row at code 2 | 11.11 | −11.95% | −11.95% | — | reproduced | `sweep alpha-tier1` |
| compact leader `L19@4 C6@3` against the shipped shape | 11.10 | −3.67% | −3.67% | — | reproduced | `sweep compact-tier` |
| `L16@4 C8@3` against the leader, Holm p | 11.10 | 0.6775 | 0.6775 | — | reproduced | `sweep compact-tier` |
| compact leader on the graphics tune split | 11.10 | −2.78% | −2.78% | — | reproduced | `sweep compact-tier-graphics` |
| compact leader against the shipped shape, on tune2 | 11.12 | −2.78% | −2.78% | — | reproduced | `sweep v07-holdout-photo --split tune2` |
| compact 21 B against ThumbHash, ΔE00, on tune2 | 11.12 | 12.146 vs 12.807 | 12.146 vs 12.807 | — | reproduced | `rd-budget --split tune2` |
| best coder's AC bits against the fixed fields, LOO | 7.13 | −7.5% | −7.5% | — | reproduced | `entropy-budget --split tune --record` |
| the saving spent at 32 B, ΔE00 | 7.13 | −1.6% | −1.6% | — | reproduced | `entropy-budget --split tune --record` |
| the saving spent at 108 B, ΔE00 | 7.13 | −4.8% | −4.8% | — | reproduced | `entropy-budget --split tune --record` |
| first 32 B of an interleaved code-2 hash against native code 1 | 7.11 | +4.15% | +4.15% | +4.15% | reproduced | `sweep embedded-tiers` |
| interleaved against channel-sequential, at the 32 B cut | 7.11 | −5.0% | −5.0% | −5.0% | reproduced | `sweep embedded-tiers` |
| CfL paid at 32 B (`L24@5 C9@4`) against the shipped layout | 7.10 | +2.11% | +2.11% | +2.11% | reproduced | `sweep cfl` |
| CfL free at code 1 | 7.10 | −0.10% | −0.10% | −0.10% | reproduced | `sweep cfl` |
| CfL free at code 3 | 7.10 | −0.45% | −0.29% | −0.45% | not reproduced | `sweep cfl` |
| CfL free at code 4 | 7.10 | −0.90% | −0.92% | −0.90% | drifted | `sweep cfl` |
| `aniso 0.9 / hv 0` against the default | 11.5 | −0.76% | −0.76% | — | reproduced | `sweep selection-weights` |
| `aniso 0.9 / hv 0`, Holm p | 11.5 | 0.0432 | 0.0432 | — | reproduced | `sweep selection-weights` |
| `aniso 1.2 / hv 0` (`sel_hv` off), Holm p | 11.5 | 0.2112 | 0.2112 | — | reproduced | `sweep selection-weights` |
| `sel_hv` 0.15 → 0.30 | 11.5 | +0.39% | +0.39% | — | reproduced | `sweep selection-weights` |
| window `w_min 0.5 exp 2` at code 1, spurious detail | 12.2 | −73% | −73% | — | reproduced | `sweep synthesis-window` |
| window `w_min 0.85 exp 1` at code 1, ΔE00 | 12.2 | +0.33% | +0.33% | — | reproduced | `sweep synthesis-window` |
| window `w_min 0.85 exp 1` at code 2, ΔE00 Δ and interval | 12.3 | +0.008 [−0.011, +0.028] | +0.008 [−0.011, +0.028] | — | reproduced | `sweep synthesis-window-upper` |
| window `w_min 0.85 exp 1` at code 2, spurious detail | 12.3 | −28% | −28% | — | reproduced | `sweep synthesis-window-upper` |
| the ladder, code 0 ΔE00 | 13.1 | 12.156 | 12.156 | 12.156 | reproduced | `sweep artifact-ladder` |
| the ladder, code 1 ΔE00 | 13.1 | 11.481 | 11.481 | 11.481 | reproduced | `sweep artifact-ladder` |
| code 3 − code 2, spurious detail on the pinned grid | 13.2 | +0.735 [+0.358, +1.159] | +0.780 [+0.363, +1.193] | +0.735 [+0.358, +1.159] | drifted | `sweep artifact-ladder-common-grid` |
| code 4 − code 2, spurious detail on the pinned grid | 13.2 | +0.742 [+0.270, +1.195] | −0.354 [−0.810, +0.081] | +0.742 [+0.270, +1.195] | not reproduced | `sweep artifact-ladder-common-grid` |
| `selection-weights`, arms that survive Holm | 13.5 | 2 | 2 | — | reproduced | `sweep selection-weights` |
| `selection-weights`, arms `ok` on intervals | 13.5 | 2 | 2 | — | reproduced | `sweep selection-weights` |
| `synthesis-window`, arms that survive Holm | 13.5 | 5 | 5 | — | reproduced | `sweep synthesis-window` |

What it says:

1. **27 of the 31 claims reproduce at master, to their printed precision.**
   That is every claim below code 3: the alpha row (−17.10% at code 1,
   −11.95% at code 2), the compact plateau and its tie-break across corpora,
   the compact tier against ThumbHash on tune2, entropy coding's −7.5% of AC
   bits and its −1.6% and −4.8%, the embedded-tier +4.15% and the 5.0%
   interleaving gain, CfL's paid +2.11% and free −0.10% at code 1, both
   §11.5 findings with their Holm p, the window at codes 1 and 2, the ladder's
   code 0 and code 1, and the §13.5 counts of the re-run sweeps.
2. **The other four are at codes 3 and 4, and #162 moved them.** CfL given
   away free at code 3 is −0.29% at master, not −0.45%, and no longer survives
   Holm: **not reproduced**, because the arm now rides on the code-3 coder. At
   code 4 it is −0.92%, not −0.90%: **drifted**. §13.2's rise off the floor
   holds at code 3 (+0.780, still excluding zero: **drifted**) and is gone at
   code 4, where code 4 − code 2 is −0.354 [−0.810, +0.081]: **not
   reproduced**, for the reason D3 adopted the window there. All four
   reproduce to the digit at v1.
3. **§13.5's seed readings reproduce.** Over the 54 results they were taken
   on, `arms --seed-sensitivity` reads 0.077 ΔE00, 4.8% of the width, 7
   interval and 10 Holm flips at 10,000 resamples, and 0.295, 15.5%, 26 and
   10 at 1,000 (`--resamples 1000`, which #130 added: until then that reading
   had no command). `--resample-change` reads 0.099, 7 flips and 6 guard
   changes. Over every result committed now (1,080 intervals) the 10,000
   reading is 0.077, 4.8%, 8 and 10; the eighth interval flip is
   `compact-retune-graphics`' `t0 L28@3 C5@3`, committed after §13.5 counted.

The readings above that the claims table does not hold, each with its status
and command. This table is unbound: `verify:experiments` does not recompute
the seed readings (20 seeds over every interval, at 10,000 resamples, is too
slow for a gate that runs on every push), and §11.14's two rows sat outside
#130's list; #168 has since re-recorded them in §11.14, where they are bound.
Each figure is the command's own output, read off it by hand.

| reading | § | as recorded | re-run | status | command |
|---|---|---|---|---|---|
| seed check at 1,000 resamples over the 54 results: largest bound move, largest move against its width, interval flips, Holm flips | 13.5 | 0.295 / 15.5% / 26 / 10 | 0.295 / 15.5% / 26 / 10 | reproduced | `arms --seed-sensitivity --resamples 1000 <the 54 results>` |
| seed check at 10,000 resamples over the 54 results, the same four | 13.5 | 0.077 / 4.8% / 7 / 10 | 0.077 / 4.8% / 7 / 10 | reproduced | `arms --seed-sensitivity <the 54 results>` |
| 1,000 → 10,000 resamples at seed 42 over the 54 results: largest bound move, interval flips, `guards (CI)` changes | 13.5 | 0.099 / 7 / 6 | 0.099 / 7 / 6 | reproduced | `arms --resample-change <the 54 results>` |
| seed check at 10,000 resamples over every committed result (1,080 intervals), the same four | — | — | 0.077 / 4.8% / 8 / 10 | not a recorded claim | `arms --seed-sensitivity` |
| `ChromaHash@411B` (code 3) mean ΔE00, `rd-budget` on tune2 | 11.14 | 7.783 | 7.313 (7.783 at v1) | re-recorded at v2 in §11.14 (#168) | `rd-budget --split tune2` |
| `ChromaHash@1623B` (code 4) mean ΔE00, `rd-budget` on tune2 | 11.14 | 6.768 | 6.642 (6.768 at v1) | re-recorded at v2 in §11.14 (#168) | `rd-budget --split tune2` |

**What the record now says.** The four master figures are not errors in the
sections that hold them: those tables record generation v1, and stay bound to
the v1 results. Each of those sections now says which of its rows are
generation v1 (§7.10, §13.1, §13.2), and so does every place that quotes them
as the current format's: `RATIONALE.md` and `spec/README.md` give the v2 CfL
figures beside the v1 ones, and `V0.8-DECISIONS.md` marks D3's and D7/D9's
prior evidence as generation v1, which is what those entries were decided on.
`verify:claims` binds each quoted v2 figure to its cell above. One table
outside #130's list moved the same way: §11.14's code-3 and code-4 rows, the
cross-format record, were generation v1 (ΔE00 7.783 → 7.313 at code 3, 6.768 →
6.642 at code 4 on the `rd-budget` re-run). #168 has since re-recorded that
table at v2: §11.14 now carries the re-run and keeps the v1 rows beside it.

**Per stratum.** Each comparison above, overall and in every holdout3 stratum
its re-run's images fall in, as the relative change in the comparison's own
metric: the ΔE00 comparisons, the spurious-detail ones (§12.2's −73%, §12.3's
−28% and §13.2's code 3 and code 4 − code 2, which the claims table quotes as
absolute differences) and the compact tier against ThumbHash
(`node tools/comparison/dist/reproduce.js --strata`, which measures the strata
off the fetched fixtures; unbound, because CI does not fetch the corpus). It
reads the committed re-runs under `results/reproductions/` with the strata
`stratify --strata` measures (`measured-strata.ts`) and resamples each stratum
as `stratify` does; `stratify` itself reads only top-level results, so it
cannot name a re-run. Three kinds of claim have no row: §13.1's ladder
figures are levels, not comparisons; §7.13's
three figures come from an `entropy-budget` record of the picks and summed
coded sizes, with no per-image series to split; and the §13.5 counts are
whole-sweep counts. On tune the strata gate nothing. A comparison is
**input-dependent** when its sign turns in some stratum, and **shown** to be
when that stratum's paired interval excludes zero on the other side; no later
entry may inherit an input-dependent comparison as a global gain.

| comparison | metric | overall | alpha | smartphone | skin | low-light | graphics | extreme-aspect | input-dependent |
|---|---|---|---|---|---|---|---|---|---|
| §11.3 `A28@3 L22@4 C3@3` − `SHIPPED A5@4 L20@5 C9@4` | ΔE00 | −17.10% | −17.10% (16) | — | — | — | — | — | no |
| §11.11 `A28@3 L22@4 C3@3 (t0 winner)` − `SHIPPED A5@4 L20@5 C9@4` | ΔE00 | −11.95% | −11.95% (16) | — | — | — | — | — | no |
| §11.10 `L19@4 C6@3  (§8.1 tune)` − `shipped shape L13@5 C6@4` | ΔE00 | −3.67% | — | −3.06% (4) | −5.01% (11) | −2.49% (9) | — | — | no |
| §11.10 `L16@4 C8@3` − `L19@4 C6@3  (§8.1 tune)` | ΔE00 | +0.72% | — | −0.58% (4) | +1.40% (11) | −0.54% (9) | — | — | sign turns |
| §11.10 `L19@4 C6@3  (§8.1 tune)` − `shipped shape L13@5 C6@4` | ΔE00 | −2.78% | −3.32% (1) | — | −3.32% (1) | −2.00% (1) | −2.78% (16) | −4.68% (1) | no |
| §11.12 `compact 21B L19@4 C6@3` − `compact 21B shipped shape` | ΔE00 | −2.78% | — | +0.80% (1) | −2.67% (16) | — | — | — | sign turns |
| §11.12 `ChromaHash@21B` − `ThumbHash` | ΔE00 | −5.16% | — | −8.66% (1) | −3.16% (16) | — | — | — | no |
| §7.11 `t1 interleaved, trunc 32 B` − `t0 native 32 B` | ΔE00 | +4.15% | — | +3.65% (4) | +3.14% (11) | +2.56% (9) | — | — | no |
| §7.11 `t1 interleaved, trunc 32 B` − `t1 seq, trunc 32 B` | ΔE00 | −4.97% | — | −4.88% (4) | −12.20% (11) | −5.52% (9) | — | — | no |
| §7.10 `32B paid cfl5 L24C9` − `32B shipped L26@5C9@4` | ΔE00 | +2.11% | — | +3.20% (4) | +1.43% (11) | +2.41% (9) | — | — | no |
| §7.10 `32B free cfl5 (34 B)` − `32B shipped L26@5C9@4` | ΔE00 | −0.10% | — | −0.13% (4) | −0.35% (11) | +0.22% (9) | — | — | sign turns |
| §7.10 `411B t2 free cfl5` − `411B t2 shipped` | ΔE00 | −0.29% | — | +0.46% (4) | −0.62% (11) | −1.18% (9) | — | — | sign turns |
| §7.10 `1623B t3 free cfl5` − `1623B t3 shipped` | ΔE00 | −0.92% | — | −1.16% (4) | −1.74% (11) | −1.76% (9) | — | — | no |
| §11.5 `aniso=0.9 hv=0.0` − `DEFAULT aniso=1.2 hv=0.15` | ΔE00 | −0.76% | — | +0.28% (4) | −1.00% (11) | −0.72% (9) | — | — | sign turns |
| §11.5 `aniso=1.2 hv=0.0` − `DEFAULT aniso=1.2 hv=0.15` | ΔE00 | −0.52% | — | +0.03% (4) | −0.64% (11) | −0.80% (9) | — | — | sign turns |
| §11.5 `aniso=1.2 hv=0.3` − `DEFAULT aniso=1.2 hv=0.15` | ΔE00 | +0.39% | — | +1.46% (4) | +0.36% (11) | +0.75% (9) | — | — | no |
| §12.2 `w_min 0.5 exp 2` − `shipped (no window)` | spurious | −73.04% | — | −72.46% (4) | −70.48% (11) | −76.45% (9) | — | — | no |
| §12.2 `w_min 0.85 exp 1` − `shipped (no window)` | ΔE00 | +0.33% | — | −0.14% (4) | +0.57% (11) | +0.12% (9) | — | — | sign turns |
| §12.3 `t2 w_min 0.85 exp 1` − `t2 shipped (no window)` | ΔE00 | +0.08% | — | −0.21% (4) | +0.20% (11) | +0.23% (9) | — | — | sign turns |
| §12.3 `t2 w_min 0.85 exp 1` − `t2 shipped (no window)` | spurious | −28.16% | — | −29.37% (4) | −25.42% (11) | −24.26% (9) | — | — | no |
| §13.2 `code 3 (411 B)` − `code 2 (108 B)` | spurious | +22.40% | — | +31.34% (4) | +11.29% (11) | +3.63% (9) | — | — | no |
| §13.2 `code 4 (1623 B)` − `code 2 (108 B)` | spurious | −10.18% | — | −12.37% (4) | −15.66% (11) | −27.18% (9) | — | — | no |

No comparison is shown to be input-dependent: no stratum of two or more images
has an interval wholly on the other side of its overall effect. Eight turn
sign in some stratum, six of them in the smartphone stratum alone (four
images on tune, one on tune2), and each is labelled input-dependent here:

- seven were never adopted, so nothing inherited them as a global gain: the
  §11.10 plateau's `L16@4 C8@3` against the leader (D8 kept the shipped
  code-0 layout), CfL given away free at codes 1 and 3 (D7 and D9 left CfL
  out of the format), both of §11.5's good-direction arms, and the window at
  codes 1 and 2 (D3 adopted it only at codes 3 and 4);
- one was adopted: the compact leader against the shipped shape on tune2,
  which turns on tune2's single smartphone photograph (+0.80%) and nowhere
  else. On tune and on the graphics split it holds its sign in every stratum.

The other figures the format adopted on this evidence (the alpha row at codes
1 and 2) and the costs that kept features out (the embedded-tier prefix and
paid CfL) hold their sign in every stratum. So do the compact tier's ΔE00 win
over ThumbHash on tune2, every spurious-detail cut the window makes (§12.2 at
code 1, §12.3 at code 2), and §13.2's two spurious-detail comparisons at
master: code 3 − code 2 rises and code 4 − code 2 falls in every stratum.
