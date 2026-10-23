import { randomUUID } from "node:crypto";

const failure = (code, message) => Object.assign(new Error(message), { code });
const playerSong = (track) => ({ ...track, duration_ms: track.durationMs ?? track.duration_ms ?? 0, playable: track.available !== false });

/** Core owns the queue; the renderer gets one expiring URL and reports actual audio events. */
export function createWindowNeteasePlayer({ library, port, startTimeoutMs = 15_000 }) {
  let status = { state: "unknown" };
  let queue = [];
  let index = -1;
  let token = null;
  let version = 0;
  let resolving = null;
  let pending = null;
  let positionMs = 0;
  let state = "stopped";
  let trial = false;
  let closed = false;
  const known = new Map();
  const listeners = new Set();
  const emit = (error = null) => { for (const listener of listeners) listener(error); };
  const send = (action, extra = {}) => port.postMessage({ type: "netease-audio", action, token, ...extra });
  function invalidate() {
    version += 1;
    resolving?.abort();
    if (pending) { clearTimeout(pending.timer); pending.reject(failure("netease_cancelled", "Playback was replaced or cancelled.")); pending = null; }
  }
  async function start(at, { skipUnavailable = false } = {}) {
    invalidate();
    const current = version;
    resolving = new AbortController();
    state = "loading";
    send("stop");
    token = null;
    let lastError;
    for (let offset = at; offset < queue.length && offset < at + (skipUnavailable ? 10 : 1); offset += 1) {
      try {
        if (!queue[offset].playable) throw failure("netease_unplayable", "This track is unavailable.");
        const source = await library.playback(queue[offset].id, { signal: resolving.signal });
        if (current !== version || closed) throw failure("netease_cancelled", "Playback was cancelled.");
        index = offset;
        positionMs = 0;
        trial = source.trial;
        token = randomUUID();
        const started = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending = null; state = "stopped"; send("stop");
            reject(failure("netease_audio_failed", "音频加载超时，请重试。 / Audio did not start. Retry playback."));
          }, startTimeoutMs);
          pending = { resolve, reject, timer };
        });
        send("play", { url: source.url, track: queue[index], trial });
        await started;
        return;
      } catch (error) {
        if (current !== version || closed || !["netease_unplayable", "netease_audio_failed"].includes(error.code)) {
          if (current === version) state = "stopped";
          throw error;
        }
        lastError = error;
      }
    }
    state = "stopped";
    emit(lastError);
    throw lastError ?? failure("netease_unplayable", "歌单中暂时没有可播放的歌曲。 / No playable songs in this playlist.");
  }
  const receive = ({ data }) => {
    if (closed || data?.type !== "netease-audio-event" || !token || data.token !== token) return;
    if (Number.isFinite(data.positionMs)) positionMs = Math.max(0, data.positionMs);
    if (Number.isFinite(data.durationMs) && queue[index]) queue[index].duration_ms = Math.max(0, data.durationMs);
    if (["playing", "paused"].includes(data.state)) state = data.state;
    if (data.state === "playing" && pending) { clearTimeout(pending.timer); pending.resolve(); pending = null; }
    if (data.state === "failed") {
      state = "stopped";
      const error = failure("netease_audio_failed", "音频暂时无法加载，请重试或播放其他歌曲。 / Audio could not load. Retry or choose another song.");
      if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; } else emit(error);
    }
    if (data.state === "ended") {
      if (index + 1 < queue.length) void start(index + 1, { skipUnavailable: true }).catch(emit);
      else { state = "stopped"; token = null; queue = []; index = -1; }
    }
    emit();
  };
  port.on("message", receive);
  const player = {
    status: () => ({ ...status, backend: "builtin" }), ready: () => status.state === "ready",
    async check() { const result = await library.status(); status = { state: result.state === "connected" ? "ready" : "signed_out" }; return player.status(); },
    async playPlaylist(id, { trackId } = {}) {
      invalidate();
      send("stop"); token = null; state = "stopped"; queue = []; index = -1; emit();
      const current = version;
      resolving = new AbortController();
      const playlist = await library.playlist(id, { signal: resolving.signal });
      if (current !== version || closed) throw failure("netease_cancelled", "Playback was cancelled.");
      const nextQueue = playlist.tracks.map(playerSong);
      const startAt = trackId ? nextQueue.findIndex((track) => track.id === trackId) : 0;
      if (startAt < 0 || !nextQueue.length) throw failure("netease_unplayable", "这首歌不在当前歌单中，或歌单为空。 / This playlist is empty or the song is no longer in it.");
      queue = nextQueue;
      await start(startAt, { skipUnavailable: !trackId });
      return { mode: "playing", trial, playlistId: id };
    },
    async search(input) {
      const tracks = (await library.search(input)).map(playerSong);
      for (const track of tracks) known.set(track.id, track);
      while (known.size > 300) known.delete(known.keys().next().value);
      return tracks;
    },
    async play({ items = [], mode = "play" } = {}) {
      const songs = [];
      for (const item of items.slice(0, 20)) {
        const song = item.id ? known.get(String(item.id)) : (await player.search({ query: `${item.title ?? ""} ${item.artist ?? ""}`.trim() }))[0];
        if (song) songs.push(song);
      }
      if (!songs.length) throw failure("netease_unplayable", "No matching playable songs were found.");
      if (mode === "queue" && queue.length && state !== "stopped") { queue.push(...songs); emit(); return { mode: "queued", songs, unplayable: [], not_found: [] }; }
      queue = songs; await start(0, { skipUnavailable: true });
      return { mode: "playing", songs: [{ ...queue[index], trial }], trial, unplayable: [], not_found: [] };
    },
    async pause() { if (token) { send("pause"); state = "paused"; emit(); } },
    async resume() { if (token) { send("resume"); } },
    async seek({ positionMs: at }) { if (token && Number.isFinite(at)) { positionMs = Math.max(0, at); send("seek", { positionMs }); emit(); } },
    async next() { if (index + 1 < queue.length) await start(index + 1, { skipUnavailable: true }); else await player.stop(); },
    async previous() { if (positionMs > 3000 || index <= 0) await player.seek({ positionMs: 0 }); else await start(index - 1); },
    async stop() { invalidate(); send("stop"); token = null; queue = []; index = -1; state = "stopped"; emit(); },
    async nowPlaying() { return { state: state === "loading" ? "paused" : state, song: state !== "stopped" && index >= 0 ? { ...queue[index], trial } : null,
      position_ms: positionMs, next: queue.slice(index + 1) }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { void player.stop(); closed = true; port.removeListener("message", receive); listeners.clear(); },
  };
  return player;
}
