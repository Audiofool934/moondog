import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveMoondogStateDirectory } from "../core/state-directory.mjs";
import { isUuid } from "../core/uuid-v5.mjs";
import {
  createListenerCorrection,
  createListenerCorrectionRetraction,
} from "./listener-corrections.mjs";
import { projectListeningProfile } from "./listening-profile-projection.mjs";
import {
  listeningFamiliarity, markMoondogStartedPlays, mixSlot, suggestionEntry, suggestionIdentities, SUGGESTION_WINDOW,
} from "./moondog-suggestions.mjs";
import { ListenerProfileStore, listenerProfileSchema } from "./listener-profile-store.mjs";

export const LISTENING_HISTORY_SCHEMA_VERSION = 7;

// The tables a cached projection, build input, Avoid gate or status reads, apart from the
// suggestions ledger (listeningDataVersion). Rows are only added to the first ones: the one
// update to a stored play, which records the play that supersedes it, is made with its row in
// listening_event_supersessions. Imports update their batch rows, so those are read in full.
// A new table those caches read, or a new update or delete, belongs here.
const APPENDED_EVIDENCE_TABLES = Object.freeze([
  "track_refs", "listening_events", "listening_event_supersessions", "listening_event_mirrors",
  "spotify_profile_evidence", "taste_events",
]);
const UPDATED_EVIDENCE_TABLES = Object.freeze(["import_batches", "profile_import_batches"]);

export function resolveListeningHistoryPath(environment = process.env) {
  return path.join(resolveMoondogStateDirectory(environment), "listening-history.sqlite");
}

export const defaultListeningHistoryPath = resolveListeningHistoryPath();

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA trusted_schema = OFF;

  CREATE TABLE IF NOT EXISTS local_music_subject (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    subject_id TEXT NOT NULL UNIQUE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS track_refs (
    track_ref_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (track_ref_id, revision)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS listening_events (
    listening_event_id TEXT PRIMARY KEY NOT NULL,
    subject_id TEXT NOT NULL,
    track_ref_id TEXT NOT NULL,
    track_ref_revision INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    deduplication_key TEXT NOT NULL UNIQUE,
    record_json TEXT NOT NULL,
    FOREIGN KEY (track_ref_id, track_ref_revision)
      REFERENCES track_refs(track_ref_id, revision)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS listening_events_subject_time
    ON listening_events(subject_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS listening_events_subject_track
    ON listening_events(subject_id, track_ref_id, track_ref_revision);

  CREATE TABLE IF NOT EXISTS source_cursors (
    source_key TEXT PRIMARY KEY NOT NULL,
    cursor_after_ms INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  -- Spotify keeps only a listener's last 50 plays. When a sync finds the window full,
  -- plays between the last stored one and the oldest returned one may be gone for good.
  CREATE TABLE IF NOT EXISTS listening_coverage_gaps (
    subject_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    gap_start TEXT NOT NULL,
    gap_end TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    PRIMARY KEY (subject_id, gap_start, gap_end),
    CHECK (gap_start < gap_end)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS import_batches (
    import_batch_id TEXT PRIMARY KEY NOT NULL,
    subject_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_format TEXT NOT NULL,
    data_scope TEXT NOT NULL,
    archive_sha256 TEXT NOT NULL,
    archive_size_bytes INTEGER NOT NULL,
    member_names_json TEXT NOT NULL,
    input_records INTEGER NOT NULL,
    earliest_occurred_at TEXT,
    latest_occurred_at TEXT,
    imported_at TEXT NOT NULL,
    inserted_events INTEGER NOT NULL,
    duplicate_events INTEGER NOT NULL,
    inserted_track_refs INTEGER NOT NULL,
    UNIQUE (source_key, subject_id, archive_sha256)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS listening_event_supersessions (
    superseded_event_id TEXT PRIMARY KEY NOT NULL,
    superseding_event_id TEXT NOT NULL UNIQUE,
    import_batch_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (superseded_event_id)
      REFERENCES listening_events(listening_event_id),
    FOREIGN KEY (superseding_event_id)
      REFERENCES listening_events(listening_event_id),
    FOREIGN KEY (import_batch_id)
      REFERENCES import_batches(import_batch_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS listening_event_reconciliation_candidates (
    superseded_event_id TEXT PRIMARY KEY NOT NULL,
    superseding_event_id TEXT NOT NULL UNIQUE,
    import_batch_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (superseding_event_id)
      REFERENCES listening_events(listening_event_id),
    FOREIGN KEY (import_batch_id)
      REFERENCES import_batches(import_batch_id)
  ) STRICT;

  -- A Last.fm scrobble that repeats a play another service recorded stays stored,
  -- linked to that play, and is left out of every count.
  CREATE TABLE IF NOT EXISTS listening_event_mirrors (
    mirror_event_id TEXT PRIMARY KEY NOT NULL,
    original_event_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    FOREIGN KEY (mirror_event_id)
      REFERENCES listening_events(listening_event_id),
    FOREIGN KEY (original_event_id)
      REFERENCES listening_events(listening_event_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS profile_import_batches (
    profile_import_id TEXT PRIMARY KEY NOT NULL,
    subject_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_format TEXT NOT NULL,
    archive_sha256 TEXT NOT NULL,
    archive_size_bytes INTEGER NOT NULL,
    member_names_json TEXT NOT NULL,
    input_records INTEGER NOT NULL,
    imported_at TEXT NOT NULL,
    inserted_evidence INTEGER NOT NULL,
    UNIQUE (source_key, subject_id, archive_sha256)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS spotify_profile_evidence (
    profile_evidence_id TEXT PRIMARY KEY NOT NULL,
    evidence_key TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    evidence_kind TEXT NOT NULL,
    profile_import_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    UNIQUE (profile_import_id, evidence_key),
    FOREIGN KEY (profile_import_id)
      REFERENCES profile_import_batches(profile_import_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS spotify_profile_evidence_subject_kind
    ON spotify_profile_evidence(subject_id, evidence_kind, observed_at DESC);

  CREATE TABLE IF NOT EXISTS taste_events (
    taste_event_id TEXT PRIMARY KEY NOT NULL,
    subject_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('assert', 'retract')),
    target_key TEXT,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    supersedes_taste_event_id TEXT,
    retracts_taste_event_id TEXT,
    record_json TEXT NOT NULL,
    CHECK (
      (operation = 'assert' AND target_key IS NOT NULL AND retracts_taste_event_id IS NULL) OR
      (operation = 'retract' AND target_key IS NULL AND retracts_taste_event_id IS NOT NULL)
    ),
    FOREIGN KEY (subject_id) REFERENCES local_music_subject(subject_id),
    FOREIGN KEY (supersedes_taste_event_id) REFERENCES taste_events(taste_event_id),
    FOREIGN KEY (retracts_taste_event_id) REFERENCES taste_events(taste_event_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS taste_events_subject_time
    ON taste_events(subject_id, recorded_at DESC, taste_event_id DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS taste_events_one_supersession
    ON taste_events(supersedes_taste_event_id)
    WHERE supersedes_taste_event_id IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS taste_events_one_retraction
    ON taste_events(retracts_taste_event_id)
    WHERE retracts_taste_event_id IS NOT NULL;

  -- What Moondog itself queued or played, written from the host's accepted receipts. Plays
  -- that match one are left out of the listener's own attention when the profile is read
  -- (src/profile/moondog-suggestions.mjs). Provider track identities never leave the host.
  CREATE TABLE IF NOT EXISTS moondog_suggestions (
    suggestion_id TEXT PRIMARY KEY NOT NULL,
    service TEXT NOT NULL,
    action TEXT NOT NULL,
    provider_track_id TEXT,
    isrc TEXT,
    track_key TEXT,
    release_key TEXT,
    title TEXT NOT NULL,
    artist_credit TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    mix_slot TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS moondog_suggestions_time
    ON moondog_suggestions(requested_at);

  ${listenerProfileSchema}
`;

function listenerCorrectionError(code, message) {
  const error = new Error(message);
  error.name = "ListenerCorrectionError";
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanSourceKey(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u.test(value)
  ) {
    throw new TypeError("Listening history source key is invalid");
  }
  return value;
}

function normalizedBundle(value, maximumRecords = 50) {
  if (
    !isPlainObject(value) ||
    !Array.isArray(value.track_refs) ||
    !Array.isArray(value.listening_events) ||
    value.track_refs.length > maximumRecords ||
    value.listening_events.length > maximumRecords
  ) {
    throw new TypeError("Listening history ingestion bundle is invalid");
  }
  return {
    sourceKey: cleanSourceKey(value.source_key),
    cursorAfterMs:
      value.cursor_after_ms === null
        ? null
        : Number.isSafeInteger(value.cursor_after_ms) &&
            value.cursor_after_ms >= 0
          ? value.cursor_after_ms
          : (() => {
              throw new TypeError("Listening history cursor is invalid");
            })(),
    capturedAt: new Date(value.captured_at).toISOString(),
    trackRefs: value.track_refs,
    listeningEvents: value.listening_events,
    windowFull: value.window_full === true,
  };
}

function normalizedUtcTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function safeProfileAttributes(value) {
  if (!isPlainObject(value) || Object.keys(value).length > 24) {
    throw new TypeError("Spotify profile evidence attributes are invalid");
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(key)) {
      throw new TypeError("Spotify profile evidence attributes are invalid");
    }
    if (typeof entry === "string") {
      if (
        Array.from(entry).length > 2_000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(entry)
      ) {
        throw new TypeError("Spotify profile evidence attributes are invalid");
      }
      continue;
    }
    if (
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      continue;
    }
    throw new TypeError("Spotify profile evidence attributes are invalid");
  }
  return value;
}

function normalizedProfileInput(value, batch) {
  const profileImport = value.profile_import;
  const profileEvidence = value.profile_evidence;
  if (profileImport === undefined && profileEvidence === undefined) return null;
  if (
    !isPlainObject(profileImport) ||
    !Array.isArray(profileEvidence) ||
    profileEvidence.length > 100_000 ||
    !isUuid(profileImport.profile_import_id) ||
    !isUuid(profileImport.subject_id) ||
    cleanSourceKey(profileImport.source_key) !== profileImport.source_key ||
    typeof profileImport.source_format !== "string" ||
    !/^[a-z][a-z0-9_]+_v[1-9][0-9]*$/u.test(profileImport.source_format) ||
    profileImport.archive_sha256 !== batch.archiveSha256 ||
    !Number.isSafeInteger(profileImport.archive_size_bytes) ||
    profileImport.archive_size_bytes !== batch.archiveSizeBytes ||
    !Array.isArray(profileImport.member_names) ||
    profileImport.member_names.length < 1 ||
    profileImport.member_names.length > 100 ||
    new Set(profileImport.member_names).size !== profileImport.member_names.length ||
    !Number.isSafeInteger(profileImport.input_records) ||
    profileImport.input_records !== profileEvidence.length
  ) {
    throw new TypeError("Spotify profile import manifest is invalid");
  }
  const subjectId = profileImport.subject_id.toLowerCase();
  const profileImportId = profileImport.profile_import_id.toLowerCase();
  if (subjectId !== batch.subjectId) {
    throw new TypeError("Spotify profile import subject scope is invalid");
  }
  const importedAt = normalizedUtcTimestamp(
    profileImport.imported_at,
    "Spotify profile import timestamp",
  );
  for (const memberName of profileImport.member_names) {
    if (
      typeof memberName !== "string" ||
      memberName.length < 1 ||
      memberName.length > 255 ||
      /[\/\\\u0000-\u001f\u007f]/u.test(memberName)
    ) {
      throw new TypeError("Spotify profile import member name is invalid");
    }
  }
  const allowedDirections = new Set(["supports", "contradicts", "context"]);
  const allowedStrengths = new Set([
    "explicit",
    "curated",
    "behavioral",
    "provider_derived",
  ]);
  const evidenceIds = new Set();
  const evidenceKeys = new Set();
  const records = profileEvidence.map((record) => {
    if (
      !isPlainObject(record) ||
      record.schema_version !== 1 ||
      !isUuid(record.profile_evidence_id) ||
      typeof record.evidence_key !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.evidence_key) ||
      !isUuid(record.subject_id) ||
      record.subject_id.toLowerCase() !== subjectId ||
      typeof record.evidence_kind !== "string" ||
      !/^[a-z][a-z0-9_]*$/u.test(record.evidence_kind) ||
      !allowedDirections.has(record.direction) ||
      !allowedStrengths.has(record.strength_class) ||
      !isPlainObject(record.entity) ||
      typeof record.entity.entity_type !== "string" ||
      !/^[a-z][a-z0-9_]*$/u.test(record.entity.entity_type) ||
      !isUuid(record.entity.entity_ref_id) ||
      !isPlainObject(record.provenance) ||
      record.provenance.source_kind !== "import" ||
      !(record.provenance.source_system === "spotify_account_data" ||
        (record.provenance.source_system === "spotify_web_api" && profileImport.source_key === "spotify.web_api_library") ||
        (["youtube_music", "qq_music", "netease", "lastfm"].includes(record.provenance.source_system) &&
          profileImport.source_key === `${record.provenance.source_system}.music_import`)) ||
      !profileImport.member_names.includes(record.provenance.source_member) ||
      record.provenance.profile_import_id?.toLowerCase() !== profileImportId ||
      record.provenance.captured_at !== importedAt
    ) {
      throw new TypeError("Spotify profile evidence record is invalid");
    }
    const evidenceId = record.profile_evidence_id.toLowerCase();
    if (evidenceIds.has(evidenceId) || evidenceKeys.has(record.evidence_key)) {
      throw new TypeError("Spotify profile evidence contains duplicate records");
    }
    evidenceIds.add(evidenceId);
    evidenceKeys.add(record.evidence_key);
    for (const field of ["label", "artist_credit", "release"]) {
      if (
        record.entity[field] !== undefined &&
        (typeof record.entity[field] !== "string" ||
          !record.entity[field].trim() ||
          Array.from(record.entity[field]).length > 512)
      ) {
        throw new TypeError("Spotify profile evidence entity is invalid");
      }
    }
    if (
      (record.entity.track_ref_id !== undefined &&
        !isUuid(record.entity.track_ref_id)) ||
      (record.entity.track_ref_revision !== undefined &&
        record.entity.track_ref_revision !== 1) ||
      (record.entity.track_ref_id === undefined) !==
        (record.entity.track_ref_revision === undefined)
    ) {
      throw new TypeError("Spotify profile evidence track reference is invalid");
    }
    const observedAt = normalizedUtcTimestamp(
      record.observed_at,
      "Spotify profile evidence timestamp",
    );
    if (Date.parse(observedAt) > Date.parse(importedAt)) {
      throw new TypeError("Spotify profile evidence timestamp is in the future");
    }
    safeProfileAttributes(record.attributes);
    return record;
  });
  return {
    profileImport: {
      profileImportId,
      subjectId,
      sourceKey: profileImport.source_key,
      sourceFormat: profileImport.source_format,
      archiveSha256: profileImport.archive_sha256,
      archiveSizeBytes: profileImport.archive_size_bytes,
      memberNames: [...profileImport.member_names],
      inputRecords: profileImport.input_records,
      importedAt,
    },
    profileEvidence: records,
  };
}

function normalizedImportBundle(value) {
  const bundle = normalizedBundle(value, 500_000);
  const batch = value.import_batch;
  if (
    !isPlainObject(batch) ||
    !isUuid(batch.import_batch_id) ||
    !isUuid(batch.subject_id) ||
    typeof batch.source_format !== "string" ||
    !/^[a-z][a-z0-9_]+_v[1-9][0-9]*$/u.test(batch.source_format) ||
    typeof batch.data_scope !== "string" ||
    !/^[a-z][a-z0-9_]+$/u.test(batch.data_scope) ||
    typeof batch.archive_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(batch.archive_sha256) ||
    !Number.isSafeInteger(batch.archive_size_bytes) ||
    batch.archive_size_bytes < 1 ||
    !Array.isArray(batch.member_names) ||
    batch.member_names.length < 1 ||
    batch.member_names.length > 100 ||
    new Set(batch.member_names).size !== batch.member_names.length ||
    !Number.isSafeInteger(batch.input_records) ||
    batch.input_records < 0 ||
    batch.input_records !== bundle.listeningEvents.length
  ) {
    throw new TypeError("Listening history import manifest is invalid");
  }
  for (const memberName of batch.member_names) {
    if (
      typeof memberName !== "string" ||
      memberName.length < 1 ||
      memberName.length > 255 ||
      /[\/\\\u0000-\u001f\u007f]/u.test(memberName)
    ) {
      throw new TypeError("Listening history import member name is invalid");
    }
  }
  const subjectId = batch.subject_id.toLowerCase();
  for (const event of bundle.listeningEvents) {
    if (
      event?.subject_id?.toLowerCase() !== subjectId ||
      event?.provenance?.import_batch_id?.toLowerCase() !==
        batch.import_batch_id.toLowerCase()
    ) {
      throw new TypeError("Listening history import records do not match their manifest");
    }
  }
  const reconciliationCandidates = value.reconciliation_candidates ?? [];
  if (
    !Array.isArray(reconciliationCandidates) ||
    reconciliationCandidates.length > bundle.listeningEvents.length
  ) {
    throw new TypeError("Listening history reconciliation candidates are invalid");
  }
  const eventIds = new Set(
    bundle.listeningEvents.map((event) => event?.listening_event_id?.toLowerCase()),
  );
  const supersedingIds = new Set();
  const supersededIds = new Set();
  for (const candidate of reconciliationCandidates) {
    const supersedingEventId = candidate?.superseding_event_id?.toLowerCase();
    const supersededEventId = candidate?.superseded_event_id?.toLowerCase();
    if (
      !isPlainObject(candidate) ||
      !isUuid(supersedingEventId) ||
      !isUuid(supersededEventId) ||
      supersedingEventId === supersededEventId ||
      !eventIds.has(supersedingEventId) ||
      supersedingIds.has(supersedingEventId) ||
      supersededIds.has(supersededEventId)
    ) {
      throw new TypeError("Listening history reconciliation candidates are invalid");
    }
    supersedingIds.add(supersedingEventId);
    supersededIds.add(supersededEventId);
  }
  const earliestOccurredAt = normalizedUtcTimestamp(
    batch.earliest_occurred_at,
    "Listening history import earliest timestamp",
    { nullable: true },
  );
  const latestOccurredAt = normalizedUtcTimestamp(
    batch.latest_occurred_at,
    "Listening history import latest timestamp",
    { nullable: true },
  );
  const importedAt = normalizedUtcTimestamp(
    batch.imported_at,
    "Listening history import timestamp",
  );
  if (importedAt !== bundle.capturedAt) {
    throw new TypeError("Listening history import timestamp does not match its manifest");
  }
  if (bundle.listeningEvents.length === 0) {
    if (earliestOccurredAt !== null || latestOccurredAt !== null) {
      throw new TypeError("Empty listening history imports cannot have an event range");
    }
  } else {
    const occurredAt = bundle.listeningEvents
      .map((event) => normalizedUtcTimestamp(
        event?.occurred_at,
        "Listening history event timestamp",
      ))
      .sort();
    if (
      earliestOccurredAt !== occurredAt[0] ||
      latestOccurredAt !== occurredAt.at(-1)
    ) {
      throw new TypeError("Listening history import event range is invalid");
    }
  }
  const normalized = {
    ...bundle,
    importBatch: {
      importBatchId: batch.import_batch_id.toLowerCase(),
      subjectId,
      sourceFormat: batch.source_format,
      dataScope: batch.data_scope,
      archiveSha256: batch.archive_sha256,
      archiveSizeBytes: batch.archive_size_bytes,
      memberNames: batch.member_names,
      inputRecords: batch.input_records,
      earliestOccurredAt,
      latestOccurredAt,
      importedAt,
    },
    reconciliationCandidates: reconciliationCandidates.map((candidate) => ({
      supersedingEventId: candidate.superseding_event_id.toLowerCase(),
      supersededEventId: candidate.superseded_event_id.toLowerCase(),
    })),
  };
  const profile = normalizedProfileInput(value, normalized.importBatch);
  return profile ? { ...normalized, ...profile } : normalized;
}

function ingestionStatements(database) {
  return {
    insertTrack: database.prepare(
      `INSERT OR IGNORE INTO track_refs (
        track_ref_id, revision, record_json
      ) VALUES (?, ?, ?)`,
    ),
    insertEvent: database.prepare(
      `INSERT OR IGNORE INTO listening_events (
        listening_event_id, subject_id, track_ref_id, track_ref_revision,
        occurred_at, deduplication_key, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    upsertCursor: database.prepare(
      `INSERT INTO source_cursors (
        source_key, cursor_after_ms, updated_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        cursor_after_ms = MAX(source_cursors.cursor_after_ms, excluded.cursor_after_ms),
        updated_at = excluded.updated_at`,
    ),
    hasEvent: database.prepare(
      "SELECT 1 FROM listening_events WHERE deduplication_key = ?",
    ),
    touchCursor: database.prepare(
      "UPDATE source_cursors SET updated_at = MAX(updated_at, ?) WHERE source_key = ?",
    ),
  };
}

// Records the span between the newest stored play and `before` as possibly missed.
function recordCoverageGap(database, { subjectId, sourceKey, before, detectedAt }) {
  const after = database.prepare(
    "SELECT MAX(occurred_at) AS occurred_at FROM listening_events WHERE subject_id = ? AND occurred_at < ?",
  ).get(subjectId, before)?.occurred_at;
  // A history that starts with this read has nothing to have missed.
  if (!after) return;
  database.prepare(
    `INSERT OR IGNORE INTO listening_coverage_gaps (subject_id, source_key, gap_start, gap_end, detected_at)
    VALUES (?, ?, ?, ?, ?)`,
  ).run(subjectId, sourceKey, after, before, detectedAt);
}

// Recent syncs from before gaps were recorded: a run that stored a full window of 50
// new plays at once may have missed plays before its oldest one.
function recordEarlierRecentSyncGaps(database) {
  const runs = database.prepare(
    `SELECT subject_id, json_extract(record_json, '$.ingested_at') AS ingested_at,
      MIN(occurred_at) AS earliest, COUNT(*) AS plays
    FROM listening_events
    WHERE json_extract(record_json, '$.provenance.external_ref.entity_type') = 'spotify.play_history'
    GROUP BY subject_id, ingested_at HAVING plays >= 50`,
  ).all();
  for (const run of runs) {
    recordCoverageGap(database, {
      subjectId: run.subject_id, sourceKey: "spotify.recently_played", before: run.earliest, detectedAt: run.ingested_at,
    });
  }
}

function insertBundleRecords(bundle, statements) {
  let insertedTracks = 0;
  let insertedEvents = 0;
  for (const record of bundle.trackRefs) {
    insertedTracks += statements.insertTrack.run(
      record.track_ref_id,
      record.revision,
      JSON.stringify(record),
    ).changes;
  }
  for (const record of bundle.listeningEvents) {
    insertedEvents += statements.insertEvent.run(
      record.listening_event_id,
      record.subject_id,
      record.track_ref_id,
      record.track_ref_revision,
      record.occurred_at,
      record.deduplication_key,
      JSON.stringify(record),
    ).changes;
  }
  if (bundle.cursorAfterMs !== null) {
    statements.upsertCursor.run(
      bundle.sourceKey,
      bundle.cursorAfterMs,
      bundle.capturedAt,
    );
  }
  return { insertedTracks, insertedEvents };
}

// Where stored plays came from, in words the agent can repeat. Others keep their kind.
const COVERAGE_SOURCE_LABELS = {
  "spotify.play_history": "Spotify recent plays, read while Moondog runs",
  "spotify.extended_history.play": "Spotify Extended Streaming History file",
  "spotify.account_data.play_history": "Spotify Account Data file",
  "listenbrainz.listen": "ListenBrainz export file",
};

const SCROBBLE_SOURCE_KEY = "lastfm.music_import";
// Scrobbles record when a song started. Spotify records when a play ended, so its start is
// the end minus the listening time; Account Data times are rounded to the minute.
const MIRROR_TOLERANCE_MS = 150_000;
const DAY_MS = 86_400_000;

// A local calendar date, such as 2026-10-25.
function localDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const foldLabel = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase("und")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const lexicalCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Many Last.fm scrobbles repeat plays that Spotify or ListenBrainz recorded too. Each scrobble
 * that matches another service's play (same artist and title, starting within a few minutes)
 * is linked to it once, whichever was imported first, so the play counts once.
 */
function reconcileScrobbleMirrors(database, subjectId, earliest, latest, createdAt) {
  if (!subjectId || !earliest || !latest) return 0;
  const scrobbled = database.prepare(
    "SELECT 1 FROM import_batches WHERE subject_id = ? AND source_key = ? LIMIT 1",
  ).get(subjectId, SCROBBLE_SOURCE_KEY);
  if (!scrobbled) return 0;
  const rows = database.prepare(
    `SELECT e.listening_event_id AS id, e.occurred_at AS at,
      e.record_json AS event_json, t.record_json AS track_json
    FROM listening_events e
    JOIN track_refs t
      ON t.track_ref_id = e.track_ref_id AND t.revision = e.track_ref_revision
    WHERE e.subject_id = ? AND e.occurred_at BETWEEN ? AND ?
      AND NOT EXISTS (
        SELECT 1 FROM listening_event_supersessions s
        WHERE s.superseded_event_id = e.listening_event_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM listening_event_mirrors m
        WHERE m.mirror_event_id = e.listening_event_id
          OR m.original_event_id = e.listening_event_id
      )`,
  ).all(
    subjectId,
    new Date(Date.parse(earliest) - DAY_MS).toISOString(),
    new Date(Date.parse(latest) + DAY_MS).toISOString(),
  );
  const scrobbles = new Map();
  const plays = [];
  for (const row of rows) {
    const event = JSON.parse(row.event_json);
    const track = JSON.parse(row.track_json);
    const artist = foldLabel(track.artist_credits?.[0]?.name);
    const title = foldLabel(track.title);
    if (!artist || !title) continue;
    const key = `${artist}\u0000${title}`;
    const at = Date.parse(row.at);
    const system = String(event.provenance?.external_ref?.system ?? "");
    if (system === "lastfm") {
      if (!scrobbles.has(key)) scrobbles.set(key, []);
      scrobbles.get(key).push({ id: row.id, start: at });
      continue;
    }
    const length = Number.isSafeInteger(event.played_ms) ? event.played_ms
      : Number.isSafeInteger(track.duration_ms) ? track.duration_ms : null;
    // A Spotify play of unknown length can't be placed precisely enough to match.
    if (system.startsWith("spotify") && length === null) continue;
    plays.push({ id: row.id, key, start: system.startsWith("spotify") ? at - length : at });
  }
  const pairs = [];
  for (const list of scrobbles.values()) list.sort((left, right) => left.start - right.start);
  for (const play of plays) {
    const list = scrobbles.get(play.key);
    if (!list) continue;
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (list[middle].start < play.start - MIRROR_TOLERANCE_MS) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < list.length && list[index].start <= play.start + MIRROR_TOLERANCE_MS; index += 1) {
      pairs.push({ gap: Math.abs(list[index].start - play.start), play: play.id, scrobble: list[index].id });
    }
  }
  // Closest pairs first, so each play and each scrobble is used once.
  pairs.sort((left, right) => left.gap - right.gap ||
    lexicalCompare(left.scrobble, right.scrobble) || lexicalCompare(left.play, right.play));
  const insert = database.prepare(
    `INSERT INTO listening_event_mirrors (mirror_event_id, original_event_id, created_at)
    VALUES (?, ?, ?)`,
  );
  const usedPlays = new Set();
  const usedScrobbles = new Set();
  let linked = 0;
  for (const pair of pairs) {
    if (usedPlays.has(pair.play) || usedScrobbles.has(pair.scrobble)) continue;
    usedPlays.add(pair.play);
    usedScrobbles.add(pair.scrobble);
    linked += insert.run(pair.scrobble, pair.play, createdAt).changes;
  }
  return linked;
}

function preserveExtendedHistoryMatches(bundle, retainedMatch) {
  const candidates = bundle.reconciliationCandidates;
  if (bundle.importBatch.sourceFormat !== "spotify_extended_streaming_history_music_v1") return candidates;
  const retained = new Map(candidates.map((candidate) => [
    candidate.supersedingEventId, retainedMatch(candidate.supersedingEventId),
  ]));
  if (!candidates.some((candidate) => retained.get(candidate.supersedingEventId) &&
    retained.get(candidate.supersedingEventId) !== candidate.supersededEventId)) return candidates;

  // Account Data cannot distinguish equal-duration plays of the same title and
  // artist within one minute. Added video plays can reorder those ordinals.
  // A narrower export may omit an established counterpart's ordinal entirely.
  // Keep those pairs too; only new plays use this archive's remaining candidates.
  // The store's conflict checks still reject a new play claiming an absent play's
  // retained counterpart, so an incomplete export cannot invent another match.
  const events = new Map(bundle.listeningEvents.map((event) => [event.listening_event_id, event]));
  const tracks = new Map(bundle.trackRefs.map((track) => [track.track_ref_id, track]));
  const groups = new Map();
  for (const candidate of candidates) {
    const event = events.get(candidate.supersedingEventId);
    const track = tracks.get(event.track_ref_id);
    const key = JSON.stringify([
      event.occurred_at.slice(0, 16), event.played_ms,
      track.title.normalize("NFKC").toLowerCase(),
      track.artist_credits[0].name.normalize("NFKC").toLowerCase(),
    ]);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const matches = new Map();
  for (const group of groups.values()) {
    const available = new Set(group.map((candidate) => candidate.supersededEventId));
    for (const candidate of group) {
      const previous = retained.get(candidate.supersedingEventId);
      if (!previous) continue;
      available.delete(previous);
      matches.set(candidate.supersedingEventId, previous);
    }
    const remaining = available.values();
    for (const candidate of group) {
      if (matches.has(candidate.supersedingEventId)) continue;
      const selected = available.has(candidate.supersededEventId)
        ? candidate.supersededEventId : remaining.next().value;
      matches.set(candidate.supersedingEventId, selected);
      available.delete(selected);
    }
  }
  return candidates.map((candidate) => ({
    ...candidate, supersededEventId: matches.get(candidate.supersedingEventId),
  }));
}

export class ListeningHistoryStore {
  #database;
  #closed = false;
  #snapshot = null;
  #projection = null;
  #coverageSources = null;
  #evidence = null;
  #ledgerChanges = 0;

  constructor(database) {
    this.#database = database;
  }

  sourceCursor(sourceKey) {
    if (this.#closed) throw new Error("Listening history store is closed");
    const row = this.#database
      .prepare(
        "SELECT cursor_after_ms FROM source_cursors WHERE source_key = ?",
      )
      .get(cleanSourceKey(sourceKey));
    return Number.isSafeInteger(row?.cursor_after_ms)
      ? row.cursor_after_ms
      : null;
  }

  localSubjectId({ preferredSubjectId, create = false } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (preferredSubjectId !== undefined && !isUuid(preferredSubjectId)) {
      throw new TypeError("A valid preferred local music subject is required");
    }
    if (typeof create !== "boolean") {
      throw new TypeError("Local music subject creation flag is invalid");
    }
    const preferred = preferredSubjectId?.toLowerCase() ?? null;
    const registered = this.#database
      .prepare(
        "SELECT subject_id FROM local_music_subject WHERE singleton = 1",
      )
      .get()?.subject_id;
    if (registered !== undefined) {
      if (!isUuid(registered)) {
        throw new Error("The local music subject registry is invalid");
      }
      const normalized = registered.toLowerCase();
      if (preferred && preferred !== normalized) {
        throw new Error(
          "The trusted Apple and local listening-history subjects do not match",
        );
      }
      return normalized;
    }

    const observed = this.#database
      .prepare(
        `SELECT subject_id FROM (
          SELECT subject_id FROM listening_events
          UNION
          SELECT subject_id FROM import_batches
          UNION
          SELECT subject_id FROM profile_import_batches
          UNION
          SELECT subject_id FROM spotify_profile_evidence
          UNION
          SELECT subject_id FROM taste_events
        )
        ORDER BY subject_id`,
      )
      .all()
      .map((row) => row.subject_id?.toLowerCase());
    if (observed.some((subjectId) => !isUuid(subjectId))) {
      throw new Error("Stored listening history contains an invalid subject");
    }
    if (observed.length > 1) {
      throw new Error(
        "Stored listening history contains multiple local music subjects",
      );
    }
    const inherited = observed[0] ?? null;
    if (preferred && inherited && preferred !== inherited) {
      throw new Error(
        "The trusted Apple and local listening-history subjects do not match",
      );
    }
    const resolved = inherited ?? preferred ?? (create ? randomUUID() : null);
    if (!resolved) return null;
    this.#database
      .prepare(
        "INSERT INTO local_music_subject (singleton, subject_id) VALUES (1, ?)",
      )
      .run(resolved);
    return resolved;
  }

  subjectDataStatus({ subjectId } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!isUuid(subjectId)) {
      throw new TypeError("A valid listening profile subject ID is required");
    }
    const normalized = subjectId.toLowerCase();
    const effectiveListeningEvents = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM listening_events e
        WHERE e.subject_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM listening_event_supersessions s
            WHERE s.superseded_event_id = e.listening_event_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM listening_event_mirrors m
            WHERE m.mirror_event_id = e.listening_event_id
          )`,
      )
      .get(normalized).count;
    const profileEvidence = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM spotify_profile_evidence
        WHERE subject_id = ?`,
      )
      .get(normalized).count;
    const activeTasteAssertions = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM taste_events a
        WHERE a.subject_id = ?
          AND a.operation = 'assert'
          AND NOT EXISTS (
            SELECT 1 FROM taste_events r
            WHERE r.retracts_taste_event_id = a.taste_event_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM taste_events s
            WHERE s.supersedes_taste_event_id = a.taste_event_id
          )`,
      )
      .get(normalized).count;
    return {
      state:
        effectiveListeningEvents > 0 ||
        profileEvidence > 0 ||
        activeTasteAssertions > 0
          ? "ready"
          : "empty",
      effective_listening_events: effectiveListeningEvents,
      profile_evidence: profileEvidence,
      active_taste_assertions: activeTasteAssertions,
    };
  }

  recordListenerCorrection({
    subjectId,
    entityType,
    label,
    artistCredit,
    stance,
    note,
    occurredAt = new Date().toISOString(),
    recordedAt = occurredAt,
    correctionId,
  } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!isUuid(subjectId)) {
      throw new TypeError("A valid listener correction subject is required");
    }
    const normalizedSubjectId = subjectId.toLowerCase();
    const initial = createListenerCorrection({
      subjectId: normalizedSubjectId,
      entityType,
      label,
      artistCredit,
      stance,
      note,
      occurredAt,
      recordedAt,
      correctionId,
    });
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.localSubjectId({ preferredSubjectId: normalizedSubjectId });
      const previous = this.#database
        .prepare(
          `SELECT a.taste_event_id, a.record_json
          FROM taste_events a
          WHERE a.subject_id = ?
            AND a.operation = 'assert'
            AND a.target_key = ?
            AND NOT EXISTS (
              SELECT 1 FROM taste_events r
              WHERE r.retracts_taste_event_id = a.taste_event_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM taste_events s
              WHERE s.supersedes_taste_event_id = a.taste_event_id
            )
          ORDER BY a.recorded_at DESC, a.taste_event_id DESC
          LIMIT 1`,
        )
        .get(normalizedSubjectId, initial.targetKey);
      const value = previous
        ? createListenerCorrection({
            subjectId: normalizedSubjectId,
            entityType,
            label,
            artistCredit,
            stance,
            note,
            occurredAt,
            recordedAt,
            correctionId: initial.record.taste_event_id,
            supersedesCorrectionId: previous.taste_event_id,
          })
        : initial;
      if (previous) {
        const previousRecord = JSON.parse(previous.record_json);
        if (
          value.record.occurred_at < previousRecord.occurred_at ||
          value.record.recorded_at < previousRecord.recorded_at
        ) {
          throw listenerCorrectionError(
            "listener_correction_time_invalid",
            "A listener correction cannot supersede a later assertion.",
          );
        }
      }
      this.#database
        .prepare(
          `INSERT INTO taste_events (
            taste_event_id, subject_id, operation, target_key, occurred_at,
            recorded_at, supersedes_taste_event_id,
            retracts_taste_event_id, record_json
          ) VALUES (?, ?, 'assert', ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          value.record.taste_event_id,
          normalizedSubjectId,
          value.targetKey,
          value.record.occurred_at,
          value.record.recorded_at,
          value.record.supersedes_taste_event_id ?? null,
          JSON.stringify(value.record),
        );
      this.#database.exec("COMMIT");
      return {
        state: "active",
        correction_id: value.record.taste_event_id,
        subject_id: normalizedSubjectId,
        entity_type: value.record.target.entity_type,
        label: value.record.target.label,
        ...(value.record.extensions?.["moondog.artist_credit"]
          ? {
              artist_credit:
                value.record.extensions["moondog.artist_credit"],
            }
          : {}),
        stance,
        occurred_at: value.record.occurred_at,
        ...(value.record.note ? { note: value.record.note } : {}),
        ...(previous
          ? { superseded_correction_id: previous.taste_event_id }
          : {}),
        profile_effects: "updated",
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  retractListenerCorrection({
    subjectId,
    correctionId,
    occurredAt = new Date().toISOString(),
    recordedAt = occurredAt,
    retractionId,
  } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!isUuid(subjectId) || !isUuid(correctionId)) {
      throw new TypeError("A valid listener correction and subject are required");
    }
    const normalizedSubjectId = subjectId.toLowerCase();
    const normalizedCorrectionId = correctionId.toLowerCase();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const assertion = this.#database
        .prepare(
          `SELECT a.record_json,
            EXISTS (
              SELECT 1 FROM taste_events r
              WHERE r.retracts_taste_event_id = a.taste_event_id
            ) AS retracted,
            EXISTS (
              SELECT 1 FROM taste_events s
              WHERE s.supersedes_taste_event_id = a.taste_event_id
            ) AS superseded
          FROM taste_events a
          WHERE a.subject_id = ?
            AND a.taste_event_id = ?
            AND a.operation = 'assert'`,
        )
        .get(normalizedSubjectId, normalizedCorrectionId);
      if (!assertion) {
        throw listenerCorrectionError(
          "listener_correction_not_found",
          "The listener correction was not found in the trusted subject scope.",
        );
      }
      if (assertion.retracted || assertion.superseded) {
        throw listenerCorrectionError(
          "listener_correction_inactive",
          "Only an active listener correction can be retracted.",
        );
      }
      const retraction = createListenerCorrectionRetraction({
        subjectId: normalizedSubjectId,
        retractsCorrectionId: normalizedCorrectionId,
        occurredAt,
        recordedAt,
        correctionId: retractionId,
      });
      const previous = JSON.parse(assertion.record_json);
      if (
        retraction.occurred_at < previous.occurred_at ||
        retraction.recorded_at < previous.recorded_at
      ) {
        throw listenerCorrectionError(
          "listener_correction_time_invalid",
          "A listener correction cannot be retracted before it was asserted.",
        );
      }
      this.#database
        .prepare(
          `INSERT INTO taste_events (
            taste_event_id, subject_id, operation, target_key, occurred_at,
            recorded_at, supersedes_taste_event_id,
            retracts_taste_event_id, record_json
          ) VALUES (?, ?, 'retract', NULL, ?, ?, NULL, ?, ?)`,
        )
        .run(
          retraction.taste_event_id,
          normalizedSubjectId,
          retraction.occurred_at,
          retraction.recorded_at,
          normalizedCorrectionId,
          JSON.stringify(retraction),
        );
      this.#database.exec("COMMIT");
      return {
        state: "retracted",
        correction_id: normalizedCorrectionId,
        retraction_id: retraction.taste_event_id,
        subject_id: normalizedSubjectId,
        entity_type: previous.target.entity_type,
        label: previous.target.label,
        profile_effects: "updated",
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listListenerCorrections({
    subjectId,
    includeInactive = false,
    limit = 50,
  } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!isUuid(subjectId)) {
      throw new TypeError("A valid listener correction subject is required");
    }
    if (typeof includeInactive !== "boolean") {
      throw new TypeError("Listener correction history flag is invalid");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Listener correction limit is invalid");
    }
    const rows = this.#database
      .prepare(
        `SELECT a.record_json,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM taste_events r
              WHERE r.retracts_taste_event_id = a.taste_event_id
            ) THEN 'retracted'
            WHEN EXISTS (
              SELECT 1 FROM taste_events s
              WHERE s.supersedes_taste_event_id = a.taste_event_id
            ) THEN 'superseded'
            ELSE 'active'
          END AS state,
          (
            SELECT r.taste_event_id FROM taste_events r
            WHERE r.retracts_taste_event_id = a.taste_event_id
          ) AS retracted_by,
          (
            SELECT s.taste_event_id FROM taste_events s
            WHERE s.supersedes_taste_event_id = a.taste_event_id
          ) AS superseded_by
        FROM taste_events a
        WHERE a.subject_id = ?
          AND a.operation = 'assert'
          AND (
            ? = 1 OR (
              NOT EXISTS (
                SELECT 1 FROM taste_events active_r
                WHERE active_r.retracts_taste_event_id = a.taste_event_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM taste_events active_s
                WHERE active_s.supersedes_taste_event_id = a.taste_event_id
              )
            )
          )
        ORDER BY a.recorded_at DESC, a.taste_event_id DESC
        LIMIT ?`,
      )
      .all(subjectId.toLowerCase(), includeInactive ? 1 : 0, limit);
    return rows
      .map((row) => {
        const record = JSON.parse(row.record_json);
        return {
          correction_id: record.taste_event_id,
          state: row.state,
          entity_type: record.target.entity_type,
          label: record.target.label,
          ...(record.extensions?.["moondog.artist_credit"]
            ? {
                artist_credit:
                  record.extensions["moondog.artist_credit"],
              }
            : {}),
          stance: record.signal_type === "avoidance" ? "avoid" : "like",
          strength: record.strength,
          occurred_at: record.occurred_at,
          ...(record.note ? { note: record.note } : {}),
          ...(record.supersedes_taste_event_id
            ? {
                supersedes_correction_id:
                  record.supersedes_taste_event_id,
              }
            : {}),
          ...(row.retracted_by
            ? { retracted_by: row.retracted_by }
            : {}),
          ...(row.superseded_by
            ? { superseded_by: row.superseded_by }
            : {}),
        };
      });
  }

  // How many choices are in force, beyond the ones a list shows.
  countActiveListenerCorrections({ subjectId } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!isUuid(subjectId)) {
      throw new TypeError("A valid listener correction subject is required");
    }
    return this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM taste_events a
        WHERE a.subject_id = ? AND a.operation = 'assert'
          AND NOT EXISTS (SELECT 1 FROM taste_events r WHERE r.retracts_taste_event_id = a.taste_event_id)
          AND NOT EXISTS (SELECT 1 FROM taste_events s WHERE s.supersedes_taste_event_id = a.taste_event_id)`,
      )
      .get(subjectId.toLowerCase()).count;
  }

  ingest(value) {
    if (this.#closed) throw new Error("Listening history store is closed");
    const bundle = normalizedBundle(value);
    const subjects = new Set(
      bundle.listeningEvents.map((record) => record.subject_id?.toLowerCase()),
    );
    if (subjects.size > 1) {
      throw new TypeError("Listening history ingestion spans multiple subjects");
    }
    const subjectId = [...subjects][0];
    const statements = ingestionStatements(this.#database);

    this.#database.exec("BEGIN IMMEDIATE");
    let insertedTracks;
    let insertedEvents;
    let mirroredEvents = 0;
    try {
      if (subjectId !== undefined) {
        this.localSubjectId({ preferredSubjectId: subjectId });
      }
      const times = bundle.listeningEvents.map((record) => record.occurred_at).sort();
      // A read that overlaps a stored play joins up with it.
      const overlaps = bundle.listeningEvents.some((record) => statements.hasEvent.get(record.deduplication_key));
      if (bundle.windowFull && subjectId !== undefined && !overlaps) {
        recordCoverageGap(this.#database, { subjectId, sourceKey: bundle.sourceKey, before: times[0], detectedAt: bundle.capturedAt });
      }
      ({ insertedTracks, insertedEvents } = insertBundleRecords(
        bundle,
        statements,
      ));
      // A read that finds nothing new still moves the source's checked time.
      statements.touchCursor.run(bundle.capturedAt, bundle.sourceKey);
      mirroredEvents = reconcileScrobbleMirrors(this.#database, subjectId, times[0], times.at(-1), bundle.capturedAt);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    return {
      state: "ready",
      source_key: bundle.sourceKey,
      fetched_events: bundle.listeningEvents.length,
      inserted_events: insertedEvents,
      duplicate_events: bundle.listeningEvents.length - insertedEvents,
      inserted_track_refs: insertedTracks,
      ...(mirroredEvents ? { mirrored_events: mirroredEvents } : {}),
      cursor_after_ms: this.sourceCursor(bundle.sourceKey),
      profile_effects: insertedEvents > 0 ? "updated" : "unchanged",
    };
  }

  ingestImport(value) {
    if (this.#closed) throw new Error("Listening history store is closed");
    const bundle = normalizedImportBundle(value);
    const batch = bundle.importBatch;
    const existingBatch = this.#database.prepare(
      `SELECT * FROM import_batches
      WHERE import_batch_id = ?`,
    );
    const insertBatch = this.#database.prepare(
      `INSERT INTO import_batches (
        import_batch_id, subject_id, source_key, source_format, data_scope,
        archive_sha256, archive_size_bytes, member_names_json, input_records,
        earliest_occurred_at, latest_occurred_at, imported_at,
        inserted_events, duplicate_events, inserted_track_refs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectBySuperseded = this.#database.prepare(
      `SELECT superseding_event_id FROM listening_event_supersessions
      WHERE superseded_event_id = ?`,
    );
    const selectBySuperseding = this.#database.prepare(
      `SELECT superseded_event_id FROM listening_event_supersessions
      WHERE superseding_event_id = ?`,
    );
    const insertSupersession = this.#database.prepare(
      `INSERT INTO listening_event_supersessions (
        superseded_event_id, superseding_event_id, import_batch_id, created_at
      ) VALUES (?, ?, ?, ?)`,
    );
    const selectCandidateBySuperseded = this.#database.prepare(
      `SELECT superseding_event_id FROM listening_event_reconciliation_candidates
      WHERE superseded_event_id = ?`,
    );
    const selectCandidateBySuperseding = this.#database.prepare(
      `SELECT superseded_event_id FROM listening_event_reconciliation_candidates
      WHERE superseding_event_id = ?`,
    );
    const insertCandidate = this.#database.prepare(
      `INSERT INTO listening_event_reconciliation_candidates (
        superseded_event_id, superseding_event_id, import_batch_id, created_at
      ) VALUES (?, ?, ?, ?)`,
    );
    const selectResolvableCandidates = this.#database.prepare(
      `SELECT
        candidate.superseded_event_id,
        candidate.superseding_event_id,
        candidate.import_batch_id
      FROM listening_event_reconciliation_candidates candidate
      JOIN listening_events superseded
        ON superseded.listening_event_id = candidate.superseded_event_id
      JOIN listening_events superseding
        ON superseding.listening_event_id = candidate.superseding_event_id
      LEFT JOIN listening_event_supersessions resolved
        ON resolved.superseded_event_id = candidate.superseded_event_id
      WHERE resolved.superseded_event_id IS NULL
      ORDER BY candidate.superseded_event_id, candidate.superseding_event_id`,
    );
    const selectEventRecord = this.#database.prepare(
      "SELECT record_json FROM listening_events WHERE listening_event_id = ?",
    );
    const updateEventRecord = this.#database.prepare(
      `UPDATE listening_events SET record_json = ?
      WHERE listening_event_id = ?`,
    );
    const existingProfileBatch = this.#database.prepare(
      `SELECT profile_import_id FROM profile_import_batches
      WHERE profile_import_id = ?`,
    );
    const insertProfileBatch = this.#database.prepare(
      `INSERT INTO profile_import_batches (
        profile_import_id, subject_id, source_key, source_format,
        archive_sha256, archive_size_bytes, member_names_json, input_records,
        imported_at, inserted_evidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    const insertProfileEvidence = this.#database.prepare(
      `INSERT OR IGNORE INTO spotify_profile_evidence (
        profile_evidence_id, evidence_key, subject_id, evidence_kind,
        profile_import_id, observed_at, captured_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateProfileBatch = this.#database.prepare(
      `UPDATE profile_import_batches SET inserted_evidence = ?
      WHERE profile_import_id = ?`,
    );
    const statements = ingestionStatements(this.#database);

    this.#database.exec("BEGIN IMMEDIATE");
    let insertedTracks = 0;
    let insertedEvents = 0;
    let supersededEvents = 0;
    let mirroredEvents = 0;
    let insertedProfileEvidence = 0;
    let alreadyImported = false;
    let profileAlreadyImported = bundle.profileImport === undefined;
    try {
      this.localSubjectId({ preferredSubjectId: batch.subjectId });
      const previousBatch = existingBatch.get(batch.importBatchId);
      alreadyImported = Boolean(previousBatch);
      if (!alreadyImported) {
        ({ insertedTracks, insertedEvents } = insertBundleRecords(
          bundle,
          statements,
        ));
        insertBatch.run(
          batch.importBatchId,
          batch.subjectId,
          bundle.sourceKey,
          batch.sourceFormat,
          batch.dataScope,
          batch.archiveSha256,
          batch.archiveSizeBytes,
          JSON.stringify(batch.memberNames),
          batch.inputRecords,
          batch.earliestOccurredAt,
          batch.latestOccurredAt,
          batch.importedAt,
          insertedEvents,
          batch.inputRecords - insertedEvents,
          insertedTracks,
        );
      } else {
        // Earlier readers skipped video members, even when they contained music.
        // Extend that same archive's receipt without replacing its existing rows.
        const previousMembers = JSON.parse(previousBatch.member_names_json);
        const addedMembers = batch.memberNames.filter((name) => !previousMembers.includes(name));
        const expandsExtendedArchive = batch.sourceFormat === "spotify_extended_streaming_history_music_v1" &&
          previousBatch.subject_id === batch.subjectId && previousBatch.source_key === bundle.sourceKey &&
          previousBatch.source_format === batch.sourceFormat && previousBatch.data_scope === batch.dataScope &&
          previousBatch.archive_sha256 === batch.archiveSha256 && previousBatch.archive_size_bytes === batch.archiveSizeBytes &&
          previousMembers.every((name) => batch.memberNames.includes(name)) && addedMembers.length > 0 &&
          addedMembers.every((name) => /^Streaming_History_Video_\d{4}(?:_\d+)?\.json$/u.test(name));
        if (expandsExtendedArchive) {
          const incomingIds = new Set(bundle.listeningEvents.map((event) => event.listening_event_id));
          const previousEvents = this.#database.prepare(`SELECT listening_event_id FROM listening_events
            WHERE subject_id = ? AND json_extract(record_json, '$.provenance.import_batch_id') = ?`)
            .all(batch.subjectId, batch.importBatchId);
          if (batch.inputRecords < previousBatch.input_records || previousEvents.some((event) => !incomingIds.has(event.listening_event_id))) {
            throw new Error("Extended archive expansion must preserve every previously imported event");
          }
          ({ insertedTracks, insertedEvents } = insertBundleRecords(bundle, statements));
          this.#database.prepare(`UPDATE import_batches SET member_names_json = ?, input_records = ?,
            earliest_occurred_at = ?, latest_occurred_at = ?,
            inserted_events = inserted_events + ?, duplicate_events = ? - inserted_events - ?,
            inserted_track_refs = inserted_track_refs + ? WHERE import_batch_id = ?`)
            .run(JSON.stringify(batch.memberNames), batch.inputRecords, batch.earliestOccurredAt, batch.latestOccurredAt,
              insertedEvents, batch.inputRecords, insertedEvents, insertedTracks, batch.importBatchId);
        }
      }
      const reconciliationCandidates = preserveExtendedHistoryMatches(bundle, (eventId) =>
        selectCandidateBySuperseding.get(eventId)?.superseded_event_id ??
        selectBySuperseding.get(eventId)?.superseded_event_id);
      for (const candidate of reconciliationCandidates) {
        const existingBySuperseded = selectCandidateBySuperseded.get(
          candidate.supersededEventId,
        )?.superseding_event_id;
        const existingBySuperseding = selectCandidateBySuperseding.get(
          candidate.supersedingEventId,
        )?.superseded_event_id;
        const resolvedSuperseding = selectBySuperseded.get(
          candidate.supersededEventId,
        )?.superseding_event_id;
        const resolvedSuperseded = selectBySuperseding.get(
          candidate.supersedingEventId,
        )?.superseded_event_id;
        if (
          (existingBySuperseded &&
            existingBySuperseded !== candidate.supersedingEventId) ||
          (existingBySuperseding &&
            existingBySuperseding !== candidate.supersededEventId) ||
          (resolvedSuperseding &&
            resolvedSuperseding !== candidate.supersedingEventId) ||
          (resolvedSuperseded &&
            resolvedSuperseded !== candidate.supersededEventId)
        ) {
          throw new Error("Listening history reconciliation conflict");
        }
        if (!existingBySuperseded && !existingBySuperseding) {
          insertCandidate.run(
            candidate.supersededEventId,
            candidate.supersedingEventId,
            batch.importBatchId,
            batch.importedAt,
          );
        }
      }
      for (const candidate of selectResolvableCandidates.all()) {
        const supersededEventId = candidate.superseded_event_id;
        const supersedingEventId = candidate.superseding_event_id;
        const existingSuperseding = selectBySuperseded.get(
          supersededEventId,
        )?.superseding_event_id;
        const existingSuperseded = selectBySuperseding.get(
          supersedingEventId,
        )?.superseded_event_id;
        if (
          (existingSuperseding && existingSuperseding !== supersedingEventId) ||
          (existingSuperseded && existingSuperseded !== supersededEventId)
        ) {
          throw new Error("Listening history reconciliation conflict");
        }
        const eventRow = selectEventRecord.get(supersedingEventId);
        const event = JSON.parse(eventRow.record_json);
        if (
          event.supersedes_listening_event_id !== undefined &&
          event.supersedes_listening_event_id.toLowerCase() !== supersededEventId
        ) {
          throw new Error("Listening history reconciliation conflict");
        }
        if (event.supersedes_listening_event_id === undefined) {
          updateEventRecord.run(
            JSON.stringify({
              ...event,
              supersedes_listening_event_id: supersededEventId,
            }),
            supersedingEventId,
          );
        }
        if (!existingSuperseding && !existingSuperseded) {
          supersededEvents += insertSupersession.run(
            supersededEventId,
            supersedingEventId,
            candidate.import_batch_id,
            batch.importedAt,
          ).changes;
        }
      }
      if (bundle.profileImport) {
        const profile = bundle.profileImport;
        profileAlreadyImported = Boolean(
          existingProfileBatch.get(profile.profileImportId),
        );
        if (!profileAlreadyImported) {
          if (alreadyImported) {
            for (const record of bundle.trackRefs) {
              insertedTracks += statements.insertTrack.run(
                record.track_ref_id,
                record.revision,
                JSON.stringify(record),
              ).changes;
            }
          }
          insertProfileBatch.run(
            profile.profileImportId,
            profile.subjectId,
            profile.sourceKey,
            profile.sourceFormat,
            profile.archiveSha256,
            profile.archiveSizeBytes,
            JSON.stringify(profile.memberNames),
            profile.inputRecords,
            profile.importedAt,
          );
          for (const record of bundle.profileEvidence) {
            insertedProfileEvidence += insertProfileEvidence.run(
              record.profile_evidence_id,
              record.evidence_key,
              record.subject_id,
              record.evidence_kind,
              profile.profileImportId,
              record.observed_at,
              record.provenance.captured_at,
              JSON.stringify(record),
            ).changes;
          }
          if (insertedProfileEvidence !== profile.inputRecords) {
            throw new Error("Spotify profile evidence import was incomplete");
          }
          updateProfileBatch.run(
            insertedProfileEvidence,
            profile.profileImportId,
          );
        }
      }
      mirroredEvents = reconcileScrobbleMirrors(
        this.#database, batch.subjectId, batch.earliestOccurredAt, batch.latestOccurredAt, batch.importedAt,
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    return {
      state: "ready",
      source_key: bundle.sourceKey,
      source_format: batch.sourceFormat,
      data_scope: batch.dataScope,
      import_batch_id: batch.importBatchId,
      archive_sha256: batch.archiveSha256,
      input_records: batch.inputRecords,
      inserted_events: insertedEvents,
      duplicate_events: batch.inputRecords - insertedEvents,
      inserted_track_refs: insertedTracks,
      superseded_events: supersededEvents,
      ...(mirroredEvents ? { mirrored_events: mirroredEvents } : {}),
      effective_event_delta: insertedEvents - supersededEvents - mirroredEvents,
      cursor_after_ms: this.sourceCursor(bundle.sourceKey),
      earliest_occurred_at: batch.earliestOccurredAt,
      latest_occurred_at: batch.latestOccurredAt,
      already_imported: alreadyImported,
      ...(bundle.profileImport
        ? {
            profile_input_records: bundle.profileImport.inputRecords,
            inserted_profile_evidence: insertedProfileEvidence,
            profile_already_imported: profileAlreadyImported,
            profile_evidence_by_kind: Object.fromEntries(
              Object.entries(
                Object.groupBy(
                  bundle.profileEvidence,
                  (record) => record.evidence_kind,
                ),
              )
                .map(([kind, records]) => [kind, records.length])
                .sort(([left], [right]) => left.localeCompare(right)),
            ),
          }
        : {}),
      profile_effects:
        insertedEvents > 0 || supersededEvents > 0 || insertedProfileEvidence > 0
          ? "updated"
          : "unchanged",
    };
  }

  recentEvents({ subjectId, limit = 20 } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (typeof subjectId !== "string" || !subjectId.trim()) {
      throw new TypeError("A listening history subject ID is required");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError("Listening history limit is invalid");
    }
    return this.#database
      .prepare(
      `SELECT record_json FROM listening_events
        WHERE subject_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM listening_event_supersessions
            WHERE superseded_event_id = listening_events.listening_event_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM listening_event_mirrors m
            WHERE m.mirror_event_id = listening_events.listening_event_id
          )
        ORDER BY occurred_at DESC, listening_event_id DESC
        LIMIT ?`,
      )
      .all(subjectId.toLowerCase(), limit)
      .map((row) => JSON.parse(row.record_json));
  }

  #profileProjection({ subjectId, maxItems }) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!isUuid(subjectId)) {
      throw new TypeError("A valid listening profile subject ID is required");
    }
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50) {
      throw new TypeError("Listening profile limit is invalid");
    }
    const normalizedSubjectId = subjectId.toLowerCase();
    const linkCandidates = this.#database
      .prepare(
        `SELECT
          superseded.track_ref_id AS source_track_ref_id,
          superseding.track_ref_id AS target_track_ref_id,
          superseding.track_ref_revision AS target_track_ref_revision,
          source_track.record_json AS source_track_json,
          target_track.record_json AS target_track_json
        FROM listening_event_supersessions link
        JOIN listening_events superseded
          ON superseded.listening_event_id = link.superseded_event_id
        JOIN listening_events superseding
          ON superseding.listening_event_id = link.superseding_event_id
        JOIN track_refs source_track
          ON source_track.track_ref_id = superseded.track_ref_id
          AND source_track.revision = superseded.track_ref_revision
        JOIN track_refs target_track
          ON target_track.track_ref_id = superseding.track_ref_id
          AND target_track.revision = superseding.track_ref_revision
        WHERE superseded.subject_id = ?
          AND superseding.subject_id = ?
        ORDER BY
          superseded.track_ref_id,
          superseding.track_ref_id,
          superseding.track_ref_revision`,
      )
      .all(normalizedSubjectId, normalizedSubjectId);
    const groupedLinks = new Map();
    for (const row of linkCandidates) {
      const sourceTrack = JSON.parse(row.source_track_json);
      const targetTrack = JSON.parse(row.target_track_json);
      const group = groupedLinks.get(row.source_track_ref_id) ?? {
        source_is_provisional: true,
        targets: new Map(),
      };
      group.source_is_provisional &&=
        sourceTrack.identity_status !== "resolved";
      const currentTarget = group.targets.get(row.target_track_ref_id);
      if (
        !currentTarget ||
        row.target_track_ref_revision > currentTarget.revision
      ) {
        group.targets.set(row.target_track_ref_id, {
          revision: row.target_track_ref_revision,
          resolved: targetTrack.identity_status === "resolved",
          track: targetTrack,
        });
      }
      groupedLinks.set(row.source_track_ref_id, group);
    }
    const exactTrackLinks = new Map();
    const ambiguousTrackSources = new Set();
    for (const [sourceTrackRefId, group] of groupedLinks) {
      if (!group.source_is_provisional) continue;
      if (group.targets.size > 1) {
        const resolvedTargets = [...group.targets.values()].filter(
          (target) => target.resolved,
        ).length;
        if (resolvedTargets > 1) {
          ambiguousTrackSources.add(sourceTrackRefId);
        }
        continue;
      }
      if (group.targets.size !== 1) continue;
      const [target] = group.targets.values();
      if (!target.resolved) continue;
      exactTrackLinks.set(sourceTrackRefId, target.track);
    }
    const eventRows = this.#database
      .prepare(
        `SELECT
          e.track_ref_id,
          e.record_json AS event_json,
          t.record_json AS track_json
        FROM listening_events e
        JOIN track_refs t
          ON t.track_ref_id = e.track_ref_id
          AND t.revision = e.track_ref_revision
        WHERE e.subject_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM listening_event_supersessions s
            WHERE s.superseded_event_id = e.listening_event_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM listening_event_mirrors m
            WHERE m.mirror_event_id = e.listening_event_id
          )
        ORDER BY e.occurred_at, e.listening_event_id`,
      )
      .all(normalizedSubjectId)
      .map((row) => {
        const originalTrack = JSON.parse(row.track_json);
        const linkedTrack = exactTrackLinks.get(row.track_ref_id);
        return {
          event: JSON.parse(row.event_json),
          track: linkedTrack ?? originalTrack,
          ...(linkedTrack
            ? { cross_format_source_track_ref_id: row.track_ref_id }
            : {}),
          ...(!linkedTrack && ambiguousTrackSources.has(row.track_ref_id)
            ? { cross_format_ambiguous_track_ref_id: row.track_ref_id }
            : {}),
        };
      });
    const profileEvidence = this.#database
      .prepare(
        `SELECT record_json FROM spotify_profile_evidence
        WHERE subject_id = ?
        ORDER BY observed_at, profile_evidence_id`,
      )
      .all(normalizedSubjectId)
      .map((row) => JSON.parse(row.record_json));
    const tasteEvents = this.#database
      .prepare(
        `SELECT record_json FROM taste_events
        WHERE subject_id = ?
        ORDER BY recorded_at, taste_event_id`,
      )
      .all(normalizedSubjectId)
      .map((row) => JSON.parse(row.record_json));
    const { rows, adopted } = markMoondogStartedPlays(eventRows, this.#suggestionsForMatching());
    return {
      ...projectListeningProfile({
        subjectId: normalizedSubjectId,
        eventRows: rows,
        profileEvidence,
        tasteEvents,
        maxItems,
        adoptedSuggestionIds: adopted,
      }),
      adoptedSuggestionIds: adopted,
    };
  }

  #suggestionsForMatching() {
    return this.#database.prepare(`SELECT suggestion_id, provider_track_id, isrc, track_key, release_key, title, artist_credit,
      requested_at FROM moondog_suggestions ORDER BY requested_at, suggestion_id`).all();
  }

  /** Records what Moondog itself queued or played. Only accepted host writes belong here. */
  recordMoondogSuggestions({ entries } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!Array.isArray(entries) || entries.length > 50) throw new TypeError("Moondog suggestions are invalid");
    const insert = this.#database.prepare(`INSERT INTO moondog_suggestions
      (suggestion_id, service, action, provider_track_id, isrc, track_key, release_key, title, artist_credit, requested_at, mix_slot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let recorded = 0;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const value of entries) {
        const entry = suggestionEntry(value);
        if (!entry || !/^[a-z][a-z0-9_.]{1,63}$/u.test(entry.action ?? "") || !Number.isFinite(Date.parse(entry.requested_at))) continue;
        insert.run(randomUUID(), entry.service, entry.action, entry.provider_track_id, entry.isrc, entry.track_key, entry.release_key,
          entry.title, entry.artist_credit, new Date(entry.requested_at).toISOString(), entry.mix_slot);
        recorded += 1;
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    this.#ledgerChanges += recorded;
    return { recorded };
  }

  /**
   * Moondog's earlier suggestions of each track, matched as stored plays are: the same provider
   * track, ISRC or song. Adopted means the listener later played it again on their own.
   */
  moondogSuggestionHistory({ subjectId, tracks } = {}) {
    if (!Array.isArray(tracks)) throw new TypeError("Suggestion history tracks are invalid");
    const suggestions = this.#suggestionsForMatching();
    if (!suggestions.length) return tracks.map(() => null);
    const { adopted } = this.#listeningSnapshot(subjectId);
    const byIdentity = new Map();
    for (const suggestion of suggestions) {
      for (const identity of suggestionIdentities(suggestion)) {
        byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), suggestion]);
      }
    }
    return tracks.map((track) => {
      const entry = suggestionEntry({ service: "spotify", action: "lookup", ...track });
      const matches = new Set(entry ? suggestionIdentities(entry).flatMap((identity) => byIdentity.get(identity) ?? []) : []);
      if (!matches.size) return null;
      const last = [...matches].reduce((latest, item) => item.requested_at > latest ? item.requested_at : latest, "");
      return { times: matches.size, last_suggested_at: last.slice(0, 10),
        adopted: [...matches].some((item) => adopted.has(item.suggestion_id)) };
    });
  }

  /** Where each track sits in the listener's own plays (MIX_SLOTS in moondog-suggestions.mjs). */
  listeningMix({ subjectId, tracks } = {}) {
    if (!Array.isArray(tracks)) throw new TypeError("Listening mix tracks are invalid");
    const { familiarity } = this.#listeningSnapshot(subjectId);
    return tracks.map((track) => mixSlot(track, familiarity));
  }

  // One projection with a single item per list serves the status, the Avoids, the catalog, the
  // mix and the suggestion history until the listening data changes. Callers copy what they return.
  #sharedProjection(subjectId) {
    const version = `${subjectId}:${this.listeningDataVersion()}`;
    if (this.#projection?.version !== version) {
      this.#projection = { version, value: this.#profileProjection({ subjectId, maxItems: 1 }) };
    }
    return this.#projection.value;
  }

  #listeningSnapshot(subjectId) {
    const version = `${subjectId}:${this.listeningDataVersion()}`;
    if (this.#snapshot?.version !== version) {
      const projected = this.#sharedProjection(subjectId);
      this.#snapshot = { version, adopted: projected.adoptedSuggestionIds,
        familiarity: listeningFamiliarity(projected.catalog, projected.summary.listening_behavior.context.reference_date) };
    }
    return this.#snapshot;
  }

  /** Every track the subject has played, with its play count, most played first. */
  listenedTracks({ subjectId } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (typeof subjectId !== "string" || !subjectId.trim()) {
      throw new TypeError("A listening history subject ID is required");
    }
    const trackStatement = this.#database.prepare(
      `SELECT record_json FROM track_refs
      WHERE track_ref_id = ?
      ORDER BY revision DESC
      LIMIT 1`,
    );
    return this.#database
      .prepare(
        `SELECT track_ref_id, COUNT(*) AS play_count
        FROM listening_events
        WHERE subject_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM listening_event_supersessions
            WHERE superseded_event_id = listening_events.listening_event_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM listening_event_mirrors m
            WHERE m.mirror_event_id = listening_events.listening_event_id
          )
        GROUP BY track_ref_id
        ORDER BY play_count DESC, track_ref_id`,
      )
      .all(subjectId.toLowerCase())
      .flatMap((row) => {
        const record = trackStatement.get(row.track_ref_id);
        if (!record) return [];
        const track = JSON.parse(record.record_json);
        const artistCredit = track.artist_credits?.[0]?.name;
        if (typeof track.title !== "string" || typeof artistCredit !== "string") return [];
        return [{
          track_ref_id: row.track_ref_id,
          title: track.title,
          artist_credit: artistCredit,
          release: typeof track.release?.title === "string" && track.release.title.trim()
            ? track.release.title
            : "Unknown release",
          play_count: row.play_count,
          ...(Number.isInteger(track.duration_ms) ? { duration_ms: track.duration_ms } : {}),
        }];
      });
  }

  lyricProfile({ subjectId } = {}) {
    const value = this.#profileProjection({ subjectId, maxItems: 50 });
    return structuredClone({ ...value.summary, lyric_exclusions: value.lyricExclusions });
  }

  activeAvoidances({ subjectId } = {}) {
    // Host-side filtering must include corrections outside the bounded display.
    return structuredClone(this.#sharedProjection(subjectId).lyricExclusions);
  }

  profileSummary({ subjectId, maxItems = 10 } = {}) {
    return structuredClone((maxItems === 1 ? this.#sharedProjection(subjectId)
      : this.#profileProjection({ subjectId, maxItems })).summary);
  }

  profileCatalog({ subjectId } = {}) {
    const projected = this.#sharedProjection(subjectId);
    const normalizedSubjectId = subjectId.toLowerCase();
    const imports = this.#database.prepare(`SELECT source_format AS format, data_scope AS scope,
      SUM(input_records) AS input_records, MIN(earliest_occurred_at) AS earliest,
      MAX(latest_occurred_at) AS latest
      FROM import_batches WHERE subject_id = ? GROUP BY source_format, data_scope ORDER BY source_format`)
      .all(normalizedSubjectId);
    const stored = this.#database.prepare("SELECT COUNT(*) AS count FROM listening_events WHERE subject_id = ?")
      .get(normalizedSubjectId).count;
    return structuredClone({
      coverage: { ...projected.summary.coverage,
        stored_listening_events: stored,
        superseded_listening_events: stored - projected.summary.coverage.effective_listening_events },
      sources: imports,
      context: {
        reference_date: projected.summary.listening_behavior.context.reference_date,
        recent_window_days: projected.summary.listening_behavior.context.recent_window_days,
        incognito_events_excluded: projected.summary.listening_behavior.context.incognito_events_excluded,
        ...(projected.summary.listening_behavior.context.moondog_started_events_excluded
          ? { moondog_started_events_excluded: projected.summary.listening_behavior.context.moondog_started_events_excluded } : {}),
        release_minimum_distinct_tracks: projected.summary.listening_behavior.context.release_minimum_distinct_tracks,
      },
      sections: projected.catalog,
    });
  }

  // What the listener played lately: stored plays on today and the `days` - 1 local days before
  // it, by artist. It reads the clock, not the newest play, so a history that stopped shows as
  // quiet. Whole local days keep the window, and so the model's context, the same all day.
  recentAttention({ subjectId, days = 28, now = Date.now(), limit = 10 } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!isUuid(subjectId)) throw new TypeError("A valid profile subject is required");
    const today = new Date(now);
    const start = new Date(today);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const from = start.toISOString();
    const effective = `e.subject_id = ? AND e.occurred_at >= ?
      AND NOT EXISTS (SELECT 1 FROM listening_event_supersessions s WHERE s.superseded_event_id = e.listening_event_id)
      AND NOT EXISTS (SELECT 1 FROM listening_event_mirrors m WHERE m.mirror_event_id = e.listening_event_id)`;
    const subject = subjectId.toLowerCase();
    // Plays Moondog started are not the listener's own attention.
    const suggestions = this.#suggestionsForMatching()
      .filter((suggestion) => Date.parse(suggestion.requested_at) + SUGGESTION_WINDOW.afterMs >= Date.parse(from));
    const started = suggestions.length === 0 ? [] : markMoondogStartedPlays(this.#database.prepare(`SELECT
      e.listening_event_id, e.record_json AS event_json, t.record_json AS track_json FROM listening_events e
      JOIN track_refs t ON t.track_ref_id = e.track_ref_id AND t.revision = e.track_ref_revision WHERE ${effective}`)
      .all(subject, from).map((row) => ({ id: row.listening_event_id, event: JSON.parse(row.event_json), track: JSON.parse(row.track_json) })),
    suggestions).rows.filter((row) => row.moondog_suggestion_id).map((row) => row.id);
    const own = `${effective} AND e.listening_event_id NOT IN (SELECT value FROM json_each(?))`;
    const plays = this.#database.prepare(`SELECT COUNT(*) AS plays FROM listening_events e WHERE ${own}`)
      .get(subject, from, JSON.stringify(started)).plays;
    const artists = this.#database.prepare(`SELECT json_extract(a.value, '$.name') AS name, COUNT(*) AS plays,
      MAX(e.occurred_at) AS last_played_at
      FROM listening_events e
      JOIN track_refs t ON t.track_ref_id = e.track_ref_id AND t.revision = e.track_ref_revision
      JOIN json_each(t.record_json, '$.artist_credits') a
      WHERE ${own} AND name IS NOT NULL
      GROUP BY name ORDER BY plays DESC, last_played_at DESC LIMIT ?`).all(subject, from, JSON.stringify(started), limit);
    return structuredClone({ from_date: localDate(start), through_date: localDate(today), plays,
      ...(started.length ? { moondog_started_plays: started.length } : {}), top_artists: artists });
  }

  // Which spans of time the stored plays cover, and where plays may be missing.
  listeningCoverage({ subjectId } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!isUuid(subjectId)) throw new TypeError("A valid profile subject is required");
    const subject = subjectId.toLowerCase();
    // Reading every play is the slow part, so it is kept until the listening data changes.
    const version = `${subject}:${this.listeningDataVersion()}`;
    if (this.#coverageSources?.version !== version) {
      this.#coverageSources = { version, sources: this.#database.prepare(`SELECT
        json_extract(record_json, '$.provenance.external_ref.entity_type') AS kind,
        COUNT(*) AS plays, MIN(occurred_at) AS first_played_at, MAX(occurred_at) AS last_played_at
        FROM listening_events WHERE subject_id = ? GROUP BY kind ORDER BY first_played_at`).all(subject) };
    }
    const { sources } = this.#coverageSources;
    // A history file imported later can fill a span that a sync missed.
    const filled = this.#database.prepare(`SELECT earliest_occurred_at AS earliest, latest_occurred_at AS latest
      FROM import_batches WHERE subject_id = ? AND earliest_occurred_at IS NOT NULL AND latest_occurred_at IS NOT NULL`).all(subject);
    const gaps = this.#database.prepare(`SELECT gap_start AS "from", gap_end AS "to"
      FROM listening_coverage_gaps WHERE subject_id = ? ORDER BY gap_start`).all(subject)
      .flatMap((gap) => filled.reduce((spans, { earliest, latest }) => spans.flatMap((span) =>
        latest <= span.from || earliest >= span.to ? [span] : [
          ...(earliest > span.from ? [{ from: span.from, to: earliest }] : []),
          ...(latest < span.to ? [{ from: latest, to: span.to }] : []),
        ]), [{ ...gap }]));
    const checked = this.#database.prepare("SELECT updated_at FROM source_cursors WHERE source_key = 'spotify.recently_played'").get();
    return structuredClone({
      sources: sources.map(({ kind, ...source }) => ({ source: COVERAGE_SOURCE_LABELS[kind] ?? kind, ...source })),
      gaps: gaps.slice(-10),
      ...(checked ? { recent_plays_checked_at: checked.updated_at } : {}),
    });
  }

  listenerProfileStorage({ subjectId } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!isUuid(subjectId)) throw new TypeError("A valid profile subject is required");
    return new ListenerProfileStore(this.#database, subjectId.toLowerCase());
  }

  profileDataVersion() {
    if (this.#closed) throw new Error("Listening history store is closed");
    // data_version observes other connections; total_changes observes our own.
    // This is a connection-local cache key, never a persisted evidence digest.
    return `${this.#database.prepare("PRAGMA data_version").get().data_version}:${
      this.#database.prepare("SELECT total_changes() AS changes").get().changes}`;
  }

  // A version of the listening evidence that no suggestions ledger write changes, from this
  // connection or another, such as the other surface's. A new suggestion changes no projection
  // until its plays arrive, so caches of the projection, the Avoids, the status and the build
  // input key on this and are not rebuilt after every queue. This connection's own writes count
  // by total_changes. Another connection's commit moves data_version whatever it wrote, so then
  // the evidence tables themselves say whether the evidence changed.
  listeningDataVersion() {
    if (this.#closed) throw new Error("Listening history store is closed");
    const dataVersion = this.#database.prepare("PRAGMA data_version").get().data_version;
    const ownChanges = this.#database.prepare("SELECT total_changes() AS changes").get().changes - this.#ledgerChanges;
    if (this.#evidence?.dataVersion !== dataVersion || this.#evidence.ownChanges !== ownChanges) {
      this.#evidence = { dataVersion, ownChanges, fingerprint: this.#evidenceFingerprint() };
    }
    return `${this.#evidence.fingerprint}:${ownChanges}`;
  }

  #evidenceFingerprint() {
    const digest = createHash("sha256");
    for (const table of APPENDED_EVIDENCE_TABLES) {
      digest.update(JSON.stringify(this.#database.prepare(`SELECT COUNT(*) AS rows, MAX(rowid) AS last FROM ${table}`).get()));
    }
    for (const table of UPDATED_EVIDENCE_TABLES) {
      for (const row of this.#database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) digest.update(JSON.stringify(row));
    }
    return digest.digest("hex");
  }

  profileEvidenceRevision({ subjectId } = {}) {
    if (this.#closed) throw new Error("Listening history store is closed");
    if (!isUuid(subjectId)) throw new TypeError("A valid profile subject is required");
    const digest = createHash("sha256");
    // Build artifacts never feed back into source evidence. Hash locally; raw
    // events, source identifiers and private import metadata do not go to Pi.
    const queries = [
      "SELECT record_json FROM listening_events WHERE subject_id = ? ORDER BY listening_event_id",
      "SELECT record_json FROM spotify_profile_evidence WHERE subject_id = ? ORDER BY profile_evidence_id",
      "SELECT record_json FROM taste_events WHERE subject_id = ? ORDER BY taste_event_id",
      "SELECT * FROM import_batches WHERE subject_id = ? ORDER BY import_batch_id",
      "SELECT * FROM profile_import_batches WHERE subject_id = ? ORDER BY profile_import_id",
      `SELECT t.record_json FROM track_refs t WHERE EXISTS (SELECT 1 FROM listening_events e
        WHERE e.subject_id = ? AND e.track_ref_id = t.track_ref_id AND e.track_ref_revision = t.revision)
        ORDER BY t.track_ref_id, t.revision`,
    ];
    for (const query of queries) {
      digest.update(query).update("\0");
      for (const row of this.#database.prepare(query).iterate(subjectId.toLowerCase())) {
        digest.update(JSON.stringify(row)).update("\0");
      }
    }
    // Moondog's suggestions decide which plays count as the listener's own. A play can match a
    // suggestion made up to SUGGESTION_WINDOW.beforeMs after it, for clock skew; one made later
    // than that after the latest stored play matches nothing yet, so it leaves the reading current.
    const latest = this.#database.prepare("SELECT MAX(occurred_at) AS latest FROM listening_events WHERE subject_id = ?")
      .get(subjectId.toLowerCase()).latest;
    const latestMs = Date.parse(latest ?? "");
    const suggestions = Number.isFinite(latestMs) ? this.#database.prepare(`SELECT suggestion_id, provider_track_id, isrc, track_key,
      release_key, title, artist_credit, requested_at FROM moondog_suggestions WHERE requested_at <= ? ORDER BY suggestion_id`)
      .all(new Date(latestMs + SUGGESTION_WINDOW.beforeMs).toISOString()) : [];
    if (suggestions.length) digest.update("moondog_suggestions\0").update(JSON.stringify(suggestions));
    return digest.digest("hex");
  }

  rediscoveryCandidates({ subjectId, limit = 6 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 12) {
      throw new TypeError("Listening rediscovery limit is invalid");
    }
    const summary = this.#profileProjection({ subjectId, maxItems: limit }).summary;
    const candidates = summary.listening_behavior.rediscovery_tracks ?? [];
    const trackStatement = this.#database.prepare(
      `SELECT record_json FROM track_refs
      WHERE track_ref_id = ?
      ORDER BY revision DESC
      LIMIT 1`,
    );
    const tracks = candidates.map((candidate) => {
      const row = trackStatement.get(candidate.track_ref_id);
      if (!row) {
        throw new Error("A rediscovery track is missing from the trusted store");
      }
      const track = JSON.parse(row.record_json);
      const artistCredit = track.artist_credits?.[0]?.name;
      if (
        typeof track.title !== "string" ||
        typeof artistCredit !== "string" ||
        track.track_ref_id !== candidate.track_ref_id
      ) {
        throw new Error("A trusted rediscovery track is invalid");
      }
      return {
        track_ref_id: candidate.track_ref_id,
        title: track.title,
        artist_credit: artistCredit,
        release:
          typeof track.release?.title === "string" && track.release.title.trim()
            ? track.release.title
            : "Unknown release",
        candidate_scope: "private_history",
        identity_status:
          track.identity_status === "resolved" ? "resolved" : "provisional",
        labels: { genres: [] },
        observation_summary: {
          preference_signals: [],
          familiarity: {
            level:
              candidate.play_count >= 20
                ? "high"
                : candidate.play_count >= 5
                  ? "medium"
                  : "low",
            basis: "effective_listening_history",
            play_count: candidate.play_count,
          },
        },
        rediscovery: {
          listening_minutes: candidate.listening_minutes,
          engaged_play_count: candidate.engaged_play_count,
          explicit_skips: candidate.explicit_skips,
          first_played_at: candidate.first_played_at,
          last_played_at: candidate.last_played_at,
          quiet_days: candidate.quiet_days,
          rediscovery_signal: candidate.rediscovery_signal,
          peak_year: candidate.peak_year,
          peak_year_play_count: candidate.peak_year_play_count,
          peak_year_listening_minutes:
            candidate.peak_year_listening_minutes,
          evidence_id: candidate.evidence_id,
        },
        ...(Number.isInteger(track.duration_ms)
          ? { duration_ms: track.duration_ms }
          : {}),
        ...(Array.isArray(track.external_refs)
          ? { external_refs: structuredClone(track.external_refs) }
          : {}),
      };
    });
    return {
      reference_date: summary.listening_behavior.context.reference_date,
      quiet_days: summary.listening_behavior.context.rediscovery_quiet_days,
      minimum_plays:
        summary.listening_behavior.context.rediscovery_minimum_plays,
      minimum_engaged_plays:
        summary.listening_behavior.context.rediscovery_minimum_engaged_plays,
      minimum_listening_minutes:
        summary.listening_behavior.context
          .rediscovery_minimum_listening_minutes,
      tracks,
    };
  }

  historicalReturnCandidates({ subjectId, limit = 6 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 12) {
      throw new TypeError("Listening historical-return limit is invalid");
    }
    const summary = this.#profileProjection({ subjectId, maxItems: limit }).summary;
    const candidates =
      summary.listening_behavior.historical_return_tracks ?? [];
    const trackStatement = this.#database.prepare(
      `SELECT record_json FROM track_refs
      WHERE track_ref_id = ?
      ORDER BY revision DESC
      LIMIT 1`,
    );
    const tracks = candidates.map((candidate) => {
      const row = trackStatement.get(candidate.track_ref_id);
      if (!row) {
        throw new Error(
          "A historical-return track is missing from the trusted store",
        );
      }
      const track = JSON.parse(row.record_json);
      const artistCredit = track.artist_credits?.[0]?.name;
      if (
        typeof track.title !== "string" ||
        typeof artistCredit !== "string" ||
        track.track_ref_id !== candidate.track_ref_id
      ) {
        throw new Error("A trusted historical-return track is invalid");
      }
      return {
        track_ref_id: candidate.track_ref_id,
        title: track.title,
        artist_credit: artistCredit,
        release:
          typeof track.release?.title === "string" && track.release.title.trim()
            ? track.release.title
            : "Unknown release",
        candidate_scope: "private_history",
        identity_status:
          track.identity_status === "resolved" ? "resolved" : "provisional",
        labels: { genres: [] },
        observation_summary: {
          preference_signals: [],
          familiarity: {
            level:
              candidate.play_count >= 20
                ? "high"
                : candidate.play_count >= 5
                  ? "medium"
                  : "low",
            basis: "effective_listening_history",
            play_count: candidate.play_count,
          },
        },
        historical_return: {
          listening_minutes: candidate.listening_minutes,
          engaged_play_count: candidate.engaged_play_count,
          explicit_skips: candidate.explicit_skips,
          first_played_at: candidate.first_played_at,
          last_played_at: candidate.last_played_at,
          return_count: candidate.return_count,
          longest_gap_days: candidate.longest_gap_days,
          latest_return_at: candidate.latest_return_at,
          latest_return_gap_days: candidate.latest_return_gap_days,
          historical_return_signal: candidate.historical_return_signal,
          evidence_id: candidate.evidence_id,
        },
        ...(Number.isInteger(track.duration_ms)
          ? { duration_ms: track.duration_ms }
          : {}),
        ...(Array.isArray(track.external_refs)
          ? { external_refs: structuredClone(track.external_refs) }
          : {}),
      };
    });
    return {
      reference_date: summary.listening_behavior.context.reference_date,
      minimum_gap_days:
        summary.listening_behavior.context
          .historical_return_minimum_gap_days,
      minimum_plays:
        summary.listening_behavior.context.historical_return_minimum_plays,
      minimum_engaged_plays:
        summary.listening_behavior.context
          .historical_return_minimum_engaged_plays,
      minimum_listening_minutes:
        summary.listening_behavior.context
          .historical_return_minimum_listening_minutes,
      tracks,
    };
  }

  backToBackCandidates({ subjectId, limit = 6 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 12) {
      throw new TypeError("Listening back-to-back limit is invalid");
    }
    const summary = this.#profileProjection({ subjectId, maxItems: limit }).summary;
    const candidates = summary.listening_behavior.back_to_back_tracks ?? [];
    const trackStatement = this.#database.prepare(
      `SELECT record_json FROM track_refs
      WHERE track_ref_id = ?
      ORDER BY revision DESC
      LIMIT 1`,
    );
    const tracks = candidates.map((candidate) => {
      const row = trackStatement.get(candidate.track_ref_id);
      if (!row) {
        throw new Error("A back-to-back track is missing from the trusted store");
      }
      const track = JSON.parse(row.record_json);
      const artistCredit = track.artist_credits?.[0]?.name;
      if (
        typeof track.title !== "string" ||
        typeof artistCredit !== "string" ||
        track.track_ref_id !== candidate.track_ref_id
      ) {
        throw new Error("A trusted back-to-back track is invalid");
      }
      return {
        track_ref_id: candidate.track_ref_id,
        title: track.title,
        artist_credit: artistCredit,
        release:
          typeof track.release?.title === "string" && track.release.title.trim()
            ? track.release.title
            : "Unknown release",
        candidate_scope: "private_history",
        identity_status:
          track.identity_status === "resolved" ? "resolved" : "provisional",
        labels: { genres: [] },
        observation_summary: {
          preference_signals: [],
          familiarity: {
            level:
              candidate.play_count >= 20
                ? "high"
                : candidate.play_count >= 5
                  ? "medium"
                  : "low",
            basis: "effective_listening_history",
            play_count: candidate.play_count,
          },
        },
        back_to_back: {
          engaged_play_count: candidate.engaged_play_count,
          explicit_skips: candidate.explicit_skips,
          burst_count: candidate.burst_count,
          maximum_consecutive_plays: candidate.maximum_consecutive_plays,
          plays_in_bursts: candidate.plays_in_bursts,
          listening_minutes_in_bursts:
            candidate.listening_minutes_in_bursts,
          latest_burst_at: candidate.latest_burst_at,
          sequence_signal: candidate.sequence_signal,
          evidence_id: candidate.evidence_id,
        },
        ...(Number.isInteger(track.duration_ms)
          ? { duration_ms: track.duration_ms }
          : {}),
        ...(Array.isArray(track.external_refs)
          ? { external_refs: structuredClone(track.external_refs) }
          : {}),
      };
    });
    return {
      reference_date: summary.listening_behavior.context.reference_date,
      minimum_consecutive_plays:
        summary.listening_behavior.context
          .back_to_back_minimum_consecutive_plays,
      minimum_played_seconds:
        summary.listening_behavior.context
          .back_to_back_minimum_played_seconds,
      maximum_gap_minutes:
        summary.listening_behavior.context
          .back_to_back_maximum_gap_minutes,
      tracks,
    };
  }

  timeCapsuleCandidates({ subjectId, limit = 6 } = {}) {
    if (!Number.isInteger(limit) || limit < 2 || limit > 12) {
      throw new TypeError("Listening time capsule limit is invalid");
    }
    const summary = this.#profileProjection({ subjectId, maxItems: limit }).summary;
    const candidates = summary.listening_behavior.time_capsule_tracks ?? [];
    const trackStatement = this.#database.prepare(
      `SELECT record_json FROM track_refs
      WHERE track_ref_id = ?
      ORDER BY revision DESC
      LIMIT 1`,
    );
    const tracks = candidates.map((candidate) => {
      const row = trackStatement.get(candidate.track_ref_id);
      if (!row) {
        throw new Error("A time capsule track is missing from the trusted store");
      }
      const track = JSON.parse(row.record_json);
      const artistCredit = track.artist_credits?.[0]?.name;
      if (
        typeof track.title !== "string" ||
        typeof artistCredit !== "string" ||
        track.track_ref_id !== candidate.track_ref_id
      ) {
        throw new Error("A trusted time capsule track is invalid");
      }
      return {
        track_ref_id: candidate.track_ref_id,
        title: track.title,
        artist_credit: artistCredit,
        release:
          typeof track.release?.title === "string" && track.release.title.trim()
            ? track.release.title
            : "Unknown release",
        candidate_scope: "private_history",
        identity_status:
          track.identity_status === "resolved" ? "resolved" : "provisional",
        labels: { genres: [] },
        observation_summary: {
          preference_signals: [],
          familiarity: {
            level:
              candidate.lifetime_play_count >= 20
                ? "high"
                : candidate.lifetime_play_count >= 5
                  ? "medium"
                  : "low",
            basis: "effective_listening_history",
            play_count: candidate.lifetime_play_count,
          },
        },
        time_capsule: {
          year: candidate.capsule_year,
          year_play_count: candidate.year_play_count,
          year_engaged_play_count: candidate.year_engaged_play_count,
          year_listening_minutes: candidate.year_listening_minutes,
          year_explicit_skips: candidate.year_explicit_skips,
          lifetime_listening_minutes: candidate.lifetime_listening_minutes,
          representative_signal: candidate.representative_signal,
          evidence_id: candidate.evidence_id,
        },
        ...(Number.isInteger(track.duration_ms)
          ? { duration_ms: track.duration_ms }
          : {}),
        ...(Array.isArray(track.external_refs)
          ? { external_refs: structuredClone(track.external_refs) }
          : {}),
      };
    });
    const years = tracks.map((track) => track.time_capsule.year);
    return {
      reference_date: summary.listening_behavior.context.reference_date,
      history_start_year:
        summary.listening_behavior.history_arc[0]?.year ?? null,
      history_end_year:
        summary.listening_behavior.history_arc.at(-1)?.year ?? null,
      minimum_years:
        summary.listening_behavior.context.time_capsule_minimum_years,
      minimum_engaged_plays:
        summary.listening_behavior.context
          .time_capsule_minimum_engaged_plays,
      minimum_listening_minutes:
        summary.listening_behavior.context
          .time_capsule_minimum_listening_minutes,
      represented_years: years,
      tracks,
    };
  }

  explainProfileEvidence({ subjectId, evidenceId } = {}) {
    if (!isUuid(evidenceId)) {
      throw new TypeError("Listening profile evidence ID is invalid");
    }
    const projected = this.#profileProjection({ subjectId, maxItems: 50 });
    const value = projected.explanations.get(evidenceId.toLowerCase());
    return value ? structuredClone(value) : null;
  }

  status() {
    if (this.#closed) return { state: "closed" };
    return {
      state: "ready",
      track_refs: this.#database
        .prepare("SELECT COUNT(*) AS count FROM track_refs")
        .get().count,
      listening_events: this.#database
        .prepare("SELECT COUNT(*) AS count FROM listening_events")
        .get().count,
      effective_listening_events: this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM listening_events
          WHERE NOT EXISTS (
            SELECT 1 FROM listening_event_supersessions
            WHERE superseded_event_id = listening_events.listening_event_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM listening_event_mirrors m
            WHERE m.mirror_event_id = listening_events.listening_event_id
          )`,
        )
        .get().count,
      superseded_listening_events: this.#database
        .prepare("SELECT COUNT(*) AS count FROM listening_event_supersessions")
        .get().count,
      sources: this.#database
        .prepare("SELECT COUNT(*) AS count FROM source_cursors")
        .get().count,
      import_batches: this.#database
        .prepare("SELECT COUNT(*) AS count FROM import_batches")
        .get().count,
      profile_import_batches: this.#database
        .prepare("SELECT COUNT(*) AS count FROM profile_import_batches")
        .get().count,
      profile_evidence: this.#database
        .prepare("SELECT COUNT(*) AS count FROM spotify_profile_evidence")
        .get().count,
      taste_assertions: this.#database
        .prepare(
          "SELECT COUNT(*) AS count FROM taste_events WHERE operation = 'assert'",
        )
        .get().count,
      active_taste_assertions: this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM taste_events a
          WHERE a.operation = 'assert'
            AND NOT EXISTS (
              SELECT 1 FROM taste_events r
              WHERE r.retracts_taste_event_id = a.taste_event_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM taste_events s
              WHERE s.supersedes_taste_event_id = a.taste_event_id
            )`,
        )
        .get().count,
    };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}

let databaseConstructorPromise;

function databaseConstructor() {
  databaseConstructorPromise ??= import("node:sqlite").then(
    ({ DatabaseSync }) => DatabaseSync,
  );
  return databaseConstructorPromise;
}

async function initializeListeningHistoryDatabase(
  database,
  { journalMode, filePath = null },
) {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`PRAGMA journal_mode = ${journalMode}`);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA trusted_schema = OFF");
  const currentVersion = database.prepare("PRAGMA user_version").get()
    .user_version;
  if (
    !Number.isInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > LISTENING_HISTORY_SCHEMA_VERSION
  ) {
    throw new Error("Listening history database schema is incompatible");
  }
  const recordsGaps = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'listening_coverage_gaps'",
  ).get();
  database.exec(schema);
  if (!recordsGaps) recordEarlierRecentSyncGaps(database);
  if (currentVersion < LISTENING_HISTORY_SCHEMA_VERSION) {
    database.exec(
      `PRAGMA user_version = ${LISTENING_HISTORY_SCHEMA_VERSION}`,
    );
  }
  if (filePath && process.platform !== "win32") {
    await chmod(filePath, 0o600);
  }
}

export async function openEphemeralListeningHistoryStore() {
  const DatabaseSync = await databaseConstructor();
  const database = new DatabaseSync(":memory:");
  try {
    await initializeListeningHistoryDatabase(database, {
      journalMode: "MEMORY",
    });
    return new ListeningHistoryStore(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function openListeningHistoryStore({
  databasePath = defaultListeningHistoryPath,
  environment = process.env,
} = {}) {
  const resolvedPath =
    databasePath === defaultListeningHistoryPath
      ? resolveListeningHistoryPath(environment)
      : databasePath;
  const parent = path.dirname(path.resolve(resolvedPath));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(parent, 0o700);

  const DatabaseSync = await databaseConstructor();
  const database = new DatabaseSync(path.resolve(resolvedPath));
  try {
    await initializeListeningHistoryDatabase(database, {
      journalMode: "WAL",
      filePath: path.resolve(resolvedPath),
    });
    return new ListeningHistoryStore(database);
  } catch (error) {
    database.close();
    throw error;
  }
}
