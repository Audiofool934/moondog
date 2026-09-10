import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  readAppleMusicSourceStatus,
  resolveAppleMusicImportsRoot,
} from "../core/apple-library-source-status.mjs";
import {
  resolveAppleMusicSubjectId,
  resolveAppleMusicProjectionPath,
} from "../core/apple-projection-domain-services.mjs";
import { resolveSpotifyResolutionCachePath } from "../integrations/spotify/resolution-cache.mjs";
import { resolveListeningHistoryPath } from "./listening-history-store.mjs";

export const LOCAL_MUSIC_DATA_EXPORT_VERSION = "moondog-local-music-export/1";
export const LOCAL_MUSIC_DATA_RESET_VERSION = "moondog-local-music-reset/1";
export const LOCAL_MUSIC_DATA_SCOPES = Object.freeze([
  "listening",
  "apple",
  "profile",
]);
export const LOCAL_MUSIC_DATA_LIMITS = Object.freeze({
  maximum_files: 100_000,
  maximum_bytes: 5 * 1024 * 1024 * 1024,
});

const excludedState = Object.freeze([
  "conversation_memory",
  "model_settings",
  "oauth_credentials",
  "raw_provider_exports",
  "spotify_client_configuration",
]);
const sqliteSidecarSuffixes = ["-journal", "-shm", "-wal"];

let databaseConstructorPromise;

function databaseConstructor() {
  databaseConstructorPromise ??= import("node:sqlite").then(
    ({ DatabaseSync }) => DatabaseSync,
  );
  return databaseConstructorPromise;
}

function fail(code, message, options) {
  const error = new Error(message, options);
  error.name = "MoondogLocalMusicDataError";
  error.code = code;
  throw error;
}

function requireScope(scope) {
  if (!LOCAL_MUSIC_DATA_SCOPES.includes(scope)) {
    throw new TypeError(
      `Local music data scope must be one of: ${LOCAL_MUSIC_DATA_SCOPES.join(", ")}`,
    );
  }
  return scope;
}

async function optionalMetadata(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function privatePermissions(metadata) {
  return process.platform === "win32" || (metadata.mode & 0o077) === 0;
}

function safeTimestamp(value) {
  return new Date(value).toISOString().replaceAll(/[:.]/gu, "-");
}

function compareFingerprintEntries(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  if (left.kind < right.kind) return -1;
  if (left.kind > right.kind) return 1;
  return 0;
}

function contentFingerprint(entries) {
  const digest = createHash("sha256");
  for (const entry of [...entries].sort(compareFingerprintEntries)) {
    digest.update(JSON.stringify(entry));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function componentDefinitions(paths, scope) {
  const listening = [
    {
      id: "listening_history",
      kind: "sqlite",
      path: paths.listeningHistoryPath,
      exportPath: "listening/listening-history.sqlite",
    },
    {
      id: "spotify_resolution_cache",
      kind: "sqlite",
      path: paths.spotifyResolutionCachePath,
      exportPath: "listening/spotify-resolution-cache.sqlite",
    },
    {
      id: "tasteprints",
      kind: "directory",
      path: paths.tasteprintsPath,
      exportPath: "listening/tasteprints",
    },
  ];
  const apple = [
    {
      id: "apple_imports",
      kind: "directory",
      path: paths.appleImportsRoot,
      exportPath: "apple/imports",
    },
    {
      id: "apple_projection",
      kind: "sqlite",
      path: paths.appleProjectionPath,
      exportPath: "apple/projection.sqlite",
    },
  ];
  if (scope === "listening") return listening;
  if (scope === "apple") return apple;
  return [...listening, ...apple];
}

export function resolveLocalMusicDataPaths({
  environment = process.env,
  appleImportsRoot = resolveAppleMusicImportsRoot(environment),
  appleProjectionPath = resolveAppleMusicProjectionPath(environment),
} = {}) {
  const listeningHistoryPath = resolveListeningHistoryPath(environment);
  const spotifyResolutionCachePath = resolveSpotifyResolutionCachePath(environment);
  for (const [label, value] of Object.entries({
    listeningHistoryPath,
    spotifyResolutionCachePath,
    appleImportsRoot,
    appleProjectionPath,
  })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw new TypeError(`${label} must be an absolute path`);
    }
  }
  return {
    listeningHistoryPath: path.resolve(listeningHistoryPath),
    spotifyResolutionCachePath: path.resolve(spotifyResolutionCachePath),
    tasteprintsPath: path.join(
      path.dirname(path.resolve(listeningHistoryPath)),
      "tasteprints",
    ),
    appleImportsRoot: path.resolve(appleImportsRoot),
    appleProjectionPath: path.resolve(appleProjectionPath),
    stateRoot: path.dirname(path.resolve(listeningHistoryPath)),
  };
}

async function inspectDirectory(root) {
  const pending = [root];
  const confirmationEntries = [];
  let files = 0;
  let bytes = 0;
  let latestModifiedMs = 0;
  let permissionsPrivate = true;
  while (pending.length > 0) {
    const directory = pending.pop();
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      fail("local_music_data_unsafe", "Local music data contains an unsafe directory.");
    }
    permissionsPrivate &&= privatePermissions(directoryMetadata);
    latestModifiedMs = Math.max(latestModifiedMs, directoryMetadata.mtimeMs);
    confirmationEntries.push({
      kind: "directory",
      path: path.relative(root, directory).split(path.sep).join("/") || ".",
      mode: directoryMetadata.mode & 0o777,
    });
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const metadata = await lstat(entryPath);
      if (metadata.isSymbolicLink()) {
        fail("local_music_data_unsafe", "Local music data contains a symbolic link.");
      }
      if (metadata.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!metadata.isFile()) {
        fail("local_music_data_unsafe", "Local music data contains an unsupported entry.");
      }
      files += 1;
      bytes += metadata.size;
      permissionsPrivate &&= privatePermissions(metadata);
      latestModifiedMs = Math.max(latestModifiedMs, metadata.mtimeMs);
      confirmationEntries.push({
        kind: "file",
        path: path.relative(root, entryPath).split(path.sep).join("/"),
        mode: metadata.mode & 0o777,
        bytes: metadata.size,
        sha256: await digestFile(entryPath),
      });
      if (
        files > LOCAL_MUSIC_DATA_LIMITS.maximum_files ||
        bytes > LOCAL_MUSIC_DATA_LIMITS.maximum_bytes
      ) {
        fail("local_music_data_too_large", "Local music data exceeds the export limits.");
      }
    }
  }
  return {
    files,
    bytes,
    latestModifiedMs,
    permissionsPrivate,
    confirmation: {
      files,
      bytes,
      modified_at: new Date(latestModifiedMs).toISOString(),
      sha256: contentFingerprint(confirmationEntries),
    },
  };
}

async function inspectSqliteFamily(filePath) {
  const metadata = await optionalMetadata(filePath);
  const sidecars = [];
  for (const suffix of sqliteSidecarSuffixes) {
    const sidecarPath = `${filePath}${suffix}`;
    const sidecarMetadata = await optionalMetadata(sidecarPath);
    if (sidecarMetadata) sidecars.push({ path: sidecarPath, metadata: sidecarMetadata });
  }
  if (!metadata) {
    if (sidecars.length > 0) {
      fail(
        "local_music_data_unsafe",
        "Local music data contains an orphaned SQLite sidecar.",
      );
    }
    return null;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("local_music_data_unsafe", "Local music data contains an unsafe SQLite file.");
  }
  let bytes = metadata.size;
  let latestModifiedMs = metadata.mtimeMs;
  let permissionsPrivate = privatePermissions(metadata);
  let confirmationFiles = 1;
  let confirmationBytes = metadata.size;
  let confirmationModifiedMs = metadata.mtimeMs;
  const confirmationEntries = [{
    kind: "file",
    path: "database",
    mode: metadata.mode & 0o777,
    bytes: metadata.size,
    sha256: await digestFile(filePath),
  }];
  for (const sidecar of sidecars) {
    if (!sidecar.metadata.isFile() || sidecar.metadata.isSymbolicLink()) {
      fail("local_music_data_unsafe", "Local music data contains an unsafe SQLite sidecar.");
    }
    bytes += sidecar.metadata.size;
    latestModifiedMs = Math.max(latestModifiedMs, sidecar.metadata.mtimeMs);
    permissionsPrivate &&= privatePermissions(sidecar.metadata);
    if (!sidecar.path.endsWith("-shm") && sidecar.metadata.size > 0) {
      confirmationFiles += 1;
      confirmationBytes += sidecar.metadata.size;
      confirmationModifiedMs = Math.max(
        confirmationModifiedMs,
        sidecar.metadata.mtimeMs,
      );
      confirmationEntries.push({
        kind: "file",
        path: path.basename(sidecar.path).slice(path.basename(filePath).length),
        mode: sidecar.metadata.mode & 0o777,
        bytes: sidecar.metadata.size,
        sha256: await digestFile(sidecar.path),
      });
    }
  }
  return {
    files: 1 + sidecars.length,
    bytes,
    latestModifiedMs,
    permissionsPrivate,
    sidecars: sidecars.map((sidecar) => sidecar.path),
    confirmation: {
      files: confirmationFiles,
      bytes: confirmationBytes,
      modified_at: new Date(confirmationModifiedMs).toISOString(),
      sha256: contentFingerprint(confirmationEntries),
    },
  };
}

async function inspectComponent(definition) {
  const metadata = await optionalMetadata(definition.path);
  if (!metadata) {
    if (definition.kind === "sqlite") await inspectSqliteFamily(definition.path);
    const missingComponent = {
      id: definition.id,
      kind: definition.kind,
      path: definition.path,
      state: "missing",
      files: 0,
      bytes: 0,
      modified_at: null,
      private_permissions: null,
    };
    Object.defineProperty(missingComponent, "confirmation", {
      value: { files: 0, bytes: 0, modified_at: null, sha256: null },
    });
    return missingComponent;
  }
  const details = definition.kind === "directory"
    ? await inspectDirectory(definition.path)
    : await inspectSqliteFamily(definition.path);
  const component = {
    id: definition.id,
    kind: definition.kind,
    path: definition.path,
    state: "ready",
    files: details.files,
    bytes: details.bytes,
    modified_at: new Date(details.latestModifiedMs).toISOString(),
    private_permissions: details.permissionsPrivate,
  };
  Object.defineProperty(component, "confirmation", {
    value: details.confirmation ?? {
      files: details.files,
      bytes: details.bytes,
      modified_at: new Date(details.latestModifiedMs).toISOString(),
      sha256: null,
    },
  });
  return component;
}

async function sqliteReadTarget(filePath) {
  for (const suffix of ["-journal", "-wal"]) {
    const metadata = await optionalMetadata(`${filePath}${suffix}`);
    if (metadata?.size > 0) return filePath;
  }
  const target = pathToFileURL(filePath);
  target.searchParams.set("immutable", "1");
  return target;
}

async function listeningSubjectId(databasePath) {
  if (!(await optionalMetadata(databasePath))) return null;
  const DatabaseSync = await databaseConstructor();
  let database;
  try {
    database = new DatabaseSync(await sqliteReadTarget(databasePath), {
      readOnly: true,
    });
    const table = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'local_music_subject'",
      )
      .get();
    if (!table) fail("local_music_data_invalid", "Listening history has no subject registry.");
    const subjectId = database
      .prepare("SELECT subject_id FROM local_music_subject WHERE singleton = 1")
      .get()?.subject_id;
    return typeof subjectId === "string" ? subjectId.toLowerCase() : null;
  } catch (error) {
    if (error?.code?.startsWith?.("local_music_data_")) throw error;
    fail("local_music_data_invalid", "Listening history could not be inspected.", {
      cause: error,
    });
  } finally {
    database?.close();
  }
}

async function appleSubjectId(importsRoot) {
  if (!(await optionalMetadata(importsRoot))) return null;
  try {
    const status = await readAppleMusicSourceStatus(importsRoot);
    if (status.state === "missing") return null;
    if (status.state === "invalid") {
      fail("local_music_data_invalid", "Apple imports could not be inspected.");
    }
    return await resolveAppleMusicSubjectId({ importsRoot });
  } catch (error) {
    if (error?.code?.startsWith?.("local_music_data_")) throw error;
    fail("local_music_data_invalid", "Apple imports could not be inspected.", {
      cause: error,
    });
  }
}

function confirmationToken(value) {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      scope: value.scope,
      subject_ids: value.subject_ids,
      components: value.components.map((component) => ({
        id: component.id,
        path: component.path,
        state: component.state,
        files: component.confirmation.files,
        bytes: component.confirmation.bytes,
        modified_at: component.confirmation.modified_at,
        sha256: component.confirmation.sha256,
      })),
    }))
    .digest("hex")
    .slice(0, 16);
  return `reset-${value.scope}-${digest}`;
}

export async function inspectLocalMusicData({
  scope,
  paths = resolveLocalMusicDataPaths(),
} = {}) {
  const normalizedScope = requireScope(scope);
  const definitions = componentDefinitions(paths, normalizedScope);
  const components = [];
  for (const definition of definitions) {
    components.push(await inspectComponent(definition));
  }
  const subjectIds = [];
  if (new Set(["listening", "profile"]).has(normalizedScope)) {
    const subjectId = await listeningSubjectId(paths.listeningHistoryPath);
    if (subjectId) subjectIds.push(subjectId);
  }
  if (new Set(["apple", "profile"]).has(normalizedScope)) {
    const subjectId = await appleSubjectId(paths.appleImportsRoot);
    if (subjectId) subjectIds.push(subjectId);
  }
  const uniqueSubjectIds = [...new Set(subjectIds)].sort();
  const readyComponents = components.filter((component) => component.state === "ready");
  const totals = {
    components: readyComponents.length,
    files: readyComponents.reduce((sum, component) => sum + component.files, 0),
    bytes: readyComponents.reduce((sum, component) => sum + component.bytes, 0),
  };
  if (
    totals.files > LOCAL_MUSIC_DATA_LIMITS.maximum_files ||
    totals.bytes > LOCAL_MUSIC_DATA_LIMITS.maximum_bytes
  ) {
    fail("local_music_data_too_large", "Local music data exceeds the export limits.");
  }
  const result = {
    inspection_version: "moondog-local-music-inspection/2",
    scope: normalizedScope,
    state:
      uniqueSubjectIds.length > 1
        ? "subject_conflict"
        : readyComponents.length > 0
          ? "ready"
          : "empty",
    subject_id: uniqueSubjectIds.length === 1 ? uniqueSubjectIds[0] : null,
    subject_ids: uniqueSubjectIds,
    components,
    totals,
    excluded: [...excludedState],
    writes: "none",
  };
  return { ...result, reset_confirmation: confirmationToken(result) };
}

async function createSqliteSnapshot(sourcePath, destinationPath) {
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const DatabaseSync = await databaseConstructor();
  const database = new DatabaseSync(await sqliteReadTarget(sourcePath), {
    readOnly: true,
  });
  try {
    const escaped = destinationPath.replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    database.close();
  }
  if (process.platform !== "win32") await chmod(destinationPath, 0o600);
}

async function copyPrivateDirectory(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { mode: 0o700 });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const destinationPath = path.join(destinationRoot, entry.name);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) {
      fail("local_music_data_unsafe", "Local music data contains a symbolic link.");
    }
    if (metadata.isDirectory()) {
      await copyPrivateDirectory(sourcePath, destinationPath);
      continue;
    }
    if (!metadata.isFile()) {
      fail("local_music_data_unsafe", "Local music data contains an unsupported entry.");
    }
    await copyFile(sourcePath, destinationPath);
    if (process.platform !== "win32") await chmod(destinationPath, 0o600);
  }
}

async function digestFile(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function exportedFiles(root, directory = root) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      fail("local_music_data_unsafe", "The local music export contains a symbolic link.");
    }
    if (metadata.isDirectory()) {
      files.push(...await exportedFiles(root, entryPath));
      continue;
    }
    if (!metadata.isFile()) {
      fail("local_music_data_unsafe", "The local music export contains an unsupported entry.");
    }
    files.push({
      path: path.relative(root, entryPath).split(path.sep).join("/"),
      bytes: metadata.size,
      sha256: await digestFile(entryPath),
    });
  }
  return files;
}

async function writePrivateJson(filePath, value) {
  let handle;
  try {
    handle = await open(filePath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  if (process.platform !== "win32") await chmod(filePath, 0o600);
}

async function assertOutputAvailable(outputPath) {
  const parent = path.dirname(outputPath);
  const parentMetadata = await optionalMetadata(parent);
  if (!parentMetadata || !parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    fail(
      "local_music_export_parent_invalid",
      "The export parent must already exist as a real directory.",
    );
  }
  if (await optionalMetadata(outputPath)) {
    fail("local_music_export_exists", "The export destination already exists.");
  }
}

export async function exportLocalMusicData({
  scope,
  outputPath,
  paths = resolveLocalMusicDataPaths(),
  now = () => new Date(),
} = {}) {
  const normalizedScope = requireScope(scope);
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    throw new TypeError("Local music export requires an output directory path");
  }
  const resolvedOutput = path.resolve(outputPath);
  await assertOutputAvailable(resolvedOutput);
  const inspection = await inspectLocalMusicData({ scope: normalizedScope, paths });
  if (inspection.state === "subject_conflict") {
    fail("local_music_subject_conflict", "Local music sources use different subjects.");
  }
  if (inspection.state === "empty") {
    fail("local_music_data_empty", "The selected local music data scope is empty.");
  }

  const partialPath = `${resolvedOutput}.partial-${randomBytes(6).toString("hex")}`;
  await mkdir(partialPath, { mode: 0o700 });
  try {
    const components = componentDefinitions(paths, normalizedScope);
    for (const component of components) {
      if (!(await optionalMetadata(component.path))) continue;
      const destinationPath = path.join(
        partialPath,
        ...component.exportPath.split("/"),
      );
      if (component.kind === "sqlite") {
        await createSqliteSnapshot(component.path, destinationPath);
      } else {
        await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
        await copyPrivateDirectory(component.path, destinationPath);
      }
    }
    const finalInspection = await inspectLocalMusicData({
      scope: normalizedScope,
      paths,
    });
    if (finalInspection.reset_confirmation !== inspection.reset_confirmation) {
      fail(
        "local_music_export_source_changed",
        "Local music data changed during export. No export was created.",
      );
    }
    const files = await exportedFiles(partialPath);
    const manifest = {
      export_version: LOCAL_MUSIC_DATA_EXPORT_VERSION,
      created_at: now().toISOString(),
      scope: normalizedScope,
      subject_id: inspection.subject_id,
      source_confirmation: inspection.reset_confirmation,
      private: true,
      files,
      totals: {
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      },
      excluded: [...excludedState],
      restore: "manual_review_required",
    };
    const manifestPath = path.join(partialPath, "manifest.json");
    await writePrivateJson(manifestPath, manifest);
    const manifestSha256 = await digestFile(manifestPath);
    await rename(partialPath, resolvedOutput);
    if (process.platform !== "win32") await chmod(resolvedOutput, 0o700);
    return {
      export_version: LOCAL_MUSIC_DATA_EXPORT_VERSION,
      scope: normalizedScope,
      subject_id: inspection.subject_id,
      path: resolvedOutput,
      manifest_sha256: manifestSha256,
      files: files.length + 1,
      bytes: manifest.totals.bytes + (await lstat(path.join(resolvedOutput, "manifest.json"))).size,
      private: true,
      source_changed: false,
      excluded: [...excludedState],
    };
  } catch (error) {
    await rm(partialPath, { recursive: true, force: true });
    throw error;
  }
}

async function checkpointSqlite(filePath) {
  if (!(await optionalMetadata(filePath))) return;
  const DatabaseSync = await databaseConstructor();
  let database;
  try {
    database = new DatabaseSync(filePath);
    database.exec("PRAGMA busy_timeout = 1");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    fail(
      "local_music_data_busy",
      "Local music data is busy. Close Moondog Studio and other Moondog processes before reset.",
      { cause: error },
    );
  } finally {
    database?.close();
  }
  if (await optionalMetadata(`${filePath}-shm`)) {
    fail(
      "local_music_data_busy",
      "Local music data is still open in another process.",
    );
  }
}

async function resetTargets(definitions) {
  const targets = [];
  for (const definition of definitions) {
    if (definition.kind === "sqlite") {
      await checkpointSqlite(definition.path);
      for (const candidate of [
        definition.path,
        ...sqliteSidecarSuffixes.map((suffix) => `${definition.path}${suffix}`),
      ]) {
        const metadata = await optionalMetadata(candidate);
        if (!metadata) continue;
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          fail("local_music_data_unsafe", "Local music data contains an unsafe SQLite entry.");
        }
        targets.push({ component: definition.id, path: candidate });
      }
      continue;
    }
    const metadata = await optionalMetadata(definition.path);
    if (!metadata) continue;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail("local_music_data_unsafe", "Local music data contains an unsafe directory.");
    }
    targets.push({ component: definition.id, path: definition.path });
  }
  return targets;
}

export async function resetLocalMusicData({
  scope,
  confirmation,
  paths = resolveLocalMusicDataPaths(),
  now = () => new Date(),
} = {}) {
  const normalizedScope = requireScope(scope);
  if (typeof confirmation !== "string" || !confirmation.trim()) {
    throw new TypeError("Local music reset requires the exact inspection confirmation token");
  }
  const inspection = await inspectLocalMusicData({ scope: normalizedScope, paths });
  if (inspection.state === "subject_conflict") {
    fail("local_music_subject_conflict", "Local music sources use different subjects.");
  }
  if (inspection.state === "empty") {
    fail("local_music_data_empty", "The selected local music data scope is empty.");
  }
  if (confirmation !== inspection.reset_confirmation) {
    fail(
      "local_music_reset_confirmation_mismatch",
      "The reset confirmation does not match the current selected state. Inspect again before retrying.",
    );
  }

  const definitions = componentDefinitions(paths, normalizedScope);
  const targets = await resetTargets(definitions);
  const resetAt = now();
  const resetId = `${safeTimestamp(resetAt)}-${randomBytes(4).toString("hex")}`;
  const moves = targets.map((target) => ({
    ...target,
    archivePath: `${target.path}.moondog-reset-${resetId}`,
  }));
  for (const move of moves) {
    if (await optionalMetadata(move.archivePath)) {
      fail("local_music_reset_conflict", "A reset archive destination already exists.");
    }
  }

  const completed = [];
  try {
    for (const move of moves) {
      await rename(move.path, move.archivePath);
      completed.push(move);
    }
    const resetDirectory = path.join(paths.stateRoot, "reset-manifests");
    await mkdir(resetDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(resetDirectory, 0o700);
    const manifestPath = path.join(resetDirectory, `profile-reset-${resetId}.json`);
    await writePrivateJson(manifestPath, {
      reset_version: LOCAL_MUSIC_DATA_RESET_VERSION,
      reset_id: resetId,
      created_at: resetAt.toISOString(),
      scope: normalizedScope,
      subject_id: inspection.subject_id,
      confirmation: inspection.reset_confirmation,
      deletion: "none",
      archives: completed.map((move) => ({
        component: move.component,
        original_path: move.path,
        archive_path: move.archivePath,
      })),
      excluded: [...excludedState],
      restore: "rename_archives_to_original_paths_after_review",
    });
    for (const move of completed) {
      if (await optionalMetadata(move.path)) {
        fail(
          "local_music_data_busy",
          "A local music data path was recreated during reset. The archived copy was preserved.",
        );
      }
    }
    return {
      reset_version: LOCAL_MUSIC_DATA_RESET_VERSION,
      reset_id: resetId,
      scope: normalizedScope,
      subject_id: inspection.subject_id,
      state: "archived",
      deletion: "none",
      manifest_path: manifestPath,
      archives: completed.map((move) => ({
        component: move.component,
        path: move.archivePath,
      })),
      excluded: [...excludedState],
    };
  } catch (error) {
    for (const move of completed.reverse()) {
      if (!(await optionalMetadata(move.path))) {
        await rename(move.archivePath, move.path).catch(() => {});
      }
    }
    throw error;
  }
}
