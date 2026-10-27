// Stands in for the desktop app's preload and core process, so the app's own window plays the page's
// scene. The core's side is the app's window-room, on the scene's agent and Music app (agent.mjs,
// application.mjs); the director (director.mjs) moves the pointer and types, as a visitor would.
import { runWindowRoom } from "../../app/window-room.mjs";
import { SceneAgent } from "./agent.mjs";
import { SceneApplication, createSceneMusicApp } from "./application.mjs";
import { createClock, direct } from "./director.mjs";
import { EXCHANGES, MODEL } from "./scene.mjs";

// The window and the core talk over one message port, as in the app. window-room listens the way
// Electron's MessagePortMain does.
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

// The window is one frame among the page's words, and nobody types in it. It never takes focus, so
// playing the scene never scrolls the page or takes its keys.
HTMLElement.prototype.focus = function focusNowhere() {};
// Every play starts the same way: no conversations beside it, the player folded, the record open.
try {
  for (const [key, value] of [["moondog.sidebar", "hidden"], ["moondog.source", "chosen"], ["moondog.record", "open"]]) localStorage.setItem(key, value);
} catch { /* Without storage the window keeps its defaults, which are the same. */ }
window.moondogApp = { setLanguage(locale) { document.documentElement.lang = locale; } };

// The page plays the music when the visitor turns the sound on (page.mjs); a page plays sound only after a
// click on it, and nobody clicks in here. The scene tells it which song plays from when, and when it ends.
const tell = (song) => { if (window.parent !== window) window.parent.postMessage({ source: "moondog-scene", song }, location.origin); };

const quick = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clock = createClock({ quick });
const musicApp = createSceneMusicApp({ onPlay: (song, startedAt) => tell(song.sound ? { sound: song.sound, startedAt } : null) });
const application = new SceneApplication({ musicApp });
const agent = new SceneAgent({ application, musicApp, clock, exchanges: EXCHANGES, model: MODEL });

void runWindowRoom({
  application,
  runtime: agent,
  // The composer shows the scene's model by its maker's mark.
  modelSettings: {
    providers: async () => [{ id: MODEL.provider, name: MODEL.providerName, modelCount: 1, signIn: "api_key", signedIn: true, source: "environment" }],
    models: async (provider) => ({ provider, refresh: null, models: [{ id: MODEL.model, name: MODEL.modelName, effortLevels: [] }] }),
  },
}, { port: core, send: (message) => core.postMessage(message) });

void direct({ clock, agent, request: EXCHANGES[1].request, quick, ending: () => tell(null) });
