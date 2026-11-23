/**
 * Register entry D9's oracle bound (`spec/V0.8-DECISIONS.md`, D9, "The
 * oracle bound first, as run"), read off a committed `cfl-oracle` result.
 *
 * At each code k the result holds the tier's shipped arm, `tk shipped`, and
 * free chroma-from-luma arms, `tk free …`, whose gain fields are added on top
 * of the tier's bytes. For each image the bound takes the lowest ΔE00 among
 * the shipped arm and every free arm of that tier, after scoring, with no bit
 * spent on the choice. `B_k` is the mean of those minima against the shipped
 * arm's mean, as a relative difference in percent. It is above every adaptive
 * or conditional form that predicts chroma from luma with a least-squares
 * gain, since a deployed form pays for its flag and gains inside the tier's
 * bytes and decides before scoring.
 *
 * The rule: code k is decided on the bound when `B_k` is not at least
 * {@link D9_BAR}% lower overall and in every class the decoder recovers from
 * the hash that the run holds ({@link recoverableClasses}). D9 is decided on
 * the bound alone when that is so at every code 0–4.
 *
 * The bound is a mean of per-image minima, which no bootstrap seed moves, so
 * R1's condition 4 holds for it by construction. `stratify --cfl-oracle`,
 * `register-verdict D9`, `verify:experiments` (§13.14) and `selftest:metrics`
 * read D9 through here.
 */

import { ALPHA_IMAGES } from "./alpha-images.ts";
import { HOLDOUT3_PROTOCOL } from "./corpus.ts";
import { GRAPHIC_IMAGES } from "./graphic-images.ts";
import { CURATED_IMAGES } from "./natural-images.ts";

/** R1's condition 1: the bound must be at least this many percent lower. */
export const D9_BAR = 3.0;

/** The codes D9 decides, each separately. */
export const D9_CODES: readonly number[] = [0, 1, 2, 3, 4];

/**
 * The commit that fixed D9's sweep and rule (#139), at which D9's result is
 * scored. It is matched by equality, as `FREEZE_REVS` is, and never by
 * ancestry: the repository squash-merges, so this commit is not reachable
 * from the default branch and a fresh clone does not hold its object.
 */
export const D9_RULE_REV = "00c44983952443c60dc2b2b53b920e6bc91804e0";

/**
 * Refuse a D9 result that was not scored at {@link D9_RULE_REV} from a clean
 * tree, so no verdict is derived from a result the rule did not fix first.
 */
export function assertD9Provenance(
  name: string,
  p: { rev: string | null; dirty: boolean | null },
): void {
  if (p.dirty !== false) {
    throw new Error(
      `${name} was not scored from a clean tree (rev ${p.rev}, dirty ${p.dirty}); refusing to derive D9 from it`,
    );
  }
  if (p.rev !== D9_RULE_REV) {
    throw new Error(
      `${name} was scored at ${p.rev}, not at D9's rule ${D9_RULE_REV}; refusing to derive D9 from it`,
    );
  }
}

/** The shipped code-2 lengths: an alpha-mode hash is 103 B, an opaque one 108 B. */
export const CODE2_BYTES = { opaque: 108, alpha: 103 } as const;

/** What the bound reads of a result row. */
export interface OracleRow {
  label: string;
  perImage: {
    ciede2000?: readonly (number | null)[];
    bytes?: readonly (number | null)[];
  };
}

/** One code's arms: its shipped arm and the free CfL arms beside it. */
export interface OracleTier {
  k: number;
  shipped: string;
  free: string[];
}

const SHIPPED_LABEL = /^t(\d) shipped$/;
const FREE_LABEL = /^t(\d) free /;

/**
 * Every code a result holds, in row order: each `tk shipped` row with the
 * `tk free …` rows of the same k. A code with no free arm is left out, and a
 * free arm with no shipped arm of its code is refused.
 */
export function oracleTiers(rows: readonly { label: string }[]): OracleTier[] {
  const tiers: OracleTier[] = [];
  for (const r of rows) {
    const m = SHIPPED_LABEL.exec(r.label.trim());
    if (m) tiers.push({ k: Number(m[1]), shipped: r.label.trim(), free: [] });
  }
  for (const r of rows) {
    const m = FREE_LABEL.exec(r.label.trim());
    if (!m) continue;
    const tier = tiers.find((t) => t.k === Number(m[1]));
    if (!tier) {
      throw new Error(
        `${r.label}: no "t${m[1]} shipped" arm to read it against`,
      );
    }
    tier.free.push(r.label.trim());
  }
  return tiers.filter((t) => t.free.length > 0);
}

/** The bound over one group of images at one code. */
export interface Bound {
  group: string;
  n: number;
  shippedMean: number;
  oracleMean: number;
  /** `(oracleMean − shippedMean) / shippedMean`, in percent. */
  rel: number;
  /** Images on which a free arm scores strictly below the shipped arm. */
  cflLower: number;
  /** Whether the bound is at least {@link D9_BAR}% lower. */
  reaches: boolean;
}

function series(
  rows: readonly OracleRow[],
  label: string,
): readonly (number | null)[] {
  const row = rows.find((r) => r.label.trim() === label);
  const s = row?.perImage.ciede2000;
  if (!s) throw new Error(`no ΔE00 series for arm "${label}"`);
  return s;
}

/**
 * The bound at `tier` over the images `idx` names. An image any arm did not
 * score is refused rather than skipped: dropping it would change the group
 * the bound is a statement about.
 */
export function boundOver(
  tier: OracleTier,
  rows: readonly OracleRow[],
  idx: readonly number[],
  group: string,
): Bound {
  if (idx.length === 0) throw new Error(`group "${group}" holds no image`);
  const shipped = series(rows, tier.shipped);
  const free = tier.free.map((l) => series(rows, l));
  let s = 0;
  let o = 0;
  let cflLower = 0;
  for (const i of idx) {
    const base = shipped[i];
    if (base == null)
      throw new Error(`${tier.shipped}: no ΔE00 for image ${i}`);
    let low = base;
    for (const [j, f] of free.entries()) {
      const v = f[i];
      if (v == null) throw new Error(`${tier.free[j]}: no ΔE00 for image ${i}`);
      low = Math.min(low, v);
    }
    if (low < base) cflLower++;
    s += base;
    o += low;
  }
  const shippedMean = s / idx.length;
  const oracleMean = o / idx.length;
  const rel = (100 * (oracleMean - shippedMean)) / shippedMean;
  return {
    group,
    n: idx.length,
    shippedMean,
    oracleMean,
    rel,
    cflLower,
    reaches: rel <= -D9_BAR,
  };
}

/** Long edge over short edge of a pinned image, or undefined for no pin. */
function pinnedAspect(name: string): number | undefined {
  const pin = [...CURATED_IMAGES, ...ALPHA_IMAGES, ...GRAPHIC_IMAGES].find(
    (p) => p.label === name,
  );
  if (!pin) return undefined;
  const long = Math.max(pin.width, pin.height);
  const short = Math.min(pin.width, pin.height);
  return short > 0 ? long / short : undefined;
}

/**
 * The classes a conditional form could activate on, because the decoder
 * recovers them from the hash, each as image indices: `alpha` and `opaque`
 * (the alpha flag), and `extreme-aspect` (the aspect byte), in that order. A
 * class no image falls in is left out.
 *
 * The alpha flag is read off the run itself, from the length of each image's
 * `t2 shipped` hash (alpha mode shortens code 2), so it is the flag the
 * encoder set rather than a covariate. Extreme aspect is the holdout3
 * stratum's test on the pinned dimensions, which EXIF rotation does not
 * change.
 */
export function recoverableClasses(
  imageNames: readonly string[],
  rows: readonly OracleRow[],
): Map<string, number[]> {
  const bytes = rows.find((r) => r.label.trim() === "t2 shipped")?.perImage
    .bytes;
  if (!bytes) {
    throw new Error('no "t2 shipped" byte series to read the alpha flag from');
  }
  const alpha: number[] = [];
  const opaque: number[] = [];
  const extreme: number[] = [];
  for (const [i, name] of imageNames.entries()) {
    const b = bytes[i];
    if (b === CODE2_BYTES.alpha) alpha.push(i);
    else if (b === CODE2_BYTES.opaque) opaque.push(i);
    else {
      throw new Error(
        `${name}: a ${b ?? "missing"} B code-2 hash is neither alpha mode (${CODE2_BYTES.alpha} B) nor opaque (${CODE2_BYTES.opaque} B)`,
      );
    }
    const aspect = pinnedAspect(name);
    if (aspect === undefined) throw new Error(`${name}: no pinned dimensions`);
    if (aspect >= HOLDOUT3_PROTOCOL.aspectMin) extreme.push(i);
  }
  const out = new Map<string, number[]>();
  if (alpha.length > 0) out.set("alpha", alpha);
  if (opaque.length > 0) out.set("opaque", opaque);
  if (extreme.length > 0) out.set("extreme-aspect", extreme);
  return out;
}

/** D9's reading at one code. */
export interface D9TierReading {
  k: number;
  overall: Bound;
  classes: Bound[];
  /** Decided on the bound: neither overall nor any class reaches the bar. */
  decided: boolean;
}

/** D9's reading of a result. */
export interface D9Reading {
  tiers: D9TierReading[];
  /** Codes 0–4 that the result does not hold. */
  missing: number[];
  /** D9 is decided on the bound alone: every code is held and decided. */
  decided: boolean;
}

/** Apply D9's rule to a result's rows. */
export function readD9(file: {
  imageNames: readonly string[];
  rows: readonly OracleRow[];
}): D9Reading {
  const all = file.imageNames.map((_, i) => i);
  const classes = recoverableClasses(file.imageNames, file.rows);
  const tiers = oracleTiers(file.rows).map((tier): D9TierReading => {
    const overall = boundOver(tier, file.rows, all, "overall");
    const byClass = [...classes].map(([c, idx]) =>
      boundOver(tier, file.rows, idx, c),
    );
    return {
      k: tier.k,
      overall,
      classes: byClass,
      decided: !overall.reaches && byClass.every((b) => !b.reaches),
    };
  });
  const missing = D9_CODES.filter((k) => !tiers.some((t) => t.k === k));
  return {
    tiers,
    missing,
    decided: missing.length === 0 && tiers.every((t) => t.decided),
  };
}

/**
 * D9's verdict from a committed `cfl-oracle` result: refused unless the
 * result passes {@link assertD9Provenance}, then {@link readD9}.
 */
export function deriveD9Verdict(file: {
  name: string;
  provenance: { rev: string | null; dirty: boolean | null };
  imageNames: readonly string[];
  rows: readonly OracleRow[];
}): D9Reading {
  assertD9Provenance(file.name, file.provenance);
  return readD9(file);
}

/**
 * The cells `EXPERIMENTS.md` §13.14's bound table states, by code: the
 * shipped and oracle means, the bound overall and in each class, the images
 * a free arm scores lower on, and the outcome.
 */
export function d9Cells(
  reading: D9Reading,
): Map<string, Record<string, number | string>> {
  const out = new Map<string, Record<string, number | string>>();
  for (const t of reading.tiers) {
    const cells: Record<string, number | string> = {
      shipped: t.overall.shippedMean,
      oracle: t.overall.oracleMean,
      bound: t.overall.rel,
      cflLower: `${t.overall.cflLower} of ${t.overall.n}`,
      outcome: t.decided ? "decided on the bound" : "reaches 3%",
    };
    for (const c of t.classes) cells[c.group] = c.rel;
    out.set(`code ${t.k}`, cells);
  }
  return out;
}
