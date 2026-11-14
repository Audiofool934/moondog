import assert from "node:assert/strict";
import test from "node:test";

import { createGateway, hashInvite, INVITE_PATTERN, MODEL_ID, newInviteCode, quotaDay } from "../src/gateway.mjs";
import { createMemoryStore } from "../src/store-memory.mjs";

const sse = (events) => new Response(
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      // Split mid-line, as a network does.
      const text = `${events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")}`;
      const cut = Math.floor(text.length / 2);
      controller.enqueue(encoder.encode(text.slice(0, cut)));
      controller.enqueue(encoder.encode(text.slice(cut)));
      controller.close();
    },
  }),
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

async function setup({ upstreamReply, limits = {}, at = Date.UTC(2026, 10, 14, 10) } = {}) {
  const store = createMemoryStore();
  const calls = [];
  const pending = [];
  const handle = createGateway({
    store,
    upstream: { baseUrl: "https://upstream.example/v4", apiKey: "upstream-key", model: "secret-upstream-model", extraBody: {} },
    limits: { dailyTokens: 1000, globalDailyTokens: 5000, perMinute: 20, endsAt: null, ...limits },
    adminToken: "admin-token",
    now: () => at,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return upstreamReply();
    },
  });
  const context = { waitUntil: (promise) => pending.push(promise) };
  const call = (path, { method = "GET", key, body } = {}) => handle(new Request(`https://moondog.example${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), context);
  const created = await (await call("/admin/invites", { method: "POST", key: "admin-token", body: { label: "first tester" } })).json();
  return { store, calls, call, code: created.invites[0].code, settle: () => Promise.all(pending), day: quotaDay(at) };
}

const chatBody = (extra = {}) => ({ model: MODEL_ID, messages: [{ role: "user", content: "play something" }], ...extra });

test("a new invite code has the shape the app accepts", () => {
  assert.match(newInviteCode(), INVITE_PATTERN);
});

test("a stream names the model moondog, hides the upstream and counts its tokens", async () => {
  const { call, calls, code, store, settle, day } = await setup({
    upstreamReply: () => sse([
      { id: "1", model: "secret-upstream-model", choices: [{ delta: { content: "On " } }] },
      { id: "1", model: "secret-upstream-model", choices: [{ delta: { content: "air." } }] },
      { id: "1", model: "secret-upstream-model", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
      "[DONE]",
    ]),
  });
  const reply = await call("/v1/chat/completions", { method: "POST", key: code, body: chatBody({ stream: true }) });
  assert.equal(reply.status, 200);
  const text = await reply.text();
  assert.ok(!text.includes("secret-upstream-model"));
  assert.ok(text.includes(`"model":"${MODEL_ID}"`));
  assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  assert.equal(calls[0].url, "https://upstream.example/v4/chat/completions");
  assert.equal(calls[0].body.model, "secret-upstream-model");
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
  assert.equal(calls[0].headers.authorization, "Bearer upstream-key");
  await settle();
  assert.deepEqual(store.usage.get(`1 ${day}`), { input: 120, output: 30, requests: 1 });
});

test("a plain reply is renamed and counted", async () => {
  const { call, code, store, settle, day } = await setup({
    upstreamReply: () => Response.json({ model: "secret-upstream-model", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
  });
  const reply = await call("/v1/chat/completions", { method: "POST", key: code, body: chatBody() });
  assert.equal((await reply.json()).model, MODEL_ID);
  await settle();
  assert.deepEqual(store.usage.get(`1 ${day}`), { input: 10, output: 2, requests: 1 });
});

test("an unknown or revoked code is refused before the upstream is called", async () => {
  const { call, calls, code } = await setup({ upstreamReply: () => Response.json({}) });
  const unknown = await call("/v1/chat/completions", { method: "POST", key: newInviteCode(), body: chatBody() });
  assert.equal(unknown.status, 401);
  assert.equal((await unknown.json()).error.code, "invite_invalid");
  assert.equal((await call("/admin/invites/1/revoke", { method: "POST", key: "admin-token" })).status, 200);
  const revoked = await call("/v1/chat/completions", { method: "POST", key: code, body: chatBody() });
  assert.equal((await revoked.json()).error.code, "invite_revoked");
  assert.equal(calls.length, 0);
});

test("the daily allowance stops a code until the next day", async () => {
  const { call, code, store, day } = await setup({ upstreamReply: () => Response.json({}) });
  await store.addUsage(1, day, { input: 900, output: 100 });
  const reply = await call("/v1/chat/completions", { method: "POST", key: code, body: chatBody() });
  assert.equal(reply.status, 429);
  assert.equal((await reply.json()).error.code, "daily_allowance_used");
  // 10:00 UTC is 18:00 in Beijing: six hours to midnight there.
  assert.equal(reply.headers.get("retry-after"), String(6 * 3600));
  const status = await (await call("/v1/invite", { key: code })).json();
  assert.equal(status.used_today, 1000);
  assert.equal(status.daily_tokens, 1000);
});

test("the limit for all testers and the per-minute limit refuse with their own codes", async () => {
  const everyone = await setup({ upstreamReply: () => Response.json({}), limits: { dailyTokens: 100000, globalDailyTokens: 500 } });
  await everyone.store.addUsage(7, everyone.day, { input: 500, output: 0 });
  const full = await everyone.call("/v1/chat/completions", { method: "POST", key: everyone.code, body: chatBody() });
  assert.equal((await full.json()).error.code, "beta_capacity_reached");

  const fast = await setup({ upstreamReply: () => Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), limits: { perMinute: 3 } });
  const send = () => fast.call("/v1/chat/completions", { method: "POST", key: fast.code, body: chatBody() });
  assert.deepEqual([(await send()).status, (await send()).status, (await send()).status], [200, 200, 200]);
  const limited = await send();
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "60", "the wait runs to the end of the clock minute");
  assert.equal(fast.calls.length, 3, "a refused request never reaches the upstream");
});

test("an upstream failure never passes the upstream's own words on", async () => {
  const { call, code } = await setup({
    upstreamReply: () => new Response(JSON.stringify({ error: { message: "secret-upstream-model overloaded" } }), { status: 503 }),
  });
  const reply = await call("/v1/chat/completions", { method: "POST", key: code, body: chatBody() });
  assert.equal(reply.status, 503);
  assert.ok(!(await reply.text()).includes("secret-upstream-model"));
});

test("the admin routes need the owner's key and never return a stored code", async () => {
  const { call, code } = await setup({ upstreamReply: () => Response.json({}) });
  assert.equal((await call("/admin/invites", { key: code })).status, 401);
  const listing = await (await call("/admin/invites", { key: "admin-token" })).json();
  assert.equal(listing.invites.length, 1);
  assert.equal(listing.invites[0].label, "first tester");
  assert.ok(!JSON.stringify(listing).includes(code));
  assert.equal(typeof (await hashInvite(code)), "string");
});
