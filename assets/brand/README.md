# Moondog Brand

Decided by the project owner on 2026-10-27.

## Logo

The logo is drawn by code in [`src/surfaces/brand/logo.mjs`](../../src/surfaces/brand/logo.mjs).
Its dog, headphones, record, craters, and tonearm are measured from the [key visual](moondog-lunar-record/README.md), so the outline is the selected picture's own.
The logo is one ink with no background, and it works on light and dark.
The dog is solid; the bar mosaic and the paper stay with the key visual.

- [`moondog-logo.svg`](moondog-logo.svg) is the full logo, for sizes above 64 px.
- [`moondog-logo-small.svg`](moondog-logo-small.svg) is the small version, for 64 px and below.
  It keeps the vinyl with the rim, two heavy grooves, and a heavy tonearm, and its gaps stay open at 16 px.
- [`moondog-app-icon.png`](moondog-app-icon.png) is the Mac app's icon: the full logo on a white tile.
- [`moondog-app-icon-dark.png`](moondog-app-icon-dark.png) is the dark tile, which the listener can choose in the app's Appearance settings.

Both SVG files follow the reader's light or dark setting.
The window's title-bar mark and the terminal's record draw the same dog through `logoFigure()`.

## Changing the logo

Change the numbers in `logo.mjs`, never the files it writes, and then run this command:

```sh
node scripts/generate-logo.mjs
```

It writes the SVG files, the app icons, and the project page's icon and link preview, and draws the PNGs with headless Chrome.
Keep the dog's outline as measured unless the project owner decides otherwise.
