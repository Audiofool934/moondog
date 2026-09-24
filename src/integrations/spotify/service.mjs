import { createSpotifyWebApiClient } from "./web-api-client.mjs";

export const SPOTIFY_SERVICE_LIMITS = Object.freeze({
  deviceIdLengthMax: 256,
  playbackUrisMax: 100,
  positionMsMax: 86_400_000,
  playlistNameLengthMax: 100,
  playlistDescriptionLengthMax: 200,
  playlistTracksMax: 20,
  editablePlaylistsPageMax: 50,
  playlistEditTracksMax: 100,
  playlistItemsPageMax: 50,
  libraryTracksMax: 20,
  recentlyPlayedDefault: 20,
  recentlyPlayedMax: 50,
  deviceNameLengthMax: 128,
});

const repeatStates = new Set(["off", "track", "context"]);
const itemUriPattern = /^spotify:(?:episode|track):[A-Za-z0-9]{1,128}$/u;
const trackUriPattern = /^spotify:track:[A-Za-z0-9]{1,128}$/u;
const contextUriPattern = /^spotify:(?:album|artist|playlist):[A-Za-z0-9]{1,128}$/u;

export class SpotifyServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpotifyServiceError";
    this.code = code;
    this.provider = "spotify";
  }
}

function fail(code, message) {
  throw new SpotifyServiceError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inputObject(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) fail("invalid_arguments", "Spotify action arguments are invalid.");
  return value;
}

function optionalDeviceId(value) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value).length > SPOTIFY_SERVICE_LIMITS.deviceIdLengthMax
  ) {
    fail("invalid_device_id", "The Spotify device identifier is invalid.");
  }
  return value.trim();
}

function requiredItemUri(value) {
  if (typeof value !== "string" || !itemUriPattern.test(value)) {
    fail("invalid_spotify_uri", "A Spotify track or episode URI is required.");
  }
  return value;
}

function optionalContextUri(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !contextUriPattern.test(value)) {
    fail("invalid_spotify_context", "The Spotify playback context is invalid.");
  }
  return value;
}

function optionalUris(value) {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SPOTIFY_SERVICE_LIMITS.playbackUrisMax
  ) {
    fail("invalid_spotify_uris", "The Spotify playback URI list is invalid.");
  }
  return value.map(requiredItemUri);
}

function requiredTrackUris(value, code, maximum) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximum ||
    new Set(value).size !== value.length
  ) {
    fail(code, "The Spotify track URI list is invalid.");
  }
  for (const uri of value) {
    if (typeof uri !== "string" || !trackUriPattern.test(uri)) {
      fail(code, "The Spotify track URI list is invalid.");
    }
  }
  return value;
}

function requiredPlaylistEditTrackUris(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SPOTIFY_SERVICE_LIMITS.playlistEditTracksMax
  ) {
    fail("invalid_playlist_tracks", "The Spotify track URI list is invalid.");
  }
  for (const uri of value) {
    if (typeof uri !== "string" || !trackUriPattern.test(uri)) {
      fail("invalid_playlist_tracks", "The Spotify track URI list is invalid.");
    }
  }
  return value;
}

function requiredPlaylistId(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value)
  ) {
    fail("invalid_playlist_id", "The Spotify playlist identifier is invalid.");
  }
  return value;
}

function requiredSnapshotId(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("invalid_playlist_snapshot", "The Spotify playlist snapshot is invalid.");
  }
  return value;
}

function playlistPageLimit(value) {
  if (value === undefined) return 20;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > SPOTIFY_SERVICE_LIMITS.editablePlaylistsPageMax
  ) {
    fail(
      "invalid_playlist_page",
      `Spotify playlist page size must be an integer from 1 to ${SPOTIFY_SERVICE_LIMITS.editablePlaylistsPageMax}.`,
    );
  }
  return value;
}

function playlistPageOffset(value) {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
    fail("invalid_playlist_page", "The Spotify playlist page offset is invalid.");
  }
  return value;
}

function accountId(account) {
  if (typeof account?.account_id !== "string" || !account.account_id) {
    fail(
      "spotify_account_identity_unavailable",
      "Spotify did not return the connected account identity.",
    );
  }
  return account.account_id;
}

function editablePlaylistReason(playlist, ownerId) {
  if (
    !isPlainObject(playlist) ||
    typeof playlist.id !== "string" ||
    !playlist.id ||
    typeof playlist.name !== "string" ||
    !playlist.name ||
    typeof playlist.owner_id !== "string" ||
    !Number.isInteger(playlist.tracks_total) ||
    playlist.tracks_total < 0
  ) {
    return "invalid";
  }
  if (playlist.owner_id !== ownerId) return "not_owned";
  if (playlist.is_public === true) return "public";
  if (playlist.collaborative === true) return "collaborative";
  if (playlist.tracks_total > SPOTIFY_SERVICE_LIMITS.playlistEditTracksMax) {
    return "over_track_limit";
  }
  return null;
}

function requireEditablePlaylist(playlist, ownerId) {
  const reason = editablePlaylistReason(playlist, ownerId);
  if (reason) {
    fail(
      "playlist_not_editable",
      "Moondog edits only connected-account-owned private, non-collaborative Spotify playlists with at most 100 tracks.",
    );
  }
  requiredPlaylistId(playlist.id);
  requiredSnapshotId(playlist.snapshot_id);
  return playlist;
}

function normalizedSnapshotTrack(entry) {
  const item = entry?.item;
  if (
    entry?.is_local === true ||
    !isPlainObject(item) ||
    item.type !== "track" ||
    item.is_playable === false ||
    typeof item.uri !== "string" ||
    !trackUriPattern.test(item.uri) ||
    typeof item.name !== "string" ||
    !item.name ||
    !Array.isArray(item.artists) ||
    item.artists.length < 1 ||
    item.artists.some((artist) => typeof artist !== "string" || !artist)
  ) {
    fail(
      "playlist_items_unsupported",
      "This Spotify playlist contains local, unavailable, or non-track items that Moondog cannot safely rewrite.",
    );
  }
  return {
    uri: item.uri,
    title: item.name,
    artists: [...item.artists],
    ...(typeof item.album === "string" && item.album
      ? { album: item.album }
      : {}),
    ...(Number.isInteger(item.duration_ms) && item.duration_ms >= 0
      ? { duration_ms: item.duration_ms }
      : {}),
  };
}

function cleanPlaylistText(value, maximum, code, label) {
  if (typeof value !== "string") {
    fail(code, `The Spotify playlist ${label} is invalid.`);
  }
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || Array.from(cleaned).length > maximum) {
    fail(code, `The Spotify playlist ${label} is invalid.`);
  }
  return cleaned;
}

function optionalPosition(value, code) {
  if (value === undefined) return undefined;
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > SPOTIFY_SERVICE_LIMITS.positionMsMax
  ) {
    fail(code, "The Spotify playback position is invalid.");
  }
  return value;
}

function optionalOffsetPosition(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    fail("invalid_offset", "The Spotify playback offset is invalid.");
  }
  return value;
}

function recentCursor(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_recent_cursor", `The Spotify ${label} cursor is invalid.`);
  }
  return value;
}

function recentLimit(value) {
  if (value === undefined) return SPOTIFY_SERVICE_LIMITS.recentlyPlayedDefault;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > SPOTIFY_SERVICE_LIMITS.recentlyPlayedMax
  ) {
    fail(
      "invalid_recent_limit",
      `Spotify recent activity limit must be an integer from 1 to ${SPOTIFY_SERVICE_LIMITS.recentlyPlayedMax}.`,
    );
  }
  return value;
}

function actionReceipt(action) {
  return {
    provider: "spotify",
    ok: true,
    effect: "write_external",
    action,
    state: "accepted",
  };
}

const DEVICE_QUERY_FILLER = new Set([
  "a",
  "an",
  "the",
  "my",
  "your",
  "on",
  "onto",
  "to",
  "from",
  "over",
  "spotify",
  "device",
  "devices",
  "playback",
  "play",
  "playing",
  "switch",
  "transfer",
  "move",
  "moving",
  "it",
  "this",
  "that",
  "please",
  "rn",
  "now",
  "there",
  "here",
]);

const DEVICE_TYPE_ALIASES = new Map([
  ["iphone", "smartphone"],
  ["phone", "smartphone"],
  ["smartphone", "smartphone"],
  ["android", "smartphone"],
  ["ipad", "tablet"],
  ["tablet", "tablet"],
  ["computer", "computer"],
  ["desktop", "computer"],
  ["laptop", "computer"],
  ["mac", "computer"],
  ["pc", "computer"],
  ["speaker", "speaker"],
  ["tv", "tv"],
  ["television", "tv"],
  ["car", "automobile"],
  ["automobile", "automobile"],
]);

function clipText(value, maximum) {
  const chars = Array.from(value);
  if (chars.length <= maximum) return value;
  return `${chars.slice(0, maximum).join("")}...`;
}

function normalizeDeviceLabel(value) {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u02bc']/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/ +/gu, " ");
}

function deviceTokens(value) {
  return value.split(" ").filter(Boolean);
}

function deviceQuery(value) {
  if (typeof value !== "string") {
    fail("invalid_device_query", "The Spotify device name is invalid.");
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    Array.from(trimmed).length > SPOTIFY_SERVICE_LIMITS.deviceNameLengthMax
  ) {
    fail("invalid_device_query", "The Spotify device name is invalid.");
  }
  const normalized = normalizeDeviceLabel(trimmed);
  if (!normalized) {
    fail("invalid_device_query", "The Spotify device name is invalid.");
  }
  return { display: trimmed, normalized };
}

function meaningfulTokens(normalized) {
  const tokens = deviceTokens(normalized).filter(
    (token) => !DEVICE_QUERY_FILLER.has(token),
  );
  return tokens.length > 0 ? tokens : deviceTokens(normalized);
}

function tokenIsSpecific(token) {
  return token.length >= 3 || /[^\u0000-\u007f]/u.test(token);
}

function tokenMatches(nameToken, queryToken) {
  if (nameToken === queryToken) return true;
  if (queryToken.length < 3) return false;
  return nameToken.startsWith(queryToken) || nameToken.endsWith(queryToken);
}

function nameMatchScore(device, queryNormalized, tokens) {
  const name = normalizeDeviceLabel(device.name ?? "");
  if (!name) return 0;
  if (name === queryNormalized) return 3;
  const nameTokens = deviceTokens(name);
  const matched =
    tokens.length > 0 &&
    tokens.every(
      (token) =>
        tokenIsSpecific(token) &&
        nameTokens.some((nameToken) => tokenMatches(nameToken, token)),
    );
  return matched ? 2 : 0;
}

function sharedTypeAlias(tokens) {
  let type = null;
  if (tokens.length === 0) return null;
  for (const token of tokens) {
    const alias = DEVICE_TYPE_ALIASES.get(token);
    if (!alias || (type && alias !== type)) return null;
    type = alias;
  }
  return type;
}

function deviceListLabel(device) {
  const details = [];
  if (device.type && device.type !== "unknown") details.push(device.type);
  if (device.is_active === true) details.push("active");
  if (device.is_restricted === true) details.push("restricted");
  const name = clipText(device.name, 48);
  return details.length > 0 ? `${name} (${details.join(", ")})` : name;
}

function fitDeviceMessage(lead, devices, tail) {
  const labels = [];
  for (const device of devices) {
    const candidate = `${lead}${[...labels, deviceListLabel(device)].join("; ")}${tail}`;
    if (Array.from(candidate).length > 220 && labels.length > 0) break;
    labels.push(deviceListLabel(device));
  }
  const hidden = devices.length - labels.length;
  const hiddenNote = hidden > 0 ? ` +${hidden} more` : "";
  const message = `${lead}${labels.join("; ")}${hiddenNote}${tail}`;
  return Array.from(message).length > 240
    ? Array.from(message).slice(0, 240).join("")
    : message;
}

function listedDevices(result) {
  return (Array.isArray(result?.devices) ? result.devices : []).filter(
    (device) =>
      typeof device?.id === "string" &&
      device.id.length > 0 &&
      typeof device?.name === "string" &&
      device.name.trim().length > 0,
  );
}

function requireTransferDevice(chosen, display) {
  if (chosen.length === 1 && chosen[0].is_restricted === true) {
    fail(
      "spotify_device_restricted",
      `Spotify will not take playback on ${clipText(chosen[0].name, 80)}. Leave its private session, or pick another device.`,
    );
  }
  const controllable = chosen.filter((device) => device.is_restricted !== true);
  if (controllable.length === 1 && chosen.length === 1) return controllable[0];
  if (controllable.length === 0) {
    fail(
      "spotify_device_restricted",
      fitDeviceMessage(
        "Spotify will not take playback on the matching devices: ",
        chosen,
        ".",
      ),
    );
  }
  fail(
    "spotify_device_ambiguous",
    fitDeviceMessage(
      `Several Spotify devices match "${display}": `,
      chosen,
      ". Say which one.",
    ),
  );
}

async function resolveNamedDevice(client, deviceName) {
  const query = deviceQuery(deviceName);
  const devices = listedDevices(await client.getDevices());
  if (devices.length === 0) {
    fail(
      "spotify_device_not_found",
      "No Spotify devices are visible. Open Spotify on that device and try again.",
    );
  }
  const tokens = meaningfulTokens(query.normalized);
  let bestScore = 0;
  let named = [];
  for (const device of devices) {
    const score = nameMatchScore(device, query.normalized, tokens);
    if (score === 0 || score < bestScore) continue;
    if (score > bestScore) {
      bestScore = score;
      named = [device];
    } else {
      named.push(device);
    }
  }
  const type = named.length === 0 ? sharedTypeAlias(tokens) : null;
  const chosen = named.length > 0
    ? named
    : devices.filter(
        (device) => (device.type ?? "").toLocaleLowerCase("en-US") === type,
      );
  if (chosen.length === 0) {
    fail(
      "spotify_device_not_found",
      fitDeviceMessage(
        `No Spotify device matches "${clipText(query.display, 40)}". Visible now: `,
        devices,
        ".",
      ),
    );
  }
  const display = clipText(query.display, 40);
  return requireTransferDevice(chosen, display);
}

async function queueDeviceId(client, requestedDeviceId) {
  const explicit = optionalDeviceId(requestedDeviceId);
  if (explicit) return explicit;

  const result = await client.getDevices();
  const devices = Array.isArray(result?.devices) ? result.devices : [];
  const controllable = devices.filter(
    (device) =>
      typeof device?.id === "string" &&
      device.id.length > 0 &&
      device.is_restricted !== true,
  );
  const active = controllable.find((device) => device.is_active === true);
  if (active) return active.id;
  if (controllable.length === 1) return controllable[0].id;
  if (devices.length > 0 && controllable.length === 0) {
    fail(
      "spotify_device_restricted",
      "Spotify's available devices do not accept Web API controls. Open Spotify on another device and try again.",
    );
  }
  fail(
    "spotify_active_device_required",
    "No active Spotify device is available. Open Spotify on one device and start playback, then try again.",
  );
}

export function createSpotifyService(options = {}) {
  const client = options.client ?? createSpotifyWebApiClient(options);
  if (!client || typeof client !== "object") {
    throw new TypeError("A Spotify Web API client is required.");
  }

  return Object.freeze({
    account() {
      return client.getAccount();
    },

    currentPlayer() {
      return client.getCurrentPlayback();
    },

    devices() {
      return client.getDevices();
    },

    queue() {
      return client.getQueue();
    },

    async recentActivity(value) {
      const input = inputObject(value);
      const after = recentCursor(input.after, "after");
      const before = recentCursor(input.before, "before");
      if (after !== undefined && before !== undefined) {
        fail(
          "conflicting_recent_cursors",
          "Choose either a Spotify after cursor or a before cursor.",
        );
      }
      return client.getRecentlyPlayed({
        limit: recentLimit(input.limit),
        ...(after !== undefined ? { after } : {}),
        ...(before !== undefined ? { before } : {}),
      });
    },

    async editablePlaylists(value) {
      const input = inputObject(value);
      const limit = playlistPageLimit(input.limit);
      const offset = playlistPageOffset(input.offset);
      const account = await client.getAccount();
      const ownerId = accountId(account);
      const page = await client.getCurrentUserPlaylists({ limit, offset });
      const excluded = {
        public: 0,
        not_owned: 0,
        collaborative: 0,
        over_track_limit: 0,
        invalid: 0,
      };
      const playlists = [];
      for (const playlist of Array.isArray(page?.items) ? page.items : []) {
        const reason = editablePlaylistReason(playlist, ownerId);
        if (reason) {
          excluded[reason] += 1;
          continue;
        }
        playlists.push({
          playlist_id: playlist.id,
          name: playlist.name,
          track_count: playlist.tracks_total,
        });
      }
      const pageOffset = Number.isInteger(page?.offset) ? page.offset : offset;
      const pageLimit = Number.isInteger(page?.limit) ? page.limit : limit;
      const hasMore = page?.has_more === true;
      return {
        provider: "spotify",
        playlists,
        excluded,
        has_more: hasMore,
        next_offset: hasMore ? pageOffset + pageLimit : null,
      };
    },

    async playlistSnapshot(value) {
      const input = inputObject(value);
      const playlistId = requiredPlaylistId(input.playlistId);
      const account = await client.getAccount();
      const ownerId = accountId(account);
      const before = requireEditablePlaylist(
        await client.getPlaylist({ playlistId }),
        ownerId,
      );
      const tracks = [];
      let offset = 0;
      while (offset < before.tracks_total) {
        const page = await client.getPlaylistItems({
          playlistId,
          limit: Math.min(
            SPOTIFY_SERVICE_LIMITS.playlistItemsPageMax,
            before.tracks_total - offset,
          ),
          offset,
        });
        if (
          !isPlainObject(page) ||
          page.total !== before.tracks_total ||
          page.offset !== offset ||
          !Array.isArray(page.items) ||
          page.items.length < 1
        ) {
          fail(
            "playlist_snapshot_changed",
            "The Spotify playlist changed while Moondog was reading it. Inspect it again before editing.",
          );
        }
        for (const entry of page.items) {
          tracks.push(normalizedSnapshotTrack(entry));
        }
        offset += page.items.length;
        if (tracks.length > before.tracks_total) {
          fail(
            "playlist_snapshot_changed",
            "The Spotify playlist changed while Moondog was reading it. Inspect it again before editing.",
          );
        }
      }
      const after = requireEditablePlaylist(
        await client.getPlaylist({ playlistId }),
        ownerId,
      );
      if (
        after.snapshot_id !== before.snapshot_id ||
        after.tracks_total !== before.tracks_total ||
        tracks.length !== before.tracks_total
      ) {
        fail(
          "playlist_snapshot_changed",
          "The Spotify playlist changed while Moondog was reading it. Inspect it again before editing.",
        );
      }
      return {
        provider: "spotify",
        playlist: {
          playlist_id: before.id,
          name: before.name,
          track_count: before.tracks_total,
          snapshot_id: before.snapshot_id,
        },
        items: tracks,
      };
    },

    async replacePlaylistItems(value) {
      const input = inputObject(value);
      const playlistId = requiredPlaylistId(input.playlistId);
      const expectedSnapshotId = requiredSnapshotId(input.expectedSnapshotId);
      const uris = requiredPlaylistEditTrackUris(input.uris);
      const account = await client.getAccount();
      const ownerId = accountId(account);
      const playlist = requireEditablePlaylist(
        await client.getPlaylist({ playlistId }),
        ownerId,
      );
      if (playlist.snapshot_id !== expectedSnapshotId) {
        fail(
          "playlist_snapshot_changed",
          "The Spotify playlist changed after preview. Inspect it again before editing.",
        );
      }
      await client.replacePlaylistItems({ playlistId, uris });
      return {
        ...actionReceipt("playlist.edit"),
        playlist: {
          name: playlist.name,
          track_count: uris.length,
          is_public: false,
        },
        previous_track_count: playlist.tracks_total,
      };
    },

    async resume(value) {
      const input = inputObject(value);
      const contextUri = optionalContextUri(input.contextUri);
      const uris = optionalUris(input.uris);
      const offsetPosition = optionalOffsetPosition(input.offsetPosition);
      const offsetUri =
        input.offsetUri === undefined ? undefined : requiredItemUri(input.offsetUri);
      if (contextUri && uris) {
        fail(
          "conflicting_playback_source",
          "Choose either a Spotify context or explicit item URIs.",
        );
      }
      if (offsetPosition !== undefined && offsetUri !== undefined) {
        fail("conflicting_offset", "Choose one Spotify playback offset.");
      }
      await client.resume({
        deviceId: optionalDeviceId(input.deviceId),
        contextUri,
        uris,
        offsetPosition,
        offsetUri,
        positionMs: optionalPosition(input.positionMs, "invalid_position"),
      });
      return actionReceipt("playback.resume");
    },

    async pause(value) {
      const input = inputObject(value);
      await client.pause({ deviceId: optionalDeviceId(input.deviceId) });
      return actionReceipt("playback.pause");
    },

    async next(value) {
      const input = inputObject(value);
      await client.next({ deviceId: optionalDeviceId(input.deviceId) });
      return actionReceipt("playback.next");
    },

    async previous(value) {
      const input = inputObject(value);
      await client.previous({ deviceId: optionalDeviceId(input.deviceId) });
      return actionReceipt("playback.previous");
    },

    async setVolume(value) {
      const input = inputObject(value);
      if (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100) {
        fail("invalid_volume", "Spotify volume must be an integer from 0 to 100.");
      }
      await client.setVolume({
        percent: input.percent,
        deviceId: optionalDeviceId(input.deviceId),
      });
      return actionReceipt("playback.volume.set");
    },

    async seek(value) {
      const input = inputObject(value);
      if (input.positionMs === undefined) {
        fail("invalid_position", "The Spotify playback position is invalid.");
      }
      await client.seek({
        positionMs: optionalPosition(input.positionMs, "invalid_position"),
        deviceId: optionalDeviceId(input.deviceId),
      });
      return actionReceipt("playback.seek");
    },

    async setShuffle(value) {
      const input = inputObject(value);
      if (typeof input.state !== "boolean") {
        fail("invalid_shuffle_state", "Spotify shuffle state must be a boolean.");
      }
      await client.setShuffle({
        state: input.state,
        deviceId: optionalDeviceId(input.deviceId),
      });
      return actionReceipt("playback.shuffle.set");
    },

    async setRepeat(value) {
      const input = inputObject(value);
      if (!repeatStates.has(input.state)) {
        fail("invalid_repeat_state", "Spotify repeat state is invalid.");
      }
      await client.setRepeat({
        state: input.state,
        deviceId: optionalDeviceId(input.deviceId),
      });
      return actionReceipt("playback.repeat.set");
    },

    async transfer(value) {
      const input = inputObject(value);
      if (input.play !== undefined && typeof input.play !== "boolean") {
        fail("invalid_play_state", "Spotify transfer play state must be a boolean.");
      }
      const deviceId =
        input.deviceId === undefined ? undefined : optionalDeviceId(input.deviceId);
      const hasName = input.deviceName !== undefined;
      if (deviceId && hasName) {
        fail(
          "conflicting_device_target",
          "Pass either a Spotify device ID or a device name.",
        );
      }
      const play = input.play ?? false;
      if (deviceId) {
        await client.transfer({ deviceId, play });
        return actionReceipt("playback.transfer");
      }
      if (!hasName) {
        fail("invalid_device_id", "A Spotify device identifier is required.");
      }
      const device = await resolveNamedDevice(client, input.deviceName);
      await client.transfer({ deviceId: device.id, play });
      return {
        ...actionReceipt("playback.transfer"),
        device: {
          name: device.name,
          type: device.type || "unknown",
        },
      };
    },

    async addToQueue(value) {
      const input = inputObject(value);
      await client.addToQueue({
        uri: requiredItemUri(input.uri),
        deviceId: await queueDeviceId(client, input.deviceId),
      });
      return actionReceipt("playback.queue.add");
    },

    async createPlaylistWithTracks(value) {
      const input = inputObject(value);
      const name = cleanPlaylistText(
        input.name,
        SPOTIFY_SERVICE_LIMITS.playlistNameLengthMax,
        "invalid_playlist_name",
        "name",
      );
      const description =
        input.description === undefined
          ? undefined
          : cleanPlaylistText(
              input.description,
              SPOTIFY_SERVICE_LIMITS.playlistDescriptionLengthMax,
              "invalid_playlist_description",
              "description",
            );
      const uris = requiredTrackUris(
        input.uris,
        "invalid_playlist_tracks",
        SPOTIFY_SERVICE_LIMITS.playlistTracksMax,
      );
      const playlist = await client.createPlaylist({
        name,
        ...(description ? { description } : {}),
      });
      if (!playlist?.id) {
        fail(
          "playlist_creation_failed",
          "Spotify did not return the created playlist.",
        );
      }
      try {
        await client.addPlaylistTracks({ playlistId: playlist.id, uris });
      } catch {
        fail(
          "playlist_created_without_tracks",
          "Spotify created the private playlist but did not accept its tracks. Check the empty playlist before trying again.",
        );
      }
      return {
        ...actionReceipt("playlist.write"),
        playlist: {
          name: playlist.name ?? name,
          track_count: uris.length,
          is_public: false,
        },
        ...(playlist.uri ? { playlist_uri: playlist.uri } : {}),
        ...(playlist.id ? { playlist_id: playlist.id } : {}),
      };
    },

    async saveTracks(value) {
      const input = inputObject(value);
      const uris = requiredTrackUris(
        input.uris,
        "invalid_library_tracks",
        SPOTIFY_SERVICE_LIMITS.libraryTracksMax,
      );
      await client.saveTracks({ uris });
      return {
        ...actionReceipt("library.save"),
        track_count: uris.length,
      };
    },

    async checkSavedTracks(value) {
      const input = inputObject(value);
      const uris = requiredTrackUris(
        input.uris,
        "invalid_library_tracks",
        SPOTIFY_SERVICE_LIMITS.libraryTracksMax,
      );
      const saved = await client.checkSavedTracks({ uris });
      return {
        provider: "spotify",
        checked: uris.map((uri, index) => ({
          uri,
          saved: saved[index] === true,
        })),
      };
    },
  });
}
