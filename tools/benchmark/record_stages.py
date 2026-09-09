"""Record one cell of `spec/PERFORMANCE.md` §1 into the committed stages baseline.

Reads the `stage=nanoseconds` lines `rust/examples/bench_stages.rs` prints on
stdin and merges them into `tools/comparison/baselines/perf-stages.json` as one
cell, keyed `WxH-tTIER`. §1 is a three-column table and each column is its own
invocation, so the file is merged rather than replaced: a fresh file per run
would leave the other two columns unmeasured.

Invoked by `mise-tasks/benchmark/stages`. It lives here, as a module, rather
than in a heredoc inside that task: this file defines the schema
`verify:benchmark` gates §1 against, and `tools/benchmark/` is the tree
`mise run lint:benchmark` and `mise run format:check:benchmark` cover. A
heredoc'd copy was the only Python in `mise-tasks/` and was outside every lint
and format task in the repo.

Usage:
    bench_stages ... | python3 tools/benchmark/record_stages.py W H TIER ITERS OUT
"""

import datetime
import json
import os
import subprocess
import sys

SCHEMA = "chromahash-perf-stages/1"

# Provenance is recorded so `verify:benchmark` can refuse a baseline that cannot
# be traced to a source state. The artifact itself is excluded from the probe:
# writing it *is* the point of this script, §1 is three columns and therefore
# three invocations, and without the exclusion every invocation after the first
# observes its predecessor's write and records `dirty: true` — which the gate
# hard-fails with advice ("re-run benchmark:stages from a clean tree") that no
# three-invocation table can ever follow. The probe also runs *after* the write
# rather than before, so it sees anything the build itself left behind.


def git(*args: str) -> str:
    """Run a git command, returning stripped stdout (empty on any failure)."""
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=False
    ).stdout.strip()


def provenance(out: str) -> dict[str, object]:
    """The revision these shares were measured at, and whether anything else was dirty."""
    top = git("rev-parse", "--show-toplevel")
    rel = os.path.relpath(os.path.abspath(out), top) if top else out
    # `:/` is every path in the repo; `:(exclude,top)` is repo-root-relative, so
    # this is correct regardless of the working directory the task runs from.
    status = git("status", "--porcelain", "--", ":/", f":(exclude,top){rel}")
    return {"rev": git("rev-parse", "--short", "HEAD"), "dirty": status != ""}


def load(out: str) -> dict:
    """The existing baseline, or a fresh document. A schema mismatch is fatal."""
    if not os.path.exists(out):
        return {"schema": SCHEMA, "cells": {}}
    try:
        with open(out, encoding="utf-8") as f:
            existing = json.load(f)
    except json.JSONDecodeError as e:
        sys.exit(f"{out}: not valid JSON ({e}). Inspect it before re-recording.")
    found = existing.get("schema")
    if found != SCHEMA:
        # Silently discarding it would drop the other two columns of §1 and
        # leave a one-cell baseline that the gate reports as a missing table
        # rather than as a schema change.
        sys.exit(
            f"{out}: schema {found!r}, expected {SCHEMA!r}.\n"
            "Refusing to overwrite: this file holds one cell per column of "
            "PERFORMANCE.md §1, and replacing it would discard the columns "
            "this run does not measure.\n"
            "Delete it deliberately and re-record all three columns:\n"
            "  mise run benchmark:stages 100 100 1\n"
            "  mise run benchmark:stages 512 512 1\n"
            "  mise run benchmark:stages 512 512 4"
        )
    existing.setdefault("cells", {})
    return existing


def write(out: str, doc: dict) -> None:
    with open(out, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, sort_keys=True)
        f.write("\n")


def main() -> None:
    w, h, tier, iters, out = sys.argv[1:6]

    stages: dict[str, int] = {}
    for line in sys.stdin:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        stages[k] = int(v)

    cell = f"{w}x{h}-t{tier}"
    doc = load(out)
    total = stages.get("whole_encode", 0)
    doc["cells"][cell] = {
        "width": int(w),
        "height": int(h),
        "tier": int(tier),
        "iters": int(iters),
        "ns": stages,
        # Shares of the whole encode, which is what §1 publishes: a ratio taken
        # inside one process, and the reason that table is readable on a host
        # whose absolute wall-clock is not.
        #
        # `quantize_and_pack` is not a marked stage. bench_stages.rs derives it
        # as whole_encode - stage_sum, so it is a residual and its share is
        # whatever the marked stages do not account for. §1 says so in place.
        "sharePct": {
            k: (v * 100.0 / total if total else 0.0)
            for k, v in stages.items()
            if k not in ("stage_sum", "whole_encode")
        },
        "recordedAt": datetime.datetime.now(datetime.UTC).isoformat(),
    }

    # Write, then probe, then record what the probe saw. The write is what makes
    # the tree dirty, and it is the one change this script is entitled to make.
    write(out, doc)
    doc["cells"][cell]["git"] = provenance(out)
    write(out, doc)
    print(f"\nrecorded cell {cell} -> {out}")


if __name__ == "__main__":
    main()
