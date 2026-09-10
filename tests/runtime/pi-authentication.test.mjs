import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createModels, createProvider } from "@earendil-works/pi-ai";

import { createPiAuthentication } from "../../src/runtime/pi/authentication.mjs";
import { PersistentCredentialStore } from "../../src/runtime/pi/persistent-credential-store.mjs";

const providerId = "openai-codex";

function fakeOAuthProvider(state) {
  return createProvider({
    id: providerId,
    name: "Fake OpenAI Codex",
    auth: {
      oauth: {
        name: "Fake OAuth",
        async login(interaction) {
          state.loginCalls += 1;
          state.loginMethod = await interaction.prompt({
            type: "select",
            message: "Select method",
            options: [{ id: "browser", label: "Browser" }],
          });
          interaction.notify({ type: "progress", message: "Fake login" });
          return {
            type: "oauth",
            access: "AUTH_MANAGER_ACCESS_SENTINEL",
            refresh: "AUTH_MANAGER_REFRESH_SENTINEL",
            expires: Date.now() + 60_000,
            accountId: "AUTH_MANAGER_ACCOUNT_SENTINEL",
          };
        },
        async refresh() {
          state.refreshCalls += 1;
          if (!state.refreshCredential) {
            throw new Error("status must not refresh OAuth");
          }
          if (state.refreshDelayMs) await delay(state.refreshDelayMs);
          return structuredClone(state.refreshCredential);
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    models: [],
    api: {
      stream() {
        throw new Error("not used");
      },
      streamSimple() {
        throw new Error("not used");
      },
    },
  });
}

async function authFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-auth-manager-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const authFile = path.join(root, "config", "auth.json");
  const state = {
    loginCalls: 0,
    refreshCalls: 0,
    loginMethod: null,
    refreshCredential: null,
    refreshDelayMs: 0,
  };
  const provider = fakeOAuthProvider(state);
  const createAuthentication = (credentials) =>
    createPiAuthentication({
      credentials,
      providerLoader: async (requestedProvider) => {
        assert.equal(requestedProvider, providerId);
        return provider;
      },
    });
  return { root, authFile, state, provider, createAuthentication };
}

test("authentication login persists OAuth without returning credential data", async (context) => {
  const fixture = await authFixture(context);
  const store = new PersistentCredentialStore({ authFile: fixture.authFile });
  const authentication = await fixture.createAuthentication(store);
  const notifications = [];

  assert.deepEqual(await authentication.status(providerId), {
    provider: providerId,
    state: "not_configured",
    type: null,
  });
  const status = await authentication.login(providerId, {
    prompt: async () => "browser",
    notify: (event) => notifications.push(event.type),
  });

  assert.deepEqual(status, {
    provider: providerId,
    state: "stored",
    type: "oauth",
  });
  assert.equal(JSON.stringify(status).includes("SENTINEL"), false);
  assert.equal(fixture.state.loginCalls, 1);
  assert.equal(fixture.state.loginMethod, "browser");
  assert.deepEqual(notifications, ["progress"]);
  assert.equal(
    (await store.read(providerId)).refresh,
    "AUTH_MANAGER_REFRESH_SENTINEL",
  );
});

test("authentication status reloads metadata without refreshing OAuth", async (context) => {
  const fixture = await authFixture(context);
  const firstStore = new PersistentCredentialStore({ authFile: fixture.authFile });
  const first = await fixture.createAuthentication(firstStore);
  await first.login(providerId, {
    prompt: async () => "browser",
    notify() {},
  });

  const reloaded = await fixture.createAuthentication(
    new PersistentCredentialStore({ authFile: fixture.authFile }),
  );
  assert.deepEqual(await reloaded.status(providerId), {
    provider: providerId,
    state: "stored",
    type: "oauth",
  });
  assert.equal(fixture.state.refreshCalls, 0);
});

test("authentication logout is local and idempotent", async (context) => {
  const fixture = await authFixture(context);
  const store = new PersistentCredentialStore({ authFile: fixture.authFile });
  const authentication = await fixture.createAuthentication(store);
  await authentication.login(providerId, {
    prompt: async () => "browser",
    notify() {},
  });

  assert.deepEqual(await authentication.logout(providerId), {
    provider: providerId,
    state: "not_configured",
    type: null,
  });
  assert.deepEqual(await authentication.logout(providerId), {
    provider: providerId,
    state: "not_configured",
    type: null,
  });
  assert.equal(await store.read(providerId), undefined);
});

test("authentication rejects providers outside the explicit allowlist", async (context) => {
  const fixture = await authFixture(context);
  const authentication = await fixture.createAuthentication(
    new PersistentCredentialStore({ authFile: fixture.authFile }),
  );

  await assert.rejects(authentication.status("openai"), {
    code: "auth_provider_unsupported",
  });
});

test("Pi refreshes one expired OAuth credential once across store instances", async (context) => {
  const fixture = await authFixture(context);
  const firstStore = new PersistentCredentialStore({ authFile: fixture.authFile });
  await firstStore.modify(providerId, async () => ({
    type: "oauth",
    access: "EXPIRED_ACCESS_SENTINEL",
    refresh: "EXPIRED_REFRESH_SENTINEL",
    expires: Date.now() - 1,
    accountId: "AUTH_MANAGER_ACCOUNT_SENTINEL",
  }));
  fixture.state.refreshCredential = {
    type: "oauth",
    access: "ROTATED_ACCESS_SENTINEL",
    refresh: "ROTATED_REFRESH_SENTINEL",
    expires: Date.now() + 10 * 60_000,
    accountId: "AUTH_MANAGER_ACCOUNT_SENTINEL",
  };
  fixture.state.refreshDelayMs = 30;

  const firstModels = createModels({ credentials: firstStore });
  const secondModels = createModels({
    credentials: new PersistentCredentialStore({ authFile: fixture.authFile }),
  });
  firstModels.setProvider(fixture.provider);
  secondModels.setProvider(fixture.provider);

  const results = await Promise.all([
    firstModels.getAuth(providerId),
    secondModels.getAuth(providerId),
  ]);

  assert.equal(fixture.state.refreshCalls, 1);
  assert.deepEqual(
    results.map((result) => result.auth.apiKey),
    ["ROTATED_ACCESS_SENTINEL", "ROTATED_ACCESS_SENTINEL"],
  );
  assert.equal(
    (await firstStore.read(providerId)).refresh,
    "ROTATED_REFRESH_SENTINEL",
  );
});
