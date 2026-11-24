/**
 * The per-binding FFI overhead table (`results/counts/overhead.md`), rendered
 * from the committed `benchmark:counts` records it quotes, so the table cannot
 * drift from them: `verify:claims` re-renders it from the records and fails on
 * any difference. Pure: the records are passed in.
 *
 * Each overhead record pairs one binding layer's driver (arm A,
 * `bindings/<layer>/examples/overhead_<layer>.rs`) with the Rust core's
 * (arm B, `overhead_core.rs`, built in the same crate and profile) on one
 * cell, so A − B is what the layer adds per operation. Each reduction record
 * pairs the layer's driver after a reduction (A) with the same driver built
 * before it (B). `mise run benchmark:overhead` writes the overhead records.
 */

import type { CountsRecord } from "./counts-core.ts";

export const OVERHEAD_TABLE = "tools/comparison/results/counts/overhead.md";

/** The default tier's hash length: every cell here encodes at tier 1. */
const TIER1_BYTES = 32;

export interface OverheadLayer {
  layer: "c" | "uniffi";
  name: string;
  serves: string;
}

export const OVERHEAD_LAYERS: readonly OverheadLayer[] = [
  { layer: "c", name: "C ABI", serves: "C, C# (P/Invoke), Go (cgo)" },
  {
    layer: "uniffi",
    name: "UniFFI scaffolding",
    serves: "Kotlin/JVM, Android, Python; Swift (not counted)",
  },
];

export interface OverheadCell {
  cell: string;
  label: string;
  op: "encode" | "decode";
  size: number;
  /** Images per batch; `null` for a single-image operation. */
  batch: number | null;
}

export const OVERHEAD_CELLS: readonly OverheadCell[] = [
  {
    cell: "encode-64",
    label: "encode 64×64",
    op: "encode",
    size: 64,
    batch: null,
  },
  {
    cell: "encode-512",
    label: "encode 512×512",
    op: "encode",
    size: 512,
    batch: null,
  },
  {
    cell: "decode-64",
    label: "decode (64×64's hash)",
    op: "decode",
    size: 64,
    batch: null,
  },
  {
    cell: "batch16-64",
    label: "batch of 16 × 64×64",
    op: "encode",
    size: 64,
    batch: 16,
  },
];

/** A byte-identical reduction and the paired records that show its decrease. */
export interface OverheadReduction {
  id: string;
  layer: OverheadLayer["layer"];
  what: string;
  /** The commit the B arm (the driver before the reduction) was built at. */
  beforeRev: string;
  beforeBin: string;
}

export const OVERHEAD_REDUCTIONS: readonly OverheadReduction[] = [
  {
    id: "uniffi-bytes",
    layer: "uniffi",
    what: "UniFFI byte arrays lifted and lowered in one slice copy instead of one push per byte (`bindings/uniffi/src/bytes.rs`); `ImageInput.rgba` lifted straight into the core's `Arc<[u8]>`",
    beforeRev: "c4b3f9e",
    beforeBin: "bindings/uniffi/target/before/overhead_uniffi",
  },
];

export const overheadRecord = (layer: string, cell: OverheadCell): string =>
  `overhead-${layer}-${cell.cell}.json`;

export const reductionRecord = (
  r: OverheadReduction,
  cell: OverheadCell,
): string => `reduce-${r.id}-${cell.cell}.json`;

const driver = (layer: string, bin: string) =>
  `bindings/${layer}/target/release/examples/${bin}`;

/**
 * Why `record` cannot be quoted as `cell` with arms `a` and `b`, or `null`.
 * Holds the record to its cell, its arms, a clean tree, equal outputs and,
 * from the encode output's length, its batch size.
 */
export function recordProblem(
  record: CountsRecord,
  cell: OverheadCell,
  a: string,
  b: string,
): string | null {
  const c = record.cell;
  if (
    c.impl !== "Rust" ||
    c.op !== cell.op ||
    c.width !== cell.size ||
    c.height !== cell.size ||
    c.tier !== 1 ||
    c.content !== "gradient"
  ) {
    return `its cell is ${c.impl} ${c.op} ${c.width}x${c.height} t${c.tier} ${c.content}, not ${cell.op} ${cell.size}x${cell.size} t1 gradient`;
  }
  if (record.arms.a.bin !== a || record.arms.b.bin !== b) {
    return `its arms are ${record.arms.a.bin} / ${record.arms.b.bin}, not ${a} / ${b}`;
  }
  if (record.arms.a.tune !== "" || record.arms.b.tune !== "") {
    return "an arm ran under a tune";
  }
  if (record.provenance.dirty !== false) {
    return "it was counted on a dirty or unknown tree";
  }
  if (!record.outputs.equal) return "its arms' outputs differ";
  if (cell.op === "encode") {
    const bytes = record.outputs.a.length / 2;
    const want = (cell.batch ?? 1) * TIER1_BYTES;
    if (bytes !== want) {
      return `its encode wrote ${bytes} bytes, not ${want} (${cell.batch ?? 1} tier-1 hash(es))`;
    }
  }
  return null;
}

const INS = "instructions:u";
/** An arm's median count, floored to the whole instructions printed. */
const floored = (s: CountsRecord["summary"]["a"]) => Math.floor(s.median[INS]);
const whole = (n: number) => n.toLocaleString("en-US");
/** A − B of the printed counts, so the column is the difference a reader computes. */
const diff = (r: CountsRecord) => floored(r.summary.a) - floored(r.summary.b);
const signed = (n: number) =>
  `${n < 0 ? "−" : "+"}${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

function unit(cell: OverheadCell): string {
  return cell.batch === null ? `per ${cell.op}` : "per batch";
}

/**
 * Render the overhead table from the records `read` returns, by file name
 * under `results/counts/ab/`. Throws, naming the record, on any record that
 * does not hold its row.
 */
export function renderOverheadTable(
  read: (record: string) => CountsRecord,
): string {
  const revs = new Set<string>();
  const cpus = new Set<string>();
  const take = (
    name: string,
    cell: OverheadCell,
    a: string,
    b: string,
  ): CountsRecord => {
    const r = read(name);
    const problem = recordProblem(r, cell, a, b);
    if (problem !== null) throw new Error(`${name}: ${problem}`);
    revs.add(r.provenance.rev ?? "unknown");
    cpus.add(r.host.cpu.modelName);
    return r;
  };

  const lines: string[] = [];
  lines.push(
    "# Per-binding FFI overhead",
    "",
    "<!-- Generated by `node tools/comparison/dist/perf/overhead-table.js` from the records under `results/counts/ab/`; `mise run verify:claims` fails if it drifts from them. Do not edit by hand. -->",
    "",
    "What each binding layer adds to an operation over the Rust core, as retired user-space instructions (`instructions:u`) per operation: the median over the record's interleaved A B / B A blocks of `mise run benchmark:counts`. Arm A is the layer's driver and arm B the core's, built in the same crate and profile from `bindings/overhead/protocol.rs`; both arms' outputs are byte-identical in every record. Every cell is tier 1 on the perf matrix's gradient fixture; a batch is 16 copies through a one-worker batch encoder. No wall-clock figure is recorded or claimed. Reproduce with `mise run benchmark:overhead`.",
    "",
    "| Layer | Serves | Cell | Layer (A) | Core (B) | Overhead | A/B | Record |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
  );
  for (const l of OVERHEAD_LAYERS) {
    for (const cell of OVERHEAD_CELLS) {
      const name = overheadRecord(l.layer, cell);
      const r = take(
        name,
        cell,
        driver(l.layer, `overhead_${l.layer}`),
        driver(l.layer, "overhead_core"),
      );
      const s = r.summary;
      const extra = diff(r);
      const perItem =
        cell.batch === null ? "" : ` (${signed(extra / cell.batch)} per image)`;
      lines.push(
        `| ${l.name} | ${l.serves} | ${cell.label} | ${whole(floored(s.a))} | ${whole(floored(s.b))} | ${signed(extra)} ${unit(cell)}${perItem} | ${s.ratio.geomean[INS].toFixed(4)} | \`${name}\` |`,
      );
    }
  }

  lines.push(
    "",
    "## Every binding",
    "",
    "| Binding | Native layer | Counted here | Not counted |",
    "| --- | --- | --- | --- |",
    "| C | C ABI | the whole call | — |",
    "| C# | C ABI | the native side of every call | the P/Invoke marshalling and the .NET runtime: `benchmark:counts` refuses a JIT and a collector |",
    "| Go | C ABI | the native side of every call | the cgo transition and the Go runtime: `benchmark:counts` refuses Go's concurrent collector |",
    "| Kotlin/JVM, Android | UniFFI scaffolding | the native side of every call, with the host's buffer writes and reads emulated at their minimum | JNA and the JVM: `benchmark:counts` refuses a JIT and a collector |",
    "| Python | UniFFI scaffolding | as Kotlin | ctypes and CPython: `benchmark:counts` refuses a managed runtime |",
    "| TypeScript (wasm) | wasm-bindgen | not measured | the whole call: it runs in a JIT engine, and a native count of the wasm crate would measure neither the JS glue nor the engine |",
    "| Swift | UniFFI scaffolding | not measured | Swift builds on macOS only (`ci-swift.yml`); its native layer is the UniFFI row above |",
    "",
    "## Reductions",
    "",
    "Each reduction is byte-identical (both arms' outputs are equal in every record) and is shown by a paired count of the layer's driver after it (A) against the same driver built before it (B), each cell counted with `benchmark:overhead`'s options and `--b-bin` naming the earlier build.",
  );
  for (const red of OVERHEAD_REDUCTIONS) {
    lines.push(
      "",
      `### \`${red.id}\` (${red.layer})`,
      "",
      `${red.what}. B is \`${red.beforeBin}\`, built at \`${red.beforeRev}\`.`,
      "",
      "| Cell | After (A) | Before (B) | Change | A/B | Record |",
      "| --- | ---: | ---: | ---: | ---: | --- |",
    );
    for (const cell of OVERHEAD_CELLS) {
      const name = reductionRecord(red, cell);
      const r = take(
        name,
        cell,
        driver(red.layer, `overhead_${red.layer}`),
        red.beforeBin,
      );
      const s = r.summary;
      lines.push(
        `| ${cell.label} | ${whole(floored(s.a))} | ${whole(floored(s.b))} | ${signed(diff(r))} ${unit(cell)} | ${s.ratio.geomean[INS].toFixed(4)} | \`${name}\` |`,
      );
    }
  }

  lines.push(
    "",
    `Counted at ${[...revs].sort().join(", ")} on ${[...cpus].sort().join(", ")}; each record holds its binaries' SHA-256, the host, the counter and every block.`,
    "",
  );
  return lines.join("\n");
}
