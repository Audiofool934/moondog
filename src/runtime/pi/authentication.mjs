import { createModels } from "@earendil-works/pi-ai";

import { createPersistentCredentialStore } from "./persistent-credential-store.mjs";
import { loadPiProvider } from "./provider-registry.mjs";

export const supportedAuthProviderIds = Object.freeze(["openai-codex"]);

function assertSupportedProvider(providerId) {
  if (!supportedAuthProviderIds.includes(providerId)) {
    const error = new Error(
      `Moondog authentication does not support provider ${providerId}.`,
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
  const models = modelsFactory({ credentials });

  for (const providerId of supportedAuthProviderIds) {
    const provider = await providerLoader(providerId);
    if (!provider) {
      const error = new Error(
        `The configured Pi dependency does not provide ${providerId}.`,
      );
      error.code = "auth_provider_unavailable";
      throw error;
    }
    models.setProvider(provider);
  }

  const status = async (providerId) => {
    assertSupportedProvider(providerId);
    const auth = await models.checkAuth(providerId);
    return {
      provider: providerId,
      state: auth ? "stored" : "not_configured",
      type: auth?.type ?? null,
    };
  };

  return {
    async login(providerId, interaction) {
      assertSupportedProvider(providerId);
      await models.login(providerId, "oauth", interaction);
      return status(providerId);
    },

    status,

    async logout(providerId) {
      assertSupportedProvider(providerId);
      await models.logout(providerId);
      return status(providerId);
    },
  };
}
