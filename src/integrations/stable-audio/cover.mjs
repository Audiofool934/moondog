// The sleeve of a track Moondog made: a grid of characters, drawn as an SVG, never an image model.
// It reads only the track's receipt: the seed, what shaped the sound, and how loud the track ran from
// start to end. So one track always has one cover, and a stream that keeps only its newest audio
// still draws every cover. The loud band across the middle is the track itself; the field behind it
// takes its characters and colour from the track's textures, genres and moods.
import { open, readFile } from "node:fs/promises";
import path from "node:path";

// How many loudness readings a receipt keeps, from the start of the track to its end.
export const LOUDNESS_POINTS = 64;
// The grid: 40 columns by 24 rows on a 600-point square, so a cell is about as tall as a monospace glyph.
const COLUMNS = 40;
const ROWS = 24;
const SIZE = 600;
const MARGIN = 30;
const CELL_W = (SIZE - 2 * MARGIN) / COLUMNS;
const CELL_H = (SIZE - 2 * MARGIN) / ROWS;
// The rows the art fills; the rows above and below carry the readout.
const ART_TOP = 2;
const ART_ROWS = 19;
export const COVER_VERSION = 1;

// ── Loudness ──────────────────────────────────────────────────────────────────────────────────

/**
 * How loud a WAV runs from start to end: `points` readings from 0 (30 dB under its loudest stretch,
 * or quieter) to 1 (its loudest). Reads 16-, 24- and 32-bit PCM and 32-bit float. Null when the file
 * is not a WAV it can read.
 */
export async function readLoudness(file, points = LOUDNESS_POINTS) {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return null;
    let format = null;
    let data = null;
    for (let offset = 12; offset + 8 <= size && !data;) {
      const chunk = Buffer.alloc(8);
      await handle.read(chunk, 0, 8, offset);
      const id = chunk.toString("ascii", 0, 4);
      const length = chunk.readUInt32LE(4);
      if (id === "fmt ") {
        const body = Buffer.alloc(Math.min(length, 40));
        await handle.read(body, 0, body.length, offset + 8);
        let code = body.readUInt16LE(0);
        // WAVE_FORMAT_EXTENSIBLE names the real format in its subformat.
        if (code === 0xfffe && body.length >= 26) code = body.readUInt16LE(24);
        format = { code, channels: body.readUInt16LE(2), bits: body.readUInt16LE(14) };
      } else if (id === "data") {
        data = { start: offset + 8, length: Math.min(length, size - offset - 8) };
      }
      offset += 8 + length + (length % 2);
    }
    if (!format || !data || !format.channels) return null;
    const bytes = format.bits / 8;
    const sample = format.code === 3 && format.bits === 32 ? (buffer, at) => buffer.readFloatLE(at)
      : format.code === 1 && format.bits === 16 ? (buffer, at) => buffer.readInt16LE(at) / 32768
        : format.code === 1 && format.bits === 24 ? (buffer, at) => buffer.readIntLE(at, 3) / 8388608
          : format.code === 1 && format.bits === 32 ? (buffer, at) => buffer.readInt32LE(at) / 2147483648 : null;
    if (!sample) return null;
    const frameBytes = bytes * format.channels;
    const frames = Math.floor(data.length / frameBytes);
    if (frames < points) return null;
    const sums = new Float64Array(points);
    const counts = new Float64Array(points);
    const chunkFrames = 65_536;
    const buffer = Buffer.alloc(chunkFrames * frameBytes);
    for (let frame = 0; frame < frames; frame += chunkFrames) {
      const count = Math.min(chunkFrames, frames - frame);
      const { bytesRead } = await handle.read(buffer, 0, count * frameBytes, data.start + frame * frameBytes);
      const read = Math.floor(bytesRead / frameBytes);
      for (let index = 0; index < read; index += 1) {
        const point = Math.min(points - 1, Math.floor(((frame + index) * points) / frames));
        let energy = 0;
        for (let channel = 0; channel < format.channels; channel += 1) {
          const value = sample(buffer, index * frameBytes + channel * bytes);
          energy += value * value;
        }
        sums[point] += energy / format.channels;
        counts[point] += 1;
      }
      if (read < count) break;
    }
    const decibels = [...sums].map((sum, point) => 10 * Math.log10(Math.max(1e-10, sum / Math.max(1, counts[point]))));
    const loudest = Math.max(...decibels);
    return decibels.map((db) => Math.round(Math.max(0, Math.min(1, (db - (loudest - 30)) / 30)) * 1000) / 1000);
  } finally {
    await handle.close();
  }
}

// ── The look, from what shaped the sound ─────────────────────────────────────────────────────

// Each glyph ramp runs from empty to dense. The track's words pick one.
const RAMPS = [
  { name: "grain", ramp: " .,:;irsXA253hMHGS#9B&@", words: ["tape", "crackle", "vinyl", "lofi", "lo-fi", "dust", "noise", "grit", "distort", "saturat", "fuzz", "analog", "cassette", "hiss", "warble", "boom bap"] },
  { name: "soft", ramp: " .'`-~:=+*", words: ["ambient", "reverb", "wash", "air", "dream", "ether", "drone", "shimmer", "pad", "haze", "mist", "calm", "gentle", "soft", "float", "shoegaze", "new age"] },
  { name: "digital", ramp: " .-:=+01x#", words: ["electronic", "techno", "house", "synth", "glitch", "digital", "idm", "trance", "edm", "chip", "bit", "modular", "acid", "breakbeat", "drum and bass", "dubstep", "electro"] },
  { name: "strings", ramp: " .,-~:;!|/", words: ["piano", "guitar", "string", "folk", "jazz", "acoustic", "orchestra", "wood", "cello", "violin", "harp", "classical", "choir", "brass", "bass clarinet", "upright"] },
];
const DEFAULT_RAMP = " .:-=+*#%@";

// Hues for the words a track carries; light paper for the bright ones.
const HUES = [
  { hue: 32, words: ["warm", "sun", "amber", "golden", "tape", "vinyl", "lofi", "lo-fi", "soul", "funk", "dust", "cassette", "boom bap"] },
  { hue: 232, words: ["night", "dark", "noir", "midnight", "melanchol", "sad", "moody", "deep", "nocturn", "cold", "brooding"] },
  { hue: 182, words: ["ambient", "ocean", "water", "aquatic", "chill", "calm", "dream", "float", "reverb", "shoegaze", "wash", "rain"] },
  { hue: 350, words: ["jazz", "blues", "romantic", "lounge", "love", "sensual", "r&b", "neo soul"] },
  { hue: 286, words: ["electronic", "techno", "synth", "neon", "glitch", "acid", "cyber", "trance", "house", "electro"] },
  { hue: 96, words: ["folk", "acoustic", "pastoral", "forest", "organic", "nature", "country", "earthy"] },
  { hue: 46, light: true, words: ["bright", "happy", "pop", "upbeat", "euphoric", "joy", "sunny", "playful", "uplifting"] },
];

// A small seeded generator, so a seed always draws the same cover.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (text) => [...String(text)].reduce((sum, character) => (Math.imul(sum, 31) + character.codePointAt(0)) >>> 0, 2166136261);

// The words that shaped the track: texture counts most, then genre, mood and the rest.
function wordsOf(receipt) {
  const weights = { texture: 3, genre: 2, mood: 2, instrument: 1, rhythm: 1 };
  return (Array.isArray(receipt?.shaped_by) ? receipt.shaped_by : [])
    .filter((entry) => typeof entry?.term === "string")
    .map((entry) => ({ term: entry.term.toLowerCase(), weight: weights[entry.facet] ?? 1 }));
}
function bestMatch(options, words) {
  let best = null;
  let bestScore = 0;
  for (const option of options) {
    const score = words.reduce((sum, { term, weight }) => sum + (option.words.some((word) => term.includes(word)) ? weight : 0), 0);
    if (score > bestScore) { best = option; bestScore = score; }
  }
  return best;
}

const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;

// ── The field ────────────────────────────────────────────────────────────────────────────────

// A field behind the band: a few seeded waves, or rings around a point, as the seed chooses. Values 0 to 1.
function backgroundField(next) {
  const kind = next() < 0.5 ? "waves" : "rings";
  const waves = Array.from({ length: 3 }, () => ({
    angle: next() * Math.PI, frequency: 2 + next() * 7, phase: next() * Math.PI * 2, weight: 0.5 + next(),
  }));
  const center = { x: 0.15 + next() * 0.7, y: 0.15 + next() * 0.7 };
  const ringFrequency = 9 + next() * 10;
  const total = waves.reduce((sum, wave) => sum + wave.weight, 0);
  return (x, y) => {
    let value = 0;
    for (const wave of waves) {
      const along = x * Math.cos(wave.angle) + y * Math.sin(wave.angle);
      value += wave.weight * Math.sin(along * wave.frequency * Math.PI + wave.phase);
    }
    value /= total;
    if (kind === "rings") {
      const distance = Math.hypot((x - center.x) * 1.0, y - center.y);
      value = 0.6 * Math.sin(distance * ringFrequency * Math.PI) + 0.4 * value;
    }
    return (value + 1) / 2;
  };
}

// Readings spread over `columns`, so 64 kept readings fit the grid's 40 columns.
function resample(values, columns) {
  if (!Array.isArray(values) || values.length < 2) return null;
  return Array.from({ length: columns }, (_, column) => {
    const at = (column / (columns - 1)) * (values.length - 1);
    const low = Math.floor(at);
    const high = Math.min(values.length - 1, low + 1);
    const value = values[low] + (values[high] - values[low]) * (at - low);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  });
}

// Made tracks are loud almost all the way through, so the band shows each track against its own
// quietest and loudest stretch; the quietest still keeps a quarter of the height.
function stretch(values) {
  if (!values) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = high - low;
  return values.map((value) => 0.25 + 0.75 * (range >= 0.05 ? (value - low) / range : value));
}

// ── The readout ──────────────────────────────────────────────────────────────────────────────

// A character takes two cells when it is wide, as CJK is.
const wide = (character) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3fffd}]/u.test(character);
const cellsOf = (text) => [...text].reduce((sum, character) => sum + (wide(character) ? 2 : 1), 0);
function fit(text, cells) {
  if (cellsOf(text) <= cells) return text;
  let out = "";
  for (const character of text) {
    if (cellsOf(`${out}${character}`) > cells - 1) break;
    out += character;
  }
  return `${out}…`;
}
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

function readout(receipt) {
  const position = Number.isInteger(receipt?.stream?.position) ? receipt.stream.position : null;
  const date = typeof receipt?.created_at === "string" ? receipt.created_at.slice(0, 10).replaceAll("-", ".") : "";
  const featured = Array.isArray(receipt?.stream?.featured) && receipt.stream.featured.length ? receipt.stream.featured
    : wordsOf(receipt).slice(0, 3).map(({ term }) => term);
  const seconds = receipt?.audio?.duration_seconds ?? receipt?.generator?.seconds;
  const bpm = Number.isInteger(receipt?.bpm) ? receipt.bpm : null;
  const seed = Number.isInteger(receipt?.generator?.seed) ? receipt.generator.seed : null;
  return {
    left: "moondog",
    right: position ? `on air #${String(position).padStart(2, "0")}` : date,
    terms: featured.length ? fit(`// ${featured.join(", ")}`, COLUMNS) : "// made on this mac",
    facts: fit([Number.isFinite(seconds) ? clock(seconds) : null, bpm ? `${bpm} bpm` : null, seed !== null ? `seed ${seed}` : null]
      .filter(Boolean).join("  "), COLUMNS),
  };
}

// ── Drawing ──────────────────────────────────────────────────────────────────────────────────

const escape = (text) => text.replace(/[&<>"]/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
const x = (column) => (MARGIN + (column + 0.5) * CELL_W).toFixed(1);
const y = (row) => (MARGIN + (row + 0.78) * CELL_H).toFixed(1);

/**
 * The cover of one made track: { svg, lines, look }. `lines` is the same grid as plain text, for a
 * terminal; `look` names the ramp, field and hue it chose. `loudness` overrides the receipt's own
 * readings, for a track made before receipts kept them.
 */
export function drawCover(receipt, { loudness } = {}) {
  const seed = (Number.isInteger(receipt?.generator?.seed) ? receipt.generator.seed : 0) ^ hash(receipt?.generated_track_id ?? receipt?.title ?? "");
  const next = random(seed);
  const words = wordsOf(receipt);
  const ramp = bestMatch(RAMPS, words);
  const glyphs = ramp?.ramp ?? DEFAULT_RAMP;
  const tint = bestMatch(HUES, words);
  const hue = (tint?.hue ?? Math.floor(next() * 360)) + (next() - 0.5) * 24;
  const light = tint?.light === true;
  const colours = light
    ? { paper: hsl(hue, 34, 90), dim: hsl(hue, 16, 64), ink: hsl(hue, 24, 32), accent: hsl(hue, 70, 40) }
    : { paper: hsl(hue, 26, 9), dim: hsl(hue, 16, 34), ink: hsl(hue, 18, 64), accent: hsl(hue, 72, 68) };
  const field = backgroundField(next);
  const band = stretch(resample(loudness ?? receipt?.audio?.loudness, COLUMNS));
  // A little unevenness per column, so the band reads as a waveform rather than a block.
  const jitter = Array.from({ length: COLUMNS }, () => 0.86 + next() * 0.28);

  // Each cell holds a glyph and its tone: 0 dim, 1 ink, 2 accent.
  const grid = Array.from({ length: ROWS }, () => Array.from({ length: COLUMNS }, () => ({ glyph: " ", tone: 1 })));
  for (let row = 0; row < ART_ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const fx = column / (COLUMNS - 1);
      const fy = row / (ART_ROWS - 1);
      const behind = field(fx, fy);
      // With a band, the field stays low so the band reads first; without one, the field is the cover.
      let value = band ? Math.max(0, behind - 0.35) * 0.75 : Math.max(0, behind - 0.2) * 1.1;
      let tone = band ? 0 : behind > 0.82 ? 2 : behind > 0.55 ? 1 : 0;
      if (band) {
        // The band is the track: tall where it is loud, mirrored about the middle row as a waveform is.
        const half = 0.06 + band[column] * 0.36 * jitter[column];
        const distance = Math.abs(fy - 0.5);
        if (distance <= half) {
          const depth = (1 - distance / half) ** 0.8;
          value = Math.max(value, Math.min(1, 0.38 + 0.62 * depth + (behind - 0.5) * 0.4));
          tone = distance <= half * 0.4 ? 2 : 1;
        }
      }
      const index = Math.min(glyphs.length - 1, Math.floor(value * glyphs.length));
      grid[ART_TOP + row][column] = { glyph: glyphs[index], tone };
    }
  }
  const write = (row, text, column, tone) => {
    let at = column;
    for (const character of text) {
      if (at >= COLUMNS) break;
      grid[row][at] = { glyph: character, tone };
      at += wide(character) ? 2 : 1;
      if (wide(character) && at - 1 < COLUMNS) grid[row][at - 1] = { glyph: "", tone };
    }
  };
  const info = readout(receipt);
  write(0, info.left, 0, 1);
  write(0, info.right, COLUMNS - cellsOf(info.right), 2);
  write(ROWS - 2, info.terms, 0, 1);
  write(ROWS - 1, info.facts, 0, 0);

  // One text element per row and tone, each glyph at its own cell, so any monospace font keeps the grid.
  const tones = [colours.dim, colours.ink, colours.accent];
  const rows = grid.map((cells, row) => tones.map((fill, tone) => {
    const placed = cells.map((cell, column) => ({ ...cell, column })).filter((cell) => cell.tone === tone && cell.glyph && cell.glyph !== " ");
    if (!placed.length) return "";
    return `<text y="${y(row)}" x="${placed.map((cell) => x(cell.column)).join(" ")}" fill="${fill}">${escape(placed.map((cell) => cell.glyph).join(""))}</text>`;
  }).join("")).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`
    + `<rect width="${SIZE}" height="${SIZE}" fill="${colours.paper}"/>`
    + `<g font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="19" font-weight="500" text-anchor="middle">${rows}</g></svg>`;
  const lines = grid.map((cells) => cells.map((cell) => cell.glyph).join("").replace(/\s+$/u, ""));
  return { svg, lines, look: { ramp: ramp?.name ?? "plain", hue: Math.round(((hue % 360) + 360) % 360), light, banded: Boolean(band), version: COVER_VERSION } };
}

/**
 * The cover of the made track in `folder` as SVG text, or null when the folder holds no receipt.
 * A track made before receipts kept its loudness is measured from its audio while it still has some.
 */
export async function trackFolderCover(folder) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path.join(folder, "receipt.json"), "utf8"));
  } catch {
    return null;
  }
  const loudness = Array.isArray(receipt?.audio?.loudness) ? null
    : await readLoudness(path.join(folder, "track.wav")).catch(() => null);
  return drawCover(receipt, loudness ? { loudness } : {}).svg;
}
