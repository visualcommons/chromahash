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
 * A config may opt out with `unpinnedLabels`, which takes a reason and a count
 * rather than a boolean: §9.5 leaves six configs unpinned on purpose, because
 * relabelling moves no number and would change the row keys
 * `verify-experiments.ts` matches on. An opt-out with a reason is a disclosure;
 * one without is a silence.
 *
 * **The count is what keeps the disclosure from becoming permanent cover.** The
 * opt-out is whole-config, so without one it also excuses every arm added to
 * the config after it was written, and an opt-out whose arms were pinned years
 * ago still reads as a live exemption. So it carries the number of arms it
 * suppresses, and the gate fails if that number is zero (the opt-out excuses
 * nothing and should be deleted) or no longer matches (it is excusing an arm
 * nobody disclosed). That is the same policy `spec/validate.py` applies to its
 * `not_in_parity` register, deliberately: one repository, one rule for a
 * standing exception.
 *
 * The summary separates the two populations rather than adding them. An arm in
 * an exempt config is *named* -- its label states something checkable -- but it
 * is not *checked*, because every finding in its config is discarded. Counting
 * it as checked is the gate over-reporting its own reach.
 *
 * Usage:
 *   node dist/verify-sweep-labels.js            # every config
 *   node dist/verify-sweep-labels.js --list     # what each label is read to name
 *   node dist/verify-sweep-labels.js --list-unnamed   # and what it reads as naming nothing
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
/**
 * Every key `rust/examples/encode_stdin.rs` accepts in a `tune` string.
 *
 * Kept here so the plainest label form there is -- the tune key written out,
 * `deadzone_l=0.02` -- is read as naming the constant it obviously names. It
 * had not been. `namedConstants` recognized ten hand-written token shapes, and
 * a label outside them fell through to "names no constant", which is
 * indistinguishable from a label that genuinely names none: the gate's one
 * blind spot was shaped exactly like its passing case. 36 arms across nine
 * configs sat in it writing the tune syntax itself -- `deadzone`'s four
 * `deadzone_*` arms, `quant-ranges`' four `max_*`, `scalefactor-bands`' ten
 * across both configs, `refine-objective`'s eleven, `graphics-encoder`'s two
 * `sel_hv` -- every one of them the precise failure this file exists to catch,
 * and every one unchecked. All 36 pass; that they pass was not knowable
 * before, which is the point.
 *
 * A key this list omits is a key no arm can pin by name, so adding a knob to
 * `encode_stdin` without adding it here reopens the gap for that knob alone.
 * Listing them out rather than scraping the parser is what makes that
 * omission a visible edit in this file.
 */
const TUNE_KEYS = [
  "max_chroma_a",
  "max_chroma_b",
  "max_l_scale",
  "max_a_scale",
  "max_b_scale",
  "max_alpha_scale",
  "mu_l",
  "mu_c",
  "mu_alpha",
  "w_min_l",
  "w_exp_l",
  "w_min_c",
  "w_exp_c",
  "dc_search",
  "compand_l",
  "compand_c",
  "compand_alpha",
  "table_l",
  "table_c",
  "table_alpha",
  "deadzone_l",
  "deadzone_c",
  "deadzone_alpha",
  "band_split",
  "band_gain_l",
  "band_gain_c",
  "aniso",
  "ac_nearest",
  "dct_separable",
  "scale_fit",
  "refine_passes",
  "refine_delta",
  "refine_obj",
  "refine_dc",
  "refine_scale",
  "reproject_passes",
  "aspect_bits",
  "l_dc_bits",
  "a_dc_bits",
  "b_dc_bits",
  "l_scale_bits",
  "a_scale_bits",
  "b_scale_bits",
  "b_scale_from_a",
  "scale_mu",
  "sel_hv",
  "refine_grid",
  "refine_wl",
  "refine_wc",
  "cfl_bits",
  "cfl_range",
  "synth_count",
  "synth_gain",
  "interleave",
  "trunc_bytes",
  "alpha_dc_bits",
  "alpha_scale_bits",
  "alpha_ac_count",
  "alpha_ac_bits",
  "alpha_ac_fit",
];

/**
 * Shorthand a label writes for a key with a longer real name.
 *
 * Only the `=` forms are listed, and each was read off the configs that use
 * it rather than guessed: `scalefactor-bands` writes `gain_l=0.7` for
 * `band_gain_l=0.7`, `refine-objective` writes `wc=3` for `refine_wc=3`. The
 * bare-token shorthands in the same labels -- `obj3`, `p4`, `d2`, `grid1` --
 * are deliberately absent. They are one or two characters with no delimiter,
 * so a rule matching them would fire on unrelated labels across the other 800
 * arms, and a gate that fails on an arm that is fine is worse than one that
 * stays quiet about it. Those arms show up under `--list-unnamed`.
 */
const TUNE_KEY_ALIASES: Record<string, string> = {
  gain_l: "band_gain_l",
  gain_c: "band_gain_c",
  split: "band_split",
  wc: "refine_wc",
  wl: "refine_wl",
};

// Longest first, so `max_a_scale` is not read as `max_a` were both ever keys.
const TUNE_KEY_RE = new RegExp(
  `(?<![A-Za-z_])(${[...TUNE_KEYS, ...Object.keys(TUNE_KEY_ALIASES)]
    .sort((a, b) => b.length - a.length)
    .join("|")})\\s*=\\s*([^\\s,)]+)`,
  "g",
);

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
  // The tune key written out. Several of the shapes above accept this spelling
  // too (`aniso=1.2`, `scale_fit=2`), so the result is deduped rather than the
  // key list pruned: which shape recognized a token is an implementation
  // detail, and pruning would silently drop a knob if a shape were ever
  // narrowed.
  for (const m of label.matchAll(TUNE_KEY_RE)) {
    const key = TUNE_KEY_ALIASES[m[1] ?? ""] ?? m[1] ?? "";
    push(`${m[1]}=${m[2]}`, [key], m[2] ?? "");
  }
  const seen = new Set<string>();
  return out.filter((n) => {
    const id = `${n.keys.join("|")}=${n.value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
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
  options: {
    list: { type: "boolean" },
    "list-unnamed": { type: "boolean" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log("usage: verify-sweep-labels [--list] [--list-unnamed]");
  process.exit(0);
}

const files = readdirSync(SWEEP_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

/** A config's `unpinnedLabels` declaration: the reason, and what it excuses. */
interface OptOut {
  /** Arms in this config whose findings the opt-out suppresses. */
  arms: number;
  /** Why they are left unpinned. */
  why: string;
}

const findings: Finding[] = [];
const disclosed: {
  config: string;
  why: string;
  suppressed: number;
  declared: number;
}[] = [];
const unnamed: { config: string; label: string }[] = [];
let arms = 0;
let named = 0;
let exemptNamed = 0;
let exemptConfigs = 0;

for (const file of files) {
  const raw = JSON.parse(readFileSync(path.join(SWEEP_DIR, file), "utf8")) as {
    variants?: { label: string; tune?: string }[];
    unpinnedLabels?: OptOut;
  };
  const optOut = raw.unpinnedLabels;
  let hits = 0;
  let namedHere = 0;

  for (const v of raw.variants ?? []) {
    arms++;
    const constants = namedConstants(v.label);
    if (constants.length === 0) {
      // Not "names no constant" -- "names none this file can read". The two
      // are the same line of code and very different claims, and the summary
      // used to make the stronger one. `--list-unnamed` is what makes the
      // residue auditable: a label in it that plainly names a knob is a token
      // shape to add above, and that is how the 36 were found.
      unnamed.push({ config: file, label: v.label });
      continue;
    }
    named++;
    namedHere++;
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
  if (optOut) {
    exemptConfigs++;
    exemptNamed += namedHere;
    disclosed.push({
      config: file,
      why: optOut.why,
      suppressed: hits,
      declared: optOut.arms,
    });
  }
}

if (values.list) process.exit(0);

if (values["list-unnamed"]) {
  console.log(
    `${unnamed.length} of ${arms} arm(s) name no constant this file can read.
Most are prose -- "32B shipped", "t1 native". One that names a knob is a token
shape missing from namedConstants, and an unchecked arm until it is added.\n`,
  );
  let last = "";
  for (const u of unnamed) {
    if (u.config !== last) console.log(`  ${u.config}`);
    last = u.config;
    console.log(`      ${JSON.stringify(u.label)}`);
  }
  process.exit(0);
}

for (const d of disclosed) {
  console.log(
    `  DISCLOSED  ${d.config}: ${d.suppressed} arm(s) name a constant they do not set\n` +
      `             ${d.why}`,
  );
}

// An opt-out that excuses nothing, or that no longer excuses what it says it
// does. Same shape and same reasoning as `not_in_parity`'s staleness check in
// `spec/validate.py`: a standing exception has to keep earning its keep, or it
// quietly becomes cover for whatever lands under it next.
const staleOptOuts = disclosed.filter(
  (d) => d.declared === 0 || d.suppressed !== d.declared,
);

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
      "inherits whatever ships \u2014 which means an arm like this measures something\n" +
      "other than what its label says, and its row in EXPERIMENTS.md is wrong in a\n" +
      "way no number can reveal. Pin the knob, or declare `unpinnedLabels` on the\n" +
      "config with the reason and the number of arms it excuses (see\n" +
      "EXPERIMENTS.md \u00a79.5).",
  );
}

if (staleOptOuts.length > 0) {
  console.error(`\n${staleOptOuts.length} stale unpinnedLabels opt-out(s):\n`);
  for (const d of staleOptOuts) {
    const why =
      d.suppressed === 0
        ? "the opt-out excuses nothing and should be deleted"
        : "the count no longer matches the arms it excuses";
    console.error(
      `  ${d.config}: declares ${d.declared} arm(s), suppresses ${d.suppressed} \u2014 ${why}`,
    );
  }
  console.error(
    "\n`unpinnedLabels` exempts the whole config, so it also covers every arm\n" +
      "added to it afterwards. The declared count is what stops that being\n" +
      "permanent: an opt-out that suppresses nothing has been fixed and should go,\n" +
      "and one whose count moved is excusing an arm nobody disclosed. Re-pin the\n" +
      "arm, or update the count and say in the reason what changed. This is the\n" +
      "same rule `spec/validate.py` applies to its `not_in_parity` register.",
  );
}

if (findings.length > 0 || staleOptOuts.length > 0) process.exit(1);

const enforced = named - exemptNamed;
console.log(
  [
    `Checked ${enforced} of ${arms} arms across ${files.length} sweep configs;`,
    `${exemptNamed} named arms in ${exemptConfigs} configs are exempt via unpinnedLabels;`,
    `${unnamed.length} name no constant this file can read (--list-unnamed).`,
  ].join(" "),
);
console.log(
  `\nEvery one of the ${enforced} enforceable arms sets the constants its label names.`,
);
console.log(
  `The ${exemptNamed} exempt arms are not that claim: their config's opt-out discards`,
);
console.log(`every finding in it, so only the ${enforced} can fail this gate.`);
