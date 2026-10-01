import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createSpotifyWebApiClient } from "../../src/integrations/spotify/web-api-client.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const device = (id = "mac", active = true) => ({ id, name: id === "mac" ? "Fictional Mac" : `Fictional ${id}`, type: "Computer", is_active: active, is_restricted: false });
const song = { id: "rose", uri: "spotify:track:rose", name: "玫瑰少年", type: "track", artists: [{ name: "JOLIN" }] };
const source = { uris: [song.uri], positionMs: 123 };
const tool = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const say = (text = "已播放。") => fauxAssistantMessage([fauxText(text)]);
function fixture(t, options = {}) {
  const state = { devices: [device()], playback: { is_playing: false, device: device(), item: song },
    playStatuses: [], transferStatus: 204, autoActivate: true, reads: [], writes: [], sleeps: 0, ...options };
  const client = createSpotifyWebApiClient({ tokenProvider: options.tokenProvider ?? (async () => "FICTIONAL"), writeTimeoutMs: 30,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url), route = parsed.pathname;
      if (init.method === "GET") {
        state.reads.push(route);
        const override = await state.onRead?.(route, init.signal);
        if (override) return override;
        if (route === "/v1/me/player/devices") return Response.json({ devices: state.devices });
        if (route === "/v1/me/player") return state.playback === null ? new Response(null, { status: 204 }) : Response.json(state.playback);
        if (route === "/v1/search") return Response.json({ tracks: { items: [song] } });
        if (route === "/v1/me/player/queue") return Response.json({ currently_playing: null, queue: [] });
        throw new Error(`Unexpected fictional read: ${route}`);
      }
      const write = { route, device: parsed.searchParams.get("device_id"), body: JSON.parse(init.body ?? "null") };
      state.writes.push(write);
      await state.onWrite?.(write);
      const status = route === "/v1/me/player" ? state.transferStatus : state.playStatuses.shift() ?? 204;
      if (status === "network") throw new Error("Fictional network loss");
      if (status === "timeout") return new Promise(() => {});
      if (route === "/v1/me/player" && status === 204 && state.autoActivate) {
        state.devices = state.devices.map(entry => ({ ...entry, is_active: entry.id === write.body.device_ids[0] }));
        if (state.playback) state.playback.device = state.devices.find(entry => entry.is_active);
      }
      return status === 204 ? new Response(null, { status }) : Response.json({ error: { status, reason: state.reason ?? "NO_ACTIVE_DEVICE" } }, { status });
    } });
  const service = createSpotifyService({ client, playbackReadinessTimeoutMs: options.timeout ?? 1000,
    playbackReadinessSleep: async () => { state.sleeps++; await state.onSleep?.(); } });
  const app = new MoondogApplication({ importsRoot: "/tmp/fictional-cold-start-no-imports",
    spotifyConnection: { service, ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }) } });
  t.after(() => app.close());
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application: app, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  const prompt = async (text, responses) => { faux.setResponses(responses); return runtime.prompt(text); };
  return { state, service, app, runtime, prompt };
}
const playTrace = (extra = [], deviceName) => [tool("moondog_spotify_search", { query: "玫瑰少年 JOLIN" }), context => {
  const result = JSON.parse(context.messages.filter(message => message.toolName === "moondog_spotify_search" && message.role === "toolResult").at(-1).content[0].text);
  return tool("moondog_spotify_player_control", { action: "resume", item_ref_id: result.items[0].item_ref_id, ...(deviceName ? { device_name: deviceName } : {}) });
}, ...extra, say("错误的模型声明：任何操作都没发生")];

for (const playing of [false, true]) test(`active device plays exact song once, without transfer; playing=${playing}`, async t => {
  const f = fixture(t); f.state.playback.is_playing = playing;
  const receipt = await f.service.resume(source);
  assert.equal(receipt.state, "accepted");
  assert.deepEqual(f.state.writes, [{ route: "/v1/me/player/play", device: "mac", body: { uris: source.uris, position_ms: 123 } }]);
});

test("paused inactive device transfers once preserving pause, waits for readiness, then plays", async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false, device: device("mac", false) }, autoActivate: false });
  f.state.onSleep = () => { if (f.state.sleeps === 2) { f.state.devices[0].is_active = true; f.state.playback.device.is_active = true; } };
  const receipt = await f.service.resume(source);
  assert.equal(f.state.sleeps, 2);
  assert.deepEqual(f.state.writes.map(write => write.route), ["/v1/me/player", "/v1/me/player/play"]);
  assert.deepEqual(f.state.writes[0].body, { device_ids: ["mac"], play: false });
  assert.deepEqual(f.state.writes[1].body, { uris: source.uris, position_ms: 123 });
  assert.equal(receipt.preparation_effects[0].action, "playback.transfer");
});

test("fresh startup with a sole inactive device and no playback state targets exact play without warming old content", async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback: null });
  await f.service.resume(source);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.writes[0].device, "mac");
  assert.equal(f.state.writes[0].route, "/v1/me/player/play");
});

test("only definite 404 NO_ACTIVE_DEVICE permits one same-device, identical-payload recovery", async t => {
  const f = fixture(t, { playStatuses: [404, 204] });
  const receipt = await f.service.resume(source);
  assert.equal(receipt.recovered_no_active_device, true);
  assert.equal(f.state.writes.length, 2);
  assert.deepEqual(f.state.writes[0], f.state.writes[1]);
  assert.equal(f.state.sleeps, 1);
});

for (const [status, reason, count] of [[404, "UNKNOWN", 1], [403, "NO_ACTIVE_DEVICE", 1], [500, "NO_ACTIVE_DEVICE", 1], ["network", null, 1], ["timeout", null, 1], [404, "NO_ACTIVE_DEVICE", 2]]) {
  test(`recovery is bounded for ${status}/${reason}`, async t => {
    const f = fixture(t, { playStatuses: [status, status], reason });
    await assert.rejects(f.service.resume(source));
    assert.equal(f.state.writes.length, count);
    assert.ok(f.state.writes.every(write => write.route === "/v1/me/player/play" && write.device === "mac"));
  });
}

for (const playback of [null, {}, { is_playing: true }]) test(`unknown/playing inactive state cannot transfer an old song: ${JSON.stringify(playback)}`, async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback, playStatuses: [404] });
  await assert.rejects(f.service.resume(source), { code: "spotify_device_not_ready" });
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.writes[0].route, "/v1/me/player/play");
});

test("an existing active device wins over an inactive preference; explicit device can play the requested song directly", async t => {
  const f = fixture(t, { devices: [device("mac", false), device("phone")], playback: { is_playing: true, device: device("phone") } });
  await f.service.resume(source, { preferredDeviceId: "mac" });
  await f.service.resume({ ...source, deviceId: "mac" });
  assert.deepEqual(f.state.writes.map(write => [write.route, write.device]), [["/v1/me/player/play", "phone"], ["/v1/me/player/play", "mac"]]);
});

test("retained local-device preference selects among paused inactive devices", async t => {
  const f = fixture(t, { devices: [device("mac", false), device("phone", false)], playback: { is_playing: false } });
  await f.service.resume(source, { preferredDeviceId: "mac" });
  assert.deepEqual(f.state.writes[0].body, { device_ids: ["mac"], play: false });
  assert.equal(f.state.writes[1].device, "mac");
});

for (const [devices, playback, code] of [
  [[], null, "spotify_device_not_found"],
  [[device("mac", false), device("phone", false)], null, "spotify_device_ambiguous"],
  [[{ ...device(), is_restricted: true }], null, "spotify_device_restricted"],
  [[{ id: "mac", name: "Fictional Mac" }], null, "spotify_device_restricted"],
  [[device(), device("phone")], null, "spotify_device_state_unconfirmed"],
  [[device(), device()], null, "spotify_device_state_unconfirmed"],
  [[device()], { is_playing: false, device: device("phone") }, "spotify_device_state_unconfirmed"],
]) test(`unusable or ambiguous state stops before writes: ${code}/${devices.length}`, async t => {
  const f = fixture(t, { devices, playback });
  await assert.rejects(f.service.resume(source), error => error.code === code && error.actionNotDispatched === true);
  assert.equal(f.state.writes.length, 0);
});

test("a disappeared explicit device never falls back to the remaining active device", async t => {
  const f = fixture(t);
  await assert.rejects(f.service.resume({ ...source, deviceId: "oldMac" }), { code: "spotify_device_not_found" });
  assert.equal(f.state.writes.length, 0);
});

for (const change of ["disappear", "other-active", "restricted"]) test(`state change during readiness retains transfer effect and sends no song: ${change}`, async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false }, autoActivate: false });
  f.state.onSleep = () => {
    if (change === "disappear") f.state.devices = [];
    else if (change === "restricted") f.state.devices[0].is_restricted = true;
    else f.state.devices.push(device("phone"));
  };
  await assert.rejects(f.service.resume(source), error => error.playbackPreparation.length === 1 && error.playbackNotDispatched && !error.actionNotDispatched);
  assert.equal(f.state.writes.length, 1);
});

test("readiness wait is bounded, including a transport that ignores cancellation", async t => {
  const f = fixture(t, { timeout: 20 });
  f.state.onRead = () => new Promise(() => {});
  await assert.rejects(f.service.resume(source), { code: "spotify_device_not_ready", actionNotDispatched: true });
  assert.equal(f.state.writes.length, 0);
});

test("readiness poll exhaustion preserves accepted transfer and never repeats it", async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false }, autoActivate: false });
  await assert.rejects(f.service.resume(source), error => error.code === "spotify_device_not_ready" && error.playbackPreparation.length === 1);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.reads.length, 8);
});

for (const status of [404, "network", "timeout"]) test(`transfer failure is never repeated or followed by play: ${status}`, async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false }, transferStatus: status });
  await assert.rejects(f.service.resume(source), error => error.playbackAction === "playback.transfer" && error.playbackNotDispatched && error.outcomeUnknown === (status !== 404));
  assert.equal(f.state.writes.length, 1);
});

for (const boundary of ["before", "after-transfer", "during-poll", "after-play"]) test(`cancellation respects accepted effects: ${boundary}`, async t => {
  const controller = new AbortController();
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false } });
  if (boundary === "before") controller.abort();
  if (boundary === "during-poll") f.state.onSleep = () => controller.abort();
  f.state.onWrite = write => { if (boundary === "after-transfer" && write.route === "/v1/me/player" || boundary === "after-play" && write.route === "/v1/me/player/play") controller.abort(); };
  if (boundary === "after-play") assert.equal((await f.service.resume(source, { signal: controller.signal })).state, "accepted");
  else await assert.rejects(f.service.resume(source, { signal: controller.signal }), error => boundary === "before" || error.playbackPreparation.length === 1);
  assert.equal(f.state.writes.length, boundary === "before" ? 0 : boundary === "after-play" ? 2 : 1);
});

test("full model/Spotify trace records preparation and exact song, blocks a subsequent model replay", async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false }, playStatuses: [404, 204] });
  const result = await f.prompt("播放玫瑰少年 JOLIN", playTrace([tool("moondog_spotify_player_control", { action: "resume" })]));
  assert.deepEqual(f.state.writes.map(write => write.route), ["/v1/me/player", "/v1/me/player/play", "/v1/me/player/play"]);
  assert.deepEqual(f.state.writes[1], f.state.writes[2]);
  assert.deepEqual(result.spotify_write_receipts.map(receipt => receipt.action), ["playback.transfer", "playback.resume"]);
  assert.equal(result.spotify_write_receipts[1].recovered_no_active_device, true);
  assert.match(result.text, /玫瑰少年/u);
  assert.doesNotMatch(result.text, /错误的模型声明/u);
});

test("explicit retry preserves the implicitly chosen device and recording when another device becomes active", async t => {
  const f = fixture(t, { playStatuses: [404, 404] });
  await f.prompt("播放玫瑰少年 JOLIN", playTrace());
  f.state.devices = [device("mac", false), device("phone")]; f.state.playback.device = device("phone");
  const result = await f.prompt("retry", [tool("moondog_spotify_player_control", { action: "resume" }), say()]);
  assert.equal(f.state.writes.length, 2);
  assert.match(result.text, /spotify_device_changed/u);
  assert.deepEqual(f.app.spotifyPlaybackAttempt.parameters.uris, [song.uri]);
  assert.equal(f.app.spotifyPlaybackAttempt.parameters.deviceId, "mac");
});

test("cancelled preparation retains accepted transfer in runtime audit and truthful final text", async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false } });
  f.state.onWrite = () => f.runtime.abort();
  const result = await f.prompt("播放玫瑰少年 JOLIN", playTrace());
  assert.equal(result.status, "aborted");
  assert.equal(result.spotify_write_receipts[0].action, "playback.transfer");
  assert.equal(result.spotify_write_receipts[0].state, "accepted");
  assert.equal(f.state.writes.length, 1);
  assert.match(result.text, /设备切换/u);
});

test("unknown transfer is audited only as transfer, never as dispatched song playback", async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false }, transferStatus: "network" });
  const result = await f.prompt("播放玫瑰少年 JOLIN", playTrace([tool("moondog_spotify_player_control", { action: "resume" })]));
  assert.equal(f.state.writes.length, 1);
  assert.deepEqual(result.spotify_write_receipts.map(receipt => [receipt.action, receipt.state]), [["playback.transfer", "unknown"]]);
  assert.equal(result.spotify_playback_failures[0].playback_not_sent, true);
});

test("queue requests never invoke playback preparation or transfer", async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false } });
  await f.service.addToQueue({ uri: song.uri });
  assert.deepEqual(f.state.writes.map(write => write.route), ["/v1/me/player/queue"]);
  assert.ok(!f.state.reads.includes("/v1/me/player"));
});

for (const text of ["播放玫瑰少年 JOLIN", "Play a song by Mac DeMarco", "播放玫瑰少年，不要在 Mac 上播放", "Play Rose, not on Mac"]) test(`model device arguments never invent or override listener intent: ${text}`, async t => {
  const f = fixture(t, { devices: [device("mac", false), device("phone")], playback: { is_playing: false, device: device("phone") } });
  const result = await f.prompt(text, playTrace([], "Mac"));
  assert.equal(f.state.writes.length, 0);
  assert.equal(result.spotify_playback_failures[0].code, "spotify_device_selection_not_authorized");
});

for (const text of ["在 Mac 上播放玫瑰少年 JOLIN", "Play Rose by JOLIN on my Mac"]) test(`listener-selected device prepares then plays only requested song: ${text}`, async t => {
  const f = fixture(t, { devices: [device("mac", false), device("phone")], playback: { is_playing: false, device: device("phone") } });
  await f.prompt(text, playTrace([], "Mac"));
  assert.deepEqual(f.state.writes.map(write => write.route), ["/v1/me/player", "/v1/me/player/play"]);
  assert.equal(f.state.writes[1].device, "mac");
  assert.deepEqual(f.state.writes[1].body, { uris: [song.uri] });
});

for (const duplicate of [false, true]) test(`named listener device via retained ref respects duplicate-name ambiguity=${duplicate}`, async t => {
  const f = fixture(t, { devices: [device("mac", false), ...(duplicate ? [{ ...device("other", false), name: "Fictional Mac" }] : [])], playback: { is_playing: false } });
  const trace = playTrace();
  trace.splice(1, 0, tool("moondog_spotify_devices"));
  trace[2] = context => {
    const read = name => JSON.parse(context.messages.filter(message => message.toolName === name && message.role === "toolResult").at(-1).content[0].text);
    return tool("moondog_spotify_player_control", { action: "resume", item_ref_id: read("moondog_spotify_search").items[0].item_ref_id, device_ref_id: read("moondog_spotify_devices").devices[0].device_ref_id });
  };
  await f.prompt("在 Fictional Mac 播放玫瑰少年 JOLIN", trace);
  assert.equal(f.state.writes.length, duplicate ? 0 : 2);
});

test("a second accepted-play attempt cannot vary selector/position or erase the retained retry device", async t => {
  const f = fixture(t);
  const trace = playTrace();
  const second = context => {
    const result = JSON.parse(context.messages.filter(message => message.toolName === "moondog_spotify_search" && message.role === "toolResult").at(-1).content[0].text);
    return tool("moondog_spotify_player_control", { action: "resume", item_ref_id: result.items[0].item_ref_id, device_name: "Mac", position_ms: 0 });
  };
  trace.splice(2, 0, second, tool("moondog_spotify_player_control", { action: "resume" }));
  await f.prompt("在 Mac 上播放玫瑰少年 JOLIN", trace);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.app.spotifyPlaybackAttempt.outcome, "accepted");
  assert.equal(f.app.spotifyPlaybackAttempt.parameters.deviceId, "mac");
  f.state.devices = [device("mac", false), device("phone")]; f.state.playback.device = device("phone");
  await f.prompt("重试", [tool("moondog_spotify_player_control", { action: "resume" }), say()]);
  assert.equal(f.state.writes.length, 1);
});

test("explicit device preference applies to a later inactive choice and clears on reset", async t => {
  const f = fixture(t);
  await f.prompt("Play Rose on my Mac", playTrace([], "Mac"));
  f.state.devices = [device("mac", false), device("phone", false)]; f.state.playback = { is_playing: false };
  await f.prompt("Play Rose again", playTrace());
  assert.deepEqual(f.state.writes.at(-2).body, { device_ids: ["mac"], play: false });
  f.app.resetSpotifyReadContext();
  f.state.devices = [device("mac", false), device("phone", false)]; f.state.playback = { is_playing: false };
  const result = await f.prompt("Play Rose again", playTrace());
  assert.equal(f.state.writes.length, 3);
  assert.equal(result.spotify_playback_failures[0].code, "spotify_device_ambiguous");
});

test("token cancellation before song dispatch retains transfer without claiming song was sent", async t => {
  const controller = new AbortController(); let tokens = 0;
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false }, tokenProvider: async () => {
    if (++tokens === 6) controller.abort(); return "FICTIONAL";
  } });
  await assert.rejects(f.service.resume(source, { signal: controller.signal }), error => error.playbackPreparation.length === 1 && error.playbackNotDispatched === true);
  assert.equal(f.state.writes.length, 1);
});

test("unknown flags remain unknown in model-visible player and device results", async t => {
  const f = fixture(t, { devices: [{ id: "mac", name: "Fictional Mac" }], playback: {} });
  await f.prompt("Show Spotify devices and now playing", [tool("moondog_spotify_devices"), tool("moondog_spotify_now_playing"), context => {
    const read = name => JSON.parse(context.messages.filter(message => message.toolName === name && message.role === "toolResult").at(-1).content[0].text);
    assert.equal(read("moondog_spotify_devices").devices[0].is_active, null);
    assert.equal(read("moondog_spotify_devices").devices[0].is_restricted, null);
    assert.equal(read("moondog_spotify_now_playing").is_playing, null);
    return say();
  }]);
  assert.equal(f.state.writes.length, 0);
});

test("named song on a device cannot warm up old content through standalone transfer", async t => {
  const f = fixture(t);
  await f.prompt("在 Mac 上播放玫瑰少年 JOLIN", [tool("moondog_spotify_device_transfer", { device_name: "Mac", play: true }), say()]);
  assert.equal(f.state.writes.length, 0);
});

for (const text of ["播放玫瑰少年 JOLIN，不要切换设备", "Play Rose, don't transfer playback"]) test(`negated transfer cannot be bypassed by standalone or implicit preparation: ${text}`, async t => {
  const f = fixture(t, { devices: [device("mac", false)], playback: { is_playing: false } });
  await f.prompt(text, [tool("moondog_spotify_device_transfer", { device_name: "Mac", play: true }), ...playTrace()]);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.writes[0].route, "/v1/me/player/play");
  assert.equal(f.state.writes[0].device, "mac");
});

for (const text of ["播放玫瑰少年，不要在 Mac 上播放", "Play Rose, not on Mac"]) test(`an excluded device cannot become an implicit fallback: ${text}`, async t => {
  const f = fixture(t);
  await f.prompt(text, playTrace());
  assert.equal(f.state.writes.length, 0);
});
