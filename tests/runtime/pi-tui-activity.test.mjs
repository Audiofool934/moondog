import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
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
  const doRender = TuiAltScreen.prototype.doRender;
  context.mock.method(TuiAltScreen.prototype, "doRender", function () {
    doRender.call(this);
    fixture.lines = (this.previousScreen ?? []).map(stripVTControlCharacters);
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

test("one prompt grows one reply, settles one count, and keeps the room fixed", async (context) => {
  const gate = deferred();
  let callbacks;
  const fixture = launch(context, { runtime: {
    async prompt(_value, received) { callbacks = received; return await gate.promise; },
    abort() { gate.resolve({ status: "aborted", text: "" }); },
  } });
  const answer = "A grounded result.";
  const statusRow = () => fixture.lines.at(-2) ?? "";
  const hintRow = () => fixture.lines.at(-1) ?? "";
  const countLine = (text) => fixture.lines.filter((line) => line.includes(text)).length;
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("Find a few related records");
  await until(() => callbacks);
  await until(() => /Thinking\.\.\. · \d+s/.test(statusRow()));
  assert.match(hintRow(), /draft stays here/);
  assert.match(hintRow(), /ctrl\+c cancel/);
  assert.doesNotMatch(hintRow(), /tab explore/);
  const first = { toolCallId: "one", label: "Search your music library", toolName: "PRIVATE_TOOL" };
  const second = { toolCallId: "two", label: "Read public music sources", toolName: "PRIVATE_TOOL" };
  callbacks.onToolStart(first);
  callbacks.onToolStart(second);
  await until(() => statusRow().includes(first.label) && /· \d+s/.test(statusRow()));
  await until(() => fixture.body().includes(first.label) && fixture.body().includes(second.label));
  assert.match(fixture.body(), /Find a few related records/);
  assert.doesNotMatch(fixture.body(), /PRIVATE_TOOL/);
  fixture.send("keep it mostly instrumental");
  await until(() => fixture.body().includes("keep it mostly instrumental"));
  callbacks.onToolEnd({ ...first, isError: true });
  await until(() => statusRow().includes(second.label) && !statusRow().includes(first.label));
  assert.match(fixture.body(), /Search your music library/);
  assert.match(hintRow(), /draft stays here/);
  assert.match(hintRow(), /ctrl\+c cancel/);
  callbacks.onTextDelta("A grounded ");
  await until(() => fixture.body().includes("A grounded") && !fixture.body().includes(answer));
  callbacks.onTextDelta("result.");
  await until(() => fixture.body().includes(answer));
  assert.equal(fixture.body().split(answer).length - 1, 1);
  callbacks.onToolEnd({ ...second, isError: false });
  gate.resolve({ status: "completed", text: answer });
  await until(() => statusRow().includes("Up recalls this conversation."));
  assert.doesNotMatch(statusRow(), /Ready\./);
  assert.match(hintRow(), /send/);
  assert.doesNotMatch(hintRow(), /tab explore/);
  assert.equal(fixture.body().split(answer).length - 1, 1);
  assert.equal(countLine("1 didn't work"), 1);
  assert.match(fixture.body(), /1 done, 1 didn't work/);
  assert.match(fixture.body(), /Find a few related records/);
  assert.match(fixture.body(), /Search your music library/);
  assert.match(fixture.body(), /Read public music sources/);
  assert.match(fixture.body(), /keep it mostly instrumental/);
  assert.doesNotMatch(fixture.body(), /PRIVATE_TOOL/);
  assert.match(fixture.lines[0], /^ MOONDOG/u);
  assert.match(fixture.lines[0], /Find a few related records/);
  assert.ok(fixture.lines.every((line) => visibleWidth(line) === 100));
  fixture.terminal.columns = 40;
  fixture.terminal.resize();
  await until(() => fixture.lines.every((line) => visibleWidth(line) === 40));
  assert.match(fixture.lines[0], /^ MOONDOG/u);
  assert.match(fixture.lines[0], /Find a few/);
  assert.match(fixture.body(), /keep it mostly instrumental/);
  assert.equal(fixture.body().split(answer).length - 1, 1);
  assert.equal(countLine("1 didn't work"), 1);
  fixture.terminal.columns = 100;
  fixture.terminal.resize();
  await until(() => fixture.lines.every((line) => visibleWidth(line) === 100));
  assert.match(fixture.lines[0], /^ MOONDOG/u);
  assert.match(fixture.lines[0], /Find a few related records/);
  assert.match(fixture.body(), /keep it mostly instrumental/);
  assert.equal(fixture.body().split(answer).length - 1, 1);
  assert.doesNotMatch(statusRow(), /Ready\./);
  assert.match(statusRow(), /Up recalls this conversation/);
  assert.match(hintRow(), /send/);
  assert.doesNotMatch(hintRow(), /tab explore/);
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
  assert.match(fixture.body(), /1 done, 1 not confirmed/);
  assert.doesNotMatch(fixture.body(), /2 done/);
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

test("page up scrolls the conversation while the header and draft stay put", async (context) => {
  const answer = Array.from({ length: 40 }, (_, index) => `Marker ${index}`).join("\n\n");
  const fixture = launch(context, { runtime: {
    async prompt(_value, options) {
      options.onTextDelta(answer);
      return { status: "completed", text: answer };
    },
  } });
  const markers = () => fixture.lines.flatMap((line) => [...line.matchAll(/Marker (\d+)/g)].map((match) => Number(match[1])));
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("Tell me about the quiet songs");
  await until(() => markers().includes(39));
  fixture.send("hold this draft");
  await until(() => fixture.body().includes("hold this draft"));
  const topBefore = Math.min(...markers());
  assert.match(fixture.lines[0], /MOONDOG/);
  fixture.send("\x1b[5~");
  await until(() => markers().length > 0 && Math.min(...markers()) < topBefore);
  assert.match(fixture.lines[0], /MOONDOG/);
  assert.match(fixture.body(), /hold this draft/);
});
