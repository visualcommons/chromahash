# Graphics corpus — sources and licences

Non-photographic content: screenshots, charts, diagrams, maps, line art and
text-heavy graphics. Every image is from Wikimedia Commons under a free
licence. Attribution below is per image, as the licences require.

These files are **not committed** — they are fetched on demand and content-pinned
by SHA-256 (`src/graphic-images.ts`, `src/corpus-pin.ts`). A pin mismatch is
fatal: the corpus a number was measured on is part of what the number means.

**This file is generated.** Edit the table in `src/graphic-images.ts` and run
`mise run corpus:licenses`; `--check` fails when the two disagree.


24 images — 16 tune, 8 holdout.

### `graphic-alphaplot-app`

- Source: <https://commons.wikimedia.org/wiki/File:Alphaplotscreenshot.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/40/Alphaplotscreenshot.png>
- Author: N.arun.lifescience
- License: CC BY-SA 4.0
- Dimensions: 1280x751
- Split: tune
- Notes: Scientific plotting application window: toolbars, spreadsheet grid and a plot.

### `graphic-bar-chart-waymo`

- Source: <https://commons.wikimedia.org/wiki/File:Bar_chart_of_Waymo_Passenger_Miles_Travelled_in_California.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f4/Bar_chart_of_Waymo_Passenger_Miles_Travelled_in_California.png>
- Author: WikiEwout
- License: CC BY-SA 4.0
- Dimensions: 3600x1800
- Split: tune
- Notes: Clean modern bar chart: large flat areas, thin axis rules, small text.

### `graphic-block-diagram-arch`

- Source: <https://commons.wikimedia.org/wiki/File:Computer_architecture_block_diagram.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/0/08/Computer_architecture_block_diagram.png>
- Author: Amila Ruwan 20
- License: CC BY-SA 4.0
- Dimensions: 5052x4540
- Split: holdout
- Notes: Large block diagram: boxes, arrows, flat fills and labels on white.

### `graphic-circuit-schematic`

- Source: <https://commons.wikimedia.org/wiki/File:74LS01_TI_8610_schematic.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/5/51/74LS01_TI_8610_schematic.png>
- Author: Robert.Baruch
- License: CC BY-SA 4.0
- Dimensions: 3508x2480
- Split: tune
- Notes: Monochrome circuit schematic: thin black lines on white, extremely sparse.

### `graphic-comic-strip-1940`

- Source: <https://commons.wikimedia.org/wiki/File:First_Chesty_Bond_comic_strip_TheSun_19Mar1940.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/c/c9/First_Chesty_Bond_comic_strip_TheSun_19Mar1940.jpg>
- Author: Syd Miller
- License: Public domain
- Dimensions: 2612x985
- Split: tune
- Notes: Newspaper comic strip scan: panelled ink line art with halftone and text.

### `graphic-comic-wiggle-much`

- Source: <https://commons.wikimedia.org/wiki/File:%22The_Wiggle_Much%22_Comic_Strip,_No._1_(published_in_The_New_York_Herald,_March_20,_1910)_MET_DP856515.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/26/%22The_Wiggle_Much%22_Comic_Strip%2C_No._1_%28published_in_The_New_York_Herald%2C_March_20%2C_1910%29_MET_DP856515.jpg>
- Author: Herbert Crowley
- License: CC0
- Dimensions: 3637x2263
- Split: holdout
- Notes: 1910 colour Sunday comic page: flat printed colour, ink outlines, lettering.

### `graphic-flat-design-desk`

- Source: <https://commons.wikimedia.org/wiki/File:Laptop-coffee-flat-design-by-david-mendoza.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/a0/Laptop-coffee-flat-design-by-david-mendoza.png>
- Author: Zombkid
- License: CC BY-SA 4.0
- Dimensions: 3002x2002
- Split: tune
- Notes: Flat-design vector illustration: large uniform colour fields, no gradients.

### `graphic-geonames-map`

- Source: <https://commons.wikimedia.org/wiki/File:Geonames_world_map_(6281371842).png>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/a8/Geonames_world_map_%286281371842%29.png>
- Author: Charlie Loyd from 94606, USA
- License: CC BY 2.0
- Dimensions: 7200x3600
- Split: tune
- Notes: Dot-density world map: fine stippled detail on a dark ground.

### `graphic-gnome-desktop`

- Source: <https://commons.wikimedia.org/wiki/File:Nyarch_Linux_GNOME_50_Desktop_Screenshot.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f3/Nyarch_Linux_GNOME_50_Desktop_Screenshot.png>
- Author: The GNOME Project and Nyarch Linux Developers
- License: CC BY 4.0
- Dimensions: 1920x1080
- Split: holdout
- Notes: Linux desktop screenshot: window chrome, icons and a photographic wallpaper.

### `graphic-infographic-timeline`

- Source: <https://commons.wikimedia.org/wiki/File:Constitutional_recognition_in_South_Africa_Timeline_Infographic.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/df/Constitutional_recognition_in_South_Africa_Timeline_Infographic.png>
- Author: Andrea Bauling
- License: CC BY-SA 4.0
- Dimensions: 788x865
- Split: tune
- Notes: Infographic timeline: flat colour blocks, icons and body text.

### `graphic-lineart-pictographs`

- Source: <https://commons.wikimedia.org/wiki/File:Pictographs_(PSF).png>
- File: <https://upload.wikimedia.org/wikipedia/commons/6/6f/Pictographs_%28PSF%29.png>
- Author: Pearson Scott Foresman
- License: Public domain
- Dimensions: 3676x618
- Split: tune
- Notes: Row of monochrome pictograms; flat black shapes on white, extreme aspect.

### `graphic-lineart-scarecrow`

- Source: <https://commons.wikimedia.org/wiki/File:Scarecrow_(PSF).png>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/21/Scarecrow_%28PSF%29.png>
- Author: Pearson Scott Foresman
- License: Public domain
- Dimensions: 1817x2061
- Split: holdout
- Notes: Dense engraving-style hatched line art, monochrome, high spatial frequency.

### `graphic-logo-solid-blue`

- Source: <https://commons.wikimedia.org/wiki/File:Ambigram_New_Man_logo_by_Raymond_Loewy_(blue_background).png>
- File: <https://upload.wikimedia.org/wikipedia/commons/8/8c/Ambigram_New_Man_logo_by_Raymond_Loewy_%28blue_background%29.png>
- Author: Raymond Loewy
- License: Public domain
- Dimensions: 6600x4400
- Split: tune
- Notes: Logo on a solid blue field: two flat colours, huge uniform background area.

### `graphic-periodic-table-nist`

- Source: <https://commons.wikimedia.org/wiki/File:Periodic_Table_-_Atomic_Properties_of_the_Elements.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/d/df/Periodic_Table_-_Atomic_Properties_of_the_Elements.png>
- Author: R.A. Dragoset, A. Musgrove, C.W. Clark, and W.C. Martin — NIST, Physical Measurement Laboratory
- License: Public domain
- Dimensions: 3300x2550
- Split: tune
- Notes: Reference table: coloured cells, dense small numerals and text.

### `graphic-playfair-piecharts`

- Source: <https://commons.wikimedia.org/wiki/File:Playfair_piecharts.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/a1/Playfair_piecharts.jpg>
- Author: William Playfair
- License: Public domain
- Dimensions: 6306x3456
- Split: holdout
- Notes: Historic hand-engraved statistical pie charts; aged paper, JPEG scan.

### `graphic-scientific-plot`

- Source: <https://commons.wikimedia.org/wiki/File:HIVPlot10.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f6/HIVPlot10.png>
- Author: Chamaemelum
- License: Public domain
- Dimensions: 3200x1600
- Split: tune
- Notes: Horizontal seaborn-style bar chart: ten saturated category bars, grid lines and small axis text on white.

### `graphic-sheet-music-dense`

- Source: <https://commons.wikimedia.org/wiki/File:Antonio_Bazzini_%E2%80%93_La_Ronde_des_Lutins_(Dance_of_the_Goblins)_%E2%80%93_Score,_First_Page.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/b/be/Antonio_Bazzini_%E2%80%93_La_Ronde_des_Lutins_%28Dance_of_the_Goblins%29_%E2%80%93_Score%2C_First_Page.png>
- Author: Antonio Bazzini
- License: Public domain
- Dimensions: 1781x2363
- Split: tune
- Notes: Dense engraved violin score: very high stroke density, monochrome.

### `graphic-smps-schematic`

- Source: <https://commons.wikimedia.org/wiki/File:24V_10A_SMPS_Circuit_Diagram.jpg>
- File: <https://upload.wikimedia.org/wikipedia/commons/4/4d/24V_10A_SMPS_Circuit_Diagram.jpg>
- Author: Amila Ruwan 20
- License: CC BY-SA 4.0
- Dimensions: 7016x4961
- Split: holdout
- Notes: Detailed power-supply schematic as a JPEG; thin lines, ringing-prone content.

### `graphic-tiling-wm`

- Source: <https://commons.wikimedia.org/wiki/File:Awesome_screenshot_ja.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/1/15/Awesome_screenshot_ja.png>
- Author: blowback
- License: CC BY-SA 3.0
- Dimensions: 1280x1024
- Split: tune
- Notes: Tiling window manager screenshot: dense monospace terminal text, high frequency detail.

### `graphic-timechart-six-nations`

- Source: <https://commons.wikimedia.org/wiki/File:1883-2023_Six_Nations_victories_time_chart_per_country.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/a/a4/1883-2023_Six_Nations_victories_time_chart_per_country.png>
- Author: Blackcat
- License: CC0
- Dimensions: 1529x999
- Split: tune
- Notes: Dense categorical time chart, many small coloured cells and labels.

### `graphic-transit-diagram`

- Source: <https://commons.wikimedia.org/wiki/File:Bengaluru_Urban_Rail_Transit_Diagram.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/e/e9/Bengaluru_Urban_Rail_Transit_Diagram.png>
- Author: Footy2000
- License: CC BY 4.0
- Dimensions: 9983x13113
- Split: holdout
- Notes: Schematic transit map: pure flat colour, straight strokes, dense small text.

### `graphic-web-app-screenshot`

- Source: <https://commons.wikimedia.org/wiki/File:Apps.education.fr_screenshot.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/e/ea/Apps.education.fr_screenshot.png>
- Author: FramaKa
- License: CC BY-SA 4.0
- Dimensions: 1920x1080
- Split: tune
- Notes: Website screenshot: flat cards, text blocks and a large colour field.

### `graphic-wikipedia-text-page`

- Source: <https://commons.wikimedia.org/wiki/File:2020-07-02_Screenshot_The_Book_Chronom%C3%A8tre_-_Chronopolis.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/f/f3/2020-07-02_Screenshot_The_Book_Chronom%C3%A8tre_-_Chronopolis.png>
- Author: Stefan Kühn
- License: CC0
- Dimensions: 1646x1975
- Split: tune
- Notes: Text-heavy page screenshot: dense body text, links and headings, near-monochrome.

### `graphic-world-map-colour`

- Source: <https://commons.wikimedia.org/wiki/File:1-12_Color_Map_World.png>
- File: <https://upload.wikimedia.org/wikipedia/commons/2/2e/1-12_Color_Map_World.png>
- Author: Colomet
- License: Public domain
- Dimensions: 4572x2500
- Split: holdout
- Notes: Flat colour-coded world map: large uniform regions, hard borders.
