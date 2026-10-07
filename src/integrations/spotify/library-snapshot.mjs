import { createHash } from "node:crypto";

import { isUuid, uuidV5 } from "../../core/uuid-v5.mjs";
import { spotifyEntityRefId, spotifyProfileEvidenceKey, spotifyResolvedTrackRef } from "./account-data-profile.mjs";

export const SPOTIFY_LIBRARY_SOURCE = "spotify.web_api_library";
export const SPOTIFY_LIBRARY_FORMAT = "spotify_web_api_library_v1";
export const SPOTIFY_LIBRARY_SYSTEM = "spotify_web_api";
// Read-only access for a library import; playback control is never requested.
export const SPOTIFY_LIBRARY_SCOPES = Object.freeze([
  "user-read-recently-played", "user-library-read", "user-follow-read", "user-top-read", "playlist-read-private",
]);
export const SPOTIFY_LIBRARY_LIMITS = Object.freeze({
  savedTracks: 10_000, savedAlbums: 2_000, followedArtists: 2_000,
  playlists: 200, itemsPerPlaylist: 2_000, playlistItems: 20_000, topItems: 50,
});
const TOP_PERIODS = Object.freeze({
  short_term: "the last four weeks", medium_term: "the last six months", long_term: "about the last year",
});
const IMPORT_NAMESPACE = "77b3424f-3dd4-4fd9-ac70-42a6b9397dae";
const EVIDENCE_NAMESPACE = "2efe152f-5455-4de6-b88f-09597719abb5";
const BATCH_NAMESPACE = "d2b37594-838e-452b-8810-f6052f510e65";
const MEMBERS = ["saved_tracks", "saved_albums", "followed_artists", "playlists", "top_items"];

function idFromUri(uri, type) {
  const match = typeof uri === "string" ? new RegExp(`^spotify:${type}:([A-Za-z0-9]{22})$`, "u").exec(uri) : null;
  return match?.[1] ?? null;
}

function track(item, extra = {}) {
  const id = item?.id ?? idFromUri(item?.uri, "track");
  if (!id || !item.name || !Array.isArray(item.artists) || !item.artists.length) return null;
  return { id, name: item.name, artists: item.artists, ...(item.album ? { album: item.album } : {}), ...extra };
}

async function pages(read, cap, onPage) {
  const items = [];
  let cursor = { offset: 0 };
  for (;;) {
    const page = await read(cursor);
    for (const item of page.items ?? []) {
      if (items.length >= cap) return { items, truncated: true };
      items.push(item);
    }
    onPage?.(items.length);
    if (!page.has_more) return { items, truncated: false };
    if (page.next_after) { cursor = { after: page.next_after }; continue; }
    // Playlist pages report their offset and size rather than a next offset.
    const next = Number.isSafeInteger(page.next_offset) ? page.next_offset
      : Number.isSafeInteger(page.offset) && Number.isSafeInteger(page.limit) ? page.offset + page.limit : null;
    if (next === null || next <= (cursor.offset ?? -1)) return { items, truncated: true };
    cursor = { offset: next };
  }
}

const clip = value => Array.from(value).slice(0, 512).join("");

/**
 * Read the listener's Spotify library through the authorized client: saved
 * tracks and albums, followed artists, their own playlists, and Spotify's top
 * artists and tracks. Every read is bounded; a playlist that cannot be read is
 * skipped and counted rather than failing the whole snapshot.
 */
export async function readSpotifyLibrarySnapshot(client, { signal, onProgress = () => {}, limits = SPOTIFY_LIBRARY_LIMITS } = {}) {
  const progress = (stage, count) => { signal?.throwIfAborted(); onProgress({ stage, count }); };
  const account = await client.getAccount({ signal });
  const saved = await pages(({ offset }) => client.getSavedItems({ type: "tracks", limit: 50, offset }, { signal }),
    limits.savedTracks, count => progress("saved_tracks", count));
  const albums = await pages(({ offset }) => client.getSavedItems({ type: "albums", limit: 50, offset }, { signal }),
    limits.savedAlbums, count => progress("saved_albums", count));
  const artists = await pages(({ after }) => client.getFollowedArtists({ limit: 50, ...(after ? { after } : {}) }, { signal }),
    limits.followedArtists, count => progress("followed_artists", count));
  const listed = await pages(({ offset }) => client.getCurrentUserPlaylists({ limit: 50, offset }, { signal }),
    limits.playlists, count => progress("playlists", count));
  const playlists = [];
  let playlistItems = 0;
  let skippedPlaylists = 0;
  let truncatedPlaylistItems = false;
  // Followed playlists are someone else's curation; only the listener's own count.
  for (const playlist of listed.items.filter(item => account.account_id && item.owner_id === account.account_id)) {
    if (playlistItems >= limits.playlistItems) { truncatedPlaylistItems = true; break; }
    try {
      const read = await pages(({ offset }) => client.getPlaylistItems({ playlistId: playlist.id, limit: 50, offset }, { signal }),
        Math.min(limits.itemsPerPlaylist, limits.playlistItems - playlistItems));
      truncatedPlaylistItems ||= read.truncated;
      const tracks = read.items.flatMap((entry, index) => {
        if (entry.is_local || entry.item?.type !== "track") return [];
        const value = track(entry.item, { position: index + 1, ...(entry.added_at ? { added_at: entry.added_at } : {}) });
        return value ? [value] : [];
      });
      playlistItems += read.items.length;
      playlists.push({ id: playlist.id, name: playlist.name, tracks });
      progress("playlist_items", playlistItems);
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      skippedPlaylists++;
    }
  }
  const top = { artists: {}, tracks: {} };
  for (const type of ["artists", "tracks"]) {
    for (const timeRange of Object.keys(TOP_PERIODS)) {
      const result = await client.getTopItems({ type, timeRange, limit: limits.topItems }, { signal });
      top[type][timeRange] = (result.items ?? []).flatMap((item, index) => {
        const rank = item.affinity_rank ?? index + 1;
        if (type === "tracks") {
          const value = track(item, { rank });
          return value ? [value] : [];
        }
        return item.name ? [{ name: item.name, rank, ...(idFromUri(item.uri, "artist") ? { id: idFromUri(item.uri, "artist") } : {}) }] : [];
      });
      progress("top_items", Object.values(top).reduce((sum, ranges) => sum + Object.values(ranges).flat().length, 0));
    }
  }
  return {
    saved_tracks: saved.items.flatMap(item => track(item, item.added_at ? { added_at: item.added_at } : {}) ?? []),
    saved_albums: albums.items.flatMap(item => {
      const id = idFromUri(item.uri, "album");
      return id && item.name ? [{ id, name: item.name, artists: item.artists ?? [], ...(item.added_at ? { added_at: item.added_at } : {}) }] : [];
    }),
    followed_artists: artists.items.flatMap(item => {
      const id = idFromUri(item.uri, "artist");
      return id && item.name ? [{ id, name: item.name }] : [];
    }),
    playlists,
    top_artists: top.artists,
    top_tracks: top.tracks,
    truncated: { saved_tracks: saved.truncated, saved_albums: albums.truncated, followed_artists: artists.truncated,
      playlists: listed.truncated, playlist_items: truncatedPlaylistItems },
    skipped_playlists: skippedPlaylists,
  };
}

function digestOf(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function projectSpotifyLibrarySnapshot({ subjectId, snapshot, capturedAt = new Date().toISOString() } = {}) {
  if (!isUuid(subjectId)) throw new TypeError("A trusted subject ID is required.");
  subjectId = subjectId.toLowerCase();
  capturedAt = new Date(capturedAt).toISOString();
  // An identical library is the same import, so a repeated sync changes nothing.
  const content = JSON.stringify({ format: SPOTIFY_LIBRARY_FORMAT, ...snapshot });
  const digest = digestOf(content);
  const size = Buffer.byteLength(content);
  const profileImportId = uuidV5(`${subjectId}\0${digest}\0${SPOTIFY_LIBRARY_FORMAT}`, IMPORT_NAMESPACE);
  const tracks = new Map();
  const evidence = [];
  const notAfterCapture = value => (value && value <= capturedAt ? value : capturedAt);
  const addTrack = item => {
    const artist = clip(item.artists.join(", "));
    const ref = spotifyResolvedTrackRef({ id: item.id, title: item.name, artist, album: item.album, observedAt: capturedAt });
    if (!tracks.has(ref.track_ref_id)) tracks.set(ref.track_ref_id, ref);
    return { entity_type: "track", entity_ref_id: ref.track_ref_id, track_ref_id: ref.track_ref_id, track_ref_revision: 1,
      label: item.name, artist_credit: artist, ...(item.album ? { release: item.album } : {}) };
  };
  const add = ({ kind, logicalKey, strength, entity, member, observedAt = capturedAt, attributes = {} }) => {
    const evidenceKey = spotifyProfileEvidenceKey(subjectId, kind, logicalKey);
    evidence.push({
      schema_version: 1, profile_evidence_id: uuidV5(`${digest}\0${evidenceKey}`, EVIDENCE_NAMESPACE),
      evidence_key: evidenceKey, subject_id: subjectId, evidence_kind: kind, direction: "supports",
      strength_class: strength, entity, observed_at: notAfterCapture(observedAt), attributes,
      provenance: { source_kind: "import", source_system: SPOTIFY_LIBRARY_SYSTEM, source_member: member,
        captured_at: capturedAt, profile_import_id: profileImportId },
    });
  };
  for (const [index, item] of snapshot.saved_tracks.entries()) {
    add({ kind: "library_track_saved", logicalKey: `saved-track\0${item.id}`, strength: "explicit", entity: addTrack(item),
      member: "saved_tracks", observedAt: item.added_at, attributes: { source_position: index + 1 } });
  }
  for (const [index, item] of snapshot.saved_albums.entries()) {
    add({ kind: "library_album_saved", logicalKey: `saved-album\0${item.id}`, strength: "explicit", member: "saved_albums",
      entity: { entity_type: "album", entity_ref_id: spotifyEntityRefId("album", item.id), label: item.name,
        ...(item.artists.length ? { artist_credit: clip(item.artists.join(", ")) } : {}) },
      observedAt: item.added_at, attributes: { source_position: index + 1 } });
  }
  for (const [index, item] of snapshot.followed_artists.entries()) {
    add({ kind: "library_artist_followed", logicalKey: `followed-artist\0${item.id}`, strength: "explicit", member: "followed_artists",
      entity: { entity_type: "artist", entity_ref_id: spotifyEntityRefId("artist", item.id), label: item.name },
      attributes: { source_position: index + 1 } });
  }
  for (const playlist of snapshot.playlists) {
    const playlistRef = spotifyEntityRefId("playlist", playlist.id);
    for (const item of playlist.tracks) {
      add({ kind: "playlist_track_added", logicalKey: `playlist-track\0${playlistRef}\0${item.id}\0${item.position}`,
        strength: "curated", entity: addTrack(item), member: "playlists", observedAt: item.added_at,
        attributes: { playlist_ref_id: playlistRef, playlist_name: playlist.name, playlist_position: item.position } });
    }
  }
  for (const [timeRange, period] of Object.entries(TOP_PERIODS)) {
    for (const item of snapshot.top_artists[timeRange] ?? []) {
      add({ kind: "top_artist_ranked", logicalKey: `top-artist\0${timeRange}\0${item.id ?? item.name}`, strength: "provider_derived",
        member: "top_items", entity: { entity_type: "artist",
          entity_ref_id: item.id ? spotifyEntityRefId("artist", item.id) : uuidV5(`artist\0${item.name}`, EVIDENCE_NAMESPACE), label: item.name },
        attributes: { rank: item.rank, period, time_range: timeRange } });
    }
    for (const item of snapshot.top_tracks[timeRange] ?? []) {
      add({ kind: "top_track_ranked", logicalKey: `top-track\0${timeRange}\0${item.id}`, strength: "provider_derived",
        member: "top_items", entity: addTrack(item), attributes: { rank: item.rank, period, time_range: timeRange } });
    }
  }
  if (!evidence.length) throw new Error("Your Spotify library looks empty, so there is nothing to import yet.");
  const manifest = { subject_id: subjectId, source_format: SPOTIFY_LIBRARY_FORMAT, archive_sha256: digest,
    archive_size_bytes: size, member_names: MEMBERS, imported_at: capturedAt };
  const unique = values => new Set(values).size;
  return {
    bundle: {
      source_key: SPOTIFY_LIBRARY_SOURCE, captured_at: capturedAt, cursor_after_ms: null,
      track_refs: [...tracks.values()], listening_events: [],
      import_batch: { ...manifest, import_batch_id: uuidV5(`${subjectId}\0${digest}`, BATCH_NAMESPACE),
        data_scope: "account_library_snapshot", input_records: 0, earliest_occurred_at: null, latest_occurred_at: null },
      profile_import: { ...manifest, profile_import_id: profileImportId, source_key: SPOTIFY_LIBRARY_SOURCE, input_records: evidence.length },
      profile_evidence: evidence,
    },
    preview: {
      kind: "spotify-library", sourceLabel: "Your Spotify library", capturedAt,
      savedTracks: snapshot.saved_tracks.length, savedAlbums: snapshot.saved_albums.length,
      followedArtists: snapshot.followed_artists.length, playlists: snapshot.playlists.length,
      playlistTracks: snapshot.playlists.reduce((sum, playlist) => sum + playlist.tracks.length, 0),
      topArtists: unique(Object.values(snapshot.top_artists).flat().map(item => item.id ?? item.name)),
      topTracks: unique(Object.values(snapshot.top_tracks).flat().map(item => item.id)),
      tracks: tracks.size, profileEvidence: evidence.length,
      truncated: Object.entries(snapshot.truncated ?? {}).filter(([, value]) => value).map(([key]) => key),
      skippedPlaylists: snapshot.skipped_playlists ?? 0,
      scopeNote: "What you keep and follow, your own playlists, and the artists and tracks Spotify ranks highest for you. It shows what you keep, not every play.",
    },
  };
}
