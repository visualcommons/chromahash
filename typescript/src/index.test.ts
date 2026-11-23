import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compactTier as wasmCompactTier,
  defaultTier as wasmDefaultTier,
  formatVersion as wasmFormatVersion,
  maxTier as wasmMaxTier,
} from "../wasm/chromahash_wasm.js";
import { FORMAT_VERSION } from "./header.ts";
import {
  COMPACT_TIER,
  ChromaHash,
  DEFAULT_TIER,
  MAX_TIER,
  init,
} from "./index.ts";
import type { Gamut } from "./index.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(currentDir, "../../spec/test-vectors");
const wasmPath = resolve(currentDir, "../wasm/chromahash_wasm_bg.wasm");

// The full path is WASM-backed; instantiate it once before any test runs.
await init(readFileSync(wasmPath));

function loadVectors<T>(name: string): T {
  // A missing or empty vector file is a broken gate, not a reason to pass:
  // `JSON.parse` of `[]` would let every `for` below run zero assertions and
  // report green. That is the defect this suite exists to prevent elsewhere.
  const parsed = JSON.parse(readFileSync(resolve(specDir, name), "utf-8"));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`spec vector file is missing or empty: ${name}`);
  }
  return parsed as T;
}

/**
 * The spec vectors name their gamut as a string, and the loader above casts it
 * to `Gamut` without checking. A vector naming a gamut this package does not
 * know would reach `GAMUT_TO_WASM` as an unmapped key and cross the FFI as
 * `undefined` — reported as a hash mismatch rather than as the real cause, the
 * same silent-fallback failure the other bindings guard against.
 */
const KNOWN_GAMUTS: readonly Gamut[] = [
  "sRGB",
  "Display P3",
  "Adobe RGB",
  "BT.2020",
  "ProPhoto RGB",
];

function checkedGamut(name: string): Gamut {
  const found = KNOWN_GAMUTS.find((g) => g === name);
  if (!found) throw new Error(`unknown gamut in spec vector: ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// Integration: encode (hash + average color, byte-exact vs. the reference)
// ---------------------------------------------------------------------------

interface EncodeVector {
  name: string;
  input: {
    width: number;
    height: number;
    gamut: Gamut;
    tier: number;
    rgba: number[];
  };
  expected: { hash: number[]; average_color: [number, number, number, number] };
}

describe("integration encode", () => {
  const vectors = loadVectors<EncodeVector[]>("integration-encode.json");

  for (const vec of vectors) {
    it(`encode ${vec.name}`, () => {
      const rgba = new Uint8Array(vec.input.rgba);
      const ch = ChromaHash.encodeWithQuality(
        vec.input.width,
        vec.input.height,
        rgba,
        checkedGamut(vec.input.gamut),
        vec.input.tier,
      );
      assert.deepStrictEqual(
        ch.hash,
        new Uint8Array(vec.expected.hash),
        `hash mismatch for ${vec.name}`,
      );
    });

    it(`average color ${vec.name}`, () => {
      const rgba = new Uint8Array(vec.input.rgba);
      const ch = ChromaHash.encode(
        vec.input.width,
        vec.input.height,
        rgba,
        checkedGamut(vec.input.gamut),
      );
      const avg = ch.averageColor();
      assert.equal(avg.r, vec.expected.average_color[0], "R mismatch");
      assert.equal(avg.g, vec.expected.average_color[1], "G mismatch");
      assert.equal(avg.b, vec.expected.average_color[2], "B mismatch");
      assert.equal(avg.a, vec.expected.average_color[3], "A mismatch");
    });
  }
});

// ---------------------------------------------------------------------------
// Integration: decode
// ---------------------------------------------------------------------------

interface DecodeVector {
  name: string;
  input: { hash: number[] };
  expected: { width: number; height: number; rgba: number[] };
}

describe("integration decode", () => {
  const vectors = loadVectors<DecodeVector[]>("integration-decode.json");

  for (const vec of vectors) {
    it(`decode ${vec.name}`, () => {
      const ch = ChromaHash.fromBytes(new Uint8Array(vec.input.hash));
      const decoded = ch.decode();

      assert.equal(decoded.w, vec.expected.width, "width mismatch");
      assert.equal(decoded.h, vec.expected.height, "height mismatch");
      assert.equal(
        decoded.rgba.length,
        vec.expected.rgba.length,
        "rgba length mismatch",
      );
      for (let i = 0; i < vec.expected.rgba.length; i++) {
        const actual = decoded.rgba[i] as number;
        const expected = vec.expected.rgba[i] as number;
        assert.ok(
          Math.abs(actual - expected) <= 1,
          `pixel byte ${i}: expected ${expected}, got ${actual}`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Integration: capped decode
// ---------------------------------------------------------------------------

interface DecodeCappedVector {
  name: string;
  input: { hash: number[]; max_width: number; max_height: number };
  expected: { width: number; height: number; rgba: number[] };
}

describe("integration decode capped", () => {
  const vectors = loadVectors<DecodeCappedVector[]>(
    "integration-decode-capped.json",
  );

  for (const vec of vectors) {
    it(`decode capped ${vec.name}`, () => {
      const ch = ChromaHash.fromBytes(new Uint8Array(vec.input.hash));
      const decoded = ch.decodeCapped(
        vec.input.max_width,
        vec.input.max_height,
      );

      assert.equal(decoded.w, vec.expected.width, "width mismatch");
      assert.equal(decoded.h, vec.expected.height, "height mismatch");
      assert.equal(
        decoded.rgba.length,
        vec.expected.rgba.length,
        "rgba length mismatch",
      );
      for (let i = 0; i < vec.expected.rgba.length; i++) {
        const actual = decoded.rgba[i] as number;
        const expected = vec.expected.rgba[i] as number;
        assert.ok(
          Math.abs(actual - expected) <= 1,
          `pixel byte ${i}: expected ${expected}, got ${actual}`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

describe("fromBytes", () => {
  it("rejects wrong length", () => {
    assert.throws(() => ChromaHash.fromBytes(new Uint8Array(16)));
    assert.throws(() => ChromaHash.fromBytes(new Uint8Array(64)));
  });

  it("roundtrips with encode", () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 128;
      rgba[i + 1] = 64;
      rgba[i + 2] = 32;
      rgba[i + 3] = 255;
    }
    const ch1 = ChromaHash.encode(4, 4, rgba, "sRGB");
    const ch2 = ChromaHash.fromBytes(new Uint8Array(ch1.hash));
    assert.deepStrictEqual(ch1.hash, ch2.hash);
  });
});

describe("isVersionSupported", () => {
  it("reports a v2 hash as supported", () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(128);
    const ch = ChromaHash.encode(4, 4, rgba, "sRGB");
    assert.ok(ch.isVersionSupported());
  });

  it("reports a future wire generation as unsupported", () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(128);
    const bytes = new Uint8Array(ChromaHash.encode(4, 4, rgba, "sRGB").hash);
    // Byte 0 bits 0..3 are the version field; 2 is a generation this build
    // does not implement. fromBytes must refuse it outright rather than
    // decode garbage, which is the whole point of the descriptor byte.
    bytes[0] = ((bytes[0] ?? 0) & ~0b111) | 2;
    assert.throws(() => ChromaHash.fromBytes(bytes), /wire-format generation/);
    // And 0, generation v1 (chromahash 0.7.x), which this build no longer
    // decodes.
    bytes[0] = (bytes[0] ?? 0) & ~0b111;
    assert.throws(() => ChromaHash.fromBytes(bytes), /wire-format generation/);
  });

  it("defaults to the 32-byte tier and can address every other one", () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(128);
    assert.strictEqual(ChromaHash.encode(4, 4, rgba, "sRGB").hash.length, 32);
    assert.strictEqual(
      ChromaHash.encodeWithQuality(4, 4, rgba, "sRGB", DEFAULT_TIER).hash
        .length,
      32,
    );
    assert.strictEqual(
      ChromaHash.encodeWithQuality(4, 4, rgba, "sRGB", COMPACT_TIER).hash
        .length,
      21,
    );
    for (let tier = COMPACT_TIER; tier <= MAX_TIER; tier++) {
      const ch = ChromaHash.encodeWithQuality(4, 4, rgba, "sRGB", tier);
      assert.strictEqual(ch.tier, tier);
      // Round-trips through the self-describing length check.
      assert.deepStrictEqual(ChromaHash.fromBytes(ch.hash).hash, ch.hash);
    }
  });
});

// ---------------------------------------------------------------------------
// The pure-TypeScript decoder in header.ts / decode.ts is a deliberate second
// implementation — render-only consumers import it to skip the WASM init
// entirely — so it declares the wire constants itself rather than reading them
// from the module it exists to avoid. This is the tie that keeps the two
// honest: the format owns these codes, and the core exports them.
// ---------------------------------------------------------------------------

describe("malformed headers", () => {
  // The reserved bit is how v1 reserves room for a future extension: a decoder
  // that ignored it would accept a hash written by a later format and render
  // garbage.
  const cases: [string, (b0: number) => number][] = [
    ["reserved bit set", (b0) => b0 | 0b1000_0000],
    ["reserved tier code", (b0) => (b0 & ~0b0011_1000) | ((MAX_TIER + 1) << 3)],
    ["unsupported version", (b0) => b0 | 0b0000_0010],
  ];

  for (const [what, mutate] of cases) {
    it(`rejects a header with a ${what}`, () => {
      const rgba = new Uint8Array(4 * 4 * 4).fill(255);
      const bytes = ChromaHash.encode(4, 4, rgba, "sRGB").hash.slice();
      bytes[0] = mutate(bytes[0] ?? 0) & 0xff;
      assert.throws(() => ChromaHash.fromBytes(bytes));
    });
  }

  // The raster is a function of the tier, so assert the values rather than a
  // range wide enough to pass at every one of them.
  it("decodes each tier at its own raster", () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(255);
    const edges = [32, 32, 64, 128, 256];
    for (let tier = COMPACT_TIER; tier <= MAX_TIER; tier++) {
      const {
        w,
        h,
        rgba: pixels,
      } = ChromaHash.encodeWithQuality(4, 4, rgba, "sRGB", tier).decode();
      assert.strictEqual(w, edges[tier], `tier ${tier} width`);
      assert.strictEqual(h, edges[tier], `tier ${tier} height`);
      assert.strictEqual(pixels.length, w * h * 4);
    }
  });
});

describe("wire constants", () => {
  it("agree between the pure-TS decoder and the WASM core", () => {
    assert.strictEqual(COMPACT_TIER, wasmCompactTier());
    assert.strictEqual(DEFAULT_TIER, wasmDefaultTier());
    assert.strictEqual(MAX_TIER, wasmMaxTier());
    assert.strictEqual(FORMAT_VERSION, wasmFormatVersion());
  });

  it("order the tier codes by quality", () => {
    assert.ok(COMPACT_TIER < DEFAULT_TIER);
    assert.ok(DEFAULT_TIER < MAX_TIER);
  });
});
