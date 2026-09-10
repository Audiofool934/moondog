import assert from "node:assert/strict";
import test from "node:test";

import { deriveArtistReleaseHintsFromSpotifyArchive } from "../../src/profile/spotify-archive-catalog-hints.mjs";

const subjectPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function track({ id, artist, release, createdAt = "2026-01-01T00:00:00.000Z" }) {
  return {
    track_ref_id: id,
    artist_credits: [{ name: artist }],
    ...(release ? { release: { title: release } } : {}),
    created_at: createdAt,
  };
}

function event({ id, trackId, occurredAt, playedMs = 180_000 }) {
  return {
    listening_event_id: id,
    track_ref_id: trackId,
    occurred_at: occurredAt,
    played_ms: playedMs,
  };
}

test("Spotify history derives bounded exact-artist release hints in evidence order", async () => {
  const calls = [];
  const result = await deriveArtistReleaseHintsFromSpotifyArchive({
    archivePath: "/private/spotify-extended.zip",
    artistName: "刘森",
    capturedAt: "2026-09-03T06:00:00.000Z",
    maximumHints: 2,
    historyArchiveImporter: async (input) => {
      calls.push(input);
      return {
        import_batch: {
          source_format: "spotify_extended_streaming_history_music_v1",
        },
        track_refs: [
          track({ id: "track-a", artist: "刘森", release: "华北浪革" }),
          track({ id: "track-b", artist: " 刘森 ", release: "华北浪革" }),
          track({ id: "track-c", artist: "刘森", release: "山神庙" }),
          track({ id: "track-d", artist: "另一位", release: "Private Album" }),
          track({ id: "track-e", artist: "刘森" }),
        ],
        listening_events: [
          event({ id: "event-a", trackId: "track-a", occurredAt: "2025-01-01T00:00:00.000Z" }),
          event({ id: "event-b", trackId: "track-b", occurredAt: "2025-02-01T00:00:00.000Z" }),
          event({ id: "event-c", trackId: "track-c", occurredAt: "2026-01-01T00:00:00.000Z" }),
          event({ id: "event-d", trackId: "track-d", occurredAt: "2026-02-01T00:00:00.000Z" }),
        ],
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].archivePath, "/private/spotify-extended.zip");
  assert.match(calls[0].subjectId, subjectPattern);
  assert.equal(calls[0].capturedAt, "2026-09-03T06:00:00.000Z");
  assert.deepEqual(result, {
    source_format: "spotify_extended_streaming_history_music_v1",
    exact_artist_track_count: 4,
    exact_artist_event_count: 3,
    release_titles: ["华北浪革", "山神庙"],
  });
  assert.equal(JSON.stringify(result).includes("Private Album"), false);
});

test("Spotify account profile tracks can provide a release hint without listening events", async () => {
  const result = await deriveArtistReleaseHintsFromSpotifyArchive({
    archivePath: "/private/spotify-account-data.zip",
    artistName: "Portishead",
    historyArchiveImporter: async () => ({
      import_batch: {
        source_format: "spotify_account_data_streaming_history_v1",
      },
      track_refs: [
        track({
          id: "track-a",
          artist: "Portishead",
        }),
        track({
          id: "track-a",
          artist: "PORTISHEAD",
          release: "Dummy",
          createdAt: "2025-07-01T00:00:00.000Z",
        }),
      ],
      listening_events: [],
    }),
  });

  assert.deepEqual(result.release_titles, ["Dummy"]);
  assert.equal(result.exact_artist_track_count, 1);
  assert.equal(result.exact_artist_event_count, 0);
});

test("Spotify archive hint derivation rejects malformed importer output", async () => {
  await assert.rejects(
    deriveArtistReleaseHintsFromSpotifyArchive({
      archivePath: "/private/history.zip",
      artistName: "刘森",
      historyArchiveImporter: async () => ({
        import_batch: { source_format: "unexpected" },
        track_refs: [],
        listening_events: [],
      }),
    }),
    /source format/u,
  );
});
