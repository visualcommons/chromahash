# chromahash (Python)

> Modern, high-quality image placeholder representation for professional formats (LQIP)

`chromahash` encodes an image into a compact, self-describing Low Quality Image
Placeholder (LQIP) — **32 bytes** at the default tier, 21 at the compact one and
108/411/1623 above it — and decodes it back into a low-fidelity preview. Color is
encoded in the perceptually-uniform [OKLAB](https://bottosson.github.io/posts/oklab/)
space with wide-gamut input support (sRGB, Display P3, Adobe RGB, BT.2020,
ProPhoto RGB) and decodes to a caller-chosen display gamut (sRGB, Display P3,
or Adobe RGB).

This is the **Python** binding — a thin facade over UniFFI-generated `ctypes`
bindings to the Rust core. It carries no native algorithm of its own and produces
output **bit-identical** to every other ChromaHash implementation, validated
against the shared [`spec/`](../spec) test vectors. It has zero external runtime
dependencies (`ctypes` is part of the standard library).

```sh
pip install chromahash
```

## Usage

```python
from chromahash import ChromaHash, Gamut

# width × height × 4 bytes (RGBA) — a 2×2 image here.
rgba = bytes([
    255, 0, 0, 255,   0, 255, 0, 255,
    0, 0, 255, 255,   255, 255, 0, 255,
])

ch = ChromaHash.encode(2, 2, rgba, Gamut.SRGB)
print(ch.as_bytes().hex())  # 32 bytes

# Reconstruct a preview. decode() targets sRGB; pass Gamut.DISPLAY_P3 or
# Gamut.ADOBE_RGB to render wide-gamut color.
width, height, pixels = ChromaHash.from_bytes(ch.as_bytes()).decode()
print(width, height, len(pixels))
```

## Building from source

The native library and the generated bindings module are build outputs, staged
by the mise task (needs the Rust toolchain):

```sh
mise run cbuild:python   # stages chromahash/_uniffi.py + the native lib
```

`mise run build:python` and `mise run test:python` run this step automatically.

See the [project repository](https://github.com/visualcommons/chromahash) for the
full format specification and the other language implementations.

> **Note:** ChromaHash is a pre-1.0 **Draft** format — the bitstream is not yet
> guaranteed stable across versions.

## License

Licensed under either of [Apache License, Version 2.0](https://github.com/visualcommons/chromahash/blob/master/LICENSE-APACHE)
or [MIT license](https://github.com/visualcommons/chromahash/blob/master/LICENSE-MIT)
at your option.
