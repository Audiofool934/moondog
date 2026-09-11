import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";

import { listAgentCapabilityDescriptors } from "../../src/core/capability-catalog.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
import { createPiModels } from "../../src/runtime/pi/model-catalog.mjs";
import { createModelFetch } from "../../src/runtime/pi/model-transport.mjs";

const provider = "deepseek";
const modelId = "deepseek-v4-flash";
const endpoint = "https://api.deepseek.com/chat/completions";
const fixtureKey = "synthetic-transport-fixture";

function networkFailure(code = "ECONNRESET") {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("PRIVATE_CAUSE_SENTINEL https://example.invalid/private?secret=SENTINEL"), {
      code,
      headers: { authorization: "Bearer PRIVATE_HEADER_SENTINEL" },
    }),
  });
}

function completionChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl_transport_fixture",
    object: "chat.completion.chunk",
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function eventText(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function textResponse(text = "The synthetic model connection recovered.") {
  return new Response([
    completionChunk({ content: text }),
    completionChunk({}, "stop"),
  ].map(eventText).join(""), { headers: { "content-type": "text/event-stream" } });
}

function spotifyNextResponse() {
  return new Response([
    completionChunk({ tool_calls: [{
      index: 0,
      id: "call_spotify_next",
      type: "function",
      function: { name: "moondog_spotify_player_control", arguments: '{"action":"next"}' },
    }] }),
    completionChunk({}, "tool_calls"),
  ].map(eventText).join(""), { headers: { "content-type": "text/event-stream" } });
}

function applicationFixture({ spotify = false } = {}) {
  const writes = [];
  return {
    writes,
    memoryStatus: () => ({ state: "not_persistent" }),
    sourceStatus: async () => ({ state: "missing", latest: null }),
    profileStatus: async () => ({ state: "not_materialized" }),
    spotifyReady: () => spotify,
    agentCapabilityDescriptors: () => spotify
      ? listAgentCapabilityDescriptors({ spotifyReady: true }).filter((item) => item.capability_id === "spotify.player.control")
      : [],
    beginPrompt() {},
    endPrompt() {},
    async spotifyControl(input) {
      writes.push(input);
      return {
        provider: "spotify", ok: true, effect: "write_external",
        action: "playback.next", state: "accepted",
      };
    },
  };
}

function runtimeFixture(fetch, { spotify = false, wait } = {}) {
  const models = createPiModels({
    credentials: { read: async () => ({ type: "api_key", key: fixtureKey }) },
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const application = applicationFixture({ spotify });
  const requests = [];
  const waits = [];
  const runtime = new PiAgentRuntime({
    application, models, provider, modelId,
    model: models.getModel(provider, modelId),
    modelFetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, endpoint);
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), `Bearer ${fixtureKey}`);
      const body = await request.json();
      requests.push(body);
      return fetch({ request, body, count: requests.length });
    },
    modelRetryDelay: wait ?? (async (milliseconds, signal) => {
      signal?.throwIfAborted();
      waits.push(milliseconds);
    }),
  });
  return { runtime, requests, waits, writes: application.writes };
}

function assertSafeConnectionError(error, { toolsExecuted = false, code = "ECONNRESET" } = {}) {
  assert.equal(error.code, "model_connection_failed");
  assert.equal(error.toolsExecuted, toolsExecuted);
  assert.match(error.message, /DeepSeek could not complete the model request/u);
  if (code) assert.ok(error.message.includes(`(${code})`));
  assert.doesNotMatch(error.message, /PRIVATE_|https?:\/\/|Bearer|SENTINEL/u);
  return true;
}

// These fixtures exercise Pi's actual HTTP adapter and agent tool loop.
// Every request is intercepted locally and carries only a synthetic key.
test("Pi retries a rejected model HTTP request twice and streams the recovered answer", async () => {
  const retryEvents = [];
  const deltas = [];
  const fixture = runtimeFixture(({ count }) => {
    if (count < 3) throw networkFailure();
    return textResponse();
  });
  const result = await fixture.runtime.prompt("Explain this synthetic music fixture.", {
    onModelRetry: (event) => retryEvents.push(event),
    onTextDelta: (delta) => deltas.push(delta),
  });
  assert.equal(result.status, "completed");
  assert.equal(deltas.join(""), result.text);
  assert.equal(fixture.requests.length, 3);
  assert.deepEqual(fixture.requests[1], fixture.requests[0]);
  assert.deepEqual(fixture.requests[2], fixture.requests[0]);
  assert.deepEqual(fixture.waits, [250, 500]);
  assert.deepEqual(retryEvents, [{ attempt: 1, maxRetries: 2 }, { attempt: 2, maxRetries: 2 }]);
  assert.equal(fixture.runtime.agent.state.messages.length, 2);
});

test("Codex SSE retries its compressed HTTP body without changing production transport selection", async () => {
  const codexProvider = "openai-codex";
  const codexModelId = "gpt-5.6-luna";
  const token = `fixture.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
  })).toString("base64")}.fixture`;
  const nativeModels = createPiModels({
    credentials: {
      read: async () => ({
        type: "oauth", access: token, refresh: "unused-synthetic-refresh",
        expires: Date.now() + 86_400_000,
      }),
    },
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const answer = "The synthetic Codex connection recovered.";
  const item = {
    id: "msg_fixture", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: answer, annotations: [] }],
  };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: answer },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item] } },
  ];
  const requests = [];
  const waits = [];
  const retryEvents = [];
  const runtime = new PiAgentRuntime({
    application: applicationFixture(), provider: codexProvider, modelId: codexModelId,
    model: nativeModels.getModel(codexProvider, codexModelId),
    models: {
      streamSimple(model, context, options) {
        assert.equal(options.transport, "auto", "production keeps Pi's WebSocket fallback");
        assert.equal(options.maxRetries, 0, "the native adapter must not add HTTP retries");
        return nativeModels.streamSimple(model, context, { ...options, transport: "sse" });
      },
    },
    modelFetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
      assert.equal(request.headers.get("content-encoding"), "zstd");
      assert.ok(ArrayBuffer.isView(init.body));
      const bytes = Buffer.from(await request.arrayBuffer());
      assert.equal(JSON.parse(zstdDecompressSync(bytes).toString()).model, codexModelId);
      requests.push(bytes);
      if (requests.length === 1) throw networkFailure();
      return new Response(events.map(eventText).join(""), { headers: { "content-type": "text/event-stream" } });
    },
    modelRetryDelay: async (milliseconds) => { waits.push(milliseconds); },
  });
  const result = await runtime.prompt("Use this synthetic Codex fixture.", {
    onModelRetry: (event) => retryEvents.push(event),
  });
  assert.equal(result.text, answer);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(waits, [250]);
  assert.deepEqual(retryEvents, [{ attempt: 1, maxRetries: 2 }]);
});

test("Pi exposes a safe final connection error after exhaustion and accepts another prompt", async () => {
  const original = networkFailure("UND_ERR_CONNECT_TIMEOUT");
  let recovered = false;
  const fixture = runtimeFixture(() => {
    if (!recovered) throw original;
    return textResponse();
  });
  await assert.rejects(fixture.runtime.prompt("First synthetic prompt."), (error) => {
    assertSafeConnectionError(error, { code: "UND_ERR_CONNECT_TIMEOUT" });
    assert.equal(error.cause.cause, original, "the original cause remains internal");
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_|Bearer|SENTINEL/u);
    return true;
  });
  assert.equal(fixture.requests.length, 3);
  assert.deepEqual(fixture.runtime.agent.state.messages, []);
  recovered = true;
  assert.equal((await fixture.runtime.prompt("Second synthetic prompt.")).status, "completed");
  assert.equal(fixture.requests.length, 4);
});

test("aborting model backoff cancels the turn without another fetch", async () => {
  const delayStarted = Promise.withResolvers();
  const fixture = runtimeFixture(() => { throw networkFailure(); }, {
    wait: (milliseconds, signal) => {
      delayStarted.resolve();
      return delay(milliseconds, undefined, { signal });
    },
  });
  const retries = [];
  const completion = fixture.runtime.prompt("Cancel this synthetic prompt.", {
    onModelRetry: (event) => retries.push(event),
  });
  await delayStarted.promise;
  fixture.runtime.abort();
  const result = await completion;
  assert.equal(result.status, "aborted");
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(retries, [{ attempt: 1, maxRetries: 2 }]);
  assert.deepEqual(fixture.runtime.agent.state.messages, []);
});

test("Pi does not retry HTTP authentication, permission, or quota responses", async () => {
  for (const status of [401, 403, 429]) {
    const retryEvents = [];
    const fixture = runtimeFixture(() => new Response(JSON.stringify({
      error: { message: status === 429 ? "insufficient_quota" : "Incorrect API key provided: PRIVATE_KEY_SENTINEL" },
    }), { status, headers: { "content-type": "application/json" } }));
    await assert.rejects(fixture.runtime.prompt("This response is terminal.", {
      onModelRetry: (event) => retryEvents.push(event),
    }), (error) => {
      assert.notEqual(error.code, "model_connection_failed");
      assert.doesNotMatch(error.message, /PRIVATE_KEY_SENTINEL/u);
      return true;
    });
    assert.equal(fixture.requests.length, 1, `HTTP ${status} must not be retried`);
    assert.deepEqual(retryEvents, []);
    assert.deepEqual(fixture.waits, []);
  }
});

test("a model HTTP retry after Spotify next keeps its receipt and executes the action once", async () => {
  const fixture = runtimeFixture(({ count, body }) => {
    if (count === 1) return spotifyNextResponse();
    const receipt = body.messages.find((message) => message.role === "tool");
    assert.equal(JSON.parse(receipt.content).action, "playback.next");
    if (count === 2) throw networkFailure();
    return textResponse("Spotify skipped once.");
  }, { spotify: true });
  const toolEnds = [];
  const result = await fixture.runtime.prompt("Skip to the next Spotify track once.", {
    onToolEnd: (tool) => toolEnds.push(tool),
  });
  assert.equal(result.text, "Spotify skipped once.");
  assert.equal(fixture.requests.length, 3);
  assert.deepEqual(fixture.requests[2], fixture.requests[1]);
  assert.deepEqual(fixture.writes, [{ action: "next" }]);
  assert.equal(toolEnds.length, 1);
  assert.equal(toolEnds[0].isError, false);
});

test("exhaustion after Spotify next reports executed tools without repeating the action", async () => {
  const fixture = runtimeFixture(({ count }) => {
    if (count === 1) return spotifyNextResponse();
    throw networkFailure();
  }, { spotify: true });
  await assert.rejects(fixture.runtime.prompt("Skip one track."), (error) =>
    assertSafeConnectionError(error, { toolsExecuted: true }),
  );
  assert.equal(fixture.requests.length, 4);
  assert.deepEqual(fixture.writes, [{ action: "next" }]);
});

test("a failure after the model response starts never replays its body or partial text", async () => {
  let responseController;
  const fixture = runtimeFixture(() => new Response(new ReadableStream({
    start(controller) {
      responseController = controller;
      controller.enqueue(new TextEncoder().encode(eventText(completionChunk({ content: "Partial synthetic answer." }))));
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  const deltas = [];
  await assert.rejects(fixture.runtime.prompt("Start a synthetic stream.", {
    onTextDelta(delta) {
      deltas.push(delta);
      responseController.error(new TypeError("terminated"));
    },
  }), (error) =>
    assertSafeConnectionError(error, { code: null }),
  );
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(deltas, ["Partial synthetic answer."]);
  assert.deepEqual(fixture.waits, []);
  assert.deepEqual(fixture.runtime.agent.state.messages, []);
});

test("model fetch declines retries for caller-owned Request bodies and streaming bodies", async () => {
  for (const input of [
    new Request(endpoint, { method: "POST", body: "synthetic request" }),
    endpoint,
  ]) {
    let count = 0;
    const retries = [];
    const fetch = createModelFetch({
      provider,
      fetchImpl: async (request) => {
        count += 1;
        if (request instanceof Request) await request.text();
        throw networkFailure();
      },
      onRetry: (event) => retries.push(event),
    });
    const init = typeof input === "string"
      ? { method: "POST", body: new ReadableStream({ start(controller) { controller.close(); } }), duplex: "half" }
      : undefined;
    await assert.rejects(fetch(input, init), /could not complete the model request/u);
    assert.equal(count, 1);
    assert.deepEqual(retries, []);
  }
});

test("malformed, authentication, and certificate fetch errors are never retried", async () => {
  for (const cause of [
    new TypeError("Failed to parse URL from malformed request"),
    Object.assign(networkFailure(), { code: "ERR_INVALID_URL" }),
    Object.assign(new Error("Incorrect API key"), { status: 401 }),
    networkFailure("CERT_HAS_EXPIRED"),
  ]) {
    let count = 0;
    const retries = [];
    const fetch = createModelFetch({
      provider,
      fetchImpl: async () => { count += 1; throw cause; },
      onRetry: (event) => retries.push(event),
    });
    await assert.rejects(fetch(endpoint, { method: "POST", body: "{}" }));
    assert.equal(count, 1);
    assert.deepEqual(retries, []);
  }
});
