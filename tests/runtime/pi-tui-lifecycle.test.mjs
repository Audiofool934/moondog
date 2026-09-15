import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, TuiMainScreen, getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { createMoondogTheme } from "../../src/surfaces/cli/brand-theme.mjs";
import { RecordSleeve, paintBrandLine } from "../../src/surfaces/cli/brand-components.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTuiArguments, runMoondogTui } from "../../src/surfaces/cli/tui.mjs";
import { runProfileCommand } from "../../src/surfaces/cli/profile-command.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { openLocalMemoryStore } from "../../src/memory/local-memory-store.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { fictionalSpotifyHistoryEntries } from "../../src/demo/fictional-spotify-history.mjs";
import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";

class FakeTerminal {
  constructor() {
    this.columns = 80;
    this.rows = 24;
    this.kittyProtocolActive = false;
    this.startCount = 0;
    this.stopCount = 0;
    this.hideCursorCount = 0;
    this.showCursorCount = 0;
    this.output = "";
  }

  start(onInput, onResize) {
    this.startCount += 1;
    this.onInput = onInput;
    this.onResize = onResize;
  }

  stop() {
    this.stopCount += 1;
  }

  async drainInput() {}

  write(data) {
    this.output += data;
  }

  moveBy() {}

  hideCursor() {
    this.hideCursorCount += 1;
  }

  showCursor() {
    this.showCursorCount += 1;
  }

  clearLine() {}

  clearFromCursor() {}

  clearScreen() {}

  setTitle() {}

  setProgress() {}

  send(data) {
    this.onInput(data);
  }
}

function fakeApplication() {
  return {
    async sourceStatus() {
      return { state: "missing", latest: null };
    },
  };
}

function fakeRuntime() {
  return {
    abortCount: 0,
    publicStatus() {
      return { state: "offline", reason: "model_not_configured" };
    },
    abort() {
      this.abortCount += 1;
    },
    reset() {},
  };
}

function configuredFakeRuntime(prompts) {
  return {
    ...fakeRuntime(),
    publicStatus() {
      return { state: "configured", provider: "faux", model: "faux-1" };
    },
    async prompt(text, callbacks) {
      prompts.push(text);
      callbacks.onTextDelta("Recorded listening request.");
      return { status: "completed", text: "Recorded listening request." };
    },
  };
}

async function waitForStart(terminal) {
  while (terminal.startCount === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate) {
  // Pi schedules renders with timers, so event-loop turns are not a timeout.
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for the TUI test condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function createSavedConversationFixture(context, histories = [], { configured = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-tui-sessions-"));
  const databasePath = path.join(root, "memory.sqlite");
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  let application;
  let memoryStore;
  let running;
  context.after(async () => {
    signalTarget.emit("SIGTERM");
    await running;
    application?.close();
    await rm(root, { recursive: true, force: true });
  });
  const openApplication = async () => {
    memoryStore = await openLocalMemoryStore({ databasePath });
    application = new MoondogApplication({ memoryStore, importsRoot: path.join(root, "no-imports") });
  };
  await openApplication();
  const saved = histories.map(({ user, assistant }) => {
    const session = application.startNewSession("fixture_seed");
    application.recordCompletedTurn(user, assistant);
    return { ...session, title: user, turns: application.currentSessionTurns() };
  });
  application.close();
  application = null;
  await openApplication();
  const runtime = {
    ...fakeRuntime(), resetCount: 0, restoreCount: 0, loadedTurns: [], prompts: [],
    publicStatus() {
      return configured ? { state: "configured", provider: "faux", model: "faux-1" }
        : { state: "offline", reason: "model_not_configured" };
    },
    reset() { this.resetCount += 1; this.loadedTurns = []; },
    restoreSession() {
      this.restoreCount += 1;
      this.loadedTurns = application.currentSessionTurns();
    },
    async prompt(text, callbacks) {
      this.prompts.push({ text, history: structuredClone(this.loadedTurns), sessionId: application.ensureMemorySession().session_id });
      const response = `Fixture response: ${text}`;
      callbacks.onTextDelta(response);
      application.recordCompletedTurn(text, response);
      this.loadedTurns = application.currentSessionTurns();
      return { status: "completed", text: response };
    },
  };
  const outputIncludes = async (expected) => {
    for (let attempt = 0; attempt < 100 && !stripVTControlCharacters(terminal.output).includes(expected); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(stripVTControlCharacters(terminal.output).includes(expected), `Expected TUI output: ${expected}`);
  };
  return {
    application, memoryStore, terminal, runtime, saved, outputIncludes,
    async launch() {
      terminal.output = "";
      running = runMoondogTui({
        application, runtime, terminal, signalTarget,
        environment: { TERM: "xterm-256color", MOONDOG_ART: "ascii", MOONDOG_MOTION: "off" },
      });
      await outputIncludes("New conversation");
    },
    async stop() { signalTarget.emit("SIGTERM"); await running; },
    async submit(command, expected) {
      terminal.output = "";
      terminal.send(command);
      terminal.send("\r");
      await outputIncludes(expected);
    },
    async openResumeFromDraft(expected = "Resume conversation") {
      terminal.output = "";
      terminal.send("\x10");
      await outputIncludes("Commands");
      terminal.send("resume");
      await outputIncludes("/resume");
      terminal.output = "";
      terminal.send("\r");
      await outputIncludes(expected);
    },
  };
}

test("each TUI launch starts an empty conversation while retaining completed SQLite history", async (context) => {
  const fixture = await createSavedConversationFixture(context, [
    { user: "Earlier synthetic listening request", assistant: "Earlier synthetic listening response" },
  ], { configured: false });
  const { application, memoryStore, runtime, terminal, saved } = fixture;
  const startSession = context.mock.method(application, "startNewSession");
  await fixture.launch();
  const firstFreshId = application.ensureMemorySession().session_id;
  assert.notEqual(firstFreshId, saved[0].session_id);
  assert.deepEqual(application.currentSessionTurns(), []);
  assert.deepEqual(memoryStore.readSessionTurns(saved[0].session_id), saved[0].turns);
  assert.equal(runtime.resetCount, 1);
  assert.equal(runtime.restoreCount, 0);
  assert.doesNotMatch(stripVTControlCharacters(terminal.output), /Earlier synthetic|Welcome back/u);
  assert.match(stripVTControlCharacters(terminal.output), /M O O N D O G/u);
  application.recordCompletedTurn("First fresh conversation", "Preserved first fresh response");
  const firstFreshTurns = application.currentSessionTurns();
  await fixture.stop();

  await fixture.launch();
  assert.notEqual(application.ensureMemorySession().session_id, firstFreshId);
  assert.deepEqual(application.currentSessionTurns(), []);
  assert.deepEqual(memoryStore.readSessionTurns(firstFreshId), firstFreshTurns);
  assert.deepEqual(memoryStore.readSessionTurns(saved[0].session_id), saved[0].turns);
  assert.equal(runtime.resetCount, 2);
  assert.deepEqual(startSession.mock.calls.map((call) => call.arguments), [["tui_start"], ["tui_start"]]);
  assert.deepEqual(new Set(application.listSavedSessions().map((session) => session.session_id)), new Set([saved[0].session_id, firstFreshId]));
  assert.doesNotMatch(stripVTControlCharacters(terminal.output), /Earlier synthetic|First fresh conversation|Welcome back/u);
});

for (const selection of ["filtered picker", "exact session ID"]) {
  test(`/resume by ${selection} restores the selected transcript and the next prompt's runtime history`, async (context) => {
    const fixture = await createSavedConversationFixture(context, [
      { user: "Amber jazz for a rainy evening", assistant: "The amber session's synthetic horn selection." },
      { user: "Cobalt songs for a morning walk", assistant: "The cobalt session's synthetic walking selection." },
    ]);
    const { application, memoryStore, runtime, terminal, saved } = fixture;
    await fixture.launch();
    if (selection === "filtered picker") {
      await fixture.submit("/resume", "Resume conversation");
      terminal.send("Amber");
      await fixture.outputIncludes("Amber jazz");
      terminal.output = "";
      terminal.send("\r");
      await fixture.outputIncludes("Resumed:");
    } else {
      await fixture.submit(`/resume ${saved[0].session_id}`, "Resumed:");
    }
    assert.equal(application.ensureMemorySession().session_id, saved[0].session_id);
    assert.equal(runtime.restoreCount, 1);
    assert.deepEqual(runtime.loadedTurns, saved[0].turns);
    assert.match(stripVTControlCharacters(terminal.output), /Amber jazz/u);
    assert.match(stripVTControlCharacters(terminal.output), /synthetic horn selection/u);
    assert.doesNotMatch(stripVTControlCharacters(terminal.output), /synthetic walking selection/u);
    assert.deepEqual(runtime.prompts, []);

    const nextRequest = "Continue with another quiet selection";
    await fixture.submit(nextRequest, `Fixture response: ${nextRequest}`);
    assert.deepEqual(runtime.prompts, [{ text: nextRequest, history: saved[0].turns, sessionId: saved[0].session_id }]);
    assert.equal(memoryStore.readSessionTurns(saved[0].session_id).length, 4);
    assert.deepEqual(memoryStore.readSessionTurns(saved[1].session_id), saved[1].turns);
    assert.equal(application.listSavedSessions().find((session) => session.session_id === saved[0].session_id).turn_count, 4);
  });
}

test("resume cancellation and an unmatched filter preserve the current conversation and input draft", async (context) => {
  const fixture = await createSavedConversationFixture(context, [
    { user: "Older synthetic playlist discussion", assistant: "A saved synthetic reply." },
  ]);
  const { application, runtime, terminal } = fixture;
  await fixture.launch();
  await fixture.submit("Current synthetic conversation", "Fixture response: Current synthetic conversation");
  const currentId = application.ensureMemorySession().session_id;
  const currentTurns = application.currentSessionTurns();
  const draft = "Finish this unchanged listening draft";
  terminal.send(draft);
  await fixture.openResumeFromDraft();
  terminal.send("no_synthetic_session_matches_this_query");
  await fixture.outputIncludes("No matches");
  terminal.send("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(application.ensureMemorySession().session_id, currentId);
  assert.deepEqual(application.currentSessionTurns(), currentTurns);
  assert.equal(runtime.restoreCount, 0);
  terminal.output = "";
  terminal.send("\x1b");
  await fixture.outputIncludes("Resume cancelled. Conversation kept.");

  await fixture.openResumeFromDraft();
  terminal.output = "";
  terminal.send("\x1b");
  await fixture.outputIncludes("Resume cancelled. Conversation kept.");
  assert.equal(application.ensureMemorySession().session_id, currentId);
  assert.deepEqual(application.currentSessionTurns(), currentTurns);
  assert.equal(runtime.restoreCount, 0);
  terminal.output = "";
  terminal.send("\r");
  await fixture.outputIncludes(`Fixture response: ${draft}`);
  assert.deepEqual(runtime.prompts.at(-1), { text: draft, history: currentTurns, sessionId: currentId });
});

test("/resume with no saved conversations leaves the empty session and draft intact", async (context) => {
  const fixture = await createSavedConversationFixture(context);
  const { application, runtime, terminal } = fixture;
  await fixture.launch();
  const currentId = application.ensureMemorySession().session_id;
  const draft = "A first listening request without history";
  terminal.send(draft);
  await fixture.openResumeFromDraft("No saved conversations yet.");
  assert.equal(application.ensureMemorySession().session_id, currentId);
  assert.deepEqual(application.currentSessionTurns(), []);
  assert.equal(runtime.restoreCount, 0);
  terminal.output = "";
  terminal.send("\r");
  await fixture.outputIncludes(`Fixture response: ${draft}`);
  assert.deepEqual(runtime.prompts, [{ text: draft, history: [], sessionId: currentId }]);
});

test("/new clears the resumed runtime and starts a separate conversation without deleting its history", async (context) => {
  const fixture = await createSavedConversationFixture(context, [
    { user: "A saved synthetic record discussion", assistant: "The saved record reply." },
  ]);
  const { application, memoryStore, runtime, terminal, saved } = fixture;
  await fixture.launch();
  await fixture.submit(`/resume ${saved[0].session_id}`, "Resumed:");
  await fixture.submit("/new", "Started a new conversation.");
  const newId = application.ensureMemorySession().session_id;
  assert.notEqual(newId, saved[0].session_id);
  assert.deepEqual(application.currentSessionTurns(), []);
  assert.deepEqual(runtime.loadedTurns, []);
  assert.equal(runtime.resetCount, 2);
  assert.deepEqual(memoryStore.readSessionTurns(saved[0].session_id), saved[0].turns);
  assert.match(stripVTControlCharacters(terminal.output), /M O O N D O G/u);
  assert.doesNotMatch(stripVTControlCharacters(terminal.output), /The saved record reply/u);
  await fixture.submit("A separate new request", "Fixture response: A separate new request");
  assert.deepEqual(runtime.prompts, [{ text: "A separate new request", history: [], sessionId: newId }]);
  assert.deepEqual(new Set(application.listSavedSessions().map((session) => session.session_id)), new Set([saved[0].session_id, newId]));
});

test("structured TUI arguments preserve quoted identities and never expand shell text", () => {
  assert.deepEqual(
    parseTuiArguments('correct --track "L’été  Again" --by \'Artist Name\' --note "$(whoami); `date` $HOME" --avoid'),
    ["correct", "--track", "L’été  Again", "--by", "Artist Name", "--note", "$(whoami); `date` $HOME", "--avoid"],
  );
  assert.deepEqual(parseTuiArguments('import-history /tmp/Music\\ Archive.zip'), ["import-history", "/tmp/Music Archive.zip"]);
  assert.throws(() => parseTuiArguments('correct --track "unfinished'), /Unclosed quote/);
  assert.throws(() => parseTuiArguments("correct --track unfinished\\"), /Incomplete escape/);
});

test("TUI shows the listening profile after each import, then supports correction and retraction without a model", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-tui-profile-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_STATE_HOME: root };
  const store = await openListeningHistoryStore({ environment });
  const subjectId = store.localSubjectId({ create: true });
  const entries = fictionalSpotifyHistoryEntries();
  const projectedImport = projectSpotifyExtendedStreamingHistory({
    subjectId,
    capturedAt: "2026-09-05T00:00:00.000Z",
    archiveSha256: "b".repeat(64),
    archiveSizeBytes: entries.reduce((sum, entry) => sum + entry.data.length, 0),
    memberNames: entries.map((entry) => path.basename(entry.name)),
    records: entries.flatMap((entry) => JSON.parse(entry.data)),
  });
  const application = new MoondogApplication({
    importsRoot: path.join(root, "no-apple-imports"),
    domainServices: createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId }),
  });
  context.after(() => application.close());
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  const running = runMoondogTui({
    application,
    runtime: fakeRuntime(),
    terminal,
    signalTarget,
    runSpotify: async (args) => {
      assert.deepEqual(args, ["import-history", "/tmp/Fictional Music History.zip"]);
      store.ingestImport(projectedImport);
      return "Spotify history import completed.";
    },
    runProfile: async (args) => {
      let output = "";
      await runProfileCommand({
        args, environment, commandPrefix: "/profile",
        output: { write: (value) => { output += value; } },
      });
      return output;
    },
  });
  context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
  await waitForStart(terminal);
  const waitForOutput = async (expected) => {
    for (let attempt = 0; attempt < 100 && !terminal.output.includes(expected); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(terminal.output.includes(expected), terminal.output);
    assert.doesNotMatch(terminal.output, /Local command failed/);
  };
  const submit = async (command, expected) => {
    terminal.output = "";
    terminal.send(command);
    terminal.send("\r");
    await waitForOutput(expected);
  };
  const leaveProfile = async (expected) => {
    terminal.output = "";
    terminal.send("\x1b");
    await waitForOutput(expected);
  };
  await submit('/spotify import-history "/tmp/Fictional Music History.zip"', "Your listening profile");
  await leaveProfile("Your Moondog tasteprint");
  assert.match(terminal.output, /Listening Time Machine/);
  assert.match(terminal.output, /cumulative local profile/);
  assert.match(terminal.output, /Midnight Lines/);
  const before = await application.runLocalCommand("taste");
  await submit('/profile correct --track "Midnight Lines" --by "Mara Vale" --avoid', "Your listening profile");
  await leaveProfile("Recorded an explicit listener correction.");
  const corrected = await application.runLocalCommand("taste");
  const assertion = corrected.listener_assertions.active[0];
  assert.equal(assertion.label, "Midnight Lines");
  assert.equal(assertion.artist_credit, "Mara Vale");
  assert.ok(!corrected.listening_behavior.time_capsule_tracks.some((track) => track.title === "Midnight Lines"));
  assert.equal(corrected.coverage.effective_listening_events, before.coverage.effective_listening_events);
  assert.ok(terminal.output.includes("/profile retract"));
  await submit("/profile corrections", "Listener corrections");
  await submit("/taste report", "Your explicit corrections");
  await submit(`/profile retract ${assertion.correction_id}`, "Your listening profile");
  await leaveProfile("Retracted the active listener correction.");
  const restored = await application.runLocalCommand("taste");
  assert.equal(restored.listener_assertions.active.length, 0);
  assert.deepEqual(restored.listening_behavior.time_capsule_tracks, before.listening_behavior.time_capsule_tracks);
  await submit("/taste report", "Listening Time Machine");
  await submit('/spotify import-history "/tmp/Fictional Music History.zip"', "Your listening profile");
  assert.equal((await application.runLocalCommand("taste")).coverage.effective_listening_events, before.coverage.effective_listening_events);
  await leaveProfile("Your Moondog tasteprint");
  terminal.send("/quit");
  terminal.send("\r");
  await running;
});

for (const failure of ["import", "profile"]) {
  test(`TUI distinguishes a failed ${failure} from a successful import awaiting profile review`, async (context) => {
    const terminal = new FakeTerminal();
    const signalTarget = new EventEmitter();
    let profileReads = 0;
    const running = runMoondogTui({
      application: {
        ...fakeApplication(),
        async runLocalCommand(command) {
          assert.equal(command, "taste");
          profileReads += 1;
          throw new Error("Projection unavailable");
        },
      },
      runtime: fakeRuntime(), terminal, signalTarget,
      async runSpotify() {
        if (failure === "import") throw new Error("Invalid history ZIP");
        return "Spotify history import completed.";
      },
    });
    context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
    await waitForStart(terminal);
    terminal.send('/spotify import-history "/tmp/Fictional Music History.zip"');
    terminal.send("\r");
    await waitFor(() => terminal.output.includes(failure === "import" ? "Command failed." : "profile review unavailable"));
    if (failure === "import") {
      assert.equal(profileReads, 0);
      assert.match(terminal.output, /Invalid history ZIP/);
      assert.doesNotMatch(terminal.output, /Your Moondog tasteprint/);
    } else {
      assert.equal(profileReads, 1);
      assert.match(terminal.output, /Spotify history import completed/);
      assert.match(terminal.output, /\/taste/);
      assert.doesNotMatch(terminal.output, /Local command failed/);
    }
    terminal.send("/quit");
    terminal.send("\r");
    await running;
  });
}

async function createGuidedImportFixture(context, options = {}) {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  const prompts = [];
  let frame;
  const doRender = TuiMainScreen.prototype.doRender;
  context.mock.method(TuiMainScreen.prototype, "doRender", function () {
    const result = doRender.call(this);
    frame = this.captureRenderState();
    return result;
  });
  const calls = { paths: [], commits: 0, closes: 0, refreshes: 0, profiles: 0 };
  const profile = {
    coverage: { effective_listening_events: 2, listening_tracks: 1, listening_hours: 0.1 },
    listening_source: { providers: ["spotify"] },
  };
  const prepared = {
    preview: {
      sourceLabel: "Spotify history", fileName: "Chosen History.zip",
      listeningEvents: 2, tracks: 1, eventsWithPlayedMs: 2, profileEvidence: 0,
      earliestListeningAt: "2026-09-01T00:00:00.000Z",
      latestListeningAt: "2026-09-02T00:00:00.000Z",
      scopeNote: "Two synthetic listening events, not a complete listening history.",
    },
    async commit() {
      calls.commits += 1;
      return options.commit ? await options.commit() : { inserted_events: 2, duplicate_events: 0 };
    },
    close() { calls.closes += 1; },
  };
  const running = runMoondogTui({
    application: {
      ...fakeApplication(),
      profileServicesReady: () => calls.commits > 0,
      async runLocalCommand(command) { assert.equal(command, "taste"); return profile; },
      async getProfileSummary() { calls.profiles += 1; return profile; },
    },
    runtime: configuredFakeRuntime(prompts), terminal, signalTarget,
    rebuildRuntime: async () => configuredFakeRuntime(prompts),
    environment: { TERM: "xterm-256color", MOONDOG_ART: "ascii", MOONDOG_MOTION: "off" },
    async prepareImport(filePath) {
      calls.paths.push(filePath);
      return options.prepareImport ? await options.prepareImport(filePath, prepared) : prepared;
    },
    async refreshImportedData() {
      calls.refreshes += 1;
      if (options.refreshError && calls.refreshes === 1) throw new Error("Fixture profile refresh unavailable");
    },
  });
  context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
  await waitFor(() => terminal.output.includes("New conversation"));
  const outputIncludes = (expected) => waitFor(() => stripVTControlCharacters(terminal.output).includes(expected));
  return {
    terminal, signalTarget, running, prompts, calls, prepared, outputIncludes,
    screen: () => frame.previousLines.map(stripVTControlCharacters).join("\n"),
    async submit(value, expected) {
      terminal.output = "";
      terminal.send(value);
      terminal.send("\r");
      await outputIncludes(expected);
    },
  };
}

test("guided import from the command palette keeps a multiline draft when cancelled", async (context) => {
  const fixture = await createGuidedImportFixture(context);
  const { terminal, calls, prompts } = fixture;
  const draft = "A quiet listening thought\nfor the train ride";
  terminal.send(`\x1b[200~${draft}\x1b[201~`);
  terminal.send("\x10");
  await fixture.outputIncludes("Commands");
  terminal.send("import");
  terminal.send("\r");
  await fixture.outputIncludes("Get Spotify history");
  terminal.output = "";
  terminal.send("\x1b");
  await fixture.outputIncludes("for the train ride");
  assert.match(stripVTControlCharacters(terminal.output), /M O O N D O G/u);
  assert.match(stripVTControlCharacters(terminal.output), /A quiet listening thought/u);
  assert.deepEqual(calls.paths, []);
  assert.equal(calls.commits, 0);
  terminal.send("\r");
  await fixture.outputIncludes("Recorded listening request.");
  assert.deepEqual(prompts, [draft]);
});

test("guided import inspection failure retains the editable path for a corrected retry", async (context) => {
  const fixture = await createGuidedImportFixture(context, {
    async prepareImport(filePath, prepared) {
      if (filePath.endsWith("Missing.zip")) throw new Error("Choose an existing history file.");
      return prepared;
    },
  });
  const { terminal, calls } = fixture;
  await fixture.submit("/import", "Get Spotify history");
  terminal.send("\r");
  await fixture.outputIncludes("Choose your history file");
  terminal.send("/tmp/Missing.zip");
  terminal.send("\r");
  await fixture.outputIncludes("Choose an existing history file.");
  assert.match(fixture.screen(), /\/tmp\/Missing\.zip/u);
  assert.match(fixture.screen(), /Nothing imported/u);
  assert.equal(calls.commits, 0);
  terminal.send("\x05");
  terminal.send("\x15");
  terminal.send("/tmp/Chosen History.zip");
  terminal.send("\r");
  await fixture.outputIncludes("Review this import");
  assert.deepEqual(calls.paths, ["/tmp/Missing.zip", "/tmp/Chosen History.zip"]);
  assert.equal(calls.commits, 0);
});

test("guided import preview cancellation closes the inspected handle without committing", async (context) => {
  const fixture = await createGuidedImportFixture(context);
  const { terminal, calls } = fixture;
  await fixture.submit("/import /tmp/Chosen History.zip", "Review this import");
  assert.match(stripVTControlCharacters(terminal.output), /Nothing added yet/u);
  assert.match(stripVTControlCharacters(terminal.output), /2 plays · 1 tracks/u);
  terminal.output = "";
  terminal.send("\x1b");
  await fixture.outputIncludes("Choose your history file");
  assert.match(fixture.screen(), /\/tmp\/Chosen History\.zip/u);
  assert.equal(calls.closes, 1);
  terminal.send("\x1b");
  await fixture.outputIncludes("Get Spotify history");
  terminal.send("\x1b");
  await fixture.outputIncludes("Import closed");
  assert.equal(calls.closes, 1);
  assert.equal(calls.commits, 0);
  assert.equal(calls.refreshes, 0);
  assert.deepEqual(fixture.prompts, []);
});

for (const refreshError of [false, true]) {
  test(`guided import confirmation commits once and ${refreshError ? "retains its receipt when refresh fails" : "opens the native Profile immediately"}`, async (context) => {
    let finishCommit;
    const commit = new Promise((resolve) => { finishCommit = resolve; });
    const fixture = await createGuidedImportFixture(context, { commit: () => commit, refreshError });
    const { terminal, calls } = fixture;
    context.after(() => finishCommit({ inserted_events: 2, duplicate_events: 0 }));
    await fixture.submit("/import /tmp/Chosen History.zip", "Review this import");
    terminal.output = "";
    terminal.send("\r");
    terminal.send("\r");
    await fixture.outputIncludes("Saving listening history locally");
    assert.equal(calls.commits, 1);
    assert.equal(calls.refreshes, 0);
    finishCommit({ inserted_events: 2, duplicate_events: 0 });
    await fixture.outputIncludes(refreshError ? "History saved; profile refresh" : "Your listening profile");
    assert.equal(calls.commits, 1);
    assert.equal(calls.closes, 1);
    assert.equal(calls.refreshes, 1);
    assert.equal(calls.profiles, refreshError ? 0 : 1);
    if (!refreshError) {
      assert.match(stripVTControlCharacters(terminal.output), /Import complete/u);
      terminal.output = "";
      terminal.send("\x1b");
      await fixture.outputIncludes("Listening history imported");
    }
    const transcript = stripVTControlCharacters(terminal.output);
    assert.match(transcript, /2 new listening records · 0 already present/u);
    assert.match(transcript, /Chosen History\.zip/u);
    if (refreshError) {
      assert.ok(transcript.indexOf("2 new listening records") < transcript.indexOf("Your history was saved"));
      assert.match(transcript, /\/reload.*\/taste/su);
      assert.doesNotMatch(transcript, /Import was not saved/u);
      await fixture.submit("/reload", "Runtime reloaded.");
      assert.equal(calls.refreshes, 2, "reload retries the saved import's data refresh");
      await fixture.submit("/taste", "Your listening profile");
      assert.equal(calls.commits, 1, "profile recovery must not repeat the import");
    }
    assert.deepEqual(fixture.prompts, []);
  });
}

test("guided import closes a late inspection handle after shutdown without committing or redrawing", async (context) => {
  let finishInspection;
  const inspection = new Promise((resolve) => { finishInspection = resolve; });
  const fixture = await createGuidedImportFixture(context, { prepareImport: () => inspection });
  const { terminal, calls, prepared } = fixture;
  terminal.send("/import /tmp/Chosen History.zip");
  terminal.send("\r");
  await fixture.outputIncludes("Inspecting the file");
  assert.equal(calls.paths.length, 1);
  fixture.signalTarget.emit("SIGTERM");
  await fixture.running;
  const stoppedOutput = terminal.output;
  finishInspection(prepared);
  await waitFor(() => calls.closes === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.commits, 0);
  assert.equal(calls.refreshes, 0);
  assert.equal(terminal.stopCount, 1);
  assert.equal(terminal.output, stoppedOutput);
});

for (const [signal, exitCode] of [
  ["SIGTERM", 143],
  ["SIGHUP", 129],
]) {
  test(`${signal} restores the TUI terminal exactly once`, async () => {
    const terminal = new FakeTerminal();
    const signalTarget = new EventEmitter();
    const runtime = fakeRuntime();
    const running = runMoondogTui({
      application: fakeApplication(),
      runtime,
      terminal,
      signalTarget,
    });

    await waitForStart(terminal);
    await waitFor(() => terminal.output.length > 0);
    const cursorShowsBeforeSignal = terminal.showCursorCount;
    signalTarget.emit(signal);
    await running;
    const stoppedOutput = terminal.output;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(terminal.startCount, 1);
    assert.equal(terminal.stopCount, 1);
    assert.ok(terminal.hideCursorCount >= 1);
    assert.equal(terminal.showCursorCount - cursorShowsBeforeSignal, 1);
    assert.equal(terminal.output, stoppedOutput, "no rendering may resume after terminal cleanup");
    assert.equal(runtime.abortCount, 1);
    assert.equal(signalTarget.exitCode, exitCode);
    assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
    assert.equal(signalTarget.listenerCount("SIGHUP"), 0);
    assert.equal(signalTarget.listenerCount("uncaughtExceptionMonitor"), 0);
  });
}

test("an uncaught failure monitor restores the TUI without swallowing the failure", async () => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  const runtime = fakeRuntime();
  const running = runMoondogTui({
    application: fakeApplication(),
    runtime,
    terminal,
    signalTarget,
  });

  await waitForStart(terminal);
  await waitFor(() => terminal.output.length > 0);
  const cursorShowsBeforeSignal = terminal.showCursorCount;
  signalTarget.emit(
    "uncaughtExceptionMonitor",
    new Error("synthetic failure"),
    "uncaughtException",
  );
  await running;
  const stoppedOutput = terminal.output;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(terminal.stopCount, 1);
  assert.equal(terminal.showCursorCount - cursorShowsBeforeSignal, 1);
  assert.equal(terminal.output, stoppedOutput, "no rendering may resume after terminal cleanup");
  assert.equal(runtime.abortCount, 1);
  assert.equal(signalTarget.listenerCount("uncaughtException"), 0);
});

test("a startup failure still restores the terminal and removes listeners", async () => {
  class FailingTerminal extends FakeTerminal {
    start(onInput, onResize) {
      super.start(onInput, onResize);
      throw new Error("synthetic start failure");
    }
  }

  const terminal = new FailingTerminal();
  const signalTarget = new EventEmitter();

  await assert.rejects(
    runMoondogTui({
      application: fakeApplication(),
      runtime: fakeRuntime(),
      terminal,
      signalTarget,
    }),
    /synthetic start failure/,
  );

  assert.equal(terminal.startCount, 1);
  assert.equal(terminal.stopCount, 1);
  assert.equal(terminal.showCursorCount, 1);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
  assert.equal(signalTarget.listenerCount("SIGHUP"), 0);
  assert.equal(signalTarget.listenerCount("uncaughtExceptionMonitor"), 0);
});

test("Ctrl+C preserves streamed text and reports cancellation instead of failure", async () => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  let resolvePrompt;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const runtime = {
    abortCount: 0,
    publicStatus() {
      return {
        state: "configured",
        provider: "faux",
        model: "faux-1",
      };
    },
    async prompt(_text, callbacks) {
      callbacks.onTextDelta("partial answer");
      resolveStarted();
      return await new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    },
    abort() {
      this.abortCount += 1;
      resolvePrompt({ status: "aborted", text: "partial answer" });
    },
    reset() {},
  };
  const running = runMoondogTui({
    application: fakeApplication(),
    runtime,
    terminal,
    signalTarget,
  });

  await waitForStart(terminal);
  terminal.send("hello");
  terminal.send("\r");
  await started;
  terminal.send("\u0003");
  await waitFor(() => terminal.output.includes("Cancelled."));

  assert.equal(runtime.abortCount, 1);
  assert.match(terminal.output, /partial answer/);
  assert.doesNotMatch(terminal.output, /Runtime error|model request failed/i);

  terminal.send("/quit");
  terminal.send("\r");
  await running;
  assert.equal(terminal.stopCount, 1);
});

test("TUI renders trusted capability labels for tool lifecycle events", async () => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  let replacementCallbackSeen = false;
  let resolvePromptCompleted;
  const promptCompleted = new Promise((resolve) => {
    resolvePromptCompleted = resolve;
  });
  const runtime = {
    publicStatus() {
      return {
        state: "configured",
        provider: "faux",
        model: "faux-1",
      };
    },
    async prompt(_text, callbacks) {
      assert.equal(typeof callbacks.onTextReplace, "function");
      callbacks.onToolStart({
        toolCallId: "tool-1",
        toolName: "PRIVATE_MACHINE_TOOL_NAME",
        capabilityId: "library.search",
        label: "Search your music library",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      callbacks.onToolEnd({
        toolCallId: "tool-1",
        toolName: "PRIVATE_MACHINE_TOOL_NAME",
        capabilityId: "library.search",
        label: "Search your music library",
        isError: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      callbacks.onToolStart({
        toolCallId: "tool-2",
        toolName: "PRIVATE_SECOND_TOOL_NAME",
        capabilityId: "profile.explain",
        label: "Explain profile evidence",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      callbacks.onToolEnd({
        toolCallId: "tool-2",
        toolName: "PRIVATE_SECOND_TOOL_NAME",
        capabilityId: "profile.explain",
        label: "Explain profile evidence",
        isError: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      callbacks.onTextDelta("Untrusted preview.");
      callbacks.onTextReplace("Grounded result.");
      replacementCallbackSeen = true;
      return await new Promise((resolve) => {
        setImmediate(() => {
          resolve({ status: "completed", text: "Grounded result." });
          setImmediate(resolvePromptCompleted);
        });
      });
    },
    abort() {},
    reset() {},
  };
  const running = runMoondogTui({
    application: fakeApplication(),
    runtime,
    terminal,
    signalTarget,
  });

  await waitForStart(terminal);
  terminal.send("plan from my library");
  terminal.send("\r");
  await promptCompleted;

  assert.equal(replacementCallbackSeen, true);
  assert.match(terminal.output, /Using capability: Search your music library/);
  assert.match(terminal.output, /Capability finished: Search your music library/);
  assert.match(terminal.output, /Using capability: Explain profile evidence/);
  assert.match(terminal.output, /Capability failed: Explain profile evidence/);
  assert.doesNotMatch(
    terminal.output,
    /PRIVATE_MACHINE_TOOL_NAME|PRIVATE_SECOND_TOOL_NAME/,
  );

  terminal.send("/quit");
  terminal.send("\r");
  await running;
});

test("TUI reports a model failure and accepts the next prompt", async () => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  let promptCount = 0;
  const runtime = {
    publicStatus() {
      return {
        state: "configured",
        provider: "faux",
        model: "faux-1",
      };
    },
    async prompt(_text, callbacks) {
      promptCount += 1;
      if (promptCount === 1) {
        throw new Error("Synthetic provider outage.");
      }
      callbacks.onTextDelta("Recovered response.");
      return { status: "completed", text: "Recovered response." };
    },
    abort() {},
    reset() {},
  };
  const running = runMoondogTui({
    application: fakeApplication(),
    runtime,
    terminal,
    signalTarget,
  });

  await waitForStart(terminal);
  terminal.send("first prompt");
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("The model request failed."));
  assert.match(terminal.output, /Runtime error: Synthetic provider outage/);

  terminal.send("second prompt");
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Recovered response."));
  assert.equal(promptCount, 2);

  terminal.send("/quit");
  terminal.send("\r");
  await running;
});

for (const toolsExecuted of [false, true]) {
  test(`TUI makes a connection failure recoverable after tools=${toolsExecuted}`, async (context) => {
    const terminal = new FakeTerminal();
    const signalTarget = new EventEmitter();
    const prompts = [];
    let failureReady;
    const failedPrompt = new Promise((resolve) => { failureReady = resolve; });
    const runtime = {
      ...configuredFakeRuntime(prompts),
      async prompt(text, callbacks) {
        prompts.push(text);
        if (prompts.length > 1) {
          callbacks.onTextDelta("Recovered response.");
          return { status: "completed", text: "Recovered response." };
        }
        if (toolsExecuted) {
          const tool = { label: "Control Spotify playback", capabilityId: "spotify.player.control" };
          callbacks.onToolStart(tool);
          callbacks.onToolEnd(tool);
        }
        callbacks.onModelRetry?.({ attempt: 1, maxRetries: 2 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        failureReady();
        throw Object.assign(new Error("Could not reach the model provider (ECONNRESET)."), {
          code: "model_connection_failed",
          toolsExecuted,
        });
      },
    };
    const running = runMoondogTui({ application: fakeApplication(), runtime, terminal, signalTarget });
    context.after(async () => {
      signalTarget.emit("SIGTERM");
      await running;
    });

    await waitForStart(terminal);
    terminal.send("Tell me about this song.");
    terminal.send("\r");
    await failedPrompt;
    await waitFor(() => terminal.output.includes("ECONNRESET"));
    const output = stripVTControlCharacters(terminal.output);
    assert.match(output, /Retrying model connection 1\/2/u);
    assert.doesNotMatch(output, /Runtime error:|The model request failed/u);
    assert.equal(prompts.length, 1);
    if (toolsExecuted) {
      assert.match(output, /Check results before repeating/u);
      assert.doesNotMatch(output, /recall your message/u);
      terminal.send("Check the current state.");
    } else {
      assert.match(output, /recall your message/u);
      terminal.send("\u001b[A");
    }
    terminal.send("\r");
    await waitFor(() => terminal.output.includes("Recovered response."));
    assert.deepEqual(prompts, [
      "Tell me about this song.",
      toolsExecuted ? "Check the current state." : "Tell me about this song.",
    ]);
  });
}

test("TUI can select a Pi model and use the rebuilt runtime", async () => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  let selected;
  let promptCount = 0;
  const configuredRuntime = {
    publicStatus() {
      return {
        state: "configured",
        provider: selected.provider,
        model: selected.model,
      };
    },
    async prompt(_text, callbacks) {
      promptCount += 1;
      callbacks.onTextDelta("Selected model response.");
      return { status: "completed", text: "Selected model response." };
    },
    abort() {},
    reset() {},
  };
  const running = runMoondogTui({
    application: fakeApplication(),
    runtime: fakeRuntime(),
    terminal,
    signalTarget,
    providers: () => [
      { id: "openai-codex", name: "OpenAI Codex", modelCount: 1 },
    ],
    models: () => [
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        reasoning: true,
      },
    ],
    async rebuildRuntime(selection) {
      selected = selection;
      return configuredRuntime;
    },
  });

  await waitForStart(terminal);
  terminal.send("/model");
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Choose a Pi provider"));
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Choose a model for openai-codex"));
  terminal.output = "";
  terminal.send("\x1b");
  await waitFor(() => terminal.output.includes("Choose a Pi provider"));
  assert.equal(selected, undefined, "returning to providers must not rebuild the runtime");
  terminal.output = "";
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Choose a model for openai-codex"));
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Model ready."));

  assert.deepEqual(selected, {
    provider: "openai-codex",
    model: "gpt-5.6-terra",
  });
  const selectedModelOutput = stripVTControlCharacters(terminal.output);
  assert.match(selectedModelOutput, /conversation ready/u);
  assert.match(selectedModelOutput, /Using Pi model openai-codex\/gpt-5\.6-terra/u);

  terminal.send("hello selected model");
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Selected model response."));
  assert.equal(promptCount, 1);

  terminal.send("/quit");
  terminal.send("\r");
  await running;
});

test("TUI can start OAuth and resume with reloaded authentication", async () => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  let authCount = 0;
  const configuredRuntime = {
    publicStatus() {
      return {
        state: "configured",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
      };
    },
    abort() {},
    reset() {},
  };
  const running = runMoondogTui({
    application: fakeApplication(),
    runtime: fakeRuntime(),
    terminal,
    signalTarget,
    async runAuth() {
      authCount += 1;
    },
    async rebuildRuntime() {
      return configuredRuntime;
    },
  });

  await waitForStart(terminal);
  terminal.send("/auth openai-codex");
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Authentication complete."));

  assert.equal(authCount, 1);
  assert.equal(terminal.startCount, 2);
  assert.equal(terminal.stopCount, 1);
  assert.match(terminal.output, /openai-codex\/gpt-5\.6-terra/u);

  terminal.send("/quit");
  terminal.send("\r");
  await running;
  assert.equal(terminal.stopCount, 2);
});

for (const command of ["/auth deepseek", "/spotify login"]) {
  test(`${command} redraws immediately after an asynchronous login cancellation`, async (context) => {
    const terminal = new FakeTerminal();
    const signalTarget = new EventEmitter();
    let cancelLogin;
    const login = new Promise((resolve, reject) => { cancelLogin = reject; });
    const running = runMoondogTui({
      application: fakeApplication(), runtime: fakeRuntime(), terminal, signalTarget,
      runAuth: () => login,
      runSpotify: () => login,
      environment: { TERM: "xterm-256color", MOONDOG_MOTION: "off" },
    });
    context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
    await waitFor(() => terminal.output.includes("New conversation"));
    terminal.send(command);
    terminal.send("\r");
    await waitFor(() => terminal.stopCount === 1);
    // A real login waits outside the TUI while its queued render is cancelled.
    await new Promise((resolve) => setTimeout(resolve, 30));
    terminal.output = "";
    cancelLogin(new Error("Fixture login was cancelled."));
    await waitFor(() => terminal.output.includes("Fixture login was cancelled."));
    assert.equal(terminal.startCount, 2);
    assert.match(terminal.output, /Command failed\./u);
    terminal.send("/help");
    terminal.send("\r");
    await waitFor(() => terminal.output.includes("Find a command here"));
  });
}

test("TUI connects the selected API provider and keeps that model through authentication", async (context) => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  const selections = [];
  const authProviders = [];
  let connected = false;
  const running = runMoondogTui({
    application: fakeApplication(),
    runtime: fakeRuntime(),
    terminal,
    signalTarget,
    providers: () => [{ id: "deepseek", name: "DeepSeek", modelCount: 1 }],
    models: () => [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
    async runAuth(provider) { authProviders.push(provider); connected = true; },
    async rebuildRuntime(selection) {
      selections.push(selection);
      return {
        ...fakeRuntime(),
        publicStatus: () => ({
          state: connected ? "configured" : "offline",
          reason: connected ? undefined : "provider_authentication_required",
          provider: selection.provider,
          model: selection.model,
        }),
      };
    },
  });
  context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
  await waitForStart(terminal);
  terminal.send("/model deepseek deepseek-v4-flash");
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Model saved; runtime offline."));
  assert.match(stripVTControlCharacters(terminal.output), /auth deepseek/);
  terminal.send("/auth");
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Authentication complete."));
  assert.deepEqual(authProviders, ["deepseek"]);
  assert.deepEqual(selections, [
    { provider: "deepseek", model: "deepseek-v4-flash" },
    { provider: "deepseek", model: "deepseek-v4-flash" },
  ]);
  assert.equal(terminal.stopCount, 1);
  assert.equal(terminal.startCount, 2);
});

test("TUI offers API providers before any model is selected", async (context) => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  const authProviders = [];
  const running = runMoondogTui({
    application: fakeApplication(), runtime: fakeRuntime(), terminal,
    signalTarget,
    providers: () => [{ id: "moonshotai", name: "Moonshot AI (Kimi)", modelCount: 1 }],
    async runAuth(provider) { authProviders.push(provider); },
  });
  context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
  await waitForStart(terminal);
  terminal.send("/auth"); terminal.send("\r");
  await waitFor(() => stripVTControlCharacters(terminal.output).includes("Connect a model provider"));
  assert.match(stripVTControlCharacters(terminal.output), /Moonshot AI \(Kimi\)/);
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Authentication complete."));
  assert.deepEqual(authProviders, ["moonshotai"]);
});

test("TUI can authorize Spotify and reload Spotify agent tools", async () => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  const calls = [];
  let spotifyReady = false;
  const application = {
    async sourceStatus() {
      return { state: "missing", latest: null };
    },
    spotifyReady() {
      return spotifyReady;
    },
    spotifyStatus() {
      return {
        provider: "spotify",
        state: spotifyReady ? "ready" : "not_authenticated",
      };
    },
  };
  const configuredRuntime = {
    publicStatus() {
      return {
        state: "configured",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        external_effects: spotifyReady ? "spotify_control" : "disabled",
      };
    },
    abort() {},
    reset() {},
  };
  const running = runMoondogTui({
    application,
    runtime: fakeRuntime(),
    terminal,
    signalTarget,
    async runSpotify(args) {
      calls.push(args);
      spotifyReady = true;
      return "Spotify authorization: stored";
    },
    async rebuildRuntime() {
      return configuredRuntime;
    },
  });

  await waitForStart(terminal);
  terminal.send("/spotify login client_id_12345678");
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Spotify login complete."));

  assert.deepEqual(calls, [["login", "client_id_12345678"]]);
  assert.equal(terminal.startCount, 2);
  assert.equal(terminal.stopCount, 1);
  assert.match(terminal.output, /Spotify connected/u);
  assert.equal(configuredRuntime.publicStatus().external_effects, "spotify_control");

  terminal.send("/quit");
  terminal.send("\r");
  await running;
});

test("TUI web commands work without a model and Ctrl+C cancels only the local request", async (context) => {
  const terminal = new FakeTerminal();
  const runtime = fakeRuntime();
  let received;
  let webSignal;
  const running = runMoondogTui({
    application: fakeApplication(), runtime, terminal, signalTarget: new EventEmitter(),
    runWeb: async (args, { signal }) => {
      received = args;
      if (args[0] === "status") return "Codex web research: configured.";
      webSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Web research cancelled.")), { once: true }));
    },
  });
  await waitForStart(terminal);
  context.after(async () => { terminal.send("\u0003"); terminal.send("\u0003"); });
  terminal.send('/web search "Artist interview"');
  terminal.send("\r");
  await waitFor(() => webSignal !== undefined);
  assert.deepEqual(received, ["search", "Artist interview"]);
  terminal.send("\u0003");
  await waitFor(() => terminal.output.includes("Web research cancelled."));
  assert.equal(webSignal.aborted, true);
  assert.equal(runtime.abortCount, 0);
  terminal.send('/web status');
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Codex web research: configured."));
  terminal.send('/quit');
  terminal.send("\r");
  await running;
  assert.equal(terminal.stopCount, 1);
});


test("record sleeve uses terminal characters and fits the opening at every supported terminal size", () => {
  const previous = getCapabilities();
  const environment = { TERM: "xterm-256color", COLORTERM: "truecolor" };
  const theme = createMoondogTheme({ mode: "paper", environment });
  const terminal = new FakeTerminal();
  try {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const sleeve = new RecordSleeve({ terminal, getTheme: () => theme, environment });
    assert.match(sleeve.render(80).join("\n"), /[\u2801-\u28ff]/u, "the default opening uses Braille art");
    for (const mode of ["auto", "braille", "ascii", "text", "off"]) {
      sleeve.setArtMode(mode);
      for (const [columns, rows] of [[120, 40], [116, 35], [100, 38], [80, 24], [40, 18], [32, 12]]) {
        terminal.columns = columns;
        terminal.rows = rows;
        const lines = sleeve.render(columns);
        const rendered = lines.join("\n");
        const chromeRows = rows >= 20 ? 7 : 6;
        assert.equal(lines.length + chromeRows, rows, `${mode} ${columns}x${rows} opening must fill the viewport with input and footer at the bottom`);
        for (const line of lines) {
          assert.equal(typeof line, "string");
          assert.ok(visibleWidth(line) <= columns, `${mode} ${columns}x${rows} line must fit the terminal`);
        }
        assert.doesNotMatch(rendered, /\x1b_G|\x1b\]1337;File|\x1bP[\d;?]*q|\[Image:/u);
        if (["ascii", "text", "off"].includes(mode)) {
          assert.doesNotMatch(rendered, /[\u2800-\u28ff]/u, `${mode} must not contain Braille`);
        }
        if (columns >= 80 && mode !== "off") {
          assert.match(stripVTControlCharacters(rendered), ["ascii", "text"].includes(mode) ? /[._/\\|()#*+=:-]{3}/u : /[\u2801-\u28ff]/u);
        }
      }
    }
    assert.equal(terminal.output, "", "character art must not write an image or deletion payload directly to the terminal");
  } finally { setCapabilities(previous); }
});

test("the actual home viewport stays filled through resize and multiline draft reflow", async (context) => {
  const terminal = new FakeTerminal();
  terminal.columns = 116;
  terminal.rows = 35;
  const signalTarget = new EventEmitter();
  const prompts = [];
  const frames = [];
  const doRender = TuiMainScreen.prototype.doRender;
  context.mock.method(TuiMainScreen.prototype, "doRender", function () {
    const result = doRender.call(this);
    frames.push(this.captureRenderState());
    return result;
  });
  const running = runMoondogTui({
    application: fakeApplication(), runtime: configuredFakeRuntime(prompts), terminal, signalTarget,
    environment: { TERM: "xterm-256color", COLORTERM: "truecolor", MOONDOG_ART: "braille", MOONDOG_MOTION: "off" },
  });
  context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
  const nextFrame = async (action = () => {}) => {
    const before = frames.length;
    action();
    for (let attempt = 0; attempt < 50 && frames.length === before; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(frames.length > before, "the terminal must render the changed viewport");
    return frames.at(-1);
  };
  const assertViewport = (frame, hasDraft = false) => {
    assert.equal(frame.previousWidth, terminal.columns);
    assert.equal(frame.previousHeight, terminal.rows);
    assert.equal(frame.previousLines.length, terminal.rows, "home must paint every viewport row");
    assert.equal(frame.previousViewportTop, 0, "home must not push its header into scrollback");
    const lines = frame.previousLines.map(stripVTControlCharacters);
    assert.match(lines[0], /^ MOONDOG/u);
    assert.match(lines[1], terminal.columns < 60 ? /model ready/u : /conversation ready/u);
    assert.match(lines.at(-1), hasDraft ? /enter send|commands/u : /tab explore|\/resume history/u);
    assert.ok(lines.some((line) => line.includes(" YOU ")), "the input border must remain visible");
    const footerRows = terminal.rows >= 20 ? 2 : 1;
    assert.ok(frame.hardwareCursorRow >= 2 && frame.hardwareCursorRow < terminal.rows - footerRows, "the draft cursor must remain above the footer");
    for (const line of frame.previousLines) assert.equal(visibleWidth(line), terminal.columns);
  };
  const resize = (columns, rows) => nextFrame(() => {
    terminal.columns = columns;
    terminal.rows = rows;
    terminal.onResize();
  });

  await waitForStart(terminal);
  const firstFrame = frames.length ? frames.at(-1) : await nextFrame();
  assertViewport(firstFrame);
  assertViewport(await resize(40, 18));
  const draft = "First listening thought\nA second thought about quiet music and slow rhythms";
  assertViewport(await nextFrame(() => terminal.send(`\x1b[200~${draft}\x1b[201~`)), true);
  assertViewport(await resize(32, 12), true);
  const expanded = await resize(120, 40);
  assertViewport(expanded, true);
  const expandedText = expanded.previousLines.map(stripVTControlCharacters).join("\n");
  for (const line of draft.split("\n")) assert.ok(expandedText.includes(line), "the complete draft must survive resize and reflow");
  assert.deepEqual(prompts, []);
  terminal.send("\r");
  await waitFor(() => prompts.length === 1);
  assert.deepEqual(prompts, [draft]);
});

for (const environment of [{ TERM: "xterm-256color", NO_COLOR: "" }, { TERM: "dumb" }]) {
  test(`record sleeve retains monochrome character art with ${environment.TERM === "dumb" ? "TERM=dumb" : "NO_COLOR"}`, () => {
    const theme = createMoondogTheme({ environment });
    const terminal = new FakeTerminal();
    const sleeve = new RecordSleeve({ terminal, getTheme: () => theme, environment });
    const rendered = sleeve.render(terminal.columns).join("\n");
    assert.doesNotMatch(rendered, /\x1b\[[\d;]*m|\x1b_G|\x1b\]1337;File|\x1bP[\d;?]*q|\[Image:/u);
    if (environment.TERM === "dumb") {
      assert.doesNotMatch(rendered, /[\u2800-\u28ff]/u);
      assert.match(rendered, /[._/\\|()#*+=:-]{3}/u);
    } else {
      assert.match(rendered, /[\u2801-\u28ff]/u, "NO_COLOR must retain the drawing without color");
    }
  });
}

test("plain terminal styling preserves Pi's cursor marker", () => {
  const theme = createMoondogTheme({ environment: { NO_COLOR: "" } });
  const line = paintBrandLine(` ${CURSOR_MARKER}\x1b[7m \x1b[0m`, 40, theme);
  assert.ok(line.includes(CURSOR_MARKER));
  assert.equal(visibleWidth(line), 40);
  assert.doesNotMatch(line, /\x1b\[[\d;]*m/u);
});

test("home, appearance controls, and the import guide never call a model or discard conversation", async (context) => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  let modelCalls = 0;
  const runtime = { ...fakeRuntime(), async prompt() { modelCalls += 1; } };
  const running = runMoondogTui({
    application: fakeApplication(),
    runtime, terminal, signalTarget,
    environment: { TERM: "xterm-256color", COLORTERM: "truecolor", MOONDOG_ART: "text", MOONDOG_MOTION: "off" },
  });
  context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
  await waitForStart(terminal);
  const submit = async (command, expected) => {
    terminal.output = "";
    terminal.send(command);
    terminal.send("\r");
    for (let attempt = 0; attempt < 100 && !terminal.output.includes(expected); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(terminal.output.includes(expected), terminal.output);
  };
  await submit("Retained listening request", "Retained listening request");
  await submit("/home", "M O O N D O G");
  await submit("/theme paper", "Paper theme.");
  await submit("/theme charcoal", "Charcoal theme.");
  await submit("/import", "Get Spotify history");
  assert.match(terminal.output, /Choose a file/u);
  assert.doesNotMatch(terminal.output, /spotify import-history/u);
  terminal.output = "";
  terminal.send("\x1b");
  await waitFor(() => terminal.output.includes("M O O N D O G"));
  await submit("/theme nonexistent", "Usage: /theme");
  assert.match(terminal.output, /Retained listening request/u);
  assert.equal(modelCalls, 0);
});

test("Tab focuses home actions and Down then Enter opens the import guide without a model call", async (context) => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  const prompts = [];
  let imports = 0;
  const running = runMoondogTui({
    application: fakeApplication(),
    runtime: configuredFakeRuntime(prompts), terminal, signalTarget,
    environment: { TERM: "xterm-256color", MOONDOG_ART: "ascii", MOONDOG_MOTION: "off" },
    async runSpotify() { imports += 1; },
  });
  context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
  await waitForStart(terminal);
  await waitFor(() => terminal.output.includes("M O O N D O G"));
  terminal.output = "";
  terminal.send("\t");
  terminal.send("\x1b[B");
  terminal.send("\r");
  await waitFor(() => terminal.output.includes("Get Spotify history"));
  assert.match(terminal.output, /Choose a file/u);
  assert.doesNotMatch(terminal.output, /spotify import-history/u);
  assert.deepEqual(prompts, []);
  assert.equal(imports, 0, "choosing Import must not import before a file is inspected and confirmed");
  terminal.output = "";
  terminal.send("\x1b");
  await waitFor(() => terminal.output.includes("M O O N D O G"));
});

test("Esc returns from home actions to the editor and the next request reaches the model intact", async (context) => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  const prompts = [];
  const running = runMoondogTui({
    application: fakeApplication(),
    runtime: configuredFakeRuntime(prompts), terminal, signalTarget,
    environment: { TERM: "xterm-256color", MOONDOG_ART: "ascii", MOONDOG_MOTION: "off" },
  });
  context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
  await waitForStart(terminal);
  await waitFor(() => terminal.output.includes("M O O N D O G"));
  terminal.send("\t");
  terminal.send("\x1b[B");
  terminal.send("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  const request = "Find something quiet from my listening history";
  for (const character of request) terminal.send(character);
  terminal.send("\r");
  await waitFor(() => prompts.length === 1);
  assert.deepEqual(prompts, [request]);
  assert.doesNotMatch(terminal.output, /Paste the ZIP path between the quotes|Local command failed/u);
});

test("Ctrl+P filters Commands and Esc preserves the complete input draft for submission", async (context) => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  const prompts = [];
  let localCommands = 0;
  const running = runMoondogTui({
    application: {
      ...fakeApplication(),
      async runLocalCommand() { localCommands += 1; return {}; },
    },
    runtime: configuredFakeRuntime(prompts), terminal, signalTarget,
    environment: { TERM: "xterm-256color", MOONDOG_ART: "ascii", MOONDOG_MOTION: "off" },
  });
  context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
  await waitForStart(terminal);
  await waitFor(() => terminal.output.includes("M O O N D O G"));
  const draft = "Build a quiet playlist, then explain each selection";
  for (const character of draft) terminal.send(character);
  terminal.send("\x10");
  await waitFor(() => /Commands/u.test(terminal.output));
  terminal.output = "";
  terminal.send("taste");
  await waitFor(() => /taste/iu.test(terminal.output));
  assert.deepEqual(prompts, []);
  assert.equal(localCommands, 0, "filtering must not invoke the selected command");
  terminal.send("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  terminal.send("\r");
  await waitFor(() => prompts.length === 1);
  assert.deepEqual(prompts, [draft], "the palette search must neither replace nor append to the original draft");
  assert.equal(localCommands, 0, "cancelling the palette must not execute /taste");
});

test("the home artwork visibly animates, pauses during interaction, and stops when motion or art is off", async (context) => {
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  const render = context.mock.method(RecordSleeve.prototype, "render");
  const running = runMoondogTui({
    application: fakeApplication(), runtime: fakeRuntime(), terminal, signalTarget,
    environment: {
      TERM: "xterm-256color", COLORTERM: "truecolor",
      MOONDOG_ART: "braille", MOONDOG_MOTION: "on",
    },
  });
  context.after(async () => { signalTarget.emit("SIGTERM"); await running; });
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const expectMotion = async (label) => {
    await delay(25);
    terminal.output = "";
    await delay(300);
    const frames = terminal.output.match(/\x1b\[\?2026h[\s\S]*?\x1b\[\?2026l/gu) ?? [];
    assert.ok(frames.length >= 2, `${label}: the idle homepage must display successive animation frames`);
    assert.ok(new Set(frames).size >= 2, `${label}: successive rendered frames must visibly differ`);
  };
  const expectStill = async (label) => {
    await delay(25);
    const outputBefore = terminal.output;
    const rendersBefore = render.mock.callCount();
    await delay(180);
    assert.equal(terminal.output, outputBefore, `${label}: the terminal must remain visually still`);
    assert.equal(render.mock.callCount(), rendersBefore, `${label}: the artwork must not redraw in the background`);
  };
  const submit = async (command) => {
    terminal.send(command);
    terminal.send("\r");
    await new Promise((resolve) => setImmediate(resolve));
  };

  await waitForStart(terminal);
  await waitFor(() => terminal.output.length > 0);
  await expectMotion("empty homepage");

  terminal.send("A quiet listening draft");
  await expectStill("nonempty draft");
  terminal.send("\x15");
  terminal.send("\t");
  await expectStill("home action navigation");
  terminal.send("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  terminal.send("\x10");
  await expectStill("Commands palette");
  terminal.send("\x1b");
  await new Promise((resolve) => setImmediate(resolve));

  await submit("/motion off");
  await expectStill("motion off");
  await submit("/motion on");
  await expectMotion("motion restored");
  await submit("/art off");
  await expectStill("art off");

  await submit("/quit");
  await running;
  await expectStill("after exit");
  assert.equal(terminal.stopCount, 1);
});
