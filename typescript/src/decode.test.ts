import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type OutputGamut,
  averageColor,
  decode,
  decodeCapped,
  decodeTo,
  isVersionSupported,
} from "./decode.ts";
import {
  COMPACT_TIER,
  DEFAULT_TIER,
  FORMAT_VERSION,
  bodyLenBytes,
} from "./header.ts";
import { ChromaHash, init } from "./index.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(currentDir, "../../spec/test-vectors");
const wasmPath = resolve(currentDir, "../wasm/chromahash_wasm_bg.wasm");

// The sync guard compares this pure-TS path against the WASM build.
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

// ---------------------------------------------------------------------------
// Spec vectors — the pure-TS decoder must reproduce the reference output
// ---------------------------------------------------------------------------

interface DecodeVector {
  name: string;
  input: { hash: number[] };
  expected: { width: number; height: number; rgba: number[] };
}

describe("pure-TS decode (spec vectors)", () => {
  const vectors = loadVectors<DecodeVector[]>("integration-decode.json");

  for (const vec of vectors) {
    it(`decode ${vec.name}`, () => {
      const out = decode(new Uint8Array(vec.input.hash));
      assert.equal(out.w, vec.expected.width, "width mismatch");
      assert.equal(out.h, vec.expected.height, "height mismatch");
      assert.equal(
        out.rgba.length,
        vec.expected.rgba.length,
        "length mismatch",
      );
      for (let i = 0; i < vec.expected.rgba.length; i++) {
        const actual = out.rgba[i] as number;
        const expected = vec.expected.rgba[i] as number;
        assert.ok(
          Math.abs(actual - expected) <= 1,
          `pixel byte ${i}: expected ${expected}, got ${actual}`,
        );
      }
    });
  }
});

interface DecodeCappedVector {
  name: string;
  input: { hash: number[]; max_width: number; max_height: number };
  expected: { width: number; height: number; rgba: number[] };
}

describe("pure-TS decodeCapped (spec vectors)", () => {
  const vectors = loadVectors<DecodeCappedVector[]>(
    "integration-decode-capped.json",
  );

  for (const vec of vectors) {
    it(`decode capped ${vec.name}`, () => {
      const out = decodeCapped(
        new Uint8Array(vec.input.hash),
        vec.input.max_width,
        vec.input.max_height,
      );
      assert.equal(out.w, vec.expected.width, "width mismatch");
      assert.equal(out.h, vec.expected.height, "height mismatch");
      assert.equal(
        out.rgba.length,
        vec.expected.rgba.length,
        "length mismatch",
      );
      for (let i = 0; i < vec.expected.rgba.length; i++) {
        const actual = out.rgba[i] as number;
        const expected = vec.expected.rgba[i] as number;
        assert.ok(
          Math.abs(actual - expected) <= 1,
          `pixel byte ${i}: expected ${expected}, got ${actual}`,
        );
      }
    });
  }
});

interface EncodeVector {
  name: string;
  input: { hash?: number[] };
  expected: { hash: number[]; average_color: [number, number, number, number] };
}

describe("pure-TS averageColor (spec vectors)", () => {
  const vectors = loadVectors<EncodeVector[]>("integration-encode.json");

  // Every vector, not a prefix. This was `.slice(0, 64)` with no explanation,
  // which silently stopped covering the tail the moment the corpus grew past 64
  // — it is at 58 and rising.
  for (const vec of vectors) {
    it(`average color ${vec.name}`, () => {
      const avg = averageColor(new Uint8Array(vec.expected.hash));
      assert.equal(avg.r, vec.expected.average_color[0], "R mismatch");
      assert.equal(avg.g, vec.expected.average_color[1], "G mismatch");
      assert.equal(avg.b, vec.expected.average_color[2], "B mismatch");
      assert.equal(avg.a, vec.expected.average_color[3], "A mismatch");
    });
  }
});

// ---------------------------------------------------------------------------
// Sync guard — the pure-TS path must be BIT-IDENTICAL to the WASM (Rust) build.
// This is what keeps the hand-maintained decoder honest when the spec changes.
// ---------------------------------------------------------------------------

function assertExactDecode(hash: Uint8Array, label: string): void {
  const pure = decode(hash);
  const wasm = ChromaHash.fromBytes(hash).decode();
  assert.equal(pure.w, wasm.w, `${label}: width`);
  assert.equal(pure.h, wasm.h, `${label}: height`);
  assert.equal(pure.rgba.length, wasm.rgba.length, `${label}: length`);
  for (let i = 0; i < wasm.rgba.length; i++) {
    assert.equal(
      pure.rgba[i],
      wasm.rgba[i],
      `${label}: pixel byte ${i} (pure=${pure.rgba[i]}, wasm=${wasm.rgba[i]})`,
    );
  }
}

describe("pure-TS decode matches WASM exactly (sync guard)", () => {
  it("agrees on every spec decode vector", () => {
    const vectors = loadVectors<DecodeVector[]>("integration-decode.json");
    for (const vec of vectors) {
      assertExactDecode(new Uint8Array(vec.input.hash), vec.name);
    }
  });

  it("agrees on every encoded spec hash", () => {
    const vectors = loadVectors<EncodeVector[]>("integration-encode.json");
    for (const vec of vectors) {
      assertExactDecode(new Uint8Array(vec.expected.hash), vec.name);
    }
  });

  it("agrees on a deterministic fuzz corpus of random hashes", () => {
    // Seeded LCG so a failure is reproducible. v1 hashes are self-describing,
    // so a random body is only decodable once byte 0 is a well-formed
    // descriptor and the buffer is exactly the length it implies — which is
    // what makes fuzzing the *body* meaningful rather than fuzzing validation.
    let state = 0x12345678 >>> 0;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    // Every shipped tier. This covered only [COMPACT_TIER, DEFAULT_TIER, 2], so
    // the pure-TS decoder — the one genuine second implementation of the
    // algorithm — had never been cross-checked against WebAssembly above tier 2.
    //
    // Case counts fall steeply with tier because cost rises ~16x per level: a
    // tier-4 case renders 256x256 through *both* implementations. Measured on
    // this suite, an even 5-way split over 256 cases cost 53 s, and this plan
    // costs about a quarter of that — on a suite that runs in the pre-push gate.
    //
    // The cheap tiers keep broad randomized coverage. The expensive ones are
    // here to reach the code path at all: what a high tier can break that a low
    // one cannot is the bit offsets of a 1623-byte payload and the shifted
    // render raster, and a handful of cases pins both. Volume adds little.
    const fuzzPlan: ReadonlyArray<readonly [number, number]> = [
      [COMPACT_TIER, 90],
      [DEFAULT_TIER, 90],
      [2, 48],
      [3, 8],
      [4, 4],
    ];
    let n = 0;
    for (const [tier, count] of fuzzPlan) {
      for (let i = 0; i < count; i++, n++) {
        const hasAlpha = (n & 1) === 1;
        const len = bodyLenBytes(tier, hasAlpha);
        const hash = new Uint8Array(len);
        for (let j = 0; j < len; j++) hash[j] = next() & 0xff;
        // This build's version, the chosen tier, the chosen alpha flag,
        // reserved bit clear.
        hash[0] = FORMAT_VERSION | (tier << 3) | (hasAlpha ? 1 << 6 : 0);
        assertExactDecode(hash, `fuzz#${n} (tier ${tier}, alpha ${hasAlpha})`);
      }
    }
  });

  it("agrees on every output gamut over the spec hashes", () => {
    // The pure-TS multi-gamut decode (decodeTo) must match WASM decodeTo for
    // each display-output gamut, not just the sRGB default.
    const gamuts: OutputGamut[] = ["sRGB", "Display P3", "Adobe RGB"];
    const vectors = loadVectors<EncodeVector[]>("integration-encode.json");
    for (const vec of vectors) {
      const hash = new Uint8Array(vec.expected.hash);
      for (const g of gamuts) {
        const pure = decodeTo(hash, g);
        const wasm = ChromaHash.fromBytes(hash).decodeTo(g);
        assert.equal(
          pure.rgba.length,
          wasm.rgba.length,
          `${vec.name}/${g}: length`,
        );
        for (let i = 0; i < wasm.rgba.length; i++) {
          assert.equal(
            pure.rgba[i],
            wasm.rgba[i],
            `${vec.name}/${g}: byte ${i} (pure=${pure.rgba[i]}, wasm=${wasm.rgba[i]})`,
          );
        }
      }
    }
  });
});

describe("pure-TS isVersionSupported", () => {
  it("reads the wire generation from the descriptor byte", () => {
    // Byte 0 bits 0..3 are the version field. v2 is 1; v1 (0.7.x) was 0.
    const v2 = new Uint8Array(32);
    v2[0] = (DEFAULT_TIER << 3) | FORMAT_VERSION;
    assert.ok(isVersionSupported(v2));

    for (let generation = 0; generation <= 7; generation++) {
      if (generation === FORMAT_VERSION) continue;
      const other = new Uint8Array(32);
      other[0] = (DEFAULT_TIER << 3) | generation;
      assert.ok(
        !isVersionSupported(other),
        `generation ${generation} must not report as supported`,
      );
    }
  });

  it("rejects rather than mis-decoding an unsupported generation", () => {
    for (const generation of [0, FORMAT_VERSION + 1]) {
      const other = new Uint8Array(32);
      other[0] = (DEFAULT_TIER << 3) | generation;
      assert.throws(() => decode(other), /wire-format generation/);
    }
  });

  it("rejects a length that disagrees with the descriptor", () => {
    // A compact-tier descriptor on a 32-byte buffer: the renumbering's own
    // hazard, and exactly what the self-describing length check exists for.
    const mismatched = new Uint8Array(32);
    mismatched[0] = (COMPACT_TIER << 3) | FORMAT_VERSION;
    assert.throws(() => decode(mismatched), /disagrees with its descriptor/);
  });
});
