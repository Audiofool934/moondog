import { setTimeout as delay } from "node:timers/promises";

export const SPOTIFY_WEB_API_BASE_URL = "https://api.spotify.com/v1";

export const SPOTIFY_WEB_API_LIMITS = Object.freeze({
  responseBytesMax: 2_000_000,
  textLengthMax: 256,
  devicesMax: 20,
  queueItemsMax: 50,
  artistsPerItemMax: 5,
  searchResultsMax: 10,
  playlistTracksMax: 20,
  playlistsPageMax: 50,
  playlistItemsPageMax: 50,
  playlistEditTracksMax: 100,
  libraryItemsMax: 20,
  recentlyPlayedMax: 50,
  // 429 retry budget for idempotent requests: total attempts (initial plus
  // up to two retries). Retries are spaced by the server's Retry-After
  // header when present, with a bounded default and jitter, and never wait
  // longer than rateLimitMaxWaitMs for a single attempt.
  rateLimitMaxAttempts: 3,
  rateLimitDefaultWaitMs: 1_000,
  rateLimitMaxWaitMs: 10_000,
  rateLimitJitterMs: 250,
});

const playbackActions = new Set([
  "interrupting_playback",
  "pausing",
  "resuming",
  "seeking",
  "skipping_next",
  "skipping_prev",
  "toggling_repeat_context",
  "toggling_repeat_track",
  "toggling_shuffle",
  "transferring_playback",
]);

// Provider error bodies are untrusted and can contain identifiers or credentials.
// Keep only known machine reasons; never return an arbitrary response message.
const publicErrorReasons = new Set([
  "NO_ACTIVE_DEVICE", "PREMIUM_REQUIRED", "RESTRICTION_VIOLATED",
  "DEVICE_NOT_CONTROLLABLE", "REMOTE_CONTROL_DISALLOW", "CONTEXT_DISALLOW",
  "NOT_ALLOWED", "TRACK_NOT_PLAYABLE", "CONTENT_UNAVAILABLE", "NON_PLAYABLE",
  "QUOTA_EXCEEDED", "UNKNOWN", "NO_SPECIFIC_REASON",
]);

export function spotifyErrorReason(value) {
  return publicErrorReasons.has(value) ? value : null;
}

export class SpotifyWebApiError extends Error {
  constructor(code, message, { status = null, reason = null, retryAfterSeconds = null, outcomeUnknown = false } = {}) {
    super(message);
    this.name = "SpotifyWebApiError";
    this.code = code;
    this.provider = "spotify";
    this.status = status;
    this.reason = spotifyErrorReason(reason);
    this.retryAfterSeconds = retryAfterSeconds;
    this.outcomeUnknown = outcomeUnknown;
  }
}

function fail(code, message, options) {
  throw new SpotifyWebApiError(code, message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeText(value, maximum = SPOTIFY_WEB_API_LIMITS.textLengthMax) {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return undefined;
  return Array.from(cleaned).slice(0, maximum).join("");
}

function safeInteger(value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    return undefined;
  }
  return value;
}

function normalizedToken(value) {
  const token =
    typeof value === "string"
      ? value
      : isPlainObject(value)
        ? (value.accessToken ?? value.access_token ?? value.access)
        : undefined;
  if (typeof token !== "string" || !token.trim()) {
    fail(
      "spotify_access_token_unavailable",
      "Spotify authentication is not available.",
    );
  }
  return token.trim();
}

function retryAfterSeconds(headers) {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.min(Math.ceil(numeric), 86_400);
  }
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return null;
  return Math.min(Math.max(0, Math.ceil((date - Date.now()) / 1_000)), 86_400);
}

function defaultSleep(milliseconds, { signal } = {}) {
  return delay(milliseconds, undefined, { signal });
}

function quotaReason(payload) {
  if (!isPlainObject(payload)) return undefined;
  return safeText(payload.reason ?? payload.error?.reason, 64);
}

function hasInsufficientClientScope(payload) {
  return (
    isPlainObject(payload) &&
    safeText(payload.error?.message, 64) === "Insufficient client scope"
  );
}

function normalizeArtistNames(rawArtists) {
  if (!Array.isArray(rawArtists)) return [];
  const result = [];
  for (const artist of rawArtists) {
    const name = safeText(artist?.name);
    if (name && !result.includes(name)) result.push(name);
    if (result.length === SPOTIFY_WEB_API_LIMITS.artistsPerItemMax) break;
  }
  return result;
}

function normalizePlayableItem(raw) {
  if (!isPlainObject(raw)) return null;
  const type = ["track", "episode", "ad", "unknown"].includes(raw.type)
    ? raw.type
    : "unknown";
  const item = { type };
  const uri = safeText(raw.uri);
  const name = safeText(raw.name);
  const artists = normalizeArtistNames(raw.artists);
  const album = safeText(raw.album?.name);
  const publisher = safeText(raw.show?.publisher);
  const durationMs = safeInteger(raw.duration_ms, 0, 86_400_000);

  if (uri) item.uri = uri;
  if (name) item.name = name;
  if (artists.length > 0) item.artists = artists;
  if (album) item.album = album;
  if (publisher) item.publisher = publisher;
  if (durationMs !== undefined) item.duration_ms = durationMs;
  if (typeof raw.explicit === "boolean") item.explicit = raw.explicit;
  return item;
}

function normalizeDevice(raw) {
  if (!isPlainObject(raw)) return null;
  const id = safeText(raw.id);
  const name = safeText(raw.name);
  const type = safeText(raw.type, 64);
  if (!id || !name) return null;
  const device = {
    id,
    name,
    type: type ?? "unknown",
    is_active: raw.is_active === true,
    is_private_session: raw.is_private_session === true,
    is_restricted: raw.is_restricted === true,
    supports_volume: raw.supports_volume === true,
  };
  const volume = safeInteger(raw.volume_percent, 0, 100);
  if (volume !== undefined) device.volume_percent = volume;
  return device;
}

function normalizeDisallowedActions(raw) {
  if (!isPlainObject(raw)) return [];
  return Object.entries(raw)
    .filter(([key, value]) => playbackActions.has(key) && value === true)
    .map(([key]) => key)
    .sort();
}

function normalizeAccount(payload) {
  const account = { provider: "spotify" };
  if (!isPlainObject(payload)) return account;
  const accountId = safeText(payload.id, 128);
  const displayName = safeText(payload.display_name);
  const country = safeText(payload.country, 8);
  const product = safeText(payload.product, 32);
  if (accountId) account.account_id = accountId;
  if (displayName) account.display_name = displayName;
  if (country) account.country = country;
  if (product) account.product = product;
  if (isPlainObject(payload.explicit_content)) {
    account.explicit_content = {
      filter_enabled: payload.explicit_content.filter_enabled === true,
      filter_locked: payload.explicit_content.filter_locked === true,
    };
  }
  return account;
}

function normalizePlayback(payload) {
  if (!isPlainObject(payload)) {
    return { provider: "spotify", state: "inactive" };
  }
  const result = {
    provider: "spotify",
    state: "available",
    is_playing: payload.is_playing === true,
    shuffle_state: payload.shuffle_state === true,
    repeat_state: ["off", "track", "context"].includes(payload.repeat_state)
      ? payload.repeat_state
      : "off",
    currently_playing_type:
      safeText(payload.currently_playing_type, 32) ?? "unknown",
    disallowed_actions: normalizeDisallowedActions(payload.actions?.disallows ?? payload.actions),
  };
  const progressMs = safeInteger(payload.progress_ms, 0, 86_400_000);
  const timestamp = safeInteger(payload.timestamp, 0, Number.MAX_SAFE_INTEGER);
  const device = normalizeDevice(payload.device);
  const item = normalizePlayableItem(payload.item);
  const contextType = safeText(payload.context?.type, 32);
  const contextUri = safeText(payload.context?.uri);
  if (progressMs !== undefined) result.progress_ms = progressMs;
  if (timestamp !== undefined) result.observed_at_ms = timestamp;
  if (device) result.device = device;
  if (item) result.item = item;
  if (contextType || contextUri) {
    result.context = {};
    if (contextType) result.context.type = contextType;
    if (contextUri) result.context.uri = contextUri;
  }
  return result;
}

function normalizeDevices(payload) {
  const rawDevices = Array.isArray(payload?.devices) ? payload.devices : [];
  const devices = rawDevices
    .map(normalizeDevice)
    .filter(Boolean)
    .slice(0, SPOTIFY_WEB_API_LIMITS.devicesMax);
  return {
    provider: "spotify",
    devices,
    truncated: rawDevices.length > devices.length,
  };
}

function normalizeQueue(payload) {
  const rawQueue = Array.isArray(payload?.queue) ? payload.queue : [];
  const queue = rawQueue
    .map(normalizePlayableItem)
    .filter(Boolean)
    .slice(0, SPOTIFY_WEB_API_LIMITS.queueItemsMax);
  return {
    provider: "spotify",
    currently_playing: normalizePlayableItem(payload?.currently_playing),
    queue,
    truncated: rawQueue.length > queue.length,
  };
}

function normalizeTrackSearchItem(raw) {
  if (!isPlainObject(raw) || raw.is_local === true || raw.is_playable === false) return null;
  const uri = safeText(raw.uri);
  const id = safeText(raw.id, 128);
  const name = safeText(raw.name);
  if (!uri || !id || !name) return null;
  const item = {
    uri,
    id,
    name,
    artists: normalizeArtistNames(raw.artists),
  };
  const album = safeText(raw.album?.name);
  if (album) item.album = album;
  const durationMs = safeInteger(raw.duration_ms, 0, 86_400_000);
  if (durationMs !== undefined) item.duration_ms = durationMs;
  const popularity = safeInteger(raw.popularity, 0, 100);
  if (popularity !== undefined) item.popularity = popularity;
  if (typeof raw.explicit === "boolean") item.explicit = raw.explicit;
  return item;
}

function normalizeTrackSearch(payload, { limit = SPOTIFY_WEB_API_LIMITS.searchResultsMax } = {}) {
  const rawItems = Array.isArray(payload?.tracks?.items)
    ? payload.tracks.items
    : [];
  const items = rawItems
    .map(normalizeTrackSearchItem)
    .filter(Boolean)
    .slice(0, limit);
  const hasMore = Boolean(payload?.tracks?.next) || Number.isInteger(payload?.tracks?.total) && rawItems.length < payload.tracks.total;
  return {
    provider: "spotify",
    items,
    has_more: hasMore,
    next_offset: hasMore && rawItems.length ? Math.min(rawItems.length, limit) : null,
    truncated: rawItems.length > items.length,
  };
}

function normalizeCatalogItem(raw, type) {
  if (type === "track") return normalizeTrackSearchItem(raw);
  if (!isPlainObject(raw) || !safeText(raw.name) ||
      typeof raw.uri !== "string" || !new RegExp(`^spotify:${type}:[A-Za-z0-9]{1,128}$`, "u").test(raw.uri)) return null;
  const item = { type, uri: raw.uri, name: safeText(raw.name), artists: normalizeArtistNames(raw.artists) };
  for (const field of ["publisher", "release_date"]) if (safeText(raw[field])) item[field] = safeText(raw[field]);
  const duration = safeInteger(raw.duration_ms, 0, 86_400_000);
  if (duration !== undefined) item.duration_ms = duration;
  if (typeof raw.explicit === "boolean") item.explicit = raw.explicit;
  return item;
}

function normalizeLibraryPage(payload, type, { limit, offset }) {
  const raw = Array.isArray(payload?.items) ? payload.items : [];
  const singular = type.slice(0, -1);
  const items = raw.slice(0, limit).map((entry) => {
    const item = normalizeCatalogItem(["playlists", "artists"].includes(type) ? entry : entry?.[singular], singular);
    const addedAt = normalizedUtcTimestamp(entry?.added_at);
    return item ? { ...item, ...(addedAt ? { added_at: addedAt } : {}) } : null;
  }).filter(Boolean);
  const total = safeInteger(payload?.total, 0, 1_000_000);
  const hasMore = Boolean(payload?.next) || (total !== undefined && offset + raw.length < total);
  return { provider: "spotify", type, items, offset, limit, ...(total !== undefined ? { total } : {}),
    has_more: hasMore, next_offset: hasMore && raw.length > 0 ? offset + Math.min(raw.length, limit) : null,
    truncated: raw.length > items.length };
}

function normalizedUtcTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

function normalizedCursor(value) {
  const numeric =
    typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
      ? Number(value)
      : value;
  return safeInteger(numeric, 0, Number.MAX_SAFE_INTEGER);
}

function normalizeRecentlyPlayedItem(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.track)) return null;
  const playedAt = normalizedUtcTimestamp(raw.played_at);
  const id = safeText(raw.track.id, 128);
  const name = safeText(raw.track.name);
  const album = safeText(raw.track.album?.name);
  const artists = normalizeArtistNames(raw.track.artists);
  if (!playedAt || !id || !name || !album || artists.length === 0) return null;
  const track = { id, name, artists, album };
  const durationMs = safeInteger(raw.track.duration_ms, 0, 86_400_000);
  if (durationMs !== undefined) track.duration_ms = durationMs;
  const isrc = safeText(raw.track.external_ids?.isrc, 32);
  if (isrc) track.isrc = isrc.toUpperCase();
  const releaseDate = safeText(raw.track.album?.release_date, 32);
  if (releaseDate) track.release_date = releaseDate;
  const externalUrl = safeText(raw.track.external_urls?.spotify, 512);
  if (externalUrl) track.external_url = externalUrl;
  const contextType = safeText(raw.context?.type, 32);
  return {
    played_at: playedAt,
    track,
    ...(contextType ? { context_type: contextType } : {}),
  };
}

function normalizeRecentlyPlayed(payload) {
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  const items = rawItems
    .map(normalizeRecentlyPlayedItem)
    .filter(Boolean)
    .slice(0, SPOTIFY_WEB_API_LIMITS.recentlyPlayedMax);
  const cursorAfterMs = normalizedCursor(payload?.cursors?.after);
  const cursorBeforeMs = normalizedCursor(payload?.cursors?.before);
  return {
    provider: "spotify",
    items,
    truncated: rawItems.length > items.length,
    has_more: Boolean(payload?.next),
    ...(cursorAfterMs !== undefined
      ? { cursor_after_ms: cursorAfterMs }
      : {}),
    ...(cursorBeforeMs !== undefined
      ? { cursor_before_ms: cursorBeforeMs }
      : {}),
  };
}

function normalizePlaylist(payload, { includeControlMetadata = false } = {}) {
  if (!isPlainObject(payload)) return null;
  const id = safeText(payload.id, 128);
  const uri = safeText(payload.uri);
  const name = safeText(payload.name, 200);
  if (!id || !uri || !name) return null;
  const playlist = {
    id,
    uri,
    name,
    is_public: typeof payload.public === "boolean" ? payload.public : null,
  };
  if (includeControlMetadata) {
    playlist.collaborative = typeof payload.collaborative === "boolean" ? payload.collaborative : null;
    const ownerId = safeText(payload.owner?.id, 128);
    const snapshotId = safeText(payload.snapshot_id, 128);
    if (ownerId) playlist.owner_id = ownerId;
    if (snapshotId) playlist.snapshot_id = snapshotId;
  }
  const tracksTotal = safeInteger(
    payload.items?.total ?? payload.tracks?.total,
    0,
    1_000_000,
  );
  if (tracksTotal !== undefined) playlist.tracks_total = tracksTotal;
  return playlist;
}

function normalizePlaylistPage(payload) {
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  const items = rawItems
    .slice(0, SPOTIFY_WEB_API_LIMITS.playlistsPageMax)
    .map((item) => normalizePlaylist(item, { includeControlMetadata: true }))
    .filter(Boolean);
  const total =
    safeInteger(payload?.total, 0, 1_000_000) ?? items.length;
  const limit =
    safeInteger(
      payload?.limit,
      1,
      SPOTIFY_WEB_API_LIMITS.playlistsPageMax,
    ) ?? Math.max(1, items.length);
  const offset =
    safeInteger(payload?.offset, 0, 1_000_000) ?? 0;
  return {
    provider: "spotify",
    items,
    total,
    limit,
    offset,
    has_more: offset + rawItems.length < total || Boolean(payload?.next),
    complete_for_name_selection: payload?.offset === 0 && safeInteger(payload?.total, 0, 1_000_000) !== undefined &&
      rawItems.length === items.length && items.length === payload.total && payload?.next === null,
  };
}

function normalizePlaylistItem(raw) {
  if (!isPlainObject(raw)) {
    return { is_local: false, item: null };
  }
  const source = isPlainObject(raw.item)
    ? raw.item
    : isPlainObject(raw.track)
      ? raw.track
      : null;
  const item = normalizePlayableItem(source);
  if (item && typeof source?.is_playable === "boolean") {
    item.is_playable = source.is_playable;
  }
  return {
    is_local: raw.is_local === true || source?.is_local === true,
    item,
  };
}

function normalizePlaylistItemsPage(payload) {
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  const items = rawItems
    .slice(0, SPOTIFY_WEB_API_LIMITS.playlistItemsPageMax)
    .map(normalizePlaylistItem);
  const total =
    safeInteger(payload?.total, 0, 1_000_000) ?? items.length;
  const limit =
    safeInteger(
      payload?.limit,
      1,
      SPOTIFY_WEB_API_LIMITS.playlistItemsPageMax,
    ) ?? Math.max(1, items.length);
  const offset =
    safeInteger(payload?.offset, 0, 1_000_000) ?? 0;
  return {
    provider: "spotify",
    items,
    total,
    limit,
    offset,
    has_more: offset + rawItems.length < total || Boolean(payload?.next),
  };
}

function normalizeSavedContains(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .slice(0, SPOTIFY_WEB_API_LIMITS.libraryItemsMax)
    .map((value) => value === true);
}

function queryString(values) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function playbackBody(input) {
  const body = {};
  if (input.contextUri !== undefined) body.context_uri = input.contextUri;
  if (input.uris !== undefined) body.uris = input.uris;
  if (input.offsetPosition !== undefined) {
    body.offset = { position: input.offsetPosition };
  } else if (input.offsetUri !== undefined) {
    body.offset = { uri: input.offsetUri };
  }
  if (input.positionMs !== undefined) body.position_ms = input.positionMs;
  return Object.keys(body).length > 0 ? body : undefined;
}

export function createSpotifyWebApiClient({
  fetchImpl = globalThis.fetch,
  tokenProvider,
  baseUrl = SPOTIFY_WEB_API_BASE_URL,
  sleepImpl = defaultSleep,
  refreshAccessToken,
  writeTimeoutMs = 15_000,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  if (typeof tokenProvider !== "function") {
    throw new TypeError("A Spotify token provider is required.");
  }
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/u, "");
  if (!Number.isInteger(writeTimeoutMs) || writeTimeoutMs < 1 || writeTimeoutMs > 60_000) throw new TypeError("Invalid Spotify write settlement timeout.");

  const request = async (
    path,
    { method = "GET", body, responseMode = "json", signal, beforeDispatch } = {},
  ) => {
    const initForToken = (token) => {
      const headers = {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      };
      const init = { method, headers };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      return init;
    };

    // Read recovery shares one request budget. Every write gets one dispatch;
    // a rejected token may be refreshed for a later explicitly requested action.
    const read = method === "GET";
    const maxAttempts = read ? SPOTIFY_WEB_API_LIMITS.rateLimitMaxAttempts : 1;
    const accessToken = async (operation) => {
      try {
        return normalizedToken(await operation());
      } catch (error) {
        // Token lookup occurs before dispatch, or after a definite 401. Its
        // failure cannot turn the protected write into an unknown effect.
        if (!read && error && typeof error === "object") error.outcomeUnknown = false;
        throw error;
      }
    };
    signal?.throwIfAborted();
    let token = await accessToken(() => tokenProvider({ signal }));
    let refreshed = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      signal?.throwIfAborted();
      const init = initForToken(token);
      // Let a dispatched write settle so cancellation cannot hide its receipt.
      if (read && signal) init.signal = signal;
      const deadline = Date.now() + writeTimeoutMs;
      const transport = read ? null : new AbortController();
      if (transport) init.signal = transport.signal;
      const settle = async (operation) => {
        if (read) return operation();
        let timer;
        try {
          return await Promise.race([Promise.resolve(operation()), new Promise((_, reject) => {
            timer = setTimeout(() => {
              transport.abort();
              reject(new Error("Spotify write settlement deadline exceeded."));
            }, Math.max(0, deadline - Date.now()));
          })]);
        } finally { clearTimeout(timer); }
      };
      let response;
      // A host authority guard runs after async token/refresh/lock waiting.
      // Local refusal precedes fetch and must not become an uncertain write.
      beforeDispatch?.();
      try {
        response = await settle(() => fetchImpl(`${normalizedBaseUrl}${path}`, init));
      } catch (error) {
        if (read) {
          signal?.throwIfAborted();
          if (error?.name === "AbortError") throw error;
        }
        // Writes have no transport cancellation signal: a transport AbortError
        // cannot prove that the dispatched action had no effect.
        fail("spotify_network_error", "Spotify could not be reached.", { outcomeUnknown: !read });
      }
      if (read) signal?.throwIfAborted();
      if (response.ok && (response.status === 204 || responseMode === "none")) return null;
      let text;
      try {
        text = await settle(() => response.text());
      } catch (error) {
        if (read) {
          signal?.throwIfAborted();
          if (error?.name === "AbortError") throw error;
        }
        fail("spotify_network_error", "Spotify's response could not be read.", {
          status: response.status,
          outcomeUnknown: !read && !(response.status >= 400 && response.status < 500),
        });
      }
      if (read) signal?.throwIfAborted();
      if (Buffer.byteLength(text, "utf8") > SPOTIFY_WEB_API_LIMITS.responseBytesMax) {
        fail("spotify_response_too_large", "Spotify returned too much data.", {
          status: response.status,
          outcomeUnknown: !read && !(response.status >= 400 && response.status < 500),
        });
      }
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch {
          // Error responses can be plain text. Their HTTP status still decides
          // whether authentication or a bounded read retry is appropriate.
          if (response.ok) fail("spotify_response_invalid", "Spotify returned an invalid response.", { status: response.status, outcomeUnknown: !read });
        }
      }
      if (response.ok) return payload;
      const retryAfter = retryAfterSeconds(response.headers);
      const options = { status: response.status, reason: quotaReason(payload), retryAfterSeconds: retryAfter,
        outcomeUnknown: !read && response.status >= 500 };
      if (response.status === 401) {
        if (!refreshed && typeof refreshAccessToken === "function" && (!read || attempt < maxAttempts)) {
          signal?.throwIfAborted();
          token = await accessToken(() => refreshAccessToken({ signal, rejectedAccessToken: token }));
          refreshed = true;
          if (!read) {
            signal?.throwIfAborted();
            fail("spotify_action_not_replayed", "Spotify rejected this action. Authentication was refreshed, but the action was not replayed. Submit a new request if you still want it.", options);
          }
          continue;
        }
        fail("spotify_authentication_required", "Spotify authentication must be refreshed.", options);
      }
      if (response.status === 429) {
        if (quotaReason(payload) === "QUOTA_EXCEEDED") {
          fail("spotify_quota_exceeded", "Spotify development quota is exhausted.", options);
        }
        const waitMs = retryAfter === null ? SPOTIFY_WEB_API_LIMITS.rateLimitDefaultWaitMs : retryAfter * 1_000;
        if (read && attempt < maxAttempts && waitMs <= SPOTIFY_WEB_API_LIMITS.rateLimitMaxWaitMs) {
          signal?.throwIfAborted();
          const jittered = Math.min(SPOTIFY_WEB_API_LIMITS.rateLimitMaxWaitMs,
            waitMs + Math.floor(Math.random() * SPOTIFY_WEB_API_LIMITS.rateLimitJitterMs));
          await sleepImpl(jittered, { signal });
          continue;
        }
        fail("spotify_rate_limited", "Spotify rate limited this request.", options);
      }
      if (response.status === 403) {
        if (hasInsufficientClientScope(payload)) {
          fail("spotify_scope_insufficient", "Spotify authorization is missing a required scope. Run moondog spotify login again.", options);
        }
        fail("spotify_action_forbidden", "Spotify did not allow this action.", options);
      }
      fail("spotify_api_error", "Spotify rejected this request.", options);
    }
  };

  return Object.freeze({
    async getAccount({ signal } = {}) {
      return normalizeAccount(await request("/me", { signal }));
    },

    async getCurrentPlayback({ signal } = {}) {
      return normalizePlayback(await request("/me/player?additional_types=episode", { signal }));
    },

    async getDevices({ signal } = {}) {
      return normalizeDevices(await request("/me/player/devices", { signal }));
    },

    async getQueue({ signal } = {}) {
      return normalizeQueue(await request("/me/player/queue", { signal }));
    },

    async getRecentlyPlayed({ limit, after, before } = {}, { signal } = {}) {
      return normalizeRecentlyPlayed(
        await request(
          `/me/player/recently-played${queryString({ limit, after, before })}`, { signal },
        ),
      );
    },

    async getSavedItems({ type = "tracks", limit = 20, offset = 0 } = {}, { signal } = {}) {
      if (!["tracks", "albums", "shows", "playlists"].includes(type) || !Number.isInteger(limit) || limit < 1 || limit > 20 ||
          !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) fail("invalid_library_page", "Choose a supported library type and bounded page.");
      return normalizeLibraryPage(await request(`/me/${type}${queryString({ limit, offset })}`, { signal }), type, { limit, offset });
    },

    async getFollowedArtists({ limit = 10, after } = {}, { signal } = {}) {
      const payload = await request(`/me/following${queryString({ type: "artist", limit, after })}`, { signal });
      const result = normalizeLibraryPage(payload?.artists, "artists", { limit, offset: 0 });
      delete result.next_offset;
      result.has_more = Boolean(payload?.artists?.next);
      const cursor = payload?.artists?.cursors?.after;
      if (result.has_more && typeof cursor === "string" && cursor !== after && /^[A-Za-z0-9]{1,128}$/u.test(cursor)) result.next_after = cursor;
      return result;
    },

    async searchItems({ query, type, limit, offset = 0 } = {}, { signal } = {}) {
      const payload = await request(`/search${queryString({ q: query, type, limit, offset })}`, { signal });
      const page = payload?.[`${type}s`];
      const raw = Array.isArray(page?.items) ? page.items : [];
      const items = raw.slice(0, limit).map((item) => normalizeCatalogItem(item, type)).filter(Boolean);
      const hasMore = Boolean(page?.next) || Number.isInteger(page?.total) && offset + raw.length < page.total;
      return { provider: "spotify", type, items, has_more: hasMore,
        next_offset: hasMore && raw.length ? offset + Math.min(raw.length, limit) : null,
        truncated: raw.length > items.length };
    },

    async getCatalogChildren({ type, id, limit, offset } = {}, { signal } = {}) {
      const childType = type === "album" ? "track" : "episode";
      const payload = await request(`/${type}s/${encodeURIComponent(id)}/${childType}s${queryString({ limit, offset })}`, { signal });
      const raw = Array.isArray(payload?.items) ? payload.items : [];
      const items = raw.slice(0, limit).map((item) => normalizeCatalogItem(item, childType)).filter(Boolean);
      const hasMore = Boolean(payload?.next) || Number.isInteger(payload?.total) && offset + raw.length < payload.total;
      return { provider: "spotify", source: "catalog", items, limit, offset, has_more: hasMore,
        next_offset: hasMore && raw.length ? offset + Math.min(raw.length, limit) : null, truncated: raw.length > items.length };
    },

    async searchTracks({ query, limit, market } = {}, { signal } = {}) {
      return normalizeTrackSearch(
        await request(
          `/search${queryString({ q: query, type: "track", limit, market })}`, { signal },
        ), { limit },
      );
    },

    async getTopItems({ type = "tracks", timeRange = "medium_term", limit = 5 } = {}, { signal } = {}) {
      if (!["artists", "tracks"].includes(type) || !["short_term", "medium_term", "long_term"].includes(timeRange) ||
          !Number.isInteger(limit) || limit < 1 || limit > 10) {
        fail("invalid_top_items", "Spotify top items require a supported type, time range, and limit from 1 to 10.");
      }
      const payload = await request(`/me/top/${type}${queryString({ time_range: timeRange, limit, offset: 0 })}`, { signal });
      const raw = Array.isArray(payload?.items) ? payload.items : [];
      const items = raw.slice(0, limit).map((item, index) => {
        const normalized = type === "tracks" ? normalizeTrackSearchItem(item) :
          (safeText(item?.name) ? { name: safeText(item.name), type: "artist" } : null);
        return normalized ? { ...normalized, affinity_rank: index + 1 } : null;
      }).filter(Boolean);
      return { provider: "spotify", items, truncated: raw.length > items.length || Boolean(payload?.next) || payload?.total > raw.length };
    },

    async getCurrentUserPlaylists({ limit, offset } = {}, { signal } = {}) {
      return normalizePlaylistPage(
        await request(
          `/me/playlists${queryString({ limit, offset })}`, { signal },
        ),
      );
    },

    async getPlaylist({ playlistId } = {}, { signal } = {}) {
      return normalizePlaylist(
        await request(`/playlists/${encodeURIComponent(playlistId)}`, { signal }),
        { includeControlMetadata: true },
      );
    },

    async getPlaylistItems({ playlistId, limit, offset } = {}, { signal } = {}) {
      return normalizePlaylistItemsPage(
        await request(
          `/playlists/${encodeURIComponent(playlistId)}/items${queryString({
            limit,
            offset,
          })}`, { signal },
        ),
      );
    },

    async createPlaylist({ name, description } = {}, { signal } = {}) {
      return normalizePlaylist(
        await request("/me/playlists", {
          method: "POST",
          signal,
          body: {
            name,
            ...(description ? { description } : {}),
            public: false,
          },
        }),
      );
    },

    async addPlaylistTracks({ playlistId, uris } = {}, { signal } = {}) {
      const payload = await request(
        `/playlists/${encodeURIComponent(playlistId)}/items`,
        { method: "POST", body: { uris }, signal },
      );
      const snapshotId = safeText(payload?.snapshot_id, 128);
      return snapshotId ? { snapshot_id: snapshotId } : {};
    },

    async renamePlaylist({ playlistId, name } = {}, { signal, beforeDispatch } = {}) {
      await request(`/playlists/${encodeURIComponent(playlistId)}`, {
        method: "PUT", body: { name }, responseMode: "none", signal, beforeDispatch,
      });
    },

    async removePlaylistItem({ playlistId, uri, snapshotId } = {}, { signal, beforeDispatch } = {}) {
      const payload = await request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
        method: "DELETE", body: { items: [{ uri }], snapshot_id: snapshotId }, signal, beforeDispatch,
      });
      const snapshot = safeText(payload?.snapshot_id, 128);
      if (!snapshot) fail("spotify_write_receipt_invalid", "Spotify did not return a valid removal receipt. Inspect the playlist before retrying.", { outcomeUnknown: true });
      return { snapshot_id: snapshot };
    },

    async replacePlaylistItems({ playlistId, uris } = {}, { signal } = {}) {
      const payload = await request(
        `/playlists/${encodeURIComponent(playlistId)}/items`,
        { method: "PUT", body: { uris }, signal },
      );
      const snapshotId = safeText(payload?.snapshot_id, 128);
      return snapshotId ? { snapshot_id: snapshotId } : {};
    },

    async checkSavedTracks({ uris } = {}, { signal } = {}) {
      return normalizeSavedContains(
        await request(
          `/me/library/contains${queryString({ uris: uris.join(",") })}`, { signal },
        ),
      );
    },

    async saveTracks({ uris } = {}, { signal } = {}) {
      await request(`/me/library${queryString({ uris: uris.join(",") })}`, {
        method: "PUT",
        responseMode: "none",
        signal,
      });
      return null;
    },

    async removeLibraryItems({ uris } = {}, { signal } = {}) {
      await request(`/me/library${queryString({ uris: uris.join(",") })}`, { method: "DELETE", responseMode: "none", signal });
    },

    async resume(input = {}, { signal } = {}) {
      await request(
        `/me/player/play${queryString({ device_id: input.deviceId })}`,
        { method: "PUT", body: playbackBody(input), responseMode: "none", signal },
      );
    },

    async pause({ deviceId } = {}, { signal } = {}) {
      await request(
        `/me/player/pause${queryString({ device_id: deviceId })}`,
        { method: "PUT", responseMode: "none", signal },
      );
    },

    async next({ deviceId } = {}, { signal } = {}) {
      await request(
        `/me/player/next${queryString({ device_id: deviceId })}`,
        { method: "POST", responseMode: "none", signal },
      );
    },

    async previous({ deviceId } = {}, { signal } = {}) {
      await request(
        `/me/player/previous${queryString({ device_id: deviceId })}`,
        { method: "POST", responseMode: "none", signal },
      );
    },

    async setVolume({ percent, deviceId }, { signal } = {}) {
      await request(
        `/me/player/volume${queryString({
          volume_percent: percent,
          device_id: deviceId,
        })}`,
        { method: "PUT", responseMode: "none", signal },
      );
    },

    async seek({ positionMs, deviceId }, { signal } = {}) {
      await request(
        `/me/player/seek${queryString({
          position_ms: positionMs,
          device_id: deviceId,
        })}`,
        { method: "PUT", responseMode: "none", signal },
      );
    },

    async setShuffle({ state, deviceId }, { signal } = {}) {
      await request(
        `/me/player/shuffle${queryString({ state, device_id: deviceId })}`,
        { method: "PUT", responseMode: "none", signal },
      );
    },

    async setRepeat({ state, deviceId }, { signal } = {}) {
      await request(
        `/me/player/repeat${queryString({ state, device_id: deviceId })}`,
        { method: "PUT", responseMode: "none", signal },
      );
    },

    async transfer({ deviceId, play }, { signal } = {}) {
      await request("/me/player", {
        method: "PUT",
        body: { device_ids: [deviceId], play },
        responseMode: "none",
        signal,
      });
    },

    async addToQueue({ uri, deviceId }, { signal } = {}) {
      await request(
        `/me/player/queue${queryString({ uri, device_id: deviceId })}`,
        { method: "POST", responseMode: "none", signal },
      );
    },
  });
}
