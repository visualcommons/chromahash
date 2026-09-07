/**
 * Checks the numbers the *rest* of the repo quotes from `spec/EXPERIMENTS.md`.
 *
 * `verify-experiments.ts` closes the loop between the sweeps and the workbench
 * log. It does not close the one after it: `README.md`, `spec/README.md`,
 * `spec/RATIONALE.md` and `rust/src/constants.rs` all restate figures from that
 * log by hand, and nothing has ever checked them. The drift that follows is not
 * hypothetical — it is what the 2026-09 Wikimedia re-baseline left behind, and
 * it is the second time. After it:
 *
 *   - both READMEs put the v0.7 recipe at −3.50% where §7.12 measures −3.72%;
 *   - `README.md` put code 2 at 9.5% over WebP where §11.14 measures 10.8%;
 *   - `spec/README.md` §7.2 quoted −0.43%/−1.8% for the scale search, citing a
 *     section (§7.11) that has never held that figure — the numbers are §4.4's,
 *     and they are −0.30% and −1.04%;
 *   - `spec/README.md` §7.4 attributed the *whole recipe's* holdout delta to the
 *     bit-depth swap alone;
 *   - `rust/src/constants.rs` — where an implementer reads the constants —
 *     priced the optional refinement at −0.6 pp against §7.12's −0.3 pp;
 *   - and both READMEs quoted an equal-quality byte saving §8.3 had retracted.
 *
 * **This gate deliberately checks against the document, not against the
 * sweeps.** The sweeps already gate the document; chaining
 * `sweeps → EXPERIMENTS.md → everything else` gives the same traceability, and
 * buys two things a direct-to-sweep check could not. It needs no sweep output,
 * so unlike `verify:experiments` it can run in CI on every push. And when a
 * figure moves it fails in exactly one place with one fix, rather than in two
 * gates that could disagree about what the document says.
 *
 * The register below is written by hand, one entry per quoted figure, and that
 * is the point: a green run means "every *registered* claim traces to a cell",
 * never "every claim in the repo is true". A figure nobody registers is a figure
 * nobody checks, which is why `--list` prints the register and why adding a
 * number to a gated file should mean adding a line here.
 *
 * Usage:
 *   node dist/verify-claims.js          # check every registered claim
 *   node dist/verify-claims.js --list   # print the register and exit
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type DocTable,
  decimals,
  parseCell,
  parseTables,
} from "./doc-tables.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SOURCE = path.join(REPO_ROOT, "spec/EXPERIMENTS.md");

/**
 * One claim: a number quoted in `file`, and the `EXPERIMENTS.md` cell it comes
 * from.
 *
 * `pattern` must capture the quoted number in group 1 and must match exactly
 * once in the file — a pattern that matches twice is ambiguous about which
 * occurrence is being checked, and one that matches zero times is a claim that
 * has been edited out from under its own binding. Both are failures.
 */
interface Claim {
  /** Repo-relative path of the file doing the quoting. */
  file: string;
  /** What the number is, for the failure message. */
  what: string;
  /** Matches the quoted figure, capturing it in group 1. */
  pattern: RegExp;
  /** `EXPERIMENTS.md` section holding the authoritative cell, e.g. "7.12". */
  section: string;
  /** Index of the table within that section, 0-based. Defaults to 0. */
  table?: number;
  /** Leading cell of the row, matched after stripping `*` and backticks. */
  row: string;
  /** Header of the column. */
  column: string;
  /**
   * Extracts the figure from the raw cell when the cell holds more than one —
   * §4.2's "11.546 (−0.9%)" is a score *and* a delta, and a claim has to say
   * which of the two it quotes. Group 1 is the number. Without this the whole
   * cell goes through `parseCell`.
   */
  cellPattern?: RegExp;
  /**
   * The quoted number as a function of the cell's, for the cases where the two
   * are not literally equal — a sign flip ("worth 3.72%" for a −3.72% cell), or
   * a magnitude ("2.09% better" for a −2.09% delta). Defaults to identity.
   */
  transform?: (cell: number) => number;
}

const abs = (n: number): number => Math.abs(n);

/** The delta inside a cell like "11.546 (−0.9%)". */
const PARENTHESISED_DELTA = /\(([−–—-]?[\d.]+)%\)/;

const REGISTER: Claim[] = [
  // ── The v0.7 recipe's holdout verdict ────────────────────────────────────
  // Quoted in three places plus the Rust doc comment. §7.12's `L28C15 stack`
  // row is the source for all four.
  {
    file: "README.md",
    what: "the v0.7 recipe on holdout",
    pattern:
      /worth \*\*−([\d.]+)% mean ΔE00\*\* at the default tier on a never-tuned holdout/,
    section: "7.12",
    row: "**L28C15 stack**",
    column: "Δ%",
    transform: abs,
  },
  {
    file: "spec/README.md",
    what: "the v0.7 recipe on holdout",
    pattern: /changes above are worth \*\*−([\d.]+)% mean\nΔE00\*\*/,
    section: "7.12",
    row: "**L28C15 stack**",
    column: "Δ%",
    transform: abs,
  },
  {
    file: "spec/RATIONALE.md",
    what: "the v0.7 recipe on holdout",
    pattern: /clears it as a whole \(−([\d.]+)% holdout/,
    section: "7.12",
    row: "**L28C15 stack**",
    column: "Δ%",
    transform: abs,
  },
  {
    file: "rust/src/constants.rs",
    what: "the v0.7 recipe on holdout",
    pattern: /never-tuned holdout split at\n\s*\/\/\/ −([\d.]+)% mean ΔE00/,
    section: "7.12",
    row: "**L28C15 stack**",
    column: "Δ%",
    transform: abs,
  },

  // ── The alpha allocation ─────────────────────────────────────────────────
  // Quoted in three files. Its source table, §11.12's alpha holdout, was
  // unbound until the 2026-09 audit, and its sweep had drifted so far it no
  // longer reproduced the figure: the incumbent labelled `SHIPPED A5@4` set no
  // alpha AC knobs, inherited the adopted A28@3, and encoded to 40 bytes.
  {
    file: "README.md",
    what: "the alpha allocation on holdout",
    pattern:
      /Worth \*\*−([\d.]+)% mean ΔE00\*\* on a never-tuned alpha holdout/,
    section: "11.12",
    table: 1,
    row: "**A28@3 L22@4 C3@3**",
    column: "holdout",
    transform: abs,
  },
  {
    file: "spec/README.md",
    what: "the alpha allocation on holdout",
    pattern: /Worth \*\*−([\d.]+)% mean ΔE00\*\* on a never-tuned/,
    section: "11.12",
    table: 1,
    row: "**A28@3 L22@4 C3@3**",
    column: "holdout",
    transform: abs,
  },
  {
    file: "spec/RATIONALE.md",
    what: "the alpha allocation on holdout",
    pattern: /−([\d.]+)% mean ΔE00 on a never-tuned alpha holdout/,
    section: "11.12",
    table: 1,
    row: "**A28@3 L22@4 C3@3**",
    column: "holdout",
    transform: abs,
  },

  // ── Cross-format positioning ─────────────────────────────────────────────
  {
    file: "README.md",
    what: "code 2 against size-matched WebP",
    pattern: /beats size-matched WebP on ΔE00 by ([\d.]+)%/,
    section: "11.14",
    row: "**108**",
    column: "ΔE00 ↓",
    // §11.14's table carries the absolute score; the README quotes the margin
    // over the 107 B WebP row beside it, which §11.14's prose states as 10.8%.
    // Bound to the prose figure rather than recomputed here: recomputing a
    // ratio the source section already states would be a second derivation to
    // keep in step with the first.
    transform: (t2) => {
      const webp = cellOf("11.14", 0, "107.0", "ΔE00 ↓");
      if (webp === null) throw new Error("§11.14 has no 107.0 B WebP row");
      return ((webp - t2) / webp) * 100;
    },
  },

  // ── The AC bit-depth trade, §7.4 of the spec ─────────────────────────────
  {
    file: "spec/README.md",
    what: "the 4-bit layout on holdout",
    pattern: /beat 26 at 5 by \*\*([\d.]+)% mean ΔE00\*\* on the never-tuned/,
    section: "4.5",
    row: "L28@4 C15@3",
    column: "Δ%",
    transform: abs,
  },
  {
    file: "spec/README.md",
    what: "the 4-bit layout on tune",
    pattern: /on tune it is\n([\d.]+)%, §4\.2/,
    section: "4.2",
    row: "L28@4 C15@3",
    column: "32 B ΔE00",
    // "11.546 (−0.9%)" — the delta is already in the cell, so take it rather
    // than recompute it against the shipped row.
    cellPattern: PARENTHESISED_DELTA,
    transform: abs,
  },

  // ── The encoder-only scale search, §7.2 of the spec ──────────────────────
  {
    file: "spec/README.md",
    what: "the AC scale search at 32 B",
    pattern: /is worth −([\d.]+)% mean ΔE00 at 32 bytes/,
    section: "4.4",
    row: "32 B",
    column: "fit2 + nearest",
    cellPattern: PARENTHESISED_DELTA,
    transform: abs,
  },
  {
    file: "spec/README.md",
    what: "the AC scale search at 411 B",
    pattern: /at 32 bytes and −([\d.]+)% at 411/,
    section: "4.4",
    row: "411 B",
    column: "fit2 + nearest",
    cellPattern: PARENTHESISED_DELTA,
    transform: abs,
  },
];

// ─── Resolving a cell ───────────────────────────────────────────────────────

const tables: DocTable[] = parseTables(readFileSync(SOURCE, "utf8"));

const strip = (s: string): string => s.replace(/[*`]/g, "").trim();

function tableOf(section: string, index: number): DocTable | undefined {
  return tables.find((t) => t.section === section && t.index === index);
}

/** The raw cell text at (section, table, row, column), or null if absent. */
function rawCellOf(
  section: string,
  index: number,
  row: string,
  column: string,
): string | null {
  const t = tableOf(section, index);
  if (!t) return null;
  const col = t.header.findIndex((h) => strip(h) === strip(column));
  if (col < 0) return null;
  const r = t.rows.find((cs) => strip(cs[0] ?? "") === strip(row));
  return r?.[col] ?? null;
}

function cellOf(
  section: string,
  index: number,
  row: string,
  column: string,
): number | null {
  const raw = rawCellOf(section, index, row, column);
  return raw === null ? null : parseCell(raw);
}

// ─── Checking ───────────────────────────────────────────────────────────────

interface Failure {
  claim: Claim;
  detail: string;
}

const { values } = parseArgs({
  options: { list: { type: "boolean" }, help: { type: "boolean" } },
});

if (values.help) {
  console.log("usage: verify-claims [--list]");
  process.exit(0);
}

if (values.list) {
  console.log(
    `${REGISTER.length} registered claims, all against spec/EXPERIMENTS.md:\n`,
  );
  for (const c of REGISTER) {
    const where = `§${c.section}${c.table ? `#${c.table}` : ""} "${c.row}" / "${c.column}"`;
    console.log(`  ${c.file}\n    ${c.what} ← ${where}`);
  }
  process.exit(0);
}

const failures: Failure[] = [];
let checked = 0;

const fileCache = new Map<string, string>();
const readFile = (rel: string): string => {
  const hit = fileCache.get(rel);
  if (hit !== undefined) return hit;
  const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
  fileCache.set(rel, text);
  return text;
};

for (const claim of REGISTER) {
  const text = readFile(claim.file);
  const all = [...text.matchAll(new RegExp(claim.pattern, "g"))];

  if (all.length === 0) {
    failures.push({
      claim,
      detail:
        "the claim's pattern matches nothing — the sentence was edited without " +
        "updating its binding here, so the figure is no longer checked",
    });
    continue;
  }
  if (all.length > 1) {
    failures.push({
      claim,
      detail: `the claim's pattern matches ${all.length} times; it must name one figure`,
    });
    continue;
  }

  const quotedRaw = all[0]?.[1] ?? "";
  const quoted = Number(quotedRaw);

  const raw = rawCellOf(
    claim.section,
    claim.table ?? 0,
    claim.row,
    claim.column,
  );
  if (raw === null) {
    failures.push({
      claim,
      detail: `§${claim.section} has no cell at row "${claim.row}", column "${claim.column}"`,
    });
    continue;
  }
  let cell: number | null;
  if (claim.cellPattern) {
    const m = claim.cellPattern.exec(raw);
    cell = m?.[1] === undefined ? null : parseCell(m[1]);
    if (cell === null) {
      failures.push({
        claim,
        detail: `§${claim.section}'s cell "${raw}" carries no figure matching ${claim.cellPattern}`,
      });
      continue;
    }
  } else {
    cell = parseCell(raw);
    if (cell === null) {
      failures.push({
        claim,
        detail: `§${claim.section}'s cell "${raw}" is not a number`,
      });
      continue;
    }
  }

  let expected: number;
  try {
    expected = claim.transform ? claim.transform(cell) : cell;
  } catch (e) {
    failures.push({ claim, detail: (e as Error).message });
    continue;
  }

  // Tolerance is the precision the *quoting* file claims, so tightening a
  // figure there tightens the assertion, exactly as in verify-experiments.
  const places = decimals(quotedRaw);
  const tol = 0.5 * 10 ** -places;
  checked++;

  if (Math.abs(expected - quoted) > tol) {
    failures.push({
      claim,
      detail:
        `quotes ${quotedRaw}, but §${claim.section} "${claim.row}" / "${claim.column}" ` +
        `gives ${expected.toFixed(Math.max(places, 2))} (cell: ${raw})`,
    });
  }
}

if (failures.length > 0) {
  console.error(
    `${failures.length} claim(s) disagree with spec/EXPERIMENTS.md:\n`,
  );
  for (const f of failures) {
    console.error(`  ${f.claim.file} — ${f.claim.what}`);
    console.error(`    ${f.detail}\n`);
  }
  console.error(
    "Fix the quoting file, or — if EXPERIMENTS.md is the thing that is wrong —\n" +
      "run `mise run verify:experiments` first: this gate trusts that document,\n" +
      "which is only sound because that one checks it against the sweeps.",
  );
  process.exit(1);
}

console.log(
  `Checked ${checked} quoted figure(s) across ` +
    `${new Set(REGISTER.map((c) => c.file)).size} files against spec/EXPERIMENTS.md.`,
);
console.log("\nEvery registered claim agrees with the section it cites.");
