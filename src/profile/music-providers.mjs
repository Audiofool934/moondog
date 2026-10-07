export const MUSIC_PROVIDER_LABELS = Object.freeze({
  spotify_account_data: "Spotify",
  spotify_web_api: "Spotify",
  youtube_music: "YouTube Music",
  qq_music: "QQ Music",
  netease: "NetEase Cloud Music",
});

export function musicProviderLabel(system) {
  return MUSIC_PROVIDER_LABELS[system] ?? "Imported music";
}

export function collectionCoverage(coverage) {
  // An export and a live library read are both Spotify; evidence is already deduplicated across them.
  const spotify = (coverage.collection_sources ?? []).filter((source) => ["spotify_account_data", "spotify_web_api"].includes(source.system));
  const total = (key) => spotify.reduce((sum, source) => sum + (source[key] ?? 0), 0);
  return {
    collection_tracks: coverage.collection_tracks ?? 0,
    collection_sources: coverage.collection_sources ?? [],
    saved_tracks: coverage.saved_tracks,
    playlist_memberships: coverage.playlist_memberships,
    spotify_profile_evidence: total("evidence_records"),
    spotify_saved_tracks: total("saved_tracks"),
    spotify_saved_albums: total("saved_albums"),
    spotify_followed_artists: total("followed_artists"),
    spotify_playlist_memberships: total("playlist_memberships"),
  };
}
