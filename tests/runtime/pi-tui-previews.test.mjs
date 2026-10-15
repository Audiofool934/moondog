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

function launch(context, options = {}) {
  const terminal = {
    columns: 100, rows: 28, kittyProtocolActive: false, stops: 0, output: "",
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
    runtime: { publicStatus: () => ({ state: "configured", provider: "fixture", model: "offline-test" }), reset() {}, abort() {}, ...options.runtime },
    terminal, signalTarget,
    environment: { TERM: "xterm-256color", MOONDOG_ART: "off", MOONDOG_MOTION: "off" },
    ...(options.previewPlayer ? { previewPlayer: options.previewPlayer } : {}),
  });
  context.after(async () => {
    signalTarget.emit("SIGTERM");
    await running;
    assert.equal(terminal.stops, 1);
    if (options.previewPlayer) assert.equal(options.previewPlayer.listeners(), 0, "a closed room stops watching the player");
  });
  return fixture;
}

// Stands in for the terminal player: the test says what it plays, the room controls it.
function previewPlayer() {
  const listeners = new Set();
  return {
    controls: [],
    emit(event) { for (const listener of listeners) listener(event); },
    listeners: () => listeners.size,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    skip() { this.controls.push("skip"); return true; },
    stop() { this.controls.push("stop"); return true; },
    play() {},
  };
}

const tracks = [
  { title: "Wind of Change", artist_credit: "Scorpions", catalog_url: "https://music.apple.com/us/album/crazy-world/2?i=2" },
  { title: "Teardrop", artist_credit: "Massive Attack", catalog_url: "https://music.apple.com/us/album/mezzanine/3?i=3" },
];

test("the room shows what is playing, links each preview to Apple Music, and controls the player", async (context) => {
  const player = previewPlayer();
  let finish;
  const fixture = launch(context, { previewPlayer: player, runtime: {
    async prompt(_text, callbacks) {
      // The agent's preview tool hands the songs to the player in the middle of the turn.
      player.emit({ type: "queue", tracks, album: null });
      player.emit({ type: "loading", track: tracks[0], position: 1, count: 2 });
      return await new Promise((resolve) => { finish = (result) => { callbacks.onTextDelta(result.text); resolve(result); }; });
    },
  } });
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("Play me Wind of Change and something like it");
  await until(() => fixture.body().includes("30-second previews from Apple Music"));
  assert.match(fixture.body(), /1\. Wind of Change - Scorpions · Apple Music/u);
  assert.match(fixture.body(), /2\. Teardrop - Massive Attack · Apple Music/u);
  for (const track of tracks) assert.ok(fixture.terminal.output.includes(track.catalog_url), "each song's Apple Music link reaches the screen");
  // A slow download shows as loading, then the song plays.
  await until(() => /♪ Wind of Change · Scorpions\s+1\/2 · loading · Apple Music · \/skip · \/stop/u.test(fixture.body()));
  player.emit({ type: "playing", track: tracks[0], position: 1, count: 2 });
  await until(() => /♪ Wind of Change · Scorpions\s+1\/2 · Apple Music · \/skip · \/stop/u.test(fixture.body()));
  player.emit({ type: "paused", track: tracks[0], position: 1, count: 2 });
  await until(() => /♪ Wind of Change · Scorpions\s+1\/2 · paused · Apple Music · \/skip · \/stop/u.test(fixture.body()));

  // While Moondog is still answering, /skip acts at once instead of waiting in the queue.
  fixture.submit("/skip");
  await until(() => player.controls.length === 1);
  assert.deepEqual(player.controls, ["skip"]);
  assert.doesNotMatch(fixture.body(), /queued/u, "/skip is not queued behind the reply");
  player.emit({ type: "playing", track: tracks[1], position: 2, count: 2 });
  await until(() => fixture.body().includes("♪ Teardrop · Massive Attack"));
  assert.doesNotMatch(fixture.body(), /♪ Wind of Change/u);
  finish({ status: "completed", text: "Two 30-second previews are playing. The full songs are on Apple Music." });
  await until(() => fixture.body().includes("The full songs are on Apple Music."));

  fixture.submit("/stop");
  await until(() => fixture.status().includes("Previews stopped."));
  assert.deepEqual(player.controls, ["skip", "stop"]);
  player.emit({ type: "stopped" });
  await until(() => !fixture.body().includes("♪ Teardrop"));
  assert.match(fixture.body(), /2\. Teardrop - Massive Attack · Apple Music/u, "the note with the links stays in the conversation");
});

test("an album note names the album once", async (context) => {
  const player = previewPlayer();
  const fixture = launch(context, { previewPlayer: player, runtime: {
    async prompt(_text, callbacks) {
      player.emit({
        type: "queue",
        album: { title: "Crazy World", artist_credit: "Scorpions", catalog_url: "https://music.apple.com/us/album/crazy-world/10" },
        tracks: [
          { title: "Tease Me Please Me", artist_credit: "Scorpions", catalog_url: "https://music.apple.com/us/album/crazy-world/10?i=4" },
          { title: "Hidden_Duet*", artist_credit: "Scorpions & Guest", catalog_url: "https://music.apple.com/us/album/crazy-world/10?i=(6)" },
        ],
      });
      callbacks.onTextDelta("Crazy World, from the top.");
      return { status: "completed", text: "Crazy World, from the top." };
    },
  } });
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("Play the album Crazy World by Scorpions");
  await until(() => fixture.body().includes("Crazy World, from the top."));
  assert.match(fixture.body(), /Crazy World - Scorpions · Apple Music/u);
  assert.match(fixture.body(), /1\. Tease Me Please Me · Apple Music/u, "the album's own artist is not repeated");
  assert.match(fixture.body(), /2\. Hidden_Duet\* - Scorpions & Guest · Apple Music/u, "titles stay as written");
  assert.ok(fixture.terminal.output.includes("?i=%286%29"), "a link keeps its whole address");
});

test("a room without a player of its own has no /skip or /stop", async (context) => {
  const plain = launch(context);
  await until(() => plain.body().includes("New conversation"));
  for (const command of ["skip", "stop"]) {
    plain.submit(`/${command}`);
    await until(() => plain.body().includes(`I don't know /${command}.`));
  }
});

test("a preview that cannot load is marked in the note, and the note says when none could", async (context) => {
  const player = previewPlayer();
  const fixture = launch(context, { previewPlayer: player, runtime: {
    async prompt(_text, callbacks) {
      player.emit({ type: "queue", tracks, album: null });
      player.emit({ type: "loading", track: tracks[0], position: 1, count: 2 });
      callbacks.onTextDelta("Two 30-second previews are playing.");
      return { status: "completed", text: "Two 30-second previews are playing." };
    },
  } });
  await until(() => fixture.body().includes("New conversation"));
  fixture.submit("Play me Wind of Change and something like it");
  await until(() => fixture.body().includes("Two 30-second previews are playing."));
  player.emit({ type: "failed", track: tracks[0], position: 1, count: 2 });
  // The mark follows the failed song, before the next one; a long address may wrap it.
  await until(() => /1\. Wind of Change - Scorpions · Apple Music[^]*?·\s+couldn't load\s+2\. Teardrop/u.test(fixture.body()));
  assert.equal(fixture.body().match(/couldn't load/gu).length, 1);
  assert.doesNotMatch(fixture.body(), /None of these previews could load/u);
  player.emit({ type: "failed", track: tracks[1], position: 2, count: 2 });
  player.emit({ type: "stopped" });
  await until(() => fixture.body().includes("None of these previews could load. Check your connection, then ask again."));
  assert.doesNotMatch(fixture.body(), /♪ Wind of Change · Scorpions/u, "nothing is left playing");
});
