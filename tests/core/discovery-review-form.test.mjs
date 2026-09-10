import assert from "node:assert/strict";
import test from "node:test";

import { createHumanReviewBundle } from "../../src/evaluation/discovery-human-review.mjs";
import { renderDiscoveryReviewForm } from "../../src/evaluation/discovery-review-form.mjs";

function reviewPacket({ title = "Recommended Track" } = {}) {
  const report = {
    report_version: "discovery-evaluation-report/1",
    generated_at: "2026-09-02T08:52:49.595Z",
    runs: [
      {
        scenario_id: "profile_grounded_open_artist_similarity",
        score: 100,
        passed: true,
      },
    ],
    raw_runs: [
      {
        scenario: {
          id: "profile_grounded_open_artist_similarity",
          expected_provider: "private-provider-name",
          prompt: "PRIVATE RAW PROMPT",
        },
        runtime: {
          provider: "private-model-provider",
          model: "private-model-name",
        },
        human_review_contexts: [
          {
            strong_preferences: [{ label: "Favorite Track" }],
            familiarity: [{ label: "Familiar Track", level: "high" }],
            artist_facets: [{ name: "Profile Artist" }],
            genre_facets: [{ name: "Profile Genre" }],
          },
        ],
        discoveries: [
          {
            source: { provider: "private-provider-name" },
            seed: {
              title: "Seed Song",
              artist_credit: "Seed Artist",
              release: "Seed Release",
            },
          },
        ],
        result: {
          status: "completed",
          playlist_plan: {
            tracks: [
              {
                position: 1,
                title,
                artist_credit: "Recommended Artist",
                release: "Recommended Release",
                selection_reason: "Bounded explanation.",
              },
            ],
          },
        },
      },
    ],
  };
  return createHumanReviewBundle(report, {
    generatedAt: "2026-09-02T10:00:00.000Z",
    sourceArtifact: "/Users/example/private/discovery-run.json",
  }).packet;
}

test("review form is self-contained, blinded, and complete", () => {
  const html = renderDiscoveryReviewForm(reviewPacket());
  const executableScript = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/gu)].at(
    -1,
  )?.[1];

  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /connect-src 'none'/u);
  assert.doesNotMatch(html, /https?:\/\//u);
  assert.match(html, /Favorite Track/u);
  assert.match(html, /Seed Song/u);
  assert.match(html, /Recommended Track/u);
  assert.match(html, /Relevance/u);
  assert.match(html, /Serendipity/u);
  assert.match(html, /Canonical recording quality/u);
  assert.match(html, /Explanation usefulness/u);
  assert.match(html, /Would you choose to listen/u);
  assert.match(html, /Download completed review/u);
  assert.match(html, /completed-' \+ review\.packet_id/u);
  assert.doesNotMatch(html, /private-provider-name/u);
  assert.doesNotMatch(html, /private-model-name/u);
  assert.doesNotMatch(html, /PRIVATE RAW PROMPT/u);
  assert.doesNotMatch(html, /Users\/example/u);
  assert.doesNotThrow(() => new Function(executableScript));
});

test("review form escapes packet values that could end the JSON script", () => {
  const title = "</script><img src=x onerror=alert(1)>";
  const html = renderDiscoveryReviewForm(reviewPacket({ title }));

  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/u);
  assert.match(html, /\\u003c\/script\\u003e\\u003cimg/u);
});

test("review form rejects packet content changed after blinding", () => {
  const packet = reviewPacket();
  packet.cases[0].recommendations[0].title = "Changed after blinding";

  assert.throws(
    () => renderDiscoveryReviewForm(packet),
    /blind content digest is invalid/u,
  );
});
