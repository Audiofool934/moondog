import assert from "node:assert/strict";
import test from "node:test";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";

// Spotify drops a queue when its device goes idle. Songs Moondog queued then were never heard,
// so a new request may queue them again; while Spotify still plays, they stay held back.
function spotifyApplication(t, player) {
  const writes = [];
  const songs = [["a", "Night Ferry", ["Mira Vale"]], ["b", "Harbor Lights", ["The Lanterns"]]];
  const service = {
    searchTracks: async () => ({ provider: "spotify", items: songs.map(([id, name, artists]) => ({ uri: `spotify:track:${id}`, id, name, artists, album: `${name} Record` })) }),
    resume: async (parameters) => { writes.push(["resume", parameters]); return { provider: "spotify", ok: true, effect: "write_external", action: "playback.resume", state: "accepted" }; },
    queueTarget: async () => ({ deviceId: "fictionalDevice", active: true }),
    addToQueue: async (parameters) => { writes.push(["queue", parameters.uri]); return { ok: true }; },
    queue: async () => ({ currently_playing: player.current?.item ? { uri: "spotify:track:playing" } : null, queue: [] }),
    currentPlayer: async () => player.current,
  };
  const application = new MoondogApplication({ importsRoot: "/tmp/fictional-dropped-no-imports",
    domainServices: { recordMoondogSuggestions: () => {} },
    spotifyConnection: { service, ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }) } });
  t.after(() => application.close());
  const queue = async (text) => {
    application.beginPrompt({ text });
    const { items } = await application.spotifySearchTracks({ query: "fictional" });
    const receipt = await application.spotifyQueueBatch({ itemRefs: items.map((item) => item.item_ref_id) });
    application.endPrompt();
    return receipt;
  };
  return { queue, writes };
}

const playing = { state: "available", is_playing: true, item: { type: "track", uri: "spotify:track:playing", name: "Now", artists: ["X"] } };
const idle = { state: "available", is_playing: false, item: null };

test("a queue Spotify dropped can be queued again", async (t) => {
  const player = { current: playing };
  const { queue } = spotifyApplication(t, player);
  assert.equal((await queue("queue two songs")).queued_count, 2);
  // Still playing: Spotify's queue view leaves them out, but they stay held back.
  const again = await queue("queue two songs");
  assert.equal(again.queued_count, 0);
  assert.equal(again.skipped_duplicate_count, 2);
  // The device went idle and the queue is empty: they were never heard.
  player.current = idle;
  assert.equal((await queue("you put them where? queue two songs")).queued_count, 2);
});

test("a player that could not be read keeps the songs held back", async (t) => {
  const player = { current: playing };
  const { queue } = spotifyApplication(t, player);
  assert.equal((await queue("queue two songs")).queued_count, 2);
  player.current = null;
  assert.equal((await queue("queue two songs")).skipped_duplicate_count, 2);
});
