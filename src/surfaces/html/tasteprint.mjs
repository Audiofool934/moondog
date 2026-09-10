const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/gu;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanText(value, maximum = 240) {
  if (typeof value !== "string") return "";
  return Array.from(
    value
      .replaceAll(CONTROL_CHARACTERS, " ")
      .replaceAll(BIDI_CONTROLS, " ")
      .replaceAll(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, maximum)
    .join("");
}

function optionalNumber(value, { integer = false, minimum = 0 } = {}) {
  if (!Number.isFinite(value) || value < minimum) return null;
  if (integer && !Number.isInteger(value)) return null;
  return value;
}

function list(value, maximum, projector) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).map(projector).filter(Boolean);
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === null || entry === undefined || entry === "") return false;
      if (Array.isArray(entry) && entry.length === 0) return false;
      return true;
    }),
  );
}

function artistSignal(item) {
  if (!isPlainObject(item)) return null;
  const name = cleanText(item.name);
  if (!name) return null;
  return compactObject({
    name,
    play_count: optionalNumber(item.play_count, { integer: true }),
    listening_minutes: optionalNumber(item.listening_minutes),
    distinct_tracks: optionalNumber(item.distinct_tracks, { integer: true }),
    last_played_at: cleanText(item.last_played_at, 40),
  });
}

function historyArcSignal(item) {
  if (!isPlainObject(item)) return null;
  const year = optionalNumber(item.year, { integer: true, minimum: 1900 });
  if (year === null || year > 9999) return null;
  const topArtist = artistSignal(item.top_artist);
  return compactObject({
    year,
    event_count: optionalNumber(item.event_count, { integer: true }),
    listening_minutes: optionalNumber(item.listening_minutes),
    distinct_tracks: optionalNumber(item.distinct_tracks, { integer: true }),
    first_observed_tracks: optionalNumber(item.first_observed_tracks, {
      integer: true,
    }),
    top_artist: topArtist,
  });
}

function tasteprintMonthIndex(monthKey) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(monthKey)) return null;
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
  return year * 12 + month - 1;
}

function monthlyActivityCellSignal(item) {
  if (!isPlainObject(item)) return null;
  const month = cleanText(item.month, 7);
  if (tasteprintMonthIndex(month) === null) return null;
  const eventCount = optionalNumber(item.event_count, { integer: true });
  const engagedPlayCount = optionalNumber(item.engaged_play_count, {
    integer: true,
  });
  const listeningMinutes = optionalNumber(item.listening_minutes);
  const distinctTracks = optionalNumber(item.distinct_tracks, { integer: true });
  if (
    eventCount === null ||
    engagedPlayCount === null ||
    engagedPlayCount > eventCount ||
    listeningMinutes === null ||
    distinctTracks === null
  ) {
    return null;
  }
  return {
    month,
    event_count: eventCount,
    engaged_play_count: engagedPlayCount,
    listening_minutes: listeningMinutes,
    distinct_tracks: distinctTracks,
  };
}

function monthlyActivitySignal(item) {
  if (!isPlainObject(item) || item.timezone !== "UTC") return null;
  const firstMonth = cleanText(item.first_month, 7);
  const lastMonth = cleanText(item.last_month, 7);
  const firstIndex = tasteprintMonthIndex(firstMonth);
  const lastIndex = tasteprintMonthIndex(lastMonth);
  const retainedSpanMonths = optionalNumber(item.retained_span_months, {
    integer: true,
    minimum: 1,
  });
  const representedMonthCount = optionalNumber(item.represented_month_count, {
    integer: true,
    minimum: 1,
  });
  const activeMonthCount = optionalNumber(item.active_month_count, {
    integer: true,
    minimum: 1,
  });
  const omittedEarlierMonthCount = optionalNumber(
    item.omitted_earlier_month_count,
    { integer: true },
  );
  const peakListeningMinutes = optionalNumber(item.peak_listening_minutes);
  const months = list(item.months, 240, monthlyActivityCellSignal).sort(
    (left, right) =>
      left.month < right.month ? -1 : left.month > right.month ? 1 : 0,
  );
  const monthIndexes = months.map((month) => tasteprintMonthIndex(month.month));
  if (
    firstIndex === null ||
    lastIndex === null ||
    firstIndex > lastIndex ||
    retainedSpanMonths === null ||
    representedMonthCount === null ||
    activeMonthCount === null ||
    omittedEarlierMonthCount === null ||
    peakListeningMinutes === null ||
    months.length !== representedMonthCount ||
    months[0]?.month !== firstMonth ||
    months.at(-1)?.month !== lastMonth ||
    retainedSpanMonths !== representedMonthCount + omittedEarlierMonthCount ||
    activeMonthCount !== months.filter((month) => month.event_count > 0).length ||
    peakListeningMinutes !== Math.max(...months.map((month) => month.listening_minutes)) ||
    monthIndexes.some(
      (index, position) =>
        index === null ||
        (position > 0 && index !== monthIndexes[position - 1] + 1),
    )
  ) {
    return null;
  }
  return {
    timezone: "UTC",
    first_month: firstMonth,
    last_month: lastMonth,
    retained_span_months: retainedSpanMonths,
    represented_month_count: representedMonthCount,
    active_month_count: activeMonthCount,
    omitted_earlier_month_count: omittedEarlierMonthCount,
    peak_listening_minutes: peakListeningMinutes,
    months,
  };
}

function tasteprintSeasonIndex(value) {
  if (!/^\d{4}-Q[1-4]$/u.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const quarter = Number(value.slice(6));
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
  return year * 4 + quarter - 1;
}

function listeningSeasonArtistSignal(item) {
  if (!isPlainObject(item)) return null;
  const name = cleanText(item.name);
  const eventCount = optionalNumber(item.event_count, {
    integer: true,
    minimum: 1,
  });
  const engagedPlayCount = optionalNumber(item.engaged_play_count, {
    integer: true,
  });
  const listeningMinutes = optionalNumber(item.listening_minutes);
  const distinctTracks = optionalNumber(item.distinct_tracks, {
    integer: true,
    minimum: 1,
  });
  if (
    !name ||
    eventCount === null ||
    engagedPlayCount === null ||
    engagedPlayCount > eventCount ||
    listeningMinutes === null ||
    distinctTracks === null
  ) {
    return null;
  }
  return {
    name,
    event_count: eventCount,
    engaged_play_count: engagedPlayCount,
    listening_minutes: listeningMinutes,
    distinct_tracks: distinctTracks,
  };
}

function listeningSeasonTrackSignal(item) {
  if (!isPlainObject(item)) return null;
  const label = cleanText(item.label);
  const artistCredit = cleanText(item.artist_credit);
  const playCount = optionalNumber(item.play_count, {
    integer: true,
    minimum: 1,
  });
  const engagedPlayCount = optionalNumber(item.engaged_play_count, {
    integer: true,
  });
  const listeningMinutes = optionalNumber(item.listening_minutes);
  const explicitSkips = optionalNumber(item.explicit_skips, {
    integer: true,
  });
  if (
    !label ||
    !artistCredit ||
    playCount === null ||
    engagedPlayCount === null ||
    engagedPlayCount > playCount ||
    listeningMinutes === null ||
    explicitSkips === null ||
    engagedPlayCount + explicitSkips !== playCount
  ) {
    return null;
  }
  return compactObject({
    label,
    artist_credit: artistCredit,
    release: cleanText(item.release),
    play_count: playCount,
    engaged_play_count: engagedPlayCount,
    listening_minutes: listeningMinutes,
    explicit_skips: explicitSkips,
  });
}

function listeningSeasonSignal(item) {
  if (!isPlainObject(item)) return null;
  const key = cleanText(item.key, 7);
  const index = tasteprintSeasonIndex(key);
  const startMonth = cleanText(item.start_month, 7);
  const endMonth = cleanText(item.end_month, 7);
  const startMonthIndex = tasteprintMonthIndex(startMonth);
  const endMonthIndex = tasteprintMonthIndex(endMonth);
  const retainedMonthCount = optionalNumber(item.retained_month_count, {
    integer: true,
    minimum: 1,
  });
  const activeMonthCount = optionalNumber(item.active_month_count, {
    integer: true,
  });
  const eventCount = optionalNumber(item.event_count, { integer: true });
  const engagedPlayCount = optionalNumber(item.engaged_play_count, {
    integer: true,
  });
  const listeningMinutes = optionalNumber(item.listening_minutes);
  const distinctTracks = optionalNumber(item.distinct_tracks, {
    integer: true,
  });
  const firstObservedTracks = optionalNumber(item.first_observed_tracks, {
    integer: true,
  });
  const returningTracks = optionalNumber(item.returning_tracks, {
    integer: true,
  });
  const leadingArtist = listeningSeasonArtistSignal(item.leading_artist);
  const signatureTrack = listeningSeasonTrackSignal(item.signature_track);
  if (
    index === null ||
    startMonthIndex === null ||
    endMonthIndex === null ||
    startMonthIndex > endMonthIndex ||
    Math.floor(startMonthIndex / 3) !== index ||
    Math.floor(endMonthIndex / 3) !== index ||
    retainedMonthCount === null ||
    retainedMonthCount > 3 ||
    retainedMonthCount !== endMonthIndex - startMonthIndex + 1 ||
    activeMonthCount === null ||
    activeMonthCount > retainedMonthCount ||
    eventCount === null ||
    engagedPlayCount === null ||
    engagedPlayCount > eventCount ||
    listeningMinutes === null ||
    distinctTracks === null ||
    distinctTracks > eventCount ||
    firstObservedTracks === null ||
    returningTracks === null ||
    firstObservedTracks + returningTracks !== distinctTracks ||
    (eventCount === 0 &&
      (activeMonthCount !== 0 ||
        engagedPlayCount !== 0 ||
        listeningMinutes !== 0 ||
        distinctTracks !== 0 ||
        leadingArtist !== null ||
        signatureTrack !== null)) ||
    (eventCount > 0 &&
      (activeMonthCount < 1 ||
        distinctTracks < 1 ||
        leadingArtist === null ||
        signatureTrack === null)) ||
    (leadingArtist &&
      (leadingArtist.event_count > eventCount ||
        leadingArtist.engaged_play_count > engagedPlayCount ||
        leadingArtist.listening_minutes > listeningMinutes ||
        leadingArtist.distinct_tracks > distinctTracks)) ||
    (signatureTrack &&
      (signatureTrack.play_count > eventCount ||
        signatureTrack.engaged_play_count > engagedPlayCount ||
        signatureTrack.listening_minutes > listeningMinutes))
  ) {
    return null;
  }
  return compactObject({
    key,
    start_month: startMonth,
    end_month: endMonth,
    retained_month_count: retainedMonthCount,
    active_month_count: activeMonthCount,
    event_count: eventCount,
    engaged_play_count: engagedPlayCount,
    listening_minutes: listeningMinutes,
    distinct_tracks: distinctTracks,
    first_observed_tracks: firstObservedTracks,
    returning_tracks: returningTracks,
    leading_artist: leadingArtist,
    signature_track: signatureTrack,
  });
}

function listeningSeasonsSignal(item) {
  if (
    !isPlainObject(item) ||
    item.timezone !== "UTC" ||
    item.alignment !== "calendar_quarter" ||
    item.season_length_months !== 3
  ) {
    return null;
  }
  const retainedFirstSeason = cleanText(item.retained_first_season, 7);
  const representedFirstSeason = cleanText(
    item.represented_first_season,
    7,
  );
  const lastSeason = cleanText(item.last_season, 7);
  const retainedFirstIndex = tasteprintSeasonIndex(retainedFirstSeason);
  const representedFirstIndex = tasteprintSeasonIndex(
    representedFirstSeason,
  );
  const lastIndex = tasteprintSeasonIndex(lastSeason);
  const retainedSeasonCount = optionalNumber(item.retained_season_count, {
    integer: true,
    minimum: 1,
  });
  const representedSeasonCount = optionalNumber(
    item.represented_season_count,
    { integer: true, minimum: 1 },
  );
  const activeSeasonCount = optionalNumber(item.active_season_count, {
    integer: true,
    minimum: 1,
  });
  const representedActiveSeasonCount = optionalNumber(
    item.represented_active_season_count,
    { integer: true, minimum: 1 },
  );
  const omittedEarlierSeasonCount = optionalNumber(
    item.omitted_earlier_season_count,
    { integer: true },
  );
  const omittedEarlierActiveSeasonCount = optionalNumber(
    item.omitted_earlier_active_season_count,
    { integer: true },
  );
  const rawSeasons = Array.isArray(item.seasons) ? item.seasons : [];
  const seasons = rawSeasons.map(listeningSeasonSignal).filter(Boolean);
  const indexes = seasons.map((season) => tasteprintSeasonIndex(season.key));
  if (
    retainedFirstIndex === null ||
    representedFirstIndex === null ||
    lastIndex === null ||
    retainedFirstIndex > representedFirstIndex ||
    representedFirstIndex > lastIndex ||
    retainedSeasonCount === null ||
    representedSeasonCount === null ||
    representedSeasonCount > 80 ||
    activeSeasonCount === null ||
    representedActiveSeasonCount === null ||
    omittedEarlierSeasonCount === null ||
    omittedEarlierActiveSeasonCount === null ||
    rawSeasons.length !== seasons.length ||
    seasons.length !== representedSeasonCount ||
    indexes[0] !== representedFirstIndex ||
    indexes.at(-1) !== lastIndex ||
    indexes.some(
      (index, position) =>
        index === null ||
        (position > 0 && index !== indexes[position - 1] + 1),
    ) ||
    retainedSeasonCount !== lastIndex - retainedFirstIndex + 1 ||
    representedSeasonCount !== lastIndex - representedFirstIndex + 1 ||
    omittedEarlierSeasonCount !== representedFirstIndex - retainedFirstIndex ||
    activeSeasonCount !==
      representedActiveSeasonCount + omittedEarlierActiveSeasonCount ||
    representedActiveSeasonCount !==
      seasons.filter((season) => season.event_count > 0).length ||
    activeSeasonCount > retainedSeasonCount ||
    representedActiveSeasonCount > representedSeasonCount ||
    omittedEarlierActiveSeasonCount > omittedEarlierSeasonCount
  ) {
    return null;
  }
  const previewSeasons = seasons.slice(-12);
  const previewActiveSeasonCount = previewSeasons.filter(
    (season) => season.event_count > 0,
  ).length;
  return {
    timezone: "UTC",
    alignment: "calendar_quarter",
    season_length_months: 3,
    retained_first_season: retainedFirstSeason,
    represented_first_season: representedFirstSeason,
    last_season: lastSeason,
    retained_season_count: retainedSeasonCount,
    represented_season_count: representedSeasonCount,
    active_season_count: activeSeasonCount,
    represented_active_season_count: representedActiveSeasonCount,
    omitted_earlier_season_count: omittedEarlierSeasonCount,
    omitted_earlier_active_season_count: omittedEarlierActiveSeasonCount,
    preview_season_count: previewSeasons.length,
    preview_active_season_count: previewActiveSeasonCount,
    preview_omitted_season_count: seasons.length - previewSeasons.length,
    preview_omitted_active_season_count:
      representedActiveSeasonCount - previewActiveSeasonCount,
    seasons: previewSeasons,
  };
}

function artistRelationshipSignal(item) {
  if (!isPlainObject(item)) return null;
  const name = cleanText(item.name);
  const firstYear = optionalNumber(item.first_year, {
    integer: true,
    minimum: 1900,
  });
  const lastYear = optionalNumber(item.last_year, {
    integer: true,
    minimum: 1900,
  });
  if (
    !name ||
    firstYear === null ||
    lastYear === null ||
    firstYear > lastYear ||
    lastYear > 9999
  ) {
    return null;
  }
  return compactObject({
    name,
    first_year: firstYear,
    last_year: lastYear,
    active_years: optionalNumber(item.active_years, {
      integer: true,
      minimum: 2,
    }),
    span_years: optionalNumber(item.span_years, {
      integer: true,
      minimum: 2,
    }),
    play_count: optionalNumber(item.play_count, { integer: true }),
    listening_minutes: optionalNumber(item.listening_minutes),
  });
}

function transitionArtistNames(value) {
  return list(value, 4, (name) => cleanText(name)).filter(Boolean);
}

function yearTransitionSignal(item) {
  if (!isPlainObject(item)) return null;
  const fromYear = optionalNumber(item.from_year, {
    integer: true,
    minimum: 1900,
  });
  const toYear = optionalNumber(item.to_year, {
    integer: true,
    minimum: 1900,
  });
  const continuityPercent = optionalNumber(item.continuity_percent);
  if (
    fromYear === null ||
    toYear === null ||
    fromYear >= toYear ||
    toYear > 9999 ||
    continuityPercent === null ||
    continuityPercent > 100
  ) {
    return null;
  }
  return compactObject({
    from_year: fromYear,
    to_year: toYear,
    artist_limit: optionalNumber(item.artist_limit, {
      integer: true,
      minimum: 1,
    }),
    from_artist_count: optionalNumber(item.from_artist_count, {
      integer: true,
    }),
    to_artist_count: optionalNumber(item.to_artist_count, {
      integer: true,
    }),
    retained_artist_count: optionalNumber(item.retained_artist_count, {
      integer: true,
    }),
    new_artist_count: optionalNumber(item.new_artist_count, {
      integer: true,
    }),
    continuity_percent: continuityPercent,
    retained_artists: transitionArtistNames(item.retained_artists),
    new_artists: transitionArtistNames(item.new_artists),
  });
}

function releaseDepthSignal(item) {
  if (!isPlainObject(item)) return null;
  const title = cleanText(item.title);
  const artistCredit = cleanText(item.artist_credit);
  const firstYear = optionalNumber(item.first_year, {
    integer: true,
    minimum: 1900,
  });
  const lastYear = optionalNumber(item.last_year, {
    integer: true,
    minimum: 1900,
  });
  if (
    !title ||
    !artistCredit ||
    (firstYear !== null && firstYear > 9999) ||
    (lastYear !== null && lastYear > 9999) ||
    (firstYear !== null && lastYear !== null && firstYear > lastYear)
  ) {
    return null;
  }
  return compactObject({
    title,
    artist_credit: artistCredit,
    distinct_tracks: optionalNumber(item.distinct_tracks, {
      integer: true,
      minimum: 1,
    }),
    play_count: optionalNumber(item.play_count, { integer: true }),
    engaged_play_count: optionalNumber(item.engaged_play_count, {
      integer: true,
    }),
    listening_minutes: optionalNumber(item.listening_minutes),
    first_year: firstYear,
    last_year: lastYear,
    active_years: optionalNumber(item.active_years, {
      integer: true,
      minimum: 1,
    }),
  });
}

function sessionSummarySignal(item) {
  if (!isPlainObject(item)) return null;
  const source = cleanText(item.source, 60);
  const method = cleanText(item.method, 60);
  const sessionCount = optionalNumber(item.session_count, {
    integer: true,
    minimum: 1,
  });
  const gapMinutes = optionalNumber(item.gap_minutes, {
    integer: true,
    minimum: 1,
  });
  const extendedPercent = optionalNumber(item.extended_sequence_percent);
  if (
    source !== "spotify_extended_history" ||
    method !== "track_stop_gap" ||
    sessionCount === null ||
    gapMinutes === null ||
    extendedPercent === null ||
    extendedPercent > 100
  ) {
    return null;
  }
  return compactObject({
    source,
    method,
    gap_minutes: gapMinutes,
    event_count: optionalNumber(item.event_count, { integer: true }),
    session_count: sessionCount,
    median_plays: optionalNumber(item.median_plays),
    median_listening_minutes: optionalNumber(item.median_listening_minutes),
    single_play_sessions: optionalNumber(item.single_play_sessions, {
      integer: true,
    }),
    short_sequence_sessions: optionalNumber(item.short_sequence_sessions, {
      integer: true,
    }),
    extended_sequence_sessions: optionalNumber(
      item.extended_sequence_sessions,
      { integer: true },
    ),
    extended_sequence_minimum_plays: optionalNumber(
      item.extended_sequence_minimum_plays,
      { integer: true, minimum: 2 },
    ),
    extended_sequence_percent: extendedPercent,
  });
}

function trackSignal(item) {
  if (!isPlainObject(item)) return null;
  const label = cleanText(item.label);
  if (!label) return null;
  return compactObject({
    label,
    artist_credit: cleanText(item.artist_credit),
    release: cleanText(item.release),
    play_count: optionalNumber(item.play_count, { integer: true }),
    listening_minutes: optionalNumber(item.listening_minutes),
    playlist_count: optionalNumber(item.playlist_count, { integer: true }),
    quiet_days: optionalNumber(item.quiet_days, { integer: true }),
    peak_year: optionalNumber(item.peak_year, {
      integer: true,
      minimum: 1900,
    }),
    peak_year_play_count: optionalNumber(item.peak_year_play_count, {
      integer: true,
    }),
    peak_year_listening_minutes: optionalNumber(
      item.peak_year_listening_minutes,
    ),
    rediscovery_signal: cleanText(item.rediscovery_signal, 128),
    return_count: optionalNumber(item.return_count, {
      integer: true,
      minimum: 1,
    }),
    longest_gap_days: optionalNumber(item.longest_gap_days, {
      integer: true,
      minimum: 1,
    }),
    latest_return_at: dateValue(item.latest_return_at),
    latest_return_gap_days: optionalNumber(item.latest_return_gap_days, {
      integer: true,
      minimum: 1,
    }),
    historical_return_signal: cleanText(
      item.historical_return_signal,
      128,
    ),
    capsule_year: optionalNumber(item.capsule_year, {
      integer: true,
      minimum: 1900,
    }),
    year_play_count: optionalNumber(item.year_play_count, { integer: true }),
    year_engaged_play_count: optionalNumber(item.year_engaged_play_count, {
      integer: true,
    }),
    year_listening_minutes: optionalNumber(item.year_listening_minutes),
    year_explicit_skips: optionalNumber(item.year_explicit_skips, {
      integer: true,
    }),
    lifetime_play_count: optionalNumber(item.lifetime_play_count, {
      integer: true,
    }),
    lifetime_listening_minutes: optionalNumber(
      item.lifetime_listening_minutes,
    ),
    representative_signal: cleanText(item.representative_signal, 128),
    burst_count: optionalNumber(item.burst_count, {
      integer: true,
      minimum: 1,
    }),
    maximum_consecutive_plays: optionalNumber(
      item.maximum_consecutive_plays,
      { integer: true, minimum: 2 },
    ),
    plays_in_bursts: optionalNumber(item.plays_in_bursts, {
      integer: true,
      minimum: 2,
    }),
    listening_minutes_in_bursts: optionalNumber(
      item.listening_minutes_in_bursts,
    ),
    latest_burst_at: dateValue(item.latest_burst_at),
    sequence_signal: cleanText(item.sequence_signal, 128),
    first_played_at: dateValue(item.first_played_at),
    last_played_at: cleanText(item.last_played_at, 40),
  });
}

function listenerAssertion(item) {
  if (!isPlainObject(item)) return null;
  const entityType = cleanText(item.entity_type, 40);
  const stance = cleanText(item.stance, 20);
  const label = cleanText(item.label);
  if (
    !new Set(["artist", "track"]).has(entityType) ||
    !new Set(["like", "avoid"]).has(stance) ||
    !label
  ) {
    return null;
  }
  return compactObject({
    entity_type: entityType,
    stance,
    label,
    artist_credit: cleanText(item.artist_credit),
    asserted_at: dateValue(item.asserted_at),
    note: cleanText(item.note, 500),
  });
}

function providerArtist(item) {
  const result = artistSignal(item);
  if (!result) return null;
  return compactObject({
    ...result,
    best_rank: optionalNumber(item.best_rank, { integer: true, minimum: 1 }),
    periods: list(item.periods, 6, (period) => cleanText(period, 80)).filter(Boolean),
  });
}

function providerTrack(item) {
  const result = trackSignal(item);
  if (!result) return null;
  return compactObject({
    ...result,
    best_rank: optionalNumber(item.best_rank, { integer: true, minimum: 1 }),
    periods: list(item.periods, 6, (period) => cleanText(period, 80)).filter(Boolean),
  });
}

function dateValue(value) {
  const cleaned = cleanText(value, 40);
  return cleaned && !Number.isNaN(Date.parse(cleaned)) ? cleaned : null;
}

function durationDays(earliest, latest) {
  if (!earliest || !latest) return null;
  const delta = Date.parse(latest) - Date.parse(earliest);
  if (!Number.isFinite(delta) || delta < 0) return null;
  return Math.max(1, Math.floor(delta / 86_400_000) + 1);
}

function metric(item) {
  if (!isPlainObject(item)) return null;
  const name = cleanText(item.name);
  if (!name) return null;
  return compactObject({
    name,
    value: optionalNumber(item.value),
    unit: cleanText(item.unit, 60),
    stream_count: optionalNumber(item.stream_count, { integer: true }),
    played_seconds: optionalNumber(item.played_seconds, { integer: true }),
    period: cleanText(item.period, 80),
  });
}

function highlight(item) {
  if (!isPlainObject(item)) return null;
  const label = cleanText(item.label);
  if (!label) return null;
  return compactObject({
    kind: cleanText(item.kind, 100),
    label,
    related_label: cleanText(item.related_label),
    metric_name: cleanText(item.metric_name, 100),
    metric_value:
      typeof item.metric_value === "number"
        ? optionalNumber(item.metric_value)
        : cleanText(item.metric_value, 100),
    observed_at: dateValue(item.observed_at),
  });
}

function uniqueNames(values, maximum = 16) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(values) ? values : []) {
    const name = cleanText(item?.name);
    const key = name.normalize("NFKC").toLocaleLowerCase("und");
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length === maximum) break;
  }
  return result;
}

export function createTasteprintView(
  profile,
  {
    generatedAt = new Date().toISOString(),
    syntheticDemo = false,
  } = {},
) {
  if (!isPlainObject(profile)) {
    throw new TypeError("A bounded profile projection is required.");
  }
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) {
    throw new TypeError("Tasteprint generatedAt must be an ISO timestamp.");
  }
  if (typeof syntheticDemo !== "boolean") {
    throw new TypeError("Tasteprint syntheticDemo must be a boolean.");
  }
  const coverage = isPlainObject(profile.coverage) ? profile.coverage : {};
  const behavior = isPlainObject(profile.listening_behavior)
    ? profile.listening_behavior
    : {};
  const context = isPlainObject(behavior.context) ? behavior.context : {};
  const curated = isPlainObject(profile.curated_preferences)
    ? profile.curated_preferences
    : {};
  const provider = isPlainObject(profile.provider_signals)
    ? profile.provider_signals
    : {};
  const listener = isPlainObject(profile.listener_assertions)
    ? profile.listener_assertions
    : {};
  const source = isPlainObject(profile.listening_source)
    ? profile.listening_source
    : {};
  const listeningRange = isPlainObject(source.listening_range)
    ? source.listening_range
    : {};
  const earliest = dateValue(listeningRange.earliest);
  const latest = dateValue(listeningRange.latest);
  const enduringArtists = list(behavior.enduring_artists, 10, artistSignal);
  const recentArtists = list(behavior.recent_artists, 10, artistSignal);
  const longArcRanks = new Map(
    enduringArtists.map((artist, index) => [
      artist.name.normalize("NFKC").toLocaleLowerCase("und"),
      index + 1,
    ]),
  );

  return {
    tasteprint_version: "moondog-tasteprint/1",
    generated_at: new Date(generatedAt).toISOString(),
    synthetic_demo: syntheticDemo,
    privacy: {
      classification: syntheticDemo
        ? "public_synthetic_demo"
        : "private_local_tasteprint",
      contains_personal_music_context: !syntheticDemo,
      network_requests: "none",
    },
    profile_version: cleanText(profile.profile_version, 80) || "unknown",
    coverage: compactObject({
      effective_listening_events: optionalNumber(
        coverage.effective_listening_events,
        { integer: true },
      ),
      profiled_listening_events: optionalNumber(
        coverage.profiled_listening_events,
        { integer: true },
      ),
      listening_hours: optionalNumber(coverage.listening_hours),
      listening_tracks: optionalNumber(coverage.listening_tracks, {
        integer: true,
      }),
      resolved_listening_tracks: optionalNumber(
        coverage.resolved_listening_tracks,
        { integer: true },
      ),
      cross_format_track_links: optionalNumber(
        coverage.cross_format_track_links,
        { integer: true },
      ),
      cross_format_linked_events: optionalNumber(
        coverage.cross_format_linked_events,
        { integer: true },
      ),
      cross_format_ambiguous_tracks: optionalNumber(
        coverage.cross_format_ambiguous_tracks,
        { integer: true },
      ),
      cross_format_ambiguous_events: optionalNumber(
        coverage.cross_format_ambiguous_events,
        { integer: true },
      ),
      spotify_saved_tracks: optionalNumber(coverage.spotify_saved_tracks, {
        integer: true,
      }),
      spotify_saved_albums: optionalNumber(coverage.spotify_saved_albums, {
        integer: true,
      }),
      spotify_followed_artists: optionalNumber(
        coverage.spotify_followed_artists,
        { integer: true },
      ),
      spotify_playlist_memberships: optionalNumber(
        coverage.spotify_playlist_memberships,
        { integer: true },
      ),
      verified_search_interactions: optionalNumber(
        coverage.verified_search_interactions,
        { integer: true },
      ),
      library_tracks_observed: optionalNumber(coverage.tracks_observed, {
        integer: true,
      }),
      library_loved_or_favorited: optionalNumber(
        coverage.loved_or_favorited,
        { integer: true },
      ),
      listener_assertion_events: optionalNumber(
        coverage.listener_assertion_events,
        { integer: true },
      ),
      active_listener_assertions: optionalNumber(
        coverage.active_listener_assertions,
        { integer: true },
      ),
      listener_retractions: optionalNumber(coverage.listener_retractions, {
        integer: true,
      }),
    }),
    timeline: compactObject({
      earliest,
      latest,
      days: durationDays(earliest, latest),
    }),
    behavior: {
      enduring_artists: enduringArtists,
      recent_artists: recentArtists.map((artist) => ({
        ...artist,
        long_arc_rank:
          longArcRanks.get(
            artist.name.normalize("NFKC").toLocaleLowerCase("und"),
          ) ?? null,
      })),
      repeat_tracks: list(behavior.repeat_tracks, 10, trackSignal),
      recent_tracks: list(behavior.recent_tracks, 10, trackSignal),
      rediscovery_tracks: list(
        behavior.rediscovery_tracks,
        10,
        trackSignal,
      ),
      historical_return_tracks: list(
        behavior.historical_return_tracks,
        10,
        trackSignal,
      ),
      time_capsule_tracks: list(
        behavior.time_capsule_tracks,
        12,
        trackSignal,
      ).sort((left, right) => left.capsule_year - right.capsule_year),
      back_to_back_tracks: list(
        behavior.back_to_back_tracks,
        10,
        trackSignal,
      ),
      history_arc: list(behavior.history_arc, 20, historyArcSignal).sort(
        (left, right) => left.year - right.year,
      ),
      monthly_activity: monthlyActivitySignal(behavior.monthly_activity),
      listening_seasons: listeningSeasonsSignal(behavior.listening_seasons),
      artist_relationships: list(
        behavior.artist_relationships,
        10,
        artistRelationshipSignal,
      ),
      year_transitions: list(
        behavior.year_transitions,
        12,
        yearTransitionSignal,
      ).sort((left, right) => left.from_year - right.from_year),
      release_depth: list(
        behavior.release_depth,
        10,
        releaseDepthSignal,
      ),
      session_summary: sessionSummarySignal(behavior.session_summary),
      context: compactObject({
        recent_window_days: optionalNumber(context.recent_window_days, {
          integer: true,
          minimum: 1,
        }),
        effective_events_profiled: optionalNumber(
          context.effective_events_profiled,
          { integer: true },
        ),
        start_reason_events: optionalNumber(context.start_reason_events, {
          integer: true,
        }),
        trackdone_starts: optionalNumber(context.trackdone_starts, {
          integer: true,
        }),
        end_reason_events: optionalNumber(context.end_reason_events, {
          integer: true,
        }),
        skip_state_events: optionalNumber(context.skip_state_events, {
          integer: true,
        }),
        explicit_skips: optionalNumber(context.explicit_skips, {
          integer: true,
        }),
        trackdone_endings: optionalNumber(context.trackdone_endings, {
          integer: true,
        }),
        direct_selection_starts: optionalNumber(
          context.direct_selection_starts,
          { integer: true },
        ),
        shuffle_events: optionalNumber(context.shuffle_events, {
          integer: true,
        }),
        shuffle_state_events: optionalNumber(context.shuffle_state_events, {
          integer: true,
        }),
        offline_events: optionalNumber(context.offline_events, {
          integer: true,
        }),
        offline_state_events: optionalNumber(context.offline_state_events, {
          integer: true,
        }),
        incognito_events_excluded: optionalNumber(
          context.incognito_events_excluded,
          { integer: true },
        ),
        rediscovery_quiet_days: optionalNumber(
          context.rediscovery_quiet_days,
          { integer: true, minimum: 1 },
        ),
        rediscovery_minimum_plays: optionalNumber(
          context.rediscovery_minimum_plays,
          { integer: true, minimum: 1 },
        ),
        rediscovery_minimum_engaged_plays: optionalNumber(
          context.rediscovery_minimum_engaged_plays,
          { integer: true, minimum: 1 },
        ),
        rediscovery_minimum_listening_minutes: optionalNumber(
          context.rediscovery_minimum_listening_minutes,
          { integer: true, minimum: 1 },
        ),
        historical_return_minimum_gap_days: optionalNumber(
          context.historical_return_minimum_gap_days,
          { integer: true, minimum: 1 },
        ),
        historical_return_minimum_plays: optionalNumber(
          context.historical_return_minimum_plays,
          { integer: true, minimum: 1 },
        ),
        historical_return_minimum_engaged_plays: optionalNumber(
          context.historical_return_minimum_engaged_plays,
          { integer: true, minimum: 1 },
        ),
        historical_return_minimum_listening_minutes: optionalNumber(
          context.historical_return_minimum_listening_minutes,
          { integer: true, minimum: 1 },
        ),
        time_capsule_minimum_years: optionalNumber(
          context.time_capsule_minimum_years,
          { integer: true, minimum: 2 },
        ),
        time_capsule_minimum_engaged_plays: optionalNumber(
          context.time_capsule_minimum_engaged_plays,
          { integer: true, minimum: 1 },
        ),
        time_capsule_minimum_listening_minutes: optionalNumber(
          context.time_capsule_minimum_listening_minutes,
          { integer: true, minimum: 1 },
        ),
        relationship_minimum_years: optionalNumber(
          context.relationship_minimum_years,
          { integer: true, minimum: 2 },
        ),
        continuity_artist_limit: optionalNumber(
          context.continuity_artist_limit,
          { integer: true, minimum: 1 },
        ),
        release_minimum_distinct_tracks: optionalNumber(
          context.release_minimum_distinct_tracks,
          { integer: true, minimum: 1 },
        ),
        session_gap_minutes: optionalNumber(context.session_gap_minutes, {
          integer: true,
          minimum: 1,
        }),
        extended_sequence_minimum_plays: optionalNumber(
          context.extended_sequence_minimum_plays,
          { integer: true, minimum: 2 },
        ),
        back_to_back_minimum_consecutive_plays: optionalNumber(
          context.back_to_back_minimum_consecutive_plays,
          { integer: true, minimum: 2 },
        ),
        back_to_back_minimum_played_seconds: optionalNumber(
          context.back_to_back_minimum_played_seconds,
          { integer: true, minimum: 1 },
        ),
        back_to_back_maximum_gap_minutes: optionalNumber(
          context.back_to_back_maximum_gap_minutes,
          { integer: true, minimum: 1 },
        ),
      }),
    },
    deliberate: {
      listener_preferences: list(
        listener.preferences,
        10,
        listenerAssertion,
      ),
      listener_avoids: list(listener.avoids, 10, listenerAssertion),
      strong_preferences: list(profile.strong_preferences, 10, (item) => {
        if (!isPlainObject(item)) return null;
        const label = cleanText(item.label);
        return label
          ? compactObject({ label, signal: cleanText(item.signal) })
          : null;
      }),
      saved_tracks: list(curated.saved_tracks, 10, trackSignal),
      playlist_anchors: list(curated.playlist_anchors, 10, trackSignal),
      followed_artists: list(curated.followed_artists, 10, artistSignal),
      saved_albums: list(curated.saved_albums, 10, trackSignal),
    },
    facets: {
      artists: uniqueNames(profile.artist_facets),
      genres: uniqueNames(profile.genre_facets),
    },
    search_intent: list(profile.search_intent, 10, (item) => {
      if (!isPlainObject(item)) return null;
      const query = cleanText(item.query);
      if (!query) return null;
      return compactObject({
        query,
        interactions: optionalNumber(item.interactions, { integer: true }),
        result_entity_types: list(item.result_entity_types, 6, (entry) =>
          cleanText(entry, 60),
        ).filter(Boolean),
        last_searched_at: dateValue(item.last_searched_at),
      });
    }),
    provider_snapshot: {
      artists: list(provider.artists, 10, providerArtist),
      tracks: list(provider.tracks, 10, providerTrack),
      genres: list(provider.genres, 10, (item) => {
        if (!isPlainObject(item)) return null;
        const name = cleanText(item.name);
        return name
          ? compactObject({
              name,
              rank: optionalNumber(item.rank, { integer: true, minimum: 1 }),
              period: cleanText(item.period, 80),
            })
          : null;
      }),
      highlights: list(provider.highlights, 6, highlight),
      metrics: list(provider.metrics, 10, metric),
    },
    limitations: list(profile.limitations, 8, (item) => cleanText(item, 500)).filter(
      Boolean,
    ),
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function number(value, maximumFractionDigits = 0) {
  if (!Number.isFinite(value)) return "Unknown";
  return value.toLocaleString("en-US", { maximumFractionDigits });
}

function listeningTime(minutesValue) {
  if (!Number.isFinite(minutesValue)) return null;
  if (minutesValue < 120) return `${number(Math.round(minutesValue))} min`;
  return `${number(minutesValue / 60, 1)} h`;
}

function dateLabel(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function spanLabel(days) {
  if (!Number.isFinite(days)) return "Your listening life";
  if (days >= 730) return `${number(days / 365.25, 1)} years of listening`;
  if (days >= 60) return `${number(days / 30.44, 1)} months of listening`;
  return `${number(days)} days of listening`;
}

function percentage(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((value / total) * 1000) / 10;
}

function metricCard(value, label, note = "") {
  return `<article class="metric-card">
    <strong>${escapeHtml(value)}</strong>
    <span>${escapeHtml(label)}</span>
    ${note ? `<small>${escapeHtml(note)}</small>` : ""}
  </article>`;
}

function artistRows(items, { recent = false } = {}) {
  if (items.length === 0) return '<p class="empty">No bounded artist signal is available.</p>';
  const maximum = Math.max(
    1,
    ...items.map((item) => item.listening_minutes ?? item.play_count ?? 0),
  );
  return `<ol class="rank-list">
    ${items
      .map((item, index) => {
        const signal = item.listening_minutes ?? item.play_count ?? 0;
        const width = Math.max(4, Math.round((signal / maximum) * 1000) / 10);
        const details = [
          Number.isFinite(item.listening_minutes)
            ? listeningTime(item.listening_minutes)
            : null,
          Number.isInteger(item.play_count) ? `${number(item.play_count)} events` : null,
          Number.isInteger(item.distinct_tracks)
            ? `${number(item.distinct_tracks)} tracks`
            : null,
        ].filter(Boolean);
        const orbit = recent
          ? Number.isInteger(item.long_arc_rank)
            ? `also long arc #${item.long_arc_rank}`
            : "recent-only top signal"
          : "";
        return `<li>
          <div class="rank-number">${String(index + 1).padStart(2, "0")}</div>
          <div class="rank-content">
            <div class="rank-heading"><strong>${escapeHtml(item.name)}</strong>${orbit ? `<span>${escapeHtml(orbit)}</span>` : ""}</div>
            <div class="bar" aria-hidden="true"><i style="width:${width}%"></i></div>
            <small>${escapeHtml(details.join(" / "))}</small>
          </div>
        </li>`;
      })
      .join("")}
  </ol>`;
}

function historyArcRows(items) {
  if (items.length === 0) {
    return '<p class="empty">No bounded calendar-year history is available.</p>';
  }
  const maximum = Math.max(
    1,
    ...items.map((item) => item.listening_minutes ?? item.event_count ?? 0),
  );
  return `<ol class="history-arc">
    ${items
      .map((item) => {
        const signal = item.listening_minutes ?? item.event_count ?? 0;
        const width = Math.max(3, Math.round((signal / maximum) * 1000) / 10);
        const details = [
          Number.isInteger(item.event_count)
            ? `${number(item.event_count)} events`
            : null,
          Number.isInteger(item.distinct_tracks)
            ? `${number(item.distinct_tracks)} tracks`
            : null,
          Number.isInteger(item.first_observed_tracks)
            ? `${number(item.first_observed_tracks)} first observed`
            : null,
        ].filter(Boolean);
        const topArtistTime = listeningTime(item.top_artist?.listening_minutes);
        const topArtistDetails = [
          topArtistTime,
          Number.isInteger(item.top_artist?.play_count)
            ? `${number(item.top_artist.play_count)} events`
            : null,
        ].filter(Boolean);
        return `<li>
          <div class="arc-year"><strong>${escapeHtml(item.year)}</strong><span>UTC year</span></div>
          <div class="arc-body">
            <div class="arc-heading"><strong>${escapeHtml(listeningTime(item.listening_minutes) ?? "Unknown time")}</strong><span>eligible listening</span></div>
            <div class="bar" aria-hidden="true"><i style="width:${width}%"></i></div>
            ${details.length > 0 ? `<small>${escapeHtml(details.join(" / "))}</small>` : ""}
          </div>
          <div class="arc-artist"><span>Most heard artist</span><strong>${escapeHtml(item.top_artist?.name ?? "Unknown artist")}</strong>${topArtistDetails.length > 0 ? `<small>${escapeHtml(topArtistDetails.join(" / "))}</small>` : ""}</div>
        </li>`;
      })
      .join("")}
  </ol>`;
}

function trackRows(items) {
  if (items.length === 0) return '<p class="empty">No bounded track signal is available.</p>';
  return `<ol class="track-list">
    ${items
      .map((item, index) => {
        const details = [
          Number.isInteger(item.play_count) ? `${number(item.play_count)} events` : null,
          listeningTime(item.listening_minutes),
          Number.isInteger(item.playlist_count)
            ? `${number(item.playlist_count)} playlists`
            : null,
          Number.isInteger(item.quiet_days)
            ? `${number(item.quiet_days)} days quiet`
            : null,
          Number.isInteger(item.peak_year)
            ? `strongest year ${item.peak_year}`
            : null,
          item.rediscovery_signal
            ? `basis: ${item.rediscovery_signal}`
            : null,
          Number.isInteger(item.return_count)
            ? `${number(item.return_count)} observed ${item.return_count === 1 ? "return" : "returns"}`
            : null,
          Number.isInteger(item.longest_gap_days)
            ? `longest gap ${number(item.longest_gap_days)} days`
            : null,
          Number.isInteger(item.latest_return_gap_days)
            ? `latest return after ${number(item.latest_return_gap_days)} days`
            : null,
          item.historical_return_signal
            ? `basis: ${item.historical_return_signal}`
            : null,
          Number.isInteger(item.capsule_year)
            ? `${item.capsule_year} landmark`
            : null,
          Number.isInteger(item.year_play_count)
            ? `${number(item.year_play_count)} events that year`
            : null,
          Number.isFinite(item.year_listening_minutes)
            ? `${listeningTime(item.year_listening_minutes)} that year`
            : null,
          item.representative_signal
            ? `basis: ${item.representative_signal}`
            : null,
          Number.isInteger(item.maximum_consecutive_plays)
            ? `${number(item.maximum_consecutive_plays)} plays in the longest adjacent sequence`
            : null,
          Number.isInteger(item.burst_count)
            ? `${number(item.burst_count)} bounded ${item.burst_count === 1 ? "sequence" : "sequences"}`
            : null,
          Number.isInteger(item.plays_in_bursts)
            ? `${number(item.plays_in_bursts)} plays across sequences`
            : null,
          Number.isFinite(item.listening_minutes_in_bursts)
            ? `${listeningTime(item.listening_minutes_in_bursts)} across sequences`
            : null,
          item.sequence_signal ? `basis: ${item.sequence_signal}` : null,
        ].filter(Boolean);
        return `<li>
          <span class="track-index">${String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>${escapeHtml(item.label)}</strong>
            <p>${escapeHtml([item.artist_credit, item.release].filter(Boolean).join(" / "))}</p>
            ${details.length > 0 ? `<small>${escapeHtml(details.join(" / "))}</small>` : ""}
          </div>
        </li>`;
      })
      .join("")}
  </ol>`;
}

function tagCloud(items) {
  if (items.length === 0) return '<p class="empty">No bounded facets are available.</p>';
  return `<ul class="tags">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function signalList(items) {
  if (items.length === 0) return '<p class="empty">No bounded deliberate signal is available.</p>';
  return `<ul class="signal-list">${items
    .map(
      (item) => `<li><strong>${escapeHtml(item.label)}</strong>${
        item.signal ? `<span>${escapeHtml(item.signal)}</span>` : ""
      }</li>`,
    )
    .join("")}</ul>`;
}

function correctionSignalList(items, stance) {
  if (items.length === 0) {
    return `<p class="empty">No explicit ${escapeHtml(stance)} correction is active.</p>`;
  }
  return signalList(
    items.map((item) => {
      const target = [item.label, item.artist_credit].filter(Boolean).join(" / ");
      const details = [
        item.entity_type,
        item.asserted_at ? `asserted ${dateLabel(item.asserted_at)}` : null,
        item.note,
      ].filter(Boolean);
      return { label: target, signal: details.join(" / ") };
    }),
  );
}

function nameRows(items) {
  if (items.length === 0) return '<p class="empty">No bounded artist signal is available.</p>';
  return `<ul class="compact-list">${items
    .map((item) => {
      const detail = listeningTime(item.listening_minutes);
      return `<li><strong>${escapeHtml(item.name)}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</li>`;
    })
    .join("")}</ul>`;
}

function searchRows(items) {
  if (items.length === 0) return '<p class="empty">No verified music-result interaction is available.</p>';
  return `<ul class="compact-list">${items
    .map((item) => {
      const details = [
        Number.isInteger(item.interactions)
          ? `${number(item.interactions)} interactions`
          : null,
        Array.isArray(item.result_entity_types)
          ? item.result_entity_types.join(", ")
          : null,
      ].filter(Boolean);
      return `<li><strong>${escapeHtml(item.query)}</strong>${details.length > 0 ? `<span>${escapeHtml(details.join(" / "))}</span>` : ""}</li>`;
    })
    .join("")}</ul>`;
}

function behaviorCard(value, total, label, boundary, coverageLabel) {
  const share =
    Number.isFinite(value) && Number.isFinite(total) && value <= total
      ? percentage(value, total)
      : null;
  return `<article class="behavior-card">
    <div><strong>${escapeHtml(number(value))}</strong>${share === null ? "" : `<span>${escapeHtml(number(share, 1))}%</span>`}</div>
    <h3>${escapeHtml(label)}</h3>
    <p>${escapeHtml(boundary)}</p>
    ${Number.isFinite(total) && coverageLabel ? `<small>${escapeHtml(`${number(total)} ${coverageLabel}`)}</small>` : ""}
  </article>`;
}

function providerRows(items, type) {
  if (items.length === 0) return '<p class="empty">No bounded provider ranking is available.</p>';
  return `<ol class="provider-list">${items
    .map((item, index) => {
      const label = type === "artist" ? item.name : item.label;
      const detail = type === "artist" ? "" : item.artist_credit;
      const rank = Number.isInteger(item.best_rank) ? `best rank #${item.best_rank}` : "ranked signal";
      const periods = Array.isArray(item.periods) && item.periods.length > 0
        ? item.periods.join(", ")
        : "exported snapshot";
      return `<li><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(label)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ""}<small>${escapeHtml(`${rank} / ${periods}`)}</small></div></li>`;
    })
    .join("")}</ol>`;
}

function snapshotCards(view) {
  const highlights = view.provider_snapshot.highlights.map((item) => {
    const detail = [item.kind, item.related_label].filter(Boolean).join(" / ");
    return `<article><span>Provider highlight</span><strong>${escapeHtml(item.label)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ""}</article>`;
  });
  const metrics = view.provider_snapshot.metrics.map((item) => {
    const value = Number.isFinite(item.value)
      ? `${number(item.value, 1)}${item.unit ? ` ${item.unit}` : ""}`
      : Number.isInteger(item.stream_count)
        ? `${number(item.stream_count)} streams`
        : Number.isInteger(item.played_seconds)
          ? listeningTime(item.played_seconds / 60)
          : "Recorded metric";
    return `<article><span>${escapeHtml(item.period || "Provider metric")}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(item.name)}</p></article>`;
  });
  const cards = [...highlights, ...metrics].slice(0, 8);
  return cards.length > 0
    ? `<div class="snapshot-cards">${cards.join("")}</div>`
    : "";
}

function naturalList(items) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function timeMachineSelectionNote(view) {
  const retainedYears = [
    ...new Set(
      view.behavior.history_arc
        .map((item) => item.year)
        .filter(Number.isInteger),
    ),
  ].sort((left, right) => left - right);
  const selectedYears = new Set(
    view.behavior.time_capsule_tracks.map((item) => item.capsule_year),
  );
  if (retainedYears.length === 0 || selectedYears.size === 0) return "";

  const representedYears = retainedYears.filter((year) =>
    selectedYears.has(year),
  );
  const unrepresentedYears = retainedYears.filter(
    (year) => !selectedYears.has(year),
  );
  const retainedNoun = retainedYears.length === 1 ? "year" : "years";
  const landmarkPhrase = representedYears.length === 1
    ? "has a landmark"
    : "have landmarks";
  const coverageCopy = `${number(representedYears.length)} of ${number(retainedYears.length)} retained ${retainedNoun} ${landmarkPhrase}.`;
  const unrepresentedCopy = unrepresentedYears.length === 0
    ? "Every retained year is represented."
    : unrepresentedYears.length === 1
      ? `${unrepresentedYears[0]} stays visible in the listening arc but has no selected landmark.`
      : `${naturalList(unrepresentedYears.map(String))} stay visible in the listening arc but have no selected landmarks.`;
  const minimumEngagedPlays =
    view.behavior.context.time_capsule_minimum_engaged_plays;
  const minimumListeningMinutes =
    view.behavior.context.time_capsule_minimum_listening_minutes;
  const thresholdCopy = Number.isFinite(minimumEngagedPlays) &&
    Number.isFinite(minimumListeningMinutes)
    ? `Candidates must come from the track's strongest retained year, clear active avoids, and reach at least ${number(minimumEngagedPlays)} engaged plays and ${number(minimumListeningMinutes, 1)} listening minutes.`
    : "Candidates must come from the track's strongest retained year and clear active avoids.";
  return `<aside class="time-machine-selection" aria-label="Time Machine year coverage"><strong>${escapeHtml(coverageCopy)}</strong><span>${escapeHtml(`${unrepresentedCopy} The route is bounded and evenly spaced. ${thresholdCopy}`)}</span></aside>`;
}

function artistRelationshipRows(items) {
  if (items.length === 0) {
    return '<p class="empty">No artist appears across enough retained years and the latest retained year.</p>';
  }
  return `<ol class="relationship-list">${items
    .map((item) => {
      const activeYears = Number.isInteger(item.active_years)
        ? item.active_years
        : item.last_year - item.first_year + 1;
      const details = [
        Number.isInteger(item.play_count)
          ? `${number(item.play_count)} effective plays`
          : null,
        Number.isFinite(item.listening_minutes)
          ? listeningTime(item.listening_minutes)
          : null,
      ].filter(Boolean);
      return `<li>
        <div class="relationship-head"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(`${number(activeYears)} active years across ${item.first_year}-${item.last_year}`)}</span></div>
        ${details.length > 0 ? `<small>${escapeHtml(details.join(" / "))}</small>` : ""}
      </li>`;
    })
    .join("")}</ol>`;
}

function yearTransitionRows(items, fallbackArtistLimit) {
  if (items.length === 0) {
    return '<p class="empty">At least two retained years are needed to compare top-artist continuity.</p>';
  }
  return `<ol class="transition-list">${items
    .map((item) => {
      const artistLimit = Number.isInteger(item.artist_limit)
        ? item.artist_limit
        : fallbackArtistLimit;
      const continuity = Math.max(0, Math.min(100, item.continuity_percent));
      const retained = Number.isInteger(item.retained_artist_count)
        ? item.retained_artist_count
        : 0;
      const introduced = Number.isInteger(item.new_artist_count)
        ? item.new_artist_count
        : 0;
      const retainedArtists = item.retained_artists ?? [];
      const newArtists = item.new_artists ?? [];
      const retainedNames = retainedArtists.length > 0
        ? `Carried forward: ${naturalList(retainedArtists)}.`
        : "";
      const introducedNames = newArtists.length > 0
        ? `New in the later top set: ${naturalList(newArtists)}.`
        : "";
      return `<li>
        <div class="transition-head"><strong>${escapeHtml(`${item.from_year} to ${item.to_year}`)}</strong><span>${escapeHtml(`${number(continuity, 1)}% carried forward`)}</span></div>
        <div class="transition-bar" aria-label="${escapeHtml(`${number(continuity, 1)} percent of ${item.to_year}'s top artists also ranked in ${item.from_year}`)}"><span style="width:${escapeHtml(String(continuity))}%"></span></div>
        <p>${escapeHtml(`${number(introduced)} new to ${item.to_year}'s top ${number(artistLimit)}. ${number(retained)} carried forward from ${item.from_year}.`)}</p>
        ${retainedNames || introducedNames ? `<small>${escapeHtml(`${retainedNames} ${introducedNames}`.trim())}</small>` : ""}
      </li>`;
    })
    .join("")}</ol>`;
}

function releaseDepthRows(items) {
  if (items.length === 0) {
    return '<p class="empty">No release has enough retained multi-track coverage.</p>';
  }
  return `<ol class="release-depth-list">${items
    .map((item, index) => {
      const years = Number.isInteger(item.first_year) &&
        Number.isInteger(item.last_year)
        ? item.first_year === item.last_year
          ? `${item.first_year}`
          : `${item.first_year}-${item.last_year}`
        : null;
      const details = [
        Number.isInteger(item.distinct_tracks)
          ? `${number(item.distinct_tracks)} distinct tracks`
          : null,
        Number.isInteger(item.play_count)
          ? `${number(item.play_count)} effective plays`
          : null,
        listeningTime(item.listening_minutes),
        Number.isInteger(item.active_years) && years
          ? `${number(item.active_years)} active ${item.active_years === 1 ? "year" : "years"} across ${years}`
          : years,
      ].filter(Boolean);
      return `<li>
        <span class="release-index">${String(index + 1).padStart(2, "0")}</span>
        <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.artist_credit)}</p><small>${escapeHtml(details.join(" / "))}</small></div>
      </li>`;
    })
    .join("")}</ol>`;
}

function sessionShape(summary) {
  if (!summary) {
    return '<p class="empty">No bounded Spotify Extended History session signal is available.</p>';
  }
  const total = summary.session_count;
  const minimumPlays = summary.extended_sequence_minimum_plays ?? 5;
  const mix = [
    { label: "1 play", value: summary.single_play_sessions ?? 0 },
    { label: `2-${minimumPlays - 1} plays`, value: summary.short_sequence_sessions ?? 0 },
    { label: `${minimumPlays}+ plays`, value: summary.extended_sequence_sessions ?? 0 },
  ];
  const medianMinutes = listeningTime(summary.median_listening_minutes);
  return `<div class="session-shape">
    <p class="session-lede"><strong>${escapeHtml(`${number(total)} listening stretches`)}</strong><span>${escapeHtml(`${number(summary.extended_sequence_percent, 1)}% contain ${number(minimumPlays)} or more plays`)}</span></p>
    <div class="session-stats">
      <div><strong>${escapeHtml(number(summary.median_plays, 1))}</strong><span>median plays</span></div>
      <div><strong>${escapeHtml(medianMinutes ?? "Unknown")}</strong><span>median listening</span></div>
      <div><strong>${escapeHtml(number(summary.event_count))}</strong><span>eligible events</span></div>
    </div>
    <ol class="session-mix">${mix
      .map((item) => {
        const share = percentage(item.value, total) ?? 0;
        return `<li><div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(`${number(item.value)} stretches / ${number(share, 1)}%`)}</span></div><div class="session-bar" aria-hidden="true"><span style="width:${escapeHtml(String(share))}%"></span></div></li>`;
      })
      .join("")}</ol>
    <p class="session-boundary">A gap longer than ${escapeHtml(number(summary.gap_minutes))} minutes begins a new stretch. This uses UTC track-stop timestamps and remains an approximation.</p>
  </div>`;
}

const pulseMonthLabels = Object.freeze([
  ["J", "January"],
  ["F", "February"],
  ["M", "March"],
  ["A", "April"],
  ["M", "May"],
  ["J", "June"],
  ["J", "July"],
  ["A", "August"],
  ["S", "September"],
  ["O", "October"],
  ["N", "November"],
  ["D", "December"],
]);

function listeningPulseLevel(listeningMinutes, peakListeningMinutes) {
  if (listeningMinutes <= 0 || peakListeningMinutes <= 0) return 0;
  return Math.max(
    1,
    Math.min(4, Math.ceil(Math.sqrt(listeningMinutes / peakListeningMinutes) * 4)),
  );
}

function monthlyActivityGrid(activity) {
  if (!activity) return "";
  const byMonth = new Map(activity.months.map((month) => [month.month, month]));
  const firstYear = Number(activity.first_month.slice(0, 4));
  const lastYear = Number(activity.last_month.slice(0, 4));
  const monthHeaders = pulseMonthLabels
    .map(([short, long]) =>
      `<span class="pulse-month-label" title="${long}" aria-hidden="true">${short}</span>`,
    )
    .join("");
  const rows = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    const cells = pulseMonthLabels.map(([, long], monthIndexValue) => {
      const key = `${year}-${String(monthIndexValue + 1).padStart(2, "0")}`;
      const month = byMonth.get(key);
      if (!month) {
        return '<span class="pulse-cell is-outside" aria-hidden="true"></span>';
      }
      const level = listeningPulseLevel(
        month.listening_minutes,
        activity.peak_listening_minutes,
      );
      const description = month.event_count > 0
        ? `${long} ${year}: ${number(month.event_count)} eligible events, ${number(month.listening_minutes)} listening minutes, ${number(month.distinct_tracks)} distinct tracks.`
        : `${long} ${year}: no retained eligible events.`;
      return `<span class="pulse-cell level-${level}" role="gridcell" title="${escapeHtml(description)}" aria-label="${escapeHtml(description)}"></span>`;
    }).join("");
    rows.push(
      `<span class="pulse-year" role="rowheader">${year}</span>${cells}`,
    );
  }
  const boundedCopy = activity.omitted_earlier_month_count > 0
    ? `The latest ${number(activity.represented_month_count)} of ${number(activity.retained_span_months)} retained calendar months are shown; ${number(activity.omitted_earlier_month_count)} earlier months remain outside this bounded view.`
    : `All ${number(activity.represented_month_count)} calendar months in the retained span are represented.`;
  return `<div class="listening-pulse">
    <div class="pulse-summary"><strong>${escapeHtml(`${number(activity.active_month_count)} active retained months`)}</strong><span>${escapeHtml(`${activity.first_month} to ${activity.last_month} UTC`)}</span></div>
    <div class="listening-pulse-grid" role="grid" aria-label="Monthly retained listening activity in UTC">
      <span class="pulse-corner" aria-hidden="true">UTC</span>${monthHeaders}${rows.join("")}
    </div>
    <div class="pulse-legend" aria-label="Listening-minute intensity scale"><span>Less retained time</span><i class="pulse-cell level-1"></i><i class="pulse-cell level-2"></i><i class="pulse-cell level-3"></i><i class="pulse-cell level-4"></i><span>More</span></div>
    <p class="pulse-boundary">${escapeHtml(`${boundedCopy} Color reflects listening minutes within this profile only. A blank cell means no eligible retained event appears in that UTC month, not proof that no listening occurred.`)}</p>
  </div>`;
}

function listeningSeasonMonthRange(season) {
  const firstMonth = Number(season.start_month.slice(5, 7));
  const lastMonth = Number(season.end_month.slice(5, 7));
  const firstLabel = pulseMonthLabels[firstMonth - 1]?.[1]?.slice(0, 3);
  const lastLabel = pulseMonthLabels[lastMonth - 1]?.[1]?.slice(0, 3);
  return firstLabel === lastLabel
    ? `${firstLabel} UTC`
    : `${firstLabel}-${lastLabel} UTC`;
}

function listeningSeasonsPanel(activity) {
  if (!activity || activity.seasons.length === 0) return "";
  const cards = activity.seasons
    .map((season) => {
      const quarter = Number(season.key.slice(6));
      const heading = season.key.replace("-", " ");
      const partial = season.retained_month_count < 3
        ? `${number(season.retained_month_count)} of 3 months retained`
        : "complete calendar quarter";
      if (season.event_count === 0) {
        return `<article class="listening-season-card is-empty quarter-${quarter}">
          <header><strong>${escapeHtml(heading)}</strong><span>${escapeHtml(listeningSeasonMonthRange(season))}</span></header>
          <div class="season-empty-mark" aria-hidden="true"></div>
          <p>No retained eligible events appear in this window.</p>
          <small>${escapeHtml(partial)}</small>
        </article>`;
      }
      const firstObservedShare = percentage(
        season.first_observed_tracks,
        season.distinct_tracks,
      ) ?? 0;
      const signature = season.signature_track;
      const leading = season.leading_artist;
      return `<article class="listening-season-card quarter-${quarter}">
        <header><strong>${escapeHtml(heading)}</strong><span>${escapeHtml(listeningSeasonMonthRange(season))}</span></header>
        <div class="season-total"><strong>${escapeHtml(listeningTime(season.listening_minutes) ?? "Unknown time")}</strong><span>${escapeHtml(`${number(season.event_count)} events / ${number(season.distinct_tracks)} tracks`)}</span></div>
        <div class="season-mix" aria-label="${escapeHtml(`${number(season.first_observed_tracks)} tracks first observed in retained history and ${number(season.returning_tracks)} seen in an earlier retained season`)}">
          <span style="width:${escapeHtml(String(firstObservedShare))}%"></span>
        </div>
        <p class="season-mix-label"><span>${escapeHtml(`${number(season.first_observed_tracks)} first observed`)}</span><span>${escapeHtml(`${number(season.returning_tracks)} seen earlier`)}</span></p>
        <dl class="season-anchors">
          <div><dt>Leading artist</dt><dd>${escapeHtml(leading.name)}</dd></div>
          <div><dt>Signature track</dt><dd>${escapeHtml(signature.label)}<span>${escapeHtml(signature.artist_credit)}</span></dd></div>
        </dl>
        <small>${escapeHtml(`${number(season.active_month_count)} active of ${number(season.retained_month_count)} retained months / ${partial}`)}</small>
      </article>`;
    })
    .join("");
  const previewCopy = activity.preview_omitted_season_count > 0
    ? `The latest ${number(activity.preview_season_count)} of ${number(activity.represented_season_count)} represented seasons are shown; ${number(activity.preview_omitted_active_season_count)} earlier active represented seasons remain outside this panel.`
    : `All ${number(activity.represented_season_count)} represented seasons are shown.`;
  const projectionCopy = activity.omitted_earlier_season_count > 0
    ? ` ${number(activity.omitted_earlier_season_count)} still-earlier retained seasons, including ${number(activity.omitted_earlier_active_season_count)} active seasons, sit outside the 80-season projection.`
    : "";
  return `<article class="panel listening-seasons-panel" id="listening-seasons">
    <div class="listening-seasons-heading"><div><span class="panel-label">Fixed three-month UTC windows</span><h3>Listening Seasons</h3></div><strong>${escapeHtml(`${number(activity.active_season_count)} active seasons`)}</strong></div>
    <p class="panel-intro">A chronological view of what occupied each calendar quarter. Leading artists and signature tracks describe only their window. They are not mood, identity, or life-event claims.</p>
    <div class="listening-seasons-grid">${cards}</div>
    <p class="listening-seasons-boundary">${escapeHtml(`${previewCopy}${projectionCopy} First observed means first appearance in retained eligible history, not discovery. An empty season is an archive observation, not proof of no listening.`)}</p>
  </article>`;
}

function crossFormatIdentityCoverage(coverage) {
  const links = coverage.cross_format_track_links;
  const events = coverage.cross_format_linked_events;
  const ambiguousTracks = coverage.cross_format_ambiguous_tracks;
  const ambiguousEvents = coverage.cross_format_ambiguous_events;
  const appliedLinks = Number.isInteger(links) ? links : 0;
  const withheldTracks = Number.isInteger(ambiguousTracks)
    ? ambiguousTracks
    : 0;
  if (appliedLinks < 1 && withheldTracks < 1) return "";
  const linkNoun = appliedLinks === 1 ? "identity" : "identities";
  const summary = appliedLinks > 0
    ? `${number(appliedLinks)} provisional track ${linkNoun} joined to resolved Spotify identities.`
    : `${number(withheldTracks)} ambiguous provisional track ${withheldTracks === 1 ? "identity remains" : "identities remain"} separate.`;
  const detail = [];
  if (appliedLinks > 0) {
    const linkedEventNoun = events === 1 ? "event" : "events";
    detail.push(
      `Exact overlapping plays support behavioral aggregation across ${number(events)} effective ${linkedEventNoun}.`,
    );
  }
  if (withheldTracks > 0) {
    const ambiguousTrackNoun = withheldTracks === 1
      ? "provisional identity"
      : "provisional identities";
    const ambiguousEventNoun = ambiguousEvents === 1 ? "event" : "events";
    detail.push(
      `Multi-target cases stay separate: ${number(withheldTracks)} ${ambiguousTrackNoun} across ${number(ambiguousEvents)} effective ${ambiguousEventNoun} were not joined because exact overlaps point to multiple resolved Spotify identities.`,
    );
  } else {
    detail.push("Multi-target cases stay separate.");
  }
  detail.push("Original records remain intact.");
  return `<aside class="identity-coverage" aria-label="Cross-format track identity coverage"><strong>${escapeHtml(summary)}</strong><span>${escapeHtml(detail.join(" "))}</span></aside>`;
}

export function renderTasteprintHtml(profile, options = {}) {
  const view = createTasteprintView(profile, options);
  const syntheticDemo = view.synthetic_demo === true;
  const coverage = view.coverage;
  const context = view.behavior.context;
  const profiledEvents =
    context.effective_events_profiled ?? coverage.profiled_listening_events;
  const resolvedShare = percentage(
    coverage.resolved_listening_tracks,
    coverage.listening_tracks,
  );
  const generatedLabel = dateLabel(view.generated_at);
  const rangeLabel = view.timeline.earliest && view.timeline.latest
    ? `${dateLabel(view.timeline.earliest)} to ${dateLabel(view.timeline.latest)}`
    : "Bounded local profile range";
  const recentWindow = context.recent_window_days ?? 90;
  const rediscoveryQuietDays =
    context.rediscovery_quiet_days ?? recentWindow;
  const listenerCorrectionCount =
    view.deliberate.listener_preferences.length +
    view.deliberate.listener_avoids.length;
  const hasProfileChoiceSignals = [
    view.deliberate.strong_preferences,
    view.deliberate.saved_tracks,
    view.deliberate.playlist_anchors,
    view.deliberate.followed_artists,
    view.deliberate.saved_albums,
    view.search_intent,
  ].some((items) => items.length > 0);
  const hasDeliberateChoiceSignals =
    listenerCorrectionCount > 0 || hasProfileChoiceSignals;
  const hasFacetSignals =
    view.facets.artists.length > 0 || view.facets.genres.length > 0;
  const hasProviderSnapshot = [
    view.provider_snapshot.artists,
    view.provider_snapshot.tracks,
    view.provider_snapshot.genres,
    view.provider_snapshot.highlights,
    view.provider_snapshot.metrics,
  ].some((items) => items.length > 0);
  const hasListeningPatterns =
    view.behavior.release_depth.length > 0 ||
    view.behavior.session_summary !== null ||
    view.behavior.back_to_back_tracks.length > 0;
  const heroDimensions = [
    "familiarity",
    hasDeliberateChoiceSignals ? "deliberate choices" : null,
    "recent movement",
    view.behavior.time_capsule_tracks.length > 0
      ? "listening-year landmarks"
      : null,
    view.behavior.monthly_activity ? "monthly listening pulse" : null,
    view.behavior.listening_seasons ? "listening seasons" : null,
    view.behavior.artist_relationships.length > 0 ||
    view.behavior.year_transitions.length > 0
      ? "taste continuity"
      : null,
    hasListeningPatterns ? "listening patterns" : null,
    view.behavior.rediscovery_tracks.length > 0
      ? "listen-again prompts"
      : null,
    hasProviderSnapshot ? "provider context" : "listening context",
  ].filter(Boolean);
  const heroCopy = `A bounded reading of ${naturalList(heroDimensions)}. No single number pretends to define your taste.`;
  const sectionLinks = [
    { href: "#taste-shape", label: "Taste shape" },
    ...(view.behavior.monthly_activity
      ? [{ href: "#listening-pulse", label: "Listening pulse" }]
      : []),
    ...(view.behavior.listening_seasons
      ? [{ href: "#listening-seasons", label: "Listening seasons" }]
      : []),
    { href: "#listening-arc", label: "Listening arc" },
    ...(view.behavior.artist_relationships.length > 0 ||
    view.behavior.year_transitions.length > 0
      ? [{ href: "#continuity", label: "Continuity and change" }]
      : []),
    ...(hasListeningPatterns
      ? [{ href: "#listening-patterns", label: "Listening patterns" }]
      : []),
    { href: "#tracks-that-stay", label: "Tracks and returns" },
    ...(listenerCorrectionCount > 0
      ? [{ href: "#listener-corrections", label: "Your corrections" }]
      : []),
    ...(hasProfileChoiceSignals || hasFacetSignals
      ? [{ href: "#profile-evidence", label: "Choices and facets" }]
      : []),
    { href: "#playback-flow", label: "Playback flow" },
    ...(hasProviderSnapshot
      ? [{ href: "#provider-snapshot", label: "Provider snapshot" }]
      : []),
    { href: "#interpretation-boundaries", label: "Boundaries" },
  ];
  const sectionNavigator = `<nav class="section-nav" aria-label="Tasteprint sections">
      <span class="section-nav-label">Explore this Tasteprint</span>
      <div class="section-nav-links">${sectionLinks.map((item) => `<a href="${item.href}">${item.label}</a>`).join("")}</div>
    </nav>`;

  const choicePanels = [
    view.deliberate.strong_preferences.length > 0
      ? `<article class="panel"><span class="panel-label">Explicit and curated signals</span><h3>Strong preferences</h3>${signalList(view.deliberate.strong_preferences)}</article>`
      : "",
    view.deliberate.saved_tracks.length > 0
      ? `<article class="panel"><span class="panel-label">Saved library</span><h3>Saved tracks</h3>${trackRows(view.deliberate.saved_tracks)}</article>`
      : "",
    view.deliberate.playlist_anchors.length > 0
      ? `<article class="panel"><span class="panel-label">Playlist curation</span><h3>Playlist anchors</h3>${trackRows(view.deliberate.playlist_anchors)}</article>`
      : "",
    view.deliberate.followed_artists.length > 0
      ? `<article class="panel"><span class="panel-label">Explicit state</span><h3>Followed artists</h3>${nameRows(view.deliberate.followed_artists)}</article>`
      : "",
    view.deliberate.saved_albums.length > 0
      ? `<article class="panel"><span class="panel-label">Saved library</span><h3>Saved albums</h3>${trackRows(view.deliberate.saved_albums)}</article>`
      : "",
    view.search_intent.length > 0
      ? `<article class="panel"><span class="panel-label">Verified interaction</span><h3>Music search intent</h3>${searchRows(view.search_intent)}</article>`
      : "",
  ].filter(Boolean);
  const facetBlocks = [
    view.facets.artists.length > 0
      ? `<div class="facet-block"><h3>Artist facets</h3>${tagCloud(view.facets.artists)}</div>`
      : "",
    view.facets.genres.length > 0
      ? `<div class="facet-block"><h3>Genre labels</h3>${tagCloud(view.facets.genres)}</div>`
      : "",
  ].filter(Boolean);
  const profileEvidenceHeading = hasProfileChoiceSignals
    ? hasFacetSignals
      ? "Deliberate choices and profile facets"
      : "Deliberate choices"
    : "Profile facets";
  const profileEvidenceCopy = hasProfileChoiceSignals
    ? hasFacetSignals
      ? "Saved state, favorites, follows, playlist placement, and verified search interactions stay distinct from profile facets, which summarize the profile without proving choice."
      : "Saved state, favorites, follows, playlist placement, and verified search interactions are kept separate from passive or ambiguous listening behavior."
    : "These bounded artist and genre labels summarize the profile without turning listening behavior into a direct preference claim.";
  const profileEvidenceSection =
    hasProfileChoiceSignals || hasFacetSignals
      ? `<section class="section" id="profile-evidence">
      <div class="section-heading"><h2>${profileEvidenceHeading}</h2><p>${profileEvidenceCopy}</p></div>
      ${facetBlocks.length > 0 ? `<article class="panel profile-facets"><span class="panel-label">Profile summary, not direct choice</span>${facetBlocks.join("")}</article>` : ""}
      ${choicePanels.length > 0 ? `<div class="adaptive-grid"${facetBlocks.length > 0 ? ' style="margin-top:18px"' : ""}>${choicePanels.join("")}</div>` : ""}
    </section>`
      : "";

  const providerPanels = [
    view.provider_snapshot.artists.length > 0
      ? `<article class="panel"><span class="panel-label">Provider-derived</span><h3>Ranked artists</h3>${providerRows(view.provider_snapshot.artists, "artist")}</article>`
      : "",
    view.provider_snapshot.tracks.length > 0
      ? `<article class="panel"><span class="panel-label">Provider-derived</span><h3>Ranked tracks</h3>${providerRows(view.provider_snapshot.tracks, "track")}</article>`
      : "",
  ].filter(Boolean);
  const providerCards = snapshotCards(view);
  const providerSection = hasProviderSnapshot
    ? `<section class="section" id="provider-snapshot">
      <div class="section-heading"><h2>The provider's snapshot</h2><p>Wrapped, Taste Profile, and Sound Capsule are preserved as quoted provider-derived context. They are not treated as user assertions or instructions.</p></div>
      <p class="provider-intro">This layer stays visibly separate from Moondog's behavioral and deliberate evidence. Rankings can summarize a period, but they do not replace the underlying history.</p>
      ${providerPanels.length > 0 ? `<div class="adaptive-grid">${providerPanels.join("")}</div>` : ""}
      ${view.provider_snapshot.genres.length > 0 ? `<div class="facet-block"${providerPanels.length > 0 ? ' style="margin-top:18px"' : ""}><h3>Provider-ranked genres</h3>${tagCloud(view.provider_snapshot.genres.map((item) => `${item.name}${Number.isInteger(item.rank) ? ` #${item.rank}` : ""}`))}</div>` : ""}
      ${providerCards}
    </section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light">
  <title>${syntheticDemo ? "Moondog Synthetic Tasteprint Demo" : "Private Moondog Tasteprint"}</title>
  <style>
    :root {
      --paper: #eee8de;
      --paper-deep: #e3d9cc;
      --card: #f8f4ed;
      --ink: #1b1b19;
      --muted: #68625a;
      --line: #c8bdaf;
      --line-strong: #9f9384;
      --accent: #6f8ca8;
      --accent-soft: #d7e3ed;
      --night: #1b1b19;
      --night-soft: #252522;
      --shadow: 0 18px 50px rgba(39, 31, 24, 0.09);
      color: var(--ink);
      background: var(--paper);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    html { min-width: 320px; scroll-behavior: smooth; }

    html:has(#taste-shape:target),
    html:has(#time-machine:target),
    html:has(#listening-pulse:target),
    html:has(#listening-seasons:target),
    html:has(#listening-patterns:target) { scrollbar-width: none; }
    html:has(#taste-shape:target)::-webkit-scrollbar,
    html:has(#time-machine:target)::-webkit-scrollbar,
    html:has(#listening-pulse:target)::-webkit-scrollbar,
    html:has(#listening-seasons:target)::-webkit-scrollbar,
    html:has(#listening-patterns:target)::-webkit-scrollbar { display: none; }

    html:has(#taste-shape:target),
    html:has(#time-machine:target),
    html:has(#listening-pulse:target),
    html:has(#listening-seasons:target),
    html:has(#listening-patterns:target) { scroll-behavior: auto; }

    body {
      margin: 0;
      background:
        radial-gradient(circle at 8% 0%, rgba(255, 255, 255, 0.68), transparent 35rem),
        linear-gradient(180deg, var(--paper) 0%, #e8dfd3 100%);
    }

    .shell {
      width: min(1220px, calc(100% - 40px));
      margin: 0 auto;
      padding: 42px 0 70px;
    }

    .hero {
      position: relative;
      isolation: isolate;
      overflow: hidden;
      min-height: 590px;
      padding: clamp(34px, 6vw, 74px);
      border: 1px solid #0f0f0e;
      border-radius: 34px;
      color: #f5f1e9;
      background: var(--night);
      box-shadow: var(--shadow);
    }

    .hero::before {
      position: absolute;
      z-index: -1;
      width: min(760px, 70vw);
      aspect-ratio: 1;
      right: min(-150px, -8vw);
      top: -160px;
      border: 1px solid rgba(245, 241, 233, 0.25);
      border-radius: 50%;
      box-shadow:
        0 0 0 18px rgba(245, 241, 233, 0.035),
        0 0 0 48px rgba(245, 241, 233, 0.026),
        0 0 0 84px rgba(245, 241, 233, 0.02),
        0 0 0 126px rgba(245, 241, 233, 0.016);
      content: "";
    }

    .hero::after {
      position: absolute;
      z-index: -1;
      width: 18px;
      height: 18px;
      right: clamp(100px, 17vw, 230px);
      top: 168px;
      border: 9px solid rgba(245, 241, 233, 0.12);
      border-radius: 50%;
      background: #f5f1e9;
      content: "";
    }

    .eyebrow {
      display: flex;
      gap: 9px;
      align-items: center;
      margin: 0 0 40px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.19em;
      text-transform: uppercase;
    }

    .eyebrow::before {
      width: 8px;
      height: 8px;
      border: 5px solid rgba(111, 140, 168, 0.25);
      border-radius: 50%;
      background: #a9bfd3;
      content: "";
    }

    h1, h2, .serif {
      font-family: Iowan Old Style, Baskerville, "Times New Roman", serif;
      font-weight: 650;
      letter-spacing: -0.035em;
    }

    h1 {
      max-width: 760px;
      margin: 0;
      font-size: clamp(54px, 8.6vw, 112px);
      line-height: 0.86;
    }

    .hero-copy {
      max-width: 590px;
      margin: 32px 0 0;
      color: #d0cbc3;
      font-size: clamp(17px, 2vw, 21px);
      line-height: 1.55;
    }

    .hero-meta {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      width: min(690px, 100%);
      margin-top: 54px;
      border: 1px solid rgba(245, 241, 233, 0.24);
      border-radius: 16px;
    }

    .hero-meta div { min-width: 0; padding: 16px 18px; }
    .hero-meta div + div { border-left: 1px solid rgba(245, 241, 233, 0.18); }

    .hero-meta span {
      display: block;
      margin-bottom: 7px;
      color: #aca79f;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .hero-meta strong { overflow-wrap: anywhere; font-size: 13px; }

    .privacy {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 15px;
      align-items: start;
      margin: 24px 0;
      padding: 20px 22px;
      border: 1px solid var(--line-strong);
      border-radius: 18px;
      background: rgba(248, 244, 237, 0.72);
    }

    .privacy-mark {
      display: grid;
      width: 36px;
      height: 36px;
      place-items: center;
      border-radius: 50%;
      color: #f5f1e9;
      background: var(--night);
      font-weight: 800;
    }

    .privacy strong { display: block; margin: 1px 0 4px; }
    .privacy p { margin: 0; color: var(--muted); line-height: 1.5; }

    .overview {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin: 24px 0;
    }

    .identity-coverage {
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.4fr);
      gap: 20px;
      margin: -8px 0 28px;
      padding: 18px 20px;
      border-left: 4px solid var(--accent);
      color: var(--muted);
      background: var(--accent-soft);
      line-height: 1.5;
    }

    .identity-coverage strong,
    .identity-coverage span {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .metric-card {
      min-width: 0;
      min-height: 178px;
      padding: 24px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: var(--card);
      box-shadow: 0 10px 30px rgba(37, 30, 24, 0.045);
    }

    .metric-card strong {
      display: block;
      margin-bottom: 30px;
      overflow-wrap: anywhere;
      font-family: Iowan Old Style, Baskerville, "Times New Roman", serif;
      font-size: clamp(37px, 4.2vw, 55px);
      font-weight: 650;
      letter-spacing: -0.04em;
      line-height: 0.95;
    }

    .metric-card span {
      display: block;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }

    .metric-card small { display: block; margin-top: 7px; color: var(--muted); line-height: 1.4; }

    .section-nav {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 18px;
      align-items: center;
      margin: 24px 0;
      padding: 15px 16px 15px 20px;
      border: 1px solid var(--line-strong);
      border-radius: 18px;
      background: rgba(248, 244, 237, 0.82);
      box-shadow: 0 10px 30px rgba(37, 30, 24, 0.045);
    }

    .section-nav-label {
      color: var(--muted);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.13em;
      text-transform: uppercase;
    }

    .section-nav-links {
      display: flex;
      min-width: 0;
      flex-wrap: wrap;
      gap: 7px;
    }

    .section-nav a {
      display: inline-flex;
      min-height: 36px;
      align-items: center;
      padding: 8px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--ink);
      background: #fbf8f2;
      font-size: 11px;
      font-weight: 750;
      text-decoration: none;
    }

    .section-nav a:hover { border-color: var(--ink); }
    .section-nav a:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

    .section {
      min-width: 0;
      margin-top: 24px;
      scroll-margin-top: 24px;
      padding: clamp(26px, 4.5vw, 54px);
      border: 1px solid var(--line);
      border-radius: 26px;
      background: rgba(248, 244, 237, 0.92);
      box-shadow: var(--shadow);
    }

    .section.dark { color: #f5f1e9; background: var(--night); border-color: #10100f; }

    .demo-chip {
      display: inline-flex;
      margin: 0 0 22px;
      padding: 7px 10px;
      border: 1px solid #5f7182;
      border-radius: 999px;
      color: #c8d9e8;
      background: rgba(111, 140, 168, 0.12);
      font-size: 9px;
      font-weight: 850;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .section-heading {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, 360px);
      gap: 34px;
      align-items: end;
      margin-bottom: 38px;
    }

    .section-heading h2 {
      margin: 0;
      font-size: clamp(40px, 5.5vw, 68px);
      line-height: 0.98;
    }

    .section-heading p { margin: 0; color: var(--muted); line-height: 1.55; }
    .dark .section-heading p { color: #bbb5ad; }

    .two-column {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }

    .three-column {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }

    .adaptive-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
      gap: 12px;
    }

    .panel {
      min-width: 0;
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: #fbf8f2;
    }

    .dark .panel { border-color: #44433e; background: var(--night-soft); }

    .panel-label {
      display: block;
      margin-bottom: 8px;
      color: var(--accent);
      font-size: 10px;
      font-weight: 850;
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }

    .panel h3 { margin: 0 0 25px; font-size: 23px; }

    .rediscovery-panel {
      margin-bottom: 18px;
      border-color: #a8bac9;
      background: linear-gradient(135deg, #edf3f7 0%, #fbf8f2 72%);
    }

    .time-capsule-panel {
      margin-top: 18px;
      border-color: #c4ad88;
      background: linear-gradient(135deg, #f5ecdc 0%, #fbf8f2 72%);
    }

    .panel-intro {
      max-width: 760px;
      margin: -12px 0 24px;
      color: var(--muted);
      line-height: 1.55;
    }

    .time-machine-selection {
      display: grid;
      grid-template-columns: minmax(150px, 0.42fr) minmax(0, 1fr);
      gap: 18px;
      margin: -5px 0 24px;
      padding: 15px 17px;
      border: 1px solid rgba(111, 140, 168, 0.42);
      border-radius: 14px;
      background: rgba(215, 227, 237, 0.44);
    }

    .time-machine-selection strong {
      color: #4f708f;
      font-size: 12px;
      line-height: 1.45;
    }

    .time-machine-selection span {
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.55;
    }

    .relationship-list, .transition-list {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .relationship-list li, .transition-list li {
      min-width: 0;
      padding: 16px 0;
      border-top: 1px solid var(--line);
    }

    .relationship-list li:first-child, .transition-list li:first-child {
      padding-top: 0;
      border-top: 0;
    }

    .relationship-head, .transition-head {
      display: flex;
      min-width: 0;
      align-items: baseline;
      justify-content: space-between;
      gap: 14px;
    }

    .relationship-head strong, .transition-head strong {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .relationship-head span, .transition-head span {
      flex: 0 0 auto;
      color: var(--accent);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .relationship-list small, .transition-list small {
      display: block;
      margin-top: 6px;
      color: var(--muted);
      line-height: 1.45;
    }

    .transition-list p {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }

    .transition-bar {
      height: 7px;
      margin-top: 11px;
      overflow: hidden;
      border-radius: 99px;
      background: #ddd5ca;
    }

    .transition-bar span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
    }

    .pattern-section {
      background:
        radial-gradient(circle at 100% 0%, rgba(111, 140, 168, 0.16), transparent 28rem),
        rgba(248, 244, 237, 0.94);
    }

    .pattern-demo-chip {
      display: inline-flex;
      margin: 0 0 22px;
      padding: 7px 10px;
      border: 1px solid #a8bac9;
      border-radius: 999px;
      color: #4f708f;
      background: rgba(237, 243, 247, 0.86);
      font-size: 9px;
      font-weight: 850;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .pattern-grid {
      align-items: start;
      grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr));
    }

    .session-panel {
      border-color: #a8bac9;
      background: linear-gradient(145deg, #edf3f7 0%, #fbf8f2 72%);
    }

    .session-shape { min-width: 0; }

    .session-lede {
      display: flex;
      min-width: 0;
      align-items: baseline;
      justify-content: space-between;
      gap: 14px;
      margin: 0 0 18px;
    }

    .session-lede strong { min-width: 0; overflow-wrap: anywhere; font-size: 17px; }
    .session-lede span { flex: 0 1 auto; color: #4f708f; font-size: 11px; font-weight: 800; text-align: right; }

    .session-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 20px;
    }

    .session-stats div {
      min-width: 0;
      padding: 14px;
      border: 1px solid rgba(111, 140, 168, 0.28);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.48);
    }

    .session-stats strong { display: block; overflow-wrap: anywhere; font: 650 25px Iowan Old Style, Baskerville, serif; }
    .session-stats span { display: block; margin-top: 5px; color: var(--muted); font-size: 9px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }

    .session-mix, .release-depth-list {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .session-mix li { padding: 12px 0; border-top: 1px solid var(--line); }
    .session-mix li:first-child { padding-top: 0; border-top: 0; }
    .session-mix li > div:first-child { display: flex; min-width: 0; justify-content: space-between; gap: 12px; }
    .session-mix strong { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
    .session-mix li > div:first-child span { flex: 0 0 auto; color: var(--muted); font-size: 10px; }

    .session-bar { height: 6px; margin-top: 8px; overflow: hidden; border-radius: 99px; background: #d5dce2; }
    .session-bar span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }

    .session-boundary { margin: 16px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }

    .release-depth-list li {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 13px;
      min-width: 0;
      padding: 16px 0;
      border-top: 1px solid var(--line);
    }

    .release-depth-list li:first-child { padding-top: 0; border-top: 0; }
    .release-index { color: var(--muted); font: 750 10px ui-monospace, monospace; }
    .release-depth-list li > div { min-width: 0; }
    .release-depth-list strong { display: block; overflow-wrap: anywhere; }
    .release-depth-list p { margin: 4px 0; color: var(--muted); font-size: 13px; }
    .release-depth-list small { color: var(--muted); line-height: 1.45; }

    .rank-list, .track-list, .provider-list, .signal-list, .tags {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .rank-list li {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 14px;
      padding: 15px 0;
      border-top: 1px solid var(--line);
    }

    .dark .rank-list li { border-color: #44433e; }
    .rank-list li:first-child { padding-top: 0; border-top: 0; }

    .rank-number { padding-top: 2px; color: var(--muted); font: 700 10px ui-monospace, monospace; }
    .dark .rank-number { color: #918c84; }

    .rank-heading { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .rank-heading strong { min-width: 0; overflow-wrap: anywhere; }
    .rank-heading span { flex: 0 0 auto; color: var(--muted); font-size: 9px; text-transform: uppercase; }
    .dark .rank-heading span { color: #928d85; }

    .bar { height: 5px; margin: 9px 0 7px; overflow: hidden; border-radius: 99px; background: #ddd5ca; }
    .bar i { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
    .dark .bar { background: #3e3d39; }
    .rank-content small { color: var(--muted); }
    .dark .rank-content small { color: #aaa49c; }

    .listening-pulse-panel {
      margin-bottom: 18px;
      border-color: #a8bac9;
      background:
        radial-gradient(circle at 100% 0%, rgba(111, 140, 168, 0.16), transparent 30rem),
        linear-gradient(145deg, #edf3f7 0%, #fbf8f2 72%);
    }

    .listening-pulse { min-width: 0; }

    .pulse-summary {
      display: flex;
      min-width: 0;
      align-items: baseline;
      justify-content: space-between;
      gap: 14px;
      margin: 0 0 18px;
    }

    .pulse-summary strong { min-width: 0; overflow-wrap: anywhere; font-size: 17px; }
    .pulse-summary span { flex: 0 1 auto; color: #4f708f; font-size: 11px; font-weight: 800; text-align: right; }

    .listening-pulse-grid {
      display: grid;
      grid-template-columns: 46px repeat(12, minmax(0, 1fr));
      gap: 6px;
      min-width: 0;
      align-items: center;
    }

    .pulse-corner,
    .pulse-month-label,
    .pulse-year {
      color: var(--muted);
      font: 800 9px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.04em;
    }

    .pulse-corner { text-align: left; }
    .pulse-month-label { text-align: center; }
    .pulse-year { padding-right: 4px; text-align: left; }

    .pulse-cell {
      display: block;
      min-width: 0;
      aspect-ratio: 1;
      border: 1px solid rgba(79, 112, 143, 0.12);
      border-radius: 5px;
      background: rgba(111, 140, 168, 0.08);
    }

    .pulse-cell.level-1 { background: #d7e3ed; }
    .pulse-cell.level-2 { background: #aec4d6; }
    .pulse-cell.level-3 { background: #829fba; }
    .pulse-cell.level-4 { background: #4f708f; }
    .pulse-cell.is-outside { border-color: transparent; background: transparent; }

    .pulse-legend {
      display: flex;
      min-width: 0;
      align-items: center;
      justify-content: flex-end;
      gap: 5px;
      margin-top: 14px;
      color: var(--muted);
      font-size: 9px;
    }

    .pulse-legend .pulse-cell { width: 12px; min-width: 12px; }
    .pulse-boundary { margin: 12px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }

    .listening-seasons-panel {
      margin-bottom: 18px;
      border-color: #b9a98f;
      background:
        radial-gradient(circle at 0% 100%, rgba(111, 140, 168, 0.12), transparent 30rem),
        linear-gradient(145deg, #fbf8f2 0%, #eee5d7 100%);
    }

    .listening-seasons-heading {
      display: flex;
      min-width: 0;
      align-items: end;
      justify-content: space-between;
      gap: 18px;
    }

    .listening-seasons-heading > div { min-width: 0; }
    .listening-seasons-heading h3 { margin-bottom: 0; }
    .listening-seasons-heading > strong {
      flex: 0 0 auto;
      color: #4f708f;
      font: 800 10px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }

    .listening-seasons-panel .panel-intro { margin: 12px 0 24px; }

    .listening-seasons-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      min-width: 0;
      margin-top: 18px;
    }

    .listening-season-card {
      position: relative;
      min-width: 0;
      overflow: hidden;
      padding: 17px;
      border: 1px solid rgba(84, 72, 56, 0.2);
      border-radius: 15px;
      background: rgba(255, 252, 246, 0.72);
    }

    .listening-season-card::before {
      position: absolute;
      inset: 0 auto 0 0;
      width: 3px;
      background: #6f8ca8;
      content: "";
    }

    .listening-season-card.quarter-2::before { background: #8aa28d; }
    .listening-season-card.quarter-3::before { background: #c39968; }
    .listening-season-card.quarter-4::before { background: #866f89; }

    .listening-season-card header,
    .season-total,
    .season-mix-label {
      display: flex;
      min-width: 0;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
    }

    .listening-season-card header strong {
      font: 760 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.04em;
    }

    .listening-season-card header span,
    .listening-season-card > small {
      color: var(--muted);
      font-size: 8px;
      line-height: 1.45;
    }

    .season-total { margin-top: 16px; }
    .season-total strong {
      min-width: 0;
      overflow-wrap: anywhere;
      font: 650 24px Iowan Old Style, Baskerville, serif;
      letter-spacing: -0.035em;
    }
    .season-total span {
      flex: 0 1 auto;
      color: var(--muted);
      font-size: 8px;
      text-align: right;
    }

    .season-mix {
      height: 4px;
      margin-top: 13px;
      overflow: hidden;
      border-radius: 99px;
      background: #c4b8a7;
    }
    .season-mix span { display: block; height: 100%; background: #6f8ca8; }
    .season-mix-label { margin: 5px 0 0; color: var(--muted); font-size: 7px; }

    .season-anchors { display: grid; gap: 9px; margin: 15px 0 13px; }
    .season-anchors div { min-width: 0; padding-top: 9px; border-top: 1px solid rgba(84, 72, 56, 0.14); }
    .season-anchors dt {
      color: var(--muted);
      font-size: 7px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .season-anchors dd { margin: 4px 0 0; overflow-wrap: anywhere; font-size: 11px; font-weight: 720; }
    .season-anchors dd span { display: block; margin-top: 2px; color: var(--muted); font-size: 8px; font-weight: 500; }

    .listening-season-card.is-empty { min-height: 180px; background: rgba(255, 252, 246, 0.38); }
    .listening-season-card.is-empty::before { opacity: 0.35; }
    .season-empty-mark { height: 1px; margin: 37px 0 14px; background: repeating-linear-gradient(90deg, #bfb3a4 0 4px, transparent 4px 10px); }
    .listening-season-card.is-empty p { margin: 0 0 24px; color: var(--muted); font-size: 10px; line-height: 1.5; }
    .listening-season-card.is-empty > small { position: absolute; right: 17px; bottom: 17px; left: 17px; }
    .listening-seasons-boundary { margin: 14px 0 0; color: var(--muted); font-size: 10px; line-height: 1.55; }

    .history-arc { margin: 0; padding: 0; list-style: none; }
    .history-arc li {
      display: grid;
      grid-template-columns: 90px minmax(0, 1fr) minmax(170px, 0.42fr);
      gap: 24px;
      align-items: center;
      padding: 22px 0;
      border-top: 1px solid var(--line);
    }
    .history-arc li:first-child { padding-top: 0; border-top: 0; }
    .arc-year strong { display: block; font: 650 34px Iowan Old Style, Baskerville, serif; letter-spacing: -0.04em; }
    .arc-year span, .arc-heading span, .arc-artist span {
      display: block;
      margin-top: 4px;
      color: var(--muted);
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .arc-body, .arc-artist { min-width: 0; }
    .arc-heading { display: flex; gap: 10px; align-items: baseline; }
    .arc-heading strong { font-size: 16px; }
    .arc-heading span { margin-top: 0; }
    .arc-body .bar { height: 7px; margin: 10px 0 8px; }
    .arc-body small, .arc-artist small { color: var(--muted); }
    .arc-artist { padding-left: 20px; border-left: 1px solid var(--line); }
    .arc-artist span { margin: 0 0 6px; }
    .arc-artist strong { display: block; overflow-wrap: anywhere; }
    .arc-artist small { display: block; margin-top: 5px; }

    .track-list li, .provider-list li {
      display: grid;
      grid-template-columns: 35px minmax(0, 1fr);
      gap: 13px;
      padding: 17px 0;
      border-top: 1px solid var(--line);
    }

    .track-list li:first-child, .provider-list li:first-child { padding-top: 0; border-top: 0; }
    .track-index, .provider-list > li > span { color: var(--muted); font: 750 10px ui-monospace, monospace; }
    .track-list strong, .provider-list strong { display: block; overflow-wrap: anywhere; }
    .track-list p, .provider-list p { margin: 4px 0; color: var(--muted); font-size: 13px; }
    .track-list small, .provider-list small { color: var(--muted); }

    .facets-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr);
      gap: 18px;
    }

    .signal-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .signal-list li { min-width: 0; padding: 16px; border: 1px solid var(--line); border-radius: 14px; background: #fbf8f2; }
    .signal-list strong { display: block; overflow-wrap: anywhere; }
    .signal-list span { display: block; margin-top: 7px; color: var(--muted); font-size: 11px; }

    .compact-list { margin: 0; padding: 0; list-style: none; }
    .compact-list li { padding: 12px 0; border-top: 1px solid var(--line); }
    .compact-list li:first-child { padding-top: 0; border-top: 0; }
    .compact-list strong { display: block; overflow-wrap: anywhere; font-size: 13px; }
    .compact-list span { display: block; margin-top: 4px; color: var(--muted); font-size: 10px; }

    .facet-block + .facet-block { margin-top: 26px; }
    .facet-block h3 { margin: 0 0 13px; font-size: 14px; }
    .tags { display: flex; flex-wrap: wrap; gap: 7px; }
    .tags li { max-width: 100%; padding: 8px 11px; overflow-wrap: anywhere; border: 1px solid var(--line-strong); border-radius: 999px; background: #fbf8f2; font-size: 12px; }

    .behavior-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .behavior-card { min-width: 0; padding: 20px; border: 1px solid #44433e; border-radius: 17px; background: var(--night-soft); }
    .behavior-card > div { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .behavior-card > div strong { font: 650 clamp(28px, 3.5vw, 42px) Iowan Old Style, Baskerville, serif; }
    .behavior-card > div span { color: #a9bfd3; font-size: 12px; font-weight: 800; }
    .behavior-card h3 { margin: 20px 0 8px; font-size: 14px; }
    .behavior-card p { margin: 0; color: #aaa49c; font-size: 11px; line-height: 1.45; }
    .behavior-card small { display: block; margin-top: 12px; color: #77756f; font-size: 9px; line-height: 1.4; }
    .context-note { margin: 16px 0 0; color: #aaa49c; font-size: 12px; }

    .provider-intro {
      margin: 0 0 25px;
      padding: 16px 18px;
      border-left: 4px solid var(--accent);
      color: var(--muted);
      background: var(--accent-soft);
      line-height: 1.5;
    }

    .snapshot-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
    .snapshot-cards article { min-width: 0; padding: 17px; border: 1px solid var(--line); border-radius: 14px; background: #fbf8f2; }
    .snapshot-cards span { display: block; margin-bottom: 14px; color: var(--muted); font-size: 9px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
    .snapshot-cards strong { display: block; overflow-wrap: anywhere; }
    .snapshot-cards p { margin: 6px 0 0; color: var(--muted); font-size: 11px; }

    .limitations { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; counter-reset: boundary; }
    .limitations p { position: relative; min-width: 0; margin: 0; padding: 18px 18px 18px 52px; border: 1px solid var(--line); border-radius: 14px; color: var(--muted); line-height: 1.5; background: #fbf8f2; counter-increment: boundary; }
    .limitations p::before { position: absolute; left: 17px; top: 18px; color: var(--ink); font: 800 10px ui-monospace, monospace; content: counter(boundary, decimal-leading-zero); }

    .empty { margin: 0; color: var(--muted); font-style: italic; }

    footer {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      margin-top: 24px;
      padding: 20px 4px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.5;
    }

    footer span:last-child { text-align: right; }

    @media (max-width: 900px) {
      .overview, .behavior-grid, .snapshot-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .listening-seasons-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .three-column { grid-template-columns: 1fr; }
      .section-heading { grid-template-columns: 1fr; gap: 15px; }
      .facets-grid { grid-template-columns: 1fr; }
    }

    @media (max-width: 660px) {
      .shell { width: min(100% - 20px, 1220px); padding-top: 10px; }
      .hero { min-height: 0; padding: 30px 22px; border-radius: 20px; }
      .hero::before { width: 540px; right: -350px; top: -90px; opacity: 0.62; }
      .hero::after { right: 105px; top: 120px; }
      .eyebrow { margin-bottom: 30px; font-size: 9px; }
      h1 { font-size: clamp(49px, 16vw, 72px); }
      .hero-copy { margin-top: 26px; font-size: 16px; }
      .hero-meta { grid-template-columns: 1fr; margin-top: 38px; }
      .hero-meta div + div { border-top: 1px solid rgba(245, 241, 233, 0.18); border-left: 0; }
      .privacy { padding: 18px; }
      .overview, .two-column, .behavior-grid, .snapshot-cards, .signal-list, .limitations { grid-template-columns: 1fr; }
      .identity-coverage { grid-template-columns: 1fr; gap: 7px; }
      .metric-card { min-height: 150px; }
      .section-nav { grid-template-columns: 1fr; gap: 11px; padding: 16px; }
      .section-nav a { min-height: 40px; }
      .section { padding: 26px 20px; border-radius: 19px; }
      .panel { padding: 20px; }
      .time-machine-selection { grid-template-columns: 1fr; gap: 7px; }
      .relationship-head, .transition-head { align-items: start; flex-direction: column; gap: 5px; }
      .relationship-head span, .transition-head span { flex: 1 1 auto; }
      .session-lede { align-items: start; flex-direction: column; gap: 5px; }
      .session-lede span { text-align: left; }
      .session-stats { grid-template-columns: 1fr; }
      .session-mix li > div:first-child { align-items: start; flex-direction: column; gap: 4px; }
      .session-mix li > div:first-child span { flex: 1 1 auto; }
      .rank-heading { align-items: start; flex-direction: column; gap: 4px; }
      .pulse-summary { align-items: start; flex-direction: column; gap: 5px; }
      .pulse-summary span { text-align: left; }
      .listening-pulse-grid { grid-template-columns: 35px repeat(12, minmax(0, 1fr)); gap: 3px; }
      .pulse-corner, .pulse-month-label, .pulse-year { font-size: 7px; }
      .pulse-cell { border-radius: 3px; }
      .listening-seasons-heading { align-items: start; flex-direction: column; gap: 7px; }
      .listening-seasons-grid { grid-template-columns: 1fr; }
      .season-total span { max-width: 45%; }
      .history-arc li { grid-template-columns: 70px minmax(0, 1fr); gap: 14px; }
      .arc-artist { grid-column: 2; padding: 12px 0 0; border-top: 1px solid var(--line); border-left: 0; }
      footer { flex-direction: column; }
      footer span:last-child { text-align: left; }
    }

    @media print {
      :root { background: white; }
      body { background: white; }
      .shell { width: 100%; padding: 0; }
      .hero, .section, .metric-card { break-inside: avoid; box-shadow: none; }
      .hero { border-radius: 0; }
      .section-nav { display: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <p class="eyebrow">${syntheticDemo ? "Moondog synthetic tasteprint demo" : "Moondog private tasteprint"}</p>
      <h1>${escapeHtml(spanLabel(view.timeline.days))}, seen clearly.</h1>
      <p class="hero-copy">${escapeHtml(heroCopy)}</p>
      <div class="hero-meta" aria-label="Tasteprint snapshot metadata">
        <div><span>Listening range</span><strong>${escapeHtml(rangeLabel)}</strong></div>
        <div><span>Generated</span><strong>${escapeHtml(generatedLabel)}</strong></div>
        <div><span>Profile</span><strong>${escapeHtml(view.profile_version)}</strong></div>
      </div>
    </header>

    <aside class="privacy" aria-label="${syntheticDemo ? "Synthetic demo boundary" : "Privacy boundary"}">
      <span class="privacy-mark" aria-hidden="true">L</span>
      <div><strong>${syntheticDemo ? "Synthetic public demo" : "Private and local"}</strong><p>${syntheticDemo ? "Every artist, track, and aggregate on this page is fictional demonstration data. The page has no scripts, external assets, or network requests." : "This page contains personal music context. It has no scripts, external assets, or network requests. Share only if you are comfortable revealing the visible artists, tracks, and aggregates."}</p></div>
    </aside>

    <section class="overview" aria-label="Listening coverage">
      ${metricCard(number(coverage.effective_listening_events), "effective events", `${number(coverage.profiled_listening_events)} eligible for ranking`)}
      ${metricCard(number(coverage.listening_hours), "listening hours", rangeLabel)}
      ${metricCard(number(coverage.listening_tracks), "distinct tracks", resolvedShare === null ? "resolution coverage unknown" : `${number(resolvedShare, 1)}% resolved identities`)}
      ${metricCard(number(coverage.spotify_playlist_memberships), "playlist placements", `${number(coverage.spotify_saved_tracks)} saved tracks`)}
    </section>

    ${crossFormatIdentityCoverage(coverage)}

    ${sectionNavigator}

    <section class="section dark" id="taste-shape">
      ${syntheticDemo ? '<p class="demo-chip">Fictional public profile</p>' : ""}
      <div class="section-heading"><h2>The shape of your listening</h2><p>Long arc ranks the complete effective history. Recent orbit uses the last ${escapeHtml(number(recentWindow))} days. Bar lengths are relative only within each displayed list.</p></div>
      <div class="two-column">
        <article class="panel"><span class="panel-label">Lifetime signal</span><h3>Long arc</h3>${artistRows(view.behavior.enduring_artists)}</article>
        <article class="panel"><span class="panel-label">Last ${escapeHtml(number(recentWindow))} days</span><h3>Recent orbit</h3>${artistRows(view.behavior.recent_artists, { recent: true })}</article>
      </div>
    </section>

    <section class="section" id="listening-arc">
      <div class="section-heading"><h2>Listening through time</h2><p>Each row groups eligible events by UTC calendar year. First observed means the track's first appearance in retained history, not proof that it was newly discovered then.</p></div>
      ${view.behavior.monthly_activity ? `<article class="panel listening-pulse-panel" id="listening-pulse"><span class="panel-label">Retained UTC activity</span><h3>Listening Pulse</h3><p class="panel-intro">Monthly cells preserve the archive's changing density without exposing a raw timestamp or claiming that an empty month means silence.</p>${monthlyActivityGrid(view.behavior.monthly_activity)}</article>` : ""}
      ${listeningSeasonsPanel(view.behavior.listening_seasons)}
      ${historyArcRows(view.behavior.history_arc)}
      ${view.behavior.time_capsule_tracks.length > 0 ? `<article class="panel time-capsule-panel" id="time-machine"><span class="panel-label">${escapeHtml(number(view.behavior.time_capsule_tracks.length))} chronological landmarks</span><h3>Listening Time Machine</h3><p class="panel-intro">One deterministic representative from each selected peak listening year, balanced across the retained span and cleared of active avoid signals. These tracks are a route through the archive, not claims that they defined a year or remain favorites today.</p>${timeMachineSelectionNote(view)}${trackRows(view.behavior.time_capsule_tracks)}</article>` : ""}
    </section>

    ${view.behavior.artist_relationships.length > 0 || view.behavior.year_transitions.length > 0 ? `<section class="section" id="continuity">
      <div class="section-heading"><h2>What stayed. What changed.</h2><p>Cross-year appearances show continuity in this retained archive. Top-artist turnover compares listening-time rankings between retained UTC years without turning either pattern into a personality claim.</p></div>
      <div class="two-column continuity-grid">
        <article class="panel"><span class="panel-label">Present in the latest retained year</span><h3>Artists across eras</h3><p class="panel-intro">Each artist appears in at least ${escapeHtml(number(context.relationship_minimum_years ?? 2))} retained years and is still present in the latest retained year.</p>${artistRelationshipRows(view.behavior.artist_relationships)}</article>
        <article class="panel"><span class="panel-label">Listening-time top sets</span><h3>Year-to-year turnover</h3><p class="panel-intro">Each comparison asks how many of the later year's top ${escapeHtml(number(context.continuity_artist_limit ?? 10))} artists also ranked in the preceding retained year.</p>${yearTransitionRows(view.behavior.year_transitions, context.continuity_artist_limit ?? 10)}</article>
      </div>
    </section>` : ""}

    ${hasListeningPatterns ? `<section class="section pattern-section" id="listening-patterns">
      ${syntheticDemo ? '<p class="pattern-demo-chip">Fictional archive preview</p>' : ""}
      <div class="section-heading"><h2>The shape of a listening stretch</h2><p>Spotify Extended History can show how plays cluster, when the same track appears back to back, and which multi-track releases recur. These are bounded archive patterns, not claims about mood, routine, intention, liking, or album completion.</p></div>
      <div class="two-column pattern-grid">
        ${view.behavior.session_summary ? `<article class="panel session-panel"><span class="panel-label">${escapeHtml(number(view.behavior.session_summary.gap_minutes))}-minute gap method</span><h3>Approximate sessions</h3><p class="panel-intro">Track-stop timestamps are grouped until a longer gap begins a new listening stretch.</p>${sessionShape(view.behavior.session_summary)}</article>` : ""}
        ${view.behavior.back_to_back_tracks.length > 0 ? `<article class="panel" id="back-to-back"><span class="panel-label">At least ${escapeHtml(number(context.back_to_back_minimum_consecutive_plays ?? 2))} adjacent plays</span><h3>Played back to back</h3><p class="panel-intro">Each sequence uses adjacent non-skipped Spotify Extended History rows for the same track, with at least ${escapeHtml(number(context.back_to_back_minimum_played_seconds ?? 30))} seconds played per event and no gap over ${escapeHtml(number(context.back_to_back_maximum_gap_minutes ?? 30))} minutes. This does not prove repeat mode, intention, or liking.</p>${trackRows(view.behavior.back_to_back_tracks)}</article>` : ""}
        ${view.behavior.release_depth.length > 0 ? `<article class="panel"><span class="panel-label">At least ${escapeHtml(number(context.release_minimum_distinct_tracks ?? 3))} distinct tracks</span><h3>Records explored in depth</h3><p class="panel-intro">Artist and release metadata are paired so same-titled records from different artists stay separate.</p>${releaseDepthRows(view.behavior.release_depth)}</article>` : ""}
      </div>
    </section>` : ""}

    <section class="section" id="tracks-that-stay">
      <div class="section-heading"><h2>Tracks that stay, disappear, and return</h2><p>Repetition and listening time show familiarity and attention. Current rediscovery adds a recent quiet window, while historical returns mark long gaps followed by another retained play. None of these patterns proves permanent preference.</p></div>
      ${view.behavior.rediscovery_tracks.length > 0 ? `<article class="panel rediscovery-panel"><span class="panel-label">Quiet for at least ${escapeHtml(number(rediscoveryQuietDays))} days</span><h3>Worth another listen</h3><p class="panel-intro">Meaningful historical attention, no recent appearance, and no active listener or provider avoid signal. The quiet period is measured against the latest retained event, not today's date.</p>${trackRows(view.behavior.rediscovery_tracks)}</article>` : ""}
      ${view.behavior.historical_return_tracks.length > 0 ? `<article class="panel rediscovery-panel"><span class="panel-label">Gaps of at least ${escapeHtml(number(context.historical_return_minimum_gap_days ?? 180))} days</span><h3>Music that came back</h3><p class="panel-intro">Each track reappeared after one or more long gaps in retained effective history and clears the active avoid boundary. A return is recurrence in the archive, not proof of liking, nostalgia, or an intentional absence.</p>${trackRows(view.behavior.historical_return_tracks)}</article>` : ""}
      <div class="two-column">
        <article class="panel"><span class="panel-label">Lifetime return</span><h3>Tracks you come back to</h3>${trackRows(view.behavior.repeat_tracks)}</article>
        <article class="panel"><span class="panel-label">Current movement</span><h3>Recent tracks</h3>${trackRows(view.behavior.recent_tracks)}</article>
      </div>
    </section>

    ${listenerCorrectionCount > 0 ? `<section class="section" id="listener-corrections">
      <div class="section-heading"><h2>Your corrections</h2><p>These are your direct, retractable assertions. They outrank ambiguous behavioral and provider signals in the current projection without rewriting listening history.</p></div>
      <div class="two-column">
        <article class="panel"><span class="panel-label">Explicit current preference</span><h3>You said you like</h3>${correctionSignalList(view.deliberate.listener_preferences, "like")}</article>
        <article class="panel"><span class="panel-label">Explicit current boundary</span><h3>You said to avoid</h3>${correctionSignalList(view.deliberate.listener_avoids, "avoid")}</article>
      </div>
    </section>` : ""}

    ${profileEvidenceSection}

    <section class="section dark" id="playback-flow">
      <div class="section-heading"><h2>How your listening flows</h2><p>These fields describe sequence and playback controls only. Their categories can overlap, and none of them establishes taste, attention, satisfaction, or personality.</p></div>
      <div class="behavior-grid">
        ${behaviorCard(context.direct_selection_starts, context.start_reason_events, "Direct starts", "A provider start reason grouped as direct interaction, not proof of attention or preference.", "events with a recorded start reason")}
        ${behaviorCard(context.trackdone_starts, context.start_reason_events, "Continued playback", "Started because the previous track ended. This describes sequence flow, not passivity.", "events with a recorded start reason")}
        ${behaviorCard(context.trackdone_endings, context.end_reason_events, "Reached track end", "Spotify marked these events trackdone. This is not a universal completion guarantee.", "events with a recorded end reason")}
        ${behaviorCard(context.explicit_skips, context.skip_state_events, "Explicit skips", "Contextual navigation evidence, not a durable avoidance claim.", "events with supplied skip state")}
        ${behaviorCard(context.shuffle_events, context.shuffle_state_events, "Shuffle active", "Playback context that can explain sequence without judging preference.", "events with supplied shuffle state")}
        ${behaviorCard(context.offline_events, context.offline_state_events, "Offline playback", "Playback context only. It does not establish location, travel, or connection quality.", "events with supplied offline state")}
      </div>
      <p class="context-note">Percentages use only rows where Spotify supplied the corresponding field. ${escapeHtml(number(context.incognito_events_excluded))} incognito events were counted as excluded coverage and did not affect rankings.</p>
    </section>

    ${providerSection}

    <section class="section" id="interpretation-boundaries">
      <div class="section-heading"><h2>Read with boundaries</h2><p>Moondog keeps uncertainty visible so a beautiful summary does not harden weak evidence into a false identity.</p></div>
      <div class="limitations">${view.limitations.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</div>
    </section>

    <footer><span>Moondog tasteprint v1 / ${syntheticDemo ? "synthetic public demo" : "private local artifact"} / no network requests</span><span>Generated ${escapeHtml(view.generated_at)}</span></footer>
  </main>
</body>
</html>
`;
}

export function renderTasteprintCardHtml(profile, options = {}) {
  const view = createTasteprintView(profile, options);
  const syntheticDemo = view.synthetic_demo === true;
  const coverage = view.coverage;
  const recentWindow = view.behavior.context.recent_window_days ?? 90;
  const enduringArtists = view.behavior.enduring_artists.slice(0, 3);
  const recentArtists = view.behavior.recent_artists.slice(0, 2);
  const repeatTracks = view.behavior.repeat_tracks.slice(0, 2);
  const correctionCount =
    view.deliberate.listener_preferences.length +
    view.deliberate.listener_avoids.length;
  const rangeLabel = view.timeline.earliest && view.timeline.latest
    ? `${dateLabel(view.timeline.earliest)} to ${dateLabel(view.timeline.latest)}`
    : "Bounded local profile range";
  const topArtist = enduringArtists[0]?.name;
  const headline = topArtist
    ? `${topArtist} anchors your long arc.`
    : "Your listening, in orbit.";
  const boundary =
    view.limitations[0] ||
    "Listening history shows familiarity and context, not identity or preference by itself.";

  const artistItems = (items, { recent = false } = {}) =>
    items.length > 0
      ? `<ol class="artist-list">${items
          .map((item, index) => {
            const details = [
              listeningTime(item.listening_minutes),
              Number.isInteger(item.play_count)
                ? `${number(item.play_count)} events`
                : null,
              Number.isInteger(item.distinct_tracks)
                ? `${number(item.distinct_tracks)} tracks`
                : null,
            ].filter(Boolean);
            const relationship = recent
              ? Number.isInteger(item.long_arc_rank)
                ? `long arc #${item.long_arc_rank}`
                : "new to the recent orbit"
              : `long arc #${index + 1}`;
            return `<li><span class="rank">${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml([relationship, ...details].join(" / "))}</small></div></li>`;
          })
          .join("")}</ol>`
      : '<p class="empty-card">No bounded artist signal is available.</p>';

  const trackItems = repeatTracks.length > 0
    ? `<ol class="track-card-list">${repeatTracks
        .map((item, index) => {
          const details = [
            item.artist_credit,
            Number.isInteger(item.play_count)
              ? `${number(item.play_count)} returns`
              : null,
            listeningTime(item.listening_minutes),
          ].filter(Boolean);
          return `<li><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(details.join(" / "))}</small></div></li>`;
        })
        .join("")}</ol>`
    : '<p class="empty-card">No bounded repeat-track signal is available.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light">
  <title>${syntheticDemo ? "Moondog Synthetic Tasteprint Card Demo" : "Private Moondog Tasteprint Card"}</title>
  <style>
    :root {
      color: #1b1b19;
      background: #151514;
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    html { min-width: 320px; }

    body {
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 18% 12%, rgba(111, 140, 168, 0.18), transparent 28rem),
        #151514;
    }

    .taste-card {
      width: min(1200px, 100%);
      min-height: min(800px, calc(100vh - 40px));
      display: grid;
      grid-template-columns: minmax(310px, 0.9fr) minmax(0, 2.1fr);
      overflow: hidden;
      border: 1px solid #52504b;
      border-radius: 34px;
      background: #eee8de;
      box-shadow: 0 28px 80px rgba(0, 0, 0, 0.35);
    }

    .identity {
      position: relative;
      isolation: isolate;
      min-width: 0;
      overflow: hidden;
      padding: 42px 38px 36px;
      display: flex;
      flex-direction: column;
      color: #f5f1e9;
      background: #1b1b19;
    }

    .identity::before {
      position: absolute;
      z-index: -1;
      width: 500px;
      aspect-ratio: 1;
      left: -275px;
      top: 120px;
      border: 1px solid rgba(245, 241, 233, 0.24);
      border-radius: 50%;
      box-shadow:
        0 0 0 24px rgba(245, 241, 233, 0.035),
        0 0 0 62px rgba(245, 241, 233, 0.026),
        0 0 0 108px rgba(245, 241, 233, 0.018);
      content: "";
    }

    .identity::after {
      position: absolute;
      z-index: -1;
      width: 14px;
      height: 14px;
      left: 168px;
      top: 351px;
      border: 8px solid rgba(169, 191, 211, 0.22);
      border-radius: 50%;
      background: #a9bfd3;
      content: "";
    }

    .brand-row, .card-footer {
      display: flex;
      min-width: 0;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .brand-row span:last-child { color: #949089; }

    .card-kicker {
      margin: 140px 0 18px;
      color: #a9bfd3;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.17em;
      text-transform: uppercase;
    }

    h1, h2, .metric strong {
      font-family: Iowan Old Style, Baskerville, "Times New Roman", serif;
      font-weight: 650;
      letter-spacing: -0.04em;
    }

    h1 {
      max-width: 320px;
      margin: 0;
      overflow-wrap: anywhere;
      font-size: clamp(50px, 5.3vw, 72px);
      line-height: 0.92;
    }

    .span {
      margin: 22px 0 0;
      color: #bcb7af;
      font-size: 15px;
      line-height: 1.5;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 1px;
      margin-top: auto;
      border: 1px solid #42413d;
      border-radius: 16px;
      background: #42413d;
      overflow: hidden;
    }

    .metric {
      min-width: 0;
      padding: 15px 12px;
      background: #252522;
    }

    .metric strong {
      display: block;
      overflow-wrap: anywhere;
      color: #f5f1e9;
      font-size: 21px;
      line-height: 1;
    }

    .metric span {
      display: block;
      margin-top: 7px;
      color: #949089;
      font-size: 8px;
      font-weight: 800;
      letter-spacing: 0.11em;
      text-transform: uppercase;
    }

    .content {
      min-width: 0;
      padding: 34px 38px 28px;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: 18px;
      background:
        radial-gradient(circle at 100% 0%, rgba(255, 255, 255, 0.7), transparent 28rem),
        #eee8de;
    }

    .content-header {
      display: flex;
      min-width: 0;
      justify-content: space-between;
      gap: 24px;
      align-items: end;
      padding-bottom: 18px;
      border-bottom: 1px solid #c8bdaf;
    }

    .content-header p { margin: 0; }

    .content-title {
      color: #68625a;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .content-range {
      max-width: 360px;
      overflow-wrap: anywhere;
      font-size: 12px;
      font-weight: 750;
      text-align: right;
    }

    .long-arc h2 {
      margin: 0 0 12px;
      font-size: 34px;
      line-height: 1;
    }

    .artist-list, .track-card-list {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .long-arc .artist-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      border: 1px solid #c8bdaf;
      border-radius: 18px;
      overflow: hidden;
      background: rgba(248, 244, 237, 0.75);
    }

    .long-arc .artist-list li {
      min-width: 0;
      padding: 18px;
    }

    .long-arc .artist-list li + li { border-left: 1px solid #c8bdaf; }

    .artist-list li, .track-card-list li {
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr);
      gap: 10px;
    }

    .rank, .track-card-list > li > span {
      color: #6f8ca8;
      font: 800 10px ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .artist-list strong, .track-card-list strong {
      display: block;
      overflow-wrap: anywhere;
      font-size: 14px;
      line-height: 1.25;
    }

    .artist-list small, .track-card-list small {
      display: block;
      margin-top: 7px;
      overflow-wrap: anywhere;
      color: #68625a;
      font-size: 9px;
      line-height: 1.45;
    }

    .signal-grid {
      min-height: 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    .signal-panel {
      min-width: 0;
      padding: 22px;
      border: 1px solid #c8bdaf;
      border-radius: 20px;
      background: #f8f4ed;
    }

    .panel-label {
      display: block;
      margin-bottom: 8px;
      color: #6f8ca8;
      font-size: 9px;
      font-weight: 850;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .signal-panel h2 {
      margin: 0 0 20px;
      font-size: 29px;
      line-height: 1;
    }

    .signal-panel .artist-list li,
    .track-card-list li {
      padding: 13px 0;
      border-top: 1px solid #d8cec1;
    }

    .signal-panel .artist-list li:first-child,
    .track-card-list li:first-child {
      padding-top: 0;
      border-top: 0;
    }

    .boundary {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 14px;
      align-items: start;
      padding: 15px 17px;
      border: 1px solid #9f9384;
      border-radius: 16px;
      background: rgba(215, 227, 237, 0.56);
    }

    .boundary-mark {
      display: grid;
      width: 29px;
      height: 29px;
      place-items: center;
      border-radius: 50%;
      color: #f5f1e9;
      background: #1b1b19;
      font-size: 11px;
      font-weight: 850;
    }

    .boundary strong { display: block; margin-bottom: 4px; font-size: 12px; }
    .boundary p { margin: 0; color: #68625a; font-size: 10px; line-height: 1.45; }

    .direct-signal {
      display: inline-flex;
      margin-top: 8px;
      color: #4d6276;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .card-footer {
      padding-top: 2px;
      color: #777169;
      font-size: 8px;
    }

    .empty-card { margin: 0; color: #68625a; font-size: 11px; font-style: italic; }

    @media (max-width: 820px) {
      body { padding: 10px; place-items: start center; }
      .taste-card { min-height: 0; grid-template-columns: 1fr; border-radius: 22px; }
      .identity { min-height: 560px; padding: 30px 24px; }
      .identity::after { display: none; }
      .card-kicker { margin-top: 110px; }
      .content { padding: 28px 22px; }
    }

    @media (max-width: 560px) {
      .content-header { align-items: start; flex-direction: column; gap: 8px; }
      .content-range { text-align: left; }
      .long-arc .artist-list, .signal-grid { grid-template-columns: 1fr; }
      .long-arc .artist-list li + li { border-top: 1px solid #c8bdaf; border-left: 0; }
      .metrics { grid-template-columns: 1fr; }
      .metric { display: flex; justify-content: space-between; align-items: baseline; }
    }

    @media print {
      :root, body { background: white; }
      body { padding: 0; }
      .taste-card { width: 100%; min-height: 100vh; border-radius: 0; box-shadow: none; }
    }
  </style>
</head>
<body>
  <main class="taste-card" data-artifact="moondog-tasteprint-card/1">
    <section class="identity" aria-labelledby="card-title">
      <div class="brand-row"><span>Moondog</span><span>${syntheticDemo ? "Synthetic demo" : "Private recap"}</span></div>
      <p class="card-kicker">Tasteprint card / long arc</p>
      <h1 id="card-title">${escapeHtml(headline)}</h1>
      <p class="span">${escapeHtml(spanLabel(view.timeline.days))}, read from your bounded listening history.</p>
      <div class="metrics" aria-label="Listening coverage">
        <div class="metric"><strong>${escapeHtml(number(coverage.listening_hours))}</strong><span>hours</span></div>
        <div class="metric"><strong>${escapeHtml(number(coverage.listening_tracks))}</strong><span>tracks</span></div>
        <div class="metric"><strong>${escapeHtml(number(coverage.effective_listening_events))}</strong><span>events</span></div>
      </div>
    </section>

    <section class="content" aria-label="Tasteprint recap">
      <header class="content-header">
        <p class="content-title">${syntheticDemo ? "Fictional public profile" : "Private listening recap"}</p>
        <p class="content-range">${escapeHtml(rangeLabel)}</p>
      </header>

      <section class="long-arc" aria-labelledby="long-arc-title">
        <h2 id="long-arc-title">The artists that stay</h2>
        ${artistItems(enduringArtists)}
      </section>

      <div class="signal-grid">
        <section class="signal-panel" aria-labelledby="recent-title">
          <span class="panel-label">Last ${escapeHtml(number(recentWindow))} days</span>
          <h2 id="recent-title">Recent movement</h2>
          ${artistItems(recentArtists, { recent: true })}
        </section>
        <section class="signal-panel" aria-labelledby="tracks-title">
          <span class="panel-label">Lifetime return</span>
          <h2 id="tracks-title">Tracks you revisit</h2>
          ${trackItems}
        </section>
      </div>

      <div>
        <aside class="boundary" aria-label="Interpretation and privacy boundary">
          <span class="boundary-mark" aria-hidden="true">L</span>
          <div>
            <strong>${syntheticDemo ? "Synthetic public demo" : "Review before sharing"}</strong>
            <p>${syntheticDemo ? "Every artist, track, date, and aggregate on this card is fictional demonstration data." : "This card contains personal listening context. Review every visible artist, track, date, and aggregate before sharing."}</p>
            <p>${escapeHtml(boundary)}</p>
            ${correctionCount > 0 ? `<span class="direct-signal">${escapeHtml(number(correctionCount))} direct listener ${correctionCount === 1 ? "correction" : "corrections"} applied to the full profile</span>` : ""}
          </div>
        </aside>
        <footer class="card-footer"><span>Moondog tasteprint card v1</span><span>No scripts / no external assets / no network requests</span></footer>
      </div>
    </section>
  </main>
</body>
</html>
`;
}
