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
  Its grooves take the three colours of the cover that is playing, from the rim inward, and drift into the next song's; the dog and the arm stay in ink.
- In a conversation the record stays above the words, and the conversation runs between it and the composer.
  Scrolling up into history folds it, as you scroll, into a small mark before the title in the title bar; back at the latest words it opens again.
  A click on the record, or `⌥⌘R`, keeps it folded; a click on the mark opens it and returns to the latest words.
  Where the bar has no room between its controls, the title gives way first, then the mark.
  Hovering the record offers a full-window view at the lower-right corner of its square, clear of the disc.
  The full-window view can shrink to a small square; the pin turns upright and solid when it keeps the window on top.
  Esc or the lower-right button returns to the conversation.
- Conversations on the left are the terminal's conversations, in both directions: one started here shows up in `/resume`, and the other way round.
  While the window shows, a conversation or folder saved in the terminal appears within about two seconds; the core asks SQLite whether another process wrote to the memory store, so nothing is sent when nothing changed.
  The window and the terminal show the same conversation: the one either opened last, with `/new`, `/resume`, `/rewind`, the sidebar or a launch.
  A branch made with `/rewind` carries its place in the conversation's lineage until it is renamed, "Late night #2"; the number stays in sight when the title is cut short.
  A message sent in the terminal appears here, and its reply grows here as it is written; the other way round too.
  One of them answers at a time: a message sent while the other answers comes back to the composer here and waits in the queue there.
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
  Where the music plays, under it, opens Spotify's devices and the choice between Spotify and Apple Music; while Apple Music plays, it reads Apple Music.
  A control Spotify won't take right now, such as skipping on a free account, is dimmed.
  Music you play yourself in the Music app on this Mac shows here too, with the next songs of its playlist, and the buttons act on it there.
  When it and Spotify both play, the one that plays wins over a paused one, then the chosen service; a player you just pressed stays in view for 30 seconds.
  macOS asks once before Moondog may read the Music app.
  With the player folded away, the song shows at the end of the title bar with play or pause and next; a click on the song opens the player.
- Drag the inner edge of either side panel to change its width; a double-click puts it back.
- Beside the send button, the music service and the model, each by its mark (from Simple Icons, and Lobe Icons for the model makers Simple Icons lacks), with its name in the tooltip.
  A model shows its maker's mark, through OpenRouter too, by the maker its id names; a maker the window has no mark for shows a plain model glyph.
  The service's menu switches between Spotify, Apple Music, and NetEase Music once ncm-cli is ready; it also signs in to Spotify in Settings, or shows the commands that set up NetEase in Terminal and checks again.
  It offers only services the core can play.
  Asking Moondog for another service switches too, within the same reply; the menu, the terminal and every conversation follow one saved choice, and the service left behind stops playing.
  The model's menu shows the maker in use over its models, the chosen one checked, every other signed-in maker's models in a submenu, and the thinking effort with its level.
  On a first launch the service reads "Choose a music service" until one is chosen, as the model reads "Choose a model" until there is one.
- Typing `/` lists commands by what they open (a mistyped one stays in the composer instead of going to Moondog): `/new`, `/model`, `/language`, `/service`, `/device`, `/import`, `/memory`, `/remember`, `/folder`, `/settings` and `/help`.
- Settings (`⌘,`, or the button at the top right beside the player's) has Language, Model (accounts, sign-in in the browser or with an API key, models, thinking), Playback (music service, Spotify sign-in, devices), Import, Memory and About.
  Changes are saved where the terminal reads them; the window never sees a key or token.
- Import: choose a Spotify, Apple Music, ListenBrainz or Last.fm export, read recent Spotify listening, read a Last.fm account (the window asks for a Last.fm API key the first time), or drop a file anywhere on the window.
  The preview uses the terminal's words, nothing is saved until you add it, and the updated profile then shows in the conversation.
- Apple Music plays whole songs where it can and 30-second previews where it can't.
  Whole songs come from a small helper beside the app's executable (`native/music.swift`) that plays the Apple Music catalog through MusicKit, so they need an Apple Music subscription and the listener's permission, which Settings › Playback asks for once.
  Until the helper can play, the window plays previews in itself, with media keys and the system's Now Playing.
- NetEase Music (网易云音乐) plays through NetEase's own command line tool, for listeners in mainland China.
  It shows among the music services once `npm install -g @music163/ncm-cli`, `brew install mpv` and `ncm-cli login` are done; ncm-cli keeps its own key and sign-in, and Moondog never reads them.
  The core (`src/integrations/netease/ncm-cli-player.mjs`) keeps the queue and plays one song at a time with ncm-cli, so the terminal and the window play the same way.
  Many songs, above all originals outside mainland China, are marked not playable, most often for copyright; Moondog never sends those and says so instead.
  Each search sends NetEase a short summary of the request, which Settings › Playback says.
- No accent color. Cover art brings the color: the song playing tints the window and the record's grooves with its strongest colours, faintly, and they drift into the next song's over a few seconds; its cover glows from the player's corner across to the far edge.
  The window is one pane: no panel has a ground of its own, and the composer and your words sit on the light as a thin film, not as cards.
  Icon buttons name themselves, with their keys, after 650 ms of hovering, in a quiet tooltip matched to the light or dark theme.
  Moving to another button waits again; the record, expand, restore and pin controls keep accessible names without explanatory tooltips.
- Controls for the whole window sit in the title bar, which never folds: the conversations and new conversation at the top left, Settings and the player at the top right.
  The side panels hold only their own content.
- Keys: Enter sends and Shift+Enter starts a new line. `⌘.` or Esc stops a reply.
  Typing anywhere goes to the composer. No plain key plays, pauses or skips, because a chat window is typed in all the time.
  `⌃⌘P` plays or pauses, and `⌃⌘→` and `⌃⌘←` skip, from the Playback menu; the media keys work too.
  `⌥⌘S` and `⌥⌘P` show or hide the conversations and the player; a narrow window folds them on its own. `⌥⌘R` folds or opens the record.
- Language: the window speaks the language the core speaks, which follows the choice in Settings or `/language`, then the system's language.
  The window's words, its menus included, exist in English, Simplified and Traditional Chinese, Japanese, Korean, Spanish, French, German, Brazilian Portuguese and Italian (`strings.mjs`).
- Closing the window hides it, and the music keeps going until you quit. A reply in progress shows in the Dock, and the Dock icon's menu plays, pauses and skips.
- Links open in your browser.

## How it fits together

- `main.mjs` opens the window, builds the localized menu, and starts the core in its own Node process.
- `core-process.mjs` runs `scripts/moondog.mjs` with a host that registers `runRoom`, so the command builds everything as it does for the terminal and hands it to the window instead of the terminal room.
- `window-room.mjs` is the core's side of the window: turns stream back as text and activity, sessions open and close, and Spotify's player state is read after every playback action, just after the playing song should end, when the window gains focus (at most every 10 seconds), and every 30 seconds in a showing window (every minute in a hidden one); the clock runs on its own between reads.
  Every read counts against the listener's Spotify app quota; when Spotify answers that the quota is used up, the window reads nothing until the time Spotify gave and says so.
  Each conversation that answers beside the first gets its own application and agent from `openConversation`, on the same memory and Spotify.
  Settings go through the services the terminal uses: `modelSettings` for providers and sign-in, `rebuildRuntime`, `saveLanguage`, `savePlaybackService` and the import services.
- `renderer/` draws the window: `sidebar.mjs` (conversations and folders), `settings.mjs` (the Settings sheet), `palette.mjs` (slash commands), `previews.mjs`, `record.mjs` (the turning record), `ui.mjs` (icons, tooltips, the overlay scrollbar), and `renderer.mjs` for the rest.
  Every colour, size, corner and duration is a token in `tokens.css`; `style.css` and `sheet.css` use only the tokens.
  Replies render from Markdown into DOM text nodes (`markdown.mjs`), so a reply can't inject markup.
- Menus for a conversation and the model, device and service pickers are native menus, built in `main.mjs` from plain items the page sends.
- One message port carries everything between the core and the window, including the previews the agent plays.

## Whole Apple Music songs

MusicKit gives an app its developer token only when MusicKit is turned on for the app's identifier.
It is on for `ai.audiofool.moondog` in team DAK5S3455A.
A build under another team or identifier needs the same switch, once, in its Apple Developer account: Certificates, Identifiers & Profiles › Identifiers › register or open the App ID › App Services › check MusicKit › Save.
No build or setting in this repository changes after that; the helper's check starts answering yes, and Settings › Playback says "Full songs".
Until then the helper reports `developerTokenRequestFailed` and the window keeps playing previews.
Apple's own answer is in the system log: `/usr/bin/log show --last 5m --predicate 'process == "moondog-music"'` (zsh's built-in `log` is another command).
`Client not found` there means the switch has not reached Apple's token service yet; for this App ID that took about a minute.

The helper's check also reports the account's storefront, and the core then searches that storefront's catalog, so its songs are ones MusicKit has; without it the core searches the Mac's region, or the US.

At the end of a queue MusicKit does not stop: it pauses, at the end of the last song or back at the start of the first.
The helper reports either as the end of the queue, so the window and the agent hear it as they do for previews.

`node native/build.mjs` builds the helper on its own: `native/build/moondog-music` for packaging, and `native/build/Moondog Music.app`, signed with the Developer ID, for `npm start`.
To ask it directly, run `"native/build/Moondog Music.app/Contents/MacOS/moondog-music"` and type `{"id":1,"type":"check"}`.

## Look at every state

`npm run harness` draws the window against a stand-in core (`harness-preload.cjs`) with fictional songs and conversations, and saves a picture of each state, in light and dark, to `release/harness/`.
It needs no model, no music service and none of your data.
`MOONDOG_HARNESS_STATES=empty,reply` picks states, `MOONDOG_HARNESS_SIZE=900x700` changes the size, `MOONDOG_HARNESS_LOCALE=zh` the language, and `MOONDOG_HARNESS_SHOW=1` opens a window to try by hand.
`MOONDOG_HARNESS_STATES=long MOONDOG_HARNESS_EVAL=check-ui.mjs npm run harness` checks tooltip timing and themes, the record handoff and corner placement, and pin feedback in both themes.
An evaluation failure exits with a nonzero status.

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
- The terminal plays Apple Music previews; only the window plays whole songs.
- The app does not update itself yet; install a new build over the old one.
- The build is for Apple silicon only.
