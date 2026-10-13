import { inflateSync } from "node:zlib";

// Album covers drawn with characters: color half-blocks, braille dots, or plain ASCII.
// The terminal only ever receives text, so covers work in tmux, over SSH, and in xterm.js.

const COVER_FETCH_BYTES_MAX = 512 * 1024;
const COVER_FETCH_TIMEOUT_MS = 8_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ASCII_RAMP = " .:-=+*#%@";

/** Asks Apple's image host for a small PNG of the cover; other hosts are refused. */
export function coverImageUrl(artworkUrl, pixels = 96) {
  let url;
  try { url = new URL(String(artworkUrl ?? "")); } catch { return null; }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".mzstatic.com")) return null;
  const size = Math.max(16, Math.min(600, Math.round(pixels)));
  const path = url.pathname.replace(/\/\d+x\d+bb\.(?:jpg|jpeg|png|webp)$/iu, `/${size}x${size}bb.png`);
  if (path === url.pathname) return null;
  url.pathname = path;
  return url.toString();
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

/** Decodes the 8-bit, non-interlaced PNGs Apple serves into RGB pixels. */
export function decodePng(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) throw new Error("The cover is not a PNG image.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette = null;
  const compressed = [];
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error("The cover uses a PNG format Moondog does not read.");
    } else if (type === "PLTE") palette = data;
    else if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || !width || !height || width * height > 1024 * 1024) throw new Error("The cover uses a PNG format Moondog does not read.");
  if (colorType === 3 && !palette) throw new Error("The cover's PNG palette is missing.");
  const joined = new Uint8Array(compressed.reduce((sum, part) => sum + part.length, 0));
  compressed.reduce((at, part) => { joined.set(part, at); return at + part.length; }, 0);
  const raw = inflateSync(joined);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("The cover's PNG data is incomplete.");
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? rows[target + x - channels] : 0;
      const up = y > 0 ? rows[target - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? rows[target - stride + x - channels] : 0;
      const value = raw[source + x];
      rows[target + x] = filter === 0 ? value
        : filter === 1 ? value + left
          : filter === 2 ? value + up
            : filter === 3 ? value + ((left + up) >> 1)
              : value + paeth(left, up, upLeft);
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const at = pixel * channels;
    let color;
    if (colorType === 3) color = [palette[rows[at] * 3], palette[rows[at] * 3 + 1], palette[rows[at] * 3 + 2]];
    else if (channels <= 2) color = [rows[at], rows[at], rows[at]];
    else color = [rows[at], rows[at + 1], rows[at + 2]];
    rgb.set(color, pixel * 3);
  }
  return { width, height, rgb };
}

/** Fetches and decodes one cover. Callers keep it on the host; nothing is sent to the model. */
export async function fetchCover(artworkUrl, { pixels = 96, signal, fetchImpl = globalThis.fetch } = {}) {
  const url = coverImageUrl(artworkUrl, pixels);
  if (!url) throw new Error("This cover is not from Apple's image host.");
  const timeout = AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS);
  const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
  if (!response.ok) throw new Error(`Apple's image host answered ${response.status}.`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length > COVER_FETCH_BYTES_MAX) throw new Error("The cover image is too large.");
  return decodePng(body);
}

// Averages the source pixels that fall inside each target cell, so small covers stay smooth.
function resample(image, columns, rows) {
  const out = new Float32Array(columns * rows * 3);
  for (let y = 0; y < rows; y += 1) {
    const top = Math.floor((y * image.height) / rows);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * image.height) / rows));
    for (let x = 0; x < columns; x += 1) {
      const left = Math.floor((x * image.width) / columns);
      const right = Math.max(left + 1, Math.floor(((x + 1) * image.width) / columns));
      const sum = [0, 0, 0];
      for (let sy = top; sy < bottom; sy += 1) {
        for (let sx = left; sx < right; sx += 1) {
          const at = (sy * image.width + sx) * 3;
          sum[0] += image.rgb[at];
          sum[1] += image.rgb[at + 1];
          sum[2] += image.rgb[at + 2];
        }
      }
      const count = (bottom - top) * (right - left);
      out.set(sum.map((value) => value / count), (y * columns + x) * 3);
    }
  }
  return out;
}

const luminance = (pixels, at) => (0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2]) / 255;

// One-color styles stretch each cover's own light range, so a pale cover keeps its lettering
// instead of filling with one character. Light-on-dark ink is the default.
function inkLevels(pixels, count, invert) {
  const levels = new Float32Array(count);
  for (let index = 0; index < count; index += 1) levels[index] = luminance(pixels, index * 3);
  const sorted = Float32Array.from(levels).sort();
  const low = sorted[Math.floor(count * 0.02)];
  const high = sorted[Math.floor(count * 0.98)];
  const range = Math.max(0.08, high - low);
  for (let index = 0; index < count; index += 1) {
    const value = Math.max(0, Math.min(1, (levels[index] - low) / range));
    levels[index] = invert ? 1 - value : value;
  }
  return levels;
}

// The fixed 6x6x6 cube and gray ramp of 256-color terminals; the first sixteen are user-defined.
function xterm256(r, g, b) {
  const level = (value) => (value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.floor((value - 35) / 40)));
  const steps = [0, 95, 135, 175, 215, 255];
  const [cr, cg, cb] = [level(r), level(g), level(b)];
  const cube = 16 + 36 * cr + 6 * cg + cb;
  const cubeError = (steps[cr] - r) ** 2 + (steps[cg] - g) ** 2 + (steps[cb] - b) ** 2;
  const grayLevel = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const gray = 8 + grayLevel * 10;
  const grayError = (gray - r) ** 2 + (gray - g) ** 2 + (gray - b) ** 2;
  return grayError < cubeError ? 232 + grayLevel : cube;
}

function colorCode(layer, pixels, at, depth) {
  const [r, g, b] = [pixels[at], pixels[at + 1], pixels[at + 2]].map(Math.round);
  return depth === 24 ? `${layer};2;${r};${g};${b}` : `${layer};5;${xterm256(r, g, b)}`;
}

// Each cell holds two stacked pixels: the upper half in the foreground, the lower in the background.
function renderBlocks(image, columns, rows, depth) {
  const pixels = resample(image, columns, rows * 2);
  const lines = [];
  for (let y = 0; y < rows; y += 1) {
    let line = "";
    for (let x = 0; x < columns; x += 1) {
      const upper = (y * 2 * columns + x) * 3;
      const lower = ((y * 2 + 1) * columns + x) * 3;
      line += `\u001b[${colorCode(38, pixels, upper, depth)};${colorCode(48, pixels, lower, depth)}m▀`;
    }
    lines.push(`${line}\u001b[39;49m`);
  }
  return lines;
}

// Each braille cell is a 2x4 dot grid; error diffusion keeps midtones from turning into flat shapes.
function renderBraille(image, columns, rows, { invert = false } = {}) {
  const width = columns * 2;
  const height = rows * 4;
  const levels = inkLevels(resample(image, width, height), width * height, invert);
  const on = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const ink = levels[index] > 0.5 ? 1 : 0;
      on[index] = ink;
      const error = levels[index] - ink;
      if (x + 1 < width) levels[index + 1] += (error * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) levels[index + width - 1] += (error * 3) / 16;
        levels[index + width] += (error * 5) / 16;
        if (x + 1 < width) levels[index + width + 1] += error / 16;
      }
    }
  }
  const bits = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    let line = "";
    for (let column = 0; column < columns; column += 1) {
      let code = 0;
      for (let dy = 0; dy < 4; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          if (on[(row * 4 + dy) * width + column * 2 + dx]) code |= bits[dy][dx];
        }
      }
      line += String.fromCodePoint(0x2800 + code);
    }
    lines.push(line);
  }
  return lines;
}

function renderAscii(image, columns, rows, { invert = false } = {}) {
  const levels = inkLevels(resample(image, columns, rows), columns * rows, invert);
  const lines = [];
  for (let y = 0; y < rows; y += 1) {
    let line = "";
    for (let x = 0; x < columns; x += 1) {
      const ink = levels[y * columns + x];
      line += ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor(ink * ASCII_RAMP.length))];
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Draws a square cover in about `columns` cells, keeping it square on screen for the cell shape.
 * style: "blocks" (needs 256 or 24-bit color), "braille", or "ascii".
 * Light-on-dark ink is the default; pass `lightBackground` for paper themes so dark areas print dark.
 */
export function renderCover(image, { columns, cellAspect = 2, style = "blocks", depth = 24, lightBackground = false }) {
  const width = Math.max(4, Math.floor(columns));
  const rows = Math.max(2, Math.round((width * (image.height / image.width)) / cellAspect));
  if (style === "blocks" && depth >= 8) return renderBlocks(image, width, rows, depth);
  if (style === "ascii") return renderAscii(image, width, rows, { invert: lightBackground });
  return renderBraille(image, width, rows, { invert: lightBackground });
}
