import { createHash } from "node:crypto";

export function lyricIdentity(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

export function lyricTrackKey(track) {
  return createHash("sha256").update(JSON.stringify([
    lyricIdentity(track.title), lyricIdentity(track.artist),
    lyricIdentity(track.album), track.durationSeconds ?? null,
  ])).digest("hex");
}

/** Only structured preferences and listening evidence can seed the lyric library. */
export function lyricSeedsFromProfile(profile = {}) {
  const assertions = profile.listener_assertions ?? {};
  const curated = profile.curated_preferences ?? {};
  const behavior = profile.listening_behavior ?? {};
  const avoids = [
    ...(profile.lyric_exclusions ?? []), ...(assertions.avoids ?? []),
    ...(assertions.active ?? []).filter((item) => item.stance === "avoid"),
    ...(curated.avoids ?? []),
  ];
  const sources = [
    [(assertions.preferences ?? []).filter((item) => item.entity_type === "track"), "explicit_like", 3],
    [(profile.strong_preferences ?? []).filter((item) => item.entity_type === "track" || item.track_ref_id), "preference", 2],
    [curated.saved_tracks ?? [], "saved", 2],
    [curated.playlist_anchors ?? [], "playlist", 1],
    [(behavior.repeat_tracks ?? []).filter((item) => item.play_count >= 3), "repeated_listening", 1],
    [(profile.familiarity ?? []).filter((item) => item.play_count >= 3), "repeated_listening", 1],
  ];
  const tracks = new Map();
  for (const [items, basis, weight] of sources) {
    for (const item of items) {
      const title = item.label?.trim();
      const artist = item.artist_credit?.trim();
      if (!title || !artist || title.length > 512 || artist.length > 512 ||
          /^(?:unknown|unknown artist)$/iu.test(artist)) continue;
      if (avoids.some((avoid) => avoid.entity_type === "artist"
        ? lyricIdentity(avoid.label) === lyricIdentity(artist)
        : avoid.entity_type === "track" && lyricIdentity(avoid.label) === lyricIdentity(title) &&
          lyricIdentity(avoid.artist_credit) === lyricIdentity(artist))) continue;
      const track = { title, artist, basis, weight };
      // Listening duration is not track duration; never use play time to match a version.
      const key = lyricTrackKey(track);
      if (!tracks.has(key)) tracks.set(key, track);
    }
  }
  return [...tracks.values()].slice(0, 50);
}
