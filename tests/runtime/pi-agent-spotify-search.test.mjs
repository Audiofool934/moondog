import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxProvider } from "@earendil-works/pi-ai";

import { listAgentCapabilityDescriptors } from "../../src/core/capability-catalog.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";
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

function searchTool(application) {
  const descriptors = listAgentCapabilityDescriptors(spotifyReady);
  const descriptor = descriptors.find(
    (entry) => entry.capability_id === "spotify.search",
  );
  assert.ok(descriptor, "spotify.search capability should be registered");
  const runtime = runtimeFor({
    memoryStatus: () => ({ state: "not_persistent" }),
    agentCapabilityDescriptors: () => descriptors,
    ...application,
  });
  const tool = runtime.agent.state.tools.find(
    (entry) => entry.name === descriptor.tool_name,
  );
  assert.ok(tool, "spotify.search tool should be built for the agent");
  return tool;
}

function fakeClient(results) {
  return {
    async searchTracks({ query, limit }) {
      assert.ok(query.length > 0);
      assert.ok(limit >= 1 && limit <= 10);
      return {
        provider: "spotify",
        items: results,
        truncated: false,
      };
    },
  };
}

test("spotify.search projects bounded track results", async () => {
  const service = createSpotifyService({
    client: fakeClient([
      {
        uri: "spotify:track:aaa",
        id: "aaa",
        name: "Weightless Part 1",
        artists: ["Marconi Union"],
        album: "Weightless",
        duration_ms: 360000,
        popularity: 42,
        explicit: false,
      },
      {
        uri: "spotify:track:bbb",
        id: "bbb",
        name: "Weightless",
        artists: ["Natasha Barrett"],
        duration_ms: 180000,
      },
    ]),
  });
  const tool = searchTool({
    spotifySearchTracks: (input) => service.searchTracks(input),
  });

  assert.equal(tool.name, "moondog_spotify_search");
  assert.equal(tool.executionMode, "parallel");

  const result = await tool.execute(
    "call-1",
    { query: "Weightless", limit: 5 },
    undefined,
  );
  const details = result.details;
  assert.equal(details.provider, "spotify");
  assert.equal(details.items.length, 2);
  assert.equal(details.items[0].name, "Weightless Part 1");
  assert.deepEqual(details.items[0].artists, ["Marconi Union"]);
  assert.equal(details.items[0].album, "Weightless");
  assert.equal(details.items[0].uri, "spotify:track:aaa");
  assert.equal(details.items[0].popularity, 42);
  assert.equal(details.truncated, false);
});

test("spotify.search rejects an empty query", async () => {
  const service = createSpotifyService({
    client: fakeClient([]),
  });
  const tool = searchTool({
    spotifySearchTracks: (input) => service.searchTracks(input),
  });

  await assert.rejects(
    tool.execute("call-2", { query: "   " }, undefined),
    /invalid_search_query/,
  );
});

test("spotify.search rejects a malformed search payload", async () => {
  const tool = searchTool({
    async spotifySearchTracks() {
      return { provider: "other" };
    },
  });

  await assert.rejects(
    tool.execute("call-3", { query: "Weightless" }, undefined),
    /domain_result_invalid:spotify_search/,
  );
});
