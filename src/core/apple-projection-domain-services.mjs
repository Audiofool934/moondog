import { randomUUID } from "node:crypto";
import { lyricSeedsFromProfile } from "./lyric-profile.mjs";
import { collectionCoverage } from "../profile/music-providers.mjs";
import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  resolveAppleMusicImportsRoot,
} from "./apple-library-source-status.mjs";
import {
  computeAppleProjectionInputDigest,
  defaultAppleMusicProjectionPath,
  defaultAppleMusicProjectionPathFor,
  isUuid,
  listAppleMusicImportBatches,
  openAppleMusicSqliteProjection,
} from "../importers/apple-music-library/index.mjs";

export { defaultAppleMusicProjectionPath };

export function resolveAppleMusicProjectionPath(environment = process.env) {
  const configured = environment.MOONDOG_APPLE_PROJECTION_PATH?.trim();
  if (!configured) return defaultAppleMusicProjectionPathFor(environment);
  if (!path.isAbsolute(configured)) {
    throw new TypeError("MOONDOG_APPLE_PROJECTION_PATH must be an absolute path");
  }
  return path.resolve(configured);
}

export const APPLE_DOMAIN_LIMITS = Object.freeze({
  searchDefault: 8,
  searchMax: 12,
  searchOffsetMax: 10_000,
  profileDefault: 6,
  profileMax: 10,
  rediscoveryDefault: 6,
  rediscoveryMax: 12,
  historicalReturnDefault: 6,
  historicalReturnMax: 12,
  backToBackDefault: 6,
  backToBackMax: 12,
  timeCapsuleDefault: 6,
  timeCapsuleMax: 12,
  candidateSetsMax: 8,
  playlistTracksMax: 12,
  queryLengthMax: 256,
  shortTextMax: 256,
  longTextMax: 500,
});

const familiarityValues = new Set(["low", "medium", "high", "unknown"]);
const preferenceSignalValues = new Set(["loved", "favorited", "rated"]);
const externalCatalogProviders = new Set(["apple_music", "listenbrainz"]);
const listenBrainzModes = new Set(["easy", "medium", "hard"]);
const rediscoverySignals = new Set([
  "explicit listener preference",
  "saved-library state",
  "private playlist curation",
  "historical attention only",
]);
const backToBackSignals = new Set(["adjacent retained plays"]);
const spotifyTrackIdPattern = /^[A-Za-z0-9]{22}$/u;
const englishTrackCounts = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
]);
const chineseTrackCounts = new Map([
  ["一", 1],
  ["二", 2],
  ["两", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
  ["十", 10],
]);

export class AppleProjectionDomainError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "AppleProjectionDomainError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new AppleProjectionDomainError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function modelArguments(value, allowedKeys) {
  const input = value ?? {};
  if (
    !isPlainObject(input) ||
    Object.keys(input).some((key) => !allowedKeys.has(key))
  ) {
    fail("invalid_arguments", "Domain service arguments are invalid.");
  }
  return input;
}

function cleanText(value, maximum, code) {
  if (typeof value !== "string" || Array.from(value).length > maximum) {
    fail(code, "Domain service text is invalid.");
  }
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) fail(code, "Domain service text is invalid.");
  return cleaned;
}

function cleanQuery(value) {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    Array.from(value).length > APPLE_DOMAIN_LIMITS.queryLengthMax
  ) {
    fail("invalid_query", "Library search query is invalid.");
  }
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function boundedLimit(value, fallback, maximum, code) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    fail(code, "Domain service limit is invalid.");
  }
  return value;
}

function boundedOffset(value, maximum, code) {
  const offset = value ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > maximum) {
    fail(code, "Domain service offset is invalid.");
  }
  return offset;
}

function normalizeText(value) {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function normalizeFilterArray(value, allowedValues, code) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) {
    fail(code, "Library search filters are invalid.");
  }
  const normalized = value.map((item) =>
    normalizeText(cleanText(item, APPLE_DOMAIN_LIMITS.shortTextMax, code)),
  );
  if (allowedValues && normalized.some((item) => !allowedValues.has(item))) {
    fail(code, "Library search filters are invalid.");
  }
  return [...new Set(normalized)];
}

function normalizeFilters(value) {
  if (value === undefined) {
    return { artists: [], genres: [], familiarity: [], preferenceSignals: [] };
  }
  if (!isPlainObject(value)) fail("invalid_filters", "Library search filters are invalid.");
  const allowed = new Set([
    "artists",
    "genres",
    "familiarity",
    "preferenceSignals",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail("invalid_filters", "Library search filters are invalid.");
  }
  return {
    artists: normalizeFilterArray(value.artists, null, "invalid_filters"),
    genres: normalizeFilterArray(value.genres, null, "invalid_filters"),
    familiarity: normalizeFilterArray(
      value.familiarity,
      familiarityValues,
      "invalid_filters",
    ),
    preferenceSignals: normalizeFilterArray(
      value.preferenceSignals,
      preferenceSignalValues,
      "invalid_filters",
    ),
  };
}

function preferenceSignals(observation = {}) {
  const result = [];
  if (observation.loved === true) result.push("loved");
  if (observation.favorited === true) result.push("favorited");
  if (
    isPlainObject(observation.rating) &&
    observation.rating.computed !== true &&
    Number.isInteger(observation.rating.value) &&
    observation.rating.value >= 60
  ) {
    result.push("rated");
  }
  return result;
}

function familiarityLevel(playCount) {
  if (!Number.isInteger(playCount) || playCount < 0) return "unknown";
  if (playCount >= 20) return "high";
  if (playCount >= 5) return "medium";
  return "low";
}

function safeTrack(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.track_ref)) {
    fail("projection_result_invalid", "Projection returned an invalid track.");
  }
  const observed = isPlainObject(raw.observation_summary)
    ? raw.observation_summary
    : {};
  const playCount = Number.isInteger(observed.play_count)
    ? observed.play_count
    : undefined;
  const genres =
    typeof raw.labels?.provider_genre === "string" &&
    raw.labels.provider_genre.trim()
      ? [raw.labels.provider_genre.trim()]
      : [];
  const labels = { genres };
  if (typeof raw.labels?.composer === "string" && raw.labels.composer.trim()) {
    labels.composer = raw.labels.composer.trim();
  }
  const familiarity = {
    level: familiarityLevel(playCount),
    basis: playCount === undefined ? "not_observed" : "aggregate_play_count",
  };
  if (playCount !== undefined) familiarity.play_count = playCount;
  const track = {
    track_ref_id: cleanText(
      raw.track_ref.track_ref_id,
      128,
      "projection_result_invalid",
    ),
    title: cleanText(raw.title, 512, "projection_result_invalid"),
    artist_credit:
      typeof raw.artist_credit === "string" && raw.artist_credit.trim()
        ? raw.artist_credit.trim()
        : "Unknown artist",
    release:
      typeof raw.release === "string" && raw.release.trim()
        ? raw.release.trim()
        : "Unknown release",
    labels,
    observation_summary: {
      preference_signals: preferenceSignals(observed),
      familiarity,
    },
  };
  if (Number.isInteger(raw.duration_ms) && raw.duration_ms >= 0) {
    track.duration_ms = raw.duration_ms;
  }
  return track;
}

function safeExternalCatalogUrl(value, provider) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const allowedHosts =
      provider === "apple_music"
        ? new Set(["music.apple.com", "itunes.apple.com"])
        : new Set(["musicbrainz.org", "listenbrainz.org"]);
    if (
      url.protocol !== "https:" ||
      !allowedHosts.has(url.hostname)
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function safeExternalTrack(raw) {
  const provider =
    isPlainObject(raw) && externalCatalogProviders.has(raw.catalog_provider)
      ? raw.catalog_provider
      : null;
  if (
    !isPlainObject(raw) ||
    !isUuid(raw.track_ref_id) ||
    raw.candidate_scope !== "external_catalog" ||
    !provider
  ) {
    fail("external_candidate_invalid", "An external catalog candidate is invalid.");
  }
  const track = {
    track_ref_id: raw.track_ref_id.toLowerCase(),
    title: cleanText(raw.title, 512, "external_candidate_invalid"),
    artist_credit: cleanText(
      raw.artist_credit,
      512,
      "external_candidate_invalid",
    ),
    release: cleanText(raw.release, 512, "external_candidate_invalid"),
    candidate_scope: "external_catalog",
    catalog_provider: provider,
    labels: { genres: [] },
    observation_summary: {
      preference_signals: [],
      familiarity: {
        level: "unknown",
        basis: "external_catalog_not_personal_evidence",
      },
    },
  };
  if (
    Number.isInteger(raw.duration_ms) &&
    raw.duration_ms >= 0 &&
    raw.duration_ms <= 86_400_000
  ) {
    track.duration_ms = raw.duration_ms;
  }
  if (typeof raw.primary_genre === "string" && raw.primary_genre.trim()) {
    track.primary_genre = cleanText(
      raw.primary_genre,
      128,
      "external_candidate_invalid",
    );
    track.labels.genres = [track.primary_genre];
  }
  if (
    typeof raw.release_date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(raw.release_date) &&
    Number.isFinite(Date.parse(`${raw.release_date}T00:00:00.000Z`))
  ) {
    track.release_date = raw.release_date;
  }
  const catalogUrl = safeExternalCatalogUrl(raw.catalog_url, provider);
  if (catalogUrl) track.catalog_url = catalogUrl;
  if (provider === "apple_music" && Array.isArray(raw.matched_queries)) {
    track.matched_queries = raw.matched_queries
      .slice(0, 3)
      .map((query) =>
        cleanText(query, APPLE_DOMAIN_LIMITS.queryLengthMax, "external_candidate_invalid"),
      );
  }
  if (provider === "listenbrainz") {
    const basis = raw.discovery_basis;
    if (
      !isPlainObject(basis) ||
      basis.kind !== "listenbrainz_collaborative_artist_similarity" ||
      !listenBrainzModes.has(basis.mode)
    ) {
      fail("external_candidate_invalid", "An external catalog candidate is invalid.");
    }
    track.discovery_basis = {
      kind: "listenbrainz_collaborative_artist_similarity",
      seed_artist: cleanText(
        basis.seed_artist,
        512,
        "external_candidate_invalid",
      ),
      adjacent_artist: cleanText(
        basis.adjacent_artist,
        512,
        "external_candidate_invalid",
      ),
      mode: basis.mode,
    };
  }
  return track;
}

function safeHistoryTimestamp(value) {
  const cleaned = cleanText(value, 64, "history_candidate_invalid");
  if (!Number.isFinite(Date.parse(cleaned))) {
    fail("history_candidate_invalid", "A listening-history candidate is invalid.");
  }
  return cleaned;
}

function safeHistoryCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("history_candidate_invalid", "A listening-history candidate is invalid.");
  }
  return value;
}

function safeHistoryExternalRefs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail("history_candidate_invalid", "A listening-history candidate is invalid.");
  }
  const spotifyRefs = [];
  for (const raw of value) {
    if (!isPlainObject(raw) || raw.system !== "spotify") continue;
    if (
      raw.entity_type !== "spotify.track" ||
      typeof raw.external_id !== "string" ||
      !spotifyTrackIdPattern.test(raw.external_id)
    ) {
      fail("history_candidate_invalid", "A listening-history candidate is invalid.");
    }
    if (!spotifyRefs.some((ref) => ref.external_id === raw.external_id)) {
      spotifyRefs.push({
        system: "spotify",
        entity_type: "spotify.track",
        external_id: raw.external_id,
      });
    }
  }
  if (spotifyRefs.length > 1) {
    fail("history_candidate_invalid", "A listening-history candidate is invalid.");
  }
  return spotifyRefs;
}

function safeHistoryTrack(raw) {
  const hasRediscovery = isPlainObject(raw?.rediscovery);
  const hasHistoricalReturn = isPlainObject(raw?.historical_return);
  const hasTimeCapsule = isPlainObject(raw?.time_capsule);
  const hasBackToBack = isPlainObject(raw?.back_to_back);
  if (
    !isPlainObject(raw) ||
    raw.candidate_scope !== "private_history" ||
    !isUuid(raw.track_ref_id) ||
    [
      hasRediscovery,
      hasHistoricalReturn,
      hasTimeCapsule,
      hasBackToBack,
    ].filter(Boolean).length !== 1
  ) {
    fail("history_candidate_invalid", "A listening-history candidate is invalid.");
  }
  const identityStatus = raw.identity_status;
  if (!new Set(["resolved", "provisional"]).has(identityStatus)) {
    fail("history_candidate_invalid", "A listening-history candidate is invalid.");
  }
  const playCount = safeHistoryCount(
    raw.observation_summary?.familiarity?.play_count,
  );
  const externalRefs = safeHistoryExternalRefs(raw.external_refs);
  const track = {
    track_ref_id: raw.track_ref_id.toLowerCase(),
    title: cleanText(raw.title, 512, "history_candidate_invalid"),
    artist_credit: cleanText(
      raw.artist_credit,
      512,
      "history_candidate_invalid",
    ),
    release: cleanText(raw.release, 512, "history_candidate_invalid"),
    candidate_scope: "private_history",
    identity_status: identityStatus,
    labels: { genres: [] },
    observation_summary: {
      preference_signals: [],
      familiarity: {
        level: familiarityLevel(playCount),
        basis: "effective_listening_history",
        play_count: playCount,
      },
    },
  };
  if (hasRediscovery) {
    const rediscovery = raw.rediscovery;
    const engagedPlayCount = safeHistoryCount(rediscovery.engaged_play_count);
    const explicitSkips = safeHistoryCount(rediscovery.explicit_skips);
    const listeningMinutes = safeHistoryCount(rediscovery.listening_minutes);
    const quietDays = safeHistoryCount(rediscovery.quiet_days);
    if (engagedPlayCount > playCount || explicitSkips > playCount) {
      fail("history_candidate_invalid", "A listening-history candidate is invalid.");
    }
    const rediscoverySignal = cleanText(
      rediscovery.rediscovery_signal,
      128,
      "history_candidate_invalid",
    );
    if (!rediscoverySignals.has(rediscoverySignal)) {
      fail("history_candidate_invalid", "A listening-history candidate is invalid.");
    }
    const firstPlayedAt = safeHistoryTimestamp(rediscovery.first_played_at);
    const lastPlayedAt = safeHistoryTimestamp(rediscovery.last_played_at);
    if (Date.parse(firstPlayedAt) > Date.parse(lastPlayedAt)) {
      fail("history_candidate_invalid", "A listening-history candidate is invalid.");
    }
    if (!isUuid(rediscovery.evidence_id)) {
      fail("history_candidate_invalid", "A listening-history candidate is invalid.");
    }
    const peakFields = [
      rediscovery.peak_year,
      rediscovery.peak_year_play_count,
      rediscovery.peak_year_listening_minutes,
    ];
    if (peakFields.some((value) => value !== undefined)) {
      if (
        !peakFields.every((value) => Number.isSafeInteger(value) && value >= 0) ||
        rediscovery.peak_year < 1900 ||
        rediscovery.peak_year > 9999
      ) {
        fail("history_candidate_invalid", "A listening-history candidate is invalid.");
      }
    }
    track.rediscovery = {
      listening_minutes: listeningMinutes,
      engaged_play_count: engagedPlayCount,
      explicit_skips: explicitSkips,
      first_played_at: firstPlayedAt,
      last_played_at: lastPlayedAt,
      quiet_days: quietDays,
      rediscovery_signal: rediscoverySignal,
      ...(peakFields.every((value) => value !== undefined)
        ? {
            peak_year: rediscovery.peak_year,
            peak_year_play_count: rediscovery.peak_year_play_count,
            peak_year_listening_minutes:
              rediscovery.peak_year_listening_minutes,
          }
        : {}),
      evidence_id: rediscovery.evidence_id.toLowerCase(),
    };
  } else if (hasHistoricalReturn) {
    const historicalReturn = raw.historical_return;
    const engagedPlayCount = safeHistoryCount(
      historicalReturn.engaged_play_count,
    );
    const explicitSkips = safeHistoryCount(historicalReturn.explicit_skips);
    const listeningMinutes = safeHistoryCount(
      historicalReturn.listening_minutes,
    );
    const returnCount = safeHistoryCount(historicalReturn.return_count);
    const longestGapDays = safeHistoryCount(
      historicalReturn.longest_gap_days,
    );
    const latestReturnGapDays = safeHistoryCount(
      historicalReturn.latest_return_gap_days,
    );
    const historicalReturnSignal = cleanText(
      historicalReturn.historical_return_signal,
      128,
      "history_candidate_invalid",
    );
    const firstPlayedAt = safeHistoryTimestamp(
      historicalReturn.first_played_at,
    );
    const lastPlayedAt = safeHistoryTimestamp(
      historicalReturn.last_played_at,
    );
    const latestReturnAt = safeHistoryTimestamp(
      historicalReturn.latest_return_at,
    );
    if (
      returnCount < 1 ||
      longestGapDays < 1 ||
      latestReturnGapDays < 1 ||
      latestReturnGapDays > longestGapDays ||
      engagedPlayCount > playCount ||
      explicitSkips > playCount ||
      Date.parse(firstPlayedAt) > Date.parse(latestReturnAt) ||
      Date.parse(latestReturnAt) > Date.parse(lastPlayedAt) ||
      !rediscoverySignals.has(historicalReturnSignal) ||
      !isUuid(historicalReturn.evidence_id)
    ) {
      fail("history_candidate_invalid", "A listening-history candidate is invalid.");
    }
    track.historical_return = {
      listening_minutes: listeningMinutes,
      engaged_play_count: engagedPlayCount,
      explicit_skips: explicitSkips,
      first_played_at: firstPlayedAt,
      last_played_at: lastPlayedAt,
      return_count: returnCount,
      longest_gap_days: longestGapDays,
      latest_return_at: latestReturnAt,
      latest_return_gap_days: latestReturnGapDays,
      historical_return_signal: historicalReturnSignal,
      evidence_id: historicalReturn.evidence_id.toLowerCase(),
    };
  } else if (hasTimeCapsule) {
    const capsule = raw.time_capsule;
    const year = safeHistoryCount(capsule.year);
    const yearPlayCount = safeHistoryCount(capsule.year_play_count);
    const yearEngagedPlayCount = safeHistoryCount(
      capsule.year_engaged_play_count,
    );
    const yearListeningMinutes = safeHistoryCount(
      capsule.year_listening_minutes,
    );
    const yearExplicitSkips = safeHistoryCount(capsule.year_explicit_skips);
    const lifetimeListeningMinutes = safeHistoryCount(
      capsule.lifetime_listening_minutes,
    );
    const representativeSignal = cleanText(
      capsule.representative_signal,
      128,
      "history_candidate_invalid",
    );
    if (
      year < 1900 ||
      year > 9999 ||
      yearPlayCount > playCount ||
      yearEngagedPlayCount > yearPlayCount ||
      yearExplicitSkips > yearPlayCount ||
      yearListeningMinutes > lifetimeListeningMinutes ||
      !rediscoverySignals.has(representativeSignal) ||
      !isUuid(capsule.evidence_id)
    ) {
      fail("history_candidate_invalid", "A listening-history candidate is invalid.");
    }
    track.time_capsule = {
      year,
      year_play_count: yearPlayCount,
      year_engaged_play_count: yearEngagedPlayCount,
      year_listening_minutes: yearListeningMinutes,
      year_explicit_skips: yearExplicitSkips,
      lifetime_listening_minutes: lifetimeListeningMinutes,
      representative_signal: representativeSignal,
      evidence_id: capsule.evidence_id.toLowerCase(),
    };
  } else {
    const context = raw.back_to_back;
    const engagedPlayCount = safeHistoryCount(context.engaged_play_count);
    const explicitSkips = safeHistoryCount(context.explicit_skips);
    const burstCount = safeHistoryCount(context.burst_count);
    const maximumConsecutivePlays = safeHistoryCount(
      context.maximum_consecutive_plays,
    );
    const playsInBursts = safeHistoryCount(context.plays_in_bursts);
    const listeningMinutesInBursts = safeHistoryCount(
      context.listening_minutes_in_bursts,
    );
    const latestBurstAt = safeHistoryTimestamp(context.latest_burst_at);
    const sequenceSignal = cleanText(
      context.sequence_signal,
      128,
      "history_candidate_invalid",
    );
    if (
      burstCount < 1 ||
      maximumConsecutivePlays < 2 ||
      playsInBursts < maximumConsecutivePlays ||
      playsInBursts < burstCount * 2 ||
      playsInBursts > playCount ||
      engagedPlayCount > playCount ||
      explicitSkips > playCount ||
      !backToBackSignals.has(sequenceSignal) ||
      !isUuid(context.evidence_id)
    ) {
      fail("history_candidate_invalid", "A listening-history candidate is invalid.");
    }
    track.back_to_back = {
      engaged_play_count: engagedPlayCount,
      explicit_skips: explicitSkips,
      burst_count: burstCount,
      maximum_consecutive_plays: maximumConsecutivePlays,
      plays_in_bursts: playsInBursts,
      listening_minutes_in_bursts: listeningMinutesInBursts,
      latest_burst_at: latestBurstAt,
      sequence_signal: sequenceSignal,
      evidence_id: context.evidence_id.toLowerCase(),
    };
  }
  if (
    Number.isInteger(raw.duration_ms) &&
    raw.duration_ms >= 0 &&
    raw.duration_ms <= 86_400_000
  ) {
    track.duration_ms = raw.duration_ms;
  }
  if (externalRefs.length > 0) track.external_refs = externalRefs;
  return track;
}

function publicHistoryTrack(track) {
  const projected = structuredClone(track);
  delete projected.external_refs;
  return projected;
}

function safeRetainedPlaylistTrack(raw) {
  if (raw?.candidate_scope === "private_history") {
    return safeHistoryTrack(raw);
  }
  if (raw?.candidate_scope === "external_catalog") {
    return {
      ...safeExternalTrack(raw),
      knownness: {
        imported_library: "not_found_by_exact_title_artist",
        listening_history: "not_checked",
      },
    };
  }
  if (
    !isPlainObject(raw) ||
    (raw.candidate_scope !== undefined &&
      raw.candidate_scope !== "private_library") ||
    !isUuid(raw.track_ref_id)
  ) {
    fail(
      "retained_candidate_invalid",
      "Retained playlist candidates are invalid.",
    );
  }
  const playCount = Number.isInteger(
    raw.observation_summary?.familiarity?.play_count,
  )
    ? raw.observation_summary.familiarity.play_count
    : undefined;
  const level = familiarityValues.has(
    raw.observation_summary?.familiarity?.level,
  )
    ? raw.observation_summary.familiarity.level
    : "unknown";
  const genres = Array.isArray(raw.labels?.genres)
    ? raw.labels.genres
        .slice(0, 4)
        .map((genre) =>
          cleanText(genre, 128, "retained_candidate_invalid"),
        )
    : [];
  const labels = { genres };
  if (typeof raw.labels?.composer === "string" && raw.labels.composer.trim()) {
    labels.composer = cleanText(
      raw.labels.composer,
      APPLE_DOMAIN_LIMITS.shortTextMax,
      "retained_candidate_invalid",
    );
  }
  const track = {
    track_ref_id: raw.track_ref_id.toLowerCase(),
    title: cleanText(raw.title, 512, "retained_candidate_invalid"),
    artist_credit: cleanText(
      raw.artist_credit,
      512,
      "retained_candidate_invalid",
    ),
    release: cleanText(raw.release, 512, "retained_candidate_invalid"),
    candidate_scope: "private_library",
    labels,
    observation_summary: {
      preference_signals: Array.isArray(
        raw.observation_summary?.preference_signals,
      )
        ? [
            ...new Set(
              raw.observation_summary.preference_signals.filter((signal) =>
                preferenceSignalValues.has(signal),
              ),
            ),
          ]
        : [],
      familiarity: {
        level,
        basis:
          playCount === undefined
            ? "not_observed"
            : "aggregate_play_count",
        ...(playCount === undefined ? {} : { play_count: playCount }),
      },
    },
  };
  if (
    Number.isInteger(raw.duration_ms) &&
    raw.duration_ms >= 0 &&
    raw.duration_ms <= 86_400_000
  ) {
    track.duration_ms = raw.duration_ms;
  }
  return track;
}

function normalizedArtistNames(value) {
  return normalizeText(value)
    .split(/\s*(?:,|&|;|\/|\bfeat\.?\b|\bfeaturing\b)\s*/u)
    .filter(Boolean);
}

export function exactTitleArtistMatch(left, right) {
  const leftTitle = normalizeText(left.title);
  const rightTitle = normalizeText(right.title);
  const leftArtists = normalizedArtistNames(left.artist_credit);
  const rightArtists = new Set(normalizedArtistNames(right.artist_credit));
  return (
    leftTitle === rightTitle &&
    leftArtists.some((artist) => rightArtists.has(artist))
  );
}

export function assertExternalPlanDiversity(tracks, intent) {
  const externalTracks = tracks.filter(
    (track) => track.candidate_scope === "external_catalog",
  );
  if (externalTracks.length < 2) return;
  const normalizedIntent = normalizeText(intent);
  const releases = new Map();
  const artists = new Map();
  for (const track of externalTracks) {
    const artistKey = normalizeText(track.artist_credit);
    const releaseKey = `${artistKey}|${normalizeText(track.release)}`;
    const releaseGroup = releases.get(releaseKey) ?? {
      release: normalizeText(track.release),
      count: 0,
    };
    releaseGroup.count += 1;
    releases.set(releaseKey, releaseGroup);
    const artistGroup = artists.get(artistKey) ?? {
      names: normalizedArtistNames(track.artist_credit),
      count: 0,
    };
    artistGroup.count += 1;
    artists.set(artistKey, artistGroup);
  }
  for (const group of releases.values()) {
    if (
      group.count > 1 &&
      !normalizedIntent.includes(group.release)
    ) {
      fail(
        "playlist_external_release_concentration",
        "External discovery plans may select only one track per release unless the intent names that release.",
      );
    }
  }
  for (const group of artists.values()) {
    const artistRequested = group.names.some(
      (name) =>
        Array.from(name).length >= 2 && normalizedIntent.includes(name),
    );
    if (group.count > 2 && !artistRequested) {
      fail(
        "playlist_external_artist_concentration",
        "External discovery plans may select at most two tracks per artist unless the intent names that artist.",
      );
    }
  }
}

export function safeExternalSource(raw) {
  if (!isPlainObject(raw) || !externalCatalogProviders.has(raw.provider)) {
    fail("external_candidate_invalid", "External catalog source metadata is invalid.");
  }
  if (
    typeof raw.retrieved_at !== "string" ||
    !Number.isFinite(Date.parse(raw.retrieved_at))
  ) {
    fail("external_candidate_invalid", "External catalog source metadata is invalid.");
  }
  if (raw.provider === "apple_music") {
    if (raw.catalog !== "itunes_search_api" || raw.storefront !== "US") {
      fail("external_candidate_invalid", "External catalog source metadata is invalid.");
    }
    return {
      provider: "apple_music",
      catalog: "itunes_search_api",
      storefront: "US",
      retrieved_at: raw.retrieved_at,
      coverage: cleanText(raw.coverage, 500, "external_candidate_invalid"),
    };
  }
  if (
    raw.catalog !== "lb_radio_artist+metadata_recording" ||
    raw.identity_provider !== "wikidata" ||
    raw.recommendation_basis !== "listenbrainz_collaborative_artist_similarity" ||
    !listenBrainzModes.has(raw.mode) ||
    !isPlainObject(raw.popularity_range) ||
    !Number.isInteger(raw.popularity_range.begin) ||
    !Number.isInteger(raw.popularity_range.end) ||
    raw.popularity_range.begin < 0 ||
    raw.popularity_range.end > 100 ||
    raw.popularity_range.begin > raw.popularity_range.end
  ) {
    fail("external_candidate_invalid", "External catalog source metadata is invalid.");
  }
  return {
    provider: "listenbrainz",
    catalog: "lb_radio_artist+metadata_recording",
    identity_provider: "wikidata",
    retrieved_at: raw.retrieved_at,
    license: cleanText(raw.license, 500, "external_candidate_invalid"),
    recommendation_basis: "listenbrainz_collaborative_artist_similarity",
    mode: raw.mode,
    popularity_range: {
      begin: raw.popularity_range.begin,
      end: raw.popularity_range.end,
    },
    seed_artist: cleanText(
      raw.seed_artist,
      512,
      "external_candidate_invalid",
    ),
    coverage: cleanText(raw.coverage, 500, "external_candidate_invalid"),
  };
}

function matchesFilters(track, filters) {
  const artist = normalizeText(track.artist_credit);
  const genres = track.labels.genres.map(normalizeText);
  if (
    filters.artists.length > 0 &&
    !filters.artists.some((candidate) => artist.includes(candidate))
  ) {
    return false;
  }
  if (
    filters.genres.length > 0 &&
    !filters.genres.some((candidate) => genres.includes(candidate))
  ) {
    return false;
  }
  if (
    filters.familiarity.length > 0 &&
    !filters.familiarity.includes(track.observation_summary.familiarity.level)
  ) {
    return false;
  }
  if (
    filters.preferenceSignals.length > 0 &&
    !filters.preferenceSignals.every((candidate) =>
      track.observation_summary.preference_signals.includes(candidate),
    )
  ) {
    return false;
  }
  return true;
}

function rawSearchFilters(filters) {
  return {
    artists: filters.artists,
    genres: filters.genres,
    familiarity: filters.familiarity,
    preferenceSignals: filters.preferenceSignals,
  };
}

function preferenceSignalLabel(observation = {}) {
  const labels = [];
  if (observation.loved === true) labels.push("Loved");
  if (observation.favorited === true) labels.push("Favorited");
  if (
    isPlainObject(observation.rating) &&
    observation.rating.computed !== true &&
    Number.isInteger(observation.rating.value) &&
    observation.rating.value >= 60
  ) {
    labels.push(`non-computed rating ${observation.rating.value}/100`);
  }
  return labels.join(", ") || "explicit provider preference signal";
}

function listenerAssertionAvoids(
  listening,
  entityType,
  label,
  artistCredit = "",
) {
  const avoids = listening?.listener_assertions?.avoids ?? [];
  const normalizedLabel = normalizeText(label ?? "");
  const normalizedArtist = normalizeText(artistCredit ?? "");
  return avoids.some((avoid) => {
    if (avoid.entity_type === "artist") {
      const avoidedArtist = normalizeText(avoid.label ?? "");
      return entityType === "artist"
        ? avoidedArtist === normalizedLabel
        : avoidedArtist === normalizedArtist;
    }
    return entityType === "track" &&
      normalizeText(avoid.label ?? "") === normalizedLabel &&
      normalizeText(avoid.artist_credit ?? "") === normalizedArtist;
  });
}

function normalizeAppleCorrectionLabels(listening, projection) {
  if (!listening || typeof projection.resolveTrackLabel !== "function") return listening;
  const resolved = new Map();
  function normalize(item) {
    if (item?.entity_type !== "track" || !item.correction_id) return item;
    if (!resolved.has(item.correction_id)) {
      const match = projection.resolveTrackLabel({
        label: item.label,
        artistCredit: item.artist_credit,
      });
      resolved.set(item.correction_id, match?.match === "legacy_display_label" ? match.title : null);
    }
    const title = resolved.get(item.correction_id);
    return title === null ? item : { ...item, label: title };
  }
  return {
    ...listening,
    listener_assertions: {
      ...listening.listener_assertions,
      active: (listening.listener_assertions?.active ?? []).map(normalize),
      preferences: (listening.listener_assertions?.preferences ?? []).map(normalize),
      avoids: (listening.listener_assertions?.avoids ?? []).map(normalize),
    },
    curated_preferences: {
      ...listening.curated_preferences,
      avoids: (listening.curated_preferences?.avoids ?? []).map(normalize),
    },
  };
}

function facetItems(preferences, field, maximum) {
  const facets = new Map();
  for (const item of preferences) {
    const name = field(item);
    if (typeof name !== "string" || !name.trim()) continue;
    const normalized = normalizeText(name);
    const current = facets.get(normalized) ?? {
      name: name.trim(),
      evidence_id: item.evidence_id,
      strength: 0,
    };
    current.strength += Number.isFinite(item.strength) ? item.strength : 0;
    facets.set(normalized, current);
  }
  return [...facets.values()]
    .sort((left, right) => {
      if (right.strength !== left.strength) return right.strength - left.strength;
      return left.name.localeCompare(right.name);
    })
    .slice(0, maximum)
    .map(({ name, evidence_id: evidenceId }) => ({
      name,
      evidence_id: evidenceId,
    }));
}

function interleaveUnique(lists, maximum, field) {
  const result = [];
  const seen = new Set();
  for (let index = 0; result.length < maximum; index += 1) {
    let added = false;
    for (const list of lists) {
      const item = list[index];
      if (!item) continue;
      added = true;
      const value = field(item);
      const key = typeof value === "string" ? normalizeText(value) : value;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
      if (result.length >= maximum) break;
    }
    if (!added) break;
  }
  return result;
}

function basisSummaryText(explanation) {
  const basis = explanation.basis_summary ?? {};
  const details = [];
  if (basis.loved === true) details.push("Loved is true");
  if (basis.favorited === true) details.push("Favorited is true");
  if (Number.isInteger(basis.play_count)) {
    details.push(`aggregate Play Count is ${basis.play_count}`);
  }
  if (isPlainObject(basis.rating)) {
    details.push(
      `rating is ${basis.rating.value}/100${
        basis.rating.computed === false ? " and is not computed" : ""
      }`,
    );
  }
  const observed =
    typeof basis.observed_at === "string"
      ? ` in the snapshot captured at ${basis.observed_at}`
      : "";
  return `${details.join(", ") || "A bounded library observation supports this claim"}${observed}.`;
}

function claimValueLabel(claim) {
  const value = claim?.value;
  if (value?.value_type === "entity") {
    return value.entity_ref?.label ?? "Referenced track";
  }
  if (value?.value_type === "string") return value.string_value;
  if (value?.value_type === "number") return String(value.number_value);
  if (value?.value_type === "boolean") return String(value.boolean_value);
  return "Bounded profile value";
}

function requestedTrackCount(intent) {
  const numeric = intent.match(
    /(?:^|[^0-9])(\d{1,2})\s*(?:首|tracks?|songs?)/iu,
  );
  if (numeric) return Number.parseInt(numeric[1], 10);
  const after = intent.match(/(?:tracks?|songs?)\s*[:=]?\s*(\d{1,2})\b/iu);
  if (after) return Number.parseInt(after[1], 10);
  const english = intent.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:tracks?|songs?)\b/iu,
  );
  if (english) return englishTrackCounts.get(english[1].toLowerCase());
  const chinese = intent.match(/([一二两三四五六七八九十]+)\s*首/u);
  if (!chinese) return undefined;
  if (chineseTrackCounts.has(chinese[1])) {
    return chineseTrackCounts.get(chinese[1]);
  }
  const parts = chinese[1].split("十");
  if (parts.length !== 2) return undefined;
  const tens = parts[0] === "" ? 1 : chineseTrackCounts.get(parts[0]);
  const ones = parts[1] === "" ? 0 : chineseTrackCounts.get(parts[1]);
  return tens && ones !== undefined ? tens * 10 + ones : undefined;
}

async function assertProjectionExists(databasePath) {
  let metadata;
  try {
    metadata = await lstat(databasePath);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      fail("projection_not_built", "The local projection has not been built.");
    }
    fail("projection_unavailable", "The local projection is unavailable.", {
      cause,
    });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("projection_unavailable", "The local projection is unavailable.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    fail("projection_permissions_invalid", "The local projection is not private.");
  }
}

async function trustedScopeFromImports(importsRoot, expectedSubjectId) {
  let batches;
  try {
    batches = await listAppleMusicImportBatches(importsRoot, {
      subjectId: expectedSubjectId,
    });
  } catch (cause) {
    fail("projection_source_invalid", "The canonical import source is invalid.", {
      cause,
    });
  }
  const subjects = new Set(batches.map((batch) => batch.manifest.subject_id));
  if (subjects.size !== 1) {
    fail(
      "projection_subject_unavailable",
      "One trusted subject scope could not be resolved from canonical imports.",
    );
  }
  const subjectId = [...subjects][0];
  if (
    expectedSubjectId !== undefined &&
    subjectId !== expectedSubjectId.toLowerCase()
  ) {
    fail(
      "projection_subject_mismatch",
      "Canonical imports do not match the trusted subject scope.",
    );
  }
  return {
    subjectId,
    inputs: batches.map((batch) => ({
      import_batch_id: batch.manifest.import_batch_id,
      captured_at: batch.manifest.source.captured_at,
      digest: computeAppleProjectionInputDigest(batch),
    })),
  };
}

export async function resolveAppleMusicSubjectId({
  importsRoot = resolveAppleMusicImportsRoot(),
  subjectId,
} = {}) {
  return (await trustedScopeFromImports(importsRoot, subjectId)).subjectId;
}

export class AppleProjectionDomainServices {
  #projection;
  #listeningHistoryStore;
  #subjectId;
  #candidateSets = new Map();

  constructor({ projection, listeningHistoryStore = null, subjectId = null }) {
    if (!projection) throw new TypeError("A trusted Apple projection is required");
    if (listeningHistoryStore && !isUuid(subjectId)) {
      throw new TypeError("A trusted listening profile subject is required");
    }
    this.#projection = projection;
    this.#listeningHistoryStore = listeningHistoryStore;
    this.#subjectId = subjectId?.toLowerCase() ?? null;
  }

  status() {
    return {
      state: "ready",
      adapter: "apple_music_sqlite_projection",
      subject_scope: "trusted_runtime",
      candidate_scope: "prompt_local",
      external_effects: "none",
    };
  }

  profileStatus() {
    const summary = this.#projection.getProfileSummary({ maxItems: 1 });
    const listening = this.#listeningHistoryStore?.profileSummary({
      subjectId: this.#subjectId,
      maxItems: 1,
    });
    return {
      state: "ready",
      projection_version: listening ? "profile-projection/1" : summary.schema_version,
      evidence_records:
        summary.coverage.evidence_records +
        (listening?.coverage.profile_evidence_records ?? 0) +
        (listening?.coverage.active_listener_assertions ?? 0),
      ...(listening
        ? {
            effective_listening_events:
              listening.coverage.effective_listening_events,
            listening_hours: listening.coverage.listening_hours,
            spotify_profile_evidence:
              listening.coverage.profile_evidence_records,
          }
        : {}),
      claims: listening?.coverage.active_listener_assertions ?? 0,
      reason:
        listening
          ? "ProfileProjection v1 combines the canonical Apple library snapshot with private effective Spotify evidence and current explicit, retractable listener assertions."
          : "ProfileProjection v0 is deterministically derived from provider-neutral library observations and can be rebuilt from the canonical import batch.",
    };
  }

  rediscoveryReady() {
    return (
      this.#listeningHistoryStore !== null &&
      typeof this.#listeningHistoryStore.rediscoveryCandidates === "function"
    );
  }

  historicalReturnReady() {
    return (
      this.#listeningHistoryStore !== null &&
      typeof this.#listeningHistoryStore.historicalReturnCandidates ===
        "function"
    );
  }

  timeCapsuleReady() {
    return (
      this.#listeningHistoryStore !== null &&
      typeof this.#listeningHistoryStore.timeCapsuleCandidates === "function"
    );
  }

  backToBackReady() {
    return (
      this.#listeningHistoryStore !== null &&
      typeof this.#listeningHistoryStore.backToBackCandidates === "function"
    );
  }

  beginPrompt() {
    return this.resetCandidateSets();
  }

  endPrompt() {
    return this.resetCandidateSets();
  }

  resetCandidateSets() {
    const invalidated = this.#candidateSets.size;
    this.#candidateSets.clear();
    return { invalidated_candidate_sets: invalidated };
  }

  async searchLibrary(argumentsValue) {
    const input = modelArguments(
      argumentsValue,
      new Set(["query", "limit", "offset", "filters"]),
    );
    const cleanedQuery = cleanQuery(input.query);
    const bounded = boundedLimit(
      input.limit,
      APPLE_DOMAIN_LIMITS.searchDefault,
      APPLE_DOMAIN_LIMITS.searchMax,
      "invalid_search_limit",
    );
    const offset = boundedOffset(
      input.offset,
      APPLE_DOMAIN_LIMITS.searchOffsetMax,
      "invalid_search_offset",
    );
    const normalizedFilters = normalizeFilters(input.filters);
    if (this.#candidateSets.size >= APPLE_DOMAIN_LIMITS.candidateSetsMax) {
      fail(
        "candidate_set_capacity_reached",
        "The prompt has reached its candidate set limit.",
      );
    }

    const rawLimit = Math.min(bounded + 1, 25);
    const raw = this.#projection.searchLibrary({
      query: cleanedQuery,
      limit: rawLimit,
      offset,
      filters: rawSearchFilters(normalizedFilters),
    });
    const filtered = raw.tracks
      .map(safeTrack)
      .filter((track) => matchesFilters(track, normalizedFilters));
    const tracks = filtered.slice(0, bounded);
    const hasMore = filtered.length > bounded || raw.tracks.length === rawLimit;
    const nextOffset = hasMore
      ? Math.min(
          offset + Math.max(tracks.length, bounded),
          APPLE_DOMAIN_LIMITS.searchOffsetMax,
        )
      : null;
    const candidateSetId = randomUUID();
    this.#candidateSets.set(
      candidateSetId,
      new Map(tracks.map((track) => [track.track_ref_id, structuredClone(track)])),
    );
    return {
      candidate_set_id: candidateSetId,
      candidate_scope: "private_library",
      result_count: tracks.length,
      limit_applied: bounded,
      offset_applied: offset,
      next_offset: nextOffset === offset ? null : nextOffset,
      has_more: hasMore && nextOffset !== offset,
      expires_on: "prompt_end",
      tracks,
    };
  }

  async getRediscoveryCandidates(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["limit"]));
    const limit = boundedLimit(
      input.limit,
      APPLE_DOMAIN_LIMITS.rediscoveryDefault,
      APPLE_DOMAIN_LIMITS.rediscoveryMax,
      "invalid_rediscovery_limit",
    );
    if (!this.rediscoveryReady()) {
      fail(
        "rediscovery_unavailable",
        "Private listening-history rediscovery is not ready.",
      );
    }
    const raw = this.#listeningHistoryStore.rediscoveryCandidates({
      subjectId: this.#subjectId,
      limit,
    });
    if (!isPlainObject(raw) || !Array.isArray(raw.tracks)) {
      fail("history_candidate_invalid", "Listening-history candidates are invalid.");
    }
    const referenceDate =
      raw.reference_date === null || raw.reference_date === undefined
        ? null
        : safeHistoryTimestamp(raw.reference_date);
    const quietDays = safeHistoryCount(raw.quiet_days);
    const minimumPlays = safeHistoryCount(raw.minimum_plays);
    const minimumEngagedPlays = safeHistoryCount(raw.minimum_engaged_plays);
    const minimumListeningMinutes = safeHistoryCount(
      raw.minimum_listening_minutes,
    );
    const tracks = raw.tracks.slice(0, limit).map(safeHistoryTrack);
    if (new Set(tracks.map((track) => track.track_ref_id)).size !== tracks.length) {
      fail("history_candidate_invalid", "Listening-history candidates are duplicated.");
    }
    if (tracks.length === 0) {
      return {
        state: "empty",
        candidate_set_id: null,
        candidate_scope: "private_history",
        result_count: 0,
        limit_applied: limit,
        reference_date: referenceDate,
        quiet_days: quietDays,
        minimum_plays: minimumPlays,
        minimum_engaged_plays: minimumEngagedPlays,
        minimum_listening_minutes: minimumListeningMinutes,
        expires_on: "prompt_end",
        tracks: [],
      };
    }
    if (referenceDate === null) {
      fail("history_candidate_invalid", "Listening-history candidates are invalid.");
    }
    if (this.#candidateSets.size >= APPLE_DOMAIN_LIMITS.candidateSetsMax) {
      fail(
        "candidate_set_capacity_reached",
        "The prompt has reached its candidate set limit.",
      );
    }
    const candidateSetId = randomUUID();
    this.#candidateSets.set(
      candidateSetId,
      new Map(
        tracks.map((track) => [track.track_ref_id, structuredClone(track)]),
      ),
    );
    return {
      state: "ready",
      candidate_set_id: candidateSetId,
      candidate_scope: "private_history",
      result_count: tracks.length,
      limit_applied: limit,
      reference_date: referenceDate,
      quiet_days: quietDays,
      minimum_plays: minimumPlays,
      minimum_engaged_plays: minimumEngagedPlays,
      minimum_listening_minutes: minimumListeningMinutes,
      expires_on: "prompt_end",
      tracks: tracks.map(publicHistoryTrack),
    };
  }

  async getHistoricalReturnCandidates(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["limit"]));
    const limit = boundedLimit(
      input.limit,
      APPLE_DOMAIN_LIMITS.historicalReturnDefault,
      APPLE_DOMAIN_LIMITS.historicalReturnMax,
      "invalid_historical_return_limit",
    );
    if (!this.historicalReturnReady()) {
      fail(
        "historical_return_unavailable",
        "Private listening-history returns are not ready.",
      );
    }
    const raw = this.#listeningHistoryStore.historicalReturnCandidates({
      subjectId: this.#subjectId,
      limit,
    });
    if (!isPlainObject(raw) || !Array.isArray(raw.tracks)) {
      fail("history_candidate_invalid", "Listening-history candidates are invalid.");
    }
    const referenceDate =
      raw.reference_date === null || raw.reference_date === undefined
        ? null
        : safeHistoryTimestamp(raw.reference_date);
    const minimumGapDays = safeHistoryCount(raw.minimum_gap_days);
    const minimumPlays = safeHistoryCount(raw.minimum_plays);
    const minimumEngagedPlays = safeHistoryCount(raw.minimum_engaged_plays);
    const minimumListeningMinutes = safeHistoryCount(
      raw.minimum_listening_minutes,
    );
    const tracks = raw.tracks.slice(0, limit).map(safeHistoryTrack);
    if (new Set(tracks.map((track) => track.track_ref_id)).size !== tracks.length) {
      fail("history_candidate_invalid", "Listening-history candidates are duplicated.");
    }
    if (tracks.length === 0) {
      return {
        state: "empty",
        candidate_set_id: null,
        candidate_scope: "private_history",
        result_count: 0,
        limit_applied: limit,
        reference_date: referenceDate,
        minimum_gap_days: minimumGapDays,
        minimum_plays: minimumPlays,
        minimum_engaged_plays: minimumEngagedPlays,
        minimum_listening_minutes: minimumListeningMinutes,
        expires_on: "prompt_end",
        tracks: [],
      };
    }
    if (referenceDate === null) {
      fail("history_candidate_invalid", "Listening-history candidates are invalid.");
    }
    if (this.#candidateSets.size >= APPLE_DOMAIN_LIMITS.candidateSetsMax) {
      fail(
        "candidate_set_capacity_reached",
        "The prompt has reached its candidate set limit.",
      );
    }
    const candidateSetId = randomUUID();
    this.#candidateSets.set(
      candidateSetId,
      new Map(
        tracks.map((track) => [track.track_ref_id, structuredClone(track)]),
      ),
    );
    return {
      state: "ready",
      candidate_set_id: candidateSetId,
      candidate_scope: "private_history",
      result_count: tracks.length,
      limit_applied: limit,
      reference_date: referenceDate,
      minimum_gap_days: minimumGapDays,
      minimum_plays: minimumPlays,
      minimum_engaged_plays: minimumEngagedPlays,
      minimum_listening_minutes: minimumListeningMinutes,
      expires_on: "prompt_end",
      tracks: tracks.map(publicHistoryTrack),
    };
  }

  async getBackToBackCandidates(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["limit"]));
    const limit = boundedLimit(
      input.limit,
      APPLE_DOMAIN_LIMITS.backToBackDefault,
      APPLE_DOMAIN_LIMITS.backToBackMax,
      "invalid_back_to_back_limit",
    );
    if (!this.backToBackReady()) {
      fail(
        "back_to_back_unavailable",
        "Private listening-history back-to-back playback is not ready.",
      );
    }
    const raw = this.#listeningHistoryStore.backToBackCandidates({
      subjectId: this.#subjectId,
      limit,
    });
    if (!isPlainObject(raw) || !Array.isArray(raw.tracks)) {
      fail("history_candidate_invalid", "Listening-history candidates are invalid.");
    }
    const referenceDate =
      raw.reference_date === null || raw.reference_date === undefined
        ? null
        : safeHistoryTimestamp(raw.reference_date);
    const minimumConsecutivePlays = safeHistoryCount(
      raw.minimum_consecutive_plays,
    );
    const minimumPlayedSeconds = safeHistoryCount(raw.minimum_played_seconds);
    const maximumGapMinutes = safeHistoryCount(raw.maximum_gap_minutes);
    if (
      minimumConsecutivePlays < 2 ||
      minimumPlayedSeconds < 1 ||
      maximumGapMinutes < 1
    ) {
      fail("history_candidate_invalid", "Listening-history candidates are invalid.");
    }
    const tracks = raw.tracks.slice(0, limit).map(safeHistoryTrack);
    if (new Set(tracks.map((track) => track.track_ref_id)).size !== tracks.length) {
      fail("history_candidate_invalid", "Listening-history candidates are duplicated.");
    }
    if (tracks.length === 0) {
      return {
        state: "empty",
        candidate_set_id: null,
        candidate_scope: "private_history",
        result_count: 0,
        limit_applied: limit,
        reference_date: referenceDate,
        minimum_consecutive_plays: minimumConsecutivePlays,
        minimum_played_seconds: minimumPlayedSeconds,
        maximum_gap_minutes: maximumGapMinutes,
        expires_on: "prompt_end",
        tracks: [],
      };
    }
    if (referenceDate === null) {
      fail("history_candidate_invalid", "Listening-history candidates are invalid.");
    }
    if (this.#candidateSets.size >= APPLE_DOMAIN_LIMITS.candidateSetsMax) {
      fail(
        "candidate_set_capacity_reached",
        "The prompt has reached its candidate set limit.",
      );
    }
    const candidateSetId = randomUUID();
    this.#candidateSets.set(
      candidateSetId,
      new Map(
        tracks.map((track) => [track.track_ref_id, structuredClone(track)]),
      ),
    );
    return {
      state: "ready",
      candidate_set_id: candidateSetId,
      candidate_scope: "private_history",
      result_count: tracks.length,
      limit_applied: limit,
      reference_date: referenceDate,
      minimum_consecutive_plays: minimumConsecutivePlays,
      minimum_played_seconds: minimumPlayedSeconds,
      maximum_gap_minutes: maximumGapMinutes,
      expires_on: "prompt_end",
      tracks: tracks.map(publicHistoryTrack),
    };
  }

  async getTimeCapsuleCandidates(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["limit"]));
    const limit = boundedLimit(
      input.limit,
      APPLE_DOMAIN_LIMITS.timeCapsuleDefault,
      APPLE_DOMAIN_LIMITS.timeCapsuleMax,
      "invalid_time_capsule_limit",
    );
    if (limit < 2) {
      fail(
        "invalid_time_capsule_limit",
        "A listening time capsule requires at least two tracks.",
      );
    }
    if (!this.timeCapsuleReady()) {
      fail(
        "time_capsule_unavailable",
        "Private listening-history Time Machine is not ready.",
      );
    }
    const raw = this.#listeningHistoryStore.timeCapsuleCandidates({
      subjectId: this.#subjectId,
      limit,
    });
    if (
      !isPlainObject(raw) ||
      !Array.isArray(raw.tracks) ||
      !Array.isArray(raw.represented_years)
    ) {
      fail("history_candidate_invalid", "Listening-history candidates are invalid.");
    }
    const optionalYear = (value) => {
      if (value === null || value === undefined) return null;
      const year = safeHistoryCount(value);
      if (year < 1900 || year > 9999) {
        fail("history_candidate_invalid", "Listening-history candidates are invalid.");
      }
      return year;
    };
    const referenceDate =
      raw.reference_date === null || raw.reference_date === undefined
        ? null
        : safeHistoryTimestamp(raw.reference_date);
    const historyStartYear = optionalYear(raw.history_start_year);
    const historyEndYear = optionalYear(raw.history_end_year);
    const minimumYears = safeHistoryCount(raw.minimum_years);
    const minimumEngagedPlays = safeHistoryCount(raw.minimum_engaged_plays);
    const minimumListeningMinutes = safeHistoryCount(
      raw.minimum_listening_minutes,
    );
    const tracks = raw.tracks.slice(0, limit).map(safeHistoryTrack);
    const representedYears = raw.represented_years.map(optionalYear);
    const trackYears = tracks.map((track) => track.time_capsule?.year);
    if (
      representedYears.some((year) => year === null) ||
      representedYears.length !== tracks.length ||
      new Set(tracks.map((track) => track.track_ref_id)).size !== tracks.length ||
      new Set(trackYears).size !== trackYears.length ||
      representedYears.some((year, index) => year !== trackYears[index]) ||
      trackYears.some((year, index) => index > 0 && year <= trackYears[index - 1])
    ) {
      fail("history_candidate_invalid", "Listening-history candidates are invalid.");
    }
    if (tracks.length === 0) {
      return {
        state: "empty",
        candidate_set_id: null,
        candidate_scope: "private_history",
        result_count: 0,
        limit_applied: limit,
        reference_date: referenceDate,
        history_start_year: historyStartYear,
        history_end_year: historyEndYear,
        minimum_years: minimumYears,
        minimum_engaged_plays: minimumEngagedPlays,
        minimum_listening_minutes: minimumListeningMinutes,
        represented_years: [],
        expires_on: "prompt_end",
        tracks: [],
      };
    }
    if (
      tracks.length < minimumYears ||
      referenceDate === null ||
      historyStartYear === null ||
      historyEndYear === null ||
      historyStartYear > historyEndYear ||
      trackYears[0] < historyStartYear ||
      trackYears.at(-1) > historyEndYear
    ) {
      fail("history_candidate_invalid", "Listening-history candidates are invalid.");
    }
    if (this.#candidateSets.size >= APPLE_DOMAIN_LIMITS.candidateSetsMax) {
      fail(
        "candidate_set_capacity_reached",
        "The prompt has reached its candidate set limit.",
      );
    }
    const candidateSetId = randomUUID();
    this.#candidateSets.set(
      candidateSetId,
      new Map(
        tracks.map((track) => [track.track_ref_id, structuredClone(track)]),
      ),
    );
    return {
      state: "ready",
      candidate_set_id: candidateSetId,
      candidate_scope: "private_history",
      result_count: tracks.length,
      limit_applied: limit,
      reference_date: referenceDate,
      history_start_year: historyStartYear,
      history_end_year: historyEndYear,
      minimum_years: minimumYears,
      minimum_engaged_plays: minimumEngagedPlays,
      minimum_listening_minutes: minimumListeningMinutes,
      represented_years: representedYears,
      expires_on: "prompt_end",
      tracks: tracks.map(publicHistoryTrack),
    };
  }

  registerExternalCandidateSet({ tracks, source } = {}) {
    if (
      !Array.isArray(tracks) ||
      tracks.length < 1 ||
      tracks.length > APPLE_DOMAIN_LIMITS.playlistTracksMax
    ) {
      fail("external_candidate_invalid", "External catalog candidates are invalid.");
    }
    if (this.#candidateSets.size >= APPLE_DOMAIN_LIMITS.candidateSetsMax) {
      fail(
        "candidate_set_capacity_reached",
        "The prompt has reached its candidate set limit.",
      );
    }
    const trustedSource = safeExternalSource(source);
    const prepared = tracks.map(safeExternalTrack);
    if (new Set(prepared.map((track) => track.track_ref_id)).size !== prepared.length) {
      fail("external_candidate_invalid", "External catalog candidates are duplicated.");
    }
    const accepted = [];
    let excludedLibraryMatches = 0;
    for (const track of prepared) {
      const query = Array.from(track.title).slice(0, 256).join("");
      const libraryResults = this.#projection.searchLibrary({
        query,
        limit: 25,
        offset: 0,
        filters: {
          artists: [],
          genres: [],
          familiarity: [],
          preferenceSignals: [],
        },
      });
      const libraryMatch = libraryResults.tracks
        .map(safeTrack)
        .some((candidate) => exactTitleArtistMatch(track, candidate));
      if (libraryMatch) {
        excludedLibraryMatches += 1;
        continue;
      }
      accepted.push({
        ...track,
        knownness: {
          imported_library: "not_found_by_exact_title_artist",
          listening_history: "not_checked",
        },
      });
    }
    if (accepted.length === 0) {
      return {
        candidate_set_id: null,
        candidate_scope: "external_catalog",
        result_count: 0,
        excluded_library_matches: excludedLibraryMatches,
        expires_on: "prompt_end",
        source: trustedSource,
        tracks: [],
      };
    }
    const candidateSetId = randomUUID();
    this.#candidateSets.set(
      candidateSetId,
      new Map(
        accepted.map((track) => [track.track_ref_id, structuredClone(track)]),
      ),
    );
    return {
      candidate_set_id: candidateSetId,
      candidate_scope: "external_catalog",
      result_count: accepted.length,
      excluded_library_matches: excludedLibraryMatches,
      expires_on: "prompt_end",
      source: trustedSource,
      tracks: accepted,
    };
  }

  registerRetainedPlaylistCandidateSet({ tracks } = {}) {
    if (
      !Array.isArray(tracks) ||
      tracks.length < 1 ||
      tracks.length > APPLE_DOMAIN_LIMITS.playlistTracksMax
    ) {
      fail(
        "retained_candidate_invalid",
        "Retained playlist candidates are invalid.",
      );
    }
    if (this.#candidateSets.size >= APPLE_DOMAIN_LIMITS.candidateSetsMax) {
      fail(
        "candidate_set_capacity_reached",
        "The prompt has reached its candidate set limit.",
      );
    }
    const prepared = tracks.map(safeRetainedPlaylistTrack);
    if (
      new Set(prepared.map((track) => track.track_ref_id)).size !==
      prepared.length
    ) {
      fail(
        "retained_candidate_invalid",
        "Retained playlist candidates are duplicated.",
      );
    }
    const candidateSetId = randomUUID();
    this.#candidateSets.set(
      candidateSetId,
      new Map(
        prepared.map((track) => [track.track_ref_id, structuredClone(track)]),
      ),
    );
    const scopes = new Set(
      prepared.map((track) => track.candidate_scope ?? "private_library"),
    );
    return {
      candidate_set_id: candidateSetId,
      candidate_scope: scopes.size === 1 ? [...scopes][0] : "mixed",
      result_count: prepared.length,
      expires_on: "prompt_end",
      source: "retained_validated_playlist",
      tracks: structuredClone(prepared),
    };
  }

  getTrustedTracks(trackRefIds) {
    if (
      !Array.isArray(trackRefIds) ||
      trackRefIds.length < 1 ||
      trackRefIds.length > APPLE_DOMAIN_LIMITS.playlistTracksMax
    ) {
      fail("invalid_track_refs", "Trusted track references are invalid.");
    }
    const results = [];
    for (const trackRefId of trackRefIds) {
      const cleanedId = cleanText(trackRefId, 128, "invalid_track_refs");
      let track = null;
      for (const candidateSet of this.#candidateSets.values()) {
        if (candidateSet.has(cleanedId)) {
          track = candidateSet.get(cleanedId);
          break;
        }
      }
      if (!track) {
        fail(
          "untrusted_track_ref",
          "A referenced track was not returned by the trusted candidate sets.",
        );
      }
      results.push(track);
    }
    return structuredClone(results);
  }

  async getLyricSeeds() {
    const profile = await this.getProfileSummary({ maxItems: 10 });
    const listening = this.#listeningHistoryStore?.lyricProfile({ subjectId: this.#subjectId });
    return {
      subjectId: this.#subjectId,
      tracks: lyricSeedsFromProfile({
        ...profile, ...listening,
        strong_preferences: profile.strong_preferences,
        familiarity: profile.familiarity,
      }),
    };
  }

  async getProfileSummary(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["maxItems"]));
    const bounded = boundedLimit(
      input.maxItems,
      APPLE_DOMAIN_LIMITS.profileDefault,
      APPLE_DOMAIN_LIMITS.profileMax,
      "invalid_profile_limit",
    );
    const raw = this.#projection.getProfileSummary({ maxItems: 50 });
    const listening = normalizeAppleCorrectionLabels(
      this.#listeningHistoryStore?.profileSummary({
        subjectId: this.#subjectId,
        maxItems: bounded,
      }),
      this.#projection,
    );
    const preferenceItems = (raw.preference ?? [])
      .filter(
        (item) =>
          item.direction === "supports" &&
          !listenerAssertionAvoids(
            listening,
            "track",
            item.label,
            item.artist_credit,
          ),
      )
      .slice(0, bounded);
    const familiarityItems = (raw.familiarity ?? [])
      .filter((item) => item.direction === "supports")
      .slice(0, bounded);
    const appleStrongPreferences = preferenceItems.map((item) => ({
      label: item.label,
      entity_type: "track",
      artist_credit: item.artist_credit,
      track_ref_id: item.track_ref?.track_ref_id,
      source: "Apple Music library preference",
      observed_at: item.observed_at,
      confidence: item.confidence,
      signal: preferenceSignalLabel(item.observation_summary),
      evidence_id: item.evidence_id,
    }));
    const listenerStrongPreferences = (
      listening?.listener_assertions?.preferences ?? []
    ).map((item) => ({
      label: item.label,
      entity_type: item.entity_type,
      ...(item.artist_credit ? { artist_credit: item.artist_credit } : {}),
      signal: `You explicitly said you like this ${item.entity_type}`,
      evidence_id: item.evidence_id,
    }));
    const spotifyStrongPreferences = listening
      ? listening.curated_preferences.saved_tracks
          .filter(
            (item) =>
              !listenerAssertionAvoids(
                listening,
                "track",
                item.label,
                item.artist_credit,
              ),
          )
          .map((item) => ({
            label: item.label,
            entity_type: "track",
            artist_credit: item.artist_credit,
            track_ref_id: item.track_ref_id,
            signal: `Saved in ${item.source_label ?? "Spotify"} library`,
            evidence_id: item.evidence_id,
          }))
      : [];
    const appleFamiliarity = familiarityItems.map((item) => {
      const playCount = item.observation_summary?.play_count;
      const result = {
        label: item.label,
        entity_type: "track",
        artist_credit: item.artist_credit,
        track_ref_id: item.track_ref?.track_ref_id,
        source: "Apple Music aggregate play count",
        observed_at: item.observed_at,
        confidence: item.confidence,
        level: familiarityLevel(playCount),
        evidence_id: item.evidence_id,
      };
      if (Number.isInteger(playCount)) result.play_count = playCount;
      return result;
    });
    const spotifyFamiliarity =
      listening?.listening_behavior.repeat_tracks.map((item) => ({
        label: item.label,
        entity_type: "track",
        artist_credit: item.artist_credit,
        track_ref_id: item.track_ref_id,
        level: familiarityLevel(item.play_count),
        play_count: item.play_count,
        evidence_id: item.evidence_id,
      })) ?? [];
    const appleArtistFacets = facetItems(
      preferenceItems,
      (item) => item.artist_credit,
      bounded,
    ).filter(
      (item) => !listenerAssertionAvoids(listening, "artist", item.name),
    );
    const spotifyArtistFacets = [
      ...(listening?.curated_preferences.followed_artists ?? []),
      ...(listening?.listening_behavior.enduring_artists ?? []),
      ...(listening?.provider_signals.artists ?? []),
    ]
      .filter(
        (item) => !listenerAssertionAvoids(listening, "artist", item.name),
      )
      .map((item) => ({
        name: item.name,
        evidence_id: item.evidence_id,
      }));
    const appleGenreFacets = facetItems(
      preferenceItems,
      (item) => item.labels?.provider_genre,
      bounded,
    );
    const spotifyGenreFacets = (listening?.provider_signals.genres ?? []).map(
      (item) => ({ name: item.name, evidence_id: item.evidence_id }),
    );
    return {
      profile_version: listening ? "profile-projection/1" : raw.schema_version,
      max_items_applied: bounded,
      strong_preferences: interleaveUnique(
        [
          listenerStrongPreferences,
          appleStrongPreferences,
          spotifyStrongPreferences,
        ],
        bounded,
        (item) => JSON.stringify([item.entity_type, item.label, item.artist_credit ?? ""]),
      ),
      familiarity: interleaveUnique(
        [appleFamiliarity, spotifyFamiliarity],
        bounded,
        (item) => JSON.stringify([item.entity_type, item.label, item.artist_credit ?? ""]),
      ),
      artist_facets: interleaveUnique(
        [appleArtistFacets, spotifyArtistFacets],
        bounded,
        (item) => item.name,
      ),
      genre_facets: interleaveUnique(
        [appleGenreFacets, spotifyGenreFacets],
        bounded,
        (item) => item.name,
      ),
      coverage: {
        tracks_observed: raw.coverage.current_tracks,
        loved_or_favorited: raw.coverage.loved_or_favorited,
        aggregate_play_count: raw.coverage.aggregate_play_count,
        non_computed_rating: raw.coverage.non_computed_rating,
        ...(listening
          ? {
              effective_listening_events:
                listening.coverage.effective_listening_events,
              profiled_listening_events:
                listening.coverage.profiled_listening_events,
              listening_hours: listening.coverage.listening_hours,
              listening_tracks: listening.coverage.distinct_tracks,
              resolved_listening_tracks: listening.coverage.resolved_tracks,
              cross_format_track_links:
                listening.coverage.cross_format_track_links,
              cross_format_linked_events:
                listening.coverage.cross_format_linked_events,
              cross_format_ambiguous_tracks:
                listening.coverage.cross_format_ambiguous_tracks,
              cross_format_ambiguous_events:
                listening.coverage.cross_format_ambiguous_events,
              ...collectionCoverage(listening.coverage),
              verified_search_interactions:
                listening.coverage.verified_search_interactions,
              listener_assertion_events:
                listening.coverage.listener_assertion_events,
              active_listener_assertions:
                listening.coverage.active_listener_assertions,
              listener_retractions:
                listening.coverage.listener_retractions,
            }
          : {}),
      },
      source: {
        kind: "provider_library_snapshot",
        captured_at: raw.coverage.source_timestamp,
      },
      ...(listening
        ? {
            listening_behavior: listening.listening_behavior,
            curated_preferences: listening.curated_preferences,
            listener_assertions: listening.listener_assertions,
            search_intent: listening.search_intent,
            provider_signals: listening.provider_signals,
            listening_source: listening.source,
          }
        : {}),
      limitations: [
        ...(raw.limitations ?? []),
        ...(listening?.limitations ?? []),
      ].slice(0, 8),
    };
  }

  async explainProfileEvidence(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["evidenceId"]));
    const cleanedId = cleanText(
      input.evidenceId,
      128,
      "invalid_evidence_id",
    );
    if (!isUuid(cleanedId)) {
      fail("invalid_evidence_id", "Profile evidence ID is invalid.");
    }
    const raw = this.#projection.explainProfileEvidence({
      evidenceId: cleanedId,
    });
    if (!raw) {
      const listening = this.#listeningHistoryStore?.explainProfileEvidence({
        subjectId: this.#subjectId,
        evidenceId: cleanedId,
      });
      if (listening) return listening;
      fail(
        "profile_evidence_unavailable",
        "Profile evidence is unavailable in the trusted subject scope.",
      );
    }
    return {
      evidence_id: raw.evidence_id,
      claim: {
        dimension: raw.claim.dimension,
        value: claimValueLabel(raw.claim),
        direction: raw.direction,
      },
      basis_summary: basisSummaryText(raw),
      derivation: {
        kind: raw.derivation.kind,
        name: raw.derivation.name,
        version: raw.derivation.version,
      },
      confidence: raw.confidence,
      interpretation_limit: raw.limitation,
    };
  }

  async buildPlaylistPlan(argumentsValue) {
    const input = modelArguments(
      argumentsValue,
      new Set([
        "intent",
        "requestedTrackCount",
        "candidateSetIds",
        "trackRefs",
        "orderingNotes",
      ]),
    );
    const {
      intent,
      requestedTrackCount: explicitRequestedCount,
      candidateSetIds,
      trackRefs,
      orderingNotes,
    } = input;
    const cleanedIntent = cleanText(
      intent,
      APPLE_DOMAIN_LIMITS.longTextMax,
      "invalid_playlist_intent",
    );
    const orderingRationale = cleanText(
      orderingNotes,
      APPLE_DOMAIN_LIMITS.longTextMax,
      "invalid_ordering_notes",
    );
    if (
      !Array.isArray(candidateSetIds) ||
      candidateSetIds.length < 1 ||
      candidateSetIds.length > APPLE_DOMAIN_LIMITS.candidateSetsMax ||
      new Set(candidateSetIds).size !== candidateSetIds.length
    ) {
      fail("invalid_candidate_sets", "Playlist candidate sets are invalid.");
    }
    const trustedTracks = new Map();
    for (const candidateSetId of candidateSetIds) {
      const cleanedId = cleanText(
        candidateSetId,
        128,
        "invalid_candidate_sets",
      );
      const candidateSet = this.#candidateSets.get(cleanedId);
      if (!candidateSet) {
        fail(
          "candidate_set_unavailable",
          "A playlist candidate set is unavailable or expired.",
        );
      }
      for (const [trackId, track] of candidateSet) trustedTracks.set(trackId, track);
    }
    if (
      !Array.isArray(trackRefs) ||
      trackRefs.length < 1 ||
      trackRefs.length > APPLE_DOMAIN_LIMITS.playlistTracksMax
    ) {
      fail("invalid_track_refs", "Playlist track references are invalid.");
    }
    const selections = trackRefs.map((entry) => {
      if (!isPlainObject(entry)) {
        fail("invalid_track_refs", "Playlist track references are invalid.");
      }
      const allowed = new Set(["trackRefId", "selectionReason"]);
      if (Object.keys(entry).some((key) => !allowed.has(key))) {
        fail("invalid_track_refs", "Playlist track references are invalid.");
      }
      return {
        trackRefId: cleanText(
          entry.trackRefId,
          128,
          "invalid_track_refs",
        ),
        selectionReason: cleanText(
          entry.selectionReason,
          APPLE_DOMAIN_LIMITS.shortTextMax,
          "invalid_selection_reason",
        ),
      };
    });
    const selectedIds = selections.map((selection) => selection.trackRefId);
    if (new Set(selectedIds).size !== selectedIds.length) {
      fail("duplicate_track_ref", "A playlist plan cannot contain duplicate tracks.");
    }
    if (selectedIds.some((trackId) => !trustedTracks.has(trackId))) {
      fail(
        "untrusted_track_ref",
        "A playlist track was not returned by the trusted candidate sets.",
      );
    }
    if (
      !Number.isInteger(explicitRequestedCount) ||
      explicitRequestedCount < 1 ||
      explicitRequestedCount > APPLE_DOMAIN_LIMITS.playlistTracksMax
    ) {
      fail(
        "playlist_intent_count_unsupported",
        "The requested playlist size is outside the supported range.",
      );
    }
    const inferredRequestedCount = requestedTrackCount(cleanedIntent);
    if (
      inferredRequestedCount !== undefined &&
      inferredRequestedCount !== explicitRequestedCount
    ) {
      fail(
        "playlist_track_count_mismatch",
        "The playlist track count does not match the explicit user intent.",
      );
    }
    const requestedCount = explicitRequestedCount;
    if (requestedCount !== selections.length) {
      fail(
        "playlist_track_count_mismatch",
        "The playlist track count does not match the explicit user intent.",
      );
    }
    const tracks = selections.map((selection, index) => {
      const track = trustedTracks.get(selection.trackRefId);
      const result = {
        position: index + 1,
        track_ref_id: track.track_ref_id,
        title: track.title,
        artist_credit: track.artist_credit,
        release: track.release,
        candidate_scope: track.candidate_scope ?? "private_library",
        selection_reason: selection.selectionReason,
      };
      if (track.duration_ms !== undefined) result.duration_ms = track.duration_ms;
      if (isPlainObject(track.time_capsule)) {
        result.history_context = {
          kind: "time_capsule",
          year: track.time_capsule.year,
        };
      } else if (isPlainObject(track.historical_return)) {
        result.history_context = { kind: "historical_return" };
      } else if (isPlainObject(track.back_to_back)) {
        result.history_context = { kind: "back_to_back" };
      } else if (isPlainObject(track.rediscovery)) {
        result.history_context = { kind: "rediscovery" };
      }
      if (
        track.candidate_scope === "external_catalog" &&
        track.catalog_provider === "apple_music" &&
        track.catalog_url
      ) {
        result.public_catalog_reference = {
          provider: "apple_music",
          url: track.catalog_url,
        };
      }
      return result;
    });
    const selectedScopes = new Set(
      tracks.map((track) => track.candidate_scope),
    );
    assertExternalPlanDiversity(tracks, cleanedIntent);
    return {
      plan_version: "playlist_plan/0",
      intent: cleanedIntent,
      requested_track_count: requestedCount ?? null,
      track_count: tracks.length,
      tracks,
      candidate_scope:
        selectedScopes.size === 1 ? [...selectedScopes][0] : "mixed",
      ordering_rationale: orderingRationale,
      candidate_sets_validated: candidateSetIds.length,
      persistence: "none",
      external_effects: "none",
    };
  }

  close() {
    this.resetCandidateSets();
    try {
      this.#projection.close();
    } finally {
      this.#listeningHistoryStore?.close?.();
    }
  }
}

export function createAppleProjectionDomainServices({
  projection,
  listeningHistoryStore,
  subjectId,
}) {
  return new AppleProjectionDomainServices({
    projection,
    listeningHistoryStore,
    subjectId,
  });
}

export async function openAppleProjectionDomainServices({
  databasePath = resolveAppleMusicProjectionPath(),
  importsRoot = resolveAppleMusicImportsRoot(),
  subjectId,
  listeningHistoryStore,
} = {}) {
  await assertProjectionExists(databasePath);
  const trustedScope = await trustedScopeFromImports(importsRoot, subjectId);
  const projection = await openAppleMusicSqliteProjection({
    databasePath,
    subjectId: trustedScope.subjectId,
    expectedInputs: trustedScope.inputs,
  });
  return createAppleProjectionDomainServices({
    projection,
    listeningHistoryStore,
    subjectId: trustedScope.subjectId,
  });
}
