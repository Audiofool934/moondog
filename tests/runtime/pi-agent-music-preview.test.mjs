import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

import { listAgentCapabilityDescriptors } from "../../src/core/capability-catalog.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSyntheticDomainServices } from "../../src/core/synthetic-domain-services.mjs";
import { createAppleMusicCatalog, createAppleMusicCatalogClient } from "../../src/integrations/apple-music/catalog.mjs";
import { createTerminalPreviewPlayer } from "../../src/integrations/apple-music/terminal-preview-player.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const now = () => Date.parse("2026-10-08T05:00:00.000Z");

function song(trackId, trackName, previewUrl) {
  return {
    wrapperType: "track",
    kind: "song",
    trackId,
    trackName,
    artistName: "Scorpions",
    collectionName: "Crazy World",
    trackTimeMillis: 312000,
    releaseDate: "1990-11-06T08:00:00Z",
    trackViewUrl: `https://music.apple.com/us/album/crazy-world/${trackId}`,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

function scorpionsCatalog() {
  const json = (results) => new Response(JSON.stringify({ results }), { headers: { "content-type": "application/json" } });
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.searchParams.get("entity") === "album") {
      return json([
        { wrapperType: "collection", collectionId: 11, collectionName: "Crazy World (Live)", artistName: "Scorpions", collectionViewUrl: "https://music.apple.com/us/album/11" },
        { wrapperType: "collection", collectionId: 10, collectionName: "Crazy World", artistName: "Scorpions", collectionViewUrl: "https://music.apple.com/us/album/10", artworkUrl100: "https://is1-ssl.mzstatic.com/image/cover/100x100bb.jpg" },
      ]);
    }
    if (url.pathname === "/lookup") {
      assert.equal(url.searchParams.get("id"), "10");
      return json([
        { wrapperType: "collection", collectionId: 10 },
        { ...song(5, "Wind of Change", "https://audio-ssl.itunes.apple.com/itunes-assets/4.m4a"), trackNumber: 4, discNumber: 1 },
        { ...song(4, "Tease Me Please Me", "https://audio-ssl.itunes.apple.com/itunes-assets/1.m4a"), trackNumber: 1, discNumber: 1 },
        { ...song(6, "Hidden Track"), trackNumber: 12, discNumber: 1 },
      ]);
    }
    return json([
      song(1, "Wind of Change (Re-Recorded)", "https://audio-ssl.itunes.apple.com/itunes-assets/rerecorded.m4a"),
      song(2, "Wind of Change", "https://audio-ssl.itunes.apple.com/itunes-assets/original.m4a"),
      song(3, "Wind of Change (Live)", "https://example.com/not-apple.m4a"),
    ]);
  };
  return createAppleMusicCatalog({ client: createAppleMusicCatalogClient({ fetchImpl, now }), now });
}

function application({ played = [], spotify = false, wholeSongs, discovery = false, neteasePlayer } = {}) {
  return new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    ...(discovery ? { domainServices: createSyntheticDomainServices({ subjectScope: "preview-discovery-test" }) } : {}),
    ...(neteasePlayer ? { neteasePlayer } : {}),
    musicCatalog: scorpionsCatalog(),
    musicPreviewPlayer: { play: async (tracks, options) => { played.push({ tracks, options }); }, ...(wholeSongs === undefined ? {} : { wholeSongs: () => wholeSongs }) },
    ...(spotify ? { spotifyConnection: { ready: () => true, service: {}, publicStatus: () => ({ provider: "spotify", state: "configured" }) } } : {}),
  });
}

function runtimeFor(app) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, runtime: new PiAgentRuntime({ application: app, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" }) };
}

const systemText = (context) => [context.systemPrompt, ...context.messages.filter((message) => message.role === "system").map((message) => JSON.stringify(message))].join("\n");

test("when the window plays whole songs, the agent hears so and is told not to call them previews", async () => {
  const { faux, runtime } = runtimeFor(application({ wholeSongs: true }));
  faux.setResponses([
    (context) => {
      assert.match(systemText(context), /When it is whole_songs, do not call them previews/u);
      return fauxAssistantMessage([fauxToolCall("moondog_music_preview", { tracks: [{ title: "Wind of Change", artist: "Scorpions" }] })], { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_music_preview");
      assert.equal(JSON.parse(result.content[0].text).plays, "whole_songs");
      return fauxAssistantMessage([fauxText("Wind of Change is playing.")]);
    },
  ]);
  await runtime.prompt("Play Wind of Change by Scorpions");
});

test("the catalog finds the exact recording's preview, only from Apple's audio host", async () => {
  const result = await scorpionsCatalog().findPreview({ title: "Wind of Change", artist: "Scorpions" });
  assert.equal(result.state, "resolved");
  assert.equal(result.track.title, "Wind of Change");
  assert.equal(result.track.preview_url, "https://audio-ssl.itunes.apple.com/itunes-assets/original.m4a");
  const live = await scorpionsCatalog().findPreview({ title: "Wind of Change (Live)", artist: "Scorpions" });
  assert.equal(live.state, "not_found", "a preview from another host is dropped");
});

test("an album's previews come back in track order, without songs that have no preview", async () => {
  const result = await scorpionsCatalog().findAlbumPreviews({ title: "Crazy World", artist: "Scorpions" });
  assert.equal(result.state, "resolved");
  assert.equal(result.album.catalog_url, "https://music.apple.com/us/album/10");
  assert.equal(result.album.artwork_url, "https://is1-ssl.mzstatic.com/image/cover/300x300bb.jpg");
  assert.deepEqual(result.tracks.map((track) => track.title), ["Tease Me Please Me", "Wind of Change"]);
});

test("previews are offered only when the host can play them", () => {
  const ids = (options) => listAgentCapabilityDescriptors(options).map((descriptor) => descriptor.capability_id);
  assert.ok(!ids({ musicCatalogReady: true }).includes("music.preview.play"));
  assert.ok(ids({ musicCatalogReady: true, musicPreviewReady: true }).includes("music.preview.play"));
  assert.equal(new MoondogApplication({ musicCatalog: scorpionsCatalog() }).musicPreviewReady(), false);
  assert.equal(application().musicPreviewReady(), true);
  assert.equal(application({ spotify: true }).musicPreviewReady(), false, "with Spotify connected, the agent plays the full songs there");
});

test("in the terminal, the agent's pick plays from Apple's audio host through the system player", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-terminal-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, "played.log");
  // A silent stand-in for afplay that records what it was given.
  await writeFile(path.join(root, "afplay"), `#!/bin/sh\nprintf '%s\\n' "$(cat "$1")" >> "${log}"\n`);
  await chmod(path.join(root, "afplay"), 0o755);
  const downloads = [];
  const player = await createTerminalPreviewPlayer({
    platform: "darwin",
    environment: { PATH: root },
    temporaryRoot: root,
    fetchImpl: async (url) => { downloads.push(url); return new Response(`audio at ${new URL(url).pathname}`); },
  });
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", musicCatalog: scorpionsCatalog(), musicPreviewPlayer: player });
  t.after(() => app.close());
  const events = [];
  player.subscribe((event) => events.push(event));
  const { faux, runtime } = runtimeFor(app);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_music_preview", { tracks: [{ title: "Wind of Change", artist: "Scorpions" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Here's a 30-second preview. The full song is on Apple Music.")]),
  ]);
  await runtime.prompt("Play Wind of Change by Scorpions");
  for (const deadline = performance.now() + 5000; events.at(-1)?.type !== "stopped";) {
    assert.ok(performance.now() < deadline, "the preview did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(events[0].tracks, [{ title: "Wind of Change", artist_credit: "Scorpions", catalog_url: "https://music.apple.com/us/album/crazy-world/2" }]);
  assert.deepEqual(downloads, ["https://audio-ssl.itunes.apple.com/itunes-assets/original.m4a"]);
  assert.equal(await readFile(log, "utf8"), "audio at /itunes-assets/original.m4a\n");
});

test("without Spotify, a request to play a song becomes a preview in the listener's player", async () => {
  const played = [];
  const { faux, runtime } = runtimeFor(application({ played }));
  faux.setResponses([
    (context) => {
      const prompt = systemText(context);
      assert.match(prompt, /Spotify is not connected in this session/u);
      assert.match(prompt, /moondog_music_preview/u);
      return fauxAssistantMessage([fauxToolCall("moondog_music_preview", { tracks: [{ title: "Wind of Change", artist: "Scorpions" }, { title: "Not A Real Song", artist: "Scorpions" }] })], { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_music_preview");
      assert.equal(result.isError, false, result.content[0].text);
      const value = JSON.parse(result.content[0].text);
      assert.deepEqual(value.playing_in_order, [{ title: "Wind of Change", artist_credit: "Scorpions" }]);
      assert.equal(value.plays, "30_second_previews");
      assert.deepEqual(value.not_found, [{ title: "Not A Real Song", artist: "Scorpions" }]);
      assert.doesNotMatch(result.content[0].text, /audio-ssl/u, "the audio address stays with the host");
      return fauxAssistantMessage([fauxText("Here's a 30-second preview. The full song is on Apple Music.")]);
    },
  ]);
  assert.match((await runtime.prompt("I want to listen to Scorpions' Wind of Change")).text, /30-second preview/u);
  assert.deepEqual(played.map(({ tracks }) => tracks.map((track) => track.preview_url)), [["https://audio-ssl.itunes.apple.com/itunes-assets/original.m4a"]]);
});

test("songs by artists the listener named are left out of the queue", async () => {
  const played = [];
  const { faux, runtime } = runtimeFor(application({ played }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_music_preview", {
      tracks: [{ title: "Wind of Change", artist: "Scorpions" }, { title: "Glory Box", artist: "Portishead" }],
      exclude_artists: ["Portishead"],
    })], { stopReason: "toolUse" }),
    (context) => {
      const value = JSON.parse(context.messages.find((message) => message.role === "toolResult").content[0].text);
      assert.deepEqual(value.playing_in_order.map((song) => song.title), ["Wind of Change"]);
      assert.equal(value.left_out_by_excluded_artist, 1);
      return fauxAssistantMessage([fauxText("Wind of Change is playing.")]);
    },
  ]);
  await runtime.prompt("I love Portishead");
  assert.deepEqual(played[0].tracks.map((track) => track.title), ["Wind of Change"]);
});

test("an album request queues the album's previews in order", async () => {
  const played = [];
  const { faux, runtime } = runtimeFor(application({ played }));
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_music_preview", { album: { title: "Crazy World", artist: "Scorpions" } })], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_music_preview");
      assert.equal(result.isError, false, result.content[0].text);
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.album.title, "Crazy World");
      assert.equal(value.playing_in_order.length, 2);
      assert.doesNotMatch(result.content[0].text, /mzstatic|audio-ssl/u);
      return fauxAssistantMessage([fauxText("Crazy World, from the top.")]);
    },
  ]);
  await runtime.prompt("Play the album Crazy World by Scorpions");
  assert.equal(played.length, 1);
  assert.deepEqual(played[0].tracks.map((track) => track.title), ["Tease Me Please Me", "Wind of Change"]);
  assert.equal(played[0].options.album.title, "Crazy World");
});

test("with Spotify connected, the prompt keeps its Spotify playback rules", async () => {
  const { faux, runtime } = runtimeFor(application({ spotify: true }));
  faux.setResponses([(context) => {
    assert.doesNotMatch(systemText(context), /Spotify is not connected in this session/u);
    return fauxAssistantMessage([fauxText("Ready.")]);
  }]);
  await runtime.prompt("Hi");
});

test("the chosen music service decides which tools play music, and the rebuilt runtime says so", () => {
  const playback = ["moondog_spotify_player_control", "moondog_spotify_queue_add", "moondog_spotify_queue_batch", "moondog_spotify_device_transfer"];
  const reads = ["moondog_spotify_search", "moondog_spotify_now_playing", "moondog_spotify_queue_status", "moondog_spotify_devices"];
  const app = application({ spotify: true });
  const offered = () => runtimeFor(app).runtime.agent.state;
  let state = offered();
  let names = state.tools.map((tool) => tool.name);
  for (const name of [...playback, ...reads]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("moondog_music_preview"));
  assert.doesNotMatch(state.systemPrompt, /Session availability/u);

  app.setPlaybackService("apple_music");
  assert.equal(app.spotifyReady(), true);
  assert.equal(app.spotifyPlaybackReady(), false);
  assert.equal(app.musicPreviewReady(), true);
  state = offered();
  names = state.tools.map((tool) => tool.name);
  for (const name of playback) assert.ok(!names.includes(name), name);
  for (const name of [...reads, "moondog_music_preview"]) assert.ok(names.includes(name), name);
  assert.match(state.systemPrompt, /The listener chose Apple Music to play music/u);
  assert.doesNotMatch(state.systemPrompt, /Spotify is not connected in this session/u);
  const blocked = app.toolsStatus().capabilities.filter((capability) => capability.blocked_by === "playback_service_not_spotify").map((capability) => capability.id);
  assert.deepEqual(blocked.sort(), ["spotify.device.transfer", "spotify.player.control", "spotify.queue.add", "spotify.queue.batch"]);

  // Without Spotify, Apple Music is the only way to play either way.
  const offline = application();
  offline.setPlaybackService("apple_music");
  assert.match(runtimeFor(offline).runtime.agent.state.systemPrompt, /Spotify is not connected in this session/u);
});

test("with Apple Music chosen, a queue request answered with previews is not sent on to Spotify's queue", async () => {
  const played = [];
  const app = application({ played, spotify: true });
  app.setPlaybackService("apple_music");
  const { faux, runtime } = runtimeFor(app);
  assert.ok(runtime.agent.state.tools.some((tool) => tool.name === "moondog_spotify_discover"), "Spotify reads stay");
  let continued = false;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_music_preview", { tracks: [{ title: "Wind of Change", artist: "Scorpions" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Here's a 30-second preview. The full song is on Apple Music.")]),
    () => { continued = true; return fauxAssistantMessage([fauxText("Queued on Spotify.")]); },
  ]);
  const result = await runtime.prompt("Queue three Scorpions songs");
  assert.equal(continued, false, "no host continuation asks for moondog_spotify_queue_batch");
  assert.match(result.text, /30-second preview/u);
  assert.equal(played.length, 1);
});

test("with Apple Music chosen, a queue request carries no Spotify queue budgets or playlist block", () => {
  const app = application({ spotify: true });
  app.beginPrompt({ text: "Queue three Scorpions songs" });
  assert.equal(app.spotifyPlaybackContextStatus().queue_request.requested, 3);
  assert.throws(() => app.requireSpotifyPlaylistCreationFlow(), { code: "spotify_queue_not_playlist" });
  app.endPrompt();
  app.setPlaybackService("apple_music");
  app.beginPrompt({ text: "Queue three Scorpions songs" });
  assert.equal(app.spotifyPlaybackContextStatus().queue_request, null);
  assert.doesNotThrow(() => app.requireSpotifyPlaylistCreationFlow());
  app.endPrompt();
});

test("switching to Apple Music preserves the playback reply after a catalog lookup for missing songs", async (t) => {
  const played = [];
  const app = application({ played, spotify: true, wholeSongs: true, discovery: true });
  t.after(() => app.close());
  app.setPlaybackService("apple_music");
  const { faux, runtime } = runtimeFor(app);
  const reply = "Apple Music 正在放 Scorpions 的 Wind of Change。另一首没找到。";
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_music_preview", { tracks: [
      { title: "Wind of Change", artist: "Scorpions" },
      { title: "Not A Real Song", artist: "Scorpions" },
    ] })], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_music_preview");
      const value = JSON.parse(result.content[0].text);
      assert.equal(result.isError, false);
      assert.equal(value.plays, "whole_songs");
      assert.deepEqual(value.playing_in_order.map((track) => track.title), ["Wind of Change"]);
      assert.equal(value.not_found.length, 1);
      return fauxAssistantMessage([fauxToolCall("moondog_music_catalog_search", { queries: ["Scorpions"], limit: 2 })], { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_music_catalog_search");
      assert.equal(result.isError, false, result.content[0].text);
      assert.ok(JSON.parse(result.content[0].text).candidate_set_id, "the lookup must exercise the external-candidate guard");
      return fauxAssistantMessage([fauxText(reply)]);
    },
  ]);
  let shown = "";
  const tools = [];
  const result = await runtime.prompt("嗯，我换成 Apple Music。", {
    onTextDelta: (delta) => { shown += delta; },
    onTextReplace: (text) => { shown = text; },
    onToolStart: ({ capabilityId }) => tools.push(capabilityId),
  });
  assert.equal(result.text, reply);
  assert.equal(shown, reply);
  assert.equal(runtime.agent.state.messages.at(-1).content[0].text, reply, "the next turn must not inherit a false playlist failure");
  assert.deepEqual(tools, ["music.preview.play", "music.catalog.track_search"]);
  assert.equal(played.length, 1);
  assert.equal("playlist_plan" in result, false);
});

test("catalog lookups do not turn other playback outcomes into playlist failures", async (t) => {
  for (const [service, outcome] of [
    ["apple_music", "preview"], ["apple_music", "not_found"], ["apple_music", "failed"],
    ["netease", "playing"], ["netease", "queued"], ["netease", "none"], ["netease", "failed"],
  ]) {
    await t.test(`${service}: ${outcome}`, async (t) => {
      const played = [];
      const app = application({ played, discovery: true, neteasePlayer: {
        ready: () => true,
        play: async () => {
          if (outcome === "failed") throw new Error("Playback unavailable");
          return { mode: outcome, songs: outcome === "none" ? [] : [{ title: "Wind of Change", artists: ["Scorpions"], playable: true }] };
        },
      } });
      t.after(() => app.close());
      app.setPlaybackService(service);
      if (outcome === "failed") app.musicPreviewPlayer.play = async () => { throw new Error("Playback unavailable"); };
      const { faux, runtime } = runtimeFor(app);
      const tool = service === "apple_music" ? "moondog_music_preview" : "moondog_netease_play";
      const tracks = [{ title: outcome === "not_found" ? "Not A Real Song" : "Wind of Change", artist: "Scorpions" }];
      const reply = outcome === "failed" || outcome === "none" || outcome === "not_found"
        ? "这首没能播放。" : "已交给播放器。";
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("moondog_music_catalog_search", { queries: ["Scorpions"], limit: 2 })], { stopReason: "toolUse" }),
        (context) => {
          const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_music_catalog_search");
          assert.equal(result.isError, false, result.content[0].text);
          assert.ok(JSON.parse(result.content[0].text).candidate_set_id);
          return fauxAssistantMessage([fauxToolCall(tool, service === "apple_music" ? { tracks }
            : { songs: tracks, mode: outcome === "queued" ? "queue" : "play", user_intent: "听一首歌" })], { stopReason: "toolUse" });
        },
        (context) => {
          const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === tool);
          assert.equal(result.isError, outcome === "failed", result.content[0].text);
          return fauxAssistantMessage([fauxText(reply)]);
        },
      ]);
      assert.equal((await runtime.prompt("放首歌")).text, reply);
      assert.equal(played.length, service === "apple_music" && outcome === "preview" ? 1 : 0);
    });
  }
});

test("a catalog search alone, such as checking whether a song is there, keeps the model's reply", async () => {
  const app = application({ discovery: true });
  const { faux, runtime } = runtimeFor(app);
  const reply = "我又在 Apple Music 搜了一遍，这次的结果里没有刘森的《疯土》。";
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_music_catalog_search", { queries: ["Scorpions"], limit: 2 })], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_music_catalog_search");
      assert.ok(JSON.parse(result.content[0].text).candidate_set_id, "the lookup must exercise the external-candidate guard");
      return fauxAssistantMessage([fauxText(reply)]);
    },
  ]);
  try {
    const result = await runtime.prompt("apple music我搜了，明明是有的");
    assert.equal(result.text, reply);
    assert.equal(runtime.agent.state.messages.at(-1).content[0].text, reply);
  } finally {
    app.close();
  }
});

test("non-Spotify playback instructions use the selected service's verification, not a playlist gate", () => {
  for (const service of ["apple_music", "netease"]) {
    const app = application({ spotify: true, discovery: true, neteasePlayer: { ready: () => true } });
    try {
      app.setPlaybackService(service);
      const { systemPrompt, tools } = runtimeFor(app).runtime.agent.state;
      const availability = systemPrompt.slice(systemPrompt.indexOf("Session availability:"));
      assert.match(availability, /Playback verification belongs to the selected music service/u);
      assert.match(availability, /do not run another catalog search or playlist planner just to recheck a successful playback result/u);
      assert.match(availability, /service change continues the current listening request/u);
      const catalogSearch = tools.find((tool) => tool.name === "moondog_music_catalog_search");
      assert.ok(catalogSearch);
      assert.doesNotMatch(catalogSearch.description, /before returning any track list/u);
      assert.match(catalogSearch.description, /For a playlist plan/u);
    } finally { app.close(); }
  }
});

test("playing a song does not validate a separately requested playlist plan", async (t) => {
  const app = application({ discovery: true });
  t.after(() => app.close());
  const { faux, runtime } = runtimeFor(app);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_music_preview", { tracks: [{ title: "Wind of Change", artist: "Scorpions" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("moondog_playlist_plan", {
      intent: "Also draft a playlist",
      requested_track_count: 1,
      candidate_set_ids: ["unregistered-candidates"],
      track_refs: [{ track_ref_id: "unregistered-track", selection_reason: "An invented selection" }],
      ordering_notes: "An invented order",
    })], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_playlist_plan");
      assert.equal(result.isError, true);
      return fauxAssistantMessage([fauxText("Here's the playlist.")]);
    },
  ]);
  const result = await runtime.prompt("放首歌，再给我做个歌单方案");
  assert.match(result.text, /无法验证这次 playlist plan/u);
  assert.equal("playlist_plan" in result, false);
});

test("host notes reach the agent's instructions, and the terminal passes none", async () => {
  const withNotes = runtimeFor(new MoondogApplication({ agentHostNotes: ["This is Moondog's public demo on its website."] }));
  withNotes.faux.setResponses([(context) => {
    assert.match(systemText(context), /About this session:(?:\n|\\n)- This is Moondog.s public demo on its website\./u);
    return fauxAssistantMessage([fauxText("Hi.")]);
  }]);
  await withNotes.runtime.prompt("Hi");
  const plain = runtimeFor(new MoondogApplication({}));
  plain.faux.setResponses([(context) => {
    assert.doesNotMatch(systemText(context), /About this session:/u);
    return fauxAssistantMessage([fauxText("Hi.")]);
  }]);
  await plain.runtime.prompt("Hi");
});
