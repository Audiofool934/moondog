import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createModelSettings } from "../../src/runtime/pi/model-settings.mjs";
import { readModelRoles, resolveModelRolesFile, writeModelRole } from "../../src/runtime/pi/model-roles.mjs";
import { PersistentCredentialStore } from "../../src/runtime/pi/persistent-credential-store.mjs";
import { PublicPiModelCatalog } from "../../src/runtime/pi/public-model-catalog.mjs";
import { readPiRuntimeSelection, writePiRuntimeSelection } from "../../src/runtime/pi/runtime-settings.mjs";
import { runModelRolesCommand } from "../../src/surfaces/cli/model-roles-command.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-model-roles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const environment = { MOONDOG_CONFIG_HOME: root };
  // The public catalog is never reachable here, so every list is Pi's bundled one.
  const catalog = new PublicPiModelCatalog({ environment, fetchImpl: async () => new Response("{}", { status: 503 }) });
  await catalog.ready;
  const store = new PersistentCredentialStore({ authFile: path.join(root, "auth.json") });
  await store.modify("anthropic", () => ({ type: "api_key", key: "ANTHROPIC_SENTINEL" }));
  return { environment, settings: createModelSettings({ environment, catalog }) };
}

const web = {
  search: { provider: "deepseek" }, read: { provider: "deepseek" },
  services: [{ id: "deepseek", provider: "deepseek", name: "DeepSeek", ready: true, search: true, read: true },
    { id: "brave", provider: "brave", name: "Brave Search", ready: false, search: false, read: false }],
};

test("vision on auto follows a chat model that sees images, and a role keeps its own model", async (t) => {
  const { environment, settings } = await fixture(t);
  await writePiRuntimeSelection({ provider: "deepseek", model: "deepseek-v4-pro" }, environment);
  let roles = await settings.roles({ web });
  assert.deepEqual(roles.map((role) => [role.id, role.kind, role.state]),
    [["chat", "model", "enabled"], ["vision", "model", "enabled"], ["web_search", "service", "enabled"], ["audio", "model", "planned"]]);
  const vision = () => roles.find((role) => role.id === "vision");
  // DeepSeek V4 Pro reads only text, so vision on auto has nothing to use.
  assert.deepEqual([vision().choice, vision().auto], [null, null]);

  await writePiRuntimeSelection({ provider: "anthropic", model: "claude-sonnet-5-5" }, environment);
  roles = await settings.roles({ web });
  assert.equal(vision().auto.model, "claude-sonnet-5-5");

  await settings.setRole("vision", { provider: "anthropic", model: "claude-opus-5-5" });
  roles = await settings.roles({ web });
  assert.deepEqual([vision().choice.model, vision().choice.vision], ["claude-opus-5-5", true]);
  await assert.rejects(settings.setRole("vision", { provider: "deepseek", model: "deepseek-v4-pro" }), { code: "model_role_unsuitable" });
  await assert.rejects(settings.setRole("vision", { provider: "anthropic", model: "no-such-model" }), { code: "model_unknown" });
  await assert.rejects(settings.setRole("audio", { provider: "anthropic", model: "claude-opus-5-5" }), { code: "model_role_unavailable" });
  await assert.rejects(settings.setRole("chat", null), { code: "model_role_unknown" });

  await settings.setRole("vision", null);
  assert.equal((await settings.roles({ web })).find((role) => role.id === "vision").choice, null);
  // settings.json keeps its fixed shape: roles never go into it.
  assert.deepEqual(await readPiRuntimeSelection(environment), { provider: "anthropic", model: "claude-sonnet-5-5" });
});

test("model-roles.json keeps roles a newer Moondog wrote, and a bad entry leaves only that role on auto", async (t) => {
  const { environment } = await fixture(t);
  await writeFile(resolveModelRolesFile(environment), JSON.stringify({ version: 1, roles: {
    vision: { provider: "anthropic" }, web_search: { service: "brave" }, music_tagging: { provider: "x", model: "y" } } }));
  assert.deepEqual(await readModelRoles(environment), { web_search: { service: "brave" } });
  await writeModelRole("web_search", null, environment);
  const saved = JSON.parse(await readFile(resolveModelRolesFile(environment), "utf8"));
  assert.deepEqual(Object.keys(saved.roles).sort(), ["music_tagging", "vision"]);
  await assert.rejects(writeModelRole("web_search", { service: "google" }, environment), { code: "model_roles_invalid" });
});

test("/model roles, vision and web show and set what each model is for", async (t) => {
  const { environment, settings } = await fixture(t);
  await writePiRuntimeSelection({ provider: "anthropic", model: "claude-sonnet-5-5" }, environment);
  let refreshed = 0;
  const webResearch = { services: async () => web, refresh: async () => { refreshed += 1; } };
  const run = (args) => runModelRolesCommand({ args, modelSettings: settings, webResearch });

  const shown = await run(["roles"]);
  assert.match(shown, /Seeing images: auto, now Claude Sonnet 5\.5 \(Anthropic\)/u);
  assert.match(shown, /Web search: auto, now DeepSeek/u);
  assert.match(shown, /Hearing audio: not available yet/u);

  assert.match(await run(["web", "brave"]), /Web search: Brave Search \(not set up; falls back to the next service\)/u);
  assert.equal(refreshed, 1);
  assert.deepEqual(await readModelRoles(environment), { web_search: { service: "brave" } });
  assert.match(await run(["vision", "anthropic", "claude-opus-5-5"]), /Seeing images: Claude Opus 5\.5 \(Anthropic\)/u);
  assert.match(await run(["audio"]), /isn't available yet/u);
  await assert.rejects(run(["web", "google"]), /Usage: \/model roles/u);
});
