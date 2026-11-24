#!/usr/bin/env python3
"""Write the fuzz seed corpora from the shared spec vectors.

Seeds are generated, never committed: every fuzz run (`mise run fuzz:rust`,
`mise run fuzz:c`, the CI smoke job) runs this first, so the seeds always
follow `spec/test-vectors/` and cannot drift from them.

Each target's byte layout is documented beside the target itself
(`rust/fuzz/src/lib.rs` for the core, the module docs of
`bindings/c/fuzz/fuzz_targets/*.rs` for the C ABI); this script must write
exactly those layouts.

Usage: python3 rust/fuzz/seeds.py        # from anywhere; paths are repo-relative
"""

import json
import shutil
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VECTORS = ROOT / "spec" / "test-vectors"
CORE = ROOT / "rust" / "fuzz" / "seeds"
C_ABI = ROOT / "bindings" / "c" / "fuzz" / "seeds"

# The C ABI's CHROMA_HASH_GAMUT_* values, 0-4, whose order the core targets
# share (`chromahash_fuzz::GAMUTS`).
GAMUTS = ["sRGB", "Display P3", "Adobe RGB", "BT.2020", "ProPhoto RGB"]
UNCAPPED = 0xFFFF_FFFF

# c_handle flags, bits 5-6: which decode entry point runs.
ENTRY_DECODE = 0 << 5
ENTRY_DECODE_CAPPED = 2 << 5
# c_encode flags, bit 3: also batch-encode the image.
BATCH = 1 << 3


def load(name):
    with open(VECTORS / name, encoding="utf-8") as f:
        return json.load(f)


def hashes():
    """Every hash the integration vectors name, as (seed name, bytes, caps)."""
    for v in load("integration-decode.json"):
        yield f"decode-{v['name']}", bytes(v["input"]["hash"]), (UNCAPPED, UNCAPPED)
    for v in load("integration-decode-capped.json"):
        i = v["input"]
        yield f"capped-{v['name']}", bytes(i["hash"]), (i["max_width"], i["max_height"])
    for v in load("integration-encode.json"):
        yield f"encode-{v['name']}", bytes(v["expected"]["hash"]), (UNCAPPED, UNCAPPED)


def images():
    for v in load("integration-encode.json"):
        i = v["input"]
        yield v["name"], i["width"], i["height"], GAMUTS.index(i["gamut"]), i["tier"], bytes(i["rgba"])


def write(directory, name, data):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_bytes(data)


def main():
    for target in ("from_bytes", "decode", "encode"):
        shutil.rmtree(CORE / target, ignore_errors=True)
    for target in ("c_handle", "c_encode"):
        shutil.rmtree(C_ABI / target, ignore_errors=True)

    for name, h, (max_w, max_h) in hashes():
        capped = (max_w, max_h) != (UNCAPPED, UNCAPPED)
        write(CORE / "from_bytes", name, h)
        write(CORE / "decode", name, struct.pack("<BII", 0, max_w, max_h) + h)
        flags = ENTRY_DECODE_CAPPED if capped else ENTRY_DECODE
        write(C_ABI / "c_handle", name, struct.pack("<BBIIH", flags, 0, max_w, max_h, len(h)) + h)

    # unit-validate.json holds the accept/reject cases of spec §2.6: exactly
    # the boundary from_bytes is fuzzed across.
    for v in load("unit-validate.json"):
        write(CORE / "from_bytes", f"validate-{v['name']}", bytes(v["input"]["bytes"]))

    for name, w, h, gamut, tier, rgba in images():
        write(CORE / "encode", name, struct.pack("<HHBB", w, h, gamut, tier) + rgba)
        write(C_ABI / "c_encode", name, struct.pack("<BBBHHb", BATCH, gamut, tier, w, h, 0) + rgba)

    for d in (CORE, C_ABI):
        for target in sorted(p for p in d.iterdir() if p.is_dir()):
            print(f"{target.relative_to(ROOT)}: {sum(1 for _ in target.iterdir())} seeds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
