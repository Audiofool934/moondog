#!/usr/bin/env node

// Writes the model makers' marks the composer's model button shows (Moondog/RoomView.swift) from the
// desktop window's own symbols (app/renderer/index.html): Simple Icons (CC0) and Lobe Icons 1.98.0
// (MIT License, LobeHub), and the window's model glyph for a maker without one. Each becomes a
// template image in Moondog/Assets.xcassets, so it takes the ink's colour as the desktop's does.
// Change a mark in the window, then run this script.
//
//   npm run marks

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const page = await readFile(path.join(here, "../../app/renderer/index.html"), "utf8");
const assets = path.join(here, "../Moondog/Assets.xcassets");
const MARKS = ["claude", "openai", "gemini", "deepseek", "kimi", "grok", "zai", "openrouter", "model"];

for (const name of MARKS) {
  const symbol = new RegExp(`<symbol id="i-${name}" viewBox="([^"]+)">([\\s\\S]*?)</symbol>`, "u").exec(page);
  if (!symbol) throw new Error(`The window has no i-${name} symbol.`);
  const folder = path.join(assets, `mark-${name}.imageset`);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${name}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${symbol[1]}" fill="#000">${symbol[2]}</svg>\n`);
  await writeFile(path.join(folder, "Contents.json"), `${JSON.stringify({
    images: [{ filename: `${name}.svg`, idiom: "universal" }],
    info: { author: "xcode", version: 1 },
    properties: { "preserves-vector-representation": true, "template-rendering-intent": "template" },
  }, null, 2)}\n`);
}
console.log(`Wrote ${MARKS.length} marks to Moondog/Assets.xcassets.`);
