import assert from "node:assert/strict";
import test from "node:test";
import { createWebResearch } from "../../src/integrations/web/web-research.mjs";
import { projectWebResearchResult } from "../../src/integrations/web/web-result.mjs";
import { runWebCommand } from "../../src/surfaces/cli/web-command.mjs";

const credentials = (stored = {}) => ({ read: async (id) => stored[id] });
// No test reads the listener's own model-roles.json.
const noRoles = async () => ({});
const fakeCodex = (state = "configured") => async () => ({
  publicStatus: () => ({ provider: "codex_cli", state, ...(state === "configured" ? {} : { reason: "codex_login_required" }) }),
  search: async () => { throw new Error("codex search"); }, read: async () => { throw new Error("codex read"); }, close() {},
});

function fakeFetch(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    const { status = 200, body } = respond(String(url), init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch };
}

test("search and reading go to the first service with a key, unless a setting picks one", async () => {
  const pick = async (stored, environment = {}, codex = "configured") => {
    const web = await createWebResearch({ readRoles: noRoles, credentials: credentials(stored), environment, createCodex: fakeCodex(codex), fetch: () => {} });
    const { search, read, state } = web.publicStatus();
    web.close();
    return [search.provider, search.state, read.provider, read.state, state];
  };
  const deepseek = { deepseek: { type: "api_key", key: "sk-test" } };
  assert.deepEqual(await pick(deepseek), ["deepseek", "configured", "deepseek", "configured", "configured"]);
  assert.deepEqual(await pick({}, { BRAVE_SEARCH_API_KEY: "brave-test" }), ["brave", "configured", "codex_cli", "configured", "configured"]);
  assert.deepEqual(await pick({}, { BRAVE_SEARCH_API_KEY: "brave-test" }, "unavailable"), ["brave", "configured", "codex_cli", "unavailable", "partial"]);
  assert.deepEqual(await pick({}, {}, "unavailable"), ["codex_cli", "unavailable", "codex_cli", "unavailable", "unavailable"]);
  assert.deepEqual(await pick(deepseek, { BRAVE_SEARCH_API_KEY: "b", MOONDOG_WEB_SEARCH_PROVIDER: "brave", MOONDOG_WEB_READ_PROVIDER: "codex" }),
    ["brave", "configured", "codex_cli", "configured", "configured"]);
  assert.deepEqual(await pick(deepseek, { MOONDOG_WEB_SEARCH_PROVIDER: "brave" }), ["brave", "unavailable", "deepseek", "configured", "partial"]);
  assert.deepEqual(await pick(deepseek, { MOONDOG_WEB_READ_PROVIDER: "brave" }), ["deepseek", "configured", null, "unavailable", "partial"]);

  const web = await createWebResearch({ readRoles: noRoles, credentials: credentials(), environment: {}, createCodex: fakeCodex("unavailable") });
  const status = await runWebCommand({ args: ["status"], webResearch: web });
  assert.match(status, /\/auth deepseek/);
  assert.match(status, /\/auth brave/);
  web.close();
});

test("DeepSeek searches with the saved key and reads page text, deduplicated and bounded", async () => {
  const result = (title, url, summary) => ({ title, url, summary, snippet: "short", content: "", site_name: null, date: "2025-09-11T16:00:00+00:00", rerank_score: 2, authority: 3 });
  const { calls, fetch } = fakeFetch((url) => url.endsWith("/search")
    ? { body: { results: [
      result("Big Thief interview - Big Thief interview", "https://www.example.com/big-thief#1", "# Big Thief interview\n...\nThe band on <b>Double Infinity</b>."),
      result("Duplicate", "https://www.example.com/big-thief#2", "Another copy."),
      result("Local", "http://localhost/private", "Never shown."),
      result("Mirror", "https://news.example.org/big-thief", "# Big Thief interview\n...\nThe band on <b>Double Infinity</b>."),
    ] } }
    : url.endsWith("/fetch") && calls.at(-1).body.url.includes("gone") ? { status: 404, body: { error: { message: "no content" } } }
    : { body: { title: "Review", content: "\\# Review\n\nA record\\, played loud\\.\n\n![cover](https://example.com/c.jpg)" } });
  const web = await createWebResearch({ readRoles: noRoles, credentials: credentials({ deepseek: { type: "api_key", key: "sk-test" } }), environment: {}, fetch, createCodex: fakeCodex() });

  const found = await web.search({ query: "Big Thief interview" });
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
  assert.deepEqual(calls[0].body, { query: "Big Thief interview", count: 10 });
  assert.equal(found.content_kind, "search_engine_results");
  assert.deepEqual(found.sources, [{ title: "Big Thief interview", url: "https://www.example.com/big-thief", snippet: "Big Thief interview ... The band on Double Infinity.", published_at: "2025-09-12" }]);
  assert.equal(projectWebResearchResult(found).trust, "untrusted_web_content");
  assert.equal((await web.search({ query: "Big Thief interview" })).from_cache, true);
  await assert.rejects(web.search({ query: "x".repeat(129) }), { code: "web_input_invalid" });

  const page = await web.read({ url: "https://example.com/review" });
  assert.equal(page.content_kind, "fetched_page_text");
  assert.equal(page.summary, "# Review\n\nA record, played loud.");
  assert.deepEqual(page.sources, [{ title: "Review", url: "https://example.com/review", snippet: "", published_at: null }]);
  assert.equal((await web.read({ url: "https://example.com/gone" })).status, "unavailable");
  assert.equal(calls.length, 3);
  web.close();
});

test("Brave searches with its own key and reports that it cannot read pages", async () => {
  const { calls, fetch } = fakeFetch(() => ({ body: { web: { results: [{
    title: "Big Thief &amp; friends", url: "https://example.com/tour", description: "Tour dates for <strong>2026</strong>",
    extra_snippets: ["Tickets go on sale Friday."], page_age: "2026-03-01T00:00:00", age: "March 1, 2026",
  }] } } }));
  const web = await createWebResearch({ readRoles: noRoles, credentials: credentials({ brave: { type: "api_key", key: "brave-test" } }), environment: { MOONDOG_WEB_READ_PROVIDER: "brave" }, fetch, createCodex: fakeCodex() });
  const found = await web.search({ query: "Big Thief tour 2026" });
  const request = new URL(calls[0].url);
  assert.equal(request.origin + request.pathname, "https://api.search.brave.com/res/v1/web/search");
  assert.equal(request.searchParams.get("q"), "Big Thief tour 2026");
  assert.equal(calls[0].init.headers["x-subscription-token"], "brave-test");
  assert.deepEqual(found.sources, [{ title: "Big Thief & friends", url: "https://example.com/tour", snippet: "Tour dates for 2026 … Tickets go on sale Friday.", published_at: "2026-03-01T00:00:00" }]);
  await assert.rejects(web.read({ url: "https://example.com/tour" }), { code: "web_provider_unknown" });
  web.close();

  const rejected = await createWebResearch({ readRoles: noRoles, credentials: credentials(), environment: { BRAVE_SEARCH_API_KEY: "old" },
    fetch: fakeFetch(() => ({ status: 401, body: { error: { code: "SUBSCRIPTION_TOKEN_INVALID" } } })).fetch, createCodex: fakeCodex() });
  await assert.rejects(rejected.search({ query: "music" }), { code: "web_key_rejected", message: /\/auth brave/ });
  rejected.close();
});

test("a key saved after startup takes effect on refresh", async () => {
  const stored = {};
  const web = await createWebResearch({ readRoles: noRoles, credentials: credentials(stored), environment: {}, createCodex: fakeCodex("unavailable"), fetch: () => {} });
  assert.equal(web.publicStatus().search.state, "unavailable");
  stored.deepseek = { type: "api_key", key: "sk-new" };
  assert.equal((await web.refresh()).search.provider, "deepseek");
  web.close();
});

test("the web search role picks a service, and the environment still picks over it", async () => {
  const keys = { deepseek: { type: "api_key", key: "sk-test" }, brave: { type: "api_key", key: "brave-test" } };
  const pick = async (role, environment = {}) => {
    const web = await createWebResearch({ readRoles: async () => (role ? { web_search: { service: role } } : {}),
      credentials: credentials(keys), environment, createCodex: fakeCodex(), fetch: () => {} });
    const { search, read } = web.publicStatus();
    const { services, chosen } = await web.services();
    web.close();
    return { search: [search.provider, search.selected_by ?? null], read: [read.provider, read.selected_by ?? null], chosen,
      ready: services.map((service) => [service.id, service.search, service.read]) };
  };
  assert.deepEqual((await pick(null)).search, ["deepseek", null]);
  // Brave only searches, so reading still goes to the first service that can.
  const brave = await pick("brave");
  assert.deepEqual([brave.search, brave.read, brave.chosen], [["brave", "settings"], ["deepseek", null], "brave"]);
  assert.deepEqual(brave.ready, [["deepseek", true, true], ["brave", true, false], ["codex", true, true]]);
  assert.deepEqual((await pick("codex")).read, ["codex_cli", "settings"]);
  assert.deepEqual((await pick("brave", { MOONDOG_WEB_SEARCH_PROVIDER: "deepseek" })).search, ["deepseek", "MOONDOG_WEB_SEARCH_PROVIDER"]);
});

test("a failed search goes on to the next service that is set up, as Hermes Agent rescues one", async () => {
  const { calls, fetch } = fakeFetch((url) => url.includes("deepseek")
    ? { status: 402, body: { error: { message: "Insufficient Balance" } } }
    : { body: { web: { results: [{ title: "Tour", url: "https://example.com/tour", description: "Dates" }] } } });
  const web = await createWebResearch({ readRoles: noRoles, credentials: credentials({ deepseek: { type: "api_key", key: "sk-test" } }),
    environment: { BRAVE_SEARCH_API_KEY: "brave-test" }, fetch, createCodex: fakeCodex() });
  const found = await web.search({ query: "Big Thief tour" });
  assert.deepEqual([found.provider, found.fallback_from, found.sources.length], ["brave", "deepseek", 1]);
  assert.equal(calls.length, 2);
  // Bad input is not retried: every service would refuse it.
  await assert.rejects(web.search({ query: "x".repeat(129) }), { code: "web_input_invalid" });
  assert.equal(calls.length, 2);
  web.close();
});

test("a search gives as many sources as asked, up to ten, and a long page reads on from next_offset", async () => {
  const results = Array.from({ length: 12 }, (_, index) => ({ title: `Page ${index}`, url: `https://example.com/${index}`, summary: `Text ${index}` }));
  const page = Array.from({ length: 4000 }, (_, index) => `Line ${index} of a long interview.`).join("\n");
  const { calls, fetch } = fakeFetch((url) => url.endsWith("/search") ? { body: { results } } : { body: { title: "Interview", content: page } });
  const web = await createWebResearch({ readRoles: noRoles, credentials: credentials({ deepseek: { type: "api_key", key: "sk-test" } }), environment: {}, fetch, createCodex: fakeCodex() });

  assert.equal((await web.search({ query: "interview" })).sources.length, 5);
  assert.equal((await web.search({ query: "interview", limit: 10 })).sources.length, 10);
  await assert.rejects(web.search({ query: "interview", limit: 11 }), { code: "web_input_invalid" });

  const first = await web.read({ url: "https://example.com/interview" });
  assert.equal(first.total_chars, page.length);
  assert.ok(first.summary.length <= 15_000 && first.summary.endsWith("interview."));
  assert.equal(first.truncated, true);
  const pieces = [first.summary];
  let next = first.next_offset;
  while (next !== null) {
    const window = await web.read({ url: "https://example.com/interview", offset: next });
    assert.equal(window.from_cache, true);
    pieces.push(window.summary);
    next = window.next_offset;
  }
  assert.equal(pieces.join(""), page);
  const projected = projectWebResearchResult(first);
  assert.deepEqual([projected.text_offset, projected.total_chars, projected.next_offset], [0, page.length, first.next_offset]);
  await assert.rejects(web.read({ url: "https://example.com/interview", offset: page.length + 1 }), { code: "web_input_invalid" });
  // One search and one fetch: every other answer came from the cache.
  assert.equal(calls.length, 2);
  web.close();
});
