// Page-side interaction checks for the fictional-data harness, not shipped with the app.
// MOONDOG_HARNESS_STATES=long MOONDOG_HARNESS_EVAL=check-ui.mjs npm run harness
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const $ = (name) => document.querySelector(`[data-${name}]`);
const over = (node) => node.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
await wait(700);
const tip = document.querySelector(".tip");
over($("new"));
await wait(400);
assert(tip.hidden, "A passing pointer must not open a tooltip within 400ms");
await wait(350);
assert(!tip.hidden, "A settled pointer should see a tooltip after 750ms");
const theme = document.createElement("span");
theme.style.color = "var(--text-2)";
theme.style.background = "color-mix(in srgb, var(--raised) 94%, transparent)";
document.body.append(theme);
assert(getComputedStyle(tip).color === getComputedStyle(theme).color, "Tooltip text should use the theme's secondary ink");
assert(getComputedStyle(tip).backgroundColor === getComputedStyle(theme).backgroundColor, "Tooltip background should follow the theme, not invert it");
theme.remove();
over($("toggle-sidebar"));
await wait(400);
assert(tip.hidden, "Moving from an open tooltip to another button must wait again");
await wait(350);
assert(!tip.hidden, "The next tooltip should open after its own delay");
over(document.body);
assert(tip.hidden, "Leaving a button must dismiss its tooltip immediately");

// Watch the real fold animation frame by frame, not just its settled endpoints.
const rect = (node) => node.getBoundingClientRect();
const record = $("record-button");
const mark = $("bar-record");
record.click();
const start = performance.now();
let handoffs = 0;
while (performance.now() - start < 550) {
  await new Promise(requestAnimationFrame);
  if (+getComputedStyle(record).opacity > 0.01 && +getComputedStyle(mark).opacity > 0.01) {
    handoffs += 1;
    const a = rect(record);
    const b = rect(mark.firstChild);
    assert(["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) < 0.5), "The large record must reach the small mark before they crossfade");
  }
}
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) assert(handoffs > 0, "The animated fold should exercise the handoff");
mark.click();
await wait(650);
const entry = rect($("expand"));
const disc = rect(record);
assert(Math.abs(entry.right - disc.right) < 0.5 && Math.abs(entry.bottom - disc.bottom) < 0.5, "The expand button belongs at the record square's bottom-right, not on the disc");
assert($("expand").tabIndex === 0, "The expand button should be reachable by keyboard while the record is open");
for (const name of ["record-button", "bar-record", "expand", "pin", "immersive"]) {
  assert($(name).getAttribute("aria-label"), `${name} should keep its accessible name`);
  over($(name));
  await wait(700);
  assert(tip.hidden, `${name} should not show an explanatory tooltip`);
}

$("expand").click();
await wait(650);
assert(getComputedStyle($("immersive")).transform === "none", "The full-window layer must not retain a transform after its entrance");
const pin = $("pin");
const appearance = () => [pin.querySelector("use").getAttribute("href"), getComputedStyle(pin.querySelector("svg")).transform].join("|");
const unpinned = appearance();
let answer;
window.moondogApp.setPinned = () => new Promise((resolve) => { answer = resolve; });
pin.click();
assert(pin.getAttribute("aria-pressed") === "true", "Pin selection should paint before the native reply");
assert(appearance() !== unpinned, "The pin glyph should visibly change, not only its accessible state");
answer(true);
await wait(150);
pin.click();
assert(pin.getAttribute("aria-pressed") === "false", "Unpin should paint immediately too");
answer(false);
await wait(150);
assert(appearance() === unpinned, "Unpin should restore the original glyph");
pin.click();
answer(false);
await wait(150);
assert(pin.getAttribute("aria-pressed") === "false", "A native refusal should restore the actual pin state");
// A press on the pin stays with the pin; a click anywhere else in the record returns to the conversation.
pin.click();
const press = (target, type) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1 }));
press(pin, "pointerdown");
assert(!$("immersive").hidden, "A press on the pin must not leave the record");
press($("immersive-record"), "pointerdown");
press($("immersive-record"), "pointerup");
await wait(50);
answer(true);
await wait(150);
assert(pin.getAttribute("aria-pressed") === "false", "A late pin reply must not select the pin after leaving the record");
assert($("immersive").hidden, "A click on the record should return to the conversation");
assert(document.activeElement === $("input"), "Returning should restore composer focus");

// The record answers its arm and the wheel. Points are placed by the art module's own geometry.
const canvas = $("record");
const unitPoint = ([ux, uy]) => {
  const box = canvas.getBoundingClientRect();
  const grid = Math.max(48, Math.round(Math.floor(canvas.clientWidth) / 8) * 4);
  const radius = (grid - 4) / 2.35;
  const [cx, cy] = [(grid - 1) / 2 - radius * 0.09, (grid - 1) / 2 + radius * 0.045];
  return { x: box.left + (cx + ux * radius + 0.5) / grid * box.width, y: box.top + (cy + uy * radius + 0.5) / grid * box.height };
};
const fire = (type, point, extra = {}) => document.elementFromPoint(point.x, point.y).dispatchEvent(new (type === "wheel" ? WheelEvent : MouseEvent)(type,
  { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, detail: 1, ...extra }));
const playIcon = () => $("toggle").querySelector("use").getAttribute("href");
const wasPlaying = playIcon();
fire("click", unitPoint([0.864, -0.706]));
await wait(100);
assert(playIcon() !== wasPlaying, "A click on the tonearm should play or pause");
assert(!$("record-button").classList.contains("away"), "A click on the tonearm must not fold the record");
await wait(700);
fire("click", unitPoint([1.07, -0.6]));
await wait(100);
assert(playIcon() === wasPlaying, "A click on the arm where it rests should undo the first");
const line = () => parseFloat($("track").style.getPropertyValue("--f"));
const startLine = line();
const top = $("scroll").scrollTop;
// The record takes the wheel from a pointer put on it.
fire("pointermove", unitPoint([0.02, 0.31]));
for (let step = 0; step < 12; step += 1) { fire("wheel", unitPoint([0, 0.3]), { deltaY: 8 }); await new Promise(requestAnimationFrame); }
assert(line() > startLine, "The wheel over the record should move the song forward on the progress line");
assert($("scratch").classList.contains("on"), "A scratch should show its place above the record");
assert($("scroll").scrollTop === top, "A scratch must not scroll the words");
await wait(450);
assert(Math.abs(line() - startLine) > 0.001, "The song should stay where the scratch left it");
// A pointer that moved onto the words, under a record that then takes the wheel, moves the words, not the song.
await wait(300);
const scroll = $("scroll");
const words = rect(scroll);
fire("pointermove", { x: words.left + words.width / 2, y: words.bottom - 80 });
const settledLine = line();
const before = scroll.scrollTop;
for (let step = 0; step < 6; step += 1) { fire("wheel", unitPoint([0, 0.3]), { deltaY: -12 }); await new Promise(requestAnimationFrame); }
await wait(300);
assert(scroll.scrollTop < before - 40, "A wheel on the record from a pointer not put there should scroll the words");
assert(line() === settledLine, "A wheel the record hands on must not move the song");
// At rest, the record's size follows where the view is and nothing else: the same at the same place,
// never a jump between two nearby places, and the room above the words stays put while the view moves.
const shown = () => parseFloat($("record-frame").style.getPropertyValue("--shown") || "1");
const lead = $("lead").offsetHeight;
const sizes = new Map();
const end = scroll.scrollHeight - scroll.clientHeight;
let last = null;
for (const pass of [0, 1]) {
  for (let step = 0; step <= 20; step += 1) {
    const at = Math.round(end - (pass ? 20 - step : step) * 24);
    scroll.scrollTop = at;
    await new Promise(requestAnimationFrame);
    await wait(120);
    if (last !== null) assert(Math.abs(shown() - last) < 0.06, `The record should change gradually with the scroll, not jump (${last} to ${shown()} at ${at})`);
    last = shown();
    if (sizes.has(at)) assert(Math.abs(sizes.get(at) - shown()) < 0.002, `The record should be the same size each time the view rests at ${at}`);
    sizes.set(at, shown());
    assert($("lead").offsetHeight === lead, "The room above the words should not change while the view moves");
  }
}
// Scrolling to the first words shrinks the record to half its size and no smaller.
$("scroll").scrollTop = 0;
await wait(400);
assert(Math.abs(parseFloat($("record-frame").style.getPropertyValue("--shown")) - 0.5) < 0.01, "Scrolled up, the record should rest at half its size");
