import assert from "node:assert/strict";
import test from "node:test";
import { openLibraryStore } from "../../src/core/library-store.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { parsePlaylistLink, readApplePlaylist } from "../../src/integrations/playlist-links.mjs";

test("playlist links are recognized by service, and anything else is refused", () => {
  assert.deepEqual(parsePlaylistLink("listen https://open.spotify.com/intl-de/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc"),
    { provider: "spotify", id: "37i9dQZF1DXcBWIGoYBM5M", url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M" });
  assert.equal(parsePlaylistLink("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M").provider, "spotify");
  assert.deepEqual(parsePlaylistLink("https://music.apple.com/jp/playlist/night/pl.u-abc123XYZ?l=en"),
    { provider: "apple_music", id: "pl.u-abc123XYZ", storefront: "jp", url: "https://music.apple.com/jp/playlist/pl.u-abc123XYZ" });
  assert.equal(parsePlaylistLink("https://music.163.com/#/playlist?id=123").provider, "public");
  assert.throws(() => parsePlaylistLink("https://open.spotify.com/album/1A2B3C4D5E6F7G8H9I0J"), { code: "playlist_link_unsupported" });
  assert.throws(() => parsePlaylistLink("https://example.com/playlist/1"), { code: "playlist_link_unsupported" });
  assert.throws(() => parsePlaylistLink("two links https://a.example https://b.example"), { code: "playlist_link_missing" });
});

const lockup = (id, title, artist) => ({ id: `track-lockup - ${id}`, title, artistName: artist, contentDescriptor: { kind: "song", identifiers: { storeAdamID: id } },
  artwork: { dictionary: { url: `https://is1-ssl.mzstatic.com/image/thumb/${id}/{w}x{h}bb.{f}` } } });
const applePage = (tracks, { total = tracks.length } = {}) => `<html><head><meta property="og:title" content="Fallback name">
<script id=schema:music-playlist type="application/ld+json">${JSON.stringify({ "@type": "MusicPlaylist", name: "Late Window", numTracks: total })}</script>
<script type="application/json" id="serialized-server-data">${JSON.stringify({ data: [{ data: { sections: [{ items: tracks }, { items: [tracks[0]] }] } }] })}</script></head></html>`;
const respond = (html, url = "https://music.apple.com/us/playlist/pl.u-1") => async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } });

test("an Apple Music playlist page gives its name, its total and each song once, with its catalog id and cover", async () => {
  const link = parsePlaylistLink("https://music.apple.com/us/playlist/late-window/pl.u-1abcdefg");
  const page = applePage([lockup("11", "Pink Moon", "Nick Drake"), lockup("12", "Road", "Nick Drake")], { total: 80 });
  const playlist = await readApplePlaylist(link, { fetchImpl: respond(page) });
  assert.deepEqual([playlist.name, playlist.total, playlist.tracks.length], ["Late Window", 80, 2]);
  assert.deepEqual(playlist.tracks[0], { id: "11", title: "Pink Moon", artist: "Nick Drake", artwork: "https://is1-ssl.mzstatic.com/image/thumb/11/300x300bb.jpg" });
  await assert.rejects(readApplePlaylist(link, { fetchImpl: respond("<html></html>") }), { code: "playlist_unavailable" });
});

test("a Spotify playlist imports as a copy; one the listener made shapes their taste unless they say no", async () => {
  const libraryStore = await openLibraryStore({ databasePath: ":memory:" });
  const tasted = [];
  const application = new MoondogApplication({ libraryStore, playlistTaste: async (found) => { tasted.push(found.id); return { state: "ready" }; } });
  const playlists = {
    mine: { name: "Night drive", owned: true, tracks_total: 2, tracks: [
      { type: "track", uri: "spotify:track:a", name: "Pink Moon", artists: ["Nick Drake"], isrc: "GBAAA0000001" },
      { type: "track", uri: "spotify:track:b", name: "Road", artists: ["Nick Drake"] }] },
    theirs: { name: "Today's Top Hits", owned: false, tracks_total: 50, tracks: [{ type: "track", uri: "spotify:track:c", name: "Hit", artists: ["Star"] }] },
  };
  application.spotifyReady = () => true;
  application.requireSpotifyService = () => ({ readPlaylist: async ({ playlistId }) => playlists[playlistId === "MINE00000000" ? "mine" : "theirs"] });

  const preview = await application.previewPlaylistLink({ link: "https://open.spotify.com/playlist/MINE00000000" });
  assert.deepEqual([preview.name, preview.read, preview.owned, preview.sample[0]], ["Night drive", 2, true, "Pink Moon - Nick Drake"]);
  const mine = await application.importPlaylistLink({ token: preview.token });
  assert.deepEqual([mine.added, mine.taste], [2, "added"]);
  const kept = libraryStore.playlist(mine.playlist.id);
  assert.deepEqual([kept.origin, kept.source.url, kept.entries[0].refs.spotify_uri, kept.entries[0].isrc], ["spotify", "https://open.spotify.com/playlist/MINE00000000", "spotify:track:a", "GBAAA0000001"]);
  // A preview imports once.
  await assert.rejects(application.importPlaylistLink({ token: preview.token }), { code: "playlist_preview_gone" });

  // Someone else's playlist is kept but shapes nothing, unless the listener says so.
  const theirs = await application.importPlaylistFromLink({ link: "https://open.spotify.com/playlist/THEIRS000000" });
  assert.deepEqual([theirs.taste, theirs.total, theirs.owned], ["not_added", 50, false]);
  const asked = await application.importPlaylistFromLink({ link: "https://open.spotify.com/playlist/THEIRS000000", taste: true });
  assert.equal(asked.taste, "added");
  assert.deepEqual(tasted, ["MINE00000000", "THEIRS000000"]);

  // Without Spotify connected, a Spotify link says so.
  application.spotifyReady = () => false;
  await assert.rejects(application.previewPlaylistLink({ link: "spotify:playlist:MINE00000000" }), { code: "spotify_not_ready" });
  application.close();
});
