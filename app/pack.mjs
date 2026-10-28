// Signed releases retain their build and Apple submission receipts until publication.
// Signed QA builds use --no-notarize and never create a publishable manifest.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, build, Platform } from "electron-builder";
import { buildMusicHelper, MUSIC_USAGE } from "./native/build.mjs";
import { builderSigningIdentity, command, digestFile, ELECTRON_DATA_SIGN_IGNORE, parseReleaseJson, phase, readJson, retryTimestampSigning, saveJson, signingIdentity, SIGNING_TEAM, RELEASE_REPO } from "./release-tools.mjs";
import { assertProvenance, finalizeArtifacts, inspectApp, releaseNames, verifyArtifacts } from "./release-artifacts.mjs";
import { notarizeFile, prepareDmgUpload } from "./release-notary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--sign", "--no-notarize", "--dir"].includes(flag)) throw new Error(`Unknown build option: ${flag}`);
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Build this release on an Apple silicon Mac.");
const sign = flags.has("--sign"), notarize = sign && !flags.has("--no-notarize");
if (notarize && flags.has("--dir")) throw new Error("Use --dir --sign --no-notarize for a local signed QA app.");
const { version } = parseReleaseJson(await readFile(path.join(root, "package.json"), "utf8"));
const git = async args => (await command("git", ["-C", root, ...args])).stdout;
if (notarize && await git(["status", "--porcelain"])) throw new Error("Release builds require a clean checkout.");
const source = await git(["rev-parse", "HEAD"]);
if (notarize && await git(["rev-parse", `v${version}^{commit}`]) !== source) throw new Error("A notarized release must be built from its version tag.");
const buildNumber = await git(["rev-list", "--count", "HEAD"]);
if (!/^[1-9]\d{0,3}$/u.test(buildNumber)) throw new Error("The build number must be a valid numeric CFBundleVersion.");
const provenance = { version, source, buildNumber, teamId: SIGNING_TEAM };
const release = path.join(here, "release"), state = path.join(release, ".state", version);
const output = path.join(release, notarize ? "apps.noindex" : "qa.noindex", version);
const app = path.join(output, "mac-arm64", "Moondog.app");
const work = path.join(here, "build"), room = path.join(work, "room");
const names = releaseNames(version), receiptFile = path.join(state, "build.json");
const profile = process.env.MOONDOG_NOTARY_PROFILE ?? process.env.APPLE_NOTARY_PROFILE ?? "mac-mini-notary";
let receipt = notarize ? await readJson(receiptFile, true) : null;
if (receipt) assertProvenance(receipt, provenance);
if (receipt?.phase === "ready") {
  await phase("Verify the existing release artifacts", () => verifyArtifacts(release, provenance));
  console.log(`Reusing ${path.join(release, names.manifest)}`);
  process.exit(0);
}
if (notarize) {
  let existing;
  try { existing = parseReleaseJson((await command("gh", ["api", `repos/${RELEASE_REPO}/releases/tags/v${version}`])).stdout); }
  catch (error) { if (error.httpStatus !== 404) throw error; }
  if (existing && !existing.draft) throw new Error("This version is already public. Reuse its verified artifacts or publish a new version; do not rebuild it.");
}
const identity = sign ? await signingIdentity() : null;
const config = {
  appId: "ai.audiofool.moondog", productName: "Moondog", extraMetadata: { version }, buildVersion: buildNumber,
  directories: { output, buildResources: "build-resources" },
  files: ["package.json", "main.mjs", "preload.cjs", "core-process.mjs", "window-room.mjs", "preview-player.mjs", "strings.mjs", "updates.mjs", "shutdown.mjs", "dist/**/*", "!dist/**/*.map"],
  publish: [{ provider: "github", owner: "Audiofool934", repo: "moondog", channel: "latest" }],
  asar: false, forceCodeSigning: sign,
  extraResources: [{ from: "build/room", to: ".", filter: ["**/*"] },
    { from: "build/room/node_modules", to: "node_modules", filter: ["**/*"] },
    { from: "build/release-provenance.json", to: "release-provenance.json" },
    { from: path.join(root, "assets/brand"), to: "brand", filter: ["moondog-app-icon.png", "moondog-app-icon-dark.png"] }],
  mac: { category: "public.app-category.music", icon: path.join(root, "assets/brand/moondog-app-icon.png"),
    hardenedRuntime: true, gatekeeperAssess: false, type: "distribution",
    entitlements: "build-resources/entitlements.mac.plist", entitlementsInherit: "build-resources/entitlements.mac.plist",
    extendInfo: { NSAppleMusicUsageDescription: MUSIC_USAGE, NSAppleEventsUsageDescription: "Moondog reads what you play in Music, and the playlist it comes from." },
    identity: builderSigningIdentity(identity), notarize: false, signIgnore: [ELECTRON_DATA_SIGN_IGNORE] },
  dmg: { title: "Moondog ${version}" },
};

if (!receipt) {
  await phase("Build and sign the app", async () => {
    await rm(work, { recursive: true, force: true });
    await mkdir(room, { recursive: true });
    await saveJson(path.join(work, "release-provenance.json"), provenance);
    const packed = await command("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], { cwd: root });
    const [{ filename }] = parseReleaseJson(packed.stdout);
    await command("tar", ["-xzf", path.join(work, filename), "-C", room, "--strip-components=1"]);
    await copyFile(path.join(root, "package-lock.json"), path.join(room, "package-lock.json"));
    await command("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: room, live: true });
    await command(process.execPath, [path.join(here, "build.mjs")], { live: true });
    const music = await buildMusicHelper({ bundle: false, required: sign });
    config.extraFiles = music ? [{ from: "native/build/moondog-music", to: "MacOS/moondog-music" }] : [];
    await rm(output, { recursive: true, force: true });
    // electron-builder mutates nested file patterns while normalizing its options.
    await build({ projectDir: here, targets: Platform.MAC.createTarget(["dir"], Arch.arm64), publish: "never", config: structuredClone(config) });
  });
  if (notarize) {
    receipt = { schema: 1, ...provenance, appCdHash: await inspectApp(app, provenance, { notarized: false }),
      createdAt: new Date().toISOString(), inputName: `Moondog-${version}-${randomUUID()}.zip`, phase: "signed" };
    await saveJson(receiptFile, receipt);
  }
}

if (!notarize) {
  if (!flags.has("--dir")) await phase("Package the local QA app", () => build({ projectDir: here, prepackaged: app,
    targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64), publish: "never", config: structuredClone(config) }));
  console.log(`Local QA output: ${flags.has("--dir") ? app : output}`);
  process.exit(0);
}

if (["signed", "stapled"].includes(receipt.phase)) {
  await inspectApp(app, receipt, { notarized: false });
  if (receipt.phase === "signed") {
    const upload = path.join(state, receipt.inputName);
    // Finish the archive before its first submission; keep those bytes on every retry.
    if (!await readJson(path.join(state, "app-archive.json"), true)) {
      const temporary = `${upload}.tmp.zip`;
      await command("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, temporary]);
      await rename(temporary, upload);
      await saveJson(path.join(state, "app-archive.json"), await digestFile(upload));
    }
    const archived = await readJson(path.join(state, "app-archive.json"));
    if ((await digestFile(upload)).sha256 !== archived.sha256) throw new Error("The saved app upload archive changed.");
    await notarizeFile({ file: upload, receiptFile: path.join(state, "app-notary.json"), profile });
    await phase("Staple and verify the app", async () => {
      await command("xcrun", ["stapler", "staple", app], { live: true });
      await inspectApp(app, receipt);
    });
    receipt.phase = "stapled";
    await saveJson(receiptFile, receipt);
  }
  await phase("Package the notarized app", async () => {
    await build({ projectDir: here, prepackaged: app, targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64), publish: "never", config: structuredClone(config) });
    for (const name of [names.zip, names.blockmap, names.dmg]) await copyFile(path.join(output, name), path.join(release, name));
  });
  receipt.phase = "packaged";
  receipt.zip = await digestFile(path.join(release, names.zip));
  receipt.blockmap = await digestFile(path.join(release, names.blockmap));
  await saveJson(receiptFile, receipt);
}

for (const recorded of [receipt.zip, receipt.blockmap]) {
  if (!recorded || (await digestFile(path.join(release, recorded.name))).sha256 !== recorded.sha256) throw new Error("A saved update archive changed; restore the original build.");
}
const dmg = path.join(release, names.dmg);
if (receipt.phase === "packaged") {
  await phase("Sign the DMG", () => retryTimestampSigning(() => command("codesign", ["--force", "--sign", identity, "--timestamp", dmg], { live: true })));
  receipt.dmg = await digestFile(dmg);
  receipt.phase = "dmg-signed";
  await saveJson(receiptFile, receipt);
}
const stapled = await command("xcrun", ["stapler", "validate", dmg]).then(() => true, () => false);
if (!stapled) {
  const upload = await prepareDmgUpload({ file: dmg, receipt, receiptFile });
  await notarizeFile({ file: upload, receiptFile: path.join(state, "dmg-notary.json"), profile });
  await phase("Staple the DMG", () => command("xcrun", ["stapler", "staple", dmg], { live: true }));
}
await phase("Verify the exact ZIP and DMG and record their hashes", () => finalizeArtifacts(release, { ...provenance, appCdHash: receipt.appCdHash }, receipt.createdAt));
receipt.phase = "ready";
await saveJson(receiptFile, receipt);
console.log(`Verified release: ${path.join(release, names.manifest)}`);
