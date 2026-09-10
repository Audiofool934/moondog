import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  FICTIONAL_SPOTIFY_HISTORY_VERSION,
  createFictionalSpotifyHistoryArchive,
  fictionalSpotifyHistoryEntries,
  writeFictionalSpotifyHistoryArchive,
} from "../../src/demo/fictional-spotify-history.mjs";
import { readSpotifyHistoryArchive } from "../../src/integrations/spotify/history-archive.mjs";
import { projectTasteFromSpotifyArchive } from "../../src/profile/spotify-archive-taste.mjs";
import { startMoondogStudio } from "../../src/surfaces/web/studio.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const cliPath = path.join(repositoryRoot, "scripts", "moondog.mjs");
const subjectId = "10000000-0000-4000-8000-000000000001";
const capturedAt = "2026-09-03T00:00:00.000Z";
const expectedMembers = [2023, 2024, 2025, 2026].map(
  (year) =>
    `Spotify Extended Streaming History/Streaming_History_Audio_${year}.json`,
);
const allowedRecordFields = [
  "incognito_mode",
  "master_metadata_album_album_name",
  "master_metadata_album_artist_name",
  "master_metadata_track_name",
  "ms_played",
  "offline",
  "reason_end",
  "reason_start",
  "shuffle",
  "skipped",
  "spotify_track_uri",
  "ts",
].sort();

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function studioSession(studio) {
  return new URL(studio.url).searchParams.get("session");
}

async function postArchive(studio, archive) {
  return fetch(new URL("/api/import", studio.origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      Origin: studio.origin,
      "X-Moondog-Session": studioSession(studio),
    },
    body: archive,
  });
}

test("fictional Extended History is byte-stable, minimal, and powers the real Taste projection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-demo-history-"));
  try {
    const firstPath = path.join(root, "first.zip");
    const secondPath = path.join(root, "second.zip");
    const first = await writeFictionalSpotifyHistoryArchive({
      outputPath: firstPath,
    });
    const second = await writeFictionalSpotifyHistoryArchive({
      outputPath: secondPath,
    });
    const firstArchive = await readFile(firstPath);
    const secondArchive = await readFile(secondPath);

    assert.equal(first.schema, FICTIONAL_SPOTIFY_HISTORY_VERSION);
    assert.equal(first.record_count, 52);
    assert.deepEqual(first.years, [2023, 2024, 2025, 2026]);
    assert.deepEqual(first.members, expectedMembers);
    assert.deepEqual(first.boundaries, {
      fictional_demonstration_data_only: true,
      private_listener_data_read: false,
      network_requests: false,
      provider_actions: false,
      persistent_profile_writes: false,
    });
    assert.equal(first.archive_sha256, second.archive_sha256);
    assert.equal(
      first.archive_sha256,
      createHash("sha256").update(firstArchive).digest("hex"),
    );
    assert.deepEqual(firstArchive, secondArchive);
    assert.deepEqual(firstArchive, createFictionalSpotifyHistoryArchive());
    assert.equal(firstArchive.includes(Buffer.from("ip_addr")), false);
    assert.equal(firstArchive.includes(Buffer.from("platform")), false);
    assert.equal(firstArchive.includes(Buffer.from("conn_country")), false);
    assert.equal(firstArchive.includes(Buffer.from("username")), false);

    const entries = fictionalSpotifyHistoryEntries();
    assert.deepEqual(entries.map((entry) => entry.name), expectedMembers);
    for (const entry of entries) {
      const records = JSON.parse(entry.data.toString("utf8"));
      assert.equal(records.length, entry.records);
      for (const record of records) {
        assert.deepEqual(Object.keys(record).sort(), allowedRecordFields);
        assert.match(
          record.spotify_track_uri,
          /^spotify:track:MoondogDemoTrack[0-9]{6}$/u,
        );
      }
    }

    const listing = await execFileAsync(
      "/usr/bin/unzip",
      ["-Z1", firstPath],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.deepEqual(listing.stdout.trim().split(/\r?\n/u), expectedMembers);

    const bundle = await readSpotifyHistoryArchive({
      archivePath: firstPath,
      subjectId,
      capturedAt,
    });
    assert.equal(
      bundle.import_batch.source_format,
      "spotify_extended_streaming_history_music_v1",
    );
    assert.equal(bundle.import_batch.input_records, 52);
    assert.equal(bundle.listening_events.length, 52);
    assert.equal(bundle.track_refs.length, 14);

    const preview = await projectTasteFromSpotifyArchive({
      archivePath: firstPath,
      capturedAt,
      maxItems: 10,
    });
    assert.equal(preview.source.persistent_import, false);
    assert.equal(preview.profile.coverage.effective_listening_events, 52);
    assert.equal(preview.profile.coverage.listening_tracks, 14);
    assert.deepEqual(preview.profile.listening_behavior.session_summary, {
      source: "spotify_extended_history",
      method: "track_stop_gap",
      gap_minutes: 30,
      event_count: 52,
      session_count: 15,
      median_plays: 4,
      median_listening_minutes: 21,
      single_play_sessions: 3,
      short_sequence_sessions: 8,
      extended_sequence_sessions: 4,
      extended_sequence_minimum_plays: 5,
      extended_sequence_percent: 26.7,
      evidence_id:
        preview.profile.listening_behavior.session_summary.evidence_id,
    });
    assert.deepEqual(
      preview.profile.listening_behavior.release_depth.map((release) => ({
        title: release.title,
        artist_credit: release.artist_credit,
        distinct_tracks: release.distinct_tracks,
        active_years: release.active_years,
      })),
      [
        {
          title: "Pale Signals",
          artist_credit: "North Window",
          distinct_tracks: 3,
          active_years: 3,
        },
        {
          title: "Night Transit",
          artist_credit: "Mara Vale",
          distinct_tracks: 3,
          active_years: 3,
        },
      ],
    );
    assert.deepEqual(
      preview.profile.listening_behavior.time_capsule_tracks.map(
        (track) => [track.capsule_year, track.label, track.artist_credit],
      ),
      [
        [2023, "Midnight Lines", "Mara Vale"],
        [2024, "Glass Highway", "North Window"],
        [2025, "Blue Exit", "Ash Meridian"],
        [2026, "Northern Relay", "Drift Assembly"],
      ],
    );
    assert.ok(
      preview.profile.listening_behavior.rediscovery_tracks.some(
        (track) => track.label === "Quiet Coordinates" && track.quiet_days === 271,
      ),
    );
    assert.deepEqual(
      preview.profile.listening_behavior.historical_return_tracks.map(
        (track) => [
          track.label,
          track.return_count,
          track.longest_gap_days,
        ],
      ),
      [
        ["Quiet Coordinates", 2, 421],
        ["Glass Highway", 2, 318],
        ["Midnight Lines", 1, 732],
        ["Blue Exit", 1, 180],
      ],
    );

    if (process.platform !== "win32") {
      assert.equal((await lstat(firstPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fictional history generation refuses ambiguous or destructive destinations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-demo-history-safe-"));
  try {
    await assert.rejects(
      writeFictionalSpotifyHistoryArchive({ outputPath: "history.zip" }),
      /output path must be absolute/u,
    );
    await assert.rejects(
      writeFictionalSpotifyHistoryArchive({
        outputPath: path.join(root, "history.json"),
      }),
      /must use the \.zip extension/u,
    );
    await assert.rejects(
      writeFictionalSpotifyHistoryArchive({
        outputPath: path.join(root, "missing", "history.zip"),
      }),
      /destination parent does not exist/u,
    );

    const existingPath = path.join(root, "existing.zip");
    await writeFile(existingPath, "keep\n", { mode: 0o600 });
    await assert.rejects(
      writeFictionalSpotifyHistoryArchive({ outputPath: existingPath }),
      /destination already exists/u,
    );
    assert.equal(await readFile(existingPath, "utf8"), "keep\n");

    if (process.platform !== "win32") {
      const realParent = path.join(root, "real-parent");
      const linkedParent = path.join(root, "linked-parent");
      await mkdir(realParent, { mode: 0o700 });
      await symlink(realParent, linkedParent);
      await assert.rejects(
        writeFictionalSpotifyHistoryArchive({
          outputPath: path.join(linkedParent, "history.zip"),
        }),
        /destination parent is not a regular directory/u,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the installed-style CLI artifact works through one-off Taste and private Studio import", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-demo-history-cli-"));
  const stateRoot = path.join(root, "state");
  const environment = {
    ...process.env,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
    NO_COLOR: "1",
  };
  let studio = null;
  context.after(async () => {
    await studio?.close();
    await rm(root, { recursive: true, force: true });
  });

  const archivePath = path.join(root, "fictional-history.zip");
  const generated = await execFileAsync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      cliPath,
      "demo-history",
      "--output",
      archivePath,
      "--json",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  const manifest = JSON.parse(generated.stdout);
  assert.equal(manifest.schema, FICTIONAL_SPOTIFY_HISTORY_VERSION);
  assert.equal(manifest.archive_path, archivePath);
  assert.equal(manifest.record_count, 52);
  assert.equal(generated.stderr, "");
  assert.equal(await exists(stateRoot), false);

  const taste = await execFileAsync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      cliPath,
      "taste",
      "--from",
      archivePath,
      "--json",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  const profile = JSON.parse(taste.stdout);
  assert.equal(profile.preview_source.persistent_import, false);
  assert.equal(profile.coverage.effective_listening_events, 52);
  assert.deepEqual(
    profile.listening_behavior.time_capsule_tracks.map(
      (track) => track.capsule_year,
    ),
    [2023, 2024, 2025, 2026],
  );
  assert.deepEqual(
    profile.listening_behavior.historical_return_tracks.map(
      (track) => track.label,
    ),
    ["Quiet Coordinates", "Glass Highway", "Midnight Lines", "Blue Exit"],
  );
  assert.deepEqual(
    profile.listening_behavior.back_to_back_tracks.map((track) => ({
      label: track.label,
      maximum_consecutive_plays: track.maximum_consecutive_plays,
    })),
    [
      { label: "Glass Highway", maximum_consecutive_plays: 3 },
      { label: "Blue Exit", maximum_consecutive_plays: 3 },
      { label: "Midnight Lines", maximum_consecutive_plays: 3 },
    ],
  );
  assert.equal(await exists(stateRoot), false);

  const temporaryRoot = path.join(root, "studio-temporary");
  await mkdir(temporaryRoot, { mode: 0o700 });
  studio = await startMoondogStudio({
    environment,
    temporaryRoot,
    now: () => new Date(capturedAt),
  });
  const response = await postArchive(studio, await readFile(archivePath));
  const imported = await response.json();
  assert.equal(response.status, 200);
  assert.equal(imported.profile_kind, "private");
  assert.equal(imported.coverage.effective_listening_events, 52);
  assert.equal(imported.source.data_scope, "lifetime_extended_streaming_history");
  assert.equal(imported.time_machine.ready, true);
  assert.equal(imported.time_machine.landmark_count, 4);
  assert.equal(imported.historical_returns.ready, true);
  assert.equal(imported.historical_returns.return_track_count, 4);
  assert.equal(imported.historical_returns.minimum_gap_days, 180);
  assert.equal(imported.back_to_back.ready, true);
  assert.equal(imported.back_to_back.track_count, 3);
  assert.equal(imported.back_to_back.minimum_consecutive_plays, 2);
  assert.deepEqual(
    imported.time_machine.landmarks.map((landmark) => landmark.year),
    [2023, 2024, 2025, 2026],
  );
});
