# Moondog Project Page

This folder builds Moondog's project page at <https://moondog.audiofool.ai>.
Its hero is Moondog's own window, the desktop app's renderer, running in the browser with a fictional listener.
One switch away is the terminal's room, with the same listener.
By default the page makes no network requests, and its content security policy enforces that.
A build with `MOONDOG_AGENT_URL` also lets both talk to the [public agent](#the-public-agent), and a Turnstile site key adds Cloudflare's visitor check.

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
The build asks GitHub for the newest release with a Mac download; `node build.mjs --offline` links the release list instead.

## How it fits together

The page is three documents, so each surface keeps its own globals and keystrokes.

- `index.html`, `style.css` and `page.mjs` are the page: the words, the Window and Terminal switch, and the copy button.
  The terminal's frame loads the first time someone asks for it.
- `window.html` is `app/renderer/index.html`, rebuilt with this page's policy.
  `window/host.mjs` stands in for the app's preload and core process.
  It runs `app/window-room.mjs` on the tab's conversations and the public agent, and the agent's Apple Music previews play in the window's own player.
  `window/menus.mjs` draws the menus and confirmations the app shows natively.
  The renderer and window-room run unchanged; a change to the app's window shows here too.
- `terminal.html` is the terminal's room: `src/surfaces/cli/tui.mjs` runs unchanged, and `terminal/xterm-terminal.mjs` gives it pi-tui's `Terminal` interface on top of xterm.js.
- `listener/` is what both share.
  `snapshot.mjs` imports the fictional Spotify history into a throwaway state folder with the real CLI and saves what the room reads to `generated/snapshot.json`, with the public agent's model.
  `browser-application.mjs` answers from that snapshot and keeps conversations in the tab, and `remote-runtime.mjs` talks to the public agent.
  What needs files, a model of your own, or a music service says it needs the app.
- `build.mjs` bundles with esbuild.
  It swaps Node built-ins and the model and sign-in modules for the stand-ins in `shims/`, and makes pi-tui's Node-only timer calls optional.

## The public agent

`server/agent-server.mjs` lets visitors talk to the agent from the page.
Each message goes to the server, where the real `PiAgentRuntime` answers from its own copy of the fictional listener and streams its steps back to the page.

- Every visitor conversation gets a private copy of the fictional history.
  Nothing is written back, conversations are not kept, and message text is never logged.
- The agent only reads and plans, and plays 30-second Apple Music previews.
  Profile builds, memory, Spotify, and web lookups are off.
- Limits stop a turn with a plain reply from Moondog:
  turns per conversation, conversations and turns per address each day, a message length, tool calls per turn, output tokens per model call, and a daily budget in US dollars for the whole site.
  Every limit has an environment variable in `configFromEnvironment`.
- `node --test server/agent-server.test.mjs` runs the server against Pi's fake model, with no key and no cost.

To run it, build `server/Dockerfile` from the repository root, or use `server/compose.yaml` next to a reverse proxy.
It needs `DEEPSEEK_API_KEY` and, behind a proxy, `MOONDOG_AGENT_ADDRESS_HEADER` (for example `cf-connecting-ip`), so the limits count real visitors.
The page talks to the agent only when the build has `MOONDOG_AGENT_URL`; the Pages workflow reads it from the repository variable of the same name.
To try the page against a local agent, start one with `MOONDOG_AGENT_ORIGINS=http://localhost:8737` and build with `MOONDOG_AGENT_URL=http://127.0.0.1:8787`.

Cloudflare Turnstile can check visitors before each conversation.
Set `TURNSTILE_SECRET_KEY` on the server and the `MOONDOG_TURNSTILE_SITE_KEY` repository variable for the page, both from the same Turnstile widget.
The page loads Cloudflare's script only when a conversation starts, and `/v1/status` shows `"humanCheck":true` when the server requires it.

## Publishing

`.github/workflows/pages.yml` builds the page on pull requests and publishes `dist/` to GitHub Pages from `main`.
`npm run publish-app` in `app/` runs it again once a release has its DMG, so the download button links the new version.

## Known gaps

- Editing and branching a message, changing the model, importing, and Spotify need the app; the window says so.
- Without the agent, a message gets a short reply that the page has no model.
