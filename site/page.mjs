// The project page's script: the scene's light and music, and the copy button beside the install commands.
// The window's scene runs in its own frame (window/host.mjs).
import { moodColours } from "../app/renderer/mood.mjs";

// The cover that is playing lights the whole page, as it lights the window in the app: its colours, read
// in the frame, become the page's three faint fields, drifting in as the last ones fade.
const mood = document.querySelector("[data-mood]");
const dark = matchMedia("(prefers-color-scheme: dark)");
let palette = null;
function paintMood() {
  moodColours(palette, dark.matches).forEach((colour, index) => mood.style.setProperty(`--mood-${index + 1}`, colour));
  mood.classList.toggle("playing", Boolean(palette));
}
dark.addEventListener("change", paintMood);

// The scene's music. The frame says which song plays from when; the page plays it, because a page plays
// sound only after a click on it. It starts off, follows the scene while the window is on screen, and
// fades between songs.
const button = document.querySelector("[data-sound]");
let context = null;
let on = false;
let inView = false;
let song = null;
const tracks = new Map();

// Sounds are loaded before they are needed, while the cover shows, so the ident comes the instant the arm is clicked.
const loaded = new Map();
function load(sound) {
  if (!loaded.has(sound)) {
    const audio = new Audio(sound);
    audio.preload = "auto";
    loaded.set(sound, audio);
  }
  return loaded.get(sound);
}
function trackFor(sound) {
  if (!tracks.has(sound)) {
    const audio = load(sound);
    const gain = context.createGain();
    gain.gain.value = 0;
    context.createMediaElementSource(audio).connect(gain).connect(context.destination);
    tracks.set(sound, { audio, gain, stop: 0 });
  }
  return tracks.get(sound);
}
function ramp(track, to, seconds) {
  const now = context.currentTime;
  track.gain.gain.cancelScheduledValues(now);
  track.gain.gain.setValueAtTime(track.gain.gain.value, now);
  track.gain.gain.linearRampToValueAtTime(to, now + seconds);
}
function follow() {
  if (!context) return;
  const heard = on && inView && document.visibilityState === "visible";
  const wanted = heard && song ? song.sound : null;
  for (const [sound, track] of tracks) {
    if (sound === wanted || track.audio.paused) continue;
    ramp(track, 0, 0.9);
    const stop = ++track.stop;
    setTimeout(() => { if (track.stop === stop) track.audio.pause(); }, 950);
  }
  if (!wanted) return;
  const track = trackFor(wanted);
  track.stop += 1;
  // A song joined late starts where the scene is in it, faded in; one heard from its start, such as the
  // ident as the scene begins, comes in at once, with its first sound whole. A sound that played to its
  // end before, as the ident does on every play, starts again.
  let fadeIn = 1.2;
  if (track.audio.paused) {
    const at = Math.max(0, (Date.now() - song.startedAt) / 1000);
    if (at >= (track.audio.duration || Infinity)) return;
    track.audio.currentTime = at;
    if (at < 0.25) fadeIn = 0.02;
    void track.audio.play().catch(() => {});
  }
  ramp(track, 1, fadeIn);
}

// Sound needs a click on the page, so it starts inside one. iPhone mutes web audio with its ringer
// unless the page says it plays music.
function setSound(next) {
  on = next;
  button.setAttribute("aria-pressed", String(on));
  button.classList.remove("hint");
  if (on && navigator.audioSession) navigator.audioSession.type = "playback";
  context ??= new AudioContext();
  void context.resume();
  follow();
}
button.addEventListener("click", () => setSound(!on));

// The cover. The scene waits on the record until the visitor lets it begin, with sound, or chooses to
// watch without it; after a while on screen it begins on its own, silently, and the sound switch shows
// itself once. Then it plays on, again and again. The record doesn't answer the visitor's pointer: the
// scene's own pointer clicks the record's arm.
const frame = document.querySelector(".stage iframe");
const cover = document.querySelector("[data-cover]");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const WAIT_MS = 10_000;
let begun = false;
let waited = 0;
let waiting = null;
const toScene = (message) => frame.contentWindow?.postMessage({ source: "moondog-page", ...message }, location.origin);

function begin({ sound = false } = {}) {
  if (begun) return;
  begun = true;
  clearInterval(waiting);
  if (sound) setSound(true);
  cover.classList.add("leaving");
  setTimeout(() => { cover.hidden = true; }, 500);
  toScene({ start: true });
}
function ready() {
  if (begun) return toScene({ start: true });
  if (reduced) return begin();
  if (!cover.hidden) return;
  cover.hidden = false;
  waiting = setInterval(() => {
    if (inView && document.visibilityState === "visible") waited += 250;
    if (waited < WAIT_MS) return;
    begin();
    button.classList.add("hint");
  }, 250);
}
cover.addEventListener("click", (event) => begin({ sound: !event.target.closest("[data-silent]") }));

addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.source !== "moondog-scene") return;
  if (event.data.ready) { for (const sound of event.data.sounds ?? []) load(sound); ready(); }
  if ("mood" in event.data) { palette = event.data.mood; paintMood(); }
  if ("song" in event.data) { song = event.data.song; follow(); }
});
new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; follow(); }, { threshold: 0.35 }).observe(document.querySelector(".stage"));
document.addEventListener("visibilitychange", follow);
// The frame may have loaded first; it answers that it's ready.
toScene({ ask: true });

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const text = document.getElementById(button.dataset.copy).textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
      button.dataset.state = "done";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => { button.textContent = "Copy"; delete button.dataset.state; }, 2000);
  });
}
