#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  AppleMusicImportError,
  importAppleMusicLibraryFile,
  inspectAppleMusicLibraryFile,
} from "../src/importers/apple-music-library/index.mjs";
import { readAppleMusicSourceStatus, resolveAppleMusicImportsRoot } from "../src/core/apple-library-source-status.mjs";
import { migrateLegacyAppleMusicData } from "../src/core/apple-data-migration.mjs";
import { resolveAppleMusicSubjectId } from "../src/core/apple-projection-domain-services.mjs";
import { openListeningHistoryStore } from "../src/profile/listening-history-store.mjs";

const usage = `Usage:
  npm run inspect:apple-library -- --input /path/to/Library.xml
  npm run import:apple-library -- --input /path/to/Library.xml [--subject-id <uuid>]

The inspect command never writes files.
The import command writes a private batch into Moondog's local state directory.`;

function parseArguments(argv) {
  const [mode, ...args] = argv;
  if (!new Set(["inspect", "import"]).has(mode)) {
    throw new AppleMusicImportError("cli_mode_invalid", "CLI mode is invalid");
  }

  const values = { mode };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    if (!new Set(["--input", "--subject-id"]).has(argument)) {
      throw new AppleMusicImportError(
        "cli_argument_invalid",
        "CLI contains an unknown argument",
      );
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new AppleMusicImportError(
        "cli_argument_value_missing",
        "CLI argument value is missing",
      );
    }
    if (argument === "--input") values.input = value;
    if (argument === "--subject-id") values.subjectId = value;
    index += 1;
  }
  return values;
}

function safeImportSummary(result) {
  return {
    ok: true,
    mode: "import",
    status: result.status,
    import_batch_id: result.manifest.import_batch_id,
    output_directory: path.posix.join("apple-music-library/imports", result.batchDirectoryName),
    counts: result.manifest.counts,
    semantics: result.manifest.semantics,
  };
}

async function existingAppleSubjectId() {
  const source = await readAppleMusicSourceStatus();
  if (source.state === "missing") return null;
  if (source.state === "invalid") {
    throw new AppleMusicImportError(
      "cli_subject_source_invalid",
      "The existing Apple Music import source is invalid",
    );
  }
  try {
    return await resolveAppleMusicSubjectId();
  } catch (cause) {
    throw new AppleMusicImportError(
      "cli_subject_source_invalid",
      "The existing Apple Music subject could not be resolved",
      { cause },
    );
  }
}

async function resolveImportSubject(explicitSubjectId) {
  const appleSubjectId = await existingAppleSubjectId();
  if (
    explicitSubjectId &&
    appleSubjectId &&
    explicitSubjectId.toLowerCase() !== appleSubjectId
  ) {
    throw new AppleMusicImportError(
      "cli_subject_mismatch",
      "The subject override does not match existing Apple Music imports",
    );
  }
  const store = await openListeningHistoryStore();
  try {
    return store.localSubjectId({
      ...(explicitSubjectId || appleSubjectId
        ? { preferredSubjectId: explicitSubjectId ?? appleSubjectId }
        : {}),
      create: true,
    });
  } catch (cause) {
    throw new AppleMusicImportError(
      "cli_subject_mismatch",
      "The Apple Music import does not match the trusted local music subject",
      { cause },
    );
  } finally {
    store.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!options.input) {
    throw new AppleMusicImportError(
      "cli_input_required",
      "The --input argument is required",
    );
  }

  if (options.mode === "inspect") {
    if (options.subjectId) {
      throw new AppleMusicImportError(
        "cli_argument_invalid",
        "Inspect mode does not accept --subject-id",
      );
    }
    const summary = await inspectAppleMusicLibraryFile(options.input);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  await migrateLegacyAppleMusicData();
  const subjectId = await resolveImportSubject(options.subjectId);
  const outputRoot = resolveAppleMusicImportsRoot();
  const outputBoundary = path.dirname(outputRoot);
  await mkdir(outputBoundary, { recursive: true, mode: 0o700 });
  const result = await importAppleMusicLibraryFile(options.input, {
    subjectId,
    outputRoot,
    outputBoundary,
  });
  process.stdout.write(`${JSON.stringify(safeImportSummary(result), null, 2)}\n`);
}

main().catch((error) => {
  const code =
    error instanceof AppleMusicImportError ? error.code : "unexpected_error";
  const message =
    error instanceof AppleMusicImportError
      ? error.message
      : "Apple Music import failed unexpectedly";
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: { code, message } }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
