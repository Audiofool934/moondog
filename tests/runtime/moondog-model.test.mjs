import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalGateway } from "../../gateway/dev-server.mjs";
import { createModelSettings } from "../../src/runtime/pi/model-settings.mjs";
import { createModelFetch } from "../../src/runtime/pi/model-transport.mjs";
import { moondogModelUrl, parseInvite, readInvite } from "../../src/runtime/pi/moondog-model.mjs";
import { PersistentCredentialStore } from "../../src/runtime/pi/persistent-credential-store.mjs";
import { PublicPiModelCatalog } from "../../src/runtime/pi/public-model-catalog.mjs";
import { readPiRuntimeSelection, writePiRuntimeSelection } from "../../src/runtime/pi/runtime-settings.mjs";

async function fixture(t, { limits } = {}) {
  const gateway = await startLocalGateway({ environment: {}, limits });
  t.after(() => gateway.close());
  const root = await mkdtemp(path.join(tmpdir(), "moondog-own-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const environment = { MOONDOG_CONFIG_HOME: root, MOONDOG_MODEL_URL: `${gateway.url}/v1` };
  const catalog = new PublicPiModelCatalog({ environment, fetchImpl: async () => new Response("{}", { status: 503 }) });
  await catalog.ready;
  return { gateway, root, environment, catalog, settings: createModelSettings({ environment, catalog }) };
}

test("an invite code is read from a typed code or an invite link", () => {
  const code = "md-0123456789abcdefghjkmnpq";
  assert.equal(parseInvite(` ${code.toUpperCase()} `), code);
  assert.equal(parseInvite(`moondog://invite/${code}`), code);
  assert.equal(parseInvite(`https://moondog-api.audiofool.ai/invite/${code}`), code);
  assert.throws(() => parseInvite("md-short"), { code: "invite_invalid" });
  assert.equal(moondogModelUrl({}), "https://moondog-api.audiofool.ai/v1");
  assert.equal(moondogModelUrl({ MOONDOG_MODEL_URL: "http://elsewhere.example/v1" }), "https://moondog-api.audiofool.ai/v1", "plain http only on this computer");
});

test("a listener with only an invite code gets Moondog's model as the default, and the code stays private", async t => {
  const { gateway, root, environment, settings } = await fixture(t);
  let providers = await settings.providers();
  assert.deepEqual([providers[0].id, providers[0].name, providers[0].signIn, providers[0].signedIn], ["moondog", "Moondog", "invite", false]);

  const saved = await settings.saveInvite(`moondog://invite/${gateway.code}`);
  assert.equal(saved.label, "Local tester");
  assert.equal(saved.dailyTokens, 3_000_000);
  assert.equal(saved.becameDefault, true);
  assert.equal(JSON.stringify(saved).includes(gateway.code), false);
  assert.deepEqual(await readPiRuntimeSelection(environment), { provider: "moondog", model: "moondog" });
  assert.equal((await stat(path.join(root, "moondog-model.json"))).mode & 0o777, 0o600);
  // settings.json keeps the shape older Moondogs read.
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(root, "settings.json"), "utf8"))).sort(), ["model", "provider", "version"]);

  providers = await settings.providers();
  assert.equal(providers[0].signedIn, true);
  assert.equal(providers[0].source, "saved");
  const list = await settings.list();
  assert.deepEqual(list.models.map(entry => [entry.provider, entry.model, entry.name, entry.providerName, entry.ready]),
    [["moondog", "moondog", "Moondog", "Moondog", true]]);

  await settings.removeInvite();
  assert.equal(await readInvite(environment), null);
  assert.equal((await settings.providers())[0].signedIn, false);
  assert.equal((await settings.list()).models[0].ready, false, "the default stays and asks for a model");
});

test("a working default stays the default when a code is added", async t => {
  const { gateway, root, environment, settings } = await fixture(t);
  await new PersistentCredentialStore({ authFile: path.join(root, "auth.json") }).modify("anthropic", () => ({ type: "api_key", key: "ANTHROPIC_SENTINEL" }));
  await writePiRuntimeSelection({ provider: "anthropic", model: "claude-opus-5-5" }, environment);
  const saved = await settings.saveInvite(gateway.code);
  assert.equal(saved.becameDefault, false);
  assert.equal((await readPiRuntimeSelection(environment)).provider, "anthropic");
  assert.deepEqual((await settings.list()).models.map(entry => entry.provider), ["anthropic", "moondog"]);
});

test("a code the gateway does not take is not saved", async t => {
  const { environment, settings } = await fixture(t);
  await assert.rejects(settings.saveInvite("md-0123456789abcdefghjkmnpq"), { code: "invite_invalid" });
  await assert.rejects(settings.saveInvite("not a code"), { code: "invite_invalid" });
  assert.equal(await readInvite(environment), null);
  const offline = createModelSettings({ environment: { ...environment, MOONDOG_MODEL_URL: "http://127.0.0.1:9/v1" } });
  await assert.rejects(offline.saveInvite("md-0123456789abcdefghjkmnpq"), { code: "invite_unreachable" });
});

test("the gateway's reason for refusing a request reaches the surface as a code", async t => {
  const { gateway, environment } = await fixture(t, { limits: { dailyTokens: 1 } });
  const send = (onRefusal, provider = "moondog") => createModelFetch({ provider, onRefusal })(`${environment.MOONDOG_MODEL_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gateway.code}` },
    body: JSON.stringify({ model: "moondog", messages: [{ role: "user", content: "hello" }] }),
  });
  const refusals = [];
  assert.equal((await send(error => refusals.push(error))).status, 200, "the first request fits the allowance");
  // The local gateway counts tokens after it answers.
  await new Promise(resolve => setTimeout(resolve, 20));
  const refused = await send(error => refusals.push(error));
  assert.equal(refused.status, 429);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].code, "moondog_daily_allowance_used");
  assert.match(refusals[0].message, /allowance/u);
  assert.equal((await refused.json()).error.code, "daily_allowance_used", "Pi still reads the response");
});
