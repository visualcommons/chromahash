/**
 * Assert that scoring concurrently produces byte-identical output to scoring
 * serially.
 *
 * The harness fans images out across cores (see `pool.ts`). Nothing about the
 * metrics is order-dependent — `iqa-cli` results are content-addressed, and the
 * quantiles sort — but the *aggregates* are naive left-folds, so bit-identical
 * output depends on results being placed back by index rather than pushed on
 * completion. That is an easy invariant to break silently: a run reordered by
 * whichever image finished first would still look completely plausible, and
 * would differ from CI in the last few digits of every mean.
 *
 * So this runs the real orchestrator twice over the generated fixtures, once at
 * `--jobs 1` and once wide, and diffs the two reports. Deliberately built on
 * the synthetic corpus: it is generated locally, so this gate needs no network,
 * no pinned corpus and no corpus-host availability — it can run on every CI
 * push, which is the only way it catches anything.
 *
 * It then does the same for a **sweep**, which is what every committed result
 * under `results/` is, and which the report check never exercises: one small
 * sweep is run twice with the metric cache off, and the two results must be
 * identical, and both must reproduce the committed result's per-image values
 * for the images they scored. The first half asserts a sweep is a function of
 * its inputs; the second, that the committed evidence is what this build and
 * this `iqa-cli` produce -- on whatever machine runs the check, CI included.
 *
 * Run with `mise run selftest:determinism`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateFixtures } from "./generate-fixtures.ts";
import {
  RESULTS_DIR,
  type ResultFile,
  readResult,
  resultPath,
} from "./results.ts";

const TOOL_ROOT = path.resolve(import.meta.dirname, "..");
const MAIN = path.join(TOOL_ROOT, "dist/main.js");
const SWEEP = path.join(TOOL_ROOT, "dist/sweep.js");
const SYNTHETIC = path.join(TOOL_ROOT, "fixtures/synthetic");

/**
 * The sweep the check re-runs, and how much of it.
 *
 * `synthesis-window` because it scores the artifact metrics as well as the
 * four iqa-cli ones, so every per-image series a result can carry is
 * exercised; and because §12.2 turns a verdict on it. Two images: the
 * invariant is per image, so more buy no coverage, and the check runs on every
 * CI push with the cache off.
 */
const GATE_SWEEP = "synthesis-window";
const GATE_SWEEP_IMAGES = 2;

/**
 * How far a re-run may sit from the committed value and still reproduce it.
 *
 * Not zero, because nothing pins the floating-point path across machines: the
 * SSIMULACRA2 and Butteraugli kernels dispatch on the host's SIMD width, and
 * libvips's resampler does the same. 1e-5 relative is two orders of magnitude
 * below the coarsest rounding `spec/EXPERIMENTS.md` prints (a ΔE00 near 10 to
 * three decimals is 1e-4), so a value inside it cannot move a cell, and one
 * outside it is a result this build does not reproduce.
 */
const REPRODUCTION_REL = 1e-5;
const REPRODUCTION_ABS = 1e-9;

/**
 * The fixtures this gate scores.
 *
 * A fixed handful, not the whole synthetic corpus. The invariant under test is
 * that per-image results are folded in input order rather than completion
 * order, and that shows up with any set of images whose metrics differ — more
 * images buy no extra coverage and only make the gate too slow to run on every
 * push. These six differ in chroma, key, structure and aspect, so a reordering
 * moves the aggregates rather than cancelling out.
 */
const GATE_FIXTURES = [
  "checkerboard.png",
  "dim-9x6.png",
  "gradient-2d.png",
  "monochrome.png",
  "noise.png",
  "solid-red.png",
] as const;

/**
 * Volatile fields that differ between any two runs and say nothing about
 * determinism: when the report was generated, and the paths of the standalone
 * image files, which each run writes into its own output directory.
 */
const VOLATILE = new Set(["generatedAt", "commit", "preview", "css"]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE.has(key)) continue;
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function runReport(outDir: string, jobs: number): string {
  execFileSync(
    process.execPath,
    [
      MAIN,
      "--images",
      `fixtures/synthetic/{${GATE_FIXTURES.join(",")}}`,
      "--skip-natural",
      "--skip-holdout",
      "--skip-harnesses",
      "--jobs",
      String(jobs),
      "--output",
      path.join(outDir, `report-j${jobs}.html`),
      "--json",
      path.join(outDir, `report-j${jobs}.json`),
    ],
    { cwd: TOOL_ROOT, stdio: ["ignore", "ignore", "inherit"] },
  );
  const raw = readFileSync(path.join(outDir, `report-j${jobs}.json`), "utf8");
  return JSON.stringify(canonical(JSON.parse(raw)), null, 1);
}

/** Run the gate sweep once, uncached, into `outDir`, and read its result. */
function runSweep(outDir: string): ResultFile {
  execFileSync(
    process.execPath,
    [
      SWEEP,
      path.join(TOOL_ROOT, "sweeps", `${GATE_SWEEP}.json`),
      "--max-images",
      String(GATE_SWEEP_IMAGES),
      "--out-dir",
      outDir,
    ],
    {
      cwd: TOOL_ROOT,
      // Off, or the second run is served from the first run's cache and the
      // comparison is of the cache with itself.
      env: { ...process.env, CHROMAHASH_METRIC_CACHE: "off" },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const result = readResult(outDir, GATE_SWEEP);
  if (!result) throw new Error(`the sweep wrote no ${GATE_SWEEP}.json`);
  return result;
}

/**
 * Everything in a result but its provenance, canonicalized. Provenance records
 * the state of the tree at the start of each run, which is not what is under
 * test and can differ between two runs for reasons unrelated to scoring.
 */
function scored(result: ResultFile): string {
  const { provenance: _, ...rest } = result;
  return JSON.stringify(canonical(rest), null, 1);
}

/**
 * Where a re-run's per-image values fall outside {@link REPRODUCTION_REL} of the
 * committed result's, matched by arm label and image name. Also reports an arm
 * or a series the committed result has and the re-run lacks, or the reverse:
 * a series that stopped being measured is not a reproduction either.
 */
function reproductionErrors(run: ResultFile, committed: ResultFile): string[] {
  const out: string[] = [];
  const committedIndex = new Map(
    committed.imageNames.map((n, i) => [n, i] as const),
  );
  for (const row of run.rows) {
    const twin = committed.rows.find((r) => r.label === row.label);
    if (!twin) {
      out.push(`arm "${row.label}" is not in the committed result`);
      continue;
    }
    const keys = new Set([
      ...Object.keys(row.perImage),
      ...Object.keys(twin.perImage),
    ]) as Set<keyof typeof row.perImage>;
    for (const key of keys) {
      const mine = row.perImage[key];
      const theirs = twin.perImage[key];
      if (!mine || !theirs) {
        out.push(
          `arm "${row.label}" ${key}: ${mine ? "absent from the committed result" : "not measured by the re-run"}`,
        );
        continue;
      }
      for (const [i, name] of run.imageNames.entries()) {
        const j = committedIndex.get(name);
        if (j === undefined) {
          out.push(`image "${name}" is not in the committed result`);
          continue;
        }
        const a = mine[i] ?? null;
        const b = theirs[j] ?? null;
        if (a === null || b === null) {
          if (a !== b) out.push(`${row.label} / ${name} ${key}: ${a} vs ${b}`);
          continue;
        }
        const tol = Math.max(REPRODUCTION_ABS, Math.abs(b) * REPRODUCTION_REL);
        if (Math.abs(a - b) > tol) {
          out.push(
            `${row.label} / ${name} ${key}: re-run ${a}, committed ${b} (off by ${(Math.abs(a - b) / Math.max(Math.abs(b), REPRODUCTION_ABS)).toExponential(2)} relative)`,
          );
        }
      }
    }
  }
  for (const twin of committed.rows) {
    if (!run.rows.some((r) => r.label === twin.label)) {
      out.push(`committed arm "${twin.label}" was not re-run`);
    }
  }
  return out;
}

/** First differing line, with a little context, or null when identical. */
function firstDifference(
  a: string,
  b: string,
  labels: readonly [string, string] = ["serial:  ", "parallel:"],
): string | null {
  if (a === b) return null;
  const as = a.split("\n");
  const bs = b.split("\n");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) {
      return [
        `  first difference at line ${i + 1}:`,
        `    ${labels[0]} ${as[i] ?? "<missing>"}`,
        `    ${labels[1]} ${bs[i] ?? "<missing>"}`,
      ].join("\n");
    }
  }
  return "  outputs differ in length only";
}

async function main(): Promise<void> {
  if (!existsSync(MAIN)) {
    console.error(
      `${MAIN} is missing — run \`pnpm --prefix tools/comparison run build\` first.`,
    );
    process.exit(1);
  }

  // The generated corpus is gitignored, so a clean checkout has none.
  if (!existsSync(SYNTHETIC)) {
    console.log("Generating synthetic fixtures...");
    await generateFixtures();
  }

  // Two workers is enough to interleave; more only lengthens the gate. A
  // machine that reports one core cannot demonstrate anything here.
  const wide = Math.max(2, Math.min(8, os.availableParallelism()));
  const outDir = mkdtempSync(path.join(os.tmpdir(), "chromahash-determinism-"));

  try {
    console.log("Scoring the synthetic corpus serially (--jobs 1)...");
    const serial = runReport(outDir, 1);
    console.log(`Scoring it again concurrently (--jobs ${wide})...`);
    const parallel = runReport(outDir, wide);

    const diff = firstDifference(serial, parallel);
    if (diff !== null) {
      console.error(
        [
          `FAIL  --jobs 1 and --jobs ${wide} produced different reports.`,
          diff,
          "",
          "  Concurrency must not change a published number. The usual cause is a",
          "  result appended on completion instead of placed by index, which",
          "  reorders the left-folds every mean is computed with.",
        ].join("\n"),
      );
      process.exit(1);
    }

    console.log(
      `\nPASS  --jobs 1 and --jobs ${wide} agree byte for byte (${serial.length} bytes of canonicalized report).`,
    );

    // ─── A sweep, twice, against its committed result ────────────────────
    const committed = readResult(RESULTS_DIR, GATE_SWEEP);
    if (!committed) {
      console.error(
        `FAIL  ${path.relative(process.cwd(), resultPath(RESULTS_DIR, GATE_SWEEP))} is not committed, so there is nothing to reproduce.`,
      );
      process.exit(1);
    }
    console.log(
      `\nRunning sweep ${GATE_SWEEP} on ${GATE_SWEEP_IMAGES} image(s), metric cache off...`,
    );
    const first = runSweep(path.join(outDir, "sweep-a"));
    console.log("Running it again...");
    const second = runSweep(path.join(outDir, "sweep-b"));

    const sweepDiff = firstDifference(scored(first), scored(second), [
      "run 1:",
      "run 2:",
    ]);
    if (sweepDiff !== null) {
      console.error(
        [
          `FAIL  two runs of sweep ${GATE_SWEEP} produced different results.`,
          sweepDiff,
          "",
          "  A sweep must be a function of its config, its corpus and its build.",
        ].join("\n"),
      );
      process.exit(1);
    }
    console.log(
      `PASS  both runs agree byte for byte (${first.rows.length} arms × ${first.imageNames.length} images).`,
    );

    const errors = reproductionErrors(first, committed);
    if (errors.length > 0) {
      console.error(
        [
          `FAIL  this build does not reproduce results/${GATE_SWEEP}.json (${errors.length} value(s) outside ${REPRODUCTION_REL} relative):`,
          ...errors.slice(0, 12).map((e) => `    ${e}`),
          ...(errors.length > 12
            ? [`    ... and ${errors.length - 12} more`]
            : []),
          "",
          `  The committed result was recorded at ${committed.provenance.rev ?? "an unknown revision"} with ${committed.provenance.iqaCli}.`,
          "  Either the encoder, the scoring path or the metric binary has moved since,",
          "  and the committed results must be re-recorded -- or they never reproduced",
          "  off the machine that recorded them, which is a finding about them.",
        ].join("\n"),
      );
      process.exit(1);
    }
    console.log(
      `PASS  the re-run reproduces results/${GATE_SWEEP}.json within ${REPRODUCTION_REL} relative on every value it scored.`,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

await main();
