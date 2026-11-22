// The film's setup windows: the app's own window on the harness's stand-in core
// (app/harness-preload.cjs). There is one window for each shot, set to its state as it loads: the first
// run of a new install, an import before it is saved, and the taste page.
import { appear, click, leave, pointer, pointerPlace, type, wait } from "./shots.mjs";

// Nobody types in these windows, so nothing takes focus and no caret blinks on its own time.
HTMLElement.prototype.focus = function focusNowhere() {};

const shot = new URLSearchParams(location.search).get("shot");
// What the made-up listener brings: the numbers the harness's taste page shows.
const PREVIEW = { title: "Spotify extended streaming history", notice: "Nothing is saved until you add it.",
  paragraphs: ["18,406 plays from February 2016 to November 2026", "1,204 artists, 3,904 songs", "Most played: The Hollow Pines, Juniper & Vale, Okara Strings"] };
function slash(command) {
  const input = document.querySelector("[data-input]");
  input.value = `/${command}`;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

window.__shots = {
  pointerPlace,
  // The first run's first question. The pointer picks Apple Music, and the sheet moves on to the model.
  async service() {
    await click('[data-key="service:apple_music"]', { ms: 900, rest: 300, dx: -120 });
  },
  // The second question: an invite code for Moondog's own model, pasted, then Use code. The model
  // answers, the first run ends, and the sheet closes on the room.
  async model() {
    const field = await appear('[data-key="field:inviteCode"]');
    await click(field, { ms: 800, rest: 220 });
    await wait(260);
    await type(field, "md-7k2m9x4q8w1c5t3n6b0zfhjr", { paste: true });
    await wait(450);
    await click('[data-key="submit:inviteCode"]', { ms: 520, rest: 240 });
    await wait(260);
    await leave();
  },
  // Add to profile, on an import that shows what is inside before it saves.
  async add() {
    await click('[data-key="import:commit"]', { ms: 1000, rest: 340 });
    await wait(240);
    await leave();
  },
  // A name in the liner notes lights that artist's plays across the pressed record; then another.
  async names() {
    const rows = () => [...document.querySelectorAll(".pressing .person")];
    await appear(".pressing .person");
    const named = (name) => rows().find((row) => row.querySelector("strong")?.textContent === name) ?? rows()[0];
    await click(named("Juniper & Vale"), { ms: 1000, rest: 260, dx: -70 });
    await wait(1700);
    await click(named("The Hollow Pines"), { ms: 620, rest: 240, dx: -70 });
    await wait(500);
    pointer.hide();
  },
};

// As the harness does between a load and a state: the window hears its core first.
void (async () => {
  await wait(350);
  if (shot === "setup") window.__harness.setState("first-run-new");
  else {
    window.__harness.setState("new-room");
    await wait(300);
    if (shot === "history") window.__harness.send({ type: "import", stage: "preview", preview: PREVIEW });
    if (shot === "taste") slash("taste");
  }
  await wait(700);
  window.parent.postMessage({ source: "moondog-scene", ready: shot }, location.origin);
})();
