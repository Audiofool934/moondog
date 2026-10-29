# Moondog desktop

A native window on the same core as the `moondog` command, as a desktop app is to its command line.
The application, agent, Spotify, profile and memory services are shared; the window draws its own surface.
Build targets are macOS on Apple silicon, Windows x64, and Linux x64.
Windows and Linux use the same renderer and core, with native window controls and Control shortcuts.
Full Apple Music playback through MusicKit and reading the Music app are macOS features; Apple Music previews and Spotify work through the shared desktop services.

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

- The first launch asks once, over the empty room, where you listen and which model Moondog uses.
  Each step shows the same rows as Settings, under a question and without Settings' other places.
  First come Spotify, Apple Music, and NetEase Music once it is ready, each by its mark; then the model's accounts, with sign-in in the browser or with an API key.
  Choosing a service saves it and moves on; the model step ends once a model can answer, and the core then ends the first run by itself.
  A step already done is not asked: a service saved in the terminal leaves only the model.
  The close button, or Esc, skips the rest; a click beside the sheet does not.
  Spotify's account and NetEase's setup stay in Settings › Playback.
  The terminal shares the first run (`first-run.json` beside `playback.json`), so one finished or skipped there closes it here within a few seconds, and it never comes back on either side.
  Settings opened while it asks takes the sheet, and the first run returns when Settings closes.
- Before anything is said, the lunar record stands alone over the composer, drawn as dots from the terminal's own record.
  It turns while music plays and rests when it stops, coming up to speed and running down like a platter.
  Its tonearm rests on it while music plays and swings off when the music stops; a click on the arm pauses, and another plays.
  A pointer near the arm lights it in its own dots without moving it: the arm's dots fill out as the pointer comes closer, and swell most around the pointer, so the light follows it along the arm.
  With nothing loaded on any player, a click on the arm asks Moondog for a song, as the words "Play something for right now" would in the open conversation; the arm goes down at once and waits on the still record, and the record turns when the music starts. A reply that starts no music lifts the arm a few seconds after it ends. A paused song is still loaded, so the arm resumes it.
  The wheel over the record scratches it: the record turns with the wheel, the song's place shows just above it and on the player's progress line, and the music goes there once the wheel rests, in one seek.
  A slow wheel moves finely; a quick one covers more of the song.
  A turn of the wheel belongs to what it starts on until the wheel rests. Above the words, the record takes it only from a pointer put on the disc or its arm; a record that grew or moved under a still pointer, its square's empty corners, and a song that can't move leave the wheel to the words.
  Its grooves take the three colours of the cover that is playing, from the rim inward, and drift into the next song's; the dog and the arm stay in ink.
- In a conversation the record stays above the words, and the conversation runs between it and the composer.
  It is full size at home, where the latest exchange starts: the newest message just under the record, or the end of the words when everything after that message fits.
  Moving away from home, up into history or down a long reply, shrinks it as you scroll, to half its size and no smaller.
  Its size follows where the view is and nothing else, so it never jumps, and it is the same size each time the view rests at the same place. A reply growing below the view leaves it as it is.
  Shrinking and growing follow the hand at once.
  A glide (the round button, a request mark) takes it straight from its size where the glide starts to its size where the glide ends.
  The room above the first words is what the record takes at the top of the conversation, so it changes when the conversation does, never while you scroll, and the words never move under your hand.
  Its dots are drawn at the size the window shows, on the screen's pixels, so a smaller record never shimmers with moiré.
  A click on the record, or `⌥⌘R`, folds it into a small mark in the middle of the title bar and keeps it there; a click on the mark opens it and returns home under it.
  Where the bar has no room between its controls, the title gives way first, then the mark.
  Hovering the record offers a full-window view at the lower-right corner of its square, clear of the disc: two arrows with no frame, which darken and open a little under the pointer.
  The full-window view can shrink to a small square; the pin turns upright and solid when it keeps the window on top.
  The arm and the wheel work there as above the words. A click anywhere else in it, or Esc, returns to the conversation; a drag moves the window. The pin also locks the view: while it is on, clicks and Esc stay on the record, and a second click on the pin releases it. The page moves the window itself, because a native drag region never passes it the click.
- Conversations on the left are the terminal's conversations, in both directions: one started here shows up in `/resume`, and the other way round.
  While the window shows, a conversation or folder saved in the terminal appears within about two seconds; the core asks SQLite whether another process wrote to the memory store, so nothing is sent when nothing changed.
  The window and the terminal show the same conversation: the one either opened last, with `/new`, `/resume`, `/branch`, Branch, the sidebar or a launch.
  An edit made in either, with Edit here or `/rewind` there, shows in the other.
  A branch carries its place in the conversation's lineage until it is renamed, "Late night #2"; the number stays in sight when the title is cut short.
  A message sent in the terminal appears here, and its reply grows here as it is written; the other way round too.
  One of them answers at a time: a message sent while the other answers comes back to the composer here and waits in the queue there.
  Pinned ones come first, then folders, then the rest by day.
  A row's `⋯` button or a right-click renames, pins, moves it to a folder, or deletes it after asking.
  Dragging a row onto a folder files it there. `⌘N` or the pencil in the title bar starts a new conversation.
  From the keyboard, Up and Down move between conversations, and the context menu key or Shift+F10 opens a row's menu.
  Several rows can be chosen as in Finder: `⌘`-click adds or removes one, starting from the open conversation, and Shift-click or Shift+Up and Shift+Down choose a run of them.
  The menu of a chosen row, a drag of one, or `⌘⌫` then pins, files, or deletes all of them at once; a delete still asks first.
  A plain click, Esc, or a click on the list's empty space lets the selection go.
- Several conversations can answer at once, up to four; a breathing dot marks one that is still answering, and you can switch away and back.
- The conversation in the middle: your words in a bubble, Moondog's in serif type.
  While Moondog works, one quiet line says the step it is on; after a turn, the song it started takes that line, with its cover.
  A reply that failed offers Try again.
- In a long conversation, a mark for each request sits at the right edge: hover one to read it, click to go back to it.
  The view rests at home while the conversation changes: a message you send, or a conversation you open, shows from its message, and a reply longer than the window grows below for you to scroll, with the round button showing.
  Scrolling to the end, or the round button, rests the view at the end instead, where a reply still being written stays in view. Only a hand on the scroll (the wheel, keys, the scrollbar) lets go, so the window never pulls the view back from under it. Page Up and Page Down scroll from the composer.
  Under each message, while the pointer is on it, Copy copies its words.
  Your own saved messages also have Edit, as `/rewind` in the terminal: the message opens in its own place, Enter sends the new words there and the replies after it go, and Esc leaves it as it was.
  Moondog's saved replies also have Branch, as `/branch`: a new conversation goes on from that reply, and the original stays among the conversations.
- What is playing on the right: a large cover that tints the panel with its own colours, the song, a progress line you can drag to move in the song (or focus it and use the arrow keys, five seconds a press, fifteen with Shift), previous, play or pause, and next.
  Where the music plays, under it, opens Spotify's devices and the choice between Spotify and Apple Music; while Apple Music plays, it reads Apple Music.
  A control Spotify won't take right now, such as skipping on a free account, is dimmed.
  Music you play yourself in the Music app on this Mac shows here too, with the next songs of its playlist, and the buttons act on it there.
  When it and Spotify both play, the one that plays wins over a paused one, then the chosen service; a player you just pressed stays in view for 30 seconds.
  macOS asks once before Moondog may read the Music app.
  The player opens only when you open it: it starts folded, a song starting never opens it, and it folds again when nothing is left to play.
  With the player folded away, the song shows at the end of the title bar with play or pause and next; a click on the song opens the player.
- Drag the inner edge of either side panel to change its width; a double-click puts it back.
  The conversations open as you last left them.
- Beside the send button, the music service and the model, each by its mark (from Simple Icons, and Lobe Icons for the model makers Simple Icons lacks), with its name in the tooltip.
  A model shows its maker's mark, through OpenRouter or an endpoint too, by the maker its id names; a maker the window has no mark for shows a plain model glyph.
  The service's menu switches among the services that can play now: Apple Music, Spotify once connected, and NetEase Music once ncm-cli is signed in, with the one in use always listed.
  Connecting Spotify and setting up NetEase happen in Settings › Playback, not in the menu.
  Asking Moondog for another service switches too, within the same reply; the menu, the terminal and every conversation follow one saved choice, and the service left behind stops playing.
  Leaving Apple Music pauses the Music app too. Moondog can also pause, resume and skip the Music app itself, so "switch to Spotify and keep playing there" pauses one and picks the other up where it stopped.
  One thing plays at a time on this Mac: music Moondog starts pauses the Music app, Spotify when it plays on this Mac, and NetEase; music you start in the Music app stops Moondog's own player.
  The model's menu shows the models kept in Settings, flat, the one this conversation uses checked, and how hard it thinks.
  A model chosen there is that conversation's alone, and the conversation keeps it after a restart; a new conversation starts on the default, which Settings sets and the terminal uses.
  While the first run still asks for a service, the service reads "Choose a music service", as the model reads "Choose a model" until there is one.
- Typing `/` lists commands by what they open (a mistyped one stays in the composer instead of going to Moondog): `/new`, `/model`, `/language`, `/service`, `/device`, `/import`, `/memory`, `/remember`, `/folder`, `/settings` and `/help`.
- Settings (`⌘,`, or the button at the top right beside the player's) has Language, Model, Playback, Import, Memory and About.
  Model lists the menu's models with the default named, one thinking scale for every model (a level a model lacks reaches it as the nearest lighter one), and the providers: OpenAI by a ChatGPT subscription or an API key, then Anthropic, Google and xAI by key, any other Pi provider once it has a key, and endpoints.
  An endpoint is any service that speaks OpenAI's Chat Completions or Anthropic's Messages, added by its address, an optional key and its model IDs (asked of the endpoint when left empty).
  Opening a provider lists its models, each ticked when the menu offers it.
  Playback has one row per music service, its state under its name and the one in use checked.
  A click on a row unfolds that service's setup or its own controls (Spotify's devices and Disconnect), one row at a time.
  With the pointer on a row, a service that can play shows a switch at its right that uses it, and one that can't yet shows Set up.
  Changes are saved where the terminal reads them; the window never sees a key or token.
  The menu's list is `models.json`, each conversation's own model is `conversation-models.json`, and endpoints are `endpoints.json` (mode 600, with their keys), beside `settings.json`, so older Moondogs that read `settings.json` by a fixed shape keep working.
  OpenAI keeps a ChatGPT sign-in or an API key in `auth.json`; Moondog 0.2.0-beta.7 and older can't read a ChatGPT sign-in there.
  A model or a sign-in saved in an open terminal reaches the window within a few seconds, and the other way round; a reply that is running keeps its model until it ends.
- Import: choose a Spotify, Apple Music, ListenBrainz or Last.fm export, read recent Spotify listening, read a Last.fm account (the window asks for a Last.fm API key the first time), or drop a file anywhere on the window.
  The preview uses the terminal's words, nothing is saved until you add it, and the updated profile then shows in the conversation.
- Apple Music plays whole songs where it can and 30-second previews where it can't.
  Whole songs come from a small helper beside the app's executable (`native/music.swift`) that plays the Apple Music catalog through MusicKit, so they need an Apple Music subscription and the listener's permission, which Settings › Playback asks for once.
  Until the helper can play, the window plays previews in itself, with media keys and the system's Now Playing.
- NetEase Music (网易云音乐) plays through NetEase's own command line tool, for listeners in mainland China.
  Settings › Playback always lists it; until `npm install -g @music163/ncm-cli`, `brew install mpv` and `ncm-cli login` are done, its row says what is missing and unfolds the setup, whose Check again says why a check still fails.
  ncm-cli keeps its own key and sign-in, and Moondog never reads them.
  The window looks for ncm-cli on its PATH, in Homebrew's folders, and then on the PATH of the listener's interactive shell, where Node managers such as nvm add their folders.
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
  On Windows and Linux, Control replaces Command in editing shortcuts and in New, Settings and Stop.
  There, Ctrl+Shift+S, Ctrl+Shift+P and Ctrl+Shift+R show or hide the conversations, the player and the record.
  Alt+Shift+P plays or pauses, and Alt+Shift+Right and Alt+Shift+Left skip.
  These keys avoid Control with Alt, which is AltGr on many Windows keyboards, and GNOME's keys for moving windows between workspaces (`platform.mjs`).
  Press Alt to open the application menu on Windows or Linux.
- Language: the window speaks the language the core speaks, which follows the choice in Settings or `/language`, then the system's language.
  The window's words, its menus included, exist in English, Simplified and Traditional Chinese, Japanese, Korean, Spanish, French, German, Brazilian Portuguese and Italian (`strings.mjs`).
- Closing the window on macOS hides it, and the music keeps going until you quit.
  On Windows and Linux, closing the window quits and saves the conversations.
  Opening Moondog again while it runs shows the open window; one profile never runs two cores.
  When Windows shuts down or signs out, it waits the few seconds Moondog needs to save a reply in progress.
  A reply in progress shows in the Dock or taskbar; the Mac Dock icon's menu plays, pauses and skips.
- Links open in your browser.

## How it fits together

- `main.mjs` opens the window, builds the localized menu, and starts the core in its own Node process.
- `core-process.mjs` runs `scripts/moondog.mjs` with a host that registers `runRoom`, so the command builds everything as it does for the terminal and hands it to the window instead of the terminal room.
- `window-room.mjs` is the core's side of the window: turns stream back as text and activity, sessions open and close, and Spotify's player state is read after every playback action, just after the playing song should end, when the window gains focus (at most every 10 seconds), and every 30 seconds in a showing window (every minute in a hidden one); the clock runs on its own between reads.
  Every read counts against the listener's Spotify app quota; when Spotify answers that the quota is used up, the window reads nothing until the time Spotify gave and says so.
  Each conversation that answers beside the first gets its own application and agent from `openConversation`, on the same memory and Spotify.
  Settings go through the services the terminal uses: `modelSettings` for providers, sign-in, the menu's list and endpoints, `rebuildRuntime`, `saveRuntimeSelection` for the default, `saveLanguage`, `savePlaybackService` and the import services.
- `renderer/` draws the window: `sidebar.mjs` (conversations and folders), `settings.mjs` (the Settings sheet), `palette.mjs` (slash commands), `previews.mjs`, `record.mjs` (the turning record), `ui.mjs` (icons, tooltips, the overlay scrollbar), and `renderer.mjs` for the rest.
  Every colour, size, corner and duration is a token in `tokens.css`; `style.css` and `sheet.css` use only the tokens.
  Replies render from Markdown into DOM text nodes (`markdown.mjs`), so a reply can't inject markup.
- Menus for a conversation and the model, device and service pickers are native menus, built in `main.mjs` from plain items the page sends.
- One message port carries everything between the core and the window, including the previews the agent plays.
- The project page plays a scripted scene in this renderer and `window-room.mjs`, unchanged, in a browser, with `site/window/host.mjs` in place of the preload and the core process, so a change here shows there too (`site/README.md`).

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

`node native/build.mjs` builds the helper on its own: `native/build/moondog-music` for packaging, and `native/build/apps.noindex/Moondog Music.app`, signed with the Developer ID, for `npm start`.
To ask it directly, run `"native/build/apps.noindex/Moondog Music.app/Contents/MacOS/moondog-music"` and type `{"id":1,"type":"check"}`.

## Look at every state

`npm run harness` draws the window against a stand-in core (`harness-preload.cjs`) with fictional songs and conversations, and saves a picture of each state, in light and dark, to `release/harness/`.
It needs no model, no music service and none of your data.
`MOONDOG_HARNESS_STATES=empty,reply` picks states, `MOONDOG_HARNESS_SIZE=900x700` changes the size, `MOONDOG_HARNESS_LOCALE=zh` the language, and `MOONDOG_HARNESS_SHOW=1` opens a window to try by hand.
`MOONDOG_HARNESS_STATES=long MOONDOG_HARNESS_EVAL=check-ui.mjs npm run harness` checks tooltip timing and themes, the record handoff and corner placement, and pin feedback in both themes.
With `first-run`, `first-run-model-only` and `first-run-netease` among the states, it also checks the first run: both steps from the keyboard, one ended in the terminal, and one skipped with Esc.
The `first-run-*` states draw its steps, sign-ins and skip tooltip on their own.
An evaluation failure exits with a nonzero status.

## Build the app

Run `npm run pack` on the target operating system and architecture.
It uploads nothing, and writes these files:

| Build host | Desktop package | Update metadata | Folder |
| --- | --- | --- | --- |
| macOS, Apple silicon | DMG and zip, for local QA | `latest-mac.yml` | `release/qa.noindex/<version>/` |
| Windows, x64 | NSIS installer `.exe` | `latest.yml` | `release/` |
| Linux, x64 | AppImage | `latest-linux.yml` | `release/` |

Builds use the host's production dependencies, so cross-compiling from another operating system is not supported.
Windows builds need Node.js, npm, Git, and the `tar.exe` in System32 that Windows 10 and later include.
The npm package lists macOS and Linux only, because the terminal launcher is a shell script.
On Windows, install the root dependencies with `npm ci --force`; `npm run pack` skips the same check for the app's copy of the core.
The installer installs for the current Windows account and preserves personal data on uninstall.
On Linux, make the AppImage executable before opening it; distributions without FUSE can use AppImage's extract-and-run mode.
`npm run pack:dir` leaves an unpacked app under `release/qa.noindex/<version>/` for `npm run smoke` to check.
The smoke check opens the packaged renderer and core with empty temporary data, imports fictional history, and quits.
It removes provider credentials from its environment and disables the system Music app and MusicKit helper with `MOONDOG_SYSTEM_MUSIC=off`.

`MOONDOG_SMOKE_EXECUTABLE` points the smoke check at an installed `Moondog.exe` or an AppImage instead.

The [Desktop builds workflow](../.github/workflows/desktop.yml) builds on Windows and Linux, and saves the installers and update metadata as workflow artifacts.
It runs the smoke check on what a listener gets: the app that the Windows installer installs, and the AppImage in extract-and-run mode.
It does not publish a GitHub release.
Windows CI builds are unsigned; a signed Windows release needs the maintainer's signing certificate configured through electron-builder's `CSC_LINK` and `CSC_KEY_PASSWORD`.

On a Mac, `node pack.mjs --dir --sign --no-notarize` leaves a signed QA app in `release/qa.noindex/<version>/` without submitting it to Apple.
`npm run release` builds a signed, notarized app, ZIP and DMG, verifies the exact files, and records a release manifest in `release/`.
Formal builds require a clean checkout and a working Apple Music helper.
The helper's compiler errors stop the release instead of silently reducing playback to previews.
The build's command helper shows progress and allowlisted failure codes without echoing command arguments or captured output.
Keep raw tool diagnostics private if a failed step needs further investigation.

- The app carries the core exactly as the npm package ships it: `npm pack` decides the files, and `npm ci --omit=dev` adds their dependencies.
- Signing needs the Developer ID Application certificate in the login keychain.
  Notarization uses `MOONDOG_NOTARY_PROFILE`, then the shared `APPLE_NOTARY_PROFILE`, then `mac-mini-notary`.
  The Mac mini stores one `mac-mini-notary` profile for all products in the same developer team.
  To configure another machine, run `xcrun notarytool store-credentials mac-mini-notary --team-id <your team ID>` and enter the Apple ID and app-specific password at the secure prompts.
  `MOONDOG_SIGNING_IDENTITY` selects a different certificate.
  Keep passwords in Keychain; profile names and environment variables contain no password.
- The app records its source commit, version, build number and signing team inside the signed bundle.
  Publication verifies that record, both apps inside the ZIP and DMG, their signatures and notarization tickets, and every update checksum.
- Interrupted notarization resumes the recorded submission in `release/.state/<version>/`.
  Keep that directory and its original artifacts until the release finishes.
  Rerun the same command from the same commit; changed artifacts are rejected instead of submitted again.
- Opened from the Dock or Finder on macOS, the app has a minimal `PATH`, so the core gets the `PATH` of a login shell, as in a terminal.
  Programs such as `codex`, which web research can use, keep working.
  Windows and Linux inherit the desktop session's environment.
- The packaged core has no npm update notice, because the app updates as a whole.

## Updates

The packaged app updates itself from this repository's GitHub releases (`updates.mjs`, with electron-updater).

- It checks at launch and every six hours, and downloads nothing until you ask.
  A beta version also takes releases marked as prereleases; a stable version takes only the others. It never goes back to an older version.
- A newer build shows at the top right, before Settings, as a small solid button whose tooltip names the version.
  A click downloads it, the ring around the button fills as it arrives, and Moondog restarts into the new version when the download ends.
  A failed download leaves the installed app as it is and the button in place, so another click tries again.
- Moondog › Check for Updates… checks at once; with a newer build offered the item reads Download and Install Update, and once one is downloaded, Restart to Update.
- The check reads the release list and sends nothing about the listener.
  A failed check or download leaves the installed app as it is, and the next check tries again.
- macOS installs only a build signed by the same Developer ID team.
  Windows installs the NSIS update, and Linux replaces the AppImage; both then open the new version.
  Each download must match the SHA-512 checksum in that platform's update metadata.
- Updating replaces the app only. Profile, history, conversations and sign-ins stay where they are.
- Before starting the installer, Moondog stops its old core and waits for it to exit.
  A failure to stop it leaves the downloaded update available for another explicit attempt.
  On Linux the new version starts only after the old app has exited, so it never finds the old one still running.

To publish an update:

1. Bump the version at the repository root (`package.json` and `package-lock.json`), commit and push it.
   The app compares versions, so a build with an unchanged version never reaches anyone.
2. Push the tag, `v` and the version.
   `Publish release` checks it, waits for the owner's approval in the `npm` environment, publishes or verifies the npm version, and prepares a GitHub draft.
   The desktop updater continues to see the previous complete release while the draft is prepared.
3. Right after pushing the tag, on the Mac mini, in a clean worktree at the tag, run `npm ci` at the root and here, then `npm run publish-app`.
   It builds and verifies the artifacts while the workflow runs, then waits up to an hour for the npm version and the draft, so the approval can come before or after the build.
   It uploads the ZIP, blockmap, DMG and release manifest to the draft together and the update metadata last, then publishes the complete release and rebuilds the project page.
   `--skip-build` requires the recorded build manifest and verifies its artifacts again.
   `--create` prepares a missing draft; it does not bypass npm or artifact verification.
   Existing remote assets with identical hashes are reused.
   Different bytes under the same filename are rejected; release a new version instead of overwriting a published build.
4. For Windows and Linux, build that same tag through the Desktop builds workflow or on a native host, and check the smoke results.
   Once `publish-app` has published the release, upload the installer or AppImage and its blockmap, then that platform's update metadata last.
   Rebuild the project page after uploading so it can offer the new platform downloads.
   CI artifacts alone do not establish a signed, published, or manually tested desktop release.

If publication tooling needs a fix after a version is tagged, keep its original artifacts and manifest.
From a clean checkout of the repaired tooling at the same package version, place those files in `app/release/` and run `node publish.mjs --skip-build --from-tag vX.Y.Z` from `app/`.
This mode never rebuilds the app and binds the artifacts, embedded source, build number and npm commit to the original local and remote tag.
Use `--verify-only --from-tag vX.Y.Z` to perform those checks without uploading.
Never move the tag or replace the version's artifacts.

To try an update before publishing it, build two versions with `node pack.mjs --sign --no-notarize` (signed, not notarized), serve the newer one's zip, `.blockmap` and `latest-mac.yml` over HTTP, and start the older app from a terminal with `MOONDOG_UPDATE_FEED=http://127.0.0.1:8765`.
Set `MOONDOG_CONFIG_HOME`, `MOONDOG_STATE_HOME` and `MOONDOG_APP_USER_DATA` to empty absolute folders too, so the test app never opens your own profile or window preferences.
Give both disposable bundles a unique matching bundle ID and a unique `updaterCacheDirName`, then sign each bundle.
Squirrel's caches and installer job belong to the bundle ID; `MOONDOG_APP_USER_DATA` alone does not isolate them.
With that feed, a click on Update downloads the newer build, installs it and quits without restarting, because a restarted app would have none of these settings and would open your own profile; start it again from the terminal with the same settings.
Also verify the normal published restart path: the old core must exit before the installer can launch the new app.
Extract test copies into a folder whose name ends in `.noindex`, so Spotlight doesn't offer them.

## Not yet

- The full taste report happens in the terminal (`moondog`).
- The terminal plays Apple Music previews; only the macOS window plays whole songs.
- Builds from before the updater have none: install the first build with it by hand, as before.
- Mac builds target Apple silicon; Windows and Linux builds target x64.
- The Windows desktop does not require Node.js or npm at runtime.
  The terminal's shell launcher and `moondog update` remain supported on macOS and Linux.
- Optional Codex web research on Windows needs `codex.exe` on PATH or a native executable selected by `MOONDOG_CODEX_BIN`.
  The npm `codex.cmd` wrapper is not launched by that integration.
