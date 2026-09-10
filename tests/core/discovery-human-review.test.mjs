import assert from "node:assert/strict";
import test from "node:test";

import {
  computeBlindContentDigest,
  createHumanReviewBundle,
  createHumanReviewProfileContext,
  createPublicHumanReviewSummary,
  validateCompletedHumanReview,
  validateHumanReviewPacket,
} from "../../src/evaluation/discovery-human-review.mjs";

function sampleReport() {
  return {
    report_version: "discovery-evaluation-report/1",
    generated_at: "2026-09-02T08:52:49.595Z",
    passed: true,
    score: 100,
    runs: [
      {
        scenario_id: "profile_grounded_open_artist_similarity",
        score: 100,
        passed: true,
      },
    ],
    raw_runs: [
      {
        run_version: "discovery-run/1",
        scenario: {
          id: "profile_grounded_open_artist_similarity",
          expected_provider: "listenbrainz",
          prompt: "PRIVATE RAW PROMPT",
        },
        runtime: {
          state: "configured",
          provider: "openai-codex",
          model: "private-model-name",
        },
        tool_trace: [
          {
            event: "start",
            capability_id: "profile.summary",
          },
        ],
        human_review_contexts: [
          {
            strong_preferences: [
              {
                label: "Favorite Track",
                signal: "Saved in Spotify library",
                evidence_id: "private-evidence-id",
              },
            ],
            familiarity: [
              {
                label: "Familiar Track",
                level: "high",
                play_count: 99,
                evidence_id: "private-familiarity-id",
              },
            ],
            artist_facets: [
              { name: "Profile Artist", evidence_id: "private-artist-id" },
            ],
            genre_facets: [
              { name: "Profile Genre", evidence_id: "private-genre-id" },
            ],
            provider_signals: { provider: "spotify" },
          },
        ],
        discoveries: [
          {
            state: "resolved",
            source: { provider: "listenbrainz" },
            seed: {
              track_ref_id: "seed-private-ref",
              title: "Seed Song",
              artist_credit: "Seed Artist",
              release: "Seed Release",
            },
          },
        ],
        result: {
          status: "completed",
          playlist_plan: {
            track_count: 4,
            tracks: Array.from({ length: 4 }, (_, index) => ({
              position: index + 1,
              track_ref_id: `private-track-ref-${index + 1}`,
              title: `Recommended Track ${index + 1}`,
              artist_credit: `Recommended Artist ${index + 1}`,
              release: `Recommended Release ${index + 1}`,
              selection_reason: `Bounded explanation ${index + 1}.`,
            })),
          },
        },
      },
    ],
  };
}

test("human review profile context keeps bounded anchors without provider evidence", () => {
  const context = createHumanReviewProfileContext({
    strong_preferences: [
      {
        label: "Track One",
        signal: "Saved in Spotify library",
        evidence_id: "private-evidence-id",
      },
      { label: "track one", signal: "duplicate" },
    ],
    familiarity: [
      { label: "Track Two", level: "high", play_count: 120 },
    ],
    artist_facets: [{ name: "Artist One", evidence_id: "private-artist-id" }],
    genre_facets: [{ name: "Genre One", provider: "private-provider" }],
    coverage: { effective_listening_events: 9999 },
  });

  assert.deepEqual(context, {
    strong_preferences: [{ label: "Track One" }],
    familiarity: [{ label: "Track Two", level: "high" }],
    artist_facets: [{ name: "Artist One" }],
    genre_facets: [{ name: "Genre One" }],
  });
  assert.doesNotMatch(JSON.stringify(context), /spotify|evidence|play_count|9999/u);
});

function completedReview(packet, reviewerId, score, wouldListen = "yes") {
  const review = structuredClone(packet);
  review.reviewer = {
    reviewer_id: reviewerId,
    reviewed_at: "2026-09-02T12:00:00.000Z",
    independent: true,
  };
  for (const reviewCase of review.cases) {
    reviewCase.overall_comment = "Useful private notes.";
    for (const recommendation of reviewCase.recommendations) {
      recommendation.ratings = {
        relevance: score,
        serendipity: score,
        canonical_recording_quality: score,
        explanation_usefulness: score,
      };
      recommendation.would_listen = wouldListen;
      recommendation.comment = "Private track-level note.";
    }
  }
  return review;
}

test("human review bundle blinds provider, model, identifiers, and raw prompt", () => {
  const { packet, manifest } = createHumanReviewBundle(sampleReport(), {
    generatedAt: "2026-09-02T10:00:00.000Z",
    sourceArtifact: "/Users/example/private/discovery-run.json",
  });
  const packetText = JSON.stringify(packet);

  assert.equal(packet.privacy.classification, "private_local_review");
  assert.equal(packet.cases.length, 1);
  assert.equal(packet.cases[0].recommendations.length, 4);
  assert.equal(packet.cases[0].context.seed.title, "Seed Song");
  assert.deepEqual(packet.cases[0].context.profile_anchors, {
    strong_preferences: [{ label: "Favorite Track" }],
    familiarity: [{ label: "Familiar Track", level: "high" }],
    artist_facets: [{ name: "Profile Artist" }],
    genre_facets: [{ name: "Profile Genre" }],
  });
  assert.doesNotMatch(packetText, /listenbrainz/u);
  assert.doesNotMatch(packetText, /private-model-name/u);
  assert.doesNotMatch(packetText, /private-track-ref/u);
  assert.doesNotMatch(packetText, /PRIVATE RAW PROMPT/u);
  assert.doesNotMatch(packetText, /profile_grounded_open_artist_similarity/u);
  assert.equal(manifest.cases[0].provider, "listenbrainz");
  assert.equal(
    manifest.cases[0].scenario_id,
    "profile_grounded_open_artist_similarity",
  );
  assert.equal(manifest.source.artifact_basename, "discovery-run.json");
});

test("completed human review requires every bounded rating and intent answer", () => {
  const { packet } = createHumanReviewBundle(sampleReport());
  const review = completedReview(packet, "judge-01", 4, "maybe");

  const validation = validateCompletedHumanReview(review);

  assert.equal(validation.reviewer_id, "judge-01");
  assert.equal(validation.independent, true);
  assert.equal(validation.case_count, 1);
  assert.equal(validation.recommendation_count, 4);

  review.cases[0].recommendations[0].ratings.relevance = null;
  assert.throws(
    () => validateCompletedHumanReview(review),
    /relevance must be an integer from 1 to 5/u,
  );
});

test("completed human review detects tampering with blind recommendation content", () => {
  const { packet } = createHumanReviewBundle(sampleReport());
  const review = completedReview(packet, "judge-01", 4);
  review.cases[0].recommendations[0].title = "Changed after blinding";

  assert.throws(
    () => validateCompletedHumanReview(review),
    /blind content digest does not match/u,
  );
});

test("review packet IDs cannot become form output paths", () => {
  const { packet } = createHumanReviewBundle(sampleReport());
  packet.packet_id = "dhr-/../../outside";
  packet.blind_content_sha256 = computeBlindContentDigest(packet);

  assert.throws(
    () => validateHumanReviewPacket(packet),
    /dhr- plus 16-hex format/u,
  );
});

test("public summary aggregates scores without track, reviewer, model, or path details", () => {
  const { packet, manifest } = createHumanReviewBundle(sampleReport(), {
    sourceArtifact: "/Users/example/private/discovery-run.json",
  });
  const reviews = [
    completedReview(packet, "judge-alpha", 5, "yes"),
    completedReview(packet, "judge-beta", 4, "maybe"),
    completedReview(packet, "judge-gamma", 3, "no"),
  ];

  const summary = createPublicHumanReviewSummary(
    { reviews, manifests: [manifest] },
    { generatedAt: "2026-09-02T13:00:00.000Z" },
  );
  const summaryText = JSON.stringify(summary);

  assert.equal(summary.counts.completed_reviews, 3);
  assert.equal(summary.counts.recommendation_ratings, 12);
  assert.equal(summary.dimensions.relevance.mean, 4);
  assert.equal(summary.behavioral_intent.yes, 4);
  assert.equal(summary.providers[0].provider, "listenbrainz");
  assert.equal(summary.representative_claim_gate.ready, true);
  assert.doesNotMatch(summaryText, /Recommended Track/u);
  assert.doesNotMatch(summaryText, /Seed Artist/u);
  assert.doesNotMatch(summaryText, /judge-alpha/u);
  assert.doesNotMatch(summaryText, /private-model-name/u);
  assert.doesNotMatch(summaryText, /Users\/example/u);
  assert.doesNotMatch(summaryText, /profile_grounded_open_artist_similarity/u);
});

test("public summary rejects a manifest for a different packet", () => {
  const first = createHumanReviewBundle(sampleReport());
  const changedReport = sampleReport();
  changedReport.raw_runs[0].result.playlist_plan.tracks[0].title = "Another Track";
  const second = createHumanReviewBundle(changedReport);
  const review = completedReview(first.packet, "judge-01", 4);

  assert.throws(
    () =>
      createPublicHumanReviewSummary({
        reviews: [review],
        manifests: [second.manifest],
      }),
    /No manifest was supplied for packet/u,
  );
});

test("public summary rejects manifest mappings for unknown review cases", () => {
  const { packet, manifest } = createHumanReviewBundle(sampleReport());
  const review = completedReview(packet, "judge-01", 4);
  manifest.cases.push({
    case_id: "case-unknown",
    scenario_id: "private-scenario",
    provider: "listenbrainz",
    structural_score: 100,
    structural_passed: true,
  });

  assert.throws(
    () => createPublicHumanReviewSummary({ reviews: [review], manifests: [manifest] }),
    /unknown review case/u,
  );
});
