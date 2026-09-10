import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  canonicalizeJson,
  computeConfirmationScopeDigest,
  computeIdempotencyKeyDigest,
  computeInvocationSemanticDigest,
  contractRecordKey,
  findUnsafePersistedData,
  validateLibraryTrackObservationSemantics,
  validateListeningEventSemantics,
  validateCapabilityDescriptor,
  validateProfileEvidenceSemantics,
  validateTasteEventSemantics,
  validateToolInvocationSemantics,
  validateToolReceiptSemantics,
  validateTrackRefSemantics,
} from "../../scripts/contract-semantics.mjs";
import {
  currentContractVersion,
  migrateContractRecord,
} from "../../scripts/contract-migrations.mjs";
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

const invocation = await readFixture("tool-invocation.valid.json");
const policy = await readFixture("capability-policy.valid.json");
const receipt = await readFixture("tool-receipt.valid.json");
const profileEvidence = await readFixture("profile-evidence.valid.json");
const tasteEvent = await readFixture("taste-event.valid.json");
const listeningEvent = await readFixture("listening-event.valid.json");
const trackRef = await readFixture("track-ref.valid.json");
const libraryTrackObservation = await readFixture(
  "library-track-observation.valid.json",
);
const observationProfileEvidence = await readFixture(
  "profile-evidence--observation.valid.json",
  2,
);

const capability = {
  registry_version: "1",
  capability_id: "playlist.write",
  capability_version: 1,
  tool_ref: {
    tool_id: "playlist.curator",
    contract_version: 1,
  },
  effects: ["write_external", "use_credentials"],
  risk_levels: {
    privacy: "medium",
    account: "medium",
    copyright: "none",
    spend: "none",
  },
  allowed_execution_modes: ["dry_run", "execute"],
};

function trustedHooks(overrides = {}) {
  return {
    validateArguments: async ({ arguments: toolArguments }) => ({
      ok:
        typeof toolArguments.playlist_name === "string" &&
        Array.isArray(toolArguments.track_ref_ids),
    }),
    inspectIntent: async ({ invocation: inspectedInvocation }) => ({
      ok: true,
      intent: {
        account_ref: structuredClone(inspectedInvocation.account_ref),
        target: structuredClone(inspectedInvocation.target),
        data_manifest: structuredClone(inspectedInvocation.data_manifest),
        budget_request: structuredClone(inspectedInvocation.budget_request),
      },
    }),
    verifyRightsBasis: async ({ rights_basis_refs: rightsBasisRefs }) => ({
      valid: rightsBasisRefs.includes("rights.user_authorization"),
    }),
    verifyConfirmation: async (context) => ({
      valid:
        context.grant_ref === invocation.confirmation_grant_ref &&
        context.confirmation_scope_digest === receipt.confirmation.scope_digest,
    }),
    ...overrides,
  };
}

async function evaluateInvocation(candidate, overrides = {}) {
  return validateToolInvocationSemantics({
    invocation: candidate,
    policy,
    capability,
    now: "2026-08-23T09:26:00Z",
    ...trustedHooks(),
    ...overrides,
  });
}

function codes(result) {
  return new Set(result.issues.map((item) => item.code));
}

test("canonical JSON ignores object key insertion order", () => {
  assert.equal(
    canonicalizeJson({ zebra: 1, alpha: { two: 2, one: 1 } }),
    canonicalizeJson({ alpha: { one: 1, two: 2 }, zebra: 1 }),
  );
});

test("invocation digest normalizes contract set fields but preserves intent", () => {
  const reordered = structuredClone(invocation);
  reordered.declared_effects.reverse();
  reordered.declared_risk_flags.reverse();
  reordered.data_manifest.data_classes.reverse();
  reordered.rights_basis_refs.reverse();

  assert.equal(
    computeInvocationSemanticDigest(reordered),
    computeInvocationSemanticDigest(invocation),
  );
  assert.equal(computeInvocationSemanticDigest(invocation), invocation.semantic_digest);
});

test("confirmation grant reference is outside the semantic digest cycle", () => {
  const mutated = structuredClone(invocation);
  mutated.confirmation_grant_ref = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  assert.equal(
    computeInvocationSemanticDigest(mutated),
    computeInvocationSemanticDigest(invocation),
  );
});

test("valid invocation passes the reference semantic gate", async () => {
  const result = await evaluateInvocation(structuredClone(invocation));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("the reference gate fails closed without trusted hooks", async () => {
  const result = await validateToolInvocationSemantics({
    invocation: structuredClone(invocation),
    policy,
    capability,
    now: "2026-08-23T09:26:00Z",
  });
  const resultCodes = codes(result);
  assert.equal(result.ok, false);
  assert.equal(resultCodes.has("arguments.validator_missing"), true);
  assert.equal(resultCodes.has("intent.inspector_missing"), true);
  assert.equal(resultCodes.has("rights.verifier_missing"), true);
  assert.equal(resultCodes.has("confirmation.verifier_missing"), true);
});

test("public tool gates reject non-object records without throwing", async () => {
  const invocationResult = await validateToolInvocationSemantics({
    invocation: null,
    policy,
    capability,
  });
  assert.equal(codes(invocationResult).has("record.invocation_invalid"), true);

  const missingReceipt = validateToolReceiptSemantics({
    receipt: null,
    invocation,
    capability,
  });
  assert.equal(
    codes(missingReceipt).has("record.receipt_context_invalid"),
    true,
  );

  const missingInvocation = validateToolReceiptSemantics({
    receipt,
    invocation: null,
    capability,
  });
  assert.equal(
    codes(missingInvocation).has("record.receipt_context_invalid"),
    true,
  );
});

test("public tool gates reject incomplete objects without throwing", async () => {
  const invocationResult = await validateToolInvocationSemantics({
    invocation: {},
    policy,
    capability,
  });
  assert.equal(codes(invocationResult).has("record.invocation_invalid"), true);

  const receiptResult = validateToolReceiptSemantics({
    receipt,
    invocation: {},
    capability,
  });
  assert.equal(
    codes(receiptResult).has("record.receipt_context_invalid"),
    true,
  );
});

test("trusted descriptor validation rejects malformed field types", async () => {
  for (const malformed of [
    { ...structuredClone(capability), effects: 42 },
    { ...structuredClone(capability), allowed_execution_modes: 42 },
    { ...structuredClone(capability), risk_levels: "malformed" },
    {},
  ]) {
    const descriptorResult = validateCapabilityDescriptor(malformed);
    assert.equal(descriptorResult.ok, false);
    const gateResult = await validateToolInvocationSemantics({
      invocation: structuredClone(invocation),
      policy,
      capability: malformed,
      now: "2026-08-23T09:26:00Z",
      ...trustedHooks(),
    });
    assert.equal(gateResult.ok, false);
  }
});

test("caller cannot omit a trusted capability effect", async () => {
  const mutated = structuredClone(invocation);
  mutated.declared_effects = ["write_external"];
  mutated.semantic_digest = computeInvocationSemanticDigest(mutated);
  const result = await evaluateInvocation(mutated);
  assert.equal(codes(result).has("registry.effects_mismatch"), true);
});

test("changing invocation arguments without rebinding the digest is rejected", async () => {
  const mutated = structuredClone(invocation);
  mutated.arguments.playlist_name = "Different playlist";
  const result = await evaluateInvocation(mutated);
  assert.equal(codes(result).has("digest.mismatch"), true);
});

test("trusted intent inspection must match declared data movement", async () => {
  const result = await evaluateInvocation(structuredClone(invocation), {
    inspectIntent: async () => ({
      ok: true,
      intent: {
        account_ref: structuredClone(invocation.account_ref),
        target: structuredClone(invocation.target),
        data_manifest: {
          ...structuredClone(invocation.data_manifest),
          raw_data_included: true,
        },
        budget_request: [],
      },
    }),
  });
  assert.equal(codes(result).has("intent.mismatch"), true);
});

test("policy authorization binds a stable purpose identifier", async () => {
  const mutated = structuredClone(invocation);
  mutated.purpose_id = "purpose.unrelated_action";
  mutated.semantic_digest = computeInvocationSemanticDigest(mutated);
  const result = await evaluateInvocation(mutated);
  assert.equal(codes(result).has("privacy.purpose_denied"), true);
});

test("policy authorization binds each destination purpose identifier", async () => {
  const mutated = structuredClone(invocation);
  mutated.data_manifest.planned_destinations[0].purpose_id =
    "purpose.unrelated_egress";
  mutated.semantic_digest = computeInvocationSemanticDigest(mutated);
  const result = await evaluateInvocation(mutated);
  assert.equal(codes(result).has("privacy.destination_denied"), true);
});

test("a forged confirmation UUID is independently rejected", async () => {
  const mutated = structuredClone(invocation);
  mutated.confirmation_grant_ref = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const result = await evaluateInvocation(mutated);
  assert.equal(codes(result).has("confirmation.invalid"), true);
});

test("verification hooks reject conflicting success signals", async () => {
  const rightsResult = await evaluateInvocation(structuredClone(invocation), {
    verifyRightsBasis: async () => ({ ok: true, valid: false }),
  });
  assert.equal(codes(rightsResult).has("rights.invalid"), true);

  const confirmationResult = await evaluateInvocation(
    structuredClone(invocation),
    {
      verifyConfirmation: async () => ({ ok: true, valid: false }),
    },
  );
  assert.equal(codes(confirmationResult).has("confirmation.invalid"), true);
});

test("operation hooks reject an explicit invalid result", async () => {
  const result = await evaluateInvocation(structuredClone(invocation), {
    validateArguments: async () => ({ ok: true, valid: false }),
  });
  assert.equal(codes(result).has("arguments.invalid"), true);
});

test("hook mutations are isolated from the canonical invocation", async () => {
  const candidate = structuredClone(invocation);
  const originalName = candidate.arguments.playlist_name;
  const result = await evaluateInvocation(candidate, {
    validateArguments: async ({
      arguments: toolArguments,
      invocation: hookInvocation,
      capability: hookCapability,
    }) => {
      toolArguments.playlist_name = "MUTATED HOOK COPY";
      hookInvocation.purpose_id = "purpose.mutated_hook_copy";
      hookCapability.effects = ["delete"];
      return { ok: true };
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(candidate.arguments.playlist_name, originalName);
  assert.equal(
    result.computed_digest,
    computeInvocationSemanticDigest(candidate),
  );
});

test("concurrent caller mutation makes invocation validation fail closed", async () => {
  const candidate = structuredClone(invocation);
  const result = await evaluateInvocation(candidate, {
    validateArguments: async () => {
      candidate.arguments.playlist_name = "MUTATED CALLER OBJECT";
      return { ok: true };
    },
  });
  assert.equal(codes(result).has("record.context_mutated"), true);
});

test("an always-confirm policy requires a grant for local writes", async () => {
  const localInvocation = structuredClone(invocation);
  localInvocation.declared_effects = ["write_local"];
  localInvocation.declared_risk_flags = ["privacy"];
  delete localInvocation.account_ref;
  delete localInvocation.confirmation_grant_ref;
  localInvocation.semantic_digest =
    computeInvocationSemanticDigest(localInvocation);

  const localCapability = {
    ...structuredClone(capability),
    effects: ["write_local"],
    risk_levels: {
      privacy: "medium",
      account: "none",
      copyright: "none",
      spend: "none",
    },
  };
  const localPolicy = structuredClone(policy);
  localPolicy.allowed_effects = ["write_local"];
  localPolicy.idempotency.required_for = ["write_local"];

  const result = await validateToolInvocationSemantics({
    invocation: localInvocation,
    policy: localPolicy,
    capability: localCapability,
    now: "2026-08-23T09:26:00Z",
    ...trustedHooks({ verifyConfirmation: async () => true }),
  });
  assert.equal(codes(result).has("confirmation.reference_missing"), true);
});

test("nested credential material is rejected without echoing its value", async () => {
  const mutated = structuredClone(invocation);
  mutated.arguments.auth = { access_token: "synthetic-secret-value" };
  mutated.semantic_digest = computeInvocationSemanticDigest(mutated);
  const result = await evaluateInvocation(mutated);
  assert.equal(codes(result).has("secret.forbidden_field"), true);
  assert.equal(JSON.stringify(result.issues).includes("synthetic-secret-value"), false);
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

test("migration entry point clones current v1 records", () => {
  const migrated = migrateContractRecord({
    contractName: "track-ref",
    record: trackRef,
  });
  assert.deepEqual(migrated, trackRef);
  assert.notEqual(migrated, trackRef);
  assert.equal(currentContractVersion("track-ref"), 1);
});

test("ProfileEvidence v1 and v2 coexist without an implicit migration", () => {
  const retainedV1 = migrateContractRecord({
    contractName: "profile-evidence",
    record: profileEvidence,
    targetVersion: 1,
  });
  const retainedV2 = migrateContractRecord({
    contractName: "profile-evidence",
    record: observationProfileEvidence,
  });

  assert.equal(currentContractVersion("profile-evidence"), 2);
  assert.deepEqual(retainedV1, profileEvidence);
  assert.deepEqual(retainedV2, observationProfileEvidence);
  assert.throws(
    () =>
      migrateContractRecord({
        contractName: "profile-evidence",
        record: profileEvidence,
      }),
    /No profile-evidence migration from schema version 1/,
  );
});

test("migration entry point fails closed for unknown upgrades and downgrades", () => {
  assert.throws(
    () =>
      migrateContractRecord({
        contractName: "unknown-contract",
        record: trackRef,
        targetVersion: 1,
      }),
    /Unknown contract/,
  );
  assert.throws(
    () =>
      migrateContractRecord({
        contractName: "track-ref",
        record: trackRef,
        targetVersion: 2,
      }),
    /target schema version 2 is not registered/,
  );
  assert.throws(
    () =>
      migrateContractRecord({
        contractName: "track-ref",
        record: { ...trackRef, schema_version: 2 },
        targetVersion: 1,
      }),
    /source schema version 2 is not registered/,
  );
  assert.throws(
    () =>
      migrateContractRecord({
        contractName: "track-ref",
        record: { schema_version: 2, untrusted: true },
        targetVersion: 2,
      }),
    /source schema version 2 is not registered/,
  );
});

test("valid receipt binds the invocation, registry, confirmation, and idempotency", () => {
  const result = validateToolReceiptSemantics({
    receipt: structuredClone(receipt),
    invocation,
    capability,
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(
    receipt.idempotency.key_digest,
    computeIdempotencyKeyDigest(invocation),
  );
  assert.equal(
    receipt.confirmation.scope_digest,
    computeConfirmationScopeDigest({
      invocationSemanticDigest: invocation.semantic_digest,
      capabilityRegistryVersion: capability.registry_version,
    }),
  );
});

test("receipt validation fails closed without a trusted descriptor", () => {
  const result = validateToolReceiptSemantics({
    receipt: structuredClone(receipt),
    invocation,
    capability: null,
  });
  assert.equal(result.ok, false);
  assert.equal(codes(result).has("registry.descriptor_missing"), true);
});

test("successful external receipt requires matching confirmation evidence", () => {
  const mutated = structuredClone(receipt);
  delete mutated.confirmation;
  const result = validateToolReceiptSemantics({
    receipt: mutated,
    invocation,
    capability,
  });
  assert.equal(codes(result).has("receipt.confirmation_mismatch"), true);
});

test("receipt status cannot contradict its policy decision", () => {
  const mutated = structuredClone(receipt);
  mutated.policy_decision.decision = "deny";
  const result = validateToolReceiptSemantics({
    receipt: mutated,
    invocation,
    capability,
  });
  assert.equal(codes(result).has("receipt.status_decision_mismatch"), true);
});

test("accepted and succeeded receipts cannot swap effect completion states", () => {
  const accepted = structuredClone(receipt);
  accepted.status = "accepted";
  const acceptedResult = validateToolReceiptSemantics({
    receipt: accepted,
    invocation,
    capability,
  });
  assert.equal(
    codes(acceptedResult).has("receipt.accepted_effect_completed"),
    true,
  );

  const succeeded = structuredClone(receipt);
  succeeded.effects[0].status = "planned";
  const succeededResult = validateToolReceiptSemantics({
    receipt: succeeded,
    invocation,
    capability,
  });
  assert.equal(
    codes(succeededResult).has("receipt.success_effect_incomplete"),
    true,
  );
});

test("idempotency conflict cannot coexist with successful execution", () => {
  const mutated = structuredClone(receipt);
  mutated.idempotency.disposition = "conflict";
  const result = validateToolReceiptSemantics({
    receipt: mutated,
    invocation,
    capability,
  });
  assert.equal(
    codes(result).has("receipt.idempotency_conflict_executed"),
    true,
  );
});

test("a replay cannot cite its own receipt as the prior result", () => {
  const replayed = structuredClone(receipt);
  replayed.idempotency.disposition = "replayed";
  replayed.deduplicated_from_receipt_id = replayed.receipt_id;
  replayed.usage = [];
  replayed.privacy_egress = [];
  const result = validateToolReceiptSemantics({
    receipt: replayed,
    invocation,
    capability,
    priorReceiptById: new Map([[replayed.receipt_id, replayed]]),
  });
  assert.equal(codes(result).has("receipt.replay_source_invalid"), true);
});

test("a granted local write requires matching receipt confirmation", () => {
  const localInvocation = structuredClone(invocation);
  localInvocation.declared_effects = ["write_local"];
  localInvocation.declared_risk_flags = ["privacy"];
  delete localInvocation.account_ref;
  localInvocation.semantic_digest =
    computeInvocationSemanticDigest(localInvocation);

  const localCapability = {
    ...structuredClone(capability),
    effects: ["write_local"],
    risk_levels: {
      privacy: "medium",
      account: "none",
      copyright: "none",
      spend: "none",
    },
  };
  const localReceipt = structuredClone(receipt);
  localReceipt.invocation_semantic_digest = localInvocation.semantic_digest;
  localReceipt.idempotency.semantic_digest = localInvocation.semantic_digest;
  localReceipt.effects[0].effect_type = "write_local";
  delete localReceipt.confirmation;

  const result = validateToolReceiptSemantics({
    receipt: localReceipt,
    invocation: localInvocation,
    capability: localCapability,
  });
  assert.equal(codes(result).has("receipt.confirmation_mismatch"), true);
});

test("unexpected receipt idempotency fails closed without throwing", () => {
  const readInvocation = structuredClone(invocation);
  readInvocation.declared_effects = ["read_external"];
  readInvocation.declared_risk_flags = ["privacy"];
  delete readInvocation.idempotency_key;
  readInvocation.semantic_digest = computeInvocationSemanticDigest(readInvocation);
  const readCapability = {
    ...structuredClone(capability),
    effects: ["read_external"],
    risk_levels: {
      privacy: "medium",
      account: "none",
      copyright: "none",
      spend: "none",
    },
  };
  const mutatedReceipt = structuredClone(receipt);
  mutatedReceipt.invocation_semantic_digest = readInvocation.semantic_digest;
  mutatedReceipt.idempotency.semantic_digest = readInvocation.semantic_digest;
  mutatedReceipt.effects[0].effect_type = "read_external";
  const result = validateToolReceiptSemantics({
    receipt: mutatedReceipt,
    invocation: readInvocation,
    capability: readCapability,
  });
  assert.equal(codes(result).has("receipt.unexpected_idempotency"), true);
});

test("receipt budget arrays reject duplicate semantic resources", () => {
  const mutated = structuredClone(receipt);
  mutated.budget_reservation = {
    reservation_id: "fefefefe-fefe-4efe-8efe-fefefefefefe",
    state: "reserved",
    reserved: [
      { resource: "credits.audio", quantity: 999, unit: "credit" },
      { resource: "credits.audio", quantity: 1, unit: "credit" },
    ],
    actual: [],
    recorded_at: "2026-08-23T09:25:01Z",
  };
  const result = validateToolReceiptSemantics({
    receipt: mutated,
    invocation,
    capability,
  });
  assert.equal(codes(result).has("receipt.budget_resource_duplicate"), true);
});

test("budget reservation must be recorded before execution starts", () => {
  const budgetedInvocation = structuredClone(invocation);
  budgetedInvocation.budget_request = [
    { resource: "credits.audio", quantity: 1, unit: "credit" },
  ];
  budgetedInvocation.semantic_digest =
    computeInvocationSemanticDigest(budgetedInvocation);
  const budgetedReceipt = structuredClone(receipt);
  budgetedReceipt.invocation_semantic_digest = budgetedInvocation.semantic_digest;
  budgetedReceipt.idempotency.semantic_digest = budgetedInvocation.semantic_digest;
  budgetedReceipt.confirmation.scope_digest = computeConfirmationScopeDigest({
    invocationSemanticDigest: budgetedInvocation.semantic_digest,
    capabilityRegistryVersion: capability.registry_version,
  });
  budgetedReceipt.usage = [
    { resource: "credits.audio", quantity: 1, unit: "credit" },
  ];
  budgetedReceipt.budget_reservation = {
    reservation_id: "fefefefe-fefe-4efe-8efe-fefefefefefe",
    state: "reconciled",
    reserved: [
      { resource: "credits.audio", quantity: 1, unit: "credit" },
    ],
    actual: [
      { resource: "credits.audio", quantity: 1, unit: "credit" },
    ],
    recorded_at: "2026-08-23T09:25:02Z",
    reconciled_at: "2026-08-23T09:25:03Z",
  };
  const result = validateToolReceiptSemantics({
    receipt: budgetedReceipt,
    invocation: budgetedInvocation,
    capability,
  });
  assert.equal(
    codes(result).has("receipt.budget_reserved_after_start"),
    true,
  );
});

test("executed account effects require confirmation consumed before start", () => {
  const missing = structuredClone(receipt);
  delete missing.confirmation.consumed_at;
  const missingResult = validateToolReceiptSemantics({
    receipt: missing,
    invocation,
    capability,
  });
  assert.equal(
    codes(missingResult).has("receipt.confirmation_time_order"),
    true,
  );

  const late = structuredClone(receipt);
  late.confirmation.verified_at = "2026-08-23T09:25:02Z";
  late.confirmation.consumed_at = "2026-08-23T09:25:02Z";
  const lateResult = validateToolReceiptSemantics({
    receipt: late,
    invocation,
    capability,
  });
  assert.equal(codes(lateResult).has("receipt.confirmation_time_order"), true);
});

test("receipt execution must begin before invocation expiry", () => {
  const mutated = structuredClone(receipt);
  mutated.confirmation.verified_at = "2027-08-23T09:25:00Z";
  mutated.confirmation.consumed_at = "2027-08-23T09:25:01Z";
  mutated.started_at = "2027-08-23T09:25:01Z";
  mutated.finished_at = "2027-08-23T09:25:03Z";
  mutated.recorded_at = "2027-08-23T09:25:03Z";
  const result = validateToolReceiptSemantics({
    receipt: mutated,
    invocation,
    capability,
  });
  const resultCodes = codes(result);
  assert.equal(
    resultCodes.has("receipt.execution_outside_invocation_window"),
    true,
  );
  assert.equal(resultCodes.has("receipt.confirmation_time_order"), true);
});

test("dry-run receipt cannot claim successful external execution", () => {
  const dryRunInvocation = structuredClone(invocation);
  dryRunInvocation.execution_mode = "dry_run";
  dryRunInvocation.semantic_digest =
    computeInvocationSemanticDigest(dryRunInvocation);
  const mutatedReceipt = structuredClone(receipt);
  mutatedReceipt.invocation_semantic_digest = dryRunInvocation.semantic_digest;
  mutatedReceipt.idempotency.semantic_digest = dryRunInvocation.semantic_digest;
  mutatedReceipt.confirmation.scope_digest = computeConfirmationScopeDigest({
    invocationSemanticDigest: dryRunInvocation.semantic_digest,
    capabilityRegistryVersion: capability.registry_version,
  });
  mutatedReceipt.effects[0].status = "planned";
  mutatedReceipt.privacy_egress = [];
  const result = validateToolReceiptSemantics({
    receipt: mutatedReceipt,
    invocation: dryRunInvocation,
    capability,
  });
  const resultCodes = codes(result);
  assert.equal(resultCodes.has("receipt.non_execute_status"), true);
  assert.equal(resultCodes.has("receipt.non_execute_proof"), true);
});

test("awaiting confirmation cannot carry execution proof", () => {
  const mutated = structuredClone(receipt);
  mutated.status = "awaiting_confirmation";
  mutated.policy_decision.decision = "require_confirmation";
  mutated.effects = [];
  mutated.usage = [];
  mutated.privacy_egress = [];
  mutated.recovery = {
    action: "request_confirmation",
    safe_summary: "Ask the user to confirm.",
  };
  delete mutated.finished_at;
  const result = validateToolReceiptSemantics({
    receipt: mutated,
    invocation,
    capability,
  });
  assert.equal(codes(result).has("receipt.pre_execution_proof"), true);
});

test("unknown outcome cannot request retry", () => {
  const mutated = structuredClone(receipt);
  mutated.status = "unknown";
  mutated.error = {
    category: "unknown",
    code: "provider.outcome_unknown",
    safe_message: "The external outcome is not known.",
    retryable: true,
  };
  mutated.recovery = {
    action: "retry",
    safe_summary: "Retry the request.",
  };
  const result = validateToolReceiptSemantics({
    receipt: mutated,
    invocation,
    capability,
  });
  const resultCodes = codes(result);
  assert.equal(resultCodes.has("receipt.unknown_retryable"), true);
  assert.equal(resultCodes.has("receipt.unknown_recovery"), true);
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
