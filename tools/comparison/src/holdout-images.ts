import fs from "node:fs/promises";
import path from "node:path";
import { ensurePinnedFixture } from "./corpus-pin.ts";

const HOLDOUT_DIR = path.resolve(import.meta.dirname, "../fixtures/holdout");

/** Number of images in the Kodak True Color suite (kodim01 … kodim24). */
const KODAK_COUNT = 24;

/**
 * SHA-256 of each `kodim<NN>.png` as served by r0k.us, indexed 0-based
 * (`KODAK_SHA256[0]` pins kodim01). The suite is byte-stable — the same PNGs
 * have been at the same URL since 1999 — so a mismatch means the mirror
 * changed, not that the corpus did; either way the run must stop rather than
 * score against different pixels (see corpus-pin.ts).
 */
export const KODAK_SHA256: readonly string[] = [
  "a56e27cbf5f843c048b6af1d6e090760e9c92fadba88b7dee0205918a37523bd", // kodak01
  "4f4b74a79237e311d72cad958237b5f7088d8bce1c82305ebefe1a70e3022dfd", // kodak02
  "e25ca1ff2f0c0cb5fdfd5f9b0a0bb21ac4c3de3c84a67f35b09a85d3306249db", // kodak03
  "e3b946107c5d3441c022f678d0c3caf1e224d81b1604ba840a4f88e562de61aa", // kodak04
  "10349e963c5c813d327852f82c1795fa4148d69fedffc4c589bee458e3ac3d53", // kodak05
  "363510303b715d4cbc384e1ce227e466b613a09e1b71ae985882bf8e7fbd9b18", // kodak06
  "b77d3f006f42414bb242222e0482e750c0fb9e5ee8d4bed2f6f11c5605fe54a4", // kodak07
  "ba23983c76b4832ee0e8af0592664756841a16779acd69f792e268fb6d13d6e7", // kodak08
  "6a4361c2fc194feb4edaa9f9a4a0620fb9943e460ac7fdf037fb0f6dd6607a7d", // kodak09
  "9dfb70f5867c29ff9ed6313683f19b3d867849e40fbc0c4c54a4a89df341cf23", // kodak10
  "7936814b58b5387fce2e4e2488b4ec830dadd95fa9520f358ddb30990b50f2b6", // kodak11
  "d78c37c2f04f23761ed2367dd77e2db584ddd4c3950833fecf89f199a8126980", // kodak12
  "bc34a3ce58dea09dce1704c997171602de90cb34d0c8503a988b77f473d39b08", // kodak13
  "55a94550ff18f3246c4074fd32b77b0c74447c26b6ad274d564d999c0450ba6e", // kodak14
  "7538cbb80cb9103606c48b806eae57d56c885c7f90b9b3be70a41160f9cbb683", // kodak15
  "a89c7268ccd4718ba424a99fc4643c572cf692ca6eae887185ceb4e9f11d2e54", // kodak16
  "37afcc89fbdcb76d9518e04b2fc011027e2f4cd14b3b2f83cefd721641a47c5b", // kodak17
  "1a9258c365988961d87a0598725b609139c303ad48a5aad6c503c3b1a87849aa", // kodak18
  "b7450b264b1b0a411390d8931b112c27905a992520fc90569dc4b920aa32bbdc", // kodak19
  "3b46c71e3b92a563820ba32936be8330c586c41f938efd94be938386aae4328a", // kodak20
  "ac958597c82073f6bb65129c68f72b651db5b9efd82e11547d07350214bc268b", // kodak21
  "1cee58eb1f2d9c7ebb254d208a03c783ce6cf2c4d8c2cf45e235dd23b4ce1b29", // kodak22
  "e3111a2fd4da24af15d6459ef9eacfe54106b38e27b4a21821b75c3f5d2d5baf", // kodak23
  "1071c68372cc5a01435c2c225a5cf7d4bb803846ec08bb6b3d6721b156d7cb96", // kodak24
];

/**
 * Ensure the holdout images are downloaded, cached and content-pinned. The set
 * is the Kodak True Color suite: 24 uncompressed 768x512 / 512x768
 * photographs, free for unrestricted use and hosted at the same URL since
 * 1999 — a stable, well-known corpus no LQIP format's constants were tuned on.
 * (CLIC datasets were considered as an additional holdout source, but their
 * hosting URLs are unstable.) Labels are `kodak01` … `kodak24`; corpus.ts maps
 * every `kodak*` image to the "holdout" split, so sweeps never tune on them.
 *
 * Every file is verified against its declared SHA-256 whether it came from the
 * cache or from the network. A fetch failure or a digest mismatch throws — a
 * partial holdout split would silently move the validation mean the
 * pre-registered ≥3% rule is decided against.
 */
export async function ensureHoldoutImages(): Promise<string[]> {
  await fs.mkdir(HOLDOUT_DIR, { recursive: true });

  const paths: string[] = [];
  let downloadCount = 0;

  for (let i = 1; i <= KODAK_COUNT; i++) {
    const num = String(i).padStart(2, "0");
    const sha256 = KODAK_SHA256[i - 1];
    if (sha256 === undefined) {
      throw new Error(`no pinned digest for kodak${num}`);
    }
    const filePath = path.join(HOLDOUT_DIR, `kodak${num}.png`);
    const downloaded = await ensurePinnedFixture({
      filePath,
      // HTTPS first: r0k.us is the canonical home of the suite but is one
      // hobby server, and this was the only plain-HTTP fetch in the corpus.
      // The Wikimedia mirror is the fallback; the digest makes it safe.
      urls: [
        `https://r0k.us/graphics/kodak/kodak/kodim${num}.png`,
        `http://r0k.us/graphics/kodak/kodak/kodim${num}.png`,
      ],
      sha256,
      label: `kodak${num}`,
    });
    if (downloaded) downloadCount++;
    paths.push(filePath);
  }

  if (downloadCount > 0) {
    console.log(
      `Downloaded ${downloadCount} holdout image(s) to ${HOLDOUT_DIR}`,
    );
  }

  return paths;
}
