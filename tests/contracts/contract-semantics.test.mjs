import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  canonicalizeJson,
  contractRecordKey,
  findUnsafePersistedData,
  validateLibraryTrackObservationSemantics,
  validateListeningEventSemantics,
  validateProfileEvidenceSemantics,
  validateTasteEventSemantics,
  validateTrackRefSemantics,
} from "../../scripts/contract-semantics.mjs";
import { fixtureDirectory } from "../../scripts/contract-lib.mjs";

async function readFixture(fileName, schemaVersion = 1) {
  return JSON.parse(
    await readFile(
      path.join(
        schemaVersion === 1
          ? fixtureDirectory
          : path.resolve(fixtureDirectory, "..", `v${schemaVersion}`),
        fileName,
      ),
      "utf8",
    ),
  );
}

const tasteEvent = await readFixture("taste-event.valid.json");
const listeningEvent = await readFixture("listening-event.valid.json");
const trackRef = await readFixture("track-ref.valid.json");
const libraryTrackObservation = await readFixture(
  "library-track-observation.valid.json",
);
const profileEvidence = await readFixture(
  "profile-evidence--direct.valid.json",
  2,
);
const observationProfileEvidence = await readFixture(
  "profile-evidence--observation.valid.json",
  2,
);

function codes(result) {
  return new Set(result.issues.map((item) => item.code));
}

test("canonical JSON ignores object key insertion order", () => {
  assert.equal(
    canonicalizeJson({ zebra: 1, alpha: { two: 2, one: 1 } }),
    canonicalizeJson({ alpha: { one: 1, two: 2 }, zebra: 1 }),
  );
});

test("nested credential material is rejected without echoing its value", () => {
  const unsafe = findUnsafePersistedData({
    arguments: { auth: { access_token: "synthetic-secret-value" } },
  });
  assert.equal(
    unsafe.some((item) => item.code === "secret.forbidden_field"),
    true,
  );
  assert.equal(JSON.stringify(unsafe).includes("synthetic-secret-value"), false);
});

test("secret scanner rejects credential URLs and permits token_count", () => {
  const unsafe = findUnsafePersistedData({
    callback: "https://example.invalid/callback?access_token=synthetic",
  });
  assert.equal(unsafe.some((item) => item.code === "secret.url_query"), true);
  assert.deepEqual(findUnsafePersistedData({ token_count: 123 }), []);
});

test("secret scanner rejects sensitive namespaced extension keys", () => {
  const unsafe = findUnsafePersistedData({
    extensions: {
      "provider.access_token": "synthetic-secret",
      "provider.client_secret": "synthetic-secret",
    },
  });
  assert.equal(
    unsafe.filter((item) => item.code === "secret.forbidden_field").length,
    2,
  );
});

test("canonical JSON rejects non-JSON values", () => {
  assert.throws(() => canonicalizeJson({ missing: undefined }), /JSON-compatible/);
});

test("TrackRef semantics reject a merge into self", () => {
  const mutated = structuredClone(trackRef);
  mutated.identity_status = "merged";
  mutated.merged_into = {
    track_ref_id: mutated.track_ref_id,
    revision: mutated.revision,
  };
  assert.equal(
    codes(validateTrackRefSemantics(mutated)).has("track.merge_cycle"),
    true,
  );
});

test("ListeningEvent semantics reject reverse ingestion time", () => {
  const mutated = structuredClone(listeningEvent);
  mutated.ingested_at = "2026-08-23T09:00:00Z";
  assert.equal(
    codes(validateListeningEventSemantics(mutated)).has("listening.time_order"),
    true,
  );
});

test("TasteEvent semantics enforce rating scale order and bounds", () => {
  const mutated = structuredClone(tasteEvent);
  mutated.rating = { value: 8, scale_min: 5, scale_max: 3 };
  assert.equal(
    codes(validateTasteEventSemantics(mutated)).has("taste.rating_range"),
    true,
  );
});

function profileRecords(taste = tasteEvent) {
  return new Map([
    [
      contractRecordKey("listening_event", listeningEvent.listening_event_id),
      structuredClone(listeningEvent),
    ],
    [
      contractRecordKey("taste_event", taste.taste_event_id),
      structuredClone(taste),
    ],
  ]);
}

function observationProfileRecords(observation = libraryTrackObservation) {
  return new Map([
    [
      contractRecordKey(
        "library_track_observation",
        observation.library_track_observation_id,
      ),
      structuredClone(observation),
    ],
  ]);
}

test("valid LibraryTrackObservation binds capture provenance and TrackRef", () => {
  const result = validateLibraryTrackObservationSemantics(
    structuredClone(libraryTrackObservation),
    { trackRef },
  );
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("LibraryTrackObservation rejects a mismatched source batch", () => {
  const mutated = structuredClone(libraryTrackObservation);
  mutated.provenance.import_batch_id = "99999999-9999-4999-8999-999999999999";
  const result = validateLibraryTrackObservationSemantics(mutated);
  assert.equal(codes(result).has("observation.provenance_mismatch"), true);
});

test("ProfileEvidence v2 accepts rule evidence from an observation", () => {
  const result = validateProfileEvidenceSemantics({
    evidence: structuredClone(observationProfileEvidence),
    records: observationProfileRecords(),
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("ProfileEvidence v2 never treats an observation as direct evidence", () => {
  const mutated = structuredClone(observationProfileEvidence);
  mutated.derivation.kind = "direct";
  delete mutated.derivation.parameters_digest;
  const result = validateProfileEvidenceSemantics({
    evidence: mutated,
    records: observationProfileRecords(),
  });
  assert.equal(
    codes(result).has("evidence.observation_derivation_invalid"),
    true,
  );
  assert.equal(codes(result).has("evidence.direct_basis_type"), true);
});

test("valid direct ProfileEvidence binds the explicit asserted target", () => {
  const result = validateProfileEvidenceSemantics({
    evidence: structuredClone(profileEvidence),
    records: profileRecords(),
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("direct ProfileEvidence rejects a different target revision", () => {
  const mutated = structuredClone(profileEvidence);
  mutated.claim.value.entity_ref.entity_revision = 2;
  const result = validateProfileEvidenceSemantics({
    evidence: mutated,
    records: profileRecords(),
  });
  assert.equal(codes(result).has("evidence.direct_target_mismatch"), true);
});

test("ProfileEvidence rejects a cross-subject basis", () => {
  const mutatedTaste = structuredClone(tasteEvent);
  mutatedTaste.subject_id = "abababab-abab-4bab-8bab-abababababab";
  const result = validateProfileEvidenceSemantics({
    evidence: structuredClone(profileEvidence),
    records: profileRecords(mutatedTaste),
  });
  assert.equal(codes(result).has("evidence.subject_mismatch"), true);
});

test("ProfileEvidence rejects an assertion retracted before creation", () => {
  const records = profileRecords();
  const retraction = {
    taste_event_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    subject_id: tasteEvent.subject_id,
    operation: "retract",
    retracts_taste_event_id: tasteEvent.taste_event_id,
    occurred_at: "2026-08-23T09:20:30Z",
    recorded_at: "2026-08-23T09:20:31Z",
  };
  records.set(
    contractRecordKey("taste_event", retraction.taste_event_id),
    retraction,
  );
  const result = validateProfileEvidenceSemantics({
    evidence: structuredClone(profileEvidence),
    records,
  });
  assert.equal(codes(result).has("evidence.taste_retracted"), true);
});
