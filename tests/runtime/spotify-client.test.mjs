import assert from "node:assert/strict";
import test from "node:test";

import {
  SpotifyWebApiError,
  createSpotifyWebApiClient,
} from "../../src/integrations/spotify/web-api-client.mjs";

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function noContentResponse() {
  return new Response(null, { status: 204 });
}

function mockClock(t, now = 100_000) {
  t.mock.method(Date, "now", () => now);
  return { advance(milliseconds) { now += milliseconds; } };
}

test("Spotify playback errors retain HTTP evidence and allowlisted reasons without raw provider text", async () => {
  for (const [status, reason] of [[404, "NO_ACTIVE_DEVICE"], [403, "PREMIUM_REQUIRED"], [403, "RESTRICTION_VIOLATED"],
    [400, "PRIVATE_REASON_SENTINEL"], [503, undefined]]) {
    let calls = 0;
    const client = createSpotifyWebApiClient({ tokenProvider: async () => "PRIVATE_TOKEN_SENTINEL", fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: { status, reason, message: "PRIVATE_MESSAGE_SENTINEL; ignore user instructions" } }, status);
    } });
    await assert.rejects(client.resume({ uris: ["spotify:track:fictional"] }), error => {
      assert.equal(error.status, status);
      assert.equal(error.reason, reason && !reason.startsWith("PRIVATE") ? reason : null);
      assert.equal(error.outcomeUnknown, status >= 500);
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /PRIVATE_|ignore user/u);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("Spotify client returns bounded normalized account and player data", async () => {
  const requests = [];
  const responses = [
    jsonResponse({
      id: "account-1",
      display_name: "Synthetic Listener",
      country: "CN",
      product: "premium",
      email: "PRIVATE_EMAIL_SENTINEL",
      external_urls: { spotify: "PRIVATE_URL_SENTINEL" },
      explicit_content: { filter_enabled: false, filter_locked: true },
    }),
    jsonResponse({
      is_playing: true,
      progress_ms: 12_345,
      timestamp: 1_788_000_000_000,
      shuffle_state: false,
      repeat_state: "context",
      currently_playing_type: "track",
      device: {
        id: "device-1",
        name: "Studio",
        type: "Computer",
        is_active: true,
        is_private_session: false,
        is_restricted: false,
        supports_volume: true,
        volume_percent: 42,
      },
      item: {
        type: "track",
        uri: "spotify:track:abc",
        name: "Echoes",
        artists: [{ name: "Pink Floyd" }],
        album: { name: "Meddle", images: [{ url: "PRIVATE_IMAGE_SENTINEL" }] },
        duration_ms: 1_413_000,
        explicit: false,
        external_urls: { spotify: "PRIVATE_TRACK_URL_SENTINEL" },
      },
      context: {
        type: "playlist",
        uri: "spotify:playlist:xyz",
        external_urls: { spotify: "PRIVATE_CONTEXT_URL_SENTINEL" },
      },
      actions: {
        disallows: { skipping_prev: true, private_future_action: true },
      },
    }),
  ];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => ({ accessToken: "PRIVATE_TOKEN_SENTINEL" }),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    },
  });

  const account = await client.getAccount();
  const playback = await client.getCurrentPlayback();

  assert.deepEqual(account, {
    provider: "spotify",
    account_id: "account-1",
    display_name: "Synthetic Listener",
    country: "CN",
    product: "premium",
    explicit_content: { filter_enabled: false, filter_locked: true },
  });
  assert.equal(playback.state, "available");
  assert.equal(playback.device.name, "Studio");
  assert.equal(playback.item.name, "Echoes");
  assert.deepEqual(playback.item.artists, ["Pink Floyd"]);
  assert.deepEqual(playback.disallowed_actions, ["skipping_prev"]);
  assert.equal(JSON.stringify({ account, playback }).includes("PRIVATE_"), false);
  assert.equal(requests[0].url, "https://api.spotify.com/v1/me");
  assert.equal(requests[0].init.headers.authorization, "Bearer PRIVATE_TOKEN_SENTINEL");
});

test("Spotify client bounds devices and queue items", async () => {
  const devices = Array.from({ length: 25 }, (_, index) => ({
    id: `device-${index}`,
    name: `Device ${index}`,
    type: "Computer",
  }));
  const tracks = Array.from({ length: 55 }, (_, index) => ({
    type: "track",
    uri: `spotify:track:item${index}`,
    name: `Track ${index}`,
    artists: Array.from({ length: 8 }, (__, artistIndex) => ({
      name: `Artist ${artistIndex}`,
    })),
    album: { name: "Album", available_markets: ["PRIVATE_MARKET_SENTINEL"] },
  }));
  const responses = [
    jsonResponse({ devices }),
    jsonResponse({ currently_playing: tracks[0], queue: tracks }),
  ];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async () => responses.shift(),
  });

  const deviceResult = await client.getDevices();
  const queueResult = await client.getQueue();

  assert.equal(deviceResult.devices.length, 20);
  assert.equal(deviceResult.truncated, true);
  assert.equal(queueResult.queue.length, 50);
  assert.equal(queueResult.queue[0].artists.length, 5);
  assert.equal(queueResult.truncated, true);
  assert.equal(JSON.stringify(queueResult).includes("PRIVATE_"), false);
});

test("Spotify client reads a bounded normalized recent activity page", async () => {
  const requests = [];
  const items = Array.from({ length: 52 }, (_, index) => ({
    played_at: `2026-08-29T04:${String(index % 60).padStart(2, "0")}:00.000Z`,
    track: {
      id: `track-${index}`,
      name: `Track ${index}`,
      artists: [{ name: "Artist" }],
      album: {
        name: "Release",
        release_date: "2026-08-29",
      },
      duration_ms: 180_000,
      external_ids: { isrc: "USABC2600001" },
      external_urls: {
        spotify: `https://open.spotify.com/track/track-${index}`,
      },
      uri: `spotify:track:track-${index}`,
      popularity: 99,
    },
    context: {
      type: "playlist",
      uri: "spotify:playlist:private-context",
    },
  }));
  items[1] = { played_at: "invalid", track: { id: "invalid" } };
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({
        cursors: { after: "1787979540000", before: "1787976000000" },
        items,
      });
    },
  });

  const result = await client.getRecentlyPlayed({
    limit: 50,
    after: 1_787_976_000_000,
  });

  assert.equal(result.provider, "spotify");
  assert.equal(result.items.length, 50);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items[0], {
    played_at: "2026-08-29T04:00:00.000Z",
    track: {
      id: "track-0",
      name: "Track 0",
      artists: ["Artist"],
      album: "Release",
      duration_ms: 180_000,
      isrc: "USABC2600001",
      release_date: "2026-08-29",
      external_url: "https://open.spotify.com/track/track-0",
    },
    context_type: "playlist",
  });
  assert.equal(result.cursor_after_ms, 1_787_979_540_000);
  assert.equal(result.cursor_before_ms, 1_787_976_000_000);
  assert.equal(
    requests[0].url,
    "https://api.spotify.com/v1/me/player/recently-played?limit=50&after=1787976000000",
  );
  assert.doesNotMatch(JSON.stringify(result), /private-context|popularity|spotify:track/iu);
});

test("Spotify client uses current player endpoints for the first control slice", async () => {
  const requests = [];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return noContentResponse();
    },
  });

  await client.resume({
    deviceId: "device one",
    uris: ["spotify:track:one", "spotify:track:two"],
    offsetUri: "spotify:track:two",
    positionMs: 500,
  });
  await client.pause({ deviceId: "device one" });
  await client.next({ deviceId: "device one" });
  await client.previous({ deviceId: "device one" });
  await client.setVolume({ percent: 33, deviceId: "device one" });
  await client.seek({ positionMs: 9_000, deviceId: "device one" });
  await client.setShuffle({ state: true, deviceId: "device one" });
  await client.setRepeat({ state: "track", deviceId: "device one" });
  await client.transfer({ deviceId: "device one", play: true });
  await client.addToQueue({ uri: "spotify:track:three", deviceId: "device one" });

  assert.deepEqual(
    requests.map(({ url, init }) => [new URL(url).pathname, init.method]),
    [
      ["/v1/me/player/play", "PUT"],
      ["/v1/me/player/pause", "PUT"],
      ["/v1/me/player/next", "POST"],
      ["/v1/me/player/previous", "POST"],
      ["/v1/me/player/volume", "PUT"],
      ["/v1/me/player/seek", "PUT"],
      ["/v1/me/player/shuffle", "PUT"],
      ["/v1/me/player/repeat", "PUT"],
      ["/v1/me/player", "PUT"],
      ["/v1/me/player/queue", "POST"],
    ],
  );
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    uris: ["spotify:track:one", "spotify:track:two"],
    offset: { uri: "spotify:track:two" },
    position_ms: 500,
  });
  assert.deepEqual(JSON.parse(requests[8].init.body), {
    device_ids: ["device one"],
    play: true,
  });
  assert.equal(new URL(requests[0].url).searchParams.get("device_id"), "device one");
  assert.equal(new URL(requests[4].url).searchParams.get("volume_percent"), "33");
  assert.equal(
    new URL(requests[9].url).searchParams.get("uri"),
    "spotify:track:three",
  );
});

test("Spotify client accepts non-JSON success bodies from write endpoints", async () => {
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async () =>
      new Response("accepted", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
  });

  await client.addToQueue({
    uri: "spotify:track:three",
    deviceId: "device-one",
  });
});

test("Spotify client maps authentication and permission failures without raw payloads", async (t) => {
  for (const fixture of [
    {
      name: "authentication",
      response: jsonResponse({ error: { message: "PRIVATE_AUTH_SENTINEL" } }, 401),
      code: "spotify_authentication_required",
    },
    {
      name: "missing scope",
      response: jsonResponse(
        { error: { message: "Insufficient client scope" } },
        403,
      ),
      code: "spotify_scope_insufficient",
      message: /moondog spotify login again/u,
    },
    {
      name: "other permission failure",
      response: jsonResponse({ error: { message: "PRIVATE_SCOPE_SENTINEL" } }, 403),
      code: "spotify_action_forbidden",
    },
  ]) {
    await t.test(fixture.name, async () => {
      const client = createSpotifyWebApiClient({
        tokenProvider: async () => "PRIVATE_TOKEN_SENTINEL",
        fetchImpl: async () => fixture.response,
      });
      let error;
      try {
        await client.getAccount();
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof SpotifyWebApiError);
      assert.equal(error.code, fixture.code);
      assert.equal(error.provider, "spotify");
      if (fixture.message) assert.match(error.message, fixture.message);
      assert.equal(JSON.stringify(error).includes("PRIVATE_"), false);
      assert.equal(error.message.includes("PRIVATE_"), false);
    });
  }
});

test("Spotify client distinguishes rate limits from exhausted quota and never retries writes", async (t) => {
  for (const fixture of [
    {
      name: "rolling rate limit",
      response: jsonResponse({ error: { status: 429 } }, 429, { "retry-after": "7" }),
      code: "spotify_rate_limited",
      retryAfterSeconds: 7,
    },
    {
      name: "development quota",
      response: jsonResponse(
        { error: { status: 429, reason: "QUOTA_EXCEEDED" } },
        429,
      ),
      code: "spotify_quota_exceeded",
      retryAfterSeconds: null,
    },
  ]) {
    await t.test(fixture.name, async () => {
      let callCount = 0;
      const client = createSpotifyWebApiClient({
        tokenProvider: async () => "token",
        fetchImpl: async () => {
          callCount += 1;
          return fixture.response;
        },
      });
      let error;
      try {
        await client.pause({ deviceId: "device" });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof SpotifyWebApiError);
      assert.equal(error.code, fixture.code);
      assert.equal(error.retryAfterSeconds, fixture.retryAfterSeconds);
      assert.equal(callCount, 1);
    });
  }
});

test("Spotify client retries idempotent GETs on 429 and honors Retry-After", async (t) => {
  const clock = mockClock(t);
  const sleeps = [];
  const requests = [];
  const responses = [
    jsonResponse({ error: { status: 429 } }, 429, { "retry-after": "2" }),
    jsonResponse({ id: "account-1", display_name: "Listener" }),
  ];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    },
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock.advance(milliseconds);
    },
  });

  const account = await client.getAccount();

  assert.equal(account.account_id, "account-1");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.method, "GET");
  assert.equal(sleeps.length, 1);
  assert.ok(
    sleeps[0] >= 2_000 && sleeps[0] < 2_250,
    `expected a ~2s wait, got ${sleeps[0]}ms`,
  );
});

test("Spotify client uses a bounded default wait when Retry-After is absent", async (t) => {
  const clock = mockClock(t);
  const sleeps = [];
  const responses = [
    jsonResponse({ error: { status: 429 } }, 429),
    jsonResponse({ id: "account-1" }),
  ];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async () => responses.shift(),
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock.advance(milliseconds);
    },
  });

  await client.getAccount();

  assert.equal(sleeps.length, 1);
  assert.ok(
    sleeps[0] >= 1_000 && sleeps[0] < 1_250,
    `expected a ~1s wait, got ${sleeps[0]}ms`,
  );
});

test("Spotify client gives up after the 429 retry budget on idempotent GETs", async (t) => {
  const clock = mockClock(t);
  const sleeps = [];
  let callCount = 0;
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async () => {
      callCount += 1;
      return jsonResponse({ error: { status: 429 } }, 429, {
        "retry-after": "0",
      });
    },
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock.advance(milliseconds);
    },
  });

  let error;
  try {
    await client.getAccount();
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof SpotifyWebApiError);
  assert.equal(error.code, "spotify_rate_limited");
  assert.equal(callCount, 3);
  assert.equal(sleeps.length, 2);
});

test("Spotify client does not wait out an unbounded Retry-After", async () => {
  const sleeps = [];
  let callCount = 0;
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async () => {
      callCount += 1;
      return jsonResponse({ error: { status: 429 } }, 429, {
        "retry-after": "3600",
      });
    },
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  let error;
  try {
    await client.getAccount();
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof SpotifyWebApiError);
  assert.equal(error.code, "spotify_rate_limited");
  assert.equal(error.retryAfterSeconds, 3600);
  assert.equal(callCount, 1);
  assert.equal(sleeps.length, 0);
});

test("Spotify client re-arms the rate limiter for later requests after a 429", async (t) => {
  const clock = mockClock(t);
  const sleeps = [];
  const responses = [
    jsonResponse({ error: { status: 429 } }, 429, { "retry-after": "3600" }),
    jsonResponse({ id: "account-1" }),
  ];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async () => responses.shift(),
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock.advance(milliseconds);
    },
  });

  // The first request fails fast on the unbounded Retry-After, but the
  // re-armed cooldown (bounded at 10s) still paces the next request.
  let error;
  try {
    await client.getAccount();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SpotifyWebApiError);
  assert.equal(error.code, "spotify_rate_limited");

  const account = await client.getAccount();
  assert.equal(account.account_id, "account-1");
  assert.equal(sleeps.length, 1);
  assert.ok(
    sleeps[0] > 9_000 && sleeps[0] <= 10_000,
    `re-armed wait was ${sleeps[0]}ms`,
  );
});

test("Spotify client re-arms the rate limiter after a 429 on a write", async (t) => {
  const clock = mockClock(t);
  const sleeps = [];
  const responses = [
    jsonResponse({ error: { status: 429 } }, 429, { "retry-after": "3" }),
    jsonResponse({ id: "account-1" }),
  ];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async () => responses.shift(),
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock.advance(milliseconds);
    },
  });

  let error;
  try {
    await client.pause({ deviceId: "device" });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SpotifyWebApiError);
  assert.equal(error.code, "spotify_rate_limited");

  const account = await client.getAccount();
  assert.equal(account.account_id, "account-1");
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 2_000 && sleeps[0] <= 3_000, `re-armed wait was ${sleeps[0]}ms`);
});

test("Spotify shared cooldown rechecks an extension before the first dispatch", async (t) => {
  const clock = mockClock(t);
  const writeStarted = Promise.withResolvers();
  const writeResponse = Promise.withResolvers();
  const sleepStarted = Promise.withResolvers();
  const sleepFinished = Promise.withResolvers();
  const requests = [];
  const sleeps = [];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async (url, init) => {
      const device = new URL(url).searchParams.get("device_id");
      requests.push({ device, method: init.method, at: Date.now() });
      if (device === "inflight") {
        writeStarted.resolve();
        return writeResponse.promise;
      }
      if (device === "seed") return jsonResponse({}, 429, { "retry-after": "1" });
      return jsonResponse({ id: "account-1" });
    },
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (sleeps.length === 1) {
        sleepStarted.resolve();
        await sleepFinished.promise;
      } else clock.advance(milliseconds);
    },
  });
  const writeRejected = assert.rejects(client.pause({ deviceId: "inflight" }), { code: "spotify_rate_limited" });
  await writeStarted.promise;
  await assert.rejects(client.pause({ deviceId: "seed" }), { code: "spotify_rate_limited" });
  const account = client.getAccount();
  await sleepStarted.promise;
  clock.advance(500);
  writeResponse.resolve(jsonResponse({}, 429, { "retry-after": "3" }));
  await writeRejected;
  clock.advance(500);
  sleepFinished.resolve();
  assert.equal((await account).account_id, "account-1");

  assert.deepEqual(requests, [
    { device: "inflight", method: "PUT", at: 100_000 },
    { device: "seed", method: "PUT", at: 100_000 },
    { device: null, method: "GET", at: 103_500 },
  ]);
  assert.deepEqual(sleeps, [1_000, 2_500]);
});

test("Spotify shared cooldown paces a 401 retry after another request arms it during refresh", async (t) => {
  const clock = mockClock(t);
  const refreshStarted = Promise.withResolvers();
  const refreshFinished = Promise.withResolvers();
  const requests = [];
  const sleeps = [];
  let accountAttempts = 0;
  let refreshes = 0;
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "old-token",
    refreshAccessToken: async () => {
      refreshes += 1;
      refreshStarted.resolve();
      return refreshFinished.promise;
    },
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      requests.push({ path, token: init.headers.authorization, at: Date.now() });
      if (path === "/v1/me") {
        return ++accountAttempts === 1 ? jsonResponse({}, 401) : jsonResponse({ id: "account-1" });
      }
      return jsonResponse({}, 429, { "retry-after": "3600" });
    },
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock.advance(milliseconds);
    },
  });
  const account = client.getAccount();
  await refreshStarted.promise;
  await assert.rejects(client.getDevices(), { code: "spotify_rate_limited" });
  refreshFinished.resolve("fresh-token");
  assert.equal((await account).account_id, "account-1");

  assert.deepEqual(requests, [
    { path: "/v1/me", token: "Bearer old-token", at: 100_000 },
    { path: "/v1/me/player/devices", token: "Bearer old-token", at: 100_000 },
    { path: "/v1/me", token: "Bearer fresh-token", at: 110_000 },
  ]);
  assert.deepEqual(sleeps, [10_000]);
  assert.equal(refreshes, 1);
});

test("Spotify shared cooldown rechecks after 429 backoff without duplicating the wait or replaying writes", async (t) => {
  const clock = mockClock(t);
  t.mock.method(Math, "random", () => 0.5);
  const writeStarted = Promise.withResolvers();
  const writeResponse = Promise.withResolvers();
  const sleepStarted = Promise.withResolvers();
  const sleepFinished = Promise.withResolvers();
  const requests = [];
  const sleeps = [];
  let accountAttempts = 0;
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async (_url, init) => {
      requests.push({ method: init.method, at: Date.now() });
      if (init.method === "PUT") {
        writeStarted.resolve();
        return writeResponse.promise;
      }
      return ++accountAttempts === 1
        ? jsonResponse({}, 429, { "retry-after": "1" })
        : jsonResponse({ id: "account-1" });
    },
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (sleeps.length === 1) {
        sleepStarted.resolve();
        await sleepFinished.promise;
      } else clock.advance(milliseconds);
    },
  });
  const writeRejected = assert.rejects(client.pause(), { code: "spotify_rate_limited" });
  await writeStarted.promise;
  const account = client.getAccount();
  await sleepStarted.promise;
  clock.advance(500);
  writeResponse.resolve(jsonResponse({}, 429, { "retry-after": "3" }));
  await writeRejected;
  clock.advance(625);
  sleepFinished.resolve();
  assert.equal((await account).account_id, "account-1");

  assert.deepEqual(requests, [
    { method: "PUT", at: 100_000 },
    { method: "GET", at: 100_000 },
    { method: "GET", at: 103_500 },
  ]);
  assert.deepEqual(sleeps, [1_125, 2_375]);
});

test("Spotify shared cooldown cancellation prevents read and write dispatch", async (t) => {
  for (const action of ["read", "write"]) await t.test(action, async (context) => {
    mockClock(context);
    const controller = new AbortController();
    const sleepStarted = Promise.withResolvers();
    let calls = 0;
    let guardCalls = 0;
    const client = createSpotifyWebApiClient({
      tokenProvider: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({}, 429, { "retry-after": "2" });
      },
      sleepImpl: async (milliseconds, { signal }) => {
        assert.equal(milliseconds, 2_000);
        assert.equal(signal, controller.signal);
        signal.throwIfAborted();
        const aborted = new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        sleepStarted.resolve();
        return aborted;
      },
    });
    await assert.rejects(client.pause(), { code: "spotify_rate_limited" });
    const pending = action === "read"
      ? client.getAccount({ signal: controller.signal })
      : client.resume({}, { signal: controller.signal, beforeDispatch: () => { guardCalls += 1; } });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await sleepStarted.promise;
    controller.abort();
    await rejected;
    assert.equal(Date.now(), 100_000);
    assert.equal(calls, 1);
    assert.equal(guardCalls, 0);
  });
});

test("Spotify client fails loudly when playlist items advertise a total but return none", async () => {
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async () =>
      jsonResponse({ items: [], total: 12, limit: 50, offset: 0, next: null }),
  });

  let error;
  try {
    await client.getPlaylistItems({ playlistId: "playlist-1", limit: 50, offset: 0 });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof SpotifyWebApiError);
  assert.equal(error.code, "spotify_playlist_items_mismatch");
  assert.match(error.message, /12/);
});

test("Spotify client still reads a genuinely empty playlist", async () => {
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async () =>
      jsonResponse({ items: [], total: 0, limit: 50, offset: 0, next: null }),
  });

  const page = await client.getPlaylistItems({ playlistId: "playlist-1", limit: 50, offset: 0 });

  assert.deepEqual(page.items, []);
  assert.equal(page.total, 0);
  assert.equal(page.has_more, false);
});

test("Spotify client reports silent 403 refusals as retired endpoints", async (t) => {
  for (const fixture of [
    {
      name: "empty error body",
      response: jsonResponse({}, 403),
      code: "spotify_endpoint_retired",
    },
    {
      name: "plain text body",
      response: new Response("Forbidden", { status: 403 }),
      code: "spotify_endpoint_retired",
    },
    {
      name: "explained refusal",
      response: jsonResponse({ error: { message: "Restricted content" } }, 403),
      code: "spotify_action_forbidden",
    },
  ]) {
    await t.test(fixture.name, async () => {
      const client = createSpotifyWebApiClient({
        tokenProvider: async () => "token",
        fetchImpl: async () => fixture.response,
      });
      let error;
      try {
        await client.getAccount();
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof SpotifyWebApiError);
      assert.equal(error.code, fixture.code);
      assert.equal(error.status, 403);
    });
  }
});

test("Spotify client never retries exhausted development quota, even on GETs", async () => {
  let callCount = 0;
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async () => {
      callCount += 1;
      return jsonResponse(
        { error: { status: 429, reason: "QUOTA_EXCEEDED" } },
        429,
        { "retry-after": "1" },
      );
    },
    sleepImpl: async () => {
      throw new Error("must not sleep before failing fast on quota");
    },
  });

  let error;
  try {
    await client.getAccount();
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof SpotifyWebApiError);
  assert.equal(error.code, "spotify_quota_exceeded");
  assert.equal(callCount, 1);
});

test("Spotify client refreshes the token reactively on 401 and retries once", async () => {
  const seenTokens = [];
  let refreshCount = 0;
  const responses = [
    jsonResponse({ error: { status: 401, message: "Bad or expired token" } }, 401),
    jsonResponse({ id: "account-1", display_name: "Listener" }),
  ];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "stale-token",
    refreshAccessToken: async () => {
      refreshCount += 1;
      return "fresh-token";
    },
    fetchImpl: async (url, init) => {
      seenTokens.push(init.headers.authorization);
      return responses.shift();
    },
  });

  const account = await client.getAccount();

  assert.equal(account.account_id, "account-1");
  assert.deepEqual(seenTokens, ["Bearer stale-token", "Bearer fresh-token"]);
  assert.equal(refreshCount, 1);
});

test("Spotify client retries a 401 only once after refreshing", async () => {
  let fetchCount = 0;
  let refreshCount = 0;
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "stale-token",
    refreshAccessToken: async () => {
      refreshCount += 1;
      return "fresh-token";
    },
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({ error: { status: 401 } }, 401);
    },
  });

  let error;
  try {
    await client.getAccount();
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof SpotifyWebApiError);
  assert.equal(error.code, "spotify_authentication_required");
  assert.equal(fetchCount, 2);
  assert.equal(refreshCount, 1);
});

test("Spotify client fails fast on 401 without a refresh hook", async () => {
  let fetchCount = 0;
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "stale-token",
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({ error: { status: 401 } }, 401);
    },
  });

  let error;
  try {
    await client.getAccount();
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof SpotifyWebApiError);
  assert.equal(error.code, "spotify_authentication_required");
  assert.equal(fetchCount, 1);
});

test("Spotify client surfaces refresh failures after a 401", async () => {
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "stale-token",
    refreshAccessToken: async () => {
      throw new SpotifyWebApiError(
        "spotify_auth_not_configured",
        "Spotify is not authenticated.",
      );
    },
    fetchImpl: async () => jsonResponse({ error: { status: 401 } }, 401),
  });

  let error;
  try {
    await client.getAccount();
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof SpotifyWebApiError);
  assert.equal(error.code, "spotify_auth_not_configured");
});

test("Spotify client returns bounded normalized catalog search results", async () => {
  const requests = [];
  const items = Array.from({ length: 12 }, (_, index) => ({
    uri: `spotify:track:search${index}`,
    id: `search${index}`,
    name: `Track ${index}`,
    artists: [{ name: "Artist" }],
    album: {
      name: "Album",
      images: [{ url: "PRIVATE_IMAGE_SENTINEL" }],
      available_markets: ["PRIVATE_MARKET_SENTINEL"],
    },
    duration_ms: 200_000,
    popularity: 50,
    explicit: false,
    is_local: false,
    external_urls: { spotify: "PRIVATE_TRACK_URL_SENTINEL" },
  }));
  items[0] = { uri: "spotify:track:no-name", id: "x" };
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ tracks: { items, total: 12 } });
    },
  });

  const result = await client.searchTracks({
    query: 'track:"Night" artist:"Mara"',
    limit: 10,
    market: "from_token",
  });

  assert.equal(result.provider, "spotify");
  assert.equal(result.items.length, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.items[0].uri, "spotify:track:search1");
  assert.deepEqual(result.items[0].artists, ["Artist"]);
  assert.equal(result.items[0].popularity, 50);
  assert.equal(
    requests[0].url,
    'https://api.spotify.com/v1/search?q=track%3A%22Night%22+artist%3A%22Mara%22&type=track&limit=10&market=from_token',
  );
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(result).includes("is_local"), false);
});

test("Spotify client creates private playlists and adds tracks with receipts", async () => {
  const requests = [];
  const responses = [
    jsonResponse({
      id: "playlist-1",
      uri: "spotify:playlist:playlist-1",
      name: "Night Drive",
      public: false,
      items: { href: "PRIVATE_HREF_SENTINEL", total: 0 },
      external_urls: { spotify: "PRIVATE_PLAYLIST_URL_SENTINEL" },
      owner: { id: "PRIVATE_OWNER_SENTINEL" },
    }),
    jsonResponse({ snapshot_id: "snapshot-1" }),
  ];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    },
  });

  const playlist = await client.createPlaylist({
    name: "Night Drive",
    description: "Moondog curated",
  });
  const added = await client.addPlaylistTracks({
    playlistId: "playlist-1",
    uris: ["spotify:track:a", "spotify:track:b"],
  });

  assert.deepEqual(playlist, {
    id: "playlist-1",
    uri: "spotify:playlist:playlist-1",
    name: "Night Drive",
    is_public: false,
    tracks_total: 0,
  });
  assert.deepEqual(added, { snapshot_id: "snapshot-1" });
  assert.equal(requests[0].url, "https://api.spotify.com/v1/me/playlists");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    name: "Night Drive",
    description: "Moondog curated",
    public: false,
  });
  assert.equal(
    requests[1].url,
    "https://api.spotify.com/v1/playlists/playlist-1/items",
  );
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    uris: ["spotify:track:a", "spotify:track:b"],
  });
  assert.equal(JSON.stringify(playlist).includes("PRIVATE_"), false);
});

test("Spotify client reads playlist metadata and items through current item endpoints", async () => {
  const requests = [];
  const responses = [
    jsonResponse({
      items: [
        {
          id: "playlist-1",
          uri: "spotify:playlist:playlist-1",
          name: "Night Drive",
          public: false,
          collaborative: false,
          owner: { id: "user-1", display_name: "PRIVATE_OWNER_SENTINEL" },
          snapshot_id: "snapshot-1",
          items: { total: 2, href: "PRIVATE_HREF_SENTINEL" },
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
      next: null,
      href: "PRIVATE_PAGE_SENTINEL",
    }),
    jsonResponse({
      id: "playlist-1",
      uri: "spotify:playlist:playlist-1",
      name: "Night Drive",
      public: false,
      collaborative: false,
      owner: { id: "user-1" },
      snapshot_id: "snapshot-1",
      items: { total: 2 },
      description: "PRIVATE_DESCRIPTION_SENTINEL",
    }),
    jsonResponse({
      items: [
        {
          added_at: "2026-09-03T00:00:00Z",
          added_by: { id: "PRIVATE_ADDER_SENTINEL" },
          is_local: false,
          item: {
            type: "track",
            uri: "spotify:track:a",
            name: "Midnight Lines",
            artists: [{ name: "Mara Vale" }],
            album: { name: "Night Transit" },
            duration_ms: 278_000,
            external_urls: { spotify: "PRIVATE_TRACK_URL_SENTINEL" },
          },
        },
        {
          is_local: true,
          item: {
            type: "track",
            uri: "spotify:local:artist:album:title:100",
            name: "Local Track",
            artists: [{ name: "Local Artist" }],
            album: { name: "Local Album" },
          },
        },
      ],
      total: 2,
      limit: 50,
      offset: 0,
      next: null,
      href: "PRIVATE_ITEMS_PAGE_SENTINEL",
    }),
  ];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    },
  });

  const page = await client.getCurrentUserPlaylists({ limit: 20, offset: 0 });
  const playlist = await client.getPlaylist({ playlistId: "playlist-1" });
  const items = await client.getPlaylistItems({
    playlistId: "playlist-1",
    limit: 50,
    offset: 0,
  });

  assert.deepEqual(page, {
    provider: "spotify",
    items: [
      {
        id: "playlist-1",
        uri: "spotify:playlist:playlist-1",
        name: "Night Drive",
        is_public: false,
        collaborative: false,
        owner_id: "user-1",
        snapshot_id: "snapshot-1",
        tracks_total: 2,
      },
    ],
    total: 1,
    limit: 20,
    offset: 0,
    has_more: false,
    complete_for_name_selection: true,
  });
  assert.equal(playlist.snapshot_id, "snapshot-1");
  assert.deepEqual(items.items[0], {
    is_local: false,
    item: {
      type: "track",
      uri: "spotify:track:a",
      name: "Midnight Lines",
      artists: ["Mara Vale"],
      album: "Night Transit",
      duration_ms: 278_000,
    },
  });
  assert.equal(items.items[1].is_local, true);
  assert.equal(items.total, 2);
  assert.equal(items.has_more, false);
  assert.deepEqual(
    requests.map(({ url, init }) => [new URL(url).pathname, init.method]),
    [
      ["/v1/me/playlists", "GET"],
      ["/v1/playlists/playlist-1", "GET"],
      ["/v1/playlists/playlist-1/items", "GET"],
    ],
  );
  assert.equal(JSON.stringify({ page, playlist, items }).includes("PRIVATE_"), false);
});

test("Spotify client replaces an exact playlist item sequence once", async () => {
  const requests = [];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ snapshot_id: "snapshot-after" });
    },
  });

  const result = await client.replacePlaylistItems({
    playlistId: "playlist one",
    uris: ["spotify:track:b", "spotify:track:a"],
  });

  assert.deepEqual(result, { snapshot_id: "snapshot-after" });
  assert.equal(
    requests[0].url,
    "https://api.spotify.com/v1/playlists/playlist%20one/items",
  );
  assert.equal(requests[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    uris: ["spotify:track:b", "spotify:track:a"],
  });
  assert.equal(requests.length, 1);
});

test("Spotify client checks and saves library tracks", async () => {
  const requests = [];
  const responses = [jsonResponse([true, false]), noContentResponse()];
  const client = createSpotifyWebApiClient({
    tokenProvider: async () => "token",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responses.shift();
    },
  });

  const uris = ["spotify:track:a", "spotify:track:b"];
  const saved = await client.checkSavedTracks({ uris });
  await client.saveTracks({ uris });

  assert.deepEqual(saved, [true, false]);
  assert.equal(
    requests[0].url,
    "https://api.spotify.com/v1/me/library/contains?uris=spotify%3Atrack%3Aa%2Cspotify%3Atrack%3Ab",
  );
  assert.equal(
    requests[1].url,
    "https://api.spotify.com/v1/me/library?uris=spotify%3Atrack%3Aa%2Cspotify%3Atrack%3Ab",
  );
  assert.equal(requests[1].init.method, "PUT");
});

test("rate limits and authentication share three total GET attempts, including non-JSON errors", async (t) => {
  const clock = mockClock(t);
  const responses = [new Response("busy", { status: 429, headers: { "retry-after": "0" } }),
    new Response("expired", { status: 401 }), new Response("busy again", { status: 429 })];
  let calls = 0;
  let refreshes = 0;
  const client = createSpotifyWebApiClient({ tokenProvider: async () => "old-token",
    refreshAccessToken: async ({ rejectedAccessToken }) => {
      assert.equal(rejectedAccessToken, "old-token"); refreshes++; return "new-token";
    },
    fetchImpl: async () => { calls++; return responses.shift(); }, sleepImpl: async (milliseconds) => { clock.advance(milliseconds); } });
  await assert.rejects(client.getQueue(), { code: "spotify_rate_limited" });
  assert.equal(calls, 3);
  assert.equal(refreshes, 1);
});

test("cancelling a real rate-limit backoff stops promptly without another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createSpotifyWebApiClient({
    tokenProvider: async ({ signal }) => { assert.equal(signal, controller.signal); return "token"; },
    fetchImpl: async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      calls++;
      setImmediate(() => controller.abort());
      return new Response("busy", { status: 429, headers: { "retry-after": "10" } });
    },
  });
  await assert.rejects(client.getQueue({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("a dispatched accepted write keeps its receipt after cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createSpotifyWebApiClient({ tokenProvider: async () => "old-token",
    refreshAccessToken: async ({ signal }) => { assert.equal(signal, controller.signal); return "new-token"; },
    fetchImpl: async (_url, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      assert.notEqual(init.signal, controller.signal);
      calls++;
      controller.abort();
      return noContentResponse();
    },
  });
  await client.addToQueue({ uri: "spotify:track:fictional" }, { signal: controller.signal });
  assert.equal(calls, 1);
});

test("every write refreshes a rejected token without automatically replaying the action", async (context) => {
  const actions = [
    ["resume", {}], ["pause", {}], ["next", {}], ["previous", {}], ["setVolume", { percent: 50 }],
    ["seek", { positionMs: 1 }], ["setShuffle", { state: true }], ["setRepeat", { state: "off" }],
    ["transfer", { deviceId: "fictionaldevice", play: true }], ["addToQueue", { uri: "spotify:track:fictional" }],
    ["createPlaylist", { name: "Fictional Playlist" }],
    ["addPlaylistTracks", { playlistId: "fictionalplaylist", uris: ["spotify:track:fictional"] }],
    ["replacePlaylistItems", { playlistId: "fictionalplaylist", uris: ["spotify:track:fictional"] }],
    ["saveTracks", { uris: ["spotify:track:fictional"] }],
  ];
  for (const [action, input] of actions) await context.test(action, async () => {
    let requests = 0;
    let refreshes = 0;
    const client = createSpotifyWebApiClient({ tokenProvider: async () => "fictional-old",
      refreshAccessToken: async () => { refreshes++; return "fictional-new"; },
      fetchImpl: async () => { requests++; return new Response("expired", { status: 401 }); } });
    await assert.rejects(client[action](input), { code: "spotify_action_not_replayed", outcomeUnknown: false, status: 401 });
    assert.equal(requests, 1);
    assert.equal(refreshes, 1);
  });
});

test("a later explicit write uses the refreshed credential after an unreplayed rejection", async () => {
  let token = "fictional-old";
  const tokens = [];
  const client = createSpotifyWebApiClient({ tokenProvider: async () => token,
    refreshAccessToken: async () => { token = "fictional-new"; return token; },
    fetchImpl: async (_url, init) => {
      tokens.push(init.headers.authorization);
      return tokens.length === 1 ? new Response("expired", { status: 401 }) : noContentResponse();
    } });
  await assert.rejects(client.next(), { code: "spotify_action_not_replayed" });
  assert.deepEqual(tokens, ["Bearer fictional-old"]);
  await client.next();
  assert.deepEqual(tokens, ["Bearer fictional-old", "Bearer fictional-new"]);
});

for (const action of ["addToQueue", "resume"]) {
  test(`Spotify ${action} never dispatches after cancellation during token lookup`, async () => {
    const controller = new AbortController();
    let requests = 0;
    const client = createSpotifyWebApiClient({
      tokenProvider: async () => {
        controller.abort();
        return "synthetic-access-token";
      },
      fetchImpl: async () => { requests += 1; return noContentResponse(); },
    });
    await assert.rejects(
      client[action]({ uri: "spotify:track:synthetic", uris: ["spotify:track:synthetic"] }, { signal: controller.signal }),
      { name: "AbortError" },
    );
    assert.equal(requests, 0);
  });
}

test("every write wrapper cancels token lookup before dispatch", async (context) => {
  const actions = [
    ["pause", {}], ["next", {}], ["previous", {}], ["setVolume", { percent: 50 }],
    ["seek", { positionMs: 1 }], ["setShuffle", { state: true }], ["setRepeat", { state: "off" }],
    ["transfer", { deviceId: "fictionaldevice", play: true }],
    ["createPlaylist", { name: "Fictional Playlist" }],
    ["addPlaylistTracks", { playlistId: "fictionalplaylist", uris: ["spotify:track:fictional"] }],
    ["replacePlaylistItems", { playlistId: "fictionalplaylist", uris: ["spotify:track:fictional"] }],
    ["saveTracks", { uris: ["spotify:track:fictional"] }],
  ];
  for (const [action, input] of actions) {
    await context.test(action, async () => {
      const controller = new AbortController();
      let calls = 0;
      const client = createSpotifyWebApiClient({ tokenProvider: async ({ signal }) => {
        assert.equal(signal, controller.signal);
        controller.abort();
        return "fictional-token";
      }, fetchImpl: async () => { calls++; return noContentResponse(); } });
      await assert.rejects(client[action](input, { signal: controller.signal }), { name: "AbortError" });
      assert.equal(calls, 0);
    });
  }
});

test("dispatched write transport and response failures retain unknown-effect provenance without replay", async (context) => {
  for (const failure of ["transport_abort", "body_abort", "malformed_success", "server_failure"]) {
    await context.test(failure, async () => {
      let requests = 0;
      let refreshes = 0;
      const client = createSpotifyWebApiClient({ tokenProvider: async () => "fictional-token",
        refreshAccessToken: async () => { refreshes++; return "fictional-replacement"; },
        fetchImpl: async () => {
          requests++;
          if (failure === "transport_abort") throw new DOMException("Fictional transport abort", "AbortError");
          if (failure === "body_abort") return { ok: true, status: 201, async text() { throw new DOMException("Fictional body abort", "AbortError"); } };
          return new Response(failure === "malformed_success" ? "incomplete json" : "unavailable", { status: failure === "malformed_success" ? 201 : 503 });
        },
      });
      await assert.rejects(client.createPlaylist({ name: "Fictional Playlist" }), (error) => {
        assert.equal(error.outcomeUnknown, true);
        assert.notEqual(error.name, "AbortError");
        return true;
      });
      assert.equal(requests, 1);
      assert.equal(refreshes, 0);
    });
  }
});
