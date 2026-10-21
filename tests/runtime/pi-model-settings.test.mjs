import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createProvider } from "@earendil-works/pi-ai";

import { createPiAuthentication } from "../../src/runtime/pi/authentication.mjs";
import { createPiModels } from "../../src/runtime/pi/model-catalog.mjs";
import { createModelSettings } from "../../src/runtime/pi/model-settings.mjs";
import { PersistentCredentialStore } from "../../src/runtime/pi/persistent-credential-store.mjs";
import { PublicPiModelCatalog } from "../../src/runtime/pi/public-model-catalog.mjs";
import { resolveMoondogSettingsFile, writePiRuntimeSelection } from "../../src/runtime/pi/runtime-settings.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = createPiModels();
const fictional = { ...baseline.getModels("deepseek")[0], id: "fictional-current", name: "Fictional current model" };

async function fixture(t, { environment: extra = {}, fetchImpl, createAuthentication } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-model-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const environment = { MOONDOG_CONFIG_HOME: root, ...extra };
  const requests = [];
  const catalog = new PublicPiModelCatalog({ environment, fetchImpl: async (url, init) => {
    requests.push(url);
    if (fetchImpl) return fetchImpl(url, init);
    return Response.json({ [fictional.id]: fictional });
  } });
  await catalog.ready;
  return {
    root, environment, requests,
    store: new PersistentCredentialStore({ authFile: path.join(root, "auth.json") }),
    settings: createModelSettings({ environment, catalog, createAuthentication }),
  };
}

const scriptedWindow = (answer, { signal } = {}) => {
  const prompts = []; const events = [];
  return { prompts, events, interaction: {
    ...(signal ? { signal } : {}),
    async prompt(prompt) { prompts.push(prompt); return typeof answer === "function" ? answer(prompt) : answer; },
    notify(event) { events.push(event); },
  } };
};

test("providers list the /model picker with sign-in kinds and states, never a key", async t => {
  const { settings, store, environment, requests } = await fixture(t, { environment: { GROQ_API_KEY: "GROQ_ENV_SENTINEL" } });
  await store.modify("deepseek", () => ({ type: "api_key", key: "DEEPSEEK_SAVED_SENTINEL" }));
  await store.modify("openai-codex", () => ({ type: "oauth", access: "ACCESS_SENTINEL", refresh: "REFRESH_SENTINEL",
    accountId: "ACCOUNT_SENTINEL", expires: Date.now() + 60_000 }));
  await writePiRuntimeSelection({ provider: "zai", model: "glm-4.7" }, environment);

  const providers = await settings.providers();
  assert.equal(JSON.stringify(providers).includes("SENTINEL"), false);
  assert.equal(requests.length, 0, "listing providers never fetches");
  // The saved provider comes first, then ChatGPT sign-in, as in the terminal.
  assert.deepEqual(providers.slice(0, 2).map(provider => provider.id), ["zai", "openai-codex"]);
  assert.equal(providers.some(provider => provider.modelCount === 0), false);
  assert.equal(providers.some(provider => provider.id === "typesafe"), false);
  const byId = Object.fromEntries(providers.map(({ id, ...rest }) => [id, rest]));
  for (const provider of providers) {
    assert.deepEqual(Object.keys(provider), ["id", "name", "modelCount", "signIn", "signedIn", "source"]);
  }
  assert.deepEqual(byId.deepseek, { ...byId.deepseek, signIn: "api_key", signedIn: true, source: "saved" });
  assert.deepEqual(byId["openai-codex"], { ...byId["openai-codex"], signIn: "oauth", signedIn: true, source: "saved" });
  assert.deepEqual(byId.groq, { ...byId.groq, signIn: "environment_only", signedIn: true, source: "GROQ_API_KEY" });
  assert.deepEqual(byId.zai, { name: "Z.AI (GLM API)", modelCount: byId.zai.modelCount, signIn: "api_key", signedIn: false, source: null });
  // A window that knows the running provider can put it first instead.
  assert.equal((await settings.providers({ current: "deepseek" }))[0].id, "deepseek");
});

test("signIn saves an API key from a scripted window, and signOut removes it", async t => {
  const { settings, store } = await fixture(t);
  const { prompts, interaction } = scriptedWindow("  sk-WINDOW-SENTINEL\n", { signal: new AbortController().signal });

  const signedIn = await settings.signIn("deepseek", interaction);
  assert.deepEqual(prompts, [{ type: "secret", message: "Enter DeepSeek API key" }]);
  assert.deepEqual(signedIn, { id: "deepseek", name: "DeepSeek", modelCount: signedIn.modelCount,
    signIn: "api_key", signedIn: true, source: "saved" });
  assert.equal(JSON.stringify(signedIn).includes("SENTINEL"), false);
  // The pasted newline is gone, as in the terminal's hidden prompt.
  assert.deepEqual(await store.read("deepseek"), { type: "api_key", key: "sk-WINDOW-SENTINEL" });

  assert.deepEqual(await settings.signOut("deepseek"), { ...signedIn, signedIn: false, source: null });
  assert.equal(await store.read("deepseek"), undefined);
});

test("ChatGPT sign-in gives the window a method choice, the link and a paste field Pi can close", async t => {
  const callbackWon = new AbortController();
  // Shaped like Pi's openai-codex flow, where the browser callback can beat a pasted code.
  const provider = createProvider({ id: "openai-codex", name: "Fictional ChatGPT", models: [],
    api: { stream() { throw new Error("not used"); }, streamSimple() { throw new Error("not used"); } },
    auth: { oauth: { name: "Fictional OAuth",
      async login(interaction) {
        const method = await interaction.prompt({ type: "select", message: "Select login method:", extra: "DROPPED_SENTINEL",
          options: [{ id: "browser", label: "Browser login (default)" }, { id: "device_code", label: "Device code login (headless)" }] });
        assert.equal(method, "browser");
        interaction.notify({ type: "auth_url", url: "https://auth.example.invalid/authorize?state=fictional", instructions: "Complete login." });
        interaction.notify({ type: "unknown", token: "DROPPED_SENTINEL" });
        const pasted = interaction.prompt({ type: "manual_code", message: "Paste the redirect URL:",
          placeholder: "http://localhost:1455/auth/callback", signal: callbackWon.signal });
        callbackWon.abort();
        await assert.rejects(pasted, { name: "AbortError" });
        return { type: "oauth", access: "ACCESS_SENTINEL", refresh: "REFRESH_SENTINEL", accountId: "ACCOUNT_SENTINEL", expires: Date.now() + 60_000 };
      },
      async refresh() { throw new Error("not used"); },
      async toAuth(credential) { return { apiKey: credential.access }; } } } });
  const { settings, store } = await fixture(t, {
    createAuthentication: options => createPiAuthentication({ ...options, providerLoader: async () => provider }) });
  const { prompts, events, interaction } = scriptedWindow(prompt => prompt.type === "select" ? "browser"
    : new Promise((_, reject) => prompt.signal.addEventListener("abort", () => reject(prompt.signal.reason), { once: true })));

  const status = await settings.signIn("openai-codex", interaction);
  assert.deepEqual(prompts.map(prompt => prompt.type), ["select", "manual_code"]);
  assert.deepEqual(prompts[0], { type: "select", message: "Select login method:",
    options: [{ id: "browser", label: "Browser login (default)" }, { id: "device_code", label: "Device code login (headless)" }] });
  assert.equal(prompts[1].placeholder, "http://localhost:1455/auth/callback");
  assert.equal(prompts[1].signal.aborted, true);
  assert.deepEqual(events, [{ type: "auth_url", url: "https://auth.example.invalid/authorize?state=fictional", instructions: "Complete login." }]);
  assert.deepEqual(status, { ...status, id: "openai-codex", signIn: "oauth", signedIn: true, source: "saved" });
  assert.equal(JSON.stringify([status, events, prompts[0]]).includes("SENTINEL"), false);
  assert.equal((await store.read("openai-codex")).refresh, "REFRESH_SENTINEL");
});

test("signOut leaves an environment key in effect", async t => {
  const { settings } = await fixture(t, { environment: { ZAI_API_KEY: "ZAI_ENV_SENTINEL" } });
  await settings.signIn("zai", scriptedWindow("sk-saved").interaction);
  const status = await settings.signOut("zai");
  assert.equal(status.signedIn, true);
  assert.equal(status.source, "ZAI_API_KEY");
});

test("sign-in errors reach the window only as fixed messages", async t => {
  const { settings, store } = await fixture(t);
  const raw = scriptedWindow(() => { throw new Error('HTTP 401 {"error":"RAW_PROVIDER_BODY sk-LEAK-SENTINEL"}'); });
  await assert.rejects(settings.signIn("deepseek", raw.interaction), error => {
    assert.equal(error.code, "auth_login_failed");
    assert.equal(error.message, "deepseek login failed before a credential was saved.");
    assert.equal(error.cause, undefined);
    return true;
  });

  const controller = new AbortController();
  const cancelled = scriptedWindow(() => { controller.abort(); throw new Error("window closed RAW_SENTINEL"); }, { signal: controller.signal });
  await assert.rejects(settings.signIn("deepseek", cancelled.interaction),
    { code: "auth_login_cancelled", message: "deepseek login was cancelled." });

  // The window has no answer: treat it as a cancel, not as an empty key.
  await assert.rejects(settings.signIn("deepseek", scriptedWindow(undefined).interaction), { code: "auth_login_cancelled" });

  const unsupported = scriptedWindow("sk-never");
  await assert.rejects(settings.signIn("groq", unsupported.interaction), { code: "auth_provider_unsupported" });
  await assert.rejects(settings.signOut("groq"), { code: "auth_provider_unsupported" });
  assert.equal(unsupported.prompts.length, 0);
  assert.equal(await store.read("deepseek"), undefined);
});

test("models refresh one provider's public catalog and list effort levels", async t => {
  const { settings, requests } = await fixture(t);
  const result = await settings.models("deepseek");
  assert.equal(result.provider, "deepseek");
  assert.equal(result.refresh.state, "updated");
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/providers\/deepseek\?/u);
  const byId = Object.fromEntries(result.models.map(model => [model.id, model]));
  assert.deepEqual(byId["deepseek-flash"], { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1_000_000,
    reasoning: true, effortLevels: ["off", "low", "high", "max"], retained: true });
  assert.equal(byId["fictional-current"].retained, undefined);
  assert.ok(Array.isArray(byId["fictional-current"].effortLevels));

  // A fresh catalog is not fetched again unless the window forces it.
  assert.equal((await settings.models("deepseek")).refresh.state, "cached");
  assert.equal(requests.length, 1);

  await assert.rejects(settings.models("typesafe"), { code: "model_provider_unknown" });
  await assert.rejects(settings.models("not-a-provider"), { code: "model_provider_unknown" });
});

test("models keep the bundled list when the catalog is unavailable, and honor cancel", async t => {
  const { settings } = await fixture(t, { fetchImpl: async () => new Response("RAW_SENTINEL", { status: 503 }) });
  const result = await settings.models("zai", { force: true });
  assert.deepEqual(result.refresh, { provider: "zai", state: "failed", reason: "unavailable_or_incompatible" });
  assert.ok(result.models.some(model => model.id === "glm-4.7"));
  // Providers Moondog cannot sign in to have no public refresh, but still list models.
  assert.equal((await settings.models("groq")).refresh.state, "unsupported");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(settings.models("deepseek", { force: true, signal: controller.signal }), { name: "AbortError" });
});

test("current reads the saved selection, leaving out a default effort", async t => {
  const { settings, environment } = await fixture(t);
  assert.equal(await settings.current(), null);
  await writePiRuntimeSelection({ provider: "deepseek", model: "deepseek-flash" }, environment);
  assert.deepEqual(await settings.current(), { provider: "deepseek", model: "deepseek-flash" });
  await writePiRuntimeSelection({ provider: "deepseek", model: "deepseek-flash", effort: "high" }, environment);
  assert.deepEqual(await settings.current(), { provider: "deepseek", model: "deepseek-flash", effort: "high" });

  await writeFile(resolveMoondogSettingsFile(environment), "{ not json");
  await assert.rejects(settings.current(), error => {
    assert.equal(error.code, "runtime_settings_invalid");
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("the launcher hands a host without terminal streams modelSettings, and its sign-in paths fail cleanly", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-model-settings-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, "config");
  await mkdir(config, { mode: 0o700 });
  const host = path.join(root, "host.mjs");
  // A desktop host as app/core-process.mjs builds it: a room, a player and no terminal.
  await writeFile(host, `
    const failure = async run => { try { await run(); return null; } catch (error) { return { type: error.constructor.name, message: error.message }; } };
    globalThis[Symbol.for("moondog.host")] = {
      musicPreviewPlayer: null,
      closed() {},
      async runRoom(services) {
        const settings = services.modelSettings;
        const providers = await settings.providers();
        process.stdout.write(JSON.stringify({
          methods: ["current", "providers", "models", "signIn", "signOut"].filter(name => typeof settings[name] === "function"),
          deepseek: providers.find(provider => provider.id === "deepseek"),
          auth: await failure(() => services.runAuth("deepseek")),
          spotify: await failure(() => services.runSpotify(["login"])),
        }));
      },
    };
  `);
  const result = spawnSync(process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", pathToFileURL(host).href, "scripts/moondog.mjs"], {
      cwd: repositoryRoot, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR ?? tmpdir(), HOME: root,
        MOONDOG_CONFIG_HOME: config, MOONDOG_STATE_HOME: path.join(root, "state"),
        MOONDOG_CODEX_BIN: path.join(root, "no-codex"), MOONDOG_LYRICS: "off", MOONDOG_UPDATE_CHECK: "off" },
    });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.methods, ["current", "providers", "models", "signIn", "signOut"]);
  assert.equal(report.deepseek.signIn, "api_key");
  assert.equal(report.deepseek.signedIn, false);
  assert.notEqual(report.auth?.type, "TypeError");
  assert.match(report.auth?.message ?? "", /interactive terminal/u);
  assert.notEqual(report.spotify?.type, "TypeError");
  assert.match(report.spotify?.message ?? "", /not configured/iu);
});
