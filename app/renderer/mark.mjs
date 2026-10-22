// Moondog's mark at the size of an icon: the lunar record, the dog with headphones and the tonearm,
// drawn as vectors from the terminal's own shapes. The arm rests on the record while music plays
// and lifts off it when the music stops.
import { lunarRecordShapes } from "../../src/surfaces/cli/terminal-art.mjs";

const SVG = "http://www.w3.org/2000/svg";
const shape = (name, attributes) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};
const points = (list) => list.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(" ");
const path = (list) => `M${list.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join("L")}`;

export function createMark() {
  const { dog, eye, headband, ear, earRadius, arm, cartridge, grooves } = lunarRecordShapes();
  const mark = shape("svg", { viewBox: "-1.06 -1.16 2.32 2.32", class: "mark", "aria-hidden": "true" });
  const record = shape("g", { class: "mark-record" });
  grooves.forEach((radius, index) => record.append(shape("circle", { r: radius, class: index ? "groove" : "rim" })));
  // A halo the colour of the panel parts the dog from the grooves, as in the logo.
  const figure = shape("g", { class: "mark-dog" });
  figure.append(
    shape("polygon", { points: points(dog), class: "halo" }),
    shape("polygon", { points: points(dog), class: "ink" }),
    shape("path", { d: path(headband), class: "band" }),
    shape("circle", { cx: ear[0], cy: ear[1], r: earRadius, class: "cup" }),
    shape("circle", { cx: eye[0], cy: eye[1], r: 0.035, class: "eye" }),
  );
  const tonearm = shape("g", { class: "mark-arm" });
  tonearm.append(shape("path", { d: path(arm), class: "arm" }), shape("polygon", { points: points(cartridge), class: "ink" }));
  mark.append(record, figure, tonearm);
  return {
    node: mark,
    playing(on) { mark.classList.toggle("playing", Boolean(on)); },
  };
}
