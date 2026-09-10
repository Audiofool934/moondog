import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { fictionalSpotifyHistoryEntries } from "../../src/demo/fictional-spotify-history.mjs";
import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { runProfileCommand } from "../../src/surfaces/cli/profile-command.mjs";
import { runMoondogTui } from "../../src/surfaces/cli/tui.mjs";

class FakeTerminal {
  columns = 100;
  rows = 34;
  kittyProtocolActive = false;
  startCount = 0;
  stopCount = 0;
  output = "";
  rendered = [];
  renderedColumns = 0;
  renderedRows = 0;

  start(onInput, onResize) { this.startCount += 1; this.onInput = onInput; this.onResize = onResize; }
  stop() { this.stopCount += 1; }
  async drainInput() {}
  write(data) { this.output += data; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  send(data) { this.onInput(data); }

  resize(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.onResize();
  }

  get text() { return stripVTControlCharacters(this.output); }
  get body() { return this.rendered.map(stripVTControlCharacters).join("\n"); }
}

async function waitFor(condition, description, terminal) {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${description}.\n${terminal?.text.slice(-2_000) ?? ""}`);
}

async function createTasteFixture(context, { imported = true, configured = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-tui-taste-loop-"));
  const environment = {
    MOONDOG_STATE_HOME: path.join(root, "state"),
    MOONDOG_CONFIG_HOME: path.join(root, "config"),
    MOONDOG_ART: "ascii",
    MOONDOG_MOTION: "off",
    TERM: "xterm-256color",
  };
  const terminal = new FakeTerminal();
  const signalTarget = new EventEmitter();
  let store;
  let application;
  let running;
  context.after(async () => {
    try {
      signalTarget.emit("SIGTERM");
      await running;
    } finally {
      if (application) application.close();
      else store?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  store = await openListeningHistoryStore({ environment });
  const subjectId = store.localSubjectId({ create: true });
  const entries = fictionalSpotifyHistoryEntries();
  const projectedImport = projectSpotifyExtendedStreamingHistory({
    subjectId,
    capturedAt: "2026-09-05T00:00:00.000Z",
    archiveSha256: "c".repeat(64),
    archiveSizeBytes: entries.reduce((sum, entry) => sum + entry.data.length, 0),
    memberNames: entries.map((entry) => path.basename(entry.name)),
    records: entries.flatMap((entry) => JSON.parse(entry.data)),
  });
  if (imported) store.ingestImport(projectedImport);
  application = new MoondogApplication({
    importsRoot: path.join(root, "no-apple-imports"),
    domainServices: createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId }),
  });
  const profileActions = [];
  const spotifyActions = [];
  const prompts = [];
  const runtime = {
    publicStatus() {
      return configured
        ? { state: "configured", provider: "faux", model: "faux-1" }
        : { state: "offline", reason: "model_not_configured" };
    },
    abort() {},
    reset() {},
    async prompt(value) { prompts.push(value); throw new Error("The local taste loop must not prompt a model."); },
  };

  // Observe complete component frames, so UI assertions cannot pass on stale scrollback.
  const render = TuiMainScreen.prototype.render;
  context.mock.method(TuiMainScreen.prototype, "render", function (width) {
    const lines = render.call(this, width);
    terminal.rendered = [...lines];
    terminal.renderedColumns = width;
    terminal.renderedRows = terminal.rows;
    return lines;
  });

  const waitBody = async (text) => waitFor(() => terminal.body.includes(text), `visible ${text}`, terminal);
  const waitOutput = async (text) => waitFor(() => terminal.text.includes(text), text, terminal);
  const fixture = {
    application, terminal, profileActions, spotifyActions, prompts,
    waitBody, waitOutput,
    async summary() { return application.getProfileSummary({ maxItems: 10 }); },
    async persistedCorrections({ includeInactive = false } = {}) {
      const inspection = await openListeningHistoryStore({ environment });
      try {
        return inspection.listListenerCorrections({ subjectId, includeInactive });
      } finally {
        inspection.close();
      }
    },
    async launch() {
      running = runMoondogTui({
        application, runtime, terminal, signalTarget, environment,
        async runSpotify(args) {
          spotifyActions.push([...args]);
          assert.deepEqual(args, ["import-history", "/tmp/Fictional Music History.zip"]);
          store.ingestImport(projectedImport);
          return "Spotify history import completed.";
        },
        async runProfile(args) {
          let output = "";
          await runProfileCommand({
            args, environment, commandPrefix: "/profile",
            output: { write(value) { output += value; } },
          });
          return output;
        },
        async runProfileAction(args) {
          const result = await runProfileCommand({
            args, environment, commandPrefix: "/profile",
            output: { write() {} },
          });
          profileActions.push({ args: [...args], result });
          return result;
        },
      });
      await waitBody("New conversation");
    },
    async submit(command, expected) {
      terminal.output = "";
      terminal.send(command);
      terminal.send("\r");
      await waitOutput(expected);
      assert.doesNotMatch(terminal.text, /Local command failed|Profile action failed/u);
    },
    async openFromDraft() {
      terminal.output = "";
      terminal.send("\x10");
      await waitOutput("Commands");
      terminal.send("taste");
      await waitOutput("/taste");
      terminal.send("\r");
      await waitBody("Your listening profile");
    },
    async chooseAction(label, expected) {
      terminal.output = "";
      terminal.send("\r");
      await waitOutput(label);
      terminal.send(label);
      terminal.output = "";
      terminal.send("\r");
      await waitOutput(expected);
    },
    async resize(columns, rows) {
      terminal.resize(columns, rows);
      await waitFor(() => terminal.renderedColumns === columns && terminal.renderedRows === rows,
        `profile resized to ${columns}x${rows}`, terminal);
      assert.ok(terminal.rendered.length <= rows, `${terminal.rendered.length} rendered rows exceed ${rows}`);
      for (const line of terminal.rendered) assert.ok(visibleWidth(line) <= columns);
    },
    async leaveProfile(expected) {
      terminal.output = "";
      terminal.send("\x1b");
      await waitBody(expected);
      assert.ok(!terminal.body.includes("Your listening profile"));
    },
  };
  return fixture;
}

test("native taste track Avoid persists, remains selectable after refresh, and retracts the exact correction", async (context) => {
  const fixture = await createTasteFixture(context);
  const { terminal, profileActions } = fixture;
  const before = await fixture.summary();
  await fixture.launch();
  await fixture.submit("/taste", "Your listening profile");
  terminal.send("Midnight Lines");
  await fixture.waitBody("Midnight Lines");
  await fixture.chooseAction("Avoid", "Saved: Avoid");

  assert.deepEqual(profileActions[0].args, ["correct", "--track", "Midnight Lines", "--by", "Mara Vale", "--avoid"]);
  const [assertion] = await fixture.persistedCorrections();
  assert.equal(assertion.entity_type, "track");
  assert.equal(assertion.label, "Midnight Lines");
  assert.equal(assertion.artist_credit, "Mara Vale");
  assert.equal(assertion.stance, "avoid");
  const corrected = await fixture.summary();
  assert.equal(corrected.coverage.effective_listening_events, before.coverage.effective_listening_events);
  assert.ok(!corrected.listening_behavior.time_capsule_tracks.some((track) => track.title === "Midnight Lines"));

  await fixture.resize(80, 24);
  await fixture.waitBody("Midnight Lines");
  await fixture.chooseAction("Retract my choice", "Retracted:");
  assert.deepEqual(profileActions[1].args, ["retract", assertion.correction_id]);
  assert.deepEqual(await fixture.persistedCorrections(), []);
  const history = await fixture.persistedCorrections({ includeInactive: true });
  assert.equal(history[0].correction_id, assertion.correction_id);
  assert.equal(history[0].state, "retracted");
  const restored = await fixture.summary();
  assert.deepEqual(restored.listening_behavior.time_capsule_tracks, before.listening_behavior.time_capsule_tracks);
  assert.deepEqual(fixture.prompts, []);
});

test("artist Like uses artist semantics and restores the exact draft after profile navigation and resize", async (context) => {
  const fixture = await createTasteFixture(context, { configured: true });
  const { terminal, profileActions } = fixture;
  await fixture.launch();
  const draft = 'Keep "this" listening draft intact.';
  terminal.send(draft);
  await fixture.waitBody(draft);
  await fixture.openFromDraft();
  terminal.send("\t");
  terminal.send("\t");
  terminal.send("Mara Vale");
  await fixture.waitBody("Mara Vale");
  terminal.output = "";
  terminal.send("\x10");
  await fixture.waitOutput("Commands");
  terminal.send("\x1b");
  await fixture.waitBody("Your listening profile");
  assert.match(terminal.body, /Mara Vale/u);
  await fixture.resize(44, 14);
  await fixture.resize(100, 34);
  await fixture.chooseAction("Like", "Saved: Like");
  assert.deepEqual(profileActions[0].args, ["correct", "--artist", "Mara Vale", "--like"]);
  const [assertion] = await fixture.persistedCorrections();
  assert.equal(assertion.entity_type, "artist");
  assert.equal(assertion.label, "Mara Vale");
  assert.equal(assertion.stance, "like");
  await fixture.leaveProfile(draft);
  assert.match(terminal.body, /Saved: Like/u);
  assert.deepEqual(fixture.prompts, []);
});

test("a saved choice survives refresh failure and retry does not write it twice", async (context) => {
  const fixture = await createTasteFixture(context);
  await fixture.launch();
  await fixture.submit("/taste", "Your listening profile");
  fixture.terminal.send("Midnight Lines");
  await fixture.waitBody("Midnight Lines");
  const getSummary = fixture.application.getProfileSummary.bind(fixture.application);
  let failRefresh = true;
  context.mock.method(fixture.application, "getProfileSummary", async (input) => {
    if (failRefresh) { failRefresh = false; throw new Error("Temporary profile read failure"); }
    return getSummary(input);
  });
  await fixture.chooseAction("Avoid", "Refresh failed");
  assert.equal((await fixture.persistedCorrections())[0].stance, "avoid");
  fixture.terminal.output = "";
  fixture.terminal.send("\r");
  await fixture.waitOutput("Profile refreshed. Select a reading");
  await fixture.waitBody("You avoid this");
  assert.equal(fixture.profileActions.length, 1);
  assert.deepEqual(fixture.prompts, []);
});

test("escaping profile actions returns to browsing, then home with the draft; taste report remains available", async (context) => {
  const fixture = await createTasteFixture(context);
  const { terminal } = fixture;
  await fixture.launch();
  const draft = "A draft for later listening";
  terminal.send(draft);
  await fixture.waitBody(draft);
  await fixture.openFromDraft();
  terminal.send("Midnight Lines");
  await fixture.waitBody("Midnight Lines");
  terminal.output = "";
  terminal.send("\r");
  await fixture.waitOutput("Why this reading");
  terminal.send("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.waitBody("Your listening profile");
  terminal.send("\x1b[B");
  terminal.send("\x1b[A");
  await fixture.leaveProfile(draft);
  assert.match(terminal.body, /Bring your history/u);
  assert.deepEqual(fixture.profileActions, []);
  assert.deepEqual(await fixture.persistedCorrections(), []);
  terminal.send("\x05");
  terminal.send("\x15");
  await fixture.submit("/taste report", "Your Moondog tasteprint");
  assert.match(terminal.body, /Listening Time Machine/u);
  assert.deepEqual(fixture.prompts, []);
});

test("a completed history import opens the cumulative native profile and preserves the receipt and report", async (context) => {
  const fixture = await createTasteFixture(context, { imported: false });
  const { terminal } = fixture;
  await fixture.launch();
  await fixture.submit('/spotify import-history "/tmp/Fictional Music History.zip"', "Your listening profile");
  await fixture.waitBody("cumulative local profile");
  assert.match(terminal.body, /Midnight Lines/u);
  const firstImport = await fixture.summary();
  assert.ok(firstImport.coverage.effective_listening_events > 0);
  await fixture.leaveProfile("Spotify history import completed.");
  assert.match(terminal.body, /Your Moondog tasteprint/u);
  assert.match(terminal.body, /Listening Time Machine/u);
  await fixture.submit('/spotify import-history "/tmp/Fictional Music History.zip"', "Your listening profile");
  const repeatedImport = await fixture.summary();
  assert.equal(repeatedImport.coverage.effective_listening_events, firstImport.coverage.effective_listening_events);
  assert.equal(fixture.spotifyActions.length, 2);
  assert.deepEqual(fixture.prompts, []);
});
