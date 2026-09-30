import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxProvider } from "@earendil-works/pi-ai";

import { listAgentCapabilityDescriptors } from "../../src/core/capability-catalog.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const spotifyReady = {
  domainServicesReady: true,
  spotifyReady: true,
};

function runtimeFor(application) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return new PiAgentRuntime({
    application,
    models,
    model: faux.getModel(),
    provider: "faux",
    modelId: "faux-1",
  });
}

function nowPlayingTool(application) {
  const descriptors = listAgentCapabilityDescriptors(spotifyReady);
  const descriptor = descriptors.find(
    (entry) => entry.capability_id === "spotify.player.now_playing",
  );
  assert.ok(descriptor, "spotify.player.now_playing should be registered");
  const runtime = runtimeFor({
    memoryStatus: () => ({ state: "not_persistent" }),
    agentCapabilityDescriptors: () => descriptors,
    ...application,
  });
  const tool = runtime.agent.state.tools.find(
    (entry) => entry.name === descriptor.tool_name,
  );
  assert.ok(tool, "spotify.player.now_playing tool should be built");
  return tool;
}

test("spotify.player.now_playing projects full track metadata", async () => {
  const tool = nowPlayingTool({
    async spotifyNowPlaying() {
      return {
        provider: "spotify",
        state: "available",
        is_playing: true,
        progress_ms: 90000,
        item: {
          type: "track",
          uri: "spotify:track:aaa",
          name: "Weightless Part 1",
          artists: ["Marconi Union"],
          album: "Weightless",
          duration_ms: 360000,
          explicit: false,
        },
        device: {
          id: "device-secret-id",
          name: "Audiofool's MacBook Pro",
          type: "Computer",
        },
      };
    },
  });

  assert.equal(tool.name, "moondog_spotify_now_playing");
  assert.equal(tool.executionMode, "parallel");

  const result = await tool.execute("call-1", {}, undefined);
  const details = result.details;
  assert.equal(details.provider, "spotify");
  assert.equal(details.state, "available");
  assert.equal(details.is_playing, true);
  assert.equal(details.progress_ms, 90000);
  assert.equal(details.item.name, "Weightless Part 1");
  assert.deepEqual(details.item.artists, ["Marconi Union"]);
  assert.equal(details.item.album, "Weightless");
  assert.equal(details.item.uri, "spotify:track:aaa");
  assert.equal(details.device.name, "Audiofool's MacBook Pro");
  assert.ok(
    !("id" in details.device),
    "device identifiers must not leak into the projection",
  );
});

test("spotify.player.now_playing reports inactive playback", async () => {
  const tool = nowPlayingTool({
    async spotifyNowPlaying() {
      return { provider: "spotify", state: "inactive" };
    },
  });

  const result = await tool.execute("call-2", {}, undefined);
  assert.deepEqual(result.details, {
    provider: "spotify",
    state: "inactive",
  });
});

test("spotify.player.now_playing rejects a malformed playback payload", async () => {
  const tool = nowPlayingTool({
    async spotifyNowPlaying() {
      return { provider: "other" };
    },
  });

  await assert.rejects(
    tool.execute("call-3", {}, undefined),
    /domain_result_invalid:spotify_playback/,
  );
});
