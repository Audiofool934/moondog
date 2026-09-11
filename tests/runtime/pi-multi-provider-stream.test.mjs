import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";

import { Agent } from "@earendil-works/pi-agent-core";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";

import { listAgentCapabilityDescriptors } from "../../src/core/capability-catalog.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
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
const conditionalToolFields = {
  moondog_spotify_player_control: { required: ["action"], fields: ["action", "device_id", "uri", "context_uri", "position_ms", "track_refs", "percent", "state"] },
  moondog_spotify_queue_add: { required: [], fields: ["track_ref_id", "uri", "device_id"] },
  moondog_spotify_playlist_read: { required: ["action"], fields: ["action", "limit", "offset", "playlist_ref_id"] },
  moondog_spotify_playlist_write: { required: ["name"], fields: ["name", "description", "track_refs", "pending_plan"] },
};
const schemaProviders = [
  ...providers,
  ["openai-codex", "gpt-5.6-luna", "openai-codex-responses", "https://chatgpt.com/backend-api/codex/responses"],
];

function isResponsesApi(api) {
  return api === "openai-responses" || api === "openai-codex-responses";
}

function productionToolApplication() {
  return {
    memoryStatus: () => ({ state: "not_persistent" }),
    sourceStatus: async () => ({ state: "missing", latest: null }),
    profileStatus: async () => ({ state: "not_materialized" }),
    spotifyReady: () => true,
    beginPrompt() {},
    endPrompt() {},
    agentCapabilityDescriptors: () => listAgentCapabilityDescriptors({
      domainServicesReady: true, profileServicesReady: true, playlistServicesReady: true,
      rediscoveryReady: true, historicalReturnReady: true, timeCapsuleReady: true,
      backToBackReady: true, memoryReady: true, spotifyReady: true,
      musicCatalogReady: true, musicDiscoveryReady: true, musicSimilarityReady: true,
      webResearchReady: true,
    }),
  };
}

function outboundToolSchemas(body, api) {
  return body.tools.map((tool) => api === "anthropic-messages"
    ? { name: tool.name, parameters: tool.input_schema }
    : isResponsesApi(api)
      ? { name: tool.name, parameters: tool.parameters }
      : { name: tool.function.name, parameters: tool.function.parameters });
}

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
    : isResponsesApi(api)
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
for (const [provider, modelId, api, endpoint] of schemaProviders) {
  test(`${provider} sends object schemas for every production tool on ordinary chat`, async (context) => {
    const codex = provider === "openai-codex";
    const key = codex
      ? `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64")}.fixture`
      : `synthetic-schema-key-${provider}`;
    const models = createPiModels({
      credentials: { read: async () => codex
        ? { type: "oauth", access: key, refresh: "unused-synthetic-refresh", expires: Date.now() + 86_400_000 }
        : { type: "api_key", key } },
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    const requests = [];
    const toolStarts = [];
    const runtime = new PiAgentRuntime({
      application: productionToolApplication(), provider, modelId,
      models: codex ? {
        streamSimple(model, streamContext, options) {
          assert.equal(options.transport, "auto", "production retains Pi's normal transport selection");
          return models.streamSimple(model, streamContext, { ...options, transport: "sse" });
        },
      } : models,
      model: models.getModel(provider, modelId),
      modelFetch: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.url, endpoint);
        assert.equal(request.headers.get(api === "anthropic-messages" ? "x-api-key" : "authorization"),
          api === "anthropic-messages" ? key : `Bearer ${key}`);
        if (codex) assert.equal(request.headers.get("content-encoding"), "zstd");
        const body = codex
          ? JSON.parse(zstdDecompressSync(Buffer.from(await request.arrayBuffer())).toString())
          : await request.json();
        requests.push(body);
        const invalid = outboundToolSchemas(body, api).find((tool) => tool.parameters.type !== "object");
        if (invalid) {
          return new Response(JSON.stringify({ error: {
            message: `Invalid schema for function '${invalid.name}': schema must be a JSON Schema of 'type: "object"', got 'type: "${invalid.parameters.type ?? "None"}"'.`,
            type: "invalid_request_error", code: "invalid_function_parameters",
          } }), { status: 400, headers: { "content-type": "application/json" } });
        }
        return streamResponse(api, modelId, true);
      },
    });
    context.after(() => runtime.abort());
    const result = await runtime.prompt("What music can you help me explore?", {
      onToolStart: (event) => toolStarts.push(event),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.text, finalText);
    assert.equal(requests.length, 1, "ordinary chat should succeed without repeating the rejected request");
    assert.deepEqual(toolStarts, [], "schema validation must not execute Spotify or another tool");
    const schemas = outboundToolSchemas(requests[0], api);
    assert.deepEqual(schemas.map((tool) => tool.name).sort(), runtime.agent.state.tools.map((tool) => tool.name).sort());
    for (const [name, expected] of Object.entries(conditionalToolFields)) {
      const schema = schemas.find((tool) => tool.name === name)?.parameters;
      assert.ok(schema, `The real ${name} schema must be exposed`);
      assert.deepEqual(Object.keys(schema.properties).sort(), [...expected.fields].sort(), `${name} must expose every action's fields`);
      assert.deepEqual([...(schema.required ?? [])].sort(), [...expected.required].sort(), `${name} must not require fields belonging only to another action`);
    }
    for (const { name, parameters } of schemas) {
      assert.equal(parameters.type, "object", `${name} requires a provider-compatible object root`);
      assert.equal(typeof parameters.properties, "object", `${name} must describe its root properties`);
      // Pi's non-strict Anthropic adapter transmits only type, properties, and required.
      if (api !== "anthropic-messages") assert.equal(parameters.additionalProperties, false, `${name} must retain unknown-field rejection`);
      assert.equal(parameters.anyOf, undefined, `${name} must not expose a root union`);
      assert.equal(parameters.oneOf, undefined, `${name} must not expose a root union`);
    }
    const playerControl = runtime.agent.state.tools.find((tool) => tool.name === "moondog_spotify_player_control");
    assert.throws(() => validateToolArguments(playerControl, {
      type: "toolCall", id: "fixture-invalid-call", name: playerControl.name,
      arguments: { action: "next", percent: 50 },
    }), /Validation failed/u, "serializing tools for the provider must not weaken the runtime's action validation");
  });
}

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

test("production Spotify tools retain conditional validation before execution", (context) => {
  const models = createPiModels();
  const runtime = new PiAgentRuntime({
    application: productionToolApplication(), models, provider: "deepseek", modelId: "deepseek-v4-flash",
    model: models.getModel("deepseek", "deepseek-v4-flash"),
  });
  context.after(() => runtime.abort());
  const cases = {
    moondog_spotify_player_control: {
      valid: [
        { action: "resume" }, { action: "resume", track_refs: ["fixture-track"], position_ms: 0 },
        { action: "pause" }, { action: "next", device_id: "fixture-device" }, { action: "previous" },
        { action: "volume", percent: 0 }, { action: "volume", percent: 100 },
        { action: "seek", position_ms: 86_400_000 }, { action: "shuffle", state: false },
        ...["off", "track", "context"].map((state) => ({ action: "repeat", state })),
      ],
      invalid: [
        {}, { action: "stop" }, { action: "volume" }, { action: "volume", percent: 101 },
        { action: "volume", percent: -1 }, { action: "seek" }, { action: "seek", position_ms: -1 },
        { action: "shuffle" }, { action: "shuffle", state: "sometimes" },
        { action: "repeat", state: "all" }, { action: "next", percent: 50 },
        { action: "pause", unexpected: true }, { action: "resume", track_refs: [] },
      ],
    },
    moondog_spotify_queue_add: {
      valid: [{ track_ref_id: "fixture-track" }, { uri: "spotify:track:fixture", device_id: "fixture-device" }],
      invalid: [{}, { track_ref_id: "fixture-track", uri: "spotify:track:fixture" }, { uri: "" }],
    },
    moondog_spotify_playlist_read: {
      valid: [{ action: "list", limit: 10, offset: 0 }, { action: "inspect", playlist_ref_id: "fixture-playlist" }],
      invalid: [{ action: "inspect" }, { action: "list", playlist_ref_id: "fixture-playlist" }, { action: "inspect", playlist_ref_id: "fixture-playlist", limit: 10 }],
    },
    moondog_spotify_playlist_write: {
      valid: [{ name: "Fixture", track_refs: [{ track_ref_id: "fixture-track" }] }, { name: "Fixture", pending_plan: true }],
      invalid: [{ name: "Fixture" }, { name: "Fixture", track_refs: [] }, { name: "Fixture", pending_plan: false }, { name: "Fixture", pending_plan: true, track_refs: [{ track_ref_id: "fixture-track" }] }],
    },
  };
  for (const [name, { valid, invalid }] of Object.entries(cases)) {
    const tool = runtime.agent.state.tools.find((item) => item.name === name);
    assert.ok(tool, `The production ${name} tool must be available`);
    const validate = (args) => validateToolArguments(tool, { type: "toolCall", id: "fixture-call", name, arguments: args });
    for (const args of valid) assert.deepEqual(validate(args), args, `${name} should accept ${JSON.stringify(args)}`);
    for (const args of invalid) assert.throws(() => validate(args), /Validation failed/u, `${name} should reject ${JSON.stringify(args)}`);
  }
});
