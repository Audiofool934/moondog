const providerLoaders = {
  anthropic: async () => {
    const { anthropicProvider } = await import(
      "@earendil-works/pi-ai/providers/anthropic"
    );
    return anthropicProvider();
  },
  deepseek: async () => {
    const { deepseekProvider } = await import(
      "@earendil-works/pi-ai/providers/deepseek"
    );
    return deepseekProvider();
  },
  google: async () => {
    const { googleProvider } = await import(
      "@earendil-works/pi-ai/providers/google"
    );
    return googleProvider();
  },
  moonshotai: async () => {
    const { moonshotaiProvider } = await import(
      "@earendil-works/pi-ai/providers/moonshotai"
    );
    return moonshotaiProvider();
  },
  "moonshotai-cn": async () => {
    const { moonshotaiCnProvider } = await import(
      "@earendil-works/pi-ai/providers/moonshotai-cn"
    );
    return moonshotaiCnProvider();
  },
  openai: async () => {
    const { openaiProvider } = await import(
      "@earendil-works/pi-ai/providers/openai"
    );
    return openaiProvider();
  },
  "openai-codex": async () => {
    const { openaiCodexProvider } = await import(
      "@earendil-works/pi-ai/providers/openai-codex"
    );
    return openaiCodexProvider();
  },
  openrouter: async () => {
    const { openrouterProvider } = await import(
      "@earendil-works/pi-ai/providers/openrouter"
    );
    return openrouterProvider();
  },
  xai: async () => {
    const { xaiProvider } = await import(
      "@earendil-works/pi-ai/providers/xai"
    );
    return xaiProvider();
  },
  zai: async () => {
    const { zaiApiProvider } = await import("./model-catalog.mjs");
    return zaiApiProvider();
  },
};

export const supportedPiProviderIds = Object.freeze(
  Object.keys(providerLoaders),
);

export const apiKeyPiProviderIds = Object.freeze(
  supportedPiProviderIds.filter((providerId) => providerId !== "openai-codex"),
);

export async function loadPiProvider(providerId) {
  if (!Object.hasOwn(providerLoaders, providerId)) return undefined;
  const loadProvider = providerLoaders[providerId];
  return loadProvider();
}
