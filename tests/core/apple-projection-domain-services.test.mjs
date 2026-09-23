import assert from "node:assert/strict";
import test from "node:test";

import {
  AppleProjectionDomainError,
  createAppleProjectionDomainServices,
} from "../../src/core/apple-projection-domain-services.mjs";

const trackIds = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
];

function rawTrack({
  trackRefId,
  title,
  artist,
  genre,
  playCount,
  loved,
  favorited,
  rated,
  ratingValue,
}) {
  return {
    track_ref: { track_ref_id: trackRefId, revision: 1 },
    title,
    artist_credit: artist,
    release: "Synthetic release",
    duration_ms: 240000,
    labels: { provider_genre: genre, composer: "Synthetic composer" },
    observation_summary: {
      ...(playCount === undefined ? {} : { play_count: playCount }),
      ...(loved === undefined ? {} : { loved }),
      ...(favorited === undefined ? {} : { favorited }),
      ...(rated || Number.isInteger(ratingValue)
        ? { rating: { value: ratingValue ?? 80, computed: false } }
        : {}),
    },
    subject_id: "PRIVATE_SUBJECT_SENTINEL",
    external_id: "PRIVATE_EXTERNAL_SENTINEL",
  };
}

function fakeProjection() {
  const tracks = [
    rawTrack({
      trackRefId: trackIds[0],
      title: "Familiar Night",
      artist: "Mara Vale",
      genre: "Ambient",
      playCount: 42,
      loved: true,
      rated: true,
    }),
    rawTrack({
      trackRefId: trackIds[1],
      title: "Distant Road",
      artist: "Mara Vale",
      genre: "Ambient",
      playCount: 6,
      favorited: true,
    }),
    rawTrack({
      trackRefId: trackIds[2],
      title: "Unexpected Exit",
      artist: "Other Artist",
      genre: "Experimental",
      playCount: 1,
      ratingValue: 20,
    }),
  ];
  const evidence = new Map([
    [
      "20000000-0000-4000-8000-000000000001",
      {
        schema_version: "profile-evidence-explanation/1",
        evidence_id: "20000000-0000-4000-8000-000000000001",
        claim: {
          dimension: "taste.track_familiarity",
          value: {
            value_type: "entity",
            entity_ref: { label: "Familiar Night" },
          },
        },
        direction: "supports",
        strength: 0.8,
        confidence: 0.9,
        basis_summary: {
          observed_at: "2026-08-25T00:00:00.000Z",
          play_count: 42,
        },
        derivation: {
          kind: "rule",
          name: "aggregate-play-count-familiarity",
          version: "1",
        },
        limitation: "This evidence supports familiarity, not liking.",
      },
    ],
  ]);
  return {
    closed: false,
    searchCalls: [],
    searchLibrary(input) {
      this.searchCalls.push(structuredClone(input));
      return {
        schema_version: "library-search-result/1",
        query: input.query,
        limit: input.limit,
        tracks: structuredClone(
          tracks.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit),
        ),
      };
    },
    getProfileSummary({ maxItems }) {
      const item = (
        track,
        evidenceId,
        dimension,
        direction = "supports",
      ) => ({
        evidence_id: evidenceId,
        dimension,
        direction,
        strength: 0.9,
        confidence: 0.9,
        track_ref: structuredClone(track.track_ref),
        label: track.title,
        observed_at: "2026-08-25T00:00:00.000Z",
        artist_credit: track.artist_credit,
        labels: structuredClone(track.labels),
        observation_summary: structuredClone(track.observation_summary),
      });
      return {
        schema_version: "profile-projection/0",
        preference: [
          item(
            tracks[0],
            "20000000-0000-4000-8000-000000000002",
            "taste.track_preference",
          ),
          item(
            tracks[1],
            "20000000-0000-4000-8000-000000000003",
            "taste.track_preference",
          ),
          item(
            tracks[2],
            "20000000-0000-4000-8000-000000000004",
            "taste.track_preference",
            "contradicts",
          ),
        ].slice(0, maxItems),
        familiarity: [
          item(
            tracks[0],
            "20000000-0000-4000-8000-000000000001",
            "taste.track_familiarity",
          ),
        ].slice(0, maxItems),
        coverage: {
          current_tracks: 3,
          observations: 3,
          evidence_records: 4,
          unresolved_identities: 0,
          loved_or_favorited: 2,
          aggregate_play_count: 3,
          non_computed_rating: 1,
          source_timestamp: "2026-08-25T00:00:00.000Z",
        },
        limitations: [
          "Play Count supports familiarity, not liking.",
          "Provider states do not have action timestamps.",
        ],
      };
    },
    explainProfileEvidence({ evidenceId }) {
      return structuredClone(evidence.get(evidenceId) ?? null);
    },
    close() {
      this.closed = true;
    },
  };
}

function fakeListeningHistoryStore() {
  const evidenceId = "30000000-0000-4000-8000-000000000001";
  return {
    closed: false,
    profileSummary() {
      return {
        schema_version: "listening-profile/1",
        coverage: {
          effective_listening_events: 12,
          profiled_listening_events: 11,
          distinct_tracks: 4,
          resolved_tracks: 4,
          listening_hours: 1.5,
          profile_evidence_records: 3,
          saved_tracks: 1,
          saved_albums: 1,
          followed_artists: 1,
          playlist_memberships: 1,
          verified_search_interactions: 1,
        },
        listening_behavior: {
          enduring_artists: [
            {
              name: "Spotify Artist",
              play_count: 12,
              engaged_play_count: 11,
              listening_minutes: 90,
              distinct_tracks: 4,
              explicit_skips: 1,
              last_played_at: "2026-08-29T04:00:00.000Z",
              evidence_id: evidenceId,
            },
          ],
          recent_artists: [],
          repeat_tracks: [],
          recent_tracks: [],
          context: {
            reference_date: "2026-08-29T04:00:00.000Z",
            recent_window_days: 90,
            effective_events_profiled: 11,
            explicit_skips: 1,
            trackdone_endings: 8,
            direct_selection_starts: 3,
            shuffle_events: 2,
            offline_events: 1,
            incognito_events_excluded: 1,
          },
        },
        curated_preferences: {
          saved_tracks: [
            {
              track_ref_id: trackIds[0],
              label: "Spotify Saved Track",
              artist_credit: "Spotify Artist",
              evidence_id: evidenceId,
            },
          ],
          playlist_anchors: [],
          followed_artists: [
            { name: "Spotify Artist", evidence_id: evidenceId },
          ],
          saved_albums: [],
          avoids: [],
        },
        search_intent: [],
        provider_signals: {
          artists: [],
          tracks: [],
          genres: [],
          interpretations: [],
          highlights: [],
          metrics: [],
        },
        source: {
          kind: "private_effective_listening_evidence",
          listening_range: {
            earliest: "2026-08-01T00:00:00.000Z",
            latest: "2026-08-29T04:00:00.000Z",
          },
          profile_captured_at: "2026-08-29T05:00:00.000Z",
        },
        limitations: ["Synthetic Spotify limitation."],
      };
    },
    rediscoveryCandidates({ limit }) {
      return {
        reference_date: "2026-08-29T04:00:00.000Z",
        quiet_days: 90,
        minimum_plays: 3,
        minimum_engaged_plays: 2,
        minimum_listening_minutes: 10,
        tracks: [
          {
            track_ref_id: "70000000-0000-4000-8000-000000000001",
            title: "Old Signal",
            artist_credit: "Archive Artist",
            release: "Earlier Rooms",
            candidate_scope: "private_history",
            identity_status: "resolved",
            labels: { genres: [] },
            observation_summary: {
              preference_signals: [],
              familiarity: {
                level: "high",
                basis: "effective_listening_history",
                play_count: 24,
              },
            },
            rediscovery: {
              listening_minutes: 96,
              engaged_play_count: 22,
              explicit_skips: 2,
              first_played_at: "2022-02-01T01:00:00.000Z",
              last_played_at: "2024-05-01T01:00:00.000Z",
              quiet_days: 850,
              rediscovery_signal: "saved-library state",
              peak_year: 2023,
              peak_year_play_count: 15,
              peak_year_listening_minutes: 60,
              evidence_id: "30000000-0000-4000-8000-000000000009",
            },
            duration_ms: 240_000,
            external_refs: [
              {
                system: "spotify",
                entity_type: "spotify.track",
                external_id: "4uLU6hMCjMI75M1A2tKUQC",
              },
            ],
          },
        ].slice(0, limit),
      };
    },
    historicalReturnCandidates({ limit }) {
      return {
        reference_date: "2026-08-29T04:00:00.000Z",
        minimum_gap_days: 180,
        minimum_plays: 3,
        minimum_engaged_plays: 3,
        minimum_listening_minutes: 10,
        tracks: [
          {
            track_ref_id: "70000000-0000-4000-8000-000000000002",
            title: "Recurring Light",
            artist_credit: "North Window",
            release: "Fictional Return",
            candidate_scope: "private_history",
            identity_status: "resolved",
            labels: { genres: [] },
            observation_summary: {
              preference_signals: [],
              familiarity: {
                level: "medium",
                basis: "effective_listening_history",
                play_count: 8,
              },
            },
            historical_return: {
              listening_minutes: 32,
              engaged_play_count: 8,
              explicit_skips: 0,
              first_played_at: "2020-01-01T00:00:00.000Z",
              last_played_at: "2026-01-01T00:00:00.000Z",
              return_count: 3,
              longest_gap_days: 730,
              latest_return_at: "2026-01-01T00:00:00.000Z",
              latest_return_gap_days: 365,
              historical_return_signal: "historical attention only",
              evidence_id: "30000000-0000-4000-8000-000000000012",
            },
            duration_ms: 240_000,
            external_refs: [
              {
                system: "spotify",
                entity_type: "spotify.track",
                external_id: "0VjIjW4GlUZAMYd2vXMi3b",
              },
            ],
          },
        ].slice(0, limit),
      };
    },
    backToBackCandidates({ limit }) {
      return {
        reference_date: "2026-08-29T04:00:00.000Z",
        minimum_consecutive_plays: 2,
        minimum_played_seconds: 30,
        maximum_gap_minutes: 30,
        tracks: [
          {
            track_ref_id: "70000000-0000-4000-8000-000000000012",
            title: "Fictional Echo",
            artist_credit: "Sequence Study",
            release: "Synthetic Playback",
            candidate_scope: "private_history",
            identity_status: "resolved",
            labels: { genres: [] },
            observation_summary: {
              preference_signals: [],
              familiarity: {
                level: "medium",
                basis: "effective_listening_history",
                play_count: 9,
              },
            },
            back_to_back: {
              engaged_play_count: 9,
              explicit_skips: 0,
              burst_count: 2,
              maximum_consecutive_plays: 4,
              plays_in_bursts: 7,
              listening_minutes_in_bursts: 28,
              latest_burst_at: "2026-08-01T12:00:00.000Z",
              sequence_signal: "adjacent retained plays",
              evidence_id: "30000000-0000-4000-8000-000000000013",
            },
            duration_ms: 240_000,
            external_refs: [
              {
                system: "spotify",
                entity_type: "spotify.track",
                external_id: "6rqhFgbbKwnb9MLmUQDhG6",
              },
            ],
          },
        ].slice(0, limit),
      };
    },
    timeCapsuleCandidates({ limit }) {
      const makeTrack = ({ ref, title, artist, year, spotifyId }) => ({
        track_ref_id: ref,
        title,
        artist_credit: artist,
        release: `${title} Release`,
        candidate_scope: "private_history",
        identity_status: "resolved",
        labels: { genres: [] },
        observation_summary: {
          preference_signals: [],
          familiarity: {
            level: "medium",
            basis: "effective_listening_history",
            play_count: 8,
          },
        },
        time_capsule: {
          year,
          year_play_count: 5,
          year_engaged_play_count: 5,
          year_listening_minutes: 20,
          year_explicit_skips: 0,
          lifetime_listening_minutes: 32,
          representative_signal: "historical attention only",
          evidence_id:
            year === 2020
              ? "30000000-0000-4000-8000-000000000010"
              : "30000000-0000-4000-8000-000000000011",
        },
        duration_ms: 240_000,
        external_refs: [
          {
            system: "spotify",
            entity_type: "spotify.track",
            external_id: spotifyId,
          },
        ],
      });
      const tracks = [
        makeTrack({
          ref: "70000000-0000-4000-8000-000000000010",
          title: "First Landmark",
          artist: "Early Artist",
          year: 2020,
          spotifyId: "4uLU6hMCjMI75M1A2tKUQC",
        }),
        makeTrack({
          ref: "70000000-0000-4000-8000-000000000011",
          title: "Later Landmark",
          artist: "Later Artist",
          year: 2025,
          spotifyId: "1234567890123456789012",
        }),
      ].slice(0, limit);
      return {
        reference_date: "2026-08-29T04:00:00.000Z",
        history_start_year: 2020,
        history_end_year: 2026,
        minimum_years: 2,
        minimum_engaged_plays: 2,
        minimum_listening_minutes: 5,
        represented_years: tracks.map((track) => track.time_capsule.year),
        tracks,
      };
    },
    explainProfileEvidence({ evidenceId: requestedId }) {
      if (requestedId !== evidenceId) return null;
      return {
        evidence_id: evidenceId,
        claim: {
          dimension: "taste.track_preference",
          value: "Spotify Saved Track",
          direction: "supports",
        },
        basis_summary: "The track is in the saved Spotify library snapshot.",
        derivation: {
          kind: "deterministic_projection",
          name: "spotify-account-library_track_saved",
          version: "listening-profile/1",
        },
        confidence: 0.95,
        interpretation_limit: "Current snapshot state has no action timestamp.",
      };
    },
    close() {
      this.closed = true;
    },
  };
}

test("real projection wrapper shapes bounded profile facets and evidence", async () => {
  const projection = fakeProjection();
  const services = createAppleProjectionDomainServices({ projection });

  assert.equal(services.status().subject_scope, "trusted_runtime");
  assert.equal(services.profileStatus().evidence_records, 4);

  const summary = await services.getProfileSummary({ maxItems: 2 });
  assert.equal(summary.strong_preferences.length, 2);
  assert.match(summary.strong_preferences[0].signal, /Loved/);
  assert.equal(summary.familiarity[0].level, "high");
  assert.deepEqual(summary.artist_facets, [
    {
      name: "Mara Vale",
      evidence_id: "20000000-0000-4000-8000-000000000002",
    },
  ]);
  assert.equal(summary.genre_facets[0].name, "Ambient");
  assert.equal(
    summary.strong_preferences.some(
      (item) => item.label === "Unexpected Exit",
    ),
    false,
  );
  assert.equal(summary.coverage.non_computed_rating, 1);
  const lyricSeeds = await services.getLyricSeeds();
  assert.ok(lyricSeeds.tracks.some((track) => track.artist === "Mara Vale"));
  assert.equal(lyricSeeds.tracks.some((track) => track.title === "Unexpected Exit"), false);
  assert.equal(JSON.stringify(summary).includes("PRIVATE_"), false);

  const search = await services.searchLibrary({ query: "", limit: 3 });
  const negativeRatedTrack = search.tracks.find(
    (track) => track.title === "Unexpected Exit",
  );
  assert.equal(
    negativeRatedTrack.observation_summary.preference_signals.includes(
      "rated",
    ),
    false,
  );

  const explanation = await services.explainProfileEvidence({
    evidenceId: "20000000-0000-4000-8000-000000000001",
  });
  assert.equal(explanation.claim.value, "Familiar Night");
  assert.match(explanation.basis_summary, /Play Count is 42/);
  assert.equal(
    explanation.interpretation_limit,
    "This evidence supports familiarity, not liking.",
  );
});

test("real projection wrapper merges private Spotify evidence and explanations", async () => {
  const projection = fakeProjection();
  const listeningHistoryStore = fakeListeningHistoryStore();
  const services = createAppleProjectionDomainServices({
    projection,
    listeningHistoryStore,
    subjectId: "11111111-1111-4111-8111-111111111111",
  });

  const status = services.profileStatus();
  assert.equal(status.projection_version, "profile-projection/1");
  assert.equal(status.effective_listening_events, 12);
  assert.equal(status.evidence_records, 7);

  const summary = await services.getProfileSummary({ maxItems: 2 });
  assert.equal(summary.profile_version, "profile-projection/1");
  assert.equal(summary.strong_preferences[1].label, "Spotify Saved Track");
  assert.equal(summary.artist_facets[1].name, "Spotify Artist");
  assert.equal(summary.coverage.listening_hours, 1.5);
  assert.equal(summary.listening_behavior.context.incognito_events_excluded, 1);

  const explained = await services.explainProfileEvidence({
    evidenceId: "30000000-0000-4000-8000-000000000001",
  });
  assert.equal(explained.claim.value, "Spotify Saved Track");
  assert.equal(explained.confidence, 0.95);

  services.close();
  assert.equal(listeningHistoryStore.closed, true);
});

test("private-history rediscovery becomes a prompt-local plan without exposing provider IDs", async () => {
  const services = createAppleProjectionDomainServices({
    projection: fakeProjection(),
    listeningHistoryStore: fakeListeningHistoryStore(),
    subjectId: "11111111-1111-4111-8111-111111111111",
  });
  services.beginPrompt();

  const candidates = await services.getRediscoveryCandidates({ limit: 1 });

  assert.equal(candidates.state, "ready");
  assert.equal(candidates.candidate_scope, "private_history");
  assert.equal(candidates.result_count, 1);
  assert.equal(candidates.tracks[0].title, "Old Signal");
  assert.equal(candidates.tracks[0].rediscovery.quiet_days, 850);
  assert.equal("external_refs" in candidates.tracks[0], false);
  assert.doesNotMatch(JSON.stringify(candidates), /4uLU6hMCjMI75M1A2tKUQC/u);

  const [trustedTrack] = services.getTrustedTracks([
    candidates.tracks[0].track_ref_id,
  ]);
  assert.equal(
    trustedTrack.external_refs[0].external_id,
    "4uLU6hMCjMI75M1A2tKUQC",
  );
  const plan = await services.buildPlaylistPlan({
    intent: "Plan 1 track worth another listen.",
    requestedTrackCount: 1,
    candidateSetIds: [candidates.candidate_set_id],
    trackRefs: [
      {
        trackRefId: candidates.tracks[0].track_ref_id,
        selectionReason: "Meaningful older attention with a bounded quiet period.",
      },
    ],
    orderingNotes: "One historical candidate stands alone.",
  });
  assert.equal(plan.candidate_scope, "private_history");
  assert.equal(plan.tracks[0].candidate_scope, "private_history");

  services.endPrompt();
  const retained = services.registerRetainedPlaylistCandidateSet({
    tracks: [trustedTrack],
  });
  assert.equal(retained.candidate_scope, "private_history");
  assert.equal(
    services.getTrustedTracks([trustedTrack.track_ref_id])[0].external_refs[0]
      .external_id,
    "4uLU6hMCjMI75M1A2tKUQC",
  );
  services.close();
});

test("private historical returns become a prompt-local plan without exposing provider IDs", async () => {
  const services = createAppleProjectionDomainServices({
    projection: fakeProjection(),
    listeningHistoryStore: fakeListeningHistoryStore(),
    subjectId: "11111111-1111-4111-8111-111111111111",
  });
  services.beginPrompt();

  const candidates = await services.getHistoricalReturnCandidates({ limit: 1 });

  assert.equal(candidates.state, "ready");
  assert.equal(candidates.candidate_scope, "private_history");
  assert.equal(candidates.tracks[0].title, "Recurring Light");
  assert.equal(candidates.tracks[0].historical_return.return_count, 3);
  assert.equal(candidates.tracks[0].historical_return.longest_gap_days, 730);
  assert.equal("external_refs" in candidates.tracks[0], false);
  assert.doesNotMatch(JSON.stringify(candidates), /0VjIjW4GlUZAMYd2vXMi3b/u);

  const [trustedTrack] = services.getTrustedTracks([
    candidates.tracks[0].track_ref_id,
  ]);
  assert.equal(
    trustedTrack.external_refs[0].external_id,
    "0VjIjW4GlUZAMYd2vXMi3b",
  );
  const plan = await services.buildPlaylistPlan({
    intent: "Plan 1 track that returned after a long gap.",
    requestedTrackCount: 1,
    candidateSetIds: [candidates.candidate_set_id],
    trackRefs: [
      {
        trackRefId: candidates.tracks[0].track_ref_id,
        selectionReason: "It reappeared after multiple bounded long gaps.",
      },
    ],
    orderingNotes: "One historical return stands alone.",
  });
  assert.deepEqual(plan.tracks[0].history_context, {
    kind: "historical_return",
  });

  services.close();
});

test("private back-to-back sequences become a prompt-local plan without exposing provider IDs", async () => {
  const services = createAppleProjectionDomainServices({
    projection: fakeProjection(),
    listeningHistoryStore: fakeListeningHistoryStore(),
    subjectId: "11111111-1111-4111-8111-111111111111",
  });
  services.beginPrompt();

  const candidates = await services.getBackToBackCandidates({ limit: 1 });

  assert.equal(candidates.state, "ready");
  assert.equal(candidates.candidate_scope, "private_history");
  assert.equal(candidates.minimum_consecutive_plays, 2);
  assert.equal(candidates.tracks[0].title, "Fictional Echo");
  assert.equal(candidates.tracks[0].back_to_back.burst_count, 2);
  assert.equal(
    candidates.tracks[0].back_to_back.maximum_consecutive_plays,
    4,
  );
  assert.equal("external_refs" in candidates.tracks[0], false);
  assert.doesNotMatch(JSON.stringify(candidates), /6rqhFgbbKwnb9MLmUQDhG6/u);

  const [trustedTrack] = services.getTrustedTracks([
    candidates.tracks[0].track_ref_id,
  ]);
  assert.equal(
    trustedTrack.external_refs[0].external_id,
    "6rqhFgbbKwnb9MLmUQDhG6",
  );
  const plan = await services.buildPlaylistPlan({
    intent: "Plan 1 track played in an adjacent sequence.",
    requestedTrackCount: 1,
    candidateSetIds: [candidates.candidate_set_id],
    trackRefs: [
      {
        trackRefId: candidates.tracks[0].track_ref_id,
        selectionReason: "It appears in a bounded adjacent playback sequence.",
      },
    ],
    orderingNotes: "One sequence stands alone.",
  });
  assert.deepEqual(plan.tracks[0].history_context, {
    kind: "back_to_back",
  });
  services.close();
});

test("private-history Time Machine spans years without exposing provider IDs", async () => {
  const services = createAppleProjectionDomainServices({
    projection: fakeProjection(),
    listeningHistoryStore: fakeListeningHistoryStore(),
    subjectId: "11111111-1111-4111-8111-111111111111",
  });
  services.beginPrompt();

  const candidates = await services.getTimeCapsuleCandidates({ limit: 2 });

  assert.equal(candidates.state, "ready");
  assert.equal(candidates.candidate_scope, "private_history");
  assert.deepEqual(candidates.represented_years, [2020, 2025]);
  assert.deepEqual(
    candidates.tracks.map((track) => [
      track.title,
      track.time_capsule.year,
    ]),
    [
      ["First Landmark", 2020],
      ["Later Landmark", 2025],
    ],
  );
  assert.equal(
    candidates.tracks.some((track) => "external_refs" in track),
    false,
  );
  assert.doesNotMatch(JSON.stringify(candidates), /4uLU6hMCjMI75M1A2tKUQC/u);

  const trusted = services.getTrustedTracks(
    candidates.tracks.map((track) => track.track_ref_id),
  );
  assert.deepEqual(
    trusted.map((track) => track.external_refs[0].external_id),
    ["4uLU6hMCjMI75M1A2tKUQC", "1234567890123456789012"],
  );
  const plan = await services.buildPlaylistPlan({
    intent: "Build a 2 track journey across my listening years.",
    requestedTrackCount: 2,
    candidateSetIds: [candidates.candidate_set_id],
    trackRefs: candidates.tracks.map((track) => ({
      trackRefId: track.track_ref_id,
      selectionReason: `${track.time_capsule.year} listening landmark.`,
    })),
    orderingNotes: "Move chronologically from the earliest to latest year.",
  });
  assert.equal(plan.candidate_scope, "private_history");
  assert.deepEqual(
    plan.tracks.map((track) => track.history_context),
    [
      { kind: "time_capsule", year: 2020 },
      { kind: "time_capsule", year: 2025 },
    ],
  );

  services.close();
});

test("direct listener assertions outrank provider preference while avoids preserve familiarity", async () => {
  const projection = fakeProjection();
  const listeningHistoryStore = fakeListeningHistoryStore();
  const originalProfileSummary = listeningHistoryStore.profileSummary.bind(
    listeningHistoryStore,
  );
  listeningHistoryStore.profileSummary = () => {
    const summary = originalProfileSummary();
    const preferenceId = "40000000-0000-4000-8000-000000000001";
    const avoidId = "40000000-0000-4000-8000-000000000002";
    const preference = {
      correction_id: preferenceId,
      evidence_id: preferenceId,
      entity_type: "artist",
      label: "Listener First",
      stance: "like",
      strength: 1,
      asserted_at: "2026-09-03T01:00:00.000Z",
    };
    const avoid = {
      correction_id: avoidId,
      evidence_id: avoidId,
      entity_type: "artist",
      label: "Mara Vale",
      stance: "avoid",
      strength: 1,
      asserted_at: "2026-09-03T02:00:00.000Z",
    };
    return {
      ...summary,
      coverage: {
        ...summary.coverage,
        listener_assertion_events: 2,
        active_listener_assertions: 2,
        listener_retractions: 0,
      },
      listener_assertions: {
        active: [avoid, preference],
        preferences: [preference],
        avoids: [avoid],
        retractions: 0,
      },
    };
  };
  const services = createAppleProjectionDomainServices({
    projection,
    listeningHistoryStore,
    subjectId: "11111111-1111-4111-8111-111111111111",
  });

  const status = services.profileStatus();
  assert.equal(status.evidence_records, 9);
  assert.equal(status.claims, 2);
  const bounded = await services.getProfileSummary({ maxItems: 1 });
  assert.equal(bounded.strong_preferences[0].label, "Listener First");

  const summary = await services.getProfileSummary({ maxItems: 3 });
  assert.equal(
    summary.strong_preferences.some((item) => item.label === "Familiar Night"),
    false,
  );
  assert.equal(
    summary.artist_facets.some((item) => item.name === "Mara Vale"),
    false,
  );
  assert.equal(
    summary.familiarity.some((item) => item.label === "Familiar Night"),
    true,
  );
  assert.equal(summary.listener_assertions.avoids[0].label, "Mara Vale");
  services.close();
});

test("real projection wrapper binds plans to final prompt candidate results", async () => {
  const projection = fakeProjection();
  const services = createAppleProjectionDomainServices({ projection });
  services.beginPrompt();
  const search = await services.searchLibrary({
    query: "",
    limit: 2,
    filters: {
      artists: ["Mara"],
      genres: ["Ambient"],
      familiarity: ["high", "medium"],
    },
  });

  assert.equal(search.result_count, 2);
  assert.equal(search.tracks.every((track) => track.artist_credit === "Mara Vale"), true);
  assert.equal(JSON.stringify(search).includes("PRIVATE_"), false);
  assert.equal(projection.searchCalls[0].limit, 3);
  assert.equal(projection.searchCalls[0].offset, 0);
  assert.deepEqual(projection.searchCalls[0].filters, {
    artists: ["mara"],
    genres: ["ambient"],
    familiarity: ["high", "medium"],
    preferenceSignals: [],
  });

  const nextPage = await services.searchLibrary({
    query: "",
    limit: 1,
    offset: 1,
  });
  assert.equal(nextPage.offset_applied, 1);
  assert.equal(nextPage.next_offset, 2);
  assert.equal(nextPage.has_more, true);
  assert.equal(nextPage.tracks[0].title, "Distant Road");

  const plan = await services.buildPlaylistPlan({
    intent: "Plan 2 tracks for a night drive.",
    requestedTrackCount: 2,
    candidateSetIds: [search.candidate_set_id],
    trackRefs: search.tracks.map((track) => ({
      trackRefId: track.track_ref_id,
      selectionReason: "Grounded in the returned library candidate set.",
    })),
    orderingNotes: "Move from high to medium familiarity.",
  });
  assert.equal(plan.track_count, 2);
  assert.deepEqual(
    plan.tracks.map((track) => track.track_ref_id),
    trackIds.slice(0, 2),
  );

  const chineseCountPlan = await services.buildPlaylistPlan({
    intent: "从我的曲库里安排一个夜晚过渡方案。",
    requestedTrackCount: 2,
    candidateSetIds: [search.candidate_set_id],
    trackRefs: search.tracks.map((track) => ({
      trackRefId: track.track_ref_id,
      selectionReason: "来自当前可信候选集。",
    })),
    orderingNotes: "从高熟悉度过渡到中等熟悉度。",
  });
  assert.equal(chineseCountPlan.requested_track_count, 2);

  services.endPrompt();
  await assert.rejects(
    services.buildPlaylistPlan({
      intent: "Plan 2 tracks.",
      candidateSetIds: [search.candidate_set_id],
      trackRefs: search.tracks.map((track) => ({
        trackRefId: track.track_ref_id,
        selectionReason: "stale",
      })),
      orderingNotes: "stale",
    }),
    (error) =>
      error instanceof AppleProjectionDomainError &&
      error.code === "candidate_set_unavailable",
  );
});

test("real projection wrapper filters and plans prompt-local external candidates", async () => {
  const projection = fakeProjection();
  const services = createAppleProjectionDomainServices({ projection });
  services.beginPrompt();
  const source = {
    provider: "apple_music",
    catalog: "itunes_search_api",
    storefront: "US",
    retrieved_at: "2026-09-02T05:00:00.000Z",
    coverage:
      "Keyword catalog candidates only. This does not prove personal fit or unheard status.",
  };
  const registered = services.registerExternalCandidateSet({
    source,
    tracks: [
      {
        track_ref_id: "40000000-0000-4000-8000-000000000001",
        title: "Familiar Night",
        artist_credit: "Mara Vale",
        release: "Another Edition",
        duration_ms: 240000,
        primary_genre: "Ambient",
        candidate_scope: "external_catalog",
        catalog_provider: "apple_music",
        matched_queries: ["ambient night"],
      },
      {
        track_ref_id: "40000000-0000-4000-8000-000000000002",
        title: "Moonlit Glass",
        artist_credit: "Aster North",
        release: "Quiet Rooms",
        duration_ms: 230000,
        primary_genre: "Electronic",
        release_date: "2025-04-18",
        catalog_url: "https://music.apple.com/us/album/1700000002",
        candidate_scope: "external_catalog",
        catalog_provider: "apple_music",
        matched_queries: ["ambient night"],
      },
    ],
  });

  assert.equal(registered.candidate_scope, "external_catalog");
  assert.equal(registered.excluded_library_matches, 1);
  assert.equal(registered.result_count, 1);
  assert.equal(registered.tracks[0].title, "Moonlit Glass");
  assert.deepEqual(registered.tracks[0].knownness, {
    imported_library: "not_found_by_exact_title_artist",
    listening_history: "not_checked",
  });

  const plan = await services.buildPlaylistPlan({
    intent: "Plan 1 track outside my imported library.",
    requestedTrackCount: 1,
    candidateSetIds: [registered.candidate_set_id],
    trackRefs: [
      {
        trackRefId: registered.tracks[0].track_ref_id,
        selectionReason: "The catalog metadata matches the requested genre.",
      },
    ],
    orderingNotes: "One external candidate needs no transition.",
  });
  assert.equal(plan.candidate_scope, "external_catalog");
  assert.equal(plan.tracks[0].candidate_scope, "external_catalog");
  assert.deepEqual(plan.tracks[0].public_catalog_reference, {
    provider: "apple_music",
    url: "https://music.apple.com/us/album/1700000002",
  });
  const trustedTracks = services.getTrustedTracks([
    registered.tracks[0].track_ref_id,
  ]);
  assert.equal(
    trustedTracks[0].title,
    "Moonlit Glass",
  );

  services.endPrompt();
  assert.throws(
    () => services.getTrustedTracks([registered.tracks[0].track_ref_id]),
    (error) =>
      error instanceof AppleProjectionDomainError &&
      error.code === "untrusted_track_ref",
  );

  const retained = services.registerRetainedPlaylistCandidateSet({
    tracks: trustedTracks,
  });
  const revised = await services.buildPlaylistPlan({
    intent: "Keep 1 external track from the prior plan.",
    requestedTrackCount: 1,
    candidateSetIds: [retained.candidate_set_id],
    trackRefs: [
      {
        trackRefId: trustedTracks[0].track_ref_id,
        selectionReason: "The listener kept this catalog candidate.",
      },
    ],
    orderingNotes: "The retained external track now stands alone.",
  });
  assert.equal(retained.source, "retained_validated_playlist");
  assert.equal(revised.candidate_scope, "external_catalog");
  assert.equal(revised.tracks[0].title, "Moonlit Glass");
  assert.deepEqual(revised.tracks[0].public_catalog_reference, {
    provider: "apple_music",
    url: "https://music.apple.com/us/album/1700000002",
  });
});

test("external discovery planning rejects unrequested artist and release concentration", async () => {
  const services = createAppleProjectionDomainServices({
    projection: fakeProjection(),
  });
  services.beginPrompt();
  const source = {
    provider: "apple_music",
    catalog: "itunes_search_api",
    storefront: "US",
    retrieved_at: "2026-09-02T05:00:00.000Z",
    coverage: "Synthetic external catalog coverage.",
  };
  const externalTrack = (index, release) => ({
    track_ref_id: `60000000-0000-4000-8000-00000000000${index}`,
    title: `External Movement ${index}`,
    artist_credit: "One Catalog Artist",
    release,
    candidate_scope: "external_catalog",
    catalog_provider: "apple_music",
    matched_queries: ["night writing"],
  });
  const registered = services.registerExternalCandidateSet({
    source,
    tracks: [
      externalTrack(1, "Shared Release"),
      externalTrack(2, "Shared Release"),
      externalTrack(3, "Second Release"),
      externalTrack(4, "Third Release"),
    ],
  });
  const planInput = (indexes, intent) => ({
    intent,
    requestedTrackCount: indexes.length,
    candidateSetIds: [registered.candidate_set_id],
    trackRefs: indexes.map((index) => ({
      trackRefId: registered.tracks[index].track_ref_id,
      selectionReason: "Synthetic catalog rationale.",
    })),
    orderingNotes: "Synthetic external ordering.",
  });

  await assert.rejects(
    services.buildPlaylistPlan(
      planInput([0, 1], "Plan 2 external tracks for writing."),
    ),
    (error) =>
      error instanceof AppleProjectionDomainError &&
      error.code === "playlist_external_release_concentration",
  );
  await assert.rejects(
    services.buildPlaylistPlan(
      planInput([0, 2, 3], "Plan 3 external tracks for writing."),
    ),
    (error) =>
      error instanceof AppleProjectionDomainError &&
      error.code === "playlist_external_artist_concentration",
  );

  const focused = await services.buildPlaylistPlan(
    planInput(
      [0, 2, 3],
      "Plan 3 One Catalog Artist tracks for writing.",
    ),
  );
  assert.equal(focused.track_count, 3);
});

test("real projection wrapper rejects missing evidence and unreturned tracks", async () => {
  const services = createAppleProjectionDomainServices({
    projection: fakeProjection(),
  });
  await assert.rejects(
    services.searchLibrary({
      query: "night",
      subjectId: "model-controlled-subject",
    }),
    (error) => error.code === "invalid_arguments",
  );
  await assert.rejects(
    services.explainProfileEvidence({
      evidenceId: "20000000-0000-4000-8000-000000000099",
    }),
    (error) => error.code === "profile_evidence_unavailable",
  );

  const search = await services.searchLibrary({ query: "night", limit: 1 });
  await assert.rejects(
    services.buildPlaylistPlan({
      intent: "Plan 1 track.",
      candidateSetIds: [search.candidate_set_id],
      trackRefs: [
        {
          trackRefId: trackIds[2],
          selectionReason: "not in the returned cap",
        },
      ],
      orderingNotes: "single track",
    }),
    (error) => error.code === "untrusted_track_ref",
  );
});
