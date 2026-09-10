import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const schemaDirectory = path.join(repositoryRoot, "contracts", "v1");
export const fixtureDirectory = path.join(
  repositoryRoot,
  "contracts",
  "examples",
  "v1",
);

const schemaVersions = [1, 2];

export const contractSchemaIdsByVersion = new Map([
  ["track-ref:1", "urn:moondog:contract:track-ref:1"],
  ["listening-event:1", "urn:moondog:contract:listening-event:1"],
  ["taste-event:1", "urn:moondog:contract:taste-event:1"],
  ["library-track-observation:1", "urn:moondog:contract:library-track-observation:1"],
  ["profile-evidence:1", "urn:moondog:contract:profile-evidence:1"],
  ["profile-evidence:2", "urn:moondog:contract:profile-evidence:2"],
  ["capability-policy:1", "urn:moondog:contract:capability-policy:1"],
  ["tool-invocation:1", "urn:moondog:contract:tool-invocation:1"],
  ["tool-receipt:1", "urn:moondog:contract:tool-receipt:1"],
]);

export const contractCurrentVersions = new Map([
  ["track-ref", 1],
  ["listening-event", 1],
  ["taste-event", 1],
  ["library-track-observation", 1],
  ["profile-evidence", 2],
  ["capability-policy", 1],
  ["tool-invocation", 1],
  ["tool-receipt", 1],
]);

export function contractSchemaId(contractName, schemaVersion) {
  const version = schemaVersion ?? contractCurrentVersions.get(contractName);
  if (!Number.isInteger(version)) return undefined;
  return contractSchemaIdsByVersion.get(`${contractName}:${version}`);
}

export const contractSchemaIds = new Map(
  [...contractCurrentVersions].map(([contractName, schemaVersion]) => [
    contractName,
    contractSchemaId(contractName, schemaVersion),
  ]),
);

async function readJson(filePath) {
  const source = await readFile(filePath, "utf8");
  return JSON.parse(source);
}

function joinSchemaPath(basePath, segment) {
  const escaped = segment.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${basePath}/${escaped}`;
}

export function assertRequiredPropertiesDeclared(
  schema,
  schemaPath = "#",
  inheritedProperties = new Set(),
) {
  if (typeof schema === "boolean") return;

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError(`${schemaPath} is not a JSON Schema object`);
  }

  const visibleProperties = new Set(inheritedProperties);

  for (const propertyName of Object.keys(schema.properties ?? {})) {
    visibleProperties.add(propertyName);
  }

  for (const propertyName of schema.required ?? []) {
    if (!visibleProperties.has(propertyName)) {
      throw new Error(
        `${schemaPath}/required names undeclared property ${JSON.stringify(propertyName)}`,
      );
    }
  }

  for (const [triggerProperty, dependentProperties] of Object.entries(
    schema.dependentRequired ?? {},
  )) {
    if (!visibleProperties.has(triggerProperty)) {
      throw new Error(
        `${schemaPath}/dependentRequired names undeclared trigger ${JSON.stringify(triggerProperty)}`,
      );
    }
    for (const dependentProperty of dependentProperties) {
      if (!visibleProperties.has(dependentProperty)) {
        throw new Error(
          `${schemaPath}/dependentRequired/${triggerProperty} names undeclared property ${JSON.stringify(dependentProperty)}`,
        );
      }
    }
  }

  if (schema.if?.properties) {
    const guardedDiscriminators = new Set(schema.if.required ?? []);
    for (const discriminator of Object.keys(schema.if.properties)) {
      if (!guardedDiscriminators.has(discriminator)) {
        throw new Error(
          `${schemaPath}/if/properties/${discriminator} is not guarded by if.required`,
        );
      }
    }
  }

  const sameInstanceKeywords = [
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "if",
    "then",
    "else",
  ];

  for (const keyword of sameInstanceKeywords) {
    const value = schema[keyword];
    if (value === undefined) continue;

    const children = Array.isArray(value) ? value : [value];
    children.forEach((child, index) => {
      const childPath = Array.isArray(value)
        ? joinSchemaPath(joinSchemaPath(schemaPath, keyword), String(index))
        : joinSchemaPath(schemaPath, keyword);
      assertRequiredPropertiesDeclared(child, childPath, visibleProperties);
    });
  }

  for (const [propertyName, propertySchema] of Object.entries(
    schema.properties ?? {},
  )) {
    assertRequiredPropertiesDeclared(
      propertySchema,
      joinSchemaPath(joinSchemaPath(schemaPath, "properties"), propertyName),
      new Set(),
    );
  }

  for (const keyword of ["patternProperties", "$defs"]) {
    for (const [name, child] of Object.entries(schema[keyword] ?? {})) {
      assertRequiredPropertiesDeclared(
        child,
        joinSchemaPath(joinSchemaPath(schemaPath, keyword), name),
        new Set(),
      );
    }
  }

  for (const [name, child] of Object.entries(schema.dependentSchemas ?? {})) {
    assertRequiredPropertiesDeclared(
      child,
      joinSchemaPath(joinSchemaPath(schemaPath, "dependentSchemas"), name),
      visibleProperties,
    );
  }

  for (const keyword of [
    "additionalProperties",
    "propertyNames",
    "items",
    "contains",
    "unevaluatedProperties",
  ]) {
    const child = schema[keyword];
    if (child === undefined) continue;
    assertRequiredPropertiesDeclared(
      child,
      joinSchemaPath(schemaPath, keyword),
      new Set(),
    );
  }

  (schema.prefixItems ?? []).forEach((child, index) => {
    assertRequiredPropertiesDeclared(
      child,
      joinSchemaPath(joinSchemaPath(schemaPath, "prefixItems"), String(index)),
      new Set(),
    );
  });
}

export async function loadSchemas() {
  const schemas = [];
  for (const schemaVersion of schemaVersions) {
    const directory = path.join(repositoryRoot, "contracts", `v${schemaVersion}`);
    let fileNames;
    try {
      fileNames = (await readdir(directory)).filter((fileName) =>
        fileName.endsWith(".schema.json"),
      );
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const fileName of fileNames) {
      const filePath = path.join(directory, fileName);
      schemas.push({
        fileName,
        filePath,
        relativePath: path.posix.join(`v${schemaVersion}`, fileName),
        schemaVersion,
        schema: await readJson(filePath),
      });
    }
  }

  return schemas.sort((left, right) => {
    if (left.fileName === "definitions.schema.json") return -1;
    if (right.fileName === "definitions.schema.json") return 1;
    return left.relativePath.localeCompare(right.relativePath);
  });
}

export async function createContractValidator() {
  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    allErrors: true,
    validateSchema: true,
    validateFormats: true,
    allowUnionTypes: false,
  });

  addFormats(ajv, { mode: "full" });

  const schemas = await loadSchemas();
  const seenIds = new Set();

  for (const { fileName, schema } of schemas) {
    if (!schema.$id) {
      throw new Error(`${fileName} has no $id`);
    }

    if (seenIds.has(schema.$id)) {
      throw new Error(`Duplicate schema $id: ${schema.$id}`);
    }

    seenIds.add(schema.$id);
    assertRequiredPropertiesDeclared(schema, `${fileName}#`);
    ajv.addSchema(schema);
  }

  for (const schemaId of contractSchemaIdsByVersion.values()) {
    if (!ajv.getSchema(schemaId)) {
      throw new Error(`Schema did not compile: ${schemaId}`);
    }
  }

  return { ajv, schemas };
}

export async function loadFixtures() {
  const fixtureDescriptors = [];
  for (const schemaVersion of schemaVersions) {
    const directory = path.join(
      repositoryRoot,
      "contracts",
      "examples",
      `v${schemaVersion}`,
    );
    let fileNames;
    try {
      fileNames = (await readdir(directory)).filter(
        (fileName) =>
          fileName.endsWith(".valid.json") ||
          fileName.endsWith(".invalid.json"),
      );
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const fileName of fileNames) {
      fixtureDescriptors.push({ directory, fileName, schemaVersion });
    }
  }
  fixtureDescriptors.sort((left, right) =>
    `${left.schemaVersion}/${left.fileName}`.localeCompare(
      `${right.schemaVersion}/${right.fileName}`,
    ),
  );

  return Promise.all(
    fixtureDescriptors.map(async ({ directory, fileName, schemaVersion }) => {
      const match = fileName.match(
        /^([a-z0-9-]+?)(?:--([a-z0-9-]+))?\.(valid|invalid)\.json$/,
      );

      if (!match) {
        throw new Error(`Unrecognized fixture file name: ${fileName}`);
      }

      const [, contractName, caseName = "base", expectation] = match;
      const schemaId = contractSchemaId(contractName, schemaVersion);

      if (!schemaId) {
        throw new Error(
          `No schema mapping for fixture: v${schemaVersion}/${fileName}`,
        );
      }

      return {
        fileName,
        relativePath: path.posix.join(`v${schemaVersion}`, fileName),
        contractName,
        caseName,
        schemaVersion,
        schemaId,
        expectedValid: expectation === "valid",
        data: await readJson(path.join(directory, fileName)),
      };
    }),
  ).then((fixtures) => {
    for (const versionKey of contractSchemaIdsByVersion.keys()) {
      const separator = versionKey.lastIndexOf(":");
      const contractName = versionKey.slice(0, separator);
      const schemaVersion = Number(versionKey.slice(separator + 1));
      const contractFixtures = fixtures.filter(
        (fixture) =>
          fixture.contractName === contractName &&
          fixture.schemaVersion === schemaVersion,
      );

      if (!contractFixtures.some((fixture) => fixture.expectedValid)) {
        throw new Error(`${versionKey} has no valid fixture`);
      }

      if (!contractFixtures.some((fixture) => !fixture.expectedValid)) {
        throw new Error(`${versionKey} has no invalid fixture`);
      }
    }

    return fixtures;
  });
}

export function formatValidationErrors(errors) {
  if (!errors || errors.length === 0) return "No validation errors were reported.";

  return errors
    .map((error) => {
      const location = error.instancePath || "/";
      return `${location} ${error.message}`;
    })
    .join("; ");
}
