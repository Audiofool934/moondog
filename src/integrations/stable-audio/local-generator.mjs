// Makes music on this Mac with a local Stable Audio 3 install (Stability AI's optimized MLX
// build). The listener turns it on once, in Settings or with /generation; until then nothing
// runs. Each track is a WAV and a receipt in Moondog's state directory, and nothing leaves the
// machine: weights are never downloaded here, and the receipt keeps no absolute path.
import { spawn } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { access, chmod, constants, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { resolveMoondogStateDirectory } from "../../core/state-directory.mjs";
import { resolveMoondogAuthFile } from "../../runtime/pi/persistent-credential-store.mjs";

// The weights Stable Audio 3 Medium needs for text to music: the text encoder, the model and its decoder.
const MEDIUM_WEIGHTS = ["t5gemma_f16.npz", "dit_medium_f16.npz", "same_l_decoder_f32.npz"];
// Medium was trained on up to 380 seconds; very short clips come out rough.
export const GENERATION_SECONDS = Object.freeze({ min: 15, max: 380, default: 120 });
// A cold start reads about 4.8 GB of weights before the first step; a 380-second track then takes about 35 seconds.
const generationTimeoutMs = 10 * 60_000;
const stoppingGraceMs = 3_000;
const trackIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const isGeneratedTrackId = (value) => typeof value === "string" && trackIdPattern.test(value);

/** Where Stability's own install script puts the MLX build when it runs from ~/Developer. */
export function defaultStableAudioRoot() {
  return path.join(homedir(), "Developer", "stable-audio-3", "optimized", "mlx");
}

// Kept next to the playback preference, apart from runtime settings.
export function resolveGenerationSettingsFile(environment = process.env) {
  return path.join(path.dirname(resolveMoondogAuthFile(environment)), "generation.json");
}

/** The generated tracks: one folder per track, named by its id. */
export function resolveGeneratedTracksDirectory(environment = process.env) {
  return path.join(resolveMoondogStateDirectory(environment), "generated");
}

// A typed folder: absolute, or under the home folder with ~/.
function literalFolder(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const expanded = text === "~" ? homedir() : text.startsWith("~/") ? path.join(homedir(), text.slice(2)) : text;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : null;
}

/**
 * The listener's choice: { enabled, path, source }. Generation is off until they turn it on;
 * MOONDOG_SA3_DIR can point at another install but never turns it on.
 * A missing or unreadable file reads as off, so an older or newer file never stops the room.
 */
export async function readGenerationSettings(environment = process.env) {
  let document = null;
  try {
    document = JSON.parse(await readFile(resolveGenerationSettingsFile(environment), "utf8"));
  } catch { /* Not set up yet. */ }
  const saved = document?.version === 1 ? document : {};
  const fromEnvironment = literalFolder(environment.MOONDOG_SA3_DIR);
  const fromFile = literalFolder(saved.path);
  return {
    enabled: saved.enabled === true,
    path: fromEnvironment ?? fromFile ?? defaultStableAudioRoot(),
    source: fromEnvironment ? "environment" : fromFile ? "settings" : "default",
  };
}

export async function writeGenerationSettings({ enabled, path: folder } = {}, environment = process.env) {
  const current = await readGenerationSettings(environment);
  const typed = folder === undefined ? undefined : literalFolder(folder);
  if (folder !== undefined && folder !== null && !typed) {
    throw Object.assign(new Error("Give the Stable Audio 3 folder as a full path, or one starting with ~/."), { code: "generation_path_invalid" });
  }
  const document = {
    version: 1,
    enabled: enabled === undefined ? current.enabled : enabled === true,
    ...(typed ? { path: typed } : current.source === "settings" ? { path: current.path } : {}),
  };
  const file = resolveGenerationSettingsFile(environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return readGenerationSettings(environment);
}

const isFile = async (file, { executable = false, minimumBytes = 0 } = {}) => {
  try {
    // stat follows the install's symlinks into the Hugging Face cache, so a cleared cache reads as missing.
    const info = await stat(file);
    if (!info.isFile() || info.size < minimumBytes) return false;
    if (executable) await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether an install can make music now, without running it: "ready", "unsupported" (MLX needs
 * Apple silicon), "missing" (no install at the folder) or "incomplete" (no Python environment
 * or no Medium weights, which Stability's ./install.sh fetches).
 */
export async function checkStableAudioInstall(root, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "darwin" || arch !== "arm64") return { state: "unsupported" };
  if (!root || !path.isAbsolute(root)) return { state: "missing" };
  if (!(await isFile(path.join(root, "scripts", "sa3_mlx.py")))) return { state: "missing" };
  if (!(await isFile(path.join(root, ".venv", "bin", "python"), { executable: true }))) return { state: "incomplete", missing: "environment" };
  for (const weight of MEDIUM_WEIGHTS) {
    if (!(await isFile(path.join(root, "models", "mlx", weight), { minimumBytes: 1024 }))) return { state: "incomplete", missing: "weights" };
  }
  return { state: "ready" };
}

// The stage lines the script always prints, which are the only progress a pipe receives.
const STAGES = new Map([["1", "reading"], ["2", "reading"], ["3", "composing"], ["4", "decoding"], ["5", "writing"]]);
const doneLine = /done\s+([\d.]+)s\s+wall\s+\S+\s+([\d.]+)s\s+audio.*?peak\s+RAM\s+([\d.]+)\s+(MB|GB)/u;

const generationError = (code, message) => Object.assign(new Error(message), { code });

// Reads a WAV header, so a receipt states what was written and a truncated file never plays.
async function wavInfo(file) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(44);
    const { bytesRead } = await handle.read(header, 0, 44, 0);
    const size = (await handle.stat()).size;
    if (bytesRead < 44 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") return null;
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitDepth = header.readUInt16LE(34);
    const bytesPerSecond = sampleRate * channels * (bitDepth / 8);
    if (!channels || !sampleRate || !bytesPerSecond) return null;
    return { sample_rate: sampleRate, channels, bit_depth: bitDepth, size_bytes: size,
      duration_seconds: Math.round(((size - 44) / bytesPerSecond) * 100) / 100 };
  } finally {
    await handle.close();
  }
}

const capitalized = (value) => value.replace(/(^|[\s/-])(\p{L})/gu, (_, edge, letter) => `${edge}${letter.toUpperCase()}`);
const sentence = (value) => value ? value[0].toUpperCase() + value.slice(1) : value;

/**
 * Stable Audio 3's prompt for a compiled taste, in the tag form Stability's own prompt assistant
 * writes: instrumental first, then genres, instruments, and the sound in plain words, then the
 * tempo. The length is not prompt text; it goes to the model as its own setting.
 */
export function stableAudioPrompt({ descriptors = [], bpm = null } = {}) {
  const terms = (facet) => descriptors.filter((descriptor) => descriptor.facet === facet).map((descriptor) => descriptor.term);
  const tags = ["TrackType: Music", "VocalType: Instrumental", ...terms("genre").map((genre) => `Genre: ${capitalized(genre)}`)];
  const instruments = terms("instrument");
  if (instruments.length) tags.push(`Instruments: ${instruments.map(capitalized).join(", ")}`);
  const sound = [...terms("texture"), ...terms("rhythm"), ...terms("mood")];
  return [tags.join(", "), sound.length ? sentence(sound.join(", ")) : null, Number.isInteger(bpm) ? `${bpm} BPM` : null]
    .filter(Boolean).join(". ").concat(".");
}

/**
 * The one generator a room shares. status() is cached so the agent can ask on every tool call;
 * check() reads the settings and the install again. One track is made at a time.
 */
export function createLocalGenerator({
  environment = process.env,
  platform = process.platform,
  arch = process.arch,
  spawnImpl = spawn,
  now = () => new Date(),
} = {}) {
  let current = { state: "unknown", enabled: false, install: "unknown", path: null, source: null };
  let running = null;
  let checking = null;
  const listeners = new Set();
  const tracksDirectory = () => resolveGeneratedTracksDirectory(environment);

  const publish = (next) => {
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    current = next;
    if (changed) for (const listener of listeners) {
      try { listener(structuredClone(current)); } catch { /* A surface's redraw cannot undo the check. */ }
    }
    return structuredClone(current);
  };

  const check = () => {
    checking ??= (async () => {
      try {
        const settings = await readGenerationSettings(environment);
        const install = await checkStableAudioInstall(settings.path, { platform, arch });
        return publish({
          state: !settings.enabled ? "off" : install.state,
          enabled: settings.enabled,
          install: install.state,
          ...(install.missing ? { missing: install.missing } : {}),
          path: settings.path,
          source: settings.source,
        });
      } finally {
        checking = null;
      }
    })();
    return checking;
  };

  // Folders a crashed run left behind. The terminal and the window each make tracks here, so a
  // folder whose process still runs is that surface's track in the making and stays.
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  };
  const sweep = async () => {
    const folder = tracksDirectory();
    let names = [];
    try { names = await readdir(folder); } catch { return; }
    await Promise.all(names.map((name) => [name, Number(/^\.[0-9a-f-]{36}\.tmp-(\d+)-/u.exec(name)?.[1])])
      .filter(([, pid]) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && !alive(pid))
      .map(([name]) => rm(path.join(folder, name), { recursive: true, force: true })));
  };

  const run = ({ root, prompt, seconds, seed, out }, { signal, onProgress }) => new Promise((resolve, reject) => {
    // The Python script itself, not Stability's ./sa3 wrapper: the wrapper wants uv on PATH and a
    // terminal, and its exec would leave a shell between this process and the one to stop.
    const child = spawnImpl(path.join(root, ".venv", "bin", "python"), [
      "scripts/sa3_mlx.py", "--prompt", prompt, "--dit", "medium", "--decoder", "same-l",
      "--seconds", String(seconds), "--seed", String(seed), "--steps", "8", "--out", out,
    ], {
      cwd: root,
      // Every choice is passed, so the script never waits on stdin for a missing one.
      stdio: ["ignore", "pipe", "pipe"],
      // Unbuffered, so stage lines arrive as they happen; offline, so missing weights fail instead of downloading.
      env: { ...environment, PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: "1" },
    });
    let output = "";
    let measured = null;
    let settled = false;
    let stopping = null;
    // Why a run was stopped, reported once its process has really exited, so the slot stays taken until then.
    let stopReason = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolve(value);
    };
    const kill = (reason) => {
      if (settled || stopReason) return;
      stopReason = reason;
      clearTimeout(timer);
      child.kill("SIGTERM");
      // The script handles only Ctrl-C, so a run that ignores the request is ended.
      stopping = setTimeout(() => child.kill("SIGKILL"), stoppingGraceMs);
    };
    const stop = () => kill(Object.assign(new Error("Making the track was stopped."), { name: "AbortError", code: "generation_stopped" }));
    const timer = setTimeout(() => kill(generationError("generation_timed_out", "Stable Audio 3 took too long, so the track was stopped.")), generationTimeoutMs);
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lines = output.split("\n");
      output = lines.pop();
      for (const line of lines) {
        const stage = /\[(\d)\/5\]/u.exec(line)?.[1];
        if (stage && STAGES.has(stage)) onProgress?.({ stage: STAGES.get(stage) });
        const done = doneLine.exec(line);
        if (done) {
          const peak = Number(done[3]) * (done[4] === "GB" ? 1024 : 1);
          measured = { wall_seconds: Number(done[1]), audio_seconds: Number(done[2]), peak_memory_mb: Math.round(peak) };
        }
      }
    });
    // Its errors can carry the output path and tracebacks; only the exit code is reported.
    child.stderr.resume();
    child.once("error", () => finish(stopReason ?? generationError("generation_failed", "Stable Audio 3 could not be started.")));
    child.once("exit", (code) => {
      clearTimeout(stopping);
      if (stopReason) finish(stopReason);
      else if (code === 0) finish(null, measured);
      else finish(generationError("generation_failed", "Stable Audio 3 stopped without making the track."));
    });
  });

  return {
    status: () => structuredClone(current),
    ready: () => current.state === "ready",
    busy: () => running !== null,
    check,
    async save(settings) {
      await writeGenerationSettings(settings, environment);
      return check();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // The terminal and the window each run a generator on one settings file. A change saved on one
    // side is checked again on the other; listeners hear it through subscribe.
    watch({ interval = 2000 } = {}) {
      const file = resolveGenerationSettingsFile(environment);
      const listener = () => { void check().catch(() => {}); };
      watchFile(file, { interval, persistent: false }, listener);
      return () => unwatchFile(file, listener);
    },
    sweep,
    /** The WAV of one generated track, or null when there is none. */
    async trackFile(id) {
      if (!isGeneratedTrackId(id)) return null;
      const file = path.join(tracksDirectory(), id, "track.wav");
      return (await isFile(file, { minimumBytes: 45 })) ? file : null;
    },
    async receipt(id) {
      if (!isGeneratedTrackId(id)) return null;
      try {
        return JSON.parse(await readFile(path.join(tracksDirectory(), id, "receipt.json"), "utf8"));
      } catch {
        return null;
      }
    },
    /**
     * Makes one track and keeps it with its receipt. receipt holds what the host knows about why
     * the track sounds as it does; the generator adds what it ran and what it wrote.
     * Returns { id, title, seconds, seed, prompt, elapsed_ms, measured }.
     */
    async generate({ prompt, seconds = GENERATION_SECONDS.default, seed = randomInt(0, 2 ** 31 - 1), title, receipt = {} }, { signal, onProgress } = {}) {
      if (running) throw generationError("generation_busy", "Moondog is already making a track. Wait for it to finish.");
      if (!Number.isInteger(seconds) || seconds < GENERATION_SECONDS.min || seconds > GENERATION_SECONDS.max) {
        throw generationError("generation_seconds_invalid", `A track can be ${GENERATION_SECONDS.min} to ${GENERATION_SECONDS.max} seconds long.`);
      }
      if (typeof prompt !== "string" || !prompt.trim()) throw generationError("generation_prompt_empty", "Nothing was made: the prompt is empty.");
      // The slot is taken before anything waits, so two requests at once never both run.
      const id = randomUUID();
      running = { id };
      const folder = tracksDirectory();
      const temporary = path.join(folder, `.${id}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
      const started = Date.now();
      try {
        const status = await check();
        if (status.state !== "ready") throw generationError("generation_not_ready", "Local generation is not ready. The listener can turn it on in Settings or with /generation.");
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await chmod(folder, 0o700);
        await mkdir(temporary, { mode: 0o700 });
        const wav = path.join(temporary, "track.wav");
        onProgress?.({ stage: "starting" });
        const measured = await run({ root: status.path, prompt, seconds, seed, out: wav }, { signal, onProgress });
        const audio = await wavInfo(wav).catch(() => null);
        if (!audio || audio.duration_seconds <= 0) throw generationError("generation_failed", "Stable Audio 3 finished but wrote no playable track.");
        await chmod(wav, 0o600);
        const elapsed = Date.now() - started;
        const document = {
          receipt_version: "moondog-generated-track/1",
          generated_track_id: id,
          moondog_id: `moondog:generated:${id}`,
          created_at: now().toISOString(),
          title,
          ...receipt,
          generator: {
            adapter: "stable-audio-3", adapter_version: 1, model: "sa3-medium-ARC", decoder: "same-l",
            prompt, seconds, seed, steps: 8, cfg: 1, elapsed_ms: elapsed, ...(measured ? { measured } : {}),
            license: "Stability AI Community License; outputs belong to the listener",
          },
          audio: { file: "track.wav", ...audio },
        };
        await writeFile(path.join(temporary, "receipt.json"), `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, path.join(folder, id));
        return { id, title, seconds, seed, prompt, elapsed_ms: elapsed, duration_seconds: audio.duration_seconds, ...(measured ? { measured } : {}) };
      } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
        throw error;
      } finally {
        running = null;
      }
    },
  };
}
