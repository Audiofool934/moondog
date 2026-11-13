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

test("Moondog's own player is read first, with what it queued and the tracks it made", async () => {
  const { createPlayerNow } = await import("../../src/core/listening-now.mjs");
  const now = createPlayerNow();
  now.queued([{ title: "Us and Them", artist_credit: "Pink Floyd" }, { title: "Space Song", artist_credit: "Beach House" }, { title: "Alison", artist_credit: "Slowdive" }]);
  now.observe({ type: "playing", position: 2 });
  const application = {
    playbackService: "apple_music",
    musicPreviewPlayer: { nowPlaying: () => now.read() },
    musicApp: { available: true, async nowPlaying() { return { state: "paused", song: { title: "Hey Jude", artists: ["The Beatles"] }, position_ms: 61_000 }; } },
    spotifyReady: () => false,
    neteaseReady: () => false,
    streamView: () => null,
  };
  let result = await readListeningNow(application);
  assert.equal(result.active, "moondog");
  assert.deepEqual(result.sources[0].song, { title: "Space Song", artists: ["Beach House"] });
  assert.deepEqual(result.sources[0].from, { kind: "moondog_queue", name: null, tracks_total: 3, position: 2 });
  assert.deepEqual(result.sources[0].next.map((song) => song.title), ["Alison"]);
  // A paused Moondog queue still comes before a paused Music app.
  now.observe({ type: "paused", position: 2 });
  assert.equal((await readListeningNow(application)).active, "moondog");
  // A stream's tracks are Moondog's own.
  now.queued([{ title: "Night Tape · 1", generated: true }]);
  now.appended({ title: "Night Tape · 2", generated: true });
  application.streamView = () => ({ phase: "playing" });
  result = await readListeningNow(application);
  assert.equal(result.sources[0].from.kind, "moondog_stream");
  assert.deepEqual(result.sources[0].song.artists, ["Moondog"]);
  assert.equal(result.sources[0].next[0].title, "Night Tape · 2");
  // Once the queue stops, the Music app is what they hear.
  now.observe({ type: "stopped" });
  result = await readListeningNow(application);
  assert.equal(result.active, "apple_music");
  assert.equal(result.sources.find((source) => source.service === "moondog").state, "stopped");
});

test("a song taken out of Up next leaves what the agent reads, and the player's positions still match", async () => {
  const { createPlayerNow } = await import("../../src/core/listening-now.mjs");
  const now = createPlayerNow();
  now.queued([{ title: "One", artist_credit: "A" }, { title: "Two", artist_credit: "B" }, { title: "Three", artist_credit: "C" }]);
  now.observe({ type: "playing", position: 1 });
  now.observe({ type: "removed", position: 1 });
  now.observe({ type: "removed", position: 2 });
  assert.deepEqual(now.read().next.map((track) => track.title), ["Three"]);
  assert.deepEqual(now.remaining().map((track) => track.title), ["One", "Three"]);
  now.observe({ type: "playing", position: 3 });
  assert.equal(now.read().song.title, "Three");
});
