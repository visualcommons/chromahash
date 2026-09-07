/**
 * Checks that every sweep arm sets the constants its own label names.
 *
 * `EXPERIMENTS.md` §9.5 names this as "the obvious next thing to build", and
 * says exactly why. A `tune` string is applied on top of `Tunables::DEFAULT`,
 * so an omitted knob inherits whatever ships. That was harmless while the
 * defaults were the pre-v0.7 constants, and stopped being harmless the moment
 * §10 adopted the §8 recipe: after that, **every arm whose label named a
 * pre-adoption constant was measuring the adopted one.**
 *
 * What that cost, from §9.5 and the audit that followed it:
 *
 *   - four arms of `holdout-candidates` returned one bit-identical number --
 *     the sweep was comparing the default against itself;
 *   - `thumbhash-headtohead` printed each plain layout and its own `+stack`
 *     twin as two rows of the twin;
 *   - `encoder-compute`'s control already contained both levers it exists to
 *     measure;
 *   - `final-candidates`'s `hv = 0` arm was `hv = 0.15`;
 *   - and `v07-holdout-alpha`'s incumbent, found later and not in that list,
 *     inherited the adopted alpha allocation, encoded to 40 bytes rather than
 *     32, and made §11.12's source table score the default against itself.
 *
 * Every one of those is the same sentence: *a label naming a constant the run
 * does not set*. That is a property of the config alone, so it is checkable
 * without running anything -- no corpus, no encoder, no sweep output -- which
 * is why this can run in CI where the sweeps themselves cannot.
 *
 * Two kinds of finding, and the second is the one that survives a re-baseline:
 *
 *   - **unset**: the label names a constant no key in the `tune` string writes.
 *     The arm silently means whatever ships today.
 *   - **mismatch**: the label names one value and the `tune` string sets
 *     another. `alt A16@4` setting `alpha_ac_count=16` without
 *     `alpha_ac_bits=4` was one of these.
 *
 * A config may opt out with `unpinnedLabels`, which takes a reason rather than
 * a boolean: §9.5 leaves nine configs unpinned on purpose, because relabelling
 * moves no number and would change the row keys `verify-experiments.ts` matches
 * on. An opt-out with a reason is a disclosure; one without is a silence.
 *
 * Usage:
 *   node dist/verify-sweep-labels.js            # every config
 *   node dist/verify-sweep-labels.js --list     # what each label is read to name
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SWEEP_DIR = path.join(REPO_ROOT, "tools/comparison/sweeps");

/** A constant a label names, canonicalized. */
interface Named {
  /** What the label calls it, for the message. */
  as: string;
  /** Tune keys that would set it, in preference order. */
  keys: string[];
  /** Value the label claims, in the form the tune string writes. */
  value: string;
  /**
   * For the split alpha form, where `alpha_ac_count`/`alpha_ac_bits` together
   * say what a single `a=count:bits` says.
   */
  split?: { count: string; bits: string };
}

/**
 * Read the constants out of a label.
 *
 * The layout forms have two spellings because the format has two layouts: `l1`
 * and `c` are the opaque-mode rows, `la1` and `ca` the alpha-mode ones, and a
 * label writes `L28@4` for either. Which one an arm means is settled by which
 * key it sets, so both are accepted and the arm is asked only to set one of
 * them.
 */
function namedConstants(label: string): Named[] {
  const out: Named[] = [];
  const push = (
    as: string,
    keys: string[],
    value: string,
    split?: Named["split"],
  ) => out.push({ as, keys, value, ...(split ? { split } : {}) });

  for (const m of label.matchAll(/\bL\s?(\d+)\s?@\s?(\d+)/g)) {
    push(`L${m[1]}@${m[2]}`, ["l1", "la1"], `${m[1]}:${m[2]}`);
  }
  for (const m of label.matchAll(/(?<![A-Za-z])C\s?(\d+)\s?@\s?(\d+)/g)) {
    push(`C${m[1]}@${m[2]}`, ["c", "ca"], `${m[1]}:${m[2]}`);
  }
  for (const m of label.matchAll(/(?<![A-Za-z])A\s?(\d+)\s?@\s?(\d+)/g)) {
    push(`A${m[1]}@${m[2]}`, ["a"], `${m[1]}:${m[2]}`, {
      count: m[1] ?? "",
      bits: m[2] ?? "",
    });
  }
  // "L28C15" — counts only, no bit widths.
  for (const m of label.matchAll(/\bL(\d+)C(\d+)\b/g)) {
    push(`L${m[1]} (count)`, ["l1", "la1"], `${m[1]}:`, undefined);
    push(`C${m[2]} (count)`, ["c", "ca"], `${m[2]}:`, undefined);
  }
  for (const m of label.matchAll(/aniso\s*=?\s*(-?[\d.]+)/g)) {
    push(`aniso=${m[1]}`, ["aniso"], m[1] ?? "");
  }
  for (const m of label.matchAll(/\bhv\s*=?\s*([+-]?[\d.]+)/g)) {
    push(`hv=${m[1]}`, ["sel_hv"], m[1] ?? "");
  }
  for (const m of label.matchAll(/scale_fit\s*=?\s*(\d+)/g)) {
    push(`scale_fit=${m[1]}`, ["scale_fit"], m[1] ?? "");
  }
  for (const m of label.matchAll(/ac_nearest\s*=?\s*(\d+)/g)) {
    push(`ac_nearest=${m[1]}`, ["ac_nearest"], m[1] ?? "");
  }
  for (const m of label.matchAll(/\bmu_l\s*=?\s*([\d.]+)/g)) {
    push(`mu_l=${m[1]}`, ["mu_l"], m[1] ?? "");
  }
  for (const m of label.matchAll(/\bmu_c\s*=?\s*([\d.]+)/g)) {
    push(`mu_c=${m[1]}`, ["mu_c"], m[1] ?? "");
  }
  return out;
}

const numeric = (v: string): number | string => {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

/** `l1=28:4 c=15:3` → { l1: "28:4", c: "15:3" }. */
function tuneKeys(tune: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of tune.split(/\s+/)) {
    const at = kv.indexOf("=");
    if (at > 0) out[kv.slice(0, at)] = kv.slice(at + 1);
  }
  return out;
}

interface Finding {
  config: string;
  label: string;
  tune: string;
  problems: string[];
}

function check(label: string, tune: string): string[] {
  const keys = tuneKeys(tune);
  const problems: string[] = [];

  for (const n of namedConstants(label)) {
    const key = n.keys.find((k) => keys[k] !== undefined);

    // `A n@b` has a second spelling: the two halves as their own keys.
    if (key === undefined && n.split) {
      const count = keys.alpha_ac_count;
      const bits = keys.alpha_ac_bits;
      if (count === undefined && bits === undefined) {
        problems.push(`label says ${n.as}, nothing sets it`);
      } else if (count !== n.split.count || bits !== n.split.bits) {
        problems.push(
          `label says ${n.as}, tune sets alpha_ac_count=${count ?? "(unset)"} ` +
            `alpha_ac_bits=${bits ?? "(unset)"}`,
        );
      }
      continue;
    }

    if (key === undefined) {
      problems.push(
        `label says ${n.as}, nothing sets it (so it inherits Tunables::DEFAULT)`,
      );
      continue;
    }

    const got = keys[key] ?? "";
    // A count-only form ("L28C15") constrains the count and says nothing about
    // the bit width, so compare only the half the label actually names.
    const claimed = n.value.endsWith(":") ? n.value.slice(0, -1) : n.value;
    const actual = n.value.endsWith(":") ? (got.split(":")[0] ?? "") : got;
    if (numeric(actual) !== numeric(claimed)) {
      problems.push(`label says ${n.as}, tune sets ${key}=${got}`);
    }
  }
  return problems;
}

// ─── Run ────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: { list: { type: "boolean" }, help: { type: "boolean" } },
});

if (values.help) {
  console.log("usage: verify-sweep-labels [--list]");
  process.exit(0);
}

const files = readdirSync(SWEEP_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

const findings: Finding[] = [];
const disclosed: { config: string; why: string; arms: number }[] = [];
let arms = 0;
let named = 0;

for (const file of files) {
  const raw = JSON.parse(readFileSync(path.join(SWEEP_DIR, file), "utf8")) as {
    variants?: { label: string; tune?: string }[];
    unpinnedLabels?: string;
  };
  const optOut = raw.unpinnedLabels;
  let hits = 0;

  for (const v of raw.variants ?? []) {
    arms++;
    const constants = namedConstants(v.label);
    if (constants.length === 0) continue;
    named++;
    if (values.list) {
      console.log(
        `  ${file}  ${JSON.stringify(v.label)}\n      names ${constants
          .map((c) => c.as)
          .join(", ")}`,
      );
      continue;
    }
    const problems = check(v.label, v.tune ?? "");
    if (problems.length === 0) continue;
    hits++;
    if (!optOut) {
      findings.push({
        config: file,
        label: v.label,
        tune: v.tune ?? "",
        problems,
      });
    }
  }
  if (optOut && hits > 0)
    disclosed.push({ config: file, why: optOut, arms: hits });
}

if (values.list) process.exit(0);

for (const d of disclosed) {
  console.log(
    `  DISCLOSED  ${d.config}: ${d.arms} arm(s) name a constant they do not set\n` +
      `             ${d.why}`,
  );
}

if (findings.length > 0) {
  console.error(
    `\n${findings.length} arm(s) name a constant they do not set:\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.config}  ${JSON.stringify(f.label)}`);
    console.error(`      tune: ${f.tune === "" ? "(none)" : f.tune}`);
    for (const p of f.problems) console.error(`      ${p}`);
    console.error("");
  }
  console.error(
    "A tune string is applied on top of Tunables::DEFAULT, so an omitted knob\n" +
      "inherits whatever ships — which means an arm like this measures something\n" +
      "other than what its label says, and its row in EXPERIMENTS.md is wrong in a\n" +
      "way no number can reveal. Pin the knob, or declare `unpinnedLabels` on the\n" +
      "config with the reason (see EXPERIMENTS.md §9.5).",
  );
  process.exit(1);
}

console.log(
  `Checked ${named} of ${arms} arms across ${files.length} sweep configs (the rest name no constant).`,
);
console.log("\nEvery arm sets the constants its label names.");
