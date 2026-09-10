#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createHumanReviewBundle,
  createPublicHumanReviewSummary,
  summarizeHumanReviewSummary,
  validateCompletedHumanReview,
} from "../src/evaluation/discovery-human-review.mjs";
import { renderDiscoveryReviewForm } from "../src/evaluation/discovery-review-form.mjs";
import {
  inspectDiscoveryReviewDirectory,
  summarizeDiscoveryReviewStatus,
} from "../src/evaluation/discovery-review-status.mjs";

function usage() {
  return [
    "Usage:",
    "  npm run eval:review -- create --input <discovery-report.json> [--output-dir <dir>] [--json]",
    "  npm run eval:review -- form --packet <blind-review.json> [--output <path>] [--json]",
    "  npm run eval:review -- status [--input-dir <dir>] [--json]",
    "  npm run eval:review -- validate --review <completed-review.json> [--review <path>] [--json]",
    "  npm run eval:review -- summarize --review <completed-review.json> --manifest <private-manifest.json> [--output <path>] [--json]",
    "",
    "Review packets and manifests contain private music context and belong in the Git-ignored runs directory.",
    "Only the aggregate summary produced by summarize is designed for public use.",
  ].join("\n");
}

function parseArguments(argv) {
  const command = argv[0];
  if (
    !new Set(["create", "form", "status", "validate", "summarize", "help"]).has(
      command,
    )
  ) {
    throw new Error(usage());
  }
  const options = {
    command,
    input: null,
    inputDir: "runs",
    outputDir: "runs",
    output: null,
    packet: null,
    reviews: [],
    manifests: [],
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
        "--input",
        "--input-dir",
        "--output-dir",
        "--output",
        "--packet",
        "--review",
        "--manifest",
      ]).has(value)
    ) {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      index += 1;
      if (value === "--input") options.input = next;
      if (value === "--input-dir") options.inputDir = next;
      if (value === "--output-dir") options.outputDir = next;
      if (value === "--output") options.output = next;
      if (value === "--packet") options.packet = next;
      if (value === "--review") options.reviews.push(next);
      if (value === "--manifest") options.manifests.push(next);
      continue;
    }
    throw new Error(`Unknown option: ${value}\n\n${usage()}`);
  }
  return options;
}

async function createReviewForm(options) {
  if (!options.packet) throw new Error(`form requires --packet.\n\n${usage()}`);
  const packetPath = path.resolve(options.packet);
  const packet = await readJson(packetPath, "blind review packet");
  const html = renderDiscoveryReviewForm(packet);
  const outputPath = path.resolve(
    options.output ??
      path.join(
        path.dirname(packetPath),
        `discovery-human-review-${packet.packet_id}.html`,
      ),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  const result = {
    packet_id: packet.packet_id,
    packet: packetPath,
    review_form: outputPath,
    privacy: "private_local_review",
    next:
      "Open the local form, complete every required answer, download the JSON review, and run validate.",
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `Created local review form for ${result.packet_id}.`,
      `Private packet: ${packetPath}`,
      `Local review form: ${outputPath}`,
      "Keep both files local because they contain bounded personal music context.",
      result.next,
    ].join("\n") + "\n",
  );
}

async function showReviewStatus(options) {
  const report = await inspectDiscoveryReviewDirectory(options.inputDir);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${summarizeDiscoveryReviewStatus(report)}\n`);
}

async function readJson(filePath, label) {
  const resolvedPath = path.resolve(filePath);
  try {
    return JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} ${resolvedPath}: ${error.message}`);
  }
}

function timestampedSummaryPath() {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return path.resolve("runs", `discovery-human-review-summary-${timestamp}.json`);
}

async function createPacket(options) {
  if (!options.input) throw new Error(`create requires --input.\n\n${usage()}`);
  const inputPath = path.resolve(options.input);
  const report = await readJson(inputPath, "discovery evaluation report");
  const { packet, manifest } = createHumanReviewBundle(report, {
    sourceArtifact: inputPath,
  });
  const outputDirectory = path.resolve(options.outputDir);
  const packetPath = path.join(
    outputDirectory,
    `discovery-human-review-${packet.packet_id}.json`,
  );
  const manifestPath = path.join(
    outputDirectory,
    `discovery-human-review-${packet.packet_id}.manifest.json`,
  );
  const reviewFormPath = path.join(
    outputDirectory,
    `discovery-human-review-${packet.packet_id}.html`,
  );
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8"),
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(reviewFormPath, renderDiscoveryReviewForm(packet), "utf8"),
  ]);
  const result = {
    packet_id: packet.packet_id,
    cases: packet.cases.length,
    recommendations: packet.cases.reduce(
      (total, reviewCase) => total + reviewCase.recommendations.length,
      0,
    ),
    packet: packetPath,
    private_manifest: manifestPath,
    review_form: reviewFormPath,
    next:
      "Open the local review form, complete every required answer, download the JSON review, and run validate before summarizing.",
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `Created blind review packet ${result.packet_id}.`,
      `Cases: ${result.cases}, recommendations: ${result.recommendations}`,
      `Private packet: ${packetPath}`,
      `Private manifest: ${manifestPath}`,
      `Local review form: ${reviewFormPath}`,
      "Keep all three files local. Only a later aggregate summary is public-safe.",
      result.next,
    ].join("\n") + "\n",
  );
}

async function validateReviews(options) {
  if (options.reviews.length === 0) {
    throw new Error(`validate requires at least one --review.\n\n${usage()}`);
  }
  const results = [];
  for (const reviewPath of options.reviews) {
    const resolvedPath = path.resolve(reviewPath);
    const review = await readJson(resolvedPath, "completed review");
    results.push({
      path: resolvedPath,
      ...validateCompletedHumanReview(review),
    });
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ valid: true, reviews: results }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${results.map((result) => `VALID ${result.path}: ${result.recommendation_count} recommendations`).join("\n")}\n`,
  );
}

async function summarizeReviews(options) {
  if (options.reviews.length === 0 || options.manifests.length === 0) {
    throw new Error(
      `summarize requires at least one --review and one --manifest.\n\n${usage()}`,
    );
  }
  const reviews = await Promise.all(
    options.reviews.map((reviewPath) => readJson(reviewPath, "completed review")),
  );
  const manifests = await Promise.all(
    options.manifests.map((manifestPath) =>
      readJson(manifestPath, "private manifest"),
    ),
  );
  const report = createPublicHumanReviewSummary({ reviews, manifests });
  const outputPath = path.resolve(options.output ?? timestampedSummaryPath());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, artifact: outputPath }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${summarizeHumanReviewSummary(report)}\nAggregate artifact: ${outputPath}\n`,
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.command === "create") await createPacket(options);
  if (options.command === "form") await createReviewForm(options);
  if (options.command === "status") await showReviewStatus(options);
  if (options.command === "validate") await validateReviews(options);
  if (options.command === "summarize") await summarizeReviews(options);
}

await main();
