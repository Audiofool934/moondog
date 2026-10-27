import assert from "node:assert/strict";
import test from "node:test";

import {
  listPiModels,
  listPiProviders,
} from "../../src/runtime/pi/model-catalog.mjs";

test("model picker catalog exposes Pi's full built-in provider set", () => {
  const providers = listPiProviders();

  assert.ok(providers.length > 7);
  assert.ok(
    providers.some(
      (provider) =>
        provider.id === "github-copilot" && provider.modelCount > 0,
    ),
  );
  assert.deepEqual(Object.keys(providers[0]).sort(), [
    "id",
    "modelCount",
    "name",
  ]);
  for (const id of [
    "anthropic",
    "deepseek",
    "moonshotai",
    "moonshotai-cn",
    "openai",
    "xai",
    "zai",
  ]) {
    assert.ok(
      providers.some((provider) => provider.id === id && provider.modelCount > 0),
    );
  }
  assert.equal(
    providers.find((provider) => provider.id === "zai").name,
    "Z.AI (GLM API)",
  );
  for (const [id, family] of [
    ["moonshotai", "Kimi"],
    ["moonshotai-cn", "Kimi"],
  ]) {
    assert.ok(providers.find((provider) => provider.id === id).name.includes(family));
  }
  // OpenAI's two ways in read as what the listener has: a ChatGPT subscription or an API key.
  for (const [id, name] of [["anthropic", "Anthropic"], ["openai", "OpenAI API"], ["openai-codex", "ChatGPT"], ["xai", "xAI"]]) {
    assert.equal(providers.find((provider) => provider.id === id).name, name);
  }
});

test("model picker catalog returns normalized Pi model metadata", () => {
  const model = listPiModels("openai-codex").find(
    (entry) => entry.id === "gpt-5.6-terra",
  );

  assert.deepEqual(model, {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    reasoning: true,
    contextWindow: 272000,
  });
  assert.deepEqual(listPiModels("not-a-pi-provider"), []);
});
