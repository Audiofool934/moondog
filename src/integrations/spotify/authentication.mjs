import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const ACCESS_TOKEN_DEFAULT_LIFETIME_SECONDS = 60 * 60;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 30_000;

export const SPOTIFY_DEFAULT_REDIRECT_URI =
  "http://127.0.0.1:43821/callback";

export const SPOTIFY_DEFAULT_SCOPES = Object.freeze([
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-read-private",
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-modify-private",
  "user-library-read",
  "user-library-modify",
  "user-read-recently-played",
]);

export class SpotifyAuthenticationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpotifyAuthenticationError";
    this.code = code;
  }
}

function safeError(code, message) {
  return new SpotifyAuthenticationError(code, message);
}

function abortError() {
  return safeError(
    "spotify_auth_aborted",
    "Spotify authentication was cancelled.",
  );
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function assertNonEmptyString(value, code, message) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw safeError(code, message);
  }
  return value;
}

function normalizeScopes(scopes) {
  const values = Array.isArray(scopes)
    ? scopes
    : typeof scopes === "string"
      ? scopes.split(/\s+/u).filter(Boolean)
      : [];
  if (values.length === 0) {
    throw safeError(
      "spotify_scope_invalid",
      "Spotify authentication requires at least one scope.",
    );
  }
  const normalized = [];
  for (const scope of values) {
    if (typeof scope !== "string" || scope.trim().length === 0) {
      throw safeError(
        "spotify_scope_invalid",
        "Spotify authentication received an invalid scope.",
      );
    }
    const value = scope.trim();
    if (!normalized.includes(value)) normalized.push(value);
  }
  return normalized.sort().join(" ");
}

function normalizeRedirectUri(value) {
  let redirect;
  try {
    redirect = new URL(value);
  } catch {
    throw safeError(
      "spotify_redirect_uri_invalid",
      "Spotify authentication requires a valid loopback callback URL.",
    );
  }
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.port.length === 0 ||
    redirect.pathname !== "/callback" ||
    redirect.username.length > 0 ||
    redirect.password.length > 0 ||
    redirect.search.length > 0 ||
    redirect.hash.length > 0
  ) {
    throw safeError(
      "spotify_redirect_uri_invalid",
      "Spotify authentication requires an exact 127.0.0.1 loopback callback URL.",
    );
  }
  return redirect;
}

function sameOpaqueValue(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function secondsFromPayload(payload, names) {
  for (const name of names) {
    if (payload[name] === undefined) continue;
    if (!Number.isFinite(payload[name]) || payload[name] <= 0) {
      throw safeError(
        "spotify_token_response_invalid",
        "Spotify returned invalid token expiry metadata.",
      );
    }
    return payload[name];
  }
  return undefined;
}

function scopesFromPayload(payload, fallbackScopes) {
  if (payload.scope === undefined) return fallbackScopes;
  if (typeof payload.scope !== "string") {
    throw safeError(
      "spotify_token_response_invalid",
      "Spotify returned invalid token scope metadata.",
    );
  }
  const values = payload.scope.split(/\s+/u).filter(Boolean);
  return values.length > 0 ? normalizeScopes(values) : fallbackScopes;
}

function addCalendarMonths(timestamp, count) {
  const value = new Date(timestamp);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + count);
  const nextMonth = new Date(value.getTime());
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  nextMonth.setUTCDate(0);
  value.setUTCDate(Math.min(day, nextMonth.getUTCDate()));
  return value.getTime();
}

function credentialFromTokenPayload(
  payload,
  {
    fallbackRefreshToken,
    fallbackRefreshExpiresAt = null,
    fallbackScopes = [],
    now,
  },
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw safeError(
      "spotify_token_response_invalid",
      "Spotify returned an invalid token response.",
    );
  }
  const accessToken = assertNonEmptyString(
    payload.access_token,
    "spotify_token_response_invalid",
    "Spotify returned an invalid access token.",
  );
  const refreshToken = payload.refresh_token ?? fallbackRefreshToken;
  assertNonEmptyString(
    refreshToken,
    "spotify_token_response_invalid",
    "Spotify returned an invalid refresh token.",
  );
  if (
    payload.token_type !== undefined &&
    (typeof payload.token_type !== "string" ||
      payload.token_type.toLowerCase() !== "bearer")
  ) {
    throw safeError(
      "spotify_token_response_invalid",
      "Spotify returned an unsupported token type.",
    );
  }

  const issuedAt = now();
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw safeError(
      "spotify_clock_invalid",
      "Spotify authentication could not read the current time.",
    );
  }
  const accessLifetime =
    secondsFromPayload(payload, ["expires_in"]) ??
    ACCESS_TOKEN_DEFAULT_LIFETIME_SECONDS;
  const refreshLifetime = secondsFromPayload(payload, [
    "refresh_expires_in",
    "refresh_token_expires_in",
  ]);

  return {
    type: "oauth",
    accessToken,
    refreshToken,
    accessExpiresAt: issuedAt + Math.round(accessLifetime * 1_000),
    refreshExpiresAt:
      refreshLifetime === undefined
        ? (fallbackRefreshExpiresAt ?? addCalendarMonths(issuedAt, 6))
        : issuedAt + Math.round(refreshLifetime * 1_000),
    tokenType: "Bearer",
    scope: scopesFromPayload(payload, fallbackScopes),
  };
}

function validateStoredCredential(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.type !== "oauth" ||
    typeof value.accessToken !== "string" ||
    value.accessToken.length === 0 ||
    typeof value.refreshToken !== "string" ||
    value.refreshToken.length === 0 ||
    !Number.isSafeInteger(value.accessExpiresAt) ||
    value.accessExpiresAt <= 0 ||
    !Number.isSafeInteger(value.refreshExpiresAt) ||
    value.refreshExpiresAt <= 0 ||
    value.tokenType !== "Bearer" ||
    typeof value.scope !== "string" ||
    value.scope.length === 0
  ) {
    throw safeError(
      "spotify_credential_invalid",
      "The stored Spotify credential is invalid.",
    );
  }
  return structuredClone(value);
}

function publicStatus(credential) {
  if (!credential) {
    return {
      provider: "spotify",
      state: "not_configured",
      type: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
    };
  }
  return {
    provider: "spotify",
    state: "stored",
    type: "oauth",
    accessExpiresAt: credential.accessExpiresAt,
    refreshExpiresAt: credential.refreshExpiresAt,
    scopes: credential.scope,
  };
}

async function requestToken(
  body,
  {
    fetchImpl,
    signal,
    failureCode,
    fallbackRefreshToken,
    fallbackRefreshExpiresAt,
    fallbackScopes,
    now,
  },
) {
  assertNotAborted(signal);
  let response;
  try {
    response = await fetchImpl(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal,
    });
  } catch {
    if (signal?.aborted) throw abortError();
    throw safeError(failureCode, "Spotify token request failed.");
  }
  if (!response?.ok) {
    throw safeError(failureCode, "Spotify token request failed.");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw safeError(
      "spotify_token_response_invalid",
      "Spotify returned an invalid token response.",
    );
  }
  return credentialFromTokenPayload(payload, {
    fallbackRefreshToken,
    fallbackRefreshExpiresAt,
    fallbackScopes,
    now,
  });
}

export function createSpotifyPkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function createSpotifyAuthorizationUrl({
  clientId,
  redirectUri = SPOTIFY_DEFAULT_REDIRECT_URI,
  scopes = SPOTIFY_DEFAULT_SCOPES,
  state,
  codeChallenge,
  showDialog = false,
}) {
  assertNonEmptyString(
    clientId,
    "spotify_client_id_invalid",
    "Spotify authentication requires a client ID.",
  );
  assertNonEmptyString(
    state,
    "spotify_state_invalid",
    "Spotify authentication requires an OAuth state value.",
  );
  assertNonEmptyString(
    codeChallenge,
    "spotify_pkce_invalid",
    "Spotify authentication requires a PKCE challenge.",
  );
  const redirect = normalizeRedirectUri(redirectUri);
  const requestedScopes = normalizeScopes(scopes);
  const url = new URL(SPOTIFY_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect.href);
  url.searchParams.set("scope", requestedScopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", codeChallenge);
  if (showDialog) url.searchParams.set("show_dialog", "true");
  return url.href;
}

export async function exchangeSpotifyAuthorizationCode({
  clientId,
  code,
  codeVerifier,
  redirectUri = SPOTIFY_DEFAULT_REDIRECT_URI,
  scopes = SPOTIFY_DEFAULT_SCOPES,
  fetchImpl = globalThis.fetch,
  signal,
  now = Date.now,
}) {
  assertNonEmptyString(
    clientId,
    "spotify_client_id_invalid",
    "Spotify authentication requires a client ID.",
  );
  assertNonEmptyString(
    code,
    "spotify_authorization_code_invalid",
    "Spotify authentication requires an authorization code.",
  );
  assertNonEmptyString(
    codeVerifier,
    "spotify_pkce_invalid",
    "Spotify authentication requires a PKCE verifier.",
  );
  const redirect = normalizeRedirectUri(redirectUri);
  const requestedScopes = normalizeScopes(scopes);
  if (typeof fetchImpl !== "function") {
    throw safeError(
      "spotify_fetch_unavailable",
      "Spotify authentication requires an HTTP client.",
    );
  }

  return requestToken(
    new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirect.href,
    }),
    {
      fetchImpl,
      signal,
      failureCode: "spotify_token_exchange_failed",
      fallbackRefreshToken: undefined,
      fallbackRefreshExpiresAt: null,
      fallbackScopes: requestedScopes,
      now,
    },
  );
}

export async function refreshSpotifyAccessToken({
  clientId,
  refreshToken,
  refreshExpiresAt = null,
  scopes = SPOTIFY_DEFAULT_SCOPES,
  fetchImpl = globalThis.fetch,
  signal,
  now = Date.now,
}) {
  assertNonEmptyString(
    clientId,
    "spotify_client_id_invalid",
    "Spotify authentication requires a client ID.",
  );
  assertNonEmptyString(
    refreshToken,
    "spotify_refresh_token_invalid",
    "Spotify authentication requires a refresh token.",
  );
  const requestedScopes = normalizeScopes(scopes);
  if (typeof fetchImpl !== "function") {
    throw safeError(
      "spotify_fetch_unavailable",
      "Spotify authentication requires an HTTP client.",
    );
  }
  assertNotAborted(signal);
  if (
    refreshExpiresAt !== null &&
    (!Number.isSafeInteger(refreshExpiresAt) || refreshExpiresAt <= 0)
  ) {
    throw safeError(
      "spotify_refresh_expiry_invalid",
      "Spotify authentication received invalid refresh expiry metadata.",
    );
  }
  if (refreshExpiresAt !== null && refreshExpiresAt <= now()) {
    throw safeError(
      "spotify_refresh_expired",
      "Spotify authorization has expired and must be renewed.",
    );
  }

  return requestToken(
    new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    {
      fetchImpl,
      signal,
      failureCode: "spotify_token_refresh_failed",
      fallbackRefreshToken: refreshToken,
      fallbackRefreshExpiresAt: refreshExpiresAt,
      fallbackScopes: requestedScopes,
      now,
    },
  );
}

function openInDefaultBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function createCallbackListener({ redirectUri, expectedState, signal }) {
  const redirect = normalizeRedirectUri(redirectUri);
  let resolveCode;
  let rejectCode;
  let settled = false;
  let closing;
  const authorizationCode = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  authorizationCode.catch(() => {});

  const server = createServer((request, response) => {
    response.setHeader("connection", "close");
    let callback;
    try {
      callback = new URL(request.url ?? "/", redirect);
    } catch {
      response.writeHead(400).end("Invalid Spotify callback.");
      return;
    }
    if (request.method !== "GET" || callback.pathname !== redirect.pathname) {
      response.writeHead(404).end("Not found.");
      return;
    }

    const state = callback.searchParams.get("state");
    if (!sameOpaqueValue(state, expectedState)) {
      response.writeHead(400).end("Spotify callback rejected.");
      finish(
        safeError(
          "spotify_oauth_state_mismatch",
          "Spotify authentication rejected an invalid OAuth state.",
        ),
      );
      return;
    }
    if (callback.searchParams.has("error")) {
      response.writeHead(400).end("Spotify authorization was not completed.");
      finish(
        safeError(
          "spotify_authorization_denied",
          "Spotify authorization was not completed.",
        ),
      );
      return;
    }
    const code = callback.searchParams.get("code");
    if (!code) {
      response.writeHead(400).end("Spotify callback rejected.");
      finish(
        safeError(
          "spotify_authorization_code_missing",
          "Spotify authentication did not receive an authorization code.",
        ),
      );
      return;
    }
    response
      .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      .end("Spotify authorization complete. You can close this window.");
    finish(undefined, code);
  });

  const close = () => {
    if (closing) return closing;
    signal?.removeEventListener("abort", onAbort);
    if (!server.listening) return Promise.resolve();
    closing = new Promise((resolve) => {
      server.close(() => resolve());
    });
    return closing;
  };

  const finish = (error, code) => {
    if (settled) return;
    settled = true;
    if (error) rejectCode(error);
    else resolveCode(code);
    void close();
  };

  const onAbort = () => finish(abortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  server.on("error", () => {
    finish(
      safeError(
        "spotify_callback_listener_failed",
        "Spotify authentication could not receive the browser callback.",
      ),
    );
  });

  try {
    await new Promise((resolve, reject) => {
      const onStartupError = () => {
        server.off("listening", onListening);
        reject(
          safeError(
            "spotify_callback_listener_failed",
            "Spotify authentication could not start its loopback callback.",
          ),
        );
      };
      const onListening = () => {
        server.off("error", onStartupError);
        resolve();
      };
      server.once("error", onStartupError);
      server.once("listening", onListening);
      server.listen(Number(redirect.port), "127.0.0.1");
    });
  } catch (error) {
    await close();
    throw error;
  }
  if (signal?.aborted) {
    await close();
    throw abortError();
  }
  return { authorizationCode, close };
}

function assertCredentialStore(store) {
  if (
    !store ||
    typeof store.read !== "function" ||
    typeof store.write !== "function" ||
    typeof store.delete !== "function"
  ) {
    throw safeError(
      "spotify_credential_store_invalid",
      "Spotify authentication requires a credential store.",
    );
  }
}

export function createSpotifyAuthentication({
  clientId,
  credentialStore,
  openBrowser = openInDefaultBrowser,
  fetchImpl = globalThis.fetch,
  redirectUri = SPOTIFY_DEFAULT_REDIRECT_URI,
  scopes = SPOTIFY_DEFAULT_SCOPES,
  now = Date.now,
} = {}) {
  assertNonEmptyString(
    clientId,
    "spotify_client_id_invalid",
    "Spotify authentication requires a client ID.",
  );
  assertCredentialStore(credentialStore);
  if (typeof openBrowser !== "function") {
    throw safeError(
      "spotify_browser_opener_invalid",
      "Spotify authentication requires a browser opener.",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw safeError(
      "spotify_fetch_unavailable",
      "Spotify authentication requires an HTTP client.",
    );
  }
  const redirect = normalizeRedirectUri(redirectUri);
  const requestedScopes = normalizeScopes(scopes);

  const readCredential = async (options = {}) => {
    let value;
    try {
      value = await credentialStore.read(options);
    } catch {
      throw safeError(
        "spotify_credential_store_failed",
        "Spotify credential storage could not be read.",
      );
    }
    return value === undefined ? undefined : validateStoredCredential(value);
  };

  const writeCredential = async (credential, options = {}) => {
    try {
      await credentialStore.write(structuredClone(credential), options);
    } catch {
      throw safeError(
        "spotify_credential_store_failed",
        "Spotify credential storage could not be updated.",
      );
    }
  };

  return {
    async login({ signal, onAuthorizationUrl } = {}) {
      assertNotAborted(signal);
      if (
        onAuthorizationUrl !== undefined &&
        typeof onAuthorizationUrl !== "function"
      ) {
        throw safeError(
          "spotify_authorization_callback_invalid",
          "Spotify authentication received an invalid URL callback.",
        );
      }
      const { verifier, challenge } = createSpotifyPkcePair();
      const state = randomBytes(32).toString("base64url");
      const listener = await createCallbackListener({
        redirectUri: redirect.href,
        expectedState: state,
        signal,
      });
      const authorizationUrl = createSpotifyAuthorizationUrl({
        clientId,
        redirectUri: redirect.href,
        scopes: requestedScopes,
        state,
        codeChallenge: challenge,
      });

      try {
        try {
          await onAuthorizationUrl?.(authorizationUrl);
          await openBrowser(authorizationUrl);
        } catch {
          throw safeError(
            "spotify_browser_open_failed",
            "Spotify authentication could not open the authorization page.",
          );
        }
        const code = await listener.authorizationCode;
        assertNotAborted(signal);
        const credential = await exchangeSpotifyAuthorizationCode({
          clientId,
          code,
          codeVerifier: verifier,
          redirectUri: redirect.href,
          scopes: requestedScopes,
          fetchImpl,
          signal,
          now,
        });
        await writeCredential(credential, { signal });
        return publicStatus(credential);
      } finally {
        await listener.close();
      }
    },

    async status({ signal } = {}) {
      assertNotAborted(signal);
      return publicStatus(await readCredential({ signal }));
    },

    async getAccessToken({ signal } = {}) {
      assertNotAborted(signal);
      const credential = await readCredential({ signal });
      if (!credential) {
        throw safeError(
          "spotify_auth_not_configured",
          "Spotify is not authenticated.",
        );
      }
      if (credential.accessExpiresAt > now() + ACCESS_TOKEN_REFRESH_WINDOW_MS) {
        return credential.accessToken;
      }
      const refreshed = await refreshSpotifyAccessToken({
        clientId,
        refreshToken: credential.refreshToken,
        refreshExpiresAt: credential.refreshExpiresAt,
        scopes: credential.scope,
        fetchImpl,
        signal,
        now,
      });
      await writeCredential(refreshed, { signal });
      return refreshed.accessToken;
    },

    async logout({ signal } = {}) {
      assertNotAborted(signal);
      try {
        await credentialStore.delete({ signal });
      } catch {
        throw safeError(
          "spotify_credential_store_failed",
          "Spotify credential storage could not be updated.",
        );
      }
      return publicStatus(undefined);
    },
  };
}
