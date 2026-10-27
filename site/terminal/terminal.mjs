// The terminal's room, running unchanged in its own document on the fictional listener, with the small
// player for the agent's Apple Music previews and keys for touch screens under it.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./frame.css";
import { normalizeLocale } from "../../src/i18n/index.mjs";
import { runMoondogTui } from "../../src/surfaces/cli/tui.mjs";
import snapshot from "../generated/snapshot.json";
import { BrowserApplication, PreviewRuntime, needsApp } from "../listener/browser-application.mjs";
import { createHumanCheck } from "../listener/human-check.mjs";
import { RemoteRuntime } from "../listener/remote-runtime.mjs";
import { createPreviewPlayer } from "./preview-player.mjs";
import { XtermTerminal } from "./xterm-terminal.mjs";

// The room's own paper and charcoal colors, from src/surfaces/cli/brand-theme.mjs.
const PALETTES = {
  paper: { background: "#f4f4f4", foreground: "#141414", cursor: "#141414", cursorAccent: "#f4f4f4", selectionBackground: "#14141433" },
  charcoal: { background: "#0c0c0c", foreground: "#e4e4e4", cursor: "#e4e4e4", cursorAccent: "#0c0c0c", selectionBackground: "#e4e4e433" },
};

// The build sets these: the public agent's address when it runs, and Turnstile's key when it checks visitors.
const agentUrl = MOONDOG_AGENT_URL;
const siteKey = agentUrl ? MOONDOG_TURNSTILE_SITE_KEY : "";

const screen = document.querySelector("[data-screen]");
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const xterm = new Terminal({
  fontFamily: '"SF Mono", Menlo, "DejaVu Sans Mono", "Cascadia Mono", Consolas, monospace',
  fontSize: matchMedia("(max-width: 600px)").matches ? 12 : 13,
  lineHeight: 1,
  scrollback: 0,
  cursorBlink: true,
  theme: PALETTES[dark ? "charcoal" : "paper"],
});
const fit = new FitAddon();
xterm.loadAddon(fit);
xterm.open(screen);
fit.fit();
new ResizeObserver(() => fit.fit()).observe(screen);

// The room listens to the mouse wheel; until a visitor clicks in, the wheel scrolls the page.
screen.addEventListener("wheel", (event) => {
  if (!screen.contains(document.activeElement)) event.stopPropagation();
}, { capture: true });

// The room reads these the way it reads a real terminal's environment.
const locale = navigator.languages.map(normalizeLocale).find(Boolean) ?? "en";
const environment = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  COLORFGBG: dark ? "15;0" : "0;15",
  MOONDOG_LANGUAGE: locale,
  ...(matchMedia("(prefers-reduced-motion: reduce)").matches ? { MOONDOG_MOTION: "off" } : {}),
};
Object.assign(process.env, environment);
const signals = { once() { return this; }, on() { return this; }, removeListener() { return this; }, off() { return this; } };

const player = createPreviewPlayer(document.querySelector("[data-player]"));
const humanCheck = siteKey ? createHumanCheck(siteKey, document.querySelector("[data-check]")) : undefined;
const application = new BrowserApplication(snapshot, { locale });
const run = () => runMoondogTui({
  application,
  runtime: agentUrl ? new RemoteRuntime(agentUrl, { agent: snapshot.agent, application, humanCheck, onPreview: (tracks, album) => player.play(tracks, album) }) : new PreviewRuntime(),
  terminal: new XtermTerminal(xterm),
  signalTarget: signals,
  environment,
  lyrics: null,
  providers: () => snapshot.providers,
  models: (id) => snapshot.models[id] ?? [],
  refreshModels: async () => [],
  rebuildRuntime: async () => { throw needsApp("Connecting a model"); },
  prepareImport: async () => { throw needsApp("Reading your files"); },
  openImportHelp: async (url) => { window.open(url, "_blank", "noopener"); },
});

// Leaving the room (/quit) closes it; any key opens it again.
const session = async () => {
  try {
    await run();
    xterm.write("\x1b[2J\x1b[H\r\n  The room is closed. Press any key to open it again.\r\n");
  } catch (error) {
    console.error(error);
    xterm.write(`\r\n  The room stopped: ${String(error?.message ?? error)}\r\n  Press any key to open it again.\r\n`);
  }
  const reopen = xterm.onData(() => { reopen.dispose(); void session(); });
};
void session();
xterm.focus();

// Keys for touch screens type into the room.
const keys = { tab: "\t", up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" };
const send = (data) => { xterm.input(data, true); xterm.focus(); };
for (const button of document.querySelectorAll("[data-key]")) button.addEventListener("click", () => send(keys[button.dataset.key]));
for (const button of document.querySelectorAll("[data-command]")) button.addEventListener("click", () => send(`${button.dataset.command}\r`));
