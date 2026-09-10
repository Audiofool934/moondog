import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openSpotifyResolutionCache } from "../../src/integrations/spotify/resolution-cache.mjs";
import {
  exportLocalMusicData,
  inspectLocalMusicData,
  resetLocalMusicData,
  resolveLocalMusicDataPaths,
} from "../../src/profile/local-music-data.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";

function fixturePaths(root) {
  return resolveLocalMusicDataPaths({
    environment: {
      MOONDOG_STATE_HOME: path.join(root, "state"),
    },
    appleImportsRoot: path.join(root, "apple-imports"),
    appleProjectionPath: path.join(root, "apple-projection.sqlite"),
  });
}

async function missing(filePath) {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

test("Apple music data paths support absolute environment isolation", () => {
  const root = path.join(tmpdir(), "moondog-isolated-apple-state");
  const importsRoot = path.join(root, "imports");
  const projectionPath = path.join(root, "projection.sqlite");
  const paths = resolveLocalMusicDataPaths({
    environment: {
      MOONDOG_STATE_HOME: path.join(root, "state"),
      MOONDOG_APPLE_IMPORTS_ROOT: importsRoot,
      MOONDOG_APPLE_PROJECTION_PATH: projectionPath,
    },
  });

  assert.equal(paths.appleImportsRoot, importsRoot);
  assert.equal(paths.appleProjectionPath, projectionPath);
  assert.throws(
    () =>
      resolveLocalMusicDataPaths({
        environment: {
          MOONDOG_STATE_HOME: path.join(root, "state"),
          MOONDOG_APPLE_IMPORTS_ROOT: "relative-imports",
        },
      }),
    /MOONDOG_APPLE_IMPORTS_ROOT must be an absolute path/u,
  );
  assert.throws(
    () =>
      resolveLocalMusicDataPaths({
        environment: {
          MOONDOG_STATE_HOME: path.join(root, "state"),
          MOONDOG_APPLE_PROJECTION_PATH: "relative-projection.sqlite",
        },
      }),
    /MOONDOG_APPLE_PROJECTION_PATH must be an absolute path/u,
  );
});

async function populatedListeningFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-local-data-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const paths = fixturePaths(root);
  const store = await openListeningHistoryStore({
    databasePath: paths.listeningHistoryPath,
  });
  const subjectId = store.localSubjectId({ create: true });
  store.close();
  const cache = await openSpotifyResolutionCache({
    databasePath: paths.spotifyResolutionCachePath,
  });
  cache.close();
  await mkdir(paths.tasteprintsPath, { mode: 0o700 });
  const tasteprintPath = path.join(paths.tasteprintsPath, "current.html");
  await writeFile(tasteprintPath, "private tasteprint\n", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(tasteprintPath, 0o600);
  const memoryPath = path.join(paths.stateRoot, "memory.sqlite");
  await writeFile(memoryPath, "MEMORY_SENTINEL\n", { mode: 0o600 });
  return { root, paths, subjectId, tasteprintPath, memoryPath };
}

test("inspection is read-only and does not create an empty state root", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-local-data-empty-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const paths = fixturePaths(root);

  const value = await inspectLocalMusicData({ scope: "listening", paths });

  assert.equal(value.state, "empty");
  assert.equal(value.writes, "none");
  assert.equal(value.totals.files, 0);
  assert.match(value.reset_confirmation, /^reset-listening-[a-f0-9]{16}$/u);
  await missing(paths.stateRoot);
});

test("export creates a private consistent snapshot and leaves source state unchanged", async (context) => {
  const fixture = await populatedListeningFixture(context);
  const outputPath = path.join(fixture.root, "profile-export");
  const before = await inspectLocalMusicData({
    scope: "listening",
    paths: fixture.paths,
  });

  const result = await exportLocalMusicData({
    scope: "listening",
    outputPath,
    paths: fixture.paths,
    now: () => new Date("2026-09-02T04:05:06.000Z"),
  });

  assert.equal(result.source_changed, false);
  assert.equal(result.subject_id, fixture.subjectId);
  assert.equal(result.private, true);
  assert.match(result.manifest_sha256, /^[a-f0-9]{64}$/u);
  if (process.platform !== "win32") {
    assert.equal((await stat(outputPath)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(outputPath, "manifest.json"))).mode & 0o777,
      0o600,
    );
  }
  const manifest = JSON.parse(
    await readFile(path.join(outputPath, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.created_at, "2026-09-02T04:05:06.000Z");
  assert.equal(manifest.source_confirmation, before.reset_confirmation);
  assert.equal(manifest.restore, "manual_review_required");
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    [
      "listening/listening-history.sqlite",
      "listening/spotify-resolution-cache.sqlite",
      "listening/tasteprints/current.html",
    ],
  );
  assert.equal(
    manifest.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256)),
    true,
  );
  const { DatabaseSync } = await import("node:sqlite");
  const exportedDatabase = new DatabaseSync(
    path.join(outputPath, "listening", "listening-history.sqlite"),
    { readOnly: true },
  );
  try {
    assert.equal(
      exportedDatabase
        .prepare("SELECT subject_id FROM local_music_subject WHERE singleton = 1")
        .get().subject_id,
      fixture.subjectId,
    );
  } finally {
    exportedDatabase.close();
  }
  assert.equal(
    (await inspectLocalMusicData({ scope: "listening", paths: fixture.paths }))
      .reset_confirmation,
    before.reset_confirmation,
  );
  assert.equal(await readFile(fixture.memoryPath, "utf8"), "MEMORY_SENTINEL\n");
});

test("reset requires current exact confirmation and archives without deletion", async (context) => {
  const fixture = await populatedListeningFixture(context);
  const first = await inspectLocalMusicData({
    scope: "listening",
    paths: fixture.paths,
  });
  const originalTasteprintMetadata = await stat(fixture.tasteprintPath);
  await writeFile(fixture.tasteprintPath, "changed tasteprint\n", { mode: 0o600 });
  await utimes(
    fixture.tasteprintPath,
    originalTasteprintMetadata.atimeMs / 1_000,
    originalTasteprintMetadata.mtimeMs / 1_000,
  );
  const changedTasteprintMetadata = await stat(fixture.tasteprintPath);
  assert.equal(changedTasteprintMetadata.size, originalTasteprintMetadata.size);
  assert.equal(
    new Date(changedTasteprintMetadata.mtimeMs).toISOString(),
    new Date(originalTasteprintMetadata.mtimeMs).toISOString(),
  );
  const current = await inspectLocalMusicData({
    scope: "listening",
    paths: fixture.paths,
  });
  assert.notEqual(current.reset_confirmation, first.reset_confirmation);

  await assert.rejects(
    resetLocalMusicData({
      scope: "listening",
      confirmation: first.reset_confirmation,
      paths: fixture.paths,
    }),
    { code: "local_music_reset_confirmation_mismatch" },
  );
  await access(fixture.paths.listeningHistoryPath);
  const result = await resetLocalMusicData({
    scope: "listening",
    confirmation: current.reset_confirmation,
    paths: fixture.paths,
    now: () => new Date("2026-09-02T07:08:09.000Z"),
  });

  assert.equal(result.state, "archived");
  assert.equal(result.deletion, "none");
  assert.equal(result.archives.length, 3);
  assert.match(result.reset_id, /^2026-09-02T07-08-09-000Z-[a-f0-9]{8}$/u);
  for (const archive of result.archives) await access(archive.path);
  await missing(fixture.paths.listeningHistoryPath);
  await missing(fixture.paths.spotifyResolutionCachePath);
  await missing(fixture.paths.tasteprintsPath);
  assert.equal(await readFile(fixture.memoryPath, "utf8"), "MEMORY_SENTINEL\n");
  const manifest = JSON.parse(await readFile(result.manifest_path, "utf8"));
  assert.equal(manifest.deletion, "none");
  assert.equal(manifest.created_at, "2026-09-02T07:08:09.000Z");
  assert.equal(manifest.archives.length, 3);
  const after = await inspectLocalMusicData({
    scope: "listening",
    paths: fixture.paths,
  });
  assert.equal(after.state, "empty");
});

test("reset refuses a listening database that is still open", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-local-data-busy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const paths = fixturePaths(root);
  const store = await openListeningHistoryStore({
    databasePath: paths.listeningHistoryPath,
  });
  context.after(() => store.close());
  store.localSubjectId({ create: true });
  const inspection = await inspectLocalMusicData({ scope: "listening", paths });

  await assert.rejects(
    resetLocalMusicData({
      scope: "listening",
      confirmation: inspection.reset_confirmation,
      paths,
    }),
    { code: "local_music_data_busy" },
  );
  await access(paths.listeningHistoryPath);
});

test("inspection refuses symbolic links inside managed music state", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX symbolic-link safety test");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "moondog-local-data-link-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const paths = fixturePaths(root);
  await mkdir(paths.tasteprintsPath, { recursive: true, mode: 0o700 });
  const outside = path.join(root, "outside.html");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(paths.tasteprintsPath, "linked.html"));

  await assert.rejects(
    inspectLocalMusicData({ scope: "listening", paths }),
    { code: "local_music_data_unsafe" },
  );
});
