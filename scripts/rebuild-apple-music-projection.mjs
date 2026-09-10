#!/usr/bin/env node

import { repositoryRoot } from "./contract-lib.mjs";
import { defaultAppleMusicImportsRoot } from "../src/core/apple-library-source-status.mjs";
import {
  AppleMusicImportError,
  defaultAppleMusicProjectionPath,
  rebuildAppleMusicSqliteProjection,
} from "../src/importers/apple-music-library/index.mjs";
import { isUuid } from "../src/importers/apple-music-library/stable-ids.mjs";

const usage = `Usage:
  npm run rebuild:apple-projection [-- --subject-id <uuid>]

Rebuilds the private disposable SQLite projection from verified Apple import batches.
Without an override, every verified batch must belong to one consistent subject.`;

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    if (argument !== "--subject-id") {
      throw new AppleMusicImportError(
        "cli_argument_invalid",
        "Projection rebuild contains an unknown argument",
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new AppleMusicImportError(
        "cli_argument_value_missing",
        "Projection rebuild argument value is missing",
      );
    }
    values.subjectId = value;
    index += 1;
  }
  return values;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (options.subjectId !== undefined && !isUuid(options.subjectId)) {
    throw new AppleMusicImportError(
      "cli_subject_invalid",
      "Projection rebuild subject override must be a valid UUID",
    );
  }
  const databasePath = defaultAppleMusicProjectionPath;
  const result = await rebuildAppleMusicSqliteProjection({
    importsRoot: defaultAppleMusicImportsRoot,
    databasePath,
    boundaryRoot: repositoryRoot,
    subjectId: options.subjectId,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        status: result.status,
        logical_digest: result.logical_digest,
        counts: result.counts,
        source_timestamp: result.source_timestamp,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  const code =
    error instanceof AppleMusicImportError ? error.code : "unexpected_error";
  const message =
    error instanceof AppleMusicImportError
      ? error.message
      : "Apple projection rebuild failed unexpectedly";
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: { code, message } }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
