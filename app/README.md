# Moondog for Mac

A native window on the same core as the `moondog` command, as a desktop app is to its command line.
The application, agent, Spotify, profile and memory services are shared; the window draws its own surface.

## Run it

From a checkout with dependencies installed (`npm ci` at the repository root):

```bash
cd app
npm ci
npm start
```

The app reads and writes the same profile, settings, and sign-ins as the `moondog` command.

To try the whole window without touching a Spotify account, run it on a simulated Spotify:

```bash
cd app
npm run simulated
```

The simulated Spotify (`src/evaluation/simulated-spotify.mjs`) has real public titles, invented IDs and drawn covers.
The model is the one your settings choose; conversations stay in memory and are gone when the app quits.

## The window

- Conversations on the left, grouped by day. `⌘N` starts a new one.
- The conversation in the middle: your words in a bubble, Moondog's in serif type.
  While Moondog works, a quiet line says what it is doing; after a turn, a song it started shows with its cover.
- What is playing on the right: a large cover, the song, the device and the time, then what comes next.
  Hovering the cover shows previous, pause and next.
- No accent color. Cover art brings the color.
- Previews: when Spotify isn't connected, the agent's Apple Music previews play in the window, in the same place, with media keys and the system's Now Playing.
- Keys: Enter sends and Shift+Enter starts a new line. `⌘.` or Esc stops a reply.
  Typing anywhere goes to the composer. Space plays and pauses, and `⌘→` and `⌘←` skip, when you are not typing.
  `⌥⌘S` and `⌥⌘P` show or hide the conversations and the player; a narrow window folds them on its own.
- Language: the window speaks the language the core speaks, which follows a choice saved with `/language` in the terminal, then the system's language.
  The window's words, its menus included, exist in English, Simplified and Traditional Chinese, Japanese, Korean, Spanish, French, German, Brazilian Portuguese and Italian (`strings.mjs`).
- Closing the window hides it, and the music keeps going until you quit. A reply in progress shows in the Dock.
- Links open in your browser.

## How it fits together

- `main.mjs` opens the window, builds the localized menu, and starts the core in its own Node process.
- `core-process.mjs` runs `scripts/moondog.mjs` with a host that registers `runRoom`, so the command builds everything as it does for the terminal and hands it to the window instead of the terminal room.
- `window-room.mjs` is the core's side of the window: turns stream back as text and activity, sessions open and close, and Spotify's player state is read every few seconds and after every playback action.
- `renderer/` draws the window. Replies render from Markdown into DOM text nodes (`markdown.mjs`), so a reply can't inject markup.
- One message port carries everything between the core and the window, including the previews the agent plays.

## Build the app

`npm run pack` builds an unsigned Moondog.app for Apple silicon, as a DMG and a zip in `release/`.
`npm run release` builds the same app, signed with the Developer ID and notarized by Apple, so it opens without a warning.

- The app carries the core exactly as the npm package ships it: `npm pack` decides the files, and `npm ci --omit=dev` adds their dependencies.
- Signing needs the Developer ID Application certificate in the login keychain.
  Notarization reads the keychain profile `moondog-notary`, made once with `xcrun notarytool store-credentials moondog-notary --team-id <your team ID>`, which asks for the Apple ID and an app-specific password.
  `MOONDOG_SIGNING_IDENTITY` and `MOONDOG_NOTARY_PROFILE` choose a different certificate or profile.
- Opened from the Dock or Finder, the app has a minimal `PATH`, so the core gets the `PATH` of a login shell, as in a terminal.
  Programs such as `codex`, which web research needs, keep working.
- The packaged core has no npm update notice, because the app updates as a whole.

## Not yet

- Importing listening history, the taste report, and first-time sign-in to a model or Spotify happen in the terminal (`moondog`); the window uses what they set up.
- The app does not update itself yet; install a new build over the old one.
- The build is for Apple silicon only.
