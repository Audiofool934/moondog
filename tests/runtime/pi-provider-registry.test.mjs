import assert from "node:assert/strict";
import test from "node:test";

import {
  apiKeyPiProviderIds,
  loadPiProvider,
  supportedPiProviderIds,
} from "../../src/runtime/pi/provider-registry.mjs";
import { createPiModels } from "../../src/runtime/pi/model-catalog.mjs";

test("Pi provider registry supports the requested model API families", async () => {
  assert.deepEqual([...supportedPiProviderIds].sort(), [
    "anthropic",
    "deepseek",
    "google",
    "moonshotai",
    "moonshotai-cn",
    "openai",
    "openai-codex",
    "openrouter",
    "xai",
    "zai",
  ]);

  const providers = await Promise.all(
    supportedPiProviderIds.map((providerId) => loadPiProvider(providerId)),
  );
  assert.deepEqual(
    providers.map((provider) => provider.id).sort(),
    [...supportedPiProviderIds].sort(),
  );
  assert.ok(providers.every((provider) => provider.getModels().length > 0));
  assert.ok(
    apiKeyPiProviderIds.every(
      (id) => providers.find((provider) => provider.id === id).auth.apiKey,
    ),
  );
  assert.ok(!apiKeyPiProviderIds.includes("openai-codex"));
});

test("GLM runtime and login providers use the general API endpoint", async () => {
  const models = createPiModels();
  const loginProvider = await loadPiProvider("zai");
  for (const provider of [loginProvider, models.getProvider("zai")]) {
    assert.equal(provider.baseUrl, "https://api.z.ai/api/paas/v4");
    assert.ok(provider.getModels().length > 0);
    assert.ok(
      provider.getModels().every(
        (model) => model.baseUrl === "https://api.z.ai/api/paas/v4",
      ),
    );
    assert.equal(
      provider.getModels().find((model) => model.id === "glm-4.7")
        .compat.thinkingFormat,
      "zai",
    );
  }
  assert.ok(models.getModels("github-copilot").length > 0);
});

test("new API providers resolve native keys without accessing process credentials", async () => {
  const apiKeys = {
    moonshotai: "MOONSHOT_API_KEY",
    "moonshotai-cn": "MOONSHOT_API_KEY",
    xai: "XAI_API_KEY",
    zai: "ZAI_API_KEY",
  };
  for (const [providerId, envKey] of Object.entries(apiKeys)) {
    const models = createPiModels({
      authContext: {
        env: (name) => name === envKey ? "TEST_KEY" : undefined,
      },
    });
    const auth = await models.getAuth(providerId);
    assert.equal(auth.auth.apiKey, "TEST_KEY");
    assert.equal(auth.source, envKey);
  }
});

test("Pi provider registry fails closed for unknown provider IDs", async () => {
  assert.equal(await loadPiProvider("not-a-provider"), undefined);
  assert.equal(await loadPiProvider("constructor"), undefined);
  assert.equal(await loadPiProvider("__proto__"), undefined);
});
