import { mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveAppleMusicImportsRoot } from "../core/apple-library-source-status.mjs";
import { resolveAppleMusicProjectionPath } from "../core/apple-projection-domain-services.mjs";
import { writeAppleMusicImportBatch, rebuildAppleMusicSqliteProjection } from "../importers/apple-music-library/index.mjs";

export async function persistAppleLibraryImport(bundle, { environment = process.env } = {}) {
  const outputRoot = resolveAppleMusicImportsRoot(environment);
  const boundaryRoot = path.dirname(outputRoot);
  await mkdir(boundaryRoot, { recursive: true, mode: 0o700 });
  const result = await writeAppleMusicImportBatch(bundle, { outputRoot, boundaryRoot });
  return {
    provider: "apple-music-library",
    already_imported: result.status === "unchanged",
    library_tracks: result.manifest.counts.track_refs,
  };
}

export async function refreshAppleLibraryImport({ environment = process.env } = {}) {
  const databasePath = resolveAppleMusicProjectionPath(environment);
  // The existing writer requires its output to be below an existing boundary.
  const boundaryRoot = path.dirname(path.dirname(databasePath));
  await mkdir(boundaryRoot, { recursive: true, mode: 0o700 });
  return rebuildAppleMusicSqliteProjection({
    importsRoot: resolveAppleMusicImportsRoot(environment), databasePath, boundaryRoot,
  });
}
