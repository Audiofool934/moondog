#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicTasteprintDemoProfile,
  PUBLIC_TASTEPRINT_DEMO_GENERATED_AT,
} from "../src/demo/moondog-tasteprint-demo.mjs";
import {
  renderTasteprintCardHtml,
  renderTasteprintHtml,
} from "../src/surfaces/html/tasteprint.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const tapePath = path.join(
  repositoryRoot,
  "assets",
  "demo",
  "moondog-offline-demo.tape",
);
const gifPath = path.join(
  repositoryRoot,
  "assets",
  "demo",
  "moondog-offline-demo.gif",
);
const studioTourGifPath = path.join(
  repositoryRoot,
  "assets",
  "demo",
  "moondog-studio-tour.gif",
);
const tasteprintHtmlPath = path.join(
  repositoryRoot,
  "assets",
  "demo",
  "moondog-tasteprint-demo.html",
);
const tasteprintPngPath = path.join(
  repositoryRoot,
  "assets",
  "demo",
  "moondog-tasteprint-preview.png",
);
const timeMachinePngPath = path.join(
  repositoryRoot,
  "assets",
  "demo",
  "moondog-time-machine-preview.png",
);
const listeningPatternsPngPath = path.join(
  repositoryRoot,
  "assets",
  "demo",
  "moondog-listening-patterns-preview.png",
);
const tasteprintCardHtmlPath = path.join(
  repositoryRoot,
  "assets",
  "demo",
  "moondog-tasteprint-card-demo.html",
);
const tasteprintCardPngPath = path.join(
  repositoryRoot,
  "assets",
  "demo",
  "moondog-tasteprint-card-preview.png",
);

function requireExact(text, expected, label) {
  const occurrences = text.split(expected).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${label} must appear exactly once in the demo tape.`);
  }
}

function skipGifSubBlocks(buffer, initialOffset) {
  let offset = initialOffset;
  while (offset < buffer.length) {
    const length = buffer[offset];
    offset += 1;
    if (length === 0) return offset;
    if (offset + length > buffer.length) {
      throw new Error("The demo GIF contains a truncated data block.");
    }
    offset += length;
  }
  throw new Error("The demo GIF contains an unterminated data block.");
}

function gifMetadata(buffer) {
  if (buffer.length < 10) throw new Error("The demo GIF is truncated.");
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (!new Set(["GIF87a", "GIF89a"]).has(signature)) {
    throw new Error("The demo media is not a GIF file.");
  }
  if (buffer.length < 13) throw new Error("The demo GIF has no screen descriptor.");
  let offset = 13;
  const globalColorTable = (buffer[10] & 0x80) !== 0;
  if (globalColorTable) {
    offset += 3 * 2 ** ((buffer[10] & 0x07) + 1);
  }
  let frames = 0;
  let trailer = false;
  while (offset < buffer.length) {
    const marker = buffer[offset];
    if (marker === 0x3b) {
      trailer = true;
      offset += 1;
      break;
    }
    if (marker === 0x21) {
      if (offset + 2 > buffer.length) {
        throw new Error("The demo GIF contains a truncated extension.");
      }
      offset = skipGifSubBlocks(buffer, offset + 2);
      continue;
    }
    if (marker !== 0x2c || offset + 10 > buffer.length) {
      throw new Error("The demo GIF contains an invalid image block.");
    }
    const localColorTable = (buffer[offset + 9] & 0x80) !== 0;
    const localColorTableBytes = localColorTable
      ? 3 * 2 ** ((buffer[offset + 9] & 0x07) + 1)
      : 0;
    offset += 10 + localColorTableBytes;
    if (offset >= buffer.length) {
      throw new Error("The demo GIF contains a truncated image block.");
    }
    offset = skipGifSubBlocks(buffer, offset + 1);
    frames += 1;
  }
  if (!trailer || offset !== buffer.length || frames === 0) {
    throw new Error("The demo GIF structure is incomplete.");
  }
  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
    frames,
  };
}

function pngDimensions(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("The Tasteprint preview is not a PNG file.");
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("The Tasteprint preview has no PNG IHDR header.");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

const tape = await readFile(tapePath, "utf8");
requireExact(
  tape,
  "Output assets/demo/moondog-offline-demo.gif",
  "Expected GIF output",
);
requireExact(
  tape,
  'Type "npm run --silent demo"',
  "Deterministic offline demo command",
);
requireExact(tape, "Set Width 1240", "Expected terminal width");
requireExact(tape, "Set Height 840", "Expected terminal height");

const forbiddenTapePatterns = [
  { id: "macOS user path", pattern: /\/Users\//u },
  { id: "Windows user path", pattern: /[A-Za-z]:\\Users\\/u },
  { id: "file URL", pattern: /file:\/\//iu },
  {
    id: "credential field",
    pattern: /(?:access|refresh|client)[_-]?token|client[_-]?secret|authorization:\s*bearer/iu,
  },
  { id: "Spotify provider URI", pattern: /spotify:(?:track|album|artist|playlist):/iu },
];
for (const forbidden of forbiddenTapePatterns) {
  if (forbidden.pattern.test(tape)) {
    throw new Error(`Demo tape contains a forbidden ${forbidden.id}.`);
  }
}

const gif = await readFile(gifPath);
const dimensions = gifMetadata(gif);
if (dimensions.width !== 1240 || dimensions.height !== 840) {
  throw new Error(
    `Demo GIF must be 1240x840, observed ${dimensions.width}x${dimensions.height}.`,
  );
}
const minimumBytes = 100 * 1024;
const maximumBytes = 5 * 1024 * 1024;
if (gif.length < minimumBytes || gif.length > maximumBytes) {
  throw new Error(
    `Demo GIF must remain between 100 KiB and 5 MiB, observed ${gif.length} bytes.`,
  );
}

const studioTourGif = await readFile(studioTourGifPath);
const studioTourMetadata = gifMetadata(studioTourGif);
if (
  studioTourMetadata.width !== 1240 ||
  studioTourMetadata.height !== 840 ||
  studioTourMetadata.frames !== 7
) {
  throw new Error(
    `Studio tour GIF must be 1240x840 with 7 frames, observed ${studioTourMetadata.width}x${studioTourMetadata.height} with ${studioTourMetadata.frames} frames.`,
  );
}
const studioTourMinimumBytes = 100 * 1024;
const studioTourMaximumBytes = 2 * 1024 * 1024;
if (
  studioTourGif.length < studioTourMinimumBytes ||
  studioTourGif.length > studioTourMaximumBytes
) {
  throw new Error(
    `Studio tour GIF must remain between 100 KiB and 2 MiB, observed ${studioTourGif.length} bytes.`,
  );
}

const tasteprintHtml = await readFile(tasteprintHtmlPath, "utf8");
const expectedTasteprintHtml = renderTasteprintHtml(
  createPublicTasteprintDemoProfile(),
  {
    generatedAt: PUBLIC_TASTEPRINT_DEMO_GENERATED_AT,
    syntheticDemo: true,
  },
);
if (tasteprintHtml !== expectedTasteprintHtml) {
  throw new Error(
    "The synthetic Tasteprint HTML does not match its deterministic source profile.",
  );
}
for (const expected of [
  "Synthetic public demo",
  "Fictional public profile",
  "Every artist, track, and aggregate on this page is fictional demonstration data.",
  "Listening through time",
  "Listening Time Machine",
  'id="time-machine"',
  "chronological landmarks",
  "4 of 4 retained years have landmarks",
  "strongest retained year",
  "at least 2 engaged plays and 5 listening minutes",
  "UTC year",
  "first appearance in retained history",
  "Listening Pulse",
  "36 active retained months",
  "A blank cell means no eligible retained event appears in that UTC month, not proof that no listening occurred.",
  "Music that came back",
  "Gaps of at least 180 days",
  "not proof of liking, nostalgia, or an intentional absence",
  "Played back to back",
  "At least 2 adjacent plays",
  "30 seconds played per event",
  "does not prove repeat mode, intention, or liking",
  "What stayed. What changed.",
  "Artists across eras",
  "Year-to-year turnover",
  "4 active years across 2023-2026",
  "50% carried forward",
  "Fictional archive preview",
  "The shape of a listening stretch",
  "2,500 listening stretches",
  "42% contain 5 or more plays",
  "Records explored in depth",
  "11 distinct tracks",
]) {
  if (!tasteprintHtml.includes(expected)) {
    throw new Error(`Synthetic Tasteprint HTML is missing: ${expected}`);
  }
}
const forbiddenTasteprintPatterns = [
  { id: "script", pattern: /<script/iu },
  { id: "external URL", pattern: /https?:\/\//iu },
  { id: "evidence identifier", pattern: /evidence[_-]?id/iu },
  { id: "track reference", pattern: /track[_-]?ref/iu },
  { id: "subject identifier", pattern: /subject[_-]?id/iu },
  { id: "macOS user path", pattern: /\/Users\//u },
  { id: "Windows user path", pattern: /[A-Za-z]:\\Users\\/u },
  { id: "provider URI", pattern: /spotify:(?:track|album|artist|playlist):/iu },
  {
    id: "credential field",
    pattern:
      /(?:access|refresh|client)[_-]?token|client[_-]?secret|authorization:\s*bearer/iu,
  },
];
for (const forbidden of forbiddenTasteprintPatterns) {
  if (forbidden.pattern.test(tasteprintHtml)) {
    throw new Error(`Synthetic Tasteprint HTML contains a forbidden ${forbidden.id}.`);
  }
}
const studioTourBinaryText = studioTourGif.toString("latin1");
for (const forbidden of forbiddenTasteprintPatterns.slice(3)) {
  if (forbidden.pattern.test(studioTourBinaryText)) {
    throw new Error(`Studio tour GIF contains a forbidden ${forbidden.id}.`);
  }
}

const tasteprintCardHtml = await readFile(tasteprintCardHtmlPath, "utf8");
const expectedTasteprintCardHtml = renderTasteprintCardHtml(
  createPublicTasteprintDemoProfile(),
  {
    generatedAt: PUBLIC_TASTEPRINT_DEMO_GENERATED_AT,
    syntheticDemo: true,
  },
);
if (tasteprintCardHtml !== expectedTasteprintCardHtml) {
  throw new Error(
    "The synthetic Tasteprint card HTML does not match its deterministic source profile.",
  );
}
for (const expected of [
  'data-artifact="moondog-tasteprint-card/1"',
  "Synthetic public demo",
  "Fictional public profile",
  "Every artist, track, date, and aggregate on this card is fictional demonstration data.",
  "The artists that stay",
  "Recent movement",
  "Tracks you revisit",
]) {
  if (!tasteprintCardHtml.includes(expected)) {
    throw new Error(`Synthetic Tasteprint card HTML is missing: ${expected}`);
  }
}
for (const forbidden of forbiddenTasteprintPatterns) {
  if (forbidden.pattern.test(tasteprintCardHtml)) {
    throw new Error(
      `Synthetic Tasteprint card HTML contains a forbidden ${forbidden.id}.`,
    );
  }
}

const tasteprintPng = await readFile(tasteprintPngPath);
const tasteprintDimensions = pngDimensions(tasteprintPng);
if (tasteprintDimensions.width !== 1240 || tasteprintDimensions.height !== 840) {
  throw new Error(
    `Tasteprint preview must be 1240x840, observed ${tasteprintDimensions.width}x${tasteprintDimensions.height}.`,
  );
}
const tasteprintMinimumBytes = 40 * 1024;
const tasteprintMaximumBytes = 2 * 1024 * 1024;
if (
  tasteprintPng.length < tasteprintMinimumBytes ||
  tasteprintPng.length > tasteprintMaximumBytes
) {
  throw new Error(
    `Tasteprint preview must remain between 40 KiB and 2 MiB, observed ${tasteprintPng.length} bytes.`,
  );
}
const tasteprintBinaryText = tasteprintPng.toString("latin1");
for (const forbidden of forbiddenTasteprintPatterns.slice(3)) {
  if (forbidden.pattern.test(tasteprintBinaryText)) {
    throw new Error(`Tasteprint PNG contains a forbidden ${forbidden.id}.`);
  }
}

const timeMachinePng = await readFile(timeMachinePngPath);
const timeMachineDimensions = pngDimensions(timeMachinePng);
if (
  timeMachineDimensions.width !== 1240 ||
  timeMachineDimensions.height !== 840
) {
  throw new Error(
    `Time Machine preview must be 1240x840, observed ${timeMachineDimensions.width}x${timeMachineDimensions.height}.`,
  );
}
if (
  timeMachinePng.length < tasteprintMinimumBytes ||
  timeMachinePng.length > tasteprintMaximumBytes
) {
  throw new Error(
    `Time Machine preview must remain between 40 KiB and 2 MiB, observed ${timeMachinePng.length} bytes.`,
  );
}
const timeMachineBinaryText = timeMachinePng.toString("latin1");
for (const forbidden of forbiddenTasteprintPatterns.slice(3)) {
  if (forbidden.pattern.test(timeMachineBinaryText)) {
    throw new Error(
      `Time Machine PNG contains a forbidden ${forbidden.id}.`,
    );
  }
}

const listeningPatternsPng = await readFile(listeningPatternsPngPath);
const listeningPatternsDimensions = pngDimensions(listeningPatternsPng);
if (
  listeningPatternsDimensions.width !== 1240 ||
  listeningPatternsDimensions.height !== 840
) {
  throw new Error(
    `Listening patterns preview must be 1240x840, observed ${listeningPatternsDimensions.width}x${listeningPatternsDimensions.height}.`,
  );
}
if (
  listeningPatternsPng.length < tasteprintMinimumBytes ||
  listeningPatternsPng.length > tasteprintMaximumBytes
) {
  throw new Error(
    `Listening patterns preview must remain between 40 KiB and 2 MiB, observed ${listeningPatternsPng.length} bytes.`,
  );
}
const listeningPatternsBinaryText = listeningPatternsPng.toString("latin1");
for (const forbidden of forbiddenTasteprintPatterns.slice(3)) {
  if (forbidden.pattern.test(listeningPatternsBinaryText)) {
    throw new Error(
      `Listening patterns PNG contains a forbidden ${forbidden.id}.`,
    );
  }
}

const tasteprintCardPng = await readFile(tasteprintCardPngPath);
const tasteprintCardDimensions = pngDimensions(tasteprintCardPng);
if (
  tasteprintCardDimensions.width !== 1240 ||
  tasteprintCardDimensions.height !== 840
) {
  throw new Error(
    `Tasteprint card preview must be 1240x840, observed ${tasteprintCardDimensions.width}x${tasteprintCardDimensions.height}.`,
  );
}
if (
  tasteprintCardPng.length < tasteprintMinimumBytes ||
  tasteprintCardPng.length > tasteprintMaximumBytes
) {
  throw new Error(
    `Tasteprint card preview must remain between 40 KiB and 2 MiB, observed ${tasteprintCardPng.length} bytes.`,
  );
}
const tasteprintCardBinaryText = tasteprintCardPng.toString("latin1");
for (const forbidden of forbiddenTasteprintPatterns.slice(3)) {
  if (forbidden.pattern.test(tasteprintCardBinaryText)) {
    throw new Error(
      `Tasteprint card PNG contains a forbidden ${forbidden.id}.`,
    );
  }
}

process.stdout.write(
  `Verified demo media: terminal GIF ${dimensions.width}x${dimensions.height}, synthetic Studio tour GIF ${studioTourMetadata.width}x${studioTourMetadata.height} with ${studioTourMetadata.frames} frames, synthetic Tasteprint PNG ${tasteprintDimensions.width}x${tasteprintDimensions.height}, synthetic Time Machine PNG ${timeMachineDimensions.width}x${timeMachineDimensions.height}, synthetic listening patterns PNG ${listeningPatternsDimensions.width}x${listeningPatternsDimensions.height}, synthetic Tasteprint card PNG ${tasteprintCardDimensions.width}x${tasteprintCardDimensions.height}, deterministic public sources with Listening Arc, Listening Time Machine, Listening Pulse, Listening Seasons, Music that came back, Played back to back, continuity and change, approximate sessions, and release depth.\n`,
);
