/**
 * Register entry D4, the separable forward DCT (`spec/V0.8-DECISIONS.md`):
 * the shape of its two committed counts, how they are tallied, and how the
 * verdict is read from them. `dct-identity.ts` and `perf/dct-instructions.ts`
 * write the records; `register-verdict D4` and `selftest:metrics` read them
 * through {@link deriveD4Verdict}.
 *
 * The entry's outcome rests on counts, not intervals:
 *
 * 1. **Selection (in sample).** The candidate qualifies if the instruction
 *    record gives a reading (its two runs agree within 1%) with both pair
 *    ratios at least {@link SPEED_THRESHOLD}, and the open-split and vector
 *    count finds no differing hash, with its negative control seen.
 * 2. **Verdict (holdout3).** A qualifying candidate passes if the one
 *    holdout3 read finds no differing hash. The decoder is untouched, so
 *    identical hashes decode to identical pixels, and R2's ΔE00 and guard
 *    conditions, condition 4 and the stratum rule hold exactly. Any
 *    differing hash fails it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Provenance } from "./results.ts";
import type { Holdout3Opening } from "./holdout-images.ts";
import { runsAgree } from "./perf/count.ts";

/** Where D4's count records are committed: not sweeps, so not beside them. */
export const COUNTS_DIR = path.join(
  import.meta.dirname,
  "..",
  "results",
  "counts",
);

/** The one candidate, and the negative control `lever-identity` uses. */
export const D4_CANDIDATE = "dct_separable=1";
export const D4_CONTROL = "mu_l=3";
/**
 * The splits the open count encodes: tuning data only. The graphics
 * `holdout` is unsealed but no committed result has read it (`corpus.ts`),
 * so D4 does not spend it on a byte-identity count either.
 */
export const D4_OPEN_SPLITS: readonly string[] = ["tune", "tune2"];
/** D4's speed threshold, unchanged by the amendment. */
export const SPEED_THRESHOLD = 2.0;

/** The three encode sizes, as `lever-identity` takes them. */
export type SizeKey = "harness" | "512" | "full";
export const SIZES: ReadonlyArray<{ size: SizeKey; tiers: readonly number[] }> =
  [
    { size: "harness", tiers: [0, 1, 2, 3, 4] },
    { size: "512", tiers: [0, 1, 2, 3, 4] },
    { size: "full", tiers: [0, 1, 2] },
  ];
/** The sizes the negative control runs at. */
export const CONTROL_SIZES: readonly SizeKey[] = ["harness", "512"];

/** One encode pair's outcome, before tallying. */
export interface Observation {
  image: string;
  corpus: string;
  split: string;
  strata: readonly string[];
  size: SizeKey;
  tier: number;
  differs: boolean;
  /** Whether the control hash differs from the shipped one; null where none ran. */
  controlDiffers: boolean | null;
}

/** The count in one corpus × split × size × tier cell. */
export interface IdentityCell {
  corpus: string;
  split: string;
  size: SizeKey;
  tier: number;
  encodes: number;
  differing: number;
  controlEncodes: number;
  controlDiffering: number;
}

/** The count in one holdout3 stratum, over every size and tier. */
export interface StratumCount {
  stratum: string;
  images: number;
  encodes: number;
  differing: number;
}

export interface Totals {
  encodes: number;
  differing: number;
  controlEncodes: number;
  controlDiffering: number;
}

/** The encode vectors' count. */
export interface VectorCount {
  vectors: number;
  encodes: number;
  differing: number;
  /** Vectors whose shipped hash at their own code is not the expected one. */
  expectedMismatches: string[];
  /** `name tN`, per differing encode. */
  diffs: string[];
}

export interface IdentityRecord {
  schema: 1;
  tool: "dct-identity";
  name: string;
  /** `open` for the tuning splits ({@link D4_OPEN_SPLITS}); `holdout3` for the entry's one read. */
  split: "open" | "holdout3";
  settings: {
    candidate: string;
    control: string;
    sizes: typeof SIZES;
    controlSizes: readonly SizeKey[];
    holdout3?: Holdout3Opening;
  };
  provenance: Provenance;
  images: {
    name: string;
    corpus: string;
    split: string;
    width: number;
    height: number;
    strata: readonly string[];
  }[];
  cells: IdentityCell[];
  strata: StratumCount[];
  vectors?: VectorCount;
  totals: Totals;
  /** `image size tN`, per differing encode. */
  diffs: string[];
}

/** Tally observations into cells, in first-seen corpus × split order, then size and tier. */
export function tallyCells(obs: readonly Observation[]): IdentityCell[] {
  const cells = new Map<string, IdentityCell>();
  for (const o of obs) {
    const key = `${o.corpus}\0${o.split}\0${o.size}\0${o.tier}`;
    let c = cells.get(key);
    if (!c) {
      c = {
        corpus: o.corpus,
        split: o.split,
        size: o.size,
        tier: o.tier,
        encodes: 0,
        differing: 0,
        controlEncodes: 0,
        controlDiffering: 0,
      };
      cells.set(key, c);
    }
    c.encodes++;
    if (o.differs) c.differing++;
    if (o.controlDiffers !== null) {
      c.controlEncodes++;
      if (o.controlDiffers) c.controlDiffering++;
    }
  }
  const sizeOrder = (s: SizeKey): number =>
    SIZES.findIndex((x) => x.size === s);
  const groups = [
    ...new Set([...cells.values()].map((c) => `${c.corpus}\0${c.split}`)),
  ];
  return [...cells.values()].sort(
    (a, b) =>
      groups.indexOf(`${a.corpus}\0${a.split}`) -
        groups.indexOf(`${b.corpus}\0${b.split}`) ||
      sizeOrder(a.size) - sizeOrder(b.size) ||
      a.tier - b.tier,
  );
}

/** Tally observations by stratum, in `order`; a stratum with no image is left out. */
export function tallyStrata(
  obs: readonly Observation[],
  order: readonly string[],
): StratumCount[] {
  const out: StratumCount[] = [];
  for (const stratum of order) {
    const inside = obs.filter((o) => o.strata.includes(stratum));
    if (inside.length === 0) continue;
    out.push({
      stratum,
      images: new Set(inside.map((o) => o.image)).size,
      encodes: inside.length,
      differing: inside.filter((o) => o.differs).length,
    });
  }
  return out;
}

export function totalsOf(cells: readonly IdentityCell[]): Totals {
  const t: Totals = {
    encodes: 0,
    differing: 0,
    controlEncodes: 0,
    controlDiffering: 0,
  };
  for (const c of cells) {
    t.encodes += c.encodes;
    t.differing += c.differing;
    t.controlEncodes += c.controlEncodes;
    t.controlDiffering += c.controlDiffering;
  }
  return t;
}

/** The instruction record `perf/dct-instructions.ts` writes, as read here. */
export interface InstructionRecord {
  tool: "dct-instructions";
  provenance: Provenance;
  pairs: {
    label: string;
    hashesEqual: boolean;
    agree: boolean;
    instructionRatio: number | null;
    runs: {
      reading: {
        ratio: Record<string, number>;
        min: Record<string, number>;
        max: Record<string, number>;
      };
    }[];
  }[];
  fasterIncumbent: string;
  agree: boolean;
}

export interface SpeedReading {
  pairs: {
    label: string;
    ratio: number;
    runRatios: number[];
    min: number;
    max: number;
    agree: boolean;
    pass: boolean;
  }[];
  fasterIncumbent: string;
  /** Every pair's runs agree and every ratio is at least the threshold. */
  pass: boolean;
}

/** Read the instruction record: both pairs, each at the threshold, runs agreeing. */
export function readSpeed(rec: InstructionRecord): SpeedReading {
  const pairs = rec.pairs.map((p) => {
    const runRatios = p.runs.map((r) => r.reading.ratio["instructions:u"] ?? 0);
    const first = p.runs[0]?.reading;
    const ratio = runRatios[0] ?? 0;
    const agree =
      runRatios.length === 2 && runsAgree(runRatios[0] ?? 0, runRatios[1] ?? 0);
    return {
      label: p.label,
      ratio,
      runRatios,
      min: first?.min["instructions:u"] ?? 0,
      max: first?.max["instructions:u"] ?? 0,
      agree,
      pass: agree && ratio >= SPEED_THRESHOLD,
    };
  });
  return {
    pairs,
    fasterIncumbent: rec.fasterIncumbent,
    pass: pairs.length === 2 && pairs.every((p) => p.pass),
  };
}

export interface IdentityReading {
  encodes: number;
  differing: number;
  /** The negative control changed at least one hash. */
  controlSeen: boolean;
  vectorsDiffering: number;
  expectedMismatches: number;
  pass: boolean;
}

/**
 * Read an identity record. It passes with no differing hash, a negative
 * control that changed at least one hash, and, where it carries vectors,
 * every vector's shipped hash equal to its expected hash.
 */
export function readIdentity(rec: IdentityRecord): IdentityReading {
  const vectorsDiffering = rec.vectors?.differing ?? 0;
  const expectedMismatches = rec.vectors?.expectedMismatches.length ?? 0;
  const controlSeen = rec.totals.controlDiffering > 0;
  return {
    encodes: rec.totals.encodes + (rec.vectors?.encodes ?? 0),
    differing: rec.totals.differing,
    controlSeen,
    vectorsDiffering,
    expectedMismatches,
    pass:
      rec.totals.encodes > 0 &&
      rec.totals.differing === 0 &&
      vectorsDiffering === 0 &&
      expectedMismatches === 0 &&
      controlSeen,
  };
}

export interface D4Verdict {
  speed: SpeedReading;
  open: IdentityReading;
  qualifies: boolean;
  holdout3: (IdentityReading & { strata: StratumCount[] }) | null;
  /** R2's outcome; null while a qualifying candidate's holdout3 is unread. */
  outcome: "passes" | "fails in sample" | "fails on holdout3" | null;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function assertClean(name: string, p: Provenance, rev?: string): void {
  if (p.rev === null || p.dirty !== false) {
    throw new Error(
      `${name} was not recorded from a clean tree (rev ${p.rev}, dirty ${p.dirty}); refusing to derive D4 from it`,
    );
  }
  if (rev !== undefined && p.rev !== rev) {
    throw new Error(
      `${name} was read at ${p.rev}, not at D4's freeze ${rev}; refusing to derive D4 from it`,
    );
  }
}

/**
 * Derive D4's outcome from its committed records in `dir`. Each must come
 * from a clean tree; the holdout3 read must be at `freezeRev`. Before the
 * freeze (no `freezeRev`) the outcome is the selection alone: null if the
 * candidate qualifies and holdout3 is still to be read.
 */
export function deriveD4Verdict(
  dir: string = COUNTS_DIR,
  freezeRev?: string,
): D4Verdict {
  const instr = readJson<InstructionRecord>(
    path.join(dir, "dct-instructions.json"),
  );
  const open = readJson<IdentityRecord>(path.join(dir, "dct-identity.json"));
  assertClean("dct-instructions", instr.provenance);
  assertClean("dct-identity", open.provenance);
  if (open.split !== "open")
    throw new Error("dct-identity is not the open count");
  const outside = open.images.filter((i) => !D4_OPEN_SPLITS.includes(i.split));
  if (outside.length > 0) {
    throw new Error(
      `dct-identity encoded ${outside.length} image(s) outside ${D4_OPEN_SPLITS.join(" and ")} (${outside[0]?.name}, ${outside[0]?.split}); refusing to derive D4 from it`,
    );
  }
  const speed = readSpeed(instr);
  const openReading = readIdentity(open);
  const qualifies = speed.pass && openReading.pass;
  if (!qualifies) {
    return {
      speed,
      open: openReading,
      qualifies,
      holdout3: null,
      outcome: "fails in sample",
    };
  }
  if (freezeRev === undefined) {
    return {
      speed,
      open: openReading,
      qualifies,
      holdout3: null,
      outcome: null,
    };
  }
  const h3 = readJson<IdentityRecord>(
    path.join(dir, "dct-identity-holdout3.json"),
  );
  assertClean("dct-identity-holdout3", h3.provenance, freezeRev);
  if (h3.split !== "holdout3" || h3.settings.holdout3?.decision !== "D4") {
    throw new Error("dct-identity-holdout3 is not D4's holdout3 read");
  }
  const h3Reading = readIdentity(h3);
  return {
    speed,
    open: openReading,
    qualifies,
    holdout3: { ...h3Reading, strata: h3.strata },
    outcome: h3Reading.pass ? "passes" : "fails on holdout3",
  };
}
