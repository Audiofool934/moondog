import assert from "node:assert/strict";
import test from "node:test";

import {
  DomainServiceError,
  SYNTHETIC_DOMAIN_LIMITS,
  createSyntheticDomainServices,
} from "../../src/core/synthetic-domain-services.mjs";

const trustedSubject = "trusted-subject-private-marker";
const foreignSubject = "foreign-subject-private-marker";
const trustedEvidenceId = "30000000-0000-4000-8000-000000000001";
const foreignEvidenceId = "30000000-0000-4000-8000-000000000002";

async function assertDomainRejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof DomainServiceError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function evidenceRecord(subjectId, evidenceId, value) {
  return {
    subject_id: subjectId,
    evidence_id: evidenceId,
    claim: {
      dimension: "preference.artist",
      value,
      direction: "supports",
    },
    basis_summary: "An explicit synthetic signal supports this bounded claim.",
    derivation: {
      kind: "rule",
      name: "synthetic-explicit-signal",
      version: "1",
    },
    confidence: 0.8,
    interpretation_limit: "This is a scoped synthetic signal, not a personality score.",
    raw_basis_refs: ["private-basis-record"],
  };
}

function largeScopedFixture() {
  const tracks = Array.from({ length: 20 }, (_, index) => ({
    subject_id: trustedSubject,
    track_ref_id: `trusted-track-${String(index + 1).padStart(2, "0")}`,
    title: `Synthetic Track ${index + 1} ${"x".repeat(300)}`,
    artist_credit: `Trusted Artist ${index + 1}`,
    release: "Bounded Results",
    duration_ms: 180000 + index,
    labels: {
      genres: ["Ambient", "Electronic", "Jazz", "Dream Pop", "Hidden Fifth"],
      composer: "Synthetic Composer",
    },
    observation: {
      preference_signals: index % 2 === 0 ? ["loved"] : [],
      familiarity: index % 3 === 0 ? "high" : "low",
      play_count: index,
    },
    search_terms: ["bounded", "night"],
    rank: 100 - index,
    provider_id: `private-provider-id-${index}`,
    source_path: `/private/library/${index}.m4a`,
    raw_observation: { snapshot_row: index },
  }));
  tracks.push({
    subject_id: foreignSubject,
    track_ref_id: "foreign-track",
    title: "Foreign Scope Track",
    artist_credit: "Foreign Artist",
    release: "Must Not Appear",
    labels: { genres: ["Foreign"] },
    observation: { familiarity: "high", play_count: 999 },
    search_terms: ["bounded", "night"],
    rank: 1000,
  });

  const summaryItems = Array.from({ length: 20 }, (_, index) => ({
    label: `Preference ${index + 1} ${"p".repeat(300)}`,
    signal: "loved",
    evidence_id: trustedEvidenceId,
  }));
  return {
    tracks,
    profiles: [
      {
        subject_id: trustedSubject,
        strong_preferences: [
          {
            label: "Cross-scope evidence must not appear",
            signal: "loved",
            evidence_id: foreignEvidenceId,
          },
          ...summaryItems,
        ],
        familiarity: summaryItems.map((item, index) => ({
          label: item.label,
          level: index % 2 === 0 ? "high" : "low",
          play_count: index,
          evidence_id: trustedEvidenceId,
        })),
        artist_facets: summaryItems.map((item) => ({
          name: item.label,
          evidence_id: trustedEvidenceId,
        })),
        genre_facets: summaryItems.map((item) => ({
          name: item.label,
          evidence_id: trustedEvidenceId,
        })),
        coverage: {
          tracks_observed: 20,
          loved_or_favorited: 10,
          aggregate_play_count: 20,
          non_computed_rating: 0,
        },
        source: { captured_at: "2026-08-25T00:00:00.000Z" },
        limitations: ["one", "two", "three", "four", "hidden fifth"],
        private_profile_blob: { account: "private-account-marker" },
      },
      {
        subject_id: foreignSubject,
        strong_preferences: [
          {
            label: "Foreign Preference",
            signal: "loved",
            evidence_id: foreignEvidenceId,
          },
        ],
      },
    ],
    evidence: [
      evidenceRecord(trustedSubject, trustedEvidenceId, "Trusted Artist"),
      evidenceRecord(foreignSubject, foreignEvidenceId, "Foreign Artist"),
    ],
  };
}

function planArguments(search, count = search.tracks.length) {
  return {
    intent: `Find ${count} tracks for a late-night drive.`,
    requestedTrackCount: count,
    candidateSetIds: [search.candidate_set_id],
    trackRefs: search.tracks.slice(0, count).map((track, index) => ({
      trackRefId: track.track_ref_id,
      selectionReason: `Selection ${index + 1} supports the requested arc.`,
    })),
    orderingNotes: "Move from familiar signals toward less familiar material.",
  };
}

test("trusted subject scope is construction-only and readiness is safe", async () => {
  assert.throws(
    () => createSyntheticDomainServices(),
    (error) => {
      assert.equal(error.code, "trusted_subject_scope_required");
      return true;
    },
  );

  const services = createSyntheticDomainServices({
    subjectScope: { subjectId: trustedSubject },
  });
  assert.deepEqual(services.status(), {
    state: "ready",
    adapter: "synthetic",
    subject_scope: "trusted_runtime",
    candidate_scope: "prompt_local",
    external_effects: "none",
  });

  await assertDomainRejects(
    services.searchLibrary({
      query: "night",
      subjectId: foreignSubject,
    }),
    "invalid_arguments",
  );
  assert.equal(JSON.stringify(services.status()).includes(trustedSubject), false);
});

test("library search scopes, redacts, and hard-caps final results", async () => {
  const services = createSyntheticDomainServices({
    subjectScope: trustedSubject,
    fixture: largeScopedFixture(),
  });
  const result = await services.searchLibrary({
    query: "bounded night",
    limit: 10_000,
  });

  assert.equal(result.limit_applied, SYNTHETIC_DOMAIN_LIMITS.searchMax);
  assert.equal(result.tracks.length, SYNTHETIC_DOMAIN_LIMITS.searchMax);
  assert.equal(result.result_count, SYNTHETIC_DOMAIN_LIMITS.searchMax);
  assert.equal(result.offset_applied, 0);
  assert.equal(result.next_offset, SYNTHETIC_DOMAIN_LIMITS.searchMax);
  assert.equal(result.has_more, true);
  assert.equal(result.expires_on, "prompt_end");
  assert.equal(
    result.tracks.every(
      (track) =>
        track.title.length <= SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax &&
        track.labels.genres.length <= SYNTHETIC_DOMAIN_LIMITS.labelsMax,
    ),
    true,
  );

  const nextPage = await services.searchLibrary({
    query: "bounded night",
    limit: 4,
    offset: SYNTHETIC_DOMAIN_LIMITS.searchMax,
  });
  assert.equal(nextPage.offset_applied, SYNTHETIC_DOMAIN_LIMITS.searchMax);
  assert.equal(
    nextPage.next_offset,
    SYNTHETIC_DOMAIN_LIMITS.searchMax + 4,
  );
  assert.equal(nextPage.has_more, true);
  assert.equal(nextPage.tracks.length, 4);
  assert.equal(
    nextPage.tracks.some((track) =>
      result.tracks.some((firstTrack) => firstTrack.track_ref_id === track.track_ref_id),
    ),
    false,
  );

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    trustedSubject,
    foreignSubject,
    "Foreign Scope Track",
    "private-provider-id",
    "/private/library",
    "raw_observation",
    "source_path",
    "subject_id",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const filtered = await services.searchLibrary({
    query: "night",
    filters: {
      genres: ["Ambient"],
      familiarity: ["high"],
      preferenceSignals: ["loved"],
    },
  });
  assert.equal(filtered.tracks.length > 0, true);
  assert.equal(
    filtered.tracks.every(
      (track) =>
        track.labels.genres.includes("Ambient") &&
        track.observation_summary.familiarity.level === "high" &&
        track.observation_summary.preference_signals.includes("loved"),
    ),
    true,
  );

  await assertDomainRejects(
    services.searchLibrary({
      query: "night",
      filters: { familiarity: ["very_high"] },
    }),
    "invalid_filters",
  );
  await assertDomainRejects(
    services.searchLibrary({ query: "q".repeat(257) }),
    "invalid_query",
  );
});

test("profile projections and evidence explanations are scoped and bounded", async () => {
  const services = createSyntheticDomainServices({
    subjectScope: trustedSubject,
    fixture: largeScopedFixture(),
  });
  const summary = await services.getProfileSummary({ maxItems: 10_000 });

  assert.equal(summary.max_items_applied, SYNTHETIC_DOMAIN_LIMITS.profileMax);
  assert.equal(summary.strong_preferences.length, SYNTHETIC_DOMAIN_LIMITS.profileMax);
  assert.equal(summary.familiarity.length, SYNTHETIC_DOMAIN_LIMITS.profileMax);
  assert.equal(summary.artist_facets.length, SYNTHETIC_DOMAIN_LIMITS.profileMax);
  assert.equal(summary.genre_facets.length, SYNTHETIC_DOMAIN_LIMITS.profileMax);
  assert.equal(summary.limitations.length, SYNTHETIC_DOMAIN_LIMITS.limitationsMax);
  assert.equal(
    summary.strong_preferences.every(
      (item) => item.label.length <= SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
    ),
    true,
  );

  const explanation = await services.explainProfileEvidence({
    evidenceId: trustedEvidenceId,
  });
  assert.equal(explanation.evidence_id, trustedEvidenceId);
  assert.equal(explanation.claim.value, "Trusted Artist");
  assert.match(explanation.interpretation_limit, /not a personality score/);

  const serialized = JSON.stringify({ summary, explanation });
  for (const forbidden of [
    trustedSubject,
    foreignSubject,
    "Foreign Preference",
    "Cross-scope evidence must not appear",
    "private-account-marker",
    "private-basis-record",
    "raw_basis_refs",
    "subject_id",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  await assertDomainRejects(
    services.explainProfileEvidence({ evidenceId: foreignEvidenceId }),
    "profile_evidence_unavailable",
  );
});

test("familiarity evidence explicitly refuses to infer liking", async () => {
  const services = createSyntheticDomainServices({
    subjectScope: trustedSubject,
  });
  const summary = await services.getProfileSummary({ maxItems: 1 });
  const explanation = await services.explainProfileEvidence({
    evidenceId: summary.familiarity[0].evidence_id,
  });

  assert.equal(summary.strong_preferences.length, 1);
  assert.equal(summary.familiarity.length, 1);
  assert.match(explanation.claim.dimension, /^familiarity\./);
  assert.equal(
    explanation.interpretation_limit,
    "Play count supports familiarity, not liking.",
  );
});

test("playlist planning accepts only the exact tracks returned by candidate sets", async () => {
  const services = createSyntheticDomainServices({
    subjectScope: trustedSubject,
  });
  const oneResult = await services.searchLibrary({ query: "night", limit: 1 });

  await assertDomainRejects(
    services.buildPlaylistPlan({
      intent: "Find one track for a late-night drive.",
      candidateSetIds: [oneResult.candidate_set_id],
      trackRefs: [
        {
          trackRefId: "10000000-0000-4000-8000-000000000002",
          selectionReason: "This known fixture track was not actually returned.",
        },
      ],
      orderingNotes: "Use the only selection.",
    }),
    "untrusted_track_ref",
  );

  const search = await services.searchLibrary({ query: "night drive", limit: 6 });
  const originalTitle = search.tracks[0].title;
  search.tracks[0].title = "Model-mutated title";
  const plan = await services.buildPlaylistPlan(planArguments(search, 6));

  assert.equal(plan.track_count, 6);
  assert.equal(plan.requested_track_count, 6);
  assert.equal(plan.tracks[0].title, originalTitle);
  assert.equal(plan.candidate_sets_validated, 1);
  assert.equal(plan.persistence, "none");
  assert.equal(plan.external_effects, "none");
  assert.equal(plan.tracks.every((track) => track.selection_reason.length > 0), true);
  assert.equal(JSON.stringify(plan).includes(search.candidate_set_id), false);

  const duplicate = planArguments(search, 2);
  duplicate.trackRefs[1].trackRefId = duplicate.trackRefs[0].trackRefId;
  await assertDomainRejects(
    services.buildPlaylistPlan(duplicate),
    "duplicate_track_ref",
  );

  const wrongCount = planArguments(search, 5);
  wrongCount.intent = "Find 6 tracks for a late-night drive.";
  await assertDomainRejects(
    services.buildPlaylistPlan(wrongCount),
    "playlist_track_count_mismatch",
  );
});

test("validated playlist tracks can be retained for a later prompt revision", async () => {
  const services = createSyntheticDomainServices({
    subjectScope: trustedSubject,
  });
  const search = await services.searchLibrary({ query: "night", limit: 3 });
  const original = await services.buildPlaylistPlan(planArguments(search, 2));
  const retainedTracks = services.getTrustedTracks(
    original.tracks.map((track) => track.track_ref_id),
  );

  services.endPrompt();
  const mutated = structuredClone(retainedTracks);
  mutated[0].title = "Model-mutated retained title";
  assert.throws(
    () =>
      services.registerRetainedPlaylistCandidateSet({
        tracks: mutated,
      }),
    (error) => {
      assert.equal(error instanceof DomainServiceError, true);
      assert.equal(error.code, "retained_candidate_invalid");
      return true;
    },
  );

  const retained = services.registerRetainedPlaylistCandidateSet({
    tracks: retainedTracks,
  });
  const reordered = await services.buildPlaylistPlan({
    intent: "Reorder 2 tracks from the prior plan.",
    requestedTrackCount: 2,
    candidateSetIds: [retained.candidate_set_id],
    trackRefs: [...original.tracks].reverse().map((track) => ({
      trackRefId: track.track_ref_id,
      selectionReason: "The listener requested this revised order.",
    })),
    orderingNotes: "Reverse the two retained positions.",
  });
  const revised = await services.buildPlaylistPlan({
    intent: "Keep 1 track from the prior plan.",
    requestedTrackCount: 1,
    candidateSetIds: [retained.candidate_set_id],
    trackRefs: [
      {
        trackRefId: original.tracks[1].track_ref_id,
        selectionReason: "The listener removed the original opener.",
      },
    ],
    orderingNotes: "The retained track now stands alone.",
  });

  assert.equal(retained.source, "retained_validated_playlist");
  assert.equal(retained.expires_on, "prompt_end");
  assert.deepEqual(
    reordered.tracks.map((track) => track.track_ref_id),
    [...original.tracks].reverse().map((track) => track.track_ref_id),
  );
  assert.equal(revised.track_count, 1);
  assert.equal(revised.tracks[0].title, original.tracks[1].title);
  services.endPrompt();
  await assertDomainRejects(
    services.buildPlaylistPlan({
      intent: "Keep 1 track from the prior plan.",
      requestedTrackCount: 1,
      candidateSetIds: [retained.candidate_set_id],
      trackRefs: [
        {
          trackRefId: original.tracks[1].track_ref_id,
          selectionReason: "This retained set is stale.",
        },
      ],
      orderingNotes: "This retained set is stale.",
    }),
    "candidate_set_unavailable",
  );
});

test("candidate sets expire at prompt boundaries and active storage is capped", async () => {
  const services = createSyntheticDomainServices({
    subjectScope: trustedSubject,
  });
  const searches = [];
  for (let index = 0; index < SYNTHETIC_DOMAIN_LIMITS.activeCandidateSetsMax; index += 1) {
    searches.push(await services.searchLibrary({ query: "night", limit: 1 }));
  }
  await assertDomainRejects(
    services.searchLibrary({ query: "night", limit: 1 }),
    "candidate_set_capacity_reached",
  );

  assert.deepEqual(services.endPrompt(), {
    invalidated_candidate_sets: SYNTHETIC_DOMAIN_LIMITS.activeCandidateSetsMax,
  });
  await assertDomainRejects(
    services.buildPlaylistPlan(planArguments(searches[0], 1)),
    "candidate_set_unavailable",
  );

  const nextPrompt = await services.searchLibrary({ query: "night", limit: 1 });
  assert.equal(nextPrompt.tracks.length, 1);
  assert.deepEqual(services.beginPrompt(), { invalidated_candidate_sets: 1 });
  await assertDomainRejects(
    services.buildPlaylistPlan(planArguments(nextPrompt, 1)),
    "candidate_set_unavailable",
  );
});
