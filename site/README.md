# Moondog Project Page

This folder builds Moondog's project page at <https://moondog.audiofool.ai>.
Its hero is Moondog's own window, the desktop app's renderer, playing a short scene with a made-up listener and made-up songs.
The page makes no network requests beyond its own files, and its content security policy enforces that.

## Run it

It needs Node.js 22.19 or newer.
Run `npm ci` at the repository root first.

```bash
cd site
npm ci
npm run dev
```

Then open <http://localhost:8737>.
`npm run build` writes the page to `dist/`.
The build asks GitHub for the newest release with a Mac download; `node build.mjs --offline` links the release list instead.

## The scene

The needle goes down and Moondog picks three songs, then a request for a late train home is typed and answered.
The window is the real one: `app/renderer` and `app/window-room.mjs` run unchanged, so a change to the app's window shows here too.

- `window/host.mjs` stands in for the app's preload and core process, and starts the scene.
- `window/scene.mjs` holds what happens: each exchange's steps, reply and songs, and the drawn covers.
  The listener is the demo history's (`src/demo/fictional-spotify-history.mjs`); the new artists are made up too.
- `window/agent.mjs` is the scene's Moondog: it runs each exchange's steps through the agent's events, starts its songs, and writes its reply at a reading pace.
- `window/application.mjs` keeps the scene's conversation and plays its songs as the Music app on a Mac would.
- `window/director.mjs` moves a pointer and types, as a visitor would: the needle, the player, the composer.
  The scene runs only while the window is on screen, and plays again behind a fade.
  With reduced motion it shows the finished scene at once, with no pointer.
  Where the window is narrower than the app gives its player room, the player stays folded.

`build.mjs` bundles with esbuild, and swaps the Node built-ins the window's core imports for the stand-ins in `shims/`.
Each published document asks for its script and styles by a hash of their content, because Cloudflare keeps them for hours.

## The public agent

`server/` holds the agent that visitors could talk to from an earlier version of the page.
The page no longer calls it.
`server/agent-server.mjs` runs the real `PiAgentRuntime` on the fictional listener (`server/fictional-history.mjs`), with limits on turns, conversations, tool calls, output tokens and a daily budget.
`node --test server/agent-server.test.mjs` runs it against Pi's fake model, with no key and no cost.
Build `server/Dockerfile` from the repository root to run it.

## Publishing

`.github/workflows/pages.yml` builds the page on pull requests and publishes `dist/` to GitHub Pages from `main`.
`npm run publish-app` in `app/` runs it again once a release has its DMG, so the download button links the new version.
