import { lyricIdentity } from "../../core/lyric-profile.mjs";

const origin = "https://lrclib.net";
const userAgent = "Moondog/0.1.0 (https://github.com/Audiofool934/moondog)";

export class LyricsProviderError extends Error {
  constructor(message, retryAfterMs = 60_000) {
    super(message);
    this.name = "LyricsProviderError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function createLrclibProvider({ fetchImpl = fetch } = {}) {
  return {
    async lookup(track, { signal } = {}) {
      const url = new URL("/api/get", origin);
      url.searchParams.set("track_name", track.title);
      url.searchParams.set("artist_name", track.artist);
      if (track.album) url.searchParams.set("album_name", track.album);
      if (track.durationSeconds) url.searchParams.set("duration", String(track.durationSeconds));
      const response = await fetchImpl(url, {
        headers: { "User-Agent": userAgent, Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
        redirect: "error",
      });
      if (response.status === 404) return { state: "not_found" };
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        const delay = /^\d+$/u.test(retry ?? "") ? Number(retry) * 1_000 : Date.parse(retry) - Date.now();
        throw new LyricsProviderError("LRCLIB is rate limited.", Math.max(60_000, Number.isFinite(delay) ? delay : 0));
      }
      if (!response.ok) throw new LyricsProviderError(`LRCLIB returned HTTP ${response.status}.`);
      const body = await response.text();
      if (body.length > 512_000) throw new LyricsProviderError("Lyrics response is too large.");
      const value = JSON.parse(body);
      if (!Number.isSafeInteger(value.id) || value.id < 1 ||
          lyricIdentity(value.trackName) !== lyricIdentity(track.title) ||
          lyricIdentity(value.artistName) !== lyricIdentity(track.artist) ||
          (track.album && lyricIdentity(value.albumName) !== lyricIdentity(track.album)) ||
          (track.durationSeconds && (!Number.isFinite(value.duration) || Math.abs(value.duration - track.durationSeconds) > 2))) {
        return { state: "mismatch" };
      }
      const plainLyrics = typeof value.plainLyrics === "string" ? value.plainLyrics : null;
      const syncedLyrics = typeof value.syncedLyrics === "string" ? value.syncedLyrics : null;
      return {
        state: value.instrumental ? "instrumental" : plainLyrics || syncedLyrics ? "ready" : "not_found",
        provider: "lrclib", providerId: String(value.id), sourceUrl: `${origin}/api/get/${value.id}`,
        title: value.trackName, artist: value.artistName, album: value.albumName ?? null,
        durationSeconds: Number.isFinite(value.duration) ? value.duration : null,
        plainLyrics, syncedLyrics,
      };
    },
  };
}
