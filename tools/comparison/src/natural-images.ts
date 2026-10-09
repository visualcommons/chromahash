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
  /**
   * Orientation, mean L\*, mean C\* and detail energy of the upright picture,
   * measured on the 512 px scoring reference by `corpus-covariates.ts --files`
   * (#102), whose `covariatesOf` defines each figure. `stratify` parses them
   * back out of this string.
   */
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
 * each axis rather than cluster at its centre. The formula behind those
 * selection-time figures was never recorded and could not be reproduced, so
 * every `notes` figure below is a re-measurement by `corpus-covariates.ts`
 * (#102); the selection itself stands as made. Three of the six portraits
 * chosen for skin tone turned out to be monochrome (mean C\* 0): they cover
 * portrait framing but no skin chroma, and their `axis` says so. Candidates
 * were restricted to
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
    notes: "landscape, mean L* 40, mean C* 6.9, detail 2.94",
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
    notes: "landscape, mean L* 72.4, mean C* 6.8, detail 8.49",
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
    notes: "portrait, mean L* 46.2, mean C* 0, detail 8.82",
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
    notes: "landscape, mean L* 27.4, mean C* 1.2, detail 14.16",
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
    notes: "landscape, mean L* 66.4, mean C* 13.5, detail 12.11",
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
    notes: "landscape, mean L* 59.6, mean C* 3.3, detail 22.11",
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
    notes: "landscape, mean L* 43.3, mean C* 8.6, detail 5.92",
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
    notes: "landscape, mean L* 12.6, mean C* 11.4, detail 4.93",
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
    notes: "landscape, mean L* 50.6, mean C* 9.7, detail 9.14",
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
    notes: "landscape, mean L* 79.7, mean C* 8.2, detail 4.72",
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
    notes: "landscape, mean L* 46.8, mean C* 18.3, detail 5.69",
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
    notes: "landscape, mean L* 25.2, mean C* 7.6, detail 2.47",
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
    notes: "portrait, mean L* 51.9, mean C* 19.3, detail 5.11",
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
    notes: "landscape, mean L* 39.2, mean C* 22, detail 4.04",
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
    notes: "landscape, mean L* 21.7, mean C* 12.8, detail 5.31",
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
    notes: "portrait, mean L* 62.2, mean C* 9.6, detail 5.01",
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
    notes: "portrait, mean L* 53, mean C* 13.9, detail 2.66",
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
    notes: "landscape, mean L* 64.7, mean C* 8.2, detail 1.99",
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
    notes: "landscape, mean L* 53.1, mean C* 0, detail 21.83",
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
    notes: "landscape, mean L* 46.5, mean C* 11.7, detail 10.58",
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
    notes: "portrait, mean L* 47.8, mean C* 13.5, detail 11.13",
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
    notes: "landscape, mean L* 44.6, mean C* 15.3, detail 10.92",
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
    notes: "landscape, mean L* 34.2, mean C* 22.9, detail 4.41",
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
    notes: "landscape, mean L* 56.4, mean C* 29, detail 3.99",
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
    notes: "landscape, mean L* 43.8, mean C* 44.5, detail 2.82",
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
    notes: "landscape, mean L* 26.2, mean C* 27.4, detail 7.23",
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
    notes: "landscape, mean L* 49.2, mean C* 28, detail 8.99",
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
    notes: "landscape, mean L* 7.8, mean C* 1.9, detail 2.11",
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
    notes: "portrait, mean L* 48, mean C* 10.4, detail 7.63",
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
    axis: "portrait framing; monochrome, so no skin chroma",
    notes: "portrait, mean L* 63.4, mean C* 0, detail 10.54",
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
    notes: "portrait, mean L* 52.4, mean C* 16, detail 3.74",
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
    notes: "portrait, mean L* 23.7, mean C* 26.8, detail 4.58",
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
    axis: "portrait framing; monochrome, so no skin chroma",
    notes: "landscape, mean L* 59.5, mean C* 0, detail 3.56",
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
    axis: "portrait framing; monochrome, so no skin chroma",
    notes: "portrait, mean L* 27.2, mean C* 0, detail 7.44",
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
    notes: "landscape, mean L* 50.6, mean C* 44.3, detail 5.33",
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
    notes: "portrait, mean L* 61.7, mean C* 12.8, detail 15.12",
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
    notes: "portrait, mean L* 42.2, mean C* 9.1, detail 7.87",
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
    notes: "landscape, mean L* 50.6, mean C* 6.9, detail 5.64",
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
    notes: "landscape, mean L* 46, mean C* 46.1, detail 8.11",
  },
  // ─── holdout2: the sealed photographic split (#76, pinned by #103) ────────
  // Drawn on covariates alone, by the protocol #103 records, with no encoder
  // run on any candidate. ensureNaturalImages never fetches these; only
  // ensureHoldout2Images does, behind the register gate (holdout-images.ts).
  // Unfetched outside that gate, they are in no tune mean (splitFor seals them).
  {
    label: "sealed-phone-aamsveenherfst",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/0/07/AamsveenHerfst.jpg",
    ],
    ext: ".jpg",
    width: 2592,
    height: 1936,
    split: "holdout2",
    sha256: "4e8e52de69d1b3f152a37cd898a0a5fbaaaed8c062f6313ed288700946e11929",
    source: "https://commons.wikimedia.org/wiki/File%3AAamsveenHerfst.jpg",
    author: "Pdreijnders",
    licence: "CC BY-SA 3.0",
    axis: "smartphone source",
    notes: "landscape, Apple iPhone 4, mean L* 58.2, mean C* 31.5, detail 7.32",
  },
  {
    label: "sealed-phone-april-at-keukenhof",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/f/f5/15_April_at_Keukenhof%2C_Lisse_%282022%29_421.jpg",
    ],
    ext: ".jpg",
    width: 4032,
    height: 2268,
    split: "holdout2",
    sha256: "791619f8494841d449dffbca92439d9ee8d731f1c8eea9120f43d63934a8ca8a",
    source:
      "https://commons.wikimedia.org/wiki/File%3A15_April_at_Keukenhof,_Lisse_(2022)_421.jpg",
    author: "Donald Trung Quoc Don (Chữ Hán: 徵國單) - Wikimedia Commons - ©",
    licence: "CC BY-SA 4.0",
    axis: "smartphone source",
    notes:
      "landscape, Google Pixel 4a, mean L* 49.4, mean C* 46.5, detail 16.81",
  },
  {
    label: "sealed-phone-citrus-swallowtail-papilio",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/f/f5/Citrus_Swallowtail_Papilio_Demodocus_Butterfly.jpg",
    ],
    ext: ".jpg",
    width: 3264,
    height: 2448,
    split: "holdout2",
    sha256: "1908b2725b2fd7f08b41dbacd6c1316a4a0bf8d8f1d63b779f20f5560891025d",
    source:
      "https://commons.wikimedia.org/wiki/File%3ACitrus_Swallowtail_Papilio_Demodocus_Butterfly.jpg",
    author: "Danesman1",
    licence: "CC BY-SA 3.0",
    axis: "smartphone source",
    notes:
      "landscape, SAMSUNG GT-I9300, mean L* 41.3, mean C* 19.7, detail 8.24",
  },
  {
    label: "sealed-phone-ger-by-munchen",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/0/01/GER_%E2%80%94_BY_%E2%80%94_M%C3%BCnchen_%E2%80%94_Stadtbezirk_1_%E2%80%94_Altstadt_%E2%80%94_Viktualienmarkt_8_%28F._S._Kustermann_GmbH_%E2%80%94_Warenpr%C3%A4sentation_Sieger_by_F%C3%BCrstenberg%29_2017_Mattes.jpg",
    ],
    ext: ".jpg",
    width: 3264,
    height: 1836,
    split: "holdout2",
    sha256: "b9c9b76da9662b7b005b7c51bd3f80e1856adda14eca08c4e43757d088c7df38",
    source:
      "https://commons.wikimedia.org/wiki/File%3AGER_%E2%80%94_BY_%E2%80%94_M%C3%BCnchen_%E2%80%94_Stadtbezirk_1_%E2%80%94_Altstadt_%E2%80%94_Viktualienmarkt_8_(F._S._Kustermann_GmbH_%E2%80%94_Warenpr%C3%A4sentation_Sieger_by_F%C3%BCrstenberg)_2017_Mattes.jpg",
    author: "User:Mattes",
    licence: "CC BY 3.0",
    axis: "smartphone source",
    notes:
      "landscape, samsung SM-G920F, mean L* 51.0, mean C* 19.3, detail 8.04",
  },
  {
    label: "sealed-phone-love-stadium-livebeyond",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/3/3e/%3DLOVE_STADIUM_LIVE%E3%80%8CBeyond_%22KYUN%22%E2%99%A1%E3%80%8DMUFG%E3%82%B9%E3%82%BF%E3%82%B8%E3%82%A2%E3%83%A0_2026%E5%B9%B46%E6%9C%8821%E6%97%A5%E3%81%AE%E6%9D%B1%E4%BA%AC_202606211727_IMG_2649.jpg",
    ],
    ext: ".jpg",
    width: 4032,
    height: 3024,
    split: "holdout2",
    sha256: "2adee09617e005c0b984af905c93b35cd55ddef3dc04879c93c44cb955784d48",
    source:
      "https://commons.wikimedia.org/wiki/File%3A%3DLOVE_STADIUM_LIVE%E3%80%8CBeyond_%22KYUN%22%E2%99%A1%E3%80%8DMUFG%E3%82%B9%E3%82%BF%E3%82%B8%E3%82%A2%E3%83%A0_2026%E5%B9%B46%E6%9C%8821%E6%97%A5%E3%81%AE%E6%9D%B1%E4%BA%AC_202606211727_IMG_2649.jpg",
    author: "ウィ貴公子",
    licence: "CC BY-SA 4.0",
    axis: "smartphone source",
    notes:
      "landscape, Apple iPhone 12 Pro, mean L* 52.1, mean C* 8.0, detail 14.26",
  },
  {
    label: "sealed-phone-morag-zamek",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/3/39/Mor%C4%85g_Zamek_16.jpg",
    ],
    ext: ".jpg",
    width: 4000,
    height: 3000,
    split: "holdout2",
    sha256: "12e0f6736952e8449df636a69ffc520f419a91e87e3b50dc0f1b5711f4e63daa",
    source: "https://commons.wikimedia.org/wiki/File%3AMor%C4%85g_Zamek_16.jpg",
    author: "Zala",
    licence: "CC BY-SA 4.0",
    axis: "smartphone source",
    notes:
      "landscape, samsung SM-G998B, mean L* 51.7, mean C* 18.9, detail 15.85",
  },
  {
    label: "sealed-phone-sienkiewicza-street-in",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/4/48/5_Sienkiewicza_Street_in_Prudnik%2C_2020.08.25_05.jpg",
    ],
    ext: ".jpg",
    width: 3264,
    height: 2448,
    split: "holdout2",
    sha256: "968abc0ecbfa23d6bc08264b0b0fc351b2baee63c9da5905930c3c6f459eb19c",
    source:
      "https://commons.wikimedia.org/wiki/File%3A5_Sienkiewicza_Street_in_Prudnik,_2020.08.25_05.jpg",
    author: "Wlodek k1",
    licence: "CC BY 3.0",
    axis: "smartphone source",
    notes:
      "landscape, Xiaomi Redmi Note 8 Pro, mean L* 44.1, mean C* 20.4, detail 18.90",
  },
  {
    label: "sealed-phone-silesian-insurgents-monument",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/2/26/20230920_Silesian_Insurgents_Monument_Stara_Ligota_Katowice_08.jpg",
    ],
    ext: ".jpg",
    width: 3000,
    height: 4000,
    split: "holdout2",
    sha256: "b0781018a85c340f420b7f4f5d15dbe81a83f29b47bff82dbdda473ccb182775",
    source:
      "https://commons.wikimedia.org/wiki/File%3A20230920_Silesian_Insurgents_Monument_Stara_Ligota_Katowice_08.jpg",
    author: "Abraham",
    licence: "CC BY-SA 4.0",
    axis: "smartphone source",
    notes: "portrait, HUAWEI MAR-LX1A, mean L* 53.3, mean C* 8.4, detail 9.35",
  },
  {
    label: "sealed-phone-zhytomyr-park-plants",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/e/e0/%D0%A8%D0%B0%D0%B4%D1%83%D0%B0%D1%80%D1%96%D0%B2%D1%81%D1%8C%D0%BA%D0%B8%D0%B9_%D0%BF%D0%B0%D1%80_%D0%96%D0%B8%D1%82%D0%BE%D0%BC%D0%B8%D1%80_%D1%80%D0%BE%D1%81%D0%BB%D0%B8%D0%BD%D0%B8_08.jpg",
    ],
    ext: ".jpg",
    width: 3024,
    height: 4032,
    split: "holdout2",
    sha256: "3eee06313200bdf3ed22ab010b7f1a50497146183d11c4f8f8654866808b0668",
    source:
      "https://commons.wikimedia.org/wiki/File%3A%D0%A8%D0%B0%D0%B4%D1%83%D0%B0%D1%80%D1%96%D0%B2%D1%81%D1%8C%D0%BA%D0%B8%D0%B9_%D0%BF%D0%B0%D1%80_%D0%96%D0%B8%D1%82%D0%BE%D0%BC%D0%B8%D1%80_%D1%80%D0%BE%D1%81%D0%BB%D0%B8%D0%BD%D0%B8_08.jpg",
    author: "Letherian3",
    licence: "CC BY-SA 4.0",
    axis: "smartphone source",
    notes:
      "portrait, Apple iPhone 15 Pro Max, mean L* 54.5, mean C* 17.5, detail 5.08",
  },
  {
    label: "sealed-night-christmas-lights-in",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/e/e3/Christmas_lights_in_Carnaby_Street%2C_London%2C_2022.jpg",
    ],
    ext: ".jpg",
    width: 4032,
    height: 3024,
    split: "holdout2",
    sha256: "bc4bdef5872d01f83b203920e2cb22fe50e314c84e087f368bc3a15aa8746f63",
    source:
      "https://commons.wikimedia.org/wiki/File%3AChristmas_lights_in_Carnaby_Street,_London,_2022.jpg",
    author: "The wub",
    licence: "CC BY-SA 4.0",
    axis: "night, saturated artificial light",
    notes:
      "landscape, Google Pixel 4a, mean L* 17.3, mean C* 23.7, detail 10.25",
  },
  {
    label: "sealed-night-neon-signs-at",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/8/8e/Neon_signs_at_night%2C_24th_October_2014.JPG",
    ],
    ext: ".jpg",
    width: 2512,
    height: 1824,
    split: "holdout2",
    sha256: "4fc89384c4929b875d11831c920dd51d0f7333a6545b2389d9364570d9b9ee30",
    source:
      "https://commons.wikimedia.org/wiki/File%3ANeon_signs_at_night,_24th_October_2014.JPG",
    author: "Tokumeigakarinoaoshima",
    licence: "CC0",
    axis: "night, saturated artificial light",
    notes:
      "landscape, Apple iPad Air, mean L* 23.7, mean C* 23.6, detail 10.92",
  },
  {
    label: "sealed-night-save-on-meats",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/7/78/Save-On_Meats_-_Some_Pig_-_Night_Neon_on_Hastings%2C_Vancouver.jpg",
    ],
    ext: ".jpg",
    width: 2560,
    height: 1920,
    split: "holdout2",
    sha256: "190d91b214a0d21274d36d783036d90fb06eb7a342bfc6871df72599be8d2651",
    source:
      "https://commons.wikimedia.org/wiki/File%3ASave-On_Meats_-_Some_Pig_-_Night_Neon_on_Hastings,_Vancouver.jpg",
    author: "Mike W.",
    licence: "CC BY-SA 2.0",
    axis: "night, saturated artificial light",
    notes:
      "landscape, PENTAX Corporation PENTAX Optio WP, mean L* 21.6, mean C* 36.4, detail 3.96",
  },
  {
    label: "sealed-interior-candleroom-in-serbian",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/e/e7/Candleroom_in_Serbian_orthodox_church_in_Ljubljana%2C_Slovenia.jpg",
    ],
    ext: ".jpg",
    width: 4232,
    height: 3136,
    split: "holdout2",
    sha256: "5d22c89506e5a65427b8f659b2d34604b00b12deb1bd0b29e7c9d64824141350",
    source:
      "https://commons.wikimedia.org/wiki/File%3ACandleroom_in_Serbian_orthodox_church_in_Ljubljana,_Slovenia.jpg",
    author: "Petar Milošević",
    licence: "CC BY-SA 4.0",
    axis: "warm artificial interior light",
    notes:
      "landscape, Panasonic DMC-G80, mean L* 18.3, mean C* 21.5, detail 3.45",
  },
  {
    label: "sealed-interior-grits-bar-interior",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/8/82/Grits_Bar_Interior_New_Orleans_Jim_Beam.jpg",
    ],
    ext: ".jpg",
    width: 4000,
    height: 3000,
    split: "holdout2",
    sha256: "6b00a324c5002209308870871c3015e323db24ebd455ed5463e80ea4bf0cda11",
    source:
      "https://commons.wikimedia.org/wiki/File%3AGrits_Bar_Interior_New_Orleans_Jim_Beam.jpg",
    author: "Infrogmation of New Orleans",
    licence: "CC BY-SA 2.0",
    axis: "warm artificial interior light",
    notes:
      "landscape, Canon Canon PowerShot SD1300 IS, mean L* 13.7, mean C* 13.7, detail 3.44",
  },
  {
    label: "sealed-interior-interior-of-restaurant",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/4/4a/Interior_of_restaurant_Santa_Clara_on_an_evening_in_October_2024.jpg",
    ],
    ext: ".jpg",
    width: 4608,
    height: 3456,
    split: "holdout2",
    sha256: "8ce4586a83431f2479809c9c245672bfdcce0868c13c2915c82ad9284e6de1f1",
    source:
      "https://commons.wikimedia.org/wiki/File%3AInterior_of_restaurant_Santa_Clara_on_an_evening_in_October_2024.jpg",
    author: "JIP",
    licence: "CC BY-SA 4.0",
    axis: "warm artificial interior light",
    notes:
      "landscape, OLYMPUS IMAGING CORP. E-M1, mean L* 36.1, mean C* 16.7, detail 5.01",
  },
  {
    label: "sealed-interior-the-mind-palace",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/1/11/The_Mind_Palace_Bar_Interior.jpg",
    ],
    ext: ".jpg",
    width: 7443,
    height: 5504,
    split: "holdout2",
    sha256: "692f60eb76d3dd2087c986aae9458ed984349f1464aa882846820321ca6cbab7",
    source:
      "https://commons.wikimedia.org/wiki/File%3AThe_Mind_Palace_Bar_Interior.jpg",
    author: "Sherlock: Escape Rooms",
    licence: "CC0",
    axis: "warm artificial interior light",
    notes:
      "landscape, NIKON CORPORATION NIKON D850, mean L* 29.1, mean C* 19.6, detail 13.89",
  },
  {
    label: "sealed-chroma-canal-du-midi",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/b/bb/Canal_du_Midi%2C_Villeneuve-l%C3%A8s-B%C3%A9ziers_BW.jpg",
    ],
    ext: ".jpg",
    width: 7360,
    height: 4145,
    split: "holdout2",
    sha256: "06d6446cdb520e2912cce5a9de3157266b52a5e4c1b384e5491899076bc0b444",
    source:
      "https://commons.wikimedia.org/wiki/File%3ACanal_du_Midi,_Villeneuve-l%C3%A8s-B%C3%A9ziers_BW.jpg",
    author: "Christian Ferrer",
    licence: "CC BY 4.0",
    axis: "the chroma floor: monochrome",
    notes:
      "landscape, NIKON CORPORATION NIKON D810, mean L* 42.9, mean C* 0.0, detail 24.11",
  },
  {
    label: "sealed-chroma-denis-mukwege-par",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/e/e1/Denis_Mukwege_par_Claude_Truong-Ngoc_novembre_2014.jpg",
    ],
    ext: ".jpg",
    width: 3840,
    height: 5760,
    split: "holdout2",
    sha256: "24595ae50606b79c8a9cdc484400af70663a757de3d69c4b655ba5cde322d6e6",
    source:
      "https://commons.wikimedia.org/wiki/File%3ADenis_Mukwege_par_Claude_Truong-Ngoc_novembre_2014.jpg",
    author: "Photo Claude TRUONG-NGOC",
    licence: "CC BY-SA 3.0",
    axis: "the chroma floor: monochrome",
    notes:
      "portrait, Canon Canon EOS 5D Mark III, mean L* 23.8, mean C* 0.0, detail 4.33",
  },
  {
    label: "sealed-chroma-valle-de-pineta",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/8/82/Valle_de_Pineta_02.jpg",
    ],
    ext: ".jpg",
    width: 4592,
    height: 3448,
    split: "holdout2",
    sha256: "24a9788723f48a26bb779f6370c8983233b5251949bd7942e5ff53ed92a9b962",
    source: "https://commons.wikimedia.org/wiki/File%3AValle_de_Pineta_02.jpg",
    author: "Basotxerri",
    licence: "CC BY-SA 4.0",
    axis: "the chroma floor: monochrome",
    notes:
      "landscape, Panasonic DMC-GM1, mean L* 27.1, mean C* 0.0, detail 8.58",
  },
  {
    label: "sealed-chroma-wandeltocht-rond-lago",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/6/64/Wandeltocht_rond_Lago_di_Pian_Pal%C3%B9_%281800_m%29._in_het_Nationaal_park_Stelvio_%28Itali%C3%AB%29._Kolkend_water_op_weg_naar_Lago_di_Pian_Pal%C3%B9.jpg",
    ],
    ext: ".jpg",
    width: 5184,
    height: 3456,
    split: "holdout2",
    sha256: "a582bf1e116a74afca01bee6473e30604a89c4c2e7804669ad2b2ffbbeda7907",
    source:
      "https://commons.wikimedia.org/wiki/File%3AWandeltocht_rond_Lago_di_Pian_Pal%C3%B9_(1800_m)._in_het_Nationaal_park_Stelvio_(Itali%C3%AB)._Kolkend_water_op_weg_naar_Lago_di_Pian_Pal%C3%B9.jpg",
    author: "Dominicus Johannes Bergsma",
    licence: "CC BY-SA 4.0",
    axis: "the chroma floor: monochrome",
    notes:
      "landscape, Canon Canon EOS M, mean L* 46.3, mean C* 0.0, detail 9.82",
  },
  {
    label: "sealed-highkey-arctic-camping-in",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/2/24/Arctic_camping_in_the_snow_%2852828251185%29.jpg",
    ],
    ext: ".jpg",
    width: 8025,
    height: 5353,
    split: "holdout2",
    sha256: "a174306f42725b2badc8dc64b89c2afc6422692d291c75bb79274e86d8a88a3d",
    source:
      "https://commons.wikimedia.org/wiki/File%3AArctic_camping_in_the_snow_(52828251185).jpg",
    author: "USFWSAlaska",
    licence: "Public domain",
    axis: "high key",
    notes:
      "landscape, Canon Canon EOS R5, mean L* 83.4, mean C* 8.7, detail 7.12",
  },
  {
    label: "sealed-highkey-fanal-madeira-portugal",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/c/c2/Fanal_%28Madeira%2C_Portugal%29%2C_Lorbeerwald_--_2025_--_1540_%28high_key%29.jpg",
    ],
    ext: ".jpg",
    width: 6434,
    height: 3619,
    split: "holdout2",
    sha256: "921b0a796e1dc281fd27a3439049d59ae4de9bd03c1c2d13803b0d9a6cf56489",
    source:
      "https://commons.wikimedia.org/wiki/File%3AFanal_(Madeira,_Portugal),_Lorbeerwald_--_2025_--_1540_(high_key).jpg",
    author: "Dietmar Rabich",
    licence: "CC BY-SA 4.0",
    axis: "high key",
    notes:
      "landscape, Canon Canon EOS 5D Mark IV, mean L* 83.1, mean C* 6.8, detail 3.76",
  },
  {
    label: "sealed-highkey-forks-isolated-on",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/4/4c/Forks_isolated_on_white_background_02.jpg",
    ],
    ext: ".jpg",
    width: 5568,
    height: 3712,
    split: "holdout2",
    sha256: "1e2c69c8fa8682693eca1c80d77cf67d3b163b52c7d07c304a76b413dd3438e6",
    source:
      "https://commons.wikimedia.org/wiki/File%3AForks_isolated_on_white_background_02.jpg",
    author: "Jonatan Svensson Glad",
    licence: "CC BY-SA 4.0",
    axis: "high key",
    notes:
      "landscape, NIKON CORPORATION NIKON D500, mean L* 95.5, mean C* 0.7, detail 0.65",
  },
  {
    label: "sealed-highkey-the-shops-at",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/6/6c/The_Shops_at_Midtown_Miami%2C_Miami%2C_United_States_%28Unsplash%29.jpg",
    ],
    ext: ".jpg",
    width: 5184,
    height: 3456,
    split: "holdout2",
    sha256: "ea17201e0835dfd2d509e12ab6bef972958a796fc6e3b7ea3cef3253a4e24729",
    source:
      "https://commons.wikimedia.org/wiki/File%3AThe_Shops_at_Midtown_Miami,_Miami,_United_States_(Unsplash).jpg",
    author: "William Stitt willpower",
    licence: "CC0",
    axis: "high key",
    notes:
      "landscape, Canon Canon EOS REBEL T5i, mean L* 81.3, mean C* 4.4, detail 5.86",
  },
  {
    label: "sealed-portrait-ernest-nuamah-england",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/2/24/Ernest_Nuamah_England_v_Ghana_23_June_2026-113.jpg",
    ],
    ext: ".jpg",
    width: 3333,
    height: 5000,
    split: "holdout2",
    sha256: "bb4e67ad1975853e6ba562dc14471033172a7f23eb030e547e26f52efed20dae",
    source:
      "https://commons.wikimedia.org/wiki/File%3AErnest_Nuamah_England_v_Ghana_23_June_2026-113.jpg",
    author: "Bryan Berlin",
    licence: "CC BY-SA 4.0",
    axis: "skin tone: dark",
    notes: "portrait, SONY ILCE-7M4, mean L* 60.6, mean C* 48.8, detail 3.88",
  },
  {
    label: "sealed-portrait-macharia-kamau-meets",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/8/83/Macharia_Kamau_meets_with_communities_in_Papua_New_Guinea.jpg",
    ],
    ext: ".jpg",
    width: 4000,
    height: 3000,
    split: "holdout2",
    sha256: "9fa6f93241bde67fc1f31e507d1ae20b8d638758c2040477fcb24245f793457e",
    source:
      "https://commons.wikimedia.org/wiki/File%3AMacharia_Kamau_meets_with_communities_in_Papua_New_Guinea.jpg",
    author: "Aliceclements",
    licence: "CC BY-SA 4.0",
    axis: "skin tone: dark",
    notes:
      "landscape, Canon Canon PowerShot G16, mean L* 51.6, mean C* 10.2, detail 3.88",
  },
  {
    label: "sealed-portrait-portrait-of-an",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/6/68/Portrait_of_an_old_indian_woman_%2825507743530%29.jpg",
    ],
    ext: ".jpg",
    width: 3456,
    height: 5184,
    split: "holdout2",
    sha256: "4363c1be540061919c8af06e6322517e5d673c92dde17bad7e099e092cf9e62f",
    source:
      "https://commons.wikimedia.org/wiki/File%3APortrait_of_an_old_indian_woman_(25507743530).jpg",
    author: "Nithi Anand from Paris, France",
    licence: "CC BY 2.0",
    axis: "skin tone: medium",
    notes:
      "portrait, Canon Canon EOS 100D, mean L* 62.9, mean C* 35.2, detail 8.63",
  },
  {
    label: "sealed-portrait-woman-with-shawl",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/7/70/Woman_with_Shawl_-_McLeod_Ganj_-_Himachal_Pradesh_-_India_%2826810940675%29.jpg",
    ],
    ext: ".jpg",
    width: 2736,
    height: 3648,
    split: "holdout2",
    sha256: "6571815c71a5c865f0b6a94da6f282e13384d907eeed05060ba6c28521ceef6e",
    source:
      "https://commons.wikimedia.org/wiki/File%3AWoman_with_Shawl_-_McLeod_Ganj_-_Himachal_Pradesh_-_India_(26810940675).jpg",
    author: "Adam Jones from Kelowna, BC, Canada",
    licence: "CC BY-SA 2.0",
    axis: "skin tone: medium",
    notes:
      "portrait, SONY DSC-HX400V, mean L* 48.0, mean C* 17.3, detail 10.30",
  },
  {
    label: "sealed-portrait-jose-manuel-lucia",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/a/a0/Jos%C3%A9_Manuel_Luc%C3%ADa_Meg%C3%ADas.JPG",
    ],
    ext: ".jpg",
    width: 3264,
    height: 2448,
    split: "holdout2",
    sha256: "1fe7eefe6689131c31fa5820291effdd49bb424777f53b7007ab455d1ab1838d",
    source:
      "https://commons.wikimedia.org/wiki/File%3AJos%C3%A9_Manuel_Luc%C3%ADa_Meg%C3%ADas.JPG",
    author: "Jmlucia",
    licence: "CC BY-SA 3.0",
    axis: "skin tone: light",
    notes:
      "landscape, KONICA MINOLTA DiMAGE A200, mean L* 64.9, mean C* 13.3, detail 4.46",
  },
  {
    label: "sealed-portrait-romina",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/e/e4/Romina_%2835553361002%29.jpg",
    ],
    ext: ".jpg",
    width: 3254,
    height: 4881,
    split: "holdout2",
    sha256: "54ba009d46a0320861bccbece6be64f58c218125c09503f40a97c001e2d05908",
    source:
      "https://commons.wikimedia.org/wiki/File%3ARomina_(35553361002).jpg",
    author: "Rodrigo Paredes from Ciudad Autónoma de Buenos Aires, Argent",
    licence: "CC BY 2.0",
    axis: "skin tone: light",
    notes:
      "portrait, Canon Canon EOS 6D, mean L* 66.8, mean C* 16.0, detail 1.71",
  },
  {
    label: "sealed-natural-red-route-trail",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/2/23/Red_Route_trail%2C_Bedgebury_Forest_-_geograph.org.uk_-_5089200.jpg",
    ],
    ext: ".jpg",
    width: 3000,
    height: 4000,
    split: "holdout2",
    sha256: "7fac045346387e5833db490d04aa04566b7619dc6c8c513f9168bc18cba7302f",
    source:
      "https://commons.wikimedia.org/wiki/File%3ARed_Route_trail,_Bedgebury_Forest_-_geograph.org.uk_-_5089200.jpg",
    author: "Oast House Archive",
    licence: "CC BY-SA 2.0",
    axis: "daylight outdoor",
    notes:
      "portrait, Canon Canon PowerShot S120, mean L* 43.4, mean C* 19.5, detail 8.47",
  },
  {
    label: "sealed-natural-santa-pola",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/0/0e/Santa_Pola_14.jpg",
    ],
    ext: ".jpg",
    width: 4000,
    height: 3000,
    split: "holdout2",
    sha256: "3d2a531f3928f504d17c3ba1333ba503c66cfb1a56302b8803632eabcdf9a15d",
    source: "https://commons.wikimedia.org/wiki/File%3ASanta_Pola_14.jpg",
    author: "TijsB from Utrecht, The Netherlands",
    licence: "CC BY-SA 2.0",
    axis: "daylight outdoor",
    notes:
      "landscape, Canon Canon PowerShot SX280 HS, mean L* 50.2, mean C* 16.3, detail 8.25",
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
