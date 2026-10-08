// The real listening room, running in the page with fictional data.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { runMoondogTui } from "../../src/surfaces/cli/tui.mjs";
import snapshot from "../generated/snapshot.json";
import { BrowserApplication, PreviewRuntime, needsApp } from "./browser-application.mjs";
import { RemoteRuntime } from "./remote-runtime.mjs";
import { XtermTerminal } from "./xterm-terminal.mjs";

// The room's own paper and charcoal colors, from src/surfaces/cli/brand-theme.mjs.
const PALETTES = {
  paper: { background: "#f4f4f4", foreground: "#141414", cursor: "#141414", cursorAccent: "#f4f4f4", selectionBackground: "#14141433" },
  charcoal: { background: "#0c0c0c", foreground: "#e4e4e4", cursor: "#e4e4e4", cursorAccent: "#0c0c0c", selectionBackground: "#e4e4e433" },
};

// With an agent URL, messages go to Moondog's public agent; without one, the room has no model.
export function openRoom(container, { agentUrl = "", humanCheck } = {}) {
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
  xterm.open(container);
  fit.fit();
  new ResizeObserver(() => fit.fit()).observe(container);

  // The room listens to the mouse wheel; until a visitor clicks in, the wheel scrolls the page.
  container.addEventListener("wheel", (event) => {
    if (!container.contains(document.activeElement)) event.stopPropagation();
  }, { capture: true });

  // The room reads these the way it reads a real terminal's environment.
  const environment = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLORFGBG: dark ? "15;0" : "0;15",
    MOONDOG_LANGUAGE: "en",
    ...(matchMedia("(prefers-reduced-motion: reduce)").matches ? { MOONDOG_MOTION: "off" } : {}),
  };
  Object.assign(process.env, environment);
  const signals = { once() { return this; }, on() { return this; }, removeListener() { return this; }, off() { return this; } };

  const run = () => runMoondogTui({
    application: new BrowserApplication(snapshot),
    runtime: agentUrl ? new RemoteRuntime(agentUrl, { humanCheck }) : new PreviewRuntime(),
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

  return {
    focus: () => xterm.focus(),
    // Lets on-screen keys type into the room on phones.
    send: (data) => { xterm.input(data, true); xterm.focus(); },
  };
}
