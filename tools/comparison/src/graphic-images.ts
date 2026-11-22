import fs from "node:fs/promises";
import path from "node:path";
import { ensurePinnedFixture } from "./corpus-pin.ts";
import {
  type CorpusSplit,
  GRAPHIC_HOLDOUT3_PREFIX,
  type Holdout3Record,
} from "./corpus.ts";
import { type Holdout3Opening, checkHoldout3Pins } from "./holdout-images.ts";

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
  /**
   * A holdout3 pin's draw record and strata (#129); present on every
   * `sealed3-graphic-*` pin and on no other ({@link graphicHoldout3Specs}).
   */
  holdout3?: Holdout3Record;
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
 *
 * The `sealed3-graphic-*` entries are the graphics part of holdout3 (#129),
 * drawn by `corpus-covariates.ts --draw-holdout3` under the protocol
 * `spec/EXPERIMENTS.md` §11.12 records, by content type (screenshot, chart,
 * map, diagram, comic, text) in a seeded order, with no encoder run on any
 * candidate. Each carries its draw record and strata.
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
  {
    label: "sealed3-graphic-screenshot-lingua-libre-2026-website",
    url: "https://upload.wikimedia.org/wikipedia/commons/b/b9/Lingua_Libre_2026-Website-Topbar-Languages-Edit.png",
    ext: ".png",
    width: 1111,
    height: 181,
    split: "holdout3",
    sha256: "41f00c7f108ca50258165de7d0487da25fe40c3492e9ad957084e1e1e75b3832",
    source:
      "https://commons.wikimedia.org/wiki/File:Lingua_Libre_2026-Website-Topbar-Languages-Edit.png",
    author: "Yug",
    licence: "CC BY-SA 4.0",
    notes:
      "Content type screenshot, drawn from the website query; mean L* 94.2, mean C* 3.6, detail 8.77.",
    holdout3: {
      drawnAs: "screenshot",
      camera: null,
      phone: false,
      meanL: 94.1969,
      lowKey: 0.0052,
      skin: 0.0033,
      strata: ["graphics", "extreme-aspect"],
    },
  },
  {
    label: "sealed3-graphic-screenshot-discussiontools-usability-table-of",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/dc/DiscussionTools_Usability_Table_of_Contents_screenshot_zh.png",
    ext: ".png",
    width: 726,
    height: 1002,
    split: "holdout3",
    sha256: "3fe05ffde08e90d3d3298806e036fd2c05bab159d1373ce54f5e3a3dc1dc22b8",
    source:
      "https://commons.wikimedia.org/wiki/File:DiscussionTools_Usability_Table_of_Contents_screenshot_zh.png",
    author:
      "User interface design by Jess Klein and other contributors to mw:Extension:DiscussionTools. Text primarily from the public domain source mw:Sample discussion by Whatamidoing (WMF) (originally), translated into Chinese",
    licence: "CC0",
    notes:
      "Content type screenshot, drawn from the ui query; mean L* 95.6, mean C* 1.6, detail 2.85.",
    holdout3: {
      drawnAs: "screenshot",
      camera: null,
      phone: false,
      meanL: 95.581,
      lowKey: 0.0019,
      skin: 0,
      strata: ["graphics"],
    },
  },
  {
    label: "sealed3-graphic-screenshot-screenshot-of-a-website",
    url: "https://upload.wikimedia.org/wikipedia/commons/1/1f/Screenshot_of_a_website_for_public_peer_review_-_review_referencing_document_passages.png",
    ext: ".png",
    width: 1525,
    height: 1408,
    split: "holdout3",
    sha256: "a04ad71a2dec4f11a083bb433b13da50bbc83f3f2a0b672ddb9b3629ee85e346",
    source:
      "https://commons.wikimedia.org/wiki/File:Screenshot_of_a_website_for_public_peer_review_-_review_referencing_document_passages.png",
    author:
      "Daniel Bingham (screenshots of his FOSS website for public peer reviews)",
    licence: "CC BY 4.0",
    notes:
      "Content type screenshot, drawn from the website query; mean L* 97.2, mean C* 0.6, detail 4.39.",
    holdout3: {
      drawnAs: "screenshot",
      camera: null,
      phone: false,
      meanL: 97.2235,
      lowKey: 0.0002,
      skin: 0.0018,
      strata: ["graphics"],
    },
  },
  {
    label: "sealed3-graphic-chart-figure-3-education-where",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/e1/Figure_3_education_%28Where_experts_and_amateurs_meet%29.png",
    ext: ".png",
    width: 1066,
    height: 517,
    split: "holdout3",
    sha256: "43bb2e40e8ebdfafdfd4b0f9a1729bdc3a94dbc2df39bb6cd3a45c60552b4231",
    source:
      "https://commons.wikimedia.org/wiki/File:Figure_3_education_(Where_experts_and_amateurs_meet).png",
    author: "Piotrus",
    licence: "CC BY-SA 4.0",
    notes:
      "Content type chart, drawn from the pie query; mean L* 92.3, mean C* 12.2, detail 4.51.",
    holdout3: {
      drawnAs: "chart",
      camera: null,
      phone: false,
      meanL: 92.2925,
      lowKey: 0.0002,
      skin: 0.0045,
      strata: ["graphics"],
    },
  },
  {
    label: "sealed3-graphic-chart-miaoli-county-constituency-2",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/4a/Miaoli_County_Constituency_2_results_%28coalition%29.png",
    ext: ".png",
    width: 1440,
    height: 926,
    split: "holdout3",
    sha256: "e0d96ec0d8acaf79410c3e0244f8a84e56c335c9ec91dc8721a7cf8cd3057bcb",
    source:
      "https://commons.wikimedia.org/wiki/File:Miaoli_County_Constituency_2_results_(coalition).png",
    author: "CptnPhasma",
    licence: "CC0",
    notes:
      "Content type chart, drawn from the line query; mean L* 97.6, mean C* 0.8, detail 5.01.",
    holdout3: {
      drawnAs: "chart",
      camera: null,
      phone: false,
      meanL: 97.5594,
      lowKey: 0.0064,
      skin: 0,
      strata: ["graphics"],
    },
  },
  {
    label: "sealed3-graphic-chart-dandenong-pv",
    url: "https://upload.wikimedia.org/wikipedia/commons/8/83/Dandenong_PV.png",
    ext: ".png",
    width: 1920,
    height: 1080,
    split: "holdout3",
    sha256: "1e07ece294fffd36e3096464a123fca127fff027c55a82d863e92b7b38b40081",
    source: "https://commons.wikimedia.org/wiki/File:Dandenong_PV.png",
    author: "Sh1pp02",
    licence: "CC0",
    notes:
      "Content type chart, drawn from the line query; mean L* 97.5, mean C* 0.9, detail 5.26.",
    holdout3: {
      drawnAs: "chart",
      camera: null,
      phone: false,
      meanL: 97.4914,
      lowKey: 0.0079,
      skin: 0,
      strata: ["graphics"],
    },
  },
  {
    label: "sealed3-graphic-map-fluchtroute-von-chris-van",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/d4/Fluchtroute_von_Chris_van_Oosterzee_1944_%E2%80%93_deutsche_Version.png",
    ext: ".png",
    width: 1054,
    height: 1492,
    split: "holdout3",
    sha256: "ca5bbc4b3a4515f5efc2795fae84f9059e6130a909cb9837c6d80475bc4eb17e",
    source:
      "https://commons.wikimedia.org/wiki/File:Fluchtroute_von_Chris_van_Oosterzee_1944_%E2%80%93_deutsche_Version.png",
    author: "Sterz",
    licence: "CC BY-SA 4.0",
    notes:
      "Content type map, drawn from the topographic query; mean L* 77.4, mean C* 24.0, detail 7.33.",
    holdout3: {
      drawnAs: "map",
      camera: null,
      phone: false,
      meanL: 77.4349,
      lowKey: 0.0107,
      skin: 0.0014,
      strata: ["graphics"],
    },
  },
  {
    label: "sealed3-graphic-map-hawaii-saare-kaart",
    url: "https://upload.wikimedia.org/wikipedia/commons/3/3e/Hawaii_saare_kaart.png",
    ext: ".png",
    width: 1415,
    height: 1165,
    split: "holdout3",
    sha256: "58468b90088de271e61e94c6e50d7e55ecefa77de522ea19423440465df18e03",
    source: "https://commons.wikimedia.org/wiki/File:Hawaii_saare_kaart.png",
    author:
      "Hawaii_Island_topographic_map-fr.svg: Sémhur derivative work: Pikne (talk)",
    licence: "CC BY-SA 3.0",
    notes:
      "Content type map, drawn from the topographic query; mean L* 72.7, mean C* 18.0, detail 4.37.",
    holdout3: {
      drawnAs: "map",
      camera: null,
      phone: false,
      meanL: 72.7064,
      lowKey: 0.0004,
      skin: 0.0037,
      strata: ["graphics"],
    },
  },
  {
    label: "sealed3-graphic-map-1990-epping-forest-district",
    url: "https://upload.wikimedia.org/wikipedia/commons/3/38/1990_Epping_Forest_District_Council_local_election_results_map_%28revised%29.png",
    ext: ".png",
    width: 3303,
    height: 3130,
    split: "holdout3",
    sha256: "0da188724a0e63c79b7613b85e917fa95d9a725697ec57e791321190a6e11474",
    source:
      "https://commons.wikimedia.org/wiki/File:1990_Epping_Forest_District_Council_local_election_results_map_(revised).png",
    author: "EppingStewart67",
    licence: "CC BY-SA 4.0",
    notes:
      "Content type map, drawn from the election query; mean L* 83.0, mean C* 23.9, detail 6.52.",
    holdout3: {
      drawnAs: "map",
      camera: null,
      phone: false,
      meanL: 82.9985,
      lowKey: 0.0159,
      skin: 0.0007,
      strata: ["graphics"],
    },
  },
  {
    label: "sealed3-graphic-diagram-data-processing-flowchart-of",
    url: "https://upload.wikimedia.org/wikipedia/commons/0/0e/Data_processing_flowchart_of_CE-4.png",
    ext: ".png",
    width: 1326,
    height: 819,
    split: "holdout3",
    sha256: "faa490eb692ae4ca598c9b6e6cd985a37e6cb7746b37cb51efb177927f0dacf6",
    source:
      "https://commons.wikimedia.org/wiki/File:Data_processing_flowchart_of_CE-4.png",
    author:
      "Jianjun Liu, Xin Ren, Wei Yan, Chunlai Li, He Zhang, Yang Jia, Xingguo Zeng, Wangli Chen, Xingye Gao, Dawei Liu, Xu Tan, Xiaoxia Zhang, Tao Ni, Hongbo Zhang, Wei Zuo, Yan Su & Weibin Wen",
    licence: "CC BY 4.0",
    notes:
      "Content type diagram, drawn from the flowchart query; mean L* 97.0, mean C* 0.1, detail 7.21.",
    holdout3: {
      drawnAs: "diagram",
      camera: null,
      phone: false,
      meanL: 97.0472,
      lowKey: 0.0006,
      skin: 0,
      strata: ["graphics"],
    },
  },
  {
    label: "sealed3-graphic-diagram-cobs-encoding-process",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/e5/COBS_encoding_process.png",
    ext: ".png",
    width: 1335,
    height: 124,
    split: "holdout3",
    sha256: "2debcc35062268748f4d1f2c5330f59d5d49a045b9cc2274d58b1661c9770ac3",
    source: "https://commons.wikimedia.org/wiki/File:COBS_encoding_process.png",
    author: "Lambtron",
    licence: "CC BY-SA 4.0",
    notes:
      "Content type diagram, drawn from the block query; mean L* 91.9, mean C* 3.3, detail 14.46.",
    holdout3: {
      drawnAs: "diagram",
      camera: null,
      phone: false,
      meanL: 91.913,
      lowKey: 0.0015,
      skin: 0.0186,
      strata: ["graphics", "extreme-aspect"],
    },
  },
  {
    label: "sealed3-graphic-diagram-twins-consort-flow-diagram",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/e4/TwiNS_CONSORT_Flow_Diagram_of_identical_twins_diet_trial.png",
    ext: ".png",
    width: 1680,
    height: 1135,
    split: "holdout3",
    sha256: "815a26f9c7812d62b58717cb026a0a1e6303505183073e146ca163df9a0601fa",
    source:
      "https://commons.wikimedia.org/wiki/File:TwiNS_CONSORT_Flow_Diagram_of_identical_twins_diet_trial.png",
    author:
      "Authors of the study: Matthew J. Landry, PhD, RDN1,2; Catherine P. Ward, PhD, RD1; Kristen M. Cunanan, PhD3; Lindsay R. Durand, MPH, RD1; Dalia Perelman, MS, RDN1; Jennifer L. Robinson, PhD1; Tayler Hennings, MPH1; Linda Koh, PhD, MS, RN1; Christopher Dant, PhD1; Amanda Zeitlin, MPH1; Emily R. Ebel, PhD4; Erica D. Sonnenburg, PhD4; Justin L. Sonnenburg, PhD4,5,6; Christopher D. Gardner, PhD1",
    licence: "CC BY 4.0",
    notes:
      "Content type diagram, drawn from the flowchart query; mean L* 96.0, mean C* 0.8, detail 6.93.",
    holdout3: {
      drawnAs: "diagram",
      camera: null,
      phone: false,
      meanL: 95.9612,
      lowKey: 0,
      skin: 0,
      strata: ["graphics"],
    },
  },
  {
    label: "sealed3-graphic-comic-movie-mat-is-inspired",
    url: "https://upload.wikimedia.org/wikipedia/commons/f/f7/Movie_Mat_is_Inspired_by_a_Thrilling_Film.jpg",
    ext: ".jpg",
    width: 2745,
    height: 2355,
    split: "holdout3",
    sha256: "f2ac0a67b4fd62ec4fe6b71a81f3cf450aaee01b003e328695e798ba0daef9ba",
    source:
      "https://commons.wikimedia.org/wiki/File:Movie_Mat_is_Inspired_by_a_Thrilling_Film.jpg",
    author: "V.F. Macom",
    licence: "Public domain",
    notes:
      "Content type comic, drawn from the strip-jpeg query; mean L* 44.7, mean C* 12.9, detail 7.09.",
    holdout3: {
      drawnAs: "comic",
      camera: null,
      phone: false,
      meanL: 44.6801,
      lowKey: 0.0664,
      skin: 0.3372,
      strata: ["graphics", "skin"],
    },
  },
  {
    label: "sealed3-graphic-comic-jon-1976-03-18",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/a7/Jon_-_1976-03-18.png",
    ext: ".png",
    width: 4932,
    height: 1518,
    split: "holdout3",
    sha256: "a969a316223d74076ad687a0b88840124515dec38ecd0930b370e456730fcc65",
    source: "https://commons.wikimedia.org/wiki/File:Jon_-_1976-03-18.png",
    author: "Jim Davis",
    licence: "Public domain",
    notes:
      "Content type comic, drawn from the strip query; mean L* 85.5, mean C* 0.0, detail 30.80.",
    holdout3: {
      drawnAs: "comic",
      camera: null,
      phone: false,
      meanL: 85.4783,
      lowKey: 0.0542,
      skin: 0,
      strata: ["graphics", "extreme-aspect"],
    },
  },
  {
    label: "sealed3-graphic-text-huxtable-typeface-sample",
    url: "https://upload.wikimedia.org/wikipedia/commons/7/79/Huxtable_typeface_sample.png",
    ext: ".png",
    width: 1352,
    height: 120,
    split: "holdout3",
    sha256: "73f21ae4c432c0103855eaed7554cb2c9cbd62ea1c71e499ea2e56ab4d230d45",
    source:
      "https://commons.wikimedia.org/wiki/File:Huxtable_typeface_sample.png",
    author: "Raymond Larabie",
    licence: "Public domain",
    notes:
      "Content type text, drawn from the specimen query; mean L* 85.8, mean C* 0.0, detail 13.32.",
    holdout3: {
      drawnAs: "text",
      camera: null,
      phone: false,
      meanL: 85.7837,
      lowKey: 0.1088,
      skin: 0,
      strata: ["graphics", "extreme-aspect"],
    },
  },
  {
    label: "sealed3-graphic-text-cinderhill-s-people-s",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/40/Cinderhill%27s_People%27s_Funeral_Speech.png",
    ext: ".png",
    width: 1621,
    height: 1953,
    split: "holdout3",
    sha256: "df8b863a7fb577d029de6aec860caddf1fadcd9c67cce5e3f59129f18aabf4c8",
    source:
      "https://commons.wikimedia.org/wiki/File:Cinderhill%27s_People%27s_Funeral_Speech.png",
    author: "Cattrina77",
    licence: "CC BY-SA 3.0",
    notes:
      "Content type text, drawn from the font query; mean L* 58.1, mean C* 8.7, detail 5.14.",
    holdout3: {
      drawnAs: "text",
      camera: null,
      phone: false,
      meanL: 58.0765,
      lowKey: 0.0002,
      skin: 0.0565,
      strata: ["graphics"],
    },
  },
];

/**
 * The graphics holdout3 pins (#129), after checking that every `sealed3-`
 * graphics pin is `sealed3-graphic-*` and holdout3, and carries its draw
 * record.
 */
export function graphicHoldout3Specs(
  images: readonly GraphicImageSpec[] = GRAPHIC_IMAGES,
): GraphicImageSpec[] {
  return checkHoldout3Pins(images, GRAPHIC_HOLDOUT3_PREFIX, "graphics");
}

/**
 * The pins {@link ensureGraphicImages} fetches. `holdout3` needs the gate's
 * opening and returns exactly the sealed part, refusing an empty one. Any
 * other split, or none, returns every pin that is not sealed: the tune and
 * holdout graphics every graphics sweep has always fetched, which the loader
 * then filters by split.
 */
export function graphicImagesToFetch(
  split?: CorpusSplit,
  images: readonly GraphicImageSpec[] = GRAPHIC_IMAGES,
  opening?: Holdout3Opening,
): GraphicImageSpec[] {
  const sealed = graphicHoldout3Specs(images);
  if (split === "holdout3") {
    if (opening === undefined) {
      throw new Error(
        "the graphics part of holdout3 is sealed: it is fetched only through the register gate (openHoldout3), for one decision spec/V0.8-DECISIONS.md records as frozen",
      );
    }
    if (sealed.length === 0) {
      throw new Error(
        `the graphics part of holdout3 has no pinned images in this table, so decision "${opening.decision}" cannot be read against it`,
      );
    }
    return sealed;
  }
  return images.filter((s) => s.split !== "holdout3");
}

/**
 * Ensure the graphics fixtures are present and content-pinned. A fetch
 * failure or digest mismatch throws — see `ensureNaturalImages` for why.
 * Which pins: {@link graphicImagesToFetch}.
 */
export async function ensureGraphicImages(
  split?: CorpusSplit,
  opening?: Holdout3Opening,
): Promise<string[]> {
  await fs.mkdir(GRAPHIC_DIR, { recursive: true });
  const paths: string[] = [];
  let downloaded = 0;
  for (const spec of graphicImagesToFetch(split, GRAPHIC_IMAGES, opening)) {
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
