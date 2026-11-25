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
npm run host -- --copy
```

Keep the host running while you use the phone.
It asks Tailscale for this Mac's IPv4 address and listens on port `47831` on that address only.
`--copy` puts a pairing link on the clipboard; on the iPhone, Universal Clipboard makes it ready for the app's Paste button.
Without it, `npm run --silent host -- --show-key` prints the key to type by hand.
Both devices need to be on the same tailnet, and the phone needs access to that port.

## Build the app

Open `Moondog.xcodeproj` in Xcode, choose your iPhone, and run the Moondog scheme.
The project has no packages or generated files; the Swift sources are in `Moondog/`.
It needs iOS 26 or later.

The app uses the bundle ID `ai.audiofool.moondog` and team `DAK5S3455A`.
Playing whole songs needs the MusicKit service on that App ID in the Apple Developer portal.
To build under another team, change the team and bundle ID in the target's Signing settings, and turn on MusicKit for your own App ID.

The record above the conversation is the terminal's lunar record in dots, the same frames the desktop window draws; the small mark in the bar is the logo's vector form.
After a change to `src/surfaces/cli/terminal-art.mjs` or `src/surfaces/brand/logo.mjs`, run `npm run logo` here to write `Moondog/record-dots.json` and `Moondog/logo-figure.json`, and `node scripts/generate-logo.mjs` from the root for the app icon.

## Try it in Simulator

Simulator can't play Apple Music, so there the app acts out the queue without sound.

```sh
npm run demo
```

The demo host listens on `127.0.0.1` with made-up songs and a scripted host, and uses no profile, model, or key of yours.
It prints a pairing link; copy it into Simulator with `xcrun simctl pbcopy booted`, then tap Paste in the app.

## Listen

Paste the pairing link or type the address and key, then allow Apple Music when the room asks.
Ask for something, or tap the record and Moondog picks.
Tap the song above the composer to see where it is and what comes next.
The system player keeps playing in the background, and the lock screen controls report back to the Mac.
New requests need the Mac online; a queue already playing keeps playing when the connection drops.

`npm test` runs the host's test: the private connection, a Pi tool call, the phone's receipt, and a reconnect, with made-up music and a test model.
