import { createProvider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

const zaiApiBaseUrl = "https://api.z.ai/api/paas/v4";
const providerDisplayNames = {
  anthropic: "Anthropic (Claude)",
  moonshotai: "Moonshot AI (Kimi)",
  "moonshotai-cn": "Moonshot AI China (Kimi)",
  openai: "OpenAI (GPT)",
  xai: "xAI (Grok)",
};

export function zaiApiProvider() {
  const nativeProvider = zaiProvider();
  // Pi's Z.AI default uses the Coding Plan endpoint. Moondog's listening
  // agent uses the general API, retaining Pi's GLM transport and model options.
  return createProvider({
    id: nativeProvider.id,
    name: "Z.AI (GLM API)",
    baseUrl: zaiApiBaseUrl,
    auth: nativeProvider.auth,
    models: nativeProvider.getModels().map((model) => ({
      ...model,
      baseUrl: zaiApiBaseUrl,
    })),
    api: nativeProvider,
  });
}

export function createPiModels(options) {
  const models = builtinModels(options);
  models.setProvider(zaiApiProvider());
  return models;
}

let cachedCatalog;

function catalog() {
  cachedCatalog ??= createPiModels();
  return cachedCatalog;
}

export function listPiProviders() {
  const models = catalog();
  return models.getProviders().map((provider) => ({
    id: provider.id,
    name: providerDisplayNames[provider.id] ?? provider.name,
    modelCount: models.getModels(provider.id).length,
  }));
}

export function listPiModels(providerId) {
  return catalog()
    .getModels(providerId)
    .map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning === true,
      contextWindow: model.contextWindow,
    }));
}
