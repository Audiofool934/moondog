// Builds Moondog.app for Apple silicon: the window from this folder, and the core as the
// npm package ships it, so the app runs the same core as `moondog` in a terminal.
//   node pack.mjs          unsigned, for a quick local check
//   node pack.mjs --sign   signed with the Developer ID and notarized; Apple's notary
//                          service reads the keychain profile in MOONDOG_NOTARY_PROFILE
//                          or APPLE_NOTARY_PROFILE (default mac-mini-notary).
//   node pack.mjs --sign --no-notarize
//                          signed only, for trying an update on this Mac: macOS installs an
//                          update signed by the same developer, notarized or not.
// Each build also writes latest-mac.yml beside the zip, beta or not; the app reads it from a GitHub
// release to find, download and check an update. Nothing is uploaded here.
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Arch, build, Platform } from "electron-builder";
import { buildMusicHelper, MUSIC_USAGE } from "./native/build.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const work = path.join(here, "build");
const room = path.join(work, "room");
const sign = process.argv.includes("--sign");
const notarize = sign && !process.argv.includes("--no-notarize");
// Unset, electron-builder finds the Developer ID Application certificate in the keychain.
const identity = process.env.MOONDOG_SIGNING_IDENTITY;

// The room: exactly the files `npm install -g @audiofool/moondog` gets, and its production dependencies.
await rm(work, { recursive: true, force: true });
await mkdir(room, { recursive: true });
const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], { cwd: root });
const [{ filename }] = JSON.parse(stdout);
await run("tar", ["-xzf", path.join(work, filename), "-C", room, "--strip-components=1"]);
await cp(path.join(root, "package-lock.json"), path.join(room, "package-lock.json"));
await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: room });

// The window's page.
await run(process.execPath, [path.join(here, "build.mjs")]);
// The Apple Music helper sits beside the app's own executable, so MusicKit knows it as Moondog;
// electron-builder signs it with the app.
const music = await buildMusicHelper({ bundle: false });

const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (notarize) process.env.APPLE_KEYCHAIN_PROFILE = process.env.MOONDOG_NOTARY_PROFILE ?? process.env.APPLE_NOTARY_PROFILE ?? "mac-mini-notary";
const artifacts = await build({
  projectDir: here,
  targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64),
  publish: "never",
  config: {
    appId: "ai.audiofool.moondog",
    productName: "Moondog",
    // The app and the room it carries share one version.
    extraMetadata: { version },
    directories: { output: "release", buildResources: "build-resources" },
    files: ["package.json", "main.mjs", "preload.cjs", "core-process.mjs", "window-room.mjs", "preview-player.mjs", "strings.mjs", "updates.mjs",
      "dist/**/*", "!dist/**/*.map"],
    // Where the app looks for updates (updates.mjs). A beta version also takes releases marked as prereleases.
    publish: [{ provider: "github", owner: "Audiofool934", repo: "moondog" }],
    asar: false,
    // The core sits beside the window's folder, where core-process.mjs imports ../scripts/moondog.mjs.
    // electron-builder leaves node_modules out of extra resources unless it is named on its own.
    extraResources: [{ from: "build/room", to: ".", filter: ["**/*"] },
      { from: "build/room/node_modules", to: "node_modules", filter: ["**/*"] }],
    extraFiles: music ? [{ from: "native/build/moondog-music", to: "MacOS/moondog-music" }] : [],
    mac: {
      category: "public.app-category.music",
      icon: path.join(root, "assets/brand/moondog-lunar-record/moondog-logo-1x1.png"),
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build-resources/entitlements.mac.plist",
      entitlementsInherit: "build-resources/entitlements.mac.plist",
      // Moondog reads what the listener plays in the Music app through Apple Events, which macOS asks them to allow.
      extendInfo: { NSAppleMusicUsageDescription: MUSIC_USAGE, NSAppleEventsUsageDescription: "Moondog reads what you play in Music, and the playlist it comes from." },
      identity: sign ? identity : null,
      notarize,
    },
    dmg: { title: "Moondog ${version}" },
  },
});
// The DMG and the zip are what ships. The unpacked app electron-builder leaves beside them
// would show up in Spotlight and Launchpad as a second Moondog, so it goes.
await rm(path.join(here, "release", "mac-arm64"), { recursive: true, force: true });
for (const artifact of artifacts) console.log(path.relative(here, artifact));
