// The Apple Music songs the agent plays when Spotify isn't there, and the tracks Moondog makes on
// this Mac. Audio lives in the window; every
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

// A track Moondog made on this Mac, which main serves by its id and nothing else.
const generatedMedia = (value) => /^moondog-media:\/\/generated\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  .test(String(value ?? "")) ? value : null;

// Its cover, which main draws from the track's receipt in characters (src/integrations/stable-audio/cover.mjs).
const coverOf = (media) => (media ? `${media}/cover.svg` : null);

// A catalog song's id is the i parameter of its music.apple.com link.
const catalogId = (url) => { try { return new URL(url).searchParams.get("i") || null; } catch { return null; } };

// How long a press of play or pause outranks the helper's reports that were already on their way.
const HOLD_MS = 1500;

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
  const full = { status: null, state: null, observedAt: 0, started: false, reported: "", token: null };
  // The songs the helper plays now, as positions in the queue: a playlist from the listener's library mixes
  // catalog songs with tracks Moondog made, so the helper plays each run of songs and the window each made track.
  let run = { start: 0, end: 0 };

  const current = () => queue[index] ?? null;
  // A song taken out of Up next keeps its place in the queue, so the helper's and the core's positions still
  // match; playing passes over it. The song after a position, or the one before it, that still plays.
  const following = (from) => { let at = from + 1; while (at < queue.length && queue[at].removed) at += 1; return at; };
  const preceding = (from) => { let at = from - 1; while (at > 0 && queue[at].removed) at -= 1; return Math.max(0, at); };
  const report = (type) => {
    const track = current();
    if (id === null || !track) return;
    send({ type: "preview-event", id, event: { type, track: track.generated ? { title: track.title, artist_credit: "", generated: true, id: track.generated_id }
      : { title: track.title, artist_credit: track.artist_credit, catalog_url: track.catalog_url }, position: index + 1, count: queue.length } });
  };
  const describe = () => {
    const track = current();
    if (session && track) {
      session.metadata = new MediaMetadata({ title: track.title, artist: track.generated ? "Moondog" : track.artist_credit,
        artwork: track.image && !track.generated ? [{ src: track.image, sizes: "600x600", type: "image/jpeg" }] : [] });
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
  // The end of the run of catalog songs that starts at a position.
  const runEnd = (position) => {
    let end = position;
    while (end < queue.length && !queue[end].generated && !queue[end].removed && catalogId(queue[end].catalog_url)) end += 1;
    return end;
  };
  // Plays the queue from a position: a catalog song through the helper while it plays whole songs, with the
  // songs after it up to the next made track; anything else in this window.
  const playAt = (position) => {
    index = Math.max(0, Math.min(queue.length - 1, position));
    if (queue[index].removed) index = following(index) < queue.length ? following(index) : preceding(index);
    const track = current();
    if (bridge && full.status?.canPlay && !track.generated && catalogId(track.catalog_url)) {
      audio.pause();
      run = { start: index, end: runEnd(index) };
      mode = "full";
      const token = `${id}:${index}`;
      Object.assign(full, { state: null, started: false, reported: "", token });
      report("loading");
      // A helper that can't play this run stops whatever it began and hands the run to the previews.
      void bridge({ type: "play", ids: queue.slice(run.start, run.end).map((each) => catalogId(each.catalog_url)), start: 0, token }).then((answer) => {
        if (!answer?.error || full.token !== token) return;
        void bridge({ type: "stop" });
        mode = "preview";
        full.token = null;
        load(index);
      });
      onChange();
      return;
    }
    if (mode === "full") void bridge?.({ type: "stop" });
    mode = "preview";
    full.state = null;
    full.token = null;
    load(index);
  };
  // After the helper's run, the queue goes on with the made track after it, or ends.
  const afterRun = () => (following(run.end - 1) < queue.length ? playAt(following(run.end - 1)) : stop());
  const stop = (notify = true) => {
    if (!queue.length) return;
    if (notify) report("stopped");
    queue = [];
    id = null;
    if (mode === "full") void bridge?.({ type: "stop" });
    mode = "preview";
    full.state = null;
    full.token = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (session) { session.metadata = null; session.playbackState = "none"; }
    onChange();
  };

  audio.addEventListener("playing", () => { failures = 0; report("playing"); describe(); });
  audio.addEventListener("pause", () => { if (!audio.ended && queue.length) { report("paused"); describe(); } });
  audio.addEventListener("timeupdate", onChange);
  // A made track that played to its end is reported as finished, for the loop back from listening.
  audio.addEventListener("ended", () => {
    if (current()?.generated) report("finished");
    return following(index) < queue.length ? playAt(following(index)) : stop();
  });
  audio.addEventListener("error", () => {
    if (!queue.length) return;
    report("failed");
    // A preview that won't load is skipped; three in a row end the queue.
    if (++failures < 3 && following(index) < queue.length) playAt(following(index));
    else stop();
  });
  // The helper reports its player; the core hears it as it hears previews. A report about another
  // queue (one stopped or replaced while it loaded) is not this one's.
  window.moondogApp?.onAppleMusic?.((message) => {
    if (mode !== "full" || !queue.length) return;
    if (message?.type === "exited") { stop(); return; }
    if (message?.type !== "state" || message.token !== full.token) return;
    if (message.status === "ended") { afterRun(); return; }
    // A report the helper sent before a pause or resume took hold still has the old status, so for a
    // moment after the listener's own press the window keeps what they chose.
    const held = full.hold && Date.now() < full.hold.until && ["playing", "paused"].includes(message.status) && message.status !== full.hold.status;
    if (held) message = { ...message, status: full.hold.status, positionMs: full.state?.positionMs ?? message.positionMs };
    full.state = message;
    full.observedAt = Date.now();
    if (Number.isInteger(message.index)) index = Math.max(run.start, Math.min(run.end - 1, run.start + message.index));
    // The helper reached a song taken out after its run was loaded: the queue goes on past it.
    if (queue[index]?.removed) { following(index) < queue.length ? playAt(following(index)) : stop(); return; }
    const key = `${message.status}|${index}`;
    if (key !== full.reported) {
      full.reported = key;
      if (message.status === "playing") { full.started = true; report("playing"); }
      else if (message.status === "paused") report("paused");
      // Stopped after it started is the end of the queue.
      else if (message.status === "stopped" && full.started) { afterRun(); return; }
    }
    onChange();
  });
  const fullState = () => full.state?.song ?? null;
  // The next eight songs that still play, each with its place in the queue for jumping to it or taking it out.
  const upNext = () => queue.map((item, position) => ({ item, position })).slice(index + 1).filter(({ item }) => !item.removed).slice(0, 8)
    .map(({ item, position }) => ({ title: item.title, artists: item.artist_credit ? [item.artist_credit] : [], image: item.image, position,
      ...(item.generated ? { generated: true } : {}) }));
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
        const tracks = (Array.isArray(message.tracks) ? message.tracks : []).map((track) => track.generated === true ? {
          title: String(track.title ?? ""), artist_credit: "", preview_url: generatedMedia(track.media_url), catalog_url: null, image: coverOf(generatedMedia(track.media_url)),
          generated: true, generated_id: generatedMedia(track.media_url)?.split("/").at(-1) ?? null,
          duration_seconds: Number.isFinite(track.duration_seconds) ? track.duration_seconds : null,
        } : {
          title: String(track.title ?? ""), artist_credit: String(track.artist_credit ?? ""),
          preview_url: allowed(track.preview_url, "audio-ssl.itunes.apple.com"), catalog_url: allowed(track.catalog_url, "music.apple.com"),
          image: artwork(track.artwork_url ?? message.album?.artwork_url),
        }).filter((track) => track.title && track.preview_url);
        // The core believes a queue plays once it sends one, so a queue this window cannot play says so.
        if (!tracks.length) { send({ type: "preview-event", id: message.id, event: { type: "stopped" } }); return; }
        if (queue.length) stop();
        queue = tracks;
        id = message.id;
        index = 0;
        report("queue");
        playAt(0);
        // A check that failed for a passing reason (the helper was slow, or went away) is asked again for the next queue.
        if (mode === "preview" && full.status?.error && full.status.error !== "unavailable") void api.check();
      }
      // An Apple Music song added at the end, as a pick from Up next is; the queue plays it once it gets there.
      if (message.type === "preview-enqueue" && message.id === id && message.track && message.track.generated !== true) {
        const song = { title: String(message.track.title ?? ""), artist_credit: String(message.track.artist_credit ?? ""),
          preview_url: allowed(message.track.preview_url, "audio-ssl.itunes.apple.com"), catalog_url: allowed(message.track.catalog_url, "music.apple.com"),
          image: artwork(message.track.artwork_url) };
        if (!song.title || !song.preview_url) return;
        queue.push(song);
        onChange();
      }
      // A made track queued behind this queue's last one, as Moondog's stream does.
      if (message.type === "preview-enqueue" && message.id === id && message.track?.generated === true) {
        const media = generatedMedia(message.track.media_url);
        if (!media || queue.some((track) => !track.generated)) return;
        queue.push({ title: String(message.track.title ?? ""), artist_credit: "", preview_url: media, catalog_url: null, image: coverOf(media),
          generated: true, generated_id: media.split("/").at(-1),
          duration_seconds: Number.isFinite(message.track.duration_seconds) ? message.track.duration_seconds : null });
        onChange();
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
        full.hold = { status: playing ? "paused" : "playing", until: Date.now() + HOLD_MS };
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
        // Past the run's last song the queue goes on with the made track after it, or ends, as it does for previews;
        // a song taken out after the run was loaded is passed over.
        if (index + 1 >= run.end) return afterRun();
        if (queue[index + 1].removed) return following(index) < queue.length ? playAt(following(index)) : stop();
        return void bridge({ type: "next" });
      }
      if (following(index) < queue.length) return playAt(following(index));
      // A made track skipped past the end of its queue: Moondog's stream moves on once its next track is made.
      if (current()?.generated) report("skipped");
      stop();
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
      if (mode === "full") {
        if (!full.state) return;
        // At the run's first song, early on, back goes to the made track before it.
        if (index === run.start && index > 0 && (api.state()?.progressMs ?? 0) < 3000) return playAt(preceding(index));
        return void bridge({ type: "previous" });
      }
      audio.currentTime > 3 || index === 0 ? (audio.currentTime = 0) : playAt(preceding(index));
    },
    // A song in Up next, by its place in the queue: it plays now, past the ones before it.
    jump(position) {
      if (!queue.length || !Number.isInteger(position) || position <= index || position >= queue.length || queue[position].removed) return;
      playAt(position);
    },
    // A song taken out of Up next. The one playing stays.
    remove(position) {
      if (!Number.isInteger(position) || position <= index || position >= queue.length || queue[position].removed) return;
      queue[position].removed = true;
      send({ type: "preview-event", id, event: { type: "removed", position: position + 1 } });
      onChange();
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
          next: upNext() };
      }
      return { title: track.title, artists: track.artist_credit ? [track.artist_credit] : [], image: track.image, link: track.catalog_url,
        ...(track.generated ? { generated: true } : {}),
        playing: !audio.paused, progressMs: Math.round((audio.currentTime || 0) * 1000),
        durationMs: Math.round((Number.isFinite(audio.duration) ? audio.duration : track.duration_seconds ?? 30) * 1000),
        next: upNext() };
    },
  };
  return api;
}
