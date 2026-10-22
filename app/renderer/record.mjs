// The lunar record the terminal opens with, drawn as dots on a canvas at the window's resolution.
// The geometry comes from the terminal's art module, so both rooms draw one record. It turns
// while music plays and rests when it stops, a frame every eighth of a second, like the terminal.
import { LOGO_MOTION_FRAMES, LOGO_MOTION_INTERVAL_MS, renderLunarRecordDots } from "../../src/surfaces/cli/terminal-art.mjs";

// Distance between dot centers, in CSS pixels, and each layer's ink: grooves, surface, the dog.
const PITCH = 3.2;
const INK = [0, 0.22, 0.5, 0.93];
const TURN = Math.PI * 2;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const dark = matchMedia("(prefers-color-scheme: dark)");

/**
 * Draws the record into `canvas`, sized by its CSS box. Returns { turn(on), stop() };
 * call stop() before dropping the canvas.
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

  // Each frame's dots, one path per layer, worked out once per size and reused on every turn.
  function paths(index) {
    if (!frames[index]) {
      const { dots, width } = renderLunarRecordDots({ columns: grid / 2, rows: grid / 4, phase: index });
      const pitch = size / grid;
      const radius = pitch * 0.32;
      const layers = [null, new Path2D(), new Path2D(), new Path2D()];
      for (let at = 0; at < dots.length; at += 1) {
        if (!dots[at]) continue;
        const x = (at % width + 0.5) * pitch;
        const y = (Math.floor(at / width) + 0.5) * pitch;
        layers[dots[at]].moveTo(x + radius, y);
        layers[dots[at]].arc(x, y, radius, 0, TURN);
      }
      frames[index] = layers;
    }
    return frames[index];
  }

  function draw() {
    if (stopped || !size) return;
    const layers = paths(frame);
    context.clearRect(0, 0, size, size);
    context.fillStyle = ink;
    for (let level = 1; level < layers.length; level += 1) {
      context.globalAlpha = INK[level];
      context.fill(layers[level]);
    }
    context.globalAlpha = 1;
  }

  // Measuring reads layout, so it runs when the canvas settles at a new size, not on every frame.
  // While a window is being resized, the last drawing simply scales with its box.
  function resize() {
    const box = canvas.getBoundingClientRect();
    const next = Math.floor(Math.min(box.width, box.height));
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
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(settle);
      cancelAnimationFrame(raf);
      observer.disconnect();
      dark.removeEventListener("change", theme);
      reduced.removeEventListener("change", run);
      document.removeEventListener("visibilitychange", run);
    },
  };
}
