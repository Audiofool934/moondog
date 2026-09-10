import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { isUuid, uuidV5 } from "../../core/uuid-v5.mjs";

export const LISTENBRAINZ_HISTORY_SOURCE = "listenbrainz.listen_history";
export const LISTENBRAINZ_HISTORY_FORMAT = "listenbrainz_listen_json_v1";
export const LISTENBRAINZ_HISTORY_SCOPE = "saved_listen_json_selection";
export const LISTENBRAINZ_MUSICBRAINZ_TRACK_NAMESPACE =
  "355c0040-e3f4-47df-b33b-7f573ddb5134";
export const LISTENBRAINZ_MSID_TRACK_NAMESPACE =
  "d8168717-9ed6-43e7-90ed-3288f28ab9db";
export const LISTENBRAINZ_LABEL_TRACK_NAMESPACE =
  "355d7588-b2c9-4b6e-86c6-d7858918a9a3";
export const LISTENBRAINZ_EVENT_NAMESPACE =
  "22d72263-f00c-4bca-bdc3-b5a14631b738";
export const LISTENBRAINZ_BATCH_NAMESPACE =
  "88e59cf7-fdaa-4a70-b6a1-f7ac469cc99d";

export const LISTENBRAINZ_HISTORY_LIMITS = Object.freeze({
  maximumFileBytes: 256 * 1024 * 1024,
  maximumRecords: 500_000,
  maximumDurationMs: 24 * 24 * 60 * 60 * 1_000,
});

const minimumListenedAt = 1_033_410_600;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class ListenBrainzHistoryError extends Error {
  constructor(message, code = "listenbrainz_history_invalid") {
    super(message);
    this.name = "ListenBrainzHistoryError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ListenBrainzHistoryError(message, code);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedTimestamp(value, label) {
  if (typeof value !== "string") fail(`${label} is invalid.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} is invalid.`);
  const normalized = new Date(milliseconds).toISOString();
  if (normalized !== value) fail(`${label} must be a normalized UTC timestamp.`);
  return normalized;
}

function cleanText(value, maximum, label, index) {
  if (typeof value !== "string") {
    fail(`ListenBrainz record ${index + 1} has an invalid ${label}.`);
  }
  const cleaned = value
    .normalize("NFC")
    .replace(unsafeTextPattern, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || Array.from(cleaned).length > maximum) {
    fail(`ListenBrainz record ${index + 1} has an invalid ${label}.`);
  }
  return cleaned;
}

function optionalText(value, maximum, label, index) {
  if (value === null || value === undefined) return null;
  return cleanText(value, maximum, label, index);
}

function normalizedIdentityText(value) {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function hashParts(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(part)).update("\0");
  return hash.digest("hex");
}

function clippedText(value, maximum = 512) {
  return Array.from(value).slice(0, maximum).join("");
}

function listenedAtTimestamp(value, capturedMilliseconds, index) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimumListenedAt ||
    value > Math.floor(capturedMilliseconds / 1_000)
  ) {
    fail(`ListenBrainz record ${index + 1} has an invalid listened_at.`);
  }
  return new Date(value * 1_000).toISOString();
}

function millisecondsValue(value, label, index) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > LISTENBRAINZ_HISTORY_LIMITS.maximumDurationMs
  ) {
    fail(`ListenBrainz record ${index + 1} has an invalid ${label}.`);
  }
  return value;
}

function secondsValue(value, label, index) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value * 1_000 > LISTENBRAINZ_HISTORY_LIMITS.maximumDurationMs
  ) {
    fail(`ListenBrainz record ${index + 1} has an invalid ${label}.`);
  }
  const milliseconds = Math.round(value * 1_000);
  if (!Number.isSafeInteger(milliseconds)) {
    fail(`ListenBrainz record ${index + 1} has an invalid ${label}.`);
  }
  return milliseconds;
}

function durationFields(value, index) {
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) {
    fail(`ListenBrainz record ${index + 1} has invalid additional_info.`);
  }
  const durationMs =
    value.duration_ms === undefined
      ? null
      : millisecondsValue(value.duration_ms, "duration_ms", index);
  const legacyDurationMs =
    value.duration === undefined
      ? null
      : secondsValue(value.duration, "duration", index);
  if (
    durationMs !== null &&
    legacyDurationMs !== null
  ) {
    fail(`ListenBrainz record ${index + 1} supplies both duration_ms and duration.`);
  }
  const playedMs =
    value.duration_played === undefined
      ? null
      : secondsValue(value.duration_played, "duration_played", index);
  return {
    ...(durationMs !== null || legacyDurationMs !== null
      ? { durationMs: durationMs ?? legacyDurationMs }
      : {}),
    ...(playedMs !== null ? { playedMs } : {}),
  };
}

function optionalUuid(value, label, index) {
  if (value === null || value === undefined) return null;
  if (!isUuid(value)) {
    fail(`ListenBrainz record ${index + 1} has an invalid ${label}.`);
  }
  return value.toLowerCase();
}

function serverRecordingMbid(value, index) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value) || !isUuid(value.recording_mbid)) {
    fail(`ListenBrainz record ${index + 1} has an invalid mbid_mapping.`);
  }
  return value.recording_mbid.toLowerCase();
}

function extractedListens(document) {
  if (!isPlainObject(document)) {
    fail("ListenBrainz JSON must be an official response or submission object.");
  }
  if (document.listen_type !== undefined) {
    if (
      Object.keys(document).some(
        (key) => key !== "listen_type" && key !== "payload",
      )
    ) {
      fail("ListenBrainz submission JSON has unsupported top-level fields.");
    }
    if (document.listen_type === "playing_now") {
      fail("ListenBrainz playing_now JSON is not persistent listening history.");
    }
    if (!new Set(["single", "import"]).has(document.listen_type)) {
      fail("ListenBrainz submission JSON has an unsupported listen_type.");
    }
    if (
      !Array.isArray(document.payload) ||
      document.payload.length < 1 ||
      (document.listen_type === "single" && document.payload.length !== 1)
    ) {
      fail("ListenBrainz submission JSON has an invalid payload.");
    }
    return { records: document.payload, allowServerMappings: false };
  }
  const payload = document.payload;
  if (isPlainObject(payload) && payload.playing_now === true) {
    fail("ListenBrainz playing_now JSON is not persistent listening history.");
  }
  if (
    !isPlainObject(payload) ||
    !Array.isArray(payload.listens) ||
    !Number.isSafeInteger(payload.count) ||
    payload.count < 0 ||
    payload.count !== payload.listens.length ||
    typeof payload.user_id !== "string" ||
    !payload.user_id.trim()
  ) {
    fail("ListenBrainz API response JSON has an invalid payload.");
  }
  return { records: payload.listens, allowServerMappings: true };
}

function normalizedRows(records, capturedAt, { allowServerMappings }) {
  if (!Array.isArray(records)) fail("ListenBrainz listen records are invalid.");
  if (records.length > LISTENBRAINZ_HISTORY_LIMITS.maximumRecords) {
    fail("ListenBrainz JSON contains too many records.");
  }
  const capturedMilliseconds = Date.parse(capturedAt);
  const rows = records.map((record, index) => {
    if (!isPlainObject(record) || !isPlainObject(record.track_metadata)) {
      fail(`ListenBrainz record ${index + 1} is invalid.`);
    }
    if (
      !allowServerMappings &&
      Object.keys(record).some(
        (key) => key !== "listened_at" && key !== "track_metadata",
      )
    ) {
      fail(
        `ListenBrainz submission record ${index + 1} has unsupported top-level fields.`,
      );
    }
    const metadata = record.track_metadata;
    if (!allowServerMappings && metadata.mbid_mapping !== undefined) {
      fail(
        `ListenBrainz record ${index + 1} includes read-only mbid_mapping in submission JSON.`,
      );
    }
    const title = cleanText(metadata.track_name, 512, "track_name", index);
    const artist = cleanText(metadata.artist_name, 512, "artist_name", index);
    const release = optionalText(
      metadata.release_name,
      512,
      "release_name",
      index,
    );
    const occurredAt = listenedAtTimestamp(
      record.listened_at,
      capturedMilliseconds,
      index,
    );
    const recordingMsid = optionalUuid(
      record.recording_msid,
      "recording_msid",
      index,
    );
    const recordingMbid = serverRecordingMbid(metadata.mbid_mapping, index);
    const durations = durationFields(metadata.additional_info, index);
    const labelFingerprint = hashParts(
      "listenbrainz-track-label-v1",
      normalizedIdentityText(artist),
      normalizedIdentityText(title),
      normalizedIdentityText(release ?? ""),
    );
    const identityKey = recordingMbid
      ? `musicbrainz:${recordingMbid}`
      : recordingMsid
        ? `listenbrainz-msid:${recordingMsid}`
        : `label:${labelFingerprint}`;
    const tuple = [
      occurredAt,
      identityKey,
      durations.playedMs === undefined ? "unknown" : durations.playedMs,
    ].join("\0");
    return {
      title,
      artist,
      release,
      occurredAt,
      recordingMsid,
      recordingMbid,
      labelFingerprint,
      identityKey,
      tuple,
      ...durations,
    };
  });
  return rows.sort((left, right) => lexicalCompare(left.tuple, right.tuple));
}

function trackIdentity(row) {
  if (row.recordingMbid) {
    return {
      trackRefId: uuidV5(
        row.recordingMbid,
        LISTENBRAINZ_MUSICBRAINZ_TRACK_NAMESPACE,
      ),
      identityStatus: "resolved",
      externalRefs: [
        {
          system: "musicbrainz",
          entity_type: "musicbrainz.recording",
          external_id: row.recordingMbid,
        },
        ...(row.recordingMsid
          ? [
              {
                system: "listenbrainz",
                entity_type: "listenbrainz.recording_msid",
                external_id: row.recordingMsid,
              },
            ]
          : []),
      ],
    };
  }
  if (row.recordingMsid) {
    return {
      trackRefId: uuidV5(
        row.recordingMsid,
        LISTENBRAINZ_MSID_TRACK_NAMESPACE,
      ),
      identityStatus: "provisional",
      externalRefs: [
        {
          system: "listenbrainz",
          entity_type: "listenbrainz.recording_msid",
          external_id: row.recordingMsid,
        },
      ],
    };
  }
  return {
    trackRefId: uuidV5(
      row.labelFingerprint,
      LISTENBRAINZ_LABEL_TRACK_NAMESPACE,
    ),
    identityStatus: "provisional",
    externalRefs: [
      {
        system: "listenbrainz-import",
        entity_type: "listenbrainz.track_label",
        external_id: row.labelFingerprint,
      },
    ],
  };
}

export function projectListenBrainzHistory({
  subjectId,
  document,
  fileSha256,
  fileSizeBytes,
  memberName,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (!isUuid(subjectId)) fail("A trusted subject ID is required.");
  const normalizedSubjectId = subjectId.toLowerCase();
  const normalizedCapturedAt = normalizedTimestamp(
    capturedAt,
    "ListenBrainz import timestamp",
  );
  if (typeof fileSha256 !== "string" || !sha256Pattern.test(fileSha256)) {
    fail("ListenBrainz file SHA-256 is invalid.");
  }
  if (
    !Number.isSafeInteger(fileSizeBytes) ||
    fileSizeBytes < 1 ||
    fileSizeBytes > LISTENBRAINZ_HISTORY_LIMITS.maximumFileBytes
  ) {
    fail("ListenBrainz JSON file size is invalid.");
  }
  if (
    typeof memberName !== "string" ||
    !memberName ||
    memberName.length > 255 ||
    path.basename(memberName) !== memberName ||
    /[\\\u0000-\u001f\u007f]/u.test(memberName) ||
    path.extname(memberName).toLowerCase() !== ".json"
  ) {
    fail("ListenBrainz JSON file name is invalid.");
  }
  const source = extractedListens(document);
  const rows = normalizedRows(source.records, normalizedCapturedAt, source);
  const importBatchId = uuidV5(
    `${normalizedSubjectId}\0${fileSha256}`,
    LISTENBRAINZ_BATCH_NAMESPACE,
  );
  const trackRefs = new Map();
  const listeningEvents = [];
  let previousTuple = null;
  let duplicateOrdinal = 0;

  for (const row of rows) {
    if (row.tuple === previousTuple) duplicateOrdinal += 1;
    else duplicateOrdinal = 1;
    previousTuple = row.tuple;

    const identity = trackIdentity(row);
    if (!trackRefs.has(identity.trackRefId)) {
      const trackRef = {
        schema_version: 1,
        track_ref_id: identity.trackRefId,
        revision: 1,
        identity_status: identity.identityStatus,
        display_label: clippedText(`${row.title} - ${row.artist}`),
        title: row.title,
        artist_credits: [{ name: row.artist, role: "unknown" }],
        external_refs: identity.externalRefs,
        created_at: row.occurredAt,
        ...(identity.identityStatus === "resolved"
          ? { resolved_at: row.occurredAt }
          : {}),
        ...(row.release ? { release: { title: row.release } } : {}),
        ...(row.durationMs !== undefined
          ? { duration_ms: row.durationMs }
          : {}),
      };
      trackRefs.set(identity.trackRefId, trackRef);
    }

    const eventFingerprint = hashParts(
      "listenbrainz-listen-v1",
      normalizedSubjectId,
      row.tuple,
      duplicateOrdinal,
    );
    listeningEvents.push({
      schema_version: 1,
      listening_event_id: uuidV5(
        eventFingerprint,
        LISTENBRAINZ_EVENT_NAMESPACE,
      ),
      subject_id: normalizedSubjectId,
      track_ref_id: identity.trackRefId,
      track_ref_revision: 1,
      event_type: "play_observed",
      occurred_at: row.occurredAt,
      ingested_at: normalizedCapturedAt,
      interaction_mode: "unknown",
      ...(row.playedMs !== undefined ? { played_ms: row.playedMs } : {}),
      context: { context_type: "unknown" },
      provenance: {
        source_kind: "import",
        captured_at: normalizedCapturedAt,
        external_ref: {
          system: "listenbrainz",
          entity_type: "listenbrainz.listen",
          external_id: eventFingerprint,
        },
        import_batch_id: importBatchId,
      },
      deduplication_key: eventFingerprint,
    });
  }

  const earliestOccurredAt = rows[0]?.occurredAt ?? null;
  const latestOccurredAt = rows.at(-1)?.occurredAt ?? null;
  return {
    source_key: LISTENBRAINZ_HISTORY_SOURCE,
    captured_at: normalizedCapturedAt,
    cursor_after_ms:
      latestOccurredAt === null ? null : Date.parse(latestOccurredAt),
    track_refs: [...trackRefs.values()],
    listening_events: listeningEvents,
    import_batch: {
      import_batch_id: importBatchId,
      subject_id: normalizedSubjectId,
      source_format: LISTENBRAINZ_HISTORY_FORMAT,
      data_scope: LISTENBRAINZ_HISTORY_SCOPE,
      archive_sha256: fileSha256,
      archive_size_bytes: fileSizeBytes,
      member_names: [memberName],
      input_records: rows.length,
      earliest_occurred_at: earliestOccurredAt,
      latest_occurred_at: latestOccurredAt,
      imported_at: normalizedCapturedAt,
    },
  };
}

export async function readListenBrainzHistoryFile({
  filePath,
  subjectId,
  capturedAt = new Date().toISOString(),
} = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    fail("A ListenBrainz history JSON path is required.");
  }
  const resolvedPath = path.resolve(filePath);
  if (path.extname(resolvedPath).toLowerCase() !== ".json") {
    fail("ListenBrainz history must be supplied as a JSON file.");
  }
  let handle;
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail(
      "The ListenBrainz history JSON could not be opened safely.",
      "listenbrainz_history_unreadable",
    );
  }
  let bytes;
  try {
    const file = await handle.stat();
    if (
      !file.isFile() ||
      file.size < 1 ||
      file.size > LISTENBRAINZ_HISTORY_LIMITS.maximumFileBytes
    ) {
      fail("The ListenBrainz history JSON is not a supported regular file.");
    }
    bytes = await handle.readFile();
    if (
      bytes.length < 1 ||
      bytes.length > LISTENBRAINZ_HISTORY_LIMITS.maximumFileBytes
    ) {
      fail("The ListenBrainz history JSON is not a supported regular file.");
    }
  } finally {
    await handle.close();
  }

  let jsonText;
  try {
    jsonText = utf8Decoder.decode(bytes).replace(/^\uFEFF/u, "");
  } catch {
    fail("The ListenBrainz history file is not valid UTF-8 JSON.");
  }
  let document;
  try {
    document = JSON.parse(jsonText);
  } catch {
    fail("The ListenBrainz history file is invalid JSON.");
  }
  return projectListenBrainzHistory({
    subjectId,
    document,
    fileSha256: createHash("sha256").update(bytes).digest("hex"),
    fileSizeBytes: bytes.length,
    memberName: path.basename(resolvedPath),
    capturedAt,
  });
}
