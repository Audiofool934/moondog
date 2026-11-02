import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

import { createUpdates } from "../../app/updates.mjs";
import { installDownloadedUpdate } from "../../app/lifecycle.mjs";
import { createCoreShutdown } from "../../app/shutdown.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
  const updates = createUpdates({ autoUpdater, squirrel: new EventEmitter(), platform: "linux", onChange: (state) => seen.push(state), onRestart() {} });
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

test("Windows and Linux install a downloaded update after the core exits, and Linux relaunches only after the app exits", async () => {
  for (const platform of ["win32", "linux"]) {
    const events = [];
    const core = savingCore(events);
    const beforeInstall = createCoreShutdown({ getCore: () => core, stopMusic() {} });
    const autoUpdater = fakeUpdater();
    autoUpdater.install = (silent, run) => {
      events.push(`install silent=${silent} run=${run}`);
      // A versioned AppImage name moves to the new version's name.
      autoUpdater.emit("appimage-filename-updated", "/apps/Moondog-0.2.0-beta.4-linux-x86_64.AppImage");
      return true;
    };
    const relaunches = [];
    // What main.mjs passes on Windows and Linux.
    const quitAndInstall = () => {
      installDownloadedUpdate({ updater: autoUpdater, platform, relaunch: (options) => relaunches.push(options), appImage: "/apps/Moondog-0.2.0-linux-x86_64.AppImage" });
      events.push("app-quit");
    };
    const updates = createUpdates({ autoUpdater, squirrel: new EventEmitter(), beforeInstall, quitAndInstall, platform, onChange() {}, onRestart() {} });
    await updates.check();
    updates.install();
    autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
    await tick();
    assert.deepEqual(events, ["quit"], platform);
    core.emit("exit", 0);
    await tick();
    assert.deepEqual(events, ["quit", `install silent=true run=${platform === "win32"}`, "app-quit"], platform);
    assert.equal(autoUpdater.installs, 0, "electron-updater's quitAndInstall would start the AppImage while this one runs");
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
  await tick();
  assert.equal(autoUpdater.installs, 1);
});

test("an installer cannot launch the new app until the previous core exits", async () => {
  const events = [];
  const core = new EventEmitter();
  core.postMessage = () => events.push("save requested");
  core.kill = () => { throw new Error("unexpected forced exit"); };
  const beforeInstall = createCoreShutdown({ getCore: () => core, stopMusic: () => events.push("music stopped") });
  const autoUpdater = fakeUpdater();
  // AppImage installs and starts the new app inside quitAndInstall, before its quit event.
  autoUpdater.quitAndInstall = () => events.push("new app started");
  const updates = createUpdates({ autoUpdater, beforeInstall, squirrel: null, platform: "linux", onChange() {}, onRestart() {} });
  await updates.check();
  updates.install();
  autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
  await tick();
  assert.deepEqual(events, ["music stopped", "save requested"]);
  updates.install();
  assert.deepEqual(events, ["music stopped", "save requested"]);
  events.push("old core exited");
  core.emit("exit", 0);
  await tick();
  assert.deepEqual(events, ["music stopped", "save requested", "old core exited", "new app started"]);
});

test("a failed shutdown keeps the downloaded update retryable without installing", async () => {
  const autoUpdater = fakeUpdater();
  let attempts = 0;
  const updates = createUpdates({ autoUpdater, squirrel: null, platform: "win32", onChange() {}, onRestart() {},
    beforeInstall: async () => { if (++attempts === 1) throw new Error("fictional core still running"); },
  });
  await updates.check();
  updates.install();
  autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
  await tick();
  assert.equal(autoUpdater.installs, 0);
  assert.deepEqual(updates.state(), { phase: "ready", version: "0.2.0-beta.4", installing: false });
  updates.install();
  await tick();
  assert.equal(autoUpdater.installs, 1);
  assert.equal(autoUpdater.downloads, 1);
});

test("bounded shutdown waits for forced exit and refuses a core that stays alive", async () => {
  const core = new EventEmitter();
  let requests = 0;
  core.postMessage = () => requests++;
  core.kill = () => true;
  const shutdown = createCoreShutdown({ getCore: () => core, stopMusic() {}, timeoutMs: 5 });
  const first = shutdown();
  assert.equal(shutdown(), first);
  await assert.rejects(first, /has not exited/u);
  assert.equal(requests, 1);
  core.kill = () => { core.emit("exit"); return true; };
  await shutdown();
  assert.equal(requests, 2);
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

function macSetup(beforeInstall, prototype) {
  const autoUpdater = fakeUpdater();
  const squirrel = new EventEmitter();
  Object.assign(squirrel, {
    checks: 0, installs: 0,
    checkForUpdates() { squirrel.checks++; },
    quitAndInstall() { squirrel.installs++; },
  });
  // MacUpdater 6.8.10 registers these before createUpdates sees either updater.
  autoUpdater.nativeUpdater = squirrel;
  autoUpdater.squirrelDownloadedUpdate = false;
  squirrel.on("error", (error) => autoUpdater.emit("error", error));
  squirrel.on("update-downloaded", () => { autoUpdater.squirrelDownloadedUpdate = true; });
  if (prototype) {
    // Use the installed implementation, with only native I/O and proxy cleanup replaced.
    autoUpdater.handleUpdateDownloaded = () => prototype.handleUpdateDownloaded.call(autoUpdater);
    autoUpdater.closeServerIfExists = () => {};
    autoUpdater.app = { quit() { squirrel.installs++; } };
    autoUpdater.quitAndInstall = () => {
      autoUpdater.installs++;
      prototype.quitAndInstall.call(autoUpdater);
    };
  }
  const updates = createUpdates({ autoUpdater, squirrel, beforeInstall, platform: "darwin", onChange() {}, onRestart() {} });
  return { autoUpdater, squirrel, updates };
}

test("Mac validation finishes before core shutdown, and core exit precedes installation", async () => {
  const events = [];
  const core = new EventEmitter();
  core.postMessage = () => events.push("save requested");
  core.kill = () => { throw new Error("unexpected forced exit"); };
  const beforeInstall = createCoreShutdown({ getCore: () => core, stopMusic: () => events.push("music stopped") });
  const { autoUpdater, squirrel, updates } = macSetup(beforeInstall);
  autoUpdater.quitAndInstall = () => events.push("new app started");
  await updates.check();
  updates.install();
  autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
  await tick();
  assert.equal(autoUpdater.autoInstallOnAppQuit, false);
  assert.deepEqual(events, []);
  assert.equal(squirrel.checks, 1);
  assert.equal(updates.state().phase, "downloading");
  updates.install();
  assert.equal(squirrel.checks, 1);
  squirrel.emit("update-downloaded");
  await tick();
  assert.deepEqual(events, ["music stopped", "save requested"]);
  assert.equal(squirrel.listenerCount("update-downloaded"), 1);
  events.push("old core exited");
  core.emit("exit", 0);
  await tick();
  assert.deepEqual(events, ["music stopped", "save requested", "old core exited", "new app started"]);
});

async function exerciseNativeFailure(prototype) {
  let coreRunning = true;
  const { autoUpdater, squirrel, updates } = macSetup(async () => { coreRunning = false; }, prototype);
  await updates.check();
  for (let attempt = 0; attempt < 2; attempt++) {
    updates.install();
    autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
    assert.equal(squirrel.listenerCount("update-downloaded"), 2);
    await tick();
    squirrel.emit("error", new Error("fictional Squirrel signature failure"));
    await tick();
    assert.equal(coreRunning, true);
    assert.equal(autoUpdater.installs, 0);
    assert.equal(squirrel.installs, 0);
    assert.equal(squirrel.listenerCount("update-downloaded"), 1);
    assert.deepEqual(updates.state(), { phase: "available", version: "0.2.0-beta.4", installing: false });
  }
  updates.install();
  autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
  squirrel.emit("update-downloaded");
  await tick();
  assert.equal(coreRunning, false);
  assert.equal(autoUpdater.downloads, 3);
  assert.equal(autoUpdater.installs, 1);
  assert.equal(squirrel.checks, 3);
  assert.equal(squirrel.listenerCount("update-downloaded"), 1);
  if (prototype) assert.equal(squirrel.installs, 1);
}

test("native validation failures keep the core running and retry without leaking install listeners", async () => {
  await exerciseNativeFailure();
});

// Root-only CI has no desktop dependencies. The contract above always runs; when app npm ci
// has run, also exercise the pinned MacUpdater prototype without launching Electron or a server.
const appRequire = createRequire(new URL("../../app/package.json", import.meta.url));
let macModule;
try {
  macModule = appRequire.resolve("electron-updater/out/MacUpdater.js");
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}
const macPrototype = macModule ? appRequire(macModule).MacUpdater.prototype : null;
test("installed MacUpdater resumes validation failures with exactly one native install", {
  skip: macPrototype ? false : "desktop dependencies are not installed",
}, async () => { await exerciseNativeFailure(macPrototype); });

test("synchronous native validation errors also leave the core running and remove the pending listener", async () => {
  let stopped = false;
  const { autoUpdater, squirrel, updates } = macSetup(() => { stopped = true; });
  squirrel.checkForUpdates = () => { throw new Error("fictional Squirrel start failure"); };
  await updates.check();
  updates.install();
  autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
  await tick();
  assert.equal(stopped, false);
  assert.equal(autoUpdater.installs, 0);
  assert.equal(updates.state().phase, "available");
  assert.equal(updates.state().installing, false);
  assert.equal(squirrel.listenerCount("update-downloaded"), 1);
});

test("a validated Mac build retries failed core shutdown without another native check", async () => {
  let attempts = 0;
  const { autoUpdater, squirrel, updates } = macSetup(async () => {
    if (++attempts === 1) throw new Error("fictional core still running");
  });
  await updates.check();
  updates.install();
  autoUpdater.emit("update-downloaded", { version: "0.2.0-beta.4" });
  squirrel.emit("update-downloaded");
  await tick();
  assert.equal(autoUpdater.installs, 0);
  assert.deepEqual(updates.state(), { phase: "ready", version: "0.2.0-beta.4", installing: false });
  updates.install();
  await tick();
  assert.equal(autoUpdater.installs, 1);
  assert.equal(autoUpdater.downloads, 1);
  assert.equal(squirrel.checks, 1);
});
