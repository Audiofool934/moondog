#!/usr/bin/env node

import {
  MOONDOG_STUDIO_MAXIMUM_ARCHIVES,
  runMoondogStudio,
} from "../src/surfaces/web/studio.mjs";

const usage = `Usage:
  npm run demo:studio
  npm run demo:studio -- --from <spotify-history.zip> [--from <spotify-history.zip>]

Without --from, Moondog opens the fictional production-importer tour.
With one or two explicitly supplied ZIPs, it opens a session-only private profile without installing dependencies or writing persistent profile state.`;

function terminalText(value) {
  return String(value ?? "Unknown failure")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .slice(0, 1_000);
}

async function main() {
  const values = process.argv.slice(2);
  if (values.length === 1 && new Set(["--help", "-h"]).has(values[0])) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (values.length === 0) {
    await runMoondogStudio({ demoOnly: true });
    return;
  }

  const archivePaths = [];
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const archivePath = values[index + 1];
    if (
      option !== "--from" ||
      !archivePath ||
      archivePath.startsWith("--")
    ) {
      throw new Error(usage);
    }
    archivePaths.push(archivePath);
  }
  if (
    archivePaths.length < 1 ||
    archivePaths.length > MOONDOG_STUDIO_MAXIMUM_ARCHIVES
  ) {
    throw new Error(usage);
  }
  await runMoondogStudio({ archivePaths });
}

main().catch((error) => {
  process.stderr.write(`moondog demo studio: ${terminalText(error?.message)}\n`);
  process.exitCode = 1;
});
