// Runs the public agent against Pi's fake model provider: no network, no key, no cost.
//   node --test site/server/
import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { configFromEnvironment, startAgentServer } from "./agent-server.mjs";

const origin = "http://localhost:8737";

async function start(t, overrides = {}) {
  const faux = fauxProvider();
  const config = { ...configFromEnvironment({}), port: 0, host: "127.0.0.1", origins: [origin], provider: "faux", model: "faux-1", ...overrides };
  const agent = await startAgentServer(config, {
    modelsFactory: () => { const models = createModels(); models.setProvider(faux.provider); return models; },
    log: () => {},
  });
  t.after(() => agent.close());
  const call = (path, init = {}) => fetch(`http://127.0.0.1:${agent.port}${path}`, {
    ...init, headers: { origin, "content-type": "application/json", ...init.headers },
  });
  const turn = async (session, text) => {
    const response = await call(`/v1/sessions/${session}/turns`, { method: "POST", body: JSON.stringify({ text }) });
    return (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  const open = async () => (await (await call("/v1/sessions", { method: "POST" })).json()).session;
  return { agent, faux, call, turn, open };
}

test("a turn streams the agent's tool steps and reply", async (t) => {
  const { faux, turn, open, call } = await start(t);
  assert.equal((await (await call("/v1/status")).json()).available, true);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_profile_summary", {})], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult");
      assert.match(JSON.stringify(result.content), /Midnight Lines|Mara Vale/u, "the tool reads the fictional listener");
      return fauxAssistantMessage([fauxText("You keep coming back to Mara Vale.")]);
    },
  ]);
  const events = await turn(await open(), "What does my listening say?");
  assert.deepEqual(events.map((event) => event.type).filter((type) => type !== "text_delta" && type !== "text_replace"), ["tool_start", "tool_end", "result"]);
  assert.equal(events.at(-1).result.text, "You keep coming back to Mara Vale.");
});

test("limits arrive as Moondog's reply, and the profile build is not offered", async (t) => {
  const { faux, turn, open } = await start(t, { turnsPerSession: 1, maxPromptChars: 20 });
  const session = await open();
  assert.match((await turn(session, "x".repeat(21))).at(-1).text, /under 20 characters/u);
  faux.setResponses([(context) => {
    const tools = context.messages.flatMap((message) => message.toolsAdded?.map((tool) => tool.name) ?? []);
    assert.ok(tools.includes("moondog_profile_summary"));
    assert.ok(!tools.includes("moondog_profile_build") && !tools.includes("moondog_memory_remember"));
    return fauxAssistantMessage([fauxText("Hello.")]);
  }]);
  assert.equal((await turn(session, "Hi")).at(-1).result.text, "Hello.");
  const capped = (await turn(session, "Again")).at(-1);
  assert.equal(capped.type, "notice");
  assert.equal(capped.code, "session_turns");
});

test("other sites and unknown sessions are refused", async (t) => {
  const { call } = await start(t);
  assert.equal((await call("/v1/sessions", { method: "POST", headers: { origin: "https://example.com" } })).status, 403);
  assert.equal((await call("/v1/sessions/00000000-0000-0000-0000-000000000000/turns", { method: "POST", body: "{}" })).status, 404);
});

test("each visitor gets a separate copy of the fictional history", async (t) => {
  const { agent, open } = await start(t);
  const [first, second] = [await open(), await open()];
  const paths = [first, second].map((id) => agent.sessions.get(id).folder);
  assert.notEqual(paths[0], paths[1]);
});
