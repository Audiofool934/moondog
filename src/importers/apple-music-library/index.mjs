import { readAppleMusicLibrary } from "./parse-plist.mjs";
import {
  normalizeAppleMusicLibrary,
  summarizeAppleMusicLibrary,
} from "./normalize.mjs";
import { writeAppleMusicImportBatch } from "./import-batch.mjs";

export {
  AppleMusicImportError,
  DEFAULT_APPLE_LIBRARY_LIMITS,
  parseAppleMusicLibraryBuffer,
  readAppleMusicLibrary,
} from "./parse-plist.mjs";
export {
  normalizeAppleMusicLibrary,
  summarizeAppleMusicLibrary,
} from "./normalize.mjs";
export { writeAppleMusicImportBatch } from "./import-batch.mjs";
export {
  listAppleMusicImportBatches,
  readAppleMusicImportBatch,
} from "./read-batch.mjs";
export {
  APPLE_PROFILE_RULES,
  APPLE_PROFILE_RULES_VERSION,
  computeAppleProjectionInputDigest,
  promoteAppleMusicImportBatches,
} from "./projection-records.mjs";
export {
  APPLE_LIBRARY_SEARCH_HARD_LIMIT,
  APPLE_PROFILE_SUMMARY_HARD_LIMIT,
  APPLE_SQLITE_PROJECTION_VERSION,
  computeAppleSqliteLogicalDigest,
  defaultAppleMusicProjectionPath,
  defaultAppleMusicProjectionPathFor,
  legacyAppleMusicProjectionPath,
  openAppleMusicSqliteProjection,
  rebuildAppleMusicSqliteProjection,
} from "./sqlite-projection.mjs";
export {
  APPLE_LIBRARY_BATCH_NAMESPACE,
  APPLE_LIBRARY_CANONICAL_TRACK_NAMESPACE,
  APPLE_LIBRARY_OBSERVATION_NAMESPACE,
  APPLE_LIBRARY_PROFILE_EVIDENCE_NAMESPACE,
  APPLE_LIBRARY_SNAPSHOT_NAMESPACE,
  APPLE_LIBRARY_TRACK_NAMESPACE,
  isUuid,
  uuidV5,
} from "./stable-ids.mjs";

export async function inspectAppleMusicLibraryFile(inputPath, options = {}) {
  const parsed = await readAppleMusicLibrary(inputPath, options);
  return summarizeAppleMusicLibrary(parsed);
}

export async function buildAppleMusicLibraryImport(
  inputPath,
  { subjectId, limits } = {},
) {
  const parsed = await readAppleMusicLibrary(inputPath, { limits });
  return normalizeAppleMusicLibrary(parsed, { subjectId });
}

export async function importAppleMusicLibraryFile(
  inputPath,
  { subjectId, outputRoot, outputBoundary, limits } = {},
) {
  const records = await buildAppleMusicLibraryImport(inputPath, {
    subjectId,
    limits,
  });
  return writeAppleMusicImportBatch(records, {
    outputRoot,
    boundaryRoot: outputBoundary,
  });
}
