"""Tests for record_stages.py, the recorder behind `spec/PERFORMANCE.md` §1 and §1.1.

The recorder defines what `verify:benchmark` gates §1 and §1.1 against, and its
load-bearing behaviours had no test: merging one cell per invocation (each table
is several columns, so a replace would drop the others), refusing a file in
another schema rather than silently discarding it, and a dirty probe that
ignores the recorder's own outputs but nothing else (without the exclusion,
invocations after the first record `dirty: true` and the gate can never pass).
The decode mode adds a cell that must carry its raster and its spec-vector
check, or not be written at all.

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
        "ac_quantize=340",
        "stage_sum=990",
        "whole_encode=1000",
        "unmarked=10",
        "",
    ]
)

DECODE_STAGES = "\n".join(
    [
        "# decode of a 100x100 gradient at tier 4, capped 32x32",
        "meta.hash_bytes=1623",
        "meta.render_width=32",
        "meta.render_height=32",
        "meta.vectors_checked=19",
        "header=10",
        "selection=80",
        "render=900",
        "stage_sum=990",
        "whole_decode=1000",
        "unmarked=10",
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
        self.assertAlmostEqual(cell["sharePct"]["ac_quantize"], 34.0)
        self.assertAlmostEqual(cell["sharePct"]["unmarked"], 1.0)
        self.assertNotIn("whole_encode", cell["sharePct"])
        self.assertNotIn("stage_sum", cell["sharePct"])

    def test_a_tiny_share_is_written_as_biome_writes_it(self) -> None:
        # 18 ns of a 1e9 ns encode is a share of 1.8e-06, which Python spells
        # `1.8e-06` and `biome format` spells `1.8e-6`; the committed file has
        # to be the one `format:check:compare` accepts, and still the same
        # number.
        stdin = "\n".join(["refine=18", "dct_forward=999999982", "stage_sum=1000000000"])
        stdin += "\nwhole_encode=1000000000\nunmarked=0\n"
        self.assertEqual(self.record(512, 512, 1, stdin=stdin).returncode, 0)
        text = self.out.read_text(encoding="utf-8")
        self.assertIn('"refine": 1.8e-6', text)
        self.assertNotIn("e-06", text)
        self.assertAlmostEqual(self.load()["cells"]["512x512-t1"]["sharePct"]["refine"], 1.8e-6)

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

    # ─── --decode: PERFORMANCE.md §1.1 ─────────────────────────────────────

    def record_decode(
        self, tier: int, cap: str = "natural", iters: int = 5, stdin: str = DECODE_STAGES
    ) -> subprocess.CompletedProcess[str]:
        rel = os.path.relpath(self.decode_out, self.repo)
        argv = ["--decode", "100", "100", str(tier), str(iters), cap, rel]
        return subprocess.run(
            [sys.executable, str(SCRIPT), *argv],
            input=stdin,
            cwd=self.repo,
            capture_output=True,
            text=True,
            check=False,
        )

    @property
    def decode_out(self) -> Path:
        return self.baselines / "perf-decode-stages.json"

    def load_decode(self) -> dict:
        return json.loads(self.decode_out.read_text(encoding="utf-8"))

    def test_decode_cells_carry_raster_vectors_and_shares(self) -> None:
        self.assertEqual(self.record_decode(1).returncode, 0)
        self.assertEqual(self.record_decode(4, cap="32x32", iters=7).returncode, 0)
        doc = self.load_decode()
        self.assertEqual(doc["schema"], "chromahash-perf-decode-stages/1")
        self.assertEqual(sorted(doc["cells"]), ["100x100-t1-natural", "100x100-t4-cap32x32"])

        natural = doc["cells"]["100x100-t1-natural"]
        self.assertIsNone(natural["cap"])
        capped = doc["cells"]["100x100-t4-cap32x32"]
        self.assertEqual(capped["cap"], {"width": 32, "height": 32})
        self.assertEqual((capped["tier"], capped["iters"]), (4, 7))
        self.assertEqual(capped["render"], {"width": 32, "height": 32})
        self.assertEqual((capped["hashBytes"], capped["vectorsChecked"]), (1623, 19))
        # meta.* lines are fields, never stages.
        self.assertNotIn("meta.render_width", capped["ns"])
        self.assertNotIn("render_width", capped["sharePct"])
        self.assertAlmostEqual(capped["sharePct"]["render"], 90.0)
        self.assertAlmostEqual(capped["sharePct"]["unmarked"], 1.0)
        self.assertNotIn("whole_decode", capped["sharePct"])
        self.assertNotIn("stage_sum", capped["sharePct"])
        self.assertAlmostEqual(sum(capped["sharePct"].values()), 100.0)

    def test_decode_refuses_output_without_its_vector_check(self) -> None:
        for broken in (
            DECODE_STAGES.replace("meta.vectors_checked=19\n", ""),
            DECODE_STAGES.replace("meta.vectors_checked=19", "meta.vectors_checked=0"),
            DECODE_STAGES.replace("whole_decode=1000\n", ""),
        ):
            result = self.record_decode(4, stdin=broken)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("nothing recorded", result.stderr)
        self.assertFalse(self.decode_out.exists())

    def test_decode_refuses_a_malformed_cap(self) -> None:
        for cap in ("32", "0x32", "32x", "capped"):
            result = self.record_decode(4, cap=cap)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("CAP must be", result.stderr)
        self.assertFalse(self.decode_out.exists())

    def test_decode_refuses_a_file_in_another_schema(self) -> None:
        original = json.dumps({"schema": "chromahash-perf-stages/1", "cells": {"x": {}}})
        self.decode_out.write_text(original, encoding="utf-8")
        result = self.record_decode(4)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing to overwrite", result.stderr)
        self.assertIn("§1.1", result.stderr)
        self.assertIn("benchmark:decode-stages", result.stderr)
        self.assertEqual(self.decode_out.read_text(encoding="utf-8"), original)

    def test_the_sibling_artifact_does_not_dirty_either_table(self) -> None:
        # §0's procedure records §1 and then §1.1 before committing either.
        head = self.git("rev-parse", "--short", "HEAD")
        self.record(100, 100, 1)  # perf-stages.json now untracked
        self.record_decode(4)
        self.assertEqual(
            self.load_decode()["cells"]["100x100-t4-natural"]["git"], {"rev": head, "dirty": False}
        )
        self.record(512, 512, 1)  # and the decode file is untracked for this one
        self.assertEqual(self.load()["cells"]["512x512-t1"]["git"], {"rev": head, "dirty": False})

    def test_decode_any_other_change_is_dirty(self) -> None:
        (self.baselines / "perf-report.json").write_text("{}", encoding="utf-8")
        self.record_decode(4)
        self.assertTrue(self.load_decode()["cells"]["100x100-t4-natural"]["git"]["dirty"])


if __name__ == "__main__":
    unittest.main()
