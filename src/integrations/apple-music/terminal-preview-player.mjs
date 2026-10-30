// Plays the agent's Apple Music previews from the terminal. Each 30-second preview is
// downloaded to a temporary file and played by the system's own player, one after another.
// A track Moondog made on this Mac plays the same way, from its own folder.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { access, constants, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Players that play one file without a window and exit at its end, in order of preference.
// None of them may read or write the terminal: the listening room owns it.
const systemPlayers = {
  darwin: [{ command: "afplay", args: [] }],
  linux: [
    { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet"] },
    { command: "mpv", args: ["--no-video", "--no-terminal"] },
  ],
};
const longestQueue = 30;
const largestPreview = 10 * 1024 * 1024;
// Some routes to Apple's audio host take over 20 seconds for one preview.
const downloadTimeoutMs = 60_000;

// The same addresses the website's player accepts.
const https = (value, allowed) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowed(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
};
const previewHost = (host) => host === "audio-ssl.itunes.apple.com";
const linkHost = (host) => host === "music.apple.com";

/** The first system player on PATH that can play a preview, or null. */
export async function findSystemPlayer({ platform = process.platform, environment = process.env } = {}) {
  const folders = String(environment.PATH ?? "").split(path.delimiter).filter((folder) => path.isAbsolute(folder));
  for (const { command, args } of systemPlayers[platform] ?? []) {
    for (const folder of folders) {
      const file = path.join(folder, command);
      try {
        if (!(await stat(file)).isFile()) continue;
        await access(file, constants.X_OK);
        return { command: file, args };
      } catch {}
    }
  }
  return null;
}

/**
 * The listening room's preview player, or null when this system has no player.
 * play(tracks, { album }) replaces the queue. subscribe(listener) reports a new queue,
 * a song still loading, a song that could not load, each song as it starts, and the
 * end of playback.
 */
export async function createTerminalPreviewPlayer({
  platform,
  environment,
  fetchImpl = globalThis.fetch,
  temporaryRoot = tmpdir(),
} = {}) {
  const player = await findSystemPlayer({ platform, environment });
  if (!player) return null;
  const listeners = new Set();
  let folder = null;
  let files = 0;
  let queue = null;
  let child = null;
  let closed = false;

  const emit = (event) => {
    for (const listener of listeners) {
      try { listener(event); } catch {}
    }
  };
  const removeFolder = () => {
    if (folder) rmSync(folder, { recursive: true, force: true });
    folder = null;
  };
  // A process that ends without closing the player still stops the sound and leaves no files.
  const onExit = () => {
    child?.kill();
    removeFolder();
  };
  process.once("exit", onExit);

  const download = async (url, signal) => {
    signal.throwIfAborted();
    folder ??= mkdtempSync(path.join(temporaryRoot, "moondog-previews-"));
    const file = path.join(folder, `${(files += 1)}.m4a`);
    const response = await fetchImpl(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(downloadTimeoutMs)]) });
    if (!response.ok || !response.body) throw new Error(`Apple Music answered ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      if ((size += chunk.byteLength) > largestPreview) throw new Error("The preview is too large");
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    await writeFile(file, Buffer.concat(chunks));
    return file;
  };

  // Resolves "ended" when the song played to its end, "stopped" when /skip or /stop ended it, and
  // "failed" when the player could not play it (no audio device, an unreadable file).
  const playFile = (file) => new Promise((resolve) => {
    const playing = spawn(player.command, [...player.args, file], { stdio: "ignore" });
    child = playing;
    const finish = (how) => {
      if (child === playing) child = null;
      resolve(how);
    };
    playing.once("error", () => finish("failed"));
    playing.once("exit", (code, signal) => finish(code === 0 ? "ended" : signal ? "stopped" : "failed"));
  });

  const start = (tracks) => {
    const controller = new AbortController();
    const downloads = new Map();
    // skip() ends the song playing, or the download of the song about to play.
    const current = { controller, skipDownload: null };
    queue = current;
    const fetchFile = (index) => {
      if (!downloads.has(index)) {
        const own = new AbortController();
        const pending = { ready: false, abort: () => own.abort(), skipped: () => own.signal.aborted };
        pending.file = download(tracks[index].preview, AbortSignal.any([controller.signal, own.signal]))
          .catch(() => null)
          .then((file) => { pending.ready = true; return file; });
        downloads.set(index, pending);
      }
      return downloads.get(index);
    };
    void (async () => {
      try {
        for (let index = 0; index < tracks.length; index += 1) {
          const { title, artist_credit, catalog_url, generated, id } = tracks[index];
          const song = { track: generated ? { title, artist_credit, generated: true, id } : { title, artist_credit, catalog_url }, position: index + 1, count: tracks.length };
          // A track Moondog made plays from its own folder, which outlives the queue.
          const pending = tracks[index].file
            ? { ready: true, file: Promise.resolve(tracks[index].file), abort: () => {}, skipped: () => false }
            : fetchFile(index);
          if (!pending.ready) emit({ type: "loading", ...song });
          current.skipDownload = pending.abort;
          const file = await pending.file;
          current.skipDownload = null;
          if (controller.signal.aborted) break;
          // The next preview downloads while this one plays.
          if (index + 1 < tracks.length && !tracks[index + 1].file) void fetchFile(index + 1);
          if (!file) {
            // An error, a timeout, or an oversized file; a listener's /skip is not a failure.
            if (!pending.skipped()) emit({ type: "failed", ...song });
            continue;
          }
          emit({ type: "playing", ...song });
          const how = await playFile(file);
          // A made track that played to its end, or that could not play, as the loop back from listening counts it.
          if (generated && !controller.signal.aborted && how !== "stopped") emit({ type: how === "ended" ? "finished" : "failed", ...song });
          if (!tracks[index].file) await rm(file, { force: true });
          if (controller.signal.aborted) break;
        }
      } finally {
        await Promise.all([...downloads.values()].map(async (pending) => {
          const file = await pending.file;
          if (file) await rm(file, { force: true });
        }));
        if (queue === current) {
          queue = null;
          emit({ type: "stopped" });
        }
      }
    })();
  };

  const stop = () => {
    if (!queue) return false;
    queue.controller.abort();
    queue = null;
    child?.kill();
    child = null;
    emit({ type: "stopped" });
    return true;
  };

  return {
    // A new set of previews replaces the queue and starts from its first song.
    play(tracks, { album } = {}) {
      if (closed) return;
      const accepted = (Array.isArray(tracks) ? tracks : []).map((track) => ({
        title: String(track?.title ?? "").trim(),
        artist_credit: String(track?.artist_credit ?? "").trim(),
        catalog_url: https(track?.catalog_url, linkHost),
        preview: https(track?.preview_url, previewHost),
      })).filter((track) => track.title && track.catalog_url && track.preview).slice(0, longestQueue);
      if (!accepted.length) return;
      stop();
      emit({
        type: "queue",
        tracks: accepted.map(({ title, artist_credit, catalog_url }) => ({ title, artist_credit, catalog_url })),
        album: album?.title
          ? { title: String(album.title), artist_credit: String(album.artist_credit ?? ""), catalog_url: https(album.catalog_url, linkHost) }
          : null,
      });
      start(accepted);
    },
    // A track Moondog made on this Mac: { id, title, file }, played whole and kept after it ends.
    playGenerated({ id, title, file } = {}) {
      const name = String(title ?? "").trim();
      if (closed || !name || typeof file !== "string" || !path.isAbsolute(file)) return;
      stop();
      const track = { title: name, artist_credit: "", generated: true, id: String(id ?? "") };
      emit({ type: "queue", tracks: [{ title: track.title, artist_credit: "", generated: true }], album: null });
      start([{ ...track, file }]);
    },
    // Ends the song now playing, or still loading; the next one starts after it.
    skip() {
      if (!queue) return false;
      if (child) child.kill();
      else queue.skipDownload?.();
      return true;
    },
    stop,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      stop();
      listeners.clear();
      process.removeListener("exit", onExit);
      removeFolder();
    },
  };
}
