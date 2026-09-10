import {
  contractSchemaIds,
  contractSchemaIdsByVersion,
  createContractValidator,
  formatValidationErrors,
  loadFixtures,
} from "./contract-lib.mjs";

const { ajv, schemas } = await createContractValidator();
const fixtures = await loadFixtures();

for (const fixture of fixtures) {
  const validate = ajv.getSchema(fixture.schemaId);
  const actualValid = validate(fixture.data);

  if (actualValid !== fixture.expectedValid) {
    const expectation = fixture.expectedValid ? "valid" : "invalid";
    throw new Error(
      `${fixture.relativePath} should be ${expectation}: ${formatValidationErrors(validate.errors)}`,
    );
  }
}

const definitionsCount = schemas.length - contractSchemaIdsByVersion.size;

console.log(
  `Compiled ${contractSchemaIds.size} current contracts across ${contractSchemaIdsByVersion.size} schema versions and ${definitionsCount} definitions schema.`,
);
console.log(`Validated ${fixtures.length} synthetic fixtures without network access.`);
