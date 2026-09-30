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

function queueStatusTool(application) {
  const descriptors = listAgentCapabilityDescriptors(spotifyReady);
  const descriptor = descriptors.find(
    (entry) => entry.capability_id === "spotify.queue.status",
  );
  assert.ok(descriptor, "spotify.queue.status capability should be registered");
  const runtime = runtimeFor({
    memoryStatus: () => ({ state: "not_persistent" }),
    agentCapabilityDescriptors: () => descriptors,
    ...application,
  });
  const tool = runtime.agent.state.tools.find(
    (entry) => entry.name === descriptor.tool_name,
  );
  assert.ok(tool, "spotify.queue.status tool should be built for the agent");
  return tool;
}

test("spotify.queue.status projects the queue with bounded track metadata", async () => {
  const tool = queueStatusTool({
    async spotifyQueueStatus() {
      return {
        provider: "spotify",
        currently_playing: {
          type: "track",
          uri: "spotify:track:aaa",
          name: "Weightless Part 1",
          artists: ["Marconi Union"],
          album: "Weightless",
          duration_ms: 360000,
        },
        queue: [
          {
            type: "track",
            uri: "spotify:track:bbb",
            name: "An Ending (Ascent)",
            artists: ["Brian Eno"],
            album: "Apollo",
            duration_ms: 256000,
          },
          {
            type: "track",
            uri: "spotify:track:ccc",
            name: "Halcyon",
            artists: ["Max Richter"],
            duration_ms: 180000,
          },
        ],
        truncated: false,
      };
    },
  });

  assert.equal(tool.name, "moondog_spotify_queue_status");
  assert.equal(tool.executionMode, "parallel");

  const result = await tool.execute("call-1", {}, undefined);
  const details = result.details;
  assert.equal(details.provider, "spotify");
  assert.equal(details.currently_playing.name, "Weightless Part 1");
  assert.deepEqual(details.currently_playing.artists, ["Marconi Union"]);
  assert.equal(details.queue.length, 2);
  assert.equal(details.queue[0].name, "An Ending (Ascent)");
  assert.equal(details.queue_count, 2);
  assert.equal(details.truncated, false);
});

test("spotify.queue.status bounds a long queue to ten items", async () => {
  const tool = queueStatusTool({
    async spotifyQueueStatus() {
      return {
        provider: "spotify",
        currently_playing: null,
        queue: Array.from({ length: 25 }, (_, index) => ({
          type: "track",
          uri: `spotify:track:${index}`,
          name: `Track ${index}`,
          artists: [`Artist ${index}`],
        })),
        truncated: true,
      };
    },
  });

  const result = await tool.execute("call-2", {}, undefined);
  assert.equal(result.details.queue.length, 10);
  assert.equal(result.details.queue_count, 25);
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.currently_playing, null);
});

test("spotify.queue.status rejects a malformed queue payload", async () => {
  const tool = queueStatusTool({
    async spotifyQueueStatus() {
      return { provider: "other" };
    },
  });

  await assert.rejects(
    tool.execute("call-3", {}, undefined),
    /domain_result_invalid:spotify_queue/,
  );
});
