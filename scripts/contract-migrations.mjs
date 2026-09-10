import { contractCurrentVersions } from "./contract-lib.mjs";

const currentVersions = new Map(contractCurrentVersions);

const migrationSteps = new Map();

function migrationKey(contractName, fromVersion) {
  return `${contractName}:${fromVersion}`;
}

export function currentContractVersion(contractName) {
  const version = currentVersions.get(contractName);
  if (version === undefined) {
    throw new Error(`Unknown contract: ${contractName}`);
  }
  return version;
}

export function migrateContractRecord({
  contractName,
  record,
  targetVersion = currentContractVersion(contractName),
}) {
  const registeredCurrentVersion = currentContractVersion(contractName);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Contract record must be an object");
  }
  if (!Number.isInteger(record.schema_version) || record.schema_version < 1) {
    throw new Error("Contract record has an invalid schema_version");
  }
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new Error("Target schema version must be a positive integer");
  }
  if (record.schema_version > registeredCurrentVersion) {
    throw new Error(
      `${contractName} source schema version ${record.schema_version} is not registered`,
    );
  }
  if (targetVersion > registeredCurrentVersion) {
    throw new Error(
      `${contractName} target schema version ${targetVersion} is not registered`,
    );
  }
  if (record.schema_version > targetVersion) {
    throw new Error("Contract migration does not support downgrades");
  }

  let migrated = structuredClone(record);
  while (migrated.schema_version < targetVersion) {
    const step = migrationSteps.get(
      migrationKey(contractName, migrated.schema_version),
    );
    if (!step) {
      throw new Error(
        `No ${contractName} migration from schema version ${migrated.schema_version}`,
      );
    }
    const expectedVersion = migrated.schema_version + 1;
    migrated = step(structuredClone(migrated));
    if (
      !migrated ||
      typeof migrated !== "object" ||
      migrated.schema_version !== expectedVersion
    ) {
      throw new Error(
        `${contractName} migration did not produce schema version ${expectedVersion}`,
      );
    }
  }

  return migrated;
}
