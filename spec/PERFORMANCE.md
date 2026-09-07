# ChromaHash Performance

The compute workbench, sibling to [`EXPERIMENTS.md`](EXPERIMENTS.md) (quality)
and [`RATIONALE.md`](RATIONALE.md) (why the constants are what they are).

ChromaHash's value proposition is a three-way trade: **bytes × reconstruction
quality × time**. Until this document, the repo measured each axis well and
never together — `tools/comparison` owned quality and bytes, `tools/benchmark`
owned wall-clock, seven per-language harnesses owned batch throughput, and
nothing joined them. The cost of every encoder-only lever was unknown, the
dominant cost driver was never varied, and the shipped `simd` feature had never
been measured at all.

Numbers here are produced by `mise run benchmark` and `mise run benchmark:full`
(driver: `tools/comparison/src/perf/`). Each harness times its own loop
in-process, so no reported figure includes process startup, and the reported
cost of a cell is the **minimum** over its timed blocks — every source of error
in a wall-clock benchmark is one-sided, so the minimum is the sample least
contaminated by the host.

Every table below is bound to a cell in a committed run, and
`mise run verify:benchmark` checks each one. A figure that cannot be traced to a
cell cannot be published here.

> ### Measured 2026-09, except six cells
>
> **180 of this document's values are now checked against a committed run**, on
> an AMD Ryzen 7 7800X3D (16 threads, Linux), from a clean tree. Six are not,
> and they are named below rather than left for a reader to find.
>
> The previous revision carried `TBD` throughout, and the reason is worth
> keeping: the runs behind the revision before *that* were not reproducible. The
> committed baseline was a `bounded` sweep taken from a dirty tree while §2–§6
> quoted a `--full` sweep that was never committed, and checked cell by cell
> `verify:benchmark` found **50 disagreements in 89 values**, two tables with no
> measured cell at all, and six duplicate cell ids. That baseline was removed
> rather than corrected.
>
> Re-measuring is a deliberate act, on a host that can hold a clock still — and
> the host is part of the result, so it is stated. An Apple M3 Pro laptop was
> tried and **rejected**: the same cell across fresh processes spanned 34%, the
> host drifted ~25% over a few hours, and two independent full sweeps sharing 99
> cells disagreed by more than 10% on 22 of them. **The bar was applied again
> here before anything was published**: two independent bounded sweeps at the
> same commit share 100 cells and **not one disagrees by more than 10%** — the
> widest is 5.5%, and the driver flags a single cell as noisy
> (`batch/Kotlin/threads=auto`, a JVM thread-pool figure).
>
> **What is still missing, and the one command that closes it:**
>
> | Cells | Why |
> |---|---|
> | §2's tier-3 and tier-4 **encode** at 100×100 | the `bounded` matrix stops at tier 2 |
> | §3's **128×128 and 1024×1024** rows | `bounded` measures 64/100/256/512 |
> | §7 and §8's **Swift** rows | its binding consumes a UniFFI xcframework only `xcodebuild` can assemble, so it is empty on **every** run made off macOS — `ci-swift.yml` on `macos-latest` is where Swift is measured. These are marked *macOS only* rather than `TBD`: they are not pending anybody's run. |
>
> The first two groups need `mise run benchmark:full`, whose exhaustive matrix
> takes hours; the third cannot be produced on this platform at all.
>
> **`mise run verify:benchmark` therefore still fails**, on six placeholders and
> nothing else, so `ci-comparison.yml` keeps `continue-on-error`. Note what that
> means for the comment beside it, which says to remove the line "in the same
> change that commits the baseline": a Linux runner can never satisfy this gate
> while the Swift rows are bound, so the gate now reports an unreachable
> target's rows as **unavailable** rather than failed. Six cells short of green
> is a state worth naming; sixty-eight was not.
>
> To fill the rest in:
>
>
> ```bash
> mise run benchmark          # -> tools/comparison/output/perf/perf.json
> mise run benchmark:full     # -> tools/comparison/output/perf/perf-full.json
> cp tools/comparison/output/perf/perf.json      tools/comparison/baselines/perf-report.json
> cp tools/comparison/output/perf/perf-full.json tools/comparison/baselines/perf-report-full.json
> mise run verify:benchmark -- --fix   # rewrites every TBD from the runs
> mise run verify:benchmark            # must pass
> ```
>
> The two `cp` lines **rename** as they copy, and that is not cosmetic: the gate
> reads `baselines/perf-report-full.json` then `baselines/perf-report.json` and
> ignores anything else in the directory (`verify-benchmark.ts`). This block used
> to say `cp …/perf*.json tools/comparison/baselines/`, which lands the files
> under their output names, leaves the gate reading nothing, and reports the
> document as unmeasured with no hint as to why. `TESTING.md` had it right.
>
> Run it on a quiet machine, from a clean tree — the driver records
> `git.dirty`, and the gate fails on a run that cannot be traced to a revision.
> §1 is the exception: it comes from `mise run benchmark:stages`, which commits
> no artifact, so its column must be filled by hand and is not gated.

---

## 1. The headline: where encode time goes

`mise run benchmark:stages`, gradient source, share of one encode. The
instrumented build asserts it still produces the shipped bytes before reporting
anything.

> Bound, as of this revision. `benchmark:stages` now writes
> `baselines/perf-stages.json` and `verify:benchmark` checks every cell here
> against it. It had been the one table nothing checked, which was the worst
> possible one to leave open: §10's whole ordering rests on it.

| stage | 100×100 t1 | 512×512 t1 | 512×512 t4 |
|---|---:|---:|---:|
| `eotf_lut` | 0.6% | 0.0% | 0.0% |
| `linearize` | 0.6% | 5.4% | 0.2% |
| `oklab_forward` | 2.4% | 6.9% | 0.2% |
| `alpha_average` | 0.2% | 0.4% | 0.0% |
| `composite` | 0.4% | 4.2% | 0.1% |
| `selection` | 0.5% | 0.0% | 0.1% |
| `cos_tables` | 0.3% | 0.1% | 0.0% |
| **`dct_forward`** | 57.4% | 79.1% | 96.9% |
| `quantize_and_pack` | 37.5% | 3.9% | 2.5% |
| total | 2.81 ms | 47.25 ms | 1835.17 ms |

**The forward DCT is the encoder, above thumbnail size.** 57% of a 100×100
encode, 79% at 512×512, and **97%** at 512×512 tier 4 — the share rises with both
size and tier. That is what orders §10: a lever that does not touch
`dct_encode_selected` cannot be worth much at any size a caller actually
encodes, however elegant.

**Two qualifications the measured table adds**, and an earlier revision of this
paragraph asserted past both by calling every other stage "a rounding error at
any size or tier that matters":

* **At 100×100, `quantize_and_pack` is 37.5%** — the scale and AC code searches,
  not a rounding error at all. That is exactly the trap §4 documents, and it is
  why the encoder-only levers look decisive on a thumbnail and vanish on a
  photograph.
* **At 512×512 the per-pixel colour pipeline is 16.5%** — `linearize` 5.4%,
  `oklab_forward` 6.9%, `composite` 4.2%. Only the middle one has a SIMD
  backend, which bounds what §5 can buy before §5 is measured at all: the
  `simd` feature covers 6.9 points of a 100-point budget at the size a caller
  most often encodes.

## 2. Cost per tier

100×100 sRGB gradient — the fixture the old benchmark used exclusively.

| tier | bytes | encode | decode |
|---|---:|---:|---:|
| 0 (compact) | 21 | 1.41 ms | 0.28 ms |
| 1 (default) | 32 | 2.46 ms | 0.31 ms |
| 2 | 108 | 7.10 ms | 1.26 ms |
| 3 | 411 | TBD ms | 15.42 ms |
| 4 | 1623 | TBD ms | 233.80 ms |

Decode grows roughly `4^level`, as `4^level` coefficients over a `4^level`
raster predicts. A tier-4 decode is the most expensive single operation the
format asks for, and it is asked for to render a placeholder.

### Capped decode is the mitigation, and it is undocumented as such

Rust decode, natural against capped to 32×32:

| tier | natural | capped 32×32 | saving |
|---|---:|---:|---:|
| 0 | 280 µs | 279 µs | 1.00× |
| 1 | 315 µs | 316 µs | 1.00× |
| 2 | 1261 µs | 528 µs | 2.39× |
| 3 | 15415 µs | 1571 µs | 9.81× |
| 4 | 233797 µs | 4952 µs | 47.22× |

Decode is linear in rendered pixels, so capping harder pays more still. The
saving is nil at the low tiers, whose natural raster is already at or below the
cap, and largest at tier 4.

The residual matters though: `K` does not shrink with the cap, so a capped
tier-4 decode still costs far more than a natural tier-1 one. **Tier choice, not
cap choice, is the dominant decode lever.**

## 3. Encode scales linearly in source pixels

There is no downsample: `dct_encode_selected` runs over the full source, so
encode is `O(K·W·H)`. Tier 1, gradient:

| source | encode | per megapixel |
|---|---:|---:|
| 64×64 | 1.57 ms | 0.38 ms |
| 100×100 | 2.46 ms | 0.25 ms |
| 128×128 | TBD ms | TBD ms |
| 256×256 | 12.32 ms | 0.19 ms |
| 512×512 | 46.74 ms | 0.18 ms |
| 1024×1024 | TBD ms | TBD ms |

The per-megapixel column falls as the source grows and then flattens, which is
fixed per-call overhead amortising; the flattened value is the marginal cost,
and extrapolating a 12 MP photo from it is the number that matters to a caller
encoding originals. The old benchmark never varied this axis — it measured
100×100 and nothing else — which is why the cost of the format's most common
real input was invisible.

## 4. The encoder-only levers, priced

Zero wire cost, decoder untouched, bytes unchanged. 100×100, tier 1. Quality
deltas are from [`EXPERIMENTS.md`](EXPERIMENTS.md) §4.4; the time column is new.

| lever | encode | vs shipped | ΔE00 @32 B |
|---|---:|---:|---|
| shipped | 2.45 ms | — | 10.390 |
| scale_fit=0 | 1.56 ms | -36.3% | — |
| scale_fit=1 | 1.55 ms | -36.6% | 10.381 |
| ac_nearest=0 | 1.73 ms | -29.2% | 10.392 |
| dc_search=0 | 2.44 ms | -0.2% | — |
| no encoder search | 1.54 ms | -37.2% | 10.434 |
| refine_passes=1 | 20.27 ms | 728.6% | — |
| refine_passes=2 | 37.42 ms | 1430.0% | — |

`EXPERIMENTS.md` §10 adopts `ac_nearest` "because it is **free** and principled".
It is free in *bits*. Nothing in the repo could price it in *time*, so the claim
went unchallenged for a release — and whatever it costs, it buys a ΔE00
improvement of 0.05%, at or below the noise floor of the metric.

`scale_fit=2` is the shipped mode, adopted for its −1.78% at 411 B. At the
default tier EXPERIMENTS' own table has mode 1 *ahead* of it, 10.381 to 10.392,
so if mode 2 also costs more time here, it is losing on both axes at the tier
most callers use. A per-tier policy is an informed option rather than a guess.

**But this is a 100×100 result, and it does not generalise.** The same arms at
two more sizes:

| lever | 100×100 | 256×256 | 512×512 |
|---|---:|---:|---:|
| shipped | 2.45 ms | 12.31 ms | 46.70 ms |
| scale_fit=0 | 1.56 ms | 11.44 ms | 45.83 ms |
| scale_fit=1 | 1.55 ms | 11.39 ms | 45.86 ms |
| ac_nearest=0 | 1.73 ms | 11.61 ms | 45.91 ms |
| dc_search=0 | 2.44 ms | 12.31 ms | 46.57 ms |
| no encoder search | 1.54 ms | 11.40 ms | 45.67 ms |
| refine_passes=1 | 20.27 ms | 127.28 ms | 504.47 ms |
| refine_passes=2 | 37.42 ms | 240.21 ms | 976.18 ms |

This is §1 restated: the searches live in `quantize_and_pack`, and can only ever
be worth what that stage is worth — which collapses as the source grows and the
DCT takes over. **The encoder-only levers are a thumbnail-sized concern.** Any
decision to drop them should be scoped to small inputs, which is the opposite of
what the 100×100 column alone implies.

`refine_passes` is measured here against EXPERIMENTS' "~54× encode time". Both
may be right — that figure was measured with the full REFINE stack
(`refine_grid`, `refine_obj=3`, `refine_dc`, `refine_scale`), not the bare pass
count — but any discrepancy is flagged rather than smoothed over.

## 5. What the `simd` feature buys

Default build vs `--no-default-features`, both byte-identical:

| source | tier | SIMD | scalar | gain |
|---|---|---:|---:|---:|
| 100×100 | 1 | 2.46 ms | 2.52 ms | 1.02× |
| 256×256 | 1 | 12.32 ms | 12.61 ms | 1.02× |
| 512×512 | 1 | 46.74 ms | 47.63 ms | 1.02× |
| 512×512 | 0 | 29.19 ms | 30.13 ms | 1.03× |

**2%, and flat across every size measured.** `src/simd/` is four hand-written
backends (AVX2, SSE2, NEON, wasm simd128), a `simd-diff-tests` feature that
fails rather than skips, and a QEMU/wasmtime emulation matrix in CI. It covers
exactly one of the pipeline's nine stages — `oklab_forward` — and §1 now prices
that stage at **6.9%** of a 512×512 encode. So the ceiling was 6.9%, the
measured gain is 2%, and the backends are capturing roughly a third of the one
stage they touch.

The flatness across 100×100 → 512×512 is the tell that this is a stage-share
result and not a vectorisation-width result: if the win scaled with anything
except that share, three sizes spanning 26× the pixels would not all land on
1.02×.

This is not an argument for deleting it: it is byte-exact, costs no dependency,
and matters more on decode-light workloads. It *is* an argument that the next
optimisation should go where §1 says the time is — and §12 is that list.

## 6. Separable forward DCT, prototyped

Since §1 puts the DCT at the overwhelming majority of encode, it is the only
lever whose size justifies a prototype. `dct_encode_selected` evaluates a full
2-D sum per coefficient (`K·W·H`); most selected pairs share an `x` frequency,
so the sum factors into one row pass per distinct `cx` plus a length-`H` column
reduction per coefficient. Saving ≈ `K / Cx`, and `K` grows by `4^level` while
`Cx` grows by `2^level` — so the saving should *grow* with size and tier, which
is what three points can show and two cannot.

Behind `Tunables::dct_separable` (off by default, exposed by no binding):

| source | tier 1 direct | separable | speedup |
|---|---:|---:|---:|
| 100×100 | 2.45 ms | 1.19 ms | 2.05× |
| 256×256 | 12.31 ms | 3.85 ms | 3.20× |
| 512×512 | 46.70 ms | 12.68 ms | 3.68× |

**The prediction holds, and this is the largest lever in the document.** The
saving grows with size exactly as the `K / Cx` argument says it should —
2.05× → 3.20× → 3.68×. At 512×512 it takes **34.0 ms off an encode where the
`simd` feature takes 0.9 ms**: 38× the absolute saving, on the stage §1 prices
at 79% of the work rather than on the 6.9% stage `simd` covers.

That it is also the only *large* lever requiring a format change is the tension
§12 exists to lay out. Stated precisely, because the temptation is to overstate
it: **the only byte-identical speedup this document has measured is 2%, and the
only large one measured at all costs a version bump.** §12.1 lists seven
byte-identical candidates that are located and sized but not built, so what is
missing is a measurement of them, not an argument for them.

**On byte-identity, precisely.** Reassociating floating-point addition is not
guaranteed to preserve quantized codes. Over 40 encodings spanning all five
tiers and three content classes, none changed. That is evidence, not proof — and
it does not make adoption free: §10 and §12.6 of the spec pin the direct
summation as normative, so another implementation could diverge where this one
happened not to. Adopting it is a format change: version bump, regenerated
vectors, every language landing together.

## 7. Cross-language, with startup removed

In-process, spawn excluded, 100×100 tier 1. The old harness's "single" column
measured process startup; these are the operations.

| implementation | encode t0 | encode t1 | encode t2 | decode t1 | decode t2 |
|---|---:|---:|---:|---:|---:|
| Rust | 1407 µs | 2461 µs | 7100 µs | 315 µs | 1261 µs |
| Rust (scalar) | 1466 µs | 2518 µs | 7184 µs | 324 µs | 1254 µs |
| Go | 1410 µs | 2456 µs | 7093 µs | 320 µs | 1279 µs |
| C# | 1411 µs | 2453 µs | 7070 µs | 323 µs | 1283 µs |
| Kotlin | 1499 µs | 2558 µs | 7170 µs | 330 µs | 1316 µs |
| Swift | *macOS only* | *macOS only* | *macOS only* | *macOS only* | *macOS only* |
| Python | 6643 µs | 7729 µs | 12600 µs | 344 µs | 1334 µs |
| TypeScript (wasm) | 1053 µs | 1649 µs | 4617 µs | 398 µs | 1761 µs |
| TypeScript (pure) | — | — | — | 1536 µs | 17442 µs |

Every row is a thin binding over the same Rust core, so a row that differs from
Rust by more than the FFI boundary costs is worth explaining rather than
reporting.

**Swift is measured.** The previous revision recorded it as unavailable, which
was a property of the measuring host rather than of the code: the binding
consumes a UniFFI xcframework that only `xcodebuild` can assemble, so the row is
empty on any run made off macOS. The bench contract is implemented, and on macOS
it produces byte-identical hashes to Rust at all five tiers. A run made off
macOS records Swift under `unavailable` with a reason; do not read an empty
Swift row as a Swift result.

**FFI cost is the buffer copy, not the transition.** The asymmetry to look for is
directional: encode passes 40 KB of RGBA in for 32 bytes out, decode passes 32
bytes in for ~4 KB out, so a binding's encode overhead should exceed its decode
overhead. In the batch path, where one call carries 200 images, the per-call
cost amortises away entirely (§8).

For scale, the numbers this table replaces: the old harness reported Kotlin
encode at 426 ms and C# at 27.8 ms. Those were JVM and .NET cold start,
published as though they were the algorithm.

> **On the managed runtimes.** An earlier revision marked the Kotlin and C# rows
> untrustworthy, on the grounds that neither was monotonic in tier. Half that
> evidence was wrong: in the run it cited, Kotlin's encode *was* monotonic
> (1767 / 5988 / 7841 µs at t0/t1/t2). The C# observation was real — a tier-0
> decode slower than its tier-1 — but the cause was the harness, not the
> runtime: the calibration pilot ran cold and with no warmup, so a managed cell
> was sized from a JIT-dominated sample and could end up timing as few as two
> iterations against a 200 ms target. That is fixed; the pilot now carries the
> measured run's warmup and re-sizes from its own median. Re-measured with it,
> both runtimes came back monotonic and within a few percent of Rust.

## 8. Batch throughput is not per-op cost

`bench-batch`, 200 images, 100×100 tier 1, reported per batch and divided:

| implementation | 1 thread | auto | scaling |
|---|---:|---:|---:|
| Rust | 2445 µs | 207 µs | 11.80× |
| Rust (scalar) | 2521 µs | 213 µs | 11.83× |
| Go | 2463 µs | 205 µs | 12.02× |
| C# | 2453 µs | 209 µs | 11.72× |
| Kotlin | 2538 µs | 278 µs | 9.14× |
| Swift | *macOS only* | *macOS only* | *macOS only* |
| TypeScript (wasm) | 1655 µs | — (serial) | — |
| Python | 7815 µs | — (serial, GIL) | — |

The serial figures should match single-image encode.

Rust, Go, C#, Kotlin and Swift are all thin bindings over the same native
`BatchEncoder`, so the algorithm is not the variable: a row that scales
materially worse than its siblings is a fact about that binding's dispatch, and
worth chasing. An earlier revision reported Kotlin at 2.4× against ~11.6× for
the others and recommended investigating on that basis; that figure came from a
cell flagged noisy at 34.7% IQR, and re-measurement did not reproduce the gap at
anything like that size. Batch cells are also not iteration-calibrated — one
block is one 200-image batch — so they carry more variance than the per-op
tables and should be read with that in mind.

The old benchmark's "bulk per-op" column was wall-clock ÷ count on a parallel
encoder, printed in the same table as GIL-bound Python — comparing threading
models, not algorithms. This document keeps **serial CPU-time per op**
(algorithmic cost) and **batch throughput** (machine-scaled) apart, always.

## 9. Pure-TypeScript decode: the trade, finally priced

`typescript/src/decode.ts` is an 818-line hand-maintained algorithm port whose
sole justification is skipping the `.wasm` fetch and instantiate. It had never
been benchmarked. Its steady-state decode cost is the `TypeScript (pure)` row of
§7; the WebAssembly path is the `TypeScript (wasm)` row directly above it.

The trade is a fixed saving against a per-decode cost: skipping instantiation
saves the module's one-time cost, after which every decode is slower. Dividing
one by the other gives the break-even count, below which the pure path wins a
page's first paint and above which WebAssembly wins outright. In a browser the
module arrives over the network rather than from a local file, so the measured
instantiation saving is a floor and the real break-even is higher — the module
earns its keep, but by a narrower margin than "skip the wasm" suggests.

> The cold-start half of this trade is a wall-clock measurement of module
> instantiation, which the perf driver does not measure and no committed run
> contains. It is not gated.

---

## 10. Where to spend effort next

Ordered by measured size, not by appeal. §12 is the same ordering taken down to
file and line, with each entry tagged by whether it moves a byte.

1. **The forward-DCT inner loop.** §1 puts it at 79% of a 512×512 encode and 97%
   at tier 4, so it is the only place where a large win is available at all, and
   the byte-safe half of it needs no format change.
2. **Adopt the separable transform** (§6) — **3.68× at 512×512**, now measured,
   growing with size as its own `K / Cx` argument predicts. It is the largest
   lever in this document by an order of magnitude, and it costs a format
   version. Worth deciding deliberately rather than by default.
3. **Reconsider `ac_nearest` and per-tier `scale_fit`** (§4), for small inputs
   only. Their quality effects are at or below the noise floor at the default
   tier, and their time cost vanishes at photo resolution.
4. **SIMD in decode** — there is none. `decode.rs` runs a scalar per-pixel OKLAB
   inverse plus three gamma lookups inside the `O(w·h·K)` render loop, and at
   tier 4 decode is the more expensive half (§2).
5. **A batch decode API** — none exists in any implementation, so every bulk
   decode is a serial loop.
6. **Document the tier-4 cost.** §2 prices it; it is defensible for an archival
   tier and indefensible as a surprise.

## 11. Corrections to published claims

`spec/README.md` §14 and `README.md` both carried performance figures that no
harness verified and no gate protected:

- decode "~36 µs native"
- encode "~400 ms for 12 MP"
- "the v0.6 DC search adds ~10 µs — negligible"

The first two are wrong by a large factor. That the DC-search line is still
right while the other two are not dates the table to the **v0.6** era: v0.7
raised the default coefficient counts and adopted the encoder searches §4
prices. They were never re-measured because nothing measured them.

Both files now state what follows from the algorithm — encode is `O(K·W·H)` over
the full source, decode is `O(w·h·K)` rising ~16× per tier level — and point
here for the figures rather than restating any. Replacing one untraceable number
with another would repeat the mistake; §2 and §3 carry the measurements once a
re-measurement fills them in.

`mise run verify:benchmark` now checks this document against the committed runs
— a task that this section previously claimed existed before it did, which is
how the drift it was supposed to catch went unnoticed. It does not read
`README.md` or `spec/README.md`, which is why those two are kept free of figures
rather than gated.

**`BENCHMARK.md` was the third file, and was missed.** It published a full
seven-language encode/decode table attributed to an Apple M3 Pro, with a "single"
column that timed process startup — the Kotlin and C# cells §7 cites. Nothing
referenced it: no generator wired to a task, no gate, and no link from anywhere
in the repo, which is why fencing `README.md` and `spec/README.md` did not reach
it. It is now a pointer to this document, linked from the root `README.md` so it
has an inbound reference, and `tools/benchmark/README.md` no longer tells the
reader that `mise run benchmark` regenerates it.

---

## 12. Where v0.8 can accelerate, and what each costs

§10 orders the levers. This is the same list at file-and-line resolution, with
the one attribute that decides which release a lever belongs to: **whether it
changes a byte.** A change that provably cannot alter the output is a patch
release; one that reassociates a float sum or moves a coefficient is a format
version, a regenerated vector set, and nine languages landing together.

The measured context, from §1 and §5: the forward DCT is **79%** of a 512×512
encode and **97%** at tier 4; `quantize_and_pack` is **37.5%** of a 100×100 one;
the per-pixel colour pipeline is **16.5%** at 512×512; and the shipped `simd`
feature buys **1.02×** because it covers 6.9 of those points.

### 12.1 Byte-identical — legal in a patch release

Each of these produces the same bytes by construction, so `spec/test-vectors/`
and `mise run rd:gate` are sufficient evidence, and no version moves.

| # | Where | What | Why it is safe |
|---|---|---|---|
| 1 | `mulaw.rs:41` ← `encode.rs:561` | **Precompute the dequantization table.** `mu_law_dequantize(index, bits, mu)` is a pure function of at most 2^bits − 1 ≤ 31 indices, and `bits`/`mu` are fixed for a channel — yet `scale_fit=2` calls it inside a 63-code search over every coefficient, each call a `portable_pow` = a 20-term series plus a degree-25 Taylor polynomial. Build a ≤32-entry table per `AcQuantJob`. | The table holds the same values the calls return |
| 2 | `mulaw.rs:7`, `encode.rs:469,481` | **Hoist the loop-invariants.** `mu_compress` recomputes `portable_ln(1.0 + mu)` on every quantize call for a constant `mu`; `bits_at`/`gain_at` walk the tier list per index per call. | Same values, computed once |
| 3 | `dct.rs:227` | **Vectorize across coefficients, not pixels.** The inner sum must keep its exact left-to-right order, which is why `simd/mod.rs` never touched it. Lanes over *distinct `(cx, cy)` pairs* preserve each coefficient's own order and are as parallel as the per-pixel case. | Per-lane arithmetic is unchanged; only which coefficient a lane holds |
| 4 | `decode.rs:372`, `dct.rs:265` | **Flatten `cos_x`/`cos_y`.** They are `Vec<Vec<f64>>`, a pointer chase per coefficient per pixel in the `O(w·h·K)` render loop. A strided `Vec<f64>` removes it. And there is **no SIMD in decode at all** — a scalar per-pixel OKLAB inverse plus three gamma lookups — while §2 puts tier-4 decode at 234 ms, the most expensive operation the format asks for. | A layout change reads the same values |
| 5 | `encode.rs:736` | **Early-exit `sse_with_delta`.** `acc` accumulates monotonically and the caller keeps only strict improvements, so it can abort the moment `acc >= best`. Off by default (`refine_passes: 0`) but §4 measures refinement at **20–37 ms against 2.45 ms shipped**, and it is what the `refine-*` sweeps spend their time in. | Changes when the loop stops, never which code wins |
| 6 | `encode.rs:224,240,263` | **Fuse the per-pixel passes.** Four full `W·H` passes and five allocations — ~10 MB of f64 traffic at 512×512 — for a stage §1 prices at 16.5%. `linearize` and `composite` fuse; `alpha_average` is a reduction and must stay in scalar pixel order. | Elementwise work, unchanged order |
| 7 | `bitpack.rs:3` | **Word-at-a-time bit writing**, against the current divide-and-modulo per bit. Correct and genuinely small — ≤1623 bytes — and listed for completeness rather than for its size. | Same bits |

Items 1 and 2 are the ones worth doing first, and not because they are the
largest: they are in `quantize_and_pack`, which is **37.5% of a thumbnail
encode** and 3.9% of a photograph. That is the shape §4 already documents for
the encoder-only *quality* levers, and it applies to their cost too.

### 12.2 Format changes — v0.8 work

| # | Where | What | What it costs |
|---|---|---|---|
| 8 | `dct.rs:296` | **Adopt the separable forward DCT.** §6 measures **3.68× at 512×512**, growing with size. Prototyped, and byte-identical over 40 encodings spanning five tiers and three content classes. | Reassociating float addition is not *guaranteed* to preserve quantized codes, and spec §10/§12.6 pin the direct summation as normative. Version bump, regenerated vectors, nine languages together |
| 9 | `encode.rs:1044` | **Downsample before the transform.** There is none: `dct_encode_selected` runs over the full source, so encode is `O(K·W·H)` in the *original's* pixels — 46.7 ms for one 512×512 image, and §3's per-megapixel column is what a caller encoding 12 MP originals actually pays. `refine_grid`/`resample_channel_dct` (`encode.rs:806`) already gesture at the machinery | Changes the coefficients, so it changes every hash |

### 12.3 What this list does not claim

* **No entry here is measured as an implemented speedup** except #8, which is
  prototyped behind `Tunables::dct_separable`. The others are located and sized
  from §1's stage shares, not from a build that has them. A stage share bounds a
  lever; it does not deliver one.
* **The byte-identical column is an argument, not a proof.** Each entry states
  why the output cannot move, and each would still ship behind the full vector
  set across nine languages plus `rd:gate` at 0.00% drift, because "cannot move"
  and "did not move" are different claims and this repo has a gate for the
  second one.
* **Decode is under-measured relative to its cost.** §2 prices tier-4 decode at
  234 ms — the single most expensive operation the format performs — and §1's
  stage breakdown covers *encode* only. There is no decode equivalent, so item 4
  is sized by reading `decode.rs`, not by measurement. That is the largest gap
  in this document that a run could close.
