import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { wrapLoginError } from "../../surfaces/cli/auth-command.mjs";
import {
  createPiAuthContext,
  createPiAuthentication,
  supportedAuthProviderIds,
} from "./authentication.mjs";
import { isEndpointProvider, removeEndpoint, saveEndpoint } from "./custom-endpoints.mjs";
import { LEGACY_MODEL_ALIASES } from "./model-catalog.mjs";
import { readConversationModels, readModelList, sameModel, writeConversationModel, writeModelList } from "./model-list.mjs";
import { chatgptProviderId } from "./provider-registry.mjs";
import { createPersistentCredentialStore } from "./persistent-credential-store.mjs";
import { getPublicPiModelCatalog } from "./public-model-catalog.mjs";
import { clampEffort, readPiRuntimeSelection } from "./runtime-settings.mjs";

// The desktop window picks models and signs in through this service, as the
// terminal does with /model and /auth. It returns status shapes only: never a
// credential, a prompt answer or raw provider text.

// The providers every listener is offered, in this order: OpenAI by a ChatGPT subscription or an API
// key, then Anthropic, Google and xAI. Any other service is reached as an endpoint by address; Pi's
// other providers show only once a key for one is saved or in the environment.
const FEATURED = ["openai", "anthropic", "google", "xai"];
// Moondog's own errors carry fixed text. Pi wraps them, and its own text may not be safe.
const moondogErrorNames = new Set(["MoondogCredentialStoreError", "MoondogRuntimeSettingsError"]);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function moondogError(error) {
  for (let current = error; current; current = current.cause) {
    if (moondogErrorNames.has(current.name)) return failure(current.code, current.message);
  }
}

const aborted = () => new DOMException("The sign-in was cancelled.", "AbortError");

function signInKind(providerId) {
  if (isEndpointProvider(providerId)) return "endpoint";
  return supportedAuthProviderIds.includes(providerId) ? "api_key" : "environment_only";
}

// Pi labels where a sign-in came from. Keep "saved" for Moondog's store, an
// environment variable's name, or "environment" for any other ambient source.
function signInSource(auth) {
  if (!auth) return null;
  if (auth.type === "oauth" || auth.source === "stored credential") return "saved";
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(auth.source ?? "") ? auth.source : "environment";
}

// Copy only the fields a window needs, so nothing else Pi adds can reach it.
function promptShape(prompt) {
  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
    ...(prompt.type === "select" ? { options: prompt.options.map(({ id, label, description }) =>
      ({ id, label, ...(description ? { description } : {}) })) } : {}),
    // Pi aborts this signal when the browser callback wins over a pasted code.
    ...(prompt.signal ? { signal: prompt.signal } : {}),
  };
}

function eventShape(event) {
  switch (event?.type) {
    case "auth_url":
      return { type: event.type, url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) };
    case "device_code":
      return { type: event.type, userCode: event.userCode, verificationUri: event.verificationUri,
        ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}) };
    case "progress":
      return { type: event.type, message: event.message };
    case "info":
      return { type: event.type, message: event.message,
        ...(event.links?.length ? { links: event.links.map(({ url, label }) => ({ url, ...(label ? { label } : {}) })) } : {}) };
  }
}

export function createModelSettings({
  environment = process.env,
  catalog: givenCatalog,
  createAuthentication = createPiAuthentication,
} = {}) {
  const catalog = async () => givenCatalog ?? getPublicPiModelCatalog(environment);

  const current = async () => {
    try {
      return (await readPiRuntimeSelection(environment)) ?? null;
    } catch (error) {
      throw moondogError(error) ?? failure("runtime_settings_invalid", "Moondog could not read runtime settings.");
    }
  };

  const listed = (source) => source.providers().filter(provider => provider.modelCount > 0);
  const withAuth = (source) => source.createModels({
    credentials: createPersistentCredentialStore(environment),
    authContext: createPiAuthContext(environment),
  });

  const rows = async (source, providers) => {
    try {
      const models = withAuth(source);
      return await Promise.all(providers.map(async ({ id, name, modelCount }) => {
        // checkAuth reads only local state. It never refreshes OAuth or calls a provider.
        const auth = await models.checkAuth(id);
        const endpoint = source.endpoints?.find(entry => entry.id === id);
        // OpenAI takes a ChatGPT sign-in as well as a key; method says which one it has.
        return { id, name, modelCount, signIn: signInKind(id), signedIn: Boolean(auth), source: signInSource(auth),
          ...(id === chatgptProviderId ? { chatgpt: true } : {}), ...(auth ? { method: auth.type === "oauth" ? "oauth" : "api_key" } : {}),
          ...(endpoint ? { endpoint: { format: endpoint.format, baseUrl: endpoint.baseUrl, keySaved: Boolean(endpoint.key), models: [...endpoint.models] } } : {}) };
      }));
    } catch (error) {
      throw moondogError(error) ?? failure("auth_status_failed", "Moondog could not read its saved sign-ins.");
    }
  };

  const row = async (providerId) => {
    const source = await catalog();
    return (await rows(source, listed(source).filter(provider => provider.id === providerId)))[0];
  };

  // The models the window's menu offers: the saved list, or the default alone until the listener
  // changes it. The default is always among them.
  const menu = async (selection) => {
    let entries;
    try {
      entries = await readModelList(environment);
    } catch (error) {
      throw moondogError(error) ?? failure("model_list_invalid", "Moondog could not read its model list.");
    }
    entries ??= [];
    if (selection && !entries.some(entry => sameModel(entry, selection))) entries = [{ provider: selection.provider, model: selection.model }, ...entries];
    return entries;
  };

  const assertSignInProvider = (providerId) => {
    if (!supportedAuthProviderIds.includes(providerId)) {
      throw failure("auth_provider_unsupported", "Moondog can't save a sign-in for this provider. Set its API key in the environment instead.");
    }
  };

  return {
    current,

    // Settings' providers: the featured ones in their order, then any other provider that has a key or
    // is in use, by name, then the listener's endpoints in the order they were added.
    async providers({ current: currentProvider } = {}) {
      currentProvider ??= (await current().catch(() => null))?.provider;
      const source = await catalog();
      const all = await rows(source, listed(source));
      const featured = FEATURED.map(id => all.find(provider => provider.id === id)).filter(Boolean);
      const others = all.filter(provider => !FEATURED.includes(provider.id) && provider.signIn !== "endpoint" &&
        (provider.signedIn || provider.id === currentProvider)).sort((left, right) => left.name.localeCompare(right.name));
      const endpoints = (source.endpoints ?? []).map(endpoint => all.find(provider => provider.id === endpoint.id)).filter(Boolean);
      return [...featured, ...others, ...endpoints];
    },

    // The menu's models, each with its provider's name and whether it can answer now, and the default
    // with the thinking level it asks for and the one its model gets.
    async list() {
      const selection = await current();
      const source = await catalog();
      const entries = await menu(selection);
      let models;
      try {
        models = withAuth(source);
      } catch (error) {
        throw moondogError(error) ?? failure("auth_status_failed", "Moondog could not read its saved sign-ins.");
      }
      const names = new Map(source.providers().map(provider => [provider.id, provider.name]));
      const ready = new Map();
      for (const provider of new Set(entries.map(entry => entry.provider))) {
        ready.set(provider, Boolean(await models.checkAuth(provider).catch(() => undefined)));
      }
      const thinks = model => Boolean(model) && getSupportedThinkingLevels(model).length > 1;
      const defaultModel = selection && models.getModel(selection.provider, selection.model);
      return {
        models: entries.map(entry => {
          const model = models.getModel(entry.provider, entry.model);
          return { provider: entry.provider, model: entry.model, name: model?.name ?? entry.model,
            providerName: names.get(entry.provider) ?? entry.provider, ready: Boolean(model) && ready.get(entry.provider) === true,
            reasoning: thinks(model) };
        }),
        default: selection ? { provider: selection.provider, model: selection.model, effort: selection.effort ?? null,
          reasoning: thinks(defaultModel), thinking: selection.effort && defaultModel ? clampEffort(defaultModel, selection.effort) : null } : null,
      };
    },

    // The model each conversation was given in the window's menu, and a change to one: null gives a
    // conversation back to the default.
    conversationModels: () => readConversationModels(environment),
    setConversationModel: (session, selection) => writeConversationModel(String(session), selection ?? null, environment),

    // Adds a model to the menu or takes it off. The default stays.
    async setListed(provider, model, listed) {
      const selection = await current();
      const entry = { provider: String(provider ?? "").trim().toLowerCase(), model: String(model ?? "").trim() };
      if (!listed && sameModel(entry, selection)) return;
      const entries = await menu(selection);
      const next = listed ? (entries.some(kept => sameModel(kept, entry)) ? entries : [...entries, entry])
        : entries.filter(kept => !sameModel(kept, entry));
      try {
        await writeModelList(next, environment);
      } catch (error) {
        throw moondogError(error) ?? failure("model_list_invalid", "Moondog could not save its model list.");
      }
    },

    // A new endpoint whose model IDs were typed goes straight into the menu with them; listed ones
    // wait to be chosen, since an endpoint such as OpenRouter lists hundreds.
    async saveEndpoint(input) {
      let saved;
      try {
        saved = await saveEndpoint(input, environment);
      } catch (error) {
        throw moondogError(error) ?? failure("endpoint_save_failed", "Moondog could not save that endpoint.");
      }
      if (!input?.id && saved.typedModels) {
        const entries = await menu(await current());
        const added = saved.endpoint.models.map(model => ({ provider: saved.endpoint.id, model }));
        await writeModelList([...entries, ...added.filter(entry => !entries.some(kept => sameModel(kept, entry)))].slice(0, 40), environment);
      }
      await (await catalog()).readEndpoints?.();
      return saved.endpoint;
    },

    // Removes an endpoint, its key and its models from the menu. A default on it stays saved, and asks
    // for another model until one is chosen.
    async removeEndpoint(id) {
      try {
        await removeEndpoint(id, environment);
      } catch (error) {
        throw moondogError(error) ?? failure("endpoint_remove_failed", "Moondog could not remove that endpoint.");
      }
      const selection = await current();
      const entries = await menu(null);
      const kept = entries.filter(entry => entry.provider !== id || sameModel(entry, selection));
      if (kept.length !== entries.length) await writeModelList(kept, environment);
      await (await catalog()).readEndpoints?.();
    },

    async models(providerId, { force = false, signal } = {}) {
      const source = await catalog();
      if (!listed(source).some(provider => provider.id === providerId)) {
        throw failure("model_provider_unknown", "Moondog doesn't know that model provider.");
      }
      let refresh;
      try {
        // Public pi.dev metadata, without credentials. A failure keeps the retained list.
        [refresh] = await source.refresh({ provider: providerId, force, signal });
      } catch {
        if (signal?.aborted) throw signal.reason;
        refresh = { provider: providerId, state: "failed" };
      }
      const full = source.createModels();
      return {
        provider: providerId,
        refresh,
        models: source.models(providerId).filter(({ id }) => !LEGACY_MODEL_ALIASES.includes(id)).map(({ id, name, contextWindow, reasoning, catalogNote }) => {
          const model = full.getModel(providerId, id);
          return { id, name, ...(contextWindow ? { contextWindow } : {}), reasoning,
            effortLevels: model ? getSupportedThinkingLevels(model) : [],
            ...(catalogNote ? { retained: true } : {}) };
        }),
      };
    },

    // method "oauth" signs in to OpenAI with ChatGPT; anything else asks for a key.
    async signIn(providerId, interaction, { method } = {}) {
      assertSignInProvider(providerId);
      if (typeof interaction?.prompt !== "function" || typeof interaction.notify !== "function") {
        throw failure("auth_interaction_invalid", "Sign-in needs a way to ask and to show progress.");
      }
      const { signal } = interaction;
      try {
        const authentication = await createAuthentication({ environment });
        await authentication.login(providerId, {
          ...(signal ? { signal } : {}),
          async prompt(prompt) {
            const answer = await interaction.prompt(promptShape(prompt));
            if (typeof answer !== "string") throw aborted();
            // A pasted key often ends in a newline, and the store refuses whitespace.
            return prompt.type === "secret" ? answer.trim() : answer;
          },
          notify(event) {
            const shape = eventShape(event);
            if (!shape) return;
            try { interaction.notify(shape); } catch { /* A closed window cannot stop the sign-in. */ }
          },
        }, { method: method === "oauth" ? "oauth" : "api_key" });
      } catch (error) {
        const safe = wrapLoginError(signal?.aborted ? aborted() : moondogError(error) ?? error, providerId);
        throw failure(safe.code, safe.message);
      }
      return row(providerId);
    },

    // Removes only Moondog's saved sign-in. An environment key stays in effect.
    async signOut(providerId) {
      assertSignInProvider(providerId);
      try {
        await (await createAuthentication({ environment })).logout(providerId);
      } catch (error) {
        throw moondogError(error) ?? failure("auth_logout_failed", "Moondog could not remove that saved sign-in.");
      }
      return row(providerId);
    },
  };
}
