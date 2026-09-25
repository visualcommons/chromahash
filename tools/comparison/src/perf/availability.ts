/**
 * How the perf driver reads a target's `bench-info` probe: measurable, absent,
 * or broken.
 *
 * Split out of `run.ts` because that file runs the whole sweep at module scope,
 * so importing it to check this would start a benchmark. The distinction is
 * what decides whether `verify-benchmark` skips a target's rows, so it is
 * asserted in `metric-selftest.ts` against real spawns.
 */

import type { SpawnSyncReturns } from "node:child_process";

/**
 * Why a target could not be measured, and whether that is a fact about the host
 * or a fact about the target.
 *
 * This used to be a bare `ok: false`, identical for a missing binary, a
 * non-zero exit, a timeout and a crash — and `verify-benchmark` skips a
 * target's rows on that alone. So on macOS, where `xcodebuild` exists, a Swift
 * *build regression* was indistinguishable from no Swift toolchain, and the
 * gate would have waved the rows through in both cases. Only `absent` may be
 * skipped; `broken` is reported.
 */
export type Availability = "absent" | "broken";

export interface ProbeOutcome {
  ok: boolean;
  kind?: Availability;
  reason?: string;
  info?: string;
}

/**
 * Strip the author's checkout path out of a probe message.
 *
 * The reason is committed in `baselines/perf-report.json` and echoed into CI
 * logs by `verify-benchmark`, and Node's ENOENT message quotes the absolute
 * command — which for this repo was a maintainer's worktree path, published in
 * the baseline and reprinted on every CI run. Repo-relative says the same
 * thing and belongs to the repo rather than to whoever measured.
 */
export function repoRelative(message: string, root: string): string {
  return message.split(`${root}/`).join("").split(root).join(".");
}

/** Read a finished `bench-info` spawn. `root` is the repo root to redact. */
export function classifyProbe(
  proc: SpawnSyncReturns<string>,
  root: string,
): ProbeOutcome {
  if (proc.error || proc.status !== 0) {
    // ENOENT is the only outcome that means "nothing on this host could have
    // measured it". A spawn that succeeded and then exited non-zero, timed out
    // (ETIMEDOUT / SIGTERM) or died on a signal all mean the target is present
    // and not working.
    const code = (proc.error as NodeJS.ErrnoException | undefined)?.code;
    const kind: Availability = code === "ENOENT" ? "absent" : "broken";
    // `||`, not `??`: a utf8 spawn's stderr is always a string, so a target
    // that died silently yields "" (or whitespace), which must fall through to
    // the signal or exit status rather than record an empty reason.
    const why =
      proc.error?.message ||
      proc.stderr?.trim().slice(0, 200) ||
      (proc.signal ? `killed by ${proc.signal}` : `exit ${proc.status}`);
    return { ok: false, kind, reason: repoRelative(why.trim(), root) };
  }
  return { ok: true, info: proc.stdout.trim() };
}
