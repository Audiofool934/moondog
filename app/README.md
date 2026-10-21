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

- Conversations on the left are the terminal's conversations, in both directions: one started here shows up in `/resume`, and the other way round.
  Pinned ones come first, then folders, then the rest by day.
  A row's `⋯` button or a right-click renames, pins, moves it to a folder, or deletes it after asking.
  Dragging a row onto a folder files it there. `⌘N` starts a new conversation.
- Several conversations can answer at once, up to four; a small dot marks one that is still answering, and you can switch away and back.
- The conversation in the middle: your words in a bubble, Moondog's in serif type.
  While Moondog works, a quiet line says what it is doing; after a turn, a song it started shows with its cover.
- What is playing on the right: a large cover, the song, the device and the time, then what comes next.
  Hovering the cover shows previous, pause and next.
- Drag the inner edge of either side panel to change its width; a double-click puts it back.
- Under the composer, the model opens a menu of the models you are signed in to, with the thinking effort, and the device opens Spotify's devices.
  The music service at the bottom left switches between Spotify and Apple Music.
- Typing `/` lists commands: `/new`, `/model`, `/effort`, `/language`, `/service`, `/device`, `/import`, `/memory`, `/remember`, `/folder`, `/settings` and `/help`.
- Settings (`⌘,`) has General (language), Model (providers, sign-in in the browser or with an API key, models, effort), Playback (music service, Spotify account, devices), Import, Memory and About.
  Changes are saved where the terminal reads them; the window never sees a key or token.
- Import: choose a Spotify, Apple Music, ListenBrainz or Last.fm export, read recent Spotify listening, or drop a file anywhere on the window.
  The preview uses the terminal's words, nothing is saved until you add it, and the updated profile then shows in the conversation.
- Apple Music plays 30-second previews in the window, with media keys and the system's Now Playing; full Apple Music playback is not built yet.
- No accent color. Cover art brings the color.
- Keys: Enter sends and Shift+Enter starts a new line. `⌘.` or Esc stops a reply.
  Typing anywhere goes to the composer. No plain key plays, pauses or skips, because a chat window is typed in all the time; the media keys and the Playback menu control the music.
  `⌥⌘S` and `⌥⌘P` show or hide the conversations and the player; a narrow window folds them on its own.
- Language: the window speaks the language the core speaks, which follows the choice in Settings or `/language`, then the system's language.
  The window's words, its menus included, exist in English, Simplified and Traditional Chinese, Japanese, Korean, Spanish, French, German, Brazilian Portuguese and Italian (`strings.mjs`).
- Closing the window hides it, and the music keeps going until you quit. A reply in progress shows in the Dock.
- Links open in your browser.

## How it fits together

- `main.mjs` opens the window, builds the localized menu, and starts the core in its own Node process.
- `core-process.mjs` runs `scripts/moondog.mjs` with a host that registers `runRoom`, so the command builds everything as it does for the terminal and hands it to the window instead of the terminal room.
- `window-room.mjs` is the core's side of the window: turns stream back as text and activity, sessions open and close, and Spotify's player state is read every few seconds and after every playback action.
  Each conversation that answers beside the first gets its own application and agent from `openConversation`, on the same memory and Spotify.
  Settings go through the services the terminal uses: `modelSettings` for providers and sign-in, `rebuildRuntime`, `saveLanguage`, `savePlaybackService` and the import services.
- `renderer/` draws the window: `sidebar.mjs` (conversations and folders), `settings.mjs` (the Settings sheet), `palette.mjs` (slash commands), `previews.mjs`, and `renderer.mjs` for the rest.
  Replies render from Markdown into DOM text nodes (`markdown.mjs`), so a reply can't inject markup.
- Menus for a conversation and the model, device and service pickers are native menus, built in `main.mjs` from plain items the page sends.
- One message port carries everything between the core and the window, including the previews the agent plays.

## Build the app

`npm run pack` builds an unsigned Moondog.app for Apple silicon, as a DMG and a zip in `release/`.
`npm run release` builds the same app, signed with the Developer ID and notarized by Apple, so it opens without a warning.

- The app carries the core exactly as the npm package ships it: `npm pack` decides the files, and `npm ci --omit=dev` adds their dependencies.
- Signing needs the Developer ID Application certificate in the login keychain.
  Notarization reads the keychain profile `moondog-notary`, made once with `xcrun notarytool store-credentials moondog-notary --team-id <your team ID>`, which asks for the Apple ID and an app-specific password.
  `MOONDOG_SIGNING_IDENTITY` and `MOONDOG_NOTARY_PROFILE` choose a different certificate or profile.
- Opened from the Dock or Finder, the app has a minimal `PATH`, so the core gets the `PATH` of a login shell, as in a terminal.
  Programs such as `codex`, which web research can use, keep working.
- The packaged core has no npm update notice, because the app updates as a whole.

## Not yet

- The first-time setup and the full taste report happen in the terminal (`moondog`).
- Apple Music plays previews only.
- The app does not update itself yet; install a new build over the old one.
- The build is for Apple silicon only.
