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
};

export const supportedPiProviderIds = Object.freeze(
  Object.keys(providerLoaders),
);

export async function loadPiProvider(providerId) {
  if (!Object.hasOwn(providerLoaders, providerId)) return undefined;
  const loadProvider = providerLoaders[providerId];
  return loadProvider();
}
