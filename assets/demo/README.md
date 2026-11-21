# Demo Media

## Desktop screenshots

`moondog-desktop-light.png` and `moondog-desktop-dark.png` show the desktop app's real window, as the project page plays it with a made-up listener and music made with Stable Audio 3.
The README shows the one that matches the reader's color scheme.
They were captured on 2026-11-21 from the page's scene served by `node site/build.mjs --serve`, in headless Chromium at 1440 by 900 and twice the pixel density, about 30 seconds after Watch without sound, then scaled to 1600 pixels wide.
No personal data, model, or music service is involved.

## Terminal screenshots

`moondog-tui-home.png` and `moondog-tui-profile.png` show the real listening room at 100 by 34 cells in the charcoal theme.
The README shows both.
`npm run generate:demo-screens` starts Moondog in a private tmux server with a temporary home and state directory, skips the first-run setup, imports the fictional 52-play history, opens the evidence behind one track, then returns to the record sleeve.
Each screen is captured with its colors and redrawn cell by cell in headless Chrome, so nothing personal, no model, and no music service is involved.
`moondog-tui-captures.json` records the capture date, dimensions, sizes, and SHA-256 values; inspect both images before committing them.

`npm run verify:community` checks that all four images are bounded PNG captures with plausible dimensions.
