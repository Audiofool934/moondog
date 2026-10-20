// Graphics inside the room. A room component marks the cells it wants painted with an
// invisible OSC 7717 sequence at the start of each of its rows: block id, row within the
// block, width in cells, and the block's data. The room rewrites a whole row at a time
// (CSI 2K, then the row), so a row belongs to the last block that marked it since it was
// cleared. After each write, every block on screen is drawn over its cells, clipped to
// the rows in view. The text underneath stays, so a block without graphics still reads.
const MARK = 7717;
// A marked region keeps at least one blank cell on each side for its bleed (in cells).
const BLEED = 0.4;
const SVG = "http://www.w3.org/2000/svg";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

export function attachBlocks(xterm, renderers) {
  const owners = new Map();
  const data = new Map();
  const drawn = new Map();
  const screen = xterm.element.querySelector(".xterm-screen");
  const layer = document.createElement("div");
  layer.className = "room-blocks";
  screen.append(layer);

  xterm.parser.registerOscHandler(MARK, (payload) => {
    const [id, row, width, encoded] = payload.split(";");
    const { cursorX, cursorY } = xterm.buffer.active;
    if (!id || !Number.isInteger(Number(row)) || !(Number(width) > 0)) return true;
    owners.set(cursorY, { id, row: Number(row), col: cursorX, width: Number(width) });
    if (encoded && !data.has(id)) {
      try { data.set(id, JSON.parse(atob(encoded))); } catch {}
    }
    return true;
  });
  // Erasing a row, or the screen, ends the claims on it; the default erase still runs.
  xterm.parser.registerCsiHandler({ final: "K" }, ([mode = 0]) => {
    const { cursorX, cursorY } = xterm.buffer.active;
    const owner = owners.get(cursorY);
    if (owner && (mode === 2 || (mode === 0 && cursorX <= owner.col) || (mode === 1 && cursorX >= owner.col))) owners.delete(cursorY);
    return false;
  });
  xterm.parser.registerCsiHandler({ final: "J" }, ([mode = 0]) => {
    const { cursorY } = xterm.buffer.active;
    for (const row of owners.keys()) {
      if (mode >= 2 || (mode === 0 && row >= cursorY) || (mode === 1 && row <= cursorY)) owners.delete(row);
    }
    return false;
  });

  const layout = () => {
    const cell = { width: screen.clientWidth / xterm.cols, height: screen.clientHeight / xterm.rows };
    const blocks = new Map();
    for (const [screenRow, owner] of owners) {
      const block = blocks.get(owner.id) ?? { top: screenRow - owner.row, col: owner.col, width: owner.width, first: screenRow, last: screenRow };
      block.first = Math.min(block.first, screenRow);
      block.last = Math.max(block.last, screenRow);
      blocks.set(owner.id, block);
    }
    for (const [id, element] of drawn) {
      if (!blocks.has(id)) { element.remove(); drawn.delete(id); }
    }
    for (const [id, block] of blocks) {
      const value = data.get(id);
      const render = renderers[value?.kind];
      if (!render) continue;
      const rows = value.rows?.length ?? block.last - block.top + 1;
      // Glyphs can draw a little past their cells, so a block bleeds into the blank cells
      // a marked region keeps on each side; otherwise slivers of the text show at its edges.
      const bleed = Math.ceil(cell.width * BLEED);
      const size = { width: block.width * cell.width + 2 * bleed, height: rows * cell.height, cell, bleed };
      let element = drawn.get(id);
      if (!element || element.dataset.size !== `${size.width}x${size.height}`) {
        const next = render(value, size, { animate: !element && !reduceMotion.matches });
        next.className = "room-block";
        next.dataset.size = `${size.width}x${size.height}`;
        if (element) element.replaceWith(next);
        else layer.append(next);
        drawn.set(id, element = next);
      }
      element.style.left = `${block.col * cell.width - bleed}px`;
      element.style.top = `${block.top * cell.height}px`;
      // Rows scrolled out of view are cut away; the header and the draft keep their cells.
      // A cut edge also drops its first pixel, where a divider between rows would sit.
      const above = (block.first - block.top) * cell.height;
      const below = (block.top + rows - 1 - block.last) * cell.height;
      element.style.clipPath = `inset(${above ? above + 1 : 0}px 0 ${below ? below + 1 : 0}px 0)`;
    }
  };
  xterm.onWriteParsed(layout);
  xterm.onResize(() => requestAnimationFrame(layout));
}

const svg = (name, attributes = {}) => {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
};

// Listening time, or plays, per quarter as thin bars on faint tracks, one row per quarter.
// Years are divided by hairlines, and each new song is a dot after its quarter's bar.
export function renderSeasons(value, { width: outer, height, cell, bleed }, { animate }) {
  const styles = getComputedStyle(document.documentElement);
  const color = (name, fallback) => value.colors?.[name] || styles.getPropertyValue(fallback).trim();
  const ink = color("ink", "--ink");
  const faint = color("faint", "--rule");
  const paper = color("paper", "--paper");
  const root = document.createElement("div");
  root.style.width = `${outer}px`;
  root.style.height = `${height}px`;
  // The drawing's origin is the block's first cell; the bleed only widens the paper.
  const width = outer - 2 * bleed;
  const chart = svg("svg", { width: outer, height, viewBox: `${-bleed} 0 ${outer} ${height}`, "aria-hidden": "true" });
  chart.append(svg("rect", { x: -bleed, width: outer, height, fill: paper }));
  const barHeight = Math.max(3, Math.round(cell.height * 0.42));
  const dot = Math.max(1.4, barHeight * 0.3);
  const reach = width - cell.width * 0.5;
  value.rows.forEach((row, index) => {
    const middle = (index + 0.5) * cell.height;
    if (index > 0 && row.quarter === 1) {
      chart.append(svg("line", { x1: 0, x2: width, y1: index * cell.height, y2: index * cell.height, stroke: faint, "stroke-width": 1, "stroke-dasharray": "2 3", opacity: 0.7 }));
    }
    chart.append(svg("line", { x1: 0, x2: reach, y1: middle, y2: middle, stroke: faint, "stroke-width": 1, opacity: 0.35 }));
    if (row.empty) {
      chart.append(svg("circle", { cx: barHeight / 2, cy: middle, r: barHeight / 2 - 0.5, fill: paper, stroke: faint, "stroke-width": 1 }));
      return;
    }
    const length = Math.max(barHeight, row.fraction * (reach - cell.width * 2));
    const bar = svg("rect", { x: 0, y: middle - barHeight / 2, width: length, height: barHeight, rx: barHeight / 2, fill: ink });
    chart.append(bar);
    for (let song = 0; song < Math.min(row.newSongs, 8); song += 1) {
      chart.append(svg("circle", { cx: length + dot * 3 + song * dot * 3.2, cy: middle, r: dot, fill: ink, opacity: 0.55 }));
    }
    if (animate) {
      bar.style.transformBox = "fill-box";
      bar.style.transformOrigin = "left center";
      bar.animate([{ transform: "scaleX(0.02)" }, { transform: "scaleX(1)" }], { duration: 520, delay: index * 35, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" });
    }
  });
  root.append(chart);
  return root;
}
