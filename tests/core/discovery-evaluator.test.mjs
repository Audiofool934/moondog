import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiscoveryScenarios,
  evaluateDiscoveryRun,
} from "../../src/evaluation/discovery-evaluator.mjs";

function toolTrace(capabilities) {
  return capabilities.flatMap((capabilityId, index) => [
    {
      event: "start",
      capability_id: capabilityId,
      tool_name: `tool_${index}`,
    },
    {
      event: "end",
      capability_id: capabilityId,
      tool_name: `tool_${index}`,
      is_error: false,
    },
  ]);
}

function knownness() {
  return {
    imported_library: "not_found_by_exact_title_artist",
    listening_history: "not_checked",
  };
}

function baseRun(scenario, discoveryTracks, source, seed) {
  const planTracks = discoveryTracks
    .slice(0, scenario.requested_track_count)
    .map((track, index) => ({
      position: index + 1,
      track_ref_id: track.track_ref_id,
      title: track.title,
      artist_credit: track.artist_credit,
      release: track.release,
      candidate_scope: "external_catalog",
      selection_reason: "Grounded provider candidate.",
    }));
  return {
    scenario,
    tool_trace: toolTrace(scenario.required_capabilities),
    discoveries: [
      {
        state: "resolved",
        source,
        seed,
        tracks: discoveryTracks,
      },
    ],
    result: {
      status: "completed",
      text: [
        "新颖性边界：这不代表你从未听过。",
        "校验范围：本地 planner 校验身份和候选集。",
        source.provider === "apple_music"
          ? "发现来源：Apple Music US storefront 关键词目录，检索于 2026-09-02。"
          : "发现来源：ListenBrainz 协同艺人相邻与 Wikidata 身份，检索于 2026-09-02，CC0 inputs；这不是音频相似。",
      ].join("\n"),
      playlist_plan: {
        track_count: planTracks.length,
        candidate_scope: "external_catalog",
        tracks: planTracks,
      },
    },
  };
}

test("discovery evaluator passes a grounded diverse Apple run", () => {
  const scenario = createDiscoveryScenarios()[0];
  const tracks = [
    ["60000000-0000-4000-8000-000000000001", "Track A", "Artist A", "Release A"],
    ["60000000-0000-4000-8000-000000000002", "Track B", "Artist B", "Release B"],
    ["60000000-0000-4000-8000-000000000003", "Track C", "Artist C", "Release C"],
  ].map(([trackRefId, title, artistCredit, release]) => ({
    track_ref_id: trackRefId,
    title,
    artist_credit: artistCredit,
    release,
    candidate_scope: "external_catalog",
    catalog_provider: "apple_music",
    matched_queries: ["grounded query"],
    knownness: knownness(),
  }));
  const run = baseRun(
    scenario,
    tracks,
    {
      provider: "apple_music",
      coverage:
        "Keyword relevance only. Results are not proof of personal fit or novelty.",
    },
  );

  const evaluation = evaluateDiscoveryRun(run);

  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.score, 100);
  assert.equal(evaluation.metrics.distinct_artists, 3);
});

test("discovery evaluator passes an open collaborative similarity run", () => {
  const scenario = createDiscoveryScenarios({ seedQuery: "Portishead" })[1];
  const tracks = [
    ["61000000-0000-4000-8000-000000000001", "Track A", "Artist A", "Release A"],
    ["61000000-0000-4000-8000-000000000002", "Track B", "Artist B", "Release B"],
    ["61000000-0000-4000-8000-000000000003", "Track C", "Artist C", "Release C"],
    ["61000000-0000-4000-8000-000000000004", "Track D", "Artist D", "Release D"],
  ].map(([trackRefId, title, artistCredit, release]) => ({
    track_ref_id: trackRefId,
    title,
    artist_credit: artistCredit,
    release,
    candidate_scope: "external_catalog",
    catalog_provider: "listenbrainz",
    knownness: knownness(),
    discovery_basis: {
      kind: "listenbrainz_collaborative_artist_similarity",
      seed_artist: "Portishead",
      adjacent_artist: artistCredit,
      mode: "medium",
    },
  }));
  const run = baseRun(
    scenario,
    tracks,
    {
      provider: "listenbrainz",
      identity_provider: "wikidata",
      license: "CC0 structured input data.",
      coverage: "Listening-derived adjacency, not audio similarity.",
    },
    {
      canonical_artist_name: "Portishead",
    },
  );

  const evaluation = evaluateDiscoveryRun(run);

  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.score, 100);
  assert.equal(evaluation.metrics.distinct_artists, 4);
});

test("discovery evaluator fails a plan containing an untrusted track", () => {
  const scenario = createDiscoveryScenarios()[0];
  const tracks = [
    ["62000000-0000-4000-8000-000000000001", "Track A", "Artist A", "Release A"],
    ["62000000-0000-4000-8000-000000000002", "Track B", "Artist B", "Release B"],
    ["62000000-0000-4000-8000-000000000003", "Track C", "Artist C", "Release C"],
  ].map(([trackRefId, title, artistCredit, release]) => ({
    track_ref_id: trackRefId,
    title,
    artist_credit: artistCredit,
    release,
    candidate_scope: "external_catalog",
    catalog_provider: "apple_music",
    matched_queries: ["grounded query"],
    knownness: knownness(),
  }));
  const run = baseRun(
    scenario,
    tracks,
    {
      provider: "apple_music",
      coverage:
        "Keyword relevance only. Results are not proof of personal fit or novelty.",
    },
  );
  run.result.playlist_plan.tracks[0].track_ref_id =
    "62000000-0000-4000-8000-999999999999";

  const evaluation = evaluateDiscoveryRun(run);

  assert.equal(evaluation.passed, false);
  assert.ok(evaluation.critical_failures.includes("trusted_provider_membership"));
});
