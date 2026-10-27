import assert from "node:assert/strict";
import test from "node:test";

import { createPreviewPlayer } from "../../site/terminal/preview-player.mjs";

class Element {
  listeners = new Map();
  attributes = new Map();
  style = {};
  hidden = false;
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  fire(name, event = {}) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}

class Audio extends Element {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = 30;
  error = null;
  source = "";
  plans = [];
  played = [];
  loads = 0;
  set src(value) {
    this.source = value;
    this.currentTime = 0;
    this.ended = false;
    this.error = null;
  }
  get src() { return this.source; }
  play() {
    this.played.push(this.src);
    const plan = this.plans.shift();
    if (plan) return plan();
    this.paused = false;
    this.fire("play");
    this.fire("playing");
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire("pause");
  }
  removeAttribute(name) {
    super.removeAttribute(name);
    if (name === "src") this.src = "";
  }
  load() { this.loads += 1; }
  finish() { this.paused = true; this.ended = true; this.fire("ended"); }
}

function fixture(t) {
  const session = {
    handlers: new Map(), metadata: null, playbackState: "none", positionCleared: false,
    setActionHandler(name, handler) { this.handlers.set(name, handler); },
    setPositionState() { this.positionCleared = true; },
  };
  for (const [name, value] of Object.entries({ navigator: { mediaSession: session }, MediaMetadata: class {
    constructor(value) { Object.assign(this, value); }
  } })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  const nodes = new Map();
  const audio = new Audio();
  nodes.set("audio", audio);
  const root = {
    hidden: true,
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, new Element());
      return nodes.get(selector);
    },
  };
  const player = createPreviewPlayer(root);
  const events = [];
  const unsubscribe = player.subscribe((event) => events.push(event));
  t.after(() => player.stop());
  return { player, events, audio, session, root, unsubscribe, button: (name) => nodes.get(`[data-player-${name}]`) };
}

const song = (name, overrides = {}) => ({
  title: `Song ${name}`, artist_credit: "Fixture Artist",
  preview_url: `https://audio-ssl.itunes.apple.com/itunes-assets/${name}.m4a`,
  catalog_url: `https://music.apple.com/us/album/fixture/1?i=${name}`,
  artwork_url: "https://is1-ssl.mzstatic.com/image/cover/300x300bb.jpg",
  ...overrides,
});
const publicSong = (name) => {
  const { title, artist_credit, catalog_url } = song(name);
  return { title, artist_credit, catalog_url };
};
const summary = (events) => events.map(({ type, position, count, track }) => track
  ? `${type} ${position}/${count} ${track.title}` : type);
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const pending = () => {
  let reject;
  const promise = new Promise((_, fail) => { reject = fail; });
  return { promise, reject };
};

test("browser previews report the public queue, skip and stop through one set of controls", async (t) => {
  const { player, events, audio, session, root, button, unsubscribe } = fixture(t);
  assert.equal(player.skip(), false);
  assert.equal(player.stop(), false);
  const album = { title: "Fixture Album", artist_credit: "Fixture Artist", catalog_url: "https://music.apple.com/us/album/fixture/1" };
  assert.equal(player.play([song("one"), song("outside", { preview_url: "https://example.com/audio.m4a" }), song("two")], album), true);
  await settle();
  assert.deepEqual(events[0], { type: "queue", tracks: [publicSong("one"), publicSong("two")], album });
  assert.equal(root.hidden, false);
  assert.equal(session.metadata.title, "Song one");
  assert.equal(session.playbackState, "playing");
  assert.equal(button("toggle").attributes.get("aria-label"), "Pause");
  assert.equal(player.play([song("outside", { preview_url: "https://example.com/audio.m4a" })]), false);
  assert.equal(audio.src, song("one").preview_url, "an invalid replacement leaves the current queue playing");

  button("next").fire("click");
  await settle();
  assert.equal(audio.src, song("two").preview_url);
  assert.deepEqual(summary(events), ["queue", "loading 1/2 Song one", "playing 1/2 Song one", "loading 2/2 Song two", "playing 2/2 Song two"]);
  assert.equal(session.handlers.get("stop")(), true);
  assert.equal(events.at(-1).type, "stopped");
  assert.equal(audio.paused, true);
  assert.equal(audio.src, "");
  assert.equal(audio.loads, 1);
  assert.equal(root.hidden, true);
  assert.equal(session.metadata, null);
  assert.equal(session.playbackState, "none");
  assert.equal(session.positionCleared, true);
  assert.ok([...session.handlers.values()].every((handler) => handler === null));
  assert.equal(player.stop(), false);
  assert.equal(player.skip(), false);
  unsubscribe();
  player.play([song("three")]);
  assert.equal(events.at(-1).type, "stopped");
});

test("pause retains the queue, skip resumes at the next song and natural completion stops", async (t) => {
  const { player, events, audio, session, button, root } = fixture(t);
  player.play([song("one"), song("two")]);
  button("toggle").fire("click");
  await settle();
  assert.equal(events.at(-1).type, "paused");
  assert.deepEqual(events.at(-1).track, publicSong("one"));
  assert.equal(session.playbackState, "paused");
  assert.equal(button("toggle").attributes.get("aria-label"), "Play");
  assert.equal(player.skip(), true);
  await settle();
  assert.equal(audio.src, song("two").preview_url);
  assert.equal(events.at(-1).type, "playing");
  assert.equal(session.handlers.get("pause")(), true);
  assert.equal(events.at(-1).type, "paused");
  assert.equal(session.handlers.get("play")(), true);
  await settle();
  assert.equal(events.at(-1).type, "playing");
  audio.finish();
  assert.equal(events.at(-1).type, "stopped");
  assert.equal(root.hidden, true);
  assert.equal(player.skip(), false);
  assert.equal(player.stop(), false);
});

test("a failed preview is reported and passed over, including element errors", async (t) => {
  const { player, events, audio } = fixture(t);
  audio.plans.push(() => Promise.reject(new Error("No preview")));
  player.play([song("missing"), song("broken"), song("three")]);
  await settle();
  audio.error = { code: 3 };
  audio.fire("error");
  await settle();
  assert.deepEqual(summary(events), [
    "queue", "loading 1/3 Song missing", "failed 1/3 Song missing",
    "loading 2/3 Song broken", "playing 2/3 Song broken", "failed 2/3 Song broken",
    "loading 3/3 Song three", "playing 3/3 Song three",
  ]);
  audio.error = { code: 3 };
  audio.fire("error");
  assert.equal(events.at(-1).type, "stopped");
  assert.equal(player.stop(), false);
});

test("an old play rejection cannot change a skipped, stopped or replaced queue", async (t) => {
  for (const action of ["skip", "stop", "replace"]) {
    await t.test(action, async (t) => {
      const { player, events, audio } = fixture(t);
      const old = pending();
      audio.plans.push(() => old.promise);
      player.play([song("pending"), song("two")]);
      if (action === "replace") player.play([song("replacement")]);
      else assert.equal(player[action](), true);
      await settle();
      const before = structuredClone(events);
      old.reject(new Error("Old request failed"));
      await settle();
      assert.deepEqual(events, before);
      assert.equal(audio.src, action === "stop" ? "" : song(action === "replace" ? "replacement" : "two").preview_url);
    });
  }
});

test("an element error and its rejected play promise advance only once", async (t) => {
  const { player, events, audio } = fixture(t);
  const first = pending();
  audio.plans.push(() => first.promise);
  player.play([song("broken"), song("two"), song("three")]);
  audio.error = { code: 3 };
  audio.fire("error");
  first.reject(new Error("The same broken preview"));
  await settle();
  assert.equal(audio.src, song("two").preview_url);
  assert.equal(events.filter(({ type }) => type === "failed").length, 1);
  assert.equal(player.skip(), true);
  assert.equal(player.skip(), true);
  assert.equal(events.at(-1).type, "stopped");
  assert.equal(player.skip(), false);
});

test("autoplay refusal pauses the current preview until the listener presses Play", async (t) => {
  const { player, events, audio, button } = fixture(t);
  audio.plans.push(() => Promise.reject(Object.assign(new Error("Needs a gesture"), { name: "NotAllowedError" })));
  player.play([song("one"), song("two")]);
  await settle();
  assert.deepEqual(summary(events), ["queue", "loading 1/2 Song one", "paused 1/2 Song one"]);
  assert.equal(audio.src, song("one").preview_url);
  assert.equal(button("toggle").attributes.get("aria-label"), "Play");
  button("toggle").fire("click");
  await settle();
  assert.equal(events.at(-1).type, "playing");
  assert.deepEqual(events.at(-1).track, publicSong("one"));
  assert.equal(player.stop(), true);
});
