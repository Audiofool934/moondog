import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LISTENBRAINZ_HISTORY_SCOPE,
  LISTENBRAINZ_HISTORY_SOURCE,
  projectListenBrainzHistory,
  readListenBrainzHistoryFile,
} from "../../src/integrations/listenbrainz/history-file.mjs";
import {
  contractSchemaIds,
  createContractValidator,
  formatValidationErrors,
} from "../../scripts/contract-lib.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const capturedAt = "2026-09-02T06:00:00.000Z";
const recordingMbid = "30d08f4c-d825-4ae1-b79c-44242cddd7c0";
const recordingMsid = "fd0cad33-ea33-453b-8155-1292379277db";

function listen(overrides = {}) {
  return {
    listened_at: 1_772_000_000,
    recording_msid: recordingMsid,
    user_name: "PRIVATE_LISTENBRAINZ_USER_SENTINEL",
    track_metadata: {
      artist_name: "Röyksopp",
      track_name: "Some Resolve",
      release_name: "Profound Mysteries II",
      additional_info: {
        duration_ms: 402_390,
        duration_played: 301,
        recording_mbid: "UNTRUSTED_CLIENT_MBID_SENTINEL",
        origin_url: "https://private.example/listen-sentinel",
        tags: ["PRIVATE_TAG_SENTINEL"],
        submission_client: "PRIVATE_CLIENT_SENTINEL",
      },
      mbid_mapping: {
        recording_mbid: recordingMbid,
        recording_name: "Some Resolve",
        url_rels: [
          {
            type: "streaming",
            url: "https://private.example/mapping-sentinel",
          },
        ],
      },
    },
    ...overrides,
  };
}

function response(records) {
  return {
    payload: {
      count: records.length,
      user_id: "PRIVATE_LISTENBRAINZ_USER_SENTINEL",
      listens: records,
    },
  };
}

function project(document) {
  return projectListenBrainzHistory({
    subjectId,
    document,
    fileSha256: "a".repeat(64),
    fileSizeBytes: 4_096,
    memberName: "listen-history.json",
    capturedAt,
  });
}

test("ListenBrainz history produces provider-neutral contracts without retaining private source fields", async () => {
  const records = [
    listen(),
    listen({
      listened_at: 1_742_000_000,
      recording_msid: null,
      user_name: "SECOND_PRIVATE_USER_SENTINEL",
      track_metadata: {
        artist_name: "Portishead",
        track_name: "Roads",
        release_name: "Dummy",
        additional_info: {
          duration: 305,
          recording_mbid: "SECOND_UNTRUSTED_MBID_SENTINEL",
          media_player: "PRIVATE_PLAYER_SENTINEL",
        },
      },
    }),
  ];
  const bundle = project(response(records));
  const reversed = project(response([...records].reverse()));
  const { ajv } = await createContractValidator();
  const validateTrack = ajv.getSchema(contractSchemaIds.get("track-ref"));
  const validateEvent = ajv.getSchema(contractSchemaIds.get("listening-event"));

  assert.equal(bundle.source_key, LISTENBRAINZ_HISTORY_SOURCE);
  assert.equal(bundle.import_batch.data_scope, LISTENBRAINZ_HISTORY_SCOPE);
  assert.equal(bundle.track_refs.length, 2);
  assert.equal(bundle.listening_events.length, 2);
  assert.deepEqual(
    bundle.listening_events.map((event) => event.listening_event_id),
    reversed.listening_events.map((event) => event.listening_event_id),
  );
  const resolved = bundle.track_refs.find(
    (track) => track.identity_status === "resolved",
  );
  const provisional = bundle.track_refs.find(
    (track) => track.identity_status === "provisional",
  );
  assert.equal(
    resolved.external_refs.find((ref) => ref.system === "musicbrainz")
      .external_id,
    recordingMbid,
  );
  assert.equal(provisional.title, "Roads");
  assert.equal(
    bundle.listening_events.find((event) => event.played_ms === 301_000)
      .event_type,
    "play_observed",
  );
  assert.equal(
    bundle.listening_events.filter((event) => event.played_ms === undefined)
      .length,
    1,
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
  }
  const serialized = JSON.stringify(bundle);
  for (const sentinel of [
    "PRIVATE_LISTENBRAINZ_USER_SENTINEL",
    "SECOND_PRIVATE_USER_SENTINEL",
    "UNTRUSTED_CLIENT_MBID_SENTINEL",
    "SECOND_UNTRUSTED_MBID_SENTINEL",
    "PRIVATE_TAG_SENTINEL",
    "PRIVATE_CLIENT_SENTINEL",
    "PRIVATE_PLAYER_SENTINEL",
    "private.example",
  ]) {
    assert.equal(serialized.includes(sentinel), false);
  }
});

test("ListenBrainz history accepts official single submissions and rejects non-history shapes", () => {
  const submission = project({
    listen_type: "single",
    payload: [
      {
        listened_at: 1_772_000_000,
        track_metadata: {
          artist_name: "Rick Astley",
          track_name: "Never Gonna Give You Up",
        },
      },
    ],
  });
  assert.equal(submission.listening_events.length, 1);

  assert.throws(
    () =>
      project({
        listen_type: "playing_now",
        payload: [listen({ listened_at: undefined })],
      }),
    /not persistent listening history/iu,
  );
  assert.throws(
    () =>
      project({
        listen_type: "single",
        payload: [
          {
            listened_at: 1_772_000_000,
            track_metadata: listen().track_metadata,
          },
        ],
      }),
    /read-only mbid_mapping/iu,
  );
  assert.throws(
    () =>
      project({
        payload: {
          count: 1,
          user_id: "listener",
          playing_now: true,
          listens: [listen()],
        },
      }),
    /not persistent listening history/iu,
  );
  assert.throws(
    () =>
      project(
        response([
          listen({
            track_metadata: {
              artist_name: "Röyksopp",
              track_name: "Some Resolve",
              mbid_mapping: { recording_mbid: "not-a-recording-mbid" },
            },
          }),
        ]),
      ),
    /invalid mbid_mapping/iu,
  );
  assert.throws(
    () =>
      project(
        response([
          listen({
            track_metadata: {
              artist_name: "Röyksopp",
              track_name: "Some Resolve",
              additional_info: { duration: 402, duration_ms: 402_000 },
            },
          }),
        ]),
      ),
    /both duration_ms and duration/iu,
  );
  assert.throws(
    () => project(response([listen({ listened_at: 2_000_000_000 })])),
    /invalid listened_at/iu,
  );
});

test("ListenBrainz file reader uses a basename manifest and rejects symbolic links", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-listenbrainz-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "listen history.json");
  const document = response([listen()]);
  const source = Buffer.from(JSON.stringify(document));
  await writeFile(filePath, source, { mode: 0o600 });

  const bundle = await readListenBrainzHistoryFile({
    filePath,
    subjectId,
    capturedAt,
  });
  assert.deepEqual(bundle.import_batch.member_names, ["listen history.json"]);
  assert.equal(
    bundle.import_batch.archive_sha256,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.equal(JSON.stringify(bundle).includes(root), false);

  const linkPath = path.join(root, "linked.json");
  await symlink(filePath, linkPath);
  await assert.rejects(
    readListenBrainzHistoryFile({
      filePath: linkPath,
      subjectId,
      capturedAt,
    }),
    /could not be opened safely/iu,
  );
});
