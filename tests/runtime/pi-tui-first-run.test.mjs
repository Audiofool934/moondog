import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { TuiAltScreen } from "@earendil-works/pi-tui";

import { createFirstRun, resolveFirstRunFile } from "../../src/core/first-run.mjs";
import { readPlaybackPreference, writePlaybackPreference } from "../../src/core/playback-preferences.mjs";
import { runMoondogTui } from "../../src/surfaces/cli/tui.mjs";

const DOWN = "\x1b[B";
const ESC = "\x1b";

function fakeTerminal() {
  return {
    columns: 90, rows: 28, kittyProtocolActive: false, starts: 0, stops: 0, output: "",
    start(input) { this.starts += 1; this.input = input; },
    stop() { this.stops += 1; },
    async drainInput() {},
    write(data) { this.output += data; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
}

const offline = (selection = {}, reason = "model_not_configured") => ({
  publicStatus: () => ({ state: "offline", reason, ...selection }), reset() {}, abort() {},
});
const configured = (prompts = []) => ({
  publicStatus: () => ({ state: "configured", provider: "deepseek", model: "deepseek-flash" }), reset() {}, abort() {},
  async prompt(text, callbacks) { prompts.push(text); callbacks.onTextDelta("Here is something calm."); return { status: "completed", text: "Here is something calm." }; },
});

async function until(fixture, predicate, what) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for: ${what}\n${fixture.screen()}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A terminal room on a fresh config folder, with the real first-run file and playback.json beside it.
async function setUp(context, { service = null, runtime = offline(), neteasePlayer, ...options } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-first-run-tui-"));
  const environment = { MOONDOG_CONFIG_HOME: root, TERM: "xterm-256color", MOONDOG_ART: "off", MOONDOG_MOTION: "off" };
  if (service) await writePlaybackPreference(service, environment);
  const fixture = { root, environment, terminal: fakeTerminal(), lines: [], saved: [], authProviders: [], prompts: [], rebuilds: [], runs: [] };
  const doRender = TuiAltScreen.prototype.doRender;
  context.mock.method(TuiAltScreen.prototype, "doRender", function () {
    doRender.call(this);
    fixture.lines = (this.previousScreen ?? []).map(stripVTControlCharacters);
  });
  fixture.screen = () => fixture.lines.join("\n");
  fixture.shows = (text) => fixture.screen().includes(text);
  fixture.see = (text) => until(fixture, () => fixture.shows(text), text);
  fixture.press = (...keys) => { for (const key of keys) fixture.terminal.input(key); };
  fixture.status = () => fixture.lines.at(-2) ?? "";
  let current = service ?? "spotify";
  const application = {
    async sourceStatus() { return { state: "missing", latest: null }; },
    get playbackService() { return current; },
    spotifyReady: () => false,
    neteasePlayer,
  };
  fixture.launch = () => {
    const signalTarget = new EventEmitter();
    const terminal = fixture.terminal;
    const running = runMoondogTui({
      application, runtime, terminal, signalTarget, environment,
      firstRun: createFirstRun({ environment, interval: 20 }),
      savePlaybackService: async (choice) => {
        // As the core does, NetEase is refused until ncm-cli is signed in.
        if (choice === "netease" && (await neteasePlayer?.check?.())?.state !== "ready") throw new Error("NetEase Music is not signed in.");
        await writePlaybackPreference(choice, environment);
        fixture.saved.push(choice);
        current = choice;
        return choice;
      },
      providers: () => [{ id: "deepseek", name: "DeepSeek", modelCount: 1 }],
      models: () => [{ id: "deepseek-flash", name: "DeepSeek V4.1 Flash" }],
      async runAuth(provider) { fixture.authProviders.push(provider); fixture.signedIn = true; },
      async rebuildRuntime(selection) {
        fixture.rebuilds.push(selection);
        if (selection) fixture.selection = selection;
        if (!fixture.selection) return offline();
        return fixture.signedIn ? configured(fixture.prompts) : offline(fixture.selection, "provider_authentication_required");
      },
      ...options,
    });
    const run = { running, stop: async () => { signalTarget.emit("SIGTERM"); await running; } };
    fixture.runs.push(run);
    return run;
  };
  context.after(async () => {
    for (const run of fixture.runs) await run.stop();
    await rm(root, { recursive: true, force: true });
  });
  return fixture;
}

const firstRunFile = async (environment) => JSON.parse(await readFile(resolveFirstRunFile(environment), "utf8"));

test("a first launch asks for the music service, then the model, and opens the home once both are set", async (context) => {
  const fixture = await setUp(context);
  fixture.launch();
  await fixture.see("Where should I play music?");
  assert.ok(fixture.shows("Welcome to the machine."));
  assert.ok(fixture.shows("Two things before we start"));
  assert.match(fixture.screen(), /◉ Spotify\s+Whole songs on your Spotify devices/u);
  assert.match(fixture.screen(), /Apple Music\s+30-second previews, played here/u);
  assert.ok(!fixture.shows("NetEase"), "NetEase waits until ncm-cli is installed");
  assert.match(fixture.screen(), /esc skip setup/u);
  assert.ok(!fixture.shows("Your personal music agent.") && !fixture.shows("What have you been listening to?"), "the sleeve and the draft wait behind the first run");

  fixture.press(DOWN, "\r");
  await fixture.see("Which model should I talk through?");
  assert.deepEqual(fixture.saved, ["apple_music"]);
  assert.equal(await readPlaybackPreference(fixture.environment), "apple_music");
  assert.ok(fixture.shows("Apple Music it is."));
  assert.match(fixture.screen(), /◉ Choose a model/u);

  // The model step is Pi's own /model picker, then the sign-in that model needs.
  fixture.press("\r");
  await fixture.see("Choose a model provider");
  fixture.press("\r");
  await fixture.see("Choose a model for deepseek");
  fixture.press("\r");
  await fixture.see("All set. Say anything, or press Tab to look around.");
  assert.deepEqual(fixture.rebuilds[0], { provider: "deepseek", model: "deepseek-flash" });
  assert.deepEqual(fixture.authProviders, ["deepseek"]);
  assert.ok(!fixture.shows("Welcome to the machine."));
  assert.ok(!fixture.shows("Now talking through"), "what the model step said stayed on its page");
  assert.equal((await firstRunFile(fixture.environment)).skipped, false);

  fixture.press("Play something calm", "\r");
  await until(fixture, () => fixture.prompts.length === 1, "the first message reaches the model");
});

test("a step already done is skipped: a saved service opens on the model, and a sign-in to finish it", async (context) => {
  const fixture = await setUp(context, { service: "spotify", runtime: offline({ provider: "deepseek", model: "deepseek-flash" }, "provider_authentication_required") });
  fixture.selection = { provider: "deepseek", model: "deepseek-flash" };
  fixture.launch();
  await fixture.see("Which model should I talk through?");
  assert.ok(fixture.shows("One thing before we start: the model I talk through."));
  assert.ok(!fixture.shows("Where should I play music?"));
  assert.ok(fixture.shows("deepseek/deepseek-flash is saved, but you're not signed in to deepseek yet."));
  assert.match(fixture.screen(), /◉ Sign in to deepseek\s+API key/u);
  assert.match(fixture.screen(), /Choose another model/u);
  fixture.press("\r");
  await fixture.see("All set.");
  assert.deepEqual(fixture.authProviders, ["deepseek"]);
  assert.equal(fixture.terminal.stops, 1, "the sign-in prompt ran outside the room");
  assert.equal(fixture.terminal.starts, 2);
});

test("a model that already answers leaves only the service, and Spotify says how to connect it later", async (context) => {
  const fixture = await setUp(context, { runtime: configured() });
  fixture.launch();
  await fixture.see("Where should I play music?");
  assert.ok(fixture.shows("One thing before we start: where I play your music."));
  fixture.press("\r");
  await fixture.see("All set. /spotify help shows how to connect Spotify.");
  assert.deepEqual(fixture.saved, ["spotify"]);
  assert.equal((await firstRunFile(fixture.environment)).skipped, false);
});

test("Esc skips the rest for good, and the next launch opens on the sleeve", async (context) => {
  const fixture = await setUp(context);
  const first = fixture.launch();
  await fixture.see("Where should I play music?");
  fixture.press(ESC);
  await fixture.see("Skipped. /service and /model are here when you want them.");
  assert.ok(!fixture.shows("Where should I play music?"));
  assert.ok(fixture.shows("Your personal music agent.") && fixture.shows("What have you been listening to?"), "the sleeve and the draft are back");
  await first.stop();
  assert.equal((await firstRunFile(fixture.environment)).skipped, true);
  assert.equal(await readPlaybackPreference(fixture.environment), null, "skipping saves no service");

  fixture.lines = [];
  fixture.launch();
  await fixture.see("New conversation");
  assert.ok(!fixture.shows("Welcome to the machine."));
});

test("NetEase before ncm-cli is set up shows how to set it up, then plays once it is", async (context) => {
  let state = "missing";
  const neteasePlayer = { status: () => ({ state }), async check() { return { state }; } };
  const fixture = await setUp(context, { runtime: configured(), neteasePlayer });
  fixture.launch();
  await fixture.see("Where should I play music?");
  assert.match(fixture.screen(), /NetEase Music\s+Set up ncm-cli first/u);
  fixture.press(DOWN, DOWN, "\r");
  await fixture.see("npm install -g @music163/ncm-cli && brew install mpv && ncm-cli login");
  assert.ok(fixture.shows("NetEase plays through its own command line tool."));
  assert.deepEqual(fixture.saved, []);
  state = "ready";
  fixture.press("\r");
  await fixture.see("All set.");
  assert.deepEqual(fixture.saved, ["netease"]);
});

test("the window's choices reach an open first run, and the window can end it", async (context) => {
  const window = (environment) => createFirstRun({ environment });
  let modelSaved = null;
  const fixture = await setUp(context, {
    watchModelSettings: (listener) => { modelSaved = listener; return () => {}; },
  });
  fixture.launch();
  await fixture.see("Where should I play music?");

  // A service chosen in the window moves the terminal on to the model.
  await writePlaybackPreference("apple_music", fixture.environment);
  await fixture.see("Which model should I talk through?");

  // A model signed in in the window rebuilds this agent, which ends the first run.
  fixture.selection = { provider: "deepseek", model: "deepseek-flash" };
  fixture.signedIn = true;
  modelSaved({ provider: "deepseek", model: "deepseek-flash" });
  await fixture.see("All set. Say anything, or press Tab to look around.");
  assert.equal((await firstRunFile(fixture.environment)).skipped, false);

  // A skip in the window closes the first run here too.
  const skipped = await setUp(context);
  skipped.launch();
  await skipped.see("Where should I play music?");
  await window(skipped.environment).finish({ skipped: true });
  await until(skipped, () => !skipped.shows("Where should I play music?"), "the first run closes");
  assert.ok(skipped.shows("New conversation · /resume history"));
  assert.ok(skipped.shows("Your personal music agent."));
});

test("/service opens the same choices any time and saves the one picked", async (context) => {
  const fixture = await setUp(context, { service: "spotify", runtime: configured() });
  fixture.launch();
  await fixture.see("New conversation");
  assert.ok(!fixture.shows("Welcome to the machine."), "a saved service and a model mean no first run");
  fixture.press("/service", "\r");
  await fixture.see("Where should I play music?");
  assert.match(fixture.screen(), /Apple Music\s+30-second previews, played here/u);
  fixture.press(DOWN, "\r");
  await fixture.see("Apple Music it is.");
  assert.deepEqual(fixture.saved, ["apple_music"]);
  fixture.press("/service netease", "\r");
  await fixture.see("NetEase Music is not signed in.");
});
