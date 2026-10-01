import { createSpotifyWebApiClient } from "./web-api-client.mjs";
import { setTimeout as delay } from "node:timers/promises";

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
  searchQueryLengthMax: 256,
  searchResultsDefault: 5,
  searchResultsMax: 10,
  playbackReadinessSnapshotsMax: 4,
  playbackReadinessTimeoutMs: 5_000,
  playbackReadinessPollMs: 250,
});

const repeatStates = new Set(["off", "track", "context"]);
const itemUriPattern = /^spotify:(?:episode|track):[A-Za-z0-9]{1,128}$/u;
const trackUriPattern = /^spotify:track:[A-Za-z0-9]{1,128}$/u;
const contextUriPattern = /^spotify:(?:album|artist|playlist):[A-Za-z0-9]{1,128}$/u;

export class SpotifyServiceError extends Error {
  constructor(code, message, { outcomeUnknown = false, actionNotDispatched = false } = {}) {
    super(message);
    this.name = "SpotifyServiceError";
    this.code = code;
    this.provider = "spotify";
    this.outcomeUnknown = outcomeUnknown;
    // These errors are raised by local argument validators before client dispatch.
    if (!outcomeUnknown && (actionNotDispatched || /^(?:invalid_|conflicting_)/u.test(code))) this.actionNotDispatched = true;
  }
}

function fail(code, message, options) {
  throw new SpotifyServiceError(code, message, options);
}

function failBeforeDispatch(code, message) {
  fail(code, message, { actionNotDispatched: true });
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
  if (playlist.is_public !== false) return "public";
  if (playlist.collaborative !== false) return "collaborative";
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

function searchQuery(value) {
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid_search_query", "The Spotify search query must not be empty.");
  }
  const query = value.trim();
  if (
    Array.from(query).length > SPOTIFY_SERVICE_LIMITS.searchQueryLengthMax
  ) {
    fail(
      "invalid_search_query",
      `The Spotify search query must be at most ${SPOTIFY_SERVICE_LIMITS.searchQueryLengthMax} characters.`,
    );
  }
  return query;
}

function searchLimit(value) {
  if (value === undefined) return SPOTIFY_SERVICE_LIMITS.searchResultsDefault;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > SPOTIFY_SERVICE_LIMITS.searchResultsMax
  ) {
    fail(
      "invalid_search_limit",
      `Spotify search limit must be an integer from 1 to ${SPOTIFY_SERVICE_LIMITS.searchResultsMax}.`,
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
  ["phone", "smartphone"],
  ["smartphone", "smartphone"],
  ["tablet", "tablet"],
  ["computer", "computer"],
  ["desktop", "computer"],
  ["laptop", "computer"],
  ["电脑", "computer"],
  ["计算机", "computer"],
  ["手机", "smartphone"],
  ["音箱", "speaker"],
  ["音响", "speaker"],
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
  if (queryToken.length < 3 || DEVICE_TYPE_ALIASES.has(queryToken)) return false;
  return nameToken.startsWith(queryToken);
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
    failBeforeDispatch(
      "spotify_device_restricted",
      `Spotify does not allow Web API control on ${clipText(chosen[0].name, 80)}. Pick another device.`,
    );
  }
  const controllable = chosen.filter((device) => device.is_restricted !== true);
  if (controllable.length === 1 && chosen.length === 1) return controllable[0];
  if (controllable.length === 0) {
    failBeforeDispatch(
      "spotify_device_restricted",
      fitDeviceMessage(
        "Spotify will not take playback on the matching devices: ",
        chosen,
        ".",
      ),
    );
  }
  failBeforeDispatch(
    "spotify_device_ambiguous",
    fitDeviceMessage(
      `Several Spotify devices match "${display}": `,
      chosen,
      ". Say which one.",
    ),
  );
}

async function resolveNamedDevice(client, deviceName, { signal } = {}) {
  const query = deviceQuery(deviceName);
  const devices = listedDevices(await client.getDevices({ signal }));
  signal?.throwIfAborted();
  if (devices.length === 0) {
    failBeforeDispatch(
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
    failBeforeDispatch(
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

async function queueDeviceId(client, requestedDeviceId, { signal } = {}) {
  const explicit = optionalDeviceId(requestedDeviceId);
  if (explicit) return explicit;

  const result = await client.getDevices({ signal });
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
    failBeforeDispatch(
      "spotify_device_restricted",
      "Spotify's available devices do not accept Web API controls. Open Spotify on another device and try again.",
    );
  }
  failBeforeDispatch(
    "spotify_active_device_required",
    "No active Spotify device is available. Open Spotify on one device and start playback, then try again.",
  );
}

export function createSpotifyService(options = {}) {
  const client = options.client ?? createSpotifyWebApiClient(options);
  if (!client || typeof client !== "object") {
    throw new TypeError("A Spotify Web API client is required.");
  }
  const readinessTimeout = options.playbackReadinessTimeoutMs ?? SPOTIFY_SERVICE_LIMITS.playbackReadinessTimeoutMs;
  if (!Number.isInteger(readinessTimeout) || readinessTimeout < 1 || readinessTimeout > 5_000) throw new TypeError("Invalid Spotify playback preparation timeout.");
  const readinessSleep = options.playbackReadinessSleep ?? ((ms, { signal }) => delay(ms, undefined, { signal }));

  async function preparedResume(input, { signal, preferredDeviceId, allowDeviceSwitch = input.deviceId !== undefined, allowTransfer = true, excludedDeviceNames = [], onDeviceSelected } = {}) {
    const effects = [];
    const deadline = Date.now() + readinessTimeout;
    let snapshots = 0, playAttempts = 0, writeStarted = false, phase = "read";
    let recovered = false, selected;
    const stop = (code, message) => failBeforeDispatch(code, message);
    // Reads and delays are bounded even if an injected transport ignores abort.
    // Dispatched writes retain the client's separate settlement deadline.
    const boundedRead = async operation => {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) stop("spotify_device_not_ready", "Spotify device readiness timed out. Open Spotify on the selected device, then request playback again.");
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let timer, abort;
      try {
        return await Promise.race([Promise.resolve().then(() => operation(combined)), new Promise((_, reject) => {
          abort = () => reject(combined.reason);
          combined.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => controller.abort(new SpotifyServiceError("spotify_device_not_ready", "Spotify device readiness timed out. Open Spotify on the selected device, then request playback again.")), remaining);
        })]);
      } finally { clearTimeout(timer); combined.removeEventListener("abort", abort); }
    };
    const snapshot = async (wait = false) => {
      phase = "read";
      if (snapshots >= SPOTIFY_SERVICE_LIMITS.playbackReadinessSnapshotsMax) stop("spotify_device_not_ready", "Spotify has not made the selected device ready. Open Spotify on it, then request playback again.");
      if (wait) await boundedRead(readSignal => readinessSleep(SPOTIFY_SERVICE_LIMITS.playbackReadinessPollMs, { signal: readSignal }));
      snapshots++;
      const [listing, player] = await boundedRead(readSignal => Promise.all([
        client.getDevices({ signal: readSignal }), client.getCurrentPlayback({ signal: readSignal }),
      ]));
      signal?.throwIfAborted();
      if (!Array.isArray(listing?.devices) || !["available", "inactive"].includes(player?.state)) stop("spotify_device_state_unconfirmed", "Spotify did not return a usable device and playback state. Check Spotify before requesting playback again.");
      const devices = listedDevices(listing);
      if (new Set(devices.map(device => device.id)).size !== devices.length) stop("spotify_device_state_unconfirmed", "Spotify returned conflicting device entries. Check Spotify's device selector before trying again.");
      const active = new Set(devices.filter(device => device.is_active === true).map(device => device.id));
      if (player.device?.is_active === true) active.add(player.device.id);
      if (active.size > 1) stop("spotify_device_state_unconfirmed", "Spotify device and playback snapshots disagree. Check the active device before trying again.");
      return { devices, player, active: [...active][0], truncated: listing.truncated === true };
    };
    const find = (state, id) => {
      const device = state.devices.find(entry => entry.id === id);
      if (!device) stop("spotify_device_not_found", "The selected Spotify device is not visible. Open Spotify on that device and request playback again; no other device was substituted.");
      if (device.is_restricted !== false) stop("spotify_device_restricted", "The selected device does not confirm Web API control. Choose another available Spotify device.");
      if (excludedDeviceNames.some(name => {
        const query = deviceQuery(name), tokens = meaningfulTokens(query.normalized);
        return nameMatchScore(device, query.normalized, tokens) > 0 || sharedTypeAlias(tokens) === device.type?.toLocaleLowerCase("en-US");
      })) stop("spotify_device_selection_not_authorized", "The listener excluded the selected device. Specify another available Spotify device before playing.");
      return device;
    };
    const check = state => {
      selected = find(state, selected.id);
      if (state.player.device?.id === selected.id && state.player.device.is_restricted === true) stop("spotify_device_restricted", "Spotify playback state restricts control of this device. Choose another available device.");
      if (state.active && state.active !== selected.id && !allowDeviceSwitch) stop("spotify_device_changed", "Another Spotify device became active. Choose the intended device explicitly; playback was not moved automatically.");
      if (state.player.disallowed_actions?.includes("resuming")) stop("spotify_playback_restricted", "Spotify currently disallows resuming playback. Check the selected device in Spotify.");
    };
    const prepare = async (state, afterRejection = false) => {
      check(state);
      if (selected.is_active === true && state.active === selected.id) return state;
      // play:false preserves the previous state. It is safe preparation only
      // with affirmative evidence of paused playback, never from a 204/unknown
      // response or a currently playing session (which could play the old song).
      const paused = state.player.state === "available" && state.player.is_playing === false;
      if (!allowTransfer || !paused || state.truncated || state.player.disallowed_actions?.includes("transferring_playback")) {
        if (afterRejection) stop("spotify_device_not_ready", "Spotify rejected playback because the selected device is not ready. Open Spotify on that device, then request the same song again.");
        return state; // One exact-target play can work without a separate transfer.
      }
      if (!effects.length) {
        signal?.throwIfAborted(); phase = "transfer";
        await client.transfer({ deviceId: selected.id, play: false }, { signal, beforeDispatch: () => { signal?.throwIfAborted(); writeStarted = true; } });
        writeStarted = true;
        effects.push({ ...actionReceipt("playback.transfer"), device: { name: selected.name, type: selected.type ?? "unknown" } });
      }
      while (true) {
        state = await snapshot(true); check(state);
        if (selected.is_active === true && state.active === selected.id) return state;
      }
    };
    try {
      let state = await snapshot();
      const id = input.deviceId ?? state.active ?? preferredDeviceId;
      if (id) selected = find(state, id);
      else {
        if (state.truncated || state.devices.length !== 1) stop(state.devices.length ? "spotify_device_ambiguous" : "spotify_device_not_found",
          state.devices.length ? "Several Spotify devices may be available. Choose the intended device by name before playing." : "No Spotify Connect device is visible. Open Spotify on the intended device and request playback again.");
        selected = find(state, state.devices[0].id);
      }
      onDeviceSelected?.(selected.id);
      input = { ...input, deviceId: selected.id }; // Frozen before any write.
      state = await prepare(state);
      for (;;) {
        signal?.throwIfAborted(); phase = "resume";
        try { await client.resume(input, { signal, beforeDispatch: () => { signal?.throwIfAborted(); writeStarted = true; playAttempts++; } }); break; }
        catch (error) {
          // A definite NO_ACTIVE_DEVICE rejection is the sole recoverable
          // play response. No queue/skip/transfer or uncertain write is replayed.
          if (playAttempts !== 1 || error?.status !== 404 || error.reason !== "NO_ACTIVE_DEVICE" || error.outcomeUnknown !== false || signal?.aborted) throw error;
          recovered = true;
          state = await snapshot(true);
          await prepare(state, true);
        }
      }
      return { ...actionReceipt("playback.resume"), device: { name: selected.name, type: selected.type ?? "unknown" },
        ...(effects.length ? { preparation_effects: effects } : {}), ...(recovered ? { recovered_no_active_device: true } : {}) };
    } catch (error) {
      // Retain accepted preparation even if a later read, cancellation, or play
      // fails. A preparation failure must not claim that the song was dispatched.
      error.playbackPreparation = effects;
      error.playbackAction = phase === "transfer" ? "playback.transfer" : "playback.resume";
      error.playbackNotDispatched = playAttempts === 0;
      error.playbackPreparationStopped = true;
      error.playbackRecoveryAttempted = recovered;
      if (phase === "read") error.outcomeUnknown = false;
      if (!writeStarted) error.actionNotDispatched = true;
      else delete error.actionNotDispatched;
      throw error;
    }
  }

  return Object.freeze({
    account(options) {
      return client.getAccount(options);
    },

    currentPlayer(options) {
      return client.getCurrentPlayback(options);
    },

    devices(options) {
      return client.getDevices(options);
    },

    async resolveDevice(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      if (input.deviceId !== undefined && input.deviceName !== undefined) fail("conflicting_device_target", "Choose one device target.");
      let device;
      if (input.deviceName !== undefined) device = await resolveNamedDevice(client, input.deviceName, { signal });
      else {
        const id = optionalDeviceId(input.deviceId);
        const devices = listedDevices(await client.getDevices({ signal }));
        signal?.throwIfAborted();
        const matching = devices.filter((item) => id ? item.id === id : item.is_active === true);
        if (matching.length === 0) failBeforeDispatch("spotify_device_not_found", "That Spotify device is no longer available. List devices again or open Spotify on it.");
        device = requireTransferDevice(matching, "selected device");
      }
      if (input.forVolume && device.supports_volume === false) failBeforeDispatch("spotify_volume_unsupported", "Spotify cannot change this device's volume through the Web API. Use its hardware or Spotify app volume control.");
      return device;
    },

    queue(options) {
      return client.getQueue(options);
    },

    async recentActivity(value, { signal } = {}) {
      signal?.throwIfAborted();
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
      }, { signal });
    },

    async topItems(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const type = input.type ?? "tracks";
      const timeRange = input.timeRange ?? "medium_term";
      if (!["artists", "tracks"].includes(type) || !["short_term", "medium_term", "long_term"].includes(timeRange)) {
        fail("invalid_top_items", "Spotify top items require artists or tracks and short_term, medium_term, or long_term.");
      }
      const limit = searchLimit(input.limit);
      const result = await client.getTopItems({ type, timeRange, limit }, { signal });
      signal?.throwIfAborted();
      const items = Array.isArray(result?.items) ? result.items : [];
      return { provider: "spotify", type, time_range: timeRange,
        evidence_basis: "spotify_calculated_affinity", items: items.slice(0, limit),
        truncated: result?.truncated === true || items.length > limit };
    },

    async libraryBrowse(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const type = input.type ?? "tracks";
      const limit = input.limit ?? 10;
      if (!["tracks", "albums", "shows", "playlists", "artists"].includes(type) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
        fail("invalid_library_page", "Browse saved tracks, albums, shows, playlists, or followed artists with a limit from 1 to 20.");
      }
      if (type === "artists") {
        if (input.offset !== undefined || input.after !== undefined && (typeof input.after !== "string" || !/^[A-Za-z0-9]{1,128}$/u.test(input.after))) fail("invalid_artist_cursor", "Use the returned after cursor for followed artists, not offset.");
        return client.getFollowedArtists({ limit, after: input.after }, { signal });
      }
      if (input.after !== undefined) fail("invalid_library_cursor", "Use offset for this library type.");
      return client.getSavedItems({ type, limit, offset: playlistPageOffset(input.offset) }, { signal });
    },

    async searchTracks(value, { signal } = {}) {
      const input = inputObject(value);
      const type = input.type ?? "track";
      if (!["track", "album", "artist", "playlist", "show", "episode"].includes(type)) fail("invalid_search_type", "Choose track, album, artist, playlist, show, or episode.");
      const offset = input.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > 1000) fail("invalid_search_offset", "Search offset must be from 0 to 1000.");
      if (type !== "track" || offset !== 0) return client.searchItems({ query: searchQuery(input.query), type, limit: searchLimit(input.limit), offset }, { signal });
      return client.searchTracks({
        query: searchQuery(input.query),
        limit: searchLimit(input.limit),
      }, { signal });
    },

    async catalogChildren(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      if (!["album", "show"].includes(input.type) || typeof input.id !== "string" || !/^[A-Za-z0-9]{1,128}$/u.test(input.id)) fail("invalid_catalog_parent", "Choose a returned album or show reference.");
      const limit = input.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) fail("invalid_catalog_limit", "Read from 1 to 20 album tracks or episodes per page.");
      return client.getCatalogChildren({ type: input.type, id: input.id, limit, offset: playlistPageOffset(input.offset) }, { signal });
    },

    async saveItems(value, { signal } = {}) {
      signal?.throwIfAborted();
      const uris = inputObject(value).uris;
      if (!Array.isArray(uris) || uris.length < 1 || uris.length > 12 || uris.some((uri) => typeof uri !== "string" || !/^spotify:(?:track|album|episode|show|playlist):[A-Za-z0-9]{1,128}$/u.test(uri))) fail("invalid_library_items", "Choose from 1 to 12 returned Spotify items.");
      const unique = [...new Set(uris)];
      await client.saveTracks({ uris: unique }, { signal });
      return { ...actionReceipt("library.save"), item_count: unique.length };
    },

    async removeSavedItem(value, { signal } = {}) {
      signal?.throwIfAborted();
      const uri = inputObject(value).uri;
      if (typeof uri !== "string" || !/^spotify:(?:track|album|episode|show):[A-Za-z0-9]{1,128}$/u.test(uri)) fail("invalid_library_item", "Choose one returned saved item.");
      await client.removeLibraryItems({ uris: [uri] }, { signal });
      return { ...actionReceipt("library.remove"), item_count: 1 };
    },

    async editablePlaylists(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const limit = playlistPageLimit(input.limit);
      const offset = playlistPageOffset(input.offset);
      const account = await client.getAccount({ signal });
      signal?.throwIfAborted();
      const ownerId = accountId(account);
      const page = await client.getCurrentUserPlaylists({ limit, offset }, { signal });
      signal?.throwIfAborted();
      const excluded = {
        public: 0,
        not_owned: 0,
        collaborative: 0,
        over_track_limit: 0,
        invalid: 0,
      };
      const playlists = [];
      const names = new Map();
      for (const item of page?.items ?? []) {
        if (typeof item?.name === "string") names.set(item.name, (names.get(item.name) ?? 0) + 1);
      }
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
        name_selection_complete: page?.complete_for_name_selection === true,
        ambiguous_names: [...names].filter(([, count]) => count > 1).map(([name]) => name),
        excluded,
        has_more: hasMore,
        next_offset: hasMore ? pageOffset + pageLimit : null,
      };
    },

    async playlistRemovalTarget(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const playlistId = requiredPlaylistId(input.playlistId);
      const account = await client.getAccount({ signal });
      signal?.throwIfAborted();
      const playlist = await client.getPlaylist({ playlistId }, { signal });
      signal?.throwIfAborted();
      if (playlist?.id !== playlistId || playlist.owner_id !== accountId(account) || playlist.is_public !== false || playlist.collaborative !== false ||
          typeof playlist.name !== "string" || !playlist.name || playlist.uri !== `spotify:playlist:${playlistId}`) {
        fail("playlist_not_removable", "Remove only a verified owned private, non-collaborative playlist from your library.");
      }
      return { playlistId, name: playlist.name, snapshotId: requiredSnapshotId(playlist.snapshot_id) };
    },

    async removePlaylistFromLibrary(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const current = await this.playlistRemovalTarget(input, { signal });
      if (current.name !== input.expectedName || current.snapshotId !== input.expectedSnapshotId) fail("playlist_snapshot_changed", "The playlist changed since confirmation was prepared. Review it again.");
      signal?.throwIfAborted();
      await client.removeLibraryItems({ uris: [`spotify:playlist:${current.playlistId}`] }, { signal });
      return { ...actionReceipt("playlist.unfollow"), playlist: { name: current.name, is_public: false } };
    },

    async playlistSnapshot(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const playlistId = requiredPlaylistId(input.playlistId);
      const account = await client.getAccount({ signal });
      signal?.throwIfAborted();
      const ownerId = accountId(account);
      const before = requireEditablePlaylist(
        await client.getPlaylist({ playlistId }, { signal }),
        ownerId,
      );
      const tracks = [];
      let offset = 0;
      while (offset < before.tracks_total) {
        signal?.throwIfAborted();
        const page = await client.getPlaylistItems({
          playlistId,
          limit: Math.min(
            SPOTIFY_SERVICE_LIMITS.playlistItemsPageMax,
            before.tracks_total - offset,
          ),
          offset,
        }, { signal });
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
      signal?.throwIfAborted();
      const after = requireEditablePlaylist(
        await client.getPlaylist({ playlistId }, { signal }),
        ownerId,
      );
      signal?.throwIfAborted();
      if (
        before.id !== playlistId || after.id !== playlistId ||
        after.name !== before.name ||
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

    async quickEditPlaylist(value, { signal, beforeWrite } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const playlistId = requiredPlaylistId(input.playlistId);
      const expectedSnapshotId = requiredSnapshotId(input.expectedSnapshotId);
      if (!["rename", "remove_track"].includes(input.action)) fail("invalid_playlist_edit", "Unsupported quick playlist edit.");
      const current = await this.playlistSnapshot({ playlistId }, { signal });
      if (current.playlist.snapshot_id !== expectedSnapshotId || current.playlist.name !== input.expectedName ||
          current.items.length !== input.expectedTrackCount) {
        fail("playlist_snapshot_changed", "The playlist changed after inspection. Inspect it again before editing.");
      }
      let name = current.playlist.name;
      let count = current.items.length;
      if (input.action === "rename") {
        name = cleanPlaylistText(input.name, 100, "invalid_playlist_name", "name");
        if (name !== input.name || name === current.playlist.name) fail("invalid_playlist_name", "The exact new playlist name must be valid and different.");
        beforeWrite?.();
        signal?.throwIfAborted();
        await client.renamePlaylist({ playlistId, name }, { signal, beforeDispatch: beforeWrite });
      } else {
        const uri = requiredItemUri(input.uri);
        if (!trackUriPattern.test(uri) || current.items.filter((item) => item.uri === uri).length !== 1) {
          fail("playlist_removal_ambiguous", "Single-track removal requires exactly one occurrence. Preview the exact final order for duplicates or bulk edits.");
        }
        beforeWrite?.();
        signal?.throwIfAborted();
        await client.removePlaylistItem({ playlistId, uri, snapshotId: expectedSnapshotId }, { signal, beforeDispatch: beforeWrite });
        count -= 1;
      }
      return { ...actionReceipt(input.action === "rename" ? "playlist.rename" : "playlist.remove_track"),
        playlist: { name, track_count: count, is_public: false }, previous_track_count: current.items.length,
        ...(input.action === "remove_track" ? { track_count: 1 } : {}) };
    },

    async replacePlaylistItems(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const playlistId = requiredPlaylistId(input.playlistId);
      const expectedSnapshotId = requiredSnapshotId(input.expectedSnapshotId);
      const uris = requiredPlaylistEditTrackUris(input.uris);
      const account = await client.getAccount({ signal });
      signal?.throwIfAborted();
      const ownerId = accountId(account);
      const playlist = requireEditablePlaylist(
        await client.getPlaylist({ playlistId }, { signal }),
        ownerId,
      );
      if (playlist.snapshot_id !== expectedSnapshotId) {
        fail(
          "playlist_snapshot_changed",
          "The Spotify playlist changed after preview. Inspect it again before editing.",
        );
      }
      signal?.throwIfAborted();
      await client.replacePlaylistItems({ playlistId, uris }, { signal });
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

    async resume(value, { signal, ...preparation } = {}) {
      signal?.throwIfAborted();
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
      return preparedResume({
        deviceId: optionalDeviceId(input.deviceId),
        contextUri,
        uris,
        offsetPosition,
        offsetUri,
        positionMs: optionalPosition(input.positionMs, "invalid_position"),
      }, { signal, ...preparation });
    },

    async pause(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      await client.pause({ deviceId: optionalDeviceId(input.deviceId) }, { signal });
      return actionReceipt("playback.pause");
    },

    async next(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      await client.next({ deviceId: optionalDeviceId(input.deviceId) }, { signal });
      return actionReceipt("playback.next");
    },

    async previous(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      await client.previous({ deviceId: optionalDeviceId(input.deviceId) }, { signal });
      return actionReceipt("playback.previous");
    },

    async setVolume(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      if (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100) {
        fail("invalid_volume", "Spotify volume must be an integer from 0 to 100.");
      }
      await client.setVolume({
        percent: input.percent,
        deviceId: optionalDeviceId(input.deviceId),
      }, { signal });
      return actionReceipt("playback.volume.set");
    },

    async seek(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      if (input.positionMs === undefined) {
        fail("invalid_position", "The Spotify playback position is invalid.");
      }
      await client.seek({
        positionMs: optionalPosition(input.positionMs, "invalid_position"),
        deviceId: optionalDeviceId(input.deviceId),
      }, { signal });
      return actionReceipt("playback.seek");
    },

    async setShuffle(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      if (typeof input.state !== "boolean") {
        fail("invalid_shuffle_state", "Spotify shuffle state must be a boolean.");
      }
      await client.setShuffle({
        state: input.state,
        deviceId: optionalDeviceId(input.deviceId),
      }, { signal });
      return actionReceipt("playback.shuffle.set");
    },

    async setRepeat(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      if (!repeatStates.has(input.state)) {
        fail("invalid_repeat_state", "Spotify repeat state is invalid.");
      }
      await client.setRepeat({
        state: input.state,
        deviceId: optionalDeviceId(input.deviceId),
      }, { signal });
      return actionReceipt("playback.repeat.set");
    },

    async transfer(value, { signal, onDeviceSelected } = {}) {
      signal?.throwIfAborted();
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
        onDeviceSelected?.(deviceId);
        await client.transfer({ deviceId, play }, { signal });
        return actionReceipt("playback.transfer");
      }
      if (!hasName) {
        fail("invalid_device_id", "A Spotify device identifier is required.");
      }
      const device = await resolveNamedDevice(client, input.deviceName, { signal });
      onDeviceSelected?.(device.id);
      signal?.throwIfAborted();
      await client.transfer({ deviceId: device.id, play }, { signal });
      return {
        ...actionReceipt("playback.transfer"),
        device: {
          name: device.name,
          type: device.type || "unknown",
        },
      };
    },

    async addToQueue(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const uri = requiredItemUri(input.uri);
      const deviceId = await queueDeviceId(client, input.deviceId, { signal });
      signal?.throwIfAborted();
      // Let a dispatched write settle so cancellation can report accepted effects.
      // Never dispatch the next write after the prompt has been cancelled.
      await client.addToQueue({ uri, deviceId }, { signal });
      return actionReceipt("playback.queue.add");
    },

    async createPlaylistWithTracks(value, { signal } = {}) {
      signal?.throwIfAborted();
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
      }, { signal });
      if (!playlist?.id) {
        fail(
          "playlist_creation_failed",
          "Spotify did not return the created playlist.",
          { outcomeUnknown: true },
        );
      }
      try {
        signal?.throwIfAborted();
        await client.addPlaylistTracks({ playlistId: playlist.id, uris }, { signal });
      } catch (error) {
        const rejected = error?.outcomeUnknown === false ||
          (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) ||
          (error?.name === "AbortError" && signal?.aborted);
        if (error?.outcomeUnknown === true || !rejected) {
          fail(
            "playlist_created_tracks_unknown",
            "Spotify created the private playlist, but did not confirm whether its tracks were added. Check the playlist before trying again.",
            { outcomeUnknown: true },
          );
        }
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

    async saveTracks(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const uris = requiredTrackUris(
        input.uris,
        "invalid_library_tracks",
        SPOTIFY_SERVICE_LIMITS.libraryTracksMax,
      );
      await client.saveTracks({ uris }, { signal });
      return {
        ...actionReceipt("library.save"),
        track_count: uris.length,
      };
    },

    async checkSavedTracks(value, { signal } = {}) {
      signal?.throwIfAborted();
      const input = inputObject(value);
      const uris = requiredTrackUris(
        input.uris,
        "invalid_library_tracks",
        SPOTIFY_SERVICE_LIMITS.libraryTracksMax,
      );
      const saved = await client.checkSavedTracks({ uris }, { signal });
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
