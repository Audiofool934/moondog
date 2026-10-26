import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { runWindowRoom } from "../../app/window-room.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";

const tick = async () => {
  for (let step = 0; step < 6; step += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function application(id) {
  return {
    locale: "en",
    playbackService: "spotify",
    sessionId: id,
    ready: false,
    ensureMemorySession() { return { session_id: this.sessionId }; },
    startNewSession() {},
    resumeSession(next) { this.sessionId = next; },
    listSavedSessions() { return []; },
    listConversationFolders() { return []; },
    currentConversationTurns() { return []; },
    spotifyReady() { return this.ready === true; },
    spotifyStatus() { return { state: "unavailable" }; },
    memoryStatus() { return { state: "unavailable" }; },
    profileServicesReady() { return false; },
  };
}

function runtime(model = "m") {
  const prompts = [];
  let releaseHold = null;
  return {
    model,
    prompts,
    hold: false,
    publicStatus() {
      return { state: "configured", provider: "p", model: this.model, effort: null, effort_levels: [] };
    },
    reset() {},
    restoreSession() {},
    abort() { releaseHold?.({ status: "aborted", text: "", spotify_write_receipts: [] }); },
    prompt(text) {
      prompts.push(text);
      if (!this.hold) return Promise.resolve({ status: "ok", text: "ok", spotify_write_receipts: [] });
      return new Promise((resolve) => { releaseHold = resolve; });
    },
  };
}

async function openRoom(extras = {}) {
  const messages = [];
  let listener = null;
  const port = { on(_type, fn) { listener = fn; }, start() {} };
  const base = extras.application ?? application("A");
  const firstRuntime = extras.runtime ?? runtime();
  const quit = new AbortController();
  const focus = new EventTarget();
  if (extras.quitNow) quit.abort();
  const opened = [];
  const saved = [];
  const built = [];
  let releaseBuild = null;
  const room = runWindowRoom({
    application: base,
    runtime: firstRuntime,
    modelSettings: { async models() { return { models: [{ id: "opus" }, { id: "sonnet" }] }; } },
    openConversation: async ({ sessionId, reason }) => {
      const openedApplication = application(sessionId ?? `opened-${reason}`);
      const openedRuntime = runtime("opened");
      opened.push({ application: openedApplication, runtime: openedRuntime });
      return { application: openedApplication, runtime: openedRuntime, close() {} };
    },
    saveRuntimeSelection: async (selection) => { saved.push(selection); },
    rebuildRuntime: async (selection) => {
      built.push(selection?.model ?? null);
      if (extras.holdFirstBuild && built.length === 1) {
        const gate = deferred();
        releaseBuild = gate.resolve;
        await gate.promise;
      }
      return runtime(selection?.model ?? "rebuilt");
    },
    ...extras.services,
  }, {
    port,
    send: (message) => { messages.push(message); },
    quit: quit.signal,
    focus,
  });
  const post = (data) => listener({ data });
  if (!extras.quitNow) await tick();
  return {
    messages,
    post,
    // The app's window gaining focus, as main.mjs reports it to the core.
    focus: () => focus.dispatchEvent(new Event("focus")),
    opened,
    saved,
    built,
    releaseBuild: () => releaseBuild?.(),
    stop: async () => { quit.abort(); await room; },
    room,
  };
}

test("a quit that arrived while the core was starting still stops the room", async () => {
  const harness = await openRoom({ quitNow: true });
  await Promise.race([
    harness.room,
    new Promise((_resolve, reject) => { setTimeout(() => reject(new Error("room did not stop")), 500); }),
  ]);
});

test("a service chosen by the agent reaches the picker before its reply ends without rebuilding it", async () => {
  const base = new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    musicCatalog: { findArtistReleases() {}, findPreview() {} },
    musicPreviewPlayer: { play() {} },
  });
  const held = runtime();
  held.hold = true;
  const harness = await openRoom({ application: base, runtime: held });
  const promptJob = harness.post({ type: "prompt", text: "不要 Spotify，用 Apple Music 听" });
  try {
    await tick();
    await base.selectPlaybackService("apple_music");
    await tick();
    assert.equal(harness.messages.findLast((message) => message.type === "status")?.playbackService, "apple_music");
    assert.deepEqual(harness.built, [], "service selection must not replace a running agent");
    assert.equal(harness.messages.some((message) => message.type === "turn" && message.state === "end"), false);
  } finally {
    held.abort();
    await promptJob;
    await harness.stop();
    base.close();
  }
});

test("a message waiting on a new model stays in that conversation", async () => {
  const harness = await openRoom({ holdFirstBuild: true });
  try {
    const modelJob = harness.post({ type: "model", provider: "p", model: "opus" });
    await tick();
    assert.deepEqual(harness.built, ["opus"]);
    const promptJob = harness.post({ type: "prompt", text: "typed in A" });
    await tick();
    const secondJob = harness.post({ type: "prompt", text: "not yet" });
    await tick();
    assert.equal(harness.messages.findLast((message) => message.code === "message_busy")?.text, "not yet");
    const openJob = harness.post({ type: "open", id: "B" });
    await tick();
    assert.equal(harness.opened[0]?.application.sessionId, "B");
    harness.releaseBuild();
    await Promise.all([modelJob, promptJob, secondJob, openJob]);
    const starts = harness.messages.filter((message) => message.type === "turn" && message.state === "start");
    assert.deepEqual(starts.map((message) => [message.session, message.text]), [["A", "typed in A"]]);
  } finally {
    await harness.stop();
  }
});

test("a message typed while an import saves is not sent in the conversation opened meanwhile", async () => {
  const gate = deferred();
  const harness = await openRoom({
    services: {
      prepareImport: async () => ({
        preview: { listeningEvents: 2, tracks: 1 },
        commit: () => gate.promise.then(() => ({ inserted_events: 2 })),
        close() {},
      }),
      refreshImportedData: async () => {},
    },
  });
  try {
    await harness.post({ type: "import-file", path: "/tmp/history.json" });
    const commitJob = harness.post({ type: "import-commit" });
    await tick();
    const promptJob = harness.post({ type: "prompt", text: "typed in A" });
    await tick();
    assert.equal(harness.messages.some((message) => message.code === "waiting_for_import"), true);
    const secondJob = harness.post({ type: "prompt", text: "not yet" });
    await tick();
    assert.equal(harness.messages.findLast((message) => message.code === "message_busy")?.text, "not yet");
    const openJob = harness.post({ type: "open", id: "B" });
    await tick();
    assert.equal(harness.opened[0]?.application.sessionId, "B");
    gate.resolve();
    await Promise.all([commitJob, promptJob, openJob, secondJob]);
    const starts = harness.messages.filter((message) => message.type === "turn" && message.state === "start");
    assert.deepEqual(starts.map((message) => [message.session, message.text]), [["A", "typed in A"]]);
  } finally {
    gate.resolve();
    await harness.stop();
  }
});

test("two model changes rebuild in order and the later one stays", async () => {
  const harness = await openRoom({ holdFirstBuild: true });
  try {
    const first = harness.post({ type: "model", provider: "p", model: "opus" });
    await tick();
    const second = harness.post({ type: "model", provider: "p", model: "sonnet" });
    await tick();
    assert.deepEqual(harness.built, ["opus"]);
    harness.releaseBuild();
    await Promise.all([first, second]);
    assert.deepEqual(harness.built, ["opus", "sonnet"]);
    assert.equal(harness.messages.findLast((message) => message.type === "status")?.model.model, "sonnet");
  } finally {
    await harness.stop();
  }
});

test("a model chosen during a reply is saved before that reply ends", async () => {
  const held = runtime();
  held.hold = true;
  const harness = await openRoom({ runtime: held });
  try {
    const promptJob = harness.post({ type: "prompt", text: "play something" });
    await tick();
    await harness.post({ type: "model", provider: "p", model: "opus" });
    assert.equal(harness.saved[0]?.model, "opus");
    assert.deepEqual(harness.built, []);
    held.abort();
    await promptJob;
    assert.deepEqual(harness.built, ["opus"]);
  } finally {
    held.abort();
    await harness.stop();
  }
});

test("a successful device transfer reads the device list after Spotify has caught up", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const service = {
    async transfer() {},
    async devices() {
      reads += 1;
      return { devices: [{ id: "desk", name: "Desk", type: "computer", is_active: reads > 1 }] };
    },
    async currentPlayer() { return { state: "unavailable" }; },
    async queue() { return { queue: [] }; },
  };
  const desk = application("A");
  desk.ready = true;
  desk.spotifyConnection = { service };
  const harness = await openRoom({ application: desk });
  try {
    await harness.post({ type: "devices" });
    const before = reads;
    await harness.post({ type: "transfer", ref: "0" });
    assert.equal(reads, before);
    mock.timers.tick(1200);
    await tick();
    assert.equal(reads, before + 1);
  } finally {
    mock.timers.reset();
    await harness.stop();
  }
});

test("a used-up Spotify quota rests the player and the devices until Spotify's time, and says until when", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const calls = { player: 0, devices: 0, queue: 0 };
  let exhausted = true;
  const quota = () => Object.assign(new Error("Spotify development quota is exhausted."), { code: "spotify_quota_exceeded", retryAfterSeconds: 3600 });
  const service = {
    async currentPlayer() {
      calls.player += 1;
      if (exhausted) throw quota();
      return { state: "available", is_playing: true, progress_ms: 0, item: { name: "Song", uri: "spotify:track:a", artists: ["A"], duration_ms: 200_000 } };
    },
    async devices() { calls.devices += 1; throw quota(); },
    async queue() { calls.queue += 1; return { queue: [] }; },
  };
  const desk = application("A");
  desk.ready = true;
  desk.spotifyConnection = { service };
  const harness = await openRoom({ application: desk });
  try {
    await harness.post({ type: "visible", visible: true });
    await tick();
    const player = harness.messages.findLast((message) => message.type === "player");
    assert.equal(player.spotify, "limited");
    assert.equal(player.resumeAt, 1_000_000 + 3_600_000);
    // Neither the devices nor the polls ask Spotify again before then.
    const asked = { ...calls };
    await harness.post({ type: "devices" });
    assert.deepEqual(harness.messages.findLast((message) => message.type === "devices"), { type: "devices", devices: [], error: "limited", resumeAt: 1_000_000 + 3_600_000 });
    mock.timers.tick(3_500_000);
    await tick();
    assert.deepEqual(calls, asked);
    // Once the time passes, the window reads again, and the queue only once for the new song.
    exhausted = false;
    mock.timers.tick(110_000);
    await tick();
    assert.equal(harness.messages.findLast((message) => message.type === "player").spotify, "ready");
    mock.timers.tick(30_000);
    await tick();
    assert.ok(calls.player >= asked.player + 2);
    assert.equal(calls.queue, asked.queue + 1);
  } finally {
    mock.timers.reset();
    await harness.stop();
  }
});

test("coming back to the window reads Spotify once, at most every 10 s", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let reads = 0;
  const service = {
    async currentPlayer() { reads += 1; return { state: "unavailable" }; },
    async queue() { return { queue: [] }; },
  };
  const desk = application("A");
  desk.ready = true;
  desk.spotifyConnection = { service };
  const harness = await openRoom({ application: desk });
  try {
    await tick();
    const before = reads;
    harness.focus();
    await tick();
    assert.equal(reads, before + 1);
    // Switching away and back again within 10 s reads nothing more.
    mock.timers.tick(9_000);
    harness.focus();
    await tick();
    assert.equal(reads, before + 1);
    mock.timers.tick(1_000);
    harness.focus();
    await tick();
    assert.equal(reads, before + 2);
  } finally {
    mock.timers.reset();
    await harness.stop();
  }
});

test("a showing window reads Spotify every 30 s, and once just after the playing song should end", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let reads = 0;
  // Spotify plays 200 s songs back to back, and the first has 12 s left when the window opens.
  const started = 1_000_000 - 188_000;
  const service = {
    async currentPlayer() {
      reads += 1;
      const song = Math.floor((Date.now() - started) / 200_000);
      return { state: "available", is_playing: true, progress_ms: (Date.now() - started) % 200_000,
        item: { name: `Song ${song}`, uri: `spotify:track:${song}`, artists: ["A"], duration_ms: 200_000 } };
    },
    async queue() { return { queue: [] }; },
  };
  const desk = application("A");
  desk.ready = true;
  desk.spotifyConnection = { service };
  const harness = await openRoom({ application: desk });
  try {
    await harness.post({ type: "visible", visible: true });
    await tick();
    const first = reads;
    mock.timers.tick(13_000);
    await tick();
    assert.equal(reads, first);
    mock.timers.tick(1_000);
    await tick();
    assert.equal(reads, first + 1);
    // A new song from its start: the next read is the regular one, 30 s on.
    mock.timers.tick(29_000);
    await tick();
    assert.equal(reads, first + 1);
    mock.timers.tick(1_000);
    await tick();
    assert.equal(reads, first + 2);
  } finally {
    mock.timers.reset();
    await harness.stop();
  }
});

test("a showing window picks up a conversation saved elsewhere, and sends nothing when the list is the same", async () => {
  const base = application("A");
  let saved = [];
  base.memoryStore = { version: 1, dataVersion() { return this.version; } };
  base.listSavedSessions = () => saved;
  const harness = await openRoom({ application: base });
  try {
    const lists = () => harness.messages.filter((message) => message.type === "sessions");
    base.memoryStore.version = 2;
    await harness.post({ type: "visible", visible: true });
    assert.equal(lists().length, 0);
    saved = [{ session_id: "T", title: "from the terminal", updated_at: "2026-10-23T08:00:00.000Z" }];
    base.memoryStore.version = 3;
    await harness.post({ type: "visible", visible: true });
    assert.deepEqual(lists().at(-1)?.sessions.map((session) => session.id), ["T"]);
  } finally {
    await harness.stop();
  }
});

test("a selection's pin, new folder and delete reach every conversation in it, and one refusal leaves the rest done", async () => {
  const base = application("A");
  const labelled = [];
  const deleted = [];
  base.labelSavedSession = (id, patch) => {
    if (id === "unsaved") throw new Error("Saved conversation not found for this route.");
    labelled.push([id, patch]);
  };
  base.deleteSavedSession = (id) => { deleted.push(id); return null; };
  base.saveConversationFolder = ({ name }) => ({ folder_id: `folder-${name}` });
  const harness = await openRoom({ application: base });
  try {
    const lists = () => harness.messages.filter((message) => message.type === "sessions").length;
    const notices = () => harness.messages.filter((message) => message.type === "notice");
    let before = lists();
    await harness.post({ type: "label", ids: ["B", "unsaved", "C"], patch: { pinned: true } });
    assert.deepEqual(labelled, [["B", { pinned: true }], ["C", { pinned: true }]]);
    assert.equal(lists(), before + 1);
    assert.equal(notices().length, 1);

    labelled.length = 0;
    await harness.post({ type: "folder-save", name: "Rain", moveSessions: ["B", "C"] });
    assert.deepEqual(labelled, [["B", { folderId: "folder-Rain" }], ["C", { folderId: "folder-Rain" }]]);

    before = lists();
    await harness.post({ type: "delete", ids: ["B", "C"] });
    assert.deepEqual(deleted, ["B", "C"]);
    assert.equal(lists(), before + 1);

    // One row still sends one id.
    labelled.length = 0;
    await harness.post({ type: "label", id: "D", patch: { folderId: null } });
    assert.deepEqual(labelled, [["D", { folderId: null }]]);
    assert.equal(notices().length, 1);
  } finally {
    await harness.stop();
  }
});

test("the window follows the conversation the terminal opened and draws the terminal's reply as it grows", async () => {
  const base = application("A");
  let active = "A";
  let reply = null;
  let saved = [];
  base.memoryStore = { version: 1, dataVersion() { return this.version; } };
  base.activeConversationId = () => active;
  base.followActiveConversation = function () {
    if (active === this.sessionId) return null;
    this.sessionId = active;
    return { session_id: active };
  };
  base.replyElsewhere = () => reply;
  base.currentConversationTurns = () => saved;
  const harness = await openRoom({ application: base });
  const look = async (change) => {
    change();
    base.memoryStore.version += 1;
    await harness.post({ type: "visible", visible: true });
  };
  try {
    const lastSession = () => harness.messages.filter((message) => message.type === "session").at(-1);
    await look(() => {
      active = "T";
      reply = { entry_id: "e1", user_text: "play something calm", assistant_text: "" };
      saved = [{ role: "user", text: "play something calm" }];
    });
    assert.equal(lastSession().current, "T");
    assert.deepEqual(lastSession().transcript, []);
    assert.equal(lastSession().live.user, "play something calm");

    await look(() => { reply = { ...reply, assistant_text: "Here is" }; });
    assert.deepEqual(harness.messages.filter((message) => message.type === "text").at(-1), { type: "text", session: "T", id: "e1", replace: "Here is" });

    // One reply at a time: the window gives the message back while the terminal answers.
    await harness.post({ type: "prompt", text: "and louder" });
    assert.deepEqual(harness.messages.filter((message) => message.type === "notice").at(-1), { type: "notice", code: "message_busy", text: "and louder" });

    await look(() => {
      reply = null;
      saved = [{ role: "user", text: "play something calm" }, { role: "assistant", text: "Here is a calm set." }];
    });
    assert.equal(lastSession().live, null);
    assert.deepEqual(lastSession().transcript.map((turn) => turn.text), ["play something calm", "Here is a calm set."]);
  } finally {
    await harness.stop();
  }
});

test("the window shows the Music app while it plays and Spotify is paused, and its buttons act there", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let spotifyReads = 0;
  const service = {
    async currentPlayer() {
      spotifyReads += 1;
      return { state: "available", is_playing: false, progress_ms: 5_000, item: { name: "Paused", uri: "spotify:track:p", artists: ["S"], duration_ms: 200_000 } };
    },
    async queue() { return { queue: [] }; },
    async pause() { throw new Error("Spotify should not be paused"); },
  };
  const actions = [];
  const song = { id: "B2", title: "Second", artists: ["M"], album: "Mix", duration_ms: 180_000 };
  const musicApp = {
    available: true,
    async nowPlaying({ tracks } = {}) {
      return { state: actions.includes("pause") ? "paused" : "playing", song, position_ms: 30_000, shuffle: false, repeat: "off",
        playlist: { id: "P", name: "Evening", library: false, ...(tracks ? { tracks_total: 3, position: 2, first_position: 1,
          tracks: [{ title: "First", artists: ["M"] }, song, { title: "Third", artists: ["N"], album: null, duration_ms: 1 }] } : {}) } };
    },
    async cover() { return "data:image/jpeg;base64,AA=="; },
    async pause() { actions.push("pause"); },
  };
  const desk = application("A");
  desk.ready = true;
  desk.spotifyConnection = { service };
  desk.musicApp = musicApp;
  const harness = await openRoom({ application: desk });
  try {
    await harness.post({ type: "visible", visible: true });
    await tick();
    const shown = harness.messages.filter((message) => message.type === "player").at(-1);
    assert.equal(shown.now.title, "Second");
    assert.equal(shown.now.service, "apple_music");
    assert.equal(shown.now.image, "data:image/jpeg;base64,AA==");
    assert.deepEqual(shown.next.map((track) => track.title), ["Third"]);
    // The Music app is read every 5 s; Spotify keeps its own 30 s.
    const reads = spotifyReads;
    mock.timers.tick(5_000);
    await tick();
    assert.equal(spotifyReads, reads);
    await harness.post({ type: "control", action: "pause" });
    await tick();
    assert.deepEqual(actions, ["pause"]);
    assert.equal(spotifyReads, reads);
    mock.timers.tick(25_000);
    await tick();
    assert.equal(spotifyReads, reads + 1);
  } finally {
    mock.timers.reset();
    await harness.stop();
  }
});

test("with both playing, a pause in the window keeps the Music app shown, so the next press resumes it", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const spotifyActions = [];
  const service = {
    async currentPlayer() {
      return { state: "available", is_playing: true, progress_ms: 5_000, item: { name: "Elsewhere", uri: "spotify:track:e", artists: ["S"], duration_ms: 200_000 } };
    },
    async queue() { return { queue: [] }; },
    async pause() { spotifyActions.push("pause"); },
    async resume() { spotifyActions.push("resume"); },
  };
  let playing = true;
  const musicApp = {
    available: true,
    async nowPlaying() { return { state: playing ? "playing" : "paused", song: { id: "1", title: "Here", artists: ["M"] }, position_ms: 0, shuffle: true, repeat: "off", playlist: null }; },
    async cover() { return null; },
    async pause() { playing = false; },
    async resume() { playing = true; },
  };
  const desk = application("A");
  desk.ready = true;
  desk.playbackService = "apple_music";
  desk.spotifyConnection = { service };
  desk.musicApp = musicApp;
  const harness = await openRoom({ application: desk });
  const shown = () => harness.messages.filter((message) => message.type === "player").at(-1).now;
  try {
    await tick();
    assert.equal(shown().title, "Here");
    await harness.post({ type: "control", action: "pause" });
    await tick();
    assert.equal(shown().title, "Here");
    assert.equal(shown().playing, false);
    await harness.post({ type: "control", action: "resume" });
    await tick();
    assert.equal(playing, true);
    assert.deepEqual(spotifyActions, []);
    // Paused and left alone, it gives way to the one still playing.
    await harness.post({ type: "control", action: "pause" });
    mock.timers.tick(31_000);
    await tick();
    assert.equal(shown().title, "Elsewhere");
  } finally {
    mock.timers.reset();
    await harness.stop();
  }
});

test("music the listener starts in the Music app stops Moondog's own player, and play in the window quiets the others", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let state = "paused";
  const stops = [];
  const quiet = [];
  const musicApp = {
    available: true,
    async nowPlaying() { return { state, song: { id: "1", title: "Here", artists: ["M"] }, position_ms: 0, shuffle: true, repeat: "off", playlist: null }; },
    async cover() { return null; },
    async resume() { state = "playing"; },
  };
  const desk = application("A");
  desk.playbackService = "apple_music";
  desk.musicApp = musicApp;
  desk.musicPreviewPlayer = { stop: () => { stops.push("stop"); } };
  desk.quietOtherPlayers = async (starting) => { quiet.push(starting); };
  const harness = await openRoom({ application: desk });
  try {
    await harness.post({ type: "visible", visible: true });
    await tick();
    assert.deepEqual(stops, []);
    state = "playing";
    mock.timers.tick(5_000);
    await tick();
    assert.deepEqual(stops, ["stop"]);
    state = "paused";
    mock.timers.tick(5_000);
    await tick();
    await harness.post({ type: "control", action: "resume" });
    await tick();
    assert.deepEqual(quiet, ["music_app"]);
    assert.equal(state, "playing");
  } finally {
    mock.timers.reset();
    await harness.stop();
  }
});

test("Edit in the window branches the conversation before a saved message and returns it as a draft", async () => {
  const base = application("A");
  let entries = [
    { entry_id: "e1", user_text: "play something calm", assistant_text: "Here is Pink Moon.", outcome: "completed" },
    { entry_id: "e2", user_text: "and louder", assistant_text: "Turned it up.", outcome: "completed" },
  ];
  base.conversationEntries = ({ limit }) => entries.slice(-limit);
  base.conversationEntryTurns = (entry) => [{ role: "user", text: entry.user_text }, { role: "assistant", text: entry.assistant_text }];
  const rewound = [];
  const room = runtime();
  room.rewindTo = async (entryId) => {
    rewound.push(entryId);
    const index = entries.findIndex((entry) => entry.entry_id === entryId);
    const draft = entries[index].user_text;
    entries = entries.slice(0, index);
    base.sessionId = "B";
    return { session_id: "B", draft };
  };
  const harness = await openRoom({ application: base, runtime: room });
  try {
    await harness.post({ type: "open", id: "A" });
    const shown = harness.messages.filter((message) => message.type === "session").at(-1);
    assert.deepEqual(shown.transcript.filter((turn) => turn.role === "user").map((turn) => turn.entry), ["e1", "e2"]);

    await harness.post({ type: "rewind", entry: "e2" });
    await tick();
    assert.deepEqual(rewound, ["e2"]);
    const branched = harness.messages.filter((message) => message.type === "session").at(-1);
    assert.equal(branched.current, "B");
    assert.deepEqual(branched.transcript.map((turn) => turn.text), ["play something calm", "Here is Pink Moon."]);
    assert.deepEqual(harness.messages.filter((message) => message.type === "draft").at(-1), { type: "draft", session: "B", text: "and louder" });

    // A turn that just ended names its saved entry, so its message can be edited without a redraw.
    entries.push({ entry_id: "e3", user_text: "something else", assistant_text: "ok", outcome: "completed" });
    await harness.post({ type: "prompt", text: "something else" });
    await tick();
    assert.equal(harness.messages.filter((message) => message.type === "turn" && message.state === "end").at(-1).entry, "e3");
  } finally {
    await harness.stop();
  }
});
