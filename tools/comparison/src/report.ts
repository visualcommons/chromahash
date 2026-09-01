import { splitFor, tierFor } from "./corpus.ts";
import { aspectFidelity, log2ToPct } from "./aspect.ts";
import { METRIC_DOCS, metricTh, renderMetricsTab } from "./report-metrics.ts";
import { layoutStyles, renderLayoutTab } from "./report-layout.ts";
import { esc } from "./html.ts";
import {
  computePairedComparisons,
  type PairedComparison,
  pickVersionBaseline,
} from "./paired.ts";
import { bootstrapCI, quantile } from "./stats.ts";
import type {
  FormatResult,
  FormatStat,
  HarnessResult,
  ImageCategory,
  LocalMetrics,
  MetricResult,
} from "./types.ts";

interface ImageEntry {
  name: string;
  category: ImageCategory;
  originalWidth: number;
  originalHeight: number;
  /**
   * Encoder-input dimensions (<=100px long edge) — the resolution every format
   * encodes from. Layout fidelity is scored against the *original*, not these;
   * the gap between the two is this harness's own contribution and is reported
   * as its own row on the Layout tab. See aspect.ts.
   */
  smallWidth: number;
  smallHeight: number;
  originalDataUri: string;
  loResDataUri: string;
  formatResults: FormatResult[];
  harnessResults: HarnessResult[];
}

/**
 * Provenance metadata stamped into the report footer for record-keeping.
 */
export interface ReportMeta {
  /** Full commit SHA the report was built from, or null when unknown. */
  commit: string | null;
  /** Base repository URL (e.g. https://github.com/visualcommons/chromahash), or null. */
  repoUrl: string | null;
  /** Pre-formatted generation timestamp, e.g. "2026-05-29 14:32 UTC". */
  generatedAt: string;
}

/**
 * Render the report footer: always shows the generation time, and the source
 * commit (linked to the repo when a repoUrl is available) when known.
 */
function reportFooter(meta: ReportMeta): string {
  let commitHtml = "";
  if (meta.commit) {
    const short = meta.commit.slice(0, 12);
    const inner = meta.repoUrl
      ? `<a href="${meta.repoUrl}/commit/${meta.commit}"><code>${short}</code></a>`
      : `<code>${short}</code>`;
    commitHtml = ` &middot; commit ${inner}`;
  }
  return `<footer class="report-footer">ChromaHash Comparison Report &middot; generated ${meta.generatedAt}${commitHtml}</footer>`;
}

/** Average a nullable metric field across results, ignoring null/non-finite values. */
function avgMetric(
  results: FormatResult[],
  pick: (m: MetricResult) => number | null,
): number | null {
  const vals = results
    .map((r) => pick(r.metrics))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

/** Average a nullable field of the locally-computed metric set. */
function avgMetricLocal(
  results: FormatResult[],
  pick: (m: LocalMetrics) => number | null,
): number | null {
  const vals = results
    .map((r) => pick(r.local))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

/** Average a nullable field of the blurred metric set (null when not computed). */
function avgBlurredMetric(
  results: FormatResult[],
  pick: (m: MetricResult) => number | null,
): number | null {
  const vals = results
    .map((r) => (r.metricsBlurred ? pick(r.metricsBlurred) : null))
    .filter((v): v is number => v !== null && Number.isFinite(v));
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

/**
 * Compute summary statistics for each format, optionally filtered to a subset of entries.
 * The primary metric (ΔE00) additionally gets a median, p90, and a 95%
 * bootstrap CI of the mean — a mean alone hides tail behaviour.
 */
export function computeFormatStats(
  entries: ImageEntry[],
  formatNames: string[],
  filter: (e: ImageEntry) => boolean = () => true,
): FormatStat[] {
  const filtered = entries.filter(filter);
  return formatNames.map((name) => {
    const results = filtered.flatMap((e) =>
      e.formatResults.filter((r) => r.formatName === name),
    );
    const avgSize =
      results.reduce((s, r) => s + r.encodedSizeBytes, 0) /
      (results.length || 1);

    const ciedeValues = results
      .map((r) => r.metrics.ciede2000)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const ciedeSorted = [...ciedeValues].sort((a, b) => a - b);

    const ringValues = results
      .map((r) => r.local.ringing)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const ringSorted = [...ringValues].sort((a, b) => a - b);

    // Scored per image against that image's own original, which is why this is
    // aggregated here rather than inside the adapters: an adapter sees one
    // image and cannot pair a result with the entry it came from.
    const aspects = filtered.flatMap((e) =>
      e.formatResults
        .filter((r) => r.formatName === name)
        .map((r) =>
          aspectFidelity(r.intrinsicSize, e.originalWidth, e.originalHeight),
        )
        .filter((a): a is NonNullable<typeof a> => a !== null),
    );
    // Averaged in octaves and converted once, not averaged as percentages —
    // see aspect.ts.
    const log2Sorted = aspects.map((a) => a.log2Error).sort((x, y) => x - y);
    const meanLog2 =
      log2Sorted.length > 0
        ? log2Sorted.reduce((x, y) => x + y, 0) / log2Sorted.length
        : null;
    // A format that declared no size anywhere gets a dash and the reason, never
    // a zero — a zero here would read as perfect layout fidelity.
    const absent = results.find((r) => r.intrinsicSize.kind === "absent");
    const absentReason =
      aspects.length === 0 && absent?.intrinsicSize.kind === "absent"
        ? absent.intrinsicSize.reason
        : null;

    return {
      name,
      images: results.length,
      avgSize,
      avgCiede: avgMetric(results, (m) => m.ciede2000),
      avgDssim: avgMetric(results, (m) => m.dssim),
      avgMsSsim: avgMetric(results, (m) => m.msSsim),
      avgPsnrHvsM: avgMetric(results, (m) => m.psnrHvsM),
      avgSsimulacra2: avgMetric(results, (m) => m.ssimulacra2),
      avgButteraugli: avgMetric(results, (m) => m.butteraugli),
      avgPsnr: avgMetric(results, (m) => m.psnrDb),
      avgCiedeBlurred: avgBlurredMetric(results, (m) => m.ciede2000),
      medianCiede: ciedeSorted.length > 0 ? quantile(ciedeSorted, 0.5) : null,
      p90Ciede: ciedeSorted.length > 0 ? quantile(ciedeSorted, 0.9) : null,
      ciCiede: ciedeValues.length > 0 ? bootstrapCI(ciedeValues) : null,
      avgRinging: avgMetricLocal(results, (m) => m.ringing),
      avgSpurious: avgMetricLocal(results, (m) => m.spurious),
      p90Ringing: ringSorted.length > 0 ? quantile(ringSorted, 0.9) : null,
      avgRingArea: avgMetricLocal(results, (m) => m.ringArea),
      avgAspectErrorPct: meanLog2 !== null ? log2ToPct(meanLog2) : null,
      p90AspectErrorPct:
        log2Sorted.length > 0 ? log2ToPct(quantile(log2Sorted, 0.9)) : null,
      maxAbsReflowPx:
        aspects.length > 0
          ? Math.max(...aspects.map((a) => Math.abs(a.reflowPx)))
          : null,
      aspectImages: aspects.length,
      aspectAbsentReason: absentReason,
    };
  });
}

/**
 * Long edge, in CSS px, of the normalization box every preview is scaled into.
 * Matches the report's historical max-height cap, so page length is unchanged.
 */
const PREVIEW_BOX_LONG_EDGE = 150;
/**
 * Floor on a rendered edge. The `dim-*` fixtures reach 1x100 and 100x1, which
 * contain-fit to a ~1.5px sliver -- present, but impossible to actually look
 * at. Clamping the short edge up stretches that one axis; the true decode
 * dimensions stay printed in every cell's label, so the distortion is
 * disclosed rather than hidden.
 */
const PREVIEW_MIN_EDGE = 8;

/** A rendered size in CSS pixels. */
interface Box {
  w: number;
  h: number;
}

/**
 * The per-row normalization box: the original's aspect ratio with its long edge
 * at {@link PREVIEW_BOX_LONG_EDGE}, short edge floored at {@link PREVIEW_MIN_EDGE}.
 * Every cell in the row -- original, each format, each language harness -- is
 * laid out in a box of exactly this size, so formats are compared at one scale
 * instead of at whatever resolution each happens to decode to.
 */
function rowBox(width: number, height: number): Box {
  if (!(width > 0) || !(height > 0)) {
    return { w: PREVIEW_BOX_LONG_EDGE, h: PREVIEW_BOX_LONG_EDGE };
  }
  const scale = PREVIEW_BOX_LONG_EDGE / Math.max(width, height);
  return {
    w: Math.max(PREVIEW_MIN_EDGE, Math.round(width * scale)),
    h: Math.max(PREVIEW_MIN_EDGE, Math.round(height * scale)),
  };
}

/**
 * Contain-fit a decode of `width`x`height` inside the row box, flooring each
 * rendered edge at {@link PREVIEW_MIN_EDGE}. Contain (never cover, never
 * stretch) is what keeps a format that decodes to a different aspect than the
 * source visibly letterboxed instead of silently distorted -- e.g. a square 4x4
 * WebP against a 827x852 original. Upscaling is the point: a 4x4 decode is
 * magnified ~37x so it is actually visible, and `image-rendering: pixelated`
 * keeps that honest by showing its 16 flat samples as 16 flat blocks.
 */
function fitInBox(width: number, height: number, box: Box): Box {
  if (!(width > 0) || !(height > 0)) return box;
  const scale = Math.min(box.w / width, box.h / height);
  return {
    w: Math.max(PREVIEW_MIN_EDGE, Math.round(width * scale)),
    h: Math.max(PREVIEW_MIN_EDGE, Math.round(height * scale)),
  };
}

/** Inline `style` sizing a media element to a fitted box. */
function sizeStyle(box: Box): string {
  return `width:${box.w}px;height:${box.h}px`;
}

/** Custom properties that fix a cell's media area to the row box. */
function boxVars(box: Box): string {
  return `--box-w:${box.w}px;--box-h:${box.h}px`;
}

/** Format a nullable metric to fixed precision, or "N/A". */
function fmt(v: number | null, digits: number): string {
  return v !== null ? v.toFixed(digits) : "N/A";
}

/** Wrap a value in a good/warn/bad colour span using ascending thresholds (lower is better). */
function gradeCell(
  v: number | null,
  digits: number,
  good: number,
  warn: number,
): string {
  if (v === null) return "N/A";
  const cls =
    v < good ? "metric-good" : v < warn ? "metric-warn" : "metric-bad";
  return `<span class="${cls}">${v.toFixed(digits)}</span>`;
}

/** Format a [lo, hi] confidence interval, or "N/A". */
function fmtCi(ci: [number, number] | null, digits: number): string {
  return ci !== null
    ? `${ci[0].toFixed(digits)}&ndash;${ci[1].toFixed(digits)}`
    : "N/A";
}

/**
 * The cross-format statistics table.
 *
 * Every metric column header links to that metric's entry on the Metrics tab —
 * the report's rule is that a number may not appear without a definition
 * reachable in one click.
 */
function formatStatsTable(stats: FormatStat[]): string {
  // A format with fewer images than the widest one could not represent the
  // budget everywhere; its means cover a subset and the table has to say so.
  const maxImages = stats.reduce((m, x) => Math.max(m, x.images), 0);
  // The blurred "as-rendered" column only appears when the run computed it.
  const hasBlurred = stats.some((s) => s.avgCiedeBlurred !== null);
  const hasRinging = stats.some((s) => s.avgRinging !== null);
  const hasSpurious = stats.some((s) => s.avgSpurious !== null);
  return `<div class="table-scroll"><table>
<tr><th>Format</th><th>Images</th><th>Avg Size (B)</th>${metricTh("ciede2000", "Avg ")}${metricTh("ciede2000", "Median ")}${metricTh("ciede2000", "p90 ")}<th>95% CI ΔE00</th>${hasBlurred ? metricTh("blurRecovery") : ""}${hasRinging ? metricTh("ringing", "Avg ") : ""}${hasSpurious ? metricTh("spurious", "Avg ") : ""}${metricTh("ssimulacra2", "Avg ")}${metricTh("butteraugli", "Avg ")}${metricTh("dssim", "Avg ")}${metricTh("msSsim", "Avg ")}${metricTh("psnrHvsM", "Avg ")}${metricTh("psnrDb", "Avg ")}</tr>
${stats
  .map(
    (s) => `<tr>
  <td class="name"><strong>${esc(s.name)}</strong></td>
  <td${s.images < maxImages ? ' class="short" title="fewer images than the set: this format could not represent the byte budget on every image, so its means cover only the images listed"' : ""}>${s.images}${s.images < maxImages ? "*" : ""}</td>
  <td>${s.avgSize.toFixed(1)}</td>
  <td>${gradeCell(s.avgCiede, 2, 2, 5)}</td>
  <td>${gradeCell(s.medianCiede, 2, 2, 5)}</td>
  <td>${gradeCell(s.p90Ciede, 2, 2, 5)}</td>
  <td>${fmtCi(s.ciCiede, 2)}</td>
  ${
    hasBlurred
      ? `<td>${
          s.avgCiede !== null && s.avgCiedeBlurred !== null
            ? (s.avgCiede - s.avgCiedeBlurred).toFixed(2)
            : "N/A"
        }</td>\n  `
      : ""
  }${hasRinging ? `<td>${fmt(s.avgRinging, 2)}</td>\n  ` : ""}${hasSpurious ? `<td>${fmt(s.avgSpurious, 2)}</td>\n  ` : ""}<td>${fmt(s.avgSsimulacra2, 1)}</td>
  <td>${fmt(s.avgButteraugli, 2)}</td>
  <td>${gradeCell(s.avgDssim, 4, 0.1, 0.25)}</td>
  <td>${fmt(s.avgMsSsim, 4)}</td>
  <td>${fmt(s.avgPsnrHvsM, 1)}</td>
  <td>${fmt(s.avgPsnr, 1)}</td>
</tr>`,
  )
  .join("\n")}
</table></div>`;
}

/**
 * Render the paired version-A/B tables: one block per candidate column, each
 * differenced per-image against the released-tag baseline. A CI that excludes
 * zero is the signal — the unpaired tables above cannot resolve differences
 * this small (see paired.ts).
 */
function pairedTable(comparisons: PairedComparison[]): string {
  if (comparisons.length === 0) return "";
  return comparisons
    .map(
      (
        cmp,
      ) => `<h4 style="margin:12px 0 4px;font-size:0.9rem">${cmp.candidate} vs ${cmp.baseline}</h4>
<table>
<tr><th>Metric</th><th>${cmp.baseline}</th><th>${cmp.candidate}</th><th>Mean Δ</th><th>Δ%</th><th>95% CI of paired Δ</th><th>win/tie/loss</th><th>sign p</th><th>n</th></tr>
${cmp.metrics
  .map((m) => {
    // A CI strictly on one side of zero is a consistent shift, not noise.
    const real = m.ci[0] > 0 || m.ci[1] < 0;
    const cls = !real ? "" : m.meanDelta < 0 ? "metric-good" : "metric-bad";
    return `<tr>
  <td><strong>${m.metric}</strong></td>
  <td>${m.baselineMean.toFixed(4)}</td>
  <td>${m.candidateMean.toFixed(4)}</td>
  <td><span class="${cls}">${m.meanDelta.toFixed(4)}</span></td>
  <td><span class="${cls}">${m.deltaPct !== null ? `${m.deltaPct.toFixed(2)}%` : "N/A"}</span></td>
  <td>${m.ci[0].toFixed(4)}&nbsp;&ndash;&nbsp;${m.ci[1].toFixed(4)}</td>
  <td>${m.wins}/${m.ties}/${m.losses}</td>
  <td>${m.signP.toFixed(4)}</td>
  <td>${m.pairs}</td>
</tr>`;
  })
  .join("\n")}
</table>`,
    )
    .join("\n");
}
/**
 * Photographic categories: the primary "natural & realistic" summary. Portrait
 * and Night are natural photographs too — they only carry their own category
 * so the report can break them out.
 */
export const PHOTO_CATEGORIES: ImageCategory[] = [
  "Natural",
  "Portrait",
  "Night",
  "Realistic",
];

/**
 * Canonical LQIP format order, shared by the HTML report and the JSON output.
 *
 * Every ChromaHash tier is listed: `main.ts` orders columns by this array and
 * appends anything absent from it, so a missing tier would silently sort after
 * the competing formats in every table.
 */
export const FORMAT_NAMES = [
  "ChromaHash t0",
  "ChromaHash t1",
  "ChromaHash t2",
  "ChromaHash t3",
  "ChromaHash t4",
  "ChromaHash",
  "ThumbHash",
  "BlurHash",
  "lqip-modern",
  "unpic",
];

/** Canonical language order, shared by the HTML report and the JSON output. */
export const LANGUAGES = [
  "Rust",
  "C",
  "TypeScript",
  "Kotlin",
  "Swift",
  "Go",
  "Python",
  "C#",
];

/** Full category order, used wherever the report walks every category. */
const ALL_CATEGORIES: ImageCategory[] = [
  "Natural",
  "Portrait",
  "Night",
  "Realistic",
  "Alpha (real)",
  "Graphics",
  "Dimensions",
  "Alpha",
  "Color Distribution",
  "Quantization",
  "Gamut",
  "Text/UI",
  "Illustration",
];

/**
 * The evidence tiers the report is organised around.
 *
 * The old report ran every category down one page and averaged them into a
 * single "All Images" table, so `gamut-bt2020.png` and `solid-blue.png` — which
 * exist to show the format *can* represent a case — carried the same weight as
 * a photograph. Splitting them is the point: the first two groups are evidence
 * about quality, the third is evidence about capability, and they answer
 * different questions.
 */
interface TabGroup {
  id: string;
  label: string;
  heading: string;
  lede: string;
  categories: ImageCategory[];
  /** Rendered as a warning strip above the tables. */
  banner?: string;
}

const CONTENT_TABS: TabGroup[] = [
  {
    id: "photos",
    label: "Photos",
    heading: "Photographs",
    lede: "Real photographs — landscapes, portraits, night scenes. This is the corpus a placeholder format is actually for, and the tables here are the ones to judge a format on.",
    categories: PHOTO_CATEGORIES,
  },
  {
    id: "content",
    label: "Cut-outs &amp; graphics",
    heading: "Cut-outs and graphics",
    lede: "Real content that is not photographic: transparent product cut-outs, logos and insignia, screenshots, charts and line art. Placeholder formats are tuned on photographs, so this is where that tuning gets tested against what a real pipeline also ingests.",
    categories: ["Alpha (real)", "Graphics"],
  },
  {
    id: "synthetic",
    label: "Synthetic tests",
    heading: "Synthetic capability tests",
    lede: "Generated fixtures: solid colours, gradients, extreme aspect ratios, wide-gamut swatches, noise.",
    categories: [
      "Dimensions",
      "Alpha",
      "Color Distribution",
      "Quantization",
      "Gamut",
      "Text/UI",
      "Illustration",
    ],
    banner:
      "These images demonstrate what a format <strong>can represent</strong>, not how well it works. A 1&times;100 strip and a BT.2020 swatch are correctness cases — they prove a format handles the situation at all. <strong>Do not read these tables as a quality ranking</strong>; a format can win here and be the wrong choice for real images, and the reverse. The photographs are the evidence about quality.",
  },
];

/** One image row: the original, then every format's decode at one scale. */
function imageRow(entry: ImageEntry): string {
  // One box per row, from the original's aspect ratio: every format in the
  // row is then drawn at the same scale, so a 4x4 WebP and a 97x100
  // ChromaHash t3 are compared as displayed rather than as decoded.
  const box = rowBox(entry.originalWidth, entry.originalHeight);
  return `
<div class="image-row">
  <div class="image-name">${esc(entry.name)}</div>
  <div class="image-cell">
    <div class="image-box original-wrap" style="${boxVars(box)}">
      <img class="img-hires" src="${entry.originalDataUri}" alt="Original">
      <img class="img-lores" src="${entry.loResDataUri}" alt="Encoder input">
    </div>
    <div class="label">Original<br>${entry.originalWidth}x${entry.originalHeight}px</div>
  </div>
  ${entry.formatResults
    .map((r) => {
      if (r.dataUri.startsWith("css:")) {
        // unpic's blurhashToCssGradientString() returns a bare comma-separated
        // gradient list -- the value of background-image, not a declaration --
        // so the property name is supplied here. The adapter's byte count
        // measures that list, which is what a consumer would actually ship.
        const css = r.dataUri.slice(4);
        return `<div class="image-cell">
      <div class="image-box" style="${boxVars(box)}"><div class="css-preview" style="background-image:${css}"></div></div>
      <div class="label">${esc(r.formatName)}<br>${r.decodedWidth}x${r.decodedHeight}px | ${r.encodedSizeBytes}B</div>
    </div>`;
      }
      const m = (v: number | null, d: number) =>
        v !== null ? v.toFixed(d) : "N/A";
      const ciedeStr =
        r.metrics.ciede2000 !== null
          ? ` | ΔE:${r.metrics.ciede2000.toFixed(2)}`
          : "";
      const ringStr =
        r.local.ringing !== null ? ` Ring:${r.local.ringing.toFixed(1)}` : "";
      const dssimStr = `<br>S2:${m(r.metrics.ssimulacra2, 0)} Bu:${m(r.metrics.butteraugli, 1)}${ringStr}`;
      const fit = fitInBox(r.decodedWidth, r.decodedHeight, box);
      return `<div class="image-cell">
      <div class="image-box" style="${boxVars(box)}"><img src="${r.dataUri}" alt="${esc(r.formatName)}" style="${sizeStyle(fit)}"></div>
      <div class="label">${esc(r.formatName)}<br>${r.decodedWidth}x${r.decodedHeight}px | ${r.encodedSizeBytes}B${ciedeStr}${dssimStr}</div>
    </div>`;
    })
    .join("\n  ")}
</div>`;
}

/** Slugify a category name into an anchor id. */
function catId(tabId: string, category: string): string {
  return `${tabId}-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * A content tab: its stats table, a jump index over the categories it holds,
 * and one collapsed gallery per category.
 *
 * The galleries are collapsed and the tables are not, deliberately: the tables
 * are the evidence, and the old report buried them under ~150 image rows in a
 * single unbroken scroll.
 */
function contentTab(
  group: TabGroup,
  entries: ImageEntry[],
  formatNames: string[],
): string {
  const mine = entries.filter((e) => group.categories.includes(e.category));
  if (mine.length === 0) return "";
  const present = group.categories.filter((c) =>
    mine.some((e) => e.category === c),
  );

  const index = present
    .map((c) => {
      const n = mine.filter((e) => e.category === c).length;
      return `<a class="jump" href="#${catId(group.id, c)}">${c} <span class="jump-n">${n}</span></a>`;
    })
    .join("");

  // What the previews are is a real source of confusion, and it changes how the
  // texture in them should be read. Each is the decode at its OWN raster —
  // often 32x21 — magnified by the browser. Blockiness there is the
  // magnification, not the format; the `Pixels / Smoothed` control switches
  // between the samples and the browser's interpolation of them, and neither is
  // a blur. The ChromaHash native-render row is the format drawing the same 32
  // bytes at full size, which is the only preview here that is not magnified.
  const previewNote = `<p class="section-note">Each preview is that format's decode at its <em>own</em> resolution, scaled up to a common box — so a 32x21 decode is magnified about seven times. Blocky edges are that magnification, not the format. <strong>Pixels / Smoothed</strong> in the toolbar switches between the stored samples and the browser's interpolation of them; neither is a blur, and placeholders are usually shown blurred. The <em>ChromaHash native render</em> row is the same 32 bytes drawn directly at full size — the one preview here that is not magnified, and the honest comparison for how much of the texture belongs to the format.</p>`;

  const galleries = present
    .map((c) => {
      const catEntries = mine.filter((e) => e.category === c);
      const note =
        c === "Gamut"
          ? `<p class="section-note">ΔE00 is scored in sRGB against the source's color-managed sRGB appearance, so the cross-format comparison stays apples-to-apples; the gamut-aware ChromaHash tiers match it while formats that ignore the source gamut look off (higher ΔE00). The <strong>Display P3</strong> row's Original and every ChromaHash preview are decoded to P3 and tagged with the P3 ICC profile: on a wide-gamut (P3) display they show the true saturated color and match each other, while the sRGB-only formats appear less saturated — ChromaHash renders correctly to the display's gamut.</p>`
          : "";
      return `<details class="gallery" id="${catId(group.id, c)}">
<summary>${c} <span class="jump-n">${catEntries.length} image${catEntries.length === 1 ? "" : "s"}</span></summary>
<div class="inner">
${previewNote}
${note}${catEntries.map(imageRow).join("\n")}
</div>
</details>`;
    })
    .join("\n");

  const perCategory = present
    .map(
      (c) => `<h4>${c}</h4>
${formatStatsTable(computeFormatStats(mine, formatNames, (e) => e.category === c))}`,
    )
    .join("\n");

  return `<h2>${group.heading}</h2>
${group.banner ? `<div class="banner"><strong>Capability, not quality.</strong> ${group.banner}</div>` : ""}
<p class="lede">${group.lede}</p>
${formatStatsTable(computeFormatStats(mine, formatNames))}
<details class="methodology">
<summary>Broken down by category</summary>
<div class="inner">
${perCategory}
</div>
</details>
<h3>Every image</h3>
<nav class="jumps">${index}</nav>
${galleries}`;
}

/**
 * The headline table: five columns, real photographs only.
 *
 * The full table has sixteen. That is the right amount for someone tuning the
 * format and far too many for someone deciding which placeholder format to use,
 * who needs to know the size, whether the colours are right, whether it looks
 * acceptable, whether it has artifacts, and whether the page will jump.
 */
function headlineTable(stats: FormatStat[]): string {
  const hasRinging = stats.some((s) => s.avgRinging !== null);
  const hasSpurious = stats.some((s) => s.avgSpurious !== null);
  return `<div class="table-scroll"><table class="headline">
<tr>
  <th>Format</th>
  <th>Bytes</th>
  ${metricTh("ciede2000", "Colour ")}
  ${metricTh("ssimulacra2", "Perceptual ")}
  ${hasRinging ? metricTh("ringing", "Artifacts ") : ""}
  ${hasSpurious ? metricTh("spurious", "") : ""}
  ${metricTh("reflow", "Layout ")}
</tr>
${stats
  .map(
    (s) => `<tr>
  <td class="name"><strong>${esc(s.name)}</strong></td>
  <td>${s.avgSize.toFixed(0)}</td>
  <td>${gradeCell(s.avgCiede, 2, 2, 5)}</td>
  <td>${fmt(s.avgSsimulacra2, 0)}</td>
  ${hasRinging ? `<td>${fmt(s.avgRinging, 2)}</td>` : ""}
  ${hasSpurious ? `<td>${fmt(s.avgSpurious, 2)}</td>` : ""}
  <td>${s.aspectImages > 0 ? `${fmt(s.maxAbsReflowPx, 0)}&nbsp;px` : '<span class="na" title="This format carries no shape of its own; the dimensions must come from elsewhere.">—</span>'}</td>
</tr>`,
  )
  .join("\n")}
</table></div>`;
}

/**
 * Generate a self-contained HTML report. Images are referenced by whatever the
 * entries' image fields contain — a relative path once materialized to disk, or
 * a data URI otherwise.
 */
export function generateReport(
  entries: ImageEntry[],
  meta: ReportMeta,
  opts?: {
    formatNames?: string[];
    showImplementations?: boolean;
    /** Extra HTML injected at the top of the overview tab (the R-D section). */
    preludeHtml?: string;
    /** Render paired A/B tables against the newest released tag (version runs). */
    paired?: boolean;
  },
): string {
  // Drop columns nothing produced a result for. FORMAT_NAMES carries the bare
  // "ChromaHash" name alongside the per-tier ones, and the standard lineup emits
  // only the tiered adapters -- so every table used to carry a phantom
  // `ChromaHash | 0* | 0.0` row. Harmless as a blank line; actively wrong once
  // the layout table reads a zero-image format as "carries no shape of its own".
  const formatNames = (opts?.formatNames ?? FORMAT_NAMES).filter((n) =>
    entries.some((e) => e.formatResults.some((r) => r.formatName === n)),
  );
  const languages = LANGUAGES;
  // The cross-language verification tab is only meaningful for the cross-format
  // report; the version-comparison report (one chromahash build per column) hides it.
  const showImplementations = opts?.showImplementations ?? true;

  const realEntries = entries.filter((e) => tierFor(e.name) === "real");
  // Intersected with the tier, not category alone. `categorizeImage` falls
  // through to "Realistic" for any filename it does not recognise, and
  // PHOTO_CATEGORIES includes "Realistic" -- so a file under an unknown prefix
  // would count as a photograph here while `tierFor` called it synthetic, and
  // the headline table and the Layout tab would silently be computed over
  // different image sets while both being labelled "Layout".
  const photoEntries = realEntries.filter((e) =>
    PHOTO_CATEGORIES.includes(e.category),
  );
  // The headline is scored on photographs alone: they are what a placeholder
  // format is for, and mixing the synthetic fixtures in is what made the old
  // summary misleading.
  const headlineStats = computeFormatStats(photoEntries, formatNames);
  const allStats = computeFormatStats(entries, formatNames);

  // Tune/holdout split summaries (see corpus.ts); the holdout tables only
  // render when holdout entries were actually part of the run.
  const hasHoldout = entries.some((e) => splitFor(e.name) === "holdout");
  const tuneStats = computeFormatStats(
    entries,
    formatNames,
    (e) => splitFor(e.name) === "tune",
  );
  const holdoutStats = computeFormatStats(
    entries,
    formatNames,
    (e) => splitFor(e.name) === "holdout",
  );

  // Paired A/B against the newest released tag. Only version runs put two
  // builds of the same format on the same images, so only they get this.
  const pairedBaseline = opts?.paired ? pickVersionBaseline(formatNames) : null;
  const pairedAll = pairedBaseline
    ? computePairedComparisons(entries, pairedBaseline, formatNames)
    : [];
  const pairedHoldout =
    pairedBaseline && hasHoldout
      ? computePairedComparisons(
          entries.filter((e) => splitFor(e.name) === "holdout"),
          pairedBaseline,
          formatNames,
        )
      : [];

  // Check cross-language consistency
  const harnessesSkipped = entries.every((e) => e.harnessResults.length === 0);
  const langPassFail = languages.map((lang) => {
    if (harnessesSkipped) {
      return { language: lang, pass: null as boolean | null };
    }
    // No result anywhere means the harness was never run, not that it
    // disagreed with the reference. Mirrors the JSON summary in main.ts.
    // A harness that built and then crashed produced no hash either, so it is
    // the same absent verdict rather than a mismatch. Only an observed byte
    // difference is a failure.
    const observed = entries.flatMap((e) =>
      e.harnessResults.filter((r) => r.language === lang && r.error === null),
    );
    if (observed.length === 0) {
      return { language: lang, pass: null as boolean | null };
    }
    return { language: lang, pass: observed.every((r) => r.matches) };
  });

  // Only tabs with content are emitted: --rd narrows the corpus to
  // photographs and --versions hides the cross-language tab, so both alternate
  // modes would otherwise render empty sections.
  const contentTabs = CONTENT_TABS.map((g) => ({
    group: g,
    html: contentTab(g, entries, formatNames),
  })).filter((t) => t.html !== "");

  const layoutHtml = renderLayoutTab(
    realEntries.length > 0 ? realEntries : entries,
    computeFormatStats(
      realEntries.length > 0 ? realEntries : entries,
      formatNames,
    ),
  );

  const scoringNote = `Placeholders are judged at the size they are shown: every format's decode is upscaled to a display-resolution reference — the original capped to 512&nbsp;px on the long edge — and scored there. Both sides are composited over a white backdrop first, so transparency has a defined meaning. The seven metrics above marked <em>iqa-cli</em> are computed by <a href="https://crates.io/crates/iqa-cli" rel="noreferrer"><code>iqa-cli</code></a>; window-based ones are omitted (N/A) for images below their minimum size. The two marked <em>measured here</em> are computed by this harness — ringing deliberately samples the decode nearest-neighbour rather than reusing that upscale, because the resampler overshoots and would otherwise be credited to the format. <strong>Speed is not measured here.</strong> This report answers "how good does each format look at a given size"; encode and decode timings come from a dedicated harness that controls for run-to-run noise (repeated blocks, a minimum-of-blocks estimator, confidence intervals) and are published in <code>spec/PERFORMANCE.md</code>. Timing a format while the machine is busy scoring every other one, as this page used to, produces a number that measures the load rather than the codec.`;

  const tabs: { id: string; label: string; html: string }[] = [
    {
      id: "overview",
      label: "Overview",
      html: `${opts?.preludeHtml ?? ""}<h2>Which placeholder format should you use?</h2>
<p class="lede">A <strong>Low Quality Image Placeholder</strong> is a handful of bytes — usually 20 to 40 — that a page stores alongside an image and shows instantly while the real one loads. It is small enough to inline in the HTML or keep in a database column, so it costs no extra network request. It is not meant to look like the photograph; it is meant to hold the right colours in the right places, and reserve the right amount of space, until the photograph arrives.</p>
<p class="lede">This page compares several of them on the same images, at the same sizes. The table below is the short answer, over ${photoEntries.length} photograph${photoEntries.length === 1 ? "" : "s"}.</p>
${headlineTable(headlineStats)}
<p class="section-note">Lower is better in every column except <em>Perceptual</em>. <strong>Colour</strong> is the average perceptual colour error; under 2 is good, above 5 is obviously wrong. <strong>Perceptual</strong> is a modern quality score fitted to human ratings — a bigger number is better, and only the gaps between formats mean anything. <strong>Artifacts</strong> is halo and ripple; a placeholder that is just a blurred copy of the original scores 0. <strong>Invented detail</strong> is structure at frequencies the original has none at — the ripples and stripes that stay inside the local range, which Artifacts cannot see. <strong>Layout</strong> is how far the page jumps when the real image loads; a dash means the format carries no shape at all and you must supply the dimensions yourself. Every column links to what it measures.</p>
<h3>How this page is organised</h3>
<p class="section-note">The evidence is split, because not all of it answers the same question:</p>
<ul class="index">
${contentTabs
  .map(
    (t) =>
      `<li><a href="#" data-tab="${t.group.id}"><strong>${t.group.label}</strong></a> — ${t.group.lede.replace(/<[^>]+>/g, "")}</li>`,
  )
  .join("\n")}
${layoutHtml ? '<li><a href="#" data-tab="layout"><strong>Layout</strong></a> — how far the page moves when the real image replaces the placeholder. Every other metric here is blind to this.</li>' : ""}
<li><a href="#" data-tab="metrics"><strong>Metrics</strong></a> — what each number means, how to read its scale, and where it is defined.</li>
${showImplementations ? '<li><a href="#" data-tab="implementations"><strong>Cross-language</strong></a> — proof that every ChromaHash implementation produces identical bytes.</li>' : ""}
</ul>
${
  pairedAll.length > 0
    ? `
<h3>Paired A/B vs ${pairedBaseline}</h3>
<p class="section-note">Every column differenced against <strong>${pairedBaseline}</strong> <em>per image</em>, then aggregated. The unpaired tables carry the corpus's image-to-image spread, which dwarfs the difference between two builds of one format; pairing cancels it. <strong>Negative Δ = the candidate is better</strong> (signs are normalized per metric). A 95% CI that excludes zero is a consistent shift rather than noise; the sign test reports direction independently of effect size.</p>
${pairedTable(pairedAll)}
${
  pairedHoldout.length > 0
    ? `<h4>Holdout split only</h4>
<p class="section-note">The never-tuned split — the honest number for a wire or constants change.</p>
${pairedTable(pairedHoldout)}`
    : ""
}
`
    : ""
}${
  hasHoldout
    ? `
<h3>Tune vs holdout</h3>
<p class="section-note">Constants sweeps tune on the <strong>tune</strong> split only; the untouched <strong>holdout</strong> split (Kodak True Color suite + held-out curated photos) checks that tuned constants generalize instead of overfitting the corpus.</p>
<details class="methodology">
<summary>Tune and holdout tables</summary>
<div class="inner">
<h4>Tune split</h4>
${formatStatsTable(tuneStats)}
<h4>Holdout split</h4>
${formatStatsTable(holdoutStats)}
</div>
</details>
`
    : ""
}
<details class="methodology">
<summary>Everything at once — all ${entries.length} images, photographs and synthetic fixtures together</summary>
<div class="inner">
<p class="section-note">Kept for continuity with earlier reports. Prefer the per-tier tables: this one averages capability fixtures in with photographs, which is exactly what makes a mean hard to interpret.</p>
${formatStatsTable(allStats)}
</div>
</details>`,
    },
    ...contentTabs.map((t) => ({
      id: t.group.id,
      label: t.group.label,
      html: t.html,
    })),
    ...(layoutHtml
      ? [{ id: "layout", label: "Layout", html: layoutHtml }]
      : []),
    { id: "metrics", label: "Metrics", html: renderMetricsTab(scoringNote) },
    ...(showImplementations
      ? [
          {
            id: "implementations",
            label: "Cross-language",
            html: `<h2>Cross-Language Verification</h2>
<p class="lede">ChromaHash is one Rust core exposed to every other language through thin bindings, so the same input must produce byte-identical output everywhere. This tab is that check.</p>
<table>
<tr><th>Language</th><th>Status</th></tr>
${langPassFail
  .map(
    (l) =>
      `<tr><td>${l.language}</td><td class="${l.pass === null ? "" : l.pass ? "pass" : "fail"}">${l.pass === null ? "N/A" : l.pass ? "PASS" : "FAIL"}</td></tr>`,
  )
  .join("\n")}
</table>
${ALL_CATEGORIES.map((category) => {
  const catEntries = entries.filter((e) => e.category === category);
  if (catEntries.length === 0) return "";
  return `<details class="gallery">
<summary>${category} <span class="jump-n">${catEntries.length}</span></summary>
<div class="inner">
${catEntries
  .map((entry) => {
    const box = rowBox(entry.originalWidth, entry.originalHeight);
    return `
<div class="image-row">
  <div class="image-name">${esc(entry.name)}</div>
  <div class="image-cell">
    <div class="image-box original-wrap" style="${boxVars(box)}">
      <img class="img-hires" src="${entry.originalDataUri}" alt="Original">
      <img class="img-lores" src="${entry.loResDataUri}" alt="Encoder input">
    </div>
    <div class="label">Original<br>${entry.originalWidth}x${entry.originalHeight}px</div>
  </div>
  ${entry.harnessResults
    .map((r) => {
      const fit = fitInBox(r.decodedWidth, r.decodedHeight, box);
      return `<div class="image-cell">
    <div class="image-box ${r.matches ? "" : "mismatch"}" style="${boxVars(box)}">${r.dataUri ? `<img src="${r.dataUri}" alt="${r.language}" style="${sizeStyle(fit)}">` : '<div class="decode-error">Error</div>'}</div>
    <div class="label ${r.matches ? "pass" : "fail"}">${r.language}</div>
  </div>`;
    })
    .join("\n  ")}
</div>`;
  })
  .join("\n")}
</div>
</details>`;
}).join("\n")}`,
          },
        ]
      : []),
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ChromaHash Comparison Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 0 20px 20px; }
  body.light { background: #f5f5f5; color: #333; }
  h1 { text-align: center; margin: 18px 0 4px; font-size: 1.5rem; }
  h2 { font-size: 1.25rem; margin: 4px 0 10px; }
  h3 { font-size: 1rem; margin: 22px 0 6px; }
  h4 { font-size: 0.9rem; margin: 14px 0 5px; }
  .tagline { text-align: center; font-size: 0.85rem; color: #aaa; margin-bottom: 14px; }
  body.light .tagline { color: #666; }
  .lede { font-size: 0.92rem; line-height: 1.65; max-width: 78ch; margin: 8px 0; }
  /* The tab bar sticks: the galleries are long, and a reader who scrolls into
     one should never have to scroll back up to leave it. */
  .topbar { position: sticky; top: 0; z-index: 20; background: #1a1a2e;
            padding: 8px 0; margin-bottom: 12px; border-bottom: 1px solid #444; }
  body.light .topbar { background: #f5f5f5; border-color: #ddd; }
  .controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: center; }
  .controls button { padding: 7px 14px; border: 1px solid #555; border-radius: 4px; cursor: pointer; background: #2a2a4a; color: #e0e0e0; font-size: 0.85rem; }
  .controls button.active { background: #4a4aff; border-color: #4a4aff; color: #fff; }
  .controls .spacer { flex-basis: 100%; height: 0; }
  body.light .controls button { background: #fff; color: #333; border-color: #ccc; }
  body.light .controls button.active { background: #4a4aff; color: #fff; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .table-scroll { overflow-x: auto; margin: 14px 0; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0; }
  .table-scroll table { margin: 0; }
  th, td { padding: 7px 11px; border: 1px solid #444; text-align: center; font-size: 0.83rem; white-space: nowrap; }
  td.name, th:first-child { text-align: left; }
  body.light th, body.light td { border-color: #ddd; }
  th { background: #2a2a4a; }
  body.light th { background: #e8e8e8; color: #333; }
  th a.metric-link { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; }
  th a.metric-link:hover { border-bottom-style: solid; }
  table.headline th, table.headline td { font-size: 0.92rem; padding: 10px 14px; }
  .na { color: #888; cursor: help; }
  .banner { border-left: 4px solid #ff9800; background: rgba(255,152,0,0.12);
            padding: 11px 14px; margin: 10px 0 14px; font-size: 0.87rem; line-height: 1.6; max-width: 90ch; }
  ul.index { margin: 8px 0 8px 20px; font-size: 0.88rem; line-height: 1.75; max-width: 88ch; }
  ul.index a { color: #8ab4ff; }
  body.light ul.index a { color: #2a4ad0; }
  nav.jumps { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
  nav.jumps .jump { font-size: 0.78rem; padding: 4px 9px; border: 1px solid #555;
                    border-radius: 999px; text-decoration: none; color: #ccc; }
  nav.jumps .jump:hover { border-color: #4a4aff; color: #fff; }
  body.light nav.jumps .jump { color: #444; border-color: #ccc; }
  .jump-n { opacity: 0.6; font-weight: 400; }
  .section-note { margin: 6px 0 10px; font-size: 0.82rem; line-height: 1.65; color: #aaa; max-width: 88ch; }
  body.light .section-note { color: #666; }
  .image-row { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; margin: 8px 0; padding: 8px; background: #222244; border-radius: 4px; }
  body.light .image-row { background: #fff; border: 1px solid #ddd; }
  .image-cell { text-align: center; min-width: 128px; max-width: 300px; }
  /* Every cell in a row shares one normalization box, sized by the generator
     from the original's aspect ratio (long edge 150px, short edge floored at
     8px) and passed down as --box-w/--box-h. Formats decode at wildly
     different resolutions -- 4x4 for a minimum-size WebP, 97x100 for
     ChromaHash t3 -- and a max-width/max-height pair only caps, never
     scales up, so each preview would render at its own native size and the
     small ones would be invisible. content-box overrides the global
     border-box so the frame sits outside the media area and --box-* is the
     true rendered size. */
  .image-box {
    box-sizing: content-box;
    width: var(--box-w); height: var(--box-h);
    display: flex; align-items: center; justify-content: center;
    margin: 0 auto;
    border: 1px solid #555;
  }
  body.light .image-box { border-color: #ccc; }
  /* The generator emits each preview's exact contain-fit size, so the element
     is never stretched by the layout; pixelated keeps a 37x-magnified 4x4
     decode reading as the 16 samples it actually stored. */
  .image-box img { display: block; image-rendering: pixelated; }
  body.smooth .image-box img { image-rendering: auto; }
  .image-box .decode-error { width: 100%; height: 100%; background: #333; display: flex; align-items: center; justify-content: center; color: #f44; font-size: 0.7rem; }
  .original-wrap { position: relative; }
  /* Both layers fill the box exactly -- the box is built from this original's
     own aspect ratio -- so the hover overlay registers pixel-for-pixel. */
  .original-wrap img { width: 100%; height: 100%; }
  .original-wrap .img-lores { position: absolute; top: 0; left: 0; opacity: 0; transition: opacity 0.15s; }
  .original-wrap:hover .img-lores { opacity: 1; }
  .original-wrap .img-hires { image-rendering: auto; }
  .image-cell .label { font-size: 0.75rem; margin-top: 2px; color: #aaa; }
  body.light .image-cell .label { color: #666; }
  .image-cell .css-preview { width: 100%; height: 100%; }
  .image-name { font-weight: bold; font-size: 0.85rem; min-width: 120px; display: flex; align-items: center; }
  .pass { color: #4caf50; }
  .fail { color: #f44336; font-weight: bold; }
  .image-box.mismatch { outline: 3px solid #f44336; }
  .metric-good { color: #4caf50; font-weight: 600; }
  .metric-warn { color: #ff9800; }
  .metric-bad  { color: #f44336; font-weight: 600; }
  details.methodology, details.gallery { margin: 10px 0; border: 1px solid #555; border-radius: 4px; }
  body.light details.methodology, body.light details.gallery { border-color: #ccc; }
  details summary { padding: 9px 13px; cursor: pointer; font-size: 0.88rem; user-select: none; }
  details .inner { padding: 10px 14px; font-size: 0.82rem; line-height: 1.6; }
  details.methodology table { font-size: 0.82rem; }
  .metric-card { border: 1px solid #555; border-radius: 4px; padding: 14px 16px; margin: 12px 0; max-width: 92ch; }
  body.light .metric-card { border-color: #ddd; background: #fff; }
  .metric-card h3 { margin: 0 0 6px; font-size: 1rem; }
  .metric-full { font-weight: 400; color: #aaa; font-size: 0.85rem; }
  body.light .metric-full { color: #666; }
  .metric-why { font-size: 0.87rem; line-height: 1.65; margin-bottom: 8px; }
  .metric-meta { display: grid; grid-template-columns: max-content 1fr; gap: 3px 14px; font-size: 0.82rem; }
  .metric-meta dt { color: #aaa; }
  body.light .metric-meta dt { color: #666; }
  .metric-meta a { color: #8ab4ff; }
  body.light .metric-meta a { color: #2a4ad0; }
  .badge { font-size: 0.68rem; padding: 2px 7px; border-radius: 999px; vertical-align: middle; font-weight: 500; }
  .badge-iqa { background: #33335c; color: #bbb; }
  .badge-local { background: #3a2d1a; color: #ffb74d; }
  body.light .badge-iqa { background: #eee; color: #555; }
  body.light .badge-local { background: #fff3e0; color: #b26a00; }
  footer.report-footer { margin-top: 40px; padding-top: 16px; text-align: center; font-size: 0.78rem; color: #888; border-top: 1px solid #444; }
  body.light footer.report-footer { color: #777; border-color: #ddd; }
  footer.report-footer a { color: inherit; }
</style>
${layoutStyles}
</head>
<body>
<h1>ChromaHash Visual Comparison Report</h1>
<p class="tagline">Comparing image placeholder formats on ${entries.length} images &middot; start at the Overview</p>
<div class="topbar"><div class="controls">
${tabs.map((t, i) => `  <button data-tab="${t.id}"${i === 0 ? ' class="active"' : ""}>${t.label}</button>`).join("\n")}
  <span class="spacer"></span>
  <button onclick="toggleTheme()">Light / Dark</button>
  <button onclick="toggleSmoothing()" title="Switch the previews between the decoded samples and the browser's interpolation of them. Neither is a blur.">Pixels / Smoothed</button>
</div></div>

${tabs
  .map(
    (t, i) =>
      `<div id="tab-${t.id}" class="tab-content${i === 0 ? " active" : ""}">
${t.html}
</div>`,
  )
  .join("\n")}

<script>
function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.controls button[data-tab]').forEach(el => el.classList.remove('active'));
  var panel = document.getElementById('tab-' + tab);
  if (panel) panel.classList.add('active');
  // Match on the button's own data-tab rather than on the click target: the
  // target is whatever inner element was clicked, so a button containing any
  // markup would leave the bar unhighlighted.
  document.querySelectorAll('.controls button[data-tab="' + tab + '"]').forEach(el => el.classList.add('active'));
  window.scrollTo(0, 0);
}
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-tab]');
  if (!el) return;
  e.preventDefault();
  switchTab(el.getAttribute('data-tab'));
});
// A link into a collapsed gallery has to open it, or the anchor jumps to a
// closed summary and appears to do nothing.
document.addEventListener('click', function (e) {
  var a = e.target.closest('a[href^="#"]');
  if (!a) return;
  var id = a.getAttribute('href').slice(1);
  var target = document.getElementById(id);
  if (!target) return;
  var host = target.closest('.tab-content');
  if (host && !host.classList.contains('active')) {
    var m = host.id.replace(/^tab-/, '');
    switchTab(m);
  }
  if (target.tagName === 'DETAILS') target.open = true;
  var d = target.closest('details');
  if (d) d.open = true;
  setTimeout(function () { target.scrollIntoView({ block: 'start' }); }, 0);
});
function toggleTheme() { document.body.classList.toggle('light'); }
function toggleSmoothing() { document.body.classList.toggle('smooth'); }
</script>
${reportFooter(meta)}
</body>
</html>`;
}

/**
 * Determine the image category from the filename.
 */
export function categorizeImage(fileName: string): ImageCategory {
  const base = fileName.replace(/\.[^.]+$/, "");
  if (base.startsWith("dim-")) return "Dimensions";
  // `cutout-`/`graphic-` are the curated evaluation corpora (§11.0); `alpha-`,
  // `textui-` and `illust-` are the small generated fixtures that predate them.
  if (base.startsWith("cutout-")) return "Alpha (real)";
  if (base.startsWith("graphic-")) return "Graphics";
  if (base.startsWith("alpha-")) return "Alpha";
  if (
    base.startsWith("solid-") ||
    base.startsWith("gradient-") ||
    base === "checkerboard" ||
    base === "noise"
  )
    return "Color Distribution";
  if (
    base.startsWith("saturated-") ||
    base.startsWith("near-") ||
    base === "monochrome"
  )
    return "Quantization";
  if (base.startsWith("gamut-")) return "Gamut";
  if (base.startsWith("textui-")) return "Text/UI";
  if (base.startsWith("illust-")) return "Illustration";
  if (base.startsWith("portrait-")) return "Portrait";
  if (base.startsWith("night-")) return "Night";
  // High-chroma curated photos and the Kodak holdout suite are ordinary
  // photographs — they belong to Natural, not a category of their own.
  if (
    base.startsWith("natural-") ||
    base.startsWith("chroma-") ||
    base.startsWith("kodak")
  )
    return "Natural";
  return "Realistic";
}
