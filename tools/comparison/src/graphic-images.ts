import fs from "node:fs/promises";
import path from "node:path";
import { ensurePinnedFixture } from "./corpus-pin.ts";
import type { CorpusSplit } from "./corpus.ts";

const GRAPHIC_DIR = path.resolve(import.meta.dirname, "../fixtures/graphic");

/**
 * One image in the graphics corpus: screenshots, charts, diagrams, maps, line
 * art and text-heavy graphics.
 *
 * No constant in this format has ever been chosen against non-photographic
 * content, even though it is a large share of what a real placeholder pipeline
 * ingests. The three `illust-*` and three `textui-*` synthetic fixtures are
 * generated edge cases, not content, and are excluded from this set.
 */
export interface GraphicImageSpec {
  /** Filename stem. The `graphic-` prefix is what puts it in the graphics corpus. */
  label: string;
  /** Permanent upstream URL (content-addressed; not a thumbnail or redirect). */
  url: string;
  /** File extension including the dot. */
  ext: string;
  width: number;
  height: number;
  /** Split. Constants are chosen on "tune" and validated on "holdout". */
  split: CorpusSplit;
  /** SHA-256 of the exact bytes (see corpus-pin.ts). */
  sha256: string;
  /** Commons file page, for attribution. */
  source: string;
  /** Author, as Commons records them. */
  author: string;
  /** Licence short name, as Commons records it. */
  licence: string;
  /** What this image is here to cover. */
  notes: string;
}

/**
 * Curated graphics corpus, sourced from Wikimedia Commons under free licences.
 * Every entry carries its own attribution, and `fixtures/graphic/LICENSES.md`
 * is generated from this table (`mise run corpus:licenses`) so the two cannot
 * drift.
 *
 * Curated along the axes that separate graphics from photographs: large flat
 * regions, hard edges, saturated synthetic palettes, fine text, and thin
 * high-contrast strokes.
 */
export const GRAPHIC_IMAGES: GraphicImageSpec[] = [
  {
    label: "graphic-alphaplot-app",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/40/Alphaplotscreenshot.png",
    ext: ".png",
    width: 1280,
    height: 751,
    split: "tune",
    sha256: "ba4a7e2fceb4bf58afbfd6c9ec7ebd688e5f788685f1a4a0417ec6d25d895484",
    source: "https://commons.wikimedia.org/wiki/File:Alphaplotscreenshot.png",
    author: "N.arun.lifescience",
    licence: "CC BY-SA 4.0",
    notes:
      "Scientific plotting application window: toolbars, spreadsheet grid and a plot.",
  },
  {
    label: "graphic-bar-chart-waymo",
    url: "https://upload.wikimedia.org/wikipedia/commons/f/f4/Bar_chart_of_Waymo_Passenger_Miles_Travelled_in_California.png",
    ext: ".png",
    width: 3600,
    height: 1800,
    split: "tune",
    sha256: "ecdded63aa63c820ea3597ad54368a6a37762c8b21d8a2468c04e074e513dbe5",
    source:
      "https://commons.wikimedia.org/wiki/File:Bar_chart_of_Waymo_Passenger_Miles_Travelled_in_California.png",
    author: "WikiEwout",
    licence: "CC BY-SA 4.0",
    notes:
      "Clean modern bar chart: large flat areas, thin axis rules, small text.",
  },
  {
    label: "graphic-block-diagram-arch",
    url: "https://upload.wikimedia.org/wikipedia/commons/0/08/Computer_architecture_block_diagram.png",
    ext: ".png",
    width: 5052,
    height: 4540,
    split: "holdout",
    sha256: "96a3b45b68420d3a30c7c75353c14b6b868ae192b717867d2899ca899b16542e",
    source:
      "https://commons.wikimedia.org/wiki/File:Computer_architecture_block_diagram.png",
    author: "Amila Ruwan 20",
    licence: "CC BY-SA 4.0",
    notes:
      "Large block diagram: boxes, arrows, flat fills and labels on white.",
  },
  {
    label: "graphic-circuit-schematic",
    url: "https://upload.wikimedia.org/wikipedia/commons/5/51/74LS01_TI_8610_schematic.png",
    ext: ".png",
    width: 3508,
    height: 2480,
    split: "tune",
    sha256: "21b08cc6349ed77eaf46b5441d0a87b138da341c78b3c6d7871003002a8f05be",
    source:
      "https://commons.wikimedia.org/wiki/File:74LS01_TI_8610_schematic.png",
    author: "Robert.Baruch",
    licence: "CC BY-SA 4.0",
    notes:
      "Monochrome circuit schematic: thin black lines on white, extremely sparse.",
  },
  {
    label: "graphic-comic-strip-1940",
    url: "https://upload.wikimedia.org/wikipedia/commons/c/c9/First_Chesty_Bond_comic_strip_TheSun_19Mar1940.jpg",
    ext: ".jpg",
    width: 2612,
    height: 985,
    split: "tune",
    sha256: "cfb1ac7c0ac7cf23889e8c166fc8d3f9060b32f4136f12436a8eab5b4754aa7d",
    source:
      "https://commons.wikimedia.org/wiki/File:First_Chesty_Bond_comic_strip_TheSun_19Mar1940.jpg",
    author: "Syd Miller",
    licence: "Public domain",
    notes:
      "Newspaper comic strip scan: panelled ink line art with halftone and text.",
  },
  {
    label: "graphic-comic-wiggle-much",
    url: "https://upload.wikimedia.org/wikipedia/commons/2/26/%22The_Wiggle_Much%22_Comic_Strip%2C_No._1_%28published_in_The_New_York_Herald%2C_March_20%2C_1910%29_MET_DP856515.jpg",
    ext: ".jpg",
    width: 3637,
    height: 2263,
    split: "holdout",
    sha256: "f0ef6ccd47a41f6434ad799f95689fab4f329fd9c258651d789e99cb46484086",
    source:
      "https://commons.wikimedia.org/wiki/File:%22The_Wiggle_Much%22_Comic_Strip,_No._1_(published_in_The_New_York_Herald,_March_20,_1910)_MET_DP856515.jpg",
    author: "Herbert Crowley",
    licence: "CC0",
    notes:
      "1910 colour Sunday comic page: flat printed colour, ink outlines, lettering.",
  },
  {
    label: "graphic-flat-design-desk",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/a0/Laptop-coffee-flat-design-by-david-mendoza.png",
    ext: ".png",
    width: 3002,
    height: 2002,
    split: "tune",
    sha256: "05052971fb70305f0b0374fdb4188f1a170fdc5d8bb3a3e47f4a4240b1197483",
    source:
      "https://commons.wikimedia.org/wiki/File:Laptop-coffee-flat-design-by-david-mendoza.png",
    author: "Zombkid",
    licence: "CC BY-SA 4.0",
    notes:
      "Flat-design vector illustration: large uniform colour fields, no gradients.",
  },
  {
    label: "graphic-geonames-map",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/a8/Geonames_world_map_%286281371842%29.png",
    ext: ".png",
    width: 7200,
    height: 3600,
    split: "tune",
    sha256: "620e583c5123dd2fa7775b954a4fa62a683d38fa9b4f66f07dae03fcb68a66e9",
    source:
      "https://commons.wikimedia.org/wiki/File:Geonames_world_map_(6281371842).png",
    author: "Charlie Loyd from 94606, USA",
    licence: "CC BY 2.0",
    notes: "Dot-density world map: fine stippled detail on a dark ground.",
  },
  {
    label: "graphic-gnome-desktop",
    url: "https://upload.wikimedia.org/wikipedia/commons/f/f3/Nyarch_Linux_GNOME_50_Desktop_Screenshot.png",
    ext: ".png",
    width: 1920,
    height: 1080,
    split: "holdout",
    sha256: "ac321db9b5bdfd7fb0e42ee3f7ab484337b11d8b0891de5567da75bed004038d",
    source:
      "https://commons.wikimedia.org/wiki/File:Nyarch_Linux_GNOME_50_Desktop_Screenshot.png",
    author: "The GNOME Project and Nyarch Linux Developers",
    licence: "CC BY 4.0",
    notes:
      "Linux desktop screenshot: window chrome, icons and a photographic wallpaper.",
  },
  {
    label: "graphic-infographic-timeline",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/df/Constitutional_recognition_in_South_Africa_Timeline_Infographic.png",
    ext: ".png",
    width: 788,
    height: 865,
    split: "tune",
    sha256: "9992cd11ecde839df92bfca7bb5f9f26cbf34995a8defe816303447c8799f7c5",
    source:
      "https://commons.wikimedia.org/wiki/File:Constitutional_recognition_in_South_Africa_Timeline_Infographic.png",
    author: "Andrea Bauling",
    licence: "CC BY-SA 4.0",
    notes: "Infographic timeline: flat colour blocks, icons and body text.",
  },
  {
    label: "graphic-lineart-pictographs",
    url: "https://upload.wikimedia.org/wikipedia/commons/6/6f/Pictographs_%28PSF%29.png",
    ext: ".png",
    width: 3676,
    height: 618,
    split: "tune",
    sha256: "cefed9c71dc7a3f8c7564fc52dd9e57bf667d5fc794913cd4c8f3689e8b9f4a8",
    source: "https://commons.wikimedia.org/wiki/File:Pictographs_(PSF).png",
    author: "Pearson Scott Foresman",
    licence: "Public domain",
    notes:
      "Row of monochrome pictograms; flat black shapes on white, extreme aspect.",
  },
  {
    label: "graphic-lineart-scarecrow",
    url: "https://upload.wikimedia.org/wikipedia/commons/2/21/Scarecrow_%28PSF%29.png",
    ext: ".png",
    width: 1817,
    height: 2061,
    split: "holdout",
    sha256: "ff8d79e50f91a00d0f1e7f33f06fe828282d315f53bee6c27178f2b94262f10d",
    source: "https://commons.wikimedia.org/wiki/File:Scarecrow_(PSF).png",
    author: "Pearson Scott Foresman",
    licence: "Public domain",
    notes:
      "Dense engraving-style hatched line art, monochrome, high spatial frequency.",
  },
  {
    label: "graphic-logo-solid-blue",
    url: "https://upload.wikimedia.org/wikipedia/commons/8/8c/Ambigram_New_Man_logo_by_Raymond_Loewy_%28blue_background%29.png",
    ext: ".png",
    width: 6600,
    height: 4400,
    split: "tune",
    sha256: "b8651f9625e2639fe5edc9c32c9e4eeb2b3073d086813c8c35e024da677804f9",
    source:
      "https://commons.wikimedia.org/wiki/File:Ambigram_New_Man_logo_by_Raymond_Loewy_(blue_background).png",
    author: "Raymond Loewy",
    licence: "Public domain",
    notes:
      "Logo on a solid blue field: two flat colours, huge uniform background area.",
  },
  {
    label: "graphic-periodic-table-nist",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/df/Periodic_Table_-_Atomic_Properties_of_the_Elements.png",
    ext: ".png",
    width: 3300,
    height: 2550,
    split: "tune",
    sha256: "cc1dfe32b5a69817debaba2ae3fe28133a249d78809d26355607f182bf1c941c",
    source:
      "https://commons.wikimedia.org/wiki/File:Periodic_Table_-_Atomic_Properties_of_the_Elements.png",
    author:
      "R.A. Dragoset, A. Musgrove, C.W. Clark, and W.C. Martin — NIST, Physical Measurement Laboratory",
    licence: "Public domain",
    notes: "Reference table: coloured cells, dense small numerals and text.",
  },
  {
    label: "graphic-playfair-piecharts",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Playfair_piecharts.jpg",
    ext: ".jpg",
    width: 6306,
    height: 3456,
    split: "holdout",
    sha256: "95e0cedb123c1237e954b1d1092d11be48b52104f2c78ba7354b06d53d5b4f86",
    source: "https://commons.wikimedia.org/wiki/File:Playfair_piecharts.jpg",
    author: "William Playfair",
    licence: "Public domain",
    notes:
      "Historic hand-engraved statistical pie charts; aged paper, JPEG scan.",
  },
  {
    label: "graphic-scientific-plot",
    url: "https://upload.wikimedia.org/wikipedia/commons/f/f6/HIVPlot10.png",
    ext: ".png",
    width: 3200,
    height: 1600,
    split: "tune",
    sha256: "9230123c94a491ed5da769521bbe0607f5e26b7b48cc31b0637421055b03aa89",
    source: "https://commons.wikimedia.org/wiki/File:HIVPlot10.png",
    author: "Chamaemelum",
    licence: "Public domain",
    notes:
      "Horizontal seaborn-style bar chart: ten saturated category bars, grid lines and small axis text on white.",
  },
  {
    label: "graphic-sheet-music-dense",
    url: "https://upload.wikimedia.org/wikipedia/commons/b/be/Antonio_Bazzini_%E2%80%93_La_Ronde_des_Lutins_%28Dance_of_the_Goblins%29_%E2%80%93_Score%2C_First_Page.png",
    ext: ".png",
    width: 1781,
    height: 2363,
    split: "tune",
    sha256: "b7781ee6d008381c4e160b390e2cb8ce65f076be9659a7c0e179389b33732585",
    source:
      "https://commons.wikimedia.org/wiki/File:Antonio_Bazzini_%E2%80%93_La_Ronde_des_Lutins_(Dance_of_the_Goblins)_%E2%80%93_Score,_First_Page.png",
    author: "Antonio Bazzini",
    licence: "Public domain",
    notes: "Dense engraved violin score: very high stroke density, monochrome.",
  },
  {
    label: "graphic-smps-schematic",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/4d/24V_10A_SMPS_Circuit_Diagram.jpg",
    ext: ".jpg",
    width: 7016,
    height: 4961,
    split: "holdout",
    sha256: "334e85b5b4b8c3abe1860dacb90da7bbd357569faa57dc8b6510070efa4ff839",
    source:
      "https://commons.wikimedia.org/wiki/File:24V_10A_SMPS_Circuit_Diagram.jpg",
    author: "Amila Ruwan 20",
    licence: "CC BY-SA 4.0",
    notes:
      "Detailed power-supply schematic as a JPEG; thin lines, ringing-prone content.",
  },
  {
    label: "graphic-tiling-wm",
    url: "https://upload.wikimedia.org/wikipedia/commons/1/15/Awesome_screenshot_ja.png",
    ext: ".png",
    width: 1280,
    height: 1024,
    split: "tune",
    sha256: "a6d916ce0b0a1ed8725156cb333285d605df9f863ea34bcdaf34d03ee5a2e57b",
    source: "https://commons.wikimedia.org/wiki/File:Awesome_screenshot_ja.png",
    author: "blowback",
    licence: "CC BY-SA 3.0",
    notes:
      "Tiling window manager screenshot: dense monospace terminal text, high frequency detail.",
  },
  {
    label: "graphic-timechart-six-nations",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/a4/1883-2023_Six_Nations_victories_time_chart_per_country.png",
    ext: ".png",
    width: 1529,
    height: 999,
    split: "tune",
    sha256: "ea2ff4f323ad6cfa1f68831a26c530d600ecbc689a6cf1b16f13ed05520da5bf",
    source:
      "https://commons.wikimedia.org/wiki/File:1883-2023_Six_Nations_victories_time_chart_per_country.png",
    author: "Blackcat",
    licence: "CC0",
    notes:
      "Dense categorical time chart, many small coloured cells and labels.",
  },
  {
    label: "graphic-transit-diagram",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/e9/Bengaluru_Urban_Rail_Transit_Diagram.png",
    ext: ".png",
    width: 9983,
    height: 13113,
    split: "holdout",
    sha256: "4191a1ad8c1b4a897c537a422df91cfb87734826c38c0f0a885f729f96e4627d",
    source:
      "https://commons.wikimedia.org/wiki/File:Bengaluru_Urban_Rail_Transit_Diagram.png",
    author: "Footy2000",
    licence: "CC BY 4.0",
    notes:
      "Schematic transit map: pure flat colour, straight strokes, dense small text.",
  },
  {
    label: "graphic-web-app-screenshot",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/ea/Apps.education.fr_screenshot.png",
    ext: ".png",
    width: 1920,
    height: 1080,
    split: "tune",
    sha256: "3af04a4bc4dfdd53ab6bf5d4f17b2f37ab100fa021b60a169d3ab876ceb3fae0",
    source:
      "https://commons.wikimedia.org/wiki/File:Apps.education.fr_screenshot.png",
    author: "FramaKa",
    licence: "CC BY-SA 4.0",
    notes:
      "Website screenshot: flat cards, text blocks and a large colour field.",
  },
  {
    label: "graphic-wikipedia-text-page",
    url: "https://upload.wikimedia.org/wikipedia/commons/f/f3/2020-07-02_Screenshot_The_Book_Chronom%C3%A8tre_-_Chronopolis.png",
    ext: ".png",
    width: 1646,
    height: 1975,
    split: "tune",
    sha256: "47a33fc28e64aa8e9218235caaa759060d653a9b8c4b7fd2bd733e75387b6dfc",
    source:
      "https://commons.wikimedia.org/wiki/File:2020-07-02_Screenshot_The_Book_Chronom%C3%A8tre_-_Chronopolis.png",
    author: "Stefan Kühn",
    licence: "CC0",
    notes:
      "Text-heavy page screenshot: dense body text, links and headings, near-monochrome.",
  },
  {
    label: "graphic-world-map-colour",
    url: "https://upload.wikimedia.org/wikipedia/commons/2/2e/1-12_Color_Map_World.png",
    ext: ".png",
    width: 4572,
    height: 2500,
    split: "holdout",
    sha256: "e21e3a23daa9e8e5b43c61255350df5efa1211ec281cd9567ca6e07cc0703233",
    source: "https://commons.wikimedia.org/wiki/File:1-12_Color_Map_World.png",
    author: "Colomet",
    licence: "Public domain",
    notes: "Flat colour-coded world map: large uniform regions, hard borders.",
  },
];

/**
 * Ensure every graphics fixture is present and content-pinned. A fetch failure
 * or digest mismatch throws — see `ensureNaturalImages` for why.
 */
export async function ensureGraphicImages(): Promise<string[]> {
  await fs.mkdir(GRAPHIC_DIR, { recursive: true });
  const paths: string[] = [];
  let downloaded = 0;
  for (const spec of GRAPHIC_IMAGES) {
    const filePath = path.join(GRAPHIC_DIR, `${spec.label}${spec.ext}`);
    if (
      await ensurePinnedFixture({
        filePath,
        urls: [spec.url],
        sha256: spec.sha256,
        label: spec.label,
      })
    ) {
      downloaded++;
    }
    paths.push(filePath);
  }
  if (downloaded > 0) {
    console.log(`Downloaded ${downloaded} graphic image(s) to ${GRAPHIC_DIR}`);
  }
  return paths;
}
