// Publish only a complete, verified Mac release. A failed upload leaves the draft private.
// Repeat the same command to resume; --skip-build requires the recorded final artifacts.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { command, digestFile, phase, readJson, RELEASE_REPO, SIGNING_TEAM } from "./release-tools.mjs";
import { releaseNames, verifyArtifacts } from "./release-artifacts.mjs";
import { markAsLatest, uploadImmutableAssets, validateNpmRelease } from "./release-publication.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, "..");
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--skip-build", "--create", "--verify-only"].includes(flag)) throw new Error(`Unknown publish option: ${flag}`);
const { name, version } = await readJson(path.join(root, "package.json"));
const tag = `v${version}`, beta = version.includes("-");
const releaseDir = path.join(here, "release"), names = releaseNames(version);
const git = async args => (await command("git", ["-C", root, ...args])).stdout;
if (await git(["status", "--porcelain"])) throw new Error("Publish from a clean checkout at the release tag.");
const source = await git(["rev-parse", "HEAD"]);
if (await git(["rev-parse", `${tag}^{commit}`]) !== source) throw new Error(`HEAD is not ${tag}.`);
const provenance = { version, source, buildNumber: await git(["rev-list", "--count", "HEAD"]), teamId: SIGNING_TEAM };
const gh = async args => (await command("gh", [...args, "--repo", RELEASE_REPO], { cwd: root, timeout: 60 * 60_000 })).stdout;
// gh api uses an explicit endpoint rather than gh's current-working-directory inference.
const api = async endpoint => JSON.parse((await command("gh", ["api", `repos/${RELEASE_REPO}/${endpoint}`], { cwd: root })).stdout);
const optionalApi = async endpoint => {
  try { return await api(endpoint); }
  catch (error) { if (/HTTP 404|Not Found \(HTTP 404\)/u.test(error.stderr || error.message)) return null; throw error; }
};
let remoteTag = (await api(`git/ref/tags/${tag}`)).object;
for (let depth = 0; remoteTag.type === "tag" && depth < 5; depth++) remoteTag = (await api(`git/tags/${remoteTag.sha}`)).object;
if (remoteTag.type !== "commit" || remoteTag.sha !== source) throw new Error("The remote release tag does not match this checkout.");

if (!flags.has("--skip-build") && !flags.has("--verify-only")) {
  await command(process.execPath, [path.join(here, "pack.mjs"), "--sign"], { cwd: here, live: true, timeout: 3 * 60 * 60_000 });
}
const manifest = await phase("Validate release provenance, hashes, signatures and containers", () => verifyArtifacts(releaseDir, provenance));
if (flags.has("--verify-only")) { console.log(`Verified ${tag}; nothing was uploaded.`); process.exit(0); }

const npmMetadata = async selector => JSON.parse((await command("npm", ["view", `${name}@${selector}`, "--json", "--registry", "https://registry.npmjs.org"], { cwd: root })).stdout);
const assertNpm = async () => validateNpmRelease(await npmMetadata(version), { name, version, source });
await phase("Verify the published npm version and commit", assertNpm);

const endpoint = `releases/tags/${tag}`;
let release = await optionalApi(endpoint);
if (!release && flags.has("--create")) {
  await gh(["release", "create", tag, "--verify-tag", "--generate-notes", "--draft", "--latest=false", ...(beta ? ["--prerelease"] : [])]);
  release = await api(endpoint);
}
if (!release) await phase(`Wait for the GitHub draft ${tag}`, async () => {
  for (let attempts = 0; !release && attempts < 60; attempts++) {
    await new Promise(resolve => setTimeout(resolve, 60_000));
    release = await optionalApi(endpoint);
  }
});
if (!release) throw new Error(`No draft ${tag}. Approve the npm workflow or use --create after npm is published.`);
if (release.prerelease !== beta || release.tag_name !== tag) throw new Error("The GitHub release identity or channel is wrong.");

const items = [...manifest.files.filter(file => file.name !== names.feed), await digestFile(path.join(releaseDir, names.manifest)),
  manifest.files.find(file => file.name === names.feed)];
const remoteDigest = async asset => {
  if (/^sha256:[a-f0-9]{64}$/u.test(asset.digest || "")) return asset.digest.slice(7);
  const parent = path.join(releaseDir, ".state", version);
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "remote-"));
  try {
    await gh(["release", "download", tag, "--pattern", asset.name, "--dir", scratch]);
    return (await digestFile(path.join(scratch, asset.name))).sha256;
  } finally { await rm(scratch, { recursive: true, force: true }); }
};
release = await phase("Upload and verify immutable release assets", () => uploadImmutableAssets({ items,
  getRelease: () => api(endpoint), remoteDigest,
  upload: item => gh(["release", "upload", tag, path.join(releaseDir, item.name)]),
  deleteAsset: asset => command("gh", ["api", "--method", "DELETE", `repos/${RELEASE_REPO}/releases/assets/${asset.id}`], { cwd: root }),
}));

// Recheck immediately before promotion. A newer release can finish while Apple processes this one.
await assertNpm();
if (release.draft) {
  const latest = await optionalApi("releases/latest");
  const registryLatest = await npmMetadata("latest");
  const latestFlag = markAsLatest(version, [latest?.tag_name?.replace(/^v/u, ""), registryLatest.version]);
  await gh(["release", "edit", tag, "--draft=false", `--prerelease=${beta}`, `--latest=${latestFlag}`]);
}
release = await api(endpoint);
if (release.draft || release.prerelease !== beta) throw new Error("GitHub did not confirm the release publication.");
console.log(`\nPublished and verified: ${release.html_url}`);
await gh(["workflow", "run", "pages.yml", "--ref", "main"]).then(
  () => console.log("The project page is rebuilding with the verified download."),
  error => console.warn(`The release is published, but the project page refresh failed: ${error.message}`));
