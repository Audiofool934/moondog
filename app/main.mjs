// Moondog for Mac: a native window on the same core as the `moondog` command, as a desktop
// app is to its command line. The core runs in its own Node process (core-process.mjs); the
// window draws conversations, the conversation, and what is playing, and keeps the music
// going after it closes.
import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, nativeTheme, screen, shell, utilityProcess } from "electron";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { windowLocale, windowStrings } from "./strings.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// For automated checks: lets a DevTools client drive the window.
if (process.env.MOONDOG_APP_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.MOONDOG_APP_DEBUG_PORT);

// The window's canvas, from app/renderer/style.css.
const background = () => (nativeTheme.shouldUseDarkColors ? "#141413" : "#F7F6F2");
let locale = "en";

// Opened from Finder or the Dock, the app gets a minimal PATH, and the core couldn't find
// programs such as codex for web research. The packaged app gives it the PATH a login shell sets.
const loginShellPath = !app.isPackaged ? Promise.resolve(null) : new Promise((resolve) => {
  execFile(os.userInfo().shell || "/bin/zsh", ["-lc", 'printf "\\n__MOONDOG_PATH__%s\\n" "$PATH"'], { timeout: 3000 },
    (_error, stdout) => resolve(String(stdout ?? "").match(/__MOONDOG_PATH__(.+)/u)?.[1] ?? null));
});

function coreEnvironment(shellPath) {
  const environment = { ...process.env };
  // Without a terminal's locale, the core speaks the system's language unless the listener chose one.
  if (!environment.LC_ALL && !environment.LC_MESSAGES && !environment.LANG) {
    environment.LANG = `${{ zh: "zh_CN", "zh-Hant": "zh_TW", pt: "pt_BR" }[locale] ?? locale}.UTF-8`;
  }
  return {
    ...environment,
    ...(shellPath ? { PATH: shellPath } : {}),
    // The Mac's own region, which LANG above may not carry, for the Apple Music storefront.
    ...(app.getLocaleCountryCode() ? { MOONDOG_SYSTEM_REGION: app.getLocaleCountryCode() } : {}),
    // The packaged app updates as a whole, so the npm update notice doesn't apply.
    ...(app.isPackaged ? { MOONDOG_UPDATE_CHECK: "off" } : {}),
  };
}

let window = null;
let core = null;
let quitting = false;
// What the page last said it can do; the menu greys out what would do nothing.
const playback = { controllable: false, streaming: false };
let dockMenu = null;
const command = (name) => () => window?.webContents.send("command", name);

function buildMenu() {
  const t = windowStrings(locale);
  const dev = !app.isPackaged;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Moondog", submenu: [
      { label: t("menuAbout"), role: "about" },
      { type: "separator" },
      { label: t("menuSettings"), accelerator: "CmdOrCtrl+,", click: command("settings") },
      { type: "separator" },
      { label: t("menuHide"), role: "hide" },
      { label: t("menuHideOthers"), role: "hideOthers" },
      { label: t("menuShowAll"), role: "unhide" },
      { type: "separator" },
      { label: t("menuQuit"), role: "quit" },
    ] },
    { label: t("menuEdit"), submenu: [
      { label: t("menuUndo"), role: "undo" },
      { label: t("menuRedo"), role: "redo" },
      { type: "separator" },
      { label: t("menuCut"), role: "cut" },
      { label: t("menuCopy"), role: "copy" },
      { label: t("menuPaste"), role: "paste" },
      { label: t("menuSelectAll"), role: "selectAll" },
    ] },
    { label: t("menuConversation"), submenu: [
      { label: t("menuNew"), accelerator: "CmdOrCtrl+N", click: command("new") },
      { id: "stop", label: t("menuStop"), accelerator: "CmdOrCtrl+.", click: command("stop"), enabled: playback.streaming },
    ] },
    { label: t("menuPlayback"), submenu: [
      // On macOS every menu accelerator is live, even while typing, so these use Control and Command
      // together: Space or Command with an arrow would play, pause and skip in the middle of a sentence.
      { id: "toggle-playback", label: t("menuPlayPause"), accelerator: "Ctrl+Cmd+P", click: command("toggle-playback"), enabled: playback.controllable },
      { id: "next", label: t("menuNext"), accelerator: "Ctrl+Cmd+Right", click: command("next"), enabled: playback.controllable },
      { id: "previous", label: t("menuPrevious"), accelerator: "Ctrl+Cmd+Left", click: command("previous"), enabled: playback.controllable },
    ] },
    { label: t("menuView"), submenu: [
      { label: t("menuSidebar"), accelerator: "CmdOrCtrl+Alt+S", click: command("toggle-sidebar") },
      { label: t("menuPlayer"), accelerator: "CmdOrCtrl+Alt+P", click: command("toggle-inspector") },
      { type: "separator" },
      ...(dev ? [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }] : []),
      { label: t("menuFullScreen"), role: "togglefullscreen" },
    ] },
    { label: t("menuWindow"), role: "windowMenu", submenu: [
      { label: t("menuMinimize"), role: "minimize" },
      { label: t("menuZoom"), role: "zoom" },
      { label: t("menuClose"), role: "close" },
      { type: "separator" },
      { label: t("menuFront"), role: "front" },
    ] },
  ]));
  // The Dock icon's menu reaches the music while the window is closed.
  dockMenu = Menu.buildFromTemplate([
    { id: "toggle-playback", label: t("menuPlayPause"), click: command("toggle-playback"), enabled: playback.controllable },
    { id: "next", label: t("menuNext"), click: command("next"), enabled: playback.controllable },
    { id: "previous", label: t("menuPrevious"), click: command("previous"), enabled: playback.controllable },
  ]);
  app.dock?.setMenu(dockMenu);
}

async function openCore() {
  const shellPath = await loginShellPath;
  const { port1, port2 } = new MessageChannelMain();
  let errors = "";
  const debugPort = Number(process.env.MOONDOG_APP_DEBUG_PORT);
  // Development can run the window on a simulated Spotify (core-sim.mjs, not packaged).
  const entry = process.env.MOONDOG_APP_SIMULATED === "1" && !app.isPackaged ? "core-sim.mjs" : "core-process.mjs";
  core = utilityProcess.fork(path.join(here, entry), [], {
    serviceName: "Moondog",
    stdio: "pipe",
    env: coreEnvironment(shellPath),
    // Automated checks can also reach the core process, one port above the window's.
    execArgv: debugPort ? [`--inspect=127.0.0.1:${debugPort + 1}`] : [],
  });
  core.stdout.on("data", (chunk) => process.stdout.write(chunk));
  core.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    errors = `${errors}${chunk}`.slice(-4000);
  });
  core.once("exit", (code) => {
    core = null;
    if (quitting) return;
    if (code) dialog.showErrorBox("Moondog stopped", errors.trim() || `The core process exited with code ${code}.`);
    app.quit();
  });
  core.postMessage({ type: "port" }, [port2]);
  window.webContents.postMessage("room", null, [port1]);
}

// The window opens where it was, if that place is still on a screen.
const boundsFile = () => path.join(app.getPath("userData"), "window.json");
function savedBounds() {
  try {
    const bounds = JSON.parse(readFileSync(boundsFile(), "utf8"));
    const visible = screen.getAllDisplays().some(({ workArea: area }) =>
      bounds.x < area.x + area.width - 80 && bounds.x + bounds.width > area.x + 80 && bounds.y >= area.y - 10 && bounds.y < area.y + area.height - 80);
    return visible && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isInteger) ? bounds : null;
  } catch { return null; }
}
let boundsTimer = null;
const saveBounds = () => {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    try { writeFileSync(boundsFile(), JSON.stringify(window.getNormalBounds())); } catch { /* The next launch uses the default size. */ }
  }, 400);
};

// Right-click offers what the text under the pointer allows, in the window's language.
function contextMenu(params) {
  const t = windowStrings(locale);
  const items = [
    ...(params.dictionarySuggestions ?? []).slice(0, 4).map((word) => ({ label: word, click: () => window.webContents.replaceMisspelling(word) })),
    ...(params.dictionarySuggestions?.length ? [{ type: "separator" }] : []),
    ...(params.isEditable ? [{ label: t("menuCut"), role: "cut", enabled: params.editFlags.canCut }] : []),
    ...(params.selectionText || params.isEditable ? [{ label: t("menuCopy"), role: "copy", enabled: params.editFlags.canCopy }] : []),
    ...(params.isEditable ? [{ label: t("menuPaste"), role: "paste", enabled: params.editFlags.canPaste }, { label: t("menuSelectAll"), role: "selectAll" }] : []),
  ];
  if (items.length) Menu.buildFromTemplate(items).popup({ window });
}

function createWindow() {
  const bounds = savedBounds();
  window = new BrowserWindow({
    ...(bounds ?? { width: 1240, height: 800 }),
    minWidth: 760,
    minHeight: 520,
    title: "Moondog",
    backgroundColor: background(),
    titleBarStyle: "hiddenInset",
    // Centered on the page's 44px bar (app/renderer/tokens.css --bar).
    trafficLightPosition: { x: 18, y: 15 },
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      // The agent starts previews from the core, without a click in the window.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  // Links open in the listener's browser; the window itself never navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//u.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("context-menu", (_event, params) => contextMenu(params));
  window.on("resize", saveBounds);
  window.on("move", saveBounds);
  // Automated checks open the window without taking focus from the listener.
  window.once("ready-to-show", () => (process.env.MOONDOG_APP_DEBUG_PORT ? window.showInactive() : window.show()));
  window.webContents.once("did-finish-load", openCore);
  // Closing the window hides it; the core and its music keep going until Quit.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  void window.loadFile(path.join(here, "dist", "index.html"));
}

// Native menus for the page: a conversation's actions, and the model, device and service pickers.
// The page sends plain items { id, label, checked, enabled, type, submenu }; the chosen id comes back.
const menuTemplate = (items, choose) => items.map((item) => item.type === "separator" ? { type: "separator" } : {
  label: String(item.label ?? ""), enabled: item.enabled !== false,
  ...(item.checked !== undefined ? { type: "checkbox", checked: item.checked === true } : {}),
  ...(Array.isArray(item.submenu) ? { submenu: menuTemplate(item.submenu, choose) } : { click: () => choose(item.id) }),
});
// On macOS the menu can report closing before the chosen item's click runs, so a click answers at
// once and closing answers "nothing" only a moment later.
ipcMain.handle("menu", (_event, { items, x, y }) => new Promise((resolve) => {
  const menu = Menu.buildFromTemplate(menuTemplate(Array.isArray(items) ? items : [], (id) => resolve(id)));
  menu.popup({ window, ...(Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : {}),
    callback: () => setTimeout(() => resolve(null), 150) });
}));
// A confirmation for something that cannot be undone, such as deleting a conversation.
ipcMain.handle("confirm", async (_event, { message, detail, confirm, cancel }) => {
  const { response } = await dialog.showMessageBox(window, { type: "warning", message: String(message ?? ""), detail: String(detail ?? ""),
    buttons: [String(confirm ?? "OK"), String(cancel ?? "Cancel")], defaultId: 1, cancelId: 1 });
  return response === 0;
});
ipcMain.handle("choose-file", async (_event, { title, filterName } = {}) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: String(title ?? ""), properties: ["openFile"],
    filters: [{ name: String(filterName ?? "Listening history"), extensions: ["zip", "json", "xml", "csv"] }] });
  return canceled ? null : filePaths[0] ?? null;
});
ipcMain.handle("version", () => app.getVersion());

// Apple Music's whole songs come from a helper MusicKit knows as Moondog (native/music.swift): it sits
// beside the app's own executable when packaged, and in its own bundle for development. It starts the
// first time the window asks and goes when the app quits. One JSON object per line each way.
const MUSIC_COMMANDS = new Set(["check", "authorize", "play", "pause", "resume", "next", "previous", "seek", "stop"]);
let musicHelper = null;
let musicSequence = 0;
const musicWaiting = new Map();
const musicHelperFile = () => (app.isPackaged ? path.join(path.dirname(app.getPath("exe")), "moondog-music")
  : path.join(here, "native", "build", "Moondog Music.app", "Contents", "MacOS", "moondog-music"));
function startMusicHelper() {
  if (musicHelper || process.platform !== "darwin" || !existsSync(musicHelperFile())) return musicHelper;
  const helper = spawn(musicHelperFile(), [], { stdio: ["pipe", "pipe", "ignore"] });
  musicHelper = helper;
  let buffer = "";
  helper.stdout.setEncoding("utf8");
  helper.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type === "answer" && musicWaiting.has(message.id)) { musicWaiting.get(message.id)(message); musicWaiting.delete(message.id); }
      else if (message.type === "state") window?.webContents.send("apple-music", message);
    }
  });
  // A helper that fails to start or stops answers everything waiting, and the window hears it went.
  let gone = false;
  const lost = () => {
    if (gone) return;
    gone = true;
    if (musicHelper === helper) musicHelper = null;
    for (const resolve of musicWaiting.values()) resolve({ error: "helperExited", canPlay: false });
    musicWaiting.clear();
    window?.webContents.send("apple-music", { type: "exited" });
  };
  helper.once("exit", lost);
  helper.once("error", lost);
  helper.stdin.on("error", () => {});
  return helper;
}
ipcMain.handle("apple-music", (_event, command) => new Promise((resolve) => {
  if (!MUSIC_COMMANDS.has(command?.type)) return resolve({ error: "unknownCommand" });
  if (quitting) return resolve({ error: "unavailable", canPlay: false });
  const helper = startMusicHelper();
  if (!helper) return resolve({ error: "unavailable", canPlay: false });
  // Only what each command needs crosses over: catalog ids are digits, a position is a number.
  const message = { type: command.type, id: ++musicSequence };
  if (command.type === "play") {
    // A queue with any id that isn't a catalog id goes back whole, so the window plays previews instead.
    const ids = Array.isArray(command.ids) ? command.ids.map(String) : [];
    if (!ids.length || ids.length > 100 || !ids.every((id) => /^\d{1,20}$/u.test(id))) return resolve({ error: "invalidIds" });
    message.ids = ids;
    message.start = Number.isInteger(command.start) ? command.start : 0;
    if (typeof command.token === "string" && command.token.length <= 80) message.token = command.token;
  }
  if (command.type === "seek") message.ms = Number.isFinite(command.ms) ? Math.max(0, command.ms) : 0;
  musicWaiting.set(message.id, resolve);
  helper.stdin.write(`${JSON.stringify(message)}\n`);
  // Asking the listener waits for their answer; anything else answers quickly or not at all.
  setTimeout(() => { if (musicWaiting.delete(message.id)) resolve({ error: "timeout", canPlay: false }); }, command.type === "authorize" ? 300_000 : 20_000);
}));

// The page reports the language the core speaks, which a saved choice can set.
ipcMain.on("language", (_event, value) => {
  if (typeof value !== "string" || value === locale) return;
  locale = windowLocale([value]);
  buildMenu();
});
// A reply in progress shows in the Dock while the window is away, and keeps the hidden window
// drawing at full speed until it ends. An idle hidden window is throttled, so its timers rest
// while the music plays for hours; previews still play, because a window making sound is never throttled.
ipcMain.on("busy", (_event, busy) => {
  window?.setProgressBar(busy === true ? 2 : -1, { mode: "indeterminate" });
  window?.webContents.setBackgroundThrottling(busy !== true);
});
ipcMain.on("playback", (_event, next) => {
  const controllable = next?.controllable === true;
  const streaming = next?.streaming === true;
  if (controllable === playback.controllable && streaming === playback.streaming) return;
  Object.assign(playback, { controllable, streaming });
  for (const menu of [Menu.getApplicationMenu(), dockMenu]) {
    for (const id of ["toggle-playback", "next", "previous"]) { const item = menu?.getMenuItemById(id); if (item) item.enabled = controllable; }
  }
  const menu = Menu.getApplicationMenu();
  const stop = menu?.getMenuItemById("stop");
  if (stop) stop.enabled = streaming;
});
nativeTheme.on("updated", () => window?.setBackgroundColor(background()));
// Quitting first asks the core to stop its replies and close its conversations, so each one is
// saved as it ended; a core that takes too long is stopped.
let stopping = false;
app.on("before-quit", (event) => {
  quitting = true;
  // The helper stops its songs and exits when its pipe closes.
  musicHelper?.stdin.end();
  if (!core) return;
  event.preventDefault();
  if (stopping) return;
  stopping = true;
  const running = core;
  const timer = setTimeout(() => running.kill(), 5000);
  running.once("exit", () => {
    clearTimeout(timer);
    app.quit();
  });
  running.postMessage({ type: "quit" });
});
app.on("activate", () => window?.show());
app.whenReady().then(() => {
  locale = windowLocale(app.getPreferredSystemLanguages());
  buildMenu();
  createWindow();
});
