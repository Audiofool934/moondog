// Moondog's mark at the size of an icon: the logo's small version (src/surfaces/brand/logo.mjs), the
// dog with headphones on the rim and two heavy grooves, and the heavy tonearm. It is where the record
// goes when it folds into the title bar, in the record's own box, so the two hand over in place. While
// music plays the arm rests on the record and two glints travel its grooves; when the music stops the
// arm lifts and the glints go, and the record rests as the logo.
import { logoFigure } from "../../src/surfaces/brand/logo.mjs";
import { LOGO_MOTION_FRAMES, LOGO_MOTION_INTERVAL_MS } from "../../src/surfaces/cli/terminal-art.mjs";

const SVG = "http://www.w3.org/2000/svg";
const shape = (name, attributes) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};
const points = (list) => list.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(" ");
// The glints: the groove each rides, where it starts, and how long it is, in radians.
const GLINTS = [[1, -0.91, 0.24], [2, 2.44, 0.2]];

let marks = 0;

export function createMark() {
  const { head, band, bandGap, gap, cup, grooves, halo, tonearm } = logoFigure();
  const [cx, cy] = cup.center;
  const mark = shape("svg", { viewBox: "-1.06 -1.16 2.32 2.32", class: "mark", "aria-hidden": "true" });
  mark.style.setProperty("--turn", `${LOGO_MOTION_FRAMES * LOGO_MOTION_INTERVAL_MS}ms`);
  // The window's light shows through the mark, so the parts the logo leaves blank are cut out
  // rather than painted over: a margin around the dog and the glints from the grooves, and the
  // logo's gaps and earcup ring from the dog.
  const id = `mark-${(marks += 1)}`;
  const box = { x: -1.06, y: -1.16, width: 2.32, height: 2.32 };
  const cut = (name, ...holes) => {
    const mask = shape("mask", { id: `${id}-${name}`, maskUnits: "userSpaceOnUse", ...box });
    mask.append(shape("rect", { ...box, fill: "#fff" }), ...holes);
    return mask;
  };
  const margin = { fill: "#000", stroke: "#000", "stroke-width": halo * 2, "stroke-linejoin": "round" };
  const line = (width) => ({ fill: "none", stroke: "#000", "stroke-width": width });
  // An unpainted rim gives the turning group the record's own box, so it turns about the record's center.
  const turning = shape("g", { class: "mark-turn" });
  turning.append(shape("circle", { r: 1, fill: "none" }));
  for (const [index, from, length] of GLINTS) {
    const [radius, width] = grooves[index];
    const at = (angle) => `${(Math.cos(angle) * radius).toFixed(3)} ${(Math.sin(angle) * radius).toFixed(3)}`;
    turning.append(shape("path", { d: `M${at(from)}A${radius} ${radius} 0 0 1 ${at(from + length)}`, ...line(width * 1.6) }));
  }
  const defs = shape("defs", {});
  defs.append(
    cut("record", shape("polygon", { points: points(head), ...margin }), shape("polygon", { points: points(band), ...margin }),
      shape("circle", { cx, cy, r: cup.radius, ...margin }), turning),
    cut("dog", shape("circle", { cx, cy, r: cup.radius + gap / 2, ...line(gap) }), shape("polyline", { points: points(bandGap), ...line(gap) }),
      shape("circle", { cx, cy, r: cup.ring, ...line(cup.ringWidth) }), shape("circle", { cx, cy, r: cup.dot, fill: "#000" })),
  );
  const record = shape("g", { class: "mark-record", mask: `url(#${id}-record)` });
  // The rim takes the cover's first colour, the grooves its second and third.
  grooves.forEach(([radius, width], index) => record.append(shape("circle", { r: radius, "stroke-width": width, class: index ? "groove" : "rim",
    style: `stroke: var(--groove-${index + 1}, currentColor)` })));
  const figure = shape("g", { class: "mark-dog", mask: `url(#${id}-dog)` });
  figure.append(shape("polygon", { points: points(head), class: "ink" }), shape("polygon", { points: points(band), class: "ink" }),
    shape("circle", { cx, cy, r: cup.radius, class: "ink" }));
  const arm = shape("g", { class: "mark-arm" });
  arm.append(...tonearm.map((corners) => shape("polygon", { points: points(corners), class: "ink" })));
  mark.append(defs, record, figure, arm);
  return {
    node: mark,
    playing(on) { mark.classList.toggle("playing", Boolean(on)); },
  };
}

// The working mark, in place of the word "Loading": not the logo but one of its parts, the glints
// that travel the mark's grooves while music plays, here scratched back and forth about the spindle
// and stretched by the speed of each stroke. Every working mark is in step with the others: its
// `offset` into the scratch is the moment it starts, unless the caller fixes one, and two marks with
// one offset are the same markup, so a redraw that compares markup keeps the one already moving.
export const SCRATCH_MS = 1600;
// The two grooves, each with the angle its path starts from, in degrees: half a turn before its glint.
const SCRATCH_GROOVES = [[0.84, 118], [0.5, -62]];
export function scratchMark(offset = Math.round(performance.now() % SCRATCH_MS)) {
  const mark = shape("svg", { viewBox: "-1 -1 2 2", class: "mark scratching", "aria-hidden": "true", style: `--scratch: ${SCRATCH_MS}ms; --offset: -${offset}ms` });
  for (const [radius] of SCRATCH_GROOVES) mark.append(shape("circle", { r: radius, class: "groove" }));
  mark.append(shape("circle", { r: 0.13, class: "ink" }));
  // A path one unit long lets the scratch move and stretch both glints in turns of the record.
  for (const [radius, angle] of SCRATCH_GROOVES) mark.append(shape("circle", { r: radius, pathLength: 1, transform: `rotate(${angle})`, class: "glint" }));
  return mark;
}
