// The window room's side of On Air, against a stand-in core: what it tells the window, the direct
// stop, and music started elsewhere ending the stream.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { runWindowRoom } from "../../app/window-room.mjs";

// The stand-in core takes "This Mac" for this Mac's name.
const THIS_MAC = { name: "This Mac", type: "Computer" };

const tick = async () => { for (let step = 0; step < 8; step += 1) await new Promise((resolve) => { setImmediate(resolve); }); };

function fakeStream() {
  let view = null;
  const listeners = new Set();
  const stops = [];
  const emit = (ended = null) => { for (const listener of [...listeners]) listener({ view: view && { ...view }, ended }); };
  return {
    stops,
    listeners,
    set(phase) { view = phase ? { phase, started_at: "2026-11-01T22:00:00.000Z", ends_at: "2026-11-01T23:00:00.000Z", tracks_made: 1 } : null; emit(); },
    view: () => view,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    stop(reason) { stops.push(reason); if (!view) return null; view = null; emit(reason); return { tracks_made: 1 }; },
  };
}

function base(extra = {}) {
  const stream = fakeStream();
  const app = {
    locale: "en", playbackService: "spotify", sessionId: "A",
    ensureMemorySession() { return { session_id: this.sessionId }; },
    startNewSession() {}, listSavedSessions() { return []; }, listConversationFolders() { return []; }, currentConversationTurns() { return []; },
    spotifyReady() { return false; }, spotifyStatus() { return { state: "unavailable" }; }, memoryStatus() { return { state: "unavailable" }; },
    spotifyOnThisMac(device) { return device?.type === "Computer" && device?.name === THIS_MAC.name; },
    atmosphereStream: stream,
    streamView() { return stream.view(); },
    subscribeStream(listener) { return stream.subscribe(listener); },
    stopped: [],
    stopStream() { this.stopped.push("asked"); const done = stream.stop("asked"); return done ? { state: "stopped", tracks_made: 1 } : { state: "not_running" }; },
    playerStops: 0,
    musicPreviewPlayer: { stop: () => { app.playerStops += 1; } },
    ...extra,
  };
  return { app, stream };
}

async function open(app) {
  const messages = [];
  let listener = null;
  const port = { on(_type, fn) { listener = fn; }, start() {} };
  const quit = new AbortController();
  const room = runWindowRoom({ application: app, runtime: { publicStatus: () => ({ state: "configured", provider: "p", model: "m", effort_levels: [] }), reset() {}, restoreSession() {}, prompt: async () => ({ status: "ok", text: "" }) } },
    { port, send: (message) => messages.push(message), quit: quit.signal, focus: new EventTarget() });
  await tick();
  return { messages, post: (data) => listener({ data }), stop: async () => { quit.abort(); await room; } };
}

test("status and ready carry onAir, and each change reaches the window; the end reads the players again", async () => {
  const { app, stream } = base();
  stream.set("playing");
  const reads = { player: 0 };
  app.spotifyReady = () => true;
  app.spotifyConnection = { service: { async currentPlayer() { reads.player += 1; return { state: "unavailable" }; }, async queue() { return { queue: [] }; } } };
  const room = await open(app);
  try {
    const ready = room.messages.find((message) => message.type === "ready");
    assert.deepEqual(ready.onAir, { phase: "playing", startedAt: "2026-11-01T22:00:00.000Z", endsAt: "2026-11-01T23:00:00.000Z", tracks: 1 });
    stream.set("waiting");
    const before = reads.player;
    stream.set("making");
    await tick();
    assert.ok(reads.player > before, "leaving the dry gap reads the players again");
    const onAir = room.messages.filter((message) => message.type === "on-air");
    assert.deepEqual(onAir.map((message) => message.onAir?.phase ?? null), ["waiting", "making"]);
    const atEnd = reads.player;
    await room.post({ type: "on-air-stop" });
    await tick();
    assert.deepEqual(app.stopped, ["asked"]);
    const last = room.messages.filter((message) => message.type === "on-air").at(-1);
    assert.deepEqual([last.onAir, last.ended], [null, "asked"]);
    assert.ok(reads.player > atEnd, "the end reads the players again");
  } finally {
    await room.stop();
  }
  assert.equal(stream.listeners.size, 0, "closing the room unsubscribes");
});

test("music started in the Music app ends a stream past starting, but not from a read that began before the stream's last change", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let state = "paused";
  let hold = null;
  const { app, stream } = base({ playbackService: "apple_music" });
  app.musicApp = {
    available: true,
    async nowPlaying() { const answer = { state, song: { id: "1", title: "Here", artists: ["M"] }, position_ms: 0, shuffle: true, repeat: "off", playlist: null };
      if (hold) { const gate = hold; hold = null; await gate.promise; } return answer; },
    async cover() { return null; },
  };
  const room = await open(app);
  try {
    await room.post({ type: "visible", visible: true });
    await tick();
    stream.set("making");
    // A read that began before a change, and ends after it, saying the Music app plays.
    state = "playing";
    hold = Promise.withResolvers();
    const gate = hold;
    mock.timers.tick(5_000);
    await tick();
    mock.timers.tick(10);
    stream.set("playing");
    gate.resolve();
    await tick();
    assert.deepEqual(stream.stops, [], "a stale read leaves the stream alone");
    assert.equal(app.playerStops, 0);
    // The next read began after the change, and counts.
    mock.timers.tick(5_000);
    await tick();
    assert.deepEqual(stream.stops, ["other_music"]);
    assert.equal(app.playerStops, 1);
  } finally {
    mock.timers.reset();
    await room.stop();
  }
});

test("while starting, the music before the stream plays on; without a stream, only the Music app stops Moondog's player", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let spotifyPlaying = false;
  const { app, stream } = base();
  app.spotifyReady = () => true;
  app.spotifyConnection = { service: {
    async currentPlayer() { return { state: "available", is_playing: spotifyPlaying, progress_ms: 0, device: THIS_MAC,
      item: { name: "S", uri: "spotify:track:s", artists: ["A"], duration_ms: 200_000 } }; },
    async queue() { return { queue: [] }; },
  } };
  const room = await open(app);
  try {
    stream.set("starting");
    spotifyPlaying = true;
    mock.timers.tick(10);
    await room.post({ type: "visible", visible: true });
    await tick();
    assert.deepEqual(stream.stops, [], "Spotify playing while the first track is made is the music before the stream");
    assert.equal(app.playerStops, 0, "without the stream past starting, Spotify leaves Moondog's player alone");
  } finally {
    mock.timers.reset();
    await room.stop();
  }
});

test("Spotify starting on this Mac ends a stream past starting; on a phone it doesn't", async () => {
  for (const [device, ends] of [[THIS_MAC, true], [{ name: "Pixel 9", type: "Smartphone" }, false]]) {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    let spotifyPlaying = false;
    const { app, stream } = base();
    app.spotifyReady = () => true;
    app.spotifyConnection = { service: {
      async currentPlayer() { return { state: "available", is_playing: spotifyPlaying, progress_ms: 0, device, item: { name: "S", uri: "spotify:track:s", artists: ["A"], duration_ms: 200_000 } }; },
      async queue() { return { queue: [] }; },
    } };
    const room = await open(app);
    try {
      stream.set("playing");
      // Past the time Spotify takes to report the stream's own pause.
      mock.timers.tick(2_100);
      spotifyPlaying = true;
      await room.post({ type: "visible", visible: true });
      await tick();
      assert.deepEqual(stream.stops, ends ? ["other_music"] : [], device.name);
    } finally {
      mock.timers.reset();
      await room.stop();
    }
  }
});

test("NetEase starting ends a stream past starting", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let playing = false;
  const { app, stream } = base({ playbackService: "netease" });
  app.neteaseReady = () => true;
  app.neteasePlayer = { status: () => ({ state: "ready" }), async nowPlaying() { return { state: playing ? "playing" : "paused", song: { title: "N", artists: ["X"], album: null, image: null, duration_ms: 1 }, position_ms: 0, next: [] }; } };
  const room = await open(app);
  try {
    await room.post({ type: "visible", visible: true });
    await tick();
    stream.set("making");
    mock.timers.tick(10);
    playing = true;
    mock.timers.tick(5_000);
    await tick();
    assert.deepEqual(stream.stops, ["other_music"]);
  } finally {
    mock.timers.reset();
    await room.stop();
  }
});

test("moving playing Spotify onto this Mac quiets the other players first; onto a phone, it doesn't", async () => {
  for (const [name, type, quiets] of [[THIS_MAC.name, "Computer", true], ["Pixel 9", "Smartphone", false]]) {
    const order = [];
    const { app } = base();
    app.spotifyReady = () => true;
    app.quietOtherPlayers = async (starting) => { order.push(`quiet:${starting}`); };
    app.spotifyConnection = { service: {
      async currentPlayer() { return { state: "available", is_playing: true, progress_ms: 0, device: { name: "Elsewhere", type: "Speaker" }, item: { name: "S", uri: "spotify:track:s", artists: ["A"], duration_ms: 200_000 } }; },
      async queue() { return { queue: [] }; },
      async devices() { return { devices: [{ id: "d0", name, type, is_active: false }] }; },
      async transfer() { order.push("transfer"); },
    } };
    const room = await open(app);
    try {
      await room.post({ type: "devices" });
      await room.post({ type: "transfer", ref: "0" });
      assert.deepEqual(order, quiets ? ["quiet:spotify", "transfer"] : ["transfer"], name);
    } finally {
      await room.stop();
    }
  }
});

test("a late Spotify report of the music the first track paused doesn't end the stream", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { app, stream } = base();
  app.spotifyReady = () => true;
  app.spotifyConnection = { service: {
    async currentPlayer() { return { state: "available", is_playing: true, progress_ms: 0, device: THIS_MAC, item: { name: "S", uri: "spotify:track:s", artists: ["A"], duration_ms: 200_000 } }; },
    async queue() { return { queue: [] }; },
  } };
  const room = await open(app);
  try {
    stream.set("starting");
    // The first track plays and pauses Spotify, which still reports playing a moment later.
    stream.set("making");
    mock.timers.tick(100);
    await room.post({ type: "visible", visible: true });
    await tick();
    assert.deepEqual(stream.stops, []);
  } finally {
    mock.timers.reset();
    await room.stop();
  }
});
