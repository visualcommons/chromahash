/**
 * Checks the numbers the *rest* of the repo quotes from `spec/EXPERIMENTS.md`.
 *
 * `verify-experiments.ts` closes the loop between the sweeps and the workbench
 * log. It does not close the one after it: `README.md`, `spec/README.md`,
 * `spec/RATIONALE.md`, `rust/src/constants.rs` and `spec/constants.py` all
 * restate figures from that log by hand, and nothing has ever checked them. The
 * drift that follows is not hypothetical — it is what the 2026-09 Wikimedia
 * re-baseline left behind, and it is the second time. After it:
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
 * `spec/constants.py` was outside all of that — absent from this register and
 * from `ci-comparison.yml`'s path filter alike, so its copy of the layout
 * comment could say anything and no gate would run, let alone object.
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
 * nobody checks, which is why `--list` prints the register, and why adding a
 * number to a gated file should mean adding a line here.
 *
 * "Should" was doing too much work there: for as long as that was only prose,
 * four figures were quoted into gated files without a line here, and drifting
 * two of them left this gate at exit 0. The scan after the register enforces it
 * instead — but only over the shapes the register is written in, which is a
 * narrower promise than the sentence above. What it does and does not catch is
 * set out where it is defined.
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

/**
 * The delta inside a cell like "11.546 (−0.9%)" — or "9.913 (+2.0%)", because
 * §4.2's two columns put the same allocation on opposite sides of zero and the
 * spec quotes both. The sign is inside the capture rather than dropped: a claim
 * bound to the 108 B column is quoting a regression, and reading it unsigned
 * would let a "+2.0%" quote agree with a "−2.0%" cell.
 */
const PARENTHESISED_DELTA = /\(([+−–—-]?[\d.]+)%\)/;

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

  // ── Two figures that are differences of §7.12's rows, not rows ───────────
  // Both price one ingredient against the recipe as a whole, and are quoted in
  // percentage *points* for that reason: §7.12 measures the recipe and each
  // variation of it as separate rows against one shared 32 B incumbent, so what
  // an ingredient is "worth" is the gap between two of those rows. Neither
  // figure is a cell. Each therefore binds to the row it is *about* and fetches
  // the row it is measured against, the same shape §11.14's margin uses below.
  {
    file: "rust/src/constants.rs",
    what: "the optional refinement, over the default recipe",
    pattern: /worth a further −([\d.]+) pp at the default tier/,
    section: "7.12",
    row: "**L28C15 stack + REFINE**",
    column: "Δ%",
    // Both rows are negative deltas against the same incumbent, so the pp is
    // the gap between their magnitudes — 4.01 − 3.72 — and not a ratio.
    //
    // The Δ% column is rounded to two places and that is enough here, where the
    // quote carries one: differencing the ΔE00 scores behind those deltas
    // instead ((11.298 − 11.265) / 11.735) gives 0.281 rather than 0.290, and
    // both are inside the 0.05 that one decimal place buys. The claim below is
    // the one where that is not true.
    transform: (refine) => {
      const stack = cellOf("7.12", 0, "**L28C15 stack**", "Δ%");
      if (stack === null) throw new Error("§7.12 has no L28C15 stack row");
      return abs(refine) - abs(stack);
    },
  },
  {
    file: "spec/RATIONALE.md",
    what: "the selection weights' share of the v0.7 recipe",
    pattern: /and is worth −([\d.]+) pp of that/,
    section: "7.12",
    row: "**L28C15 stack**",
    column: "ΔE00",
    // The ingredient here is the `sel_hv` term, which §7.12 isolates by holding
    // everything else in the stack fixed and setting `hv = 0`. So the bound
    // cell is the shipped stack's score and the fetched one is that variant's.
    //
    // Bound to the ΔE00 columns rather than the Δ% ones because at two quoted
    // places the rounding in Δ% is no longer affordable: −3.72 against −3.37
    // gives 0.35, which misses the quoted 0.36 by twice the tolerance, while
    // the scores those deltas were computed from give 0.358. Recomputing the
    // delta against the incumbent both rows share is the same arithmetic
    // §7.12's own Δ% column does, one rounding step earlier.
    transform: (withHv) => {
      const withoutHv = cellOf("7.12", 0, "L28C15 stack, hv = 0", "ΔE00");
      const base = cellOf("7.12", 0, "shipped", "ΔE00");
      if (withoutHv === null || base === null) {
        throw new Error("§7.12 has no `hv = 0` row or no shipped baseline");
      }
      return ((withoutHv - withHv) / base) * 100;
    },
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

  // The same alpha figure, in the two hand-maintained constant tables. Both
  // restate LAYOUT_T0's alpha row in a comment, so both drift independently of
  // the Rust doc comment above and of each other; `validate:spec` compares the
  // constants those files declare, never the prose around them.
  {
    file: "rust/src/constants.rs",
    what: "the alpha allocation on holdout",
    pattern:
      /is worth −([\d.]+)% mean\n\/\/\/ ΔE00 on the never-tuned alpha holdout/,
    section: "11.12",
    table: 1,
    row: "**A28@3 L22@4 C3@3**",
    column: "holdout",
    transform: abs,
  },
  {
    file: "spec/constants.py",
    what: "the alpha allocation on holdout",
    pattern:
      /is worth −([\d.]+)% mean ΔE00 on the never-tuned alpha\n# holdout/,
    section: "11.12",
    table: 1,
    row: "**A28@3 L22@4 C3@3**",
    column: "holdout",
    transform: abs,
  },

  // ── The 4-bit layout, in the three places that restate it ────────────────
  // §4.5 measures the layout *alone* on holdout at −2.09%. Three files quoted
  // 3.5% here, which is neither: it was the whole v0.7 recipe (§8.3, −3.72%)
  // attributed to one ingredient. `spec/README.md` was corrected by the change
  // that added this register; the Rust doc comment and `RATIONALE.md` were not,
  // and nothing noticed, because neither was registered. They are now.
  {
    file: "rust/src/constants.rs",
    what: "the 4-bit layout on holdout",
    pattern: /by ([\d.]+)% mean ΔE00 on the never-tuned holdout split/,
    section: "4.5",
    row: "L28@4 C15@3",
    column: "Δ%",
    transform: abs,
  },
  {
    file: "spec/constants.py",
    what: "the 4-bit layout on holdout",
    pattern: /split by ([\d.]+)% mean\n# ΔE00 on the never-tuned holdout split/,
    section: "4.5",
    row: "L28@4 C15@3",
    column: "Δ%",
    transform: abs,
  },
  {
    file: "spec/RATIONALE.md",
    what: "the 4-bit layout on holdout",
    pattern: /worth −([\d.]+)% mean ΔE00 on the\nnever-tuned holdout/,
    section: "4.5",
    row: "L28@4 C15@3",
    column: "Δ%",
    transform: abs,
  },
  // The other side of the same trade: §4.2 puts the identical allocation on the
  // wrong side of zero at 108 B, and the spec quotes both numbers in one
  // sentence. Binding only the favourable one would gate half a claim.
  {
    file: "spec/README.md",
    what: "the 4-bit layout at 108 B, against it",
    pattern: /at 108 bytes the same swap is \+([\d.]+)% the \*wrong\* way/,
    section: "4.2",
    row: "L28@4 C15@3",
    column: "108 B ΔE00",
    cellPattern: PARENTHESISED_DELTA,
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
    // Recomputed from the two cells rather than read off §11.14's prose. The
    // prose figure and the table are two statements of one result, and binding
    // to the prose would gate the sentence while leaving the cells it is drawn
    // from unchecked; the cells are what the sweep produces.
    //
    // The cost is rounding headroom: the recomputation lands at 10.839 against
    // a quoted 10.8, and one decimal place buys a tolerance of 0.05 — so 0.039
    // of it is already spent before any drift. That is tight but not wrong,
    // and it is the reason this claim is the one to revisit first if §11.14's
    // scores move. Quoting a second decimal in the README would restore the
    // margin.
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

  // A pattern that matches but captures nothing, or captures something that is
  // not a number, used to reach the comparison anyway: `Number(undefined ?? "")`
  // is 0, and `Number("n/a")` is NaN. Neither is a figure, and the NaN is the
  // dangerous one -- every comparison against NaN is false, so
  // `Math.abs(expected - quoted) > tol` was false, the claim passed, and
  // `checked++` below counted it as verified. A register entry whose capture
  // group drifted off the number would have reported a clean run forever.
  const quotedRaw = all[0]?.[1];
  if (quotedRaw === undefined) {
    failures.push({
      claim,
      detail:
        "the claim's pattern matched but captured nothing — it needs a capture " +
        "group around the figure itself",
    });
    continue;
  }
  const quoted = Number(quotedRaw);
  if (!Number.isFinite(quoted)) {
    failures.push({
      claim,
      detail: `the claim's pattern captured "${quotedRaw}", which is not a number`,
    });
    continue;
  }

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
  // A transform that divides by a zero cell returns Infinity, and one that
  // divides zero by zero returns NaN. Both compare false against everything,
  // so both would pass as agreement rather than fail as nonsense.
  if (!Number.isFinite(expected)) {
    failures.push({
      claim,
      detail: `§${claim.section}'s cell "${raw}" gives ${expected} through this claim's transform, which cannot be compared`,
    });
    continue;
  }

  // Tolerance is the precision the *quoting* file claims, so tightening a
  // figure there tightens the assertion, exactly as in verify-experiments.
  const places = decimals(quotedRaw);
  const tol = 0.5 * 10 ** -places;
  // Position is load-bearing: every path that reaches here has a finite quoted
  // figure and a finite expected one, so the comparison below genuinely runs.
  // Counting earlier is what let an uncomparable claim be reported as checked.
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

/**
 * The register is hand-written, so the gate above can only be as complete as
 * someone remembered to make it. This scan is the part that does not rely on
 * remembering: it reads the gated files back and fails on a figure that looks
 * like one of ours but is bound to nothing.
 *
 * **It is deliberately narrow, and the narrowness is the promise.** It matches
 * two shapes only — a percentage attached to `mean ΔE00`, and a `pp` delta —
 * because those are the shapes every entry in the register is written in, and
 * because they cannot collide with a version string, a byte count, a bit width
 * or a coefficient index. A figure quoted in any *other* shape is still
 * invisible here: `README.md`'s WebP margin is registered above but would not
 * be caught by this scan if it were dropped. So a green run means "no
 * ΔE00-or-pp figure in a gated file is unregistered", never "every claim in
 * the repo is registered".
 *
 * That is a smaller promise than the sentence at the top of this file, and it
 * is worth having anyway: three of the four figures this scan first flagged
 * were real. Two were the same stale 3.5% — the whole v0.7 recipe misattributed
 * to the layout alone — surviving in `rust/src/constants.rs` and
 * `RATIONALE.md` after the change that corrected it everywhere else, which is
 * exactly the drift the register exists to stop and exactly the drift a
 * hand-written register reproduces when nobody checks it back.
 */
const FIGURE_SHAPES: RegExp[] = [
  // "−3.72% mean ΔE00", including across a comment-continuation newline in the
  // Rust (`/// `) and Python (`# `) constant tables.
  /[+−–—-]?\d+(?:\.\d+)?%\s*mean\s*\n?(?:\/\/\/ |# )?ΔE00/g,
  // "−0.3 pp", the shape used where a figure prices one ingredient against a
  // recipe rather than against an incumbent.
  /[+−–—-]?\d+(?:\.\d+)?\s*pp\b/g,
];

interface Unregistered {
  file: string;
  line: number;
  text: string;
}

const unregistered: Unregistered[] = [];

for (const file of new Set(REGISTER.map((c) => c.file))) {
  const text = readFileSync(path.join(REPO_ROOT, file), "utf8");

  // Where each registered claim for this file actually sits, as a character
  // range. A figure is covered when it falls inside one — matching on position
  // rather than on value, so two claims quoting the same number in the same
  // file cannot cover for one another.
  const covered: Array<[number, number]> = [];
  for (const claim of REGISTER) {
    if (claim.file !== file) continue;
    const m = claim.pattern.exec(text);
    if (m?.index !== undefined) covered.push([m.index, m.index + m[0].length]);
  }

  for (const shape of FIGURE_SHAPES) {
    for (const m of text.matchAll(shape)) {
      const start = m.index;
      const end = start + m[0].length;
      if (covered.some(([lo, hi]) => start < hi && end > lo)) continue;
      unregistered.push({
        file,
        line: text.slice(0, start).split("\n").length,
        text: m[0].replace(/\n(?:\/\/\/ |# )?/, " "),
      });
    }
  }
}

if (unregistered.length > 0) {
  console.error(
    `${unregistered.length} figure(s) in gated files are bound to nothing:\n`,
  );
  for (const u of unregistered) {
    console.error(`  ${u.file}:${u.line} — ${u.text}`);
  }
  console.error(
    "\nEach quotes spec/EXPERIMENTS.md but has no entry in the register above,\n" +
      "so nothing would notice it drifting. Add an entry binding it to the cell\n" +
      "it comes from — or, if it is not an EXPERIMENTS.md figure at all, reword\n" +
      "it so it does not read as one.",
  );
  process.exit(1);
}

console.log(
  `Checked ${checked} quoted figure(s) across ` +
    `${new Set(REGISTER.map((c) => c.file)).size} files against spec/EXPERIMENTS.md.`,
);
console.log("\nEvery registered claim agrees with the section it cites.");
console.log(
  `No unregistered ΔE00 or pp figure in the ${new Set(REGISTER.map((c) => c.file)).size} gated files.`,
);
