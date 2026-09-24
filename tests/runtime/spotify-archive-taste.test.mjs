import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function extendedRecord(overrides = {}) {
  return {
    ts: "2026-08-29T04:00:42Z",
    ms_played: 305_000,
    master_metadata_track_name: "Roads",
    master_metadata_album_artist_name: "Portishead",
    master_metadata_album_album_name: "Dummy",
    spotify_track_uri: "spotify:track:1234567890123456789012",
    reason_start: "clickrow",
    reason_end: "trackdone",
    shuffle: false,
    skipped: false,
    offline: false,
    incognito_mode: false,
    ip_addr: "PRIVATE_IP_SENTINEL",
    platform: "PRIVATE_PLATFORM_SENTINEL",
    ...overrides,
  };
}

test("taste --from creates a private one-off Tasteprint without Apple setup or persistence", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-archive-taste-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Spotify Extended Streaming History");
  const archivePath = path.join(root, "spotify extended.zip");
  const outputPath = path.join(root, "output", "tasteprint.html");
  const cardPath = path.join(root, "output", "tasteprint-card.html");
  const stateRoot = path.join(root, "state");
  await mkdir(dataRoot);
  await writeFile(
    path.join(dataRoot, "Streaming_History_Audio_2026.json"),
    JSON.stringify([
      extendedRecord(),
      extendedRecord({
        ts: "2024-04-19T12:00:00Z",
        ms_played: 240_000,
        master_metadata_track_name: "Glory Box",
        spotify_track_uri: "spotify:track:abcdefghijklmnopqrstuv",
      }),
    ]),
  );
  await execFileAsync(
    "/usr/bin/zip",
    ["-q", "-r", archivePath, "Spotify Extended Streaming History"],
    { cwd: root },
  );

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "scripts/moondog.mjs",
      "taste",
      "--from",
      archivePath,
      "--html",
      "--output",
      outputPath,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        MOONDOG_STATE_HOME: stateRoot,
        MOONDOG_CONFIG_HOME: path.join(root, "config"),
      },
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  const html = await readFile(outputPath, "utf8");
  const mode = (await stat(outputPath)).mode & 0o777;
  assert.match(stdout, /Your listening report is ready/u);
  assert.match(stdout, /Read from 2 plays/u);
  assert.match(stdout, /From the Spotify Extended Streaming History you chose/u);
  assert.match(stdout, /Nothing was saved to your profile/u);
  assert.doesNotMatch(stderr, /PRIVATE_/u);
  assert.equal(mode, 0o600);
  assert.match(html, /Private Moondog Tasteprint/u);
  assert.match(html, /Year by year/u);
  assert.match(html, /2024/u);
  assert.match(html, /2026/u);
  assert.match(html, /one-off reading of the Spotify ZIP you chose/u);
  assert.doesNotMatch(html, /<script/iu);
  assert.doesNotMatch(html, /https?:\/\//iu);
  assert.doesNotMatch(html, /PRIVATE_/u);
  assert.doesNotMatch(html, /spotify:track:/u);
  assert.doesNotMatch(html, new RegExp(archivePath.replaceAll("\\", "\\\\"), "u"));

  const cardResult = await execFileAsync(
    process.execPath,
    [
      "scripts/moondog.mjs",
      "taste",
      "--from",
      archivePath,
      "--card",
      "--output",
      cardPath,
      "--json",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        MOONDOG_STATE_HOME: stateRoot,
        MOONDOG_CONFIG_HOME: path.join(root, "config"),
      },
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const cardArtifact = JSON.parse(cardResult.stdout);
  const cardHtml = await readFile(cardPath, "utf8");
  assert.equal(cardArtifact.artifact_version, "moondog-tasteprint-card-artifact/1");
  assert.equal(cardArtifact.artifact_format, "card");
  assert.equal(cardArtifact.source.persistent_import, false);
  assert.equal((await stat(cardPath)).mode & 0o777, 0o600);
  assert.match(cardHtml, /Private listening recap/u);
  assert.match(cardHtml, /Read it before you share it/u);
  assert.match(cardHtml, /Portishead, shining on/u);
  assert.doesNotMatch(cardHtml, /<script/iu);
  assert.doesNotMatch(cardHtml, /https?:\/\//iu);
  assert.doesNotMatch(cardHtml, /PRIVATE_/u);
  assert.doesNotMatch(cardHtml, /spotify:track:/u);
  assert.doesNotMatch(
    cardHtml,
    new RegExp(archivePath.replaceAll("\\", "\\\\"), "u"),
  );
  await assert.rejects(
    access(path.join(stateRoot, "listening-history.sqlite")),
    /ENOENT/u,
  );
});

test("taste --from --save persists one local identity and powers later taste commands", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-persistent-taste-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "Spotify Extended Streaming History");
  const archivePath = path.join(root, "spotify extended.zip");
  const outputPath = path.join(root, "output", "tasteprint.html");
  const stateRoot = path.join(root, "state");
  const environment = {
    ...process.env,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
  };
  await mkdir(dataRoot);
  await writeFile(
    path.join(dataRoot, "Streaming_History_Audio_2026.json"),
    JSON.stringify([
      extendedRecord(),
      extendedRecord({
        ts: "2024-04-19T12:00:00Z",
        ms_played: 240_000,
        master_metadata_track_name: "Glory Box",
        spotify_track_uri: "spotify:track:abcdefghijklmnopqrstuv",
      }),
    ]),
  );
  await execFileAsync(
    "/usr/bin/zip",
    ["-q", "-r", archivePath, "Spotify Extended Streaming History"],
    { cwd: root },
  );

  const first = await execFileAsync(
    process.execPath,
    [
      "scripts/moondog.mjs",
      "taste",
      "--from",
      archivePath,
      "--save",
      "--html",
      "--output",
      outputPath,
      "--json",
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const artifact = JSON.parse(first.stdout);
  assert.equal(artifact.source.persistent_import, true);
  assert.equal(artifact.source.already_imported, false);
  assert.equal(artifact.source.superseded_events, 0);
  assert.equal(artifact.coverage.effective_listening_events, 2);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(
    (await stat(path.join(stateRoot, "listening-history.sqlite"))).mode & 0o777,
    0o600,
  );

  const store = await openListeningHistoryStore({ environment });
  const localSubjectId = store.localSubjectId();
  assert.match(localSubjectId, /^[0-9a-f-]{36}$/u);
  assert.equal(
    store.subjectDataStatus({ subjectId: localSubjectId })
      .effective_listening_events,
    2,
  );
  store.close();

  const later = await execFileAsync(
    process.execPath,
    ["scripts/moondog.mjs", "taste", "--json"],
    {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const cumulativeProfile = JSON.parse(later.stdout);
  assert.equal(cumulativeProfile.coverage.effective_listening_events, 2);
  assert.equal(
    cumulativeProfile.listening_behavior.history_arc.length,
    2,
  );
  assert.equal(JSON.stringify(cumulativeProfile).includes(archivePath), false);
});
