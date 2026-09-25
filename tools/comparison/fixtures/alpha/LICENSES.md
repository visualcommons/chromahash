# Alpha corpus — sources and licences

Images with meaningful transparency, used to measure the alpha-mode layout.
Every image is from Wikimedia Commons. Every one still in use is under a free
licence, and attribution below is per image, as the licences require. An entry
marked **withdrawn** is no longer available from its source and is never
fetched; its pin stays so the results that scored it still say what they
measured, and no licence is presented as holding for it.

These files are **not committed** — they are fetched on demand and content-pinned
by SHA-256 (`src/alpha-images.ts`, `src/corpus-pin.ts`). A pin mismatch is
fatal: the corpus a number was measured on is part of what the number means.

The holdout split is retired (#83): see `ALPHA_HOLDOUT_RETIRED` in
`src/alpha-images.ts`. Its images keep their declared split below.

**This file is generated.** Edit the table in `src/alpha-images.ts` and run
`mise run corpus:licenses`; `--check` fails when the two disagree.


24 images — 16 tune, 8 holdout; 1 withdrawn.

### `cutout-3d-star-greek`

- Source: <https://commons.wikimedia.org/wiki/File:3D_greek_star.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/ce/3D_greek_star.png>
- Author: Andrikkos
- License: CC BY-SA 3.0
- Dimensions: 827x852
- Split: tune
- Alpha: 74.0% non-opaque, 24.4% soft-edged
- Notes: 3D glossy star render with soft shading and mostly-transparent canvas.

### `cutout-3d-star-soviet`

- Source: <https://commons.wikimedia.org/wiki/File:3D_plastic_soviet_star.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/52/3D_plastic_soviet_star.png>
- Author: Andrikkos
- License: CC BY-SA 3.0
- Dimensions: 608x579
- Split: tune
- Alpha: 65.6% non-opaque, 0.0% soft-edged
- Notes: Small saturated 3D star; simple shape, high proportion of transparency.

### `cutout-app-icon-aptoide`

- Source: <https://commons.wikimedia.org/wiki/File:Aptoide_icon_2025.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/e/ef/Aptoide_icon_2025.png>
- Author: Aptoide
- License: Public domain
- Dimensions: 601x600
- Split: holdout
- Alpha: 11.8% non-opaque, 0.5% soft-edged
- Notes: Modern app icon; flat colour, rounded-square alpha mask.

### `cutout-bioart-astrocyte`

- Source: <https://commons.wikimedia.org/wiki/File:Astrocyte_(NIH_BioArt_40_-_627569).png>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/5b/Astrocyte_%28NIH_BioArt_40_-_627569%29.png>
- Author: Courtesy of NIAID Ryan Kissinger
- License: Public domain
- Dimensions: 1609x1395
- Split: tune
- Alpha: 88.5% non-opaque, 0.9% soft-edged
- Notes: Scientific illustration on transparency; thin branching structure, mostly transparent.

### `cutout-broccoli`

- Source: <https://commons.wikimedia.org/wiki/File:Broccoli.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f1/Broccoli.png>
- Author: Tiia Monto
- License: CC BY-SA 3.0
- Dimensions: 2261x1833
- Split: tune
- Alpha: 48.2% non-opaque, 1.3% soft-edged
- Notes: Highly fractal organic edge, the hardest kind of alpha boundary to approximate.

### `cutout-campaign-medal`

- Source: <https://commons.wikimedia.org/wiki/File:Afghanistan_Campaign_Medal.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/82/Afghanistan_Campaign_Medal.png>
- Author: Defense Logistics Agency
- License: Public domain
- Dimensions: 726x816
- Split: holdout
- Alpha: 45.3% non-opaque, 0.0% soft-edged
- Notes: Medal with ribbon: metallic detail plus fabric texture, narrow mostly-transparent frame.

### `cutout-cheeseburger`

- Source: <https://commons.wikimedia.org/wiki/File:Cheeseburger.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/11/Cheeseburger.png>
- Author: Renee Comet (photographer) - edited for transparent background by -download | sign!
- License: Public domain
- Dimensions: 2700x1800
- Split: tune
- Alpha: 44.9% non-opaque, 0.0% soft-edged
- Notes: Detailed food cutout; highly textured, colourful, large opaque area.

### `cutout-dod-seal`

- Source: <https://commons.wikimedia.org/wiki/File:Seal_of_the_United_States_Department_of_Defense_(2001%E2%80%932022).png>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/43/Seal_of_the_United_States_Department_of_Defense_%282001%E2%80%932022%29.png>
- Author: DOD
- License: Public domain
- Dimensions: 600x599
- Split: tune
- Alpha: 21.8% non-opaque, 0.6% soft-edged
- Notes: Circular seal: fine radial text and detail, hard circular alpha boundary.

### `cutout-dslr-camera`

- Source: <https://commons.wikimedia.org/wiki/File:Nikon_D90.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/3/3d/Nikon_D90.png>
- Author: Zacke82
- License: Public domain
- Dimensions: 800x719
- Split: holdout
- Alpha: 52.3% non-opaque, 0.6% soft-edged
- Notes: Product photo cutout of a DSLR body; detailed dark monochrome subject with hard-ish silhouette.

### `cutout-emblem-kscz`

- Source: <https://commons.wikimedia.org/wiki/File:Emblem_of_the_Communist_Party_of_Czechoslovakia_1948-1990.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/7a/Emblem_of_the_Communist_Party_of_Czechoslovakia_1948-1990.png>
- Author: Danrolo
- License: CC BY-SA 3.0
- Dimensions: 564x538
- Split: tune
- Alpha: 66.1% non-opaque, 0.0% soft-edged
- Notes: Two-colour flat emblem; mostly transparent, near-monochrome, simple shapes.

### `cutout-game-sprite-ship`

- Source: <https://commons.wikimedia.org/wiki/File:Galak-Z_art_-_ship_BULLDOZER.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/61/Galak-Z_art_-_ship_BULLDOZER.png>
- Author: Raj Joshi, Senior Producer & Studio Director for 17-BIT
- License: CC BY-SA 3.0
- Dimensions: 1344x708
- Split: tune
- Alpha: 67.9% non-opaque, 0.4% soft-edged
- Notes: Game sprite art: pixel/vector spaceship with hard alpha and saturated colour.

### `cutout-glassfish`

- Source: <https://commons.wikimedia.org/wiki/File:Agassiz%27s_glassfish_(Ambassis_agassizii)_isolated_2023-03-08.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/d9/Agassiz%27s_glassfish_%28Ambassis_agassizii%29_isolated_2023-03-08.png>
- Author: Pelagic
- License: CC BY-SA 4.0
- Dimensions: 2417x1461
- Split: holdout
- Alpha: 63.2% non-opaque, 9.9% soft-edged
- Notes: Isolated fish photo with translucent fins, i.e. genuinely soft partial alpha.

### `cutout-greek-vase-figure`

- Source: <https://commons.wikimedia.org/wiki/File:NAMA_Th%C3%A9s%C3%A9e_%26_taureau.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/8e/NAMA_Th%C3%A9s%C3%A9e_%26_taureau.png>
- Author: Unknown
- License: CC BY-SA 2.5
- Dimensions: 723x1748
- Split: tune
- Alpha: 51.8% non-opaque, 18.2% soft-edged
- Notes: Ancient artefact cutout; fine detail, warm two-tone palette.

### `cutout-green-dragon`

- Source: <https://commons.wikimedia.org/wiki/File:Little_Green_Dragon_-_looking_left_-_Museum_of_Asian_Art_of_Corfu.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/49/Little_Green_Dragon_-_looking_left_-_Museum_of_Asian_Art_of_Corfu.png>
- Author: User Piotrus; edited by user Jaybear
- License: CC BY-SA 3.0
- Dimensions: 2120x2760
- Split: tune
- Alpha: 53.6% non-opaque, 0.0% soft-edged
- Notes: Museum object cutout with an intricate perforated silhouette.

### `cutout-insignia-4id`

- Source: <https://commons.wikimedia.org/wiki/File:4th_Infantry_Division_SSI.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/d0/4th_Infantry_Division_SSI.png>
- Author: US Army
- License: Public domain
- Dimensions: 622x620
- Split: holdout
- Alpha: 46.4% non-opaque, 0.1% soft-edged
- Notes: Flat vector-style military patch; hard binary alpha, few flat colours.

### `cutout-lamp-glow`

- Source: <https://commons.wikimedia.org/wiki/File:LampOnGlow.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/e/eb/LampOnGlow.png>
- Author: Roman Dilo (Saroman)
- License: CC BY 3.0
- Dimensions: 1000x760
- Split: tune
- Alpha: 91.2% non-opaque, 29.3% soft-edged
- Notes: Lamp with a wide translucent glow, dominated by partial (soft) alpha rather than binary.

### `cutout-lineart-hoe`

- Source: <https://commons.wikimedia.org/wiki/File:Hoe_(PSF).png>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/65/Hoe_%28PSF%29.png>
- Author: Pearson Scott Foresman
- License: Public domain
- Dimensions: 2749x2483
- Split: tune
- Alpha: 72.9% non-opaque, 1.1% soft-edged
- Notes: Public-domain pen line art of a man hoeing a field; monochrome greyscale+alpha (LA), sparse strokes, ~73% transparent.

### `cutout-lineart-oinochoe`

- Source: <https://commons.wikimedia.org/wiki/File:Oinochoe_(PSF).png>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/b1/Oinochoe_%28PSF%29.png>
- Author: Pearson Scott Foresman
- License: Public domain
- Dimensions: 1255x2048
- Split: holdout
- Alpha: 43.0% non-opaque, 0.3% soft-edged
- Notes: Line-art vessel drawing; hatched shading, monochrome, mostly transparent.

### `cutout-navy-crest`

- Source: <https://commons.wikimedia.org/wiki/File:USS_Cole_DDG-67_Crest.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/9/97/USS_Cole_DDG-67_Crest.png>
- Author: A Member of the United States Armed Forces
- License: Public domain
- Dimensions: 892x1134
- Split: tune
- Alpha: 17.3% non-opaque, 0.0% soft-edged
- Notes: Heraldic crest, detailed multi-colour flat art with hard alpha.

### `cutout-nokia-soft-shadow`

- Source: <https://commons.wikimedia.org/wiki/File:Nokia_3410_(cutout_transparent_background_and_shadow).png>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/ae/Nokia_3410_%28cutout_transparent_background_and_shadow%29.png>
- Author: Erik Baas
- License: CC BY-SA 3.0
- Dimensions: 732x1554
- Split: tune
- Alpha: 22.4% non-opaque, 6.8% soft-edged
- Notes: Phone cutout that keeps a soft drop shadow, so a large area is partial alpha rather than binary.

### `cutout-planet-gas-giant`

- Source: <https://commons.wikimedia.org/wiki/File:Blue_gas_giant.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/20/Blue_gas_giant.png>
- Author: unnamed
- License: CC0
- Dimensions: 4000x4000
- Split: holdout
- Alpha: 43.0% non-opaque, 18.0% soft-edged
- Notes: Banded gas giant render; smooth low-detail interior, soft alpha rim.

### `cutout-planet-lava`

- Source: <https://commons.wikimedia.org/wiki/File:Lava_planet.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/70/Lava_planet.png>
- Author: Max
- License: CC BY-SA 3.0
- Dimensions: 2300x2300
- Split: tune
- Alpha: 39.1% non-opaque, 6.2% soft-edged
- Notes: Rendered planet with glowing soft-alpha atmosphere; dark body, high contrast.

### `cutout-road-sign`

- Source: <https://commons.wikimedia.org/wiki/File:%22Maryland_Welcomes_You_-_Enjoy_Your_Visit!%22_road_sign,_c._1999.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4a/%22Maryland_Welcomes_You_-_Enjoy_Your_Visit%21%22_road_sign%2C_c._1999.png>
- Author: State of Maryland, Maryland SHWA
- License: Public domain
- Dimensions: 1332x1509
- Split: tune
- Alpha: 15.3% non-opaque, 0.2% soft-edged
- Notes: Text-heavy road sign on transparency; flat colour, hard rectangular-ish alpha.

### `cutout-wordmark-aflac`

- Source: <https://commons.wikimedia.org/wiki/File:Aflac_logo.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/81/Aflac_logo.png>
- Author: Aflac
- Status: **withdrawn** — deleted from Wikimedia Commons on 2026-08-25 as a copyright violation (COM:CSD#F1); no archived copy (#83)
- License: none that holds. The upload claimed CC BY 4.0; the image is withdrawn, so that claim is not relied on, and the image is neither fetched nor redistributed.
- Dimensions: 3840x1227
- Split: holdout
- Alpha: 59.7% non-opaque, 0.8% soft-edged
- Notes: Wide wordmark logo: extreme aspect, monochrome, overwhelmingly transparent canvas.
