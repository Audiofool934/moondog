# Moondog for iPhone

A native SwiftUI app that plays Apple Music on the iPhone and talks to Moondog on your Mac over Tailscale.
The phone is one more window on Moondog's core there, as the desktop app is.
The host runs the `moondog` command with the phone as its window, through the desktop window's own room (`app/window-room.mjs`) and player (`app/preview-player.mjs`).
So the conversations, the models, the library and On Air are the Mac's, shared with the desktop app and the terminal.
A conversation opened or started on the phone is the one the desktop shows too.
When a request comes from the phone, Apple Music plays on the phone, and the phone tells the Mac what actually plays.
The phone keeps the pairing in Keychain.

## Start the Mac host

Install the root dependencies and the host's one dependency from this checkout.

```sh
npm ci
cd mobile
npm ci
npm run pair
```

`npm run pair` shows a pairing code in the terminal and starts the host.
Scan the code in the app, or with the iPhone's Camera, which opens Moondog and pairs it.
It also copies the pairing link, which Universal Clipboard makes ready to paste when both devices use the same Apple ID.
macOS draws the code itself, so the host needs no package for it.
Once paired, `npm run host` starts the host without the code.
To type the key by hand, `npm run --silent host -- --show-key` prints it.

Keep the host running while you use the phone.
It reads the same settings, profile, library and memory as the desktop app, and the phone always plays on Apple Music, whatever the Mac plays on.
It prints a line for each queue it sends, and each step of starting songs on the phone, with the phone's own error when one comes back.
Music sent while the phone is away waits for it, for up to ten minutes.
Tracks Moondog makes on the Mac, as On Air does, reach the paired phone from the host, by id and with the pairing key.
It asks Tailscale for this Mac's IPv4 address and listens on port `47831` on that address only.
Both devices need to be on the same tailnet, and the phone needs access to that port.

## Build the app

Open `Moondog.xcodeproj` in Xcode, choose your iPhone, and run the Moondog scheme.
The project has no packages or generated files.
The app's Swift sources are in `Moondog/`, the Live Activity's in `MoondogActivity/`, and what both use in `Shared/`.
It needs iOS 26 or later.

The app uses the bundle ID `ai.audiofool.moondog` and team `DAK5S3455A`.
Playing whole songs needs the MusicKit service on that App ID in the Apple Developer portal.
The Live Activity extension uses `ai.audiofool.moondog.activity`.
To build under another team, change the team and bundle IDs in both targets' Signing settings, and turn on MusicKit for your own App ID.

The record is the terminal's lunar record in dots, the same frames the desktop window draws; drawn small, it uses a coarser grid of the same record so its dots stay dots.
After a change to `src/surfaces/cli/terminal-art.mjs` or `src/surfaces/brand/logo.mjs`, run `npm run logo` here to write `Moondog/record-dots.json`, `Moondog/record-dots-small.json` and `Moondog/logo-figure.json`, and `node scripts/generate-logo.mjs` from the root for the app icon and the Live Activity's mark.

## Try it in Simulator

Simulator can't play Apple Music, so there the app acts out the queue without sound, and each made-up song lights the room with colours taken from its title rather than a cover.

```sh
npm run demo
```

The demo host runs the desktop's window room on `127.0.0.1` with made-up songs, two made-up models and a scripted host, and uses no profile, model, or key of yours.
Ask it to make something, and it writes a short tone as a made track and plays it from the host, the way On Air's tracks come.
It prints a pairing link; open it in Simulator with `xcrun simctl openurl booted '<link>'`, or copy it with `xcrun simctl pbcopy booted` and paste it in the app.

## Listen

Scan the pairing code, then allow Apple Music when the room asks.
Ask for something, or tap the record and Moondog picks.
Once there are words, the record moves into the bar, small and still turning; it plays and pauses there too.
A tap on the conversation, or sending a message, puts the keyboard away.
Tap the song above the composer to see where it is and what comes next; tap a song in Up next to play it, or press it to take it out, and the bookmark keeps what plays in Saved.
The list button at the top left opens the sidebar, as on the desktop: Chats, Library and Taste in a row of glass, with a new conversation beside Chats and Settings at the end.
Chats lists every conversation on the Mac, pinned first and then by folder; swipe one to pin or delete it, or press it to rename it.
The pencil beside the list button starts a new conversation too.
The library plays a playlist from the top, shuffled, or from any song in it.
Taste lists the artists and tracks your profile rests on, as the desktop's taste view does; open one to see why it's there, like it, keep it out, or find more like a track.
The model beside the send button is this conversation's, from the models set up on the Mac, with its thinking levels.
When the Mac can make music, the radio button goes on air as the desktop's does, by asking Moondog; while it is on, the On Air mark stops it.
As on the desktop, the playing cover's colours tint the record's grooves and light the room faintly.
The button at the top right opens the record alone: it grows out of its place to fill the screen over the cover's light, and keeps the screen on.
Tap the record to play or pause; swipe down, or tap beside it, to send it back.
Away from the app, a Live Activity puts the logo in the Dynamic Island and on the Lock Screen with the song and what the host is doing or last said.
The system player keeps playing in the background, and the Lock Screen controls report back to the Mac.
Leave the app while Moondog works and the reply still arrives for a short while; songs it picks start if iOS allows, and otherwise the moment you are back.
New requests need the Mac online; a queue already playing keeps playing when the connection drops.

`npm test` runs the host's tests: the phone's port (the room drawn again on connect, music kept while the phone is away, messages both ways) and the made-track route (paired phone only, byte ranges).
