// Publish only a complete, verified Mac release. A failed upload leaves the draft private.
// Start it right after the tag push: after the build it waits up to an hour for the npm approval and the draft.
// Repeat the same command to resume; --skip-build requires the recorded final artifacts.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { command, commandFailure, digestFile, parseReleaseJson, phase, readJson, RELEASE_REPO, SIGNING_TEAM } from "./release-tools.mjs";
import { releaseNames, verifyArtifacts } from "./release-artifacts.mjs";
import { assertReleaseIdentity, findReleaseByTag, markAsLatest, publicationSource, uploadImmutableAssets, validateNpmRelease, waitFor } from "./release-publication.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, "..");
const args = process.argv.slice(2), flags = new Set();
let fromTag;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--from-tag") {
    if (fromTag !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Provide --from-tag once with an exact release tag.");
    fromTag = args[++i];
  } else if (["--skip-build", "--create", "--verify-only"].includes(flag)) flags.add(flag);
  else throw new Error(`Unknown publish option: ${flag}`);
}
const { name, version } = await readJson(path.join(root, "package.json"));
const tag = `v${version}`, beta = version.includes("-");
const releaseDir = path.join(here, "release"), names = releaseNames(version);
const git = async args => (await command("git", ["-C", root, ...args])).stdout;
if (await git(["status", "--porcelain"])) throw new Error("Publish from a clean checkout.");
const head = await git(["rev-parse", "HEAD"]), tagSource = await git(["rev-parse", `${tag}^{commit}`]);
const gh = async args => (await command("gh", [...args, "--repo", RELEASE_REPO], { cwd: root, timeout: 60 * 60_000 })).stdout;
// gh api uses an explicit endpoint rather than gh's current-working-directory inference.
const api = async endpoint => parseReleaseJson((await command("gh", ["api", `repos/${RELEASE_REPO}/${endpoint}`], { cwd: root })).stdout);
const optionalApi = async endpoint => {
  try { return await api(endpoint); }
  catch (error) { if (error.httpStatus === 404) return null; throw error; }
};
let remoteTag = (await api(`git/ref/tags/${tag}`)).object;
for (let depth = 0; remoteTag.type === "tag" && depth < 5; depth++) remoteTag = (await api(`git/tags/${remoteTag.sha}`)).object;
const source = publicationSource({ version, fromTag, skipBuild: flags.has("--skip-build"), verifyOnly: flags.has("--verify-only"),
  head, tagSource, remoteSource: remoteTag.type === "commit" ? remoteTag.sha : null });
const provenance = { version, source, buildNumber: await git(["rev-list", "--count", source]), teamId: SIGNING_TEAM };

if (!flags.has("--skip-build") && !flags.has("--verify-only")) {
  await command(process.execPath, [path.join(here, "pack.mjs"), "--sign"], { cwd: here, live: true, timeout: 3 * 60 * 60_000 });
}
const manifest = await phase("Validate release provenance, hashes, signatures and containers", () => verifyArtifacts(releaseDir, provenance));
if (flags.has("--verify-only")) { console.log(`Verified ${tag}; nothing was uploaded.`); process.exit(0); }

const npmMetadata = async selector => parseReleaseJson((await command("npm", ["view", `${name}@${selector}`, "--json", "--prefer-online", "--registry", "https://registry.npmjs.org"], { cwd: root })).stdout);
const assertNpm = async () => validateNpmRelease(await npmMetadata(version), { name, version, source });
// npm view reports a version that is not published yet as E404; any other failure stops here.
const readNpm = () => npmMetadata(version).catch(error => { if (error.npmCodes?.includes("E404")) return null; throw error; });
const deadline = Date.now() + 60 * 60_000;
let npmRelease = await readNpm();
if (!npmRelease) npmRelease = await phase(`Wait for npm ${version}: approve the npm environment on the Publish release run`, () => waitFor(readNpm, { deadline }));
if (!npmRelease) throw new Error(`npm ${version} is not published. Approve the npm environment on the Publish release run, then run the same command again.`);
await phase("Verify the published npm version and commit", () => validateNpmRelease(npmRelease, { name, version, source }));

const findRelease = () => findReleaseByTag({ tag, prerelease: beta,
  listPage: page => api(`releases?per_page=100&page=${page}`) });
let release = await findRelease();
if (!release && flags.has("--create")) {
  await gh(["release", "create", tag, "--verify-tag", "--generate-notes", "--draft", "--latest=false", ...(beta ? ["--prerelease"] : [])]);
  release = await findRelease();
}
if (!release) release = await phase(`Wait for the GitHub draft ${tag}`, () => waitFor(findRelease, { deadline }));
if (!release) throw new Error(`No draft ${tag}. Approve the npm workflow or use --create after npm is published.`);
const identity = { id: release.id, tag, prerelease: beta };
const endpoint = `releases/${identity.id}`;
const getRelease = async () => assertReleaseIdentity(await api(endpoint), identity);
release = await getRelease();

const items = [...manifest.files.filter(file => file.name !== names.feed), await digestFile(path.join(releaseDir, names.manifest)),
  manifest.files.find(file => file.name === names.feed)];
const remoteDigest = async asset => {
  if (/^sha256:[a-f0-9]{64}$/u.test(asset.digest || "")) return asset.digest.slice(7);
  const parent = path.join(releaseDir, ".state", version);
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "remote-"));
  try {
    // Pin the fallback download to the asset ID returned by the bound release.
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0) throw new Error("Invalid GitHub asset ID.");
    const file = path.join(scratch, "asset");
    const child = spawn("gh", ["api", `repos/${RELEASE_REPO}/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.resume();
    const done = new Promise((resolve, reject) => {
      child.once("error", error => reject(commandFailure("gh", { code: error.code })));
      child.once("close", (code, signal) => code === 0 ? resolve() : reject(commandFailure("gh", { code, signal })));
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 60 * 60_000);
    try { await Promise.all([done, pipeline(child.stdout, createWriteStream(file))]); }
    finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGTERM"); await done.catch(() => {}); }
    return (await digestFile(file)).sha256;
  } finally { await rm(scratch, { recursive: true, force: true }); }
};
release = await phase("Upload and verify immutable release assets", () => uploadImmutableAssets({ items,
  getRelease, remoteDigest,
  upload: item => command("gh", ["api", "--method", "POST",
    `https://uploads.github.com/repos/${RELEASE_REPO}/${endpoint}/assets?name=${encodeURIComponent(item.name)}`,
    "-H", "Content-Type: application/octet-stream", "-H", `Content-Length: ${item.size}`,
    // The ZIP and DMG upload at once and share the bandwidth, so each gets twice the time one had alone.
    "--input", path.join(releaseDir, item.name)], { cwd: root, timeout: 2 * 60 * 60_000 }),
  deleteAsset: asset => command("gh", ["api", "--method", "DELETE", `repos/${RELEASE_REPO}/releases/assets/${asset.id}`], { cwd: root }),
}));

// Recheck immediately before promotion. A newer release can finish while Apple processes this one.
await assertNpm();
release = await getRelease();
if (release.draft) {
  const latest = await optionalApi("releases/latest");
  const registryLatest = await npmMetadata("latest");
  const latestFlag = markAsLatest(version, [latest?.tag_name?.replace(/^v/u, ""), registryLatest.version]);
  release = await getRelease();
  if (release.draft) await command("gh", ["api", "--method", "PATCH", `repos/${RELEASE_REPO}/${endpoint}`,
    "-F", "draft=false", "-F", `prerelease=${beta}`, "-f", `make_latest=${latestFlag}`], { cwd: root });
}
release = await getRelease();
if (release.draft || release.prerelease !== beta) throw new Error("GitHub did not confirm the release publication.");
console.log(`\nPublished and verified: ${release.html_url}`);
await gh(["workflow", "run", "pages.yml", "--ref", "main"]).then(
  () => console.log("The project page is rebuilding with the verified download."),
  error => console.warn(`The release is published, but the project page refresh failed: ${error.message}`));
