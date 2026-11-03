// The room uses the same player interface in a terminal and in the desktop app.
// Audio stays in the window; its events come back so the room can show and control it.
import { createPlayerNow } from "../src/core/listening-now.mjs";

const generatedTrackId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function createWindowPreviewPlayer(port) {
  const listeners = new Set();
  let sequence = 0;
  let queueId = null;
  let active = false;
  // Whether the queue sent last holds Apple Music songs, rather than only tracks Moondog made.
  let catalog = false;
  let closed = false;
  // What it plays, for the agent: the queue sent last, moved along by the window's events.
  const now = createPlayerNow();
  const https = (value, host) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === host ? url.href : null;
    } catch { return null; }
  };
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  // Whether the window plays whole songs through MusicKit, as its last check found; until then, previews.
  let wholeSongs = false;
  const receive = ({ data }) => {
    if (data?.type === "whole-songs") { wholeSongs = data.canPlay === true; return; }
    if (closed || queueId === null || data?.type !== "preview-event" || data.id !== queueId) return;
    const event = data.event;
    if (!["queue", "loading", "playing", "paused", "finished", "skipped", "failed", "stopped"].includes(event?.type)) return;
    if (event.type === "stopped") active = false;
    else if (event.type !== "failed") active = true;
    now.observe(event);
    emit(event);
  };
  port.on("message", receive);

  const stop = () => {
    if (!active || closed) return false;
    port.postMessage({ type: "preview-control", action: "stop", id: queueId });
    // Ignore events already in transit from the queue that was just stopped.
    queueId = null;
    active = false;
    now.clear();
    emit({ type: "stopped" });
    return true;
  };

  return {
    play(tracks, { album } = {}) {
      if (closed) return;
      const accepted = (Array.isArray(tracks) ? tracks : []).map((track) => ({
        title: String(track?.title ?? "").trim(),
        artist_credit: String(track?.artist_credit ?? "").trim(),
        preview_url: https(track?.preview_url, "audio-ssl.itunes.apple.com"),
        catalog_url: https(track?.catalog_url, "music.apple.com"),
        artwork_url: track?.artwork_url,
      })).filter((track) => track.title && track.preview_url && track.catalog_url).slice(0, 30);
      if (!accepted.length) return;
      queueId = ++sequence;
      active = true;
      catalog = true;
      now.queued(accepted);
      port.postMessage({
        type: "preview", id: queueId, tracks: accepted,
        album: album?.title ? {
          title: String(album.title), artist_credit: String(album.artist_credit ?? ""),
          catalog_url: https(album.catalog_url, "music.apple.com"), artwork_url: album.artwork_url,
        } : null,
      });
    },
    // A playlist from the listener's library: Apple Music songs and tracks Moondog made, in one queue. The
    // window plays whole songs through MusicKit and the made tracks itself, one after another.
    playList(tracks) {
      if (closed) return;
      const accepted = (Array.isArray(tracks) ? tracks : []).map((track) => {
        if (track?.generated === true) {
          const id = String(track.id ?? "");
          const name = String(track.title ?? "").trim();
          return generatedTrackId.test(id) && name ? { title: name, artist_credit: "", generated: true, id, media_url: `moondog-media://generated/${id}`,
            ...(Number.isFinite(track.seconds) && track.seconds > 0 ? { duration_seconds: track.seconds } : {}) } : null;
        }
        const song = { title: String(track?.title ?? "").trim(), artist_credit: String(track?.artist_credit ?? "").trim(),
          preview_url: https(track?.preview_url, "audio-ssl.itunes.apple.com"), catalog_url: https(track?.catalog_url, "music.apple.com"), artwork_url: track?.artwork_url };
        return song.title && song.preview_url && song.catalog_url ? song : null;
      }).filter(Boolean).slice(0, 50);
      if (!accepted.length) return;
      queueId = ++sequence;
      active = true;
      catalog = accepted.some((track) => !track.generated);
      now.queued(accepted);
      port.postMessage({ type: "preview", id: queueId, tracks: accepted.map(({ id: _id, ...track }) => track), album: null });
    },
    // A track Moondog made on this Mac. The window asks main for it by id through moondog-media:,
    // so its path never reaches the page.
    playGenerated({ id, title, seconds } = {}) {
      const name = String(title ?? "").trim();
      if (closed || !name || !generatedTrackId.test(String(id ?? ""))) return;
      queueId = ++sequence;
      active = true;
      catalog = false;
      now.queued([{ title: name, generated: true, id }]);
      port.postMessage({
        type: "preview", id: queueId,
        tracks: [{ title: name, artist_credit: "", generated: true, media_url: `moondog-media://generated/${id}`,
          ...(Number.isFinite(seconds) && seconds > 0 ? { duration_seconds: seconds } : {}) }],
        album: null,
      });
    },
    // A made track queued behind the one playing, as Moondog's stream does; with nothing playing, it plays now.
    enqueueGenerated({ id, title, seconds } = {}) {
      const name = String(title ?? "").trim();
      if (closed || !name || !generatedTrackId.test(String(id ?? ""))) return;
      if (!active || queueId === null) return this.playGenerated({ id, title, seconds });
      now.appended({ title: name, generated: true, id });
      port.postMessage({
        type: "preview-enqueue", id: queueId,
        track: { title: name, artist_credit: "", generated: true, media_url: `moondog-media://generated/${id}`,
          ...(Number.isFinite(seconds) && seconds > 0 ? { duration_seconds: seconds } : {}) },
      });
    },
    skip() {
      if (!active || closed) return false;
      port.postMessage({ type: "preview-control", action: "skip", id: queueId });
      return true;
    },
    stop,
    // What plays now, as createPlayerNow reads it: null, or { state, song, position, count, next }.
    nowPlaying: () => (closed ? null : now.read()),
    // Leaving Apple Music stops its songs here, never the tracks Moondog made.
    holdsCatalogSongs: () => active && catalog,
    wholeSongs: () => wholeSongs,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      stop();
      closed = true;
      listeners.clear();
      port.removeListener("message", receive);
    },
  };
}
