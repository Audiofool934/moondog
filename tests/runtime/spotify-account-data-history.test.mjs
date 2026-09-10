import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  SPOTIFY_ACCOUNT_DATA_HISTORY_SCOPE,
  SPOTIFY_ACCOUNT_DATA_HISTORY_SOURCE,
  projectSpotifyAccountDataHistory,
  readSpotifyAccountDataHistoryArchive,
} from "../../src/integrations/spotify/account-data-history.mjs";
import {
  contractSchemaIds,
  createContractValidator,
  formatValidationErrors,
} from "../../scripts/contract-lib.mjs";

const execFileAsync = promisify(execFile);
const subjectId = "11111111-1111-4111-8111-111111111111";
const capturedAt = "2026-08-29T05:00:00.000Z";
const archiveSha256 = "a".repeat(64);

function project(records) {
  return projectSpotifyAccountDataHistory({
    subjectId,
    records,
    archiveSha256,
    archiveSizeBytes: 1234,
    memberNames: ["StreamingHistory_music_0.json"],
    capturedAt,
  });
}

test("Spotify Account Data projects deterministic provisional tracks and observed plays", async () => {
  const records = [
    {
      endTime: "2026-08-29 04:01",
      artistName: "PINK FLOYD",
      trackName: "Echoes",
      msPlayed: 1_413_000,
    },
    {
      endTime: "2026-08-29 04:00",
      artistName: "Pink Floyd",
      trackName: "Echoes",
      msPlayed: 30_000,
    },
    {
      endTime: "2026-08-29 04:00",
      artistName: "Pink Floyd",
      trackName: "Echoes",
      msPlayed: 30_000,
    },
  ];
  const bundle = project(records);
  const reversed = project([...records].reverse());
  const { ajv } = await createContractValidator();
  const validateTrack = ajv.getSchema(contractSchemaIds.get("track-ref"));
  const validateEvent = ajv.getSchema(
    contractSchemaIds.get("listening-event"),
  );

  assert.equal(bundle.source_key, SPOTIFY_ACCOUNT_DATA_HISTORY_SOURCE);
  assert.equal(bundle.import_batch.data_scope, SPOTIFY_ACCOUNT_DATA_HISTORY_SCOPE);
  assert.equal(bundle.track_refs.length, 1);
  assert.equal(bundle.track_refs[0].identity_status, "provisional");
  assert.equal(bundle.listening_events.length, 3);
  assert.equal(new Set(bundle.listening_events.map((event) => event.listening_event_id)).size, 3);
  assert.deepEqual(
    bundle.listening_events.map((event) => event.listening_event_id),
    reversed.listening_events.map((event) => event.listening_event_id),
  );
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
    assert.equal(record.provenance.source_kind, "import");
    assert.equal(record.context.context_type, "unknown");
  }
  assert.equal(JSON.stringify(bundle).includes("liked"), false);
  assert.equal(JSON.stringify(bundle).includes("skipped"), false);
});

test("Spotify Account Data rejects malformed or future music records", () => {
  assert.throws(
    () =>
      project([
        {
          endTime: "2026-02-30 04:00",
          artistName: "Pink Floyd",
          trackName: "Echoes",
          msPlayed: 30_000,
        },
      ]),
    /invalid endTime/iu,
  );
  assert.throws(
    () =>
      project([
        {
          endTime: "2026-08-29 05:01",
          artistName: "Pink Floyd",
          trackName: "Echoes",
          msPlayed: 30_000,
        },
      ]),
    /later than the import time/iu,
  );
  assert.throws(
    () =>
      project([
        {
          endTime: "2026-08-29 04:00",
          artistName: "Pink Floyd",
          trackName: "Echoes",
          msPlayed: -1,
        },
      ]),
    /invalid msPlayed/iu,
  );
});

test("Spotify Account Data reader imports music segments directly from a ZIP", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-spotify-export-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Spotify Account Data");
  const archivePath = path.join(root, "spotify account data.zip");
  await mkdir(dataRoot);
  await writeFile(
    path.join(dataRoot, "StreamingHistory_music_0.json"),
    JSON.stringify([
      {
        endTime: "2026-08-29 03:58",
        artistName: "Portishead",
        trackName: "Roads",
        msPlayed: 305_000,
      },
    ]),
  );
  await writeFile(
    path.join(dataRoot, "StreamingHistory_music_1.json"),
    JSON.stringify([
      {
        endTime: "2026-08-29 04:00",
        artistName: "Pink Floyd",
        trackName: "Echoes",
        msPlayed: 30_000,
      },
    ]),
  );
  await writeFile(
    path.join(dataRoot, "SearchQueries.json"),
    JSON.stringify([
      {
        searchQuery: "private query",
        searchTime: "2026-08-29T03:57:00.000Z[UTC]",
        searchInteractionURIs: [],
        platform: "private platform",
      },
    ]),
  );
  await execFileAsync("/usr/bin/zip", [
    "-q",
    "-r",
    archivePath,
    "Spotify Account Data",
  ], { cwd: root });

  const bundle = await readSpotifyAccountDataHistoryArchive({
    archivePath,
    subjectId,
    capturedAt,
  });

  assert.equal(bundle.listening_events.length, 2);
  assert.deepEqual(bundle.import_batch.member_names, [
    "StreamingHistory_music_0.json",
    "StreamingHistory_music_1.json",
  ]);
  assert.equal(JSON.stringify(bundle).includes("private query"), false);
  assert.equal(JSON.stringify(bundle).includes(archivePath), false);
});
