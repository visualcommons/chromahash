/**
 * Write `results/counts/overhead.md` from the committed overhead and
 * reduction records (`overhead-core.ts`), or with `--check` fail if the
 * committed table differs from what the records give. `mise run
 * benchmark:overhead` runs it after recording; `verify:claims` runs the check.
 *
 *   node dist/perf/overhead-table.js [--check]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { AB_COUNTS_DIR, type CountsRecord } from "./counts-core.ts";
import { OVERHEAD_TABLE, renderOverheadTable } from "./overhead-core.ts";
import { ROOT } from "./targets.ts";

const read = (record: string): CountsRecord =>
  JSON.parse(readFileSync(path.join(AB_COUNTS_DIR, record), "utf8"));

const table = renderOverheadTable(read);
const out = path.join(ROOT, OVERHEAD_TABLE);

if (process.argv.includes("--check")) {
  const committed = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (committed !== table) {
    console.error(
      `${OVERHEAD_TABLE} differs from what its records give; regenerate it with \`node tools/comparison/dist/perf/overhead-table.js\``,
    );
    process.exit(1);
  }
  console.error(`${OVERHEAD_TABLE} matches its records`);
} else {
  writeFileSync(out, table);
  console.error(`wrote ${OVERHEAD_TABLE}`);
}
