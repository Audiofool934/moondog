import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertRequiredPropertiesDeclared,
  contractSchemaIds,
  contractSchemaIdsByVersion,
  createContractValidator,
  formatValidationErrors,
  loadFixtures,
} from "../../scripts/contract-lib.mjs";

const { ajv, schemas } = await createContractValidator();
const fixtures = await loadFixtures();

function fixtureData(fileName) {
  const fixture = fixtures.find((item) => item.fileName === fileName);
  assert.ok(fixture, `Missing fixture ${fileName}`);
  return structuredClone(fixture.data);
}

function assertSchemaRejects(contractName, data, expectedError) {
  const validate = ajv.getSchema(contractSchemaIds.get(contractName));
  assert.equal(validate(data), false, "Mutation unexpectedly validated");
  if (!expectedError) return;
  assert.ok(
    validate.errors.some(
      (error) =>
        error.instancePath === expectedError.instancePath &&
        error.keyword === expectedError.keyword,
    ),
    `Expected ${JSON.stringify(expectedError)} in ${JSON.stringify(validate.errors)}`,
  );
}

const expectedInvalidErrors = new Map([
  [
    "v1/capability-policy.invalid.json",
    { instancePath: "/confirmation/mode", keyword: "const" },
  ],
  [
    "v1/listening-event.invalid.json",
    { instancePath: "/completion_ratio", keyword: "maximum" },
  ],
  [
    "v1/profile-evidence.invalid.json",
    { instancePath: "/basis_refs", keyword: "minItems" },
  ],
  [
    "v1/library-track-observation.invalid.json",
    { instancePath: "", keyword: "additionalProperties" },
  ],
  ["v1/taste-event.invalid.json", { instancePath: "", keyword: "not" }],
  [
    "v1/tool-invocation.invalid.json",
    { instancePath: "/data_manifest", keyword: "not" },
  ],
  [
    "v1/tool-receipt.invalid.json",
    { instancePath: "", keyword: "required", missingProperty: "error" },
  ],
  [
    "v1/track-ref.invalid.json",
    {
      instancePath: "",
      keyword: "additionalProperties",
      additionalProperty: "spotify_uri",
    },
  ],
  [
    "v2/profile-evidence--observation.invalid.json",
    { instancePath: "/derivation/kind", keyword: "enum" },
  ],
]);

for (const fixture of fixtures) {
  test(`${fixture.relativePath} has the declared validity`, () => {
    const validate = ajv.getSchema(fixture.schemaId);
    const actualValid = validate(fixture.data);

    assert.equal(
      actualValid,
      fixture.expectedValid,
      formatValidationErrors(validate.errors),
    );

    if (!fixture.expectedValid) {
      const expectedError = expectedInvalidErrors.get(fixture.relativePath);
      assert.ok(expectedError, `No expected error for ${fixture.relativePath}`);
      assert.ok(
        validate.errors.some((error) => {
          if (error.instancePath !== expectedError.instancePath) return false;
          if (error.keyword !== expectedError.keyword) return false;
          if (
            expectedError.missingProperty &&
            error.params.missingProperty !== expectedError.missingProperty
          ) {
            return false;
          }
          if (
            expectedError.additionalProperty &&
            error.params.additionalProperty !== expectedError.additionalProperty
          ) {
            return false;
          }
          return true;
        }),
        `Expected ${JSON.stringify(expectedError)} in ${JSON.stringify(validate.errors)}`,
      );
    }
  });
}

for (const fixture of fixtures.filter((item) => item.expectedValid)) {
  test(`${fixture.relativePath} rejects unknown top-level fields`, () => {
    const validate = ajv.getSchema(fixture.schemaId);
    const mutated = structuredClone(fixture.data);
    mutated.untrusted_provider_field = "must not pass";

    assert.equal(validate(mutated), false);
  });
}

test("all current contracts and registered schema versions compile", () => {
  assert.equal(contractSchemaIds.size, 8);
  assert.equal(contractSchemaIdsByVersion.size, 9);

  for (const schemaId of contractSchemaIdsByVersion.values()) {
    assert.equal(typeof ajv.getSchema(schemaId), "function");
  }
});

test("core schema source contains no provider-specific contract vocabulary", async () => {
  const forbiddenTerms = /\b(?:spotify|openclaw|suno|udio)\b/i;

  for (const { filePath, relativePath } of schemas) {
    const source = await readFile(filePath, "utf8");
    assert.equal(
      forbiddenTerms.test(source),
      false,
      `${relativePath} contains provider-specific vocabulary`,
    );
  }
});

test("every top-level contract rejects additional properties", () => {
  for (const { fileName, relativePath, schema } of schemas) {
    if (fileName === "definitions.schema.json") continue;
    assert.equal(schema.additionalProperties, false, relativePath);
  }
});

test("a caller cannot add a provider field to ToolInvocation", () => {
  const fixture = fixtures.find(
    (item) => item.fileName === "tool-invocation.valid.json",
  );
  const validate = ajv.getSchema(fixture.schemaId);
  const mutated = structuredClone(fixture.data);
  mutated.provider = "synthetic-provider";

  assert.equal(validate(mutated), false);
});

test("dry-run invocation cannot export raw listening history", () => {
  const fixture = fixtures.find(
    (item) => item.fileName === "tool-invocation.valid.json",
  );
  const validate = ajv.getSchema(fixture.schemaId);
  const mutated = structuredClone(fixture.data);
  mutated.execution_mode = "dry_run";
  mutated.declared_effects = ["read_external"];
  mutated.data_manifest.data_classes = ["raw_listening_history"];
  mutated.data_manifest.raw_data_included = true;
  mutated.data_manifest.planned_destinations = [
    {
      destination_type: "external",
      system: "synthetic-analysis",
      purpose_id: "purpose.raw_analysis",
      purpose: "Attempt raw data egress.",
    },
  ];

  assert.equal(validate(mutated), false);
});

test("inferred is not a valid TasteEvent explicitness", () => {
  const fixture = fixtures.find(
    (item) => item.fileName === "taste-event.valid.json",
  );
  const validate = ajv.getSchema(fixture.schemaId);
  const mutated = structuredClone(fixture.data);
  mutated.explicitness = "inferred";

  assert.equal(validate(mutated), false);
});

test("wildcard capability policy does not validate", () => {
  const fixture = fixtures.find(
    (item) => item.fileName === "capability-policy.valid.json",
  );
  const validate = ajv.getSchema(fixture.schemaId);
  const mutated = structuredClone(fixture.data);
  mutated.capability_ids = ["playlist.*"];

  assert.equal(validate(mutated), false);
});

test("required-property linter accepts same-instance dependentSchemas", () => {
  assert.doesNotThrow(() =>
    assertRequiredPropertiesDeclared({
      type: "object",
      properties: { mode: {}, reason: {} },
      dependentSchemas: {
        mode: { required: ["reason"] },
      },
    }),
  );
});

test("required-property linter rejects a dependentRequired typo", () => {
  assert.throws(
    () =>
      assertRequiredPropertiesDeclared({
        type: "object",
        properties: { mode: {}, reason: {} },
        dependentRequired: { mode: ["reaosn"] },
      }),
    /undeclared property "reaosn"/,
  );
});

test("required-property linter rejects a conditional typo", () => {
  assert.throws(
    () =>
      assertRequiredPropertiesDeclared({
        type: "object",
        properties: { status: {}, error: {} },
        allOf: [
          {
            if: {
              properties: { status: { const: "failed" } },
              required: ["status"],
            },
            then: { required: ["erorr"] },
          },
        ],
      }),
    /undeclared property "erorr"/,
  );
});

test("required-property linter rejects an unguarded discriminator", () => {
  assert.throws(
    () =>
      assertRequiredPropertiesDeclared({
        type: "object",
        properties: { status: {}, error: {} },
        if: { properties: { status: { const: "failed" } } },
        then: { required: ["error"] },
      }),
    /not guarded by if.required/,
  );
});

test("UTC timestamps require uppercase T and Z", () => {
  const mutated = fixtureData("capability-policy.valid.json");
  mutated.valid_from = "2026-08-23 09:00:00Z";
  assertSchemaRejects("capability-policy", mutated, {
    instancePath: "/valid_from",
    keyword: "pattern",
  });
});

test("resolved TrackRef requires a title", () => {
  const mutated = fixtureData("track-ref.valid.json");
  delete mutated.title;
  assertSchemaRejects("track-ref", mutated, {
    instancePath: "",
    keyword: "required",
  });
});

test("TrackRef revision 2 requires a supersedes pointer", () => {
  const mutated = fixtureData("track-ref.valid.json");
  mutated.revision = 2;
  assertSchemaRejects("track-ref", mutated, {
    instancePath: "",
    keyword: "required",
  });
});

test("TrackRef revision 1 forbids a supersedes pointer", () => {
  const mutated = fixtureData("track-ref.valid.json");
  mutated.supersedes = {
    track_ref_id: mutated.track_ref_id,
    revision: 1,
  };
  assertSchemaRejects("track-ref", mutated, {
    instancePath: "",
    keyword: "not",
  });
});

test("provisional TrackRef forbids ambiguous candidates", () => {
  const mutated = fixtureData("track-ref--provisional.valid.json");
  mutated.candidate_track_ref_ids = [
    "13131313-1313-4131-8131-131313131313",
    "14141414-1414-4141-8141-141414141414",
  ];
  assertSchemaRejects("track-ref", mutated, {
    instancePath: "",
    keyword: "not",
  });
});

test("TrackRef rejects an impossible release date", () => {
  const mutated = fixtureData("track-ref.valid.json");
  mutated.release.release_date = "2026-02-30";
  assertSchemaRejects("track-ref", mutated);
});

test("play_started forbids completion_ratio", () => {
  const mutated = fixtureData("listening-event.valid.json");
  mutated.event_type = "play_started";
  mutated.completion_ratio = 0.2;
  assertSchemaRejects("listening-event", mutated, {
    instancePath: "",
    keyword: "not",
  });
});

test("a non-rating TasteEvent forbids rating fields", () => {
  const mutated = fixtureData("taste-event.valid.json");
  mutated.signal_type = "preference";
  assertSchemaRejects("taste-event", mutated, {
    instancePath: "",
    keyword: "not",
  });
});

test("a mutating invocation requires an idempotency key", () => {
  const mutated = fixtureData("tool-invocation.valid.json");
  delete mutated.idempotency_key;
  assertSchemaRejects("tool-invocation", mutated, {
    instancePath: "",
    keyword: "required",
  });
});

test("a spending invocation requires a non-empty budget", () => {
  const mutated = fixtureData("tool-invocation.valid.json");
  mutated.declared_effects.push("spend");
  assertSchemaRejects("tool-invocation", mutated, {
    instancePath: "/budget_request",
    keyword: "minItems",
  });
});

test("a successful receipt cannot cite a deny decision", () => {
  const mutated = fixtureData("tool-receipt.valid.json");
  mutated.policy_decision.decision = "deny";
  assertSchemaRejects("tool-receipt", mutated, {
    instancePath: "/policy_decision/decision",
    keyword: "const",
  });
});

test("awaiting confirmation cannot report an applied effect", () => {
  const mutated = fixtureData("tool-receipt.valid.json");
  mutated.status = "awaiting_confirmation";
  mutated.policy_decision.decision = "require_confirmation";
  delete mutated.finished_at;
  assertSchemaRejects("tool-receipt", mutated, {
    instancePath: "/effects",
    keyword: "maxItems",
  });
});

test("awaiting confirmation uses request_confirmation recovery", () => {
  const candidate = fixtureData("tool-receipt.valid.json");
  candidate.status = "awaiting_confirmation";
  candidate.policy_decision.decision = "require_confirmation";
  candidate.effects = [];
  candidate.usage = [];
  candidate.privacy_egress = [];
  candidate.recovery = {
    action: "request_confirmation",
    safe_summary: "Ask the user to confirm this invocation.",
  };
  delete candidate.confirmation;
  delete candidate.idempotency;
  delete candidate.executor_ref;
  delete candidate.started_at;
  delete candidate.finished_at;
  const validate = ajv.getSchema(contractSchemaIds.get("tool-receipt"));
  assert.equal(validate(candidate), true, formatValidationErrors(validate.errors));
});

test("awaiting confirmation rejects retained execution proof", () => {
  const mutated = fixtureData("tool-receipt.valid.json");
  mutated.status = "awaiting_confirmation";
  mutated.policy_decision.decision = "require_confirmation";
  mutated.effects = [];
  mutated.usage = [];
  mutated.privacy_egress = [];
  mutated.recovery = {
    action: "request_confirmation",
    safe_summary: "Ask the user to confirm this invocation.",
  };
  delete mutated.finished_at;
  assertSchemaRejects("tool-receipt", mutated, {
    instancePath: "",
    keyword: "not",
  });
});

test("human escalation uses human_handoff recovery", () => {
  const candidate = fixtureData("tool-receipt.valid.json");
  candidate.status = "requires_human";
  candidate.policy_decision.decision = "escalate";
  candidate.effects = [];
  candidate.usage = [];
  candidate.privacy_egress = [];
  candidate.recovery = {
    action: "human_handoff",
    safe_summary: "Hand the unresolved invocation to a human.",
  };
  delete candidate.confirmation;
  delete candidate.idempotency;
  delete candidate.executor_ref;
  delete candidate.started_at;
  const validate = ajv.getSchema(contractSchemaIds.get("tool-receipt"));
  assert.equal(validate(candidate), true, formatValidationErrors(validate.errors));
});

test("executed confirmation evidence requires consumed_at", () => {
  const mutated = fixtureData("tool-receipt.valid.json");
  delete mutated.confirmation.consumed_at;
  assertSchemaRejects("tool-receipt", mutated, {
    instancePath: "/confirmation",
    keyword: "required",
  });
});

test("idempotency conflict cannot coexist with success", () => {
  const mutated = fixtureData("tool-receipt.valid.json");
  mutated.idempotency.disposition = "conflict";
  assertSchemaRejects("tool-receipt", mutated, {
    instancePath: "/status",
    keyword: "const",
  });
});

test("accepted receipt cannot claim an applied effect", () => {
  const mutated = fixtureData("tool-receipt.valid.json");
  mutated.status = "accepted";
  delete mutated.finished_at;
  assertSchemaRejects("tool-receipt", mutated, {
    instancePath: "/effects/0/status",
    keyword: "const",
  });
});

test("successful receipt cannot leave an effect planned", () => {
  const mutated = fixtureData("tool-receipt.valid.json");
  mutated.effects[0].status = "planned";
  assertSchemaRejects("tool-receipt", mutated, {
    instancePath: "/effects/0/status",
    keyword: "enum",
  });
});

test("budget state none forbids reconciliation metadata", () => {
  const mutated = fixtureData("tool-receipt.valid.json");
  mutated.budget_reservation.reconciled_at = "2026-08-23T09:25:03Z";
  assertSchemaRejects("tool-receipt", mutated, {
    instancePath: "/budget_reservation",
    keyword: "not",
  });
});

test("unknown receipts cannot be automatically retried", () => {
  const mutated = fixtureData("tool-receipt.valid.json");
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
  assertSchemaRejects("tool-receipt", mutated);
});

test("artifact references require hashes and safe controlled URIs", () => {
  const missingHash = fixtureData("tool-receipt.valid.json");
  missingHash.artifacts = [
    {
      artifact_id: "abababab-abab-4bab-8bab-abababababab",
      media_type: "audio/wav",
      uri: "https://example.invalid/artifacts/example.wav",
    },
  ];
  assertSchemaRejects("tool-receipt", missingHash, {
    instancePath: "/artifacts/0",
    keyword: "required",
  });

  const unsafeUri = fixtureData("tool-receipt.valid.json");
  unsafeUri.artifacts = [
    {
      artifact_id: "abababab-abab-4bab-8bab-abababababab",
      media_type: "text/html",
      uri: "data:text/html;base64,PHNjcmlwdD4=",
      sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    },
  ];
  assertSchemaRejects("tool-receipt", unsafeUri, {
    instancePath: "/artifacts/0/uri",
    keyword: "pattern",
  });
});
