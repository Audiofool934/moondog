// The Apple Music songs the agent plays when Spotify isn't there. Audio lives in the window; every
// change goes back to the core, which reports it as the terminal's player would. When the Apple Music
// helper can play the catalog (native/music.swift, through MusicKit), the same queue plays whole
// songs; until it can, or if it fails, the window plays 30-second previews as before.
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

// A catalog song's id is the i parameter of its music.apple.com link.
const catalogId = (url) => { try { return new URL(url).searchParams.get("i") || null; } catch { return null; } };

export function createPreviews({ send, onChange }) {
  const audio = new Audio();
  audio.preload = "auto";
  const session = "mediaSession" in navigator ? navigator.mediaSession : null;
  let queue = [];
  let index = 0;
  let id = null;
  let failures = 0;
  // "full" while the helper plays whole songs, "preview" while this window plays previews.
  let mode = "preview";
  const bridge = window.moondogApp?.appleMusic ?? null;
  const full = { status: null, state: null, observedAt: 0, started: false, reported: "" };

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
    if (mode === "full") void bridge?.({ type: "stop" });
    mode = "preview";
    full.state = null;
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
  // The helper reports its player; the core hears it as it hears previews. A report about another
  // queue (one stopped or replaced while it loaded) is not this one's.
  window.moondogApp?.onAppleMusic?.((message) => {
    if (mode !== "full" || !queue.length) return;
    if (message?.type === "exited") { stop(); return; }
    if (message?.type !== "state" || message.token !== String(id)) return;
    if (message.status === "ended") { stop(); return; }
    full.state = message;
    full.observedAt = Date.now();
    if (Number.isInteger(message.index)) index = Math.max(0, Math.min(queue.length - 1, message.index));
    const key = `${message.status}|${index}`;
    if (key !== full.reported) {
      full.reported = key;
      if (message.status === "playing") { full.started = true; report("playing"); }
      else if (message.status === "paused") report("paused");
      // Stopped after it started is the end of the queue.
      else if (message.status === "stopped" && full.started) { stop(); return; }
    }
    onChange();
  });
  const fullState = () => full.state?.song ?? null;
  const fullPlaying = () => full.state?.status === "playing";

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
        index = 0;
        report("queue");
        const ids = tracks.map((track) => catalogId(track.catalog_url));
        if (full.status?.canPlay && ids.every(Boolean)) {
          mode = "full";
          Object.assign(full, { state: null, started: false, reported: "" });
          report("loading");
          const queued = id;
          // A helper that can't play this queue stops whatever it began and hands the queue to the previews.
          void bridge({ type: "play", ids, start: 0, token: String(queued) }).then((answer) => {
            if (!answer?.error || id !== queued) return;
            void bridge({ type: "stop" });
            mode = "preview";
            load(0);
          });
          onChange();
        } else {
          mode = "preview";
          load(0);
          // A check that failed for a passing reason (the helper was slow, or went away) is asked again for the next queue.
          if (full.status?.error && full.status.error !== "unavailable") void api.check();
        }
      }
      if (message.type === "preview-control" && message.id === id) {
        if (message.action === "skip") api.next();
        if (message.action === "stop") stop(false);
      }
    },
    active: () => queue.length > 0,
    // Whether whole songs can play: asks the helper, or asks the listener first when they chose to.
    async check(command = "check") {
      if (!bridge) return null;
      full.status = await bridge({ type: command }).catch(() => null);
      // The core searches the listener's own storefront, so its songs are ones the helper can play.
      if (typeof full.status?.storefront === "string") send({ type: "storefront", code: full.status.storefront });
      // The agent tells the listener what they hear, so the core learns whether whole songs play.
      send({ type: "whole-songs", canPlay: full.status?.canPlay === true });
      onChange();
      return full.status;
    },
    fullStatus: () => (bridge ? full.status : null),
    toggle() {
      if (!queue.length) return;
      // Until the helper reports this queue, there is nothing of it to pause.
      if (mode === "full" && !full.state) return;
      if (mode === "full") {
        const playing = fullPlaying();
        void bridge({ type: playing ? "pause" : "resume" });
        if (full.state) full.state = { ...full.state, status: playing ? "paused" : "playing", positionMs: api.state()?.progressMs ?? 0 };
        full.observedAt = Date.now();
        onChange();
        return;
      }
      if (audio.paused) void audio.play().catch(() => {});
      else audio.pause();
    },
    next() {
      if (!queue.length) return;
      if (mode === "full") {
        if (!full.state) return;
        // Past the last song the queue ends, as it does for previews.
        if (index + 1 >= queue.length) return stop();
        return void bridge({ type: "next" });
      }
      index + 1 < queue.length ? load(index + 1) : stop();
    },
    stop() { stop(); },
    seek(ms) {
      if (!queue.length || !Number.isFinite(ms)) return;
      if (mode === "full") {
        if (!full.state) return;
        void bridge({ type: "seek", ms: Math.max(0, ms) });
        if (full.state) { full.state = { ...full.state, positionMs: Math.max(0, ms) }; full.observedAt = Date.now(); }
      } else audio.currentTime = Math.max(0, ms / 1000);
      onChange();
    },
    previous() {
      if (!queue.length) return;
      if (mode === "full") return void (full.state && bridge({ type: "previous" }));
      audio.currentTime > 3 || index === 0 ? (audio.currentTime = 0) : load(index - 1);
    },
    state() {
      const track = current();
      if (!track) return null;
      if (mode === "full") {
        const song = fullState();
        const playing = fullPlaying();
        const progressMs = (full.state?.positionMs ?? 0) + (playing ? Date.now() - full.observedAt : 0);
        return { title: song?.title ?? track.title, artists: [song?.artist ?? track.artist_credit].filter(Boolean),
          image: artwork(song?.artwork) ?? track.image, link: allowed(song?.link, "music.apple.com") ?? track.catalog_url, album: song?.album ?? null, full: true,
          playing, progressMs: song?.durationMs ? Math.min(progressMs, song.durationMs) : progressMs, durationMs: song?.durationMs ?? null,
          next: queue.slice(index + 1, index + 9).map((item) => ({ title: item.title, artists: [item.artist_credit], image: item.image })) };
      }
      return { title: track.title, artists: track.artist_credit ? [track.artist_credit] : [], image: track.image, link: track.catalog_url,
        playing: !audio.paused, progressMs: Math.round((audio.currentTime || 0) * 1000),
        durationMs: Math.round((Number.isFinite(audio.duration) ? audio.duration : 30) * 1000),
        next: queue.slice(index + 1, index + 9).map((item) => ({ title: item.title, artists: [item.artist_credit], image: item.image })) };
    },
  };
  return api;
}
