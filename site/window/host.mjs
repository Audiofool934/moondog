// Stands in for the desktop app's preload and core process, so the app's own window runs in the page.
// The core's side is the app's window-room, here on the fictional listener and Moondog's public
// agent; the agent's Apple Music previews play in the window's own player. What the app does with
// the Mac (menus, dialogs, files, updates, the Apple Music helper) is drawn here or left out.
import { normalizeLocale } from "../../src/i18n/index.mjs";
import { createWindowPreviewPlayer } from "../../app/preview-player.mjs";
import { runWindowRoom } from "../../app/window-room.mjs";
// Only the demo agent's names; the window reads nothing else of the made-up listener.
import { agent } from "../generated/snapshot.json";
import { BrowserApplication, PreviewRuntime, needsApp } from "../listener/browser-application.mjs";
import { createHumanCheck } from "../listener/human-check.mjs";
import { RemoteRuntime } from "../listener/remote-runtime.mjs";
import { confirmAction, showMenu } from "./menus.mjs";

// The build sets these: the public agent's address when it runs, and Turnstile's key when it checks visitors.
const agentUrl = MOONDOG_AGENT_URL;
const siteKey = agentUrl ? MOONDOG_TURNSTILE_SITE_KEY : "";

// The window and the core talk over one message port, as in the app. window-room and the preview
// player listen the way Electron's MessagePortMain does.
const channel = new MessageChannel();
const core = {
  on: (type, listener) => channel.port1.addEventListener(type, listener),
  removeListener: (type, listener) => channel.port1.removeEventListener(type, listener),
  postMessage: (message) => channel.port1.postMessage(message),
  start: () => channel.port1.start(),
  close: () => channel.port1.close(),
};
// The page keeps the port from the first "moondog-room" message; module scripts run before DOMContentLoaded.
const announce = () => window.postMessage("moondog-room", "*", [channel.port2]);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce, { once: true });
else announce();

// What the app's preload offers, for what a page can do.
window.moondogApp = {
  pathForFile: () => null,
  onCommand() {},
  setLanguage(locale) { document.documentElement.lang = locale; },
  setBusy() {},
  setImmersive() {},
  setPinned: async () => false,
  dragWindow: async () => 0,
  setPlayback() {},
  showMenu,
  confirm: confirmAction,
  chooseFile: async () => null,
  version: async () => MOONDOG_VERSION,
  updateState: async () => null,
  onUpdate() {},
  installUpdate() {},
};

// Here the window is one frame among the page's words. It takes focus only once the visitor is in it,
// so loading it never scrolls the page or takes the keys meant for the page.
const focus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function focusInFrame(options) { if (document.hasFocus()) focus.call(this, options); };

// Every visit starts with no conversations, so their panel starts folded; the service is Apple Music's
// previews, so the window doesn't ask for one as on a first launch.
try {
  localStorage.setItem("moondog.sidebar", "hidden");
  localStorage.setItem("moondog.source", "chosen");
} catch { /* Without storage the window keeps its defaults. */ }

const locale = navigator.languages.map(normalizeLocale).find(Boolean) ?? "en";
const application = new BrowserApplication({}, { locale, playbackService: "apple_music" });
const check = document.querySelector("[data-check]");
const humanCheck = siteKey ? createHumanCheck(siteKey, check) : undefined;
const player = createWindowPreviewPlayer(core);
const runtime = agentUrl
  ? new RemoteRuntime(agentUrl, { agent, application, humanCheck, onPreview: (tracks, album) => player.play(tracks, { album }) })
  : new PreviewRuntime();
const status = runtime.publicStatus();
const unavailable = (what) => async () => { throw needsApp(what); };

void runWindowRoom({
  application,
  runtime,
  // The demo agent answers with one model; the window lists only that one.
  modelSettings: {
    providers: async () => (status.state === "configured"
      ? [{ id: agent.provider, name: agent.providerName, modelCount: 1, signIn: "api_key", signedIn: true, source: "environment" }]
      : []),
    models: async (provider) => ({ provider, refresh: null,
      models: status.state === "configured" && provider === agent.provider ? [{ id: agent.model, name: agent.modelName, effortLevels: [] }] : [] }),
    signIn: unavailable("Signing in"),
    signOut: unavailable("Signing out"),
  },
  rebuildRuntime: unavailable("Changing the model"),
  // The page plays Apple Music's previews and nothing else.
  savePlaybackService: unavailable("Another music service"),
  prepareImport: unavailable("Importing your history"),
  prepareRecentImport: unavailable("Importing your history"),
}, { port: core, send: (message) => core.postMessage(message) });
