# chromahash

> Modern, high-quality image placeholder representation for professional formats (LQIP)

`chromahash` encodes an image into a compact Low Quality Image Placeholder
(LQIP) — **32 bytes** at the default quality tier, with opt-in tiers from 21 B
up to ~1.6 kB — and decodes it back into a low-fidelity
preview. Color is encoded in the perceptually-uniform
[OKLAB](https://bottosson.github.io/posts/oklab/) space with wide-gamut input
support (sRGB, Display P3, Adobe RGB, BT.2020, ProPhoto RGB), an adaptive DCT
grid, and alpha. The byte length is self-describing from the first byte.

This is the **Rust** implementation. It is part of a multi-language project whose
implementations are validated **bit-exact** against a shared specification, so the
same input produces the same placeholder in every language. The crate is
zero-dependency.

```toml
[dependencies]
chromahash = "0.8"
```

The minimum supported Rust version (MSRV) is **1.85**.

See the [project repository](https://github.com/visualcommons/chromahash) for the
full format specification, the other language implementations, and usage
examples.

> **Note:** ChromaHash is a pre-1.0 **Draft** format — the bitstream is not yet
> guaranteed stable across versions.

## License

Licensed under either of [Apache License, Version 2.0](https://github.com/visualcommons/chromahash/blob/master/LICENSE-APACHE)
or [MIT license](https://github.com/visualcommons/chromahash/blob/master/LICENSE-MIT)
at your option.
