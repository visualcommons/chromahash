import fs from "node:fs/promises";
import path from "node:path";
import { ensurePinnedFixture } from "./corpus-pin.ts";
import {
  ALPHA_HOLDOUT2_PREFIX,
  ALPHA_HOLDOUT3_PREFIX,
  type CorpusSplit,
  HOLDOUT2_PREFIX,
  type Holdout3Record,
} from "./corpus.ts";
import {
  type Holdout2Opening,
  type Holdout3Opening,
  checkHoldout3Pins,
} from "./holdout-images.ts";

const ALPHA_DIR = path.resolve(import.meta.dirname, "../fixtures/alpha");

/**
 * One image in the alpha corpus: real content with meaningful transparency.
 *
 * The format has an alpha mode whose tier-0 layout has never been measured,
 * because the photographic corpus contains no transparency at all. The six
 * generated `alpha-*` synthetic fixtures are 8x8 correctness cases for the
 * alpha *path* and are deliberately not part of this set — nothing should be
 * tuned against a checkerboard.
 */
export interface AlphaImageSpec {
  /** Filename stem. The `cutout-` prefix is what puts it in the alpha corpus. */
  label: string;
  /** Permanent upstream URL (content-addressed; not a thumbnail or redirect). */
  url: string;
  /** File extension including the dot. */
  ext: string;
  width: number;
  height: number;
  /**
   * Split. Constants are chosen on "tune". "tune2" is the retired holdout's
   * seven surviving images, which are tuning data now (#93); "holdout" is left
   * only on the withdrawn pin; "holdout2" is the sealed split, labelled
   * `sealed-cutout-*` ({@link alphaHoldout2Specs}).
   */
  split: CorpusSplit;
  /** Fraction of pixels with alpha < 255, measured on the pinned bytes. */
  nonOpaqueFraction: number;
  /** Fraction with 0 < alpha < 255 — the anti-aliased/soft edges. */
  softAlphaFraction: number;
  /** SHA-256 of the exact bytes (see corpus-pin.ts). */
  sha256: string;
  /** Commons file page, for attribution. */
  source: string;
  /** Author, as Commons records them. */
  author: string;
  /**
   * Licence short name, as Commons records it. For a withdrawn entry, the
   * licence the upload claimed: the attribution file renders it as a claim
   * that no longer holds, never as the image's licence.
   */
  licence: string;
  /** What this image is here to cover. */
  notes: string;
  /**
   * Set when the upstream source no longer exists: when and why it went. A
   * withdrawn image is never fetched. Its entry stays so the pin still says
   * what the results that scored it measured. It also keeps the image's
   * declared split: a cached copy with no entry would fall through `splitFor`
   * to "tune" and join every alpha tune sweep.
   */
  withdrawn?: string;
  /**
   * A holdout3 pin's draw record and strata (#129); present on every
   * `sealed3-cutout-*` pin and on no other ({@link alphaHoldout3Specs}).
   */
  holdout3?: Holdout3Record;
}

/**
 * Why the alpha holdout split is closed. `ensureAlphaImages("holdout")` throws
 * this rather than fetching a split that no longer exists as pinned.
 *
 * The split was eight images. One is gone, so scoring the other seven would be
 * a different experiment reported under the old one's name. It has also been
 * spent: §11.12 read it to adopt the alpha row, and to adopt the compact alpha
 * row, and to reject `alpha_ac_fit`. The seven survivors are `tune2` now
 * (#93), tuning data kept apart from tune, as the photographic holdout's are
 * (#76). The replacement is the sealed `holdout2` split, curated on covariates
 * and read only through the register gate.
 */
export const ALPHA_HOLDOUT_RETIRED =
  "the alpha holdout split is retired (#83): cutout-wordmark-aflac, one of its eight images, " +
  "was deleted from Wikimedia Commons on 2026-08-25 as a copyright violation and has no archived copy, " +
  "and the split has already informed the decisions spec/EXPERIMENTS.md §11.12 records. " +
  "Its seven surviving images are the tune2 split now (#93): score them with --split tune2 (tuning data, not a verdict). " +
  "The out-of-sample alpha split is holdout2, sealed until spec/V0.8-DECISIONS.md records the decision it answers as frozen.";

/**
 * Why an alpha holdout2 fetch refuses when the table it reads holds no
 * holdout2 pin, rather than scoring an empty split. The shipped table holds
 * the fourteen approved in #107, so this is reached only from a table that
 * lost them.
 */
export const ALPHA_HOLDOUT2_UNPINNED =
  "the alpha holdout2 split has no pinned images in this table (the approved list is pinned in #107)";

/**
 * Curated alpha corpus, sourced from Wikimedia Commons under free licences.
 * Every entry carries its own attribution, and `fixtures/alpha/LICENSES.md` is
 * generated from this table (`mise run corpus:licenses`) so the two cannot
 * drift.
 *
 * Curated along the axes alpha coding is sensitive to rather than by subject:
 * hard binary masks vs anti-aliased edges, mostly-opaque vs mostly-transparent,
 * and simple silhouettes vs detailed cut-outs.
 *
 * The `sealed-cutout-*` entries are the sealed holdout2 split (#107), drawn
 * from Commons on those same three axes by the protocol #107 records: cuts
 * fixed in advance (non-opaque < 0.5 or ≥ 0.5; soft-alpha ≤ 0.01 or ≥ 0.03;
 * silhouette ≤ 1.5 or ≥ 2.0, measured by `corpus-covariates.ts`), two per
 * cell, in a seeded order, with no encoder run on any candidate. Sixteen were
 * proposed and fourteen approved: the LAPD patch (a city work tagged public
 * domain) and an AI-generated icon were dropped and not replaced, so the
 * opaque/hard/simple and transparent/soft/simple cells hold one image each.
 *
 * The `sealed3-cutout-*` entries are the alpha part of holdout3 (#129),
 * drawn by `corpus-covariates.ts --draw-holdout3` under the protocol
 * `spec/EXPERIMENTS.md` §11.12 records: the same cells and cuts, three per
 * cell, in the seeded order `sha256("holdout3:" + title)`, with no encoder
 * run on any candidate. Each carries its draw record and strata.
 */
export const ALPHA_IMAGES: AlphaImageSpec[] = [
  {
    label: "cutout-3d-star-greek",
    url: "https://upload.wikimedia.org/wikipedia/commons/c/ce/3D_greek_star.png",
    ext: ".png",
    width: 827,
    height: 852,
    split: "tune",
    nonOpaqueFraction: 0.7403,
    softAlphaFraction: 0.2443,
    sha256: "28b9e4888cdcbfa13cafbb1b56d0ee1f515756b99b8f7ecc00a544ecaa85dc7c",
    source: "https://commons.wikimedia.org/wiki/File:3D_greek_star.png",
    author: "Andrikkos",
    licence: "CC BY-SA 3.0",
    notes:
      "3D glossy star render with soft shading and mostly-transparent canvas.",
  },
  {
    label: "cutout-3d-star-soviet",
    url: "https://upload.wikimedia.org/wikipedia/commons/5/52/3D_plastic_soviet_star.png",
    ext: ".png",
    width: 608,
    height: 579,
    split: "tune",
    nonOpaqueFraction: 0.656,
    softAlphaFraction: 0.0,
    sha256: "89e2d3f669b448c56e47a9c29de65121c60a3d9e9910c95499f0233817074d94",
    source:
      "https://commons.wikimedia.org/wiki/File:3D_plastic_soviet_star.png",
    author: "Andrikkos",
    licence: "CC BY-SA 3.0",
    notes:
      "Small saturated 3D star; simple shape, high proportion of transparency.",
  },
  {
    label: "cutout-app-icon-aptoide",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/ef/Aptoide_icon_2025.png",
    ext: ".png",
    width: 601,
    height: 600,
    split: "tune2",
    nonOpaqueFraction: 0.1179,
    softAlphaFraction: 0.0053,
    sha256: "40ae89a4816df285936235cf877f7c69cf9ca000e27eeea3ac4709dce0e7982a",
    source: "https://commons.wikimedia.org/wiki/File:Aptoide_icon_2025.png",
    author: "Aptoide",
    licence: "Public domain",
    notes: "Modern app icon; flat colour, rounded-square alpha mask.",
  },
  {
    label: "cutout-bioart-astrocyte",
    url: "https://upload.wikimedia.org/wikipedia/commons/5/5b/Astrocyte_%28NIH_BioArt_40_-_627569%29.png",
    ext: ".png",
    width: 1609,
    height: 1395,
    split: "tune",
    nonOpaqueFraction: 0.8847,
    softAlphaFraction: 0.0093,
    sha256: "559304d1f8226cfafa4de7685601a3d5dd0673e93365b7b8dc9093a2112849a9",
    source:
      "https://commons.wikimedia.org/wiki/File:Astrocyte_(NIH_BioArt_40_-_627569).png",
    author: "Courtesy of NIAID Ryan Kissinger",
    licence: "Public domain",
    notes:
      "Scientific illustration on transparency; thin branching structure, mostly transparent.",
  },
  {
    label: "cutout-broccoli",
    url: "https://upload.wikimedia.org/wikipedia/commons/f/f1/Broccoli.png",
    ext: ".png",
    width: 2261,
    height: 1833,
    split: "tune",
    nonOpaqueFraction: 0.4821,
    softAlphaFraction: 0.0132,
    sha256: "e7f19280e60b7f164bd53e68134040fa97c3efb539ff44edf2d985ccb3a48f8f",
    source: "https://commons.wikimedia.org/wiki/File:Broccoli.png",
    author: "Tiia Monto",
    licence: "CC BY-SA 3.0",
    notes:
      "Highly fractal organic edge, the hardest kind of alpha boundary to approximate.",
  },
  {
    label: "cutout-campaign-medal",
    url: "https://upload.wikimedia.org/wikipedia/commons/8/82/Afghanistan_Campaign_Medal.png",
    ext: ".png",
    width: 726,
    height: 816,
    split: "tune2",
    nonOpaqueFraction: 0.4527,
    softAlphaFraction: 0.0004,
    sha256: "1d49ac031e3ae558d3a46cbb3aec5b12c64e31363f01705a9b49852f458f29f8",
    source:
      "https://commons.wikimedia.org/wiki/File:Afghanistan_Campaign_Medal.png",
    author: "Defense Logistics Agency",
    licence: "Public domain",
    notes:
      "Medal with ribbon: metallic detail plus fabric texture, narrow mostly-transparent frame.",
  },
  {
    label: "cutout-cheeseburger",
    url: "https://upload.wikimedia.org/wikipedia/commons/1/11/Cheeseburger.png",
    ext: ".png",
    width: 2700,
    height: 1800,
    split: "tune",
    nonOpaqueFraction: 0.449,
    softAlphaFraction: 0.0,
    sha256: "cff8d8ac543defb51454a96a1513dafb43457a569f487030380128b76cfa760a",
    source: "https://commons.wikimedia.org/wiki/File:Cheeseburger.png",
    author:
      "Renee Comet (photographer) - edited for transparent background by -download | sign!",
    licence: "Public domain",
    notes:
      "Detailed food cutout; highly textured, colourful, large opaque area.",
  },
  {
    label: "cutout-dod-seal",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/43/Seal_of_the_United_States_Department_of_Defense_%282001%E2%80%932022%29.png",
    ext: ".png",
    width: 600,
    height: 599,
    split: "tune",
    nonOpaqueFraction: 0.2175,
    softAlphaFraction: 0.0062,
    sha256: "8a67df69e07c9e342bd9d7ac677e6a962ac0a39507881b531bdf88e9baabbaa9",
    source:
      "https://commons.wikimedia.org/wiki/File:Seal_of_the_United_States_Department_of_Defense_(2001%E2%80%932022).png",
    author: "DOD",
    licence: "Public domain",
    notes:
      "Circular seal: fine radial text and detail, hard circular alpha boundary.",
  },
  {
    label: "cutout-dslr-camera",
    url: "https://upload.wikimedia.org/wikipedia/commons/3/3d/Nikon_D90.png",
    ext: ".png",
    width: 800,
    height: 719,
    split: "tune2",
    nonOpaqueFraction: 0.5228,
    softAlphaFraction: 0.006,
    sha256: "b52e726f129bfc656763ac5d2c8c98f4ee96ce1b6cea95010fa90cb8564bffc5",
    source: "https://commons.wikimedia.org/wiki/File:Nikon_D90.png",
    author: "Zacke82",
    licence: "Public domain",
    notes:
      "Product photo cutout of a DSLR body; detailed dark monochrome subject with hard-ish silhouette.",
  },
  {
    label: "cutout-emblem-kscz",
    url: "https://upload.wikimedia.org/wikipedia/commons/7/7a/Emblem_of_the_Communist_Party_of_Czechoslovakia_1948-1990.png",
    ext: ".png",
    width: 564,
    height: 538,
    split: "tune",
    nonOpaqueFraction: 0.6614,
    softAlphaFraction: 0.0,
    sha256: "c8095953b20fd2e8b0a2db22902f3353c5c7196ac35302e00dee221842afad43",
    source:
      "https://commons.wikimedia.org/wiki/File:Emblem_of_the_Communist_Party_of_Czechoslovakia_1948-1990.png",
    author: "Danrolo",
    licence: "CC BY-SA 3.0",
    notes:
      "Two-colour flat emblem; mostly transparent, near-monochrome, simple shapes.",
  },
  {
    label: "cutout-game-sprite-ship",
    url: "https://upload.wikimedia.org/wikipedia/commons/6/61/Galak-Z_art_-_ship_BULLDOZER.png",
    ext: ".png",
    width: 1344,
    height: 708,
    split: "tune",
    nonOpaqueFraction: 0.6794,
    softAlphaFraction: 0.0041,
    sha256: "0e731563527cb737e4f0ff4cff0fbb723fa3dced9d48ec8f72f0ad63945519ca",
    source:
      "https://commons.wikimedia.org/wiki/File:Galak-Z_art_-_ship_BULLDOZER.png",
    author: "Raj Joshi, Senior Producer & Studio Director for 17-BIT",
    licence: "CC BY-SA 3.0",
    notes:
      "Game sprite art: pixel/vector spaceship with hard alpha and saturated colour.",
  },
  {
    label: "cutout-glassfish",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/d9/Agassiz%27s_glassfish_%28Ambassis_agassizii%29_isolated_2023-03-08.png",
    ext: ".png",
    width: 2417,
    height: 1461,
    split: "tune2",
    nonOpaqueFraction: 0.6323,
    softAlphaFraction: 0.099,
    sha256: "122c8a89f44ddd023cb0c581e565cd027c4013261e06a11d54ceef379d85305c",
    source:
      "https://commons.wikimedia.org/wiki/File:Agassiz%27s_glassfish_(Ambassis_agassizii)_isolated_2023-03-08.png",
    author: "Pelagic",
    licence: "CC BY-SA 4.0",
    notes:
      "Isolated fish photo with translucent fins, i.e. genuinely soft partial alpha.",
  },
  {
    label: "cutout-greek-vase-figure",
    url: "https://upload.wikimedia.org/wikipedia/commons/8/8e/NAMA_Th%C3%A9s%C3%A9e_%26_taureau.png",
    ext: ".png",
    width: 723,
    height: 1748,
    split: "tune",
    nonOpaqueFraction: 0.518,
    softAlphaFraction: 0.1824,
    sha256: "ff3e45df88805a10348a8fd92d1212a9410ebe6cce22d52e02ab1188d05a89f8",
    source:
      "https://commons.wikimedia.org/wiki/File:NAMA_Th%C3%A9s%C3%A9e_%26_taureau.png",
    author: "Unknown",
    licence: "CC BY-SA 2.5",
    notes: "Ancient artefact cutout; fine detail, warm two-tone palette.",
  },
  {
    label: "cutout-green-dragon",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/49/Little_Green_Dragon_-_looking_left_-_Museum_of_Asian_Art_of_Corfu.png",
    ext: ".png",
    width: 2120,
    height: 2760,
    split: "tune",
    nonOpaqueFraction: 0.5364,
    softAlphaFraction: 0.0,
    sha256: "4d02f29aec4e6de647874836130026e8c413b820b122af3bbddb56a61d097ea6",
    source:
      "https://commons.wikimedia.org/wiki/File:Little_Green_Dragon_-_looking_left_-_Museum_of_Asian_Art_of_Corfu.png",
    author: "User Piotrus; edited by user Jaybear",
    licence: "CC BY-SA 3.0",
    notes: "Museum object cutout with an intricate perforated silhouette.",
  },
  {
    label: "cutout-insignia-4id",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/d0/4th_Infantry_Division_SSI.png",
    ext: ".png",
    width: 622,
    height: 620,
    split: "tune2",
    nonOpaqueFraction: 0.4635,
    softAlphaFraction: 0.0011,
    sha256: "8fb32f6350082d5b90019b4fdd2070bea4e0d8fb48e934a0f50b4c2d85f08924",
    source:
      "https://commons.wikimedia.org/wiki/File:4th_Infantry_Division_SSI.png",
    author: "US Army",
    licence: "Public domain",
    notes:
      "Flat vector-style military patch; hard binary alpha, few flat colours.",
  },
  {
    label: "cutout-lamp-glow",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/eb/LampOnGlow.png",
    ext: ".png",
    width: 1000,
    height: 760,
    split: "tune",
    nonOpaqueFraction: 0.9119,
    softAlphaFraction: 0.2928,
    sha256: "857ef6d2b9fd450be843429cca5f49353705c52000647791bb7530de81de840f",
    source: "https://commons.wikimedia.org/wiki/File:LampOnGlow.png",
    author: "Roman Dilo (Saroman)",
    licence: "CC BY 3.0",
    notes:
      "Lamp with a wide translucent glow, dominated by partial (soft) alpha rather than binary.",
  },
  {
    label: "cutout-lineart-hoe",
    url: "https://upload.wikimedia.org/wikipedia/commons/6/65/Hoe_%28PSF%29.png",
    ext: ".png",
    width: 2749,
    height: 2483,
    split: "tune",
    nonOpaqueFraction: 0.7286,
    softAlphaFraction: 0.0108,
    sha256: "fd3ad52a4a82f4c685d05981ce3e54ddc35403e23945a3be62fb7b2986e6f142",
    source: "https://commons.wikimedia.org/wiki/File:Hoe_(PSF).png",
    author: "Pearson Scott Foresman",
    licence: "Public domain",
    notes:
      "Public-domain pen line art of a man hoeing a field; monochrome greyscale+alpha (LA), sparse strokes, ~73% transparent.",
  },
  {
    label: "cutout-lineart-oinochoe",
    url: "https://upload.wikimedia.org/wikipedia/commons/b/b1/Oinochoe_%28PSF%29.png",
    ext: ".png",
    width: 1255,
    height: 2048,
    split: "tune2",
    nonOpaqueFraction: 0.4301,
    softAlphaFraction: 0.0028,
    sha256: "3bfbc282601a585c17938950b8cba766faeaf4d423bf8a36b87e716c4c42d5ff",
    source: "https://commons.wikimedia.org/wiki/File:Oinochoe_(PSF).png",
    author: "Pearson Scott Foresman",
    licence: "Public domain",
    notes:
      "Line-art vessel drawing; hatched shading, monochrome, mostly transparent.",
  },
  {
    label: "cutout-navy-crest",
    url: "https://upload.wikimedia.org/wikipedia/commons/9/97/USS_Cole_DDG-67_Crest.png",
    ext: ".png",
    width: 892,
    height: 1134,
    split: "tune",
    nonOpaqueFraction: 0.1729,
    softAlphaFraction: 0.0,
    sha256: "61eab4c1618ddbc8de9cbf78135492bee775be50d15a6eebd7335bf3be370643",
    source: "https://commons.wikimedia.org/wiki/File:USS_Cole_DDG-67_Crest.png",
    author: "A Member of the United States Armed Forces",
    licence: "Public domain",
    notes: "Heraldic crest, detailed multi-colour flat art with hard alpha.",
  },
  {
    label: "cutout-nokia-soft-shadow",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/ae/Nokia_3410_%28cutout_transparent_background_and_shadow%29.png",
    ext: ".png",
    width: 732,
    height: 1554,
    split: "tune",
    nonOpaqueFraction: 0.2236,
    softAlphaFraction: 0.0675,
    sha256: "75951d906cb08acc1a643554dde538d739d3f814a5f5231a7971a96550ada98a",
    source:
      "https://commons.wikimedia.org/wiki/File:Nokia_3410_(cutout_transparent_background_and_shadow).png",
    author: "Erik Baas",
    licence: "CC BY-SA 3.0",
    notes:
      "Phone cutout that keeps a soft drop shadow, so a large area is partial alpha rather than binary.",
  },
  {
    label: "cutout-planet-gas-giant",
    url: "https://upload.wikimedia.org/wikipedia/commons/2/20/Blue_gas_giant.png",
    ext: ".png",
    width: 4000,
    height: 4000,
    split: "tune2",
    nonOpaqueFraction: 0.4301,
    softAlphaFraction: 0.1796,
    sha256: "16d9563712b9d7b42c548b64821d7f17f2913c5ed62c62086967394d5540183d",
    source: "https://commons.wikimedia.org/wiki/File:Blue_gas_giant.png",
    author: "unnamed",
    licence: "CC0",
    notes:
      "Banded gas giant render; smooth low-detail interior, soft alpha rim.",
  },
  {
    label: "cutout-planet-lava",
    url: "https://upload.wikimedia.org/wikipedia/commons/7/70/Lava_planet.png",
    ext: ".png",
    width: 2300,
    height: 2300,
    split: "tune",
    nonOpaqueFraction: 0.391,
    softAlphaFraction: 0.0618,
    sha256: "74b6ae59cbfef2fa11e59d29d51ed326b3c26a10ac40604eec9ccd94883ea9cc",
    source: "https://commons.wikimedia.org/wiki/File:Lava_planet.png",
    author: "Max",
    licence: "CC BY-SA 3.0",
    notes:
      "Rendered planet with glowing soft-alpha atmosphere; dark body, high contrast.",
  },
  {
    label: "cutout-road-sign",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/4a/%22Maryland_Welcomes_You_-_Enjoy_Your_Visit%21%22_road_sign%2C_c._1999.png",
    ext: ".png",
    width: 1332,
    height: 1509,
    split: "tune",
    nonOpaqueFraction: 0.1533,
    softAlphaFraction: 0.0018,
    sha256: "56297cb398e82ca506d2057a4402218a1113f7acb38ac92e2c1b3f5e6d460122",
    source:
      "https://commons.wikimedia.org/wiki/File:%22Maryland_Welcomes_You_-_Enjoy_Your_Visit!%22_road_sign,_c._1999.png",
    author: "State of Maryland, Maryland SHWA",
    licence: "Public domain",
    notes:
      "Text-heavy road sign on transparency; flat colour, hard rectangular-ish alpha.",
  },
  {
    label: "cutout-wordmark-aflac",
    url: "https://upload.wikimedia.org/wikipedia/commons/8/81/Aflac_logo.png",
    ext: ".png",
    width: 3840,
    height: 1227,
    split: "holdout",
    nonOpaqueFraction: 0.5971,
    softAlphaFraction: 0.0077,
    sha256: "3e0ddc1b3b6856b16b48ac2003f343e0e8cfaff02f022e8b2c21fbf24de2e302",
    source: "https://commons.wikimedia.org/wiki/File:Aflac_logo.png",
    author: "Aflac",
    licence: "CC BY 4.0",
    notes:
      "Wide wordmark logo: extreme aspect, monochrome, overwhelmingly transparent canvas.",
    withdrawn:
      "deleted from Wikimedia Commons on 2026-08-25 as a copyright violation (COM:CSD#F1); no archived copy (#83)",
  },
  {
    label: "sealed-cutout-2006-nd-proof",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/d9/2006_ND_Proof.png",
    ext: ".png",
    width: 2000,
    height: 2000,
    split: "holdout2",
    nonOpaqueFraction: 0.3271,
    softAlphaFraction: 0.1239,
    sha256: "ffe78ac75f9092627d69005ffa1c952338c5e21a58fff3d89ce9b729aad7ae28",
    source: "https://commons.wikimedia.org/wiki/File:2006_ND_Proof.png",
    author: "United States Mint",
    licence: "Public domain",
    notes:
      "Cell opaque/soft/simple; silhouette 1.19. North Dakota state quarter proof: fine silver relief inside an anti-aliased circular rim.",
  },
  {
    label: "sealed-cutout-bupropion-molecule-spacefill",
    url: "https://upload.wikimedia.org/wikipedia/commons/5/57/Bupropion_molecule_spacefill.png",
    ext: ".png",
    width: 2000,
    height: 1485,
    split: "holdout2",
    nonOpaqueFraction: 0.5209,
    softAlphaFraction: 0.0021,
    sha256: "b10fc6254dedf252ae40d4ad32a49d72fb08fad2cef965f4aabcaebe20e35ee1",
    source:
      "https://commons.wikimedia.org/wiki/File:Bupropion_molecule_spacefill.png",
    author: "Jynto (talk)",
    licence: "CC0",
    notes:
      "Cell transparent/hard/simple; silhouette 1.48. Space-filling molecule render, a compact blob of shaded spheres.",
  },
  {
    label: "sealed-cutout-coffee-bean",
    url: "https://upload.wikimedia.org/wikipedia/commons/5/55/Coffee_bean_transparent.png",
    ext: ".png",
    width: 1005,
    height: 1005,
    split: "holdout2",
    nonOpaqueFraction: 0.7513,
    softAlphaFraction: 0.2031,
    sha256: "9c47c28d41745b58a476249abe3102bc5ea84626c8fde1e89d0083d3c0f0db58",
    source:
      "https://commons.wikimedia.org/wiki/File:Coffee_bean_transparent.png",
    author: "Chiccodoro",
    licence: "CC BY-SA 2.0",
    notes:
      "Cell transparent/soft/simple (the cell's only image: its other candidate was not approved); silhouette 1.24. Single coffee bean photo cut-out with a soft shadow fringe.",
  },
  {
    label: "sealed-cutout-flashlight-symbol",
    url: "https://upload.wikimedia.org/wikipedia/commons/6/68/Flashlight_symbol.png",
    ext: ".png",
    width: 984,
    height: 794,
    split: "holdout2",
    nonOpaqueFraction: 0.7807,
    softAlphaFraction: 0.7807,
    sha256: "44c9659c2d9a54a8b730300a727906dbd698825d4a20829d6e4a1d2b60bcda02",
    source: "https://commons.wikimedia.org/wiki/File:Flashlight_symbol.png",
    author: "Timedfootpaths",
    licence: "CC BY-SA 4.0",
    notes:
      "Cell transparent/soft/detailed; silhouette 2.75. Line-art flashlight icon with light rays. No fully transparent pixel: its background is one partly transparent layer, so its soft alpha is a translucent field rather than a feathered edge.",
  },
  {
    label: "sealed-cutout-flowerit-5-gray",
    url: "https://upload.wikimedia.org/wikipedia/commons/b/bc/Flowerit_5_Gray.png",
    ext: ".png",
    width: 614,
    height: 595,
    split: "holdout2",
    nonOpaqueFraction: 0.6415,
    softAlphaFraction: 0.0,
    sha256: "7778893f7946e67f7bdc0d7fc6f84ca8abcc92315b5ca8dc3dd32a1a9ca70c7d",
    source: "https://commons.wikimedia.org/wiki/File:Flowerit_5_Gray.png",
    author: "unknown: very old wide-spread illustrations ornament",
    licence: "CC0",
    notes:
      "Cell transparent/hard/detailed; silhouette 5.62. Flat grey five-petal flower ornament with a binary mask and an open centre ring.",
  },
  {
    label: "sealed-cutout-helmed-hoplite-sparta",
    url: "https://upload.wikimedia.org/wikipedia/commons/c/c4/Helmed_Hoplite_Sparta_2.png",
    ext: ".png",
    width: 517,
    height: 836,
    split: "holdout2",
    nonOpaqueFraction: 0.5236,
    softAlphaFraction: 0.0,
    sha256: "7c95feabb74e52e82f72ca65f80278e4b84a56c47183f7e79142b0b34391d71b",
    source:
      "https://commons.wikimedia.org/wiki/File:Helmed_Hoplite_Sparta_2.png",
    author: "Modifications by myself of a picture by de:Benutzer:Ticinese",
    licence: "CC BY-SA 3.0",
    notes:
      "Cell transparent/hard/simple; silhouette 1.45. Photo cut-out of a sculpted helmeted hoplite bust, stone texture, binary mask.",
  },
  {
    label: "sealed-cutout-journal-plague-year",
    url: "https://upload.wikimedia.org/wikipedia/commons/5/52/A_Journal_of_the_Plague_Year_-_Half_Title_Headpiece.png",
    ext: ".png",
    width: 1304,
    height: 109,
    split: "holdout2",
    nonOpaqueFraction: 0.4935,
    softAlphaFraction: 0.0,
    sha256: "ff8a6aabccf29b24602bd6e5680e6243da42dad54d3b307966c76014c565377f",
    source:
      "https://commons.wikimedia.org/wiki/File:A_Journal_of_the_Plague_Year_-_Half_Title_Headpiece.png",
    author: "Daniel Defoe Artist unknown",
    licence: "Public domain",
    notes:
      "Cell opaque/hard/detailed; silhouette 28.95. Ornamental book headpiece band at a 12:1 aspect, near the format's 16:1 limit and wider than any other alpha pin.",
  },
  {
    label: "sealed-cutout-languages-difference-icon",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/4c/Languages_difference_icon.png",
    ext: ".png",
    width: 2000,
    height: 2000,
    split: "holdout2",
    nonOpaqueFraction: 0.2135,
    softAlphaFraction: 0.0444,
    sha256: "a38fe6c358a9841f733f4635b0af4e50f1c5367d3077a63f884602e1072ee2aa",
    source:
      "https://commons.wikimedia.org/wiki/File:Languages_difference_icon.png",
    author: "SlicedIceDice",
    licence: "CC BY-SA 4.0",
    notes:
      "Cell opaque/soft/simple; silhouette 1.21. Round light-blue icon lettered with greetings in many scripts; anti-aliased rim.",
  },
  {
    label: "sealed-cutout-mammal-barnstar-hires",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/4d/Mammal_Barnstar_Hires.png",
    ext: ".png",
    width: 2000,
    height: 1900,
    split: "holdout2",
    nonOpaqueFraction: 0.6083,
    softAlphaFraction: 0.047,
    sha256: "cf95173996a1e043be4dbf8a4c9c201c6cf4a4a9c64f1b281b8cc20180bdc699",
    source: "https://commons.wikimedia.org/wiki/File:Mammal_Barnstar_Hires.png",
    author: "Original idea by Leptictidium Original remastering by Antonu",
    licence: "CC BY-SA 3.0",
    notes:
      "Cell transparent/soft/detailed; silhouette 2.48. Tiger head over a bronze barnstar; illustrated, anti-aliased edges.",
  },
  {
    label: "sealed-cutout-marcosticks-3d-printed",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/d9/Marcosticks-3D-printed_Ergonomic_chopsticks.png",
    ext: ".png",
    width: 4032,
    height: 3024,
    split: "holdout2",
    nonOpaqueFraction: 0.7571,
    softAlphaFraction: 0.0075,
    sha256: "9fd578d0542ed53d6fde4c97cf251556f38ecb69e5f84fb911ee7f55cc53c3f3",
    source:
      "https://commons.wikimedia.org/wiki/File:Marcosticks-3D-printed_Ergonomic_chopsticks.png",
    author: "Marcosticks",
    licence: "CC BY-SA 4.0",
    notes:
      "Cell transparent/hard/detailed; silhouette 2.71. Photo cut-out of a hand holding 3D-printed chopsticks: long thin shapes on a mostly transparent canvas.",
  },
  {
    label: "sealed-cutout-neuro-muscular-junction",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/ac/Neuro_Muscular_Junction.png",
    ext: ".png",
    width: 4096,
    height: 3112,
    split: "holdout2",
    nonOpaqueFraction: 0.4854,
    softAlphaFraction: 0.4086,
    sha256: "5831ddccee0ab6de9d950cedf5829a0cf15677958655432e36ad94f5e8323694",
    source:
      "https://commons.wikimedia.org/wiki/File:Neuro_Muscular_Junction.png",
    author: "Doctor Jana",
    licence: "CC BY 4.0",
    notes:
      "Cell opaque/soft/detailed; silhouette 5.49. Labelled medical illustration of a neuromuscular junction; partial alpha covers about 41% of the canvas.",
  },
  {
    label: "sealed-cutout-new-doodles-2016",
    url: "https://upload.wikimedia.org/wikipedia/commons/1/1e/New_doodles_2016_4.png",
    ext: ".png",
    width: 1112,
    height: 1112,
    split: "holdout2",
    nonOpaqueFraction: 0.4794,
    softAlphaFraction: 0.0335,
    sha256: "3fcc1ddc26d7d9ac3aa5441970478e43775459d55a0676398a5b1202b08f2614",
    source: "https://commons.wikimedia.org/wiki/File:New_doodles_2016_4.png",
    author: "Oxana59",
    licence: "CC BY-SA 4.0",
    notes:
      "Cell opaque/soft/detailed; silhouette 4.68. Grid of fourteen colourful mandala doodles: many separate intricate shapes.",
  },
  {
    label: "sealed-cutout-uscgc-florence-finch",
    url: "https://upload.wikimedia.org/wikipedia/commons/b/bb/USCGC_Florence_Finch_%28WPC_1157%29_CoA.png",
    ext: ".png",
    width: 2178,
    height: 2178,
    split: "holdout2",
    nonOpaqueFraction: 0.2211,
    softAlphaFraction: 0.0014,
    sha256: "17a22976013b846f544f841cf6dcdb86ebe73e8f06e1c372a11c3d92db5cff6e",
    source:
      "https://commons.wikimedia.org/wiki/File:USCGC_Florence_Finch_(WPC_1157)_CoA.png",
    author: "The Institute of Heraldry",
    licence: "Public domain",
    notes:
      "Cell opaque/hard/simple (the cell's only image: its other candidate was not approved); silhouette 1.18. Circular cutter coat of arms: lettered ring around a heraldic shield, hard mask.",
  },
  {
    label: "sealed-cutout-usmc-pistol-marksman",
    url: "https://upload.wikimedia.org/wikipedia/commons/2/23/USMC_Pistol_Marksman_badge.png",
    ext: ".png",
    width: 603,
    height: 600,
    split: "holdout2",
    nonOpaqueFraction: 0.4739,
    softAlphaFraction: 0.0,
    sha256: "64332e02d051cd87d16fd7ca0350cededeaab4778f2a66f0e5d3812c4033a2ba",
    source:
      "https://commons.wikimedia.org/wiki/File:USMC_Pistol_Marksman_badge.png",
    author: "USMC",
    licence: "Public domain",
    notes:
      "Cell opaque/hard/detailed; silhouette 2.46. Silver marksmanship badge: lettered bar and hanging target pendant, binary mask.",
  },
  // holdout3 pins (#129): written by `corpus-covariates.js --pin-holdout3` from fixtures/holdout3-draw.json; never edit by hand.
  {
    label: "sealed3-cutout-bic-j5",
    url: "https://upload.wikimedia.org/wikipedia/commons/7/76/Bic_J5.png",
    ext: ".png",
    width: 710,
    height: 313,
    split: "holdout3",
    nonOpaqueFraction: 0.4108,
    softAlphaFraction: 0.0036,
    sha256: "57ec10a912f626c172bef0e16d6f69b3361749a1a0f522414b2ae644fc869c5d",
    source: "https://commons.wikimedia.org/wiki/File:Bic_J5.png",
    author: "USer:Bilou",
    licence: "CC BY-SA 3.0",
    notes:
      "Cell opaque/hard/simple; silhouette 1.36. Drawn from the kitchen query.",
    holdout3: {
      drawnAs: "alpha: opaque/hard/simple",
      camera: null,
      phone: false,
      meanL: 27.8764,
      lowKey: 0.4105,
      skin: 0.005,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-vine-leaf-ornament-gray",
    url: "https://upload.wikimedia.org/wikipedia/commons/0/0e/Vine_leaf_ornament_Gray_LE.png",
    ext: ".png",
    width: 609,
    height: 609,
    split: "holdout3",
    nonOpaqueFraction: 0.5303,
    softAlphaFraction: 0,
    sha256: "a7851c31850e45e48c8a2fa5d34e46cd26f8dc1bff8a2ec9f367a2297e84ccaa",
    source:
      "https://commons.wikimedia.org/wiki/File:Vine_leaf_ornament_Gray_LE.png",
    author: "Inductiveload",
    licence: "CC0",
    notes:
      "Cell transparent/hard/detailed; silhouette 3.37. Drawn from the organisms query.",
    holdout3: {
      drawnAs: "alpha: transparent/hard/detailed",
      camera: null,
      phone: false,
      meanL: 30.3029,
      lowKey: 0.5113,
      skin: 0,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-weird-tales-v36n04-separator",
    url: "https://upload.wikimedia.org/wikipedia/commons/3/37/Weird_Tales_v36n04_-_Separator_p.48.png",
    ext: ".png",
    width: 771,
    height: 27,
    split: "holdout3",
    nonOpaqueFraction: 0.7376,
    softAlphaFraction: 0.6102,
    sha256: "a3a4c5a28fe2ba79a090f9c9ddf7eb4d461aa17e86e0ef55633c206ae714b869",
    source:
      "https://commons.wikimedia.org/wiki/File:Weird_Tales_v36n04_-_Separator_p.48.png",
    author: "Unknown authorUnknown author",
    licence: "Public domain",
    notes:
      "Cell transparent/soft/detailed; silhouette 10.99. Drawn from the ornaments query.",
    holdout3: {
      drawnAs: "alpha: transparent/soft/detailed",
      camera: null,
      phone: false,
      meanL: 0,
      lowKey: 1,
      skin: 0,
      strata: ["alpha", "extreme-aspect"],
    },
  },
  {
    label: "sealed3-cutout-anime-girl-publicdomainq",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/e7/Anime_girl_publicdomainq.png",
    ext: ".png",
    width: 1570,
    height: 2400,
    split: "holdout3",
    nonOpaqueFraction: 0.3536,
    softAlphaFraction: 0.0032,
    sha256: "d51fea3bef4cce76b07755a67de454a288be47d81a6fb87f29723ccbf8a765e2",
    source:
      "https://commons.wikimedia.org/wiki/File:Anime_girl_publicdomainq.png",
    author: "oksmith",
    licence: "CC0",
    notes:
      "Cell opaque/hard/detailed; silhouette 2.13. Drawn from the hair query.",
    holdout3: {
      drawnAs: "alpha: opaque/hard/detailed",
      camera: null,
      phone: false,
      meanL: 39.4679,
      lowKey: 0.3403,
      skin: 0.2957,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-runner-icon-colors2",
    url: "https://upload.wikimedia.org/wikipedia/commons/8/8b/Runner_icon_colors2.png",
    ext: ".png",
    width: 768,
    height: 748,
    split: "holdout3",
    nonOpaqueFraction: 0.7298,
    softAlphaFraction: 0.0068,
    sha256: "8e1d4b3409c241aa2743a77885f525cdb467e53342b7f7dc48d5d1a98196b259",
    source: "https://commons.wikimedia.org/wiki/File:Runner_icon_colors2.png",
    author: "Agonatrix",
    licence: "CC0",
    notes:
      "Cell transparent/hard/detailed; silhouette 3.04. Drawn from the icons query.",
    holdout3: {
      drawnAs: "alpha: transparent/hard/detailed",
      camera: null,
      phone: false,
      meanL: 9.932,
      lowKey: 0.7292,
      skin: 0.1642,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-flowerc-ornament-gold",
    url: "https://upload.wikimedia.org/wikipedia/commons/3/3d/FlowerC_Ornament_Gold.png",
    ext: ".png",
    width: 575,
    height: 555,
    split: "holdout3",
    nonOpaqueFraction: 0.6137,
    softAlphaFraction: 0,
    sha256: "13a994a4518fc1affee306b48ab30693c53c686efc481af0316579903974255d",
    source: "https://commons.wikimedia.org/wiki/File:FlowerC_Ornament_Gold.png",
    author: "unknown: antique floral ornament",
    licence: "CC0",
    notes:
      "Cell transparent/hard/detailed; silhouette 6.00. Drawn from the organisms query.",
    holdout3: {
      drawnAs: "alpha: transparent/hard/detailed",
      camera: null,
      phone: false,
      meanL: 28.5778,
      lowKey: 0.5798,
      skin: 0.0076,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-canon-powershot-sx500-is",
    url: "https://upload.wikimedia.org/wikipedia/commons/7/72/Canon_Powershot_SX500_IS_Front_Cropped.png",
    ext: ".png",
    width: 2681,
    height: 2587,
    split: "holdout3",
    nonOpaqueFraction: 0.5243,
    softAlphaFraction: 0.0013,
    sha256: "76cf72191c9bf769433aa8c73c87613f8293c21daea3e3ad633e03dddf00a42c",
    source:
      "https://commons.wikimedia.org/wiki/File:Canon_Powershot_SX500_IS_Front_Cropped.png",
    author: "Envagyokabela",
    licence: "CC BY-SA 4.0",
    notes:
      "Cell transparent/hard/simple; silhouette 1.43. Drawn from the cutout-photo query.",
    holdout3: {
      drawnAs: "alpha: transparent/hard/simple",
      camera: null,
      phone: false,
      meanL: 10.1467,
      lowKey: 0.6268,
      skin: 0.0012,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-pulitzer-prizes-medal",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/eb/Pulitzer_Prizes_%28medal%29.png",
    ext: ".png",
    width: 2055,
    height: 1101,
    split: "holdout3",
    nonOpaqueFraction: 0.1739,
    softAlphaFraction: 0.0028,
    sha256: "2e907365b643613dd4c372417522f5833ed9400c06528b49649e7d9f5635d084",
    source:
      "https://commons.wikimedia.org/wiki/File:Pulitzer_Prizes_(medal).png",
    author:
      "Daniel Chester French (1850–1931) and Augustus Lukeman (1872–1935)",
    licence: "Public domain",
    notes:
      "Cell opaque/hard/simple; silhouette 1.35. Drawn from the objects query.",
    holdout3: {
      drawnAs: "alpha: opaque/hard/simple",
      camera: null,
      phone: false,
      meanL: 47.068,
      lowKey: 0.1592,
      skin: 0.5792,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-bowl-of-chopped-almonds",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/af/Bowl_of_chopped_almonds_no_bg.png",
    ext: ".png",
    width: 1887,
    height: 1876,
    split: "holdout3",
    nonOpaqueFraction: 0.2181,
    softAlphaFraction: 0.002,
    sha256: "7841d009e88ad3825357d9016dbaecfc878b48626f3d53c017469534fcd0440a",
    source:
      "https://commons.wikimedia.org/wiki/File:Bowl_of_chopped_almonds_no_bg.png",
    author: "Douglas P Perkins",
    licence: "CC BY-SA 3.0",
    notes:
      "Cell opaque/hard/simple; silhouette 1.13. Drawn from the food query.",
    holdout3: {
      drawnAs: "alpha: opaque/hard/simple",
      camera: null,
      phone: false,
      meanL: 52.0371,
      lowKey: 0.2094,
      skin: 0.0139,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-mortar-and-pestle-sand",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/ec/Mortar_and_pestle_-_sand_casting%2C_bronze-2.png",
    ext: ".png",
    width: 2688,
    height: 3776,
    split: "holdout3",
    nonOpaqueFraction: 0.5825,
    softAlphaFraction: 0.0412,
    sha256: "1728912650f6c0424b60c71ae08bcd984b7de6fca3e37e1b01d385aee694c762",
    source:
      "https://commons.wikimedia.org/wiki/File:Mortar_and_pestle_-_sand_casting,_bronze-2.png",
    author:
      "File:Mortar_and_pestle_-_sand_casting,_bronze.jpg: Hans Chr. R. derivative Work: Saibo (Δ)",
    licence: "CC BY-SA 3.0",
    notes:
      "Cell transparent/soft/detailed; silhouette 2.06. Drawn from the kitchen query.",
    holdout3: {
      drawnAs: "alpha: transparent/soft/detailed",
      camera: null,
      phone: false,
      meanL: 11.9943,
      lowKey: 0.6178,
      skin: 0.1172,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-copa-latina-transparent",
    url: "https://upload.wikimedia.org/wikipedia/commons/1/1b/Copa_latina_transparent.png",
    ext: ".png",
    width: 1400,
    height: 3244,
    split: "holdout3",
    nonOpaqueFraction: 0.4756,
    softAlphaFraction: 0.0041,
    sha256: "fc0ef7f1fe5d88850c8d132d287b5fd617b999ba9bb46c36c931b34fb648352a",
    source:
      "https://commons.wikimedia.org/wiki/File:Copa_latina_transparent.png",
    author: "HLA",
    licence: "CC BY-SA 4.0",
    notes:
      "Cell opaque/hard/detailed; silhouette 2.24. Drawn from the glass query.",
    holdout3: {
      drawnAs: "alpha: opaque/hard/detailed",
      camera: null,
      phone: false,
      meanL: 25.8215,
      lowKey: 0.4636,
      skin: 0.1605,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-picturesque-new-guinea-chapter",
    url: "https://upload.wikimedia.org/wikipedia/commons/9/95/Picturesque_New_Guinea_-_Chapter_5_banner.png",
    ext: ".png",
    width: 1958,
    height: 416,
    split: "holdout3",
    nonOpaqueFraction: 0.9299,
    softAlphaFraction: 0.2276,
    sha256: "6ff063c47115a801b40129a221249319fec52ff55fbf6e1324b85aeb73df6ff5",
    source:
      "https://commons.wikimedia.org/wiki/File:Picturesque_New_Guinea_-_Chapter_5_banner.png",
    author: "Unknown engraver",
    licence: "Public domain",
    notes:
      "Cell transparent/soft/detailed; silhouette 68.31. Drawn from the ornaments query.",
    holdout3: {
      drawnAs: "alpha: transparent/soft/detailed",
      camera: null,
      phone: false,
      meanL: 0,
      lowKey: 1,
      skin: 0,
      strata: ["alpha", "extreme-aspect"],
    },
  },
  {
    label: "sealed3-cutout-abolengo",
    url: "https://upload.wikimedia.org/wikipedia/commons/4/46/ABOLENGO.png",
    ext: ".png",
    width: 424,
    height: 637,
    split: "holdout3",
    nonOpaqueFraction: 0.4916,
    softAlphaFraction: 0.0094,
    sha256: "d83b37126806f6791db6e0e29677c533065a190b5ccd81f67f239b69457919b6",
    source: "https://commons.wikimedia.org/wiki/File:ABOLENGO.png",
    author: "Benjaaladro",
    licence: "CC BY-SA 4.0",
    notes:
      "Cell opaque/hard/detailed; silhouette 2.25. Drawn from the clothing query.",
    holdout3: {
      drawnAs: "alpha: opaque/hard/detailed",
      camera: null,
      phone: false,
      meanL: 41.6808,
      lowKey: 0.5201,
      skin: 0,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-dba-herz",
    url: "https://upload.wikimedia.org/wikipedia/commons/0/0c/Dba-Herz.png",
    ext: ".png",
    width: 1013,
    height: 1003,
    split: "holdout3",
    nonOpaqueFraction: 0.2614,
    softAlphaFraction: 0.0342,
    sha256: "9d9ae586e15d747363346eb235340931ca8ec8ad0b2e1bf4ee29423508162520",
    source: "https://commons.wikimedia.org/wiki/File:Dba-Herz.png",
    author: "Matti Blume, MB-one",
    licence: "CC BY-SA 3.0",
    notes:
      "Cell opaque/soft/simple; silhouette 1.19. Drawn from the food query.",
    holdout3: {
      drawnAs: "alpha: opaque/soft/simple",
      camera: null,
      phone: false,
      meanL: 47.5826,
      lowKey: 0.2285,
      skin: 0.0009,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-smart-cardprinter-closed",
    url: "https://upload.wikimedia.org/wikipedia/commons/c/ce/SMART_Cardprinter_closed.png",
    ext: ".png",
    width: 1500,
    height: 1500,
    split: "holdout3",
    nonOpaqueFraction: 0.5897,
    softAlphaFraction: 0.0025,
    sha256: "a33271d4a384770f2119b5016fd83bea263c2166fa47549aa418f91c3836d5ef",
    source:
      "https://commons.wikimedia.org/wiki/File:SMART_Cardprinter_closed.png",
    author: "Michael Ahrens",
    licence: "CC BY-SA 3.0",
    notes:
      "Cell transparent/hard/simple; silhouette 1.30. Drawn from the objects query.",
    holdout3: {
      drawnAs: "alpha: transparent/hard/simple",
      camera: null,
      phone: false,
      meanL: 34.5082,
      lowKey: 0.5808,
      skin: 0,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-cotinine-molecule-spacefill",
    url: "https://upload.wikimedia.org/wikipedia/commons/1/14/Cotinine_molecule_spacefill.png",
    ext: ".png",
    width: 2000,
    height: 1454,
    split: "holdout3",
    nonOpaqueFraction: 0.5052,
    softAlphaFraction: 0.002,
    sha256: "ae8490b3327b2ca310673f41918b174fa6a6ae7c0c662f482af0257ca1b269b3",
    source:
      "https://commons.wikimedia.org/wiki/File:Cotinine_molecule_spacefill.png",
    author: "Jynto (more from this user)",
    licence: "CC0",
    notes:
      "Cell transparent/hard/simple; silhouette 1.39. Drawn from the smoke query.",
    holdout3: {
      drawnAs: "alpha: transparent/hard/simple",
      camera: null,
      phone: false,
      meanL: 20.0143,
      lowKey: 0.5814,
      skin: 0.0012,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-harpy-hawl-owl-smilie",
    url: "https://upload.wikimedia.org/wikipedia/commons/b/b0/Harpy-Hawl-owl_Smilie_Take_it_easy.png",
    ext: ".png",
    width: 1200,
    height: 1200,
    split: "holdout3",
    nonOpaqueFraction: 0.4136,
    softAlphaFraction: 0.141,
    sha256: "6cf2284aa670dea2b643fc5fec2074c86b401ed727487cdc9aa4e6cf64eaefb2",
    source:
      "https://commons.wikimedia.org/wiki/File:Harpy-Hawl-owl_Smilie_Take_it_easy.png",
    author: "CulmSee-Axel-acad.2161",
    licence: "CC BY-SA 4.0",
    notes:
      "Cell opaque/soft/simple; silhouette 1.31. Drawn from the organisms query.",
    holdout3: {
      drawnAs: "alpha: opaque/soft/simple",
      camera: null,
      phone: false,
      meanL: 49.3902,
      lowKey: 0.3475,
      skin: 0.0032,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-fictional-planet-vulcan",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/db/Fictional_Planet_Vulcan.png",
    ext: ".png",
    width: 4000,
    height: 4000,
    split: "holdout3",
    nonOpaqueFraction: 0.5759,
    softAlphaFraction: 0.3229,
    sha256: "5189d8c48eeecc244878dd086b2c9962231b412f7d5fcd65518074947ab48af0",
    source:
      "https://commons.wikimedia.org/wiki/File:Fictional_Planet_Vulcan.png",
    author: "Shisma",
    licence: "CC BY 4.0",
    notes:
      "Cell transparent/soft/simple; silhouette 1.23. Drawn from the planets query.",
    holdout3: {
      drawnAs: "alpha: transparent/soft/simple",
      camera: null,
      phone: false,
      meanL: 15.1097,
      lowKey: 0.4533,
      skin: 0.3063,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-papas-fritas-argentinas-con",
    url: "https://upload.wikimedia.org/wikipedia/commons/2/2c/Papas_fritas_argentinas_con_huevos_fritos_y_mayonesa_picante.png",
    ext: ".png",
    width: 3832,
    height: 2786,
    split: "holdout3",
    nonOpaqueFraction: 0.2728,
    softAlphaFraction: 0.0361,
    sha256: "a7d3788746a3966c9d966edf09938ebc5efea9e0f230d41d4e324025ca921ec9",
    source:
      "https://commons.wikimedia.org/wiki/File:Papas_fritas_argentinas_con_huevos_fritos_y_mayonesa_picante.png",
    author: "Horacio Cambeiro",
    licence: "CC BY-SA 3.0",
    notes:
      "Cell opaque/soft/simple; silhouette 1.17. Drawn from the food query.",
    holdout3: {
      drawnAs: "alpha: opaque/soft/simple",
      camera: "samsung Galaxy S25 Ultra",
      phone: true,
      meanL: 44.6212,
      lowKey: 0.2474,
      skin: 0.2997,
      strata: ["smartphone", "alpha"],
    },
  },
  {
    label: "sealed3-cutout-red-cement-mixer-truck",
    url: "https://upload.wikimedia.org/wikipedia/commons/2/2d/Red_cement_mixer_truck.png",
    ext: ".png",
    width: 2766,
    height: 877,
    split: "holdout3",
    nonOpaqueFraction: 0.4856,
    softAlphaFraction: 0.0321,
    sha256: "5849b18dbc020797b350413ceab010feef617fa4676a359686ed1e8ad448b705",
    source:
      "https://commons.wikimedia.org/wiki/File:Red_cement_mixer_truck.png",
    author: "User: MrX",
    licence: "CC BY-SA 3.0",
    notes:
      "Cell opaque/soft/detailed; silhouette 3.57. Drawn from the vehicles query.",
    holdout3: {
      drawnAs: "alpha: opaque/soft/detailed",
      camera: null,
      phone: false,
      meanL: 17.1804,
      lowKey: 0.5443,
      skin: 0.0531,
      strata: ["alpha", "extreme-aspect"],
    },
  },
  {
    label: "sealed3-cutout-barnstarman-a",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/a7/BarnStarman_a.png",
    ext: ".png",
    width: 800,
    height: 800,
    split: "holdout3",
    nonOpaqueFraction: 0.7881,
    softAlphaFraction: 0.5745,
    sha256: "2ef6c35f3fef35fac3700ca5b3fcf6a2fc3d8234f0c66b463fe7680b9b9a9626",
    source: "https://commons.wikimedia.org/wiki/File:BarnStarman_a.png",
    author: "Jecowa",
    licence: "CC BY-SA 3.0",
    notes:
      "Cell transparent/soft/simple; silhouette 1.31. Drawn from the glow query.",
    holdout3: {
      drawnAs: "alpha: transparent/soft/simple",
      camera: null,
      phone: false,
      meanL: 68.5642,
      lowKey: 0.2265,
      skin: 0,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-pba-commissioner-s-cup",
    url: "https://upload.wikimedia.org/wikipedia/commons/a/aa/PBA_Commissioner%27s_Cup_Trophy_-_2011.png",
    ext: ".png",
    width: 1182,
    height: 1885,
    split: "holdout3",
    nonOpaqueFraction: 0.4546,
    softAlphaFraction: 0.0337,
    sha256: "afa0dd7205bb8f4c5e7a1073bd693e056569d77ee77e538e2ac9d52df141dfda",
    source:
      "https://commons.wikimedia.org/wiki/File:PBA_Commissioner%27s_Cup_Trophy_-_2011.png",
    author:
      "PBA Commissioner's Cup Trophy - 2011.jpg: Dan Saavedra from Manila, Philippines derivative work: WayKurat (talk)",
    licence: "CC BY 2.0",
    notes:
      "Cell opaque/soft/detailed; silhouette 2.94. Drawn from the objects query.",
    holdout3: {
      drawnAs: "alpha: opaque/soft/detailed",
      camera: null,
      phone: false,
      meanL: 31.6345,
      lowKey: 0.4423,
      skin: 0.1996,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-passenger",
    url: "https://upload.wikimedia.org/wikipedia/commons/9/99/Passenger.png",
    ext: ".png",
    width: 1042,
    height: 1042,
    split: "holdout3",
    nonOpaqueFraction: 0.8927,
    softAlphaFraction: 0.0588,
    sha256: "80daddf2b104528bc2c3617d9d7972352b81725f458fb56001a137b9eafa6d4a",
    source: "https://commons.wikimedia.org/wiki/File:Passenger.png",
    author: "Yashwonth",
    licence: "CC BY-SA 4.0",
    notes:
      "Cell transparent/soft/simple; silhouette 1.38. Drawn from the icons query.",
    holdout3: {
      drawnAs: "alpha: transparent/soft/simple",
      camera: null,
      phone: false,
      meanL: 6.9389,
      lowKey: 0.8347,
      skin: 0,
      strata: ["alpha"],
    },
  },
  {
    label: "sealed3-cutout-icone-noir-pour-representer",
    url: "https://upload.wikimedia.org/wikipedia/commons/5/50/Ic%C3%B4ne_noir_pour_repr%C3%A9senter_une_lavogne_pour_Pic_Patrimoine.png",
    ext: ".png",
    width: 1600,
    height: 1600,
    split: "holdout3",
    nonOpaqueFraction: 0.8893,
    softAlphaFraction: 0.0086,
    sha256: "83d3dc6609bc98c6636074bd0d7848391686e383059a84643b778a5c1f2a2ec6",
    source:
      "https://commons.wikimedia.org/wiki/File:Ic%C3%B4ne_noir_pour_repr%C3%A9senter_une_lavogne_pour_Pic_Patrimoine.png",
    author: "PicPatrimoinePhilippeN",
    licence: "CC0",
    notes:
      "Cell transparent/hard/detailed; silhouette 6.02. Drawn from the icons query.",
    holdout3: {
      drawnAs: "alpha: transparent/hard/detailed",
      camera: null,
      phone: false,
      meanL: 0,
      lowKey: 1,
      skin: 0,
      strata: ["alpha"],
    },
  },
  // end of the holdout3 pins
];

/**
 * The alpha holdout2 pins, after checking that labels and splits agree.
 * `splitFor` seals by the `sealed-` prefix and `inCorpus` puts a sealed image
 * in the alpha corpus only by `sealed-cutout-`, so every holdout2 pin, and
 * only a holdout2 pin, carries {@link ALPHA_HOLDOUT2_PREFIX}; and no alpha pin
 * carries a bare `sealed-` prefix, which would seal it as a photograph.
 */
export function alphaHoldout2Specs(
  images: readonly AlphaImageSpec[] = ALPHA_IMAGES,
): AlphaImageSpec[] {
  const mismatched = images.filter(
    (s) =>
      (s.split === "holdout2") !== s.label.startsWith(ALPHA_HOLDOUT2_PREFIX) ||
      (s.label.startsWith(HOLDOUT2_PREFIX) &&
        !s.label.startsWith(ALPHA_HOLDOUT2_PREFIX)),
  );
  if (mismatched.length > 0) {
    throw new Error(
      `every alpha holdout2 pin, and only an alpha holdout2 pin, is labelled "${ALPHA_HOLDOUT2_PREFIX}*"; these are not: ${mismatched.map((s) => `${s.label} (${s.split})`).join(", ")}`,
    );
  }
  return images.filter((s) => s.split === "holdout2");
}

/**
 * The pins {@link ensureAlphaImages} fetches for `split`. Withdrawn entries
 * are skipped. The retired holdout split throws {@link ALPHA_HOLDOUT_RETIRED}.
 * The sealed holdout2 split is fetched only with the gate's opening, only
 * whole, and never as part of "every split": with no split, its pins are
 * skipped. Separate from the fetch so the self-test (`metric-selftest.ts`)
 * can assert every branch without the network.
 *
 * @param opening The register gate's proof (`openHoldout2` in
 *   `holdout-images.ts`); required for, and only meaningful with, holdout2.
 */
export function alphaImagesToFetch(
  split?: CorpusSplit,
  images: readonly AlphaImageSpec[] = ALPHA_IMAGES,
  opening?: Holdout2Opening | Holdout3Opening,
): AlphaImageSpec[] {
  if (split === "holdout") throw new Error(ALPHA_HOLDOUT_RETIRED);
  const sealed3 = alphaHoldout3Specs(images);
  if (split === "holdout3") {
    if (opening === undefined || !("split" in opening)) {
      throw new Error(
        "the alpha part of holdout3 is sealed: it is fetched only through the register gate (openHoldout3), for one decision spec/V0.8-DECISIONS.md records as frozen",
      );
    }
    const withdrawn = sealed3.filter((s) => s.withdrawn !== undefined);
    if (withdrawn.length > 0) {
      throw new Error(
        `an alpha holdout3 pin is withdrawn (${withdrawn.map((s) => s.label).join(", ")}), so the split cannot be read whole`,
      );
    }
    if (sealed3.length === 0) {
      throw new Error(
        `the alpha part of holdout3 has no pinned images in this table, so decision "${opening.decision}" cannot be read against it`,
      );
    }
    return sealed3;
  }
  const sealed = alphaHoldout2Specs(images);
  if (split === "holdout2") {
    if (opening === undefined || "split" in opening) {
      throw new Error(
        "the alpha holdout2 split is sealed: it is fetched only through the register gate (openHoldout2), for one decision spec/V0.8-DECISIONS.md records as frozen",
      );
    }
    const specs = sealed.filter((s) => s.withdrawn === undefined);
    if (specs.length !== sealed.length) {
      throw new Error(
        `an alpha holdout2 pin is withdrawn (${sealed
          .filter((s) => s.withdrawn !== undefined)
          .map((s) => s.label)
          .join(", ")}), so the split cannot be read whole`,
      );
    }
    if (specs.length === 0) {
      throw new Error(
        `${ALPHA_HOLDOUT2_UNPINNED}, so decision "${opening.decision}" cannot be read against it`,
      );
    }
    return specs;
  }
  return images.filter(
    (spec) =>
      spec.withdrawn === undefined &&
      spec.split !== "holdout2" &&
      spec.split !== "holdout3" &&
      (split === undefined || spec.split === split),
  );
}

/**
 * The alpha holdout3 pins (#129), after checking that every `sealed3-` alpha
 * pin is `sealed3-cutout-*` and holdout3, and carries its draw record.
 */
export function alphaHoldout3Specs(
  images: readonly AlphaImageSpec[] = ALPHA_IMAGES,
): AlphaImageSpec[] {
  return checkHoldout3Pins(images, ALPHA_HOLDOUT3_PREFIX, "alpha");
}

/**
 * Ensure every alpha fixture is present and content-pinned. A fetch failure or
 * digest mismatch throws — see `ensureNaturalImages` for why.
 *
 * @param split Fetch only this split's images. A tune sweep never reads the
 *   holdout images, and requiring them made every alpha sweep depend on the
 *   one holdout file Wikimedia Commons has since deleted
 *   (`cutout-wordmark-aflac`, removed 2026-08-25 as a copyright violation).
 *   The holdout split is retired, so asking for it throws
 *   {@link ALPHA_HOLDOUT_RETIRED} before anything is fetched, rather than
 *   failing on the missing file or scoring a smaller corpus.
 *   The sealed holdout2 split needs `opening`.
 *   With no split, every image that has not been withdrawn and is not sealed
 *   is fetched.
 * @param opening The register gate's proof, for holdout2 only.
 */
export async function ensureAlphaImages(
  split?: CorpusSplit,
  opening?: Holdout2Opening | Holdout3Opening,
): Promise<string[]> {
  const specs = alphaImagesToFetch(split, ALPHA_IMAGES, opening);
  await fs.mkdir(ALPHA_DIR, { recursive: true });
  const paths: string[] = [];
  let downloaded = 0;
  for (const spec of specs) {
    const filePath = path.join(ALPHA_DIR, `${spec.label}${spec.ext}`);
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
    console.log(`Downloaded ${downloaded} alpha image(s) to ${ALPHA_DIR}`);
  }
  if ((split === "holdout2" || split === "holdout3") && opening !== undefined) {
    console.log(
      `alpha ${split} opened for decision "${opening.decision}" (${opening.register} sha256 ${opening.registerSha256.slice(0, 12)})`,
    );
  }
  return paths;
}
