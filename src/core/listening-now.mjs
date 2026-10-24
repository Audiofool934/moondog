// What the listener plays right now, wherever it plays: the Music app on this Mac, Spotify on its
// active device, or NetEase through ncm-cli, with the playlist, album or queue it plays from.
// Two players rarely play at once. When they do, one that plays wins over a paused one, then the
// listener's chosen service, then this order.
export const LISTENING_ORDER = Object.freeze(["apple_music", "spotify", "netease"]);

export function activeListening(sources, chosen) {
  const order = [...new Set([chosen, ...LISTENING_ORDER])];
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

async function musicApp(application) {
  const now = await application.musicApp.nowPlaying({ tracks: true });
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
