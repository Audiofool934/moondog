import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfiguredRuntime } from "../../src/runtime/pi/configured-runtime.mjs";
import { discoverModels, normalizeBaseUrl, readEndpoints, saveEndpoint } from "../../src/runtime/pi/custom-endpoints.mjs";
import { createPiModels } from "../../src/runtime/pi/model-catalog.mjs";
import { createModelSettings } from "../../src/runtime/pi/model-settings.mjs";
import { PersistentCredentialStore } from "../../src/runtime/pi/persistent-credential-store.mjs";
import { PublicPiModelCatalog } from "../../src/runtime/pi/public-model-catalog.mjs";
import { clampEffort, writePiRuntimeSelection } from "../../src/runtime/pi/runtime-settings.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-model-list-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const environment = { MOONDOG_CONFIG_HOME: root };
  // The public catalog is never reachable here, so every list is Pi's bundled one.
  const catalog = new PublicPiModelCatalog({ environment, fetchImpl: async () => new Response("{}", { status: 503 }) });
  await catalog.ready;
  const store = new PersistentCredentialStore({ authFile: path.join(root, "auth.json") });
  await store.modify("anthropic", () => ({ type: "api_key", key: "ANTHROPIC_SENTINEL" }));
  return { root, environment, store, settings: createModelSettings({ environment, catalog }) };
}

test("the menu starts as the default, keeps the default, and adds and drops the rest", async t => {
  const { environment, settings } = await fixture(t);
  await writePiRuntimeSelection({ provider: "anthropic", model: "claude-opus-5-5", effort: "medium" }, environment);
  let list = await settings.list();
  assert.deepEqual(list.models.map(entry => entry.model), ["claude-opus-5-5"]);
  assert.deepEqual(list.default, { provider: "anthropic", model: "claude-opus-5-5", effort: "medium", reasoning: true, thinking: "medium" });

  await settings.setListed("anthropic", "claude-sonnet-5-5", true);
  await settings.setListed("openai", "gpt-5", true);
  await settings.setListed("anthropic", "claude-opus-5-5", false);
  list = await settings.list();
  assert.deepEqual(list.models.map(entry => [entry.model, entry.ready]),
    [["claude-opus-5-5", true], ["claude-sonnet-5-5", true], ["gpt-5", false]], "a model without a key stays listed, not ready");
  await settings.setListed("anthropic", "claude-sonnet-5-5", false);
  assert.deepEqual((await settings.list()).models.map(entry => entry.model), ["claude-opus-5-5", "gpt-5"]);
});

test("an endpoint keeps its key private, never sends it to a new address, and joins the catalog", async t => {
  const { root, environment, settings } = await fixture(t);
  await writePiRuntimeSelection({ provider: "anthropic", model: "claude-opus-5-5" }, environment);
  const saved = await settings.saveEndpoint({ name: "Gateway", format: "openai", baseUrl: "https://gateway.example/v1/chat/completions",
    key: " sk-GATEWAY-SENTINEL ", models: "deepseek-flash, house-model" });
  assert.equal(saved.id, "endpoint-gateway");
  assert.equal(saved.baseUrl, "https://gateway.example/v1");
  assert.equal(saved.keySaved, true);
  assert.equal(JSON.stringify(saved).includes("SENTINEL"), false);
  assert.equal((await stat(path.join(root, "endpoints.json"))).mode & 0o777, 0o600);
  // auth.json keeps only the providers older Moondogs know.
  assert.equal((await readFile(path.join(root, "auth.json"), "utf8")).includes("GATEWAY"), false);

  // Typed model IDs go straight into the menu.
  const list = await settings.list();
  assert.deepEqual(list.models.map(entry => `${entry.provider}/${entry.model}`),
    ["anthropic/claude-opus-5-5", "endpoint-gateway/deepseek-flash", "endpoint-gateway/house-model"]);
  const providers = await settings.providers();
  const row = providers.at(-1);
  assert.equal(row.id, "endpoint-gateway");
  assert.equal(row.signIn, "endpoint");
  assert.equal(JSON.stringify(providers).includes("SENTINEL"), false);

  // A model Pi knows keeps its name and thinking levels; an unknown one is plain text.
  const { models } = await settings.models("endpoint-gateway");
  assert.deepEqual(models.map(entry => [entry.id, entry.name, entry.reasoning]),
    [["deepseek-flash", "DeepSeek V4.1 Flash", true], ["house-model", "house-model", false]]);

  // Same address, blank key: the key stays. A new address needs the key again.
  await settings.saveEndpoint({ id: saved.id, name: "Gateway", format: "openai", baseUrl: "https://gateway.example/v1", key: "", models: "house-model" });
  assert.equal((await readEndpoints(environment))[0].key, "sk-GATEWAY-SENTINEL");
  await settings.saveEndpoint({ id: saved.id, name: "Gateway", format: "openai", baseUrl: "https://other.example/v1", key: "", models: "house-model" });
  assert.equal((await readEndpoints(environment))[0].key, undefined);

  await settings.removeEndpoint(saved.id);
  assert.deepEqual(await readEndpoints(environment), []);
  assert.deepEqual((await settings.list()).models.map(entry => entry.provider), ["anthropic"]);
});

test("an endpoint's address is normalized and checked, and its models can be discovered", async t => {
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/", "openai"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/anthropic/v1/messages", "anthropic"), "https://api.example.com/anthropic");
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1", "openai"), "http://localhost:11434/v1");
  for (const bad of ["http://example.com/v1", "https://someone@example.com", "https://example.com/v1?key=1", "not a url"]) {
    assert.throws(() => normalizeBaseUrl(bad, "openai"), { code: "endpoint_url_invalid" }, bad);
  }

  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, redirect: init.redirect });
    return Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] });
  };
  assert.deepEqual(await discoverModels({ format: "openai", baseUrl: "https://api.example.com/v1", key: "k" }, { fetchImpl }), ["model-a", "model-b"]);
  assert.equal(seen[0].url, "https://api.example.com/v1/models");
  assert.equal(seen[0].headers.Authorization, "Bearer k");
  assert.equal(seen[0].redirect, "error");
  await discoverModels({ format: "anthropic", baseUrl: "https://api.example.com", key: "k" }, { fetchImpl });
  assert.match(seen[1].url, /^https:\/\/api\.example\.com\/v1\/models/u);
  assert.equal(seen[1].headers["x-api-key"], "k");

  const failing = async () => new Response("nope", { status: 401 });
  await assert.rejects(discoverModels({ format: "openai", baseUrl: "https://api.example.com/v1" }, { fetchImpl: failing }), { code: "endpoint_models_unavailable" });

  // Without typed IDs, saving asks the endpoint.
  const root = await mkdtemp(path.join(tmpdir(), "moondog-endpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saved = await saveEndpoint({ name: "Local", baseUrl: "http://127.0.0.1:1234/v1" }, { MOONDOG_CONFIG_HOME: root },
    { discover: async () => ["local-a"] });
  assert.deepEqual(saved.endpoint.models, ["local-a"]);
  assert.equal(saved.typedModels, false);
});

test("every thinking level reaches a model as the nearest one it has, never more", async () => {
  const models = createPiModels();
  const flash = models.getModel("deepseek", "deepseek-flash");
  const opus = models.getModel("anthropic", "claude-opus-5-5");
  const grok = models.getModel("xai", "grok-4.7");
  assert.equal(clampEffort(flash, "medium"), "low");
  assert.equal(clampEffort(flash, "xhigh"), "high");
  assert.equal(clampEffort(opus, "xhigh"), "xhigh");
  // Off on a model that always thinks is its lightest level.
  assert.equal(clampEffort(opus, "off"), "low");
  assert.equal(clampEffort(grok, "max"), "xhigh");
  const pro = models.getModel("deepseek", "deepseek-v4-pro");
  assert.equal(clampEffort(pro, "low"), "high", "with nothing lighter, the lightest it has");
});

test("a conversation's runtime asks for the clamped level and reports both", async t => {
  const { environment } = await fixture(t);
  const runtime = await createConfiguredRuntime({}, environment, {
    selection: { provider: "anthropic", model: "claude-opus-5-5", effort: "off" },
    runtimeFactory: configuration => ({ configuration }),
  });
  assert.equal(runtime.configuration.effort, "off");
  assert.equal(runtime.configuration.thinkingLevel, "low");
});
