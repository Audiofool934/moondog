#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { MoondogApplication } from "../src/core/moondog-application.mjs";
import { openAppleProjectionDomainServices } from "../src/core/apple-projection-domain-services.mjs";
import {
  createHumanReviewProfileContext,
} from "../src/evaluation/discovery-human-review.mjs";
import {
  createDiscoveryScenarios,
  evaluateDiscoveryRun,
  summarizeDiscoveryEvaluation,
} from "../src/evaluation/discovery-evaluator.mjs";
import { createAppleMusicCatalog } from "../src/integrations/apple-music/catalog.mjs";
import { createOpenMusicSimilarity } from "../src/integrations/open-music-similarity/artist-radio.mjs";
import { openListeningHistoryStore } from "../src/profile/listening-history-store.mjs";
import { createConfiguredRuntime } from "../src/runtime/pi/configured-runtime.mjs";

function parseArguments(argv) {
  const options = {
    json: false,
    output: null,
    seedQuery: null,
    scenarioIds: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--output" || value === "--seed" || value === "--scenario") {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      index += 1;
      if (value === "--output") options.output = next;
      if (value === "--seed") options.seedQuery = next;
      if (value === "--scenario") options.scenarioIds.push(next);
      continue;
    }
    throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function defaultOutputPath() {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return path.resolve("runs", `discovery-evaluation-${timestamp}.json`);
}

async function createEvaluationApplication() {
  const listeningHistoryStore = await openListeningHistoryStore();
  try {
    const domainServices = await openAppleProjectionDomainServices({
      listeningHistoryStore,
    });
    return new MoondogApplication({
      domainServices,
      musicCatalog: createAppleMusicCatalog(),
      musicSimilarity: createOpenMusicSimilarity(),
    });
  } catch (error) {
    listeningHistoryStore.close();
    throw error;
  }
}

function captureDiscoveryCalls(application, discoveries) {
  const searchMusicCatalog = application.searchMusicCatalog.bind(application);
  application.searchMusicCatalog = async (input) => {
    const result = await searchMusicCatalog(input);
    discoveries.push(structuredClone(result));
    return result;
  };
  const discoverSimilarMusic = application.discoverSimilarMusic.bind(application);
  application.discoverSimilarMusic = async (input) => {
    const result = await discoverSimilarMusic(input);
    discoveries.push(structuredClone(result));
    return result;
  };
}

function captureHumanReviewContext(application, humanReviewContexts) {
  const getProfileSummary = application.getProfileSummary.bind(application);
  application.getProfileSummary = async (input) => {
    const result = await getProfileSummary(input);
    const context = createHumanReviewProfileContext(result);
    if (context) humanReviewContexts.push(structuredClone(context));
    return result;
  };
}

async function runScenario(scenario) {
  const toolTrace = [];
  const discoveries = [];
  const humanReviewContexts = [];
  const executedAt = new Date().toISOString();
  let application;
  let runtimeStatus = { state: "unavailable" };
  try {
    application = await createEvaluationApplication();
    captureDiscoveryCalls(application, discoveries);
    captureHumanReviewContext(application, humanReviewContexts);
    const runtime = await createConfiguredRuntime(application);
    runtimeStatus = runtime.publicStatus();
    if (runtimeStatus.state !== "configured") {
      throw new Error(
        "A configured model runtime is required for live discovery evaluation.",
      );
    }
    const result = await runtime.prompt(scenario.prompt, {
      onToolStart(tool) {
        toolTrace.push({
          event: "start",
          capability_id: tool.capabilityId,
          tool_name: tool.toolName,
        });
      },
      onToolEnd(tool) {
        toolTrace.push({
          event: "end",
          capability_id: tool.capabilityId,
          tool_name: tool.toolName,
          is_error: tool.isError,
        });
      },
    });
    return {
      run_version: "discovery-run/1",
      executed_at: executedAt,
      scenario,
      runtime: {
        state: runtimeStatus.state,
        provider: runtimeStatus.provider,
        model: runtimeStatus.model,
      },
      tool_trace: toolTrace,
      discoveries,
      human_review_contexts: humanReviewContexts,
      result,
    };
  } catch (error) {
    return {
      run_version: "discovery-run/1",
      executed_at: executedAt,
      scenario,
      runtime: {
        state: runtimeStatus.state,
        provider: runtimeStatus.provider,
        model: runtimeStatus.model,
      },
      tool_trace: toolTrace,
      discoveries,
      human_review_contexts: humanReviewContexts,
      result: {
        status: "failed",
        text: "",
        error:
          typeof error?.code === "string" && /^[a-z0-9_]+$/u.test(error.code)
            ? error.code
            : "discovery_evaluation_failed",
      },
    };
  } finally {
    application?.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const allScenarios = createDiscoveryScenarios({
    seedQuery: options.seedQuery,
  });
  const scenarios =
    options.scenarioIds.length === 0
      ? allScenarios
      : allScenarios.filter((scenario) =>
          options.scenarioIds.includes(scenario.id),
        );
  if (scenarios.length === 0) {
    throw new Error("No matching discovery evaluation scenarios were selected.");
  }
  const unknownIds = options.scenarioIds.filter(
    (id) => !allScenarios.some((scenario) => scenario.id === id),
  );
  if (unknownIds.length > 0) {
    throw new Error(`Unknown discovery scenarios: ${unknownIds.join(", ")}`);
  }

  const rawRuns = [];
  for (const scenario of scenarios) rawRuns.push(await runScenario(scenario));
  const runs = rawRuns.map(evaluateDiscoveryRun);
  const report = {
    report_version: "discovery-evaluation-report/1",
    generated_at: new Date().toISOString(),
    passed: runs.every((run) => run.passed),
    score: Math.round(
      runs.reduce((total, run) => total + run.score, 0) / runs.length,
    ),
    runs,
    raw_runs: rawRuns,
  };
  const outputPath = path.resolve(options.output ?? defaultOutputPath());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, artifact: outputPath }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${summarizeDiscoveryEvaluation(report)}\nArtifact: ${outputPath}\n`,
    );
  }
  if (!report.passed) process.exitCode = 1;
}

await main();
