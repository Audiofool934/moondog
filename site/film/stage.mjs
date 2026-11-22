// The film: about a minute of Moondog, from the needle's drop to the record turning in the whole window.
// The stage holds four of the app's own windows and shows one at a time: the listening room (room.mjs),
// and three setup windows (harness-shots.mjs). This script is the cut: which window shows, what each
// one does, and the line of words under it. render.mjs records it a frame at a time and mixes the sound
// from the cues the stage keeps.
import { moodColours } from "../../app/renderer/mood.mjs";
import { IDENT } from "../window/scene.mjs";
import "./film.css";

// The first song's file is this long (site/README.md); the second comes in under its last second.
const FIRST_SONG_MS = 32_000;
const OVERLAP_MS = 900;

const find = (name, value) => document.querySelector(value ? `[data-${name}="${value}"]` : `[data-${name}]`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const windows = Object.fromEntries([...document.querySelectorAll("[data-window]")].map((frame) => [frame.dataset.window, frame]));
const shots = (name) => windows[name].contentWindow.__shots;
let showing = "room";
function show(name) {
  showing = name;
  for (const [key, frame] of Object.entries(windows)) frame.classList.toggle("on", key === name);
}

// One line of words under the window. A new line waits for the last one to fade.
const line = find("caption");
let said = 0;
async function say(text) {
  const mine = (said += 1);
  line.classList.remove("on");
  if (line.textContent) await wait(260);
  if (mine !== said) return;
  line.textContent = text ?? "";
  if (text) line.classList.add("on");
}

// The windows tell the stage when they are ready, when a song starts, and the colours of its cover,
// which light the stage as they light the project page.
const stage = { started: false, done: false, cues: [], length: 0,
  // Where the film's pointer is on the stage, for the recorder's real mouse; null while it is hidden.
  mouse() {
    const place = shots(showing)?.pointerPlace?.();
    if (!place) return null;
    // The window is shown larger than it is drawn (film.css), so its points are scaled to the stage's.
    const box = windows[showing].getBoundingClientRect();
    const larger = box.width / windows[showing].clientWidth;
    return { x: Math.round(box.left + place.x * larger), y: Math.round(box.top + place.y * larger) };
  } };
window.__stage = stage;
let began = 0;
const now = () => performance.now() - began;
const cue = (sound) => stage.cues.push({ at: Math.round(now()), sound });
const mood = find("mood");
const ready = new Set();
let whenReady = null;
let whenSong = null;
const allReady = new Promise((resolve) => { whenReady = resolve; });
const nextSong = () => new Promise((resolve) => { whenSong = resolve; });
addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.source !== "moondog-scene") return;
  const news = event.data;
  if (news.ready) { ready.add(news.ready); if (Object.keys(windows).every((name) => ready.has(name))) whenReady(); }
  if (news.song) {
    cue(news.song);
    // The ident answers the needle; a song is what the cut waits for.
    if (news.song !== IDENT) { whenSong?.(now()); whenSong = null; }
  }
  if (news.mood !== undefined) {
    moodColours(news.mood, false).forEach((colour, index) => mood.style.setProperty(`--mood-${index + 1}`, colour));
    mood.classList.toggle("playing", Boolean(news.mood));
  }
});

async function film() {
  await allReady;
  await wait(700);
  began = performance.now();
  stage.started = true;

  // The card, in silence.
  await wait(1500);
  find("card", "open").classList.remove("on");
  await wait(450);

  // The needle, and the station's ident with it. Moondog picks something for right now, and the first
  // song starts.
  void say("A radio host, just for you.");
  await wait(500);
  const picked = shots("room").answered();
  const firstSong = nextSong();
  await shots("room").needle();
  const startedAt = await firstSong;
  void say("It knows what you play, and picks something for right now.");
  await picked;
  await wait(1300);

  // Setting it up, once: where you listen, then a model.
  show("setup");
  void say("Set it up once. Tell it where you listen,");
  await wait(700);
  await shots("setup").service();
  void say("and give it a model to talk through.");
  await shots("setup").model();
  await wait(700);

  // Your history, shown before it is saved.
  show("history");
  void say("Bring your history. It shows what's inside before anything is saved.");
  await wait(1300);
  await shots("history").add();
  await wait(600);

  // Your taste, pressed as a record.
  show("taste");
  void say("It learns your taste, and shows you the evidence.");
  await wait(800);
  await shots("taste").names();
  await wait(500);

  // A request in the listener's own words. Its song comes in under the end of the first.
  show("room");
  void say("Then ask in your own words.");
  await wait(500);
  const answered = shots("room").answered();
  const secondSong = nextSong();
  await shots("room").ask("Something for a late train home", { playsIn: Math.max(0, startedAt + FIRST_SONG_MS - OVERLAP_MS - now()) });
  await secondSong;
  void say("Every pick comes with its reason.");
  await answered;
  await wait(700);
  await shots("room").player();
  await wait(2500);

  // The record takes the whole window.
  void say("Or just let the record turn.");
  await shots("room").record();
  await wait(5200);

  // The closing card.
  void say(null);
  find("card", "close").classList.add("on");
  await wait(4800);
  stage.length = Math.round(now());
  stage.done = true;
}
void film().catch((error) => { console.error(error); stage.failed = String(error?.stack ?? error); stage.done = true; });
