import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createUpdates } from "../../app/updates.mjs";
import { createQuitHandler } from "../../app/lifecycle.mjs";

// A stand-in for electron-updater's autoUpdater that records what the app asks of it.
function fakeUpdater({ available = true } = {}) {
  const updater = new EventEmitter();
  Object.assign(updater, {
    autoDownload: true, autoRunAppAfterInstall: true, checks: 0, downloads: 0, installs: 0,
    async checkForUpdates() { updater.checks += 1; if (available) updater.emit("update-available", { version: "0.2.0-beta.4" }); return { isUpdateAvailable: available }; },
    downloadUpdate() { updater.downloads += 1; return Promise.resolve([]); },
    quitAndInstall() { updater.installs += 1; },
    setFeedURL(options) { updater.feed = options; },
  });
  return updater;
}

function setup(options) {
  const autoUpdater = fakeUpdater(options);
  const seen = [];
  const updates = createUpdates({ autoUpdater, squirrel: new EventEmitter(), onChange: (state) => seen.push(state), onRestart() {} });
  return { autoUpdater, updates, seen };
}

test("a newer build is offered, and nothing downloads until the listener clicks", async () => {
  const { autoUpdater, updates } = setup();
  assert.equal(autoUpdater.autoDownload, false);
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(await updates.check(), "available");
  assert.deepEqual(updates.state(), { phase: "available", version: "0.2.0-beta.4", installing: false });
  assert.equal(autoUpdater.downloads, 0);
  // Another check while it is only offered can find a newer one.
  await updates.check();
  assert.equal(autoUpdater.checks, 2);
});

test("an update restart drains the core before the application quits on every desktop", async () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const events = [];
    let core = new EventEmitter();
    const running = core;
    running.postMessage = (message) => events.push(message.type);
    running.kill = () => { throw new Error("A saved conversation must not be killed"); };
    running.once("exit", () => { core = null; });
    const shutdown = createQuitHandler({
      getCore: () => core, stopMusic: () => events.push("stop-music"),
      willQuit: () => events.push("quitting"), quit: () => events.push("app-quit"),
    });
    const squirrel = new EventEmitter();
    const autoUpdater = fakeUpdater();
    autoUpdater.quitAndInstall = () => {
      // electron-updater's MacUpdater and BaseUpdater signal Electron's autoUpdater here.
      squirrel.emit("before-quit-for-update");
      shutdown({ preventDefault: () => events.push("wait-for-core") });
    };
    const updates = createUpdates({ autoUpdater, squirrel, onChange() {}, onRestart: () => events.push("update-restart") });
    await updates.check();
    assert.deepEqual(events, [], platform);
    updates.install();
    autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
    assert.deepEqual(events, ["update-restart", "quitting", "stop-music", "wait-for-core", "quit"], platform);
    assert(!events.includes("app-quit"), platform);
    running.emit("exit", 0);
    assert.equal(events.at(-1), "app-quit", platform);
  }
});

test("a core that cannot finish saving is stopped once during quit", async () => {
  const core = new EventEmitter();
  let asks = 0, kills = 0, quits = 0;
  core.postMessage = () => { asks += 1; };
  core.kill = () => { kills += 1; core.emit("exit", 1); };
  const shutdown = createQuitHandler({ getCore: () => core, stopMusic() {}, willQuit() {}, quit: () => { quits += 1; }, timeoutMs: 5 });
  const event = { preventDefault() {} };
  shutdown(event);
  shutdown(event);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(asks, 1);
  assert.equal(kills, 1);
  assert.equal(quits, 1);
});

test("one click downloads the build and restarts into it when the download ends", async () => {
  const { autoUpdater, updates } = setup();
  await updates.check();
  updates.install();
  assert.deepEqual(updates.state(), { phase: "downloading", version: "0.2.0-beta.4", progress: 0, installing: true });
  assert.equal(autoUpdater.downloads, 1);
  // A second click while it downloads changes nothing, and neither does a check.
  updates.install();
  assert.equal(await updates.check(), "available");
  assert.equal(autoUpdater.downloads, 1);
  assert.equal(autoUpdater.checks, 1);
  autoUpdater.emit("download-progress", { percent: 50 });
  assert.equal(updates.state().progress, 0.5);
  assert.equal(autoUpdater.installs, 0);
  autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
  assert.equal(updates.state().phase, "ready");
  assert.equal(autoUpdater.installs, 1);
});

test("a failed download keeps the build offered, and another click tries again", async () => {
  const { autoUpdater, updates } = setup();
  await updates.check();
  updates.install();
  autoUpdater.emit("error", new Error("fictional network failure"));
  assert.deepEqual(updates.state(), { phase: "available", version: "0.2.0-beta.4", installing: false });
  updates.install();
  assert.equal(autoUpdater.downloads, 2);
  assert.equal(updates.state().phase, "downloading");
});

test("a failed check offers nothing, and an app that is not packaged never updates", async () => {
  const { autoUpdater, updates } = setup({ available: false });
  assert.equal(await updates.check(), "current");
  autoUpdater.emit("error", new Error("fictional check failure"));
  assert.equal(updates.state().phase, "idle");
  updates.install();
  assert.equal(autoUpdater.downloads, 0);

  const unpackaged = createUpdates({ autoUpdater: null, squirrel: null, onChange() {}, onRestart() {} });
  assert.equal(unpackaged.enabled, false);
  assert.equal(await unpackaged.check(), "failed");
});
