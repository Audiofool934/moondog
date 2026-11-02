// Moondog's own Stable Audio 3 install. Only when the listener asks, it downloads uv, Stability AI's
// code, a Python environment and the chosen model's weights into one folder Moondog manages, only
// from the pinned official sources (sources.mjs), and checks every file before anything runs it.
// The terminal and the window are separate processes on that folder: a lock file names the process
// that runs the job, and that process writes its progress to a status file the other one reads.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { access, constants, lstat, mkdir, open, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkStableAudioInstall, readGenerationSettings, resolveGenerationSettingsFile, resolveStableAudioManagedRoot, writeGenerationSettings } from "./local-generator.mjs";
import { isStableAudioModel, SHARED_WEIGHTS, STABLE_AUDIO_MODELS, STABLE_AUDIO_SOURCES } from "./sources.mjs";

const MB = 1024 ** 2;
// Room kept free after each step, so a download never fills the disk.
const SPACE_MARGIN = 512 * MB;
// What the steps without a known size need on disk: uv unpacked, the code's tarball and tree, Python with its packages.
const STEP_SPACE = Object.freeze({ uv: 100 * MB, code: 200 * MB, python: 1536 * MB });
// At most four snapshots a second reach the surfaces while bytes arrive.
const PUSH_MS = 250;
// How often a surface that listens reads the folder again, which is how a job in the other process shows.
const POLL_MS = 1000;
// A lock file still being written is unreadable for a moment; one unreadable for longer is left over.
const LOCK_WRITE_MS = 5000;

const setupError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const cancelled = () => setupError("setup_cancelled", "The download was cancelled.");
const gigabytes = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** The listener's agreement to the licenses, kept with the settings so removing the install keeps it. */
export function resolveStableAudioLicenseFile(environment = process.env) {
  return path.join(path.dirname(resolveGenerationSettingsFile(environment)), "stable-audio-3-licenses.json");
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const sizeOf = (file) => {
  try {
    const info = statSync(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
};
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};
const executable = async (file) => {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};
async function writeJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}
async function sha256File(file, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    if (signal?.aborted) throw cancelled();
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * The setup both surfaces share. status() reads the folder each time, so it also shows a job the
 * other process runs; install() starts a job in the background; subscribe() hears its progress.
 */
export function createStableAudioSetup({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  platform = process.platform,
  arch = process.arch,
  now = () => new Date(),
  sources = STABLE_AUDIO_SOURCES,
  freeSpace = async (folder) => { const info = await statfs(folder); return info.bavail * info.bsize; },
} = {}) {
  const supported = platform === "darwin" && arch === "arm64";
  const root = resolveStableAudioManagedRoot(environment);
  const files = {
    lock: path.join(root, "setup.lock"),
    job: path.join(root, "job.json"),
    cancel: path.join(root, "cancel.json"),
    downloads: path.join(root, "downloads"),
    uv: path.join(root, "uv"),
    uvMarker: path.join(root, "uv", ".moondog.json"),
    mlx: path.join(root, "mlx"),
    codeMarker: path.join(root, "mlx", ".moondog-code.json"),
    venv: path.join(root, "mlx", ".venv"),
    envMarker: path.join(root, "mlx", ".venv", ".moondog-env.json"),
    weights: path.join(root, "mlx", "models", "mlx"),
    licenses: resolveStableAudioLicenseFile(environment),
  };
  const weightFiles = (model) => [...SHARED_WEIGHTS, ...STABLE_AUDIO_MODELS[model].weights];
  const weightSize = (name) => sources.weights.files[name].size;
  const part = (name) => path.join(files.downloads, `${name}.part`);
  const pythonPins = { python: sources.python.version, packages: [...sources.python.packages] };

  // The job this process runs, or null.
  let job = null;
  const listeners = new Set();
  let shown = null;
  let pushTimer = null;
  let poll = null;

  const base = () => ({
    uv: readJson(files.uvMarker)?.version === sources.uv.version && sizeOf(path.join(files.uv, "uv")) !== null ? "ready" : "absent",
    code: readJson(files.codeMarker)?.commit === sources.code.commit ? "ready" : "absent",
    python: JSON.stringify(readJson(files.envMarker)) === JSON.stringify(pythonPins) ? "ready" : "absent",
  });
  const jobView = () => {
    if (job) return { model: job.model, step: job.step, received: job.received, total: job.total, running: true };
    const saved = readJson(files.job);
    if (!saved || !isStableAudioModel(saved.model)) return null;
    const view = { model: saved.model, step: saved.step, received: saved.received ?? 0, total: saved.total ?? 0 };
    // A failed job stays until the next install, so the surfaces can say why and offer Try again.
    if (saved.error) return { ...view, running: false, error: saved.error };
    // Another process's job shows while that process holds the lock; a crashed one's does not.
    const lock = readJson(files.lock);
    return lock && lock.token === saved.token && alive(lock.pid) ? { ...view, running: true } : null;
  };

  /**
   * { supported, root, licenses: { accepted, at, links }, job, models, base }. job is null or
   * { model, step, received, total, running, error? }: received and total count the step's bytes.
   * Each model's bytes and total count all its weights, the shared text encoder included.
   */
  const status = () => {
    const agreement = readJson(files.licenses);
    const steps = base();
    const current = jobView();
    const baseReady = Object.values(steps).every((state) => state === "ready");
    const models = Object.fromEntries(Object.keys(STABLE_AUDIO_MODELS).map((model) => {
      let bytes = 0;
      let complete = true;
      for (const name of weightFiles(model)) {
        const size = weightSize(name);
        const present = sizeOf(path.join(files.weights, name)) === size;
        if (!present) complete = false;
        bytes += present ? size : Math.min(size, sizeOf(part(name)) ?? 0);
      }
      const own = STABLE_AUDIO_MODELS[model].weights.some((name) => sizeOf(path.join(files.weights, name)) !== null || sizeOf(part(name)) !== null);
      const total = weightFiles(model).reduce((sum, name) => sum + weightSize(name), 0);
      const state = complete && baseReady ? "ready" : own || (current?.running && current.model === model) ? "partial" : "absent";
      return [model, { state, bytes, total }];
    }));
    return {
      supported,
      root,
      licenses: { accepted: Boolean(agreement?.accepted_at), at: agreement?.accepted_at ?? null, links: sources.licenses.map((license) => ({ ...license })) },
      job: current,
      models,
      base: steps,
    };
  };

  const push = () => {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (!listeners.size) return;
    const snapshot = status();
    const key = JSON.stringify(snapshot);
    if (key === shown) return;
    shown = key;
    for (const listener of [...listeners]) {
      try { listener(structuredClone(snapshot)); } catch { /* A surface's redraw cannot stop the download. */ }
    }
  };
  const pushSoon = () => { pushTimer ??= setTimeout(push, PUSH_MS); pushTimer.unref?.(); };

  // The status file the other process reads, written with each snapshot at most.
  let saving = Promise.resolve();
  const saveJob = (extra = {}) => {
    if (!job) return saving;
    const record = { pid: process.pid, token: job.token, model: job.model, step: job.step, received: job.received, total: job.total, updated_at: now().toISOString(), ...extra };
    saving = saving.then(() => writeJson(files.job, record)).catch(() => {});
    return saving;
  };
  let saveTimer = null;
  const progress = (received, total) => {
    job.received = received;
    job.total = total;
    if (!saveTimer) {
      saveTimer = setTimeout(() => { saveTimer = null; void saveJob(); }, PUSH_MS);
      saveTimer.unref?.();
    }
    pushSoon();
  };
  const step = (name, total = 0) => {
    job.step = name;
    job.received = 0;
    job.total = total;
    void saveJob();
    push();
  };

  const takeLock = async (model, token) => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(files.lock, JSON.stringify({ pid: process.pid, token, model, started_at: now().toISOString() }), { flag: "wx", mode: 0o600 });
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const held = readJson(files.lock);
      let age = 0;
      try { age = Date.now() - statSync(files.lock).mtimeMs; } catch { continue; }
      if (held ? alive(held.pid) : age < LOCK_WRITE_MS) break;
      // The process that held it has ended, so its job is over.
      await rm(files.lock, { force: true });
    }
    throw setupError("setup_busy", "Stable Audio 3 is already being set up, here or in the other Moondog window or terminal.");
  };
  const releaseLock = async (token) => {
    if (readJson(files.lock)?.token === token) await rm(files.lock, { force: true });
  };
  const runningElsewhere = () => {
    const lock = readJson(files.lock);
    return Boolean(lock && alive(lock.pid) && lock.token !== job?.token);
  };

  const ensureSpace = async (bytes) => {
    const free = await freeSpace(root);
    const needed = bytes + SPACE_MARGIN;
    if (free < needed) {
      throw setupError("setup_disk_full", `There is not enough space on this Mac: ${gigabytes(needed)} is needed and ${gigabytes(free)} is free.`, { needed, free });
    }
  };

  // A command the setup runs (tar, uv). Its output can hold paths, so only the exit code is reported.
  const runCommand = (command, args, { env = environment, code, message }) => new Promise((resolve, reject) => {
    const { signal } = job.controller;
    if (signal.aborted) return reject(cancelled());
    const child = spawnImpl(command, args, { stdio: ["ignore", "ignore", "pipe"], env });
    let tail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => { tail = (tail + chunk).slice(-4000); });
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", () => { signal.removeEventListener("abort", stop); reject(setupError(code, message)); });
    child.once("exit", (exit) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(cancelled());
      else if (exit === 0) resolve();
      else reject(setupError(code, message, { detail: tail.trim().split("\n").slice(-3).join("\n") }));
    });
  });

  /**
   * Downloads one file into downloads/<name>.part, resuming with an HTTP Range request, checks its
   * size and sha256, and renames it into place. A file that fails the check is deleted; one cut off
   * by a dropped connection or a cancel stays, so the next install resumes it.
   */
  const download = async ({ url, name, size, sha256, target, onBytes }) => {
    const { signal } = job.controller;
    const partial = part(name);
    await mkdir(files.downloads, { recursive: true, mode: 0o700 });
    let offset = sizeOf(partial) ?? 0;
    if (size !== undefined && offset > size) {
      await rm(partial, { force: true });
      offset = 0;
    }
    let hash = createHash("sha256");
    if (offset > 0) {
      for await (const chunk of createReadStream(partial, { end: offset - 1 })) {
        if (signal.aborted) throw cancelled();
        hash.update(chunk);
      }
    }
    const host = new URL(url).host;
    let response;
    try {
      response = await fetchImpl(url, { headers: offset > 0 ? { Range: `bytes=${offset}-` } : {}, redirect: "follow", signal });
    } catch {
      if (signal.aborted) throw cancelled();
      throw setupError("setup_offline", `Moondog could not reach ${host}. Check the connection, then try again.`);
    }
    const finished = offset > 0 && response.status === 416 && size !== undefined && offset === size;
    if (offset > 0 && response.status === 416 && !finished) {
      // A partial file the server no longer accepts cannot be continued.
      await rm(partial, { force: true });
      throw setupError("setup_download_failed", `The download from ${host} could not continue. Try again.`);
    }
    if (offset > 0 && !finished && response.status !== 206) {
      // The server sent the whole file again, or nothing usable: start over.
      offset = 0;
      hash = createHash("sha256");
    }
    if (!finished && !response.ok) {
      await response.body?.cancel().catch(() => {});
      throw setupError("setup_download_failed", `The download from ${host} failed (HTTP ${response.status}). Try again later.`);
    }
    let received = offset;
    const length = Number(response.headers.get("content-length"));
    const total = size ?? (Number.isFinite(length) && length > 0 ? offset + length : 0);
    onBytes?.(received, total);
    if (finished) await response.body?.cancel().catch(() => {});
    else {
      const handle = await open(partial, offset > 0 ? "a" : "w", 0o600);
      try {
        for await (const chunk of response.body) {
          if (signal.aborted) throw cancelled();
          await handle.write(chunk);
          hash.update(chunk);
          received += chunk.length;
          if (size !== undefined && received > size) break;
          onBytes?.(received, total);
        }
      } catch (error) {
        if (signal.aborted || error?.code === "setup_cancelled") throw cancelled();
        throw setupError("setup_download_failed", `The download from ${host} stopped. Try again to continue it.`);
      } finally {
        await handle.close();
      }
    }
    if (size !== undefined && received < size) {
      throw setupError("setup_download_failed", `The download from ${host} stopped. Try again to continue it.`);
    }
    if ((size !== undefined && received !== size) || (sha256 && hash.digest("hex") !== sha256)) {
      await rm(partial, { force: true });
      throw setupError("setup_verification_failed", `${name} did not match the file Moondog expects, so it was deleted. Try again.`, { file: name });
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await rename(partial, target);
    return target;
  };

  // Checks an unpacked tree against the code's manifest: every file there, the same bytes, and
  // nothing else, links included, so the run never loads a file that was not checked.
  const verifyTree = async (folder) => {
    const expected = new Map(sources.code.files.map(([file, size, sha256]) => [file, { size, sha256 }]));
    const found = new Set();
    const walk = async (relative) => {
      for (const entry of await readdir(path.join(folder, relative))) {
        const file = relative ? `${relative}/${entry}` : entry;
        const info = await lstat(path.join(folder, file));
        if (info.isDirectory()) { await walk(file); continue; }
        const want = expected.get(file);
        if (!info.isFile() || !want || info.size !== want.size || (await sha256File(path.join(folder, file), job.controller.signal)) !== want.sha256) {
          throw setupError("setup_verification_failed", "Stable Audio 3's code did not match the files Moondog expects, so it was deleted. Try again.", { file });
        }
        found.add(file);
      }
    };
    await walk("");
    if (found.size !== expected.size) throw setupError("setup_verification_failed", "Stable Audio 3's code is missing files Moondog expects, so it was deleted. Try again.");
  };

  const setUpUv = async () => {
    if ((await executable(path.join(files.uv, "uv"))) && readJson(files.uvMarker)?.version === sources.uv.version) return;
    step("uv", sources.uv.size);
    await ensureSpace(sources.uv.size * 2 + STEP_SPACE.uv);
    const archive = await download({ url: sources.uv.url, name: "uv.tar.gz", size: sources.uv.size, sha256: sources.uv.sha256,
      target: path.join(files.downloads, "uv.tar.gz"), onBytes: progress });
    const temporary = `${files.uv}.tmp-${job.token}`;
    try {
      await rm(temporary, { recursive: true, force: true });
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      await runCommand("/usr/bin/tar", ["-xzf", archive, "-C", temporary, "--strip-components", "1"],
        { code: "setup_verification_failed", message: "uv could not be unpacked. Try again." });
      if (!(await executable(path.join(temporary, "uv")))) throw setupError("setup_verification_failed", "uv was not in its download. Try again.");
      await writeJson(path.join(temporary, ".moondog.json"), { version: sources.uv.version });
      await rm(files.uv, { recursive: true, force: true });
      await rename(temporary, files.uv);
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
  };

  const setUpCode = async () => {
    if (readJson(files.codeMarker)?.commit === sources.code.commit) return;
    step("code");
    await ensureSpace(STEP_SPACE.code);
    const archive = await download({ url: sources.code.url, name: "code.tar.gz", target: path.join(files.downloads, "code.tar.gz"), onBytes: progress });
    const temporary = `${files.mlx}.tmp-${job.token}`;
    try {
      await rm(temporary, { recursive: true, force: true });
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      step("verifying");
      const strip = String(sources.code.folder.split("/").length);
      await runCommand("/usr/bin/tar", ["-xzf", archive, "-C", temporary, "--strip-components", strip, sources.code.folder],
        { code: "setup_verification_failed", message: "Stable Audio 3's code could not be unpacked. Try again." });
      await verifyTree(temporary);
      // Weights and the environment from an earlier install move into the new tree.
      for (const kept of [path.join("models", "mlx"), ".venv"]) {
        if ((await stat(path.join(files.mlx, kept)).catch(() => null))?.isDirectory()) {
          await mkdir(path.dirname(path.join(temporary, kept)), { recursive: true });
          await rename(path.join(files.mlx, kept), path.join(temporary, kept));
        }
      }
      await writeJson(path.join(temporary, ".moondog-code.json"), { commit: sources.code.commit });
      await rm(files.mlx, { recursive: true, force: true });
      await rename(temporary, files.mlx);
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
  };

  const setUpPython = async () => {
    const python = path.join(files.venv, "bin", "python");
    if ((await executable(python)) && JSON.stringify(readJson(files.envMarker)) === JSON.stringify(pythonPins)) return;
    step("python");
    await ensureSpace(STEP_SPACE.python);
    // Only the pinned Python and packages from uv's defaults: the listener's own uv or pip settings
    // could point elsewhere, and the caches and Python stay in this folder so remove takes them too.
    const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(UV_|PIP_|VIRTUAL_ENV$|CONDA_|PYTHON)/u.test(name)));
    Object.assign(env, { UV_CACHE_DIR: path.join(root, "uv-cache"), UV_PYTHON_INSTALL_DIR: path.join(root, "python"),
      UV_PYTHON_PREFERENCE: "only-managed", UV_NO_CONFIG: "1", UV_NO_PROGRESS: "1" });
    const uv = path.join(files.uv, "uv");
    const failed = { code: "setup_python_failed", message: "The Python environment could not be set up. Check the connection, then try again." };
    await runCommand(uv, ["venv", "--clear", "--python", sources.python.version, files.venv], { env, ...failed });
    await runCommand(uv, ["pip", "install", "--python", python, ...sources.python.packages], { env, ...failed });
    await writeJson(files.envMarker, pythonPins);
  };

  const setUpWeights = async (model) => {
    const names = weightFiles(model);
    const total = names.reduce((sum, name) => sum + weightSize(name), 0);
    const missing = names.filter((name) => sizeOf(path.join(files.weights, name)) !== weightSize(name));
    if (!missing.length) return;
    step("weights", total);
    await ensureSpace(missing.reduce((sum, name) => sum + weightSize(name) - Math.min(weightSize(name), sizeOf(part(name)) ?? 0), 0));
    let done = total - missing.reduce((sum, name) => sum + weightSize(name), 0);
    for (const name of missing) {
      const { size, sha256 } = sources.weights.files[name];
      await download({ url: sources.weights.url(name), name, size, sha256, target: path.join(files.weights, name),
        onBytes: (received) => progress(done + received, total) });
      done += size;
    }
  };

  const finish = async (model) => {
    step("verifying");
    const install = await checkStableAudioInstall(files.mlx, { model, platform, arch });
    if (install.state !== "ready") throw setupError("setup_verification_failed", "Stable Audio 3 was set up but is not ready to run. Try again.");
    // The download was the listener's ask, so this model is turned on, unless a folder they chose
    // themselves runs now (they can still pick this one with Use) or MOONDOG_SA3_DIR decides.
    const settings = await readGenerationSettings(environment);
    if (settings.source === "environment") return;
    const runsNow = async () => (await checkStableAudioInstall(settings.path, { model: settings.model, platform, arch })).state === "ready";
    // A model of Moondog's own already in use stays in use too.
    if ((settings.source === "settings" || (settings.source === "managed" && settings.enabled)) && (await runsNow())) return;
    await writeGenerationSettings({ source: "managed", model, enabled: true }, environment);
  };

  const run = async (model, { baseOnly }) => {
    await setUpUv();
    await setUpCode();
    await setUpPython();
    if (baseOnly) return;
    await setUpWeights(model);
    await finish(model);
  };

  // A cancel asked in the other process reaches the job through a file that names it.
  const watchCancel = (token, controller) => {
    const timer = setInterval(() => { if (readJson(files.cancel)?.token === token) controller.abort(); }, 500);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return {
    supported,
    root,
    status,
    /**
     * Starts setting up a model in the background; resolves with status() once the job holds the
     * lock. Refuses without the licenses: pass accepted: true once, and the agreement is kept.
     */
    async install(model, { accepted = false, baseOnly = false } = {}) {
      if (!isStableAudioModel(model)) throw setupError("setup_model_unknown", "Choose medium or small-music.");
      if (!supported) throw setupError("setup_unsupported", "Stable Audio 3 needs a Mac with Apple silicon.");
      if (job) throw setupError("setup_busy", "Stable Audio 3 is already being set up.");
      if (!readJson(files.licenses)?.accepted_at) {
        if (accepted !== true) {
          throw setupError("setup_license_required", "Agree to the Stability AI Community License and the Gemma Terms of Use first.", { licenses: sources.licenses.map((license) => ({ ...license })) });
        }
        await mkdir(path.dirname(files.licenses), { recursive: true, mode: 0o700 });
        await writeJson(files.licenses, { version: 1, accepted_at: now().toISOString(), licenses: sources.licenses.map(({ id, url }) => ({ id, url })) });
      }
      const token = randomBytes(8).toString("hex");
      await takeLock(model, token);
      await rm(files.cancel, { force: true });
      const controller = new AbortController();
      job = { model, token, controller, step: "uv", received: 0, total: 0 };
      await saveJob();
      const unwatch = watchCancel(token, controller);
      job.done = (async () => {
        let failure = null;
        try {
          await run(model, { baseOnly });
        } catch (error) {
          if (!controller.signal.aborted && error?.code !== "setup_cancelled") {
            failure = { code: typeof error?.code === "string" && error.code.startsWith("setup_") ? error.code : "setup_failed",
              message: typeof error?.code === "string" && error.code.startsWith("setup_") ? error.message : "Stable Audio 3 could not be set up. Try again." };
          }
        } finally {
          unwatch();
          clearTimeout(saveTimer);
          saveTimer = null;
          if (failure) await saveJob({ error: failure });
          await saving;
          if (!failure) await rm(files.job, { force: true });
          await rm(files.cancel, { force: true });
          await releaseLock(token);
          job = null;
          push();
        }
        return status();
      })();
      push();
      return status();
    },
    /** Waits for this process's job to end; resolves with status(). */
    wait: () => job?.done ?? Promise.resolve(status()),
    /** Stops the job, here or in the other process; verified and .part files stay for a later install. */
    async cancel() {
      if (job) {
        job.controller.abort();
        await job.done;
        return true;
      }
      const lock = readJson(files.lock);
      if (!lock || !alive(lock.pid)) return false;
      await writeJson(files.cancel, { token: lock.token });
      return true;
    },
    /**
     * Deletes a model's own weights. With no model left, the whole folder goes: uv, the code,
     * Python, the caches and the shared weights. The licenses stay agreed. Refuses while a job runs.
     */
    async remove(model) {
      if (!isStableAudioModel(model)) throw setupError("setup_model_unknown", "Choose medium or small-music.");
      if (job || runningElsewhere()) throw setupError("setup_busy", "Stable Audio 3 is being set up. Cancel it first.");
      if (!(await stat(root).catch(() => null))) return status();
      const token = randomBytes(8).toString("hex");
      await takeLock(model, token);
      const other = Object.keys(STABLE_AUDIO_MODELS).find((name) => name !== model);
      try {
        for (const name of STABLE_AUDIO_MODELS[model].weights) {
          await rm(path.join(files.weights, name), { force: true });
          await rm(part(name), { force: true });
        }
        await rm(files.job, { force: true });
        const otherLeft = STABLE_AUDIO_MODELS[other].weights.some((name) => sizeOf(path.join(files.weights, name)) !== null || sizeOf(part(name)) !== null);
        if (!otherLeft) await rm(root, { recursive: true, force: true });
      } finally {
        await releaseLock(token);
      }
      // Music making that used this model moves to the other one, or back to the listener's folder.
      const settings = await readGenerationSettings(environment);
      if (settings.source === "managed" && settings.model === model) {
        await writeGenerationSettings(status().models[other].state === "ready" ? { model: other } : { source: "settings" }, environment);
      }
      push();
      return status();
    },
    /** Hears status() snapshots while anything changes, from this process's job or the other's. */
    subscribe(listener) {
      listeners.add(listener);
      if (!poll) {
        poll = setInterval(push, POLL_MS);
        poll.unref?.();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size && poll) {
          clearInterval(poll);
          poll = null;
          shown = null;
        }
      };
    },
  };
}

// A developer's way to try the real downloads from a terminal, into the state folder
// MOONDOG_STATE_HOME names: node src/integrations/stable-audio/setup.mjs status | install
// medium|small-music [--agree] [--base-only] | remove medium|small-music. --base-only stops before
// the weights, so uv, the code and Python can be tried without gigabytes.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = "status", model, ...flags] = process.argv.slice(2);
  const setup = createStableAudioSetup();
  const line = (snapshot) => {
    const { job } = snapshot;
    const state = Object.entries(snapshot.models).map(([name, entry]) => `${name} ${entry.state} ${gigabytes(entry.bytes)}/${gigabytes(entry.total)}`).join(", ");
    return `${job ? `${job.step} ${job.received}/${job.total}${job.error ? ` ${job.error.code}: ${job.error.message}` : ""} | ` : ""}${state} | base ${JSON.stringify(snapshot.base)}`;
  };
  try {
    if (command === "install") {
      const unsubscribe = setup.subscribe((snapshot) => console.log(line(snapshot)));
      process.once("SIGINT", () => { void setup.cancel(); });
      await setup.install(model, { accepted: flags.includes("--agree"), baseOnly: flags.includes("--base-only") });
      const end = await setup.wait();
      unsubscribe();
      console.log(line(end));
      process.exitCode = end.job?.error ? 1 : 0;
    } else if (command === "remove") {
      console.log(line(await setup.remove(model)));
    } else {
      console.log(JSON.stringify(setup.status(), null, 2));
    }
  } catch (error) {
    console.error(`${error.code ?? "error"}: ${error.message}`);
    process.exitCode = 1;
  }
}
