# Demo Media

## Terminal screenshots

`moondog-tui-home.png` and `moondog-tui-profile.png` show the real listening room at 100 by 34 cells in the charcoal theme.
The README shows both.
`npm run generate:demo-screens` starts Moondog in a private tmux server with a temporary home and state directory, imports the fictional 52-play history, opens the evidence behind one track, then returns to the record sleeve.
Each screen is captured with its colors and redrawn cell by cell in headless Chrome, so nothing personal, no model, and no music service is involved.
`moondog-tui-captures.json` records the capture date, dimensions, sizes, and SHA-256 values; inspect both images before committing them.
`npm run verify:community` checks that both images are bounded PNG captures with plausible terminal dimensions.
