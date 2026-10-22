// Builds Moondog.app for Apple silicon: the window from this folder, and the core as the
// npm package ships it, so the app runs the same core as `moondog` in a terminal.
//   node pack.mjs          unsigned, for a quick local check
//   node pack.mjs --sign   signed with the Developer ID and notarized; Apple's notary
//                          service reads the keychain profile in MOONDOG_NOTARY_PROFILE
//                          or APPLE_NOTARY_PROFILE (default mac-mini-notary).
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Arch, build, Platform } from "electron-builder";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const work = path.join(here, "build");
const room = path.join(work, "room");
const sign = process.argv.includes("--sign");
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

const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (sign) process.env.APPLE_KEYCHAIN_PROFILE = process.env.MOONDOG_NOTARY_PROFILE ?? process.env.APPLE_NOTARY_PROFILE ?? "mac-mini-notary";
const artifacts = await build({
  projectDir: here,
  targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64),
  config: {
    appId: "ai.audiofool.moondog",
    productName: "Moondog",
    // The app and the room it carries share one version.
    extraMetadata: { version },
    directories: { output: "release", buildResources: "build-resources" },
    files: ["package.json", "main.mjs", "preload.cjs", "core-process.mjs", "window-room.mjs", "preview-player.mjs", "strings.mjs",
      "dist/**/*", "!dist/**/*.map"],
    asar: false,
    // The core sits beside the window's folder, where core-process.mjs imports ../scripts/moondog.mjs.
    // electron-builder leaves node_modules out of extra resources unless it is named on its own.
    extraResources: [{ from: "build/room", to: ".", filter: ["**/*"] },
      { from: "build/room/node_modules", to: "node_modules", filter: ["**/*"] }],
    mac: {
      category: "public.app-category.music",
      icon: path.join(root, "assets/brand/moondog-lunar-record/moondog-logo-1x1.png"),
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build-resources/entitlements.mac.plist",
      entitlementsInherit: "build-resources/entitlements.mac.plist",
      identity: sign ? identity : null,
      notarize: sign,
    },
    dmg: { title: "Moondog ${version}" },
  },
});
for (const artifact of artifacts) console.log(path.relative(here, artifact));
