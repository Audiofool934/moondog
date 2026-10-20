import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSimulatedSpotify } from "../../src/evaluation/simulated-spotify.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";
import { createSpotifyWebApiClient } from "../../src/integrations/spotify/web-api-client.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

// Playback, queue and device moves are reversible: the model acts on the listener's words in any
// language and writes the reply, while Spotify's real state and the structured receipts stay true.
function fixture(t, setup = {}) {
  const spotify = createSimulatedSpotify({ devices: [{ id: "simMac", name: "Fictional MacBook Pro", type: "Computer" }, { id: "simPC", name: "PC", type: "Computer" }], ...setup });
  const client = createSpotifyWebApiClient({ tokenProvider: async () => "SIMULATED", fetchImpl: spotify.fetchImpl });
  const application = new MoondogApplication({ importsRoot: "/tmp/fictional-playback-contract-no-imports",
    spotifyConnection: { service: createSpotifyService({ client, thisComputerName: "Fictional MacBook Pro" }), ready: () => true,
      missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }) } });
  t.after(() => application.close());
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  const call = (name, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
  const say = text => fauxAssistantMessage([fauxText(text)]);
  const lastResult = context => context.messages.filter(message => message.role === "toolResult").at(-1);
  const found = (context, title) => JSON.parse(context.messages.filter(message => message.role === "toolResult" && message.toolName === "moondog_spotify_search")
    .at(-1).content[0].text).items.find(item => item.name === title).item_ref_id;
  const prompt = (text, responses) => { faux.setResponses(responses); return runtime.prompt(text); };
  const plays = () => spotify.state.writes.filter(write => write.path === "/me/player/play").length;
  return { spotify, application, call, say, lastResult, found, prompt, plays };
}

test("the model's reply stands after it plays a song, and the result keeps the receipt", async t => {
  const f = fixture(t);
  const result = await f.prompt("我要听伍佰的被动", [f.call("moondog_spotify_search", { query: "伍佰 被动" }),
    c => f.call("moondog_spotify_player_control", { action: "resume", item_ref_id: f.found(c, "被動") }), f.say("在放《被動》了。")]);
  assert.equal(result.text, "在放《被動》了。");
  assert.equal(f.spotify.state.current.id, "simBeidong");
  assert.equal(f.spotify.state.active, "simMac");
  assert.equal(result.spotify_write_receipts[0].action, "playback.resume");
  assert.equal(result.spotify_write_receipts[0].targets[0].title, "被動");
});

test("a reference from an earlier search still plays after later searches", async t => {
  const f = fixture(t, { active: "simMac", playing: "simReckoner" });
  let beyond;
  await f.prompt("搜一下 Beyond 和陈奕迅的歌", [f.call("moondog_spotify_search", { query: "Beyond" }),
    c => { beyond = f.found(c, "海闊天空"); return f.call("moondog_spotify_search", { query: "陈奕迅" }); }, f.say("找到了。")]);
  const result = await f.prompt("放刚才那首海阔天空", [f.call("moondog_spotify_player_control", { action: "resume", item_ref_id: beyond }), f.say("好。")]);
  assert.equal(result.spotify_playback_failures, undefined);
  assert.equal(f.spotify.state.current.id, "simHaiKuoTianKong");
});

test("moving playback starts the song on the target when Spotify refuses the transfer", async t => {
  const f = fixture(t, { active: "simMac", playing: "simBeidongDuet", refuseTransfersTo: ["simPC"] });
  const result = await f.prompt("切到 PC 播放", [f.call("moondog_spotify_device_transfer", { device_name: "PC" }), f.say("已经在 PC 上放了。")]);
  assert.equal(result.text, "已经在 PC 上放了。");
  assert.deepEqual([f.spotify.state.active, f.spotify.state.playing, f.spotify.state.current.id], ["simPC", true, "simBeidongDuet"]);
  assert.deepEqual(f.spotify.state.writes.map(write => `${write.path} ${write.status}`), ["/me/player 403", "/me/player/play 204"]);
});

test("a move Spotify refuses every way leaves playback where it was, in plain words for the model", async t => {
  const f = fixture(t, { active: "simMac", playing: "simBeidongDuet", refuseMovesTo: ["simPC"] });
  let error;
  const result = await f.prompt("切到 PC 播放", [f.call("moondog_spotify_device_transfer", { device_name: "PC" }),
    c => { error = f.lastResult(c); return f.say("没能切到 PC，还在 Mac 上放。"); }]);
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /would not move playback to PC.*Playback stays on Fictional MacBook Pro/su);
  assert.equal(result.text, "没能切到 PC，还在 Mac 上放。");
  assert.equal(result.spotify_playback_failures[0].code, "spotify_device_refused");
  assert.deepEqual([f.spotify.state.active, f.spotify.state.playing], ["simMac", true]);
});

test("pausing a paused player and resuming a playing one succeed without a change", async t => {
  const f = fixture(t, { active: "simMac", playing: "simWeirdFishes" });
  const pause = f.call("moondog_spotify_player_control", { action: "pause" });
  const resume = f.call("moondog_spotify_player_control", { action: "resume" });
  for (const [text, step, playing] of [["一時停止して", pause, false], ["止めて", pause, false], ["再開して", resume, true], ["続けて", resume, true]]) {
    let outcome;
    await f.prompt(text, [step, c => { outcome = f.lastResult(c); return f.say("はい。"); }]);
    assert.equal(outcome.isError, false, text);
    assert.equal(f.spotify.state.playing, playing, text);
  }
  assert.equal(f.plays(), 1);
  assert.equal(f.spotify.state.writes.filter(write => write.path === "/me/player/pause" && write.status === 204).length, 1);
});

test("asking for the same song twice in one turn plays it once", async t => {
  const f = fixture(t, { active: "simMac", playing: "simReckoner" });
  const resume = c => f.call("moondog_spotify_player_control", { action: "resume", item_ref_id: f.found(c, "Nude") });
  await f.prompt("play Nude", [f.call("moondog_spotify_search", { query: "Nude Radiohead" }), resume, resume, f.say("Playing Nude.")]);
  assert.equal(f.plays(), 1);
  assert.equal(f.spotify.state.current.id, "simNude");
});

test("the device the model chooses from the listener's words is used in any language", async t => {
  const f = fixture(t);
  const result = await f.prompt("PC에서 Reckoner 틀어줘", [f.call("moondog_spotify_search", { query: "Reckoner Radiohead" }),
    c => f.call("moondog_spotify_player_control", { action: "resume", item_ref_id: f.found(c, "Reckoner"), device_name: "PC" }), f.say("PC에서 재생 중이에요.")]);
  assert.equal(result.spotify_playback_failures, undefined);
  assert.deepEqual([f.spotify.state.active, f.spotify.state.current.id], ["simPC", "simReckoner"]);
});

test("a queue request with nothing playing starts the first song on this computer and queues the rest", async t => {
  const f = fixture(t);
  const refs = c => JSON.parse(c.messages.filter(message => message.toolName === "moondog_spotify_search").at(-1).content[0].text).items.map(item => item.item_ref_id);
  const result = await f.prompt("pon tres canciones de Radiohead en la cola", [f.call("moondog_spotify_search", { query: "Radiohead" }),
    c => f.call("moondog_spotify_queue_batch", { item_refs: refs(c), count: 3 }), f.say("Listo: suena Radiohead y hay dos más en la cola.")]);
  assert.equal(result.text, "Listo: suena Radiohead y hay dos más en la cola.");
  assert.deepEqual([f.spotify.state.active, f.spotify.state.playing, f.spotify.state.queue.length], ["simMac", true, 2]);
  assert.equal(result.spotify_queue_plan.queued.length, 3);
});
