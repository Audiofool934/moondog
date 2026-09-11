import { access } from "node:fs/promises";
import { homedir } from "node:os";

import { createModels } from "@earendil-works/pi-ai";

import { createPersistentCredentialStore } from "./persistent-credential-store.mjs";
import { apiKeyPiProviderIds, loadPiProvider } from "./provider-registry.mjs";

export const supportedAuthProviderIds = Object.freeze([
  "openai-codex",
  ...apiKeyPiProviderIds,
]);

export function createPiAuthContext(environment = process.env) {
  return {
    async env(name) {
      const value = environment[name];
      return typeof value === "string" && value.trim().length > 0
        ? value
        : undefined;
    },
    async fileExists(filePath) {
      try {
        await access(
          filePath.startsWith("~") ? homedir() + filePath.slice(1) : filePath,
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

function assertSupportedProvider(providerId) {
  if (!supportedAuthProviderIds.includes(providerId)) {
    const error = new Error(
      "Moondog authentication does not support this provider.",
    );
    error.code = "auth_provider_unsupported";
    throw error;
  }
}

export async function createPiAuthentication({
  environment = process.env,
  credentials = createPersistentCredentialStore(environment),
  providerLoader = loadPiProvider,
  modelsFactory = createModels,
} = {}) {
  const models = modelsFactory({
    credentials,
    authContext: createPiAuthContext(environment),
  });
  const loadedProviders = new Set();

  const ensureProvider = async (providerId) => {
    assertSupportedProvider(providerId);
    if (loadedProviders.has(providerId)) return;
    const provider = await providerLoader(providerId);
    if (!provider) {
      const error = new Error(
        `The configured Pi dependency does not provide ${providerId}.`,
      );
      error.code = "auth_provider_unavailable";
      throw error;
    }
    models.setProvider(provider);
    loadedProviders.add(providerId);
  };

  const status = async (providerId) => {
    await ensureProvider(providerId);
    const auth = await models.checkAuth(providerId);
    const fromEnvironment = auth?.type === "api_key" &&
      auth.source !== "stored credential";
    return {
      provider: providerId,
      state: auth ? (fromEnvironment ? "environment" : "stored") : "not_configured",
      type: auth?.type ?? null,
      ...(fromEnvironment ? { source: auth.source } : {}),
    };
  };

  return {
    async login(providerId, interaction) {
      await ensureProvider(providerId);
      await models.login(
        providerId,
        providerId === "openai-codex" ? "oauth" : "api_key",
        interaction,
      );
      return status(providerId);
    },

    status,

    async logout(providerId) {
      await ensureProvider(providerId);
      await models.logout(providerId);
      return status(providerId);
    },
  };
}
