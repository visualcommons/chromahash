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
 * SHA-256 over `git ls-tree --full-tree <commit> -- MEASURED_PATHS` — and the
 * gate verifies provenance by that digest when the commit itself is not
 * reachable: a run is traceable if some commit in `HEAD`'s history has the same
 * measured sources. The squash commit that landed the measured branch does,
 * provided `master`'s measured sources did not move between the measurement and
 * the merge.
 *
 * `tools/benchmark/record_stages.py` computes the same digest over the same
 * paths for §1 and §1.1; `metric-selftest.ts` asserts the two lists agree.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * The paths whose content decides what a perf cell measures: the core and
 * every binding a harness drives, the harnesses' own sources, the driver and
 * its statistics, and the stage recorder. Repo-root-relative, sorted.
 */
export const MEASURED_PATHS = [
  "Package.swift",
  "bindings",
  "csharp",
  "go",
  "python",
  "rust",
  "swift",
  "tools/benchmark/record_stages.py",
  "tools/comparison/src/perf",
  "tools/comparison/src/stats.ts",
  "typescript",
] as const;

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
  const listing = git(root, [
    "ls-tree",
    "--full-tree",
    rev,
    "--",
    ...MEASURED_PATHS,
  ]);
  if (listing === null || listing === "") return null;
  return createHash("sha256").update(listing).digest("hex");
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
  /** Cannot search: a shallow clone. Reported as a skip. */
  | "shallow"
  /** The commit is reachable and its sources do not match the digest. */
  | "mismatch"
  /** Nothing reachable carries the recorded sources. */
  | "unresolved";

export interface ProvenanceVerdict {
  status: ProvenanceStatus;
  detail: string;
}

/** Whether a verdict fails the gate. */
export const provenanceFails = (v: ProvenanceVerdict): boolean =>
  v.status === "mismatch" || v.status === "unresolved";

/**
 * The rule §0 states. A recorded digest is checked against the recorded commit
 * when that commit is an ancestor of HEAD, and otherwise searched for in HEAD's
 * history. A run with no digest predates the rule: the gate says what it could
 * and could not establish and does not fail it.
 */
export function judgeProvenance(
  rec: { commit: string; digest?: string | null },
  view: GitView,
): ProvenanceVerdict {
  const search = (digest: string): string | null => {
    for (const c of view.history()) {
      if (view.digestAt(c) === digest) return c;
    }
    return null;
  };
  const ancestor = view.isAncestor(rec.commit);

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
