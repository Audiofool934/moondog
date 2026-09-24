import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  projectTasteFromSpotifyArchives,
} from "../../src/profile/spotify-archive-taste.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function extendedRecord(overrides = {}) {
  return {
    ts: "2026-01-01T10:00:30Z",
    ms_played: 120_000,
    master_metadata_track_name: "Shared Signal",
    master_metadata_album_artist_name: "Archive Ensemble",
    master_metadata_album_album_name: "Resolved Record",
    spotify_track_uri: "spotify:track:1234567890123456789012",
    reason_start: "clickrow",
    reason_end: "trackdone",
    shuffle: false,
    skipped: false,
    offline: false,
    incognito_mode: false,
    ...overrides,
  };
}

async function createArchivePair(root) {
  const extendedRoot = path.join(root, "Spotify Extended Streaming History");
  const accountRoot = path.join(root, "Spotify Account Data");
  const extendedPath = path.join(root, "extended.zip");
  const accountPath = path.join(root, "account.zip");
  await mkdir(extendedRoot);
  await mkdir(accountRoot);
  await writeFile(
    path.join(extendedRoot, "Streaming_History_Audio_2026.json"),
    JSON.stringify([
      extendedRecord(),
      extendedRecord({
        ts: "2025-05-01T08:15:00Z",
        master_metadata_track_name: "Extended Only",
        spotify_track_uri: "spotify:track:abcdefghijklmnopqrstuv",
      }),
    ]),
  );
  await writeFile(
    path.join(accountRoot, "StreamingHistory_music_0.json"),
    JSON.stringify([
      {
        endTime: "2026-01-01 10:00",
        artistName: "Archive Ensemble",
        trackName: "Shared Signal",
        msPlayed: 120_000,
      },
      {
        endTime: "2024-03-01 07:30",
        artistName: "Archive Ensemble",
        trackName: "Shared Signal",
        msPlayed: 90_000,
      },
    ]),
  );
  await execFileAsync(
    "/usr/bin/zip",
    ["-q", "-r", extendedPath, "Spotify Extended Streaming History"],
    { cwd: root },
  );
  await execFileAsync(
    "/usr/bin/zip",
    ["-q", "-r", accountPath, "Spotify Account Data"],
    { cwd: root },
  );
  return { accountPath, extendedPath };
}

function aggregate(result) {
  return {
    source: result.source,
    coverage: result.profile.coverage,
    repeatTracks: result.profile.listening_behavior.repeat_tracks.map(
      ({ label, play_count: playCount }) => ({ label, playCount }),
    ),
  };
}

test("two Spotify archives reconcile in memory independently of selection order", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-archive-set-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { accountPath, extendedPath } = await createArchivePair(root);
  const capturedAt = "2026-09-03T12:00:00.000Z";

  const forward = await projectTasteFromSpotifyArchives({
    archivePaths: [accountPath, extendedPath],
    capturedAt,
  });
  const reverse = await projectTasteFromSpotifyArchives({
    archivePaths: [extendedPath, accountPath],
    capturedAt,
  });

  assert.deepEqual(aggregate(forward), aggregate(reverse));
  assert.equal(forward.source.archive_count, 2);
  assert.equal(forward.source.data_scope, "combined_spotify_history");
  assert.equal(forward.source.input_records, 4);
  assert.equal(forward.source.effective_listening_events, 3);
  assert.equal(forward.source.reconciled_overlap_events, 1);
  assert.equal(forward.profile.coverage.effective_listening_events, 3);
  assert.equal(forward.profile.coverage.cross_format_track_links, 1);
  assert.equal(forward.profile.coverage.cross_format_linked_events, 1);
  assert.match(
    forward.profile.limitations[0],
    /2 Spotify ZIPs you chose, combined/u,
  );
});

test("taste accepts two distinct --from archives without persistent state", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-archive-set-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { accountPath, extendedPath } = await createArchivePair(root);
  const stateRoot = path.join(root, "state");
  const environment = {
    ...process.env,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
  };

  const result = await execFileAsync(
    process.execPath,
    [
      "scripts/moondog.mjs",
      "taste",
      "--from",
      accountPath,
      "--from",
      extendedPath,
      "--json",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const profile = JSON.parse(result.stdout);
  assert.equal(profile.coverage.effective_listening_events, 3);
  assert.equal(profile.preview_source.archive_count, 2);
  assert.equal(profile.preview_source.reconciled_overlap_events, 1);
  assert.equal(profile.preview_source.persistent_import, false);
  assert.doesNotMatch(result.stdout, new RegExp(root, "u"));
  await assert.rejects(
    access(path.join(stateRoot, "listening-history.sqlite")),
    /ENOENT/u,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/moondog.mjs",
        "taste",
        "--from",
        accountPath,
        "--from",
        extendedPath,
        "--from",
        accountPath,
        "--json",
      ],
      { cwd: repositoryRoot, env: environment },
    ),
    /at most 2 times/u,
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        "scripts/moondog.mjs",
        "taste",
        "--from",
        accountPath,
        "--from",
        extendedPath,
        "--save",
        "--json",
      ],
      { cwd: repositoryRoot, env: environment },
    ),
    /in-memory preview/u,
  );
  await assert.rejects(
    access(path.join(stateRoot, "listening-history.sqlite")),
    /ENOENT/u,
  );
});

test("an archive set rejects the same selected ZIP twice", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-archive-set-duplicate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { extendedPath } = await createArchivePair(root);
  const copiedPath = path.join(root, "copied-extended.zip");
  await copyFile(extendedPath, copiedPath);
  await assert.rejects(
    projectTasteFromSpotifyArchives({
      archivePaths: [extendedPath, copiedPath],
    }),
    /must be distinct/u,
  );
});
