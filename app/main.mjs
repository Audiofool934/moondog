// Moondog's desktop app: the real listening room in a window.
// The room runs unchanged in its own Node process (room-process.mjs). The window draws it
// with xterm.js and adds what a terminal can't: a preview player with media keys,
// and a room that keeps playing after the window closes.
import { app, BrowserWindow, dialog, MessageChannelMain, nativeTheme, shell, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// For automated checks: lets a DevTools client drive the window.
if (process.env.MOONDOG_APP_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.MOONDOG_APP_DEBUG_PORT);

// The room's paper and charcoal, from src/surfaces/cli/brand-theme.mjs.
const background = () => (nativeTheme.shouldUseDarkColors ? "#0c0c0c" : "#f4f4f4");

// Variables that would make the room think it runs inside another terminal.
const terminalIdentity = [
  "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "TERMINAL_EMULATOR", "KITTY_WINDOW_ID",
  "GHOSTTY_RESOURCES_DIR", "WEZTERM_PANE", "ITERM_SESSION_ID", "WARP_SESSION_ID", "WARP_TERMINAL_SESSION_UUID",
  "WT_SESSION", "TMUX", "STY", "COLUMNS", "LINES",
];

// Opened from Finder or the Dock, the app gets a minimal PATH, and the room couldn't find
// programs such as codex for web research. The packaged app gives it the PATH a login shell sets.
const loginShellPath = !app.isPackaged ? Promise.resolve(null) : new Promise((resolve) => {
  execFile(os.userInfo().shell || "/bin/zsh", ["-lc", 'printf "\\n__MOONDOG_PATH__%s\\n" "$PATH"'], { timeout: 3000 },
    (_error, stdout) => resolve(String(stdout ?? "").match(/__MOONDOG_PATH__(.+)/u)?.[1] ?? null));
});

function roomEnvironment(shellPath) {
  const environment = { ...process.env };
  for (const name of terminalIdentity) delete environment[name];
  return {
    ...environment,
    ...(shellPath ? { PATH: shellPath } : {}),
    // The packaged app updates as a whole, so the npm update notice doesn't apply.
    ...(app.isPackaged ? { MOONDOG_UPDATE_CHECK: "off" } : {}),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLORFGBG: nativeTheme.shouldUseDarkColors ? "15;0" : "0;15",
    TERM_PROGRAM: "moondog-app",
    // Room components may mark cells for the window to paint (app/renderer/blocks.mjs).
    MOONDOG_HOST: "app",
    // xterm.js draws OSC 8 links, and the window opens them in the browser.
    PI_HYPERLINKS: "1",
  };
}

let window = null;
let room = null;
let quitting = false;

async function openRoom() {
  const shellPath = await loginShellPath;
  const { port1, port2 } = new MessageChannelMain();
  let errors = "";
  const debugPort = Number(process.env.MOONDOG_APP_DEBUG_PORT);
  room = utilityProcess.fork(path.join(here, "room-process.mjs"), [], {
    serviceName: "Moondog room",
    stdio: "pipe",
    env: roomEnvironment(shellPath),
    // Automated checks can also reach the room process, one port above the window's.
    execArgv: debugPort ? [`--inspect=127.0.0.1:${debugPort + 1}`] : [],
  });
  room.stdout.on("data", (chunk) => process.stdout.write(chunk));
  room.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    errors = `${errors}${chunk}`.slice(-4000);
  });
  room.on("message", (message) => {
    if (message?.type === "title") window?.setTitle(message.title || "Moondog");
    // A busy room shows in the Dock while the window is away.
    if (message?.type === "progress") window?.setProgressBar(message.active ? 2 : -1, { mode: "indeterminate" });
  });
  room.once("exit", (code) => {
    room = null;
    if (quitting) return;
    if (code) dialog.showErrorBox("The room stopped", errors.trim() || `The room process exited with code ${code}.`);
    app.quit();
  });
  room.postMessage({ type: "port" }, [port2]);
  window.webContents.postMessage("room", null, [port1]);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    title: "Moondog",
    backgroundColor: background(),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 13 },
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // Previews keep playing and the room keeps drawing while the window is hidden.
      backgroundThrottling: false,
    },
  });
  // Links open in the listener's browser; the window itself never navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//u.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // Automated checks open the window without taking focus from the listener.
  window.once("ready-to-show", () => (process.env.MOONDOG_APP_DEBUG_PORT ? window.showInactive() : window.show()));
  window.webContents.once("did-finish-load", openRoom);
  // Closing the window hides it; the room and its music keep going until Quit.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  void window.loadFile(path.join(here, "dist", "index.html"));
}

app.on("before-quit", () => {
  quitting = true;
  room?.kill();
});
app.on("activate", () => window?.show());
app.whenReady().then(createWindow);
