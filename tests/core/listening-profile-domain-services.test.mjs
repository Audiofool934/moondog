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

test("home lyric seeds honor artist Avoid beyond the bounded profile display", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-lyric-seeds-"));
  const store = await openListeningHistoryStore({ databasePath: path.join(root, "history.sqlite") });
  const services = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  context.after(async () => { services.close(); await rm(root, { recursive: true, force: true }); });
  for (let index = 0; index < 60; index++) {
    store.recordListenerCorrection({ subjectId, entityType: "artist", label: index ? `Other ${index}` : "Blocked artist", stance: "avoid",
      occurredAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString() });
  }
  store.recordListenerCorrection({ subjectId, entityType: "track", label: "Liked fixture", artistCredit: "Blocked artist", stance: "like",
    occurredAt: "2026-09-02T00:00:00.000Z" });
  const summary = await services.getProfileSummary({ maxItems: 10 });
  assert.equal(summary.listener_assertions.avoids.some((item) => item.label === "Blocked artist"), false);
  assert.equal((await services.getLyricSeeds()).tracks.some((track) => track.title === "Liked fixture"), false);
});

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
  assert.match(profile.limitations[0], /saved on this machine/iu);

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

test("Spotify-only history revises a played-back-to-back plan with outside music", async (context) => {
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

  application.beginPrompt();
  const retainedHistory = application.pendingSpotifyPlaylistStatus().revision;
  const external = application.domainServices.registerExternalCandidateSet({
    tracks: [{
      track_ref_id: "22222222-2222-4222-8222-222222222222",
      title: "Moonlit Glass",
      artist_credit: "North Window",
      release: "Fictional Horizon",
      candidate_scope: "external_catalog",
      catalog_provider: "apple_music",
    }],
    source: {
      provider: "apple_music",
      catalog: "itunes_search_api",
      storefront: "US",
      retrieved_at: capturedAt,
      coverage: "Fictional test catalog.",
    },
  });
  const mixedPlan = await application.buildPlaylistPlan({
    intent: "Pair a familiar track with an outside discovery.",
    requestedTrackCount: 2,
    candidateSetIds: [retainedHistory.candidate_set_id, external.candidate_set_id],
    trackRefs: [...plan.tracks, ...external.tracks].map((track) => ({
      trackRefId: track.track_ref_id,
      selectionReason: "Move from a familiar sequence to new music.",
    })),
    orderingNotes: "Start familiar, then step outside.",
  });
  application.endPrompt();

  application.beginPrompt();
  const retainedMixed = application.pendingSpotifyPlaylistStatus().revision;
  assert.equal(retainedMixed.state, "ready");
  assert.equal(retainedMixed.candidate_scope, "mixed");
  assert.doesNotMatch(JSON.stringify(retainedMixed), /external_refs|6rqhFgbbKwnb9MLmUQDhG6/u);
  const trusted = application.domainServices.getTrustedTracks(
    mixedPlan.tracks.map((track) => track.track_ref_id),
  );
  assert.equal(trusted[0].external_refs[0].external_id, "6rqhFgbbKwnb9MLmUQDhG6");
  assert.equal(trusted[0].identity_status, "resolved");
  assert.deepEqual(trusted[0].back_to_back, candidates.tracks[0].back_to_back);
  const revised = await application.buildPlaylistPlan({
    intent: "Hear the discovery before the familiar track.",
    requestedTrackCount: 2,
    candidateSetIds: [retainedMixed.candidate_set_id],
    trackRefs: [...mixedPlan.tracks].reverse().map((track) => ({
      trackRefId: track.track_ref_id,
      selectionReason: "The listener reversed the listening order.",
    })),
    orderingNotes: "Start outside, then return to the familiar sequence.",
  });
  assert.equal(revised.candidate_scope, "mixed");
  assert.deepEqual(revised.tracks.map((track) => track.candidate_scope), ["external_catalog", "private_history"]);
  assert.deepEqual(revised.tracks[1].history_context, { kind: "back_to_back" });
  application.endPrompt();
});

test("retained history-profile candidates preserve validation, privacy, and prompt limits", () => {
  const services = createListeningProfileDomainServices({
    listeningHistoryStore: {
      profileSummary() {},
      explainProfileEvidence() {},
      subjectDataStatus() {},
      close() {},
    },
    subjectId,
  });
  const track = {
    track_ref_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    title: "Moonlit Glass",
    artist_credit: "North Window",
    release: "Fictional Horizon",
    candidate_scope: "external_catalog",
    catalog_provider: "apple_music",
    catalog_url: "https://music.apple.com/us/album/1700000002",
    duration_ms: 180_000,
    matched_queries: ["Fictional catalog query"],
    external_refs: [{ system: "spotify", entity_type: "spotify.track", external_id: "1234567890123456789012" }],
    observation_summary: { preference_signals: ["loved"] },
    rediscovery: { evidence_id: subjectId },
  };
  try {
    for (const invalid of [
      [],
      [null],
      [{ ...track, candidate_scope: "private_library" }],
      [{ ...track, candidate_scope: "private_history" }],
      [{ ...track, catalog_provider: "unknown" }],
      [{ ...track, catalog_provider: "listenbrainz" }],
      [{ ...track, track_ref_id: "not-a-uuid" }],
      [track, { ...track, track_ref_id: track.track_ref_id.toLowerCase() }],
      Array(13).fill(track),
    ]) {
      assert.throws(() => services.registerRetainedPlaylistCandidateSet({ tracks: invalid }));
    }
    const retained = services.registerRetainedPlaylistCandidateSet({ tracks: [track] });
    assert.equal(retained.source, "retained_validated_playlist");
    assert.equal(retained.tracks[0].track_ref_id, track.track_ref_id.toLowerCase());
    assert.equal(retained.tracks[0].catalog_url, track.catalog_url);
    assert.equal(retained.tracks[0].duration_ms, track.duration_ms);
    assert.deepEqual(retained.tracks[0].observation_summary.preference_signals, []);
    assert.equal("rediscovery" in retained.tracks[0], false);
    assert.equal("external_refs" in retained.tracks[0], false);
    track.title = "Changed caller input";
    retained.tracks[0].matched_queries.push("Changed caller output");
    const trusted = services.getTrustedTracks([track.track_ref_id]);
    assert.equal(trusted[0].title, "Moonlit Glass");
    assert.deepEqual(trusted[0].matched_queries, ["Fictional catalog query"]);
    trusted[0].title = "Changed trusted copy";
    assert.equal(services.getTrustedTracks([track.track_ref_id])[0].title, "Moonlit Glass");
    for (let index = 1; index < 8; index += 1) {
      services.registerRetainedPlaylistCandidateSet({ tracks: [track] });
    }
    assert.throws(() => services.registerRetainedPlaylistCandidateSet({ tracks: [track] }), /candidate set limit/u);
    assert.deepEqual(services.endPrompt(), { invalidated_candidate_sets: 8 });
    assert.throws(() => services.getTrustedTracks([track.track_ref_id]), /unavailable/u);
  } finally {
    services.close();
  }
});

test("history-only profiles can continue and revise plans with outside music", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-history-discovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  store.ingestImport(
    projectSpotifyExtendedStreamingHistory({
      subjectId,
      capturedAt,
      archiveSha256: "c".repeat(64),
      archiveSizeBytes: 4096,
      memberNames: ["Streaming_History_Audio_2026.json"],
      records: [extendedRecord("2026-08-30T04:00:00Z", 305_000)],
    }),
  );
  const application = new MoondogApplication({
    importsRoot: path.join(root, "no-apple-imports"),
    domainServices: createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId }),
    musicSimilarity: { async discoverSimilarTracks() { return { state: "resolved", tracks: [] }; } },
  });
  context.after(() => application.close());
  assert.equal(application.domainServicesReady(), false);
  assert.equal(application.musicSimilarityReady(), true);

  const external = (id, title, artist) => ({
    track_ref_id: id,
    title,
    artist_credit: artist,
    release: `${title} Release`,
    candidate_scope: "external_catalog",
    catalog_provider: "apple_music",
  });
  application.beginPrompt();
  const registered = application.domainServices.registerExternalCandidateSet({
    tracks: [
      external("22222222-2222-4222-8222-222222222222", "Roads", "Portishead"),
      external("33333333-3333-4333-8333-333333333333", "Teardrop", "Massive Attack"),
      {
        ...external("44444444-4444-4444-8444-444444444444", "Moonlit Glass", "North Window"),
        catalog_provider: "listenbrainz",
        discovery_basis: {
          kind: "listenbrainz_collaborative_artist_similarity",
          mode: "easy",
          seed_artist: "Fictional Seed",
          adjacent_artist: "North Window",
        },
      },
    ],
    source: {
      provider: "apple_music",
      catalog: "itunes_search_api",
      storefront: "US",
      retrieved_at: capturedAt,
      coverage: "Fictional test catalog.",
    },
  });
  assert.equal(registered.excluded_library_matches, 1);
  assert.deepEqual(registered.tracks.map((track) => track.title), ["Teardrop", "Moonlit Glass"]);

  const plan = await application.buildPlaylistPlan({
    intent: "Find 2 songs near my listening.",
    requestedTrackCount: 2,
    candidateSetIds: [registered.candidate_set_id],
    trackRefs: registered.tracks.map((track) => ({
      trackRefId: track.track_ref_id,
      selectionReason: "One step outside the listening history.",
    })),
    orderingNotes: "One step outward.",
  });
  assert.equal(plan.candidate_scope, "external_catalog");
  assert.equal(plan.tracks[0].candidate_scope, "external_catalog");
  assert.equal("history_context" in plan.tracks[0], false);
  application.endPrompt();
  assert.throws(() => application.domainServices.getTrustedTracks([plan.tracks[0].track_ref_id]), /unavailable/u);

  application.beginPrompt();
  const retained = application.pendingSpotifyPlaylistStatus().revision;
  assert.equal(retained.state, "ready");
  assert.equal(retained.candidate_scope, "external_catalog");
  assert.equal(retained.expires_on, "prompt_end");
  assert.notEqual(retained.candidate_set_id, registered.candidate_set_id);
  const revisedArguments = {
    intent: "Reverse the outside discoveries.",
    requestedTrackCount: 2,
    candidateSetIds: [retained.candidate_set_id],
    trackRefs: [...plan.tracks].reverse().map((track) => ({
      trackRefId: track.track_ref_id,
      selectionReason: "The listener requested this order.",
    })),
    orderingNotes: "Reverse the validated plan.",
  };
  await assert.rejects(application.buildPlaylistPlan({
    ...revisedArguments,
    candidateSetIds: [registered.candidate_set_id],
  }), /unavailable or expired/u);
  const revised = await application.buildPlaylistPlan(revisedArguments);
  assert.equal(revised.candidate_scope, "external_catalog");
  assert.deepEqual(revised.tracks.map((track) => track.track_ref_id), [...plan.tracks].reverse().map((track) => track.track_ref_id));
  assert.deepEqual(revised.tracks.map((track) => track.discovery_evidence), [...plan.tracks].reverse().map((track) => track.discovery_evidence));
  const trusted = application.domainServices.getTrustedTracks(revised.tracks.map((track) => track.track_ref_id));
  assert.ok(trusted.every((track) => track.observation_summary.familiarity.basis === "external_catalog_not_personal_evidence"));
  assert.deepEqual(trusted[0].knownness, registered.tracks[0].knownness);
  application.endPrompt();
  await assert.rejects(application.domainServices.buildPlaylistPlan(revisedArguments), /unavailable or expired/u);

  application.beginPrompt();
  assert.deepEqual(application.pendingSpotifyPlaylistStatus().revision.tracks, revised.tracks);
  application.endPrompt();
});
