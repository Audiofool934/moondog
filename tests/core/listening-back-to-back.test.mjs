import assert from "node:assert/strict";
import test from "node:test";

import { createListenerCorrection } from "../../src/profile/listener-corrections.mjs";
import { projectListeningProfile } from "../../src/profile/listening-profile-projection.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";

function track(trackRefId, title, artist) {
  return {
    track_ref_id: trackRefId,
    revision: 1,
    identity_status: "resolved",
    title,
    artist_credits: [{ name: artist }],
    release: { title: `${title} Release` },
  };
}

function row(value, occurredAt, index, {
  playedMs = 180_000,
  skipped = false,
  source = "spotify-extended-history",
} = {}) {
  return {
    track: value,
    event: {
      listening_event_id: `event-${index}`,
      subject_id: subjectId,
      track_ref_id: value.track_ref_id,
      occurred_at: occurredAt,
      event_type: skipped ? "play_skipped" : "play_observed",
      played_ms: playedMs,
      extensions: { "spotify.skipped": skipped },
      provenance: {
        external_ref: { system: source },
        captured_at: "2026-09-03T00:00:00.000Z",
      },
    },
  };
}

test("back-to-back tracks expose adjacent repeat bursts without claiming intent", () => {
  const anchor = track(
    "11111111-1111-4111-8111-111111111101",
    "Looping Light",
    "North Window",
  );
  const second = track(
    "11111111-1111-4111-8111-111111111102",
    "Double Signal",
    "Glass Orchard",
  );
  const avoided = track(
    "11111111-1111-4111-8111-111111111103",
    "Muted Loop",
    "Paper Static",
  );
  const avoid = createListenerCorrection({
    subjectId,
    entityType: "track",
    label: avoided.title,
    artistCredit: avoided.artist_credits[0].name,
    stance: "avoid",
    occurredAt: "2026-09-03T00:00:00.000Z",
    correctionId: "22222222-2222-4222-8222-222222222201",
  }).record;
  const rows = [
    row(anchor, "2026-01-01T10:00:00.000Z", 1),
    row(anchor, "2026-01-01T10:05:00.000Z", 2),
    row(anchor, "2026-01-01T10:10:00.000Z", 3),
    row(second, "2026-01-01T10:15:00.000Z", 4),
    row(second, "2026-01-01T10:20:00.000Z", 5),
    row(anchor, "2026-01-01T11:00:00.000Z", 6),
    row(anchor, "2026-01-01T11:05:00.000Z", 7),
    row(anchor, "2026-01-01T12:00:00.000Z", 8),
    row(anchor, "2026-01-01T12:05:00.000Z", 9, { skipped: true }),
    row(anchor, "2026-01-01T12:10:00.000Z", 10),
    row(anchor, "2026-01-01T13:00:00.000Z", 11, { playedMs: 20_000 }),
    row(anchor, "2026-01-01T13:05:00.000Z", 12),
    row(anchor, "2026-01-01T14:00:00.000Z", 13, { source: "listenbrainz" }),
    row(anchor, "2026-01-01T14:05:00.000Z", 14, { source: "listenbrainz" }),
    row(avoided, "2026-01-01T15:00:00.000Z", 15),
    row(avoided, "2026-01-01T15:05:00.000Z", 16),
  ];

  const first = projectListeningProfile({
    subjectId,
    eventRows: rows,
    tasteEvents: [avoid],
    maxItems: 10,
  });
  const secondProjection = projectListeningProfile({
    subjectId,
    eventRows: [...rows].reverse(),
    tasteEvents: [avoid],
    maxItems: 10,
  });
  const tracks = first.summary.listening_behavior.back_to_back_tracks;

  assert.deepEqual(tracks, secondProjection.summary.listening_behavior.back_to_back_tracks);
  assert.deepEqual(
    tracks.map((item) => item.label),
    ["Looping Light", "Double Signal"],
  );
  assert.equal(tracks[0].burst_count, 2);
  assert.equal(tracks[0].maximum_consecutive_plays, 3);
  assert.equal(tracks[0].plays_in_bursts, 5);
  assert.equal(tracks[0].listening_minutes_in_bursts, 15);
  assert.equal(tracks[0].latest_burst_at, "2026-01-01T11:05:00.000Z");
  assert.equal(tracks[0].sequence_signal, "adjacent retained plays");
  assert.equal(
    tracks.some((item) => item.label === "Muted Loop"),
    false,
  );
  assert.equal(
    first.summary.listening_behavior.context
      .back_to_back_minimum_consecutive_plays,
    2,
  );
  assert.equal(
    first.summary.listening_behavior.context
      .back_to_back_minimum_played_seconds,
    30,
  );
  assert.equal(
    first.summary.listening_behavior.context
      .back_to_back_maximum_gap_minutes,
    30,
  );

  const explanation = first.explanations.get(tracks[0].evidence_id);
  assert.equal(explanation.claim.dimension, "listening.back_to_back");
  assert.match(explanation.basis_summary, /played it again right away 2 times, 5 plays in all/iu);
  assert.match(explanation.interpretation_limit, /can't tell which/iu);
  assert.ok(
    first.summary.limitations.some((item) =>
      item.includes("Played back to back means"),
    ),
  );
});
