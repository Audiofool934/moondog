import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxProvider } from "@earendil-works/pi-ai";

import { listAgentCapabilityDescriptors } from "../../src/core/capability-catalog.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

test("the agent reads what plays everywhere, with the playlist and its songs bounded", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const descriptors = listAgentCapabilityDescriptors({});
  const runtime = new PiAgentRuntime({
    application: {
      memoryStatus: () => ({ state: "not_persistent" }),
      agentCapabilityDescriptors: () => descriptors,
      async listeningNow() {
        return {
          active: "apple_music",
          sources: [
            { service: "apple_music", state: "playing", player: "Music app on this Mac", song: { title: "Here", artists: ["M"], album: null, duration_ms: 61_000 },
              position_ms: 1_400, shuffle: false, repeat: "off",
              from: { kind: "playlist", name: "Evening", tracks_total: 80, position: 7, first_position: 2,
                tracks: Array.from({ length: 60 }, (_, index) => ({ title: `Song ${index}`, artists: ["M"] })) } },
            { service: "spotify", state: "not_allowed", reason: "Spotify is idle." },
          ],
        };
      },
    },
    models,
    model: faux.getModel(),
    provider: "faux",
    modelId: "faux-1",
  });
  const tool = runtime.agent.state.tools.find((entry) => entry.name === "moondog_listening_now");
  assert.ok(tool, "the listening tool should be built for the agent");
  const value = JSON.parse((await tool.execute("call-1", {}, new AbortController().signal)).content[0].text);
  assert.equal(value.active, "apple_music");
  const [music, spotify] = value.sources;
  assert.deepEqual(music.song, { title: "Here", artists: ["M"], duration_seconds: 61 });
  assert.equal(music.position_seconds, 1);
  assert.equal(music.from.name, "Evening");
  assert.equal(music.from.playing_position, 7);
  assert.equal(music.from.tracks.length, 50);
  assert.equal(music.from.tracks[0].position, 2);
  assert.deepEqual(spotify, { service: "spotify", state: "not_allowed", reason: "Spotify is idle." });
});
