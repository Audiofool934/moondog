# Moondog for iPhone

A native SwiftUI app that plays Apple Music on the iPhone and talks to the Moondog agent on your Mac over Tailscale.
The Mac reads its own model settings, listening profile, library, and memory.
On connection, the phone opens the conversation that is selected on the Mac.
Messages use the same conversation store and agent turn lock as the desktop app and the terminal.
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
It prints a line for each song it sends, holds or loses, with the phone's own error when one comes back.
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

The demo host listens on `127.0.0.1` with made-up songs and a scripted host, and uses no profile, model, or key of yours.
It prints a pairing link; open it in Simulator with `xcrun simctl openurl booted '<link>'`, or copy it with `xcrun simctl pbcopy booted` and paste it in the app.

## Listen

Scan the pairing code, then allow Apple Music when the room asks.
Ask for something, or tap the record and Moondog picks.
Once there are words, the record moves into the bar, small and still turning; it plays and pauses there too.
A tap on the conversation, or sending a message, puts the keyboard away.
Tap the song above the composer to see where it is and what comes next.
As on the desktop, the playing cover's colours tint the record's grooves and light the room faintly.
The button at the top right opens the record alone: it grows out of its place to fill the screen over the cover's light, and keeps the screen on.
Tap the record to play or pause; swipe down, or tap beside it, to send it back.
Away from the app, a Live Activity puts the logo in the Dynamic Island and on the Lock Screen with the song and what the host is doing or last said.
The system player keeps playing in the background, and the lock screen controls report back to the Mac.
Leave the app while Moondog works and the reply still arrives for a short while; a song it picks starts if iOS allows, and otherwise the moment you are back.
New requests need the Mac online; a queue already playing keeps playing when the connection drops.

`npm test` runs the host's test: the private connection, a Pi tool call, the phone's receipt, and a reconnect, with made-up music and a test model.
