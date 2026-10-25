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
