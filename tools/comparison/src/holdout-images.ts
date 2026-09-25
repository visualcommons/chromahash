import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePinnedFixture, sha256 } from "./corpus-pin.ts";
import { HOLDOUT2_PREFIX } from "./corpus.ts";
import {
  CURATED_IMAGES,
  type NaturalImageSpec,
  naturalImagePath,
} from "./natural-images.ts";

const HOLDOUT_DIR = path.resolve(import.meta.dirname, "../fixtures/holdout");
/** Not `results.ts`'s: that module imports this one, and a cycle leaves it undefined here. */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/** Number of images in the Kodak True Color suite (kodim01 … kodim24). */
const KODAK_COUNT = 24;

/**
 * SHA-256 of each `kodim<NN>.png` as served by r0k.us, indexed 0-based
 * (`KODAK_SHA256[0]` pins kodim01). The suite is byte-stable — the same PNGs
 * have been at the same URL since 1999 — so a mismatch means the mirror
 * changed, not that the corpus did; either way the run must stop rather than
 * score against different pixels (see corpus-pin.ts).
 */
export const KODAK_SHA256: readonly string[] = [
  "a56e27cbf5f843c048b6af1d6e090760e9c92fadba88b7dee0205918a37523bd", // kodak01
  "4f4b74a79237e311d72cad958237b5f7088d8bce1c82305ebefe1a70e3022dfd", // kodak02
  "e25ca1ff2f0c0cb5fdfd5f9b0a0bb21ac4c3de3c84a67f35b09a85d3306249db", // kodak03
  "e3b946107c5d3441c022f678d0c3caf1e224d81b1604ba840a4f88e562de61aa", // kodak04
  "10349e963c5c813d327852f82c1795fa4148d69fedffc4c589bee458e3ac3d53", // kodak05
  "363510303b715d4cbc384e1ce227e466b613a09e1b71ae985882bf8e7fbd9b18", // kodak06
  "b77d3f006f42414bb242222e0482e750c0fb9e5ee8d4bed2f6f11c5605fe54a4", // kodak07
  "ba23983c76b4832ee0e8af0592664756841a16779acd69f792e268fb6d13d6e7", // kodak08
  "6a4361c2fc194feb4edaa9f9a4a0620fb9943e460ac7fdf037fb0f6dd6607a7d", // kodak09
  "9dfb70f5867c29ff9ed6313683f19b3d867849e40fbc0c4c54a4a89df341cf23", // kodak10
  "7936814b58b5387fce2e4e2488b4ec830dadd95fa9520f358ddb30990b50f2b6", // kodak11
  "d78c37c2f04f23761ed2367dd77e2db584ddd4c3950833fecf89f199a8126980", // kodak12
  "bc34a3ce58dea09dce1704c997171602de90cb34d0c8503a988b77f473d39b08", // kodak13
  "55a94550ff18f3246c4074fd32b77b0c74447c26b6ad274d564d999c0450ba6e", // kodak14
  "7538cbb80cb9103606c48b806eae57d56c885c7f90b9b3be70a41160f9cbb683", // kodak15
  "a89c7268ccd4718ba424a99fc4643c572cf692ca6eae887185ceb4e9f11d2e54", // kodak16
  "37afcc89fbdcb76d9518e04b2fc011027e2f4cd14b3b2f83cefd721641a47c5b", // kodak17
  "1a9258c365988961d87a0598725b609139c303ad48a5aad6c503c3b1a87849aa", // kodak18
  "b7450b264b1b0a411390d8931b112c27905a992520fc90569dc4b920aa32bbdc", // kodak19
  "3b46c71e3b92a563820ba32936be8330c586c41f938efd94be938386aae4328a", // kodak20
  "ac958597c82073f6bb65129c68f72b651db5b9efd82e11547d07350214bc268b", // kodak21
  "1cee58eb1f2d9c7ebb254d208a03c783ce6cf2c4d8c2cf45e235dd23b4ce1b29", // kodak22
  "e3111a2fd4da24af15d6459ef9eacfe54106b38e27b4a21821b75c3f5d2d5baf", // kodak23
  "1071c68372cc5a01435c2c225a5cf7d4bb803846ec08bb6b3d6721b156d7cb96", // kodak24
];

/**
 * Ensure the Kodak images are downloaded, cached and content-pinned. The set
 * is the Kodak True Color suite: 24 uncompressed 768x512 / 512x768
 * photographs, free for unrestricted use and hosted at the same URL since
 * 1999 — a stable, well-known corpus no LQIP format's constants were tuned on
 * when it was chosen. (CLIC datasets were considered as an additional holdout
 * source, but their hosting URLs are unstable.) Labels are `kodak01` …
 * `kodak24`.
 *
 * It was the core of the photographic holdout until #76 retired that split as
 * spent: it had informed a decision in every round (`spec/EXPERIMENTS.md`
 * §11.12). corpus.ts now maps every `kodak*` image to "tune2", and the
 * out-of-sample verdict belongs to the sealed holdout2 split
 * ({@link ensureHoldout2Images}).
 *
 * Every file is verified against its declared SHA-256 whether it came from the
 * cache or from the network. A fetch failure or a digest mismatch throws — a
 * partial split would silently move every mean taken over it.
 */
export async function ensureHoldoutImages(): Promise<string[]> {
  await fs.mkdir(HOLDOUT_DIR, { recursive: true });

  const paths: string[] = [];
  let downloadCount = 0;

  for (let i = 1; i <= KODAK_COUNT; i++) {
    const num = String(i).padStart(2, "0");
    const sha256 = KODAK_SHA256[i - 1];
    if (sha256 === undefined) {
      throw new Error(`no pinned digest for kodak${num}`);
    }
    const filePath = path.join(HOLDOUT_DIR, `kodak${num}.png`);
    const downloaded = await ensurePinnedFixture({
      filePath,
      // HTTPS first: r0k.us is the canonical home of the suite but is one
      // hobby server, and this was the only plain-HTTP fetch in the corpus.
      // The plain-HTTP URL is the only fallback, and the pinned digest is what
      // makes it safe; there is no second host, so r0k.us being down fails
      // the holdout split loudly rather than silently shrinking it.
      urls: [
        `https://r0k.us/graphics/kodak/kodak/kodim${num}.png`,
        `http://r0k.us/graphics/kodak/kodak/kodim${num}.png`,
      ],
      sha256,
      label: `kodak${num}`,
    });
    if (downloaded) downloadCount++;
    paths.push(filePath);
  }

  if (downloadCount > 0) {
    console.log(`Downloaded ${downloadCount} Kodak image(s) to ${HOLDOUT_DIR}`);
  }

  return paths;
}

// ─── The sealed holdout (holdout2, #76) ─────────────────────────────────────

/**
 * The v0.8 decision register the gate reads. Only a decision it records as
 * `frozen` — criterion fixed and approved, not yet answered — may open
 * holdout2.
 */
export const DECISION_REGISTER = path.join(REPO_ROOT, "spec/V0.8-DECISIONS.md");

/**
 * Proof that the gate ran and what it read. `ensureHoldout2Images` takes one,
 * so nothing can fetch the sealed split without having passed
 * {@link openHoldout2}; a result scored on holdout2 records it.
 */
export interface Holdout2Opening {
  /** The register decision this reading answers. */
  decision: string;
  /** Repo-relative path of the register that was read. */
  register: string;
  /** SHA-256 of the register's bytes when it was read. */
  registerSha256: string;
}

/** A decision ID: a letter, then letters, digits, `.`, `_` or `-`. */
const DECISION_ID = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * A status line, in any of the forms Markdown prose puts one: `Status: frozen`,
 * `**Status:** frozen`, `**Status**: frozen`, optionally as a list item.
 */
const STATUS_LINE =
  /^\s*(?:[-*+]\s+)?(?:\*\*|__)?status(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*([A-Za-z-]+)/i;

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What the register records as a decision's status, or why it records none.
 *
 * The register's contract, which this parser is the whole of:
 *
 * - A decision is a Markdown heading, at any level, whose text starts with the
 *   decision's ID followed by the end of the heading, whitespace, `:`, `)`, an
 *   em or en dash, or `.` and then whitespace — `## D3. Entropy-coded AC` and
 *   `### D3 — Entropy-coded AC` are decision `D3`; `## D3.1 …` is not.
 * - Its section runs to the next heading of the same or a higher level.
 * - The section holds exactly one status line (`Status: frozen`, bold or
 *   not, optionally a list item). Its first word, lowercased, is the status.
 *
 * Anything else — no such heading, two of them, no status line, two status
 * lines — is reported rather than guessed at: a gate that opens on an
 * ambiguous register is not a gate.
 */
export function registerStatus(
  text: string,
  decision: string,
): { status: string } | { error: string } {
  const headingAt = new RegExp(
    `^(#{1,6})\\s+${escapeRegExp(decision)}(?=$|[\\s:)\\u2013\\u2014]|\\.(?:\\s|$))`,
  );
  const lines = text.split("\n");
  const starts: { index: number; level: number }[] = [];
  lines.forEach((line, index) => {
    const m = headingAt.exec(line);
    if (m?.[1] !== undefined) starts.push({ index, level: m[1].length });
  });
  if (starts.length === 0) {
    return { error: `records no decision headed "${decision}"` };
  }
  const first = starts[0];
  if (starts.length > 1 || first === undefined) {
    return {
      error: `heads decision "${decision}" ${starts.length} times (lines ${starts.map((s) => s.index + 1).join(", ")})`,
    };
  }
  const statuses: string[] = [];
  let fenced = false;
  for (let i = first.index + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading?.[1] !== undefined && heading[1].length <= first.level) break;
    const m = STATUS_LINE.exec(line);
    if (m?.[1] !== undefined) statuses.push(m[1].toLowerCase());
  }
  const only = statuses[0];
  if (statuses.length !== 1 || only === undefined) {
    return {
      error: `gives decision "${decision}" ${statuses.length} status lines (${statuses.join(", ") || "none"}); it must give exactly one`,
    };
  }
  return { status: only };
}

/**
 * The gate. Throws unless `decision` names a decision the register records
 * as `frozen`: criteria approved, not yet answered. `open` or `draft` has no
 * approved criterion for a result to be judged against; `decided` has already
 * been answered, so reading the split for it again is a second look.
 *
 * @param registerPath Overridable only so the self-test can drive the gate
 *   against a fixture; every tool reads {@link DECISION_REGISTER}.
 */
export function openHoldout2(
  decision: string | undefined,
  registerPath: string = DECISION_REGISTER,
): Holdout2Opening {
  const where = path
    .relative(REPO_ROOT, registerPath)
    .split(path.sep)
    .join("/");
  if (decision === undefined || decision === "") {
    throw new Error(
      `--split holdout2 needs --decision <ID>: the sealed holdout opens only for one decision ${where} records as frozen`,
    );
  }
  if (!DECISION_ID.test(decision)) {
    throw new Error(
      `--decision "${decision}" is not a decision ID (a letter, then letters, digits, ".", "_" or "-")`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(registerPath);
  } catch {
    throw new Error(
      `holdout2 is sealed: ${where} does not exist, so no decision is frozen (the register is #77)`,
    );
  }
  const found = registerStatus(bytes.toString("utf8"), decision);
  if ("error" in found) {
    throw new Error(`holdout2 is sealed: ${where} ${found.error}`);
  }
  if (found.status !== "frozen") {
    throw new Error(
      `holdout2 is sealed: ${where} records decision "${decision}" as "${found.status}", and only a frozen decision opens it`,
    );
  }
  return {
    decision,
    register: where,
    registerSha256: sha256(bytes),
  };
}

/**
 * Refuse to overwrite a committed holdout2 result. The split is read once per
 * question: a second run under the same name, after the first has been seen,
 * is the forking path the seal exists to close. A result that has to be
 * re-read is a new, named run, and the document says why.
 */
export function assertHoldout2Unread(resultFile: string): void {
  if (existsSync(resultFile)) {
    throw new Error(
      `${path.relative(REPO_ROOT, resultFile)} already holds a holdout2 reading; the sealed split is read once per question, so a re-read needs a new name and a reason recorded in spec/EXPERIMENTS.md`,
    );
  }
}

/**
 * The holdout2 pins, after checking that the prefix and the declared split
 * agree. `splitFor` seals by the `sealed-` prefix, so a holdout2 pin without
 * it would be scored as tune by every other loader, and a `sealed-` image
 * declared anything else would be sealed without the table saying so.
 */
export function holdout2Specs(
  images: readonly NaturalImageSpec[] = CURATED_IMAGES,
): NaturalImageSpec[] {
  const mismatched = images.filter(
    (s) => (s.split === "holdout2") !== s.label.startsWith(HOLDOUT2_PREFIX),
  );
  if (mismatched.length > 0) {
    throw new Error(
      `every holdout2 pin, and only a holdout2 pin, is labelled "${HOLDOUT2_PREFIX}*"; these are not: ${mismatched.map((s) => `${s.label} (${s.split})`).join(", ")}`,
    );
  }
  return images.filter((s) => s.split === "holdout2");
}

/**
 * Ensure the sealed holdout2 images are present and content-pinned. Takes the
 * gate's {@link Holdout2Opening}, so the only way to fetch them is through
 * {@link openHoldout2}. Throws when the split has no pinned image, rather than
 * letting a run score an empty holdout and report it as one.
 */
export async function ensureHoldout2Images(
  opening: Holdout2Opening,
  images: readonly NaturalImageSpec[] = CURATED_IMAGES,
): Promise<string[]> {
  const specs = holdout2Specs(images);
  if (specs.length === 0) {
    throw new Error(
      `holdout2 has no pinned images yet: its candidate list awaits approval before anything is pinned (#103), so decision "${opening.decision}" cannot be read against it`,
    );
  }
  const paths: string[] = [];
  let downloadCount = 0;
  for (const spec of specs) {
    const filePath = naturalImagePath(spec);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (
      await ensurePinnedFixture({
        filePath,
        urls: spec.urls,
        sha256: spec.sha256,
        label: spec.label,
      })
    ) {
      downloadCount++;
    }
    paths.push(filePath);
  }
  if (downloadCount > 0) {
    console.log(`Downloaded ${downloadCount} holdout2 image(s)`);
  }
  console.log(
    `holdout2 opened for decision "${opening.decision}" (${opening.register} sha256 ${opening.registerSha256.slice(0, 12)})`,
  );
  return paths;
}
