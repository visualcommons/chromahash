"""Record one cell of `spec/PERFORMANCE.md` §1 or §1.1 into a committed stages baseline.

Encode (§1): reads the `stage=nanoseconds` lines `rust/examples/bench_stages.rs`
prints on stdin and merges them into `tools/comparison/baselines/perf-stages.json`
as one cell, keyed `WxH-tTIER`.

Decode (§1.1, `--decode`): the same for `rust/examples/bench_decode_stages.rs`,
into `perf-decode-stages.json`, keyed `WxH-tTIER-natural` or
`WxH-tTIER-capCWxCH`. That example also prints `meta.*` lines — the rendered
raster, the hash length, and how many spec decode vectors it reproduced before
timing — which become fields of the cell rather than stages.

Each table is several columns and each column is its own invocation, so the
file is merged rather than replaced: a fresh file per run would leave the other
columns unmeasured.

Invoked by `mise-tasks/benchmark/stages` and `mise-tasks/benchmark/decode-stages`.
It lives here, as a module, rather than in a heredoc inside those tasks: this
file defines the schemas `verify:benchmark` gates §1 and §1.1 against, and
`tools/benchmark/` is the tree `mise run lint:benchmark` and
`mise run format:check:benchmark` cover. A heredoc'd copy was the only Python in
`mise-tasks/` and was outside every lint and format task in the repo.

Usage:
    bench_stages ... | python3 tools/benchmark/record_stages.py W H TIER ITERS OUT
    bench_decode_stages ... \
        | python3 tools/benchmark/record_stages.py --decode W H TIER ITERS CAP OUT

CAP is `natural` or `CWxCH`.
"""

import datetime
import json
import os
import re
import subprocess
import sys

SCHEMA = "chromahash-perf-stages/1"
DECODE_SCHEMA = "chromahash-perf-decode-stages/1"

# Every artifact this recorder writes. The dirty probe excludes all of them,
# not only the one being written; see `provenance`.
RECORDER_OUTPUTS = ("perf-stages.json", "perf-decode-stages.json")

# Provenance is recorded so `verify:benchmark` can refuse a baseline that cannot
# be traced to a source state. The recorder's own artifacts are excluded from the
# probe: writing them *is* the point of this script, each table is several
# columns and therefore several invocations, and without the exclusion every
# invocation after the first observes its predecessor's write and records
# `dirty: true` — which the gate hard-fails with advice ("re-run from a clean
# tree") that no multi-invocation table can ever follow. The exclusion covers
# the sibling artifact too: §0's procedure records §1 and then §1.1 before
# committing either, and a measurement output is not a source input, so the
# encode baseline being modified says nothing about what the decode run built.
# Every other path still counts. The probe also runs *after* the write rather
# than before, so it sees anything the build itself left behind.


def git(*args: str) -> str:
    """Run a git command, returning stripped stdout (empty on any failure)."""
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    ).stdout.strip()


def provenance(out: str) -> dict[str, object]:
    """The revision these shares were measured at, and whether anything else was dirty."""
    top = git("rev-parse", "--show-toplevel")
    here = os.path.dirname(os.path.abspath(out))
    excluded = {os.path.abspath(out)} | {os.path.join(here, n) for n in RECORDER_OUTPUTS}
    rels = sorted(os.path.relpath(p, top) if top else p for p in excluded)
    # `:/` is every path in the repo; `:(exclude,top)` is repo-root-relative, so
    # this is correct regardless of the working directory the task runs from.
    status = git("status", "--porcelain", "--", ":/", *(f":(exclude,top){r}" for r in rels))
    return {"rev": git("rev-parse", "--short", "HEAD"), "dirty": status != ""}


RERECORD = {
    SCHEMA: (
        "PERFORMANCE.md §1",
        "  mise run benchmark:stages 100 100 1\n"
        "  mise run benchmark:stages 512 512 1\n"
        "  mise run benchmark:stages 512 512 4",
    ),
    DECODE_SCHEMA: (
        "PERFORMANCE.md §1.1",
        "  mise run benchmark:decode-stages 100 100 1 2000\n"
        "  mise run benchmark:decode-stages 100 100 4 20\n"
        "  mise run benchmark:decode-stages 100 100 4 200 32x32",
    ),
}


def load(out: str, schema: str = SCHEMA) -> dict:
    """The existing baseline, or a fresh document. A schema mismatch is fatal."""
    if not os.path.exists(out):
        return {"schema": schema, "cells": {}}
    try:
        with open(out, encoding="utf-8") as f:
            existing = json.load(f)
    except json.JSONDecodeError as e:
        sys.exit(f"{out}: not valid JSON ({e}). Inspect it before re-recording.")
    found = existing.get("schema")
    if found != schema:
        # Silently discarding it would drop the table's other columns and
        # leave a one-cell baseline that the gate reports as a missing table
        # rather than as a schema change.
        table, commands = RERECORD[schema]
        sys.exit(
            f"{out}: schema {found!r}, expected {schema!r}.\n"
            f"Refusing to overwrite: this file holds one cell per column of {table}, "
            "and replacing it would discard the columns this run does not measure.\n"
            f"Delete it deliberately and re-record every column:\n{commands}"
        )
    existing.setdefault("cells", {})
    return existing


# Python writes a float's exponent with at least two digits (`1.8e-05`); `biome
# format`, which `format:check:compare` runs over every committed baseline,
# writes the fewest (`1.8e-5`). The two spell the same number, but the committed
# file must stay byte-for-byte this script's output, so the exponent is
# normalized to biome's spelling here. A share small enough to need an exponent
# is ordinary: the `refine` stage is off in the shipped build and measures a few
# millionths of an encode.
#
# Anchored to a whole value — after `": "`, before the line's end — so it can
# only ever rewrite a number: a string value starts with a quote, and a hex
# revision like `3e05abc` is never touched.
_PADDED_EXPONENT = re.compile(
    r'(?<=": )(-?[0-9]+(?:\.[0-9]+)?)e([+-]?)0+([0-9]+)(?=,?$)', re.MULTILINE
)


def write(out: str, doc: dict) -> None:
    text = json.dumps(doc, indent=2, sort_keys=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(_PADDED_EXPONENT.sub(r"\1e\2\3", text))
        f.write("\n")


def read_stdin() -> tuple[dict[str, int], dict[str, int]]:
    """`stage=ns` lines, and `meta.key=value` lines, from the example's output."""
    stages: dict[str, int] = {}
    meta: dict[str, int] = {}
    for line in sys.stdin:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        if k.startswith("meta."):
            meta[k.removeprefix("meta.")] = int(v)
        else:
            stages[k] = int(v)
    return stages, meta


def shares(stages: dict[str, int], total_key: str) -> dict[str, float]:
    """Each stage as a percentage of the whole operation; the two totals are not rows."""
    total = stages.get(total_key, 0)
    return {
        k: (v * 100.0 / total if total else 0.0)
        for k, v in stages.items()
        if k not in ("stage_sum", total_key)
    }


def record(out: str, doc: dict, cell: str, entry: dict) -> None:
    doc["cells"][cell] = entry
    # Write, then probe, then record what the probe saw. The write is what makes
    # the tree dirty, and it is the one change this script is entitled to make.
    write(out, doc)
    doc["cells"][cell]["git"] = provenance(out)
    write(out, doc)
    print(f"\nrecorded cell {cell} -> {out}")


def main_decode(argv: list[str]) -> None:
    if len(argv) != 6:
        sys.exit("usage: record_stages.py --decode W H TIER ITERS CAP OUT")
    w, h, tier, iters, cap, out = argv
    m = re.fullmatch(r"([1-9][0-9]*)x([1-9][0-9]*)", cap)
    if cap != "natural" and not m:
        sys.exit(f"CAP must be `natural` or `WxH`, got {cap!r}")

    stages, meta = read_stdin()
    # A decode cell without its totals, its raster or its vector check is not a
    # measurement the gate can read, so refuse it here rather than write it.
    missing = [k for k in ("whole_decode", "stage_sum", "unmarked") if k not in stages]
    missing += [
        f"meta.{k}"
        for k in ("render_width", "render_height", "hash_bytes", "vectors_checked")
        if k not in meta
    ]
    if missing:
        sys.exit(f"bench_decode_stages output lacks {', '.join(missing)}; nothing recorded")
    if meta["vectors_checked"] < 1:
        sys.exit("bench_decode_stages checked no spec decode vectors; nothing recorded")

    key = f"{w}x{h}-t{tier}-" + ("natural" if m is None else f"cap{cap}")
    doc = load(out, DECODE_SCHEMA)
    record(
        out,
        doc,
        key,
        {
            "width": int(w),
            "height": int(h),
            "tier": int(tier),
            "iters": int(iters),
            # An object, not a [w, h] pair: `biome format` rewraps short arrays,
            # and the committed file must stay byte-for-byte this script's output.
            "cap": None if m is None else {"width": int(m.group(1)), "height": int(m.group(2))},
            "render": {"width": meta["render_width"], "height": meta["render_height"]},
            "hashBytes": meta["hash_bytes"],
            # How many shared decode vectors the instrumented build reproduced
            # byte for byte before it timed anything. The gate requires it.
            "vectorsChecked": meta["vectors_checked"],
            "ns": stages,
            # Shares of the whole decode, as §1.1 publishes them. `unmarked`
            # is whole_decode - stage_sum: the return and the timers' own
            # overhead, since the marks cover `render_at_size` end to end.
            "sharePct": shares(stages, "whole_decode"),
            "recordedAt": datetime.datetime.now(datetime.UTC).isoformat(),
        },
    )


def main() -> None:
    if sys.argv[1:2] == ["--decode"]:
        main_decode(sys.argv[2:])
        return
    w, h, tier, iters, out = sys.argv[1:6]

    stages, _ = read_stdin()

    cell = f"{w}x{h}-t{tier}"
    doc = load(out)
    record(
        out,
        doc,
        cell,
        {
            "width": int(w),
            "height": int(h),
            "tier": int(tier),
            "iters": int(iters),
            "ns": stages,
            # Shares of the whole encode, which is what §1 publishes: a ratio
            # taken inside one process, and the reason that table is readable on
            # a host whose absolute wall-clock is not.
            #
            # `unmarked` is not a marked stage. bench_stages.rs derives it as
            # whole_encode - stage_sum; the marks cover `encode_with` end to
            # end, so it is the return and the timers' own overhead. (It was
            # `quantize_and_pack` while the quantizer searches, the refinement
            # and the packing were one unmarked span.) §1 says so in place.
            "sharePct": shares(stages, "whole_encode"),
            "recordedAt": datetime.datetime.now(datetime.UTC).isoformat(),
        },
    )


if __name__ == "__main__":
    main()
