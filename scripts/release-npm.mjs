// Publishes the npm package once, then prepares a draft for the Mac publisher to finish.
// All remote mutations are injected into prepareRelease so interruption paths can be tested offline.
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareReleaseVersions, releaseVersion, UPDATE_PACKAGE } from "../src/core/application-update.mjs";
import { releaseChannel } from "./release-version.mjs";
import { assertReleaseIdentity, findReleaseByTag } from "../app/release-publication.mjs";
import { command, parseReleaseJson } from "../app/release-tools.mjs";

const repository = "Audiofool934/moondog";
export const packageIntegrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function assertPublishedMetadata(metadata, expected) {
  if (metadata?.name !== UPDATE_PACKAGE || metadata.version !== expected.version || metadata.gitHead !== expected.head) {
    throw new Error("The published npm version does not match this package and Git commit. Refusing to resume.");
  }
  if (metadata.dist?.integrity !== expected.integrity) {
    throw new Error("The published npm tarball does not match the package built from this commit. Refusing to resume.");
  }
}

export function assertPublishedPackage(metadata, expected, bytes) {
  assertPublishedMetadata(metadata, expected);
  if (packageIntegrity(bytes) !== expected.integrity) {
    throw new Error("The published npm tarball does not match the package built from this commit. Refusing to resume.");
  }
}

export function assertNotOlder(version, current, label) {
  if (current == null) return;
  if (!releaseVersion(current)) throw new Error(`${label} has an unsupported version.`);
  if (compareReleaseVersions(version, current) < 0) throw new Error(`Refusing to promote ${version}: ${label} is already ${current}.`);
}

// npm/execFile errors can contain stdout, authorization URLs and tokens. Report structured
// command diagnostics only; never print the captured output or the raw execFile message.
export function publishFailureSummary(error) {
  const details = [];
  if (Number.isInteger(error?.code)) details.push(`exit ${error.code}`);
  else if (/^E[A-Z_]{1,32}$/u.test(error?.code ?? "")) details.push(error.code);
  if (/^SIG[A-Z]{1,16}$/u.test(error?.signal ?? "")) details.push(error.signal);
  if (error?.killed) details.push("command timed out or was terminated");
  const codes = [...new Set([
    ...(Array.isArray(error?.npmCodes) ? error.npmCodes.filter(code => /^E[A-Z0-9_]{1,32}$/u.test(code)) : []),
    ...[...String(error?.stderr ?? "").matchAll(/^npm (?:error|ERR!) code (E[A-Z0-9_]{1,32})\s*$/gmu)].map(match => match[1]),
  ])];
  if (codes.length) details.push(`npm ${codes.join(", ")}`);
  return `npm publish failed (${details.join("; ") || "no exit status available"}).`;
}

export async function registryRequest(url, { missing = false, binary = false, timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  const fresh = new URL(url);
  fresh.searchParams.set("release_check", randomUUID());
  let response;
  try {
    response = await fetchImpl(fresh, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" },
      redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw Object.assign(new Error("Registry request timed out or could not connect."), { retryable: true });
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (missing && response.status === 404) return null;
    throw Object.assign(new Error(`Registry request failed with HTTP ${response.status}.`), {
      retryable: response.status === 404 || response.status === 429 || response.status >= 500,
    });
  }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) throw Object.assign(new Error("Registry response exceeded the release verification limit."), { code: "RELEASE_RESPONSE_TOO_LARGE" });
      chunks.push(chunk);
    }
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError") {
      throw Object.assign(new Error("Registry response timed out or was interrupted."), { retryable: true });
    }
    throw new Error(error.code === "RELEASE_RESPONSE_TOO_LARGE"
      ? "Registry response exceeded the release verification limit."
      : "Registry response could not be read.");
  }
  const bytes = Buffer.concat(chunks);
  return binary ? bytes : parseReleaseJson(bytes.toString("utf8"));
}

export async function readGithubRelease({ tag, prerelease, request }) {
  // The by-tag REST endpoint can return 404 for a draft that already exists.
  const match = await findReleaseByTag({ tag, prerelease,
    listPage: page => request(`releases?per_page=100&page=${page}`),
  });
  if (!match) return null;
  const release = assertReleaseIdentity(await request(`releases/${match.id}`), { id: match.id, tag, prerelease });
  return { tagName: release.tag_name, isDraft: release.draft, isPrerelease: release.prerelease };
}

export async function prepareRelease({ version, head, integrity, readTags, readVersion, readTarball, latestGithubVersion,
  publish, readRelease, createDraft, log = () => {}, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), waitTimeoutMs = 180_000 }) {
  const channel = releaseChannel({ name: UPDATE_PACKAGE, version, lockVersion: version, tag: `v${version}` });
  const checkNpmOrder = async options => {
    const tags = await readTags(options);
    assertNotOlder(version, tags.latest, "npm latest");
    assertNotOlder(version, tags[channel], `npm ${channel}`);
    return tags;
  };
  const checkOrder = async () => {
    const tags = await checkNpmOrder();
    assertNotOlder(version, await latestGithubVersion(), "GitHub latest");
    return tags;
  };
  await checkOrder();
  let metadata = await readVersion();
  let publicationStatus = "The version already existed; npm publish was not called.";
  if (!metadata) {
    log(`Publishing ${UPDATE_PACKAGE}@${version} to ${channel}.`);
    // The request may have succeeded even if its response was lost. Verify before deciding to retry.
    try {
      await publish(channel);
      publicationStatus = "npm publish exited successfully.";
    } catch (error) { publicationStatus = publishFailureSummary(error); }
    log(`${publicationStatus} Verifying public registry visibility for up to ${waitTimeoutMs / 1000}s; no further publish request will be sent.`);
  } else log(`Checking the existing npm version ${version} before resuming.`);
  // A successful PUT can precede public metadata, the tarball and dist-tags by over a minute.
  // One deadline covers all of those reads. Immutable identity/content mismatches fail at once.
  const started = now(), deadline = started + waitTimeoutMs;
  const readOptions = () => ({ timeoutMs: Math.max(1, Math.min(20_000, deadline - now())) });
  let packageVerified = false, waiting = "version metadata is not visible";
  const expired = () => {
    const recovery = packageVerified
      ? `npm ${version} is verified. Restore that dist-tag explicitly after checking the release order, then retry.`
      : "Retry the same release to verify the existing version before publishing again.";
    return new Error(`npm publication could not be confirmed after ${Math.ceil((now() - started) / 1000)}s: ${waiting}. ${publicationStatus} ${recovery}`);
  };
  for (;;) {
    if (now() >= deadline) throw expired();
    try {
      metadata ??= await readVersion(readOptions());
      if (!metadata) waiting = "version metadata is not visible";
      if (metadata) {
        if (!packageVerified) {
          assertPublishedMetadata(metadata, { version, head, integrity });
          assertPublishedPackage(metadata, { version, head, integrity }, await readTarball(metadata, readOptions()));
          packageVerified = true;
        }
        const tags = await checkNpmOrder(readOptions());
        if (tags[channel] === version) break;
        waiting = `npm ${channel} does not yet point to ${version}`;
      }
    } catch (error) {
      if (!error.retryable) throw error;
      waiting = error.message;
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw expired();
    log(`Waiting for npm publication (${Math.floor((now() - started) / 1000)}/${waitTimeoutMs / 1000}s): ${waiting}.`);
    await sleep(Math.min(10_000, remaining));
  }
  log(`Verified npm ${version} commit, tarball and ${channel} after ${Math.ceil((now() - started) / 1000)}s.`);
  const tags = await checkOrder();
  if (tags[channel] !== version) {
    throw new Error(`npm ${version} is verified, but ${channel} points to ${tags[channel] ?? "no version"}. Restore that dist-tag explicitly after checking the release order, then retry. Nothing was republished.`);
  }
  const existing = await readRelease(channel);
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
  const sh = async (program, args) => (await command(program, args, { cwd: root, timeout: 180_000 })).stdout;
  const pkg = parseReleaseJson(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = parseReleaseJson(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const tag = process.argv[2];
  if (lock.version !== pkg.version) throw new Error("The lockfile and package versions differ.");
  releaseChannel({ ...pkg, lockVersion: lock.packages[""].version, tag });
  const head = await sh("git", ["rev-parse", "HEAD"]);
  if (await sh("git", ["rev-parse", `${tag}^{commit}`]) !== head || await sh("git", ["status", "--porcelain"])) {
    throw new Error("Publish from a clean checkout at the release tag.");
  }
  const github = async endpoint => {
    try { return parseReleaseJson(await sh("gh", ["api", `repos/${repository}/${endpoint}`])); }
    catch (error) {
      if (error.httpStatus === 404) return null;
      throw error;
    }
  };
  const temporary = await mkdtemp(path.join(tmpdir(), "moondog-npm-release-"));
  try {
    const [packed] = parseReleaseJson(await sh("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary]));
    const integrity = packageIntegrity(await readFile(path.join(temporary, packed.filename)));
    await prepareRelease({ version: pkg.version, head, integrity,
      readTags: options => registryRequest("https://registry.npmjs.org/-/package/@audiofool%2fmoondog/dist-tags", options),
      readVersion: options => registryRequest(`https://registry.npmjs.org/@audiofool%2fmoondog/${pkg.version}`, { ...options, missing: true }),
      readTarball: (metadata, options) => {
        const expected = `https://registry.npmjs.org/@audiofool/moondog/-/moondog-${pkg.version}.tgz`;
        if (metadata.dist?.tarball !== expected) throw new Error("Unexpected npm tarball URL.");
        return registryRequest(expected, { ...options, binary: true });
      },
      latestGithubVersion: async () => (await github("releases/latest"))?.tag_name?.replace(/^v/u, "") ?? null,
      publish: channel => sh("npm", ["publish", "--ignore-scripts", "--provenance", "--access", "public", "--tag", channel]),
      readRelease: channel => readGithubRelease({ tag, prerelease: channel === "beta", request: github }),
      createDraft: channel => sh("gh", ["release", "create", tag, "--repo", repository, "--verify-tag", "--generate-notes", "--draft", "--latest=false", ...(channel === "beta" ? ["--prerelease"] : [])]),
      log: console.log,
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
