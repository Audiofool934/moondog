import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addCustomEndpoint, normalizeEndpoint, publicCustomEndpoint, readCustomEndpoint, writeCustomEndpoint, removeCustomEndpoint, testCustomEndpoint } from "../../src/runtime/pi/custom-endpoint.mjs";
import { getPublicPiModelCatalog } from "../../src/runtime/pi/public-model-catalog.mjs";
import { createConfiguredRuntime } from "../../src/runtime/pi/configured-runtime.mjs";
import { writePiRuntimeSelection } from "../../src/runtime/pi/runtime-settings.mjs";
import { createModels } from "@earendil-works/pi-ai";
import { safeProviderErrorMessage } from "../../src/runtime/pi/model-transport.mjs";

const input = { baseUrl: "https://gateway.example/v1", modelId: "relay-test-model", apiKey: "fictional-gateway-key", protocol: "openai-completions" };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-custom-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { MOONDOG_CONFIG_HOME: root };
}
const stream = () => new Response([
  { id: "fictional", object: "chat.completion.chunk", created: 1, model: "relay-test-model", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
  { id: "fictional", object: "chat.completion.chunk", created: 1, model: "relay-test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });

test("custom endpoint persistence preserves a same-site key, never returns it and requires a new key for a new site", async (t) => {
  const environment = await fixture(t);
  const result = await writeCustomEndpoint(input, environment);
  assert.equal(JSON.stringify(result).includes(input.apiKey), false);
  assert.equal(result.keySaved, true);
  await writeCustomEndpoint({ ...input, apiKey: "", modelId: "another-model" }, environment);
  assert.equal((await readCustomEndpoint(environment)).apiKey, input.apiKey);
  await assert.rejects(writeCustomEndpoint({ ...input, apiKey: "", baseUrl: "https://another.example/v1" }, environment));
  await removeCustomEndpoint(environment);
  assert.equal(await readCustomEndpoint(environment), null);
});

test("endpoint normalization handles copied operation URLs and rejects credential-bearing URLs", () => {
  assert.equal(normalizeEndpoint("https://gateway.example/v1/chat/completions"), input.baseUrl);
  assert.equal(normalizeEndpoint("http://localhost:1234/v1/"), "http://localhost:1234/v1");
  for (const value of ["https://secret@gateway.example/v1", "https://gateway.example/v1?key=secret", "http://remote.example/v1", "file:///tmp/api"]) assert.throws(() => normalizeEndpoint(value));
});

test("a custom model uses the entered URL and key for a real Pi streaming request", async (t) => {
  const environment = await fixture(t);
  await writeCustomEndpoint(input, environment);
  const config = await readCustomEndpoint(environment);
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push(String(url));
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${input.apiKey}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, input.modelId);
    assert.equal(body.stream, true);
    assert.equal(options.redirect, "error");
    return stream();
  };
  assert.deepEqual(await testCustomEndpoint(config, { fetchImpl }), { ok: true });
  assert.deepEqual(urls, ["https://gateway.example/v1/chat/completions"]);
});

test("the saved custom model participates in the shared picker and configured runtime after restart", async (t) => {
  const environment = await fixture(t);
  await writeCustomEndpoint(input, environment);
  await writePiRuntimeSelection({ provider: "custom-endpoint", model: input.modelId }, environment);
  const catalog = await getPublicPiModelCatalog(environment);
  assert.ok(catalog.providers().some((provider) => provider.id === "custom-endpoint"));
  const runtime = await createConfiguredRuntime({}, environment, { runtimeFactory: (options) => ({ publicStatus: () => ({ state: "configured", provider: options.provider, model: options.modelId }) }) });
  assert.equal(runtime.publicStatus().state, "configured");
  assert.equal(JSON.stringify(runtime.publicStatus()).includes(input.apiKey), false);
  for (const protocol of ["openai-responses", "anthropic-messages"]) {
    const models = addCustomEndpoint(createModels(), { ...await readCustomEndpoint(environment), protocol });
    assert.equal(models.getModel("custom-endpoint", input.modelId).api, protocol);
  }
});

test("custom endpoint failures never echo upstream credentials or raw server errors", async (t) => {
  const environment = await fixture(t);
  await writeCustomEndpoint(input, environment);
  await assert.rejects(testCustomEndpoint(await readCustomEndpoint(environment), {
    fetchImpl: async () => Response.json({ error: { message: `bad ${input.apiKey}` } }, { status: 401 }),
  }), (error) => error.code === "custom_endpoint_test_failed" && !error.message.includes(input.apiKey));
  assert.equal(safeProviderErrorMessage(`bad ${input.apiKey}`, "custom-endpoint").includes(input.apiKey), false);
});

test("Responses and Anthropic relay protocols use their correct operation URLs and streaming parsers", async (t) => {
  const environment = await fixture(t);
  const item = { id: "msg_fictional", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  const response = { id: "resp_fictional", object: "response", model: input.modelId, status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
  for (const protocol of ["openai-responses", "anthropic-messages"]) {
    await writeCustomEndpoint({ ...input, protocol }, environment);
    const config = await readCustomEndpoint(environment);
    const events = protocol === "openai-responses" ? [
      { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "OK" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ] : [
      { type: "message_start", message: { id: "msg_fictional", type: "message", role: "assistant", model: input.modelId, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    const models = addCustomEndpoint(createModels(), config);
    let observed;
    const result = await models.completeSimple(models.getModel("custom-endpoint", input.modelId), {
      messages: [{ role: "user", content: "Reply OK", timestamp: Date.now() }],
    }, { maxTokens: 16, fetch: async (url, options) => {
      observed = { url: String(url), headers: new Headers(options.headers) };
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    } });
    const operation = new URL(observed.url);
    assert.equal(`${operation.origin}${operation.pathname}`, protocol === "openai-responses" ? "https://gateway.example/v1/responses" : "https://gateway.example/v1/messages");
    assert.equal(observed.headers.get(protocol === "anthropic-messages" ? "x-api-key" : "authorization"), protocol === "anthropic-messages" ? input.apiKey : `Bearer ${input.apiKey}`);
    assert.notEqual(result.stopReason, "error", `${protocol}: ${result.errorMessage}`);
    assert.ok(result.content.some((item) => item.type === "text" && item.text === "OK"));
  }
});
