// The window's own drawing of the sleeve: the same lunar record the terminal room opens with,
// rasterized to braille at the window's size and turned a little every eighth of a second.
// The geometry comes from the terminal's art module so both rooms draw one record, not two.
import {
  LOGO_MOTION_FRAMES, LOGO_MOTION_INTERVAL_MS, RECORD_LAYERS,
  renderLunarRecordLayers, renderMoondogWordmark,
} from "../../src/surfaces/cli/terminal-art.mjs";

const REDUCED = "(prefers-reduced-motion: reduce)";
// Blank cells are braille blanks, not spaces: the monospace font has no braille, so a space and a dot
// would come from two fonts at two widths and the circle would bulge. One glyph set, one cell width.
const BLANK = "⠀";
const SAMPLE = "⣿".repeat(16);
const escape = (text) => text.replace(/[&<>]/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);
const toneClass = { [RECORD_LAYERS.groove]: "groove", [RECORD_LAYERS.surface]: "surface", [RECORD_LAYERS.figure]: "figure" };

// The frames of one size are drawn once and reused, so turning the record swaps markup instead of
// rendering it again. Only the latest size is kept; a resize starts a new set.
let frames = { key: "", markup: [] };

// One <span> per run of the same ink level: the record's grooves, its surface, and the dog.
function markup(lines, tones) {
  let out = "";
  for (let row = 0; row < lines.length; row += 1) {
    const line = (lines[row] ?? "").replaceAll(" ", BLANK);
    const tone = tones[row] ?? [];
    let start = 0;
    while (start < line.length) {
      const level = tone[start] ?? 0;
      let end = start + 1;
      while (end < line.length && (tone[end] ?? 0) === level) end += 1;
      const run = escape(line.slice(start, end));
      out += level ? `<span class="${toneClass[level] ?? "surface"}">${run}</span>` : run;
      start = end;
    }
    if (row < lines.length - 1) out += "\n";
  }
  return out;
}

export function renderWordmark(pre) {
  pre.textContent = renderMoondogWordmark().join("\n");
}

/**
 * Draws the record into `pre` at the size of its well and keeps it turning.
 * Returns a handle whose stop() releases the frame loop; call it before dropping the node.
 */
export function mountRecord(pre, well, { maxColumns = 74 } = {}) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  let columns = 0;
  let rows = 0;
  let cellAspect = 1;
  let frame = 0;
  let stopped = false;
  let last = 0;
  let raf = 0;
  let observer = null;

  function cell() {
    const style = getComputedStyle(pre);
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const width = context.measureText(SAMPLE).width / SAMPLE.length || 6;
    const line = parseFloat(style.lineHeight) || 10;
    return { width, line };
  }

  function fit() {
    const { width, line } = cell();
    const box = well.getBoundingClientRect();
    const wide = Math.max(18, Math.min(maxColumns, Math.floor(box.width / width)));
    const tall = Math.max(10, Math.floor(box.height / line) - 1);
    // Keep the drawing square in pixels so the record stays a circle.
    let nextColumns = wide;
    let nextRows = Math.round(nextColumns * width / line);
    if (nextRows > tall) {
      nextRows = tall;
      nextColumns = Math.max(18, Math.round(nextRows * line / width));
    }
    return { columns: nextColumns, rows: nextRows, width, line };
  }

  // Measuring reads layout, so it runs when the well changes size, not on every frame.
  function resize() {
    const size = fit();
    cellAspect = size.line / size.width;
    if (size.columns !== columns || size.rows !== rows) {
      columns = size.columns;
      rows = size.rows;
      pre.style.width = `${Math.round(columns * size.width)}px`;
      pre.style.height = `${Math.round(rows * size.line)}px`;
    }
    const key = `${columns}x${rows}x${cellAspect}`;
    if (frames.key !== key) frames = { key, markup: [] };
  }

  function draw() {
    if (stopped) return;
    if (!frames.markup[frame]) {
      const art = renderLunarRecordLayers({ columns, rows, phase: frame, cellAspect });
      frames.markup[frame] = markup(art.lines, art.tones);
    }
    pre.innerHTML = frames.markup[frame];
  }

  function tick(now) {
    if (stopped) return;
    if (now - last >= LOGO_MOTION_INTERVAL_MS) {
      last = now;
      frame = (frame + 1) % LOGO_MOTION_FRAMES;
      draw();
    }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    observer = new ResizeObserver(() => { resize(); draw(); });
    observer.observe(well);
    resize();
    draw();
    if (matchMedia(REDUCED).matches) return;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    stopped = true;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    observer = null;
  }

  // A hidden window does not need to redraw art nobody can see.
  const visibility = () => {
    if (stopped) return;
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
    else if (!raf && !matchMedia(REDUCED).matches) { last = performance.now(); raf = requestAnimationFrame(tick); }
  };

  document.addEventListener("visibilitychange", visibility);
  start();

  return {
    stop() {
      stop();
      document.removeEventListener("visibilitychange", visibility);
    },
    redraw: draw,
  };
}