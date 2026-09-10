import { createHash } from "node:crypto";

import { isUuid, uuidV5 } from "../../core/uuid-v5.mjs";
import { SPOTIFY_TRACK_NAMESPACE } from "./recent-activity.mjs";

export const SPOTIFY_ACCOUNT_PROFILE_SOURCE =
  "spotify.account_data.music_profile";
export const SPOTIFY_ACCOUNT_PROFILE_FORMAT =
  "spotify_account_data_music_profile_v1";
export const SPOTIFY_ACCOUNT_PROFILE_IMPORT_NAMESPACE =
  "643b1d15-9104-5ddd-9c76-9427b43e4729";
export const SPOTIFY_ACCOUNT_PROFILE_EVIDENCE_NAMESPACE =
  "96ebeff8-f432-55aa-80d2-415986d7795f";
export const SPOTIFY_ACCOUNT_PROFILE_ENTITY_NAMESPACE =
  "df2fe6d6-3769-5dfd-a4cb-47bd33da4035";

export const SPOTIFY_ACCOUNT_PROFILE_MEMBERS = Object.freeze([
  "Playlist1.json",
  "SearchQueries.json",
  "TasteProfile.json",
  "Wrapped2025.json",
  "YourLibrary.json",
  "YourSoundCapsule.json",
]);

const memberNames = new Set(SPOTIFY_ACCOUNT_PROFILE_MEMBERS);
const spotifyUriPattern =
  /^spotify:(track|artist|album|playlist|show|episode):([A-Za-z0-9]{22})$/u;
const spotifyConceptUriPattern = /^spotify:concept:([A-Za-z0-9]{22})$/u;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const sha256Pattern = /^[a-f0-9]{64}$/u;

export class SpotifyAccountProfileError extends Error {
  constructor(message, code = "spotify_account_profile_invalid") {
    super(message);
    this.name = "SpotifyAccountProfileError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new SpotifyAccountProfileError(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanText(value, maximum, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === "")) {
    return null;
  }
  if (typeof value !== "string") fail(`${label} is invalid.`);
  const cleaned = value
    .normalize("NFC")
    .replace(unsafeTextPattern, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || Array.from(cleaned).length > maximum) {
    fail(`${label} is invalid.`);
  }
  return cleaned;
}

function timestamp(value, label, capturedAt, { dateOnly = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") fail(`${label} is invalid.`);
  const candidate = dateOnly
    ? `${value}T00:00:00.000Z`
    : value.replace(/\[UTC\]$/u, "");
  const milliseconds = Date.parse(candidate);
  if (!Number.isFinite(milliseconds)) fail(`${label} is invalid.`);
  const normalized = new Date(milliseconds).toISOString();
  if (milliseconds > Date.parse(capturedAt)) fail(`${label} is in the future.`);
  return normalized;
}

function requiredArray(value, label, maximum = 100_000) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function hashParts(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(part)).update("\0");
  return hash.digest("hex");
}

function normalizedText(value) {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function uri(value, expectedType, label) {
  const cleaned = cleanText(value, 128, label);
  const match = spotifyUriPattern.exec(cleaned);
  if (!match || (expectedType && match[1] !== expectedType)) {
    fail(`${label} is invalid.`);
  }
  return { type: match[1], id: match[2] };
}

function optionalUri(value) {
  if (typeof value !== "string") return null;
  const match = spotifyUriPattern.exec(value.trim());
  return match ? { type: match[1], id: match[2] } : null;
}

function entityRefId(type, externalId) {
  if (type === "track") return uuidV5(externalId, SPOTIFY_TRACK_NAMESPACE);
  return uuidV5(
    `${type}\0${externalId}`,
    SPOTIFY_ACCOUNT_PROFILE_ENTITY_NAMESPACE,
  );
}

function labelEntityRefId(type, label) {
  return uuidV5(
    `${type}\0label\0${normalizedText(label)}`,
    SPOTIFY_ACCOUNT_PROFILE_ENTITY_NAMESPACE,
  );
}

function clippedDisplayLabel(title, artist) {
  return Array.from(`${title} - ${artist}`).slice(0, 512).join("");
}

function resolvedTrackRef({ id, title, artist, album, observedAt }) {
  const result = {
    schema_version: 1,
    track_ref_id: entityRefId("track", id),
    revision: 1,
    identity_status: "resolved",
    display_label: clippedDisplayLabel(title, artist),
    title,
    artist_credits: [{ name: artist, role: "unknown" }],
    external_refs: [
      {
        system: "spotify",
        entity_type: "spotify.track",
        external_id: id,
      },
    ],
    created_at: observedAt,
    resolved_at: observedAt,
  };
  if (album) result.release = { title: album };
  return result;
}

function numeric(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function integer(value, label, options) {
  numeric(value, label, options);
  if (!Number.isSafeInteger(value)) fail(`${label} is invalid.`);
  return value;
}

function profileBuilder({ subjectId, archiveSha256, capturedAt, profileImportId }) {
  const records = [];
  const tracks = new Map();

  function addTrack(track) {
    const key = `${track.track_ref_id}:${track.revision}`;
    if (!tracks.has(key)) tracks.set(key, track);
  }

  function addEvidence({
    logicalKey,
    kind,
    direction = "supports",
    strengthClass,
    entity,
    observedAt = capturedAt,
    sourceMember,
    attributes = {},
  }) {
    const evidenceKey = hashParts(
      "spotify-account-profile-evidence-key-v1",
      subjectId,
      kind,
      logicalKey,
    );
    records.push({
      schema_version: 1,
      profile_evidence_id: uuidV5(
        `${archiveSha256}\0${evidenceKey}`,
        SPOTIFY_ACCOUNT_PROFILE_EVIDENCE_NAMESPACE,
      ),
      evidence_key: evidenceKey,
      subject_id: subjectId,
      evidence_kind: kind,
      direction,
      strength_class: strengthClass,
      entity,
      observed_at: observedAt,
      attributes,
      provenance: {
        source_kind: "import",
        source_system: "spotify_account_data",
        source_member: sourceMember,
        captured_at: capturedAt,
        profile_import_id: profileImportId,
      },
    });
  }

  return { records, tracks, addTrack, addEvidence };
}

function libraryEvidence(document, context) {
  if (!isPlainObject(document)) fail("YourLibrary.json is invalid.");
  const tracks = requiredArray(document.tracks, "Spotify saved tracks");
  const albums = requiredArray(document.albums, "Spotify saved albums");
  const artists = requiredArray(document.artists, "Spotify followed artists");
  const bannedTracks = requiredArray(
    document.bannedTracks ?? [],
    "Spotify banned tracks",
  );
  const bannedArtists = requiredArray(
    document.bannedArtists ?? [],
    "Spotify banned artists",
  );

  for (const [index, item] of tracks.entries()) {
    if (!isPlainObject(item)) fail("Spotify saved track is invalid.");
    const parsedUri = uri(item.uri, "track", "Spotify saved track URI");
    const title = cleanText(item.track, 512, "Spotify saved track title");
    const artist = cleanText(item.artist, 512, "Spotify saved track artist");
    const album = cleanText(item.album, 512, "Spotify saved track album", {
      optional: true,
    });
    const track = resolvedTrackRef({
      id: parsedUri.id,
      title,
      artist,
      album,
      observedAt: context.capturedAt,
    });
    context.addTrack(track);
    context.trackLabels.set(parsedUri.id, { title, artist, album });
    context.addEvidence({
      logicalKey: `saved-track\0${parsedUri.id}`,
      kind: "library_track_saved",
      strengthClass: "explicit",
      entity: {
        entity_type: "track",
        entity_ref_id: track.track_ref_id,
        track_ref_id: track.track_ref_id,
        track_ref_revision: 1,
        label: title,
        artist_credit: artist,
        ...(album ? { release: album } : {}),
      },
      sourceMember: "YourLibrary.json",
      attributes: { source_position: index + 1 },
    });
  }

  for (const [index, item] of albums.entries()) {
    if (!isPlainObject(item)) fail("Spotify saved album is invalid.");
    const parsedUri = uri(item.uri, "album", "Spotify saved album URI");
    const label = cleanText(item.album, 512, "Spotify saved album title");
    const artist = cleanText(item.artist, 512, "Spotify saved album artist");
    context.albumLabels.set(parsedUri.id, { label, artist });
    context.addEvidence({
      logicalKey: `saved-album\0${parsedUri.id}`,
      kind: "library_album_saved",
      strengthClass: "explicit",
      entity: {
        entity_type: "album",
        entity_ref_id: entityRefId("album", parsedUri.id),
        label,
        artist_credit: artist,
      },
      sourceMember: "YourLibrary.json",
      attributes: { source_position: index + 1 },
    });
  }

  for (const [index, item] of artists.entries()) {
    if (!isPlainObject(item)) fail("Spotify followed artist is invalid.");
    const parsedUri = uri(item.uri, "artist", "Spotify followed artist URI");
    const name = cleanText(item.name, 512, "Spotify followed artist name");
    context.artistLabels.set(parsedUri.id, name);
    context.addEvidence({
      logicalKey: `followed-artist\0${parsedUri.id}`,
      kind: "library_artist_followed",
      strengthClass: "explicit",
      entity: {
        entity_type: "artist",
        entity_ref_id: entityRefId("artist", parsedUri.id),
        label: name,
      },
      sourceMember: "YourLibrary.json",
      attributes: { source_position: index + 1 },
    });
  }

  for (const [index, item] of bannedTracks.entries()) {
    if (!isPlainObject(item)) fail("Spotify banned track is invalid.");
    const parsedUri = uri(item.uri, "track", "Spotify banned track URI");
    const title = cleanText(item.track, 512, "Spotify banned track title");
    const artist = cleanText(item.artist, 512, "Spotify banned track artist");
    context.addEvidence({
      logicalKey: `banned-track\0${parsedUri.id}`,
      kind: "library_track_banned",
      direction: "contradicts",
      strengthClass: "explicit",
      entity: {
        entity_type: "track",
        entity_ref_id: entityRefId("track", parsedUri.id),
        track_ref_id: entityRefId("track", parsedUri.id),
        track_ref_revision: 1,
        label: title,
        artist_credit: artist,
      },
      sourceMember: "YourLibrary.json",
      attributes: { source_position: index + 1 },
    });
  }

  for (const [index, item] of bannedArtists.entries()) {
    if (!isPlainObject(item)) fail("Spotify banned artist is invalid.");
    const parsedUri = uri(item.uri, "artist", "Spotify banned artist URI");
    const name = cleanText(item.name, 512, "Spotify banned artist name");
    context.addEvidence({
      logicalKey: `banned-artist\0${parsedUri.id}`,
      kind: "library_artist_banned",
      direction: "contradicts",
      strengthClass: "explicit",
      entity: {
        entity_type: "artist",
        entity_ref_id: entityRefId("artist", parsedUri.id),
        label: name,
      },
      sourceMember: "YourLibrary.json",
      attributes: { source_position: index + 1 },
    });
  }
}

function playlistEvidence(document, context) {
  if (!isPlainObject(document)) fail("Playlist1.json is invalid.");
  const playlists = requiredArray(document.playlists, "Spotify playlists", 10_000);
  for (const [playlistIndex, playlist] of playlists.entries()) {
    if (!isPlainObject(playlist)) fail("Spotify playlist is invalid.");
    const name = cleanText(playlist.name, 512, "Spotify playlist name");
    const modifiedAt = timestamp(
      playlist.lastModifiedDate,
      "Spotify playlist modification date",
      context.capturedAt,
      { dateOnly: true },
    );
    const playlistRef = labelEntityRefId(
      "playlist",
      `${playlistIndex + 1}\0${name}`,
    );
    const items = requiredArray(
      playlist.items,
      "Spotify playlist items",
      100_000,
    );
    for (const [itemIndex, item] of items.entries()) {
      if (!isPlainObject(item) || !isPlainObject(item.track)) {
        fail("Spotify playlist item is invalid.");
      }
      const parsedUri = uri(
        item.track.trackUri,
        "track",
        "Spotify playlist track URI",
      );
      const title = cleanText(
        item.track.trackName,
        512,
        "Spotify playlist track title",
      );
      const artist = cleanText(
        item.track.artistName,
        512,
        "Spotify playlist track artist",
      );
      const album = cleanText(
        item.track.albumName,
        512,
        "Spotify playlist track album",
        { optional: true },
      );
      const addedAt = timestamp(
        item.addedDate,
        "Spotify playlist added date",
        context.capturedAt,
        { dateOnly: true },
      );
      const observedAt = addedAt ?? modifiedAt ?? context.capturedAt;
      const track = resolvedTrackRef({
        id: parsedUri.id,
        title,
        artist,
        album,
        observedAt,
      });
      context.addTrack(track);
      if (!context.trackLabels.has(parsedUri.id)) {
        context.trackLabels.set(parsedUri.id, { title, artist, album });
      }
      context.addEvidence({
        logicalKey: `playlist-track\0${playlistRef}\0${parsedUri.id}\0${itemIndex + 1}`,
        kind: "playlist_track_added",
        strengthClass: "curated",
        entity: {
          entity_type: "track",
          entity_ref_id: track.track_ref_id,
          track_ref_id: track.track_ref_id,
          track_ref_revision: 1,
          label: title,
          artist_credit: artist,
          ...(album ? { release: album } : {}),
        },
        observedAt,
        sourceMember: "Playlist1.json",
        attributes: {
          playlist_ref_id: playlistRef,
          playlist_name: name,
          playlist_position: itemIndex + 1,
          ...(modifiedAt ? { playlist_modified_at: modifiedAt } : {}),
        },
      });
    }
  }
}

function searchEvidence(document, context) {
  const rows = requiredArray(document, "Spotify search queries", 100_000);
  for (const [rowIndex, row] of rows.entries()) {
    if (!isPlainObject(row)) fail("Spotify search query is invalid.");
    const query = cleanText(row.searchQuery, 512, "Spotify search query");
    const searchedAt = timestamp(
      row.searchTime,
      "Spotify search timestamp",
      context.capturedAt,
    );
    const interactions = requiredArray(
      row.searchInteractionURIs,
      "Spotify search interactions",
      1_000,
    );
    for (const [interactionIndex, value] of interactions.entries()) {
      const parsedUri = optionalUri(value);
      if (
        !parsedUri ||
        !new Set(["track", "artist", "album", "playlist"]).has(parsedUri.type)
      ) {
        continue;
      }
      const resultRefId = entityRefId(parsedUri.type, parsedUri.id);
      context.addEvidence({
        logicalKey: `search\0${searchedAt}\0${rowIndex + 1}\0${interactionIndex + 1}\0${resultRefId}`,
        kind: "search_result_interacted",
        direction: "context",
        strengthClass: "behavioral",
        entity: {
          entity_type: "search_query",
          entity_ref_id: labelEntityRefId("search_query", query),
          label: query,
        },
        observedAt: searchedAt,
        sourceMember: "SearchQueries.json",
        attributes: {
          result_entity_type: parsedUri.type,
          result_ref_id: resultRefId,
        },
      });
    }
  }
}

function tasteProfileEvidence(document, context) {
  if (!isPlainObject(document) || !isPlainObject(document.tasteProfile)) {
    fail("TasteProfile.json is invalid.");
  }
  const profile = document.tasteProfile;
  const artistUris = requiredArray(
    profile.artistUris,
    "Spotify taste-profile artists",
    1_000,
  );
  for (const [index, value] of artistUris.entries()) {
    const parsedUri = uri(value, "artist", "Spotify taste-profile artist URI");
    const label = context.artistLabels.get(parsedUri.id) ?? null;
    context.addEvidence({
      logicalKey: `taste-artist\0${parsedUri.id}\0${index + 1}`,
      kind: "taste_artist_ranked",
      strengthClass: "provider_derived",
      entity: {
        entity_type: "artist",
        entity_ref_id: entityRefId("artist", parsedUri.id),
        ...(label ? { label } : {}),
      },
      sourceMember: "TasteProfile.json",
      attributes: { rank: index + 1 },
    });
  }
  for (const [kind, value] of [
    ["musical_identity", profile.musicalIdentity],
    ["content_rhythms", profile.contentRhythms],
  ]) {
    const text = cleanText(
      value,
      2_000,
      `Spotify ${kind.replaceAll("_", " ")}`,
      { optional: true },
    );
    if (!text) continue;
    context.addEvidence({
      logicalKey: `taste-narrative\0${kind}`,
      kind: "provider_interpretation",
      direction: "context",
      strengthClass: "provider_derived",
      entity: {
        entity_type: "provider_interpretation",
        entity_ref_id: labelEntityRefId("provider_interpretation", kind),
        label: kind,
      },
      sourceMember: "TasteProfile.json",
      attributes: { text },
    });
  }
}

function rankedUriEvidence({
  values,
  expectedType,
  kind,
  sourceMember,
  context,
  labelMap,
  metrics = () => ({}),
}) {
  for (const [index, value] of requiredArray(values, kind, 10_000).entries()) {
    const rawUri = isPlainObject(value)
      ? value.trackUri ?? value.artistUri ?? value.uri
      : value;
    const parsedUri = uri(rawUri, expectedType, `Spotify ${kind} URI`);
    const entity = {
      entity_type: expectedType,
      entity_ref_id: entityRefId(expectedType, parsedUri.id),
    };
    const label = labelMap?.get(parsedUri.id);
    if (typeof label === "string") entity.label = label;
    else if (isPlainObject(label)) {
      entity.label = label.title ?? label.label;
      if (label.artist) entity.artist_credit = label.artist;
      if (label.album) entity.release = label.album;
    }
    if (expectedType === "track") {
      entity.track_ref_id = entity.entity_ref_id;
      entity.track_ref_revision = 1;
    }
    context.addEvidence({
      logicalKey: `${kind}\0${parsedUri.id}\0${index + 1}`,
      kind,
      strengthClass: "provider_derived",
      entity,
      sourceMember,
      attributes: { rank: index + 1, ...metrics(value, index) },
    });
  }
}

function wrappedEvidence(document, context) {
  if (!isPlainObject(document)) fail("Wrapped2025.json is invalid.");
  rankedUriEvidence({
    values: document.topTracks?.topTracks ?? [],
    expectedType: "track",
    kind: "wrapped_track_ranked",
    sourceMember: "Wrapped2025.json",
    context,
    labelMap: context.trackLabels,
    metrics: (value) => ({
      stream_count: integer(value.count, "Spotify Wrapped track count"),
      played_ms: integer(value.msPlayed, "Spotify Wrapped track duration"),
      period: "2025",
    }),
  });
  rankedUriEvidence({
    values: document.topArtists?.topArtistUris ?? [],
    expectedType: "artist",
    kind: "wrapped_artist_ranked",
    sourceMember: "Wrapped2025.json",
    context,
    labelMap: context.artistLabels,
    metrics: () => ({ period: "2025" }),
  });
  rankedUriEvidence({
    values: document.topAlbums?.topAlbums ?? [],
    expectedType: "album",
    kind: "wrapped_album_ranked",
    sourceMember: "Wrapped2025.json",
    context,
    labelMap: context.albumLabels,
    metrics: () => ({ period: "2025" }),
  });
  const genres = requiredArray(
    document.topGenres?.topGenres ?? [],
    "Spotify Wrapped genres",
    1_000,
  );
  for (const [index, value] of genres.entries()) {
    const raw = cleanText(value, 256, "Spotify Wrapped genre");
    const concept = spotifyConceptUriPattern.exec(raw);
    const label = concept ? null : raw;
    const ref = concept
      ? entityRefId("genre_concept", concept[1])
      : labelEntityRefId("genre", label);
    context.addEvidence({
      logicalKey: `wrapped-genre\0${ref}\0${index + 1}`,
      kind: "wrapped_genre_ranked",
      strengthClass: "provider_derived",
      entity: {
        entity_type: concept ? "genre_concept" : "genre",
        entity_ref_id: ref,
        ...(label ? { label } : {}),
      },
      sourceMember: "Wrapped2025.json",
      attributes: { rank: index + 1, period: "2025" },
    });
  }

  const metricValues = [
    ["total_listening_ms", document.yearlyMetrics?.totalMsListened, "ms"],
    ["unique_tracks", document.topTracks?.numUniqueTracks, "count"],
    ["unique_artists", document.topArtists?.numUniqueArtists, "count"],
    ["unique_genres", document.topGenres?.totalNumGenres, "count"],
    ["night_listening_percent", document.party?.percentListenedNight, "percent"],
    ["average_tempo_bpm", document.party?.weightedMsAvgTempo, "bpm"],
    ["artists_discovered", document.party?.numArtistsDiscovered, "count"],
    ["listening_day_streak", document.party?.streakNumListeningDays, "days"],
  ];
  for (const [name, value, unit] of metricValues) {
    if (value === null || value === undefined) continue;
    const normalized = numeric(value, `Spotify Wrapped ${name}`, {
      maximum: Number.MAX_SAFE_INTEGER,
    });
    context.addEvidence({
      logicalKey: `wrapped-metric\0${name}`,
      kind: "wrapped_metric",
      direction: "context",
      strengthClass: "provider_derived",
      entity: {
        entity_type: "metric",
        entity_ref_id: labelEntityRefId("metric", `wrapped-2025-${name}`),
        label: name,
      },
      sourceMember: "Wrapped2025.json",
      attributes: { value: normalized, unit, period: "2025" },
    });
  }
}

function capsuleRankedEvidence(values, kind, entityType, period, context) {
  for (const [index, value] of requiredArray(values, kind, 1_000).entries()) {
    if (!isPlainObject(value)) fail(`Spotify ${kind} item is invalid.`);
    const label = cleanText(value.name, 512, `Spotify ${kind} label`);
    context.addEvidence({
      logicalKey: `${kind}\0${period}\0${normalizedText(label)}\0${index + 1}`,
      kind,
      strengthClass: "provider_derived",
      entity: {
        entity_type: entityType,
        entity_ref_id: labelEntityRefId(entityType, label),
        label,
      },
      sourceMember: "YourSoundCapsule.json",
      attributes: {
        rank: index + 1,
        period,
        stream_count: integer(value.streamCount, `Spotify ${kind} stream count`),
        played_seconds: integer(
          value.secondsPlayed,
          `Spotify ${kind} played seconds`,
        ),
      },
    });
  }
}

function soundCapsuleEvidence(document, context) {
  if (!isPlainObject(document)) fail("YourSoundCapsule.json is invalid.");
  const stats = requiredArray(document.stats, "Spotify Sound Capsule stats", 1_000);
  for (const [index, stat] of stats.entries()) {
    if (!isPlainObject(stat)) fail("Spotify Sound Capsule stat is invalid.");
    const period = cleanText(stat.date, 64, "Spotify Sound Capsule period");
    capsuleRankedEvidence(
      stat.topArtists ?? [],
      "sound_capsule_artist_ranked",
      "artist",
      period,
      context,
    );
    capsuleRankedEvidence(
      stat.topTracks ?? [],
      "sound_capsule_track_ranked",
      "track_label",
      period,
      context,
    );
    context.addEvidence({
      logicalKey: `sound-capsule-period\0${period}\0${index + 1}`,
      kind: "sound_capsule_period_metric",
      direction: "context",
      strengthClass: "provider_derived",
      entity: {
        entity_type: "metric",
        entity_ref_id: labelEntityRefId("metric", `sound-capsule-${period}`),
        label: "period_listening",
      },
      observedAt: timestamp(
        stat.date,
        "Spotify Sound Capsule stat date",
        context.capturedAt,
        { dateOnly: true },
      ),
      sourceMember: "YourSoundCapsule.json",
      attributes: {
        period,
        stream_count: integer(
          stat.streamCount,
          "Spotify Sound Capsule stream count",
        ),
        played_seconds: integer(
          stat.secondsPlayed,
          "Spotify Sound Capsule played seconds",
        ),
      },
    });
  }

  const highlights = requiredArray(
    document.highlights,
    "Spotify Sound Capsule highlights",
    10_000,
  );
  for (const [index, highlight] of highlights.entries()) {
    if (!isPlainObject(highlight)) fail("Spotify Sound Capsule highlight is invalid.");
    const kind = cleanText(
      highlight.highlightType,
      128,
      "Spotify Sound Capsule highlight type",
    );
    const observedAt = timestamp(
      highlight.date,
      "Spotify Sound Capsule highlight date",
      context.capturedAt,
      { dateOnly: true },
    );
    const payload =
      highlight.milestoneHighlight ??
      highlight.multiEntityMilestoneHighlight ??
      highlight.onRepeatHighlight ??
      highlight.proportionListeningHighlight ??
      highlight.streaksHighlight ??
      highlight.unlikeCombinationHighlight ??
      highlight.youStandOutHighlight;
    if (!isPlainObject(payload)) continue;
    const labels = [
      payload.entity,
      ...(Array.isArray(payload.entities) ? payload.entities : []),
      payload.firstEntity,
      payload.secondEntity,
    ]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => cleanText(value, 512, "Spotify Sound Capsule highlight label"));
    if (labels.length < 1) continue;
    const metricEntry = Object.entries(payload).find(
      ([key, value]) => key !== "country" && typeof value === "number",
    );
    context.addEvidence({
      logicalKey: `sound-capsule-highlight\0${observedAt}\0${kind}\0${index + 1}`,
      kind: "sound_capsule_highlight",
      direction: "context",
      strengthClass: "provider_derived",
      entity: {
        entity_type: "provider_highlight",
        entity_ref_id: labelEntityRefId(
          "provider_highlight",
          `${observedAt}\0${kind}\0${labels.join("\0")}`,
        ),
        label: labels[0],
      },
      observedAt,
      sourceMember: "YourSoundCapsule.json",
      attributes: {
        highlight_type: kind,
        ...(labels[1] ? { related_label: labels[1] } : {}),
        ...(metricEntry
          ? {
              metric_name: metricEntry[0],
              metric_value: numeric(
                metricEntry[1],
                "Spotify Sound Capsule highlight metric",
              ),
            }
          : {}),
      },
    });
  }
}

export function projectSpotifyAccountDataProfile({
  subjectId,
  archiveSha256,
  archiveSizeBytes,
  documents,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (!isUuid(subjectId)) fail("A trusted subject ID is required.");
  const normalizedSubjectId = subjectId.toLowerCase();
  const normalizedCapturedAt = new Date(capturedAt).toISOString();
  if (
    typeof archiveSha256 !== "string" ||
    !sha256Pattern.test(archiveSha256)
  ) {
    fail("Spotify account-profile archive SHA-256 is invalid.");
  }
  if (!Number.isSafeInteger(archiveSizeBytes) || archiveSizeBytes < 1) {
    fail("Spotify account-profile archive size is invalid.");
  }
  if (!isPlainObject(documents)) fail("Spotify account-profile documents are invalid.");
  const selectedMembers = Object.keys(documents).sort();
  if (
    selectedMembers.length < 1 ||
    selectedMembers.some((name) => !memberNames.has(name))
  ) {
    fail("Spotify account-profile document selection is invalid.");
  }
  const profileImportId = uuidV5(
    `${normalizedSubjectId}\0${archiveSha256}\0${SPOTIFY_ACCOUNT_PROFILE_FORMAT}`,
    SPOTIFY_ACCOUNT_PROFILE_IMPORT_NAMESPACE,
  );
  const builder = profileBuilder({
    subjectId: normalizedSubjectId,
    archiveSha256,
    capturedAt: normalizedCapturedAt,
    profileImportId,
  });
  const context = {
    ...builder,
    capturedAt: normalizedCapturedAt,
    trackLabels: new Map(),
    artistLabels: new Map(),
    albumLabels: new Map(),
  };

  if (documents["YourLibrary.json"] !== undefined) {
    libraryEvidence(documents["YourLibrary.json"], context);
  }
  if (documents["Playlist1.json"] !== undefined) {
    playlistEvidence(documents["Playlist1.json"], context);
  }
  if (documents["SearchQueries.json"] !== undefined) {
    searchEvidence(documents["SearchQueries.json"], context);
  }
  if (documents["TasteProfile.json"] !== undefined) {
    tasteProfileEvidence(documents["TasteProfile.json"], context);
  }
  if (documents["Wrapped2025.json"] !== undefined) {
    wrappedEvidence(documents["Wrapped2025.json"], context);
  }
  if (documents["YourSoundCapsule.json"] !== undefined) {
    soundCapsuleEvidence(documents["YourSoundCapsule.json"], context);
  }

  return {
    track_refs: [...builder.tracks.values()],
    profile_evidence: builder.records,
    profile_import: {
      profile_import_id: profileImportId,
      subject_id: normalizedSubjectId,
      source_key: SPOTIFY_ACCOUNT_PROFILE_SOURCE,
      source_format: SPOTIFY_ACCOUNT_PROFILE_FORMAT,
      archive_sha256: archiveSha256,
      archive_size_bytes: archiveSizeBytes,
      member_names: selectedMembers,
      input_records: builder.records.length,
      imported_at: normalizedCapturedAt,
    },
  };
}

export function mergeSpotifyAccountProfile(historyBundle, profileBundle) {
  if (!isPlainObject(historyBundle) || !isPlainObject(profileBundle)) {
    fail("Spotify account-profile merge input is invalid.");
  }
  const trackRefs = new Map();
  for (const record of [
    ...(historyBundle.track_refs ?? []),
    ...(profileBundle.track_refs ?? []),
  ]) {
    const key = `${record.track_ref_id}:${record.revision}`;
    if (!trackRefs.has(key)) trackRefs.set(key, record);
  }
  return {
    ...historyBundle,
    track_refs: [...trackRefs.values()],
    profile_evidence: profileBundle.profile_evidence,
    profile_import: profileBundle.profile_import,
  };
}
