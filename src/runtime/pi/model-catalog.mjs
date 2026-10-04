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

// Pi supplies canonical Flash metadata. Keep legacy IDs as aliases so saved
// Moondog selections continue to resolve without rewriting the listener's settings.
function currentDeepSeekModels(nativeModels) {
  const flash = nativeModels.find(model => model.id === "deepseek-flash");
  return [...nativeModels.map(model =>
    model.id === "deepseek-v4-pro" ? { ...model, name: "DeepSeek V4 Pro (0813)" } : model),
    ...["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].map(id => ({ ...flash, id, name: `${flash.name} (legacy alias)` }))];
}

export function createPiModels({ catalogModels, ...options } = {}) {
  const models = builtinModels(options);
  models.setProvider(zaiApiProvider());
  for (const native of models.getProviders()) {
    if (native.id !== "deepseek" && !catalogModels?.has(native.id)) continue;
    const baseline = native.id === "deepseek" ? currentDeepSeekModels(native.getModels()) : native.getModels();
    const merged = new Map(baseline.map(model => [model.id, model]));
    for (const model of catalogModels?.get(native.id) ?? []) merged.set(model.id, model);
    if (native.id === "deepseek") {
      const flash = merged.get("deepseek-flash");
      for (const id of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
        merged.set(id, { ...flash, id, name: `${flash.name} (legacy alias)` });
      }
    }
    // Keep the installed provider's auth, routing and stream implementations.
    const snapshot = [...merged.values()];
    models.setProvider({ ...native, getModels: () => structuredClone(snapshot) });
  }
  return models;
}

let cachedCatalog;

function catalog() {
  cachedCatalog ??= createPiModels();
  return cachedCatalog;
}

export function listPiProviders(models = catalog()) {
  return models.getProviders().map((provider) => ({
    id: provider.id,
    name: providerDisplayNames[provider.id] ?? provider.name,
    modelCount: models.getModels(provider.id).length,
  }));
}

export function listPiModels(providerId, models = catalog()) {
  return models
    .getModels(providerId)
    .map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning === true,
      contextWindow: model.contextWindow,
    }));
}
