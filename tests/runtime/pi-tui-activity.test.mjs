import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { runMoondogTui } from "../../src/surfaces/cli/tui.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  const deadline = performance.now() + 2500;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "TUI did not reach the expected frame");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function launch(context, { runtime: customRuntime, ...options } = {}) {
  const terminal = {
    columns: 100, rows: 28, kittyProtocolActive: false, stops: 0, output: "",
    start(input, resize) { this.input = input; this.resize = resize; },
    stop() { this.stops += 1; },
    async drainInput() {},
    write(data) { this.output += data; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const signalTarget = new EventEmitter();
  const fixture = { terminal, lines: [] };
  const render = TuiMainScreen.prototype.render;
  context.mock.method(TuiMainScreen.prototype, "render", function (width) {
    const lines = render.call(this, width);
    fixture.lines = lines.map(stripVTControlCharacters);
    return lines;
  });
  fixture.body = () => fixture.lines.join("\n");
  fixture.footer = () => fixture.lines.slice(-2).join("\n");
  fixture.send = (data) => terminal.input(data);
  fixture.submit = (text) => { fixture.send(text); fixture.send("\r"); };
  const runtime = {
    aborts: 0,
    publicStatus: () => ({ state: "configured", provider: "fixture", model: "offline-test" }),
    reset() {}, abort() { this.aborts += 1; },
    ...customRuntime,
  };
  fixture.runtime = runtime;
  const running = runMoondogTui({
    application: { async sourceStatus() { return { state: "missing", latest: null }; } },
    runtime, terminal, signalTarget,
    environment: { TERM: "xterm-256color", MOONDOG_ART: "off", MOONDOG_MOTION: "off" },
    ...options,
  });
  context.after(async () => {
    signalTarget.emit("SIGTERM");
    await running;
    assert.equal(terminal.stops, 1);
    assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
    assert.equal(signalTarget.listenerCount("SIGHUP"), 0);
  });
  return fixture;
}

test("a pending local command has truthful cancellation hints and keeps the draft", async (context) => {
  const gate = deferred();
  let started = false;
  const fixture = launch(context, {
    async runSpotify(args) {
      assert.deepEqual(args, ["status"]);
      started = true;
      await gate.promise;
      return "Local status result.";
    },
  });
  context.after(() => gate.resolve());
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("/spotify status");
  await until(() => started && fixture.footer().includes("waiting for command"));
  assert.doesNotMatch(fixture.footer(), /ctrl\+c cancel/);
  fixture.send("my next listening thought");
  fixture.send("\x03");
  await until(() => fixture.footer().includes("can't be stopped halfway"));
  assert.equal(fixture.runtime.aborts, 0, "a local command must not abort an unrelated model runtime");
  assert.match(fixture.body(), /my next listening thought/);
  gate.resolve();
  await until(() => fixture.footer().includes("Spotify status: done."));
  assert.match(fixture.body(), /Local status result/);
  assert.match(fixture.body(), /my next listening thought/);
});

test("overlapping calls retain the active identity and leave one compact outcome receipt", async (context) => {
  const gate = deferred();
  let callbacks;
  const fixture = launch(context, { runtime: {
    async prompt(_value, received) { callbacks = received; return await gate.promise; },
    abort() { gate.resolve({ status: "aborted", text: "" }); },
  } });
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("Find a few related records");
  await until(() => callbacks);
  const first = { toolCallId: "one", label: "Search your music library", toolName: "PRIVATE_TOOL" };
  const second = { toolCallId: "two", label: "Read public music sources", toolName: "PRIVATE_TOOL" };
  callbacks.onToolStart(first);
  callbacks.onToolStart(second);
  await until(() => fixture.footer().includes("2 running"));
  fixture.send("keep it mostly instrumental");
  callbacks.onToolEnd({ ...first, isError: true });
  await until(() => fixture.footer().includes(second.label));
  assert.doesNotMatch(fixture.footer(), /Search your music library/);
  assert.match(fixture.body(), /keep it mostly instrumental/);
  fixture.terminal.columns = 40;
  fixture.terminal.resize();
  await until(() => fixture.lines.every((line) => visibleWidth(line) === 40));
  assert.match(fixture.footer(), /Read public music sources/);
  callbacks.onToolEnd({ ...second, isError: false });
  callbacks.onTextDelta("A grounded result.");
  gate.resolve({ status: "completed", text: "A grounded result." });
  await until(() => fixture.footer().includes("Ready."));
  assert.match(fixture.body(), /Tools · 1 done, 1 failed/);
  assert.doesNotMatch(fixture.body(), /PRIVATE_TOOL/);
  assert.equal(fixture.lines.filter((line) => line.includes("Tools ·")).length, 1);
  fixture.terminal.columns = 100;
  fixture.terminal.resize();
  await until(() => fixture.lines.every((line) => visibleWidth(line) === 100) && fixture.body().includes("keep it mostly instrumental"));
  assert.match(fixture.body(), /Search your music library/);
});

test("cancel during tools is idempotent and does not label unconfirmed work successful", async (context) => {
  const gate = deferred();
  let callbacks;
  const fixture = launch(context, { runtime: {
    async prompt(_value, received) { callbacks = received; return await gate.promise; },
  } });
  context.after(() => gate.resolve({ status: "aborted", text: "" }));
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("A cancellable music request");
  await until(() => callbacks);
  callbacks.onToolStart({ toolCallId: "one", label: "Search your music library" });
  await until(() => fixture.footer().includes("ctrl+c cancel"));
  fixture.send("\x03");
  fixture.send("\x03");
  callbacks.onToolStart({ toolCallId: "two", label: "Read public music sources" });
  await until(() => fixture.footer().includes("Stopping..."));
  assert.equal(fixture.runtime.aborts, 1);
  callbacks.onToolEnd({ toolCallId: "one", label: "Search your music library", isError: false });
  gate.resolve({ status: "aborted", text: "" });
  await until(() => fixture.footer().includes("Cancelled."));
  assert.match(fixture.body(), /Tools · 1 done, 1 unfinished/);
  assert.doesNotMatch(fixture.body(), /2 completed/);
});

test("elapsed work stays readable without animation and stops rendering after shutdown", async (context) => {
  const gate = deferred();
  const fixture = launch(context, { runtime: {
    async prompt() { return await gate.promise; },
    abort() { gate.resolve({ status: "aborted", text: "" }); },
  } });
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("Wait for a music lookup");
  await until(() => /Thinking\.\.\. · [1-9]\d*s/.test(fixture.footer()));
  fixture.send("\x03");
  await until(() => fixture.footer().includes("Cancelled."));
  fixture.submit("/quit");
  await until(() => fixture.terminal.stops === 1);
  const output = fixture.terminal.output;
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(fixture.terminal.output, output);
});
