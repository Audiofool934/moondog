import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createNeteasePlayer } from "../../src/integrations/netease/ncm-cli-player.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
import { parseNextSongs } from "../../src/runtime/pi/next-songs.mjs";

test("the host's picks are read from the first JSON array in the reply, each once", () => {
  assert.deepEqual(parseNextSongs("Here you go:\n```json\n[{\"title\": \"稻香\", \"artist\": \"Jay\"}, {\"title\": \"稻香\", \"artist\": \"Jay\"}, {\"title\": \"\", \"artist\": \"X\"}]\n```"),
    [{ title: "稻香", artist: "Jay" }]);
  assert.deepEqual(parseNextSongs("no list here"), []);
  assert.deepEqual(parseNextSongs("[not json]"), []);
});

// A stand-in ncm-cli that is signed in, finds one playable 稻香, and plays at once.
function netease() {
  const records = [{ id: "1D71F87C34BD42F6F13574EB6AFA8516", originalId: 3441643322, name: "稻香", artists: [{ name: "Jay" }], album: { name: "稻香" },
    duration: 198_000, coverImgUrl: "https://p1.music.126.net/cover.jpg", visible: true }];
  const run = async (args) => {
    if (args[0] === "login") return { success: true };
    if (args[0] === "search") return { code: 200, data: { records: args[3].includes("稻香") ? records : [] } };
    if (args[0] === "state") return { success: true, state: { status: "playing", title: "稻香 - Jay", position: 2, duration: 198 } };
    return { success: true };
  };
  return createNeteasePlayer({ run, wait: async () => {} });
}

test("when Up next runs low on NetEase, the host's picks found there are offered, and one queues with a click", async () => {
  const player = netease();
  await player.check();
  await player.play({ items: [{ title: "稻香", artist: "Jay" }] });
  const app = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source", neteasePlayer: player, playbackService: "netease" });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application: app, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  faux.setResponses([(context) => {
    const asked = JSON.stringify(context.messages);
    assert.match(asked, /<playing>晴天 - 周杰伦<\/playing>/u);
    assert.match(asked, /<offered_before>\\n七里香 - 周杰伦/u);
    return fauxAssistantMessage([fauxText('[{"title": "晴天", "artist": "周杰伦"}, {"title": "Nowhere Song", "artist": "Nobody"}, {"title": "稻香", "artist": "Jay"}]')]);
  }]);

  const picks = await runtime.proposeNextSongs({ playing: { title: "晴天", artists: ["周杰伦"] }, next: [], offered: [{ title: "七里香", artists: ["周杰伦"] }], where: "netease" });
  assert.deepEqual(picks.map(({ title, artists, image }) => ({ title, artists, image })), [{ title: "稻香", artists: ["Jay"], image: "https://p1.music.126.net/cover.jpg" }],
    "the song playing and a song NetEase doesn't have are left out");

  assert.deepEqual(await app.queueUpNextProposal(picks[0].ref), { state: "queued" });
  assert.deepEqual((await player.nowPlaying()).next.map((song) => song.title), ["稻香"]);
  assert.deepEqual(await app.queueUpNextProposal(picks[0].ref), { state: "gone" }, "a pick queues once");

  assert.deepEqual(await runtime.proposeNextSongs({ playing: { title: "晴天", artists: ["周杰伦"] }, where: "spotify" }), [], "only the chosen service is asked for");
});
