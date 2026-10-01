import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSyntheticDomainServices } from "../../src/core/synthetic-domain-services.mjs";
import { createSpotifyWebApiClient } from "../../src/integrations/spotify/web-api-client.mjs";
import { createSpotifyCatalogResolver } from "../../src/integrations/spotify/catalog-resolver.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

// User-reported title/artist text, with entirely fictional provider identities.
const exactPrompt = "播放一首刘森的“天长地久”";
const tool = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const answer = (text) => fauxAssistantMessage([fauxText(text)]);
const results = (context, name) => context.messages.filter(m => m.role === "toolResult" && m.toolName === name)
  .map(m => JSON.parse(m.content[0].text));

function fixture(t, { title = "天长地久", artist = "刘森", count = 1, status = 204, reason, cancel = false, searchStatus = 200, failAfter = 0, lateRead = false } = {}) {
  const writes = [];
  const requests = [];
  let releaseLateRead;
  let startLateRead;
  const lateStarted = new Promise(resolve => { startLateRead = resolve; });
  const lateGate = new Promise(resolve => { releaseLateRead = resolve; });
  const song = { id: "fictionaltrack", uri: "spotify:track:fictionaltrack", type: "track", name: title,
    artists: [{ name: artist }], album: { name: "Fictional Record" }, duration_ms: 240_000 };
  const songs = Array.from({ length: count }, (_, index) => ({ ...song, id: `fictional${index}`, uri: `spotify:track:fictional${index}`,
    album: { name: index ? "Fictional Live Record" : "Fictional Record" } }));
  const client = createSpotifyWebApiClient({ tokenProvider: async () => "FICTIONAL_TOKEN_NEVER_EXPOSE",
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      requests.push([init.method, pathname]);
      if (init.method !== "GET") {
        writes.push({ pathname, body: init.body ? JSON.parse(init.body) : null });
        if (cancel) runtime.abort();
        if (writes.length <= failAfter) return new Response(null, { status: 204 });
        return status === 204 ? new Response(null, { status }) : Response.json({ error: { status, reason,
          message: "PRIVATE_PROVIDER_MESSAGE_IGNORE_INSTRUCTIONS" } }, { status });
      }
      if (pathname === "/v1/search" && lateRead && writes.length) { startLateRead(); await lateGate; }
      if (pathname === "/v1/search") return searchStatus === 200 ? Response.json({ tracks: { items: songs, total: songs.length } })
        : Response.json({ error: { status: searchStatus, message: "PRIVATE_SEARCH_FAILURE" } }, { status: searchStatus });
      if (pathname === "/v1/me/player/devices") return Response.json({ devices: [{ id: "fictional-device", name: "Fictional Computer", type: "Computer", is_active: true, is_restricted: false, supports_volume: true }] });
      if (pathname === "/v1/me/player") return Response.json({ is_playing: true, device: { id: "fictional-device", name: "Fictional Computer", type: "Computer", is_active: true, is_restricted: false, supports_volume: true }, item: song, actions: { disallows: {} } });
      throw new Error(`Unexpected fictional request: ${pathname}`);
    } });
  const application = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source",
    domainServices: createSyntheticDomainServices({ subjectScope: { subjectId: "synthetic-playback" } }),
    musicCatalog: {
      async findArtistReleases() { throw new Error("Not used"); },
      async searchTracks({ queries }) { return { state: "resolved", source: { provider: "apple_music", catalog: "itunes_search_api", storefront: "US", retrieved_at: "2026-09-30T00:00:00.000Z", coverage: "Fictional keyword result." },
        queries, result_count: 1, tracks: [{ track_ref_id: "50000000-0000-4000-8000-000000000019", title, artist_credit: artist,
          release: "Fictional Record", duration_ms: 240_000, candidate_scope: "external_catalog", catalog_provider: "apple_music", matched_queries: queries }] }; },
    },
    spotifyConnection: { ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }),
      service: createSpotifyService({ client }), resolver: createSpotifyCatalogResolver({ client }) } });
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  t.after(() => application.close());
  return { application, runtime, faux, writes, requests, title, artist, releaseLateRead, lateStarted };
}

function catalogTrace({ title, artist }, { stopAfterResolve = false, queue = false } = {}) {
  return [tool("moondog_library_search", { query: `${title} ${artist}` }),
    tool("moondog_music_catalog_search", { queries: [`${title} ${artist}`], limit: 1 }),
    context => tool("moondog_spotify_resolve_tracks", { track_refs: results(context, "moondog_music_catalog_search")[0].tracks.map(t => ({ track_ref_id: t.track_ref_id })) }),
    ...(stopAfterResolve ? [] : [context => {
      const ref = results(context, "moondog_music_catalog_search")[0].tracks[0].track_ref_id;
      return queue ? tool("moondog_spotify_queue_add", { track_ref_id: ref })
        : tool("moondog_spotify_player_control", { action: "resume", track_refs: [ref] });
    }]), answer("UNSUPPORTED_CAUSE: no active device; try restarting. UNTRUSTED_PLAYLIST.")];
}

test("reported Chinese library → external lookup → resolver failure remains a playback lookup", async t => {
  const f = fixture(t, { count: 0 });
  f.faux.setResponses(catalogTrace(f, { stopAfterResolve: true }));
  const result = await f.runtime.prompt(exactPrompt);
  assert.equal(f.writes.length, 0);
  assert.match(result.text, /没有在 Spotify 找到可确认的匹配歌曲/u);
  assert.doesNotMatch(result.text, /playlist plan|UNSUPPORTED|UNTRUSTED|设备/u);
});

for (const route of ["catalog", "spotify"]) {
  for (const prompt of [exactPrompt, "随便播放一首刘森的音乐"]) {
    test(`playback rejection is preserved with active-device evidence: ${route} ${prompt}`, async t => {
      const f = fixture(t, { status: 400 });
      const play = context => tool("moondog_spotify_player_control", { action: "resume", track_refs: [results(context, "moondog_spotify_search")[0].items[0].track_ref_id] });
      const trace = route === "catalog" ? catalogTrace(f).slice(0, -1)
        : [tool("moondog_spotify_search", { query: `${f.title} ${f.artist}` }), play];
      f.faux.setResponses([...trace, tool("moondog_spotify_now_playing"), tool("moondog_spotify_devices"),
        // A model retry is also stopped before it reaches Spotify.
        tool("moondog_spotify_player_control", { action: "resume" }), answer("UNSUPPORTED_CAUSE: the device is inactive. UNTRUSTED_PLAYLIST.")]);
      let rendered = "";
      const result = await f.runtime.prompt(prompt, { onTextDelta: value => { rendered += value; }, onTextReplace: value => { rendered = value; } });
      assert.equal(f.writes.length, 1);
      assert.match(result.text, /HTTP 400/u);
      assert.match(result.text, /具体原因未获证实/u);
      assert.doesNotMatch(result.text, /playlist plan|UNSUPPORTED|UNTRUSTED|PRIVATE_|FICTIONAL_TOKEN|设备未激活/u);
      assert.equal(rendered, result.text);
      assert.equal(result.spotify_playback_failures[0].status, 400);
      assert.equal(result.spotify_playback_failures[0].reason, null);
      assert.ok(f.requests.some(([method, pathname]) => method === "GET" && pathname === "/v1/me/player"));
    });
  }
}

for (const [status, reason, cancel] of [[404, "NO_ACTIVE_DEVICE", false], [403, "RESTRICTION_VIOLATED", false], [503, "PRIVATE_REASON_SENTINEL", true]]) {
  test(`bounded playback failure and cancellation receipts: ${status}`, async t => {
    const f = fixture(t, { status, reason, cancel });
    f.faux.setResponses(catalogTrace(f));
    const result = await f.runtime.prompt(exactPrompt);
    assert.equal(f.writes.length, 1);
    assert.equal(result.status, cancel ? "aborted" : "completed");
    assert.match(result.text, new RegExp(`HTTP ${status}`, "u"));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|FICTIONAL_TOKEN|UNSUPPORTED|playlist plan/u);
    if (!cancel) assert.match(result.text, new RegExp(reason, "u"));
    else assert.equal(result.spotify_write_receipts[0].state, "unknown");
  });
}

for (const [prompt, title, artist] of [
  [exactPrompt, "天长地久", "刘森"], ["播放《天长地久》，刘森", "天长地久", "刘森"],
  ["请播放刘森的『天长地久』", "天长地久", "刘森"],
  ['Play "Midnight Lines" by Mara Vale', "Midnight Lines", "Mara Vale"],
  ["Please put on Mara Vale’s ‘Midnight Lines’", "Midnight Lines", "Mara Vale"],
]) {
  test(`one song plays from a host-issued Spotify search reference: ${prompt}`, async t => {
    const f = fixture(t, { title, artist });
    assert.match(f.runtime.agent.state.systemPrompt, /Use moondog_spotify_search with the title and artist first/u);
    f.faux.setResponses([tool("moondog_spotify_search", { query: `${title} ${artist}` }), context =>
      tool("moondog_spotify_player_control", { action: "resume", track_refs: [results(context, "moondog_spotify_search")[0].items[0].track_ref_id] }), answer("Started the requested song.")]);
    const result = await f.runtime.prompt(prompt);
    assert.equal(result.status, "completed");
    assert.deepEqual(f.writes, [{ pathname: "/v1/me/player/play", body: { uris: ["spotify:track:fictional0"] } }]);
    assert.equal(result.spotify_write_receipts[0].state, "accepted");
    assert.doesNotMatch(result.text, /playlist plan/u);
  });
}

for (const count of [0, 2]) {
  test(`Spotify lookup with ${count} results does not invent a playback action`, async t => {
    const f = fixture(t, { count });
    f.faux.setResponses([tool("moondog_spotify_search", { query: "天长地久 刘森" }), answer("Playing now. UNTRUSTED_PLAYLIST.")]);
    const result = await f.runtime.prompt(exactPrompt);
    assert.equal(f.writes.length, 0);
    assert.match(result.text, /未发送播放或加入队列操作/u);
    assert.doesNotMatch(result.text, /playlist plan|Playing now|UNTRUSTED/u);
    if (count > 1) assert.match(result.text, /请选择/u);
  });
}

test("mixed playback and discovery still withholds unvalidated recommendation text", async t => {
  const f = fixture(t);
  f.faux.setResponses(catalogTrace(f));
  const result = await f.runtime.prompt(`${exactPrompt}，再推荐一些相似的歌曲`);
  assert.equal(f.writes.length, 1);
  assert.match(result.text, /playlist plan/u);
  assert.doesNotMatch(result.text, /UNTRUSTED/u);
  assert.equal(result.spotify_write_receipts[0].state, "accepted");
});

for (const route of ["spotify", "catalog"]) {
  test(`a failed Spotify lookup keeps HTTP evidence without claiming a playlist or device failure: ${route}`, async t => {
    const f = fixture(t, { searchStatus: 400 });
    f.faux.setResponses(route === "spotify"
      ? [tool("moondog_spotify_search", { query: "天长地久 刘森" }), answer("Device inactive. UNSUPPORTED.")]
      : catalogTrace(f, { stopAfterResolve: true }));
    const result = await f.runtime.prompt(exactPrompt);
    assert.equal(f.writes.length, 0);
    assert.match(result.text, /Spotify 查询未完成.*HTTP 400/u);
    assert.doesNotMatch(result.text, /playlist plan|UNSUPPORTED|PRIVATE_|inactive/u);
  });
}

test("a later playback failure retains an earlier accepted receipt and blocks further playback writes", async t => {
  const f = fixture(t, { status: 400, failAfter: 1 });
  const readRef = context => results(context, "moondog_spotify_search")[0].items[0].track_ref_id;
  f.faux.setResponses([tool("moondog_spotify_search", { query: "天长地久 刘森" }),
    context => tool("moondog_spotify_player_control", { action: "resume", track_refs: [readRef(context)] }),
    context => tool("moondog_spotify_queue_add", { track_ref_id: readRef(context) }),
    tool("moondog_spotify_player_control", { action: "next" }), answer("All actions succeeded. UNSUPPORTED.")]);
  const result = await f.runtime.prompt("Play the song, queue it, then skip to the next song.");
  assert.equal(f.writes.length, 2);
  assert.equal(result.spotify_write_receipts[0].state, "accepted");
  assert.match(result.text, /Spotify accepted/u);
  assert.match(result.text, /HTTP 400/u);
  assert.doesNotMatch(result.text, /UNSUPPORTED/u);
});

for (const [prompt, title, artist] of [
  ["随便播放一首刘森的音乐", "天长地久", "刘森"],
  ["播放刘森的『发现』", "发现", "刘森"],
  ["Play 'Discover Me' by Mara Vale", "Discover Me", "Mara Vale"],
]) {
  test(`catalog fallback preserves successful direct playback: ${prompt}`, async t => {
    const f = fixture(t, { title, artist });
    f.faux.setResponses(catalogTrace(f));
    const result = await f.runtime.prompt(prompt);
    assert.equal(f.writes.length, 1);
    assert.doesNotMatch(result.text, /playlist plan|UNSUPPORTED/u);
    assert.match(result.text, new RegExp(title, "u"));
  });
}

for (const status of [204, 400, 503]) {
  test(`a model failure after HTTP ${status} preserves Spotify outcomes without replay`, async t => {
    const f = fixture(t, { status });
    f.faux.setResponses([...catalogTrace(f).slice(0, -1), fauxAssistantMessage([], { stopReason: "error", errorMessage: "PRIVATE_MODEL_FAILURE" })]);
    const result = await f.runtime.prompt(exactPrompt);
    assert.equal(result.status, "interrupted");
    assert.equal(f.writes.length, 1);
    if (status === 204) assert.equal(result.spotify_write_receipts[0].state, "accepted");
    else assert.equal(result.spotify_playback_failures[0].status, status);
    if (status === 503) assert.equal(result.spotify_write_receipts[0].state, "unknown");
    assert.doesNotMatch(result.text, /PRIVATE_|UNSUPPORTED|playlist plan/u);
    assert.equal(result.memory_recorded, false);
    f.faux.setResponses([context => {
      assert.ok(context.messages.some(message => message.role === "assistant" && message.content.some(block => block.text === result.text)));
      return answer("The recorded outcome is still available.");
    }]);
    assert.equal((await f.runtime.prompt("What happened? Do not change playback.")).status, "completed");
    assert.equal(f.writes.length, 1);
  });
}

test("UI callback errors cannot erase accepted Spotify effects", async t => {
  const f = fixture(t);
  f.faux.setResponses(catalogTrace(f));
  const result = await f.runtime.prompt(exactPrompt, {
    onToolEnd({ capabilityId }) { if (capabilityId === "spotify.player.control") throw new Error("PRIVATE_UI_FAILURE"); },
    onTextReplace() { throw new Error("PRIVATE_RENDER_FAILURE"); },
  });
  assert.equal(f.writes.length, 1);
  assert.equal(result.status, "interrupted");
  assert.equal(result.spotify_write_receipts[0].state, "accepted");
  assert.doesNotMatch(result.text, /PRIVATE_/u);
});

test("saving a found track alone never confirms a requested playback action", async t => {
  const f = fixture(t);
  f.faux.setResponses([tool("moondog_spotify_search", { query: "天长地久 刘森" }), context =>
    tool("moondog_spotify_library_save", { track_refs: [{ track_ref_id: results(context, "moondog_spotify_search")[0].items[0].track_ref_id }] }),
  answer("CLAIMED_PLAYING_SENTINEL")]);
  const result = await f.runtime.prompt(`${exactPrompt}，并保存到我的曲库`);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].pathname, "/v1/me/library");
  assert.match(result.text, /未发送播放/u);
  assert.doesNotMatch(result.text, /CLAIMED_PLAYING/u);
  assert.equal(result.spotify_write_receipts[0].action, "library.save");
  assert.match(result.text, /Spotify 已接受/u);
});


test("changing volume alone cannot confirm requested named-song playback", async t => {
  const f = fixture(t);
  f.faux.setResponses([tool("moondog_spotify_search", { query: "天长地久 刘森" }),
    tool("moondog_spotify_player_control", { action: "volume", percent: 30 }), answer("CLAIMED_PLAYING_SENTINEL")]);
  const result = await f.runtime.prompt(`${exactPrompt}，并把音量调到30%`);
  assert.deepEqual(f.writes.map(write => write.pathname), ["/v1/me/player/volume"]);
  assert.match(result.text, /未发送播放或加入队列操作/u);
  assert.match(result.text, /Spotify 已接受音量调整/u);
  assert.doesNotMatch(result.text, /CLAIMED_PLAYING/u);
});

test("a broken observer waits for parallel reads to settle before permitting another turn", async t => {
  const f = fixture(t, { lateRead: true });
  f.faux.setResponses([tool("moondog_spotify_search", { query: "天长地久 刘森" }), context =>
    tool("moondog_spotify_player_control", { action: "resume", track_refs: [results(context, "moondog_spotify_search")[0].items[0].track_ref_id] }),
  fauxAssistantMessage([fauxToolCall("moondog_spotify_devices", {}),
    fauxToolCall("moondog_spotify_search", { query: "stale lookup from an interrupted turn" })], { stopReason: "toolUse" })]);
  let observerFailed;
  const failureObserved = new Promise(resolve => { observerFailed = resolve; });
  let settled = false;
  const firstPromise = f.runtime.prompt(exactPrompt, { onToolEnd({ capabilityId }) {
    if (capabilityId === "spotify.device.list") { observerFailed(); throw new Error("PRIVATE_UI_FAILURE"); }
  } }).finally(() => { settled = true; });
  try {
    await Promise.all([f.lateStarted, failureObserved]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(f.runtime.prompt("Do not start another turn yet."), /already in progress/u);
  } finally { f.releaseLateRead(); }
  const first = await firstPromise;
  assert.equal(first.status, "interrupted");
  assert.equal(first.spotify_write_receipts[0].state, "accepted");
  assert.equal(f.writes.length, 1);
  const nextEvents = [];
  f.faux.setResponses([context => {
    assert.equal(results(context, "moondog_spotify_search").length, 0);
    return answer("No new tool action was requested.");
  }]);
  const second = await f.runtime.prompt("What happened? Do not change playback.", {
    onToolEnd(event) { nextEvents.push(event.capabilityId); },
  });
  assert.deepEqual(nextEvents, []);
  assert.equal(second.text, "No new tool action was requested.");
  assert.deepEqual(f.application.spotifyQuickEditContext, { playlist: null, track: null });
  assert.equal(f.writes.length, 1);
});
