import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createSpotifyWebApiClient } from "../../src/integrations/spotify/web-api-client.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const device = (id = "mac", active = true) => ({ id, name: id === "mac" ? "Fictional Mac" : `Fictional ${id}`, type: "Computer", is_active: active, is_restricted: false });
const song = { id: "denverOriginal", uri: "spotify:track:denverOriginal", name: "Take Me Home, Country Roads - Original Version", type: "track", artists: [{ name: "John Denver" }] };
const source = { uris: [song.uri], positionMs: 123 };
const tool = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const say = (text = "已播放。") => fauxAssistantMessage([fauxText(text)]);
function fixture(t, options = {}) {
  const state = { devices: [device()], playback: { is_playing: false, device: device(), item: song },
    playStatuses: [], transferStatus: 204, autoActivate: true, reads: [], writes: [], sleeps: 0, ...options };
  const client = createSpotifyWebApiClient({ tokenProvider: async () => { state.tokenCalls = (state.tokenCalls ?? 0) + 1; return await state.onToken?.(state.tokenCalls) ?? "FICTIONAL"; }, writeTimeoutMs: 30,
    sleepImpl: async (_ms, options) => state.onApiSleep?.(options),
    fetchImpl: async (url, init) => {
      const parsed = new URL(url), route = parsed.pathname;
      if (init.method === "GET") {
        state.reads.push(route);
        const override = await state.onRead?.(route, init.signal);
        if (override) return override;
        if (route === "/v1/me/player/devices") return Response.json({ devices: state.devices });
        if (route === "/v1/me/player") return state.playback === null ? new Response(null, { status: 204 }) : Response.json(state.playback);
        if (route === "/v1/search") return Response.json({ tracks: { items: state.searchItems ?? [song] } });
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

const pc = { ...device("pc", false), name: "PC" };
const playing = { is_playing: true, device: device(), actions: { disallows: { resuming: true } } };
const resume = args => tool("moondog_spotify_player_control", { action: "resume", ...args });
const show = async f => f.prompt("I want to listen Country Road", [tool("moondog_spotify_search", { query: "Country Road" }), say("Choose a version.")]);

for (const input of [source, { contextUri: "spotify:album:countryOriginal" }]) test(`current-context resume flag permits a requested new source: ${JSON.stringify(input)}`, async t => {
  const f = fixture(t, { playback: playing });
  assert.equal((await f.service.resume(input)).state, "accepted");
  assert.equal(f.state.writes.length, 1);
});

test("a paused same-context restriction still applies to bare resume, but not a different device", async t => {
  const f = fixture(t, { devices: [device(), pc], playback: { ...playing, is_playing: false } });
  await assert.rejects(f.service.resume({}), { code: "spotify_playback_restricted" });
  assert.equal(f.state.writes.length, 0);
  f.state.playback.is_playing = true;
  await f.service.resume({ deviceId: "pc" });
  assert.equal(f.state.writes.at(-1).device, "pc");
});

for (const afterTransfer of [false, true]) test(`one transient read can recover without replaying writes; after transfer=${afterTransfer}`, async t => {
  const f = fixture(t, afterTransfer ? { devices: [device("mac", false)], playback: { is_playing: false } } : {});
  let failed = false;
  f.state.onRead = route => { if (!failed && route === "/v1/me/player/devices" && (!afterTransfer || f.state.writes.length)) { failed = true; throw new Error("Fictional read loss"); } };
  await f.service.resume(source);
  assert.deepEqual(f.state.writes.map(write => write.route), afterTransfer ? ["/v1/me/player", "/v1/me/player/play"] : ["/v1/me/player/play"]);
  assert.ok(f.state.reads.length <= 8);
});

test("persistent network failures stop after the single read recovery and never write", async t => {
  const f = fixture(t);
  f.state.onRead = route => { if (route === "/v1/me/player/devices") throw new Error("Fictional outage"); };
  await assert.rejects(f.service.resume(source), { code: "spotify_network_error", actionNotDispatched: true });
  assert.equal(f.state.reads.length, 4);
  assert.equal(f.state.writes.length, 0);
});

test("Windows is a PC name alias, never an arbitrary computer or a stronger exact name", async t => {
  const f = fixture(t, { devices: [device(), pc] });
  assert.equal((await f.service.resolveDevice({ deviceName: "Windows device" })).id, "pc");
  const windows = { ...pc, id: "windows", name: "Windows workstation" };
  f.state.devices.push(windows);
  assert.equal((await f.service.resolveDevice({ deviceName: "Windows" })).id, "windows");
  f.state.devices = [device()];
  await assert.rejects(f.service.resolveDevice({ deviceName: "Windows" }), { code: "spotify_device_no_match" });
});
