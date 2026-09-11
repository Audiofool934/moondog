import { PiAgentRuntime } from "./agent-runtime.mjs";
import { createPiAuthContext } from "./authentication.mjs";
import { createPiModels } from "./model-catalog.mjs";
import { createPersistentCredentialStore } from "./persistent-credential-store.mjs";
import { readPiRuntimeSelection } from "./runtime-settings.mjs";

export class OfflineAgentRuntime {
  constructor(reason = "model_not_configured", selection) {
    this.reason = reason;
    this.selection = selection;
  }

  publicStatus() {
    return {
      state: "offline",
      adapter: "pi_agent_core",
      pi_version: "0.84.3",
      reason: this.reason,
      ...this.selection,
      session_persistence: "none",
      external_effects: "disabled",
    };
  }

  async prompt() {
    throw new Error(
      "Moondog's model runtime is offline. Choose a model or set MOONDOG_PROVIDER and MOONDOG_MODEL to enable free-text conversation.",
    );
  }

  abort() {}

  reset() {}

  restoreSession() {}
}

export async function createConfiguredRuntime(
  application,
  environment = process.env,
  {
    credentials,
    modelsFactory = createPiModels,
    runtimeFactory = (configuration) => new PiAgentRuntime(configuration),
    selection,
    settingsReader = readPiRuntimeSelection,
  } = {},
) {
  const environmentSelectsModel =
    environment.MOONDOG_PROVIDER !== undefined ||
    environment.MOONDOG_MODEL !== undefined;
  const configuredSelection =
    selection !== undefined
      ? selection
      : environmentSelectsModel
        ? {
            provider: environment.MOONDOG_PROVIDER,
            model: environment.MOONDOG_MODEL,
          }
        : await settingsReader(environment);
  const provider = configuredSelection?.provider?.trim().toLowerCase();
  const modelId = configuredSelection?.model?.trim();

  if (!provider && !modelId) {
    return new OfflineAgentRuntime();
  }
  if (!provider || !modelId) {
    return new OfflineAgentRuntime("model_configuration_incomplete");
  }

  const credentialStore =
    credentials ?? createPersistentCredentialStore(environment);
  const models = modelsFactory({
    credentials: credentialStore,
    authContext: createPiAuthContext(environment),
  });
  if (!models.getProvider(provider)) {
    return new OfflineAgentRuntime("provider_not_found_in_pi_catalog");
  }
  const model = models.getModel(provider, modelId);
  if (!model) {
    return new OfflineAgentRuntime("model_not_found_in_pi_catalog");
  }
  if (!(await models.checkAuth(provider))) {
    return new OfflineAgentRuntime("provider_authentication_required", {
      provider,
      model: modelId,
    });
  }

  return runtimeFactory({
    application,
    models,
    model,
    provider,
    modelId,
  });
}
