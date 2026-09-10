import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import {
  SPOTIFY_DEFAULT_REDIRECT_URI,
  createSpotifyAuthentication,
  createSpotifyAuthorizationUrl,
  createSpotifyPkcePair,
  exchangeSpotifyAuthorizationCode,
  refreshSpotifyAccessToken,
} from "../../src/integrations/spotify/authentication.mjs";

const clientId = "SPOTIFY_CLIENT_ID_SENTINEL";
const scopes = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-playback-state",
];

function successfulResponse(payload) {
  return {
    ok: true,
    async json() {
      return structuredClone(payload);
    },
  };
}

function memoryCredentialStore(initial) {
  let credential = initial ? structuredClone(initial) : undefined;
  return {
    async read() {
      return credential ? structuredClone(credential) : undefined;
    },
    async write(value) {
      credential = structuredClone(value);
    },
    async delete() {
      credential = undefined;
    },
    snapshot() {
      return credential ? structuredClone(credential) : undefined;
    },
  };
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function assertPortCanBeReused(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("PKCE authorization URL uses the exact registered loopback callback", () => {
  assert.equal(
    SPOTIFY_DEFAULT_REDIRECT_URI,
    "http://127.0.0.1:43821/callback",
  );
  const { verifier, challenge } = createSpotifyPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(
    challenge,
    createHash("sha256").update(verifier).digest("base64url"),
  );

  const authorizationUrl = createSpotifyAuthorizationUrl({
    clientId,
    scopes,
    state: "STATE_SENTINEL",
    codeChallenge: challenge,
  });
  const parsed = new URL(authorizationUrl);
  assert.equal(parsed.origin, "https://accounts.spotify.com");
  assert.equal(parsed.pathname, "/authorize");
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("client_id"), clientId);
  assert.equal(
    parsed.searchParams.get("redirect_uri"),
    SPOTIFY_DEFAULT_REDIRECT_URI,
  );
  assert.equal(
    parsed.searchParams.get("scope"),
    "user-modify-playback-state user-read-playback-state",
  );
  assert.equal(parsed.searchParams.get("state"), "STATE_SENTINEL");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("code_challenge"), challenge);
  assert.equal(parsed.searchParams.has("client_secret"), false);

  assert.throws(
    () =>
      createSpotifyAuthorizationUrl({
        clientId,
        redirectUri: "http://localhost:43821/callback",
        scopes,
        state: "STATE_SENTINEL",
        codeChallenge: challenge,
      }),
    { code: "spotify_redirect_uri_invalid" },
  );
});

test("authorization code exchange records access and refresh expiry metadata", async () => {
  const issuedAt = Date.UTC(2026, 7, 26, 4, 0, 0);
  let request;
  const credential = await exchangeSpotifyAuthorizationCode({
    clientId,
    code: "AUTHORIZATION_CODE_SENTINEL",
    codeVerifier: "PKCE_VERIFIER_SENTINEL",
    scopes,
    now: () => issuedAt,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return successfulResponse({
        access_token: "ACCESS_TOKEN_SENTINEL",
        refresh_token: "REFRESH_TOKEN_SENTINEL",
        expires_in: 3_600,
        refresh_token_expires_in: 7_200,
        token_type: "Bearer",
        scope: "user-read-playback-state user-modify-playback-state",
      });
    },
  });

  assert.equal(request.url, "https://accounts.spotify.com/api/token");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.body.get("grant_type"), "authorization_code");
  assert.equal(
    request.options.body.get("code"),
    "AUTHORIZATION_CODE_SENTINEL",
  );
  assert.equal(
    request.options.body.get("code_verifier"),
    "PKCE_VERIFIER_SENTINEL",
  );
  assert.equal(request.options.body.get("client_id"), clientId);
  assert.equal(request.options.body.has("client_secret"), false);
  assert.deepEqual(credential, {
    type: "oauth",
    accessToken: "ACCESS_TOKEN_SENTINEL",
    refreshToken: "REFRESH_TOKEN_SENTINEL",
    accessExpiresAt: issuedAt + 3_600_000,
    refreshExpiresAt: issuedAt + 7_200_000,
    tokenType: "Bearer",
    scope: "user-modify-playback-state user-read-playback-state",
  });
});

test("token refresh preserves the refresh token, deadline, and normalized scope", async () => {
  const issuedAt = Date.UTC(2026, 7, 26, 4, 0, 0);
  const refreshExpiresAt = Date.UTC(2027, 1, 26, 4, 0, 0);
  let requestBody;
  const credential = await refreshSpotifyAccessToken({
    clientId,
    refreshToken: "REFRESH_TOKEN_SENTINEL",
    refreshExpiresAt,
    scopes: "user-read-playback-state user-modify-playback-state",
    now: () => issuedAt,
    fetchImpl: async (_url, options) => {
      requestBody = options.body;
      return successfulResponse({
        access_token: "ROTATED_ACCESS_TOKEN_SENTINEL",
        expires_in: 3_600,
        token_type: "Bearer",
      });
    },
  });

  assert.equal(requestBody.get("grant_type"), "refresh_token");
  assert.equal(
    requestBody.get("refresh_token"),
    "REFRESH_TOKEN_SENTINEL",
  );
  assert.equal(requestBody.get("client_id"), clientId);
  assert.equal(requestBody.has("client_secret"), false);
  assert.deepEqual(credential, {
    type: "oauth",
    accessToken: "ROTATED_ACCESS_TOKEN_SENTINEL",
    refreshToken: "REFRESH_TOKEN_SENTINEL",
    accessExpiresAt: issuedAt + 3_600_000,
    refreshExpiresAt,
    tokenType: "Bearer",
    scope: "user-modify-playback-state user-read-playback-state",
  });
});

test("browser login validates state, persists OAuth, and returns metadata only", async () => {
  const port = await availableLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const issuedAt = Date.UTC(2026, 7, 26, 4, 0, 0);
  const expectedRefreshExpiry = Date.UTC(2027, 1, 26, 4, 0, 0);
  const credentialStore = memoryCredentialStore();
  let displayedUrl;
  let openedUrl;
  let callbackResponse;
  let tokenBody;

  const authentication = createSpotifyAuthentication({
    clientId,
    credentialStore,
    redirectUri,
    scopes,
    now: () => issuedAt,
    openBrowser: async (authorizationUrl) => {
      openedUrl = authorizationUrl;
      const authorization = new URL(authorizationUrl);
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "AUTHORIZATION_CODE_SENTINEL");
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callbackResponse = await fetch(callback);
    },
    fetchImpl: async (_url, options) => {
      tokenBody = options.body;
      return successfulResponse({
        access_token: "ACCESS_TOKEN_SENTINEL",
        refresh_token: "REFRESH_TOKEN_SENTINEL",
        expires_in: 3_600,
        token_type: "Bearer",
      });
    },
  });

  const status = await authentication.login({
    onAuthorizationUrl(url) {
      displayedUrl = url;
    },
  });

  assert.equal(openedUrl, displayedUrl);
  assert.equal(callbackResponse.status, 200);
  assert.match(await callbackResponse.text(), /authorization complete/iu);
  const opened = new URL(openedUrl);
  const verifier = tokenBody.get("code_verifier");
  assert.equal(
    opened.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
  assert.equal(tokenBody.get("redirect_uri"), redirectUri);
  assert.deepEqual(status, {
    provider: "spotify",
    state: "stored",
    type: "oauth",
    accessExpiresAt: issuedAt + 3_600_000,
    refreshExpiresAt: expectedRefreshExpiry,
    scopes: "user-modify-playback-state user-read-playback-state",
  });
  assert.equal(JSON.stringify(status).includes("TOKEN_SENTINEL"), false);
  assert.deepEqual(await authentication.status(), status);
  assert.deepEqual(credentialStore.snapshot(), {
    type: "oauth",
    accessToken: "ACCESS_TOKEN_SENTINEL",
    refreshToken: "REFRESH_TOKEN_SENTINEL",
    accessExpiresAt: issuedAt + 3_600_000,
    refreshExpiresAt: expectedRefreshExpiry,
    tokenType: "Bearer",
    scope: "user-modify-playback-state user-read-playback-state",
  });
  await assertPortCanBeReused(port);
});

test("state mismatch is rejected without persisting or leaking callback data", async () => {
  const port = await availableLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const credentialStore = memoryCredentialStore();
  let tokenRequests = 0;
  const authentication = createSpotifyAuthentication({
    clientId,
    credentialStore,
    redirectUri,
    openBrowser: async () => {
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "CALLBACK_CODE_SENTINEL");
      callback.searchParams.set("state", "INVALID_STATE_SENTINEL");
      const response = await fetch(callback);
      assert.equal(response.status, 400);
    },
    fetchImpl: async () => {
      tokenRequests += 1;
      throw new Error("must not exchange an invalid callback");
    },
  });

  await assert.rejects(authentication.login(), (error) => {
    assert.equal(error.code, "spotify_oauth_state_mismatch");
    assert.equal(error.message.includes("CALLBACK_CODE_SENTINEL"), false);
    assert.equal(error.message.includes("INVALID_STATE_SENTINEL"), false);
    return true;
  });
  assert.equal(tokenRequests, 0);
  assert.equal(credentialStore.snapshot(), undefined);
  await assertPortCanBeReused(port);
});

test("aborting login closes the loopback listener", async () => {
  const port = await availableLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const controller = new AbortController();
  const authentication = createSpotifyAuthentication({
    clientId,
    credentialStore: memoryCredentialStore(),
    redirectUri,
    openBrowser: async () => {
      controller.abort();
    },
    fetchImpl: async () => {
      throw new Error("must not exchange after abort");
    },
  });

  await assert.rejects(authentication.login({ signal: controller.signal }), {
    code: "spotify_auth_aborted",
  });
  await assertPortCanBeReused(port);
});

test("access token retrieval refreshes expired OAuth and logout stays metadata-only", async () => {
  const issuedAt = Date.UTC(2026, 7, 26, 4, 0, 0);
  const refreshExpiresAt = Date.UTC(2027, 1, 26, 4, 0, 0);
  const credentialStore = memoryCredentialStore({
    type: "oauth",
    accessToken: "EXPIRED_ACCESS_TOKEN_SENTINEL",
    refreshToken: "REFRESH_TOKEN_SENTINEL",
    accessExpiresAt: issuedAt - 1,
    refreshExpiresAt,
    tokenType: "Bearer",
    scope: "user-modify-playback-state user-read-playback-state",
  });
  const authentication = createSpotifyAuthentication({
    clientId,
    credentialStore,
    now: () => issuedAt,
    openBrowser: async () => {},
    fetchImpl: async () =>
      successfulResponse({
        access_token: "ROTATED_ACCESS_TOKEN_SENTINEL",
        expires_in: 3_600,
        token_type: "Bearer",
      }),
  });

  assert.equal(
    await authentication.getAccessToken(),
    "ROTATED_ACCESS_TOKEN_SENTINEL",
  );
  const status = await authentication.status();
  assert.deepEqual(status, {
    provider: "spotify",
    state: "stored",
    type: "oauth",
    accessExpiresAt: issuedAt + 3_600_000,
    refreshExpiresAt,
    scopes: "user-modify-playback-state user-read-playback-state",
  });
  assert.equal(JSON.stringify(status).includes("TOKEN_SENTINEL"), false);
  assert.deepEqual(await authentication.logout(), {
    provider: "spotify",
    state: "not_configured",
    type: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
  });
  assert.equal(credentialStore.snapshot(), undefined);
});

test("token endpoint failures do not expose response credentials", async () => {
  await assert.rejects(
    exchangeSpotifyAuthorizationCode({
      clientId,
      code: "AUTHORIZATION_CODE_SENTINEL",
      codeVerifier: "PKCE_VERIFIER_SENTINEL",
      fetchImpl: async () => ({
        ok: false,
        async json() {
          return {
            error: "invalid_grant",
            access_token: "LEAKED_ACCESS_TOKEN_SENTINEL",
          };
        },
      }),
    }),
    (error) => {
      assert.equal(error.code, "spotify_token_exchange_failed");
      assert.equal(error.message.includes("LEAKED_ACCESS_TOKEN_SENTINEL"), false);
      assert.equal(error.message.includes("AUTHORIZATION_CODE_SENTINEL"), false);
      return true;
    },
  );
});
