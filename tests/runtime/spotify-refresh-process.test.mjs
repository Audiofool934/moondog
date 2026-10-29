import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { PersistentCredentialStore } from "../../src/runtime/pi/persistent-credential-store.mjs";
import { createSpotifyCredentialStore } from "../../src/integrations/spotify/credential-store.mjs";
import { createSpotifyAuthentication } from "../../src/integrations/spotify/authentication.mjs";

const old = () => ({ type: "oauth", accessToken: "old-access", refreshToken: "old-refresh", accessExpiresAt: Date.now() + 3600_000,
  refreshExpiresAt: Date.now() + 86400_000, tokenType: "Bearer", scope: "user-read-playback-state" });
const payload = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, token_type: "Bearer" };
const response = () => ({ ok: true, json: async () => payload });
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-refresh-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authFile = path.join(root, "auth.json");
  const persistent = new PersistentCredentialStore({ authFile });
  const store = createSpotifyCredentialStore({ credentialStore: persistent });
  await store.write(old());
  return { root, authFile, persistent, store };
}
function worker(t, authFile, mode) {
  const child = fork(new URL("../fixtures/spotify-refresh/worker.mjs", import.meta.url), [authFile, ...(mode ? [mode] : [])], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages = [];
  const waits = [];
  child.on("message", (message) => { messages.push(message); for (const waiter of [...waits]) waiter(message); });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const wait = (event) => new Promise((resolve, reject) => {
    const seen = messages.find((m) => m.event === event);
    if (seen) return resolve(seen);
    const timer = setTimeout(() => reject(new Error(`worker missing ${event}: ${JSON.stringify(messages)}`)), 5000);
    const accept = (message) => { if (message.event === event) { clearTimeout(timer); waits.splice(waits.indexOf(accept), 1); resolve(message); } };
    waits.push(accept);
  });
  return { child, messages, wait, send: (message) => child.send(message) };
}
const authFor = (store, fetchImpl, extra = {}) => createSpotifyAuthentication({ clientId: "fictional-client", credentialStore: store, fetchImpl, ...extra });

test("independent processes serialize the whole refresh and reuse persisted rotation", async (t) => {
  const f = await fixture(t);
  const a = worker(t, f.authFile), b = worker(t, f.authFile);
  await Promise.all([a.wait("ready"), b.wait("ready")]);
  a.send("start");
  assert.equal((await a.wait("exchange")).refresh, "old-refresh");
  b.send("start");
  a.send("release");
  const tokens = await Promise.all([a.wait("token"), b.wait("token")]);
  assert.deepEqual(tokens.map((m) => m.token), ["rotated-access", "rotated-access"]);
  assert.equal(b.messages.filter((m) => m.event === "exchange").length, 0);
  const reloaded = await new PersistentCredentialStore({ authFile: f.authFile }).read("spotify");
  assert.equal(reloaded.refreshToken, "rotated-refresh");
  assert.equal(reloaded.refreshAttempt, undefined);
  assert.equal((await stat(f.authFile)).mode & 0o777, 0o600);
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
});

test("a process that dies during the exchange does not sign the listener out", async (t) => {
  const f = await fixture(t);
  const a = worker(t, f.authFile);
  await a.wait("ready"); a.send("start"); await a.wait("exchange");
  const died = once(a.child, "exit"); a.child.kill("SIGKILL"); await died;
  const sent = [];
  const auth = authFor(f.store, async (_url, options) => { sent.push(options.body.get("refresh_token")); return response(); });
  assert.equal(await auth.refreshAccessToken({ rejectedAccessToken: "old-access" }), "new-access");
  assert.deepEqual(sent, ["old-refresh"]);
  assert.equal((await f.store.read()).refreshToken, "new-refresh");
});

test("a refresh that fails before Spotify answers is tried again on the next request", async (t) => {
  const f = await fixture(t);
  await f.store.write({ ...old(), accessExpiresAt: Date.now() - 60_000 });
  let online = false, requests = 0;
  const auth = authFor(f.store, async () => { requests++; if (!online) throw new TypeError("fetch failed"); return response(); });
  await assert.rejects(auth.getAccessToken(), { code: "spotify_token_refresh_failed" });
  online = true;
  assert.equal(await auth.getAccessToken(), "new-access");
  assert.equal(requests, 2);
});

test("only Spotify rejecting the grant asks for a new sign-in", async (t) => {
  const f = await fixture(t);
  let answer;
  const auth = authFor(f.store, async () => answer);
  for (const [status, error] of [[503, "server_error"], [429, undefined]]) {
    answer = { ok: false, status, json: async () => (error ? { error } : {}) };
    await assert.rejects(auth.refreshAccessToken(), { code: "spotify_token_refresh_failed" });
  }
  answer = { ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "Refresh token revoked" }) };
  await assert.rejects(auth.refreshAccessToken(), { code: "spotify_refresh_rejected" });
  assert.equal((await f.store.read()).refreshToken, "old-refresh");
});

test("a credential an older version left marked as interrupted refreshes normally", async (t) => {
  const f = await fixture(t);
  await f.store.write({ ...old(), accessExpiresAt: Date.now() - 60_000,
    refreshAttempt: { id: "6f1c2a52-8a52-4c1e-9d3b-0f6d2c1b9e47", startedAt: Date.now() - 3600_000 } });
  let requests = 0;
  const auth = authFor(f.store, async () => { requests++; return response(); });
  assert.equal(await auth.getAccessToken(), "new-access");
  assert.equal(requests, 1);
  assert.equal((await f.store.read()).refreshAttempt, undefined);
});

test("dead process before refresh intent allows exactly one recovery exchange", async (t) => {
  const f = await fixture(t), holder = worker(t, f.authFile, "lock");
  await holder.wait("ready"); holder.send("start"); await holder.wait("locked");
  const died = once(holder.child, "exit"); holder.child.kill("SIGKILL"); await died;
  const contenders = Array.from({ length: 6 }, () => worker(t, f.authFile));
  let exchanges = 0;
  for (const c of contenders) c.child.on("message", (m) => { if (m.event === "exchange") { exchanges++; c.send("release"); } });
  await Promise.all(contenders.map(async (c) => { await c.wait("ready"); c.send("start"); }));
  await Promise.all(contenders.map((c) => c.wait("token")));
  assert.equal(exchanges, 1);
});

test("lock-wait cancellation is bounded and does not steal another process's lock", async (t) => {
  const f = await fixture(t), holder = worker(t, f.authFile, "lock");
  await holder.wait("ready"); holder.send("start"); await holder.wait("locked");
  let requests = 0;
  const auth = authFor(f.store, async () => { requests++; return response(); });
  const controller = new AbortController();
  const waiting = assert.rejects(auth.refreshAccessToken({ signal: controller.signal }), { code: "spotify_auth_aborted" });
  controller.abort(); await waiting;
  assert.equal(requests, 0);
  assert.ok(await stat(`${f.authFile}.lock`));
  holder.send("release");
  await once(holder.child, "exit");
});

test("a timed-out refresh is tried again, and its late response cannot write", async (t) => {
  const f = await fixture(t);
  let release, requests = 0;
  const auth = authFor(f.store, async () => {
    requests++;
    if (requests === 1) await new Promise((r) => { release = r; });
    return response();
  }, { refreshTimeoutMs: 100 });
  await assert.rejects(auth.refreshAccessToken(), { code: "spotify_refresh_timeout" });
  assert.equal((await f.store.read()).accessToken, "old-access");
  await f.store.write({ ...old(), accessToken: "explicit-replacement" });
  release(); await new Promise((r) => setImmediate(r));
  assert.equal((await f.store.read()).accessToken, "explicit-replacement");
  assert.equal(await auth.refreshAccessToken({ rejectedAccessToken: "explicit-replacement" }), "new-access");
  assert.equal(requests, 2);
});

for (const failure of ["before-rename", "after-rename"]) {
  test(`persistence failure ${failure} never returns an uncommitted token`, async (t) => {
    const f = await fixture(t);
    const write = f.persistent.writeDocument.bind(f.persistent);
    let requests = 0;
    f.persistent.writeDocument = async (...args) => {
      if (failure === "before-rename") throw new Error("fictional disk failure");
      await write(...args);
      throw new Error("fictional directory fsync failure");
    };
    await assert.rejects(authFor(f.store, async () => { requests++; return response(); }).refreshAccessToken(), { code: "spotify_credential_store_failed" });
    const reloaded = await new PersistentCredentialStore({ authFile: f.authFile }).read("spotify");
    assert.equal(requests, 1);
    assert.equal(reloaded.accessToken, failure === "after-rename" ? "new-access" : "old-access");
  });
}

test("unsupported nontransactional stores fail closed before token HTTP", async () => {
  let requests = 0;
  const store = { read: async () => old(), write: async () => {}, delete: async () => {} };
  await assert.rejects(authFor(store, async () => { requests++; return response(); }).refreshAccessToken(), { code: "spotify_refresh_coordination_unavailable" });
  assert.equal(requests, 0);
});

test("cancelling the last waiter after dispatch still persists rotation under the deadline", async (t) => {
  const f = await fixture(t);
  let release, started, requests = 0;
  const ready = new Promise((r) => { started = r; });
  const auth = authFor(f.store, async () => { requests++; started(); await new Promise((r) => { release = r; }); return response(); });
  const controller = new AbortController();
  const pending = assert.rejects(auth.refreshAccessToken({ signal: controller.signal }), { code: "spotify_auth_aborted" });
  await ready; controller.abort(); await pending;
  release();
  // A later rejection of the old token joins the rotation still in flight.
  assert.equal(await auth.refreshAccessToken({ rejectedAccessToken: "old-access" }), "new-access");
  assert.equal((await f.store.read()).refreshToken, "new-refresh");
  assert.equal(requests, 1);
});

test("refresh caller deadline includes waiting behind another local credential mutation", async (t) => {
  const f = await fixture(t);
  let release, requests = 0;
  const remove = f.store.delete;
  f.store.delete = async () => { await new Promise((r) => { release = r; }); await remove(); };
  const auth = authFor(f.store, async () => { requests++; return response(); }, { refreshTimeoutMs: 50 });
  const logout = auth.logout();
  const began = Date.now();
  await assert.rejects(auth.refreshAccessToken(), { code: "spotify_refresh_timeout" });
  assert.ok(Date.now() - began < 1500);
  release(); await logout;
  assert.equal(requests, 0);
});

test("a newer rejected token joining a waiting task gets its own refresh", async (t) => {
  const f = await fixture(t);
  let unlock, entered;
  const ready = new Promise((r) => { entered = r; });
  const modify = f.store.modify;
  let firstModify = true;
  f.store.modify = async (...args) => {
    if (firstModify) { firstModify = false; entered(); await new Promise((r) => { unlock = r; }); }
    return modify(...args);
  };
  let requests = 0;
  const auth = authFor(f.store, async () => { requests++; return response(); });
  const first = auth.refreshAccessToken({ rejectedAccessToken: "old-access" });
  await ready;
  await f.store.write({ ...old(), accessToken: "newer-rejected", refreshToken: "newer-refresh" });
  const second = auth.refreshAccessToken({ rejectedAccessToken: "newer-rejected" });
  await new Promise((r) => setImmediate(r));
  unlock();
  assert.equal(await first, "newer-rejected");
  assert.equal(await second, "new-access");
  assert.equal(requests, 1);
});

test("changed credential metadata never reuses the same rejected access token", async (t) => {
  const f = await fixture(t);
  const modify = f.store.modify;
  f.store.modify = async (...args) => {
    await f.store.write({ ...old(), refreshToken: "changed-refresh" });
    return modify(...args);
  };
  let requests = 0;
  const auth = authFor(f.store, async (_url, options) => {
    requests++; assert.equal(options.body.get("refresh_token"), "changed-refresh"); return response();
  });
  assert.equal(await auth.refreshAccessToken({ rejectedAccessToken: "old-access" }), "new-access");
  assert.equal(requests, 1);
});
