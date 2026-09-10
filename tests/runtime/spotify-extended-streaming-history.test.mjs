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

test("history archive router reads Extended audio and ignores video", async (context) => {
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
    JSON.stringify([{ ts: "2026-08-29T04:00:42Z", episode_name: "Video" }]),
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
  assert.equal(bundle.listening_events.length, 1);
  assert.deepEqual(bundle.import_batch.member_names, [
    "Streaming_History_Audio_2026.json",
  ]);
  assert.equal(JSON.stringify(bundle).includes("Video"), false);
  assert.equal(JSON.stringify(bundle).includes(archivePath), false);
});
