export const PUBLIC_TASTEPRINT_DEMO_GENERATED_AT =
  "2026-08-25T12:00:00.000Z";

function distributeSyntheticTotal(total, weights) {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let remaining = total;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return remaining;
    const value = Math.floor((total * weight) / weightTotal);
    remaining -= value;
    return value;
  });
}

function createSyntheticMonthlyActivity() {
  const periods = [
    {
      year: 2023,
      firstMonth: 9,
      events: 2_480,
      minutes: 8_940,
      weights: [1.1, 0.8, 1.25, 0.95],
    },
    {
      year: 2024,
      firstMonth: 1,
      events: 5_210,
      minutes: 17_820,
      weights: [1.2, 0.95, 1.05, 0.8, 0.9, 1.35, 1.18, 0.92, 1.12, 0.86, 0.98, 1.28],
    },
    {
      year: 2025,
      firstMonth: 1,
      events: 6_184,
      minutes: 21_636,
      weights: [1.32, 1.08, 0.92, 1.16, 0.88, 1.24, 1.02, 0.96, 1.34, 1.1, 0.9, 1.28],
    },
    {
      year: 2026,
      firstMonth: 1,
      events: 4_522,
      minutes: 13_788,
      weights: [1.15, 0.92, 1.28, 0.86, 1.04, 1.34, 0.98, 1.2],
    },
  ];
  const months = periods.flatMap((period) => {
    const eventCounts = distributeSyntheticTotal(period.events, period.weights);
    const minuteCounts = distributeSyntheticTotal(period.minutes, period.weights);
    return period.weights.map((_, index) => {
      const eventCount = eventCounts[index];
      return {
        month: `${period.year}-${String(period.firstMonth + index).padStart(2, "0")}`,
        event_count: eventCount,
        engaged_play_count: Math.round(eventCount * 0.845),
        listening_minutes: minuteCounts[index],
        distinct_tracks: Math.max(1, Math.round(eventCount * 0.36)),
      };
    });
  });
  return {
    timezone: "UTC",
    first_month: months[0].month,
    last_month: months.at(-1).month,
    retained_span_months: months.length,
    represented_month_count: months.length,
    active_month_count: months.length,
    omitted_earlier_month_count: 0,
    peak_listening_minutes: Math.max(
      ...months.map((month) => month.listening_minutes),
    ),
    months,
  };
}

function createSyntheticListeningSeasons() {
  const anchors = [
    ["Mara Vale", "Midnight Lines", "Night Transit"],
    ["Sable Arcade", "Signal Garden", "Night Survey"],
    ["North Window", "Glass Highway", "Pale Signals"],
    ["Lumen Choir", "Amber Receiver", "Open Frequencies"],
    ["Ash Meridian", "Blue Exit", "Afterimage"],
    ["Static Bloom", "Soft Static", "Quiet Machinery"],
    ["Mara Vale", "Night Transit", "Night Transit"],
    ["Juniper City", "Empty Overpass", "Exit Weather"],
    ["Elsewhere Signal", "Parallel Rooms", "Long Distance"],
    ["Cinder Lake", "Weather Memory", "Shoreline Code"],
    ["North Window", "First Light Behind Us", "Pale Signals"],
    ["Drift Assembly", "Northern Relay", "Moving Weather"],
    ["New Coast Archive", "Blue Hour Index", "Tide Tables"],
  ];
  const groups = new Map();
  for (const month of createSyntheticMonthlyActivity().months) {
    const year = Number(month.month.slice(0, 4));
    const monthNumber = Number(month.month.slice(5, 7));
    const quarter = Math.floor((monthNumber - 1) / 3) + 1;
    const key = `${year}-Q${quarter}`;
    const group = groups.get(key) ?? [];
    group.push(month);
    groups.set(key, group);
  }
  const seasons = [...groups.entries()].map(([key, months], index) => {
    const eventCount = months.reduce(
      (sum, month) => sum + month.event_count,
      0,
    );
    const engagedPlayCount = months.reduce(
      (sum, month) => sum + month.engaged_play_count,
      0,
    );
    const listeningMinutes = months.reduce(
      (sum, month) => sum + month.listening_minutes,
      0,
    );
    const distinctTracks = Math.max(
      1,
      Math.round(months.reduce((sum, month) => sum + month.distinct_tracks, 0) * 0.72),
    );
    const firstObservedShare = Math.max(0.18, 0.7 - index * 0.04);
    const firstObservedTracks = Math.round(
      distinctTracks * firstObservedShare,
    );
    const [artist, track, release] = anchors[index];
    const leadingEventCount = Math.max(1, Math.round(eventCount * 0.16));
    const leadingEngagedPlayCount = Math.round(leadingEventCount * 0.88);
    const signaturePlayCount = Math.max(1, Math.round(eventCount * 0.035));
    const signatureEngagedPlayCount = Math.round(signaturePlayCount * 0.91);
    return {
      key,
      start_month: months[0].month,
      end_month: months.at(-1).month,
      retained_month_count: months.length,
      active_month_count: months.length,
      event_count: eventCount,
      engaged_play_count: engagedPlayCount,
      listening_minutes: listeningMinutes,
      distinct_tracks: distinctTracks,
      first_observed_tracks: firstObservedTracks,
      returning_tracks: distinctTracks - firstObservedTracks,
      leading_artist: {
        name: artist,
        event_count: leadingEventCount,
        engaged_play_count: leadingEngagedPlayCount,
        listening_minutes: Math.max(1, Math.round(listeningMinutes * 0.17)),
        distinct_tracks: Math.max(1, Math.round(distinctTracks * 0.14)),
      },
      signature_track: {
        label: track,
        artist_credit: artist,
        release,
        play_count: signaturePlayCount,
        engaged_play_count: signatureEngagedPlayCount,
        listening_minutes: Math.max(1, Math.round(signaturePlayCount * 4.6)),
        explicit_skips: signaturePlayCount - signatureEngagedPlayCount,
      },
    };
  });
  return {
    timezone: "UTC",
    alignment: "calendar_quarter",
    season_length_months: 3,
    retained_first_season: seasons[0].key,
    represented_first_season: seasons[0].key,
    last_season: seasons.at(-1).key,
    retained_season_count: seasons.length,
    represented_season_count: seasons.length,
    active_season_count: seasons.length,
    represented_active_season_count: seasons.length,
    omitted_earlier_season_count: 0,
    omitted_earlier_active_season_count: 0,
    seasons,
  };
}

const publicTasteprintDemoProfile = {
  profile_version: "profile-projection/synthetic-demo-1",
  coverage: {
    effective_listening_events: 18_420,
    profiled_listening_events: 18_396,
    listening_hours: 1_036.4,
    listening_tracks: 3_260,
    resolved_listening_tracks: 3_218,
    spotify_saved_tracks: 286,
    spotify_saved_albums: 72,
    spotify_followed_artists: 34,
    spotify_playlist_memberships: 642,
    verified_search_interactions: 41,
    tracks_observed: 1_240,
    loved_or_favorited: 94,
  },
  listening_behavior: {
    enduring_artists: [
      { name: "Mara Vale", play_count: 1_230, listening_minutes: 5_420, distinct_tracks: 88 },
      { name: "North Window", play_count: 1_104, listening_minutes: 4_810, distinct_tracks: 73 },
      { name: "Ash Meridian", play_count: 846, listening_minutes: 3_650, distinct_tracks: 61 },
      { name: "Lumen Choir", play_count: 698, listening_minutes: 2_880, distinct_tracks: 49 },
      { name: "Static Bloom", play_count: 605, listening_minutes: 2_430, distinct_tracks: 44 },
      { name: "Juniper City", play_count: 531, listening_minutes: 2_150, distinct_tracks: 39 },
      { name: "Cinder Lake", play_count: 477, listening_minutes: 1_920, distinct_tracks: 36 },
      { name: "Elsewhere Signal", play_count: 418, listening_minutes: 1_760, distinct_tracks: 31 },
      { name: "Glass Atlas", play_count: 376, listening_minutes: 1_550, distinct_tracks: 28 },
      { name: "Sable Arcade", play_count: 319, listening_minutes: 1_320, distinct_tracks: 25 },
    ],
    recent_artists: [
      { name: "North Window", play_count: 98, listening_minutes: 620, distinct_tracks: 18 },
      { name: "Juniper City", play_count: 86, listening_minutes: 540, distinct_tracks: 14 },
      { name: "Drift Assembly", play_count: 77, listening_minutes: 468, distinct_tracks: 11 },
      { name: "Mara Vale", play_count: 69, listening_minutes: 430, distinct_tracks: 16 },
      { name: "New Coast Archive", play_count: 62, listening_minutes: 386, distinct_tracks: 9 },
      { name: "Lumen Choir", play_count: 55, listening_minutes: 344, distinct_tracks: 12 },
      { name: "Static Bloom", play_count: 51, listening_minutes: 308, distinct_tracks: 10 },
      { name: "Low Lanterns", play_count: 44, listening_minutes: 271, distinct_tracks: 8 },
      { name: "Ash Meridian", play_count: 38, listening_minutes: 236, distinct_tracks: 9 },
      { name: "Glass Atlas", play_count: 31, listening_minutes: 194, distinct_tracks: 7 },
    ],
    repeat_tracks: [
      { label: "Midnight Lines", artist_credit: "Mara Vale", release: "Night Transit", play_count: 64, listening_minutes: 312 },
      { label: "Glass Highway", artist_credit: "North Window", release: "Pale Signals", play_count: 57, listening_minutes: 286 },
      { label: "Blue Exit", artist_credit: "Ash Meridian", release: "Afterimage", play_count: 49, listening_minutes: 241 },
      { label: "Soft Static", artist_credit: "Static Bloom", release: "Quiet Machinery", play_count: 43, listening_minutes: 218 },
      { label: "First Light Behind Us", artist_credit: "North Window", release: "Pale Signals", play_count: 39, listening_minutes: 201 },
      { label: "Amber Receiver", artist_credit: "Lumen Choir", release: "Open Frequencies", play_count: 36, listening_minutes: 188 },
      { label: "Empty Overpass", artist_credit: "Juniper City", release: "Exit Weather", play_count: 34, listening_minutes: 173 },
      { label: "Weather Memory", artist_credit: "Cinder Lake", release: "Shoreline Code", play_count: 31, listening_minutes: 162 },
      { label: "Parallel Rooms", artist_credit: "Elsewhere Signal", release: "Long Distance", play_count: 29, listening_minutes: 151 },
      { label: "Signal Garden", artist_credit: "Glass Atlas", release: "Unfolding Maps", play_count: 27, listening_minutes: 143 },
    ],
    recent_tracks: [
      { label: "Northern Relay", artist_credit: "Drift Assembly", release: "Moving Weather", play_count: 18, listening_minutes: 96 },
      { label: "Exit Weather", artist_credit: "Juniper City", release: "Exit Weather", play_count: 16, listening_minutes: 88 },
      { label: "Blue Hour Index", artist_credit: "New Coast Archive", release: "Tide Tables", play_count: 15, listening_minutes: 82 },
      { label: "First Light Behind Us", artist_credit: "North Window", release: "Pale Signals", play_count: 14, listening_minutes: 76 },
      { label: "Low Voltage Moon", artist_credit: "Low Lanterns", release: "Street Astronomy", play_count: 13, listening_minutes: 71 },
      { label: "Midnight Lines", artist_credit: "Mara Vale", release: "Night Transit", play_count: 12, listening_minutes: 65 },
      { label: "Amber Receiver", artist_credit: "Lumen Choir", release: "Open Frequencies", play_count: 11, listening_minutes: 61 },
      { label: "Soft Static", artist_credit: "Static Bloom", release: "Quiet Machinery", play_count: 10, listening_minutes: 56 },
      { label: "Unfolding Maps", artist_credit: "Glass Atlas", release: "Unfolding Maps", play_count: 9, listening_minutes: 51 },
      { label: "Blue Exit", artist_credit: "Ash Meridian", release: "Afterimage", play_count: 8, listening_minutes: 45 },
    ],
    rediscovery_tracks: [
      {
        label: "Quiet Coordinates",
        artist_credit: "Sable Arcade",
        release: "Night Survey",
        play_count: 32,
        listening_minutes: 168,
        first_played_at: "2023-11-18T21:14:00.000Z",
        last_played_at: "2025-11-26T19:42:00.000Z",
        quiet_days: 271,
        peak_year: 2024,
        peak_year_play_count: 18,
        peak_year_listening_minutes: 96,
        rediscovery_signal: "saved-library state",
      },
      {
        label: "After the Floodlights",
        artist_credit: "Cinder Lake",
        release: "Shoreline Code",
        play_count: 27,
        listening_minutes: 142,
        first_played_at: "2024-02-09T18:30:00.000Z",
        last_played_at: "2025-12-19T23:11:00.000Z",
        quiet_days: 248,
        peak_year: 2025,
        peak_year_play_count: 15,
        peak_year_listening_minutes: 81,
        rediscovery_signal: "private playlist curation",
      },
      {
        label: "Signal Garden",
        artist_credit: "Glass Atlas",
        release: "Unfolding Maps",
        play_count: 27,
        listening_minutes: 143,
        first_played_at: "2023-10-21T20:08:00.000Z",
        last_played_at: "2026-01-08T14:20:00.000Z",
        quiet_days: 228,
        peak_year: 2024,
        peak_year_play_count: 13,
        peak_year_listening_minutes: 70,
        rediscovery_signal: "historical attention only",
      },
    ],
    historical_return_tracks: [
      {
        label: "Quiet Coordinates",
        artist_credit: "Sable Arcade",
        release: "Night Survey",
        play_count: 32,
        engaged_play_count: 31,
        listening_minutes: 168,
        explicit_skips: 1,
        first_played_at: "2023-11-18T21:14:00.000Z",
        last_played_at: "2025-11-26T19:42:00.000Z",
        return_count: 2,
        longest_gap_days: 421,
        latest_return_at: "2025-11-26T19:42:00.000Z",
        latest_return_gap_days: 316,
        historical_return_signal: "saved-library state",
      },
      {
        label: "Glass Highway",
        artist_credit: "North Window",
        release: "Pale Signals",
        play_count: 57,
        engaged_play_count: 54,
        listening_minutes: 286,
        explicit_skips: 3,
        first_played_at: "2024-01-19T20:10:00.000Z",
        last_played_at: "2026-03-09T22:12:00.000Z",
        return_count: 2,
        longest_gap_days: 318,
        latest_return_at: "2026-03-09T22:12:00.000Z",
        latest_return_gap_days: 318,
        historical_return_signal: "explicit listener preference",
      },
      {
        label: "Midnight Lines",
        artist_credit: "Mara Vale",
        release: "Night Transit",
        play_count: 64,
        engaged_play_count: 61,
        listening_minutes: 312,
        explicit_skips: 3,
        first_played_at: "2023-06-03T21:32:00.000Z",
        last_played_at: "2026-06-04T21:46:00.000Z",
        return_count: 1,
        longest_gap_days: 732,
        latest_return_at: "2026-06-04T21:46:00.000Z",
        latest_return_gap_days: 732,
        historical_return_signal: "saved-library state",
      },
    ],
    back_to_back_tracks: [
      {
        label: "Glass Highway",
        artist_credit: "North Window",
        release: "Pale Signals",
        play_count: 57,
        engaged_play_count: 54,
        explicit_skips: 3,
        burst_count: 4,
        maximum_consecutive_plays: 5,
        plays_in_bursts: 14,
        listening_minutes_in_bursts: 71,
        latest_burst_at: "2026-03-09T22:12:00.000Z",
        sequence_signal: "adjacent retained plays",
      },
      {
        label: "Midnight Lines",
        artist_credit: "Mara Vale",
        release: "Night Transit",
        play_count: 64,
        engaged_play_count: 61,
        explicit_skips: 3,
        burst_count: 3,
        maximum_consecutive_plays: 4,
        plays_in_bursts: 10,
        listening_minutes_in_bursts: 49,
        latest_burst_at: "2026-06-04T21:46:00.000Z",
        sequence_signal: "adjacent retained plays",
      },
      {
        label: "Blue Exit",
        artist_credit: "Ash Meridian",
        release: "Afterimage",
        play_count: 49,
        engaged_play_count: 47,
        explicit_skips: 2,
        burst_count: 2,
        maximum_consecutive_plays: 3,
        plays_in_bursts: 6,
        listening_minutes_in_bursts: 30,
        latest_burst_at: "2026-03-09T22:12:00.000Z",
        sequence_signal: "adjacent retained plays",
      },
    ],
    time_capsule_tracks: [
      {
        label: "Midnight Lines",
        artist_credit: "Mara Vale",
        release: "Night Transit",
        identity_status: "resolved",
        capsule_year: 2023,
        year_play_count: 22,
        year_engaged_play_count: 21,
        year_listening_minutes: 108,
        year_explicit_skips: 1,
        lifetime_play_count: 64,
        lifetime_listening_minutes: 312,
        representative_signal: "saved-library state",
      },
      {
        label: "Glass Highway",
        artist_credit: "North Window",
        release: "Pale Signals",
        identity_status: "resolved",
        capsule_year: 2024,
        year_play_count: 27,
        year_engaged_play_count: 25,
        year_listening_minutes: 135,
        year_explicit_skips: 2,
        lifetime_play_count: 57,
        lifetime_listening_minutes: 286,
        representative_signal: "explicit listener preference",
      },
      {
        label: "Blue Exit",
        artist_credit: "Ash Meridian",
        release: "Afterimage",
        identity_status: "resolved",
        capsule_year: 2025,
        year_play_count: 31,
        year_engaged_play_count: 29,
        year_listening_minutes: 154,
        year_explicit_skips: 2,
        lifetime_play_count: 49,
        lifetime_listening_minutes: 241,
        representative_signal: "private playlist curation",
      },
      {
        label: "Northern Relay",
        artist_credit: "Drift Assembly",
        release: "Moving Weather",
        identity_status: "resolved",
        capsule_year: 2026,
        year_play_count: 18,
        year_engaged_play_count: 18,
        year_listening_minutes: 96,
        year_explicit_skips: 0,
        lifetime_play_count: 18,
        lifetime_listening_minutes: 96,
        representative_signal: "historical attention only",
      },
    ],
    history_arc: [
      { year: 2023, event_count: 2_480, listening_minutes: 8_940, distinct_tracks: 1_120, first_observed_tracks: 1_120, top_artist: { name: "Mara Vale", play_count: 340, listening_minutes: 1_480 } },
      { year: 2024, event_count: 5_210, listening_minutes: 17_820, distinct_tracks: 1_680, first_observed_tracks: 982, top_artist: { name: "North Window", play_count: 480, listening_minutes: 2_160 } },
      { year: 2025, event_count: 6_184, listening_minutes: 21_636, distinct_tracks: 1_940, first_observed_tracks: 743, top_artist: { name: "Mara Vale", play_count: 590, listening_minutes: 2_740 } },
      { year: 2026, event_count: 4_522, listening_minutes: 13_788, distinct_tracks: 1_360, first_observed_tracks: 415, top_artist: { name: "North Window", play_count: 285, listening_minutes: 1_410 } },
    ],
    monthly_activity: createSyntheticMonthlyActivity(),
    listening_seasons: createSyntheticListeningSeasons(),
    artist_relationships: [
      { name: "Mara Vale", first_year: 2023, last_year: 2026, active_years: 4, span_years: 4, play_count: 1_230, listening_minutes: 5_420 },
      { name: "Ash Meridian", first_year: 2023, last_year: 2026, active_years: 4, span_years: 4, play_count: 846, listening_minutes: 3_650 },
      { name: "North Window", first_year: 2024, last_year: 2026, active_years: 3, span_years: 3, play_count: 1_104, listening_minutes: 4_810 },
      { name: "Lumen Choir", first_year: 2024, last_year: 2026, active_years: 3, span_years: 3, play_count: 698, listening_minutes: 2_880 },
    ],
    year_transitions: [
      { from_year: 2023, to_year: 2024, artist_limit: 10, from_artist_count: 10, to_artist_count: 10, retained_artist_count: 6, new_artist_count: 4, continuity_percent: 60, retained_artists: ["Mara Vale", "Ash Meridian", "Static Bloom"], new_artists: ["North Window", "Lumen Choir", "Glass Atlas"] },
      { from_year: 2024, to_year: 2025, artist_limit: 10, from_artist_count: 10, to_artist_count: 10, retained_artist_count: 7, new_artist_count: 3, continuity_percent: 70, retained_artists: ["Mara Vale", "North Window", "Lumen Choir"], new_artists: ["Ash Meridian", "Juniper City", "Elsewhere Signal"] },
      { from_year: 2025, to_year: 2026, artist_limit: 10, from_artist_count: 10, to_artist_count: 10, retained_artist_count: 5, new_artist_count: 5, continuity_percent: 50, retained_artists: ["North Window", "Mara Vale", "Ash Meridian"], new_artists: ["Drift Assembly", "New Coast Archive", "Low Lanterns"] },
    ],
    release_depth: [
      { title: "Night Transit", artist_credit: "Mara Vale", distinct_tracks: 11, play_count: 284, engaged_play_count: 267, listening_minutes: 1_246, first_year: 2023, last_year: 2026, active_years: 4 },
      { title: "Pale Signals", artist_credit: "North Window", distinct_tracks: 10, play_count: 251, engaged_play_count: 238, listening_minutes: 1_104, first_year: 2024, last_year: 2026, active_years: 3 },
      { title: "Afterimage", artist_credit: "Ash Meridian", distinct_tracks: 9, play_count: 198, engaged_play_count: 184, listening_minutes: 862, first_year: 2023, last_year: 2026, active_years: 4 },
      { title: "Open Frequencies", artist_credit: "Lumen Choir", distinct_tracks: 8, play_count: 171, engaged_play_count: 160, listening_minutes: 734, first_year: 2024, last_year: 2026, active_years: 3 },
      { title: "Quiet Machinery", artist_credit: "Static Bloom", distinct_tracks: 7, play_count: 146, engaged_play_count: 133, listening_minutes: 618, first_year: 2023, last_year: 2026, active_years: 4 },
    ],
    session_summary: {
      source: "spotify_extended_history",
      method: "track_stop_gap",
      gap_minutes: 30,
      event_count: 17_980,
      session_count: 2_500,
      median_plays: 5,
      median_listening_minutes: 17,
      single_play_sessions: 600,
      short_sequence_sessions: 850,
      extended_sequence_sessions: 1_050,
      extended_sequence_minimum_plays: 5,
      extended_sequence_percent: 42,
    },
    context: {
      recent_window_days: 90,
      effective_events_profiled: 18_396,
      start_reason_events: 17_980,
      trackdone_starts: 11_920,
      end_reason_events: 17_980,
      skip_state_events: 17_980,
      explicit_skips: 2_860,
      trackdone_endings: 12_104,
      direct_selection_starts: 4_320,
      shuffle_state_events: 17_980,
      shuffle_events: 5_940,
      offline_state_events: 17_980,
      offline_events: 214,
      incognito_events_excluded: 24,
      rediscovery_quiet_days: 90,
      rediscovery_minimum_plays: 3,
      rediscovery_minimum_engaged_plays: 2,
      rediscovery_minimum_listening_minutes: 10,
      historical_return_minimum_gap_days: 180,
      historical_return_minimum_plays: 3,
      historical_return_minimum_engaged_plays: 3,
      historical_return_minimum_listening_minutes: 10,
      back_to_back_minimum_consecutive_plays: 2,
      back_to_back_minimum_played_seconds: 30,
      back_to_back_maximum_gap_minutes: 30,
      monthly_activity_maximum_months: 240,
      listening_season_maximum_seasons: 80,
      time_capsule_minimum_years: 2,
      time_capsule_minimum_engaged_plays: 2,
      time_capsule_minimum_listening_minutes: 5,
      relationship_minimum_years: 2,
      continuity_artist_limit: 10,
      release_minimum_distinct_tracks: 3,
      session_gap_minutes: 30,
      extended_sequence_minimum_plays: 5,
    },
  },
  strong_preferences: [
    { label: "Midnight Lines", signal: "Loved and saved" },
    { label: "Glass Highway", signal: "Favorited" },
    { label: "Mara Vale", signal: "Followed artist" },
    { label: "Night Transit", signal: "Saved album" },
    { label: "First Light Behind Us", signal: "Playlist anchor" },
    { label: "North Window", signal: "Followed artist" },
  ],
  artist_facets: [
    { name: "Mara Vale" },
    { name: "North Window" },
    { name: "Ash Meridian" },
    { name: "Lumen Choir" },
    { name: "Static Bloom" },
    { name: "Juniper City" },
  ],
  genre_facets: [
    { name: "Art Pop" },
    { name: "Ambient Rock" },
    { name: "Electronic" },
    { name: "Dream Pop" },
    { name: "Post-Rock" },
    { name: "Alternative" },
  ],
  curated_preferences: {
    saved_tracks: [
      { label: "Midnight Lines", artist_credit: "Mara Vale", release: "Night Transit", listening_minutes: 312 },
      { label: "Glass Highway", artist_credit: "North Window", release: "Pale Signals", listening_minutes: 286 },
      { label: "Blue Exit", artist_credit: "Ash Meridian", release: "Afterimage", listening_minutes: 241 },
      { label: "Amber Receiver", artist_credit: "Lumen Choir", release: "Open Frequencies", listening_minutes: 188 },
      { label: "Signal Garden", artist_credit: "Glass Atlas", release: "Unfolding Maps", listening_minutes: 143 },
    ],
    playlist_anchors: [
      { label: "First Light Behind Us", artist_credit: "North Window", release: "Pale Signals", playlist_count: 5 },
      { label: "Midnight Lines", artist_credit: "Mara Vale", release: "Night Transit", playlist_count: 4 },
      { label: "Soft Static", artist_credit: "Static Bloom", release: "Quiet Machinery", playlist_count: 4 },
      { label: "Parallel Rooms", artist_credit: "Elsewhere Signal", release: "Long Distance", playlist_count: 3 },
      { label: "Weather Memory", artist_credit: "Cinder Lake", release: "Shoreline Code", playlist_count: 3 },
    ],
    followed_artists: [
      { name: "Mara Vale", listening_minutes: 5_420 },
      { name: "North Window", listening_minutes: 4_810 },
      { name: "Ash Meridian", listening_minutes: 3_650 },
      { name: "Lumen Choir", listening_minutes: 2_880 },
      { name: "Juniper City", listening_minutes: 2_150 },
    ],
    saved_albums: [
      { label: "Night Transit", artist_credit: "Mara Vale" },
      { label: "Pale Signals", artist_credit: "North Window" },
      { label: "Afterimage", artist_credit: "Ash Meridian" },
      { label: "Open Frequencies", artist_credit: "Lumen Choir" },
      { label: "Quiet Machinery", artist_credit: "Static Bloom" },
    ],
  },
  search_intent: [
    { query: "Mara Vale", interactions: 5, result_entity_types: ["artist", "track"] },
    { query: "late night ambient rock", interactions: 4, result_entity_types: ["track", "playlist"] },
    { query: "North Window", interactions: 3, result_entity_types: ["artist", "album"] },
    { query: "post-rock instrumental", interactions: 3, result_entity_types: ["track"] },
    { query: "Quiet Machinery", interactions: 2, result_entity_types: ["album"] },
  ],
  provider_signals: {
    artists: [
      { name: "Mara Vale", best_rank: 1, periods: ["Demo 2025"] },
      { name: "North Window", best_rank: 2, periods: ["Demo 2025"] },
      { name: "Ash Meridian", best_rank: 3, periods: ["Demo 2025"] },
      { name: "Lumen Choir", best_rank: 4, periods: ["Demo 2025"] },
      { name: "Static Bloom", best_rank: 5, periods: ["Demo 2025"] },
    ],
    tracks: [
      { label: "Midnight Lines", artist_credit: "Mara Vale", best_rank: 1, periods: ["Demo 2025"] },
      { label: "Glass Highway", artist_credit: "North Window", best_rank: 2, periods: ["Demo 2025"] },
      { label: "Blue Exit", artist_credit: "Ash Meridian", best_rank: 3, periods: ["Demo 2025"] },
      { label: "Soft Static", artist_credit: "Static Bloom", best_rank: 4, periods: ["Demo 2025"] },
      { label: "Amber Receiver", artist_credit: "Lumen Choir", best_rank: 5, periods: ["Demo 2025"] },
    ],
    genres: [
      { name: "Art Pop", rank: 1, period: "Demo 2025" },
      { name: "Ambient Rock", rank: 2, period: "Demo 2025" },
      { name: "Electronic", rank: 3, period: "Demo 2025" },
    ],
    highlights: [
      { kind: "top_track", label: "Midnight Lines", related_label: "Mara Vale" },
      { kind: "discovery_month", label: "March", related_label: "Drift Assembly" },
      { kind: "return_track", label: "Glass Highway", related_label: "North Window" },
    ],
    metrics: [
      { name: "listening time", value: 62_184, unit: "minutes", period: "Demo lifetime" },
      { name: "effective events", value: 18_420, unit: "events", period: "Demo lifetime" },
      { name: "distinct tracks", value: 3_260, unit: "tracks", period: "Demo lifetime" },
    ],
  },
  listening_source: {
    listening_range: {
      earliest: "2023-09-01T08:00:00.000Z",
      latest: "2026-08-24T22:30:00.000Z",
    },
  },
  limitations: [
    "This page uses fictional demonstration data and does not describe a real listener.",
    "Listening duration and repetition support familiarity and attention, not liking by themselves.",
    "Explicit skip flags are contextual navigation evidence, not permanent dislikes.",
    "Recent and lifetime rankings use different time windows.",
    "Calendar-year listening arcs use UTC boundaries.",
    "A track's first appearance in retained history does not prove that it was newly discovered then.",
    "Rediscovery candidates are listen-again prompts, not preference claims.",
    "Historical returns are long-gap recurrence patterns, not proof of liking, nostalgia, or intentional absence.",
    "Played-back-to-back sequences describe adjacent retained plays, not repeat mode, intention, liking, or preference.",
    "Listening Time Machine tracks are deterministic calendar-year landmarks, not claims that they defined a year or remain preferred now.",
    "Release depth describes multi-track listening, not full-album playback, completion, ownership, or liking.",
    "Approximate sessions use a 30-minute gap between UTC track-stop timestamps and do not establish activity, mood, location, or intent.",
    "Provider-derived rankings remain quoted context rather than user assertions.",
    "Bar lengths are relative only within each displayed list.",
  ],
};

export function createPublicTasteprintDemoProfile() {
  return structuredClone(publicTasteprintDemoProfile);
}
