import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
import { createConfiguredRuntime, OfflineAgentRuntime } from "../../src/runtime/pi/configured-runtime.mjs";

const timestamp = "2026-09-10T09:00:00.000Z";
const turn = (role, text) => ({ role, text, created_at: timestamp });
const messageText = (message) => typeof message.content === "string"
  ? message.content
  : message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
const queuedMessage = (text) => ({ role: "user", content: text, timestamp: 0 });

function fixture() {
  const sessions = {
    A: [turn("user", "SESSION_A_REQUEST"), turn("assistant", "SESSION_A_ANSWER")],
    B: [turn("user", "SESSION_B_REQUEST"), turn("assistant", "SESSION_B_ANSWER")],
  };
  const state = { selected: "A", reads: [], resets: 0, promptActive: false, promptState: {} };
  const application = {
    currentSessionTurns({ limit }) {
      state.reads.push({ session: state.selected, limit });
      return structuredClone(sessions[state.selected].slice(-limit));
    },
    agentCapabilityDescriptors: () => [],
    sourceStatus: async () => ({ state: "missing", latest: null }),
    profileStatus: async () => ({ state: "not_materialized" }),
    memoryStatus: () => ({ state: "ready", long_term_memory: "explicit_only" }),
    memoryContext: () => ({ durable_memories: [], recent_episodes: [], recent_sessions: [] }),
    beginPrompt() { state.promptActive = true; },
    endPrompt() { state.promptActive = false; },
    resetPromptState() { state.resets += 1; state.promptState = {}; },
    recordCompletedTurn(user, assistant) {
      sessions[state.selected].push(turn("user", user), turn("assistant", assistant));
      return { recorded: true };
    },
  };
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({
    application,
    models,
    model: faux.getModel("faux-1"),
    provider: "faux",
    modelId: "faux-1",
  });
  return { application, state, sessions, faux, models, runtime };
}

test("restoring session B replaces session A and clears queued Pi messages before the next prompt", async () => {
  const { application, state, sessions, faux, runtime } = fixture();
  faux.setResponses([
    (context) => {
      assert.match(JSON.stringify(context.messages), /SESSION_A_ANSWER/u);
      return fauxAssistantMessage("SESSION_A_NEW_ANSWER");
    },
    (context) => {
      const messages = context.messages.map(messageText);
      assert.deepEqual(messages.slice(1), ["SESSION_B_REQUEST", "SESSION_B_ANSWER", "Continue B."]);
      assert.doesNotMatch(JSON.stringify(context), /SESSION_A_|STALE_STEER|STALE_FOLLOWUP/u);
      assert.deepEqual(state.promptState, {});
      return fauxAssistantMessage("SESSION_B_NEW_ANSWER");
    },
  ]);
  await runtime.prompt("SESSION_A_NEW_REQUEST");
  runtime.agent.steer(queuedMessage("STALE_STEER"));
  runtime.agent.followUp(queuedMessage("STALE_FOLLOWUP"));
  state.promptState = { staleCandidate: "SESSION_A_CANDIDATE" };
  assert.equal(runtime.agent.hasQueuedMessages(), true);

  state.selected = "B";
  runtime.restoreSession();

  assert.deepEqual(state.reads.at(-1), { session: "B", limit: 40 });
  assert.equal(state.resets, 1);
  assert.equal(runtime.agent.hasQueuedMessages(), false);
  assert.equal(runtime.activePromptState, null);
  assert.equal(runtime.promptInFlight, false);
  assert.deepEqual(runtime.agent.state.messages.map(messageText), ["SESSION_B_REQUEST", "SESSION_B_ANSWER"]);
  const assistant = runtime.agent.state.messages[1];
  assert.equal(assistant.api, runtime.model.api);
  assert.equal(assistant.provider, "faux");
  assert.equal(assistant.model, "faux-1");
  assert.equal(assistant.timestamp, Date.parse(timestamp));
  assert.equal(assistant.stopReason, "stop");
  assert.equal(assistant.usage.totalTokens, 0);

  const result = await runtime.prompt("Continue B.");
  assert.equal(result.text, "SESSION_B_NEW_ANSWER");
  assert.equal(result.memory_recorded, true);
  assert.equal(faux.state.callCount, 2);
  assert.equal(sessions.A.at(-1).text, "SESSION_A_NEW_ANSWER");
  assert.equal(application.currentSessionTurns({ limit: 40 }).at(-1).text, "SESSION_B_NEW_ANSWER");
});

test("restore rejects an in-flight prompt before reading or resetting session state", async () => {
  const { state, faux, runtime } = fixture();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  faux.setResponses([
    async () => {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage("Still in session A.");
    },
  ]);
  const pending = runtime.prompt("Keep this prompt in A.");
  try {
    await started.promise;
    const activePromptState = runtime.activePromptState;
    const messages = structuredClone(runtime.agent.state.messages);
    const reads = state.reads.length;
    assert.throws(() => runtime.restoreSession(), /restore.*prompt is in progress/iu);
    assert.equal(state.reads.length, reads);
    assert.equal(state.resets, 0);
    assert.equal(runtime.activePromptState, activePromptState);
    assert.equal(state.promptActive, true);
    assert.deepEqual(runtime.agent.state.messages, messages);
  } finally {
    release.resolve();
    await pending;
  }
  assert.equal(runtime.promptInFlight, false);
  assert.equal(state.promptActive, false);
  assert.doesNotThrow(() => runtime.restoreSession());
});

test("model reload hydrates the selected session using the new model metadata", async () => {
  const { application, state, faux, models, runtime } = fixture();
  state.selected = "B";
  runtime.restoreSession();
  const reloaded = await createConfiguredRuntime(application, {}, {
    credentials: {},
    modelsFactory: () => models,
    selection: { provider: "faux", model: "faux-2" },
  });
  // Match the TUI replacement order: construct the next runtime, then reset the previous one.
  runtime.reset();
  assert.equal(state.selected, "B");
  assert.deepEqual(runtime.agent.state.messages, []);
  assert.deepEqual(reloaded.agent.state.messages.map(messageText), ["SESSION_B_REQUEST", "SESSION_B_ANSWER"]);
  assert.equal(reloaded.agent.state.messages[1].model, "faux-2");
  assert.equal(reloaded.agent.state.messages[1].provider, "faux");
  assert.equal(reloaded.agent.state.messages[1].api, faux.getModel("faux-2").api);
  faux.setResponses([
    (context, _options, _state, model) => {
      assert.equal(model.id, "faux-2");
      assert.deepEqual(context.messages.slice(1).map(messageText), ["SESSION_B_REQUEST", "SESSION_B_ANSWER", "Use the selected session."]);
      assert.doesNotMatch(JSON.stringify(context), /SESSION_A_/u);
      return fauxAssistantMessage("Session B, new model.");
    },
  ]);
  assert.equal((await reloaded.prompt("Use the selected session.")).text, "Session B, new model.");
});

test("reset keeps a fresh context empty and offline restore remains a no-op", async () => {
  const { runtime, faux } = fixture();
  runtime.agent.followUp(queuedMessage("STALE_FOLLOWUP"));
  runtime.reset();
  assert.deepEqual(runtime.agent.state.messages, []);
  assert.equal(runtime.agent.hasQueuedMessages(), false);
  faux.setResponses([
    (context) => {
      assert.deepEqual(context.messages.slice(1).map(messageText), ["Fresh session request."]);
      assert.doesNotMatch(JSON.stringify(context), /SESSION_A_|SESSION_B_|STALE_FOLLOWUP/u);
      return fauxAssistantMessage("Fresh session reply.");
    },
  ]);
  assert.equal((await runtime.prompt("Fresh session request.")).text, "Fresh session reply.");
  const offline = new OfflineAgentRuntime();
  const status = offline.publicStatus();
  assert.equal(offline.restoreSession(), undefined);
  assert.deepEqual(offline.publicStatus(), status);
});
