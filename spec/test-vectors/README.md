# ChromaHash Test Vectors

Golden test vectors generated from the Rust reference implementation.
Regenerate with:

```sh
cargo test --manifest-path rust/Cargo.toml -- generate_test_vectors --nocapture --ignored
```

## Files

### Unit tests (wire-format v2)

- `unit-color.json` — OKLAB color space transforms (RGB ↔ OKLAB)
- `unit-mulaw.json` — µ-law companding round-trips for both format µ values
  (MU_L/MU_ALPHA = 5, MU_C = 8), including exact-zero center codes and the
  never-written top code's clamp-down behavior
- `unit-selection.json` — Top-K coefficient selection per spec §6: selected
  `(cx, cy)` pairs and `p_k` for every unique `(W, H, K)` across all 256
  aspect bytes (replaces v0.4's `unit-dct.json` scan orders). Each `(W, H, K)`
  appears twice — the `input` carries the `aniso`/`hv` selection weights, and
  the two rows are the bare priority order (both zero) and the shipped order
  (`_w` suffix, §6.2). Passing both proves an implementation's `selectionKey`
  integer arithmetic, not just its sort
- `unit-aspect.json` — Aspect ratio encoding/decoding and output sizes
- `unit-bitpack.json` — Bit packing `readBits`/`writeBits` operations
- `unit-cbrt.json` — Halley cube root accuracy
- `unit-validate.json` — `from_bytes` accept/reject cases: version, tier,
  reserved-bit, and length validation (spec §2.6)

### Integration tests (wire-format v2)

- `integration-encode.json` — Full encode: input RGBA → hash, across quality
  every tier code 0–4 (21/32/108/411/1623 bytes no-alpha). Includes degenerate dimensions
  (`strip_1x100`, `strip_100x1`, `solid_1x1`), gamut-corner solids,
  wide-gamut solids (Display P3, ProPhoto), and the 16:1 aspect clamp
  boundary.
- `integration-decode.json` — Full decode: hash → output RGBA at the
  natural size (long edge `32·2^renderLevel(tier)` px)
- `integration-decode-capped.json` — Capped decode: hash + `max_width`/
  `max_height` → output RGBA. Covers sub-natural rendering (the band-limited
  frequency skip of spec §11.3), including the 1×N strips that rendered
  solid white under v0.5, and caps larger than natural (no upscaling).

## Schema

Each JSON file contains an array of test cases. Every test case has:

```json
{
  "name": "descriptive name",
  "input": { ... },
  "expected": { ... }
}
```

All floating-point values are rounded to 15 significant digits.
All byte arrays are represented as arrays of integers (0–255).
