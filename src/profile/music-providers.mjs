export const MUSIC_PROVIDER_LABELS = Object.freeze({
  spotify_account_data: "Spotify",
  youtube_music: "YouTube Music",
  qq_music: "QQ Music",
  netease: "NetEase Cloud Music",
});

export function musicProviderLabel(system) {
  return MUSIC_PROVIDER_LABELS[system] ?? "Imported music";
}

export function collectionCoverage(coverage) {
  const spotify = coverage.collection_sources?.find((source) => source.system === "spotify_account_data");
  return {
    collection_tracks: coverage.collection_tracks ?? 0,
    collection_sources: coverage.collection_sources ?? [],
    saved_tracks: coverage.saved_tracks,
    playlist_memberships: coverage.playlist_memberships,
    spotify_profile_evidence: spotify?.evidence_records ?? 0,
    spotify_saved_tracks: spotify?.saved_tracks ?? 0,
    spotify_saved_albums: spotify?.saved_albums ?? 0,
    spotify_followed_artists: spotify?.followed_artists ?? 0,
    spotify_playlist_memberships: spotify?.playlist_memberships ?? 0,
  };
}
