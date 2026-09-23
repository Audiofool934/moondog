import assert from "node:assert/strict";
import test from "node:test";

import { projectListeningProfile } from "../../src/profile/listening-profile-projection.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";

function eventRow({
  occurredAt,
  artist,
  title,
  release,
  playedMs = 120_000,
  source = "spotify-extended-history",
  incognito = false,
}) {
  return {
    event: {
      occurred_at: occurredAt,
      played_ms: playedMs,
      event_type: "play_observed",
      extensions: {
        "spotify.incognito_mode": incognito,
      },
      provenance: {
        external_ref: {
          system: source,
        },
      },
    },
    track: {
      track_ref_id: `${artist}:${release}:${title}`,
      identity_status: "resolved",
      title,
      artist_credits: [{ name: artist, role: "primary" }],
      release: { title: release },
    },
  };
}

test("listening patterns expose monthly pulse, multi-track release depth, and bounded approximate sessions", () => {
  const { summary, explanations } = projectListeningProfile({
    subjectId,
    eventRows: [
      eventRow({
        occurredAt: "2024-01-01T10:00:00.000Z",
        artist: "Album Artist",
        title: "Album Track One",
        release: "Whole Record",
      }),
      eventRow({
        occurredAt: "2024-01-01T10:10:00.000Z",
        artist: "Album Artist",
        title: "Album Track Two",
        release: "Whole Record",
      }),
      eventRow({
        occurredAt: "2024-01-01T10:20:00.000Z",
        artist: "Album Artist",
        title: "Album Track Three",
        release: "Whole Record",
      }),
      eventRow({
        occurredAt: "2024-01-01T11:00:00.000Z",
        artist: "Album Artist",
        title: "Album Track One",
        release: "Whole Record",
      }),
      eventRow({
        occurredAt: "2024-01-01T11:10:00.000Z",
        artist: "Album Artist",
        title: "Album Track Two",
        release: "Whole Record",
      }),
      eventRow({
        occurredAt: "2024-01-01T11:20:00.000Z",
        artist: "Album Artist",
        title: "Album Track Three",
        release: "Whole Record",
      }),
      eventRow({
        occurredAt: "2024-01-01T11:30:00.000Z",
        artist: "Album Artist",
        title: "Album Track Four",
        release: "Whole Record",
      }),
      eventRow({
        occurredAt: "2024-01-01T11:40:00.000Z",
        artist: "Album Artist",
        title: "Album Track Five",
        release: "Whole Record",
      }),
      eventRow({
        occurredAt: "2025-04-02T09:00:00.000Z",
        artist: "Album Artist",
        title: "Album Track Three",
        release: "Whole Record",
      }),
      eventRow({
        occurredAt: "2025-04-02T09:05:00.000Z",
        artist: "Single Artist",
        title: "Only Track",
        release: "One Track Release",
        source: "listenbrainz",
      }),
      eventRow({
        occurredAt: "2025-04-02T09:10:00.000Z",
        artist: "Private Artist",
        title: "Private Track",
        release: "Private Record",
        incognito: true,
      }),
    ],
  });

  assert.deepEqual(summary.listening_behavior.release_depth, [
    {
      title: "Whole Record",
      artist_credit: "Album Artist",
      distinct_tracks: 5,
      play_count: 9,
      engaged_play_count: 9,
      listening_minutes: 18,
      first_year: 2024,
      last_year: 2025,
      active_years: 2,
      evidence_id: summary.listening_behavior.release_depth[0].evidence_id,
    },
  ]);
  assert.deepEqual(
    {
      ...summary.listening_behavior.monthly_activity,
      evidence_id: "<stable aggregate evidence>",
      months: summary.listening_behavior.monthly_activity.months.map(
        (month) => ({ ...month }),
      ),
    },
    {
      timezone: "UTC",
      first_month: "2024-01",
      last_month: "2025-04",
      retained_span_months: 16,
      represented_month_count: 16,
      active_month_count: 2,
      omitted_earlier_month_count: 0,
      peak_listening_minutes: 16,
      months: [
        {
          month: "2024-01",
          event_count: 8,
          engaged_play_count: 8,
          listening_minutes: 16,
          distinct_tracks: 5,
        },
        ...Array.from({ length: 14 }, (_, index) => ({
          month: new Date(Date.UTC(2024, index + 1, 1))
            .toISOString()
            .slice(0, 7),
          event_count: 0,
          engaged_play_count: 0,
          listening_minutes: 0,
          distinct_tracks: 0,
        })),
        {
          month: "2025-04",
          event_count: 2,
          engaged_play_count: 2,
          listening_minutes: 4,
          distinct_tracks: 2,
        },
      ],
      evidence_id: "<stable aggregate evidence>",
    },
  );
  assert.deepEqual(
    {
      ...summary.listening_behavior.listening_seasons,
      evidence_id: "<stable aggregate evidence>",
    },
    {
      timezone: "UTC",
      alignment: "calendar_quarter",
      season_length_months: 3,
      retained_first_season: "2024-Q1",
      represented_first_season: "2024-Q1",
      last_season: "2025-Q2",
      retained_season_count: 6,
      represented_season_count: 6,
      active_season_count: 2,
      represented_active_season_count: 2,
      omitted_earlier_season_count: 0,
      omitted_earlier_active_season_count: 0,
      seasons: [
        {
          key: "2024-Q1",
          start_month: "2024-01",
          end_month: "2024-03",
          retained_month_count: 3,
          active_month_count: 1,
          event_count: 8,
          engaged_play_count: 8,
          listening_minutes: 16,
          distinct_tracks: 5,
          first_observed_tracks: 5,
          returning_tracks: 0,
          leading_artist: {
            name: "Album Artist",
            event_count: 8,
            engaged_play_count: 8,
            listening_minutes: 16,
            distinct_tracks: 5,
          },
          signature_track: {
            track_ref_id: "Album Artist:Whole Record:Album Track One",
            label: "Album Track One",
            artist_credit: "Album Artist",
            release: "Whole Record",
            play_count: 2,
            engaged_play_count: 2,
            listening_minutes: 4,
            explicit_skips: 0,
          },
        },
        ...["2024-Q2", "2024-Q3", "2024-Q4", "2025-Q1"].map(
          (key, index) => ({
            key,
            start_month: ["2024-04", "2024-07", "2024-10", "2025-01"][index],
            end_month: ["2024-06", "2024-09", "2024-12", "2025-03"][index],
            retained_month_count: 3,
            active_month_count: 0,
            event_count: 0,
            engaged_play_count: 0,
            listening_minutes: 0,
            distinct_tracks: 0,
            first_observed_tracks: 0,
            returning_tracks: 0,
          }),
        ),
        {
          key: "2025-Q2",
          start_month: "2025-04",
          end_month: "2025-04",
          retained_month_count: 1,
          active_month_count: 1,
          event_count: 2,
          engaged_play_count: 2,
          listening_minutes: 4,
          distinct_tracks: 2,
          first_observed_tracks: 1,
          returning_tracks: 1,
          leading_artist: {
            name: "Album Artist",
            event_count: 1,
            engaged_play_count: 1,
            listening_minutes: 2,
            distinct_tracks: 1,
          },
          signature_track: {
            track_ref_id: "Album Artist:Whole Record:Album Track Three",
            label: "Album Track Three",
            artist_credit: "Album Artist",
            release: "Whole Record",
            play_count: 1,
            engaged_play_count: 1,
            listening_minutes: 2,
            explicit_skips: 0,
          },
        },
      ],
      evidence_id: "<stable aggregate evidence>",
    },
  );
  assert.deepEqual(
    summary.listening_behavior.session_summary,
    {
      source: "spotify_extended_history",
      method: "track_stop_gap",
      gap_minutes: 30,
      event_count: 9,
      session_count: 3,
      median_plays: 3,
      median_listening_minutes: 6,
      single_play_sessions: 1,
      short_sequence_sessions: 1,
      extended_sequence_sessions: 1,
      extended_sequence_minimum_plays: 5,
      extended_sequence_percent: 33.3,
      evidence_id: summary.listening_behavior.session_summary.evidence_id,
    },
  );
  assert.equal(summary.listening_behavior.context.release_minimum_distinct_tracks, 3);
  assert.equal(summary.listening_behavior.context.session_gap_minutes, 30);
  assert.equal(summary.listening_behavior.context.extended_sequence_minimum_plays, 5);
  assert.equal(summary.listening_behavior.context.monthly_activity_maximum_months, 240);
  assert.equal(summary.listening_behavior.context.listening_season_maximum_seasons, 80);

  const releaseEvidence = explanations.get(
    summary.listening_behavior.release_depth[0].evidence_id,
  );
  assert.equal(releaseEvidence.claim.dimension, "taste.release_depth");
  assert.match(releaseEvidence.interpretation_limit, /doesn't mean you played the whole album/u);
  const sessionEvidence = explanations.get(
    summary.listening_behavior.session_summary.evidence_id,
  );
  assert.equal(sessionEvidence.claim.dimension, "listening.session_shape");
  assert.match(sessionEvidence.interpretation_limit, /estimated/u);
  const pulseEvidence = explanations.get(
    summary.listening_behavior.monthly_activity.evidence_id,
  );
  assert.equal(pulseEvidence.claim.dimension, "listening.monthly_activity");
  assert.match(pulseEvidence.interpretation_limit, /blank month/u);
  const seasonEvidence = explanations.get(
    summary.listening_behavior.listening_seasons.evidence_id,
  );
  assert.equal(seasonEvidence.claim.dimension, "listening.seasons");
  assert.match(seasonEvidence.interpretation_limit, /not always when you found it/u);
  assert.match(seasonEvidence.interpretation_limit, /describes that season only/u);

  const longSeasonRows = Array.from({ length: 82 }, (_, index) => {
    const year = 2000 + Math.floor(index / 4);
    const month = index % 4 * 3 + 1;
    return eventRow({
      occurredAt: `${year}-${String(month).padStart(2, "0")}-01T00:00:00.000Z`,
      artist: `Season Artist ${index}`,
      title: `Season Track ${index}`,
      release: `Season Release ${index}`,
    });
  });
  const boundedSeasons = projectListeningProfile({
    subjectId,
    eventRows: longSeasonRows,
  }).summary.listening_behavior.listening_seasons;
  const reversedBoundedSeasons = projectListeningProfile({
    subjectId,
    eventRows: [...longSeasonRows].reverse(),
  }).summary.listening_behavior.listening_seasons;
  assert.equal(boundedSeasons.retained_season_count, 82);
  assert.equal(boundedSeasons.represented_season_count, 80);
  assert.equal(boundedSeasons.active_season_count, 82);
  assert.equal(boundedSeasons.represented_active_season_count, 80);
  assert.equal(boundedSeasons.omitted_earlier_season_count, 2);
  assert.equal(boundedSeasons.omitted_earlier_active_season_count, 2);
  assert.equal(boundedSeasons.represented_first_season, "2000-Q3");
  assert.equal(boundedSeasons.last_season, "2020-Q2");
  assert.equal(boundedSeasons.seasons.length, 80);
  assert.deepEqual(boundedSeasons, reversedBoundedSeasons);
});
