import assert from "node:assert/strict";
import test from "node:test";

import { formatLocalResult } from "../../src/surfaces/cli/format-output.mjs";

test("music imports retain platform labels and do not display missing duration or playback context as measured zero", () => {
  const output = formatLocalResult("taste", {
    coverage: { effective_listening_events: 1, events_with_played_duration: 0, listening_hours: 0,
      collection_sources: [{ label: "YouTube Music", tracks: 2 }] },
    listening_behavior: { repeat_tracks: [{ label: "Moon", play_count: 1, listening_minutes: 0 }],
      context: { direct_selection_starts: 0, start_reason_events: 0 } },
  });
  assert.match(output, /Listening time: unknown/u);
  assert.match(output, /YouTube Music collection: 2 tracks/u);
  assert.match(output, /Moon - 1 plays/u);
  assert.doesNotMatch(output, /0 min|Playback flow|Spotify supplied/u);
});

test("taste output makes behavioral evidence readable without provider prose", () => {
  const evidenceId = "11111111-2222-4333-8444-555555555555";
  const output = formatLocalResult("taste", {
    coverage: {
      effective_listening_events: 1200,
      listening_hours: 75,
      listening_tracks: 340,
      cross_format_track_links: 14,
      cross_format_linked_events: 22,
      cross_format_ambiguous_tracks: 3,
      cross_format_ambiguous_events: 5,
      spotify_saved_tracks: 80,
      spotify_playlist_memberships: 120,
    },
    listening_behavior: {
      enduring_artists: [
        {
          name: "Mara Vale",
          play_count: 91,
          listening_minutes: 420,
          distinct_tracks: 17,
          evidence_id: evidenceId,
        },
      ],
      recent_artists: [
        {
          name: "North Window",
          play_count: 24,
          listening_minutes: 110,
          distinct_tracks: 6,
          evidence_id: evidenceId,
        },
      ],
      repeat_tracks: [
        {
          label: "Midnight Lines",
          artist_credit: "Mara Vale",
          play_count: 31,
          listening_minutes: 150,
          evidence_id: evidenceId,
        },
      ],
      recent_tracks: [],
      rediscovery_tracks: [
        {
          label: "Quiet Coordinates",
          artist_credit: "Sable Arcade",
          play_count: 18,
          listening_minutes: 92,
          quiet_days: 240,
          peak_year: 2024,
          rediscovery_signal: "saved-library state",
          evidence_id: evidenceId,
        },
      ],
      historical_return_tracks: [
        {
          label: "Recurring Light",
          artist_credit: "North Window",
          play_count: 8,
          listening_minutes: 32,
          return_count: 3,
          longest_gap_days: 730,
          latest_return_gap_days: 365,
          historical_return_signal: "historical attention only",
          evidence_id: evidenceId,
        },
      ],
      time_capsule_tracks: [
        {
          label: "First Light",
          artist_credit: "Early Artist",
          capsule_year: 2024,
          year_play_count: 8,
          year_engaged_play_count: 8,
          year_listening_minutes: 32,
          year_explicit_skips: 0,
          lifetime_play_count: 12,
          lifetime_listening_minutes: 48,
          representative_signal: "historical attention only",
          evidence_id: evidenceId,
        },
      ],
      back_to_back_tracks: [
        {
          label: "Fictional Echo",
          artist_credit: "Sequence Study",
          play_count: 9,
          maximum_consecutive_plays: 4,
          burst_count: 2,
          plays_in_bursts: 7,
          listening_minutes_in_bursts: 28,
          sequence_signal: "adjacent retained plays",
          evidence_id: evidenceId,
        },
      ],
      history_arc: [
        {
          year: 2026,
          event_count: 620,
          listening_minutes: 2_340,
          distinct_tracks: 190,
          first_observed_tracks: 75,
          top_artist: { name: "North Window" },
        },
      ],
      listening_seasons: {
        seasons: [
          {
            key: "2026-Q1",
            start_month: "2026-01",
            end_month: "2026-03",
            event_count: 126,
            listening_minutes: 292,
            distinct_tracks: 75,
            first_observed_tracks: 55,
            returning_tracks: 20,
            leading_artist: { name: "North Window" },
            signature_track: {
              label: "Seasonal Signal",
              artist_credit: "North Window",
            },
          },
          {
            key: "2026-Q2",
            start_month: "2026-04",
            end_month: "2026-06",
            event_count: 0,
          },
        ],
      },
      context: {
        recent_window_days: 90,
        effective_events_profiled: 1_197,
        start_reason_events: 1_000,
        direct_selection_starts: 300,
        trackdone_starts: 600,
        end_reason_events: 1_000,
        trackdone_endings: 800,
        skip_state_events: 1_000,
        explicit_skips: 100,
        shuffle_state_events: 1_000,
        shuffle_events: 250,
        offline_state_events: 1_000,
        offline_events: 20,
        incognito_events_excluded: 3,
        rediscovery_quiet_days: 90,
        historical_return_minimum_gap_days: 180,
        back_to_back_minimum_consecutive_plays: 2,
      },
    },
    strong_preferences: [
      {
        label: "Mara Vale",
        signal: "Favorited",
        evidence_id: evidenceId,
      },
    ],
    listening_source: {
      listening_range: {
        earliest: "2024-01-01T00:00:00.000Z",
        latest: "2026-08-30T00:00:00.000Z",
      },
    },
    limitations: ["Play count supports familiarity, not liking."],
    provider_signals: {
      interpretations: [
        {
          text: "PROVIDER_PROSE_MUST_NOT_APPEAR",
        },
      ],
    },
  });

  assert.match(output, /Your Moondog tasteprint/u);
  assert.match(output, /Long arc/u);
  assert.match(output, /Recent movement \(90 days\)/u);
  assert.match(output, /Listening through time \(UTC\)/u);
  assert.match(output, /2026 - 39 h, 620 events, 190 tracks, 75 first observed/u);
  assert.match(output, /most heard artist: North Window/u);
  assert.match(output, /Listening Seasons \(fixed UTC calendar quarters\)/u);
  assert.match(output, /2026 Q1 \(2026-01 to 2026-03 UTC\)/u);
  assert.match(output, /55 first observed, 20 seen earlier/u);
  assert.match(output, /leading artist: North Window/u);
  assert.match(output, /signature track: Seasonal Signal - North Window/u);
  assert.match(output, /2026 Q2 \(2026-04 to 2026-06 UTC\) - no retained eligible events/u);
  assert.match(output, /do not infer preference, mood, or life events/u);
  assert.match(output, /Tracks you return to/u);
  assert.match(output, /Worth another listen \(quiet 90\+ days\)/u);
  assert.match(output, /Quiet Coordinates - Sable Arcade/u);
  assert.match(output, /240 days quiet, strongest year 2024, basis: saved-library state/u);
  assert.match(output, /Music that came back \(gaps 180\+ days\)/u);
  assert.match(output, /Recurring Light - North Window/u);
  assert.match(
    output,
    /3 observed returns, longest gap 730 days, latest return after 365 days/u,
  );
  assert.match(output, /Listening Time Machine/u);
  assert.match(output, /2024: First Light - Early Artist/u);
  assert.match(output, /8 plays in year, 32 min in year/u);
  assert.match(output, /Played back to back \(2\+ adjacent plays\)/u);
  assert.match(output, /Fictional Echo - Sequence Study/u);
  assert.match(
    output,
    /4 plays in longest adjacent sequence, 2 bounded sequences, 7 plays across sequences, 28 min across sequences/u,
  );
  assert.match(output, /do not prove repeat mode, intentional replay, or liking/u);
  assert.match(output, /Playback flow/u);
  assert.match(output, /Direct starts: 300 of 1,000 start-reason events \(30%\)/u);
  assert.match(output, /Continued playback: 600 of 1,000 start-reason events \(60%\)/u);
  assert.match(output, /Reached track end: 800 of 1,000 end-reason events \(80%\)/u);
  assert.match(output, /Explicit skips: 100 of 1,000 skip-state events \(10%\)/u);
  assert.match(output, /Shuffle active: 250 of 1,000 shuffle-state events \(25%\)/u);
  assert.match(output, /Offline playback: 20 of 1,000 offline-state events \(2%\)/u);
  assert.match(output, /not proof of taste, attention, satisfaction, personality, location, or device use/u);
  assert.match(output, /Deliberate choices/u);
  assert.match(output, /1,200/u);
  assert.match(
    output,
    /Cross-format track links: 14 provisional identities across 22 effective events/u,
  );
  assert.match(
    output,
    /Ambiguous cross-format identities kept separate: 3 across 5 effective events/u,
  );
  assert.match(output, /Incognito events excluded from taste inference: 3/u);
  assert.doesNotMatch(output, new RegExp(evidenceId, "u"));
  assert.doesNotMatch(output, /PROVIDER_PROSE_MUST_NOT_APPEAR/u);
});
