# chromahash-wasm

The **WebAssembly** binding for ChromaHash: a thin [`wasm-bindgen`](https://rustwasm.github.io/wasm-bindgen/)
wrapper over the zero-dependency [`chromahash`](../../rust) core, built with
`wasm-pack`. This is the full encode + decode path for the TypeScript web package;
output is byte-identical to every other ChromaHash implementation.

## Build

```sh
mise run build:wasm   # → bindings/wasm/pkg (web) and bindings/wasm/pkg-node (nodejs)
mise run test:wasm    # spec-vector parity gate, compiled to wasm and run in Node
```

Both outputs are gitignored build artifacts. The TypeScript package (`typescript/`)
consumes them.

## API (generated TypeScript)

```ts
import init, { ChromaHash, Gamut } from "chromahash-wasm";

await init();                                  // load + instantiate the .wasm
const hash = ChromaHash.encode(w, h, rgba, Gamut.Srgb);  // rgba: Uint8Array
const bytes = hash.asBytes();                  // Uint8Array(32) at the default tier

const back = ChromaHash.fromBytes(bytes);      // throws unless the length matches the header
const { width, height, rgba: pixels } = back.decode();
```

Batch encoding is **not** exposed here — WebAssembly can't use the core's worker
pool without `SharedArrayBuffer` + COOP/COEP, so the TypeScript layer implements
`encodeBatch` by looping this single-image `encode`.
