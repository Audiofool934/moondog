import { uuidV5 } from "../../core/uuid-v5.mjs";

export const LISTENBRAINZ_RECORDING_TRACK_NAMESPACE =
  "1ea3cad6-a0a2-58a5-a584-64953336f69f";

export const OPEN_MUSIC_SIMILARITY_LIMITS = Object.freeze({
  artistNameLengthMax: 512,
  outputTracksMax: 12,
  wikidataSearchResultsMax: 8,
  listenBrainzRecordingsMax: 24,
  cacheTtlMs: 10 * 60 * 1_000,
  identityCacheTtlMs: 60 * 60 * 1_000,
  requestTimeoutMs: 8_000,
});

const wikidataOrigin = "https://www.wikidata.org";
const listenBrainzOrigin = "https://api.listenbrainz.org";
const defaultUserAgent = "Moondog/0.1 (https://ai.ruc.edu.cn/)";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const modes = new Set(["easy", "medium", "hard"]);
const popularityRanges = Object.freeze({
  easy: Object.freeze({ begin: 80, end: 100 }),
  medium: Object.freeze({ begin: 65, end: 100 }),
  hard: Object.freeze({ begin: 20, end: 70 }),
});

export class OpenMusicSimilarityError extends Error {
  constructor(code, message, provider) {
    super(message);
    this.name = "OpenMusicSimilarityError";
    this.code = code;
    this.provider = provider;
  }
}

function fail(code, message, provider) {
  throw new OpenMusicSimilarityError(code, message, provider);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanText(value, maximum) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, maximum).join("");
}

function requiredArtistName(value) {
  if (
    typeof value !== "string" ||
    Array.from(value).length < 1 ||
    Array.from(value).length > OPEN_MUSIC_SIMILARITY_LIMITS.artistNameLengthMax
  ) {
    fail(
      "open_music_artist_invalid",
      "The trusted seed artist name is invalid.",
      "open_music_similarity",
    );
  }
  const cleaned = cleanText(value, OPEN_MUSIC_SIMILARITY_LIMITS.artistNameLengthMax);
  if (!cleaned) {
    fail(
      "open_music_artist_invalid",
      "The trusted seed artist name is invalid.",
      "open_music_similarity",
    );
  }
  return cleaned.replace(/\s+(?:feat\.?|featuring|ft\.?)\s+.+$/iu, "").trim();
}

function normalizeForMatch(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/["'‘’“”`]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function languageForArtist(value) {
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(value)) return "ja";
  if (/\p{Script=Hangul}/u.test(value)) return "ko";
  if (/\p{Script=Han}/u.test(value)) return "zh";
  if (/\p{Script=Cyrillic}/u.test(value)) return "ru";
  return "en";
}

function safeUuid(value) {
  return typeof value === "string" && uuidPattern.test(value)
    ? value.toLowerCase()
    : null;
}

function safeAppleMusicArtistId(value) {
  return typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value)
    ? value
    : null;
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function headerInteger(response, name) {
  const raw = response.headers?.get?.(name);
  if (typeof raw !== "string" || !/^\d+$/u.test(raw.trim())) return null;
  return Number.parseInt(raw, 10);
}

async function responseJson(response, provider, codePrefix) {
  if (!response || typeof response.ok !== "boolean") {
    fail(
      `${codePrefix}_response_invalid`,
      `${provider} returned an invalid response.`,
      provider,
    );
  }
  if (!response.ok) {
    const status = Number.isInteger(response.status) ? response.status : 0;
    const retryAfter =
      headerInteger(response, "retry-after") ??
      headerInteger(response, "x-ratelimit-reset-in");
    if (status === 429) {
      const suffix = retryAfter === null ? "" : ` Retry after ${retryAfter} seconds.`;
      fail(
        `${codePrefix}_rate_limited`,
        `${provider} rate limit reached.${suffix}`,
        provider,
      );
    }
    fail(
      `${codePrefix}_http_error`,
      `${provider} returned HTTP ${status}.`,
      provider,
    );
  }
  try {
    return await response.json();
  } catch {
    fail(
      `${codePrefix}_response_invalid`,
      `${provider} returned invalid JSON.`,
      provider,
    );
  }
}

async function cached(cache, key, ttlMs, now, loader) {
  const current = now();
  if (!Number.isFinite(current)) {
    fail(
      "open_music_clock_invalid",
      "The open music service clock is invalid.",
      "open_music_similarity",
    );
  }
  const entry = cache.get(key);
  if (entry && entry.expiresAt > current) return structuredClone(entry.value);
  const value = await loader();
  cache.set(key, { expiresAt: current + ttlMs, value: structuredClone(value) });
  return structuredClone(value);
}

function wikidataMbidClaims(entity) {
  const claims = Array.isArray(entity?.claims?.P434) ? entity.claims.P434 : [];
  return [
    ...new Set(
      claims
        .map((claim) => safeUuid(claim?.mainsnak?.datavalue?.value))
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right, "en"));
}

function wikidataAppleMusicArtistClaims(entity) {
  const claims = Array.isArray(entity?.claims?.P2850)
    ? entity.claims.P2850
    : [];
  return [
    ...new Set(
      claims
        .map((claim) =>
          safeAppleMusicArtistId(claim?.mainsnak?.datavalue?.value),
        )
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function entityText(entity, field, language, fallback) {
  return (
    cleanText(entity?.[field]?.[language]?.value, 512) ??
    cleanText(entity?.[field]?.en?.value, 512) ??
    cleanText(fallback, 512)
  );
}

export function createWikidataArtistResolver({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheTtlMs = OPEN_MUSIC_SIMILARITY_LIMITS.identityCacheTtlMs,
  userAgent = defaultUserAgent,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
    throw new TypeError("The Wikidata identity cache TTL is invalid.");
  }
  const agent = cleanText(userAgent, 512);
  if (!agent) throw new TypeError("A descriptive Wikidata user agent is required.");
  const cache = new Map();

  async function request(parameters) {
    const url = new URL("/w/api.php", wikidataOrigin);
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, String(value));
    }
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: "application/json",
          "user-agent": agent,
        },
        signal: AbortSignal.timeout(
          OPEN_MUSIC_SIMILARITY_LIMITS.requestTimeoutMs,
        ),
      });
      return await responseJson(response, "Wikidata", "wikidata");
    } catch (error) {
      if (error instanceof OpenMusicSimilarityError) throw error;
      fail(
        "wikidata_request_failed",
        "Wikidata could not be reached.",
        "wikidata",
      );
    }
  }

  return Object.freeze({
    async resolveArtist(artistName) {
      const artist = requiredArtistName(artistName);
      const normalized = normalizeForMatch(artist);
      const language = languageForArtist(artist);
      const key = `${language}|${normalized}`;
      return cached(cache, key, cacheTtlMs, now, async () => {
        const searchPayload = await request({
          action: "wbsearchentities",
          search: artist,
          language,
          uselang: language,
          type: "item",
          limit: OPEN_MUSIC_SIMILARITY_LIMITS.wikidataSearchResultsMax,
          format: "json",
        });
        const search = Array.isArray(searchPayload?.search)
          ? searchPayload.search
          : [];
        const exact = search.filter((entry) => {
          const matched = cleanText(entry?.match?.text, 512);
          const label = cleanText(entry?.label, 512);
          return [matched, label]
            .filter(Boolean)
            .some((value) => normalizeForMatch(value) === normalized);
        });
        const ids = [
          ...new Set(
            exact
              .map((entry) =>
                typeof entry?.id === "string" && /^Q\d+$/u.test(entry.id)
                  ? entry.id
                  : null,
              )
              .filter(Boolean),
          ),
        ].sort((left, right) =>
          left.localeCompare(right, "en", { numeric: true }),
        );
        if (ids.length === 0) {
          return {
            state: "not_found",
            artist_name: artist,
            language,
            candidates: [],
          };
        }
        const entityPayload = await request({
          action: "wbgetentities",
          ids: ids.join("|"),
          props: "claims|labels|descriptions",
          languages: language === "en" ? "en" : `${language}|en`,
          format: "json",
        });
        const entities = isPlainObject(entityPayload?.entities)
          ? entityPayload.entities
          : {};
        const candidates = ids
          .map((id) => {
            const entity = entities[id];
            const artistMbids = wikidataMbidClaims(entity);
            if (artistMbids.length === 0) return null;
            const searchEntry = exact.find((entry) => entry.id === id);
            const appleMusicArtistIds =
              wikidataAppleMusicArtistClaims(entity);
            return {
              wikidata_id: id,
              name: entityText(entity, "labels", language, searchEntry?.label),
              description: entityText(
                entity,
                "descriptions",
                language,
                searchEntry?.description,
              ),
              artist_mbids: artistMbids,
              apple_music_artist_ids: appleMusicArtistIds,
            };
          })
          .filter(Boolean);
        const artistMbids = [
          ...new Set(candidates.flatMap((candidate) => candidate.artist_mbids)),
        ];
        if (artistMbids.length !== 1) {
          return {
            state: artistMbids.length === 0 ? "not_found" : "ambiguous",
            artist_name: artist,
            language,
            candidates,
          };
        }
        const matchedCandidates = candidates.filter((candidate) =>
          candidate.artist_mbids.includes(artistMbids[0]),
        );
        const appleMusicArtistIds = [
          ...new Set(
            matchedCandidates.flatMap(
              (candidate) => candidate.apple_music_artist_ids,
            ),
          ),
        ].sort((left, right) =>
          left.localeCompare(right, "en", { numeric: true }),
        );
        return {
          state: "resolved",
          artist_name: artist,
          language,
          artist_mbid: artistMbids[0],
          wikidata_ids: matchedCandidates.map((candidate) => candidate.wikidata_id),
          canonical_name: matchedCandidates[0]?.name ?? artist,
          apple_music_artist_ids: appleMusicArtistIds,
          candidates: matchedCandidates,
        };
      });
    },
  });
}

function parseRadioPayload(payload) {
  if (!isPlainObject(payload)) {
    fail(
      "listenbrainz_radio_response_invalid",
      "ListenBrainz returned an invalid artist radio response.",
      "listenbrainz",
    );
  }
  const groups = [];
  for (const [artistMbidValue, values] of Object.entries(payload)) {
    const artistMbid = safeUuid(artistMbidValue);
    if (!artistMbid || !Array.isArray(values)) continue;
    const recordings = values
      .map((entry) => {
        const recordingMbid = safeUuid(entry?.recording_mbid);
        const similarArtistMbid = safeUuid(entry?.similar_artist_mbid);
        const similarArtistName = cleanText(entry?.similar_artist_name, 512);
        const totalListenCount = safeNonnegativeInteger(entry?.total_listen_count);
        if (
          !recordingMbid ||
          similarArtistMbid !== artistMbid ||
          !similarArtistName ||
          totalListenCount === null
        ) {
          return null;
        }
        return {
          recording_mbid: recordingMbid,
          similar_artist_mbid: similarArtistMbid,
          similar_artist_name: similarArtistName,
          total_listen_count: totalListenCount,
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.total_listen_count - left.total_listen_count);
    if (recordings.length > 0) groups.push({ artist_mbid: artistMbid, recordings });
  }
  return groups;
}

function parseRecordingMetadata(payload, recordingMbids) {
  if (!isPlainObject(payload)) {
    fail(
      "listenbrainz_metadata_response_invalid",
      "ListenBrainz returned invalid recording metadata.",
      "listenbrainz",
    );
  }
  const result = new Map();
  for (const recordingMbid of recordingMbids) {
    const value = payload[recordingMbid];
    const title = cleanText(value?.recording?.name, 512);
    const artistCredit = cleanText(value?.artist?.name, 512);
    const release = cleanText(value?.release?.name, 512);
    const durationMs = safeNonnegativeInteger(value?.recording?.length);
    if (!title || !artistCredit || !release) continue;
    result.set(recordingMbid, {
      title,
      artist_credit: artistCredit,
      release,
      ...(durationMs !== null && durationMs <= 86_400_000
        ? { duration_ms: durationMs }
        : {}),
    });
  }
  return result;
}

export function createListenBrainzArtistRadioClient({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheTtlMs = OPEN_MUSIC_SIMILARITY_LIMITS.cacheTtlMs,
  userAgent = defaultUserAgent,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
    throw new TypeError("The ListenBrainz cache TTL is invalid.");
  }
  const agent = cleanText(userAgent, 512);
  if (!agent) throw new TypeError("A descriptive ListenBrainz user agent is required.");
  const cache = new Map();
  let rateLimitedUntil = 0;

  async function request(pathname, parameters) {
    const current = now();
    if (!Number.isFinite(current)) {
      fail(
        "open_music_clock_invalid",
        "The open music service clock is invalid.",
        "open_music_similarity",
      );
    }
    if (current < rateLimitedUntil) {
      const seconds = Math.max(1, Math.ceil((rateLimitedUntil - current) / 1_000));
      fail(
        "listenbrainz_rate_limited",
        `ListenBrainz rate limit reached. Retry after ${seconds} seconds.`,
        "listenbrainz",
      );
    }
    const url = new URL(pathname, listenBrainzOrigin);
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, String(value));
    }
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: "application/json",
          "user-agent": agent,
        },
        signal: AbortSignal.timeout(
          OPEN_MUSIC_SIMILARITY_LIMITS.requestTimeoutMs,
        ),
      });
      const resetIn = headerInteger(response, "x-ratelimit-reset-in");
      const retryAfter = headerInteger(response, "retry-after") ?? resetIn;
      const remaining = headerInteger(response, "x-ratelimit-remaining");
      if (remaining === 0 && resetIn !== null) {
        rateLimitedUntil = current + resetIn * 1_000;
      }
      if (response.status === 429) {
        rateLimitedUntil = current + (retryAfter ?? 1) * 1_000;
      }
      return await responseJson(response, "ListenBrainz", "listenbrainz");
    } catch (error) {
      if (error instanceof OpenMusicSimilarityError) {
        if (error.code === "listenbrainz_rate_limited") {
          rateLimitedUntil = Math.max(rateLimitedUntil, current + 1_000);
        }
        throw error;
      }
      fail(
        "listenbrainz_request_failed",
        "ListenBrainz could not be reached.",
        "listenbrainz",
      );
    }
  }

  return Object.freeze({
    async artistRadio({
      artistMbid,
      mode,
      maxSimilarArtists,
      maxRecordingsPerArtist,
      popBegin,
      popEnd,
    }) {
      const cleanedMbid = safeUuid(artistMbid);
      if (!cleanedMbid) {
        fail(
          "listenbrainz_artist_mbid_invalid",
          "The ListenBrainz seed artist identity is invalid.",
          "listenbrainz",
        );
      }
      const key = [
        "radio",
        cleanedMbid,
        mode,
        maxSimilarArtists,
        maxRecordingsPerArtist,
        popBegin,
        popEnd,
      ].join("|");
      return cached(cache, key, cacheTtlMs, now, async () => {
        const payload = await request(`/1/lb-radio/artist/${cleanedMbid}`, {
          mode,
          max_similar_artists: maxSimilarArtists,
          max_recordings_per_artist: maxRecordingsPerArtist,
          pop_begin: popBegin,
          pop_end: popEnd,
        });
        return parseRadioPayload(payload);
      });
    },

    async recordingMetadata(recordingMbids) {
      if (
        !Array.isArray(recordingMbids) ||
        recordingMbids.length < 1 ||
        recordingMbids.length > OPEN_MUSIC_SIMILARITY_LIMITS.listenBrainzRecordingsMax
      ) {
        fail(
          "listenbrainz_recording_mbids_invalid",
          "The ListenBrainz recording identities are invalid.",
          "listenbrainz",
        );
      }
      const cleaned = [...new Set(recordingMbids.map(safeUuid))];
      if (cleaned.includes(null) || cleaned.length !== recordingMbids.length) {
        fail(
          "listenbrainz_recording_mbids_invalid",
          "The ListenBrainz recording identities are invalid.",
          "listenbrainz",
        );
      }
      const key = `metadata|${cleaned.join(",")}`;
      return cached(cache, key, cacheTtlMs, now, async () => {
        const payload = await request("/1/metadata/recording/", {
          recording_mbids: cleaned.join(","),
          inc: "artist release",
        });
        return [...parseRecordingMetadata(payload, cleaned).entries()];
      }).then((entries) => new Map(entries));
    },
  });
}

function roundRobinRecordings(groups, limit) {
  const selected = [];
  const seen = new Set();
  const maximumLength = Math.max(0, ...groups.map((group) => group.recordings.length));
  for (let index = 0; index < maximumLength && selected.length < limit; index += 1) {
    for (const group of groups) {
      const recording = group.recordings[index];
      if (!recording || seen.has(recording.recording_mbid)) continue;
      seen.add(recording.recording_mbid);
      selected.push(recording);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function recordingVariantRisk(details) {
  const title = normalizeForMatch(details.title);
  const release = normalizeForMatch(details.release);
  let risk = 0;
  if (/\b(?:interview|commentary|applause|spoken word|talks?)\b/u.test(title)) {
    risk += 100;
  }
  if (/^(?:intro|outro|interlude)(?:\b|$)/u.test(title)) risk += 20;
  if (/\b(?:alternate take|alternative take|outtake|rehearsal|session)\b/u.test(title)) {
    risk += 8;
  }
  if (/^\d{4}\s+\d{2}\s+\d{2}\b/u.test(release)) risk += 12;
  if (
    /\b(?:bootleg|live at|live in|live from|copyright extension|unplugged)\b/u.test(
      release,
    )
  ) {
    risk += 10;
  }
  if (/\b(?:mx|matrix)\s*(?:co)?\s*\d/u.test(title)) risk += 8;
  if (
    /\b(?:a cappella|acappella|demo|karaoke|radio edit|club mix|live|remix|mix|version)\b/u.test(
      title,
    )
  ) {
    risk += 4;
  }
  if (/\b(?:remix|mixes|live)\b/u.test(release)) risk += 2;
  return risk;
}

function sourceMetadata(now, mode, range, seedArtist) {
  const current = now();
  if (!Number.isFinite(current)) {
    fail(
      "open_music_clock_invalid",
      "The open music service clock is invalid.",
      "open_music_similarity",
    );
  }
  return {
    provider: "listenbrainz",
    catalog: "lb_radio_artist+metadata_recording",
    identity_provider: "wikidata",
    retrieved_at: new Date(current).toISOString(),
    license:
      "CC0 inputs: ListenBrainz public listen-derived data, Wikidata structured identity data, and MusicBrainz core artist, recording, and release metadata. Tags and search indexes were not requested.",
    recommendation_basis: "listenbrainz_collaborative_artist_similarity",
    mode,
    popularity_range: { begin: range.begin, end: range.end },
    seed_artist: seedArtist,
    coverage:
      "Listening-derived artist adjacency and recording popularity from ListenBrainz. This is not audio similarity, proof of personal fit, proof of novelty, or complete catalog coverage.",
  };
}

export function createOpenMusicSimilarity({
  identityResolver = createWikidataArtistResolver(),
  radioClient = createListenBrainzArtistRadioClient(),
  now = Date.now,
} = {}) {
  if (!identityResolver || typeof identityResolver.resolveArtist !== "function") {
    throw new TypeError("A Wikidata artist identity resolver is required.");
  }
  if (
    !radioClient ||
    typeof radioClient.artistRadio !== "function" ||
    typeof radioClient.recordingMetadata !== "function"
  ) {
    throw new TypeError("A ListenBrainz artist radio client is required.");
  }

  return Object.freeze({
    async discoverSimilarTracks({ artistName, mode = "medium", limit = 8 } = {}) {
      const artist = requiredArtistName(artistName);
      if (!modes.has(mode)) {
        fail(
          "open_music_mode_invalid",
          "The artist similarity mode is invalid.",
          "open_music_similarity",
        );
      }
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > OPEN_MUSIC_SIMILARITY_LIMITS.outputTracksMax
      ) {
        fail(
          "open_music_limit_invalid",
          "The artist similarity result limit is invalid.",
          "open_music_similarity",
        );
      }
      const range = popularityRanges[mode];
      const source = sourceMetadata(now, mode, range, artist);
      const identity = await identityResolver.resolveArtist(artist);
      if (identity.state !== "resolved") {
        return {
          state:
            identity.state === "ambiguous"
              ? "seed_identity_ambiguous"
              : "seed_identity_not_found",
          source,
          seed: {
            artist_name: artist,
            identity_resolution: identity.state,
            candidate_count: identity.candidates?.length ?? 0,
          },
          result_count: 0,
          tracks: [],
        };
      }
      const groups = await radioClient.artistRadio({
        artistMbid: identity.artist_mbid,
        mode,
        maxSimilarArtists: Math.min(8, Math.max(4, Math.ceil(limit / 2) + 2)),
        maxRecordingsPerArtist: 5,
        popBegin: range.begin,
        popEnd: range.end,
      });
      const adjacentGroups = groups.filter(
        (group) => group.artist_mbid !== identity.artist_mbid,
      );
      const recordings = adjacentGroups
        .flatMap((group) => group.recordings);
      if (recordings.length === 0) {
        return {
          state: "not_found",
          source,
          seed: {
            artist_name: artist,
            canonical_artist_name: identity.canonical_name,
            identity_resolution: "wikidata_exact_label_or_alias",
          },
          result_count: 0,
          tracks: [],
        };
      }
      const metadata = new Map();
      for (
        let offset = 0;
        offset < recordings.length;
        offset += OPEN_MUSIC_SIMILARITY_LIMITS.listenBrainzRecordingsMax
      ) {
        const chunk = recordings.slice(
          offset,
          offset + OPEN_MUSIC_SIMILARITY_LIMITS.listenBrainzRecordingsMax,
        );
        const chunkMetadata = await radioClient.recordingMetadata(
          chunk.map((recording) => recording.recording_mbid),
        );
        for (const [recordingMbid, details] of chunkMetadata) {
          metadata.set(recordingMbid, details);
        }
      }
      const rankedGroups = adjacentGroups
        .map((group) => ({
          ...group,
          recordings: group.recordings
            .map((recording) => {
              const details = metadata.get(recording.recording_mbid);
              return details
                ? {
                    ...recording,
                    details,
                    variant_risk: recordingVariantRisk(details),
                  }
                : null;
            })
            .filter(Boolean)
            .sort((left, right) => {
              if (left.variant_risk !== right.variant_risk) {
                return left.variant_risk - right.variant_risk;
              }
              return right.total_listen_count - left.total_listen_count;
            }),
        }))
        .filter((group) => group.recordings.length > 0);
      const selected = roundRobinRecordings(rankedGroups, limit);
      const tracks = [];
      for (const recording of selected) {
        const details = recording.details;
        tracks.push({
          track_ref_id: uuidV5(
            recording.recording_mbid,
            LISTENBRAINZ_RECORDING_TRACK_NAMESPACE,
          ),
          ...details,
          candidate_scope: "external_catalog",
          catalog_provider: "listenbrainz",
          discovery_basis: {
            kind: "listenbrainz_collaborative_artist_similarity",
            seed_artist: identity.canonical_name,
            adjacent_artist: recording.similar_artist_name,
            mode,
          },
        });
        if (tracks.length >= limit) break;
      }
      return {
        state: tracks.length > 0 ? "resolved" : "not_found",
        source,
        seed: {
          artist_name: artist,
          canonical_artist_name: identity.canonical_name,
          identity_resolution: "wikidata_exact_label_or_alias",
        },
        result_count: tracks.length,
        tracks,
      };
    },
  });
}
