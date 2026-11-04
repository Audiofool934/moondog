import { readModelRoles } from "../../runtime/pi/model-roles.mjs";
import { createPersistentCredentialStore } from "../../runtime/pi/persistent-credential-store.mjs";
import { createBraveWebResearch } from "./brave-web.mjs";
import { createCodexWebResearch } from "./codex-web.mjs";
import { createDeepSeekWebResearch } from "./deepseek-web.mjs";
import { failure, webProviderName } from "./web-result.mjs";

// Search goes to the first backend that is set up; reading needs a backend that can open pages.
// The web search role in Settings (model-roles.json) picks one instead, and MOONDOG_WEB_SEARCH_PROVIDER
// and MOONDOG_WEB_READ_PROVIDER pick over that. As in Hermes Agent, a call that fails on the chosen
// backend is tried once more on each other backend that is set up, so one service being down or out
// of credit doesn't leave the agent without the web.
const order = Object.freeze({ search: ["deepseek", "brave", "codex"], read: ["deepseek", "codex"] });
// Failures that another backend would only repeat.
const final = new Set(["web_cancelled", "web_input_invalid", "web_url_invalid"]);
const providerIds = Object.freeze({ deepseek: "deepseek", brave: "brave", codex: "codex_cli" });
const keys = Object.freeze({
  deepseek: { credential: "deepseek", variable: "DEEPSEEK_API_KEY" },
  brave: { credential: "brave", variable: "BRAVE_SEARCH_API_KEY" },
});

export const webSetupText = [
  "- `/auth deepseek` - DeepSeek Search and Fetch: search and page reading, $0.75 per 1,000 requests each",
  "- `/auth brave` - Brave Search: search only, with a free monthly credit",
  "- Install the Codex CLI and run `codex login` - search and reading through your ChatGPT plan",
].join("\n");

// The same order as Pi uses for model keys: the one saved with /auth, then the environment.
async function readKey(credentials, environment, { credential, variable }) {
  let stored;
  try { stored = await credentials.read(credential); } catch {}
  if (stored?.type === "api_key" && stored.key) return { key: stored.key, source: "stored credential" };
  const value = environment[variable]?.trim();
  return value ? { key: value, source: variable } : null;
}

export async function createWebResearch({
  environment = process.env,
  credentials = createPersistentCredentialStore(environment),
  fetch = globalThis.fetch,
  createCodex = createCodexWebResearch,
  readRoles = readModelRoles,
  now,
} = {}) {
  let current = { backends: {}, choices: {}, found: {} };

  // A backend whose key did not change keeps its cache. A working Codex stays; one that was not ready
  // is checked again, since the listener may have signed in since.
  async function backendFor(name, found, previous) {
    if (name === "codex") {
      const kept = previous?.backends.codex;
      return kept?.publicStatus().state === "configured" ? kept : createCodex({ environment, now });
    }
    const kept = previous?.backends[name] && previous.found[name]?.key === found[name]?.key;
    return kept ? previous.backends[name] : { deepseek: createDeepSeekWebResearch, brave: createBraveWebResearch }[name]({ apiKey: found[name]?.key, fetch, now });
  }

  async function load(previous) {
    const found = {
      deepseek: await readKey(credentials, environment, keys.deepseek),
      brave: await readKey(credentials, environment, keys.brave),
    };
    const role = (await readRoles(environment).catch(() => ({}))).web_search?.service ?? null;
    const choices = {};
    for (const kind of ["search", "read"]) {
      const wanted = environment[`MOONDOG_WEB_${kind.toUpperCase()}_PROVIDER`]?.trim().toLowerCase();
      if (wanted) choices[kind] = order[kind].includes(wanted) ? { name: wanted, selectedBy: `MOONDOG_WEB_${kind.toUpperCase()}_PROVIDER` } : { name: null, reason: "web_provider_unknown", wanted };
      // Brave only searches, so with Brave chosen a read still goes to the first backend that can.
      else if (role && order[kind].includes(role)) choices[kind] = { name: role, selectedBy: "settings" };
      else choices[kind] = { name: order[kind].find((name) => name !== "codex" && found[name]) ?? "codex" };
    }
    const backends = {};
    for (const name of new Set(Object.values(choices).map((choice) => choice.name).filter(Boolean))) {
      backends[name] = await backendFor(name, found, previous);
    }
    return { backends, choices, found };
  }

  // The other backends a failed call can go to: ones with a key, and Codex once it is signed in.
  async function alternatives(kind, tried) {
    const names = [];
    for (const name of order[kind]) {
      if (name === tried) continue;
      if (name !== "codex" && !current.found[name]) continue;
      current.backends[name] ??= await backendFor(name, current.found, null);
      if (name === "codex" && current.backends.codex.publicStatus().state !== "configured") continue;
      names.push(name);
    }
    return names;
  }

  async function research(kind, input, options) {
    const first = backend(kind);
    const name = current.choices[kind].name;
    let failed;
    try {
      const result = await first[kind](input, options);
      // A page the chosen backend could not read may open on another.
      if (kind === "search" || result.status !== "unavailable") return result;
      failed = result;
    } catch (error) {
      if (final.has(error?.code) || options?.signal?.aborted) throw error;
      failed = error;
    }
    for (const other of await alternatives(kind, name)) {
      try {
        const result = await current.backends[other][kind](input, options);
        if (kind === "search" || result.status !== "unavailable") return { ...result, fallback_from: providerIds[name] };
      } catch (error) {
        if (final.has(error?.code) || options?.signal?.aborted) throw error;
      }
    }
    if (failed instanceof Error) throw failed;
    return failed;
  }

  /** Each service, whether it is set up for each operation, and which one the role chose; for Settings. */
  async function services() {
    const role = (await readRoles(environment).catch(() => ({}))).web_search?.service ?? null;
    current.backends.codex ??= await backendFor("codex", current.found, null);
    const codex = current.backends.codex.publicStatus().state === "configured";
    return {
      chosen: role,
      search: operationStatus("search"),
      read: operationStatus("read"),
      services: order.search.map((name) => {
        const ready = name === "codex" ? codex : Boolean(current.found[name]);
        return { id: name, provider: providerIds[name], name: webProviderName(providerIds[name]), ready,
          search: ready, read: ready && order.read.includes(name) };
      }),
    };
  }

  function operationStatus(kind) {
    const choice = current.choices[kind];
    if (!choice?.name) return { provider: null, state: "unavailable", reason: choice?.reason ?? "web_provider_unknown", ...(choice?.wanted ? { requested: choice.wanted } : {}) };
    const provider = providerIds[choice.name];
    const override = choice.selectedBy ? { selected_by: choice.selectedBy } : {};
    if (choice.name === "codex") {
      const codex = current.backends.codex.publicStatus();
      return { provider, state: codex.state, ...(codex.reason ? { reason: codex.reason } : {}), ...override };
    }
    const key = current.found[choice.name];
    return key
      ? { provider, state: "configured", credential: key.source, ...override }
      : { provider, state: "unavailable", reason: `${choice.name}_key_missing`, ...override };
  }

  function publicStatus() {
    const search = operationStatus("search");
    const read = operationStatus("read");
    const ready = [search, read].filter((entry) => entry.state === "configured").length;
    return {
      state: ready === 2 ? "configured" : ready === 1 ? "partial" : "unavailable",
      search, read, access: "public_web_read_only", live_call_verified: false,
    };
  }

  function backend(kind) {
    const choice = current.choices[kind];
    if (choice?.name) return current.backends[choice.name];
    throw failure("web_provider_unknown", `MOONDOG_WEB_${kind.toUpperCase()}_PROVIDER is ${choice?.wanted}, which can't ${kind === "read" ? "read pages" : "search"}. Use ${order[kind].join(" or ")}.`);
  }

  function closeAll() {
    for (const entry of Object.values(current.backends)) entry.close();
  }

  current = await load();
  return {
    publicStatus,
    services,
    search: (input, options) => research("search", input, options),
    read: (input, options) => research("read", input, options),
    /** Reads keys and settings again, after /auth or /reload. */
    async refresh() {
      const previous = current;
      current = await load(previous);
      for (const [name, entry] of Object.entries(previous.backends)) if (current.backends[name] !== entry) entry.close();
      return publicStatus();
    },
    close: closeAll,
  };
}

export { webProviderName };
