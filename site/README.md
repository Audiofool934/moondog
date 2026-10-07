# Web Room Spike

This spike runs the real Moondog listening room in a browser page.
It uses fictional listening data and connects to no model or music service.
It is an experiment, not a product surface.

## Run it

It needs Node 22.19 or newer.
Run `npm ci` at the repository root first.

```bash
cd web-room
npm install
npm run snapshot
npm run build -- --serve --dev
```

Then open <http://localhost:8737>.

## How it works

- `src/surfaces/cli/tui.mjs` runs unchanged.
  Its `terminal` parameter gets `src/xterm-terminal.mjs`, which implements pi-tui's `Terminal` interface on top of xterm.js.
- `snapshot.mjs` imports the fictional Spotify history into a throwaway state folder with the real CLI.
  It then saves what the room reads (the profile summary, the evidence, and the local command results) to `generated/snapshot.json`.
- `src/browser-application.mjs` answers the room from that snapshot.
  Anything else says it needs the installed app.
- `build.mjs` bundles with esbuild.
  It swaps Node built-ins and the model and sign-in modules for the small stand-ins in `shims/`.

## Findings

- The home sleeve, motion, tracklist, `/taste`, filtering, evidence, `/import`'s service list, `/help`, the no-model reply, paper and charcoal (from the system setting), and the narrow stacked layout all work in the browser.
- No room code changed.
  The browser needed 11 small shim files, and the only real fix was a `Buffer` stand-in for pi-tui's input buffer.
- `main.js` is 1.4 MB, or 359 KB gzipped.
  Translations are 470 KB and could load on demand; xterm.js is 336 KB; the snapshot is 233 KB.
- Like, Avoid, and Undo are not wired yet, because they write to the listening store.
- At phone width the lyric line loses its opening quote mark.
  Check whether the terminal app does the same.
