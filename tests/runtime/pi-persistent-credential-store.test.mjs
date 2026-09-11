import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  PersistentCredentialStore,
  resolveMoondogAuthFile,
} from "../../src/runtime/pi/persistent-credential-store.mjs";

const providerId = "openai-codex";

function spotifyCredential(overrides = {}) {
  return {
    type: "oauth",
    accessToken: "SPOTIFY_ACCESS_TOKEN_SENTINEL",
    refreshToken: "SPOTIFY_REFRESH_TOKEN_SENTINEL",
    accessExpiresAt: Date.now() + 60_000,
    refreshExpiresAt: Date.now() + 180 * 24 * 60 * 60_000,
    tokenType: "Bearer",
    scope:
      "user-read-playback-state user-read-currently-playing user-modify-playback-state",
    ...overrides,
  };
}

function oauthCredential(overrides = {}) {
  return {
    type: "oauth",
    access: "ACCESS_TOKEN_SENTINEL",
    refresh: "REFRESH_TOKEN_SENTINEL",
    expires: Date.now() + 60_000,
    accountId: "ACCOUNT_ID_SENTINEL",
    ...overrides,
  };
}

async function credentialFixture(context) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-auth-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "config");
  const authFile = path.join(directory, "auth.json");
  return {
    root,
    directory,
    authFile,
    store: new PersistentCredentialStore({ authFile }),
  };
}

test("credential store persists OAuth data privately and lists metadata only", async (context) => {
  const fixture = await credentialFixture(context);
  const original = oauthCredential();

  const stored = await fixture.store.modify(providerId, async () => original);
  original.access = "mutated-after-write";
  assert.equal(stored.access, "ACCESS_TOKEN_SENTINEL");

  const reloadedStore = new PersistentCredentialStore({
    authFile: fixture.authFile,
  });
  const reloaded = await reloadedStore.read(providerId);
  assert.equal(reloaded.access, "ACCESS_TOKEN_SENTINEL");
  reloaded.refresh = "mutated-after-read";
  assert.equal(
    (await reloadedStore.read(providerId)).refresh,
    "REFRESH_TOKEN_SENTINEL",
  );

  const listed = await reloadedStore.list();
  assert.deepEqual(listed, [{ providerId, type: "oauth" }]);
  assert.equal(JSON.stringify(listed).includes("TOKEN_SENTINEL"), false);
  assert.equal(JSON.stringify(listed).includes("ACCOUNT_ID_SENTINEL"), false);

  if (process.platform !== "win32") {
    assert.equal((await stat(fixture.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(fixture.authFile)).mode & 0o777, 0o600);
  }
});

test("credential store persists Spotify OAuth without exposing tokens in metadata", async (context) => {
  const fixture = await credentialFixture(context);
  await fixture.store.modify("spotify", async () => spotifyCredential());

  const stored = await fixture.store.read("spotify");
  assert.equal(stored.tokenType, "Bearer");
  assert.deepEqual(await fixture.store.list(), [
    { providerId: "spotify", type: "oauth" },
  ]);
  assert.doesNotMatch(JSON.stringify(await fixture.store.list()), /SENTINEL/u);
});

test("API keys coexist with OAuth and reject unexpected credential fields", async (context) => {
  const fixture = await credentialFixture(context);
  await fixture.store.modify("openai-codex", async () => oauthCredential());
  await fixture.store.modify("spotify", async () => spotifyCredential());
  await fixture.store.modify("openai", async () => ({
    type: "api_key",
    key: "API_KEY_SENTINEL",
  }));

  const reloaded = new PersistentCredentialStore({ authFile: fixture.authFile });
  assert.deepEqual(await reloaded.list(), [
    { providerId: "openai", type: "api_key" },
    { providerId: "openai-codex", type: "oauth" },
    { providerId: "spotify", type: "oauth" },
  ]);
  for (const credential of [
    { type: "api_key", key: "" },
    { type: "api_key", key: " " },
    { type: "api_key", key: "KEY\nINJECTION" },
    { type: "api_key", key: "API_KEY_SENTINEL", extra: "unsupported" },
    { type: "oauth", key: "API_KEY_SENTINEL" },
  ]) {
    await assert.rejects(reloaded.modify("openai", async () => credential), {
      code: "credential_store_corrupt",
    });
  }
  assert.equal((await reloaded.read("openai")).key, "API_KEY_SENTINEL");
  await reloaded.delete("openai");
  assert.equal((await reloaded.read("spotify")).refreshToken, "SPOTIFY_REFRESH_TOKEN_SENTINEL");
  assert.equal((await reloaded.read("openai-codex")).refresh, "REFRESH_TOKEN_SENTINEL");
});

test("credential store serializes refresh-like modifications across instances", async (context) => {
  const fixture = await credentialFixture(context);
  await fixture.store.modify(providerId, async () => oauthCredential());
  const secondStore = new PersistentCredentialStore({
    authFile: fixture.authFile,
  });
  const observedRefreshTokens = [];

  await Promise.all([
    fixture.store.modify(providerId, async (current) => {
      observedRefreshTokens.push(current.refresh);
      await delay(50);
      return {
        ...current,
        refresh: `${current.refresh}:rotated`,
      };
    }),
    secondStore.modify(providerId, async (current) => {
      observedRefreshTokens.push(current.refresh);
      return {
        ...current,
        refresh: `${current.refresh}:rotated`,
      };
    }),
  ]);

  assert.deepEqual(observedRefreshTokens, [
    "REFRESH_TOKEN_SENTINEL",
    "REFRESH_TOKEN_SENTINEL:rotated",
  ]);
  assert.equal(
    (await fixture.store.read(providerId)).refresh,
    "REFRESH_TOKEN_SENTINEL:rotated:rotated",
  );
  await assert.rejects(stat(`${fixture.authFile}.lock`), { code: "ENOENT" });
});

test("credential store lock wait honors cancellation without stealing a live lock", async (context) => {
  const fixture = await credentialFixture(context);
  await fixture.store.modify(providerId, async () => oauthCredential());
  const secondStore = new PersistentCredentialStore({
    authFile: fixture.authFile,
  });
  let releaseFirst;
  let signalFirstStarted;
  const firstStarted = new Promise((resolve) => {
    signalFirstStarted = resolve;
  });
  const first = fixture.store.modify(providerId, async (current) => {
    signalFirstStarted();
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    return current;
  });
  await firstStarted;

  const controller = new AbortController();
  const second = secondStore.modify(
    providerId,
    async (current) => current,
    { signal: controller.signal },
  );
  controller.abort(new Error("cancelled lock wait"));
  await assert.rejects(second, /cancelled lock wait/iu);

  releaseFirst();
  await first;
  assert.equal(
    (await fixture.store.read(providerId)).refresh,
    "REFRESH_TOKEN_SENTINEL",
  );
});

test("credential store recovers a lock owned by a confirmed dead process", async (context) => {
  const fixture = await credentialFixture(context);
  await mkdir(fixture.directory, { recursive: true, mode: 0o700 });
  const lockDirectory = `${fixture.authFile}.lock`;
  await mkdir(lockDirectory, { mode: 0o700 });
  const deadProcess = spawnSync(process.execPath, ["-e", ""], {
    encoding: "utf8",
  });
  assert.equal(deadProcess.status, 0, deadProcess.stderr);
  await writeFile(
    path.join(lockDirectory, "owner.json"),
    `${JSON.stringify({
      pid: deadProcess.pid,
      nonce: "dead-process-lock",
      createdAt: Date.now(),
    })}\n`,
    { mode: 0o600 },
  );

  await fixture.store.modify(providerId, async () => oauthCredential());

  assert.equal(
    (await fixture.store.read(providerId)).refresh,
    "REFRESH_TOKEN_SENTINEL",
  );
  await assert.rejects(stat(lockDirectory), { code: "ENOENT" });
});

test("credential store fails closed on corrupt JSON and preserves the bytes", async (context) => {
  const fixture = await credentialFixture(context);
  await mkdir(fixture.directory, { recursive: true, mode: 0o700 });
  await chmod(fixture.directory, 0o700);
  const corrupt = "{not-valid-json\nACCESS_TOKEN_SENTINEL";
  await writeFile(fixture.authFile, corrupt, { mode: 0o600 });
  await chmod(fixture.authFile, 0o600);

  await assert.rejects(
    fixture.store.read(providerId),
    (error) =>
      error.code === "credential_store_corrupt" &&
      !error.message.includes("ACCESS_TOKEN_SENTINEL"),
  );
  assert.equal(await readFile(fixture.authFile, "utf8"), corrupt);
  await assert.rejects(
    fixture.store.modify(providerId, async () => oauthCredential()),
    { code: "credential_store_corrupt" },
  );
  assert.equal(await readFile(fixture.authFile, "utf8"), corrupt);
});

test("credential store rejects a symlink credential target", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX symlink safety test");
    return;
  }
  const fixture = await credentialFixture(context);
  await mkdir(fixture.directory, { recursive: true, mode: 0o700 });
  const target = path.join(fixture.root, "outside-auth.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, fixture.authFile);

  await assert.rejects(fixture.store.read(providerId), {
    code: "credential_store_unsafe",
  });
});

test("read-only status never changes an existing custom directory mode", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX permission safety test");
    return;
  }
  const fixture = await credentialFixture(context);
  await mkdir(fixture.directory, { recursive: true, mode: 0o755 });
  await chmod(fixture.directory, 0o755);

  await assert.rejects(fixture.store.read(providerId), {
    code: "credential_store_unsafe",
  });
  assert.equal((await stat(fixture.directory)).mode & 0o777, 0o755);
  await assert.rejects(stat(fixture.authFile), { code: "ENOENT" });
});

test("credential delete is idempotent and does not expose another auth cache", async (context) => {
  const fixture = await credentialFixture(context);
  await fixture.store.modify(providerId, async () => oauthCredential());
  await fixture.store.delete(providerId);
  await fixture.store.delete(providerId);

  assert.equal(await fixture.store.read(providerId), undefined);
  assert.deepEqual(await fixture.store.list(), []);
  assert.equal(
    resolveMoondogAuthFile({
      MOONDOG_CONFIG_HOME: fixture.directory,
      CODEX_HOME: path.join(fixture.root, "codex-must-not-be-used"),
    }),
    fixture.authFile,
  );
});

test("credential path override must be absolute", () => {
  assert.throws(
    () =>
      resolveMoondogAuthFile({
        MOONDOG_CONFIG_HOME: "relative/moondog",
      }),
    { code: "credential_store_path_invalid" },
  );
});
