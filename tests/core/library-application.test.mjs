import assert from "node:assert/strict";
import test from "node:test";
import { openLibraryStore } from "../../src/core/library-store.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createPlayerNow } from "../../src/core/listening-now.mjs";

const MADE = "0b7c6f1e-2a3d-4c5e-8f90-1a2b3c4d5e6f";

// Moondog's own player, as the window's: it keeps what it was asked to play.
function ownPlayer() {
  const now = createPlayerNow();
  const played = [];
  return {
    played,
    play(tracks) { now.queued(tracks); },
    playList(tracks) { played.push(tracks); now.queued(tracks); },
    playGenerated() {},
    nowPlaying: () => now.read(),
    wholeSongs: () => true,
    holdsCatalogSongs: () => false,
    stop() { now.clear(); return true; },
  };
}
const generator = {
  ready: () => true,
  receipt: async (id) => (id === MADE ? { title: "Tide glass" } : null),
  trackFile: async (id) => (id === MADE ? "/tmp/made/track.wav" : null),
};
const catalog = {
  findPreview: async ({ title, artist }) => ({ state: "resolved", track: { title, artist_credit: artist, catalog_id: `id-${title}`,
    preview_url: "https://audio-ssl.itunes.apple.com/a.m4a", catalog_url: `https://music.apple.com/us/song/${encodeURIComponent(title)}?i=1`,
    artwork_url: "https://is1-ssl.mzstatic.com/a/100x100bb.jpg" } }),
};

test("the library keeps what plays now and plays songs and made tracks as one queue", async () => {
  const libraryStore = await openLibraryStore({ databasePath: ":memory:" });
  const player = ownPlayer();
  const application = new MoondogApplication({ libraryStore, musicPreviewPlayer: player, localGenerator: generator, musicCatalog: catalog,
    playbackService: "apple_music" });
  application.requireListenerAvoids = () => {};
  application.avoidAllows = () => true;

  // A made track playing in Moondog's player is kept by its id, and its audio with it.
  player.play([{ title: "Tide glass", generated: true, id: MADE }]);
  const kept = await application.saveToLibrary({ from: "now_playing" });
  assert.deepEqual([kept.playlist.saved, kept.added], [true, 1]);
  assert.equal(libraryStore.holdsMade(MADE), true);

  // A song and what follows it make a new playlist by name.
  player.play([{ title: "Pink Moon", artist_credit: "Nick Drake" }, { title: "Road", artist_credit: "Nick Drake" }]);
  const set = await application.saveToLibrary({ from: "queue", playlistName: "Night drive" });
  assert.equal(set.playlist.created, true);
  libraryStore.addEntries(set.playlist.id, [{ kind: "made", id: MADE, title: "Tide glass" }]);
  assert.deepEqual(application.findLibraryPlaylists("night").map((playlist) => playlist.name), ["Night drive"]);

  const played = await application.playLibrary({ playlistId: set.playlist.id });
  assert.equal(played.state, "playing");
  assert.deepEqual(player.played.at(-1).map((track) => track.title), ["Pink Moon", "Road", "Tide glass"]);
  assert.equal(player.played.at(-1)[2].generated, true);
  // The catalog's ids and covers stay on the entries, for the next play and for the window.
  assert.equal(libraryStore.playlist(set.playlist.id).entries[0].refs.apple_music_id, "id-Pink Moon");

  // With Spotify chosen the songs go to Spotify, which must be ready; nothing falls back to previews unasked.
  const onSpotify = new MoondogApplication({ libraryStore, musicPreviewPlayer: player, localGenerator: generator, musicCatalog: catalog,
    playbackService: "spotify", ownsServices: false });
  onSpotify.avoidAllows = () => true;
  assert.equal(onSpotify.playbackService, "spotify");
  await assert.rejects(onSpotify.playLibrary({ playlistId: set.playlist.id }), { code: "spotify_not_ready" });
  // Ready, it plays the songs by the URIs the host kept for the matches, remembers them, and leaves the made track out.
  const resumed = [];
  onSpotify.spotifyPlaybackReady = () => true;
  onSpotify.quietOtherPlayers = async () => {};
  onSpotify.spotifyResolveSongs = async ([wanted]) => ({ matched: [{ item_ref_id: `ref-${wanted.title}`, name: wanted.title }], unmatched: [] });
  onSpotify.spotifyHostReadItems = () => ["Pink Moon", "Road"].map((title, index) => ({ item_ref_id: `ref-${title}`, uri: `spotify:track:${index}`, type: "track", name: title, artists: ["Nick Drake"] }));
  onSpotify.requireSpotifyService = () => ({ resume: async (parameters) => { resumed.push(parameters.uris); return { state: "accepted" }; } });
  const onAir = await onSpotify.playLibrary({ playlistId: set.playlist.id });
  assert.deepEqual([onAir.state, onAir.playing, onAir.left_out_made, onAir.not_found], ["playing", 2, 1, 0]);
  assert.deepEqual(resumed, [["spotify:track:0", "spotify:track:1"]]);
  assert.equal(libraryStore.playlist(set.playlist.id).entries[1].refs.spotify_uri, "spotify:track:1");
  // A playlist of made tracks alone plays in Moondog's own player under any service.
  const madeOnly = libraryStore.savePlaylist({ name: "Cut for me", entries: [{ kind: "made", id: MADE, title: "Tide glass" }] });
  assert.equal((await onSpotify.playLibrary({ playlistId: madeOnly.id })).player, "moondog");
  onSpotify.close();
  application.close();
});

test("the agent's library tools appear only with a library", async () => {
  const without = new MoondogApplication({});
  assert.ok(!without.agentCapabilityDescriptors().some((descriptor) => descriptor.tool_name.startsWith("moondog_collection_")));
  const libraryStore = await openLibraryStore({ databasePath: ":memory:" });
  const withLibrary = new MoondogApplication({ libraryStore });
  assert.deepEqual(withLibrary.agentCapabilityDescriptors().filter((descriptor) => descriptor.tool_name.startsWith("moondog_collection_"))
    .map((descriptor) => descriptor.tool_name).sort(), ["moondog_collection_list", "moondog_collection_play", "moondog_collection_save"]);
  withLibrary.close();
  without.close();
});
