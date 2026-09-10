import assert from "node:assert/strict";
import test from "node:test";

import { projectListeningProfile } from "../../src/profile/listening-profile-projection.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";

function eventRow({ occurredAt, artist, title, playedMs }) {
  const trackRefId = `${artist}:${title}`;
  return {
    event: {
      occurred_at: occurredAt,
      played_ms: playedMs,
      event_type: "play_completed",
      extensions: {},
    },
    track: {
      track_ref_id: trackRefId,
      identity_status: "resolved",
      title,
      artist_credits: [{ name: artist, role: "primary" }],
    },
  };
}

test("listening continuity separates artists that stayed from year-to-year turnover", () => {
  const { summary, explanations } = projectListeningProfile({
    subjectId,
    eventRows: [
      eventRow({
        occurredAt: "2023-02-01T12:00:00.000Z",
        artist: "Anchor Artist",
        title: "First Anchor",
        playedMs: 200_000,
      }),
      eventRow({
        occurredAt: "2023-04-01T12:00:00.000Z",
        artist: "Legacy Artist",
        title: "Legacy Song",
        playedMs: 180_000,
      }),
      eventRow({
        occurredAt: "2024-03-01T12:00:00.000Z",
        artist: "Anchor Artist",
        title: "Second Anchor",
        playedMs: 220_000,
      }),
      eventRow({
        occurredAt: "2024-05-01T12:00:00.000Z",
        artist: "Middle Artist",
        title: "Middle Song",
        playedMs: 300_000,
      }),
      eventRow({
        occurredAt: "2026-06-01T12:00:00.000Z",
        artist: "Anchor Artist",
        title: "Current Anchor",
        playedMs: 240_000,
      }),
      eventRow({
        occurredAt: "2026-08-01T12:00:00.000Z",
        artist: "New Artist",
        title: "New Song",
        playedMs: 400_000,
      }),
    ],
  });

  assert.deepEqual(summary.listening_behavior.artist_relationships, [
    {
      name: "Anchor Artist",
      first_year: 2023,
      last_year: 2026,
      active_years: 3,
      span_years: 4,
      play_count: 3,
      listening_minutes: 11,
      evidence_id:
        summary.listening_behavior.artist_relationships[0].evidence_id,
    },
  ]);
  assert.deepEqual(
    summary.listening_behavior.year_transitions.map((transition) => ({
      from_year: transition.from_year,
      to_year: transition.to_year,
      from_artist_count: transition.from_artist_count,
      to_artist_count: transition.to_artist_count,
      retained_artist_count: transition.retained_artist_count,
      new_artist_count: transition.new_artist_count,
      continuity_percent: transition.continuity_percent,
      retained_artists: transition.retained_artists,
      new_artists: transition.new_artists,
    })),
    [
      {
        from_year: 2023,
        to_year: 2024,
        from_artist_count: 2,
        to_artist_count: 2,
        retained_artist_count: 1,
        new_artist_count: 1,
        continuity_percent: 50,
        retained_artists: ["Anchor Artist"],
        new_artists: ["Middle Artist"],
      },
      {
        from_year: 2024,
        to_year: 2026,
        from_artist_count: 2,
        to_artist_count: 2,
        retained_artist_count: 1,
        new_artist_count: 1,
        continuity_percent: 50,
        retained_artists: ["Anchor Artist"],
        new_artists: ["New Artist"],
      },
    ],
  );
  assert.equal(summary.listening_behavior.context.relationship_minimum_years, 2);
  assert.equal(summary.listening_behavior.context.continuity_artist_limit, 10);

  const relationshipEvidence = explanations.get(
    summary.listening_behavior.artist_relationships[0].evidence_id,
  );
  assert.equal(
    relationshipEvidence.claim.dimension,
    "taste.artist_continuity",
  );
  assert.match(relationshipEvidence.basis_summary, /3 retained UTC calendar years/u);
  const transitionEvidence = explanations.get(
    summary.listening_behavior.year_transitions[0].evidence_id,
  );
  assert.equal(transitionEvidence.claim.dimension, "taste.artist_turnover");
  assert.match(transitionEvidence.interpretation_limit, /does not measure genre breadth/u);
});
