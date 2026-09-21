import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  runSpotifyCommand,
  spotifyHelpText,
} from "../../src/surfaces/cli/spotify-command.mjs";

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

function fakeSpotify(overrides = {}) {
  const calls = [];
  let configuration = overrides.configuration ?? {
    clientId: "client_id_12345678",
    source: "test",
  };
  const authentication = {
    async status() {
      calls.push(["status"]);
      return {
        provider: "spotify",
        state: "stored",
        type: "oauth",
        accessExpiresAt: 1_800_000_000_000,
        refreshExpiresAt: 1_900_000_000_000,
        scopes:
          overrides.scopes ??
          "user-read-playback-state user-read-currently-playing user-modify-playback-state",
        accessToken: "ACCESS_TOKEN_SENTINEL",
        refreshToken: "REFRESH_TOKEN_SENTINEL",
      };
    },
    async login({ onAuthorizationUrl }) {
      calls.push(["login"]);
      await onAuthorizationUrl(
        "https://accounts.spotify.com/authorize?client_id=safe-client&state=safe-state",
      );
      return {
        provider: "spotify",
        state: "stored",
        type: "oauth",
        accessExpiresAt: 1_800_000_000_000,
        refreshExpiresAt: 1_900_000_000_000,
        scopes:
          overrides.scopes ??
          "user-read-playback-state user-read-currently-playing user-modify-playback-state",
        accessToken: "ACCESS_TOKEN_SENTINEL",
        refreshToken: "REFRESH_TOKEN_SENTINEL",
      };
    },
    async logout() {
      calls.push(["logout"]);
      return { provider: "spotify", state: "not_configured", type: null };
    },
  };
  const receipt = (action) => ({
    provider: "spotify",
    ok: true,
    effect: "write_external",
    action,
    state: "accepted",
    accessToken: "ACCESS_TOKEN_SENTINEL",
  });
  const service = {
    async account() {
      calls.push(["account"]);
      return {
        provider: "spotify",
        account_id: "listener",
        display_name: "Synthetic Listener",
        product: "premium",
        accessToken: "ACCESS_TOKEN_SENTINEL",
      };
    },
    async currentPlayer() {
      calls.push(["currentPlayer"]);
      return {
        provider: "spotify",
        state: "available",
        is_playing: true,
        item: { name: "Echoes", artists: ["Pink Floyd"] },
      };
    },
    async devices() {
      calls.push(["devices"]);
      return {
        provider: "spotify",
        devices: [
          {
            id: "device-1",
            name: "Studio Mac",
            type: "Computer",
            is_active: true,
          },
        ],
      };
    },
    async queue() {
      calls.push(["queue"]);
      return { provider: "spotify", currently_playing: null, queue: [] };
    },
    async recentActivity(value) {
      calls.push(["recentActivity", value]);
      return {
        provider: "spotify",
        cursor_after_ms: 1_788_000_000_000,
        items: [
          {
            played_at: "2026-08-29T04:00:00.000Z",
            track: {
              id: "track-1",
              name: "Echoes",
              artists: ["Pink Floyd"],
              album: "Meddle",
              duration_ms: 1_413_000,
            },
            context_type: "album",
          },
        ],
      };
    },
    async resume(value) {
      calls.push(["resume", value]);
      return receipt("playback.resume");
    },
    async pause(value) {
      calls.push(["pause", value]);
      return receipt("playback.pause");
    },
    async next(value) {
      calls.push(["next", value]);
      return receipt("playback.next");
    },
    async previous(value) {
      calls.push(["previous", value]);
      return receipt("playback.previous");
    },
    async setVolume(value) {
      calls.push(["setVolume", value]);
      return receipt("playback.volume.set");
    },
    async seek(value) {
      calls.push(["seek", value]);
      return receipt("playback.seek");
    },
    async setShuffle(value) {
      calls.push(["setShuffle", value]);
      return receipt("playback.shuffle.set");
    },
    async setRepeat(value) {
      calls.push(["setRepeat", value]);
      return receipt("playback.repeat.set");
    },
    async transfer(value) {
      calls.push(["transfer", value]);
      return receipt("playback.transfer");
    },
    async addToQueue(value) {
      calls.push(["addToQueue", value]);
      return receipt("playback.queue.add");
    },
  };
  return {
    calls,
    spotify: {
      configuration: () => configuration,
      async configure(clientId) {
        calls.push(["configure", clientId]);
        configuration = { clientId, source: "test" };
        return configuration;
      },
      authentication,
      service,
      ...(overrides.resolver ? { resolver: overrides.resolver } : {}),
    },
  };
}

function fixture(runtime = fakeSpotify()) {
  return {
    ...runtime,
    stdout: captureStream(),
    stderr: captureStream(),
    signalTarget: new EventEmitter(),
  };
}

test("Spotify help documents the exact callback and does not initialize a runtime", async () => {
  const stdout = captureStream();
  await runSpotifyCommand({ args: ["help"], stdout });

  assert.equal(stdout.value().trim(), spotifyHelpText());
  assert.match(stdout.value(), /http:\/\/127\.0\.0\.1:43821\/callback/u);
  assert.match(stdout.value(), /spotify queue-add/iu);
  assert.match(stdout.value(), /spotify sync-recent/iu);
  assert.match(stdout.value(), /spotify import-history/iu);
});

test("Spotify configure writes only the public client ID", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-spotify-command-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stdout = captureStream();
  const environment = { MOONDOG_CONFIG_HOME: root };

  await runSpotifyCommand({
    args: ["configure", "spotify_client_123456", "--json"],
    environment,
    stdout,
  });

  assert.deepEqual(JSON.parse(stdout.value()), {
    provider: "spotify",
    state: "configured",
    client_id_configured: true,
    redirect_uri: "http://127.0.0.1:43821/callback",
  });
  const settings = JSON.parse(await readFile(path.join(root, "spotify.json"), "utf8"));
  assert.equal(settings.client_id, "spotify_client_123456");
  assert.equal(JSON.stringify(settings).includes("token"), false);
});

test("Spotify status is offline-safe before configuration", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-spotify-status-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stdout = captureStream();

  await runSpotifyCommand({
    args: ["status", "--json"],
    environment: { MOONDOG_CONFIG_HOME: root },
    stdout,
  });

  assert.deepEqual(JSON.parse(stdout.value()), {
    provider: "spotify",
    state: "not_configured",
    client_id_configured: false,
    type: null,
    access_expires_at: null,
    refresh_expires_at: null,
    redirect_uri: "http://127.0.0.1:43821/callback",
  });
  await assert.rejects(stat(path.join(root, "auth.json")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(root, "spotify.json")), { code: "ENOENT" });
});

test("Spotify status uses the default browser opener path after configuration", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-spotify-status-configured-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stdout = captureStream();
  const environment = { MOONDOG_CONFIG_HOME: root };

  await runSpotifyCommand({
    args: ["configure", "spotify_client_123456"],
    environment,
    stdout: captureStream(),
  });
  await runSpotifyCommand({
    args: ["status", "--json"],
    environment,
    stdout,
  });

  assert.equal(JSON.parse(stdout.value()).client_id_configured, true);
});

test("Spotify login prints the authorization URL and callback without exposing credentials", async () => {
  const setup = fixture();
  await runSpotifyCommand({ args: ["login", "--json"], ...setup });

  assert.deepEqual(setup.calls, [["login"]]);
  assert.match(setup.stderr.value(), /accounts\.spotify\.com\/authorize/u);
  assert.match(setup.stderr.value(), /http:\/\/127\.0\.0\.1:43821\/callback/u);
  const combined = setup.stdout.value() + setup.stderr.value();
  assert.doesNotMatch(combined, /ACCESS_TOKEN_SENTINEL|REFRESH_TOKEN_SENTINEL/u);
  assert.equal(JSON.parse(setup.stdout.value()).state, "stored");
});

test("history-only login reports its granted scope as ready without requesting full login again", async () => {
  for (const json of [true, false]) {
    const setup = fixture(fakeSpotify({ scopes: "user-read-recently-played" }));
    const result = await runSpotifyCommand({ args: ["login", "--history-only"], json, ...setup });
    assert.equal(result.scope_purpose, "recent_listening");
    assert.equal(result.scopes_sufficient, true);
    assert.deepEqual(result.missing_scopes, []);
    assert.doesNotMatch(setup.stdout.value(), /re-login required/u);
    if (!json) assert.match(setup.stdout.value(), /recent-listening scopes: ready/u);
  }
});

test("history-only login requests just recent listening and releases its callback on cancellation", async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    let requestedScope;
    await assert.rejects(runSpotifyCommand({
      args: ["login", "--history-only"],
      spotify: { configuration: { clientId: "test_client_123456" } },
      credentialStore: { async read() {}, async delete() {}, async write() { assert.fail("Cancelled login must not save credentials"); } },
      stdout: captureStream(), stderr: captureStream(), signalTarget: new EventEmitter(),
      signal: controller.signal,
      async openBrowser(url) { requestedScope = new URL(url).searchParams.get("scope"); controller.abort(); },
    }), { code: "spotify_auth_aborted" });
    assert.equal(requestedScope, "user-read-recently-played");
  }
});

test("Spotify status and account JSON whitelist away token-shaped fields", async () => {
  const status = fixture();
  await runSpotifyCommand({ args: ["status", "--json"], ...status });
  assert.equal(JSON.parse(status.stdout.value()).type, "oauth");
  assert.doesNotMatch(status.stdout.value(), /TOKEN_SENTINEL/u);

  const account = fixture();
  await runSpotifyCommand({ args: ["account", "--json"], ...account });
  assert.equal(
    JSON.parse(account.stdout.value()).display_name,
    "Synthetic Listener",
  );
  assert.doesNotMatch(account.stdout.value(), /TOKEN_SENTINEL/u);
});

test("Spotify read commands call the normalized service", async () => {
  const setup = fakeSpotify();
  for (const action of ["account", "now", "devices", "queue"]) {
    await runSpotifyCommand({
      args: [action],
      spotify: setup.spotify,
      stdout: captureStream(),
    });
  }

  assert.deepEqual(setup.calls, [
    ["account"],
    ["currentPlayer"],
    ["devices"],
    ["queue"],
  ]);
});

test("Spotify recent commands preserve bounds and sync through provider-neutral records", async () => {
  const setup = fakeSpotify();
  const ingested = [];
  const store = {
    sourceCursor() {
      return 1_787_999_000_000;
    },
    ingest(bundle) {
      ingested.push(bundle);
      return {
        state: "ready",
        source_key: bundle.source_key,
        fetched_events: bundle.listening_events.length,
        inserted_events: bundle.listening_events.length,
        duplicate_events: 0,
        inserted_track_refs: bundle.track_refs.length,
        cursor_after_ms: bundle.cursor_after_ms,
        profile_effects: "none",
      };
    },
  };

  const recentOutput = captureStream();
  await runSpotifyCommand({
    args: ["recent", "--limit", "7", "--before", "1788000000000"],
    spotify: setup.spotify,
    stdout: recentOutput,
  });
  const syncOutput = captureStream();
  await runSpotifyCommand({
    args: ["sync-recent", "--limit", "50", "--json"],
    spotify: setup.spotify,
    stdout: syncOutput,
    recentActivityStore: store,
    subjectId: "11111111-1111-4111-8111-111111111111",
    now: () => Date.UTC(2026, 7, 29, 5, 0, 0),
  });

  assert.deepEqual(setup.calls, [
    ["recentActivity", { limit: 7, before: 1_788_000_000_000 }],
    ["recentActivity", { limit: 50, after: 1_787_999_000_000 }],
  ]);
  assert.match(recentOutput.value(), /Echoes - Pink Floyd/u);
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].track_refs.length, 1);
  assert.equal(ingested[0].listening_events.length, 1);
  assert.equal(
    ingested[0].listening_events[0].subject_id,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(JSON.parse(syncOutput.value()).profile_effects, "none");
});

test("Spotify account-data import is local and does not initialize OAuth", async () => {
  const importerCalls = [];
  const stored = [];
  const stdout = captureStream();
  const bundle = {
    source_key: "spotify.account_data.streaming_history",
    marker: "validated-bundle",
  };
  await runSpotifyCommand({
    args: ["import-history", "/private/spotify-account-data.zip", "--json"],
    stdout,
    subjectId: "11111111-1111-4111-8111-111111111111",
    now: () => Date.UTC(2026, 7, 29, 5, 0, 0),
    historyArchiveImporter: async (input) => {
      importerCalls.push(input);
      return bundle;
    },
    recentActivityStore: {
      ingestImport(value) {
        stored.push(value);
        return {
          state: "ready",
          source_key: value.source_key,
          source_format: "spotify_account_data_streaming_history_v1",
          data_scope: "past_year_account_data",
          import_batch_id: "22222222-2222-4222-8222-222222222222",
          archive_sha256: "c".repeat(64),
          input_records: 2,
          inserted_events: 2,
          duplicate_events: 0,
          inserted_track_refs: 2,
          cursor_after_ms: 1_788_000_000_000,
          earliest_occurred_at: "2026-08-29T03:58:00.000Z",
          latest_occurred_at: "2026-08-29T04:00:00.000Z",
          already_imported: false,
          profile_effects: "none",
        };
      },
    },
  });

  assert.deepEqual(importerCalls, [
    {
      archivePath: "/private/spotify-account-data.zip",
      subjectId: "11111111-1111-4111-8111-111111111111",
      capturedAt: "2026-08-29T05:00:00.000Z",
    },
  ]);
  assert.deepEqual(stored, [bundle]);
  assert.equal(JSON.parse(stdout.value()).inserted_events, 2);
  assert.equal(stdout.value().includes("/private/"), false);
});

test("Spotify account-data import explains cross-format reconciliation", async () => {
  const stdout = captureStream();
  await runSpotifyCommand({
    args: ["import-history", "/private/spotify-account-data.zip"],
    stdout,
    subjectId: "11111111-1111-4111-8111-111111111111",
    now: () => Date.UTC(2026, 7, 29, 5, 0, 0),
    historyArchiveImporter: async () => ({
      source_key: "spotify.account_data.streaming_history",
    }),
    recentActivityStore: {
      ingestImport() {
        return {
          state: "ready",
          source_key: "spotify.account_data.streaming_history",
          source_format: "spotify_account_data_streaming_history_v1",
          data_scope: "past_year_account_data",
          archive_sha256: "d".repeat(64),
          input_records: 3,
          inserted_events: 3,
          duplicate_events: 0,
          inserted_track_refs: 3,
          superseded_events: 2,
          effective_event_delta: 1,
          profile_input_records: 0,
          inserted_profile_evidence: 0,
          already_imported: false,
          profile_effects: "updated",
        };
      },
    },
  });

  assert.match(stdout.value(), /Reconciled Extended-history overlaps: 2/u);
  assert.match(stdout.value(), /Effective event delta: 1/u);
  assert.doesNotMatch(stdout.value(), /\/private\//u);
});

test("Spotify playback commands map precise arguments into the service", async () => {
  const setup = fakeSpotify();
  const commands = [
    ["play"],
    ["play", "spotify:track:abc123"],
    ["pause"],
    ["next"],
    ["previous"],
    ["volume", "37"],
    ["seek", "12500"],
    ["shuffle", "on"],
    ["repeat", "context"],
    ["transfer", "device-1", "--play"],
    ["queue-add", "spotify:episode:pod123", "device-1"],
  ];
  for (const args of commands) {
    await runSpotifyCommand({
      args,
      spotify: setup.spotify,
      stdout: captureStream(),
    });
  }

  assert.deepEqual(setup.calls, [
    ["resume", undefined],
    ["resume", { uris: ["spotify:track:abc123"] }],
    ["pause", undefined],
    ["next", undefined],
    ["previous", undefined],
    ["setVolume", { percent: 37 }],
    ["seek", { positionMs: 12_500 }],
    ["setShuffle", { state: true }],
    ["setRepeat", { state: "context" }],
    ["transfer", { deviceId: "device-1", play: true }],
    ["addToQueue", { uri: "spotify:episode:pod123", deviceId: "device-1" }],
  ]);
});

test("Spotify command rejects malformed values and misplaced JSON options", async () => {
  const setup = fakeSpotify();
  await assert.rejects(
    runSpotifyCommand({ args: ["volume", "101"], spotify: setup.spotify }),
    /integer from 0 to 100/iu,
  );
  await assert.rejects(
    runSpotifyCommand({ args: ["shuffle", "maybe"], spotify: setup.spotify }),
    /must be on or off/iu,
  );
  await assert.rejects(
    runSpotifyCommand({ args: ["transfer", "device", "--bad"], spotify: setup.spotify }),
    /transfer <device-id>/iu,
  );
  await assert.rejects(
    runSpotifyCommand({ args: ["status", "--json", "extra"], spotify: setup.spotify }),
    /--json option must appear/iu,
  );
  await assert.rejects(
    runSpotifyCommand({ args: ["resolve", "--title", "Missing Artist"] }),
    /--artist/iu,
  );
  await assert.rejects(
    runSpotifyCommand({ args: ["resolve", "--title", "x", "--bad", "y"] }),
    /spotify resolve/iu,
  );
  await assert.rejects(
    runSpotifyCommand({ args: ["dance"], spotify: setup.spotify }),
    /unknown Spotify command/iu,
  );
});

test("Spotify status tells playback-only credentials to re-login for connected actions", async () => {
  const setup = fixture();

  await runSpotifyCommand({ args: ["status", "--json"], ...setup });

  const status = JSON.parse(setup.stdout.value());
  assert.equal(status.scopes_sufficient, false);
  assert.deepEqual(status.missing_scopes, [
    "user-read-private",
    "playlist-read-private",
    "playlist-modify-private",
    "user-library-read",
    "user-library-modify",
    "user-read-recently-played",
  ]);
});

test("Spotify status recognizes complete connected-action authorization scopes", async () => {
  const setup = fixture(
    fakeSpotify({
      scopes: [
        "user-read-playback-state",
        "user-read-currently-playing",
        "user-read-private",
        "user-modify-playback-state",
        "playlist-read-private",
        "playlist-modify-private",
        "user-library-read",
        "user-library-modify",
        "user-read-recently-played",
      ].join(" "),
    }),
  );

  await runSpotifyCommand({ args: ["status"], ...setup });

  assert.match(setup.stdout.value(), /Spotify connected-action scopes: ready/u);
});

test("Spotify resolve command reports deterministic catalog matches", async () => {
  const resolverCalls = [];
  const setup = fixture(
    fakeSpotify({
      resolver: {
        async resolve(tracks) {
          resolverCalls.push(tracks);
          return {
            provider: "spotify",
            requested: 1,
            resolved_count: 1,
            not_found_count: 0,
            resolutions: [
              {
                track_ref_id: "cli",
                status: "resolved",
                match_quality: "exact",
                matched: {
                  title: "Midnight Lines",
                  artists: ["Mara Vale"],
                  album: "Night Transit",
                  duration_ms: 278_000,
                },
                spotify: {
                  track_id: "midnight-lines",
                  uri: "spotify:track:midnight-lines",
                },
              },
            ],
          };
        },
      },
    }),
  );

  await runSpotifyCommand({
    args: [
      "resolve",
      "--title",
      "Midnight Lines",
      "--artist",
      "Mara Vale",
      "--release",
      "Night Transit",
      "--duration-ms",
      "278000",
    ],
    ...setup,
  });

  assert.deepEqual(resolverCalls, [
    [
      {
        track_ref_id: "cli",
        title: "Midnight Lines",
        artist_credit: "Mara Vale",
        release: "Night Transit",
        duration_ms: 278_000,
      },
    ],
  ]);
  assert.match(
    setup.stdout.value(),
    /Midnight Lines - Mara Vale \(exact\)/u,
  );
  assert.doesNotMatch(setup.stdout.value(), /spotify:track/u);
});
