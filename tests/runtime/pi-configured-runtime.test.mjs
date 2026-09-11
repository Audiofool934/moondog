import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createConfiguredRuntime,
  OfflineAgentRuntime,
} from "../../src/runtime/pi/configured-runtime.mjs";
import { PersistentCredentialStore } from "../../src/runtime/pi/persistent-credential-store.mjs";
import { writePiRuntimeSelection } from "../../src/runtime/pi/runtime-settings.mjs";
import { listPiModels } from "../../src/runtime/pi/model-catalog.mjs";

const provider = "openai-codex";
const model = "gpt-5.6-terra";

function applicationStub() {
  return {
    agentCapabilityDescriptors() {
      return [];
    },
  };
}

test("all six API providers require a key and retain selection for authentication", async (context) => {
  const credentials = await credentialFixture(context);
  const providers = {
    anthropic: "ANTHROPIC_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    moonshotai: "MOONSHOT_API_KEY",
    openai: "OPENAI_API_KEY",
    xai: "XAI_API_KEY",
    zai: "ZAI_API_KEY",
  };
  for (const [provider, variable] of Object.entries(providers)) {
    const model = listPiModels(provider)[0].id;
    const environment = { MOONDOG_PROVIDER: provider, MOONDOG_MODEL: model };
    const offline = await createConfiguredRuntime(applicationStub(), environment, { credentials });
    assert.equal(offline.publicStatus().reason, "provider_authentication_required");
    assert.equal(offline.publicStatus().provider, provider);
    assert.equal(offline.publicStatus().model, model);

    const fromEnvironment = await createConfiguredRuntime(applicationStub(), {
      ...environment,
      [variable]: "RUNTIME_API_KEY_SENTINEL",
    }, { credentials });
    assert.equal(fromEnvironment.publicStatus().state, "configured", provider);

    await credentials.modify(provider, () => ({ type: "api_key", key: "STORED_API_KEY_SENTINEL" }));
    const fromStore = await createConfiguredRuntime(applicationStub(), environment, { credentials });
    assert.equal(fromStore.publicStatus().state, "configured", provider);
    assert.doesNotMatch(JSON.stringify(fromStore.publicStatus()), /SENTINEL/);
  }
});

async function credentialFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-runtime-auth-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return new PersistentCredentialStore({
    authFile: path.join(root, "auth.json"),
  });
}

test("openai-codex remains offline until Moondog has an OAuth credential", async (context) => {
  const credentials = await credentialFixture(context);
  const runtime = await createConfiguredRuntime(
    applicationStub(),
    {
      MOONDOG_PROVIDER: provider,
      MOONDOG_MODEL: model,
    },
    { credentials },
  );

  assert.ok(runtime instanceof OfflineAgentRuntime);
  assert.equal(
    runtime.publicStatus().reason,
    "provider_authentication_required",
  );
});

test("openai-codex runtime uses the persisted Moondog OAuth credential", async (context) => {
  const credentials = await credentialFixture(context);
  await credentials.modify(provider, async () => ({
    type: "oauth",
    access: "ACCESS_TOKEN_SENTINEL",
    refresh: "REFRESH_TOKEN_SENTINEL",
    expires: Date.now() + 60_000,
    accountId: "ACCOUNT_ID_SENTINEL",
  }));

  const runtime = await createConfiguredRuntime(
    applicationStub(),
    {
      MOONDOG_PROVIDER: provider,
      MOONDOG_MODEL: model,
    },
    { credentials },
  );

  assert.deepEqual(runtime.publicStatus(), {
    state: "configured",
    adapter: "pi_agent_core",
    pi_version: "0.84.3",
    provider,
    model,
    session_persistence: "process_local_only",
    external_effects: "disabled",
  });
  assert.doesNotMatch(
    JSON.stringify(runtime.publicStatus()),
    /ACCESS_TOKEN_SENTINEL|REFRESH_TOKEN_SENTINEL|ACCOUNT_ID_SENTINEL/u,
  );
});

test("openai-codex model validation does not require a login or network call", async (context) => {
  const credentials = await credentialFixture(context);
  const runtime = await createConfiguredRuntime(
    applicationStub(),
    {
      MOONDOG_PROVIDER: provider,
      MOONDOG_MODEL: "not-a-real-codex-model",
    },
    { credentials },
  );

  assert.ok(runtime instanceof OfflineAgentRuntime);
  assert.equal(runtime.publicStatus().reason, "model_not_found_in_pi_catalog");
});

test("runtime uses a persisted Pi provider and model when env overrides are absent", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-runtime-settings-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root, DEEPSEEK_API_KEY: "TEST_KEY" };
  await writePiRuntimeSelection(
    { provider: "deepseek", model: "deepseek-v4-flash" },
    environment,
  );

  const runtime = await createConfiguredRuntime(
    applicationStub(),
    environment,
  );

  assert.equal(runtime.publicStatus().state, "configured");
  assert.equal(runtime.publicStatus().provider, "deepseek");
  assert.equal(runtime.publicStatus().model, "deepseek-v4-flash");
});

test("explicit model selection takes precedence over env and stored selection", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-runtime-precedence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    MOONDOG_CONFIG_HOME: root,
    MOONDOG_PROVIDER: "xai",
    MOONDOG_MODEL: "grok-4.6",
    ZAI_API_KEY: "TEST_KEY",
  };
  await writePiRuntimeSelection(
    { provider: "deepseek", model: "deepseek-v4-flash" },
    environment,
  );

  const runtime = await createConfiguredRuntime(applicationStub(), environment, {
    selection: { provider: "zai", model: "glm-4.7" },
  });

  assert.equal(runtime.publicStatus().provider, "zai");
  assert.equal(runtime.publicStatus().model, "glm-4.7");
});

test("either model env variable blocks fallback to stored selection", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-runtime-env-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writePiRuntimeSelection(
    { provider: "xai", model: "grok-4.6" },
    { MOONDOG_CONFIG_HOME: root },
  );

  const runtime = await createConfiguredRuntime(applicationStub(), {
    MOONDOG_CONFIG_HOME: root,
    MOONDOG_PROVIDER: "xai",
  });

  assert.ok(runtime instanceof OfflineAgentRuntime);
  assert.equal(
    runtime.publicStatus().reason,
    "model_configuration_incomplete",
  );
});

test("configured runtime can reuse model resolution through a dedicated runtime factory", async () => {
  let received;
  const marker = { kind: "memory-runtime" };
  const runtime = await createConfiguredRuntime(
    applicationStub(),
    { DEEPSEEK_API_KEY: "TEST_KEY" },
    {
      selection: { provider: "deepseek", model: "deepseek-v4-flash" },
      runtimeFactory(configuration) {
        received = configuration;
        return marker;
      },
    },
  );

  assert.equal(runtime, marker);
  assert.equal(received.provider, "deepseek");
  assert.equal(received.modelId, "deepseek-v4-flash");
  assert.equal(received.model.id, "deepseek-v4-flash");
  assert.equal(typeof received.models.streamSimple, "function");
});
