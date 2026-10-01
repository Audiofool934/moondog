// Fictional cross-process OAuth transport; every exchange is mediated by IPC.
import { PersistentCredentialStore } from "../../../src/runtime/pi/persistent-credential-store.mjs";
import { createSpotifyCredentialStore } from "../../../src/integrations/spotify/credential-store.mjs";
import { createSpotifyAuthentication } from "../../../src/integrations/spotify/authentication.mjs";
const [authFile, mode = "refresh"] = process.argv.slice(2);
const persistent = new PersistentCredentialStore({ authFile });
let storageFailure;
for (const method of ["read", "modify"]) {
  const original = persistent[method].bind(persistent);
  persistent[method] = async (...args) => {
    try { return await original(...args); }
    catch (error) {
      storageFailure = { method, code: error.code, causeCode: error.cause?.code };
      throw error;
    }
  };
}
const credentialStore = createSpotifyCredentialStore({ credentialStore: persistent });
const controller = new AbortController();
let release;
process.on("message", (message) => {
  if (message === "release") release?.();
  if (message === "abort") controller.abort();
});
process.send({ event: "ready" });
await new Promise((resolve) => process.once("message", resolve));
try {
  if (mode === "lock") {
    await persistent.modify("spotify", async (value) => {
      process.send({ event: "locked" });
      await new Promise((resolve) => { release = resolve; });
      return value;
    });
  } else {
    const auth = createSpotifyAuthentication({
      clientId: "fictional-client", credentialStore,
      fetchImpl: async (_url, options) => {
        process.send({ event: "exchange", refresh: options.body.get("refresh_token") });
        await new Promise((resolve) => { release = resolve; });
        return { ok: true, json: async () => ({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600, token_type: "Bearer" }) };
      },
    });
    const token = await auth.refreshAccessToken({ rejectedAccessToken: "old-access", signal: controller.signal });
    process.send({ event: "token", token });
  }
} catch (error) { process.send({ event: "error", code: error.code, storageFailure }); }
process.disconnect();
