// Moondog's logo, drawn from numbers. Every shape is measured from the selected 2026-09-02 picture
// (assets/brand/moondog-lunar-record): the dog's outline, the headphones, the record's grooves and
// craters, and the tonearm. The picture's paper and its bar mosaic stay with that key visual; the
// logo is one ink on nothing, so it sits on any background.
//
// Coordinates are the picture's 1024 px square with the record's centre moved to (512, 512).
// scripts/generate-logo.mjs writes the files in assets/brand, the app icons and the site's images
// from this module; the window's title-bar mark and the terminal's record draw the same dog.

const f = (n) => Number(n.toFixed(2));
const pt = ([x, y]) => `${f(x)} ${f(y)}`;

export const RECORD = Object.freeze({ cx: 512, cy: 512, rim: 426.7, inner: 222, pitch: 9.75 });

// The earcup is a small record of its own, its rings on the record's own pitch.
const CUP = Object.freeze({ cx: 362.5, cy: 504, r: 67, rings: [5, 14, 23, 32, 41, 50, 59] });

// The band, its outer edge first, from inside the earcup up over the crown to the ear's tip, then
// back down its inner edge. Its foot reaches into the earcup, so the gap round the cup cuts it.
const BAND_OUTER = [[334, 452], [334.6, 418], [335.2, 396.1], [339.3, 371.8], [345.7, 353.1], [353.5, 336.1], [365.6, 317.1],
  [379.8, 300.7], [389.7, 291], [400.7, 282.9], [413.5, 275.6], [426.9, 267.9], [436, 262.3]];
const BAND_TIP = [[441, 262.4], [444.6, 267.6], [447.6, 276.4]];
const BAND_INNER = [[446.3, 281.5], [436.7, 284.8], [419.5, 296], [401.3, 311.1], [389, 324.5], [380.3, 338], [373.4, 351.8],
  [367.4, 368], [363.2, 386], [361.1, 405], [361, 452]];

// The head, clockwise from the ear's tip: down the ear, the brow and the muzzle, round the nose, back
// under the jaw, down the throat and the chest, along the bottom and up the back of the neck into
// the earcup's gap. The corners are the ear, the throat, the chest's step and the bottom's two ends.
const HEAD = [
  [447.6, 281], [469.5, 347.5],
  [481, 359.8], [494, 377.2], [512, 389.2], [542, 401.2], [577, 417], [603, 435.2],
  [611.5, 449], [620.5, 461], [629, 473.5], [641, 483.6], [655, 490.4], [681, 501], [704.4, 508.6], [720, 512],
  [729, 515.8], [733, 522.5], [733.4, 530.6], [731, 539.5],
  [724.3, 553.2], [719.4, 565.9], [712.5, 577.5], [696.5, 593.6], [679.4, 604.9], [657.5, 612.9], [638, 617],
  [592.5, 618.1], [578.2, 621.5], [568.6, 628.9], [563.5, 636],
  [563.3, 661], [565.6, 690], [566.3, 728.3],
  [546.2, 740.3], [528, 746.8],
  [525.2, 790], [527.5, 838.8],
  [480, 833.5], [434, 825], [392, 813.6], [350, 800], [312, 775], [275, 750], [245, 727], [220.3, 699.5],
  [236, 664], [252, 630], [265, 600], [276, 566], [287.7, 533.7], [292, 522],
];
const HEAD_CORNERS = [0, 1, 30, 33, 35, 37, 45];

// Craters, each an inner arc, a ring and one or two dashed rings.
const CRATERS = [
  { cx: 321.5, cy: 236.7, r: 39 }, { cx: 712.8, cy: 277.2, r: 36 }, { cx: 212, cy: 490.9, r: 27.5 },
  { cx: 816.5, cy: 618.4, r: 16.5 }, { cx: 256.5, cy: 786.9, r: 30.5 }, { cx: 640.8, cy: 848.7, r: 40 },
];

// The tonearm in its own coordinates: t runs down the arm from the headshell's middle, s across it.
const ARM = Object.freeze({ origin: [900.3, 201.2], down: [-0.61433, 0.78905] });

// A centripetal Catmull-Rom curve through the nodes, as cubic Béziers: it passes through every node
// and never loops at a sharp turn. A node in `corners` keeps its point; the curve meets it straight.
function segments(nodes, { closed = true, corners = [] } = {}) {
  const sharp = new Set(corners);
  const count = nodes.length;
  const at = (index) => (closed ? nodes[(index + count) % count] : nodes[Math.max(0, Math.min(count - 1, index))]);
  const tangent = (a, b, c, index) => {
    if (sharp.has((index + count) % count)) return [0, 0];
    const before = Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5 || 1e-6;
    const after = Math.hypot(c[0] - b[0], c[1] - b[1]) ** 0.5 || 1e-6;
    return [0, 1].map((axis) => (b[axis] - a[axis]) / before - (c[axis] - a[axis]) / (before + after) + (c[axis] - b[axis]) / after);
  };
  const list = [];
  for (let index = 0; index < (closed ? count : count - 1); index += 1) {
    const [p0, p1, p2, p3] = [at(index - 1), at(index), at(index + 1), at(index + 2)];
    const span = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) ** 0.5;
    const [m1, m2] = [tangent(p0, p1, p2, index), tangent(p1, p2, p3, index + 1)];
    list.push([p1, [p1[0] + m1[0] * span / 3, p1[1] + m1[1] * span / 3], [p2[0] - m2[0] * span / 3, p2[1] - m2[1] * span / 3], p2]);
  }
  return { list, closed };
}
const toPath = ({ list, closed }) => `M${pt(list[0][0])}${list.map(([, c1, c2, end]) => `C${pt(c1)} ${pt(c2)} ${pt(end)}`).join("")}${closed ? "Z" : ""}`;
function toPoints({ list }, steps = 8) {
  const points = [];
  for (const [a, b, c, d] of list) {
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps, s = 1 - t;
      points.push([0, 1].map((axis) => s ** 3 * a[axis] + 3 * s * s * t * b[axis] + 3 * s * t * t * c[axis] + t ** 3 * d[axis]));
    }
  }
  points.push(list.at(-1)[3]);
  return points;
}

// Moves each node of an open line sideways by `by`: positive is to the right of the way it runs.
function offset(nodes, by) {
  return nodes.map((point, index) => {
    const a = nodes[Math.max(0, index - 1)], b = nodes[Math.min(nodes.length - 1, index + 1)];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [point[0] - ((b[1] - a[1]) / length) * by, point[1] + ((b[0] - a[0]) / length) * by];
  });
}

// The dog's three shapes and the gap between band and head. The head closes through the earcup and
// just inside the band, so head and band overlap without a seam; the gaps are cut from all three.
function figure(gap) {
  const band = segments([...BAND_OUTER, ...BAND_TIP, ...BAND_INNER], { corners: [0, BAND_OUTER.length + BAND_TIP.length + BAND_INNER.length - 1] });
  const along = offset([...BAND_INNER].reverse(), -1.5).slice(0, -1);
  const head = segments([...HEAD, [330, 505], [358, 455], ...along], {
    corners: [...HEAD_CORNERS, HEAD.length - 1, HEAD.length, HEAD.length + 1, HEAD.length + along.length - 1],
  });
  // The band's gap runs beside its inner edge, from the middle of the earcup's gap out past the ear.
  const edge = [...BAND_INNER.slice(0, -1), [361.1, CUP.cy - CUP.r - gap / 2]];
  const [first, second] = edge;
  const bandGap = segments(offset([[first[0] + (first[0] - second[0]) * 1.2, first[1] + (first[1] - second[1]) * 1.2], ...edge], -gap / 2), { closed: false });
  return { head, band, bandGap };
}

const toArm = (t, s) => [ARM.origin[0] + t * ARM.down[0] + s * ARM.down[1], ARM.origin[1] + t * ARM.down[1] - s * ARM.down[0]];
const quad = (corners) => `M${corners.map((corner) => pt(toArm(...corner))).join("L")}Z`;
// The full tonearm: tube, collar, headshell, the block under it, finger lift, cartridge, stylus.
function tonearm(reach) {
  return {
    parts: [
      quad([[-reach, -7.25], [-reach, 7.25], [-38, 7.25], [-38, -7.25]]), quad([[-36.5, -11], [-36.5, 11], [-28, 11], [-28, -11]]),
      quad([[-26.5, -17.5], [-26.5, 17.5], [25, 17.5], [25, -20]]), quad([[27, -26], [27, 21.5], [70, 19.5], [70, -28]]),
      quad([[21.75, 17], [21.75, 54], [30.25, 54], [30.25, 17]]),
      quad([[71.5, -13.5], [71.5, 8.5], [97.5, 6.25], [97.5, -11.25]]), quad([[97.5, -6.5], [97.5, 1.5], [104, 0], [104, -5]]),
    ],
    liftEnd: toArm(26, 54),
    screw: toArm(-11.25, 0),
    holes: [toArm(50, -12.5), toArm(50, 7)],
  };
}
// At small sizes the arm is one tube, one headshell and a cartridge, heavy enough to show at 32 px.
const heavyTonearm = (reach) => [quad([[-reach, -15], [-reach, 15], [-30, 15], [-30, -15]]),
  quad([[-26, -30], [-26, 26], [74, 24], [74, -32]]), quad([[78, -17], [78, 11], [104, 8], [104, -14]])];

function arc(cx, cy, r, from, to) {
  const point = (angle) => [cx + r * Math.cos((angle * Math.PI) / 180), cy + r * Math.sin((angle * Math.PI) / 180)];
  return `M${pt(point(from))}A${f(r)} ${f(r)} 0 ${to - from > 180 ? 1 : 0} 1 ${pt(point(to))}`;
}
const ring = (cx, cy, r, width, paint, more = "") =>
  `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${paint}" stroke-width="${f(width)}"${more}/>`;
const crater = ({ cx, cy, r }, ink, line) => {
  const large = r > 25;
  return [
    `<path d="${arc(cx, cy, r * 0.27, 200, 470)}" fill="none" stroke="${ink}" stroke-width="${line}" stroke-linecap="round"/>`,
    ring(cx, cy, r * 0.46, line * 1.15, ink),
    ring(cx, cy, r * (large ? 0.72 : 1), line, ink, ` stroke-dasharray="${f(r * 0.5)} ${f(r * 0.12)}" stroke-dashoffset="${f(r * 0.2)}"`),
    large ? ring(cx, cy, r, line * 0.85, ink, ` stroke-dasharray="${f(r * 0.28)} ${f(r * 0.1)} ${f(r * 0.06)} ${f(r * 0.1)}"`) : "",
  ].join("");
};
// A standalone file takes the reader's light or dark; drawn inside a page, the logo takes the page's colour.
const SCHEME = "<style>svg{color:#141414}@media (prefers-color-scheme:dark){svg{color:#f2f2f2}}</style>";

/**
 * The logo as SVG. The full logo has every groove, the craters and the whole tonearm. `small` is
 * the one for 64 px and below: the rim, two heavy grooves, a heavy tonearm, and gaps wide enough
 * to last. `ink` paints it; `standalone` adds the light and dark colours a file on its own needs.
 * `id` keeps the masks of several logos on one page apart.
 */
export function logoSvg({ small = false, ink = "currentColor", standalone = false, id = "moondog-logo", reach = 200, line = 1.4 } = {}) {
  const gap = small ? 30 : 11;
  const halo = small ? 22 : 6;
  const { head, band, bandGap } = figure(gap);
  const arm = tonearm(reach);
  const armParts = small ? heavyTonearm(reach + 60) : arm.parts;
  const liftEnd = small ? "" : `<circle cx="${f(arm.liftEnd[0])}" cy="${f(arm.liftEnd[1])}" r="4.25"/>`;
  const dog = `<path d="${toPath(head)}"/><path d="${toPath(band)}"/><circle cx="${CUP.cx}" cy="${CUP.cy}" r="${CUP.r}"/>`;
  const grooves = [];
  if (small) grooves.push([RECORD.rim - 15, 30], [362, 22], [312, 22]);
  else for (let r = RECORD.rim, index = 0; r >= RECORD.inner - 0.01; r -= RECORD.pitch, index += 1) grooves.push([r, index ? line : line * 1.6]);
  const cupRings = small
    ? `${ring(CUP.cx, CUP.cy, 34, 14, "#000")}<circle cx="${CUP.cx}" cy="${CUP.cy}" r="14" fill="#000"/>`
    : CUP.rings.map((r) => ring(CUP.cx, CUP.cy, r, 3.2, "#000")).join("");
  const mask = (name, body) => `<mask id="${id}-${name}" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="#fff"/>${body}</mask>`;
  // Grooves stop short of the dog, the arm and the craters; the gaps cut the dog into head, band and cup.
  const clear = `<g fill="#000" stroke="#000" stroke-width="${halo * 2}" stroke-linejoin="round">${dog}${armParts.map((d) => `<path d="${d}"/>`).join("")}${liftEnd}</g>`
    + (small ? "" : CRATERS.map((c) => `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r + 10}" fill="#000"/>`).join(""));
  const cuts = `${ring(CUP.cx, CUP.cy, CUP.r + gap / 2, gap, "#000")}<path d="${toPath(bandGap)}" fill="none" stroke="#000" stroke-width="${gap}"/>${cupRings}`;
  const armDetail = small ? "" : ring(...arm.screw, 7.5, 1.8, "#000") + arm.holes.map(([x, y]) => `<circle cx="${f(x)}" cy="${f(y)}" r="5.5" fill="#000"/>`).join("")
    + `<path d="M${pt(arm.holes[0])}L${pt(arm.holes[1])}" stroke="#000" stroke-width="1.6"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${small ? "40 40 944 944" : "0 0 1024 1024"}">${standalone ? SCHEME : ""}`
    + `<defs>${mask("clear", clear)}${mask("cut", cuts)}${small ? "" : mask("arm", armDetail)}</defs>`
    + `<g mask="url(#${id}-clear)">${grooves.map(([r, width]) => ring(RECORD.cx, RECORD.cy, r, width, ink)).join("")}</g>`
    + (small ? "" : CRATERS.map((c) => crater(c, ink, line)).join(""))
    + `<g mask="url(#${id}-cut)" fill="${ink}">${dog}</g>`
    + `<g fill="${ink}"${small ? "" : ` mask="url(#${id}-arm)"`}>${armParts.map((d) => `<path d="${d}"/>`).join("")}${liftEnd}</g></svg>`;
}

/**
 * The Mac app icon: the full logo on a rounded square of Apple's 824 px grid, its tonearm reaching in
 * from beyond the tile's corner. Light is the app's own icon; dark is the one the listener can choose.
 */
export function appIconSvg({ dark = false, id = "moondog-icon" } = {}) {
  const [tile, ink] = dark ? ["#151515", "#f2f2f2"] : ["#ffffff", "#141414"];
  // A superellipse, the shape of a macOS icon.
  const corner = Array.from({ length: 160 }, (_, index) => {
    const angle = (index / 160) * 2 * Math.PI, cos = Math.cos(angle), sin = Math.sin(angle);
    return [512 + 412 * Math.sign(cos) * Math.abs(cos) ** 0.4, 512 + 412 * Math.sign(sin) * Math.abs(sin) ** 0.4];
  });
  const shape = `M${corner.map(pt).join("L")}Z`;
  const art = logoSvg({ ink, id, reach: 340, line: 1.8 }).replace(/^<svg[^>]*>/u, "").replace(/<\/svg>$/u, "");
  // The soft shadow under the tile that Mac icons draw in their own margin.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><clipPath id="${id}-tile"><path d="${shape}"/></clipPath>`
    + `<filter id="${id}-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.28"/></filter></defs>`
    + `<path d="${shape}" fill="${tile}" filter="url(#${id}-shadow)"/><g clip-path="url(#${id}-tile)"><g transform="translate(512 512) scale(0.74) translate(-512 -512)">${art}</g></g></svg>`;
}

/**
 * The dog for surfaces that draw it themselves, such as the window's title-bar mark and the
 * terminal's record: outlines as points in the record's unit coordinates (the disc has radius 1
 * around 0, 0), at the gap a size calls for (`small` for an icon or a terminal).
 */
export function logoFigure({ small = true } = {}) {
  const gap = small ? 30 : 11;
  const { head, band, bandGap } = figure(gap);
  const unit = ([x, y]) => [(x - RECORD.cx) / RECORD.rim, (y - RECORD.cy) / RECORD.rim];
  return {
    // The head to fill, and its outer edge alone, from the ear's tip round to the back of the neck.
    head: toPoints(head).map(unit),
    headEdge: toPoints(segments(HEAD, { closed: false, corners: HEAD_CORNERS })).map(unit),
    // The band to fill, and the line down its middle, from the ear's tip to the earcup.
    band: toPoints(band).map(unit),
    bandCenter: toPoints(segments(offset(BAND_INNER, 12.5), { closed: false })).map(unit),
    bandGap: toPoints(bandGap, 4).map(unit),
    gap: gap / RECORD.rim,
    cup: { center: unit([CUP.cx, CUP.cy]), radius: CUP.r / RECORD.rim, ring: 34 / RECORD.rim, ringWidth: 14 / RECORD.rim, dot: 14 / RECORD.rim },
  };
}
