/**
 * Markdown table parsing, shared by the two documentation gates.
 *
 * `verify-experiments.ts` checks `spec/EXPERIMENTS.md`'s tables against the
 * sweep output that produced them. `verify-claims.ts` checks the *other* files
 * — `README.md`, `spec/README.md`, `spec/RATIONALE.md`, `rust/src/constants.rs`
 * — against those same tables. Both have to read a table the same way, and a
 * second copy of this parser would be a place for the two gates to disagree
 * about what a document says, which is the failure mode they exist to prevent.
 */

/** One markdown table, addressed by the section heading it sits under. */
export interface DocTable {
  /** Section heading the table sits under, e.g. "11.5" or "1". */
  section: string;
  /** Index of this table within its section, 0-based. */
  index: number;
  /** Line of the header row in the document, for error messages. */
  line: number;
  header: string[];
  rows: string[][];
}

/** Split a markdown table row into trimmed cells, dropping the outer pipes. */
export function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isSeparator = (line: string): boolean =>
  /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-");

export function parseTables(markdown: string): DocTable[] {
  const lines = markdown.split("\n");
  const tables: DocTable[] = [];
  let section = "0";
  let indexInSection = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const heading = /^#{2,3}\s+([0-9]+(?:\.[0-9]+)?)[.\s]/.exec(line);
    if (heading?.[1]) {
      section = heading[1];
      indexInSection = 0;
      continue;
    }

    if (!line.trimStart().startsWith("|")) continue;
    if (!isSeparator(lines[i + 1] ?? "")) continue;

    const header = cells(line);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const body = lines[j] ?? "";
      if (!body.trimStart().startsWith("|")) break;
      rows.push(cells(body));
    }
    tables.push({
      section,
      index: indexInSection++,
      line: i + 1,
      header,
      rows,
    });
    i = j - 1;
  }
  return tables;
}

/**
 * Parse a doc cell like "**10.100**", "−0.81%", "8.57 @32 px", "—".
 *
 * A trailing prose clause is dropped, whether it follows a comma
 * ("**−16.19%**, every guard improving") or sits in parentheses
 * ("−14.48% (worse than without)"), so a verdict cell yields its figure rather
 * than nothing.
 *
 * The parenthesised form is dropped *only when the parenthesis holds no
 * digits*, and that restriction is the whole of its safety. "10.855 (−2.78%)"
 * is a score **and** a delta — two claims in one cell — and taking the first
 * would quietly discard the second, which is the trap `verify-claims` already
 * refuses to fall into: its `cellPattern`/`PARENTHESISED_DELTA` exist so a
 * claim on such a cell has to say which of the two figures it quotes. A parser
 * that guessed here would be making that choice for every caller, invisibly.
 *
 * A cell this still refuses is not lost. `verify-experiments` counts every cell
 * in a bound column that fails to parse and lists it (`--list-unparsed`),
 * because a bound column full of unparseable cells checks nothing while
 * reporting as bound — the same class of invisible gap that
 * `--list-unbound-columns` exists to expose, one level further down.
 */
export function parseCell(raw: string): number | null {
  const cleaned = raw
    .replace(/[*`]/g, "")
    .replace(/[−–—]/g, "-")
    .replace(/%/g, "")
    .replace(/@.*$/, "")
    .replace(/^(\s*[-+]?[0-9.]+)\s*,.*$/, "$1")
    // Anchored at both ends, and digit-free inside the parenthesis, so this can
    // only turn a cell that parsed to nothing into a number — never change a
    // number a caller already gets.
    .replace(/^(\s*[-+]?[0-9.]+)\s*\([^0-9()]*\)\s*$/, "$1")
    // The same shape, but where the parenthesis holds the delta rather than a
    // word: "10.855 (-2.78)" after the % above is stripped. The leading number
    // is the score the column publishes and the parenthesis restates it against
    // that section's incumbent, so taking the score is not a choice between two
    // candidate values — the delta is a second column's worth of information
    // that happens to be printed in the same cell. Kept separate from the rule
    // above because this one *can* see digits, so it is anchored to a single
    // signed number and nothing else: "11.4 (see 7.2)" and "11.4 (1.2, 3.4)"
    // both still parse to nothing rather than silently to 11.4.
    .replace(/^(\s*[-+]?[0-9.]+)\s*\(\s*[-+]?[0-9.]+\s*\)\s*$/, "$1")
    .replace(/\s*B$/i, "")
    .trim();
  if (cleaned === "" || cleaned === "-" || cleaned.toLowerCase() === "n/a") {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Put a corrected value into a cell without disturbing anything else about it:
 * the document uses bold to mark winners, a unicode minus, an explicit plus on
 * signed columns, and trailing units, and all of that is meaning, not
 * formatting noise.
 *
 * `docUsesUnicodeMinus` is the document's minus convention, not the cell's.
 * Reading it from the cell alone gets it wrong in exactly the case that
 * matters: a cell whose old value was positive has no minus to copy, so a
 * newly-negative measurement lands as an ASCII hyphen among unicode ones.
 *
 * Here rather than in `verify-experiments.ts` because that file is a script
 * that runs on import, and the self-test has to reach this without running it.
 */
export function rewriteCell(
  raw: string,
  measured: string,
  docUsesUnicodeMinus: boolean,
): string {
  // A bare number that rounds to zero carries no direction, so it is written
  // unsigned. `toFixed` keeps the sign of a small negative (`-0.0004` gives
  // `-0.000`), which the minus convention below would turn into `−0.000`.
  const value =
    /^[-+][0-9.]+$/.test(measured) && Number(measured) === 0
      ? measured.slice(1)
      : measured;
  const trimmed = raw.trim();
  // A leading bold span is rewritten inside, and whatever follows it is kept.
  // Treating a cell as bold only when it both starts and ends with `**` read
  // §4.2's `**11.458** (−1.7%)` as plain, stripped its opening marker, and
  // took `** (−1.7%)` for the unit, leaving `11.457** (−1.7%)` (#109).
  const span = /^\*\*(.+?)\*\*(.*)$/s.exec(trimmed);
  const body = span?.[1] ?? trimmed;
  const tail = span?.[2] ?? "";
  const usesUnicodeMinus = trimmed.includes("−") || docUsesUnicodeMinus;
  let next = value;
  if (usesUnicodeMinus) next = next.replace(/^-/, "−");
  // Preserve a trailing unit or annotation ("%", " B", " @32 px", "pp") — but
  // only when the measured value is a bare number. A composite value already
  // carries what this regex reads as a suffix: on a win count the "unit" is
  // `/31`, so appending it to `16/31` produced `16/31/31`. That stayed hidden
  // while every win count happened to agree, and surfaced the first time one
  // did not.
  const suffix = /^[-−+]?[0-9.]+(.*)$/.exec(body)?.[1] ?? "";
  if (/^[-−+]?[0-9.]+$/.test(value)) {
    // A measured value arrives unsigned when positive. Where the old cell
    // wrote its sign, the column is a signed one, so the `+` stays: dropping
    // it left §7.11, §12.2 and §13.2 mixing signed and unsigned values (#109).
    if (body.startsWith("+") && /^[0-9.]/.test(value) && Number(value) > 0) {
      next = `+${next}`;
    }
    next += suffix;
  } else if (usesUnicodeMinus) next = value.replace(/-/g, "−");
  return span ? `**${next}**${tail}` : next;
}

/** Decimals shown, so a tolerance can match the precision the doc claims. */
export function decimals(raw: string): number {
  const m = /\.(\d+)/.exec(raw.replace(/[*`]/g, ""));
  return m?.[1]?.length ?? 0;
}
