# chromahash comparison

Generates the visual comparison report: every LQIP format encoded and decoded
over the same corpus, scored the same way, and rendered as a single HTML page.
CI publishes it to Cloudflare Pages on each push to `master`
(`ci-comparison.yml` builds it, `deploy-comparison.yml` deploys it), so this is
the project's public answer to "how does ChromaHash compare".

The tool also hosts the research harnesses that produce `spec/EXPERIMENTS.md`
and `spec/PERFORMANCE.md` — the constants sweeps, the rate–distortion runs, the
CI quality gate. Those share the corpus and the scoring path with the report,
which is why they live here.

## Reading the report

The report is organised by *what the evidence is evidence of*, because not all
of it answers the same question.

| Tab | What it is for |
| --- | --- |
| **Overview** | The short answer: five columns over photographs alone. Start here. |
| **Photos** | Real photographs. This is the corpus a placeholder format is *for*, and the tables to judge a format on. |
| **Cut-outs & graphics** | Real content that is not photographic — transparent cut-outs, logos, screenshots, charts, line art. Placeholder formats are tuned on photographs; this is where that tuning meets what a real pipeline also ingests. |
| **Synthetic tests** | Generated fixtures. **Capability, not quality** — see below. |
| **Layout** | How far the page moves when the real image replaces the placeholder. |
| **Metrics** | What every number means and where it is defined. |
| **Cross-language** | That all nine implementations produce identical bytes. |

### The corpus is tiered, and the tiers are not interchangeable

`src/corpus.ts` splits the corpus three ways, on three orthogonal axes:

- **`CorpusTier`** — `real` (111 images) or `synthetic` (43). Real content is
  39 curated photographs, the 24-image Kodak suite, 24 transparent cut-outs and
  24 graphics. Synthetic is the generated fixtures: `solid-*`, `gradient-*`,
  `dim-*`, `gamut-*`, `noise`.
- **`CorpusSplit`** — `tune` or `holdout`. Constants sweeps tune on `tune` only;
  `holdout` (the Kodak True Color suite plus held-out curated photographs) is
  what shows whether tuned constants generalize.
- **`CorpusSet`** — `photo`, `alpha`, `graphic`, `all`. Which body of content a
  sweep is measured against.

The tier split matters most for reading the report. `gamut-bt2020.png` and
`dim-1x100.png` demonstrate that a format *can* represent a case; they say
nothing about how well it serves a real placeholder. Averaging them in with
photographs — which the report used to do, under "All Images" — reads a
capability demonstration as a quality result. **Do not rank formats on the
synthetic tab.**

All three axes are keyed off the filename prefix, deliberately: adding fixtures
under a new prefix then cannot silently move the mean of an existing sweep.

### A corpus change is a re-baseline, not an edit

`sweep.ts` globs `fixtures/**` and defaults unknown names to the tune split, so
adding one image moves every number in `spec/EXPERIMENTS.md`. Every downloaded
fixture carries a SHA-256 pin (`corpus-pin.ts`) that throws on mismatch, so the
digests record *which* corpus a number belongs to. If you add or remove an
image, re-run §6 of EXPERIMENTS.md in the same change — about an hour — or do
not add it.

## The metrics

Seven come from [`iqa-cli`](https://crates.io/crates/iqa-cli); three are computed
by this harness and are badged separately in the report, because the report
claims those seven are iqa-cli's and that claim has to stay true.

| Metric | Direction | Reference |
| --- | --- | --- |
| **ΔE00** (CIEDE2000) — *primary* | lower | [Colour difference § CIEDE2000](https://en.wikipedia.org/wiki/Color_difference#CIEDE2000) |
| SSIMULACRA2 | higher | [cloudinary/ssimulacra2](https://github.com/cloudinary/ssimulacra2) |
| Butteraugli | lower | [google/butteraugli](https://github.com/google/butteraugli) |
| DSSIM | lower | [Structural similarity](https://en.wikipedia.org/wiki/Structural_similarity_index_measure) |
| MS-SSIM | higher | [SSIM § Multi-Scale](https://en.wikipedia.org/wiki/Structural_similarity_index_measure#Multi-Scale_SSIM) |
| PSNR-HVS-M | higher | [Ponomarenko et al.](https://www.ponomarenko.info/psnrhvsm.htm) |
| PSNR — *reference only* | higher | [Peak signal-to-noise ratio](https://en.wikipedia.org/wiki/Peak_signal-to-noise_ratio) |
| **Ringing** — *measured here* | lower | [Ringing artifacts](https://en.wikipedia.org/wiki/Ringing_artifacts) |
| **Invented detail** — *measured here* | lower | [Ringing artifacts](https://en.wikipedia.org/wiki/Ringing_artifacts) |
| **Aspect error / reflow** — *measured here* | lower | [Cumulative Layout Shift](https://web.dev/articles/cls) |

ΔE00 is primary because colour accuracy dominates perceived quality at
placeholder fidelity, where PSNR correlates poorly. SSIMULACRA2, Butteraugli and
DSSIM are co-reported as guards: a change that improves ΔE00 while making one of
them worse has traded something real away.

The three local metrics exist because the other seven cannot answer their
questions:

- **Ringing** (`src/metrics/local.ts`) separates *smooth but wrong* from *sharp
  with artifacts*, which every aggregate fidelity score conflates. It measures
  only error that escapes the local range of the original, so a decode that is
  merely a low-pass of the reference scores **exactly zero** — that property is
  the metric, and `mise run selftest:metrics` asserts it.
- **Invented detail** (`src/metrics/spurious.ts`) is ringing's companion, and
  exists because ringing has a hard ceiling: it sees only error that escapes the
  reference's *local range*, so an in-envelope ripple, a broad wave over texture
  and a directional stripe all score zero there — and away from hard edges those
  are exactly what a truncated cosine basis produces. It measures energy the
  decode carries at frequencies the reference has none at, through the format's
  own basis, and **the ideal low-pass of the reference scores exactly zero**.
  Missing detail is free, by design: that is what the fidelity metrics charge
  for. It splits by orientation, which is how the deliberately anisotropic
  selection order (`aniso_oblique`, `sel_hv`) would show up if it were visible.
- **Aspect error** (`src/aspect.ts`) exists because `upscaleRgba` stretches every
  decode back into the reference frame before scoring, so every other metric here
  is structurally blind to a format decoding to the wrong shape.
  `spec/EXPERIMENTS.md` §7.5 recorded that gap; §7.14's U19 named closing it the
  most valuable unmeasured item.

### One caveat worth knowing about

Aspect error measures the **render grid**, not ChromaHash's aspect byte. The byte
is good to ±1.09% (spec §8.1), but the base grid rounds to integers at a 32 px
long edge, and that rounding dominates: a 3:2 source decodes to 32×21 = 1.5238,
1.59% off. Since §8.2 defines higher tiers as a bit shift of the already-rounded
base, **every tier reports the same aspect error** — a useful self-check. A
consumer reading the decoded ratio gets 1.09%; one reading the decoded raster,
which is what an `<img>` receives, gets this.

## Running it

Two prerequisites this repo does not install for you:

```bash
mise run install:iqa     # iqa-cli; ~5 min, builds vendored C++. Required.
```

Without it every run aborts up front, by design: a report with all-null quality
metrics looks complete and supports no conclusions.

```bash
mise run compare              # the standard report -> output/report.{html,json}
mise run compare:rd           # rate-distortion sweep -> output/rd-report.*
mise run compare:versions     # v0.2..v0.6 vs the working tree
mise run rd:gate              # the CI quality gate
mise run selftest:metrics     # assert the local metrics' defining properties
mise run sweep synthesis-window   # the decode-side taper, scored on artifacts
```

Useful flags on `node dist/main.js`:

| Flag | Effect |
| --- | --- |
| `--skip-harnesses` | Skip cross-language verification (what CI uses; needs no language toolchains) |
| `--images <glob>` | Narrow the corpus — the fast loop while iterating |
| `--no-artifacts` | Skip both local artifact metrics (ringing, invented detail) |
| `--no-blurred-scoring` | Skip the blur-recovery pass |
| `--allow-missing-iqa` | Degrade metrics to N/A. Preview only; never for a published comparison |

`output/` is gitignored, so nothing here is committed and there is no in-tree
baseline to diff a regeneration against — the published page is whatever CI last
built from `master`.

## Layout

```
src/
  main.ts              orchestrator + CLI
  report.ts            the HTML report shell and tabs
  report-metrics.ts    METRIC_DOCS: every metric's rationale and citation
  report-layout.ts     the Layout tab
  aspect.ts            layout fidelity
  metrics.ts           scoring config, compositing, blur, the scoring path
  metrics/iqa.ts       iqa-cli subprocess wrapper + content-addressed cache
  metrics/local.ts     ringing
  metrics/spurious.ts  invented detail
  corpus.ts            the three corpus axes
  adapters/            one per format
  rd/                  rate-distortion lineup, byte targeting, charts
  perf/                the performance harness behind spec/PERFORMANCE.md
  sweep.ts, rd-gate.ts, verify-*.ts   the research and gate harnesses
```

There is no test framework here; `TESTING.md` explains why. The gates are
`format:check`, `lint`, `tsc`, `mise run rd:gate` (a two-sided ±1% check on mean
ΔE00 against a committed baseline), `mise run verify:experiments`,
`mise run verify:benchmark`, and `mise run selftest:metrics`.
