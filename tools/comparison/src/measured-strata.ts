/**
 * Each image's holdout3 strata, measured off its cached fixture: the strata
 * `stratify --strata` and `reproduce --strata` read a tune or tune2 result
 * through. A holdout3 result reads its pins' recorded strata instead
 * (`register-verdict-core.ts` `holdout3StrataOf`); a tune image has no pin, so
 * its strata are measured with the same covariates and the same
 * `holdout3Strata` rule the draw used.
 *
 * Needs the fixtures on disk, which is why nothing in CI reads it: a run of
 * the sweep fetches them.
 */

import fs from "node:fs/promises";
import { glob } from "node:fs/promises";
import path from "node:path";
import { measureFile } from "./corpus-covariates.ts";
import { holdout3Strata } from "./corpus.ts";
import { realCorpusOf } from "./stratify-core.ts";

export async function measuredStrata(
  names: readonly string[],
): Promise<(name: string) => readonly string[]> {
  const files = new Map<string, string>();
  for await (const f of glob(
    path.join(import.meta.dirname, "../fixtures/**/*.{png,jpg}"),
  )) {
    files.set(path.basename(f).replace(/\.[^.]+$/, ""), f);
  }
  const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const out = new Map<string, readonly string[]>();
  for (const name of names) {
    const f = files.get(name);
    if (!f) {
      console.error(`${name}: no cached fixture to measure — run the sweep`);
      process.exit(1);
    }
    const c = await measureFile(await fs.readFile(f));
    const corpus = realCorpusOf(name);
    if (corpus === null) {
      console.error(`${name}: in no real corpus, so it has no strata`);
      process.exit(1);
    }
    out.set(
      name,
      holdout3Strata({
        corpus,
        width: c.width,
        height: c.height,
        nonOpaqueFraction: round4(c.alpha?.nonOpaqueFraction ?? 0),
        phone: c.phone,
        meanL: round4(c.meanL),
        lowKey: round4(c.lowKey),
        skin: round4(c.skin),
      }),
    );
  }
  return (name) => out.get(name) ?? [];
}
