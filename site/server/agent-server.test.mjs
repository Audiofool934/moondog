// Runs the public agent against Pi's fake model provider: no network, no key, no cost.
//   node --test site/server/
import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configFromEnvironment, startAgentServer } from "./agent-server.mjs";
import { DailyLimits } from "./limits.mjs";

const origin = "http://localhost:8737";

async function start(t, overrides = {}, { verifyHuman, musicCatalog } = {}) {
  const faux = fauxProvider();
  const config = { ...configFromEnvironment({}), port: 0, host: "127.0.0.1", origins: [origin], provider: "faux", model: "faux-1", ...overrides };
  const agent = await startAgentServer(config, {
    modelsFactory: () => { const models = createModels(); models.setProvider(faux.provider); return models; },
    log: () => {},
    ...(verifyHuman ? { verifyHuman } : {}),
    ...(musicCatalog ? { musicCatalog } : {}),
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

test("with a Turnstile secret, a conversation starts only after Cloudflare confirms the token", async (t) => {
  const checked = [];
  const { call } = await start(t, { turnstileSecret: "secret" }, {
    verifyHuman: async ({ token }) => { checked.push(token); return token === "good"; },
  });
  const open = (body) => call("/v1/sessions", { method: "POST", body: JSON.stringify(body) });
  const refused = await open({});
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error.text, /confirm you're a person/u);
  assert.equal((await open({ turnstileToken: "bad" })).status, 403);
  assert.equal((await open({ turnstileToken: "good" })).status, 201);
  assert.deepEqual(checked, ["bad", "good"]);
});

test("the day's spending survives a restart, and a new day starts from zero", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "moondog-limits-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const stateFile = path.join(folder, "daily-limits.json");
  const options = { dailyBudgetUsd: 3, sessionsPerAddress: 6, turnsPerAddress: 30, stateFile };
  let clock = Date.parse("2026-10-07T12:00:00Z");
  const first = new DailyLimits({ ...options, now: () => clock });
  first.claimTurn("203.0.113.9");
  first.spend(2.5);
  assert.doesNotMatch(await readFile(stateFile, "utf8"), /203\.0\.113\.9/u, "addresses stay in memory");
  const restarted = new DailyLimits({ ...options, now: () => clock });
  assert.equal(restarted.budgetLeft(), 0.5);
  assert.equal(restarted.summary().turns, 1);
  clock = Date.parse("2026-10-08T00:00:01Z");
  const nextDay = new DailyLimits({ ...options, now: () => clock });
  assert.equal(nextDay.budgetLeft(), 3);
});

test("a preview the agent plays reaches the page as a stream event", async (t) => {
  const track = { title: "Wind of Change", artist_credit: "Scorpions", release: "Crazy World", preview_url: "https://audio-ssl.itunes.apple.com/itunes-assets/original.m4a", catalog_url: "https://music.apple.com/us/album/crazy-world/2" };
  const musicCatalog = {
    async findPreview(input) { assert.deepEqual(input, { title: "Wind of Change", artist: "Scorpions" }); return { state: "resolved", source: {}, track }; },
    async searchTracks() { return { state: "not_found", source: {}, queries: [], result_count: 0, tracks: [] }; },
    async findArtistReleases() { return { state: "not_found" }; },
  };
  const { faux, turn, open } = await start(t, {}, { musicCatalog });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_music_preview", { title: "Wind of Change", artist: "Scorpions" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Here's a 30-second preview.")]),
  ]);
  const events = await turn(await open(), "Play Wind of Change by Scorpions");
  const preview = events.find((event) => event.type === "preview");
  assert.equal(preview.track.preview_url, track.preview_url);
  assert.equal(preview.track.catalog_url, track.catalog_url);
  assert.equal(events.at(-1).result.text, "Here's a 30-second preview.");
});
