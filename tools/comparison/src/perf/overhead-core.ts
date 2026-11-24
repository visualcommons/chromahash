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
 * before it (B). Each host record pairs a host runtime's own CLI driver,
 * through its published binding and under its counting configuration
 * (`counts-core.ts` `COUNTING_CONFIGS`), with the core driver of the native
 * layer it binds (`--b-impl Rust`); a host whose records do not hold every
 * block within `HOST_SPREAD` of its arm's median is listed as not countable,
 * with its spread, instead of in rows. `mise run benchmark:overhead` writes
 * the overhead and host records.
 */

import {
  COUNTING_CONFIGS,
  type CountsRecord,
  HOST_SPREAD,
  blockSpread,
  configTokens,
} from "./counts-core.ts";

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
  layer: OverheadLayer["layer"] | "wasm";
  what: string;
  /** The implementation both arms run (`--impl`). */
  impl: string;
  /** The driver after the reduction (arm A). */
  afterBin: string;
  /** The commit the B arm (the driver before the reduction) was built at. */
  beforeRev: string;
  beforeBin: string;
  /** The cells the reduction is counted on: those whose path it changes. */
  cells: readonly OverheadCell["cell"][];
}

export const OVERHEAD_REDUCTIONS: readonly OverheadReduction[] = [
  {
    id: "uniffi-bytes",
    layer: "uniffi",
    what: "UniFFI byte arrays lifted and lowered in one slice copy instead of one push per byte (`bindings/uniffi/src/bytes.rs`); `ImageInput.rgba` lifted straight into the core's `Arc<[u8]>`",
    impl: "Rust",
    afterBin: "bindings/uniffi/target/release/examples/overhead_uniffi",
    beforeRev: "c4b3f9e",
    beforeBin: "bindings/uniffi/target/before/overhead_uniffi",
    cells: ["encode-64", "encode-512", "decode-64", "batch16-64"],
  },
  {
    id: "wasm-rgba-copy",
    layer: "wasm",
    what: "`DecodeResult::rgba` returns a `Uint8Array` built from the decoded slice (`bindings/wasm/src/lib.rs`), so the pixels cross to JS in one copy instead of a clone in the wasm heap, wasm-bindgen's copy of the clone and its free. Counted through the TypeScript package's CLI under Node's counting configuration (Host runtimes), on the decode cell, the only one whose path it changes",
    impl: "TypeScript (wasm)",
    afterBin: "typescript/dist/encode-stdin.js",
    beforeRev: "4fd0571",
    beforeBin: "bindings/wasm/target/before/typescript/dist/encode-stdin.js",
    cells: ["decode-64"],
  },
  {
    id: "uniffi-py-bytes",
    layer: "uniffi",
    what: "The Python bindings write a byte array into the RustBuffer in one `ctypes.memmove` instead of one Python loop iteration per byte, by a step `mise run cbuild:python` applies to uniffi-bindgen's output (`mise-tasks/cbuild/python`), so lowering `ImageInput.rgba` no longer runs w × h × 4 iterations per encode. Counted through the Python package's CLI under CPython's counting configuration (Host runtimes), on the encode cells, the ones whose input it writes; each arm is a package directory, run from its parent",
    impl: "Python",
    afterBin: "python/chromahash",
    beforeRev: "32ffc24",
    beforeBin: "bindings/uniffi/target/before/python/chromahash",
    cells: ["encode-64", "encode-512"],
  },
];

/** A host runtime counted through its own binding, and the layer it binds. */
export interface OverheadHost {
  impl: string;
  slug: string;
  /** The native layer whose core driver is arm B; null for the wasm package. */
  layer: OverheadLayer["layer"] | null;
  /** What the host adds on its side of the native layer. */
  via: string;
}

export const OVERHEAD_HOSTS: readonly OverheadHost[] = [
  { impl: "C#", slug: "csharp", layer: "c", via: "P/Invoke and .NET" },
  { impl: "Go", slug: "go", layer: "c", via: "cgo and the Go runtime" },
  { impl: "Kotlin", slug: "kotlin", layer: "uniffi", via: "JNA and the JVM" },
  {
    impl: "Python",
    slug: "python",
    layer: "uniffi",
    via: "ctypes and CPython",
  },
  {
    impl: "TypeScript (wasm)",
    slug: "ts-wasm",
    layer: null,
    via: "the wasm-bindgen glue, V8, and the core itself compiled to wasm",
  },
];

/** The cells a host is counted on: every single-image cell. */
export const HOST_CELLS: readonly OverheadCell[] = OVERHEAD_CELLS.filter(
  (c) => c.batch === null,
);

export const overheadRecord = (layer: string, cell: OverheadCell): string =>
  `overhead-${layer}-${cell.cell}.json`;

export const hostRecord = (h: OverheadHost, cell: OverheadCell): string =>
  `host-${h.slug}-${cell.cell}.json`;

/** The program a host's arm A runs, as its record names it. */
export function hostProgram(h: OverheadHost): string {
  const cfg = COUNTING_CONFIGS[h.impl];
  if (cfg === undefined)
    throw new Error(`${h.impl} has no counting configuration`);
  return cfg.program ?? (cfg.artifacts("")[0] as string);
}

/** The native core driver a host is counted against. */
export const hostCore = (h: OverheadHost): string =>
  driver(h.layer ?? "c", "overhead_core");

export const reductionRecord = (
  r: OverheadReduction,
  cell: OverheadCell,
): string => `reduce-${r.id}-${cell.cell}.json`;

const driver = (layer: string, bin: string) =>
  `bindings/${layer}/target/release/examples/${bin}`;

/**
 * Why `record` cannot be quoted as `cell` with arms `a` and `b`, or `null`.
 * Holds the record to its cell, its arms, a clean tree, equal outputs and,
 * from the encode output's length, its batch size. `impl` is arm A's
 * implementation (the cell's); `bImpl`, where given, is arm B's, which the
 * record must then name on each arm. An arm run under a counting
 * configuration must state the one `COUNTING_CONFIGS` holds for it now.
 */
export function recordProblem(
  record: CountsRecord,
  cell: OverheadCell,
  a: string,
  b: string,
  impl = "Rust",
  bImpl?: string,
): string | null {
  const c = record.cell;
  if (
    c.impl !== impl ||
    c.op !== cell.op ||
    c.width !== cell.size ||
    c.height !== cell.size ||
    c.tier !== 1 ||
    c.content !== "gradient"
  ) {
    return `its cell is ${c.impl} ${c.op} ${c.width}x${c.height} t${c.tier} ${c.content}, not ${impl} ${cell.op} ${cell.size}x${cell.size} t1 gradient`;
  }
  if (record.arms.a.bin !== a || record.arms.b.bin !== b) {
    return `its arms are ${record.arms.a.bin} / ${record.arms.b.bin}, not ${a} / ${b}`;
  }
  const impls = bImpl === undefined ? [] : [impl, bImpl];
  if (
    (record.arms.a.impl ?? null) !== (impls[0] ?? null) ||
    (record.arms.b.impl ?? null) !== (impls[1] ?? null)
  ) {
    return `its arms run ${record.arms.a.impl ?? c.impl} / ${record.arms.b.impl ?? c.impl}, not ${impl} / ${bImpl ?? impl}`;
  }
  for (const side of ["a", "b"] as const) {
    const name = record.arms[side].impl ?? c.impl;
    const cfg = COUNTING_CONFIGS[name];
    const want = cfg === undefined ? null : configTokens(cfg).join(" ");
    const got = record.arms[side].config?.join(" ") ?? null;
    if (got !== want) {
      return `its arm ${side.toUpperCase()} ran under ${got ?? "no counting configuration"}, not ${want ?? "none"}`;
    }
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
    impl = "Rust",
    bImpl?: string,
  ): CountsRecord => {
    const r = read(name);
    const problem = recordProblem(r, cell, a, b, impl, bImpl);
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
  /** Each layer's record per cell, which the host rows read its share from. */
  const layerRecords = new Map<string, CountsRecord>();
  for (const l of OVERHEAD_LAYERS) {
    for (const cell of OVERHEAD_CELLS) {
      const name = overheadRecord(l.layer, cell);
      const r = take(
        name,
        cell,
        driver(l.layer, `overhead_${l.layer}`),
        driver(l.layer, "overhead_core"),
      );
      layerRecords.set(`${l.layer} ${cell.cell}`, r);
      const s = r.summary;
      const extra = diff(r);
      const perItem =
        cell.batch === null ? "" : ` (${signed(extra / cell.batch)} per image)`;
      lines.push(
        `| ${l.name} | ${l.serves} | ${cell.label} | ${whole(floored(s.a))} | ${whole(floored(s.b))} | ${signed(extra)} ${unit(cell)}${perItem} | ${s.ratio.geomean[INS].toFixed(4)} | \`${name}\` |`,
      );
    }
  }

  // ─── Host runtimes ────────────────────────────────────────────────────────
  const hostRecords = OVERHEAD_HOSTS.map((h) => {
    const records = HOST_CELLS.map((cell) => {
      const name = hostRecord(h, cell);
      return {
        cell,
        name,
        r: take(name, cell, hostProgram(h), hostCore(h), h.impl, "Rust"),
      };
    });
    const spread = Math.max(
      ...records.flatMap(({ r }) => [
        blockSpread(r.summary.a),
        blockSpread(r.summary.b),
      ]),
    );
    return { h, records, spread, countable: spread <= HOST_SPREAD };
  });
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
  lines.push(
    "",
    "## Host runtimes",
    "",
    `What each host runtime adds to a call, counted through its published binding. Arm A is the host's own command-line driver (the cross-language benchmark's \`encode-stdin\`), run under the host's counting configuration (\`counts-core.ts\` \`COUNTING_CONFIGS\`); arm B is the core driver of the native layer the host binds, counted with \`--b-impl Rust\` on the same cell, and both arms decode to the same RGBA bytes or encode to the same hash in every record. A host is countable where, in every one of its records, each arm's per-operation count in each of the interleaved blocks is within ${pct(HOST_SPREAD)} of that arm's median; the check and its tolerance were fixed in issue #173 before any host was counted. The check tests that a record repeats, not that its per-operation figure is independent of the iteration count: work a process does once, part-way through the long process only (a JIT compile at its call threshold, say), is spread over the iterations, so each figure is its cell's at that record's iteration count (\`settings.iterations\`). Kotlin is counted in the JVM's interpreter for this reason; with C1 at its call threshold its decode counted about 12% more per call at 500 iterations than at 2,000. In the interpreter a smaller dependence remains, unexplained: arm A counts 0.5% more per decode at 500 iterations than at 2,000, 0.9% more per 64×64 encode at 200 than at 800, and 0.7% more per 512×512 encode at 20 than at 80, where the core (arm B) also moves by 0.1% and the host side falls by about 13%. A counting configuration is not how the host ships: it pins the runtime's compiler tier and its collector's pacing, so a host's figure is its cost under that configuration. "Native layer" is the overhead row above for the same cell, counted against the same core binary, and "Host side" is what is left: the host's call, its marshalling and its runtime, with its CLI's bench loop. The subtraction assumes the core does the same work in every process, and at 512×512 it does not: the encode's buffers pass glibc malloc's 128 KiB mmap threshold, which glibc raises once the first such buffer is freed, so a process can serve them from its heap, zeroing them in user space, or map fresh zeroed pages. Pinning the threshold (\`GLIBC_TUNABLES=glibc.malloc.mmap_threshold=65536\`) cut the 512×512 encode, at \`45498f8\` by the same 1 and 21 iteration subtraction, by 259,871 instructions in the core driver and by 287,020 in the UniFFI driver but by 6,329 in the Python CLI, and by 500 in the core driver's 64×64 encode; so a 512×512 host side is the host's cost less the allocator work the core driver's process does and the host's does not, and can understate it by about that much (Python's is +26,089 against about +301,000 with the threshold pinned). A host side can fall below zero where that saving exceeds the host's cost, and the table refuses such a row rather than print it as what the host adds. A count also belongs to its revision (the line at the end names each): issue #183 found the Python rows, then counted at \`84e3338\`, below the \`uniffi-py-bytes\` reduction's After arm, counted at \`baa863e\`, because PR #171's core changes landed between the two and cut arm B of \`host-python-encode-512.json\` from 109,849,404 to 106,955,006 instructions. Two records' figures compare only where they were counted on the same core binary. The TypeScript (wasm) arm runs the core itself as wasm in V8's baseline compiler, so its figure is the whole call against native code rather than the glue alone; the glue's share is not separable by this count.`,
    "",
    "| Host | Counting configuration | Largest block spread | Countable |",
    "| --- | --- | ---: | --- |",
  );
  for (const { h, spread, countable } of hostRecords) {
    const cfg = COUNTING_CONFIGS[h.impl];
    lines.push(
      `| ${h.impl} | ${
        cfg === undefined
          ? "—"
          : configTokens(cfg)
              .map((t) => `\`${t}\``)
              .join(" ")
      } | ${pct(spread)} | ${countable ? "yes" : `no: over ${pct(HOST_SPREAD)}`} |`,
    );
  }
  lines.push(
    "",
    "| Host | Via | Cell | Host (A) | Core (B) | Over the core | Native layer | Host side | A/B | Record |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const { h, records, countable } of hostRecords) {
    if (!countable) continue;
    for (const { cell, name, r } of records) {
      const s = r.summary;
      const over = diff(r);
      let layer = "—";
      let side = "—";
      // What is left once the native layer is subtracted: the host side, or
      // the whole call over the core where no layer is separable.
      let rest = over;
      if (h.layer !== null) {
        const lr = layerRecords.get(`${h.layer} ${cell.cell}`);
        if (lr === undefined || lr.arms.b.binSha256 !== r.arms.b.binSha256) {
          throw new Error(
            `${name}: its core binary is not the one ${overheadRecord(h.layer, cell)} counts the native layer against, so the layer's share cannot be subtracted`,
          );
        }
        rest = over - diff(lr);
        layer = signed(diff(lr));
        side = signed(rest);
      }
      // Arm A runs the core arm B runs, plus the layer and the host, so a
      // remainder below zero is not what the host adds: the core did less
      // work in the host's process (its allocator, at 512×512), or the arms
      // ran different core code. Refused rather than printed.
      if (rest < 0) {
        throw new Error(
          `${name}: the host counts ${signed(rest)} ${unit(cell)} beyond the core${h.layer === null ? "" : " and its native layer"}, so the subtraction does not isolate the host: the core did less work in the host's process, or the arms ran different core code`,
        );
      }
      lines.push(
        `| ${h.impl} | ${h.via} | ${cell.label} | ${whole(floored(s.a))} | ${whole(floored(s.b))} | ${signed(over)} ${unit(cell)} | ${layer} | ${side} | ${s.ratio.geomean[INS].toFixed(4)} | \`${name}\` |`,
      );
    }
  }

  const host = (impl: string) => {
    const found = hostRecords.find((x) => x.h.impl === impl);
    if (found === undefined) throw new Error(`no host ${impl}`);
    return found;
  };
  const counted = (impl: string, side: string) =>
    host(impl).countable
      ? "the whole call, under its counting configuration (Host runtimes)"
      : side;
  const missed = (impl: string, shipped: string, refused: string) =>
    host(impl).countable
      ? `${shipped} as it ships: its count is under the counting configuration`
      : `${refused}: under its counting configuration its blocks spread ${pct(host(impl).spread)}, over ${pct(HOST_SPREAD)}`;
  lines.push(
    "",
    "## Every binding",
    "",
    "| Binding | Native layer | Counted here | Not counted |",
    "| --- | --- | --- | --- |",
    "| C | C ABI | the whole call | — |",
    `| C# | C ABI | ${counted("C#", "the native side of every call")} | ${missed("C#", "the .NET runtime (tiered JIT, concurrent collector)", "the P/Invoke marshalling and the .NET runtime")} |`,
    `| Go | C ABI | ${counted("Go", "the native side of every call")} | ${missed("Go", "the Go runtime (its concurrent collector, every processor)", "the cgo transition and the Go runtime")} |`,
    `| Kotlin/JVM | UniFFI scaffolding | ${counted("Kotlin", "the native side of every call, with the host's buffer writes and reads emulated at their minimum")} | ${missed("Kotlin", "the JVM (tiered C1/C2 compilation in the background, its default collector)", "JNA and the JVM")} |`,
    "| Android | UniFFI scaffolding | the native side of every call, as Kotlin/JVM | JNA and ART: they run on a device, not on the counting host |",
    `| Python | UniFFI scaffolding | ${counted("Python", "as Kotlin/JVM")} | ${missed("Python", "CPython started through `uv run`, with a random hash seed", "ctypes and CPython")} |`,
    `| TypeScript (wasm) | wasm-bindgen | ${counted("TypeScript (wasm)", "not measured")} | ${missed("TypeScript (wasm)", "V8 with its optimizing tiers (Maglev, TurboFan) and background threads, which is where the wasm core runs", "the whole call")} |`,
    "| Swift | UniFFI scaffolding | not measured | Swift builds on macOS only (`ci-swift.yml`); its native layer is the UniFFI row above |",
    "",
    "## Reductions",
    "",
    "Each reduction is byte-identical (both arms' outputs are equal in every record) and is shown by a paired count of the layer's driver after it (A) against the same driver built before it (B), each cell counted with `benchmark:overhead`'s options, `--impl` naming the driver's implementation and `--b-bin` naming the earlier build; every block of every record counts fewer instructions after it.",
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
    for (const cell of OVERHEAD_CELLS.filter((c) =>
      red.cells.includes(c.cell),
    )) {
      const name = reductionRecord(red, cell);
      const r = take(name, cell, red.afterBin, red.beforeBin, red.impl);
      if (!(r.summary.ratio.max[INS] < 1)) {
        throw new Error(
          `${name}: a reduction must count fewer instructions in every block, but its largest block ratio is ${r.summary.ratio.max[INS]}`,
        );
      }
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
