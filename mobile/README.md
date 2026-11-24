# Moondog for iPhone

This React Native app plays Apple Music on the iPhone and talks to the personal Moondog agent on a Mac over Tailscale.
The Mac reads its existing model settings, listening profile, library and memory.
On connection, the phone opens the conversation currently selected on the Mac.
Messages use the same local conversation store and agent turn lock as the desktop and terminal.
Apple Music plays on the phone when the request comes from the phone.
The iPhone stores its connection details in Keychain.

## Start the Mac host

Install the root dependencies and the mobile dependencies from this checkout.

```sh
npm ci
cd mobile
npm ci
npm run host
```

Keep the host running while using the phone.
It asks the Tailscale client for its IPv4 address, prints the address, and listens on port `47831` on that interface.
In another terminal in `mobile`, run `npm run --silent host -- --show-key` and copy the pairing key into the app.
Both devices need to be on the same tailnet, with access from the phone to that port.
To run against the same Mac from Simulator, use `MOONDOG_PHONE_HOST=127.0.0.1 npm run host` and enter `127.0.0.1` in the app.

## Build the iPhone app

Use Xcode with the iOS SDK and CocoaPods on the Mac.
From `mobile`, generate the local Xcode project with `npx expo prebuild --platform ios`.
For a simulator build with the JavaScript bundle embedded, run `npm run ios -- --configuration Release`.
For an iPhone, open `ios/Moondog.xcworkspace`, select your signing team and iPhone, and build with the Release configuration to use it away from Metro.
The iPhone and Mac clients use the same bundle ID, `ai.audiofool.moondog`.
For subscription playback, sign with the team that owns its MusicKit-enabled App ID and an iOS provisioning profile for the device.
If building under another team, choose your own bundle ID in `app.json` and enable MusicKit for that App ID before generating the project.
The Swift module lives in `modules/moondog-music/ios`; the generated Xcode project stays local.

## Listen

Enter the Mac address and pairing key, tap **Connect**, then **Connect Apple Music**.
Ask for a song or tap the record to ask Moondog to choose.
Tap the current title to see the queue, use the playback buttons, or ask Moondog to pause or skip.
The system player supports background audio and reports the actual entry when the app returns to the foreground.
New conversations with the agent need the host online.
An existing queue plays on the phone when the Mac connection drops, subject to Apple Music availability.

Run `node --test host/room.test.mjs` from `mobile` to exercise the private connection, a Pi tool call, the phone receipt, and reconnect using fictional music and a test model.
