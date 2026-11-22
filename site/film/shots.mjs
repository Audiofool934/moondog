// What every film window shares: a clock, the scene's pointer, and the gestures a shot is made of.
// A gesture is what a listener would do: glide to a control, click it, type.
import { FADE_MS, createClock, createPointer, middle } from "../window/director.mjs";

export const clock = createClock();
clock.run(true);
export const pointer = createPointer(clock);
export const wait = (ms) => clock.wait(ms);

// Waits for something the window is about to draw.
export async function appear(selector, root = document) {
  for (let waited = 0; waited < 6000; waited += 40) {
    const found = root.querySelector(selector);
    if (found?.getClientRects().length) return found;
    await clock.wait(40);
  }
  throw new Error(`The film waited for ${selector}, and it never showed`);
}

// The pointer fades in at a place, where a hand would rest before it moves.
export async function enter(point) {
  if (pointer.shown) return;
  pointer.jump(point);
  pointer.show();
  await clock.wait(FADE_MS);
}
export async function leave() {
  pointer.hide();
  await clock.wait(FADE_MS);
}

const target = async (what) => (typeof what === "string" ? appear(what) : what);
// Glides to a control and clicks it. from: where the pointer comes in when it isn't showing yet.
export async function click(what, { ms = 850, rest = 260, dx = 0, from = null } = {}) {
  const element = await target(what);
  const to = middle(element, dx);
  if (!pointer.shown) await enter(from ?? { x: to.x + 150, y: to.y + 110 });
  await pointer.move(to, ms);
  await clock.wait(rest);
  await pointer.click();
}
export async function glide(what, { ms = 850, dx = 0, from = null } = {}) {
  const element = await target(what);
  const to = middle(element, dx);
  if (!pointer.shown) await enter(from ?? { x: to.x + 150, y: to.y + 110 });
  await pointer.move(to, ms);
}

// Types into a field a key at a time, with the small unevenness of a hand; all at once, it is a paste.
export async function type(field, text, { paste = false } = {}) {
  const put = (value) => { field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); };
  if (paste) { put(text); return; }
  for (const letter of text) {
    put(field.value + letter);
    await clock.wait(40 + Math.random() * 62 + (letter === " " ? 36 : 0));
  }
}

// Where the pointer is in this window, for the stage to pass to the real mouse; null while it is hidden.
export function pointerPlace() {
  const mark = document.querySelector(".pointer");
  if (!mark?.classList.contains("shown")) return null;
  const moved = new DOMMatrix(getComputedStyle(mark).transform);
  return { x: moved.m41, y: moved.m42 };
}
