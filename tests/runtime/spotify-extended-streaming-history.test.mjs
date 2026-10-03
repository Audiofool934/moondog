import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { projectSpotifyAccountDataHistory } from "../../src/integrations/spotify/account-data-history.mjs";
import {
  SPOTIFY_EXTENDED_HISTORY_SCOPE,
  SPOTIFY_EXTENDED_HISTORY_SOURCE,
  projectSpotifyExtendedStreamingHistory,
} from "../../src/integrations/spotify/extended-streaming-history.mjs";
import { readSpotifyHistoryArchive } from "../../src/integrations/spotify/history-archive.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import {
  contractSchemaIds,
  createContractValidator,
  formatValidationErrors,
} from "../../scripts/contract-lib.mjs";

const execFileAsync = promisify(execFile);
const subjectId = "11111111-1111-4111-8111-111111111111";
const capturedAt = "2026-08-29T05:00:00.000Z";

function musicRecord(overrides = {}) {
  return {
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
    username: "PRIVATE_USERNAME_SENTINEL",
    ip_addr: "PRIVATE_IP_SENTINEL",
    conn_country: "PRIVATE_COUNTRY_SENTINEL",
    platform: "PRIVATE_PLATFORM_SENTINEL",
    user_agent_decrypted: "PRIVATE_USER_AGENT_SENTINEL",
    offline_timestamp: 1_777_777_777,
    ...overrides,
  };
}

function project(records) {
  return projectSpotifyExtendedStreamingHistory({
    subjectId,
    records,
    archiveSha256: "e".repeat(64),
    archiveSizeBytes: 4096,
    memberNames: ["Streaming_History_Audio_2026.json"],
    capturedAt,
  });
}

test("Extended History produces resolved contracts and exact standard-event candidates", async () => {
  const standard = projectSpotifyAccountDataHistory({
    subjectId,
    records: [
      {
        endTime: "2026-08-29 04:00",
        artistName: "Pink Floyd",
        trackName: "Echoes",
        msPlayed: 30_000,
      },
    ],
    archiveSha256: "f".repeat(64),
    archiveSizeBytes: 1024,
    memberNames: ["StreamingHistory_music_0.json"],
    capturedAt,
  });
  const records = [
    musicRecord(),
    musicRecord({
      ts: "2024-08-29T04:00:42Z",
      ms_played: 305_000,
      master_metadata_track_name: "Roads",
      master_metadata_album_artist_name: "Portishead",
      master_metadata_album_album_name: "Dummy",
      spotify_track_uri: "spotify:track:abcdefghijklmnopqrstuv",
      reason_start: "trackdone",
      reason_end: "trackdone",
      skipped: false,
    }),
    {
      spotify_track_uri: null,
      episode_name: "Private podcast title",
      ip_addr: "PRIVATE_IP_SENTINEL",
    },
  ];
  const bundle = project(records);
  const reversed = project([...records].reverse());
  const { ajv } = await createContractValidator();
  const validateTrack = ajv.getSchema(contractSchemaIds.get("track-ref"));
  const validateEvent = ajv.getSchema(
    contractSchemaIds.get("listening-event"),
  );

  assert.equal(bundle.source_key, SPOTIFY_EXTENDED_HISTORY_SOURCE);
  assert.equal(bundle.import_batch.data_scope, SPOTIFY_EXTENDED_HISTORY_SCOPE);
  assert.equal(bundle.track_refs.length, 2);
  assert.equal(bundle.listening_events.length, 2);
  assert.equal(bundle.reconciliation_candidates.length, 2);
  assert.equal(
    bundle.reconciliation_candidates.find((candidate) =>
      bundle.listening_events.some(
        (event) =>
          event.listening_event_id === candidate.superseding_event_id &&
          event.occurred_at.startsWith("2026-08-29"),
      ),
    ).superseded_event_id,
    standard.listening_events[0].listening_event_id,
  );
  assert.deepEqual(
    bundle.listening_events.map((event) => event.listening_event_id),
    reversed.listening_events.map((event) => event.listening_event_id),
  );
  for (const record of bundle.track_refs) {
    assert.equal(record.identity_status, "resolved");
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
  }
  assert.equal(bundle.listening_events[1].event_type, "play_skipped");
  const serialized = JSON.stringify(bundle);
  assert.equal(serialized.includes("PRIVATE_IP_SENTINEL"), false);
  assert.equal(serialized.includes("PRIVATE_USERNAME_SENTINEL"), false);
  assert.equal(serialized.includes("PRIVATE_COUNTRY_SENTINEL"), false);
  assert.equal(serialized.includes("PRIVATE_PLATFORM_SENTINEL"), false);
  assert.equal(serialized.includes("PRIVATE_USER_AGENT_SENTINEL"), false);
  assert.equal(serialized.includes("1777777777"), false);
  assert.equal(serialized.includes("Private podcast title"), false);
  assert.equal(serialized.includes("spotify:track:"), false);
});

test("Extended History rejects invalid track identities and behavior fields", () => {
  assert.throws(
    () => project([musicRecord({ spotify_track_uri: "spotify:track:short" })]),
    /invalid spotify_track_uri/iu,
  );
  assert.throws(
    () => project([musicRecord({ skipped: "yes" })]),
    /invalid skipped/iu,
  );
});

test("history archive router reads music in audio and video members and can extend an older import", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-spotify-extended-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Spotify Extended Streaming History");
  const archivePath = path.join(root, "spotify extended.zip");
  await mkdir(dataRoot);
  await writeFile(
    path.join(dataRoot, "Streaming_History_Audio_2026.json"),
    JSON.stringify([musicRecord()]),
  );
  await writeFile(
    path.join(dataRoot, "Streaming_History_Video_2026.json"),
    JSON.stringify([
      { ts: "2026-08-29T04:00:42Z", spotify_track_uri: null, episode_name: "Private video podcast" },
      musicRecord({ ts: "2026-08-29T04:04:00Z", ms_played: 60_000 }),
    ]),
  );
  await execFileAsync(
    "/usr/bin/zip",
    ["-q", "-r", archivePath, "Spotify Extended Streaming History"],
    { cwd: root },
  );

  const bundle = await readSpotifyHistoryArchive({
    archivePath,
    subjectId,
    capturedAt,
  });

  assert.equal(bundle.source_key, SPOTIFY_EXTENDED_HISTORY_SOURCE);
  assert.equal(bundle.listening_events.length, 2);
  assert.deepEqual(bundle.import_batch.member_names, [
    "Streaming_History_Audio_2026.json",
    "Streaming_History_Video_2026.json",
  ]);
  assert.equal(JSON.stringify(bundle).includes("Private video podcast"), false);
  assert.equal(JSON.stringify(bundle).includes(archivePath), false);

  const { openEphemeralListeningHistoryStore } = await import("../../src/profile/listening-history-store.mjs");
  const store = await openEphemeralListeningHistoryStore();
  context.after(() => store.close());
  const previous = projectSpotifyExtendedStreamingHistory({
    subjectId, capturedAt, records: [musicRecord()],
    archiveSha256: bundle.import_batch.archive_sha256,
    archiveSizeBytes: bundle.import_batch.archive_size_bytes,
    memberNames: ["Streaming_History_Audio_2026.json"],
  });
  store.ingestImport(previous);
  assert.equal(store.ingestImport(bundle).inserted_events, 1);
  assert.equal(store.ingestImport(bundle).inserted_events, 0);
  assert.equal(store.profileSummary({ subjectId }).coverage.effective_listening_events, 2);
  assert.equal(store.profileCatalog({ subjectId }).sources[0].input_records, 2);
});

for (const standardTiming of ["before", "after"]) {
  test(`video expansion preserves colliding audio matches with Account Data imported ${standardTiming}`, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "moondog-video-expansion-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const dataRoot = path.join(root, "Spotify Extended Streaming History");
    const archivePath = path.join(root, "history.zip");
    const audio = musicRecord({ ts: "2026-08-29T04:00:42Z", ms_played: 5_000 });
    const video = musicRecord({ ts: "2026-08-29T04:00:12Z", ms_played: 5_000 });
    await mkdir(dataRoot);
    await writeFile(path.join(dataRoot, "Streaming_History_Audio_2026.json"), JSON.stringify([audio]));
    await writeFile(path.join(dataRoot, "Streaming_History_Video_2026.json"), JSON.stringify([video]));
    await execFileAsync("/usr/bin/zip", ["-q", "-r", archivePath, "Spotify Extended Streaming History"], { cwd: root });
    const full = await readSpotifyHistoryArchive({ archivePath, subjectId, capturedAt });
    const original = projectSpotifyExtendedStreamingHistory({
      subjectId, capturedAt, records: [audio], archiveSha256: full.import_batch.archive_sha256,
      archiveSizeBytes: full.import_batch.archive_size_bytes, memberNames: ["Streaming_History_Audio_2026.json"],
    });
    const standard = projectSpotifyAccountDataHistory({
      subjectId, capturedAt, archiveSha256: "f".repeat(64), archiveSizeBytes: 1024,
      memberNames: ["StreamingHistory_music_0.json"],
      records: Array.from({ length: 2 }, () => ({
        endTime: "2026-08-29 04:00", artistName: "Pink Floyd", trackName: "Echoes", msPlayed: 5_000,
      })),
    });
    const databasePath = path.join(root, "history.sqlite");
    let store = await openListeningHistoryStore({ databasePath });
    context.after(() => store.close());
    if (standardTiming === "before") store.ingestImport(standard);
    store.ingestImport(original);
    const audioId = original.listening_events[0].listening_event_id;
    const savedAudio = store.recentEvents({ subjectId }).find(event => event.listening_event_id === audioId);
    const correction = store.recordListenerCorrection({ subjectId, entityType: "track", label: "Echoes",
      artistCredit: "Pink Floyd", stance: "avoid", occurredAt: capturedAt });
    store.close();
    store = await openListeningHistoryStore({ databasePath });

    const upgraded = store.ingestImport(full);
    assert.equal(upgraded.inserted_events, 1);
    assert.equal(upgraded.effective_event_delta, standardTiming === "before" ? 0 : 1);
    assert.deepEqual(store.recentEvents({ subjectId }).find(event => event.listening_event_id === audioId), savedAudio);
    if (standardTiming === "after") store.ingestImport(standard);
    store.close();
    store = await openListeningHistoryStore({ databasePath });
    assert.equal(store.ingestImport(full).effective_event_delta, 0);
    assert.equal(store.ingestImport(standard).effective_event_delta, 0);
    const overlappingExport = projectSpotifyExtendedStreamingHistory({
      subjectId, capturedAt, records: [audio, video], archiveSha256: "d".repeat(64),
      archiveSizeBytes: 2048, memberNames: full.import_batch.member_names,
    });
    assert.equal(store.ingestImport(overlappingExport).effective_event_delta, 0);
    assert.equal(store.status().effective_listening_events, 2);
    assert.equal(store.status().superseded_listening_events, 2);
    const events = store.recentEvents({ subjectId });
    assert.equal(events.find(event => event.listening_event_id === audioId).supersedes_listening_event_id,
      original.reconciliation_candidates[0].superseded_event_id);
    assert.equal(store.profileCatalog({ subjectId }).sources.find(source => source.format === full.import_batch.source_format).input_records, 4);
    assert.equal(store.activeAvoidances({ subjectId })[0].correction_id, correction.correction_id);
  });
}

function overlappingHistoryFixtures() {
  const capturedAt = "2026-09-01T00:00:00.000Z";
  const record = (ts) => musicRecord({
    ts, ms_played: 5_000, master_metadata_track_name: "Synthetic Song",
    master_metadata_album_artist_name: "Example Artist", master_metadata_album_album_name: "Example Album",
  });
  const audio = record("2026-08-29T04:00:42Z");
  const video = record("2026-08-29T04:00:12Z");
  const newPlay = record("2026-08-29T04:00:02Z");
  const extended = (records, digest, memberNames = ["Streaming_History_Audio_2026.json"]) =>
    projectSpotifyExtendedStreamingHistory({
      subjectId, capturedAt, records, archiveSha256: digest.repeat(64), archiveSizeBytes: 4096, memberNames,
    });
  const standard = (count, digest) => projectSpotifyAccountDataHistory({
    subjectId, capturedAt, archiveSha256: digest.repeat(64), archiveSizeBytes: 1024,
    memberNames: ["StreamingHistory_music_0.json"],
    records: Array.from({ length: count }, () => ({
      endTime: "2026-08-29 04:00", artistName: "Example Artist", trackName: "Synthetic Song", msPlayed: 5_000,
    })),
  });
  const original = extended([audio], "a");
  const full = extended([audio, video], "a", [
    "Streaming_History_Audio_2026.json", "Streaming_History_Video_2026.json",
  ]);
  return { audio, video, newPlay, capturedAt, extended, standard, original, full };
}

for (const route of ["audio then video expansion", "audio and video together"]) {
  for (const standardTiming of ["before", "after"]) {
    test(`narrower Extended History preserves ${route} matches with Account Data ${standardTiming}`, async (context) => {
      const root = await mkdtemp(path.join(tmpdir(), "moondog-history-subset-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      const databasePath = path.join(root, "history.sqlite");
      let store = await openListeningHistoryStore({ databasePath });
      context.after(() => store.close());
      const { audio, video, capturedAt, extended, standard, original, full } = overlappingHistoryFixtures();
      const accountData = standard(2, "f");
      if (standardTiming === "before") store.ingestImport(accountData);
      if (route === "audio then video expansion") store.ingestImport(original);
      store.ingestImport(full);
      const subset = extended([route === "audio then video expansion" ? video : audio], "b");
      const correction = store.recordListenerCorrection({
        subjectId, entityType: "track", label: "Synthetic Song", artistCredit: "Example Artist",
        stance: "avoid", occurredAt: capturedAt,
      });
      const savedEvents = store.recentEvents({ subjectId });
      store.close();
      store = await openListeningHistoryStore({ databasePath });

      const imported = store.ingestImport(subset);
      assert.equal(imported.inserted_events, 0);
      assert.equal(imported.duplicate_events, 1);
      assert.equal(imported.effective_event_delta, 0);
      assert.deepEqual(store.recentEvents({ subjectId }), savedEvents);
      assert.equal(store.ingestImport(subset).effective_event_delta, 0);
      if (standardTiming === "after") store.ingestImport(accountData);
      const matchedEvents = store.recentEvents({ subjectId });
      assert.deepEqual(new Set(matchedEvents.map(event => event.supersedes_listening_event_id)),
        new Set(accountData.listening_events.map(event => event.listening_event_id)));
      const first = route === "audio then video expansion" ? original : full;
      const firstCandidate = first.reconciliation_candidates[0];
      assert.equal(matchedEvents.find(event => event.listening_event_id === firstCandidate.superseding_event_id)
        .supersedes_listening_event_id, firstCandidate.superseded_event_id);

      store.close();
      store = await openListeningHistoryStore({ databasePath });
      for (const bundle of [subset, full, accountData]) {
        assert.equal(store.ingestImport(bundle).effective_event_delta, 0);
      }
      assert.deepEqual(store.recentEvents({ subjectId }), matchedEvents);
      assert.equal(store.status().effective_listening_events, 2);
      assert.equal(store.status().superseded_listening_events, 2);
      assert.equal(store.activeAvoidances({ subjectId })[0].correction_id, correction.correction_id);
    });
  }
}

test("a new same-minute play cannot steal a retained match from an absent play", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-history-new-overlap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, "history.sqlite");
  let store = await openListeningHistoryStore({ databasePath });
  context.after(() => store.close());
  const { audio, video, newPlay, capturedAt, extended, standard, full } = overlappingHistoryFixtures();
  store.ingestImport(standard(2, "f"));
  store.ingestImport(full);
  const correction = store.recordListenerCorrection({
    subjectId, entityType: "track", label: "Synthetic Song", artistCredit: "Example Artist",
    stance: "avoid", occurredAt: capturedAt,
  });
  const savedEvents = store.recentEvents({ subjectId });
  const savedStatus = store.status();
  const savedSources = store.profileCatalog({ subjectId }).sources;
  for (const records of [[newPlay], [newPlay, video]]) {
    assert.throws(() => store.ingestImport(extended(records, "b")), /Listening history reconciliation conflict/u);
    assert.deepEqual(store.recentEvents({ subjectId }), savedEvents);
    assert.deepEqual(store.status(), savedStatus);
    assert.deepEqual(store.profileCatalog({ subjectId }).sources, savedSources);
  }
  store.close();
  store = await openListeningHistoryStore({ databasePath });
  assert.deepEqual(store.recentEvents({ subjectId }), savedEvents);

  // A complete larger export supplies a third equivalent counterpart. The new
  // play can use it without changing either of the already-established pairs.
  const larger = extended([newPlay, video, audio], "c");
  const imported = store.ingestImport(larger);
  assert.equal(imported.inserted_events, 1);
  assert.equal(imported.effective_event_delta, 1);
  assert.deepEqual(store.recentEvents({ subjectId }).filter(event =>
    savedEvents.some(saved => saved.listening_event_id === event.listening_event_id)), savedEvents);
  const accountData = standard(3, "d");
  assert.equal(store.ingestImport(accountData).effective_event_delta, 0);
  const matchedEvents = store.recentEvents({ subjectId });
  assert.deepEqual(new Set(matchedEvents.map(event => event.supersedes_listening_event_id)),
    new Set(accountData.listening_events.map(event => event.listening_event_id)));
  store.close();
  store = await openListeningHistoryStore({ databasePath });
  assert.equal(store.ingestImport(larger).effective_event_delta, 0);
  assert.equal(store.ingestImport(accountData).effective_event_delta, 0);
  assert.deepEqual(store.recentEvents({ subjectId }), matchedEvents);
  assert.equal(store.status().effective_listening_events, 3);
  assert.equal(store.status().superseded_listening_events, 3);
  assert.equal(store.activeAvoidances({ subjectId })[0].correction_id, correction.correction_id);
});
