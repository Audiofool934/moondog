import {
  createConfiguredMemoryAgentRuntime,
  MAX_REFLECTION_EPISODES,
  MEMORY_AGENT_WORKER_VERSION,
} from "../runtime/pi/memory-agent-runtime.mjs";

function reflectionErrorCode(error) {
  const message = String(error?.message ?? "");
  if (/did not submit|exact episode|structured reflection/iu.test(message)) {
    return "model_output_invalid";
  }
  if (/model request failed|provider/iu.test(message)) return "model_failed";
  return "reflection_failed";
}

function offlineRuntimeError(reason) {
  if (reason === "provider_authentication_required") {
    return new Error(
      "The Memory Agent requires OpenAI Codex authentication. Run moondog auth login openai-codex first.",
    );
  }
  return new Error(
    "The Memory Agent model is offline. Choose a model with /model or configure MOONDOG_PROVIDER and MOONDOG_MODEL.",
  );
}

export async function runMemoryReflection({
  application,
  environment = process.env,
  trigger = "manual",
  dryRun = false,
  runtimeFactory = createConfiguredMemoryAgentRuntime,
  limit = MAX_REFLECTION_EPISODES,
} = {}) {
  if (!application) throw new TypeError("Memory reflection needs an application");

  const pending = application.pendingMemoryReflection({ limit });
  if (pending.length === 0) {
    return {
      state: "no_work",
      examined_episodes: 0,
      message: "No unprocessed memory episodes are ready for reflection.",
    };
  }

  const runtime = await runtimeFactory(environment);
  const runtimeStatus = runtime.publicStatus();
  if (runtimeStatus.state !== "configured") {
    throw offlineRuntimeError(runtimeStatus.reason);
  }

  const run = application.beginMemoryReflection({
    trigger,
    workerVersion: MEMORY_AGENT_WORKER_VERSION,
    provider: runtimeStatus.provider,
    model: runtimeStatus.model,
    limit,
    leaseMs: 15 * 60 * 1_000,
  });
  if (run.state !== "started") {
    return {
      state: run.state,
      ...(run.active_run ? { active_run: run.active_run } : {}),
      examined_episodes: 0,
    };
  }

  try {
    const reflected = await runtime.reflect({
      episodes: run.episodes,
      activeMemories: run.active_memories,
    });
    return application.completeMemoryReflection({
      runId: run.run_id,
      leaseToken: run.lease_token,
      proposals: reflected.proposals,
      dryRun,
    });
  } catch (error) {
    application.failMemoryReflection(
      run.run_id,
      run.lease_token,
      reflectionErrorCode(error),
    );
    throw error;
  }
}
