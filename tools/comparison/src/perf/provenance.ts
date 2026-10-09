/**
 * Which source state a measurement came from, in a form that survives a squash
 * merge.
 *
 * Every recorder here stamped `git rev-parse --short HEAD`, and every measured
 * commit in the repo's baselines is unreachable from `master`: PRs are
 * squash-merged, so the branch commit a run was taken at survives only under a
 * GitHub PR ref, which a normal clone does not fetch. `perf-report.json` records
 * `e53e6cd`, the stage baselines `4d68c1f` and `8f5f4d1`; none is an ancestor
 * of `master`, so "this run traces to a revision" was a claim nobody could
 * check from the repository it was committed to.
 *
 * A squash merge discards the commit and keeps the trees. So a run now also
 * records a **digest of the sources that determine the measurement** — a
 * SHA-256 over every file `git ls-tree -r` lists under MEASURED_PATHS, less
 * documentation (`isDocumentation`) — and the gate verifies provenance by that
 * digest when the commit itself is not reachable: a run is traceable if some
 * commit in `HEAD`'s history has the same measured sources. The squash commit
 * that landed the measured branch does, provided `master`'s measured sources
 * did not move between the measurement and the merge.
 *
 * That proviso used to be checked only after the merge, when it was too late:
 * a run measured on a branch passed while the PR was open, and failed on
 * `master` once a PR that moved the measured sources merged first. So a change
 * that *adds or changes* a baseline must now carry HEAD's own sources
 * (`judgeLanding`): in CI, HEAD is the PR merged into the current `master`, so a
 * stale run fails before the merge, and the fix is to rebase and re-measure.
 *
 * `tools/benchmark/record_stages.py` computes the same digest over the same
 * paths for §1 and §1.1; `metric-selftest.ts` asserts the two lists agree.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * The paths whose content decides what a perf cell measures: the core and
 * every binding a harness drives, the harnesses' own sources, the driver and
 * its statistics, the stage recorder, and the tasks that build and run them —
 * `.mise.toml` holds every harness's build flags (`build:benchmark`,
 * `build:benchmark:scalar`, the `bench-internals` feature), and
 * `mise-tasks/benchmark/` the session and stage tasks. Repo-root-relative,
 * sorted.
 *
 * `.mise.toml` is whole: a change to an unrelated task there invalidates a
 * baseline it did not affect. That costs a re-measurement now and then; leaving
 * it out let a change to a harness's build flags keep the old baseline.
 */
export const MEASURED_PATHS = [
  ".mise.toml",
  "Package.swift",
  "bindings",
  "csharp",
  "go",
  "mise-tasks/benchmark",
  "python",
  "rust",
  "swift",
  "tools/benchmark/record_stages.py",
  "tools/comparison/src/perf",
  "tools/comparison/src/stats.ts",
  "typescript",
] as const;

/**
 * Files under MEASURED_PATHS that cannot change a measurement: Markdown and
 * reStructuredText, and anything under a `docs/` directory. A README edit in
 * `rust/` used to change the digest and so orphan every baseline taken before
 * it. `record_stages.py` applies the same rule; the selftest checks the two
 * digests agree on HEAD.
 */
export const isDocumentation = (repoPath: string): boolean =>
  /\.(md|markdown|rst)$/i.test(repoPath) ||
  repoPath.split("/").includes("docs");

/**
 * The digest of a `git ls-tree -r -z` listing: SHA-256 over each kept entry
 * (`<mode> <type> <object>\t<path>`) followed by a newline, in git's order,
 * documentation dropped. Null for a listing with nothing left in it.
 */
export function digestOfListing(listing: Buffer): string | null {
  const hash = createHash("sha256");
  let kept = 0;
  let start = 0;
  for (let i = 0; i <= listing.length; i++) {
    if (i < listing.length && listing[i] !== 0) continue;
    const entry = listing.subarray(start, i);
    start = i + 1;
    if (entry.length === 0) continue;
    const tab = entry.indexOf(9);
    const repoPath = entry.subarray(tab + 1).toString("utf8");
    if (tab < 0 || isDocumentation(repoPath)) continue;
    hash.update(entry);
    hash.update("\n");
    kept++;
  }
  return kept === 0 ? null : hash.digest("hex");
}

/**
 * What the recorders write into the tree, and so what their dirty probes
 * ignore. A measurement output is not a measurement input: a copied-in
 * `perf-report.json` says nothing about what the next harness builds, and
 * treating it as source made §0's procedure order-dependent — sweeps first,
 * then stages, then the copies, or every later recording stamped itself dirty.
 */
export const MEASUREMENT_OUTPUTS = [
  "tools/comparison/baselines/hosts",
  "tools/comparison/baselines/perf-decode-stages.json",
  "tools/comparison/baselines/perf-stages.json",
] as const;

function gitRaw(root: string, args: string[]): Buffer | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The digest of `rev`'s measured sources, or null if `rev` is not here. */
export function sourceDigest(root: string, rev: string): string | null {
  const listing = gitRaw(root, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    rev,
    "--",
    ...MEASURED_PATHS,
  ]);
  return listing === null ? null : digestOfListing(listing);
}

/**
 * Whether the working tree differs from `HEAD` anywhere but the recorders' own
 * outputs. Untracked files count, as they always have.
 */
export function dirtyOutsideOutputs(root: string): boolean {
  const status = git(root, [
    "status",
    "--porcelain",
    "--",
    ":/",
    ...MEASUREMENT_OUTPUTS.map((p) => `:(exclude,top)${p}`),
  ]);
  return status === null || status.trim().length > 0;
}

/** The short commit, the digest of its measured sources, and the dirty bit. */
export function recordGit(root: string): {
  commit: string;
  dirty: boolean;
  digest: string | null;
} {
  return {
    commit: (git(root, ["rev-parse", "--short", "HEAD"]) ?? "unknown").trim(),
    dirty: dirtyOutsideOutputs(root),
    digest: sourceDigest(root, "HEAD"),
  };
}

// ─── Verification ───────────────────────────────────────────────────────────

/** What the gate can ask the repository; injected so the rule is testable. */
export interface GitView {
  /** True/false if `commit` is known; null if the object is not in this clone. */
  isAncestor(commit: string): boolean | null;
  /** The digest of `commit`'s measured sources, or null if it is not here. */
  digestAt(commit: string): string | null;
  /** Commits reachable from HEAD at which the measured sources changed, newest first, HEAD included. */
  history(): string[];
  shallow: boolean;
}

export type ProvenanceStatus =
  /** The recorded commit is an ancestor of HEAD, and its sources match. */
  | "commit"
  /** The commit is not reachable, but a reachable commit has its sources. */
  | "digest"
  /** No digest recorded — a run from before digests. Reported, never failed. */
  | "legacy"
  /** No digest recorded by a format that always records one. */
  | "unrecorded"
  /** Cannot search: a shallow clone. Reported as a skip. */
  | "shallow"
  /** The commit is reachable and its sources do not match the digest. */
  | "mismatch"
  /** A baseline this change adds or changes, measured on other sources than HEAD's. */
  | "stale"
  /** Nothing reachable carries the recorded sources. */
  | "unresolved";

export interface ProvenanceVerdict {
  status: ProvenanceStatus;
  detail: string;
}

/** Whether a verdict fails the gate. */
export const provenanceFails = (v: ProvenanceVerdict): boolean =>
  v.status === "mismatch" ||
  v.status === "unresolved" ||
  v.status === "unrecorded" ||
  v.status === "stale";

/**
 * The landing rule: a baseline this change adds or changes must have been
 * measured on HEAD's own measured sources. Null for a baseline the change does
 * not touch, which the ordinary rule (`judgeProvenance`) covers.
 *
 * Why HEAD and not "some commit in history": the history rule passes a run
 * while its PR is open and fails it on `master` if another PR moved the
 * measured sources in between, because the squash commit then carries sources
 * nobody measured. Holding a *new* baseline to HEAD — which in CI is the PR
 * merged into the current `master` — moves that failure before the merge.
 */
export function judgeLanding(
  rec: { digest?: string | null },
  landing: { isNew: boolean; headDigest: string | null; base: string },
): ProvenanceVerdict | null {
  if (!landing.isNew) return null;
  if (rec.digest && rec.digest === landing.headDigest) {
    return {
      status: "commit",
      detail: `new since ${landing.base}, and measured on HEAD's own sources`,
    };
  }
  return {
    status: "stale",
    detail: `new since ${landing.base}, but measured on sources ${rec.digest ? rec.digest.slice(0, 12) : "(no digest)"}, and HEAD's are ${landing.headDigest?.slice(0, 12) ?? "(none)"} — the measured sources moved after the run (a rebase onto master, or a later commit here); re-measure at HEAD`,
  };
}

/** What the landing rule needs from the repository. */
export interface LandingView {
  /** The ref the change is measured against, or null when none resolves. */
  base: string | null;
  headDigest: string | null;
  /** Whether the working-tree file's content is absent from `base`'s baselines. */
  isNewFile(repoPath: string): boolean;
  /** The file's content at `base`, or null if it did not exist there. */
  atBase(repoPath: string): string | null;
}

/**
 * The real repository's landing view. The base is `VERIFY_BENCHMARK_BASE` when
 * set, and otherwise where HEAD left `origin/master` (or `master`): on a PR's
 * merge commit in CI that is `master` itself, and on `master` it is HEAD, so
 * nothing there is new. A file is new when its blob is nowhere under the
 * base's `tools/comparison/baselines/`, so a baseline moved unchanged is not.
 */
export function landingView(root: string): LandingView {
  const explicit = process.env.VERIFY_BENCHMARK_BASE;
  const resolve = (ref: string): string | null =>
    git(root, ["merge-base", "HEAD", ref])?.trim() || null;
  const base = explicit
    ? (git(root, ["rev-parse", "--verify", `${explicit}^{commit}`])?.trim() ??
      null)
    : (resolve("origin/master") ?? resolve("master"));
  let blobs: Set<string> | null = null;
  return {
    base: base ? base.slice(0, 7) : null,
    headDigest: sourceDigest(root, "HEAD"),
    isNewFile(repoPath) {
      if (base === null) return false;
      if (blobs === null) {
        const listing =
          git(root, [
            "ls-tree",
            "-r",
            base,
            "--",
            "tools/comparison/baselines",
          ]) ?? "";
        blobs = new Set(
          listing
            .split("\n")
            .map((l) => l.split(/\s+/)[2])
            .filter((b): b is string => !!b),
        );
      }
      const blob = git(root, ["hash-object", "--", repoPath])?.trim();
      return blob !== undefined && !blobs.has(blob);
    },
    atBase(repoPath) {
      return base === null ? null : git(root, ["show", `${base}:${repoPath}`]);
    },
  };
}

/**
 * The rule §0 states. A recorded digest is checked against the recorded commit
 * when that commit is an ancestor of HEAD, and otherwise searched for in HEAD's
 * history. A run with no digest predates the rule — but only a run whose format
 * predates it (`legacy: true`) may say so: the gate says what it could and
 * could not establish about one and does not fail it. Any other run without a
 * digest is `unrecorded`, and fails.
 */
export function judgeProvenance(
  rec: { commit: string; digest?: string | null },
  view: GitView,
  legacy = false,
): ProvenanceVerdict {
  const search = (digest: string): string | null => {
    for (const c of view.history()) {
      if (view.digestAt(c) === digest) return c;
    }
    return null;
  };
  const ancestor = view.isAncestor(rec.commit);

  if (!rec.digest && !legacy) {
    return {
      status: "unrecorded",
      detail: `no source digest recorded for commit ${rec.commit}, and this run's format always records one — it cannot be traced after a squash merge; regenerate it`,
    };
  }
  if (!rec.digest) {
    if (ancestor === true) {
      return {
        status: "legacy",
        detail: `no source digest recorded; commit ${rec.commit} is an ancestor of HEAD`,
      };
    }
    const at = view.digestAt(rec.commit);
    const match = at ? search(at) : null;
    return {
      status: "legacy",
      detail: match
        ? `no source digest recorded; commit ${rec.commit} is not an ancestor of HEAD, but its measured sources are ${match}'s`
        : `no source digest recorded, and commit ${rec.commit} is ${at ? "not an ancestor of HEAD and its sources match no reachable commit" : "not in this clone"} — recorded before provenance digests, so this run is traceable only by its PR ref`,
    };
  }

  if (ancestor === true) {
    const at = view.digestAt(rec.commit);
    return at === rec.digest
      ? {
          status: "commit",
          detail: `commit ${rec.commit} is an ancestor of HEAD`,
        }
      : {
          status: "mismatch",
          detail: `commit ${rec.commit} is an ancestor of HEAD, but its measured sources digest to ${at?.slice(0, 12)}, not the recorded ${rec.digest.slice(0, 12)} — the run was not taken at the commit it names`,
        };
  }
  const match = search(rec.digest);
  if (match) {
    return {
      status: "digest",
      detail: `commit ${rec.commit} is not reachable (squash-merged?); its measured sources are ${match}'s`,
    };
  }
  if (view.shallow) {
    return {
      status: "shallow",
      detail: `commit ${rec.commit} is not in this shallow clone and no fetched commit carries its sources — fetch full history to verify`,
    };
  }
  return {
    status: "unresolved",
    detail: `commit ${rec.commit} is not reachable from HEAD and no commit in HEAD's history has its measured sources (${rec.digest.slice(0, 12)}) — measure on a branch rebased onto master, and land it before the measured sources move`,
  };
}

/** The real repository, memoized: the gate asks about the same few commits. */
export function gitView(root: string): GitView {
  const digests = new Map<string, string | null>();
  let historyCache: string[] | null = null;
  return {
    isAncestor(commit) {
      if (git(root, ["cat-file", "-e", `${commit}^{commit}`]) === null) {
        return null;
      }
      return (
        git(root, ["merge-base", "--is-ancestor", commit, "HEAD"]) !== null
      );
    },
    digestAt(commit) {
      if (!digests.has(commit)) digests.set(commit, sourceDigest(root, commit));
      return digests.get(commit) ?? null;
    },
    history() {
      if (historyCache === null) {
        const out = git(root, [
          "log",
          "--format=%h",
          "HEAD",
          "--",
          ...MEASURED_PATHS,
        ]);
        const head = (git(root, ["rev-parse", "--short", "HEAD"]) ?? "").trim();
        historyCache = [
          ...(head ? [head] : []),
          ...(out ?? "").split("\n").filter((l) => l.length > 0),
        ];
      }
      return historyCache;
    },
    shallow:
      (git(root, ["rev-parse", "--is-shallow-repository"]) ?? "").trim() ===
      "true",
  };
}
