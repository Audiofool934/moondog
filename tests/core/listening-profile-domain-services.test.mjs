import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const capturedAt = "2026-09-02T06:00:00.000Z";

function extendedRecord(ts, msPlayed) {
  return {
    ts,
    ms_played: msPlayed,
    master_metadata_track_name: "Roads",
    master_metadata_album_artist_name: "Portishead",
    master_metadata_album_album_name: "Dummy",
    spotify_track_uri: "spotify:track:1234567890123456789012",
    reason_start: "clickrow",
    reason_end: "trackdone",
    shuffle: false,
    skipped: false,
    offline: false,
    incognito_mode: false,
  };
}

test("persistent listening history enables profile tools without pretending to be a library", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-spotify-profile-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  store.ingestImport(
    projectSpotifyExtendedStreamingHistory({
      subjectId,
      capturedAt,
      archiveSha256: "a".repeat(64),
      archiveSizeBytes: 4096,
      memberNames: ["Streaming_History_Audio_2026.json"],
      records: [
        extendedRecord("2026-08-30T04:00:00Z", 305_000),
        extendedRecord("2026-09-01T04:00:00Z", 300_000),
      ],
    }),
  );
  const application = new MoondogApplication({
    importsRoot: path.join(root, "no-apple-imports"),
    domainServices: createListeningProfileDomainServices({
      listeningHistoryStore: store,
      subjectId,
    }),
  });
  context.after(() => application.close());

  assert.equal(application.profileServicesReady(), true);
  assert.equal(application.domainServicesReady(), false);
  const capabilities = application.toolsStatus().capabilities;
  assert.equal(
    capabilities.find((item) => item.id === "profile.summary").state,
    "enabled",
  );
  assert.equal(
    capabilities.find((item) => item.id === "profile.explain").state,
    "enabled",
  );
  assert.equal(
    capabilities.find((item) => item.id === "library.search").state,
    "blocked",
  );
  assert.equal(
    capabilities.find((item) => item.id === "playlist.plan").state,
    "enabled",
  );

  const status = await application.profileStatus();
  const profile = await application.getProfileSummary({ maxItems: 4 });
  assert.equal(status.state, "ready");
  assert.equal(status.effective_listening_events, 2);
  assert.equal(
    profile.profile_version,
    "profile-projection/listening-history/1",
  );
  assert.equal(profile.coverage.effective_listening_events, 2);
  assert.deepEqual(status.listening_sources, ["spotify"]);
  assert.deepEqual(profile.listening_source.providers, ["spotify"]);
  assert.equal(profile.listening_behavior.repeat_tracks[0].label, "Roads");
  assert.match(profile.limitations[0], /provider-neutral/iu);

  const explanation = await application.explainProfileEvidence({
    evidenceId: profile.listening_behavior.repeat_tracks[0].evidence_id,
  });
  assert.equal(explanation.claim.dimension, "taste.track_familiarity");
});

test("Spotify-only history builds a private chronological Time Machine plan", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-history-time-machine-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  const record = ({ ts, title, artist, id }) => ({
    ts,
    ms_played: 180_000,
    master_metadata_track_name: title,
    master_metadata_album_artist_name: artist,
    master_metadata_album_album_name: `${title} Release`,
    spotify_track_uri: `spotify:track:${id}`,
    reason_start: "clickrow",
    reason_end: "trackdone",
    shuffle: false,
    skipped: false,
    offline: false,
    incognito_mode: false,
  });
  store.ingestImport(
    projectSpotifyExtendedStreamingHistory({
      subjectId,
      capturedAt,
      archiveSha256: "b".repeat(64),
      archiveSizeBytes: 4096,
      memberNames: ["Streaming_History_Audio_2026.json"],
      records: [
        record({
          ts: "2020-01-01T00:00:00Z",
          title: "First Landmark",
          artist: "Early Artist",
          id: "4uLU6hMCjMI75M1A2tKUQC",
        }),
        record({
          ts: "2020-02-01T00:00:00Z",
          title: "First Landmark",
          artist: "Early Artist",
          id: "4uLU6hMCjMI75M1A2tKUQC",
        }),
        record({
          ts: "2025-01-01T00:00:00Z",
          title: "Later Landmark",
          artist: "Later Artist",
          id: "1234567890123456789012",
        }),
        record({
          ts: "2025-02-01T00:00:00Z",
          title: "Later Landmark",
          artist: "Later Artist",
          id: "1234567890123456789012",
        }),
      ],
    }),
  );
  const services = createListeningProfileDomainServices({
    listeningHistoryStore: store,
    subjectId,
  });
  const application = new MoondogApplication({
    importsRoot: path.join(root, "no-apple-imports"),
    domainServices: services,
  });
  context.after(() => application.close());

  assert.equal(application.domainServicesReady(), false);
  assert.equal(application.playlistServicesReady(), true);
  assert.equal(application.timeCapsuleServicesReady(), true);
  assert.equal(
    application
      .toolsStatus()
      .capabilities.find((item) => item.id === "profile.time_capsule").state,
    "enabled",
  );

  application.beginPrompt();
  const candidates = await application.getTimeCapsuleCandidates({ limit: 2 });
  assert.deepEqual(candidates.represented_years, [2020, 2025]);
  assert.equal(
    candidates.tracks.some((track) => "external_refs" in track),
    false,
  );
  assert.doesNotMatch(JSON.stringify(candidates), /spotify:|4uLU6hMCjMI75M1A2tKUQC/u);
  const plan = await application.buildPlaylistPlan({
    intent: "Build a 2 track journey across my listening years.",
    requestedTrackCount: 2,
    candidateSetIds: [candidates.candidate_set_id],
    trackRefs: candidates.tracks.map((track) => ({
      trackRefId: track.track_ref_id,
      selectionReason: `${track.time_capsule.year} listening landmark.`,
    })),
    orderingNotes: "Chronological from earliest to latest.",
  });
  assert.deepEqual(
    plan.tracks.map((track) => track.history_context.year),
    [2020, 2025],
  );
  assert.equal(plan.external_effects, "none");
  application.endPrompt();
});

test("Spotify-only history builds a private historical-return plan", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-history-returns-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  const returningRecord = (ts) => ({
    ...extendedRecord(ts, 300_000),
    master_metadata_track_name: "Recurring Light",
    master_metadata_album_artist_name: "North Window",
    master_metadata_album_album_name: "Fictional Return",
    spotify_track_uri: "spotify:track:0VjIjW4GlUZAMYd2vXMi3b",
  });
  store.ingestImport(
    projectSpotifyExtendedStreamingHistory({
      subjectId,
      capturedAt,
      archiveSha256: "c".repeat(64),
      archiveSizeBytes: 4096,
      memberNames: ["Streaming_History_Audio_2026.json"],
      records: [
        returningRecord("2020-01-01T00:00:00Z"),
        returningRecord("2021-01-01T00:00:00Z"),
        returningRecord("2022-01-01T00:00:00Z"),
      ],
    }),
  );
  const application = new MoondogApplication({
    importsRoot: path.join(root, "no-apple-imports"),
    domainServices: createListeningProfileDomainServices({
      listeningHistoryStore: store,
      subjectId,
    }),
  });
  context.after(() => application.close());

  assert.equal(application.historicalReturnServicesReady(), true);
  assert.equal(
    application
      .toolsStatus()
      .capabilities.find((item) => item.id === "profile.historical_returns")
      .state,
    "enabled",
  );

  application.beginPrompt();
  const candidates = await application.getHistoricalReturnCandidates({
    limit: 1,
  });
  assert.equal(candidates.tracks[0].historical_return.return_count, 2);
  assert.equal(candidates.tracks[0].historical_return.longest_gap_days, 366);
  assert.equal("external_refs" in candidates.tracks[0], false);
  assert.doesNotMatch(
    JSON.stringify(candidates),
    /spotify:|0VjIjW4GlUZAMYd2vXMi3b/u,
  );
  const plan = await application.buildPlaylistPlan({
    intent: "Build a 1 track historical return path.",
    requestedTrackCount: 1,
    candidateSetIds: [candidates.candidate_set_id],
    trackRefs: [
      {
        trackRefId: candidates.tracks[0].track_ref_id,
        selectionReason: "It reappeared after multiple long gaps.",
      },
    ],
    orderingNotes: "One return stands alone.",
  });
  assert.deepEqual(plan.tracks[0].history_context, {
    kind: "historical_return",
  });
  const explanation = await application.explainProfileEvidence({
    evidenceId: candidates.tracks[0].historical_return.evidence_id,
  });
  assert.equal(explanation.claim.dimension, "listening.historical_return");
  application.endPrompt();
});

test("Spotify-only history builds a private played-back-to-back plan", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-history-back-to-back-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  const backToBackRecord = (ts) => ({
    ...extendedRecord(ts, 180_000),
    master_metadata_track_name: "Fictional Echo",
    master_metadata_album_artist_name: "Sequence Study",
    master_metadata_album_album_name: "Synthetic Playback",
    spotify_track_uri: "spotify:track:6rqhFgbbKwnb9MLmUQDhG6",
  });
  store.ingestImport(
    projectSpotifyExtendedStreamingHistory({
      subjectId,
      capturedAt,
      archiveSha256: "d".repeat(64),
      archiveSizeBytes: 4096,
      memberNames: ["Streaming_History_Audio_2026.json"],
      records: [
        backToBackRecord("2026-08-30T04:00:00Z"),
        backToBackRecord("2026-08-30T04:03:00Z"),
        backToBackRecord("2026-08-30T04:06:00Z"),
      ],
    }),
  );
  const application = new MoondogApplication({
    importsRoot: path.join(root, "no-apple-imports"),
    domainServices: createListeningProfileDomainServices({
      listeningHistoryStore: store,
      subjectId,
    }),
  });
  context.after(() => application.close());

  assert.equal(application.backToBackServicesReady(), true);
  assert.equal(
    application
      .toolsStatus()
      .capabilities.find((item) => item.id === "profile.back_to_back").state,
    "enabled",
  );

  application.beginPrompt();
  const candidates = await application.getBackToBackCandidates({ limit: 1 });
  assert.equal(candidates.minimum_consecutive_plays, 2);
  assert.equal(candidates.minimum_played_seconds, 30);
  assert.equal(candidates.maximum_gap_minutes, 30);
  assert.equal(candidates.tracks[0].back_to_back.burst_count, 1);
  assert.equal(candidates.tracks[0].back_to_back.maximum_consecutive_plays, 3);
  assert.equal(candidates.tracks[0].back_to_back.plays_in_bursts, 3);
  assert.equal("external_refs" in candidates.tracks[0], false);
  assert.doesNotMatch(
    JSON.stringify(candidates),
    /spotify:|6rqhFgbbKwnb9MLmUQDhG6/u,
  );
  const plan = await application.buildPlaylistPlan({
    intent: "Build a 1 track path from music I played back to back.",
    requestedTrackCount: 1,
    candidateSetIds: [candidates.candidate_set_id],
    trackRefs: [
      {
        trackRefId: candidates.tracks[0].track_ref_id,
        selectionReason: "It appears in a bounded adjacent playback sequence.",
      },
    ],
    orderingNotes: "One sequence stands alone.",
  });
  assert.deepEqual(plan.tracks[0].history_context, {
    kind: "back_to_back",
  });
  const explanation = await application.explainProfileEvidence({
    evidenceId: candidates.tracks[0].back_to_back.evidence_id,
  });
  assert.equal(explanation.claim.dimension, "listening.back_to_back");
  application.endPrompt();
});
