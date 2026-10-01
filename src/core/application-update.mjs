import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMoondogSettingsFile } from "../runtime/pi/runtime-settings.mjs";
import { resolveMoondogStateDirectory } from "./state-directory.mjs";

const exec = promisify(execFile);
export const UPDATE_PACKAGE = "@audiofool/moondog";
const REPOSITORY = "https://github.com/Audiofool934/moondog";
const DEFAULT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CACHE_MS = 24 * 60 * 60_000;
const failure = (code, message) => Object.assign(new Error(message), { code });
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };
async function resolvedPath(file) {
  try { return await realpath(file); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    return parent === file ? file : path.join(await resolvedPath(parent), path.basename(file));
  }
}
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

export function releaseVersion(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-beta\.(0|[1-9]\d{0,5}))?$/u);
  return match ? [...match.slice(1, 4).map(Number), match[4] === undefined ? Infinity : Number(match[4])] : null;
}
export function compareReleaseVersions(a, b) {
  const left = releaseVersion(a), right = releaseVersion(b);
  if (!left || !right) throw failure("update_version_invalid", "The release version is unsupported.");
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  return 0;
}
function channelName(value) {
  if (!["latest", "beta"].includes(value)) throw failure("update_channel_invalid", "Choose the latest or beta update channel.");
  return value;
}
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
async function command(binary, args, options = {}) {
  return (await exec(binary, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024, ...options })).stdout.trim();
}
async function boundedBody(response, maximum) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("Update download exceeds its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Covers older installations that do not know about the update lock. Only PID
// values leave this function; process arguments are never logged or persisted.
export async function activeInstallationProcesses(root, { run = command, ownPid = process.pid, platform = process.platform } = {}) {
  const output = await run("ps", ["-axo", "pid=,comm=,args="], { timeout: 5_000 });
  const active = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/u);
    if (!match || Number(match[1]) === ownPid) continue;
    const exactLauncher = match[3].includes(path.join(root, "scripts", "moondog"));
    if (!exactLauncher && !/^(?:node(?:js|\d+(?:\.\d+)*)?|moondog)$/u.test(path.basename(match[2]))) continue;
    if (!/(?:^|[ /])(?:scripts\/)?moondog(?:\.mjs)?(?:\s|$)/u.test(match[3])) continue;
    let cwd = "";
    if (!match[3].includes(path.join(root, "scripts", "moondog"))) {
      try {
        cwd = platform === "linux" ? await readlink(`/proc/${match[1]}/cwd`) :
          (await run("lsof", ["-a", "-p", match[1], "-d", "cwd", "-Fn"], { timeout: 3_000 })).split("\n").find(value => value.startsWith("n"))?.slice(1);
      } catch { throw failure("update_session_check_failed", "Could not check another Moondog process. Close other sessions and retry."); }
      if (cwd !== root) continue;
    }
    active.push(Number(match[1]));
  }
  return active;
}

export function createApplicationUpdater({ root = DEFAULT_ROOT, environment = process.env, fetchImpl = globalThis.fetch,
  run = command, now = Date.now, activeProcesses, node = process.execPath, npm = "npm" } = {}) {
  root = realpathSync(path.resolve(root));
  const storage = path.join(path.dirname(resolveMoondogSettingsFile(environment)), "updates");
  // Installation-wide, even when two sessions use different config homes.
  const lock = path.join(path.dirname(root), ".moondog-update-" + createHash("sha256").update(root).digest("hex").slice(0, 24) + ".lock");
  const recovery = lock + ".recovery.json";
  const settings = path.join(storage, "settings.json");
  const git = (args, options = {}) => run("git", ["-C", root, ...args], { env: environment, ...options });
  const inspectProcesses = () => activeProcesses ? activeProcesses(root) : activeInstallationProcesses(root, { run });
  const packageInfo = async () => {
    const value = await readJson(path.join(root, "package.json"));
    if (value.name !== UPDATE_PACKAGE || !releaseVersion(value.version)) throw failure("update_installation_invalid", "This is not a supported Moondog installation.");
    return value;
  };
  async function assertDataOutsideReplacement(mode) {
    const replaced = mode === "npm" ? root : path.join(root, "node_modules");
    const canonical = await resolvedPath(replaced);
    const personal = [path.dirname(resolveMoondogSettingsFile(environment)), resolveMoondogStateDirectory(environment),
      environment.MOONDOG_APPLE_IMPORTS_ROOT, environment.MOONDOG_APPLE_PROJECTION_PATH].filter(Boolean);
    for (const file of personal) {
      if (inside(replaced, path.resolve(file)) || inside(canonical, await resolvedPath(path.resolve(file)))) {
        throw failure("update_data_inside_installation", "Personal data is configured inside the program directory being replaced. Move that data and update its configured path before updating; nothing was replaced.");
      }
    }
    if (mode === "npm" && await exists(path.join(root, "data"))) throw failure("update_data_inside_installation", "Legacy data exists inside this installation. Move it to the configured state directory before updating.");
  }
  async function installation() {
    const info = await packageInfo();
    if (await exists(path.join(root, ".git"))) {
      if (await git(["rev-parse", "--show-toplevel"]) !== root) throw failure("update_installation_invalid", "The source checkout root is inconsistent.");
      return { mode: "source", root, version: info.version };
    }
    const prefix = path.resolve(root, "../../../..");
    if (path.join(prefix, "lib/node_modules/@audiofool/moondog") === root) {
      try {
        if (await realpath(path.join(prefix, "bin/moondog")) === path.join(root, "scripts/moondog")) return { mode: "npm", root, prefix, version: info.version };
      } catch { /* Local installs and unrelated launchers are not managed here. */ }
    }
    return { mode: "unmanaged", root, version: info.version };
  }
  async function selectedChannel() {
    try { return channelName((await readJson(settings)).channel); } catch { return "latest"; }
  }
  async function assertNotUpdating() {
    if (await exists(recovery)) throw failure("update_recovery_required", `An interrupted update needs recovery. See ${recovery}.`);
    if (!await exists(lock)) return;
    let owner;
    try { owner = await readJson(path.join(lock, "owner.json")); } catch { throw failure("update_busy", "Another update is starting. Wait for it to finish."); }
    if (!Number.isInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) throw failure("update_busy", "Another Moondog update is running. Wait for it to finish.");
  }
  async function check({ channel, force = false, signal } = {}) {
    const current = await packageInfo();
    channel = channelName(channel ?? await selectedChannel());
    const cache = path.join(storage, `${channel}.json`);
    if (!force) {
      try {
        const cached = await readJson(cache), age = now() - cached.checkedAt;
        if (age >= 0 && age < CACHE_MS && cached.current === current.version && cached.channel === channel) return cached;
      } catch { /* A missing or damaged cache cannot prevent startup. */ }
    }
    let result;
    try {
      const controller = AbortSignal.timeout(5_000);
      const response = await fetchImpl(`https://registry.npmjs.org/@audiofool%2fmoondog/${channel}`, {
        signal: signal ? AbortSignal.any([signal, controller]) : controller,
        redirect: "error", headers: { Accept: "application/json" },
      });
      if (response.status === 404) throw failure("update_channel_empty", `No ${channel} release has been published yet.`);
      if (!response.ok) throw new Error("Registry unavailable");
      const body = (await boundedBody(response, 512_000)).toString("utf8");
      const release = JSON.parse(body);
      if (release.name !== UPDATE_PACKAGE || !releaseVersion(release.version) ||
          channel === "latest" && release.version.includes("-") ||
          ![`${REPOSITORY}.git`, `git+${REPOSITORY}.git`].includes(release.repository?.url)) throw new Error("Invalid release metadata");
      const minimum = release.engines?.node?.match(/^>=(\d+\.\d+\.\d+)$/u)?.[1];
      if (!minimum || !releaseVersion(minimum)) throw new Error("Unsupported runtime requirement");
      const tarball = `https://registry.npmjs.org/@audiofool/moondog/-/moondog-${release.version}.tgz`;
      if (release.dist?.tarball !== tarball || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(release.dist?.integrity ?? "")) throw new Error("Unsupported package integrity metadata");
      result = { state: compareReleaseVersions(release.version, current.version) > 0 ? "available" : "current", current: current.version,
        latest: release.version, channel, minimumNode: minimum,
        compatible: compareReleaseVersions(process.versions.node, minimum) >= 0,
        gitHead: /^[a-f0-9]{40}$/u.test(release.gitHead ?? "") ? release.gitHead : null,
        tarball, integrity: release.dist.integrity,
        releaseUrl: `${REPOSITORY}/releases/tag/v${release.version}` };
    } catch (error) {
      signal?.throwIfAborted();
      result = { state: "unavailable", current: current.version, channel,
        message: error.code === "update_channel_empty" ? error.message : "Could not check for updates. Your installed version is still available." };
    }
    result.checkedAt = now();
    await atomicJson(cache, result).catch(() => {});
    return result;
  }
  async function assertSourceUnchanged(head) {
    const origin = await git(["remote", "get-url", "origin"]);
    if (![`${REPOSITORY}.git`, REPOSITORY, "git@github.com:Audiofool934/moondog.git"].includes(origin)) throw failure("update_source_remote", "Source updates require the official Moondog origin. Update this checkout manually.");
    if (await git(["branch", "--show-current"]) !== "main") throw failure("update_source_branch", "Source updates require the main branch. Your current branch was left unchanged.");
    if (await git(["status", "--porcelain", "--untracked-files=normal"])) throw failure("update_source_dirty", "This checkout has local changes. Commit or move them before updating; nothing was overwritten.");
    if (head && await git(["rev-parse", "HEAD"]) !== head) throw failure("update_source_changed", "The checkout changed while preparing the update. Nothing was installed.");
  }
  async function noActiveSessions() {
    if ((await inspectProcesses()).length) throw failure("update_session_active", "Another Moondog session is running. Close it before updating.");
  }
  async function smoke(stagedRoot, version, signal) {
    const isolated = path.join(path.dirname(stagedRoot), `.update-smoke-${randomUUID()}`);
    await mkdir(isolated, { mode: 0o700 });
    try {
      const output = await run(node, [path.join(stagedRoot, "scripts/moondog.mjs"), "--version"], {
        cwd: stagedRoot, timeout: 15_000, signal,
        env: { ...environment, MOONDOG_CONFIG_HOME: isolated, MOONDOG_STATE_HOME: isolated, MOONDOG_UPDATE_CHECK: "off" },
      });
      if (output !== version) throw failure("update_verification_failed", "The prepared program did not report the expected version. Your installation was left unchanged.");
    } finally { await rm(isolated, { recursive: true, force: true }); }
  }
  async function apply({ channel, signal, onProgress = () => {} } = {}) {
    await assertNotUpdating();
    await mkdir(storage, { recursive: true, mode: 0o700 });
    // Never remove a lock after a separate read: another updater could acquire
    // it between those operations. Abandoned locks require explicit recovery.
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") throw failure("update_busy", `An update lock already exists. If its owner has exited, follow docs/UPDATES.md to recover: ${lock}`); throw error; }
    let stage, backup, install, priorHead, installed = false, sourceAttempted = false, dependenciesMoved = false, replacementMoved = false;
    try {
      await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      install = await installation();
      if (install.mode === "unmanaged") throw failure("update_installation_unmanaged", "This installation is managed by another tool or local project. Update it using its original installation method.");
      await assertDataOutsideReplacement(install.mode);
      await noActiveSessions();
      if (install.mode === "source") { await assertSourceUnchanged(); priorHead = await git(["rev-parse", "HEAD"]); }
      onProgress("Checking the selected release channel...");
      const release = await check({ channel, force: true, signal });
      if (release.state === "unavailable") throw failure("update_check_failed", release.message);
      if (release.state !== "available") {
        await atomicJson(settings, { channel: release.channel });
        return release;
      }
      if (!release.compatible) throw failure("update_node_required", `This release needs Node ${release.minimumNode} or newer. Update Node first; Moondog was left unchanged.`);
      await access(path.dirname(root), constants.W_OK);
      stage = await mkdtemp(path.join(path.dirname(root), ".moondog-update-"));
      backup = path.join(stage, "previous");
      let stagedRoot;
      onProgress(`Preparing Moondog ${release.latest}. The installed program and your data are unchanged.`);
      if (install.mode === "source") {
        if (!release.gitHead) throw failure("update_release_unverified", "The release has no source commit identity. Update this checkout manually.");
        const tag = `refs/tags/v${release.latest}`;
        await git(["fetch", "--no-tags", "origin", `${tag}:${tag}`], { signal });
        if (await git(["rev-parse", `${tag}^{commit}`]) !== release.gitHead) throw failure("update_release_unverified", "The release tag does not match the published package. No update was installed.");
        try { await git(["merge-base", "--is-ancestor", priorHead, release.gitHead]); }
        catch { throw failure("update_source_diverged", "This checkout is ahead of or diverges from the published release. No history was replaced."); }
        stagedRoot = path.join(stage, "source");
        await mkdir(stagedRoot);
        const archive = path.join(stage, "release.tar");
        await git(["archive", "--format=tar", `--output=${archive}`, release.gitHead], { signal });
        await run("tar", ["-xf", archive, "-C", stagedRoot], { signal });
        await run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], { cwd: stagedRoot, env: environment, signal });
      } else {
        const prefix = path.join(stage, "install");
        const response = await fetchImpl(release.tarball, { redirect: "error",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
        if (!response.ok) throw failure("update_download_failed", "The release package could not be downloaded. Nothing was installed.");
        const archive = await boundedBody(response, 16 * 1024 * 1024);
        if (`sha512-${createHash("sha512").update(archive).digest("base64")}` !== release.integrity) throw failure("update_integrity_failed", "The package did not match the published checksum. Nothing was installed.");
        const tarball = path.join(stage, "release.tgz");
        await writeFile(tarball, archive, { mode: 0o600 });
        await run(npm, ["install", "--prefix", prefix, "--install-strategy=nested", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--registry=https://registry.npmjs.org/", tarball], { env: environment, signal });
        stagedRoot = path.join(prefix, "node_modules/@audiofool/moondog");
      }
      const prepared = await readJson(path.join(stagedRoot, "package.json"));
      if (prepared.name !== UPDATE_PACKAGE || prepared.version !== release.latest) throw failure("update_verification_failed", "The prepared package identity did not match. Nothing was installed.");
      await smoke(stagedRoot, release.latest, signal);
      await noActiveSessions();
      await assertDataOutsideReplacement(install.mode);
      if (install.mode === "source") await assertSourceUnchanged(priorHead);
      else if ((await packageInfo()).version !== install.version) throw failure("update_installation_changed", "The installed version changed during preparation. Retry after the other update finishes.");
      signal?.throwIfAborted();
      const record = { installation: root, mode: install.mode, previousVersion: install.version, version: release.latest,
        previousHead: priorHead ?? null, targetHead: release.gitHead, backup, stage };
      await atomicJson(recovery, record);
      onProgress(`Installing ${release.latest}. Recovery record: ${recovery}`);
      // Once replacement begins, settle it or restore our own change before
      // honoring cancellation. No user data is opened, migrated or removed.
      if (install.mode === "source") {
        sourceAttempted = true;
        await git(["merge", "--ff-only", "--no-overwrite-ignore", release.gitHead]);
        installed = true;
        if (await exists(path.join(root, "node_modules"))) { await rename(path.join(root, "node_modules"), backup); dependenciesMoved = true; }
        await rename(path.join(stagedRoot, "node_modules"), path.join(root, "node_modules")); replacementMoved = true;
      } else {
        await rename(root, backup); dependenciesMoved = true;
        await rename(stagedRoot, root); installed = true; replacementMoved = true;
      }
      await smoke(root, release.latest);
      await atomicJson(path.join(storage, "last-update.json"), record);
      await atomicJson(settings, { channel: release.channel });
      await rm(recovery);
      return { ...release, state: "updated", previous: install.version, recoveryBackup: backup, restartRequired: true };
    } catch (error) {
      if (await exists(recovery)) {
        try {
          if (install.mode === "source") {
            const record = await readJson(recovery);
            if (sourceAttempted) {
              // A command can change HEAD and then report a timeout/error.
              // Observe the actual repository before deciding it is unchanged.
              const currentHead = await git(["rev-parse", "HEAD"]);
              if (currentHead === record.targetHead) {
                await assertSourceUnchanged(record.targetHead);
                await git(["reset", "--hard", priorHead]);
              } else if (currentHead === priorHead) await assertSourceUnchanged(priorHead);
              else throw failure("update_source_changed", "Source identity is uncertain; recovery is required.");
            }
            if (replacementMoved) await rename(path.join(root, "node_modules"), path.join(stage, "failed-dependencies"));
            if (dependenciesMoved) await rename(backup, path.join(root, "node_modules"));
          } else {
            if (replacementMoved) await rename(root, path.join(stage, "failed-install"));
            if (dependenciesMoved) await rename(backup, root);
          }
          await rm(recovery);
          installed = false;
        } catch { throw failure("update_recovery_required", `The update stopped and needs recovery. Your previous program is preserved. See ${recovery}.`); }
      }
      if (error.name === "AbortError") throw error;
      if (typeof error.code === "string" && error.code.startsWith("update_")) throw error;
      throw failure("update_failed", "The update could not finish. The previous program was retained or restored; your personal data was not changed.");
    } finally {
      if (stage && !installed && !await exists(recovery)) await rm(stage, { recursive: true, force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
  return { check, apply, installation, assertNotUpdating, version: async () => (await packageInfo()).version,
    startupCheck: options => environment.MOONDOG_UPDATE_CHECK === "off" ? Promise.resolve(null) : check(options) };
}
