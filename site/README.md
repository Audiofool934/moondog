# Moondog Project Page

This folder builds Moondog's project page at <https://moondog.audiofool.ai>.
It opens on Moondog's own window, the desktop app's renderer, playing a short scene with a made-up listener and made-up songs, with music made by Stable Audio 3.
The window fills the first screen; what Moondog is, and the download, come right under it.
The page loads only its own files, and Cloudflare's Web Analytics, which Cloudflare adds to the pages it serves; its content security policy allows nothing else.

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

The window waits on a new conversation with the record's arm up, and the page's cover asks the visitor in with sound ("Experience Moondog"); a quiet link watches without it.
The record doesn't answer the visitor's pointer before that.
The click turns the sound on; the cover's words fade, and the scene's pointer takes over from where the click landed, glides to the record's arm, and clicks it.
As in the app, the click asks for "Play something for right now", and the station's ident plays while Moondog picks three songs; the needle goes down as the first one starts.
Then a request for a late train home is typed and answered, and the record takes the whole window.
The needle lifts, the music stops, and the record glides back to a new conversation, where the scene began, so the scene plays again in place, with no reload.
Without a click, the scene begins silently after ten seconds on screen, the scene's pointer clicks the arm, and the Sound switch shows itself once.
The window is the real one: `app/renderer` and `app/window-room.mjs` run unchanged, so a change to the app's window shows here too.

- `window/host.mjs` stands in for the app's preload and core process, and starts the scene.
- `window/scene.mjs` holds what happens: each exchange's steps, reply and songs, and the drawn covers.
  The listener is the demo history's (`src/demo/fictional-spotify-history.mjs`); the new artists are made up too.
- `window/agent.mjs` is the scene's Moondog: it runs each exchange's steps through the agent's events, starts its songs, and writes its reply at a reading pace.
- `window/application.mjs` keeps the scene's conversation and plays its songs as the Music app on a Mac would.
- `window/director.mjs` waits for the page to let the scene begin, then moves a pointer and types, as a visitor would: the record's arm, the player, the composer, and the record's full-window arrows.
  The scene runs only while the window is on screen.
  With reduced motion it shows the finished scene at once, with no pointer.
  Where the window is narrower than the app gives its player room, the player stays folded.

The cover playing in the window lights the whole page, as it lights the app's window: the frame reads its colours with the app's `coverPalette`, and the page paints them as three faint fields behind everything with the app's `moodColours` (`app/renderer/mood.mjs`).
The colours drift in over a few seconds, and hold while the window is off screen.

The two songs the scene plays have music, made with Stability AI's Stable Audio 3 Medium on a Mac through its MLX version (`~/Developer/stable-audio-3/optimized/mlx` on the Mac mini).
The page plays it from `static/scene/` when the visitor turns the sound on; `page.mjs` follows the scene's songs and fades between them.
The station's ident, which plays as the arm is clicked, was made the same way.
Each song is 32 seconds and the ident 6, made with `./sa3 --dit medium --decoder same-l --seconds N --seed N` and these prompts, then normalized to -16 LUFS (the ident, under the songs, to -20) with a true peak of -1.5 dB, faded out at the end, and encoded as AAC at 160 kb/s:

- `ident.m4a`, seed 11: "TrackType: Music, VocalType: Instrumental. A short late-night radio station ident. A stylus lands on a vinyl record with a soft crackle, then a warm Rhodes electric piano chord blooms over a deep, round bass note, with tape warmth and a gentle reverb tail. Calm, inviting, intimate. 76 BPM."

- `glass-highway.m4a`, seed 7: "TrackType: Music, VocalType: Instrumental, Genre: Electronic, Genre: Dream Pop. A warm, unhurried dream pop instrumental for driving at dusk on an empty highway. Soft analog synth pads glow like the last light of the day, a round pulsing bass keeps a gentle motion, and a drum machine plays a soft, steady beat with brushed hi-hats. A chiming clean electric guitar repeats a simple, wistful motif, with tape warmth and a little reverb. Nostalgic, calm, slightly melancholic. 92 BPM."
- `last-tram-home.m4a`, seed 21: "TrackType: Music, VocalType: Instrumental, Genre: Downtempo, Genre: Jazz. A late-night downtempo instrumental for the last tram home through a quiet city. A close-miked Rhodes electric piano plays soft, tired chords, a warm upright bass walks slowly, and brushed drums keep a relaxed swing. A distant city hum and the gentle rhythm of rails sit under the music, with warm tape saturation and soft reverb. Intimate, sleepy, tender, a little lonely. 76 BPM."

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
