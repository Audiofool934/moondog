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

## How it fits together

- `main.mjs` opens the window and starts the room in its own Node process.
- `room-process.mjs` runs `scripts/moondog.mjs` unchanged, with a stand-in terminal and preview player it registers first.
- `renderer/` draws the room with xterm.js, shows the player, and paints the blocks.
- Output, keys, size, and previews travel over one message port between the room process and the window.

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

## Not yet

- Model sign-in (`/auth`) asks for a key on the terminal's own input, so the app turns it off for now; sign in once with `moondog`, and the app uses the same sign-in.
- `/spotify login` still opens the browser, but the steps it prints for a terminal don't show in the app yet.
- Quitting stops the room process at once instead of asking it to close.
- There is no packaged, signed build.
