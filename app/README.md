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
A model or music service chosen there lasts until the app quits, and sign-in and sign-out are turned off.

## The window

- Before anything is said, the lunar record stands alone over the composer, drawn as dots from the terminal's own record.
  It turns while music plays and rests when it stops.
- Conversations on the left are the terminal's conversations, in both directions: one started here shows up in `/resume`, and the other way round.
  Pinned ones come first, then folders, then the rest by day.
  A row's `⋯` button or a right-click renames, pins, moves it to a folder, or deletes it after asking.
  Dragging a row onto a folder files it there. `⌘N` or the pencil in the title bar starts a new conversation.
  From the keyboard, Up and Down move between conversations, and the context menu key or Shift+F10 opens a row's menu.
- Several conversations can answer at once, up to four; a breathing dot marks one that is still answering, and you can switch away and back.
- The conversation in the middle: your words in a bubble, Moondog's in serif type.
  While Moondog works, one quiet line says the step it is on; after a turn, the song it started takes that line, with its cover.
  A reply that failed offers Try again.
- In a long conversation, a mark for each request sits at the right edge: hover one to read it, click to go back to it.
  The view stays with the newest words until you scroll up; a round button brings you back. Page Up and Page Down scroll from the composer.
- What is playing on the right: a large cover that tints the panel with its own colours, the song, a progress line you can drag to move in the song (or focus it and use the arrow keys, five seconds a press, fifteen with Shift), previous, play or pause, and next.
  The device under it opens Spotify's devices and the choice between Spotify and Apple Music.
  A control Spotify won't take right now, such as skipping on a free account, is dimmed.
  With the player folded away, the song shows at the end of the title bar; a click opens the player.
- Drag the inner edge of either side panel to change its width; a double-click puts it back.
- In the composer, the model opens a menu of the models you are signed in to, with the thinking effort.
- Typing `/` lists commands by what they open (a mistyped one stays in the composer instead of going to Moondog): `/new`, `/model`, `/language`, `/service`, `/device`, `/import`, `/memory`, `/remember`, `/folder`, `/settings` and `/help`.
- Settings (`⌘,`) has Language, Model (accounts, sign-in in the browser or with an API key, models, thinking), Playback (music service, Spotify sign-in, devices), Import, Memory and About.
  Changes are saved where the terminal reads them; the window never sees a key or token.
- Import: choose a Spotify, Apple Music, ListenBrainz or Last.fm export, read recent Spotify listening, read a Last.fm account (the window asks for a Last.fm API key the first time), or drop a file anywhere on the window.
  The preview uses the terminal's words, nothing is saved until you add it, and the updated profile then shows in the conversation.
- Apple Music plays 30-second previews in the window, with media keys and the system's Now Playing; full Apple Music playback is not built yet.
- No accent color. Cover art brings the color. Icon buttons name themselves, with their keys, in a tooltip.
- Keys: Enter sends and Shift+Enter starts a new line. `⌘.` or Esc stops a reply.
  Typing anywhere goes to the composer. No plain key plays, pauses or skips, because a chat window is typed in all the time.
  `⌃⌘P` plays or pauses, and `⌃⌘→` and `⌃⌘←` skip, from the Playback menu; the media keys work too.
  `⌥⌘S` and `⌥⌘P` show or hide the conversations and the player; a narrow window folds them on its own.
- Language: the window speaks the language the core speaks, which follows the choice in Settings or `/language`, then the system's language.
  The window's words, its menus included, exist in English, Simplified and Traditional Chinese, Japanese, Korean, Spanish, French, German, Brazilian Portuguese and Italian (`strings.mjs`).
- Closing the window hides it, and the music keeps going until you quit. A reply in progress shows in the Dock, and the Dock icon's menu plays, pauses and skips.
- Links open in your browser.

## How it fits together

- `main.mjs` opens the window, builds the localized menu, and starts the core in its own Node process.
- `core-process.mjs` runs `scripts/moondog.mjs` with a host that registers `runRoom`, so the command builds everything as it does for the terminal and hands it to the window instead of the terminal room.
- `window-room.mjs` is the core's side of the window: turns stream back as text and activity, sessions open and close, and Spotify's player state is read every few seconds and after every playback action.
  Each conversation that answers beside the first gets its own application and agent from `openConversation`, on the same memory and Spotify.
  Settings go through the services the terminal uses: `modelSettings` for providers and sign-in, `rebuildRuntime`, `saveLanguage`, `savePlaybackService` and the import services.
- `renderer/` draws the window: `sidebar.mjs` (conversations and folders), `settings.mjs` (the Settings sheet), `palette.mjs` (slash commands), `previews.mjs`, `record.mjs` (the turning record), `ui.mjs` (icons, tooltips, the overlay scrollbar), and `renderer.mjs` for the rest.
  Every colour, size, corner and duration is a token in `tokens.css`; `style.css` and `sheet.css` use only the tokens.
  Replies render from Markdown into DOM text nodes (`markdown.mjs`), so a reply can't inject markup.
- Menus for a conversation and the model, device and service pickers are native menus, built in `main.mjs` from plain items the page sends.
- One message port carries everything between the core and the window, including the previews the agent plays.

## Look at every state

`npm run harness` draws the window against a stand-in core (`harness-preload.cjs`) with fictional songs and conversations, and saves a picture of each state, in light and dark, to `release/harness/`.
It needs no model, no music service and none of your data.
`MOONDOG_HARNESS_STATES=empty,reply` picks states, `MOONDOG_HARNESS_SIZE=900x700` changes the size, `MOONDOG_HARNESS_LOCALE=zh` the language, and `MOONDOG_HARNESS_SHOW=1` opens a window to try by hand.

## Build the app

`npm run pack` builds an unsigned Moondog.app for Apple silicon, as a DMG and a zip in `release/`.
`npm run release` builds the same app, signed with the Developer ID and notarized by Apple, so it opens without a warning.

- The app carries the core exactly as the npm package ships it: `npm pack` decides the files, and `npm ci --omit=dev` adds their dependencies.
- Signing needs the Developer ID Application certificate in the login keychain.
  Notarization uses `MOONDOG_NOTARY_PROFILE`, then the shared `APPLE_NOTARY_PROFILE`, then `mac-mini-notary`.
  The Mac mini stores one `mac-mini-notary` profile for all products in the same developer team.
  To configure another machine, run `xcrun notarytool store-credentials mac-mini-notary --team-id <your team ID>` and enter the Apple ID and app-specific password at the secure prompts.
  `MOONDOG_SIGNING_IDENTITY` selects a different certificate.
  Keep passwords in Keychain; profile names and environment variables contain no password.
- Opened from the Dock or Finder, the app has a minimal `PATH`, so the core gets the `PATH` of a login shell, as in a terminal.
  Programs such as `codex`, which web research can use, keep working.
- The packaged core has no npm update notice, because the app updates as a whole.

## Not yet

- The first-time setup and the full taste report happen in the terminal (`moondog`).
- Apple Music plays previews only.
- The app does not update itself yet; install a new build over the old one.
- The build is for Apple silicon only.
