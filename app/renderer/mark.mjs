// Moondog's mark at the size of an icon: the lunar record, the dog with headphones and the tonearm.
// The dog is the logo's small one (src/surfaces/brand/logo.mjs); the record and the arm are the
// terminal's. It is where the record goes when it folds into the title bar. While music plays the
// arm rests on the record and its highlights turn with it; when the music stops the arm lifts and
// the record rests.
import { logoFigure } from "../../src/surfaces/brand/logo.mjs";
import { LOGO_MOTION_FRAMES, LOGO_MOTION_INTERVAL_MS, lunarRecordShapes } from "../../src/surfaces/cli/terminal-art.mjs";

const SVG = "http://www.w3.org/2000/svg";
const shape = (name, attributes) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};
const points = (list) => list.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(" ");
const path = (list) => `M${list.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join("L")}`;
// At icon size the terminal's highlights would be a pixel long; they keep their grooves and angles, longer.
const REACH = 4;

let marks = 0;

export function createMark() {
  const { arm, cartridge, grooves, highlights } = lunarRecordShapes();
  const { head, band, bandGap, gap, cup } = logoFigure();
  const [cx, cy] = cup.center;
  const mark = shape("svg", { viewBox: "-1.06 -1.16 2.32 2.32", class: "mark", "aria-hidden": "true" });
  mark.style.setProperty("--turn", `${LOGO_MOTION_FRAMES * LOGO_MOTION_INTERVAL_MS}ms`);
  // The window's light shows through the mark, so the parts the logo leaves blank are cut out
  // rather than painted over: a margin around the dog from the grooves, and the logo's gaps and
  // earcup ring from the dog.
  const id = `mark-${(marks += 1)}`;
  const box = { x: -1.06, y: -1.16, width: 2.32, height: 2.32 };
  const cut = (name, ...holes) => {
    const mask = shape("mask", { id: `${id}-${name}`, maskUnits: "userSpaceOnUse", ...box });
    mask.append(shape("rect", { ...box, fill: "#fff" }), ...holes);
    return mask;
  };
  const defs = shape("defs", {});
  const margin = { fill: "#000", stroke: "#000", "stroke-width": 0.18, "stroke-linejoin": "round" };
  const line = (width) => ({ fill: "none", stroke: "#000", "stroke-width": width });
  defs.append(
    cut("record", shape("polygon", { points: points(head), ...margin }), shape("polygon", { points: points(band), ...margin }),
      shape("circle", { cx, cy, r: cup.radius, ...margin })),
    cut("dog", shape("circle", { cx, cy, r: cup.radius + gap / 2, ...line(gap) }), shape("polyline", { points: points(bandGap), ...line(gap) }),
      shape("circle", { cx, cy, r: cup.ring, ...line(cup.ringWidth) }), shape("circle", { cx, cy, r: cup.dot, fill: "#000" })),
  );
  const record = shape("g", { class: "mark-record", mask: `url(#${id}-record)` });
  // The rim and the outer groove take the cover's first colour, the inner grooves its second and third.
  grooves.forEach((radius, index) => record.append(shape("circle", { r: radius, class: index ? "groove" : "rim",
    style: `stroke: var(--groove-${Math.max(1, index)}, currentColor)` })));
  // An unpainted rim gives the turning group the record's own box, so it turns about the record's center.
  const turning = shape("g", { class: "mark-turn" });
  turning.append(shape("circle", { r: 1, fill: "none" }));
  for (const [index, offset, length] of highlights) {
    const radius = grooves[index];
    const from = offset - length * REACH;
    const at = (angle) => `${(Math.cos(angle) * radius).toFixed(3)} ${(Math.sin(angle) * radius).toFixed(3)}`;
    turning.append(shape("path", { d: `M${at(from)}A${radius} ${radius} 0 0 1 ${at(offset)}`, class: "shine" }));
  }
  record.append(turning);
  const figure = shape("g", { class: "mark-dog", mask: `url(#${id}-dog)` });
  figure.append(shape("polygon", { points: points(head), class: "ink" }), shape("polygon", { points: points(band), class: "ink" }),
    shape("circle", { cx, cy, r: cup.radius, class: "ink" }));
  const tonearm = shape("g", { class: "mark-arm" });
  tonearm.append(shape("path", { d: path(arm), class: "arm" }), shape("polygon", { points: points(cartridge), class: "ink" }));
  mark.append(defs, record, figure, tonearm);
  return {
    node: mark,
    playing(on) { mark.classList.toggle("playing", Boolean(on)); },
  };
}
