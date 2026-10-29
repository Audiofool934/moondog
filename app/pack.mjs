// Build on the target OS: macOS arm64 (DMG/zip), Windows x64 (NSIS), Linux x64 (AppImage).
// The window carries exactly the npm package's core with production dependencies for this host.
// `--dir` leaves an unpacked app for smoke tests. Nothing is published by this script.
// Signed Mac releases retain their build and Apple submission receipts until publication.
// Signed Mac QA builds use --no-notarize and never create a publishable manifest.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, build, Platform } from "electron-builder";
import { buildMusicHelper, MUSIC_USAGE } from "./native/build.mjs";
import { desktopConfig, desktopTarget } from "./pack-config.mjs";
import { builderSigningIdentity, command, digestFile, parseReleaseJson, phase, readJson, retryTimestampSigning, saveJson, signingIdentity, SIGNING_TEAM, RELEASE_REPO } from "./release-tools.mjs";
import { assertProvenance, finalizeArtifacts, inspectApp, releaseNames, verifyArtifacts } from "./release-artifacts.mjs";
import { notarizeFile, prepareDmgUpload } from "./release-notary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--sign", "--no-notarize", "--dir"].includes(flag)) throw new Error(`Unknown build option: ${flag}`);
const target = desktopTarget();
const sign = flags.has("--sign"), notarize = sign && !flags.has("--no-notarize");
if (sign && target.platform !== "darwin") throw new Error("--sign is the macOS Developer ID release path. Windows signing uses electron-builder's CSC_LINK and CSC_KEY_PASSWORD.");
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
const app = path.join(output, target.unpacked, "Moondog.app");
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
const configFor = (music) => desktopConfig({ root, version, buildNumber, output, target, sign, identity: builderSigningIdentity(identity), musicUsage: MUSIC_USAGE, music });
let config = configFor(false);
// npm.cmd cannot be spawned without a shell on Windows. Run npm's JavaScript entrypoint with this Node,
// including when Node and npm live in a directory containing spaces.
const npmCli = process.platform === "win32" ? process.env.npm_execpath || [
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ...(process.env.PATH || process.env.Path || "").split(path.delimiter).map((dir) => path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")),
].find((candidate) => existsSync(candidate)) : null;
if (process.platform === "win32" && !npmCli) throw new Error("Could not find npm's entrypoint. Run this build with npm run pack.");
const npm = (args, options) => npmCli ? command(process.execPath, [npmCli, ...args], options) : command("npm", args, options);
// Windows 10 and newer include bsdtar in System32. A GNU tar earlier on PATH, such as Git's,
// would read the C: in an absolute path as a remote host.
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
const platform = { darwin: Platform.MAC, win32: Platform.WINDOWS, linux: Platform.LINUX }[target.platform];

if (!receipt) {
  await phase("Build and sign the app", async () => {
    await rm(work, { recursive: true, force: true });
    await mkdir(room, { recursive: true });
    await saveJson(path.join(work, "release-provenance.json"), provenance);
    const packed = await npm(["pack", "--json", "--ignore-scripts", "--pack-destination", work], { cwd: root });
    const [{ filename }] = parseReleaseJson(packed.stdout);
    await command(tar, ["-xzf", path.join(work, filename), "-C", room, "--strip-components=1"]);
    await copyFile(path.join(root, "package-lock.json"), path.join(room, "package-lock.json"));
    // The npm package lists macOS and Linux only, because its terminal launcher is a shell script.
    // The Windows app carries the same core, so its install skips that platform check.
    await npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...(process.platform === "win32" ? ["--force"] : [])], { cwd: room, live: true });
    await command(process.execPath, [path.join(here, "build.mjs")], { live: true });
    // The Apple Music helper sits beside the Mac app's own executable, so MusicKit knows it as Moondog.
    config = configFor(Boolean(await buildMusicHelper({ bundle: false, required: sign })));
    await rm(output, { recursive: true, force: true });
    // macOS signs and notarizes the app before packaging it. Windows and Linux package it at once.
    const targets = target.platform === "darwin" || flags.has("--dir") ? ["dir"] : target.targets;
    // electron-builder mutates nested file patterns while normalizing its options.
    await build({ projectDir: here, targets: platform.createTarget(targets, Arch[target.arch]), publish: "never", config: structuredClone(config) });
  });
  if (notarize) {
    receipt = { schema: 1, ...provenance, appCdHash: await inspectApp(app, provenance, { notarized: false }),
      createdAt: new Date().toISOString(), inputName: `Moondog-${version}-${randomUUID()}.zip`, phase: "signed" };
    await saveJson(receiptFile, receipt);
  }
}

if (target.platform !== "darwin") {
  // Only final deliverables move to release/, replacing a build of the same version. Earlier versions
  // stay, so an update can be tried between two builds.
  if (!flags.has("--dir")) for (const file of await readdir(output, { withFileTypes: true })) {
    if (!file.isFile() || !/\.(?:exe|AppImage|blockmap|yml)$/u.test(file.name) || file.name.startsWith("builder-")) continue;
    await rename(path.join(output, file.name), path.join(release, file.name));
    console.log(path.join("release", file.name));
  }
  console.log(`Local QA output: ${flags.has("--dir") ? path.join(output, target.unpacked) : release}`);
  process.exit(0);
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
