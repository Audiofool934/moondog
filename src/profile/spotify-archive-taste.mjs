import { randomUUID } from "node:crypto";

import { readSpotifyHistoryArchive } from "../integrations/spotify/history-archive.mjs";
import { openEphemeralListeningHistoryStore } from "./listening-history-store.mjs";

export const SPOTIFY_ARCHIVE_SET_MAXIMUM = 2;

function uniqueByLabel(items, maximum) {
  const seen = new Set();
  const values = [];
  for (const item of items) {
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    const key = label.normalize("NFKC").toLocaleLowerCase("und");
    if (!label || seen.has(key)) continue;
    seen.add(key);
    values.push(item);
    if (values.length === maximum) break;
  }
  return values;
}

function normalizedLabel(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").toLocaleLowerCase("und").trim()
    : "";
}

function assertionAvoids(item, entityType, label, artistCredit = "") {
  const avoids = item?.listener_assertions?.avoids ?? [];
  const normalizedItemLabel = normalizedLabel(label);
  const normalizedArtist = normalizedLabel(artistCredit);
  return avoids.some((avoid) => {
    if (avoid.entity_type === "artist") {
      const avoidedArtist = normalizedLabel(avoid.label);
      return entityType === "artist"
        ? avoidedArtist === normalizedItemLabel
        : avoidedArtist === normalizedArtist;
    }
    return entityType === "track" &&
      normalizedLabel(avoid.label) === normalizedItemLabel &&
      normalizedLabel(avoid.artist_credit) === normalizedArtist;
  });
}

function uniqueArtistFacets(listening, maximum) {
  const candidates = [
    ...(listening.curated_preferences?.followed_artists ?? []),
    ...(listening.listening_behavior?.enduring_artists ?? []),
    ...(listening.provider_signals?.artists ?? []),
  ];
  const seen = new Set();
  const values = [];
  for (const item of candidates) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const key = name.normalize("NFKC").toLocaleLowerCase("und");
    if (
      !name ||
      seen.has(key) ||
      assertionAvoids(listening, "artist", name)
    ) {
      continue;
    }
    seen.add(key);
    values.push({ name, ...(item.evidence_id ? { evidence_id: item.evidence_id } : {}) });
    if (values.length === maximum) break;
  }
  return values;
}

function strongPreferences(listening, maximum) {
  const curated = listening.curated_preferences ?? {};
  return uniqueByLabel(
    [
      ...(listening.listener_assertions?.preferences ?? []).map((item) => ({
        ...item,
        signal: `You explicitly said you like this ${item.entity_type}`,
      })),
      ...(curated.saved_tracks ?? [])
        .filter(
          (item) =>
            !assertionAvoids(
              listening,
              "track",
              item.label,
              item.artist_credit,
            ),
        )
        .map((item) => ({
          ...item,
          signal: "Saved in Spotify library",
        })),
      ...(curated.followed_artists ?? [])
        .filter(
          (item) => !assertionAvoids(listening, "artist", item.name),
        )
        .map((item) => ({
          ...item,
          label: item.name,
          signal: "Followed artist",
        })),
      ...(curated.saved_albums ?? [])
        .filter(
          (item) =>
            !assertionAvoids(
              listening,
              "album",
              item.label,
              item.artist_credit,
            ),
        )
        .map((item) => ({
          ...item,
          signal: "Saved album",
        })),
      ...(curated.playlist_anchors ?? [])
        .filter(
          (item) =>
            !assertionAvoids(
              listening,
              "track",
              item.label,
              item.artist_credit,
            ),
        )
        .map((item) => ({
          ...item,
          signal: "Playlist anchor",
        })),
    ],
    maximum,
  );
}

function createListeningProfileProjection(
  listening,
  { maxItems = 10, persistent = false, archiveCount = 1 } = {},
) {
  if (!listening || typeof listening !== "object" || Array.isArray(listening)) {
    throw new TypeError("A bounded listening-history projection is required.");
  }
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) {
    throw new TypeError("Listening-history Tasteprint maxItems is invalid.");
  }
  if (typeof persistent !== "boolean") {
    throw new TypeError("Listening projection persistence is invalid.");
  }
  if (
    !Number.isInteger(archiveCount) ||
    archiveCount < 1 ||
    archiveCount > SPOTIFY_ARCHIVE_SET_MAXIMUM
  ) {
    throw new TypeError("Listening projection archive count is invalid.");
  }
  const coverage = listening.coverage ?? {};
  const providerGenres = listening.provider_signals?.genres ?? [];
  return {
    profile_version: persistent
      ? "profile-projection/listening-history/1"
      : "profile-projection/spotify-archive-preview-1",
    max_items_applied: maxItems,
    strong_preferences: strongPreferences(listening, maxItems),
    familiarity: (listening.listening_behavior?.repeat_tracks ?? [])
      .slice(0, maxItems)
      .map((item) => ({
        label: item.label,
        level:
          Number.isInteger(item.play_count) && item.play_count >= 20
            ? "high"
            : Number.isInteger(item.play_count) && item.play_count >= 5
              ? "medium"
              : "low",
        ...(Number.isInteger(item.play_count)
          ? { play_count: item.play_count }
          : {}),
        ...(item.evidence_id ? { evidence_id: item.evidence_id } : {}),
      })),
    artist_facets: uniqueArtistFacets(listening, maxItems),
    genre_facets: providerGenres.slice(0, maxItems).map((item) => ({
      name: item.name,
      ...(item.evidence_id ? { evidence_id: item.evidence_id } : {}),
    })),
    coverage: {
      tracks_observed: 0,
      loved_or_favorited: 0,
      effective_listening_events: coverage.effective_listening_events,
      profiled_listening_events: coverage.profiled_listening_events,
      events_with_played_duration: coverage.events_with_played_duration,
      listening_hours: coverage.listening_hours,
      listening_tracks: coverage.distinct_tracks,
      resolved_listening_tracks: coverage.resolved_tracks,
      cross_format_track_links: coverage.cross_format_track_links,
      cross_format_linked_events: coverage.cross_format_linked_events,
      cross_format_ambiguous_tracks: coverage.cross_format_ambiguous_tracks,
      cross_format_ambiguous_events: coverage.cross_format_ambiguous_events,
      spotify_profile_evidence: coverage.profile_evidence_records,
      spotify_saved_tracks: coverage.saved_tracks,
      spotify_saved_albums: coverage.saved_albums,
      spotify_followed_artists: coverage.followed_artists,
      spotify_playlist_memberships: coverage.playlist_memberships,
      verified_search_interactions: coverage.verified_search_interactions,
      listener_assertion_events: coverage.listener_assertion_events,
      active_listener_assertions: coverage.active_listener_assertions,
      listener_retractions: coverage.listener_retractions,
    },
    listening_behavior: listening.listening_behavior ?? {},
    curated_preferences: listening.curated_preferences ?? {},
    listener_assertions: listening.listener_assertions ?? {
      active: [],
      preferences: [],
      avoids: [],
      retractions: 0,
    },
    search_intent: listening.search_intent ?? [],
    provider_signals: listening.provider_signals ?? {},
    listening_source: listening.source ?? {},
    limitations: [
      persistent
        ? "This projection is derived from Moondog's private persistent provider-neutral listening-history store."
        : archiveCount === 1
          ? "This is a one-off projection from the selected Spotify ZIP and was not added to Moondog's persistent listening-history store."
          : `This is a one-off projection from ${archiveCount} selected Spotify ZIP archives reconciled in memory and was not added to Moondog's persistent listening-history store.`,
      ...(listening.limitations ?? []),
    ].slice(0, 8),
  };
}

export function createListeningHistoryProfileProjection(
  listening,
  { maxItems = 10 } = {},
) {
  return createListeningProfileProjection(listening, {
    maxItems,
    persistent: true,
  });
}

export function createSpotifyListeningProfileProjection(listening, options) {
  return createListeningProfileProjection(listening, options);
}

export function createSpotifyArchiveProfileProjection(listening, options) {
  return createSpotifyListeningProfileProjection(listening, options);
}

function validatedArchivePaths(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SPOTIFY_ARCHIVE_SET_MAXIMUM ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new TypeError(
      `Choose between 1 and ${SPOTIFY_ARCHIVE_SET_MAXIMUM} Spotify history ZIP archives.`,
    );
  }
  if (new Set(value.map((item) => item.trim())).size !== value.length) {
    throw new TypeError("Each selected Spotify history ZIP must be distinct.");
  }
  return value.map((item) => item.trim());
}

function archiveSetSource(receipts, listening, { persistent }) {
  if (receipts.length === 1) {
    const [receipt] = receipts;
    return {
      source_format: receipt.source_format,
      data_scope: receipt.data_scope,
      input_records: receipt.input_records,
      profile_input_records: receipt.profile_input_records ?? 0,
      persistent_import: persistent,
      ...(persistent
        ? {
            already_imported: receipt.already_imported,
            effective_event_delta: receipt.effective_event_delta,
            superseded_events: receipt.superseded_events,
          }
        : {}),
    };
  }

  const sources = receipts
    .map((receipt) => ({
      source_format: receipt.source_format,
      data_scope: receipt.data_scope,
      input_records: receipt.input_records,
      profile_input_records: receipt.profile_input_records ?? 0,
    }))
    .sort((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      if (leftKey === rightKey) return 0;
      return leftKey < rightKey ? -1 : 1;
    });
  return {
    source_format: "spotify_history_archive_set_v1",
    data_scope: "combined_spotify_history",
    archive_count: receipts.length,
    sources,
    input_records: sources.reduce((total, source) => total + source.input_records, 0),
    profile_input_records: sources.reduce(
      (total, source) => total + source.profile_input_records,
      0,
    ),
    effective_listening_events:
      listening.coverage?.effective_listening_events ?? 0,
    reconciled_overlap_events: receipts.reduce(
      (total, receipt) => total + receipt.superseded_events,
      0,
    ),
    persistent_import: persistent,
    ...(persistent
      ? {
          already_imported: receipts.every(
            (receipt) => receipt.already_imported === true,
          ),
          effective_event_delta: receipts.reduce(
            (total, receipt) => total + receipt.effective_event_delta,
            0,
          ),
          superseded_events: receipts.reduce(
            (total, receipt) => total + receipt.superseded_events,
            0,
          ),
        }
      : {}),
  };
}

async function ingestSpotifyArchiveSet({
  archivePaths,
  subjectId,
  store,
  capturedAt,
  historyArchiveImporter,
}) {
  const archiveHashes = new Set();
  const receipts = [];
  for (const archivePath of archivePaths) {
    const bundle = await historyArchiveImporter({
      archivePath,
      subjectId,
      capturedAt,
    });
    const archiveSha256 = bundle?.import_batch?.archive_sha256;
    if (
      typeof archiveSha256 === "string" &&
      archiveHashes.has(archiveSha256)
    ) {
      throw new TypeError("Each selected Spotify history ZIP must be distinct.");
    }
    if (typeof archiveSha256 === "string") archiveHashes.add(archiveSha256);
    receipts.push(store.ingestImport(bundle));
  }
  return receipts;
}

export async function projectTasteFromSpotifyArchives({
  archivePaths,
  capturedAt = new Date().toISOString(),
  maxItems = 10,
  historyArchiveImporter = readSpotifyHistoryArchive,
  openStore = openEphemeralListeningHistoryStore,
} = {}) {
  const selectedArchivePaths = validatedArchivePaths(archivePaths);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) {
    throw new TypeError("Spotify archive Tasteprint maxItems is invalid.");
  }
  if (typeof capturedAt !== "string" || Number.isNaN(Date.parse(capturedAt))) {
    throw new TypeError("Spotify archive Tasteprint capturedAt is invalid.");
  }

  const normalizedCapturedAt = new Date(capturedAt).toISOString();
  const subjectId = randomUUID();
  let store;
  try {
    store = await openStore();
    const receipts = await ingestSpotifyArchiveSet({
      archivePaths: selectedArchivePaths,
      subjectId,
      store,
      capturedAt: normalizedCapturedAt,
      historyArchiveImporter,
    });
    const listening = store.profileSummary({ subjectId, maxItems });
    return {
      profile: createSpotifyListeningProfileProjection(listening, {
        maxItems,
        archiveCount: selectedArchivePaths.length,
      }),
      source: archiveSetSource(receipts, listening, { persistent: false }),
    };
  } finally {
    store?.close?.();
  }
}

export async function projectTasteFromSpotifyArchive({
  archivePath,
  capturedAt = new Date().toISOString(),
  maxItems = 10,
  historyArchiveImporter = readSpotifyHistoryArchive,
  openStore = openEphemeralListeningHistoryStore,
} = {}) {
  if (typeof archivePath !== "string" || !archivePath.trim()) {
    throw new TypeError("A Spotify history ZIP path is required.");
  }
  return projectTasteFromSpotifyArchives({
    archivePaths: [archivePath],
    capturedAt,
    maxItems,
    historyArchiveImporter,
    openStore,
  });
}

export async function persistTasteFromSpotifyArchive({
  archivePath,
  subjectId,
  store,
  capturedAt = new Date().toISOString(),
  maxItems = 10,
  historyArchiveImporter = readSpotifyHistoryArchive,
} = {}) {
  if (typeof archivePath !== "string" || !archivePath.trim()) {
    throw new TypeError("A Spotify history ZIP path is required.");
  }
  const result = await persistTasteFromSpotifyArchives({
    archivePaths: [archivePath],
    subjectId,
    store,
    capturedAt,
    maxItems,
    historyArchiveImporter,
  });
  const { receipts, ...projection } = result;
  return {
    ...projection,
    receipt: receipts[0],
  };
}

async function persistTasteFromSpotifyArchives({
  archivePaths,
  subjectId,
  store,
  capturedAt = new Date().toISOString(),
  maxItems = 10,
  historyArchiveImporter = readSpotifyHistoryArchive,
} = {}) {
  const selectedArchivePaths = validatedArchivePaths(archivePaths);
  if (typeof subjectId !== "string" || !subjectId.trim()) {
    throw new TypeError("A trusted local music subject is required.");
  }
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) {
    throw new TypeError("Spotify archive Tasteprint maxItems is invalid.");
  }
  if (
    !store ||
    typeof store.ingestImport !== "function" ||
    typeof store.profileSummary !== "function"
  ) {
    throw new TypeError("A persistent listening-history store is required.");
  }
  if (typeof capturedAt !== "string" || Number.isNaN(Date.parse(capturedAt))) {
    throw new TypeError("Spotify archive Tasteprint capturedAt is invalid.");
  }
  const normalizedCapturedAt = new Date(capturedAt).toISOString();
  const receipts = await ingestSpotifyArchiveSet({
    archivePaths: selectedArchivePaths,
    subjectId,
    store,
    capturedAt: normalizedCapturedAt,
    historyArchiveImporter,
  });
  const listening = store.profileSummary({ subjectId, maxItems });
  return {
    profile: createSpotifyListeningProfileProjection(listening, {
      maxItems,
      persistent: true,
      archiveCount: selectedArchivePaths.length,
    }),
    source: archiveSetSource(receipts, listening, { persistent: true }),
    receipts,
  };
}
