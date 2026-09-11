import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import { PersistentCredentialStore } from "../../src/runtime/pi/persistent-credential-store.mjs";
import { createPiModels } from "../../src/runtime/pi/model-catalog.mjs";

const toolName = "lookup_music";
const toolArguments = { artist: "Moondog" };
const serializedArguments = JSON.stringify(toolArguments);
const toolOutput = JSON.stringify({ title: "Bird's Lament", artist: "Moondog" });
const finalText = "Try Bird's Lament by Moondog.";
const providers = [
  ["anthropic", "claude-haiku-4-5", "anthropic-messages", "https://api.anthropic.com/v1/messages"],
  ["deepseek", "deepseek-v4-flash", "openai-completions", "https://api.deepseek.com/chat/completions"],
  ["moonshotai", "kimi-k2.5", "openai-completions", "https://api.moonshot.ai/v1/chat/completions"],
  ["openai", "gpt-5.4-mini", "openai-responses", "https://api.openai.com/v1/responses"],
  ["xai", "grok-4.6", "openai-responses", "https://api.x.ai/v1/responses"],
  ["zai", "glm-4.7", "openai-completions", "https://api.z.ai/api/paas/v4/chat/completions"],
];

function completionEvents(model, followUp) {
  const chunk = (delta, finishReason = null) => ({
    id: "chatcmpl_fixture",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  if (followUp) return [chunk({ content: finalText }), chunk({}, "stop")];
  return [
    chunk({ tool_calls: [{ index: 0, id: "call_music", type: "function", function: { name: toolName, arguments: "" } }] }),
    ...[serializedArguments.slice(0, 10), serializedArguments.slice(10)].map((part) =>
      chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] }),
    ),
    chunk({}, "tool_calls"),
  ];
}

function responseEvents(followUp) {
  const item = followUp
    ? { type: "message", id: "msg_music", role: "assistant", content: [] }
    : { type: "function_call", id: "fc_music", call_id: "call_music", name: toolName, arguments: "" };
  const doneItem = followUp
    ? { ...item, content: [{ type: "output_text", text: finalText, annotations: [] }] }
    : { ...item, arguments: serializedArguments };
  const deltas = followUp ? [finalText] : [serializedArguments.slice(0, 10), serializedArguments.slice(10)];
  return [
    { type: "response.created", response: { id: "resp_music", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item },
    ...deltas.map((delta) => ({
      type: followUp ? "response.output_text.delta" : "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta,
    })),
    { type: "response.output_item.done", output_index: 0, item: doneItem },
    { type: "response.completed", response: { id: "resp_music", status: "completed", output: [doneItem] } },
  ];
}

function anthropicEvents(model, followUp) {
  const contentBlock = followUp
    ? { type: "text", text: "" }
    : { type: "tool_use", id: "call_music", name: toolName, input: {} };
  const deltas = followUp
    ? [{ type: "text_delta", text: finalText }]
    : [serializedArguments.slice(0, 10), serializedArguments.slice(10)].map((part) => ({
        type: "input_json_delta", partial_json: part,
      }));
  return [
    { type: "message_start", message: { id: "msg_music", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: contentBlock },
    ...deltas.map((delta) => ({ type: "content_block_delta", index: 0, delta })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: followUp ? "end_turn" : "tool_use" }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
}

function streamResponse(api, model, followUp) {
  const events = api === "anthropic-messages"
    ? anthropicEvents(model, followUp)
    : api === "openai-responses"
      ? responseEvents(followUp)
      : completionEvents(model, followUp);
  const body = events.map((event) =>
    `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
  ).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function assertRequestBody(body, api, model, followUp) {
  assert.equal(body.model, model);
  assert.equal(body.stream, true);
  if (api === "anthropic-messages") {
    assert.equal(body.tools[0].name, toolName);
    assert.equal(body.tools[0].input_schema.properties.artist.type, "string");
    if (!followUp) return;
    const call = body.messages.flatMap((message) => message.content).find((block) => block.type === "tool_use");
    const result = body.messages.flatMap((message) => message.content).find((block) => block.type === "tool_result");
    assert.deepEqual(call.input, toolArguments);
    assert.equal(result.tool_use_id, call.id);
    assert.ok(JSON.stringify(result.content).includes("Bird's Lament"));
  } else if (api === "openai-responses") {
    assert.equal(body.tools[0].type, "function");
    assert.equal(body.tools[0].name, toolName);
    assert.equal(body.tools[0].parameters.properties.artist.type, "string");
    if (!followUp) return;
    const call = body.input.find((item) => item.type === "function_call");
    const result = body.input.find((item) => item.type === "function_call_output");
    assert.deepEqual(JSON.parse(call.arguments), toolArguments);
    assert.equal(result.call_id, call.call_id);
    assert.equal(result.output, toolOutput);
  } else {
    assert.equal(body.tools[0].type, "function");
    assert.equal(body.tools[0].function.name, toolName);
    assert.equal(body.tools[0].function.parameters.properties.artist.type, "string");
    if (!followUp) return;
    const call = body.messages.find((message) => message.tool_calls)?.tool_calls[0];
    const result = body.messages.find((message) => message.role === "tool");
    assert.deepEqual(JSON.parse(call.function.arguments), toolArguments);
    assert.equal(result.tool_call_id, call.id);
    assert.equal(result.content, toolOutput);
  }
}

// Exercise the real Pi HTTP adapters and Agent loop with synthetic SSE and keys.
// This validates local request construction, not access to any live model service.
for (const [provider, modelId, api, endpoint] of providers) {
  test(`${provider} uses its saved API key and streams a music tool roundtrip`, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "moondog-provider-stream-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const authFile = path.join(root, "auth.json");
    const key = `synthetic-test-key-${provider}`;
    await new PersistentCredentialStore({ authFile }).modify(provider, async () => ({ type: "api_key", key }));
    const models = createPiModels({
      credentials: new PersistentCredentialStore({ authFile }),
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    assert.ok(await models.checkAuth(provider));
    const model = models.getModel(provider, modelId);
    assert.equal(model?.api, api);
    const requests = [];
    const executions = [];
    const events = [];
    const fetch = async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, endpoint);
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get(api === "anthropic-messages" ? "x-api-key" : "authorization"),
        api === "anthropic-messages" ? key : `Bearer ${key}`);
      const body = await request.json();
      assert.ok(requests.length < 2, "Expected only a tool request and its follow-up");
      const followUp = requests.length === 1;
      assertRequestBody(body, api, modelId, followUp);
      requests.push(body);
      return streamResponse(api, modelId, followUp);
    };
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: "Help the listener discover music using the available lookup tool.",
        tools: [{
          name: toolName,
          label: "Look up music",
          description: "Look up a track by artist.",
          parameters: Type.Object({ artist: Type.String() }),
          async execute(_id, parameters) {
            executions.push(parameters);
            return { content: [{ type: "text", text: toolOutput }], details: {} };
          },
        }],
      },
      streamFn: (selectedModel, streamContext, options) => models.streamSimple(selectedModel, streamContext, {
        ...options, fetch, maxRetries: 0,
      }),
    });
    const unsubscribe = agent.subscribe((event) => events.push(event));
    context.after(() => { unsubscribe(); agent.abort(); });
    await agent.prompt("Find a track by Moondog.");
    assert.equal(agent.state.errorMessage, undefined);
    assert.equal(requests.length, 2);
    assert.deepEqual(executions, [toolArguments]);
    assert.equal(agent.state.messages.at(-1).content[0].text, finalText);
    assert.ok(events.some((event) => event.type === "tool_execution_end" && !event.isError));
    assert.ok(events.some((event) => event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta"));
    assert.ok(events.some((event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"));
  });
}
