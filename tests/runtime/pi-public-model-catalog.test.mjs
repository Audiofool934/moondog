import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiModels } from "../../src/runtime/pi/model-catalog.mjs";
import { PublicPiModelCatalog, PI_CATALOG_VERSION } from "../../src/runtime/pi/public-model-catalog.mjs";
import { supportedPiProviderIds } from "../../src/runtime/pi/provider-registry.mjs";
import { createConfiguredRuntime } from "../../src/runtime/pi/configured-runtime.mjs";
import { readPiRuntimeSelection, writePiRuntimeSelection, resolveMoondogSettingsFile } from "../../src/runtime/pi/runtime-settings.mjs";

const baseline = createPiModels();
const metadata = (provider = "deepseek", id = "fictional-current", overrides = {}) => ({
  ...baseline.getModels(provider)[0], id, name: "Fictional current model", ...overrides,
});
const document = (...models) => Object.fromEntries(models.map(model => [model.id, model]));
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-public-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root };
  const catalog = new PublicPiModelCatalog({ environment, ...options }); await catalog.ready;
  return { root, environment, catalog };
}

test("offline DeepSeek identity is canonical V4.1 with explicit aliases and distinct Pro", () => {
  const models = createPiModels();
  const canonical = models.getModel("deepseek", "deepseek-flash");
  assert.equal(canonical.name, "DeepSeek V4.1 Flash");
  assert.deepEqual(canonical.input, ["text", "image"]);
  assert.equal(canonical.contextWindow, 1_000_000);
  assert.equal(canonical.maxTokens, 384_000);
  assert.equal(canonical.compat.thinkingFormat, "deepseek");
  assert.equal(canonical.compat.requiresReasoningContentOnAssistantMessages, true);
  for (const id of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
    const alias = models.getModel("deepseek", id);
    assert.equal(alias.id, id);
    assert.equal(alias.name, "DeepSeek V4.1 Flash (legacy alias)");
    assert.deepEqual(alias.cost, canonical.cost);
  }
  const pro = models.getModel("deepseek", "deepseek-v4-pro");
  assert.equal(pro.name, "DeepSeek V4 Pro (0813)");
  assert.deepEqual(pro.input, ["text"]);
});

for (const provider of supportedPiProviderIds) {
  test(`compatible public metadata preserves native auth, transport and endpoint for ${provider}`, async t => {
    const native = baseline.getProvider(provider);
    const source = metadata(provider, "fictional-current", { baseUrl: "https://untrusted.invalid", headers: { Authorization: "ATTACKER_HEADER" },
      auth: { command: "UNTRUSTED_COMMAND" }, compat: { ...metadata(provider).compat, supportsMidConvoSystemMessages: true },
      inputLimits: { unrecognized: true } });
    const requests = [];
    const { catalog, root } = await fixture(t, { fetchImpl: async (url, init) => {
      requests.push({ url, ...init }); return Response.json(document(source), { headers: { etag: '"fictional-catalog"' } });
    } });
    const results = await catalog.refresh({ provider });
    assert.equal(results[0].state, "updated");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `https://pi.dev/api/models/providers/${provider}?pi-version=${PI_CATALOG_VERSION}`);
    assert.equal(requests[0].headers.Accept, "application/json");
    assert.match(requests[0].headers["User-Agent"], /^pi\/1\.0\.1 /u);
    assert.equal(requests[0].credentials, "omit");
    assert.equal(requests[0].redirect, "error");
    assert.equal(requests[0].body, undefined);
    assert.equal(requests[0].headers.Authorization, undefined);
    const runtimeModels = catalog.createModels();
    const model = runtimeModels.getModel(provider, source.id);
    assert.equal(model.baseUrl, native.baseUrl ?? native.getModels()[0].baseUrl);
    assert.equal(model.headers, undefined);
    assert.equal(model.auth, undefined);
    assert.equal(model.inputLimits, undefined);
    assert.equal(model.compat.supportsMidConvoSystemMessages, undefined);
    assert.equal(typeof runtimeModels.getProvider(provider).streamSimple, "function");
    assert.deepEqual(Object.keys(runtimeModels.getProvider(provider).auth), Object.keys(native.auth));
    for (const method of Object.keys(native.auth)) {
      assert.equal(runtimeModels.getProvider(provider).auth[method].name, native.auth[method].name);
      assert.equal(typeof runtimeModels.getProvider(provider).auth[method].login, "function");
    }
    assert.ok(catalog.models(provider).some(model => model.id === source.id));
    const cached = await readFile(path.join(root, "model-catalog", `${provider}.json`), "utf8");
    assert.doesNotMatch(cached, /untrusted.invalid|ATTACKER_HEADER|UNTRUSTED_COMMAND/u);
    assert.equal((await stat(path.join(root, "model-catalog", `${provider}.json`))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, "model-catalog"))).mode & 0o777, 0o700);
  });
}

test("fresh cache skips network; stale refresh and 304 reuse the last valid body", async t => {
  let now = 1_000_000; let calls = 0;
  const { environment, catalog } = await fixture(t, { now: () => now, fetchImpl: async (_url, init) => {
    calls++;
    if (calls === 1) return Response.json(document(metadata()), { headers: { etag: '"version1"' } });
    assert.equal(init.headers["If-None-Match"], '"version1"');
    return new Response(null, { status: 304 });
  } });
  assert.equal((await catalog.refresh({ provider: "deepseek" }))[0].state, "updated");
  assert.equal((await catalog.refresh({ provider: "deepseek" }))[0].state, "cached");
  assert.equal(calls, 1);
  now += 4 * 60 * 60 * 1000 + 1;
  assert.equal((await catalog.refresh({ provider: "deepseek" }))[0].state, "unchanged");
  assert.equal(calls, 2);
  const restored = new PublicPiModelCatalog({ environment, now: () => now, fetchImpl: () => { throw new Error("No network allowed"); } });
  await restored.ready;
  assert.equal((await restored.refresh({ provider: "deepseek" }))[0].state, "cached");
  assert.ok(restored.models("deepseek").some(model => model.id === "fictional-current"));
});

for (const kind of ["failed-request", "invalid-json", "oversized-header", "oversized-body", "http-500", "all-incompatible", "slow-headers", "slow-body"]) {
  test(`${kind} refresh retains fallback and the last valid cache`, async t => {
    let fail = false;
    const { catalog, root } = await fixture(t, { fetchImpl: async () => {
      if (!fail) return Response.json(document(metadata()));
      if (kind === "failed-request") throw new Error("PRIVATE_URL_OR_SECRET");
      if (kind === "invalid-json") return new Response("invalid");
      if (kind === "oversized-header") return new Response("{}", { headers: { "content-length": 3 * 1024 * 1024 } });
      if (kind === "oversized-body") return new Response(" ".repeat(2 * 1024 * 1024 + 1));
      if (kind === "http-500") return new Response(null, { status: 500 });
      if (kind === "all-incompatible") return Response.json(document(metadata("deepseek", "bad", { api: "anthropic-messages" })));
      if (kind === "slow-headers") return new Promise(() => {});
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
    } });
    assert.equal((await catalog.refresh({ provider: "deepseek" }))[0].state, "updated");
    // Apply the short fault deadline after seeding a valid cache; parallel CI
    // can take more than 40 ms to perform that successful filesystem write.
    catalog.timeoutMs = 40;
    const cacheFile = path.join(root, "model-catalog", "deepseek.json");
    const before = await readFile(cacheFile, "utf8"); fail = true;
    const result = await catalog.refresh({ provider: "deepseek", force: true });
    assert.equal(result[0].state, "failed");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
    assert.equal(await readFile(cacheFile, "utf8"), before);
    assert.ok(catalog.models("deepseek").some(model => model.id === "fictional-current"));
    assert.ok(catalog.models("deepseek").some(model => model.id === "deepseek-flash"));
  });
}

test("304 without validated cache cannot create an empty catalog", async t => {
  const { catalog, root } = await fixture(t, { fetchImpl: async () => new Response(null, { status: 304 }) });
  assert.equal((await catalog.refresh({ provider: "deepseek" }))[0].state, "failed");
  assert.ok(catalog.models("deepseek").length >= 3);
  assert.deepEqual(await readdir(path.join(root, "model-catalog")), []);
});

test("cancellation rejects promptly, ignores late response and does not publish it", async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const start = new Promise(resolve => { started = resolve; });
  const { catalog, root } = await fixture(t, { fetchImpl: () => { started(); return gate; } });
  const controller = new AbortController();
  const pending = catalog.refresh({ provider: "deepseek", signal: controller.signal });
  await start; controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  release(Response.json(document(metadata())));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!catalog.models("deepseek").some(model => model.id === "fictional-current"));
  assert.deepEqual(await readdir(path.join(root, "model-catalog")), []);
});

test("refresh cannot replace an unsupported OpenRouter API or accept mismatched model identity", async t => {
  const existing = baseline.getModels("openrouter")[0];
  const unsupported = { ...existing, api: "unsupported-api" };
  const good = metadata("openrouter");
  const { catalog } = await fixture(t, { fetchImpl: async () => Response.json({
    ...document(unsupported, good, metadata("openrouter", "wrong-provider", { provider: "deepseek" })),
    "wrong-id": metadata("openrouter", "other-id"),
  }) });
  const [result] = await catalog.refresh({ provider: "openrouter" });
  assert.equal(result.state, "updated"); assert.equal(result.skipped, 3);
  assert.deepEqual(catalog.createModels().getModel("openrouter", existing.id), existing);
  assert.equal(catalog.createModels().getModel("openrouter", good.id).api, good.api);
});

test("saved aliases and omitted remote-only IDs survive refresh without settings or active-model mutation", async t => {
  let generation = 1;
  const { catalog, environment } = await fixture(t, { fetchImpl: async () => Response.json(document(metadata("deepseek", `fictional-${generation}`))) });
  await writePiRuntimeSelection({ provider: "deepseek", model: "deepseek-v4-flash" }, environment);
  const saved = await readFile(resolveMoondogSettingsFile(environment), "utf8");
  await catalog.refresh({ provider: "deepseek" });
  const active = catalog.createModels();
  const activeModel = active.getModel("deepseek", "fictional-1");
  // Existing programmatic/custom provider definitions stay owned by that runtime.
  const custom = { ...active.getProvider("deepseek"), getModels: () => [{ ...activeModel, id: "custom-only", name: "Private custom definition" }] };
  active.setProvider(custom);
  generation++;
  await catalog.refresh({ provider: "deepseek", force: true });
  assert.equal(active.getProvider("deepseek"), custom);
  assert.equal(active.getModel("deepseek", "fictional-2"), undefined);
  assert.equal(activeModel.id, "fictional-1");
  assert.ok(catalog.createModels().getModel("deepseek", "fictional-1"));
  assert.match(catalog.models("deepseek").find(model => model.id === "fictional-1").catalogNote, /retained/u);
  assert.equal(await readFile(resolveMoondogSettingsFile(environment), "utf8"), saved);
  assert.equal((await readPiRuntimeSelection(environment)).model, "deepseek-v4-flash");
});

test("configured runtime restores saved remote models offline and respects an explicit custom models factory", async t => {
  const { catalog, environment } = await fixture(t, { fetchImpl: async () => Response.json(document(metadata())) });
  await catalog.refresh({ provider: "deepseek" });
  await writePiRuntimeSelection({ provider: "deepseek", model: "fictional-current" }, environment);
  const configured = await createConfiguredRuntime({}, { ...environment, DEEPSEEK_API_KEY: "FICTIONAL_KEY" }, { runtimeFactory: value => value });
  assert.equal(configured.model.id, "fictional-current");
  const customModel = { id: "private-model", provider: "private-provider" };
  const customModels = { getProvider: () => ({}), getModel: () => customModel, checkAuth: async () => true };
  const custom = await createConfiguredRuntime({}, environment, {
    selection: { provider: "private-provider", model: "private-model" },
    modelsFactory: () => customModels, runtimeFactory: value => value,
  });
  assert.equal(custom.model, customModel); assert.equal(custom.models, customModels);
});

for (const kind of ["corrupt", "wrong-version", "oversized", "symlink"]) {
  test(`${kind} cache never blocks offline startup or rewrites unrelated files`, async t => {
    const { environment, root } = await fixture(t);
    const dir = path.join(root, "model-catalog"); await mkdir(dir);
    const file = path.join(dir, "deepseek.json");
    if (kind === "symlink") {
      const target = path.join(root, "unrelated.json"); await writeFile(target, "UNCHANGED"); await symlink(target, file);
    } else await writeFile(file, kind === "corrupt" ? "{" : kind === "oversized" ? " ".repeat(2 * 1024 * 1024 + 1) : JSON.stringify({ version: 99 }));
    const catalog = new PublicPiModelCatalog({ environment, fetchImpl: () => { throw new Error("No network"); } });
    await catalog.ready;
    assert.ok(catalog.models("deepseek").some(model => model.id === "deepseek-flash"));
    if (kind === "symlink") assert.equal(await readFile(path.join(root, "unrelated.json"), "utf8"), "UNCHANGED");
  });
}

test("failed cache persistence and a symlink directory keep the last usable catalog", async t => {
  const { environment, root } = await fixture(t);
  const unrelated = path.join(root, "unrelated"); await mkdir(unrelated);
  await symlink(unrelated, path.join(root, "model-catalog"));
  const catalog = new PublicPiModelCatalog({ environment, fetchImpl: async () => Response.json(document(metadata())) });
  await catalog.ready;
  assert.equal((await catalog.refresh({ provider: "deepseek" }))[0].state, "failed");
  assert.deepEqual(await readdir(unrelated), []);
  assert.ok(catalog.models("deepseek").some(model => model.id === "deepseek-flash"));
});

test("all-provider refresh bounds concurrency and never fetches custom provider configuration", async t => {
  let concurrent = 0; let maximum = 0; const requested = [];
  const { catalog } = await fixture(t, { fetchImpl: async url => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    const id = new URL(url).pathname.split("/").at(-1); requested.push(id);
    await new Promise(resolve => setImmediate(resolve)); concurrent--;
    return Response.json(document(metadata(id)));
  } });
  assert.equal((await catalog.refresh({ provider: "private-config" }))[0].state, "unsupported");
  const results = await catalog.refresh();
  assert.equal(results.length, supportedPiProviderIds.length);
  assert.ok(results.every(result => result.state === "updated"));
  assert.ok(maximum <= 3);
  assert.deepEqual(requested.sort(), [...supportedPiProviderIds].sort());
});

test("public latest aliases are supported, while invalid cost metadata cannot replace a working model", async t => {
  const prior = baseline.getModels("openrouter")[0];
  const alias = metadata("openrouter", "~fictional/model-latest");
  const { catalog } = await fixture(t, { fetchImpl: async () => Response.json(document(alias,
    { ...prior, cost: { ...prior.cost, input: -1 } })) });
  const [result] = await catalog.refresh({ provider: "openrouter" });
  assert.equal(result.state, "updated"); assert.equal(result.skipped, 1);
  assert.ok(catalog.createModels().getModel("openrouter", alias.id));
  assert.deepEqual(catalog.createModels().getModel("openrouter", prior.id), prior);
});
