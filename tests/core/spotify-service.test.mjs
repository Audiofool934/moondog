import assert from "node:assert/strict";
import test from "node:test";

import {
  SpotifyServiceError,
  createSpotifyService,
} from "../../src/integrations/spotify/service.mjs";

function fakeClient() {
  const calls = [];
  const client = {
    getAccount: async () => ({ provider: "spotify", product: "premium" }),
    getCurrentPlayback: async () => ({ provider: "spotify", state: "inactive" }),
    getDevices: async () => ({ provider: "spotify", devices: [] }),
    getQueue: async () => ({ provider: "spotify", queue: [] }),
    getRecentlyPlayed: async (input) => {
      calls.push({ method: "getRecentlyPlayed", input });
      return { provider: "spotify", items: [] };
    },
  };
  for (const method of [
    "resume",
    "pause",
    "next",
    "previous",
    "setVolume",
    "seek",
    "setShuffle",
    "setRepeat",
    "transfer",
    "addToQueue",
  ]) {
    client[method] = async (input) => calls.push({ method, input });
  }
  return { client, calls };
}

test("Spotify service exposes normalized read methods for application injection", async () => {
  const fixture = fakeClient();
  const service = createSpotifyService({ client: fixture.client });

  assert.deepEqual(await service.account(), {
    provider: "spotify",
    product: "premium",
  });
  assert.deepEqual(await service.currentPlayer(), {
    provider: "spotify",
    state: "inactive",
  });
  assert.deepEqual(await service.devices(), {
    provider: "spotify",
    devices: [],
  });
  assert.deepEqual(await service.queue(), {
    provider: "spotify",
    queue: [],
  });
  assert.deepEqual(await service.recentActivity({ limit: 7, after: 123 }), {
    provider: "spotify",
    items: [],
  });
  assert.deepEqual(fixture.calls, [
    {
      method: "getRecentlyPlayed",
      input: { limit: 7, after: 123 },
    },
  ]);
});

test("Spotify service bounds recent activity and rejects conflicting cursors", async () => {
  const fixture = fakeClient();
  const service = createSpotifyService({ client: fixture.client });

  await service.recentActivity();
  assert.deepEqual(fixture.calls[0], {
    method: "getRecentlyPlayed",
    input: { limit: 20 },
  });
  await assert.rejects(service.recentActivity({ limit: 0 }), {
    code: "invalid_recent_limit",
  });
  await assert.rejects(service.recentActivity({ after: 1, before: 2 }), {
    code: "conflicting_recent_cursors",
  });
  await assert.rejects(service.recentActivity({ after: -1 }), {
    code: "invalid_recent_cursor",
  });
  assert.equal(fixture.calls.length, 1);
});

test("Spotify service returns metadata-free receipts for every write action", async () => {
  const fixture = fakeClient();
  const service = createSpotifyService({ client: fixture.client });
  const deviceId = "PRIVATE_DEVICE_SENTINEL";
  const uri = "spotify:track:PrivateTrack123";
  const receipts = [
    await service.resume({ deviceId, uris: [uri], positionMs: 1_000 }),
    await service.pause({ deviceId }),
    await service.next({ deviceId }),
    await service.previous({ deviceId }),
    await service.setVolume({ deviceId, percent: 20 }),
    await service.seek({ deviceId, positionMs: 5_000 }),
    await service.setShuffle({ deviceId, state: true }),
    await service.setRepeat({ deviceId, state: "context" }),
    await service.transfer({ deviceId, play: true }),
    await service.addToQueue({ deviceId, uri }),
  ];

  assert.equal(fixture.calls.length, 10);
  assert.deepEqual(
    receipts.map((receipt) => receipt.action),
    [
      "playback.resume",
      "playback.pause",
      "playback.next",
      "playback.previous",
      "playback.volume.set",
      "playback.seek",
      "playback.shuffle.set",
      "playback.repeat.set",
      "playback.transfer",
      "playback.queue.add",
    ],
  );
  assert.equal(receipts.every((receipt) => receipt.effect === "write_external"), true);
  assert.equal(receipts.every((receipt) => receipt.state === "accepted"), true);
  assert.equal(JSON.stringify(receipts).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(receipts).includes("spotify:track"), false);
});

test("Spotify service rejects invalid controls before invoking the client", async () => {
  const fixture = fakeClient();
  const service = createSpotifyService({ client: fixture.client });

  await assert.rejects(service.setVolume({ percent: 101 }), {
    code: "invalid_volume",
  });
  await assert.rejects(service.seek({}), {
    code: "invalid_position",
  });
  await assert.rejects(service.setShuffle({ state: "yes" }), {
    code: "invalid_shuffle_state",
  });
  await assert.rejects(service.setRepeat({ state: "all" }), {
    code: "invalid_repeat_state",
  });
  await assert.rejects(service.transfer({}), {
    code: "invalid_device_id",
  });
  await assert.rejects(service.addToQueue({ uri: "https://example.com" }), {
    code: "invalid_spotify_uri",
  });
  await assert.rejects(
    service.resume({
      contextUri: "spotify:playlist:one",
      uris: ["spotify:track:one"],
    }),
    SpotifyServiceError,
  );
  assert.equal(fixture.calls.length, 0);
});

test("Spotify queue targets the sole available unrestricted device", async () => {
  const fixture = fakeClient();
  fixture.client.getDevices = async () => ({
    provider: "spotify",
    devices: [
      {
        id: "sole-device",
        is_active: false,
        is_restricted: false,
      },
    ],
  });
  const service = createSpotifyService({ client: fixture.client });

  const receipt = await service.addToQueue({ uri: "spotify:track:one" });

  assert.equal(receipt.action, "playback.queue.add");
  assert.deepEqual(fixture.calls, [
    {
      method: "addToQueue",
      input: { uri: "spotify:track:one", deviceId: "sole-device" },
    },
  ]);
});

test("Spotify queue does not guess between inactive devices", async () => {
  const fixture = fakeClient();
  fixture.client.getDevices = async () => ({
    provider: "spotify",
    devices: [
      { id: "device-a", is_active: false, is_restricted: false },
      { id: "device-b", is_active: false, is_restricted: false },
    ],
  });
  const service = createSpotifyService({ client: fixture.client });

  await assert.rejects(
    service.addToQueue({ uri: "spotify:track:one" }),
    { code: "spotify_active_device_required" },
  );
  assert.deepEqual(fixture.calls, []);
});

test("Spotify service creates a private playlist with tracks and returns a receipt", async () => {
  const calls = [];
  const client = {
    async getAccount() {
      return { provider: "spotify", account_id: "user-1" };
    },
    async createPlaylist(input) {
      calls.push(["create", input]);
      return {
        id: "playlist-1",
        uri: "spotify:playlist:playlist-1",
        name: "Night Drive",
        is_public: false,
        tracks_total: 0,
      };
    },
    async addPlaylistTracks(input) {
      calls.push(["add", input]);
      return { snapshot_id: "snapshot-1" };
    },
  };
  const service = createSpotifyService({ client });

  const receipt = await service.createPlaylistWithTracks({
    name: "  Night Drive  ",
    description: "Six tracks for late driving",
    uris: ["spotify:track:a", "spotify:track:b"],
  });

  assert.deepEqual(calls, [
    ["create", { name: "Night Drive", description: "Six tracks for late driving" }],
    ["add", { playlistId: "playlist-1", uris: ["spotify:track:a", "spotify:track:b"] }],
  ]);
  assert.deepEqual(receipt, {
    provider: "spotify",
    ok: true,
    effect: "write_external",
    action: "playlist.write",
    state: "accepted",
    playlist: { name: "Night Drive", track_count: 2, is_public: false },
    playlist_uri: "spotify:playlist:playlist-1",
    playlist_id: "playlist-1",
  });
});

test("Spotify service rejects invalid playlist writes before any client call", async () => {
  const calls = [];
  const client = {
    async getAccount() {
      calls.push("account");
      return { provider: "spotify", account_id: "user-1" };
    },
    async createPlaylist() {
      calls.push("create");
      return { id: "p", uri: "spotify:playlist:p", name: "x" };
    },
    async addPlaylistTracks() {
      calls.push("add");
    },
  };
  const service = createSpotifyService({ client });

  await assert.rejects(
    service.createPlaylistWithTracks({ name: "", uris: ["spotify:track:a"] }),
    { code: "invalid_playlist_name" },
  );
  await assert.rejects(
    service.createPlaylistWithTracks({
      name: "x".repeat(101),
      uris: ["spotify:track:a"],
    }),
    { code: "invalid_playlist_name" },
  );
  await assert.rejects(
    service.createPlaylistWithTracks({ name: "ok", uris: ["spotify:episode:a"] }),
    { code: "invalid_playlist_tracks" },
  );
  await assert.rejects(
    service.createPlaylistWithTracks({
      name: "ok",
      uris: ["spotify:track:a", "spotify:track:a"],
    }),
    { code: "invalid_playlist_tracks" },
  );
  await assert.rejects(
    service.createPlaylistWithTracks({ name: "ok", uris: [] }),
    { code: "invalid_playlist_tracks" },
  );
  assert.deepEqual(calls, []);
});

test("Spotify service reports a playlist created without its tracks", async () => {
  const calls = [];
  const service = createSpotifyService({
    client: {
      async getAccount() {
        return { provider: "spotify", account_id: "user-1" };
      },
      async createPlaylist() {
        calls.push("create");
        return {
          id: "playlist-1",
          uri: "spotify:playlist:playlist-1",
          name: "Partial Playlist",
          is_public: false,
        };
      },
      async addPlaylistTracks() {
        calls.push("add");
        throw new Error("provider failure");
      },
    },
  });

  await assert.rejects(
    service.createPlaylistWithTracks({
      name: "Partial Playlist",
      uris: ["spotify:track:a"],
    }),
    {
      code: "playlist_created_without_tracks",
      message:
        "Spotify created the private playlist but did not accept its tracks. Check the empty playlist before trying again.",
    },
  );
  assert.deepEqual(calls, ["create", "add"]);
});

test("Spotify service lists only owned private non-collaborative editable playlists", async () => {
  const calls = [];
  const service = createSpotifyService({
    client: {
      async getAccount() {
        calls.push(["account"]);
        return { provider: "spotify", account_id: "user-1" };
      },
      async getCurrentUserPlaylists(input) {
        calls.push(["list", input]);
        return {
          provider: "spotify",
          total: 6,
          limit: 20,
          offset: 0,
          has_more: false,
          items: [
            {
              id: "owned-private",
              name: "Owned Private",
              is_public: false,
              collaborative: false,
              owner_id: "user-1",
              snapshot_id: "snapshot-a",
              tracks_total: 2,
            },
            {
              id: "owned-public",
              name: "Owned Public",
              is_public: true,
              collaborative: false,
              owner_id: "user-1",
              snapshot_id: "snapshot-b",
              tracks_total: 2,
            },
            {
              id: "followed-private",
              name: "Followed Private",
              is_public: false,
              collaborative: false,
              owner_id: "other-user",
              snapshot_id: "snapshot-c",
              tracks_total: 2,
            },
            {
              id: "collaborative-private",
              name: "Collaborative Private",
              is_public: false,
              collaborative: true,
              owner_id: "user-1",
              snapshot_id: "snapshot-d",
              tracks_total: 2,
            },
            {
              id: "too-large",
              name: "Too Large",
              is_public: false,
              collaborative: false,
              owner_id: "user-1",
              snapshot_id: "snapshot-e",
              tracks_total: 101,
            },
            {
              id: "empty-private",
              name: "Empty Private",
              is_public: false,
              collaborative: false,
              owner_id: "user-1",
              snapshot_id: "snapshot-f",
              tracks_total: 0,
            },
          ],
        };
      },
    },
  });

  const result = await service.editablePlaylists({ limit: 20, offset: 0 });

  assert.deepEqual(result, {
    provider: "spotify",
    playlists: [
      {
        playlist_id: "owned-private",
        name: "Owned Private",
        track_count: 2,
      },
      {
        playlist_id: "empty-private",
        name: "Empty Private",
        track_count: 0,
      },
    ],
    excluded: {
      public: 1,
      not_owned: 1,
      collaborative: 1,
      over_track_limit: 1,
      invalid: 0,
    },
    has_more: false,
    next_offset: null,
  });
  assert.deepEqual(calls, [
    ["account"],
    ["list", { limit: 20, offset: 0 }],
  ]);
});

test("Spotify service reads a consistent bounded playlist snapshot", async () => {
  const calls = [];
  let metadataRead = 0;
  const playlist = {
    id: "playlist-1",
    name: "Night Drive",
    is_public: false,
    collaborative: false,
    owner_id: "user-1",
    snapshot_id: "snapshot-1",
    tracks_total: 2,
  };
  const service = createSpotifyService({
    client: {
      async getAccount() {
        calls.push(["account"]);
        return { provider: "spotify", account_id: "user-1" };
      },
      async getPlaylist(input) {
        metadataRead += 1;
        calls.push(["metadata", input, metadataRead]);
        return { ...playlist };
      },
      async getPlaylistItems(input) {
        calls.push(["items", input]);
        return {
          provider: "spotify",
          total: 2,
          limit: 50,
          offset: 0,
          has_more: false,
          items: [
            {
              is_local: false,
              item: {
                type: "track",
                uri: "spotify:track:a",
                name: "Midnight Lines",
                artists: ["Mara Vale"],
                album: "Night Transit",
                duration_ms: 278_000,
              },
            },
            {
              is_local: false,
              item: {
                type: "track",
                uri: "spotify:track:b",
                name: "Glass Highway",
                artists: ["North Window"],
                album: "Slow Roads",
                duration_ms: 251_000,
              },
            },
          ],
        };
      },
    },
  });

  const result = await service.playlistSnapshot({ playlistId: "playlist-1" });

  assert.deepEqual(result, {
    provider: "spotify",
    playlist: {
      playlist_id: "playlist-1",
      name: "Night Drive",
      track_count: 2,
      snapshot_id: "snapshot-1",
    },
    items: [
      {
        uri: "spotify:track:a",
        title: "Midnight Lines",
        artists: ["Mara Vale"],
        album: "Night Transit",
        duration_ms: 278_000,
      },
      {
        uri: "spotify:track:b",
        title: "Glass Highway",
        artists: ["North Window"],
        album: "Slow Roads",
        duration_ms: 251_000,
      },
    ],
  });
  assert.deepEqual(calls, [
    ["account"],
    ["metadata", { playlistId: "playlist-1" }, 1],
    ["items", { playlistId: "playlist-1", limit: 2, offset: 0 }],
    ["metadata", { playlistId: "playlist-1" }, 2],
  ]);
});

test("Spotify service rejects an inconsistent playlist read and never writes", async () => {
  let metadataRead = 0;
  let writes = 0;
  const service = createSpotifyService({
    client: {
      async getAccount() {
        return { provider: "spotify", account_id: "user-1" };
      },
      async getPlaylist() {
        metadataRead += 1;
        return {
          id: "playlist-1",
          name: "Night Drive",
          is_public: false,
          collaborative: false,
          owner_id: "user-1",
          snapshot_id: metadataRead === 1 ? "snapshot-1" : "snapshot-2",
          tracks_total: 1,
        };
      },
      async getPlaylistItems() {
        return {
          provider: "spotify",
          total: 1,
          limit: 50,
          offset: 0,
          has_more: false,
          items: [
            {
              is_local: false,
              item: {
                type: "track",
                uri: "spotify:track:a",
                name: "Midnight Lines",
                artists: ["Mara Vale"],
                album: "Night Transit",
              },
            },
          ],
        };
      },
      async replacePlaylistItems() {
        writes += 1;
      },
    },
  });

  await assert.rejects(
    service.playlistSnapshot({ playlistId: "playlist-1" }),
    { code: "playlist_snapshot_changed" },
  );
  assert.equal(writes, 0);
});

test("Spotify service replaces exact items only when the expected snapshot is current", async () => {
  const calls = [];
  let snapshotId = "snapshot-1";
  const service = createSpotifyService({
    client: {
      async getAccount() {
        calls.push(["account"]);
        return { provider: "spotify", account_id: "user-1" };
      },
      async getPlaylist(input) {
        calls.push(["metadata", input]);
        return {
          id: "playlist-1",
          name: "Night Drive",
          is_public: false,
          collaborative: false,
          owner_id: "user-1",
          snapshot_id: snapshotId,
          tracks_total: 2,
        };
      },
      async replacePlaylistItems(input) {
        calls.push(["replace", input]);
        return { snapshot_id: "snapshot-2" };
      },
    },
  });

  const receipt = await service.replacePlaylistItems({
    playlistId: "playlist-1",
    expectedSnapshotId: "snapshot-1",
    uris: ["spotify:track:b", "spotify:track:a", "spotify:track:a"],
  });

  assert.deepEqual(receipt, {
    provider: "spotify",
    ok: true,
    effect: "write_external",
    action: "playlist.edit",
    state: "accepted",
    playlist: {
      name: "Night Drive",
      track_count: 3,
      is_public: false,
    },
    previous_track_count: 2,
  });
  assert.deepEqual(calls, [
    ["account"],
    ["metadata", { playlistId: "playlist-1" }],
    [
      "replace",
      {
        playlistId: "playlist-1",
        uris: ["spotify:track:b", "spotify:track:a", "spotify:track:a"],
      },
    ],
  ]);

  snapshotId = "snapshot-stale";
  calls.length = 0;
  await assert.rejects(
    service.replacePlaylistItems({
      playlistId: "playlist-1",
      expectedSnapshotId: "snapshot-1",
      uris: ["spotify:track:a"],
    }),
    { code: "playlist_snapshot_changed" },
  );
  assert.deepEqual(calls, [
    ["account"],
    ["metadata", { playlistId: "playlist-1" }],
  ]);
});

test("Spotify service saves and checks library tracks with bounded inputs", async () => {
  const calls = [];
  const client = {
    async checkSavedTracks(input) {
      calls.push(["check", input]);
      return [true, false];
    },
    async saveTracks(input) {
      calls.push(["save", input]);
      return null;
    },
  };
  const service = createSpotifyService({ client });

  const check = await service.checkSavedTracks({
    uris: ["spotify:track:a", "spotify:track:b"],
  });
  const save = await service.saveTracks({ uris: ["spotify:track:a"] });

  assert.deepEqual(check, {
    provider: "spotify",
    checked: [
      { uri: "spotify:track:a", saved: true },
      { uri: "spotify:track:b", saved: false },
    ],
  });
  assert.deepEqual(save, {
    provider: "spotify",
    ok: true,
    effect: "write_external",
    action: "library.save",
    state: "accepted",
    track_count: 1,
  });
  assert.deepEqual(calls, [
    [
      "check",
      { uris: ["spotify:track:a", "spotify:track:b"] },
    ],
    ["save", { uris: ["spotify:track:a"] }],
  ]);
  await assert.rejects(service.saveTracks({ uris: ["spotify:episode:a"] }), {
    code: "invalid_library_tracks",
  });
  await assert.rejects(service.checkSavedTracks({ uris: [] }), {
    code: "invalid_library_tracks",
  });
});

function connectDevice(id, name, type, extras = {}) {
  return {
    id,
    name,
    type,
    is_active: false,
    is_restricted: false,
    ...extras,
  };
}

function deviceClient(devices) {
  const calls = [];
  const client = {
    async getDevices() {
      calls.push({ method: "getDevices" });
      return { provider: "spotify", devices };
    },
    async transfer(input) {
      calls.push({ method: "transfer", input });
    },
  };
  return { client, calls };
}

test("Spotify transfer matches an iPhone by name and keeps the device id out of the receipt", async () => {
  const fixture = deviceClient([
    connectDevice("SECRET_PHONE_ID", "Everett’s iPhone", "Smartphone"),
    connectDevice("SECRET_COMPUTER_ID", "Studio Mac", "Computer", { is_active: true }),
  ]);
  const service = createSpotifyService({ client: fixture.client });

  const receipt = await service.transfer({
    deviceName: "switch it to spotify on iphone rn",
    play: true,
  });

  assert.deepEqual(receipt, {
    provider: "spotify",
    ok: true,
    effect: "write_external",
    action: "playback.transfer",
    state: "accepted",
    device: { name: "Everett’s iPhone", type: "Smartphone" },
  });
  assert.equal(JSON.stringify(receipt).includes("SECRET_"), false);
  assert.deepEqual(fixture.calls, [
    { method: "getDevices" },
    { method: "transfer", input: { deviceId: "SECRET_PHONE_ID", play: true } },
  ]);
});

test("Spotify transfer prefers the exact device name over a partial one", async () => {
  const fixture = deviceClient([
    connectDevice("work-phone", "Work iPhone", "Smartphone"),
    connectDevice("exact-phone", "iPhone", "Smartphone"),
  ]);
  const service = createSpotifyService({ client: fixture.client });

  const receipt = await service.transfer({ deviceName: "iPhone", play: true });

  assert.equal(receipt.device.name, "iPhone");
  assert.equal(fixture.calls.at(-1).input.deviceId, "exact-phone");
});

test("Spotify transfer uses the only phone when its name does not say iPhone", async () => {
  const fixture = deviceClient([
    connectDevice("pixel", "Pocket", "Smartphone"),
    connectDevice("desk", "Studio Mac", "Computer"),
  ]);
  const service = createSpotifyService({ client: fixture.client });

  const receipt = await service.transfer({ deviceName: "iphone" });

  assert.deepEqual(receipt.device, { name: "Pocket", type: "Smartphone" });
  assert.equal(fixture.calls.at(-1).input.deviceId, "pixel");
  assert.equal(fixture.calls.at(-1).input.play, false);
});

test("Spotify transfer asks which device when several names match", async () => {
  const fixture = deviceClient([
    connectDevice("phone-a", "Everett's iPhone", "Smartphone"),
    connectDevice("phone-b", "Work iPhone", "Smartphone"),
  ]);
  const service = createSpotifyService({ client: fixture.client });

  await assert.rejects(service.transfer({ deviceName: "iPhone", play: true }), {
    code: "spotify_device_ambiguous",
    message:
      'Several Spotify devices match "iPhone": Everett\'s iPhone (Smartphone); Work iPhone (Smartphone). Say which one.',
  });
  assert.deepEqual(fixture.calls, [{ method: "getDevices" }]);
});

test("Spotify transfer names the visible devices when nothing matches", async () => {
  const fixture = deviceClient([
    connectDevice("SECRET_PHONE_ID", "Everett's iPhone", "Smartphone", { is_active: true }),
    connectDevice("SECRET_COMPUTER_ID", "Studio Mac", "Computer"),
  ]);
  const service = createSpotifyService({ client: fixture.client });

  await assert.rejects(
    service.transfer({ deviceName: "kitchen" }),
    (error) => {
      assert.equal(error.code, "spotify_device_not_found");
      assert.equal(
        error.message,
        'No Spotify device matches "kitchen". Visible now: Everett\'s iPhone (Smartphone, active); Studio Mac (Computer).',
      );
      assert.equal(error.message.includes("SECRET_"), false);
      return true;
    },
  );
});

test("Spotify transfer reports when no devices are visible", async () => {
  const fixture = deviceClient([]);
  const service = createSpotifyService({ client: fixture.client });

  await assert.rejects(service.transfer({ deviceName: "iPhone" }), {
    code: "spotify_device_not_found",
    message: "No Spotify devices are visible. Open Spotify on that device and try again.",
  });
  assert.deepEqual(fixture.calls, [{ method: "getDevices" }]);
});

test("Spotify transfer refuses a matching device that will not accept playback", async () => {
  const fixture = deviceClient([
    connectDevice("SECRET_PHONE_ID", "Everett's iPhone", "Smartphone", {
      is_restricted: true,
    }),
  ]);
  const service = createSpotifyService({ client: fixture.client });

  await assert.rejects(service.transfer({ deviceName: "iPhone" }), {
    code: "spotify_device_restricted",
    message:
      "Spotify will not take playback on Everett's iPhone. Leave its private session, or pick another device.",
  });
  assert.deepEqual(fixture.calls, [{ method: "getDevices" }]);
});

test("Spotify transfer rejects a device name and a device id together", async () => {
  const fixture = deviceClient([]);
  const service = createSpotifyService({ client: fixture.client });

  await assert.rejects(
    service.transfer({ deviceId: "phone", deviceName: "iPhone" }),
    { code: "conflicting_device_target" },
  );
  await assert.rejects(service.transfer({ deviceName: "   " }), {
    code: "invalid_device_query",
  });
  await assert.rejects(service.transfer({ deviceName: "iPhone", play: "yes" }), {
    code: "invalid_play_state",
  });
  assert.deepEqual(fixture.calls, []);
});
