# Moondog Project Page

This folder builds Moondog's project page.
Its hero is the real listening room, running in the browser with a fictional listener.
The page makes no network requests, and its content security policy enforces that.

## Run it

It needs Node.js 22.19 or newer.
Run `npm ci` at the repository root first.

```bash
cd site
npm ci
npm run dev
```

Then open <http://localhost:8737>.
`npm run build` makes a fresh fictional snapshot and writes the page to `dist/`.

## How the room runs in a browser

- `src/surfaces/cli/tui.mjs` runs unchanged.
  `room/xterm-terminal.mjs` gives it pi-tui's `Terminal` interface on top of xterm.js.
- `room/snapshot.mjs` imports the fictional Spotify history into a throwaway state folder with the real CLI.
  It saves what the room reads (the profile summary, the evidence, and the local command results) to `generated/snapshot.json`.
- `room/browser-application.mjs` answers the room from that snapshot.
  Anything that needs files, a model, or a music service says it needs the installed app.
- `build.mjs` bundles with esbuild.
  It swaps Node built-ins and the model and sign-in modules for the stand-ins in `room/shims/`, and makes pi-tui's Node-only timer calls optional.

## Publishing

`.github/workflows/pages.yml` builds the page on pull requests and publishes `dist/` to GitHub Pages from `main`.

## Known gaps

- Like, Avoid, and Undo are not wired yet, because they write to the listening store.
- Typing a message shows the no-model reply, and `/model` explains that a model needs the installed app.
