/**
 * Generate the attribution files of the three Commons corpora from the pin
 * tables that fetch those images, and check they have not drifted:
 * `fixtures/natural/LICENSES.md` from `src/natural-images.ts`,
 * `fixtures/alpha/LICENSES.md` from `src/alpha-images.ts`, and
 * `fixtures/graphic/LICENSES.md` from `src/graphic-images.ts`.
 *
 * Attribution and pins used to live in two places. They drifted: the graphics
 * corpus recorded one image's licence under `graphic-hbar-chart-shipments`
 * while the fetcher had always called it `graphic-scientific-plot`, so the
 * attribution was filed under a name no file on disk has ever had. Nothing
 * noticed, because nothing compared them.
 *
 * Here the pin table is the single source: every entry carries its own source
 * page, author and licence, and this renders them. A missing attribution is a
 * type error rather than a documentation lapse. An entry marked `withdrawn`
 * renders as withdrawn, with no licence presented as holding: the licence its
 * upload claimed is kept only as the claim it was.
 *
 *   mise run corpus:licenses          # rewrite the three files
 *   mise run corpus:licenses --check  # fail if any of them is stale (CI)
 *   mise run corpus:licenses --probe  # fail if a pinned source is gone or relicensed
 *
 * `--check` compares files in this repository, so it cannot notice the world
 * changing under them. `cutout-wordmark-aflac` showed the cost. Commons
 * deleted it as a copyright violation, and the attribution kept calling it
 * freely licensed. Nothing noticed until a holdout run could not fetch it (#83).
 * `--probe` asks the source instead. It covers the three Commons pin tables:
 * photographic, alpha and graphics. Every entry must still exist on Commons at
 * the pinned URL, and Commons must still record the licence the table records.
 * An entry marked `withdrawn` is skipped and counted, since its absence is
 * already known. Kodak24 is not probed: it is not on Commons, and its URLs are
 * built inside `ensureHoldoutImages` rather than held in a table. The probe
 * needs the network and a third-party host, so it is not a CI gate. Run it
 * before a sweep that fetches the corpus, and when curating a new split.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ALPHA_IMAGES } from "./alpha-images.ts";
import { CORPUS_SPLITS, type CorpusSplit } from "./corpus.ts";
import { GRAPHIC_IMAGES } from "./graphic-images.ts";
import { CURATED_IMAGES } from "./natural-images.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");

const NATURAL_HEADER = `# Curated photographic corpus — sources and licences

Every image is from Wikimedia Commons under a free licence. Attribution below is
per image, as the licences require.

These files are **not committed** — they are fetched on demand and content-pinned
by SHA-256 (\`src/natural-images.ts\`, \`src/corpus-pin.ts\`). A pin mismatch is
fatal: the corpus a number was measured on is part of what the number means.

**This file is generated.** Edit the table in \`src/natural-images.ts\` and run
\`mise run corpus:licenses\`; \`--check\` fails when the two disagree.

**Splits.** \`tune\` is what constants are chosen on. \`tune2\` is the
photographic holdout retired as spent (#76): it informed a decision in every
round (\`spec/EXPERIMENTS.md\` §11.12), so it is tuning data now, together with
the Kodak24 suite (\`src/holdout-images.ts\`, not listed here). \`holdout2\`, if
any entry carries it, is the sealed holdout: no tool fetches it until
\`spec/V0.8-DECISIONS.md\` records the decision it answers as frozen.

**Axis** is the §9.1 corpus-audit axis the image was chosen to cover.
**Notes** are its covariates on the 512 px scoring reference: orientation,
mean CIELAB L\\*, mean chroma C\\*, and a Laplacian detail energy whose exact
formula was not recorded when these were measured.

`;

/** "31 tune, 8 tune2": every split with an image in it, in corpus.ts order. */
function splitCounts(rows: readonly { split: CorpusSplit }[]): string {
  return CORPUS_SPLITS.map(
    (s) => [s, rows.filter((r) => r.split === s).length] as const,
  )
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
}

function renderNatural(): string {
  const rows = [...CURATED_IMAGES].sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  const parts = [NATURAL_HEADER];
  parts.push(`${rows.length} images — ${splitCounts(rows)}.\n`);

  for (const r of rows) {
    parts.push(
      [
        `### \`${r.label}\``,
        "",
        `- Source: <${r.source}>`,
        `- File: <${r.urls[0]}>`,
        `- Author: ${r.author}`,
        `- License: ${r.licence}`,
        `- Dimensions: ${r.width}x${r.height}`,
        `- Split: ${r.split}`,
        `- Axis: ${r.axis}`,
        `- Notes: ${r.notes}`,
        "",
      ].join("\n"),
    );
  }
  return parts.join("\n");
}

const ALPHA_HEADER = `# Alpha corpus — sources and licences

Images with meaningful transparency, used to measure the alpha-mode layout.
Every image is from Wikimedia Commons. Every one still in use is under a free
licence, and attribution below is per image, as the licences require. An entry
marked **withdrawn** is no longer available from its source and is never
fetched; its pin stays so the results that scored it still say what they
measured, and no licence is presented as holding for it.

These files are **not committed** — they are fetched on demand and content-pinned
by SHA-256 (\`src/alpha-images.ts\`, \`src/corpus-pin.ts\`). A pin mismatch is
fatal: the corpus a number was measured on is part of what the number means.

The holdout split is retired (#83): see \`ALPHA_HOLDOUT_RETIRED\` in
\`src/alpha-images.ts\`. Its images keep their declared split below.

**This file is generated.** Edit the table in \`src/alpha-images.ts\` and run
\`mise run corpus:licenses\`; \`--check\` fails when the two disagree.

`;

/** A fraction as a percentage to one decimal place. */
function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function renderAlpha(): string {
  const rows = [...ALPHA_IMAGES].sort((a, b) => a.label.localeCompare(b.label));
  const withdrawn = rows.filter((r) => r.withdrawn !== undefined).length;

  const parts = [ALPHA_HEADER];
  parts.push(
    `${rows.length} images — ${rows.filter((r) => r.split === "tune").length} tune, ${rows.filter((r) => r.split === "holdout").length} holdout; ${withdrawn} withdrawn.\n`,
  );

  for (const r of rows) {
    const licence =
      r.withdrawn === undefined
        ? [`- License: ${r.licence}`]
        : [
            `- Status: **withdrawn** — ${r.withdrawn}`,
            `- License: none that holds. The upload claimed ${r.licence}; the image is withdrawn, so that claim is not relied on, and the image is neither fetched nor redistributed.`,
          ];
    parts.push(
      [
        `### \`${r.label}\``,
        "",
        `- Source: <${r.source}>`,
        `- File: <${r.url}>`,
        `- Author: ${r.author}`,
        ...licence,
        `- Dimensions: ${r.width}x${r.height}`,
        `- Split: ${r.split}`,
        `- Alpha: ${percent(r.nonOpaqueFraction)} non-opaque, ${percent(r.softAlphaFraction)} soft-edged`,
        `- Notes: ${r.notes}`,
        "",
      ].join("\n"),
    );
  }
  return parts.join("\n");
}

const GRAPHIC_HEADER = `# Graphics corpus — sources and licences

Non-photographic content: screenshots, charts, diagrams, maps, line art and
text-heavy graphics. Every image is from Wikimedia Commons under a free
licence. Attribution below is per image, as the licences require.

These files are **not committed** — they are fetched on demand and content-pinned
by SHA-256 (\`src/graphic-images.ts\`, \`src/corpus-pin.ts\`). A pin mismatch is
fatal: the corpus a number was measured on is part of what the number means.

**This file is generated.** Edit the table in \`src/graphic-images.ts\` and run
\`mise run corpus:licenses\`; \`--check\` fails when the two disagree.

`;

function renderGraphic(): string {
  const rows = [...GRAPHIC_IMAGES].sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  const parts = [GRAPHIC_HEADER];
  parts.push(
    `${rows.length} images — ${rows.filter((r) => r.split === "tune").length} tune, ${rows.filter((r) => r.split === "holdout").length} holdout.\n`,
  );

  for (const r of rows) {
    parts.push(
      [
        `### \`${r.label}\``,
        "",
        `- Source: <${r.source}>`,
        `- File: <${r.url}>`,
        `- Author: ${r.author}`,
        `- License: ${r.licence}`,
        `- Dimensions: ${r.width}x${r.height}`,
        `- Split: ${r.split}`,
        `- Notes: ${r.notes}`,
        "",
      ].join("\n"),
    );
  }
  return parts.join("\n");
}

/** One generated attribution file and the pin table it is rendered from. */
interface AttributionFile {
  path: string;
  table: string;
  entries: number;
  render: () => string;
}

const ATTRIBUTION_FILES: readonly AttributionFile[] = [
  {
    path: path.join(FIXTURES, "natural/LICENSES.md"),
    table: "src/natural-images.ts",
    entries: CURATED_IMAGES.length,
    render: renderNatural,
  },
  {
    path: path.join(FIXTURES, "alpha/LICENSES.md"),
    table: "src/alpha-images.ts",
    entries: ALPHA_IMAGES.length,
    render: renderAlpha,
  },
  {
    path: path.join(FIXTURES, "graphic/LICENSES.md"),
    table: "src/graphic-images.ts",
    entries: GRAPHIC_IMAGES.length,
    render: renderGraphic,
  },
];

/** One pinned Commons file, as the probe sees it. */
interface ProbeTarget {
  table: "natural" | "alpha" | "graphic";
  label: string;
  url: string;
  /** The licence the pin table records. */
  licence: string;
}

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const PROBE_USER_AGENT =
  "chromahash-corpus-probe/0.7 (https://github.com/visualcommons/chromahash) node-fetch";
/** Commons answers at most 50 titles per query for an anonymous client. */
const TITLES_PER_QUERY = 50;
const UPLOAD_URL =
  /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)$/;

/** The part of an `action=query&prop=imageinfo` answer the probe reads. */
interface CommonsQuery {
  query?: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
    pages?: Record<
      string,
      {
        title: string;
        missing?: string;
        imageinfo?: {
          url: string;
          extmetadata?: { LicenseShortName?: { value: string } };
        }[];
      }
    >;
  };
}

/** `File:Name with spaces.png` for a pinned upload URL, or null when it is not one. */
function commonsTitle(url: string): string | null {
  const m = UPLOAD_URL.exec(url);
  if (m?.[1] === undefined) return null;
  return `File:${decodeURIComponent(m[1]).replace(/_/g, " ")}`;
}

function sameUpload(a: string, b: string): boolean {
  const strip = (u: string): string => decodeURIComponent(u.split("?")[0] ?? u);
  return strip(a) === strip(b);
}

function sameLicence(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s.trim().toLowerCase().replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

function probeTargets(): { targets: ProbeTarget[]; withdrawn: string[] } {
  const targets: ProbeTarget[] = [
    ...CURATED_IMAGES.map(
      (s): ProbeTarget => ({
        table: "natural",
        label: s.label,
        url: s.urls[0] ?? "",
        licence: s.licence,
      }),
    ),
    ...GRAPHIC_IMAGES.map(
      (s): ProbeTarget => ({
        table: "graphic",
        label: s.label,
        url: s.url,
        licence: s.licence,
      }),
    ),
  ];
  const withdrawn: string[] = [];
  for (const s of ALPHA_IMAGES) {
    if (s.withdrawn !== undefined) {
      withdrawn.push(`${s.label}: ${s.withdrawn}`);
      continue;
    }
    targets.push({
      table: "alpha",
      label: s.label,
      url: s.url,
      licence: s.licence,
    });
  }
  return { targets, withdrawn };
}

/**
 * Ask Commons about every pinned file and return what no longer holds, one
 * line per problem. Throws when Commons cannot be asked at all. That is a
 * failed probe, not a clean one.
 */
async function probe(targets: ProbeTarget[]): Promise<string[]> {
  const problems: string[] = [];
  const byTitle = new Map<string, ProbeTarget>();
  for (const t of targets) {
    const title = commonsTitle(t.url);
    if (title === null) {
      problems.push(
        `${t.table}/${t.label}: ${t.url} is not a Commons upload URL`,
      );
      continue;
    }
    byTitle.set(title, t);
  }

  const titles = [...byTitle.keys()];
  const seen = new Set<string>();
  for (let i = 0; i < titles.length; i += TITLES_PER_QUERY) {
    const batch = titles.slice(i, i + TITLES_PER_QUERY);
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "1",
      prop: "imageinfo",
      iiprop: "url|extmetadata",
      iiextmetadatafilter: "LicenseShortName",
      redirects: "1",
      titles: batch.join("|"),
    });
    const response = await fetch(`${COMMONS_API}?${params}`, {
      headers: { "User-Agent": PROBE_USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(
        `Commons answered HTTP ${response.status} to the probe; nothing was checked`,
      );
    }
    const body = (await response.json()) as CommonsQuery;
    const pages = body.query?.pages;
    if (pages === undefined) {
      throw new Error("Commons returned no pages; nothing was checked");
    }
    // Map each answer back to the title that was asked for. Commons rewrites
    // a title it normalizes, and follows a redirect to the file's new name.
    const asked = new Map<string, string>();
    for (const t of batch) asked.set(t, t);
    for (const { from, to } of body.query?.normalized ?? []) {
      asked.set(to, asked.get(from) ?? from);
    }
    const redirected = new Map<string, string>();
    for (const { from, to } of body.query?.redirects ?? []) {
      const original = asked.get(from) ?? from;
      asked.set(to, original);
      redirected.set(original, to);
    }

    for (const page of Object.values(pages)) {
      const title = asked.get(page.title) ?? page.title;
      const t = byTitle.get(title);
      if (t === undefined) continue;
      seen.add(title);
      const where = `${t.table}/${t.label}`;
      const info = page.imageinfo?.[0];
      if (page.missing !== undefined || info === undefined) {
        problems.push(
          `${where}: ${title} no longer exists on Commons (deleted or never uploaded)`,
        );
        continue;
      }
      const moved = redirected.get(title);
      if (moved !== undefined || !sameUpload(info.url, t.url)) {
        problems.push(
          `${where}: ${title} now resolves to ${moved ?? page.title} at ${info.url.split("?")[0]}, not the pinned ${t.url}`,
        );
      }
      const licence = info.extmetadata?.LicenseShortName?.value;
      if (licence === undefined) {
        problems.push(`${where}: Commons records no licence for ${title}`);
      } else if (!sameLicence(licence, t.licence)) {
        problems.push(
          `${where}: Commons records "${licence}" for ${title}, the pin table "${t.licence}"`,
        );
      }
    }
  }
  for (const [title, t] of byTitle) {
    if (!seen.has(title)) {
      problems.push(
        `${t.table}/${t.label}: Commons did not answer for ${title}`,
      );
    }
  }
  return problems;
}

async function runProbe(): Promise<void> {
  const { targets, withdrawn } = probeTargets();
  let problems: string[];
  try {
    problems = await probe(targets);
  } catch (e) {
    console.error(
      `The probe could not run: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(2);
  }
  for (const w of withdrawn) console.log(`withdrawn, not probed: ${w}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(
      `${problems.length} of ${targets.length} pinned Commons source(s) no longer hold as pinned.`,
    );
    process.exit(1);
  }
  console.log(
    `All ${targets.length} pinned Commons sources exist at their pinned URL, and all ${targets.length} recorded licences match Commons.`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--probe")) {
    await runProbe();
    return;
  }
  const check = process.argv.includes("--check");

  if (!check) {
    for (const f of ATTRIBUTION_FILES) {
      await fs.writeFile(f.path, f.render());
      console.log(`Wrote ${f.entries} entries to ${f.path}`);
    }
    return;
  }

  let stale = 0;
  for (const f of ATTRIBUTION_FILES) {
    let actual: string;
    try {
      actual = await fs.readFile(f.path, "utf8");
    } catch {
      console.error(`${f.path} is missing. Run \`mise run corpus:licenses\`.`);
      stale++;
      continue;
    }
    if (actual !== f.render()) {
      console.error(
        `${f.path} does not match ${f.table}. Run \`mise run corpus:licenses\`.`,
      );
      stale++;
      continue;
    }
    console.log(`${f.path} is up to date (${f.entries} entries).`);
  }
  if (stale > 0) process.exit(1);
}

await main();
