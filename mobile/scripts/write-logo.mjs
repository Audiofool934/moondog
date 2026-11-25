#!/usr/bin/env node

// Writes what the iPhone app draws its record from (Moondog/Logo.swift):
// - logo-figure.json, the small logo's geometry from src/surfaces/brand/logo.mjs, for the vector mark
//   in the bar. Coordinates are in record radii, with the record's center at 0,0.
// - record-dots.json, the lunar record as dots from src/surfaces/cli/terminal-art.mjs: every frame of
//   its turn and its arm at each step of a swing, on the grid the desktop window draws. Each dot holds
//   0 or the layer that inked it (1 grooves, 2 surface, 3 the dog and the arm), two bits a dot, base64.
// Change the drawing in those modules, then run this script.
//
//   npm run logo

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logoFigure } from "../../src/surfaces/brand/logo.mjs";
import { LOGO_MOTION_FRAMES, renderLunarRecordDots, renderTonearmDots } from "../../src/surfaces/cli/terminal-art.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { head, band, bandGap, gap, cup, grooves, halo, tonearm } = logoFigure();
const round = (value) => Math.round(value * 10000) / 10000;
const points = (list) => list.map(([x, y]) => [round(x), round(y)]);
const figure = {
  head: points(head),
  band: points(band),
  bandGap: points(bandGap),
  gap: round(gap),
  halo: round(halo),
  cup: Object.fromEntries(Object.entries(cup).map(([key, value]) => [key, Array.isArray(value) ? value.map(round) : round(value)])),
  grooves: grooves.map(([radius, width]) => [round(radius), round(width)]),
  tonearm: tonearm.map(points),
};
await writeFile(path.join(here, "..", "Moondog", "logo-figure.json"), `${JSON.stringify(figure)}\n`);

// A square grid of dots, four rows to a terminal row, about two points apart on the phone, as the
// desktop keeps them two pixels apart.
const GRID = 120;
// Off the record the arm stands swung out 28 degrees, as on the desktop; SWINGS steps lead there.
const LIFTED = -28 / 180 * Math.PI;
const SWINGS = 24;
const pack = (dots) => {
  const bytes = new Uint8Array(Math.ceil(dots.length / 4));
  dots.forEach((layer, at) => { bytes[at >> 2] |= (layer & 3) << ((at & 3) * 2); });
  return Buffer.from(bytes).toString("base64");
};
const size = { columns: GRID / 2, rows: GRID / 4 };
const first = renderLunarRecordDots({ ...size, phase: 0, tonearm: false });
const record = {
  width: first.width,
  height: first.height,
  center: [round(first.centerX), round(first.centerY)],
  radius: round(first.radius),
  lifted: round(LIFTED),
  frames: Array.from({ length: LOGO_MOTION_FRAMES }, (_, phase) => pack(renderLunarRecordDots({ ...size, phase, tonearm: false }).dots)),
  arm: Array.from({ length: SWINGS + 1 }, (_, step) => pack(renderTonearmDots({ ...size, phase: 0, swing: LIFTED * step / SWINGS }).dots)),
};
await writeFile(path.join(here, "..", "Moondog", "record-dots.json"), `${JSON.stringify(record)}\n`);
