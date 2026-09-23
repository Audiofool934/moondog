import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { isUuid } from "../core/uuid-v5.mjs";
import {
  createListenerCorrection,
  createListenerCorrectionRetraction,
} from "./listener-corrections.mjs";
import { projectListeningProfile } from "./listening-profile-projection.mjs";

export const LISTENING_HISTORY_SCHEMA_VERSION = 6;

export function resolveListeningHistoryPath(environment = process.env) {
  const configuredState = environment.MOONDOG_STATE_HOME?.trim();
  if (configuredState) {
    if (!path.isAbsolute(configuredState)) {
      throw new TypeError("MOONDOG_STATE_HOME must be an absolute path");
    }
    return path.join(path.resolve(configuredState), "listening-history.sqlite");
  }

  const configuredConfig = environment.MOONDOG_CONFIG_HOME?.trim();
  if (configuredConfig) {
    if (!path.isAbsolute(configuredConfig)) {
      throw new TypeError("MOONDOG_CONFIG_HOME must be an absolute path");
    }
    return path.join(path.resolve(configuredConfig), "listening-history.sqlite");
  }

  const xdgState = environment.XDG_STATE_HOME?.trim();
  if (xdgState && path.isAbsolute(xdgState)) {
    return path.join(
      path.resolve(xdgState),
      "moondog",
      "listening-history.sqlite",
    );
  }

  return path.join(
    homedir(),
    ".local",
    "state",
    "moondog",
    "listening-history.sqlite",
  );
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

  CREATE TABLE IF NOT EXISTS source_cursors (
    source_key TEXT PRIMARY KEY NOT NULL,
    cursor_after_ms INTEGER NOT NULL,
    updated_at TEXT NOT NULL
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
        (["youtube_music", "qq_music", "netease"].includes(record.provenance.source_system) &&
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
  };
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

export class ListeningHistoryStore {
  #database;
  #closed = false;

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
    try {
      if (subjectId !== undefined) {
        this.localSubjectId({ preferredSubjectId: subjectId });
      }
      ({ insertedTracks, insertedEvents } = insertBundleRecords(
        bundle,
        statements,
      ));
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
      cursor_after_ms: this.sourceCursor(bundle.sourceKey),
      profile_effects: insertedEvents > 0 ? "updated" : "unchanged",
    };
  }

  ingestImport(value) {
    if (this.#closed) throw new Error("Listening history store is closed");
    const bundle = normalizedImportBundle(value);
    const batch = bundle.importBatch;
    const existingBatch = this.#database.prepare(
      `SELECT import_batch_id FROM import_batches
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
    let insertedProfileEvidence = 0;
    let alreadyImported = false;
    let profileAlreadyImported = bundle.profileImport === undefined;
    try {
      this.localSubjectId({ preferredSubjectId: batch.subjectId });
      alreadyImported = Boolean(existingBatch.get(batch.importBatchId));
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
      }
      for (const candidate of bundle.reconciliationCandidates) {
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
      effective_event_delta: insertedEvents - supersededEvents,
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
        insertedEvents - supersededEvents !== 0 || insertedProfileEvidence > 0
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
    return projectListeningProfile({
      subjectId: normalizedSubjectId,
      eventRows,
      profileEvidence,
      tasteEvents,
      maxItems,
    });
  }

  lyricProfile({ subjectId } = {}) {
    const value = this.#profileProjection({ subjectId, maxItems: 50 });
    return structuredClone({ ...value.summary, lyric_exclusions: value.lyricExclusions });
  }

  profileSummary({ subjectId, maxItems = 10 } = {}) {
    return structuredClone(
      this.#profileProjection({ subjectId, maxItems }).summary,
    );
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
  database.exec(schema);
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
