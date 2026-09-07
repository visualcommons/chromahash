/**
 * One table of metric documentation, shared by every place the report names a
 * metric.
 *
 * The report used to print sixteen columns of bare numbers and hide the
 * definitions inside a collapsed block with no citations, so a reader could not
 * tell what ΔE00 = 3.2 meant, which column mattered, or why PSNR was listed and
 * then disclaimed. Every metric now states why it is reported and links to its
 * source — the defining specification where one exists, Wikipedia otherwise.
 *
 * Column headers render from this table, so a metric cannot appear in a report
 * table without a definition behind it.
 */

import { esc } from "./html.ts";

/** Which way is better, for the arrow the report prints beside a column. */
export type MetricDirection = "lower" | "higher";

export interface MetricDoc {
  /** Short column label, e.g. "ΔE00". */
  label: string;
  /** Full name spelled out. */
  name: string;
  direction: MetricDirection;
  /** Why this harness reports it — one or two sentences, for a non-expert. */
  why: string;
  /** What "good" looks like, in the metric's own units. */
  scale: string;
  /** Reference URL. */
  href: string;
  /** Human label for the reference. */
  hrefLabel: string;
  /** Who computed it: the external metrics binary, or this harness. */
  source: "iqa-cli" | "harness";
}

export const METRIC_DOCS = {
  ciede2000: {
    label: "ΔE00",
    name: "CIEDE2000 colour difference",
    direction: "lower",
    why: "The primary metric. A placeholder is seen for a fraction of a second at low detail, so what a viewer registers is whether the colours are right — not whether edges landed in the correct place. ΔE00 measures exactly that, in a space built so that equal numbers look like equally large differences.",
    scale:
      "0 is identical; ~1 is the smallest difference a person can see at all; under 2 is good, 5 and above is obviously wrong.",
    href: "https://en.wikipedia.org/wiki/Color_difference#CIEDE2000",
    hrefLabel: "Wikipedia: Color difference § CIEDE2000",
    source: "iqa-cli",
  },
  ssimulacra2: {
    label: "SSIMULACRA2",
    name: "SSIMULACRA 2",
    direction: "higher",
    why: "A modern perceptual score tuned against human ratings of compressed images. It is the best single answer to 'would a person call this a good approximation', and it is reported as a guard: a change that improves colour accuracy while making this worse has traded something real away.",
    scale:
      "100 is identical. Placeholders sit far below that — the useful reading is the gap between formats, not the absolute value.",
    href: "https://github.com/cloudinary/ssimulacra2",
    hrefLabel: "cloudinary/ssimulacra2 (reference implementation)",
    source: "iqa-cli",
  },
  butteraugli: {
    label: "Butteraugli",
    name: "Butteraugli distance",
    direction: "lower",
    why: "Google's perceptual distance from libjxl, built to estimate the point at which a difference becomes noticeable rather than to average error. Reported as a second guard, because it and SSIMULACRA2 disagree often enough to be worth seeing separately.",
    scale: "0 is identical; higher means a more visible difference.",
    href: "https://github.com/google/butteraugli",
    hrefLabel: "google/butteraugli",
    source: "iqa-cli",
  },
  dssim: {
    label: "DSSIM",
    name: "Structural dissimilarity, (1 − SSIM) / 2",
    direction: "lower",
    why: "Measures whether structure — edges, texture, the arrangement of light and dark — survived, rather than whether individual pixels match. A placeholder deliberately throws structure away, so this is read as a guard against throwing away more than intended.",
    scale:
      "0 is identical; under 0.10 is good, 0.25 and above is a large structural change.",
    href: "https://en.wikipedia.org/wiki/Structural_similarity_index_measure",
    hrefLabel: "Wikipedia: Structural similarity",
    source: "iqa-cli",
  },
  msSsim: {
    label: "MS-SSIM",
    name: "Multi-scale structural similarity",
    direction: "higher",
    why: "SSIM evaluated at several zoom levels at once, so it is less fooled by an image that is wrong at one scale and right at another. Included because a placeholder is judged at whatever size the page happens to show it.",
    scale: "1 is identical.",
    href: "https://en.wikipedia.org/wiki/Structural_similarity_index_measure#Multi-Scale_SSIM",
    hrefLabel: "Wikipedia: Structural similarity § Multi-Scale SSIM",
    source: "iqa-cli",
  },
  psnrHvsM: {
    label: "PSNR-HVS-M",
    name: "Peak signal-to-noise ratio, HVS-masked",
    direction: "higher",
    why: "PSNR corrected for two facts about human vision: sensitivity varies with detail size, and busy areas hide errors that flat areas expose. A more honest version of the classic measure below.",
    scale: "Decibels; higher is better.",
    href: "https://www.ponomarenko.info/psnrhvsm.htm",
    hrefLabel: "Ponomarenko et al., PSNR-HVS-M",
    source: "iqa-cli",
  },
  psnrDb: {
    label: "PSNR",
    name: "Peak signal-to-noise ratio",
    direction: "higher",
    why: "The classic pixel-difference measure, reported for reference only and deliberately not used to judge anything. It punishes blur, and a placeholder is supposed to be blurry — so a format can improve on every perceptual metric while PSNR gets worse.",
    scale: "Decibels; higher is better. Do not rank formats on this column.",
    href: "https://en.wikipedia.org/wiki/Peak_signal-to-noise_ratio",
    hrefLabel: "Wikipedia: Peak signal-to-noise ratio",
    source: "iqa-cli",
  },
  ringing: {
    label: "Ringing",
    name: "Overshoot beyond the original's local range",
    direction: "lower",
    why: "Everything above answers 'how wrong is it'. None of them answers 'is it wrong in an ugly way'. A placeholder that is uniformly a little off and one that rings with halos and ripples around every edge can score the same. This separates them: it measures only error that escapes the range of the original nearby, which is what ringing does and what ordinary blur cannot do. Blurring a placeholder before display hides this kind of error and not the other kind, so it is the number to watch if you intend to blur.",
    scale:
      "0 to ~20 in 8-bit colour levels. A placeholder that is merely a blurred copy of the original scores exactly 0, by construction. Comparable only between rows decoded at the same size — the window this is measured in scales with the decode, and the Scale column shows it.",
    href: "https://en.wikipedia.org/wiki/Ringing_artifacts",
    hrefLabel: "Wikipedia: Ringing artifacts",
    source: "harness",
  },
  spurious: {
    label: "Invented detail",
    name: "Structure the placeholder has that the original does not",
    direction: "lower",
    why: "Ringing catches error that escapes the range of the original nearby — halos at edges. It cannot catch a ripple that stays inside that range, a broad wave laid over a textured area, or a stripe running through the whole picture, and those are what a placeholder built from a handful of frequencies produces away from edges. This is the number for that: how much structure the placeholder shows at spatial frequencies the original has none at. It is what a reader means when a placeholder 'looks textured' rather than simply blurry. Losing detail costs nothing here — that is what the columns above charge for.",
    scale:
      "0 to ~20 in 8-bit colour levels. The ideal blurred copy of the original at the same resolution scores exactly 0, by construction. Compare two rows directly only at equal decode sizes.",
    href: "https://en.wikipedia.org/wiki/Ringing_artifacts",
    hrefLabel: "Wikipedia: Ringing artifacts",
    source: "harness",
  },
  blurRecovery: {
    label: "Blur recovery",
    name: "Colour error removed by a blur-up",
    direction: "higher",
    why: "Placeholders are usually shown behind a blur, and a blur hides some kinds of error and not others. This is how much colour error disappears when both the placeholder and the original are blurred: a large number means most of the error was fine detail the blur was going to remove anyway, and a small one means the error is in the broad colours, where a blur cannot help. Read it beside Artifacts — a format high in both is one a blur-up rescues.",
    scale: "ΔE00 removed. Larger means the blur-up helps more.",
    href: "https://en.wikipedia.org/wiki/Gaussian_blur",
    hrefLabel: "Wikipedia: Gaussian blur",
    source: "iqa-cli",
  },
  aspect: {
    label: "Aspect error",
    name: "Shape error against the original",
    direction: "lower",
    why: "A placeholder's job includes reserving the right amount of space. If its shape is wrong, the page reflows when the real image arrives — text jumps, and whatever the reader was looking at moves. Every other metric on this page is blind to it, because they stretch the placeholder back into the correct frame before scoring.",
    scale:
      "Percent, measured symmetrically so that 'too wide' and 'too tall' are penalised equally.",
    href: "https://web.dev/articles/cls",
    hrefLabel: "web.dev: Cumulative Layout Shift",
    source: "harness",
  },
  reflow: {
    label: "Reflow",
    name: "Layout shift in a 1000px column",
    direction: "lower",
    why: "The same error as above, in the unit that matters: how many pixels the page jumps when the real image replaces the placeholder, in a 1000px-wide content column. This is the number to compare if you are choosing a format for a page whose layout must hold still.",
    scale: "CSS pixels. 0 means no reflow at all.",
    href: "https://web.dev/articles/cls",
    hrefLabel: "web.dev: Cumulative Layout Shift",
    source: "harness",
  },
} as const satisfies Record<string, MetricDoc>;

export type MetricKey = keyof typeof METRIC_DOCS;

/** Arrow suffix a column header carries, so direction never has to be guessed. */
export function directionArrow(key: MetricKey): string {
  return METRIC_DOCS[key].direction === "lower" ? "↓" : "↑";
}

/**
 * A column header that links to the metric's definition. The report's rule is
 * that a metric may not appear in a table without one.
 */
export function metricTh(key: MetricKey, prefix = ""): string {
  const d = METRIC_DOCS[key];
  return `<th><a class="metric-link" href="#metric-${key}" title="${esc(d.name)} — ${esc(d.scale)}">${prefix}${d.label}</a> ${directionArrow(key)}</th>`;
}

/** The Metrics tab: every metric, why it is here, and where it is defined. */
export function renderMetricsTab(scoringNote: string): string {
  const rows = (Object.keys(METRIC_DOCS) as MetricKey[])
    .map((key) => {
      const d = METRIC_DOCS[key];
      const badge =
        d.source === "harness"
          ? '<span class="badge badge-local" title="Computed by this harness, not by iqa-cli">measured here</span>'
          : '<span class="badge badge-iqa" title="Computed by the iqa-cli binary">iqa-cli</span>';
      return `<section class="metric-card" id="metric-${key}">
  <h3>${d.label} <span class="metric-full">${d.name}</span> ${badge}</h3>
  <p class="metric-why">${d.why}</p>
  <dl class="metric-meta">
    <dt>Better when</dt><dd>${d.direction === "lower" ? "lower ↓" : "higher ↑"}</dd>
    <dt>Reading it</dt><dd>${d.scale}</dd>
    <dt>Defined in</dt><dd><a href="${d.href}" rel="noreferrer">${d.hrefLabel}</a></dd>
  </dl>
</section>`;
    })
    .join("\n");

  return `<h2>What each metric means</h2>
<p class="lede">Nine numbers appear on this page. They do not all answer the same question, and two of them exist because the other seven cannot answer it. Each entry below says what the metric is for, how to read its scale, and where it is defined.</p>
${rows}
<section class="metric-card">
  <h3>How everything here is measured</h3>
  <p class="metric-why">${scoringNote}</p>
</section>`;
}
