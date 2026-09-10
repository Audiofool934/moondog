import assert from "node:assert/strict";
import test from "node:test";

import {
  loadPiProvider,
  supportedPiProviderIds,
} from "../../src/runtime/pi/provider-registry.mjs";

test("Pi provider registry preserves existing providers and adds openai-codex", async () => {
  assert.deepEqual([...supportedPiProviderIds].sort(), [
    "anthropic",
    "deepseek",
    "google",
    "moonshotai",
    "openai",
    "openai-codex",
    "openrouter",
  ]);

  const providers = await Promise.all(
    supportedPiProviderIds.map((providerId) => loadPiProvider(providerId)),
  );
  assert.deepEqual(
    providers.map((provider) => provider.id).sort(),
    [...supportedPiProviderIds].sort(),
  );
  assert.ok(providers.every((provider) => provider.getModels().length > 0));
});

test("Pi provider registry fails closed for unknown provider IDs", async () => {
  assert.equal(await loadPiProvider("not-a-provider"), undefined);
  assert.equal(await loadPiProvider("constructor"), undefined);
  assert.equal(await loadPiProvider("__proto__"), undefined);
});
