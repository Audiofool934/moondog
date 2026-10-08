import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

import { listAgentCapabilityDescriptors } from "../../src/core/capability-catalog.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createAppleMusicCatalog, createAppleMusicCatalogClient } from "../../src/integrations/apple-music/catalog.mjs";
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
  const fetchImpl = async () => new Response(JSON.stringify({
    results: [
      song(1, "Wind of Change (Re-Recorded)", "https://audio-ssl.itunes.apple.com/itunes-assets/rerecorded.m4a"),
      song(2, "Wind of Change", "https://audio-ssl.itunes.apple.com/itunes-assets/original.m4a"),
      song(3, "Wind of Change (Live)", "https://example.com/not-apple.m4a"),
    ],
  }), { headers: { "content-type": "application/json" } });
  return createAppleMusicCatalog({ client: createAppleMusicCatalogClient({ fetchImpl, now }), now });
}

function application({ played = [], spotify = false } = {}) {
  return new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    musicCatalog: scorpionsCatalog(),
    musicPreviewPlayer: { play: async (track) => { played.push(track); } },
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

test("the catalog finds the exact recording's preview, only from Apple's audio host", async () => {
  const result = await scorpionsCatalog().findPreview({ title: "Wind of Change", artist: "Scorpions" });
  assert.equal(result.state, "resolved");
  assert.equal(result.track.title, "Wind of Change");
  assert.equal(result.track.preview_url, "https://audio-ssl.itunes.apple.com/itunes-assets/original.m4a");
  const live = await scorpionsCatalog().findPreview({ title: "Wind of Change (Live)", artist: "Scorpions" });
  assert.equal(live.state, "not_found", "a preview from another host is dropped");
});

test("previews are offered only when the host can play them", () => {
  const ids = (options) => listAgentCapabilityDescriptors(options).map((descriptor) => descriptor.capability_id);
  assert.ok(!ids({ musicCatalogReady: true }).includes("music.preview.play"));
  assert.ok(ids({ musicCatalogReady: true, musicPreviewReady: true }).includes("music.preview.play"));
  assert.equal(new MoondogApplication({ musicCatalog: scorpionsCatalog() }).musicPreviewReady(), false);
});

test("without Spotify, a request to play a song becomes a preview in the listener's player", async () => {
  const played = [];
  const { faux, runtime } = runtimeFor(application({ played }));
  faux.setResponses([
    (context) => {
      const prompt = systemText(context);
      assert.match(prompt, /Spotify is not connected in this session/u);
      assert.match(prompt, /moondog_music_preview/u);
      return fauxAssistantMessage([fauxToolCall("moondog_music_preview", { title: "Wind of Change", artist: "Scorpions" })], { stopReason: "toolUse" });
    },
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "moondog_music_preview");
      assert.equal(result.isError, false, result.content[0].text);
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.played, true);
      assert.equal(value.track.apple_music_url, "https://music.apple.com/us/album/crazy-world/2");
      assert.doesNotMatch(result.content[0].text, /audio-ssl/u, "the audio address stays with the host");
      return fauxAssistantMessage([fauxText("Here's a 30-second preview. The full song is on Apple Music.")]);
    },
  ]);
  assert.match((await runtime.prompt("I want to listen to Scorpions' Wind of Change")).text, /30-second preview/u);
  assert.deepEqual(played.map((track) => track.preview_url), ["https://audio-ssl.itunes.apple.com/itunes-assets/original.m4a"]);
});

test("with Spotify connected, the prompt keeps its Spotify playback rules", async () => {
  const { faux, runtime } = runtimeFor(application({ spotify: true }));
  faux.setResponses([(context) => {
    assert.doesNotMatch(systemText(context), /Spotify is not connected in this session/u);
    return fauxAssistantMessage([fauxText("Ready.")]);
  }]);
  await runtime.prompt("Hi");
});
