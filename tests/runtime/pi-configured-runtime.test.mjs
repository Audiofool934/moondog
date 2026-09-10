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

const provider = "openai-codex";
const model = "gpt-5.6-terra";

function applicationStub() {
  return {
    agentCapabilityDescriptors() {
      return [];
    },
  };
}

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
  const environment = { MOONDOG_CONFIG_HOME: root };
  await writePiRuntimeSelection(
    { provider: "github-copilot", model: "claude-haiku-4.5" },
    environment,
  );

  const runtime = await createConfiguredRuntime(
    applicationStub(),
    environment,
  );

  assert.equal(runtime.publicStatus().state, "configured");
  assert.equal(runtime.publicStatus().provider, "github-copilot");
  assert.equal(runtime.publicStatus().model, "claude-haiku-4.5");
});

test("explicit model selection takes precedence over env and stored selection", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-runtime-precedence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    MOONDOG_CONFIG_HOME: root,
    MOONDOG_PROVIDER: "xai",
    MOONDOG_MODEL: "grok-4.6",
  };
  await writePiRuntimeSelection(
    { provider: "github-copilot", model: "claude-haiku-4.5" },
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
    {},
    {
      selection: { provider: "github-copilot", model: "claude-haiku-4.5" },
      runtimeFactory(configuration) {
        received = configuration;
        return marker;
      },
    },
  );

  assert.equal(runtime, marker);
  assert.equal(received.provider, "github-copilot");
  assert.equal(received.modelId, "claude-haiku-4.5");
  assert.equal(received.model.id, "claude-haiku-4.5");
  assert.equal(typeof received.models.streamSimple, "function");
});
