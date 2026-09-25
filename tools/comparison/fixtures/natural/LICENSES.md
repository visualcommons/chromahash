# Curated photographic corpus — sources and licences

Every image is from Wikimedia Commons under a free licence. Attribution below is
per image, as the licences require.

These files are **not committed** — they are fetched on demand and content-pinned
by SHA-256 (`src/natural-images.ts`, `src/corpus-pin.ts`). A pin mismatch is
fatal: the corpus a number was measured on is part of what the number means.

**This file is generated.** Edit the table in `src/natural-images.ts` and run
`mise run corpus:licenses`; `--check` fails when the two disagree.

**Splits.** `tune` is what constants are chosen on. `tune2` is the
photographic holdout retired as spent (#76): it informed a decision in every
round (`spec/EXPERIMENTS.md` §11.12), so it is tuning data now, together with
the Kodak24 suite (`src/holdout-images.ts`, not listed here). `holdout2`, if
any entry carries it, is the sealed holdout: no tool fetches it until
`spec/V0.8-DECISIONS.md` records the decision it answers as frozen.

**Axis** is the §9.1 corpus-audit axis the image was chosen to cover.
**Notes** are its covariates on the 512 px scoring reference: orientation,
mean CIELAB L\*, mean chroma C\*, and a Laplacian detail energy whose exact
formula was not recorded when these were measured.


39 images — 31 tune, 8 tune2.

### `chroma-black-and-white`

- Source: <https://commons.wikimedia.org/wiki/File%3ABlack_and_white_cat%E2%80%93IMG_6332_02.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/a8/Black_and_white_cat%E2%80%93IMG_6332_02.jpg>
- Author: Kızıl
- License: CC BY-SA 4.0
- Dimensions: 4157x2771
- Split: tune2
- Axis: the chroma floor: near-zero C*
- Notes: landscape, mean L* 40.1, mean C* 6.8, detail 9.85

### `chroma-glass-reinforcements`

- Source: <https://commons.wikimedia.org/wiki/File%3AGlass_reinforcements.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/1a/Glass_reinforcements.jpg>
- Author: Cjp24
- License: CC BY-SA 3.0
- Dimensions: 1523x1437
- Split: tune
- Axis: flat woven pattern
- Notes: landscape, mean L* 72.2, mean C* 6.6, detail 28.4

### `chroma-the-old-monochrome`

- Source: <https://commons.wikimedia.org/wiki/File%3AThe_old_in_monochrome%2C_Mary_street%2C_Gympie_-_panoramio.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/6e/The_old_in_monochrome%2C_Mary_street%2C_Gympie_-_panoramio.jpg>
- Author: Sue Allen
- License: CC BY-SA 3.0
- Dimensions: 2736x3648
- Split: tune
- Axis: the chroma floor: near-zero C*
- Notes: portrait, mean L* 46.2, mean C* 0, detail 24.56

### `chroma-windows-toronto-city`

- Source: <https://commons.wikimedia.org/wiki/File%3AWindows_of_Toronto_City_Hall_(Monochrome).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/b7/Windows_of_Toronto_City_Hall_%28Monochrome%29.jpg>
- Author: Maksim Sokolov (maxergon.com)
- License: CC BY-SA 4.0
- Dimensions: 6000x3885
- Split: tune
- Axis: the chroma floor: near-zero C*
- Notes: landscape, mean L* 27.7, mean C* 1.1, detail 39.81

### `natural-agraulis-vanillae-isla`

- Source: <https://commons.wikimedia.org/wiki/File%3AAgraulis_vanillae_at_Isla_Margarita.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/20/Agraulis_vanillae_at_Isla_Margarita.jpg>
- Author: Wilfredor
- License: CC0
- Dimensions: 4000x2705
- Split: tune
- Axis: extreme close detail
- Notes: landscape, mean L* 39.2, mean C* 21.9, detail 13.31

### `natural-andrew-jackson-state`

- Source: <https://commons.wikimedia.org/wiki/File%3AAndrew_Jackson_State_Office_Building%2C_Deaderick_Street_and_5th_Avenue%2C_Nashville%2C_TN_(54385251424).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/db/Andrew_Jackson_State_Office_Building%2C_Deaderick_Street_and_5th_Avenue%2C_Nashville%2C_TN_%2854385251424%29.jpg>
- Author: Warren LeMay from Chicago, IL, United States
- License: CC BY-SA 2.0
- Dimensions: 3914x5219
- Split: tune
- Axis: dense periodic man-made detail
- Notes: portrait, mean L* 61.7, mean C* 12.7, detail 47.25

### `natural-bird-cherry-ermine`

- Source: <https://commons.wikimedia.org/wiki/File%3ABird-cherry_ermine_moth_(Yponomeuta_evonymella)_caterpillars.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/50/Bird-cherry_ermine_moth_%28Yponomeuta_evonymella%29_caterpillars.jpg>
- Author: Charles J. Sharp
- License: CC BY-SA 4.0
- Dimensions: 5058x3372
- Split: tune
- Axis: fine fur/feather texture
- Notes: landscape, mean L* 21.6, mean C* 12.6, detail 19

### `natural-dish-meatloaf-served`

- Source: <https://commons.wikimedia.org/wiki/File%3ADish_of_meatloaf_served_on_a_white_plate_with_sauce_and_herbs_in_a_restaurant_setting.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/87/Dish_of_meatloaf_served_on_a_white_plate_with_sauce_and_herbs_in_a_restaurant_setting.jpg>
- Author: Shixart1985
- License: CC BY 2.0
- Dimensions: 5184x6912
- Split: tune
- Axis: close framing, saturated food
- Notes: portrait, mean L* 62.1, mean C* 9.6, detail 14.81

### `natural-egretta-thula-las`

- Source: <https://commons.wikimedia.org/wiki/File%3AEgretta_thula_at_Las_Gallinas_Wildlife_Ponds.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f9/Egretta_thula_at_Las_Gallinas_Wildlife_Ponds.jpg>
- Author: Frank Schulenburg
- License: CC BY-SA 3.0
- Dimensions: 2437x3159
- Split: tune2
- Axis: fine fur/feather texture
- Notes: portrait, mean L* 53, mean C* 13.9, detail 8.12

### `natural-fishing-the-coast`

- Source: <https://commons.wikimedia.org/wiki/File%3AFishing_on_the_coast_of_South_China_Sea%2C_Lang_Co%2C_Vietnam.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/3/3b/Fishing_on_the_coast_of_South_China_Sea%2C_Lang_Co%2C_Vietnam.jpg>
- Author: Vyacheslav Argenberg
- License: CC BY 4.0
- Dimensions: 3984x2656
- Split: tune
- Axis: outdoor daylight landscape
- Notes: landscape, mean L* 64.6, mean C* 8.3, detail 7.06

### `natural-forest-road-slavne`

- Source: <https://commons.wikimedia.org/wiki/File%3AForest_road_Slavne_2017_BW_G9.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/cc/Forest_road_Slavne_2017_BW_G9.jpg>
- Author: George Chernilevsky
- License: Public domain
- Dimensions: 4500x2850
- Split: tune
- Axis: outdoor daylight landscape
- Notes: landscape, mean L* 53.2, mean C* 0, detail 74.18

### `natural-hard-rock-cafe`

- Source: <https://commons.wikimedia.org/wiki/File%3AHard_Rock_Cafe_interior_(8348879216).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/be/Hard_Rock_Cafe_interior_%288348879216%29.jpg>
- Author: shankar s. from Dubai, united arab emirates
- License: CC BY 2.0
- Dimensions: 3296x2472
- Split: tune
- Axis: interior and mixed illuminants
- Notes: landscape, mean L* 12.6, mean C* 11.4, detail 12.83

### `natural-interior-cafe-commerce`

- Source: <https://commons.wikimedia.org/wiki/File%3AInterior%2C_Cafe_du_Commerce%2C_Paris_24_September_2016.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/c4/Interior%2C_Cafe_du_Commerce%2C_Paris_24_September_2016.jpg>
- Author: James Petts from London, England
- License: CC BY-SA 2.0
- Dimensions: 4608x3456
- Split: tune2
- Axis: interior and mixed illuminants
- Notes: landscape, mean L* 50.6, mean C* 9.7, detail 23.09

### `natural-landschaftsschutzgebiet-dwest-gen`

- Source: <https://commons.wikimedia.org/wiki/File%3ALandschaftsschutzgebiet_S%C3%BCdwest-R%C3%BCgen-Zudar_lub_2026-02-07_img26.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4f/Landschaftsschutzgebiet_S%C3%BCdwest-R%C3%BCgen-Zudar_lub_2026-02-07_img26.jpg>
- Author: Lukas Beck
- License: CC BY 4.0
- Dimensions: 4032x3024
- Split: tune2
- Axis: high-key framing, DC-dominated
- Notes: landscape, mean L* 66.4, mean C* 13.3, detail 40.79

### `natural-landschaftsschutzgebiet-volkspark-rehberge`

- Source: <https://commons.wikimedia.org/wiki/File%3ALandschaftsschutzgebiet_Volkspark_Rehberge_lub_2026-01-03_img02_snow.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/54/Landschaftsschutzgebiet_Volkspark_Rehberge_lub_2026-01-03_img02_snow.jpg>
- Author: Lukas Beck
- License: CC BY 4.0
- Dimensions: 4032x3024
- Split: tune
- Axis: high-key framing, DC-dominated
- Notes: landscape, mean L* 59.5, mean C* 3.1, detail 75.92

### `natural-lmen-umland`

- Source: <https://commons.wikimedia.org/wiki/File%3AD%C3%BClmen%2C_Umland_--_2014_--_7056.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/76/D%C3%BClmen%2C_Umland_--_2014_--_7056.jpg>
- Author: Dietmar Rabich
- License: CC BY-SA 4.0
- Dimensions: 5184x3456
- Split: tune
- Axis: outdoor daylight landscape
- Notes: landscape, mean L* 46.7, mean C* 11, detail 35.93

### `natural-mabrousha-cake-with`

- Source: <https://commons.wikimedia.org/wiki/File%3AMabrousha_cake_with_strawberry_jam_-_Home_baked_Middle_Eastern_dessert.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/d7/Mabrousha_cake_with_strawberry_jam_-_Home_baked_Middle_Eastern_dessert.jpg>
- Author: Hayan Alhasan
- License: CC BY-SA 4.0
- Dimensions: 3456x4608
- Split: tune2
- Axis: close framing, saturated food
- Notes: portrait, mean L* 47.7, mean C* 13.5, detail 35.72

### `natural-maidens-tower`

- Source: <https://commons.wikimedia.org/wiki/File%3AMaidens_Tower_(8394899124).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/6c/Maidens_Tower_%288394899124%29.jpg>
- Author: Jorge Láscar from Australia
- License: CC BY 2.0
- Dimensions: 4288x2848
- Split: tune
- Axis: interior and mixed illuminants
- Notes: landscape, mean L* 79.7, mean C* 8.3, detail 17.7

### `natural-mid-1920s-house`

- Source: <https://commons.wikimedia.org/wiki/File%3AMid-1920s_House%2C_Downtown_Fort_Lauderdale_Florida%2C_January_2018_-_Interior_-_Kitchen_02.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/7b/Mid-1920s_House%2C_Downtown_Fort_Lauderdale_Florida%2C_January_2018_-_Interior_-_Kitchen_02.jpg>
- Author: Infrogmation of New Orleans
- License: CC BY 2.0
- Dimensions: 5184x3888
- Split: tune
- Axis: interior illuminant
- Notes: landscape, mean L* 46.8, mean C* 18.3, detail 20.07

### `natural-nnov-shcherbinki-produce`

- Source: <https://commons.wikimedia.org/wiki/File%3ANNov-Shcherbinki-produce-vendors-C0469.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/b8/NNov-Shcherbinki-produce-vendors-C0469.jpg>
- Author: Vmenkov
- License: CC BY-SA 4.0
- Dimensions: 2048x1536
- Split: tune
- Axis: cluttered saturated scene
- Notes: landscape, mean L* 44.4, mean C* 15.2, detail 34.75

### `natural-nster-westdeutsche-lotterie`

- Source: <https://commons.wikimedia.org/wiki/File%3AM%C3%BCnster%2C_Westdeutsche_Lotterie_--_2014_--_3791.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/77/M%C3%BCnster%2C_Westdeutsche_Lotterie_--_2014_--_3791.jpg>
- Author: Dietmar Rabich
- License: CC BY-SA 4.0
- Dimensions: 3648x5472
- Split: tune
- Axis: dense periodic man-made detail
- Notes: portrait, mean L* 42.1, mean C* 9.2, detail 22.77

### `natural-nster-westdeutsche-lotterie-2`

- Source: <https://commons.wikimedia.org/wiki/File%3AM%C3%BCnster%2C_Westdeutsche_Lotterie%2C_Zentrale_--_2026_--_1521.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/9/91/M%C3%BCnster%2C_Westdeutsche_Lotterie%2C_Zentrale_--_2026_--_1521.jpg>
- Author: Dietmar Rabich
- License: CC BY-SA 4.0
- Dimensions: 7728x4347
- Split: tune
- Axis: dense periodic man-made detail
- Notes: landscape, mean L* 50.6, mean C* 7, detail 17.48

### `natural-obama-center-library`

- Source: <https://commons.wikimedia.org/wiki/File%3AObama_Center_library_interior_(President's_Reading_Room)_-_Chicago%2C_IL_-_June_2026.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/0/03/Obama_Center_library_interior_%28President%27s_Reading_Room%29_-_Chicago%2C_IL_-_June_2026.jpg>
- Author: AlphaBeta135
- License: CC BY 4.0
- Dimensions: 3444x2296
- Split: tune
- Axis: interior illuminant
- Notes: landscape, mean L* 25.2, mean C* 7.5, detail 7.41

### `natural-pike-place-market`

- Source: <https://commons.wikimedia.org/wiki/File%3APike_Place_Market_produce_vendor%2C_circa_1970s_(46728151995).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/1c/Pike_Place_Market_produce_vendor%2C_circa_1970s_%2846728151995%29.jpg>
- Author: Seattle Municipal Archives from Seattle, WA
- License: CC BY 2.0
- Dimensions: 3469x2298
- Split: tune
- Axis: cluttered saturated scene
- Notes: landscape, mean L* 34.1, mean C* 22.8, detail 13.27

### `natural-roof-tiles-packed`

- Source: <https://commons.wikimedia.org/wiki/File%3ARoof_tiles_packed_in_crate_1.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/b2/Roof_tiles_packed_in_crate_1.jpg>
- Author: W.carter
- License: CC BY-SA 4.0
- Dimensions: 4000x3000
- Split: tune
- Axis: dense periodic man-made detail
- Notes: landscape, mean L* 46, mean C* 46, detail 25.17

### `natural-studioarrangement-for-product`

- Source: <https://commons.wikimedia.org/wiki/File%3AStudioarrangement_for_product_photography_and_video_2296.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/5b/Studioarrangement_for_product_photography_and_video_2296.jpg>
- Author: Hubertl
- License: CC BY-SA 4.0
- Dimensions: 4374x2925
- Split: tune
- Axis: high-key framing, DC-dominated
- Notes: landscape, mean L* 43.3, mean C* 8.6, detail 13.96

### `natural-table-set-for`

- Source: <https://commons.wikimedia.org/wiki/File%3ATable_set_for_dining_in_a_modern_restaurant_interior_with_wooden_walls_and_elegant_decor.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/58/Table_set_for_dining_in_a_modern_restaurant_interior_with_wooden_walls_and_elegant_decor.jpg>
- Author: Shixart1985
- License: CC BY 2.0
- Dimensions: 4032x6048
- Split: tune2
- Axis: interior and mixed illuminants
- Notes: portrait, mean L* 51.8, mean C* 19.3, detail 14.53

### `natural-trees-rising-out`

- Source: <https://commons.wikimedia.org/wiki/File%3ATrees_rising_out_of_Cheow_Lan_Lake%2C_blue_sky%2C_eternal_summer_in_Surat_Thani_edited.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/d0/Trees_rising_out_of_Cheow_Lan_Lake%2C_blue_sky%2C_eternal_summer_in_Surat_Thani_edited.jpg>
- Author: Original: Vyacheslav Argenberg Derivative work: The Cosmonaut
- License: CC BY 4.0
- Dimensions: 4032x2800
- Split: tune
- Axis: outdoor daylight landscape
- Notes: landscape, mean L* 56.4, mean C* 29, detail 14.12

### `natural-walnut-tart-close`

- Source: <https://commons.wikimedia.org/wiki/File%3AWalnut_tart_close-up_-_Aviv_(4714494928).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/cc/Walnut_tart_close-up_-_Aviv_%284714494928%29.jpg>
- Author: Alpha from Melbourne, Australia
- License: CC BY-SA 2.0
- Dimensions: 3872x2592
- Split: tune2
- Axis: close framing, saturated food
- Notes: landscape, mean L* 43.8, mean C* 44.4, detail 9.07

### `night-bas-lica-notre`

- Source: <https://commons.wikimedia.org/wiki/File%3ABas%C3%ADlica_de_Notre-Dame%2C_Montreal%2C_Canad%C3%A1%2C_2017-08-11%2C_DD_20-22_HDR.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/5d/Bas%C3%ADlica_de_Notre-Dame%2C_Montreal%2C_Canad%C3%A1%2C_2017-08-11%2C_DD_20-22_HDR.jpg>
- Author: Diego Delso
- License: CC BY-SA 4.0
- Dimensions: 4911x4549
- Split: tune
- Axis: low key, saturated artificial light
- Notes: landscape, mean L* 26.2, mean C* 27.2, detail 23.88

### `night-long-island-city`

- Source: <https://commons.wikimedia.org/wiki/File%3ALong_Island_City_New_York_May_2015_panorama_3.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/dd/Long_Island_City_New_York_May_2015_panorama_3.jpg>
- Author: King of Hearts
- License: CC BY-SA 3.0
- Dimensions: 8000x4000
- Split: tune
- Axis: low key, saturated artificial light
- Notes: landscape, mean L* 49.1, mean C* 27.9, detail 28.32

### `night-night-sky-milky`

- Source: <https://commons.wikimedia.org/wiki/File%3ANight-sky-milky-way-stars-hills_-_West_Virginia_-_ForestWander.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/13/Night-sky-milky-way-stars-hills_-_West_Virginia_-_ForestWander.jpg>
- Author: ForestWander
- License: CC BY-SA 3.0 us
- Dimensions: 5616x3744
- Split: tune
- Axis: low key, saturated artificial light
- Notes: landscape, mean L* 7.7, mean C* 1.9, detail 6.76

### `night-nster-liudgerhaus-und`

- Source: <https://commons.wikimedia.org/wiki/File%3AM%C3%BCnster%2C_Liudgerhaus_und_Di%C3%B6zesanbibliothek_--_2014_--_0303.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f7/M%C3%BCnster%2C_Liudgerhaus_und_Di%C3%B6zesanbibliothek_--_2014_--_0303.jpg>
- Author: Dietmar Rabich
- License: CC BY-SA 4.0
- Dimensions: 3601x5401
- Split: tune2
- Axis: low key, saturated artificial light
- Notes: portrait, mean L* 47.9, mean C* 10.5, detail 22.71

### `portrait-african-lady`

- Source: <https://commons.wikimedia.org/wiki/File%3AAn_African_Lady.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f7/An_African_Lady.jpg>
- Author: K15photos
- License: CC BY-SA 4.0
- Dimensions: 1668x2500
- Split: tune
- Axis: skin tone and portrait framing
- Notes: portrait, mean L* 63.5, mean C* 0, detail 28.33

### `portrait-african-woman-rusinga`

- Source: <https://commons.wikimedia.org/wiki/File%3AAfrican_woman_rusinga.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/ad/African_woman_rusinga.jpg>
- Author: Jeffmugendi
- License: CC BY-SA 4.0
- Dimensions: 4160x6240
- Split: tune
- Axis: skin tone and portrait framing
- Notes: portrait, mean L* 52.3, mean C* 16.1, detail 10.2

### `portrait-imene6`

- Source: <https://commons.wikimedia.org/wiki/File%3AImene6.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4d/Imene6.jpg>
- Author: Samia Dib Benkaci
- License: CC BY-SA 4.0
- Dimensions: 3456x5184
- Split: tune
- Axis: skin tone and portrait framing
- Notes: portrait, mean L* 23.7, mean C* 26.6, detail 13.15

### `portrait-mother-and-child`

- Source: <https://commons.wikimedia.org/wiki/File%3AMother_and_Child_II_(Imagicity_626).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/9/9a/Mother_and_Child_II_%28Imagicity_626%29.jpg>
- Author: Graham Crumb
- License: CC BY-SA 3.0
- Dimensions: 4288x2848
- Split: tune
- Axis: skin tone and portrait framing
- Notes: landscape, mean L* 59.5, mean C* 0, detail 11.4

### `portrait-portrait-femme-tenue`

- Source: <https://commons.wikimedia.org/wiki/File%3APortrait_de_femme_en_tenue_traditionnelle_de_Berb%C3%A8re_Alg%C3%A9rien.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/0/0a/Portrait_de_femme_en_tenue_traditionnelle_de_Berb%C3%A8re_Alg%C3%A9rien.jpg>
- Author: Samia Dib Benkaci
- License: CC BY-SA 4.0
- Dimensions: 3456x5184
- Split: tune
- Axis: skin tone and portrait framing
- Notes: portrait, mean L* 27.2, mean C* 0, detail 21.72

### `portrait-sideshow-bob-love`

- Source: <https://commons.wikimedia.org/wiki/File%3ASideshow_Bob's_Love_Child.%3F_(Imagicity_774).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/7a/Sideshow_Bob%27s_Love_Child.%3F_%28Imagicity_774%29.jpg>
- Author: Graham Crumb
- License: CC BY-SA 3.0
- Dimensions: 4288x2848
- Split: tune
- Axis: skin tone and portrait framing
- Notes: landscape, mean L* 50.6, mean C* 44.1, detail 17.64
