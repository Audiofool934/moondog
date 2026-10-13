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
const session = typeof navigator === "object" && "mediaSession" in navigator ? navigator.mediaSession : null;
const clock = (seconds) => (Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "0:00");

export function createPreviewPlayer(root) {
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

  const renderState = () => {
    const playing = !audio.paused && !audio.ended;
    toggle.innerHTML = playing ? icons.pause : icons.play;
    toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
    previous.disabled = index === 0 && audio.currentTime < 3;
    next.disabled = index >= queue.length - 1;
  };

  const renderTime = () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 30;
    const current = audio.currentTime || 0;
    bar.style.width = `${Math.min(100, (current / duration) * 100)}%`;
    seek.setAttribute("aria-valuenow", String(Math.round(current)));
    seek.setAttribute("aria-valuemax", String(Math.round(duration)));
    find("[data-player-time]").textContent = `${clock(current)} / ${clock(duration)}`;
  };

  const load = (position) => {
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
    renderTime();
    // Browsers may hold sound until the visitor presses Play; the button is ready either way.
    audio.play().catch(() => {}).finally(renderState);
  };

  audio.addEventListener("play", renderState);
  audio.addEventListener("pause", renderState);
  audio.addEventListener("timeupdate", renderTime);
  audio.addEventListener("loadedmetadata", renderTime);
  audio.addEventListener("ended", () => (index < queue.length - 1 ? load(index + 1) : renderState()));
  toggle.addEventListener("click", () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()));
  const goPrevious = () => {
    if (audio.currentTime > 3 || index === 0) { audio.currentTime = 0; renderTime(); renderState(); }
    else load(index - 1);
  };
  const goNext = () => { if (index < queue.length - 1) load(index + 1); };
  previous.addEventListener("click", goPrevious);
  next.addEventListener("click", goNext);
  const seekTo = (seconds) => {
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
    renderTime();
  };
  // Media keys and the system's Now Playing reach the player where the browser offers them.
  const actions = {
    play: () => audio.play().catch(() => {}),
    pause: () => audio.pause(),
    previoustrack: goPrevious,
    nexttrack: goNext,
    seekto: ({ seekTime }) => seekTo(seekTime),
  };
  for (const [action, handler] of Object.entries(session ? actions : {})) {
    try { session.setActionHandler(action, handler); } catch {}
  }
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
      queue = (Array.isArray(tracks) ? tracks : []).map((track) => ({
        title: String(track?.title ?? ""),
        artist_credit: String(track?.artist_credit ?? ""),
        preview: https(track?.preview_url, previewHost),
        link: https(track?.catalog_url, linkHost),
        artwork: https(track?.artwork_url, artworkHost),
      })).filter((track) => track.title && track.preview && track.link).slice(0, 30);
      if (!queue.length) return;
      album = albumInfo?.title ? { title: String(albumInfo.title), artwork: https(albumInfo.artwork_url, artworkHost) } : null;
      root.hidden = false;
      load(0);
    },
  };
}
