// Puts a signed, notarized Moondog for Mac on the GitHub release for its version, where the app's
// updater finds it. Run it on the Mac that holds the Developer ID key, from a clean checkout at the
// release tag, after `Publish release` has created the release (it waits for it):
//   node publish.mjs                build with pack.mjs --sign, then sign, notarize and upload
//   node publish.mjs --skip-build   use the build already in release/ for this version
//   node publish.mjs --create       make the release if the workflow did not (prerelease for a beta)
// The DMG is signed, notarized and stapled too, and latest-mac.yml is uploaded last, because the
// app acts on it. Nothing is deleted from the release.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const flags = new Set(process.argv.slice(2));
const sh = async (command, args, options = {}) => (await run(command, args, { maxBuffer: 64 * 1024 * 1024, ...options })).stdout.trim();
const step = (words) => console.log(`\n${words}`);
const fail = (words) => { console.error(`\n${words}`); process.exit(1); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const tag = `v${version}`;
const beta = version.includes("-");
const profile = process.env.MOONDOG_NOTARY_PROFILE ?? process.env.APPLE_NOTARY_PROFILE ?? "mac-mini-notary";
const release = path.join(here, "release");
const files = {
  zip: path.join(release, `Moondog-${version}-arm64-mac.zip`),
  blockmap: path.join(release, `Moondog-${version}-arm64-mac.zip.blockmap`),
  dmg: path.join(release, `Moondog-${version}-arm64.dmg`),
  feed: path.join(release, "latest-mac.yml"),
};

step(`Moondog ${version}, release ${tag}`);
// A build packs the working tree, so it needs a clean one; publishing an existing build only needs the tracked files unchanged.
const untracked = flags.has("--skip-build") ? ["--untracked-files=no"] : [];
if (await sh("git", ["-C", root, "status", "--porcelain", ...untracked])) fail("The checkout has changes. Publish from a clean checkout at the release tag.");
const head = await sh("git", ["-C", root, "rev-parse", "HEAD"]);
const tagged = await sh("git", ["-C", root, "rev-parse", `${tag}^{commit}`]).catch(() => "");
if (tagged !== head) fail(`HEAD is not ${tag}. Push the tag first, then publish from a checkout at it.`);

if (!flags.has("--skip-build")) {
  step("Building, signing and notarizing the app (pack.mjs --sign)");
  await sh(process.execPath, [path.join(here, "pack.mjs"), "--sign"], { cwd: here, timeout: 3 * 60 * 60_000 });
}
for (const file of Object.values(files)) await stat(file).catch(() => fail(`Missing ${path.relative(here, file)}. Build this version first.`));
const feed = await readFile(files.feed, "utf8");
if (!feed.startsWith(`version: ${version}\n`)) fail(`latest-mac.yml is for another version:\n${feed.split("\n")[0]}`);

step("Signing, notarizing and stapling the DMG");
if ((await sh("xcrun", ["stapler", "validate", files.dmg]).catch(() => "")).includes("worked")) console.log("Already stapled.");
else {
  const identity = process.env.MOONDOG_SIGNING_IDENTITY ?? (await sh("security", ["find-identity", "-v", "-p", "codesigning"]))
    .split("\n").map((line) => line.match(/"(Developer ID Application: [^"]+)"/u)?.[1]).find(Boolean);
  if (!identity) fail("No Developer ID Application certificate in the keychain.");
  await sh("codesign", ["--force", "--sign", identity, "--timestamp", files.dmg]);
  console.log(await sh("xcrun", ["notarytool", "submit", files.dmg, "--keychain-profile", profile, "--wait"], { timeout: 3 * 60 * 60_000 }));
  await sh("xcrun", ["stapler", "staple", files.dmg]);
}
await sh("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-v", files.dmg]).catch(() => fail("Gatekeeper does not accept the DMG."));

// Signing and stapling changed the DMG, so its line in latest-mac.yml gets its new size and checksum.
const dmg = await readFile(files.dmg);
const sha512 = createHash("sha512").update(dmg).digest("base64");
const name = path.basename(files.dmg);
const updated = feed.replace(new RegExp(`(- url: ${name.replace(/\./gu, "\\.")}\\n\\s+sha512: )\\S+(\\n\\s+size: )\\d+`, "u"), `$1${sha512}$2${dmg.length}`);
if (!updated.includes(sha512)) fail("Could not find the DMG in latest-mac.yml.");
await writeFile(files.feed, updated);

step(`Waiting for the GitHub release ${tag}`);
const view = () => sh("gh", ["release", "view", tag, "--json", "isDraft,isPrerelease,assets"]).then(JSON.parse, () => null);
let found = await view();
if (!found && flags.has("--create")) {
  await sh("gh", ["release", "create", tag, "--verify-tag", "--generate-notes", ...(beta ? ["--prerelease"] : ["--latest"])]);
  found = await view();
}
for (let minutes = 0; !found && minutes < 60; minutes++) {
  if (minutes === 0) console.log("Not there yet. Approve the Publish release run on GitHub; checking every minute for an hour.");
  await wait(60_000);
  found = await view();
}
if (!found) fail(`No release ${tag}. Run again with --create to make it here.`);
if (found.isPrerelease !== beta) fail(`The release is ${found.isPrerelease ? "" : "not "}a prerelease, but ${version} is ${beta ? "" : "not "}a beta.`);

step("Uploading the app, then latest-mac.yml");
await sh("gh", ["release", "upload", tag, files.zip, files.blockmap, files.dmg, "--clobber"], { timeout: 60 * 60_000 });
await sh("gh", ["release", "upload", tag, files.feed, "--clobber"]);

const assets = (await view()).assets;
const uploaded = (file) => assets.find((asset) => asset.name === path.basename(file));
for (const file of Object.values(files)) {
  const asset = uploaded(file);
  if (!asset || asset.size !== (await stat(file)).size) fail(`${path.basename(file)} did not upload whole.`);
}
console.log(`\nMoondog ${version} is on https://github.com/Audiofool934/moondog/releases/tag/${tag}`);
console.log(beta ? "Apps on a beta version will find it at their next check." : "Apps on a stable version will find it at their next check.");
// The project page links the newest release that has a DMG, so it is built again now that this one has.
await sh("gh", ["workflow", "run", "pages.yml", "--ref", "main"]).then(
  () => console.log("The project page is being built again, to link this download."),
  () => console.log("Run the Project page workflow on GitHub so the page links this download."));
