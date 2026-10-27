import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { scanForbiddenContent } from "./release-tree-policy.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// Each language adds about 30 KB packed (conversation and screen catalogs).
const maximumPackedBytes = 2_600_000;
// The Apache-2.0 LICENSE file adds one entry and about 11 KB; the Spotify
// library import adds one more entry and about 20 KB; the language module
// adds five entries and about 35 KB, mostly message catalogs. Screen text
// catalogs add about 100 KB and one entry per language; Japanese and
// Portuguese add four entries and about 250 KB. The terminal preview player
// adds one entry and about 15 KB. The Last.fm import adds two entries and
// about 40 KB. The seasons chart and the desktop app's hooks add one entry and
// about 5 KB. The shared check for unrecorded listening measures adds one
// entry and about 1 KB. Replies in Traditional Chinese, Korean, French,
// German and Italian add five entries and about 60 KB. The local tool trace
// adds one entry and about 2 KB. Web search through DeepSeek and Brave adds
// four entries and about 33 KB. The desktop window's model settings and
// playback preference add two entries and about 27 KB.
const maximumUnpackedBytes = 5_210_000;
const maximumEntries = 151;
const packageOnlyPrivateSentinelPattern = new RegExp(
  ["PRIVATE", "(?:IP|PLATFORM)", "SENTINEL"].join("_"),
  "u",
);
const requiredPackagePaths = new Set([
  "LICENSE",
  "README.md",
  "assets/brand/moondog-logo.svg",
  "contracts/v1/definitions.schema.json",
  "contracts/v2/profile-evidence.schema.json",
  "package.json",
  "scripts/contract-lib.mjs",
  "scripts/contract-semantics.mjs",
  "scripts/moondog",
  "scripts/moondog.mjs",
  "src/demo/fictional-spotify-history.mjs",
  "src/demo/moondog-demo.mjs",
  "src/integrations/cross-catalog-artist-identity.mjs",
  "src/integrations/lyrics/lrclib.mjs",
  "src/core/lyric-library.mjs",
  "src/core/lyric-profile.mjs",
  "src/core/lyric-service.mjs",
  "src/core/spotify-listening-intent.mjs",
  "src/core/application-update.mjs",
  "src/surfaces/cli/update-command.mjs",
  "src/integrations/listenbrainz/history-file.mjs",
  "src/integrations/public-playlists.mjs",
  "src/integrations/youtube-music/takeout.mjs",
  "src/profile/music-import-bundle.mjs",
  "src/profile/music-providers.mjs",
  "src/profile/profile-exploration.mjs",
  "src/profile/listener-profile-build.mjs",
  "src/profile/listener-profile-store.mjs",
  "src/profile/listener-profile-worker.mjs",
  "src/profile/listener-profile-verification.mjs",
  "src/runtime/pi/profile-build-runtime.mjs",
  "src/surfaces/cli/listener-profile-command.mjs",
  "src/runtime/pi/skills/listener-profile/SKILL.md",
  "src/profile/listener-corrections.mjs",
  "src/profile/local-music-data.mjs",
  "src/profile/spotify-archive-catalog-hints.mjs",
  "src/surfaces/cli/catalog-command.mjs",
  "src/surfaces/cli/data-command.mjs",
  "src/surfaces/cli/listenbrainz-command.mjs",
  "src/surfaces/cli/profile-command.mjs",
]);
const exactAllowedPackagePaths = new Set([
  "README.md",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "NOTICE",
  "package.json",
  "assets/brand/moondog-logo.svg",
  "scripts/contract-lib.mjs",
  "scripts/contract-semantics.mjs",
  "scripts/moondog",
  "scripts/moondog.mjs",
  "src/demo/fictional-spotify-history.mjs",
  "src/demo/moondog-demo.mjs",
]);
const allowedPackagePrefixes = [
  "contracts/v1/",
  "contracts/v2/",
  "src/core/",
  "src/i18n/",
  "src/importers/",
  "src/integrations/",
  "src/memory/",
  "src/profile/",
  "src/runtime/",
  "src/surfaces/",
];
const forbiddenReleaseExtensions = new Set([
  ".db",
  ".env",
  ".log",
  ".musiclibrary",
  ".sqlite",
  ".sqlite3",
  ".tgz",
  ".xml",
  ".zip",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function npmCommand(args) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? { command: process.execPath, args: [npmExecPath, ...args] }
    : { command: "npm", args };
}

async function runNpm(args, options = {}) {
  const invocation = npmCommand(args);
  return execFileAsync(invocation.command, invocation.args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 180_000,
    ...options,
  });
}

function isAllowedPackagePath(filePath) {
  return exactAllowedPackagePaths.has(filePath) ||
    allowedPackagePrefixes.some((prefix) => filePath.startsWith(prefix));
}

function validatePackManifest(pack) {
  assert(pack && typeof pack === "object", "npm pack returned no package record.");
  assert(pack.name === "@audiofool/moondog", "npm pack returned the wrong package name.");
  assert(Number.isInteger(pack.size) && pack.size <= maximumPackedBytes, "The packed Moondog package is unexpectedly large.");
  assert(
    Number.isInteger(pack.unpackedSize) && pack.unpackedSize <= maximumUnpackedBytes,
    "The unpacked Moondog package is unexpectedly large.",
  );
  assert(
    Number.isInteger(pack.entryCount) && pack.entryCount <= maximumEntries,
    "The Moondog package contains too many files.",
  );
  assert(Array.isArray(pack.files), "npm pack returned no file manifest.");

  const paths = pack.files.map((file) => file?.path);
  assert(paths.every((filePath) => typeof filePath === "string"), "npm pack returned an invalid file path.");
  assert(new Set(paths).size === paths.length, "The Moondog package contains duplicate paths.");
  for (const requiredPath of requiredPackagePaths) {
    assert(paths.includes(requiredPath), `The Moondog package is missing ${requiredPath}.`);
  }
  for (const filePath of paths) {
    assert(isAllowedPackagePath(filePath), `The Moondog package unexpectedly contains ${filePath}.`);
    assert(!filePath.includes(".."), `The Moondog package contains an unsafe path: ${filePath}.`);
    assert(!forbiddenReleaseExtensions.has(path.extname(filePath).toLocaleLowerCase("en-US")), `The Moondog package contains a forbidden file type: ${filePath}.`);
  }
  return paths;
}

async function validateExtractedPackage(packageRoot, manifestPaths) {
  for (const relativePath of manifestPaths) {
    const absolutePath = path.join(packageRoot, ...relativePath.split("/"));
    const metadata = await lstat(absolutePath);
    assert(metadata.isFile(), `The packed path is not a regular file: ${relativePath}.`);
    assert(!metadata.isSymbolicLink(), `The packed path is a symbolic link: ${relativePath}.`);
    if (relativePath.endsWith(".png")) continue;
    const source = await readFile(absolutePath);
    const issues = scanForbiddenContent(source);
    if (packageOnlyPrivateSentinelPattern.test(source.toString("latin1"))) {
      issues.push("private test sentinel");
    }
    assert(
      issues.length === 0,
      `The packed file ${relativePath} contains ${issues.join(", ")}.`,
    );
  }
}

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
    ...overrides,
  };
}

async function createSyntheticArchive(root) {
  const sourceDirectory = path.join(root, "Spotify Extended Streaming History");
  const archivePath = path.join(root, "synthetic-extended-history.zip");
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(sourceDirectory, "Streaming_History_Audio_2026.json"),
    JSON.stringify([
      extendedRecord(),
      extendedRecord({
        ts: "2024-04-19T12:00:00Z",
        ms_played: 240_000,
        master_metadata_track_name: "Glory Box",
        spotify_track_uri: "spotify:track:abcdefghijklmnopqrstuv",
      }),
    ]),
    { mode: 0o600 },
  );
  await execFileAsync("/usr/bin/zip", [
    "-q",
    "-r",
    archivePath,
    "Spotify Extended Streaming History",
  ], {
    cwd: root,
    timeout: 30_000,
  });
  return archivePath;
}

async function createSyntheticAccountArchive(root) {
  const sourceDirectory = path.join(root, "Spotify Account Data");
  const archivePath = path.join(root, "synthetic-account-data.zip");
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(sourceDirectory, "StreamingHistory_music_0.json"),
    JSON.stringify([
      {
        endTime: "2026-08-29 04:00",
        artistName: "Portishead",
        trackName: "Roads",
        msPlayed: 305_000,
      },
      {
        endTime: "2024-04-19 12:00",
        artistName: "Portishead",
        trackName: "Glory Box",
        msPlayed: 240_000,
      },
      {
        endTime: "2025-07-01 12:00",
        artistName: "Portishead",
        trackName: "Roads",
        msPlayed: 90_000,
      },
    ]),
    { mode: 0o600 },
  );
  await execFileAsync("/usr/bin/zip", [
    "-q",
    "-r",
    archivePath,
    "Spotify Account Data",
  ], {
    cwd: root,
    timeout: 30_000,
  });
  return archivePath;
}

async function createSyntheticListenBrainzFile(
  root,
  {
    fileName = "synthetic-listenbrainz-history.json",
    userSentinel = "PRIVATE_LISTENBRAINZ_PACKAGE_SENTINEL",
    listenedAtOffsetSeconds = 0,
  } = {},
) {
  const filePath = path.join(root, fileName);
  await writeFile(
    filePath,
    JSON.stringify({
      payload: {
        count: 2,
        user_id: userSentinel,
        listens: [
          {
            listened_at: 1_730_419_200 + listenedAtOffsetSeconds,
            recording_msid: "fd0cad33-ea33-453b-8155-1292379277db",
            user_name: userSentinel,
            track_metadata: {
              artist_name: "Björk",
              track_name: "Jóga",
              release_name: "Homogenic",
              additional_info: {
                duration_ms: 307_000,
                duration_played: 280,
                origin_url: "https://private.example/package-sentinel",
              },
              mbid_mapping: {
                recording_mbid: "30d08f4c-d825-4ae1-b79c-44242cddd7c0",
              },
            },
          },
          {
            listened_at: 1_733_011_200 + listenedAtOffsetSeconds,
            track_metadata: {
              artist_name: "Massive Attack",
              track_name: "Teardrop",
            },
          },
        ],
      },
    }),
    { mode: 0o600 },
  );
  return filePath;
}

async function verifyInstalledPackage({ consumerRoot, tarballPath }) {
  const npmCacheRoot = path.join(consumerRoot, "npm-cache");
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify({ name: "moondog-package-consumer", private: true }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--cache",
    npmCacheRoot,
    tarballPath,
  ], { cwd: consumerRoot });

  const installedRoot = path.join(
    consumerRoot,
    "node_modules",
    "@audiofool",
    "moondog",
  );
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  assert(installedPackage.private !== true, "The published package must not be marked private.");
  assert(
    JSON.stringify(installedPackage.os) === JSON.stringify(["darwin", "linux"]),
    "The package platform boundary changed unexpectedly.",
  );
  assert(installedPackage.dependencies?.ajv === "8.20.0", "Ajv is not a runtime dependency.");
  assert(
    installedPackage.dependencies?.["ajv-formats"] === "3.0.1",
    "Ajv formats is not a runtime dependency.",
  );

  const binaryPath = path.join(consumerRoot, "node_modules", ".bin", "moondog");
  const stateRoot = path.join(consumerRoot, "state");
  const configRoot = path.join(consumerRoot, "config");
  const consumerTemporaryRoot = path.join(consumerRoot, "temporary");
  await mkdir(consumerTemporaryRoot, { recursive: true, mode: 0o700 });
  const environment = {
    ...process.env,
    MOONDOG_CONFIG_HOME: configRoot,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_APPLE_IMPORTS_ROOT: path.join(consumerRoot, "apple-imports"),
    MOONDOG_APPLE_PROJECTION_PATH: path.join(
      consumerRoot,
      "apple-projection.sqlite",
    ),
    NO_COLOR: "1",
    TMPDIR: consumerTemporaryRoot,
  };

  const help = await execFileAsync(binaryPath, ["help"], {
    cwd: consumerRoot,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert(
    help.stdout.includes("moondog taste --from <account-data.zip> --from <extended-history.zip> --html"),
    "The installed CLI help has no two-archive in-memory reconciliation path.",
  );
  assert(
    help.stdout.includes("moondog taste --from <spotify-history.zip> --save --html"),
    "The installed CLI help has no saved Spotify import path.",
  );
  assert(help.stdout.includes("moondog demo-history"), "The installed CLI help has no fictional importer path.");
  assert(help.stdout.includes("moondog data inspect"), "The installed CLI help has no local data control path.");
  assert(help.stdout.includes("moondog profile correct"), "The installed CLI help has no listener correction path.");
  assert(help.stdout.includes("moondog listenbrainz import-history"), "The installed CLI help has no ListenBrainz import path.");
  assert(
    help.stdout.includes("moondog catalog latest-single") &&
      help.stdout.includes("--from <spotify-history.zip>"),
    "The installed CLI help has no archive-assisted public catalog path.",
  );
  assert(help.stdout.includes("moondog taste --card"), "The installed CLI help has no Tasteprint card path.");
  assert(!help.stderr, "The installed CLI help wrote an unexpected error.");

  const catalogHelp = await execFileAsync(binaryPath, ["catalog", "help"], {
    cwd: consumerRoot,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert(
    catalogHelp.stdout.includes("without a model") &&
      catalogHelp.stdout.includes("--artist-page <Apple Music artist URL>") &&
      catalogHelp.stdout.includes("select one public artist page") &&
      catalogHelp.stdout.includes("exact Wikidata label or alias") &&
      catalogHelp.stdout.includes("--from <spotify-history.zip>") &&
      catalogHelp.stdout.includes("does not send a personal profile or private archive"),
    "The installed catalog help omits its no-model privacy boundary.",
  );
  assert(!catalogHelp.stderr, "The installed catalog help wrote an unexpected error.");
  assert(
    !(await pathExists(stateRoot)) && !(await pathExists(configRoot)),
    "The installed catalog help initialized private state or configuration.",
  );

  const fictionalHistoryPath = path.join(
    consumerRoot,
    "moondog-fictional-history.zip",
  );
  const fictionalHistoryGeneration = await execFileAsync(
    binaryPath,
    [
      "demo-history",
      "--output",
      fictionalHistoryPath,
      "--json",
    ],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  const fictionalHistory = JSON.parse(fictionalHistoryGeneration.stdout);
  assert(
    fictionalHistory.schema === "moondog-fictional-spotify-history/2",
    "The installed fictional history generator returned the wrong schema.",
  );
  assert(
    fictionalHistory.archive_path === fictionalHistoryPath &&
      fictionalHistory.record_count === 52,
    "The installed fictional history generator returned the wrong artifact.",
  );
  assert(
    JSON.stringify(fictionalHistory.boundaries) ===
      JSON.stringify({
        fictional_demonstration_data_only: true,
        private_listener_data_read: false,
        network_requests: false,
        provider_actions: false,
        persistent_profile_writes: false,
      }),
    "The installed fictional history generator lost its privacy boundary.",
  );
  assert(
    /^[a-f0-9]{64}$/u.test(fictionalHistory.archive_sha256),
    "The installed fictional history generator returned no archive digest.",
  );
  const fictionalHistoryFile = await lstat(fictionalHistoryPath);
  assert(
    fictionalHistoryFile.isFile() && !fictionalHistoryFile.isSymbolicLink(),
    "The installed fictional history artifact is not a regular file.",
  );
  if (process.platform !== "win32") {
    assert(
      (fictionalHistoryFile.mode & 0o777) === 0o600,
      "The installed fictional history artifact is not mode 0600.",
    );
  }
  assert(
    !(await pathExists(stateRoot)),
    "The installed fictional history generator initialized private state.",
  );

  const fictionalTasteResult = await execFileAsync(
    binaryPath,
    ["taste", "--from", fictionalHistoryPath, "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  const fictionalTaste = JSON.parse(fictionalTasteResult.stdout);
  assert(
    fictionalTaste.preview_source?.persistent_import === false &&
      fictionalTaste.coverage?.effective_listening_events === 52,
    "The installed fictional history did not complete the one-off Taste path.",
  );
  assert(
    JSON.stringify(
      fictionalTaste.listening_behavior?.time_capsule_tracks?.map(
        (track) => track.capsule_year,
      ),
    ) === JSON.stringify([2023, 2024, 2025, 2026]),
    "The installed fictional history did not produce the four-year Time Machine.",
  );
  assert(
    fictionalTaste.listening_behavior?.back_to_back_tracks?.length === 3 &&
      fictionalTaste.listening_behavior.back_to_back_tracks.every(
        (track) => track.maximum_consecutive_plays === 3,
      ),
    "The installed fictional history did not produce three bounded played-back-to-back tracks.",
  );
  assert(
    !(await pathExists(stateRoot)),
    "The installed one-off fictional Taste path initialized private state.",
  );

  const archiveSetRoot = path.join(consumerRoot, "spotify-archive-set");
  const archiveSetExtendedPath = await createSyntheticArchive(archiveSetRoot);
  const archiveSetAccountPath = await createSyntheticAccountArchive(
    archiveSetRoot,
  );
  const archiveSetExtendedBefore = await stat(archiveSetExtendedPath);
  const archiveSetAccountBefore = await stat(archiveSetAccountPath);
  const archiveSetTasteResult = await execFileAsync(
    binaryPath,
    [
      "taste",
      "--from",
      archiveSetAccountPath,
      "--from",
      archiveSetExtendedPath,
      "--json",
    ],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  const archiveSetTaste = JSON.parse(archiveSetTasteResult.stdout);
  assert(
    archiveSetTaste.coverage?.effective_listening_events === 3 &&
      archiveSetTaste.coverage?.cross_format_track_links === 1 &&
      archiveSetTaste.coverage?.cross_format_linked_events === 1 &&
      archiveSetTaste.preview_source?.archive_count === 2 &&
      archiveSetTaste.preview_source?.reconciled_overlap_events === 2 &&
      archiveSetTaste.preview_source?.persistent_import === false,
    "The installed two-archive Taste path did not reconcile both exports in memory.",
  );
  assert(
    !archiveSetTasteResult.stdout.includes(archiveSetAccountPath) &&
      !archiveSetTasteResult.stdout.includes(archiveSetExtendedPath) &&
      !(await pathExists(stateRoot)),
    "The installed two-archive Taste path exposed a source path or initialized persistent state.",
  );

  const emptyDataInspection = await execFileAsync(
    binaryPath,
    ["data", "inspect", "--scope", "listening", "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  const emptyData = JSON.parse(emptyDataInspection.stdout);
  assert(emptyData.state === "empty", "The installed data inspection reported unexpected state.");
  assert(emptyData.writes === "none", "The installed data inspection did not remain read-only.");
  assert(!(await pathExists(stateRoot)), "The installed data inspection initialized local state.");

  const demo = await execFileAsync(binaryPath, ["demo", "--offline", "--json"], {
    cwd: consumerRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  const demoResult = JSON.parse(demo.stdout);
  assert(demoResult.demo_version === "moondog-demo/3", "The installed demo version is invalid.");
  assert(demoResult.tool_trace?.length === 4, "The installed demo tool trace is incomplete.");
  assert(demoResult.result?.playlist_plan?.track_count === 6, "The installed demo playlist is incomplete.");
  assert(demoResult.result?.playlist_plan?.external_effects === "none", "The installed demo changed external state.");
  assert(
    demoResult.next_steps?.some(
      (step) =>
        step.id === "open_listening_room" &&
        step.checkout_command === "npm start" &&
        step.installed_command === "moondog",
    ),
    "The installed demo has no path into the listening room.",
  );

  // Save both Spotify exports the way a listener would from the command line.
  for (const savedArchivePath of [
    await createSyntheticArchive(consumerRoot),
    await createSyntheticAccountArchive(consumerRoot),
  ]) {
    const savedImport = JSON.parse((await execFileAsync(
      binaryPath,
      ["taste", "--from", savedArchivePath, "--save", "--json"],
      {
        cwd: consumerRoot,
        env: environment,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
      },
    )).stdout);
    assert(
      savedImport.preview_source?.persistent_import === true &&
        savedImport.preview_source?.already_imported === false,
      "The installed CLI did not save a new Spotify import.",
    );
  }
  assert((await stat(path.join(stateRoot, "listening-history.sqlite"))).isFile(), "The installed CLI did not persist listening history.");

  const correction = JSON.parse((await execFileAsync(
    binaryPath,
    [
      "profile",
      "correct",
      "--artist",
      "Portishead",
      "--avoid",
      "--note",
      "Contextual listening only.",
      "--json",
    ],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  assert(correction.stance === "avoid", "The installed listener correction has the wrong stance.");
  assert(correction.entity_type === "artist", "The installed listener correction has the wrong target type.");

  const correctedTaste = JSON.parse((await execFileAsync(
    binaryPath,
    ["taste", "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  assert(
    correctedTaste.listener_assertions?.avoids?.[0]?.label === "Portishead",
    "The installed Taste projection did not apply the listener correction.",
  );
  assert(
    correctedTaste.coverage?.effective_listening_events === 3,
    "The installed listener correction rewrote listening history.",
  );

  const correctionList = JSON.parse((await execFileAsync(
    binaryPath,
    ["profile", "corrections", "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  assert(correctionList.active === 1, "The installed correction list omitted the active assertion.");

  // Without --output, the page goes to the private state directory.
  const tasteprintArtifact = JSON.parse((await execFileAsync(
    binaryPath,
    ["taste", "--html", "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  assert(
    path.dirname(tasteprintArtifact.path) === path.join(stateRoot, "tasteprints"),
    "The installed Tasteprint did not default to the private state directory.",
  );
  const correctedTasteprint = await readFile(tasteprintArtifact.path, "utf8");
  assert(correctedTasteprint.includes("What you told me"), "The installed Tasteprint did not expose listener corrections.");
  assert(correctedTasteprint.includes("Portishead"), "The installed Tasteprint omitted the correction target.");

  const correctedTasteprintCardPath = path.join(
    consumerRoot,
    "corrected-tasteprint-card.html",
  );
  const cardArtifact = JSON.parse((await execFileAsync(
    binaryPath,
    [
      "taste",
      "--card",
      "--output",
      correctedTasteprintCardPath,
      "--json",
    ],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  const correctedTasteprintCard = await readFile(
    correctedTasteprintCardPath,
    "utf8",
  );
  assert(
    cardArtifact.artifact_version === "moondog-tasteprint-card-artifact/1",
    "The installed Tasteprint card returned the wrong artifact contract.",
  );
  assert(
    correctedTasteprintCard.includes("Private listening recap"),
    "The installed Tasteprint card is incomplete.",
  );
  assert(
    correctedTasteprintCard.includes("Read it before you share it"),
    "The installed Tasteprint card omitted its privacy boundary.",
  );
  assert(
    !/<script/iu.test(correctedTasteprintCard) &&
      !/https?:\/\//iu.test(correctedTasteprintCard),
    "The installed Tasteprint card is not static and self-contained.",
  );

  const retraction = JSON.parse((await execFileAsync(
    binaryPath,
    ["profile", "retract", correction.correction_id, "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  assert(retraction.state === "retracted", "The installed listener correction was not retractable.");
  const activeAfterRetraction = JSON.parse((await execFileAsync(
    binaryPath,
    ["profile", "corrections", "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  assert(activeAfterRetraction.active === 0, "The installed retraction left an active listener correction.");

  const listenBrainzPath = await createSyntheticListenBrainzFile(consumerRoot);
  const listenBrainzBefore = await stat(listenBrainzPath);
  const firstListenBrainz = JSON.parse((await execFileAsync(
    binaryPath,
    ["listenbrainz", "import-history", listenBrainzPath, "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  const repeatedListenBrainz = JSON.parse((await execFileAsync(
    binaryPath,
    ["listenbrainz", "import-history", listenBrainzPath, "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  const multiSourceTaste = JSON.parse((await execFileAsync(
    binaryPath,
    ["taste", "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  const listenBrainzAfter = await stat(listenBrainzPath);
  assert(firstListenBrainz.inserted_events === 2, "The installed ListenBrainz importer stored the wrong event count.");
  assert(firstListenBrainz.mapped_track_refs === 1, "The installed ListenBrainz importer lost the server mapping.");
  assert(firstListenBrainz.events_with_played_ms === 1, "The installed ListenBrainz importer reported the wrong duration coverage.");
  assert(firstListenBrainz.already_imported === false, "The installed ListenBrainz importer treated new input as repeated.");
  assert(repeatedListenBrainz.inserted_events === 0, "The installed ListenBrainz importer duplicated events.");
  assert(repeatedListenBrainz.already_imported === true, "The installed ListenBrainz importer missed a repeated input.");
  assert(multiSourceTaste.coverage?.effective_listening_events === 5, "The installed multi-source Tasteprint has the wrong coverage.");
  assert(
    JSON.stringify(multiSourceTaste.listening_source?.providers) ===
      JSON.stringify(["listenbrainz", "spotify"]),
    "The installed Tasteprint did not retain provider-neutral source coverage.",
  );
  assert(
    !JSON.stringify({ firstListenBrainz, repeatedListenBrainz, multiSourceTaste }).includes(
      "PRIVATE_LISTENBRAINZ_PACKAGE_SENTINEL",
    ),
    "The installed ListenBrainz path exposed a direct identifier.",
  );
  assert(
    !JSON.stringify({ firstListenBrainz, repeatedListenBrainz, multiSourceTaste }).includes(
      "private.example",
    ),
    "The installed ListenBrainz path exposed a source URL.",
  );
  assert(
    listenBrainzBefore.size === listenBrainzAfter.size &&
      listenBrainzBefore.mtimeMs === listenBrainzAfter.mtimeMs,
    "The installed ListenBrainz importer changed the source JSON.",
  );

  const populatedInspection = JSON.parse((await execFileAsync(
    binaryPath,
    ["data", "inspect", "--scope", "listening", "--json"],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  assert(populatedInspection.state === "ready", "The installed data inspection did not find imported history.");
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      populatedInspection.subject_id,
    ),
    "The installed data inspection found an invalid subject.",
  );
  assert(populatedInspection.totals.components >= 2, "The installed data inspection omitted managed components.");

  const dataExportPath = path.join(consumerRoot, "local-music-export");
  const dataExport = JSON.parse((await execFileAsync(
    binaryPath,
    [
      "data",
      "export",
      "--scope",
      "listening",
      "--output",
      dataExportPath,
      "--json",
    ],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  assert(dataExport.source_changed === false, "The installed data export changed its source.");
  assert(await pathExists(path.join(dataExportPath, "manifest.json")), "The installed data export has no manifest.");
  assert(await pathExists(path.join(stateRoot, "listening-history.sqlite")), "The installed data export removed listening history.");

  const dataReset = JSON.parse((await execFileAsync(
    binaryPath,
    [
      "data",
      "reset",
      "--scope",
      "listening",
      "--confirm",
      populatedInspection.reset_confirmation,
      "--json",
    ],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  )).stdout);
  assert(dataReset.state === "archived", "The installed data reset did not archive state.");
  assert(dataReset.deletion === "none", "The installed data reset deleted state.");
  assert(dataReset.archives.length >= 2, "The installed data reset omitted managed components.");
  assert(await pathExists(dataReset.manifest_path), "The installed data reset has no manifest.");
  assert(!(await pathExists(path.join(stateRoot, "listening-history.sqlite"))), "The installed data reset left active listening history.");
}

async function main() {
  await access("/usr/bin/zip");
  await access("/usr/bin/unzip");
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "moondog-package-"));
  if (process.platform !== "win32") await chmod(temporaryRoot, 0o700);
  try {
    const packRoot = path.join(temporaryRoot, "pack");
    const extractRoot = path.join(temporaryRoot, "extract");
    const consumerRoot = path.join(temporaryRoot, "consumer");
    await mkdir(packRoot, { mode: 0o700 });
    await mkdir(extractRoot, { mode: 0o700 });
    await mkdir(consumerRoot, { mode: 0o700 });

    const packed = await runNpm([
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packRoot,
    ], { cwd: repositoryRoot });
    const packRecords = JSON.parse(packed.stdout);
    assert(Array.isArray(packRecords) && packRecords.length === 1, "npm pack returned an unexpected result.");
    const pack = packRecords[0];
    const manifestPaths = validatePackManifest(pack);
    const tarballPath = path.join(packRoot, pack.filename);
    await access(tarballPath);
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractRoot], {
      timeout: 30_000,
    });
    await validateExtractedPackage(path.join(extractRoot, "package"), manifestPaths);
    await verifyInstalledPackage({ consumerRoot, tarballPath });

    process.stdout.write(
      `Verified installable package from an isolated npm cache: ${pack.entryCount} files, ${(pack.size / (1024 * 1024)).toFixed(2)} MiB packed, CLI, no-model dated Apple latest-single path with fail-closed exact Wikidata alias recovery, deterministic explicit public artist-page recovery, and optional local Spotify archive disambiguation, fictional history generation, one- and two-archive in-memory Taste, six-track demo, saved Spotify import, ListenBrainz import, repeat imports, multi-source private Tasteprint, privacy-bounded Tasteprint card, CLI listener correction, and recoverable local data control.\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Package verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
