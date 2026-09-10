import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const webResult = (kind) => ({
  provider: "codex_cli", kind, status: "found", retrieved_at: "2026-09-05T00:00:00Z", from_cache: false,
  evidence: "native_web_operation_observed", summary: "A sourced music interview.",
  sources: [{ title: "Music interview", url: "https://example.com/interview", snippet: "A public source summary.", published_at: null }],
  raw_provider_payload: "not model-visible",
});

test("Pi searches and reads with bounded inputs, then retains host-rendered sources", async () => {
  const calls = [];
  const application = new MoondogApplication({
    importsRoot: "/tmp/moondog-web-no-import",
    webResearch: {
      publicStatus: () => ({ state: "configured" }),
      search: async (input, { signal }) => { calls.push(input); assert.ok(signal instanceof AbortSignal); return webResult("search"); },
      read: async (input) => { calls.push(input); return webResult("read"); },
    },
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_web_search", { query: "artist interview" })], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult");
      assert.equal(result.isError, false);
      assert.equal(JSON.stringify(result).includes("not model-visible"), false);
      assert.equal(JSON.parse(result.content[0].text).trust, "untrusted_web_content");
      return fauxAssistantMessage([fauxToolCall("moondog_web_read", { url: "https://example.com/interview" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxText("找到一篇访谈，日期没有确认。")]),
  ]);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  let rendered = "";
  const result = await runtime.prompt("搜索并读一篇艺术家访谈", { onTextDelta: (delta) => { rendered += delta; }, onTextReplace: (text) => { rendered = text; } });
  assert.deepEqual(calls, [{ query: "artist interview" }, { url: "https://example.com/interview" }]);
  assert.equal(result.web_sources.length, 1);
  assert.match(result.text, /Public web sources/);
  assert.match(result.text, /https:\/\/example.com\/interview/);
  assert.equal(rendered, result.text);
  application.close();
});

test("unconfigured web backend registers no callable web tools", () => {
  const application = new MoondogApplication({ importsRoot: "/tmp/moondog-web-no-import" });
  assert.equal(application.agentCapabilityDescriptors().some((tool) => tool.capability_id.startsWith("web.")), false);
  application.close();
});
