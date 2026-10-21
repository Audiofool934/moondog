import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { wrapLoginError } from "../../surfaces/cli/auth-command.mjs";
import {
  createPiAuthContext,
  createPiAuthentication,
  supportedAuthProviderIds,
} from "./authentication.mjs";
import { createPersistentCredentialStore } from "./persistent-credential-store.mjs";
import { getPublicPiModelCatalog } from "./public-model-catalog.mjs";
import { readPiRuntimeSelection } from "./runtime-settings.mjs";

// The desktop window picks models and signs in through this service, as the
// terminal does with /model and /auth. It returns status shapes only: never a
// credential, a prompt answer or raw provider text.

const OAUTH_PROVIDER = "openai-codex";
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
  if (providerId === OAUTH_PROVIDER) return "oauth";
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

  // The same list as the terminal's /model picker: providers with models, the
  // current one first, then ChatGPT sign-in, then by name.
  const listed = (source, currentProvider) => source.providers()
    .filter(provider => provider.modelCount > 0)
    .sort((left, right) => {
      const priority = provider => provider.id === currentProvider ? 0 : provider.id === OAUTH_PROVIDER ? 1 : 2;
      return priority(left) - priority(right) || left.name.localeCompare(right.name);
    });

  const rows = async (source, providers) => {
    try {
      const models = source.createModels({
        credentials: createPersistentCredentialStore(environment),
        authContext: createPiAuthContext(environment),
      });
      return await Promise.all(providers.map(async ({ id, name, modelCount }) => {
        // checkAuth reads only local state. It never refreshes OAuth or calls a provider.
        const auth = await models.checkAuth(id);
        return { id, name, modelCount, signIn: signInKind(id), signedIn: Boolean(auth), source: signInSource(auth) };
      }));
    } catch (error) {
      throw moondogError(error) ?? failure("auth_status_failed", "Moondog could not read its saved sign-ins.");
    }
  };

  const row = async (providerId) => {
    const source = await catalog();
    return (await rows(source, listed(source).filter(provider => provider.id === providerId)))[0];
  };

  const assertSignInProvider = (providerId) => {
    if (!supportedAuthProviderIds.includes(providerId)) {
      throw failure("auth_provider_unsupported", "Moondog can't save a sign-in for this provider. Set its API key in the environment instead.");
    }
  };

  return {
    current,

    async providers({ current: currentProvider } = {}) {
      currentProvider ??= (await current().catch(() => null))?.provider;
      const source = await catalog();
      return rows(source, listed(source, currentProvider));
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
        models: source.models(providerId).map(({ id, name, contextWindow, reasoning, catalogNote }) => {
          const model = full.getModel(providerId, id);
          return { id, name, ...(contextWindow ? { contextWindow } : {}), reasoning,
            effortLevels: model ? getSupportedThinkingLevels(model) : [],
            ...(catalogNote ? { retained: true } : {}) };
        }),
      };
    },

    async signIn(providerId, interaction) {
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
        });
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
