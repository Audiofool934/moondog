// The small player under the room. It plays the Apple Music previews the agent picks,
// one after another, next to a link to each full song.
const icons = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="7 4 20 12 7 20" /></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>',
};

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
const artworkHost = (host) => host.endsWith(".mzstatic.com");
// Now Playing shows a larger cover than the player does; Apple's image host makes any size.
const largeArtwork = (url) => url.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/u, "/600x600bb.$1");
const clock = (seconds) => (Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "0:00");

export function createPreviewPlayer(root) {
  const session = typeof navigator === "object" && "mediaSession" in navigator ? navigator.mediaSession : null;
  const find = (selector) => root.querySelector(selector);
  const audio = find("audio");
  const art = find("[data-player-art]");
  const toggle = find("[data-player-toggle]");
  const previous = find("[data-player-prev]");
  const next = find("[data-player-next]");
  const seek = find("[data-player-seek]");
  const bar = find("[data-player-bar]");
  let queue = [];
  let album = null;
  let index = 0;
  let generation = 0;
  let attempt = 0;
  let state = "stopped";
  const listeners = new Set();
  const publicTrack = ({ title, artist_credit, link }) => ({ title, artist_credit, catalog_url: link });
  const emit = (event) => {
    for (const listener of listeners) {
      try { listener(event); } catch {}
    }
  };
  const report = (type) => {
    if (!queue.length || state === type) return;
    state = type;
    if (session) session.playbackState = type === "playing" ? "playing" : "paused";
    emit({ type, track: publicTrack(queue[index]), position: index + 1, count: queue.length });
  };

  const renderState = () => {
    const playing = queue.length && !audio.paused && !audio.ended;
    toggle.innerHTML = playing ? icons.pause : icons.play;
    toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
    previous.disabled = !queue.length || (index === 0 && audio.currentTime < 3);
    next.disabled = !queue.length;
  };

  const renderTime = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 30;
    const current = audio.currentTime || 0;
    bar.style.width = `${Math.min(100, (current / duration) * 100)}%`;
    seek.setAttribute("aria-valuenow", String(Math.round(current)));
    seek.setAttribute("aria-valuemax", String(Math.round(duration)));
    find("[data-player-time]").textContent = `${clock(current)} / ${clock(duration)}`;
  };

  const stop = () => {
    if (!queue.length) return false;
    generation += 1;
    attempt += 1;
    queue = [];
    album = null;
    index = 0;
    state = "stopped";
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (session) {
      session.metadata = null;
      session.playbackState = "none";
      try { session.setPositionState?.(); } catch {}
    }
    setMediaActions(false);
    root.hidden = true;
    renderState();
    renderTime();
    emit({ type: "stopped" });
    return true;
  };

  const skip = () => {
    if (!queue.length) return false;
    if (index < queue.length - 1) load(index + 1);
    else stop();
    return true;
  };

  const failed = () => {
    report("failed");
    skip();
  };

  const resume = () => {
    if (!queue.length) return false;
    const ownGeneration = generation;
    const ownAttempt = ++attempt;
    const current = () => queue.length && generation === ownGeneration && attempt === ownAttempt;
    report("loading");
    const rejected = (error) => {
      if (!current()) return;
      // An autoplay policy leaves the current preview ready for an explicit Play.
      if (error?.name === "NotAllowedError") report("paused");
      else failed();
      renderState();
    };
    try {
      Promise.resolve(audio.play()).then(() => {
        if (!current()) return;
        if (!audio.paused && !audio.ended) report("playing");
        renderState();
      }, rejected);
    } catch (error) { rejected(error); }
    return true;
  };

  const pause = () => {
    if (!queue.length) return false;
    attempt += 1;
    audio.pause();
    report("paused");
    renderState();
    return true;
  };

  const load = (position) => {
    generation += 1;
    attempt += 1;
    // Ignore the old element's pause while replacing its source.
    state = "loading";
    audio.pause();
    index = Math.max(0, Math.min(position, queue.length - 1));
    const track = queue[index];
    find("[data-player-title]").textContent = track.title;
    find("[data-player-artist]").textContent = track.artist_credit;
    find("[data-player-link]").href = track.link;
    find("[data-player-position]").textContent = album
      ? `${album.title}, preview ${index + 1} of ${queue.length}`
      : `Preview ${index + 1} of ${queue.length}`;
    const cover = track.artwork ?? album?.artwork;
    art.hidden = !cover;
    if (cover) art.src = cover;
    if (session && typeof MediaMetadata === "function") {
      session.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist_credit,
        album: album?.title ?? "",
        artwork: cover ? [{ src: largeArtwork(cover), sizes: "600x600" }] : [],
      });
    }
    audio.src = track.preview;
    state = null;
    report("loading");
    renderTime();
    renderState();
    resume();
  };

  audio.addEventListener("play", renderState);
  audio.addEventListener("playing", () => {
    if (queue.length && !audio.paused && !audio.ended) report("playing");
    renderState();
  });
  audio.addEventListener("pause", () => {
    if (queue.length && state !== "loading" && audio.paused && !audio.ended) {
      attempt += 1;
      report("paused");
    }
    renderState();
  });
  audio.addEventListener("timeupdate", () => { renderTime(); renderState(); });
  audio.addEventListener("loadedmetadata", renderTime);
  audio.addEventListener("ended", () => { if (audio.ended) skip(); });
  audio.addEventListener("error", () => { if (queue.length && audio.error) failed(); });
  toggle.addEventListener("click", () => (audio.paused ? resume() : pause()));
  const goPrevious = () => {
    if (!queue.length) return false;
    if (audio.currentTime > 3 || index === 0) { audio.currentTime = 0; renderTime(); renderState(); }
    else load(index - 1);
    return true;
  };
  previous.addEventListener("click", goPrevious);
  next.addEventListener("click", skip);
  const seekTo = (seconds) => {
    if (!queue.length || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
    renderTime();
  };
  // Media keys and the system's Now Playing reach the player where the browser offers them.
  const actions = {
    play: resume,
    pause,
    stop,
    previoustrack: goPrevious,
    nexttrack: skip,
    seekto: ({ seekTime }) => seekTo(seekTime),
  };
  const setMediaActions = (active) => {
    for (const [action, handler] of Object.entries(session ? actions : {})) {
      try { session.setActionHandler(action, active ? handler : null); } catch {}
    }
  };
  seek.addEventListener("click", (event) => {
    const box = seek.getBoundingClientRect();
    seekTo(((event.clientX - box.left) / box.width) * audio.duration);
  });
  seek.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") { seekTo(audio.currentTime + 5); event.preventDefault(); }
    if (event.key === "ArrowLeft") { seekTo(audio.currentTime - 5); event.preventDefault(); }
  });

  return {
    // A new set of previews replaces the queue and starts from its first song.
    play(tracks, albumInfo) {
      const accepted = (Array.isArray(tracks) ? tracks : []).map((track) => ({
        title: String(track?.title ?? "").trim(),
        artist_credit: String(track?.artist_credit ?? "").trim(),
        preview: https(track?.preview_url, previewHost),
        link: https(track?.catalog_url, linkHost),
        artwork: https(track?.artwork_url, artworkHost),
      })).filter((track) => track.title && track.preview && track.link).slice(0, 30);
      if (!accepted.length) return false;
      stop();
      queue = accepted;
      album = albumInfo?.title ? {
        title: String(albumInfo.title), artist_credit: String(albumInfo.artist_credit ?? ""),
        catalog_url: https(albumInfo.catalog_url, linkHost), artwork: https(albumInfo.artwork_url, artworkHost),
      } : null;
      emit({
        type: "queue", tracks: queue.map(publicTrack),
        album: album ? { title: album.title, artist_credit: album.artist_credit, catalog_url: album.catalog_url } : null,
      });
      setMediaActions(true);
      root.hidden = false;
      load(0);
      return true;
    },
    skip,
    stop,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
