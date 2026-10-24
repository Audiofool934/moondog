import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createPlaybackSelection } from "../../src/core/playback-preferences.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

function fixture(t, { service = "spotify", spotify = true, apple = true, netease = false, save, musicApp = null } = {}) {
  const saved = [];
  const played = [];
  const spotifyActions = [];
  const stopped = [];
  const selection = createPlaybackSelection({ service, save: save ?? (async (value) => { saved.push(value); }) });
  const application = new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    playbackSelection: selection,
    musicApp,
    ...(spotify ? { spotifyConnection: { ready: () => true, publicStatus: () => ({ state: "ready" }),
      service: { pause: async () => { spotifyActions.push("pause"); return { provider: "spotify", action: "playback.pause", ok: true, state: "accepted" }; } } } } : {}),
    ...(apple ? {
      musicCatalog: { findArtistReleases() {}, findPreview: async ({ title, artist }) => ({ state: "resolved", track: {
        title, artist_credit: artist, preview_url: "https://audio-ssl.itunes.apple.com/itunes-assets/song.m4a",
        catalog_url: "https://music.apple.com/us/album/1?i=2",
      } }) },
      musicPreviewPlayer: { play: async (tracks) => { played.push(tracks); }, stop: () => { stopped.push("apple_music"); }, wholeSongs: () => true },
    } : {}),
    neteasePlayer: { ready: () => netease, status: () => ({ state: netease ? "ready" : "missing" }),
      check: async () => ({ state: netease ? "ready" : "missing" }),
      stop: async () => { stopped.push("netease"); },
      play: async ({ items, mode }) => { played.push(items); return { mode: mode === "queue" ? "queued" : "playing", songs: items.map((item) => ({ title: item.title, artists: [item.artist], playable: true })) }; } },
  });
  t.after(() => application.close());
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  return { application, runtime, faux, selection, saved, played, spotifyActions, stopped };
}

function product(context) {
  const message = context.messages.find((entry) => entry.role === "user" && entry.content?.[0]?.text?.startsWith("[Trusted Moondog product context]\n"));
  return JSON.parse(message.content[0].text.split("\n")[1]);
}

function toolResult(context, name) {
  const result = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === name);
  assert.ok(result, name);
  return { ...result, value: JSON.parse(result.content[0].text) };
}

const tools = (runtime) => runtime.agent.state.tools.map((tool) => tool.name);
// What the model request itself declares, after every system message in it.
const declared = (context) => getCurrentTools(context.messages).map((tool) => tool.name);
const instructions = (context) => getCurrentSystemPrompt(context.messages);
const use = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

test("the listener can switch from Spotify to Apple Music and hear the selection in the same turn", async (t) => {
  const f = fixture(t);
  f.faux.setResponses([
    (context) => {
      assert.equal(product(context).playback.selected_service, "spotify");
      assert.equal(product(context).playback.effective_service, "spotify");
      assert.ok(tools(f.runtime).includes("moondog_playback_service"));
      assert.ok(!tools(f.runtime).includes("moondog_music_preview"));
      assert.ok(declared(context).includes("moondog_spotify_player_control"));
      assert.doesNotMatch(instructions(context), /Session availability/u);
      return use("moondog_playback_service", { service: "apple_music" });
    },
    (context) => {
      const result = toolResult(context, "moondog_playback_service");
      assert.equal(result.isError, false, result.content[0].text);
      assert.equal(result.value.selected_service, "apple_music");
      assert.equal(result.value.changed, true);
      assert.equal(product(context).playback.effective_service, "apple_music");
      assert.ok(tools(f.runtime).includes("moondog_music_preview"));
      assert.ok(!tools(f.runtime).includes("moondog_spotify_player_control"));
      assert.ok(declared(context).includes("moondog_music_preview"), "the request declares the new service's tool");
      assert.ok(!declared(context).includes("moondog_spotify_player_control"));
      assert.match(instructions(context), /The listener chose Apple Music to play music/u);
      return use("moondog_music_preview", { tracks: [{ title: "Wind of Change", artist: "Scorpions" }] });
    },
    (context) => {
      assert.equal(toolResult(context, "moondog_music_preview").value.plays, "whole_songs");
      return fauxAssistantMessage([fauxText("换到 Apple Music 了，正在放 Scorpions 的 Wind of Change。")]);
    },
  ]);
  const started = [];
  const result = await f.runtime.prompt("不要用 Spotify 了，用 Apple Music 听，放 Scorpions 的 Wind of Change。", {
    onToolStart: ({ capabilityId }) => started.push(capabilityId),
  });
  assert.match(result.text, /换到 Apple Music/u);
  assert.deepEqual(started, ["playback.service", "music.preview.play"]);
  assert.deepEqual(f.saved, ["apple_music"]);
  assert.equal(f.played.length, 1);
  assert.deepEqual(f.spotifyActions, ["pause"], "the service left stops playing");
  assert.equal(f.application.playbackService, "apple_music");
});

test("a service chosen in the picker between replies reaches the agent's next reply without a rebuild", async (t) => {
  const f = fixture(t, { service: "apple_music" });
  const changed = await f.application.selectPlaybackService("spotify", { strict: false });
  assert.equal(changed.changed, true);
  assert.deepEqual(f.stopped, ["apple_music"], "the previews stop");
  f.faux.setResponses([
    (context) => {
      assert.ok(declared(context).includes("moondog_spotify_player_control"));
      assert.ok(!declared(context).includes("moondog_music_preview"));
      assert.doesNotMatch(instructions(context), /Session availability/u);
      return fauxAssistantMessage([fauxText("Spotify it is.")]);
    },
    // A finished reply keeps only its text, so the next switch is measured against the transcript.
    (context) => {
      assert.ok(declared(context).includes("moondog_music_preview"));
      assert.ok(!declared(context).includes("moondog_spotify_player_control"));
      assert.match(instructions(context), /The listener chose Apple Music to play music/u);
      return fauxAssistantMessage([fauxText("Back to Apple Music.")]);
    },
  ]);
  assert.equal((await f.runtime.prompt("play something")).status, "completed");
  await f.application.selectPlaybackService("apple_music", { strict: false });
  assert.equal((await f.runtime.prompt("play something else")).status, "completed");
  assert.deepEqual(f.spotifyActions, ["pause"]);
});

test("a call to the old service's tool in the batch that switches is refused without ending the reply", async (t) => {
  const f = fixture(t);
  f.faux.setResponses([
    () => fauxAssistantMessage([
      fauxToolCall("moondog_playback_service", { service: "apple_music" }),
      fauxToolCall("moondog_spotify_player_control", { action: "pause" }),
    ], { stopReason: "toolUse" }),
    (context) => {
      const refused = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "moondog_spotify_player_control");
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /left with the change of music service/u);
      return fauxAssistantMessage([fauxText("Switched to Apple Music.")]);
    },
  ]);
  const result = await f.runtime.prompt("switch to Apple Music and pause Spotify");
  assert.equal(result.status, "completed");
  assert.deepEqual(f.spotifyActions, ["pause"], "only the switch paused Spotify; the stale call did nothing");
});

test("the agent hears why a service cannot play, and nothing changes", async (t) => {
  const f = fixture(t);
  f.faux.setResponses([
    () => use("moondog_playback_service", { service: "netease" }),
    (context) => {
      const result = toolResult(context, "moondog_playback_service");
      assert.equal(result.isError, false);
      assert.equal(result.value.changed, false);
      assert.equal(result.value.selected_service, "spotify");
      assert.match(result.value.refused, /npm install -g @music163\/ncm-cli/u);
      return fauxAssistantMessage([fauxText("NetEase Music needs ncm-cli first.")]);
    },
  ]);
  await f.runtime.prompt("用网易云放歌");
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.spotifyActions, []);
  assert.equal(f.application.playbackService, "spotify");
});

// The Music app on the Mac, playing one song of a playlist, as the listener left it.
function musicApp(state = "playing") {
  const actions = [];
  const now = () => ({ state, song: { id: "1", title: "Atom Heart Mother", artists: ["Pink Floyd"], album: "Atom Heart Mother", duration_ms: 1_420_000 },
    position_ms: 400_000, shuffle: false, repeat: "off", playlist: { id: "P", name: "A Pink Floyd Experience", library: false } });
  const act = (action, next) => async () => { actions.push(action); state = next ?? state; return now(); };
  return { actions, player: { available: true, nowPlaying: async () => now(),
    pause: act("pause", "paused"), resume: act("resume", "playing"), next: act("next"), previous: act("previous") } };
}

test("switching to Spotify to keep listening there pauses the Music app, and Spotify's controls arrive in the same turn", async (t) => {
  const music = musicApp();
  const f = fixture(t, { service: "apple_music", musicApp: music.player });
  f.faux.setResponses([
    (context) => {
      assert.ok(declared(context).includes("moondog_music_app_control"));
      assert.match(instructions(context), /move the listening to another player/u);
      return use("moondog_playback_service", { service: "spotify" });
    },
    (context) => {
      assert.equal(toolResult(context, "moondog_playback_service").value.selected_service, "spotify");
      assert.deepEqual(music.actions, ["pause"], "the Music app left behind pauses");
      assert.ok(declared(context).includes("moondog_spotify_player_control"));
      return fauxAssistantMessage([fauxText("换到 Spotify 了。")]);
    },
  ]);
  assert.equal((await f.runtime.prompt("cool，能切换到Spotify继续播放那边的音乐吗？")).status, "completed");
  assert.deepEqual(f.stopped, ["apple_music"]);
});

test("the agent pauses and resumes the Music app, and a paused one stays paused when the service changes", async (t) => {
  const music = musicApp("paused");
  const f = fixture(t, { service: "apple_music", musicApp: music.player });
  f.faux.setResponses([
    () => use("moondog_music_app_control", { action: "resume" }),
    (context) => {
      const result = toolResult(context, "moondog_music_app_control");
      assert.equal(result.isError, false, result.content[0].text);
      assert.equal(result.value.state, "playing");
      assert.equal(result.value.song.title, "Atom Heart Mother");
      assert.equal(result.value.from.name, "A Pink Floyd Experience");
      return use("moondog_music_app_control", { action: "pause" });
    },
    () => fauxAssistantMessage([fauxText("Paused.")]),
  ]);
  assert.equal((await f.runtime.prompt("keep Pink Floyd going, then pause it")).status, "completed");
  assert.deepEqual(music.actions, ["resume", "pause"]);
  await f.application.selectPlaybackService("spotify");
  assert.deepEqual(music.actions, ["resume", "pause"], "nothing to pause");
});
