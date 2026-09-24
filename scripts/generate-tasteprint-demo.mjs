#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
const demoDirectory = path.join(repositoryRoot, "assets", "demo");
const outputPath = path.join(demoDirectory, "moondog-tasteprint-demo.html");
const cardOutputPath = path.join(
  demoDirectory,
  "moondog-tasteprint-card-demo.html",
);

const profile = createPublicTasteprintDemoProfile();
const profileText = JSON.stringify(profile);
const forbiddenProfilePatterns = [
  { id: "evidence identifier", pattern: /evidence[_-]?id/iu },
  { id: "track reference", pattern: /track[_-]?ref/iu },
  { id: "subject identifier", pattern: /subject[_-]?id/iu },
  { id: "user path", pattern: /\/Users\/|[A-Za-z]:\\Users\\/u },
  { id: "provider URI", pattern: /spotify:(?:track|album|artist|playlist):/iu },
  {
    id: "credential field",
    pattern:
      /(?:access|refresh|client)[_-]?token|client[_-]?secret|authorization:\s*bearer/iu,
  },
];
for (const forbidden of forbiddenProfilePatterns) {
  if (forbidden.pattern.test(profileText)) {
    throw new Error(`Synthetic Tasteprint profile contains a forbidden ${forbidden.id}.`);
  }
}

const html = renderTasteprintHtml(profile, {
  generatedAt: PUBLIC_TASTEPRINT_DEMO_GENERATED_AT,
  syntheticDemo: true,
});
const cardHtml = renderTasteprintCardHtml(profile, {
  generatedAt: PUBLIC_TASTEPRINT_DEMO_GENERATED_AT,
  syntheticDemo: true,
});
if (!html.includes("A fictional demo")) {
  throw new Error("Synthetic Tasteprint boundary is missing from the output.");
}
if (!cardHtml.includes("A fictional demo")) {
  throw new Error("Synthetic Tasteprint card boundary is missing from the output.");
}

await mkdir(demoDirectory, { recursive: true });
await writeFile(outputPath, html, "utf8");
await writeFile(cardOutputPath, cardHtml, "utf8");

process.stdout.write(
  `Generated synthetic Tasteprint HTML: ${path.relative(repositoryRoot, outputPath)}, sha256 ${createHash("sha256").update(html).digest("hex")}\nGenerated synthetic Tasteprint card: ${path.relative(repositoryRoot, cardOutputPath)}, sha256 ${createHash("sha256").update(cardHtml).digest("hex")}\n`,
);
