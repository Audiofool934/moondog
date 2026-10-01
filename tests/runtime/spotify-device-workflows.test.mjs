import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";
import { createSpotifyWebApiClient } from "../../src/integrations/spotify/web-api-client.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
const use = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const devices = [
  { id: "one", name: "Kitchen", type: "Speaker", is_active: true, supports_volume: true, volume_percent: 30 },
  { id: "two", name: "Kitchen", type: "Speaker", supports_volume: true, volume_percent: 50 },
  { id: "three", name: "Pixel", type: "Smartphone", supports_volume: false },
  { id: "four", name: "Microphone", type: "Speaker", supports_volume: false },
];
function fixture(t) {
  const writes = []; const state = { devices: structuredClone(devices) };
  const client = { getDevices: async () => ({ provider: "spotify", devices: state.devices }),
    transfer: async (input) => writes.push(["transfer", input]), setVolume: async (input) => writes.push(["volume", input]),
    pause: async (input) => writes.push(["pause", input]), addToQueue: async (input) => writes.push(["queue", input]) };
  const service = createSpotifyService({ client });
  const application = new MoondogApplication({ importsRoot: "/tmp/moondog-fictional-no-imports", spotifyConnection: { ready: () => true, missingScopes: () => [], service, publicStatus: () => ({ provider: "spotify", state: "ready" }) } });
  t.after(() => application.close());
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  return { writes, state, service, application, faux, runtime };
}
test("device names never substitute another brand or a suffix; generic type remains useful", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.service.transfer({ deviceName: "iPhone" }), { code: "spotify_device_not_found" });
  await f.service.transfer({ deviceName: "phone" });
  assert.deepEqual(f.writes, [["transfer", { deviceId: "three", play: false }]]);
  await assert.rejects(f.service.transfer({ deviceName: "Kitchen" }), { code: "spotify_device_ambiguous" });
});
test("agent device refs distinguish duplicate names and target volume/pause/transfer across turns", async (t) => {
  const f = fixture(t); let second;
  f.faux.setResponses([use("moondog_spotify_devices"), (input) => {
    const result = JSON.parse(input.messages.findLast((m) => m.role === "toolResult").content[0].text);
    second = result.devices[1].device_ref_id;
    assert.equal(result.devices[0].volume_percent, 30); assert.equal(result.devices[2].supports_volume, false);
    assert.notEqual(second, result.devices[0].device_ref_id); assert.doesNotMatch(JSON.stringify(result), /"id"/);
    return fauxAssistantMessage([fauxText("Two Kitchen speakers are available.")]);
  }]);
  await f.runtime.prompt("List devices");
  f.faux.setResponses([use("moondog_spotify_player_control", { action: "volume", percent: 40, device_ref_id: second }),
    use("moondog_spotify_player_control", { action: "pause", device_ref_id: second }),
    use("moondog_spotify_device_transfer", { device_ref_id: second }), fauxAssistantMessage([fauxText("Done.")])]);
  assert.equal((await f.runtime.prompt("Set the second Kitchen to 40, pause there and switch to it")).status, "completed");
  assert.deepEqual(f.writes, [["volume", { percent: 40, deviceId: "two" }], ["pause", { deviceId: "two" }], ["transfer", { deviceId: "two", play: false }]]);
  f.state.devices = f.state.devices.filter((d) => d.id !== "two");
  await assert.rejects(f.application.spotifyDeviceTarget({ deviceRefId: second }), { code: "spotify_device_not_found" });
  f.application.resetSpotifyReadContext();
  await assert.rejects(f.application.spotifyDeviceTarget({ deviceRefId: second }), { code: "spotify_device_reference_expired" });
});
test("restricted, unsupported volume, conflicting selectors and cancellation do not dispatch", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.application.spotifyDeviceTarget({ deviceName: "Pixel" }, { forVolume: true }), { code: "spotify_volume_unsupported" });
  f.state.devices[0].is_restricted = true;
  await assert.rejects(f.application.spotifyDeviceTarget({ deviceId: "one" }), { code: "spotify_device_restricted" });
  await assert.rejects(f.application.spotifyDeviceTarget({ deviceId: "one", deviceName: "Pixel" }), { code: "conflicting_device_target" });
  await assert.rejects(f.application.spotifyDeviceTarget({ deviceId: "two" }, { signal: AbortSignal.abort() }));
  assert.equal(f.writes.length, 0);
});
test("a duplicate-name device ordinal authorizes only its retained identity", async t => {
  const f = fixture(t);
  const listed = await f.application.spotifyDevices();
  f.faux.setResponses([use("moondog_spotify_device_transfer", { device_ref_id: listed.devices[0].device_ref_id }), fauxAssistantMessage([fauxText("Done.")])]);
  await f.runtime.prompt("Switch to the second Kitchen");
  assert.equal(f.writes.length, 0);
});
for (const status of [null, 200, 403, 503]) test(`write settlement deadline is bounded and never replays; stalled status ${status}`, async () => {
  let calls = 0; let late;
  const client = createSpotifyWebApiClient({ tokenProvider: async () => "fictional", writeTimeoutMs: 20, fetchImpl: async (_url, init) => {
    calls++; assert.ok(init.signal);
    if (status === null) return new Promise((resolve) => { late = resolve; });
    return { ok: status === 200, status, headers: new Headers(), text: () => new Promise((resolve) => { late = resolve; }) };
  } });
  const control = new AbortController();
  const promise = client.addPlaylistTracks({ playlistId: "fictional", uris: ["spotify:track:fictional"] }, { signal: control.signal });
  await new Promise((resolve) => setImmediate(resolve)); control.abort();
  await assert.rejects(promise, (e) => e.outcomeUnknown === (status !== 403));
  assert.equal(calls, 1); late(status === null ? new Response(null, { status: 204 }) : '{}');
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 1);
});
test("dispatched write can settle accepted after caller cancellation before deadline", async () => {
  let release; const control = new AbortController();
  const client = createSpotifyWebApiClient({ tokenProvider: async () => "fictional", writeTimeoutMs: 100, fetchImpl: () => new Promise((r) => { release = r; }) });
  const operation = client.pause({}, { signal: control.signal }); await new Promise((r) => setImmediate(r));
  control.abort(); release(new Response(null, { status: 204 })); await operation;
});
