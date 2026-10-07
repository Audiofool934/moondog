// Stands in for the model catalog and sign-in modules, which need files and network.
// The provider list is real (recorded by room/snapshot.mjs); connecting needs the installed app.
import snapshot from "../../generated/snapshot.json";

export const listPiProviders = () => snapshot.providers;
export const listPiModels = (providerId) => snapshot.models[providerId] ?? [];
export const supportedAuthProviderIds = Object.freeze([...snapshot.authProviderIds]);
export async function getPublicPiModelCatalog() {
  return { providers: listPiProviders, models: listPiModels, refresh: async () => [] };
}
