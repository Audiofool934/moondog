import { builtinModels } from "@earendil-works/pi-ai/providers/all";

let cachedCatalog;

function catalog() {
  cachedCatalog ??= builtinModels();
  return cachedCatalog;
}

export function listPiProviders() {
  const models = catalog();
  return models.getProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
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
