import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createNeteasePlayer } from "../../src/integrations/netease/ncm-cli-player.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

// A stand-in ncm-cli that is signed in (or not), finds two recordings of 稻香, and plays at once.
function netease({ signedIn = true } = {}) {
  const calls = [];
  const records = [
    { id: "1D71F87C34BD42F6F13574EB6AFA8516", originalId: 3441643322, name: "稻香", artists: [{ name: "Jay" }], album: { name: "稻香" },
      duration: 198_000, coverImgUrl: "http://p1.music.126.net/cover.jpg", visible: true },
    { id: "81804C7DB01B6A0CB44E9AE685E829AA", originalId: 1868553, name: "稻香", artists: [{ name: "周杰伦" }], album: { name: "魔杰座" },
      duration: 223_000, coverImgUrl: "http://p1.music.126.net/other.jpg", visible: false },
  ];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "login") return signedIn ? { success: true, message: "已登录实名账号" } : { success: false, message: "未登录" };
    if (args[0] === "search") return { code: 200, data: { records: args[3].includes("稻香") ? records : [] } };
    if (args[0] === "state") return { success: true, state: { status: "playing", title: "稻香 - Jay", position: 2, duration: 198, currentIndex: 0, queueLength: 0 } };
    return { success: true };
  };
  return { player: createNeteasePlayer({ run, wait: async () => {} }), calls };
}

function runtimeFor(app) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, runtime: new PiAgentRuntime({ application: app, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" }) };
}

const systemText = (context) => [context.systemPrompt, ...context.messages.filter((message) => message.role === "system").map((message) => JSON.stringify(message))].join("\n");
const toolIds = (app) => app.agentCapabilityDescriptors().map((descriptor) => descriptor.capability_id).filter((id) => id.startsWith("netease."));

test("NetEase's tools exist only while it is the chosen service and ncm-cli is signed in", async () => {
  const ready = netease();
  await ready.player.check();
  const preview = { play: async () => {} };
  const chosen = new MoondogApplication({ neteasePlayer: ready.player, playbackService: "netease", musicPreviewPlayer: preview });
  assert.deepEqual(toolIds(chosen).sort(), ["netease.control", "netease.now_playing", "netease.play", "netease.search"]);
  assert.equal(chosen.musicPreviewReady(), false, "Apple Music previews do not play beside NetEase");

  assert.deepEqual(toolIds(new MoondogApplication({ neteasePlayer: ready.player, playbackService: "apple_music" })), []);

  const signedOut = netease({ signedIn: false });
  await signedOut.player.check();
  const waiting = new MoondogApplication({ neteasePlayer: signedOut.player, playbackService: "netease" });
  assert.deepEqual(toolIds(waiting), []);
  assert.equal(waiting.toolsStatus().capabilities.find((capability) => capability.id === "netease.play").blocked_by, "netease_not_ready");
});

test("a request to play goes to NetEase, which plays only a playable recording and keeps covers with the host", async () => {
  const { player, calls } = netease();
  await player.check();
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", neteasePlayer: player, playbackService: "netease" });
  const { faux, runtime } = runtimeFor(app);
  faux.setResponses([
    (context) => {
      const prompt = systemText(context);
      assert.match(prompt, /NetEase Music \(网易云音乐\)/u);
      assert.match(prompt, /most often a copyright limit/u);
      assert.doesNotMatch(prompt, /moondog_music_preview/u);
      return fauxAssistantMessage([fauxToolCall("moondog_netease_play", {
        songs: [{ title: "稻香", artist: "周杰伦" }, { title: "Bohemian Rhapsody", artist: "Queen" }], user_intent: "想听稻香",
      })], { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_netease_play");
      assert.equal(result.isError, false, result.content[0].text);
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.result, "playing");
      assert.deepEqual(value.songs.map((song) => [song.title, song.artists, song.other_artist]), [["稻香", ["Jay"], true]]);
      assert.deepEqual(value.not_found, [{ title: "Bohemian Rhapsody", artist: "Queen" }]);
      assert.doesNotMatch(result.content[0].text, /126\.net/u, "the cover address stays with the host");
      return fauxAssistantMessage([fauxText("网易云上周杰伦的原版放不了，多半是版权原因；现在放的是 Jay 翻唱的《稻香》。")]);
    },
  ]);
  await runtime.prompt("播放周杰伦的稻香");
  assert.ok(calls.some((args) => args[0] === "play" && args.includes("1D71F87C34BD42F6F13574EB6AFA8516")));
  assert.ok(!calls.some((args) => args.includes("81804C7DB01B6A0CB44E9AE685E829AA")), "the unplayable original is never sent");
  assert.ok(calls.some((args) => args[0] === "search" && args.at(-1) === "想听稻香"), "only the short intent goes to NetEase");
});

test("a NetEase set gets the host's mix line under the reply, and one song gets none", async () => {
  const recorded = [];
  const player = {
    ready: () => true, check: async () => {}, search: async () => [], nowPlaying: async () => ({ state: "stopped" }),
    play: async ({ items }) => ({ mode: "playing", songs: items.map((item, index) => ({ id: `fictional${index}`, title: item.title, artists: [item.artist] })) }),
  };
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", neteasePlayer: player, playbackService: "netease",
    domainServices: {
      filterDiscoveryTracks: (tracks) => tracks,
      listeningMix: (tracks) => tracks.map((track) => track.title === "Glass Harbor" ? "familiar" : "new"),
      recordMoondogSuggestions: (entries) => recorded.push(...entries),
    } });
  const { faux, runtime } = runtimeFor(app);
  const play = (songs) => fauxAssistantMessage([fauxToolCall("moondog_netease_play", { songs, user_intent: "something for tonight" })], { stopReason: "toolUse" });
  faux.setResponses([
    play([{ title: "Glass Harbor", artist: "The Lanterns" }, { title: "Night Ferry", artist: "Mira Vale" }]),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_netease_play");
      assert.deepEqual(JSON.parse(result.content[0].text).mix, { familiar: 1, returning: 0, heard: 0, known_artist: 0, new: 1 });
      return fauxAssistantMessage([fauxText("Two songs for tonight.")]);
    },
  ]);
  const set = await runtime.prompt("play me something for tonight");
  assert.equal(set.text, "Two songs for tonight.\n\nThe mix: 1 you know well, 1 new to you.");
  assert.deepEqual(recorded.map((entry) => [entry.title, entry.mixSlot]), [["Glass Harbor", "familiar"], ["Night Ferry", "new"]]);

  faux.setResponses([play([{ title: "Night Ferry", artist: "Mira Vale" }]), fauxAssistantMessage([fauxText("Playing it.")])]);
  assert.equal((await runtime.prompt("play Night Ferry by Mira Vale")).text, "Playing it.");
  assert.equal(recorded.length, 2, "a song the listener named stays out of Moondog's ledger");
});
