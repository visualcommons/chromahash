/**
 * What a sweep measures, decided before anything is spawned.
 *
 * Split out of `run.ts` for the reason `availability.ts` was: that file runs
 * the whole sweep at module scope, so nothing in it can be asserted without
 * starting a benchmark. The plan is where the rules this gate depends on live —
 * which ids a `--full` run may hold, which cells are the same work under two
 * names, which pairs a speedup is read from, and in what order processes are
 * interleaved — so it is pure, and `metric-selftest.ts` checks it.
 *
 * Three things changed when it was split out, each a fix to a defect in the
 * single-pass driver it replaces:
 *
 *  - **`--full` is a supplement.** It measures only ids the bounded matrix does
 *    not, so committing it fills the cells only it can produce and re-baselines
 *    nothing else. It used to re-measure every bounded id too, and the gate
 *    preferred its value, so filling six cells rewrote 216.
 *  - **A `shipped` arm is an alias, not a cell.** `…/gradient/shipped` is the
 *    same encode as `…/gradient`, and `decode/Rust/t1/natural/shipped` the same
 *    decode as `decode/Rust/t1/natural`. They were measured twice, published
 *    from different cells in different sections, and never compared.
 *  - **Cells come in units.** A lever and the arm it is divided into, a SIMD
 *    build and its scalar twin, a natural decode and its capped one: each unit's
 *    processes run back to back, so a ratio is taken between processes seconds
 *    apart rather than minutes.
 */

import {
  ALL_TIERS,
  BOUNDED_CROSS_TIERS,
  BOUNDED_SIZES,
  BOUNDED_THREADS,
  type Content,
  DECODE_ACCEL_ARMS,
  FULL_SIZES,
  FULL_THREADS,
  TIER4_ACCEL_ARMS,
  TIER_BYTES,
  TUNE_ARMS,
} from "./matrix.ts";

export type Mode = "bounded" | "full" | "quick";
export type Op = "encode" | "decode" | "batch";

/** What the planner needs to know about a target. */
export interface TargetCaps {
  readonly name: string;
  readonly ops: readonly Op[];
  readonly threadable: boolean;
}

/** What a cell's harness reads on stdin, produced lazily by the runner. */
export type Input =
  | {
      readonly kind: "pixels";
      readonly w: number;
      readonly h: number;
      readonly content: Content;
    }
  | {
      readonly kind: "hash";
      readonly tier: number;
      readonly w: number;
      readonly h: number;
      readonly content: Content;
    };

export interface PlannedCell {
  readonly id: string;
  readonly op: Op;
  readonly target: string;
  readonly tier: number;
  readonly source: { w: number; h: number; content: Content } | null;
  readonly tune: string | null;
  readonly decodeCap: [number, number] | null;
  readonly threads: number | null;
  readonly bytes: number | null;
  /** `@ITERS@` is replaced with the calibrated iteration count. */
  readonly argv: readonly string[];
  readonly input: Input;
  /** Extra environment, beyond `CHROMAHASH_TIER`. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A ratio the run records directly: `base` time over `arm` time, taken process
 * by process. A lever's speedup, the `simd` feature's gain (base = the scalar
 * build), a capped decode's saving (base = natural), a batch's thread scaling
 * (base = one thread).
 */
export interface PlannedPair {
  readonly base: string;
  readonly arm: string;
}

export interface Plan {
  readonly mode: Mode;
  /** In plan order. */
  readonly cells: readonly PlannedCell[];
  /** Each cell id's unit: cells sharing one run back to back in every round. */
  readonly unitOf: ReadonlyMap<string, string>;
  readonly pairs: readonly PlannedPair[];
  /** A name that is another cell's measurement: alias id -> measured id. */
  readonly aliases: Readonly<Record<string, string>>;
}

/** The label a lever arm table gives the unmodified encoder. */
export const SHIPPED = "shipped";

/** The arm id the driver has always recorded a lever under. */
export const leverId = (base: string, label: string): string =>
  `${base}/${label}`;

class Builder {
  private readonly cells = new Map<string, PlannedCell>();
  private readonly order: string[] = [];
  /** Union-find over units; the representative is the earliest member. */
  private readonly parent = new Map<string, string>();
  readonly pairs: PlannedPair[] = [];
  readonly aliases: Record<string, string> = {};

  add(cell: PlannedCell): string {
    if (!this.cells.has(cell.id)) {
      this.cells.set(cell.id, cell);
      this.order.push(cell.id);
      this.parent.set(cell.id, cell.id);
    }
    return cell.id;
  }

  private root(id: string): string {
    let r = id;
    for (let p = this.parent.get(r); p !== undefined && p !== r; ) {
      r = p;
      p = this.parent.get(r);
    }
    return r;
  }

  /** Put two planned cells in one unit. */
  join(a: string, b: string): void {
    if (!this.cells.has(a) || !this.cells.has(b)) return;
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra === rb) return;
    const first =
      this.order.indexOf(ra) <= this.order.indexOf(rb) ? [ra, rb] : [rb, ra];
    this.parent.set(first[1] as string, first[0] as string);
  }

  pair(base: string, arm: string): void {
    if (!this.cells.has(base) || !this.cells.has(arm)) return;
    this.join(base, arm);
    if (!this.pairs.some((p) => p.base === base && p.arm === arm)) {
      this.pairs.push({ base, arm });
    }
  }

  build(mode: Mode): Plan {
    const unitOf = new Map<string, string>();
    for (const id of this.order) unitOf.set(id, this.root(id));
    return {
      mode,
      cells: this.order.map((id) => this.cells.get(id) as PlannedCell),
      unitOf,
      pairs: this.pairs,
      aliases: this.aliases,
    };
  }
}

const pixels = (
  w: number,
  h: number,
  content: Content = "gradient",
): Input => ({
  kind: "pixels",
  w,
  h,
  content,
});
const hashOf = (tier: number): Input => ({
  kind: "hash",
  tier,
  w: 100,
  h: 100,
  content: "gradient",
});

function encodeCell(
  target: string,
  tier: number,
  n: number,
  content: Content = "gradient",
  arm: { label: string; tune: string | null } | null = null,
): PlannedCell {
  const base = `encode/${target}/t${tier}/${n}x${n}/${content}`;
  return {
    id: arm ? leverId(base, arm.label) : base,
    op: "encode",
    target,
    tier,
    source: { w: n, h: n, content },
    tune: arm?.tune ?? null,
    decodeCap: null,
    threads: null,
    bytes: TIER_BYTES[tier] ?? null,
    argv: ["bench-encode", String(n), String(n), "srgb", "@ITERS@"],
    input: pixels(n, n, content),
    env: arm?.tune ? { CHROMAHASH_TUNE: arm.tune } : {},
  };
}

function decodeCell(
  target: string,
  tier: number,
  cap: [number, number] | null,
  arm: { label: string; tune: string | null } | null = null,
): PlannedCell {
  const base = `decode/${target}/t${tier}/${cap ? `capped${cap[0]}` : "natural"}`;
  return {
    id: arm ? leverId(base, arm.label) : base,
    op: "decode",
    target,
    tier,
    source: null,
    tune: arm?.tune ?? null,
    decodeCap: cap,
    threads: null,
    bytes: TIER_BYTES[tier] ?? null,
    argv: cap
      ? ["bench-decode", "@ITERS@", String(cap[0]), String(cap[1])]
      : ["bench-decode", "@ITERS@"],
    input: hashOf(tier),
    env: arm?.tune ? { CHROMAHASH_TUNE: arm.tune } : {},
  };
}

/**
 * One lever table: a base cell and its arms, each arm paired with the base.
 * The `shipped` arm is the base under another name, so it becomes an alias.
 * An arm whose label extends another arm's (`refine_passes=1 accel_…`) is
 * paired with that arm instead: the early exit can only shorten refinement.
 */
function levers(
  b: Builder,
  base: PlannedCell,
  arms: ReadonlyArray<{ label: string; tune: string | null }>,
  armCell: (arm: { label: string; tune: string | null }) => PlannedCell,
): void {
  b.add(base);
  for (const arm of arms) {
    if (arm.label === SHIPPED) {
      b.aliases[leverId(base.id, SHIPPED)] = base.id;
      continue;
    }
    const id = b.add(armCell(arm));
    const parent = arms.find(
      (a) =>
        a.label !== SHIPPED &&
        a.label !== arm.label &&
        arm.label.startsWith(`${a.label} `),
    );
    b.pair(parent ? leverId(base.id, parent.label) : base.id, id);
  }
}

/** The whole matrix for one mode, before `--full` is reduced to a supplement. */
export function planMatrix(mode: Mode, targets: readonly TargetCaps[]): Plan {
  const b = new Builder();
  const full = mode === "full";
  const has = (name: string) => targets.some((t) => t.name === name);

  // A. Cross-language encode/decode at the centre fixture.
  for (const t of targets) {
    for (const tier of mode === "quick"
      ? [1]
      : full
        ? ALL_TIERS
        : BOUNDED_CROSS_TIERS) {
      if (t.ops.includes("encode")) b.add(encodeCell(t.name, tier, 100));
      if (t.ops.includes("decode")) b.add(decodeCell(t.name, tier, null));
    }
  }
  if (mode === "quick") return b.build(mode);

  if (has("Rust")) {
    // B. Encode scaling in source pixels.
    for (const n of full ? FULL_SIZES : BOUNDED_SIZES) {
      b.add(encodeCell("Rust", 1, n));
    }
    // C. Decode by tier, natural and capped; the capped cell is paired with
    //    the natural one, which is §2's "saving" column.
    for (const tier of ALL_TIERS) {
      const natural = b.add(decodeCell("Rust", tier, null));
      const capped = b.add(decodeCell("Rust", tier, [32, 32]));
      b.pair(natural, capped);
    }
    // E. Encoder-only levers at three sizes (three, so the separable DCT's
    //    growing saving is a trend rather than a pair of points).
    for (const n of [100, 256, 512]) {
      levers(b, encodeCell("Rust", 1, n), TUNE_ARMS, (arm) =>
        encodeCell("Rust", 1, n, "gradient", arm),
      );
    }
    // E2. §12.1's levers at tier 4. The base is §2's tier-4 encode, which the
    //     bounded matrix therefore now measures.
    levers(b, encodeCell("Rust", 4, 100), TIER4_ACCEL_ARMS, (arm) =>
      encodeCell("Rust", 4, 100, "gradient", arm),
    );
    // E3. §12.1 item 4's decode levers, each against §2's own decode cell.
    for (const [tier, cap] of [
      [1, null],
      [4, null],
      [4, [32, 32]],
    ] as const) {
      const c: [number, number] | null = cap ? [cap[0], cap[1]] : null;
      levers(b, decodeCell("Rust", tier, c), DECODE_ACCEL_ARMS, (arm) =>
        decodeCell("Rust", tier, c, arm),
      );
    }
    // I. Content classes — what a filled AC band costs the quantizer.
    for (const content of ["gradient", "noise", "solid"] as const) {
      b.add(encodeCell("Rust", 1, 256, content));
    }
  }

  // D. SIMD on/off, paired so the gain is base (scalar) over arm (SIMD).
  if (has("Rust") && has("Rust (scalar)")) {
    for (const [n, tier] of [
      [100, 1],
      [256, 1],
      [512, 1],
      [512, 0],
    ] as const) {
      const simd = b.add(encodeCell("Rust", tier, n));
      const scalar = b.add(encodeCell("Rust (scalar)", tier, n));
      b.pair(scalar, simd);
    }
  }

  // G. Batch throughput and thread scaling, paired one thread over auto.
  for (const t of targets) {
    if (!t.ops.includes("batch")) continue;
    const ids: string[] = [];
    for (const th of t.threadable
      ? full
        ? FULL_THREADS
        : BOUNDED_THREADS
      : [1]) {
      ids.push(
        b.add({
          id: `batch/${t.name}/t1/100x100/threads=${th === 0 ? "auto" : th}`,
          op: "batch",
          target: t.name,
          tier: 1,
          source: { w: 100, h: 100, content: "gradient" },
          tune: null,
          decodeCap: null,
          threads: th,
          bytes: TIER_BYTES[1] ?? null,
          argv: ["bench-batch", "100", "100", "srgb", "200"],
          input: pixels(100, 100),
          env: { CHROMAHASH_BATCH_THREADS: String(th) },
        }),
      );
    }
    const one = `batch/${t.name}/t1/100x100/threads=1`;
    const auto = `batch/${t.name}/t1/100x100/threads=auto`;
    if (ids.includes(one) && ids.includes(auto)) b.pair(one, auto);
    for (const id of ids) b.join(one, id);
  }

  return b.build(mode);
}

/**
 * The plan a run executes. `bounded` and `quick` are their matrices; `full` is
 * the full matrix *minus every id the bounded matrix holds* — computed against
 * every target the driver knows (`universe`), not only the ones available on
 * this host, so a target that happened to be missing from one run cannot
 * leak its bounded ids into the supplement.
 */
export function planRun(
  mode: Mode,
  targets: readonly TargetCaps[],
  universe: readonly TargetCaps[] = targets,
): Plan {
  const plan = planMatrix(mode, targets);
  if (mode !== "full") return plan;
  const bounded = planMatrix("bounded", universe);
  const taken = new Set(bounded.cells.map((c) => c.id));
  for (const alias of Object.keys(bounded.aliases)) taken.add(alias);
  const cells = plan.cells.filter((c) => !taken.has(c.id));
  const kept = new Set(cells.map((c) => c.id));
  // A unit key is only a label, so a unit whose first member was dropped keeps
  // its key and its surviving members stay together.
  const unitOf = new Map<string, string>();
  for (const c of cells) unitOf.set(c.id, plan.unitOf.get(c.id) ?? c.id);
  return {
    mode,
    cells,
    unitOf,
    pairs: plan.pairs.filter((p) => kept.has(p.base) && kept.has(p.arm)),
    aliases: Object.fromEntries(
      Object.entries(plan.aliases).filter(
        ([alias, id]) => kept.has(id) && !taken.has(alias),
      ),
    ),
  };
}

/**
 * The order cells are spawned in, one list per round.
 *
 * Every cell gets one process per round, so P rounds give P independent
 * processes per cell, and slow drift over the sweep lands on every cell a
 * little rather than on whichever cell ran last. Cells of one unit stay
 * adjacent. Odd rounds run the units, and the cells inside each unit, in
 * reverse: across two rounds a pair runs A B … B A, so a linear drift adds as
 * much to one side of the ratio as to the other. (Plain ABAB would put the
 * same member first every time and leave the drift in the ratio.)
 */
export function roundOrder(plan: Plan, round: number): PlannedCell[] {
  const units = new Map<string, PlannedCell[]>();
  for (const c of plan.cells) {
    const u = plan.unitOf.get(c.id) ?? c.id;
    const list = units.get(u);
    if (list) list.push(c);
    else units.set(u, [c]);
  }
  const ordered = [...units.values()];
  const reverse = round % 2 === 1;
  if (reverse) ordered.reverse();
  return ordered.flatMap((cells) => (reverse ? [...cells].reverse() : cells));
}
