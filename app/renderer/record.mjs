// The lunar record the terminal opens with, drawn as dots on a canvas at the window's resolution.
// The geometry comes from the terminal's art module, so both rooms draw one record. It turns
// while music plays and rests when it stops, a frame every eighth of a second, like the terminal,
// coming up to speed and running down like a platter. Its tonearm rests on it while music plays and
// swings off it when the music stops. Its grooves take the colours of the cover that is playing;
// the dog and the arm stay in ink.
import { LOGO_MOTION_FRAMES, LOGO_MOTION_INTERVAL_MS, lunarRecordShapes, renderLunarRecordDots, renderTonearmDots } from "../../src/surfaces/cli/terminal-art.mjs";

// Distance between dot centers, in CSS pixels, and each layer's ink: grooves, surface, the dog. At
// this pitch the record above the words reaches the terminal art's finest detail, ten grooves.
const PITCH = 2;
const INK = [0, 0.22, 0.5, 0.93];
// Grooves in a cover's colours stand a little stronger than grooves in ink, so the colour reads.
const TINTED = 0.6;
// A new cover's colours drift into the grooves as the window's light drifts into its own.
const DRIFT_MS = 2400;
const TURN = Math.PI * 2;
// Off the record the arm stands swung out as far as the bar's mark swings its own.
const LIFTED = -28 / 180 * Math.PI;
const SWING_MS = 560;
// A click takes the arm anywhere in a round target about the whole arm: within REACH of its middle, in
// the record's radius.
const REACH = 0.46;
// A pointer near the arm lights it in its own dots, and never moves it. Within NEAR_PX of where a click
// takes the arm, the light grows as the pointer comes closer: the arm's dots fill out a little, by BASE,
// and swell most around the pointer, by SPOT, across SPREAD of the record's radius, so the light follows
// the pointer along the arm. It eases in and out over about EASE_MS.
const NEAR_PX = 36;
const BASE = 0.12;
const SPOT = 0.55;
const SPREAD = 0.1;
const EASE_MS = 90;
// The platter starts at half speed and gains on each frame; stopping, it loses on each frame and
// rests below a quarter of its speed, a second or so later.
const SPIN_UP = 1.45;
const SPIN_DOWN = 0.72;
const SLOWEST = 0.25;
// A hand on the record holds it still for this long after it last moved it.
const HELD_MS = 220;
// The arm's middle, halfway from its pivot to its stylus, in the record's unit coordinates, and half its length.
const { arm: [PIVOT] } = lunarRecordShapes();
const STYLUS = [0.755, -0.587];
const MIDDLE = [(PIVOT[0] + STYLUS[0]) / 2, (PIVOT[1] + STYLUS[1]) / 2];
const HALF = Math.hypot(PIVOT[0] - STYLUS[0], PIVOT[1] - STYLUS[1]) / 2;
const swung = ([x, y], swing) => {
  const [px, py] = PIVOT;
  const [cosine, sine] = [Math.cos(swing), Math.sin(swing)];
  return [px + (x - px) * cosine - (y - py) * sine, py + (x - px) * sine + (y - py) * cosine];
};
const rgbOf = (colour) => (colour.match(/[\d.]+/gu) ?? [0, 0, 0]).slice(0, 3).map(Number);
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const dark = matchMedia("(prefers-color-scheme: dark)");

/**
 * Draws the record into `canvas`, sized by its CSS box. Returns its controls: turn(on) runs the
 * platter; needle(on, instant) rests the arm on the record or swings it off; near(x, y) lights the arm
 * for a pointer at that point in the window, and near(null) for none; spin(distance) turns the record by hand, `distance` pixels along its rim;
 * shown(scale) says the box is drawn at `scale` by a transform; hit(x, y) names what is under a
 * point in the window ("arm", "disc" or null); place() gives the disc's center and radius in the
 * window; tint(colours, instant) takes three [r, g, b] colours, from the rim inward, or null for ink.
 * Call stop() before dropping the canvas.
 * `across` fixes the number of dots across, so a record drawn large keeps the mosaic of the one above the words.
 */
export function mountRecord(canvas, { across = null } = {}) {
  const context = canvas.getContext("2d");
  let size = 0;
  let grid = 0;
  let frames = [];
  let traced = { density: 0, layers: [] };
  let arms = new Map();
  // The record's turn in frames; the frame drawn is its whole part.
  let phase = 0;
  let ink = "";
  let turning = false;
  let speed = 0;
  let heldUntil = 0;
  let raf = 0;
  let timer = 0;
  let painting = 0;
  let warming = 0;
  let stopped = false;
  // The scale a transform draws the box at; the canvas paints its dots at that size, so the screen
  // never resamples a field of dots, which beats against the pixels as moiré.
  let scale = 1;
  // The grooves' center and outer radius in CSS pixels, the record's unit coordinates on the grid
  // in dots, and the colours drifting from one cover's to the next.
  let disc = null;
  let axes = null;
  let rings = { from: null, to: null, start: 0 };
  let drifting = 0;
  // The arm: on the record or off it, and its swing as drawn, eased toward where it goes; and the pointer
  // near it, in the window, with where it falls on the record and how strongly the arm answers it.
  let down = true;
  let pointer = null;
  let near = { p: 0, at: 0, x: 0, y: 0 };
  let swing = 0;
  let swingTo = null;
  let swinging = 0;
  const frameAt = () => ((Math.floor(phase) % LOGO_MOTION_FRAMES) + LOGO_MOTION_FRAMES) % LOGO_MOTION_FRAMES;

  // Dots as paths, one per layer, in CSS pixels of the box. Each dot's center sits on the middle of a
  // bitmap pixel, `density` of them to a CSS pixel, so every dot is drawn alike: dots that fall between
  // pixels come out fainter or bolder than their neighbours, and rows of them beat as moiré. Closer
  // than two pixels apart, dots would share pixels, so there they keep their places and blend instead.
  // grow, if given, scales each dot's radius by its column and row.
  function trace({ dots, width }, layers, density, grow = null) {
    const pitch = size / grid;
    const radius = pitch * 0.32;
    const snap = pitch * density >= 1.9 ? (at) => (Math.round(at * density - 0.5) + 0.5) / density : (at) => at;
    for (let at = 0; at < dots.length; at += 1) {
      if (!dots[at]) continue;
      const x = snap((at % width + 0.5) * pitch);
      const y = snap((Math.floor(at / width) + 0.5) * pitch);
      const r = grow ? radius * grow(at % width, Math.floor(at / width)) : radius;
      layers[dots[at]].moveTo(x + r, y);
      layers[dots[at]].arc(x, y, r, 0, TURN);
    }
    return layers;
  }
  // Each frame's dots, worked out once per size and reused on every turn. The arm is drawn apart, so it can swing.
  function dotsAt(index) {
    if (!frames[index]) {
      const art = renderLunarRecordDots({ columns: grid / 2, rows: grid / 4, phase: index, tonearm: false });
      frames[index] = art;
      if (!disc) {
        // The grooves never turn, so the outermost one gives the disc's place.
        const pitch = size / grid;
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        art.dots.forEach((layer, at) => {
          if (layer !== 1) return;
          const x = (at % art.width + 0.5) * pitch;
          const y = (Math.floor(at / art.width) + 0.5) * pitch;
          box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
        });
        disc = { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2, radius: (box[2] - box[0]) / 2 };
        axes = { x: art.centerX, y: art.centerY, radius: art.radius };
      }
    }
    return frames[index];
  }
  // A frame's paths at the bitmap's density, kept while the density holds, as it does while the record turns.
  function paths(index, density) {
    if (density !== traced.density) traced = { density, layers: [] };
    traced.layers[index] ??= trace(dotsAt(index), [null, new Path2D(), new Path2D(), new Path2D()], density);
    return traced.layers[index];
  }
  // The arm at its swing; resting on the record, its contact moves with the frame. Lit, each dot swells
  // by how near the pointer is to the arm, and most near the pointer itself.
  function armPath(index, density) {
    const key = swing === 0 ? `on ${index}` : `${Math.round(swing * 2000)}`;
    let art = arms.get(key);
    if (!art) {
      if (arms.size > 200) arms.clear();
      art = renderTonearmDots({ columns: grid / 2, rows: grid / 4, phase: index, swing });
      arms.set(key, art);
    }
    const grow = near.p && axes ? (column, row) => 1 + near.p * (BASE + SPOT * Math.exp(
      -(((column - axes.x) / axes.radius - near.x) ** 2 + ((row - axes.y) / axes.radius - near.y) ** 2) / SPREAD ** 2)) : null;
    return trace(art, [null, null, null, new Path2D()], density, grow)[3];
  }
  // Where a point in the window falls in the record's unit coordinates, how far it is from the arm's
  // middle there, how far from it a click still takes the arm, and how many pixels make one unit.
  function measure(x, y) {
    if (!axes || !size) return null;
    const box = canvas.getBoundingClientRect();
    if (!box.width) return null;
    const unit = box.width / grid * axes.radius;
    const nx = ((x - box.left) / box.width * grid - 0.5 - axes.x) / axes.radius;
    const ny = ((y - box.top) / box.height * grid - 0.5 - axes.y) / axes.radius;
    const [mx, my] = swung(MIDDLE, swing);
    // Never less than ten pixels beyond the arm's ends, however small the record.
    return { nx, ny, gap: Math.hypot(nx - mx, ny - my), reach: Math.max(REACH, HALF + 10 / unit), unit };
  }
  // How strongly the arm answers the pointer, eased toward how near the pointer is now: 1 where a click
  // takes the arm, falling to 0 at NEAR_PX beyond. A swing moves the arm toward or away from a still
  // pointer too. Returns whether it is still on its way.
  function nearness(now) {
    const at = pointer && measure(pointer.x, pointer.y);
    const target = at ? Math.min(1, Math.max(0, 1 - (at.gap - at.reach) * at.unit / NEAR_PX)) : 0;
    if (at) { near.x = at.nx; near.y = at.ny; }
    const dt = Math.min(32, now - near.at);
    near.at = now;
    near.p = reduced.matches ? target : target + (near.p - target) * Math.exp(-dt / EASE_MS);
    if (Math.abs(near.p - target) < 0.01) near.p = target;
    return near.p !== target;
  }
  // The frames a hand might turn to are worked out while the window is idle, nearest first.
  function warm() {
    cancelIdleCallback(warming);
    warming = requestIdleCallback(() => {
      warming = 0;
      if (stopped || !size) return;
      const start = frameAt();
      const missing = Array.from({ length: LOGO_MOTION_FRAMES }, (_, step) => (start + (step % 2 ? -1 : 1) * Math.ceil(step / 2) + LOGO_MOTION_FRAMES) % LOGO_MOTION_FRAMES)
        .find((index) => !frames[index]);
      if (missing === undefined) return;
      dotsAt(missing);
      warm();
    });
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
    const index = frameAt();
    // The bitmap holds as many pixels as the screen shows of the box.
    const pixels = Math.max(1, Math.round(size * scale * (devicePixelRatio || 1)));
    if (canvas.width !== pixels) { canvas.width = pixels; canvas.height = pixels; }
    const density = pixels / size;
    const layers = paths(index, density);
    const easing = nearness(performance.now());
    context.setTransform(density, 0, 0, density, 0, 0);
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
    context.globalAlpha = INK[3];
    context.fill(armPath(index, density));
    context.globalAlpha = 1;
    if (easing) paintSoon();
    // While colours drift, the record redraws on every display frame until they arrive.
    if (!paint.done && !drifting) drifting = requestAnimationFrame(() => { drifting = 0; draw(); });
  }
  const paintSoon = () => { if (!painting) painting = requestAnimationFrame(() => { painting = 0; draw(); }); };

  // Measuring reads layout, so it runs when the canvas settles at a new size, not on every frame.
  // While a window is being resized, the last drawing simply scales with its box. The box is the
  // canvas's own size before any transform, so a record that folds by scaling keeps its drawing.
  function resize() {
    const next = Math.floor(Math.min(canvas.clientWidth, canvas.clientHeight));
    if (!next) return;
    if (next !== size) {
      size = next;
      // A square grid of dots, four rows to a terminal row, so the record stays round.
      grid = across ?? Math.max(48, Math.round(next / PITCH / 4) * 4);
      frames = [];
      traced = { density: 0, layers: [] };
      arms = new Map();
      disc = null;
      warm();
    }
    ink = getComputedStyle(canvas).color;
    draw();
  }
  let settle = 0;
  const resized = () => { clearTimeout(settle); settle = setTimeout(resize, size ? 140 : 0); };

  // Eight frames a second at full speed, timed by the clock and painted on the next display frame.
  // A hand on the record holds it: the platter keeps its speed, and the record turns only by hand.
  function tick() {
    timer = 0;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (stopped) return;
      if (performance.now() >= heldUntil) { phase += 1; draw(); }
      speed = turning ? Math.min(1, Math.max(0.5, speed * SPIN_UP)) : speed * SPIN_DOWN;
      run();
    });
  }
  function run() {
    if (speed < SLOWEST) speed = 0;
    const should = speed > 0 && !reduced.matches && !document.hidden && !stopped;
    if (should && !timer && !raf) timer = setTimeout(tick, LOGO_MOTION_INTERVAL_MS / speed);
    if (!should) { clearTimeout(timer); cancelAnimationFrame(raf); timer = 0; raf = 0; }
  }

  // The arm eases to where it goes, in a long, even swing on or off the record.
  function aim() {
    swingTo = { from: swing, to: down ? 0 : LIFTED, start: performance.now() };
    if (!swinging) swinging = requestAnimationFrame(swingStep);
  }
  function swingStep() {
    swinging = 0;
    if (stopped || !swingTo) return;
    const { from, to, start } = swingTo;
    const t = reduced.matches ? 1 : Math.min(1, Math.max(0, (performance.now() - start) / SWING_MS));
    const eased = t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2;
    swing = t >= 1 ? to : from + (to - from) * eased;
    if (t >= 1) swingTo = null; else swinging = requestAnimationFrame(swingStep);
    draw();
  }

  const observer = new ResizeObserver(resized);
  observer.observe(canvas);
  const theme = () => { ink = getComputedStyle(canvas).color; draw(); };
  dark.addEventListener("change", theme);
  reduced.addEventListener("change", run);
  document.addEventListener("visibilitychange", run);
  resize();

  return {
    turn(on) {
      turning = Boolean(on);
      if (turning && speed < 0.5) speed = 0.5;
      run();
    },
    needle(on, instant = false) {
      on = Boolean(on);
      if (on === down && !instant) return;
      down = on;
      if (instant || reduced.matches) { swingTo = null; swing = down ? 0 : LIFTED; draw(); return; }
      aim();
    },
    near(x, y) {
      pointer = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      paintSoon();
    },
    spin(distance) {
      if (!disc || !distance) return;
      phase += distance / (disc.radius * scale) / TURN * LOGO_MOTION_FRAMES;
      heldUntil = performance.now() + HELD_MS;
      paintSoon();
    },
    shown(next) {
      if (Math.abs(next - scale) < 0.0005) return;
      scale = next;
      draw();
    },
    hit(x, y) {
      const at = measure(x, y);
      if (!at) return null;
      if (at.gap <= at.reach) return "arm";
      return Math.hypot(at.nx, at.ny) <= 1.04 ? "disc" : null;
    },
    place() {
      if (!disc || !size) return null;
      const box = canvas.getBoundingClientRect();
      const k = box.width / size;
      return { x: box.left + disc.x * k, y: box.top + disc.y * k, radius: disc.radius * k };
    },
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
      cancelAnimationFrame(painting);
      cancelAnimationFrame(swinging);
      cancelIdleCallback(warming);
      observer.disconnect();
      dark.removeEventListener("change", theme);
      reduced.removeEventListener("change", run);
      document.removeEventListener("visibilitychange", run);
    },
  };
}
