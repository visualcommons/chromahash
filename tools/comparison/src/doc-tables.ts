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

/** Parse a doc cell like "**10.100**", "−0.81%", "8.57 @32 px", "—". */
export function parseCell(raw: string): number | null {
  const cleaned = raw
    .replace(/[*`]/g, "")
    .replace(/[−–—]/g, "-")
    .replace(/%/g, "")
    .replace(/@.*$/, "")
    .replace(/\s*B$/i, "")
    .trim();
  if (cleaned === "" || cleaned === "-" || cleaned.toLowerCase() === "n/a") {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Decimals shown, so a tolerance can match the precision the doc claims. */
export function decimals(raw: string): number {
  const m = /\.(\d+)/.exec(raw.replace(/[*`]/g, ""));
  return m?.[1]?.length ?? 0;
}
