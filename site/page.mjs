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

function trackFor(sound) {
  if (!tracks.has(sound)) {
    const audio = new Audio(sound);
    audio.preload = "auto";
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
  if (track.audio.paused) {
    // A song joined late starts where the scene is in it.
    const at = Math.max(0, (Date.now() - song.startedAt) / 1000);
    if (track.audio.ended || at >= (track.audio.duration || Infinity)) return;
    track.audio.currentTime = at;
    void track.audio.play().catch(() => {});
  }
  ramp(track, 1, 1.2);
}

addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.source !== "moondog-scene") return;
  if ("mood" in event.data) { palette = event.data.mood; paintMood(); }
  if ("song" in event.data) { song = event.data.song; follow(); }
});
new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; follow(); }, { threshold: 0.35 }).observe(document.querySelector(".stage"));
document.addEventListener("visibilitychange", follow);
button.addEventListener("click", () => {
  on = !on;
  button.setAttribute("aria-pressed", String(on));
  context ??= new AudioContext();
  void context.resume();
  follow();
});

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
