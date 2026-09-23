import { uuidV5 } from "../core/uuid-v5.mjs";
import { musicProviderLabel } from "./music-providers.mjs";

export const LISTENING_PROFILE_SCHEMA_VERSION = "listening-profile/1";
export const LISTENING_PROFILE_EVIDENCE_NAMESPACE =
  "5d9a8b8d-c66c-547f-98c2-c8a0559f56be";

const dayMs = 86_400_000;
const recentWindowDays = 90;
const rediscoveryMinimumPlays = 3;
const rediscoveryMinimumEngagedPlays = 2;
const rediscoveryMinimumPlayedMs = 10 * 60_000;
const historicalReturnMinimumGapDays = 180;
const historicalReturnMinimumPlays = 3;
const historicalReturnMinimumEngagedPlays = 3;
const historicalReturnMinimumPlayedMs = 10 * 60_000;
const timeCapsuleMinimumYears = 2;
const timeCapsuleMinimumEngagedPlays = 2;
const timeCapsuleMinimumPlayedMs = 5 * 60_000;
const relationshipMinimumYears = 2;
const continuityArtistLimit = 10;
const releaseMinimumDistinctTracks = 3;
const sessionGapMinutes = 30;
const extendedSequenceMinimumPlays = 5;
const backToBackMinimumConsecutivePlays = 2;
const backToBackMinimumPlayedMs = 30_000;
const backToBackMaximumGapMinutes = 30;
const monthlyActivityMaximumMonths = 240;
const listeningSeasonMaximumSeasons = 80;
const spotifyExtendedHistorySystem = "spotify-extended-history";
const directStartReasons = new Set([
  "clickrow",
  "clickside",
  "playbtn",
  "remote",
  "search",
  "uriopen",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedText(value) {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function descendingTimestamp(left, right) {
  return lexicalCompare(right ?? "", left ?? "");
}

function minutes(milliseconds) {
  return Math.round(milliseconds / 60_000);
}

function hours(milliseconds) {
  return Math.round(milliseconds / 360_000) / 10;
}

function aggregateEvidenceId(subjectId, kind, key) {
  return uuidV5(
    `${subjectId}\0${kind}\0${key}`,
    LISTENING_PROFILE_EVIDENCE_NAMESPACE,
  );
}

function explanation({
  evidenceId,
  dimension,
  value,
  direction = "supports",
  basis,
  name,
  confidence,
  limitation,
}) {
  return {
    evidence_id: evidenceId,
    claim: { dimension, value, direction },
    basis_summary: basis,
    derivation: {
      kind: "deterministic_projection",
      name,
      version: LISTENING_PROFILE_SCHEMA_VERSION,
    },
    confidence,
    interpretation_limit: limitation,
  };
}

function confidenceForCount(count, floor = 0.55, ceiling = 0.95) {
  return Math.min(ceiling, floor + Math.log10(Math.max(1, count)) * 0.16);
}

function trackFields(track) {
  const title =
    typeof track?.title === "string" && track.title.trim()
      ? track.title.trim()
      : "Unknown track";
  const artist =
    Array.isArray(track?.artist_credits) &&
    typeof track.artist_credits[0]?.name === "string" &&
    track.artist_credits[0].name.trim()
      ? track.artist_credits[0].name.trim()
      : "Unknown artist";
  const release =
    typeof track?.release?.title === "string" && track.release.title.trim()
      ? track.release.title.trim()
      : null;
  return {
    trackRefId: track?.track_ref_id,
    identityStatus:
      track?.identity_status === "resolved" ? "resolved" : "provisional",
    title,
    artist,
    artistKnown: Boolean(track?.artist_credits?.[0]?.name?.trim()),
    release,
  };
}

function aggregateHistoryArc(rows) {
  const years = new Map();
  const firstObservedYearByTrack = new Map();

  for (const row of rows) {
    const occurredAt = row.event?.occurred_at;
    const yearText = typeof occurredAt === "string" ? occurredAt.slice(0, 4) : "";
    if (!/^\d{4}$/u.test(yearText)) continue;

    const year = Number(yearText);
    const metadata = trackFields(row.track);
    const currentFirstYear = firstObservedYearByTrack.get(metadata.trackRefId);
    if (currentFirstYear === undefined || year < currentFirstYear) {
      firstObservedYearByTrack.set(metadata.trackRefId, year);
    }

    const aggregate = years.get(year) ?? {
      eventCount: 0,
      playedMs: 0,
      trackRefs: new Set(),
      artists: new Map(),
    };
    aggregate.eventCount += 1;
    aggregate.playedMs += row.playedMs;
    aggregate.trackRefs.add(metadata.trackRefId);

    const artistKey = normalizedText(metadata.artist);
    const artist = aggregate.artists.get(artistKey) ?? {
      name: metadata.artist,
      playCount: 0,
      playedMs: 0,
    };
    artist.playCount += 1;
    artist.playedMs += row.playedMs;
    if (metadata.artistKnown) aggregate.artists.set(artistKey, artist);
    years.set(year, aggregate);
  }

  return [...years.entries()]
    .sort(([left], [right]) => left - right)
    .map(([year, aggregate]) => {
      const topArtist = [...aggregate.artists.values()].sort((left, right) => {
        if (right.playedMs !== left.playedMs) return right.playedMs - left.playedMs;
        if (right.playCount !== left.playCount) return right.playCount - left.playCount;
        return lexicalCompare(left.name, right.name);
      })[0];
      const firstObservedTracks = [...aggregate.trackRefs].filter(
        (trackRefId) => firstObservedYearByTrack.get(trackRefId) === year,
      ).length;

      return {
        year,
        event_count: aggregate.eventCount,
        listening_minutes: minutes(aggregate.playedMs),
        distinct_tracks: aggregate.trackRefs.size,
        first_observed_tracks: firstObservedTracks,
        ...(topArtist
          ? {
              top_artist: {
                name: topArtist.name,
                play_count: topArtist.playCount,
                listening_minutes: minutes(topArtist.playedMs),
              },
            }
          : {}),
      };
    });
}

function monthIndex(monthKey) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(monthKey)) return null;
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return null;
  return year * 12 + month - 1;
}

function monthKey(index) {
  const year = Math.floor(index / 12);
  const month = index % 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function seasonIndexForMonth(index) {
  return Math.floor(index / 3);
}

function seasonKey(index) {
  const year = Math.floor(index / 4);
  const quarter = index % 4 + 1;
  return `${String(year).padStart(4, "0")}-Q${quarter}`;
}

function aggregateListeningSeasons(subjectId, eventAnalysis, explanations) {
  const retainedFirstMonth = eventAnalysis.earliest?.slice(0, 7) ?? "";
  const retainedLastMonth = eventAnalysis.latest?.slice(0, 7) ?? "";
  const retainedFirstMonthIndex = monthIndex(retainedFirstMonth);
  const retainedLastMonthIndex = monthIndex(retainedLastMonth);
  if (
    retainedFirstMonthIndex === null ||
    retainedLastMonthIndex === null ||
    retainedFirstMonthIndex > retainedLastMonthIndex
  ) {
    return null;
  }

  const retainedFirstSeasonIndex = seasonIndexForMonth(
    retainedFirstMonthIndex,
  );
  const lastSeasonIndex = seasonIndexForMonth(retainedLastMonthIndex);
  const retainedSeasonCount =
    lastSeasonIndex - retainedFirstSeasonIndex + 1;
  const representedFirstSeasonIndex = Math.max(
    retainedFirstSeasonIndex,
    lastSeasonIndex - listeningSeasonMaximumSeasons + 1,
  );
  const firstObservedSeasonByTrack = new Map();
  const aggregates = new Map();

  for (const row of eventAnalysis.eligible) {
    const observedMonthIndex = monthIndex(
      row.event?.occurred_at?.slice(0, 7) ?? "",
    );
    if (observedMonthIndex === null) continue;
    const observedSeasonIndex = seasonIndexForMonth(observedMonthIndex);
    const metadata = trackFields(row.track);
    const trackKey =
      typeof metadata.trackRefId === "string" && metadata.trackRefId
        ? metadata.trackRefId
        : [metadata.title, metadata.artist, metadata.release ?? ""]
            .map(normalizedText)
            .join("\0");
    const firstObservedSeason = firstObservedSeasonByTrack.get(trackKey);
    if (
      firstObservedSeason === undefined ||
      observedSeasonIndex < firstObservedSeason
    ) {
      firstObservedSeasonByTrack.set(trackKey, observedSeasonIndex);
    }

    const aggregate = aggregates.get(observedSeasonIndex) ?? {
      eventCount: 0,
      engagedPlayCount: 0,
      playedMs: 0,
      activeMonths: new Set(),
      trackRefs: new Set(),
      artists: new Map(),
      tracks: new Map(),
    };
    aggregate.eventCount += 1;
    if (!row.skipped) aggregate.engagedPlayCount += 1;
    aggregate.playedMs += row.playedMs;
    aggregate.activeMonths.add(observedMonthIndex);
    aggregate.trackRefs.add(trackKey);

    const artistKey = normalizedText(metadata.artist);
    const artist = aggregate.artists.get(artistKey) ?? {
      name: metadata.artist,
      eventCount: 0,
      engagedPlayCount: 0,
      playedMs: 0,
      trackRefs: new Set(),
    };
    artist.eventCount += 1;
    if (!row.skipped) artist.engagedPlayCount += 1;
    artist.playedMs += row.playedMs;
    artist.trackRefs.add(trackKey);
    if (metadata.artistKnown) aggregate.artists.set(artistKey, artist);

    const track = aggregate.tracks.get(trackKey) ?? {
      ...metadata,
      trackKey,
      eventCount: 0,
      engagedPlayCount: 0,
      skippedCount: 0,
      playedMs: 0,
    };
    track.eventCount += 1;
    if (row.skipped) track.skippedCount += 1;
    else track.engagedPlayCount += 1;
    track.playedMs += row.playedMs;
    aggregate.tracks.set(trackKey, track);
    aggregates.set(observedSeasonIndex, aggregate);
  }

  const seasons = [];
  for (
    let index = representedFirstSeasonIndex;
    index <= lastSeasonIndex;
    index += 1
  ) {
    const aggregate = aggregates.get(index);
    const calendarFirstMonthIndex = index * 3;
    const calendarLastMonthIndex = calendarFirstMonthIndex + 2;
    const firstMonthIndex = Math.max(
      retainedFirstMonthIndex,
      calendarFirstMonthIndex,
    );
    const lastMonthIndex = Math.min(
      retainedLastMonthIndex,
      calendarLastMonthIndex,
    );
    const trackRefs = aggregate?.trackRefs ?? new Set();
    const firstObservedTracks = [...trackRefs].filter(
      (trackRef) => firstObservedSeasonByTrack.get(trackRef) === index,
    ).length;
    const leadingArtist = [...(aggregate?.artists.values() ?? [])].sort(
      (left, right) => {
        if (right.playedMs !== left.playedMs) {
          return right.playedMs - left.playedMs;
        }
        if (right.engagedPlayCount !== left.engagedPlayCount) {
          return right.engagedPlayCount - left.engagedPlayCount;
        }
        if (right.eventCount !== left.eventCount) {
          return right.eventCount - left.eventCount;
        }
        return lexicalCompare(left.name, right.name);
      },
    )[0];
    const signatureTrack = [...(aggregate?.tracks.values() ?? [])].sort(
      (left, right) => {
        if (right.playedMs !== left.playedMs) {
          return right.playedMs - left.playedMs;
        }
        if (right.engagedPlayCount !== left.engagedPlayCount) {
          return right.engagedPlayCount - left.engagedPlayCount;
        }
        if (right.eventCount !== left.eventCount) {
          return right.eventCount - left.eventCount;
        }
        const titleOrder = lexicalCompare(left.title, right.title);
        if (titleOrder !== 0) return titleOrder;
        const artistOrder = lexicalCompare(left.artist, right.artist);
        if (artistOrder !== 0) return artistOrder;
        return lexicalCompare(left.trackKey, right.trackKey);
      },
    )[0];

    seasons.push({
      key: seasonKey(index),
      start_month: monthKey(firstMonthIndex),
      end_month: monthKey(lastMonthIndex),
      retained_month_count: lastMonthIndex - firstMonthIndex + 1,
      active_month_count: aggregate?.activeMonths.size ?? 0,
      event_count: aggregate?.eventCount ?? 0,
      engaged_play_count: aggregate?.engagedPlayCount ?? 0,
      listening_minutes: minutes(aggregate?.playedMs ?? 0),
      distinct_tracks: trackRefs.size,
      first_observed_tracks: firstObservedTracks,
      returning_tracks: trackRefs.size - firstObservedTracks,
      ...(leadingArtist
        ? {
            leading_artist: {
              name: leadingArtist.name,
              event_count: leadingArtist.eventCount,
              engaged_play_count: leadingArtist.engagedPlayCount,
              listening_minutes: minutes(leadingArtist.playedMs),
              distinct_tracks: leadingArtist.trackRefs.size,
            },
          }
        : {}),
      ...(signatureTrack
        ? {
            signature_track: {
              track_ref_id: signatureTrack.trackRefId,
              label: signatureTrack.title,
              artist_credit: signatureTrack.artist,
              ...(signatureTrack.release
                ? { release: signatureTrack.release }
                : {}),
              play_count: signatureTrack.eventCount,
              engaged_play_count: signatureTrack.engagedPlayCount,
              listening_minutes: minutes(signatureTrack.playedMs),
              explicit_skips: signatureTrack.skippedCount,
            },
          }
        : {}),
    });
  }

  const activeSeasonCount = aggregates.size;
  const representedActiveSeasonCount = seasons.filter(
    (season) => season.event_count > 0,
  ).length;
  const evidenceId = aggregateEvidenceId(
    subjectId,
    "listening-seasons",
    `${seasonKey(retainedFirstSeasonIndex)}\0${seasonKey(lastSeasonIndex)}\0${eventAnalysis.eligible.length}`,
  );
  explanations.set(
    evidenceId,
    explanation({
      evidenceId,
      dimension: "listening.seasons",
      value: `${activeSeasonCount} active retained UTC calendar quarters`,
      basis: `${eventAnalysis.eligible.length} eligible effective events are grouped into ${activeSeasonCount} active fixed UTC calendar quarters from ${seasonKey(retainedFirstSeasonIndex)} through ${seasonKey(lastSeasonIndex)}. The bounded projection represents ${seasons.length} of ${retainedSeasonCount} quarters.`,
      name: "listening-seasons",
      confidence: confidenceForCount(eventAnalysis.eligible.length, 0.65, 0.95),
      limitation:
        "Listening Seasons are fixed three-month UTC windows. First observed means first appearance in retained eligible history, not discovery. Empty windows mean no retained eligible event appears there, not proof of no listening. A leading artist or signature track describes only that window and does not establish preference, mood, or a life event.",
    }),
  );

  return {
    timezone: "UTC",
    alignment: "calendar_quarter",
    season_length_months: 3,
    retained_first_season: seasonKey(retainedFirstSeasonIndex),
    represented_first_season: seasonKey(representedFirstSeasonIndex),
    last_season: seasonKey(lastSeasonIndex),
    retained_season_count: retainedSeasonCount,
    represented_season_count: seasons.length,
    active_season_count: activeSeasonCount,
    represented_active_season_count: representedActiveSeasonCount,
    omitted_earlier_season_count:
      representedFirstSeasonIndex - retainedFirstSeasonIndex,
    omitted_earlier_active_season_count:
      activeSeasonCount - representedActiveSeasonCount,
    seasons,
    evidence_id: evidenceId,
  };
}

function aggregateMonthlyActivity(subjectId, eventAnalysis, explanations) {
  const firstMonth = eventAnalysis.earliest?.slice(0, 7) ?? "";
  const lastMonth = eventAnalysis.latest?.slice(0, 7) ?? "";
  const firstIndex = monthIndex(firstMonth);
  const lastIndex = monthIndex(lastMonth);
  if (firstIndex === null || lastIndex === null || firstIndex > lastIndex) {
    return null;
  }

  const retainedSpanMonths = lastIndex - firstIndex + 1;
  const representedFirstIndex = Math.max(
    firstIndex,
    lastIndex - monthlyActivityMaximumMonths + 1,
  );
  const aggregates = new Map();
  for (const row of eventAnalysis.eligible) {
    const key = row.event?.occurred_at?.slice(0, 7) ?? "";
    const index = monthIndex(key);
    if (index === null || index < representedFirstIndex || index > lastIndex) {
      continue;
    }
    const aggregate = aggregates.get(key) ?? {
      eventCount: 0,
      engagedPlayCount: 0,
      playedMs: 0,
      trackRefs: new Set(),
    };
    aggregate.eventCount += 1;
    if (!row.skipped) aggregate.engagedPlayCount += 1;
    aggregate.playedMs += row.playedMs;
    const trackRefId = row.track?.track_ref_id;
    if (typeof trackRefId === "string" && trackRefId) {
      aggregate.trackRefs.add(trackRefId);
    }
    aggregates.set(key, aggregate);
  }

  const months = [];
  for (let index = representedFirstIndex; index <= lastIndex; index += 1) {
    const key = monthKey(index);
    const aggregate = aggregates.get(key);
    months.push({
      month: key,
      event_count: aggregate?.eventCount ?? 0,
      engaged_play_count: aggregate?.engagedPlayCount ?? 0,
      listening_minutes: minutes(aggregate?.playedMs ?? 0),
      distinct_tracks: aggregate?.trackRefs.size ?? 0,
    });
  }
  const activeMonths = months.filter((month) => month.event_count > 0);
  const peakListeningMinutes = months.reduce(
    (maximum, month) => Math.max(maximum, month.listening_minutes),
    0,
  );
  const evidenceId = aggregateEvidenceId(
    subjectId,
    "monthly-activity",
    `${firstMonth}\0${lastMonth}\0${eventAnalysis.eligible.length}`,
  );
  explanations.set(
    evidenceId,
    explanation({
      evidenceId,
      dimension: "listening.monthly_activity",
      value: `${activeMonths.length} active retained UTC months`,
      basis: `${eventAnalysis.eligible.length} eligible effective events are grouped into ${activeMonths.length} active retained UTC months from ${firstMonth} through ${lastMonth}. The bounded grid represents ${months.length} of ${retainedSpanMonths} calendar months in that span.`,
      name: "listening-monthly-activity",
      confidence: confidenceForCount(eventAnalysis.eligible.length, 0.65, 0.95),
      limitation:
        "Monthly activity is a UTC aggregate of retained eligible events. A blank month means no retained eligible event appears in that month, not proof that no listening occurred.",
    }),
  );
  return {
    timezone: "UTC",
    first_month: monthKey(representedFirstIndex),
    last_month: monthKey(lastIndex),
    retained_span_months: retainedSpanMonths,
    represented_month_count: months.length,
    active_month_count: activeMonths.length,
    omitted_earlier_month_count: representedFirstIndex - firstIndex,
    peak_listening_minutes: peakListeningMinutes,
    months,
    evidence_id: evidenceId,
  };
}

function aggregateEvents(subjectId, eventRows, explanations) {
  const eligible = [];
  let incognitoEventsExcluded = 0;
  let rawPlayedMs = 0;
  let eventsWithPlayedDuration = 0;
  for (const row of eventRows) {
    const event = row.event;
    const hasPlayedDuration = Number.isSafeInteger(event?.played_ms);
    const playedMs = hasPlayedDuration ? event.played_ms : 0;
    if (hasPlayedDuration) eventsWithPlayedDuration += 1;
    rawPlayedMs += playedMs;
    if (event?.extensions?.["spotify.incognito_mode"] === true) {
      incognitoEventsExcluded += 1;
      continue;
    }
    eligible.push({
      event,
      track: row.track,
      playedMs,
      skipped:
        event?.event_type === "play_skipped" ||
        event?.extensions?.["spotify.skipped"] === true,
    });
  }
  const earliest = eligible.reduce(
    (value, row) =>
      value === null || row.event.occurred_at < value
        ? row.event.occurred_at
        : value,
    null,
  );
  const latest = eligible.reduce(
    (value, row) =>
      value === null || row.event.occurred_at > value
        ? row.event.occurred_at
        : value,
    null,
  );
  const recentCutoff = latest
    ? new Date(Date.parse(latest) - recentWindowDays * dayMs).toISOString()
    : null;

  function aggregate(rows, windowKind) {
    const artists = new Map();
    const tracks = new Map();
    for (const row of rows) {
      const metadata = trackFields(row.track);
      const trackKey = metadata.trackRefId;
      const artistKey = normalizedText(metadata.artist);
      const occurredAt = row.event.occurred_at;
      const track = tracks.get(trackKey) ?? {
        ...metadata,
        playCount: 0,
        engagedPlayCount: 0,
        skippedCount: 0,
        playedMs: 0,
        firstPlayedAt: occurredAt,
        lastPlayedAt: occurredAt,
        engagedPlayedAt: [],
        years: new Map(),
      };
      track.playCount += 1;
      track.playedMs += row.playedMs;
      if (row.skipped) track.skippedCount += 1;
      else {
        track.engagedPlayCount += 1;
        track.engagedPlayedAt.push(occurredAt);
      }
      if (occurredAt < track.firstPlayedAt) track.firstPlayedAt = occurredAt;
      if (occurredAt > track.lastPlayedAt) track.lastPlayedAt = occurredAt;
      const year = Number(occurredAt.slice(0, 4));
      if (Number.isInteger(year)) {
        const yearAggregate = track.years.get(year) ?? {
          playCount: 0,
          engagedPlayCount: 0,
          skippedCount: 0,
          playedMs: 0,
        };
        yearAggregate.playCount += 1;
        yearAggregate.playedMs += row.playedMs;
        if (row.skipped) yearAggregate.skippedCount += 1;
        else yearAggregate.engagedPlayCount += 1;
        track.years.set(year, yearAggregate);
      }
      tracks.set(trackKey, track);

      const artist = artists.get(artistKey) ?? {
        name: metadata.artist,
        playCount: 0,
        engagedPlayCount: 0,
        skippedCount: 0,
        playedMs: 0,
        trackRefs: new Set(),
        years: new Map(),
        firstPlayedAt: occurredAt,
        lastPlayedAt: occurredAt,
      };
      artist.playCount += 1;
      artist.playedMs += row.playedMs;
      if (row.skipped) artist.skippedCount += 1;
      else artist.engagedPlayCount += 1;
      artist.trackRefs.add(trackKey);
      if (Number.isInteger(year)) {
        const artistYear = artist.years.get(year) ?? {
          playCount: 0,
          playedMs: 0,
        };
        artistYear.playCount += 1;
        artistYear.playedMs += row.playedMs;
        artist.years.set(year, artistYear);
      }
      if (occurredAt < artist.firstPlayedAt) artist.firstPlayedAt = occurredAt;
      if (occurredAt > artist.lastPlayedAt) artist.lastPlayedAt = occurredAt;
      if (metadata.artistKnown) artists.set(artistKey, artist);
    }

    const rankedArtists = [...artists.entries()]
      .sort(([, left], [, right]) => {
        if (right.playedMs !== left.playedMs) return right.playedMs - left.playedMs;
        if (right.engagedPlayCount !== left.engagedPlayCount) {
          return right.engagedPlayCount - left.engagedPlayCount;
        }
        return lexicalCompare(left.name, right.name);
      })
      .map(([key, item]) => {
        const evidenceId = aggregateEvidenceId(
          subjectId,
          `artist-${windowKind}`,
          `${key}\0${windowKind === "recent" ? latest : "lifetime"}`,
        );
        explanations.set(
          evidenceId,
          explanation({
            evidenceId,
            dimension: "taste.artist_familiarity",
            value: item.name,
            basis: `${item.playCount} effective plays across ${item.trackRefs.size} tracks, totaling ${minutes(item.playedMs)} listening minutes${windowKind === "recent" ? ` in the ${recentWindowDays}-day window ending ${latest}` : ` from ${item.firstPlayedAt} through ${item.lastPlayedAt}`}.`,
            name: `listening-artist-${windowKind}`,
            confidence: confidenceForCount(item.playCount),
            limitation:
              "Repeated or long listening supports familiarity and attention, not a permanent preference. Explicit skips remain contextual.",
          }),
        );
        return {
          name: item.name,
          play_count: item.playCount,
          engaged_play_count: item.engagedPlayCount,
          listening_minutes: minutes(item.playedMs),
          distinct_tracks: item.trackRefs.size,
          explicit_skips: item.skippedCount,
          last_played_at: item.lastPlayedAt,
          evidence_id: evidenceId,
        };
      });

    const rankedTracks = [...tracks.values()]
      .sort((left, right) => {
        if (right.playedMs !== left.playedMs) return right.playedMs - left.playedMs;
        if (right.engagedPlayCount !== left.engagedPlayCount) {
          return right.engagedPlayCount - left.engagedPlayCount;
        }
        const titleOrder = lexicalCompare(left.title, right.title);
        return titleOrder || lexicalCompare(left.artist, right.artist);
      })
      .map((item) => {
        const evidenceId = aggregateEvidenceId(
          subjectId,
          `track-${windowKind}`,
          `${item.trackRefId}\0${windowKind === "recent" ? latest : "lifetime"}`,
        );
        explanations.set(
          evidenceId,
          explanation({
            evidenceId,
            dimension: "taste.track_familiarity",
            value: `${item.title} - ${item.artist}`,
            basis: `${item.playCount} effective plays totaling ${minutes(item.playedMs)} listening minutes${windowKind === "recent" ? ` in the ${recentWindowDays}-day window ending ${latest}` : ` from ${item.firstPlayedAt} through ${item.lastPlayedAt}`}; ${item.skippedCount} events carry an explicit provider skip signal.`,
            name: `listening-track-${windowKind}`,
            confidence: confidenceForCount(item.playCount),
            limitation:
              "This is behavioral familiarity evidence. Listening duration and repeats do not by themselves prove liking.",
          }),
        );
        return {
          track_ref_id: item.trackRefId,
          label: item.title,
          artist_credit: item.artist,
          ...(item.release ? { release: item.release } : {}),
          identity_status: item.identityStatus,
          play_count: item.playCount,
          engaged_play_count: item.engagedPlayCount,
          listening_minutes: minutes(item.playedMs),
          explicit_skips: item.skippedCount,
          last_played_at: item.lastPlayedAt,
          evidence_id: evidenceId,
        };
      });
    return { artists, tracks, rankedArtists, rankedTracks };
  }

  const lifetime = aggregate(eligible, "lifetime");
  const recent = aggregate(
    recentCutoff
      ? eligible.filter((row) => row.event.occurred_at >= recentCutoff)
      : [],
    "recent",
  );
  const historyArc = aggregateHistoryArc(eligible);
  const rowsWithStartReason = eligible
    .map((row) => ({
      row,
      reason: row.event.extensions?.["spotify.reason_start"],
    }))
    .filter(({ reason }) => typeof reason === "string" && reason.trim());
  const rowsWithEndReason = eligible
    .map((row) => ({
      row,
      reason: row.event.extensions?.["spotify.reason_end"],
    }))
    .filter(({ reason }) => typeof reason === "string" && reason.trim());
  const rowsWithSkipState = eligible.filter(
    (row) => typeof row.event.extensions?.["spotify.skipped"] === "boolean",
  );
  const rowsWithShuffleState = eligible.filter(
    (row) => typeof row.event.extensions?.["spotify.shuffle"] === "boolean",
  );
  const rowsWithOfflineState = eligible.filter(
    (row) => typeof row.event.extensions?.["spotify.offline"] === "boolean",
  );
  const context = {
    reference_date: latest,
    recent_window_days: recentWindowDays,
    effective_events_profiled: eligible.length,
    start_reason_events: rowsWithStartReason.length,
    direct_selection_starts: rowsWithStartReason.filter(({ reason }) =>
      directStartReasons.has(normalizedText(reason.trim())),
    ).length,
    trackdone_starts: rowsWithStartReason.filter(
      ({ reason }) => normalizedText(reason.trim()) === "trackdone",
    ).length,
    end_reason_events: rowsWithEndReason.length,
    trackdone_endings: rowsWithEndReason.filter(
      ({ reason }) => normalizedText(reason.trim()) === "trackdone",
    ).length,
    skip_state_events: rowsWithSkipState.length,
    explicit_skips: eligible.filter((row) => row.skipped).length,
    shuffle_state_events: rowsWithShuffleState.length,
    shuffle_events: rowsWithShuffleState.filter(
      (row) => row.event.extensions?.["spotify.shuffle"] === true,
    ).length,
    offline_state_events: rowsWithOfflineState.length,
    offline_events: rowsWithOfflineState.filter(
      (row) => row.event.extensions?.["spotify.offline"] === true,
    ).length,
    incognito_events_excluded: incognitoEventsExcluded,
  };
  return {
    eligible,
    earliest,
    latest,
    recentCutoff,
    rawPlayedMs,
    eventsWithPlayedDuration,
    profiledPlayedMs: eligible.reduce((sum, row) => sum + row.playedMs, 0),
    lifetime,
    recent,
    historyArc,
    context,
  };
}

function artistRelationships(subjectId, eventAnalysis, explanations) {
  const latestYear = Number(eventAnalysis.latest?.slice(0, 4));
  if (!Number.isInteger(latestYear)) return [];

  return [...eventAnalysis.lifetime.artists.values()]
    .map((artist) => {
      const years = [...artist.years.keys()].sort((left, right) => left - right);
      const firstYear = years[0];
      const lastYear = years.at(-1);
      if (
        years.length < relationshipMinimumYears ||
        lastYear !== latestYear
      ) {
        return null;
      }
      return {
        artist,
        firstYear,
        lastYear,
        activeYears: years.length,
        spanYears: lastYear - firstYear + 1,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.activeYears !== left.activeYears) {
        return right.activeYears - left.activeYears;
      }
      if (right.spanYears !== left.spanYears) {
        return right.spanYears - left.spanYears;
      }
      if (right.artist.playedMs !== left.artist.playedMs) {
        return right.artist.playedMs - left.artist.playedMs;
      }
      if (right.artist.playCount !== left.artist.playCount) {
        return right.artist.playCount - left.artist.playCount;
      }
      return lexicalCompare(left.artist.name, right.artist.name);
    })
    .map(({ artist, firstYear, lastYear, activeYears, spanYears }) => {
      const evidenceId = aggregateEvidenceId(
        subjectId,
        "artist-continuity",
        `${normalizedText(artist.name)}\0${firstYear}\0${lastYear}`,
      );
      explanations.set(
        evidenceId,
        explanation({
          evidenceId,
          dimension: "taste.artist_continuity",
          value: artist.name,
          basis: `${artist.name} appears in ${activeYears} retained UTC calendar years from ${firstYear} through ${lastYear}, across ${artist.playCount} effective plays and ${minutes(artist.playedMs)} listening minutes.`,
          name: "listening-artist-continuity",
          confidence: confidenceForCount(artist.playCount),
          limitation:
            "This describes continuity in retained history, not uninterrupted affinity, current preference, or the listener's identity.",
        }),
      );
      return {
        name: artist.name,
        first_year: firstYear,
        last_year: lastYear,
        active_years: activeYears,
        span_years: spanYears,
        play_count: artist.playCount,
        listening_minutes: minutes(artist.playedMs),
        evidence_id: evidenceId,
      };
    });
}

function yearlyArtistTransitions(subjectId, eventAnalysis, explanations) {
  const years = new Map();
  for (const row of eventAnalysis.eligible) {
    const year = Number(row.event?.occurred_at?.slice(0, 4));
    if (!Number.isInteger(year)) continue;
    const metadata = trackFields(row.track);
    if (!metadata.artistKnown) continue;
    const artistName = metadata.artist;
    const artistKey = normalizedText(artistName);
    const artists = years.get(year) ?? new Map();
    const artist = artists.get(artistKey) ?? {
      key: artistKey,
      name: artistName,
      playCount: 0,
      playedMs: 0,
    };
    artist.playCount += 1;
    artist.playedMs += row.playedMs;
    artists.set(artistKey, artist);
    years.set(year, artists);
  }

  const rankedYears = [...years.entries()]
    .sort(([left], [right]) => left - right)
    .map(([year, artists]) => ({
      year,
      artists: [...artists.values()]
        .sort((left, right) => {
          if (right.playedMs !== left.playedMs) {
            return right.playedMs - left.playedMs;
          }
          if (right.playCount !== left.playCount) {
            return right.playCount - left.playCount;
          }
          return lexicalCompare(left.name, right.name);
        })
        .slice(0, continuityArtistLimit),
    }));

  return rankedYears.slice(1).map((current, index) => {
    const previous = rankedYears[index];
    const previousKeys = new Set(previous.artists.map((artist) => artist.key));
    const retained = current.artists.filter((artist) =>
      previousKeys.has(artist.key),
    );
    const introduced = current.artists.filter(
      (artist) => !previousKeys.has(artist.key),
    );
    const continuityPercent = current.artists.length > 0
      ? Math.round((retained.length / current.artists.length) * 1_000) / 10
      : 0;
    const evidenceId = aggregateEvidenceId(
      subjectId,
      "artist-turnover",
      `${previous.year}\0${current.year}\0${continuityArtistLimit}`,
    );
    explanations.set(
      evidenceId,
      explanation({
        evidenceId,
        dimension: "taste.artist_turnover",
        value: `${previous.year} to ${current.year}`,
        basis: `Among the ${current.artists.length} artists with the most retained listening time in ${current.year}, ${retained.length} also ranked in ${previous.year} and ${introduced.length} did not.`,
        name: "listening-yearly-artist-turnover",
        confidence: confidenceForCount(
          Math.min(previous.artists.length, current.artists.length),
        ),
        limitation:
          "Year-to-year top-artist overlap describes this retained archive. It does not measure genre breadth, discovery, identity, or permanent taste change.",
      }),
    );
    return {
      from_year: previous.year,
      to_year: current.year,
      artist_limit: continuityArtistLimit,
      from_artist_count: previous.artists.length,
      to_artist_count: current.artists.length,
      retained_artist_count: retained.length,
      new_artist_count: introduced.length,
      continuity_percent: continuityPercent,
      retained_artists: retained.map((artist) => artist.name),
      new_artists: introduced.map((artist) => artist.name),
      evidence_id: evidenceId,
    };
  });
}

function releaseDepth(subjectId, eventAnalysis, explanations) {
  const releases = new Map();
  for (const row of eventAnalysis.eligible) {
    const metadata = trackFields(row.track);
    if (!metadata.release || typeof metadata.trackRefId !== "string") continue;
    const key = `${normalizedText(metadata.artist)}\0${normalizedText(metadata.release)}`;
    const occurredAt = row.event?.occurred_at;
    const year = Number(occurredAt?.slice(0, 4));
    const release = releases.get(key) ?? {
      title: metadata.release,
      artist: metadata.artist,
      trackRefs: new Set(),
      playCount: 0,
      engagedPlayCount: 0,
      playedMs: 0,
      years: new Set(),
    };
    release.trackRefs.add(metadata.trackRefId);
    release.playCount += 1;
    if (!row.skipped) release.engagedPlayCount += 1;
    release.playedMs += row.playedMs;
    if (Number.isInteger(year)) release.years.add(year);
    releases.set(key, release);
  }

  return [...releases.entries()]
    .filter(([, release]) =>
      release.trackRefs.size >= releaseMinimumDistinctTracks,
    )
    .sort(([, left], [, right]) => {
      if (right.playedMs !== left.playedMs) {
        return right.playedMs - left.playedMs;
      }
      if (right.trackRefs.size !== left.trackRefs.size) {
        return right.trackRefs.size - left.trackRefs.size;
      }
      if (right.engagedPlayCount !== left.engagedPlayCount) {
        return right.engagedPlayCount - left.engagedPlayCount;
      }
      const artistOrder = lexicalCompare(left.artist, right.artist);
      return artistOrder || lexicalCompare(left.title, right.title);
    })
    .map(([key, release]) => {
      const years = [...release.years].sort((left, right) => left - right);
      const firstYear = years[0];
      const lastYear = years.at(-1);
      const evidenceId = aggregateEvidenceId(
        subjectId,
        "release-depth",
        `${key}\0${firstYear ?? "unknown"}\0${lastYear ?? "unknown"}`,
      );
      explanations.set(
        evidenceId,
        explanation({
          evidenceId,
          dimension: "taste.release_depth",
          value: `${release.title} - ${release.artist}`,
          basis: `${release.trackRefs.size} distinct retained tracks from ${release.title} appear across ${release.playCount} effective plays totaling ${minutes(release.playedMs)} listening minutes${years.length > 0 ? ` in ${years.length} UTC calendar ${years.length === 1 ? "year" : "years"}` : ""}.`,
          name: "listening-release-depth",
          confidence: confidenceForCount(release.engagedPlayCount),
          limitation:
            "Multi-track listening describes release-level depth in retained history. It does not prove full-album listening, track order, completion, ownership, or liking.",
        }),
      );
      return {
        title: release.title,
        artist_credit: release.artist,
        distinct_tracks: release.trackRefs.size,
        play_count: release.playCount,
        engaged_play_count: release.engagedPlayCount,
        listening_minutes: minutes(release.playedMs),
        ...(Number.isInteger(firstYear) ? { first_year: firstYear } : {}),
        ...(Number.isInteger(lastYear) ? { last_year: lastYear } : {}),
        active_years: years.length,
        evidence_id: evidenceId,
      };
    });
}

function median(values) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const value = ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
  return Math.round(value * 10) / 10;
}

function listeningSessionSummary(subjectId, eventAnalysis, explanations) {
  const rows = eventAnalysis.eligible
    .filter(
      (row) =>
        row.event?.provenance?.external_ref?.system ===
        spotifyExtendedHistorySystem,
    )
    .sort((left, right) => {
      const timeOrder = lexicalCompare(
        left.event.occurred_at,
        right.event.occurred_at,
      );
      if (timeOrder) return timeOrder;
      return lexicalCompare(
        String(left.track?.track_ref_id ?? ""),
        String(right.track?.track_ref_id ?? ""),
      );
    });
  if (rows.length === 0) return null;

  const sessions = [];
  let current = [];
  for (const row of rows) {
    const previous = current.at(-1);
    const gap = previous
      ? Date.parse(row.event.occurred_at) -
        Date.parse(previous.event.occurred_at)
      : 0;
    if (previous && gap > sessionGapMinutes * 60_000) {
      sessions.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) sessions.push(current);

  const sessionPlayCounts = sessions.map((session) => session.length);
  const sessionListeningMinutes = sessions.map((session) =>
    minutes(session.reduce((sum, row) => sum + row.playedMs, 0)),
  );
  const singlePlaySessions = sessionPlayCounts.filter(
    (count) => count === 1,
  ).length;
  const shortSequenceSessions = sessionPlayCounts.filter(
    (count) => count >= 2 && count < extendedSequenceMinimumPlays,
  ).length;
  const extendedSequenceSessions = sessionPlayCounts.filter(
    (count) => count >= extendedSequenceMinimumPlays,
  ).length;
  const extendedSequencePercent = Math.round(
    (extendedSequenceSessions / sessions.length) * 1_000,
  ) / 10;
  const evidenceId = aggregateEvidenceId(
    subjectId,
    "listening-session-shape",
    `${rows[0].event.occurred_at}\0${rows.at(-1).event.occurred_at}\0${rows.length}\0${sessionGapMinutes}`,
  );
  explanations.set(
    evidenceId,
    explanation({
      evidenceId,
      dimension: "listening.session_shape",
      value: `${sessions.length} approximate listening sessions`,
      basis: `${rows.length} eligible Spotify Extended History events form ${sessions.length} approximate sessions when a gap longer than ${sessionGapMinutes} minutes starts a new session. The median session contains ${median(sessionPlayCounts)} plays and ${median(sessionListeningMinutes)} listening minutes.`,
      name: "listening-session-shape",
      confidence: confidenceForCount(rows.length),
      limitation:
        "This is an approximation from UTC track-stop timestamps, not a provider session log. It does not establish activity, attention, mood, location, or intent.",
    }),
  );
  return {
    source: "spotify_extended_history",
    method: "track_stop_gap",
    gap_minutes: sessionGapMinutes,
    event_count: rows.length,
    session_count: sessions.length,
    median_plays: median(sessionPlayCounts),
    median_listening_minutes: median(sessionListeningMinutes),
    single_play_sessions: singlePlaySessions,
    short_sequence_sessions: shortSequenceSessions,
    extended_sequence_sessions: extendedSequenceSessions,
    extended_sequence_minimum_plays: extendedSequenceMinimumPlays,
    extended_sequence_percent: extendedSequencePercent,
    evidence_id: evidenceId,
  };
}

function backToBackTracks(
  subjectId,
  eventAnalysis,
  evidence,
  direct,
  explanations,
) {
  const rows = eventAnalysis.eligible
    .filter(
      (row) =>
        row.event?.provenance?.external_ref?.system ===
        spotifyExtendedHistorySystem,
    )
    .sort((left, right) => {
      const timeOrder = lexicalCompare(
        left.event.occurred_at,
        right.event.occurred_at,
      );
      if (timeOrder) return timeOrder;
      return lexicalCompare(
        String(left.event?.listening_event_id ?? ""),
        String(right.event?.listening_event_id ?? ""),
      );
    });
  const bursts = [];
  let current = [];
  for (const row of rows) {
    const occurredAtMs = Date.parse(row.event?.occurred_at ?? "");
    const metadata = trackFields(row.track);
    const eligible =
      Number.isFinite(occurredAtMs) &&
      typeof metadata.trackRefId === "string" &&
      !row.skipped &&
      row.playedMs >= backToBackMinimumPlayedMs;
    const previous = current.at(-1);
    const previousMs = previous
      ? Date.parse(previous.event.occurred_at)
      : Number.NaN;
    const gapMs = occurredAtMs - previousMs;
    const continues =
      previous &&
      eligible &&
      metadata.trackRefId === trackFields(previous.track).trackRefId &&
      gapMs >= 0 &&
      gapMs <= backToBackMaximumGapMinutes * 60_000;
    if (continues) {
      current.push(row);
      continue;
    }
    if (current.length >= backToBackMinimumConsecutivePlays) {
      bursts.push(current);
    }
    current = eligible ? [row] : [];
  }
  if (current.length >= backToBackMinimumConsecutivePlays) {
    bursts.push(current);
  }

  const byTrack = new Map();
  for (const burst of bursts) {
    const metadata = trackFields(burst[0].track);
    const burstListeningMs = burst.reduce(
      (sum, row) => sum + row.playedMs,
      0,
    );
    const latestBurstAt = burst.at(-1).event.occurred_at;
    const aggregate = byTrack.get(metadata.trackRefId) ?? {
      ...metadata,
      burstCount: 0,
      maximumConsecutivePlays: 0,
      playsInBursts: 0,
      listeningMsInBursts: 0,
      latestBurstAt,
    };
    aggregate.burstCount += 1;
    aggregate.maximumConsecutivePlays = Math.max(
      aggregate.maximumConsecutivePlays,
      burst.length,
    );
    aggregate.playsInBursts += burst.length;
    aggregate.listeningMsInBursts += burstListeningMs;
    if (latestBurstAt > aggregate.latestBurstAt) {
      aggregate.latestBurstAt = latestBurstAt;
    }
    byTrack.set(metadata.trackRefId, aggregate);
  }

  const avoids = combinedAvoids(direct.avoids, evidence.avoids);
  return [...byTrack.values()]
    .filter(
      (item) => !avoids.some((avoid) => assertionMatchesTrack(avoid, item)),
    )
    .sort((left, right) => {
      if (
        right.maximumConsecutivePlays !== left.maximumConsecutivePlays
      ) {
        return (
          right.maximumConsecutivePlays - left.maximumConsecutivePlays
        );
      }
      if (right.burstCount !== left.burstCount) {
        return right.burstCount - left.burstCount;
      }
      if (right.playsInBursts !== left.playsInBursts) {
        return right.playsInBursts - left.playsInBursts;
      }
      if (right.listeningMsInBursts !== left.listeningMsInBursts) {
        return right.listeningMsInBursts - left.listeningMsInBursts;
      }
      const titleOrder = lexicalCompare(left.title, right.title);
      return titleOrder || lexicalCompare(left.artist, right.artist);
    })
    .map((item) => {
      const lifetime = eventAnalysis.lifetime.tracks.get(item.trackRefId);
      const evidenceId = aggregateEvidenceId(
        subjectId,
        "track-back-to-back",
        `${item.trackRefId}\0${item.burstCount}\0${item.maximumConsecutivePlays}\0${item.latestBurstAt}`,
      );
      explanations.set(
        evidenceId,
        explanation({
          evidenceId,
          dimension: "listening.back_to_back",
          value: `${item.title} - ${item.artist}`,
          basis: `${item.playsInBursts} retained plays form ${item.burstCount} adjacent same-track ${item.burstCount === 1 ? "sequence" : "sequences"}; the longest contains ${item.maximumConsecutivePlays} consecutive plays. Every counted event is a non-skipped Spotify Extended History row with at least ${backToBackMinimumPlayedMs / 1_000} seconds played, and no adjacent gap exceeds ${backToBackMaximumGapMinutes} minutes.`,
          name: "listening-track-back-to-back",
          confidence: confidenceForCount(
            item.playsInBursts,
            0.58,
            0.9,
          ),
          limitation:
            "Adjacent same-track events describe retained playback sequence. They do not prove that repeat mode was active, that the replay was intentional, or that the listener liked the track.",
        }),
      );
      return {
        track_ref_id: item.trackRefId,
        label: item.title,
        artist_credit: item.artist,
        ...(item.release ? { release: item.release } : {}),
        identity_status: item.identityStatus,
        play_count: lifetime?.playCount ?? item.playsInBursts,
        engaged_play_count:
          lifetime?.engagedPlayCount ?? item.playsInBursts,
        explicit_skips: lifetime?.skippedCount ?? 0,
        burst_count: item.burstCount,
        maximum_consecutive_plays: item.maximumConsecutivePlays,
        plays_in_bursts: item.playsInBursts,
        listening_minutes_in_bursts: minutes(item.listeningMsInBursts),
        latest_burst_at: item.latestBurstAt,
        sequence_signal: "adjacent retained plays",
        evidence_id: evidenceId,
      };
    });
}

function deduplicateProfileEvidence(records) {
  const selected = new Map();
  for (const record of records) {
    const current = selected.get(record.evidence_key);
    const capturedAt = record.provenance?.captured_at ?? "";
    const currentCapturedAt = current?.provenance?.captured_at ?? "";
    if (
      !current ||
      capturedAt > currentCapturedAt ||
      (capturedAt === currentCapturedAt &&
        record.profile_evidence_id > current.profile_evidence_id)
    ) {
      selected.set(record.evidence_key, record);
    }
  }
  return [...selected.values()];
}

function persistedExplanation(record) {
  const provider = musicProviderLabel(record.provenance?.source_system);
  const label = record.entity?.label ?? "Unresolved provider entity";
  const attributes = record.attributes ?? {};
  const source = record.provenance?.source_member ?? "Spotify account data";
  const basisByKind = {
    library_track_saved: `The track appears in the saved ${provider} library snapshot captured at ${record.provenance.captured_at}.`,
    library_album_saved: `The album appears in the saved ${provider} library snapshot captured at ${record.provenance.captured_at}.`,
    library_artist_followed: `The artist appears in the followed-artists snapshot captured at ${record.provenance.captured_at}.`,
    library_track_banned: `The track appears in the explicitly banned-tracks snapshot captured at ${record.provenance.captured_at}.`,
    library_artist_banned: `The artist appears in the explicitly banned-artists snapshot captured at ${record.provenance.captured_at}.`,
    playlist_track_added: `The track appears in the ${provider} playlist named ${JSON.stringify(attributes.playlist_name)} at position ${attributes.playlist_position}.` + (attributes.selected_public_playlist ? " You selected this public playlist; ownership and listening are not established." : ""),
    search_result_interacted: `A Spotify search for ${JSON.stringify(label)} led to an interaction with a ${attributes.result_entity_type} result at ${record.observed_at}.`,
    wrapped_track_ranked: `Spotify Wrapped ranked this track at position ${attributes.rank} for ${attributes.period}.`,
    wrapped_artist_ranked: `Spotify Wrapped ranked this artist at position ${attributes.rank} for ${attributes.period}.`,
    wrapped_album_ranked: `Spotify Wrapped ranked this album at position ${attributes.rank} for ${attributes.period}.`,
    wrapped_genre_ranked: `Spotify Wrapped ranked this genre concept at position ${attributes.rank} for ${attributes.period}.`,
    taste_artist_ranked: `Spotify's exported Taste Profile ranked this artist reference at position ${attributes.rank}.`,
    provider_interpretation: `Spotify supplied this provider-generated ${label.replaceAll("_", " ")} narrative in ${source}.`,
    sound_capsule_artist_ranked: `Spotify Sound Capsule ranked this artist at position ${attributes.rank} for ${attributes.period}.`,
    sound_capsule_track_ranked: `Spotify Sound Capsule ranked this track label at position ${attributes.rank} for ${attributes.period}.`,
    sound_capsule_highlight: `Spotify Sound Capsule emitted a ${attributes.highlight_type} highlight dated ${record.observed_at}.`,
    wrapped_metric: `Spotify Wrapped reported ${attributes.value} ${attributes.unit} for ${label} in ${attributes.period}.`,
    sound_capsule_period_metric: `Spotify Sound Capsule reported ${attributes.stream_count} streams and ${attributes.played_seconds} played seconds for ${attributes.period}.`,
  };
  const limitationByClass = {
    explicit:
      "This is an explicit current provider state, but the export does not include the original action timestamp.",
    curated:
      "Playlist inclusion is a curatorial signal, not proof of a permanent preference or the reason for inclusion.",
    behavioral:
      "The query and interacted result show bounded search intent, not durable preference.",
    provider_derived:
      "This is Spotify-generated interpretation or aggregation, not a direct user assertion or instruction.",
  };
  const dimensions = {
    library_track_saved: "taste.track_preference",
    library_album_saved: "taste.album_preference",
    library_artist_followed: "taste.artist_preference",
    library_track_banned: "taste.track_avoidance",
    library_artist_banned: "taste.artist_avoidance",
    playlist_track_added: "taste.track_curation",
    search_result_interacted: "intent.search",
    wrapped_track_ranked: "provider.track_rank",
    wrapped_artist_ranked: "provider.artist_rank",
    wrapped_album_ranked: "provider.album_rank",
    wrapped_genre_ranked: "provider.genre_rank",
    taste_artist_ranked: "provider.artist_rank",
    provider_interpretation: "provider.interpretation",
    sound_capsule_artist_ranked: "provider.artist_rank",
    sound_capsule_track_ranked: "provider.track_rank",
    sound_capsule_highlight: "provider.highlight",
    wrapped_metric: "provider.metric",
    sound_capsule_period_metric: "provider.metric",
  };
  const confidenceByClass = {
    explicit: 0.95,
    curated: 0.85,
    behavioral: 0.65,
    provider_derived: 0.5,
  };
  return explanation({
    evidenceId: record.profile_evidence_id,
    dimension: dimensions[record.evidence_kind] ?? "profile.context",
    value: label,
    direction: record.direction,
    basis: basisByKind[record.evidence_kind] ?? `The evidence came from ${source}.`,
    name: `${record.provenance.source_system}-${record.evidence_kind}`,
    confidence: confidenceByClass[record.strength_class] ?? 0.5,
    limitation:
      limitationByClass[record.strength_class] ??
      "This evidence must be interpreted within its provider-export context.",
  });
}

function evidenceGroups(records, eventAnalysis, explanations) {
  const byKind = new Map();
  for (const record of records) {
    const values = byKind.get(record.evidence_kind) ?? [];
    values.push(record);
    byKind.set(record.evidence_kind, values);
    explanations.set(record.profile_evidence_id, persistedExplanation(record));
  }
  const kind = (name) => byKind.get(name) ?? [];
  const trackMetrics = eventAnalysis.lifetime.tracks;
  const artistMetrics = eventAnalysis.lifetime.artists;

  const playlistGroups = new Map();
  for (const record of kind("playlist_track_added")) {
    const trackRefId = record.entity.track_ref_id;
    const group = playlistGroups.get(trackRefId) ?? {
      entity: record.entity,
      evidenceId: record.profile_evidence_id,
      playlists: new Set(),
      lastAddedAt: record.observed_at,
      sourceLabel: musicProviderLabel(record.provenance.source_system),
    };
    group.playlists.add(record.attributes.playlist_name);
    if (record.observed_at > group.lastAddedAt) {
      group.lastAddedAt = record.observed_at;
      group.evidenceId = record.profile_evidence_id;
    }
    playlistGroups.set(trackRefId, group);
  }

  const savedTracks = kind("library_track_saved")
    .map((record) => ({
      record,
      metric: trackMetrics.get(record.entity.track_ref_id),
    }))
    .sort((left, right) => {
      const duration = (right.metric?.playedMs ?? 0) - (left.metric?.playedMs ?? 0);
      if (duration) return duration;
      const playlists =
        (playlistGroups.get(right.record.entity.track_ref_id)?.playlists.size ?? 0) -
        (playlistGroups.get(left.record.entity.track_ref_id)?.playlists.size ?? 0);
      if (playlists) return playlists;
      return lexicalCompare(left.record.entity.label, right.record.entity.label);
    })
    .map(({ record, metric }) => ({
      track_ref_id: record.entity.track_ref_id,
      source_label: musicProviderLabel(record.provenance.source_system),
      label: record.entity.label,
      artist_credit: record.entity.artist_credit,
      ...(record.entity.release ? { release: record.entity.release } : {}),
      ...(metric ? { listening_minutes: minutes(metric.playedMs) } : {}),
      evidence_id: record.profile_evidence_id,
    }));

  const playlistAnchors = [...playlistGroups.values()]
    .sort((left, right) => {
      if (right.playlists.size !== left.playlists.size) {
        return right.playlists.size - left.playlists.size;
      }
      const duration =
        (trackMetrics.get(right.entity.track_ref_id)?.playedMs ?? 0) -
        (trackMetrics.get(left.entity.track_ref_id)?.playedMs ?? 0);
      if (duration) return duration;
      return lexicalCompare(left.entity.label, right.entity.label);
    })
    .map((group) => ({
      track_ref_id: group.entity.track_ref_id,
      source_label: group.sourceLabel,
      label: group.entity.label,
      artist_credit: group.entity.artist_credit,
      ...(group.entity.release ? { release: group.entity.release } : {}),
      playlist_count: group.playlists.size,
      playlist_names: [...group.playlists].sort(lexicalCompare).slice(0, 3),
      last_added_at: group.lastAddedAt,
      evidence_id: group.evidenceId,
    }));

  const followedArtists = kind("library_artist_followed")
    .map((record) => ({
      record,
      metric: artistMetrics.get(normalizedText(record.entity.label)),
    }))
    .sort((left, right) => {
      const duration = (right.metric?.playedMs ?? 0) - (left.metric?.playedMs ?? 0);
      return duration || lexicalCompare(left.record.entity.label, right.record.entity.label);
    })
    .map(({ record, metric }) => ({
      name: record.entity.label,
      ...(metric ? { listening_minutes: minutes(metric.playedMs) } : {}),
      evidence_id: record.profile_evidence_id,
    }));

  const savedAlbums = kind("library_album_saved")
    .sort((left, right) => lexicalCompare(left.entity.label, right.entity.label))
    .map((record) => ({
      label: record.entity.label,
      artist_credit: record.entity.artist_credit,
      evidence_id: record.profile_evidence_id,
    }));

  const avoids = [
    ...kind("library_track_banned"),
    ...kind("library_artist_banned"),
  ].map((record) => ({
    entity_type: record.entity.entity_type,
    label: record.entity.label,
    ...(record.entity.artist_credit
      ? { artist_credit: record.entity.artist_credit }
      : {}),
    evidence_id: record.profile_evidence_id,
  }));

  const searchGroups = new Map();
  for (const record of kind("search_result_interacted")) {
    const key = normalizedText(record.entity.label);
    const group = searchGroups.get(key) ?? {
      query: record.entity.label,
      interactions: 0,
      entityTypes: new Set(),
      lastSearchedAt: record.observed_at,
      evidenceId: record.profile_evidence_id,
    };
    group.interactions += 1;
    group.entityTypes.add(record.attributes.result_entity_type);
    if (record.observed_at > group.lastSearchedAt) {
      group.lastSearchedAt = record.observed_at;
      group.evidenceId = record.profile_evidence_id;
    }
    searchGroups.set(key, group);
  }
  const searches = [...searchGroups.values()]
    .sort((left, right) => {
      if (right.interactions !== left.interactions) {
        return right.interactions - left.interactions;
      }
      return descendingTimestamp(left.lastSearchedAt, right.lastSearchedAt);
    })
    .map((group) => ({
      query: group.query,
      quoted_data: true,
      interactions: group.interactions,
      result_entity_types: [...group.entityTypes].sort(lexicalCompare),
      last_searched_at: group.lastSearchedAt,
      evidence_id: group.evidenceId,
    }));

  const providerArtistKinds = new Set([
    "wrapped_artist_ranked",
    "taste_artist_ranked",
    "sound_capsule_artist_ranked",
  ]);
  const providerTrackKinds = new Set([
    "wrapped_track_ranked",
    "sound_capsule_track_ranked",
  ]);
  function providerRanked(kinds, outputType) {
    const groups = new Map();
    for (const record of records.filter((item) => kinds.has(item.evidence_kind))) {
      if (!record.entity.label) continue;
      const key = normalizedText(record.entity.label);
      const group = groups.get(key) ?? {
        label: record.entity.label,
        artistCredit: record.entity.artist_credit,
        bestRank: Number.MAX_SAFE_INTEGER,
        periods: new Set(),
        playedSeconds: 0,
        evidenceId: record.profile_evidence_id,
      };
      const rank = Number.isSafeInteger(record.attributes.rank)
        ? record.attributes.rank
        : Number.MAX_SAFE_INTEGER;
      if (rank < group.bestRank) {
        group.bestRank = rank;
        group.evidenceId = record.profile_evidence_id;
      }
      if (record.attributes.period) group.periods.add(record.attributes.period);
      if (Number.isSafeInteger(record.attributes.played_seconds)) {
        group.playedSeconds += record.attributes.played_seconds;
      }
      groups.set(key, group);
    }
    return [...groups.values()]
      .sort((left, right) => {
        if (right.playedSeconds !== left.playedSeconds) {
          return right.playedSeconds - left.playedSeconds;
        }
        if (left.bestRank !== right.bestRank) return left.bestRank - right.bestRank;
        return lexicalCompare(left.label, right.label);
      })
      .map((group) => ({
        ...(outputType === "artist"
          ? { name: group.label }
          : {
              label: group.label,
              ...(group.artistCredit
                ? { artist_credit: group.artistCredit }
                : {}),
            }),
        ...(group.bestRank < Number.MAX_SAFE_INTEGER
          ? { best_rank: group.bestRank }
          : {}),
        periods: [...group.periods].sort(lexicalCompare),
        ...(group.playedSeconds > 0
          ? { listening_minutes: minutes(group.playedSeconds * 1_000) }
          : {}),
        evidence_id: group.evidenceId,
      }));
  }

  const genres = kind("wrapped_genre_ranked")
    .filter((record) => record.entity.label)
    .sort((left, right) => left.attributes.rank - right.attributes.rank)
    .map((record) => ({
      name: record.entity.label,
      rank: record.attributes.rank,
      period: record.attributes.period,
      evidence_id: record.profile_evidence_id,
    }));
  const interpretations = kind("provider_interpretation").map((record) => ({
    kind: record.entity.label,
    text: record.attributes.text,
    quoted_data: true,
    evidence_id: record.profile_evidence_id,
  }));
  const highlights = kind("sound_capsule_highlight")
    .sort((left, right) => descendingTimestamp(left.observed_at, right.observed_at))
    .map((record) => ({
      kind: record.attributes.highlight_type,
      label: record.entity.label,
      ...(record.attributes.related_label
        ? { related_label: record.attributes.related_label }
        : {}),
      ...(record.attributes.metric_name
        ? {
            metric_name: record.attributes.metric_name,
            metric_value: record.attributes.metric_value,
          }
        : {}),
      observed_at: record.observed_at,
      evidence_id: record.profile_evidence_id,
    }));
  const metrics = [
    ...kind("wrapped_metric"),
    ...kind("sound_capsule_period_metric"),
  ].map((record) => ({
    name: record.entity.label,
    ...(record.attributes.value !== undefined
      ? { value: record.attributes.value, unit: record.attributes.unit }
      : {
          stream_count: record.attributes.stream_count,
          played_seconds: record.attributes.played_seconds,
        }),
    period: record.attributes.period,
    evidence_id: record.profile_evidence_id,
  }));

  return {
    byKind,
    savedTracks,
    playlistAnchors,
    followedArtists,
    savedAlbums,
    avoids,
    searches,
    providerArtists: providerRanked(providerArtistKinds, "artist"),
    providerTracks: providerRanked(providerTrackKinds, "track"),
    genres,
    interpretations,
    highlights,
    metrics,
  };
}

function slice(value, maximum) {
  return value.slice(0, maximum);
}

function listenerAssertions(subjectId, records, explanations) {
  const retracted = new Set(
    records
      .filter((record) => record?.operation === "retract")
      .map((record) => record.retracts_taste_event_id)
      .filter((value) => typeof value === "string"),
  );
  const superseded = new Set(
    records
      .filter((record) => record?.operation === "assert")
      .map((record) => record.supersedes_taste_event_id)
      .filter((value) => typeof value === "string"),
  );
  const assertions = records.filter(
    (record) =>
      record?.operation === "assert" &&
      record.subject_id?.toLowerCase() === subjectId &&
      !retracted.has(record.taste_event_id) &&
      !superseded.has(record.taste_event_id),
  );
  const items = assertions
    .sort((left, right) => {
      const time = descendingTimestamp(left.recorded_at, right.recorded_at);
      return time || lexicalCompare(right.taste_event_id, left.taste_event_id);
    })
    .map((record) => {
      const stance = record.signal_type === "avoidance" ? "avoid" : "like";
      const entityType = record.target?.entity_type;
      const label = record.target?.label;
      if (
        !new Set(["artist", "track"]).has(entityType) ||
        typeof label !== "string" ||
        !label.trim()
      ) {
        throw new TypeError("Stored listener correction target is invalid");
      }
      const artistCredit = record.extensions?.["moondog.artist_credit"];
      const value = artistCredit ? `${label} - ${artistCredit}` : label;
      explanations.set(
        record.taste_event_id,
        explanation({
          evidenceId: record.taste_event_id,
          dimension: `taste.${entityType}_${
            stance === "avoid" ? "avoidance" : "preference"
          }`,
          value,
          direction: "supports",
          basis: `The listener explicitly marked ${JSON.stringify(value)} as ${
            stance === "avoid" ? "something to avoid" : "something they like"
          } at ${record.occurred_at}.`,
          name: "explicit-listener-correction",
          confidence: 1,
          limitation:
            "This is a current direct listener assertion. It can be superseded or retracted and does not rewrite behavioral history.",
        }),
      );
      return {
        correction_id: record.taste_event_id,
        evidence_id: record.taste_event_id,
        entity_type: entityType,
        label: label.trim(),
        ...(typeof artistCredit === "string" && artistCredit.trim()
          ? { artist_credit: artistCredit.trim() }
          : {}),
        stance,
        strength: record.strength,
        asserted_at: record.occurred_at,
        ...(typeof record.note === "string" && record.note.trim()
          ? { note: record.note.trim() }
          : {}),
      };
    });
  return {
    active: items,
    preferences: items.filter((item) => item.stance === "like"),
    avoids: items.filter((item) => item.stance === "avoid"),
    total_assertions: records.filter((record) => record?.operation === "assert")
      .length,
    retractions: records.filter((record) => record?.operation === "retract")
      .length,
  };
}

function combinedAvoids(listenerAvoids, providerAvoids) {
  const selected = new Map();
  for (const item of [...listenerAvoids, ...providerAvoids]) {
    const key = [
      item.entity_type,
      normalizedText(item.label),
      normalizedText(item.artist_credit ?? ""),
    ].join("\0");
    if (!selected.has(key)) selected.set(key, item);
  }
  return [...selected.values()];
}

function assertionMatchesTrack(assertion, track) {
  if (assertion.entity_type === "artist") {
    return normalizedText(assertion.label) === normalizedText(track.artist);
  }
  if (assertion.entity_type !== "track") return false;
  if (normalizedText(assertion.label) !== normalizedText(track.title)) {
    return false;
  }
  return !assertion.artist_credit ||
    normalizedText(assertion.artist_credit) === normalizedText(track.artist);
}

function rediscoverySignal(track, evidence, direct) {
  if (direct.preferences.some((item) => assertionMatchesTrack(item, track))) {
    return { rank: 4, value: "explicit listener preference" };
  }
  if (
    evidence.savedTracks.some(
      (item) => item.track_ref_id === track.trackRefId,
    )
  ) {
    return { rank: 3, value: "saved-library state" };
  }
  if (
    evidence.playlistAnchors.some(
      (item) => item.track_ref_id === track.trackRefId,
    )
  ) {
    return { rank: 2, value: "private playlist curation" };
  }
  return { rank: 1, value: "historical attention only" };
}

function rediscoveryPeakYear(track) {
  return [...track.years.entries()]
    .sort(([leftYear, left], [rightYear, right]) => {
      if (right.playedMs !== left.playedMs) {
        return right.playedMs - left.playedMs;
      }
      if (right.playCount !== left.playCount) {
        return right.playCount - left.playCount;
      }
      return leftYear - rightYear;
    })
    .map(([year, aggregate]) => ({
      year,
      play_count: aggregate.playCount,
      engaged_play_count: aggregate.engagedPlayCount,
      explicit_skips: aggregate.skippedCount,
      listening_minutes: minutes(aggregate.playedMs),
      played_ms: aggregate.playedMs,
    }))[0] ?? null;
}

function rediscoveryTracks(
  subjectId,
  eventAnalysis,
  evidence,
  direct,
  explanations,
) {
  const latestMs = Date.parse(eventAnalysis.latest ?? "");
  if (!Number.isFinite(latestMs)) return [];
  const avoids = combinedAvoids(direct.avoids, evidence.avoids);
  return [...eventAnalysis.lifetime.tracks.values()]
    .map((track) => {
      const lastPlayedMs = Date.parse(track.lastPlayedAt);
      const quietDays = Math.floor((latestMs - lastPlayedMs) / dayMs);
      const signal = rediscoverySignal(track, evidence, direct);
      return {
        track,
        quietDays,
        signal,
        peak: rediscoveryPeakYear(track),
      };
    })
    .filter(
      ({ track, quietDays }) =>
        quietDays >= recentWindowDays &&
        track.playCount >= rediscoveryMinimumPlays &&
        track.engagedPlayCount >= rediscoveryMinimumEngagedPlays &&
        track.playedMs >= rediscoveryMinimumPlayedMs &&
        track.engagedPlayCount >= track.skippedCount &&
        !avoids.some((item) => assertionMatchesTrack(item, track)),
    )
    .sort((left, right) => {
      if (right.signal.rank !== left.signal.rank) {
        return right.signal.rank - left.signal.rank;
      }
      if (right.track.playedMs !== left.track.playedMs) {
        return right.track.playedMs - left.track.playedMs;
      }
      if (right.track.engagedPlayCount !== left.track.engagedPlayCount) {
        return right.track.engagedPlayCount - left.track.engagedPlayCount;
      }
      if (right.quietDays !== left.quietDays) {
        return right.quietDays - left.quietDays;
      }
      const titleOrder = lexicalCompare(left.track.title, right.track.title);
      return titleOrder || lexicalCompare(left.track.artist, right.track.artist);
    })
    .map(({ track, quietDays, signal, peak }) => {
      const evidenceId = aggregateEvidenceId(
        subjectId,
        "track-rediscovery",
        `${track.trackRefId}\0${eventAnalysis.latest}`,
      );
      explanations.set(
        evidenceId,
        explanation({
          evidenceId,
          dimension: "listening.rediscovery_candidate",
          value: `${track.title} - ${track.artist}`,
          basis: `${track.playCount} effective plays, ${track.engagedPlayCount} without an explicit skip signal, and ${minutes(track.playedMs)} listening minutes from ${track.firstPlayedAt} through ${track.lastPlayedAt}; the track has been quiet for ${quietDays} days relative to the latest retained event. Its strongest supporting signal is ${signal.value}.`,
          name: "listening-track-rediscovery",
          confidence:
            signal.rank === 4
              ? 0.95
              : confidenceForCount(track.engagedPlayCount, 0.58, 0.88),
          limitation:
            "This is a bounded listen-again prompt, not proof of liking or that the absence was intentional. Missing provider history can make the quiet period look longer than it was.",
        }),
      );
      return {
        track_ref_id: track.trackRefId,
        label: track.title,
        artist_credit: track.artist,
        ...(track.release ? { release: track.release } : {}),
        identity_status: track.identityStatus,
        play_count: track.playCount,
        engaged_play_count: track.engagedPlayCount,
        listening_minutes: minutes(track.playedMs),
        explicit_skips: track.skippedCount,
        first_played_at: track.firstPlayedAt,
        last_played_at: track.lastPlayedAt,
        quiet_days: quietDays,
        rediscovery_signal: signal.value,
        ...(peak
          ? {
              peak_year: peak.year,
              peak_year_play_count: peak.play_count,
              peak_year_listening_minutes: peak.listening_minutes,
            }
          : {}),
        evidence_id: evidenceId,
      };
    });
}

function historicalReturnGaps(track) {
  const timestamps = [...track.engagedPlayedAt]
    .map((value) => ({ value, milliseconds: Date.parse(value) }))
    .filter(({ milliseconds }) => Number.isFinite(milliseconds))
    .sort((left, right) => left.milliseconds - right.milliseconds);
  const returns = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const gapDays = Math.floor(
      (timestamps[index].milliseconds - timestamps[index - 1].milliseconds) /
        dayMs,
    );
    if (gapDays < historicalReturnMinimumGapDays) continue;
    returns.push({
      gap_days: gapDays,
      returned_at: timestamps[index].value,
    });
  }
  return returns;
}

function historicalReturnTracks(
  subjectId,
  eventAnalysis,
  evidence,
  direct,
  explanations,
) {
  const avoids = combinedAvoids(direct.avoids, evidence.avoids);
  return [...eventAnalysis.lifetime.tracks.values()]
    .map((track) => ({
      track,
      returns: historicalReturnGaps(track),
      signal: rediscoverySignal(track, evidence, direct),
    }))
    .filter(
      ({ track, returns }) =>
        returns.length > 0 &&
        track.playCount >= historicalReturnMinimumPlays &&
        track.engagedPlayCount >= historicalReturnMinimumEngagedPlays &&
        track.playedMs >= historicalReturnMinimumPlayedMs &&
        track.engagedPlayCount >= track.skippedCount &&
        !avoids.some((item) => assertionMatchesTrack(item, track)),
    )
    .sort((left, right) => {
      if (right.returns.length !== left.returns.length) {
        return right.returns.length - left.returns.length;
      }
      const leftLongest = Math.max(
        ...left.returns.map((item) => item.gap_days),
      );
      const rightLongest = Math.max(
        ...right.returns.map((item) => item.gap_days),
      );
      if (rightLongest !== leftLongest) return rightLongest - leftLongest;
      if (right.signal.rank !== left.signal.rank) {
        return right.signal.rank - left.signal.rank;
      }
      if (right.track.playedMs !== left.track.playedMs) {
        return right.track.playedMs - left.track.playedMs;
      }
      if (right.track.engagedPlayCount !== left.track.engagedPlayCount) {
        return right.track.engagedPlayCount - left.track.engagedPlayCount;
      }
      const titleOrder = lexicalCompare(left.track.title, right.track.title);
      return titleOrder || lexicalCompare(left.track.artist, right.track.artist);
    })
    .map(({ track, returns, signal }) => {
      const longestGapDays = Math.max(
        ...returns.map((item) => item.gap_days),
      );
      const latestReturn = returns.at(-1);
      const evidenceId = aggregateEvidenceId(
        subjectId,
        "track-historical-return",
        `${track.trackRefId}\0${returns.length}\0${longestGapDays}\0${latestReturn.returned_at}`,
      );
      explanations.set(
        evidenceId,
        explanation({
          evidenceId,
          dimension: "listening.historical_return",
          value: `${track.title} - ${track.artist}`,
          basis: `${track.playCount} effective plays, ${track.engagedPlayCount} without an explicit skip signal, and ${minutes(track.playedMs)} listening minutes from ${track.firstPlayedAt} through ${track.lastPlayedAt}; ${returns.length} observed return ${returns.length === 1 ? "gap" : "gaps"} reached at least ${historicalReturnMinimumGapDays} days, with a longest gap of ${longestGapDays} days. Its strongest supporting context is ${signal.value}.`,
          name: "listening-track-historical-return",
          confidence: confidenceForCount(
            track.engagedPlayCount + returns.length,
            0.58,
            0.9,
          ),
          limitation:
            "A long gap followed by another retained play is a historical return pattern, not proof of liking, nostalgia, or an intentional absence. Missing history and changed provider metadata can lengthen or split the pattern.",
        }),
      );
      return {
        track_ref_id: track.trackRefId,
        label: track.title,
        artist_credit: track.artist,
        ...(track.release ? { release: track.release } : {}),
        identity_status: track.identityStatus,
        play_count: track.playCount,
        engaged_play_count: track.engagedPlayCount,
        listening_minutes: minutes(track.playedMs),
        explicit_skips: track.skippedCount,
        first_played_at: track.firstPlayedAt,
        last_played_at: track.lastPlayedAt,
        return_count: returns.length,
        longest_gap_days: longestGapDays,
        latest_return_at: latestReturn.returned_at,
        latest_return_gap_days: latestReturn.gap_days,
        historical_return_signal: signal.value,
        evidence_id: evidenceId,
      };
    });
}

function evenlySpaced(values, maximum) {
  if (values.length <= maximum) return [...values];
  if (maximum === 1) {
    return [
      [...values].sort((left, right) => {
        if (right.strength !== left.strength) {
          return right.strength - left.strength;
        }
        return right.year - left.year;
      })[0],
    ];
  }
  const selected = [];
  for (let index = 0; index < maximum; index += 1) {
    const position = Math.round((index * (values.length - 1)) / (maximum - 1));
    const value = values[position];
    if (!selected.includes(value)) selected.push(value);
  }
  return selected;
}

function timeCapsuleTracks(
  subjectId,
  eventAnalysis,
  evidence,
  direct,
  explanations,
  maximum,
) {
  const avoids = combinedAvoids(direct.avoids, evidence.avoids);
  const byYear = new Map();
  for (const track of eventAnalysis.lifetime.tracks.values()) {
    if (avoids.some((item) => assertionMatchesTrack(item, track))) continue;
    const peak = rediscoveryPeakYear(track);
    if (
      !peak ||
      peak.engaged_play_count < timeCapsuleMinimumEngagedPlays ||
      peak.listening_minutes < minutes(timeCapsuleMinimumPlayedMs) ||
      peak.engaged_play_count < peak.explicit_skips
    ) {
      continue;
    }
    const values = byYear.get(peak.year) ?? [];
    values.push({
      track,
      peak,
      signal: rediscoverySignal(track, evidence, direct),
    });
    byYear.set(peak.year, values);
  }
  if (byYear.size < timeCapsuleMinimumYears) return [];

  const rankedYears = [...byYear.entries()]
    .sort(([left], [right]) => left - right)
    .map(([year, values]) => {
      values.sort((left, right) => {
        if (right.peak.played_ms !== left.peak.played_ms) {
          return right.peak.played_ms - left.peak.played_ms;
        }
        if (
          right.peak.engaged_play_count !== left.peak.engaged_play_count
        ) {
          return right.peak.engaged_play_count - left.peak.engaged_play_count;
        }
        if (right.signal.rank !== left.signal.rank) {
          return right.signal.rank - left.signal.rank;
        }
        if (right.track.playedMs !== left.track.playedMs) {
          return right.track.playedMs - left.track.playedMs;
        }
        const titleOrder = lexicalCompare(left.track.title, right.track.title);
        return titleOrder || lexicalCompare(left.track.artist, right.track.artist);
      });
      return {
        year,
        values,
        strength: values[0].peak.played_ms,
      };
    });
  const selectedYears = evenlySpaced(rankedYears, maximum).sort(
    (left, right) => left.year - right.year,
  );
  const usedArtists = new Set();
  return selectedYears.map(({ year, values }) => {
    const selected =
      values.find(
        ({ track }) => !usedArtists.has(normalizedText(track.artist)),
      ) ?? values[0];
    const { track, peak, signal } = selected;
    usedArtists.add(normalizedText(track.artist));
    const evidenceId = aggregateEvidenceId(
      subjectId,
      "track-time-capsule",
      `${track.trackRefId}\0${year}`,
    );
    explanations.set(
      evidenceId,
      explanation({
        evidenceId,
        dimension: "listening.time_capsule_representative",
        value: `${track.title} - ${track.artist}`,
        basis: `${year} is this track's strongest retained calendar year, with ${peak.play_count} effective plays, ${peak.engaged_play_count} without an explicit skip signal, and ${peak.listening_minutes} listening minutes. The deterministic year representative excludes active avoid signals and its strongest supporting context is ${signal.value}.`,
        name: "listening-time-capsule",
        confidence: confidenceForCount(peak.engaged_play_count, 0.55, 0.88),
        limitation:
          "This track is a bounded representative of retained listening in one UTC calendar year, not proof that it defined the year, was first discovered then, or remains preferred now. Missing history can change the selection.",
      }),
    );
    return {
      track_ref_id: track.trackRefId,
      label: track.title,
      artist_credit: track.artist,
      ...(track.release ? { release: track.release } : {}),
      identity_status: track.identityStatus,
      capsule_year: year,
      year_play_count: peak.play_count,
      year_engaged_play_count: peak.engaged_play_count,
      year_listening_minutes: peak.listening_minutes,
      year_explicit_skips: peak.explicit_skips,
      lifetime_play_count: track.playCount,
      lifetime_listening_minutes: minutes(track.playedMs),
      representative_signal: signal.value,
      evidence_id: evidenceId,
    };
  });
}

export function projectListeningProfile({
  subjectId,
  eventRows = [],
  profileEvidence = [],
  tasteEvents = [],
  maxItems = 10,
} = {}) {
  if (typeof subjectId !== "string" || !subjectId.trim()) {
    throw new TypeError("Listening profile subject ID is required");
  }
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) {
    throw new TypeError("Listening profile maxItems is invalid");
  }
  if (
    !Array.isArray(eventRows) ||
    !Array.isArray(profileEvidence) ||
    !Array.isArray(tasteEvents)
  ) {
    throw new TypeError("Listening profile inputs are invalid");
  }
  const normalizedSubjectId = subjectId.toLowerCase();
  const explanations = new Map();
  const events = aggregateEvents(normalizedSubjectId, eventRows, explanations);
  const monthlyActivity = aggregateMonthlyActivity(
    normalizedSubjectId,
    events,
    explanations,
  );
  const listeningSeasons = aggregateListeningSeasons(
    normalizedSubjectId,
    events,
    explanations,
  );
  const deduplicatedEvidence = deduplicateProfileEvidence(profileEvidence);
  const evidence = evidenceGroups(
    deduplicatedEvidence,
    events,
    explanations,
  );
  const direct = listenerAssertions(
    normalizedSubjectId,
    tasteEvents,
    explanations,
  );
  const rediscovery = rediscoveryTracks(
    normalizedSubjectId,
    events,
    evidence,
    direct,
    explanations,
  );
  const historicalReturns = historicalReturnTracks(
    normalizedSubjectId,
    events,
    evidence,
    direct,
    explanations,
  );
  const timeCapsule = timeCapsuleTracks(
    normalizedSubjectId,
    events,
    evidence,
    direct,
    explanations,
    maxItems,
  );
  const relationships = artistRelationships(
    normalizedSubjectId,
    events,
    explanations,
  );
  const transitions = yearlyArtistTransitions(
    normalizedSubjectId,
    events,
    explanations,
  );
  const releases = releaseDepth(
    normalizedSubjectId,
    events,
    explanations,
  );
  const sessions = listeningSessionSummary(
    normalizedSubjectId,
    events,
    explanations,
  );
  const backToBack = backToBackTracks(
    normalizedSubjectId,
    events,
    evidence,
    direct,
    explanations,
  );
  const kindCounts = Object.fromEntries(
    [...evidence.byKind.entries()]
      .map(([kind, values]) => [kind, values.length])
      .sort(([left], [right]) => lexicalCompare(left, right)),
  );
  const distinctTracks = events.lifetime.tracks.size;
  const resolvedTracks = [...events.lifetime.tracks.values()].filter(
    (track) => track.identityStatus === "resolved",
  ).length;
  const crossFormatLinkedRows = eventRows.filter(
    (row) => typeof row?.cross_format_source_track_ref_id === "string",
  );
  const crossFormatTrackLinks = new Set(
    crossFormatLinkedRows.map((row) => row.cross_format_source_track_ref_id),
  ).size;
  const crossFormatAmbiguousRows = eventRows.filter(
    (row) => typeof row?.cross_format_ambiguous_track_ref_id === "string",
  );
  const crossFormatAmbiguousTracks = new Set(
    crossFormatAmbiguousRows.map(
      (row) => row.cross_format_ambiguous_track_ref_id,
    ),
  ).size;
  const latestProviderCapture = deduplicatedEvidence.reduce(
    (latest, record) =>
      !latest || record.provenance.captured_at > latest
        ? record.provenance.captured_at
        : latest,
    null,
  );
  const latestCorrectionCapture = tasteEvents.reduce(
    (latest, record) =>
      typeof record?.recorded_at === "string" &&
      (!latest || record.recorded_at > latest)
        ? record.recorded_at
        : latest,
    null,
  );
  const latestListeningCapture = eventRows.reduce(
    (latest, row) => {
      const capturedAt = row?.event?.provenance?.captured_at;
      return typeof capturedAt === "string" &&
        (!latest || capturedAt > latest)
        ? capturedAt
        : latest;
    },
    null,
  );
  const listeningProviders = [
    ...new Set(
      eventRows
        .map((row) => row?.event?.provenance?.external_ref?.system)
        .map((system) => {
          if (typeof system !== "string") return null;
          if (system.startsWith("spotify")) return "spotify";
          if (system.startsWith("listenbrainz")) return "listenbrainz";
          if (system === "youtube_music") return "youtube_music";
          return "other";
        })
        .filter(Boolean),
    ),
  ].sort(lexicalCompare);
  const latestProfileCapture = [
    latestProviderCapture,
    latestCorrectionCapture,
    latestListeningCapture,
  ]
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  return {
    summary: {
      schema_version: LISTENING_PROFILE_SCHEMA_VERSION,
      coverage: {
        effective_listening_events: eventRows.length,
        profiled_listening_events: events.eligible.length,
        events_with_played_duration: events.eventsWithPlayedDuration,
        distinct_tracks: distinctTracks,
        resolved_tracks: resolvedTracks,
        cross_format_track_links: crossFormatTrackLinks,
        cross_format_linked_events: crossFormatLinkedRows.length,
        cross_format_ambiguous_tracks: crossFormatAmbiguousTracks,
        cross_format_ambiguous_events: crossFormatAmbiguousRows.length,
        listening_hours: hours(events.profiledPlayedMs),
        earliest_played_at: events.earliest,
        latest_played_at: events.latest,
        profile_evidence_records: deduplicatedEvidence.length,
        collection_tracks: new Set(deduplicatedEvidence.filter((record) => ["library_track_saved", "playlist_track_added"].includes(record.evidence_kind)).map((record) => record.entity.track_ref_id)).size,
        collection_sources: [...new Set(deduplicatedEvidence.map((record) => record.provenance.source_system))].sort().map((system) => {
          const records = deduplicatedEvidence.filter((record) => record.provenance.source_system === system);
          const count = (kind) => records.filter((record) => record.evidence_kind === kind).length;
          return { system, label: musicProviderLabel(system), evidence_records: records.length,
            tracks: new Set(records.filter((record) => ["library_track_saved", "playlist_track_added"].includes(record.evidence_kind)).map((record) => record.entity.track_ref_id)).size,
            saved_tracks: count("library_track_saved"), saved_albums: count("library_album_saved"),
            followed_artists: count("library_artist_followed"), playlist_memberships: count("playlist_track_added") };
        }),
        listener_assertion_events: direct.total_assertions,
        active_listener_assertions: direct.active.length,
        listener_retractions: direct.retractions,
        saved_tracks: evidence.byKind.get("library_track_saved")?.length ?? 0,
        saved_albums: evidence.byKind.get("library_album_saved")?.length ?? 0,
        followed_artists:
          evidence.byKind.get("library_artist_followed")?.length ?? 0,
        playlist_memberships:
          evidence.byKind.get("playlist_track_added")?.length ?? 0,
        verified_search_interactions:
          evidence.byKind.get("search_result_interacted")?.length ?? 0,
        evidence_by_kind: kindCounts,
      },
      listening_behavior: {
        enduring_artists: slice(events.lifetime.rankedArtists, maxItems),
        recent_artists: slice(events.recent.rankedArtists, maxItems),
        repeat_tracks: slice(events.lifetime.rankedTracks, maxItems),
        recent_tracks: slice(events.recent.rankedTracks, maxItems),
        rediscovery_tracks: slice(rediscovery, maxItems),
        historical_return_tracks: slice(historicalReturns, maxItems),
        time_capsule_tracks: timeCapsule,
        history_arc: events.historyArc,
        monthly_activity: monthlyActivity,
        listening_seasons: listeningSeasons,
        artist_relationships: slice(relationships, maxItems),
        year_transitions: slice(transitions, 12),
        release_depth: slice(releases, maxItems),
        session_summary: sessions,
        back_to_back_tracks: slice(backToBack, maxItems),
        context: {
          ...events.context,
          rediscovery_quiet_days: recentWindowDays,
          rediscovery_minimum_plays: rediscoveryMinimumPlays,
          rediscovery_minimum_engaged_plays: rediscoveryMinimumEngagedPlays,
          rediscovery_minimum_listening_minutes: minutes(
            rediscoveryMinimumPlayedMs,
          ),
          historical_return_minimum_gap_days:
            historicalReturnMinimumGapDays,
          historical_return_minimum_plays: historicalReturnMinimumPlays,
          historical_return_minimum_engaged_plays:
            historicalReturnMinimumEngagedPlays,
          historical_return_minimum_listening_minutes: minutes(
            historicalReturnMinimumPlayedMs,
          ),
          time_capsule_minimum_years: timeCapsuleMinimumYears,
          time_capsule_minimum_engaged_plays:
            timeCapsuleMinimumEngagedPlays,
          time_capsule_minimum_listening_minutes: minutes(
            timeCapsuleMinimumPlayedMs,
          ),
          relationship_minimum_years: relationshipMinimumYears,
          continuity_artist_limit: continuityArtistLimit,
          release_minimum_distinct_tracks: releaseMinimumDistinctTracks,
          session_gap_minutes: sessionGapMinutes,
          extended_sequence_minimum_plays: extendedSequenceMinimumPlays,
          back_to_back_minimum_consecutive_plays:
            backToBackMinimumConsecutivePlays,
          back_to_back_minimum_played_seconds:
            backToBackMinimumPlayedMs / 1_000,
          back_to_back_maximum_gap_minutes:
            backToBackMaximumGapMinutes,
          monthly_activity_maximum_months: monthlyActivityMaximumMonths,
          listening_season_maximum_seasons:
            listeningSeasonMaximumSeasons,
        },
      },
      curated_preferences: {
        saved_tracks: slice(evidence.savedTracks, maxItems),
        playlist_anchors: slice(evidence.playlistAnchors, maxItems),
        followed_artists: slice(evidence.followedArtists, maxItems),
        saved_albums: slice(evidence.savedAlbums, maxItems),
        avoids: slice(combinedAvoids(direct.avoids, evidence.avoids), maxItems),
      },
      listener_assertions: {
        active: slice(direct.active, maxItems),
        preferences: slice(direct.preferences, maxItems),
        avoids: slice(direct.avoids, maxItems),
        retractions: direct.retractions,
      },
      search_intent: slice(evidence.searches, maxItems),
      provider_signals: {
        artists: slice(evidence.providerArtists, maxItems),
        tracks: slice(evidence.providerTracks, maxItems),
        genres: slice(evidence.genres, maxItems),
        interpretations: slice(evidence.interpretations, 2),
        highlights: slice(evidence.highlights, Math.min(maxItems, 4)),
        metrics: slice(evidence.metrics, Math.min(maxItems, 8)),
      },
      source: {
        kind: "private_effective_listening_evidence",
        providers: listeningProviders,
        listening_range: {
          earliest: events.earliest,
          latest: events.latest,
        },
        profile_captured_at: latestProfileCapture,
      },
      limitations: [
        "Listening duration and repetition support familiarity and attention, not liking by themselves.",
        ...(listeningProviders.includes("spotify")
          ? [
              "Spotify skip flags are contextual navigation evidence, while incognito events are excluded from taste rankings.",
            ]
          : []),
        ...(listeningProviders.includes("listenbrainz")
          ? [
              "ListenBrainz timestamps mark playback start, listens without duration_played affect counts but not listening-time totals, and only server-resolved MusicBrainz mappings become resolved identity.",
            ]
          : []),
        ...(listeningProviders.length > 1
          ? [
              "Cross-provider events are combined, but provider-specific track identities are not automatically merged without a shared canonical recording identity.",
            ]
          : []),
        "Calendar-year listening arcs use UTC boundaries.",
        ...(monthlyActivity
          ? [
              "Listening Pulse groups eligible effective events by retained UTC calendar month, caps the rendered window at 240 months, and treats blank months as missing retained activity rather than proof of no listening.",
            ]
          : []),
        ...(listeningSeasons
          ? [
              "Listening Seasons groups eligible effective events into fixed UTC calendar quarters, caps the represented window at 80 quarters, and treats leading artists and signature tracks as within-window descriptions rather than preference, mood, or life-event claims.",
            ]
          : []),
        "A track's first appearance in retained history does not prove that it was newly discovered then.",
        "Rediscovery candidates require at least 3 effective plays, 2 plays without an explicit skip signal, 10 listening minutes, and no appearance in the recent 90-day window. They are listen-again prompts, not preference claims.",
        "Historical returns require at least 3 effective plays, 3 plays without an explicit skip signal, 10 listening minutes, and one observed gap of at least 180 days. They describe recurrence in retained history, not liking, nostalgia, or intentional absence.",
        "Listening Time Machine representatives require at least two qualifying calendar years and select at most one track per represented peak year. They are deterministic history landmarks, not claims that a track defined a year or remains preferred now.",
        "Artist relationships require appearances in at least two retained UTC years including the latest retained year, while year-to-year top-artist overlap describes continuity and turnover without claiming permanent taste change.",
        "Release depth requires at least three distinct retained tracks from the same artist and release metadata pair. It does not establish full-album playback, track order, completion, ownership, or liking.",
        ...(sessions
          ? [
              "Approximate listening sessions use only eligible Spotify Extended History track-stop timestamps and begin after gaps longer than 30 minutes. They are not provider session logs or evidence of activity, mood, location, or intent.",
            ]
          : []),
        ...(backToBack.length > 0
          ? [
              "Played back to back requires at least two adjacent non-skipped Spotify Extended History events for the same track, at least 30 seconds played per event, and no gap over 30 minutes. It does not prove repeat mode, intention, or liking.",
            ]
          : []),
        ...(deduplicatedEvidence.length > 0
          ? [
              "Spotify-generated Taste Profile, Wrapped, and Sound Capsule fields are provider interpretations, not user instructions or direct assertions.",
            ]
          : []),
        "Direct listener assertions outrank ambiguous behavioral and provider signals but remain retractable and do not rewrite source history.",
      ],
    },
    explanations,
    // Host-only consumers need every exclusion, not the bounded display sample.
    lyricExclusions: combinedAvoids(direct.avoids, evidence.avoids),
  };
}
