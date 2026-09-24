import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveMoondogStateDirectory } from "./state-directory.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Earlier versions kept Apple Music data inside the source checkout.
export const legacyAppleMusicImportsRoot = path.join(
  repositoryRoot,
  "data",
  "imports",
  "apple-music-library",
);

export function defaultAppleMusicImportsRootFor(environment = process.env) {
  return path.join(resolveMoondogStateDirectory(environment), "apple-music-library", "imports");
}

export const defaultAppleMusicImportsRoot = defaultAppleMusicImportsRootFor();

export function resolveAppleMusicImportsRoot(environment = process.env) {
  const configured = environment.MOONDOG_APPLE_IMPORTS_ROOT?.trim();
  if (!configured) return defaultAppleMusicImportsRootFor(environment);
  if (!path.isAbsolute(configured)) {
    throw new TypeError("MOONDOG_APPLE_IMPORTS_ROOT must be an absolute path");
  }
  return path.resolve(configured);
}

const uuidDirectoryPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumManifestBytes = 256 * 1024;

function missingStatus() {
  return {
    source: "apple_music_library_xml",
    state: "missing",
    valid_batches: 0,
    invalid_batches: 0,
    latest: null,
    semantics: {
      library_snapshot_available: false,
      complete_listening_history_available: false,
      profile_materialization_ready: false,
    },
  };
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function requireCount(record, key) {
  const value = record?.[key];
  if (!isNonNegativeInteger(value)) {
    throw new Error("manifest_count_invalid");
  }
  return value;
}

function sanitizeManifest(manifest) {
  if (
    !manifest ||
    manifest.schema_version !== "apple-music-library-import-manifest/1"
  ) {
    throw new Error("manifest_schema_invalid");
  }

  const capturedAt = manifest.source?.captured_at;
  if (
    typeof capturedAt !== "string" ||
    !Number.isFinite(Date.parse(capturedAt))
  ) {
    throw new Error("manifest_timestamp_invalid");
  }

  if (
    typeof manifest.subject_id !== "string" ||
    !uuidDirectoryPattern.test(manifest.subject_id) ||
    manifest.semantics?.source_is_library_snapshot !== true ||
    manifest.semantics?.source_is_complete_listening_history !== false ||
    manifest.semantics?.aggregate_counts_expanded_into_events !== false ||
    manifest.semantics?.explicit_states_projected_into_taste_events !== false
  ) {
    throw new Error("manifest_semantics_invalid");
  }

  return {
    subject_id: manifest.subject_id.toLowerCase(),
    captured_at: new Date(capturedAt).toISOString(),
    tracks: requireCount(manifest.counts, "source_tracks"),
    playlists: requireCount(manifest.counts, "source_playlists"),
    playlist_item_references: requireCount(
      manifest.counts,
      "source_playlist_item_references",
    ),
    aggregate_track_snapshots: requireCount(
      manifest.counts,
      "aggregate_track_snapshots",
    ),
    listening_events: requireCount(
      manifest.counts,
      "core_listening_events",
    ),
    taste_events: requireCount(manifest.counts, "core_taste_events"),
    loved_or_favorited_coverage: requireCount(
      manifest.coverage,
      "loved_or_favorited",
    ),
    aggregate_play_count_coverage: requireCount(
      manifest.coverage,
      "aggregate_play_count",
    ),
  };
}

async function readPrivateManifest(batchDirectory) {
  const directoryMetadata = await lstat(batchDirectory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error("batch_directory_invalid");
  }

  const manifestPath = path.join(batchDirectory, "manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (
    !manifestMetadata.isFile() ||
    manifestMetadata.isSymbolicLink() ||
    manifestMetadata.size > maximumManifestBytes
  ) {
    throw new Error("manifest_file_invalid");
  }

  return sanitizeManifest(JSON.parse(await readFile(manifestPath, "utf8")));
}

export async function readAppleMusicSourceStatus(
  importsRoot = resolveAppleMusicImportsRoot(),
  operations = { lstat, readdir },
) {
  let rootMetadata;
  try {
    rootMetadata = await operations.lstat(importsRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return missingStatus();
    return { ...missingStatus(), state: "invalid", error: "source_unreadable" };
  }

  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    return { ...missingStatus(), state: "invalid", error: "source_root_invalid" };
  }

  let entries;
  try {
    entries = await operations.readdir(importsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return missingStatus();
    return { ...missingStatus(), state: "invalid", error: "source_unreadable" };
  }
  const candidateNames = entries
    .filter((entry) => uuidDirectoryPattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const valid = [];
  let invalidBatches = 0;

  for (const candidateName of candidateNames) {
    try {
      valid.push(
        await readPrivateManifest(path.join(importsRoot, candidateName)),
      );
    } catch {
      invalidBatches += 1;
    }
  }

  valid.sort((left, right) =>
    left.captured_at.localeCompare(right.captured_at),
  );
  const latest = valid.at(-1) ?? null;

  if (new Set(valid.map((manifest) => manifest.subject_id)).size > 1) {
    return {
      ...missingStatus(),
      state: "invalid",
      valid_batches: valid.length,
      invalid_batches: invalidBatches,
      error: "multiple_subjects",
    };
  }

  if (!latest) {
    return {
      ...missingStatus(),
      state: invalidBatches > 0 ? "invalid" : "missing",
      invalid_batches: invalidBatches,
      ...(invalidBatches > 0 ? { error: "no_valid_batches" } : {}),
    };
  }

  const { subject_id: ignoredSubjectId, ...safeLatest } = latest;
  void ignoredSubjectId;
  return {
    source: "apple_music_library_xml",
    state: invalidBatches > 0 ? "degraded" : "ready",
    valid_batches: valid.length,
    invalid_batches: invalidBatches,
    latest: safeLatest,
    semantics: {
      library_snapshot_available: true,
      complete_listening_history_available: false,
      profile_materialization_ready: false,
    },
  };
}
