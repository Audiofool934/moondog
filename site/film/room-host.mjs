// The host of the film's listening room: the page scene's core (site/window), with the made-up listener,
// songs and covers of the project page. Where the page's scene plays itself in a loop, this window waits
// for the stage (stage.mjs) to call each shot.
import { coverPalette } from "../../app/renderer/mood.mjs";
import { runWindowRoom } from "../../app/window-room.mjs";
import { SceneAgent } from "../window/agent.mjs";
import { SceneApplication, createSceneMusicApp } from "../window/application.mjs";
import { $, HOME, armPoint, inside, middle, settled } from "../window/director.mjs";
import { EXCHANGES, IDENT } from "../window/scene.mjs";
import { click, clock, enter, leave, pointer, pointerPlace, type, wait } from "./shots.mjs";

// The window and the core talk over one message port, as in the app (site/window/host.mjs).
const channel = new MessageChannel();
const core = {
  on: (kind, listener) => channel.port1.addEventListener(kind, listener),
  removeListener: (kind, listener) => channel.port1.removeEventListener(kind, listener),
  postMessage: (message) => channel.port1.postMessage(message),
  start: () => channel.port1.start(),
  close: () => channel.port1.close(),
};
const announce = () => window.postMessage("moondog-room", "*", [channel.port2]);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce, { once: true });
else announce();
HTMLElement.prototype.focus = function focusNowhere() {};
try { localStorage.setItem("moondog.record", "open"); } catch { /* The defaults are the same. */ }
window.moondogApp = { setLanguage(locale) { document.documentElement.lang = locale; } };

// The stage hears each song as it starts, for the film's sound, and the cover's colours, for its light.
const tell = (news) => window.parent.postMessage({ source: "moondog-scene", ...news }, location.origin);
// The film's listener set Moondog's own model in the first run, so the room talks through it.
const MODEL = { provider: "moondog", model: "moondog", providerName: "Moondog", modelName: "Moondog" };
const musicApp = createSceneMusicApp({ onPlay(song) {
  tell({ song: song.sound ?? null });
  void coverPalette(song.image).then((mood) => tell({ mood }));
} });
const application = new SceneApplication({ musicApp });
const agent = new SceneAgent({ application, musicApp, clock, exchanges: EXCHANGES, model: MODEL });
void runWindowRoom({
  application,
  runtime: agent,
  modelSettings: {
    providers: async () => [{ id: MODEL.provider, name: MODEL.providerName, modelCount: 1, signIn: "invite", signedIn: true, source: "saved" }],
    models: async (provider) => ({ provider, refresh: null, models: [{ id: MODEL.model, name: MODEL.modelName, effortLevels: [] }] }),
    list: async () => ({ models: [{ provider: MODEL.provider, model: MODEL.model, name: MODEL.modelName, providerName: MODEL.providerName, ready: true, reasoning: false }],
      default: { provider: MODEL.provider, model: MODEL.model, effort: null, reasoning: false, thinking: null } }),
  },
}, { port: core, send: (message) => core.postMessage(message) });

const stepsOf = (index) => EXCHANGES[index].steps.reduce((sum, step) => sum + step.ms, 0);
let home = null;

window.__shots = {
  pointerPlace,
  // How long Moondog works on each exchange before its song starts.
  leads: [stepsOf(0), stepsOf(1)],
  // The pointer comes in beside the record, glides to its arm and clicks: Moondog picks something for
  // right now. Resolves once the click has landed; answered() tells when the reply is written.
  async needle() {
    home = inside(armPoint($("record"), null, HOME));
    await enter(home);
    const arm = armPoint();
    await pointer.move(arm, 750);
    await wait(140);
    await pointer.click();
    // The station's ident answers the needle, as on the page.
    tell({ song: IDENT });
    await wait(220);
    pointer.hide();
    await pointer.move({ x: arm.x + (home.x - arm.x) * 0.4, y: arm.y + (home.y - arm.y) * 0.4 }, 600);
  },
  answered: () => agent.answered(),
  // The player opens, with the song's cover and what is up next.
  async player() {
    await click($("toggle-inspector"), { ms: 900, rest: 300 });
    await wait(260);
    await leave();
  },
  // A request, typed and sent so that its song starts playsIn milliseconds from now.
  async ask(text, { playsIn = 0 } = {}) {
    const due = performance.now() + playsIn;
    await settled(clock);
    const input = $("input");
    await click(input, { ms: 900, rest: 220, dx: -input.getBoundingClientRect().width / 2 + 90 });
    pointer.hide();
    await type(input, text);
    await wait(Math.max(420, due - EXCHANGES[1].steps.reduce((sum, step) => sum + step.ms, 0) - performance.now()));
    $("form").requestSubmit();
  },
  // The record takes the whole window and turns in the cover's colours.
  async record() {
    const frame = $("record-frame");
    const hover = () => frame.classList.add("scene-hover");
    frame.addEventListener("pointermove", hover, { once: true });
    await enter(inside(middle($("record"), 260)));
    await pointer.move(middle($("expand")), 1100);
    hover();
    await wait(340);
    await pointer.click();
    frame.classList.remove("scene-hover");
    await wait(380);
    await leave();
  },
};
tell({ ready: "room" });
