// What the listener plays right now, wherever it plays: Moondog's own player (the songs it played or
// queued, the tracks it made, its stream), the Music app on this Mac, Spotify on its active device,
// or NetEase through ncm-cli, with the playlist, album or queue it plays from.
// Two players rarely play at once. When they do, one that plays wins over a paused one, then
// Moondog's own player, which pauses the others when it starts, then the listener's chosen service,
// then this order.
export const LISTENING_ORDER = Object.freeze(["moondog", "apple_music", "spotify", "netease"]);

export function activeListening(sources, chosen) {
  const order = [...new Set(["moondog", chosen, ...LISTENING_ORDER])];
  const heard = sources.filter((source) => source.song && (source.state === "playing" || source.state === "paused"));
  return heard.sort((a, b) => (a.state === "playing" ? 0 : 1) - (b.state === "playing" ? 0 : 1) ||
    order.indexOf(a.service) - order.indexOf(b.service))[0] ?? null;
}

const songOf = (item) => ({
  title: item.name ?? item.title ?? "",
  artists: Array.isArray(item.artists) ? item.artists : [],
  album: item.album ?? null,
  duration_ms: Number.isInteger(item.duration_ms) ? item.duration_ms : null,
  ...(item.track_ref_id ? { track_ref_id: item.track_ref_id } : {}),
});

// What the Music app plays, as one source. Its playlist's songs come only from a read that asked for them.
export function musicAppSource(now) {
  if (!now.song) return { state: now.state, ...(now.reason ? { reason: now.reason } : {}) };
  const playlist = now.playlist;
  return {
    state: now.state,
    player: "Music app on this Mac",
    song: songOf(now.song),
    position_ms: now.position_ms,
    shuffle: now.shuffle,
    repeat: now.repeat,
    from: playlist ? {
      kind: playlist.library ? "library" : "playlist",
      name: playlist.name,
      tracks_total: playlist.tracks_total ?? null,
      position: playlist.position ?? null,
      ...(playlist.tracks ? { first_position: playlist.first_position, tracks: playlist.tracks.map(songOf) } : {}),
    } : null,
  };
}

const musicApp = async (application) => musicAppSource(await application.musicApp.nowPlaying({ tracks: true }));

// Spotify reports only the device that plays; reading it costs three or four requests of the quota.
async function spotify(application, { signal }) {
  const player = await application.spotifyNowPlaying({ signal });
  if (player.state !== "available" || !player.item) return { state: "stopped" };
  const context = player.context ?? null;
  const [queue, playlist] = await Promise.all([
    application.spotifyQueueStatus({ signal }).catch((error) => (signal?.aborted ? Promise.reject(error) : null)),
    context?.type === "playlist"
      ? application.requireSpotifyService().playingPlaylist({ uri: context.uri }, { signal })
        .catch((error) => (signal?.aborted ? Promise.reject(error) : { unavailable: String(error?.message ?? error).slice(0, 200) }))
      : null,
  ]);
  const from = context?.type === "playlist"
    ? { kind: "playlist", name: playlist.name ?? null, tracks_total: playlist.tracks_total ?? null,
      ...(playlist.tracks ? { first_position: 1, tracks: playlist.tracks.map(songOf) } : {}),
      ...(playlist.unavailable ? { unavailable: playlist.unavailable } : {}) }
    : context?.type === "album" ? { kind: "album", name: player.item.album ?? null }
      : context?.type === "artist" ? { kind: "artist", name: player.item.artists?.[0] ?? null }
        : context?.type === "collection" ? { kind: "liked_songs", name: "Liked Songs" }
          : null;
  return {
    state: player.is_playing === true ? "playing" : "paused",
    player: player.device?.name ? `Spotify on ${player.device.name}` : "Spotify",
    ...(player.device ? { device: { name: player.device.name ?? null, type: player.device.type ?? null } } : {}),
    song: songOf(player.item),
    position_ms: player.progress_ms ?? 0,
    shuffle: player.shuffle_state === true,
    repeat: player.repeat_state ?? "off",
    from,
    next: (queue?.queue ?? []).map(songOf),
  };
}

// Moondog's own player: Apple Music songs in the window or the terminal, and the tracks Moondog made.
const madeBy = (track) => ({ title: track.title, artists: track.generated ? ["Moondog"] : track.artist_credit ? [track.artist_credit] : [],
  ...(track.generated && track.id ? { made_track_id: track.id } : {}) });
function moondogPlayer(application) {
  const now = application.musicPreviewPlayer.nowPlaying();
  if (!now?.song?.title) return { state: "stopped" };
  const kind = !now.song.generated ? "moondog_queue" : application.streamView?.() ? "moondog_stream" : "moondog_made";
  return {
    state: now.state,
    player: "Moondog's own player",
    song: madeBy(now.song),
    from: { kind, name: null, tracks_total: now.count, position: now.position },
    next: now.next.map(madeBy),
  };
}

async function netease(application) {
  const now = await application.neteaseNowPlaying();
  if (now.state === "stopped" || !now.song) return { state: "stopped" };
  return {
    state: now.state,
    player: "NetEase Music through ncm-cli on this Mac",
    song: songOf(now.song),
    position_ms: now.position_ms ?? 0,
    from: { kind: "moondog_queue", name: null },
    next: (now.next ?? []).map(songOf),
  };
}

/** Every player Moondog can read, the one the listener hears first: { active, sources }. */
export async function readListeningNow(application, { signal } = {}) {
  const readers = [
    typeof application.musicPreviewPlayer?.nowPlaying === "function" ? ["moondog", () => moondogPlayer(application)] : null,
    application.musicApp?.available ? ["apple_music", () => musicApp(application)] : null,
    application.spotifyReady() ? ["spotify", () => spotify(application, { signal })] : null,
    application.neteaseReady() ? ["netease", () => netease(application)] : null,
  ].filter(Boolean);
  const sources = await Promise.all(readers.map(async ([service, read]) => {
    try {
      return { service, ...(await read()) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { service, state: "unreadable", reason: String(error?.message ?? error).slice(0, 200) };
    }
  }));
  const active = activeListening(sources, application.playbackService);
  return { active: active?.service ?? null, sources: active ? [active, ...sources.filter((source) => source !== active)] : sources };
}

// What Moondog's own player plays: the queue it was sent last, and where in it the player's own
// events put it. The window and the terminal players keep one each, so the agent can read the songs
// it played or queued, and the tracks it made, as it reads the Music app or Spotify.

const entry = (track) => ({
  title: String(track?.title ?? "").trim(),
  artist_credit: String(track?.artist_credit ?? "").trim(),
  ...(track?.generated === true ? { generated: true, ...(typeof track.id === "string" && track.id ? { id: track.id } : {}) } : {}),
});

export function createPlayerNow() {
  // null, or { tracks, index, state } where state is "loading", "playing" or "paused".
  let queue = null;
  return {
    /** A new queue replaces the last one and starts from its first song. */
    queued(tracks) {
      const list = (Array.isArray(tracks) ? tracks : []).map(entry).filter((track) => track.title);
      queue = list.length ? { tracks: list, index: 0, state: "loading" } : null;
    },
    /** A made track queued behind the last one, as Moondog's stream does. */
    appended(track) {
      const added = entry(track);
      if (queue && added.title) queue.tracks.push(added);
    },
    /** One of the player's events: { type, position } moves it along; stopped empties it. */
    observe(event) {
      // The terminal's player announces each new queue with its songs; the window's does not.
      if (event?.type === "queue" && Array.isArray(event.tracks)) { this.queued(event.tracks); return; }
      if (!queue) return;
      if (event?.type === "stopped") { queue = null; return; }
      // A song the listener took out of Up next keeps its place, so the positions the player reports still match.
      if (event?.type === "removed") {
        if (Number.isInteger(event.position) && event.position > queue.index + 1 && event.position <= queue.tracks.length) queue.tracks[event.position - 1].removed = true;
        return;
      }
      if (Number.isInteger(event?.position) && event.position >= 1 && event.position <= queue.tracks.length) queue.index = event.position - 1;
      if (event?.type === "playing" || event?.type === "paused" || event?.type === "loading") queue.state = event.type;
    },
    clear() {
      queue = null;
    },
    /** The song playing and every one after it, for keeping the whole queue: read() shows only ten. */
    remaining() {
      return queue ? queue.tracks.slice(queue.index).filter((track) => !track.removed).map((track) => ({ ...track })) : [];
    },
    /** null when nothing is queued, or { state, song, position, count, next } with up to ten songs after it. */
    read() {
      if (!queue) return null;
      return {
        // A song still loading is the one the listener is about to hear.
        state: queue.state === "paused" ? "paused" : "playing",
        song: { ...queue.tracks[queue.index] },
        position: queue.index + 1,
        count: queue.tracks.length,
        next: queue.tracks.slice(queue.index + 1).filter((track) => !track.removed).slice(0, 10).map((track) => ({ ...track })),
      };
    },
  };
}
