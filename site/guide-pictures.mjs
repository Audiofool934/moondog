// Draws the getting-started guide's pictures into static/guide/: the desktop app's real window on the
// harness's sample data (app/harness.mjs), in light and dark, as WebP. The last picture is the README's
// own, the page's scene with its made-up listener (assets/demo/).
//
//   node guide-pictures.mjs
//
// It needs app/'s dependencies (npm ci in app/) and cwebp (brew install webp). The pictures come out
// at the screen's pixel density, so draw them on a display that shows two pixels a point.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const app = path.join(root, "app");
const out = path.join(here, "static", "guide");
const themes = ["light", "dark"];

// Each picture: the harness state it shows, the window's size in points, how much of its height to
// keep, counted from the top, and a width in pixels to scale it to. A sheet sits in a window just
// larger than itself.
const pictures = [
  { name: "service", state: "first-run", size: "560x300" },
  { name: "model", state: "first-run-fresh", size: "560x440" },
  { name: "spotify", state: "settings-spotify-setup", size: "800x600" },
  { name: "import", state: "import-preview", size: "800x600", keep: 0.48 },
  { name: "taste", state: "taste", size: "1240x800" },
  // For a phone: the same page in a narrow window, where the record takes the width.
  { name: "taste-narrow", state: "taste", size: "600x800", width: 900 },
];

const webp = (from, to, crop = []) => run("cwebp", ["-quiet", "-q", "84", ...crop, from, "-o", to]);

const drawn = await mkdtemp(path.join(tmpdir(), "moondog-guide-pictures-"));
try {
  await run("cwebp", ["-version"]).catch(() => { throw new Error("cwebp is missing. Install it with: brew install webp"); });
  await mkdir(out, { recursive: true });
  await run(process.execPath, ["build.mjs"], { cwd: app });
  await run(path.join(app, "node_modules", ".bin", "electron"), ["harness.mjs"], {
    cwd: app,
    env: { ...process.env, MOONDOG_HARNESS_OUT: drawn, MOONDOG_HARNESS_THEMES: themes.join(","),
      MOONDOG_HARNESS_STATES: pictures.map(({ state, size }) => `${state}@${size}`).join(",") },
  });
  for (const theme of themes) {
    for (const { name, state, size, keep, width: scaled } of pictures) {
      const from = path.join(drawn, `${state}-${size}-${theme}.png`);
      const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", from]);
      const [width, height] = ["pixelWidth", "pixelHeight"].map((key) => Number(new RegExp(`${key}: (\\d+)`, "u").exec(stdout)[1]));
      const kept = keep ? Math.round(height * keep) : height;
      await webp(from, path.join(out, `${name}-${theme}.webp`),
        [...(keep ? ["-crop", "0", "0", String(width), String(kept)] : []), ...(scaled ? ["-resize", String(scaled), "0"] : [])]);
      console.log(`${name}-${theme}.webp ${scaled ?? width}x${scaled ? Math.round(kept * scaled / width) : kept}`);
    }
    await webp(path.join(root, "assets", "demo", `moondog-desktop-${theme}.png`), path.join(out, `room-${theme}.webp`));
    console.log(`room-${theme}.webp`);
  }
} finally {
  await rm(drawn, { recursive: true, force: true });
}
