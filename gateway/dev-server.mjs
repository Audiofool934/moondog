#!/usr/bin/env node
// The gateway on this computer, for development: the same code as the Worker, with its store in
// memory. It makes one invite code at start and prints it.
//
//   node gateway/dev-server.mjs
//   MOONDOG_MODEL_URL=http://127.0.0.1:8788/v1 moondog invite <the printed code>
//
// With UPSTREAM_BASE_URL, UPSTREAM_API_KEY and UPSTREAM_MODEL set, it calls that upstream.
// Without them it answers each request with one fixed line, so the app's path can be checked
// with no key.

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { createGateway, hashInvite, newInviteCode } from "./src/gateway.mjs";
import { createMemoryStore } from "./src/store-memory.mjs";

function cannedUpstream() {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const text = "This is the local Moondog gateway answering without an upstream model.";
    const usage = { prompt_tokens: Math.ceil(init.body.length / 3), completion_tokens: 20 };
    if (!body.stream) {
      return Response.json({ id: "local", object: "chat.completion", model: "local", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
    }
    const events = [
      { id: "local", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
      { id: "local", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "local", object: "chat.completion.chunk", model: "local", choices: [], usage },
    ];
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
}

/** Starts the gateway on 127.0.0.1. Returns { url, code, store, adminToken, close }. */
export async function startLocalGateway({ port = 0, environment = process.env, limits = {}, fetch } = {}) {
  const store = createMemoryStore();
  const real = environment.UPSTREAM_BASE_URL && environment.UPSTREAM_API_KEY && environment.UPSTREAM_MODEL;
  const adminToken = environment.ADMIN_TOKEN ?? "local-admin";
  const handle = createGateway({
    store,
    upstream: real
      ? { baseUrl: environment.UPSTREAM_BASE_URL.replace(/\/+$/u, ""), apiKey: environment.UPSTREAM_API_KEY, model: environment.UPSTREAM_MODEL, extraBody: {} }
      : { baseUrl: "http://upstream.invalid", apiKey: "none", model: "local", extraBody: {} },
    limits: { dailyTokens: 3_000_000, globalDailyTokens: 40_000_000, perMinute: 20, endsAt: null, ...limits },
    adminToken,
    ...(fetch || !real ? { fetch: fetch ?? cannedUpstream() } : {}),
  });
  const code = newInviteCode();
  await store.createInvite({ hash: await hashInvite(code), label: "Local tester", dailyTokenLimit: null, expiresAt: null });

  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method: incoming.method,
      headers: Object.entries(incoming.headers).filter(([, value]) => typeof value === "string"),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const reply = await handle(request, { waitUntil() {} });
    outgoing.writeHead(reply.status, Object.fromEntries(reply.headers));
    if (reply.body) Readable.fromWeb(reply.body).pipe(outgoing);
    else outgoing.end();
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    code, store, adminToken,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const gateway = await startLocalGateway({ port: Number(process.env.PORT ?? 8788) });
  console.log(`Moondog gateway: ${gateway.url}`);
  console.log(`Invite code:     ${gateway.code}`);
  console.log(`Use it with:     MOONDOG_MODEL_URL=${gateway.url}/v1`);
}
