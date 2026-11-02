import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { runMoondogTui } from "../../src/surfaces/cli/tui.mjs";

async function until(predicate) {
  const deadline = performance.now() + 2500;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "TUI did not reach the expected frame");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function launch(context, generation) {
  const terminal = {
    columns: 120, rows: 30, kittyProtocolActive: false, stops: 0, output: "",
    start(input) { this.input = input; },
    stop() { this.stops += 1; },
    async drainInput() {},
    write(data) { this.output += data; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const signalTarget = new EventEmitter();
  const fixture = { terminal, lines: [] };
  const doRender = TuiAltScreen.prototype.doRender;
  context.mock.method(TuiAltScreen.prototype, "doRender", function () {
    doRender.call(this);
    fixture.lines = (this.previousScreen ?? []).map(stripVTControlCharacters);
  });
  fixture.body = () => fixture.lines.join("\n");
  fixture.status = () => fixture.lines.at(-2) ?? "";
  fixture.submit = (text) => { terminal.input(text); terminal.input("\r"); };
  const running = runMoondogTui({
    application: { async sourceStatus() { return { state: "missing", latest: null }; } },
    runtime: { publicStatus: () => ({ state: "configured", provider: "fixture", model: "offline-test" }), reset() {}, abort() {} },
    terminal, signalTarget, generation,
    environment: { TERM: "xterm-256color", MOONDOG_ART: "off", MOONDOG_MOTION: "off" },
  });
  context.after(async () => {
    signalTarget.emit("SIGTERM");
    await running;
    assert.equal(terminal.stops, 1);
    assert.equal(generation.setup.listeners.size, 0, "a closed room stops watching the setup");
  });
  return fixture;
}

// Stands in for the core's setup and generator: the test says what the setup reports.
function fakeGeneration() {
  const models = () => ({ medium: { state: "absent", bytes: 0, total: 5_179_055_990 }, "small-music": { state: "absent", bytes: 0, total: 1_704_727_702 } });
  const setup = {
    listeners: new Set(),
    calls: [],
    current: { supported: true, root: "/tmp/sa3", licenses: { accepted: false, at: null }, job: null, models: models(), base: { uv: "absent", code: "absent", python: "absent" } },
    emit(change) { this.current = { ...this.current, ...change }; for (const listener of this.listeners) listener(structuredClone(this.current)); },
    status() { return structuredClone(this.current); },
    install(model, options) { this.calls.push(["install", model, options]); this.emit({ licenses: { accepted: true, at: "now" }, job: { model, step: "uv", received: 0, total: 0, running: true } }); return this.status(); },
    async cancel() { this.calls.push(["cancel"]); this.emit({ job: null }); },
    async remove(model) { this.calls.push(["remove", model]); this.emit({ models: { ...this.current.models, [model]: { state: "absent", bytes: 0, total: this.current.models[model].total } } }); },
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
  };
  let state = { state: "off", enabled: false, install: "missing", path: "/tmp/sa3/mlx", source: "default", managed: false, model: "medium" };
  return {
    setup,
    saves: [],
    status: () => state,
    async check() { return state; },
    async save(settings) {
      this.saves.push(settings);
      const ready = setup.current.models[settings.model ?? state.model]?.state === "ready";
      state = { ...state, ...settings, managed: settings.source === "managed" || state.managed, install: ready ? "ready" : state.install };
      state.state = !state.enabled ? "off" : state.install === "ready" ? "ready" : "missing";
      return state;
    },
  };
}

test("/generation downloads a model after the licenses, shows its progress, and uses it when done", async (context) => {
  const generation = fakeGeneration();
  const fixture = launch(context, generation);
  await until(() => fixture.body().includes("New conversation"));

  fixture.submit("/generation");
  await until(() => fixture.body().includes("Small Music"));
  assert.match(fixture.body(), /Get Stable Audio 3 with \/generation download medium/u);
  assert.match(fixture.body(), /Stable Audio 3 Medium · best sound · 5\.2 GB · not downloaded/u);
  assert.match(fixture.body(), /Stable Audio 3 Small Music · faster, lighter · 1\.7 GB · not downloaded/u);

  // The first download asks for the licenses and starts nothing.
  fixture.submit("/generation download medium");
  await until(() => fixture.body().includes("--agree"));
  assert.match(fixture.body(), /https:\/\/stability\.ai\/license/u);
  assert.match(fixture.body(), /LICENSE_GEMMA\.md/u);
  assert.deepEqual(generation.setup.calls, []);

  fixture.submit("/generation download medium --agree");
  await until(() => generation.setup.calls.length === 1);
  assert.deepEqual(generation.setup.calls[0], ["install", "medium", { accepted: true }]);
  await until(() => fixture.body().includes("↓ Stable Audio 3 Medium · getting uv"));
  generation.setup.emit({ job: { model: "medium", step: "weights", received: 2_200_000_000, total: 5_179_055_990 } });
  await until(() => /↓ Stable Audio 3 Medium · downloading the model 42%\s+· \/generation cancel/u.test(fixture.body()));

  // A second download waits; the agreement is not asked again.
  fixture.submit("/generation download small");
  await until(() => fixture.status().includes("Another download is running."));

  // Done: the line goes. The core's setup turned the new model on itself; the terminal reads that
  // choice and changes no setting of its own.
  const finished = { ...generation.setup.current.models, medium: { state: "ready", bytes: 5_179_055_990, total: 5_179_055_990 } };
  generation.setup.current = { ...generation.setup.current, models: finished };
  await generation.save({ enabled: true, source: "managed", model: "medium" });
  generation.saves.length = 0;
  generation.setup.emit({ job: null, models: finished });
  await until(() => fixture.status().includes("Stable Audio 3 Medium is ready. Ask for a track."));
  assert.deepEqual(generation.saves, [], "the terminal leaves the choice to the core");
  assert.doesNotMatch(fixture.body(), /↓ Stable Audio 3/u);

  fixture.submit("/generation");
  await until(() => fixture.body().includes("installed, in use"));
});

test("/generation cancel stops a download started elsewhere, and remove asks once", async (context) => {
  const generation = fakeGeneration();
  generation.setup.current.licenses = { accepted: true, at: "earlier" };
  const fixture = launch(context, generation);
  await until(() => fixture.body().includes("New conversation"));

  // The window started this download; the terminal sees it through the same setup.
  generation.setup.emit({ job: { model: "small-music", step: "weights", received: 100, total: 1000 } });
  await until(() => fixture.body().includes("↓ Stable Audio 3 Small Music · downloading the model 10%"));
  fixture.submit("/generation remove small --yes");
  await until(() => fixture.body().includes("Wait for the download to finish"));
  fixture.submit("/generation cancel");
  await until(() => generation.setup.calls.some(([name]) => name === "cancel"));
  await until(() => fixture.status().includes("Download stopped. /generation download small picks it up where it left off."));
  assert.doesNotMatch(fixture.body(), /↓ Stable Audio 3/u);

  fixture.submit("/generation use small");
  await until(() => fixture.body().includes("Stable Audio 3 Small Music isn't downloaded yet."));

  generation.setup.emit({ models: { ...generation.setup.current.models, "small-music": { state: "ready", bytes: 1_704_727_702, total: 1_704_727_702 } } });
  fixture.submit("/generation remove small");
  await until(() => fixture.body().includes("It's the last model"));
  assert.ok(!generation.setup.calls.some(([name]) => name === "remove"), "nothing is removed before --yes");
  fixture.submit("/generation remove small --yes");
  await until(() => fixture.body().includes("Removed Stable Audio 3 Small Music from this Mac."));
  assert.deepEqual(generation.setup.calls.at(-1), ["remove", "small-music"]);

  // A failed download says why in one sentence, by the setup's code.
  generation.setup.emit({ job: { model: "medium", step: "weights", received: 0, total: 10, error: { code: "setup_disk_full", message: "There is not enough space on this Mac." } } });
  await until(() => fixture.status().includes("There isn't enough free space on this Mac for the download."));
});

test("/generation without the core's setup keeps on and off only", async (context) => {
  const generation = { ...fakeGeneration(), setup: { listeners: new Set() } };
  const fixture = launch(context, generation);
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("/generation download medium");
  await until(() => fixture.body().includes("Use /generation, /generation on [folder], or /generation off."));
});

test("with the core's real setup, an offline download fails in one sentence and keeps the agreement", async (context) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createStableAudioSetup } = await import("../../src/integrations/stable-audio/setup.mjs");
  const { createLocalGenerator } = await import("../../src/integrations/stable-audio/local-generator.mjs");
  const state = await mkdtemp(`${tmpdir()}/moondog-sa3-tui-`);
  context.after(() => rm(state, { recursive: true, force: true }));
  const environment = { MOONDOG_STATE_HOME: state, MOONDOG_CONFIG_HOME: state, HOME: state };
  const core = createStableAudioSetup({ environment, platform: "darwin", arch: "arm64",
    fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  const generator = createLocalGenerator({ environment, platform: "darwin", arch: "arm64" });
  const listeners = new Set();
  const setup = { ...core, listeners, subscribe(listener) { const stop = core.subscribe(listener); listeners.add(listener); return () => { stop(); listeners.delete(listener); }; } };
  const generation = { status: () => generator.status(), check: () => generator.check(), save: (settings) => generator.save(settings), setup };
  const fixture = launch(context, generation);
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("/generation download small");
  await until(() => fixture.body().includes("--agree"));
  fixture.submit("/generation download small --agree");
  await until(() => fixture.status().includes("The download couldn't reach its source."));
  assert.equal((await core.status()).licenses.accepted, true);
  fixture.submit("/generation");
  await until(() => fixture.body().includes("download stopped on an error"));
});
