import { createPersistentCredentialStore } from "../../runtime/pi/persistent-credential-store.mjs";
import { createBraveWebResearch } from "./brave-web.mjs";
import { createCodexWebResearch } from "./codex-web.mjs";
import { createDeepSeekWebResearch } from "./deepseek-web.mjs";
import { failure, webProviderName } from "./web-result.mjs";

// Search goes to the first backend that is set up; reading needs a backend that can open pages.
// MOONDOG_WEB_SEARCH_PROVIDER and MOONDOG_WEB_READ_PROVIDER pick one instead.
const order = Object.freeze({ search: ["deepseek", "brave", "codex"], read: ["deepseek", "codex"] });
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
  now,
} = {}) {
  let current = { backends: {}, choices: {} };

  async function load(previous) {
    const found = {
      deepseek: await readKey(credentials, environment, keys.deepseek),
      brave: await readKey(credentials, environment, keys.brave),
    };
    const choices = {};
    for (const kind of ["search", "read"]) {
      const wanted = environment[`MOONDOG_WEB_${kind.toUpperCase()}_PROVIDER`]?.trim().toLowerCase();
      if (wanted) choices[kind] = order[kind].includes(wanted) ? { name: wanted, override: true } : { name: null, reason: "web_provider_unknown", wanted };
      else choices[kind] = { name: order[kind].find((name) => name !== "codex" && found[name]) ?? "codex" };
    }
    const backends = {};
    for (const name of new Set(Object.values(choices).map((choice) => choice.name).filter(Boolean))) {
      // A backend whose key did not change keeps its cache.
      const create = { deepseek: createDeepSeekWebResearch, brave: createBraveWebResearch }[name];
      if (create) {
        const kept = previous?.backends[name] && previous.found[name]?.key === found[name]?.key;
        backends[name] = kept ? previous.backends[name] : create({ apiKey: found[name]?.key, fetch, now });
      }
      // A working Codex stays; one that was not ready is checked again, since the listener may have signed in since.
      if (name === "codex") {
        const kept = previous?.backends.codex;
        backends.codex = kept?.publicStatus().state === "configured" ? kept : await createCodex({ environment, now });
      }
    }
    return { backends, choices, found };
  }

  function operationStatus(kind) {
    const choice = current.choices[kind];
    if (!choice?.name) return { provider: null, state: "unavailable", reason: choice?.reason ?? "web_provider_unknown", ...(choice?.wanted ? { requested: choice.wanted } : {}) };
    const provider = providerIds[choice.name];
    const override = choice.override ? { selected_by: `MOONDOG_WEB_${kind.toUpperCase()}_PROVIDER` } : {};
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
    search: async (input, options) => backend("search").search(input, options),
    read: async (input, options) => backend("read").read(input, options),
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
