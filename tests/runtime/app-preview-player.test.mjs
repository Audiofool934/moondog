import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createWindowPreviewPlayer } from "../../app/preview-player.mjs";

const tracks = [{
  title: "Midnight Lines", artist_credit: "Mara Vale",
  preview_url: "https://audio-ssl.itunes.apple.com/fixture.m4a",
  catalog_url: "https://music.apple.com/us/album/fictional/1?i=2",
}];

function fixture(context) {
  const port = new EventEmitter();
  const sent = [];
  port.postMessage = (message) => sent.push(message);
  const player = createWindowPreviewPlayer(port);
  const events = [];
  player.subscribe((event) => events.push(event));
  const receive = (id, event) => port.emit("message", { data: { type: "preview-event", id, event } });
  context.after(() => player.close());
  return { port, sent, player, events, receive };
}

test("desktop previews share controls and playback events with the room", (context) => {
  const { player, sent, receive, events, port } = fixture(context);
  assert.equal(player.skip(), false);
  assert.equal(player.stop(), false);
  player.play(tracks);
  const id = sent[0].id;
  assert.deepEqual(sent[0], { type: "preview", id, tracks: [{ ...tracks[0], artwork_url: undefined }], album: null });
  assert.equal(player.skip(), true, "controls also work while the window is receiving a new queue");
  assert.deepEqual(sent.at(-1), { type: "preview-control", action: "skip", id });
  const song = { track: tracks[0], position: 1, count: 1 };
  receive(id, { type: "queue", tracks, album: null });
  receive(id, { type: "loading", ...song });
  receive(id, { type: "playing", ...song });
  receive(id, { type: "paused", ...song });
  assert.equal(player.stop(), true, "a paused queue can be stopped");
  assert.deepEqual(sent.at(-1), { type: "preview-control", action: "stop", id });
  assert.deepEqual(events.map(({ type }) => type), ["queue", "loading", "playing", "paused", "stopped"]);
  receive(id, { type: "playing", ...song });
  assert.equal(events.at(-1).type, "stopped", "an event already in transit cannot restart the stopped queue");
  assert.equal(player.skip(), false);
  player.close();
  assert.equal(port.listenerCount("message"), 0);
  player.play(tracks);
  assert.equal(sent.length, 3, "a closed player sends nothing");
});

test("replacing a queue ignores old events and preserves the current queue on invalid input", (context) => {
  const { player, sent, receive, events } = fixture(context);
  player.play(tracks);
  const first = sent.at(-1).id;
  player.play(tracks, { album: { title: "Night Walk", artist_credit: "Mara Vale", catalog_url: tracks[0].catalog_url } });
  const second = sent.at(-1).id;
  assert.notEqual(first, second);
  receive(first, { type: "stopped" });
  receive(first, { type: "failed", position: 1 });
  assert.equal(events.length, 0);
  player.play([{ ...tracks[0], preview_url: "file:///fixture.m4a" }]);
  assert.equal(sent.length, 2);
  receive(second, { type: "failed", position: 1 });
  receive(second, { type: "stopped" });
  assert.deepEqual(events.map(({ type }) => type), ["failed", "stopped"]);
  assert.equal(player.skip(), false);
  receive(second, { type: "playing", track: tracks[0], position: 1, count: 1 });
  assert.equal(player.skip(), true, "replaying from the window makes the queue controllable again");
  assert.equal(sent.at(-1).id, second);
});
