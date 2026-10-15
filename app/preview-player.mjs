// The room uses the same player interface in a terminal and in the desktop app.
// Audio stays in the window; its events come back so the room can show and control it.
export function createWindowPreviewPlayer(port) {
  const listeners = new Set();
  let sequence = 0;
  let queueId = null;
  let active = false;
  let closed = false;
  const https = (value, host) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === host ? url.href : null;
    } catch { return null; }
  };
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  const receive = ({ data }) => {
    if (closed || queueId === null || data?.type !== "preview-event" || data.id !== queueId) return;
    const event = data.event;
    if (!["queue", "loading", "playing", "paused", "failed", "stopped"].includes(event?.type)) return;
    if (event.type === "stopped") active = false;
    else if (event.type !== "failed") active = true;
    emit(event);
  };
  port.on("message", receive);

  const stop = () => {
    if (!active || closed) return false;
    port.postMessage({ type: "preview-control", action: "stop", id: queueId });
    // Ignore events already in transit from the queue that was just stopped.
    queueId = null;
    active = false;
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
      port.postMessage({
        type: "preview", id: queueId, tracks: accepted,
        album: album?.title ? {
          title: String(album.title), artist_credit: String(album.artist_credit ?? ""),
          catalog_url: https(album.catalog_url, "music.apple.com"), artwork_url: album.artwork_url,
        } : null,
      });
    },
    skip() {
      if (!active || closed) return false;
      port.postMessage({ type: "preview-control", action: "skip", id: queueId });
      return true;
    },
    stop,
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
