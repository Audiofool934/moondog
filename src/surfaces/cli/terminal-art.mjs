export const LOGO_MOTION_FRAMES = 64;
export const LOGO_MOTION_INTERVAL_MS = 125;

const turn = Math.PI * 2;

const dog = [
  [-0.62, 0.48], [-0.55, 0.29], [-0.47, 0.08], [-0.42, -0.16],
  [-0.4, -0.34], [-0.32, -0.47], [-0.18, -0.61], [-0.17, -0.44],
  [-0.12, -0.43], [-0.1, -0.32], [0.02, -0.27], [0.16, -0.24],
  [0.24, -0.18], [0.28, -0.08], [0.35, -0.03], [0.53, 0.015],
  [0.55, 0.055], [0.53, 0.16], [0.46, 0.22], [0.31, 0.26],
  [0.16, 0.26], [0.13, 0.33], [0.13, 0.56], [0.045, 0.58],
  [0.07, 0.77], [-0.13, 0.75], [-0.3, 0.7], [-0.48, 0.62],
];

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
  const dots = new Uint8Array(width * height);
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
        if (predicate(nx, ny, x, y)) dots[y * width + x] = ink ? 1 : 0;
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
        && (!hatch || (dy % 4 < 2 && dx % 9 !== 0)), ink);
  }

  return { dots, width, height, radius, pixel, circle, disc, line, polygon };
}

function braille(columns, rows, phase, cellAspect) {
  const art = drawing(columns, rows, cellAspect);
  const { radius, pixel, circle, disc, line, polygon } = art;
  const detail = radius >= 39 ? 2 : radius >= 27 ? 1 : 0;
  const grooves = detail === 2
    ? [1, 0.975, 0.935, 0.895, 0.85, 0.8, 0.74, 0.67, 0.59, 0.51]
    : detail === 1 ? [1, 0.955, 0.89, 0.82, 0.74, 0.64, 0.53]
      : [1, 0.91, 0.8, 0.66];
  for (const groove of grooves) circle(0, 0, groove, pixel * 0.95);

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
  for (const [groove, offset, length] of [[grooves[1], -0.91, 0.12], [grooves[3], 2.44, 0.09]]) {
    const angle = rotation + offset;
    const points = Array.from({ length: 13 }, (_, index) => {
      const position = angle - length + index / 12 * length;
      return [Math.cos(position) * groove, Math.sin(position) * groove];
    });
    line(points, pixel * 1.65);
    disc(Math.cos(angle) * groove, Math.sin(angle) * groove, pixel * 1.1);
  }

  polygon(dog, false);
  polygon(dog, true, true);
  line([...dog, dog[0]], pixel * 0.8);

  const headband = bezier([-0.42, -0.03], [-0.47, -0.31], [-0.27, -0.58], [-0.18, -0.59]);
  line(headband, Math.max(pixel * 3.5, 0.065));
  line(headband, Math.max(pixel * 1.2, 0.025), false);
  const earX = -0.365;
  const earY = -0.005;
  const earRadius = detail > 0 ? 0.157 : 0.17;
  disc(earX, earY, earRadius + pixel * 1.6, false);
  circle(earX, earY, earRadius, pixel * 1.1);
  circle(earX, earY, earRadius * 0.69, pixel);
  if (detail > 0) circle(earX, earY, earRadius * 0.35, pixel);
  else disc(earX, earY, pixel * 0.9);
  // A small eye and nose keep the dog readable before the hatch pattern resolves.
  disc(0.22, -0.13, pixel * 1.05, false);
  disc(0.53, 0.045, pixel * 0.85);

  line([[1.17, -1.095], [0.91, -0.8]], Math.max(pixel * 1.8, 0.03));
  const cartridge = [[0.92, -0.845], [0.998, -0.777], [0.808, -0.567], [0.73, -0.635]];
  polygon(cartridge, true);
  line([...cartridge, cartridge[0]], pixel);
  disc(0.914, -0.764, Math.max(pixel * 0.7, 0.021), false);
  line([[0.775, -0.615], [0.735, -0.559]], pixel * 1.3);
  const pulse = Math.sin(rotation * 4);
  const angle = -0.612 + pulse * pixel * 0.85;
  const contact = [Math.cos(angle) * 0.928, Math.sin(angle) * 0.928];
  disc(contact[0], contact[1], pixel * (0.95 + pulse * 0.15));

  const bit = [[1, 8], [2, 16], [4, 32], [64, 128]];
  return Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
    let mask = 0;
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        if (art.dots[(row * 4 + y) * art.width + column * 2 + x]) mask |= bit[y][x];
      }
    }
    return mask ? String.fromCodePoint(0x2800 + mask) : " ";
  }).join(""));
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
  return Array.from({ length: rows }, (_, row) => {
    const content = animated[row - top]?.join("") ?? "";
    return (" ".repeat(left) + content).slice(0, columns).padEnd(columns);
  });
}

/**
 * Original terminal drawing, composed from geometry and hand-lettered ASCII.
 * Braille uses a 2-by-4 dot grid; cellAspect (cell height over width) keeps the record round,
 * and the default 2 suits a typical 1:2 terminal cell.
 * phase advances the moon surface and groove highlights through an eight-second loop.
 * The portrait and cartridge stay fixed; scheduling and motion preferences belong to the caller.
 */
export function renderLunarRecord({ columns = 56, rows = 24, style = "braille", phase = 0, cellAspect = 2 } = {}) {
  const width = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 56;
  const height = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 24;
  if (!width || !height) return Array.from({ length: height }, () => "");
  const frame = Number.isFinite(phase)
    ? ((Math.floor(phase) % LOGO_MOTION_FRAMES) + LOGO_MOTION_FRAMES) % LOGO_MOTION_FRAMES
    : 0;
  if (style === "ascii" || width < 20 || height < 9) return ascii(width, height, frame);
  const aspect = Number.isFinite(cellAspect) ? Math.min(3, Math.max(1.5, cellAspect)) : 2;
  return braille(width, height, frame, aspect);
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
