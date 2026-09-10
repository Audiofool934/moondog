import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createHumanReviewBundle } from "../../src/evaluation/discovery-human-review.mjs";
import { renderDiscoveryReviewForm } from "../../src/evaluation/discovery-review-form.mjs";
import {
  inspectDiscoveryReviewDirectory,
  summarizeDiscoveryReviewStatus,
} from "../../src/evaluation/discovery-review-status.mjs";

const execFileAsync = promisify(execFile);

function sampleReport() {
  return {
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
          expected_provider: "listenbrainz",
          prompt: "PRIVATE RAW PROMPT",
        },
        runtime: { provider: "private-runtime", model: "private-model" },
        human_review_contexts: [
          {
            strong_preferences: [{ label: "Private Favorite" }],
            artist_facets: [{ name: "Private Profile Artist" }],
          },
        ],
        discoveries: [
          {
            source: { provider: "listenbrainz" },
            seed: {
              title: "Private Seed",
              artist_credit: "Private Seed Artist",
              release: "Private Seed Release",
            },
          },
        ],
        result: {
          status: "completed",
          playlist_plan: {
            tracks: Array.from({ length: 4 }, (_, index) => ({
              position: index + 1,
              title: `Private Recommendation ${index + 1}`,
              artist_credit: `Private Artist ${index + 1}`,
              release: `Private Release ${index + 1}`,
              selection_reason: `Private explanation ${index + 1}.`,
            })),
          },
        },
      },
    ],
  };
}

function completedReview(packet, reviewerId) {
  const review = structuredClone(packet);
  review.reviewer = {
    reviewer_id: reviewerId,
    reviewed_at: "2026-09-02T12:00:00.000Z",
    independent: true,
  };
  for (const reviewCase of review.cases) {
    for (const recommendation of reviewCase.recommendations) {
      recommendation.ratings = {
        relevance: 4,
        serendipity: 4,
        canonical_recording_quality: 4,
        explanation_usefulness: 4,
      };
      recommendation.would_listen = "yes";
    }
  }
  return review;
}

async function writeBundle(root, { withForm = true } = {}) {
  const { packet, manifest } = createHumanReviewBundle(sampleReport(), {
    generatedAt: "2026-09-02T10:00:00.000Z",
  });
  const prefix = `discovery-human-review-${packet.packet_id}`;
  await Promise.all([
    writeFile(
      path.join(root, `${prefix}.json`),
      `${JSON.stringify(packet, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(root, `${prefix}.manifest.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    ...(withForm
      ? [
          writeFile(
            path.join(root, `${prefix}.html`),
            renderDiscoveryReviewForm(packet),
            "utf8",
          ),
        ]
      : []),
  ]);
  return { packet, manifest, prefix };
}

test("review status inventories prepared bundles without leaking music context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-review-status-"));
  try {
    const { packet } = await writeBundle(root);
    const status = await inspectDiscoveryReviewDirectory(root, {
      generatedAt: "2026-09-02T13:00:00.000Z",
    });
    const serialized = JSON.stringify(status);
    const summary = summarizeDiscoveryReviewStatus(status);

    assert.equal(status.counts.packet_templates, 1);
    assert.equal(status.counts.private_manifests, 1);
    assert.equal(status.counts.review_forms, 1);
    assert.equal(status.counts.distribution_ready_bundles, 1);
    assert.equal(status.counts.completed_reviews, 0);
    assert.equal(status.claim_gate.ready, false);
    assert.equal(status.claim_gate.providers[0].missing_independent_reviewers, 3);
    assert.equal(status.claim_gate.providers[0].missing_recommendation_ratings, 12);
    assert.equal(status.bundles[0].packet_id, packet.packet_id);
    assert.doesNotMatch(serialized, /Private Favorite/u);
    assert.doesNotMatch(serialized, /Private Recommendation/u);
    assert.doesNotMatch(serialized, /Private Artist/u);
    assert.doesNotMatch(serialized, new RegExp(root, "u"));
    assert.match(summary, /0\/3 independent reviewers/u);
    assert.match(summary, /0\/12 recommendation ratings/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review status reaches the bounded claim gate with three independent reviews", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-review-ready-"));
  try {
    const { packet } = await writeBundle(root);
    for (const reviewerId of ["judge-alpha", "judge-beta", "judge-gamma"]) {
      await writeFile(
        path.join(root, `completed-${packet.packet_id}-${reviewerId}.json`),
        `${JSON.stringify(completedReview(packet, reviewerId), null, 2)}\n`,
        "utf8",
      );
    }

    const status = await inspectDiscoveryReviewDirectory(root);
    const serialized = JSON.stringify(status);

    assert.equal(status.counts.completed_reviews, 3);
    assert.equal(status.counts.reviewers, 3);
    assert.equal(status.counts.independent_reviewers, 3);
    assert.equal(status.claim_gate.ready, true);
    assert.equal(status.claim_gate.providers[0].recommendation_ratings, 12);
    assert.equal(status.bundles[0].completed_reviews, 3);
    assert.doesNotMatch(serialized, /judge-alpha|judge-beta|judge-gamma/u);
    assert.equal(status.next_actions.at(-1).code, "publish_aggregate_only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review status reports a missing form and invalid completed review", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-review-invalid-"));
  try {
    const { packet } = await writeBundle(root, { withForm: false });
    const invalid = completedReview(packet, "judge-invalid");
    invalid.cases[0].recommendations[0].ratings.relevance = null;
    await writeFile(
      path.join(root, `completed-${packet.packet_id}-judge-invalid.json`),
      `${JSON.stringify(invalid, null, 2)}\n`,
      "utf8",
    );

    const status = await inspectDiscoveryReviewDirectory(root);

    assert.equal(status.counts.completed_reviews, 0);
    assert.equal(status.counts.invalid_artifacts, 1);
    assert.equal(status.invalid_artifacts[0].code, "invalid_completed_review");
    assert.deepEqual(status.bundles[0].issues, [
      "missing_review_form",
      "no_completed_reviews",
    ]);
    assert.ok(
      status.next_actions.some((action) => action.code === "create_missing_form"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("form command regenerates a self-contained browser review surface", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-review-form-cli-"));
  try {
    const { packet, prefix } = await writeBundle(root, { withForm: false });
    const packetPath = path.join(root, `${prefix}.json`);
    const formPath = path.join(root, `${prefix}.html`);
    const scriptPath = path.resolve("scripts/review-discovery.mjs");
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "form",
      "--packet",
      packetPath,
      "--output",
      formPath,
      "--json",
    ]);
    const result = JSON.parse(stdout);
    const html = await readFile(formPath, "utf8");

    assert.equal(result.packet_id, packet.packet_id);
    assert.equal(result.review_form, formPath);
    assert.match(html, /Content-Security-Policy/u);
    assert.match(html, /connect-src 'none'/u);
    assert.match(html, /Download completed review/u);
    assert.doesNotMatch(html, /https?:\/\//u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review status treats a missing input directory as an empty setup", async () => {
  const root = path.join(
    tmpdir(),
    `moondog-review-missing-${process.pid}-${Date.now()}`,
  );
  const status = await inspectDiscoveryReviewDirectory(root);

  assert.equal(status.directory_exists, false);
  assert.equal(status.counts.packet_templates, 0);
  assert.equal(status.claim_gate.ready, false);
  assert.equal(status.next_actions[0].code, "create_packet");
});
