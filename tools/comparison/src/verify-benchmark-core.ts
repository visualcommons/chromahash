/**
 * The pure parts of `verify-benchmark.ts`: how PERFORMANCE.md is read, how the
 * committed runs are merged, and every rule that decides whether a documented
 * cell passes, fails or is skipped.
 *
 * Split out of the CLI for the reason `stratify-core.ts` was: the gate does its
 * work at module scope — it parses argv, reads the document and the baselines
 * off disk, prints and exits — so importing it to check any of this would run
 * it. These are the parts that can be wrong without throwing, and a gate that is
 * wrong without throwing reports green, so they are asserted in
 * `metric-selftest.ts` against fixtures with known answers. The file reads, the
 * table bindings and the exit status stay in the CLI.
 */

import { defaultMaxLoad, hostKey } from "./perf/host.ts";

// ─── The document, as tables ────────────────────────────────────────────────

export interface DocTable {
  section: string;
  index: number;
  line: number;
  header: string[];
  rows: string[][];
  /** Source line of each row, parallel to `rows`, for --fix. */
  rowLines: number[];
}

export const clean = (s: string): string => s.replace(/[*`]/g, "").trim();

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
    const rowLines: number[] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const body = lines[j] ?? "";
      if (!body.trimStart().startsWith("|")) break;
      rows.push(cells(body));
      rowLines.push(j);
    }
    tables.push({
      section,
      index: indexInSection++,
      line: i + 1,
      header,
      rows,
      rowLines,
    });
    i = j - 1;
  }
  return tables;
}

// ─── A documented number ────────────────────────────────────────────────────

export type Unit = "us" | "ms" | "s" | "ratio" | "percent";

export interface DocNumber {
  value: number;
  unit: Unit;
  /** Decimal places the document used, which is the precision it is held to. */
  decimals: number;
}

/**
 * A bound cell whose number has not been measured yet. Written into the
 * document as TBD so a rewrite can land with its tables bound but its figures
 * pending; the gate fails on it, so the document cannot be published in that
 * state. `--fix` against a committed run replaces them.
 */
const PLACEHOLDER = "TBD";

/**
 * Read a placeholder's intended format. Written as "TBD ms", "TBD µs", "TBD×"
 * or "TBD%", so a rewrite knows the unit the column is in; the decimals default
 * to what the document uses for that unit elsewhere.
 */
function parsePlaceholder(raw: string): DocNumber | null {
  const text = clean(raw).replace(/\*\*/g, "").trim();
  const m = /^TBD\s*(µs|us|ms|s|×|x|%)?$/i.exec(text);
  if (!m) return null;
  const suffix = m[1];
  const unit: Unit =
    suffix === "ms"
      ? "ms"
      : suffix === "s"
        ? "s"
        : suffix === "%"
          ? "percent"
          : suffix === "×" || suffix === "x"
            ? "ratio"
            : suffix === undefined
              ? "ratio"
              : "us";
  const decimals = unit === "us" ? 0 : unit === "percent" ? 1 : 2;
  return { value: Number.NaN, unit, decimals };
}

/**
 * Read one table cell as a number. Markdown emphasis, thousands separators and
 * the unicode minus all appear in the document and none of them are data.
 * Returns null for a cell that is deliberately not a measurement — an em dash,
 * a "not measured", a prose note.
 */
function parseDocNumber(raw: string): DocNumber | null {
  const text = raw
    .replace(/\*\*/g, "")
    .replace(/[*_`]/g, "")
    .replace(/−/g, "-")
    .replace(/,/g, "")
    .trim();
  const m = /^(-?[0-9]+(?:\.[0-9]+)?)\s*(µs|us|ms|s|×|x|%)?$/.exec(text);
  if (!m?.[1]) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = m[2];
  const unit: Unit =
    suffix === "µs" || suffix === "us"
      ? "us"
      : suffix === "ms"
        ? "ms"
        : suffix === "s"
          ? "s"
          : suffix === "%"
            ? "percent"
            : suffix === "×" || suffix === "x"
              ? "ratio"
              : "ratio";
  const dot = m[1].indexOf(".");
  return { value, unit, decimals: dot < 0 ? 0 : m[1].length - dot - 1 };
}

/**
 * Read a cell that declares a target this run cannot reach — "*macOS only*".
 *
 * A token rather than free prose, and asserted rather than tolerated, because
 * the alternative is what this gate shipped with: the unavailable-target skip
 * sat *below* `if (!doc) continue`, so a prose cell exited before ever reaching
 * it and the branch was live only for the one case that must never take it — a
 * documented *number* on a target no committed run measured. Fabricated Swift
 * figures passed, and the run said "Every bound value in PERFORMANCE.md agrees
 * with a committed run".
 *
 * The shape is "<host or toolchain> only", which is what §0's disclosure table
 * already writes and what PERFORMANCE.md:55 already says is written instead of
 * `TBD`: these rows are not pending anybody's run. Asserting the shape is what
 * separates a deliberate marker from a typo, an emptied cell, or a sentence
 * that used to be a number.
 *
 * Two constraints, both because the first version of this was
 * `^[A-Za-z][A-Za-z0-9 .+#-]* only$` against the de-emphasised text, which
 * matches any English phrase ending in "only". Every bound column of every
 * bound table runs through here, so an ordinary prose cell — "encoder only",
 * "batch only" — became a hard failure with a message about committed runs
 * that had nothing to do with it.
 *
 *  1. The emphasis is part of the marker. §0 and §7/§8 write `*macOS only*`,
 *     and the failure message tells an author to write exactly that. A bare
 *     phrase is prose.
 *  2. The qualifier must name a platform this repo builds for, from the list
 *     below. A marker says "no run on this host can fill this cell"; only a
 *     host can make that true, and the vocabulary for hosts is closed.
 */
const MARKER_PLATFORMS = [
  "macOS",
  "Linux",
  "Windows",
  "iOS",
  "Android",
  "arm64",
  "aarch64",
  "x86_64",
  "wasm",
] as const;

const MARKER_RE = new RegExp(
  `^\\*(?:\\*)?(${MARKER_PLATFORMS.join("|")}) only(?:\\*)?\\*$`,
);

export function parseUnavailableMarker(raw: string): string | null {
  // The raw cell, not `clean(raw)` — `clean` strips the emphasis that
  // constraint 1 depends on.
  const m = MARKER_RE.exec(raw.trim());
  return m?.[1] ? `${m[1]} only` : null;
}

const TIME_UNITS = new Set<Unit>(["us", "ms", "s"]);
const PER_US: Record<string, number> = { us: 1, ms: 1e3, s: 1e6 };

// ─── The committed runs ─────────────────────────────────────────────────────

/**
 * The run format this document's figures are defined against: per-process
 * sampling, the median of each cell's process minima (`perf/probe.ts`).
 */
export const SCHEMA = "chromahash-perf/3";

/**
 * The previous format: one process per cell, its minimum block reported. Still
 * read, because the committed baseline is one and a re-measurement replaces it
 * rather than a schema bump orphaning it; its cells carry no interval, so they
 * are held to the ±TOLERANCE band alone.
 */
export const LEGACY_SCHEMA = "chromahash-perf/2";

/**
 * Two runs of the same cell on one host agree to within this much on a host fit
 * to publish from — §0's bar. Applied *between* the committed runs of one host,
 * never across hosts and never to accept a documented number.
 */
export const CROSS_RUN_TOLERANCE = 0.1;

/**
 * How far a documented figure may sit from the committed run and still pass,
 * when it is not inside the cell's own interval.
 *
 * Half of §0's 10% host bar. A documented figure is transcribed from one run,
 * and §0's procedure commits a second that may sit anywhere within 10% of the
 * first; holding the document to the run *exactly* made every re-measurement
 * rewrite nearly every value, so the diff of a re-run was noise and a real
 * change could not be seen in it. 5% absorbs the motion of nearly every cell
 * between two sweeps the host bar accepts — the one pair this document has
 * evidence for spread at most 5.5%, with almost every cell far tighter — while
 * a change the size of the bar itself still fails. It is the resolution of the
 * document, stated: a ratio claim within 5% of 1, such as §5's SIMD gain, is
 * checked only to that resolution.
 */
export const TOLERANCE = 0.05;

/**
 * A stage share (§1, §1.1) passes within half a point, whatever its size. A
 * share is a ratio inside one process; §1 records that two recordings back to
 * back agreed within 0.4 points on every share, so half a point is what a
 * re-recording should clear without a rewrite. Not relative: 5% of a 57% share
 * is three points, which is the size of the load burst §1 says moved
 * `ac_quantize` — a change, not noise.
 */
export const SHARE_FLOOR_POINTS = 0.5;

/**
 * The least sampling a chromahash-perf/3 run may have and still be a baseline.
 *
 * Four processes, an even count: a paired ratio is estimated over AB/BA blocks
 * of two rounds (`perf/probe.ts`), so an odd count leaves a round out, and with
 * fewer than four a cell's range across processes holds its median less often
 * than seven times in eight. Five blocks per process is the driver's default;
 * fewer and a process's minimum is a small sample of what it could have seen.
 * The driver lets either be lowered for a smoke test; the gate does not take
 * the result.
 */
export const MIN_PROCESSES = 4;
export const MIN_REPS = 5;

/**
 * The sweep mode §0's stability claim is about: two independent `bounded`
 * sweeps at one commit. A `full` run is a supplement holding only ids the
 * bounded matrix does not, so it shares no cell with either.
 */
export const STABILITY_MODE = "bounded";
export const SUPPLEMENT_MODE = "full";

/** A measured value with the interval the run recorded for it, if any. */
export interface Estimate {
  value: number;
  /** Bootstrap 95% interval across processes; null for a chromahash-perf/2 cell. */
  interval: [number, number] | null;
}

export const isEstimate = (v: unknown): v is Estimate =>
  typeof v === "object" && v !== null && "value" in v && "interval" in v;

interface Cell {
  id: string;
  /** chromahash-perf/2. Older runs reported the median as the headline. */
  nsPerOp?: number;
  medianNsPerOp: number;
  iqrPct: number;
  noisy: boolean;
  iters: number;
  /** chromahash-perf/3: the interval of `nsPerOp` across processes. */
  ci95NsPerOp?: [number, number];
  processMinNsPerOp?: number[];
}

export interface PairRecord {
  base: string;
  arm: string;
  ratio: number;
  ci95: [number, number];
  ratios?: number[];
}

export interface RunDoc {
  file: string;
  /**
   * The directory the run was committed under, `baselines/hosts/<host>/`.
   * Set by the loader; a fixture may leave it out, and it is then derived from
   * the run's own environment.
   */
  hostDir?: string;
  schema: string;
  git: { commit: string; dirty: boolean; digest?: string | null };
  host?: { id: string; machine: string };
  environment: {
    cpuModel: string;
    arch: string;
    cores: number;
    os?: string;
    preflight?: {
      loaded?: boolean;
      maxLoad?: number;
      loadavgStart?: number[] | null;
      loadavgRounds?: (number[] | null)[];
      loadavgEnd?: number[] | null;
    };
  };
  config: { mode: string; reps: number; processes?: number };
  cells: Cell[];
  /** chromahash-perf/3: paired ratios, base over arm. */
  pairs?: PairRecord[];
  /** chromahash-perf/3: names that are another cell's measurement. */
  aliases?: Record<string, string>;
  /**
   * Targets the driver could not run, with the reason it recorded. Swift is the
   * permanent case: its binding consumes a UniFFI xcframework only `xcodebuild`
   * can assemble, so the row is empty on every run made off macOS.
   */
  unavailable?: { target: string; reason: string; kind?: string }[];
}

/**
 * Why a target was not measured — and whether that is a fact about the host or
 * a fact about the target.
 *
 * `probeAvailability` used to answer only "did `bench-info` succeed", and the
 * gate skipped every row of every target that answered no. A missing binary, a
 * non-zero exit, a timeout and a crash were one outcome, so on macOS a genuine
 * Swift *build regression* was indistinguishable from no `xcodebuild`, and the
 * gate would have skipped the rows in both cases, reporting green.
 *
 *  - `absent`  — the binary is not there (spawn ENOENT). Nothing on this host
 *                could have measured it. Rows are skipped.
 *  - `broken`  — it is there and it failed: non-zero exit, timeout, crash.
 *                That is a regression, not an unavailable platform, and it is
 *                reported rather than skipped.
 *  - missing   — a run recorded before this distinction existed. Not skipped:
 *                the fail-safe direction is to report, since an old run cannot
 *                say which of the two it saw.
 */
type Availability = "absent" | "broken" | "unclassified";

interface Unavailable {
  reason: string;
  kind: Availability;
}

export function classify(kind: string | undefined): Availability {
  return kind === "absent" || kind === "broken" ? kind : "unclassified";
}

/** A host's key: OS, architecture and CPU model, slugged (`perf/host.ts`). */
export function hostKeyOf(env: RunDoc["environment"] | undefined): string {
  return hostKey({
    os: env?.os ?? "unknown",
    arch: env?.arch ?? "unknown",
    cpuModel: env?.cpuModel ?? "unknown",
  });
}

const targetOf = (id: string): string => id.split("/")[1] ?? "";

/**
 * Why a chromahash-perf/3 run cannot be a baseline at all, or null. A /3 run
 * must say what it sampled, where it came from and what the host was doing, or
 * the rules that read those fields pass it by default: a run with no `git`
 * block was neither dirty nor untraceable, and one with no preflight was never
 * loaded. /2 predates every one of these fields and is exempt.
 */
export function unreadable(doc: RunDoc): string | null {
  if (doc.schema !== SCHEMA) return null;
  const processes = doc.config?.processes;
  const reps = doc.config?.reps;
  if (
    processes === undefined ||
    processes < MIN_PROCESSES ||
    processes % 2 !== 0
  ) {
    return `${processes ?? "no"} process(es) per cell; a baseline needs an even count of at least ${MIN_PROCESSES} — regenerate with the driver's defaults`;
  }
  if (reps === undefined || reps < MIN_REPS) {
    return `${reps ?? "no"} block(s) per process; a baseline needs at least ${MIN_REPS} — regenerate with the driver's defaults`;
  }
  const g = doc.git;
  if (
    !g ||
    typeof g.commit !== "string" ||
    g.commit === "" ||
    g.commit === "unknown" ||
    typeof g.digest !== "string" ||
    typeof g.dirty !== "boolean"
  ) {
    return "no git commit, source digest and dirty bit recorded, so the run cannot be traced to a source state";
  }
  if (!doc.environment?.preflight) {
    return "no preflight recorded, so nothing says the host was quiet";
  }
  return null;
}

/**
 * Why a chromahash-perf/3 run was taken on a loaded host, or null.
 *
 * The bar is recomputed from the run's own core count, not read from it: the
 * driver's `--max-load` moves the bar it refuses at, and a run started under
 * `--max-load 50` was never `loaded` by its own account. Every reading is held
 * to it — the start and the start of every process round — so a run that
 * started quiet and became loaded fails too. The end reading is not: it trails
 * the run's own last minutes, batch cells included.
 */
export function loadProblem(doc: RunDoc): string | null {
  if (doc.schema !== SCHEMA) return null;
  const p = doc.environment?.preflight;
  if (!p) return null;
  if (p.loaded) {
    return "taken with --force-loaded above the load bar";
  }
  const bar = defaultMaxLoad(doc.environment.cores);
  const rounds = p.loadavgRounds ?? [];
  const processes = doc.config?.processes ?? 0;
  if (rounds.length < processes) {
    return `load recorded for ${rounds.length} of its ${processes} process rounds`;
  }
  const readings: [string, number[] | null | undefined][] = [
    ["the start", p.loadavgStart],
    ...rounds.map((l, i): [string, number[] | null] => [`round ${i + 1}`, l]),
  ];
  for (const [at, l] of readings) {
    const load1 = l?.[0];
    if (load1 === undefined || !Number.isFinite(load1)) {
      return `no load average recorded at ${at}, so nothing says the host was quiet then`;
    }
    if (load1 > bar) {
      return `1-minute load ${load1.toFixed(2)} at ${at}, above the bar of ${bar.toFixed(2)} for ${doc.environment.cores} threads`;
    }
  }
  return null;
}

/** Lookup order inside one host: the bounded runs as listed, then the supplement. */
const modeRank = (d: RunDoc): number =>
  d.config?.mode === STABILITY_MODE
    ? 0
    : d.config?.mode === SUPPLEMENT_MODE
      ? 1
      : 2;

export interface RunsOptions {
  /** The host the document is measured on. Default: the first run's. */
  primary?: string;
  /**
   * Names that are another cell's measurement, for runs too old to record their
   * own (`perf/plan.ts`'s aliases). A chromahash-perf/3 run carries them.
   */
  aliases?: Readonly<Record<string, string>>;
}

export class Runs {
  private readonly byId = new Map<
    string,
    { us: number; cell: Cell; from: string; interval: [number, number] | null }
  >();
  /** Every loaded run's own value for each of its cells, by file. */
  private readonly perRun = new Map<string, Map<string, number>>();
  private readonly pairById = new Map<string, PairRecord & { from: string }>();
  private readonly aliases = new Map<string, string>();
  readonly loaded: RunDoc[] = [];
  /** The loaded runs grouped by host, in lookup order within each. */
  readonly hosts = new Map<string, RunDoc[]>();
  readonly primary: string;
  /**
   * Same id, two runs of one host, further apart than `CROSS_RUN_TOLERANCE`:
   * the host did not hold its clock still across them. Compared across every
   * pair of a host's runs; runs of different hosts are never compared — a
   * macOS run and a Linux run of one cell disagreeing is not news.
   */
  readonly crossRunSpread: string[] = [];
  /** Same id twice inside one run: an integrity bug in the driver. */
  readonly duplicates: string[] = [];
  /**
   * One measurement under two names (`…/gradient` and `…/gradient/shipped`),
   * recorded as two cells by a run older than the alias, and disagreeing by
   * more than CROSS_RUN_TOLERANCE: the document would publish two different
   * figures for one piece of work.
   */
  readonly aliasDisagreements: string[] = [];
  /** A supplement re-measuring ids its host's bounded runs hold. */
  readonly overlaps: string[] = [];
  /** A run filed under a host directory its environment does not match. */
  readonly misfiled: string[] = [];
  /** A run taken on a loaded host, by its own record (`loadProblem`). */
  readonly loadedRuns: string[] = [];
  readonly dirty: string[] = [];
  /** Runs rejected outright, with the reason. */
  readonly rejected: string[] = [];
  /** Every id a binding asked for, so the gate can list the noisy ones. */
  readonly touched = new Set<string>();
  /**
   * Targets no loaded run could measure.
   *
   * A cell for one of these is not a document that has drifted and not a
   * measurement anybody forgot: it is a row this host cannot fill. Reporting it
   * as a missing cell made `verify:benchmark` unpassable on Linux — which is
   * every CI runner this job uses — and so made `continue-on-error` permanent
   * while its comment claimed it was pending a re-measurement.
   */
  readonly unavailable = new Map<string, Unavailable>();

  /**
   * The committed runs, parsed. Each is tagged with the baseline file it was
   * read from and, by the CLI, the host directory; reading them is the CLI's
   * job, so a fixture can stand in for a file.
   *
   * **Lookup.** The primary host's bounded runs, in the order given, are
   * authoritative; its supplement (`full`) is consulted only for ids no bounded
   * run holds, and is *failed* for holding any it does. Other hosts are
   * consulted only for targets the primary host recorded absent — a macOS run
   * fills the Swift rows and nothing else.
   */
  constructor(docs: RunDoc[], opts: RunsOptions = {}) {
    for (const [alias, id] of Object.entries(opts.aliases ?? {})) {
      this.aliases.set(alias, id);
    }
    const accepted: RunDoc[] = [];
    for (const doc of docs) {
      const file = doc.file;
      // chromahash-perf/1 reported the median as a cell's headline figure; /2
      // the minimum of one process; /3 the median of per-process minima. /1
      // means something else and is refused; /2 is read, held to the band.
      if (doc.schema !== SCHEMA && doc.schema !== LEGACY_SCHEMA) {
        this.rejected.push(
          `${file}: schema ${doc.schema ?? "(none)"}, expected ${SCHEMA} — regenerate with \`mise run benchmark\``,
        );
        continue;
      }
      if (doc.config?.mode === "quick") {
        this.rejected.push(
          `${file}: a --quick run is a one-rep smoke test of the bench contract, not a baseline`,
        );
        continue;
      }
      const why = unreadable(doc);
      if (why !== null) {
        this.rejected.push(`${file}: ${why}`);
        continue;
      }
      const own = hostKeyOf(doc.environment);
      const hostDir = doc.hostDir ?? own;
      if (hostDir !== own) {
        this.misfiled.push(
          `${hostDir}/${file}: recorded on ${own}, committed under ${hostDir}`,
        );
      }
      accepted.push({ ...doc, hostDir });
    }

    for (const doc of accepted) {
      const host = doc.hostDir as string;
      const list = this.hosts.get(host) ?? [];
      list.push(doc);
      this.hosts.set(host, list);
    }
    for (const [host, list] of this.hosts) {
      this.hosts.set(
        host,
        list
          .map((d, i) => ({ d, i }))
          .sort((a, b) => modeRank(a.d) - modeRank(b.d) || a.i - b.i)
          .map((x) => x.d),
      );
    }
    this.primary = opts.primary ?? accepted[0]?.hostDir ?? "";
    const primaryFirst = [
      ...(this.hosts.get(this.primary) ?? []),
      ...[...this.hosts.entries()]
        .filter(([h]) => h !== this.primary)
        .flatMap(([, l]) => l),
    ];

    for (const doc of primaryFirst) {
      const file = doc.file;
      const key = this.runKey(doc);
      this.loaded.push(doc);
      if (doc.git?.dirty) this.dirty.push(key);
      const loadedBy = loadProblem(doc);
      if (loadedBy !== null) this.loadedRuns.push(`${key}: ${loadedBy}`);
      for (const [alias, id] of Object.entries(doc.aliases ?? {})) {
        if (!this.aliases.has(alias)) this.aliases.set(alias, id);
      }
      for (const u of doc.unavailable ?? []) {
        const prior = this.unavailable.get(u.target);
        // A `broken` probe outranks an `absent` one: if any run got far enough
        // to see the target fail, "not built on this host" is not the story.
        if (
          !prior ||
          (prior.kind === "absent" && classify(u.kind) !== "absent")
        ) {
          this.unavailable.set(u.target, {
            reason: u.reason,
            kind: classify(u.kind),
          });
        }
      }

      const own = new Map<string, number>();
      for (const c of doc.cells) {
        if (own.has(c.id)) {
          this.duplicates.push(`${file}: duplicate cell id ${c.id}`);
          continue;
        }
        own.set(c.id, (c.nsPerOp ?? c.medianNsPerOp) / 1000);
      }
      this.perRun.set(key, own);
    }

    // Spread and overlap, host by host.
    for (const [host, list] of this.hosts) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i] as RunDoc;
        const ca = this.perRun.get(this.runKey(a)) ?? new Map();
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j] as RunDoc;
          const cb = this.perRun.get(this.runKey(b)) ?? new Map();
          const supplement =
            [a, b].filter((d) => d.config?.mode === SUPPLEMENT_MODE).length ===
            1;
          const shared: string[] = [];
          for (const [id, us] of ca) {
            const theirs = cb.get(id);
            if (theirs === undefined) continue;
            shared.push(id);
            const delta = spread(us, theirs);
            if (delta > CROSS_RUN_TOLERANCE) {
              this.crossRunSpread.push(
                `${id}: ${a.file} says ${us.toFixed(1)} us, ` +
                  `${b.file} says ${theirs.toFixed(1)} us (${(delta * 100).toFixed(1)}% apart, ${host})`,
              );
            }
          }
          if (supplement && shared.length > 0) {
            const [full, bounded] =
              a.config?.mode === SUPPLEMENT_MODE ? [a, b] : [b, a];
            this.overlaps.push(
              `${host}: ${full.file} re-measures ${shared.length} id(s) ${bounded.file} holds (e.g. ${shared[0]}) — a full run is a supplement; regenerate it with the current driver, which measures only ids the bounded matrix does not`,
            );
          }
        }
      }
    }

    // One measurement under two names, recorded twice by an old run.
    for (const doc of this.loaded) {
      const own = this.perRun.get(this.runKey(doc)) ?? new Map();
      for (const [alias, id] of this.aliases) {
        const a = own.get(alias);
        const b = own.get(id);
        if (a === undefined || b === undefined) continue;
        const d = spread(a, b);
        if (d > CROSS_RUN_TOLERANCE) {
          this.aliasDisagreements.push(
            `${doc.file}: ${alias} says ${a.toFixed(1)} us and ${id} says ${b.toFixed(1)} us (${(d * 100).toFixed(1)}% apart) — one encode, measured twice`,
          );
        }
      }
    }

    // The primary host is authoritative; another host fills a cell only for a
    // target the primary recorded absent and measured nothing of.
    const primaryRuns = this.hosts.get(this.primary) ?? [];
    const primaryTargets = new Set(
      primaryRuns.flatMap((d) => d.cells.map((c) => targetOf(c.id))),
    );
    const primaryAbsent = new Set(
      primaryRuns
        .flatMap((d) => d.unavailable ?? [])
        .filter((u) => classify(u.kind) === "absent")
        .map((u) => u.target)
        .filter((t) => !primaryTargets.has(t)),
    );
    for (const doc of primaryFirst) {
      const isPrimary = doc.hostDir === this.primary;
      for (const c of doc.cells) {
        if (this.byId.has(c.id)) continue;
        if (!isPrimary && !primaryAbsent.has(targetOf(c.id))) continue;
        const ci = c.ci95NsPerOp;
        this.byId.set(c.id, {
          us: (c.nsPerOp ?? c.medianNsPerOp) / 1000,
          cell: c,
          from: this.runKey(doc),
          interval:
            doc.schema === SCHEMA && ci ? [ci[0] / 1000, ci[1] / 1000] : null,
        });
      }
      for (const p of doc.pairs ?? []) {
        const id = `${p.base}|${p.arm}`;
        const base = this.byId.get(p.base);
        // A pair is read from the run its base cell is read from, so a ratio
        // never mixes one run's numerator with another's denominator.
        if (!this.pairById.has(id) && base?.from === this.runKey(doc)) {
          this.pairById.set(id, { ...p, from: this.runKey(doc) });
        }
      }
    }

    // "The union of what was measured wins over any single run's gap" — as a
    // second pass, over every cell any host supplied. Order-independent: a
    // target one run measured and another recorded absent is measured.
    for (const id of this.byId.keys()) {
      this.unavailable.delete(targetOf(id));
    }
  }

  /** How a run is named in messages: its file, under its host if there are several. */
  runKey(doc: RunDoc): string {
    return this.hosts.size > 1 ? `${doc.hostDir}/${doc.file}` : doc.file;
  }

  private resolveId(id: string): string {
    return this.byId.has(id) ? id : (this.aliases.get(id) ?? id);
  }

  has(id: string): boolean {
    return this.byId.has(this.resolveId(id));
  }

  /** Whether any committed run holds a cell for this target, at any id. */
  measuredTarget(target: string): boolean {
    for (const id of this.byId.keys()) {
      if (targetOf(id) === target) return true;
    }
    return false;
  }

  /** Microseconds per op. Throws if the id is not in any committed run. */
  us(id: string): number {
    return this.est(id).value;
  }

  /** Microseconds per op with its interval. Throws if the id is not committed. */
  est(id: string): Estimate {
    const real = this.resolveId(id);
    this.touched.add(real);
    const hit = this.byId.get(real);
    if (!hit) throw new MissingCell(id);
    return { value: hit.us, interval: hit.interval };
  }

  /**
   * `base` time over `arm` time. The run's own paired record when it has one —
   * a ratio taken process by process, with its interval — and otherwise the
   * ratio of the two cells, with none.
   */
  ratio(base: string, arm: string): Estimate {
    const b = this.resolveId(base);
    const a = this.resolveId(arm);
    const pair = this.pairById.get(`${b}|${a}`);
    if (pair) {
      this.touched.add(b);
      this.touched.add(a);
      return { value: pair.ratio, interval: pair.ci95 };
    }
    return { value: this.us(b) / this.us(a), interval: null };
  }

  cell(id: string): Cell | null {
    return this.byId.get(this.resolveId(id))?.cell ?? null;
  }

  /** Every id a binding resolved whose cell the driver flagged noisy. */
  noisyTouched(): string[] {
    return [...this.touched]
      .filter((id) => this.byId.get(id)?.cell.noisy)
      .sort();
  }

  get ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  /** One loaded run's own cells, microseconds by id; undefined if not loaded. */
  cellsOf(file: string): ReadonlyMap<string, number> | undefined {
    return this.perRun.get(file);
  }
}

/**
 * Everything about the committed runs themselves — not the document — that
 * fails the gate. Split out of the CLI so the selftest can drive each.
 */
export function runFailures(R: Runs): Failure[] {
  const out: Failure[] = [];
  const add = (
    column: string,
    documented: string,
    items: string[],
    detail: (s: string) => string,
    measured = "",
  ) => {
    for (const s of items) {
      out.push({
        where: "committed runs",
        column,
        row: s.split(":")[0] ?? "—",
        documented,
        measured: measured || column,
        detail: detail(s),
      });
    }
  };
  // A dirty tree means the numbers cannot be traced back to a source state,
  // which is how the 2026-08-29 baseline came to disagree with its document.
  add(
    "git.dirty",
    "clean tree",
    R.dirty,
    (f) =>
      `${f}: regenerate from a committed tree so the run traces to a revision`,
    "dirty",
  );
  add(
    "integrity",
    "one value per cell id",
    R.duplicates,
    (s) => s,
    "duplicate",
  );
  add(
    "cross-run spread",
    `within ${(CROSS_RUN_TOLERANCE * 100).toFixed(0)}% across one host's runs`,
    R.crossRunSpread,
    (s) => s,
    "outside",
  );
  add(
    "supplement",
    "full holds only ids bounded does not",
    R.overlaps,
    (s) => s,
    "overlap",
  );
  add(
    "alias",
    "one figure per measurement",
    R.aliasDisagreements,
    (s) => s,
    "disagree",
  );
  add(
    "host",
    "baselines/hosts/<the run's own host>/",
    R.misfiled,
    (s) => s,
    "misfiled",
  );
  add(
    "preflight.load",
    "every round started below the load bar",
    R.loadedRuns,
    (s) =>
      `${s} — so its figures are about the host's other work; re-run on a quiet host (benchmark:session waits for one)`,
    "loaded",
  );
  // A run the gate would not read is a baseline that is not there. Printing it
  // and carrying on let a --quick or a /1 run sit in perf-report-2.json while
  // the stability check reported one run committed and §0 said so.
  add(
    "run",
    "a run the gate can read as a baseline",
    R.rejected,
    (s) => s,
    "rejected",
  );
  for (const [host, list] of R.hosts) {
    const schemas = new Set(list.map((d) => d.schema));
    if (schemas.size > 1) {
      out.push({
        where: "committed runs",
        column: "schema",
        row: host,
        documented: "one schema per host",
        measured: [...schemas].join(", "),
        detail: `${host} mixes run formats; the reported value of a cell means a different statistic in each, so a re-measurement replaces the whole set`,
      });
    }
  }
  return out;
}

export class MissingCell extends Error {
  constructor(readonly id: string) {
    super(`no cell "${id}" in any committed run`);
  }
}

/** Relative distance between two timings of one cell, against the faster. */
export function spread(a: number, b: number): number {
  return Math.abs(a - b) / Math.min(a, b);
}

// ─── §0's host-stability claim ──────────────────────────────────────────────
//
// §0 publishes a host only after two independent bounded sweeps at one commit
// agreed within `CROSS_RUN_TOLERANCE` on every shared cell. That claim used to
// stand on the maintainer's word: one sweep was committed, the gate had no slot
// for a second, and the spread it computed was printed as a warning. It is now
// a result with three outcomes per host, and §0's own table row is held to the
// primary host's.

export interface Stability {
  /**
   * `pass` — two bounded runs, one commit, one host, at least one shared cell,
   *          none further apart than the tolerance.
   * `skip` — fewer than two bounded runs committed: nothing to compare, and the
   *          gate says so rather than reporting agreement.
   * `fail` — two are committed and they do not substantiate the claim.
   */
  status: "pass" | "skip" | "fail";
  /** The host checked. */
  host: string;
  /** The bounded runs compared, by file. */
  runs: string[];
  /** Cells every compared run holds. */
  shared: number;
  /** Widest spread over the shared cells, as a fraction; null if none. */
  widest: number | null;
  /** Why the status is not `pass`. */
  problems: string[];
}

/** The stability check for one host; the primary host by default. */
export function checkStability(R: Runs, host: string = R.primary): Stability {
  const bounded = (R.hosts.get(host) ?? []).filter(
    (d) => d.config?.mode === STABILITY_MODE,
  );
  const runs = bounded.map((d) => d.file);
  if (bounded.length < 2) {
    return {
      status: "skip",
      host,
      runs,
      shared: 0,
      widest: null,
      problems: [
        `${bounded.length} ${STABILITY_MODE} run(s) committed for ${host}; the check needs two`,
      ],
    };
  }

  const problems: string[] = [];
  const commits = new Set(bounded.map((d) => d.git?.commit));
  if (commits.size > 1) {
    const list = [...commits].join(", ");
    problems.push(
      `the ${STABILITY_MODE} runs are at different commits (${list}); the claim is about one commit measured twice`,
    );
  }
  const cpus = new Set(bounded.map((d) => d.environment?.cpuModel));
  if (cpus.size > 1) {
    const list = [...cpus].join(", ");
    problems.push(
      `the ${STABILITY_MODE} runs are from different CPUs (${list}); the claim is about one host`,
    );
  }
  const machines = new Set(
    bounded.map((d) => d.host?.machine).filter((m) => m !== undefined),
  );
  if (machines.size > 1) {
    problems.push(
      `the ${STABILITY_MODE} runs are from different machines with one CPU model (${[...machines].join(", ")}); the claim is about one host`,
    );
  }

  const maps = bounded.map(
    (d) => R.cellsOf(R.runKey(d)) ?? new Map<string, number>(),
  );
  const [first, ...rest] = maps;
  let shared = 0;
  let outside = 0;
  let widest: number | null = null;
  for (const [id, us] of first ?? []) {
    const all = [us];
    for (const m of rest) {
      const v = m.get(id);
      if (v !== undefined) all.push(v);
    }
    if (all.length < maps.length) continue;
    shared++;
    const d = spread(Math.max(...all), Math.min(...all));
    if (d > CROSS_RUN_TOLERANCE) outside++;
    if (widest === null || d > widest) widest = d;
  }
  if (shared === 0) {
    problems.push(`the ${STABILITY_MODE} runs share no cell`);
  } else if (outside > 0) {
    problems.push(
      `${outside} of ${shared} shared cell(s) more than ` +
        `${(CROSS_RUN_TOLERANCE * 100).toFixed(0)}% apart, the widest ` +
        `${((widest ?? 0) * 100).toFixed(1)}%`,
    );
  }

  return {
    status: problems.length > 0 ? "fail" : "pass",
    host,
    runs,
    shared,
    widest,
    problems,
  };
}

/** How §0 names the row, and what the gate requires it to quote on "Yes". */
export const STABILITY_ROW =
  /^[>\s]*\|\s*This host's [^|]*agreement\s*\|([^|]*)\|/;

/**
 * §0's table says whether the host-stability claim is reproducible from the
 * tree. Hold that row to the check, in both directions: "Yes" needs a passing
 * check and must quote its shared-cell count and widest spread, so the prose
 * cannot drift from the runs; "No" while the check passes understates the
 * tree, and is failed so the row is updated in the change that lands the run.
 */
export function checkStabilityClaim(doc: string, s: Stability): Failure[] {
  const where = "§0 — reproducibility table";
  const column = "Reproducible from the tree?";
  const row = "This host's cross-run agreement";
  const hit = doc
    .split("\n")
    .map((line) => STABILITY_ROW.exec(line))
    .find((m) => m !== null);
  if (!hit) {
    return [
      {
        where,
        column,
        row,
        documented: "(row not found)",
        measured: s.status,
        detail: `§0 must state whether its host-stability claim is reproducible; no line matched ${STABILITY_ROW}`,
      },
    ];
  }

  const cell = clean(hit[1] ?? "");
  const says = /^yes\b/i.test(cell) ? "Yes" : /^no\b/i.test(cell) ? "No" : "";
  const documented = cell.slice(0, 60);
  if (says === "") {
    return [
      {
        where,
        column,
        row,
        documented,
        measured: s.status,
        detail: 'the cell must begin with "Yes" or "No"',
      },
    ];
  }
  if (says === "Yes" && s.status !== "pass") {
    return [
      {
        where,
        column,
        row,
        documented,
        measured: s.status,
        detail: `the check did not pass: ${s.problems.join("; ")}`,
      },
    ];
  }
  if (says === "No" && s.status === "pass") {
    return [
      {
        where,
        column,
        row,
        documented,
        measured: s.status,
        detail: `${s.runs.join(" and ")} agree on ${s.shared} shared cells; the row understates the tree — change it to "Yes"`,
      },
    ];
  }
  if (says === "Yes") {
    const widest = `${((s.widest ?? 0) * 100).toFixed(1)}%`;
    // Bounded on the left, so "2 shared cells" is not found inside "12 shared
    // cells".
    const quoted = (q: string): boolean =>
      new RegExp(`(^|[^0-9.])${q.replace(/[.%]/g, "\\$&")}`).test(cell);
    const missing = [`${s.shared} shared cells`, `widest ${widest}`].filter(
      (q) => !quoted(q),
    );
    if (missing.length > 0) {
      return [
        {
          where,
          column,
          row,
          documented,
          measured: `${s.shared} shared cells, widest ${widest}`,
          detail: `the row must quote the check's figures: missing ${missing.map((m) => `"${m}"`).join(", ")}`,
        },
      ];
    }
  }
  return [];
}

// ─── Bindings ───────────────────────────────────────────────────────────────

/** Reads a named column out of the row being checked. */
export type Row = (column: string) => string;
/**
 * A resolver returns the measured value of one cell: microseconds for a time
 * column, a bare number for a ratio or a percentage, or an `Estimate` carrying
 * the interval the run recorded for it. Null marks the cell deliberately
 * unbound.
 */
export type Resolve = (row: Row, R: Runs) => number | Estimate | null;

export interface Binding {
  section: string;
  index: number;
  title: string;
  /** Column header (exact) -> resolver. Unlisted columns are not checked. */
  columns: Record<string, Resolve>;
  /**
   * `share`: a percentage column is a stage share and passes within
   * SHARE_FLOOR_POINTS. Otherwise a percentage is a difference between two
   * timings (§4's "vs shipped") and passes within TOLERANCE of its ratio.
   */
  rule?: "share";
}

/**
 * A header or row label without its parenthetical aside: the document writes
 * "auto (12)" for the thread count and "shipped (scale_fit=2 ...)" for the
 * lever, and in both the parenthesis is commentary, not the name.
 */
export const bare = (s: string): string =>
  clean(s)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();

// ─── §1's stages baseline ───────────────────────────────────────────────────

export const STAGES_BASELINE = "perf-stages.json";
export const STAGES_SCHEMA = "chromahash-perf-stages/1";

export interface StageCell {
  ns: Record<string, number>;
  sharePct: Record<string, number>;
  git: { rev: string; dirty: boolean; digest?: string | null };
}

/**
 * The stages baseline, or the reason there is none. `text` is the file's
 * contents, or null when there is no file.
 *
 * This returned a bare `null` for "no file" and for "wrong schema" alike, and
 * §1's resolvers turned that into `null` per cell, which `checkTable` counts as
 * `unbound` — a *pass*. Deleting `perf-stages.json` therefore produced a green
 * run for the one table this gate exists for: thirty cells silently reclassified
 * as deliberately unbound, and all thirteen `PROSE_CLAIMS` skipped along with
 * them, since both blocks are guarded by `if (STAGES)`. `Runs` has never
 * behaved that way — a missing perf report exits 1 with the command to
 * regenerate it. §1 gets the same treatment.
 */
export function parseStages(text: string | null): {
  cells: Record<string, StageCell> | null;
  error: string | null;
} {
  return parseStageFile<StageCell>(text, {
    baseline: STAGES_BASELINE,
    schema: STAGES_SCHEMA,
    absent:
      "record §1's three columns with `mise run benchmark:stages 100 100 1`, `… 512 512 1`, `… 512 512 4`",
    rerecord: "re-record §1's three columns with `mise run benchmark:stages`",
  });
}

/** What `parseStages` and `parseDecodeStages` share: every way of not having a file. */
function parseStageFile<C>(
  text: string | null,
  o: { baseline: string; schema: string; absent: string; rerecord: string },
): { cells: Record<string, C> | null; error: string | null } {
  const where = `tools/comparison/baselines/${o.baseline}`;
  if (text === null) {
    return { cells: null, error: `${where} does not exist — ${o.absent}` };
  }
  let doc: { schema?: string; cells?: Record<string, C> };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch (e) {
    return {
      cells: null,
      error: `${where} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (doc.schema !== o.schema) {
    return {
      cells: null,
      error: `${where}: schema ${doc.schema ?? "(none)"}, expected ${o.schema} — ${o.rerecord}`,
    };
  }
  if (!doc.cells || Object.keys(doc.cells).length === 0) {
    return { cells: null, error: `${where} holds no cells` };
  }
  return { cells: doc.cells, error: null };
}

// ─── §1.1's decode-stages baseline ──────────────────────────────────────────

export const DECODE_STAGES_BASELINE = "perf-decode-stages.json";
export const DECODE_STAGES_SCHEMA = "chromahash-perf-decode-stages/1";

/** The commands that record §1.1, one per column. */
export const DECODE_STAGES_COMMANDS = [
  "mise run benchmark:decode-stages 100 100 1 2000",
  "mise run benchmark:decode-stages 100 100 4 20",
  "mise run benchmark:decode-stages 100 100 4 200 32x32",
] as const;

/**
 * One column of §1.1: a gradient of `width`×`height` encoded at `tier`, then
 * decoded at its natural raster (`cap: null`) or capped, stage by stage.
 */
export interface DecodeStageCell extends StageCell {
  width: number;
  height: number;
  tier: number;
  iters: number;
  cap: { width: number; height: number } | null;
  render: { width: number; height: number };
  hashBytes: number;
  /** Spec decode vectors the instrumented build reproduced before timing. */
  vectorsChecked: number;
}

/** §1.1's baseline, refused on exactly the terms §1's is. */
export function parseDecodeStages(text: string | null): {
  cells: Record<string, DecodeStageCell> | null;
  error: string | null;
} {
  return parseStageFile<DecodeStageCell>(text, {
    baseline: DECODE_STAGES_BASELINE,
    schema: DECODE_STAGES_SCHEMA,
    absent: `record §1.1's three columns with ${DECODE_STAGES_COMMANDS.map((c) => `\`${c}\``).join(", ")}`,
    rerecord:
      "re-record §1.1's three columns with `mise run benchmark:decode-stages`",
  });
}

/** The key the recorder files a decode cell under, derived from its fields. */
export const decodeCellKey = (c: DecodeStageCell): string =>
  `${c.width}x${c.height}-t${c.tier}-${c.cap ? `cap${c.cap.width}x${c.cap.height}` : "natural"}`;

/**
 * Figures the prose derives from §1's table, bound to the same baseline.
 *
 * The table is checked cell by cell; the sentences underneath it were not, and
 * that is where §1's numbers actually drifted. "the per-pixel colour pipeline
 * is 16.6% — `linearize` 5.5%" is a sum of three cells and one of the cells,
 * and both were wrong: `linearize` measures 5.4340%, which the table two dozen
 * lines above correctly rounds to 5.4%, and the three stages sum to 16.5183%.
 * The 16.6% is what you get by rounding each part up first and adding the
 * rounded parts, and it was repeated in §10 and in the lever table, so a single
 * transcription slip became three published figures no run supports.
 *
 * A derived figure is a claim like any other. These bind the sentence to the
 * arithmetic, so restating a cell in prose is checked the same way as writing
 * it in the table.
 */
export interface ProseClaim {
  what: string;
  /** Must match exactly once in the document, capturing the figure. */
  pattern: RegExp;
  /** The cell key in `perf-stages.json`. */
  cell: string;
  /** Stages to sum; a single-element list is a single cell. */
  stages: string[];
}

// ─── Checking ───────────────────────────────────────────────────────────────

export interface Failure {
  where: string;
  column: string;
  row: string;
  documented: string;
  measured: string;
  detail?: string;
}

/** One cell `--fix` will rewrite: line in the document, column, new text. */
export interface Edit {
  line: number;
  cellIndex: number;
  text: string;
}

export interface Counters {
  checked: number;
  unbound: number;
  /** TBD cells a committed run can fill: `--fix` writes them. */
  placeholders: number;
  /** TBD cells no committed run can fill yet. */
  pending: number;
  unavailable: number;
  /** Checked values that passed on the interval or the band, not exactly. */
  tolerated: number;
}

/**
 * How a documented value was found to agree with its cell, or that it did not.
 *
 *  - `exact`    — it is the measured value, rounded to the precision written.
 *  - `interval` — it lies inside the cell's own interval across processes
 *                 (widened by half the last written digit, for the rounding).
 *  - `band`     — it lies within TOLERANCE of the measured value: within
 *                 SHARE_FLOOR_POINTS for a stage
 *                 share, and within TOLERANCE × 100 points for a percentage
 *                 that is a difference of two timings.
 *  - `outside`  — none of these; `--fix` rewrites it.
 *
 * Until the methods revision this was `exact` alone, against one run's rounded
 * output, so a re-run moved most values in the document and `--fix` rewrote
 * them all. The rule is now what the measurement can support: a value inside
 * the cell's interval or the band is as good as the run can say it is, and
 * only a value outside both is a disagreement.
 */
export type Verdict = "exact" | "interval" | "band" | "outside";

export function agreement(
  doc: DocNumber,
  measured: Estimate,
  rule: "share" | "default" = "default",
): { verdict: Verdict; shown: string } {
  const scale = TIME_UNITS.has(doc.unit) ? (PER_US[doc.unit] ?? 1) : 1;
  const m = measured.value / scale;
  const rounded = Number(m.toFixed(doc.decimals));
  const shown = `${rounded.toFixed(doc.decimals)}${suffixOf(doc.unit)}`;
  if (Math.abs(rounded - doc.value) < 1e-9) return { verdict: "exact", shown };
  const half = 0.5 * 10 ** -doc.decimals;
  const iv = measured.interval;
  if (iv) {
    const lo = Math.min(iv[0], iv[1]) / scale;
    const hi = Math.max(iv[0], iv[1]) / scale;
    if (doc.value >= lo - half && doc.value <= hi + half) {
      return { verdict: "interval", shown };
    }
  }
  const tol =
    doc.unit === "percent"
      ? rule === "share"
        ? SHARE_FLOOR_POINTS
        : TOLERANCE * 100
      : TOLERANCE * Math.abs(m);
  return {
    verdict: Math.abs(doc.value - m) <= tol + half + 1e-12 ? "band" : "outside",
    shown,
  };
}

const suffixOf = (unit: Unit): string =>
  unit === "ratio"
    ? "×"
    : unit === "percent"
      ? "%"
      : ` ${unit === "us" ? "µs" : unit}`;

/**
 * Render a measured value the way the document writes that column: same unit,
 * same number of decimals, same emphasis. Used by --fix so a rewritten cell is
 * indistinguishable from a hand-written one.
 */
function formatLike(doc: DocNumber, measuredUs: number, raw: string): string {
  const measured = TIME_UNITS.has(doc.unit)
    ? measuredUs / (PER_US[doc.unit] ?? 1)
    : measuredUs;
  const body = `${measured.toFixed(doc.decimals)}${suffixOf(doc.unit)}`;
  // Preserve bold emphasis, which the document uses to mark a headline figure.
  return /^\*\*.*\*\*$/.test(raw.trim()) ? `**${body}**` : body;
}

export function checkTable(
  binding: Binding,
  table: DocTable,
  R: Runs,
  failures: Failure[],
  counters: Counters,
  edits: Edit[],
): void {
  const headerIndex = new Map<string, number>();
  table.header.forEach((h, i) => {
    headerIndex.set(clean(h).toLowerCase(), i);
    headerIndex.set(bare(h).toLowerCase(), i);
  });

  const columnOf = (name: string): number | undefined =>
    headerIndex.get(name.toLowerCase()) ??
    headerIndex.get(bare(name).toLowerCase());

  table.rows.forEach((cellsOfRow, rowIdx) => {
    const row: Row = (column) => {
      const i = columnOf(column);
      return i === undefined ? "" : (cellsOfRow[i] ?? "");
    };
    const rowLabel = clean(cellsOfRow[0] ?? "");
    const sourceLine = table.rowLines[rowIdx] ?? table.line;

    for (const [column, resolve] of Object.entries(binding.columns)) {
      const i = columnOf(column);
      if (i === undefined) continue;
      const raw = cellsOfRow[i] ?? "";
      const placeholder = parsePlaceholder(raw);
      const doc = placeholder ?? parseDocNumber(raw);

      // Before `!doc`, not after. A row naming a target no committed run
      // measured is not drift and not a forgotten measurement — it is a row
      // this host cannot fill, and the document says so with a marker beside
      // it. But that is a claim about the *cell*, so the cell has to be read
      // before it can be honoured, and it was being read afterwards: a prose
      // cell left at `!doc` first and never arrived, while a cell carrying a
      // number arrived and was waved through. Exactly inverted. The only case
      // the skip actually caught was the one it must never catch.
      // `R.unavailable` is keyed on the target name the driver records, which
      // is the row label verbatim — "Rust (scalar)" included. Looking it up
      // under `bare(rowLabel)` alone stripped the parenthetical, so a
      // parenthesised target could never match its own record. Try the label as
      // written first, then bare.
      const rowLabelClean = clean(rowLabel);
      const rowTarget = R.unavailable.has(rowLabelClean)
        ? rowLabelClean
        : bare(rowLabel);
      const unavailable = R.unavailable.get(rowTarget);
      const marker = parseUnavailableMarker(raw);
      const where = `§${binding.section} ${binding.title} (line ${sourceLine})`;
      if (unavailable) {
        // Only an *absent* target may be skipped. A target that was found and
        // then failed its probe is a regression, and skipping its rows is how a
        // broken Swift build passes for "no xcodebuild".
        if (unavailable.kind !== "absent") {
          failures.push({
            where,
            column,
            row: rowLabel,
            documented: raw === "" ? "(empty)" : raw,
            measured: "—",
            detail:
              unavailable.kind === "broken"
                ? `${rowTarget}'s probe was found and failed (${unavailable.reason.split("\n")[0]}) — that is a regression in the target, not an unavailable platform, so this row is not skipped`
                : `${rowTarget} is recorded unavailable by a run made before absent/broken were distinguished, so it cannot be told apart from a build regression — regenerate the run with \`mise run benchmark\``,
          });
          continue;
        }
        if (marker) {
          counters.unavailable++;
          continue;
        }
        // No committed run holds a measurement for this target, so whatever is
        // in this cell is not backed by one — a number least of all.
        failures.push({
          where,
          column,
          row: rowLabel,
          documented: raw === "" ? "(empty)" : raw,
          measured: "—",
          detail: `no committed run measured ${rowTarget} (${unavailable.reason}), so this cell cannot be verified — write it as a marker such as "*macOS only*"`,
        });
        continue;
      }
      // And the converse. A marker on a target the committed runs *did* measure
      // is a row that has stopped describing the run behind it, which is the
      // same drift in the other direction and just as invisible.
      //
      // But only if a run measured it. The message asserts "a committed run
      // measured T" and nothing checked that: a target no run ever *probed* —
      // `--impls Rust,Go` leaves seven of them — is in neither `unavailable`
      // nor `cells`, and the gate stated a falsehood about it. Ask `R`.
      if (marker) {
        if (!R.measuredTarget(rowTarget)) {
          failures.push({
            where,
            column,
            row: rowLabel,
            documented: raw,
            measured: "—",
            detail: `cell reads "${marker}", but no committed run measured ${rowTarget} and none recorded it as unavailable either — it was never probed, so nothing here is evidence either way (was the run made with \`--impls\`?)`,
          });
          continue;
        }
        failures.push({
          where,
          column,
          row: rowLabel,
          documented: raw,
          measured: "—",
          detail: `cell reads "${marker}" but a committed run measured ${rowTarget}`,
        });
        continue;
      }
      if (!doc) continue;

      let resolved: number | Estimate | null;
      try {
        resolved = resolve(row, R);
      } catch (e) {
        if (e instanceof MissingCell) {
          failures.push({
            where: `§${binding.section} ${binding.title} (line ${table.line})`,
            column,
            row: rowLabel,
            documented: raw,
            measured: "—",
            detail: e.message,
          });
          if (placeholder) counters.pending++;
          continue;
        }
        throw e;
      }
      if (resolved === null) {
        counters.unbound++;
        continue;
      }
      const measured: Estimate = isEstimate(resolved)
        ? resolved
        : { value: resolved, interval: null };
      const expected = measured.value;

      // A placeholder is a bound cell whose number has not been measured yet.
      // It always fails, so a document cannot be published still carrying one,
      // and --fix knows exactly what to write in its place.
      if (placeholder) {
        counters.placeholders++;
        edits.push({
          line: sourceLine,
          cellIndex: i,
          text: formatLike(doc, expected, raw),
        });
        failures.push({
          where: `§${binding.section} ${binding.title} (line ${sourceLine})`,
          column,
          row: rowLabel,
          documented: raw,
          measured: formatLike(doc, expected, raw),
          detail: "placeholder — run with --fix against a committed run",
        });
        continue;
      }

      counters.checked++;
      const verdict = agreement(doc, measured, binding.rule ?? "default");
      if (verdict.verdict === "interval" || verdict.verdict === "band") {
        counters.tolerated++;
      }
      if (verdict.verdict === "outside") {
        edits.push({
          line: sourceLine,
          cellIndex: i,
          text: formatLike(doc, expected, raw),
        });
        failures.push({
          where: `§${binding.section} ${binding.title} (line ${sourceLine})`,
          column,
          row: rowLabel,
          documented: raw,
          measured: verdict.shown,
        });
      }
    }
  });
}

/**
 * §1's baseline gets the provenance check its sibling already had. A stages
 * file is *merged* one cell per run — the table is three columns and each is
 * its own invocation — so it is the one artifact here that can hold cells from
 * three different builds and read as one measurement. Nothing looked. The
 * dirty flag was recorded on every cell and read on none, while the same flag
 * on a perf-report has failed the run since that check was written.
 */
export function checkStagesProvenance(
  stages: Record<string, StageCell>,
): Failure[] {
  return checkOneCleanCommit(stages, STAGES_BASELINE, "§1", "benchmark:stages");
}

function checkOneCleanCommit(
  stages: Record<string, StageCell>,
  baseline: string,
  section: string,
  task: string,
): Failure[] {
  const failures: Failure[] = [];
  const dirty = Object.entries(stages)
    .filter(([, c]) => c.git?.dirty)
    .map(([k]) => k);
  if (dirty.length > 0) {
    failures.push({
      where: baseline,
      column: "git.dirty",
      row: dirty.join(", "),
      documented: "—",
      measured: "dirty",
      detail: `recorded from a working tree with uncommitted changes, so these shares cannot be traced to a source state — re-run ${task} from a clean tree`,
    });
  }
  const revs = new Map<string, string[]>();
  for (const [key, cell] of Object.entries(stages)) {
    const rev = cell.git?.rev ?? "(none)";
    revs.set(rev, [...(revs.get(rev) ?? []), key]);
  }
  if (revs.size > 1) {
    failures.push({
      where: baseline,
      column: "git.rev",
      row: [...revs.keys()].join(" vs "),
      documented: "one commit",
      measured: `${revs.size} commits`,
      detail: `${section} reads as one measurement across its columns, and these cells are from different builds: ${[...revs.entries()].map(([r, ks]) => `${r} (${ks.join(", ")})`).join("; ")}`,
    });
  }
  return failures;
}

/**
 * §1.1's provenance: §1's one-clean-commit rule, plus what a decode cell must
 * carry to mean what §1.1 says it means.
 *
 * - `vectorsChecked` ≥ 1. §1.1 says the instrumented build reproduced the
 *   spec's decode vectors before timing; this is the field that says it did.
 * - The key matches the fields, so a column header cannot be bound to a cell
 *   that measured something else.
 * - `iters` ≥ 1, `whole_decode` > 0, and `whole_decode` ≥ `stage_sum`.
 * - Every share is its own `ns` over `whole_decode`, and together they cover
 *   every recorded stage — so the file cannot be hand-edited in one field and
 *   not the other, which is exactly how §1's shares could drift from its ns.
 */
export function checkDecodeStagesProvenance(
  stages: Record<string, DecodeStageCell>,
): Failure[] {
  const failures = checkOneCleanCommit(
    stages,
    DECODE_STAGES_BASELINE,
    "§1.1",
    "benchmark:decode-stages",
  );
  const fail = (
    row: string,
    column: string,
    measured: string,
    detail: string,
  ) =>
    failures.push({
      where: DECODE_STAGES_BASELINE,
      column,
      row,
      documented: "—",
      measured,
      detail,
    });
  for (const [key, c] of Object.entries(stages)) {
    if (!Number.isInteger(c.vectorsChecked) || c.vectorsChecked < 1) {
      fail(
        key,
        "vectorsChecked",
        String(c.vectorsChecked),
        "no record that the instrumented build reproduced the spec's decode vectors before timing — re-record with benchmark:decode-stages",
      );
    }
    const derived = decodeCellKey(c);
    if (derived !== key) {
      fail(
        key,
        "key",
        derived,
        "the cell's fields describe a different measurement from the key it is filed under",
      );
    }
    if (!Number.isInteger(c.iters) || c.iters < 1) {
      fail(
        key,
        "iters",
        String(c.iters),
        "a cell must average at least one decode",
      );
    }
    const ns = c.ns ?? {};
    const whole = ns.whole_decode;
    const sum = ns.stage_sum;
    if (
      whole === undefined ||
      !(whole > 0) ||
      sum === undefined ||
      sum > whole
    ) {
      fail(
        key,
        "ns",
        `whole_decode=${whole} stage_sum=${sum}`,
        "whole_decode must be positive and no smaller than the sum of its stages",
      );
      continue;
    }
    const stageKeys = Object.keys(ns)
      .filter((k) => k !== "whole_decode" && k !== "stage_sum")
      .sort();
    const shareKeys = Object.keys(c.sharePct ?? {}).sort();
    if (stageKeys.join(",") !== shareKeys.join(",")) {
      fail(
        key,
        "sharePct",
        shareKeys.join(", "),
        `shares must cover exactly the recorded stages (${stageKeys.join(", ")})`,
      );
      continue;
    }
    // Written as "not within", so a share that is not a number fails too:
    // every comparison with NaN is false.
    const off = stageKeys.filter(
      (k) =>
        !(
          Math.abs(
            (c.sharePct[k] ?? Number.NaN) -
              ((ns[k] ?? Number.NaN) * 100) / whole,
          ) <= 1e-9
        ),
    );
    if (off.length > 0) {
      fail(
        key,
        "sharePct",
        off.join(", "),
        "a share disagrees with its own ns over whole_decode",
      );
    }
  }
  return failures;
}

/**
 * The rows of a stage table against the stages its baseline records. A stage
 * the table omits is time the table silently leaves out, and a row naming no
 * recorded stage is a figure nothing backs; both fail. `labels` are the
 * table's row labels, cleaned.
 */
export function checkStageRowCoverage(
  labels: readonly string[],
  stages: Record<string, StageCell>,
  where: string,
): Failure[] {
  const failures: Failure[] = [];
  const rows = new Set(labels);
  for (const [key, cell] of Object.entries(stages)) {
    const recorded = Object.keys(cell.sharePct ?? {});
    const omitted = recorded.filter((s) => !rows.has(s));
    const unbacked = [...rows].filter((r) => !recorded.includes(r));
    if (omitted.length > 0 || unbacked.length > 0) {
      failures.push({
        where,
        column: key,
        row: [...omitted, ...unbacked].join(", "),
        documented: [...rows].join(", "),
        measured: recorded.join(", "),
        detail: [
          omitted.length > 0
            ? `recorded but not in the table: ${omitted.join(", ")}`
            : "",
          unbacked.length > 0
            ? `in the table but not recorded: ${unbacked.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("; "),
      });
    }
  }
  return failures;
}

/** One figure `--fix` will rewrite in prose: a character range of the document. */
export interface ProseEdit {
  index: number;
  length: number;
  text: string;
}

/** Find a claim's one match, with the capture group's offset for `--fix`. */
function matchOnce(
  doc: string,
  pattern: RegExp,
): { count: number; text?: string; index?: number } {
  const flags = new Set([...pattern.flags, "g", "d"]);
  const all = [
    ...doc.matchAll(new RegExp(pattern.source, [...flags].join(""))),
  ];
  if (all.length !== 1) return { count: all.length };
  const m = all[0] as RegExpMatchArray & { indices?: [number, number][] };
  const span = m.indices?.[1];
  return span && m[1] !== undefined
    ? { count: 1, text: m[1], index: span[0] }
    : { count: 1 };
}

const placesOf = (text: string): number => {
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
};

/**
 * Apply prose edits and table edits to the document. Prose first, in reverse
 * order of position, so no edit moves another's offset; neither kind adds or
 * removes a line, so the table edits' line numbers still hold.
 */
export function applyEdits(
  doc: string,
  edits: readonly Edit[],
  prose: readonly ProseEdit[],
): string {
  let text = doc;
  for (const e of [...prose].sort((a, b) => b.index - a.index)) {
    text = text.slice(0, e.index) + e.text + text.slice(e.index + e.length);
  }
  const lines = text.split("\n");
  const byLine = new Map<number, Edit[]>();
  for (const e of edits) {
    const list = byLine.get(e.line);
    if (list) list.push(e);
    else byLine.set(e.line, [e]);
  }
  for (const [line, group] of byLine) {
    const raw = lines[line];
    if (raw === undefined) continue;
    // Keep the row's own leading whitespace and outer pipes.
    const indent = raw.slice(0, raw.length - raw.trimStart().length);
    const parts = cells(raw);
    for (const e of group) parts[e.cellIndex] = e.text;
    lines[line] = `${indent}| ${parts.join(" | ")} |`;
  }
  return lines.join("\n");
}

/**
 * The prose figures §1 and §1.1 derive from their tables. Checked against the
 * same baseline the table is, by the same share rule (`agreement`): within
 * SHARE_FLOOR_POINTS — so a re-recording that moves a
 * share by a few tenths of a point does not rewrite every sentence quoting it,
 * and one that moves it further does.
 */
export function checkProseClaims(
  doc: string,
  stages: Record<string, StageCell>,
  claims: readonly ProseClaim[],
  baseline: string = STAGES_BASELINE,
): { failures: Failure[]; checked: number; edits: ProseEdit[] } {
  const failures: Failure[] = [];
  const edits: ProseEdit[] = [];
  let checked = 0;
  for (const claim of claims) {
    const hit = matchOnce(doc, claim.pattern);
    if (hit.count !== 1) {
      failures.push({
        where: "PERFORMANCE.md prose",
        column: claim.what,
        row: "—",
        documented: `${hit.count} match(es)`,
        measured: "—",
        detail:
          hit.count === 0
            ? "the sentence was edited without updating its binding here, so the figure is no longer checked"
            : "the pattern must name one figure",
      });
      continue;
    }
    const quotedRaw = hit.text;
    if (quotedRaw === undefined) continue;
    // A claim bound to a cell or stage the baseline does not hold is a figure
    // nothing checks, and it used to be skipped without a word — so a claim
    // could never fail by pointing at the wrong cell.
    const cell = stages[claim.cell];
    const absent = cell
      ? claim.stages.filter((st) => cell.sharePct[st] === undefined)
      : [];
    if (!cell || absent.length > 0) {
      failures.push({
        where: "PERFORMANCE.md prose",
        column: claim.what,
        row: claim.stages.join(" + "),
        documented: `${quotedRaw}%`,
        measured: "—",
        detail: cell
          ? `${claim.cell} in ${baseline} records no ${absent.join(", ")}`
          : `${baseline} has no cell ${claim.cell}`,
      });
      continue;
    }
    const quoted = Number(quotedRaw);
    if (!Number.isFinite(quoted)) {
      failures.push({
        where: "PERFORMANCE.md prose",
        column: claim.what,
        row: "—",
        documented: quotedRaw,
        measured: "—",
        detail: "captured text is not a number",
      });
      continue;
    }
    let expected = 0;
    for (const st of claim.stages) expected += cell.sharePct[st] ?? 0;
    const places = placesOf(quotedRaw);
    checked++;
    const v = agreement(
      { value: quoted, unit: "percent", decimals: places },
      { value: expected, interval: null },
      "share",
    );
    if (v.verdict === "outside") {
      failures.push({
        where: "PERFORMANCE.md prose",
        column: claim.what,
        row: claim.stages.join(" + "),
        documented: `${quotedRaw}%`,
        measured: `${expected.toFixed(Math.max(places, 2))}%`,
        detail: `from ${claim.cell} in ${baseline}`,
      });
      if (hit.index !== undefined) {
        edits.push({
          index: hit.index,
          length: quotedRaw.length,
          text: expected.toFixed(places),
        });
      }
    }
  }
  return { failures, checked, edits };
}

// ─── Figures the prose derives from the sweeps ──────────────────────────────

/** What a sweep claim's resolver can see beyond the runs. */
export interface ClaimContext {
  /** The table counters, as they will stand once `--fix` has run. */
  counters: Counters;
  stability: Stability;
}

/**
 * A figure a sentence derives from the perf runs — a time, a ratio, a gain —
 * rather than from §1's or §1.1's stage shares. §5's "2%", §6's "34.0 ms" and
 * "38×", §2's 234 ms restated in §12, §0's own counts: each was a number
 * transcribed from a table and checked by nothing, so a re-measurement that
 * moved the table left the sentence stating the old figure.
 *
 * The pattern's one capture group holds the figure, or `TBD` where the
 * measurement it restates does not exist yet. A TBD fails loudly — it is a
 * figure the document has promised and not delivered — and `--fix` fills it
 * the moment a committed run can.
 */
export interface SweepClaim {
  what: string;
  /** Must match exactly once in the document; group 1 is the figure or TBD. */
  pattern: RegExp;
  /**
   * `count` is exact; the rest are held to `agreement`'s rule. `percent` is a
   * difference of two timings (a gain of 2% is a ratio of 1.02).
   */
  unit: "us" | "ms" | "ratio" | "percent" | "count";
  /** Decimals `--fix` writes in place of a TBD. */
  decimals: number;
  /**
   * The measured value; several when the sentence claims one figure for each
   * ("flat across every size"), and every one must agree. Throws MissingCell
   * when a cell is not committed.
   */
  resolve: (
    R: Runs,
    ctx: ClaimContext,
  ) => number | Estimate | (number | Estimate)[] | null;
}

export function checkSweepClaims(
  doc: string,
  R: Runs,
  ctx: ClaimContext,
  claims: readonly SweepClaim[],
): {
  failures: Failure[];
  checked: number;
  pending: number;
  placeholders: number;
  edits: ProseEdit[];
} {
  const failures: Failure[] = [];
  const edits: ProseEdit[] = [];
  let checked = 0;
  let pending = 0;
  let placeholders = 0;
  const where = "PERFORMANCE.md prose";
  for (const claim of claims) {
    // A sentence wraps wherever the prose reflows it, so a space in the
    // pattern matches any run of whitespace, line breaks and blockquote markers included.
    const hit = matchOnce(
      doc,
      new RegExp(
        claim.pattern.source.replace(/ /g, String.raw`[\s>]+`),
        claim.pattern.flags,
      ),
    );
    if (hit.count !== 1 || hit.text === undefined) {
      failures.push({
        where,
        column: claim.what,
        row: "—",
        documented: `${hit.count} match(es)`,
        measured: "—",
        detail:
          hit.count === 0
            ? "the sentence was edited without updating its binding here, so the figure is no longer checked"
            : "the pattern must name one figure",
      });
      continue;
    }
    const raw = hit.text;
    const tbd = /^TBD$/i.test(raw.trim());
    let resolved: ReturnType<SweepClaim["resolve"]>;
    try {
      resolved = claim.resolve(R, ctx);
    } catch (e) {
      if (!(e instanceof MissingCell)) throw e;
      if (tbd) pending++;
      failures.push({
        where,
        column: claim.what,
        row: "—",
        documented: raw,
        measured: "—",
        detail: tbd
          ? `placeholder — ${e.message}; the next committed run fills it with --fix`
          : e.message,
      });
      continue;
    }
    if (resolved === null) {
      if (tbd) pending++;
      failures.push({
        where,
        column: claim.what,
        row: "—",
        documented: raw,
        measured: "—",
        detail: tbd
          ? "placeholder — not measurable from the committed runs yet"
          : "nothing committed backs this figure",
      });
      continue;
    }
    const values = (Array.isArray(resolved) ? resolved : [resolved]).map(
      (v): Estimate => (isEstimate(v) ? v : { value: v, interval: null }),
    );
    const sorted = values.map((v) => v.value).sort((a, b) => a - b);
    const central = sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
    const places = tbd ? claim.decimals : placesOf(raw);
    // Resolvers return microseconds for a time; the sentence is in its unit.
    const written = (v: number) =>
      (claim.unit === "ms" ? v / 1e3 : v).toFixed(places);
    if (tbd) {
      placeholders++;
      failures.push({
        where,
        column: claim.what,
        row: "—",
        documented: raw,
        measured: written(central),
        detail: "placeholder — run with --fix against a committed run",
      });
      edits.push({
        index: hit.index as number,
        length: raw.length,
        text: written(central),
      });
      continue;
    }
    const quoted = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(quoted)) {
      failures.push({
        where,
        column: claim.what,
        row: "—",
        documented: raw,
        measured: "—",
        detail: "captured text is not a number",
      });
      continue;
    }
    checked++;
    const off = values.filter((v) => {
      // A count is exact at the precision written: "128 cells", "5.2%".
      if (claim.unit === "count") {
        return Number(v.value.toFixed(places)) !== quoted;
      }
      const unit: Unit = claim.unit === "percent" ? "percent" : claim.unit;
      return (
        agreement({ value: quoted, unit, decimals: places }, v).verdict ===
        "outside"
      );
    });
    if (off.length > 0) {
      failures.push({
        where,
        column: claim.what,
        row: "—",
        documented: raw,
        measured: values.map((v) => written(v.value)).join(", "),
        ...(values.length > 1
          ? {
              detail: `${off.length} of the ${values.length} figures this sentence speaks for are outside the band`,
            }
          : {}),
      });
      edits.push({
        index: hit.index as number,
        length: raw.length,
        text: written(central),
      });
    }
  }
  return { failures, checked, pending, placeholders, edits };
}
