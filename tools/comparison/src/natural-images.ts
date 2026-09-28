import fs from "node:fs/promises";
import path from "node:path";
import { ensurePinnedFixture } from "./corpus-pin.ts";
import type { CorpusSplit } from "./corpus.ts";

const NATURAL_DIR = path.resolve(import.meta.dirname, "../fixtures/natural");

export interface NaturalImageSpec {
  /**
   * Label used as the filename stem (`<label><ext>`). Its prefix drives
   * categorization: `natural-`/`chroma-` → Natural, `portrait-` → Portrait,
   * `night-` → Night (see report.ts `categorizeImage`), and `corpus.ts` keys
   * the photo corpus off the same prefixes.
   */
  label: string;
  /** Sources to fetch from, tried in order (see corpus-pin.ts). */
  urls: readonly string[];
  /** File extension, including the dot — Commons carries both JPEG and PNG. */
  ext: string;
  /** Native width of the pinned original. */
  width: number;
  /** Native height of the pinned original. */
  height: number;
  /**
   * Corpus split (see corpus.ts): constants sweeps tune on "tune" images only.
   * "tune2" is the photographic holdout #76 retired as spent; "holdout2" is
   * the sealed one, whose label must start with `HOLDOUT2_PREFIX` and which
   * {@link ensureNaturalImages} never fetches. Never move an image out of a
   * holdout except by retiring the whole split, disclosed where its results
   * are reported.
   */
  split: CorpusSplit;
  /**
   * SHA-256 of the exact bytes of the pinned original — the content pin,
   * verified on every load, cached or freshly downloaded; a mismatch is fatal
   * (see corpus-pin.ts). Commons originals are immutable: a re-upload becomes a
   * new version at a new URL rather than changing these bytes.
   */
  sha256: string;
  /** Commons file page, for attribution. */
  source: string;
  /** Author, as Commons records them. */
  author: string;
  /** Licence short name, as Commons records it. */
  licence: string;
  /** Which axis of the §9.1 corpus audit this image is here to cover. */
  axis: string;
  /** Measured on the 512 px scoring reference — see the notes in §12. */
  notes: string;
}

/**
 * Curated photographic corpus, from Wikimedia Commons.
 *
 * The set is curated along the axes the format is actually sensitive to, not by
 * subject matter: illuminant (daylight / tungsten / mixed interior / night
 * artificial), key (high-key framing through to near-black night), chroma
 * (achromatic through to flat saturated paint), spatial frequency (smooth
 * gradient through to dense facade), skin tone, and orientation. A gap on one
 * of those axes is a gap in the evidence.
 *
 * Selection was measured, not guessed: every candidate was reduced to the same
 * 512 px reference the harness scores against, and mean L*, mean chroma C* and
 * Laplacian detail energy were computed on it; the set was then chosen to span
 * each axis rather than cluster at its centre. Candidates were restricted to
 * files carrying camera EXIF and outside Commons' artwork categories, because a
 * search for "portrait photograph" on an archive returns as many oil paintings
 * as photographs, and a scanned painting has nothing statistically in common
 * with what an LQIP pipeline ingests.
 *
 * Every image is freely licensed and attributed per image in
 * `fixtures/natural/LICENSES.md`, which is generated from this table
 * (`mise run corpus:licenses`) so the two cannot drift.
 *
 * Adding or removing an image changes every mean in `spec/EXPERIMENTS.md`, so
 * the whole sweep set is re-run in the same change (see §9 and §12 there).
 */
export const CURATED_IMAGES: NaturalImageSpec[] = [
  {
    label: "chroma-black-and-white",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/a/a8/Black_and_white_cat%E2%80%93IMG_6332_02.jpg",
    ],
    ext: ".jpg",
    width: 4157,
    height: 2771,
    split: "tune2",
    sha256: "0ea4fa6c16e8923ec0b3658a5cebb6bee4ba32ae35bca0641b69b9fe64e27f50",
    source:
      "https://commons.wikimedia.org/wiki/File%3ABlack_and_white_cat%E2%80%93IMG_6332_02.jpg",
    author: "Kızıl",
    licence: "CC BY-SA 4.0",
    axis: "the chroma floor: near-zero C*",
    notes: "landscape, mean L* 40.1, mean C* 6.8, detail 9.85",
  },
  {
    label: "chroma-glass-reinforcements",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/1/1a/Glass_reinforcements.jpg",
    ],
    ext: ".jpg",
    width: 1523,
    height: 1437,
    split: "tune",
    sha256: "7dc132db36c390e2be4b2b343a52b09525e24a8cbeb671113bfc4072bed707eb",
    source:
      "https://commons.wikimedia.org/wiki/File%3AGlass_reinforcements.jpg",
    author: "Cjp24",
    licence: "CC BY-SA 3.0",
    axis: "flat woven pattern",
    notes: "landscape, mean L* 72.2, mean C* 6.6, detail 28.4",
  },
  {
    label: "chroma-the-old-monochrome",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/6/6e/The_old_in_monochrome%2C_Mary_street%2C_Gympie_-_panoramio.jpg",
    ],
    ext: ".jpg",
    width: 2736,
    height: 3648,
    split: "tune",
    sha256: "b6e5db7f2b2225939b08ea4d7de2c0e5ba2fa590a6c1dda7bc682de5c759024b",
    source:
      "https://commons.wikimedia.org/wiki/File%3AThe_old_in_monochrome%2C_Mary_street%2C_Gympie_-_panoramio.jpg",
    author: "Sue Allen",
    licence: "CC BY-SA 3.0",
    axis: "the chroma floor: near-zero C*",
    notes: "portrait, mean L* 46.2, mean C* 0, detail 24.56",
  },
  {
    label: "chroma-windows-toronto-city",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/b/b7/Windows_of_Toronto_City_Hall_%28Monochrome%29.jpg",
    ],
    ext: ".jpg",
    width: 6000,
    height: 3885,
    split: "tune",
    sha256: "ebd77b5d88886ee03a4f38be2a87c88ab364beab124270c20a3e52c9a8df1027",
    source:
      "https://commons.wikimedia.org/wiki/File%3AWindows_of_Toronto_City_Hall_(Monochrome).jpg",
    author: "Maksim Sokolov (maxergon.com)",
    licence: "CC BY-SA 4.0",
    axis: "the chroma floor: near-zero C*",
    notes: "landscape, mean L* 27.7, mean C* 1.1, detail 39.81",
  },
  {
    label: "natural-landschaftsschutzgebiet-dwest-gen",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/4/4f/Landschaftsschutzgebiet_S%C3%BCdwest-R%C3%BCgen-Zudar_lub_2026-02-07_img26.jpg",
    ],
    ext: ".jpg",
    width: 4032,
    height: 3024,
    split: "tune2",
    sha256: "c76ccdd7cb56c1959272d57726c324998e3cb81bcaa0d658180d0d065d3bd33a",
    source:
      "https://commons.wikimedia.org/wiki/File%3ALandschaftsschutzgebiet_S%C3%BCdwest-R%C3%BCgen-Zudar_lub_2026-02-07_img26.jpg",
    author: "Lukas Beck",
    licence: "CC BY 4.0",
    axis: "high-key framing, DC-dominated",
    notes: "landscape, mean L* 66.4, mean C* 13.3, detail 40.79",
  },
  {
    label: "natural-landschaftsschutzgebiet-volkspark-rehberge",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/5/54/Landschaftsschutzgebiet_Volkspark_Rehberge_lub_2026-01-03_img02_snow.jpg",
    ],
    ext: ".jpg",
    width: 4032,
    height: 3024,
    split: "tune",
    sha256: "8600924344d252eeed2d5bfeb8502c77dedca362bcb4f996f63d94e8b5081b01",
    source:
      "https://commons.wikimedia.org/wiki/File%3ALandschaftsschutzgebiet_Volkspark_Rehberge_lub_2026-01-03_img02_snow.jpg",
    author: "Lukas Beck",
    licence: "CC BY 4.0",
    axis: "high-key framing, DC-dominated",
    notes: "landscape, mean L* 59.5, mean C* 3.1, detail 75.92",
  },
  {
    label: "natural-studioarrangement-for-product",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/5/5b/Studioarrangement_for_product_photography_and_video_2296.jpg",
    ],
    ext: ".jpg",
    width: 4374,
    height: 2925,
    split: "tune",
    sha256: "7eac9625191027dc861c05e4b548f8fe2fa6b7abc37bcba5b0ac1270116b5c54",
    source:
      "https://commons.wikimedia.org/wiki/File%3AStudioarrangement_for_product_photography_and_video_2296.jpg",
    author: "Hubertl",
    licence: "CC BY-SA 4.0",
    axis: "high-key framing, DC-dominated",
    notes: "landscape, mean L* 43.3, mean C* 8.6, detail 13.96",
  },
  {
    label: "natural-hard-rock-cafe",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/b/be/Hard_Rock_Cafe_interior_%288348879216%29.jpg",
    ],
    ext: ".jpg",
    width: 3296,
    height: 2472,
    split: "tune",
    sha256: "fe9f5c50d1c5c7439526f45de71e211c7d46b6486c3ddbd469f4be5999c07a62",
    source:
      "https://commons.wikimedia.org/wiki/File%3AHard_Rock_Cafe_interior_(8348879216).jpg",
    author: "shankar s. from Dubai, united arab emirates",
    licence: "CC BY 2.0",
    axis: "interior and mixed illuminants",
    notes: "landscape, mean L* 12.6, mean C* 11.4, detail 12.83",
  },
  {
    label: "natural-interior-cafe-commerce",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/c/c4/Interior%2C_Cafe_du_Commerce%2C_Paris_24_September_2016.jpg",
    ],
    ext: ".jpg",
    width: 4608,
    height: 3456,
    split: "tune2",
    sha256: "2bb825fed40007f83a759f4103691599fcdddb116d411648752dd8df990b7ec9",
    source:
      "https://commons.wikimedia.org/wiki/File%3AInterior%2C_Cafe_du_Commerce%2C_Paris_24_September_2016.jpg",
    author: "James Petts from London, England",
    licence: "CC BY-SA 2.0",
    axis: "interior and mixed illuminants",
    notes: "landscape, mean L* 50.6, mean C* 9.7, detail 23.09",
  },
  {
    label: "natural-maidens-tower",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/6/6c/Maidens_Tower_%288394899124%29.jpg",
    ],
    ext: ".jpg",
    width: 4288,
    height: 2848,
    split: "tune",
    sha256: "6e2003530320c4b0f943940b9038ce56f80da238811a059fbfe6ce8cc3bb3d40",
    source:
      "https://commons.wikimedia.org/wiki/File%3AMaidens_Tower_(8394899124).jpg",
    author: "Jorge Láscar from Australia",
    licence: "CC BY 2.0",
    axis: "interior and mixed illuminants",
    notes: "landscape, mean L* 79.7, mean C* 8.3, detail 17.7",
  },
  {
    label: "natural-mid-1920s-house",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/7/7b/Mid-1920s_House%2C_Downtown_Fort_Lauderdale_Florida%2C_January_2018_-_Interior_-_Kitchen_02.jpg",
    ],
    ext: ".jpg",
    width: 5184,
    height: 3888,
    split: "tune",
    sha256: "b71252c8ce94143164c38900d53f522d9e987e72eb00dd33384ae1d331bf95ec",
    source:
      "https://commons.wikimedia.org/wiki/File%3AMid-1920s_House%2C_Downtown_Fort_Lauderdale_Florida%2C_January_2018_-_Interior_-_Kitchen_02.jpg",
    author: "Infrogmation of New Orleans",
    licence: "CC BY 2.0",
    axis: "interior illuminant",
    notes: "landscape, mean L* 46.8, mean C* 18.3, detail 20.07",
  },
  {
    label: "natural-obama-center-library",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/0/03/Obama_Center_library_interior_%28President%27s_Reading_Room%29_-_Chicago%2C_IL_-_June_2026.jpg",
    ],
    ext: ".jpg",
    width: 3444,
    height: 2296,
    split: "tune",
    sha256: "c849e4ca78b07c8e51f28c9aee920a48a12f9ac04d7eb9e40c2082ccc3cd5195",
    source:
      "https://commons.wikimedia.org/wiki/File%3AObama_Center_library_interior_(President's_Reading_Room)_-_Chicago%2C_IL_-_June_2026.jpg",
    author: "AlphaBeta135",
    licence: "CC BY 4.0",
    axis: "interior illuminant",
    notes: "landscape, mean L* 25.2, mean C* 7.5, detail 7.41",
  },
  {
    label: "natural-table-set-for",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/5/58/Table_set_for_dining_in_a_modern_restaurant_interior_with_wooden_walls_and_elegant_decor.jpg",
    ],
    ext: ".jpg",
    width: 4032,
    height: 6048,
    split: "tune2",
    sha256: "9af6423b26141dce7d14aeeef58f94d4d980875ead7c7d6653814dec81ee756c",
    source:
      "https://commons.wikimedia.org/wiki/File%3ATable_set_for_dining_in_a_modern_restaurant_interior_with_wooden_walls_and_elegant_decor.jpg",
    author: "Shixart1985",
    licence: "CC BY 2.0",
    axis: "interior and mixed illuminants",
    notes: "portrait, mean L* 51.8, mean C* 19.3, detail 14.53",
  },
  {
    label: "natural-agraulis-vanillae-isla",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/2/20/Agraulis_vanillae_at_Isla_Margarita.jpg",
    ],
    ext: ".jpg",
    width: 4000,
    height: 2705,
    split: "tune",
    sha256: "04c47c24d08d713222691350748206f79cbbf40b14ce0833110c13f495b39b40",
    source:
      "https://commons.wikimedia.org/wiki/File%3AAgraulis_vanillae_at_Isla_Margarita.jpg",
    author: "Wilfredor",
    licence: "CC0",
    axis: "extreme close detail",
    notes: "landscape, mean L* 39.2, mean C* 21.9, detail 13.31",
  },
  {
    label: "natural-bird-cherry-ermine",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/5/50/Bird-cherry_ermine_moth_%28Yponomeuta_evonymella%29_caterpillars.jpg",
    ],
    ext: ".jpg",
    width: 5058,
    height: 3372,
    split: "tune",
    sha256: "bf2a30c065bc167f8d7a364b05412af44b106f780087cda1b196e4d96573c012",
    source:
      "https://commons.wikimedia.org/wiki/File%3ABird-cherry_ermine_moth_(Yponomeuta_evonymella)_caterpillars.jpg",
    author: "Charles J. Sharp",
    licence: "CC BY-SA 4.0",
    axis: "fine fur/feather texture",
    notes: "landscape, mean L* 21.6, mean C* 12.6, detail 19",
  },
  {
    label: "natural-dish-meatloaf-served",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/8/87/Dish_of_meatloaf_served_on_a_white_plate_with_sauce_and_herbs_in_a_restaurant_setting.jpg",
    ],
    ext: ".jpg",
    width: 5184,
    height: 6912,
    split: "tune",
    sha256: "cacedc4705bfd6433849756addb692920b1819db2b187dd8ef3c7922f9d35017",
    source:
      "https://commons.wikimedia.org/wiki/File%3ADish_of_meatloaf_served_on_a_white_plate_with_sauce_and_herbs_in_a_restaurant_setting.jpg",
    author: "Shixart1985",
    licence: "CC BY 2.0",
    axis: "close framing, saturated food",
    notes: "portrait, mean L* 62.1, mean C* 9.6, detail 14.81",
  },
  {
    label: "natural-egretta-thula-las",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/f/f9/Egretta_thula_at_Las_Gallinas_Wildlife_Ponds.jpg",
    ],
    ext: ".jpg",
    width: 2437,
    height: 3159,
    split: "tune2",
    sha256: "00e9a470e07721ac2d384a437fe922f66ee82c27cc81c106e8a2097a14bfb6c1",
    source:
      "https://commons.wikimedia.org/wiki/File%3AEgretta_thula_at_Las_Gallinas_Wildlife_Ponds.jpg",
    author: "Frank Schulenburg",
    licence: "CC BY-SA 3.0",
    axis: "fine fur/feather texture",
    notes: "portrait, mean L* 53, mean C* 13.9, detail 8.12",
  },
  {
    label: "natural-fishing-the-coast",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/3/3b/Fishing_on_the_coast_of_South_China_Sea%2C_Lang_Co%2C_Vietnam.jpg",
    ],
    ext: ".jpg",
    width: 3984,
    height: 2656,
    split: "tune",
    sha256: "7497c8976f59942a24cefbd7fa94e2097ae2504e6f295e4453fa6082384f6fcf",
    source:
      "https://commons.wikimedia.org/wiki/File%3AFishing_on_the_coast_of_South_China_Sea%2C_Lang_Co%2C_Vietnam.jpg",
    author: "Vyacheslav Argenberg",
    licence: "CC BY 4.0",
    axis: "outdoor daylight landscape",
    notes: "landscape, mean L* 64.6, mean C* 8.3, detail 7.06",
  },
  {
    label: "natural-forest-road-slavne",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/c/cc/Forest_road_Slavne_2017_BW_G9.jpg",
    ],
    ext: ".jpg",
    width: 4500,
    height: 2850,
    split: "tune",
    sha256: "54f1fae4f6195bbb1092e5ce87abe946fc691cb17ebfcdcacc916f181936f07d",
    source:
      "https://commons.wikimedia.org/wiki/File%3AForest_road_Slavne_2017_BW_G9.jpg",
    author: "George Chernilevsky",
    licence: "Public domain",
    axis: "outdoor daylight landscape",
    notes: "landscape, mean L* 53.2, mean C* 0, detail 74.18",
  },
  {
    label: "natural-lmen-umland",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/7/76/D%C3%BClmen%2C_Umland_--_2014_--_7056.jpg",
    ],
    ext: ".jpg",
    width: 5184,
    height: 3456,
    split: "tune",
    sha256: "1330a32f865b6d3d713336bade56cb97d6b2c77a4d5b4506f309136de8bce3e6",
    source:
      "https://commons.wikimedia.org/wiki/File%3AD%C3%BClmen%2C_Umland_--_2014_--_7056.jpg",
    author: "Dietmar Rabich",
    licence: "CC BY-SA 4.0",
    axis: "outdoor daylight landscape",
    notes: "landscape, mean L* 46.7, mean C* 11, detail 35.93",
  },
  {
    label: "natural-mabrousha-cake-with",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/d/d7/Mabrousha_cake_with_strawberry_jam_-_Home_baked_Middle_Eastern_dessert.jpg",
    ],
    ext: ".jpg",
    width: 3456,
    height: 4608,
    split: "tune2",
    sha256: "fc1bc49c2b2ca9675bd87205d7b4382ef2b10d80da8346600abd9a19a637d985",
    source:
      "https://commons.wikimedia.org/wiki/File%3AMabrousha_cake_with_strawberry_jam_-_Home_baked_Middle_Eastern_dessert.jpg",
    author: "Hayan Alhasan",
    licence: "CC BY-SA 4.0",
    axis: "close framing, saturated food",
    notes: "portrait, mean L* 47.7, mean C* 13.5, detail 35.72",
  },
  {
    label: "natural-nnov-shcherbinki-produce",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/b/b8/NNov-Shcherbinki-produce-vendors-C0469.jpg",
    ],
    ext: ".jpg",
    width: 2048,
    height: 1536,
    split: "tune",
    sha256: "10030c1934c2753f6fd77451a45af8a8c94494252e0213df646b08b9d2d2185e",
    source:
      "https://commons.wikimedia.org/wiki/File%3ANNov-Shcherbinki-produce-vendors-C0469.jpg",
    author: "Vmenkov",
    licence: "CC BY-SA 4.0",
    axis: "cluttered saturated scene",
    notes: "landscape, mean L* 44.4, mean C* 15.2, detail 34.75",
  },
  {
    label: "natural-pike-place-market",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/1/1c/Pike_Place_Market_produce_vendor%2C_circa_1970s_%2846728151995%29.jpg",
    ],
    ext: ".jpg",
    width: 3469,
    height: 2298,
    split: "tune",
    sha256: "be45216f8c7cdbf31997ebacce9f297a0e20b3c5b4a5b07b7bc33fc3e674ef0e",
    source:
      "https://commons.wikimedia.org/wiki/File%3APike_Place_Market_produce_vendor%2C_circa_1970s_(46728151995).jpg",
    author: "Seattle Municipal Archives from Seattle, WA",
    licence: "CC BY 2.0",
    axis: "cluttered saturated scene",
    notes: "landscape, mean L* 34.1, mean C* 22.8, detail 13.27",
  },
  {
    label: "natural-trees-rising-out",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/d/d0/Trees_rising_out_of_Cheow_Lan_Lake%2C_blue_sky%2C_eternal_summer_in_Surat_Thani_edited.jpg",
    ],
    ext: ".jpg",
    width: 4032,
    height: 2800,
    split: "tune",
    sha256: "31f10ec471cd35b2467469feac2c75b803e422f32e042c05ae2ac50250b54c18",
    source:
      "https://commons.wikimedia.org/wiki/File%3ATrees_rising_out_of_Cheow_Lan_Lake%2C_blue_sky%2C_eternal_summer_in_Surat_Thani_edited.jpg",
    author: "Original: Vyacheslav Argenberg Derivative work: The Cosmonaut",
    licence: "CC BY 4.0",
    axis: "outdoor daylight landscape",
    notes: "landscape, mean L* 56.4, mean C* 29, detail 14.12",
  },
  {
    label: "natural-walnut-tart-close",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/c/cc/Walnut_tart_close-up_-_Aviv_%284714494928%29.jpg",
    ],
    ext: ".jpg",
    width: 3872,
    height: 2592,
    split: "tune2",
    sha256: "68141502b2131761f963dca2c4f9ef09e43457812235f88c8a448326009f6e93",
    source:
      "https://commons.wikimedia.org/wiki/File%3AWalnut_tart_close-up_-_Aviv_(4714494928).jpg",
    author: "Alpha from Melbourne, Australia",
    licence: "CC BY-SA 2.0",
    axis: "close framing, saturated food",
    notes: "landscape, mean L* 43.8, mean C* 44.4, detail 9.07",
  },
  {
    label: "night-bas-lica-notre",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/5/5d/Bas%C3%ADlica_de_Notre-Dame%2C_Montreal%2C_Canad%C3%A1%2C_2017-08-11%2C_DD_20-22_HDR.jpg",
    ],
    ext: ".jpg",
    width: 4911,
    height: 4549,
    split: "tune",
    sha256: "accfac7a9eb21d983456dc80936c7797dd3496cd5c0b4d6e387f3605bd3210de",
    source:
      "https://commons.wikimedia.org/wiki/File%3ABas%C3%ADlica_de_Notre-Dame%2C_Montreal%2C_Canad%C3%A1%2C_2017-08-11%2C_DD_20-22_HDR.jpg",
    author: "Diego Delso",
    licence: "CC BY-SA 4.0",
    axis: "low key, saturated artificial light",
    notes: "landscape, mean L* 26.2, mean C* 27.2, detail 23.88",
  },
  {
    label: "night-long-island-city",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/d/dd/Long_Island_City_New_York_May_2015_panorama_3.jpg",
    ],
    ext: ".jpg",
    width: 8000,
    height: 4000,
    split: "tune",
    sha256: "f009409b13acdd9a1aba85fa81309fe7c29681ab284a029c9cf7552a8f92a591",
    source:
      "https://commons.wikimedia.org/wiki/File%3ALong_Island_City_New_York_May_2015_panorama_3.jpg",
    author: "King of Hearts",
    licence: "CC BY-SA 3.0",
    axis: "low key, saturated artificial light",
    notes: "landscape, mean L* 49.1, mean C* 27.9, detail 28.32",
  },
  {
    label: "night-night-sky-milky",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/1/13/Night-sky-milky-way-stars-hills_-_West_Virginia_-_ForestWander.jpg",
    ],
    ext: ".jpg",
    width: 5616,
    height: 3744,
    split: "tune",
    sha256: "a84ed4e7b6b81b0deaec580b6def472b74b031300d17712def354847900c7eef",
    source:
      "https://commons.wikimedia.org/wiki/File%3ANight-sky-milky-way-stars-hills_-_West_Virginia_-_ForestWander.jpg",
    author: "ForestWander",
    licence: "CC BY-SA 3.0 us",
    axis: "low key, saturated artificial light",
    notes: "landscape, mean L* 7.7, mean C* 1.9, detail 6.76",
  },
  {
    label: "night-nster-liudgerhaus-und",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/f/f7/M%C3%BCnster%2C_Liudgerhaus_und_Di%C3%B6zesanbibliothek_--_2014_--_0303.jpg",
    ],
    ext: ".jpg",
    width: 3601,
    height: 5401,
    split: "tune2",
    sha256: "1c4dedcc5564305a8bf0bfdfde912dc45057b60c3a80caef977c2b39eaa36674",
    source:
      "https://commons.wikimedia.org/wiki/File%3AM%C3%BCnster%2C_Liudgerhaus_und_Di%C3%B6zesanbibliothek_--_2014_--_0303.jpg",
    author: "Dietmar Rabich",
    licence: "CC BY-SA 4.0",
    axis: "low key, saturated artificial light",
    notes: "portrait, mean L* 47.9, mean C* 10.5, detail 22.71",
  },
  {
    label: "portrait-african-lady",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/f/f7/An_African_Lady.jpg",
    ],
    ext: ".jpg",
    width: 1668,
    height: 2500,
    split: "tune",
    sha256: "84d789fe7a5ef4f3713c596a5fdb562cdc11a2d0c6c903a13ccc8495f71beba9",
    source: "https://commons.wikimedia.org/wiki/File%3AAn_African_Lady.jpg",
    author: "K15photos",
    licence: "CC BY-SA 4.0",
    axis: "skin tone and portrait framing",
    notes: "portrait, mean L* 63.5, mean C* 0, detail 28.33",
  },
  {
    label: "portrait-african-woman-rusinga",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/a/ad/African_woman_rusinga.jpg",
    ],
    ext: ".jpg",
    width: 4160,
    height: 6240,
    split: "tune",
    sha256: "b42b667d11aaeeca9a2b57c34c1bd5ec502935ad9565da8c4c1ffd12101d80cb",
    source:
      "https://commons.wikimedia.org/wiki/File%3AAfrican_woman_rusinga.jpg",
    author: "Jeffmugendi",
    licence: "CC BY-SA 4.0",
    axis: "skin tone and portrait framing",
    notes: "portrait, mean L* 52.3, mean C* 16.1, detail 10.2",
  },
  {
    label: "portrait-imene6",
    urls: ["https://upload.wikimedia.org/wikipedia/commons/4/4d/Imene6.jpg"],
    ext: ".jpg",
    width: 3456,
    height: 5184,
    split: "tune",
    sha256: "1c338666388eaba2b821ff9f1e136179bc1ac50f78e13cd13ace9d78ca563fd9",
    source: "https://commons.wikimedia.org/wiki/File%3AImene6.jpg",
    author: "Samia Dib Benkaci",
    licence: "CC BY-SA 4.0",
    axis: "skin tone and portrait framing",
    notes: "portrait, mean L* 23.7, mean C* 26.6, detail 13.15",
  },
  {
    label: "portrait-mother-and-child",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/9/9a/Mother_and_Child_II_%28Imagicity_626%29.jpg",
    ],
    ext: ".jpg",
    width: 4288,
    height: 2848,
    split: "tune",
    sha256: "0edca0e3a38b7670be967cb78c33ce1ed79c5a88e88ec4282970080a9766b8e0",
    source:
      "https://commons.wikimedia.org/wiki/File%3AMother_and_Child_II_(Imagicity_626).jpg",
    author: "Graham Crumb",
    licence: "CC BY-SA 3.0",
    axis: "skin tone and portrait framing",
    notes: "landscape, mean L* 59.5, mean C* 0, detail 11.4",
  },
  {
    label: "portrait-portrait-femme-tenue",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/0/0a/Portrait_de_femme_en_tenue_traditionnelle_de_Berb%C3%A8re_Alg%C3%A9rien.jpg",
    ],
    ext: ".jpg",
    width: 3456,
    height: 5184,
    split: "tune",
    sha256: "3db3587f2612133fc4859adc0b3097fb833bbe644e2b92617ee8fa60b9166fd4",
    source:
      "https://commons.wikimedia.org/wiki/File%3APortrait_de_femme_en_tenue_traditionnelle_de_Berb%C3%A8re_Alg%C3%A9rien.jpg",
    author: "Samia Dib Benkaci",
    licence: "CC BY-SA 4.0",
    axis: "skin tone and portrait framing",
    notes: "portrait, mean L* 27.2, mean C* 0, detail 21.72",
  },
  {
    label: "portrait-sideshow-bob-love",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/7/7a/Sideshow_Bob%27s_Love_Child.%3F_%28Imagicity_774%29.jpg",
    ],
    ext: ".jpg",
    width: 4288,
    height: 2848,
    split: "tune",
    sha256: "1967684f3043484bb14543e2596c8bc94563a59094b510ca55bf2b82527597f0",
    source:
      "https://commons.wikimedia.org/wiki/File%3ASideshow_Bob's_Love_Child.%3F_(Imagicity_774).jpg",
    author: "Graham Crumb",
    licence: "CC BY-SA 3.0",
    axis: "skin tone and portrait framing",
    notes: "landscape, mean L* 50.6, mean C* 44.1, detail 17.64",
  },
  {
    label: "natural-andrew-jackson-state",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/d/db/Andrew_Jackson_State_Office_Building%2C_Deaderick_Street_and_5th_Avenue%2C_Nashville%2C_TN_%2854385251424%29.jpg",
    ],
    ext: ".jpg",
    width: 3914,
    height: 5219,
    split: "tune",
    sha256: "9756e13cbf24c588ce74fce684c8917d10e63545b057c59bcbbcba22b5fffa08",
    source:
      "https://commons.wikimedia.org/wiki/File%3AAndrew_Jackson_State_Office_Building%2C_Deaderick_Street_and_5th_Avenue%2C_Nashville%2C_TN_(54385251424).jpg",
    author: "Warren LeMay from Chicago, IL, United States",
    licence: "CC BY-SA 2.0",
    axis: "dense periodic man-made detail",
    notes: "portrait, mean L* 61.7, mean C* 12.7, detail 47.25",
  },
  {
    label: "natural-nster-westdeutsche-lotterie",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/7/77/M%C3%BCnster%2C_Westdeutsche_Lotterie_--_2014_--_3791.jpg",
    ],
    ext: ".jpg",
    width: 3648,
    height: 5472,
    split: "tune",
    sha256: "0ac1145f61da508d18f9b8b79fbb3e5c602c6618f641c88924444c9443dc3940",
    source:
      "https://commons.wikimedia.org/wiki/File%3AM%C3%BCnster%2C_Westdeutsche_Lotterie_--_2014_--_3791.jpg",
    author: "Dietmar Rabich",
    licence: "CC BY-SA 4.0",
    axis: "dense periodic man-made detail",
    notes: "portrait, mean L* 42.1, mean C* 9.2, detail 22.77",
  },
  {
    label: "natural-nster-westdeutsche-lotterie-2",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/9/91/M%C3%BCnster%2C_Westdeutsche_Lotterie%2C_Zentrale_--_2026_--_1521.jpg",
    ],
    ext: ".jpg",
    width: 7728,
    height: 4347,
    split: "tune",
    sha256: "26f7412b89e183810ab9fe77142290296d87d3d65e7b7464340cb66a24ed3405",
    source:
      "https://commons.wikimedia.org/wiki/File%3AM%C3%BCnster%2C_Westdeutsche_Lotterie%2C_Zentrale_--_2026_--_1521.jpg",
    author: "Dietmar Rabich",
    licence: "CC BY-SA 4.0",
    axis: "dense periodic man-made detail",
    notes: "landscape, mean L* 50.6, mean C* 7, detail 17.48",
  },
  {
    label: "natural-roof-tiles-packed",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/b/b2/Roof_tiles_packed_in_crate_1.jpg",
    ],
    ext: ".jpg",
    width: 4000,
    height: 3000,
    split: "tune",
    sha256: "7832fed7d5f12a8aec3d36393d9f646b11d601a445d858eb214b916cb04d2688",
    source:
      "https://commons.wikimedia.org/wiki/File%3ARoof_tiles_packed_in_crate_1.jpg",
    author: "W.carter",
    licence: "CC BY-SA 4.0",
    axis: "dense periodic man-made detail",
    notes: "landscape, mean L* 46, mean C* 46, detail 25.17",
  },
];

/** Where a curated image is cached. */
export function naturalImagePath(spec: NaturalImageSpec): string {
  return path.join(NATURAL_DIR, `${spec.label}${spec.ext}`);
}

/**
 * The curated pins `ensureNaturalImages` fetches: every one that is not in
 * the sealed holdout2 split, or only the labels in `only`. A label that is
 * unknown, or that names a holdout2 pin, throws before anything is fetched.
 * `images` is the table to select from, so the self-test can drive it with
 * fixtures.
 */
export function naturalImagesToFetch(
  only?: readonly string[],
  images: readonly NaturalImageSpec[] = CURATED_IMAGES,
): NaturalImageSpec[] {
  const wanted = only ? new Set(only) : null;
  if (wanted) {
    const byLabel = new Map(images.map((s) => [s.label, s]));
    for (const label of wanted) {
      const spec = byLabel.get(label);
      if (spec === undefined) {
        throw new Error(`unknown curated image label: ${label}`);
      }
      if (spec.split === "holdout2") {
        throw new Error(
          `${label} is in the sealed holdout2 split; only ensureHoldout2Images fetches it, through the register gate`,
        );
      }
    }
  }
  return images.filter(
    (spec) =>
      spec.split !== "holdout2" && (wanted === null || wanted.has(spec.label)),
  );
}

/**
 * Ensure every curated image is present and content-verified, whether from
 * cache or from the network. A fetch failure or a digest mismatch throws: a
 * partial or drifted corpus would silently move every reported mean, so the
 * run stops rather than producing a number nobody can reproduce.
 *
 * The sealed holdout2 images are never fetched here: only
 * `ensureHoldout2Images` fetches them, and only once the register gate has
 * opened the split (`holdout-images.ts`). Asking for one by label throws.
 *
 * @param only Restrict to these labels — for the CI R-D gate, which scores a
 *   handful of images and should not pull the whole corpus it will not look at.
 */
export async function ensureNaturalImages(
  only?: readonly string[],
): Promise<string[]> {
  const specs = naturalImagesToFetch(only);
  await fs.mkdir(NATURAL_DIR, { recursive: true });

  const paths: string[] = [];
  let downloadCount = 0;

  for (const spec of specs) {
    const filePath = naturalImagePath(spec);
    const downloaded = await ensurePinnedFixture({
      filePath,
      urls: spec.urls,
      sha256: spec.sha256,
      label: spec.label,
    });
    if (downloaded) downloadCount++;
    paths.push(filePath);
  }

  if (downloadCount > 0) {
    console.log(
      `Downloaded ${downloadCount} natural image(s) to ${NATURAL_DIR}`,
    );
  }

  return paths;
}
