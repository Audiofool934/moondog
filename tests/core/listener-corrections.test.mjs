import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InteractiveTasteprintDemoSession } from "../../src/demo/moondog-interactive-tasteprint-demo.mjs";

import {
  contractSchemaIds,
  createContractValidator,
  formatValidationErrors,
} from "../../scripts/contract-lib.mjs";
import { validateTasteEventSemantics } from "../../scripts/contract-semantics.mjs";
import { projectSpotifyRecentActivity } from "../../src/integrations/spotify/recent-activity.mjs";
import {
  createListenerCorrection,
  createListenerCorrectionRetraction,
} from "../../src/profile/listener-corrections.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { createSpotifyListeningProfileProjection } from "../../src/profile/spotify-archive-taste.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";

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
        },
        context_type: "album",
      },
    ],
  };
}

test("listener correction builders emit deterministic valid TasteEvent records", async () => {
  const first = createListenerCorrection({
    subjectId,
    entityType: "track",
    label: " Echoes ",
    artistCredit: "Pink Floyd",
    stance: "avoid",
    note: " Played for someone else.\u202e ",
    occurredAt: "2026-09-03T01:02:03.000Z",
    correctionId: "22222222-2222-4222-8222-222222222222",
  });
  const second = createListenerCorrection({
    subjectId,
    entityType: "track",
    label: "echoes",
    artistCredit: "pink floyd",
    stance: "avoid",
    occurredAt: "2026-09-03T01:02:03.000Z",
    correctionId: "33333333-3333-4333-8333-333333333333",
  });
  const retraction = createListenerCorrectionRetraction({
    subjectId,
    retractsCorrectionId: first.record.taste_event_id,
    occurredAt: "2026-09-03T02:00:00.000Z",
    correctionId: "44444444-4444-4444-8444-444444444444",
  });
  const { ajv } = await createContractValidator();
  const validate = ajv.getSchema(contractSchemaIds.get("taste-event"));

  assert.equal(first.record.target.entity_id, second.record.target.entity_id);
  assert.equal(first.targetKey, second.targetKey);
  assert.equal(first.record.note, "Played for someone else.");
  assert.equal(first.record.signal_type, "avoidance");
  assert.equal(first.record.polarity, "negative");
  for (const record of [first.record, retraction]) {
    assert.equal(validate(record), true, formatValidationErrors(validate.errors));
    assert.equal(
      validateTasteEventSemantics(record).ok,
      true,
      JSON.stringify(validateTasteEventSemantics(record).issues),
    );
  }
});

test("listener corrections supersede, retract, and visibly update the next profile", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-corrections-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening.sqlite"),
  });
  context.after(() => store.close());
  store.ingest(projectSpotifyRecentActivity({
    subjectId,
    page: recentPage(),
    capturedAt: "2026-08-29T05:00:00.000Z",
  }));

  const avoided = store.recordListenerCorrection({
    subjectId,
    entityType: "artist",
    label: "Pink Floyd",
    stance: "avoid",
    note: "This listening was contextual.",
    occurredAt: "2026-09-03T01:00:00.000Z",
    correctionId: "55555555-5555-4555-8555-555555555555",
  });
  const corrected = store.profileSummary({ subjectId, maxItems: 10 });
  const projected = createSpotifyListeningProfileProjection(corrected, {
    maxItems: 10,
    persistent: true,
  });

  assert.equal(corrected.listening_behavior.enduring_artists[0].name, "Pink Floyd");
  assert.equal(corrected.listener_assertions.avoids[0].label, "Pink Floyd");
  assert.equal(corrected.curated_preferences.avoids[0].label, "Pink Floyd");
  assert.equal(corrected.coverage.active_listener_assertions, 1);
  assert.equal(projected.artist_facets.some((item) => item.name === "Pink Floyd"), false);
  assert.equal(projected.listener_assertions.avoids[0].correction_id, avoided.correction_id);
  assert.match(
    store.explainProfileEvidence({
      subjectId,
      evidenceId: avoided.correction_id,
    }).basis_summary,
    /explicitly marked/iu,
  );

  const liked = store.recordListenerCorrection({
    subjectId,
    entityType: "artist",
    label: "Pink Floyd",
    stance: "like",
    occurredAt: "2026-09-03T02:00:00.000Z",
    correctionId: "66666666-6666-4666-8666-666666666666",
  });
  assert.equal(liked.superseded_correction_id, avoided.correction_id);
  assert.deepEqual(
    store.listListenerCorrections({ subjectId }).map((item) => item.stance),
    ["like"],
  );
  assert.deepEqual(
    store
      .listListenerCorrections({ subjectId, includeInactive: true })
      .map((item) => item.state),
    ["active", "superseded"],
  );
  const likedProfile = createSpotifyListeningProfileProjection(
    store.profileSummary({ subjectId, maxItems: 10 }),
    { maxItems: 10, persistent: true },
  );
  assert.equal(likedProfile.strong_preferences[0].label, "Pink Floyd");
  assert.match(likedProfile.strong_preferences[0].signal, /explicitly/iu);

  const retracted = store.retractListenerCorrection({
    subjectId,
    correctionId: liked.correction_id,
    occurredAt: "2026-09-03T03:00:00.000Z",
    retractionId: "77777777-7777-4777-8777-777777777777",
  });
  assert.equal(retracted.state, "retracted");
  assert.deepEqual(store.listListenerCorrections({ subjectId }), []);
  const finalProfile = store.profileSummary({ subjectId, maxItems: 10 });
  assert.equal(finalProfile.coverage.active_listener_assertions, 0);
  assert.equal(finalProfile.coverage.listener_retractions, 1);
  assert.equal(
    finalProfile.source.profile_captured_at,
    "2026-09-03T03:00:00.000Z",
  );
  await assert.rejects(
    Promise.resolve().then(() => store.retractListenerCorrection({
      subjectId,
      correctionId: liked.correction_id,
      occurredAt: "2026-09-03T04:00:00.000Z",
    })),
    { code: "listener_correction_inactive" },
  );
});

test("active corrections are filtered before bounds and revision time cannot run backward", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-correction-history-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({
    databasePath: path.join(root, "listening.sqlite"),
  });
  context.after(() => store.close());

  const earlierActive = store.recordListenerCorrection({
    subjectId,
    entityType: "artist",
    label: "Earlier Active Artist",
    stance: "like",
    occurredAt: "2026-09-01T00:00:00.000Z",
  });
  let latestRevision;
  for (let index = 0; index < 51; index += 1) {
    const timestamp = new Date(
      Date.UTC(2026, 8, 2, 0, index),
    ).toISOString();
    latestRevision = store.recordListenerCorrection({
      subjectId,
      entityType: "artist",
      label: "Frequently Revised Artist",
      stance: index % 2 === 0 ? "avoid" : "like",
      occurredAt: timestamp,
    });
  }

  assert.deepEqual(
    store
      .listListenerCorrections({ subjectId })
      .map((item) => item.label)
      .sort(),
    ["Earlier Active Artist", "Frequently Revised Artist"],
  );
  assert.equal(
    store.subjectDataStatus({ subjectId }).active_taste_assertions,
    2,
  );
  assert.throws(
    () =>
      store.recordListenerCorrection({
        subjectId,
        entityType: "artist",
        label: "Frequently Revised Artist",
        stance: "like",
        occurredAt: "2026-09-01T12:00:00.000Z",
      }),
    { code: "listener_correction_time_invalid" },
  );
  assert.throws(
    () =>
      store.retractListenerCorrection({
        subjectId,
        correctionId: earlierActive.correction_id,
        occurredAt: "2026-08-31T23:59:59.000Z",
      }),
    { code: "listener_correction_time_invalid" },
  );
  assert.equal(
    store.listListenerCorrections({ subjectId }).find(
      (item) => item.correction_id === latestRevision.correction_id,
    )?.state,
    "active",
  );
});

test("temporary corrections filter every selection, preserve history, and restore on retraction", () => {
  const selectionKeys = ["time_capsule_tracks", "rediscovery_tracks", "historical_return_tracks", "back_to_back_tracks"];
  const tracks = [
    { label: "Same Song", artist_credit: "First Artist" },
    { label: "Same Song", artist_credit: "Second Artist" },
  ];
  const base = {
    coverage: {}, strong_preferences: [], curated_preferences: {}, limitations: [],
    listening_behavior: {
      ...Object.fromEntries(selectionKeys.map((key) => [key, tracks])),
      repeat_tracks: tracks,
      history_arc: [{ year: 2024, play_count: 8 }],
    },
  };
  const original = structuredClone(base);
  for (const kind of ["demo", "private_session"]) {
    const session = new InteractiveTasteprintDemoSession({ kind, baseProfileFactory: () => structuredClone(base) });
    const correction = session.record({
      entityType: "track", label: "Same Song", artistCredit: "First Artist", stance: "avoid",
      occurredAt: "2026-09-05T00:00:00Z",
    });
    const avoided = session.profile();
    for (const key of selectionKeys) assert.deepEqual(avoided.listening_behavior[key], [tracks[1]]);
    assert.deepEqual(avoided.listening_behavior.repeat_tracks, tracks);
    assert.deepEqual(avoided.listening_behavior.history_arc, base.listening_behavior.history_arc);
    session.retract({ correctionId: correction.correction_id, occurredAt: "2026-09-05T00:01:00Z" });
    for (const key of selectionKeys) assert.deepEqual(session.profile().listening_behavior[key], tracks);
    session.record({ entityType: "artist", label: "First Artist", stance: "avoid", occurredAt: "2026-09-05T00:02:00Z" });
    for (const key of selectionKeys) assert.deepEqual(session.profile().listening_behavior[key], [tracks[1]]);
    session.record({ entityType: "artist", label: "First Artist", stance: "like", occurredAt: "2026-09-05T00:03:00Z" });
    for (const key of selectionKeys) assert.deepEqual(session.profile().listening_behavior[key], tracks);
  }
  assert.deepEqual(base, original);
});
