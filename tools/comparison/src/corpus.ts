import { ALPHA_IMAGES } from "./alpha-images.ts";
import { GRAPHIC_IMAGES } from "./graphic-images.ts";
import { CURATED_IMAGES } from "./natural-images.ts";

/**
 * Which corpus split an image belongs to. Constants sweeps MUST tune on the
 * "tune" split only and validate on a holdout — tuning on the full corpus is
 * train/test contamination (the format's constants were once swept on the same
 * images the report evaluates; this split exists so that never happens again).
 *
 * - `tune` — what constants are chosen on.
 * - `tune2` — the **spent** photographic holdout: Kodak24 and the eight curated
 *   photographs that were `holdout` until #76. It informed a decision in every
 *   round (`spec/EXPERIMENTS.md` §11.12), so it can no longer give an
 *   out-of-sample verdict. It is kept apart from `tune` rather than merged into
 *   it, so every committed tune result keeps meaning what it measured and the
 *   split's history stays visible in its name. It is tuning data now.
 * - `holdout` — the graphics corpus's holdout, which no committed result or
 *   recorded decision has read, and the alpha corpus's retired one (#83, refused by
 *   `alphaImagesToFetch`). No photograph is in it any more:
 *   {@link PHOTO_HOLDOUT_RETIRED}.
 * - `holdout2` — the sealed photographic holdout (#76). No tool reads it
 *   unless `spec/V0.8-DECISIONS.md` records the decision being answered as
 *   frozen (`holdout-images.ts` `openHoldout2`), and nothing reads it by
 *   accident: see {@link isSealed}.
 */
export type CorpusSplit = "tune" | "tune2" | "holdout" | "holdout2";

/** Every split, in the order a tool lists them. */
export const CORPUS_SPLITS: readonly CorpusSplit[] = [
  "tune",
  "tune2",
  "holdout",
  "holdout2",
];

/**
 * Why `--split holdout` refuses a photographic corpus. The images still exist
 * and are pinned; what is gone is their use as a holdout. They are `tune2`.
 */
export const PHOTO_HOLDOUT_RETIRED =
  "the photographic holdout is spent and retired (#76): Kodak24 and its eight curated photographs " +
  "informed a decision in every round (spec/EXPERIMENTS.md §11.12), so they are now the tune2 split. " +
  "Score them with --split tune2 (tuning data, not a verdict); the out-of-sample split is holdout2, " +
  "sealed until spec/V0.8-DECISIONS.md records the decision it answers as frozen.";

/** Declared split of every curated image, keyed by label. */
const DECLARED_SPLITS = new Map<string, CorpusSplit>([
  ...CURATED_IMAGES.map((s): [string, CorpusSplit] => [s.label, s.split]),
  ...ALPHA_IMAGES.map((s): [string, CorpusSplit] => [s.label, s.split]),
  ...GRAPHIC_IMAGES.map((s): [string, CorpusSplit] => [s.label, s.split]),
]);

/**
 * Filename prefix of every sealed-holdout image. The prefix, not a table
 * lookup, is what marks an image sealed: a cached file whose pin was later
 * removed or renamed would otherwise fall through to "tune" and join every
 * tune sweep — the failure `alpha-images.ts` keeps withdrawn pins to prevent.
 */
export const HOLDOUT2_PREFIX = "sealed-";

/**
 * Resolve the corpus split for an image by its report name (the filename
 * without extension). Explicit rules:
 *
 * - `sealed-*` is holdout2, whatever any table says.
 * - `kodak*` (the Kodak True Color suite) is tune2: it was holdout by
 *   definition until #76 retired the photographic holdout.
 * - Every curated image — photo, alpha or graphic — carries its declared split.
 * - Everything else — all synthetic fixtures and realistic images — is tune.
 */
export function splitFor(imageName: string): CorpusSplit {
  if (imageName.startsWith(HOLDOUT2_PREFIX)) return "holdout2";
  if (imageName.startsWith("kodak")) return "tune2";
  return DECLARED_SPLITS.get(imageName) ?? "tune";
}

/**
 * Is `split` sealed: never read unless the register gate opens it for one
 * decision? A loader that globs `fixtures/**` sees a sealed image whenever an
 * earlier gated run cached it, so every loader asks this before scoring one,
 * and "all" never includes it.
 */
export function isSealed(split: CorpusSplit): boolean {
  return split === "holdout2";
}

/**
 * Does an image belong to the split a tool was asked for? `"all"` means every
 * split that is not sealed. A sealed split matches only when asked for by
 * name, which the tools that accept it do only after the register gate.
 */
export function inSplit(
  imageName: string,
  wanted: CorpusSplit | "all",
): boolean {
  const split = splitFor(imageName);
  if (wanted === "all") return !isSealed(split);
  return split === wanted;
}

/**
 * Parse a `--split` value, throwing on anything unrecognized rather than
 * defaulting. `allowAll` admits `"all"` for the tools that score every
 * unsealed split at once.
 */
export function parseSplit(value: string, allowAll: false): CorpusSplit;
export function parseSplit(value: string, allowAll: true): CorpusSplit | "all";
export function parseSplit(
  value: string,
  allowAll: boolean,
): CorpusSplit | "all" {
  if (allowAll && value === "all") return "all";
  const found = CORPUS_SPLITS.find((s) => s === value);
  if (found !== undefined) return found;
  throw new Error(
    `unknown --split "${value}" (expected ${[...CORPUS_SPLITS, ...(allowAll ? ["all"] : [])].join(", ")})`,
  );
}

/**
 * Parse `--split` for a photographs-only tool whose output is scratch — JSON
 * under `output/`, with no provenance and nothing committed. `holdout` is
 * refused because no photograph is in it any more; `holdout2` because a
 * reading of the sealed split has to be a committed result that records the
 * register decision it answers, which only `sweep` and `rd-budget` write.
 */
export function parseScratchPhotoSplit(value: string): CorpusSplit | "all" {
  const split = parseSplit(value, true);
  if (split === "holdout") throw new Error(PHOTO_HOLDOUT_RETIRED);
  if (split === "holdout2") {
    throw new Error(
      "this tool does not read holdout2: its output is scratch with no provenance, and a reading of the sealed split must be a committed result (results.ts) recording the register decision it answers — use sweep or rd-budget with --decision",
    );
  }
  return split;
}

/**
 * Which body of content a sweep is measured against.
 *
 * The format's constants have only ever been chosen against photographs, and
 * for most questions that is the right corpus — but not for all of them. The
 * alpha-mode layout cannot be measured on a corpus with no transparency in it,
 * and a layout tuned on photographs has never been checked against the
 * screenshots, charts and logos a real placeholder pipeline also ingests.
 *
 * Membership is keyed off the filename prefix, so adding fixtures under a new
 * prefix cannot silently move the mean of an existing sweep — which is the
 * failure mode the content pins exist to prevent (`EXPERIMENTS.md` §7.14).
 */
export type CorpusSet = "photo" | "alpha" | "graphic" | "all";

/**
 * Filename prefixes belonging to each corpus. `alpha` deliberately excludes the
 * generated `alpha-*` synthetic fixtures: those are 8x8 correctness cases for
 * the alpha *path*, not content anything should be tuned against.
 */
const CORPUS_PREFIXES: Record<Exclude<CorpusSet, "all">, readonly string[]> = {
  photo: [
    "natural-",
    "portrait-",
    "night-",
    "chroma-",
    "kodak",
    HOLDOUT2_PREFIX,
  ],
  alpha: ["cutout-"],
  graphic: ["graphic-"],
};

/** Does an image (by report name, i.e. filename without extension) belong to `set`? */
export function inCorpus(imageName: string, set: CorpusSet): boolean {
  if (set === "all") return true;
  return CORPUS_PREFIXES[set].some((p) => imageName.startsWith(p));
}

/**
 * Whether an image is real content or a generated capability fixture.
 *
 * This is a third axis, orthogonal to {@link CorpusSplit} (tune/holdout) and
 * {@link CorpusSet} (photo/alpha/graphic), and it exists because averaging the
 * two together misleads. `gamut-bt2020.png`, `dim-1x100.png` and
 * `solid-blue.png` demonstrate that the format *can* represent a case; they say
 * nothing about how well it serves a real placeholder, and a mean taken across
 * both reads a capability demonstration as a quality result.
 */
export type CorpusTier = "real" | "synthetic";

/**
 * Resolve an image's tier from its report name.
 *
 * Derived from {@link CORPUS_PREFIXES} rather than restated, so the two cannot
 * drift: anything belonging to the photo, alpha or graphic corpora is real
 * content; everything else is a generated fixture.
 *
 * Deliberately *not* keyed off `ImageCategory`. `categorizeImage()`'s
 * "Realistic" arm is a fallthrough default for unmatched filenames, so an
 * image nobody classified would silently be counted as real evidence.
 */
export function tierFor(imageName: string): CorpusTier {
  const real = (["photo", "alpha", "graphic"] as const).some((set) =>
    inCorpus(imageName, set),
  );
  return real ? "real" : "synthetic";
}

/** Parse a corpus name, throwing on anything unrecognized rather than defaulting. */
export function parseCorpusSet(value: string): CorpusSet {
  if (
    value === "photo" ||
    value === "alpha" ||
    value === "graphic" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error(
    `unknown corpus "${value}" (expected photo, alpha, graphic or all)`,
  );
}
