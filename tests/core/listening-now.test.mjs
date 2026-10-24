import assert from "node:assert/strict";
import test from "node:test";
import { activeListening, readListeningNow } from "../../src/core/listening-now.mjs";

const song = { title: "S", artists: ["A"] };

test("a player that plays wins over a paused one, then the chosen service, then Apple Music, Spotify, NetEase", () => {
  const apple = { service: "apple_music", state: "playing", song };
  const spotify = { service: "spotify", state: "playing", song };
  const pausedSpotify = { ...spotify, state: "paused" };
  assert.equal(activeListening([pausedSpotify, apple], "spotify"), apple);
  assert.equal(activeListening([apple, spotify], "spotify"), spotify);
  assert.equal(activeListening([apple, spotify], "netease"), apple);
  assert.equal(activeListening([{ ...apple, state: "paused" }, pausedSpotify], "apple_music").service, "apple_music");
  assert.equal(activeListening([{ service: "spotify", state: "stopped" }], "spotify"), null);
});

test("the Music app's playlist and Spotify's active device are read together, the one heard first", async () => {
  const application = {
    playbackService: "spotify",
    musicApp: {
      available: true,
      async nowPlaying() {
        return { state: "playing", song: { id: "1", title: "Here", artists: ["M"], album: null, duration_ms: 1000 }, position_ms: 0, shuffle: true, repeat: "off",
          playlist: { id: "P", name: "Evening", library: false, tracks_total: 2, position: 2, first_position: 1,
            tracks: [{ title: "Before", artists: ["M"] }, { title: "Here", artists: ["M"] }] } };
      },
    },
    spotifyReady: () => true,
    neteaseReady: () => false,
    async spotifyNowPlaying() {
      return { state: "available", is_playing: false, progress_ms: 0, device: { name: "Phone", type: "Smartphone" }, context: { type: "playlist", uri: "spotify:playlist:x" },
        item: { name: "Paused", artists: ["S"], track_ref_id: "r1" } };
    },
    async spotifyQueueStatus() { return { queue: [{ name: "Later", artists: ["S"], track_ref_id: "r2" }] }; },
    requireSpotifyService: () => ({ async playingPlaylist() { throw new Error("Spotify answered not found."); } }),
  };
  const result = await readListeningNow(application);
  assert.equal(result.active, "apple_music");
  assert.deepEqual(result.sources.map((source) => source.service), ["apple_music", "spotify"]);
  assert.equal(result.sources[0].from.name, "Evening");
  assert.equal(result.sources[0].from.position, 2);
  assert.equal(result.sources[0].shuffle, true);
  const spotify = result.sources[1];
  assert.equal(spotify.player, "Spotify on Phone");
  assert.equal(spotify.song.track_ref_id, "r1");
  assert.equal(spotify.next[0].title, "Later");
  assert.equal(spotify.from.kind, "playlist");
  assert.match(spotify.from.unavailable, /not found/u);
});
