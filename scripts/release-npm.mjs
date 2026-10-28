// Publishes the npm package once, then prepares a draft for the Mac publisher to finish.
// All remote mutations are injected into prepareRelease so interruption paths can be tested offline.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { compareReleaseVersions, releaseVersion, UPDATE_PACKAGE } from "../src/core/application-update.mjs";
import { releaseChannel } from "./release-version.mjs";

const repository = "Audiofool934/moondog";
export const packageIntegrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export function assertPublishedPackage(metadata, expected, bytes) {
  if (metadata?.name !== UPDATE_PACKAGE || metadata.version !== expected.version || metadata.gitHead !== expected.head) {
    throw new Error("The published npm version does not match this package and Git commit. Refusing to resume.");
  }
  if (metadata.dist?.integrity !== expected.integrity || packageIntegrity(bytes) !== expected.integrity) {
    throw new Error("The published npm tarball does not match the package built from this commit. Refusing to resume.");
  }
}

export function assertNotOlder(version, current, label) {
  if (current == null) return;
  if (!releaseVersion(current)) throw new Error(`${label} has an unsupported version: ${current}`);
  if (compareReleaseVersions(version, current) < 0) throw new Error(`Refusing to promote ${version}: ${label} is already ${current}.`);
}

export async function prepareRelease({ version, head, integrity, readTags, readVersion, readTarball, latestGithubVersion,
  publish, readRelease, createDraft, log = () => {} }) {
  const channel = releaseChannel({ name: UPDATE_PACKAGE, version, lockVersion: version, tag: `v${version}` });
  const checkOrder = async () => {
    const tags = await readTags();
    assertNotOlder(version, tags.latest, "npm latest");
    assertNotOlder(version, tags[channel], `npm ${channel}`);
    assertNotOlder(version, await latestGithubVersion(), "GitHub latest");
    return tags;
  };
  await checkOrder();
  let metadata = await readVersion();
  if (!metadata) {
    log(`Publishing ${UPDATE_PACKAGE}@${version} to ${channel}.`);
    // The request may have succeeded even if its response was lost. Verify before deciding to retry.
    let publishError;
    try { await publish(channel); } catch (error) { publishError = error; }
    metadata = await readVersion({ wait: true });
    if (!metadata) throw publishError ?? new Error("npm publication could not be confirmed. Retry the same release to recover.");
  } else log(`Checking the existing npm version ${version} before resuming.`);
  assertPublishedPackage(metadata, { version, head, integrity }, await readTarball(metadata));
  const tags = await checkOrder();
  if (tags[channel] !== version) {
    throw new Error(`npm ${version} is verified, but ${channel} points to ${tags[channel] ?? "no version"}. Restore that dist-tag explicitly after checking the release order, then retry. Nothing was republished.`);
  }
  const existing = await readRelease();
  if (existing) {
    if (existing.tagName !== `v${version}` || existing.isPrerelease !== (channel === "beta")) {
      throw new Error("The GitHub release identity or prerelease status does not match this version.");
    }
    log(existing.isDraft ? "The GitHub draft is ready for the Mac publisher." : "The matching GitHub release already exists; its assets were left unchanged.");
    return { channel, resumed: true, draft: existing.isDraft };
  }
  await createDraft(channel);
  log("The GitHub draft is ready. The Mac publisher will expose it only after artifact verification.");
  return { channel, resumed: false, draft: true };
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const run = promisify(execFile);
  const sh = async (command, args) => (await run(command, args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 180_000 })).stdout.trim();
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const tag = process.argv[2];
  if (lock.version !== pkg.version) throw new Error("The lockfile and package versions differ.");
  releaseChannel({ ...pkg, lockVersion: lock.packages[""].version, tag });
  const head = await sh("git", ["rev-parse", "HEAD"]);
  if (await sh("git", ["rev-parse", `${tag}^{commit}`]) !== head || await sh("git", ["status", "--porcelain"])) {
    throw new Error("Publish from a clean checkout at the release tag.");
  }
  const request = async (url, { missing = false, binary = false } = {}) => {
    const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Registry request failed with HTTP ${response.status}.`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) throw new Error("Registry response exceeded the release verification limit.");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    return binary ? bytes : JSON.parse(bytes.toString("utf8"));
  };
  const github = async endpoint => {
    try { return JSON.parse(await sh("gh", ["api", `repos/${repository}/${endpoint}`])); }
    catch (error) {
      if (/HTTP 404/u.test(error.stderr ?? "")) return null;
      throw error;
    }
  };
  const temporary = await mkdtemp(path.join(tmpdir(), "moondog-npm-release-"));
  try {
    const [packed] = JSON.parse(await sh("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary]));
    const integrity = packageIntegrity(await readFile(path.join(temporary, packed.filename)));
    await prepareRelease({ version: pkg.version, head, integrity,
      readTags: () => request("https://registry.npmjs.org/-/package/@audiofool%2fmoondog/dist-tags"),
      readVersion: async ({ wait = false } = {}) => {
        for (let attempt = 0; ; attempt++) {
          const metadata = await request(`https://registry.npmjs.org/@audiofool%2fmoondog/${pkg.version}`, { missing: true });
          if (metadata || !wait || attempt === 5) return metadata;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      },
      readTarball: metadata => {
        const expected = `https://registry.npmjs.org/@audiofool/moondog/-/moondog-${pkg.version}.tgz`;
        if (metadata.dist?.tarball !== expected) throw new Error("Unexpected npm tarball URL.");
        return request(expected, { binary: true });
      },
      latestGithubVersion: async () => (await github("releases/latest"))?.tag_name?.replace(/^v/u, "") ?? null,
      publish: channel => sh("npm", ["publish", "--ignore-scripts", "--provenance", "--access", "public", "--tag", channel]),
      readRelease: async () => {
        const release = await github(`releases/tags/${tag}`);
        return release ? { tagName: release.tag_name, isDraft: release.draft, isPrerelease: release.prerelease } : null;
      },
      createDraft: channel => sh("gh", ["release", "create", tag, "--repo", repository, "--verify-tag", "--generate-notes", "--draft", "--latest=false", ...(channel === "beta" ? ["--prerelease"] : [])]),
      log: console.log,
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
