#!/usr/bin/env node

// Writes the logo's geometry for the iPhone app, which draws the record itself from these numbers
// (Moondog/Logo.swift). The numbers come from src/surfaces/brand/logo.mjs; change them there, then
// run this script. Coordinates are in record radii, with the record's center at 0,0.
//
//   npm run logo

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logoFigure } from "../../src/surfaces/brand/logo.mjs";

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
