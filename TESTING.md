# Testing Methodology

Complete testing procedure for the ChromaHash monorepo. Run this after any change to be confident all implementations are correct and in sync.

See [README.md](README.md) for setup and prerequisites (mise, hk, per-language dependencies).

---

## Quick Check (run after every change)

```bash
mise run test
```

This runs every language's test suite: the Rust core, the C / WASM / UniFFI
binding crates, and the TypeScript, JVM (Java/Kotlin), Swift, Go, Python and C#
packages over them — ten test surfaces in all, plus the two helper crates under
`tools/`. (The README counts *nine* implementations: the three binding crates
are one FFI layer with three shapes, and WASM is not a package anyone consumes
directly.) If it passes, every language agrees on all golden test vectors.

On a non-macOS host `test-swift` skips (SwiftPM consumes an xcframework, which
only `xcodebuild` can assemble) and says so rather than passing silently;
`ci-swift.yml` on `macos-latest` is the enforcing gate for it.

---

## Full Verification (run before pushing)

Run these in order. Each step must pass before proceeding.

### Step 1: Validate spec constants

```bash
mise run validate:spec
```

`spec/validate.py` is an **independent** Python reference, not a wrapper over the
Rust crate: it re-derives every M1 matrix from the gamut chromaticity coordinates
and checks them against `constants.py`, then checks matrix inverses, white-point
mapping, OKLAB bounds, µ-law round-trips, the tier tables and byte lengths, and
the aspect encoding. It also replays `unit-aspect.json` (45 cases) and
`unit-selection.json` (488 cases) against its own implementation, which is the
one place the golden vectors are checked by something that did not produce them.
174 assertions; exit code 0 = pass.

### Step 2: Check the manifest versions agree

```bash
mise run check:versions
```

Every publishable manifest must carry the core crate's version. Each
`release-*.yml` verifies the pushed tag against *its own* manifest, so one stale
file does not fail loudly — it fails that single pipeline, leaving one registry a
version behind while the others publish.

### Step 3: Format check

```bash
mise run format:check
```

Checks formatting across all implementations without modifying files. If this fails, run `mise run format:fix` and re-check.

### Step 4: Lint

```bash
mise run lint
```

Runs linters across all implementations. If this fails, run `mise run lint:fix` for auto-fixable issues.

### Step 5: Build

```bash
mise run build
```

Compiles every implementation and helper crate. Catches type errors, missing imports, and compilation issues that tests alone might not surface (e.g., TypeScript type checking).

### Step 6: Test all implementations

```bash
mise run test
```

Runs the full test suite for each language. All implementations load the same golden test vectors from `spec/test-vectors/` and must produce identical results.

### Step 7: (If test vectors changed) Regenerate and re-test

If you modified encoding/decoding logic in Rust (the reference implementation):

```bash
cd rust && cargo test -- --ignored generate_test_vectors --nocapture && cd ..
mise run test
```

This regenerates all JSON test vectors from the Rust implementation, then re-runs every language's tests against the new vectors. All nine must still pass.

Regenerating is a deliberate, reviewed act: the vectors are the cross-language
contract, so a diff to them is a format change, not a test update. `mise run test`
fails if the committed vectors and the reference disagree — that is what
`rust/tests/spec_vectors.rs` and the read-back tests in `rust/src/test_vectors.rs`
are for.

---

## One-Liner for Full Verification

```bash
mise run validate:spec && mise run check:versions && mise run format:check && mise run lint && mise run build && mise run test
```

Then the slower gates, which are not part of a routine change:

```bash
mise run test:simd:diff     # every SIMD backend this host can execute
mise run rd:gate            # encoder quality regression gate
mise run verify:experiments # every number in spec/EXPERIMENTS.md vs the sweep output
mise run verify:claims      # every figure the OTHER docs quote from EXPERIMENTS.md
mise run verify:sweep-labels # every sweep arm sets the constants its label names
mise run corpus:licenses -- --check   # corpus attribution vs the pin table
mise run verify:benchmark   # every number in spec/PERFORMANCE.md vs the committed runs
mise run mutants:rust       # full mutation sweep of the core (slow)
mise run benchmark          # the perf sweep behind spec/PERFORMANCE.md
mise run benchmark:full     # the same sweep, exhaustive matrix (hours)
mise run benchmark:stages   # where encode time goes, stage by stage
```

`verify:benchmark` needs no harness — it reads `spec/PERFORMANCE.md` and the
committed runs under `tools/comparison/baselines/` — so it is cheap and runs in
`ci-comparison.yml` on every change to either. `verify:experiments` is its
sibling for `EXPERIMENTS.md`.

**Four gates, and only one of them needs the sweeps.** `verify:experiments` does
— they are gitignored and take hours, so it can only ever run locally, and its
bindings are exercised nowhere else. The other three read source files and run
in CI:

| Gate | What it asserts | Reads |
| --- | --- | --- |
| `verify:experiments` | every table in `EXPERIMENTS.md` matches the run that produced it | the sweep output |
| `verify:claims` | every figure `README.md`, `spec/README.md`, `spec/RATIONALE.md` and `rust/src/constants.rs` quote from `EXPERIMENTS.md` matches the cell it cites | five files |
| `verify:sweep-labels` | every sweep arm sets the constants its own label names | the sweep configs |
| `validate:spec` | `spec/constants.py`, `rust/src/constants.rs` and `typescript/src/header.ts` agree on every shared constant | three sources |

They chain: the sweeps gate `EXPERIMENTS.md`, and `EXPERIMENTS.md` gates
everything that quotes it. That is why `verify:claims` checks against the
*document* rather than re-deriving from the sweeps — the same traceability, and
it can run where the sweeps cannot.

> **A green `verify:claims` means every *registered* claim traces to a cell**,
> not that every number in the repo is true. `--list` prints the register.
> Adding a figure to one of those files should mean adding a line to it.

> **`verify:experiments` binds columns, not tables.** A bound table is checked on
> the columns its binding names and silent about the rest; four columns sat stale
> behind passing tables that way (`EXPERIMENTS.md` §9.5). The run now prints a
> `PARTIAL` line per bound table with an unchecked column, and
> `--list-unbound-columns` gives the breakdown. Every unchecked column is either
> bound or listed in `UNBOUND_COLUMN_NOTES` with the reason.

> **`verify:benchmark` currently fails, and its CI job is red on `master`.**
> `spec/PERFORMANCE.md` carries `TBD` placeholders throughout and no perf run is
> committed, both of which the gate fails on deliberately — see the banner at
> the top of that document. Do not bisect it, and do not silence it: the
> re-measurement below is what clears it.

**Re-measuring is a deliberate act.** The perf sweep is the one gate whose
output depends on the machine, so a re-measurement is reviewed the way a test
vector regeneration is:

```bash
mise run benchmark && mise run benchmark:full
cp tools/comparison/output/perf/perf.json      tools/comparison/baselines/perf-report.json
cp tools/comparison/output/perf/perf-full.json tools/comparison/baselines/perf-report-full.json
mise run verify:benchmark -- --fix   # rewrite the document's cells from the runs
mise run verify:benchmark            # must pass
```

Run it on a quiet machine from a clean tree: the driver records `git.dirty` and
the gate refuses a run that cannot be traced to a revision. The gate also warns
when the two runs disagree on a shared cell, which is the measuring host's
reproducibility floor — no figure in the document is tighter than it. A laptop
is usually not good enough; an Apple M3 Pro measured the same cell across fresh
processes with a 34% spread and drifted ~25% over a few hours.

> **`mise run test` does not run the per-backend SIMD differential tests.**
> `test:rust` is a plain `cargo test`, so the `simd-diff-tests` feature is off
> and only the generic SIMD path is exercised. That is deliberate: those tests
> *fail* rather than skip on a host that cannot execute a backend they were asked
> to validate, so enabling them in the aggregate would make `mise run test` — and
> therefore `git push` — fail on machines for reasons unrelated to the change
> being pushed. `test:simd:diff` is the opt-in, and `ci-rust.yml` and
> `ci-repo.yml` (both `--features full`) are the enforcing gates.

---

## Test Architecture

### Golden Test Vectors

All cross-implementation conformance testing is driven by shared JSON test vectors in `spec/test-vectors/`. The Rust implementation is the reference that generates these vectors. Every other implementation loads and validates against them.

| File | What it tests | Cases | Read by |
|------|---------------|-------|---------|
| `unit-color.json` | Linear/gamma RGB → OKLAB and the sRGB round-trip | 10 | Rust core |
| `unit-mulaw.json` | µ-law compress/expand/quantize/dequantize, both µ values × 4/5/6 bits, plus the never-written top code | 84 | Rust core |
| `unit-bitpack.json` | `write_bits`/`read_bits` round-trip, including widths that straddle a byte boundary | 15 | Rust core |
| `unit-cbrt.json` | The Halley cube root against the reference, with the ULP distance recorded per case | 23 | Rust core |
| `unit-aspect.json` | Aspect encode/decode and the decoded output size, over all 256 aspect bytes' distinct results | 45 | `spec/validate.py`, Rust read-back |
| `unit-selection.json` | Top-K coefficient selection: every distinct (W, H, K) at tier 1, half isotropic and half with the shipped `aniso`/`hv` weights | 488 | `spec/validate.py`, Rust read-back |
| `unit-validate.json` | `from_bytes` accept/reject: bad version, reserved tier, reserved bit, wrong length | 12 | `rust/tests/spec_vectors.rs` |
| `integration-encode.json` | Image → hash, byte-exact, plus average colour | 58 | all nine |
| `integration-decode.json` | Hash → image, pixel-exact (incl. one tier-4 case) | 10 | all nine |
| `integration-decode-capped.json` | Capped decode at various caps, pixel-exact | 9 | all nine |

`integration-encode.json` spans all five tiers, every source gamut (sRGB,
Display P3, Adobe RGB, BT.2020, ProPhoto RGB), 1×1 up to 320×20, both aspect
clamp extremes (1×100, 100×1), and seven alpha cases. The `unit-*` files are generated by `rust/src/test_vectors.rs`; a file
nobody reads back is not a test, so every one above names its consumer.

### Test Layers

The Rust core is the reference implementation and carries the algorithm tests.
Every other language is a thin binding over it (through `bindings/{c,uniffi,wasm}`)
and carries the parity gate plus a small behavioural suite — not a
re-implementation of the Rust suite. What each binding must have is listed under
[Binding test requirements](#binding-test-requirements).

The core has tests at four layers:

**1. Unit tests** — individual functions in isolation, in each module's
`#[cfg(test)]` block:
- `round_half_away_from_zero`
- `cbrt_signed` / `cbrt_halley` for negative values
- `write_bits` / `read_bits` round-trip
- `mu_law_quantize` / `mu_law_dequantize` round-trip
- top-K isotropic coefficient selection: counts and ordering
- `encode_aspect` / `decode_aspect` at known ratios and both clamp extremes
- `linear_rgb_to_oklab` / `oklab_to_linear_srgb` on white, black, and the primaries
- transfer functions: sRGB, Adobe RGB, ProPhoto, BT.2020 PQ boundaries
- `select_dc_codes`: that it reaches the ±1 neighbours, and never returns a code
  wider than its field

**2. Unit tests against golden vectors** — loaded from `spec/test-vectors/unit-*.json`
(the read-back tests in `rust/src/test_vectors.rs`, alongside the generator):
- colour conversion: exact OKLAB values, bit-for-bit
- µ-law: exact compressed / expanded / quantized / dequantized values
- bit packing: exact round-trip at boundary-straddling positions
- cube root: exact value, and the recorded ULP distance to the reference
- `from_bytes` accept/reject, via `rust/tests/spec_vectors.rs`

> These compare `f64` bit patterns, so the JSON parser has to be exact.
> serde_json's default float parser lands 1 ULP from Rust's own
> `str::parse::<f64>()` on values that appear verbatim in `unit-color.json`; the
> core enables its `float_roundtrip` feature for that reason. A binding that
> starts asserting on floats needs the same care.

**3. Integration tests against golden vectors** — loaded from `spec/test-vectors/integration-*.json`:
- Encode: given (width, height, RGBA pixels, gamut, tier), the hash bytes must match exactly
- Decode: given a hash, the output (width, height, RGBA pixels) must match exactly
- Average color: the header-only DC color extraction must match

**4. Property tests** — `rust/tests/properties.rs`, randomized via proptest.

The golden vectors are *regenerated from the crate under test*, so they catch a
change to the bitstream but never a bug that was already there when they were
written. These assert what the format guarantees, over inputs nobody enumerated:

- the byte length is a function of `(tier, has_alpha)` alone — not of the
  dimensions, the gamut, or the pixels;
- `from_bytes` accepts exactly what `encode_with_quality` produces;
- **anything `from_bytes` accepts, `decode` handles** — the documented contract
  that "a hash that validates is guaranteed to decode". Reached by perturbing one
  byte of a real hash, so the accept path sees payloads the encoder never emits;
- wrong lengths, reserved tier codes and a set reserved bit are always rejected;
- encode and decode are deterministic;
- `decode_capped` never exceeds its cap and never returns an empty image;
- `average_color` reproduces a solid input's own colour to within the DC's
  quantization.

Tolerances here are **measured, not guessed**. `average_color`'s bound of 16/255
is the worst deviation over a stride-3 sweep of the RGB cube (~636k solids), on
saturated green, where the bounded chroma range is least precise. Widening a
tolerance to make a test pass defeats it; if one of these fails, the number moved.

### Tolerances

- **Integer outputs** (quantized values, byte arrays, pixel values): exact match, zero tolerance.
- **Floating-point intermediates** in test vectors: written at Rust's shortest round-tripping precision (16–17 significant digits), not truncated — which is why the core enables serde_json's `float_roundtrip` (see above). The Rust read-back asserts them *bit-exactly*; a binding that starts asserting on floats should match within `1e-10` for colour conversions and `1e-12` for µ-law round-trips.
- **Rounding mode**: all implementations MUST use round-half-away-from-zero, not banker's rounding (spec section 2.2). This is the most common source of cross-implementation divergence.

---

## Test Fixture Coverage Requirements

This section defines all axes of variation that must be covered when building or extending the test vector dataset. Every combination that exercises a distinct code path should have at least one test case.

### Axis 1: Image Dimensions

Dimensions affect the aspect ratio encoding byte, the DCT basis function evaluation (cosine arguments scale with 1/w and 1/h), and whether AC coefficients are zero for trivially small images.

| Case | w | h | Purpose |
|------|---|---|---------|
| Minimum | 1 | 1 | Single pixel — all AC must be zero |
| Square small | 4 | 4 | Baseline for solid/gradient cases |
| Square medium | 8 | 8 | Higher-resolution AC detail |
| Square large | 16 | 16 | More pixels, richer AC spectrum |
| Square max | 100 | 100 | A large square; there is no dimension cap in the format |
| Landscape | 8 | 4 | aspect byte > 128 (8×4 → 159) |
| Portrait | 4 | 8 | aspect byte < 128 (4×8 → 96) |
| Extreme landscape | 100 | 1 | aspect byte = 255 (16:1 cap) |
| Extreme portrait | 1 | 100 | aspect byte = 0 (1:16 cap) |
| Photographic 3:2 | 9 | 6 | Common camera ratio |
| Photographic 16:9 | 16 | 9 | Widescreen ratio |

The byte is `round((log2(w/h) + 4) / 8 × 255)`, so it *rises* with width: 128 is
square, above is landscape, below is portrait. It clamps at the representable
extremes (ratio 16:1 → byte 255, ratio 1:16 → byte 0). Test images at the exact
clamp boundary.

### Axis 2: Gamut

Each gamut uses a distinct M1 matrix and, for Adobe RGB and ProPhoto RGB, a different transfer function exponent. Identical sRGB-valued pixels fed through different gamuts must produce different OKLAB values and therefore different hashes.

| Gamut | Transfer function | Notes |
|-------|------------------|-------|
| sRGB | Piecewise (IEC 61966-2-1) | Baseline |
| Display P3 | Same as sRGB | Different primaries only |
| Adobe RGB | Power 2.2 | Different EOTF from sRGB |
| BT.2020 | PQ (SMPTE ST 2084) → Reinhard | Wider primaries *and* a different EOTF |
| ProPhoto RGB | Power 1.8 + Bradford D50→D65 | Most extreme gamut |

At minimum, each gamut needs one solid-color encode case with a known OKLAB output. A saturated color (e.g. 100% red) is most useful because it diverges maximally between gamuts.

### Axis 3: Alpha Channel

The presence of any pixel with α < 255 flips `hasAlpha = 1`, which switches the
whole AC allocation to the layout's alpha row. Selection is top-K, not a fixed
grid: at the default tier the opaque row is 28 luma coefficients at 4 bits plus
15 chroma at 3, and the alpha row is 22 luma at 4 plus 3 chroma at 3, freeing
budget for 28 alpha coefficients at 3 bits alongside an alpha DC (5 bits) and
scale (4 bits). See `LAYOUT_T0` in `rust/src/constants.rs`.

| Case | Description | hasAlpha |
|------|-------------|----------|
| All opaque | Every pixel α = 255 | 0 |
| One transparent pixel | A single pixel with α < 255 among opaque pixels | 1 |
| Checkerboard alpha | Alternating fully-opaque / fully-transparent | 1 |
| Uniform partial alpha | All pixels at α = 128 | 1 |
| Fully transparent | All pixels α = 0 | 1, DC defaults to black |

The fully-transparent case exercises the edge case where alpha-weighted averaging produces a zero-weight sum: the implementation must default to black (L=0, a=0, b=0) rather than dividing by zero.

### Axis 4: Color Distribution (AC Coefficient Coverage)

Solid colors produce scale=0 and all AC coefficients at the μ-law midpoint — a distinct code path from images with spatial variation.

| Pattern | Scale factor result | AC coefficients |
|---------|--------------------|-----------------|
| Solid color (any) | scale = 0 | All at μ-law midpoint |
| Horizontal gradient | L/a/b scale > 0 | Non-zero in X-frequency bins |
| Vertical gradient | L/a/b scale > 0 | Non-zero in Y-frequency bins |
| 2D gradient | L/a/b scale > 0 | Non-zero in both axes |
| Checkerboard | scale > 0 | Energy in high-frequency bins |

For solid colors, test at least: white (255,255,255), black (0,0,0), neutral gray (128,128,128), pure red, pure green, pure blue, and an arbitrary mid-tone that exercises non-neutral a/b DC values.

For gradients, ensure both a horizontal-only and vertical-only case exist so that x-frequency and y-frequency AC paths are independently verified.

### Axis 5: Quantization Boundary Values

These cases target the clamping and rounding logic rather than general image variety.

**DC values near extremes:**
- Pure white → L_dc near 1.0, a_dc ≈ 0, b_dc ≈ 0 (encodes to byte 127, 64, 64)
- Pure black → L_dc = 0.0 (encodes to byte 0)
- Maximally saturated color that pushes |a_dc| or |b_dc| toward `MAX_CHROMA_A` (0.35) or `MAX_CHROMA_B` (0.33) — tests clamping in the a/b DC encoder
- A color whose OKLAB a or b exceeds those bounds (out-of-gamut for narrow-display input in wide-gamut mode) — must clamp, not overflow

**Scale factor = 0:**
When all pixels are identical, scale = 0. The AC encoder must still write valid bits (the μ-law midpoint value) rather than dividing by zero or writing garbage.

**μ-law boundary values (unit test):**
- v = 0.0 → midpoint of quantized range
- v = 1.0 and v = -1.0 → quantized to max/min
- Values landing exactly on 0.5 quantization steps → verify round-half-away-from-zero, not banker's rounding
- Test the widths the shipped layouts use: 4 bits (luma AC) and 3 bits (chroma AC, alpha AC). `unit-mulaw.json` also covers 5 and 6, which no shipped tier selects but the sweep tunables can

**Aspect ratio boundary (unit test):**
- w/h = 1.0 → byte should be 128
- w/h = 4.0 → byte should be 255 (clamped)
- w/h = 0.25 → byte should be 0 (clamped)
- Ratios that land on exact half-integer byte steps → verify rounding

### Axis 6: Bit Packing

The output is a tightly packed bitstream with no byte alignment between fields (32 bytes at the default tier; the length is determined by the tier and alpha flag). Several fields straddle byte boundaries.

| Field | Bits | Byte boundary crossed? |
|-------|------|----------------------|
| version | 0–2 | No |
| tier | 3–5 | No |
| hasAlpha | 6 | No |
| reserved | 7 | No |
| aspect | 8–15 | No |
| L_dc | 16–22 | No (wholly inside byte 2) |
| a_dc | 23–29 | Yes (crosses byte 2→3) |
| b_dc | 30–36 | Yes (crosses byte 3→4) |
| L_scale | 37–42 | Yes (crosses byte 4→5) |
| a_scale | 43–48 | Yes (crosses byte 5→6) |
| b_scale | 49–53 | No |
| alpha_dc | 54–58 | *alpha mode only* |
| alpha_scale | 59–62 | *alpha mode only* |

Bytes 0 and 1 are the **descriptor**: the self-describing header that fixes the
hash's total length. Byte 0's low three bits are the format generation, the next
three the quality tier, then the alpha flag and one reserved bit. `PREFIX_BITS`
is 54 (16 descriptor + 38 DC/scale); the AC payload follows, and its size is what
distinguishes the tiers.

Unit tests for `write_bits`/`read_bits` must cover writes that begin and end in
different bytes — `unit-bitpack.json` does, at positions 0, 3, 6, 7, 47, 48, 53,
183 and 219.

**The reserved bit is rejected, not ignored.** In v1 the header determines the
byte length exactly, so `from_bytes` validates the version, the tier, the
reserved bit and the length, and returns an error rather than decoding a
malformed input. A hash that validates is guaranteed to decode; that is the
contract every binding surfaces, and `unit-validate.json` pins it.

### Axis 7: Round-trip Consistency

Encode→decode round-trips do not recover the exact original pixels (lossy format), but they must be deterministic: encoding the same input twice must produce the identical hash bytes, and decoding that hash must produce the identical pixel array.

| Check | What to verify |
|-------|---------------|
| Encode determinism | Same input → same bytes, across multiple calls |
| Decode determinism | Same hash → same pixel array, across multiple calls |
| Cross-implementation | Rust == C == WASM == UniFFI == TypeScript == JVM == Swift == Go == Python == C# for the same input |
| Decode output dimensions | Decoder output w/h are derived from aspect byte, not stored exactly — verify they match the spec formula |

### Current Coverage Gaps

Closed since this list was first written: ProPhoto RGB encode cases, both aspect
clamp boundaries (100×1 and 1×100), 6-bit µ-law cases, dimensions well past
100 px (up to 320×20), and all five tiers on the solid / gradient / alpha
families.

Also closed, in v0.7.2: **Adobe RGB and BT.2020 encode cases**
(`solid_adobe_4x4`, `solid_bt2020_4x4`), the **DC chroma clamp**
(`solid_out_of_gamut_4x4` — ProPhoto blue clamps both OKLAB axes at once), the
**fully transparent** and **uniform partial alpha** cases (`transparent_4x4`,
`uniform_alpha_8x8`, each with a decode half), and a **tier-4 decode oracle**
(`strip_100x1_t4_decode`). The last was not on this list because nobody had
noticed it: every decode vector was at the default tier, as were the core's own
in-file decode goldens, so no implementation in any language had a byte-exact
tier-4 decode to check against.

Still open in `spec/test-vectors/`:

- **`decode_to` / `decode_capped_to` (output-gamut rendering).** Every binding
  exports it — `go/chromahash.go`, `csharp/src/Chromahash/ChromaHash.cs`,
  `python/chromahash/__init__.py`, `bindings/uniffi/src/lib.rs`,
  `bindings/c/src/lib.rs` — and no shared vector pins it. Rust covers it alone
  (`decode.rs`), and the TypeScript package cross-checks pure-TS against WASM
  over the display gamuts, but the other seven languages replay nothing. Given
  wide-gamut output is a headline feature, this is now the largest parity gap.
  Closing it means an output-gamut axis in the generator plus a `decodeTo`
  replay in every binding suite.

That gap is a *binding-parity* gap rather than a correctness gap: the behaviour
is pinned in the reference, but the shared contract does not carry it.

---

## What to Check After Specific Changes

### Changed a constant or matrix in `spec/constants.py`

1. `python3 spec/validate.py` — verify derivation still holds
2. Update the constant in the Rust core (the other languages read it through the FFI)
3. Regenerate test vectors from Rust: `cd rust && cargo test -- --ignored generate_test_vectors --nocapture`
4. `mise run test` — every language must pass

### Changed encoding logic

1. Change it in the Rust core only — every other language is a binding over it
2. Regenerate test vectors from Rust (it is the reference)
3. `mise run test` — every language must pass against the new vectors
4. `mise run rd:gate` — the encoder quality gate; if it moves, say which change moved it

### Changed decoding logic

1. Change it in the Rust core only
2. Regenerate decode test vectors from Rust
3. `mise run test`

### Changed only one language implementation (bug fix)

1. `mise run test-<lang>` for the changed language
2. `mise run test` to confirm no regressions across all languages

### Changed the spec (`spec/README.md`)

1. Verify the spec text matches `constants.py`: `python3 spec/validate.py`
2. If the spec describes new behaviour, ensure the reference and the test vectors reflect it
3. `mise run test`

---

## Git Hooks (Automated Safety Net)

[hk](https://hk.jdx.dev) enforces checks automatically. The configuration is
[`hk.pkl`](hk.pkl); every step delegates to a mise task, so the hooks and CI run
the same commands.

| Hook | What runs | Purpose |
|------|-----------|---------|
| `commit-msg` | `convco check` | Reject a non-conventional commit message at commit time |
| `pre-commit` | `mise run format`, `mise run lint:fix`, then `git diff --exit-code` | Auto-fix style, then fail if the fixers changed anything |
| `pre-push` | `convco check` on the outgoing commits, `mise run format:check`, `mise run lint`, `mise run test`, `mise run mutants:rust:diff` | Block push if anything fails |

Install them once with `hk install` (hk itself comes from `mise install`). The
pre-push hook runs the full test suite, so a successful `git push` implies all
checks passed. Steps run one at a time — they all drive cargo against the same
target directories.

The `mutants-rust` pre-push step is gated on `rust/src/**/*.rs` edits, so non-Rust pushes skip it. It mutation-tests only the core lines the push changes (see [Mutation Testing](#mutation-testing)). Skip it explicitly with `HK_SKIP_STEPS=mutants-rust git push`.

---

## CI (GitHub Actions)

Each language has an independent CI workflow triggered when its directory — or
anything it depends on — changes. **`spec/test-vectors/**` is in every language
workflow's path filter**: ten suites read those files, so without it a vector
edit ran nothing but the commit linter.

| Workflow | Trigger path | Steps |
|----------|-------------|-------|
| `ci-rust.yml` | `rust/**`, `spec/test-vectors/**` | fmt check, clippy (`--all-targets --features full`), test, `--no-default-features` build + test, MSRV build on the declared `rust-version`; `simd-diff` matrix runs the per-backend differential tests per target (native Arm NEON, QEMU SSE2-only, wasmtime simd128) |
| `ci-c.yml` | `bindings/c/**`, `rust/**`, `spec/test-vectors/**` | fmt check, clippy `--all-targets`, header drift, test, C example |
| `ci-wasm.yml` | `bindings/wasm/**`, `rust/**`, `spec/test-vectors/**` | fmt check, clippy `--all-targets`, test (wasm in Node) |
| `ci-typescript.yml` | `typescript/**`, `bindings/wasm/**`, `rust/**`, `spec/test-vectors/**` | build WASM, fmt check, lint, build, test |
| `ci-jvm.yml` | `bindings/uniffi/**`, `rust/**`, `spec/test-vectors/**` | ktlint check, test (spec vectors through the binding) |
| `ci-swift.yml` | `swift/**`, `bindings/uniffi/**`, `rust/**`, `spec/test-vectors/**` | build, test (macOS — the xcframework needs xcodebuild) |
| `ci-go.yml` | `go/**`, `bindings/c/**`, `rust/**`, `spec/test-vectors/**` | fmt check, vet, test |
| `ci-python.yml` | `python/**`, `bindings/uniffi/**`, `rust/**`, `spec/test-vectors/**` | fmt check, lint, test |
| `ci-csharp.yml` | `csharp/**`, `bindings/c/**`, `rust/**`, `spec/test-vectors/**` | fmt check, build (lint), test |
| `ci-android.yml` | `bindings/uniffi/**`, `rust/**`, `spec/test-vectors/**` | spec-vector test; AAR cross-compile + assemble |
| `ci-repo.yml` | *no path filter* | `spec/validate.py`, the core's `--features full` test, and the manifest-version check — the repo-wide gates that must run on every change |
| `ci-tools.yml` | `tools/{thumbhash-rs,gamut-ref-stdin,benchmark,ci}/**` | fmt, lint and build the three helper tools; manifest versions. The two Rust tools have no `#[test]` of their own — the `cargo test` step is a compile gate, and their correctness is asserted where they are *used*, by the comparison harness's own checks |
| `ci-comparison.yml` | `tools/comparison/**`, `typescript/**`, `rust/**` | build the harness and run the R–D quality gate. `rust/**` is there because the gate exists to catch *encoder* regressions |
| `ci-mutants.yml` | `rust/**` (PRs) | mutation-test the changed core lines (`--in-diff`), with an empty-diff guard; full sweep weekly and on demand |
| `ci-commits.yml` | *all* | conventional-commit format (convco) |

CI mirrors the local `mise run` tasks. If local checks pass, CI should pass — with
two exceptions that cannot run on a Linux workstation: the Swift suite (needs
macOS for the xcframework, so `mise run test:swift` skips with a message rather than
passing silently) and `test-simd-emulated` (needs `qemu-user` and `wasmtime`).

---

## Binding test requirements

Every non-Rust package is a thin wrapper with no algorithm of its own, so its
suite is deliberately small. But "small" is not "absent": each requirement below
caught a real defect in at least one binding, and each must be present in every
one of them.

This list is a *contract*, so it is worth saying how it is enforced: it is not.
Nothing mechanically checks that a binding carries these tests — adding a
binding, or a tenth requirement, means adding them by hand. When this section
was first written it described what the suites *ought* to have had; six of the
nine rows were false for at least one binding at the time. They were then made
true, one binding at a time. If you extend this table, do the same, and check
the claim before writing it down.

| Requirement | Why |
|---|---|
| **Replay all three integration vector files** | The cross-language contract. Encode, decode, and capped decode. |
| **A missing or empty vector file must fail** | A loader that returns `null` or an empty list on a missing file turns the entire correctness gate green with zero assertions. That is exactly what the JVM suite did until a rename would have gone unnoticed. |
| **An unknown gamut must fail loudly** | A silent fallback to sRGB reports a *hash mismatch* instead of the real cause. Go's fallback was load-bearing: removing it revealed there was no `case "sRGB"` at all. TypeScript has no mapping function — it casts the vector's string straight to `Gamut` — so its guard is a validating `checkedGamut()` at the loader instead. |
| **Per-tier byte lengths (21/32/108/411/1623)** | A `length == 32` assertion is true of exactly one tier and says nothing about the other four. |
| **Per-tier decoded raster (32/32/64/128/256)** | A range check wide enough to pass at every tier cannot tell them apart. |
| **`from_bytes` rejects a wrong length, a reserved tier code, and a set reserved bit** | The documented contract is that a hash which constructs is guaranteed to decode. A lazy `from_bytes` moves the failure far from the boundary that accepted it. |
| **`encode` rejects invalid dimensions, a mismatched rgba length, and a reserved tier** | The core panics on all three. A panic across FFI is undefined behaviour; in WebAssembly it aborts the module instance, so every later call fails too. |
| **Batch encoding honours each item's tier, and an omitted tier is the *default* tier** | The tier codes are ordered by quality, so a zero default silently produces the 21-byte compact hash. Comparing batch against serial would pass if both used one tier — the byte lengths are what distinguish them. **Go is the exception**: a struct field cannot be "unset", so `ImageInput{...}` without `Quality` *is* the compact tier. That is pinned by `TestZeroValueQualityIsTheCompactTier` rather than papered over — it is the trap that made the Go batch benchmark measure 21-byte hashes against a 32-byte serial baseline. |
| **Locally declared tier constants agree with the FFI's** | Go and C# must declare their own (they need constant expressions); a test ties them to the exported symbols so a renumber cannot leave one behind. |

TypeScript additionally ships a **pure-TypeScript decoder** (`src/header.ts`,
`src/decode.ts`) for render-only consumers who skip the WASM init. That is a
genuine second implementation, so it declares the wire constants independently —
and a test asserts they equal the ones the WASM core exports.

---

## SIMD Differential Testing

The core color math has hand-written SIMD backends (`rust/src/simd/`): AVX2/SSE2
on x86, NEON on aarch64, simd128 on wasm, plus the always-available scalar
fallback. Each must produce **byte-identical** output to the scalar reference
(`color::linear_rgb_to_oklab`) — that equivalence is what lets the SIMD path stay
spec-conformant. It is pinned by *differential tests* in `src/simd/mod.rs` that
run a backend over a fuzzed batch (many sizes × all gamuts × edge pixels) and
assert every pixel equals scalar.

Two run on a plain `cargo test`:

- `scalar_backend_matches_reference` — the scalar batch path vs the reference.
- `public_dispatch_matches_reference` — whatever backend *this* host selects.

The **per-backend** tests (`avx2_…`, `sse2_…`, `neon_…`, `wasm_simd128_…`) each
pin one *specific* backend and are gated behind the off-by-default
`simd-diff-tests` feature (included in `full`). Because a backend only compiles
for its own target, full coverage means running the suite on — or emulating —
every target.

**They fail rather than skip.** Running the suite on a host that cannot execute a
backend it was asked to validate (the AVX2 test on a non-AVX2 CPU, or
`simd-diff-tests` on a target with no vector backend at all) is a
misconfiguration — usually a mis-targeted CI job — so it panics with a clear
message instead of passing green with zero coverage.

```bash
mise run test:simd:diff        # native host: every backend this CPU/arch provides
mise run setup:simd-targets    # add the rustup targets the emulated sweep needs
mise run test:simd:emulated    # every target via QEMU (x86_64 AVX2 + SSE2-only,
                           # aarch64 NEON) and wasmtime (wasm32 simd128)
```

`test-simd-emulated` needs `qemu-user`, `gcc-aarch64-linux-gnu`, and `wasmtime`
on `PATH`. QEMU user-mode emulates Linux targets, so on a non-Linux host run it
inside a Linux container.

**Where it runs in CI.** `ci-rust.yml` runs the differential tests on each
machine target: the main job covers x86_64 AVX2+SSE2 (`cargo test --features
full`), and the `simd-diff` matrix adds a native Arm runner (NEON), a QEMU job
forcing an SSE2-only CPU (the no-AVX2 dispatch path), and a wasmtime job
(simd128).

---

## Mutation Testing

[cargo-mutants](https://mutants.rs) stress-tests the **core Rust crate's own test
suite**: it applies small mutations to `rust/src` (flip a comparison, swap an
operator, replace a function body with a constant) and checks the tests catch
each one. A *missed* mutant is a line the tests run but don't actually pin — a
coverage gap a line-coverage number would hide.

Scope is the core only (per issue #41); the FFI bindings are thin wrappers and
are exercised by their own spec-vector tests.

```bash
mise run mutants:rust                     # full sweep of rust/src (~2000 mutants, ~hours)
mise run mutants:rust:diff                # only the lines changed vs origin/master (fast)
mise run mutants:rust --file src/dct.rs   # extra args pass straight to cargo-mutants
```

**How the sweep sees the golden vectors.** cargo-mutants builds the crate in an
isolated copy of `rust/` that does not include the sibling `spec/` dir, so the
external golden test (`tests/spec_vectors.rs`, gated by the default-on
`spec-vectors` feature) is skipped during the sweep (`no_default_features` in
`rust/.cargo/mutants.toml`). The encode/decode pipeline is instead pinned for
mutation by **self-contained golden unit tests** in `src/encode.rs` and
`src/decode.rs` that embed the expected hashes/pixels directly. Normal
`cargo test` and CI run the full external golden test as usual.

**Equivalent mutants.** A few mutations can't be killed by any test because they
produce identical observable behaviour (e.g. `>` vs `>=` at a boundary no input
reaches) or only affect resource cleanup. These are listed, with justification,
in `exclude_re` in `rust/.cargo/mutants.toml` — keep that list short and prefer
adding a test over an exclusion.

Two rules learned the hard way, both from exclusions in that file that turned
out to be wrong:

- **Anchor the pattern as narrowly as it will go.** An unanchored
  `replace - with (\+|/) in select_dc_codes` matched all three clamp ceilings
  when only the L one is equivalent, quietly exempting two killable mutants —
  while the comment beside it said the opposite. A line-anchored pattern is
  brittle, but it fails *safe*: if the file shifts, the sweep reports an extra
  missed mutant rather than exempting a new one.
- **Assert the premise.** "No input reaches this boundary" is a claim about the
  format, so it can be a test. `no_aspect_byte_decodes_to_exactly_one` checks
  all 256 aspect bytes, which is what the two `>`/`>=` exclusions actually rest
  on. Where the premise cannot be tested, say what was measured and how.

**The build profile changes the answer.** The sweep runs on `[profile.mutants]`
(optimized, but with `overflow-checks` and `debug-assertions` on), not plain
`release`. Release masks arithmetic that debug traps on, and that changes which
mutants are killable, not just how fast they run: `(bitpos + i) % 8` → `+ 8` is
caught in a checked build, where the shift panics, and survives in release,
where `1u8 << 11` silently becomes `1u8 << 3`. Reporting that as an equivalent
mutant would be measuring the profile rather than the tests.

**The property tests are randomized**, so a mutant they kill in one sweep may
survive the next. A single missed mutant in `tests/properties.rs`'s blast radius
is worth re-running before acting on; a repeatable one is a real gap.

**Where it runs.** The `mutants:rust:diff` hk pre-push step gates pushes
that touch `rust/src` on the changed lines being covered; `ci-mutants.yml` runs
the same incremental check on pull requests. The full sweep is too slow for a PR
gate, so it runs weekly on a schedule (and on demand via workflow_dispatch): a
gap the incremental gate cannot see is one in code nobody is touching, worth
catching eventually but not worth blocking every PR on.

**Why not a coverage percentage.** This repo has no coverage-percentage
threshold anywhere, deliberately. Line coverage counts lines the tests *execute*;
mutation testing counts lines the tests *pin*. A threshold rewards adding calls
without assertions — and most of this repo is bindings, where a coverage number
would measure the FFI marshalling rather than the format. The gates that matter
here are the shared vectors, the property invariants, the structural requirements
in [Binding test requirements](#binding-test-requirements), and this sweep.

---

## Troubleshooting

### Tests pass locally but fail in CI

- Check tool versions match `.mise.toml` (node 24, java 21, gradle 9.4.0, swift 6.2.4, go 1.24, python 3.13, dotnet 9)
- CI installs specific versions; local `mise install` should match

### One language passes but another fails on the same test vector

- The failing implementation has a bug. The test vectors are authoritative.
- Common causes: wrong rounding mode, off-by-one in scan order loop, incorrect bit width, matrix typo

### Floating-point mismatch in color conversion

- Ensure float64 precision for encoding (spec section 2.3)
- Check `cbrt` handles negative values (spec section 2.4): must use `sign(x) * |x|^(1/3)`, not `pow(x, 1/3)`
- Verify the correct M1 matrix is selected for the source gamut

### Test vector regeneration produces different hashes

- Expected if you changed encoding logic in the core. Review the diff, and say in
  the commit message which change moved it.
- Unexpected otherwise. The reference may have a bug — compare against the spec
  pseudocode, and check `spec/validate.py`, which derives the constants
  independently.
