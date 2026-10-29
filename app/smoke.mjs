// Launch the real packaged desktop with empty state, exercise its first run and Settings, then quit.
// Uses Node's built-in CDP transport; no model, account, or browser driver is needed.
// MOONDOG_SMOKE_EXECUTABLE runs an installed app or an AppImage instead of the unpacked build.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { desktopTarget } from "./pack-config.mjs";
import { createFictionalSpotifyHistoryArchive } from "../src/demo/fictional-spotify-history.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = desktopTarget();
const base = path.join(here, "release", "apps.noindex", target.unpacked);
const executable = process.env.MOONDOG_SMOKE_EXECUTABLE || path.join(base, ...({
  darwin: ["Moondog.app", "Contents", "MacOS", "Moondog"], win32: ["Moondog.exe"], linux: ["moondog"],
}[target.platform]));
const out = path.join(here, "release", "smoke");
const isolated = await mkdtemp(path.join(os.tmpdir(), "moondog-desktop-smoke-"));
const server = net.createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let socket;
let exited = false;
let exit;
let log = "";
let sequence = 0;
const pending = new Map();
const exceptions = [];
const deadline = Date.now() + 60_000;
// Carry only the host settings needed to launch a window, never provider credentials or
// personal Moondog overrides from the maintainer's shell.
const hostEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|SHELL|DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|LANG|LC_.+|CI|APPIMAGE_EXTRACT_AND_RUN)$/iu.test(key)));
async function until(fn, label) {
  while (Date.now() < deadline) {
    if (exited) throw new Error(`App exited before ${label}.\n${log}`);
    const result = await fn();
    if (result) return result;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}.\n${log}`);
}
function cdp(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

try {
  await mkdir(out, { recursive: true });
  child = spawn(executable, process.env.CI && process.platform === "linux" ? ["--no-sandbox"] : [], {
    cwd: isolated,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...hostEnvironment,
      MOONDOG_APP_DEBUG_PORT: String(port), MOONDOG_APP_USER_DATA: path.join(isolated, "window"),
      MOONDOG_CONFIG_HOME: path.join(isolated, "config"), MOONDOG_STATE_HOME: path.join(isolated, "state"),
      MOONDOG_UPDATE_CHECK: "off", MOONDOG_SYSTEM_MUSIC: "off", MOONDOG_LYRICS: "off",
    },
  });
  exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  // A failed launch must be reported even while the debugger endpoint is still being polled.
  exit.catch((error) => { exited = true; log += error.message; });
  const collect = (data) => { log = (log + data).slice(-64 * 1024); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const page = await until(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      return pages.find((entry) => entry.type === "page" && entry.url.startsWith("file:"));
    } catch { return null; }
  }, "the desktop debugger");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, "open");
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
  await cdp("Runtime.enable");
  // The sheet is opened only after the real utility process has returned first-run state.
  await until(() => evaluate('Boolean(document.querySelector(".sheet:not([hidden]) .sheet-card.asking"))'), "the core's first-run screen");
  assert.equal(await evaluate("typeof window.moondogApp.version"), "function", "The sandboxed preload must load");
  const { data: firstRun } = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(out, `${process.platform}-first-run.png`), Buffer.from(firstRun, "base64"));
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(async () => {
    try { return JSON.parse(await readFile(path.join(isolated, "config", "first-run.json"), "utf8")).skipped; } catch { return false; }
  }, "the core to save the skipped first run");
  await until(() => evaluate('Boolean(document.querySelector(".sheet[hidden]"))'), "the first-run screen to close");
  const archive = path.join(isolated, "fictional history.zip");
  await writeFile(archive, createFictionalSpotifyHistoryArchive());
  // A real file drop exercises the sandboxed preload's file path and the packaged ZIP reader.
  const drag = { x: 450, y: 350, data: { items: [], files: [archive], dragOperationsMask: 1 } };
  for (const type of ["dragEnter", "dragOver", "drop"]) await cdp("Input.dispatchDragEvent", { type, ...drag });
  await until(() => evaluate('Boolean(document.querySelector(\'[data-key="import:commit"]\'))'), "the fictional history preview");
  await evaluate('document.querySelector(\'[data-key="import:commit"]\').click()');
  await until(() => evaluate('document.querySelector("[data-column]").textContent.includes("Midnight Lines")'), "the imported listening profile");
  const { data: profile } = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(out, `${process.platform}-profile.png`), Buffer.from(profile, "base64"));
  await evaluate('document.querySelector("[data-settings-button]").click()');
  await until(() => evaluate('Boolean(document.querySelector(".sheet:not([hidden]) .sheet-card:not(.asking)"))'), "Settings to open");
  assert.equal(await evaluate('Boolean(document.querySelector("[data-input]") && document.querySelector("[data-record]").width > 0)'), true);
  const { data: settings } = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(out, `${process.platform}-settings.png`), Buffer.from(settings, "base64"));
  assert.deepEqual(exceptions, [], "The real renderer must not throw");
  // Windows/Linux's Close button must quit the app. macOS keeps its window after Close, so quit
  // the browser process instead. Both routes must let the utility process stop cleanly.
  await cdp(process.platform === "darwin" ? "Browser.close" : "Page.close").catch(() => {});
  const result = await Promise.race([exit, delay(12_000).then(() => { throw new Error("The app did not quit cleanly"); })]);
  assert.equal(result.code, 0, `App quit failed: ${JSON.stringify(result)}\n${log}`);
  await writeFile(path.join(out, `${process.platform}.json`), `${JSON.stringify({ platform: process.platform, arch: process.arch, firstRun: true, saved: true, imported: true, settings: true, cleanExit: true }, null, 2)}\n`);
  console.log(`Packaged desktop smoke passed on ${process.platform}/${process.arch}. Screenshots: ${path.relative(here, out)}`);
} catch (error) {
  // A provider-independent import error is often visible in the sheet rather than stderr.
  // Keep that evidence before the isolated app and its data are removed.
  if (socket?.readyState === WebSocket.OPEN) {
    const page = await evaluate('document.body.innerText.slice(0, 12000)').catch(() => null);
    await writeFile(path.join(out, `${process.platform}-failure.json`), `${JSON.stringify({ error: error.message, page, exceptions }, null, 2)}\n`).catch(() => {});
    const screenshot = await cdp("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (screenshot) await writeFile(path.join(out, `${process.platform}-failure.png`), Buffer.from(screenshot.data, "base64")).catch(() => {});
  }
  throw error;
} finally {
  socket?.close();
  for (const { timer, reject } of pending.values()) { clearTimeout(timer); reject(new Error("Smoke test closed")); }
  if (child?.pid && !exited) {
    if (process.platform === "win32") await promisify(execFile)("taskkill", ["/PID", String(child.pid), "/T", "/F"]).catch(() => {});
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already closed. */ } }
    await exit.catch(() => {});
  }
  await writeFile(path.join(out, `${process.platform}.log`), log).catch(() => {});
  await rm(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
