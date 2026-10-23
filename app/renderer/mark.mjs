// Moondog's mark at the size of an icon: the lunar record, the dog with headphones and the tonearm,
// drawn as vectors from the terminal's own shapes. It is where the record goes when it folds into
// the title bar. While music plays the arm rests on the record and its highlights turn with it;
// when the music stops the arm lifts and the record rests.
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
  const { dog, eye, headband, ear, earRadius, arm, cartridge, grooves, highlights } = lunarRecordShapes();
  const mark = shape("svg", { viewBox: "-1.06 -1.16 2.32 2.32", class: "mark", "aria-hidden": "true" });
  mark.style.setProperty("--turn", `${LOGO_MOTION_FRAMES * LOGO_MOTION_INTERVAL_MS}ms`);
  // The window's light shows through the mark, so the parts the logo leaves blank are cut out
  // rather than painted over: a margin around the dog from the grooves, and the eye and the ear
  // cup from the dog.
  const id = `mark-${(marks += 1)}`;
  const box = { x: -1.06, y: -1.16, width: 2.32, height: 2.32 };
  const cut = (name, ...holes) => {
    const mask = shape("mask", { id: `${id}-${name}`, maskUnits: "userSpaceOnUse", ...box });
    mask.append(shape("rect", { ...box, fill: "#fff" }), ...holes);
    return mask;
  };
  const defs = shape("defs", {});
  defs.append(
    cut("record", shape("polygon", { points: points(dog), fill: "#000", stroke: "#000", "stroke-width": 0.18, "stroke-linejoin": "round" })),
    cut("dog", shape("circle", { cx: ear[0], cy: ear[1], r: earRadius, fill: "#000" }), shape("circle", { cx: eye[0], cy: eye[1], r: 0.035, fill: "#000" })),
  );
  const record = shape("g", { class: "mark-record", mask: `url(#${id}-record)` });
  grooves.forEach((radius, index) => record.append(shape("circle", { r: radius, class: index ? "groove" : "rim" })));
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
  const body = shape("g", { mask: `url(#${id}-dog)` });
  body.append(shape("polygon", { points: points(dog), class: "ink" }), shape("path", { d: path(headband), class: "band" }));
  const figure = shape("g", { class: "mark-dog" });
  figure.append(body, shape("circle", { cx: ear[0], cy: ear[1], r: earRadius, class: "cup" }));
  const tonearm = shape("g", { class: "mark-arm" });
  tonearm.append(shape("path", { d: path(arm), class: "arm" }), shape("polygon", { points: points(cartridge), class: "ink" }));
  mark.append(defs, record, figure, tonearm);
  return {
    node: mark,
    playing(on) { mark.classList.toggle("playing", Boolean(on)); },
  };
}
