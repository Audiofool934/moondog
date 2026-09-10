export {
  SPOTIFY_WEB_API_BASE_URL,
  SPOTIFY_WEB_API_LIMITS,
  SpotifyWebApiError,
  createSpotifyWebApiClient,
} from "./web-api-client.mjs";

export {
  SPOTIFY_SERVICE_LIMITS,
  SpotifyServiceError,
  createSpotifyService,
} from "./service.mjs";

export {
  SPOTIFY_DEFAULT_REDIRECT_URI,
  SPOTIFY_DEFAULT_SCOPES,
  SpotifyAuthenticationError,
  createSpotifyAuthentication,
} from "./authentication.mjs";

export { createSpotifyCredentialStore } from "./credential-store.mjs";
export { openSpotifyConnection } from "./connection.mjs";

export {
  SPOTIFY_CATALOG_RESOLVER_LIMITS,
  SpotifyCatalogResolverError,
  createSpotifyCatalogResolver,
} from "./catalog-resolver.mjs";

export {
  SPOTIFY_RESOLUTION_CACHE_KEY_VERSION,
  SPOTIFY_RESOLUTION_CACHE_SCHEMA_VERSION,
  createInMemorySpotifyResolutionCache,
  defaultSpotifyResolutionCachePath,
  openSpotifyResolutionCache,
  resolveSpotifyResolutionCachePath,
  spotifyResolutionCacheKey,
} from "./resolution-cache.mjs";

export {
  SPOTIFY_LISTENING_EVENT_NAMESPACE,
  SPOTIFY_RECENT_ACTIVITY_SOURCE,
  SPOTIFY_TRACK_NAMESPACE,
  projectSpotifyRecentActivity,
} from "./recent-activity.mjs";

export {
  SPOTIFY_ACCOUNT_DATA_BATCH_NAMESPACE,
  SPOTIFY_ACCOUNT_DATA_EVENT_NAMESPACE,
  SPOTIFY_ACCOUNT_DATA_HISTORY_FORMAT,
  SPOTIFY_ACCOUNT_DATA_HISTORY_LIMITS,
  SPOTIFY_ACCOUNT_DATA_HISTORY_SCOPE,
  SPOTIFY_ACCOUNT_DATA_HISTORY_SOURCE,
  SPOTIFY_ACCOUNT_DATA_TRACK_NAMESPACE,
  SpotifyAccountDataHistoryError,
  projectSpotifyAccountDataHistory,
  readSpotifyAccountDataHistoryArchive,
  spotifyAccountDataEventIdentity,
  spotifyAccountDataTrackIdentity,
} from "./account-data-history.mjs";

export {
  SPOTIFY_EXTENDED_HISTORY_BATCH_NAMESPACE,
  SPOTIFY_EXTENDED_HISTORY_EVENT_NAMESPACE,
  SPOTIFY_EXTENDED_HISTORY_FORMAT,
  SPOTIFY_EXTENDED_HISTORY_LIMITS,
  SPOTIFY_EXTENDED_HISTORY_SCOPE,
  SPOTIFY_EXTENDED_HISTORY_SOURCE,
  SpotifyExtendedHistoryError,
  projectSpotifyExtendedStreamingHistory,
  readSpotifyExtendedStreamingHistoryArchive,
} from "./extended-streaming-history.mjs";

export { readSpotifyHistoryArchive } from "./history-archive.mjs";

export {
  readSpotifyConfiguration,
  resolveSpotifySettingsFile,
  writeSpotifyConfiguration,
} from "./settings.mjs";
