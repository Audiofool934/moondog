# Moondog app (prototype)

The real listening room in its own window.
The room is the same code as the `moondog` command, and the window adds what a terminal can't.

## Run it

From a checkout with dependencies installed (`npm ci` at the repository root):

```bash
cd app
npm ci
npm start
```

The app reads and writes the same profile, settings, and sign-ins as the `moondog` command.
To try it on fictional data, set `MOONDOG_STATE_HOME` and `MOONDOG_CONFIG_HOME` to empty folders first.

## What the window adds

- Sound: previews the agent picks play in a player under the room, with media keys and the system's Now Playing.
- Control: `/skip` moves to the next preview and `/stop` clears the queue, including while the agent is answering.
  The room follows the player's current song, loading and paused state, and marks previews that could not load.
- Presence: closing the window hides it, and the room and its music keep going until you quit.
- Mixed blocks: a room component can mark cells for the window to paint with graphics, while its labels stay terminal text.
- Files: dropping a file types its path into the room, as a terminal does, so `/import` and a drop work together.
- Links open in your browser, and a busy room shows in the Dock.
- Sign-in works as in a terminal: `/auth` and `/spotify login` clear the window for their steps, Ctrl+C cancels them, and their addresses are links.

## How it fits together

- `main.mjs` opens the window and starts the room in its own Node process.
- `room-process.mjs` runs `scripts/moondog.mjs` unchanged, with a stand-in terminal and preview player it registers first.
- `renderer/` draws the room with xterm.js, shows the player, and paints the blocks.
- Output, keys, size, and previews travel over one message port between the room process and the window.
- `window-terminal.mjs` is the room's terminal. When the room steps aside for a sign-in, it acts like a plain terminal for the prompt.
- Quit sends the room SIGTERM, which it handles as it does in a terminal, so a draft you haven't sent is kept.

## Mixed blocks

A block is one room component, drawn as text in every terminal.
In this window (`MOONDOG_HOST=app`), each of its rows starts with an invisible mark: `OSC 7717 ; id ; row ; width ; data`.
The data is the block's numbers as base64 JSON, so any row in view is enough to draw it.
The room rewrites a whole row at a time, so a row belongs to the last block that marked it since it was cleared.
After each write, the window paints every block over its cells and cuts away the rows that are out of view.
The text underneath stays, so a block still reads if its graphics fail.

The first block is the seasons chart in `/taste report` (`src/surfaces/cli/seasons-chart.mjs`).
Its quarters and details stay text; only the bars become graphics.

Rules for new blocks:

- The grid is the layout: graphics take whole cells and use the room's palette.
- Every block has a text form; the window may only draw it better.
- Facts and actions exist in both forms; hover, motion, and precision may be graphics-only.
- A marked region keeps a blank cell on each side, which the graphics may bleed into.

## Build the app

`npm run pack` builds an unsigned Moondog.app for Apple silicon, as a DMG and a zip in `release/`.
`npm run release` builds the same app, signed with the Developer ID and notarized by Apple, so it opens without a warning.

- The app carries the room exactly as the npm package ships it: `npm pack` decides the files, and `npm ci --omit=dev` adds their dependencies.
- Signing needs the Developer ID Application certificate in the login keychain.
  Notarization reads the keychain profile `moondog-notary`, made once with `xcrun notarytool store-credentials moondog-notary --team-id <your team ID>`, which asks for the Apple ID and an app-specific password.
  `MOONDOG_SIGNING_IDENTITY` and `MOONDOG_NOTARY_PROFILE` choose a different certificate or profile.
- Opened from the Dock or Finder, the app has a minimal `PATH`, so the room gets the `PATH` of a login shell, as in a terminal.
  Programs such as `codex`, which web research needs, keep working.
- The packaged room has no npm update notice, because the app updates as a whole.

## Not yet

- The app does not update itself yet; install a new build over the old one.
- The build is for Apple silicon only.
