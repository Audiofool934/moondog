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

## The public agent

`server/agent-server.mjs` lets visitors talk to the agent from the page.
Each message goes to the server, where the real `PiAgentRuntime` answers from its own copy of the fictional listener and streams its steps back to the room.

- Every visitor session gets a private copy of the fictional history.
  Nothing is written back, conversations are not kept, and message text is never logged.
- The agent only reads and plans.
  Profile builds, memory, Spotify, and web lookups are off.
- Limits stop a turn with a plain reply from Moondog:
  turns per conversation, conversations and turns per address each day, a message length, tool calls per turn, output tokens per model call, and a daily budget in US dollars for the whole site.
  Every limit has an environment variable in `configFromEnvironment`.
- `node --test server/agent-server.test.mjs` runs the server against Pi's fake model, with no key and no cost.

To run it, build `server/Dockerfile` from the repository root, or use `server/compose.yaml` next to a reverse proxy.
It needs `DEEPSEEK_API_KEY` and, behind a proxy, `MOONDOG_AGENT_ADDRESS_HEADER` (for example `cf-connecting-ip`), so the limits count real visitors.
The page talks to the agent only when the build has `MOONDOG_AGENT_URL`; the Pages workflow reads it from the repository variable of the same name.

## Publishing

`.github/workflows/pages.yml` builds the page on pull requests and publishes `dist/` to GitHub Pages from `main`.

## Known gaps

- Like, Avoid, and Undo are not wired yet, because they write to the listening store.
- Without the agent, typing a message shows the no-model reply. `/model` always explains that switching models needs the installed app.
