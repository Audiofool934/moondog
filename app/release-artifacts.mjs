import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { command, digestFile, readJson, saveJson, SIGNING_TEAM } from "./release-tools.mjs";

export function releaseNames(version) {
  return { zip: `Moondog-${version}-arm64-mac.zip`, blockmap: `Moondog-${version}-arm64-mac.zip.blockmap`,
    dmg: `Moondog-${version}-arm64.dmg`, feed: "latest-mac.yml", manifest: `Moondog-${version}-release.json` };
}

export function assertProvenance(actual, expected) {
  for (const field of ["version", "source", "buildNumber", "teamId"]) {
    if (actual?.[field] !== expected[field]) throw new Error(`Build provenance differs: ${field}. Restore the build from this release commit.`);
  }
}

export async function inspectApp(app, expected, { notarized = true, run = command } = {}) {
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const identity = await run("codesign", ["--display", "--verbose=4", app]);
  const details = `${identity.stdout}\n${identity.stderr}`;
  const team = details.match(/^TeamIdentifier=(.+)$/mu)?.[1];
  const cdhash = details.match(/^CDHash=(.+)$/mu)?.[1];
  if (team !== SIGNING_TEAM || !cdhash || !details.includes("Authority=Developer ID Application:")) throw new Error("The app is not signed with the release Developer ID team.");
  const provenance = await readJson(path.join(app, "Contents/Resources/release-provenance.json"));
  assertProvenance(provenance, expected);
  for (const [key, value] of [["CFBundleShortVersionString", expected.version], ["CFBundleVersion", expected.buildNumber]]) {
    const actual = await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(app, "Contents/Info.plist")]);
    if (actual.stdout !== value) throw new Error(`The app's ${key} does not match the release.`);
  }
  for (const relative of ["Contents/Resources/package.json", "Contents/Resources/app/package.json"]) {
    if ((await readJson(path.join(app, relative))).version !== expected.version) throw new Error("The app and its core have different versions.");
  }
  if (!(await stat(path.join(app, "Contents/MacOS/moondog-music"))).isFile()) throw new Error("The release is missing its Apple Music helper.");
  if (expected.appCdHash && expected.appCdHash !== cdhash) throw new Error("The app signature differs from the recorded build.");
  if (notarized) {
    await run("xcrun", ["stapler", "validate", app]);
    const assessment = await run("spctl", ["-a", "--type", "execute", "--verbose=4", app]);
    if (!`${assessment.stdout}\n${assessment.stderr}`.includes("source=Notarized Developer ID")) throw new Error("Gatekeeper did not confirm a notarized Developer ID app.");
  }
  return cdhash;
}

// Compare signed contents, executable bits, and symlinks after both containers are opened.
// Finder's optional .DS_Store is not part of the app and must not affect this comparison.
export async function appTreeDigest(directory) {
  const hash = createHash("sha256");
  async function visit(relative) {
    const location = path.join(directory, relative);
    const info = await lstat(location);
    hash.update(`${relative}\0${info.mode & 0o111}\0`);
    if (info.isSymbolicLink()) hash.update(`link\0${await readlink(location)}\0`);
    else if (info.isDirectory()) {
      for (const name of (await readdir(location)).sort()) if (name !== ".DS_Store") await visit(path.join(relative, name));
    } else if (info.isFile()) hash.update(`${(await digestFile(location)).sha256}\0`);
    else throw new Error(`Unexpected app entry: ${relative}`);
  }
  await visit("");
  return hash.digest("hex");
}

export function updateFeed(version, zip, dmg, releaseDate) {
  return `version: ${version}\nfiles:\n` + [zip, dmg].map(file => `  - url: ${file.name}\n    sha512: ${file.sha512}\n    size: ${file.size}\n`).join("")
    + `path: ${zip.name}\nsha512: ${zip.sha512}\nreleaseDate: '${releaseDate}'\n`;
}

export async function assertArtifactFiles(directory, manifest) {
  const names = releaseNames(manifest.version);
  const expected = [names.zip, names.blockmap, names.dmg, names.feed].sort();
  if (JSON.stringify(manifest.files?.map(file => file.name).sort()) !== JSON.stringify(expected)) throw new Error("The release manifest must contain exactly the four Mac update assets.");
  for (const recorded of manifest.files) {
    const actual = await digestFile(path.join(directory, recorded.name));
    for (const key of ["size", "sha256", "sha512"]) if (actual[key] !== recorded[key]) throw new Error(`Artifact changed: ${recorded.name} (${key}).`);
  }
  const zip = manifest.files.find(file => file.name === names.zip), dmg = manifest.files.find(file => file.name === names.dmg);
  if (await readFile(path.join(directory, names.feed), "utf8") !== updateFeed(manifest.version, zip, dmg, manifest.createdAt)) throw new Error("The update feed does not describe these exact artifacts.");
}

export async function inspectContainers(directory, expected, run = command) {
  const names = releaseNames(expected.version);
  const scratchRoot = path.join(directory, "apps.noindex");
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchRoot, "verify-"));
  const extracted = path.join(scratch, "zip"), mounted = path.join(scratch, "dmg");
  let attached = false;
  try {
    await mkdir(extracted); await mkdir(mounted);
    await run("ditto", ["-x", "-k", path.join(directory, names.zip), extracted]);
    const zipApp = path.join(extracted, "Moondog.app");
    const appCdHash = await inspectApp(zipApp, expected, { run });
    await run("codesign", ["--verify", "--strict", path.join(directory, names.dmg)]);
    await run("xcrun", ["stapler", "validate", path.join(directory, names.dmg)]);
    await run("spctl", ["-a", "-t", "open", "--context", "context:primary-signature", "-v", path.join(directory, names.dmg)]);
    await run("hdiutil", ["attach", path.join(directory, names.dmg), "-readonly", "-nobrowse", "-mountpoint", mounted]);
    attached = true;
    const dmgApp = path.join(mounted, "Moondog.app");
    await inspectApp(dmgApp, { ...expected, appCdHash }, { run });
    const appTreeSha256 = await appTreeDigest(zipApp);
    if (appTreeSha256 !== await appTreeDigest(dmgApp)) throw new Error("The ZIP and DMG contain different app contents.");
    if (expected.appTreeSha256 && expected.appTreeSha256 !== appTreeSha256) throw new Error("The app contents differ from the release manifest.");
    const { buildBlockMap } = await import("app-builder-lib/out/targets/blockmap/blockmap.js");
    const rebuilt = path.join(scratch, "zip.blockmap");
    await buildBlockMap(path.join(directory, names.zip), "gzip", rebuilt);
    if ((await digestFile(rebuilt)).sha256 !== (await digestFile(path.join(directory, names.blockmap))).sha256) throw new Error("The ZIP blockmap does not match the ZIP.");
    return { appCdHash, appTreeSha256 };
  } finally {
    if (attached) await run("hdiutil", ["detach", mounted]);
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function finalizeArtifacts(directory, provenance, createdAt) {
  const names = releaseNames(provenance.version);
  const zip = await digestFile(path.join(directory, names.zip)), dmg = await digestFile(path.join(directory, names.dmg));
  await writeFile(path.join(directory, names.feed), updateFeed(provenance.version, zip, dmg, createdAt));
  const contents = await inspectContainers(directory, provenance);
  const files = await Promise.all([names.zip, names.blockmap, names.dmg, names.feed].map(name => digestFile(path.join(directory, name))));
  const manifest = { schema: 1, ...provenance, ...contents, notarized: true, createdAt, files };
  await saveJson(path.join(directory, names.manifest), manifest);
  return manifest;
}

export async function verifyArtifacts(directory, provenance, { inspect = inspectContainers } = {}) {
  const manifest = await readJson(path.join(directory, releaseNames(provenance.version).manifest));
  if (manifest.schema !== 1 || manifest.notarized !== true) throw new Error("This is not a completed notarized release build.");
  assertProvenance(manifest, provenance);
  await assertArtifactFiles(directory, manifest);
  await inspect(directory, manifest);
  return manifest;
}
