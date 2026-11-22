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
`holdout3` (#129), labelled `sealed3-*`, is the third sealed split, drawn on
covariates alone (`spec/EXPERIMENTS.md` §11.12) and opened the same way, once
per register entry; each of its entries lists the strata it sits in.

**Axis** is the §9.1 corpus-audit axis the image was chosen to cover.
**Notes** are its covariates on the upright 512 px scoring reference:
orientation, mean CIELAB L\*, mean chroma C\*, and a detail energy (mean
absolute 4-neighbour Laplacian of L\*), all measured by
`src/corpus-covariates.ts --files` (#102).


119 images — 31 tune, 8 tune2, 32 holdout2, 48 holdout3.

### `chroma-black-and-white`

- Source: <https://commons.wikimedia.org/wiki/File%3ABlack_and_white_cat%E2%80%93IMG_6332_02.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/a8/Black_and_white_cat%E2%80%93IMG_6332_02.jpg>
- Author: Kızıl
- License: CC BY-SA 4.0
- Dimensions: 4157x2771
- Split: tune2
- Axis: the chroma floor: near-zero C*
- Notes: landscape, mean L* 40, mean C* 6.9, detail 2.94

### `chroma-glass-reinforcements`

- Source: <https://commons.wikimedia.org/wiki/File%3AGlass_reinforcements.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/1a/Glass_reinforcements.jpg>
- Author: Cjp24
- License: CC BY-SA 3.0
- Dimensions: 1523x1437
- Split: tune
- Axis: flat woven pattern
- Notes: landscape, mean L* 72.4, mean C* 6.8, detail 8.49

### `chroma-the-old-monochrome`

- Source: <https://commons.wikimedia.org/wiki/File%3AThe_old_in_monochrome%2C_Mary_street%2C_Gympie_-_panoramio.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/6e/The_old_in_monochrome%2C_Mary_street%2C_Gympie_-_panoramio.jpg>
- Author: Sue Allen
- License: CC BY-SA 3.0
- Dimensions: 2736x3648
- Split: tune
- Axis: the chroma floor: near-zero C*
- Notes: portrait, mean L* 46.2, mean C* 0, detail 8.82

### `chroma-windows-toronto-city`

- Source: <https://commons.wikimedia.org/wiki/File%3AWindows_of_Toronto_City_Hall_(Monochrome).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/b7/Windows_of_Toronto_City_Hall_%28Monochrome%29.jpg>
- Author: Maksim Sokolov (maxergon.com)
- License: CC BY-SA 4.0
- Dimensions: 6000x3885
- Split: tune
- Axis: the chroma floor: near-zero C*
- Notes: landscape, mean L* 27.4, mean C* 1.2, detail 14.16

### `natural-agraulis-vanillae-isla`

- Source: <https://commons.wikimedia.org/wiki/File%3AAgraulis_vanillae_at_Isla_Margarita.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/20/Agraulis_vanillae_at_Isla_Margarita.jpg>
- Author: Wilfredor
- License: CC0
- Dimensions: 4000x2705
- Split: tune
- Axis: extreme close detail
- Notes: landscape, mean L* 39.2, mean C* 22, detail 4.04

### `natural-andrew-jackson-state`

- Source: <https://commons.wikimedia.org/wiki/File%3AAndrew_Jackson_State_Office_Building%2C_Deaderick_Street_and_5th_Avenue%2C_Nashville%2C_TN_(54385251424).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/db/Andrew_Jackson_State_Office_Building%2C_Deaderick_Street_and_5th_Avenue%2C_Nashville%2C_TN_%2854385251424%29.jpg>
- Author: Warren LeMay from Chicago, IL, United States
- License: CC BY-SA 2.0
- Dimensions: 3914x5219
- Split: tune
- Axis: dense periodic man-made detail
- Notes: portrait, mean L* 61.7, mean C* 12.8, detail 15.12

### `natural-bird-cherry-ermine`

- Source: <https://commons.wikimedia.org/wiki/File%3ABird-cherry_ermine_moth_(Yponomeuta_evonymella)_caterpillars.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/50/Bird-cherry_ermine_moth_%28Yponomeuta_evonymella%29_caterpillars.jpg>
- Author: Charles J. Sharp
- License: CC BY-SA 4.0
- Dimensions: 5058x3372
- Split: tune
- Axis: fine fur/feather texture
- Notes: landscape, mean L* 21.7, mean C* 12.8, detail 5.31

### `natural-dish-meatloaf-served`

- Source: <https://commons.wikimedia.org/wiki/File%3ADish_of_meatloaf_served_on_a_white_plate_with_sauce_and_herbs_in_a_restaurant_setting.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/87/Dish_of_meatloaf_served_on_a_white_plate_with_sauce_and_herbs_in_a_restaurant_setting.jpg>
- Author: Shixart1985
- License: CC BY 2.0
- Dimensions: 5184x6912
- Split: tune
- Axis: close framing, saturated food
- Notes: portrait, mean L* 62.2, mean C* 9.6, detail 5.01

### `natural-egretta-thula-las`

- Source: <https://commons.wikimedia.org/wiki/File%3AEgretta_thula_at_Las_Gallinas_Wildlife_Ponds.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f9/Egretta_thula_at_Las_Gallinas_Wildlife_Ponds.jpg>
- Author: Frank Schulenburg
- License: CC BY-SA 3.0
- Dimensions: 2437x3159
- Split: tune2
- Axis: fine fur/feather texture
- Notes: portrait, mean L* 53, mean C* 13.9, detail 2.66

### `natural-fishing-the-coast`

- Source: <https://commons.wikimedia.org/wiki/File%3AFishing_on_the_coast_of_South_China_Sea%2C_Lang_Co%2C_Vietnam.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/3/3b/Fishing_on_the_coast_of_South_China_Sea%2C_Lang_Co%2C_Vietnam.jpg>
- Author: Vyacheslav Argenberg
- License: CC BY 4.0
- Dimensions: 3984x2656
- Split: tune
- Axis: outdoor daylight landscape
- Notes: landscape, mean L* 64.7, mean C* 8.2, detail 1.99

### `natural-forest-road-slavne`

- Source: <https://commons.wikimedia.org/wiki/File%3AForest_road_Slavne_2017_BW_G9.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/cc/Forest_road_Slavne_2017_BW_G9.jpg>
- Author: George Chernilevsky
- License: Public domain
- Dimensions: 4500x2850
- Split: tune
- Axis: outdoor daylight landscape
- Notes: landscape, mean L* 53.1, mean C* 0, detail 21.83

### `natural-hard-rock-cafe`

- Source: <https://commons.wikimedia.org/wiki/File%3AHard_Rock_Cafe_interior_(8348879216).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/be/Hard_Rock_Cafe_interior_%288348879216%29.jpg>
- Author: shankar s. from Dubai, united arab emirates
- License: CC BY 2.0
- Dimensions: 3296x2472
- Split: tune
- Axis: interior and mixed illuminants
- Notes: landscape, mean L* 12.6, mean C* 11.4, detail 4.93

### `natural-interior-cafe-commerce`

- Source: <https://commons.wikimedia.org/wiki/File%3AInterior%2C_Cafe_du_Commerce%2C_Paris_24_September_2016.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/c4/Interior%2C_Cafe_du_Commerce%2C_Paris_24_September_2016.jpg>
- Author: James Petts from London, England
- License: CC BY-SA 2.0
- Dimensions: 4608x3456
- Split: tune2
- Axis: interior and mixed illuminants
- Notes: landscape, mean L* 50.6, mean C* 9.7, detail 9.14

### `natural-landschaftsschutzgebiet-dwest-gen`

- Source: <https://commons.wikimedia.org/wiki/File%3ALandschaftsschutzgebiet_S%C3%BCdwest-R%C3%BCgen-Zudar_lub_2026-02-07_img26.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4f/Landschaftsschutzgebiet_S%C3%BCdwest-R%C3%BCgen-Zudar_lub_2026-02-07_img26.jpg>
- Author: Lukas Beck
- License: CC BY 4.0
- Dimensions: 4032x3024
- Split: tune2
- Axis: high-key framing, DC-dominated
- Notes: landscape, mean L* 66.4, mean C* 13.5, detail 12.11

### `natural-landschaftsschutzgebiet-volkspark-rehberge`

- Source: <https://commons.wikimedia.org/wiki/File%3ALandschaftsschutzgebiet_Volkspark_Rehberge_lub_2026-01-03_img02_snow.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/54/Landschaftsschutzgebiet_Volkspark_Rehberge_lub_2026-01-03_img02_snow.jpg>
- Author: Lukas Beck
- License: CC BY 4.0
- Dimensions: 4032x3024
- Split: tune
- Axis: high-key framing, DC-dominated
- Notes: landscape, mean L* 59.6, mean C* 3.3, detail 22.11

### `natural-lmen-umland`

- Source: <https://commons.wikimedia.org/wiki/File%3AD%C3%BClmen%2C_Umland_--_2014_--_7056.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/76/D%C3%BClmen%2C_Umland_--_2014_--_7056.jpg>
- Author: Dietmar Rabich
- License: CC BY-SA 4.0
- Dimensions: 5184x3456
- Split: tune
- Axis: outdoor daylight landscape
- Notes: landscape, mean L* 46.5, mean C* 11.7, detail 10.58

### `natural-mabrousha-cake-with`

- Source: <https://commons.wikimedia.org/wiki/File%3AMabrousha_cake_with_strawberry_jam_-_Home_baked_Middle_Eastern_dessert.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/d7/Mabrousha_cake_with_strawberry_jam_-_Home_baked_Middle_Eastern_dessert.jpg>
- Author: Hayan Alhasan
- License: CC BY-SA 4.0
- Dimensions: 3456x4608
- Split: tune2
- Axis: close framing, saturated food
- Notes: portrait, mean L* 47.8, mean C* 13.5, detail 11.13

### `natural-maidens-tower`

- Source: <https://commons.wikimedia.org/wiki/File%3AMaidens_Tower_(8394899124).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/6c/Maidens_Tower_%288394899124%29.jpg>
- Author: Jorge Láscar from Australia
- License: CC BY 2.0
- Dimensions: 4288x2848
- Split: tune
- Axis: interior and mixed illuminants
- Notes: landscape, mean L* 79.7, mean C* 8.2, detail 4.72

### `natural-mid-1920s-house`

- Source: <https://commons.wikimedia.org/wiki/File%3AMid-1920s_House%2C_Downtown_Fort_Lauderdale_Florida%2C_January_2018_-_Interior_-_Kitchen_02.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/7b/Mid-1920s_House%2C_Downtown_Fort_Lauderdale_Florida%2C_January_2018_-_Interior_-_Kitchen_02.jpg>
- Author: Infrogmation of New Orleans
- License: CC BY 2.0
- Dimensions: 5184x3888
- Split: tune
- Axis: interior illuminant
- Notes: landscape, mean L* 46.8, mean C* 18.3, detail 5.69

### `natural-nnov-shcherbinki-produce`

- Source: <https://commons.wikimedia.org/wiki/File%3ANNov-Shcherbinki-produce-vendors-C0469.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/b8/NNov-Shcherbinki-produce-vendors-C0469.jpg>
- Author: Vmenkov
- License: CC BY-SA 4.0
- Dimensions: 2048x1536
- Split: tune
- Axis: cluttered saturated scene
- Notes: landscape, mean L* 44.6, mean C* 15.3, detail 10.92

### `natural-nster-westdeutsche-lotterie`

- Source: <https://commons.wikimedia.org/wiki/File%3AM%C3%BCnster%2C_Westdeutsche_Lotterie_--_2014_--_3791.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/77/M%C3%BCnster%2C_Westdeutsche_Lotterie_--_2014_--_3791.jpg>
- Author: Dietmar Rabich
- License: CC BY-SA 4.0
- Dimensions: 3648x5472
- Split: tune
- Axis: dense periodic man-made detail
- Notes: portrait, mean L* 42.2, mean C* 9.1, detail 7.87

### `natural-nster-westdeutsche-lotterie-2`

- Source: <https://commons.wikimedia.org/wiki/File%3AM%C3%BCnster%2C_Westdeutsche_Lotterie%2C_Zentrale_--_2026_--_1521.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/9/91/M%C3%BCnster%2C_Westdeutsche_Lotterie%2C_Zentrale_--_2026_--_1521.jpg>
- Author: Dietmar Rabich
- License: CC BY-SA 4.0
- Dimensions: 7728x4347
- Split: tune
- Axis: dense periodic man-made detail
- Notes: landscape, mean L* 50.6, mean C* 6.9, detail 5.64

### `natural-obama-center-library`

- Source: <https://commons.wikimedia.org/wiki/File%3AObama_Center_library_interior_(President's_Reading_Room)_-_Chicago%2C_IL_-_June_2026.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/0/03/Obama_Center_library_interior_%28President%27s_Reading_Room%29_-_Chicago%2C_IL_-_June_2026.jpg>
- Author: AlphaBeta135
- License: CC BY 4.0
- Dimensions: 3444x2296
- Split: tune
- Axis: interior illuminant
- Notes: landscape, mean L* 25.2, mean C* 7.6, detail 2.47

### `natural-pike-place-market`

- Source: <https://commons.wikimedia.org/wiki/File%3APike_Place_Market_produce_vendor%2C_circa_1970s_(46728151995).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/1c/Pike_Place_Market_produce_vendor%2C_circa_1970s_%2846728151995%29.jpg>
- Author: Seattle Municipal Archives from Seattle, WA
- License: CC BY 2.0
- Dimensions: 3469x2298
- Split: tune
- Axis: cluttered saturated scene
- Notes: landscape, mean L* 34.2, mean C* 22.9, detail 4.41

### `natural-roof-tiles-packed`

- Source: <https://commons.wikimedia.org/wiki/File%3ARoof_tiles_packed_in_crate_1.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/b2/Roof_tiles_packed_in_crate_1.jpg>
- Author: W.carter
- License: CC BY-SA 4.0
- Dimensions: 4000x3000
- Split: tune
- Axis: dense periodic man-made detail
- Notes: landscape, mean L* 46, mean C* 46.1, detail 8.11

### `natural-studioarrangement-for-product`

- Source: <https://commons.wikimedia.org/wiki/File%3AStudioarrangement_for_product_photography_and_video_2296.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/5b/Studioarrangement_for_product_photography_and_video_2296.jpg>
- Author: Hubertl
- License: CC BY-SA 4.0
- Dimensions: 4374x2925
- Split: tune
- Axis: high-key framing, DC-dominated
- Notes: landscape, mean L* 43.3, mean C* 8.6, detail 5.92

### `natural-table-set-for`

- Source: <https://commons.wikimedia.org/wiki/File%3ATable_set_for_dining_in_a_modern_restaurant_interior_with_wooden_walls_and_elegant_decor.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/58/Table_set_for_dining_in_a_modern_restaurant_interior_with_wooden_walls_and_elegant_decor.jpg>
- Author: Shixart1985
- License: CC BY 2.0
- Dimensions: 4032x6048
- Split: tune2
- Axis: interior and mixed illuminants
- Notes: portrait, mean L* 51.9, mean C* 19.3, detail 5.11

### `natural-trees-rising-out`

- Source: <https://commons.wikimedia.org/wiki/File%3ATrees_rising_out_of_Cheow_Lan_Lake%2C_blue_sky%2C_eternal_summer_in_Surat_Thani_edited.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/d0/Trees_rising_out_of_Cheow_Lan_Lake%2C_blue_sky%2C_eternal_summer_in_Surat_Thani_edited.jpg>
- Author: Original: Vyacheslav Argenberg Derivative work: The Cosmonaut
- License: CC BY 4.0
- Dimensions: 4032x2800
- Split: tune
- Axis: outdoor daylight landscape
- Notes: landscape, mean L* 56.4, mean C* 29, detail 3.99

### `natural-walnut-tart-close`

- Source: <https://commons.wikimedia.org/wiki/File%3AWalnut_tart_close-up_-_Aviv_(4714494928).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/cc/Walnut_tart_close-up_-_Aviv_%284714494928%29.jpg>
- Author: Alpha from Melbourne, Australia
- License: CC BY-SA 2.0
- Dimensions: 3872x2592
- Split: tune2
- Axis: close framing, saturated food
- Notes: landscape, mean L* 43.8, mean C* 44.5, detail 2.82

### `night-bas-lica-notre`

- Source: <https://commons.wikimedia.org/wiki/File%3ABas%C3%ADlica_de_Notre-Dame%2C_Montreal%2C_Canad%C3%A1%2C_2017-08-11%2C_DD_20-22_HDR.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/5d/Bas%C3%ADlica_de_Notre-Dame%2C_Montreal%2C_Canad%C3%A1%2C_2017-08-11%2C_DD_20-22_HDR.jpg>
- Author: Diego Delso
- License: CC BY-SA 4.0
- Dimensions: 4911x4549
- Split: tune
- Axis: low key, saturated artificial light
- Notes: landscape, mean L* 26.2, mean C* 27.4, detail 7.23

### `night-long-island-city`

- Source: <https://commons.wikimedia.org/wiki/File%3ALong_Island_City_New_York_May_2015_panorama_3.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/dd/Long_Island_City_New_York_May_2015_panorama_3.jpg>
- Author: King of Hearts
- License: CC BY-SA 3.0
- Dimensions: 8000x4000
- Split: tune
- Axis: low key, saturated artificial light
- Notes: landscape, mean L* 49.2, mean C* 28, detail 8.99

### `night-night-sky-milky`

- Source: <https://commons.wikimedia.org/wiki/File%3ANight-sky-milky-way-stars-hills_-_West_Virginia_-_ForestWander.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/13/Night-sky-milky-way-stars-hills_-_West_Virginia_-_ForestWander.jpg>
- Author: ForestWander
- License: CC BY-SA 3.0 us
- Dimensions: 5616x3744
- Split: tune
- Axis: low key, saturated artificial light
- Notes: landscape, mean L* 7.8, mean C* 1.9, detail 2.11

### `night-nster-liudgerhaus-und`

- Source: <https://commons.wikimedia.org/wiki/File%3AM%C3%BCnster%2C_Liudgerhaus_und_Di%C3%B6zesanbibliothek_--_2014_--_0303.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f7/M%C3%BCnster%2C_Liudgerhaus_und_Di%C3%B6zesanbibliothek_--_2014_--_0303.jpg>
- Author: Dietmar Rabich
- License: CC BY-SA 4.0
- Dimensions: 3601x5401
- Split: tune2
- Axis: low key, saturated artificial light
- Notes: portrait, mean L* 48, mean C* 10.4, detail 7.63

### `portrait-african-lady`

- Source: <https://commons.wikimedia.org/wiki/File%3AAn_African_Lady.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f7/An_African_Lady.jpg>
- Author: K15photos
- License: CC BY-SA 4.0
- Dimensions: 1668x2500
- Split: tune
- Axis: portrait framing; monochrome, so no skin chroma
- Notes: portrait, mean L* 63.4, mean C* 0, detail 10.54

### `portrait-african-woman-rusinga`

- Source: <https://commons.wikimedia.org/wiki/File%3AAfrican_woman_rusinga.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/ad/African_woman_rusinga.jpg>
- Author: Jeffmugendi
- License: CC BY-SA 4.0
- Dimensions: 4160x6240
- Split: tune
- Axis: skin tone and portrait framing
- Notes: portrait, mean L* 52.4, mean C* 16, detail 3.74

### `portrait-imene6`

- Source: <https://commons.wikimedia.org/wiki/File%3AImene6.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4d/Imene6.jpg>
- Author: Samia Dib Benkaci
- License: CC BY-SA 4.0
- Dimensions: 3456x5184
- Split: tune
- Axis: skin tone and portrait framing
- Notes: portrait, mean L* 23.7, mean C* 26.8, detail 4.58

### `portrait-mother-and-child`

- Source: <https://commons.wikimedia.org/wiki/File%3AMother_and_Child_II_(Imagicity_626).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/9/9a/Mother_and_Child_II_%28Imagicity_626%29.jpg>
- Author: Graham Crumb
- License: CC BY-SA 3.0
- Dimensions: 4288x2848
- Split: tune
- Axis: portrait framing; monochrome, so no skin chroma
- Notes: landscape, mean L* 59.5, mean C* 0, detail 3.56

### `portrait-portrait-femme-tenue`

- Source: <https://commons.wikimedia.org/wiki/File%3APortrait_de_femme_en_tenue_traditionnelle_de_Berb%C3%A8re_Alg%C3%A9rien.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/0/0a/Portrait_de_femme_en_tenue_traditionnelle_de_Berb%C3%A8re_Alg%C3%A9rien.jpg>
- Author: Samia Dib Benkaci
- License: CC BY-SA 4.0
- Dimensions: 3456x5184
- Split: tune
- Axis: portrait framing; monochrome, so no skin chroma
- Notes: portrait, mean L* 27.2, mean C* 0, detail 7.44

### `portrait-sideshow-bob-love`

- Source: <https://commons.wikimedia.org/wiki/File%3ASideshow_Bob's_Love_Child.%3F_(Imagicity_774).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/7a/Sideshow_Bob%27s_Love_Child.%3F_%28Imagicity_774%29.jpg>
- Author: Graham Crumb
- License: CC BY-SA 3.0
- Dimensions: 4288x2848
- Split: tune
- Axis: skin tone and portrait framing
- Notes: landscape, mean L* 50.6, mean C* 44.3, detail 5.33

### `sealed-chroma-canal-du-midi`

- Source: <https://commons.wikimedia.org/wiki/File%3ACanal_du_Midi,_Villeneuve-l%C3%A8s-B%C3%A9ziers_BW.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/bb/Canal_du_Midi%2C_Villeneuve-l%C3%A8s-B%C3%A9ziers_BW.jpg>
- Author: Christian Ferrer
- License: CC BY 4.0
- Dimensions: 7360x4145
- Split: holdout2
- Axis: the chroma floor: monochrome
- Notes: landscape, NIKON CORPORATION NIKON D810, mean L* 42.9, mean C* 0.0, detail 24.11

### `sealed-chroma-denis-mukwege-par`

- Source: <https://commons.wikimedia.org/wiki/File%3ADenis_Mukwege_par_Claude_Truong-Ngoc_novembre_2014.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/e/e1/Denis_Mukwege_par_Claude_Truong-Ngoc_novembre_2014.jpg>
- Author: Photo Claude TRUONG-NGOC
- License: CC BY-SA 3.0
- Dimensions: 3840x5760
- Split: holdout2
- Axis: the chroma floor: monochrome
- Notes: portrait, Canon Canon EOS 5D Mark III, mean L* 23.8, mean C* 0.0, detail 4.33

### `sealed-chroma-valle-de-pineta`

- Source: <https://commons.wikimedia.org/wiki/File%3AValle_de_Pineta_02.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/82/Valle_de_Pineta_02.jpg>
- Author: Basotxerri
- License: CC BY-SA 4.0
- Dimensions: 4592x3448
- Split: holdout2
- Axis: the chroma floor: monochrome
- Notes: landscape, Panasonic DMC-GM1, mean L* 27.1, mean C* 0.0, detail 8.58

### `sealed-chroma-wandeltocht-rond-lago`

- Source: <https://commons.wikimedia.org/wiki/File%3AWandeltocht_rond_Lago_di_Pian_Pal%C3%B9_(1800_m)._in_het_Nationaal_park_Stelvio_(Itali%C3%AB)._Kolkend_water_op_weg_naar_Lago_di_Pian_Pal%C3%B9.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/64/Wandeltocht_rond_Lago_di_Pian_Pal%C3%B9_%281800_m%29._in_het_Nationaal_park_Stelvio_%28Itali%C3%AB%29._Kolkend_water_op_weg_naar_Lago_di_Pian_Pal%C3%B9.jpg>
- Author: Dominicus Johannes Bergsma
- License: CC BY-SA 4.0
- Dimensions: 5184x3456
- Split: holdout2
- Axis: the chroma floor: monochrome
- Notes: landscape, Canon Canon EOS M, mean L* 46.3, mean C* 0.0, detail 9.82

### `sealed-highkey-arctic-camping-in`

- Source: <https://commons.wikimedia.org/wiki/File%3AArctic_camping_in_the_snow_(52828251185).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/24/Arctic_camping_in_the_snow_%2852828251185%29.jpg>
- Author: USFWSAlaska
- License: Public domain
- Dimensions: 8025x5353
- Split: holdout2
- Axis: high key
- Notes: landscape, Canon Canon EOS R5, mean L* 83.4, mean C* 8.7, detail 7.12

### `sealed-highkey-fanal-madeira-portugal`

- Source: <https://commons.wikimedia.org/wiki/File%3AFanal_(Madeira,_Portugal),_Lorbeerwald_--_2025_--_1540_(high_key).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/c2/Fanal_%28Madeira%2C_Portugal%29%2C_Lorbeerwald_--_2025_--_1540_%28high_key%29.jpg>
- Author: Dietmar Rabich
- License: CC BY-SA 4.0
- Dimensions: 6434x3619
- Split: holdout2
- Axis: high key
- Notes: landscape, Canon Canon EOS 5D Mark IV, mean L* 83.1, mean C* 6.8, detail 3.76

### `sealed-highkey-forks-isolated-on`

- Source: <https://commons.wikimedia.org/wiki/File%3AForks_isolated_on_white_background_02.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4c/Forks_isolated_on_white_background_02.jpg>
- Author: Jonatan Svensson Glad
- License: CC BY-SA 4.0
- Dimensions: 5568x3712
- Split: holdout2
- Axis: high key
- Notes: landscape, NIKON CORPORATION NIKON D500, mean L* 95.5, mean C* 0.7, detail 0.65

### `sealed-highkey-the-shops-at`

- Source: <https://commons.wikimedia.org/wiki/File%3AThe_Shops_at_Midtown_Miami,_Miami,_United_States_(Unsplash).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/6c/The_Shops_at_Midtown_Miami%2C_Miami%2C_United_States_%28Unsplash%29.jpg>
- Author: William Stitt willpower
- License: CC0
- Dimensions: 5184x3456
- Split: holdout2
- Axis: high key
- Notes: landscape, Canon Canon EOS REBEL T5i, mean L* 81.3, mean C* 4.4, detail 5.86

### `sealed-interior-candleroom-in-serbian`

- Source: <https://commons.wikimedia.org/wiki/File%3ACandleroom_in_Serbian_orthodox_church_in_Ljubljana,_Slovenia.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/e/e7/Candleroom_in_Serbian_orthodox_church_in_Ljubljana%2C_Slovenia.jpg>
- Author: Petar Milošević
- License: CC BY-SA 4.0
- Dimensions: 4232x3136
- Split: holdout2
- Axis: warm artificial interior light
- Notes: landscape, Panasonic DMC-G80, mean L* 18.3, mean C* 21.5, detail 3.45

### `sealed-interior-grits-bar-interior`

- Source: <https://commons.wikimedia.org/wiki/File%3AGrits_Bar_Interior_New_Orleans_Jim_Beam.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/82/Grits_Bar_Interior_New_Orleans_Jim_Beam.jpg>
- Author: Infrogmation of New Orleans
- License: CC BY-SA 2.0
- Dimensions: 4000x3000
- Split: holdout2
- Axis: warm artificial interior light
- Notes: landscape, Canon Canon PowerShot SD1300 IS, mean L* 13.7, mean C* 13.7, detail 3.44

### `sealed-interior-interior-of-restaurant`

- Source: <https://commons.wikimedia.org/wiki/File%3AInterior_of_restaurant_Santa_Clara_on_an_evening_in_October_2024.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4a/Interior_of_restaurant_Santa_Clara_on_an_evening_in_October_2024.jpg>
- Author: JIP
- License: CC BY-SA 4.0
- Dimensions: 4608x3456
- Split: holdout2
- Axis: warm artificial interior light
- Notes: landscape, OLYMPUS IMAGING CORP. E-M1, mean L* 36.1, mean C* 16.7, detail 5.01

### `sealed-interior-the-mind-palace`

- Source: <https://commons.wikimedia.org/wiki/File%3AThe_Mind_Palace_Bar_Interior.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/11/The_Mind_Palace_Bar_Interior.jpg>
- Author: Sherlock: Escape Rooms
- License: CC0
- Dimensions: 7443x5504
- Split: holdout2
- Axis: warm artificial interior light
- Notes: landscape, NIKON CORPORATION NIKON D850, mean L* 29.1, mean C* 19.6, detail 13.89

### `sealed-natural-red-route-trail`

- Source: <https://commons.wikimedia.org/wiki/File%3ARed_Route_trail,_Bedgebury_Forest_-_geograph.org.uk_-_5089200.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/23/Red_Route_trail%2C_Bedgebury_Forest_-_geograph.org.uk_-_5089200.jpg>
- Author: Oast House Archive
- License: CC BY-SA 2.0
- Dimensions: 3000x4000
- Split: holdout2
- Axis: daylight outdoor
- Notes: portrait, Canon Canon PowerShot S120, mean L* 43.4, mean C* 19.5, detail 8.47

### `sealed-natural-santa-pola`

- Source: <https://commons.wikimedia.org/wiki/File%3ASanta_Pola_14.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/0/0e/Santa_Pola_14.jpg>
- Author: TijsB from Utrecht, The Netherlands
- License: CC BY-SA 2.0
- Dimensions: 4000x3000
- Split: holdout2
- Axis: daylight outdoor
- Notes: landscape, Canon Canon PowerShot SX280 HS, mean L* 50.2, mean C* 16.3, detail 8.25

### `sealed-night-christmas-lights-in`

- Source: <https://commons.wikimedia.org/wiki/File%3AChristmas_lights_in_Carnaby_Street,_London,_2022.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/e/e3/Christmas_lights_in_Carnaby_Street%2C_London%2C_2022.jpg>
- Author: The wub
- License: CC BY-SA 4.0
- Dimensions: 4032x3024
- Split: holdout2
- Axis: night, saturated artificial light
- Notes: landscape, Google Pixel 4a, mean L* 17.3, mean C* 23.7, detail 10.25

### `sealed-night-neon-signs-at`

- Source: <https://commons.wikimedia.org/wiki/File%3ANeon_signs_at_night,_24th_October_2014.JPG>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/8e/Neon_signs_at_night%2C_24th_October_2014.JPG>
- Author: Tokumeigakarinoaoshima
- License: CC0
- Dimensions: 2512x1824
- Split: holdout2
- Axis: night, saturated artificial light
- Notes: landscape, Apple iPad Air, mean L* 23.7, mean C* 23.6, detail 10.92

### `sealed-night-save-on-meats`

- Source: <https://commons.wikimedia.org/wiki/File%3ASave-On_Meats_-_Some_Pig_-_Night_Neon_on_Hastings,_Vancouver.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/78/Save-On_Meats_-_Some_Pig_-_Night_Neon_on_Hastings%2C_Vancouver.jpg>
- Author: Mike W.
- License: CC BY-SA 2.0
- Dimensions: 2560x1920
- Split: holdout2
- Axis: night, saturated artificial light
- Notes: landscape, PENTAX Corporation PENTAX Optio WP, mean L* 21.6, mean C* 36.4, detail 3.96

### `sealed-phone-aamsveenherfst`

- Source: <https://commons.wikimedia.org/wiki/File%3AAamsveenHerfst.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/0/07/AamsveenHerfst.jpg>
- Author: Pdreijnders
- License: CC BY-SA 3.0
- Dimensions: 2592x1936
- Split: holdout2
- Axis: smartphone source
- Notes: landscape, Apple iPhone 4, mean L* 58.2, mean C* 31.5, detail 7.32

### `sealed-phone-april-at-keukenhof`

- Source: <https://commons.wikimedia.org/wiki/File%3A15_April_at_Keukenhof,_Lisse_(2022)_421.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f5/15_April_at_Keukenhof%2C_Lisse_%282022%29_421.jpg>
- Author: Donald Trung Quoc Don (Chữ Hán: 徵國單) - Wikimedia Commons - ©
- License: CC BY-SA 4.0
- Dimensions: 4032x2268
- Split: holdout2
- Axis: smartphone source
- Notes: landscape, Google Pixel 4a, mean L* 49.4, mean C* 46.5, detail 16.81

### `sealed-phone-citrus-swallowtail-papilio`

- Source: <https://commons.wikimedia.org/wiki/File%3ACitrus_Swallowtail_Papilio_Demodocus_Butterfly.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f5/Citrus_Swallowtail_Papilio_Demodocus_Butterfly.jpg>
- Author: Danesman1
- License: CC BY-SA 3.0
- Dimensions: 3264x2448
- Split: holdout2
- Axis: smartphone source
- Notes: landscape, SAMSUNG GT-I9300, mean L* 41.3, mean C* 19.7, detail 8.24

### `sealed-phone-ger-by-munchen`

- Source: <https://commons.wikimedia.org/wiki/File%3AGER_%E2%80%94_BY_%E2%80%94_M%C3%BCnchen_%E2%80%94_Stadtbezirk_1_%E2%80%94_Altstadt_%E2%80%94_Viktualienmarkt_8_(F._S._Kustermann_GmbH_%E2%80%94_Warenpr%C3%A4sentation_Sieger_by_F%C3%BCrstenberg)_2017_Mattes.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/0/01/GER_%E2%80%94_BY_%E2%80%94_M%C3%BCnchen_%E2%80%94_Stadtbezirk_1_%E2%80%94_Altstadt_%E2%80%94_Viktualienmarkt_8_%28F._S._Kustermann_GmbH_%E2%80%94_Warenpr%C3%A4sentation_Sieger_by_F%C3%BCrstenberg%29_2017_Mattes.jpg>
- Author: User:Mattes
- License: CC BY 3.0
- Dimensions: 3264x1836
- Split: holdout2
- Axis: smartphone source
- Notes: landscape, samsung SM-G920F, mean L* 51.0, mean C* 19.3, detail 8.04

### `sealed-phone-love-stadium-livebeyond`

- Source: <https://commons.wikimedia.org/wiki/File%3A%3DLOVE_STADIUM_LIVE%E3%80%8CBeyond_%22KYUN%22%E2%99%A1%E3%80%8DMUFG%E3%82%B9%E3%82%BF%E3%82%B8%E3%82%A2%E3%83%A0_2026%E5%B9%B46%E6%9C%8821%E6%97%A5%E3%81%AE%E6%9D%B1%E4%BA%AC_202606211727_IMG_2649.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/3/3e/%3DLOVE_STADIUM_LIVE%E3%80%8CBeyond_%22KYUN%22%E2%99%A1%E3%80%8DMUFG%E3%82%B9%E3%82%BF%E3%82%B8%E3%82%A2%E3%83%A0_2026%E5%B9%B46%E6%9C%8821%E6%97%A5%E3%81%AE%E6%9D%B1%E4%BA%AC_202606211727_IMG_2649.jpg>
- Author: ウィ貴公子
- License: CC BY-SA 4.0
- Dimensions: 4032x3024
- Split: holdout2
- Axis: smartphone source
- Notes: landscape, Apple iPhone 12 Pro, mean L* 52.1, mean C* 8.0, detail 14.26

### `sealed-phone-morag-zamek`

- Source: <https://commons.wikimedia.org/wiki/File%3AMor%C4%85g_Zamek_16.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/3/39/Mor%C4%85g_Zamek_16.jpg>
- Author: Zala
- License: CC BY-SA 4.0
- Dimensions: 4000x3000
- Split: holdout2
- Axis: smartphone source
- Notes: landscape, samsung SM-G998B, mean L* 51.7, mean C* 18.9, detail 15.85

### `sealed-phone-sienkiewicza-street-in`

- Source: <https://commons.wikimedia.org/wiki/File%3A5_Sienkiewicza_Street_in_Prudnik,_2020.08.25_05.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/48/5_Sienkiewicza_Street_in_Prudnik%2C_2020.08.25_05.jpg>
- Author: Wlodek k1
- License: CC BY 3.0
- Dimensions: 3264x2448
- Split: holdout2
- Axis: smartphone source
- Notes: landscape, Xiaomi Redmi Note 8 Pro, mean L* 44.1, mean C* 20.4, detail 18.90

### `sealed-phone-silesian-insurgents-monument`

- Source: <https://commons.wikimedia.org/wiki/File%3A20230920_Silesian_Insurgents_Monument_Stara_Ligota_Katowice_08.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/26/20230920_Silesian_Insurgents_Monument_Stara_Ligota_Katowice_08.jpg>
- Author: Abraham
- License: CC BY-SA 4.0
- Dimensions: 3000x4000
- Split: holdout2
- Axis: smartphone source
- Notes: portrait, HUAWEI MAR-LX1A, mean L* 53.3, mean C* 8.4, detail 9.35

### `sealed-phone-zhytomyr-park-plants`

- Source: <https://commons.wikimedia.org/wiki/File%3A%D0%A8%D0%B0%D0%B4%D1%83%D0%B0%D1%80%D1%96%D0%B2%D1%81%D1%8C%D0%BA%D0%B8%D0%B9_%D0%BF%D0%B0%D1%80_%D0%96%D0%B8%D1%82%D0%BE%D0%BC%D0%B8%D1%80_%D1%80%D0%BE%D1%81%D0%BB%D0%B8%D0%BD%D0%B8_08.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/e/e0/%D0%A8%D0%B0%D0%B4%D1%83%D0%B0%D1%80%D1%96%D0%B2%D1%81%D1%8C%D0%BA%D0%B8%D0%B9_%D0%BF%D0%B0%D1%80_%D0%96%D0%B8%D1%82%D0%BE%D0%BC%D0%B8%D1%80_%D1%80%D0%BE%D1%81%D0%BB%D0%B8%D0%BD%D0%B8_08.jpg>
- Author: Letherian3
- License: CC BY-SA 4.0
- Dimensions: 3024x4032
- Split: holdout2
- Axis: smartphone source
- Notes: portrait, Apple iPhone 15 Pro Max, mean L* 54.5, mean C* 17.5, detail 5.08

### `sealed-portrait-ernest-nuamah-england`

- Source: <https://commons.wikimedia.org/wiki/File%3AErnest_Nuamah_England_v_Ghana_23_June_2026-113.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/24/Ernest_Nuamah_England_v_Ghana_23_June_2026-113.jpg>
- Author: Bryan Berlin
- License: CC BY-SA 4.0
- Dimensions: 3333x5000
- Split: holdout2
- Axis: skin tone: dark
- Notes: portrait, SONY ILCE-7M4, mean L* 60.6, mean C* 48.8, detail 3.88

### `sealed-portrait-jose-manuel-lucia`

- Source: <https://commons.wikimedia.org/wiki/File%3AJos%C3%A9_Manuel_Luc%C3%ADa_Meg%C3%ADas.JPG>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/a0/Jos%C3%A9_Manuel_Luc%C3%ADa_Meg%C3%ADas.JPG>
- Author: Jmlucia
- License: CC BY-SA 3.0
- Dimensions: 3264x2448
- Split: holdout2
- Axis: skin tone: light
- Notes: landscape, KONICA MINOLTA DiMAGE A200, mean L* 64.9, mean C* 13.3, detail 4.46

### `sealed-portrait-macharia-kamau-meets`

- Source: <https://commons.wikimedia.org/wiki/File%3AMacharia_Kamau_meets_with_communities_in_Papua_New_Guinea.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/83/Macharia_Kamau_meets_with_communities_in_Papua_New_Guinea.jpg>
- Author: Aliceclements
- License: CC BY-SA 4.0
- Dimensions: 4000x3000
- Split: holdout2
- Axis: skin tone: dark
- Notes: landscape, Canon Canon PowerShot G16, mean L* 51.6, mean C* 10.2, detail 3.88

### `sealed-portrait-portrait-of-an`

- Source: <https://commons.wikimedia.org/wiki/File%3APortrait_of_an_old_indian_woman_(25507743530).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/68/Portrait_of_an_old_indian_woman_%2825507743530%29.jpg>
- Author: Nithi Anand from Paris, France
- License: CC BY 2.0
- Dimensions: 3456x5184
- Split: holdout2
- Axis: skin tone: medium
- Notes: portrait, Canon Canon EOS 100D, mean L* 62.9, mean C* 35.2, detail 8.63

### `sealed-portrait-romina`

- Source: <https://commons.wikimedia.org/wiki/File%3ARomina_(35553361002).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/e/e4/Romina_%2835553361002%29.jpg>
- Author: Rodrigo Paredes from Ciudad Autónoma de Buenos Aires, Argent
- License: CC BY 2.0
- Dimensions: 3254x4881
- Split: holdout2
- Axis: skin tone: light
- Notes: portrait, Canon Canon EOS 6D, mean L* 66.8, mean C* 16.0, detail 1.71

### `sealed-portrait-woman-with-shawl`

- Source: <https://commons.wikimedia.org/wiki/File%3AWoman_with_Shawl_-_McLeod_Ganj_-_Himachal_Pradesh_-_India_(26810940675).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/70/Woman_with_Shawl_-_McLeod_Ganj_-_Himachal_Pradesh_-_India_%2826810940675%29.jpg>
- Author: Adam Jones from Kelowna, BC, Canada
- License: CC BY-SA 2.0
- Dimensions: 2736x3648
- Split: holdout2
- Axis: skin tone: medium
- Notes: portrait, SONY DSC-HX400V, mean L* 48.0, mean C* 17.3, detail 10.30

### `sealed3-chroma-ewe-sheep-black-and`

- Source: <https://commons.wikimedia.org/wiki/File:Ewe_sheep_black_and_white.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/56/Ewe_sheep_black_and_white.jpg>
- Author: George Gastin
- License: CC BY-SA 3.0
- Dimensions: 3037x2578
- Split: holdout3
- Axis: chroma floor
- Notes: landscape, NIKON CORPORATION NIKON D40X, mean L* 41.8, mean C* 0.0, detail 4.91
- Drawn as: chroma floor; strata: none

### `sealed3-chroma-morning-mist-lake-tinaroo`

- Source: <https://commons.wikimedia.org/wiki/File:Morning_mist_Lake_Tinaroo_Tinaroo_State_Forest_Atherton_Tableland_Queensland_1986_IMG_0016_(2).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/63/Morning_mist_Lake_Tinaroo_Tinaroo_State_Forest_Atherton_Tableland_Queensland_1986_IMG_0016_%282%29.jpg>
- Author: John Robert McPherson
- License: CC BY-SA 4.0
- Dimensions: 6533x4309
- Split: holdout3
- Axis: chroma floor
- Notes: landscape, Canon CanoScan 8800F, mean L* 40.8, mean C* 0.0, detail 3.05
- Drawn as: chroma floor; strata: none

### `sealed3-chroma-not-so-urban-morning`

- Source: <https://commons.wikimedia.org/wiki/File:Not_So_Urban_Morning_(251257351).jpeg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/69/Not_So_Urban_Morning_%28251257351%29.jpeg>
- Author: Nicu Buculei
- License: CC BY-SA 3.0
- Dimensions: 2048x1365
- Split: holdout3
- Axis: chroma floor
- Notes: landscape, Canon Canon EOS 6D, mean L* 64.7, mean C* 0.0, detail 3.91
- Drawn as: chroma floor; strata: none

### `sealed3-chroma-waltensburg-vuorz-panoramaweg-20`

- Source: <https://commons.wikimedia.org/wiki/File:Waltensburg-Vuorz._Panoramaweg._20-09-2025._(actm.)_39.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/e/ec/Waltensburg-Vuorz._Panoramaweg._20-09-2025._%28actm.%29_39.jpg>
- Author: Agnes Monkelbaan
- License: CC BY-SA 4.0
- Dimensions: 5143x2893
- Split: holdout3
- Axis: chroma floor
- Notes: landscape, Canon Canon EOS M, mean L* 53.1, mean C* 0.0, detail 7.66
- Drawn as: chroma floor; strata: none

### `sealed3-daylight-2024-09-28-a`

- Source: <https://commons.wikimedia.org/wiki/File:2024-09-28_A_view_from_the_hiking_trail_to_L%27Arche_de_Corte_06.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/60/2024-09-28_A_view_from_the_hiking_trail_to_L%27Arche_de_Corte_06.jpg>
- Author: Alexkom000
- License: CC BY 4.0
- Dimensions: 5484x3656
- Split: holdout3
- Axis: daylight
- Notes: landscape, SONY ILCE-7M3, mean L* 53.3, mean C* 25.1, detail 10.60
- Drawn as: daylight; strata: none

### `sealed3-daylight-iss067-e-152527-view`

- Source: <https://commons.wikimedia.org/wiki/File:ISS067-E-152527_-_View_of_Earth.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/63/ISS067-E-152527_-_View_of_Earth.jpg>
- Author: Earth Science and Remote Sensing Unit, Lyndon B. Johnson Space Center
- License: Public domain
- Dimensions: 5568x3712
- Split: holdout3
- Axis: daylight
- Notes: landscape, NIKON CORPORATION NIKON D5, mean L* 45.9, mean C* 6.0, detail 8.81
- Drawn as: daylight; strata: none

### `sealed3-daylight-summer-at-knole-park`

- Source: <https://commons.wikimedia.org/wiki/File:Summer_at_Knole_Park_-_geograph.org.uk_-_6856983.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/44/Summer_at_Knole_Park_-_geograph.org.uk_-_6856983.jpg>
- Author: Peter S
- License: CC BY-SA 2.0
- Dimensions: 4608x3456
- Split: holdout3
- Axis: daylight
- Notes: landscape, NIKON COOLPIX A10, mean L* 49.1, mean C* 22.4, detail 10.79
- Drawn as: daylight; strata: none

### `sealed3-daylight-summer-park-concert-4618857`

- Source: <https://commons.wikimedia.org/wiki/File:Summer_Park_Concert_(4618857).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/25/Summer_Park_Concert_%284618857%29.jpg>
- Author: U.S. Marine Corps photo by Cpl. Cristian Ricardo
- License: Public domain
- Dimensions: 3456x5184
- Split: holdout3
- Axis: daylight
- Notes: portrait, Canon Canon EOS-1D X, mean L* 80.3, mean C* 5.1, detail 2.70
- Drawn as: daylight; strata: none

### `sealed3-highkey-canon-ef-100mm-f2`

- Source: <https://commons.wikimedia.org/wiki/File:Canon_EF_100mm_F2.8_Macro_USM_n02.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/a2/Canon_EF_100mm_F2.8_Macro_USM_n02.jpg>
- Author: Marie-Lan Nguyen
- License: CC BY 2.5
- Dimensions: 3338x5000
- Split: holdout3
- Axis: high key
- Notes: portrait, NIKON CORPORATION NIKON D800E, mean L* 54.5, mean C* 1.0, detail 4.37
- Drawn as: high key; strata: none

### `sealed3-highkey-chaise-lounges-on-the`

- Source: <https://commons.wikimedia.org/wiki/File:Chaise_lounges_on_the_beautiful_tropical_beach_with_white_sand,_Bali,_Indonesia.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4b/Chaise_lounges_on_the_beautiful_tropical_beach_with_white_sand%2C_Bali%2C_Indonesia.jpg>
- Author: Artem Beliaikin
- License: CC BY 2.0
- Dimensions: 6000x4000
- Split: holdout3
- Axis: high key
- Notes: landscape, Canon Canon EOS 80D, mean L* 71.3, mean C* 19.3, detail 12.67
- Drawn as: high key; strata: none

### `sealed3-highkey-runcam-eagle-black-fpv`

- Source: <https://commons.wikimedia.org/wiki/File:Runcam_Eagle_black_FPV_camera_with_bracket.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/81/Runcam_Eagle_black_FPV_camera_with_bracket.jpg>
- Author: Lucasbosch
- License: CC BY-SA 3.0
- Dimensions: 3384x3087
- Split: holdout3
- Axis: high key
- Notes: landscape, Canon Canon EOS 6D, mean L* 62.7, mean C* 1.0, detail 3.85
- Drawn as: high key; strata: none

### `sealed3-highkey-white-sand-beach-galapagos`

- Source: <https://commons.wikimedia.org/wiki/File:White_Sand_Beach,_Galapagos_(50138582752).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/14/White_Sand_Beach%2C_Galapagos_%2850138582752%29.jpg>
- Author: kuhnmi
- License: CC BY 2.0
- Dimensions: 5979x3363
- Split: holdout3
- Axis: high key
- Notes: landscape, NIKON CORPORATION NIKON D7100, mean L* 84.6, mean C* 6.8, detail 2.28
- Drawn as: high key; strata: none

### `sealed3-lowlight-aurora-16067336322`

- Source: <https://commons.wikimedia.org/wiki/File:Aurora_-_16067336322.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/bf/Aurora_-_16067336322.jpg>
- Author: mmmavocado
- License: CC BY 2.0
- Dimensions: 5616x3744
- Split: holdout3
- Axis: low light
- Notes: landscape, Canon Canon EOS 5D Mark II, mean L* 8.0, mean C* 5.2, detail 1.29
- Drawn as: low light; strata: low-light

### `sealed3-lowlight-aurora-borealis-svolv-rgeita`

- Source: <https://commons.wikimedia.org/wiki/File:Aurora_Borealis_Svolv%C3%A6rgeita_001.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/13/Aurora_Borealis_Svolv%C3%A6rgeita_001.jpg>
- Author: Birgit Fostervold
- License: CC BY-SA 4.0
- Dimensions: 3204x2132
- Split: holdout3
- Axis: low light
- Notes: landscape, NIKON CORPORATION NIKON Z 6_2, mean L* 9.3, mean C* 5.8, detail 2.39
- Drawn as: low light; strata: low-light

### `sealed3-lowlight-fireworks-lugano-2011-3`

- Source: <https://commons.wikimedia.org/wiki/File:Fireworks_lugano_2011-3.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/d2/Fireworks_lugano_2011-3.jpg>
- Author: Philippe Moret
- License: CC BY-SA 4.0
- Dimensions: 1733x2600
- Split: holdout3
- Axis: low light
- Notes: portrait, Canon Canon EOS 400D DIGITAL, mean L* 32.8, mean C* 17.8, detail 6.26
- Drawn as: low light; strata: skin, low-light

### `sealed3-lowlight-freedom-250-national-memorial`

- Source: <https://commons.wikimedia.org/wiki/File:Freedom_250_National_Memorial_Day_Observance_-_An_Evening_of_Stories_of_Service_at_Memorial_Amphitheater_in_Arlington_National_Cemetery,_Virginia_on_May_25,_2026_-_73.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/7d/Freedom_250_National_Memorial_Day_Observance_-_An_Evening_of_Stories_of_Service_at_Memorial_Amphitheater_in_Arlington_National_Cemetery%2C_Virginia_on_May_25%2C_2026_-_73.jpg>
- Author: usarmyband
- License: CC BY 4.0
- Dimensions: 3679x5519
- Split: holdout3
- Axis: low light
- Notes: portrait, Canon Canon EOS R6m2, mean L* 26.0, mean C* 27.6, detail 2.86
- Drawn as: low light; strata: low-light

### `sealed3-lowlight-korea-yeosu-dolsan-bridge`

- Source: <https://commons.wikimedia.org/wiki/File:Korea-Yeosu-Dolsan_Bridge_at_night-01.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/ca/Korea-Yeosu-Dolsan_Bridge_at_night-01.jpg>
- Author: Doo-ho Kim from Seoul, Republic of Korea
- License: CC BY-SA 2.0
- Dimensions: 1917x2935
- Split: holdout3
- Axis: low light
- Notes: portrait, NIKON CORPORATION NIKON D70, mean L* 11.6, mean C* 10.0, detail 5.60
- Drawn as: low light; strata: low-light

### `sealed3-lowlight-pszczyna-train-station-by`

- Source: <https://commons.wikimedia.org/wiki/File:Pszczyna_train_station_by_night_(2).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/55/Pszczyna_train_station_by_night_%282%29.jpg>
- Author: Michał Bulsa
- License: CC0
- Dimensions: 4624x3472
- Split: holdout3
- Axis: low light
- Notes: landscape, Xiaomi 22021211RG, mean L* 21.2, mean C* 7.9, detail 7.63
- Drawn as: low light; strata: smartphone, skin, low-light

### `sealed3-lowlight-rishikesh-and-the-river`

- Source: <https://commons.wikimedia.org/wiki/File:Rishikesh_and_The_River_Ganga_at_Night_and_Illuminated_Janki_Bridge_07.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/0/0a/Rishikesh_and_The_River_Ganga_at_Night_and_Illuminated_Janki_Bridge_07.jpg>
- Author: Goutam1962
- License: CC BY-SA 4.0
- Dimensions: 3840x2160
- Split: holdout3
- Axis: low light
- Notes: landscape, Xiaomi Redmi Note 7 Pro, mean L* 24.1, mean C* 8.5, detail 5.37
- Drawn as: low light; strata: smartphone, low-light

### `sealed3-lowlight-south-train-station-at`

- Source: <https://commons.wikimedia.org/wiki/File:South_Train_Station_at_night,_2019.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/64/South_Train_Station_at_night%2C_2019.jpg>
- Author: Shum3rR
- License: CC BY-SA 4.0
- Dimensions: 5248x2952
- Split: holdout3
- Axis: low light
- Notes: landscape, Motorola XT1254, mean L* 26.5, mean C* 7.7, detail 7.42
- Drawn as: low light; strata: smartphone, low-light

### `sealed3-lowlight-watching-starry-sky-at`

- Source: <https://commons.wikimedia.org/wiki/File:Watching_Starry_Sky_at_Lake_Kasumigaura_at_Tsuchiura,_Japan_(56536614).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/ff/Watching_Starry_Sky_at_Lake_Kasumigaura_at_Tsuchiura%2C_Japan_%2856536614%29.jpg>
- Author: Chibi Medako
- License: CC BY 3.0
- Dimensions: 1363x2048
- Split: holdout3
- Axis: low light
- Notes: portrait, NIKON CORPORATION NIKON D700, mean L* 28.7, mean C* 48.8, detail 8.71
- Drawn as: low light; strata: low-light

### `sealed3-pano-miami-late-afternoon-skyline`

- Source: <https://commons.wikimedia.org/wiki/File:Miami_Late_Afternoon_Skyline_2026.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/56/Miami_Late_Afternoon_Skyline_2026.jpg>
- Author: Euthman
- License: CC BY 4.0
- Dimensions: 12869x3169
- Split: holdout3
- Axis: extreme aspect
- Notes: landscape, Apple iPhone 14 Pro, mean L* 62.2, mean C* 18.5, detail 14.33
- Drawn as: extreme aspect; strata: smartphone, extreme-aspect

### `sealed3-pano-panorama-of-the-interior`

- Source: <https://commons.wikimedia.org/wiki/File:Panorama_of_the_Interior_of_a_Piccadilly_Line_Train_(August_2023)_02.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/7/7e/Panorama_of_the_Interior_of_a_Piccadilly_Line_Train_%28August_2023%29_02.jpg>
- Author: DiscoA340
- License: CC BY-SA 4.0
- Dimensions: 17022x2800
- Split: holdout3
- Axis: extreme aspect
- Notes: landscape, Canon Canon EOS R10, mean L* 57.5, mean C* 12.9, detail 12.38
- Drawn as: extreme aspect; strata: extreme-aspect

### `sealed3-pano-panoramic-view-into-the`

- Source: <https://commons.wikimedia.org/wiki/File:Panoramic_view_into_the_Rh%C3%B4ne_valley_(14842361192).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/28/Panoramic_view_into_the_Rh%C3%B4ne_valley_%2814842361192%29.jpg>
- Author: Björn S...
- License: CC BY-SA 2.0
- Dimensions: 12483x2476
- Split: holdout3
- Axis: extreme aspect
- Notes: landscape, Canon Canon EOS 600D, mean L* 62.3, mean C* 13.9, detail 7.35
- Drawn as: extreme aspect; strata: extreme-aspect

### `sealed3-pano-phra-nang-beach-panorama`

- Source: <https://commons.wikimedia.org/wiki/File:Phra_Nang_beach_panorama_3.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/55/Phra_Nang_beach_panorama_3.jpg>
- Author: kallerna
- License: CC BY-SA 3.0
- Dimensions: 10870x2800
- Split: holdout3
- Axis: extreme aspect
- Notes: landscape, SONY DSLR-A700, mean L* 55.5, mean C* 17.7, detail 10.86
- Drawn as: extreme aspect; strata: extreme-aspect

### `sealed3-pano-singapore-night-time-skyline`

- Source: <https://commons.wikimedia.org/wiki/File:Singapore_Night_Time_Skyline_Panorama_(54212129482).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/82/Singapore_Night_Time_Skyline_Panorama_%2854212129482%29.jpg>
- Author: Mustang Joe
- License: CC0
- Dimensions: 8907x2844
- Split: holdout3
- Axis: extreme aspect
- Notes: landscape, NIKON CORPORATION NIKON D750, mean L* 15.7, mean C* 11.8, detail 9.26
- Drawn as: extreme aspect; strata: low-light, extreme-aspect

### `sealed3-pano-sta-cruz-sand-bar`

- Source: <https://commons.wikimedia.org/wiki/File:Sta._Cruz_Sand_Bar.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/a4/Sta._Cruz_Sand_Bar.jpg>
- Author: Aldous Mariano Cariño
- License: CC BY-SA 4.0
- Dimensions: 10013x2802
- Split: holdout3
- Axis: extreme aspect
- Notes: landscape, DJI FC3682, mean L* 42.2, mean C* 20.1, detail 8.72
- Drawn as: extreme aspect; strata: extreme-aspect

### `sealed3-pano-times-square-10147934665`

- Source: <https://commons.wikimedia.org/wiki/File:Times_Square_(10147934665).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4c/Times_Square_%2810147934665%29.jpg>
- Author: Andrew Napier
- License: CC BY 2.0
- Dimensions: 3613x1062
- Split: holdout3
- Axis: extreme aspect
- Notes: landscape, LGE Nexus 4, mean L* 36.1, mean C* 10.4, detail 13.83
- Drawn as: extreme aspect; strata: smartphone, skin, extreme-aspect

### `sealed3-pano-view-north-from-ben`

- Source: <https://commons.wikimedia.org/wiki/File:View_north_from_Ben_Lawers,_Scotland.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/c1/View_north_from_Ben_Lawers%2C_Scotland.jpg>
- Author: Michal Klajban
- License: CC BY-SA 4.0
- Dimensions: 21276x3143
- Split: holdout3
- Axis: extreme aspect
- Notes: landscape, Canon Canon EOS 6D, mean L* 49.3, mean C* 17.1, detail 7.68
- Drawn as: extreme aspect; strata: skin, extreme-aspect

### `sealed3-phone-00525355`

- Source: <https://commons.wikimedia.org/wiki/File:%CE%A3%CE%B9%CE%B4%CE%B7%CF%81%CE%BF%CE%B4%CF%81%CE%BF%CE%BC%CE%B9%CE%BA%CF%8C%CF%82_%CE%A3%CF%84%CE%B1%CE%B8%CE%BC%CF%8C%CF%82_%CE%92%CF%8C%CE%BB%CE%BF%CF%85.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/3/39/%CE%A3%CE%B9%CE%B4%CE%B7%CF%81%CE%BF%CE%B4%CF%81%CE%BF%CE%BC%CE%B9%CE%BA%CF%8C%CF%82_%CE%A3%CF%84%CE%B1%CE%B8%CE%BC%CF%8C%CF%82_%CE%92%CF%8C%CE%BB%CE%BF%CF%85.jpg>
- Author: PLAKLE
- License: CC BY-SA 4.0
- Dimensions: 3264x2448
- Split: holdout3
- Axis: smartphone
- Notes: landscape, Xiaomi Redmi Note 9 Pro, mean L* 57.8, mean C* 7.8, detail 8.09
- Drawn as: smartphone; strata: smartphone, skin

### `sealed3-phone-2018-american-athletic-conference`

- Source: <https://commons.wikimedia.org/wiki/File:2018_American_Athletic_Conference_Championship_Trophy_Presentation_(31199404377).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/84/2018_American_Athletic_Conference_Championship_Trophy_Presentation_%2831199404377%29.jpg>
- Author: elisfkc from Orlando, FL, United States
- License: CC BY-SA 2.0
- Dimensions: 4032x3024
- Split: holdout3
- Axis: smartphone
- Notes: landscape, Google Pixel 3, mean L* 40.2, mean C* 14.7, detail 19.53
- Drawn as: smartphone; strata: smartphone

### `sealed3-phone-aitana-madrid`

- Source: <https://commons.wikimedia.org/wiki/File:Aitana_Madrid.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/1e/Aitana_Madrid.jpg>
- Author: EddyLlrg
- License: CC BY-SA 4.0
- Dimensions: 2267x2934
- Split: holdout3
- Axis: smartphone
- Notes: portrait, Google Pixel 6, mean L* 27.0, mean C* 49.9, detail 4.44
- Drawn as: smartphone; strata: smartphone, low-light

### `sealed3-phone-arco-manuelino-de-abiul`

- Source: <https://commons.wikimedia.org/wiki/File:Arco_Manuelino_de_Abiul_em_2021.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/6c/Arco_Manuelino_de_Abiul_em_2021.jpg>
- Author: Threeohsix
- License: CC BY-SA 4.0
- Dimensions: 6936x9248
- Split: holdout3
- Axis: smartphone
- Notes: portrait, samsung SM-A525F, mean L* 44.3, mean C* 5.9, detail 10.18
- Drawn as: smartphone; strata: smartphone

### `sealed3-phone-clingmans-dome-panorama-at`

- Source: <https://commons.wikimedia.org/wiki/File:Clingmans_Dome_panorama_at_sunset_-_July_2019.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/3/3a/Clingmans_Dome_panorama_at_sunset_-_July_2019.jpg>
- Author: Nheyob
- License: CC BY-SA 4.0
- Dimensions: 16380x3796
- Split: holdout3
- Axis: smartphone
- Notes: landscape, Apple iPhone 8, mean L* 54.0, mean C* 11.7, detail 4.40
- Drawn as: smartphone; strata: smartphone, extreme-aspect

### `sealed3-phone-libreoffice-conference-2019-by`

- Source: <https://commons.wikimedia.org/wiki/File:LibreOffice_Conference_2019,_by_Ismael_Olea_011.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/c2/LibreOffice_Conference_2019%2C_by_Ismael_Olea_011.jpg>
- Author: Ismael Olea
- License: CC BY 4.0
- Dimensions: 4608x3456
- Split: holdout3
- Axis: smartphone
- Notes: landscape, motorola moto g(7) plus, mean L* 25.6, mean C* 17.9, detail 6.67
- Drawn as: smartphone; strata: smartphone, low-light

### `sealed3-phone-luxembourg-place-auguste-engel`

- Source: <https://commons.wikimedia.org/wiki/File:Luxembourg,_place_Auguste_Engel_(101).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/1a/Luxembourg%2C_place_Auguste_Engel_%28101%29.jpg>
- Author: GilPe
- License: CC BY-SA 3.0
- Dimensions: 3648x2736
- Split: holdout3
- Axis: smartphone
- Notes: landscape, HUAWEI LYA-L29, mean L* 52.1, mean C* 21.7, detail 18.93
- Drawn as: smartphone; strata: smartphone, skin

### `sealed3-phone-nagaoka-city-ojima-jr`

- Source: <https://commons.wikimedia.org/wiki/File:Nagaoka_City_Ojima_Jr_High_School_at_Gate_2019.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/ac/Nagaoka_City_Ojima_Jr_High_School_at_Gate_2019.jpg>
- Author: Rebirth10
- License: CC BY-SA 4.0
- Dimensions: 4618x3464
- Split: holdout3
- Axis: smartphone
- Notes: landscape, Sony D6603, mean L* 54.9, mean C* 4.7, detail 9.63
- Drawn as: smartphone; strata: smartphone

### `sealed3-phone-national-museum-of-anthropology`

- Source: <https://commons.wikimedia.org/wiki/File:National_Museum_of_Anthropology_-_wm2015_-_6.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/41/National_Museum_of_Anthropology_-_wm2015_-_6.jpg>
- Author: Benoît Prieur
- License: CC0
- Dimensions: 2832x2180
- Split: holdout3
- Axis: smartphone
- Notes: landscape, Apple iPhone 6, mean L* 37.4, mean C* 11.6, detail 14.43
- Drawn as: smartphone; strata: smartphone, skin

### `sealed3-phone-pvjlvlja-montenegro-33239`

- Source: <https://commons.wikimedia.org/wiki/File:Pvjlvlja_montenegro_(33239).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4d/Pvjlvlja_montenegro_%2833239%29.jpg>
- Author: Andre Hospers
- License: CC BY 4.0
- Dimensions: 4032x3024
- Split: holdout3
- Axis: smartphone
- Notes: landscape, samsung SM-G955F, mean L* 48.2, mean C* 20.2, detail 19.86
- Drawn as: smartphone; strata: smartphone

### `sealed3-skin-banana-vendor-uganda-15166221095`

- Source: <https://commons.wikimedia.org/wiki/File:Banana_Vendor,_Uganda_(15166221095).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/16/Banana_Vendor%2C_Uganda_%2815166221095%29.jpg>
- Author: Rod Waddington from Kergunyah, Australia
- License: CC BY-SA 2.0
- Dimensions: 4016x5670
- Split: holdout3
- Axis: skin: medium
- Notes: portrait, NIKON CORPORATION NIKON D600, mean L* 54.2, mean C* 32.9, detail 6.84
- Drawn as: skin: medium; strata: skin

### `sealed3-skin-domkirken-kristiansand-norway-nygotisk`

- Source: <https://commons.wikimedia.org/wiki/File:DOMKIRKEN_KRISTIANSAND_Norway_Nygotisk_korskirke_Thrap-Meyer_1885_Cathedral_Neo-Gothic_church_2023-10-18_INTERIOR_Alter_altertavle_av_Eilif_Peterssen_alterring_koret_Altar_piece_etc_IMG_3915.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/2b/DOMKIRKEN_KRISTIANSAND_Norway_Nygotisk_korskirke_Thrap-Meyer_1885_Cathedral_Neo-Gothic_church_2023-10-18_INTERIOR_Alter_altertavle_av_Eilif_Peterssen_alterring_koret_Altar_piece_etc_IMG_3915.jpg>
- Author: Wolfmann
- License: CC BY-SA 4.0
- Dimensions: 5619x7493
- Split: holdout3
- Axis: skin: light
- Notes: portrait, Apple iPhone 14 Pro, mean L* 50.7, mean C* 18.6, detail 7.98
- Drawn as: skin: light; strata: smartphone, skin

### `sealed3-skin-emmy-at-esc2025-for`

- Source: <https://commons.wikimedia.org/wiki/File:Emmy_at_ESC2025_for_Ireland_5.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/d7/Emmy_at_ESC2025_for_Ireland_5.jpg>
- Author: Quejaytee
- License: CC BY 4.0
- Dimensions: 4562x3650
- Split: holdout3
- Axis: skin: dark
- Notes: landscape, Canon Canon EOS R1, mean L* 31.6, mean C* 20.7, detail 6.13
- Drawn as: skin: dark; strata: skin

### `sealed3-skin-her-majesty`

- Source: <https://commons.wikimedia.org/wiki/File:Her_Majesty.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/d3/Her_Majesty.jpg>
- Author: Nikonambassug
- License: CC BY-SA 4.0
- Dimensions: 3744x5616
- Split: holdout3
- Axis: skin: light
- Notes: portrait, Canon Canon EOS 5D Mark II, mean L* 74.1, mean C* 15.4, detail 4.64
- Drawn as: skin: light; strata: skin

### `sealed3-skin-indonesia-traffic-signs-warning`

- Source: <https://commons.wikimedia.org/wiki/File:Indonesia_Traffic-signs_Warning-sign-07.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/62/Indonesia_Traffic-signs_Warning-sign-07.jpg>
- Author: CEphoto, Uwe Aranas
- License: CC BY-SA 3.0
- Dimensions: 3306x4278
- Split: holdout3
- Axis: skin: dark
- Notes: portrait, Canon Canon EOS 5D Mark III, mean L* 37.9, mean C* 24.3, detail 18.65
- Drawn as: skin: dark; strata: skin

### `sealed3-skin-mumtaz-alia-akbari-2`

- Source: <https://commons.wikimedia.org/wiki/File:Mumtaz_Alia_Akbari_2.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/c3/Mumtaz_Alia_Akbari_2.jpg>
- Author: Kazi Riton
- License: CC BY-SA 4.0
- Dimensions: 1488x2240
- Split: holdout3
- Axis: skin: light
- Notes: portrait, NIKON CORPORATION NIKON D100, mean L* 49.9, mean C* 15.5, detail 4.88
- Drawn as: skin: light; strata: skin

### `sealed3-skin-portrait-gallery-cafe-geograph`

- Source: <https://commons.wikimedia.org/wiki/File:Portrait_Gallery_caf%C3%A9_-_geograph.org.uk_-_7883755.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/0/08/Portrait_Gallery_caf%C3%A9_-_geograph.org.uk_-_7883755.jpg>
- Author: Anthony O'Neil
- License: CC BY-SA 2.0
- Dimensions: 5131x3256
- Split: holdout3
- Axis: skin: medium
- Notes: landscape, FUJIFILM X-Pro3, mean L* 43.4, mean C* 15.2, detail 7.03
- Drawn as: skin: medium; strata: skin

### `sealed3-skin-portrait-head-jar-peru`

- Source: <https://commons.wikimedia.org/wiki/File:Portrait_head_jar,_Peru,_Moche_IV_or_V,_north_coast,_c._500_AD,_earthenware_-_Krannert_Art_Museum,_UIUC_-_DSC06498.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/9/95/Portrait_head_jar%2C_Peru%2C_Moche_IV_or_V%2C_north_coast%2C_c._500_AD%2C_earthenware_-_Krannert_Art_Museum%2C_UIUC_-_DSC06498.jpg>
- Author: Daderot
- License: Public domain
- Dimensions: 3495x3178
- Split: holdout3
- Axis: skin: medium
- Notes: landscape, SONY DSC-RX100M3, mean L* 47.2, mean C* 25.9, detail 1.80
- Drawn as: skin: medium; strata: skin

### `sealed3-skin-washare-from-the-hamer`

- Source: <https://commons.wikimedia.org/wiki/File:Washare_from_the_Hamer_tribe_in_Logara,_near_Turmi,_Omo_Valley,_Ethiopia_(16882803797).jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/cc/Washare_from_the_Hamer_tribe_in_Logara%2C_near_Turmi%2C_Omo_Valley%2C_Ethiopia_%2816882803797%29.jpg>
- Author: Alfred Weidinger from Vienna, Austria
- License: CC BY 2.0
- Dimensions: 4992x7512
- Split: holdout3
- Axis: skin: dark
- Notes: portrait, Leica Camera AG Leica S2, mean L* 56.2, mean C* 17.4, detail 8.70
- Drawn as: skin: dark; strata: skin
