import assert from "node:assert/strict";
import test from "node:test";
import { openLibraryStore } from "../../src/core/library-store.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { parsePlaylistLink, readApplePlaylist } from "../../src/integrations/playlist-links.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";

test("a Spotify playlist reads its catalog songs and whether the listener owns it, leaving local files out", async () => {
  const song = (id, name) => ({ is_local: false, item: { type: "track", uri: `spotify:track:${id}`, name, artists: ["Nick Drake"] } });
  const client = {
    getPlaylist: async () => ({ name: "Night drive", uri: "spotify:playlist:MINE00000000", owner_id: "me", tracks_total: 3 }),
    getPlaylistItems: async () => ({ items: [song("a", "Pink Moon"), { is_local: true, item: { type: "track", uri: "spotify:local:x:y:z:1", name: "Demo", artists: ["Me"] } }, song("b", "Road")], has_more: false }),
    getAccount: async () => ({ account_id: "me" }),
  };
  const read = await createSpotifyService({ client }).readPlaylist({ playlistId: "MINE00000000" });
  assert.deepEqual([read.owned, read.tracks_total, read.tracks.map((track) => track.uri)], [true, 3, ["spotify:track:a", "spotify:track:b"]]);
});

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

test("a NetEase playlist reads every song, in its order, when the playlist answer details only the first", async () => {
  const song = (id, name) => ({ id, name, artists: [{ name: "求导乐队" }], album: { name: "圈中乐园", picUrl: `http://p2.music.126.net/${id}.jpg` } });
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(new URL(url).pathname);
    if (url.includes("/api/v6/playlist/detail")) return new Response(JSON.stringify({ code: 200, playlist: { id: 1983017976, name: "Audiofool喜欢的音乐", privacy: 0, trackCount: 3,
      trackIds: [{ id: 11 }, { id: 12 }, { id: 13 }], tracks: [song(11, "First")] } }));
    // song/detail answers in its own order; the playlist's order is restored.
    if (url.includes("/api/song/detail")) return new Response(JSON.stringify({ code: 200, songs: [song(13, "Third"), song(12, "Second")] }));
    return new Response("{}", { status: 404 });
  };
  const { readPublicPlaylistLink } = await import("../../src/integrations/playlist-links.mjs");
  const playlist = await readPublicPlaylistLink({ url: "https://music.163.com/#/playlist?id=1983017976" }, { fetchImpl });
  assert.deepEqual([playlist.name, playlist.total, playlist.tracks.map((track) => track.title)], ["Audiofool喜欢的音乐", 3, ["First", "Second", "Third"]]);
  assert.equal(playlist.tracks[1].artwork, "https://p2.music.126.net/12.jpg");
  assert.deepEqual(asked, ["/api/v6/playlist/detail", "/api/song/detail/"]);
  // A private one says so, with a kind the window can name.
  const closed = async () => new Response(JSON.stringify({ code: 200, playlist: { id: 5, name: "Mine", privacy: 10, trackIds: [] } }));
  await assert.rejects(readPublicPlaylistLink({ url: "https://music.163.com/#/playlist?id=5" }, { fetchImpl: closed }), { code: "playlist_unavailable" });
});

test("a Spotify playlist imports as a copy; one the listener made shapes their taste unless they say no", async () => {
  const libraryStore = await openLibraryStore({ databasePath: ":memory:" });
  const tasted = [];
  const application = new MoondogApplication({ libraryStore, playlistTaste: async (found) => { tasted.push(found.id); return { state: "ready" }; } });
  const playlists = {
    mine: { name: "Night drive", owned: true, tracks_total: 2, tracks: [
      { type: "track", uri: "spotify:track:a", name: "Pink Moon", artists: ["Nick Drake"], isrc: "GBAAA0000001", image: "https://i.scdn.co/image/ab67616d0000b273aaaa" },
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
  // Each song keeps its album cover, so the playlist and its rows show it as an Apple Music import does.
  assert.equal(kept.entries[0].refs.artwork_url, "https://i.scdn.co/image/ab67616d0000b273aaaa");
  assert.deepEqual(libraryStore.view().playlists.find((playlist) => playlist.id === mine.playlist.id).cover, { artwork_url: "https://i.scdn.co/image/ab67616d0000b273aaaa" });
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
