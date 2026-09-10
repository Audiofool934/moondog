#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createFirstRunUsabilityProtocol,
  createPublicFirstRunUsabilitySummary,
  summarizeFirstRunUsabilitySummary,
  validateFirstRunUsabilityProtocol,
  validateFirstRunUsabilitySession,
} from "../src/evaluation/first-run-usability.mjs";
import { renderFirstRunUsabilityForm } from "../src/evaluation/first-run-usability-form.mjs";
import {
  inspectFirstRunUsabilityDirectory,
  summarizeFirstRunUsabilityStatus,
} from "../src/evaluation/first-run-usability-status.mjs";

function usage() {
  return [
    "Usage:",
    "  npm run eval:usability -- create [--output-dir <dir>] [--json]",
    "  npm run eval:usability -- form --protocol <protocol.json> [--output <path>] [--json]",
    "  npm run eval:usability -- status [--input-dir <dir>] [--json]",
    "  npm run eval:usability -- validate --protocol <protocol.json> --session <completed-session.json> [--session <path>] [--json]",
    "  npm run eval:usability -- summarize --protocol <protocol.json> --session <completed-session.json> [--session <path>] [--output <path>] [--json]",
    "",
    "Use only built-in or Moondog-generated fictional music data during sessions.",
    "Protocols, forms, and completed sessions belong in the Git-ignored runs directory.",
    "Only the aggregate summary produced by summarize is designed for public use.",
  ].join("\n");
}

function parseArguments(argv) {
  const command = argv[0];
  if (!new Set(["create", "form", "status", "validate", "summarize", "help"]).has(command)) {
    throw new Error(usage());
  }
  const options = {
    command,
    inputDir: "runs",
    outputDir: "runs",
    output: null,
    protocol: null,
    sessions: [],
    json: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (
      new Set([
        "--input-dir",
        "--output-dir",
        "--output",
        "--protocol",
        "--session",
      ]).has(value)
    ) {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      index += 1;
      if (value === "--input-dir") options.inputDir = next;
      if (value === "--output-dir") options.outputDir = next;
      if (value === "--output") options.output = next;
      if (value === "--protocol") options.protocol = next;
      if (value === "--session") options.sessions.push(next);
      continue;
    }
    throw new Error(`Unknown option: ${value}\n\n${usage()}`);
  }
  return options;
}

async function readJson(filePath, label) {
  const resolvedPath = path.resolve(filePath);
  try {
    return JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} ${resolvedPath}: ${error.message}`);
  }
}

async function writePrivate(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function createProtocolBundle(options) {
  const protocol = createFirstRunUsabilityProtocol();
  const outputDirectory = path.resolve(options.outputDir);
  const prefix = `first-run-usability-${protocol.protocol_id}`;
  const protocolPath = path.join(outputDirectory, `${prefix}.protocol.json`);
  const formPath = path.join(outputDirectory, `${prefix}.html`);
  await Promise.all([
    writePrivate(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`),
    writePrivate(formPath, renderFirstRunUsabilityForm(protocol)),
  ]);
  const result = {
    protocol_id: protocol.protocol_id,
    tasks: protocol.tasks.length,
    protocol: protocolPath,
    observer_form: formPath,
    privacy: "fictional_only_private_local_sessions",
    next:
      "Give the clean copy, public README, and local form to an independent newcomer. Keep downloaded session JSON private.",
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `Created first-run protocol ${result.protocol_id}.`,
      `Tasks: ${result.tasks}`,
      `Private protocol: ${result.protocol}`,
      `Local observer form: ${result.observer_form}`,
      "Use only built-in or Moondog-generated fictional data. Do not collect a participant's listening archive or provider credentials.",
      result.next,
    ].join("\n") + "\n",
  );
}

async function createObserverForm(options) {
  if (!options.protocol) throw new Error(`form requires --protocol.\n\n${usage()}`);
  const protocolPath = path.resolve(options.protocol);
  const protocol = await readJson(protocolPath, "first-run protocol");
  validateFirstRunUsabilityProtocol(protocol);
  const outputPath = path.resolve(
    options.output ??
      path.join(
        path.dirname(protocolPath),
        `first-run-usability-${protocol.protocol_id}.html`,
      ),
  );
  await writePrivate(outputPath, renderFirstRunUsabilityForm(protocol));
  const result = {
    protocol_id: protocol.protocol_id,
    protocol: protocolPath,
    observer_form: outputPath,
    privacy: "fictional_only_private_local_sessions",
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `Regenerated local observer form for ${result.protocol_id}.`,
      `Private protocol: ${result.protocol}`,
      `Local observer form: ${result.observer_form}`,
      "Keep downloaded completed sessions local and validate them before aggregation.",
    ].join("\n") + "\n",
  );
}

async function showStatus(options) {
  const report = await inspectFirstRunUsabilityDirectory(options.inputDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${summarizeFirstRunUsabilityStatus(report)}\n`);
}

async function readProtocolAndSessions(options, command) {
  if (!options.protocol || options.sessions.length === 0) {
    throw new Error(
      `${command} requires --protocol and at least one --session.\n\n${usage()}`,
    );
  }
  const protocol = await readJson(options.protocol, "first-run protocol");
  const sessions = await Promise.all(
    options.sessions.map((sessionPath) =>
      readJson(sessionPath, "completed usability session"),
    ),
  );
  return { protocol, sessions };
}

async function validateSessions(options) {
  const { protocol, sessions } = await readProtocolAndSessions(
    options,
    "validate",
  );
  const results = sessions.map((session) => {
    const validation = validateFirstRunUsabilitySession(session, protocol);
    return {
      valid: true,
      completed_tasks: validation.completed_tasks,
      blocked_tasks: validation.blocked_tasks,
      skipped_tasks: validation.skipped_tasks,
    };
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ valid: true, sessions: results }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${results.map((result, index) => `VALID session ${index + 1}: ${result.completed_tasks} completed, ${result.blocked_tasks} blocked, ${result.skipped_tasks} skipped`).join("\n")}\n`,
  );
}

function timestampedSummaryPath() {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return path.resolve("runs", `first-run-usability-summary-${timestamp}.json`);
}

async function summarizeSessions(options) {
  const { protocol, sessions } = await readProtocolAndSessions(
    options,
    "summarize",
  );
  const report = createPublicFirstRunUsabilitySummary({ protocol, sessions });
  const outputPath = path.resolve(options.output ?? timestampedSummaryPath());
  await writePrivate(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, artifact: outputPath }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${summarizeFirstRunUsabilitySummary(report)}\nAggregate artifact: ${outputPath}\n`,
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.command === "create") await createProtocolBundle(options);
  if (options.command === "form") await createObserverForm(options);
  if (options.command === "status") await showStatus(options);
  if (options.command === "validate") await validateSessions(options);
  if (options.command === "summarize") await summarizeSessions(options);
}

await main();
