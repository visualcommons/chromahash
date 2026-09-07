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

> ### ⚠ Numbers pending re-measurement
>
> The tables carry `TBD` placeholders. The runs that backed the previous
> revision of this document were not reproducible: the committed baseline was a
> `bounded` sweep taken from a dirty tree, while §2, §3, §4, §5 and §6 quoted a
> `--full` sweep that was never committed. Checked cell by cell,
> `verify:benchmark` found **50 disagreements in 89 values**, two tables with no
> measured cell at all, and six duplicate cell ids in the baseline. That baseline
> has been removed rather than left in place: the gate rejected it on three
> counts at once, and it was the source the repo's user-facing performance
> claims had been quietly reading from.
>
> **`mise run verify:benchmark` therefore fails, by design, until a
> re-measurement lands** — a placeholder is a bound cell with no number, and it
> always fails. The `ci-comparison.yml` job carrying it is red on `master` for
> the same reason. That is the gap made visible, not a regression to bisect:
> a green gate here would mean the document had stopped asking for the numbers
> it does not have.
>
> Re-measuring is a deliberate act, on a host that can hold a clock still. An
> Apple M3 Pro laptop was tried and rejected: the same cell measured across
> fresh processes spanned **34%**, and the host drifted **~25% over a few
> hours**. Across two independent full sweeps sharing 99 cells, 22 still
> disagreed by more than 10%.
>
> To fill this document in:
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

> Not covered by `verify:benchmark`: `benchmark:stages` writes no committed
> artifact, so this table is transcribed by hand. That is a remaining gap.

| stage | 100×100 t1 | 512×512 t1 | 512×512 t4 |
|---|---:|---:|---:|
| `eotf_lut` | TBD% | TBD% | TBD% |
| `linearize` | TBD% | TBD% | TBD% |
| `oklab_forward` | TBD% | TBD% | TBD% |
| `alpha_average` | TBD% | TBD% | TBD% |
| `composite` | TBD% | TBD% | TBD% |
| `selection` | TBD% | TBD% | TBD% |
| `cos_tables` | TBD% | TBD% | TBD% |
| **`dct_forward`** | TBD% | TBD% | TBD% |
| `quantize_and_pack` | TBD% | TBD% | TBD% |
| total | TBD ms | TBD ms | TBD ms |

**The forward DCT is the encoder.** Every other stage is a rounding error at any
size or tier that matters, and the share rises with both. That single fact is
what orders §10: a lever that does not touch `dct_encode_selected` cannot be
worth much, however elegant.

The one place the other stages matter is small images, where
`quantize_and_pack`'s searches are a large enough share to be worth measuring —
which is exactly the trap §4 documents.

## 2. Cost per tier

100×100 sRGB gradient — the fixture the old benchmark used exclusively.

| tier | bytes | encode | decode |
|---|---:|---:|---:|
| 0 (compact) | 21 | TBD ms | TBD ms |
| 1 (default) | 32 | TBD ms | TBD ms |
| 2 | 108 | TBD ms | TBD ms |
| 3 | 411 | TBD ms | TBD ms |
| 4 | 1623 | TBD ms | TBD ms |

Decode grows roughly `4^level`, as `4^level` coefficients over a `4^level`
raster predicts. A tier-4 decode is the most expensive single operation the
format asks for, and it is asked for to render a placeholder.

### Capped decode is the mitigation, and it is undocumented as such

Rust decode, natural against capped to 32×32:

| tier | natural | capped 32×32 | saving |
|---|---:|---:|---:|
| 0 | TBD µs | TBD µs | TBD× |
| 1 | TBD µs | TBD µs | TBD× |
| 2 | TBD µs | TBD µs | TBD× |
| 3 | TBD µs | TBD µs | TBD× |
| 4 | TBD µs | TBD µs | TBD× |

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
| 64×64 | TBD ms | TBD ms |
| 100×100 | TBD ms | TBD ms |
| 128×128 | TBD ms | TBD ms |
| 256×256 | TBD ms | TBD ms |
| 512×512 | TBD ms | TBD ms |
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
| shipped | TBD ms | — | 10.390 |
| scale_fit=0 | TBD ms | TBD% | — |
| scale_fit=1 | TBD ms | TBD% | 10.381 |
| ac_nearest=0 | TBD ms | TBD% | 10.392 |
| dc_search=0 | TBD ms | TBD% | — |
| no encoder search | TBD ms | TBD% | 10.434 |
| refine_passes=1 | TBD ms | TBD% | — |
| refine_passes=2 | TBD ms | TBD% | — |

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
| shipped | TBD ms | TBD ms | TBD ms |
| scale_fit=0 | TBD ms | TBD ms | TBD ms |
| scale_fit=1 | TBD ms | TBD ms | TBD ms |
| ac_nearest=0 | TBD ms | TBD ms | TBD ms |
| dc_search=0 | TBD ms | TBD ms | TBD ms |
| no encoder search | TBD ms | TBD ms | TBD ms |
| refine_passes=1 | TBD ms | TBD ms | TBD ms |
| refine_passes=2 | TBD ms | TBD ms | TBD ms |

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
| 100×100 | 1 | TBD ms | TBD ms | TBD× |
| 256×256 | 1 | TBD ms | TBD ms | TBD× |
| 512×512 | 1 | TBD ms | TBD ms | TBD× |
| 512×512 | 0 | TBD ms | TBD ms | TBD× |

`src/simd/` is four hand-written backends (AVX2, SSE2, NEON, wasm simd128), a
dedicated `simd-diff-tests` feature that fails rather than skips, and a
QEMU/wasmtime emulation matrix in CI. It covers exactly one of the pipeline's
nine stages — `oklab_forward`, which §1 shows is a small share of encode — so
its ceiling was never more than that share.

This is not an argument for deleting it: it is byte-exact, costs no dependency,
and matters more on decode-light workloads. It *is* an argument that the next
optimisation should go where §1 says the time is.

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
| 100×100 | TBD ms | TBD ms | TBD× |
| 256×256 | TBD ms | TBD ms | TBD× |
| 512×512 | TBD ms | TBD ms | TBD× |

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
| Rust | TBD µs | TBD µs | TBD µs | TBD µs | TBD µs |
| Rust (scalar) | TBD µs | TBD µs | TBD µs | TBD µs | TBD µs |
| Go | TBD µs | TBD µs | TBD µs | TBD µs | TBD µs |
| C# | TBD µs | TBD µs | TBD µs | TBD µs | TBD µs |
| Kotlin | TBD µs | TBD µs | TBD µs | TBD µs | TBD µs |
| Swift | TBD µs | TBD µs | TBD µs | TBD µs | TBD µs |
| Python | TBD µs | TBD µs | TBD µs | TBD µs | TBD µs |
| TypeScript (wasm) | TBD µs | TBD µs | TBD µs | TBD µs | TBD µs |
| TypeScript (pure) | — | — | — | TBD µs | TBD µs |

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
| Rust | TBD µs | TBD µs | TBD× |
| Rust (scalar) | TBD µs | TBD µs | TBD× |
| Go | TBD µs | TBD µs | TBD× |
| C# | TBD µs | TBD µs | TBD× |
| Kotlin | TBD µs | TBD µs | TBD× |
| Swift | TBD µs | TBD µs | TBD× |
| TypeScript (wasm) | TBD µs | — (serial) | — |
| Python | TBD µs | — (serial, GIL) | — |

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

Ordered by measured size, not by appeal:

1. **The forward-DCT inner loop.** §1 puts it at the overwhelming majority of
   encode at every size and tier that matters, so it is the only place where a
   large win is available at all, and it needs no format change.
2. **Adopt the separable transform** (§6) — prototyped and byte-identical over
   40 encodings, but its speedup is still unmeasured here and it costs a format
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
