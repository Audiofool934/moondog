import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFirstRun, resolveFirstRunFile } from "../../src/core/first-run.mjs";
import { resolvePlaybackPreferenceFile, writePlaybackPreference } from "../../src/core/playback-preferences.mjs";
import { runtimeBehindSelection } from "../../src/runtime/pi/runtime-settings.mjs";

test("the first run asks until a service is saved and a model answers, then never again", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-first-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root };
  const firstRun = createFirstRun({ environment });
  assert.equal(path.dirname(resolveFirstRunFile(environment)), path.dirname(resolvePlaybackPreferenceFile(environment)));

  assert.deepEqual(await firstRun.state(), { needed: true, service: null, model: false });
  assert.deepEqual(await firstRun.state({ modelReady: true }), { needed: true, service: null, model: true }, "Spotify by default is not a choice");
  await writePlaybackPreference("spotify", environment);
  assert.deepEqual(await firstRun.state({ modelReady: false }), { needed: true, service: "spotify", model: false });
  assert.deepEqual(await firstRun.state({ modelReady: true }), { needed: false, service: "spotify", model: true });
  assert.equal(JSON.parse(await readFile(resolveFirstRunFile(environment), "utf8")).skipped, false);
  assert.equal((await firstRun.state({ modelReady: false })).needed, false, "signing out later does not bring it back");
});

test("skipping ends the first run on both surfaces", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-first-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root };
  const terminal = createFirstRun({ environment });
  const window = createFirstRun({ environment });
  await terminal.finish({ skipped: true });
  assert.deepEqual(await window.state(), { needed: false, service: null, model: false });
  assert.equal(JSON.parse(await readFile(resolveFirstRunFile(environment), "utf8")).skipped, true);
});

test("an agent is rebuilt for another saved model, or when it could not answer, not for a token refresh", () => {
  const working = { state: "configured", provider: "deepseek", model: "deepseek-chat" };
  assert.equal(runtimeBehindSelection(working, { provider: "deepseek", model: "deepseek-chat" }), false);
  assert.equal(runtimeBehindSelection({ ...working, effort: "high" }, { provider: "deepseek", model: "deepseek-chat", effort: "high" }), false);
  assert.equal(runtimeBehindSelection(working, { provider: "deepseek", model: "deepseek-chat", effort: "high" }), true);
  assert.equal(runtimeBehindSelection(working, { provider: "anthropic", model: "claude-sonnet-5-5" }), true);
  assert.equal(runtimeBehindSelection({ ...working, state: "offline", reason: "provider_authentication_required" },{ provider: "deepseek", model: "deepseek-chat" }), true);
  assert.equal(runtimeBehindSelection({ state: "offline", reason: "model_not_configured" }, undefined), true);
});
