import { createHash } from "node:crypto";

const sensitiveKeyNames = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientassertion",
  "clientsecret",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "passwd",
  "privatekey",
  "providertoken",
  "rawproviderpayload",
  "refreshtoken",
  "sessiontoken",
  "setcookie",
]);
const sensitiveUrlParameterNames = new Set([
  ...sensitiveKeyNames,
  "code",
  "key",
  "secret",
  "signature",
  "token",
]);

function issue(code, path, message) {
  return { code, path, message };
}

function normalizeKey(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isSensitiveKeyName(value, sensitiveNames = sensitiveKeyNames) {
  const candidates = [
    normalizeKey(value),
    ...value.split(/[.:/\\-]+/).map((segment) => normalizeKey(segment)),
  ];
  return candidates.some((candidate) =>
    [...sensitiveNames].some(
      (sensitiveName) =>
        candidate === sensitiveName || candidate.endsWith(sensitiveName),
    ),
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalizeJson(value) {
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain a non-finite number");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }

  if (!isPlainObject(value)) {
    throw new TypeError("Canonical JSON accepts only JSON-compatible values");
  }

  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`,
    )
    .join(",")}}`;
}

export function sha256Hex(value) {
  const source = typeof value === "string" ? value : canonicalizeJson(value);
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function inspectUrl(value, path, issues) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return;
  }

  if (new Set(["data:", "javascript:", "file:"]).has(parsed.protocol)) {
    issues.push(
      issue(
        "secret.unsafe_uri_scheme",
        path,
        "Persisted contract records must not contain unsafe URI schemes.",
      ),
    );
  }

  if (parsed.username || parsed.password) {
    issues.push(
      issue(
        "secret.url_userinfo",
        path,
        "Persisted URLs must not contain credentials in userinfo.",
      ),
    );
  }

  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveKeyName(key, sensitiveUrlParameterNames)) {
      issues.push(
        issue(
          "secret.url_query",
          path,
          "Persisted URLs must not contain credential query parameters.",
        ),
      );
      break;
    }
  }

  for (const key of parsed.hash.replace(/^#/, "").split(/[&;]/)) {
    const [name] = key.split("=", 1);
    if (isSensitiveKeyName(name, sensitiveUrlParameterNames)) {
      issues.push(
        issue(
          "secret.url_fragment",
          path,
          "Persisted URLs must not contain credential fragments.",
        ),
      );
      break;
    }
  }
}

export function findUnsafePersistedData(
  value,
  path = "$",
  { maxDepth = 64, maxNodes = 10_000, maxBytes = 1_000_000 } = {},
) {
  const issues = [];
  let nodeCount = 0;
  let limitReported = false;

  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
      issues.push(
        issue(
          "record.byte_limit",
          path,
          "The persisted record exceeds the semantic inspection byte limit.",
        ),
      );
    }
  } catch {
    issues.push(
      issue(
        "record.not_json",
        path,
        "The persisted record must be finite JSON data.",
      ),
    );
  }

  function visit(current, currentPath, depth) {
    nodeCount += 1;
    if (depth > maxDepth || nodeCount > maxNodes) {
      if (!limitReported) {
        issues.push(
          issue(
            "record.inspection_limit",
            currentPath,
            "The persisted record exceeds semantic inspection limits.",
          ),
        );
        limitReported = true;
      }
      return;
    }
    if (typeof current === "string") {
      if (/^(?:basic|bearer)\s+[a-z0-9._~+\/-]+=*$/i.test(current)) {
        issues.push(
          issue(
            "secret.authorization_value",
            currentPath,
            "Persisted values must not contain authorization material.",
          ),
        );
      }
      if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(current)) {
        issues.push(
          issue(
            "secret.private_key_value",
            currentPath,
            "Persisted values must not contain private keys.",
          ),
        );
      }
      inspectUrl(current, currentPath, issues);
      return;
    }

    if (Array.isArray(current)) {
      current.forEach((item, index) =>
        visit(item, `${currentPath}/${index}`, depth + 1),
      );
      return;
    }

    if (!isPlainObject(current)) return;

    for (const [key, child] of Object.entries(current)) {
      const childPath = `${currentPath}/${key}`;
      if (isSensitiveKeyName(key)) {
        issues.push(
          issue(
            "secret.forbidden_field",
            childPath,
            "Persisted contract records must not contain credential fields or raw provider payloads.",
          ),
        );
      }
      visit(child, childPath, depth + 1);
    }
  }

  visit(value, path, 0);
  return issues;
}

function canonicalEqual(left, right) {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function validateTrackRefSemantics(trackRef) {
  const issues = [];
  const createdAt = parseTimestamp(trackRef.created_at);
  const resolvedAt = parseTimestamp(trackRef.resolved_at);

  if (resolvedAt !== null && createdAt !== null && resolvedAt < createdAt) {
    issues.push(
      issue(
        "track.resolution_time_order",
        "/resolved_at",
        "Track resolution cannot predate record creation.",
      ),
    );
  }
  if (trackRef.revision === 1 && trackRef.supersedes) {
    issues.push(
      issue(
        "track.initial_supersedes",
        "/supersedes",
        "An initial TrackRef revision cannot supersede another revision.",
      ),
    );
  }
  if (trackRef.revision > 1) {
    if (
      trackRef.supersedes?.track_ref_id !== trackRef.track_ref_id ||
      trackRef.supersedes?.revision !== trackRef.revision - 1
    ) {
      issues.push(
        issue(
          "track.supersedes_mismatch",
          "/supersedes",
          "A TrackRef revision must supersede the immediately preceding revision of the same identity.",
        ),
      );
    }
  }
  if (trackRef.merged_into?.track_ref_id === trackRef.track_ref_id) {
    issues.push(
      issue(
        "track.merge_cycle",
        "/merged_into",
        "A TrackRef cannot merge into itself.",
      ),
    );
  }
  if (trackRef.candidate_track_ref_ids?.includes(trackRef.track_ref_id)) {
    issues.push(
      issue(
        "track.ambiguous_self_candidate",
        "/candidate_track_ref_ids",
        "An ambiguous TrackRef cannot list itself as a candidate.",
      ),
    );
  }

  return { ok: issues.length === 0, issues };
}

export function validateListeningEventSemantics(listeningEvent) {
  const issues = [];
  const occurredAt = parseTimestamp(listeningEvent.occurred_at);
  const ingestedAt = parseTimestamp(listeningEvent.ingested_at);
  if (occurredAt !== null && ingestedAt !== null && occurredAt > ingestedAt) {
    issues.push(
      issue(
        "listening.time_order",
        "/ingested_at",
        "A listening event cannot be ingested before it occurred.",
      ),
    );
  }
  return { ok: issues.length === 0, issues };
}

export function validateTasteEventSemantics(tasteEvent) {
  const issues = [];
  const occurredAt = parseTimestamp(tasteEvent.occurred_at);
  const recordedAt = parseTimestamp(tasteEvent.recorded_at);
  if (occurredAt !== null && recordedAt !== null && occurredAt > recordedAt) {
    issues.push(
      issue(
        "taste.time_order",
        "/recorded_at",
        "A taste event cannot be recorded before it occurred.",
      ),
    );
  }

  if (tasteEvent.signal_type === "rating") {
    const { value, scale_min: scaleMin, scale_max: scaleMax } =
      tasteEvent.rating ?? {};
    if (
      typeof value !== "number" ||
      typeof scaleMin !== "number" ||
      typeof scaleMax !== "number" ||
      scaleMin >= scaleMax ||
      value < scaleMin ||
      value > scaleMax
    ) {
      issues.push(
        issue(
          "taste.rating_range",
          "/rating",
          "A rating value must fall within a strictly increasing scale.",
        ),
      );
    }
  }
  if (
    tasteEvent.operation === "retract" &&
    tasteEvent.retracts_taste_event_id === tasteEvent.taste_event_id
  ) {
    issues.push(
      issue(
        "taste.self_retraction",
        "/retracts_taste_event_id",
        "A taste event cannot retract itself.",
      ),
    );
  }

  return { ok: issues.length === 0, issues };
}

export function contractRecordKey(recordType, recordId) {
  return `${recordType}:${recordId}`;
}

function recordFromCollection(records, recordType, recordId) {
  const key = contractRecordKey(recordType, recordId);
  if (records instanceof Map) return records.get(key);
  return records?.[key];
}

function recordsFromCollection(records) {
  if (records instanceof Map) return [...records.values()];
  return Object.values(records ?? {});
}

function recordIdForType(record, recordType) {
  if (recordType === "library_track_observation") {
    return record.library_track_observation_id;
  }
  if (recordType === "listening_event") return record.listening_event_id;
  if (recordType === "taste_event") return record.taste_event_id;
  return undefined;
}

function basisTimestamp(record, recordType) {
  if (recordType === "library_track_observation") {
    return parseTimestamp(record.observed_at);
  }
  return parseTimestamp(record.occurred_at);
}

export function validateLibraryTrackObservationSemantics(
  observation,
  { trackRef } = {},
) {
  const issues = [];
  if (!isPlainObject(observation)) {
    return {
      ok: false,
      issues: [
        issue(
          "observation.record_invalid",
          "/",
          "LibraryTrackObservation semantics require an object.",
        ),
      ],
    };
  }

  if (
    observation.provenance?.source_kind !== "import" ||
    observation.source_batch_ref !== observation.provenance?.import_batch_id
  ) {
    issues.push(
      issue(
        "observation.provenance_mismatch",
        "/provenance",
        "A library observation must bind its exact import batch.",
      ),
    );
  }
  if (observation.observed_at !== observation.provenance?.captured_at) {
    issues.push(
      issue(
        "observation.capture_time_mismatch",
        "/observed_at",
        "Observation and provenance capture timestamps must match.",
      ),
    );
  }

  const observedAt = parseTimestamp(observation.observed_at);
  for (const [field, value] of [
    ["last_played_at", observation.aggregate_state?.last_played_at],
    ["last_skipped_at", observation.aggregate_state?.last_skipped_at],
    ["date_added", observation.library_state?.date_added],
    ["date_modified", observation.library_state?.date_modified],
  ]) {
    const stateTimestamp = parseTimestamp(value);
    if (
      observedAt !== null &&
      stateTimestamp !== null &&
      stateTimestamp > observedAt
    ) {
      issues.push(
        issue(
          "observation.state_after_capture",
          field.startsWith("date_")
            ? `/library_state/${field}`
            : `/aggregate_state/${field}`,
          "Observed provider state cannot be later than its snapshot capture.",
        ),
      );
    }
  }

  if (
    trackRef &&
    (trackRef.track_ref_id !== observation.track_ref_id ||
      trackRef.revision !== observation.track_ref_revision)
  ) {
    issues.push(
      issue(
        "observation.track_ref_mismatch",
        "/track_ref_id",
        "A library observation must bind the exact TrackRef revision supplied by the registry.",
      ),
    );
  }

  return { ok: issues.length === 0, issues };
}

function entityIdentity(entityRef) {
  const identity = {};
  for (const field of [
    "entity_type",
    "entity_id",
    "entity_revision",
    "entity_key",
  ]) {
    if (entityRef?.[field] !== undefined) identity[field] = entityRef[field];
  }
  return identity;
}

export function validateProfileEvidenceSemantics({ evidence, records }) {
  const issues = [];
  const resolvedBasis = [];

  for (const basisRef of evidence.basis_refs ?? []) {
    const record = recordFromCollection(
      records,
      basisRef.record_type,
      basisRef.record_id,
    );
    if (!record) {
      issues.push(
        issue(
          "evidence.basis_missing",
          "/basis_refs",
          "A referenced evidence record does not exist.",
        ),
      );
      continue;
    }
    if (recordIdForType(record, basisRef.record_type) !== basisRef.record_id) {
      issues.push(
        issue(
          "evidence.basis_identity_mismatch",
          "/basis_refs",
          "A referenced evidence record has a different identity.",
        ),
      );
    }
    if (record.subject_id !== evidence.subject_id) {
      issues.push(
        issue(
          "evidence.subject_mismatch",
          "/basis_refs",
          "Evidence cannot cross subject boundaries.",
        ),
      );
    }
    resolvedBasis.push({ basisRef, record });
  }

  const windowStart = parseTimestamp(evidence.evidence_window?.start_at);
  const windowEnd = parseTimestamp(evidence.evidence_window?.end_at);
  const createdAt = parseTimestamp(evidence.created_at);
  if (evidence.evidence_window && windowStart > windowEnd) {
    issues.push(
      issue(
        "evidence.window_order",
        "/evidence_window/end_at",
        "The evidence window end must follow its start.",
      ),
    );
  }
  if (
    evidence.evidence_window &&
    createdAt !== null &&
    windowEnd !== null &&
    windowEnd > createdAt
  ) {
    issues.push(
      issue(
        "evidence.window_after_creation",
        "/evidence_window/end_at",
        "The evidence window cannot extend past record creation.",
      ),
    );
  }
  for (const { basisRef, record } of resolvedBasis) {
    const occurredAt = basisTimestamp(record, basisRef.record_type);
    if (evidence.evidence_window) {
      if (
        occurredAt !== null &&
        (occurredAt < windowStart || occurredAt > windowEnd)
      ) {
        issues.push(
          issue(
            "evidence.basis_outside_window",
            "/basis_refs",
            "A referenced record falls outside the declared evidence window.",
          ),
        );
      }
    }
    if (occurredAt !== null && createdAt !== null && occurredAt > createdAt) {
      issues.push(
        issue(
          "evidence.basis_after_creation",
          "/basis_refs",
          "A profile claim cannot depend on a future record.",
        ),
      );
    }
  }

  const retractedTasteIds = new Set(
    recordsFromCollection(records)
      .filter(
        (record) =>
          record?.operation === "retract" &&
          record.subject_id === evidence.subject_id &&
          (createdAt === null ||
            parseTimestamp(record.recorded_at ?? record.occurred_at) <= createdAt),
      )
      .map((record) => record.retracts_taste_event_id)
      .filter(Boolean),
  );
  for (const { basisRef, record } of resolvedBasis) {
    if (
      basisRef.record_type === "taste_event" &&
      (record.operation !== "assert" ||
        retractedTasteIds.has(record.taste_event_id))
    ) {
      issues.push(
        issue(
          "evidence.taste_retracted",
          "/basis_refs",
          "A retracted taste assertion cannot support profile evidence.",
        ),
      );
    }
  }

  if (evidence.derivation?.kind === "direct") {
    if (resolvedBasis.length !== 1) {
      issues.push(
        issue(
          "evidence.direct_basis_count",
          "/basis_refs",
          "Direct evidence must bind exactly one record.",
        ),
      );
    } else {
      const [{ basisRef, record }] = resolvedBasis;
      if (basisRef.record_type !== "taste_event" || record.operation !== "assert") {
        issues.push(
          issue(
            "evidence.direct_basis_type",
            "/basis_refs",
            "Direct profile evidence must bind one explicit taste assertion.",
          ),
        );
      }
      if (
        evidence.claim?.value?.value_type !== "entity" ||
        !canonicalEqual(
          entityIdentity(evidence.claim?.value?.entity_ref),
          entityIdentity(record.target),
        )
      ) {
        issues.push(
          issue(
            "evidence.direct_target_mismatch",
            "/claim/value/entity_ref",
            "A direct entity claim must match the exact asserted target revision.",
          ),
        );
      }
    }
  }

  if (
    resolvedBasis.some(
      ({ basisRef }) =>
        basisRef.record_type === "library_track_observation",
    ) &&
    !new Set(["rule", "aggregate"]).has(evidence.derivation?.kind)
  ) {
    issues.push(
      issue(
        "evidence.observation_derivation_invalid",
        "/derivation/kind",
        "Observation-derived evidence must use a rule or aggregate derivation.",
      ),
    );
  }

  if (
    new Set(["rule", "aggregate", "model"]).has(evidence.derivation?.kind) &&
    !evidence.derivation?.parameters_digest
  ) {
    issues.push(
      issue(
        "evidence.parameters_digest_missing",
        "/derivation/parameters_digest",
        "Non-direct derivations must bind their parameters.",
      ),
    );
  }

  const expiresAt = parseTimestamp(evidence.expires_at);
  if (expiresAt !== null && createdAt !== null && expiresAt <= createdAt) {
    issues.push(
      issue(
        "evidence.expiry_order",
        "/expires_at",
        "Profile evidence expiry must follow its creation time.",
      ),
    );
  }

  if (evidence.supersedes_profile_evidence_id) {
    const superseded = recordFromCollection(
      records,
      "profile_evidence",
      evidence.supersedes_profile_evidence_id,
    );
    if (!superseded || superseded.subject_id !== evidence.subject_id) {
      issues.push(
        issue(
          "evidence.superseded_record_invalid",
          "/supersedes_profile_evidence_id",
          "Superseded profile evidence must exist for the same subject.",
        ),
      );
    }
  }

  return { ok: issues.length === 0, issues };
}
