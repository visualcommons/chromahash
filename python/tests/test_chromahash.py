"""End-to-end parity tests for the ChromaHash Python binding.

The package is now a thin facade over the UniFFI-generated bindings to the Rust
core, so these tests exercise the public API against the shared spec vectors —
the cross-language parity gate. Per-function unit tests of the algorithm live in
the Rust core (the single source of truth).
"""

import json
import os

import pytest

from chromahash import (
    COMPACT_TIER,
    DEFAULT_TIER,
    FORMAT_VERSION,
    MAX_TIER,
    BatchEncoder,
    ChromaHash,
    ChromaHashError,
    Gamut,
    ImageInput,
)

SPEC_VECTORS = os.path.join(os.path.dirname(__file__), "../../spec/test-vectors")


def load_vectors(name: str) -> list:
    """A missing or empty vector file is a broken gate, not a reason to pass."""
    path = os.path.join(SPEC_VECTORS, name)
    assert os.path.exists(path), f"spec vector file not found: {path}"
    with open(path) as f:
        cases = json.load(f)
    assert cases, f"spec vector file is empty: {name}"
    return cases


def gamut_from_name(name: str) -> Gamut:
    return {
        "sRGB": Gamut.SRGB,
        "Display P3": Gamut.DISPLAY_P3,
        "Adobe RGB": Gamut.ADOBE_RGB,
        "BT.2020": Gamut.BT2020,
        "ProPhoto RGB": Gamut.PROPHOTO_RGB,
    }[name]  # KeyError names the gamut; a silent sRGB fallback would surface
    # as a hash mismatch on an unrelated assertion instead.


def solid_image(w: int, h: int, r: int, g: int, b: int, a: int) -> bytes:
    return bytes([r, g, b, a]) * (w * h)


def test_integration_encode():
    cases = load_vectors("integration-encode.json")
    assert cases
    for tc in cases:
        name = tc["name"]
        inp = tc["input"]
        rgba = bytes(inp["rgba"])
        ch = ChromaHash.encode_with_quality(
            inp["width"], inp["height"], rgba, gamut_from_name(inp["gamut"]), inp["tier"]
        )
        assert list(ch.as_bytes()) == tc["expected"]["hash"], f"{name}: hash mismatch"
        if "average_color" in tc["expected"]:
            assert list(ch.average_color()) == tc["expected"]["average_color"], (
                f"{name}: average_color mismatch"
            )


def test_integration_decode():
    cases = load_vectors("integration-decode.json")
    assert cases
    for tc in cases:
        name = tc["name"]
        ch = ChromaHash.from_bytes(bytes(tc["input"]["hash"]))
        w, h, rgba = ch.decode()
        assert w == tc["expected"]["width"], f"{name}: width"
        assert h == tc["expected"]["height"], f"{name}: height"
        assert list(rgba) == tc["expected"]["rgba"], f"{name}: rgba mismatch"


def test_integration_decode_capped():
    cases = load_vectors("integration-decode-capped.json")
    assert cases
    for tc in cases:
        name = tc["name"]
        inp = tc["input"]
        ch = ChromaHash.from_bytes(bytes(inp["hash"]))
        w, h, rgba = ch.decode_capped(inp["max_width"], inp["max_height"])
        assert w == tc["expected"]["width"], f"{name}: width"
        assert h == tc["expected"]["height"], f"{name}: height"
        assert list(rgba) == tc["expected"]["rgba"], f"{name}: rgba mismatch"


# The byte length is a function of the tier alone, so assert all five rather
# than only the default. These are the lengths spec §3.3 tabulates.
@pytest.mark.parametrize(("tier", "expected"), [(0, 21), (1, 32), (2, 108), (3, 411), (4, 1623)])
def test_each_tier_encodes_to_its_documented_length(tier: int, expected: int):
    rgba = solid_image(4, 4, 128, 128, 128, 255)
    ch = ChromaHash.encode_with_quality(4, 4, rgba, Gamut.SRGB, tier)
    assert len(ch.as_bytes()) == expected


def test_encode_defaults_to_the_default_tier():
    rgba = solid_image(4, 4, 128, 128, 128, 255)
    plain = ChromaHash.encode(4, 4, rgba, Gamut.SRGB)
    explicit = ChromaHash.encode_with_quality(4, 4, rgba, Gamut.SRGB, DEFAULT_TIER)
    assert plain.as_bytes() == explicit.as_bytes()
    # ...and the compact tier is genuinely a different, smaller code.
    compact = ChromaHash.encode_with_quality(4, 4, rgba, Gamut.SRGB, COMPACT_TIER)
    assert len(compact.as_bytes()) < len(plain.as_bytes())


# Decoded dimensions come from the aspect byte and the tier's raster. A range
# check wide enough to pass for every tier cannot tell them apart.
@pytest.mark.parametrize(("tier", "edge"), [(0, 32), (1, 32), (2, 64), (3, 128), (4, 256)])
def test_decoded_dimensions_follow_the_tier_raster(tier: int, edge: int):
    rgba = solid_image(4, 4, 128, 64, 32, 255)
    ch = ChromaHash.encode_with_quality(4, 4, rgba, Gamut.SRGB, tier)
    w, h, pixels = ch.decode()
    assert (w, h) == (edge, edge)
    assert len(pixels) == w * h * 4


def test_from_bytes_roundtrip():
    ch = ChromaHash.encode(4, 4, solid_image(4, 4, 128, 64, 32, 255), Gamut.SRGB)
    assert ChromaHash.from_bytes(ch.as_bytes()) == ch


@pytest.mark.parametrize("tier", range(MAX_TIER + 1))
def test_from_bytes_rejects_wrong_length(tier: int):
    """Every tier has its own exact length, so a fixed one is not a valid
    assertion about any of them — bracket each tier's own encoding.

    The header is self-describing, so a length that disagrees with it is
    rejected at construction rather than deferred to ``decode``.
    """
    encoded = ChromaHash.encode_with_quality(
        4, 4, solid_image(4, 4, 128, 64, 32, 255), Gamut.SRGB, tier
    ).as_bytes()
    ChromaHash.from_bytes(encoded).decode()  # accepted, and decodes

    with pytest.raises(ChromaHashError.InvalidData):
        ChromaHash.from_bytes(encoded[:-1])
    with pytest.raises(ChromaHashError.InvalidData):
        ChromaHash.from_bytes(encoded + b"\x00")
    with pytest.raises(ChromaHashError.InvalidData):
        ChromaHash.from_bytes(b"")


@pytest.mark.parametrize(
    ("what", "mutate"),
    [
        # The reserved bit is how v1 reserves room for a future extension: a
        # decoder that ignored it would accept a later format's hash and render
        # garbage.
        ("reserved bit set", lambda b: b | 0b1000_0000),
        ("reserved tier code", lambda b: (b & ~0b0011_1000) | ((MAX_TIER + 1) << 3)),
        ("unsupported version", lambda b: b | 0b0000_0010),
    ],
)
def test_from_bytes_rejects_a_malformed_header(what, mutate):
    encoded = bytearray(ChromaHash.encode(4, 4, solid_image(4, 4, 1, 2, 3, 255)).as_bytes())
    encoded[0] = mutate(encoded[0]) & 0xFF
    with pytest.raises(ChromaHashError.InvalidData):
        ChromaHash.from_bytes(bytes(encoded))


# The core panics on invalid input, and a panic across the FFI boundary is
# undefined behaviour — so the UniFFI layer validates first and raises a typed
# error, matching the C ABI's status codes (issue #8).
@pytest.mark.parametrize(
    ("width", "height", "rgba_len", "error"),
    [
        (0, 4, 0, ChromaHashError.InvalidDimensions),
        (4, 0, 0, ChromaHashError.InvalidDimensions),
        (4, 4, 63, ChromaHashError.InvalidLength),
    ],
)
def test_encode_rejects_invalid_input(width, height, rgba_len, error):
    with pytest.raises(error):
        ChromaHash.encode(width, height, bytes(rgba_len), Gamut.SRGB)


def test_encode_with_quality_rejects_a_reserved_tier():
    rgba = solid_image(4, 4, 128, 64, 32, 255)
    with pytest.raises(ChromaHashError.InvalidTier):
        ChromaHash.encode_with_quality(4, 4, rgba, Gamut.SRGB, MAX_TIER + 1)


# ── batch ──────────────────────────────────────────────────────────────────────


def test_batch_encode_honors_quality():
    """Pin the tier down to the byte count. Comparing the batch against the
    serial path alone would pass if both silently used one tier.
    """
    rgba = solid_image(8, 8, 200, 100, 50, 255)
    items = [ImageInput(8, 8, rgba, Gamut.SRGB, tier) for tier in range(COMPACT_TIER, MAX_TIER + 1)]
    hashes = BatchEncoder().encode_batch(items)
    assert [len(h.as_bytes()) for h in hashes] == [21, 32, 108, 411, 1623]


def test_batch_encode_defaults_to_the_default_tier():
    """An item with no explicit tier must match ``encode`` — the codes are
    ordered by quality, so a zero default would be the 21-byte compact tier.
    """
    rgba = solid_image(8, 8, 200, 100, 50, 255)
    (batched,) = BatchEncoder().encode_batch([ImageInput(8, 8, rgba, Gamut.SRGB)])
    assert batched == ChromaHash.encode(8, 8, rgba, Gamut.SRGB)


def test_batch_encode_rejects_a_reserved_tier():
    """The batch path raises the same typed errors as `encode_with_quality`,
    not a bare ValueError — one taxonomy for the caller, matching every other
    binding.
    """
    rgba = solid_image(4, 4, 128, 64, 32, 255)
    with pytest.raises(ChromaHashError.InvalidTier, match="item 1"):
        BatchEncoder().encode_batch(
            [
                ImageInput(4, 4, rgba, Gamut.SRGB),
                ImageInput(4, 4, rgba, Gamut.SRGB, MAX_TIER + 1),
            ]
        )


def test_tier_constants_come_from_the_core():
    """They are read across the FFI, not restated here, so comparing them to
    themselves would assert nothing. What is checkable is the contract: the
    ordering the format guarantees, and the byte length each code selects.
    """
    assert COMPACT_TIER < DEFAULT_TIER < MAX_TIER
    assert FORMAT_VERSION == 1

    rgba = solid_image(4, 4, 128, 128, 128, 255)
    assert (
        len(ChromaHash.encode_with_quality(4, 4, rgba, Gamut.SRGB, COMPACT_TIER).as_bytes()) == 21
    )
    assert (
        len(ChromaHash.encode_with_quality(4, 4, rgba, Gamut.SRGB, DEFAULT_TIER).as_bytes()) == 32
    )
    with pytest.raises(ChromaHashError.InvalidTier):
        ChromaHash.encode_with_quality(4, 4, rgba, Gamut.SRGB, MAX_TIER + 1)
