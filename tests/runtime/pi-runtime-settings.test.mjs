import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readPiRuntimeSelection,
  resolveMoondogSettingsFile,
  writePiRuntimeSelection,
} from "../../src/runtime/pi/runtime-settings.mjs";

async function settingsFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-settings-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    environment: { MOONDOG_CONFIG_HOME: root },
  };
}

test("runtime selection is stored beside auth.json with only public model fields", async (context) => {
  const fixture = await settingsFixture(context);

  assert.equal(await readPiRuntimeSelection(fixture.environment), undefined);
  assert.equal(
    resolveMoondogSettingsFile(fixture.environment),
    path.join(fixture.root, "settings.json"),
  );

  const written = await writePiRuntimeSelection(
    { provider: " OpenAI-Codex ", model: " gpt-5.6-terra " },
    fixture.environment,
  );

  assert.deepEqual(written, {
    provider: "openai-codex",
    model: "gpt-5.6-terra",
  });
  assert.deepEqual(await readPiRuntimeSelection(fixture.environment), written);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(fixture.root, "settings.json"))),
    {
      version: 1,
      provider: "openai-codex",
      model: "gpt-5.6-terra",
    },
  );
});

test("runtime settings reject fields outside the small persisted contract", async (context) => {
  const fixture = await settingsFixture(context);
  await writePiRuntimeSelection(
    { provider: "xai", model: "grok-4.6" },
    fixture.environment,
  );
  const settingsFile = resolveMoondogSettingsFile(fixture.environment);
  const source = JSON.parse(await readFile(settingsFile, "utf8"));
  source.token = "must-not-live-here";
  await writeFile(settingsFile, JSON.stringify(source));

  await assert.rejects(
    readPiRuntimeSelection(fixture.environment),
    (error) => error?.code === "runtime_settings_invalid",
  );
});
