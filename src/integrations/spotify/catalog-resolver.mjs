import { spotifyResolutionCacheKey } from "./resolution-cache.mjs";

export const SPOTIFY_CATALOG_RESOLVER_LIMITS = Object.freeze({
  tracksPerCallMax: 12,
  trackRefIdLengthMax: 128,
  titleLengthMax: 512,
  artistCreditLengthMax: 512,
  releaseLengthMax: 512,
  searchResultsMax: 10,
  durationToleranceMs: 3_000,
});

const artistSeparators =
  /\s*(?:,|;|&|\/|(?:featuring|feat\.?|ft\.?|with)(?=\s|$)|、|和|与)\s*/iu;
const bracketedDescriptorPattern = /[（(【\[]([^）)】\]]+)[）)】\]]/gu;
const trailingDescriptorPattern = /^(.*)\s+(?:-|–)\s+(.+)$/u;
const materialRecordingTags = new Set([
  "acoustic",
  "clean",
  "demo",
  "edit",
  "extended",
  "instrumental",
  "karaoke",
  "live",
  "mono",
  "radio_edit",
  "rerecorded",
  "remix",
  "session",
  "single_edit",
  "slowed",
  "sped_up",
  "stereo",
  "version",
]);
const spotifyTrackIdPattern = /^[A-Za-z0-9]{22}$/u;

export class SpotifyCatalogResolverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpotifyCatalogResolverError";
    this.code = code;
    this.provider = "spotify";
  }
}

function fail(code, message) {
  throw new SpotifyCatalogResolverError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanInputText(value, maximum, code, field) {
  if (
    typeof value !== "string" ||
    Array.from(value).length < 1 ||
    Array.from(value).length > maximum
  ) {
    fail(code, `The track ${field} is invalid.`);
  }
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) fail(code, `The track ${field} is invalid.`);
  return cleaned;
}

function trustedSpotifyTrackId(track) {
  if (track.external_refs === undefined) return undefined;
  if (track.candidate_scope !== "private_history" || !Array.isArray(track.external_refs)) {
    fail("invalid_tracks", "A trusted Spotify track reference is invalid.");
  }
  const ids = [];
  for (const raw of track.external_refs) {
    if (!isPlainObject(raw) || raw.system !== "spotify") continue;
    if (
      raw.entity_type !== "spotify.track" ||
      typeof raw.external_id !== "string" ||
      !spotifyTrackIdPattern.test(raw.external_id)
    ) {
      fail("invalid_tracks", "A trusted Spotify track reference is invalid.");
    }
    if (!ids.includes(raw.external_id)) ids.push(raw.external_id);
  }
  if (ids.length > 1) {
    fail("invalid_tracks", "A trusted Spotify track reference is ambiguous.");
  }
  return ids[0];
}

export function primaryArtistName(artistCredit) {
  const segments = artistCredit
    .split(artistSeparators)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments[0] ?? artistCredit.trim();
}

function normalizeForMatch(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/["'‘’“”`]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function descriptorDetails(value) {
  const raw = String(value).trim();
  const normalized = normalizeForMatch(raw);
  const tags = new Set();
  const collaborators = [];
  const remasterYears = new Set();
  let recognized = false;

  const feature = /^(?:feat(?:uring)?\.?|ft\.?)\s+(.+)$/iu.exec(raw);
  if (feature) {
    recognized = true;
    collaborators.push(feature[1]);
  }
  if (/\b(?:re ?master(?:ed|ing)?|remaster(?:ed|ing)?)\b/u.test(normalized)) {
    recognized = true;
    tags.add("remaster");
    for (const matched of normalized.matchAll(/\b(?:19|20)\d{2}\b/gu)) {
      remasterYears.add(matched[0]);
    }
  }
  if (
    normalized === "live" ||
    /^(?:live\b|recorded live\b|in concert\b|concert version\b)/u.test(normalized)
  ) {
    recognized = true;
    tags.add("live");
  }
  if (/\bradio (?:edit|version|mix)\b/u.test(normalized)) {
    recognized = true;
    tags.add("radio_edit");
  } else if (/\bsingle (?:edit|version|mix)\b/u.test(normalized)) {
    recognized = true;
    tags.add("single_edit");
  } else if (/\bextended (?:edit|version|mix)\b/u.test(normalized)) {
    recognized = true;
    tags.add("extended");
  } else if (/\bedit\b/u.test(normalized)) {
    recognized = true;
    tags.add("edit");
  }
  if (/\bremix(?:ed)?\b/u.test(normalized)) {
    recognized = true;
    tags.add("remix");
  }
  if (/\bacoustic\b/u.test(normalized)) {
    recognized = true;
    tags.add("acoustic");
  }
  if (/\bdemo\b/u.test(normalized)) {
    recognized = true;
    tags.add("demo");
  }
  if (/\binstrumental\b/u.test(normalized)) {
    recognized = true;
    tags.add("instrumental");
  }
  if (/\bkaraoke\b/u.test(normalized)) {
    recognized = true;
    tags.add("karaoke");
  }
  if (/\bmono(?:phonic)?\b/u.test(normalized)) {
    recognized = true;
    tags.add("mono");
  }
  if (/\bstereo(?:phonic)?\b/u.test(normalized)) {
    recognized = true;
    tags.add("stereo");
  }
  if (/\b(?:bbc |studio )?session\b/u.test(normalized)) {
    recognized = true;
    tags.add("session");
  }
  if (/\bre ?record(?:ed|ing)?\b/u.test(normalized)) {
    recognized = true;
    tags.add("rerecorded");
  }
  if (/\bsped up\b/u.test(normalized)) {
    recognized = true;
    tags.add("sped_up");
  }
  if (/\b(?:slowed|slow version)\b/u.test(normalized)) {
    recognized = true;
    tags.add("slowed");
  }
  if (/\bclean(?: version)?\b/u.test(normalized)) {
    recognized = true;
    tags.add("clean");
  }

  const neutralVersion = /^(?:album|lp|original) (?:mix|version)$/u.test(normalized);
  const neutralEdition =
    /^(?:(?:deluxe|expanded|anniversary) edition|bonus track)$/u.test(normalized);
  if (neutralVersion || neutralEdition) recognized = true;
  if (
    !neutralVersion &&
    tags.size === 0 &&
    /\bversion\b/u.test(normalized)
  ) {
    recognized = true;
    tags.add("version");
  }

  return { recognized, tags, collaborators, remasterYears };
}

function mergeDescriptor(target, details) {
  for (const tag of details.tags) target.tags.add(tag);
  for (const collaborator of details.collaborators) {
    target.collaborators.push(collaborator);
  }
  for (const year of details.remasterYears) target.remasterYears.add(year);
}

function analyzeComparableTitle(value) {
  const target = {
    tags: new Set(),
    collaborators: [],
    remasterYears: new Set(),
  };
  const original = String(value);
  let core = original.replace(
    bracketedDescriptorPattern,
    (whole, descriptor) => {
      const details = descriptorDetails(descriptor);
      if (!details.recognized) return whole;
      mergeDescriptor(target, details);
      return " ";
    },
  );
  while (true) {
    const matched = trailingDescriptorPattern.exec(core);
    if (!matched) break;
    const details = descriptorDetails(matched[2]);
    if (!details.recognized) break;
    mergeDescriptor(target, details);
    core = matched[1];
  }
  return {
    ...target,
    core: normalizeForMatch(core),
    normalized: normalizeForMatch(original),
  };
}

export function coreComparableTitle(title) {
  return analyzeComparableTitle(title).core;
}

function searchTerm(value) {
  return value.replace(/["'‘’“”`]/gu, "").replace(/\s+/gu, " ").trim();
}

function fieldedSearchQuery(track) {
  const artist = searchTerm(primaryArtistName(track.artist_credit));
  return `track:"${searchTerm(track.title)}"${artist ? ` artist:"${artist}"` : ""}`;
}

function plainSearchQuery(track) {
  const artist = searchTerm(primaryArtistName(track.artist_credit));
  return [searchTerm(track.title), artist].filter(Boolean).join(" ");
}

function albumMatches(release, album) {
  if (typeof album !== "string" || typeof release !== "string") return false;
  const left = coreComparableTitle(release);
  const right = coreComparableTitle(album);
  return left.length > 0 && left === right;
}

function durationMatches(expectedMs, actualMs) {
  if (
    !Number.isInteger(expectedMs) ||
    !Number.isInteger(actualMs) ||
    expectedMs < 0 ||
    actualMs < 0
  ) {
    return false;
  }
  return Math.abs(expectedMs - actualMs) <= SPOTIFY_CATALOG_RESOLVER_LIMITS.durationToleranceMs;
}

function artistNameCompatible(left, right) {
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function artistParticipants(artistCredits, titleCollaborators = []) {
  const credits = Array.isArray(artistCredits) ? artistCredits : [artistCredits];
  const participants = [];
  for (const credit of [...credits, ...titleCollaborators]) {
    if (typeof credit !== "string") continue;
    for (const segment of credit.split(artistSeparators)) {
      const normalized = normalizeForMatch(segment);
      if (normalized && !participants.includes(normalized)) {
        participants.push(normalized);
      }
    }
  }
  return participants;
}

function artistsCompatible(track, candidate, trackTitle, candidateTitle) {
  const sourcePrimary = normalizeForMatch(primaryArtistName(track.artist_credit));
  const candidatePrimary = normalizeForMatch(candidate.artists?.[0] ?? "");
  if (!artistNameCompatible(sourcePrimary, candidatePrimary)) return false;

  const source = artistParticipants(
    track.artist_credit,
    trackTitle.collaborators,
  );
  const available = artistParticipants(
    candidate.artists,
    candidateTitle.collaborators,
  );
  if (source.length !== available.length) return false;
  for (const participant of source) {
    let index = available.indexOf(participant);
    if (index < 0) {
      index = available.findIndex((candidateArtist) =>
        artistNameCompatible(participant, candidateArtist),
      );
    }
    if (index < 0) return false;
    available.splice(index, 1);
  }
  return available.length === 0;
}

function setEquals(left, right) {
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

function recordingIdentity(title, release) {
  const titleDetails = analyzeComparableTitle(title);
  const releaseDetails = analyzeComparableTitle(release ?? "");
  const tags = new Set([...titleDetails.tags, ...releaseDetails.tags]);
  const materialTags = new Set(
    [...tags].filter((tag) => materialRecordingTags.has(tag)),
  );
  return {
    title: titleDetails,
    materialTags,
    remastered: tags.has("remaster"),
    remasterYears: new Set([
      ...titleDetails.remasterYears,
      ...releaseDetails.remasterYears,
    ]),
  };
}

function remasterYearsConflict(left, right) {
  if (left.size === 0 || right.size === 0) return false;
  return ![...left].some((year) => right.has(year));
}

function recordingCompatibility(source, candidate, albumMatch, durationMatch) {
  if (!setEquals(source.materialTags, candidate.materialTags)) return null;
  if (
    source.remastered &&
    candidate.remastered &&
    remasterYearsConflict(source.remasterYears, candidate.remasterYears)
  ) {
    return null;
  }

  const titleExact = source.title.normalized === candidate.title.normalized;
  const corroborated = albumMatch || durationMatch;
  if (source.remastered !== candidate.remastered) {
    if (!corroborated) return null;
    return { rank: 1, quality: "alternate_master" };
  }
  if (
    (source.materialTags.size > 0 || source.remastered) &&
    !titleExact &&
    !corroborated
  ) {
    return null;
  }
  return {
    rank: 2,
    quality: corroborated ? "exact" : "standard",
  };
}

function bestCandidate(track, candidates) {
  const eligible = [];
  const sourceIdentity = recordingIdentity(track.title, track.release);
  for (const candidate of candidates) {
    if (!isPlainObject(candidate) || typeof candidate.uri !== "string") continue;
    const candidateIdentity = recordingIdentity(
      candidate.name ?? "",
      candidate.album,
    );
    const titleMatch = candidateIdentity.title.core === sourceIdentity.title.core;
    if (!titleMatch) continue;
    if (
      !artistsCompatible(
        track,
        candidate,
        sourceIdentity.title,
        candidateIdentity.title,
      )
    ) {
      continue;
    }
    const albumMatch = albumMatches(track.release, candidate.album);
    const durationMatch = durationMatches(
      track.duration_ms,
      candidate.duration_ms,
    );
    const recordingMatch = recordingCompatibility(
      sourceIdentity,
      candidateIdentity,
      albumMatch,
      durationMatch,
    );
    if (!recordingMatch) continue;
    eligible.push({
      candidate,
      albumMatch,
      durationMatch,
      recordingRank: recordingMatch.rank,
      quality: recordingMatch.quality,
      score: (albumMatch ? 2 : 0) + (durationMatch ? 1 : 0),
      popularity: Number.isInteger(candidate.popularity)
        ? candidate.popularity
        : 0,
    });
  }
  if (eligible.length === 0) return null;
  eligible.sort((left, right) => {
    if (right.recordingRank !== left.recordingRank) {
      return right.recordingRank - left.recordingRank;
    }
    if (right.score !== left.score) return right.score - left.score;
    if (right.popularity !== left.popularity) {
      return right.popularity - left.popularity;
    }
    return left.candidate.uri < right.candidate.uri
      ? -1
      : left.candidate.uri > right.candidate.uri
        ? 1
        : 0;
  });
  const winner = eligible[0];
  return {
    candidate: winner.candidate,
    quality: winner.quality,
    recordingRank: winner.recordingRank,
    score: winner.score,
    popularity: winner.popularity,
  };
}

function entryFromMatch(match) {
  const matched = {
    title: match.candidate.name,
    artists: match.candidate.artists ?? [],
  };
  if (typeof match.candidate.album === "string") {
    matched.album = match.candidate.album;
  }
  if (Number.isInteger(match.candidate.duration_ms)) {
    matched.duration_ms = match.candidate.duration_ms;
  }
  return {
    status: "resolved",
    match_quality: match.quality,
    matched,
    spotify: {
      track_id: match.candidate.id,
      uri: match.candidate.uri,
    },
  };
}

function entryFromProviderId(track) {
  const matched = {
    title: track.title,
    artists: [track.artist_credit],
    album: track.release,
  };
  if (Number.isInteger(track.duration_ms)) {
    matched.duration_ms = track.duration_ms;
  }
  return {
    status: "resolved",
    match_quality: "provider_id",
    matched,
    spotify: {
      track_id: track.spotify_external_id,
      uri: `spotify:track:${track.spotify_external_id}`,
    },
  };
}

function resolutionKey(track) {
  return track.spotify_external_id
    ? `spotify-id:${track.spotify_external_id}`
    : spotifyResolutionCacheKey(track);
}

export function createSpotifyCatalogResolver({ client, cache = null, now = Date.now } = {}) {
  if (!client || typeof client !== "object") {
    throw new TypeError("A Spotify Web API client is required.");
  }
  if (cache !== null && (typeof cache.get !== "function" || typeof cache.put !== "function")) {
    throw new TypeError("The Spotify resolution cache interface is invalid.");
  }

  async function searchAndMatch(track) {
    const queries = [
      fieldedSearchQuery(track),
      plainSearchQuery(track),
    ];
    let fallback = null;
    for (const query of queries) {
      const result = await client.searchTracks({
        query,
        limit: SPOTIFY_CATALOG_RESOLVER_LIMITS.searchResultsMax,
      });
      const items = Array.isArray(result?.items) ? result.items : [];
      const match = bestCandidate(track, items);
      if (!match) continue;
      if (match.recordingRank > 1) return entryFromMatch(match);
      if (
        !fallback ||
        match.score > fallback.score ||
        (match.score === fallback.score && match.popularity > fallback.popularity) ||
        (match.score === fallback.score &&
          match.popularity === fallback.popularity &&
          match.candidate.uri < fallback.candidate.uri)
      ) {
        fallback = match;
      }
    }
    if (fallback) return entryFromMatch(fallback);
    return { status: "not_found" };
  }

  return Object.freeze({
    async resolve(tracks) {
      if (!Array.isArray(tracks) || tracks.length < 1) {
        fail("invalid_tracks", "At least one track is required for resolution.");
      }
      if (tracks.length > SPOTIFY_CATALOG_RESOLVER_LIMITS.tracksPerCallMax) {
        fail("invalid_tracks", "Too many tracks were submitted for resolution.");
      }
      const seenRefIds = new Set();
      const prepared = tracks.map((track) => {
        if (!isPlainObject(track)) {
          fail("invalid_tracks", "A resolution track is invalid.");
        }
        const trackRefId = cleanInputText(
          track.track_ref_id,
          SPOTIFY_CATALOG_RESOLVER_LIMITS.trackRefIdLengthMax,
          "invalid_track_ref",
          "reference ID",
        );
        if (seenRefIds.has(trackRefId)) {
          fail("invalid_tracks", "Duplicate track references cannot be resolved.");
        }
        seenRefIds.add(trackRefId);
        const preparedTrack = {
          track_ref_id: trackRefId,
          title: cleanInputText(
            track.title,
            SPOTIFY_CATALOG_RESOLVER_LIMITS.titleLengthMax,
            "invalid_track_title",
            "title",
          ),
          artist_credit: cleanInputText(
            track.artist_credit,
            SPOTIFY_CATALOG_RESOLVER_LIMITS.artistCreditLengthMax,
            "invalid_track_artist",
            "artist credit",
          ),
          release: cleanInputText(
            track.release,
            SPOTIFY_CATALOG_RESOLVER_LIMITS.releaseLengthMax,
            "invalid_track_release",
            "release",
          ),
        };
        if (
          Number.isInteger(track.duration_ms) &&
          track.duration_ms >= 0 &&
          track.duration_ms <= 86_400_000
        ) {
          preparedTrack.duration_ms = track.duration_ms;
        }
        const spotifyExternalId = trustedSpotifyTrackId(track);
        if (spotifyExternalId) {
          preparedTrack.spotify_external_id = spotifyExternalId;
        }
        return preparedTrack;
      });

      const uniqueKeys = new Map();
      for (const track of prepared) {
        const cacheKey = resolutionKey(track);
        if (!uniqueKeys.has(cacheKey)) uniqueKeys.set(cacheKey, track);
      }

      const entriesByKey = new Map();
      await Promise.all(
        [...uniqueKeys.entries()].map(async ([cacheKey, track]) => {
          if (track.spotify_external_id) {
            entriesByKey.set(cacheKey, entryFromProviderId(track));
            return;
          }
          let entry = cache ? await cache.get(cacheKey) : null;
          if (!entry) {
            entry = await searchAndMatch(track);
            if (entry.status === "resolved" && cache) {
              await cache.put(cacheKey, entry, now());
            }
          }
          entriesByKey.set(cacheKey, entry);
        }),
      );

      const resolutions = prepared.map((track) => {
        const entry = entriesByKey.get(resolutionKey(track));
        return {
          track_ref_id: track.track_ref_id,
          ...structuredClone(entry ?? { status: "not_found" }),
        };
      });
      return {
        provider: "spotify",
        resolutions,
        resolved_count: resolutions.filter(
          (resolution) => resolution.status === "resolved",
        ).length,
        not_found_count: resolutions.filter(
          (resolution) => resolution.status !== "resolved",
        ).length,
      };
    },
  });
}
