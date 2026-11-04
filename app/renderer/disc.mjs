// The window's record buttons: the solid buttons that start music or a reply, drawn as the record above the
// conversation is drawn, in dots. A ring of grooves in dots at the record's own pitch runs round a solid label, and
// the glyph sits whole on the label, as the dog does on the record. A pointer near the button lights the dots
// closest to it, as a pointer near the tonearm lights the arm. While what the button started is going (music from
// this playlist, a reply being written), two glints travel the grooves, as they do on the logo while music plays.
const SVG = "http://www.w3.org/2000/svg";
const shape = (name, attributes, parent) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
};
// The record's dot pitch (record.mjs PITCH) and dot size; the rim's groove stands strongest, as on the record.
const PITCH = 2;
const DOT = 0.62;
const RIM = 0.93;
const GROOVE = 0.42;
// The pointer's light: how far it reaches, as a share of the button, how much it adds at its center, and
// how much every groove gains while the pointer is on the button at all.
const REACH = 0.62;
const LIGHT = 0.5;
const HOVER = 0.12;
// The two glints, as the logo's: where each starts round the groove, and how wide it is, in radians.
const GLINTS = [[-0.91, 0.5], [2.44, 0.42]];

/**
 * Makes button a record button of size px, with the glyph (an icon symbol's name) on its label. Returns
 * { setTurning(on) }: turning shows the glints and sends them round the grooves.
 */
export function discButton(button, { size, glyph, label = 0.32, fill = false }) {
  const center = size / 2;
  const labelRadius = size * label;
  const svg = shape("svg", { class: "disc-art", viewBox: `0 0 ${size} ${size}`, width: size, height: size, "aria-hidden": "true" });
  const grooves = shape("g", { class: "disc-grooves" }, svg);
  const glints = shape("g", { class: "disc-glints" }, svg);
  const dots = [];
  for (let ring = labelRadius + 2.4; ring < center - 0.6; ring += PITCH) {
    const count = Math.round((2 * Math.PI * ring) / PITCH);
    const strength = ring > center - 2.6 ? RIM : GROOVE;
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2;
      const x = center + Math.cos(angle) * ring;
      const y = center + Math.sin(angle) * ring;
      dots.push({ node: shape("circle", { cx: x.toFixed(2), cy: y.toFixed(2), r: DOT, "fill-opacity": strength }, grooves), x, y, strength });
      // The glints are the same dots lit along two arcs; they turn with their group.
      const lit = Math.max(0, ...GLINTS.map(([at, width]) => 1 - Math.abs(Math.atan2(Math.sin(angle - at), Math.cos(angle - at))) / width));
      if (lit > 0) shape("circle", { cx: x.toFixed(2), cy: y.toFixed(2), r: DOT * 1.15, "fill-opacity": (lit * (1 - strength) + 0.05).toFixed(2) }, glints);
    }
  }
  shape("circle", { class: "disc-label", cx: center, cy: center, r: labelRadius }, svg);
  // The glyph keeps the icon's own drawing, sized to the label; setIcon still swaps it by its one <use>.
  const glyphSize = labelRadius * 1.2;
  const holder = shape("svg", { class: `icon disc-glyph${fill ? " fill" : ""}`, x: center - glyphSize / 2, y: center - glyphSize / 2, width: glyphSize, height: glyphSize }, svg);
  shape("use", { href: `#i-${glyph}` }, holder);
  button.replaceChildren(svg);
  button.classList.add("disc");

  // The pointer's light, eased toward where it is; it fades when the pointer leaves.
  let frame = 0;
  let pointer = null;
  const paint = () => {
    frame = 0;
    for (const dot of dots) {
      const near = pointer ? Math.max(0, 1 - Math.hypot(dot.x - pointer.x, dot.y - pointer.y) / (REACH * size)) : 0;
      dot.node.setAttribute("fill-opacity", Math.min(1, dot.strength + (pointer ? HOVER : 0) + near * near * LIGHT).toFixed(3));
      dot.node.setAttribute("r", (DOT * (1 + near * 0.35)).toFixed(3));
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  button.addEventListener("pointermove", (event) => {
    if (button.disabled) return;
    const box = svg.getBoundingClientRect();
    pointer = { x: ((event.clientX - box.left) / box.width) * size, y: ((event.clientY - box.top) / box.height) * size };
    schedule();
  });
  button.addEventListener("pointerleave", () => { pointer = null; schedule(); });

  return {
    setTurning(on) { button.classList.toggle("turning", Boolean(on)); },
  };
}
