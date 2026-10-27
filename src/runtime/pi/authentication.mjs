import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { createModels } from "@earendil-works/pi-ai";

import { createPersistentCredentialStore, resolveMoondogAuthFile, serviceApiKeyIds } from "./persistent-credential-store.mjs";
import { apiKeyPiProviderIds, chatgptProviderId, loadPiProvider } from "./provider-registry.mjs";

// Keys for services that are not models share the same sign-in and private store;
// each one also needs its id in the store's serviceApiKeyIds.
export const serviceKeyProviders = Object.freeze([
  Object.freeze({ id: "brave", name: "Brave Search", variable: "BRAVE_SEARCH_API_KEY" }),
]);

export const supportedAuthProviderIds = Object.freeze([
  ...apiKeyPiProviderIds,
  ...serviceApiKeyIds,
]);

// Sign in with ChatGPT names this installation to OpenAI by a lasting random ID, kept beside auth.json.
async function installationId(directory) {
  const file = path.join(directory, "installation-id");
  try {
    const saved = (await readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(saved)) return saved;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const id = randomUUID();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${id}\n`, { encoding: "utf8", mode: 0o600 });
  return id;
}

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

  // Pi knows only model providers; a service key is read and written here, in the same store.
  const serviceStatus = async (service) => {
    const stored = await credentials.read(service.id);
    const variable = environment[service.variable]?.trim() ? service.variable : null;
    return {
      provider: service.id,
      state: stored ? "stored" : variable ? "environment" : "not_configured",
      type: stored || variable ? "api_key" : null,
      ...(!stored && variable ? { source: variable } : {}),
    };
  };
  const service = (providerId) => serviceKeyProviders.find((entry) => entry.id === providerId);

  const status = async (providerId) => {
    if (service(providerId)) return serviceStatus(service(providerId));
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
    // method "oauth" signs in with ChatGPT, for OpenAI only; any other login saves an API key.
    async login(providerId, interaction, { method = "api_key" } = {}) {
      const entry = service(providerId);
      if (entry) {
        interaction.signal?.throwIfAborted();
        const key = await interaction.prompt({ type: "secret", message: `Enter ${entry.name} API key` });
        interaction.signal?.throwIfAborted();
        await credentials.modify(entry.id, async () => ({ type: "api_key", key: typeof key === "string" ? key.trim() : key }));
        return serviceStatus(entry);
      }
      if (method === "oauth" && providerId !== chatgptProviderId) {
        const error = new Error("Only OpenAI signs in with ChatGPT.");
        error.code = "auth_provider_unsupported";
        throw error;
      }
      await ensureProvider(providerId);
      const deviceId = method === "oauth"
        ? await installationId(credentials.directory ?? path.dirname(resolveMoondogAuthFile(environment))) : null;
      await models.login(providerId, method === "oauth" ? "oauth" : "api_key", interaction,
        method === "oauth" ? { getDeviceId: () => deviceId } : undefined);
      return status(providerId);
    },

    status,

    async logout(providerId) {
      if (service(providerId)) {
        await credentials.delete(providerId);
        return serviceStatus(service(providerId));
      }
      await ensureProvider(providerId);
      await models.logout(providerId);
      return status(providerId);
    },
  };
}
