import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { createCodexWebResearch, publicWebUrl, runCodexProcess } from "../../src/integrations/web/codex-web.mjs";
import { runWebCommand } from "../../src/surfaces/cli/web-command.mjs";

const answer = {
  status: "found", summary: "A public music interview.",
  sources: [{ title: "Artist interview", url: "https://example.com/interview", snippet: "A bounded paraphrase.", published_at: null }],
};

function fakeCodex({ events, authCode = 0 } = {}) {
  const calls = [];
  const runProcess = async (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === "exec") return { code: 0, stdout: "--ignore-user-config --ephemeral --output-schema" };
    if (args[0] === "login") return { code: authCode, stdout: "" };
    await access(options.cwd);
    const request = JSON.parse(options.input.split("\n").at(-1));
    for (const event of events ?? [
      { type: "item.completed", item: { type: "agent_message", text: "progress, not the answer" } },
      { type: "item.started", item: { type: "web_search" } },
      { type: "item.completed", item: { type: "web_search", query: request.url ?? request.query, action: { type: request.kind === "read" ? "other" : "search" } } },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(answer) } },
      { type: "turn.completed" },
    ]) options.onEvent(event);
    return { code: 0 };
  };
  return { calls, runProcess };
}

async function service(fake, extra = {}) {
  return createCodexWebResearch({ binary: process.execPath, runProcess: fake.runProcess, environment: {}, ...extra });
}

test("Codex web backend runs a bounded isolated search and reuses only fresh results", async () => {
  const fake = fakeCodex();
  let time = new Date("2026-09-05T00:00:00Z");
  const web = await service(fake, { now: () => time });
  assert.equal(web.publicStatus().state, "configured");
  assert.equal(fake.calls.length, 2);
  const query = "Artist interview $(no-shell-expansion)";
  const result = await web.search({ query });
  assert.equal(result.trust, "untrusted_web_content");
  assert.equal(result.sources[0].url, answer.sources[0].url);
  const call = fake.calls.at(-1);
  assert.equal(call.args.includes(query), false);
  for (const flag of ["--search", "--ephemeral", "--ignore-user-config", "--ignore-rules", "read-only"]) assert.ok(call.args.includes(flag));
  assert.deepEqual(JSON.parse(call.options.input.split("\n").at(-1)), { kind: "search", query });
  await assert.rejects(access(call.options.cwd));
  result.sources[0].title = "mutated by caller";
  assert.equal((await web.search({ query })).sources[0].title, "Artist interview");
  assert.equal((await web.search({ query })).from_cache, true);
  assert.equal(fake.calls.length, 3);
  time = new Date(time.getTime() + 300_001);
  assert.equal((await web.search({ query })).from_cache, false);
  assert.equal(fake.calls.length, 4);
  web.close();
});

test("CLI reader opens the supplied URL and shows attributable summaries", async () => {
  const fake = fakeCodex();
  const web = await service(fake);
  const output = await runWebCommand({ args: ["read", "https://example.com/interview#part"], webResearch: web });
  assert.match(output, /A Codex summary of public pages/);
  assert.match(output, /https:\/\/example.com\/interview/);
  assert.equal(JSON.parse(fake.calls.at(-1).options.input.split("\n").at(-1)).url, "https://example.com/interview");
  await assert.rejects(runWebCommand({ args: ["read", "https://example.com", "extra"], webResearch: web }), /Usage/);
  web.close();
});

test("login is reported without making model calls and unavailable credentials block research", async () => {
  const fake = fakeCodex({ authCode: 1 });
  const web = await service(fake);
  assert.match(await runWebCommand({ args: ["status"], webResearch: web }), /codex login required/);
  await assert.rejects(web.search({ query: "music" }), { code: "web_codex_unavailable" });
  assert.equal(fake.calls.length, 2);
});

test("research cannot claim grounding without a native operation or expose malformed sources", async () => {
  for (const [payload, operation, errorCode] of [
    [answer, null, "web_evidence_missing"],
    [{ ...answer, sources: [] }, "search", "web_output_invalid"],
    [{ ...answer, sources: [{ ...answer.sources[0], url: "file:///tmp/private" }] }, "search", "web_url_invalid"],
  ]) {
    const fake = fakeCodex({ events: [
      ...(operation ? [{ type: "item.completed", item: { type: "web_search", action: { type: operation } } }] : []),
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } },
      { type: "turn.completed" },
    ] });
    const web = await service(fake);
    await assert.rejects(web.search({ query: "music" }), { code: errorCode });
    await assert.rejects(access(fake.calls.at(-1).options.cwd));
  }
  const web = await service(fakeCodex({ events: [{ type: "item.started", item: { type: "command_execution" } }] }));
  await assert.rejects(web.search({ query: "music" }), { code: "web_tool_boundary" });
});

test("reader accepts public pages, rejects local targets, and cannot substitute a search", async () => {
  for (const url of ["http://localhost", "file:///tmp/music", "https://" + "user:password" + "@example.com", "http://" + [127, 0, 0, 1].join("."), "https://example.com:8888"]) {
    assert.throws(() => publicWebUrl(url), { code: "web_url_invalid" });
  }
  const fake = fakeCodex({ events: [
    { type: "item.completed", item: { type: "web_search", query: "https://example.com/interview", action: { type: "search" } } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(answer) } },
    { type: "turn.completed" },
  ] });
  await assert.rejects((await service(fake)).read({ url: "https://example.com/interview" }), { code: "web_evidence_missing" });
});

test("subprocess cancellation and timeout stop a running process", async () => {
  const controller = new AbortController();
  const running = runCodexProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, { code: "web_cancelled" });
  await assert.rejects(runCodexProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 30 }), { code: "web_timeout" });
});
