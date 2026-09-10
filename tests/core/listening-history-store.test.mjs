import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openListeningHistoryStore,
  resolveListeningHistoryPath,
} from "../../src/profile/listening-history-store.mjs";
import {
  SPOTIFY_RECENT_ACTIVITY_SOURCE,
  projectSpotifyRecentActivity,
} from "../../src/integrations/spotify/recent-activity.mjs";
import { projectSpotifyAccountDataHistory } from "../../src/integrations/spotify/account-data-history.mjs";
import {
  mergeSpotifyAccountProfile,
  projectSpotifyAccountDataProfile,
} from "../../src/integrations/spotify/account-data-profile.mjs";
import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";
import {
  contractSchemaIds,
  createContractValidator,
  formatValidationErrors,
} from "../../scripts/contract-lib.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const capturedAt = "2026-08-29T05:00:00.000Z";

function recentPage() {
  return {
    provider: "spotify",
    cursor_after_ms: 1_788_000_060_000,
    items: [
      {
        played_at: "2026-08-29T04:00:00.000Z",
        track: {
          id: "spotify-track-1",
          name: "Echoes",
          artists: ["Pink Floyd"],
          album: "Meddle",
          duration_ms: 1_413_000,
          isrc: "GBN9Y1100019",
          release_date: "1971-11-05",
          external_url: "https://open.spotify.com/track/spotify-track-1",
        },
        context_type: "album",
      },
      {
        played_at: "2026-08-29T04:01:00.000Z",
        track: {
          id: "spotify-track-1",
          name: "Echoes",
          artists: ["Pink Floyd"],
          album: "Meddle",
          duration_ms: 1_413_000,
        },
        context_type: "collection",
      },
    ],
  };
}

test("Spotify recent activity projects into valid provider-neutral contracts", async () => {
  const bundle = projectSpotifyRecentActivity({
    subjectId,
    page: recentPage(),
    capturedAt,
  });
  const { ajv } = await createContractValidator();
  const validateTrack = ajv.getSchema(contractSchemaIds.get("track-ref"));
  const validateEvent = ajv.getSchema(
    contractSchemaIds.get("listening-event"),
  );

  assert.equal(bundle.source_key, SPOTIFY_RECENT_ACTIVITY_SOURCE);
  assert.equal(bundle.track_refs.length, 1);
  assert.equal(bundle.listening_events.length, 2);
  for (const record of bundle.track_refs) {
    assert.equal(
      validateTrack(record),
      true,
      formatValidationErrors(validateTrack.errors),
    );
  }
  for (const record of bundle.listening_events) {
    assert.equal(
      validateEvent(record),
      true,
      formatValidationErrors(validateEvent.errors),
    );
    assert.equal(record.event_type, "play_observed");
    assert.equal(record.interaction_mode, "unknown");
  }
  assert.equal(bundle.listening_events[1].context.context_type, "unknown");
  assert.equal(JSON.stringify(bundle).includes("spotify:track"), false);
});

test("listening history sync is private, cursor-based, and idempotent", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-listening-history-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "private", "listening-history.sqlite");
  const store = await openListeningHistoryStore({ databasePath });
  context.after(() => store.close());
  const bundle = projectSpotifyRecentActivity({
    subjectId,
    page: recentPage(),
    capturedAt,
  });

  const first = store.ingest(bundle);
  const second = store.ingest(bundle);

  assert.equal(store.localSubjectId(), subjectId);
  assert.deepEqual(first, {
    state: "ready",
    source_key: SPOTIFY_RECENT_ACTIVITY_SOURCE,
    fetched_events: 2,
    inserted_events: 2,
    duplicate_events: 0,
    inserted_track_refs: 1,
    cursor_after_ms: 1_788_000_060_000,
    profile_effects: "updated",
  });
  assert.equal(second.inserted_events, 0);
  assert.equal(second.duplicate_events, 2);
  assert.equal(second.inserted_track_refs, 0);
  assert.deepEqual(store.status(), {
    state: "ready",
    track_refs: 1,
    listening_events: 2,
    effective_listening_events: 2,
    superseded_listening_events: 0,
    sources: 1,
    import_batches: 0,
    profile_import_batches: 0,
    profile_evidence: 0,
    taste_assertions: 0,
    active_taste_assertions: 0,
  });
  assert.equal(store.recentEvents({ subjectId }).length, 2);
  assert.equal((await stat(path.dirname(databasePath))).mode & 0o777, 0o700);
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
});

test("the listening store owns one stable local music subject", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-local-subject-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  context.after(() => store.close());

  assert.equal(store.localSubjectId(), null);
  const generated = store.localSubjectId({ create: true });
  assert.match(
    generated,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.equal(store.localSubjectId({ create: true }), generated);
  assert.throws(
    () => store.localSubjectId({ preferredSubjectId: subjectId }),
    /do not match/iu,
  );
  assert.deepEqual(store.subjectDataStatus({ subjectId: generated }), {
    state: "empty",
    effective_listening_events: 0,
    profile_evidence: 0,
    active_taste_assertions: 0,
  });
});

test("a failed first ingestion does not bind the local music subject", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-subject-rollback-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  context.after(() => store.close());
  const bundle = projectSpotifyRecentActivity({
    subjectId,
    page: recentPage(),
    capturedAt,
  });
  bundle.track_refs = [];

  assert.throws(() => store.ingest(bundle));
  assert.equal(store.localSubjectId(), null);
});

test("listening history imports are atomic, manifested, and idempotent", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-history-import-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  context.after(() => store.close());
  const bundle = projectSpotifyAccountDataHistory({
    subjectId,
    capturedAt,
    archiveSha256: "b".repeat(64),
    archiveSizeBytes: 2048,
    memberNames: ["StreamingHistory_music_0.json"],
    records: [
      {
        endTime: "2026-08-29 04:00",
        artistName: "Pink Floyd",
        trackName: "Echoes",
        msPlayed: 1_413_000,
      },
      {
        endTime: "2026-08-29 04:01",
        artistName: "Portishead",
        trackName: "Roads",
        msPlayed: 305_000,
      },
    ],
  });

  const first = store.ingestImport(bundle);
  const second = store.ingestImport(bundle);

  assert.equal(first.input_records, 2);
  assert.equal(first.inserted_events, 2);
  assert.equal(first.duplicate_events, 0);
  assert.equal(first.inserted_track_refs, 2);
  assert.equal(first.already_imported, false);
  assert.equal(second.inserted_events, 0);
  assert.equal(second.duplicate_events, 2);
  assert.equal(second.inserted_track_refs, 0);
  assert.equal(second.already_imported, true);
  assert.deepEqual(store.status(), {
    state: "ready",
    track_refs: 2,
    listening_events: 2,
    effective_listening_events: 2,
    superseded_listening_events: 0,
    sources: 1,
    import_batches: 1,
    profile_import_batches: 0,
    profile_evidence: 0,
    taste_assertions: 0,
    active_taste_assertions: 0,
  });
});

test("Extended History supersedes exact standard events without deleting evidence", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-history-reconcile-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  context.after(() => store.close());
  const standard = projectSpotifyAccountDataHistory({
    subjectId,
    capturedAt,
    archiveSha256: "c".repeat(64),
    archiveSizeBytes: 1024,
    memberNames: ["StreamingHistory_music_0.json"],
    records: [
      {
        endTime: "2026-08-29 04:00",
        artistName: "Pink Floyd",
        trackName: "Echoes",
        msPlayed: 30_000,
      },
    ],
  });
  const extended = projectSpotifyExtendedStreamingHistory({
    subjectId,
    capturedAt,
    archiveSha256: "d".repeat(64),
    archiveSizeBytes: 2048,
    memberNames: ["Streaming_History_Audio_2026.json"],
    records: [
      {
        ts: "2026-08-29T04:00:42Z",
        ms_played: 30_000,
        master_metadata_track_name: "Echoes",
        master_metadata_album_artist_name: "Pink Floyd",
        master_metadata_album_album_name: "Meddle",
        spotify_track_uri: "spotify:track:1234567890123456789012",
        reason_start: "clickrow",
        reason_end: "fwdbtn",
        shuffle: false,
        skipped: true,
        offline: false,
        incognito_mode: false,
      },
      {
        ts: "2024-08-29T04:00:42Z",
        ms_played: 305_000,
        master_metadata_track_name: "Roads",
        master_metadata_album_artist_name: "Portishead",
        master_metadata_album_album_name: "Dummy",
        spotify_track_uri: "spotify:track:abcdefghijklmnopqrstuv",
        reason_start: "trackdone",
        reason_end: "trackdone",
        shuffle: false,
        skipped: false,
        offline: false,
        incognito_mode: false,
      },
    ],
  });

  store.ingestImport(standard);
  const first = store.ingestImport(extended);
  const second = store.ingestImport(extended);
  const effective = store.recentEvents({ subjectId });
  const summary = store.profileSummary({ subjectId, maxItems: 3 });

  assert.equal(first.inserted_events, 2);
  assert.equal(first.superseded_events, 1);
  assert.equal(first.effective_event_delta, 1);
  assert.equal(second.inserted_events, 0);
  assert.equal(second.superseded_events, 0);
  assert.equal(second.effective_event_delta, 0);
  assert.equal(second.already_imported, true);
  assert.equal(effective.length, 2);
  assert.equal(
    effective.filter((event) => event.supersedes_listening_event_id).length,
    1,
  );
  assert.deepEqual(summary.listening_behavior.context, {
    reference_date: "2026-08-29T04:00:42.000Z",
    recent_window_days: 90,
    effective_events_profiled: 2,
    start_reason_events: 2,
    direct_selection_starts: 1,
    trackdone_starts: 1,
    end_reason_events: 2,
    trackdone_endings: 1,
    skip_state_events: 2,
    explicit_skips: 1,
    shuffle_state_events: 2,
    shuffle_events: 0,
    offline_state_events: 2,
    offline_events: 0,
    incognito_events_excluded: 0,
    rediscovery_quiet_days: 90,
    rediscovery_minimum_plays: 3,
    rediscovery_minimum_engaged_plays: 2,
    rediscovery_minimum_listening_minutes: 10,
    historical_return_minimum_gap_days: 180,
    historical_return_minimum_plays: 3,
    historical_return_minimum_engaged_plays: 3,
    historical_return_minimum_listening_minutes: 10,
    time_capsule_minimum_years: 2,
    time_capsule_minimum_engaged_plays: 2,
    time_capsule_minimum_listening_minutes: 5,
    relationship_minimum_years: 2,
    continuity_artist_limit: 10,
    release_minimum_distinct_tracks: 3,
    session_gap_minutes: 30,
    extended_sequence_minimum_plays: 5,
    back_to_back_minimum_consecutive_plays: 2,
    back_to_back_minimum_played_seconds: 30,
    back_to_back_maximum_gap_minutes: 30,
    monthly_activity_maximum_months: 240,
    listening_season_maximum_seasons: 80,
  });
  assert.deepEqual(summary.listening_behavior.history_arc, [
    {
      year: 2024,
      event_count: 1,
      listening_minutes: 5,
      distinct_tracks: 1,
      first_observed_tracks: 1,
      top_artist: {
        name: "Portishead",
        play_count: 1,
        listening_minutes: 5,
      },
    },
    {
      year: 2026,
      event_count: 1,
      listening_minutes: 1,
      distinct_tracks: 1,
      first_observed_tracks: 1,
      top_artist: {
        name: "Pink Floyd",
        play_count: 1,
        listening_minutes: 1,
      },
    },
  ]);
  assert.deepEqual(store.status(), {
    state: "ready",
    track_refs: 3,
    listening_events: 3,
    effective_listening_events: 2,
    superseded_listening_events: 1,
    sources: 2,
    import_batches: 2,
    profile_import_batches: 0,
    profile_evidence: 0,
    taste_assertions: 0,
    active_taste_assertions: 0,
  });
});

test("Extended History reconciliation is independent of import order", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-history-reconcile-reverse-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "listening-history.sqlite");
  let store = await openListeningHistoryStore({ databasePath });
  context.after(() => store.close());
  const forwardStore = await openListeningHistoryStore({
    databasePath: path.join(root, "forward-listening-history.sqlite"),
  });
  context.after(() => forwardStore.close());
  const standard = projectSpotifyAccountDataHistory({
    subjectId,
    capturedAt,
    archiveSha256: "4".repeat(64),
    archiveSizeBytes: 1024,
    memberNames: ["StreamingHistory_music_0.json"],
    records: [
      {
        endTime: "2026-08-29 04:00",
        artistName: "Pink Floyd",
        trackName: "Echoes",
        msPlayed: 30_000,
      },
    ],
  });
  const extended = projectSpotifyExtendedStreamingHistory({
    subjectId,
    capturedAt,
    archiveSha256: "5".repeat(64),
    archiveSizeBytes: 2048,
    memberNames: ["Streaming_History_Audio_2026.json"],
    records: [
      {
        ts: "2026-08-29T04:00:42Z",
        ms_played: 30_000,
        master_metadata_track_name: "Echoes",
        master_metadata_album_artist_name: "Pink Floyd",
        master_metadata_album_album_name: "Meddle",
        spotify_track_uri: "spotify:track:1234567890123456789012",
        reason_start: "clickrow",
        reason_end: "fwdbtn",
        shuffle: false,
        skipped: true,
        offline: false,
        incognito_mode: false,
      },
    ],
  });

  const first = store.ingestImport(extended);
  store.close();
  store = await openListeningHistoryStore({ databasePath });
  const second = store.ingestImport(standard);
  const repeatedStandard = store.ingestImport(standard);
  const repeatedExtended = store.ingestImport(extended);
  const effective = store.recentEvents({ subjectId });
  forwardStore.ingestImport(standard);
  forwardStore.ingestImport(extended);

  assert.equal(first.effective_event_delta, 1);
  assert.equal(second.inserted_events, 1);
  assert.equal(second.superseded_events, 1);
  assert.equal(second.effective_event_delta, 0);
  assert.equal(repeatedStandard.effective_event_delta, 0);
  assert.equal(repeatedExtended.effective_event_delta, 0);
  assert.equal(effective.length, 1);
  assert.equal(
    effective[0].supersedes_listening_event_id,
    standard.listening_events[0].listening_event_id,
  );
  assert.equal(store.status().listening_events, 2);
  assert.equal(store.status().effective_listening_events, 1);
  assert.equal(store.status().superseded_listening_events, 1);
  assert.deepEqual(
    store.profileSummary({ subjectId, maxItems: 10 }),
    forwardStore.profileSummary({ subjectId, maxItems: 10 }),
  );
});

test("exact cross-format overlap links remaining provisional plays to one resolved track", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-history-track-link-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "listening-history.sqlite");
  let store = await openListeningHistoryStore({ databasePath });
  context.after(() => store.close());
  const standard = projectSpotifyAccountDataHistory({
    subjectId,
    capturedAt,
    archiveSha256: "6".repeat(64),
    archiveSizeBytes: 1024,
    memberNames: ["StreamingHistory_music_0.json"],
    records: [
      {
        endTime: "2026-08-29 04:00",
        artistName: "Archive Artist",
        trackName: "One Known Signal",
        msPlayed: 30_000,
      },
      {
        endTime: "2025-07-01 12:00",
        artistName: "Archive Artist",
        trackName: "One Known Signal",
        msPlayed: 90_000,
      },
    ],
  });
  const extended = projectSpotifyExtendedStreamingHistory({
    subjectId,
    capturedAt,
    archiveSha256: "7".repeat(64),
    archiveSizeBytes: 2048,
    memberNames: ["Streaming_History_Audio_2026.json"],
    records: [
      {
        ts: "2026-08-29T04:00:42Z",
        ms_played: 30_000,
        master_metadata_track_name: "One Known Signal",
        master_metadata_album_artist_name: "Archive Artist",
        master_metadata_album_album_name: "Mapped Rooms",
        spotify_track_uri: "spotify:track:1111111111111111111111",
        reason_start: "clickrow",
        reason_end: "trackdone",
        shuffle: false,
        skipped: false,
        offline: false,
        incognito_mode: false,
      },
    ],
  });

  store.ingestImport(standard);
  store.ingestImport(extended);
  store.close();
  store = await openListeningHistoryStore({ databasePath });

  const summary = store.profileSummary({ subjectId, maxItems: 10 });
  const remainingAccountEvent = store
    .recentEvents({ subjectId })
    .find((event) => !event.supersedes_listening_event_id);

  assert.equal(summary.coverage.effective_listening_events, 2);
  assert.equal(summary.coverage.distinct_tracks, 1);
  assert.equal(summary.coverage.resolved_tracks, 1);
  assert.equal(summary.coverage.cross_format_track_links, 1);
  assert.equal(summary.coverage.cross_format_linked_events, 1);
  assert.equal(summary.coverage.cross_format_ambiguous_tracks, 0);
  assert.equal(summary.coverage.cross_format_ambiguous_events, 0);
  assert.equal(summary.listening_behavior.repeat_tracks.length, 1);
  assert.equal(summary.listening_behavior.repeat_tracks[0].play_count, 2);
  assert.equal(
    summary.listening_behavior.repeat_tracks[0].track_ref_id,
    extended.track_refs[0].track_ref_id,
  );
  assert.equal(
    remainingAccountEvent.track_ref_id,
    standard.track_refs[0].track_ref_id,
  );
  assert.deepEqual(store.status(), {
    state: "ready",
    track_refs: 2,
    listening_events: 3,
    effective_listening_events: 2,
    superseded_listening_events: 1,
    sources: 2,
    import_batches: 2,
    profile_import_batches: 0,
    profile_evidence: 0,
    taste_assertions: 0,
    active_taste_assertions: 0,
  });
});

test("cross-format track links fail closed when exact overlaps resolve to multiple tracks", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-history-track-ambiguity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  context.after(() => store.close());
  const standard = projectSpotifyAccountDataHistory({
    subjectId,
    capturedAt,
    archiveSha256: "8".repeat(64),
    archiveSizeBytes: 1024,
    memberNames: ["StreamingHistory_music_0.json"],
    records: [
      {
        endTime: "2026-08-29 04:00",
        artistName: "Edition Artist",
        trackName: "Two Possible Masters",
        msPlayed: 30_000,
      },
      {
        endTime: "2026-08-29 04:20",
        artistName: "Edition Artist",
        trackName: "Two Possible Masters",
        msPlayed: 30_000,
      },
      {
        endTime: "2025-07-01 12:00",
        artistName: "Edition Artist",
        trackName: "Two Possible Masters",
        msPlayed: 90_000,
      },
    ],
  });
  const extended = projectSpotifyExtendedStreamingHistory({
    subjectId,
    capturedAt,
    archiveSha256: "9".repeat(64),
    archiveSizeBytes: 2048,
    memberNames: ["Streaming_History_Audio_2026.json"],
    records: [
      {
        ts: "2026-08-29T04:00:42Z",
        ms_played: 30_000,
        master_metadata_track_name: "Two Possible Masters",
        master_metadata_album_artist_name: "Edition Artist",
        master_metadata_album_album_name: "First Edition",
        spotify_track_uri: "spotify:track:2222222222222222222222",
        reason_start: "clickrow",
        reason_end: "trackdone",
        shuffle: false,
        skipped: false,
        offline: false,
        incognito_mode: false,
      },
      {
        ts: "2026-08-29T04:20:42Z",
        ms_played: 30_000,
        master_metadata_track_name: "Two Possible Masters",
        master_metadata_album_artist_name: "Edition Artist",
        master_metadata_album_album_name: "Second Edition",
        spotify_track_uri: "spotify:track:3333333333333333333333",
        reason_start: "clickrow",
        reason_end: "trackdone",
        shuffle: false,
        skipped: false,
        offline: false,
        incognito_mode: false,
      },
    ],
  });

  store.ingestImport(standard);
  store.ingestImport(extended);

  const summary = store.profileSummary({ subjectId, maxItems: 10 });

  assert.equal(summary.coverage.effective_listening_events, 3);
  assert.equal(summary.coverage.distinct_tracks, 3);
  assert.equal(summary.coverage.resolved_tracks, 2);
  assert.equal(summary.coverage.cross_format_track_links, 0);
  assert.equal(summary.coverage.cross_format_linked_events, 0);
  assert.equal(summary.coverage.cross_format_ambiguous_tracks, 1);
  assert.equal(summary.coverage.cross_format_ambiguous_events, 1);
  assert.equal(summary.listening_behavior.repeat_tracks.length, 3);
  assert.equal(
    summary.listening_behavior.repeat_tracks.reduce(
      (total, track) => total + track.play_count,
      0,
    ),
    3,
  );
  assert.equal(store.status().listening_events, 5);
  assert.equal(store.status().effective_listening_events, 3);
  assert.equal(store.status().superseded_listening_events, 2);
});

test("rediscovery candidates retain trusted provider identity only inside the local store boundary", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-rediscovery-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  context.after(() => store.close());
  const rediscoveryTrackId = "4uLU6hMCjMI75M1A2tKUQC";
  const record = (timestamp) => ({
    ts: timestamp,
    ms_played: 240_000,
    master_metadata_track_name: "Old Signal",
    master_metadata_album_artist_name: "Archive Artist",
    master_metadata_album_album_name: "Earlier Rooms",
    spotify_track_uri: `spotify:track:${rediscoveryTrackId}`,
    reason_start: "clickrow",
    reason_end: "trackdone",
    shuffle: false,
    skipped: false,
    offline: false,
    incognito_mode: false,
  });
  const bundle = projectSpotifyExtendedStreamingHistory({
    subjectId,
    capturedAt,
    archiveSha256: "1".repeat(64),
    archiveSizeBytes: 4096,
    memberNames: ["Streaming_History_Audio_2026.json"],
    records: [
      record("2024-01-10T01:00:00Z"),
      record("2024-01-11T01:00:00Z"),
      record("2024-01-12T01:00:00Z"),
      {
        ...record("2026-08-29T04:00:00Z"),
        master_metadata_track_name: "Current Anchor",
        master_metadata_album_artist_name: "Present Artist",
        master_metadata_album_album_name: "Now",
        spotify_track_uri: "spotify:track:1234567890123456789012",
      },
    ],
  });
  store.ingestImport(bundle);

  const result = store.rediscoveryCandidates({ subjectId, limit: 1 });

  assert.equal(result.reference_date, "2026-08-29T04:00:00.000Z");
  assert.equal(result.quiet_days, 90);
  assert.equal(result.minimum_plays, 3);
  assert.equal(result.minimum_engaged_plays, 2);
  assert.equal(result.minimum_listening_minutes, 10);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].candidate_scope, "private_history");
  assert.equal(result.tracks[0].title, "Old Signal");
  assert.equal(result.tracks[0].rediscovery.listening_minutes, 12);
  assert.deepEqual(result.tracks[0].external_refs, [
    {
      system: "spotify",
      entity_type: "spotify.track",
      external_id: rediscoveryTrackId,
    },
  ]);
  assert.throws(
    () => store.rediscoveryCandidates({ subjectId, limit: 13 }),
    /limit is invalid/iu,
  );
});

test("time capsule candidates preserve chronological years and trusted identities", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-time-capsule-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  context.after(() => store.close());
  const firstId = "4uLU6hMCjMI75M1A2tKUQC";
  const secondId = "1234567890123456789012";
  const record = ({ timestamp, title, artist, id }) => ({
    ts: timestamp,
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
  const bundle = projectSpotifyExtendedStreamingHistory({
    subjectId,
    capturedAt,
    archiveSha256: "2".repeat(64),
    archiveSizeBytes: 4096,
    memberNames: ["Streaming_History_Audio_2026.json"],
    records: [
      record({
        timestamp: "2020-02-01T01:00:00Z",
        title: "First Landmark",
        artist: "Early Artist",
        id: firstId,
      }),
      record({
        timestamp: "2020-03-01T01:00:00Z",
        title: "First Landmark",
        artist: "Early Artist",
        id: firstId,
      }),
      record({
        timestamp: "2025-02-01T01:00:00Z",
        title: "Later Landmark",
        artist: "Later Artist",
        id: secondId,
      }),
      record({
        timestamp: "2025-03-01T01:00:00Z",
        title: "Later Landmark",
        artist: "Later Artist",
        id: secondId,
      }),
    ],
  });
  store.ingestImport(bundle);

  const result = store.timeCapsuleCandidates({ subjectId, limit: 6 });

  assert.equal(result.reference_date, "2025-03-01T01:00:00.000Z");
  assert.equal(result.history_start_year, 2020);
  assert.equal(result.history_end_year, 2025);
  assert.equal(result.minimum_years, 2);
  assert.equal(result.minimum_engaged_plays, 2);
  assert.equal(result.minimum_listening_minutes, 5);
  assert.deepEqual(result.represented_years, [2020, 2025]);
  assert.deepEqual(
    result.tracks.map((track) => [
      track.title,
      track.time_capsule.year,
      track.external_refs[0].external_id,
    ]),
    [
      ["First Landmark", 2020, firstId],
      ["Later Landmark", 2025, secondId],
    ],
  );
  assert.throws(
    () => store.timeCapsuleCandidates({ subjectId, limit: 1 }),
    /limit is invalid/iu,
  );
});

test("private profile projection combines listening, curation, and verified search evidence", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-profile-projection-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening-history.sqlite"),
  });
  context.after(() => store.close());
  const trackUri = "spotify:track:1234567890123456789012";
  const artistUri = "spotify:artist:abcdefghijklmnopqrstuv";
  const albumUri = "spotify:album:zyxwvutsrqponmlkjihgfe";
  const archiveSha256 = "e".repeat(64);
  const standard = projectSpotifyAccountDataHistory({
    subjectId,
    capturedAt,
    archiveSha256,
    archiveSizeBytes: 4096,
    memberNames: ["StreamingHistory_music_0.json"],
    records: [],
  });
  const profile = projectSpotifyAccountDataProfile({
    subjectId,
    capturedAt,
    archiveSha256,
    archiveSizeBytes: 4096,
    documents: {
      "YourLibrary.json": {
        tracks: [
          {
            track: "Echoes",
            artist: "Pink Floyd",
            album: "Meddle",
            uri: trackUri,
          },
        ],
        albums: [{ album: "Meddle", artist: "Pink Floyd", uri: albumUri }],
        artists: [{ name: "Pink Floyd", uri: artistUri }],
        bannedTracks: [],
        bannedArtists: [],
      },
      "Playlist1.json": {
        playlists: [
          {
            name: "Long Forms",
            lastModifiedDate: "2026-08-29",
            items: [
              {
                addedDate: "2026-08-20",
                track: {
                  trackName: "Echoes",
                  artistName: "Pink Floyd",
                  albumName: "Meddle",
                  trackUri,
                },
              },
            ],
          },
        ],
      },
      "SearchQueries.json": [
        {
          searchQuery: "pink floyd echoes",
          searchTime: "2026-08-29T03:00:00.000Z[UTC]",
          searchInteractionURIs: [trackUri, "spotify:search:ignored"],
          platform: "desktop",
        },
      ],
      "TasteProfile.json": {
        notes: [],
        tasteProfile: {
          artistUris: [artistUri],
          musicalIdentity: "A provider-generated profile statement.",
          contentRhythms: "A provider-generated rhythm statement.",
          audiobookTaste: "Not projected into music taste.",
          audiobookUris: [],
          podcastTaste: "Not projected into music taste.",
          showUris: [],
        },
      },
    },
  });
  const first = store.ingestImport(
    mergeSpotifyAccountProfile(standard, profile),
  );
  assert.equal(first.inserted_profile_evidence, 8);

  const extended = projectSpotifyExtendedStreamingHistory({
    subjectId,
    capturedAt,
    archiveSha256: "f".repeat(64),
    archiveSizeBytes: 2048,
    memberNames: ["Streaming_History_Audio_2026.json"],
    records: [
      {
        ts: "2026-08-29T04:00:00Z",
        ms_played: 120_000,
        master_metadata_track_name: "Echoes",
        master_metadata_album_artist_name: "Pink Floyd",
        master_metadata_album_album_name: "Meddle",
        spotify_track_uri: trackUri,
        reason_start: "clickrow",
        reason_end: "trackdone",
        shuffle: false,
        skipped: false,
        offline: false,
        incognito_mode: false,
      },
      {
        ts: "2026-08-29T04:05:00Z",
        ms_played: 1_000,
        master_metadata_track_name: "Echoes",
        master_metadata_album_artist_name: "Pink Floyd",
        master_metadata_album_album_name: "Meddle",
        spotify_track_uri: trackUri,
        reason_start: "trackdone",
        reason_end: "fwdbtn",
        shuffle: true,
        skipped: true,
        offline: true,
        incognito_mode: false,
      },
      {
        ts: "2026-08-29T04:10:00Z",
        ms_played: 240_000,
        master_metadata_track_name: "Echoes",
        master_metadata_album_artist_name: "Pink Floyd",
        master_metadata_album_album_name: "Meddle",
        spotify_track_uri: trackUri,
        reason_start: "clickrow",
        reason_end: "trackdone",
        shuffle: false,
        skipped: false,
        offline: false,
        incognito_mode: true,
      },
    ],
  });
  store.ingestImport(extended);

  const summary = store.profileSummary({ subjectId, maxItems: 3 });
  assert.equal(summary.coverage.effective_listening_events, 3);
  assert.equal(summary.coverage.profiled_listening_events, 2);
  assert.deepEqual(summary.listening_behavior.context, {
    reference_date: "2026-08-29T04:05:00.000Z",
    recent_window_days: 90,
    effective_events_profiled: 2,
    start_reason_events: 2,
    direct_selection_starts: 1,
    trackdone_starts: 1,
    end_reason_events: 2,
    trackdone_endings: 1,
    skip_state_events: 2,
    explicit_skips: 1,
    shuffle_state_events: 2,
    shuffle_events: 1,
    offline_state_events: 2,
    offline_events: 1,
    incognito_events_excluded: 1,
    rediscovery_quiet_days: 90,
    rediscovery_minimum_plays: 3,
    rediscovery_minimum_engaged_plays: 2,
    rediscovery_minimum_listening_minutes: 10,
    historical_return_minimum_gap_days: 180,
    historical_return_minimum_plays: 3,
    historical_return_minimum_engaged_plays: 3,
    historical_return_minimum_listening_minutes: 10,
    time_capsule_minimum_years: 2,
    time_capsule_minimum_engaged_plays: 2,
    time_capsule_minimum_listening_minutes: 5,
    relationship_minimum_years: 2,
    continuity_artist_limit: 10,
    release_minimum_distinct_tracks: 3,
    session_gap_minutes: 30,
    extended_sequence_minimum_plays: 5,
    back_to_back_minimum_consecutive_plays: 2,
    back_to_back_minimum_played_seconds: 30,
    back_to_back_maximum_gap_minutes: 30,
    monthly_activity_maximum_months: 240,
    listening_season_maximum_seasons: 80,
  });
  assert.equal(summary.listening_behavior.enduring_artists[0].name, "Pink Floyd");
  assert.deepEqual(summary.listening_behavior.history_arc, [
    {
      year: 2026,
      event_count: 2,
      listening_minutes: 2,
      distinct_tracks: 1,
      first_observed_tracks: 1,
      top_artist: {
        name: "Pink Floyd",
        play_count: 2,
        listening_minutes: 2,
      },
    },
  ]);
  assert.equal(summary.curated_preferences.saved_tracks[0].label, "Echoes");
  assert.equal(summary.curated_preferences.playlist_anchors[0].playlist_count, 1);
  assert.equal(summary.search_intent[0].query, "pink floyd echoes");
  assert.equal(summary.search_intent[0].quoted_data, true);
  assert.equal(summary.provider_signals.interpretations.length, 2);
  assert.equal(JSON.stringify(summary).includes("spotify:"), false);
  assert.equal(JSON.stringify(summary).includes("desktop"), false);

  const explanation = store.explainProfileEvidence({
    subjectId,
    evidenceId: summary.curated_preferences.saved_tracks[0].evidence_id,
  });
  assert.equal(explanation.claim.dimension, "taste.track_preference");
  assert.match(explanation.interpretation_limit, /explicit current provider state/iu);
});

test("listening history path follows the private Moondog state root", () => {
  assert.equal(
    resolveListeningHistoryPath({ MOONDOG_STATE_HOME: "/tmp/moondog-state" }),
    path.join("/tmp/moondog-state", "listening-history.sqlite"),
  );
  assert.equal(
    resolveListeningHistoryPath({ XDG_STATE_HOME: "/tmp/xdg-state" }),
    path.join("/tmp/xdg-state", "moondog", "listening-history.sqlite"),
  );
  assert.throws(
    () => resolveListeningHistoryPath({ MOONDOG_STATE_HOME: "relative" }),
    /absolute path/u,
  );
});
