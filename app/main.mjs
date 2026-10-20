// Moondog for Mac: a native window on the same core as the `moondog` command, as a desktop
// app is to its command line. The core runs in its own Node process (core-process.mjs); the
// window draws conversations, the conversation, and what is playing, and keeps the music
// going after it closes.
import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, nativeTheme, screen, shell, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { windowLocale, windowStrings } from "./strings.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// For automated checks: lets a DevTools client drive the window.
if (process.env.MOONDOG_APP_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.MOONDOG_APP_DEBUG_PORT);

// The window's canvas, from app/renderer/style.css.
const background = () => (nativeTheme.shouldUseDarkColors ? "#1A1A19" : "#F8F8F6");
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
    // The packaged app updates as a whole, so the npm update notice doesn't apply.
    ...(app.isPackaged ? { MOONDOG_UPDATE_CHECK: "off" } : {}),
  };
}

let window = null;
let core = null;
let quitting = false;
const command = (name) => () => window?.webContents.send("command", name);

function buildMenu() {
  const t = windowStrings(locale);
  const dev = !app.isPackaged;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Moondog", submenu: [
      { label: t("menuAbout"), role: "about" },
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
      { label: t("menuStop"), accelerator: "CmdOrCtrl+.", click: command("stop") },
    ] },
    { label: t("menuPlayback"), submenu: [
      // The page handles these keys itself, so typing a space or moving the cursor still works.
      { label: t("menuPlayPause"), accelerator: "Space", registerAccelerator: false, click: command("toggle-playback") },
      { label: t("menuNext"), accelerator: "CmdOrCtrl+Right", registerAccelerator: false, click: command("next") },
      { label: t("menuPrevious"), accelerator: "CmdOrCtrl+Left", registerAccelerator: false, click: command("previous") },
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
    trafficLightPosition: { x: 20, y: 19 },
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // Previews keep playing while the window is hidden.
      backgroundThrottling: false,
      spellcheck: true,
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

// The page reports the language the core speaks, which a saved choice can set.
ipcMain.on("language", (_event, value) => {
  if (typeof value !== "string" || value === locale) return;
  locale = windowLocale([value]);
  buildMenu();
});
// A reply in progress shows in the Dock while the window is away.
ipcMain.on("busy", (_event, busy) => window?.setProgressBar(busy === true ? 2 : -1, { mode: "indeterminate" }));
nativeTheme.on("updated", () => window?.setBackgroundColor(background()));
app.on("before-quit", () => {
  quitting = true;
  core?.kill();
});
app.on("activate", () => window?.show());
app.whenReady().then(() => {
  locale = windowLocale(app.getPreferredSystemLanguages());
  buildMenu();
  createWindow();
});
