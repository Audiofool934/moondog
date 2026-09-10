import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  listenBrainzHelpText,
  runListenBrainzCommand,
} from "../../src/surfaces/cli/listenbrainz-command.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const subjectId = "11111111-1111-4111-8111-111111111111";

function captureStream() {
  let value = "";
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    value += chunk;
  });
  stream.value = () => value;
  return stream;
}

function receipt() {
  return {
    state: "ready",
    source_key: "listenbrainz.listen_history",
    source_format: "listenbrainz_listen_json_v1",
    data_scope: "saved_listen_json_selection",
    import_batch_id: "22222222-2222-4222-8222-222222222222",
    archive_sha256: "a".repeat(64),
    input_records: 2,
    inserted_events: 2,
    duplicate_events: 0,
    inserted_track_refs: 2,
    superseded_events: 0,
    effective_event_delta: 2,
    cursor_after_ms: 1_740_000_000_000,
    earliest_occurred_at: "2025-01-01T00:00:00.000Z",
    latest_occurred_at: "2025-02-01T00:00:00.000Z",
    already_imported: false,
    profile_effects: "updated",
  };
}

test("ListenBrainz command imports exactly one local JSON file", async () => {
  const stdout = captureStream();
  const calls = [];
  const bundle = {
    track_refs: [
      { identity_status: "resolved" },
      { identity_status: "provisional" },
    ],
    listening_events: [{ played_ms: 180_000 }, {}],
  };
  const result = await runListenBrainzCommand({
    args: ["import-history", "/private/source.json", "--json"],
    stdout,
    subjectId,
    now: () => Date.parse("2026-09-02T06:00:00.000Z"),
    historyFileImporter: async (value) => {
      calls.push(["import", value]);
      return bundle;
    },
    historyStore: {
      ingestImport(value) {
        calls.push(["store", value]);
        return receipt();
      },
    },
  });

  assert.equal(result.provider, "listenbrainz");
  assert.equal(result.mapped_track_refs, 1);
  assert.equal(result.events_with_played_ms, 1);
  assert.equal(result.source_file_retained, false);
  assert.equal(result.direct_account_identifiers_retained, false);
  assert.deepEqual(calls[0], [
    "import",
    {
      filePath: "/private/source.json",
      subjectId,
      capturedAt: "2026-09-02T06:00:00.000Z",
    },
  ]);
  assert.deepEqual(calls[1], ["store", bundle]);
  assert.equal(stdout.value().includes("/private/source.json"), false);
  assert.deepEqual(JSON.parse(stdout.value()), result);
});

test("ListenBrainz command help and argument failures do not initialize storage", async () => {
  const stdout = captureStream();
  await runListenBrainzCommand({ args: ["help"], stdout });
  assert.equal(stdout.value().trim(), listenBrainzHelpText());
  assert.match(stdout.value(), /local and offline/iu);

  await assert.rejects(
    runListenBrainzCommand({ args: ["import-history"] }),
    /Usage: moondog listenbrainz import-history/iu,
  );
  await assert.rejects(
    runListenBrainzCommand({
      args: ["import-history", "one.json", "--json", "extra"],
    }),
    /--json option must appear once at the end/iu,
  );
});

test("real CLI persists ListenBrainz history idempotently and enables a provider-neutral Tasteprint", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-listenbrainz-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config");
  const stateRoot = path.join(root, "state");
  const filePath = path.join(root, "listenbrainz-history.json");
  const source = JSON.stringify({
    payload: {
      count: 2,
      user_id: "PRIVATE_REAL_CLI_USER_SENTINEL",
      listens: [
        {
          listened_at: 1_735_689_600,
          recording_msid: "fd0cad33-ea33-453b-8155-1292379277db",
          user_name: "PRIVATE_REAL_CLI_USER_SENTINEL",
          track_metadata: {
            artist_name: "Portishead",
            track_name: "Roads",
            release_name: "Dummy",
            additional_info: {
              duration_ms: 305_000,
              duration_played: 240,
              origin_url: "https://private.example/real-cli-sentinel",
            },
            mbid_mapping: {
              recording_mbid: "30d08f4c-d825-4ae1-b79c-44242cddd7c0",
            },
          },
        },
        {
          listened_at: 1_738_368_000,
          track_metadata: {
            artist_name: "Björk",
            track_name: "Jóga",
          },
        },
      ],
    },
  });
  await writeFile(filePath, source, { mode: 0o600 });
  const before = await stat(filePath);
  const environment = {
    ...process.env,
    MOONDOG_CONFIG_HOME: configRoot,
    MOONDOG_STATE_HOME: stateRoot,
    MOONDOG_APPLE_IMPORTS_ROOT: path.join(root, "missing-apple-imports"),
    MOONDOG_APPLE_PROJECTION_PATH: path.join(root, "missing-apple.sqlite"),
    NO_COLOR: "1",
  };
  const run = (args) =>
    execFileAsync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        path.join(repositoryRoot, "scripts/moondog.mjs"),
        ...args,
      ],
      {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
        timeout: 30_000,
      },
    );

  const first = JSON.parse(
    (await run(["listenbrainz", "import-history", filePath, "--json"]))
      .stdout,
  );
  const second = JSON.parse(
    (await run(["listenbrainz", "import-history", filePath, "--json"]))
      .stdout,
  );
  const taste = JSON.parse((await run(["taste", "--json"])).stdout);
  const after = await stat(filePath);

  assert.equal(first.inserted_events, 2);
  assert.equal(first.mapped_track_refs, 1);
  assert.equal(first.events_with_played_ms, 1);
  assert.equal(first.already_imported, false);
  assert.equal(second.inserted_events, 0);
  assert.equal(second.already_imported, true);
  assert.equal(taste.profile_version, "profile-projection/listening-history/1");
  assert.equal(taste.coverage.effective_listening_events, 2);
  assert.equal(taste.coverage.events_with_played_duration, 1);
  assert.deepEqual(taste.listening_source.providers, ["listenbrainz"]);
  assert.equal(taste.listening_behavior.repeat_tracks[0].label, "Roads");
  assert.equal(
    JSON.stringify({ first, second, taste }).includes(
      "PRIVATE_REAL_CLI_USER_SENTINEL",
    ),
    false,
  );
  assert.equal(
    JSON.stringify({ first, second, taste }).includes("private.example"),
    false,
  );
  assert.equal(before.size, after.size);
  assert.equal(before.mtimeMs, after.mtimeMs);
});
