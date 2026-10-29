import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createUpdates } from "../../app/updates.mjs";
import { createQuitHandler, installDownloadedUpdate } from "../../app/lifecycle.mjs";

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

// A core whose quit is recorded; it exits only when the test says so.
function savingCore(events) {
  const core = new EventEmitter();
  core.postMessage = (message) => events.push(message.type);
  core.kill = () => { throw new Error("A saved conversation must not be killed"); };
  return core;
}

test("a Mac update restart drains the core before the application quits", async () => {
  const events = [];
  let core = savingCore(events);
  const running = core;
  running.once("exit", () => { core = null; });
  const shutdown = createQuitHandler({
    getCore: () => core, stopMusic: () => events.push("stop-music"),
    willQuit: () => events.push("quitting"), quit: () => events.push("app-quit"),
  });
  const squirrel = new EventEmitter();
  const autoUpdater = fakeUpdater();
  autoUpdater.quitAndInstall = () => {
    // electron-updater's MacUpdater signals Electron's autoUpdater here, then Squirrel quits the app.
    squirrel.emit("before-quit-for-update");
    shutdown({ preventDefault: () => events.push("wait-for-core") });
  };
  const updates = createUpdates({ autoUpdater, squirrel, onChange() {}, onRestart: () => events.push("update-restart") });
  await updates.check();
  assert.deepEqual(events, []);
  updates.install();
  autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
  assert.deepEqual(events, ["update-restart", "quitting", "stop-music", "wait-for-core", "quit"]);
  assert(!events.includes("app-quit"));
  running.emit("exit", 0);
  assert.equal(events.at(-1), "app-quit");
});

test("Windows and Linux install a downloaded update only after the core has saved", async () => {
  for (const platform of ["win32", "linux"]) {
    const events = [];
    let core = savingCore(events);
    const running = core;
    running.once("exit", () => { core = null; });
    const shutdown = createQuitHandler({ getCore: () => core, stopMusic() {}, willQuit() {}, quit: () => events.push("app-quit") });
    const autoUpdater = fakeUpdater();
    autoUpdater.install = (silent, run) => {
      events.push(`install silent=${silent} run=${run}`);
      // A versioned AppImage name moves to the new version's name.
      autoUpdater.emit("appimage-filename-updated", "/apps/Moondog-0.2.0-beta.4-linux-x86_64.AppImage");
      return true;
    };
    let installOnQuit = false;
    const updates = createUpdates({ autoUpdater, squirrel: new EventEmitter(), onChange() {}, onRestart() {},
      restart: () => { installOnQuit = true; shutdown({ preventDefault: () => events.push("wait-for-core") }); } });
    await updates.check();
    updates.install();
    autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
    assert.deepEqual(events, ["wait-for-core", "quit"], platform);
    assert.equal(autoUpdater.installs, 0, "quitAndInstall would start the installer before the core saved");
    running.emit("exit", 0);
    assert.equal(events.at(-1), "app-quit", platform);
    // The app's will-quit, once the windows have closed.
    const relaunches = [];
    assert(installOnQuit);
    installDownloadedUpdate({ updater: autoUpdater, platform, relaunch: (options) => relaunches.push(options), appImage: "/apps/Moondog-0.2.0-linux-x86_64.AppImage" });
    assert.equal(events.at(-1), `install silent=true run=${platform === "win32"}`, platform);
    assert.deepEqual(relaunches, platform === "linux" ? [{ execPath: "/apps/Moondog-0.2.0-beta.4-linux-x86_64.AppImage", args: [] }] : [], platform);
    assert.equal(autoUpdater.listenerCount("appimage-filename-updated"), 0);
  }
});

test("a failed Windows install opens the installed app again, and a test feed never relaunches", () => {
  const relaunches = [];
  const updater = Object.assign(new EventEmitter(), { autoRunAppAfterInstall: true, install: () => false });
  installDownloadedUpdate({ updater, platform: "win32", relaunch: (options) => relaunches.push(options ?? "same app") });
  assert.deepEqual(relaunches, ["same app"]);
  updater.autoRunAppAfterInstall = false;
  installDownloadedUpdate({ updater, platform: "linux", relaunch: (options) => relaunches.push(options), appImage: "/apps/Moondog.AppImage" });
  assert.deepEqual(relaunches, ["same app"]);
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
