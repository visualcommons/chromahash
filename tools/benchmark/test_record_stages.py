"""Tests for record_stages.py, the recorder behind `spec/PERFORMANCE.md` §1.

The recorder defines what `verify:benchmark` gates §1 against, and its three
load-bearing behaviours had no test: merging one cell per invocation (§1 is
three columns, so a replace would drop two of them), refusing a file in another
schema rather than silently discarding it, and a dirty probe that ignores the
recorder's own output but nothing else (without the exclusion, invocations two
and three record `dirty: true` and the gate can never pass).

Each test runs the script as `benchmark:stages` does - a subprocess reading
`stage=nanoseconds` lines on stdin - inside a throwaway git repository, so the
probe sees a tree whose state the test controls. Run with
`mise run test:benchmark`.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "record_stages.py"

# Scratch space under this directory rather than the system temp dir, so a test
# run writes nothing outside the checkout. The root .gitignore ignores output/.
SCRATCH = HERE / "output"

STAGES = "\n".join(
    [
        "# bench_stages 100x100 tier 1",
        "eotf_lut=10",
        "linearize=40",
        "dct_forward=600",
        "quantize_and_pack=350",
        "stage_sum=650",
        "whole_encode=1000",
        "",
    ]
)

# A throwaway repository must not inherit the machine's commit hooks or signing.
GIT = [
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
]


class RecordStagesTest(unittest.TestCase):
    def setUp(self) -> None:
        SCRATCH.mkdir(exist_ok=True)
        self._tmp = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.repo = Path(self._tmp.name)
        self.git("init", "-q")
        (self.repo / "README").write_text("fixture\n", encoding="utf-8")
        self.baselines = self.repo / "tools" / "comparison" / "baselines"
        self.baselines.mkdir(parents=True)
        self.out = self.baselines / "perf-stages.json"
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "fixture")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(
            [*GIT, *args], cwd=self.repo, capture_output=True, text=True, check=True
        ).stdout.strip()

    def record(
        self, w: int, h: int, tier: int, iters: int = 5, stdin: str = STAGES
    ) -> subprocess.CompletedProcess[str]:
        # Relative OUT from the repo root, as the mise task passes it.
        rel = os.path.relpath(self.out, self.repo)
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(w), str(h), str(tier), str(iters), rel],
            input=stdin,
            cwd=self.repo,
            capture_output=True,
            text=True,
            check=False,
        )

    def load(self) -> dict:
        return json.loads(self.out.read_text(encoding="utf-8"))

    def test_merges_one_cell_per_invocation(self) -> None:
        for w, h, tier in [(100, 100, 1), (512, 512, 1), (512, 512, 4)]:
            self.assertEqual(self.record(w, h, tier).returncode, 0)
        doc = self.load()
        self.assertEqual(doc["schema"], "chromahash-perf-stages/1")
        self.assertEqual(sorted(doc["cells"]), ["100x100-t1", "512x512-t1", "512x512-t4"])

        cell = doc["cells"]["512x512-t4"]
        self.assertEqual((cell["width"], cell["height"], cell["tier"]), (512, 512, 4))
        self.assertEqual(cell["iters"], 5)
        self.assertEqual(cell["ns"]["whole_encode"], 1000)
        # Shares are of the whole encode, and the two totals are not rows.
        self.assertAlmostEqual(cell["sharePct"]["dct_forward"], 60.0)
        self.assertAlmostEqual(cell["sharePct"]["quantize_and_pack"], 35.0)
        self.assertNotIn("whole_encode", cell["sharePct"])
        self.assertNotIn("stage_sum", cell["sharePct"])

    def test_rerecording_a_cell_replaces_only_that_cell(self) -> None:
        self.record(100, 100, 1)
        self.record(512, 512, 1)
        before = self.load()["cells"]["512x512-t1"]
        self.record(
            100, 100, 1, iters=9, stdin=STAGES.replace("dct_forward=600", "dct_forward=700")
        )
        cells = self.load()["cells"]
        self.assertEqual(cells["100x100-t1"]["iters"], 9)
        self.assertEqual(cells["100x100-t1"]["ns"]["dct_forward"], 700)
        self.assertEqual(cells["512x512-t1"], before)

    def test_refuses_a_file_in_another_schema(self) -> None:
        original = json.dumps({"schema": "chromahash-perf-stages/0", "cells": {"x": {}}})
        self.out.write_text(original, encoding="utf-8")
        result = self.record(100, 100, 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing to overwrite", result.stderr)
        self.assertIn("chromahash-perf-stages/0", result.stderr)
        self.assertEqual(self.out.read_text(encoding="utf-8"), original)

    def test_refuses_a_file_that_is_not_json(self) -> None:
        self.out.write_text("{", encoding="utf-8")
        result = self.record(100, 100, 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not valid JSON", result.stderr)
        self.assertEqual(self.out.read_text(encoding="utf-8"), "{")

    def test_own_output_does_not_dirty_later_invocations(self) -> None:
        head = self.git("rev-parse", "--short", "HEAD")
        # Untracked after the first write, modified after committing it: the
        # exclusion must hold in both states.
        self.record(100, 100, 1)
        self.record(512, 512, 1)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "baseline")
        head2 = self.git("rev-parse", "--short", "HEAD")
        self.record(512, 512, 4)
        cells = self.load()["cells"]
        self.assertEqual(cells["100x100-t1"]["git"], {"rev": head, "dirty": False})
        self.assertEqual(cells["512x512-t1"]["git"], {"rev": head, "dirty": False})
        self.assertEqual(cells["512x512-t4"]["git"], {"rev": head2, "dirty": False})

    def test_any_other_change_is_dirty(self) -> None:
        (self.repo / "README").write_text("edited\n", encoding="utf-8")
        self.record(100, 100, 1)
        self.assertTrue(self.load()["cells"]["100x100-t1"]["git"]["dirty"])

    def test_an_untracked_file_elsewhere_is_dirty(self) -> None:
        (self.baselines / "perf-report.json").write_text("{}", encoding="utf-8")
        self.record(100, 100, 1)
        self.assertTrue(self.load()["cells"]["100x100-t1"]["git"]["dirty"])


if __name__ == "__main__":
    unittest.main()
