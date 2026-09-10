import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalizeJson,
  sha256Hex,
} from "../../../scripts/contract-semantics.mjs";
import { AppleMusicImportError } from "./parse-plist.mjs";
import { listAppleMusicImportBatches } from "./read-batch.mjs";
import { promoteAppleMusicImportBatches } from "./projection-records.mjs";
import { isUuid } from "./stable-ids.mjs";

export const APPLE_SQLITE_PROJECTION_VERSION = 1;
export const APPLE_LIBRARY_SEARCH_HARD_LIMIT = 25;
export const APPLE_LIBRARY_SEARCH_HARD_OFFSET = 10_000;
export const APPLE_PROFILE_SUMMARY_HARD_LIMIT = 50;
export const defaultAppleMusicProjectionPath = fileURLToPath(
  new URL(
    "../../../data/private/apple-music-library/projection.sqlite",
    import.meta.url,
  ),
);

const projectionSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = DELETE;
  PRAGMA trusted_schema = OFF;
  PRAGMA user_version = ${APPLE_SQLITE_PROJECTION_VERSION};

  CREATE TABLE projection_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE track_refs (
    subject_id TEXT NOT NULL,
    track_ref_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
    metadata_digest TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (subject_id, track_ref_id, revision)
  ) STRICT;

  CREATE UNIQUE INDEX track_refs_one_current
    ON track_refs(subject_id, track_ref_id)
    WHERE is_current = 1;

  CREATE TABLE external_anchors (
    subject_id TEXT NOT NULL,
    system TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    track_ref_id TEXT NOT NULL,
    track_ref_revision INTEGER NOT NULL,
    PRIMARY KEY (subject_id, system, entity_type, external_id),
    FOREIGN KEY (subject_id, track_ref_id, track_ref_revision)
      REFERENCES track_refs(subject_id, track_ref_id, revision)
  ) STRICT;

  CREATE TABLE observations (
    subject_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    track_ref_id TEXT NOT NULL,
    track_ref_revision INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    source_batch_ref TEXT NOT NULL,
    source_record_digest TEXT NOT NULL,
    play_count INTEGER,
    loved INTEGER,
    favorited INTEGER,
    rating_value INTEGER,
    rating_computed INTEGER,
    record_json TEXT NOT NULL,
    PRIMARY KEY (subject_id, observation_id),
    UNIQUE (subject_id, source_batch_ref, source_record_digest),
    FOREIGN KEY (subject_id, track_ref_id, track_ref_revision)
      REFERENCES track_refs(subject_id, track_ref_id, revision)
  ) STRICT;

  CREATE TABLE profile_evidence (
    subject_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    claim_dimension TEXT NOT NULL,
    direction TEXT NOT NULL,
    strength REAL NOT NULL,
    confidence REAL NOT NULL,
    basis_observation_id TEXT NOT NULL,
    track_ref_id TEXT NOT NULL,
    track_ref_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY (subject_id, evidence_id),
    FOREIGN KEY (subject_id, basis_observation_id)
      REFERENCES observations(subject_id, observation_id),
    FOREIGN KEY (subject_id, track_ref_id, track_ref_revision)
      REFERENCES track_refs(subject_id, track_ref_id, revision)
  ) STRICT;

  CREATE TABLE profile_summary_items (
    subject_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    direction TEXT NOT NULL,
    strength REAL NOT NULL,
    item_json TEXT NOT NULL,
    PRIMARY KEY (subject_id, evidence_id),
    FOREIGN KEY (subject_id, evidence_id)
      REFERENCES profile_evidence(subject_id, evidence_id)
  ) STRICT;

  CREATE TABLE library_search (
    rowid INTEGER PRIMARY KEY,
    subject_id TEXT NOT NULL,
    track_ref_id TEXT NOT NULL,
    track_ref_revision INTEGER NOT NULL,
    title TEXT NOT NULL,
    title_norm TEXT NOT NULL,
    artist_credit TEXT NOT NULL,
    artist_credit_norm TEXT NOT NULL,
    release_title TEXT NOT NULL,
    release_title_norm TEXT NOT NULL,
    composer TEXT NOT NULL,
    composer_norm TEXT NOT NULL,
    genre_label TEXT NOT NULL,
    genre_label_norm TEXT NOT NULL,
    duration_ms INTEGER,
    play_count INTEGER,
    loved INTEGER,
    favorited INTEGER,
    rating_value INTEGER,
    rating_computed INTEGER,
    UNIQUE (subject_id, track_ref_id),
    FOREIGN KEY (subject_id, track_ref_id, track_ref_revision)
      REFERENCES track_refs(subject_id, track_ref_id, revision)
  ) STRICT;

  CREATE VIRTUAL TABLE library_fts USING fts5(
    title,
    artist_credit,
    release_title,
    composer,
    genre_label,
    content = 'library_search',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;

let databaseConstructorPromise;

async function databaseConstructor() {
  databaseConstructorPromise ??= import("node:sqlite").then(
    ({ DatabaseSync }) => DatabaseSync,
  );
  return databaseConstructorPromise;
}

function fail(code, message, options) {
  throw new AppleMusicImportError(code, message, options);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function pathMetadata(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function preparePrivateDatabasePath(databasePath, boundaryRoot) {
  if (
    typeof databasePath !== "string" ||
    databasePath.trim() === "" ||
    typeof boundaryRoot !== "string" ||
    boundaryRoot.trim() === ""
  ) {
    throw new TypeError("Projection database path and boundary are required");
  }
  const lexicalBoundary = path.resolve(boundaryRoot);
  const lexicalDatabase = path.resolve(databasePath);
  if (!isPathInside(lexicalBoundary, lexicalDatabase)) {
    fail("projection_boundary_invalid", "Projection database is outside its boundary");
  }

  const boundaryMetadata = await pathMetadata(lexicalBoundary);
  if (
    !boundaryMetadata?.isDirectory() ||
    boundaryMetadata.isSymbolicLink()
  ) {
    fail("projection_boundary_invalid", "Projection boundary is invalid");
  }
  const canonicalBoundary = await realpath(lexicalBoundary);
  const parent = path.dirname(lexicalDatabase);
  const segments = path
    .relative(lexicalBoundary, parent)
    .split(path.sep)
    .filter(Boolean);
  let current = lexicalBoundary;
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata = await pathMetadata(current);
    let created = false;
    if (!metadata) {
      try {
        await mkdir(current, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      metadata = await pathMetadata(current);
    }
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      fail("projection_path_invalid", "Projection path contains an unsafe entry");
    }
    const canonicalCurrent = await realpath(current);
    if (!isPathInside(canonicalBoundary, canonicalCurrent)) {
      fail("projection_boundary_invalid", "Projection path escaped its boundary");
    }
    if (created || current === parent) await chmod(current, 0o700);
  }

  const existing = await pathMetadata(lexicalDatabase);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    fail("projection_path_invalid", "Projection database path is unsafe");
  }
  return lexicalDatabase;
}

async function removeTemporaryDatabase(databasePath) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      await unlink(`${databasePath}${suffix}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function normalizedText(value) {
  return (value ?? "").normalize("NFKC").trim().toLowerCase();
}

function artistCredit(trackRef) {
  return (trackRef.artist_credits ?? [])
    .map((credit) => credit.name)
    .filter(Boolean)
    .join("; ");
}

function currentObservationByTrack(records) {
  const latestBatchRef = records.inputs.at(-1).import_batch_id;
  return new Map(
    records.observations
      .filter((observation) => observation.source_batch_ref === latestBatchRef)
      .map((observation) => [observation.track_ref_id, observation]),
  );
}

function profileSummaryItem(evidence) {
  const entity = evidence.claim.value.entity_ref;
  return {
    evidence_id: evidence.profile_evidence_id,
    dimension: evidence.claim.dimension,
    direction: evidence.direction,
    strength: evidence.strength,
    confidence: evidence.confidence,
    track_ref: {
      track_ref_id: entity.entity_id,
      revision: entity.entity_revision,
    },
    label: entity.label,
    observed_at: evidence.created_at,
  };
}

function logicalPayloadFromDatabase(database) {
  database.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.moondog_fts_vocab USING fts5vocab(main, library_fts, instance)",
  );
  const subjectId = JSON.parse(
    database.prepare("SELECT value FROM projection_meta WHERE key = ?").get(
      "projection.subject_id",
    ).value,
  );
  const inputs = JSON.parse(
    database.prepare("SELECT value FROM projection_meta WHERE key = ?").get(
      "projection.inputs",
    ).value,
  );
  const trackRefs = database
    .prepare(
      "SELECT record_json FROM track_refs ORDER BY track_ref_id, revision",
    )
    .all()
    .map((row) => JSON.parse(row.record_json));
  const currentTrackRefs = database
    .prepare(
      "SELECT track_ref_id, revision FROM track_refs WHERE is_current = 1 ORDER BY track_ref_id",
    )
    .all();
  const observations = database
    .prepare(
      "SELECT record_json FROM observations ORDER BY observation_id",
    )
    .all()
    .map((row) => JSON.parse(row.record_json));
  const profileEvidence = database
    .prepare(
      "SELECT record_json FROM profile_evidence ORDER BY evidence_id",
    )
    .all()
    .map((row) => JSON.parse(row.record_json));
  const profileSummaryItems = database
    .prepare(
      "SELECT item_json FROM profile_summary_items ORDER BY evidence_id",
    )
    .all()
    .map((row) => JSON.parse(row.item_json));
  const externalAnchors = database
    .prepare(`
      SELECT
        subject_id, system, entity_type, external_id,
        track_ref_id, track_ref_revision
      FROM external_anchors
      ORDER BY subject_id, system, entity_type, external_id
    `)
    .all();
  const librarySearch = database
    .prepare(`
      SELECT
        rowid, subject_id, track_ref_id, track_ref_revision,
        title, title_norm, artist_credit, artist_credit_norm,
        release_title, release_title_norm, composer, composer_norm,
        genre_label, genre_label_norm, duration_ms,
        play_count, loved, favorited, rating_value, rating_computed
      FROM library_search
      ORDER BY rowid
    `)
    .all();
  const libraryFtsSchema = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?")
    .get("table", "library_fts")?.sql;
  const libraryFtsVocabulary = database
    .prepare(`
      SELECT term, doc, col, offset
      FROM temp.moondog_fts_vocab
      ORDER BY term, doc, col, offset
    `)
    .all();
  if (typeof libraryFtsSchema !== "string") {
    fail("projection_schema_incompatible", "Projection search schema is missing");
  }
  return {
    kind: "moondog.apple_sqlite_logical_projection",
    version: APPLE_SQLITE_PROJECTION_VERSION,
    subject_id: subjectId,
    inputs,
    counts: JSON.parse(
      database.prepare("SELECT value FROM projection_meta WHERE key = ?").get(
        "projection.counts",
      ).value,
    ),
    source_timestamp: JSON.parse(
      database.prepare("SELECT value FROM projection_meta WHERE key = ?").get(
        "projection.source_timestamp",
      ).value,
    ),
    track_refs: trackRefs,
    current_track_refs: currentTrackRefs,
    external_anchors: externalAnchors,
    observations,
    profile_evidence: profileEvidence,
    profile_summary_items: profileSummaryItems,
    library_search: librarySearch,
    library_fts_schema: libraryFtsSchema,
    library_fts_vocabulary: libraryFtsVocabulary,
  };
}

export function computeAppleSqliteLogicalDigest(database) {
  return sha256Hex(logicalPayloadFromDatabase(database));
}

function insertProjectionRecords(database, records) {
  const insertMeta = database.prepare(
    "INSERT INTO projection_meta(key, value) VALUES (?, ?)",
  );
  insertMeta.run("projection.subject_id", canonicalizeJson(records.subject_id));
  insertMeta.run("projection.inputs", canonicalizeJson(records.inputs));
  insertMeta.run("projection.counts", canonicalizeJson(records.counts));
  insertMeta.run(
    "projection.source_timestamp",
    canonicalizeJson(records.inputs.at(-1).captured_at),
  );

  const currentRevisionByTrack = new Map(
    records.currentTrackRefs.map((trackRef) => [
      trackRef.track_ref_id,
      trackRef.revision,
    ]),
  );
  const insertTrackRef = database.prepare(`
    INSERT INTO track_refs(
      subject_id, track_ref_id, revision, is_current, metadata_digest, record_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertExternalAnchor = database.prepare(`
    INSERT INTO external_anchors(
      subject_id, system, entity_type, external_id,
      track_ref_id, track_ref_revision
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const trackRef of records.trackRefs) {
    insertTrackRef.run(
      records.subject_id,
      trackRef.track_ref_id,
      trackRef.revision,
      currentRevisionByTrack.get(trackRef.track_ref_id) === trackRef.revision ? 1 : 0,
      sha256Hex({
        kind: "moondog.sqlite_track_ref_record",
        version: 1,
        track_ref: trackRef,
      }),
      canonicalizeJson(trackRef),
    );
    if (trackRef.revision === 1) {
      for (const externalRef of trackRef.external_refs) {
        insertExternalAnchor.run(
          records.subject_id,
          externalRef.system,
          externalRef.entity_type,
          externalRef.external_id,
          trackRef.track_ref_id,
          trackRef.revision,
        );
      }
    }
  }

  const insertObservation = database.prepare(`
    INSERT INTO observations(
      subject_id, observation_id, track_ref_id, track_ref_revision,
      observed_at, source_batch_ref, source_record_digest,
      play_count, loved, favorited, rating_value, rating_computed, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const observation of records.observations) {
    insertObservation.run(
      records.subject_id,
      observation.library_track_observation_id,
      observation.track_ref_id,
      observation.track_ref_revision,
      observation.observed_at,
      observation.source_batch_ref,
      observation.source_record_digest,
      observation.aggregate_state.play_count ?? null,
      observation.aggregate_state.loved === undefined
        ? null
        : Number(observation.aggregate_state.loved),
      observation.aggregate_state.favorited === undefined
        ? null
        : Number(observation.aggregate_state.favorited),
      observation.aggregate_state.rating?.value ?? null,
      observation.aggregate_state.rating?.computed === undefined
        ? null
        : Number(observation.aggregate_state.rating.computed),
      canonicalizeJson(observation),
    );
  }

  const insertEvidence = database.prepare(`
    INSERT INTO profile_evidence(
      subject_id, evidence_id, claim_dimension, direction, strength,
      confidence, basis_observation_id, track_ref_id, track_ref_revision,
      created_at, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSummaryItem = database.prepare(`
    INSERT INTO profile_summary_items(
      subject_id, evidence_id, dimension, direction, strength, item_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const evidence of records.profileEvidence) {
    const entity = evidence.claim.value.entity_ref;
    const basisObservationId = evidence.basis_refs[0].record_id;
    insertEvidence.run(
      records.subject_id,
      evidence.profile_evidence_id,
      evidence.claim.dimension,
      evidence.direction,
      evidence.strength,
      evidence.confidence,
      basisObservationId,
      entity.entity_id,
      entity.entity_revision,
      evidence.created_at,
      canonicalizeJson(evidence),
    );
    const item = profileSummaryItem(evidence);
    insertSummaryItem.run(
      records.subject_id,
      evidence.profile_evidence_id,
      evidence.claim.dimension,
      evidence.direction,
      evidence.strength,
      canonicalizeJson(item),
    );
  }

  const observationByTrack = currentObservationByTrack(records);
  const insertSearchRow = database.prepare(`
    INSERT INTO library_search(
      rowid, subject_id, track_ref_id, track_ref_revision,
      title, title_norm, artist_credit, artist_credit_norm,
      release_title, release_title_norm, composer, composer_norm,
      genre_label, genre_label_norm, duration_ms,
      play_count, loved, favorited, rating_value, rating_computed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  records.currentTrackRefs.forEach((trackRef, index) => {
    const observation = observationByTrack.get(trackRef.track_ref_id);
    const title = trackRef.title ?? trackRef.display_label;
    const artist = artistCredit(trackRef);
    const releaseTitle = trackRef.release?.title ?? "";
    const composer = trackRef.extensions?.["apple_music.composer"] ?? "";
    const genre = trackRef.extensions?.["apple_music.genre"] ?? "";
    insertSearchRow.run(
      index + 1,
      records.subject_id,
      trackRef.track_ref_id,
      trackRef.revision,
      title,
      normalizedText(title),
      artist,
      normalizedText(artist),
      releaseTitle,
      normalizedText(releaseTitle),
      composer,
      normalizedText(composer),
      genre,
      normalizedText(genre),
      trackRef.duration_ms ?? null,
      observation?.aggregate_state.play_count ?? null,
      observation?.aggregate_state.loved === undefined
        ? null
        : Number(observation.aggregate_state.loved),
      observation?.aggregate_state.favorited === undefined
        ? null
        : Number(observation.aggregate_state.favorited),
      observation?.aggregate_state.rating?.value ?? null,
      observation?.aggregate_state.rating?.computed === undefined
        ? null
        : Number(observation.aggregate_state.rating.computed),
    );
  });
  database.exec("INSERT INTO library_fts(library_fts) VALUES ('rebuild')");
}

function assertDatabaseIntegrity(database) {
  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length > 0) {
    fail("projection_foreign_key_invalid", "Projection foreign keys are invalid");
  }
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") {
    fail("projection_integrity_invalid", "Projection database is not valid");
  }
}

export async function rebuildAppleMusicSqliteProjection({
  importsRoot,
  databasePath,
  boundaryRoot,
  subjectId,
}) {
  if (subjectId !== undefined && !isUuid(subjectId)) {
    throw new TypeError("Apple projection requires a valid subject UUID");
  }
  const resolvedDatabasePath = await preparePrivateDatabasePath(
    databasePath,
    boundaryRoot,
  );
  const batches = await listAppleMusicImportBatches(importsRoot, { subjectId });
  if (batches.length === 0) {
    fail("projection_input_missing", "No Apple import batch exists for the subject");
  }
  const records = await promoteAppleMusicImportBatches(batches, { subjectId });
  const temporaryPath = path.join(
    path.dirname(resolvedDatabasePath),
    `.${path.basename(resolvedDatabasePath)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );

  let database;
  let logicalDigest;
  try {
    const privateFile = await open(temporaryPath, "wx", 0o600);
    await privateFile.close();
    await chmod(temporaryPath, 0o600);
    const DatabaseSync = await databaseConstructor();
    database = new DatabaseSync(temporaryPath);
    database.exec("PRAGMA temp_store = MEMORY");
    database.exec(projectionSchema);
    database.exec("BEGIN IMMEDIATE");
    try {
      insertProjectionRecords(database, records);
      logicalDigest = computeAppleSqliteLogicalDigest(database);
      database
        .prepare("INSERT INTO projection_meta(key, value) VALUES (?, ?)")
        .run("projection.logical_digest", canonicalizeJson(logicalDigest));
      assertDatabaseIntegrity(database);
      database.exec("COMMIT");
      if (computeAppleSqliteLogicalDigest(database) !== logicalDigest) {
        fail("projection_digest_mismatch", "Projection logical digest is unstable");
      }
    } catch (cause) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original failure remains authoritative.
      }
      throw cause;
    }
    database.close();
    database = null;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, resolvedDatabasePath);
  } catch (cause) {
    try {
      database?.close();
    } catch {
      // Cleanup continues without replacing the original projection.
    }
    await removeTemporaryDatabase(temporaryPath);
    if (cause instanceof AppleMusicImportError) throw cause;
    fail("projection_rebuild_failed", "Apple projection rebuild failed", {
      cause,
    });
  }

  return {
    status: "rebuilt",
    logical_digest: logicalDigest,
    counts: records.counts,
    source_timestamp: records.inputs.at(-1).captured_at,
  };
}

function boundedLimit(value, fallback, hardLimit, field) {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > hardLimit) {
    throw new RangeError(`${field} must be between 1 and ${hardLimit}`);
  }
  return limit;
}

function boundedOffset(value, hardLimit, field) {
  const offset = value ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > hardLimit) {
    throw new RangeError(`${field} must be between 0 and ${hardLimit}`);
  }
  return offset;
}

function escapeLike(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function literalFtsQuery(query) {
  return query
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" AND ");
}

function usesLikeFallback(query) {
  return (
    Array.from(query).length < 3 ||
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
      query,
    )
  );
}

function normalizeSearchFilters(filters = {}) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    throw new TypeError("Library search filters must be an object");
  }
  const allowed = new Set([
    "genre",
    "loved",
    "favorited",
    "minimumPlayCount",
    "artists",
    "genres",
    "familiarity",
    "preferenceSignals",
  ]);
  if (Object.keys(filters).some((key) => !allowed.has(key))) {
    throw new TypeError("Library search contains an unsupported filter");
  }
  const normalized = {};
  if (filters.genre !== undefined) {
    if (typeof filters.genre !== "string" || filters.genre.trim() === "") {
      throw new TypeError("Library search genre filter must be non-empty text");
    }
    normalized.genre = normalizedText(filters.genre);
  }
  for (const field of ["loved", "favorited"]) {
    if (filters[field] !== undefined) {
      if (typeof filters[field] !== "boolean") {
        throw new TypeError(`Library search ${field} filter must be boolean`);
      }
      normalized[field] = Number(filters[field]);
    }
  }
  if (filters.minimumPlayCount !== undefined) {
    if (
      !Number.isSafeInteger(filters.minimumPlayCount) ||
      filters.minimumPlayCount < 1
    ) {
      throw new TypeError("minimumPlayCount must be a positive integer");
    }
    normalized.minimumPlayCount = filters.minimumPlayCount;
  }
  const normalizedArray = (field, allowedValues) => {
    const value = filters[field];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 4) {
      throw new TypeError(`Library search ${field} filter must be an array`);
    }
    const items = value.map((item) => {
      if (typeof item !== "string" || item.trim() === "") {
        throw new TypeError(`Library search ${field} filter must contain text`);
      }
      const itemValue = normalizedText(item);
      if (allowedValues && !allowedValues.has(itemValue)) {
        throw new TypeError(`Library search ${field} filter is invalid`);
      }
      return itemValue;
    });
    return [...new Set(items)];
  };
  normalized.artists = normalizedArray("artists");
  normalized.genres = normalizedArray("genres");
  normalized.familiarity = normalizedArray(
    "familiarity",
    new Set(["low", "medium", "high", "unknown"]),
  );
  normalized.preferenceSignals = normalizedArray(
    "preferenceSignals",
    new Set(["loved", "favorited", "rated"]),
  );
  return normalized;
}

function appendSearchFilters(where, parameters, filters) {
  if (filters.genre !== undefined) {
    where.push("s.genre_label_norm = ?");
    parameters.push(filters.genre);
  }
  if (filters.loved !== undefined) {
    where.push("s.loved = ?");
    parameters.push(filters.loved);
  }
  if (filters.favorited !== undefined) {
    where.push("s.favorited = ?");
    parameters.push(filters.favorited);
  }
  if (filters.minimumPlayCount !== undefined) {
    where.push("s.play_count >= ?");
    parameters.push(filters.minimumPlayCount);
  }
  if (filters.artists.length > 0) {
    where.push(
      `(${filters.artists
        .map(() => "s.artist_credit_norm LIKE ? ESCAPE '\\'")
        .join(" OR ")})`,
    );
    parameters.push(
      ...filters.artists.map((artist) => `%${escapeLike(artist)}%`),
    );
  }
  if (filters.genres.length > 0) {
    where.push(
      `(${filters.genres.map(() => "s.genre_label_norm = ?").join(" OR ")})`,
    );
    parameters.push(...filters.genres);
  }
  if (filters.familiarity.length > 0) {
    const clauses = filters.familiarity.map((level) => {
      switch (level) {
        case "low":
          return "(s.play_count IS NOT NULL AND s.play_count < 5)";
        case "medium":
          return "(s.play_count >= 5 AND s.play_count < 20)";
        case "high":
          return "s.play_count >= 20";
        case "unknown":
          return "s.play_count IS NULL";
        default:
          throw new TypeError("Library search familiarity filter is invalid");
      }
    });
    where.push(`(${clauses.join(" OR ")})`);
  }
  for (const signal of filters.preferenceSignals) {
    switch (signal) {
      case "loved":
        where.push("s.loved = 1");
        break;
      case "favorited":
        where.push("s.favorited = 1");
        break;
      case "rated":
        where.push(
          "s.rating_value >= 60 AND COALESCE(s.rating_computed, 0) = 0",
        );
        break;
      default:
        throw new TypeError("Library search preference filter is invalid");
    }
  }
}

function compactSearchResult(row) {
  const labels = {};
  if (row.genre_label) labels.provider_genre = row.genre_label;
  if (row.composer) labels.composer = row.composer;
  const observationSummary = {};
  if (row.play_count !== null) observationSummary.play_count = row.play_count;
  if (row.loved !== null) observationSummary.loved = Boolean(row.loved);
  if (row.favorited !== null) {
    observationSummary.favorited = Boolean(row.favorited);
  }
  if (row.rating_value !== null) {
    observationSummary.rating = {
      value: row.rating_value,
      ...(row.rating_computed === null
        ? {}
        : { computed: Boolean(row.rating_computed) }),
    };
  }
  return {
    track_ref: {
      track_ref_id: row.track_ref_id,
      revision: row.track_ref_revision,
    },
    title: row.title,
    artist_credit: row.artist_credit || null,
    release: row.release_title || null,
    duration_ms: row.duration_ms,
    labels,
    observation_summary: observationSummary,
  };
}

function readMeta(database, key) {
  const row = database
    .prepare("SELECT value FROM projection_meta WHERE key = ?")
    .get(key);
  if (!row) {
    fail("projection_metadata_missing", "Projection metadata is incomplete");
  }
  return JSON.parse(row.value);
}

class AppleMusicSqliteProjection {
  #database;
  #subjectId;
  #closed = false;

  constructor(database, subjectId) {
    this.#database = database;
    this.#subjectId = subjectId;
  }

  #assertOpen() {
    if (this.#closed) {
      throw new Error("Apple projection is closed");
    }
  }

  logicalDigest() {
    this.#assertOpen();
    return readMeta(this.#database, "projection.logical_digest");
  }

  searchLibrary({ query, limit, offset, filters } = {}) {
    this.#assertOpen();
    if (typeof query !== "string") {
      throw new TypeError("Library search query must be text");
    }
    const normalizedQuery = normalizedText(query);
    if (Array.from(normalizedQuery).length > 256) {
      throw new RangeError("Library search query is too long");
    }
    const bounded = boundedLimit(
      limit,
      10,
      APPLE_LIBRARY_SEARCH_HARD_LIMIT,
      "Library search limit",
    );
    const boundedSearchOffset = boundedOffset(
      offset,
      APPLE_LIBRARY_SEARCH_HARD_OFFSET,
      "Library search offset",
    );
    const normalizedFilters = normalizeSearchFilters(filters);
    const selectColumns = `
      s.track_ref_id, s.track_ref_revision, s.title, s.artist_credit,
      s.release_title, s.composer, s.genre_label, s.duration_ms,
      s.play_count, s.loved, s.favorited, s.rating_value, s.rating_computed
    `;
    let sql;
    let parameters;

    if (normalizedQuery === "") {
      const where = ["s.subject_id = ?"];
      parameters = [this.#subjectId];
      appendSearchFilters(where, parameters, normalizedFilters);
      sql = `
        SELECT ${selectColumns}
        FROM library_search s
        WHERE ${where.join(" AND ")}
        ORDER BY s.title_norm, s.artist_credit_norm, s.track_ref_id
        LIMIT ? OFFSET ?
      `;
      parameters.push(bounded, boundedSearchOffset);
    } else if (usesLikeFallback(normalizedQuery)) {
      const pattern = `%${escapeLike(normalizedQuery)}%`;
      const where = [
        "s.subject_id = ?",
        `(s.title_norm LIKE ? ESCAPE '\\'
          OR s.artist_credit_norm LIKE ? ESCAPE '\\'
          OR s.release_title_norm LIKE ? ESCAPE '\\'
          OR s.composer_norm LIKE ? ESCAPE '\\'
          OR s.genre_label_norm LIKE ? ESCAPE '\\')`,
      ];
      parameters = [
        this.#subjectId,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
      ];
      appendSearchFilters(where, parameters, normalizedFilters);
      sql = `
        SELECT ${selectColumns}
        FROM library_search s
        WHERE ${where.join(" AND ")}
        ORDER BY
          CASE
            WHEN s.title_norm = ? THEN 0
            WHEN s.artist_credit_norm = ? THEN 1
            ELSE 2
          END,
          s.title_norm,
          s.track_ref_id
        LIMIT ? OFFSET ?
      `;
      parameters.push(
        normalizedQuery,
        normalizedQuery,
        bounded,
        boundedSearchOffset,
      );
    } else {
      const where = ["library_fts MATCH ?", "s.subject_id = ?"];
      parameters = [literalFtsQuery(normalizedQuery), this.#subjectId];
      appendSearchFilters(where, parameters, normalizedFilters);
      sql = `
        SELECT ${selectColumns},
          bm25(library_fts, 8.0, 4.0, 2.0, 1.0, 1.0) AS lexical_rank
        FROM library_fts
        JOIN library_search s ON s.rowid = library_fts.rowid
        WHERE ${where.join(" AND ")}
        ORDER BY
          CASE
            WHEN s.title_norm = ? THEN 0
            WHEN s.artist_credit_norm = ? THEN 1
            ELSE 2
          END,
          lexical_rank,
          s.track_ref_id
        LIMIT ? OFFSET ?
      `;
      parameters.push(
        normalizedQuery,
        normalizedQuery,
        bounded,
        boundedSearchOffset,
      );
    }

    return {
      schema_version: "library-search-result/1",
      query: query.trim(),
      limit: bounded,
      offset: boundedSearchOffset,
      tracks: this.#database.prepare(sql).all(...parameters).map(compactSearchResult),
    };
  }

  getProfileSummary({ maxItems } = {}) {
    this.#assertOpen();
    const bounded = boundedLimit(
      maxItems,
      20,
      APPLE_PROFILE_SUMMARY_HARD_LIMIT,
      "Profile summary maxItems",
    );
    const items = this.#database
      .prepare(`
        WITH ranked AS (
          SELECT
            i.item_json,
            i.dimension,
            i.strength,
            i.evidence_id,
            s.artist_credit,
            s.genre_label,
            s.composer,
            s.play_count,
            s.loved,
            s.favorited,
            s.rating_value,
            s.rating_computed,
            ROW_NUMBER() OVER (
              PARTITION BY i.dimension
              ORDER BY i.strength DESC, i.evidence_id
            ) AS dimension_rank
          FROM profile_summary_items i
          JOIN profile_evidence e
            ON e.subject_id = i.subject_id AND e.evidence_id = i.evidence_id
          JOIN library_search s
            ON s.subject_id = e.subject_id AND s.track_ref_id = e.track_ref_id
          WHERE i.subject_id = ?
        )
        SELECT *
        FROM ranked
        WHERE dimension_rank <= ?
        ORDER BY
          CASE dimension
            WHEN 'taste.track_preference' THEN 0
            WHEN 'taste.track_familiarity' THEN 1
            ELSE 2
          END,
          strength DESC,
          evidence_id
      `)
      .all(this.#subjectId, bounded)
      .map((row) => {
        const item = JSON.parse(row.item_json);
        item.artist_credit = row.artist_credit || null;
        item.labels = {};
        if (row.genre_label) item.labels.provider_genre = row.genre_label;
        if (row.composer) item.labels.composer = row.composer;
        item.observation_summary = {};
        if (row.play_count !== null) {
          item.observation_summary.play_count = row.play_count;
        }
        if (row.loved !== null) {
          item.observation_summary.loved = Boolean(row.loved);
        }
        if (row.favorited !== null) {
          item.observation_summary.favorited = Boolean(row.favorited);
        }
        if (row.rating_value !== null) {
          item.observation_summary.rating = {
            value: row.rating_value,
            ...(row.rating_computed === null
              ? {}
              : { computed: Boolean(row.rating_computed) }),
          };
        }
        return item;
      });
    const counts = readMeta(this.#database, "projection.counts");
    const signalCoverage = this.#database
      .prepare(`
        SELECT
          SUM(CASE WHEN loved = 1 OR favorited = 1 THEN 1 ELSE 0 END)
            AS loved_or_favorited,
          SUM(CASE WHEN play_count IS NOT NULL THEN 1 ELSE 0 END)
            AS aggregate_play_count,
          SUM(
            CASE
              WHEN rating_value IS NOT NULL AND COALESCE(rating_computed, 0) = 0
                THEN 1
              ELSE 0
            END
          ) AS non_computed_rating
        FROM library_search
        WHERE subject_id = ?
      `)
      .get(this.#subjectId);
    return {
      schema_version: "profile-projection/0",
      preference: items.filter(
        (item) => item.dimension === "taste.track_preference",
      ),
      familiarity: items.filter(
        (item) => item.dimension === "taste.track_familiarity",
      ),
      coverage: {
        current_tracks: counts.current_tracks,
        observations: counts.observations,
        evidence_records: counts.profile_evidence,
        unresolved_identities: counts.unresolved_identities,
        loved_or_favorited: signalCoverage.loved_or_favorited,
        aggregate_play_count: signalCoverage.aggregate_play_count,
        non_computed_rating: signalCoverage.non_computed_rating,
        source_timestamp: readMeta(
          this.#database,
          "projection.source_timestamp",
        ),
      },
      limitations: [
        "Play Count supports familiarity, not liking.",
        "Loved, Favorited, and ratings are current provider snapshot states without action timestamps.",
        "Name-only artist and provider genre labels are not resolved entities.",
      ],
    };
  }

  explainProfileEvidence({ evidenceId } = {}) {
    this.#assertOpen();
    if (!isUuid(evidenceId)) {
      throw new TypeError("Profile evidence ID must be a UUID");
    }
    const row = this.#database
      .prepare(`
        SELECT e.record_json AS evidence_json, o.record_json AS observation_json
        FROM profile_evidence e
        JOIN observations o
          ON o.subject_id = e.subject_id
          AND o.observation_id = e.basis_observation_id
        WHERE e.subject_id = ? AND e.evidence_id = ?
      `)
      .get(this.#subjectId, evidenceId);
    if (!row) return null;
    const evidence = JSON.parse(row.evidence_json);
    const observation = JSON.parse(row.observation_json);
    const aggregate = observation.aggregate_state;
    const basisSummary = { observed_at: observation.observed_at };
    for (const field of ["play_count", "loved", "favorited", "rating"]) {
      if (aggregate[field] !== undefined) {
        basisSummary[field] = structuredClone(aggregate[field]);
      }
    }
    return {
      schema_version: "profile-evidence-explanation/1",
      evidence_id: evidence.profile_evidence_id,
      claim: evidence.claim,
      direction: evidence.direction,
      strength: evidence.strength,
      confidence: evidence.confidence,
      basis_summary: basisSummary,
      derivation: evidence.derivation,
      limitation:
        evidence.claim.dimension === "taste.track_familiarity"
          ? "This evidence supports familiarity, not liking."
          : "This evidence reflects current provider state, not a timestamped preference action or permanent preference.",
    };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}

export async function openAppleMusicSqliteProjection({
  databasePath,
  subjectId,
  expectedInputs,
  verifyDigest = true,
}) {
  if (!isUuid(subjectId)) {
    throw new TypeError("Apple projection requires a valid subject UUID");
  }
  const normalizedSubjectId = subjectId.toLowerCase();
  const metadata = await pathMetadata(databasePath);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    fail("projection_database_invalid", "Projection database file is invalid");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    fail("projection_permissions_invalid", "Projection database is not private");
  }

  let database;
  try {
    const DatabaseSync = await databaseConstructor();
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA temp_store = MEMORY");
    const userVersion = database.prepare("PRAGMA user_version").get().user_version;
    if (userVersion !== APPLE_SQLITE_PROJECTION_VERSION) {
      fail(
        "projection_schema_incompatible",
        "Projection schema is incompatible and must be rebuilt",
      );
    }
    assertDatabaseIntegrity(database);
    if (readMeta(database, "projection.subject_id") !== normalizedSubjectId) {
      fail("projection_subject_mismatch", "Projection belongs to another subject");
    }
    if (
      expectedInputs !== undefined &&
      canonicalizeJson(readMeta(database, "projection.inputs")) !==
        canonicalizeJson(expectedInputs)
    ) {
      fail(
        "projection_input_mismatch",
        "Projection inputs changed and must be rebuilt",
      );
    }
    if (
      verifyDigest &&
      readMeta(database, "projection.logical_digest") !==
        computeAppleSqliteLogicalDigest(database)
    ) {
      fail(
        "projection_digest_mismatch",
        "Projection logical digest does not match and must be rebuilt",
      );
    }
    return new AppleMusicSqliteProjection(database, normalizedSubjectId);
  } catch (cause) {
    try {
      database?.close();
    } catch {
      // The original validation failure remains authoritative.
    }
    if (cause instanceof AppleMusicImportError) throw cause;
    fail(
      "projection_database_invalid",
      "Projection database is invalid and must be rebuilt",
      { cause },
    );
  }
}
