import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
const maximumPackedBytes = 2_500_000;
// Multi-service imports currently pack 103 source/assets entries, about 3.92 MB.
const maximumUnpackedBytes = 4_000_000;
const maximumEntries = 110;
const packageOnlyPrivateSentinelPattern = new RegExp(
  ["PRIVATE", "(?:IP|PLATFORM)", "SENTINEL"].join("_"),
  "u",
);
const requiredPackagePaths = new Set([
  "README.md",
  "assets/brand/moondog-lunar-record/moondog-logo-1x1.png",
  "contracts/v1/definitions.schema.json",
  "contracts/v2/profile-evidence.schema.json",
  "package.json",
  "scripts/contract-lib.mjs",
  "scripts/contract-semantics.mjs",
  "scripts/demo-studio.mjs",
  "scripts/moondog",
  "scripts/moondog.mjs",
  "src/demo/fictional-spotify-history.mjs",
  "src/demo/moondog-demo.mjs",
  "src/demo/moondog-interactive-tasteprint-demo.mjs",
  "src/demo/moondog-tasteprint-demo.mjs",
  "src/integrations/cross-catalog-artist-identity.mjs",
  "src/integrations/lyrics/lrclib.mjs",
  "src/core/lyric-library.mjs",
  "src/core/lyric-profile.mjs",
  "src/core/lyric-service.mjs",
  "src/integrations/listenbrainz/history-file.mjs",
  "src/integrations/public-playlists.mjs",
  "src/integrations/youtube-music/takeout.mjs",
  "src/profile/music-import-bundle.mjs",
  "src/profile/music-providers.mjs",
  "src/profile/listener-corrections.mjs",
  "src/profile/local-music-data.mjs",
  "src/profile/spotify-archive-catalog-hints.mjs",
  "src/surfaces/cli/catalog-command.mjs",
  "src/surfaces/cli/data-command.mjs",
  "src/surfaces/cli/listenbrainz-command.mjs",
  "src/surfaces/cli/profile-command.mjs",
  "src/surfaces/web/studio-page.mjs",
  "src/surfaces/web/studio.mjs",
]);
const exactAllowedPackagePaths = new Set([
  "README.md",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "NOTICE",
  "package.json",
  "assets/brand/moondog-lunar-record/moondog-logo-1x1.png",
  "scripts/contract-lib.mjs",
  "scripts/contract-semantics.mjs",
  "scripts/demo-studio.mjs",
  "scripts/moondog",
  "scripts/moondog.mjs",
  "src/demo/fictional-spotify-history.mjs",
  "src/demo/moondog-demo.mjs",
  "src/demo/moondog-interactive-tasteprint-demo.mjs",
  "src/demo/moondog-tasteprint-demo.mjs",
]);
const allowedPackagePrefixes = [
  "contracts/v1/",
  "contracts/v2/",
  "src/core/",
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
  assert(pack.name === "@ruc-aimusic-lab/moondog", "npm pack returned the wrong package name.");
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

function waitForStudio(child, output) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("The installed Moondog Studio did not become ready."));
    }, 15_000);

    const inspect = () => {
      const match = output.stdout.match(/http:\/\/127\.0\.0\.1:[0-9]+\/\?session=[A-Za-z0-9_-]+/u);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(match[0]);
    };
    child.stdout.on("data", (chunk) => {
      output.stdout = `${output.stdout}${chunk}`.slice(-100_000);
      inspect();
    });
    child.stderr.on("data", (chunk) => {
      output.stderr = `${output.stderr}${chunk}`.slice(-100_000);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `The installed Moondog Studio exited before startup (${code ?? signal}). ${output.stderr}`,
        ),
      );
    });
  });
}

async function stopStudio(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The installed Moondog Studio did not stop after SIGINT."));
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGINT") resolve();
      else reject(new Error(`The installed Moondog Studio stopped unexpectedly (${code ?? signal}).`));
    });
  });
}

async function postArchive(studioUrl, archive) {
  const pageUrl = new URL(studioUrl);
  const token = pageUrl.searchParams.get("session");
  const origin = pageUrl.origin;
  return fetch(new URL("/api/import", origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      Origin: origin,
      "X-Moondog-Session": token,
    },
    body: archive,
  });
}

async function postHistoryJson(studioUrl, history) {
  const pageUrl = new URL(studioUrl);
  const token = pageUrl.searchParams.get("session");
  const origin = pageUrl.origin;
  return fetch(new URL("/api/import", origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Moondog-Session": token,
    },
    body: history,
  });
}

async function studioProfileRequest(studioUrl, pathname, value) {
  const pageUrl = new URL(studioUrl);
  const token = pageUrl.searchParams.get("session");
  const origin = pageUrl.origin;
  const options = value === undefined
    ? { headers: { "X-Moondog-Session": token } }
    : {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "X-Moondog-Session": token,
        },
        body: JSON.stringify(value),
      };
  return fetch(new URL(pathname, origin), options);
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
    "@ruc-aimusic-lab",
    "moondog",
  );
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  assert(installedPackage.private === true, "The package publication gate changed unexpectedly.");
  assert(
    JSON.stringify(installedPackage.os) === JSON.stringify(["darwin", "linux"]),
    "The package platform boundary changed unexpectedly.",
  );
  assert(
    installedPackage.scripts?.["demo:studio"] ===
      "node --disable-warning=ExperimentalWarning scripts/demo-studio.mjs",
    "The installed package has no zero-data Studio tour.",
  );
  assert(installedPackage.dependencies?.ajv === "8.20.0", "Ajv is not a runtime dependency.");
  assert(
    installedPackage.dependencies?.["ajv-formats"] === "3.0.1",
    "Ajv formats is not a runtime dependency.",
  );

  const binaryPath = path.join(consumerRoot, "node_modules", ".bin", "moondog");
  const stateRoot = path.join(consumerRoot, "state");
  const configRoot = path.join(consumerRoot, "config");
  const studioTemporaryRoot = path.join(consumerRoot, "studio-temporary");
  await mkdir(studioTemporaryRoot, { recursive: true, mode: 0o700 });
  const environment = {
    ...process.env,
    MOONDOG_CONFIG_HOME: configRoot,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_APPLE_IMPORTS_ROOT: path.join(consumerRoot, "apple-imports"),
    MOONDOG_APPLE_PROJECTION_PATH: path.join(
      consumerRoot,
      "apple-projection.sqlite",
    ),
    MOONDOG_STUDIO_NO_OPEN: "1",
    NO_COLOR: "1",
    TMPDIR: studioTemporaryRoot,
  };

  const help = await execFileAsync(binaryPath, ["help"], {
    cwd: consumerRoot,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert(help.stdout.includes("moondog studio"), "The installed CLI help is incomplete.");
  assert(help.stdout.includes("moondog studio --demo"), "The installed CLI help has no zero-data Studio tour.");
  assert(
    help.stdout.includes("moondog studio --from <spotify-history.zip>"),
    "The installed CLI help has no session-only private Studio path.",
  );
  assert(
    help.stdout.includes(
      "moondog studio --from <account-data.zip> --from <extended-history.zip>",
    ) &&
      help.stdout.includes(
        "moondog taste --from <account-data.zip> --from <extended-history.zip> --html",
      ),
    "The installed CLI help has no two-archive in-memory reconciliation path.",
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
  const showcase = JSON.parse(demo.stdout);
    assert(showcase.demo_version === "moondog-demo/3", "The installed demo version is invalid.");
  assert(showcase.tool_trace?.length === 4, "The installed demo tool trace is incomplete.");
    assert(showcase.result?.playlist_plan?.track_count === 6, "The installed demo playlist is incomplete.");
    assert(showcase.result?.playlist_plan?.external_effects === "none", "The installed demo changed external state.");
    assert(
      showcase.next_steps?.some(
        (step) =>
          step.id === "open_visual_tour" &&
          step.checkout_command === "npm run demo:studio" &&
          step.installed_command === "moondog studio --demo",
      ),
      "The installed demo has no path into the zero-data visual tour.",
    );
    assert(
      showcase.next_steps?.some(
        (step) =>
          step.id === "open_session_studio" &&
          step.checkout_command ===
            "npm --silent run demo:studio -- --from /absolute/path/to/spotify-history.zip" &&
          step.installed_command ===
            "moondog studio --from /absolute/path/to/spotify-history.zip",
      ),
      "The installed demo has no path into session-only private Studio.",
    );
    assert(
      showcase.next_steps?.some(
        (step) =>
          step.id === "open_private_studio" &&
          step.checkout_command === "npm run studio" &&
          step.installed_command === "moondog studio",
      ),
      "The installed demo has no path into private Studio.",
    );

  const demoStudioOutput = { stdout: "", stderr: "" };
  const demoStudio = spawn(binaryPath, ["studio", "--demo"], {
    cwd: consumerRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const demoStudioUrl = await waitForStudio(demoStudio, demoStudioOutput);
    const demoStudioPageResponse = await fetch(demoStudioUrl);
    const demoStudioPage = await demoStudioPageResponse.text();
    assert(demoStudioPageResponse.status === 200, "The installed zero-data Studio page did not load.");
    assert(demoStudioPage.includes("A music life,<br>made legible."), "The installed zero-data Studio tour is incomplete.");
    assert(demoStudioPage.includes("data-demo-only=\"true\""), "The installed zero-data Studio mode is not explicit.");
    assert(demoStudioPage.includes("hidden aria-hidden=\"true\""), "The installed zero-data Studio still exposes the import surface.");

    const demoProfileResponse = await studioProfileRequest(
      demoStudioUrl,
      "/api/profile",
    );
    const demoProfile = await demoProfileResponse.json();
    assert(demoProfileResponse.status === 200, "The installed zero-data profile did not load.");
    assert(demoProfile.profile_kind === "synthetic_demo", "The installed zero-data profile is not synthetic.");
    assert(
      demoProfile.demo_proof?.production_importer === true &&
        demoProfile.demo_proof?.record_count === 52,
      "The installed zero-data profile did not exercise the production importer.",
    );
    assert(
      demoProfile.coverage?.effective_listening_events === 52,
      "The installed zero-data Studio loaded the wrong fictional archive.",
    );
    assert(demoProfile.time_machine?.landmark_count === 4, "The installed zero-data Time Machine is incomplete.");
    assert(
      demoProfile.time_machine?.retained_year_count === 4 &&
        demoProfile.time_machine?.represented_year_count === 4 &&
        demoProfile.time_machine?.unrepresented_years?.length === 0,
      "The installed zero-data Time Machine does not explain its year coverage.",
    );
    assert(
      demoProfile.listening_pulse?.ready === true &&
        demoProfile.listening_pulse?.timezone === "UTC" &&
        demoProfile.listening_pulse?.retained_span_months === 36 &&
        demoProfile.listening_pulse?.represented_month_count === 36 &&
        demoProfile.listening_pulse?.active_month_count === 15 &&
        demoProfile.listening_pulse?.months?.length === 36,
      "The installed zero-data Studio does not expose the expected monthly Listening Pulse.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs|occurred_at/u.test(
        JSON.stringify(demoProfile.listening_pulse),
      ),
      "The installed zero-data Listening Pulse exposed private identity or event detail.",
    );
    assert(
      demoProfile.listening_seasons?.ready === true &&
        demoProfile.listening_seasons?.timezone === "UTC" &&
        demoProfile.listening_seasons?.retained_season_count === 13 &&
        demoProfile.listening_seasons?.represented_season_count === 13 &&
        demoProfile.listening_seasons?.active_season_count === 12 &&
        demoProfile.listening_seasons?.preview_season_count === 6 &&
        demoProfile.listening_seasons?.seasons?.length === 6,
      "The installed zero-data Studio does not expose the expected fixed-quarter Listening Seasons.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs|occurred_at/u.test(
        JSON.stringify(demoProfile.listening_seasons),
      ),
      "The installed zero-data Listening Seasons exposed private identity or event detail.",
    );
    assert(
      demoProfile.listening_patterns?.ready === true &&
        demoProfile.listening_patterns?.session?.session_count > 0,
      "The installed zero-data Studio does not expose approximate listening patterns.",
    );
    assert(
      demoProfile.back_to_back?.ready === true &&
        demoProfile.back_to_back?.track_count === 3 &&
        demoProfile.back_to_back?.minimum_consecutive_plays === 2 &&
        demoProfile.back_to_back?.minimum_played_seconds === 30 &&
        demoProfile.back_to_back?.maximum_gap_minutes === 30,
      "The installed zero-data Studio does not expose bounded played-back-to-back evidence.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs|occurred_at/u.test(
        JSON.stringify(demoProfile.back_to_back),
      ),
      "The installed zero-data back-to-back preview exposed private identity or event detail.",
    );

    const rejectedImportResponse = await postArchive(
      demoStudioUrl,
      Buffer.from("504b0304", "hex"),
    );
    const rejectedImport = await rejectedImportResponse.json();
    assert(rejectedImportResponse.status === 409, "The installed zero-data Studio accepted a history import.");
    assert(
      /does not read or accept private listening history/u.test(rejectedImport.message),
      "The installed zero-data Studio obscures its import boundary.",
    );
    assert(!(await pathExists(stateRoot)), "The installed zero-data Studio initialized private state.");
  } finally {
    await stopStudio(demoStudio);
  }

  const archiveBeforeSession = await stat(fictionalHistoryPath);
  const archiveStudioOutput = { stdout: "", stderr: "" };
  const archiveStudio = spawn(
    binaryPath,
    ["studio", "--from", fictionalHistoryPath],
    {
      cwd: consumerRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const archiveStudioUrl = await waitForStudio(
      archiveStudio,
      archiveStudioOutput,
    );
    const archiveStudioPageResponse = await fetch(archiveStudioUrl);
    const archiveStudioPage = await archiveStudioPageResponse.text();
    assert(
      archiveStudioPageResponse.status === 200,
      "The installed session-only Studio page did not load.",
    );
    assert(
        archiveStudioPage.includes("Your whole history,<br>ready now.") &&
        archiveStudioPage.includes('data-session-mode="archive"') &&
        archiveStudioPage.includes("original ZIP stays untouched") &&
        archiveStudioPage.includes('id="profile-listening-pulse"') &&
        archiveStudioPage.includes('id="profile-listening-seasons"') &&
        archiveStudioPage.includes('id="profile-continuity"') &&
        archiveStudioPage.includes('id="profile-listening-patterns"'),
      "The installed session-only Studio does not explain its private boundary.",
    );
    assert(
      !archiveStudioPage.includes(fictionalHistoryPath),
      "The installed session-only Studio rendered the private source path.",
    );

    const archiveProfileResponse = await studioProfileRequest(
      archiveStudioUrl,
      "/api/profile",
    );
    const archiveProfile = await archiveProfileResponse.json();
    assert(
      archiveProfileResponse.status === 200 &&
        archiveProfile.profile_kind === "private_session",
      "The installed archive did not open as a session-only private profile.",
    );
    assert(
        archiveProfile.coverage?.effective_listening_events === 52 &&
        archiveProfile.time_machine?.landmark_count === 4 &&
        archiveProfile.listening_pulse?.ready === true &&
        archiveProfile.listening_pulse?.timezone === "UTC" &&
        archiveProfile.listening_pulse?.retained_span_months === 36 &&
        archiveProfile.listening_pulse?.active_month_count === 15 &&
        archiveProfile.listening_seasons?.ready === true &&
        archiveProfile.listening_seasons?.timezone === "UTC" &&
        archiveProfile.listening_seasons?.retained_season_count === 13 &&
        archiveProfile.listening_seasons?.active_season_count === 12 &&
        archiveProfile.listening_seasons?.preview_season_count === 6 &&
        archiveProfile.continuity?.ready === true &&
        archiveProfile.continuity?.relationships?.length > 0 &&
        archiveProfile.continuity?.latest_transition?.to_year === 2026 &&
        archiveProfile.listening_patterns?.ready === true &&
        archiveProfile.listening_patterns?.session?.session_count > 0 &&
        archiveProfile.source?.persistent_import === false,
      "The installed session-only Studio did not expose the complete fictional profile.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs|occurred_at/u.test(
        JSON.stringify(archiveProfile.listening_pulse),
      ),
      "The installed session-only Listening Pulse exposed private identity or event detail.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs|occurred_at/u.test(
        JSON.stringify(archiveProfile.listening_seasons),
      ),
      "The installed session-only Listening Seasons exposed private identity or event detail.",
    );
    assert(
      !JSON.stringify(archiveProfile).includes(fictionalHistoryPath),
      "The installed session-only profile returned the private source path.",
    );

    const archiveCorrectionResponse = await studioProfileRequest(
      archiveStudioUrl,
      "/api/session/corrections",
      {
        entity_type: "artist",
        label: "Session Verification Artist",
        stance: "like",
      },
    );
    const archiveCorrection = await archiveCorrectionResponse.json();
    assert(
      archiveCorrectionResponse.status === 200 &&
        archiveCorrection.profile_kind === "private_session" &&
        archiveCorrection.active_corrections === 1,
      "The installed session-only Studio could not apply an in-memory correction.",
    );

    const archiveRetractionResponse = await studioProfileRequest(
      archiveStudioUrl,
      "/api/session/corrections/retract",
      { correction_id: archiveCorrection.corrections[0].correction_id },
    );
    const archiveRetraction = await archiveRetractionResponse.json();
    assert(
      archiveRetractionResponse.status === 200 &&
        archiveRetraction.active_corrections === 0,
      "The installed session-only Studio could not retract an in-memory correction.",
    );

    const archiveImportResponse = await postArchive(
      archiveStudioUrl,
      Buffer.from("504b0304", "hex"),
    );
    const archiveImport = await archiveImportResponse.json();
    assert(
      archiveImportResponse.status === 409 &&
        /does not accept another import/u.test(archiveImport.message),
      "The installed session-only Studio accepted a persistent import.",
    );
    assert(
      !(await pathExists(stateRoot)),
      "The installed session-only Studio initialized persistent state.",
    );
  } finally {
    await stopStudio(archiveStudio);
  }
  const archiveAfterSession = await stat(fictionalHistoryPath);
  assert(
    archiveAfterSession.size === archiveBeforeSession.size &&
      archiveAfterSession.mtimeMs === archiveBeforeSession.mtimeMs,
    "The installed session-only Studio changed the supplied archive.",
  );
  assert(
    (await readdir(studioTemporaryRoot)).length === 0,
    "The installed session-only Studio retained temporary files.",
  );

  const archiveSetStudioOutput = { stdout: "", stderr: "" };
  const archiveSetStudio = spawn(
    binaryPath,
    [
      "studio",
      "--from",
      archiveSetAccountPath,
      "--from",
      archiveSetExtendedPath,
    ],
    {
      cwd: consumerRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const archiveSetStudioUrl = await waitForStudio(
      archiveSetStudio,
      archiveSetStudioOutput,
    );
    const archiveSetPageResponse = await fetch(archiveSetStudioUrl);
    const archiveSetPage = await archiveSetPageResponse.text();
    assert(
      archiveSetPageResponse.status === 200 &&
        archiveSetPage.includes("Two ZIPs, one private session") &&
        archiveSetPage.includes('data-archive-count="2"'),
      "The installed two-archive Studio does not explain its session boundary.",
    );
    const archiveSetProfileResponse = await studioProfileRequest(
      archiveSetStudioUrl,
      "/api/profile",
    );
    const archiveSetProfile = await archiveSetProfileResponse.json();
    assert(
      archiveSetProfileResponse.status === 200 &&
        archiveSetProfile.profile_kind === "private_session" &&
        archiveSetProfile.coverage?.effective_listening_events === 3 &&
        archiveSetProfile.source?.archive_count === 2 &&
        archiveSetProfile.source?.reconciled_overlap_events === 2 &&
        archiveSetProfile.source?.persistent_import === false &&
        archiveSetProfile.listening_pulse?.ready === true &&
        archiveSetProfile.listening_pulse?.timezone === "UTC" &&
        archiveSetProfile.listening_pulse?.months?.length ===
          archiveSetProfile.listening_pulse?.preview_month_count &&
        archiveSetProfile.listening_seasons?.ready === true &&
        archiveSetProfile.listening_seasons?.timezone === "UTC" &&
        archiveSetProfile.listening_seasons?.seasons?.length ===
          archiveSetProfile.listening_seasons?.preview_season_count,
      "The installed two-archive Studio did not expose the reconciled session-only profile.",
    );
    assert(
      !JSON.stringify(archiveSetProfile).includes(archiveSetAccountPath) &&
        !JSON.stringify(archiveSetProfile).includes(archiveSetExtendedPath) &&
        !(await pathExists(stateRoot)),
      "The installed two-archive Studio exposed a source path or initialized persistent state.",
    );
  } finally {
    await stopStudio(archiveSetStudio);
  }
  const archiveSetExtendedAfter = await stat(archiveSetExtendedPath);
  const archiveSetAccountAfter = await stat(archiveSetAccountPath);
  assert(
    archiveSetExtendedAfter.size === archiveSetExtendedBefore.size &&
      archiveSetExtendedAfter.mtimeMs === archiveSetExtendedBefore.mtimeMs &&
      archiveSetAccountAfter.size === archiveSetAccountBefore.size &&
      archiveSetAccountAfter.mtimeMs === archiveSetAccountBefore.mtimeMs,
    "The installed two-archive session changed a supplied archive.",
  );
  assert(
    (await readdir(studioTemporaryRoot)).length === 0,
    "The installed two-archive Studio retained temporary files.",
  );

  const output = { stdout: "", stderr: "" };
  const studio = spawn(binaryPath, ["studio"], {
    cwd: consumerRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const studioUrl = await waitForStudio(studio, output);
    const pageResponse = await fetch(studioUrl);
    const page = await pageResponse.text();
    assert(pageResponse.status === 200, "The installed Studio page did not load.");
    assert(page.includes("Your history,<br>now useful."), "The installed Studio page is incomplete.");
    assert(page.includes("Spotify ZIP or ListenBrainz JSON"), "The installed Studio page does not expose both private history formats.");
    assert(page.includes("Try the real importer with fictional history"), "The installed Studio has no first-screen real-import entry point.");
    assert(page.includes("Run the fictional archive through the real importer"), "The installed Studio has no interactive real-import entry point.");
    assert(page.includes("profile-time-machine"), "The installed Studio has no Time Machine preview.");
    assert(page.includes("profile-time-machine-coverage"), "The installed Studio has no Time Machine coverage explanation.");
    assert(page.includes("profile-listening-seasons"), "The installed Studio has no Listening Seasons preview.");
    assert(page.includes("profile-continuity"), "The installed Studio has no continuity preview.");
    assert(page.includes("profile-back-to-back"), "The installed Studio has no played-back-to-back preview.");
    assert(page.includes("profile-listening-patterns"), "The installed Studio has no listening-pattern preview.");
    assert(page.includes("Fictional real-import demo"), "The installed Studio does not label its real-import demo.");
    assert(page.includes("Correct the reading."), "The installed Studio has no visual correction path.");
    assert(page.includes("Apply to Tasteprint"), "The installed Studio has no correction action.");
    assert(!/https?:\/\/(?!127\.0\.0\.1)/u.test(page), "The installed Studio page references an external URL.");

    const pageUrl = new URL(studioUrl);
    const demoTasteprintUrl = new URL("/demo-tasteprint", pageUrl.origin);
    demoTasteprintUrl.searchParams.set("session", pageUrl.searchParams.get("session"));
    const demoTasteprintResponse = await fetch(demoTasteprintUrl);
    const demoTasteprint = await demoTasteprintResponse.text();
    assert(demoTasteprintResponse.status === 200, "The installed Studio demo Tasteprint did not load.");
    assert(demoTasteprint.includes("Moondog Synthetic Tasteprint Demo"), "The installed Studio demo Tasteprint is incomplete.");
    assert(demoTasteprint.includes("Synthetic public demo"), "The installed Studio demo is not labeled synthetic.");
    assert(
      demoTasteprint.includes("4 of 4 retained years have landmarks"),
      "The installed Studio demo Tasteprint does not explain Time Machine year coverage.",
    );
    assert(
      demoTasteprint.includes("Listening Seasons") &&
        demoTasteprint.includes("Fixed three-month UTC windows"),
      "The installed Studio demo Tasteprint does not expose fixed-quarter Listening Seasons.",
    );
    assert(
      demoTasteprint.includes("What stayed. What changed.") &&
        demoTasteprint.includes("Year-to-year turnover"),
      "The installed Studio demo Tasteprint does not expose continuity and change.",
    );
    assert(
      demoTasteprint.includes("The shape of a listening stretch") &&
        demoTasteprint.includes("Approximate sessions") &&
        demoTasteprint.includes("Records explored in depth"),
      "The installed Studio demo Tasteprint does not expose listening patterns.",
    );
    assert(
      demoTasteprint.includes("Played back to back") &&
        demoTasteprint.includes("At least 2 adjacent plays") &&
        demoTasteprint.includes("does not prove repeat mode, intention, or liking"),
      "The installed Studio demo Tasteprint does not expose bounded played-back-to-back evidence.",
    );
    assert(!/<script/iu.test(demoTasteprint), "The installed Studio demo Tasteprint contains a script.");
    assert(!/https?:\/\//iu.test(demoTasteprint), "The installed Studio demo Tasteprint contains an external URL.");
    assert(
      !(await pathExists(path.join(stateRoot, "listening-history.sqlite"))),
      "The installed Studio demo preview created listening history.",
    );

    const interactiveDemoResponse = await studioProfileRequest(
      studioUrl,
      "/api/demo/start",
      {},
    );
    const interactiveDemo = await interactiveDemoResponse.json();
    assert(interactiveDemoResponse.status === 200, "The installed Studio could not start the fictional profile.");
    assert(interactiveDemo.profile_kind === "synthetic_demo", "The installed Studio did not label the interactive profile synthetic.");
    assert(interactiveDemo.coverage?.effective_listening_events === 52, "The installed Studio loaded the wrong fictional profile.");
    assert(
      interactiveDemo.demo_proof?.source_format ===
        "spotify_extended_streaming_history_music_v1" &&
        interactiveDemo.demo_proof?.persistent_profile_writes === false,
      "The installed Studio did not expose bounded real-import proof.",
    );
    assert(interactiveDemo.time_machine?.ready === true, "The installed Studio did not expose the fictional Time Machine.");
    assert(interactiveDemo.time_machine?.landmark_count === 4, "The installed Studio exposed the wrong Time Machine landmarks.");
    assert(
      interactiveDemo.time_machine?.retained_year_count === 4 &&
        interactiveDemo.time_machine?.represented_year_count === 4 &&
        interactiveDemo.time_machine?.unrepresented_years?.length === 0,
      "The installed Studio Time Machine does not expose year coverage.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs/u.test(
        JSON.stringify(interactiveDemo.time_machine),
      ),
      "The installed Studio Time Machine exposed a private identity field.",
    );
    assert(
      interactiveDemo.listening_pulse?.ready === true &&
        interactiveDemo.listening_pulse?.timezone === "UTC" &&
        interactiveDemo.listening_pulse?.retained_span_months === 36 &&
        interactiveDemo.listening_pulse?.active_month_count === 15 &&
        interactiveDemo.listening_pulse?.months?.length === 36,
      "The installed Studio did not expose the fictional monthly Listening Pulse.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs|occurred_at/u.test(
        JSON.stringify(interactiveDemo.listening_pulse),
      ),
      "The installed Studio Listening Pulse exposed private identity or event detail.",
    );
    assert(
      interactiveDemo.listening_seasons?.ready === true &&
        interactiveDemo.listening_seasons?.timezone === "UTC" &&
        interactiveDemo.listening_seasons?.retained_season_count === 13 &&
        interactiveDemo.listening_seasons?.active_season_count === 12 &&
        interactiveDemo.listening_seasons?.preview_season_count === 6 &&
        interactiveDemo.listening_seasons?.seasons?.length === 6,
      "The installed Studio did not expose the fictional fixed-quarter Listening Seasons.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs|occurred_at/u.test(
        JSON.stringify(interactiveDemo.listening_seasons),
      ),
      "The installed Studio Listening Seasons exposed private identity or event detail.",
    );
    assert(interactiveDemo.continuity?.ready === true, "The installed Studio did not expose fictional continuity.");
    assert(interactiveDemo.continuity?.relationships?.length === 4, "The installed Studio exposed the wrong fictional relationships.");
    assert(
      interactiveDemo.continuity?.latest_transition?.from_year === 2025 &&
        interactiveDemo.continuity?.latest_transition?.to_year === 2026 &&
        interactiveDemo.continuity?.latest_transition?.retained_artist_count === 3 &&
        interactiveDemo.continuity?.latest_transition?.new_artist_count === 4 &&
        interactiveDemo.continuity?.latest_transition?.continuity_percent === 42.9,
      "The installed Studio exposed the wrong production-importer continuity map.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs/u.test(
        JSON.stringify(interactiveDemo.continuity),
      ),
      "The installed Studio continuity preview exposed a private identity field.",
    );
    assert(
      interactiveDemo.listening_patterns?.ready === true &&
        interactiveDemo.listening_patterns?.session?.session_count > 0,
      "The installed Studio did not expose production-importer listening patterns.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs|occurred_at/u.test(
        JSON.stringify(interactiveDemo.listening_patterns),
      ),
      "The installed Studio listening-pattern preview exposed private identity or event detail.",
    );
    assert(
      interactiveDemo.back_to_back?.ready === true &&
        interactiveDemo.back_to_back?.track_count === 3,
      "The installed Studio did not expose production-importer played-back-to-back evidence.",
    );
    assert(
      !/spotify:track:|track_ref|evidence_id|external_refs|occurred_at/u.test(
        JSON.stringify(interactiveDemo.back_to_back),
      ),
      "The installed Studio played-back-to-back preview exposed private identity or event detail.",
    );
    assert(interactiveDemo.active_corrections === 0, "The installed Studio fictional profile began with a correction.");

    const demoCorrectionResponse = await studioProfileRequest(
      studioUrl,
      "/api/demo/corrections",
      {
        entity_type: "track",
        label: "Midnight Lines",
        artist_credit: "Mara Vale",
        stance: "avoid",
        note: "Installed fictional correction signal.",
      },
    );
    const demoCorrection = await demoCorrectionResponse.json();
    assert(demoCorrectionResponse.status === 200, "The installed Studio could not correct the fictional profile.");
    assert(demoCorrection.active_corrections === 1, "The installed Studio did not activate its fictional correction.");
    assert(demoCorrection.coverage?.effective_listening_events === 52, "The fictional correction rewrote synthetic history.");
    assert(
      demoCorrection.back_to_back?.track_count === 2,
      "The installed Studio correction did not remove the avoided played-back-to-back track.",
    );
    const interactiveTasteprintResponse = await fetch(
      new URL(demoCorrection.tasteprint_url, pageUrl.origin),
    );
    const interactiveTasteprint = await interactiveTasteprintResponse.text();
    assert(interactiveTasteprintResponse.status === 200, "The installed Studio did not render its corrected fictional Tasteprint.");
    assert(interactiveTasteprint.includes("Synthetic public demo"), "The corrected fictional Tasteprint lost its synthetic label.");
    assert(interactiveTasteprint.includes("Installed fictional correction signal."), "The corrected fictional Tasteprint omitted its direct signal.");

    const demoRetractionResponse = await studioProfileRequest(
      studioUrl,
      "/api/demo/corrections/retract",
      { correction_id: demoCorrection.corrections[0].correction_id },
    );
    const demoRetraction = await demoRetractionResponse.json();
    assert(demoRetractionResponse.status === 200, "The installed Studio could not retract its fictional correction.");
    assert(demoRetraction.active_corrections === 0, "The installed Studio left its fictional correction active.");
    assert(!(await pathExists(stateRoot)), "The interactive fictional profile wrote persistent state.");

    const archivePath = await createSyntheticArchive(consumerRoot);
    const before = await stat(archivePath);
    const archive = await readFile(archivePath);
    const firstResponse = await postArchive(studioUrl, archive);
    const first = await firstResponse.json();
    assert(firstResponse.status === 200, "The installed Studio could not import Extended History.");
    assert(first.profile_kind === "private", "The installed Studio did not switch from fictional to private mode.");
    assert(first.coverage?.effective_listening_events === 2, "The installed Studio imported the wrong event count.");
    assert(first.source?.already_imported === false, "The installed Studio treated a new archive as repeated.");
    assert(first.source?.effective_event_delta === 2, "The installed Studio reported the wrong event delta.");
    assert(first.source?.superseded_events === 0, "The installed Studio reported an unexpected reconciliation.");

    const accountArchivePath = await createSyntheticAccountArchive(consumerRoot);
    const accountArchive = await readFile(accountArchivePath);
    const accountResponse = await postArchive(studioUrl, accountArchive);
    const accountImport = await accountResponse.json();
    assert(accountResponse.status === 200, "The installed Studio could not import Account Data after Extended History.");
    assert(accountImport.coverage?.effective_listening_events === 3, "The installed Studio produced the wrong cross-format event count.");
    assert(accountImport.coverage?.distinct_tracks === 2, "The installed Studio split a uniquely linked cross-format track identity.");
    assert(accountImport.coverage?.cross_format_track_links === 1, "The installed Studio did not report its exact cross-format track link.");
    assert(accountImport.coverage?.cross_format_linked_events === 1, "The installed Studio reported the wrong linked-event count.");
    assert(accountImport.coverage?.cross_format_ambiguous_tracks === 0, "The installed Studio reported an unexpected ambiguous track identity.");
    assert(accountImport.coverage?.cross_format_ambiguous_events === 0, "The installed Studio reported an unexpected ambiguous linked event.");
    assert(accountImport.source?.effective_event_delta === 1, "The installed Studio reported the wrong cross-format event delta.");
    assert(accountImport.source?.superseded_events === 2, "The installed Studio did not reconcile exact cross-format overlaps.");

    const secondResponse = await postArchive(studioUrl, archive);
    const second = await secondResponse.json();
    assert(secondResponse.status === 200, "The installed Studio could not repeat the import.");
    assert(second.source?.already_imported === true, "The installed Studio did not detect a repeated archive.");
    assert(second.source?.effective_event_delta === 0, "The installed Studio repeated persisted events.");

    const profileResponse = await studioProfileRequest(
      studioUrl,
      "/api/profile",
    );
    const profile = await profileResponse.json();
    assert(profileResponse.status === 200, "The installed Studio could not read the current profile.");
    assert(profile.profile_kind === "private", "The installed Studio kept fictional mode after a private import.");
    assert(profile.state === "ready", "The installed Studio did not recognize its imported profile.");
    assert(profile.active_corrections === 0, "The installed Studio began with an unexpected correction.");

    const studioCorrectionResponse = await studioProfileRequest(
      studioUrl,
      "/api/corrections",
      {
        entity_type: "artist",
        label: "Studio Verification Artist",
        stance: "like",
        note: "Installed Studio verification signal.",
      },
    );
    const studioCorrection = await studioCorrectionResponse.json();
    assert(studioCorrectionResponse.status === 200, "The installed Studio could not create a correction.");
    assert(studioCorrection.active_corrections === 1, "The installed Studio did not activate its correction.");
    assert(
      studioCorrection.corrections?.[0]?.label === "Studio Verification Artist",
      "The installed Studio returned the wrong correction target.",
    );
    assert(
      studioCorrection.coverage?.effective_listening_events === 3,
      "The installed Studio correction rewrote listening history.",
    );
    assert(
      studioCorrection.tasteprint_card_url?.startsWith("/tasteprint-card?session="),
      "The installed Studio did not expose its recap card.",
    );
    const studioCorrectedTasteprintResponse = await fetch(
      new URL(studioCorrection.tasteprint_url, new URL(studioUrl).origin),
    );
    const studioCorrectedTasteprint = await studioCorrectedTasteprintResponse.text();
    assert(
      studioCorrectedTasteprint.includes("Studio Verification Artist"),
      "The installed Studio Tasteprint omitted its correction.",
    );

    const studioRetractionResponse = await studioProfileRequest(
      studioUrl,
      "/api/corrections/retract",
      { correction_id: studioCorrection.corrections[0].correction_id },
    );
    const studioRetraction = await studioRetractionResponse.json();
    assert(studioRetractionResponse.status === 200, "The installed Studio could not retract a correction.");
    assert(studioRetraction.active_corrections === 0, "The installed Studio retraction remained active.");
    assert(
      studioRetraction.coverage?.effective_listening_events === 3,
      "The installed Studio retraction rewrote listening history.",
    );

    const after = await stat(archivePath);
    assert(before.size === after.size && before.mtimeMs === after.mtimeMs, "The installed Studio changed the source ZIP.");
    assert((await readdir(studioTemporaryRoot)).length === 0, "The installed Studio retained a temporary upload.");
    const tasteprintResponse = await fetch(
      new URL(studioRetraction.tasteprint_url, new URL(studioUrl).origin),
    );
    const tasteprint = await tasteprintResponse.text();
    assert(tasteprintResponse.status === 200, "The installed Studio did not serve the Tasteprint.");
    assert(tasteprint.includes("Private Moondog Tasteprint"), "The installed Tasteprint is incomplete.");
    assert(tasteprint.includes("1 provisional track identity joined to resolved Spotify identities."), "The installed Tasteprint omitted cross-format identity coverage.");
    assert(tasteprint.includes("Multi-target cases stay separate"), "The installed Tasteprint omitted the ambiguous-link boundary.");
    assert(tasteprint.includes("Original records remain intact."), "The installed Tasteprint omitted the immutable-evidence boundary.");
    assert(!/<script/iu.test(tasteprint), "The installed Tasteprint contains a script.");
    assert(!/https?:\/\//iu.test(tasteprint), "The installed Tasteprint contains an external URL.");
    const tasteprintCardResponse = await fetch(
      new URL(studioRetraction.tasteprint_card_url, new URL(studioUrl).origin),
    );
    const tasteprintCard = await tasteprintCardResponse.text();
    assert(tasteprintCardResponse.status === 200, "The installed Studio did not serve the recap card.");
    assert(tasteprintCard.includes("Private Moondog Tasteprint Card"), "The installed recap card is incomplete.");
    assert(tasteprintCard.includes("Review before sharing"), "The installed recap card omitted its privacy review boundary.");
    assert(!tasteprintCard.includes("Installed Studio verification signal."), "The installed recap card exposed a private correction note.");
    assert(!/<script/iu.test(tasteprintCard), "The installed recap card contains a script.");
    assert(!/https?:\/\//iu.test(tasteprintCard), "The installed recap card contains an external URL.");
    const tasteprintCardDownloadResponse = await fetch(
      new URL(
        `${studioRetraction.tasteprint_card_url}&download=1`,
        new URL(studioUrl).origin,
      ),
    );
    assert(tasteprintCardDownloadResponse.status === 200, "The installed Studio could not download the recap card.");
    assert(
      tasteprintCardDownloadResponse.headers.get("content-disposition") ===
        "attachment; filename=\"moondog-private-tasteprint-card.html\"",
      "The installed Studio recap download did not use a private portable filename.",
    );
    assert(
      await tasteprintCardDownloadResponse.text() === tasteprintCard,
      "The installed Studio recap download changed the artifact bytes.",
    );

    const studioListenBrainzPath = await createSyntheticListenBrainzFile(
      consumerRoot,
      {
        fileName: "synthetic-studio-listenbrainz-history.json",
        userSentinel: "PRIVATE_LISTENBRAINZ_STUDIO_PACKAGE_SENTINEL",
        listenedAtOffsetSeconds: 86_400,
      },
    );
    const studioListenBrainzBefore = await stat(studioListenBrainzPath);
    const studioListenBrainz = await readFile(studioListenBrainzPath);
    const firstStudioListenBrainzResponse = await postHistoryJson(
      studioUrl,
      studioListenBrainz,
    );
    const firstStudioListenBrainz = await firstStudioListenBrainzResponse.json();
    assert(firstStudioListenBrainzResponse.status === 200, "The installed Studio could not import ListenBrainz JSON.");
    assert(firstStudioListenBrainz.source?.provider === "listenbrainz", "The installed Studio mislabeled its ListenBrainz source.");
    assert(firstStudioListenBrainz.source?.already_imported === false, "The installed Studio treated new ListenBrainz JSON as repeated.");
    assert(firstStudioListenBrainz.source?.effective_event_delta === 2, "The installed Studio reported the wrong ListenBrainz event delta.");
    assert(firstStudioListenBrainz.source?.mapped_track_refs === 1, "The installed Studio lost the server-resolved MusicBrainz mapping.");
    assert(firstStudioListenBrainz.source?.events_with_played_duration === 1, "The installed Studio reported the wrong ListenBrainz duration coverage.");
    assert(firstStudioListenBrainz.coverage?.effective_listening_events === 5, "The installed Studio did not combine Spotify and ListenBrainz history.");
    assert(
      !JSON.stringify(firstStudioListenBrainz).includes(
        "PRIVATE_LISTENBRAINZ_STUDIO_PACKAGE_SENTINEL",
      ),
      "The installed Studio exposed a ListenBrainz username.",
    );
    assert(
      !JSON.stringify(firstStudioListenBrainz).includes("private.example"),
      "The installed Studio exposed a ListenBrainz source URL.",
    );

    const repeatedStudioListenBrainzResponse = await postHistoryJson(
      studioUrl,
      studioListenBrainz,
    );
    const repeatedStudioListenBrainz =
      await repeatedStudioListenBrainzResponse.json();
    assert(repeatedStudioListenBrainzResponse.status === 200, "The installed Studio could not repeat a ListenBrainz import.");
    assert(repeatedStudioListenBrainz.source?.already_imported === true, "The installed Studio missed a repeated ListenBrainz file.");
    assert(repeatedStudioListenBrainz.source?.effective_event_delta === 0, "The installed Studio duplicated ListenBrainz events.");
    assert(repeatedStudioListenBrainz.coverage?.effective_listening_events === 5, "The repeated Studio import changed profile coverage.");
    const multiSourceStudioTasteprintResponse = await fetch(
      new URL(
        repeatedStudioListenBrainz.tasteprint_url,
        new URL(studioUrl).origin,
      ),
    );
    const multiSourceStudioTasteprint =
      await multiSourceStudioTasteprintResponse.text();
    assert(multiSourceStudioTasteprintResponse.status === 200, "The installed Studio did not serve its multi-source Tasteprint.");
    assert(multiSourceStudioTasteprint.includes("Cross-provider events are combined"), "The installed Studio Tasteprint lost its multi-source boundary.");
    assert(!multiSourceStudioTasteprint.includes("PRIVATE_LISTENBRAINZ_STUDIO_PACKAGE_SENTINEL"), "The installed Studio Tasteprint exposed a ListenBrainz username.");
    assert(!multiSourceStudioTasteprint.includes("private.example"), "The installed Studio Tasteprint exposed a source URL.");
    const studioListenBrainzAfter = await stat(studioListenBrainzPath);
    assert(
      studioListenBrainzBefore.size === studioListenBrainzAfter.size &&
        studioListenBrainzBefore.mtimeMs === studioListenBrainzAfter.mtimeMs,
      "The installed Studio changed the source ListenBrainz JSON.",
    );
    assert((await readdir(studioTemporaryRoot)).length === 0, "The installed Studio retained a temporary ListenBrainz upload.");
  } finally {
    await stopStudio(studio);
  }

  assert((await stat(path.join(stateRoot, "listening-history.sqlite"))).isFile(), "The installed Studio did not persist listening history.");
  assert((await readdir(path.join(stateRoot, "tasteprints"))).length === 7, "The installed Studio did not persist import and correction Tasteprints.");

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
    correctedTaste.coverage?.effective_listening_events === 5,
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

  const correctedTasteprintPath = path.join(
    consumerRoot,
    "corrected-tasteprint.html",
  );
  await execFileAsync(
    binaryPath,
    ["taste", "--html", "--output", correctedTasteprintPath],
    {
      cwd: consumerRoot,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  const correctedTasteprint = await readFile(correctedTasteprintPath, "utf8");
  assert(correctedTasteprint.includes("Your corrections"), "The installed Tasteprint did not expose listener corrections.");
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
    correctedTasteprintCard.includes("Review before sharing"),
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
  assert(multiSourceTaste.coverage?.effective_listening_events === 7, "The installed multi-source Tasteprint has the wrong coverage.");
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
      `Verified installable package from an isolated npm cache: ${pack.entryCount} files, ${(pack.size / (1024 * 1024)).toFixed(2)} MiB packed, CLI, no-model dated Apple latest-single path with fail-closed exact Wikidata alias recovery, deterministic explicit public artist-page recovery, and optional local Spotify archive disambiguation, fictional history generation, one- and two-archive in-memory Taste, six-track demo, production-importer zero-data Studio tour, one- and two-archive session-only Studio, monthly Listening Pulse, fixed UTC Listening Seasons, long-gap historical-return evidence and planning, played-back-to-back evidence and planning, transparent Time Machine year coverage, continuity and change map, approximate session shape, multi-track release depth, Studio correction loop, import-order-independent Spotify reconciliation, fail-closed cross-format track identity linking with a visible applied and withheld coverage ledger, ListenBrainz import, repeat imports, multi-source private Tasteprint, privacy-bounded Tasteprint card, Studio and CLI listener correction, and recoverable local data control.\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Package verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
