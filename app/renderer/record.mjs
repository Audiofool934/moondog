// The lunar record the terminal opens with, drawn as dots on a canvas at the window's resolution.
// The geometry comes from the terminal's art module, so both rooms draw one record. It turns
// while music plays and rests when it stops, a frame every eighth of a second, like the terminal.
// Its grooves take the colours of the cover that is playing; the dog and the arm stay in ink.
import { LOGO_MOTION_FRAMES, LOGO_MOTION_INTERVAL_MS, renderLunarRecordDots } from "../../src/surfaces/cli/terminal-art.mjs";

// Distance between dot centers, in CSS pixels, and each layer's ink: grooves, surface, the dog. At
// this pitch the record above the words reaches the terminal art's finest detail, ten grooves.
const PITCH = 2;
const INK = [0, 0.22, 0.5, 0.93];
// Grooves in a cover's colours stand a little stronger than grooves in ink, so the colour reads.
const TINTED = 0.6;
// A new cover's colours drift into the grooves as the window's light drifts into its own.
const DRIFT_MS = 2400;
const TURN = Math.PI * 2;
const rgbOf = (colour) => (colour.match(/[\d.]+/gu) ?? [0, 0, 0]).slice(0, 3).map(Number);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const dark = matchMedia("(prefers-color-scheme: dark)");

/**
 * Draws the record into `canvas`, sized by its CSS box. Returns { turn(on), tint(colours, instant), stop() };
 * tint takes three [r, g, b] colours, from the rim inward, or null for ink. Call stop() before dropping the canvas.
 */
export function mountRecord(canvas) {
  const context = canvas.getContext("2d");
  let size = 0;
  let grid = 0;
  let frames = [];
  let frame = 0;
  let ink = "";
  let turning = false;
  let raf = 0;
  let timer = 0;
  let stopped = false;
  // The grooves' center and outer radius in CSS pixels, and the colours drifting from one cover's to the next.
  let disc = null;
  let rings = { from: null, to: null, start: 0 };
  let drifting = 0;

  // Each frame's dots, one path per layer, worked out once per size and reused on every turn.
  function paths(index) {
    if (!frames[index]) {
      const { dots, width } = renderLunarRecordDots({ columns: grid / 2, rows: grid / 4, phase: index });
      const pitch = size / grid;
      const radius = pitch * 0.32;
      const layers = [null, new Path2D(), new Path2D(), new Path2D()];
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (let at = 0; at < dots.length; at += 1) {
        if (!dots[at]) continue;
        const x = (at % width + 0.5) * pitch;
        const y = (Math.floor(at / width) + 0.5) * pitch;
        layers[dots[at]].moveTo(x + radius, y);
        layers[dots[at]].arc(x, y, radius, 0, TURN);
        if (dots[at] === 1) { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); }
      }
      frames[index] = layers;
      // The grooves never turn, so the outermost one gives the disc's place.
      disc ??= { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2, radius: (box[2] - box[0]) / 2 };
    }
    return frames[index];
  }

  // The grooves' paint: ink, a cover's three colours from the rim inward, or on the way between them.
  const inked = () => ({ colours: Array(3).fill(rgbOf(ink)), alpha: INK[1] });
  function blend(now) {
    const from = rings.from ?? inked();
    const to = rings.to ? { colours: rings.to, alpha: TINTED } : inked();
    const k = reduced.matches ? 1 : Math.min(1, (now - rings.start) / DRIFT_MS);
    const eased = k * k * (3 - 2 * k);
    const colours = to.colours.map((colour, index) => colour.map((value, channel) => Math.round(from.colours[index][channel] + (value - from.colours[index][channel]) * eased)));
    return { colours, alpha: from.alpha + (to.alpha - from.alpha) * eased, k };
  }
  function grooves(now) {
    if (!rings.from && !rings.to) return { style: ink, alpha: INK[1], done: true };
    const { colours, alpha, k } = blend(now);
    const style = context.createRadialGradient(disc.x, disc.y, disc.radius * 0.45, disc.x, disc.y, disc.radius);
    [[0, 2], [0.55, 1], [1, 0]].forEach(([stop, index]) => style.addColorStop(stop, `rgb(${colours[index].join(" ")})`));
    return { style, alpha, done: k >= 1 };
  }

  function draw() {
    if (stopped || !size) return;
    const layers = paths(frame);
    context.clearRect(0, 0, size, size);
    const paint = grooves(performance.now());
    context.fillStyle = paint.style;
    context.globalAlpha = paint.alpha;
    context.fill(layers[1]);
    context.fillStyle = ink;
    for (let level = 2; level < layers.length; level += 1) {
      context.globalAlpha = INK[level];
      context.fill(layers[level]);
    }
    context.globalAlpha = 1;
    // While colours drift, the record redraws on every display frame until they arrive.
    if (!paint.done && !drifting) drifting = requestAnimationFrame(() => { drifting = 0; draw(); });
  }

  // Measuring reads layout, so it runs when the canvas settles at a new size, not on every frame.
  // While a window is being resized, the last drawing simply scales with its box. The box is the
  // canvas's own size before any transform, so a record that folds by scaling keeps its drawing.
  function resize() {
    const next = Math.floor(Math.min(canvas.clientWidth, canvas.clientHeight));
    if (!next) return;
    const scale = devicePixelRatio || 1;
    if (next !== size || canvas.width !== Math.round(next * scale)) {
      canvas.width = Math.round(next * scale);
      canvas.height = Math.round(next * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      size = next;
      // A square grid of dots, four rows to a terminal row, so the record stays round.
      grid = Math.max(48, Math.round(next / PITCH / 4) * 4);
      frames = [];
      disc = null;
    }
    ink = getComputedStyle(canvas).color;
    draw();
  }
  let settle = 0;
  const resized = () => { clearTimeout(settle); settle = setTimeout(resize, size ? 140 : 0); };

  // Eight frames a second, timed by the clock and painted on the next display frame.
  function tick() {
    timer = 0;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (stopped || !turning) return;
      frame = (frame + 1) % LOGO_MOTION_FRAMES;
      draw();
      run();
    });
  }
  function run() {
    const should = turning && !reduced.matches && !document.hidden && !stopped;
    if (should && !timer && !raf) timer = setTimeout(tick, LOGO_MOTION_INTERVAL_MS);
    if (!should) { clearTimeout(timer); cancelAnimationFrame(raf); timer = 0; raf = 0; }
  }

  const observer = new ResizeObserver(resized);
  observer.observe(canvas);
  const theme = () => { ink = getComputedStyle(canvas).color; draw(); };
  dark.addEventListener("change", theme);
  reduced.addEventListener("change", run);
  document.addEventListener("visibilitychange", run);
  resize();

  return {
    turn(on) { turning = Boolean(on); run(); },
    tint(colours, instant = false) {
      const next = colours?.length ? colours.slice(0, 3) : null;
      if (JSON.stringify(next) === JSON.stringify(rings.to)) return;
      // A drift starts from wherever the grooves are now, even mid-way through the last one.
      const now = performance.now();
      const from = !instant && (rings.from || rings.to) ? blend(now) : null;
      rings = { from, to: next, start: instant ? -Infinity : now };
      draw();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(settle);
      cancelAnimationFrame(raf);
      cancelAnimationFrame(drifting);
      observer.disconnect();
      dark.removeEventListener("change", theme);
      reduced.removeEventListener("change", run);
      document.removeEventListener("visibilitychange", run);
    },
  };
}
