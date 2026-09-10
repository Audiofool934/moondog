import {
  contractRecordKey,
  canonicalizeJson,
  sha256Hex,
  validateLibraryTrackObservationSemantics,
  validateProfileEvidenceSemantics,
  validateTrackRefSemantics,
} from "../../../scripts/contract-semantics.mjs";
import {
  contractSchemaId,
  createContractValidator,
  formatValidationErrors,
} from "../../../scripts/contract-lib.mjs";
import { validateAppleMusicImportRecords } from "./normalize.mjs";
import { AppleMusicImportError } from "./parse-plist.mjs";
import {
  APPLE_LIBRARY_CANONICAL_TRACK_NAMESPACE,
  APPLE_LIBRARY_OBSERVATION_NAMESPACE,
  APPLE_LIBRARY_PROFILE_EVIDENCE_NAMESPACE,
  isUuid,
  uuidV5,
} from "./stable-ids.mjs";

export const APPLE_PROFILE_RULES_VERSION = "apple-profile-rules/1";
export const APPLE_PROFILE_RULES = Object.freeze({
  curation: {
    one_positive_state_strength: 0.8,
    multiple_positive_states_strength: 0.9,
    confidence: 0.85,
  },
  rating: {
    positive_minimum: 60,
    negative_maximum: 40,
    confidence: 0.9,
  },
  familiarity: {
    moderate_minimum: 5,
    strong_minimum: 20,
    strengths: {
      low: 0.35,
      moderate: 0.6,
      strong: 0.85,
    },
    confidence: 0.9,
  },
});

let validatorsPromise;

async function validators() {
  validatorsPromise ??= createContractValidator().then(({ ajv }) => ({
    observation: ajv.getSchema(contractSchemaId("library-track-observation", 1)),
    profileEvidence: ajv.getSchema(contractSchemaId("profile-evidence", 2)),
    trackRef: ajv.getSchema(contractSchemaId("track-ref", 1)),
  }));
  return validatorsPromise;
}

function fail(code, message) {
  throw new AppleMusicImportError(code, message);
}

function compareCanonical(left, right) {
  const leftValue = canonicalizeJson(left);
  const rightValue = canonicalizeJson(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTrackMetadata(trackRef) {
  return Object.fromEntries(
    Object.entries({
      identity_status: trackRef.identity_status,
      display_label: trackRef.display_label,
      title: trackRef.title,
      artist_credits: trackRef.artist_credits,
      release: trackRef.release,
      duration_ms: trackRef.duration_ms,
      isrc: trackRef.isrc,
      external_refs: trackRef.external_refs,
      extensions: trackRef.extensions,
    }).filter(([, value]) => value !== undefined),
  );
}

function externalAnchorKey(subjectId, externalRef) {
  return canonicalizeJson({
    subject_id: subjectId,
    system: externalRef.system,
    entity_type: externalRef.entity_type,
    external_id: externalRef.external_id,
  });
}

function canonicalTrackId(subjectId, externalRef) {
  return uuidV5(
    canonicalizeJson({
      kind: "moondog.exact_external_track_anchor",
      version: 1,
      subject_id: subjectId,
      system: externalRef.system,
      entity_type: externalRef.entity_type,
      external_id: externalRef.external_id,
    }),
    APPLE_LIBRARY_CANONICAL_TRACK_NAMESPACE,
  );
}

function sourceRecordDigest(trackRef, snapshot) {
  return sha256Hex({
    kind: "moondog.apple_music_library.normalized_source_record",
    version: 1,
    track_ref_candidate: trackRef,
    aggregate_snapshot: snapshot,
  });
}

function observationId(observationIdentity) {
  return uuidV5(
    canonicalizeJson({
      kind: "moondog.library_track_observation",
      version: 1,
      ...observationIdentity,
    }),
    APPLE_LIBRARY_OBSERVATION_NAMESPACE,
  );
}

function profileRuleParametersDigest(ruleName) {
  return sha256Hex({
    kind: "moondog.profile_rule_parameters",
    version: 1,
    rule_name: ruleName,
    rules_version: APPLE_PROFILE_RULES_VERSION,
    rules: APPLE_PROFILE_RULES,
  });
}

function evidenceId(evidence) {
  return uuidV5(
    canonicalizeJson({
      kind: "moondog.profile_evidence_identity",
      version: 2,
      subject_id: evidence.subject_id,
      basis_refs: [...evidence.basis_refs].sort(compareCanonical),
      claim: evidence.claim,
      direction: evidence.direction,
      strength: evidence.strength,
      confidence: evidence.confidence,
      derivation: {
        kind: evidence.derivation.kind,
        name: evidence.derivation.name,
        version: evidence.derivation.version,
        parameters_digest: evidence.derivation.parameters_digest,
      },
    }),
    APPLE_LIBRARY_PROFILE_EVIDENCE_NAMESPACE,
  );
}

function entityClaim(trackRef, dimension) {
  return {
    dimension,
    value: {
      value_type: "entity",
      entity_ref: {
        entity_type: "track",
        entity_id: trackRef.track_ref_id,
        entity_revision: trackRef.revision,
        label: trackRef.display_label,
      },
    },
  };
}

function makeEvidence({
  observation,
  trackRef,
  dimension,
  direction,
  strength,
  confidence,
  ruleName,
}) {
  const record = {
    schema_version: 2,
    profile_evidence_id: "00000000-0000-4000-8000-000000000000",
    subject_id: observation.subject_id,
    claim: entityClaim(trackRef, dimension),
    direction,
    strength,
    confidence,
    basis_refs: [
      {
        record_type: "library_track_observation",
        record_id: observation.library_track_observation_id,
      },
    ],
    derivation: {
      kind: "rule",
      name: ruleName,
      version: APPLE_PROFILE_RULES_VERSION,
      parameters_digest: profileRuleParametersDigest(ruleName),
    },
    evidence_window: {
      start_at: observation.observed_at,
      end_at: observation.observed_at,
    },
    created_at: observation.observed_at,
  };
  record.profile_evidence_id = evidenceId(record);
  return record;
}

function familiarityStrength(playCount) {
  if (playCount >= APPLE_PROFILE_RULES.familiarity.strong_minimum) {
    return APPLE_PROFILE_RULES.familiarity.strengths.strong;
  }
  if (playCount >= APPLE_PROFILE_RULES.familiarity.moderate_minimum) {
    return APPLE_PROFILE_RULES.familiarity.strengths.moderate;
  }
  return APPLE_PROFILE_RULES.familiarity.strengths.low;
}

function evidenceForObservation(observation, trackRef) {
  const records = [];
  const positiveCurationStates = [
    observation.aggregate_state.loved,
    observation.aggregate_state.favorited,
  ].filter((value) => value === true).length;
  if (positiveCurationStates > 0) {
    records.push(
      makeEvidence({
        observation,
        trackRef,
        dimension: "taste.track_preference",
        direction: "supports",
        strength:
          positiveCurationStates > 1
            ? APPLE_PROFILE_RULES.curation.multiple_positive_states_strength
            : APPLE_PROFILE_RULES.curation.one_positive_state_strength,
        confidence: APPLE_PROFILE_RULES.curation.confidence,
        ruleName: "provider-curation-track-preference",
      }),
    );
  }

  const rating = observation.aggregate_state.rating;
  if (rating && rating.computed !== true) {
    let direction;
    if (rating.value >= APPLE_PROFILE_RULES.rating.positive_minimum) {
      direction = "supports";
    } else if (rating.value <= APPLE_PROFILE_RULES.rating.negative_maximum) {
      direction = "contradicts";
    }
    if (direction) {
      records.push(
        makeEvidence({
          observation,
          trackRef,
          dimension: "taste.track_preference",
          direction,
          strength: Math.abs(rating.value - 50) / 50,
          confidence: APPLE_PROFILE_RULES.rating.confidence,
          ruleName: "provider-rating-track-preference",
        }),
      );
    }
  }

  const playCount = observation.aggregate_state.play_count;
  if (Number.isSafeInteger(playCount) && playCount > 0) {
    records.push(
      makeEvidence({
        observation,
        trackRef,
        dimension: "taste.track_familiarity",
        direction: "supports",
        strength: familiarityStrength(playCount),
        confidence: APPLE_PROFILE_RULES.familiarity.confidence,
        ruleName: "aggregate-play-count-track-familiarity",
      }),
    );
  }
  return records;
}

function normalizeLibraryState(snapshot) {
  const libraryState = structuredClone(snapshot.library_state);
  if (libraryState.apple_music !== undefined) {
    libraryState.subscription_catalog_item = libraryState.apple_music;
    delete libraryState.apple_music;
  }
  return libraryState;
}

function assertValidRecord(record, validate, label) {
  if (!validate(record)) {
    fail(
      "projection_schema_invalid",
      `${label} failed validation: ${formatValidationErrors(validate.errors)}`,
    );
  }
}

export function computeAppleProjectionInputDigest(batch) {
  return sha256Hex({
    kind: "moondog.apple_projection_input",
    version: 1,
    manifest: batch.manifest,
    track_refs: batch.trackRefs,
    track_snapshots: batch.trackSnapshots,
    warnings: batch.warnings,
  });
}

export async function promoteAppleMusicImportBatches(
  inputBatches,
  { subjectId } = {},
) {
  if (!Array.isArray(inputBatches) || inputBatches.length === 0) {
    fail("projection_input_missing", "Apple projection requires an import batch");
  }
  if (subjectId !== undefined && !isUuid(subjectId)) {
    throw new TypeError("Apple projection requires a valid subject UUID");
  }
  const sortedBatches = [...inputBatches].sort((left, right) => {
    const capturedOrder = compareText(
      left.manifest.source.captured_at,
      right.manifest.source.captured_at,
    );
    if (capturedOrder !== 0) return capturedOrder;
    return compareText(
      left.manifest.import_batch_id,
      right.manifest.import_batch_id,
    );
  });
  const normalizedSubjectId = (
    subjectId ?? sortedBatches[0].manifest.subject_id
  ).toLowerCase();
  const seenBatchIds = new Map();
  const batches = [];
  for (const batch of sortedBatches) {
    await validateAppleMusicImportRecords(batch);
    if (batch.manifest.subject_id !== normalizedSubjectId) {
      fail("projection_subject_mismatch", "Apple projection cannot cross subjects");
    }
    const inputDigest = computeAppleProjectionInputDigest(batch);
    const priorDigest = seenBatchIds.get(batch.manifest.import_batch_id);
    if (priorDigest && priorDigest !== inputDigest) {
      fail("projection_batch_conflict", "Apple projection batch identity conflicts");
    }
    if (priorDigest) continue;
    seenBatchIds.set(batch.manifest.import_batch_id, inputDigest);
    batches.push(batch);
  }

  const { observation: validateObservation, profileEvidence: validateEvidence, trackRef: validateTrackRef } =
    await validators();
  const anchorStates = new Map();
  const trackStateById = new Map();
  const trackRefs = [];
  const observationsById = new Map();
  const currentTrackIds = new Set();
  const currentObservationByTrack = new Map();
  const latestBatchId = batches.at(-1).manifest.import_batch_id;
  let unresolvedIdentityCount = 0;

  for (const batch of batches) {
    const snapshotByCandidateId = new Map(
      batch.trackSnapshots.map((snapshot) => [snapshot.track_ref_id, snapshot]),
    );
    const fallbackSourceKeys = new Set(
      batch.warnings
        .filter((warning) => warning.code === "identity_fallback_unstable")
        .map((warning) => warning.source_record_key_sha256),
    );
    unresolvedIdentityCount += fallbackSourceKeys.size;

    for (const candidate of batch.trackRefs) {
      const snapshot = snapshotByCandidateId.get(candidate.track_ref_id);
      const externalRef = candidate.external_refs[0];
      const anchorKey = externalAnchorKey(normalizedSubjectId, externalRef);
      let state = anchorStates.get(anchorKey);
      if (!state) {
        state = {
          trackRefId: canonicalTrackId(normalizedSubjectId, externalRef),
          revision: 0,
          metadataDigest: null,
          currentTrackRef: null,
        };
        anchorStates.set(anchorKey, state);
        trackStateById.set(state.trackRefId, state);
      }

      const metadata = canonicalTrackMetadata(candidate);
      const metadataDigest = sha256Hex({
        kind: "moondog.track_ref_metadata",
        version: 1,
        metadata,
      });
      if (metadataDigest !== state.metadataDigest) {
        const revision = state.revision + 1;
        const canonicalTrackRef = {
          schema_version: 1,
          track_ref_id: state.trackRefId,
          revision,
          ...structuredClone(metadata),
          created_at: batch.manifest.source.captured_at,
        };
        if (revision > 1) {
          canonicalTrackRef.supersedes = {
            track_ref_id: state.trackRefId,
            revision: revision - 1,
          };
        }
        assertValidRecord(canonicalTrackRef, validateTrackRef, "TrackRef");
        if (!validateTrackRefSemantics(canonicalTrackRef).ok) {
          fail("projection_semantics_invalid", "TrackRef semantics are invalid");
        }
        trackRefs.push(canonicalTrackRef);
        state.revision = revision;
        state.metadataDigest = metadataDigest;
        state.currentTrackRef = canonicalTrackRef;
      }

      const digest = sourceRecordDigest(candidate, snapshot);
      const identity = {
        subject_id: normalizedSubjectId,
        source_batch_ref: batch.manifest.import_batch_id,
        source_record_digest: digest,
        track_ref_id: state.trackRefId,
        track_ref_revision: state.revision,
        observed_at: snapshot.captured_at,
      };
      const observation = {
        schema_version: 1,
        library_track_observation_id: observationId(identity),
        ...identity,
        source_kind: "provider_library_snapshot",
        aggregate_state: structuredClone(snapshot.aggregate_state),
        library_state: normalizeLibraryState(snapshot),
        provenance: {
          source_kind: "import",
          captured_at: snapshot.captured_at,
          import_batch_id: batch.manifest.import_batch_id,
        },
      };
      assertValidRecord(
        observation,
        validateObservation,
        "LibraryTrackObservation",
      );
      const observationSemantics = validateLibraryTrackObservationSemantics(
        observation,
        { trackRef: state.currentTrackRef },
      );
      if (!observationSemantics.ok) {
        fail(
          "projection_semantics_invalid",
          "LibraryTrackObservation semantics are invalid",
        );
      }
      const priorObservation = observationsById.get(
        observation.library_track_observation_id,
      );
      if (
        priorObservation &&
        canonicalizeJson(priorObservation) !== canonicalizeJson(observation)
      ) {
        fail("projection_observation_conflict", "Observation identity conflicts");
      }
      observationsById.set(observation.library_track_observation_id, observation);

      if (batch.manifest.import_batch_id === latestBatchId) {
        currentTrackIds.add(state.trackRefId);
        currentObservationByTrack.set(state.trackRefId, observation);
      }
    }
  }

  const currentTrackRefs = [...currentTrackIds]
    .map((trackRefId) => trackStateById.get(trackRefId).currentTrackRef)
    .sort((left, right) => compareText(left.track_ref_id, right.track_ref_id));
  const trackRefById = new Map(
    currentTrackRefs.map((trackRef) => [trackRef.track_ref_id, trackRef]),
  );
  const profileEvidence = [];
  const evidenceRecords = new Map(
    [...observationsById.values()].map((observation) => [
      contractRecordKey(
        "library_track_observation",
        observation.library_track_observation_id,
      ),
      observation,
    ]),
  );
  for (const [trackRefId, observation] of currentObservationByTrack) {
    for (const evidence of evidenceForObservation(
      observation,
      trackRefById.get(trackRefId),
    )) {
      assertValidRecord(evidence, validateEvidence, "ProfileEvidence");
      const semanticResult = validateProfileEvidenceSemantics({
        evidence,
        records: evidenceRecords,
      });
      if (!semanticResult.ok) {
        fail("projection_semantics_invalid", "ProfileEvidence semantics are invalid");
      }
      profileEvidence.push(evidence);
      evidenceRecords.set(
        contractRecordKey("profile_evidence", evidence.profile_evidence_id),
        evidence,
      );
    }
  }

  trackRefs.sort((left, right) => {
    const idOrder = compareText(left.track_ref_id, right.track_ref_id);
    return idOrder !== 0 ? idOrder : left.revision - right.revision;
  });
  const observations = [...observationsById.values()].sort((left, right) =>
    compareText(
      left.library_track_observation_id,
      right.library_track_observation_id,
    ),
  );
  profileEvidence.sort((left, right) =>
    compareText(left.profile_evidence_id, right.profile_evidence_id),
  );

  return {
    schema_version: "apple-projection-records/1",
    subject_id: normalizedSubjectId,
    inputs: batches.map((batch) => ({
      import_batch_id: batch.manifest.import_batch_id,
      captured_at: batch.manifest.source.captured_at,
      digest: computeAppleProjectionInputDigest(batch),
    })),
    trackRefs,
    currentTrackRefs,
    observations,
    profileEvidence,
    counts: {
      current_tracks: currentTrackRefs.length,
      observations: observations.length,
      profile_evidence: profileEvidence.length,
      listening_events: 0,
      taste_events: 0,
      unresolved_identities: unresolvedIdentityCount,
    },
  };
}
