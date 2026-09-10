import { uuidV5 } from "../../core/uuid-v5.mjs";

export const APPLE_MUSIC_CATALOG_TRACK_NAMESPACE =
  "2837a09e-e5f0-5aa5-b271-bb99d8b0de20";

export const APPLE_MUSIC_CATALOG_LIMITS = Object.freeze({
  artistNameLengthMax: 256,
  releaseHintLengthMax: 512,
  discoveryQueryLengthMax: 256,
  discoveryQueriesMax: 3,
  trackSearchResultsMax: 12,
  outputTracksMax: 12,
  artistSearchResultsMax: 10,
  exactArtistCandidatesMax: 4,
  releasesPerArtistMax: 50,
  outputReleasesMax: 8,
  ambiguousCandidateReleasesMax: 3,
  cacheTtlMs: 10 * 60 * 1_000,
  requestTimeoutMs: 8_000,
});

const appleCatalogOrigin = "https://itunes.apple.com";
const releaseSuffixPattern = /\s*-\s*(Single|EP)\s*$/iu;

export class AppleMusicCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AppleMusicCatalogError";
    this.code = code;
    this.provider = "apple_music";
  }
}

function fail(code, message) {
  throw new AppleMusicCatalogError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanInputText(value, maximum, code, label) {
  if (
    typeof value !== "string" ||
    Array.from(value).length < 1 ||
    Array.from(value).length > maximum
  ) {
    fail(code, `The ${label} is invalid.`);
  }
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) fail(code, `The ${label} is invalid.`);
  return cleaned;
}

function safeText(value, maximum) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, maximum).join("");
}

function normalizeForMatch(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(releaseSuffixPattern, "")
    .replace(/["'‘’“”`]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function safeCatalogId(value) {
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return String(value);
}

function cleanArtistCatalogId(value) {
  const catalogId =
    typeof value === "string" && /^\d{1,20}$/u.test(value)
      ? value
      : null;
  if (!catalogId) {
    fail(
      "apple_music_catalog_artist_id_invalid",
      "The Apple Music artist identity is invalid.",
    );
  }
  return catalogId;
}

function safeAppleMusicUrl(value) {
  const cleaned = safeText(value, 2_048);
  if (!cleaned) return null;
  try {
    const url = new URL(cleaned);
    if (
      url.protocol !== "https:" ||
      !new Set(["music.apple.com", "itunes.apple.com"]).has(url.hostname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function releaseDate(value) {
  if (typeof value !== "string") return null;
  const matched = /^(\d{4}-\d{2}-\d{2})T/u.exec(value);
  if (!matched || !Number.isFinite(Date.parse(value))) return null;
  return matched[1];
}

function releaseIdentity(collectionName) {
  const matched = collectionName.match(releaseSuffixPattern);
  const releaseType = matched
    ? matched[1].toLocaleLowerCase("en-US")
    : "album";
  const title = collectionName.replace(releaseSuffixPattern, "").trim();
  return {
    title: title || collectionName,
    release_type: releaseType,
  };
}

function normalizeArtist(raw) {
  if (!isPlainObject(raw) || raw.wrapperType !== "artist") return null;
  const catalogId = safeCatalogId(raw.artistId);
  const name = safeText(raw.artistName, 256);
  if (!catalogId || !name) return null;
  const artist = {
    catalog_id: catalogId,
    name,
  };
  const primaryGenre = safeText(raw.primaryGenreName, 128);
  const catalogUrl = safeAppleMusicUrl(raw.artistLinkUrl);
  if (primaryGenre) artist.primary_genre = primaryGenre;
  if (catalogUrl) artist.catalog_url = catalogUrl;
  return artist;
}

function normalizeRelease(raw, expectedArtistId) {
  if (
    !isPlainObject(raw) ||
    raw.wrapperType !== "collection" ||
    safeCatalogId(raw.artistId) !== expectedArtistId
  ) {
    return null;
  }
  const catalogId = safeCatalogId(raw.collectionId);
  const artistName = safeText(raw.artistName, 256);
  const collectionName = safeText(raw.collectionName, 512);
  const date = releaseDate(raw.releaseDate);
  if (!catalogId || !artistName || !collectionName || !date) return null;
  const release = {
    catalog_id: catalogId,
    artist_name: artistName,
    collection_name: collectionName,
    ...releaseIdentity(collectionName),
    release_date: date,
  };
  if (Number.isSafeInteger(raw.trackCount) && raw.trackCount >= 0) {
    release.track_count = raw.trackCount;
  }
  const primaryGenre = safeText(raw.primaryGenreName, 128);
  const catalogUrl = safeAppleMusicUrl(raw.collectionViewUrl);
  if (primaryGenre) release.primary_genre = primaryGenre;
  if (catalogUrl) release.catalog_url = catalogUrl;
  return release;
}

function normalizeTrack(raw) {
  if (
    !isPlainObject(raw) ||
    raw.wrapperType !== "track" ||
    raw.kind !== "song"
  ) {
    return null;
  }
  const catalogId = safeCatalogId(raw.trackId);
  const title = safeText(raw.trackName, 512);
  const artistCredit = safeText(raw.artistName, 512);
  const release = safeText(raw.collectionName, 512);
  if (!catalogId || !title || !artistCredit || !release) return null;
  const track = {
    track_ref_id: uuidV5(catalogId, APPLE_MUSIC_CATALOG_TRACK_NAMESPACE),
    title,
    artist_credit: artistCredit,
    release,
    candidate_scope: "external_catalog",
    catalog_provider: "apple_music",
  };
  if (
    Number.isSafeInteger(raw.trackTimeMillis) &&
    raw.trackTimeMillis >= 0 &&
    raw.trackTimeMillis <= 86_400_000
  ) {
    track.duration_ms = raw.trackTimeMillis;
  }
  const primaryGenre = safeText(raw.primaryGenreName, 128);
  const catalogUrl = safeAppleMusicUrl(raw.trackViewUrl);
  const date = releaseDate(raw.releaseDate);
  if (primaryGenre) track.primary_genre = primaryGenre;
  if (catalogUrl) track.catalog_url = catalogUrl;
  if (date) track.release_date = date;
  return track;
}

function deduplicateAndSortReleases(releases) {
  const seen = new Set();
  const unique = [];
  for (const release of releases) {
    const key = [
      normalizeForMatch(release.title),
      release.release_type,
      release.release_date,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(release);
  }
  return unique.sort((left, right) => {
    const dateOrder = right.release_date.localeCompare(left.release_date);
    if (dateOrder !== 0) return dateOrder;
    return left.title.localeCompare(right.title, "und");
  });
}

function sourceMetadata(now) {
  const current = now();
  if (!Number.isFinite(current)) {
    fail("apple_music_catalog_clock_invalid", "The catalog clock is invalid.");
  }
  return {
    provider: "apple_music",
    catalog: "itunes_search_api",
    storefront: "US",
    retrieved_at: new Date(current).toISOString(),
    coverage:
      "Apple Music US storefront catalog only. This is not a claim about every music platform.",
  };
}

function releasedAndUpcoming(releases, retrievedAt) {
  const observedDate = retrievedAt.slice(0, 10);
  return {
    released: releases.filter(
      (release) => release.release_date <= observedDate,
    ),
    upcoming: releases.filter(
      (release) => release.release_date > observedDate,
    ),
  };
}

function interleaveTrackResults(resultSets, queries, limit) {
  const selected = [];
  const selectedById = new Map();
  const selectedReleaseKeys = new Set();
  const selectedArtistCounts = new Map();
  const maximumLength = Math.max(0, ...resultSets.map((results) => results.length));
  for (let index = 0; index < maximumLength && selected.length < limit; index += 1) {
    for (let queryIndex = 0; queryIndex < resultSets.length; queryIndex += 1) {
      const track = resultSets[queryIndex][index];
      if (!track) continue;
      const existing = selectedById.get(track.track_ref_id);
      if (existing) {
        if (!existing.matched_queries.includes(queries[queryIndex])) {
          existing.matched_queries.push(queries[queryIndex]);
        }
        continue;
      }
      const artistKey = normalizeForMatch(track.artist_credit);
      const releaseKey = `${artistKey}|${normalizeForMatch(track.release)}`;
      if (
        selectedReleaseKeys.has(releaseKey) ||
        (selectedArtistCounts.get(artistKey) ?? 0) >= 2
      ) {
        continue;
      }
      const result = {
        ...track,
        matched_queries: [queries[queryIndex]],
      };
      selected.push(result);
      selectedById.set(track.track_ref_id, result);
      selectedReleaseKeys.add(releaseKey);
      selectedArtistCounts.set(
        artistKey,
        (selectedArtistCounts.get(artistKey) ?? 0) + 1,
      );
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function cachedRequest(cache, key, ttlMs, now, loader) {
  const current = now();
  const existing = cache.get(key);
  if (existing && existing.expires_at_ms > current) return existing.promise;
  const entry = {
    expires_at_ms: current + ttlMs,
    promise: Promise.resolve().then(loader),
  };
  cache.set(key, entry);
  entry.promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return entry.promise;
}

async function parseJsonResponse(response) {
  if (!response || response.ok !== true) {
    const status = Number.isInteger(response?.status) ? response.status : 0;
    fail(
      "apple_music_catalog_http_error",
      status > 0
        ? `Apple Music catalog returned HTTP ${status}.`
        : "Apple Music catalog request failed.",
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(
      "apple_music_catalog_response_invalid",
      "Apple Music catalog returned invalid JSON.",
    );
  }
  if (!isPlainObject(payload) || !Array.isArray(payload.results)) {
    fail(
      "apple_music_catalog_response_invalid",
      "Apple Music catalog returned an invalid response.",
    );
  }
  return payload.results;
}

export function createAppleMusicCatalogClient({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheTtlMs = APPLE_MUSIC_CATALOG_LIMITS.cacheTtlMs,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
    throw new TypeError("The Apple Music catalog cache TTL is invalid.");
  }
  const cache = new Map();

  async function request(pathname, parameters) {
    const url = new URL(pathname, appleCatalogOrigin);
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(
          APPLE_MUSIC_CATALOG_LIMITS.requestTimeoutMs,
        ),
      });
      return await parseJsonResponse(response);
    } catch (error) {
      if (error instanceof AppleMusicCatalogError) throw error;
      fail(
        "apple_music_catalog_request_failed",
        "Apple Music catalog could not be reached.",
      );
    }
  }

  async function artistCatalog(artistId) {
    const catalogId = cleanArtistCatalogId(artistId);
    const key = `artist-catalog|US|${catalogId}`;
    return cachedRequest(cache, key, cacheTtlMs, now, async () => {
      const results = await request("/lookup", {
        id: catalogId,
        country: "us",
        entity: "album",
        limit: APPLE_MUSIC_CATALOG_LIMITS.releasesPerArtistMax,
        sort: "recent",
      });
      const artist = results
        .map(normalizeArtist)
        .find((candidate) => candidate?.catalog_id === catalogId) ?? null;
      const releases = deduplicateAndSortReleases(
        results
          .map((result) => normalizeRelease(result, catalogId))
          .filter(Boolean),
      );
      return { artist, releases };
    });
  }

  return Object.freeze({
    async searchTracks(query) {
      const cleaned = cleanInputText(
        query,
        APPLE_MUSIC_CATALOG_LIMITS.discoveryQueryLengthMax,
        "apple_music_catalog_query_invalid",
        "catalog query",
      );
      const key = `tracks|US|${normalizeForMatch(cleaned)}`;
      return cachedRequest(cache, key, cacheTtlMs, now, async () => {
        const results = await request("/search", {
          term: cleaned,
          country: "us",
          media: "music",
          entity: "song",
          limit: APPLE_MUSIC_CATALOG_LIMITS.trackSearchResultsMax,
          explicit: "No",
        });
        return results.map(normalizeTrack).filter(Boolean);
      });
    },

    async searchArtists(artistName) {
      const cleaned = cleanInputText(
        artistName,
        APPLE_MUSIC_CATALOG_LIMITS.artistNameLengthMax,
        "apple_music_catalog_artist_invalid",
        "artist name",
      );
      const key = `artists|US|${normalizeForMatch(cleaned)}`;
      return cachedRequest(cache, key, cacheTtlMs, now, async () => {
        const results = await request("/search", {
          term: cleaned,
          country: "us",
          media: "music",
          entity: "musicArtist",
          attribute: "artistTerm",
          limit: APPLE_MUSIC_CATALOG_LIMITS.artistSearchResultsMax,
          explicit: "No",
        });
        return results.map(normalizeArtist).filter(Boolean);
      });
    },

    async artistIdentity(artistId) {
      return (await artistCatalog(artistId)).artist;
    },

    async artistReleases(artistId) {
      return (await artistCatalog(artistId)).releases;
    },
  });
}

function candidateSummary(artist, releases = []) {
  return {
    artist,
    recent_releases: releases.slice(
      0,
      APPLE_MUSIC_CATALOG_LIMITS.ambiguousCandidateReleasesMax,
    ),
  };
}

export function createAppleMusicCatalog({
  client = createAppleMusicCatalogClient(),
  now = Date.now,
} = {}) {
  if (
    !client ||
    typeof client.searchTracks !== "function" ||
    typeof client.searchArtists !== "function" ||
    typeof client.artistReleases !== "function"
  ) {
    throw new TypeError("The Apple Music catalog client is invalid.");
  }

  return Object.freeze({
    async searchTracks({ queries, limit = 8 } = {}) {
      if (
        !Array.isArray(queries) ||
        queries.length < 1 ||
        queries.length > APPLE_MUSIC_CATALOG_LIMITS.discoveryQueriesMax
      ) {
        fail(
          "apple_music_catalog_queries_invalid",
          "The catalog discovery queries are invalid.",
        );
      }
      const cleanedQueries = queries.map((query) =>
        cleanInputText(
          query,
          APPLE_MUSIC_CATALOG_LIMITS.discoveryQueryLengthMax,
          "apple_music_catalog_query_invalid",
          "catalog query",
        ),
      );
      if (new Set(cleanedQueries.map(normalizeForMatch)).size !== cleanedQueries.length) {
        fail(
          "apple_music_catalog_queries_invalid",
          "The catalog discovery queries must be distinct.",
        );
      }
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > APPLE_MUSIC_CATALOG_LIMITS.outputTracksMax
      ) {
        fail(
          "apple_music_catalog_limit_invalid",
          "The track result limit is invalid.",
        );
      }

      const resultSets = [];
      for (const query of cleanedQueries) {
        resultSets.push(await client.searchTracks(query));
      }
      const source = {
        ...sourceMetadata(now),
        coverage:
          "Keyword relevance from the Apple Music US storefront. Results are external catalog candidates, not proof of personal fit, novelty, or cross-platform availability.",
      };
      const tracks = interleaveTrackResults(
        resultSets,
        cleanedQueries,
        limit,
      );
      return {
        state: tracks.length > 0 ? "resolved" : "not_found",
        source,
        queries: cleanedQueries,
        result_count: tracks.length,
        tracks,
      };
    },

    async findArtistReleasesByCatalogId({
      artistCatalogId,
      limit = 6,
    } = {}) {
      const catalogId = cleanArtistCatalogId(artistCatalogId);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > APPLE_MUSIC_CATALOG_LIMITS.outputReleasesMax
      ) {
        fail(
          "apple_music_catalog_limit_invalid",
          "The release result limit is invalid.",
        );
      }
      if (typeof client.artistIdentity !== "function") {
        fail(
          "apple_music_catalog_artist_identity_unavailable",
          "Explicit Apple Music artist lookup is unavailable.",
        );
      }
      const source = sourceMetadata(now);
      const artist = await client.artistIdentity(catalogId);
      if (!artist) {
        return {
          state: "not_found",
          source,
          query: { artist_catalog_id: catalogId },
          candidates: [],
        };
      }
      const releases = await client.artistReleases(catalogId);
      const split = releasedAndUpcoming(releases, source.retrieved_at);
      return {
        state: "resolved",
        source,
        query: { artist_catalog_id: catalogId },
        artist,
        selection_basis: "explicit_artist_catalog_identity",
        releases: split.released.slice(0, limit),
        latest_released_single:
          split.released.find(
            (release) => release.release_type === "single",
          ) ?? null,
        upcoming_releases: split.upcoming.slice(0, limit),
        candidates: [],
      };
    },

    async findArtistReleases({
      artistName,
      artistCatalogId,
      knownRelease,
      limit = 6,
    } = {}) {
      const artist = cleanInputText(
        artistName,
        APPLE_MUSIC_CATALOG_LIMITS.artistNameLengthMax,
        "apple_music_catalog_artist_invalid",
        "artist name",
      );
      const releaseHint =
        knownRelease === undefined
          ? null
          : cleanInputText(
              knownRelease,
              APPLE_MUSIC_CATALOG_LIMITS.releaseHintLengthMax,
              "apple_music_catalog_release_hint_invalid",
              "known release",
            );
      const explicitCatalogId =
        artistCatalogId === undefined
          ? null
          : cleanArtistCatalogId(artistCatalogId);
      if (releaseHint && explicitCatalogId) {
        fail(
          "apple_music_catalog_identity_hints_conflict",
          "Use either a known release or an explicit artist identity, not both.",
        );
      }
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > APPLE_MUSIC_CATALOG_LIMITS.outputReleasesMax
      ) {
        fail(
          "apple_music_catalog_limit_invalid",
          "The release result limit is invalid.",
        );
      }

      const source = sourceMetadata(now);
      const normalizedArtist = normalizeForMatch(artist);
      let selected = null;
      let selectedReleases = [];
      let selectionBasis = null;
      const releasesByArtist = new Map();
      let exactCandidates = [];

      if (explicitCatalogId) {
        if (typeof client.artistIdentity !== "function") {
          fail(
            "apple_music_catalog_artist_identity_unavailable",
            "Explicit Apple Music artist lookup is unavailable.",
          );
        }
        selected = await client.artistIdentity(explicitCatalogId);
        if (!selected) {
          return {
            state: "not_found",
            source,
            query: {
              artist_name: artist,
              artist_catalog_id: explicitCatalogId,
            },
            candidates: [],
          };
        }
        if (normalizeForMatch(selected.name) !== normalizedArtist) {
          return {
            state: "artist_identity_mismatch",
            source,
            query: {
              artist_name: artist,
              artist_catalog_id: explicitCatalogId,
            },
            artist: selected,
            candidates: [],
          };
        }
        selectedReleases = await client.artistReleases(selected.catalog_id);
        selectionBasis = "explicit_artist_catalog_page";
      } else {
        const searched = await client.searchArtists(artist);
        exactCandidates = searched
          .filter(
            (candidate) =>
              normalizeForMatch(candidate.name) === normalizedArtist,
          )
          .slice(0, APPLE_MUSIC_CATALOG_LIMITS.exactArtistCandidatesMax);

        if (exactCandidates.length === 0) {
          return {
            state: "not_found",
            source,
            query: { artist_name: artist },
            candidates: [],
          };
        }

        if (exactCandidates.length === 1) {
          selected = exactCandidates[0];
          selectedReleases = await client.artistReleases(selected.catalog_id);
          selectionBasis = "unique_exact_artist_name";
        } else if (releaseHint) {
          const normalizedHint = normalizeForMatch(releaseHint);
          const matching = [];
          for (const candidate of exactCandidates) {
            const releases = await client.artistReleases(candidate.catalog_id);
            releasesByArtist.set(candidate.catalog_id, releases);
            if (
              releases.some(
                (release) => normalizeForMatch(release.title) === normalizedHint,
              )
            ) {
              matching.push(candidate);
            }
          }
          if (matching.length === 1) {
            selected = matching[0];
            selectedReleases =
              releasesByArtist.get(selected.catalog_id) ?? [];
            selectionBasis = "exact_artist_name_and_known_release";
          }
        }
      }

      if (!selected) {
        return {
          state: "ambiguous_artist",
          source,
          query: {
            artist_name: artist,
            ...(releaseHint ? { known_release: releaseHint } : {}),
            ...(explicitCatalogId
              ? { artist_catalog_id: explicitCatalogId }
              : {}),
          },
          candidates: exactCandidates.map((candidate) =>
            candidateSummary(
              candidate,
              releasesByArtist.get(candidate.catalog_id) ?? [],
            ),
          ),
        };
      }

      const split = releasedAndUpcoming(
        selectedReleases,
        source.retrieved_at,
      );
      return {
        state: "resolved",
        source,
        query: {
          artist_name: artist,
          ...(releaseHint ? { known_release: releaseHint } : {}),
          ...(explicitCatalogId
            ? { artist_catalog_id: explicitCatalogId }
            : {}),
        },
        artist: selected,
        selection_basis: selectionBasis,
        releases: split.released.slice(0, limit),
        latest_released_single:
          split.released.find(
            (release) => release.release_type === "single",
          ) ?? null,
        upcoming_releases: split.upcoming.slice(0, limit),
        candidates: [],
      };
    },
  });
}
