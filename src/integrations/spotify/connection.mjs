import { createSpotifyAuthentication, SPOTIFY_DEFAULT_SCOPES } from "./authentication.mjs";
import { createSpotifyCatalogResolver } from "./catalog-resolver.mjs";
import { createSpotifyCredentialStore } from "./credential-store.mjs";
import { createSpotifyService } from "./service.mjs";
import { readSpotifyConfiguration } from "./settings.mjs";
import { createSpotifyWebApiClient } from "./web-api-client.mjs";

function disconnectedStatus(reason = "client_id_required") {
  return {
    provider: "spotify",
    state: "not_configured",
    reason,
    authentication: "not_configured",
    client_id_configured: false,
    external_effects: "disabled",
  };
}

function grantedScopes(authenticationStatus) {
  if (typeof authenticationStatus?.scopes !== "string") return [];
  return authenticationStatus.scopes.split(/\s+/u).filter(Boolean).sort();
}

function connectedStatus(authenticationStatus, now = Date.now()) {
  const stored = authenticationStatus?.state === "stored";
  const refreshValid =
    stored &&
    Number.isSafeInteger(authenticationStatus.refreshExpiresAt) &&
    authenticationStatus.refreshExpiresAt > now;
  const granted = grantedScopes(authenticationStatus);
  const missingScopes = SPOTIFY_DEFAULT_SCOPES.filter(
    (scope) => !granted.includes(scope),
  );
  return {
    provider: "spotify",
    state: refreshValid ? "ready" : stored ? "reauthentication_required" : "not_authenticated",
    authentication: stored ? "stored" : "not_configured",
    client_id_configured: true,
    access_expires_at: authenticationStatus?.accessExpiresAt ?? null,
    refresh_expires_at: authenticationStatus?.refreshExpiresAt ?? null,
    external_effects: refreshValid ? "spotify_control" : "disabled",
    scopes: {
      granted,
      missing: missingScopes,
      sufficient: missingScopes.length === 0,
    },
  };
}

export async function openSpotifyConnection({
  environment = process.env,
  credentialStore,
  fetchImpl = globalThis.fetch,
  openBrowser,
  now = Date.now,
  resolutionCache = null,
} = {}) {
  const configuration = await readSpotifyConfiguration(environment);
  if (!configuration) {
    return {
      service: null,
      resolver: null,
      authentication: null,
      ready: () => false,
      publicStatus: () => disconnectedStatus(),
    };
  }

  const spotifyCredentialStore = createSpotifyCredentialStore({
    environment,
    ...(credentialStore ? { credentialStore } : {}),
  });
  const authentication = createSpotifyAuthentication({
    clientId: configuration.clientId,
    credentialStore: spotifyCredentialStore,
    fetchImpl,
    ...(openBrowser ? { openBrowser } : {}),
    now,
  });
  const client = createSpotifyWebApiClient({
    fetchImpl,
    tokenProvider: () => authentication.getAccessToken(),
  });
  const service = createSpotifyService({ client });
  const resolver = createSpotifyCatalogResolver({
    client,
    ...(resolutionCache ? { cache: resolutionCache } : {}),
  });
  let status = connectedStatus(await authentication.status(), now());

  return {
    service,
    resolver,
    authentication,

    ready() {
      return status.state === "ready";
    },

    publicStatus() {
      return structuredClone(status);
    },

    missingScopes() {
      return [...status.scopes.missing];
    },

    async login(options) {
      const authenticationStatus = await authentication.login(options);
      status = connectedStatus(authenticationStatus, now());
      return structuredClone(status);
    },

    async logout(options) {
      const authenticationStatus = await authentication.logout(options);
      status = connectedStatus(authenticationStatus, now());
      return structuredClone(status);
    },

    async refreshStatus(options) {
      status = connectedStatus(await authentication.status(options), now());
      return structuredClone(status);
    },
  };
}
