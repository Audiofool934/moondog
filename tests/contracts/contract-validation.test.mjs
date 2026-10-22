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
    "v1/listening-event.invalid.json",
    { instancePath: "/completion_ratio", keyword: "maximum" },
  ],
  [
    "v1/library-track-observation.invalid.json",
    { instancePath: "", keyword: "additionalProperties" },
  ],
  ["v1/taste-event.invalid.json", { instancePath: "", keyword: "not" }],
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
  assert.equal(contractSchemaIds.size, 5);
  assert.equal(contractSchemaIdsByVersion.size, 5);

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

test("inferred is not a valid TasteEvent explicitness", () => {
  const fixture = fixtures.find(
    (item) => item.fileName === "taste-event.valid.json",
  );
  const validate = ajv.getSchema(fixture.schemaId);
  const mutated = structuredClone(fixture.data);
  mutated.explicitness = "inferred";

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
  const mutated = fixtureData("listening-event.valid.json");
  mutated.occurred_at = "2026-08-23 09:00:00Z";
  assertSchemaRejects("listening-event", mutated, {
    instancePath: "/occurred_at",
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
