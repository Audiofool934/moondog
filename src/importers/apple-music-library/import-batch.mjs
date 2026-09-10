import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import {
  canonicalizeJson,
  findUnsafePersistedData,
} from "../../../scripts/contract-semantics.mjs";
import { validateAppleMusicImportRecords } from "./normalize.mjs";
import { AppleMusicImportError } from "./parse-plist.mjs";
import { isUuid } from "./stable-ids.mjs";

const dataFileNames = [
  "track-refs.ndjson",
  "track-snapshots.ndjson",
  "warnings.ndjson",
];

function fail(code, message, options) {
  throw new AppleMusicImportError(code, message, options);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function ndjson(records) {
  if (records.length === 0) return Buffer.alloc(0);
  return Buffer.from(`${records.map(canonicalizeJson).join("\n")}\n`, "utf8");
}

function buildFiles(records) {
  const fileRecords = new Map([
    ["track-refs.ndjson", records.trackRefs],
    ["track-snapshots.ndjson", records.trackSnapshots],
    ["warnings.ndjson", records.warnings],
  ]);

  return dataFileNames.map((name) => {
    const buffer = ndjson(fileRecords.get(name));
    return {
      name,
      buffer,
      descriptor: {
        name,
        sha256: sha256(buffer),
        bytes: buffer.length,
        records: fileRecords.get(name).length,
      },
    };
  });
}

async function pathType(target) {
  try {
    return await lstat(target);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw cause;
  }
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function prepareOutputRoot(outputRoot, boundaryRoot) {
  if (typeof boundaryRoot !== "string" || boundaryRoot.trim() === "") {
    throw new TypeError("Import output boundary is required");
  }
  const lexicalBoundary = path.resolve(boundaryRoot);
  const lexicalOutput = path.resolve(outputRoot);
  if (!isPathInside(lexicalBoundary, lexicalOutput)) {
    fail("output_boundary_invalid", "Import output root is outside its boundary");
  }

  const boundaryMetadata = await pathType(lexicalBoundary);
  if (
    !boundaryMetadata?.isDirectory() ||
    boundaryMetadata.isSymbolicLink()
  ) {
    fail("output_boundary_invalid", "Import output boundary must be a real directory");
  }
  const canonicalBoundary = await realpath(lexicalBoundary);
  const relativeSegments = path
    .relative(lexicalBoundary, lexicalOutput)
    .split(path.sep)
    .filter(Boolean);
  let current = lexicalBoundary;

  for (const segment of relativeSegments) {
    current = path.join(current, segment);
    let metadata = await pathType(current);
    if (!metadata) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (cause) {
        if (cause?.code !== "EEXIST") throw cause;
      }
      metadata = await pathType(current);
    }
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
      fail(
        "output_path_symlink_forbidden",
        "Import output path cannot contain symbolic links",
      );
    }
    const canonicalCurrent = await realpath(current);
    if (!isPathInside(canonicalBoundary, canonicalCurrent)) {
      fail("output_boundary_invalid", "Import output path escaped its boundary");
    }
  }

  await chmod(lexicalOutput, 0o700);
  return realpath(lexicalOutput);
}

async function writePrivateFile(filePath, buffer) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}

async function verifyExistingBatch(
  batchDirectory,
  expectedManifestBuffer,
  files,
) {
  const directoryMetadata = await pathType(batchDirectory);
  if (!directoryMetadata?.isDirectory() || directoryMetadata.isSymbolicLink()) {
    fail(
      "existing_batch_conflict",
      "Existing import batch path is not a private batch directory",
    );
  }
  if (
    process.platform !== "win32" &&
    (directoryMetadata.mode & 0o077) !== 0
  ) {
    fail("existing_batch_conflict", "Existing batch permissions are not private");
  }
  const expectedNames = [
    "manifest.json",
    ...files.map((file) => file.name),
  ].sort();
  const actualNames = (await readdir(batchDirectory)).sort();
  if (canonicalizeJson(actualNames) !== canonicalizeJson(expectedNames)) {
    fail("existing_batch_conflict", "Existing batch contains unexpected files");
  }

  try {
    const manifestPath = path.join(batchDirectory, "manifest.json");
    const manifestMetadata = await lstat(manifestPath);
    if (
      !manifestMetadata.isFile() ||
      manifestMetadata.isSymbolicLink() ||
      manifestMetadata.size !== expectedManifestBuffer.length ||
      (process.platform !== "win32" &&
        (manifestMetadata.mode & 0o077) !== 0)
    ) {
      fail("existing_batch_conflict", "Existing batch manifest is invalid");
    }
    const existingManifestBuffer = await readFile(manifestPath);
    if (!existingManifestBuffer.equals(expectedManifestBuffer)) {
      fail("existing_batch_conflict", "Existing batch manifest does not match");
    }
  } catch (cause) {
    if (cause instanceof AppleMusicImportError) throw cause;
    fail("existing_batch_conflict", "Existing batch manifest cannot be verified", {
      cause,
    });
  }

  for (const file of files) {
    const filePath = path.join(batchDirectory, file.name);
    const metadata = await pathType(filePath);
    if (
      !metadata?.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== file.buffer.length ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      fail("existing_batch_conflict", "Existing batch data file does not match");
    }
    if (sha256(await readFile(filePath)) !== file.descriptor.sha256) {
      fail("existing_batch_conflict", "Existing batch data file does not match");
    }
  }
}

export async function writeAppleMusicImportBatch(
  records,
  { outputRoot, boundaryRoot },
) {
  if (!isUuid(records?.manifest?.import_batch_id)) {
    fail("batch_id_invalid", "Import batch ID must be a UUID");
  }
  if (typeof outputRoot !== "string" || outputRoot.trim() === "") {
    throw new TypeError("Import output root is required");
  }

  await validateAppleMusicImportRecords(records);
  const files = buildFiles(records);
  const manifest = {
    ...records.manifest,
    files: files.map(({ descriptor }) => descriptor),
  };
  if (findUnsafePersistedData(manifest).length > 0) {
    fail("manifest_unsafe", "Import manifest failed persisted-data inspection");
  }
  const manifestBuffer = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const resolvedOutputRoot = await prepareOutputRoot(outputRoot, boundaryRoot);

  const batchDirectoryName = records.manifest.import_batch_id;
  const batchDirectory = path.join(resolvedOutputRoot, batchDirectoryName);
  const existing = await pathType(batchDirectory);
  if (existing) {
    await verifyExistingBatch(batchDirectory, manifestBuffer, files);
    return {
      status: "unchanged",
      batchDirectoryName,
      manifest,
    };
  }

  const temporaryDirectory = path.join(
    resolvedOutputRoot,
    `.${batchDirectoryName}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  await mkdir(temporaryDirectory, { mode: 0o700 });

  try {
    for (const file of files) {
      await writePrivateFile(
        path.join(temporaryDirectory, file.name),
        file.buffer,
      );
    }
    await writePrivateFile(
      path.join(temporaryDirectory, "manifest.json"),
      manifestBuffer,
    );
    await rename(temporaryDirectory, batchDirectory);
  } catch (cause) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    if (cause?.code === "EEXIST" || cause?.code === "ENOTEMPTY") {
      await verifyExistingBatch(batchDirectory, manifestBuffer, files);
      return {
        status: "unchanged",
        batchDirectoryName,
        manifest,
      };
    }
    if (cause instanceof AppleMusicImportError) throw cause;
    fail("batch_write_failed", "Private import batch could not be written", {
      cause,
    });
  }

  return {
    status: "written",
    batchDirectoryName,
    manifest,
  };
}
