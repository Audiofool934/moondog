import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  copyReleaseFiles,
  visibleReleasePaths,
} from "../../scripts/public-source-tree.mjs";
import { writeFictionalSpotifyHistoryArchive } from "../../src/demo/fictional-spotify-history.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function waitForStudioUrl(child, stdoutState, stderr) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => {
      reject(new Error(`zero-install Studio timed out: ${stderr.value}`));
    }, 15_000);
    const finish = (callback) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      callback();
    };
    const onData = (chunk) => {
      stdout += String(chunk);
      stdoutState.value = `${stdoutState.value}${chunk}`.slice(-8_192);
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?session=[A-Za-z0-9_-]+/u);
      if (match) finish(() => resolve(match[0]));
    };
    const onExit = (code, signal) => {
      finish(() => reject(new Error(
        `zero-install Studio exited before readiness with ${code ?? signal}: ${stderr.value}`,
      )));
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForClose(child) {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function waitWithTimeout(promise, milliseconds, message) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), milliseconds);
    timer.unref();
  });
  return Promise.race([promise, timedOut]).then((result) => {
    clearTimeout(timer);
    if (result === null) throw new Error(message);
    return result;
  });
}

function signalStudioProcessTree(child, signal) {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function stopStudioProcessTree(child, closed) {
  signalStudioProcessTree(child, "SIGTERM");
  try {
    return {
      ...(await waitWithTimeout(
        closed,
        5_000,
        "Studio process tree did not close after SIGTERM",
      )),
      forced: false,
    };
  } catch (error) {
    signalStudioProcessTree(child, "SIGKILL");
    return {
      ...(await waitWithTimeout(closed, 5_000, error.message)),
      forced: true,
    };
  }
}

function npmInvocation(extraArguments = []) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? {
        command: process.execPath,
        args: [
          npmExecPath,
          ...(extraArguments.length > 0 ? ["--silent"] : []),
          "run",
          "demo:studio",
          ...(extraArguments.length > 0 ? ["--", ...extraArguments] : []),
        ],
      }
    : {
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: [
          ...(extraArguments.length > 0 ? ["--silent"] : []),
          "run",
          "demo:studio",
          ...(extraArguments.length > 0 ? ["--", ...extraArguments] : []),
        ],
      };
}

async function copyCleanSource(destination) {
  await mkdir(destination, { mode: 0o700 });
  const paths = await visibleReleasePaths(repositoryRoot);
  await copyReleaseFiles({
    sourceRoot: repositoryRoot,
    destinationRoot: destination,
    paths,
  });
  await assert.rejects(access(path.join(destination, "node_modules")), /ENOENT/u);
}

async function createAccountArchive(root) {
  const dataRoot = path.join(root, "Spotify Account Data");
  const archivePath = path.join(root, "spotify-account-data.zip");
  await mkdir(dataRoot);
  await writeFile(
    path.join(dataRoot, "StreamingHistory_music_0.json"),
    JSON.stringify([
      {
        endTime: "2026-08-26 09:30",
        artistName: "Zero Install Ensemble",
        trackName: "Private Orbit",
        msPlayed: 183_000,
      },
    ]),
  );
  await execFileAsync(
    "/usr/bin/zip",
    ["-q", "-r", archivePath, "Spotify Account Data"],
    { cwd: root },
  );
  return archivePath;
}

test("the interactive fictional Studio starts from a clean source checkout without installed dependencies", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-zero-install-studio-"));
  const sourceRoot = path.join(root, "source");
  const stateRoot = path.join(root, "private-state-must-not-exist");
  const configRoot = path.join(root, "private-config-must-not-exist");
  await copyCleanSource(sourceRoot);
  const packageMetadata = JSON.parse(
    await readFile(path.join(sourceRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageMetadata.scripts.start,
    packageMetadata.scripts.moondog,
  );

  const stderr = { value: "" };
  const stdout = { value: "" };
  let stopped = false;
  const invocation = npmInvocation();
  const child = spawn(invocation.command, invocation.args, {
    cwd: sourceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      MOONDOG_CONFIG_HOME: configRoot,
      MOONDOG_STATE_HOME: stateRoot,
      MOONDOG_STUDIO_NO_OPEN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = waitForClose(child);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.value = `${stderr.value}${chunk}`.slice(-8_192);
  });
  context.after(async () => {
    if (!stopped) {
      await stopStudioProcessTree(child, closed);
    }
    await rm(root, { recursive: true, force: true });
  });

  const studioUrl = new URL(await waitForStudioUrl(child, stdout, stderr));
  const token = studioUrl.searchParams.get("session");
  assert.ok(token);
  const profileResponse = await fetch(new URL("/api/profile", studioUrl), {
    headers: { "X-Moondog-Session": token },
  });
  const profile = await profileResponse.json();
  assert.equal(profileResponse.status, 200);
  assert.equal(profile.profile_kind, "synthetic_demo");
  assert.equal(profile.demo_proof.production_importer, true);
  assert.equal(profile.demo_proof.private_listener_data_read, false);
  assert.equal(profile.demo_proof.persistent_profile_writes, false);
  assert.equal(profile.time_machine.landmark_count, 4);
  assert.equal(profile.historical_returns.return_track_count, 4);
  assert.equal(profile.listening_patterns.session.session_count, 15);
  assert.equal(profile.listening_patterns.release_count, 2);
  await assert.rejects(access(stateRoot), /ENOENT/u);
  await assert.rejects(access(configRoot), /ENOENT/u);

  const result = await stopStudioProcessTree(child, closed);
  stopped = true;
  assert.equal(result.forced, false, stderr.value);
  assert.ok(
    (result.code === 0 && result.signal === null)
      || (result.code === null && result.signal === "SIGTERM"),
    stderr.value,
  );
});

test("explicit Studio command opens one Spotify ZIP without dependencies or persistent state", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-zero-install-private-"));
  const sourceRoot = path.join(root, "source");
  const archivePath = path.join(root, "fictional-private-history.zip");
  const stateRoot = path.join(root, "private-state-must-not-exist");
  const configRoot = path.join(root, "private-config-must-not-exist");
  await writeFictionalSpotifyHistoryArchive({ outputPath: archivePath });
  const archiveBefore = await stat(archivePath);
  await copyCleanSource(sourceRoot);

  const stderr = { value: "" };
  const stdout = { value: "" };
  let stopped = false;
  const invocation = npmInvocation(["--from", archivePath]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: sourceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      MOONDOG_CONFIG_HOME: configRoot,
      MOONDOG_STATE_HOME: stateRoot,
      MOONDOG_STUDIO_NO_OPEN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = waitForClose(child);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.value = `${stderr.value}${chunk}`.slice(-8_192);
  });
  context.after(async () => {
    if (!stopped) await stopStudioProcessTree(child, closed);
    await rm(root, { recursive: true, force: true });
  });

  const studioUrl = new URL(await waitForStudioUrl(child, stdout, stderr));
  const token = studioUrl.searchParams.get("session");
  const profileResponse = await fetch(new URL("/api/profile", studioUrl), {
    headers: { "X-Moondog-Session": token },
  });
  const profile = await profileResponse.json();
  assert.equal(profileResponse.status, 200);
  assert.equal(profile.profile_kind, "private_session");
  assert.equal(profile.source.input_records, 52);
  assert.equal(profile.source.persistent_import, false);
  assert.equal(profile.coverage.effective_listening_events, 52);
  assert.equal(profile.listening_seasons.retained_season_count, 13);
  assert.match(stdout.value, /Session-only private profile/u);
  assert.doesNotMatch(stdout.value, new RegExp(root, "u"));
  assert.doesNotMatch(JSON.stringify(profile), new RegExp(root, "u"));
  await assert.rejects(access(stateRoot), /ENOENT/u);
  await assert.rejects(access(configRoot), /ENOENT/u);

  const result = await stopStudioProcessTree(child, closed);
  stopped = true;
  assert.equal(result.forced, false, stderr.value);
  const archiveAfter = await stat(archivePath);
  assert.equal(archiveAfter.size, archiveBefore.size);
  assert.equal(archiveAfter.mtimeMs, archiveBefore.mtimeMs);
});

test("explicit Studio command reconciles two Spotify ZIPs without dependencies or persistent state", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-zero-install-private-set-"));
  const sourceRoot = path.join(root, "source");
  const extendedPath = path.join(root, "fictional-extended-history.zip");
  await writeFictionalSpotifyHistoryArchive({ outputPath: extendedPath });
  const accountPath = await createAccountArchive(root);
  const extendedBefore = await stat(extendedPath);
  const accountBefore = await stat(accountPath);
  const stateRoot = path.join(root, "private-state-must-not-exist");
  const configRoot = path.join(root, "private-config-must-not-exist");
  await copyCleanSource(sourceRoot);

  const stderr = { value: "" };
  const stdout = { value: "" };
  let stopped = false;
  const invocation = npmInvocation([
    "--from",
    accountPath,
    "--from",
    extendedPath,
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: sourceRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      MOONDOG_CONFIG_HOME: configRoot,
      MOONDOG_STATE_HOME: stateRoot,
      MOONDOG_STUDIO_NO_OPEN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = waitForClose(child);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.value = `${stderr.value}${chunk}`.slice(-8_192);
  });
  context.after(async () => {
    if (!stopped) await stopStudioProcessTree(child, closed);
    await rm(root, { recursive: true, force: true });
  });

  const studioUrl = new URL(await waitForStudioUrl(child, stdout, stderr));
  const token = studioUrl.searchParams.get("session");
  const profileResponse = await fetch(new URL("/api/profile", studioUrl), {
    headers: { "X-Moondog-Session": token },
  });
  const profile = await profileResponse.json();
  assert.equal(profileResponse.status, 200);
  assert.equal(profile.profile_kind, "private_session");
  assert.equal(profile.source.archive_count, 2);
  assert.equal(profile.source.data_scope, "combined_spotify_history");
  assert.equal(profile.source.persistent_import, false);
  assert.equal(profile.source.input_records, 53);
  assert.equal(profile.coverage.effective_listening_events, 53);
  assert.match(stdout.value, /Both original ZIPs stay untouched/u);
  assert.doesNotMatch(stdout.value, new RegExp(root, "u"));
  assert.doesNotMatch(JSON.stringify(profile), new RegExp(root, "u"));
  await assert.rejects(access(stateRoot), /ENOENT/u);
  await assert.rejects(access(configRoot), /ENOENT/u);

  const result = await stopStudioProcessTree(child, closed);
  stopped = true;
  assert.equal(result.forced, false, stderr.value);
  const extendedAfter = await stat(extendedPath);
  const accountAfter = await stat(accountPath);
  assert.equal(extendedAfter.size, extendedBefore.size);
  assert.equal(extendedAfter.mtimeMs, extendedBefore.mtimeMs);
  assert.equal(accountAfter.size, accountBefore.size);
  assert.equal(accountAfter.mtimeMs, accountBefore.mtimeMs);
});
