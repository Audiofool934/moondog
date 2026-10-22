// The colours of the cover that is playing, spread through the window as faint light. A cover is read
// at 24 by 24 pixels; its strongest distinct hues become three soft fields that drift into place when
// the song changes. Cover servers allow this read (Spotify's and Apple's send CORS headers).
const SIZE = 24;
const cache = new Map();

/** Up to three of a cover's colours as { h, s, l } (hue in degrees, the rest 0 to 1), or null. */
export function coverPalette(src) {
  if (!src) return Promise.resolve(null);
  if (!cache.has(src)) {
    cache.set(src, new Promise((resolve) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.decoding = "async";
      image.addEventListener("load", () => { try { resolve(paletteOf(image)); } catch { resolve(null); } }, { once: true });
      image.addEventListener("error", () => resolve(null), { once: true });
      image.src = src;
    }));
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  return cache.get(src);
}

function hsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function paletteOf(image) {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, SIZE, SIZE);
  const { data } = context.getImageData(0, 0, SIZE, SIZE);
  // Twelve hues, each a weighted sum: vivid, mid-light pixels count most; greys and near-blacks barely.
  const buckets = Array.from({ length: 12 }, () => ({ r: 0, g: 0, b: 0, weight: 0 }));
  let grey = 0;
  let count = 0;
  for (let at = 0; at < data.length; at += 4) {
    const [r, g, b] = [data[at] / 255, data[at + 1] / 255, data[at + 2] / 255];
    const { h, s, l } = hsl(r, g, b);
    grey += l;
    count += 1;
    const weight = s ** 1.4 * Math.max(0, 1 - Math.abs(l - 0.5) * 1.6);
    if (weight < 0.02) continue;
    const bucket = buckets[Math.floor(h / 30) % 12];
    bucket.r += r * weight; bucket.g += g * weight; bucket.b += b * weight; bucket.weight += weight;
  }
  const ranked = buckets.filter((bucket) => bucket.weight > 0).sort((a, b) => b.weight - a.weight);
  const total = ranked.reduce((sum, bucket) => sum + bucket.weight, 0);
  const picked = [];
  for (const bucket of ranked) {
    if (bucket.weight < total * 0.06) break;
    const colour = hsl(bucket.r / bucket.weight, bucket.g / bucket.weight, bucket.b / bucket.weight);
    // Neighbouring hues would read as one colour; each field gets its own.
    if (picked.some((other) => Math.min(Math.abs(other.h - colour.h), 360 - Math.abs(other.h - colour.h)) < 28)) continue;
    picked.push(colour);
    if (picked.length === 3) break;
  }
  // A black-and-white cover still lights the window, in its own grey.
  if (!picked.length) picked.push({ h: 0, s: 0, l: grey / count });
  while (picked.length < 3) picked.push({ ...picked[picked.length - 1], h: (picked[picked.length - 1].h + 18) % 360 });
  return picked;
}

/**
 * The three fields as CSS colours for a light or dark window: pale and soft on paper, deeper at
 * night, always far too faint to compete with the words.
 */
export function moodColours(palette, dark) {
  if (!palette) return ["transparent", "transparent", "transparent"];
  const strength = dark ? [0.34, 0.24, 0.16] : [0.3, 0.22, 0.15];
  return palette.map(({ h, s, l }, index) => {
    const saturation = Math.min(s, 0.62) * (dark ? 0.9 : 0.85) * 100;
    const lightness = (dark ? 0.3 + l * 0.22 : 0.64 + l * 0.18) * 100;
    return `hsl(${h.toFixed(0)} ${saturation.toFixed(0)}% ${lightness.toFixed(0)}% / ${strength[index]})`;
  });
}
