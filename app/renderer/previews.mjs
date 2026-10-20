// The 30-second Apple Music previews the agent plays when Spotify isn't there. Audio lives in
// the window; every change goes back to the core, which reports it as the terminal's player would.
const allowed = (value, host) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (typeof host === "string" ? url.hostname === host : host(url.hostname)) ? url.href : null;
  } catch { return null; }
};
// Apple's image host serves any size; the cover is drawn at 288 points.
const artwork = (url) => {
  const safe = allowed(url, (host) => host.endsWith(".mzstatic.com"));
  return safe ? safe.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/u, "/600x600bb.$1") : null;
};

export function createPreviews({ send, onChange }) {
  const audio = new Audio();
  audio.preload = "auto";
  const session = "mediaSession" in navigator ? navigator.mediaSession : null;
  let queue = [];
  let index = 0;
  let id = null;
  let failures = 0;

  const current = () => queue[index] ?? null;
  const report = (type) => {
    const track = current();
    if (id === null || !track) return;
    send({ type: "preview-event", id, event: { type, track: { title: track.title, artist_credit: track.artist_credit, catalog_url: track.catalog_url },
      position: index + 1, count: queue.length } });
  };
  const describe = () => {
    const track = current();
    if (session && track) {
      session.metadata = new MediaMetadata({ title: track.title, artist: track.artist_credit,
        artwork: track.image ? [{ src: track.image, sizes: "600x600", type: "image/jpeg" }] : [] });
      session.playbackState = audio.paused ? "paused" : "playing";
    }
    onChange();
  };
  const load = (position) => {
    index = Math.max(0, Math.min(queue.length - 1, position));
    audio.src = current().preview_url;
    report("loading");
    void audio.play().catch(() => {});
    describe();
  };
  const stop = (notify = true) => {
    if (!queue.length) return;
    if (notify) report("stopped");
    queue = [];
    id = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (session) { session.metadata = null; session.playbackState = "none"; }
    onChange();
  };

  audio.addEventListener("playing", () => { failures = 0; report("playing"); describe(); });
  audio.addEventListener("pause", () => { if (!audio.ended && queue.length) { report("paused"); describe(); } });
  audio.addEventListener("timeupdate", onChange);
  audio.addEventListener("ended", () => (index + 1 < queue.length ? load(index + 1) : stop()));
  audio.addEventListener("error", () => {
    if (!queue.length) return;
    report("failed");
    // A preview that won't load is skipped; three in a row end the queue.
    if (++failures < 3 && index + 1 < queue.length) load(index + 1);
    else stop();
  });
  if (session) {
    session.setActionHandler("play", () => api.toggle());
    session.setActionHandler("pause", () => api.toggle());
    session.setActionHandler("nexttrack", () => api.next());
    session.setActionHandler("previoustrack", () => api.previous());
  }

  const api = {
    receive(message) {
      if (message.type === "preview") {
        const tracks = (Array.isArray(message.tracks) ? message.tracks : []).map((track) => ({
          title: String(track.title ?? ""), artist_credit: String(track.artist_credit ?? ""),
          preview_url: allowed(track.preview_url, "audio-ssl.itunes.apple.com"), catalog_url: allowed(track.catalog_url, "music.apple.com"),
          image: artwork(track.artwork_url ?? message.album?.artwork_url),
        })).filter((track) => track.title && track.preview_url);
        if (!tracks.length) return;
        if (queue.length) stop();
        queue = tracks;
        id = message.id;
        report("queue");
        load(0);
      }
      if (message.type === "preview-control" && message.id === id) {
        if (message.action === "skip") api.next();
        if (message.action === "stop") stop(false);
      }
    },
    active: () => queue.length > 0,
    toggle() {
      if (!queue.length) return;
      if (audio.paused) void audio.play().catch(() => {});
      else audio.pause();
    },
    next() { if (queue.length) (index + 1 < queue.length ? load(index + 1) : stop()); },
    previous() { if (queue.length) (audio.currentTime > 3 || index === 0 ? (audio.currentTime = 0) : load(index - 1)); },
    state() {
      const track = current();
      if (!track) return null;
      return { title: track.title, artists: track.artist_credit ? [track.artist_credit] : [], image: track.image, link: track.catalog_url,
        playing: !audio.paused, progressMs: Math.round((audio.currentTime || 0) * 1000),
        durationMs: Math.round((Number.isFinite(audio.duration) ? audio.duration : 30) * 1000),
        next: queue.slice(index + 1, index + 9).map((item) => ({ title: item.title, artists: [item.artist_credit], image: item.image })) };
    },
  };
  return api;
}
