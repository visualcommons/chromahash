/**
 * The table-level half of `verify-experiments.ts`'s register audit, as a pure
 * function over the document's tables and the two registers, so
 * `metric-selftest.ts` can hold each failure branch to a fixture.
 * `verify-experiments.ts` runs top-level code on import and so cannot be
 * imported by a test; its own run over the committed document exercises only
 * the state that document is in, where every one of these branches is silent.
 */

/** The parts of a `DocTable` the audit reads. */
export interface RegisterTable {
  section: string;
  index: number;
  line: number;
  header: string[];
}

export interface TableRegisterInput {
  /** Every table in the document. */
  tables: readonly RegisterTable[];
  /** `section#table` of every table some binding checks. */
  bound: ReadonlySet<string>;
  /** Why a table carries no binding, by `section#table`. */
  unboundNotes: Readonly<Record<string, string>>;
  /** The cells each bound table is asserted to check, by `section#table`. */
  expectedCells: Readonly<Record<string, number>>;
  /** The cells each table actually checked this run, by `section#table`. */
  checkedByTable: ReadonlyMap<string, number>;
  /**
   * Tables at least one of whose bindings was skipped. Their count is
   * incomplete by definition and is reported as a SKIP instead, so it is not
   * held to `expectedCells` here.
   */
  skippedTables: ReadonlySet<string>;
}

/**
 * Every table-level register problem: a note that explains nothing, a table
 * with neither a binding nor a note, and a bound table whose checked-cell
 * count differs from the one asserted for it (or has none asserted).
 */
export function tableRegisterProblems(input: TableRegisterInput): string[] {
  const {
    tables,
    bound,
    unboundNotes,
    expectedCells,
    checkedByTable,
    skippedTables,
  } = input;
  const problems: string[] = [];

  const inDocument = new Set(tables.map((t) => `${t.section}#${t.index}`));
  for (const key of Object.keys(unboundNotes)) {
    if (bound.has(key)) {
      problems.push(
        `UNBOUND_NOTES["${key}"] explains nothing: that table is bound, so an unchecked column of it belongs in UNBOUND_COLUMN_NOTES`,
      );
    } else if (!inDocument.has(key)) {
      problems.push(
        `UNBOUND_NOTES["${key}"] explains nothing: the document has no such table (renumbered or removed?)`,
      );
    }
  }
  // The table-level twin of the PARTIAL rule. A table with neither a binding
  // nor a note is exactly as silent as an undeclared column was, one level up:
  // §8.3 and §12.4 quoted measured figures that nothing checked and nothing
  // said were unchecked.
  for (const t of tables) {
    const key = `${t.section}#${t.index}`;
    if (bound.has(key) || unboundNotes[key] !== undefined) continue;
    problems.push(
      `§${t.section} table ${t.index} (line ${t.line}, "${t.header.join(" | ")}"): no binding and no UNBOUND_NOTES entry`,
    );
  }

  // The asserted count.
  for (const key of Object.keys(expectedCells)) {
    if (!bound.has(key)) {
      problems.push(
        `EXPECTED_CELLS["${key}"] asserts cells for a table no binding checks`,
      );
    }
  }
  for (const key of bound) {
    if (skippedTables.has(key)) continue;
    const got = checkedByTable.get(key) ?? 0;
    const want = expectedCells[key];
    if (want === undefined) {
      problems.push(
        `§${key.replace("#", " table ")}: checked ${got} cell(s) with no EXPECTED_CELLS entry to hold them to`,
      );
    } else if (got !== want) {
      problems.push(
        `§${key.replace("#", " table ")}: checked ${got} cell(s), EXPECTED_CELLS asserts ${want}`,
      );
    }
  }
  return problems;
}
