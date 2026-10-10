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

Numbers here are produced by `mise run benchmark:session` (driver:
`tools/comparison/src/perf/`). Each harness times its own loop in-process, so no
reported figure includes process startup. Each cell is timed in several
independent processes, each reporting the **minimum** over its timed blocks —
every source of error in a wall-clock benchmark is one-sided, so the minimum is
the sample least contaminated by the host — and the reported cost is the
**median of those per-process minima**, beside their range. §0 states the
method and its revisions.

Every table below is bound to a cell in a committed run, and
`mise run verify:benchmark` checks each one. A figure that cannot be traced to a
cell cannot be published here.

> ### Measured 2026-10-10, except the cells named below
>
> **223 of this document's values are checked against a committed run**, on
> an AMD Ryzen 7 7800X3D (16 threads, Linux), from a clean tree.
> **33 table cells** are placeholders no committed run can fill yet, and so
> are **1 figures in the prose** that depend on them; all of them are named
> below rather than left for a reader to find.
>
> The revision before last carried `TBD` throughout, and the reason is worth
> keeping: the runs behind the revision before *that* were not reproducible.
> The committed baseline was a `bounded` sweep taken from a dirty tree while
> §2–§6 quoted a `--full` sweep that was never committed, and checked cell by
> cell `verify:benchmark` found **50 disagreements in 89 values**, two tables
> with no measured cell at all, and six duplicate cell ids. That baseline was
> removed rather than corrected.
>
> Re-measuring is a deliberate act, on a host that can hold a clock still — and
> the host is part of the result, so it is stated. An Apple M3 Pro laptop was
> tried and **rejected**: the same cell across fresh processes spanned 34%, the
> host drifted ~25% over a few hours, and two independent full sweeps sharing 99
> cells disagreed by more than 10% on 22 of them. This host now meets the bar on
> evidence committed to the tree: the two bounded sweeps committed at one commit
> share **128 cells**, the widest **6.0%** apart.
>
> | Claim | Reproducible from the tree? |
> |---|---|
> | Every table below agrees with a cell in `baselines/hosts/<host>/perf-report*.json`, `baselines/perf-stages.json` and `baselines/perf-decode-stages.json`, within the cell's range or ±5% | **Yes** — `mise run verify:benchmark`, cell by cell |
> | The M3 Pro's 34% / ~25% / 22-of-99 figures | **No.** That host's runs were never committed, and the machine was rejected rather than published |
> | This host's cross-run agreement | **Yes** — two bounded sweeps at one commit: 128 shared cells, widest 6.0% (`verify:benchmark`, host stability) |
>
> **How it was measured, and what that costs.** The session ran on 2026-10-09
> and 10, on the integration of every change open at the time (`d7f8efa`).
> - **The host was shared.** Other users' builds held the load at 5–20 for
>   most of the night. The driver waited out every busy spell: 6.2 hours in
>   17 waits, the longest 3.2 hours, inside a session that ran from 23:18 to
>   06:26 UTC. It measured each process round only when the 1-minute load fell
>   below 2.0.
> - **The governor and boost were not set.** The governor stayed `powersave`
>   and boost on, because the root-only steps below need a password the
>   session did not have. The preflight records both.
> - **The two checks disagree on 33 cells.** The two runs agree with each
>   other (the stability row), but 33 cells' own processes spread past the 10%
>   bar.
>   - 21 of them have a single outlier process in run 1, taken in a round
>     admitted on a 1-minute dip while the 5-minute load was 3–6. #125
>     tightens that admission rule.
>   - 5 are the `threads=auto` batch cells, which spread in both runs: sixteen
>     threads on a shared SMT host.
>
>   Those cells are **withheld**: written `TBD`, failed by name, and not
>   published until a quieter session measures them.
>
> **What is still missing:**
>
> | Cells | Why |
> |---|---|
> | the 33 withheld cells, and the 1 prose figure resting on one | their own processes spread past the 10% host bar (`verify:benchmark` names each with its spread) |
> | §7 and §8's **Swift** rows | its binding consumes a UniFFI xcframework only `xcodebuild` can assemble, so it is empty on **every** run made off macOS — `ci-swift.yml` on `macos-latest` is where Swift is measured. These are marked *macOS only* rather than `TBD`: they are not pending anybody's run, and a macOS session commits its own host directory (below) |
>
> **`mise run verify:benchmark` therefore still fails**, on the withheld
> cells and nothing else, so `ci-comparison.yml` keeps `continue-on-error`. A
> Linux runner can never satisfy this gate while the Swift rows are bound, so
> the gate reports an unreachable target's rows as **unavailable** rather than
> failed. A session on a quieter host, with the root-only steps below taken,
> fills the rest: `mise run benchmark:session`, from a clean tree — §0 below.

## 0. Procedure and methods

**The session.** One command re-measures the document, after the root-only
steps that hold a clock still. The driver never runs `sudo`; these are yours:

```bash
# On the measuring host, as root, once per boot. Each sysfs switch exists only
# for the frequency driver that owns it.
echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
echo 0 | sudo tee /sys/devices/system/cpu/cpufreq/boost           # acpi-cpufreq, amd-pstate passive
echo 0 | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/boost      # amd-pstate active (per policy)
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo   # intel_pstate
# Optional: SMT off, or pin the harnesses to one thread per core below.
echo off | sudo tee /sys/devices/system/cpu/smt/control

mise run benchmark:session                  # or: mise run benchmark:session --pin 2,4,6,8
```

It runs, in order: a preflight; two `bounded` sweeps (the host-stability
pair); the `full` supplement; `benchmark:stages` for §1's three columns
(`100 100 1`, `512 512 1`, `512 512 4`) and `benchmark:decode-stages` for
§1.1's (`100 100 1 2000`, `100 100 4 20`, `100 100 4 200 32x32`); a copy of
the sweeps into `baselines/hosts/<host>/`; `verify:benchmark --fix`; and
`verify:benchmark`, whose status it exits with. Review the diff, set §0's
stability row to **Yes** with the figures the gate prints, and commit.
`--scratch DIR` runs only the sweeps, into `DIR`, to smoke-test the procedure;
every other flag is passed to the sweeps.

It decides, before measuring, whose document this is. `baselines/hosts/PRIMARY`
names the host the figures speak for, and a session changes it only when told
to with `--set-primary` (or when there is none yet). On any other host the
session commits a secondary set — read only for the targets the primary
records absent, which is how a macOS session fills the Swift rows — and leaves
PRIMARY, the stage files and the document's figures alone; it used to repoint
PRIMARY at whichever host ran last.

The order is no longer load-bearing. This block used to be fifteen commands —
sweeps first, then stages, then the copies — because every recorder stamped
`git.dirty` and a copied-in baseline dirtied every recording after it. Every
recorder now leaves the measurement outputs (`baselines/hosts/`, the two stage
files) out of its dirty probe: an output is not a source.

**Preflight and load.** Before measuring, the driver reads the load average
(Linux and macOS), the cpufreq governor, boost (the global switch,
`intel_pstate/no_turbo`, or amd-pstate's per-policy `boost`) and SMT. The bar
is a 1-minute load of one runnable task per eight hardware threads, never
below 1. The session **waits** for the load to fall under it — after the
build, before each sweep and **before every process round**, and before the
stages — for up to `--load-timeout` seconds (default 1800) each time, and
stops with what it saw if it does not. Refusing instead stopped the session at
its second sweep: the 1-minute average decays over about a minute, so it is
still high after the build and after each round's `threads=auto` batch cells.
Run alone, the driver refuses a loaded host unless given `--wait-for-load`;
`--force-loaded` starts anyway and marks the run `loaded`. A governor other
than `performance`, boost on and SMT on are reported, not refused — they need
root. All of it, with `rustc --version`, the kernel, the seconds waited, and
the load average at the start, at every process round and at the end, is
recorded in the run's `environment.preflight`. `--pin CPULIST` runs every
harness under `taskset -c`.

The gate does not take the driver's word for it. It recomputes the bar from
the run's own core count — so `--max-load 50` does not move it — and holds the
start and every round to it, so a run that started quiet and became loaded
fails. (The end reading is recorded and not held: it trails the run's own
batch cells.) It rejects, as a failure rather than a printed note, a `/3` run
with fewer than four processes, an odd number, or fewer than five blocks; one
with no git commit, digest and dirty bit; one with no preflight; and any
`--quick` or `/1` run, under any file name.

**Method (`chromahash-perf/3`).** One pilot sizes a cell's timed block to
about 200 ms. The cell is then measured in **P independent processes**
(`--processes`, default 4) of five timed blocks each (`--reps`), after the
harness's warmup; each process reports its minimum block, and the cell
reports the **median of the per-process minima**. Processes are interleaved
**round-robin** across every cell, so a drift over the sweep lands on every
cell a little instead of on whichever ran last.

Beside the median the run records the **range** of the process minima — not a
confidence interval. The range of n independent draws holds their median with
probability 1 − 2^(1−n): 87.5% at four processes, 75% at three. The run stores
that coverage beside the range. An earlier draft of this revision called the
range a "bootstrap 95% interval", which with three processes it could not be.
A cell is **noisy** when its process minima spread more than 5%. Its range then
never widens what a documented value may be, so it is checked on the band
alone.

**A cell whose own processes spread past the host bar is withheld, not
published.** Past 10%, a cell's processes disagree by more than two runs of
the host are allowed to, so no figure taken from it is reproducible to this
document's resolution, however well it agrees with the run. The gate fails
every value resting on such a cell (or on a pair whose A B / B A blocks spread
that far) by name, with the spread. `--fix` writes `TBD` in its place, and
leaves a `TBD` that is already there. This is a property of the cell, not of
the run, so `--fix` still writes every other value. The summary counts these
apart from other placeholders ("withheld for process spread"), and they stay
failing until a quieter session measures them.

The stability pair and the per-cell spread are **separate checks**. The pair
asks whether two runs of the host agree cell for cell, and its 10% is between
runs. The spread asks whether one cell's processes agree within a single run.
A session can pass the first and still withhold cells under the second: the
2026-10-10 session's pair agreed within 6.0% on all 128 shared cells, while
21 cells had one outlier process in one of the two runs.

The `threads=auto` batch cells may be **structurally unpublishable on a shared
SMT host**: they put a runnable thread on every core, so they compete with
whatever else the host runs, and they spread past the bar in both runs of that
session. That is the same kind of fact as Swift off macOS, about the host
rather than the code. Unlike Swift there is no exemption: they stay withheld,
and failing, until a session on a quieter host measures them within the bar.
No `/3` figure is drawn by bootstrap, so the resample count `stats.ts`
defaults to does not reach this document. The committed `/2` baseline's
`ci95NsPerOp` fields were bootstrap draws at 1,000 resamples — `stats.ts`'s
default at `e53e6cd`, whatever it is now, and not re-drawn since.
They describe the median of one process's blocks, and the gate reads none of
them.

A ratio is measured as one. A lever and the cell it is divided into — every
§4 and §12.4 arm and its base, §6's separable DCT, §5's scalar and SIMD
builds, §2's natural and capped decodes, §8's one-thread and auto batches —
form a unit whose processes run back to back, in reverse order every other
round: rounds 0 and 1 run a pair A B, then B A, and so do rounds 2 and 3. The
run stores each such ratio as a **paired record**. The record holds each
round's base minimum over that round's arm minimum, and the ratio is their
**geometric mean over complete A B / B A blocks**. Whatever running second does
to a member multiplies one order's ratio by about what it divides the other's
by, so the order effect cancels. The record also holds each block's ratio, the
blocks' range (two blocks cover the median half the time, so this is a range
too) and their spread. A pair whose blocks spread past 5% gets no range
acceptance, and one whose blocks spread past 10% is withheld, as for a cell. The
ratio used to be the median of the rounds. With three rounds (A B, B A, A B)
that is an A B round, carrying any order effect whole, which is why the count
is now even. These records are what §2's saving, §4's "vs shipped", §5's gain,
§6's and §12.4's speedups and §8's scaling read. A `/3` run without the record
for a ratio it publishes is missing a measurement and fails; only a `/2` run,
which recorded no pairs, is read as a ratio of two cells.

**One measurement, one cell.** A lever table's `shipped` arm is the base cell
under another name — `encode/Rust/t1/100x100/gradient/shipped` is
`encode/Rust/t1/100x100/gradient`, and `decode/Rust/t1/natural/shipped` is
`decode/Rust/t1/natural` — so it is now recorded as an alias and measured
once. They used to be measured twice and quoted from different cells in
different sections; a run old enough to hold both is checked for the two
agreeing within 10%.

**The full run is a supplement.** `--full` measures only the cell ids the
bounded matrix does not hold — tier 3 and 4 across languages, the 128×128 and
1024×1024 sources, two, four and eight batch threads — so committing it fills
the cells only it can produce and re-baselines nothing. It used to re-measure
every bounded id as well, and the gate preferred its value, so filling six
cells rewrote two hundred. The gate fails a full run that holds a bounded id.

**What it costs.** By the harness's own budget (pilot, warmup, blocks), a
bounded sweep at four processes on this host is about twenty minutes, up from
about seven for one process per cell, and the full supplement about a quarter
of an hour. The load waits add a few minutes per sweep, mostly after rounds
that end in the `threads=auto` batch cells. A whole session, builds and stage
recordings included, is about an hour and a half. These are estimates from
that budget, not measurements; each run records its own `wallSeconds` and the
seconds it waited.

**How a figure is checked.** A documented value passes when it is the
measured value rounded as written, when it lies inside the cell's range, or
when it is within **±5%** of the committed run. The 5% is half of the 10% host
bar, and it is a resolution chosen rather than a noise level measured: a
figure is rewritten only when it moved more than half of what the bar lets
two runs of the host differ by, and a change the size of the bar always is.
How many figures a re-run on this host moves past it is not known yet — the
one pair of sweeps this host has compared was never committed, so that
agreement is unverified — and the first committed pair will say. A stage share
passes within half a point, whatever its size: §1 records two
recordings back to back agreeing within 0.4 points. A percentage that is a
difference of two timings (§4's "vs shipped", §5's "2%") is held to the same 5%
on the ratio it stands for — §4's −36.3% is 0.637×, so ±3.2 points. A ratio or
timing percentage that states a direction must also keep it: a figure written
as a speedup fails against a measured slowdown however small the difference,
and `--fix` writes the measured side; one that rounds to 1× or 0% as written
states none. `--fix` rewrites only what is outside. It refuses to write at all
while the committed runs themselves fail — untraceable or stale provenance, a
dirty tree, a loaded round, too few samples, a rejected run, no preflight,
cross-run spread or a failed stability pair — because agreeing with a run the
gate refused would carry its figures into the document. A withheld cell is
not one of these: it is written as `TBD` and the rest of the fix goes ahead.
That is the document's
resolution, stated: a claim within 5% of 1 — §5's SIMD gain — is checked to
"within 5%" and to its sign, no finer. Every figure the prose restates is bound
the same way, and one that needs a measurement nobody has committed is written
`TBD` and fails by name.

**Per-host baselines.** Sweeps are committed under `baselines/hosts/<host>/`,
where `<host>` is the run's OS, architecture and CPU model, slugged; each run
also records a one-way hash of the machine id, and two machines with one CPU
model fail the stability check. `baselines/hosts/PRIMARY` names the host this
document is measured on: its bounded runs are authoritative and its full run
supplements them. Spread and stability are checked within a host, never
across, so a macOS session can commit `baselines/hosts/darwin-arm64-…/` beside
this one, and is read only for targets the primary host records absent —
which is how the Swift rows will be filled, and why they stay *macOS only*
until then. Any host whose cells are read must have a passing stability pair
of its own, the secondary as much as the primary; only a host whose runs are
all the legacy `/2` format — the committed one, labelled "No" above — is
exempt.

**Provenance survives a squash merge.** Pull requests here are squash-merged,
so the commit a run was taken at is unreachable from `master` once it lands:
the committed baseline records `e53e6cd`, the stage files `4d68c1f` and
`8f5f4d1`, and none is an ancestor of `master`. Every recorder now also
records a SHA-256 over the files that decide a measurement (`rust/`,
`bindings/`, every harness's language directory, the driver and the stage
recorder, and the tasks that build and run them — `.mise.toml` and
`mise-tasks/benchmark/`; `perf/provenance.ts` lists them), less documentation:
a README or a `docs/` page cannot move a figure, so editing one does not orphan
a baseline. The gate accepts a run whose commit is an ancestor of `HEAD` and
has that digest, or — when the commit is not reachable — whose digest some
commit in `HEAD`'s history has. So: **measure on a branch rebased onto
`master`, and land it before `master`'s measured sources move.** That is now
checked before the merge rather than discovered after it: a change that adds
or changes a baseline must have measured it on `HEAD`'s own sources, and in CI
`HEAD` is the pull request merged into the current `master`, so a run that went
stale while its PR was open fails there, and the fix is to rebase and
re-measure. A run from before digests is reported (`LEGACY`) and not failed.
`e53e6cd`'s harness sources are `ec2b290`'s, but its branch's `.mise.toml` and
`mise-tasks/benchmark/stages` never reached `master` in that form, so under the
current digest it is traceable only by its PR ref.

**Methods revisions.** `chromahash-perf/1` reported each cell's median block.
`chromahash-perf/2` (2026-09) reported the minimum block of one process, on
the one-sided-error argument above: on the rejected M3 Pro, ten fresh
processes timing one cell put the minimum within 0.1% while the median of the
same blocks spanned 34%. `chromahash-perf/3` (this revision) samples
processes, not only blocks: the minimum of one process left the variance
between processes — a different core, heap layout or moment in the host's
thermal cycle — unsampled, its "interval" was a CI of the median of its
blocks rather than of the figure reported, and its `noisy` flag was never
read. It also pairs ratios over A B / B A blocks, makes `--full` a
supplement, keys baselines by host, records the host's state and a source
digest, and checks documented figures against a range or a band instead of
exactly. The gate reads `/2` and `/3`, and a host's runs must share one. A
`/2` cell has no range, so it is held to the ±5% band alone; the gate lists
every bound cell the driver flagged noisy, and holds `/2` to none of the `/3`
record requirements above, which it predates.

---

## 1. The headline: where encode time goes

`mise run benchmark:stages`, gradient source, share of one encode. The
instrumented build asserts it still produces the shipped bytes before reporting
anything.

> Bound, as of this revision. `benchmark:stages` now writes
> `baselines/perf-stages.json` and `verify:benchmark` checks every cell here
> against it. It had been the one table nothing checked, which was the worst
> possible one to leave open: §10's whole ordering rests on it.
>
> **Provenance.** All three cells were re-measured at **`4d68c1f`**, which the
> artifact records and the gate checks for uniformity across the three columns,
> from a clean tree with the recorder's fixed dirty probe. They were re-measured
> because the table changed shape: the four rows from `dc_search` down were one
> unmarked residual, `quantize_and_pack`, until that revision's encoder gave
> them marks.
>
> The encoder they describe is the one `master` ships. This revision adds
> §12.4's levers, all off by default, and before recording anything the shipped
> path was timed against `master`'s own build on the same host, stage by stage:
> at 512×512 every shared stage agreed within noise, and so did the whole
> encode at 100×100 tier 1 and tier 4 and a tier-4 decode. (That check caught
> two places where the lever code *had* moved the shipped path — by more than
> 10%, once in each direction — and both were fixed before these cells were
> taken.)
>
> **The host was not idle, and that is not free for shares either.** Its load
> average was about 2.5 of 16 threads, in bursts. One recording taken during a
> burst moved `linearize` at 512×512 from 5.4% to 7.0% and `ac_quantize` at
> 100×100 from 37% to 44% — a share is a ratio inside one process, but load
> does not slow every stage alike. So the three columns were recorded twice,
> back to back, and kept only because the two agreed: every share within 0.4
> points, every total within 2.2%. The second is the one committed. As with §0's
> stability claim, the first run is not committed, so that agreement is a
> statement about the host at the time rather than something this tree can
> re-derive. Against the previous, quieter recording at `e53e6cd` the totals
> land within 0.6% at 512×512; at 100×100 they are 9% lower, and `master`'s own
> build measures the same ~2.5 ms on this host today, so that gap is the host
> and toolchain since then, not the code.

| stage | 100×100 t1 | 512×512 t1 | 512×512 t4 |
|---|---:|---:|---:|
| `eotf_lut` | 0.6% | 0.0% | 0.0% |
| `linearize` | 0.6% | 5.4% | 0.2% |
| `oklab_forward` | 2.5% | 6.9% | 0.2% |
| `alpha_average` | 0.2% | 0.4% | 0.0% |
| `composite` | 0.5% | 4.3% | 0.1% |
| `selection` | 0.6% | 0.0% | 0.1% |
| `cos_tables` | 0.3% | 0.1% | 0.0% |
| **`dct_forward`** | 60.5% | 79.8% | 96.7% |
| `dc_search` | 0.2% | 0.0% | 0.0% |
| `ac_quantize` | 33.9% | 1.9% | 2.6% |
| `refine` | 0.0% | 0.0% | 0.0% |
| `pack` | 0.0% | 0.0% | 0.0% |
| `unmarked` | 0.0% | 2.1% | 0.1% |
| total | 2.36 ms | 47.20 ms | 1845.11 ms |

**Every row but `unmarked` is a `stage!` mark, and the marks now cover
`encode_with` end to end.** Until this revision the last four stages —
`dc_search` (the decode-aware DC code search), `ac_quantize` (every AC scale and
code search: `scale_fit`, `ac_nearest`, the alpha plane, CfL), `refine` (the
pixel-domain refinement, off in the shipped build) and `pack` (the body
allocation and every bit written into it) — were one residual,
`quantize_and_pack`, computed as `whole_encode − stage_sum`. That made it an
*upper bound* on four kinds of work at once, and it was the only size §12.1
items 1, 2 and 7 had. They now have their own. **`unmarked` is the residual
that remains, and it names no search:** it is the return from `encode_with`,
which frees every per-pixel buffer the encode allocated, plus the timers' own
overhead — negligible at 100×100, and 2.1% at 512×512, where the buffers are
megabytes each.

**The forward DCT is the encoder, above thumbnail size.** 60% of a 100×100
encode, 79% at 512×512, and **97%** at 512×512 tier 4 — the share rises with both
size and tier. That is what orders §10: a lever that does not touch
`dct_encode_selected` cannot be worth much at any size a caller actually
encodes, however elegant.

**Two qualifications the measured table adds**, and an earlier revision of this
paragraph asserted past both by calling every other stage "a rounding error at
any size or tier that matters":

* **At 100×100, `ac_quantize` is 33.9%** — the scale and AC code searches,
  not a rounding error at all, and now measured rather than bounded: the rest
  of the old residual (`dc_search`, `refine`, `pack`, `unmarked`) is under half
  a point together. That is exactly the trap §4 documents, and it is
  why the encoder-only levers look decisive on a thumbnail and vanish on a
  photograph.
* **At 512×512 the per-pixel colour pipeline is 16.0%** — `linearize` 5.4%,
  `oklab_forward` 6.9%, `composite` 4.3%. Only the middle one has a SIMD
  backend, which bounds what §5 can buy before §5 is measured at all: the
  `simd` feature covers 6.9 points of a 100-point budget at the size a caller
  most often encodes.

### 1.1 Where decode time goes

`mise run benchmark:decode-stages`, share of one decode. The fixture is a
100×100 gradient encoded at the column's tier, then decoded at its natural
raster or capped at 32×32; decode cost depends on the tier and the raster, not
on the source's size. Before timing anything the instrumented build decodes
every shared decode vector in `spec/test-vectors/` and must reproduce the
spec's bytes, and the artifact records how many it did.

> **Provenance.** Bound to `baselines/perf-decode-stages.json`, recorded at
> **`8f5f4d1`** from a clean tree, all three columns at that one commit; the gate
> checks both, and that each cell reproduced the spec vectors. The recorded
> iterations are 2000, 20 and 200 — inversely to the cost of one decode, so each
> column times a comparable interval.
>
> **Shares only, at whole-percent precision.** The host was loaded while these
> were recorded, so no absolute decode time is published here; §2 remains the
> source for those. Load moves shares too, least for a stage whose cost is
> fixed: re-running the tier-1 column on the same host moved `render` by tens of
> microseconds between runs while `gamma_lut` held within a few, so the tier-1
> split between those two rows is the least stable figure in the table. Those
> re-runs are not committed; only the recorded run is checked.

| stage | t1 natural | t4 natural | t4 capped 32×32 |
|---|---:|---:|---:|
| `header` | 0% | 0% | 0% |
| `selection` | 4% | 1% | 38% |
| `ac_dequant` | 0% | 0% | 1% |
| `window_filter` | 0% | 0% | 0% |
| `cos_tables` | 1% | 0% | 0% |
| `gamma_lut` | 59% | 0% | 4% |
| **`render`** | 35% | 99% | 57% |
| `unmarked` | 0% | 0% | 2% |

Every row but `unmarked` is a `stage!` mark in `decode.rs`'s `render_at_size`,
and the marks cover that function end to end: `header` (the descriptor, DC and
scale fields), `selection` (sorting the candidate list and taking each
channel's prefix), `ac_dequant` (reading and dequantizing every AC code),
`window_filter` (the synthesis window and the frequency filter),
`cos_tables`, `gamma_lut` (building the output gamut's 4096-entry transfer
table) and `render` (the `O(w·h·K)` loop, with the output buffer it fills).
**`unmarked` is a residual, like §1's, and names no work:** it is the return
from `render_at_size` and the timers' own overhead.

**At the default tier, most of a decode is not the decode.** `gamma_lut` is
**59%** of a tier-1 decode — the transfer table is rebuilt on every call, 4096
evaluations of the gamma curve for a 32×32 raster of 1024 pixels, and it costs
more than the render loop it serves (`render` is **35%**). The table depends only
on the output gamut, so it is the same table every time.

**At tier 4 the render loop is the decode:** **99%** of a natural tier-4 decode,
everything else together about one point. **Capping moves the cost, not only
the size:** at 32×32 the render loop shrinks and `selection` — which sorts the
full tier-4 candidate list whatever the raster — is **38%** of what remains.

The render loop is one mark on purpose. Splitting it into its inverse DCT and
its per-pixel colour conversion would take a timer per pixel or a second loop,
and either would measure a decoder this crate does not ship; §12.1 item 4 is
sized with that limit stated.

## 2. Cost per tier

100×100 sRGB gradient — the fixture the old benchmark used exclusively.

| tier | bytes | encode | decode |
|---|---:|---:|---:|
| 0 (compact) | 21 | 1.41 ms | 0.24 ms |
| 1 (default) | 32 | 2.46 ms | 0.28 ms |
| 2 | 108 | 7.10 ms | 1.19 ms |
| 3 | 411 | 25.97 ms | 15.42 ms |
| 4 | 1623 | 110.38 ms | 233.80 ms |

Decode grows roughly `4^level`, as `4^level` coefficients over a `4^level`
raster predicts. A tier-4 decode is the most expensive single operation the
format asks for, and it is asked for to render a placeholder.

### Capped decode is the mitigation, and it is undocumented as such

Rust decode, natural against capped to 32×32:

| tier | natural | capped 32×32 | saving |
|---|---:|---:|---:|
| 0 | 239 µs | 240 µs | 1.00× |
| 1 | 279 µs | 276 µs | 1.00× |
| 2 | 1191 µs | 469 µs | 2.53× |
| 3 | 15415 µs | 1492 µs | 9.81× |
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
| 64×64 | 1.48 ms | 362.35 ms |
| 100×100 | 2.46 ms | 246.12 ms |
| 128×128 | 3.65 ms | 222.68 ms |
| 256×256 | 12.32 ms | 188.03 ms |
| 512×512 | 46.74 ms | 178.29 ms |
| 1024×1024 | 185.96 ms | 177.34 ms |

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
| dc_search=0 | 2.44 ms | 0.0% | — |
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

This is §1 restated: the searches live in `ac_quantize`, and can only ever
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
| 100×100 | 1 | 2.46 ms | 2.39 ms | 1.02× |
| 256×256 | 1 | 12.32 ms | 12.61 ms | 1.02× |
| 512×512 | 1 | 46.74 ms | 47.63 ms | 1.02× |
| 512×512 | 0 | 29.19 ms | 30.13 ms | 1.03× |

**2%, and flat across every size measured.** `src/simd/` is four hand-written
backends (AVX2, SSE2, NEON, wasm simd128), a `simd-diff-tests` feature that
fails rather than skips, and a QEMU/wasmtime emulation matrix in CI. It covers
exactly one of the encoder's twelve marked stages — `oklab_forward` — and §1
now prices that stage at **6.9%** of a 512×512 encode. So the ceiling was 6.9%, the
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
| 100×100 | 2.45 ms | 1.04 ms | 2.26× |
| 256×256 | 12.31 ms | TBD ms | TBD× |
| 512×512 | 46.70 ms | 12.68 ms | 3.68× |

**The prediction holds.** The saving grows with size exactly as the `K / Cx`
argument says it should: 2.26× → TBD× → 3.68×. At 512×512 it takes **34.0 ms
off an encode**, working on the stage §1 prices at 79% of the work. The shipped
`simd` feature works on the 6.9% stage and takes nothing measurable off the same
encode: the byte-identical speedup §5 measures for it is 2%, inside the 5% band
this document holds a figure to.

**It is no longer the largest lever, and it is not the one to adopt.** §12.4's
`accel_dct_lanes` vectorises the same forward transform across coefficients,
and it keeps each coefficient's own summation order, so it is byte-identical by
construction and by test. All seven byte-identical levers together, with
`accel_dct_lanes` doing nearly all of it, measure **7.58×** at 512×512. That is
about twice the separable factorisation, at no format cost. §12 set out the
tension of a large lever that costs a version bump. It has resolved in favour
of the byte-identical one, and register entry D4 is decided as not adopted
(`V0.8-DECISIONS.md`, A1).

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
| Rust | 1339 µs | 2461 µs | 7100 µs | 279 µs | 1191 µs |
| Rust (scalar) | 1466 µs | 2388 µs | 7184 µs | 274 µs | 1170 µs |
| Go | 1410 µs | 2456 µs | TBD µs | 279 µs | TBD µs |
| C# | 1411 µs | 2453 µs | 7070 µs | 278 µs | 1283 µs |
| Kotlin | TBD µs | 2558 µs | 7170 µs | 288 µs | 1247 µs |
| Swift | *macOS only* | *macOS only* | *macOS only* | *macOS only* | *macOS only* |
| Python | TBD µs | TBD µs | TBD µs | TBD µs | 1334 µs |
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
| Rust | 2445 µs | TBD µs | TBD× |
| Rust (scalar) | 2378 µs | TBD µs | TBD× |
| Go | 2335 µs | TBD µs | TBD× |
| C# | 2453 µs | TBD µs | TBD× |
| Kotlin | 2538 µs | TBD µs | TBD× |
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
   the byte-safe half of it needs no format change. That half is now built and
   measured. §12.4's levers, `accel_dct_lanes` above all, make a 512×512 encode
   about 7.6× faster at the same bytes. Turning them on by default is the 1.0
   speed change: patch-legal and with no wire change.
2. **The separable transform** (§6): **3.68× at 512×512**, now measured,
   growing with size as its own `K / Cx` argument predicts. It costs a format
   version, and the byte-identical lever in item 1 is about twice as fast. It
   is decided as not adopted (register D4, under the 1.0 freeze).
3. **Reconsider `ac_nearest` and per-tier `scale_fit`** (§4), for small inputs
   only. Their quality effects are at or below the noise floor at the default
   tier, and their time cost vanishes at photo resolution.
4. **SIMD in decode** — there is none. `decode.rs` runs a scalar per-pixel OKLAB
   inverse plus three gamma lookups inside the `O(w·h·K)` render loop, and at
   tier 4 decode is the more expensive half (§2). §1.1 adds that at the default
   tier the larger cost is not that loop but a gamma table rebuilt on every
   decode (§12.1 item 4).
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
encode and **97%** at tier 4; `ac_quantize` is **33.9%** of a 100×100 one;
the per-pixel colour pipeline is **16.0%** at 512×512; and the shipped `simd`
feature buys **1.02×** because it covers 6.9 of those points.

All four are now marked stages. The second used to be a residual,
`quantize_and_pack`, which held the quantizer searches *and* the DC search, the
bit packing, the buffer frees and the instrumentation's overhead, so it could
only ever be a ceiling on a bucket; §1 now splits it, and the searches are
33.9 of its old 37.5 points at 100×100.

### 12.1 Byte-identical — legal in a patch release

Each of these produces the same bytes by construction, so `spec/test-vectors/`
and `mise run rd:gate` are sufficient evidence, and no version moves.

| # | Where | What | Why it is safe |
|---|---|---|---|
| 1 | `mulaw.rs:50` ← `encode.rs:652` | **Precompute the dequantization table, keyed on `(bits, index)`.** `mu_law_dequantize(index, bits, mu)` is a pure function of its arguments, and `mu` *is* fixed for a channel (`t.mu_l`) — yet `scale_fit=2` calls it inside a 63-code search over every coefficient, each call a `portable_pow` = a 20-term series plus a degree-25 Taylor polynomial. **`bits` is not fixed:** `AcQuantJob::bits_at(i)` (`encode.rs:682`) walks the job's tier list and returns a width that varies with the selection index. `LAYOUT_C` (`constants.rs:193`) is `l_tiers: [(8, 6), (14, 5)]` — 6-bit low band, 5-bit high band, one channel, reachable through `Tunables::layout_upper` and exercised by `constants.rs:863`. A table keyed on the index alone would hand the high band the low band's grid and dequantize it wrongly. Two widths per job at most, ≤ 2^6 − 1 = 63 indices each, so ≤ 128 entries — not the "≤ 32" an index-only table suggests. | The table holds the same values the calls return, *provided* `bits` is part of the key |
| 2 | `mulaw.rs:6`, `encode.rs:682,694` | **Hoist the loop-invariants.** `mu_compress` recomputes `portable_ln(1.0 + mu)` on every quantize call for a constant `mu`; `bits_at`/`gain_at` walk the tier list per index per call. Note this is the *same* walk item 1 must key its table on: it is an inefficiency worth removing and a correctness constraint at once, so the two entries have to land together. | Same values, computed once |
| 3 | `dct.rs:251` | **Vectorize across coefficients, not pixels.** The inner sum must keep its exact left-to-right order, which is why `simd/mod.rs` never touched it. Lanes over *distinct `(cx, cy)` pairs* preserve each coefficient's own order and are as parallel as the per-pixel case. | Per-lane arithmetic is unchanged; only which coefficient a lane holds — **but the arithmetic argument alone is not sufficient, and two things break it.** (a) **FMA contraction.** The kernel is `f += channel[x + y*w] * cx_row[x] * fy`; fusing the multiply-add keeps one rounding instead of two and changes the result. Rust does not contract today, but intrinsics backends are written by hand and `fmadd` is the obvious instruction to reach for. The lanes must use separate multiply and add. (b) **Regrouping.** `channel * (cx * fy)` is the natural vector form and is *not* `(channel * cx) * fy`; float multiplication is not associative, and this repo ships four hand-written backends that would each have to resist the same simplification. Both belong in the vector-diff gate, not in review |
| 4 | `decode.rs:22,420`; `decode.rs:447`, `dct.rs:370` | **Decode, in two parts sized by §1.1.** (a) **Build the gamma LUT once per output gamut, not once per decode.** `build_gamma_lut` evaluates the transfer curve 4096 times — each a `portable_pow` for sRGB and Display P3 — on every call, and §1.1 measures it at **59%** of a default-tier decode, more than the render loop itself. It is a pure function of the gamut, so a table built once (or generated) holds the same 4096 bytes. `average_color` (`decode.rs:660`) builds the same table to convert one pixel. (b) **Flatten `cos_x`/`cos_y`, and vectorize the render loop.** They are `Vec<Vec<f64>>`, a pointer chase per coefficient per pixel in the `O(w·h·K)` loop, and there is **no SIMD in decode at all** — a scalar per-pixel OKLAB inverse plus three gamma lookups. §1.1 puts that loop at **99%** of a natural tier-4 decode, the operation §2 prices at 234 ms, so (b) is bounded by 99% there and by 35% at tier 1. §1.1 does not split the loop's inverse DCT from its colour conversion, so how that bound divides between flattening and SIMD is not measured. | (a) the same function of the same argument, computed fewer times; (b) a layout change reads the same values; a vector colour conversion is byte-identical only if it keeps the scalar path's operation order, and would need the differential tests `simd/` already runs for encode |
| 5 | `encode.rs:934` | **Early-exit `sse_with_delta`.** `acc` accumulates monotonically and the caller keeps only strict improvements, so it can abort the moment `acc >= best`. Off by default (`refine_passes: 0`) but §4 measures refinement at **20–37 ms against 2.45 ms shipped**, and it is what the `refine-*` sweeps spend their time in. | Changes when the loop stops, never which code wins |
| 6 | `encode.rs:260,320,328,369` | **Fuse the first three per-pixel passes; `composite` cannot join them.** Four full `W·H` passes and **eight** `W·H` allocations — `lin_r`/`lin_g`/`lin_b`/`alpha_pixels`, `oklab_pixels` (3 f64 each), `l_chan`/`a_chan`/`b_chan` — which is 10 f64 per pixel, or **20 MiB** at 512×512, for a stage §1 prices at 16.0%. **An earlier revision of this row said `linearize` and `composite` fuse. They do not:** `composite` (`encode.rs:369`) reads `avg_l`/`avg_a`/`avg_b`, which are the *completed* `alpha_average` reduction (`328`) after its normalization by `avg_alpha` (`340`). A full-array barrier sits between exactly the two passes that row paired, and fusing across it would composite against a running partial mean — different bytes, not merely a different order. What is available: fuse `linearize` + `oklab_forward` + `alpha_average` into one tiled pass, and drop `alpha_pixels` entirely by re-deriving alpha in `composite` from `rgba[i*4+3] as f64 / 255.0`, the identical expression. That is 8 buffers → 4 and 4 passes → 2; `oklab_pixels` must survive the barrier and cannot be tiled away. | Elementwise work in unchanged order, **and** the reduction still accumulates in flat pixel index order — which holds only if the tile length is a multiple of the SIMD lane count, so no pixel moves between `oklab_forward_batch`'s vector body and its scalar tail. `composite` stays a separate pass; nothing about this makes the barrier crossable |
| 7 | `bitpack.rs:3` | **Word-at-a-time bit writing**, against the current divide-and-modulo per bit. Correct and genuinely small — ≤1623 bytes — and listed for completeness rather than for its size. | Same bits |

Items 1 and 2 are the ones worth doing first, and not because they are the
largest: they sit inside `ac_quantize`, which is 33.9% of a thumbnail encode
and 1.9% of a photograph. That is the shape §4 already documents for the
encoder-only *quality* levers, and it applies to their cost too.

**Measured (§12.4).** `accel_quant_table` makes a 100×100 tier-1 encode **1.39×**
faster and a 512×512 one **1.01×**; at tier 4 it is **1.41×**, where the
quantizer searches ~16× the coefficients over the same source. Item 7,
`accel_word_bitpack`, measures **0.98×** at 100×100, against a `pack` stage that
rounds to nothing in §1. Each is a paired ratio from §12.4's tables, and each
reads `TBD` — failing the gate by name — until a committed run holds it.

**37.2% is now the stage these two levers act in, not a bucket they share.**
Until §1 marked it, the only figure was `quantize_and_pack`'s 37.5% — a
residual that also held the DC search, the bit packing and the buffer frees,
and so only an upper bound. The marks settle two more things the residual hid:
item 7 acts in `pack`, which rounds to **0.0%** in every column of §1 — it was
listed for completeness, and its stage confirms it — and the DC search, which
no lever touches, is `dc_search` at 0.2%. A stage is still a ceiling, not a
speedup: how much of `ac_quantize` items 1 and 2 remove is §12.4's to measure,
and the figures above are that measurement, pending (§12.3).

### 12.2 Format changes — v0.8 work

| # | Where | What | What it costs |
|---|---|---|---|
| 8 | `dct.rs:424` | **Adopt the separable forward DCT.** §6 measures **3.68× at 512×512**, growing with size. Prototyped, and byte-identical over 40 encodings spanning five tiers and three content classes. | Reassociating float addition is not *guaranteed* to preserve quantized codes, and spec §10/§12.6 pin the direct summation as normative. Version bump, regenerated vectors, nine languages together |
| 9 | `encode.rs:437` | **Downsample before the transform.** There is none: `dct_encode_selected` runs over the full source, so encode is `O(K·W·H)` in the *original's* pixels — 46.7 ms for one 512×512 image, and §3's per-megapixel column is what a caller encoding 12 MP originals actually pays. `refine_grid`/`resample_channel_dct` (`encode.rs:1023`) already gesture at the machinery | Changes the coefficients, so it changes every hash |

### 12.3 What this list does not claim

* **Items 1–7 are built, bound and measured.** #8 is prototyped behind
  `Tunables::dct_separable`; items 1–7 are built (§12.4), each behind its own
  flag and each held to the shipped bytes. Measured, all seven levers together
  measure **7.58×** on a 512×512 encode and **2.94×** on a default-tier decode,
  and do nothing for a natural tier-4 decode, whose render loop no lever yet
  touches. A lever cell whose own processes spread past the host bar is
  withheld as `TBD` (§0) until a quieter session measures it. The stage shares
  above are bounds; §12.4's ratios are the measured speedups.
* **The byte-identical column is an argument, not a proof** — and for items
  1–7 it is no longer only an argument. §12.4 lists what now checks "did not
  move" for each; "cannot move" and "did not move" are different claims, and
  this repo has a gate for the second one.
* **Decode is measured by stage, not below it.** §1.1 is the decode
  equivalent of §1, and item 4 is sized from it rather than from reading
  `decode.rs`: the gamma LUT is **59%** of a default-tier decode and the render
  loop **99%** of a tier-4 one. What §1.1 cannot say is how the render loop
  divides between its inverse DCT and its colour conversion, so item 4(b)'s
  two halves share one bound. §1.1 also publishes no absolute time: its shares
  were recorded on a loaded host, and §2's 234 ms is still the only measured
  tier-4 decode time.

### 12.4 The byte-identical levers, built

§12.1's items 1–7 exist in `rust/`, each behind a `Tunables` flag that is
**off** in `Tunables::DEFAULT`. They are off so the shipped path stays the
reference each one is timed against, not because any of them changes a byte:

| # | flag | what is built |
|---|---|---|
| 1, 2 | `accel_quant_table` | Each AC job precomputes its per-index bit widths and one `compand_dequantize` table **per width** — keyed on `(bits, index)`, so `LAYOUT_C`'s 6- and 5-bit luma bands each get their own grid — and hoists `ln(1 + µ)` out of every µ-law quantize (`mulaw::mu_compress_by`, which `mu_compress` now calls, so the two are one expression). Landed together, as item 2 requires |
| 3 | `accel_dct_lanes` | `dct::dct_encode_lanes`: four coefficients per pass over the channel, one accumulator each, each summing in the scalar pixel order with the scalar term `(channel · cos_x) · cos_y`. Portable Rust with no intrinsics, so there is no `fmadd` to reach for; Rust never contracts `a * b + c` on its own |
| 4(a) | `accel_gamma_lut_cache` | The decoder's 4096-entry gamma table is built once per transfer curve (`OnceLock`) — two tables serve all five output gamuts, because `build_gamma_lut` reads only whether the gamut uses Adobe's γ. `average_color` uses it too |
| 4(b) | `accel_flat_cos` | The render loop reads its cosines from one contiguous array per axis (`precompute_cos_table_flat`, `dct_decode_pixel_flat`). **Only the layout half of 4(b) is built.** Vectorizing the render loop's colour conversion is not: it needs the differential-test harness `simd/` has for encode, and belongs with it |
| 5 | `accel_sse_early_exit` | `sse_with_delta` stops at the end of the first row whose partial sum has reached the candidate it must beat; each term is `≥ 0` or NaN, so a partial sum at the bound can never finish below it |
| 6 | `accel_fused_pixels` | `linearize`, `oklab_forward` and `alpha_average` run as one pass over 1024-pixel tiles; the alpha buffer is built only when the image has alpha to transform. `composite` stays behind its barrier |
| 7 | `accel_word_bitpack` | `bitpack::write_bits_word`: a field is masked and shifted into one 64-bit word and OR-ed a byte at a time |

**"Did not move", checked.** `rust/tests/accel_levers.rs` reproduces every
encode, decode and capped-decode vector in `spec/test-vectors/` with each flag
on alone and with all seven on; then compares every flag against the shipped
path under the shipped `Tunables` and eight non-default ones that reach what
the vectors cannot —
`LAYOUT_C`'s two widths at tier 2, refinement (the only caller of item 5),
alpha through the channel quantizer, CfL, the interleaved payload, the other
companding families — over opaque and translucent images from 1×1 to 64×48,
two fused tiles included. Library tests in `encode.rs`, `decode.rs`, `dct.rs`,
`mulaw.rs` and `bitpack.rs` repeat the core of it without reading `spec/`, so
the mutation sweep holds every lever too. And the eight photographs
`rd:gate` scores hash identically with all seven levers on, at every tier on
their encoder-input size and at tiers 0–2 on their display-size reference: 64
of 64 hashes. (`rd:gate` itself cannot take a flag — its adapter strips
`CHROMAHASH_TUNE` by design — but its figure is a function of the hash, so
identical hashes are 0.00% drift.)

No binding exposes `Tunables`, so the other eight languages cannot reach a
lever and their vector suites are unaffected by construction. **Making a lever
the default is the change that would need them**, and the vectors they run are
the ones this file already holds every lever to.

**What each buys: bound, not yet measured.** Every cell below is a
`verify:benchmark` binding to a perf arm the bounded sweep now records
(`perf/matrix.ts`: `TUNE_ARMS`, `TIER4_ACCEL_ARMS`, `DECODE_ACCEL_ARMS`), and
each speedup is the sweep's paired record for that lever — its process minima
divided round by round into its base's, timed back to back (§0) — not a ratio
of two cells measured minutes apart. None is filled, because no
committed run holds those cells: the host this revision was written on was
under sustained load, and §0's rule is that a wall-clock figure is published
from a host that holds a clock still. §0's `mise run benchmark:session`
fills them with `--fix`, and until then the gate reports each as missing
rather than passing it.

Speedup at tier 1 (shipped time ÷ lever time; the early exit is divided into
`refine_passes=1`, the only encode it can shorten):

| lever | 100×100 | 256×256 | 512×512 |
|---|---:|---:|---:|
| accel_quant_table | 1.39× | TBD× | 1.01× |
| accel_dct_lanes | 2.22× | TBD× | TBD× |
| accel_fused_pixels | 0.98× | 1.05× | 1.04× |
| accel_word_bitpack | 0.98× | 1.01× | 1.01× |
| accel all | 5.93× | 4.79× | 7.58× |
| refine_passes=1 accel_sse_early_exit | TBD× | 1.15× | 1.18× |

Tier 4 at 100×100, where the quantizer searches ~16× the coefficients of tier 1
over the same source:

| lever | encode | speedup |
|---|---:|---:|
| shipped | 110.38 ms | — |
| accel_quant_table | 77.76 ms | 1.41× |
| accel_dct_lanes | TBD ms | TBD× |
| accel all | 13.24 ms | 8.22× |

Decode (§12.1 item 4), 100×100 gradient source, speedup over the shipped decode:

| lever | t1 natural | t4 natural | t4 capped 32×32 |
|---|---:|---:|---:|
| accel_gamma_lut_cache | TBD× | 1.02× | 1.04× |
| accel_flat_cos | 1.05× | 0.98× | 1.07× |
| accel all | 2.94× | 0.98× | 1.12× |
