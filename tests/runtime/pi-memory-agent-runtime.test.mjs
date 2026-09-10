import assert from "node:assert/strict";
import test from "node:test";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import {
  MAX_REFLECTION_EPISODES,
  MemoryAgentRuntime,
} from "../../src/runtime/pi/memory-agent-runtime.mjs";

function episode(id = "episode-1") {
  return {
    episode_id: id,
    session_id: "session-1",
    kind: "dialogue",
    source_kind: "turn",
    summary: "The user says they prefer concise answers.",
    occurred_at: "2026-08-26T00:00:00.000Z",
    expires_at: null,
    importance: 1,
  };
}

function fixture() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    runtime: new MemoryAgentRuntime({
      models,
      model: faux.getModel(),
      provider: "faux",
      modelId: "faux-1",
    }),
  };
}

test("dedicated Pi Memory Agent captures one exact structured submission", async () => {
  const { faux, runtime } = fixture();
  const proposal = {
    action: "candidate_memory",
    assertion_mode: "explicit",
    confidence: 0.96,
    episode_ids: ["episode-1"],
    kind: "preference",
    rationale: "The user directly stated a stable preference.",
    statement: "Prefers concise answers",
  };
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("moondog_submit_memory_reflection", {
          proposals: [proposal],
        }),
      ],
      { stopReason: "toolUse" },
    ),
  ]);

  const result = await runtime.reflect({ episodes: [episode()] });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.proposals, [proposal]);
  assert.equal(faux.state.callCount, 1);
  assert.equal(runtime.publicStatus().adapter, "pi_memory_agent");
});

test("dedicated Pi Memory Agent fails closed on prose or wrong coverage", async () => {
  const prose = fixture();
  prose.faux.setResponses([
    fauxAssistantMessage([fauxText("I found one preference.")]),
  ]);
  await assert.rejects(
    prose.runtime.reflect({ episodes: [episode()] }),
    /did not submit/iu,
  );
  assert.equal(prose.faux.state.callCount, 1);

  const wrong = fixture();
  wrong.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("moondog_submit_memory_reflection", {
          proposals: [
            {
              action: "ignore",
              episode_ids: ["different-episode"],
              reason: "Wrong batch.",
            },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  await assert.rejects(
    wrong.runtime.reflect({ episodes: [episode()] }),
    /exact episode batch/iu,
  );
});

test("dedicated Pi Memory Agent rejects oversized input before a provider call", async () => {
  const { faux, runtime } = fixture();
  const episodes = Array.from(
    { length: MAX_REFLECTION_EPISODES + 1 },
    (_value, index) => episode(`episode-${index}`),
  );
  await assert.rejects(
    runtime.reflect({ episodes }),
    /at most 24 episodes/iu,
  );
  assert.equal(faux.state.callCount, 0);
});
