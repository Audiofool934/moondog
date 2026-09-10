import { randomUUID } from "node:crypto";

export const SYNTHETIC_DOMAIN_LIMITS = Object.freeze({
  searchDefault: 8,
  searchMax: 12,
  searchOffsetMax: 10_000,
  profileDefault: 6,
  profileMax: 10,
  activeCandidateSetsMax: 8,
  playlistTracksMax: 12,
  filterValuesMax: 4,
  labelsMax: 4,
  limitationsMax: 4,
  queryLengthMax: 256,
  shortTextLengthMax: 256,
  longTextLengthMax: 500,
});

export const LIBRARY_SEARCH_FILTER_VALUES = Object.freeze({
  familiarity: Object.freeze(["low", "medium", "high", "unknown"]),
  preferenceSignals: Object.freeze(["loved", "favorited", "rated"]),
});

const familiarityValues = new Set(LIBRARY_SEARCH_FILTER_VALUES.familiarity);
const preferenceSignalValues = new Set(
  LIBRARY_SEARCH_FILTER_VALUES.preferenceSignals,
);
const externalCatalogProviders = new Set(["apple_music", "listenbrainz"]);
const listenBrainzModes = new Set(["easy", "medium", "hard"]);
const filterKeys = new Set([
  "artists",
  "genres",
  "familiarity",
  "preferenceSignals",
]);

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
  ["十一", 11],
  ["十二", 12],
]);

export class DomainServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainServiceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new DomainServiceError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length === 0) return undefined;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 3))}...`;
}

function trustedSubjectId(subjectScope) {
  const candidate =
    typeof subjectScope === "string"
      ? subjectScope
      : isPlainObject(subjectScope)
        ? (subjectScope.subjectId ?? subjectScope.subject_id)
        : undefined;
  const subjectId = cleanText(candidate, SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax);
  if (!subjectId) {
    fail(
      "trusted_subject_scope_required",
      "A trusted subject scope is required to construct domain services.",
    );
  }
  return subjectId;
}

function modelArguments(value, allowedKeys) {
  const input = value ?? {};
  if (!isPlainObject(input)) {
    fail("invalid_arguments", "Domain service arguments are invalid.");
  }
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    fail("invalid_arguments", "Domain service arguments are invalid.");
  }
  return input;
}

function requiredInputText(value, maxLength, code) {
  if (typeof value !== "string" || value.length > maxLength) {
    fail(code, "A required domain service text value is invalid.");
  }
  const result = cleanText(value, maxLength);
  if (!result) {
    fail(code, "A required domain service text value is invalid.");
  }
  return result;
}

function searchQueryText(value) {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length > SYNTHETIC_DOMAIN_LIMITS.queryLengthMax
  ) {
    fail("invalid_query", "The library search query is invalid.");
  }
  return cleanText(value, SYNTHETIC_DOMAIN_LIMITS.queryLengthMax) ?? "";
}

function boundedResultCount(value, defaultValue, maximum, code) {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1) {
    fail(code, "A domain service result limit is invalid.");
  }
  return Math.min(value, maximum);
}

function boundedOffset(value, maximum, code) {
  const offset = value ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > maximum) {
    fail(code, "A domain service offset is invalid.");
  }
  return offset;
}

function requiredFixtureText(value) {
  const result = cleanText(value, SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax);
  if (!result) {
    fail("synthetic_fixture_invalid", "The synthetic domain fixture is invalid.");
  }
  return result;
}

function safeFixtureText(value, maximum = SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax) {
  return cleanText(value, maximum);
}

function safeStringArray(values, maximum = SYNTHETIC_DOMAIN_LIMITS.labelsMax) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (const value of values) {
    const item = safeFixtureText(value);
    if (item && !result.includes(item)) result.push(item);
    if (result.length === maximum) break;
  }
  return result;
}

function normalizeInternalTrack(record) {
  if (!isPlainObject(record)) {
    fail("synthetic_fixture_invalid", "The synthetic domain fixture is invalid.");
  }
  const preferenceSignals = safeStringArray(record.observation?.preference_signals)
    .map((value) => value.toLowerCase())
    .filter((value) => preferenceSignalValues.has(value));
  const familiarity = safeFixtureText(record.observation?.familiarity)?.toLowerCase();
  const playCount = record.observation?.play_count;
  const durationMs = record.duration_ms;

  return {
    trackRefId: requiredFixtureText(record.track_ref_id),
    title: requiredFixtureText(record.title),
    artistCredit: requiredFixtureText(record.artist_credit),
    release: requiredFixtureText(record.release),
    durationMs:
      Number.isInteger(durationMs) && durationMs >= 0 && durationMs <= 86_400_000
        ? durationMs
        : undefined,
    genres: safeStringArray(record.labels?.genres),
    composer: safeFixtureText(record.labels?.composer),
    preferenceSignals,
    familiarity: familiarityValues.has(familiarity) ? familiarity : "unknown",
    playCount:
      Number.isInteger(playCount) && playCount >= 0 ? playCount : undefined,
    searchTerms: safeStringArray(record.search_terms, 16),
    rank: Number.isFinite(record.rank) ? record.rank : 0,
  };
}

function safeTrackResult(track) {
  const labels = { genres: [...track.genres] };
  if (track.composer) labels.composer = track.composer;

  const familiarity = {
    level: track.familiarity,
    basis:
      track.playCount === undefined
        ? "not_observed"
        : "aggregate_play_count",
  };
  if (track.playCount !== undefined) familiarity.play_count = track.playCount;

  const result = {
    track_ref_id: track.trackRefId,
    title: track.title,
    artist_credit: track.artistCredit,
    release: track.release,
    labels,
    observation_summary: {
      preference_signals: [...track.preferenceSignals],
      familiarity,
    },
  };
  if (track.durationMs !== undefined) result.duration_ms = track.durationMs;
  if (track.candidateScope === "external_catalog") {
    result.candidate_scope = "external_catalog";
    result.catalog_provider = track.catalogProvider;
    if (track.catalogProvider === "apple_music") {
      result.matched_queries = [...(track.matchedQueries ?? [])];
    }
    if (track.catalogProvider === "listenbrainz") {
      result.discovery_basis = structuredClone(track.discoveryBasis);
    }
    result.knownness = {
      imported_library: "not_found_by_exact_title_artist",
      listening_history: "not_checked",
    };
    if (track.primaryGenre) result.primary_genre = track.primaryGenre;
    if (track.releaseDate) result.release_date = track.releaseDate;
    if (track.catalogUrl) result.catalog_url = track.catalogUrl;
  }
  return result;
}

function normalizeExternalInternalTrack(raw, provider) {
  if (
    !isPlainObject(raw) ||
    raw.candidate_scope !== "external_catalog" ||
    raw.catalog_provider !== provider ||
    !externalCatalogProviders.has(provider)
  ) {
    fail("external_candidate_invalid", "An external catalog candidate is invalid.");
  }
  const internal = {
    trackRefId: requiredInputText(
      raw.track_ref_id,
      SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
      "external_candidate_invalid",
    ),
    title: requiredInputText(
      raw.title,
      SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
      "external_candidate_invalid",
    ),
    artistCredit: requiredInputText(
      raw.artist_credit,
      SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
      "external_candidate_invalid",
    ),
    release: requiredInputText(
      raw.release,
      SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
      "external_candidate_invalid",
    ),
    durationMs:
      Number.isInteger(raw.duration_ms) && raw.duration_ms >= 0
        ? raw.duration_ms
        : undefined,
    genres: safeStringArray(raw.primary_genre ? [raw.primary_genre] : []),
    composer: undefined,
    preferenceSignals: [],
    familiarity: "unknown",
    playCount: undefined,
    searchTerms: [],
    rank: 0,
    candidateScope: "external_catalog",
    catalogProvider: provider,
    primaryGenre: safeFixtureText(raw.primary_genre, 128),
    releaseDate: safeFixtureText(raw.release_date, 10),
    catalogUrl: safeFixtureText(raw.catalog_url, 2_048),
    matchedQueries: safeStringArray(raw.matched_queries, 3),
    discoveryBasis:
      provider === "listenbrainz" &&
      isPlainObject(raw.discovery_basis) &&
      raw.discovery_basis.kind ===
        "listenbrainz_collaborative_artist_similarity" &&
      listenBrainzModes.has(raw.discovery_basis.mode)
        ? {
            kind: "listenbrainz_collaborative_artist_similarity",
            seed_artist: requiredInputText(
              raw.discovery_basis.seed_artist,
              SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
              "external_candidate_invalid",
            ),
            adjacent_artist: requiredInputText(
              raw.discovery_basis.adjacent_artist,
              SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
              "external_candidate_invalid",
            ),
            mode: raw.discovery_basis.mode,
          }
        : undefined,
  };
  if (provider === "listenbrainz" && !internal.discoveryBasis) {
    fail("external_candidate_invalid", "An external catalog candidate is invalid.");
  }
  return internal;
}

function normalizeSearchText(value) {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function searchScore(track, tokens) {
  if (tokens.length === 0) return 0;
  const haystack = normalizeSearchText(
    [
      track.title,
      track.artistCredit,
      track.release,
      ...track.genres,
      track.composer,
      ...track.searchTerms,
    ]
      .filter(Boolean)
      .join(" "),
  );
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function normalizeFilterValues(value, allowedValues) {
  if (value === undefined) return [];
  const input = Array.isArray(value) ? value : [value];
  if (input.length > SYNTHETIC_DOMAIN_LIMITS.filterValuesMax) {
    fail("invalid_filters", "Library search filters are invalid.");
  }
  const normalized = input.map((item) =>
    requiredInputText(
      item,
      SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
      "invalid_filters",
    ).toLowerCase(),
  );
  if (allowedValues && normalized.some((item) => !allowedValues.has(item))) {
    fail("invalid_filters", "Library search filters are invalid.");
  }
  return [...new Set(normalized)];
}

function normalizeFilters(value) {
  if (value === undefined) {
    return {
      artists: [],
      genres: [],
      familiarity: [],
      preferenceSignals: [],
    };
  }
  if (!isPlainObject(value) || Object.keys(value).some((key) => !filterKeys.has(key))) {
    fail("invalid_filters", "Library search filters are invalid.");
  }
  return {
    artists: normalizeFilterValues(value.artists),
    genres: normalizeFilterValues(value.genres),
    familiarity: normalizeFilterValues(value.familiarity, familiarityValues),
    preferenceSignals: normalizeFilterValues(
      value.preferenceSignals,
      preferenceSignalValues,
    ),
  };
}

function matchesFilters(track, filters) {
  const artist = normalizeSearchText(track.artistCredit);
  const genres = track.genres.map(normalizeSearchText);
  if (
    filters.artists.length > 0 &&
    !filters.artists.some((item) => artist.includes(normalizeSearchText(item)))
  ) {
    return false;
  }
  if (
    filters.genres.length > 0 &&
    !filters.genres.some((item) => genres.includes(normalizeSearchText(item)))
  ) {
    return false;
  }
  if (
    filters.familiarity.length > 0 &&
    !filters.familiarity.includes(track.familiarity)
  ) {
    return false;
  }
  if (
    filters.preferenceSignals.length > 0 &&
    !filters.preferenceSignals.every((item) =>
      track.preferenceSignals.includes(item),
    )
  ) {
    return false;
  }
  return true;
}

function normalizeProfileItem(item, kind) {
  if (!isPlainObject(item)) return undefined;
  const evidenceId = safeFixtureText(item.evidence_id);
  if (kind === "strong_preference") {
    const label = safeFixtureText(item.label);
    const signal = safeFixtureText(item.signal);
    if (!label || !signal || !evidenceId) return undefined;
    return { label, signal, evidence_id: evidenceId };
  }
  if (kind === "familiarity") {
    const label = safeFixtureText(item.label);
    const level = safeFixtureText(item.level)?.toLowerCase();
    if (!label || !familiarityValues.has(level) || !evidenceId) return undefined;
    const result = { label, level, evidence_id: evidenceId };
    if (Number.isInteger(item.play_count) && item.play_count >= 0) {
      result.play_count = item.play_count;
    }
    return result;
  }
  const name = safeFixtureText(item.name);
  if (!name || !evidenceId) return undefined;
  return { name, evidence_id: evidenceId };
}

function normalizeProfile(profile) {
  const safeItems = (value, kind) =>
    (Array.isArray(value) ? value : [])
      .map((item) => normalizeProfileItem(item, kind))
      .filter(Boolean);
  const coverage = isPlainObject(profile?.coverage) ? profile.coverage : {};
  const safeCount = (value) =>
    Number.isInteger(value) && value >= 0 ? value : 0;

  return {
    strongPreferences: safeItems(profile?.strong_preferences, "strong_preference"),
    familiarity: safeItems(profile?.familiarity, "familiarity"),
    artistFacets: safeItems(profile?.artist_facets, "facet"),
    genreFacets: safeItems(profile?.genre_facets, "facet"),
    coverage: {
      tracks_observed: safeCount(coverage.tracks_observed),
      loved_or_favorited: safeCount(coverage.loved_or_favorited),
      aggregate_play_count: safeCount(coverage.aggregate_play_count),
      non_computed_rating: safeCount(coverage.non_computed_rating),
    },
    source: {
      kind: "synthetic_library_snapshot",
      captured_at:
        safeFixtureText(profile?.source?.captured_at) ?? "2026-08-25T00:00:00.000Z",
    },
    limitations: safeStringArray(
      profile?.limitations,
      SYNTHETIC_DOMAIN_LIMITS.limitationsMax,
    ),
  };
}

function normalizeEvidence(record) {
  if (!isPlainObject(record)) return undefined;
  const evidenceId = safeFixtureText(record.evidence_id);
  const dimension = safeFixtureText(record.claim?.dimension);
  const value = safeFixtureText(record.claim?.value);
  const direction = safeFixtureText(record.claim?.direction);
  const basisSummary = safeFixtureText(
    record.basis_summary,
    SYNTHETIC_DOMAIN_LIMITS.longTextLengthMax,
  );
  const interpretationLimit = safeFixtureText(
    record.interpretation_limit,
    SYNTHETIC_DOMAIN_LIMITS.longTextLengthMax,
  );
  const kind = safeFixtureText(record.derivation?.kind);
  const name = safeFixtureText(record.derivation?.name);
  const version = safeFixtureText(record.derivation?.version);
  if (
    !evidenceId ||
    !dimension ||
    !value ||
    !direction ||
    !basisSummary ||
    !interpretationLimit ||
    !kind ||
    !name ||
    !version ||
    !Number.isFinite(record.confidence)
  ) {
    return undefined;
  }
  return {
    evidence_id: evidenceId,
    claim: { dimension, value, direction },
    basis_summary: basisSummary,
    derivation: { kind, name, version },
    confidence: Math.max(0, Math.min(record.confidence, 1)),
    interpretation_limit: interpretationLimit,
  };
}

function requestedTrackCount(intent) {
  const numericBeforeUnit = intent.match(
    /(?:^|[^0-9])(\d+)\s*(?:首|tracks?|songs?)/iu,
  );
  if (numericBeforeUnit) return Number.parseInt(numericBeforeUnit[1], 10);

  const numericAfterUnit = intent.match(
    /(?:tracks?|songs?)\s*[:=]?\s*(\d+)\b/iu,
  );
  if (numericAfterUnit) return Number.parseInt(numericAfterUnit[1], 10);

  const english = intent.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:tracks?|songs?)\b/iu,
  );
  if (english) return englishTrackCounts.get(english[1].toLowerCase());

  const chinese = intent.match(/([一二两三四五六七八九十]+)\s*首/u);
  if (!chinese) return undefined;
  if (chineseTrackCounts.has(chinese[1])) {
    return chineseTrackCounts.get(chinese[1]);
  }
  const [tensText, onesText] = chinese[1].split("十");
  if (chinese[1].split("十").length !== 2) return undefined;
  const tens = tensText === "" ? 1 : chineseTrackCounts.get(tensText);
  const ones = onesText === "" ? 0 : chineseTrackCounts.get(onesText);
  return tens && ones !== undefined ? tens * 10 + ones : undefined;
}

function assertExternalPlanDiversity(tracks, intent) {
  const externalTracks = tracks.filter(
    (track) => track.candidate_scope === "external_catalog",
  );
  if (externalTracks.length < 2) return;
  const normalizedIntent = normalizeSearchText(intent);
  const releaseCounts = new Map();
  const artistCounts = new Map();
  for (const track of externalTracks) {
    const artist = normalizeSearchText(track.artist_credit);
    const release = normalizeSearchText(track.release);
    const releaseKey = `${artist}|${release}`;
    releaseCounts.set(releaseKey, {
      release,
      count: (releaseCounts.get(releaseKey)?.count ?? 0) + 1,
    });
    artistCounts.set(artist, {
      artist,
      count: (artistCounts.get(artist)?.count ?? 0) + 1,
    });
  }
  if (
    [...releaseCounts.values()].some(
      (group) =>
        group.count > 1 && !normalizedIntent.includes(group.release),
    )
  ) {
    fail(
      "playlist_external_release_concentration",
      "External discovery plans may select only one track per release unless the intent names that release.",
    );
  }
  if (
    [...artistCounts.values()].some(
      (group) =>
        group.count > 2 && !normalizedIntent.includes(group.artist),
    )
  ) {
    fail(
      "playlist_external_artist_concentration",
      "External discovery plans may select at most two tracks per artist unless the intent names that artist.",
    );
  }
}

function createDefaultFixture(subjectId) {
  const evidenceIds = {
    explicitMara: "20000000-0000-4000-8000-000000000001",
    explicitNorthWindow: "20000000-0000-4000-8000-000000000002",
    familiarity: "20000000-0000-4000-8000-000000000003",
    artistFacet: "20000000-0000-4000-8000-000000000004",
    genreFacet: "20000000-0000-4000-8000-000000000005",
  };
  const tracks = [
    {
      track_ref_id: "10000000-0000-4000-8000-000000000001",
      title: "Midnight Lines",
      artist_credit: "Mara Vale",
      release: "Night Transit",
      duration_ms: 278000,
      labels: { genres: ["Ambient", "Electronic"], composer: "Mara Vale" },
      observation: {
        preference_signals: ["loved", "rated"],
        familiarity: "high",
        play_count: 48,
      },
      search_terms: ["night", "drive", "alone", "familiar", "夜晚", "独自", "坐车"],
      rank: 80,
    },
    {
      track_ref_id: "10000000-0000-4000-8000-000000000002",
      title: "Glass Highway",
      artist_credit: "North Window",
      release: "Slow Roads",
      duration_ms: 251000,
      labels: { genres: ["Dream Pop"] },
      observation: {
        preference_signals: ["favorited"],
        familiarity: "high",
        play_count: 35,
      },
      search_terms: ["night", "drive", "familiar", "road", "夜晚", "熟悉"],
      rank: 70,
    },
    {
      track_ref_id: "10000000-0000-4000-8000-000000000003",
      title: "Blue Exit",
      artist_credit: "Kestrel Frame",
      release: "After Hours",
      duration_ms: 234000,
      labels: { genres: ["Jazz", "Electronic"] },
      observation: {
        preference_signals: [],
        familiarity: "medium",
        play_count: 14,
      },
      search_terms: ["night", "drive", "transition", "夜晚", "过渡"],
      rank: 60,
    },
    {
      track_ref_id: "10000000-0000-4000-8000-000000000004",
      title: "Distant Headlights",
      artist_credit: "Mara Vale",
      release: "Unlit Maps",
      duration_ms: 305000,
      labels: { genres: ["Ambient"] },
      observation: {
        preference_signals: ["loved"],
        familiarity: "medium",
        play_count: 8,
      },
      search_terms: ["night", "drive", "alone", "headlights", "夜晚", "独自"],
      rank: 50,
    },
    {
      track_ref_id: "10000000-0000-4000-8000-000000000005",
      title: "Soft Static",
      artist_credit: "Field Arithmetic",
      release: "Low Signal",
      duration_ms: 219000,
      labels: { genres: ["Experimental", "Electronic"] },
      observation: {
        preference_signals: [],
        familiarity: "low",
        play_count: 2,
      },
      search_terms: ["night", "drive", "surprise", "unexpected", "意外", "夜晚"],
      rank: 40,
    },
    {
      track_ref_id: "10000000-0000-4000-8000-000000000006",
      title: "Empty Overpass",
      artist_credit: "Serein Club",
      release: "Nocturne District",
      duration_ms: 337000,
      labels: { genres: ["Post-Rock"] },
      observation: {
        preference_signals: [],
        familiarity: "low",
        play_count: 1,
      },
      search_terms: ["night", "drive", "alone", "surprise", "夜晚", "意外"],
      rank: 30,
    },
    {
      track_ref_id: "10000000-0000-4000-8000-000000000007",
      title: "First Light Behind Us",
      artist_credit: "North Window",
      release: "Slow Roads",
      duration_ms: 264000,
      labels: { genres: ["Dream Pop"] },
      observation: {
        preference_signals: ["favorited"],
        familiarity: "medium",
        play_count: 16,
      },
      search_terms: ["night", "drive", "dawn", "transition", "过渡", "熟悉"],
      rank: 20,
    },
    {
      track_ref_id: "10000000-0000-4000-8000-000000000008",
      title: "Rain on Route Nine",
      artist_credit: "Aster Fold",
      release: "Weather Systems",
      duration_ms: 288000,
      labels: { genres: ["Ambient Jazz"] },
      observation: {
        preference_signals: [],
        familiarity: "unknown",
      },
      search_terms: ["night", "drive", "rain", "surprise", "夜晚", "意外"],
      rank: 10,
    },
  ].map((track, index) => ({
    ...track,
    subject_id: subjectId,
    provider_id: `synthetic-provider-private-${index + 1}`,
    source_path: `/private/synthetic/library/${index + 1}.m4a`,
    raw_observation: { private_snapshot_row: index + 1 },
  }));

  return {
    tracks,
    profiles: [
      {
        subject_id: subjectId,
        strong_preferences: [
          {
            label: "Mara Vale",
            signal: "loved and non-computed rating",
            evidence_id: evidenceIds.explicitMara,
          },
          {
            label: "North Window",
            signal: "favorited",
            evidence_id: evidenceIds.explicitNorthWindow,
          },
        ],
        familiarity: [
          {
            label: "Midnight Lines",
            level: "high",
            play_count: 48,
            evidence_id: evidenceIds.familiarity,
          },
          {
            label: "Glass Highway",
            level: "high",
            play_count: 35,
            evidence_id: evidenceIds.familiarity,
          },
          {
            label: "Soft Static",
            level: "low",
            play_count: 2,
            evidence_id: evidenceIds.familiarity,
          },
        ],
        artist_facets: [
          { name: "Mara Vale", evidence_id: evidenceIds.artistFacet },
          { name: "North Window", evidence_id: evidenceIds.artistFacet },
        ],
        genre_facets: [
          { name: "Ambient", evidence_id: evidenceIds.genreFacet },
          { name: "Dream Pop", evidence_id: evidenceIds.genreFacet },
          { name: "Electronic", evidence_id: evidenceIds.genreFacet },
        ],
        coverage: {
          tracks_observed: tracks.length,
          loved_or_favorited: 4,
          aggregate_play_count: 7,
          non_computed_rating: 1,
        },
        source: { captured_at: "2026-08-25T00:00:00.000Z" },
        limitations: [
          "The source is one aggregate library snapshot, not complete listening history.",
          "Play count supports familiarity, not liking.",
          "Artist facets are name-only and genre facets use provider labels.",
          "The synthetic projection does not model short-term preference change.",
        ],
        private_profile_blob: { subject_id: subjectId },
      },
    ],
    evidence: [
      {
        subject_id: subjectId,
        evidence_id: evidenceIds.explicitMara,
        claim: {
          dimension: "preference.artist",
          value: "Mara Vale",
          direction: "supports",
        },
        basis_summary:
          "Loved state and a non-computed rating support a strong preference signal.",
        derivation: {
          kind: "rule",
          name: "explicit-library-preference",
          version: "synthetic/1",
        },
        confidence: 0.95,
        interpretation_limit:
          "This supports preference for the observed item or facet, not a timeless personality trait.",
        raw_basis_refs: ["private-observation-1"],
      },
      {
        subject_id: subjectId,
        evidence_id: evidenceIds.explicitNorthWindow,
        claim: {
          dimension: "preference.artist",
          value: "North Window",
          direction: "supports",
        },
        basis_summary: "Favorited state supports a strong preference signal.",
        derivation: {
          kind: "rule",
          name: "explicit-library-preference",
          version: "synthetic/1",
        },
        confidence: 0.9,
        interpretation_limit:
          "Favorited state supports preference but does not establish when or why it formed.",
      },
      {
        subject_id: subjectId,
        evidence_id: evidenceIds.familiarity,
        claim: {
          dimension: "familiarity.track",
          value: "aggregate play count",
          direction: "supports",
        },
        basis_summary:
          "Aggregate play counts distinguish frequently and rarely played library tracks.",
        derivation: {
          kind: "rule",
          name: "aggregate-play-count-familiarity",
          version: "synthetic/1",
        },
        confidence: 0.85,
        interpretation_limit: "Play count supports familiarity, not liking.",
      },
      {
        subject_id: subjectId,
        evidence_id: evidenceIds.artistFacet,
        claim: {
          dimension: "profile.artist_facet",
          value: "name-only artist facets",
          direction: "supports",
        },
        basis_summary:
          "Explicit track signals are grouped by the artist credit string in the snapshot.",
        derivation: {
          kind: "aggregate",
          name: "artist-name-facet",
          version: "synthetic/1",
        },
        confidence: 0.75,
        interpretation_limit:
          "Artist names are labels only and are not resolved external identities.",
      },
      {
        subject_id: subjectId,
        evidence_id: evidenceIds.genreFacet,
        claim: {
          dimension: "profile.genre_facet",
          value: "provider genre labels",
          direction: "supports",
        },
        basis_summary:
          "Genre labels attached to tracks with explicit signals form a bounded facet summary.",
        derivation: {
          kind: "aggregate",
          name: "provider-genre-facet",
          version: "synthetic/1",
        },
        confidence: 0.7,
        interpretation_limit:
          "Provider genre labels are not a normalized genre ontology or an abstract taste score.",
      },
    ],
  };
}

export class SyntheticDomainServices {
  #subjectId;
  #tracks;
  #tracksById;
  #profile;
  #evidenceById;
  #candidateSets = new Map();
  #externalTrackIds = new Set();

  constructor({ subjectScope, fixture } = {}) {
    this.#subjectId = trustedSubjectId(subjectScope);
    const source = structuredClone(fixture ?? createDefaultFixture(this.#subjectId));
    if (!isPlainObject(source) || !Array.isArray(source.tracks)) {
      fail("synthetic_fixture_invalid", "The synthetic domain fixture is invalid.");
    }

    this.#tracks = source.tracks
      .filter((record) => record?.subject_id === this.#subjectId)
      .map(normalizeInternalTrack);
    this.#tracksById = new Map();
    for (const track of this.#tracks) {
      if (this.#tracksById.has(track.trackRefId)) {
        fail("synthetic_fixture_invalid", "The synthetic domain fixture is invalid.");
      }
      this.#tracksById.set(track.trackRefId, track);
    }

    const profiles = Array.isArray(source.profiles)
      ? source.profiles
      : isPlainObject(source.profile)
        ? [source.profile]
        : [];
    const scopedProfile = profiles.find(
      (record) => record?.subject_id === this.#subjectId,
    );
    this.#profile = normalizeProfile(scopedProfile);

    this.#evidenceById = new Map();
    for (const record of Array.isArray(source.evidence) ? source.evidence : []) {
      if (record?.subject_id !== this.#subjectId) continue;
      const evidence = normalizeEvidence(record);
      if (!evidence) continue;
      if (this.#evidenceById.has(evidence.evidence_id)) {
        fail("synthetic_fixture_invalid", "The synthetic domain fixture is invalid.");
      }
      this.#evidenceById.set(evidence.evidence_id, evidence);
    }
    for (const key of [
      "strongPreferences",
      "familiarity",
      "artistFacets",
      "genreFacets",
    ]) {
      this.#profile[key] = this.#profile[key]
        .filter((item) => this.#evidenceById.has(item.evidence_id))
        .slice(0, SYNTHETIC_DOMAIN_LIMITS.profileMax);
    }
  }

  status() {
    return {
      state: "ready",
      adapter: "synthetic",
      subject_scope: "trusted_runtime",
      candidate_scope: "prompt_local",
      external_effects: "none",
    };
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
    for (const trackRefId of this.#externalTrackIds) {
      this.#tracksById.delete(trackRefId);
    }
    this.#externalTrackIds.clear();
    return { invalidated_candidate_sets: invalidated };
  }

  async searchLibrary(argumentsValue) {
    const input = modelArguments(
      argumentsValue,
      new Set(["query", "limit", "offset", "filters"]),
    );
    const query = searchQueryText(input.query);
    const limit = boundedResultCount(
      input.limit,
      SYNTHETIC_DOMAIN_LIMITS.searchDefault,
      SYNTHETIC_DOMAIN_LIMITS.searchMax,
      "invalid_search_limit",
    );
    const offset = boundedOffset(
      input.offset,
      SYNTHETIC_DOMAIN_LIMITS.searchOffsetMax,
      "invalid_search_offset",
    );
    const filters = normalizeFilters(input.filters);
    if (this.#candidateSets.size >= SYNTHETIC_DOMAIN_LIMITS.activeCandidateSetsMax) {
      fail(
        "candidate_set_capacity_reached",
        "The prompt has reached its candidate set limit.",
      );
    }

    const tokens = normalizeSearchText(query).split(/\s+/u).filter(Boolean);
    const matches = this.#tracks
      .map((track) => ({ track, score: searchScore(track, tokens) }))
      .filter(
        ({ track, score }) =>
          (tokens.length === 0 || score > 0) && matchesFilters(track, filters),
      )
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.track.rank !== left.track.rank) return right.track.rank - left.track.rank;
        return left.track.trackRefId.localeCompare(right.track.trackRefId);
      });
    const tracks = matches
      .slice(offset, offset + limit)
      .map(({ track }) => safeTrackResult(track));
    const hasMore = matches.length > offset + tracks.length;
    const nextOffset = hasMore
      ? Math.min(offset + tracks.length, SYNTHETIC_DOMAIN_LIMITS.searchOffsetMax)
      : null;

    let candidateSetId;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = randomUUID();
      if (!this.#candidateSets.has(candidate)) {
        candidateSetId = candidate;
        break;
      }
    }
    if (!candidateSetId) {
      fail("candidate_set_unavailable", "A candidate set could not be created.");
    }

    this.#candidateSets.set(
      candidateSetId,
      new Set(tracks.map((track) => track.track_ref_id)),
    );
    return {
      candidate_set_id: candidateSetId,
      candidate_scope: "private_library",
      result_count: tracks.length,
      limit_applied: limit,
      offset_applied: offset,
      next_offset: nextOffset === offset ? null : nextOffset,
      has_more: hasMore && nextOffset !== offset,
      expires_on: "prompt_end",
      tracks,
    };
  }

  registerExternalCandidateSet({ tracks, source } = {}) {
    const provider =
      isPlainObject(source) && externalCatalogProviders.has(source.provider)
        ? source.provider
        : null;
    if (
      !Array.isArray(tracks) ||
      tracks.length < 1 ||
      tracks.length > SYNTHETIC_DOMAIN_LIMITS.playlistTracksMax ||
      !provider
    ) {
      fail("external_candidate_invalid", "External catalog candidates are invalid.");
    }
    if (this.#candidateSets.size >= SYNTHETIC_DOMAIN_LIMITS.activeCandidateSetsMax) {
      fail(
        "candidate_set_capacity_reached",
        "The prompt has reached its candidate set limit.",
      );
    }
    const accepted = [];
    let excludedLibraryMatches = 0;
    for (const raw of tracks) {
      if (
        !isPlainObject(raw) ||
        raw.candidate_scope !== "external_catalog" ||
        raw.catalog_provider !== provider
      ) {
        fail("external_candidate_invalid", "An external catalog candidate is invalid.");
      }
      const internal = normalizeExternalInternalTrack(raw, provider);
      const libraryMatch = this.#tracks.some(
        (track) =>
          normalizeSearchText(track.title) ===
            normalizeSearchText(internal.title) &&
          normalizeSearchText(track.artistCredit) ===
            normalizeSearchText(internal.artistCredit),
      );
      if (libraryMatch) {
        excludedLibraryMatches += 1;
        continue;
      }
      if (this.#tracksById.has(internal.trackRefId)) {
        fail("external_candidate_invalid", "External catalog candidates are duplicated.");
      }
      this.#tracksById.set(internal.trackRefId, internal);
      this.#externalTrackIds.add(internal.trackRefId);
      accepted.push(safeTrackResult(internal));
    }
    if (accepted.length === 0) {
      return {
        candidate_set_id: null,
        candidate_scope: "external_catalog",
        result_count: 0,
        excluded_library_matches: excludedLibraryMatches,
        expires_on: "prompt_end",
        source: structuredClone(source),
        tracks: [],
      };
    }
    const candidateSetId = randomUUID();
    this.#candidateSets.set(
      candidateSetId,
      new Set(accepted.map((track) => track.track_ref_id)),
    );
    return {
      candidate_set_id: candidateSetId,
      candidate_scope: "external_catalog",
      result_count: accepted.length,
      excluded_library_matches: excludedLibraryMatches,
      expires_on: "prompt_end",
      source: structuredClone(source),
      tracks: accepted,
    };
  }

  registerRetainedPlaylistCandidateSet({ tracks } = {}) {
    if (
      !Array.isArray(tracks) ||
      tracks.length < 1 ||
      tracks.length > SYNTHETIC_DOMAIN_LIMITS.playlistTracksMax
    ) {
      fail(
        "retained_candidate_invalid",
        "Retained playlist candidates are invalid.",
      );
    }
    if (this.#candidateSets.size >= SYNTHETIC_DOMAIN_LIMITS.activeCandidateSetsMax) {
      fail(
        "candidate_set_capacity_reached",
        "The prompt has reached its candidate set limit.",
      );
    }

    const prepared = [];
    const seen = new Set();
    for (const raw of tracks) {
      if (!isPlainObject(raw)) {
        fail(
          "retained_candidate_invalid",
          "Retained playlist candidates are invalid.",
        );
      }
      let track;
      if (raw.candidate_scope === "external_catalog") {
        const provider = externalCatalogProviders.has(raw.catalog_provider)
          ? raw.catalog_provider
          : null;
        track = normalizeExternalInternalTrack(raw, provider);
        if (this.#tracksById.has(track.trackRefId)) {
          fail(
            "retained_candidate_invalid",
            "A retained playlist candidate conflicts with a trusted library track.",
          );
        }
      } else {
        if (
          raw.candidate_scope !== undefined &&
          raw.candidate_scope !== "private_library"
        ) {
          fail(
            "retained_candidate_invalid",
            "Retained playlist candidates are invalid.",
          );
        }
        const trackRefId = requiredInputText(
          raw.track_ref_id,
          SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
          "retained_candidate_invalid",
        );
        track = this.#tracksById.get(trackRefId);
        const canonical = track ? safeTrackResult(track) : null;
        if (
          !track ||
          track.candidateScope === "external_catalog" ||
          raw.title !== canonical.title ||
          raw.artist_credit !== canonical.artist_credit ||
          raw.release !== canonical.release
        ) {
          fail(
            "retained_candidate_invalid",
            "A retained playlist candidate no longer matches the trusted library.",
          );
        }
      }
      if (seen.has(track.trackRefId)) {
        fail(
          "retained_candidate_invalid",
          "Retained playlist candidates are duplicated.",
        );
      }
      seen.add(track.trackRefId);
      prepared.push(track);
    }

    for (const track of prepared) {
      if (track.candidateScope === "external_catalog") {
        this.#tracksById.set(track.trackRefId, track);
        this.#externalTrackIds.add(track.trackRefId);
      }
    }
    const candidateSetId = randomUUID();
    this.#candidateSets.set(candidateSetId, new Set(seen));
    const safeTracks = prepared.map(safeTrackResult);
    const scopes = new Set(
      safeTracks.map((track) => track.candidate_scope ?? "private_library"),
    );
    return {
      candidate_set_id: candidateSetId,
      candidate_scope: scopes.size === 1 ? [...scopes][0] : "mixed",
      result_count: safeTracks.length,
      expires_on: "prompt_end",
      source: "retained_validated_playlist",
      tracks: safeTracks,
    };
  }

  getTrustedTracks(trackRefIds) {
    if (
      !Array.isArray(trackRefIds) ||
      trackRefIds.length < 1 ||
      trackRefIds.length > SYNTHETIC_DOMAIN_LIMITS.playlistTracksMax
    ) {
      fail("invalid_track_refs", "Trusted track references are invalid.");
    }
    const results = [];
    for (const trackRefId of trackRefIds) {
      const cleanedId = requiredInputText(
        trackRefId,
        SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
        "invalid_track_refs",
      );
      let trusted = false;
      for (const candidateSet of this.#candidateSets.values()) {
        if (candidateSet.has(cleanedId)) {
          trusted = true;
          break;
        }
      }
      const track = this.#tracksById.get(cleanedId);
      if (!trusted || !track) {
        fail(
          "untrusted_track_ref",
          "A referenced track was not returned by the trusted candidate sets.",
        );
      }
      results.push(safeTrackResult(track));
    }
    return results;
  }

  async getProfileSummary(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["maxItems"]));
    const maxItems = boundedResultCount(
      input.maxItems,
      SYNTHETIC_DOMAIN_LIMITS.profileDefault,
      SYNTHETIC_DOMAIN_LIMITS.profileMax,
      "invalid_profile_limit",
    );
    return {
      profile_version: "profile_projection/0",
      max_items_applied: maxItems,
      strong_preferences: structuredClone(
        this.#profile.strongPreferences.slice(0, maxItems),
      ),
      familiarity: structuredClone(this.#profile.familiarity.slice(0, maxItems)),
      artist_facets: structuredClone(this.#profile.artistFacets.slice(0, maxItems)),
      genre_facets: structuredClone(this.#profile.genreFacets.slice(0, maxItems)),
      coverage: structuredClone(this.#profile.coverage),
      source: structuredClone(this.#profile.source),
      limitations: [...this.#profile.limitations],
    };
  }

  async explainProfileEvidence(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["evidenceId"]));
    const evidenceId = requiredInputText(
      input.evidenceId,
      SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
      "invalid_evidence_id",
    );
    const evidence = this.#evidenceById.get(evidenceId);
    if (!evidence) {
      fail(
        "profile_evidence_unavailable",
        "Profile evidence is unavailable in the trusted subject scope.",
      );
    }
    return structuredClone(evidence);
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
    const intent = requiredInputText(
      input.intent,
      SYNTHETIC_DOMAIN_LIMITS.longTextLengthMax,
      "invalid_playlist_intent",
    );
    const orderingRationale = requiredInputText(
      input.orderingNotes,
      SYNTHETIC_DOMAIN_LIMITS.longTextLengthMax,
      "invalid_ordering_notes",
    );
    if (
      !Array.isArray(input.candidateSetIds) ||
      input.candidateSetIds.length < 1 ||
      input.candidateSetIds.length > SYNTHETIC_DOMAIN_LIMITS.activeCandidateSetsMax
    ) {
      fail("invalid_candidate_sets", "Playlist candidate sets are invalid.");
    }
    const candidateSetIds = input.candidateSetIds.map((value) =>
      requiredInputText(
        value,
        SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
        "invalid_candidate_sets",
      ),
    );
    if (new Set(candidateSetIds).size !== candidateSetIds.length) {
      fail("invalid_candidate_sets", "Playlist candidate sets are invalid.");
    }

    const trustedTrackIds = new Set();
    for (const candidateSetId of candidateSetIds) {
      const candidateSet = this.#candidateSets.get(candidateSetId);
      if (!candidateSet) {
        fail(
          "candidate_set_unavailable",
          "A playlist candidate set is unavailable or expired.",
        );
      }
      for (const trackRefId of candidateSet) trustedTrackIds.add(trackRefId);
    }

    if (
      !Array.isArray(input.trackRefs) ||
      input.trackRefs.length < 1 ||
      input.trackRefs.length > SYNTHETIC_DOMAIN_LIMITS.playlistTracksMax
    ) {
      fail("invalid_track_refs", "Playlist track references are invalid.");
    }
    const selections = input.trackRefs.map((entry) => {
      const item = modelArguments(
        entry,
        new Set(["trackRefId", "selectionReason"]),
      );
      return {
        trackRefId: requiredInputText(
          item.trackRefId,
          SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
          "invalid_track_refs",
        ),
        selectionReason: requiredInputText(
          item.selectionReason,
          SYNTHETIC_DOMAIN_LIMITS.shortTextLengthMax,
          "invalid_selection_reason",
        ),
      };
    });
    const selectedIds = selections.map((selection) => selection.trackRefId);
    if (new Set(selectedIds).size !== selectedIds.length) {
      fail("duplicate_track_ref", "A playlist plan cannot contain duplicate tracks.");
    }
    if (selectedIds.some((trackRefId) => !trustedTrackIds.has(trackRefId))) {
      fail(
        "untrusted_track_ref",
        "A playlist track was not returned by the trusted candidate sets.",
      );
    }

    if (
      !Number.isInteger(input.requestedTrackCount) ||
      input.requestedTrackCount < 1 ||
      input.requestedTrackCount > SYNTHETIC_DOMAIN_LIMITS.playlistTracksMax
    ) {
      fail(
        "playlist_intent_count_unsupported",
        "The requested playlist size is outside the supported range.",
      );
    }
    const inferredRequestedCount = requestedTrackCount(intent);
    if (
      inferredRequestedCount !== undefined &&
      inferredRequestedCount !== input.requestedTrackCount
    ) {
      fail(
        "playlist_track_count_mismatch",
        "The playlist track count does not match the explicit user intent.",
      );
    }
    const requestedCount = input.requestedTrackCount;
    if (requestedCount !== selections.length) {
      fail(
        "playlist_track_count_mismatch",
        "The playlist track count does not match the explicit user intent.",
      );
    }

    const tracks = selections.map((selection, index) => {
      const track = this.#tracksById.get(selection.trackRefId);
      if (!track) {
        fail(
          "untrusted_track_ref",
          "A playlist track was not returned by the trusted candidate sets.",
        );
      }
      const result = {
        position: index + 1,
        track_ref_id: track.trackRefId,
        title: track.title,
        artist_credit: track.artistCredit,
        release: track.release,
        candidate_scope: track.candidateScope ?? "private_library",
        selection_reason: selection.selectionReason,
      };
      if (track.durationMs !== undefined) result.duration_ms = track.durationMs;
      if (
        track.candidateScope === "external_catalog" &&
        track.catalogProvider === "apple_music" &&
        track.catalogUrl
      ) {
        result.public_catalog_reference = {
          provider: "apple_music",
          url: track.catalogUrl,
        };
      }
      return result;
    });
    const selectedScopes = new Set(
      tracks.map((track) => track.candidate_scope),
    );
    assertExternalPlanDiversity(tracks, intent);

    return {
      plan_version: "playlist_plan/0",
      intent,
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
}

export function createSyntheticDomainServices(options) {
  return new SyntheticDomainServices(options);
}
