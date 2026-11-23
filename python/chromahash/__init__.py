"""ChromaHash: modern LQIP (Low Quality Image Placeholder) format."""

from ._constants import Gamut
from ._uniffi import ChromaHash as _CoreHash
from ._uniffi import ChromaHashError
from ._uniffi import Gamut as _CoreGamut
from ._uniffi import compact_tier as _compact_tier
from ._uniffi import default_tier as _default_tier
from ._uniffi import format_version as _format_version
from ._uniffi import max_tier as _max_tier

# The public Gamut keeps the `PROPHOTO_RGB` spelling; the generated enum uses
# `PRO_PHOTO_RGB`. Map across the FFI explicitly.
_GAMUT_TO_CORE = {
    Gamut.SRGB: _CoreGamut.SRGB,
    Gamut.DISPLAY_P3: _CoreGamut.DISPLAY_P3,
    Gamut.ADOBE_RGB: _CoreGamut.ADOBE_RGB,
    Gamut.BT2020: _CoreGamut.BT2020,
    Gamut.PROPHOTO_RGB: _CoreGamut.PRO_PHOTO_RGB,
}

# Tier codes, ordered by quality (spec §2.5). Codes 5..=7 are reserved.
#
# Read from the core through the FFI rather than restated here: the format owns
# these, and a hand-written copy is free to drift from a renumbering.
#: The 21-byte compact tier -- the smallest and lowest fidelity, rendered at
#: ``DEFAULT_TIER``'s resolution.
COMPACT_TIER = _compact_tier()
#: The 32-byte tier :meth:`ChromaHash.encode` produces. Pass this rather than a
#: literal: the codes are ordered by quality, so a bare ``0`` is the compact tier.
DEFAULT_TIER = _default_tier()
#: The highest valid tier code.
MAX_TIER = _max_tier()
#: The format generation this build writes and accepts (the ``version`` field of
#: byte 0).
FORMAT_VERSION = _format_version()


class ChromaHash:
    """ChromaHash: a compact LQIP (Low Quality Image Placeholder).

    A thin facade over the UniFFI-generated bindings to the Rust core. Output is
    byte-identical to every other ChromaHash implementation. The hash is variable
    length (32 bytes at the default quality tier); native objects are created transiently
    per operation.
    """

    def __init__(self, hash_bytes: bytes) -> None:
        self._hash = bytes(hash_bytes)

    @classmethod
    def encode(
        cls,
        w: int,
        h: int,
        rgba: bytes | bytearray,
        gamut: Gamut = Gamut.SRGB,
    ) -> "ChromaHash":
        """Encode an image into a default-tier (32-byte) ChromaHash.

        Args:
            w: image width (>= 1)
            h: image height (>= 1)
            rgba: pixel data in RGBA format (4 bytes per pixel)
            gamut: source color space

        Raises:
            ChromaHashError.InvalidDimensions: ``w`` or ``h`` is zero.
            ChromaHashError.InvalidLength: ``len(rgba) != w * h * 4``.
        """
        obj = _CoreHash.encode(w, h, bytes(rgba), _GAMUT_TO_CORE[gamut])
        return cls(obj.as_bytes())

    @classmethod
    def encode_with_quality(
        cls,
        w: int,
        h: int,
        rgba: bytes | bytearray,
        gamut: Gamut = Gamut.SRGB,
        quality: int = DEFAULT_TIER,
    ) -> "ChromaHash":
        """Encode an image at an explicit quality tier (0..=MAX_TIER, ordered
        by quality).

        DEFAULT_TIER is the 32-byte tier and COMPACT_TIER the 21-byte one --
        pass those rather than a literal, since a bare 0 is the compact tier.
        Each higher code carries more detail in a
        larger hash. See :meth:`encode` for the argument contract.

        Raises:
            ChromaHashError.InvalidDimensions: ``w`` or ``h`` is zero.
            ChromaHashError.InvalidLength: ``len(rgba) != w * h * 4``.
            ChromaHashError.InvalidTier: ``quality`` is above ``MAX_TIER``.
        """
        obj = _CoreHash.encode_with_quality(w, h, bytes(rgba), _GAMUT_TO_CORE[gamut], quality)
        return cls(obj.as_bytes())

    def decode(self, output: Gamut = Gamut.SRGB) -> tuple[int, int, bytes]:
        """Decode a ChromaHash into an RGBA image in the given output gamut.

        ``output`` selects the display target (``Gamut.SRGB``,
        ``Gamut.DISPLAY_P3``, or ``Gamut.ADOBE_RGB``); wide-gamut colors render
        at full saturation on a matching display. ``Gamut.BT2020`` and
        ``Gamut.PROPHOTO_RGB`` are not display-output gamuts and fall back to
        sRGB. Returns (width, height, rgba_pixels).
        """
        result = _CoreHash.from_bytes(self._hash).decode_to(_GAMUT_TO_CORE[output])
        return (result.width, result.height, result.rgba)

    def decode_capped(
        self, max_w: int, max_h: int, output: Gamut = Gamut.SRGB
    ) -> tuple[int, int, bytes]:
        """Decode a ChromaHash into an RGBA image, capped at the given max
        dimensions, in the given output gamut.
        Returns (width, height, rgba_pixels).
        """
        result = _CoreHash.from_bytes(self._hash).decode_capped_to(
            max_w, max_h, _GAMUT_TO_CORE[output]
        )
        return (result.width, result.height, result.rgba)

    def average_color(self) -> tuple[int, int, int, int]:
        """Extract the average color without full decode.
        Returns (r, g, b, a) as int values in [0, 255].
        """
        c = _CoreHash.from_bytes(self._hash).average_color()
        return (c.r, c.g, c.b, c.a)

    @classmethod
    def from_bytes(cls, hash_bytes: bytes) -> "ChromaHash":
        """Create a ChromaHash from raw hash bytes, validating them up front.

        The format is self-describing, so the header fixes the exact byte
        length: a ChromaHash that comes back from ``from_bytes`` is guaranteed
        to decode.

        Raises:
            ChromaHashError.InvalidData: the bytes are not a valid v2
                ChromaHash (bad version, reserved tier code, set reserved bit,
                or a length that disagrees with the header).
        """
        _CoreHash.from_bytes(bytes(hash_bytes))
        return cls(hash_bytes)

    def as_bytes(self) -> bytes:
        """Get the raw hash bytes (32 at the default tier, more at higher tiers)."""
        return self._hash

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ChromaHash):
            return NotImplemented
        return self._hash == other._hash

    def __repr__(self) -> str:
        return f"ChromaHash({self._hash.hex()})"


from ._batch import BatchEncoder, ImageInput  # noqa: E402

__all__ = [
    "COMPACT_TIER",
    "DEFAULT_TIER",
    "FORMAT_VERSION",
    "MAX_TIER",
    "BatchEncoder",
    "ChromaHash",
    "ChromaHashError",
    "Gamut",
    "ImageInput",
]
