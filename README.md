# chromahash

> Modern, high-quality image placeholder representation for professional formats (LQIP)

chromahash is a multi-language library implementing a compact, high-fidelity Low Quality Image Placeholder (LQIP) format. All nine implementations are spec-compatible — identical input produces identical output across languages.

## Packages

| Language | Package | Registry |
| -------- | ------- | -------- |
| Rust | `chromahash` | [crates.io](https://crates.io/crates/chromahash) |
| TypeScript | `@visualcommons/chromahash` | [npm](https://www.npmjs.com/package/@visualcommons/chromahash) |
| Python | `chromahash` | [PyPI](https://pypi.org/project/chromahash/) |
| C# | `ChromaHash` | [NuGet](https://www.nuget.org/packages/ChromaHash) |
| Java / Kotlin (JVM) | `io.github.visualcommons:chromahash-jvm` | [Maven Central](https://central.sonatype.com/artifact/io.github.visualcommons/chromahash-jvm) † |
| Android | `io.github.visualcommons:chromahash-android` | [Maven Central](https://central.sonatype.com/artifact/io.github.visualcommons/chromahash-android) † |
| Go | `github.com/visualcommons/chromahash/go` | [pkg.go.dev](https://pkg.go.dev/github.com/visualcommons/chromahash/go) |
| Swift | SwiftPM (`https://github.com/visualcommons/chromahash`) | [Swift Package Index](https://swiftpackageindex.com/visualcommons/chromahash) |
| C | `chromahash-c` | [source](bindings/c) (C ABI — the FFI foundation, no registry) |

> Every package is published to its registry automatically on each tagged release — see [`RELEASING.md`](RELEASING.md).
>
> The table lists where each package *publishes*, which is not the same as what
> is live today. As of 0.6.0: crates.io, PyPI, NuGet and the Go proxy are live;
> npm has not published yet (0.7.1 is the first release under the
> `@visualcommons` scope); and † the JVM/Android artifacts are still on Maven
> Central under the pre-rename `io.github.justin13888` coordinates —
> `io.github.visualcommons` takes over from 0.7.1.

## Why ChromaHash?

ChromaHash is built for professional photo management at scale, where perceptual quality, layout precision, and wide-gamut correctness matter. Every format claim below is defined and quantified in the [format specification](spec/); the section references are to [`spec/README.md`](spec/README.md).

- **Perceptually uniform, and tuned on measurements.** Color is encoded in the [OKLAB](https://bottosson.github.io/posts/oklab/) perceptually-uniform color space (the model adopted by CSS Color 4), so quantization steps map to evenly-perceived changes. AC coefficients use µ-law companding with an **exact-zero code** (µ=5 luma, µ=8 chroma, µ=5 alpha), so empty slots and solid colors decode exactly instead of carrying a systematic bias (§7.3). Quantization ranges are sized to the measured coefficient distributions and to the union of the display gamuts rather than to theoretical extremes (§7.1–§7.2), and the encoder chooses its scale and coefficient codes by searching *reconstruction* error instead of rounding in the companded domain (§7.2–§7.3) — an encoder-only change the decoder never sees. The v0.7 constants and encoder recipe together are worth **−3.50% mean ΔE00** at the default tier on a never-tuned holdout split, with every guard metric improving. The 32-byte encode now matches what the previous constants needed 40 bytes to reach (§13).
- **One rule chooses the coefficients.** ChromaHash transmits the K lowest isotropic spatial frequencies representable on the natural decode raster — an ℓ2 ball, the ideal low-pass set for the radially decaying spectra of natural images. It is aspect-adaptive with no grid machinery, no mode flags, and no way to select a frequency the raster cannot represent (§6.2–§6.3). The order within that ball is weighted for human contrast sensitivity: diagonal detail is *de*prioritized (the oblique effect) and vertical is preferred to horizontal. The weight is evaluated as an exact integer, so the transmission order is bit-exact across languages and costs nothing at decode (§6.2).
- **Wide-gamut in, display-gamut out.** Encodes from sRGB, Display P3, Adobe RGB, BT.2020 (tone-mapped by a canonical Reinhard operator at 203 cd/m²) or ProPhoto RGB into absolute OKLAB — so no gamut flag is stored — and decodes to sRGB, Display P3, or Adobe RGB (§5, §11). Out-of-gamut colors are mapped by a relative-colorimetric per-channel clip, landing at the gamut boundary at full in-gamut saturation rather than being desaturated toward gray the way earlier revisions did (§12.6). And the encoder simulates the decoder's DC path across 27 candidate code triples to pick the one whose *decoded* color is closest to the true average, so gamut-corner solids round-trip nearly exactly — solid blue went from ΔE00 7.75 to **0.36** (§10.3).
- **Precise layout.** An 8-bit log₂ aspect ratio carries the source's shape to within **~1.09%** across the whole 1:16 – 16:1 range, against ThumbHash's 3-bit ~7% over ~7:1 (§8.1, Appendix A). Read the *ratio* and you get that; read the decoded *raster* and you get ~1.6%, because the base grid rounds to integers at a 32 px long edge and §8.2 defines every higher tier as a bit shift of that already-rounded base — a 3:2 source lands on 32×21 at every tier. Both numbers are measured, per format, on the report's Layout tab.
- **32 bytes by default, five self-describing tiers.** The default hash (tier code 1) is exactly 32 bytes — memory-aligned, cache-friendly, a zero-overhead database column or cache key. Code 0 is a 21-byte **compact** tier rendering at the same 32 px raster; codes 2–4 quadruple the coefficient budget and double the render edge, at 108/411/1623 bytes (103/388/1528 with alpha). Byte 0 carries the version, tier, and alpha flag, and the byte length follows deterministically from them — so a parser validates a hash in **O(1) with no checksum**, and a hash that validates is *guaranteed* to decode (§2.6, §3.5). The format is strongest from ~20 to ~110 bytes: on a never-tuned holdout split the compact tier beats ThumbHash on ΔE00, SSIMULACRA2, Butteraugli *and* DSSIM at its own size, and at 108 bytes it beats size-matched WebP on ΔE00 by 9.5% while taking SSIMULACRA2 and Butteraugli. Above that, the specification says plainly that a real codec is the better tool (§14.1).
- **Alpha is a real channel, not an afterthought.** A cut-out placeholder is mostly silhouette, which is high-frequency, so the default tier spends **28 AC coefficients on alpha** — paid for out of chroma, which transparent regions composite away — inside the same 32 bytes. Worth **−16.2% mean ΔE00** on a never-tuned alpha holdout with every guard metric improving (§3.2, §7.4). Decode cost per tier, and what capping the raster buys back at the upper ones, are measured in [`spec/PERFORMANCE.md`](spec/PERFORMANCE.md) (§14).
- **One core, first-class everywhere.** A single zero-dependency Rust core is exposed to every other language through thin FFI bindings (C, WebAssembly, and UniFFI), so a spec change lands once and every language stays **bit-exact** against the shared [`spec/`](spec/) test vectors. See [Appendix A of the spec](spec/README.md#appendix-a-thumbhash-comparison--acknowledgment) for the full ThumbHash comparison.

## Guides

- [Performance](spec/PERFORMANCE.md) — where encode and decode time actually goes, per tier, per implementation, and what each lever costs. It is the only place this repo publishes wall-clock; [`BENCHMARK.md`](BENCHMARK.md) is a pointer to it.
- [Decoding on Android](docs/android.md) — how the [`bindings/uniffi/`] AAR wraps the native Rust core for fast, SIMD-ready placeholder decoding

## Setup

### Prerequisites

Install all pinned tools via [mise](https://mise.jdx.dev/):

```bash
mise install
```

mise also runs the cross-language tasks — there is no separate task runner to
install. `mise tasks` lists them.

Then install per-language dependencies:

```bash
# TypeScript
cd typescript && pnpm install

# Java/Kotlin JVM (pre-cache Gradle dependencies)
cd bindings/uniffi/jvm && ./gradlew dependencies

# Python
cd python && uv sync

# C#
cd csharp && dotnet restore
```

Install git hooks (hk comes from `mise install` above; this registers it with git):

```bash
hk install
```

## License

Licensed under either of:

- [MIT License](LICENSE-MIT)
- [Apache License, Version 2.0](LICENSE-APACHE)

at your option.
