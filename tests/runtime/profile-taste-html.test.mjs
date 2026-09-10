import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createTasteprintView,
  renderTasteprintCardHtml,
  renderTasteprintHtml,
} from "../../src/surfaces/html/tasteprint.mjs";
import { writeTasteprintArtifact } from "../../src/surfaces/html/tasteprint-artifact.mjs";
import {
  createPublicTasteprintDemoProfile,
  PUBLIC_TASTEPRINT_DEMO_GENERATED_AT,
} from "../../src/demo/moondog-tasteprint-demo.mjs";

const privateEvidenceId = "11111111-2222-4333-8444-555555555555";

function sampleProfile() {
  return {
    profile_version: "profile-projection/1",
    coverage: {
      effective_listening_events: 1200,
      profiled_listening_events: 1197,
      listening_hours: 75,
      listening_tracks: 340,
      resolved_listening_tracks: 320,
      cross_format_track_links: 14,
      cross_format_linked_events: 22,
      cross_format_ambiguous_tracks: 3,
      cross_format_ambiguous_events: 5,
      spotify_saved_tracks: 80,
      spotify_saved_albums: 20,
      spotify_followed_artists: 12,
      spotify_playlist_memberships: 120,
      verified_search_interactions: 14,
      tracks_observed: 500,
      loved_or_favorited: 40,
      listener_assertion_events: 3,
      active_listener_assertions: 2,
      listener_retractions: 1,
    },
    listening_behavior: {
      enduring_artists: [
        {
          name: "Mara Vale",
          play_count: 91,
          listening_minutes: 420,
          distinct_tracks: 17,
          evidence_id: privateEvidenceId,
        },
      ],
      recent_artists: [
        {
          name: "North Window",
          play_count: 24,
          listening_minutes: 110,
          distinct_tracks: 6,
          evidence_id: privateEvidenceId,
        },
      ],
      repeat_tracks: [
        {
          track_ref_id: "private-track-ref",
          label: "</strong><script>alert(1)</script>",
          artist_credit: "Mara Vale",
          play_count: 31,
          listening_minutes: 150,
          evidence_id: privateEvidenceId,
        },
      ],
      recent_tracks: [],
      rediscovery_tracks: [
        {
          track_ref_id: "private-rediscovery-ref",
          label: "Quiet Coordinates",
          artist_credit: "Sable Arcade",
          release: "Night Survey",
          play_count: 18,
          listening_minutes: 92,
          first_played_at: "2024-01-12T00:00:00.000Z",
          last_played_at: "2025-12-31T00:00:00.000Z",
          quiet_days: 242,
          peak_year: 2024,
          peak_year_play_count: 12,
          peak_year_listening_minutes: 61,
          rediscovery_signal: "saved-library state",
          evidence_id: privateEvidenceId,
        },
      ],
      historical_return_tracks: [
        {
          track_ref_id: "private-historical-return-ref",
          label: "Recurring Light",
          artist_credit: "North Window",
          release: "Fictional Return",
          play_count: 8,
          listening_minutes: 32,
          first_played_at: "2020-01-01T00:00:00.000Z",
          last_played_at: "2026-01-01T00:00:00.000Z",
          return_count: 3,
          longest_gap_days: 730,
          latest_return_at: "2026-01-01T00:00:00.000Z",
          latest_return_gap_days: 365,
          historical_return_signal: "historical attention only",
          evidence_id: privateEvidenceId,
          external_refs: ["PRIVATE_RETURN_PROVIDER_ID"],
        },
      ],
      time_capsule_tracks: [
        {
          track_ref_id: "private-time-capsule-ref",
          label: "First Light",
          artist_credit: "Early Artist",
          release: "Archive One",
          identity_status: "resolved",
          capsule_year: 2024,
          year_play_count: 8,
          year_engaged_play_count: 8,
          year_listening_minutes: 32,
          year_explicit_skips: 0,
          lifetime_play_count: 12,
          lifetime_listening_minutes: 48,
          representative_signal: "historical attention only",
          evidence_id: privateEvidenceId,
          external_refs: ["PRIVATE_PROVIDER_ID"],
        },
      ],
      back_to_back_tracks: [
        {
          track_ref_id: "private-back-to-back-ref",
          label: "Fictional Echo",
          artist_credit: "Sequence Study",
          release: "Synthetic Playback",
          identity_status: "resolved",
          play_count: 9,
          engaged_play_count: 9,
          explicit_skips: 0,
          burst_count: 2,
          maximum_consecutive_plays: 4,
          plays_in_bursts: 7,
          listening_minutes_in_bursts: 28,
          latest_burst_at: "2026-08-01T12:00:00.000Z",
          sequence_signal: "adjacent retained plays",
          evidence_id: privateEvidenceId,
          external_refs: ["PRIVATE_BACK_TO_BACK_PROVIDER_ID"],
        },
      ],
      history_arc: [
        {
          year: 2026,
          event_count: 620,
          listening_minutes: 2_340,
          distinct_tracks: 190,
          first_observed_tracks: 75,
          top_artist: {
            name: "North Window",
            play_count: 88,
            listening_minutes: 390,
            evidence_id: privateEvidenceId,
          },
          private_path: "/Users/example/private/history.zip",
        },
        {
          year: 2024,
          event_count: 580,
          listening_minutes: 2_160,
          distinct_tracks: 170,
          first_observed_tracks: 170,
          top_artist: {
            name: "Mara Vale",
            play_count: 76,
            listening_minutes: 350,
          },
        },
      ],
      monthly_activity: {
        timezone: "UTC",
        first_month: "2026-01",
        last_month: "2026-03",
        retained_span_months: 3,
        represented_month_count: 3,
        active_month_count: 2,
        omitted_earlier_month_count: 0,
        peak_listening_minutes: 180,
        months: [
          {
            month: "2026-01",
            event_count: 80,
            engaged_play_count: 72,
            listening_minutes: 180,
            distinct_tracks: 31,
            private_timestamps: ["2026-01-01T00:00:00.000Z"],
          },
          {
            month: "2026-02",
            event_count: 0,
            engaged_play_count: 0,
            listening_minutes: 0,
            distinct_tracks: 0,
          },
          {
            month: "2026-03",
            event_count: 46,
            engaged_play_count: 39,
            listening_minutes: 112,
            distinct_tracks: 24,
          },
        ],
        private_path: "/Users/example/private/history.zip",
      },
      listening_seasons: {
        timezone: "UTC",
        alignment: "calendar_quarter",
        season_length_months: 3,
        retained_first_season: "2026-Q1",
        represented_first_season: "2026-Q1",
        last_season: "2026-Q1",
        retained_season_count: 1,
        represented_season_count: 1,
        active_season_count: 1,
        represented_active_season_count: 1,
        omitted_earlier_season_count: 0,
        omitted_earlier_active_season_count: 0,
        seasons: [
          {
            key: "2026-Q1",
            start_month: "2026-01",
            end_month: "2026-03",
            retained_month_count: 3,
            active_month_count: 2,
            event_count: 126,
            engaged_play_count: 111,
            listening_minutes: 292,
            distinct_tracks: 75,
            first_observed_tracks: 55,
            returning_tracks: 20,
            leading_artist: {
              name: "North Window",
              event_count: 40,
              engaged_play_count: 35,
              listening_minutes: 96,
              distinct_tracks: 14,
              private_artist_id: "PRIVATE_SEASON_ARTIST_ID",
            },
            signature_track: {
              track_ref_id: "private-season-track-ref",
              label: "Seasonal Signal",
              artist_credit: "North Window",
              release: "Quarter Study",
              play_count: 12,
              engaged_play_count: 10,
              listening_minutes: 54,
              explicit_skips: 2,
              private_timestamps: ["2026-03-01T00:00:00.000Z"],
            },
          },
        ],
        evidence_id: privateEvidenceId,
        private_path: "/Users/example/private/history.zip",
      },
      artist_relationships: [
        {
          name: "Mara Vale",
          first_year: 2024,
          last_year: 2026,
          active_years: 3,
          span_years: 3,
          play_count: 91,
          listening_minutes: 420,
          evidence_id: privateEvidenceId,
          private_path: "/Users/example/private/history.zip",
        },
      ],
      year_transitions: [
        {
          from_year: 2024,
          to_year: 2026,
          from_artist_count: 10,
          to_artist_count: 10,
          retained_artist_count: 4,
          new_artist_count: 6,
          continuity_percent: 40,
          retained_artists: ["Mara Vale", "North Window"],
          new_artists: ["New Coast Archive", "Low Lanterns"],
          evidence_id: privateEvidenceId,
          private_artist_ids: ["PRIVATE_PROVIDER_ID"],
        },
      ],
      release_depth: [
        {
          title: "Night Transit",
          artist_credit: "Mara Vale",
          distinct_tracks: 8,
          play_count: 120,
          engaged_play_count: 110,
          listening_minutes: 520,
          first_year: 2024,
          last_year: 2026,
          active_years: 3,
          evidence_id: privateEvidenceId,
          private_track_ids: ["PRIVATE_PROVIDER_ID"],
        },
      ],
      session_summary: {
        source: "spotify_extended_history",
        method: "track_stop_gap",
        gap_minutes: 30,
        event_count: 1_000,
        session_count: 180,
        median_plays: 5,
        median_listening_minutes: 18,
        single_play_sessions: 40,
        short_sequence_sessions: 60,
        extended_sequence_sessions: 80,
        extended_sequence_minimum_plays: 5,
        extended_sequence_percent: 44.4,
        evidence_id: privateEvidenceId,
        private_timestamps: ["2026-01-01T00:00:00.000Z"],
      },
      context: {
        recent_window_days: 90,
        effective_events_profiled: 1197,
        start_reason_events: 1000,
        trackdone_starts: 600,
        end_reason_events: 1000,
        skip_state_events: 1000,
        explicit_skips: 100,
        trackdone_endings: 800,
        direct_selection_starts: 300,
        shuffle_state_events: 1000,
        shuffle_events: 250,
        offline_state_events: 1000,
        offline_events: 20,
        incognito_events_excluded: 3,
        rediscovery_quiet_days: 90,
        historical_return_minimum_gap_days: 180,
        historical_return_minimum_plays: 3,
        historical_return_minimum_engaged_plays: 3,
        historical_return_minimum_listening_minutes: 10,
        time_capsule_minimum_years: 2,
        time_capsule_minimum_engaged_plays: 2,
        time_capsule_minimum_listening_minutes: 5,
        relationship_minimum_years: 2,
        continuity_artist_limit: 10,
        release_minimum_distinct_tracks: 3,
        session_gap_minutes: 30,
        extended_sequence_minimum_plays: 5,
        back_to_back_minimum_consecutive_plays: 2,
        back_to_back_minimum_played_seconds: 30,
        back_to_back_maximum_gap_minutes: 30,
        monthly_activity_maximum_months: 240,
      },
    },
    strong_preferences: [
      {
        label: "Favorite Track",
        signal: "Favorited",
        evidence_id: privateEvidenceId,
      },
    ],
    listener_assertions: {
      active: [],
      preferences: [
        {
          correction_id: privateEvidenceId,
          evidence_id: privateEvidenceId,
          entity_type: "artist",
          label: "Mara Vale",
          stance: "like",
          strength: 1,
          asserted_at: "2026-09-01T12:00:00.000Z",
          note: "Keep this close.",
        },
      ],
      avoids: [
        {
          correction_id: privateEvidenceId,
          evidence_id: privateEvidenceId,
          entity_type: "track",
          label: "<Context-only track>",
          artist_credit: "Other Artist",
          stance: "avoid",
          strength: 1,
          asserted_at: "2026-09-02T12:00:00.000Z",
          note: "Played for someone else <not mine>.",
        },
      ],
      retractions: 1,
    },
    artist_facets: [{ name: "Mara Vale", evidence_id: privateEvidenceId }],
    genre_facets: [{ name: "Art Rock", evidence_id: privateEvidenceId }],
    curated_preferences: {
      saved_tracks: [
        {
          track_ref_id: "private-saved-ref",
          label: "Midnight Lines",
          artist_credit: "Mara Vale",
          evidence_id: privateEvidenceId,
        },
      ],
      playlist_anchors: [
        {
          track_ref_id: "private-playlist-ref",
          label: "Night Transit",
          artist_credit: "Mara Vale",
          playlist_count: 3,
          playlist_names: ["PRIVATE PLAYLIST NAME"],
          evidence_id: privateEvidenceId,
        },
      ],
      followed_artists: [
        { name: "North Window", evidence_id: privateEvidenceId },
      ],
      saved_albums: [
        {
          label: "Glass City",
          artist_credit: "North Window",
          evidence_id: privateEvidenceId,
        },
      ],
    },
    search_intent: [
      {
        query: "Mara Vale",
        interactions: 2,
        result_entity_types: ["artist"],
        evidence_id: privateEvidenceId,
      },
    ],
    provider_signals: {
      artists: [
        {
          name: "Provider Artist",
          best_rank: 1,
          periods: ["2025"],
          evidence_id: privateEvidenceId,
        },
      ],
      tracks: [
        {
          label: "Provider Track",
          artist_credit: "Provider Artist",
          best_rank: 2,
          periods: ["2025"],
          evidence_id: privateEvidenceId,
        },
      ],
      genres: [
        { name: "Provider Genre", rank: 1, period: "2025", evidence_id: privateEvidenceId },
      ],
      highlights: [
        {
          kind: "top_track",
          label: "Provider Highlight",
          evidence_id: privateEvidenceId,
        },
      ],
      metrics: [
        {
          name: "minutes listened",
          value: 4500,
          unit: "minutes",
          period: "2025",
          evidence_id: privateEvidenceId,
        },
      ],
      interpretations: [
        {
          text: "PROVIDER_PROSE_MUST_NOT_APPEAR",
          evidence_id: privateEvidenceId,
        },
      ],
    },
    listening_source: {
      listening_range: {
        earliest: "2024-01-01T00:00:00.000Z",
        latest: "2026-08-30T00:00:00.000Z",
      },
      private_source_path: "/Users/example/private/history.zip",
    },
    limitations: ["Play count supports familiarity, not liking."],
  };
}

test("tasteprint view keeps bounded display fields and drops private identifiers", () => {
  const view = createTasteprintView(sampleProfile(), {
    generatedAt: "2026-09-02T12:00:00.000Z",
  });
  const text = JSON.stringify(view);

  assert.equal(view.tasteprint_version, "moondog-tasteprint/1");
  assert.equal(view.coverage.effective_listening_events, 1200);
  assert.equal(view.coverage.cross_format_track_links, 14);
  assert.equal(view.coverage.cross_format_linked_events, 22);
  assert.equal(view.coverage.cross_format_ambiguous_tracks, 3);
  assert.equal(view.coverage.cross_format_ambiguous_events, 5);
  assert.equal(view.timeline.days, 973);
  assert.equal(view.behavior.enduring_artists[0].name, "Mara Vale");
  assert.deepEqual(
    view.behavior.history_arc.map((item) => item.year),
    [2024, 2026],
  );
  assert.equal(view.behavior.history_arc[1].top_artist.name, "North Window");
  assert.equal(view.behavior.monthly_activity.timezone, "UTC");
  assert.equal(view.behavior.monthly_activity.represented_month_count, 3);
  assert.equal(view.behavior.monthly_activity.active_month_count, 2);
  assert.equal(view.behavior.monthly_activity.months[1].event_count, 0);
  assert.equal(
    "private_timestamps" in view.behavior.monthly_activity.months[0],
    false,
  );
  assert.equal(view.behavior.listening_seasons.timezone, "UTC");
  assert.equal(view.behavior.listening_seasons.preview_season_count, 1);
  assert.equal(view.behavior.listening_seasons.seasons[0].key, "2026-Q1");
  assert.equal(
    view.behavior.listening_seasons.seasons[0].signature_track.label,
    "Seasonal Signal",
  );
  assert.equal(
    "track_ref_id" in
      view.behavior.listening_seasons.seasons[0].signature_track,
    false,
  );
  assert.equal(
    "private_artist_id" in
      view.behavior.listening_seasons.seasons[0].leading_artist,
    false,
  );
  assert.equal(view.behavior.artist_relationships[0].name, "Mara Vale");
  assert.equal(view.behavior.artist_relationships[0].span_years, 3);
  assert.equal(view.behavior.year_transitions[0].continuity_percent, 40);
  assert.deepEqual(view.behavior.year_transitions[0].new_artists, [
    "New Coast Archive",
    "Low Lanterns",
  ]);
  assert.equal(view.behavior.release_depth[0].title, "Night Transit");
  assert.equal(view.behavior.release_depth[0].distinct_tracks, 8);
  assert.equal(view.behavior.session_summary.session_count, 180);
  assert.equal(view.behavior.session_summary.extended_sequence_percent, 44.4);
  assert.equal(view.behavior.rediscovery_tracks[0].quiet_days, 242);
  assert.equal(
    view.behavior.rediscovery_tracks[0].rediscovery_signal,
    "saved-library state",
  );
  assert.equal(view.behavior.historical_return_tracks[0].return_count, 3);
  assert.equal(
    view.behavior.historical_return_tracks[0].longest_gap_days,
    730,
  );
  assert.equal(view.behavior.time_capsule_tracks[0].capsule_year, 2024);
  assert.equal(view.behavior.time_capsule_tracks[0].label, "First Light");
  assert.equal("external_refs" in view.behavior.time_capsule_tracks[0], false);
  assert.equal(view.behavior.back_to_back_tracks[0].label, "Fictional Echo");
  assert.equal(
    view.behavior.back_to_back_tracks[0].maximum_consecutive_plays,
    4,
  );
  assert.equal(
    "external_refs" in view.behavior.back_to_back_tracks[0],
    false,
  );
  assert.equal(view.behavior.context.start_reason_events, 1000);
  assert.equal(view.behavior.context.trackdone_starts, 600);
  assert.equal(view.behavior.context.end_reason_events, 1000);
  assert.equal(view.behavior.context.skip_state_events, 1000);
  assert.equal(view.behavior.context.shuffle_state_events, 1000);
  assert.equal(view.behavior.context.offline_state_events, 1000);
  assert.equal(
    view.behavior.context.historical_return_minimum_gap_days,
    180,
  );
  assert.equal(view.behavior.context.relationship_minimum_years, 2);
  assert.equal(view.behavior.context.continuity_artist_limit, 10);
  assert.equal(view.behavior.context.release_minimum_distinct_tracks, 3);
  assert.equal(view.behavior.context.session_gap_minutes, 30);
  assert.equal(view.behavior.context.extended_sequence_minimum_plays, 5);
  assert.equal(
    view.behavior.context.back_to_back_minimum_consecutive_plays,
    2,
  );
  assert.equal(view.deliberate.playlist_anchors[0].playlist_count, 3);
  assert.equal(view.coverage.active_listener_assertions, 2);
  assert.equal(view.deliberate.listener_preferences[0].label, "Mara Vale");
  assert.equal(view.deliberate.listener_avoids[0].label, "<Context-only track>");
  assert.equal(view.provider_snapshot.artists[0].best_rank, 1);
  assert.doesNotMatch(text, /evidence_id/u);
  assert.doesNotMatch(text, new RegExp(privateEvidenceId, "u"));
  assert.doesNotMatch(text, /track_ref_id/u);
  assert.doesNotMatch(text, /private-track-ref/u);
  assert.doesNotMatch(text, /PRIVATE PLAYLIST NAME/u);
  assert.doesNotMatch(text, /PRIVATE_RETURN_PROVIDER_ID/u);
  assert.doesNotMatch(text, /PRIVATE_BACK_TO_BACK_PROVIDER_ID/u);
  assert.doesNotMatch(text, /PROVIDER_PROSE_MUST_NOT_APPEAR/u);
  assert.doesNotMatch(text, /Users\/example/u);
});

test("tasteprint HTML is static, self-contained, escaped, and visually complete", () => {
  const html = renderTasteprintHtml(sampleProfile(), {
    generatedAt: "2026-09-02T12:00:00.000Z",
  });

  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /connect-src 'none'/u);
  assert.match(html, /The shape of your listening/u);
  assert.match(html, /aria-label="Tasteprint sections"/u);
  assert.match(html, /Explore this Tasteprint/u);
  assert.match(html, /href="#taste-shape"/u);
  assert.match(html, /href="#listening-arc"/u);
  assert.match(html, /href="#listening-seasons"/u);
  assert.match(html, /href="#tracks-that-stay"/u);
  assert.match(html, /href="#listener-corrections"/u);
  assert.match(html, /href="#profile-evidence"/u);
  assert.match(html, /href="#playback-flow"/u);
  assert.match(html, /href="#provider-snapshot"/u);
  assert.match(html, /href="#interpretation-boundaries"/u);
  assert.match(html, /Listening through time/u);
  assert.match(html, /What stayed\. What changed\./u);
  assert.match(html, /Artists across eras/u);
  assert.match(html, /Mara Vale/u);
  assert.match(html, /3 active years across 2024-2026/u);
  assert.match(html, /Year-to-year turnover/u);
  assert.match(html, /40% carried forward/u);
  assert.match(html, /6 new to 2026&#39;s top 10/u);
  assert.match(html, /href="#continuity"/u);
  assert.match(html, /href="#listening-patterns"/u);
  assert.match(html, /The shape of a listening stretch/u);
  assert.match(html, /Approximate sessions/u);
  assert.match(html, /Played back to back/u);
  assert.match(html, /id="back-to-back"/u);
  assert.match(html, /4 plays in the longest adjacent sequence/u);
  assert.match(html, /2 bounded sequences/u);
  assert.match(html, /does not prove repeat mode, intention, or liking/u);
  assert.match(html, /180 listening stretches/u);
  assert.match(html, /44\.4% contain 5 or more plays/u);
  assert.match(html, /Records explored in depth/u);
  assert.match(html, /Night Transit/u);
  assert.match(html, /8 distinct tracks/u);
  assert.doesNotMatch(html, /Fictional archive preview/u);
  assert.match(
    html,
    /14 provisional track identities joined to resolved Spotify identities/u,
  );
  assert.match(
    html,
    /Exact overlapping plays support behavioral aggregation across 22 effective events/u,
  );
  assert.match(
    html,
    /Multi-target cases stay separate: 3 provisional identities across 5 effective events were not joined/u,
  );
  assert.match(html, /Original records remain intact/u);
  assert.match(html, /first appearance in retained history/u);
  assert.match(html, /Listening Pulse/u);
  assert.match(html, /id="listening-pulse"/u);
  assert.match(html, /2 active retained months/u);
  assert.match(html, /January 2026: 80 eligible events/u);
  assert.match(html, /February 2026: no retained eligible events/u);
  assert.match(html, /not proof that no listening occurred/u);
  assert.match(html, /Listening Seasons/u);
  assert.match(html, /id="listening-seasons"/u);
  assert.match(html, /Fixed three-month UTC windows/u);
  assert.match(
    html,
    /\.listening-seasons-panel \.panel-intro \{ margin: 12px 0 24px; \}/u,
  );
  assert.match(html, /Seasonal Signal/u);
  assert.match(html, /55 first observed/u);
  assert.match(html, /20 seen earlier/u);
  assert.match(html, /not mood, identity, or life-event claims/u);
  assert.match(html, /Tracks that stay, disappear, and return/u);
  assert.match(html, /Worth another listen/u);
  assert.match(html, /Listening Time Machine/u);
  assert.match(html, /id="time-machine"/u);
  assert.match(html, /1 of 2 retained years has a landmark/u);
  assert.match(
    html,
    /2026 stays visible in the listening arc but has no selected landmark/u,
  );
  assert.match(html, /at least 2 engaged plays and 5 listening minutes/u);
  assert.match(html, /2024 landmark/u);
  assert.doesNotMatch(html, /PRIVATE_PROVIDER_ID/u);
  assert.match(html, /strongest year 2024/u);
  assert.doesNotMatch(html, /strongest year 2,024/u);
  assert.match(html, /Quiet for at least 90 days/u);
  assert.match(html, /Quiet Coordinates/u);
  assert.match(html, /242 days quiet/u);
  assert.match(html, /basis: saved-library state/u);
  assert.match(html, /latest retained event, not today's date/u);
  assert.match(html, /Music that came back/u);
  assert.match(html, /Gaps of at least 180 days/u);
  assert.match(html, /Recurring Light/u);
  assert.match(html, /3 observed returns/u);
  assert.match(html, /longest gap 730 days/u);
  assert.match(html, /latest return after 365 days/u);
  assert.doesNotMatch(html, /PRIVATE_RETURN_PROVIDER_ID/u);
  assert.match(html, /Your corrections/u);
  assert.match(html, /id="listener-corrections"/u);
  assert.match(html, /direct, retractable assertions/u);
  assert.match(html, /You said you like/u);
  assert.match(html, /You said to avoid/u);
  assert.match(html, /&lt;Context-only track&gt;/u);
  assert.match(html, /Played for someone else &lt;not mine&gt;/u);
  assert.match(html, /Deliberate choices/u);
  assert.match(html, /How your listening flows/u);
  assert.match(html, /Direct starts/u);
  assert.match(html, /Continued playback/u);
  assert.match(html, /Reached track end/u);
  assert.match(html, /30%/u);
  assert.match(html, /60%/u);
  assert.match(html, /1,000 events with a recorded start reason/u);
  assert.match(html, /Percentages use only rows where Spotify supplied/u);
  assert.match(html, /The provider's snapshot/u);
  assert.match(html, /Read with boundaries/u);
  assert.match(html, /Mara Vale/u);
  assert.match(html, /&lt;\/strong&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script/u);
  assert.doesNotMatch(html, /https?:\/\//u);
  assert.doesNotMatch(html, /PROVIDER_PROSE_MUST_NOT_APPEAR/u);
  assert.doesNotMatch(html, new RegExp(privateEvidenceId, "u"));
});

test("tasteprint card is bounded, static, and explicit about review before sharing", () => {
  const html = renderTasteprintCardHtml(sampleProfile(), {
    generatedAt: "2026-09-02T12:00:00.000Z",
  });

  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /connect-src 'none'/u);
  assert.match(html, /data-artifact="moondog-tasteprint-card\/1"/u);
  assert.match(html, /Private listening recap/u);
  assert.match(html, /Mara Vale anchors your long arc\./u);
  assert.match(html, /The artists that stay/u);
  assert.match(html, /Recent movement/u);
  assert.match(html, /North Window/u);
  assert.match(html, /Tracks you revisit/u);
  assert.match(html, /&lt;\/strong&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /Review before sharing/u);
  assert.match(html, /Review every visible artist, track, date, and aggregate/u);
  assert.match(html, /2 direct listener corrections applied to the full profile/u);
  assert.match(html, /Play count supports familiarity, not liking\./u);
  assert.doesNotMatch(html, /<script/u);
  assert.doesNotMatch(html, /https?:\/\//u);
  assert.doesNotMatch(html, /Context-only track/u);
  assert.doesNotMatch(html, /Played for someone else/u);
  assert.doesNotMatch(html, /Favorite Track/u);
  assert.doesNotMatch(html, /Mara Vale<\/strong><span>Favorited/u);
  assert.doesNotMatch(html, /PRIVATE PLAYLIST NAME/u);
  assert.doesNotMatch(html, /Provider Artist/u);
  assert.doesNotMatch(html, /PROVIDER_PROSE_MUST_NOT_APPEAR/u);
  assert.doesNotMatch(html, /evidence[_-]?id/iu);
  assert.doesNotMatch(html, /track[_-]?ref/iu);
  assert.doesNotMatch(html, new RegExp(privateEvidenceId, "u"));
  assert.doesNotMatch(html, /Users\/example/u);
});

test("history-only Tasteprint labels facets honestly and omits empty evidence sections", () => {
  const profile = sampleProfile();
  profile.strong_preferences = [];
  profile.listener_assertions = {
    active: [],
    preferences: [],
    avoids: [],
    retractions: 0,
  };
  profile.curated_preferences = {
    saved_tracks: [],
    playlist_anchors: [],
    followed_artists: [],
    saved_albums: [],
  };
  profile.search_intent = [];
  profile.genre_facets = [];
  profile.provider_signals = {
    artists: [],
    tracks: [],
    genres: [],
    highlights: [],
    metrics: [],
    interpretations: [],
  };

  const html = renderTasteprintHtml(profile, {
    generatedAt: "2026-09-02T12:00:00.000Z",
  });

  assert.match(
    html,
    /A bounded reading of familiarity, recent movement, listening-year landmarks, monthly listening pulse, listening seasons, taste continuity, listening patterns, listen-again prompts, and listening context\./u,
  );
  assert.match(html, /<h2>Profile facets<\/h2>/u);
  assert.match(html, /Profile summary, not direct choice/u);
  assert.match(html, /Artist facets/u);
  assert.match(html, /Mara Vale/u);
  assert.match(html, /Tracks that stay/u);
  assert.doesNotMatch(html, /Deliberate choices/u);
  assert.doesNotMatch(html, /No bounded deliberate signal/u);
  assert.doesNotMatch(html, /No bounded facets/u);
  assert.doesNotMatch(html, /Saved tracks<\/h3>/u);
  assert.doesNotMatch(html, /Playlist anchors/u);
  assert.doesNotMatch(html, /The provider's snapshot/u);
  assert.doesNotMatch(html, /href="#listener-corrections"/u);
  assert.doesNotMatch(html, /href="#provider-snapshot"/u);
  assert.doesNotMatch(html, /No bounded provider/u);
});

test("partial provider snapshots render only populated provider panels", () => {
  const profile = sampleProfile();
  profile.provider_signals.artists = [];
  profile.provider_signals.tracks = [];
  profile.provider_signals.genres = [];
  profile.provider_signals.metrics = [];

  const html = renderTasteprintHtml(profile, {
    generatedAt: "2026-09-02T12:00:00.000Z",
  });

  assert.match(html, /The provider's snapshot/u);
  assert.match(html, /Provider highlight/u);
  assert.match(html, /Provider Highlight/u);
  assert.doesNotMatch(html, /<h3>Ranked artists<\/h3>/u);
  assert.doesNotMatch(html, /<h3>Ranked tracks<\/h3>/u);
  assert.doesNotMatch(html, /No bounded provider/u);
});

test("public Tasteprint demo is deterministic and unmistakably synthetic", () => {
  const profile = createPublicTasteprintDemoProfile();
  const options = {
    generatedAt: PUBLIC_TASTEPRINT_DEMO_GENERATED_AT,
    syntheticDemo: true,
  };
  const view = createTasteprintView(profile, options);
  const first = renderTasteprintHtml(profile, options);
  const second = renderTasteprintHtml(createPublicTasteprintDemoProfile(), options);
  const firstCard = renderTasteprintCardHtml(profile, options);
  const secondCard = renderTasteprintCardHtml(
    createPublicTasteprintDemoProfile(),
    options,
  );

  assert.equal(view.synthetic_demo, true);
  assert.equal(view.privacy.classification, "public_synthetic_demo");
  assert.equal(view.privacy.contains_personal_music_context, false);
  assert.deepEqual(
    view.behavior.history_arc.map((item) => item.year),
    [2023, 2024, 2025, 2026],
  );
  assert.equal(view.behavior.history_arc[2].first_observed_tracks, 743);
  assert.equal(view.behavior.monthly_activity.represented_month_count, 36);
  assert.equal(view.behavior.monthly_activity.active_month_count, 36);
  assert.equal(view.behavior.listening_seasons.represented_season_count, 13);
  assert.equal(view.behavior.listening_seasons.preview_season_count, 12);
  assert.equal(view.behavior.listening_seasons.preview_omitted_season_count, 1);
  assert.equal(view.behavior.listening_seasons.seasons[0].key, "2023-Q4");
  assert.equal(view.behavior.listening_seasons.seasons.at(-1).key, "2026-Q3");
  assert.equal(view.behavior.rediscovery_tracks[0].label, "Quiet Coordinates");
  assert.equal(
    view.behavior.historical_return_tracks[0].label,
    "Quiet Coordinates",
  );
  assert.equal(view.behavior.historical_return_tracks[0].return_count, 2);
  assert.equal(view.behavior.release_depth[0].title, "Night Transit");
  assert.equal(view.behavior.session_summary.session_count, 2_500);
  assert.equal(first, second);
  assert.equal(firstCard, secondCard);
  assert.match(first, /Synthetic public demo/u);
  assert.match(first, /fictional demonstration data/u);
  assert.match(first, /Mara Vale/u);
  assert.match(first, /Worth another listen/u);
  assert.match(first, /Music that came back/u);
  assert.match(first, /Listening Pulse/u);
  assert.match(first, /36 active retained months/u);
  assert.match(first, /Listening Seasons/u);
  assert.match(first, /13 active seasons/u);
  assert.match(first, /latest 12 of 13 represented seasons/u);
  assert.match(first, /Blue Hour Index/u);
  assert.match(first, /not proof of liking, nostalgia/u);
  assert.match(first, /Quiet Coordinates/u);
  assert.match(first, /The shape of a listening stretch/u);
  assert.match(first, /Records explored in depth/u);
  assert.match(first, /Fictional archive preview/u);
  assert.doesNotMatch(first, /Private and local/u);
  assert.doesNotMatch(first, /evidence[_-]?id/iu);
  assert.doesNotMatch(first, /track[_-]?ref/iu);
  assert.doesNotMatch(first, /\/Users\//u);
  assert.match(firstCard, /Synthetic public demo/u);
  assert.match(firstCard, /Fictional public profile/u);
  assert.match(firstCard, /fictional demonstration data/u);
  assert.doesNotMatch(firstCard, /Private recap/u);
  assert.doesNotMatch(firstCard, /Review before sharing/u);
  assert.doesNotMatch(firstCard, /evidence[_-]?id/iu);
  assert.doesNotMatch(firstCard, /track[_-]?ref/iu);
  assert.doesNotMatch(firstCard, /\/Users\//u);
});

test("tasteprint artifact defaults to a private state directory and refuses overwrite", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "moondog-tasteprint-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const generatedAt = "2026-09-02T12:00:00.000Z";
  const environment = { MOONDOG_STATE_HOME: temporary };

  const artifact = await writeTasteprintArtifact(sampleProfile(), {
    generatedAt,
    environment,
  });
  const contents = await readFile(artifact.path, "utf8");
  const fileMode = (await stat(artifact.path)).mode & 0o777;
  const directoryMode = (await stat(path.dirname(artifact.path))).mode & 0o777;

  assert.equal(path.dirname(artifact.path), path.join(temporary, "tasteprints"));
  assert.equal(fileMode, 0o600);
  assert.equal(directoryMode, 0o700);
  assert.equal(artifact.bytes, Buffer.byteLength(contents));
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
  await assert.rejects(
    () =>
      writeTasteprintArtifact(sampleProfile(), {
        generatedAt,
        environment,
      }),
    /output already exists/u,
  );
});

test("tasteprint card artifact uses a distinct private filename and format contract", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "moondog-tasteprint-card-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const generatedAt = "2026-09-02T12:00:00.000Z";
  const environment = { MOONDOG_STATE_HOME: temporary };

  const artifact = await writeTasteprintArtifact(sampleProfile(), {
    generatedAt,
    environment,
    format: "card",
  });
  const contents = await readFile(artifact.path, "utf8");

  assert.equal(
    path.basename(artifact.path),
    "tasteprint-card-2026-09-02T12-00-00-000Z.html",
  );
  assert.equal(artifact.artifact_version, "moondog-tasteprint-card-artifact/1");
  assert.equal(artifact.artifact_format, "card");
  assert.equal((await stat(artifact.path)).mode & 0o777, 0o600);
  assert.match(contents, /data-artifact="moondog-tasteprint-card\/1"/u);
  await assert.rejects(
    () =>
      writeTasteprintArtifact(sampleProfile(), {
        generatedAt,
        environment,
        format: "card",
      }),
    /output already exists/u,
  );
  await assert.rejects(
    () =>
      writeTasteprintArtifact(sampleProfile(), {
        generatedAt,
        environment,
        format: "poster",
      }),
    /format must be full or card/u,
  );
});
