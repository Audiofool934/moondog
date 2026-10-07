import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { readSpotifyLibrarySnapshot } from "../../src/integrations/spotify/library-snapshot.mjs";
import { createSpotifyWebApiClient } from "../../src/integrations/spotify/web-api-client.mjs";
import { commitSpotifyQuickImport, prepareSpotifyQuickImport } from "../../src/profile/history-import.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { runSpotifyCommand } from "../../src/surfaces/cli/spotify-command.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
// Spotify IDs are 22 characters; every name and ID here is fictional.
const id = (prefix, index) => `${prefix}${String(index).padStart(22 - prefix.length, "0")}`;
const rawTrack = (index, artist = `Fictional Artist ${index % 3}`) => ({ id: id("trk", index), uri: `spotify:track:${id("trk", index)}`,
  name: `Fictional Song ${index}`, artists: [{ name: artist }], album: { name: `Fictional Album ${index % 4}` }, duration_ms: 200_000 });
const rawArtist = index => ({ uri: `spotify:artist:${id("art", index)}`, name: `Fictional Artist ${index}` });

function fakeSpotify(library) {
  const reads = [];
  const page = (items, url, extra = {}) => {
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 20);
    return Response.json({ items: items.slice(offset, offset + limit), offset, limit, total: items.length,
      next: offset + limit < items.length ? "more" : null, ...extra });
  };
  const fetchImpl = async (value) => {
    const url = new URL(value);
    reads.push(url.pathname);
    if (url.pathname === "/v1/me") return Response.json({ id: "fictional-listener", display_name: "Fictional Listener" });
    if (url.pathname === "/v1/me/tracks") return page(library.saved.map(index => ({ added_at: "2026-01-02T00:00:00Z", track: rawTrack(index) })), url);
    if (url.pathname === "/v1/me/albums") return page([{ added_at: "2026-01-03T00:00:00Z",
      album: { uri: `spotify:album:${id("alb", 1)}`, name: "Fictional Album 1", artists: [{ name: "Fictional Artist 1" }] } }], url);
    if (url.pathname === "/v1/me/following") return Response.json({ artists: { items: library.followed.map(rawArtist), next: null, cursors: { after: null } } });
    if (url.pathname === "/v1/me/playlists") return page([
      { id: "ownplaylist", uri: "spotify:playlist:ownplaylist", name: "Fictional Mix", owner: { id: "fictional-listener" } },
      { id: "theirplaylist", uri: "spotify:playlist:theirplaylist", name: "Someone Else's Mix", owner: { id: "someone-else" } },
      { id: "brokenplaylist", uri: "spotify:playlist:brokenplaylist", name: "Unreadable", owner: { id: "fictional-listener" } },
    ], url);
    if (url.pathname === "/v1/playlists/ownplaylist/items") return page([7, 8].map(index => ({ added_at: "2026-02-01T00:00:00Z", item: { type: "track", ...rawTrack(index) } })), url);
    if (url.pathname === "/v1/playlists/brokenplaylist/items") return Response.json({ error: { status: 404, message: "Fictional missing" } }, { status: 404 });
    if (url.pathname === "/v1/me/top/artists") return page(url.searchParams.get("time_range") === "short_term" ? [rawArtist(9), rawArtist(1)] : [rawArtist(1)], url);
    if (url.pathname === "/v1/me/top/tracks") return page([rawTrack(1)], url);
    if (url.pathname === "/v1/me/player/recently-played") return Response.json({ items: [] });
    throw new Error(`Unexpected fictional route ${url.pathname}`);
  };
  return { client: createSpotifyWebApiClient({ tokenProvider: async () => "FICTIONAL_TOKEN", fetchImpl }), reads };
}

async function storeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-spotify-library-"));
  const store = await openListeningHistoryStore({ databasePath: path.join(root, "history.sqlite") });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.localSubjectId({ preferredSubjectId: subjectId, create: true });
  return store;
}

// Fresh services read the store as the TUI does after an import; the store closes with the fixture.
const summary = store => createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId }).getProfileSummary();

test("a library snapshot pages every source, keeps only the listener's own playlists and skips an unreadable one", async () => {
  const { client } = fakeSpotify({ saved: Array.from({ length: 120 }, (_, index) => index), followed: [1, 2] });
  const stages = new Set();
  const snapshot = await readSpotifyLibrarySnapshot(client, { onProgress: ({ stage }) => stages.add(stage) });
  assert.equal(snapshot.saved_tracks.length, 120);
  assert.equal(snapshot.saved_albums.length, 1);
  assert.deepEqual(snapshot.followed_artists.map(artist => artist.name), ["Fictional Artist 1", "Fictional Artist 2"]);
  assert.deepEqual(snapshot.playlists.map(playlist => [playlist.name, playlist.tracks.length]), [["Fictional Mix", 2]]);
  assert.equal(snapshot.skipped_playlists, 1);
  assert.deepEqual(snapshot.top_artists.short_term.map(artist => [artist.name, artist.rank]), [["Fictional Artist 9", 1], ["Fictional Artist 1", 2]]);
  assert.deepEqual([...stages].sort(), ["followed_artists", "playlist_items", "playlists", "saved_albums", "saved_tracks", "top_items"]);
});

test("quick import saves library and recent plays together, an identical re-sync changes nothing, and a newer snapshot replaces the old one", async (t) => {
  const store = await storeFixture(t);
  const first = fakeSpotify({ saved: [1, 2, 3], followed: [1, 2] });
  const snapshot = await readSpotifyLibrarySnapshot(first.client);
  // No recent plays at all still imports the library.
  const prepared = prepareSpotifyQuickImport({ page: { provider: "spotify", items: [] }, librarySnapshot: snapshot, subjectId, capturedAt: "2026-09-01T00:00:00.000Z" });
  assert.equal(prepared.preview.kind, "spotify-quick");
  assert.equal(prepared.preview.library.savedTracks, 3);
  assert.equal(prepared.preview.library.topArtists, 2);
  const receipt = commitSpotifyQuickImport(store, prepared);
  assert.ok(receipt.inserted_profile_evidence > 0);
  let profile = await summary(store);
  assert.equal(profile.coverage.spotify_saved_tracks, 3);
  assert.equal(profile.coverage.spotify_followed_artists, 2);

  const again = prepareSpotifyQuickImport({ page: { provider: "spotify", items: [] }, librarySnapshot: snapshot, subjectId, capturedAt: "2026-09-02T00:00:00.000Z" });
  assert.equal(commitSpotifyQuickImport(store, again).library_already_imported, true);

  // The listener unsaved a song and unfollowed an artist since the first read.
  const later = await readSpotifyLibrarySnapshot(fakeSpotify({ saved: [1, 2], followed: [2] }).client);
  commitSpotifyQuickImport(store, prepareSpotifyQuickImport({ page: { provider: "spotify", items: [] }, librarySnapshot: later, subjectId, capturedAt: "2026-09-03T00:00:00.000Z" }));
  profile = await summary(store);
  assert.equal(profile.coverage.spotify_saved_tracks, 2);
  assert.equal(profile.coverage.spotify_followed_artists, 1);
});

test("sync-library stores the snapshot from the command line and reports what came in", async (t) => {
  const store = await storeFixture(t);
  const { client } = fakeSpotify({ saved: [1, 2, 3], followed: [1] });
  const { createSpotifyService } = await import("../../src/integrations/spotify/service.mjs");
  let output = "";
  const result = await runSpotifyCommand({ args: ["sync-library"], subjectId, recentActivityStore: store, now: () => Date.parse("2026-09-01T00:00:00Z"),
    spotify: { service: createSpotifyService({ client }) }, stdout: { write: value => { output += value; } } });
  assert.equal(result.preview.savedTracks, 3);
  assert.match(output, /Your Spotify library is in/u);
  assert.match(output, /3 saved songs, 1 saved albums, 1 followed artists/u);
  assert.match(output, /1 playlists couldn't be read/u);
});
