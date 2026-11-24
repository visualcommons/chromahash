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

> ### Measured 2026-09, except the cells named below
>
> **207 of this document's values are checked against a committed run**, on
> an AMD Ryzen 7 7800X3D (16 threads, Linux), from a clean tree.
> **40 table cells** are placeholders no committed run can fill yet, and so
> are **8 figures in the prose** that depend on them; all of them are named
> below rather than left for a reader to find. §6's table and the figures
> quoted from it were recorded before its arms were pinned to every lever off,
> so the gate reports them as missing until the quiet-host session (§6).
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
> cells disagreed by more than 10% on 22 of them. The same bar was applied to
> this host in 2026-09, by two bounded sweeps at one commit of which only one
> was committed — so their agreement is a statement about the host at the time,
> and its figures are no longer quoted here. The bar is now checked rather than
> asserted: the two bounded sweeps committed at one commit share **TBD cells**,
> the widest **TBD%** apart, and those placeholders are filled by the session
> that commits the pair.
>
> | Claim | Reproducible from the tree? |
> |---|---|
> | Every table below agrees with a cell in `baselines/hosts/<host>/perf-report*.json`, `baselines/perf-stages.json` and `baselines/perf-decode-stages.json`, within the cell's range or ±5% (a provisional tolerance; see "How a figure is checked") | **Yes** — `mise run verify:benchmark`, cell by cell |
> | The M3 Pro's 34% / ~25% / 22-of-99 figures | **No.** That host's runs were never committed, and the machine was rejected rather than published |
> | This host's cross-run agreement | **No.** Only one of the two bounded sweeps is committed, so `verify:benchmark`'s host-stability check has nothing to compare and reports itself `SKIP` |
>
> The gate has the slot and the rule; what it lacks is the second run. It
> reads `baselines/hosts/<host>/perf-report.json`, `perf-report-2.json` and
> `perf-report-full.json`, and **fails** on any cell two of one host's runs
> share that is more than 10% apart. The stability check needs two `bounded`
> runs at one commit on one host, sharing at least one cell, and it holds the
> row above to its result in both directions: "Yes" fails unless the check
> passes and the row quotes its figures (`N shared cells`, `widest X.X%`), and
> "No" fails once it passes. Until a second bounded sweep is committed the
> cross-run agreement stands on the maintainer's word and nothing else — which
> is exactly the standard §11 indicts `spec/README` §14 for, kept here only
> because it is *labelled* rather than presented as a checked result.
>
> **That committed run was annotated after it ran, in two fields that are not
> measurements.** `baselines/hosts/linux-x64-amd-ryzen-7-7800x3d-8-core-processor/perf-report.json`
> records commit `e53e6cd` with `dirty: false`, and every cell in it is that
> run's output, unedited. Its one `unavailable` entry, Swift's, was then
> changed by hand twice: the `reason` lost the measuring checkout's absolute
> path (it now reads `spawnSync .build/release/ChromaHashCLI ENOENT`), and
> `kind: "absent"` was added. The driver at `e53e6cd` could write neither — it
> recorded no `kind` and quoted the absolute path — so the file is not
> byte-for-byte what that commit produces. Both edits are what the driver writes
> for the same probe outcome: the `ENOENT` kept in the reason is the evidence
> for `absent`, and the redaction removes nothing else. The file was later
> moved, unchanged, from `baselines/perf-report.json` into its host's
> directory. It is a `chromahash-perf/2` run — one process per cell — and the
> gate reads it as one (below). The next `benchmark:session` on a quiet host
> replaces it with unannotated files, and the gate tests them against the bar.
>
> **What is still missing:**
>
> | Cells | Why |
> |---|---|
> | §2's tier-3 **encode** at 100×100 | only the full supplement measures tier 3 |
> | §2's tier-4 **encode** at 100×100 | the bounded matrix now measures it, as the base of §12.4's tier-4 levers; the committed run predates that |
> | §3's **128×128 and 1024×1024** rows | only the full supplement measures them |
> | §12.4's lever cells | the bounded matrix records them, but its arms were added after the committed run was taken, and the host was not quiet enough to take another |
> | §0's stability figures, and §12.1's and §12.3's measured restatements | prose bound to the cells above and to the committed pair, written `TBD` until they exist |
> | §7 and §8's **Swift** rows | its binding consumes a UniFFI xcframework only `xcodebuild` can assemble, so it is empty on **every** run made off macOS — `ci-swift.yml` on `macos-latest` is where Swift is measured. These are marked *macOS only* rather than `TBD`: they are not pending anybody's run, and a macOS session commits its own host directory (below) |
>
> **`mise run verify:benchmark` therefore still fails**, on those placeholders
> and nothing else, so `ci-comparison.yml` keeps `continue-on-error`. A Linux
> runner can never satisfy this gate while the Swift rows are bound, so the
> gate reports an unreachable target's rows as **unavailable** rather than
> failed. One command fills the rest: `mise run benchmark:session`, on a quiet
> host, from a clean tree — §0 below.

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
below 1, **and** a 5-minute load under 1.5× that bar (`SUSTAINED_LOAD_FACTOR`
in `perf/host.ts`; 3.0 on 16 threads). The 1-minute bar alone admitted a dip
inside sustained load: in the 2026-10-10 overnight session every round was
admitted at a 1-minute load of 1.86–2.0 while the 5-minute load stood at
2.6–6.2, and 21 bound cells had one outlier process in run 1. The 5-minute
average moves over minutes, so it rejects such a dip, and 1.5× leaves room
for the decaying tail of the build and the previous round without demanding
a host idle for a quarter of an hour. The session **waits** for the load to
fall under both — after the
build, before each sweep and **before every process round**, and before the
stages — for up to `--load-timeout` seconds (default 1800) each time, and
stops with what it saw if it does not. Refusing instead stopped the session at
its second sweep: the 1-minute average decays over about a minute, so it is
still high after the build and after each round's `threads=auto` batch cells.
Run alone, the driver refuses a loaded host unless given `--wait-for-load`;
`--force-loaded` starts anyway and marks the run `loaded`. A governor other
than `performance`, boost on and SMT on are reported, not refused — they need
root. All of it, with `rustc --version`, the kernel, the seconds waited, the
admission rule applied (`waitRule`), and the load average at the start, at
every process round and at the end, is recorded in the run's
`environment.preflight`. `--pin CPULIST` runs every
harness under `taskset -c`.

The gate does not take the driver's word for it. It recomputes the bar from
the run's own core count — so `--max-load 50` does not move it — and holds the
start and every round to it, so a run that started quiet and became loaded
fails. (The end reading is recorded and not held: it trails the run's own
batch cells.) It holds the 5-minute half **only to a run that records
`waitRule`**. A run taken before the rule, including the 2026-10-10 session's,
was admitted on the 1-minute bar alone and is held to that alone, so its
figures carry the weaker admission; a `waitRule` the gate does not recognise
fails. It rejects, as a failure rather than a printed note, a `/3` run
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
failing until a quieter session measures them. A cell that completed fewer
processes than its run planned (the driver keeps a cell with one), or a pair
with fewer complete A B / B A blocks than half that count, is withheld the
same way: with one process there is no spread to judge, and the spread rules
would otherwise pass it on the band alone.

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
when it is within **±5%** of the committed run. **Both tolerances in this
paragraph — the ±5% band and the half-point share floor — are provisional**:
no committed pair of sessions has yet measured the drift they are meant to
absorb, so the first committed stability pair may revise either, and neither
is a criterion any decision may cite as settled. The 5% is half of the 10% host
bar, and it is a resolution chosen rather than a noise level measured: a
figure is rewritten only when it moved more than half of what the bar lets
two runs of the host differ by, and a change the size of the bar always is.
How many figures a re-run on this host moves past it is not known yet — the
one pair of sweeps this host has compared was never committed, so that
agreement is unverified — and the first committed pair will say. A stage share
passes within half a point (provisional, as above), whatever its size: §1
records two recordings back to back agreeing within 1.0 point on a loaded
host, and §1.1 within 1.6. A percentage
that is a difference of two timings (§4's "vs shipped", §5's "2%") is held to the same 5%
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
> **Provenance.** All three cells were recorded at **`8d0ca33`**, which the
> artifact records and the gate checks for uniformity across the three columns,
> from a clean tree. They describe the encoder `master` ships since #165: every
> §12.4 lever on, which is the shipped default (`accel_fused_pixels` included),
> with #165's selection prefix and cached EOTF table. The previous recording, at
> `4d68c1f`, was of the unaccelerated reference path (`accel_*=0`), which was
> then the shipped encoder; it is still in that revision's
> `baselines/perf-stages.json`, and the figures this document quotes from it
> name it.
>
> The fused colour pass marks `linearize`, `oklab_forward` and
> `alpha_average` once per 1024-pixel tile, so the table keeps the unfused
> pass's rows: each is the sum of its tile marks, and the timers' own cost
> (a few hundred marks at 512×512) lands in the rows they close.
>
> **The host was loaded, and that is not free for shares either.** Its
> one-minute load average was about 6 of 16 threads when these were started
> and 12 when they ended, after hours near 20. So
> the three columns were recorded twice, back to back, and kept because the two
> agreed: every share within 1.0 point. The second is the one committed. The
> totals did *not* agree — 5.5% apart at 100×100, 7.5% at 512×512 tier 1 and
> 69% at tier 4, where the second run met a burst — which is why the total row
> is a record of this run and nothing more: it is not comparable with the
> previous recording's totals, and no speedup is read from the two. §12.4's
> instruction counts are what size each lever. As with §0's stability claim,
> the first run is not committed, so that agreement is a statement about the
> host at the time rather than something this tree can re-derive.

| stage | 100×100 t1 | 512×512 t1 | 512×512 t4 |
|---|---:|---:|---:|
| `eotf_lut` | 0.0% | 0.0% | 0.0% |
| `linearize` | 2.8% | 4.4% | 0.2% |
| `oklab_forward` | 16.9% | 27.4% | 2.6% |
| `alpha_average` | 3.0% | 4.7% | 0.1% |
| `composite` | 3.4% | 6.0% | 1.8% |
| `selection` | 1.5% | 0.1% | 0.5% |
| `cos_tables` | 1.9% | 0.6% | 0.3% |
| **`dct_forward`** | 36.3% | 54.5% | 89.5% |
| `dc_search` | 0.9% | 0.1% | 0.0% |
| `ac_quantize` | 33.2% | 2.1% | 4.3% |
| `refine` | 0.0% | 0.0% | 0.0% |
| `pack` | 0.1% | 0.0% | 0.0% |
| `unmarked` | 0.1% | 0.2% | 0.6% |
| total | 0.36 ms | 5.94 ms | 240.67 ms |

**Every row but `unmarked` is a `stage!` mark, and the marks now cover
`encode_with` end to end.** Until `4d68c1f` the last four stages —
`dc_search` (the decode-aware DC code search), `ac_quantize` (every AC scale and
code search: `scale_fit`, `ac_nearest`, the alpha plane, CfL), `refine` (the
pixel-domain refinement, off in the shipped build) and `pack` (the body
allocation and every bit written into it) — were one residual,
`quantize_and_pack`, computed as `whole_encode − stage_sum`. That made it an
*upper bound* on four kinds of work at once, and it was the only size §12.1
items 1, 2 and 7 had. They now have their own. **`unmarked` is the residual
that remains, and it names no search:** it is the return from `encode_with`,
which frees every per-pixel buffer the encode allocated, plus the timers' own
overhead — negligible at 100×100, and 0.2% at 512×512, where the buffers are
megabytes each.

**The forward DCT is still the largest stage, and rises with size and tier.**
36% of a 100×100
encode, 55% at 512×512, and **90%** at 512×512 tier 4. On the unaccelerated
path `4d68c1f` recorded it was 57%, 79% and 97%: `accel_dct_lanes` executes
2.56× fewer instructions in it (§12.4), so the stages around it now weigh
more. That still orders §10: at tier 4 nothing but the transform matters, and
at the default tier a lever that touches neither `dct_encode_selected` nor
the colour pipeline cannot be worth much at any size a caller actually
encodes, however elegant.

**Two qualifications the measured table adds**, and an earlier revision of this
paragraph asserted past both by calling every other stage "a rounding error at
any size or tier that matters":

* **At 100×100, `ac_quantize` is 33.2%** — the scale and AC code searches,
  not a rounding error at all, and now measured rather than bounded: the rest
  of the old residual (`dc_search`, `refine`, `pack`, `unmarked`) is about one
  point together. That is exactly the trap §4 documents, and it is
  why the encoder-only levers look decisive on a thumbnail and vanish on a
  photograph.
* **At 512×512 the per-pixel colour pipeline is 37.8%** — `linearize` 4.4%,
  `oklab_forward` 27.4%, `composite` 6.0%, with `alpha_average`'s reduction
  4.7% beside it. Only `oklab_forward` has a SIMD backend, which bounds what §5
  can buy before §5 is measured at all: the `simd` feature
  covers 27.4 points of a 100-point budget at the size a caller most often
  encodes — four times
  the 6.9 points it covered on the unaccelerated path, because the transform
  around it shrank.

### 1.1 Where decode time goes

`mise run benchmark:decode-stages`, share of one decode. The fixture is a
100×100 gradient encoded at the column's tier, then decoded at its natural
raster or capped at 32×32; decode cost depends on the tier and the raster, not
on the source's size. Before timing anything the instrumented build decodes
every shared decode vector in `spec/test-vectors/` and must reproduce the
spec's bytes, and the artifact records how many it did.

> **Provenance.** Bound to `baselines/perf-decode-stages.json`, recorded at
> **`8d0ca33`** from a clean tree, all three columns at that one commit and the
> same commit as §1; the gate checks both, and that each cell reproduced the
> spec vectors. The recorded iterations are 2000, 20 and 200 — inversely to the
> cost of one decode, so each column times a comparable interval.
>
> **The decoder these shares describe is the shipped one:** every §12.4 lever
> on, so the gamma table is built once per transfer curve and the render loop
> reads flat cosine tables, with #165's selection prefix. The previous
> recording, at `8f5f4d1`, had every lever off; it is still in that revision's
> `baselines/perf-decode-stages.json`, and the figures this document quotes
> from it name it.
>
> **Shares only, at whole-percent precision.** The host was loaded while these
> were recorded, so no absolute decode time is published here; §2 remains the
> source for those. The three columns were recorded twice, back to back, with
> §1's: every share agreed within 1.6 points, the tier-1 split between
> `render` and `selection` the least stable, while the totals were 83–98%
> apart, the second run having met a burst. The second is the one committed;
> the first is not, so that agreement is a statement about the host at the
> time.

| stage | t1 natural | t4 natural | t4 capped 32×32 |
|---|---:|---:|---:|
| `header` | 0% | 0% | 0% |
| `selection` | 5% | 0% | 22% |
| `ac_dequant` | 1% | 0% | 1% |
| `window_filter` | 0% | 0% | 1% |
| `cos_tables` | 2% | 0% | 0% |
| `gamma_lut` | 0% | 0% | 0% |
| **`render`** | 91% | 99% | 73% |
| `unmarked` | 0% | 0% | 3% |

Every row but `unmarked` is a `stage!` mark in `decode.rs`'s `render_at_size`,
and the marks cover that function end to end: `header` (the descriptor, DC and
scale fields), `selection` (keying every candidate in the grid, ordering the
longest prefix a channel takes, and taking each channel's), `ac_dequant`
(reading and dequantizing every AC code), `window_filter` (the synthesis
window and the frequency filter), `cos_tables`, `gamma_lut` (fetching the
output gamut's 4096-entry transfer table, built on the first decode of a
process) and `render` (the `O(w·h·K)` loop, with the output buffer it fills).
**`unmarked` is a residual, like §1's, and names no work:** it is the return
from `render_at_size` and the timers' own overhead.

**At the default tier the render loop is now most of the decode.** `gamma_lut` is
**0%** of a tier-1 decode. On the unaccelerated path `8f5f4d1` recorded it at
66%: the transfer table was rebuilt on every call, 4096 evaluations of the
gamma curve for a 32×32 raster of 1024 pixels, costing more than the render
loop it served. The table depends only on the output gamut, so since #142 it
is built once per transfer curve (§12.1 item 4(a)), and the render loop takes
what it left (`render` is **91%**), with `selection` 5% beside it.

**At tier 4 the render loop is the decode:** **99%** of a natural tier-4 decode,
everything else together about one point. **Capping moves the cost, not only
the size:** at 32×32 the render loop shrinks and `selection` — which keys all
65,535 candidates of the tier-4 grid whatever the raster — is **22%**
of what remains. It was 38% at `8f5f4d1`, when it also sorted the whole grid; since
#165 it orders only the few hundred candidates the channels take
(`SelectionOrder::with_prefix`), so what is left of the stage is keying every
candidate and selecting among them, both linear in the grid.

The render loop is one mark on purpose. Splitting it into its inverse DCT and
its per-pixel colour conversion would take a timer per pixel or a second loop,
and either would measure a decoder this crate does not ship; §12.1 item 4 is
sized with that limit stated.

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
| 64×64 | 1.57 ms | 384.49 ms |
| 100×100 | 2.46 ms | 246.12 ms |
| 128×128 | TBD ms | TBD ms |
| 256×256 | 12.32 ms | 188.03 ms |
| 512×512 | 46.74 ms | 178.29 ms |
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
| 100×100 | 1 | 2.46 ms | 2.52 ms | 1.02× |
| 256×256 | 1 | 12.32 ms | 12.61 ms | 1.02× |
| 512×512 | 1 | 46.74 ms | 47.63 ms | 1.02× |
| 512×512 | 0 | 29.19 ms | 30.13 ms | 1.03× |

**2%, and flat across every size measured.** `src/simd/` is four hand-written
backends (AVX2, SSE2, NEON, wasm simd128), a `simd-diff-tests` feature that
fails rather than skips, and a QEMU/wasmtime emulation matrix in CI. It covers
exactly one of the encoder's twelve marked stages — `oklab_forward` — which the
unaccelerated encoder these cells timed spent 6.9% of a 512×512 encode in
(`4d68c1f`'s `baselines/perf-stages.json`). So the ceiling was 6.9%, the
measured gain is 2%, and the backends were capturing roughly a third of the
one stage they touch.

The shipped encoder is not that encoder any more. With every §12.4 lever on,
§1 now prices that stage at **27.4%** of a 512×512 encode, because the
transform around it executes 2.56× fewer instructions, so the ceiling `simd`
works under is about four times what it was. These cells were not re-timed
at the new defaults, so whether the gain grew with the ceiling is not
measured; the 2% above is the unaccelerated encoder's.

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

Behind `Tunables::dct_separable` (off by default, exposed by no binding).
Both columns are encodes with every §12.4 lever off, so the pair differs in
the transform alone. These figures were recorded at `e53e6cd`, when that was
the shipped default. Since #142 the shipped encode runs `accel_dct_lanes`
and `accel_quant_table`, so it is not the direct summation, and the gate
binds this table and every figure quoted from it to the `accel none` and
`accel none dct_separable` arms (`perf/matrix.ts`). No committed run holds
those arms yet, so `verify:benchmark` reports these cells as missing until
§0's quiet-host session records them:

| source | tier 1 direct | separable | speedup |
|---|---:|---:|---:|
| 100×100 | 2.45 ms | 1.19 ms | 2.05× |
| 256×256 | 12.31 ms | 3.85 ms | 3.20× |
| 512×512 | 46.70 ms | 12.68 ms | 3.68× |

**The prediction holds, and this is the largest lever in the document.** The
saving grows with size exactly as the `K / Cx` argument says it should —
2.05× → 3.20× → 3.68×. At 512×512 it takes **34.0 ms off an encode where the
`simd` feature takes 0.9 ms**: 38× the absolute saving, on the stage the
unaccelerated encoder these cells timed spent 79% of its work in, rather than
on the 6.9% stage `simd` covers (`4d68c1f`'s recording of §1). On the shipped
encoder the two stages are 55% and 27.4% (§1), and neither arm has been timed
there.

That it is also the only *large* lever requiring a format change is the tension
§12 exists to lay out. Stated precisely, because the temptation is to overstate
it: **the only byte-identical speedup §5 measures is 2%, and the only large
one measured at all costs a version bump.** §12.1's seven byte-identical
candidates are now built (§12.4), so what is missing is their measurement, not
an argument for them.

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

1. **The forward-DCT inner loop.** §1 puts it at 55% of a 512×512 encode and 90%
   at tier 4, so it is still the largest place a win is available. Its
   byte-safe half, `accel_dct_lanes`, is shipped (§12.4); what remains of it is
   the separable transform, a format change (item 2). Beside it, at the default
   tier, the per-pixel colour pipeline is the next stage §1 prices.
2. **Adopt the separable transform** (§6) — **3.68× at 512×512**, now measured,
   against the direct summation with every §12.4 lever off in both arms, and
   growing with size as its own `K / Cx` argument predicts. It is the largest
   lever in this document by an order of magnitude, and it costs a format
   version. Worth deciding deliberately rather than by default.
3. **Reconsider `ac_nearest` and per-tier `scale_fit`** (§4), for small inputs
   only. Their quality effects are at or below the noise floor at the default
   tier, and their time cost vanishes at photo resolution.
4. **SIMD in decode** — there is none. `decode.rs` runs a scalar per-pixel OKLAB
   inverse plus three gamma lookups inside the `O(w·h·K)` render loop, and at
   tier 4 decode is the more expensive half (§2). §1.1 adds that, with the
   gamma table built once per transfer curve since #142 (§12.1 item 4(a)),
   that loop is most of a default-tier decode too.
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

The measured context, from §1 and §5: the forward DCT is **55%** of a 512×512
encode and **90%** at tier 4; `ac_quantize` is **33.2%** of a 100×100 one;
the per-pixel colour pipeline is **37.8%** at 512×512; and the `simd`
feature buys **1.02×** because, on the unaccelerated encoder §5 timed, it
covered 6.9 points — on the shipped one it covers 27.4 of those points, and
has not been re-timed.

All four are now marked stages. The second used to be a residual,
`quantize_and_pack`, which held the quantizer searches *and* the DC search, the
bit packing, the buffer frees and the instrumentation's overhead, so it could
only ever be a ceiling on a bucket. §1 now splits it: on the unaccelerated
path `4d68c1f` recorded, the searches were 37.2 of its 37.5 points at
100×100.

### 12.1 Byte-identical — legal in a patch release

Each of these produces the same bytes by construction, so `spec/test-vectors/`
and `mise run rd:gate` are sufficient evidence, and no version moves.

| # | Where | What | Why it is safe |
|---|---|---|---|
| 1 | `mulaw.rs:50` ← `encode.rs:652` | **Precompute the dequantization table, keyed on `(bits, index)`.** `mu_law_dequantize(index, bits, mu)` is a pure function of its arguments, and `mu` *is* fixed for a channel (`t.mu_l`) — yet `scale_fit=2` calls it inside a 63-code search over every coefficient, each call a `portable_pow` = a 20-term series plus a degree-25 Taylor polynomial. **`bits` is not fixed:** `AcQuantJob::bits_at(i)` (`encode.rs:682`) walks the job's tier list and returns a width that varies with the selection index. `LAYOUT_C` (`constants.rs:193`) is `l_tiers: [(8, 6), (14, 5)]` — 6-bit low band, 5-bit high band, one channel, reachable through `Tunables::layout_upper` and exercised by `constants.rs:863`. A table keyed on the index alone would hand the high band the low band's grid and dequantize it wrongly. Two widths per job at most, ≤ 2^6 − 1 = 63 indices each, so ≤ 128 entries — not the "≤ 32" an index-only table suggests. | The table holds the same values the calls return, *provided* `bits` is part of the key |
| 2 | `mulaw.rs:6`, `encode.rs:682,694` | **Hoist the loop-invariants.** `mu_compress` recomputes `portable_ln(1.0 + mu)` on every quantize call for a constant `mu`; `bits_at`/`gain_at` walk the tier list per index per call. Note this is the *same* walk item 1 must key its table on: it is an inefficiency worth removing and a correctness constraint at once, so the two entries have to land together. | Same values, computed once |
| 3 | `dct.rs:251` | **Vectorize across coefficients, not pixels.** The inner sum must keep its exact left-to-right order, which is why `simd/mod.rs` never touched it. Lanes over *distinct `(cx, cy)` pairs* preserve each coefficient's own order and are as parallel as the per-pixel case. | Per-lane arithmetic is unchanged; only which coefficient a lane holds — **but the arithmetic argument alone is not sufficient, and two things break it.** (a) **FMA contraction.** The kernel is `f += channel[x + y*w] * cx_row[x] * fy`; fusing the multiply-add keeps one rounding instead of two and changes the result. Rust does not contract today, but intrinsics backends are written by hand and `fmadd` is the obvious instruction to reach for. The lanes must use separate multiply and add. (b) **Regrouping.** `channel * (cx * fy)` is the natural vector form and is *not* `(channel * cx) * fy`; float multiplication is not associative, and this repo ships four hand-written backends that would each have to resist the same simplification. Both belong in the vector-diff gate, not in review |
| 4 | `decode.rs:22,420`; `decode.rs:447`, `dct.rs:370` | **Decode, in two parts sized by §1.1.** (a) **Build the gamma LUT once per output gamut, not once per decode.** `build_gamma_lut` evaluates the transfer curve 4096 times — each a `portable_pow` for sRGB and Display P3 — on every call, and §1.1 measured it at 66% of a default-tier decode with every lever off (`8f5f4d1`), more than the render loop itself; with the table cached, §1.1 measures it at **0%** of a default-tier decode. It is a pure function of the gamut, so a table built once (or generated) holds the same 4096 bytes. `average_color` (`decode.rs:660`) builds the same table to convert one pixel. (b) **Flatten `cos_x`/`cos_y`, and vectorize the render loop.** They are `Vec<Vec<f64>>`, a pointer chase per coefficient per pixel in the `O(w·h·K)` loop, and there is **no SIMD in decode at all** — a scalar per-pixel OKLAB inverse plus three gamma lookups. §1.1 puts that loop at **99%** of a natural tier-4 decode, the operation §2 prices at 234 ms, so (b) is bounded by 99% there and by 91% at tier 1. §1.1 does not split the loop's inverse DCT from its colour conversion, so how that bound divides between flattening and SIMD is not measured. | (a) the same function of the same argument, computed fewer times; (b) a layout change reads the same values; a vector colour conversion is byte-identical only if it keeps the scalar path's operation order, and would need the differential tests `simd/` already runs for encode |
| 5 | `encode.rs:934` | **Early-exit `sse_with_delta`.** `acc` accumulates monotonically and the caller keeps only strict improvements, so it can abort the moment `acc >= best`. Off by default (`refine_passes: 0`) but §4 measures refinement at **20–37 ms against 2.45 ms shipped**, and it is what the `refine-*` sweeps spend their time in. | Changes when the loop stops, never which code wins |
| 6 | `encode.rs:260,320,328,369` | **Fuse the first three per-pixel passes; `composite` cannot join them.** Four full `W·H` passes and **eight** `W·H` allocations — `lin_r`/`lin_g`/`lin_b`/`alpha_pixels`, `oklab_pixels` (3 f64 each), `l_chan`/`a_chan`/`b_chan` — which is 10 f64 per pixel, or **20 MiB** at 512×512, for a stage §1 prices at 37.8%. **An earlier revision of this row said `linearize` and `composite` fuse. They do not:** `composite` (`encode.rs:369`) reads `avg_l`/`avg_a`/`avg_b`, which are the *completed* `alpha_average` reduction (`328`) after its normalization by `avg_alpha` (`340`). A full-array barrier sits between exactly the two passes that row paired, and fusing across it would composite against a running partial mean — different bytes, not merely a different order. What is available: fuse `linearize` + `oklab_forward` + `alpha_average` into one tiled pass, and drop `alpha_pixels` entirely by re-deriving alpha in `composite` from `rgba[i*4+3] as f64 / 255.0`, the identical expression. That is 8 buffers → 4 and 4 passes → 2; `oklab_pixels` must survive the barrier and cannot be tiled away. | Elementwise work in unchanged order, **and** the reduction still accumulates in flat pixel index order — which holds only if the tile length is a multiple of the SIMD lane count, so no pixel moves between `oklab_forward_batch`'s vector body and its scalar tail. `composite` stays a separate pass; nothing about this makes the barrier crossable |
| 7 | `bitpack.rs:3` | **Word-at-a-time bit writing**, against the current divide-and-modulo per bit. Correct and genuinely small — ≤1623 bytes — and listed for completeness rather than for its size. | Same bits |

Items 1 and 2 were the ones worth doing first, and not because they are the
largest: they sit inside the stage that was 37.2% of a thumbnail encode before
them (`4d68c1f`). With every lever on that stage is `ac_quantize`, which is 33.2% of a thumbnail encode
and 2.1% of a photograph. That is the shape §4 already documents for the
encoder-only *quality* levers, and it applies to their cost too.

**Measured (§12.4).** `accel_quant_table` makes a 100×100 tier-1 encode **TBD×**
faster and a 512×512 one **TBD×**; at tier 4 it is **TBD×**, where the
quantizer searches ~16× the coefficients over the same source. Item 7,
`accel_word_bitpack`, measures **TBD×** at 100×100, against a `pack` stage that
rounds to nothing in §1. Each is a paired ratio from §12.4's tables, and each
reads `TBD` — failing the gate by name — until a committed run holds it.

**`ac_quantize` is now the stage these two levers act in, not a bucket they share.**
Until §1 marked it, the only figure was `quantize_and_pack`'s 37.5% — a
residual that also held the DC search, the bit packing and the buffer frees,
and so only an upper bound. The marks settle two more things the residual hid:
item 7 acts in `pack`, which rounds to at most 0.1% in every column of §1 — it was
listed for completeness, and its stage confirms it — and the DC search, which
no lever touches, is `dc_search` at 0.9%. A stage is still a ceiling, not a
speedup: how much of `ac_quantize` items 1 and 2 remove is §12.4's to measure,
and the figures above are that measurement, pending (§12.3).

### 12.2 Format changes — v0.8 work

| # | Where | What | What it costs |
|---|---|---|---|
| 8 | `dct.rs:424` | **Adopt the separable forward DCT.** §6 measures **3.68× at 512×512** with every lever off in both arms, growing with size. Prototyped, and byte-identical over 40 encodings spanning five tiers and three content classes. | Reassociating float addition is not *guaranteed* to preserve quantized codes, and spec §10/§12.6 pin the direct summation as normative. Version bump, regenerated vectors, nine languages together |
| 9 | `encode.rs:437` | **Downsample before the transform.** There is none: `dct_encode_selected` runs over the full source, so encode is `O(K·W·H)` in the *original's* pixels — 46.7 ms for one 512×512 image, and §3's per-megapixel column is what a caller encoding 12 MP originals actually pays. `refine_grid`/`resample_channel_dct` (`encode.rs:1023`) already gesture at the machinery | Changes the coefficients, so it changes every hash |

### 12.3 What this list does not claim

* **Items 1–7 are built and bound; their wall-clock measurement is pending.**
  #8 is prototyped behind `Tunables::dct_separable`; items 1–7 are built
  (§12.4), each behind its own flag and each held to the shipped bytes, and
  all seven are on in the shipped defaults (item 6 since #165) on the
  strength of a paired instruction count, not a timing. Measured against every lever off,
  the shipped levers together measure **TBD×**
  on a 512×512 encode and **TBD×** on a default-tier decode. Until a
  committed run holds §12.4's cells those are placeholders that fail the
  gate; the stage shares above and
  §12.4's instruction counts are the only sizes any lever has. A stage share
  bounds a lever, and an instruction count is not a time.
* **The byte-identical column is an argument, not a proof** — and for items
  1–7 it is no longer only an argument. §12.4 lists what now checks "did not
  move" for each; "cannot move" and "did not move" are different claims, and
  this repo has a gate for the second one.
* **Decode is measured by stage, not below it.** §1.1 is the decode
  equivalent of §1, and item 4 was sized from it rather than from reading
  `decode.rs`: the gamma LUT was 66% of a default-tier decode with every lever
  off (`8f5f4d1`). With every lever on, the gamma LUT is **0%** of a default-tier decode and the render
  loop **99%** of a tier-4 one. What §1.1 cannot say is how the render loop
  divides between its inverse DCT and its colour conversion, so item 4(b)'s
  two halves share one bound. §1.1 also publishes no absolute time: its shares
  were recorded on a loaded host, and §2's 234 ms is still the only measured
  tier-4 decode time.

### 12.4 The byte-identical levers, built

§12.1's items 1–7 exist in `rust/`, each behind a `Tunables` flag. Since #142
six flags, and since #165 all seven, are **on** in `Tunables::DEFAULT`, each
on the strength of a paired instruction count (below). Off (`accel_*=0`), a flag
selects the unaccelerated path its lever replaced, which stays as the
reference `lever-identity` and `benchmark:counts` compare the shipped path
against. No setting of any flag changes a byte:

| # | flag | what is built |
|---|---|---|
| 1, 2 | `accel_quant_table` | Each AC job precomputes its per-index bit widths and one `compand_dequantize` table **per width** — keyed on `(bits, index)`, so `LAYOUT_C`'s 6- and 5-bit luma bands each get their own grid — and hoists `ln(1 + µ)` out of every µ-law quantize (`mulaw::mu_compress_by`, which `mu_compress` now calls, so the two are one expression). Landed together, as item 2 requires |
| 3 | `accel_dct_lanes` | `dct::dct_encode_lanes`: four coefficients per pass over the channel, one accumulator each, each summing in the scalar pixel order with the scalar term `(channel · cos_x) · cos_y`. Portable Rust with no intrinsics, so there is no `fmadd` to reach for; Rust never contracts `a * b + c` on its own |
| 4(a) | `accel_gamma_lut_cache` | The decoder's 4096-entry gamma table is built once per transfer curve (`OnceLock`) — two tables serve all five output gamuts, because `build_gamma_lut` reads only whether the gamut uses Adobe's γ. `average_color` uses it too |
| 4(b) | `accel_flat_cos` | The render loop reads its cosines from one contiguous array per axis (`precompute_cos_table_flat`, `dct_decode_pixel_flat`). **Only the layout half of 4(b) is built.** Vectorizing the render loop's colour conversion is not: it needs the differential-test harness `simd/` has for encode, and belongs with it |
| 5 | `accel_sse_early_exit` | `sse_with_delta` stops at the end of the first row whose partial sum has reached the candidate it must beat; each term is `≥ 0` or NaN, so a partial sum at the bound can never finish below it |
| 6 | `accel_fused_pixels` | `linearize`, `oklab_forward` and `alpha_average` run as one pass over 1024-pixel tiles; the alpha buffer is built only when the image has alpha to transform. `composite` stays behind its barrier. Each tile's bytes and OKLAB slice are walked as zipped chunk iterators, so no per-element bounds check is left in the pass (#165); it marks the three unfused stage names once per tile, so §1 keeps their rows |
| 7 | `accel_word_bitpack` | `bitpack::write_bits_word`: a field is masked and shifted into one 64-bit word and OR-ed a byte at a time |

**"Did not move", checked.** `rust/tests/accel_levers.rs` reproduces every
encode, decode and capped-decode vector in `spec/test-vectors/` under the
shipped defaults, with every flag off, with each flag on alone over that, and
with all seven on; then compares every flag against the levers-off reference
under the shipped `Tunables` and eight non-default ones that reach what
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
identical hashes are 0.00% drift.) Since #142 `rd:gate` scores the shipped
levers directly, because they are the defaults its adapter runs.
`mise run lever-identity` widens the check to every open fixture image
(`baselines/lever-identity.json`): it encodes each with every lever off and
compares two arms with it, the shipped defaults and all seven on, at 100 px
and 512 px at every tier code and at full resolution at codes 0–2, hashes
byte for byte and decoded pixels too, beside a negative control that must
report a difference. At `51ea98b`, whose Rust is #165's — the rewritten fused
pass, the selection prefix and the cached EOTF table, with all seven levers
on by default, so the two arms run the same path — it compared
153 images in 3,978 encode and 3,978 decode pairs, 1,989 per arm, and none
differed; the control differed in 1,313 of its 1,530 encodes and as many
decodes. (`2219004`'s run, with six levers on by default, had the same
result.)

No binding exposes `Tunables`, so the other eight languages cannot reach a
lever, and since #142 they run the shipped levers through `Tunables::DEFAULT`.
`spec/test-vectors/` did not change, so every binding's vector suite holds
them to the same bytes it held the unaccelerated path to.

**What each lever buys, counted.** The shipped defaults were chosen on paired
user-space instruction counts (`mise run benchmark:counts`), which a loaded
host does not move the way it moves a time: each record is ten interleaved
A B / B A blocks of the reference arm (`accel_*=0`) against the shipped
defaults on one cell, committed under `tools/comparison/results/counts/ab/`
at `29ae913` from a clean tree, both arms producing equal outputs; the
`accel_fused_pixels` row was re-recorded at `92d6784` (#165). The ratio
is reference instructions ÷ shipped instructions, so above 1 is a reduction;
every block's ratio agreed with their geometric mean to four decimals. An instruction count is
not a time, and no speedup is claimed from one. `verify:claims` holds every
row, and the counts quoted below it, to its record (`perf/counts-claims.ts`).

| lever | cell | reference | shipped | ratio |
|---|---|---:|---:|---:|
| accel_quant_table | encode 100×100 t1 | 11,645,256 | 6,238,744 | 1.867 |
| accel_dct_lanes | encode 512×512 t1 | 281,235,421 | 109,849,392 | 2.560 |
| accel_gamma_lut_cache | decode 100×100 t1 | 3,689,370 | 2,400,418 | 1.537 |
| accel_flat_cos | decode 100×100 t4 | 7,416,211,976 | 5,571,385,951 | 1.331 |
| accel_sse_early_exit | encode 100×100 t1, `refine_passes=1` | 326,807,578 | 278,289,676 | 1.174 |
| accel_word_bitpack | encode 100×100 t4 | 239,475,894 | 239,433,012 | 1.0002 |
| accel_word_bitpack | encode 100×100 t1 | 6,238,641 | 6,238,761 | 0.99998 |
| every lever off | encode 512×512 t1 | 286,640,377 | 109,849,411 | 2.609 |
| every lever off | decode 100×100 t1 | 4,273,343 | 2,400,419 | 1.780 |
| accel_fused_pixels | encode 512×512 t1 | 109,661,546 | 107,028,138 | 1.025 |
| selection prefix | decode 100×100 t1 | 2,400,418 | 2,212,505 | 1.085 |
| selection prefix | encode 100×100 t1 | 6,238,757 | 6,050,902 | 1.031 |
| selection prefix | encode 512×512 t4 | 3,513,061,707 | 3,491,925,087 | 1.006 |
| EOTF table cache | encode 100×100 t1 | 5,946,962 | 5,874,040 | 1.012 |
| EOTF table cache | encode 512×512 t1 | 107,028,135 | 106,954,970 | 1.0007 |

**`accel_fused_pixels` is on since #165.** #142 left it off: its record then
(`955efb6`) counted 8.3% *more* instructions than the four passes it
replaces. The fused loop indexed the source bytes and the OKLAB plane by flat
pixel index inside each tile, so every element carried bounds checks the
separate passes do not, and its composite re-tested `has_alpha` and grew the
alpha plane one push per pixel; an instruction profile put the increase in
`analyze`, the function holding those loops. #165 walks each tile as zipped
chunk iterators and collects the alpha plane in one pass, and the fused pass
now executes 2.5% fewer instructions than the separate passes, with its
cycle ratio inside its blocks' noise (0.93–1.15).

**The last five rows are #165's two changes without a flag**, so each
record's arms are two builds rather than two tunes: the reference is the
commit before the change (`arms.a.bin` and its SHA-256 in the record), the
shipped arm the change, both under the shipped defaults. *Selection prefix*:
the selection order sorted every candidate in the grid — up to 65,535 at
tier 4 — when no channel takes more than a few hundred;
`SelectionOrder::with_prefix` selects the prefix the channels take and sorts
only that, the same coefficients because the sort key `(key, cx, cy)` is a
total order (a library test holds it to the full sort at every tier). *EOTF
table cache*: the encoder's 256-entry EOTF table is built once per transfer
curve, as the decoder's gamma table is since #142. Its saving is a per-call
one in a process that encodes more than once; a process that encodes once
pays the table as before. **`accel_word_bitpack` is on:** at tier 4,
where the writer packs 1623 bytes, it removes 42,882 instructions per encode;
at tier 1, 32 bytes, it costs 120 more out of 6.24 million, in the `pack`
stage §1 rounds to 0.1% or less.

**What each buys in time: bound, not yet measured.** Every cell below is a
`verify:benchmark` binding to a perf arm the bounded sweep now records
(`perf/matrix.ts`: `TUNE_ARMS`, `TIER4_ACCEL_ARMS`, `DECODE_ACCEL_ARMS`).
Because the levers are the defaults, each arm turns its lever off
(`accel_*=0`, or `accel none` for all seven) and the speedup is the
reference time over the shipped time. Each is the sweep's paired record for that lever — its process
minima divided round by round into its base's, timed back to back (§0) — not
a ratio of two cells measured minutes apart. None is filled, because no
committed run holds those cells: the host this revision was written on was
under sustained load, and §0's rule is that a wall-clock figure is published
from a host that holds a clock still. §0's `mise run benchmark:session`
fills them with `--fix`, and until then the gate reports each as missing
rather than passing it.

Speedup at tier 1 (reference time ÷ shipped time; the early exit's arm runs
`refine_passes=1`, the only encode it can shorten, and is divided by it):

| lever | 100×100 | 256×256 | 512×512 |
|---|---:|---:|---:|
| accel_quant_table=0 | TBD× | TBD× | TBD× |
| accel_dct_lanes=0 | TBD× | TBD× | TBD× |
| accel_fused_pixels=0 | TBD× | TBD× | TBD× |
| accel_word_bitpack=0 | TBD× | TBD× | TBD× |
| accel none | TBD× | TBD× | TBD× |
| refine_passes=1 accel_sse_early_exit=0 | TBD× | TBD× | TBD× |

Tier 4 at 100×100, where the quantizer searches ~16× the coefficients of tier 1
over the same source:

| lever | encode | speedup |
|---|---:|---:|
| shipped | TBD ms | — |
| accel_quant_table=0 | TBD ms | TBD× |
| accel_dct_lanes=0 | TBD ms | TBD× |
| accel none | TBD ms | TBD× |

Decode (§12.1 item 4), 100×100 gradient source, each lever's speedup (the
reference decode's time over the shipped decode's):

| lever | t1 natural | t4 natural | t4 capped 32×32 |
|---|---:|---:|---:|
| accel_gamma_lut_cache=0 | TBD× | TBD× | TBD× |
| accel_flat_cos=0 | TBD× | TBD× | TBD× |
| accel none | TBD× | TBD× | TBD× |
