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

function rowsFor(value, prefix, dates, skipped = []) {
  return dates.map((occurredAt, index) => ({
    track: value,
    event: {
      listening_event_id: `${prefix}-${index}`,
      subject_id: subjectId,
      track_ref_id: value.track_ref_id,
      occurred_at: occurredAt,
      event_type: skipped[index] ? "play_skipped" : "play_observed",
      played_ms: 300_000,
      extensions: { "spotify.skipped": skipped[index] ?? false },
      provenance: {
        external_ref: { system: "spotify-extended-history" },
        captured_at: "2026-09-03T00:00:00.000Z",
      },
    },
  }));
}

test("historical returns expose repeated long-gap recurrence without claiming preference", () => {
  const recurring = track(
    "11111111-1111-4111-8111-111111111101",
    "Recurring Light",
    "North Window",
  );
  const oneReturn = track(
    "11111111-1111-4111-8111-111111111102",
    "One Return",
    "Glass Orchard",
  );
  const recentOnly = track(
    "11111111-1111-4111-8111-111111111103",
    "Close Together",
    "Soft Relay",
  );
  const tooThin = track(
    "11111111-1111-4111-8111-111111111104",
    "Thin Echo",
    "Paper Static",
  );
  const avoided = track(
    "11111111-1111-4111-8111-111111111105",
    "Avoided Return",
    "Muted Current",
  );
  const avoid = createListenerCorrection({
    subjectId,
    entityType: "track",
    label: avoided.title,
    artistCredit: avoided.artist_credits[0].name,
    stance: "avoid",
    occurredAt: "2026-08-30T00:00:00.000Z",
    correctionId: "22222222-2222-4222-8222-222222222201",
  }).record;

  const projected = projectListeningProfile({
    subjectId,
    eventRows: [
      ...rowsFor(recurring, "recurring", [
        "2020-01-01T00:00:00.000Z",
        "2021-01-01T00:00:00.000Z",
        "2022-01-01T00:00:00.000Z",
      ]),
      ...rowsFor(oneReturn, "one-return", [
        "2020-02-01T00:00:00.000Z",
        "2020-02-02T00:00:00.000Z",
        "2022-02-01T00:00:00.000Z",
      ]),
      ...rowsFor(recentOnly, "close", [
        "2025-01-01T00:00:00.000Z",
        "2025-02-01T00:00:00.000Z",
        "2025-03-01T00:00:00.000Z",
      ]),
      ...rowsFor(tooThin, "thin", [
        "2020-01-01T00:00:00.000Z",
        "2022-01-01T00:00:00.000Z",
      ]),
      ...rowsFor(avoided, "avoided", [
        "2020-03-01T00:00:00.000Z",
        "2021-03-01T00:00:00.000Z",
        "2022-03-01T00:00:00.000Z",
      ]),
    ],
    tasteEvents: [avoid],
    maxItems: 10,
  });
  const returns = projected.summary.listening_behavior.historical_return_tracks;

  assert.deepEqual(
    returns.map((item) => item.label),
    ["Recurring Light", "One Return"],
  );
  assert.equal(returns[0].return_count, 2);
  assert.equal(returns[0].longest_gap_days, 366);
  assert.equal(returns[0].latest_return_at, "2022-01-01T00:00:00.000Z");
  assert.equal(returns[0].latest_return_gap_days, 365);
  assert.equal(returns[0].historical_return_signal, "historical attention only");
  assert.equal(
    projected.summary.listening_behavior.context
      .historical_return_minimum_gap_days,
    180,
  );
  assert.equal(
    projected.summary.listening_behavior.context
      .historical_return_minimum_engaged_plays,
    3,
  );
  assert.equal(
    returns.some((item) => item.label === "Avoided Return"),
    false,
  );

  const explanation = projected.explanations.get(returns[0].evidence_id);
  assert.equal(explanation.claim.dimension, "listening.historical_return");
  assert.match(explanation.basis_summary, /2 observed return gaps/iu);
  assert.match(explanation.interpretation_limit, /not proof of liking/iu);
});
