#!/usr/bin/env node

import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MOONDOG_SHOWCASE_ROUTES } from "../src/surfaces/web/showcase.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const showcasePath = path.join(repositoryRoot, "showcase", "index.html");

function fail(message) {
  throw new Error(`Showcase verification failed: ${message}`);
}

function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function referencesFrom(html) {
  return [...html.matchAll(/\b(?:href|src)="([^"]+)"/gu)].map(
    (match) => match[1],
  );
}

const html = await readFile(showcasePath, "utf8");
for (const expected of [
  "Your listening history, made useful.",
  "Explore the Time Machine",
  "More than another stats dashboard.",
  "What stayed. What changed.",
  "Artists across eras",
  "Year-to-year turnover",
  "50% carried forward",
  "Some songs find their way back.",
  "Music that came back",
  "Quiet Coordinates",
  "421-day longest gap · 2 returns",
  "732-day gap · 1 return",
  "gap of at least 180 days",
  "Recurrence is not proof of liking, nostalgia, or intentional absence.",
  "The shape of a listening stretch.",
  "Approximate sessions",
  "2,500",
  "42%",
  "Records explored in depth",
  "Night Transit",
  "30-minute grouping is an approximation",
  "The question that started it.",
  "刘森最新的单曲是哪首？",
  "天长地久",
  "Captured 2026-09-03",
  "moondog catalog latest-single",
  "--artist 刘森",
  "--artist-page candidate-page",
  "--from spotify-history.zip",
  "The returned public page is name-checked before releases load.",
  "music.catalog.artist_search",
  "music.catalog.artist_identity",
  "Returned page can be selected",
  "local.history.hint",
  "Both ZIP commands above are inert showcase text and never read a ZIP.",
  "music.catalog.artist_releases",
  "One storefront, not every platform.",
  "Public music-world evidence stays separate from private listening evidence.",
  "The agent can show its work.",
  "Privacy is architecture",
  "The static showcase itself needs no dependency installation.",
  "npm install --ignore-scripts",
  "npm run studio --",
  "--from spotify-history.zip",
  "Session-only private profile",
  "Stopping Studio discards the in-memory profile and corrections.",
  "Tasteprint, Time Machine, historical-return, continuity, session-shape, and release-depth names, tracks, dates, and counts are fictional demonstration data.",
  "The dated catalog proof uses public Apple Music US metadata.",
  "No analytics, scripts, external fonts, or network resources.",
  'http-equiv="Content-Security-Policy"',
  "default-src 'none'",
  "img-src 'self'",
]) {
  if (!html.includes(expected)) fail(`showcase/index.html is missing ${expected}`);
}

const expectedReferences = [
  "../assets/brand/moondog-lunar-record/moondog-logo-1x1.png",
  "#top",
  "../assets/brand/moondog-lunar-record/moondog-logo-1x1.png",
  "#product",
  "#catalog",
  "#evidence",
  "#privacy",
  "../assets/demo/moondog-tasteprint-demo.html#time-machine",
  "#start",
  "../assets/demo/moondog-time-machine-preview.png",
  "../assets/demo/moondog-tasteprint-demo.html#tracks-that-stay",
  "../assets/demo/moondog-offline-demo.gif",
  "../assets/demo/moondog-tasteprint-card-demo.html",
  "../assets/demo/moondog-tasteprint-card-preview.png",
];
const references = referencesFrom(html);
if (!arraysEqual(references, expectedReferences)) {
  fail("showcase/index.html has an unexpected link or asset reference");
}

const forbiddenPatterns = [
  /<script\b/iu,
  /<iframe\b/iu,
  /<form\b/iu,
  /\bhttps?:\/\//iu,
  /file:\/\//iu,
  /\/Users\//u,
  /[A-Za-z]:\\Users\\/u,
  /(?:access|refresh)[_-]?token/iu,
  /client[_-]?secret/iu,
  /spotify:(?:track|artist|album|playlist):/iu,
];
if (forbiddenPatterns.some((pattern) => pattern.test(html))) {
  fail("showcase/index.html contains executable, remote, or private material");
}

const rootRealPath = await realpath(repositoryRoot);
const localReferences = references
  .filter((reference) => !reference.startsWith("#"))
  .map((reference) => reference.split("#", 1)[0]);
for (const reference of localReferences) {
  const absolutePath = path.resolve(path.dirname(showcasePath), reference);
  const absoluteRealPath = await realpath(absolutePath);
  const relativeRealPath = path.relative(rootRealPath, absoluteRealPath);
  if (
    !relativeRealPath ||
    relativeRealPath.startsWith("..") ||
    path.isAbsolute(relativeRealPath)
  ) {
    fail(`${reference} resolves outside the repository`);
  }
  const info = await stat(absoluteRealPath);
  if (!info.isFile() || info.size === 0) fail(`${reference} is not a non-empty file`);
}

const routePaths = new Set(
  MOONDOG_SHOWCASE_ROUTES.map((route) => route.relativePath),
);
const expectedRoutePaths = new Set([
  "showcase/index.html",
  ...localReferences.map((reference) =>
    path.relative(repositoryRoot, path.resolve(path.dirname(showcasePath), reference)),
  ),
]);
if (
  routePaths.size !== expectedRoutePaths.size ||
  [...routePaths].some((routePath) => !expectedRoutePaths.has(routePath))
) {
  fail("the loopback server allowlist and showcase references differ");
}

for (const relativePath of [
  "assets/demo/moondog-tasteprint-demo.html",
  "assets/demo/moondog-tasteprint-card-demo.html",
]) {
  const artifact = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  if (
    !artifact.includes("Synthetic") ||
    !artifact.includes("Fictional public profile") ||
    forbiddenPatterns.some((pattern) => pattern.test(artifact))
  ) {
    fail(`${relativePath} is not a self-contained fictional artifact`);
  }
}

process.stdout.write(
  `Verified local showcase: ${MOONDOG_SHOWCASE_ROUTES.length} allowlisted files, ${references.length} explicit page references, no scripts or remote resources.\n`,
);
