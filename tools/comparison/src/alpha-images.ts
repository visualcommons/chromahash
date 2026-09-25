import fs from "node:fs/promises";
import path from "node:path";
import { ensurePinnedFixture } from "./corpus-pin.ts";
import type { CorpusSplit } from "./corpus.ts";

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
  /** Split. Constants are chosen on "tune" and validated on "holdout". */
  split: CorpusSplit;
  /** Fraction of pixels with alpha < 255, measured on the pinned bytes. */
  nonOpaqueFraction: number;
  /** Fraction with 0 < alpha < 255 — the anti-aliased/soft edges. */
  softAlphaFraction: number;
  /** SHA-256 of the exact bytes (see corpus-pin.ts). */
  sha256: string;
}

/**
 * Curated alpha corpus, sourced from Wikimedia Commons under free licences
 * (see `fixtures/alpha/LICENSES.md` for per-image attribution).
 *
 * Curated along the axes alpha coding is sensitive to rather than by subject:
 * hard binary masks vs anti-aliased edges, mostly-opaque vs mostly-transparent,
 * and simple silhouettes vs detailed cut-outs.
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
  },
  {
    label: "cutout-app-icon-aptoide",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/ef/Aptoide_icon_2025.png",
    ext: ".png",
    width: 601,
    height: 600,
    split: "holdout",
    nonOpaqueFraction: 0.1179,
    softAlphaFraction: 0.0053,
    sha256: "40ae89a4816df285936235cf877f7c69cf9ca000e27eeea3ac4709dce0e7982a",
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
  },
  {
    label: "cutout-campaign-medal",
    url: "https://upload.wikimedia.org/wikipedia/commons/8/82/Afghanistan_Campaign_Medal.png",
    ext: ".png",
    width: 726,
    height: 816,
    split: "holdout",
    nonOpaqueFraction: 0.4527,
    softAlphaFraction: 0.0004,
    sha256: "1d49ac031e3ae558d3a46cbb3aec5b12c64e31363f01705a9b49852f458f29f8",
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
  },
  {
    label: "cutout-dslr-camera",
    url: "https://upload.wikimedia.org/wikipedia/commons/3/3d/Nikon_D90.png",
    ext: ".png",
    width: 800,
    height: 719,
    split: "holdout",
    nonOpaqueFraction: 0.5228,
    softAlphaFraction: 0.006,
    sha256: "b52e726f129bfc656763ac5d2c8c98f4ee96ce1b6cea95010fa90cb8564bffc5",
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
  },
  {
    label: "cutout-glassfish",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/d9/Agassiz%27s_glassfish_%28Ambassis_agassizii%29_isolated_2023-03-08.png",
    ext: ".png",
    width: 2417,
    height: 1461,
    split: "holdout",
    nonOpaqueFraction: 0.6323,
    softAlphaFraction: 0.099,
    sha256: "122c8a89f44ddd023cb0c581e565cd027c4013261e06a11d54ceef379d85305c",
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
  },
  {
    label: "cutout-insignia-4id",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/d0/4th_Infantry_Division_SSI.png",
    ext: ".png",
    width: 622,
    height: 620,
    split: "holdout",
    nonOpaqueFraction: 0.4635,
    softAlphaFraction: 0.0011,
    sha256: "8fb32f6350082d5b90019b4fdd2070bea4e0d8fb48e934a0f50b4c2d85f08924",
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
  },
  {
    label: "cutout-lineart-oinochoe",
    url: "https://upload.wikimedia.org/wikipedia/commons/b/b1/Oinochoe_%28PSF%29.png",
    ext: ".png",
    width: 1255,
    height: 2048,
    split: "holdout",
    nonOpaqueFraction: 0.4301,
    softAlphaFraction: 0.0028,
    sha256: "3bfbc282601a585c17938950b8cba766faeaf4d423bf8a36b87e716c4c42d5ff",
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
  },
  {
    label: "cutout-planet-gas-giant",
    url: "https://upload.wikimedia.org/wikipedia/commons/2/20/Blue_gas_giant.png",
    ext: ".png",
    width: 4000,
    height: 4000,
    split: "holdout",
    nonOpaqueFraction: 0.4301,
    softAlphaFraction: 0.1796,
    sha256: "16d9563712b9d7b42c548b64821d7f17f2913c5ed62c62086967394d5540183d",
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
  },
];

/**
 * Ensure every alpha fixture is present and content-pinned. A fetch failure or
 * digest mismatch throws — see `ensureNaturalImages` for why.
 *
 * @param split Fetch only this split's images. A tune sweep never reads the
 *   holdout images, and requiring them made every alpha sweep depend on the
 *   one holdout file Wikimedia Commons has since deleted
 *   (`cutout-wordmark-aflac`, removed 2026-08-25 as a copyright violation):
 *   the tune split stays reproducible, and a holdout run still fails loudly
 *   rather than scoring a smaller corpus.
 */
export async function ensureAlphaImages(
  split?: CorpusSplit,
): Promise<string[]> {
  await fs.mkdir(ALPHA_DIR, { recursive: true });
  const paths: string[] = [];
  let downloaded = 0;
  for (const spec of ALPHA_IMAGES) {
    if (split !== undefined && spec.split !== split) continue;
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
  return paths;
}
