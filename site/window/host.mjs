// Stands in for the desktop app's preload and core process, so the app's own window plays the page's
// scene. The core's side is the app's window-room, on the scene's agent and Music app (agent.mjs,
// application.mjs); the director (director.mjs) moves the pointer and types, as a visitor would.
import { coverPalette } from "../../app/renderer/mood.mjs";
import { runWindowRoom } from "../../app/window-room.mjs";
import { SceneAgent } from "./agent.mjs";
import { SceneApplication, createSceneMusicApp } from "./application.mjs";
import { createClock, direct, leanArm } from "./director.mjs";
import { EXCHANGES, IDENT, MODEL } from "./scene.mjs";

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
// click on it, and nobody clicks in here. The scene tells it which song plays from when, and the cover's
// colours, read as the window reads them, so the whole page takes the cover's light; and when it ends.
const tell = (news) => { if (window.parent !== window) window.parent.postMessage({ source: "moondog-scene", ...news }, location.origin); };
function playing(song, startedAt) {
  tell({ song: song.sound ? { sound: song.sound, startedAt } : null });
  void coverPalette(song.image).then((mood) => tell({ mood }));
}

const quick = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clock = createClock({ quick });
const musicApp = createSceneMusicApp({ onPlay: playing });
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

// The page says when the scene may begin (page.mjs): on the visitor's own click on its cover, which puts
// the needle down, or on its own after a while; and on every play after the first, at once. A pointer
// over the cover leans the arm. Each needle drop starts the station's ident, before the first song.
const begin = Promise.withResolvers();
addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.source !== "moondog-page") return;
  if (event.data.start) begin.resolve({ touch: event.data.start.touch === true });
  if ("lean" in event.data) leanArm(event.data.lean === true);
  // The page may load after this frame; it asks, and hears that the scene is ready.
  if (event.data.ask) tell(ready);
});
// Ready, with the sounds the first moments play, so the page can load them while its cover shows.
const ready = { ready: true, sounds: [IDENT, ...EXCHANGES[0].songs.slice(0, 1).map((song) => song.sound)] };
tell(ready);
const ident = () => tell({ song: { sound: IDENT, startedAt: Date.now() } });

void direct({ clock, agent, request: EXCHANGES[1].request, quick, begin: begin.promise, needle: ident, ending: () => tell({ song: null, mood: null }) });
