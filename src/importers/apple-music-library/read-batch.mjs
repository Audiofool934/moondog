import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { canonicalizeJson } from "../../../scripts/contract-semantics.mjs";
import { validateAppleMusicImportRecords } from "./normalize.mjs";
import { AppleMusicImportError } from "./parse-plist.mjs";
import {
  APPLE_LIBRARY_BATCH_NAMESPACE,
  APPLE_MUSIC_LIBRARY_IMPORTER_NAME,
  APPLE_MUSIC_LIBRARY_IMPORTER_VERSION,
  isUuid,
  uuidV5,
} from "./stable-ids.mjs";

const dataFileNames = [
  "track-refs.ndjson",
  "track-snapshots.ndjson",
  "warnings.ndjson",
];
const maximumManifestBytes = 1024 * 1024;
const maximumDataFileBytes = 128 * 1024 * 1024;

function fail(code, message, options) {
  throw new AppleMusicImportError(code, message, options);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPrivateMode(metadata, kind) {
  if (process.platform === "win32") return;
  if ((metadata.mode & 0o077) !== 0) {
    fail("batch_permissions_invalid", `Apple import batch ${kind} is not private`);
  }
}

function parseCanonicalNdjson(buffer, expectedRecords) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (cause) {
    fail("batch_data_invalid", "Apple import batch data is not valid UTF-8", {
      cause,
    });
  }
  if (source === "") {
    if (expectedRecords !== 0) {
      fail("batch_data_invalid", "Apple import batch record count does not match");
    }
    return [];
  }
  if (!source.endsWith("\n")) {
    fail("batch_data_invalid", "Apple import batch NDJSON is not canonical");
  }

  const lines = source.slice(0, -1).split("\n");
  if (lines.length !== expectedRecords) {
    fail("batch_data_invalid", "Apple import batch record count does not match");
  }
  return lines.map((line) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (cause) {
      fail("batch_data_invalid", "Apple import batch contains invalid JSON", {
        cause,
      });
    }
    if (canonicalizeJson(record) !== line) {
      fail("batch_data_invalid", "Apple import batch NDJSON is not canonical");
    }
    return record;
  });
}

async function readPrivateFile(filePath, descriptor) {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== descriptor.bytes ||
    metadata.size > maximumDataFileBytes
  ) {
    fail("batch_data_invalid", "Apple import batch data file is invalid");
  }
  assertPrivateMode(metadata, "file");
  const buffer = await readFile(filePath);
  if (sha256(buffer) !== descriptor.sha256) {
    fail("batch_digest_mismatch", "Apple import batch data digest does not match");
  }
  return parseCanonicalNdjson(buffer, descriptor.records);
}

async function readAppleMusicImportManifest(
  batchDirectory,
  { expectedSubjectId } = {},
) {
  if (expectedSubjectId !== undefined && !isUuid(expectedSubjectId)) {
    throw new TypeError("Expected Apple import subject must be a UUID");
  }
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(batchDirectory);
  } catch (cause) {
    fail("batch_unreadable", "Apple import batch cannot be read", { cause });
  }
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink()
  ) {
    fail("batch_directory_invalid", "Apple import batch directory is invalid");
  }
  assertPrivateMode(directoryMetadata, "directory");

  const batchDirectoryName = path.basename(batchDirectory);
  if (!isUuid(batchDirectoryName)) {
    fail("batch_directory_invalid", "Apple import batch directory name is invalid");
  }

  const entries = (await readdir(batchDirectory)).sort();
  const expectedEntries = ["manifest.json", ...dataFileNames].sort();
  if (canonicalizeJson(entries) !== canonicalizeJson(expectedEntries)) {
    fail("batch_directory_invalid", "Apple import batch contains unexpected files");
  }

  const manifestPath = path.join(batchDirectory, "manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (
    !manifestMetadata.isFile() ||
    manifestMetadata.isSymbolicLink() ||
    manifestMetadata.size > maximumManifestBytes
  ) {
    fail("batch_manifest_invalid", "Apple import batch manifest is invalid");
  }
  assertPrivateMode(manifestMetadata, "manifest");

  let persistedManifest;
  try {
    persistedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    fail("batch_manifest_invalid", "Apple import batch manifest is invalid", {
      cause,
    });
  }
  if (
    persistedManifest.import_batch_id !== batchDirectoryName ||
    (expectedSubjectId !== undefined &&
      persistedManifest.subject_id !== expectedSubjectId.toLowerCase()) ||
    !Array.isArray(persistedManifest.files) ||
    persistedManifest.files.length !== dataFileNames.length
  ) {
    fail("batch_manifest_invalid", "Apple import batch manifest identity is invalid");
  }
  const expectedBatchId = uuidV5(
    `v1\n${APPLE_MUSIC_LIBRARY_IMPORTER_NAME}@${APPLE_MUSIC_LIBRARY_IMPORTER_VERSION}\n${persistedManifest.subject_id}\n${persistedManifest.source?.sha256}`,
    APPLE_LIBRARY_BATCH_NAMESPACE,
  );
  if (expectedBatchId !== persistedManifest.import_batch_id) {
    fail(
      "batch_manifest_invalid",
      "Apple import batch deterministic identity is invalid",
    );
  }

  const descriptors = new Map();
  for (const descriptor of persistedManifest.files) {
    if (
      !descriptor ||
      canonicalizeJson(Object.keys(descriptor).sort()) !==
        canonicalizeJson(["bytes", "name", "records", "sha256"]) ||
      !dataFileNames.includes(descriptor.name) ||
      descriptors.has(descriptor.name) ||
      !/^[0-9a-f]{64}$/.test(descriptor.sha256) ||
      !Number.isSafeInteger(descriptor.bytes) ||
      descriptor.bytes < 0 ||
      !Number.isSafeInteger(descriptor.records) ||
      descriptor.records < 0
    ) {
      fail("batch_manifest_invalid", "Apple import batch file descriptor is invalid");
    }
    descriptors.set(descriptor.name, descriptor);
  }

  return { persistedManifest, descriptors };
}

export async function readAppleMusicImportBatch(
  batchDirectory,
  { expectedSubjectId } = {},
) {
  const { persistedManifest, descriptors } =
    await readAppleMusicImportManifest(batchDirectory, { expectedSubjectId });

  const [trackRefs, trackSnapshots, warnings] = await Promise.all(
    dataFileNames.map((fileName) =>
      readPrivateFile(path.join(batchDirectory, fileName), descriptors.get(fileName)),
    ),
  );
  const { files: ignoredFiles, ...manifest } = persistedManifest;
  void ignoredFiles;
  const records = { manifest, trackRefs, trackSnapshots, warnings };
  await validateAppleMusicImportRecords(records);
  return records;
}

export async function listAppleMusicImportBatches(
  importsRoot,
  { subjectId } = {},
) {
  if (subjectId !== undefined && !isUuid(subjectId)) {
    throw new TypeError("Apple projection requires a valid subject UUID");
  }
  let rootMetadata;
  try {
    rootMetadata = await lstat(importsRoot);
  } catch (cause) {
    fail("imports_root_unreadable", "Apple import root cannot be read", { cause });
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail("imports_root_invalid", "Apple import root is invalid");
  }
  assertPrivateMode(rootMetadata, "root");

  const entries = await readdir(importsRoot, { withFileTypes: true });
  const batchNames = entries
    .map((entry) => entry.name)
    .filter((name) => isUuid(name))
    .sort();
  const candidates = [];
  for (const batchName of batchNames) {
    const batchDirectory = path.join(importsRoot, batchName);
    const { persistedManifest } = await readAppleMusicImportManifest(
      batchDirectory,
    );
    candidates.push({
      batchDirectory,
      subjectId: persistedManifest.subject_id,
    });
  }
  const subjects = new Set(candidates.map((candidate) => candidate.subjectId));
  if (subjectId === undefined && subjects.size > 1) {
    fail(
      "projection_subject_mismatch",
      "Apple projection cannot infer one subject across import batches",
    );
  }
  const resolvedSubjectId =
    subjectId?.toLowerCase() ?? [...subjects][0];
  const batches = [];
  for (const candidate of candidates) {
    if (candidate.subjectId !== resolvedSubjectId) continue;
    batches.push(
      await readAppleMusicImportBatch(candidate.batchDirectory, {
        expectedSubjectId: resolvedSubjectId,
      }),
    );
  }
  batches.sort((left, right) => {
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
  return batches;
}
