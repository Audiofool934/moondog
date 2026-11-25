#!/usr/bin/env node

// Writes Moondog's logo files from src/surfaces/brand/logo.mjs: the logo and its small version as
// SVG, the Mac and iPhone app icons, the iPhone's Dynamic Island mark, and the project page's icon and link preview. Headless Chrome draws the
// PNGs, as it draws the README's screenshots; set MOONDOG_CAPTURE_BROWSER to use another Chrome.
//
//   node scripts/generate-logo.mjs

import { spawn } from "node:child_process";
import { access, constants, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { appIconSvg, logoSvg } from "../src/surfaces/brand/logo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "assets", "brand");
const site = path.join(root, "site", "static");
const iphoneIcons = path.join(root, "mobile", "Moondog", "Assets.xcassets", "AppIcon.appiconset");
const islandMark = path.join(root, "mobile", "MoondogActivity", "Assets.xcassets", "Mark.imageset", "mark.png");
const INK = "#141414";

const logo = logoSvg({ standalone: true });
const small = logoSvg({ small: true, standalone: true });
const files = {
  [path.join(brand, "moondog-logo.svg")]: logo,
  [path.join(brand, "moondog-logo-small.svg")]: small,
  [path.join(brand, "moondog-app-icon.svg")]: appIconSvg(),
  [path.join(brand, "moondog-app-icon-dark.svg")]: appIconSvg({ dark: true }),
  [path.join(site, "moondog-logo.svg")]: logo,
  [path.join(site, "moondog-logo-small.svg")]: small,
};
// The iPhone icon fills its square, and iOS rounds the corners; the logo keeps the Mac tile's proportions.
const iphoneIconSvg = ({ dark = false } = {}) => {
  const [tile, ink] = dark ? ["#151515", "#f2f2f2"] : ["#ffffff", "#141414"];
  const id = dark ? "moondog-iphone-dark" : "moondog-iphone";
  const art = logoSvg({ ink, id, reach: 340, line: 1.8 }).replace(/^<svg[^>]*>/u, "").replace(/<\/svg>$/u, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${tile}"/>`
    + `<g transform="translate(512 512) scale(0.9) translate(-512 -512)">${art}</g></svg>`;
};
// Each PNG: the page that draws it, its size, and whether it keeps a transparent background. Chrome may lay
// out a small window wider than it shoots, so a picture that fills its window sits in the corner, not the middle.
const page = (body, background = "transparent", { corner = false } = {}) => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:${background}}
body{${corner ? "display:block" : "display:grid;place-items:center;width:100vw;height:100vh"}}svg{display:block}</style>${body}`;
const sized = (svg, width) => svg.replace("<svg ", `<svg width="${width}" height="${width}" `);
const images = [
  { file: path.join(brand, "moondog-app-icon.png"), size: [1024, 1024], html: page(sized(appIconSvg(), 1024)) },
  { file: path.join(brand, "moondog-app-icon-dark.png"), size: [1024, 1024], html: page(sized(appIconSvg({ dark: true }), 1024)) },
  { file: path.join(iphoneIcons, "icon.png"), size: [1024, 1024], html: page(sized(iphoneIconSvg(), 1024)), opaque: true },
  { file: path.join(iphoneIcons, "icon-dark.png"), size: [1024, 1024], html: page(sized(iphoneIconSvg({ dark: true }), 1024)), opaque: true },
  // The small logo for the Live Activity, a template the island and the Lock Screen tint, at three times 32 points.
  { file: islandMark, size: [96, 96], html: page(sized(logoSvg({ small: true, ink: INK }), 96), "transparent", { corner: true }) },
  { file: path.join(site, "favicon-64.png"), size: [64, 64], html: page(sized(logoSvg({ small: true, ink: INK }), 64)) },
  // The link preview: the logo on white, at the size link previews ask for.
  { file: path.join(site, "moondog-og.png"), size: [1200, 630], html: page(sized(logoSvg({ ink: INK }), 560), "#ffffff"), opaque: true },
];

async function executable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveBrowser() {
  if (process.env.MOONDOG_CAPTURE_BROWSER) return path.resolve(process.env.MOONDOG_CAPTURE_BROWSER);
  for (const candidate of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error("A Chrome or Chromium executable is required. Set MOONDOG_CAPTURE_BROWSER to its path.");
}

/** Headless Chrome writes the file but may not exit, so wait for the file and stop it. */
async function screenshot({ browser, url, outputPath, size: [width, height], opaque, profile }) {
  await rm(outputPath, { force: true });
  const child = spawn(browser, [
    "--headless=new", "--disable-gpu", "--disable-extensions", "--disable-background-networking",
    "--disable-sync", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    "--force-device-scale-factor=1", `--window-size=${width},${height}`, ...(opaque ? [] : ["--default-background-color=00000000"]),
    "--virtual-time-budget=1000", `--user-data-dir=${profile}`, `--screenshot=${outputPath}`, url,
  ], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const written = await stat(outputPath).then((info) => info.size > 0, () => false);
      if (written) return;
      await delay(100);
    }
    throw new Error(`Chrome did not write ${path.relative(root, outputPath)}.`);
  } finally {
    child.kill();
    await exited;
  }
}

for (const [file, svg] of Object.entries(files)) await writeFile(file, `${svg}\n`);
const browser = await resolveBrowser();
const work = await mkdtemp(path.join(tmpdir(), "moondog-logo-"));
try {
  for (const [index, image] of images.entries()) {
    const html = path.join(work, `${index}.html`);
    await writeFile(html, image.html);
    await screenshot({ browser, url: pathToFileURL(html).href, outputPath: image.file, size: image.size, opaque: image.opaque, profile: path.join(work, "profile") });
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
const written = [...Object.keys(files), ...images.map(({ file }) => file)];
process.stdout.write(`Wrote ${written.map((file) => path.relative(root, file)).join(", ")}.\n`);
