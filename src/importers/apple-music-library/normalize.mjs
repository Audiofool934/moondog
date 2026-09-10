import { readFile } from "node:fs/promises";

import {
  assertRequiredPropertiesDeclared,
  contractSchemaIds,
  createContractValidator,
  formatValidationErrors,
} from "../../../scripts/contract-lib.mjs";
import {
  canonicalizeJson,
  findUnsafePersistedData,
  sha256Hex,
  validateTrackRefSemantics,
} from "../../../scripts/contract-semantics.mjs";
import { AppleMusicImportError } from "./parse-plist.mjs";
import {
  APPLE_LIBRARY_BATCH_NAMESPACE,
  APPLE_LIBRARY_SNAPSHOT_NAMESPACE,
  APPLE_LIBRARY_TRACK_NAMESPACE,
  APPLE_MUSIC_LIBRARY_IMPORTER_NAME,
  APPLE_MUSIC_LIBRARY_IMPORTER_VERSION,
  isUuid,
  uuidV5,
} from "./stable-ids.mjs";

const snapshotSchema = JSON.parse(
  await readFile(new URL("./track-snapshot.schema.json", import.meta.url), "utf8"),
);
assertRequiredPropertiesDeclared(snapshotSchema, "track-snapshot.schema.json#");

let validatorPromise;

async function validators() {
  validatorPromise ??= createContractValidator().then(({ ajv }) => {
    ajv.addSchema(snapshotSchema);
    return {
      trackRef: ajv.getSchema(contractSchemaIds.get("track-ref")),
      snapshot: ajv.getSchema(snapshotSchema.$id),
    };
  });
  return validatorPromise;
}

function fail(code, message) {
  throw new AppleMusicImportError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sourceKeyOrder([left], [right]) {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function cleanText(value, field, warnings, sourceRecordKeySha256, maxLength = 512) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    warnings.push({
      code: "field_type_invalid",
      scope: "track",
      field,
      source_record_key_sha256: sourceRecordKeySha256,
    });
    return undefined;
  }
  const cleaned = value.trim();
  if (cleaned === "") return undefined;
  if (Array.from(cleaned).length > maxLength) {
    warnings.push({
      code: "field_length_invalid",
      scope: "track",
      field,
      source_record_key_sha256: sourceRecordKeySha256,
    });
    return undefined;
  }
  return cleaned;
}

function displayLabel(title, artist, fallback, warnings, sourceRecordKeySha256) {
  const label = title && artist ? `${title} - ${artist}` : title ?? artist ?? fallback;
  const codePoints = Array.from(label);
  if (codePoints.length <= 512) return label;
  warnings.push({
    code: "display_label_truncated",
    scope: "track",
    field: "display_label",
    source_record_key_sha256: sourceRecordKeySha256,
  });
  return codePoints.slice(0, 512).join("");
}

function nonnegativeInteger(value, field, warnings, sourceRecordKeySha256) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    warnings.push({
      code: "field_value_invalid",
      scope: "track",
      field,
      source_record_key_sha256: sourceRecordKeySha256,
    });
    return undefined;
  }
  return value;
}

function boundedInteger(
  value,
  field,
  warnings,
  sourceRecordKeySha256,
  minimum,
  maximum,
) {
  const parsed = nonnegativeInteger(
    value,
    field,
    warnings,
    sourceRecordKeySha256,
  );
  if (parsed === undefined) return undefined;
  if (parsed < minimum || parsed > maximum) {
    warnings.push({
      code: "field_value_out_of_range",
      scope: "track",
      field,
      source_record_key_sha256: sourceRecordKeySha256,
    });
    return undefined;
  }
  return parsed;
}

function optionalBoolean(value, field, warnings, sourceRecordKeySha256) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    warnings.push({
      code: "field_type_invalid",
      scope: "track",
      field,
      source_record_key_sha256: sourceRecordKeySha256,
    });
    return undefined;
  }
  return value;
}

function optionalTimestamp(value, field, warnings, sourceRecordKeySha256) {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    warnings.push({
      code: "field_date_invalid",
      scope: "track",
      field,
      source_record_key_sha256: sourceRecordKeySha256,
    });
    return undefined;
  }
  return value.toISOString();
}

function releaseDate(track, warnings, sourceRecordKeySha256) {
  const released = optionalTimestamp(
    track["Release Date"],
    "release_date",
    warnings,
    sourceRecordKeySha256,
  );
  if (released) return released.slice(0, 10);

  if (track.Year === undefined) return undefined;
  if (
    !Number.isSafeInteger(track.Year) ||
    track.Year < 1000 ||
    track.Year > 9999
  ) {
    warnings.push({
      code: "field_value_invalid",
      scope: "track",
      field: "year",
      source_record_key_sha256: sourceRecordKeySha256,
    });
    return undefined;
  }
  return String(track.Year).padStart(4, "0");
}

function ratingState(
  value,
  computed,
  field,
  computedField,
  warnings,
  sourceRecordKeySha256,
) {
  const rating = boundedInteger(
    value,
    field,
    warnings,
    sourceRecordKeySha256,
    0,
    100,
  );
  if (rating === undefined) return undefined;
  const result = { value: rating };
  const computedValue = optionalBoolean(
    computed,
    computedField,
    warnings,
    sourceRecordKeySha256,
  );
  if (computedValue !== undefined) result.computed = computedValue;
  return result;
}

function setIfDefined(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function safeCoverage(parsed) {
  const coverage = {
    title: 0,
    artist: 0,
    album: 0,
    persistent_identity: 0,
    aggregate_play_count: 0,
    last_played_at: 0,
    aggregate_skip_count: 0,
    last_skipped_at: 0,
    rating: 0,
    loved_or_favorited: 0,
    date_added: 0,
    local_file_reference: 0,
  };

  for (const track of Object.values(parsed.root.Tracks)) {
    if (!isPlainObject(track)) continue;
    if (typeof track.Name === "string" && track.Name.trim()) coverage.title += 1;
    if (typeof track.Artist === "string" && track.Artist.trim()) {
      coverage.artist += 1;
    }
    if (typeof track.Album === "string" && track.Album.trim()) coverage.album += 1;
    if (
      typeof track["Persistent ID"] === "string" &&
      track["Persistent ID"].trim()
    ) {
      coverage.persistent_identity += 1;
    }
    if (Number.isSafeInteger(track["Play Count"]) && track["Play Count"] >= 0) {
      coverage.aggregate_play_count += 1;
    }
    if (track["Play Date UTC"] instanceof Date) coverage.last_played_at += 1;
    if (Number.isSafeInteger(track["Skip Count"]) && track["Skip Count"] >= 0) {
      coverage.aggregate_skip_count += 1;
    }
    if (track["Skip Date"] instanceof Date) coverage.last_skipped_at += 1;
    if (Number.isSafeInteger(track.Rating)) coverage.rating += 1;
    if (track.Loved === true || track.Favorited === true) {
      coverage.loved_or_favorited += 1;
    }
    if (track["Date Added"] instanceof Date) coverage.date_added += 1;
    if (typeof track.Location === "string" && track.Location) {
      coverage.local_file_reference += 1;
    }
  }

  return coverage;
}

export function summarizeAppleMusicLibrary(parsed) {
  return {
    ok: true,
    mode: "inspect",
    writes_performed: false,
    source_format: "apple_music_library_xml_plist",
    source_bytes: parsed.sourceBytes,
    captured_at: parsed.capturedAt,
    counts: {
      tracks: parsed.trackCount,
      playlists: parsed.playlistCount,
      playlist_item_references: parsed.playlistItemCount,
      provisional_track_candidates: parsed.trackCount,
      aggregate_track_snapshots: parsed.trackCount,
      core_listening_events: 0,
      core_taste_events: 0,
    },
    coverage: safeCoverage(parsed),
    semantics: {
      source_is_library_snapshot: true,
      source_is_complete_listening_history: false,
      track_refs_are_batch_candidates: true,
      cross_batch_identity_uses_hashed_external_refs: true,
      aggregate_counts_expanded_into_events: false,
      explicit_states_projected_into_taste_events: false,
    },
  };
}

function warningCounts(warnings) {
  const counts = {};
  for (const warning of warnings) {
    counts[warning.code] = (counts[warning.code] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function identityMetadata(trackRef) {
  return Object.fromEntries(
    Object.entries({
      title: trackRef.title,
      artist_credits: trackRef.artist_credits,
      release: trackRef.release,
      duration_ms: trackRef.duration_ms,
      isrc: trackRef.isrc,
      extensions: trackRef.extensions,
    }).filter(([, value]) => value !== undefined),
  );
}

function collectOutputStrings(value, strings = new Set()) {
  if (typeof value === "string") {
    strings.add(value);
  } else if (Array.isArray(value)) {
    for (const child of value) collectOutputStrings(child, strings);
  } else if (isPlainObject(value)) {
    for (const child of Object.values(value)) collectOutputStrings(child, strings);
  }
  return strings;
}

function assertRawSourceIdentifiersExcluded(parsed, records) {
  const excluded = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.length >= 8) excluded.add(value);
  };

  add(parsed.libraryPersistentId);
  add(parsed.root["Music Folder"]);
  for (const track of Object.values(parsed.root.Tracks)) {
    if (!isPlainObject(track)) continue;
    add(track["Persistent ID"]);
    add(track.Location);
  }
  for (const playlist of parsed.root.Playlists ?? []) {
    if (!isPlainObject(playlist)) continue;
    add(playlist["Playlist Persistent ID"]);
  }

  const outputStrings = collectOutputStrings(records);
  for (const value of excluded) {
    if (outputStrings.has(value)) {
      fail(
        "privacy_raw_source_value",
        "Normalized output contains a forbidden raw source identifier",
      );
    }
  }
}

function assertRecordSafe(record, type, validate) {
  if (!validate(record)) {
    fail(
      "normalized_schema_invalid",
      `${type} failed validation: ${formatValidationErrors(validate.errors)}`,
    );
  }
  const unsafeIssues = findUnsafePersistedData(record);
  if (unsafeIssues.length > 0) {
    fail("normalized_record_unsafe", `${type} failed persisted-data inspection`);
  }
}

function assertExactKeys(value, expectedKeys, code) {
  if (!isPlainObject(value)) {
    fail(code, "Import record structure is invalid");
  }
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (canonicalizeJson(actualKeys) !== canonicalizeJson(expected)) {
    fail(code, "Import record contains unexpected or missing fields");
  }
}

export async function validateAppleMusicImportRecords(records) {
  assertExactKeys(
    records,
    ["manifest", "trackRefs", "trackSnapshots", "warnings"],
    "import_records_invalid",
  );
  if (
    !Array.isArray(records.trackRefs) ||
    !Array.isArray(records.trackSnapshots) ||
    !Array.isArray(records.warnings)
  ) {
    fail("import_records_invalid", "Import record collections must be arrays");
  }

  const { trackRef: validateTrackRef, snapshot: validateSnapshot } =
    await validators();
  const { manifest } = records;
  assertExactKeys(
    manifest,
    [
      "schema_version",
      "importer",
      "subject_id",
      "import_batch_id",
      "source",
      "counts",
      "coverage",
      "warning_counts",
      "semantics",
    ],
    "manifest_invalid",
  );
  if (
    manifest.schema_version !== "apple-music-library-import-manifest/1" ||
    !isUuid(manifest.subject_id) ||
    manifest.subject_id !== manifest.subject_id.toLowerCase() ||
    !isUuid(manifest.import_batch_id)
  ) {
    fail("manifest_invalid", "Import manifest identity is invalid");
  }
  const expectedImportBatchId = uuidV5(
    `v1\n${APPLE_MUSIC_LIBRARY_IMPORTER_NAME}@${APPLE_MUSIC_LIBRARY_IMPORTER_VERSION}\n${manifest.subject_id}\n${manifest.source?.sha256}`,
    APPLE_LIBRARY_BATCH_NAMESPACE,
  );
  if (expectedImportBatchId !== manifest.import_batch_id) {
    fail("manifest_invalid", "Import manifest deterministic identity is invalid");
  }
  assertExactKeys(manifest.importer, ["name", "version"], "manifest_invalid");
  if (
    manifest.importer.name !== APPLE_MUSIC_LIBRARY_IMPORTER_NAME ||
    manifest.importer.version !== APPLE_MUSIC_LIBRARY_IMPORTER_VERSION
  ) {
    fail("manifest_invalid", "Import manifest version is invalid");
  }
  assertExactKeys(
    manifest.source,
    [
      "format",
      "sha256",
      "bytes",
      "captured_at",
      "library_fingerprint_sha256",
    ],
    "manifest_invalid",
  );
  if (
    manifest.source.format !== "apple_music_library_xml_plist" ||
    !/^[0-9a-f]{64}$/.test(manifest.source.sha256) ||
    !/^[0-9a-f]{64}$/.test(manifest.source.library_fingerprint_sha256) ||
    !Number.isSafeInteger(manifest.source.bytes) ||
    manifest.source.bytes < 1 ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/.test(
      manifest.source.captured_at,
    ) ||
    Number.isNaN(Date.parse(manifest.source.captured_at))
  ) {
    fail("manifest_invalid", "Import manifest source summary is invalid");
  }

  const countKeys = [
    "source_tracks",
    "source_playlists",
    "source_playlist_item_references",
    "track_refs",
    "aggregate_track_snapshots",
    "core_listening_events",
    "core_taste_events",
    "warnings",
  ];
  assertExactKeys(manifest.counts, countKeys, "manifest_invalid");
  if (
    countKeys.some(
      (key) =>
        !Number.isSafeInteger(manifest.counts[key]) ||
        manifest.counts[key] < 0,
    ) ||
    manifest.counts.track_refs !== records.trackRefs.length ||
    manifest.counts.aggregate_track_snapshots !==
      records.trackSnapshots.length ||
    manifest.counts.warnings !== records.warnings.length ||
    manifest.counts.core_listening_events !== 0 ||
    manifest.counts.core_taste_events !== 0 ||
    manifest.counts.track_refs > manifest.counts.source_tracks
  ) {
    fail("manifest_invalid", "Import manifest record counts are invalid");
  }

  const coverageKeys = [
    "title",
    "artist",
    "album",
    "persistent_identity",
    "aggregate_play_count",
    "last_played_at",
    "aggregate_skip_count",
    "last_skipped_at",
    "rating",
    "loved_or_favorited",
    "date_added",
    "local_file_reference",
  ];
  assertExactKeys(manifest.coverage, coverageKeys, "manifest_invalid");
  if (
    coverageKeys.some(
      (key) =>
        !Number.isSafeInteger(manifest.coverage[key]) ||
        manifest.coverage[key] < 0 ||
        manifest.coverage[key] > manifest.counts.source_tracks,
    )
  ) {
    fail("manifest_invalid", "Import manifest coverage is invalid");
  }

  const semanticKeys = [
    "source_is_library_snapshot",
    "source_is_complete_listening_history",
    "track_refs_are_batch_candidates",
    "cross_batch_identity_uses_hashed_external_refs",
    "aggregate_counts_expanded_into_events",
    "explicit_states_projected_into_taste_events",
  ];
  assertExactKeys(manifest.semantics, semanticKeys, "manifest_invalid");
  const expectedSemantics = {
    source_is_library_snapshot: true,
    source_is_complete_listening_history: false,
    track_refs_are_batch_candidates: true,
    cross_batch_identity_uses_hashed_external_refs: true,
    aggregate_counts_expanded_into_events: false,
    explicit_states_projected_into_taste_events: false,
  };
  if (
    canonicalizeJson(manifest.semantics) !==
    canonicalizeJson(expectedSemantics)
  ) {
    fail("manifest_invalid", "Import manifest semantics are invalid");
  }

  const trackIds = new Set();
  const trackRefsById = new Map();
  const externalIdentities = new Set();
  for (const trackRef of records.trackRefs) {
    assertRecordSafe(trackRef, "TrackRef", validateTrackRef);
    if (!validateTrackRefSemantics(trackRef).ok) {
      fail("normalized_semantics_invalid", "TrackRef failed semantic validation");
    }
    if (
      trackRef.identity_status !== "provisional" ||
      trackRef.revision !== 1 ||
      trackRef.created_at !== manifest.source.captured_at ||
      trackIds.has(trackRef.track_ref_id)
    ) {
      fail("import_records_invalid", "TrackRef batch invariants are invalid");
    }
    trackIds.add(trackRef.track_ref_id);
    trackRefsById.set(trackRef.track_ref_id, trackRef);

    const appleRefs = trackRef.external_refs.filter(
      (externalRef) =>
        externalRef.system === "apple-music-library" &&
        externalRef.entity_type === "library.track" &&
        /^[0-9a-f]{64}$/.test(externalRef.external_id),
    );
    if (appleRefs.length !== 1 || trackRef.external_refs.length !== 1) {
      fail("import_records_invalid", "TrackRef external identity is invalid");
    }
    if (
      trackRef.extensions &&
      Object.keys(trackRef.extensions).some(
        (key) =>
          !new Set([
            "apple_music.genre",
            "apple_music.composer",
            "apple_music.album_artist",
          ]).has(key),
      )
    ) {
      fail("import_records_invalid", "TrackRef extensions are invalid");
    }
    const externalIdentity = appleRefs[0].external_id;
    if (externalIdentities.has(externalIdentity)) {
      fail("import_records_invalid", "TrackRef external identity is duplicated");
    }
    externalIdentities.add(externalIdentity);
  }

  const snapshotTrackIds = new Set();
  for (const snapshot of records.trackSnapshots) {
    assertRecordSafe(snapshot, "TrackSnapshot", validateSnapshot);
    if (
      snapshot.import_batch_id !== manifest.import_batch_id ||
      snapshot.subject_id !== manifest.subject_id ||
      snapshot.captured_at !== manifest.source.captured_at ||
      !trackIds.has(snapshot.track_ref_id) ||
      snapshotTrackIds.has(snapshot.track_ref_id)
    ) {
      fail("import_records_invalid", "Track snapshot batch invariants are invalid");
    }
    const trackRef = trackRefsById.get(snapshot.track_ref_id);
    const expectedTrackRefId = uuidV5(
      `candidate-v1\n${manifest.import_batch_id}\n${snapshot.source_record_key_sha256}\n${trackRef.external_refs[0].external_id}`,
      APPLE_LIBRARY_TRACK_NAMESPACE,
    );
    const expectedSnapshotId = uuidV5(
      `v1\n${manifest.import_batch_id}\n${snapshot.source_record_key_sha256}`,
      APPLE_LIBRARY_SNAPSHOT_NAMESPACE,
    );
    if (
      expectedTrackRefId !== trackRef.track_ref_id ||
      expectedSnapshotId !== snapshot.track_snapshot_id
    ) {
      fail(
        "import_records_invalid",
        "Apple import record deterministic identity is invalid",
      );
    }
    snapshotTrackIds.add(snapshot.track_ref_id);
  }
  if (snapshotTrackIds.size !== trackIds.size) {
    fail("import_records_invalid", "Every TrackRef must have one track snapshot");
  }

  const warningCountsFromRecords = {};
  for (const warning of records.warnings) {
    if (!isPlainObject(warning)) {
      fail("warning_invalid", "Import warning must be an object");
    }
    const allowedKeys = new Set([
      "code",
      "scope",
      "field",
      "source_record_key_sha256",
    ]);
    if (
      Object.keys(warning).some((key) => !allowedKeys.has(key)) ||
      !/^[a-z][a-z0-9_]{0,127}$/.test(warning.code) ||
      !new Set(["library", "track"]).has(warning.scope) ||
      (warning.field !== undefined &&
        !/^[a-z][a-z0-9_]{0,127}$/.test(warning.field)) ||
      (warning.source_record_key_sha256 !== undefined &&
        !/^[0-9a-f]{64}$/.test(warning.source_record_key_sha256)) ||
      (warning.scope === "track" &&
        warning.source_record_key_sha256 === undefined) ||
      (warning.scope === "library" &&
        warning.source_record_key_sha256 !== undefined)
    ) {
      fail("warning_invalid", "Import warning is invalid");
    }
    warningCountsFromRecords[warning.code] =
      (warningCountsFromRecords[warning.code] ?? 0) + 1;
    if (findUnsafePersistedData(warning).length > 0) {
      fail("normalized_record_unsafe", "Import warning failed data inspection");
    }
  }
  if (
    !isPlainObject(manifest.warning_counts) ||
    Object.values(manifest.warning_counts).some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    )
  ) {
    fail("manifest_invalid", "Import manifest warning counts are invalid");
  }
  if (
    canonicalizeJson(manifest.warning_counts) !==
    canonicalizeJson(
      Object.fromEntries(
        Object.entries(warningCountsFromRecords).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    )
  ) {
    fail("manifest_invalid", "Import manifest warning counts are invalid");
  }
  if (findUnsafePersistedData(manifest).length > 0) {
    fail("manifest_unsafe", "Import manifest failed persisted-data inspection");
  }
}

export async function normalizeAppleMusicLibrary(parsed, { subjectId }) {
  if (!isUuid(subjectId)) {
    fail("subject_id_invalid", "Import requires a valid stable subject UUID");
  }
  const normalizedSubjectId = subjectId.toLowerCase();
  const { trackRef: validateTrackRef, snapshot: validateSnapshot } =
    await validators();

  const importBatchId = uuidV5(
    `v1\n${APPLE_MUSIC_LIBRARY_IMPORTER_NAME}@${APPLE_MUSIC_LIBRARY_IMPORTER_VERSION}\n${normalizedSubjectId}\n${parsed.sourceSha256}`,
    APPLE_LIBRARY_BATCH_NAMESPACE,
  );
  const libraryIdentityMaterial = parsed.libraryPersistentId
    ? `v1\n${normalizedSubjectId}\n${parsed.libraryPersistentId}`
    : `fallback-v1\n${normalizedSubjectId}\n${parsed.sourceSha256}`;
  const libraryFingerprintSha256 = sha256Hex({
    kind: "apple_music_library_identity",
    identity_material: libraryIdentityMaterial,
  });

  const warnings = [];
  if (!parsed.libraryPersistentId) {
    warnings.push({
      code: "library_persistent_id_missing",
      scope: "library",
    });
  }

  const trackRefs = [];
  const trackSnapshots = [];
  const seenPersistentIds = new Map();

  for (const [sourceKey, track] of Object.entries(parsed.root.Tracks).sort(
    sourceKeyOrder,
  )) {
    if (!isPlainObject(track)) {
      fail("plist_track_invalid", "Apple Music track entry must be a dictionary");
    }

    const sourceRecordKeySha256 = sha256Hex({
      kind: "apple_music_library_source_record",
      source_sha256: parsed.sourceSha256,
      source_key: sourceKey,
    });
    const persistentId = cleanText(
      track["Persistent ID"],
      "persistent_id",
      warnings,
      sourceRecordKeySha256,
      512,
    );
    if (!persistentId) {
      warnings.push({
        code: "identity_fallback_unstable",
        scope: "track",
        source_record_key_sha256: sourceRecordKeySha256,
      });
    }

    const externalIdentityMaterial =
      parsed.libraryPersistentId && persistentId
        ? `v1\n${normalizedSubjectId}\n${parsed.libraryPersistentId}\n${persistentId}`
        : `fallback-v1\n${normalizedSubjectId}\n${parsed.sourceSha256}\n${sourceKey}`;
    const externalIdentitySha256 = sha256Hex({
      kind: "apple_music_library_track_identity",
      identity_material: externalIdentityMaterial,
    });
    const trackCandidateMaterial =
      `candidate-v1\n${importBatchId}\n${sourceRecordKeySha256}\n` +
      externalIdentitySha256;
    const trackRefId = uuidV5(
      trackCandidateMaterial,
      APPLE_LIBRARY_TRACK_NAMESPACE,
    );

    const title = cleanText(
      track.Name,
      "title",
      warnings,
      sourceRecordKeySha256,
    );
    let artist = cleanText(
      track.Artist,
      "artist",
      warnings,
      sourceRecordKeySha256,
    );
    const albumArtist = cleanText(
      track["Album Artist"],
      "album_artist",
      warnings,
      sourceRecordKeySha256,
    );
    if (!artist && albumArtist) {
      artist = albumArtist;
      warnings.push({
        code: "artist_fell_back_to_album_artist",
        scope: "track",
        source_record_key_sha256: sourceRecordKeySha256,
      });
    }
    const album = cleanText(
      track.Album,
      "album",
      warnings,
      sourceRecordKeySha256,
    );
    const durationMs = nonnegativeInteger(
      track["Total Time"],
      "duration_ms",
      warnings,
      sourceRecordKeySha256,
    );
    const released = releaseDate(track, warnings, sourceRecordKeySha256);
    const rawIsrc = cleanText(
      track.ISRC,
      "isrc",
      warnings,
      sourceRecordKeySha256,
      64,
    );
    const isrc = rawIsrc?.toUpperCase();
    const validIsrc = isrc && /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc);
    if (isrc && !validIsrc) {
      warnings.push({
        code: "isrc_invalid",
        scope: "track",
        source_record_key_sha256: sourceRecordKeySha256,
      });
    }

    const trackRef = {
      schema_version: 1,
      track_ref_id: trackRefId,
      revision: 1,
      identity_status: "provisional",
      display_label: displayLabel(
        title,
        artist,
        `Apple Music library track ${externalIdentitySha256.slice(0, 12)}`,
        warnings,
        sourceRecordKeySha256,
      ),
      external_refs: [
        {
          system: "apple-music-library",
          entity_type: "library.track",
          external_id: externalIdentitySha256,
        },
      ],
      created_at: parsed.capturedAt,
    };
    setIfDefined(trackRef, "title", title);
    if (artist) {
      trackRef.artist_credits = [{ name: artist, role: "primary" }];
    }
    if (album) {
      trackRef.release = { title: album };
      setIfDefined(trackRef.release, "release_date", released);
    }
    setIfDefined(trackRef, "duration_ms", durationMs);
    if (validIsrc) trackRef.isrc = isrc;

    const extensions = {};
    setIfDefined(
      extensions,
      "apple_music.genre",
      cleanText(track.Genre, "genre", warnings, sourceRecordKeySha256),
    );
    setIfDefined(
      extensions,
      "apple_music.composer",
      cleanText(track.Composer, "composer", warnings, sourceRecordKeySha256),
    );
    setIfDefined(extensions, "apple_music.album_artist", albumArtist);
    if (Object.keys(extensions).length > 0) trackRef.extensions = extensions;

    assertRecordSafe(trackRef, "TrackRef", validateTrackRef);
    const semanticResult = validateTrackRefSemantics(trackRef);
    if (!semanticResult.ok) {
      fail("normalized_semantics_invalid", "TrackRef failed semantic validation");
    }

    const aggregateState = {};
    setIfDefined(
      aggregateState,
      "play_count",
      nonnegativeInteger(
        track["Play Count"],
        "play_count",
        warnings,
        sourceRecordKeySha256,
      ),
    );
    setIfDefined(
      aggregateState,
      "last_played_at",
      optionalTimestamp(
        track["Play Date UTC"],
        "last_played_at",
        warnings,
        sourceRecordKeySha256,
      ),
    );
    if (track["Play Date"] !== undefined && !track["Play Date UTC"]) {
      warnings.push({
        code: "legacy_play_date_not_projected",
        scope: "track",
        source_record_key_sha256: sourceRecordKeySha256,
      });
    }
    setIfDefined(
      aggregateState,
      "skip_count",
      nonnegativeInteger(
        track["Skip Count"],
        "skip_count",
        warnings,
        sourceRecordKeySha256,
      ),
    );
    setIfDefined(
      aggregateState,
      "last_skipped_at",
      optionalTimestamp(
        track["Skip Date"],
        "last_skipped_at",
        warnings,
        sourceRecordKeySha256,
      ),
    );
    setIfDefined(
      aggregateState,
      "rating",
      ratingState(
        track.Rating,
        track["Rating Computed"],
        "rating",
        "rating_computed",
        warnings,
        sourceRecordKeySha256,
      ),
    );
    setIfDefined(
      aggregateState,
      "album_rating",
      ratingState(
        track["Album Rating"],
        track["Album Rating Computed"],
        "album_rating",
        "album_rating_computed",
        warnings,
        sourceRecordKeySha256,
      ),
    );
    setIfDefined(
      aggregateState,
      "loved",
      optionalBoolean(
        track.Loved,
        "loved",
        warnings,
        sourceRecordKeySha256,
      ),
    );
    setIfDefined(
      aggregateState,
      "favorited",
      optionalBoolean(
        track.Favorited,
        "favorited",
        warnings,
        sourceRecordKeySha256,
      ),
    );

    const libraryState = {};
    setIfDefined(
      libraryState,
      "date_added",
      optionalTimestamp(
        track["Date Added"],
        "date_added",
        warnings,
        sourceRecordKeySha256,
      ),
    );
    setIfDefined(
      libraryState,
      "date_modified",
      optionalTimestamp(
        track["Date Modified"],
        "date_modified",
        warnings,
        sourceRecordKeySha256,
      ),
    );
    for (const [sourceField, outputField] of [
      ["Apple Music", "apple_music"],
      ["Purchased", "purchased"],
      ["Playlist Only", "playlist_only"],
      ["Compilation", "compilation"],
      ["Unplayed", "unplayed"],
      ["Disabled", "disabled"],
    ]) {
      setIfDefined(
        libraryState,
        outputField,
        optionalBoolean(
          track[sourceField],
          outputField,
          warnings,
          sourceRecordKeySha256,
        ),
      );
    }

    const trackSnapshot = {
      schema_version: "1",
      track_snapshot_id: uuidV5(
        `v1\n${importBatchId}\n${sourceRecordKeySha256}`,
        APPLE_LIBRARY_SNAPSHOT_NAMESPACE,
      ),
      import_batch_id: importBatchId,
      subject_id: normalizedSubjectId,
      track_ref_id: trackRefId,
      captured_at: parsed.capturedAt,
      source_record_key_sha256: sourceRecordKeySha256,
      snapshot_kind: "aggregate_library_state",
      aggregate_state: aggregateState,
      library_state: libraryState,
    };
    assertRecordSafe(trackSnapshot, "TrackSnapshot", validateSnapshot);

    if (persistentId) {
      const comparison = {
        identity_metadata: identityMetadata(trackRef),
        aggregate_state: aggregateState,
        library_state: libraryState,
      };
      const prior = seenPersistentIds.get(persistentId);
      if (prior) {
        if (canonicalizeJson(prior) !== canonicalizeJson(comparison)) {
          fail(
            "duplicate_persistent_id_conflict",
            "A persistent track identity has conflicting metadata or state",
          );
        }
        warnings.push({
          code: "duplicate_persistent_id_deduplicated",
          scope: "track",
          source_record_key_sha256: sourceRecordKeySha256,
        });
        continue;
      }
      seenPersistentIds.set(persistentId, comparison);
    }

    trackRefs.push(trackRef);
    trackSnapshots.push(trackSnapshot);
  }

  trackRefs.sort((left, right) =>
    left.track_ref_id < right.track_ref_id
      ? -1
      : left.track_ref_id > right.track_ref_id
        ? 1
        : 0,
  );
  trackSnapshots.sort((left, right) =>
    left.track_ref_id < right.track_ref_id
      ? -1
      : left.track_ref_id > right.track_ref_id
        ? 1
        : 0,
  );
  warnings.sort((left, right) =>
    canonicalizeJson(left) < canonicalizeJson(right)
      ? -1
      : canonicalizeJson(left) > canonicalizeJson(right)
        ? 1
        : 0,
  );

  const manifest = {
    schema_version: "apple-music-library-import-manifest/1",
    importer: {
      name: APPLE_MUSIC_LIBRARY_IMPORTER_NAME,
      version: APPLE_MUSIC_LIBRARY_IMPORTER_VERSION,
    },
    subject_id: normalizedSubjectId,
    import_batch_id: importBatchId,
    source: {
      format: "apple_music_library_xml_plist",
      sha256: parsed.sourceSha256,
      bytes: parsed.sourceBytes,
      captured_at: parsed.capturedAt,
      library_fingerprint_sha256: libraryFingerprintSha256,
    },
    counts: {
      source_tracks: parsed.trackCount,
      source_playlists: parsed.playlistCount,
      source_playlist_item_references: parsed.playlistItemCount,
      track_refs: trackRefs.length,
      aggregate_track_snapshots: trackSnapshots.length,
      core_listening_events: 0,
      core_taste_events: 0,
      warnings: warnings.length,
    },
    coverage: safeCoverage(parsed),
    warning_counts: warningCounts(warnings),
    semantics: {
      source_is_library_snapshot: true,
      source_is_complete_listening_history: false,
      track_refs_are_batch_candidates: true,
      cross_batch_identity_uses_hashed_external_refs: true,
      aggregate_counts_expanded_into_events: false,
      explicit_states_projected_into_taste_events: false,
    },
  };

  const records = { manifest, trackRefs, trackSnapshots, warnings };
  await validateAppleMusicImportRecords(records);
  assertRawSourceIdentifiersExcluded(parsed, records);
  for (const value of [manifest, ...warnings]) {
    if (findUnsafePersistedData(value).length > 0) {
      fail("normalized_record_unsafe", "Import metadata failed persisted-data inspection");
    }
  }

  return records;
}
