import { randomUUID } from "node:crypto";

import { isUuid, uuidV5 } from "../core/uuid-v5.mjs";

export const LISTENER_CORRECTION_SCHEMA_VERSION = 1;
export const LISTENER_CORRECTION_ENTITY_NAMESPACE =
  "6bcb265e-ce6d-5ab9-8471-7d6b40c95ba6";
export const LISTENER_CORRECTION_ENTITY_TYPES = Object.freeze([
  "artist",
  "track",
]);
export const LISTENER_CORRECTION_STANCES = Object.freeze([
  "like",
  "avoid",
]);

function cleanText(value, label, maximum = 512) {
  if (typeof value !== "string") throw new TypeError(`${label} is required`);
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || Array.from(cleaned).length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return cleaned;
}

function optionalNote(value) {
  if (value === undefined || value === null) return null;
  return cleanText(value, "Listener correction note", 2_000);
}

function timestamp(value, label) {
  const milliseconds = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(milliseconds)) {
    throw new TypeError(`${label} is invalid`);
  }
  return new Date(milliseconds).toISOString();
}

function normalizedIdentity(value) {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function correctionTarget({ entityType, label, artistCredit }) {
  if (!LISTENER_CORRECTION_ENTITY_TYPES.includes(entityType)) {
    throw new TypeError(
      `Listener correction entity type must be one of: ${LISTENER_CORRECTION_ENTITY_TYPES.join(", ")}`,
    );
  }
  const cleanedLabel = cleanText(label, "Listener correction label");
  const cleanedArtist = entityType === "track"
    ? cleanText(artistCredit, "Listener correction track artist")
    : null;
  const identity = [
    entityType,
    normalizedIdentity(cleanedLabel),
    ...(cleanedArtist ? [normalizedIdentity(cleanedArtist)] : []),
  ].join("\0");
  const entityId = uuidV5(identity, LISTENER_CORRECTION_ENTITY_NAMESPACE);
  return {
    target: {
      entity_type: entityType,
      entity_id: entityId,
      entity_revision: 1,
      label: cleanedLabel,
    },
    targetKey: `${entityType}:${entityId}`,
    artistCredit: cleanedArtist,
  };
}

function eventId(value, label) {
  const id = value ?? randomUUID();
  if (!isUuid(id)) throw new TypeError(`${label} is invalid`);
  return id.toLowerCase();
}

export function createListenerCorrection({
  subjectId,
  entityType,
  label,
  artistCredit,
  stance,
  note,
  occurredAt,
  recordedAt = occurredAt,
  supersedesCorrectionId,
  correctionId,
} = {}) {
  if (!isUuid(subjectId)) {
    throw new TypeError("Listener correction subject is invalid");
  }
  if (!LISTENER_CORRECTION_STANCES.includes(stance)) {
    throw new TypeError(
      `Listener correction stance must be one of: ${LISTENER_CORRECTION_STANCES.join(", ")}`,
    );
  }
  const occurred = timestamp(occurredAt, "Listener correction occurrence time");
  const recorded = timestamp(recordedAt, "Listener correction recording time");
  if (occurred > recorded) {
    throw new TypeError("Listener correction cannot be recorded before it occurred");
  }
  const correctionTargetValue = correctionTarget({
    entityType,
    label,
    artistCredit,
  });
  const supersedes = supersedesCorrectionId === undefined
    ? null
    : eventId(supersedesCorrectionId, "Superseded listener correction ID");
  const cleanedNote = optionalNote(note);
  const id = eventId(correctionId, "Listener correction ID");
  if (supersedes === id) {
    throw new TypeError("A listener correction cannot supersede itself");
  }
  const record = {
    schema_version: LISTENER_CORRECTION_SCHEMA_VERSION,
    taste_event_id: id,
    subject_id: subjectId.toLowerCase(),
    operation: "assert",
    occurred_at: occurred,
    recorded_at: recorded,
    target: correctionTargetValue.target,
    signal_type: stance === "like" ? "preference" : "avoidance",
    polarity: stance === "like" ? "positive" : "negative",
    strength: 1,
    explicitness: "explicit",
    provenance: {
      source_kind: "user_input",
      captured_at: recorded,
    },
    extensions: {
      "moondog.correction_scope": "label_scoped",
      ...(correctionTargetValue.artistCredit
        ? { "moondog.artist_credit": correctionTargetValue.artistCredit }
        : {}),
    },
    ...(cleanedNote ? { note: cleanedNote } : {}),
    ...(supersedes ? { supersedes_taste_event_id: supersedes } : {}),
  };
  return {
    record,
    targetKey: correctionTargetValue.targetKey,
    stance,
  };
}

export function createListenerCorrectionRetraction({
  subjectId,
  retractsCorrectionId,
  occurredAt,
  recordedAt = occurredAt,
  correctionId,
} = {}) {
  if (!isUuid(subjectId)) {
    throw new TypeError("Listener correction subject is invalid");
  }
  const occurred = timestamp(
    occurredAt,
    "Listener correction retraction occurrence time",
  );
  const recorded = timestamp(
    recordedAt,
    "Listener correction retraction recording time",
  );
  if (occurred > recorded) {
    throw new TypeError(
      "Listener correction retraction cannot be recorded before it occurred",
    );
  }
  const id = eventId(correctionId, "Listener correction retraction ID");
  const retracts = eventId(
    retractsCorrectionId,
    "Retracted listener correction ID",
  );
  if (id === retracts) {
    throw new TypeError("A listener correction cannot retract itself");
  }
  return {
    schema_version: LISTENER_CORRECTION_SCHEMA_VERSION,
    taste_event_id: id,
    subject_id: subjectId.toLowerCase(),
    operation: "retract",
    occurred_at: occurred,
    recorded_at: recorded,
    retracts_taste_event_id: retracts,
    provenance: {
      source_kind: "user_input",
      captured_at: recorded,
    },
  };
}

export function listenerCorrectionTargetKey(record) {
  if (
    !record ||
    record.operation !== "assert" ||
    !LISTENER_CORRECTION_ENTITY_TYPES.includes(record.target?.entity_type) ||
    typeof record.target?.label !== "string"
  ) {
    throw new TypeError("Listener correction target is invalid");
  }
  if (!isUuid(record.target.entity_id)) {
    throw new TypeError("Listener correction target ID is invalid");
  }
  const artistCredit = record.extensions?.["moondog.artist_credit"];
  if (record.target.entity_type === "track") {
    cleanText(
      artistCredit,
      "Listener correction track artist",
    );
  }
  return `${record.target.entity_type}:${record.target.entity_id.toLowerCase()}`;
}
