import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createWindowNeteasePlayer } from "../../app/netease-player.mjs";
import { createNeteaseAudio } from "../../app/renderer/netease-audio.mjs";

const tick = () => new Promise(setImmediate);
function fixture(t, { blocked = [], autoStart = true } = {}) {
  const sent = []; const resolved = [];
  const port = new EventEmitter();
  port.postMessage = (data) => {
    sent.push(data);
    if (autoStart && data.action === "play") setImmediate(() => port.emit("message", { data: { type: "netease-audio-event", token: data.token, state: "playing", positionMs: 0 } }));
  };
  const tracks = [1, 2, 3].map((id) => ({ id: String(id), title: `Song ${id}`, artists: ["Fictional artist"], durationMs: 10000, available: true }));
  const library = { status: async () => ({ state: "connected" }), playlist: async () => ({ tracks }), playback: async (id) => {
    resolved.push(id);
    if (blocked.includes(id)) throw Object.assign(new Error("Unavailable"), { code: "netease_unplayable" });
    return { url: `https://m8.music.126.net/${id}.mp3`, trial: id === "3" };
  } };
  const player = createWindowNeteasePlayer({ library, port, startTimeoutMs: 200 });
  t.after(() => player.close());
  const event = (state, extra = {}) => port.emit("message", { data: { type: "netease-audio-event", token: sent.findLast((item) => item.action === "play")?.token, state, ...extra } });
  return { player, port, sent, resolved, event };
}

test("signed-in NetEase plays a playlist without a CLI and resolves URLs only when needed", async (t) => {
  const { player, resolved, sent, event } = fixture(t);
  assert.equal((await player.check()).state, "ready");
  await player.playPlaylist("1001");
  assert.deepEqual(resolved, ["1"]);
  assert.equal((await player.nowPlaying()).state, "playing");
  event("paused", { positionMs: 1500 });
  assert.equal((await player.nowPlaying()).position_ms, 1500);
  await player.seek({ positionMs: 4000 });
  assert.equal(sent.at(-1).action, "seek");
  await player.next();
  assert.deepEqual(resolved, ["1", "2"]);
  await player.previous();
  assert.equal((await player.nowPlaying()).song.id, "1");
  await player.stop();
  assert.equal((await player.nowPlaying()).song, null);
});

test("playlist advancement skips unavailable songs but explicit unavailable clicks fail visibly", async (t) => {
  const { player, event, resolved } = fixture(t, { blocked: ["2"] });
  await player.playPlaylist("1001");
  event("ended");
  await tick(); await tick();
  assert.deepEqual(resolved, ["1", "2", "3"]);
  assert.equal((await player.nowPlaying()).song.trial, true);
  await assert.rejects(player.playPlaylist("1001", { trackId: "2" }), { code: "netease_unplayable" });
});

test("playback receipts wait for actual audio and ignore old queue events", async (t) => {
  const { player, port, sent, event } = fixture(t, { autoStart: false });
  let finished = false;
  const pending = player.playPlaylist("1001").then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  port.emit("message", { data: { type: "netease-audio-event", token: "old", state: "playing" } });
  await tick(); assert.equal(finished, false);
  event("playing"); await pending;
  assert.ok(sent.some((message) => message.action === "play"));
  assert.equal(JSON.stringify(sent).includes("MUSIC_U"), false);
});

test("failed audio is surfaced and a stopped player ignores late started events", async (t) => {
  const { player, event } = fixture(t, { autoStart: false });
  const pending = player.playPlaylist("1001", { trackId: "1" });
  await tick(); event("failed");
  await assert.rejects(pending, { code: "netease_audio_failed" });
  await player.stop(); event("playing");
  assert.equal((await player.nowPlaying()).state, "stopped");
});

test("renderer audio rejects non-NetEase URLs and discards replaced audio events", async () => {
  const sent = []; const instances = [];
  class FakeAudio extends EventTarget {
    constructor() { super(); this.currentTime = 0; this.duration = 10; instances.push(this); }
    async play() { this.dispatchEvent(new Event("playing")); }
    pause() { this.dispatchEvent(new Event("pause")); }
    load() {}
    removeAttribute() {}
  }
  const audio = createNeteaseAudio({ send: (message) => sent.push(message), AudioClass: FakeAudio });
  audio.receive({ type: "netease-audio", action: "play", token: "bad", url: "https://attacker.example/audio.mp3" });
  assert.equal(instances.length, 0);
  audio.receive({ type: "netease-audio", action: "play", token: "1", url: "https://m8.music.126.net/1.mp3" });
  audio.receive({ type: "netease-audio", action: "play", token: "2", url: "https://m8.music.126.net/2.mp3" });
  const count = sent.length; instances[0].dispatchEvent(new Event("ended"));
  assert.equal(sent.length, count);
  audio.stop();
});

function rendererFixture(t, start, options = {}) {
  const sent = []; const instances = [];
  class FakeAudio extends EventTarget {
    constructor() { super(); this.currentTime = 0; this.duration = 100; instances.push(this); }
    play() { return start(this, instances.length); }
    pause() { this.dispatchEvent(new Event("pause")); }
    load() {}
    removeAttribute() {}
  }
  const audio = createNeteaseAudio({ send: (message) => sent.push(message), AudioClass: FakeAudio, ...options });
  t.after(() => audio.stop());
  const play = (token = "1") => audio.receive({ type: "netease-audio", action: "play", token,
    url: "https://m804.music.126.net/authorized/song.mp3?signature=fictional" });
  return { audio, sent, instances, play };
}

test("renderer retries a refused NetEase CDN without changing the authorized path or signature", async (t) => {
  const { sent, instances, play } = rendererFixture(t, (audio, count) => {
    if (count === 1) { audio.dispatchEvent(new Event("error")); return Promise.reject(new Error("HTTP 403")); }
    audio.dispatchEvent(new Event("playing")); return Promise.resolve();
  });
  play(); await tick();
  assert.deepEqual(instances.map((audio) => audio.src), [
    "https://m804.music.126.net/authorized/song.mp3?signature=fictional",
    "https://m701.music.126.net/authorized/song.mp3?signature=fictional",
  ]);
  assert.deepEqual(sent.map((event) => event.state), ["playing"]);
  instances[0].dispatchEvent(new Event("error"));
  assert.equal(instances.length, 2);
});

test("renderer switches a stalled CDN before the core's playback deadline", async (t) => {
  const { sent, instances, play } = rendererFixture(t, (audio, count) => {
    if (count > 1) audio.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  }, { sourceTimeoutMs: 15 });
  play();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(instances.length, 2);
  assert.deepEqual(sent.map((event) => event.state), ["playing"]);
});

test("renderer preserves progress after CDN failure and reports failure only after exhausting nodes", async (t) => {
  const { sent, instances, play } = rendererFixture(t, (audio) => {
    audio.dispatchEvent(new Event("playing")); return Promise.resolve();
  });
  play(); instances[0].currentTime = 24;
  instances[0].dispatchEvent(new Event("error"));
  instances[1].dispatchEvent(new Event("loadedmetadata"));
  assert.equal(instances[1].currentTime, 24);
  instances[1].dispatchEvent(new Event("error"));
  instances[2].dispatchEvent(new Event("loadedmetadata"));
  assert.equal(instances[2].currentTime, 24);
  instances[2].dispatchEvent(new Event("error"));
  instances[2].dispatchEvent(new Event("error"));
  assert.equal(instances.length, 3);
  assert.equal(sent.filter((event) => event.state === "failed").length, 1);
});

test("stopping stalled audio cancels its CDN retry timer", async (t) => {
  const { audio, instances, sent, play } = rendererFixture(t, () => Promise.resolve(), { sourceTimeoutMs: 15 });
  play(); audio.stop();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(instances.length, 1);
  assert.equal(sent.length, 0);
});
