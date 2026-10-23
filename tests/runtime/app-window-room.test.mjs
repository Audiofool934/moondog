import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { runWindowRoom } from "../../app/window-room.mjs";

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
  });
  const post = (data) => listener({ data });
  if (!extras.quitNow) await tick();
  return {
    messages,
    post,
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
