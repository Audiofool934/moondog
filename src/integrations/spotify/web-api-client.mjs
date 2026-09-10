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

export class SpotifyWebApiError extends Error {
  constructor(code, message, { status = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = "SpotifyWebApiError";
    this.code = code;
    this.provider = "spotify";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
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
    disallowed_actions: normalizeDisallowedActions(payload.actions?.disallows),
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
  if (!isPlainObject(raw)) return null;
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

function normalizeTrackSearch(payload) {
  const rawItems = Array.isArray(payload?.tracks?.items)
    ? payload.tracks.items
    : [];
  const items = rawItems
    .map(normalizeTrackSearchItem)
    .filter(Boolean)
    .slice(0, SPOTIFY_WEB_API_LIMITS.searchResultsMax);
  return {
    provider: "spotify",
    items,
    truncated: rawItems.length > items.length,
  };
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
    is_public: payload.public === true,
  };
  if (includeControlMetadata) {
    playlist.collaborative = payload.collaborative === true;
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
    has_more: offset + rawItems.length < total,
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
    has_more: offset + rawItems.length < total,
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
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }
  if (typeof tokenProvider !== "function") {
    throw new TypeError("A Spotify token provider is required.");
  }
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/u, "");

  const request = async (
    path,
    { method = "GET", body, responseMode = "json" } = {},
  ) => {
    const token = normalizedToken(await tokenProvider());
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    const init = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(`${normalizedBaseUrl}${path}`, init);
    } catch {
      fail("spotify_network_error", "Spotify could not be reached.");
    }

    if (response.ok && (response.status === 204 || responseMode === "none")) {
      return null;
    }
    const text = await response.text();
    if (text.length > SPOTIFY_WEB_API_LIMITS.responseBytesMax) {
      fail("spotify_response_too_large", "Spotify returned too much data.", {
        status: response.status,
      });
    }
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        fail("spotify_response_invalid", "Spotify returned an invalid response.", {
          status: response.status,
        });
      }
    }

    if (!response.ok) {
      const options = {
        status: response.status,
        retryAfterSeconds: retryAfterSeconds(response.headers),
      };
      if (response.status === 401) {
        fail(
          "spotify_authentication_required",
          "Spotify authentication must be refreshed.",
          options,
        );
      }
      if (response.status === 403) {
        if (hasInsufficientClientScope(payload)) {
          fail(
            "spotify_scope_insufficient",
            "Spotify authorization is missing a required scope. Run moondog spotify login again.",
            options,
          );
        }
        fail(
          "spotify_action_forbidden",
          "Spotify did not allow this action.",
          options,
        );
      }
      if (response.status === 429) {
        if (quotaReason(payload) === "QUOTA_EXCEEDED") {
          fail(
            "spotify_quota_exceeded",
            "Spotify development quota is exhausted.",
            options,
          );
        }
        fail(
          "spotify_rate_limited",
          "Spotify rate limited this request.",
          options,
        );
      }
      fail("spotify_api_error", "Spotify rejected this request.", options);
    }
    return payload;
  };

  return Object.freeze({
    async getAccount() {
      return normalizeAccount(await request("/me"));
    },

    async getCurrentPlayback() {
      return normalizePlayback(await request("/me/player"));
    },

    async getDevices() {
      return normalizeDevices(await request("/me/player/devices"));
    },

    async getQueue() {
      return normalizeQueue(await request("/me/player/queue"));
    },

    async getRecentlyPlayed({ limit, after, before } = {}) {
      return normalizeRecentlyPlayed(
        await request(
          `/me/player/recently-played${queryString({ limit, after, before })}`,
        ),
      );
    },

    async searchTracks({ query, limit, market } = {}) {
      return normalizeTrackSearch(
        await request(
          `/search${queryString({ q: query, type: "track", limit, market })}`,
        ),
      );
    },

    async getCurrentUserPlaylists({ limit, offset } = {}) {
      return normalizePlaylistPage(
        await request(
          `/me/playlists${queryString({ limit, offset })}`,
        ),
      );
    },

    async getPlaylist({ playlistId } = {}) {
      return normalizePlaylist(
        await request(`/playlists/${encodeURIComponent(playlistId)}`),
        { includeControlMetadata: true },
      );
    },

    async getPlaylistItems({ playlistId, limit, offset } = {}) {
      return normalizePlaylistItemsPage(
        await request(
          `/playlists/${encodeURIComponent(playlistId)}/items${queryString({
            limit,
            offset,
          })}`,
        ),
      );
    },

    async createPlaylist({ name, description } = {}) {
      return normalizePlaylist(
        await request("/me/playlists", {
          method: "POST",
          body: {
            name,
            ...(description ? { description } : {}),
            public: false,
          },
        }),
      );
    },

    async addPlaylistTracks({ playlistId, uris } = {}) {
      const payload = await request(
        `/playlists/${encodeURIComponent(playlistId)}/items`,
        { method: "POST", body: { uris } },
      );
      const snapshotId = safeText(payload?.snapshot_id, 128);
      return snapshotId ? { snapshot_id: snapshotId } : {};
    },

    async replacePlaylistItems({ playlistId, uris } = {}) {
      const payload = await request(
        `/playlists/${encodeURIComponent(playlistId)}/items`,
        { method: "PUT", body: { uris } },
      );
      const snapshotId = safeText(payload?.snapshot_id, 128);
      return snapshotId ? { snapshot_id: snapshotId } : {};
    },

    async checkSavedTracks({ uris } = {}) {
      return normalizeSavedContains(
        await request(
          `/me/library/contains${queryString({ uris: uris.join(",") })}`,
        ),
      );
    },

    async saveTracks({ uris } = {}) {
      await request(`/me/library${queryString({ uris: uris.join(",") })}`, {
        method: "PUT",
        responseMode: "none",
      });
      return null;
    },

    async resume(input = {}) {
      await request(
        `/me/player/play${queryString({ device_id: input.deviceId })}`,
        { method: "PUT", body: playbackBody(input), responseMode: "none" },
      );
    },

    async pause({ deviceId } = {}) {
      await request(
        `/me/player/pause${queryString({ device_id: deviceId })}`,
        { method: "PUT", responseMode: "none" },
      );
    },

    async next({ deviceId } = {}) {
      await request(
        `/me/player/next${queryString({ device_id: deviceId })}`,
        { method: "POST", responseMode: "none" },
      );
    },

    async previous({ deviceId } = {}) {
      await request(
        `/me/player/previous${queryString({ device_id: deviceId })}`,
        { method: "POST", responseMode: "none" },
      );
    },

    async setVolume({ percent, deviceId }) {
      await request(
        `/me/player/volume${queryString({
          volume_percent: percent,
          device_id: deviceId,
        })}`,
        { method: "PUT", responseMode: "none" },
      );
    },

    async seek({ positionMs, deviceId }) {
      await request(
        `/me/player/seek${queryString({
          position_ms: positionMs,
          device_id: deviceId,
        })}`,
        { method: "PUT", responseMode: "none" },
      );
    },

    async setShuffle({ state, deviceId }) {
      await request(
        `/me/player/shuffle${queryString({ state, device_id: deviceId })}`,
        { method: "PUT", responseMode: "none" },
      );
    },

    async setRepeat({ state, deviceId }) {
      await request(
        `/me/player/repeat${queryString({ state, device_id: deviceId })}`,
        { method: "PUT", responseMode: "none" },
      );
    },

    async transfer({ deviceId, play }) {
      await request("/me/player", {
        method: "PUT",
        body: { device_ids: [deviceId], play },
        responseMode: "none",
      });
    },

    async addToQueue({ uri, deviceId }) {
      await request(
        `/me/player/queue${queryString({ uri, device_id: deviceId })}`,
        { method: "POST", responseMode: "none" },
      );
    },
  });
}
