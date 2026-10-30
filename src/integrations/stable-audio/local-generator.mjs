// Makes music on this Mac with a local Stable Audio 3 install (Stability AI's optimized MLX
// build). The listener turns it on once, in Settings or with /generation; until then nothing
// runs. Each track is a WAV and a receipt in Moondog's state directory, and nothing leaves the
// machine: weights are never downloaded here, and the receipt keeps no absolute path.
import { spawn } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { access, appendFile, chmod, constants, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { resolveMoondogStateDirectory } from "../../core/state-directory.mjs";
import { streamVariation } from "../../profile/taste-compiler.mjs";
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

// A made track the listener left within this many seconds was skipped; later, stopped.
const SKIP_SECONDS = 30;
const OUTCOMES = Object.freeze(["completed", "skipped", "stopped", "replayed"]);

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
  // The tracks made here, newest last, with what happened each time they played: the loop back
  // from listening reads them. Each track's outcomes.jsonl keeps them; the receipt never changes.
  const made = new Map();
  // The made track playing now in this room's player: { id, heardMs, since }, since null while paused.
  let playing = null;
  // Outcome writes still on their way, which a closing room waits for.
  const writing = new Set();
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

  const stopped = () => Object.assign(new Error("Making the track was stopped."), { name: "AbortError", code: "generation_stopped" });
  const run = ({ root, prompt, seconds, seed, out }, { signal, onProgress }) => new Promise((resolve, reject) => {
    // A stop that came while the install was checked starts nothing.
    if (signal?.aborted) return reject(stopped());
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
    const stop = () => kill(stopped());
    const timer = setTimeout(() => kill(generationError("generation_timed_out", "Stable Audio 3 took too long, so the track was stopped.")), generationTimeoutMs);
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

  const remember = (receipt, outcomes = [], audioKept = true) => {
    if (!isGeneratedTrackId(receipt?.generated_track_id)) return;
    made.set(receipt.generated_track_id, {
      id: receipt.generated_track_id,
      title: String(receipt.title ?? ""),
      made_at: receipt.created_at,
      seconds: receipt.audio?.duration_seconds ?? receipt.generator?.seconds ?? null,
      sound: (Array.isArray(receipt.shaped_by) ? receipt.shaped_by : []).map((entry) => entry?.term).filter((term) => typeof term === "string").slice(0, 8),
      ...(receipt.stream ? { stream: true } : {}),
      // A stream keeps only its newest tracks' audio; the agent must not offer the rest again.
      ...(audioKept ? {} : { audio_kept: false }),
      outcomes,
    });
  };
  // Appends one outcome to the track's own file, so the terminal and the window add to one record.
  const recordOutcome = async (id, outcome) => {
    if (!isGeneratedTrackId(id) || !OUTCOMES.includes(outcome?.outcome)) return;
    const entry = { ...outcome, at: now().toISOString() };
    made.get(id)?.outcomes.push(entry);
    try {
      await appendFile(path.join(tracksDirectory(), id, "outcomes.jsonl"), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch { /* The track was removed; its outcome goes with it. */ }
  };
  const close = (finished) => {
    if (!playing) return;
    const heard = Math.round((playing.heardMs + (playing.since === null ? 0 : Date.now() - playing.since)) / 1000);
    const { id } = playing;
    playing = null;
    const write = recordOutcome(id, { outcome: finished ? "completed" : heard < SKIP_SECONDS ? "skipped" : "stopped", heard_seconds: heard });
    writing.add(write);
    void write.finally(() => writing.delete(write));
  };

  return {
    status: () => structuredClone(current),
    /**
     * Reads the tracks made here, with their outcomes, from their folders. The terminal and the
     * window each keep a generator on one folder, so each reply reads it again and sees the other's.
     */
    async load() {
      let names = [];
      try { names = await readdir(tracksDirectory()); } catch { names = []; }
      made.clear();
      for (const name of names.filter(isGeneratedTrackId)) {
        try {
          const receipt = JSON.parse(await readFile(path.join(tracksDirectory(), name, "receipt.json"), "utf8"));
          const outcomes = (await readFile(path.join(tracksDirectory(), name, "outcomes.jsonl"), "utf8").catch(() => ""))
            .split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
          const audioKept = await stat(path.join(tracksDirectory(), name, "track.wav")).then(() => true, () => false);
          remember(receipt, outcomes, audioKept);
        } catch { /* A folder without a readable receipt is not a track. */ }
      }
    },
    /**
     * The newest made tracks and how each landed, for the agent: what Moondog made, never the
     * listener's taste. Each outcome counts plays that ran to the end, were skipped within 30
     * seconds, were stopped later, or that the listener asked for again by name. Moondog's own
     * replays are counted apart, so its picks never read as the listener's.
     */
    recentTracks(limit = 5) {
      const listeners = (entry) => entry.outcome !== "replayed" || entry.by === "listener";
      return [...made.values()].sort((left, right) => String(right.made_at).localeCompare(String(left.made_at))).slice(0, limit)
        .map(({ outcomes, ...track }) => {
          const theirs = outcomes.filter(listeners);
          const counts = Object.fromEntries(OUTCOMES.map((kind) => [kind === "replayed" ? "asked_for_again" : kind, theirs.filter((entry) => entry.outcome === kind).length]));
          return { ...track, outcomes: { ...counts, replayed_by_moondog: outcomes.length - theirs.length },
            ...(theirs.length ? { last_outcome: theirs.at(-1).outcome === "replayed" ? "asked_for_again" : theirs.at(-1).outcome } : {}) };
        });
    },
    /** What a room's player reports. A made track that plays to its end was completed; one that stops or gives way was skipped or stopped. */
    observe(event) {
      const track = event?.track;
      if (event?.type === "playing" && track?.generated === true && isGeneratedTrackId(track.id)) {
        if (playing?.id !== track.id) {
          close(false);
          playing = { id: track.id, heardMs: 0, since: Date.now() };
        } else if (playing.since === null) playing.since = Date.now();
      } else if (event?.type === "paused" && playing && playing.since !== null) {
        playing.heardMs += Date.now() - playing.since;
        playing.since = null;
      } else if (event?.type === "finished" && playing && (!track?.id || track.id === playing.id)) {
        close(true);
      } else if (event?.type === "failed" && playing && (!track?.id || track.id === playing.id)) {
        // A track the player could not play says nothing about the listener.
        playing = null;
      } else if (event?.type === "stopped" || (event?.type === "queue" && !(event.tracks ?? []).some((entry) => entry?.id === playing?.id))) {
        close(false);
      }
    },
    /** Waits for the outcomes still being written, as a room does before it closes. */
    flush: () => Promise.allSettled([...writing]),
    // A replay of the track playing now starts it over; that is not a skip.
    // A stream keeps only its newest tracks' audio; the receipt and outcomes of the rest stay.
    async removeAudio(id) {
      if (!isGeneratedTrackId(id)) return;
      await rm(path.join(tracksDirectory(), id, "track.wav"), { force: true }).catch(() => {});
      const entry = made.get(id);
      if (entry) entry.audio_kept = false;
    },
    restart(id) {
      if (playing?.id === id) playing = null;
    },
    recordReplay(id, by) {
      this.restart(id);
      return recordOutcome(id, { outcome: "replayed", by: by === "listener" ? "listener" : "moondog" });
    },
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
        remember(document);
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

// Moondog's atmosphere stream (docs/MUSIC_DECENTRALIZATION.md): from one compiled taste, a track at a
// time, each made while the last one plays and queued behind it, so a skip moves straight on. Each
// track features a different few of the taste's sounds; one the listener skips within 30 seconds
// steers the stream away from what it featured, and a track played through counts for little in the
// background. Stopping the player, other music, or the time limit ends it. One stream per room, on
// the room's one generator; only its newest tracks keep their audio, and every receipt stays.
const STREAM_SKIP_MS = 30_000;
export function createAtmosphereStream({ generator, player, now = Date.now, keepAudio = 3 }) {
  let stream = null;
  const end = (reason) => {
    const ending = stream;
    if (!ending) return null;
    stream = null;
    ending.controller.abort();
    ending.ended = reason;
    return ending;
  };
  const trackFor = (ending, position) => {
    const variation = streamVariation(ending.compiled, position, ending.leaveOut);
    return { variation, prompt: stableAudioPrompt(variation), title: `${ending.title} · ${position + 1}`,
      receipt: { ...ending.receipt, shaped_by: variation.descriptors, ...(variation.bpm ? { bpm: variation.bpm } : {}),
        stream: { started_at: new Date(ending.startedAt).toISOString(), position: position + 1, featured: variation.featured } } };
  };
  // The tracks that started playing keep their audio, the newest few; the rest keep their receipts.
  const prune = (current) => {
    const played = current.made.filter((made) => made.started);
    for (const made of played.slice(0, Math.max(0, played.length - keepAudio))) {
      if (!made.pruned) { made.pruned = true; void generator.removeAudio?.(made.id); }
    }
  };
  // How long the track playing now was heard, pauses left out, as its outcome counts it.
  const heard = (playing) => playing.heardMs + (playing.since === null ? 0 : now() - playing.since);
  // Another track fits when it would end within the time limit, after what is left of the one playing now.
  const fits = (current) => {
    const playing = current.current;
    const left = playing && !playing.finished ? Math.max(0, (playing.seconds ?? current.seconds) * 1000 - heard(playing)) : 0;
    return now() + left + current.seconds * 1000 <= current.endsAt;
  };
  // The track playing now was left early: within 30 seconds, what it featured stays out from now on.
  const leftEarly = (current) => {
    const before = current.current;
    if (!before || before.finished || before.steered || heard(before) >= STREAM_SKIP_MS) return;
    before.steered = true;
    for (const term of current.made.find((made) => made.id === before.id)?.featured ?? []) current.leaveOut.add(term);
  };
  // Nothing is queued after the track that just ended: the next plays once made, or the stream ends.
  const ranDry = (current) => {
    if (current.making || fits(current)) {
      current.waiting = true;
      void makeNext();
    } else end("time");
  };
  const makeNext = async () => {
    const current = stream;
    if (!current || current.making || current.next || !fits(current)) return;
    current.making = true;
    try {
      const { prompt, title, receipt, variation } = trackFor(current, current.made.length);
      const made = await generator.generate({ prompt, seconds: current.seconds, title, receipt }, { signal: current.controller.signal });
      if (stream !== current) return;
      const file = await generator.trackFile(made.id);
      if (stream !== current) return;
      current.made.push({ id: made.id, featured: variation.featured, started: false, seconds: made.duration_seconds });
      current.next = made.id;
      const track = { id: made.id, title: made.title, seconds: made.duration_seconds, file };
      // A queue that ran dry while this was made starts again with it.
      if (current.waiting) { current.waiting = false; player.playGenerated(track); } else player.enqueueGenerated(track);
      current.onTrack?.(made);
    } catch (error) {
      // A run stopped with the stream is not a failure; anything else ends the stream.
      if (stream === current && error?.code !== "generation_stopped") end("failed");
    } finally {
      current.making = false;
    }
  };
  return {
    active: () => stream !== null,
    status() {
      if (!stream) return null;
      // Fixed times, so the agent's context changes only when the stream does.
      return { tracks_made: stream.made.length, started_at: new Date(stream.startedAt).toISOString(),
        ends_at: new Date(stream.endsAt).toISOString(), steering_away_from: [...stream.leaveOut] };
    },
    /**
     * Starts a stream from a compiled taste and plays its first track; the next is made at once.
     * beforePlay runs once the first track exists, so other music pauses only when there is one to
     * play. Returns the first track. A stream already running gives way to the new one.
     */
    async start({ compiled, title, seconds, minutes, receipt = {} }, { signal, onProgress, onTrack, beforePlay } = {}) {
      const previous = end("replaced");
      if (previous) player.stop?.();
      const current = { compiled, title, seconds, receipt, onTrack, startedAt: now(), endsAt: now() + minutes * 60_000,
        made: [], leaveOut: new Set(), current: null, next: null, waiting: false, making: true, controller: new AbortController() };
      stream = current;
      const stopped = () => Object.assign(new Error("The stream was stopped before it began."), { code: "generation_stopped" });
      try {
        const { prompt, title: first, receipt: firstReceipt, variation } = trackFor(current, 0);
        const made = await generator.generate({ prompt, seconds, title: first, receipt: firstReceipt },
          { signal: signal ? AbortSignal.any([signal, current.controller.signal]) : current.controller.signal, onProgress });
        const file = await generator.trackFile(made.id);
        // A stream replaced, or a reply stopped, while the first track was made plays nothing.
        if (stream !== current || signal?.aborted) throw stopped();
        await beforePlay?.();
        if (stream !== current || signal?.aborted) throw stopped();
        current.made.push({ id: made.id, featured: variation.featured, started: true, seconds: made.duration_seconds });
        current.current = { id: made.id, heardMs: 0, since: now(), finished: false, seconds: made.duration_seconds };
        current.making = false;
        // Whatever was playing stops for the first track; that stop is not the listener's.
        current.starting = true;
        try { player.playGenerated({ id: made.id, title: made.title, seconds: made.duration_seconds, file }); } finally { current.starting = false; }
        onTrack?.(made);
        void makeNext();
        return { made, prompt, variation };
      } catch (error) {
        if (stream === current) end("failed");
        throw error;
      }
    },
    stop(reason = "asked") {
      const ending = end(reason);
      if (ending) player.stop?.();
      return ending ? { tracks_made: ending.made.length } : null;
    },
    /** What the room's player reports, which moves the stream along or ends it. */
    observe(event) {
      const current = stream;
      // Until its first track plays, what the player reports is about the music before it.
      if (!current || !current.current) return;
      const track = event?.track;
      const ours = (id) => current.made.some((made) => made.id === id);
      // A queue or a song that is not one of the stream's tracks is other music, which ends the stream.
      if (event?.type === "queue" || event?.type === "playing") {
        const items = Array.isArray(event.tracks) ? event.tracks : track ? [track] : [];
        if (items.some((item) => !item?.generated || (item.id && !ours(item.id)))) { end("other_music"); return; }
      }
      const isCurrent = track?.id && track.id === current.current.id;
      if (event?.type === "playing" && track?.id && track.id === current.next) {
        leftEarly(current);
        const made = current.made.find((entry) => entry.id === track.id);
        current.current = { id: track.id, heardMs: 0, since: now(), finished: false, seconds: made?.seconds };
        if (made) made.started = true;
        current.next = null;
        current.waiting = false;
        prune(current);
        void makeNext();
      } else if (event?.type === "paused" && isCurrent && current.current.since !== null) {
        current.current.heardMs += now() - current.current.since;
        current.current.since = null;
      } else if (event?.type === "playing" && isCurrent && current.current.since === null) {
        current.current.since = now();
      } else if (event?.type === "skipped" && isCurrent) {
        // A skip past the end of the queue moves on to the next track once it is made.
        leftEarly(current);
        current.current.finished = true;
        if (!current.next) ranDry(current);
      } else if ((event?.type === "finished" || event?.type === "failed") && isCurrent) {
        // A track that could not play says nothing about the listener; it is passed over like one that ended.
        current.current.finished = true;
        if (!current.next) ranDry(current);
      } else if (event?.type === "stopped" && !current.waiting && !current.starting) {
        end("stopped");
      }
    },
  };
}
