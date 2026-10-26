export const LOGO_MOTION_FRAMES = 64;
export const LOGO_MOTION_INTERVAL_MS = 125;

const turn = Math.PI * 2;

/** Record layers from faintest to strongest, matching the logo's fine grooves and solid dog. */
export const RECORD_LAYERS = Object.freeze({ groove: 1, surface: 2, figure: 3 });

// The dog's eye, in the record's unit coordinates; layouts line the title up with it.
const eye = [0.22, -0.13];

// The dog's outline runs through these points as one smooth curve (smoothOutline, below), so it
// keeps its shape without the facets of straight segments between them.
const dogPoints = [
  [-0.62, 0.48], [-0.55, 0.29], [-0.47, 0.08], [-0.42, -0.16],
  [-0.4, -0.34], [-0.32, -0.47], [-0.18, -0.61], [-0.17, -0.44],
  [-0.12, -0.43], [-0.1, -0.32], [0.02, -0.27], [0.16, -0.24],
  [0.24, -0.18], [0.28, -0.08], [0.35, -0.03], [0.53, 0.015],
  [0.55, 0.055], [0.53, 0.16], [0.46, 0.22], [0.31, 0.26],
  [0.16, 0.26], [0.13, 0.33], [0.13, 0.56], [0.045, 0.58],
  [0.07, 0.77], [-0.13, 0.75], [-0.3, 0.7], [-0.48, 0.62],
];

// A closed centripetal Catmull-Rom curve through `points`: it passes through every point, and unlike
// the uniform kind it never loops or overshoots at the sharp turns of the ear and the nose.
function smoothOutline(points, steps = 10) {
  const outline = [];
  const count = points.length;
  for (let index = 0; index < count; index += 1) {
    const p = [-1, 0, 1, 2].map((offset) => points[(index + offset + count) % count]);
    const t = [0];
    for (let at = 1; at < 4; at += 1) t.push(t[at - 1] + Math.hypot(p[at][0] - p[at - 1][0], p[at][1] - p[at - 1][1]) ** 0.5);
    for (let step = 0; step < steps; step += 1) {
      const u = t[1] + (t[2] - t[1]) * step / steps;
      const mix = (a, b, from, to) => a.map((value, axis) => ((to - u) * value + (u - from) * b[axis]) / (to - from));
      const [a1, a2, a3] = [mix(p[0], p[1], t[0], t[1]), mix(p[1], p[2], t[1], t[2]), mix(p[2], p[3], t[2], t[3])];
      outline.push(mix(mix(a1, a2, t[0], t[2]), mix(a2, a3, t[1], t[3]), t[1], t[2]));
    }
  }
  return outline;
}
const dog = smoothOutline(dogPoints);

const smallAscii = [
  "                  /",
  "      .-======-. /",
  "   .-'  .--.   [/]",
  "  /   /\\   o    \\",
  " /   /  \\___     \\",
  "|   ((o))== `>    |",
  "|    \\=======/    |",
  " \\    |====|    /",
  "  \\ o /====|   /",
  "   '-.______.-'",
];

const mediumAscii = [
  "                                  /",
  "              .-==========-.     //",
  "         .-=='  .------.    '==. [/]",
  "      .-'   .--'        '--.   '-/'",
  "    .'   .-'   (o)         '-.   '.",
  "   /   .'       /\\     (o)    '.   \\",
  "  /   /        /  \\            \\   \\",
  " |   |        / /\\ \\___         |   |",
  " |   |       / /  \\====='-.     |   |",
  " |   |      (( O ))======= `>   |   |",
  " |   |       \\_//========__/    |   |",
  " |   |       /==========|       |   |",
  "  \\   \\     /===========|      /   /",
  "   \\   '.  /============|    .'   /",
  "    '.   '-.___________   .-'   .'",
  "      '-.   '--._____.--'   .-'",
  "         '==-._________.-=='",
];

const largeAscii = [
  "                                               /",
  "                                             //",
  "                  .-================-.     .//",
  "             .-=='  .------------.    '==. [//]",
  "          .-'   .--'   .------.   '--.   '-./'",
  "       .-'   .-'   .--'        '--.   '-.   '-.",
  "     .'   .-'   .-'                '-.   '-.   '.",
  "    /   .'   .-'   ((o))    /\\       '-.   '.   \\",
  "   /   /   .'             /  \\    (o)  '.   \\   \\",
  "  /   /   /             / /\\ \\           \\   \\   \\",
  " |   |   |             / /  \\ \\____       |   |   |",
  " |   |   |            / /    \\======'-.   |   |   |",
  " |   |   |           / /      \\========'-.|   |   |",
  " |   |   |    o     ((  O  ))=========== `>   |   |",
  " |   |   |           \\___//==============/|   |   |",
  " |   |   |            /=================/ |   |   |",
  " |   |   |           /============|       |   |   |",
  "  \\   \\   \\         /=============|      /   /   /",
  "   \\   \\   '.      /==============|    .'   /   /",
  "    \\   '.   '-.  /===============| .-'   .'   /",
  "     '.   '-.   '-._______________.-'   .-'   .'",
  "       '-.   '-.   '--._______.--'   .-'   .-'",
  "          '-.   '--._____________.--'   .-'",
  "             '==-._________________.-=='",
];

function insidePolygon(x, y, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [ax, ay] = points[index];
    const [bx, by] = points[previous];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

function bezier(start, first, second, end) {
  return Array.from({ length: 65 }, (_, index) => {
    const t = index / 64;
    const s = 1 - t;
    return [0, 1].map((axis) =>
      s ** 3 * start[axis] + 3 * s ** 2 * t * first[axis]
      + 3 * s * t ** 2 * second[axis] + t ** 3 * end[axis],
    );
  });
}

function drawing(columns, rows, cellAspect) {
  const width = columns * 2;
  const height = rows * 4;
  // Each dot remembers which layer inked it, so callers can tone the record like the logo.
  const dots = new Uint8Array(width * height);
  let layer = RECORD_LAYERS.figure;
  // A Braille dot is as tall as a quarter cell and as wide as half of one.
  const stretch = cellAspect / 2;
  const radius = Math.min((width - 4) / 2.35, (height - 4) * stretch / 2.24);
  const centerX = (width - 1) / 2 - radius * 0.09;
  const centerY = (height - 1) / 2 + radius * 0.045 / stretch;
  const pixel = 1 / radius;

  function scan(left, top, right, bottom, predicate, ink) {
    for (let y = Math.max(0, Math.floor(centerY + top * radius / stretch)); y <= Math.min(height - 1, Math.ceil(centerY + bottom * radius / stretch)); y += 1) {
      for (let x = Math.max(0, Math.floor(centerX + left * radius)); x <= Math.min(width - 1, Math.ceil(centerX + right * radius)); x += 1) {
        const nx = (x - centerX) / radius;
        const ny = (y - centerY) * stretch / radius;
        if (predicate(nx, ny, x, y)) dots[y * width + x] = ink ? layer : 0;
      }
    }
  }

  function circle(x, y, size, lineWidth = pixel, ink = true) {
    const half = lineWidth / 2;
    scan(x - size - half, y - size - half, x + size + half, y + size + half,
      (nx, ny) => Math.abs(Math.hypot(nx - x, ny - y) - size) <= half, ink);
  }

  function disc(x, y, size, ink = true) {
    scan(x - size, y - size, x + size, y + size,
      (nx, ny) => Math.hypot(nx - x, ny - y) <= size, ink);
  }

  function line(points, thickness = pixel, ink = true) {
    for (let index = 1; index < points.length; index += 1) {
      const [ax, ay] = points[index - 1];
      const [bx, by] = points[index];
      const length = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(length * radius * 2));
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        disc(ax + (bx - ax) * t, ay + (by - ay) * t, thickness / 2, ink);
      }
    }
  }

  function polygon(points, ink, hatch = false) {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    scan(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys),
      (x, y, dx, dy) => insidePolygon(x, y, points)
        // The hatch runs diagonally, two dots on and two off, like an engraving's.
        && (!hatch || (dx + dy) % 4 < 2), ink);
  }

  const paintLayer = (value) => { layer = value; };
  return { dots, width, height, radius, centerX, centerY, pixel, circle, disc, line, polygon, paintLayer };
}

// The portrait and the tonearm in the record's unit coordinates: the disc has radius 1 around 0,0.
const shapes = {
  headband: bezier([-0.42, -0.03], [-0.47, -0.31], [-0.27, -0.58], [-0.18, -0.59]),
  ear: [-0.365, -0.005],
  nose: [0.53, 0.045],
  arm: [[1.17, -1.095], [0.91, -0.8]],
  cartridge: [[0.92, -0.845], [0.998, -0.777], [0.808, -0.567], [0.73, -0.635]],
  // Two short highlights ride fixed grooves as the record turns: the groove's place from the rim, its angle, its length.
  highlights: [[1, -0.91, 0.12], [3, 2.44, 0.09]],
};

/** The shapes the record is drawn from, for surfaces that draw it as vectors, such as the window's small mark. */
export function lunarRecordShapes() {
  return structuredClone({ dog, eye, ...shapes, earRadius: 0.17, grooves: [1, 0.91, 0.8, 0.66] });
}

// The tonearm swings about its pivot, the arm's first point; a negative swing turns it off the record.
// Only an arm at rest on the record touches a groove, where its contact pulses as the record turns.
function paintTonearm({ pixel, disc, line, polygon }, rotation, swing = 0) {
  const [pivotX, pivotY] = shapes.arm[0];
  const [cosine, sine] = [Math.cos(swing), Math.sin(swing)];
  const swung = ([x, y]) => [pivotX + (x - pivotX) * cosine - (y - pivotY) * sine, pivotY + (x - pivotX) * sine + (y - pivotY) * cosine];
  const cartridge = shapes.cartridge.map(swung);
  line(shapes.arm.map(swung), Math.max(pixel * 1.8, 0.03));
  polygon(cartridge, true);
  line([...cartridge, cartridge[0]], pixel);
  disc(...swung([0.914, -0.764]), Math.max(pixel * 0.7, 0.021), false);
  line([[0.775, -0.615], [0.735, -0.559]].map(swung), pixel * 1.3);
  if (swing) return;
  const pulse = Math.sin(rotation * 4);
  const angle = -0.612 + pulse * pixel * 0.85;
  disc(Math.cos(angle) * 0.928, Math.sin(angle) * 0.928, pixel * (0.95 + pulse * 0.15));
}

// The record as a field of dots, two across and four down per terminal cell, each marked with its layer.
function paint(columns, rows, phase, cellAspect, tonearm = true) {
  const art = drawing(columns, rows, cellAspect);
  const { radius, pixel, circle, disc, line, polygon, paintLayer } = art;
  const detail = radius >= 39 ? 2 : radius >= 27 ? 1 : 0;
  const grooves = detail === 2
    ? [1, 0.975, 0.935, 0.895, 0.85, 0.8, 0.74, 0.67, 0.59, 0.51]
    : detail === 1 ? [1, 0.955, 0.89, 0.82, 0.74, 0.64, 0.53]
      : [1, 0.91, 0.8, 0.66];
  paintLayer(RECORD_LAYERS.groove);
  // A full dot keeps each ring continuous through its diagonals without merging neighbours.
  for (const groove of grooves) circle(0, 0, groove, pixel);
  paintLayer(RECORD_LAYERS.surface);

  const rotation = phase / LOGO_MOTION_FRAMES * turn;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);

  const craters = [
    [-0.5, -0.64, 0.068], [0.47, -0.54, 0.057], [0.73, 0.28, 0.05],
    ...(detail > 0 ? [[-0.71, -0.02, 0.047], [-0.57, 0.68, 0.047], [0.3, 0.81, 0.059]] : []),
  ];
  for (const [originalX, originalY, size] of craters) {
    const x = originalX * cosine - originalY * sine;
    const y = originalX * sine + originalY * cosine;
    disc(x, y, size + pixel * 2, false);
    circle(x, y, size, pixel);
    if (size * radius > 2.8) circle(x + pixel * 0.5, y + pixel * 0.3, size * 0.53, pixel * 0.8);
  }

  // These short highlights follow fixed grooves; the record geometry never deforms.
  // Painting the portrait afterward keeps the moving surface behind the dog and headphones.
  for (const [index, offset, length] of shapes.highlights) {
    const groove = grooves[index];
    const angle = rotation + offset;
    const points = Array.from({ length: 13 }, (_, index) => {
      const position = angle - length + index / 12 * length;
      return [Math.cos(position) * groove, Math.sin(position) * groove];
    });
    line(points, pixel * 1.65);
    disc(Math.cos(angle) * groove, Math.sin(angle) * groove, pixel * 1.1);
  }

  paintLayer(RECORD_LAYERS.figure);
  // Like the logo, a clear halo separates the dog from the grooves around it.
  const { headband, ear, nose } = shapes;
  line([...dog, dog[0]], pixel * 4.5, false);
  line(headband, Math.max(pixel * 7, 0.11), false);
  polygon(dog, false);
  polygon(dog, true, true);
  line([...dog, dog[0]], pixel * 0.8);

  line(headband, Math.max(pixel * 3.5, 0.065));
  line(headband, Math.max(pixel * 1.2, 0.025), false);
  const [earX, earY] = ear;
  const earRadius = detail > 0 ? 0.157 : 0.17;
  disc(earX, earY, earRadius + pixel * 1.6, false);
  circle(earX, earY, earRadius, pixel * 1.1);
  circle(earX, earY, earRadius * 0.69, pixel);
  if (detail > 0) circle(earX, earY, earRadius * 0.35, pixel);
  else disc(earX, earY, pixel * 0.9);
  // A small eye and nose keep the dog readable before the hatch pattern resolves.
  disc(eye[0], eye[1], pixel * 1.05, false);
  disc(nose[0], nose[1], pixel * 0.85);

  if (tonearm) paintTonearm(art, rotation);
  return art;
}

function braille(columns, rows, phase, cellAspect) {
  const art = paint(columns, rows, phase, cellAspect);
  const { radius } = art;
  const bit = [[1, 8], [2, 16], [4, 32], [64, 128]];
  const tones = [];
  const lines = Array.from({ length: rows }, (_, row) => {
    const rowTones = [];
    const line = Array.from({ length: columns }, (_, column) => {
      let mask = 0;
      let tone = 0;
      for (let y = 0; y < 4; y += 1) {
        for (let x = 0; x < 2; x += 1) {
          const value = art.dots[(row * 4 + y) * art.width + column * 2 + x];
          if (value) mask |= bit[y][x];
          tone = Math.max(tone, value);
        }
      }
      rowTones.push(tone);
      return mask ? String.fromCodePoint(0x2800 + mask) : " ";
    }).join("");
    tones.push(rowTones);
    return line;
  });
  // The disc's own center in cells; the tonearm reaches past it, so layouts align on this.
  const stretch = cellAspect / 2;
  const cell = (x, y) => [(art.centerX + x * radius + 0.5) / 2, (art.centerY + y * radius / stretch + 0.5) / 4];
  return { lines, tones, center: cell(0, 0), eye: cell(...eye), radius: [radius / 2, radius / stretch / 4] };
}

function ascii(columns, rows, phase) {
  const templates = [
    { lines: largeAscii, orbit: [25.5, 12.5, 22, 9.5], needle: [37, 6] },
    { lines: mediumAscii, orbit: [18, 8.5, 15.5, 6.9], needle: [29, 4] },
    { lines: smallAscii, orbit: [9, 5.2, 7.7, 3.7], needle: [14, 3] },
  ];
  const selected = templates.find(({ lines }) => lines.length <= rows && Math.max(...lines.map((line) => line.length)) <= columns);
  const template = selected?.lines ?? [" .-o-.", "/ (o)>\\", "\\___/ "];
  const width = Math.max(...template.map((line) => line.length));
  const left = Math.max(0, Math.floor((columns - width) / 2));
  const top = Math.max(0, Math.floor((rows - template.length) / 2));
  const animated = template.map((line) => Array.from(line.padEnd(width)));
  if (selected) {
    const [centerX, centerY, radiusX, radiusY] = selected.orbit;
    const [needleX, needleY] = selected.needle;
    const angle = phase / LOGO_MOTION_FRAMES * turn - 2.17;
    // A crater and two lighter groove marks travel around the hand-drawn perimeter.
    for (const [offset, mark] of [[-0.19, "."], [2.47, ":"], [0, "o"]]) {
      const x = Math.round(centerX + Math.cos(angle + offset) * radiusX);
      const y = Math.round(centerY + Math.sin(angle + offset) * radiusY);
      if (x >= needleX && y <= needleY) continue;
      if (animated[y]?.[x] !== undefined) animated[y][x] = mark;
    }
  }
  const lines = Array.from({ length: rows }, (_, row) => {
    const content = animated[row - top]?.join("") ?? "";
    return (" ".repeat(left) + content).slice(0, columns).padEnd(columns);
  });
  const [centerX, centerY, radiusX, radiusY] = selected?.orbit ?? [width / 2, template.length / 2, width / 2, template.length / 2];
  return {
    lines,
    center: [left + centerX + 0.5, top + centerY + 0.5],
    eye: [left + centerX + eye[0] * radiusX + 0.5, top + centerY + eye[1] * radiusY + 0.5],
    radius: [radiusX, radiusY],
  };
}

/**
 * Original terminal drawing, composed from geometry and hand-lettered ASCII.
 * Braille uses a 2-by-4 dot grid; cellAspect (cell height over width) keeps the record round,
 * and the default 2 suits a typical 1:2 terminal cell.
 * phase advances the moon surface and groove highlights through an eight-second loop.
 * The portrait and cartridge stay fixed; scheduling and motion preferences belong to the caller.
 * Every cell also gets a RECORD_LAYERS tone, so each layer can take its own ink.
 */
export function renderLunarRecordLayers({ columns = 56, rows = 24, style = "braille", phase = 0, cellAspect = 2 } = {}) {
  const width = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 56;
  const height = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 24;
  if (!width || !height) {
    const center = [width / 2, height / 2];
    return { lines: Array.from({ length: height }, () => ""), tones: Array.from({ length: height }, () => []), center, eye: center, radius: center };
  }
  const frame = Number.isFinite(phase)
    ? ((Math.floor(phase) % LOGO_MOTION_FRAMES) + LOGO_MOTION_FRAMES) % LOGO_MOTION_FRAMES
    : 0;
  if (style === "ascii" || width < 20 || height < 9) {
    // Hand-lettered ASCII has no separable layers; it keeps one ink.
    const { lines, ...geometry } = ascii(width, height, frame);
    return { lines, ...geometry, tones: lines.map((line) => Array.from(line, (character) => character === " " ? 0 : RECORD_LAYERS.figure)) };
  }
  const aspect = Number.isFinite(cellAspect) ? Math.min(3, Math.max(1.5, cellAspect)) : 2;
  return braille(width, height, frame, aspect);
}

/**
 * The same record as dots rather than Braille characters, for surfaces that draw their own dots,
 * such as the desktop window's canvas. Dots sit on a square grid of width x height, row by row;
 * each holds 0 or the RECORD_LAYERS value that inked it. With tonearm: false the arm is left out, for
 * a surface that draws it apart with renderTonearmDots so it can lift. centerX, centerY and radius
 * place the record's unit coordinates on the grid, in dots.
 */
export function renderLunarRecordDots({ columns = 56, rows = 28, phase = 0, tonearm = true } = {}) {
  const frame = Number.isFinite(phase) ? ((Math.floor(phase) % LOGO_MOTION_FRAMES) + LOGO_MOTION_FRAMES) % LOGO_MOTION_FRAMES : 0;
  const { dots, width, height, centerX, centerY, radius } = paint(Math.max(10, Math.floor(columns)), Math.max(5, Math.floor(rows)), frame, 2, tonearm);
  return { dots, width, height, centerX, centerY, radius };
}

/**
 * The tonearm alone, on the same grid as renderLunarRecordDots, swung `swing` radians about its pivot
 * (negative lifts it off the record). At rest on the record its contact follows the record's phase.
 */
export function renderTonearmDots({ columns = 56, rows = 28, phase = 0, swing = 0 } = {}) {
  const art = drawing(Math.max(10, Math.floor(columns)), Math.max(5, Math.floor(rows)), 2);
  art.paintLayer(RECORD_LAYERS.figure);
  paintTonearm(art, (Number.isFinite(phase) ? phase : 0) / LOGO_MOTION_FRAMES * turn, Number.isFinite(swing) ? swing : 0);
  return { dots: art.dots, width: art.width, height: art.height };
}

/** Five-pixel letterforms, packed into three terminal rows without color or escapes. */
export function renderMoondogWordmark() {
  const letters = {
    M: ["10001", "11011", "10101", "10001", "10001"],
    O: ["01110", "10001", "10001", "10001", "01110"],
    N: ["10001", "11001", "10101", "10011", "10001"],
    D: ["11110", "10001", "10001", "10001", "11110"],
    G: ["01110", "10000", "10111", "10001", "01110"],
  };
  const blocks = [" ", "▄", "▀", "█"];
  return Array.from({ length: 3 }, (_, row) => Array.from("MOONDOG", (letter) =>
    Array.from({ length: 5 }, (_, column) => {
      const upper = letters[letter][row * 2][column] === "1" ? 2 : 0;
      const lower = letters[letter][row * 2 + 1]?.[column] === "1" ? 1 : 0;
      return blocks[upper + lower];
    }).join(""),
  ).join(" "));
}
